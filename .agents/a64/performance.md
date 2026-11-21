# A64 performance

Numbers, what they rest on, and what was tried. All on an i7-10700K
(16 threads) with Node 24.22.1 unless said. Single runs on a busy machine
vary by up to 20%, and the first command after boot most (V8 is still
optimising the kernel): compare interleaved medians only, and give
machine, date and command with any number. The ISA-neutral core's numbers
and rejected designs are in kwemu.md.

## Measuring

- **Guest MIPS**: `node test/kwemu-bench.mjs --ref --reps 5 --median`
  (the A64 guests `test/guest/a64/bench.c` and `test/guest/kbench.c` modes, native
  and wasm64, tier and reference; `--wasm-only`). The guests are built
  with `-fno-vectorize`, so `fp` is scalar FP.
- **Alpine**: `test/guest-bench.sh` (20 apk and shell commands timed in the
  guest from /proc/uptime, 10 ms steps; its header has the command line),
  boots interleaved, medians of 5. Node rows: a data disk with Node 24 and
  npm 11, `--mem 1024 --snapshot` (an empty npm cache each boot), medians
  of 3.
- **Debian with Node, Bun and Claude Code**: a data disk
  (`vendor/build/profile/debian-node.img`, gitignored) with Node 24.22.3
  and npm from nodejs.org, Bun 1.4.5 and the native Claude Code 2.1.329 (a
  Bun executable) installed for the user, and a host copy of its root in
  `vendor/build/profile/root` for `--profile-root`; `node js/cli.ts
  --distro debian --data vendor/build/profile/debian-node.img --snapshot
  --mem 1024`. All three are non-PIE and run with no illegal instruction.
  Workloads (2026-11-21; user instructions per run, then the median wall
  time of a later run, UP bundle inline): `claude --help` 441 M, 2.48 s;
  `npm --version` 310-370 M, 2.28 s (3.15 s on the first run); `bun
  cpu.js 150` (a numeric, string, object, Map and sort mix) 1.1 G, 2.87 s;
  on 2 CPUs with the 64K ring: `claude --version` 12.8 M, 0.115 s; `bun
  build` of a 0.5 MB TypeScript file 144 M, 0.66 s. Later runs of the same
  binary reuse code compiled by earlier processes (Tenured ring), so
  report first and later runs apart. The A/B numbers below are SDK boots
  (`createKernel` inline, the disk with `snapshot: true`), one per variant
  and workload, timing 3-5 `vm.exec` runs of the command each.
- **Counters**: a `-Dkwemu-stats` kernel (`kernel/build.sh stats`, CLI
  `--stats`, or `kw_debug_stats` per window: kwemu.md, Measuring). The
  A64 tier adds `tier.Ax` in JitStats.hb_gen (interpreted instructions by
  why they were not compiled: never compiled, counting down, the tail
  after a hand-back; hand-backs by kind; countdown progress lost; generic
  hand-backs and executions by class, `tier.genClass`), `tier.Ar` in the
  tail of Stats.op_hist (nursery resets and what was live, tenured blocks,
  decodes by what the table way held, countdown taken over), `tier.fpForm`
  (generic executions by FP form), `Jx.sync_site` (where NZCV is
  materialised, counted in the generated code), and generic ops by
  instruction word (`kwemu.countGenWord`, `JitStats.gen_words`: 512
  entries of key = word with Rd and Rn cleared, executions, calls from
  compiled code; `KwemuStats.words` from word 501 on; disassemble the
  keys with llvm-mc).
- **Counter traps**: all counters run from boot. `gen_words` fills up
  during the boot, so in a later window about half of the generic ops land
  in the last entry (its key stays 0); the class totals (`tier.genClass`)
  are complete. `Ar.heat_kept` re-adds a block's whole progress at every
  re-decode, so it is a running stock, not a flow: do not compare it with
  `Ax.lost_drop`. Two losses of progress are not counted: `victim()`
  halving the surviving way's progress on a conflict eviction, and
  `jc.evict` resetting a compiled block to the full threshold
  (`Ar.ten_evicted_compiled` counts those blocks, not what they lose).
- **One guest command**: with the SDK, take `vm.stats().kwemu` (and
  `stats().jit` for compile time and bytes) before and after
  `vm.exec(...)` on a stats bundle, and subtract word by word. Host time
  for the same window: `node:inspector`'s `Profiler.start`/`stop` around
  the exec. Pre-install big programs on a data disk opened with
  `openDisk(file, { snapshot: true })` so each boot skips the install.
  `claude -p` (no valid key) is not repeatable (4.5-12 G instructions per
  run); `claude --help` is (441 M), so use it for A/B comparisons, with 8
  or more interleaved rounds to resolve 3%.
- **Guest profile**: `--profile FILE` (with `--cpus 2` or more for time
  samples, `--profile-root DIR` for symbols; kwemu.md, Measuring): where
  guest user time goes by file and offset over every process, and by
  command, process and pc, against instruction samples at the same keys;
  a page of a file or a symbol whose time share is well above its
  instruction share is slow per instruction (interpreted, a hand-back, a
  slow path). For one command, take `vm.profile()` before and after it and
  subtract the counts.
- **Host profile**: `node --cpu-prof` of the CLI; it stops at wasm
  functions, and V8's first-call compile of JIT modules shows as
  `(program)`. In such breakdowns `decode.exec` is the reference
  interpreter running generic ops, not decoding.
- **Host counters**: `perf stat`/`perf record` with `:u` events of `node
  --perf-basic-prof js/cli.ts ...` give cycles, instructions and misses per
  kernel function (perf 7.3.3; the host needs
  `kernel.perf_event_paranoid` 1 or lower; no PEBS events in a container).
  Window them with `perf record -D -1 --control fifo:CTL,ACK` around the
  command.

## Current numbers

**Tier vs reference** (2026-11-17, guest MIPS, `kwemu-bench.mjs`):

| benchmark | Minsns | native ref | native tier | wasm64 ref | wasm64 tier |
| --- | ---: | ---: | ---: | ---: | ---: |
| sieve+fib | 99.7 | 71.3 | 525.7 | 45.2 | 274.1 |
| mem | 65.3 | 68.1 | 522.4 | 42.9 | 288.0 |
| fib | 25.6 | 67.5 | 565.0 | 42.2 | 295.5 |
| fp | 136.0 | 57.1 | 151.5 | 35.8 | 96.6 |
| sha | 171.9 | 71.8 | 547.5 | 47.4 | 284.4 |
| interp | 175.2 | 64.6 | 406.5 | 40.5 | 246.8 |

On the image the tier was 3.3-4.9x the reference loop (`apk search` 1.14
against 4.87 s, `seq 100000 | sort -r` 6.57 against 32.14).

**JIT** (2026-11-18, `kwemu-harness-jit.wasm` at the default threshold,
the same guests, medians of 5): sieve+fib 1204 MIPS (memory32 1303), mem
1164 (1321), fib 804 (1024), fp 98 (106), sha 1748 (1952), interp 1184
(1364). A register-only loop guest ran 1965 MIPS with lazy NZCV against
1277 with NZCV packed after every producer. Modules average 1-1.4 KiB
and take 0.1-0.3 ms each to compile and install.

**Alpine apk and shell** (2026-11-18, guest seconds, medians of 5, the
riscv64 guest's last bundle for scale; A64 with generic calls and inline
forms, before the op-arena and later changes, which took the 20-row sum
from 24.6 to 22.0 s):

| command | riscv64 | A64 |
| --- | ---: | ---: |
| apk update | 1.15 | 1.29 |
| apk search | 0.69 | 0.82 |
| apk info -v | 0.61 | 0.67 |
| apk add jq | 1.19 | 1.26 |
| apk add python3 | 3.53 | 4.06 |
| ash loop, 30000 iterations | 1.86 | 2.04 |
| `seq 100000 \| sort -r` | 2.82 | 2.82 |
| `seq 250000 \| gzip \| gunzip` | 2.19 | 1.97 |

apk stays 6-25% behind riscv64 although it runs about 12% fewer
instructions. Compiled share (stats kernel): apk update, search, info and
add jq 76-86%; apk add git and python3, ash, sort, gzip 93-98%; the rest
is blocks counting down to the threshold, hand-backs (data-TLB misses)
0.1-0.5%.

**Node and Bun** (2026-11-18, UP bundle, guest seconds, cold and warm
runs): `npm --version` 3.91 and 3.54, `npx --version` 3.53 and 3.55, `npx
--yes cowsay hi` 38.0 and 14.6, `node -e 0` 0.69 and 0.64, a JSON loop
4.12; Bun `bun -e` x10 0.65, `bun run t.ts` x5 0.79. SMP kernel with
`--cpus 2`: `npm --version` 3.47 and 2.99. Compiled share: npm 44%, `node
-e 0` 63%, V8 loops 80-92%.

**OpenSSL** (2026-11-18, UP bundle, libcrypto built with gcc `-O2`; the
image now has Alpine's `-Os` build, whose NEON and crypto paths are the
same assembly; `openssl speed -evp ALG -bytes 16384 -seconds 2`, MB/s, medians of 3 boots;
"integer" is `OPENSSL_armcap=0`, "NEON + crypto" what HWCAP selects on a
SIMD host, "no SIMD" the same code as interpreter calls):

| algorithm | integer | NEON + crypto | NEON + crypto, no SIMD |
| --- | ---: | ---: | ---: |
| aes-128-gcm | 23.8 | 98.8 | 13.9 |
| aes-256-gcm | 20.5 | 79.5 | 11.4 |
| aes-256-ctr | 25.0 | 137.2 | 14.3 |
| aes-128-cbc | 42.5 | 189.7 | 23.1 |
| chacha20-poly1305 | 167.9 | 203.4 | 4.8 |
| sha256 | 59.4 | 157.0 | 26.6 |
| sha512 | 130.8 | 216.9 | 9.8 |
| sha1 | 158.4 | 323.6 | 30.9 |

A host without wasm SIMD is 2-13x slower than the integer paths would be;
it could boot with `kw.isa=-sha512` or set `OPENSSL_armcap=0` (status.md).

**Tenured ring** (`ten_default` 128K ops beside a 320K-op nursery,
`KW_CPU_SIZE` 9 MiB). The 64K ring, which is FIFO, could not hold one
run's compiled set of a Bun-based program, so every run compiled again;
non-PIE binaries reuse what the ring keeps (Where the time goes, Compiled
code across processes). Taking the 128K ring out of a 384K-op arena (a
256K nursery) made npm slower, so the arena grew by 1 MiB.
Measured 2026-11-21 on the Debian profile disk (Measuring), UP bundle
inline, 8 boots per variant with bundles rotated per round, medians,
first / later runs against a 64K ring and a 320K nursery (8 MiB):

| Nursery (`KW_CPU_SIZE`) | `claude --help` | `npm --version` | `bun cpu.js 150` | mixed sequence | compiles per later claude run |
| --- | --- | --- | --- | --- | --- |
| 256K (8 MiB) | -1.8% / -14.9% | +2.1% / +3.3% | -1.4% / -4.7% | -2.2% | 448 to 97 |
| 320K (9 MiB, the default) | -1.2% / -14.6% | +1.6% / -0.6% | -2.4% / -3.5% | -3.6% | 448 to 98 |
| 384K (10 MiB) | -2.4% / -15.4% | -1.5% / -2.0% | -2.8% / -2.3% | -3.7% | 448 to 101 |
| 512K (12 MiB) | -4.2% / -15.9% | -2.6% / -2.0% | -2.0% / -0.3% | -4.8% | 448 to 96 |

Baseline spread: first runs about ±5%, later runs ±3-5% (claude
2796-3072 ms, npm 2241-2403). The mixed sequence is one boot of claude,
npm, claude, npm, claude, npm (17.09 s with the 64K ring); with a 320K nursery the
steps compile 426, 298, 146, 77, 336, 60 blocks against 430, 296, 437,
272, 437, 275: an npm run between two claude runs still pushes part of
claude's code out. On 2 CPUs (5 boots): claude -2.4% / -17.8% with a
320K nursery (256K: +0.9% / -16.4%), npm -0.6% / -3.4% (256K: +2.2% /
-2.9%), the mixed sequence -4.2% (256K: -4.8%; 512K: -8.3%). Alpine (5
boots): the 20-row sum +0.8% with a 320K nursery (256K +1.0%, 384K +2.3%,
512K +2.9%), gzip +3.3% (ranges overlapping), OpenSSL -2.8% to +1.1%;
`kwemu-bench.mjs` within -1% to +4%. Boot time (448-452 ms to the first
command UP, 662-672 ms on 2 CPUs) and the host's RSS do not change; each
MiB of `KW_CPU_SIZE` comes out of guest RAM on every CPU (MemTotal at
`--mem 1024`: 1022964 KiB with 8 MiB, 1021940 with 9 MiB, 1018868 with 12
MiB; twice that loss on 2 CPUs). Stats bundle, later npm runs: 41 nursery
resets with the 320K nursery, 39-42 with the 64K ring, 57-59 with 256K (decodes
670K, 651-679K, 752-762K; re-decodes 51%, 51%, 57%); the mixed sequence
evicts 78-706 compiled blocks per step after the first.

**Sizes**: `kwemu.o` (wasm64, ReleaseFast) 234 KB, 199.6 KB with
`-Dkwemu-a64-ref`; `kwemu-jit.o` about 600 KB.

## Where the time goes (2026-11-18 unless dated)

- **node's cold code.** Host profile of three `npm --version` and an `npx
  --version` with the boot: `runOps` 40.8%, `kw_run`'s loop 14.4%,
  compiled code 14.4%, decode 10.4%, lookupSlow 2.3%, validate 2.0%,
  `jitcore.enter` 1.4%, generic ops in the tier about 1.5%. npm runs 56% of
  its instructions outside compiled code and decodes once per ~480
  instructions; of its 1.0M decodes per command 0.46M are first decodes of
  the process (ops hold absolute addresses, so a PIE binary at a new base
  decodes again), 0.58M decodes again after nursery resets. Exclusives
  (1-10M per command) and AdvSIMD (1-8M) in node run mostly interpreted,
  in cold code.
- **Node, Bun and Claude Code on Debian** (2026-11-20, the profile disk,
  Measuring; 64-instruction blocks and the 64K ring). Interpreted instructions are almost all blocks counting
  down to the threshold: `claude --help` 40%, `npm --version` 50%, `bun
  cpu.js` 12%, `bun build` 13-40%; at least 28%, 47% and 7.4% (claude,
  npm, bun cpu.js) are in blocks that never reach 2^17 in the run; blocks
  never compiled 0%, tails after a hand-back 0.4-1.6%. The profiles are
  flat: the 50 hottest 4 KiB pages hold 53% of claude's time and 29% of
  npm's. Time by tier (time samples, 2 CPUs), decoded against compiled:
  claude 63/35, npm 76/23, bun cpu.js 34/64, bun build 49/50; kernel time
  is 2-4% of busy time (16-20% for tiny commands such as `claude
  --version`). A guest JIT's own (anonymous) code is about 1% of claude's
  time and 15% of bun cpu.js's (for 23% of its instructions), mostly
  compiled. Hand-backs are data-TLB misses and stores into code pages
  (about 75% loads, 10% stores, 8% exclusives and LSE). Generic ops are
  0.1-1.6% of instructions; the most frequent words are `dc zva`, `movi
  v0.2d, #0`, `fmov` between X and D, `ldar`, `casab`/`caslb`, `ldadd(al)`,
  `scvtf` and `fcmp` in Bun and claude, `ldar`/`stlr`, `pmull`/`pmull2`,
  `casl` and `swpl` in npm. The 1024 JIT slots never fill and the tenured
  ring never resets. Two thirds of the modules are `shortened` (the first
  emit overflowed the 16 KiB buffer, because `jc.candidate` takes any
  decoded block not compiled yet as a member; those members do run:
  Rejected designs). With the 128K ring and 320K nursery (stats bundle,
  2026-11-21, later runs of `claude --help` in one boot; the 64K ring
  in parentheses): 70-72% compiled (54-56%), 25-28% counting down
  (42-44%), 78-133 compiles (457-477) taking 30-86 ms (162-198), no
  compiled block evicted from the ring (about 1500), 23-25 nursery resets
  (25-27), and 55-57% of decodes re-decode blocks a reset discarded
  (56-60%).
- **Compiled code across processes.** node, bun and claude are non-PIE,
  so a later process maps their code at the same addresses and its blocks
  revalidate: code compiled by an earlier process runs again if the
  tenured ring still holds it (Tenured ring). On SMP each
  CPU has its own code cache (kwemu.md, JIT on several CPUs): later npm
  runs compiled 99-365 blocks on 2 CPUs against 48-59 on one (64K ring).
- **Per-unit costs** (2026-11-20; `perf` `:u`, `node --perf-basic-prof`,
  UP bundle inline with 64-instruction blocks and the 64K ring, windows
  of 3 runs after a warm-up; Measuring). The
  decoded tier (`runOps`) per guest instruction: 25-30 cycles, 49-54 host
  instructions, 0.30-0.39 branch mispredicts (almost all at its one
  dispatch jump), 0.13 L1 and 0.04-0.055 L2 load misses. A hot shell loop
  costs the same (25.7 cycles, 48.8 instructions, 0.37 mispredicts) as
  cold claude and npm code: in the kernel decoded code costs the same hot
  or cold. The dispatch head is 14 host instructions, the simplest
  handlers about 25 more. `kw_run`'s loop (JIT on): 71-74 cycles, 114-117
  instructions and about 0.4 mispredicts per iteration, stalling on the
  block-table load and the exec-TLB generation load. A decode: 2100-3640
  cycles, 4400-7860 host instructions (about 300 per guest instruction).
  Compiled modules: 10-12 cycles, 17 host instructions per guest
  instruction, about 2.4x cheaper than decoded (time share against
  instruction share from the guest profile: 2.5-3.6x). Compiling is 4.6%
  of a claude run (`jit.compileMs` 142 of 3113 ms). V8's worker threads
  take 36% of the process's cycles on `claude --help` and 13.5% on npm
  with the JIT on (unsymbolized; likely tier-up of the modules), invisible
  in wall time on an idle 16-thread host. The wasm64 harness's hot loops
  (17.6-21.3 cycles, 69-73 host instructions, 0.007-0.10 mispredicts per
  guest instruction, whole process) do not compare with these.
- **apk.** Outside compiled code nearly all is blocks counting down
  (13-27% of instructions): about half the warm-up of blocks that do get
  compiled (compiles x 2^17), the rest blocks that never reach the
  threshold before a nursery reset. Host profile of apk search and info:
  compiled code 30%, `runOps` 29%, `kw_run`'s loop 17%, `jitcore.enter` 3%,
  `noteHot` 2%, module compiles 2.5%, decode 1%.
- **Exit costs**, priced by doubling one piece in a throwaway build (7
  boots interleaved, 6 apk/shell rows): NZCV materialisation +3.0%, the
  module prologue's register loads +5.0%, `run`'s entry path (a second
  `lookupIn`, `ready` and an indirect call) +5.4% (sort +11%).
- **NZCV materialisation sites** (`Jx.sync_site`, per command): exit or
  hand-back / back edge / member transfer / eager: `seq | sort` 9.0M,
  3.8M, 17.3M, 54.4M; gzip 16.2M, 26.4M, 8.9M, 14.7M; apk add python3
  29.4M, 31.4M, 14.8M, 9.2M. The eager site after a member's last producer
  is the largest.
- **Generic calls left** from compiled code: FMADD (busybox `seq`: 0.25M
  in the gzip row), OpenSSL's LD4/ST4 (11K per second of
  chacha20-poly1305); exclusive pairs and CASP never ran in any workload.
- One stats boot showed an ash loop at 82% compiled with 12% of its
  instructions in tails after data-TLB misses: the direct-mapped data TLB
  aliases hot pages in some address layouts; other boots do not.

## Next levers (ranked, 2026-11-20)

Node, Bun and Claude Code (Where the time goes), in this order:

1. **Measure again with the 128K ring**: V8's worker
   threads' share of cycles and the decode share (`perf`, Measuring).
2. **More tenured capacity or a second-chance ring**: the mixed sequence
   still evicts compiled blocks (`Ar.ten_evicted_compiled`, Tenured
   ring), but a bigger ring needs a bigger `KW_CPU_SIZE` (1 MiB of guest
   RAM per CPU for 64K ops) or takes from the nursery, which costs npm;
   worth it only if long sessions show the same.
3. **Per-CPU code caches on SMP**: each CPU compiles the same code again
   (kwemu.md, JIT on several CPUs, says what sharing needs).
4. **A cheaper decoder**, only if decode stays above about 8% of npm's
   time (about 300 host instructions per decoded guest instruction).
5. **Binaryen `-O2` after the 32-bit lowering**: 2-3.5% fewer main-thread
   host instructions on claude and npm (2026-11-20, perf); wall time not
   yet measured on a quiet machine.

Smaller: tier op kinds for LDAR/STLR and LSE (generic ops are 0.1-1.6% of
these programs' instructions). Not worth revisiting: the compile
threshold and heat policy, the block-table size, the interpreter's
dispatch and op density (Rejected designs).

Apk and shell rows:

1. **`run`'s entry path and the region prologue**: about 5% of the
   apk/shell rows each. Lighter prologues need a region-wide "written
   before every exit" analysis (loading only the entered member's
   registers was slower; kwemu.md, Rejected designs).
2. **NZCV materialisation**: about 3%. Carrying lazy state across member
   transfers needs a runtime kind for the checked entry's stop path.
3. **FMADD inline**: needs fparith's emulated FMA inline (no wasm FMA);
   worth at most about 2% of the gzip row.

The shared-core levers (bigger regions, self-loop exits, threshold) are in
kwemu.md, Next steps.

## Rejected designs (A64)

Do not retry without a new reason. Dates 2026-11-17/18 unless given; UP
bundle, boots interleaved.

| Idea | Result |
| --- | --- |
| `runOps` inlined into `run` | wasm64: sieve +13%, mem +5%, but sha -9%, interp -7%; a separate function running self-loop passes gets the gains without the losses |
| An op that does not continue handled inside `runOps`' `inline else` body | every leaving kind had its own copy; handling it once after the `switch` made cold code faster (npm 4.23 to 3.91 s, the 20 apk/shell rows 22.75 to 22.18 s) |
| Self-loop pass count as `left / ninsn` per entry | a 64-bit division per entry: sha, interp, fib -6..-9%; `runOps` subtracts per pass |
| Error unions from non-inlined slow paths inside `runOps` | each result slot is a shadow-stack frame slot set up on every call (~50 wasm instructions); plain integer results: mem +7%, interp +4% |
| No cross-CPU invalidation | kwtest's cross-CPU rewrite check ran 751695 of 877496 calls stale (a64/tier.md, Coherence) |
| JIT threshold 2^15 or 2^13 | 2^15 within noise; 2^13 apk rows 5-25% slower: extra compiles (~0.3 ms each) cost more than they move into compiled code. With countdowns kept across resets 2^15 made npm 5.93 against 4.86 s. 2^16 with the 128K ring and 32-instruction blocks (2026-11-20, the profile disk, 6 boots, medians): `claude --help` first runs +1.6% and later runs +4.1%, npm +2.5% and +0.8%, bun cpu.js +1.3% and -0.4%; twice the compiles per later claude run (171 against 88) |
| Region members only with a quarter of the threshold counted (a heat test in `jc.candidate`), alone or at threshold 2^16; `region_max` 8 | Claude Code `--help`, 8 rounds (2026-11-19): 3.55, 3.68 and 3.57 s against 3.56. Alone: `shortened` 292 to 75 and members 2059 to 1556, but compiled share 54.5% to 49.8% (the cold members did run). At 2^16: 61.8% compiled, 898 compiles, compile time 148 to 264 ms |
| V8 without Liftoff (`node --no-liftoff`) | Claude Code `--help` 4.7 against 3.3 s, about 3.5 ms more per extra compile (2026-11-19) |
| A heat table keyed by host address (short countdown for code compiled before, also in an earlier process) | compiled share +2..+8 points on apk, but twice the compiles; time equal at best, worse with shorter countdowns; remembering counting blocks too thrashed the table |
| Countdowns kept across arena resets with alternating-way replacement | npm 6.04 against 5.22 s: conflict evictions lost progress and evicted members failed checked entries; replacing the way with less progress fixed it |
| A tenured part that frees every module when full | short apk commands 10-15% slower (~450 modules freed per command) |
| `jc.enter` inlined into `run` | within noise |
| Exec TLB of 1024 sets instead of 256 | npm exec-TLB walks 160K to 30K and revalidations 1.3M to 0.5M per command, time within noise: a revalidation is cheap |
| A nursery beyond 320K with the 128K ring: 384K (`KW_CPU_SIZE` 10 MiB) or 512K (12 MiB); earlier 16 MiB (64K blocks, a 704K nursery) | 2026-11-21, against the 320K nursery (Tenured ring; UP 8 boots, 2 CPUs 5): `claude --help` later runs -1.0% and -1.5%, npm later runs -1.4% and -1.4%, the mixed sequence -0.1% and -1.2% (on 2 CPUs 512K -4.3%), bun cpu.js later runs +1.2% and +3.3%, the Alpine sum +1.5% and +2.0%: within noise or mixed, for 1 and 3 MiB more guest RAM per CPU. 16 MiB (2026-11-18/19, Alpine's node, single runs, before the ring change): npm decodes 880K to 565K, time within noise, `node -e 0` slower |
| Chaining interpreted blocks inside `runOps` | the `run` loop is 12% of npm's host time, but every node row got 2-4% slower: the chain code in each branch kind costs more than the returns it saves |
| Shorter blocks: `max_block` 32, 48 or 16 instead of 64 (2026-11-20, UP bundle) | 32 with the 128K ring, the profile disk (6 boots): `claude --help` +0.8% / -15.9% (first / later runs; the ring alone -15.7%), npm -4.9% / -2.8%, bun cpu.js 0.0% / -9.0%, the mixed sequence -4.8%; the Alpine 20-row sum -3.3% and -5.6% in two sessions (gzip -32%, sha256sum +4-6%); but OpenSSL (5 boots, two sessions) chacha20-poly1305 -25%, sha512 -10%, aes-128-gcm -5..-9%, aes-256-ctr -6%. 32 alone (an earlier round, 6 boots): claude +0.9% / -12.1%, npm -3.4% / -1.8%, bun cpu.js -4.3% / -5.0%; hot guests (`kwemu-harness-jit.wasm`) -0.9..+3.7% (noise ±4%). 48 with the ring: OpenSSL chacha20-poly1305 -11%, aes-256-ctr -6%, sha512 -5%, aes-128-gcm -5%, and no gzip gain. 16: claude +10.9% / -2.9%, hot sha -15.8%, interp -6.0%. The OpenSSL losses are not traced; a length rule that does not cut OpenSSL's blocks might keep the gains (untested) |
| Interpreter-loop work for cold code: fewer dispatch mispredicts, denser ops (2026-11-20, perf) | hot and cold code mispredict alike (Where the time goes, Per-unit costs); if every mispredict vanished, at most about 23% of `runOps`; L1/L2 misses on ops bound denser ops below 5% of `runOps` |
| NZCV of hand-back paths through module helper functions | materialisation fell from 31% to 20% of module bytes, but regions took more members up to the buffer: module bytes unchanged, compile time +9%, time within noise |
