# A64 instruction semantics

What the reference interpreter implements beyond plain ARMv8.0 integer
and FP, and the rules that are easy to get wrong. Conventions every group
file follows are in a64.md.

## System registers and hints

EL0 sees Linux's EL0 view (arm64 Linux 7.x, `cpufeature.c`): kwemu
answers everything an arm64 kernel would let through or emulate, so the
kernel never decodes an MRS.

- **Read and write**: TPIDR_EL0, NZCV (bits 31..28), FPCR (`FPCR_MASK`:
  AHP, DN, FZ, RMode; FZ16, trap enables, Len and Stride are RES0 without
  FP16 and trapping), FPSR (`FPSR_MASK`: QC, IDC, IXC..IOC).
- **Read only** (MSR ILLEGAL): TPIDRRO_EL0 (0), DCZID_EL0 (4: DC ZVA
  allowed, 64-byte blocks), CTR_EL0 (0x8444c004: 64-byte lines, IDC = DIC
  = 0, so software issues DC CVAU and IC IVAU for new code), CNTFRQ_EL0
  (1 GHz, as qemu), CNTVCT_EL0.
- **CNTVCT_EL0** is the number of instructions this CPU has retired
  (`kw_cpu.icount` plus the current run): not wall time, and CPUs do not
  agree. The instruction returns `Hart.trap = .counter`; the run loop
  supplies the count through `branch.finishCounter` and counts it as
  retired (the tier and compiled code hand it back to do the same). The
  kernel must not base a vDSO clock on it.
- **ID registers** Linux emulates for EL0 (HWCAP_CPUID): MIDR_EL1
  (0x000f0000, implementer 0, so nothing picks core-specific code),
  MPIDR_EL1 (0x80000000), REVIDR_EL1 (0), and op0 = 3, op1 = 0, CRn = 0,
  CRm = 2..7, any op2 (`idReg`): visible fields describe kwemu, hidden
  ones show Linux's safe values. ID_AA64PFR0_EL1 = 0x11 (FP and AdvSIMD
  without FP16), ID_AA64DFR0_EL1 = 6, ID_AA64MMFR0_EL1 =
  0x00000111ff000000, ID_AA64ISAR0_EL1 from the enabled features (below),
  every other register 0 (no RDM, PAuth, SB, LSE2, ...; AArch32 registers
  read 0). CRm = 1 and the rest of CRm = 0 are ILLEGAL (Linux sends
  SIGILL).
- **ILLEGAL**: DAIF (SCTLR_EL1.UMA = 0), CNTPCT_EL0 and the timer
  registers, CNTVCTSS_EL0, RNDR/RNDRRS, PMU, debug (op0 = 2), SSBS, DIT,
  TCO, TPIDR2_EL0, every EL1 register.
- **Hints** (CRn = 2, Rt = 31) are NOPs: WFE, WFI (Linux sets nTWE/nTWI;
  returning at once is a permitted wake-up), YIELD, SEV, SEVL, CSDB, the
  PAC hints, BTI, unallocated hints. MSR (immediate), CFINV/XAFLAG/AXFLAG,
  WFET/WFIT and a hint with Rt != 31 are ILLEGAL.
- **Barriers**: DMB and DSB (any option) are `c.barrier` (a full barrier
  on SMP: a seq_cst RMW of `Hart.fence_word`), ISB nothing, CLREX closes
  the monitor. SB, DSB nXS, TCOMMIT and op2 = 0 are ILLEGAL.
- **SYS** (SCTLR_EL1.UCI and DZE set, as Linux): DC ZVA (`dcZva`, all or
  nothing), DC CVAU, CVAC, CIVAC (a read probe: an unmapped address
  faults, nothing else), IC IVAU (`icIvau`, no permission check: the hook
  where decoded and compiled code is dropped, a64/tier.md, Coherence).
  DC CVAP/CVADP, the MTE forms, every EL1 operation and SYSL are ILLEGAL.
- **Exceptions**: SVC (any immediate) retires with KW_EV_SYSCALL; BRK
  raises KW_EV_BREAKPOINT; HVC, SMC, HLT, DCPS, ERET, DRPS, UDF and the
  PAC branches (BRAA, RETAA, ...) are ILLEGAL.

## Optional features and HWCAP

| `KW_ISA_*` | HWCAP | ID_AA64ISAR0_EL1 | Instructions |
| --- | --- | --- | --- |
| AES | AES | AES = 1 | AESE, AESD, AESMC, AESIMC |
| PMULL | PMULL | AES = 2 | PMULL/PMULL2 .1Q |
| SHA1 | SHA1 | SHA1 = 1 | SHA1C/P/M/H/SU0/SU1 |
| SHA2 | SHA2 | SHA2 = 1 | SHA256H/H2/SU0/SU1 |
| SHA512 | SHA512 | SHA2 = 2 | SHA512H/H2/SU0/SU1; needs SHA2 |
| CRC32 | CRC32 | CRC32 = 1 | CRC32B/H/W/X, CRC32C* |
| LSE | ATOMICS | Atomic = 2 | LD<op>, SWP, CAS, CASP |
| SHA3 | SHA3 | SHA3 = 1 | EOR3, BCAX, RAX1, XAR |

The architecture has no SHA-512 without SHA-256, so `kw_set_isa` keeps
SHA512 only with SHA2: `kw.isa=-sha2` turns both off, `kw.isa=-sha512`
only SHA512, `armv8,+sha512` enables nothing. SHA3 depends on nothing
(`armv8,+sha3` is SHA3 alone). SM3 and SM4 have no bit and stay ILLEGAL
(OpenSSL picks them only from HWCAP_SM3/SM4). Each instruction checks its
own bit, so a disabled feature is ILLEGAL; reserved `size`/`opcode`
values and CRC32 with the wrong `sf` are ILLEGAL too.

## Exclusives (`excl.zig`)

The monitor is `Hart.resv` (address, `core.no_resv` when closed),
`Priv.excl_size` (1..8 bytes, 8 for a W pair, 16 for an X pair),
`Hart.resv_val` (the value read; for a W pair the whole 64-bit word) and
`Priv.excl_val2` (a pair's second register). kw_clear_reservation (every
switch and exception return), kw_set_pgd and CLREX close it.

- STXR/STXP pass only on exactly the same address and size, and always
  close the monitor; Ws = 0 on success, 1 on failure.
- Every access must be naturally aligned (pairs: the whole pair), else
  KW_EV_MISALIGNED before anything happens.
- A store that would pass and faults has no effect (status register and
  monitor stay; the kernel's trap return clears the monitor and the retry
  fails, so the guest loops).
- Should-be-one fields (Rs, Rt2 where the form has none) must be 11111,
  else ILLEGAL. LDLAR/STLLR (LOR) are ILLEGAL.
- **One CPU**: plain accesses; a store by the same CPU in between does not
  close the monitor (IMPLEMENTATION DEFINED; qemu compares values).
- **`-Dkwemu-atomics`** (`c.smp`): LDXR is a seq_cst atomic load, STXR a
  compare-and-swap against `resv_val` (another CPU's ABA store goes
  unnoticed, as in QEMU), LDAR/STLR seq_cst atomic load/store. A W pair
  is one 64-bit access.
- **X pairs on SMP**: wasm has no 128-bit compare-and-swap. LDXP is two
  64-bit atomic loads; STXP (`storePair128Shared`) takes `pair_lock` (a
  word in kwemu's static data shared by all CPU threads, never held across
  an instruction, so parking never sees it taken), then compare-and-swaps
  the low and the high half (undoing the low one if the high one changed).
  CASP of X registers takes the same lock. So all 128-bit STXPs and CASPs
  are serialised, a torn LDXP never passes, and plain loads may see half
  of one (ARMv8.0 allows that: LDP is two 64-bit accesses). Not covered: a
  racing plain or 64-bit atomic store to one half during a 128-bit STXP or
  CASP (QEMU stops all other CPUs for this instead).

Tests: `tests_excl.zig` (monitor rules, alignment, precise faults, ILLEGAL
neighbours, the 128-bit scheme on host threads, counter, ID registers,
masks, the ILLEGAL system space), `atomictest.c` against qemu.

## LSE atomics (`lse.zig`)

LDADD, LDCLR, LDEOR, LDSET, LDSMAX, LDSMIN, LDUMAX, LDUMIN and SWP
(`size 111 0 00 A R 1 Rs o3 opc 00 Rn Rt`, routed from ldst.zig: bit 24 =
0, bit 21 = 1, bits 11..10 = 00), CAS (from excl.zig: o2 = 1, o1 = 1) and
CASP (o2 = 0, o1 = 1, size 0x), every size and A/L variant; ST<op> is
LD<op> with Rt = XZR. ILLEGAL: all of it while `.lse` is off; V = 1
(FEAT_LSFE); o3 = 1 with opc != 000 (LDAPR, ST64B, LD64B, RCW); CAS/CASP
with Rt2 != 11111; CASP with an odd Rs or Rt. Rs = 30 in CASP pairs x30
with XZR.

- **Results**: LD<op>/SWP write the old value, zero-extended, to Rt; CAS
  writes it to Rs whether the compare passed or not (B and H forms compare
  and return only their bytes); CASP writes Rs and Rs+1. Operands are read
  before anything is written, so aliased registers work.
- **Alignment** to the access size (CASP: the pair), else
  KW_EV_MISALIGNED. No FEAT_LSE2 (qemu's `max` cpu has it and accepts
  unaligned atomics inside 16 bytes, so the qemu guest never tests that).
- **Permission**: every form needs write permission, also a failing CAS
  and an LD<op> into XZR (read-modify-writes for the MMU, as on hardware
  and qemu-user). So a CAS on a read-only page is KW_EV_FAULT with access
  WRITE, and on a COW page it breaks the COW even when it does not store.
  The host pointer (`Cpu.rmwPtr`, which also tracks stores into decoded
  code) is taken before anything is read or written.
- **Monitor**: an LSE store is a store like any other. One CPU: it does
  not close the monitor. SMP: STXR compare-and-swaps against what LDXR
  read, so another CPU's LSE atomic makes it fail (ABA aside).
- **Atomicity**: one CPU needs nothing (kw_run never stops inside an
  instruction). SMP: 1-8 byte forms are one seq_cst wasm atomic each
  (`rmwShared`: `.Add`, `.And` with ~Rs for LDCLR, `.Xor`, `.Or`, `.Xchg`;
  min/max are CAS loops; CAS is `@cmpxchgStrong`). A W-pair CASP is one
  8-byte CAS; an X-pair CASP is `casPair128Shared` under `pair_lock`.

In the tier every LSE word is `generic`; compiled code runs LD<op>, SWP
and CAS inline, CASP as a call (a64/jit.md, Atomics). The image's
OpenSSL and libssl have LSE outline atomics, but they never run on musl:
libgcc sets `__aarch64_have_lse_atomics` only in a glibc constructor, so
nothing writes it (measured 2026-11-18: 0 LSE instructions in 1.76G of
openssl, apk and TLS work; 1.26M of the exclusive class). Programs that
test HWCAP_ATOMICS themselves (Go, glibc builds) would take LSE.

Tests: `tests_lse.zig` (encodings against the assembler; every operation
and size over edge-value pairs against an i128 reference with the bytes
around untouched; aliasing; misaligned and read-only for every form; the
feature switch; SWP and CAS into the running block; `rmwShared`/
`casShared`/`casPair128Shared` on 4 host threads), `lsetest.c` against
qemu, the block fuzz, kwtest `lse smp`. The decode matches llvm-mc
(`-mattr=+lse`) over 81280 words of both classes (2026-11-18; the only
difference, LDXP W with Rt == Rt2, LLVM refuses as UNPREDICTABLE and
kwemu runs). Only kwtest on 4 CPUs catches LDADD made a plain load plus
store on shared memory.

## Crypto and CRC32 (`crypto.zig`)

AES, SHA1, SHA2, SHA512 and SHA3 decode in the crypto group, CRC32/CRC32C
in data-processing 2-source (`dp_reg.twoSource` calls `crypto.crc32`),
PMULL/PMULL2 .1Q in AdvSIMD three different (`crypto.pmull64`, which
must check `has(s, .pmull)` itself).

- **Constant time** in the interpreter (as far as the host's integer
  multiply is): SubBytes is the Boyar-Peralta 113-gate circuit bitsliced
  over the 16 state bytes, InvSubBytes the same between two affine maps,
  MixColumns on packed bytes, carry-less multiply `core.bitmanip.clmul`/
  `clmulh`, CRC32 folds each bit in with a mask (no table). The JIT's AES
  reads core.aes's data-indexed tables: compiled AES is not constant-time
  on the host.
- **SHA-512** (ARMv8.2): SHA512H, SHA512H2, SHA512SU1 (`11001110 011 Rm 1
  0 00 opcode Rn Rd`, opcode 00..10) and SHA512SU0 (`11001110 11000000
  100000 Rn Rd`), the Arm ARM's pseudocode on two 64-bit halves. The rest
  of op0 = 1100 other than SHA3 stays ILLEGAL (SM3PARTW1/2, SM4EKEY, SM4E,
  SM3SS1, SM3TT*, reserved).
- **SHA-3** (ARMv8.2): EOR3 (n ^ m ^ a) and BCAX (n ^ (m & ~a)) (`11001110
  0 Op0 Rm 0 Ra Rn Rd`, Op0 00, 01; 10 is SM3SS1), RAX1 (n ^ rol(m, 1) per
  lane; opcode 11 of the SHA512 class) and XAR (ror(n ^ m, imm6) per lane;
  `11001110 100 Rm imm6 Rn Rd`).
- **OpenSSL in the image** takes its SHA-512 extension path from HWCAP
  (the kernel advertises SHA512 by default); with the JIT on a SIMD host
  that path is the fast one (a64/performance.md, Current numbers). Its Keccak
  takes the ARMv8.2 path only on cores it knows by MIDR (Apple), so SHA3
  instructions never run there (sha3-256 the same with and without
  `kw.isa=-sha3`, 2026-11-18).

Tests: `crypto_tests.zig` (FIPS 180-4 and 197 known answers through the
instruction semantics, driven as OpenSSL's `sha512_block_armv8` and
ARMv8.2 Keccak drive them; SHA3-256 and SHAKE128 through Keccak-f[1600]
built from the four instructions; gating and the SHA2 dependency with
ID_AA64ISAR0_EL1; reserved neighbours), `cryptotest.c` against qemu
(known answers, then per-form hashes with aliased operands), kwtest. The
decode matches llvm-mc (`-mattr=+sha3`) over all of bits 23..10 of the
`0xce` space with Rn, Rd in {0, 31} (2026-11-18).

## AdvSIMD arithmetic

Every ARMv8.0 instruction of the arithmetic classes, integer and FP,
vector and scalar; v8.1+ (SQRDMLAH, DOT, FP16, FHM, FCMA, FRINTTS, BF16)
is ILLEGAL, and FP16 FMOV in simd_move too. Each class decodes its integer
part and hands its FP part to one function in `simd_fp.zig` (the doc
comment of each lists its instructions), which decodes the rest strictly
(single and double; FCVTN/FCVTL also convert halves, with AHP).

- Integer ops with one element size are `simd_int.Op2` over lanes
  (`map2`; a by-element op is the same op with the element broadcast as
  Vm); exact values are i128 for add, subtract and compare only; shifts
  handle amounts of the element width and more on T. Saturating ops set
  FPSR.QC.
- FP lanes are `fparith.zig` calls with one `fl` per instruction (FPSR
  ORed once at the end): `simd_fp.Bin` (two operands; FMLS is `mulAdd`
  with Vn negated, FABD `abs(sub)`, FACGE/FACGT compare absolute values)
  and `simd_fp.Un` (FRINT*, FCVT*, SCVTF/UCVTF with `fbits`, estimates,
  compares with zero).
- Easy to get wrong: FRECPS/FRSQRTS are fused (FRSQRTS computes 1.5 + a *
  (b/2), halving an operand whose exponent allows it, since 3 + a*b may
  overflow where the result does not); the across-lanes reduction is
  op(op(e0, e1), op(e2, e3)), so an sNaN quieted in the first level loses
  to a number in FMAXNMV; pairwise ops pair Vn's lanes, then Vm's; FCVTXN
  rounds to odd; by-element indexes select the 64-bit half with a mask
  (a64.md, no compiler-rt calls).

Tests: unit tests in `simd_int.zig`, `simd_arith.zig` (every same-size and
two-reg misc op over all 8-bit operand pairs against an i128 reference,
shifts over all counts, doubling multiplies on 16-bit boundaries) and
`simd_fp.zig` (estimate tables, step known answers, reserved encodings);
`simdtest.c`, `simdfptest.c`, `simdmovetest.c`; the simd fuzz (a64.md,
Tests). 2026-11-17: 1.22M integer and 1.02M FP words drawn, legality
identical to `qemu-aarch64 -cpu cortex-a53` for all of them, about 0.6M
legal words run on both with no difference (FP also 21817 words under
the wasm64 harness). The decode of simd_move and
simd_ldst matches llvm-mc (`-mattr=+neon`) over every encoding with bits
31..10 free (2026-11-17). fptest's fuzz mode: 17M cases over 17 seeds
against qemu, all identical.

## Coverage tool

`test/a64-coverage.mjs` reports, per group file and per mnemonic, which
distinct words of a corpus the interpreter rejects as ILLEGAL
(`zig-out/bin/kwemu-a64-classify` runs each word once on a scratch
machine with the reference loop; anything but KW_EV_ILLEGAL counts as
implemented). A fourth column gives the tier op kind of the word
(`generic`: the reference runs it), which with a dynamic trace says what
is left to `generic`. The output is sorted plain text: diff two reports.

Corpora live in the gitignored `vendor/a64-corpus/` (dynamic: what qemu
executed) and `vendor/a64-corpus-static/` (every instruction in the
binaries). Regenerate from an aarch64 Alpine root:

```sh
qemu-aarch64 -L $ROOT -d in_asm,nochain -D sh.log $ROOT/bin/busybox sh -c '...'
node test/a64-coverage.mjs --import sh=sh.log [apk=apk.log ...]
llvm-objdump -d $ROOT/bin/busybox $ROOT/lib/ld-musl-aarch64.so.1 ... > static.dis
node test/a64-coverage.mjs --import static=static.dis   # then move it to vendor/a64-corpus-static/
zig build && node test/a64-coverage.mjs                  # all of vendor/a64-corpus
node test/a64-coverage.mjs vendor/a64-corpus-static/static.txt
```

For the whole image, disassemble each ELF to `<name>.dis` (`llvm-objdump
-d --mattr=+v9.6a,+sve2,+sme`), import each as `img-<name>`, move them to
`vendor/a64-corpus-image/` and run the tool on that directory.

## What is implemented (2026-11-18)

Every group is complete for ARMv8.0-A EL0 with the extensions above. On
the corpora (qemu 10.2 traces of busybox sh, apk and `apk update` under
cpus with and without crypto, 42489 distinct words; and the static words
of busybox, musl, apk, zlib, libssl and libcrypto, 209286):

- dynamic: no word ILLEGAL;
- static: 436 ILLEGAL, all later architecture behind HWCAP checks that
  kwemu does not advertise: SVE/SME (283, libcrypto's ChaCha and SM4
  paths), SM3/SM4 (145), LDRAB, `mrs RNDR`/`RNDRRS`, CBNE (FEAT_CMPBR),
  and two data words in a text section that disassemble as `ldxrh w29,
  [x18]` (0x484f565d) and `stlr w29, [x20]` (0x888f969d) with Rs/Rt2 not
  11111;
- the whole image (226037 words, 2026-11-17) adds nothing beyond those
  classes. Words a program reaches on any CPU and that once were missing
  are scalar SCVTF/UCVTF/FCVTZS/FCVTZU on D registers (busybox `sleep`)
  and `fneg v.2d` (musl's libm), implemented in `simd_fp.zig`.

The image's busybox, zlib, libcrypto, libssl and apk are Alpine's builds
(`-Os`, almost free of vectorized code); libcrypto picks its AES, PMULL,
SHA and NEON code from HWCAP.
