# Kernel tests

Quick checks per change and the full matrix are in testing.md. To add a kernel check: a `CHECK(...)` in
`guest/src/test/kwtest.c`.

## kwtest (`guest/src/test/kwtest.c`)

`/usr/bin/kwtest` in local builds' bundle and in `base-test.cpio` (`--initrd
base-test`), not in release bundles (guest.md). Run as `rdinit=/usr/bin/kwtest` on both builds (UP and
SMP), with and without `--no-jit`; it powers off on success (`kwtest: 0
failure(s)`) and halts (exit 1) on failure. `kwtest isa` runs only the ISA
checks; `kwtest smp` (as `rdinit=/usr/bin/kwtest -- smp`) runs only
`uaccess:`, `smp:`, `lse smp:`, `excl smp:`, `move:` and `jit:`.

Built by `guest/base/build.sh` with `zig cc -target aarch64-linux-musl -mcpu=generic
-static -O2 -s`. It needs kwemu's scalar FP and AdvSIMD arithmetic (Zig's
libc malloc uses CNT), and no AdvSIMD FP. Device nodes come from devtmpfs
when it is mounted, else they are made in `/tmp` (as `/init` it makes
`/tmp` and `/proc` if the initramfs has none); it never opens a node in
`/tmp` once `/dev` has one, because the overlay root mounts `/tmp` nodev.

What it covers beyond syscalls:

- **Features and the arm64 ABI**, reading `kw.isa=` from `/proc/cmdline`:
  the cpuinfo `Features` line (names, HWCAP order, what must be listed)
  against AT_HWCAP (no bit outside the table), AT_HWCAP2/3 0, AT_PLATFORM,
  no vDSO, AT_MINSIGSTKSZ 4720, the cpuinfo MIDR fields, the EL0 system
  registers (CTR_EL0, DCZID_EL0, TPIDRRO_EL0, MIDR_EL1, TPIDR_EL0), DC ZVA,
  misaligned LDR/STR of X, W, D and LDP/STP within and across pages, UDF
  (SIGILL, ILL_ILLOPC) and BRK (SIGTRAP, TRAP_BRKPT), one probe instruction
  per feature (`a64_feats`) that must raise SIGILL exactly when the
  feature is not listed, the signal frame (fpsimd record and terminator,
  V8 and FPCR as at the SVC, sigreturn loading V9 and FPCR), the return to
  `sa_restorer` and to `[sigpage]`, and `clock_gettime` without a vDSO.
  Run it with `kw.isa=armv8` too after a feature change.
- **ISA results** (`isa <feature>:`; also pass under `qemu-aarch64 -cpu
  cortex-a53`, except the FPCR/FPSR read-back and the exec check): known
  answers for each optional feature in AT_HWCAP and SIGILL for each one
  that is not: AES-128 (FIPS-197 C.1, key expanded by AESE), PMULL/PMULL2
  .1Q and GHASH (GCM test case 2), SHA-1 and SHA-256 (FIPS 180), CRC-32 and
  CRC-32C by B, H, W and X, SHA-512 driven as OpenSSL's ARMv8.2 code does,
  SHA3-256 and SHAKE128 by Keccak-f[1600] on EOR3, RAX1, XAR and BCAX, the
  ID_AA64ISAR0_EL1 fields against AT_HWCAP, and each LSE op (LD<op>,
  STADD, SWP, CAS, CASP) on B, H, W and X.
- `fp:` each FPCR.RMode for FDIV, FSQRT, FRINTI and SCVTF; each FPSR flag
  and their accumulation; FZ on denormal input and output; DN with NaN
  payloads; FPCR/FPSR read back 0x07c00000 and 0x0800009f after writing
  all ones; fork keeps FPCR and FPSR, exec clears them.
- `vregs:` V0..V31, FPCR, FPSR, x9..x18 and TPIDR_EL0 kept across a signal
  at an SVC, across 1 ms SIGALRMs in a spin, and in two processes that
  ping-pong over pipes and then spin side by side on one CPU (each must
  see an involuntary switch). `tpidr:` three threads with their own
  TPIDR_EL0 over 2000 `sched_yield()` each.
- `exclusive monitor:` STXR passes right after LDXR and fails after a
  syscall, after a signal whose handler did an LDXR of the same word, and
  after a switch to a thread that did one.
- `hot loops (JIT)` and `FP hot loop (JIT)` run long enough to compile
  (self-looping blocks with page faults, a thread, a COW child, SIGALRM);
  the FP hash comes from a native build (`fphot()`).
- `park:` park cycles through `/proc/kwpark` (UP and SMP; parking.md).
- AF_VSOCK: with the host device (the CLI's default) the guest CID is 3 and
  a connect to host port 9 is refused (ECONNRESET); with `--no-vsock`
  `connect()` fails with ENODEV.
- kwshm (CLI `--shm`, skipped otherwise): page counts of a 1 MiB memfd with
  holes and of a 10000-byte range, the EINVAL refusals (unaligned offset,
  range past the end, a pipe), `F_SEAL_WRITE` EBUSY while exported and
  fine after release or closing `/dev/kwshm`, a second release ENOENT.
- kwfb (CLI `--display`, skipped otherwise): a second open of `/dev/fb0`
  fails with EBUSY while the first is open, while a forked child still
  holds the file, and while a mapping outlives `close()`; it opens again
  after the child's exit and after `munmap`.
- `uaccess:` `read()` from a pipe into a userfaultfd page whose handler
  signals the reader before it supplies the page must return the data; a
  `FUTEX_WAKE_OP` add beside an LDXR/STXR add on the same word (on another
  CPU when there is one) must lose no increment.
- `config:` checks options (config.md); `input handlers` that no input
  handler besides evdev and sysrq is registered.
- `smp:` (more than one CPU): three threads count to 900000 through atomic
  adds, a CAS loop and a pthread mutex, and must have run on two CPUs.
- `lse smp:` (needs HWCAP_ATOMICS; on one CPU too, where preemption
  interleaves): one pinned thread per CPU (2 to 4) hammers shared counters
  with LDADDAL, STADDL, a CASAL loop, SWPAL (every value comes out exactly
  once), LDUMAXAL, a CASA/SWPL lock around a plain increment and a 128-bit
  CASPAL counter; every total must be exact. Threads are pinned because the
  check is shorter than the balancer may need to spread them (`move:`
  checks spreading).
- `excl smp:` (on one CPU too): one pinned thread per CPU counts 50000
  times in its own halfword of a shared word (LDXRH/STXRH: a wider store
  would lose a neighbour's counts) and, all of them, in a shared halfword,
  byte, word and doubleword with the acquire/release variants, and with
  HWCAP_ATOMICS LDADDB/LDADDLH beside them; two threads pass 20000
  messages published by STLR of X, W, H and B and read by LDAR. The loops
  run compiled.
- `move:` (more than one CPU; smp.md): 2 threads per CPU started on CPU 0
  and then allowed everywhere must sit evenly on every CPU at 1.2 s; the
  main thread moves itself round the CPUs 300 times in the middle of a
  register computation in FE_UPWARD with FE_DIVBYZERO raised and must match
  a run without moves; `sched_setaffinity` on a busy thread returns at
  once and moves it within 1 s, on one asleep in `read()` returns at once
  and moves it at the wakeup; 2000 queued RT signals to a moving thread
  arrive once each; pipe and futex round trips between moving threads keep
  their order; a reader on a busy CPU 0 woken from CPU 1 must leave CPU 0
  within 40 wakeups; of 5 children that exec beside the busy thread at
  least 4 start their new image elsewhere; `/proc/kwmove` shows moves and
  no lost drops.
- `jit:` (more than one CPU; kwemu.md, JIT on several CPUs): `hot()` and
  `fphot()` on every CPU at once while signal handlers change FPCR and FPSR
  (sigreturn must undo both); four threads increment their own byte and
  halfword of one cache line beside an atomic add and a CAS loop (no store
  lost); a compiled thread whose affinity changes every 4 ms; code that CPU
  1 calls in a loop rewritten by CPU 0 (one aligned store and
  `__builtin___clear_cache()`, 300 times), replaced by `mremap()` (40) and
  made non-executable by `mprotect()` (10): CPU 1 must never run an older
  version once a new one is published, never run non-executable code, and
  never crash.

## abitest (`guest/src/test/abitest.c`)

A freestanding arm64 ABI test (no libc, no exclusives, no TLS), so it runs
before a libc does and is the only test that sees the registers exec leaves
(all of x0..x30, V0..V31, FPCR, FPSR, NZCV and TPIDR_EL0 0, for itself as
init and for a process that execs itself with all of them set). It also
checks the auxv, `personality(PER_LINUX32)`, an unaligned `mmap` offset,
the signal frame and sigreturn (x19 from the frame, the {x29, x30} record),
`sa_restorer` and `[sigpage]`, EINTR and SA_RESTART restarts (a child
writes after 100 ms, past the parent's 20 ms alarm, whatever the CPU's
speed), and raw `clone()` (fork's x0, CLONE_SETTLS). Its header has the
build command. Boot it like kwtest with `rdinit=/usr/bin/abitest`
(`abitest: 0 failure(s)`, exit 0). The release workflow runs it on 1 and 2
CPUs.

## Others

- kwbench (`rdinit=/usr/bin/kwbench`, `--stats` for the JIT counters):
  rough guest speed.
- `node test/wasi-node.ts`: the kernel with Node's `node:wasi` for every
  WASI import (`unkernel` imports from the script: JSPI switching, no
  block or net device, no JIT), a check of the WASI side against a
  third-party implementation.
- Debian (`--distro debian`, guest.md) is the glibc check: boot it, and
  with a network run an `apt-get install`.

## Debugging

- To list what a userland lacks, build a throwaway kernel (`KOUT=`
  elsewhere) that `pr_info`s every `-ENOSYS` in `do_syscall` and every
  `do_user_trap` (traps.c). On the riscv64 guest, Ubuntu 24.04's boot, apt
  and python3 hit neither, systemd only `bpf` and `keyctl`; not yet rerun
  on 26.10 arm64 (status.md).
- For a hang, the same kernel can print each user task's state and `x8`
  (the syscall it sleeps in) from `arch_cpu_idle` every 20 s. A busy host
  can be paused through the Node inspector (`kill -USR1`, then
  `Debugger.pause` over CDP), which shows the wasm kernel stack at the next
  import call.
- tcrypt cannot benchmark here: `sec=N` loops forever (jiffies do not
  advance inside one long kernel stay) and `sec=0` needs `get_cycles`,
  which is 0 on arch/wasm.
