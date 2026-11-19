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

**OpenSSL** (2026-11-18, UP bundle, the image's rebuilt libcrypto, `openssl
speed -evp ALG -bytes 16384 -seconds 2`, MB/s, medians of 3 boots;
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
| JIT threshold 2^15 or 2^13 | 2^15 within noise; 2^13 apk rows 5-25% slower: extra compiles (~0.3 ms each) cost more than they move into compiled code. With countdowns kept across resets 2^15 made npm 5.93 against 4.86 s |
| A heat table keyed by host address (short countdown for code compiled before, also in an earlier process) | compiled share +2..+8 points on apk, but twice the compiles; time equal at best, worse with shorter countdowns; remembering counting blocks too thrashed the table |
| Countdowns kept across arena resets with alternating-way replacement | npm 6.04 against 5.22 s: conflict evictions lost progress and evicted members failed checked entries; replacing the way with less progress fixed it |
| A tenured part that frees every module when full | short apk commands 10-15% slower (~450 modules freed per command) |
| A 128K-op tenured ring (nursery 256K) | npm 5.17 against 4.86 s, npx 4.69 against 4.41; apk within noise |
| `jc.enter` inlined into `run` | within noise |
| Exec TLB of 1024 sets instead of 256 | npm exec-TLB walks 160K to 30K and revalidations 1.3M to 0.5M per command, time within noise: a revalidation is cheap |
| `KW_CPU_SIZE` 16 MiB (64K blocks, 704K-op nursery; an ABI change) | npm decodes 880K to 565K, compiled share unchanged; `node -e 0` slower (host cache misses), npm within noise. Most decodes left are first decodes of a new process, which no size removes |
| Chaining interpreted blocks inside `runOps` | the `run` loop is 12% of npm's host time, but every node row got 2-4% slower: the chain code in each branch kind costs more than the returns it saves |
| NZCV of hand-back paths through module helper functions | materialisation fell from 31% to 20% of module bytes, but regions took more members up to the buffer: module bytes unchanged, compile time +9%, time within noise |
