# Status: roadmap and open issues

Remove items when they are done.

## Not in the image

`kernel/guest/fbdoom` and `fbdoom-patches/`: fbDOOM built in the guest
with tcc, on `/dev/fb0` with evdev input and `/dev/dsp` sound. The page's
launcher reaches it: its Doom demo writes the script and the patches into
the guest (Vite `?raw`), which builds it there. On the aarch64 guest
(Alpine's tcc 0.9.27_git20250619 for aarch64; Node SDK, direct network,
fresh data disk, 2026-11-18) the first run took 22 s to the game's first
frame, the 81 files compiling in 6 s; a later run starts in 0.2 s.

The FreeDOS launcher demo (`web/src/demos/dos.ts`, hidden) boots the FreeDOS
1.2 boot floppy in Alpine's qemu-system-i386 with the curses display. It
worked on the riscv64 guest but was too slow for the launcher: as shipped,
the floppy took about 70 s from qemu's start to the prompt (CLI,
2026-11-15). A stripped FDCONFIG.SYS and AUTOEXEC.BAT, and resuming from a
qemu state saved at the prompt (in the demo now), did not make it fast
enough on the page. qemu's TCG keeps writing new code, which kwemu
interprets or recompiles. Alpine has qemu-system-i386 and qemu-ui-curses
for aarch64 (11.0.3); the demo has not been run on the aarch64 guest.

WASI programs on the host's engine (prototype, branch `wasi-binfmt`;
js.md, WASI programs): `kernel/guest/kwwasi.c` is a binfmt_misc
interpreter for `\0asm\1\0\0\0` that sends argv, environment, the preopen
and the module's identity over vsock port 1021 (the module only when the
host has not compiled it for that identity) and then does the program's
file I/O in the guest as that process. `serveWasiPrograms(vm.vsock)` (CLI
`--wasi`) compiles each module once (js.md, Modules) and runs each program in a
worker of its own, started by the owner of `vm.vsock`; its WASI file calls
round-trip to the owner, which talks to kwwasi: through a SharedArrayBuffer
per program (the worker blocks in `Atomics.wait`, the owner wakes on
`Atomics.waitAsync`) where one can be used (Node, isolated pages), else as
messages to and from JSPI Suspending imports. A kill of kwwasi
(Ctrl-C, SIGKILL, SIGPIPE) or the machine's end terminates the worker at
once, mid computation too; a worker whose program ended by itself is kept
idle for the next one (two at most). Programs are left out of snapshots:
they do not block one, and after a restore kwwasi exits 126 ("lost the
connection to the host"), also while it waits for stdin. alpine.sh builds
kwwasi and kw-binfmt.sh registers it, but no image with them has been
built yet; `node test/wasi-binfmt.ts [--worker] [--messages]` brings
kwwasi in through a mount and registers it by hand. It passes inline, in
a worker and with `UNKERNEL_TEST_CPUS=2`, on the shared path and with
`--messages` (2026-11-19, aarch64; the snapshot part with one CPU only, since an
SMP kernel has no KW_PARK), and the built CLI (`pnpm build`,
`dist/cli.mjs --wasi`, inline and `--smp 2`) ran programs on the shared
path (a Ctrl-C through it was tried on the message path only). Preview 0
modules (`wasi_unstable`) run adapted (js.md): wasienv's Lua 5.4 shell
(`@antonz/lua-wasi`) runs scripts, file I/O with seeks, stdin and its
REPL; its SQLite 3.44.2 shell (`@antonz/sqlite-wasi`) runs SQL given as
arguments, but SQL on stdin does nothing, also under Node's own
`node:wasi`: it is built with SQLITE_SHELL_FIDDLE, whose shell never reads
stdin (2026-11-18).
Measured 2026-11-18 (Node 24.22, V8 13.6, 16 cores) with the riscv64
guest of that day, where not said otherwise; not measured again on
aarch64, apart from the test's own figures (2026-11-19, inline: 1e9
rounds 6.5 s cold and 1.8 s cached as wasm, 3.5 s as aarch64 in the
guest; 52 µs per 16-byte pread; a 16 MiB copy 0.09 s):
- A `sleep 0.5` beside a computing program takes 0.50 s and a console
  write 3 ms, as with nothing beside them, in every mode. A killed
  program's worker has exited within 3 ms of the guest seeing kwwasi
  exit. Two 3e8-round loops at a time take 0.58 s, one alone 0.53 s.
- 1e9 rounds of an xorshift loop: 6.5 s as wasm on its first run, 1.8 s
  on later runs (a new worker each time; the posted module shares the
  tiered-up code), 2.9 s as riscv64 in that guest. The first run is
  Liftoff code all along: `_start` is called once and V8 13.6 has no
  on-stack replacement for wasm (no flag for it), so the TurboFan code
  that dynamic tiering makes serves only later calls. Outside the guest,
  3e8 rounds take 1.95 s on the first call and 0.53 s on the second, and
  0.58 s on the first with `--no-liftoff`; workers and JSPI make no
  difference. A process-wide `--no-liftoff` would also slow the kernel's
  own compile, and there is no per-module choice in the JS API.
- A hello world starts in 4.9 ms (median, exec() to exit; message path,
  and 20 of them take 0.06-0.07 s on either path) with an idle worker,
  against 4.4 ms with the program on the vsock thread; with a new
  worker each it takes about 41 ms from source (a bare Node worker starts
  in about 20 ms).
- One small request, after kwwasi's one recv() and one send() per frame
  and the host's single copies (2026-11-18, evening; 3000 one-byte writes,
  one-byte reads, 16-byte preads, stats or fstats per run, timed by the
  program; medians of 6 runs, before and after alternating in one boot,
  host load 1.6-2.8): on the shared path 37-55 µs inline (before 45-60),
  86-101 µs in worker mode (97-117) and 95-129 µs with 2 CPUs (112-191,
  noisier), on the message path inline 85-105 µs (88-122). Writes to
  /dev/null and regular files and reads of /dev/zero and regular files
  gained most (9-12 µs inline): no fcntl() and poll() before them any
  more. The program's thread to kwwasi and back stays most of it: kwwasi's
  syscall itself is 1.3-2.4 µs, a native program in the guest makes the same one
  in 0.5-1.1 µs. Earlier (2026-11-18, before these changes, timestamped on
  the message path): a small request inline was 21-32 µs worker to owner,
  39-57 µs vsock and kwwasi, 21-32 µs back. Without the 200 µs spin the
  shared path took 68-74 µs inline (Atomics.wait's wakeup); spins of 50,
  100 and 200 µs did about equally well inline, worker mode needed 200.
- Throughput through kwwasi (same runs; 32 MiB in 64 KiB or 1 MiB reads
  and writes of a tmpfs file): shared path inline 470/753 MB/s reading
  (64 KiB/1 MiB; before 322/564) and 454/740 MB/s writing (before
  302/627); worker mode 400/759 and 393/695 (before 320/649 and 273/573);
  2 CPUs 335/579 and 341/425 (before 278/485 and 231/424); message path
  inline 388/891 and 359/818 (before 312/737 and 282/654). A scratch
  kwwasi that copied payloads to coalesce its sends made 64 KiB requests
  2x slower (measured earlier that day): copies under emulation cost more
  than the syscalls they save.
- Start to exit (`fork`+`exec`+`wait` in the guest, same runs): nop.wasm
  920-960 µs median (min about 650) inline and in worker mode, hello.wasm
  1.5-1.7 ms, unchanged by these changes. The shared path does not start
  slower than the message path: alternated in one boot, nop.wasm took
  970-1146 µs against 877-1217 µs inline (2026-11-18); an earlier gap
  (598 against 1055 µs) compared different boots. The floor is mostly the
  guest's process start and exit, the vsock connect (160-215 µs, measured
  earlier that day) and the "start" and "exit" messages between the owner
  and the program's worker (a growable SharedArrayBuffer costs 3 µs to
  make).
- Module identity (2026-11-18, inline, modules on a 9p mount, start to
  exit through the guest shell): a hello world with a 100 MiB custom
  section took 0.71 s on its first run and 0.31-0.34 s on later ones when
  every run sent it, against 0.63 s and 0.01 s now; four started at once,
  1.46 s cold and 1.07 s warm before (guest MemAvailable fell from 490 to
  75 MiB during them: kwwasi held each module whole), 0.80 s cold (one
  sent) and 0.09 s warm now (MemAvailable 486 MiB throughout). CPython
  3.15.2 (32 MiB) `-c pass`: 0.31 s first, 0.14-0.15 s later, before; 0.37
  s and 0.06-0.07 s now. A copy made less than 2 s before it runs is sent
  each time (0.14-0.16 s).
- Bare round trips between a Node worker and its main thread (2026-11-18):
  messages both ways 37 µs (55 µs with 64 KiB), a message there and the
  reply in a SharedArrayBuffer with Atomics.wait 25 µs, both ways through
  one with Atomics.waitAsync on the main thread 19 µs (39 µs with 64 KiB).
  A thread asleep in Atomics.wait takes tens of µs to wake; spinning
  avoids that.
Open:
- Browsers: `js/web/wasi.ts` and its entry are written and the build
  inlines them, but no browser has run them.
- The shared path's spin keeps the program's thread busy up to 200 µs per
  request it waits on; not measured on a phone or a host with few cores.
- A busy guest stalls every request (2026-11-18): one write beside a
  native busy loop (`rvbench spin`) took 35.7 ms inline and 20.1 ms in
  worker mode, against 37-87 µs alone, the same before and after the
  changes above; with 2 CPUs 0.1-0.13 ms (the loop on the other CPU), 20
  ms in an occasional run. The host's packets
  reach a busy kernel only when its thread runs the event loop: inline the
  owner is the kernel's thread, so the program's request (a waitAsync
  task or a message) waits for the kernel to suspend; in worker mode the
  owner's packets go to the kernel's worker as messages, handled only
  while it is suspended, and the guest's packets leave from a microtask
  (worker-serve.ts) unless 64 KiB wait. A busy kernel suspends every 20 ms
  (kernel.md, IRQs and time). Nothing in kwwasi or the WASI host can reach
  it, and no existing wake or flush is per connection. A fix is generic:
  in worker mode, vsock packets through the shared transport's rings
  (worker-shared.ts, worker-serve.ts, worker-host.ts), drained by
  `Kernel.poller` at each slice end as console input and evdev are, and
  the guest's packets out from the import into a ring the owner waits on;
  inline, a synchronous path from a program's channel to the guest and
  back inside the kernel's slice-end clock import (the web streams resolve
  in microtasks, which do not run inside an import): a synchronous
  connection API in vsock.ts and a poller hook beside the console ring's.
  Either changes how every vsock connection's packets cross (9p mounts,
  kwtty and exec(), connect() and --forward, snapshots' "packets in
  flight"), so it is not done here.
- Worker mode and SMP add 45-50 µs to each small request against inline
  (above): the request packet goes to the kernel's worker as a message,
  the reply comes back as one, and an idle kernel worker is woken by a
  "kick" message. The same shared-ring transport would remove the
  messages; it is generic, as above.
- A snapshot taken while a program streams data can still be refused
  ("vsock packets in flight"), as for any vsock traffic (not tried).
- wasi-libc's cwd is always "/" (`getcwd()`), so relative and absolute
  paths reach kwwasi alike and it guesses by what exists (js.md, Paths and
  the cwd; `KWWASI_CWD` overrides); the preopen replaces an inherited
  descriptor 3. poll_oneoff's fd events come from a guest poll(); no
  sockets, no `proc_raise`, no signals to the program.

## Roadmap

1. **JIT**: bigger regions (most remaining exits leave full ones), exits
   into self-loop modules, cold code, `run`'s entry path and region
   prologues, NZCV materialisation. Details in a64/performance.md (Next levers)
   and kwemu.md (Next steps). The op arena keeps countdowns and compiled
   code across resets (kwemu.md, Interpreter machinery; a64/tier.md,
   The op arena).
2. **A64 features**: ARMv8.0-A with AES, PMULL, SHA1, SHA2, CRC32, LSE,
   SHA512 and SHA3 is in (a64/isa.md, What is implemented). Not implemented: SVE/SME, SM3
   and SM4, FP16 arithmetic, RNDR, later-architecture encodings (the
   coverage tool lists what corpora use). The interpreter's AES is
   bitsliced; compiled AES reads data-indexed tables, so it is not
   constant-time on the host.
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
6. **Ubuntu**: Ubuntu Base 26.10 arm64 boots from a disk (`kernel/build.sh
   ubuntu`, kernel/guest.md), apt works, and systemd boots to
   multi-user.target once installed from apt; the page's Ubuntu demo runs
   the same tarball in a chroot on Alpine. Next: network under systemd
   (systemd-networkd or a kw-net unit), a prebuilt systemd image, BPF,
   keys, IPv6 and cgroup controllers if a service needs them (costs in
   kernel/config.md), the ENOSYS and illegal-instruction logging run on 26.10,
   and kw-init's poweroff after an apt run that replaced a file its bash
   maps (the read-only remount fails as busy). 26.10 is an interim
   release (support ends mid-2027): pin the next one, or 26.04.x LTS,
   before then.
7. **Stack switching.** The wasm stack-switching proposal is at Phase 3,
   behind a flag in V8 and missing from WebKit (Node 26:
   `--experimental-wasm-wasmfx`). With a module-defined memory and stub
   (or `fd_pread`-backed) kwblk/kwnet imports, that is what a standalone
   WASI runtime still needs. The generic services already use WASI
   preview 1.
8. **SMP** (experimental; kernel/smp.md; js.md, CPU threads; web.md,
   Several CPUs). The SMP kernel is a second build of the same tree, one
   kernel instance per CPU thread on a shared memory (so cross-origin
   isolation and a secure context in browsers), with per-CPU kwemu state
   and JIT tables, wasm atomics for the guest's exclusives and LSE
   atomics, and TLB shootdowns through the polled IRQ bits; release
   bundles carry the patch to it. JSPI-suspended stacks cannot move
   between threads, so a task moves only where its stack can be dropped
   and it can start on a fresh one (step 3); parking assumes UP in the
   places listed in kernel/parking.md. The steps that built it follow
   with their measurements, taken on the riscv64 guest the project had
   then (2026-11-16 and 17); what is open comes after them.
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
   Step 2, an SMP kernel in Node (2026-11-16; kernel/smp.md; js.md, CPU
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
   Step 3, moving tasks (2026-11-16; kernel/smp.md): a user task may
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
   TLB flushes and clocks (2026-11-16; kernel/smp.md, MM and Costs):
   a flush no longer waits for a CPU in lazy TLB mode (it flushes when
   it uses the mm again), a PTE that only gained access is flushed on
   this CPU alone, the teardown of a whole mm clears PTEs without
   atomics, and a secondary's host keeps one view of the memory. kwfork
   (11 alternating rounds, medians, interpreter only), before and
   after: with the process moved to CPU 1 and CPU 0 idle, an anonymous
   fault 3,321 to 536 ns, `fork()` 42.5 to 23.4 µs, fork+exit+wait 118
   to 80 µs, `clock_gettime` 500 to 358 ns; exit 4.3 ns less per mapped
   page everywhere (8 MiB fork+exit+wait 173 to 163 µs on one CPU, 211
   to 202 on two); every other one- and two-CPU number moved by less
   than 3%, within the rounds' spread. kwtlb (threads that move between
   CPUs and check every access against a mutator that mprotects,
   munmaps, mremaps, replaces a memfd mapping and forks, plus a phase
   where one thread fills CPU a's TLB, moves away so a idles, changes
   the mapping and comes back or wakes a sibling asleep on a) ran 4
   minutes on 2 and 4 CPUs beside kwstorm with no error; with the flush
   on return from lazy mode removed it reports stale reads and writes
   within seconds. The scratch tools are in `vendor/smp-deferred/tools`.
   Step 4, the JIT on SMP (2026-11-16; kwemu.md, JIT on several CPUs):
   each CPU's kwemu compiles into its own instance's table through a
   JIT host of its own in that CPU's thread, so the JIT now runs with
   any number of CPUs (it was off because only CPU 0's host had one).
   Every CPU now yields to its host every 20 ms of user code, without
   which V8 never finished collecting freed modules on a secondary (the
   JIT host nudged with up to 4 GiB allocations, a shootdown once waited
   0.58 s, and compiles would have been refused after 2048 frees);
   compiled code reads the interrupt word atomically; an interpreted
   self-loop that an interrupt ends counts towards the compile
   threshold (under a stream of IPIs hot loops never compiled). kwtest
   with the JIT passes on 2 CPUs (20 of 20) and 4 (10 of 10), with its
   new `jit:` checks (compiled loops on every CPU under signals, stores
   beside atomics, moves, code changed by another CPU), and so do the
   4-minute kwstorm + kwmmstress and kwstorm + kwtlb runs on 2 and 4
   CPUs. Parallel compiled loops scale 1.99x on 2 CPUs and 3.93x on 4,
   gzip/bzip2/awk jobs 1.94x and 3.81x; compiled code runs as fast as
   on the UP build (kwemu.md, Numbers). Shootdown answers from a CPU in
   compiled code take 1.8 µs at the median.
   Step 5, the host devices on SMP (2026-11-16; kernel/smp.md,
   Devices): kwblk, kwshm, kwfb, kwinput and kwsnd now work on SMP; every
   device import still runs on CPU 0. kwblk hands another CPU's requests
   to CPU 0 through a list and IRQ 3; the others call their imports
   through `kw_host_call()` (a work item on CPU 0 while the caller
   sleeps), and kwsnd's timer is pinned to CPU 0. The UP build is the same
   binary but for one `WARN_ON_ONCE` line number in kwblk. Checked on 2
   and 4 CPUs with the JIT (and without): kwtest with `--display --shm`
   (also pinned to CPU 1, so its kwfb and kwshm checks call from there),
   glimmer-check (also with glimmer pinned to CPU 1 and 3), the api tests
   (`UNKERNEL_TEST_CPUS`), an ext4 root disk, the data disk with the
   overlay root across a reboot, a read-only disk beside two writable
   ones, and 200 s of verified parallel I/O from threads that move
   between CPUs (O_DIRECT and buffered, fsync, dropped caches) beside
   parallel dd/sha256sum jobs, fsync loops and kwstorm; `e2fsck -fn`
   clean afterwards. Cost (rough, on a host loaded by other work,
   2026-11-16): a synchronous 4 KiB O_DIRECT read or write took about 30
   to 40 µs from CPU 0 (as on UP) and 80 to 90 µs from CPU 1 (two
   cross-thread wakeups); reading 2000 small files cold took 2.3x as
   long from CPU 1, a 256 MiB sequential read 0.7x the rate; a 256 MiB
   buffered write with fsync ran 2-5x slower from CPU 1 while dirty
   throttling was on (balance_dirty_pages waits on each round of
   writeback) and as fast as CPU 0 with it off. The SMP build on one CPU
   read and wrote sequentially at UP's rates and created small files
   about 25% slower (its general cost, step 2).
   Step 6, waits under host load (2026-11-16; kernel/smp.md, Waiting
   for another CPU; study in `vendor/smp-deferred/load/README.md`): a
   CPU that waits for another (a spinlock, a cross-CPU call's answer,
   `smp_cond_load_*()`) spins 20 µs and then blocks its thread until an
   unlock or `csd_unlock()` kicks it, an IPI arrives or 100 µs pass, and
   a long spin takes its expired timer. Before, on a busy host, a CPU
   spinning for another whose thread the host had descheduled looked
   busy itself and was descheduled more, also while holding locks.
   Beside 24 spinning host processes in the same session (16-thread
   host; lowered kernels, JIT; 3 interleaved runs each, medians) against
   the same kernel without the change: kwtest's move ping-pong 543 to
   495 ms on 2 CPUs and 10.0 s (0.66-18.7) to 0.58 s on 4; a cross-CPU
   pipe ping-pong of 2000 round trips 5.8 to 0.28 s (2 CPUs) and 4.0 to
   0.30 s (4); 500 fork+exit+wait 3.1 to 0.17 s and 1.2 to 0.17 s;
   200k `close(dup(0))` from N threads (a contended kernel spinlock) 0.23
   to 0.13 s and 8.1 to 0.17 s; a CPU-bound loop that measures the
   guest's share of the host 0.59-0.68 s before and 0.91-0.94 after,
   now that the waiting threads give the host back its time. On an idle
   host (10 rounds): move ping-pong 192 to 198 ms on 2 CPUs and 268 to
   265 on 4, fork+exit+wait of an 8 MiB process 202 µs either way, and
   compiled loops scale 1.99x/1.98x on 2 CPUs and 3.91x/3.92x on 4.
   kwtest (1, 2 and 4 CPUs with the JIT, 2 without), 2 minutes of
   kwstorm with kwmmstress and with kwtlb on 2 and 4 CPUs, the block
   scenario of step 5, glimmer-check and the api tests on 2 CPUs pass;
   the UP build is the same binary.
   Step 7, spinlocks taken out of turn (2026-11-17; kernel/smp.md,
   Waiting for another CPU; evaluation in
   `vendor/smp-deferred/load/README.md`, Patch 2 on realistic
   workloads): with `kw_spin_unfair=1`, the default, a CPU takes a
   spinlock only while no ticket is outstanding instead of queueing
   behind waiters whose host threads may be descheduled. On realistic
   guest workloads (gcc, configure, file systems, node, Python, apk; 2-8
   CPUs, idle to 2x oversubscribed host) fair and unfair locks measured
   the same (geomean of the ratios 0.97-1.02). Beside 24 spinning host
   processes at 8 CPUs (lowered kernels, JIT; 4 interleaved boots each,
   medians; host 7-16% busy before the spinners started) against step 6:
   kwload's `kspin` (8 threads on one kernel spinlock) 14.7 s
   (7.6-20.9) to 0.097 s, the whole kwload run 40 to 23 s, pipe
   ping-pong p99 3.2 to 1.0 ms; `pp`, `ppx`, `fork`, `mutex`, `par` and
   `shoot` the same within noise. On an idle host (7 rounds, random
   order, against step 6): move ping-pong 198 to 203 ms on 2 CPUs and
   273 either way on 4, fork+exit+wait of an 8 MiB process 209 to 203
   µs (2 CPUs) and 209 to 208 (4), compiled loops scale 2.00x/2.00x on
   2 CPUs and 3.90x/3.92x on 4. Its idle-host cost is under heavy
   contention only: `kspin` at 8 CPUs 0.073 to 0.102 s (1.4x; 5 boots,
   0.077 s with `kw_spin_unfair=0`), and in the evaluation kernel
   `dup()` from 8 threads 0.69x the throughput, p99 no worse.
   kwtest (1, 2 and 4 CPUs with the JIT, 2 without, 4 with
   `kw_spin_unfair=0`), 2 minutes of kwstorm with kwmmstress and with
   kwtlb on 4 and 8 CPUs idle and beside 24 spinners, the same at 8
   CPUs with the parameter flipped every 50 ms, the block scenario of
   step 5, glimmer-check and the api tests on 2 CPUs pass; the UP build
   is the same binary.
   Console order (2026-11-17; js.md, CPU threads): console output from
   different CPUs used to reach the host in arrival order, since CPU 0's
   host takes another CPU's messages only when CPU 0 suspends, while
   its own writes go out at once. Every write now gets its place inside
   `fd_write` (so in the order the kernel's locks gave the calls): first
   a number that CPU 0's host wrote by, now a record in the console ring
   (Console speed, below); the kernel is unchanged. A reproducer
   (lines printed in turn by tasks pinned to every CPU, through the tty
   and through `/dev/kmsg`, and 64 KiB writes on CPU 1 racing short
   lines; 3 runs at 2, 4 and 8 CPUs) had 0-62 of 400 tty lines and
   6-108 of 400 printk lines out of place and 1-169 short lines inside
   a long write before, none in any run after (also with
   `--worker=messages`); the console's kernel lines after sysrq `t`,
   `l` and `m` from CPUs 1-3 against the guest's `dmesg`: 113 and 199
   of about 450 out of place before, 0 after. The api tests on 4 CPUs
   failed in 3 of 3 runs before and passed 7 of 7 after; a new api test
   checks the order. Echo latency and output speed did not move (3
   alternating rounds, Node, 2 CPUs; before, then after): median echo
   0.43-0.46 and 0.45-0.54 ms in worker mode, 0.28-0.29 and 0.28-0.33
   ms inline (UP 0.17-0.18 and 0.16-0.18); `seq 1 20000` on CPU 0
   0.36-0.39 and 0.36-0.46 s in worker mode, on CPU 1 6.2-6.3 s either
   way (most of that was the measuring script, see below).
   Console speed (2026-11-17; js.md, CPU threads): the 6 s of `seq 1
   20000` on CPU 1 were mostly the measuring script, which flattened a
   growing string once per chunk; CPU 1's output reached the owner as
   one chunk per write (two per line), CPU 0's in a few batched
   chunks. The guest itself wrote 40000 lines on CPU 1 in 0.62 s
   against 0.35 s on CPU 0 (a `postMessage` per write). What was real:
   400k messages per `seq 1 200000` for the owner (the page took 38 s
   for it in headless Chromium), output from CPU 1 held until CPU 0's
   next suspension (10 ms at the median while CPU 0 runs user code), and
   a queue only CPU 0's suspensions drained. Every CPU's console output
   now goes into one shared ring (`console-ring.ts`), read by the owner
   with the shared transport and by CPU 0's host otherwise; the kernel
   is unchanged. Node, 2 CPUs (4 alike), before, then after, host load
   1-3.3 from another agent's builds, one run each, with a consumer of
   constant per-chunk cost: `seq 1 200000` on CPU 1 with CPU 0 idle
   4.06 and 2.41 s shared, 4.16 and 2.45 s messages, 4.48 and 2.57 s
   inline, against CPU 0's 2.36-2.47 s in worker mode (3.55-3.57 s
   inline, where every write of CPU 0's is a chunk, as before and as on
   UP); with CPU 0 spinning in user code or in a 1-byte `dd`, 3.4-3.7
   and 2.4-2.6 s. CPU 1's output after it was written, CPU 0 spinning,
   median: 10.8-12.1 and 0.05 ms shared, 10.6-11.8 and 0.09-0.23 ms
   messages, 10.0-10.2 and 0.05-0.21 ms inline. Echo of a shell on CPU 1
   with CPU 0 spinning: 10.0-10.4 and 0.22-0.44 ms shared, 30.1-30.7 and
   10.1-10.4 ms messages (the input still waits for CPU 0's suspension
   there), 20.1-20.3 and 0.19-0.50 ms inline. UP unchanged (`seq 1
   200000` 3.16 and 3.11 s worker, 3.49 and 3.28 s inline). 27 MB from
   CPU 1 with CPU 0 spinning: RSS rose by 26-40 MiB before and 22-27
   MiB after. The order reproducer (3 runs at 2, 4 and 8 CPUs, shared,
   messages and inline), the sysrq dmesg check and a panic on CPU 1 with
   CPU 0 spinning (exit 253, panic line out) pass; a stress of the
   ring's full paths with worker threads (4 KiB and 16 KiB rings, a
   reader busy 30 of every 40 ms) lost and reordered nothing, and a
   reader stuck for 0.6 s made "post" writers drop rather than wait.
   Uaccess races (2026-11-17, after step 7; kernel.md, Memory model, and
   kernel/smp.md, MM): a system call could fail with EFAULT on a valid address
   (kwmmstress's `getcpu()` once). `kw_user_addr()` gave up after three
   faults, and other threads of the mm can take the page away again
   between a fault that succeeded and the next walk: `MADV_DONTNEED` zaps
   under the mmap read lock, beside the fault, and under host load a
   fork's COW write-protect lands there while the faulting CPU's host
   thread is descheduled (a temporary counter showed the PTE empty, or
   the same page write-protected again, after every such fault). The walk
   now goes on for as long as the fault succeeds (up to 17 rounds in a
   row seen beside host load; 10000 rounds end it with a warning). Two
   more bugs turned up: a kernel access whose fault returned
   `VM_FAULT_RETRY` failed whenever any signal was pending
   (`fault_signal_pending()` with no regs read `user_mode()` at address
   0), and the futex ops on user words were a plain read and write, so
   `FUTEX_WAKE_OP`'s add beside an amoadd on another CPU lost up to 6% of
   the increments (robust futex death and the PI paths could drop
   `FUTEX_WAITERS`). A scratch reproducer (`kwuarace`: one writer thread
   per CPU in `clock_gettime`, `getcpu`, `read` and `uname` into four
   pages and `getcpu` on its stack, while siblings zap the pages, fork,
   mprotect them RW and RWX, and the main thread re-pins the writers; 120
   s per run, lowered kernels, JIT): before, 60 EFAULTs in 5 of 6 runs
   (idle 5, 1 and 0 at 2, 4 and 8 CPUs in 0.3, 0.5 and 0.9 billion calls;
   beside 24 host spinners 32, 21 and 1), and lost adds in most of its
   3-second `FUTEX_WAKE_OP` rounds; after, none in 2.1 billion calls and
   no lost add. kwtest's new `uaccess:` checks fail on the old UP and SMP
   kernels and pass now. Cost (39 alternating boots per kernel,
   interpreter only): `getppid`, `clock_gettime`, 64-byte and 4 KiB pipe
   round trips, `uname`, anonymous and COW faults within ±3% on UP, on
   SMP with one CPU and with two, inside their run-to-run spread; the
   walk's code is the same apart from the slow path. kwtest (UP with and
   without the JIT; SMP on 1, 2 and 4 CPUs with the JIT, 2 without), 2
   minutes of kwstorm with kwmmstress and with kwtlb on 4 CPUs, and the
   api tests on 2 CPUs pass. The UP build changes in `kw_user_addr()`,
   `kw_handle_fault()` and the futex callers. The kernel changes are
   folded into the arch patch and `wasm: SMP`.
   Placement (2026-11-17; kernel/smp.md, Placement): what holding a
   task on its CPU while it is in the kernel cost, measured with a
   scratch suite (`kwmig`: CPU-bound children by fork, fork+exec,
   vfork+exec, shell `&` and `xargs -P`; pipelines; a thread pool fed
   in bursts; kernel-heavy processes; a sleeper woken behind a busy
   task; fork+exec loops; lowered kernels, JIT, 2 and 4 CPUs, 3
   interleaved rounds, host load 3.7-13.5 from other work) and a
   SCHEDSTATS build. Most of it did not matter: children of every
   launcher finished within 0-8% of the ideal (their CPU time spread
   evenly), fork-only and fork+exec alike, since fork already places
   them; pipelines 5-15% over theirs, the pool at its ideal wall time,
   also when every task started asleep on CPU 0; kernel-heavy processes
   (16 and 64 MiB `MAP_POPULATE` and `munmap` rounds, preempted in
   `cond_resched()`) started on CPU 0 spread to one per CPU anyway,
   because they pass through user mode often enough. What did matter: a
   sleeper held on a CPU it shares with a busy task, while another CPU
   idles, stayed there for good, and the busy task lost the sleeper's
   share (500 µs every 2 ms: the busy task got 80% of its CPU on 2
   CPUs; the idle CPU stayed idle). Wakeup preemption kept the wake-to-
   run latency low (median 10-35 µs), and the balancer could not help
   (30-50% of its attempts failed on held or cache-hot tasks; it never
   tried an active balance). And `sched_exec()` never moved anything:
   its choice used `cpus_ptr`, which a held task that has slept has
   narrowed to its CPU, and its stopper cannot move a held task anyway.
   Now the scheduler names a better CPU for a held task at exec and at
   a wakeup on its busy CPU, and the task moves there on its way to
   user mode if that CPU is idle then and its own is not; nothing is
   interrupted, so no call returns EINTR or restarts (a check of
   threads asleep in `read`, `nanosleep`, `poll`, `epoll_wait`,
   `futex`, `accept`, `recv` with `SO_RCVTIMEO` and `select` while
   being moved and beside busy movers: no EINTR, early or short
   return). Before and after (medians): the busy task's share beside
   that sleeper 80.5% to 99.7% on 2 CPUs and 93.1% to 99.7% on 4 (3
   busy tasks); the sleeper's wake-to-run p99 0.12 to 0.04 ms on 2
   CPUs (0.10 to 0.09 on 4); kwtest's
   new checks (a sleeper woken 60 times behind a busy thread pinned to
   CPU 0; 5 execs beside it) failed on the old kernel (0 of 60 wakeups
   and 0 of 5 images away from CPU 0) and pass (away from the 1st-7th
   wakeup on; 5 of 5). Unchanged within noise: the suite's other
   numbers, fork+exec+wait loops (1000-loop runs 189-238 µs before,
   180-259 after, 4 CPUs), move ping-pong (201-220 and 192-203 ms on 2
   CPUs, 267-339 and 277-313 on 4, 3 and 8 runs), fork+exit+wait of an
   8 MiB process (203-240 and 200-212 µs on 2 CPUs, 259-296 and 213-245
   on 4) and kwpar process scaling (1.89-2.13x and 1.93-2.02x on 2,
   3.65-3.75x and 3.86-4.03x on 4; host load about 4). The UP build
   differs only in `__LINE__` constants of WARNs after the inserted
   lines (`kernel/sched/core.c`, `include/linux/sched.h`).
   Open, roughly in order:
   - A task preempted in the kernel (`cond_resched()`) or asleep in a
     system call still stays on its CPU until it reaches user mode;
     only its later placement improved (above). A long system call
     beside another task on its CPU therefore shares that CPU while
     another idles, until it returns; nothing measured needed more.
     Ending interruptible sleeps to move the sleeper (as parking does)
     is not done: calls that do not restart would return EINTR at the
     scheduler's whim.
   - Device I/O is serialised on CPU 0 and pays two cross-thread wakeups
     per request from another CPU (step 5); adaptive idle polling
     (below) or completing on the submitting CPU would cut that.
   - Parking and snapshots: deferred (decided 2026-11-17). They stay
     UP only (`KW_PARK` depends on `!SMP`; kernel/parking.md lists what
     they would need), and the page hides Suspend with several CPUs.
   - Console ring (js.md, CPU threads), paths that never ran: the
     reader's 4 ms polling where the main thread has no
     `Atomics.waitAsync`, the drop path in a real guest (stress test
     only), CPU 0 stuck inside the kernel. A single write over 64 KiB
     is split into records that another CPU's write can land between.
   - No browser test in `web/test/` covers the CPUs option.
   - JIT on SMP, what is left: TLB flushes no longer wait for a CPU
     that compiles or yields to its host (kwemu.md, JIT on several
     CPUs, and Numbers, Compile stalls), but other IPIs do (`membarrier()`,
     other cross-CPU calls; a wakeup onto a compiling CPU starts after
     the compile), and so does a flush whose IPI was already on its way
     when the compile began; modules are not shared between CPUs, so a
     task that moves compiles its hot code again; exclusive pairs and
     CASP stay interpreter calls in compiled code (a64/jit.md, Atomics in
     compiled code).
   - Under host load (after steps 6 and 7): a synchronous TLB shootdown to a
     CPU running user code still waits until that CPU's host thread runs
     again (kwload's `shoot` 2-36 s at 4-8 CPUs beside 24 spinners);
     nothing in the guest can shorten it, so fewer guest CPUs than free
     host cores is the remedy (a CLI warning for `--smp` above
     `os.availableParallelism()` is not built). Spinlocks taken out of
     turn (step 7) have no starvation bound (a waiter that has waited,
     say, 1 ms could take a ticket; nothing measured needs it), and
     nothing switches `kw_spin_unfair=` by itself. Bare `cpu_relax()`
     loops (seqcount retries) do not take the timer.
   - Aligned `get_user()` and `put_user()` copy through `memcpy` (wasm
     `memory.copy`), which the wasm spec does not make single-copy
     atomic on a shared memory, unlike plain wasm loads and stores: a
     futex word read beside user stores on another CPU could tear.
     None seen (2026-11-17: 7.8 million `FUTEX_WAIT` reads of a word
     another CPU flips between 0 and ~0, 2 CPUs), and the futex paths
     retry on an unexpected value. Scalar `__get_user_fn` and
     `__put_user_fn` for aligned 1, 2, 4 and 8 bytes would make it so.
   - Browsers (2026-11-17; js.md, CPU threads; web.md, Several CPUs):
     `js/web/cpu.ts` starts each CPU as a Web Worker, nested in worker
     mode's kernel worker (CPU 0 must be able to block, so not on a
     page's main thread), and the page has a CPUs option (`?smp=N`, off
     by default) that loads the SMP bundle only then and falls back to
     one CPU. Run in headless Chromium (2 and 4 CPUs: boot, a terminal
     window, glimmer, the JIT on every CPU, parallel loops scaling) and
     by hand on a deployed build in desktop Chrome, Firefox and on iOS.
     Not tried: desktop Safari, Android, a hidden tab (worker
     throttling), long sessions. The page offers it when its release
     bundle carries the SMP patch, as releases do since 2026-11-17
     (testing.md, Release workflow, lists the SMP checks the workflow
     still lacks). Several CPUs on the aarch64 guest are checked in Node
     only (kwtest on 2 and 4 CPUs, abitest on 2, 2026-11-18), not on the
     page.
   - Deferred fork and wakeup changes, measured 2026-11-16 (kwfork,
     9 alternating rounds; patches and a README with their base in
     `vendor/smp-deferred/`, which is gitignored like all of vendor):
     - Cheaper barriers: `smp_load_acquire()` and `smp_store_release()`
       as wasm atomic loads and stores instead of a plain access and
       `atomic.fence`, and `smp_mb__{before,after}_atomic()` as compiler
       barriers. Fences per fork 558 to 230. Waits for a decision on
       supported hosts: the RMW half counts on V8 compiling an atomic
       RMW as a full barrier, which holds on x86-64 and on arm64 with
       LSE but not on arm64 without it; it also adds one clang warning
       (a misaligned atomic in `objpool.h`).
     - Adaptive idle polling (`kw_idle_poll_us=`, off by default): an
       idle CPU polls its pending word for up to that long, adapting as
       KVM's `halt_poll_ns` does, before its host thread sleeps. With
       200 on two CPUs fork+exit+wait 110.5 to 67.8 µs, of an 8 MiB
       process 194.7 to 156.6 µs; a fixed 100 µs poll slowed fork+exec
       loops instead. A policy choice: it burns host CPU (1-4 points of
       a host core for light guest activity, an idle guest about none)
       for wakeup latency, and on a busy host it makes things worse (a
       polling thread looks busy to the host; alone as bad as no step
       6, with it pipe ping-pong 1.5-3x slower). Rebased onto the load
       study's patch 1 as `load/load-3-idle-poll.patch`.
     - Rejected: `sched_fork_local=1` (a fork child starts on its
       parent's CPU) made two parallel fork+exec loops on two CPUs take
       0.65 s against 0.39; `smp_rmb()`/`smp_wmb()` as compiler barriers
       hold only on x86-64 hosts.
9. **Listening-port detection** for the preview chip and CLI
   auto-forward: a `kwtty ports` subcommand in C that re-reads
   `/proc/net/tcp` every 3 s (a stdin byte rescans at once) and prints
   changes, spawned only while someone subscribes. Each check wakes the
   kernel for about 1.3 ms of host CPU (2026-11-15); no listen event
   exists without a kernel patch.
10. **Snapshots** (save and restore the machine). Parking and snapshots
    with the console, disks, display, input, sound, shm, vsock and network
    are in (kernel/parking.md; js.md; data-disk.md): the SDK's
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
    - **SMP**: parking assumes UP in the places listed in
      kernel/parking.md, SMP (the idle check, unpark while the old stack may still run
      on another CPU, the idle restart under TINY_RCU, the per-CPU page
      lists drained before the free-page walk).
    Known costs: parking makes epoll_wait and socket-timeout waits return
    EINTR once per snapshot; every new kernel thread needs a park point
    (AGENTS.md).

## Host file systems: follow-ups

- The patch `9p: add metatimeout` is not upstream. It refuses
  write-back cache modes (EINVAL; kernel/devices.md, 9p); making it work with
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

- **aarch64: FMA, AdvSIMD FP and system instructions are calls of the
  interpreter in compiled code.** The A64 JIT (a64/jit.md)
  translates every ALU, memory and branch op, the frequent FP moves,
  compares and AdvSIMD moves, scalar FP arithmetic and conversions (with
  a fast path that needs FPCR's defaults and calls the interpreter off
  it; double FMUL, FDIV and FSQRT only once FPSR.IXC is set) inline
  (generic.zig), and where the host compiles SIMD the integer AdvSIMD
  ops, LD1/ST1, LDP/STP of V registers, AES, PMULL, SHA1, SHA256 and
  SHA512 (vec.zig); the other generic ops are calls of the reference
  interpreter through the kernel's function table, with the module's
  registers spilled around them (2026-11-18). Exclusives, LDAR/STLR and
  the LSE atomics are inline too, with wasm atomics in SMP builds
  (atomic.zig); pairs and CASP stay calls. The largest count left is
  FMADD (a64/performance.md, Where the time goes).
- **aarch64: OpenSSL's NEON and crypto paths need wasm SIMD in the
  host.** The image's libcrypto now picks its code from HWCAP and the
  kernel enables SHA512 by default, because the JIT translates those
  paths (aes-128-gcm 99 MB/s, sha256 157, sha512 217 against 24, 59, 131
  on the integer paths; 2026-11-18, guest-packages.md). A host whose
  engine has no SIMD (V8 on an x86-64 without SSE4.1) runs them as
  interpreter calls, 2-13x slower than the integer paths would be; such a
  host could boot with `kw.isa=-sha512` or set `OPENSSL_armcap=0`.
- **One timing-sensitive case in `pnpm test:api`** failed now and then
  on the decoded-op tier bundle (2026-11-17; not seen in 4 runs on the
  JIT bundle, 2026-11-18): the inline `display, evdev and sound` case
  sums the PCM chunks 300 ms after glimmer's "test sound done" and then
  misses the last one (65966 or 65919 of 66150 frames), while
  `test/glimmer-check.mjs --run` gets all 66150, sample exact (3 of 3).
- **aarch64 page: not yet opened in a browser.** The launcher demos (web.md,
  Launcher), the stand-ins (web.md, Stand-ins) and qemu-user are checked
  through the Node SDK only (2026-11-18): static busybox binaries of
  x86_64, riscv64, i386 and armv7 each installed their qemu and library
  root on first run in 8-9 s and then ran in 0.2-0.3 s. In a browser,
  writing claude's 357 MB and opencode's 248 MB to the IndexedDB data disk
  has not been timed, and every demo's first run there waits on Wisp
  instead of the host's network.
- **GNU ld binaries exec slower.** Alpine links everything with GNU ld,
  whose one R+X segment for code and read-only data cost about 0.5 ms per
  exec under riscv64 kwemu against lld's layout; on aarch64 about 0.07
  ms (busybox, 150 execs 230 against 220 ms, 2026-11-18;
  guest-packages.md). The cause on the kwemu or kernel side is not known.
- **aarch64 apk is still slower than riscv64.** With the rebuilt
  packages and the JIT's generic calls and inline forms (2026-11-18,
  a64/performance.md, Where the time goes) the apk commands take 6-25% longer than
  on riscv64, although they run about 12% fewer instructions; sort is
  level, gzip 10% faster, the ash loop 10% slower. apk runs 13-24% of its
  instructions in blocks still counting down to the compile threshold
  (node's npm 55%); a lower threshold and a heat table across processes
  did not pay (compiles cost about 0.3 ms each), nor did a bigger exec
  TLB, a 16 MiB `KW_CPU_SIZE` or chaining interpreted blocks in `runOps`
  (2026-11-18). The ranked levers left are in a64/performance.md (Next
  levers): cold code (`runOps` itself, first decodes of each new process),
  `run`'s entry path and region prologues (about 5% each of the
  apk/shell rows), NZCV materialisation (about 3%).
- **node's shared libraries** (brotli, zstd, simdutf, simdjson, c-ares,
  nghttp2) are Alpine's builds. `npx --version` did not change with the
  rebuilt packages (about 4.1 s, 2026-11-16): it is V8 in the node
  binary.
- **No seccomp**: `arch/wasm` has no seccomp filter support, so `bwrap
  --seccomp FD` fails, and GTK programs that load images through glycin
  abort. Workaround in the image: `/usr/local/bin/bwrap`
  (`kernel/guest/bwrap-shim.sh`) drops the seccomp arguments. The fix is
  seccomp in the arch (a syscall entry hook and the `asm/syscall.h`
  helpers); remove the shim then.
- **kwfb: mmap racing a mode change.** An `mmap` of `/dev/fb0` racing a
  mode change from another thread of the same program can map the old
  buffer (found 2026-11-16, on UP too). Not fixed.
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
- Kernel limits are in kernel.md (arm64 user ABI), the data-disk and
  overlay limits in data-disk.md.
