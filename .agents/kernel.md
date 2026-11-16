# Kernel

The kernel-side reference for agents. kernel/README.md describes the same
system for users (build steps, CLI options, devices, the guest image). This
file covers how to change the kernel and what must not break.

## Tree and patch workflow

`vendor/src/linux-wasm-kernel` is a git tree on branch `kw-riscv-user`:
base `7595a62d45e` (Linux v7.3.4 from kernel.org) plus one commit per file in
`kernel/patches/linux/`. `arch/wasm` grew from Joel Severin's linux-wasm
series (`joelseverin/linux`, branch `wasm-7.0`); the first two patches
(the arch panic hook, modpost on Wasm) are his as they were, and the arch
patch, which keeps about a quarter of its lines from his port, names him
in a `Co-developed-by` trailer (keep it when rewording that patch). Nothing
is fetched from that fork.
On a fresh clone, build.sh (`prepare_kernel_tree`) creates the branch with
`git am` on a shallow fetch (`git fetch --deepen=100` for more history).

```sh
cd vendor/src/linux-wasm-kernel
git commit -a          # a new patch, or `git commit --fixup X` and then
                       # GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash 7595a62d45e
cd ../../..
kernel/build.sh kernel
rm kernel/patches/linux/*.patch
git -C vendor/src/linux-wasm-kernel format-patch -N -o "$PWD/kernel/patches/linux" 7595a62d45e..kw-riscv-user
```

- The series has one patch per piece: generic changes first (Joel's two,
  stock LLVM, `VMALLOC_FLAT`, 9p `metatimeout`, the kthread park points,
  the random vmfork reseed),
  then the arch, the ISA and hwprobe, each driver (kwblk, kwnet, kwfb,
  kwinput, sysrq, kwsnd, kwvsock, kwshm), parking, kwvsock's reset after
  a snapshot restore (it needs both), and `kw_defconfig` last. A fix or an extension of one of
  them is a `git commit --fixup` of that patch, autosquashed; a new piece
  (a driver, a generic change) is a new patch, placed with its kind, with a
  kernel-style subject (`wasm: ...`). Its config options go in the
  `kw_defconfig` patch. Each patch need not build on its own; the whole
  series must.
- Keep `-N` (no `n/m` counter) on export.
- To check that the series applies to a clean base:
  `git -C vendor/src/linux-wasm-kernel worktree add /path/x 7595a62d45e && git -C /path/x am "$PWD"/kernel/patches/linux/*.patch`,
  built with `KSRC=/path/x KOUT=vendor/build/kernel-x kernel/build.sh kernel`.
- **Config**: `arch/wasm/configs/kw_defconfig` is a hand-written list of
  explicit choices. Never replace it with `savedefconfig` output. build.sh
  reruns `make kw_defconfig` whenever the file is newer than
  `$KOUT/.config`, which overwrites any menuconfig change. Put every change
  in kw_defconfig, rebuild, then check `$KOUT/.config`: Kconfig drops
  options whose dependencies are not met without saying so.
- Kbuild runs the toolchain through
  `kernel/tools/fake-llvm/llvm-wrapper.py` (`LLVM=` is the wrapper and
  `REAL_LLVM=` the real tools). See toolchain.md.
- The kernel builds without warnings; keep it that way. kw_defconfig sets
  `FRAME_WARN=3072` because clang's wasm backend gives each variadic call
  its own 16-byte stack slot (`snmp_seq_show`: 2304 bytes, all others
  under 1024).

## Where things are in the kernel tree

| What | Where |
| --- | --- |
| entry, task switch | `arch/wasm/kernel/entry.S`, `process.c` |
| parking (all tasks to a resumable point), `/proc/kwpark` | `arch/wasm/kernel/park.c`, `asm/park.h`, `include/linux/kw_park.h` (park points in kernel threads) |
| user-mode loop (`kw_run` slices, IRQ and timer checks, yield) | `arch/wasm/kernel/traps.c` (`KW_SLICE` 200000, `KW_ENTRY_COST` 1000, `KW_YIELD_NS` 20 ms) |
| WASI wrappers, `wasi_ptr()` | `arch/wasm/kernel/wasi.c` |
| sync IRQ | `arch/wasm/kernel/sync.c` |
| kwemu glue, ABI check, `kw_cpu_storage` | `arch/wasm/mm/tlb.c` |
| software uaccess and the fault path | `arch/wasm/mm/fault.c` |
| flat vmalloc | `mm/vmalloc-flat.c` (`CONFIG_VMALLOC_FLAT`) |
| riscv syscall table | `arch/wasm/kernel/Makefile.syscalls`, `syscall_table.c` (from `scripts/syscall.tbl`, abis `riscv rlimit memfd_secret`) |
| riscv signal frames | `arch/wasm/kernel/signal.c`, `arch/wasm/mm/sigpage.c` |
| riscv uapi | `arch/wasm/include/uapi/asm/` (ptrace, sigcontext, ucontext, hwcap, hwprobe), `include/asm/elf.h` |
| `riscv_hwprobe`, `riscv_flush_icache` | `arch/wasm/kernel/sys_riscv.c` |
| ISA extensions: the table, `kw.isa=`, the cpuinfo `isa` line, the hwprobe bits | `arch/wasm/kernel/cpu.c`, `kw_isa_init()` from `tlb.c` |
| IRQ numbers | `arch/wasm/include/asm/irq.h` |
| devices | `drivers/tty/hvc/hvc_wasm.c`, `drivers/block/kwblk.c`, `drivers/net/kwnet.c`, `drivers/video/fbdev/kwfb.c`, `drivers/input/kwinput.c`, `sound/drivers/kwsnd.c`, `net/vmw_vsock/kwvsock.c`, `drivers/misc/kwshm.c` with `include/uapi/linux/kwshm.h` |

## The kwemu contract (`include/kw_emu.h`)

`include/kw_emu.h` is the source of truth. The kernel's copy is
`arch/wasm/include/asm/kw_emu.h`. build.sh copies the header over it and
warns if they differed, so a header change also needs a kernel commit and a
patch re-export.

- `KW_ABI_VERSION` is 6. `tlb.c` compares it with `kw_abi_version()` at
  boot and panics on a mismatch. Bump it, in both copies, on any change to
  the layout or the semantics. A new `KW_ISA_*` bit is an ABI change;
  implementing an extension that already has a bit is not. Host imports
  (below) are not part of it.
- Optional ISA extensions: `kw_cpu_init` enables every one kwemu
  implements, and `tlb.c` then calls `kw_isa_init()` (cpu.c), which calls
  `kw_set_isa()` once with what `kw.isa=` leaves on and advertises exactly
  the set it returns. `kw_set_isa()` drops all decoded code, so it is
  meant for boot only.
- `kw_host_reset()` is for a restored snapshot (park.c, `__kw_resume`):
  the memory now belongs to a new module instance, so kwemu forgets its
  JIT slots without `kw_host_jit_free`, asks `kw_host_jit_caps` again and
  drops all decoded code.
- `KW_CPU_SIZE` is 8 MiB, reserved statically (`kw_cpu_storage`), so it
  comes out of guest RAM. Zig checks its layouts against the header at
  compile time through translate-c. About 53 KiB of it is spare
  (kwemu.md, Sizes).
- kwemu has no allocator and no globals. All state lives in `struct kw_cpu`
  and `struct kw_regs`, which the kernel owns.
- Sv39 tables are read at `phys_base + pa`, and kwemu never writes a PTE.
  If A is 0, or D is 0 on a store, it raises `KW_EV_FAULT`. The kernel then
  sets the bits directly (a fast path, like Svadu) or goes through
  `handle_mm_fault`.
- Flushes: the kernel calls `kw_flush_tlb_range`/`kw_flush_tlb_all` from
  `flush_tlb_*` and `update_mmu_cache`, and `kw_set_pgd` from `switch_mm`.
  Code the kernel or the host writes (COW copies, page reuse, file data,
  kwshm) becomes visible only after one of these calls or a guest FENCE.I.
  kwemu tracks guest stores into code exactly by itself.
- `kw_clear_reservation` must be called on every context switch, signal
  delivery and sigreturn (process.c, signal.c), or LR/SC breaks.
- kwemu polls `*irq_pending` (`&wasm_host_irqs`) on entry and at every
  block end, so at least every 64 instructions, and returns
  `KW_EV_INTERRUPT`.
- The `cycle`, `time` and `instret` CSRs return `icount`, not wall time.
  That is why there is no vDSO and `clock_gettime` is a real syscall.
  Signal handlers return through the `[sigpage]` mapping
  (`li a7,139; ecall`).
- The JIT imports (`unkernel.kw_host_jit_caps`/`compile`/`free`) are not
  part of the ABI version, and the kernel never calls them. kwemu imports
  them itself and owns 1024 stub functions in the kernel's exported
  `__indirect_function_table`. Details are in kwemu.md.

## Memory model

- The kernel runs only in the direct map: virtual = physical = linear
  address, and `phys_base` is 0.
- User page tables use the Sv39 layout with riscv's PTE bits
  (`_PAGE_PROT_NONE` = G, the riscv swap format), in 3 levels with the PUD
  folded.
- vmalloc returns direct-mapped memory, so `vmap()` of scattered pages
  fails (nothing in this config hits that). There is no `VMAP_STACK` and no
  stack guard, and per-cpu memory uses `percpu-km`.
- uaccess (`copy_{to,from}_user`, `clear_user`, futex ops) walks the user
  page tables in software and faults pages in. `get_user`/`put_user` and
  `strn*_user` are the generic ones on top of that.
- Kernel memory is not shared (no SharedArrayBuffer). Guest RAM is below
  4 GiB, which makes the lowering exact.

## Tasks: JSPI on one thread

- Every kernel task runs on its own wasm stack. `__switch_to` calls the
  suspending import `wasm_switch_to`, which parks the current stack on a
  promise and resumes the next one, or starts a fresh stack through the
  promising export `ret_from_fork`. `__stack_pointer` and `current` are
  wasm globals, saved in locals across the switch (`entry.S`).
- The kernel is UP with `ARCH_NO_PREEMPT`.
- Suspending imports: `unkernel.wasm_switch_to` and the WASI
  `poll_oneoff`, `sched_yield` and `proc_exit`. They suspend only when the
  host returns a promise. The console read path uses a zero-timeout
  `poll_oneoff`, which must return synchronously.
- Every other import must return synchronously. In particular
  `wasm_driver_block_submit` is called by blk-mq in atomic context.
- `Kernel.stop()` and every exit make the suspending imports return a
  never-settling promise (a fresh one each time, so a dropped instance can
  be collected), and the kernel parks at its next suspension point.
- Keep task switching behind `wasm_switch_to`/`ret_from_fork`, so that
  wasm stack switching can replace JSPI later (status.md).

## Parking: every task's state in memory

A suspended task's continuation is on its wasm stack in the engine, which
cannot be saved. Parking (`arch/wasm/kernel/park.c`, `asm/park.h`,
`linux/kw_park.h`) brings every task to a point where its whole state is
in guest memory, then resumes each one on a fresh stack. Snapshots are
built on it (below; the console and disks are saved so far, status.md).
Every cycle resumes every task through the fresh-stack path, so kwtest's
`park:` check covers it.

- **Trigger**: a write to `/proc/kwpark` (asynchronous: the writer parks
  too) wakes `kwparkd`. Reading it gives `requests N done N result R users
  U kthreads K us T blocker comm[pid]:state` (the last cycle's counts,
  request-to-resume time and the task that blocked it, `-` if none).
- **Phases**: user tasks first (`kw_park_users`), while kernel threads
  still run, so a user task in a D-state wait for a journal commit or
  writeback finishes it; then kernel threads (`kw_park_kthreads`); then
  kwparkd parks itself and sets `kw_park_final`. A task that has not
  parked after 2 s (stopped or traced, in a D-state sleep, a kernel thread
  without a park point, created but never woken) ends the cycle: every
  parked task is resumed and the result is -EBUSY with that task named.
- **User tasks**: kwparkd sets `TIF_NOTIFY_SIGNAL` (repeated every tick
  until the task parks), which ends interruptible sleeps. The task parks
  at the top of `user_mode_loop()`, after the exit work, where its state
  is `pt_regs` plus task_struct (restart block, signal state). Syscalls
  restart (-ERESTARTSYS, -ERESTARTNOHAND, the restart block for nanosleep,
  poll and futex timeouts); the few that do not restart after SIGSTOP and
  SIGCONT either (epoll_wait, sigtimedwait, sockets with a timeout) return
  EINTR once per cycle. Parked tasks sleep in `TASK_IDLE`, so signals
  (even SIGKILL) and tty wakeups wait for the resume.
- **Kernel threads**: kwparkd wakes those sleeping in `TASK_INTERRUPTIBLE`
  or `TASK_IDLE` (never plain D-state sleeps: `kthread()`'s wait for its
  first wakeup has no loop). Each loop has a `kw_park_point(fn, arg)` where
  it holds no locks and has no wait queue entry or timer on its stack;
  `fn(arg)` re-enters the loop without its one-time setup. The set:
  kthreadd (`kthreadd_loop`), `kthread_worker_fn`, `worker_thread` (at
  `woke_up`, idle), `rescuer_thread`, `smpboot_thread_fn`, devtmpfsd
  (`devtmpfs_work_fn`), oom_reaper, kcompactd (`kcompactd_loop`), kswapd
  (`kswapd_loop`), khvcd, kjournald2 (`kjournald2_loop`) and
  ext4lazyinit (`ext4_lazyinit_thread`, at its loop top). Waits that a
  wakeup does not end (`wait_event*()`) also end on `kw_park_pending()`,
  and the loop then skips its work. A new kernel thread (a driver, a
  config option) needs a park point too, or every cycle fails with EBUSY
  naming it; `cat /proc/kwpark` after a cycle shows which.
- **Consistent point**: `arch_cpu_idle()` sees `kw_park_final` and, inside
  `irqentry_enter()` with interrupts off and nothing runnable, checks that
  every task is `KW_PARK_PARKED` (and not on a runqueue), a zombie, or
  `TIF_NEVER_RUN`. A snapshot would be taken there.
- **Resume**: `kw_unpark_all()` marks each parked task `KW_PARK_RESUMING`
  and `TIF_NEVER_RUN` and wakes it. The next switch to it starts a fresh
  stack (the host drops the old one from `resumers`), and `__ret_from_fork`
  calls `kw_park_resume()`: `schedule_tail()` with `set_child_tid` cleared
  (the TID was stored at the first run), then `fn(arg)` (its return value
  goes to `kthread_exit()`), or for a user task `irqentry_exit_to_user_mode()`
  (delivers signals that arrived while parked, no syscall-exit work, so no
  duplicate ptrace stop) and `user_mode_loop()`.
- **Snapshots**: `Kernel.snapshot()` raises IRQ 8, which marks the next
  cycle a snapshot. At its end park.c calls the import
  `wasm_snapshot_point(result, blocker, free_map, free_bits)`: with
  result 0 from the consistent point (after the counts, before anything
  is resumed), where the host copies the memory during the call, leaving
  out the free pages; otherwise with the error and the task that did not
  park. The host answers 0, or -EBUSY if
  its own block, net, vsock or shm queues are not empty or a disk cannot be
  sealed (js.md, Disks in snapshots). A disk's seal happens during this
  call, while nothing runs. A restore instantiates
  the same build (`linux_banner` must match), copies the memory over the
  fresh instance's, clears `wasm_host_irqs` and calls the export
  `kw_resume` (entry.S) instead of `_start`: the idle task on a fresh
  stack, `__kw_resume()`, which calls `kw_host_reset()` and resumes only
  kwparkd. kwparkd steps the realtime clock to the host's
  (`do_settimeofday64`), reseeds the RNG (`add_vmfork_randomness()`,
  built for KW_PARK by the generic random patch, so that two restores of
  one snapshot differ), runs the park restore notifiers and then resumes
  everything else. A driver whose host side did not survive registers one
  (`kw_park_register_restore_notifier()`, linux/kw_park.h; it runs while
  every other task is parked, so it must not wait for one): kwvsock resets
  every connected socket (ECONNRESET, as virtio-vsock does on
  TRANSPORT_RESET after a live migration) except the established ones the
  host keeps (`wasm_driver_vsock_keep(guest_port, host_port)` > 0: the 9p
  sessions of host file systems, whose state the host saved, js.md), and
  listeners stay. The other
  devices need no kernel help: their host side restores what the kernel
  told it (js.md, Devices in snapshots). On SMP the other CPUs would have
  to stay idle until the notifiers return.
  Free pages: just before that call, `kw_park_mark_free()` drains this
  CPU's per-cpu lists (`drain_local_pages()`, as hibernation's
  `swsusp_save()` does) and sets a bit for every page on the buddy free
  lists in a bitmap of `max_pfn` bits (`kvcalloc` on the first snapshot,
  then kept: 16 KiB for 512 MiB), passed as `free_map`. The host leaves
  those pages out (`copySnapshotMemory()`, js.md) and a restore gives them
  zeros. Nothing reads a free page's contents (no PAGE_POISONING;
  `init_on_free` expects zeros), and the free lists link through
  `struct page`, which is saved. `/proc/kwpark` shows the last count
  (`free`, in pages). Dropping clean page cache first gains nothing with
  the initramfs root, whose files are tmpfs (28.6 MiB with
  `drop_caches` against 28.4 MiB without, 2026-11-15), so there is no such
  option; an overlay root on a data disk has cache that could be dropped. The host offsets
  its monotonic clock so that the guest's continues from the saved value
  (CLOCK_MONOTONIC and CLOCK_BOOTTIME do not count the time between save
  and restore). Restarting the idle task at `cpu_startup_entry()` is fine
  with TINY_RCU and no CPU_IDLE or CONTEXT_TRACKING_IDLE; TREE_RCU (SMP)
  would need care there.
- **Cost** (2026-11-15, Node, Alpine at a shell with 3 to 7 user tasks and
  22 to 25 kernel threads): 180-500 µs per cycle. The check in
  `user_mode_loop()` (one load per kernel exit) did not move kwbench:
  0.13 µs per `getppid`, 0.14 ms per fork+exit+wait, with and without it.
  The lowered kernel grew by 1.5 KB raw, 2.3 KB gzip (parking alone). A
  snapshot of a 512 MiB machine (2026-11-15, the CLI's `{suspend}`): at
  a shell 28.4 MiB, after writing and removing 200 MiB in /tmp and a
  `sort` 28.9 MiB (32.0 and 232.1 MiB with the free pages saved too, zero
  64 KiB chunks left out by `encodeSnapshot` either way); parked and
  copied in 10-16 ms (80-90 ms when the whole memory was copied); reading
  and decoding the file 15 ms (122 ms for the 232 MiB one). A restore
  answered its first shell command 215 ms after reading the file, about
  what a cold boot to the prompt takes (210 ms): the gain is the state,
  not the time.
- **SMP** (not done; UP is assumed in three places): `kw_park_final` must
  become a count of CPUs that reached `arch_cpu_idle()` with interrupts
  off (the last one runs the check); `kw_unpark_all()` must not mark a
  task whose old stack still runs on another CPU (a spurious wakeup into
  the park loop; `wait_task_inactive()`); and the check runs inside
  `irqentry_enter()` so that RCU watches, which matters with TREE_RCU.
  The free-page walk then needs every CPU's per-cpu lists drained (each
  CPU drains its own before it counts itself, or the last one drains all
  of them, since the others are idle).
  `kw_park_resume()`'s user path is the fresh entry that status.md's SMP
  item needs for moving a task preempted in user mode to another CPU.

## Host interface

Module `wasi_snapshot_preview1` (kernel `wasi.c`, host `js/core/wasi.ts`):

- `clock_time_get` (monotonic for clocksource, sched_clock and timer;
  realtime for the boot wall clock) and `random_get`.
- `fd_write` (1 = console, 2 = panic text), `fd_read` (0 = console input),
  `poll_oneoff`, `sched_yield`, and `proc_exit` (0 = power off, 1 = halt,
  2 = restart, 253 = panic).
- `args_*`: the command line is argv[1..] joined with spaces (the runtime
  passes `["vmlinux", cmdline]`).
- `fd_prestat_*`, `path_open`, `fd_filestat_get`, `fd_close`: the initrd is
  the file `initrd` in the first preopened directory that has one.
- Preview 1 is a wasm32 ABI. Declare pointer and size parameters `u32` and
  pass them through `wasi_ptr()`, which panics above 4 GiB. Anything that
  may live in high RAM goes through a static buffer in the kernel image or
  the bounce buffer.

Module `unkernel`: `wasm_switch_to`, `wasm_snapshot_point` (park.c),
`wasm_driver_block_info`/`submit`/`reap`
(kwblk), `wasm_driver_net_init`/`send`/`rx_len`/`recv` (kwnet; `net_init`
< 0 means no device), `wasm_driver_console_size` (`rows << 16 | cols`, 0 =
unknown), `wasm_dump_stacktrace`, kwemu's `kw_host_jit_caps`/`compile`/
`free`, and the display, input, sound, vsock and shm imports below. Module
`env` holds only `memory`. A host must provide every import, or
instantiation fails.

Display, input, sound, vsock and shm are lazy: each `_init` import returns
< 0 when the host has no such device, and then nothing is registered.
Display, input and sound allocate nothing until a program opens the
device, and the host is told on open and close. None of these imports
suspends. Each new device must add only its own imports (diff the
module's imports against a build without it).

- **kwfb** (`/dev/fb0`, 32 bpp XRGB8888, write and mmap):
  `wasm_driver_fb_init()`; `wasm_driver_fb_mode()` (`width << 16 | height`,
  0 = 640x480), asked at the first open; `wasm_driver_fb_attach(pixels,
  width, height, stride, format)` at the first open and on every mode
  change, with NULL at the last close. It returns the size at which the
  host shows the picture, in mm (`width << 16 | height`, 0 = unknown),
  which becomes `fb_var_screeninfo` `width` and `height` (X.Org's fbdev
  driver ignores those and assumes 96 dpi; Qt's linuxfb uses them). The
  host reads the pixels in place whenever it runs; there is no vsync. The
  buffer is one contiguous allocation, and the buddy allocator gives at
  most 4 MiB, so each side is clamped to 64..4096 and a mode above 1M
  pixels is divided by the smallest integer that fits; if the allocation
  still fails, the size is halved. `FBIOPUT_VSCREENINFO` changes the size
  only while the caller's file is the only one open and nothing is mapped
  (EBUSY otherwise); `line_length` is always 4 * xres. One program has
  the display at a time: a user open fails with EBUSY while another user
  open file exists (kernel opens, `user == 0`, are not refused; there is
  no fbcon). The claim is the file's, so it lasts through fork and through
  a mapping that outlives `close()`, and ends at the file's release, which
  exit always reaches. mmap inserts the pages directly: `vm_insert_page`
  rejects large kmalloc pages here.
- **kwinput** (evdev, present only with the display): event0 "kwinput
  keyboard" (keys 1..255, no autorepeat), event1 "kwinput mouse"
  (REL_X, REL_Y, REL_WHEEL, three buttons) and event2 "kwinput tablet",
  an absolute pointer like QEMU's usb-tablet (ABS_X/ABS_Y 0..32767 for the
  whole picture, REL_WHEEL, three buttons; no BTN_TOUCH, tool bits or
  INPUT_PROP_DIRECT, so udev and libinput call it a mouse with absolute
  motion and X's evdev an absolute pointer; device numbers 0, 1, 2 in the
  events and the open mask). `wasm_driver_input_init()`;
  `wasm_driver_input_state(mask)` from the open and close callbacks;
  `wasm_driver_input_read(buf, max)` pulls 12-byte events (device, type,
  code, value) after the host raises IRQ bit 5. kw_defconfig switches HID
  and the hardware input drivers off. Only user space may open these
  devices: the host routes keys to evdev instead of the console while the
  keyboard is open, so an in-kernel input handler that opens what it
  matches breaks the console. sysrq's handler is a passive observer on
  wasm (the `wasm: sysrq` patch, `passive_observer`: it sees events while evdev has the
  device open, so Alt-SysRq works then, but never calls `open`). A lower
  `MAGIC_SYSRQ_DEFAULT_ENABLE` would not do: writing a non-zero
  `kernel.sysrq` registers the handler again, and systemd sets 16. Any new
  handler (VT kbd, leds, mousedev, joydev) needs the same care; kwtest's
  `input handlers` check fails on handlers other than evdev and sysrq, and
  `test/api.test.ts` asserts that nothing is open before glimmer opens the
  devices.
- **kwsnd** (ALSA card 0, `hw:0,0`, playback only, U8 and S16_LE, mono or
  stereo, 8000-48000 Hz, plus OSS `/dev/dsp` through SND_PCM_OSS; no
  mixer, no PCM timer, no `/proc/asound`): `wasm_driver_sound_init()`
  (the host's preferred rate, or 0); `wasm_driver_sound_event(event, rate,
  channels, format)` (0 close, 1 open, 2 prepare, 3 start, 4 stop);
  `wasm_driver_sound_write(buf, bytes)`, which the host copies during the
  call and answers with the frames it has queued. A kernel timer on the
  host's monotonic clock hands over the frames that the elapsed time is
  worth every 5-10 ms; it uses no IRQ bit. A late tick hands over at most
  three ticks' worth, and an underrun stops the stream, so nothing spins.
- **kwvsock** (host `js/core/vsock.ts`): an AF_VSOCK transport on
  `virtio_transport_common`, registered as the G2H transport the way
  `vsock_loopback` registers its local one (KWVSOCK selects
  VIRTIO_VSOCKETS_COMMON and needs no VIRTIO; `virtio_transport_stream_allow`
  lives in virtio_transport.c, so kwvsock has its own). Guest CID 3
  (`KWVSOCK_GUEST_CID`), host CID 2; streams only (no seqpacket, no
  datagrams). Packets are virtio-vsock's (`struct virtio_vsock_hdr`, then
  the payload); the host runs the other end of the protocol. Without the
  device AF_VSOCK `connect()` fails with ENODEV. Sends keep their order: a
  packet the host refuses (-EAGAIN) goes back to the head of the queue and
  is retried after IRQ 6 (the SDK refuses only through its `refuse` test
  hook, since credit bounds the data). RX takes packets into linear skbs
  of at most `rx_max` (32 KiB less the shared info, which the host keeps
  every packet within) and calls `virtio_transport_recv_pkt(..., NULL)`
  (global mode, like virtio-vsock); a failed skb allocation leaves the
  packet with the host and retries 10 ms later. kw_defconfig: VSOCKETS,
  VSOCKETS_DIAG (`ss --vsock`), KWVSOCK, not VSOCKETS_LOOPBACK. Cost:
  +45 KiB lowered kernel (+15.7 KB gzipped).
- **kwshm** (UAPI `include/uapi/linux/kwshm.h`; host `js/core/shm.ts`):
  the host reads and writes the pages of guest shmem files (memfds,
  `/dev/shm` files) in place. An export is a file or a page-aligned range
  of one, with an id (IDR, cyclic from 1, shared by host and guest
  exports; at most 4096, and at most half of RAM pinned). Its folios are
  pinned with `memfd_pin_folios()` (FOLL_PIN with FOLL_LONGTERM semantics,
  udmabuf's interface), which also allocates holes, so every page the host
  sees is the file's. A pin rather than a plain reference: both make
  migration fail, but a pin is the documented way to give something
  outside the kernel's mappings long-lived access, lets compaction skip
  the folio early (`folio_maybe_dma_pinned()`), and moves pages out of
  ZONE_MOVABLE/CMA first (none here). `F_SEAL_WRITE` uses the same
  refcount test, so it fails with EBUSY while exported. No swap and no THP
  here. A truncation or hole punch removes pinned folios from the page
  cache (`folio->mapping` becomes NULL) but cannot free them, so the host
  never touches freed or reused memory; its view may go stale. Stale means
  another size (`i_size` against the export's; range exports are clamped
  to their range) or a held folio whose mapping or index no longer
  matches. Unpinning marks a writable export's folios dirty
  (`folio_mark_dirty_lock()`). Host writes bypass kwemu: code the host
  writes into a page a guest program executes is not seen until a FENCE.I
  or a flush.
  Ordering: every export is announced (attach) when it is made, refreshed
  and released, so a guest export's page list is already at the host when
  the guest sends its id, and an attach comes before the reply to the
  request that caused it. A refresh unpins the old pages only after the
  new list's attach, a release only after the detach returned. Host opens
  look the name up in PID 1's fs (`scoped_with_init_fs()`: a kworker's own
  root is nullfs) without following a final symlink. The guest side is
  the misc device `/dev/kwshm` (ioctl magic 0xBB, listed in
  ioctl-number.rst; the UAPI header documents it); closing the file
  releases its exports, and an export is writable for the host only if
  the fd is writable and not sealed against writes. One mutex covers
  everything. There is no change notification: the host learns staleness
  with a check, a round trip. At power-off the kernel releases nothing;
  the host forgets every export. The request layout and the imports are
  in the driver and `js/core/shm.ts`. kw_defconfig: KWSHM (depends on
  SHMEM and MEMFD_CREATE). Cost: +6 KiB lowered kernel (+1.8 KB gzipped).
- **9p** (host `js/core/9p.ts`, guest `kernel/guest/kw9p.c`): host file
  systems use the stock 9p client with the fd transport, no driver and no
  host import. kw9p connects an AF_VSOCK socket to the host (CID 2, port
  564) and mounts 9p with `trans=fd,rfdno=S,wfdno=S`,
  `cache=readahead` and `metatimeout=1000` on it; the client takes its
  own references to the socket, so kw9p exits after mount(2) and
  unmounting closes the connection. What the guest caches and for how
  long is in js.md (Host file systems). Stock fs/9p has no attribute
  timeout and no way for the server to invalidate a guest cache; the
  patch `9p: add metatimeout` adds `metatimeout=MS`: CACHE_META with an
  expiry per inode (`v9fs_inode.attr_expire`, set in
  `v9fs_stat2inode_dotl`), checked in `__v9fs_lookup_revalidate` and
  `v9fs_vfs_getattr_dotl`; `v9fs_refresh_inode_dotl` then drops the pages
  of a file whose qid.version, size or mtime changed and leaves a name
  that now holds another qid.path invalid. Negative dentries default to
  the same expiry. The option is meant for 9P2000.L: only there does it
  set the expiry and refresh a stat (with the legacy protocols lookups
  always revalidate, but a stat of a cached inode is not refreshed);
  without the option nothing changes. `v9fs_get_tree` refuses it with
  EINVAL in any cache mode with CACHE_WRITEBACK (mmap, loose, fscache, or
  a bitmask with that bit), because the CACHE_META getattr path skips the
  flush of dirty pages and a refresh rewrites the inode from the server,
  which could truncate pending writes; kw9p uses cache=readahead.
  kw_defconfig: NETWORK_FILESYSTEMS (the menu that holds 9P_FS; nothing
  else in it is on), NET_9P (selects NETFS_SUPPORT), NET_9P_FD, 9P_FS; not
  9P_FS_POSIX_ACL, 9P_FSCACHE or the virtio, Xen, RDMA and USB
  transports. Cost, measured 2026-11-15 against the build before it:
  +141 KiB lowered kernel (+52 KB gzipped), 28 KiB of RAM (the boot
  "Memory:" line); metatimeout adds under 1 KiB to the bundle. kwtest
  checks that the type is registered.

The host writes kernel memory only for `wasm_host_irqs`, kwblk/kwnet data,
kwinput events, kwvsock packets, kwshm requests, the pages of shmem files
exported to it (kwshm, ShmFile.write) and WASI results. It does not write
`boot_command_line` or the initrd bounds. `test/wasi-node.ts` boots with
Node's `node:wasi` for every WASI import and checks this side against a
third-party implementation.

## IRQs and time

- IRQs are bits in `wasm_host_irqs`, written by the host and polled
  (`asm/irq.h`): console = 1 (input or a window resize), net = 2, block =
  3, sync = 4 (`ksys_sync()` from a work item; requests coalesce; host
  `Kernel.requestSync()`), input = 5 (kwinput events queued), vsock = 6
  (kwvsock packets queued, or room again after a refused send), shm = 7
  (kwshm requests queued), snapshot = 8 (a park cycle that ends in
  `wasm_snapshot_point`; host `Kernel.snapshot()`). Bits without a handler
  are cleared and ignored.
- The timer is a one-shot deadline, checked against the host monotonic
  clock.
- Everything is checked when a slice ends and in `arch_cpu_idle`
  (`wasm_idle(timeout)`: a `poll_oneoff` on stdin and the deadline). A
  slice is 200k user instructions of the CPU, not of one `kw_run` call:
  `cpu->budget` is refilled only after `KW_EV_BUDGET`/`KW_EV_INTERRUPT`,
  and each syscall and page fault costs `KW_ENTRY_COST` (1000) of it.
  Otherwise a loop of cheap syscalls never sees a timer tick and is never
  preempted (apt busy-polls dpkg's status pipe with `pselect()` after EOF,
  and dpkg never runs again).
- While user code is busy, the kernel yields to the host every 20 ms.
  After idle and after a yield, it sets the console bit itself when stdin
  is readable, for hosts that never write `wasm_host_irqs`.
- The host relies on this: every slice end reads the monotonic clock
  (`clock_time_get`) before `wasm_poll_irqs`. Worker mode's shared
  transport (js.md) drains its input rings in that import and sets the IRQ
  bits there, so the kernel takes them in the same slice end (in a guest
  busy loop the clock ran every 0.6 ms p90 with the JIT, 1.3 ms without;
  2026-11-14). Keep a clock read at the slice end if `do_user_interrupt`
  changes.
- irq_work runs from the timer tick: `arch_irq_work_has_interrupt()` is
  false, since nothing could raise the interrupt (otherwise irq_work never
  runs and every Tiny SRCU `synchronize_srcu()` hangs: inotify `close()`,
  systemd).
- A single long stay in the kernel (one big syscall) still delays these
  checks until it returns. See status.md.

## riscv64 user ABI

- Syscall numbers come from `scripts/syscall.tbl` through pt_regs wrappers,
  so every syscall has one wasm type.
- Generic code takes ABI choices from arch `Kconfig` selects. Riscv's
  clone argument order is `CLONE_BACKWARDS` (otherwise `tls` and
  `child_tid` swap and every pthread program breaks). Compare with
  `arch/riscv/Kconfig` before adding a syscall-ABI select.
- ELF: `EM_RISCV`, `AT_HWCAP` = IMAFDC (single letters only, never more),
  `AT_MINSIGSTKSZ`. `riscv_flush_icache` flushes kwemu's translations.
- ISA advertising (cpu.c): one table of multi-letter extensions in the
  canonical order of riscv's `riscv_isa_ext[]`, each with its kwemu bit (0
  for ones every kwemu has: Zicbop, Ziccamoa, Ziccif, Zicclsm, Ziccrse,
  Zicntr, Zihintntl, Zihintpause, Za64rs, Zaamo, Zalrsc, Zca, Zcd) and its
  hwprobe bit, in `IMA_EXT_0` or, for the platform properties Ziccamoa,
  Ziccif, Zicclsm, Ziccrse and Za64rs (kwemu.md), in `IMA_EXT_1`. The
  effective set (implemented, minus `kw.isa=`) gives the `/proc/cpuinfo`
  `isa` line and `riscv_hwprobe` `IMA_EXT_0` and `IMA_EXT_1`;
  `ZICBOP_BLOCK_SIZE`, `ZICBOZ_BLOCK_SIZE` and `ZICBOM_BLOCK_SIZE` are 64
  while that extension is listed. User space picks code paths from these
  (OpenSSL reads `IMA_EXT_0`, V8 on musl only the cpuinfo line), so an
  extension is listed only once kwemu implements it. Optional ones listed
  by default: Zicbom, Zicboz, Zicond, Zihpm, Zimop, Zawrs, Zfa, Zfhmin,
  Zcb, Zcmop, Zba, Zbb, Zbc, Zbkb, Zbkc, Zbkx, Zbs, Zknd, Zkne: all of
  RVA23U64 but V and its sub-extensions, Supm and Zkt. Not listed: Zkt
  (kwemu's AES is not constant-time, kwemu.md), Supm (pointer masking:
  dropped), Zmmul (M implies it and upstream has no name for it).
  `MISALIGNED_SCALAR_PERF` (and `CPUPERF_0`) is FAST: a misaligned access
  costs what an aligned one does, several times less than its bytes one by
  one. `MISALIGNED_VECTOR_PERF` is UNSUPPORTED (no V). `riscv_hwprobe`
  ignores `RISCV_HWPROBE_WHICH_CPUS` and answers as for a plain query.
  `HIGHEST_VIRT_ADDRESS` is 1 << 38 (`STACK_TOP_MAX`, as riscv Sv39), the
  THEAD, SIFIVE and MIPS vendor keys are 0, and `TIME_CSR_FREQ` is
  unknown (key -1), because the time CSR counts instructions.
- ptrace has no regsets, so strace and gdb do not work. There are no core
  dumps, seccomp, modules, swap or kallsyms. Kernel stack overflow (16 KiB
  shadow stacks) is not detected, and a wasm trap in the kernel ends the
  session.

## Two builds: wasm64 and lowered

`vmlinux` uses memory64 and table64. `kernel/build.sh lower` runs it
through Binaryen (`wasm-opt -g --memory64-lowering --table64-lowering`) to
make `vmlinux32.wasm`. Pointers stay i64 in the code and at the JS
boundary. Only memory and table accesses are wrapped to i32, which is exact
because RAM is below 4 GiB. The runtime picks the memory type with
`moduleIsMemory64()`, which reads the module's `target_features` section.

The lowered build runs at the same speed in V8, is about 20% faster in
JavaScriptCore, and needs no memory64. The bundle, the page, the CLI's
default and `createKernel()` all use it. `vmlinux` stays the build input
and the reference (`--kernel vendor/build/kernel/vmlinux`). `lower` is
required: build.sh fetches Binaryen 133 if it finds no `wasm-opt` with
`--table64-lowering`.

## Kernel tests

- kwtest (`kernel/guest/kwtest.c`, `/usr/bin/kwtest` in local builds and
  `alpine-test.cpio`, not in release bundles; kernel/README.md, alpine):
  run as `rdinit=` on both builds, with and without `--no-jit`. Device
  nodes come from devtmpfs when it is mounted, else they are made in
  `/tmp`; it never opens a node in `/tmp` once `/dev` has one, because
  the overlay root mounts `/tmp` nodev. It powers off on
  success and halts (exit 1) on failure. What it covers beyond syscalls:
  - ISA, reading `kw.isa=` from `/proc/cmdline`: the cpuinfo `isa` line
    (order, names, what must be listed), `riscv_hwprobe` `IMA_EXT_0` and
    `IMA_EXT_1` against it (and the three CBO block sizes, misaligned
    scalar FAST and vector UNSUPPORTED), misaligned loads and stores in a
    page and across pages (Zicclsm), `AT_HWCAP`, the hints and counters, and one
    probe instruction per optional extension that must raise SIGILL
    exactly when the extension is not listed (`isa_exts`). Listed
    extensions get result checks long enough to compile: FIPS-197 AES-128
    (Zkne/Zknd), OpenSSL's GHASH (Zbc or Zbkc, Zbkb), 13 B/Zicond
    instructions against plain C, a Zcb-compiled function against rv64gc,
    the MOPs, Zfa rounding/fli/fmin/fmax against libm, Zfhmin conversions,
    Zihpm counters reading 0, and the CBOs (including SIGSEGV on read-only
    and PROT_NONE pages, SIGILL for cbo.inval). Run it with
    `kw.isa=rv64gc` too after an ISA change.
  - `hot loops (JIT)` and `FP hot loop (JIT)` run long enough to compile
    (self-looping blocks with page faults, a thread, a COW child,
    SIGALRM); the FP hash comes from a native build (`fphot()`).
  - AF_VSOCK: with the host device (the CLI's default) the guest CID is 3
    and a connect to host port 9 is refused (ECONNRESET); without one
    (`--no-vsock`) `connect()` fails with ENODEV.
  - kwshm (CLI `--shm`, skipped otherwise): page counts of a 1 MiB memfd
    with holes and of a 10000-byte range, the EINVAL refusals (unaligned
    offset, range past the end, a pipe), `F_SEAL_WRITE` EBUSY while
    exported and fine after release or closing `/dev/kwshm`, a second
    release ENOENT.
  - kwfb (CLI `--display`, skipped otherwise): a second open of
    `/dev/fb0` fails with EBUSY while the first is open, while a forked
    child still holds the file after the parent closed it, and while a
    mapping outlives `close()`; it opens again after the child's exit and
    after `munmap`.
  - `config:` checks the options below, and `input handlers` that no
    input handler besides evdev and sysrq is registered.
- kwbench (`rdinit=/usr/bin/kwbench`, add `--stats` for the JIT counters)
  gives rough guest speed.
- `node test/wasi-node.ts`: the WASI side under `node:wasi` (no JIT).
- Ubuntu (`kernel/build.sh ubuntu`, kernel/README.md, Ubuntu) is the glibc
  check: boot it, and with a network run an `apt-get install`. To list
  what a userland lacks, build a throwaway kernel (`KOUT=` elsewhere) that
  `pr_info`s every `-ENOSYS` in `do_syscall` and every `do_user_trap`
  (traps.c); Ubuntu 24.04 boot, apt and python3 hit neither, systemd only
  `bpf` and `keyctl`. For a hang, the same kernel can print each user
  task's state and `a7` (the syscall it sleeps in) from `arch_cpu_idle`
  every 20 s; a busy host can be paused through the Node inspector
  (`kill -USR1`, then `Debugger.pause` over CDP), which shows the wasm
  kernel stack at the next import call.
- kw_defconfig has what systemd needs (CGROUPS, NAMESPACES, KCMP,
  FANOTIFY, AUTOFS_FS, EXT4_FS_SECURITY) and cheap options that tools probe
  for (CGROUP_PIDS, USER_NS, CHECKPOINT_RESTORE, PSI, TASKSTATS with I/O
  accounting, USERFAULTFD, IP_MULTICAST, the socket DIAGs, BLK_DEV_LOOP
  with MIN_COUNT=0, TUN, MAGIC_SYSRQ with its passive handler, see
  kwinput), and FUSE_FS for sshfs, rclone and AppImage (measured
  2026-11-14: +129 KB raw, +48 KB gzip, 20 KiB RAM). BPF_SYSCALL, KEYS, IPV6 and SECCOMP stay off. COREDUMP must
  stay off until the arch has `elf_core_copy_task_fpregs` and riscv64 core
  notes: without them a fault with a core limit is a wasm trap.
- To measure an option, copy a built `$KOUT`, append the option to its
  `.config`, run `make olddefconfig` and `vmlinux` with build.sh's make
  variables, lower it, and compare sizes. Also diff the module's imports
  against the base build: a new unresolved import (one the arch lacks)
  traps when it is called.
- Options left off, measured 2026-11-14 (one per build; base
  `vmlinux32.wasm` 6.83 MB raw, 2.21 MB gzip -9; RAM from the boot
  "Memory:" line). Remeasure if the tree has moved a lot.

  | Option(s) | raw | gzip | RAM | enables / checked |
  | --- | ---: | ---: | ---: | --- |
  | KEYS | +64 KB | +24 KB | 4 KiB | keyctl (systemd's other ENOSYS), cryptsetup |
  | VFAT_FS + NLS 437, iso8859-1, utf8 | +92 KB | +35 KB | 20 KiB | FAT images |
  | SWAP + ZRAM (lzo-rle) | +96 KB | +36 KB | 4 KiB | swap for 256 MiB phones; 64 MiB zram swapon worked |
  | MISC_FILESYSTEMS + SQUASHFS (zlib, xz, zstd) | +156 KB | +56 KB | 16 KiB | AppImage, snap |
  | TLS + CRYPTO_CHACHA20POLY1305 | +181 KB | +66 KB | 40 KiB | kTLS works, but curl, Node, Go, rustls, BoringSSL and busybox wget never use it, and the kernel's AES-GCM is no faster than user-space Zkn |
  | IO_URING | +192 KB | +71 KB | 16 KiB | liburing, PostgreSQL |
  | IPV6 | +467 KB | +170 KB | 52 KiB | `::1` ping worked; IPv6 is out of scope for now |
  | BPF_SYSCALL + CGROUP_BPF | +903 KB | +313 KB | 112 KiB | `docker run` (runc/crun device cgroup) worked with it |

  IKCONFIG/IKCONFIG_PROC: clang crashes on `kernel/configs.o`.
- tcrypt cannot benchmark here: `sec=N` loops forever (jiffies do not
  advance inside one long kernel stay) and `sec=0` needs `get_cycles`,
  which is 0 on arch/wasm.
