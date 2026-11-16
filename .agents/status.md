# Status: roadmap and open issues

Remove items when they are done.

## Not in the image

`kernel/guest/fbdoom`, `fbdoom-patches/`, `dosbox` and `dosbox-build/`:
fbDOOM built in the guest with tcc, and DOSBox 0.74-3 on a patched static
SDL 1.2, both on `/dev/fb0` with evdev input and `/dev/dsp` sound. The
page's launcher reaches fbDOOM: its Doom demo writes the script and the
patches into the guest (Vite `?raw`), which builds it there. DOSBox still
waits for a way to distribute prebuilt guest packages: its launcher demo
(Windows 3.1 from archive.org, `web/src/demos/windows.ts`) is hidden, and
building it in the guest (`dosbox-build/guest-build.sh`, g++ -O1) had
built SDL and 16 of DOSBox's ~250 files after 16 minutes, so a whole
build would take hours (2026-11-15).

The FreeDOS launcher demo (`web/src/demos/dos.ts`, hidden) boots the FreeDOS
1.2 boot floppy in Alpine's qemu-system-i386 with the curses display. It
works but is too slow for the launcher: as shipped, the floppy took about
70 s from qemu's start to the prompt (CLI, 2026-11-15). A stripped
FDCONFIG.SYS and AUTOEXEC.BAT, and resuming from a qemu state saved at
the prompt (in the demo now), did not make it fast enough on the page.
qemu's TCG keeps writing new code, which kwemu interprets or recompiles.

## Roadmap

1. **JIT**: AMOs and LR/SC, bigger regions (most remaining exits leave
   full ones), exits into self-loop modules, the op arena's reset policy
   (node startup), AES and GHASH codegen (guest HTTPS). Details in
   kwemu.md (Numbers, Next steps).
2. **ISA extensions**: all of RVA23U64 is in except V (and its
   sub-extensions), Supm (dropped) and Zkt (not advertised: kwemu's AES
   uses data-indexed tables). Next: V; a constant-time AES (bitsliced
   S-box) if Zkt is wanted; JIT support for fcvtmod.w.d and Zfhmin if they
   show up hot.
3. A cheaper data-TLB fast path, which also helps without the JIT.
4. **Worker mode** (`createKernel({ worker: true })`, CLI `--worker`, page
   `?worker=1`; js.md, Worker mode). Before it becomes the page default:
   a hand test on the page and on an iPhone over https, the page with
   `?worker=1` in desktop Safari and Firefox, and browser tests for worker
   mode. Open:
   - Without cross-origin isolation (a plain-http LAN page) input and
     frames wait for the worker's next yield (up to 20 ms while the guest
     is busy).
   - Console output from the worker is posted only when the kernel
     suspends (per microtask).
   - A `display` function is re-asked only on resize(),
     `updateDisplaySize()` and the page's resize and rotate toggle, not
     when a program opens /dev/fb0.
   - The CLI's `--worker` compiles the kernel before it creates the
     worker, so it pays the worker's startup in series (about 34 ms).
   - The page's fallback for an engine that cannot post a compiled module
     to a worker (boot.ts, `inWorker`) has never run: no such engine was
     found.
5. **One kernel shared by many tabs** in a SharedWorker, over the existing
   message protocol (it cannot share memory with pages; each tab could
   show its own terminal windows, web.md). Check first: SharedWorker on Chrome for
   Android, and JSPI inside one. A service worker is unsuitable, since
   browsers stop idle ones.
6. **Ubuntu**: Ubuntu Base 24.04 boots from a disk (`kernel/build.sh
   ubuntu`, kernel/README.md), apt works, and systemd boots to
   multi-user.target once installed from apt. Next: network under systemd
   (systemd-networkd or a kw-net unit), a prebuilt systemd image, BPF,
   keys, IPv6 and cgroup controllers if a service needs them (costs in
   kernel.md), then the page. 25.10 and later need V.
7. **Stack switching.** The wasm stack-switching proposal is at Phase 3,
   behind a flag in V8 and missing from WebKit (Node 26:
   `--experimental-wasm-wasmfx`). With a module-defined memory and stub
   (or `fd_pread`-backed) kwblk/kwnet imports, that is what a standalone
   WASI runtime still needs. The generic services already use WASI
   preview 1.
8. **SMP** is a design question. It needs shared memory (so cross-origin
   isolation and a secure context), one kernel instance per worker,
   per-CPU kwemu state and JIT tables, wasm atomics for AMOs and LR/SC,
   and TLB shootdowns through the polled IRQ bits. JSPI-suspended stacks
   cannot move between threads, so a task moves only where its stack can
   be dropped and it can start on a fresh one (step 3); parking assumes
   UP in the places listed in kernel.md, Parking.
   Step 1, toolchain (2026-11-16, on the `smp` branches): the UP kernel
   builds with atomics and links with `--shared-memory` (kernel.md,
   Memory model), survives Binaryen's lowering, and passes kwtest (JIT
   and `--no-jit`, lowered and wasm64) and a snapshot round trip on a
   shared `WebAssembly.Memory` in Node. The JIT declares its memory
   import shared (caps bit 3, kwemu.md). Cost on one CPU (Node, kwbench
   medians of 15 alternating runs): page faults +21% (458 to 562 ns) and
   kwbench's fork of an 8 MiB process +31%, both from the kernel's
   atomic RMW instructions (kwemu built with atomics alone costs
   nothing); sharing the memory adds nothing measurable beyond that.
   Syscalls, pipes, futex wake and user code are within noise. The
   lowered kernel is 41 KB smaller (9 KB gzip).
   Where the cost is (2026-11-16, i7-10700K, Node 24): V8 compiles every
   atomic RMW, cmpxchg and seq_cst atomic store to a locked instruction,
   about 4 ns each (0.2 for the plain op, 7 ns for `atomic.fence`, +0.1
   for an atomic load), shared memory or not. Counted per site by
   wrapping each atomic instruction of the lowered module in an
   exported counter, an anonymous write fault did 20 locked ops, its
   munmap 10 per page and a fork+exit of an 8 MiB process about 8,750
   (4 per page: refcount and mapcount, copied and dropped); count × 4
   ns is the whole slowdown. Plain `atomic_read`/`atomic_set` (they are
   relaxed) and no `folio_ref_add(folio, 0)` (two patches) bring the
   fault to 16 locked ops and 469 ns, from 482 (414 without atomics;
   medians of 15 runs of a 400k-fault loop). Of the rest, 8 per fault
   and 8 per munmapped page are UP vmstat (`zone_page_state_add` and
   friends, two `atomic_long_add`s per update), which an SMP config keeps
   in per-cpu diffs instead: with those plain (an experiment, not in the
   tree) a fault costs +7% and munmap +11% over base. The other 8
   (mmap_lock trylock and unlock, LRU-batch refcount, freeze and flags,
   `SetPageAnonExclusive`) are needed on SMP, which also adds spinlocks
   (PTE lock, pcp lock: about 4 more locked ops per fault). Fork stays
   at +33% unless folios grow beyond a page.
   Step 2, an SMP kernel in Node (2026-11-16; kernel.md, SMP; js.md, CPU
   threads): `kw_smp.config` builds it, and `node js/cli.ts --kernel
   <its vmlinux32.wasm> --smp 2` boots Alpine to a shell on two CPUs
   (worker mode, interpreter only). kwtest passes on 2 CPUs (40 of 40
   runs) and 4 CPUs, with its new `smp:` check; the park check is
   skipped there. Two spinning processes take 1.22 s against 2.42 s on
   one CPU, two loops of 500 fork+exec 0.66 s against 1.21 s, and four
   parallel `wget`s through kwnet check out. Cost on one CPU against the
   UP build (Node, kwbench and the page-fault tool, medians of 7
   alternating runs, interpreter only): user code, syscalls and memory
   copies unchanged; `clock_gettime` +17%, anonymous fault +40%, COW
   fault +33%, munmap +18%, fork+exit+wait +46%, fork of an 8 MiB
   process +58% (atomics, spinlocks, per-CPU offsets, the interrupt
   check on every enable); on two CPUs fork costs +85-92% (the child
   starts on the other CPU: two cross-CPU wakeups).
   Step 3, moving tasks (2026-11-16; kernel.md, SMP): a user task may
   move at the reschedule on its way to user mode (after a system call,
   a fault or a slice end) and starts on a fresh stack on its new CPU,
   so the load balancer and affinity changes now move tasks; one asleep
   in a system call stays until it returns. `sched_setaffinity()` (and
   `taskset`) records the mask at once and the task moves on its way to
   user mode (a busy thread within 10 ms in kwtest). A workqueue rescuer
   moves to the per-CPU pool it serves (it used to run that CPU's work
   items on its own, with a warning). kwtest's new `move:` checks pass
   on 2 CPUs (20 of 20 runs) and 4 CPUs (10 of 10); a migration storm
   (threads changing their own and each other's affinity while doing
   system calls, faults, forks, queued signals and FP work, 4.3 min per
   session on 2 and 4 CPUs, 24,000 and 62,000 moves, step 2's
   kwmmstress alongside) found no error, lost signal or kernel warning.
   Balance on 2 CPUs (Node, 3 runs each, interpreter only; one busy
   process 0.61 s): four busy processes started from one shell 1.26-1.30
   s against step 2's 1.24-1.92 s (fork placement is luck there), four
   started on CPU 0 and then let go 1.30-1.35 s against 1.86-1.97 s,
   four threads 1.23-1.24 s against 1.29-1.84 s; fork+exec loops
   unchanged (fork places the children). In an Alpine boot to a shell
   no user task moved (10-18 preemptions on the way to user mode, all
   resumed in place), and kthreads restarted on another CPU 6 times on 2
   CPUs, 21 on 4. Cost (kwbench, the page-fault tool and a pipe and
   spin benchmark, 14 rounds in random order against step 2's kernels,
   interpreter only): on one CPU and on two every metric moved by -7%
   to +4% (`getppid` 0.11 µs either way, a slice-bound spin -1% and
   -3%), within the noise of the UP pair, whose code is the same
   (-2% to +5%). A secondary
   CPU's exit, trap or fatal error now also raises the stop IPI on CPU
   0, which a CPU takes even while spinning with interrupts off, so the
   session ends with that CPU's code (a panic and a poweroff on CPU 1
   were run; the spinning case only by reading the code).
   Open, roughly in order:
   - A task asleep in a system call stays on its CPU until it returns,
     and so does one preempted in the kernel (`cond_resched()`): their
     stacks are live. An interruptible sleeper could be moved the way
     parking does it (TIF_NOTIFY_SIGNAL ends the sleep, the call
     restarts on the way out, where the task may move), at the price of
     a spurious restart (EINTR for the calls that do not restart);
     not done. `sched_exec()` asks the stopper to move an exec'ing task,
     which is held there, so exec does not balance (fork does); it could
     record the CPU and move at the exit of `execve()`.
   - Devices: kwblk, kwfb, kwinput, kwsnd and kwshm refuse to start on
     SMP. kwblk needs `queue_rq` from any CPU funneled to CPU 0 (a queue
     and a work item, as kwnet does) and completions back; the display,
     input and sound paths likewise.
   - Parking and snapshots: off (`KW_PARK` depends on `!SMP`; kernel.md,
     Parking lists what they would need).
   - The JIT: off with more than one CPU (per-CPU tables, atomic AMOs in
     compiled code, cross-hart code tracking).
   - Browsers: not tried. They need cross-origin isolation, a worker for
     CPU 0 (the CLI implies `--worker`), a web `Platform.spawnCpu`, and
     `Atomics.waitAsync` for CPU 0's idle (check each engine; a message
     from the sender's host would do instead).
   - `pnpm build` does not bundle `js/node/cpu-entry.ts` yet (source
     checkouts only), and `kernel/build.sh` has no SMP target.
9. **Listening-port detection** for the preview chip and CLI
   auto-forward: a `kwtty ports` subcommand in C that re-reads
   `/proc/net/tcp` every 3 s (a stdin byte rescans at once) and prints
   changes, spawned only while someone subscribes. Each check wakes the
   kernel for about 1.3 ms of host CPU (2026-11-15); no listen event
   exists without a kernel patch.
10. **Snapshots** (save and restore the machine). Parking and snapshots
    with the console, disks, display, input, sound, shm, vsock and network
    are in (kernel.md, Parking; js.md; data-disk.md): the SDK's
    `snapshot({ stop })` and `restore` (inline and in worker mode), the
    CLI's `{save=FILE}`, `{suspend=FILE}` and `--restore`, and the page's
    Suspend and resume offer (web.md). A snapshot stays restorable only
    while its disks are unchanged; vsock sessions and guest TCP
    connections do not survive a restore (the guest's ends are reset), but
    host file systems do, with their open files (inline only; worker-mode
    snapshots refuse while anything is mounted). Next, roughly in order:
    - **Rewind and fork**: restore one snapshot again after the disk moved
      on, or several times. Needs the disk state frozen at the seal, e.g.
      the CowDisk overlay frozen as a read-only layer under a new one.
    - **Mounts in worker-mode snapshots**: the owner's 9p state would have
      to be saved at the worker's snapshot point.
    - **Fewer EBUSY refusals**: a job-control-stopped task (^Z) never
      parks, because `arch_do_signal_or_restart` keeps the restart state
      in locals (moving `retval`, `restart_addr` and `continue_addr` into
      `pt_regs` would make it re-enterable); ptrace stops and FUSE waits
      (the daemon is parked first) stay EBUSY; a kthread created but never
      woken blocks a snapshot. The SDK error names the blocker; the page
      shows it as a failed Suspend.
    - **Page**: a browser test for Suspend and Resume (checked by hand
      only); saving by itself when the tab goes away (web.md, Suspend and
      resume says why not); resuming in place instead of the reload that
      Resume does.
    - **Size**: dropping clean page cache before the seal pays off only
      with a root on a disk (the default root is tmpfs: no gain measured,
      2026-11-15).
    - **SMP**: parking assumes UP in the places listed in kernel.md,
      Parking (the idle check, unpark while the old stack may still run
      on another CPU, the idle restart under TINY_RCU, the per-CPU page
      lists drained before the free-page walk).
    Known costs: parking makes epoll_wait and socket-timeout waits return
    EINTR once per snapshot; every new kernel thread needs a park point
    (AGENTS.md).

## Host file systems: follow-ups

- The patch `9p: add metatimeout` is not upstream. It refuses
  write-back cache modes (EINVAL; kernel.md, 9p); making it work with
  them would need a flush of dirty pages before each refresh.
- An adapter from mountx drivers (MIT) to the `Fs` handler interface is a
  possible follow-up.
- The page does not expose mounts.
- `vm.mount()` runs one kwtty session per mount; createKernel's mounts
  could share one.
- nodeFs is not safe against the host swapping a directory for a symlink
  between the guest's walk and its next request (no openat2
  RESOLVE_BENEATH in Node).

## Open issues

- **GNU ld binaries exec slower.** Alpine links everything with GNU ld,
  whose one R+X segment for code and read-only data costs about 0.5 ms
  per exec under kwemu against lld's layout (guest-packages.md). The cause
  on the kwemu or kernel side is not known. Fixing it there would speed
  up every Alpine binary.
- **node's shared libraries** (brotli, zstd, simdutf, simdjson, c-ares,
  nghttp2) are Alpine's builds; only openssl and zlib are rebuilt. V8 can
  emit Zba/Zbb with `--riscv-b-extension` (kwemu.md: -6.5% on an integer
  JS benchmark), but it is off by default and `NODE_OPTIONS` does not
  accept it. `npx --version` did not change with the rebuilt packages
  (about 4.1 s, 2026-11-16): it is V8 in the node binary.
- **No seccomp**: `arch/wasm` has no seccomp filter support, so `bwrap
  --seccomp FD` fails, and GTK programs that load images through glycin
  abort. Workaround in the image: `/usr/local/bin/bwrap`
  (`kernel/guest/bwrap-shim.sh`) drops the seccomp arguments. The fix is
  seccomp in the arch (a syscall entry hook and the `asm/syscall.h`
  helpers); remove the shim then.
- **One long syscall delays the host.** Every syscall and page fault
  costs 1000 instructions of the 200k slice, so kernel-bound
  loops end slices, but a single syscall that stays in the kernel for long
  holds off host events, the timer and the 20 ms yield until it returns.
- **Safari on plain http has no JIT** (web.md). The page does not warn.
- **JavaScriptCore and freed JIT modules**: not confirmed on a phone, and
  about 50 MiB of growth per long WebKit session is unexplained (kwemu.md,
  Collecting freed modules).
- **iPhone network**: an old report (`ping` "Network unreachable", a
  `wget` segfault) was never reproduced with the current page.
- The browser keeps every range-fetched root-disk chunk in memory, and data
  disk export and import hold the whole image in memory.
- The syscall comparison in README.md (How fast?) has no committed script.
  It was measured 2026-11-14 under Node with a static riscv64 C benchmark
  as `/init` of a cpio, against native x86, `qemu-riscv64` and
  `qemu-system-riscv64 -M virt` with Alpine's linux-lts.
- Kernel limits are in kernel.md (riscv64 user ABI), the data-disk and
  overlay limits in data-disk.md.
