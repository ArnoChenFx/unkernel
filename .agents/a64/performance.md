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
  run); `claude --help` is (0.44 G), so use it for A/B comparisons, with 8
  or more interleaved rounds to resolve 3%.
- **Guest profile**: `--profile FILE` (with `--cpus 2` or more for time
  samples, `--profile-root DIR` for symbols; kwemu.md, Measuring): where
  guest user time goes by file and offset over every process, and by
  command, process and pc, against instruction samples at the same keys;
  a page of a file or a symbol whose time share is well above its
  instruction share is slow per instruction (interpreted, a hand-back, a
  slow path).
- **Host profile**: `node --cpu-prof` of the CLI.

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

**Sizes**: `kwemu.o` (wasm64, ReleaseFast) 234 KB, 199.6 KB with
`-Dkwemu-a64-ref`; `kwemu-jit.o` about 600 KB.

## Where the time goes (2026-11-18)

- **node's cold code.** Host profile of three `npm --version` and an `npx
  --version` with the boot: `runOps` 40.8%, `kw_run`'s loop 14.4%,
  compiled code 14.4%, decode 10.4%, lookupSlow 2.3%, validate 2.0%,
  `jitcore.enter` 1.4%, generic ops in the tier about 1.5%. npm runs 56% of
  its instructions outside compiled code and decodes once per ~480
  instructions; of its 1.0M decodes per command 0.46M are first decodes of
  the process (ASLR moves node's text, and ops hold absolute addresses),
  0.58M decodes again after nursery resets. Exclusives (1-10M per command)
  and AdvSIMD (1-8M) in node run mostly interpreted, in cold code.
- **Claude Code** (2.1.328, a Bun executable; Debian, UP, 2026-11-19).
  `claude -p hi` with an invalid key: 4.6 G instructions in 23.6 s, 76%
  compiled, 22.7% interpreted while counting down, 1.1% tails after
  hand-backs. Host profile of that window: `runOps` 32.8%, `kw_run`'s
  loop 13.5%, compiled code 24.6%, decode 8.9%, block cache and heat
  (`validate`, `lookupSlow`, `noteHot`, `resetNursery`) 5.1%, generic
  and SIMD reference code 3.9%, `jc.enter` and compiles 2.9%, MMU slow
  paths (`translate`, `loadSlow`, `ldSlow`) 2.6%. All 4.9M hand-backs are
  translated ops taking their slow path, none untranslated ops: loads 63%
  (real read-TLB misses; `walks_r` 1549 per M instructions), exclusives
  and LSE 14% (`casa`, `ldar`, `ldadd*`), stores 17%. Generic executions
  are 0.47% of instructions, nearly all in interpreted blocks. 283
  nursery resets; 1.97M of 3.2M decodes re-decode blocks a reset
  discarded. Compiles are cheap: `claude --help` spends about 150 ms of
  its 3.3-3.6 s in the host's compiles (`stats().jit.compileMs`, about 440
  modules of 8 KiB, 0.34 ms each). Two thirds of them are `shortened` (the
  first emit overflowed the 16 KiB buffer), because `candidate()` takes any
  decoded block that is not compiled yet as a region member. Those members
  do run: leaving out the cold ones costs compiled share. The tuning in
  Rejected designs (threshold, ring, `KW_CPU_SIZE`, region members) fixes
  these counters without changing the time: the countdown share comes from
  a flat profile, not from thrashing, and code compiled at the margin runs
  little faster than the interpreter (about 23 instructions per entry).
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

## Next levers (ranked, 2026-11-18)

1. **Cold code in node and Bun**: `runOps` itself (41% of npm's busy host
   time; its code size matters, see Rejected designs) and the `run` loop
   (14%). Left to try: smaller handlers for the frequent kinds, cheaper
   decodes (10%; first decodes of a new process cannot be shared while
   ops hold absolute addresses), tier op kinds for LDAR/STLR/LDXR/STXR
   (1.2M interpreted generic executions per npm command, 9-10M in cowsay).
2. **`run`'s entry path and the region prologue**: about 5% of the
   apk/shell rows each. Lighter prologues need a region-wide "written
   before every exit" analysis (loading only the entered member's
   registers was slower; kwemu.md, Rejected designs).
3. **NZCV materialisation**: about 3%. Carrying lazy state across member
   transfers needs a runtime kind for the checked entry's stop path.
4. **FMADD inline**: needs fparith's emulated FMA inline (no wasm FMA);
   worth at most about 2% of the gzip row.
5. **Interpreter per-op cost on cold code**: `runOps` runs about 6.5 ns
   per op on Claude Code against 3.4 ns on the hot benches, and `kw_run`
   costs about 13 ns per block (`lookupIn`, `ready`, the `runOps` call,
   refunds, the irq poll). Untested: whether that is dispatch mispredicts
   or data misses on the 16-byte ops and the block table (`perf stat` of
   `--no-jit --help` on the host; needs `kernel.perf_event_paranoid` 2 or
   lower). Misses would point to denser ops.

The shared-core levers (bigger regions, self-loop exits, threshold) are in
kwemu.md, Next steps.

## Rejected designs (A64)

Do not retry without a new reason. Dates 2026-11-17/18; UP bundle, boots
interleaved.

| Idea | Result |
| --- | --- |
| `runOps` inlined into `run` | wasm64: sieve +13%, mem +5%, but sha -9%, interp -7%; a separate function running self-loop passes gets the gains without the losses |
| An op that does not continue handled inside `runOps`' `inline else` body | every leaving kind had its own copy; handling it once after the `switch` made cold code faster (npm 4.23 to 3.91 s, the 20 apk/shell rows 22.75 to 22.18 s) |
| Self-loop pass count as `left / ninsn` per entry | a 64-bit division per entry: sha, interp, fib -6..-9%; `runOps` subtracts per pass |
| Error unions from non-inlined slow paths inside `runOps` | each result slot is a shadow-stack frame slot set up on every call (~50 wasm instructions); plain integer results: mem +7%, interp +4% |
| No cross-CPU invalidation | kwtest's cross-CPU rewrite check ran 751695 of 877496 calls stale (a64/tier.md, Coherence) |
| JIT threshold 2^15 or 2^13 | 2^15 within noise; 2^13 apk rows 5-25% slower: extra compiles (~0.3 ms each) cost more than they move into compiled code. With countdowns kept across resets 2^15 made npm 5.93 against 4.86 s. Claude Code `--help` (2026-11-19): 2^16 3.7-4.0 s and 2^15 4.2-4.4 s against 3.3-3.4 (compiled 62% and 67% against 54.5%; 2-4x the compiles, and the 64K ring then drops 2-5.6K compiled blocks) |
| Region members only with a quarter of the threshold counted (a heat test in `jc.candidate`), alone or at threshold 2^16; `region_max` 8 | Claude Code `--help`, 8 rounds (2026-11-19): 3.55, 3.68 and 3.57 s against 3.56. Alone: `shortened` 292 to 75 and members 2059 to 1556, but compiled share 54.5% to 49.8% (the cold members did run). At 2^16: 61.8% compiled, 898 compiles, compile time 148 to 264 ms |
| V8 without Liftoff (`node --no-liftoff`) | Claude Code `--help` 4.7 against 3.3 s, about 3.5 ms more per extra compile (2026-11-19) |
| A heat table keyed by host address (short countdown for code compiled before, also in an earlier process) | compiled share +2..+8 points on apk, but twice the compiles; time equal at best, worse with shorter countdowns; remembering counting blocks too thrashed the table |
| Countdowns kept across arena resets with alternating-way replacement | npm 6.04 against 5.22 s: conflict evictions lost progress and evicted members failed checked entries; replacing the way with less progress fixed it |
| A tenured part that frees every module when full | short apk commands 10-15% slower (~450 modules freed per command) |
| A 128K-op tenured ring (nursery 256K) | npm 5.17 against 4.86 s, npx 4.69 against 4.41; apk within noise. Claude Code `--help` 3.5-3.6 against 3.3-3.4 s (no compiled block dropped, but 39 nursery resets against 27; 2026-11-19) |
| `jc.enter` inlined into `run` | within noise |
| Exec TLB of 1024 sets instead of 256 | npm exec-TLB walks 160K to 30K and revalidations 1.3M to 0.5M per command, time within noise: a revalidation is cheap |
| `KW_CPU_SIZE` 16 MiB (64K blocks, 704K-op nursery; an ABI change) | npm decodes 880K to 565K, compiled share unchanged; `node -e 0` slower (host cache misses), npm within noise. Most decodes left are first decodes of a new process, which no size removes. Claude Code `--help` (2026-11-19, 4 rounds): a 576K nursery, a 512K nursery with a 128K ring, that plus threshold 2^16 (66% compiled), and that plus 32K block sets all ran 3.25-3.54 s against 3.26-3.37. Nursery resets fell from 27 to 11-13, decodes by 23%, ring drops to 0, but decode is only 9% of the time and a bigger CPU block costs host cache misses |
| Chaining interpreted blocks inside `runOps` | the `run` loop is 12% of npm's host time, but every node row got 2-4% slower: the chain code in each branch kind costs more than the returns it saves |
| NZCV of hand-back paths through module helper functions | materialisation fell from 31% to 20% of module bytes, but regions took more members up to the buffer: module bytes unchanged, compile time +9%, time within noise |
