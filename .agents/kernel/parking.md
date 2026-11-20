# Parking and snapshots

A suspended task's continuation is on its wasm stack in the engine, which
cannot be saved. Parking (`arch/wasm/kernel/park.c`, `asm/park.h`,
`include/linux/kw_park.h`) brings every task to a point where its whole
state is in guest memory, then resumes each one on a fresh stack. Snapshots
are built on it. Every cycle resumes every task through the fresh-stack
path, so kwtest's `park:` check covers it. Both work on the UP and the SMP
kernel (SMP, below).

## The cycle

- **Trigger**: a write to `/proc/kwpark` (asynchronous: the writer parks
  too) wakes `kwparkd`. Reading it gives `requests N done N result R users
  U kthreads K us T blocker comm[pid]:state free F` (the last cycle's
  counts, request-to-resume time, for a restore from kwparkd's restore
  work on, the task that blocked it, `-` if none, and the free pages its
  snapshot left out, 0 if it took none).
- **Phases**: user tasks first (`kw_park_users`), while kernel threads still
  run, so a user task in a D-state wait for a journal commit or writeback
  finishes it; then kernel threads (`kw_park_kthreads`); then kwparkd parks
  itself and sets `kw_park_final`. A task that has not parked after 2 s
  (stopped or traced, in a D-state sleep, a kernel thread without a park
  point, created but never woken) ends the cycle: every parked task is
  resumed and the result is -EBUSY naming that task.
- **User tasks**: kwparkd sets `TIF_NOTIFY_SIGNAL` (repeated every tick
  until the task parks), which ends interruptible sleeps. The task parks at
  the top of `user_mode_loop()`, after the exit work, where its state is
  `pt_regs` plus task_struct (restart block, signal state). Syscalls
  restart (-ERESTARTSYS, -ERESTARTNOHAND, the restart block for nanosleep,
  poll and futex timeouts); the few that do not restart after SIGSTOP and
  SIGCONT either (epoll_wait, sigtimedwait, sockets with a timeout) return
  EINTR once per cycle. Parked tasks sleep in `TASK_IDLE`, so signals (even
  SIGKILL) and tty wakeups wait for the resume.
- **Kernel threads**: kwparkd wakes those sleeping in `TASK_INTERRUPTIBLE`
  or `TASK_IDLE` (never plain D-state sleeps: `kthread()`'s wait for its
  first wakeup has no loop). Each loop has a `kw_park_point(fn, arg)` where
  it holds no locks and has no wait queue entry or timer on its stack;
  `fn(arg)` re-enters the loop without its one-time setup. The set:
  kthreadd (`kthreadd_loop`), `kthread_worker_fn`, `worker_thread` (at
  `woke_up`, idle), `rescuer_thread`, `smpboot_thread_fn`, devtmpfsd
  (`devtmpfs_work_fn`), oom_reaper, kcompactd (`kcompactd_loop`), kswapd
  (`kswapd_loop`), khvcd, kjournald2 (`kjournald2_loop`), ext4lazyinit
  (`ext4_lazyinit_thread`, at its loop top) and on SMP the TREE_RCU
  grace-period kthread (`rcu_gp_kthread_loop`). Waits that a wakeup does not
  end (`wait_event*()`) also end on `kw_park_pending()`, and the loop then
  skips its work. **A new kernel thread (a driver, a config option) needs
  a park point too**, or every cycle fails with EBUSY naming it; `cat
  /proc/kwpark` after a cycle shows which.
- **Consistent point**: `arch_cpu_idle()` sees `kw_park_final` and, inside
  `irqentry_enter()` with interrupts off and nothing runnable, checks that
  every task is `KW_PARK_PARKED` (and not on a runqueue), a zombie, or
  `TIF_NEVER_RUN`. A snapshot is taken there (on SMP just after the
  `irqentry_exit()`). On SMP CPU 0 does this while it holds every other CPU
  in the idle loop (SMP, below).
- **Resume**: `kw_unpark_all()` marks each parked task `KW_PARK_RESUMING`
  and `TIF_NEVER_RUN` and wakes it. The next switch to it starts a fresh
  stack (the host drops the old one from `resumers`), and `__ret_from_fork`
  calls `kw_park_resume()`: `schedule_tail()` with `set_child_tid` cleared
  (the TID was stored at the first run), then `fn(arg)` (its return value
  goes to `kthread_exit()`), or for a user task
  `irqentry_exit_to_user_mode()` (delivers signals that arrived while
  parked; no syscall-exit work, so no duplicate ptrace stop) and
  `user_mode_loop()`.

## Snapshots

- `Kernel.snapshot()` raises IRQ 8, which marks the next cycle a snapshot.
  At its end park.c calls the import `wasm_snapshot_point(result, blocker,
  free_map, free_bits)`: with result 0 from the consistent point (after the
  counts, before anything is resumed), where the host copies the memory
  during the call; otherwise with the error and the task that did not park.
  The host answers 0, or -EBUSY if its own block, net, vsock or shm queues
  are not empty or a disk cannot be sealed (js.md, Disks in snapshots). A
  disk's seal happens during this call, while nothing runs.
- **Free pages**: just before that call, `kw_park_mark_free()` drains this
  CPU's per-cpu lists (`drain_local_pages()`, as hibernation's
  `swsusp_save()` does) and sets a bit for every page on the buddy free
  lists in a bitmap of `max_pfn` bits (`kvcalloc` on the first snapshot,
  then kept: 16 KiB for 512 MiB), passed as `free_map`. The host leaves
  those pages out (`copySnapshotMemory()`, js.md) and a restore gives them
  zeros. Nothing reads a free page's contents (no PAGE_POISONING;
  `init_on_free` expects zeros), and the free lists link through `struct
  page`, which is saved. Dropping clean page cache first gains nothing with
  the initramfs root, whose files are tmpfs (28.6 MiB with `drop_caches`
  against 28.4 MiB without, 2026-11-15); an overlay root on a data disk has
  cache that could be dropped.
- **Restore**: instantiate the same build (`linux_banner` must match; the
  build id in it makes every differing module differ, kernel.md, Two
  kernels), copy the memory over the fresh instance's, clear
  `wasm_host_irqs` and call the export `kw_resume` (entry.S) instead of
  `_start`: the idle task on a fresh stack runs `__kw_resume()`, which
  calls `kw_host_reset()`, marks every parked task `TIF_NEVER_RUN` and
  resumes only kwparkd. kwparkd steps the realtime clock to the host's
  (`do_settimeofday64`), reseeds the RNG (`add_vmfork_randomness()`, built
  for KW_PARK by the generic random patch, so that two restores of one
  snapshot differ), runs the park restore notifiers and then resumes
  everything else. A parked task woken before that (a timer, a work item
  queued meanwhile) has no stack left to resume: the mark makes it start
  on a fresh one, where `kw_park_resume()` sees it still `KW_PARK_PARKED`
  and waits until kwparkd resumes it, as in `kw_park_self()`. The host
  offsets its monotonic clock so that CLOCK_MONOTONIC and CLOCK_BOOTTIME
  continue from the saved value. On UP, restarting the idle task at
  `cpu_startup_entry()` is fine with TINY_RCU and no CPU_IDLE or
  CONTEXT_TRACKING_IDLE; SMP restarts it exactly (SMP, below).
- **Restore notifiers** (`kw_park_register_restore_notifier()`,
  linux/kw_park.h) are for a driver whose host side did not survive. They
  run while every other task is parked, so they must not wait for one.
  kwvsock resets every connected socket (ECONNRESET, as virtio-vsock does
  on TRANSPORT_RESET after a live migration) except the established ones
  the host keeps (`wasm_driver_vsock_keep(guest_port, host_port)` > 0: the
  9p sessions of host file systems, whose state the host saved, js.md);
  listeners stay. The other devices need no kernel help: their host side
  restores what the kernel told it (js.md, Devices in snapshots).

## Cost

2026-11-15, Node, Alpine at a shell with 3 to 7 user tasks and 22 to 25
kernel threads (riscv64 guest; the mechanism is ISA-neutral):

- 180-500 µs per cycle. The check in `user_mode_loop()` (one load per
  kernel exit) did not move kwbench. Parking adds 1.5 KB raw, 2.3 KB gzip
  to the lowered kernel.
- A snapshot of a 512 MiB machine (the CLI's `{suspend}`): 28.4 MiB at a
  shell, 28.9 MiB after writing and removing 200 MiB in /tmp and a `sort`
  (32.0 and 232.1 MiB with the free pages saved too); parked and copied in
  10-16 ms; reading and decoding the file 15 ms. A restore answered its
  first shell command 215 ms after reading the file, about what a cold
  boot to the prompt takes: the gain is the state, not the time.

## SMP

Parking and snapshots work on the SMP kernel (kwtest's `park:` check runs
there; `test/api.test.ts` snapshots and restores machines on several
CPUs).

- **Holds**: a parked task stays held on its CPU (`migrate_disable()`
  from its first run, smp.md), so it resumes there, on a fresh stack whose
  old one that CPU's host drops (`is_new`), and `__ret_from_fork()` takes
  no second hold for it. `kw_park_self()` warns if a task parks unheld,
  movable or at a restart point. So a restore needs the snapshot's CPU
  count (the host checks it, js.md).
- **kwparkd** is bound to CPU 0, where the device imports answer (a
  failed snapshot's `wasm_snapshot_point()`, the restore notifiers) and
  which leads the rendezvous.
- **Unpark**: `kw_unpark()` marks a task under `task_call_func()`, which
  holds off its wakeup and its switches. A task off its CPU gets
  `KW_PARK_RESUMING` and `TIF_NEVER_RUN`; one still on its old stack (on
  its way out after parking, or woken in the park loop) gets
  `KW_PARK_NONE` and goes on there: `kw_park_self()` returns and the park
  point continues (a user task runs `irqentry_exit_to_user_mode()` first).
  A task that parks just as a phase ends with -EBUSY sees the flag cleared
  (a barrier on both sides) and calls its park off itself.
- **Rendezvous** (park.c): kwparkd, parked last, sets a round number and
  `kw_park_final` and kicks every CPU. Each other CPU that reaches
  `arch_cpu_idle()` with nothing pending stores the round in its slot,
  kicks CPU 0 and blocks with interrupts off (`memory.atomic.wait32` on its
  pending word, outside `irqentry_enter()`, so in RCU's idle state) until
  the round changes. CPU 0 waits in its idle loop with interrupts working
  (at most 1 ms at a time) until every online CPU has checked in, claims
  every slot (`cmpxchg`), then counts the tasks inside `irqentry_enter()`.
  A held CPU whose pending word gets an IPI, or whose timer expires,
  before it is claimed leaves (the sender may be waiting for it), takes
  it and checks in again. Once claimed, a CPU stays until CPU 0 gives it
  back or starts a new round; meanwhile CPU 0 waits for no IPI answer and
  takes no lock a held CPU could own (they are idle). CPU 0 gives the
  claimed CPUs back (unclaimed, still held: `kw_park_unclaim()`) and
  waits again when a claim fails (that CPU just left), when its count
  finds a task not settled (on a CPU, on a runqueue, or `TASK_WAKING`: a
  wakeup queued on a held CPU, whose IPI that CPU then takes), or when
  its own word holds something after the claims (such as a block request
  another CPU queued for it in `kwblk_pending`, whose interrupt a restore
  would lose). A round still missing a CPU after a window is ended (every
  held CPU leaves once, for anything else the missing one may wait for)
  and a new one starts; the window starts at 5 ms and doubles each time,
  so a host that is slow to wake the CPUs' threads does not end every
  round before they check in. At the cycle's 2 s deadline CPU 0 resumes
  kwparkd alone, which resumes the rest with -EBUSY (blocker `cpuN` for a
  CPU that never checked in). On success CPU 0 resumes every task (all
  off their CPUs, so all on fresh stacks), then ends the round.
- **Park points only SMP has**: the TREE_RCU grace-period kthread
  (`rcu_gp_kthread_loop`, at the top of its loop, where no grace period is
  in progress; its wait for a request also ends on `kw_park_pending()`,
  so no grace period starts while kernel threads park). A grace period in
  flight finishes first, which takes 1-2 jiffies: the kernel-thread phase
  is then most of a cycle's time (below). The rcu expedited workers and
  `pool_workqueue_release` are kthread workers; migration, cpuhp and
  ksoftirqd are smpboot threads.
- **The snapshot point**: every CPU but 0 is held in `arch_cpu_idle()`
  (interrupts off, RCU not watching, tick perhaps stopped) with its idle
  task's stack live in its host. For a snapshot each held CPU drains its
  per-cpu page lists (`drain_local_pages()`, in its own irqentry pair)
  before it checks in; its seq-cst check-in orders that before CPU 0's
  claim and free-page walk (CPU 0 cannot IPI a held CPU, so no
  `drain_all_pages()`). CPU 0 then calls `wasm_snapshot_point()` after its
  `irqentry_exit()`, so in the state of the held CPUs. The host copies the
  shared memory during the call: no other CPU's host writes it then (held
  CPUs block in `memory.atomic.wait32`; a claimed one calls no import, and
  a timer check that began just before its claim only reads the clock;
  the console ring is a buffer of its own). Device queues: a block request another CPU
  queued for CPU 0 is seen after the claims, and CPU 0 then gives the
  claims back, takes it and tries again (above); kwnet's queue,
  kwvsock's `tx_queue` and kwsnd's deferred events wait for a work item on
  CPU 0, which is in memory with its pending work and runs after the
  resume (vsock packets for connections the restore resets get an RST from
  the host, as on UP); the host's own checks (block, net, vsock, shm, 9p)
  refuse the rest.
- **Restore**: the host instantiates CPU 0 only and enters `kw_resume`,
  which also sets the instance's `kw_irq_word` global. `__kw_resume()`
  resets what belonged to the old instances: kwemu's code on CPU 0
  (`kw_host_reset()`), the other CPUs' pending words (a kick at most: a
  claimed CPU takes no other IPI), the stacks each CPU had still to drop
  (`kw_stack_drops`) and the rendezvous slots; it marks the parked tasks
  and resumes kwparkd, then asks the host to start every other online CPU
  (`wasm_cpu_start(cpu, idle_task(cpu))`; a refusal panics: that CPU's
  tasks could never run). The host knows it is a restore and enters
  `kw_secondary_resume(idle)` there, which sets `current`, the stack
  pointer and `kw_irq_word`, calls `kw_host_reset()` for that CPU's kwemu
  and nothing of the bring-up (online, clockevent, ISA, page table and the
  idle task's mm are in the saved memory). kwparkd waits up to 30 s for
  every online CPU to report back (`kw_park_back`), else panics naming
  it, before its restore work: each CPU holds its own tasks, and
  `do_settimeofday64()` calls on every CPU. Tasks woken meanwhile on any
  CPU only wait again (Restore, above).
- **The idle tasks' restart**: at the snapshot point every CPU's idle task
  was in the same place: `do_idle()` had run `tick_nohz_idle_enter()`
  (the tick perhaps stopped), `default_idle_call()` had run
  `ct_cpuidle_enter()` (RCU's idle state), and `arch_cpu_idle()` ran with
  interrupts off outside any `irqentry_enter()` (CPU 0 takes the snapshot
  outside its own for this). The fresh instance's interrupt flag is off
  too. Each CPU's fresh stack leaves that state as the old stack would
  have: `ct_cpuidle_exit()` and the interrupt enable (default_idle_call),
  then `tick_nohz_idle_exit()` (ends the nohz idle period: restarts a
  stopped tick, accounts the idle time; the WARNs there check the
  balance), then `cpu_startup_entry(CPUHP_ONLINE)`, whose
  `cpuhp_online_idle()` does nothing for that state and whose `do_idle()`
  enters idle anew. Nothing else on the way out of `do_idle()` holds state
  here: no PREEMPT_COUNT, CPU_IDLE, polling bit, tick broadcast or tracing.
  kwemu's static words need nothing: every CPU is out of `kw_run()` at the
  snapshot point, so `pair_lock` is free, and `code_epoch` only counts up
  (`kw_host_reset()` takes its value). Nor do wait.c's keys and sleeper
  counts (no CPU waits for a lock or a csd there), `kw_tlb_lazy` and
  `kw_tlb_stale` (consistent with the saved state), `jit_busy` (no
  compile in progress) or the per-CPU clockevent expiries (the guest's
  monotonic clock continues, on every CPU: js.md, CPU threads).
- Cost (2026-11-19, Node, i7-10700K, base shell, a busy workload beside
  it): 12-15 ms per cycle on 2, 4 and 8 CPUs (users 1.5 ms, kernel threads
  about 12 ms waiting for a grace period, rendezvous 0.1 ms); kwtest's
  `park:` means 1.3-6.4 ms on 2 and 4 CPUs, 0.3 ms on one. Under host
  load (2026-11-20, 16 host threads, park cycles beside that workload):
  every cycle completed on 8 CPUs beside 16 and 96 busy host processes
  (mean 17 and 36 ms), and on 8 CPUs squeezed onto one host core (57 ms);
  with 8 CPUs on 2 host cores, every node thread at nice 19 beside 4 busy
  processes, cycles took 0.4-0.5 s (at most 1.6 s) and 1 of 70 ended
  -EBUSY in the user phase (a starved user task); none in the
  rendezvous.
- Snapshots (2026-11-20, same machine, the CLI's `{suspend}` in worker
  mode, base shell with a spinning loop per CPU and one more, a pipe pair
  and a sleeper loop): 34-35 MiB on 2 CPUs, 54 MiB on 4, 88-91 MiB on 8
  (each CPU's kwemu state and its decoded code, 512 MiB machines), parked
  and copied in 17-93 ms; Alpine on 4 CPUs 58 MiB in 42-100 ms.
