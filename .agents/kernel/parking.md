# Parking and snapshots

A suspended task's continuation is on its wasm stack in the engine, which
cannot be saved. Parking (`arch/wasm/kernel/park.c`, `asm/park.h`,
`include/linux/kw_park.h`) brings every task to a point where its whole
state is in guest memory, then resumes each one on a fresh stack. Snapshots
are built on it. Every cycle resumes every task through the fresh-stack
path, so kwtest's `park:` check covers it. UP only (SMP, below).

## The cycle

- **Trigger**: a write to `/proc/kwpark` (asynchronous: the writer parks
  too) wakes `kwparkd`. Reading it gives `requests N done N result R users
  U kthreads K us T blocker comm[pid]:state free F` (the last cycle's
  counts, request-to-resume time, the task that blocked it, `-` if none,
  and the free pages left out of the last snapshot).
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
  (`kswapd_loop`), khvcd, kjournald2 (`kjournald2_loop`) and ext4lazyinit
  (`ext4_lazyinit_thread`, at its loop top). Waits that a wakeup does not
  end (`wait_event*()`) also end on `kw_park_pending()`, and the loop then
  skips its work. **A new kernel thread (a driver, a config option) needs
  a park point too**, or every cycle fails with EBUSY naming it; `cat
  /proc/kwpark` after a cycle shows which.
- **Consistent point**: `arch_cpu_idle()` sees `kw_park_final` and, inside
  `irqentry_enter()` with interrupts off and nothing runnable, checks that
  every task is `KW_PARK_PARKED` (and not on a runqueue), a zombie, or
  `TIF_NEVER_RUN`. A snapshot is taken there.
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
  calls `kw_host_reset()` and resumes only kwparkd. kwparkd steps the
  realtime clock to the host's (`do_settimeofday64`), reseeds the RNG
  (`add_vmfork_randomness()`, built for KW_PARK by the generic random
  patch, so that two restores of one snapshot differ), runs the park
  restore notifiers and then resumes everything else. The host offsets its
  monotonic clock so that CLOCK_MONOTONIC and CLOCK_BOOTTIME continue from
  the saved value. Restarting the idle task at `cpu_startup_entry()` is
  fine with TINY_RCU and no CPU_IDLE or CONTEXT_TRACKING_IDLE.
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

`KW_PARK` depends on `!SMP`: an SMP kernel has no `/proc/kwpark`, no
`kw_resume` export (the host's `snapshot()` rejects: "cannot resume one")
and no handler for IRQ 8; kwtest's `park:` check is skipped when `uname -v`
says SMP. Parking there would need:

- `kw_park_final` as a count of CPUs that reached `arch_cpu_idle()` with
  interrupts off (the last one runs the check);
- `kw_unpark_all()` not marking a task whose old stack still runs on
  another CPU (a spurious wakeup into the park loop; `wait_task_inactive()`);
- the check inside `irqentry_enter()` so that RCU watches (TREE_RCU), and
  care restarting the idle task with TREE_RCU;
- every CPU's per-cpu page lists drained before the free-page walk;
- `kwblk_pending` empty at the consistent point (another CPU's request
  raises IRQ 3, which CPU 0 takes before it idles, so the check goes after
  that); the work items devices queue on CPU 0 already run before a
  kworker parks;
- a resumed task setting `thread.stack_cpu`. Moving a user task to another
  CPU (smp.md) already uses the same kind of fresh entry as
  `kw_park_resume()`'s user path.
