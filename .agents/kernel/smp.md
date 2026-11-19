# SMP kernel

The `CONFIG_SMP` build of the same tree: `make kw_defconfig kw_smp.config`
(`arch/wasm/configs/kw_smp.config`: SMP, `NR_CPUS` 8), linked with
`--shared-memory`, with kwemu built by `zig build -Dkwemu-atomics=true`.
`kernel/build.sh smp` builds it into `vendor/build/kernel-smp` (kernel.md,
Two kernels). Every SMP piece is `#ifdef CONFIG_SMP` or compiles away, so
the UP build does not change. Status and open issues: status.md item 8.
The host side: js.md, CPU threads.

## Model

- One module instance per CPU, each in its own host thread, all on one
  shared memory. `current`, `__stack_pointer`, `kw_irq_flags` (the
  interrupt flag) and `kw_irq_word` (the address of the CPU's pending word)
  are wasm globals, so per CPU; `raw_smp_processor_id()` is
  `current_thread_info()->cpu`.
- The host offers `wasm_cpu_count()` CPUs. `kw_smp_init_cpus()`
  (setup_arch) makes them possible and present, capped by `nr_cpus=`, and
  takes kwemu's 8 MiB state for each from memblock (CPU 0's is static).
- `__cpu_up()` calls `wasm_cpu_start(cpu, idle)`: the host starts a thread
  with a new instance, which enters the export `kw_secondary_entry(idle)`
  (entry.S), then `kw_secondary_start()` (smp.c). `__cpu_up()` waits up to
  30 s for it to come online.
- **The data-segment flag.** With a shared memory every instance's start
  function initialises the passive data segments unless the word
  `__wasm_init_memory_flag` is 2. wasm-ld places it past `_end`, in memory
  the kernel would hand out, and C cannot name it (wasm-ld asserts on a
  reference). The module exports its address, the host answers
  `wasm_init_flag()` from that export, setup_arch memblock-reserves the
  word, and a secondary's host checks that it reads 2 before it
  instantiates.
- Per-CPU memory is percpu-km (mm/Kconfig allows `NEED_PER_CPU_KM` on SMP
  with `VMALLOC_FLAT`) with the generic `setup_per_cpu_areas()`. Spinlocks
  are asm-generic's ticket locks with the wait out of line, taken out of
  turn by default (Waiting for another CPU); rwlocks are queued
  (`ARCH_USE_QUEUED_RWLOCKS`); RCU is TREE_RCU.
- No parking and no snapshots (parking.md, SMP).

## Moving tasks

A JSPI stack belongs to the host thread that created it, so a task moves
only where its stack can be dropped (`ARCH_TASKS_STAY_ON_CPU`, init/Kconfig;
the arch side is in process.c). `thread.stack_cpu` is the CPU whose host
holds the task's stack. `__ret_from_fork()` holds the task there with
`migrate_disable()` from its first run, which the scheduler honours
everywhere (`cpus_ptr` becomes that CPU once it switches out;
`sched_getaffinity()` still shows the user's mask). A fork child starts
unheld (`copy_thread()` resets the copied hold), so new tasks spread at
fork. A held task is let go (`sched_stay_release()`, kernel/sched/core.c:
`migrate_enable()`, plus a move to an allowed CPU if its affinity excludes
this one) at two kinds of point:

- **A user task at the reschedule on its way to user mode.** The generic
  exit loop calls `arch_exit_to_user_mode_schedule()` (irq-entry-common.h;
  the default is `schedule()`), here `kw_exit_to_user_schedule()`: after a
  system call, a fault or an interrupt, once the system call's exit work
  (tracing, a ptrace stop, audit) is done, so the task's state is all in
  `pt_regs` and task_struct. Switched in on its stack's CPU, it returns
  from `schedule()` and is held again. Switched in elsewhere,
  `__switch_to()` starts it on a fresh stack, and `kw_user_resume()`
  finishes the switch (`sched_stay_switch_tail()`: `schedule_tail()`
  without the child TID store and without recalculating TIF_SIGPENDING, so
  a system call that returned -ERESTARTSYS still restarts) and runs
  `irqentry_exit_to_user_mode()` from the top. What the old pass still had
  to do (a signal, notify-resume, another reschedule) is in the TIF flags,
  which only the task clears; `regs->cause` and x0 are as it left them;
  the exclusive monitor is cleared on every entry to user mode anyway.
  This equals the old stack's path with rseq off (this config) and no
  CONTEXT_TRACKING_USER; with rseq on, `rseq_*_exit_to_user_mode()` would
  need a look. Tasks preempted or asleep in the kernel (a system call,
  `cond_resched()`, a signal stop) stay held: their stack is live.
- **A kthread at a restart point.** New kthreads first run only to report
  that they exist and are bound afterwards (per-CPU threads of a CPU not
  yet online, a per-CPU workqueue pool's first worker), so kernel/kthread.c
  and kernel/workqueue.c call `arch_kthread_restart_point(fn, arg)` before
  such a sleep (the creation wait, the park before the thread function, an
  idle worker) and `arch_kthread_restart_cancel()` after it. Woken on
  another CPU, the thread starts there in `kthread_exit(fn(arg))`. A
  workqueue rescuer that must serve another CPU's per-CPU pool leaves the
  request queued and calls `arch_kthread_move(cpu, rescuer_thread,
  rescuer)`: its affinity becomes that CPU, it releases itself and starts
  again there (otherwise `process_one_work()` warns).

The CPU that holds a moved task's old stack learns it from a per-CPU list
(`kw_stack_drop()`, 32 entries) and, at its next switch or idle, before it
could switch to that task (or a new task at the same address) again, calls
`wasm_stack_drop(task)`; its host forgets the stack. A full list only leaks
that stack until the task next starts fresh on that CPU. A task picked
again on its own CPU resumes its stack rather than starting fresh:
preemptions are frequent and moves rare, and a fresh start costs a new JSPI
stack while the old one waits for garbage collection.

Held tasks never call `migrate_enable()` before they exit, so
`rq->nr_pinned` (used only by CPU hot-unplug, which this arch lacks) only
grows.

### Affinity

`sched_setaffinity()` that excludes the CPU of a held task records the mask
and returns at once. For a user task `arch_stay_move()` sets TIF_KW_MOVE
(`ARCH_EXIT_TO_USER_MODE_WORK`, asm/entry-common.h) and kicks it: it moves
on its next way to user mode, at once if it runs in user mode, at the end
of the call for itself (`taskset -c 1 cmd`, `pthread_setaffinity_np()` on
itself), at the wakeup if it sleeps in a system call. A task let go
meanwhile moves the upstream way (stopper or `move_queued_task()`). A held
kthread gets EBUSY, unless it is moving itself (`arch_kthread_move()`).

### Placement

Where the scheduler would have moved a held task itself, it names the CPU
to the arch instead (`arch_stay_move_to()`, which sets TIF_KW_MOVE and
`thread.move_to`):

- `sched_exec()`, whose stopper cannot move a held task (it asks with the
  task's own mask, since `cpus_ptr` is its CPU's);
- the wakeup of a held user task whose CPU is busy (`stay_wake_target()`
  in `select_task_rq()`): the waker's CPU for a WF_SYNC wakeup from another
  CPU, else the first idle CPU; a WF_SYNC wakeup on the task's own CPU
  keeps the pair together.

The task finishes its system call where it slept, and
`kw_exit_to_user_move()` takes the hint on its way to user mode only if
that CPU is idle then and its own CPU has other work
(`sched_stay_release(dest)` queues the move as for an affinity change);
otherwise it goes on without a reschedule. A sleeper woken behind a busy
task thus leaves once and then wakes on its new CPU. Sleepers are not
interrupted to move them the way parking does: calls that do not restart
would return EINTR at the scheduler's whim. Tasks preempted in the kernel
(`cond_resched()`) stay where they are (status.md, SMP, Placement, has
what that costs).

### `/proc/kwmove`

SMP only. Counts user tasks switched out where they may move (`released`),
resumed on their CPU (`resumed`) or started on another (`moved`), kthreads
started again elsewhere (`restarted`), stacks dropped (`dropped`, `lost`),
and exits that found a CPU named by exec or a wakeup (`hinted`) and moved
there (`followed`). An Alpine boot to a shell (2026-11-16) released 10-18
times, all resumed in place, and restarted 6 kthreads on 2 CPUs, 21 on 4.

## Interrupts, IPIs and idle

- Each CPU has a word of pending bits. CPU 0's is `wasm_host_irqs` (the
  host's device bits arrive only there, set with `Atomics.or`, so device
  interrupts run on CPU 0); the others are `kw_irq_words[]`. IPIs are bits
  24-27 (`KW_IPI_*`, irq.h; 27, the kick, has no handler: it only ends a
  blocked wait).
- The timer is a per-CPU clockevent (IRQ 0 is a percpu-devid interrupt)
  with a per-CPU expiry.
- Polling widens: a CPU also takes what is pending when it enables
  interrupts (`arch_local_irq_restore()` checks the word) and in
  `cpu_relax()` with interrupts on, so a CPU spinning on a lock still
  answers the holder's TLB shootdown.
- `kw_irq_raise(cpu, bits)` (irq.c) ORs the bits into the target's word and
  does `memory.atomic.notify`. A secondary idles in `memory.atomic.wait32`
  on its word with the timer's timeout (it blocks its thread; no JSPI).
  CPU 0 idles in `poll_oneoff` as on UP, and its host also ends that wait
  on `Atomics.waitAsync` of `wasm_host_irqs`.
- `kw_irq_enable_pending()` runs the handlers with interrupts still off,
  then sets the flag. `user_mode_loop()` enables without delivering, since
  `kw_run()` returns `KW_EV_INTERRUPT` at once and the exit path then
  honours a reschedule.
- Every CPU yields to its own host (`wasm_yield`, every 20 ms of user code,
  traps.c). CPU 0's yield serves the devices; a secondary's event loop runs
  the engine's housekeeping, without which V8 never finishes collecting the
  JIT modules freed there (js.md, CPU threads). That can take milliseconds,
  so the yield comes after the pending interrupts are taken, and TLB
  flushes do not wait for a yielding CPU (MM). Only CPU 0 checks stdin
  there.
- `smp_send_stop()` parks the others. CPU 0 waits in `wasm_idle(-1)`, so
  its host can still take a secondary's exit, and clears its pending word
  before each such wait: the host's idle ends at once while that word is
  not 0, and a stop bit left there would keep CPU 0 resuming in a loop of
  microtasks that starves the host's event loop. A CPU takes the stop IPI
  in `cpu_relax()` even with interrupts off, and a secondary's host raises
  it on CPU 0 when the session ends there (exit, trap, fatal; js.md): CPU
  0's host takes that CPU's message only once CPU 0 suspends, and CPU 0 may
  be spinning for the CPU that ended.

## MM

- `switch_mm()` adds the CPU to `mm_cpumask(next)` before `kw_set_pgd()`
  and removes it from the previous mm (still referenced: lazy TLB
  refcount). `flush_tlb_*()` runs `kw_flush_tlb_*` here and, through
  `smp_call_function_many()` with wait, on every other CPU in the mask
  that uses the mm.
- New code: a guest's IC IVAU on one CPU reaches every CPU at its next
  block boundary through kwemu's code epoch; the kernel does nothing
  (kw_emu.h; a64/tier.md, Coherence).
- Flushes do not wait for a CPU that cannot be using the mm's
  translations at that moment; instead they mark it, and it flushes
  everything before it runs user code or uaccess for that mm again:
  - **Lazy TLB** (`enter_lazy_tlb()`: idle, a kthread, a task past
    `exit_mm()`). The CPU keeps the mm loaded and its mask bit, but its
    host thread may be asleep, so the flusher sets its `kw_tlb_stale`, and
    `switch_mm()` back to that mm flushes everything first (Dekker pairing
    of `kw_tlb_lazy` and `kw_tlb_stale` with `smp_mb()` on both sides; a
    switch to another mm drops everything anyway).
  - **Yielding** to its host from user mode (`kw_yield_to_host()`): the
    same flag.
  - **Compiling** (kw_emu.h, `jit_busy`: no user code, guest memory or
    page table in use, a few hundred µs of host time without interrupts).
    The flusher sets its `flush_all`, `smp_mb()`, and skips it if it still
    reads `jit_busy` (acquire, pairing with kwemu's release store, so the
    user stores made before the compile are visible). kwemu clears
    `jit_busy`, then takes `flush_all` and flushes everything before it
    runs user code (`kw_flush_later()`, tlb.c; kwemu.md, JIT on several
    CPUs).

  `flush_tlb_all()` skips them too. Unlike on x86 this holds when page
  tables are freed: kwemu walks the table only while it runs user code and
  caches no table entries.
- `update_mmu_cache_range()` and the flush after `ptep_set_access_flags()`
  (`flush_tlb_fix_spurious_fault()`) flush only this CPU: they follow a PTE
  that gained access with the same page, and kwemu fills a TLB entry only
  from a PTE that allows the access (separate read, write and exec TLBs,
  no negative entries), so another CPU at worst walks again. Every change
  that takes access away or moves the page flushes every CPU first
  (`ptep_clear_flush()`, `flush_tlb_*()`).
- The software A/D update in fault.c is a `cmpxchg` (as a hardware
  walker's, without the PTE lock), so pgtable.h makes every
  read-modify-write of a present PTE atomic on SMP (`ptep_get_and_clear`,
  `ptep_set_wrprotect`, `ptep_test_and_clear_young`,
  `ptep_set_access_flags` keeping D), except `ptep_get_and_clear_full()` in
  `exit_mmap()` (mm_users is 0, so nothing sets A or D), a plain read and
  clear as on x86.
- The uaccess walk and copy (`kw_user_addr()`) have no poll point between
  them, and pages and page tables are freed only after the mmu_gather
  flush, which waits for every CPU that uses the mm, so a CPU never copies
  into a freed page (gup-fast's argument; the default mmu_gather, without
  `MMU_GATHER_RCU_TABLE_FREE`, frees page tables in the same batch). The
  walk takes no lock (munmap frees page tables under the mmap read lock),
  so it reads each level once and follows that value, as gup-fast does.
- User code on other CPUs updates futex words with exclusives, so the
  kernel's futex ops on them (`FUTEX_WAKE_OP`, PI, robust futex death) are
  atomic RMWs (asm/futex.h).

## Waiting for another CPU (wait.c)

The host may deschedule a CPU's thread at any time. A CPU that spins for
another (a lock holder, a cross-CPU call's answer, a task leaving another
CPU) burns host time while that CPU is not running and looks busy to the
host, which then deschedules it more often, also while it holds a lock.
Under host load that convoy made cross-CPU work 10-50x slower than the
guest's lost share of the host explains (`vendor/smp-deferred/load/README.md`).
So:

- Every such wait spins for `kw_spin_us=` (20 µs, counted from its 256th
  spin; the clock is not read before) and then blocks the thread in
  `memory.atomic.wait32` on the CPU's own pending word until the word
  changes, for at most `kw_spin_sleep_us=` (100 µs) at a time. Both are
  boot parameters, writable in `/sys/module/kernel/parameters/`;
  `kw_spin_us=0` only spins.
- The waits: the ticket lock's slow path (`kw_ticket_wait()`), csd waits
  (`arch_csd_lock_wait()`, a hook in kernel/smp.c) and
  `smp_cond_load_relaxed()` (asm/barrier.h; so qrwlock and
  `try_to_wake_up()`'s wait for `p->on_cpu`).
- Kicks: a spinlock unlock (one atomic 16-bit add on the owner half, then
  a read of `kw_lock_sleepers`) and `csd_unlock()` (`arch_csd_unlocked()`)
  kick the CPUs blocked on that lock or csd with `KW_IPI_KICK`. The waiter
  publishes its key (per CPU) and the sleeper count, both seq_cst, before
  it reads the lock again, and the releaser reads the count and the keys
  after its release, so either the waiter sees the release or the releaser
  kicks it; `memory.atomic.wait32` compares the word first.
  `smp_cond_load_relaxed()` waits have no kick: the timeout or any
  interrupt ends their block. A kick that comes after its waiter stopped
  waiting is cleared before the CPU waits again.
- Any IPI ends a block (the sender notifies the word), so a blocked CPU
  still answers shootdowns. With interrupts on, a waiter never blocks over
  something already pending (`cpu_relax()` takes it); with them off it
  blocks until something new arrives (a reschedule IPI it cannot take yet
  does not keep it spinning), never over a kick or the stop IPI.
- The block is not a JSPI suspension. CPU 0 blocks too: every CPU of an SMP
  kernel runs in a worker, and an SMP kernel on one CPU never waits for
  another.
- Every 256 spins a waiter with interrupts on also takes its timer if it
  expired; otherwise a spinning CPU sees only its pending word and its tick
  starves (an RCU stall). Bare `cpu_relax()` loops (seqcount retries) still
  spin without the timer check.

**Locks taken out of turn.** Ticket locks are FIFO, so a waiter whose
thread the host has descheduled holds up every waiter behind it even once
the lock is free, and blocking does not help there. With `kw_spin_unfair=1`
(the default; a boot parameter, writable at run time) a CPU takes no
ticket: it takes the lock as `arch_spin_trylock()` does (cmpxchg of the
ticket word while owner == next) and otherwise waits for that in
`kw_steal_wait()`, which spins, blocks and is kicked as a ticket waiter
(same key and sleeper count; only an unlock frees the lock, and it kicks
every CPU blocked on it). Waiters are served in no particular order, as on
x86 guests without PV spinlocks (`virt_spin_lock()`), with no starvation
bound. Both kinds share the word, the unlock and the kick, so the parameter
may change at any time: a ticket holder is served in turn, a CPU without
one never overtakes a ticket, and one still waiting when the parameter
turns 0 takes a ticket. `kw_spin_unfair=0` gives plain ticket locks (cost
when 0: one flag read per lock). `arch_spin_is_contended()` counts only
tickets (its users, `spin_needbreak()` and `rwlock_needbreak()`, return 0
without preemption anyway). qrwlock's `wait_lock` is an `arch_spinlock_t`,
so it is unfair too; a waiting writer holds it, so readers still cannot
starve a writer. Measurements: status.md, SMP, step 7.

## Devices

Device imports answer only on CPU 0; another CPU's host ends the session
if one is called there (js.md). So:

- **hvc_wasm**: CPU 0's console interrupt pulls input into a FIFO and
  records the window size; khvcd reads those on any CPU. Output works on
  every CPU: each CPU's `fd_write` puts it into one ring shared by every
  CPU and the host, in the order the kernel made the calls (js.md, CPU
  threads).
- **kwnet**: NAPI runs on CPU 0 (its interrupt). Another CPU's frames wait
  in a queue that a work item on CPU 0 sends, and `ndo_open` raises IRQ 2
  on CPU 0 instead of looking itself.
- **kwvsock**: its work items run on CPU 0; another CPU's packets wait in
  `tx_queue`.
- **kwblk**: blk-mq calls `->queue_rq()` on the submitting CPU in atomic
  context. A request started on another CPU waits in `kwblk_pending` and
  raises IRQ 3 on CPU 0, whose handler submits the waiting ones in order
  before it reaps; CPU 0 submits its own directly behind them. Every
  request is submitted and ended on CPU 0 (`blk_mq_end_request()` there
  wakes the submitter where it sleeps), so disk I/O is serialised on CPU
  0, as it is on the host's thread anyway.
- The other devices' imports are called from process context through
  `kw_host_call(fn, arg)` (smp.c): at once on CPU 0, else
  `work_on_cpu(0, ...)` while the caller sleeps (a task in the kernel stays
  on its CPU, so the check holds).
  - kwshm: its request work item is queued on CPU 0; attach and detach go
    through `kw_host_call()` with `kwshm_lock` held, which the call does
    not take (the work item that does take it sleeps on it in another
    kworker of CPU 0's pool).
  - kwfb: the mode and attach calls (open, release, mode change, under
    `info->lock`).
  - kwinput: the open/close callbacks update the open mask inside the
    call, which serialises them.
  - kwsnd: open, prepare and close send their event through it. The timer
    is pinned to CPU 0 (`HRTIMER_MODE_REL_PINNED`). A trigger (atomic) on
    another CPU leaves its start or stop in the stream and queues a work
    item on CPU 0 (`system_highpri_wq`), which sends it and starts the
    timer. Whatever sends an event first sends those left (between two
    prepares a stream starts and stops at most once), and the tick sends a
    start before its frames, so the host sees them in order.
- The host reads and writes these devices' memory (block data, pixels, shm
  pages, PCM, input events) while other CPUs run, as a DMA engine would:
  block data belongs to its request until it ends, and framebuffer tearing
  is as on UP. WASI's scratch buffers for the clock and writes are per CPU;
  the rest is CPU 0's.

## kwemu

Each CPU has its own `struct kw_cpu`, with the ISA CPU 0 enabled, and its
own JIT tier compiling into its own instance's function table through its
own host (kwemu.md, JIT on several CPUs). A `kw_cpu` is used only by its
CPU's instance (`wasm_kw_cpu` is `kw_cpus[smp_processor_id()]`, and a task
that moves starts afresh on the new CPU), so nothing compiled on one CPU is
reachable from another. The atomics build makes exclusives, LSE and
barriers atomic (a64/isa.md, Exclusives).

## Costs

2026-11-16, i7-10700K, Node 24, interpreter only (riscv64 guest; the
mechanisms are the same):

- Each atomic RMW, cmpxchg or seq_cst store is a locked instruction in V8
  on x86-64, about 4.3 ns more than the plain op, and `atomic.fence`
  (`smp_mb()`, `smp_rmb()`, `smp_wmb()`, and acquire and release, which
  asm-generic builds from a fence) about 8.9 ns. A fork and its exit take
  about 4 locked ops per mapped page (folio refcount and mapcount).
- A wakeup that has to wake a sleeping host thread costs about 12 µs more
  than one on the same CPU when the target is a secondary
  (`memory.atomic.wait32`) and 20 µs more for CPU 0 (its host's
  `poll_oneoff`): kwwake, a pipe ping-pong with 200 µs gaps, woke a task on
  its own CPU in 7.3 µs, on CPU 1 in 19 µs, on CPU 0 in 28 µs (medians of
  500). A fork whose child starts on the other CPU pays two of those.
- kwfork (11 alternating rounds, medians): a process moved to CPU 1 while
  CPU 0 idles with its mm loaded faults in 536 ns (3,321 ns when every
  fault waited for CPU 0's flush) and forks and reaps a child in 80 µs
  (118 µs); the plain teardown clear saves 4.3 ns per mapped page at exit.

With the JIT on every CPU: kwemu.md, Numbers, SMP with the JIT.
