# kwemu: MMU, block cache and JIT core

kwemu is the guest CPU, linked into the kernel. The CPU itself is AArch64
(`src/a64`, a64.md: decode, semantics, the decoded-op tier, the A64 JIT
emitter, the C ABI). This file covers what lies under it and is
ISA-neutral: `struct kw_cpu` and the Sv39 walker and TLBs
(`src/emu/kwemu.zig`), the block cache the tier plugs into
(`Cpu.lookupIn` with the ISA's block hooks), the JIT core
(`src/emu/jitcore.zig`, `Jit(I)` with the ISA's emit hooks), the shared
types and AES/carry-less primitives (`src/cpu/core.zig`) and the softfloat
(`src/cpu/fpu.zig`). It has the design, the invariants the tests guard,
the numbers that drove decisions and the designs that were tried and
rejected. Many of those measurements were taken with the riscv64 guest
CPU that kwemu had before A64 (its code is in git history); they are
kept where the machinery they concern is unchanged, and marked
"riscv64 guest".

## Sources and outputs

| Path | What |
| --- | --- |
| `src/libkwemu.zig` | library root: exports the A64 C ABI (`src/a64/run.zig`) |
| `src/emu/kwemu.zig` | `Cpu` (struct kw_cpu), Sv39 walker and TLBs, the block cache (lookup, validation, code tracking, op arena; generic over the ISA's block hooks), `kw_debug_cpu_of_jit_buf` |
| `src/emu/jitcore.zig` | JIT tier, ISA-neutral: slot pool, host imports, compile policy, `install` and its emit retries, module skeleton, regions, the compile window, the `Emit` helpers, statistics (`Jx`); `Jit(I)` takes the ISA's hooks (A64: `src/a64/jit/emit.zig`) |
| `src/cpu/core.zig` | `Hart` (traps, exclusive monitor), `Kind`, `Access`, `Error`, `Exit`, `smp`; AES tables and column mixes (`aes`), carry-less multiply (`bitmanip`) |
| `src/cpu/fpu.zig` | exact softfloat for all rounding modes and flags, host-float fast paths for RNE; its unit tests run in `zig build test` |
| `src/emu/harness*.zig` | test "kernel" using only the C ABI (native and wasm64; A64 ELFs) |
| `test/kwemu-unit-wasm.mjs` | runs a wasm64 unit-test module against an eager JIT host (`zig build test`, `--name a64`) |
| `test/kwemu-jit-host.mjs` | JS host of the JIT imports, for tests and benchmarks |
| `test/kwemu-bench.mjs` | A64 benchmark table (`--ref`, `--median --reps N`, `--wasm-only`; a64.md, Numbers) |

`zig build` writes `zig-out/lib/{kwemu.o,libkwemu.a}` (wasm64, cpu `mvp` +
memory64 only, undefined `__stack_pointer`), `zig-out/lib/kwemu-jit.o`,
`zig-out/lib/native/libkwemu.a`, `zig-out/bin/kwemu-harness{,.wasm}` and
`kwemu-harness-jit.wasm` (the latter with the JIT tier; `test/a64-test.mjs`
runs it) and the A64 tools and guests (a64.md).

Build options: `-Dkwemu-jit` (off for plain `zig build`; kernel/build.sh
turns it on), `-Dkwemu-jit-threshold` (2^17), `-Dkwemu-jit-grow` (8192
exits per KiB of module, 0 = never; see Regions), `-Dkwemu-stats`
(counters, the `kw_debug_stats` export, harness and CLI `--stats`;
`kernel/build.sh stats` builds a kernel and bundle with it),
`-Dkwemu-atomics` (a shared-memory kernel, below), `-Dlib-optimize`
(ReleaseFast) and `-Doptimize` (native library and harness). A64 only
(a64.md, Decoded-op tier): `-Dkwemu-a64-ref` (kw_run is the reference
loop), `-Dkwemu-a64-fuzz=N` and `-Dkwemu-a64-fuzz-seed` (the block fuzz in
`zig build test`).

## Interpreter

The machinery every interpreted instruction goes through; what an op is
and how a block is shaped is the ISA's (a64.md, Decoded-op tier).

- **Ops.** The op arena is an array of 16-byte slots (`kwemu.Slot`); the
  ISA views it as its own op type (`Cpu.opArena`). One guest instruction
  is one op, so an op index is a count of retired instructions, and
  anything the ISA keeps beside the ops (A64: the raw words for
  `validate`) sits after them in further slots. `Stats.op_hist` and
  `JitStats.hb` have room for `kwemu.max_ops` (192) op kinds
  (harness.zig reads that layout). Every kind costs dispatch code, so
  variants of one operation share a kind, with the variant in a field
  where that needs no branch.
- **Superblocks.** A block holds up to 64 instructions inside one page, in
  execution order: conditional branches are side exits and direct
  branches inside the page are followed. A branch back to the block's own
  start ends it, and such a self-loop re-enters without a lookup. A
  block never depends on a second page.
- **Lookup.** A 2-way table of 32K blocks keyed by virtual pc, set
  `((pc >> 1) ^ (pc >> 15)) & 16383`. The fast path is two compares: pc,
  and `tgen` against the generation of either entry of pc's exec-TLB set.
  The exec TLB is 2-way (256 sets), and every fill gets a fresh 64-bit
  generation. Both the 2-way exec TLB and that set hash are needed: a
  1-way exec TLB (busybox and musl pages under ASLR) or a `pc >> 16` hash
  (pc and `pc ^ 0x8000` collide) made an ash loop vary between 3 and 5 s
  (riscv64 guest).
- **Coherence.** A block is trusted only under the generation it was
  validated with. Flushes, `kw_set_pgd` and the guest's instruction-cache
  invalidation (A64 IC IVAU, `Cpu.icInvalidate`) retire generations. A
  stale block is revalidated (same pc, same host address, same raw bits)
  or re-decoded. Guest stores are tracked exactly: pages holding code sit
  in a hashed filter with a 64-byte-chunk bitmap, and their write-TLB
  entries carry `code_flag`, which sends stores to the slow path. A
  filter slot two pages share is wild and marks every page hashing to it;
  the write TLB is scanned only when a slot changes state (a64.md, The
  op arena). A store into a marked chunk retires the page's generations
  and ends the current block, so self-modifying code takes effect at the
  next instruction. Code changed by another CPU: a64.md, Coherence and
  several CPUs.
- **Several CPUs** (an SMP kernel, kernel.md, SMP): each CPU has its own
  `struct kw_cpu` on one shared memory, and code tracking is per
  `kw_cpu`. Built with `-Dkwemu-atomics` (`core.smp`), exclusives and LSE
  atomics are wasm atomics (a load-exclusive is an atomic load whose
  value the store-exclusive compare-and-swaps against: an ABA store in
  between goes unnoticed, as in QEMU), everything is seq_cst, and a
  barrier is a seq_cst read-modify-write of `Hart.fence_word`, a locked
  instruction on x86-64 V8 (about 4.3 ns over the plain op, against
  8.9 ns for `atomic.fence`, an mfence; an atomic load costs nothing
  extra. Node 24, i7-10700K, 2026-11-16, a loop of each on a shared
  memory). Without the option everything assumes one CPU. The JIT runs
  on every CPU (JIT on several CPUs, below).
- **Precise state.** Ops update `kw_regs` directly. On a fault mid-block,
  pc is recomputed from the ops (`pcAt`) and the budget is refunded.
  `icount` and the budget are exact, because a block that does not fit
  the remaining budget is single-stepped. `*irq_pending` is polled at
  every block end. An interpreted self-loop that an interrupt ends still
  counts its passes towards the compile threshold (`loopDone`): under a
  stream of IPIs (a thread flushing TLBs on another CPU) a hot loop
  otherwise never got compiled.
- **Memory fast path.** One compare per access: the TLB entry holds
  `tag = vpn` and `add = host - va`, and the tag is compared against the
  vpn of the access's last byte, so page-straddling accesses fall into the
  slow path for free. This is still about 15 wasm instructions per access.
  The read and write TLBs are direct-mapped with 1024 entries each
  (32 KiB together). Against 256 entries (riscv64 guest, 2026-11-15, Node
  24.22.1, 16-core host, medians of 15 runs over 5 interleaved boots):
  `apk --no-network info tree` 2.76 vs 2.85 s, `seq 100000 | sort -r`
  2.89 vs 2.98 s, `seq 250000 | gzip | gunzip` 2.96 vs 3.03 s, an ash
  counting loop 2.97 vs 3.01 s.
- **Cache.** 32K block slots, 384K op slots (6 MiB of the 8 MiB
  `KW_CPU_SIZE`), a 4096-entry code-page filter. The op arena has two
  parts: a nursery (320K slots) where blocks are decoded, and a tenured
  ring (64K) where a block's ops are copied when it is compiled. When the
  nursery fills, only its ops are discarded: blocks keep their table entry
  with pc, host and compile countdown (`op_gone`), and a re-decode of the
  same pc and host goes on counting where it was; compiled code keeps
  running. The ring makes room by dropping its oldest blocks (and their
  code). Tenured ops are numbered on for good (the ring position is the
  number modulo its size), so a module's member check (`blocks[m].op`)
  never mistakes a later copy for the one it was emitted from. The block
  table replaces the way with less countdown progress (compiled counts as
  most); the way that stays loses half its progress. Only kw_cpu_init,
  kw_set_isa and kw_host_reset drop everything. Measured on the A64 image
  (a64.md, The op arena): node's working set is larger than the arena
  (84% of it still live at a nursery reset), so keeping countdowns and
  code is what pays. A 16 or 32 MiB `KW_CPU_SIZE` was no faster (riscv64
  guest, before the split), and 32 MiB does not boot with 48 or 64 MiB of
  guest memory. The block table cannot grow past 64K entries: region
  members are u16 block indexes.
- **FP** (`fpu.zig`). All five rounding modes and flags are exact. RNE
  uses host-float fast paths with exact inexact detection. f64 FMA uses
  Boldo & Melquiond's emulated FMA (Dekker product, TwoSum, round to odd),
  checked against the integer path on more than 2M random and
  near-cancellation cases. A64's rules (NaN propagation, tininess before
  rounding, FPCR) are applied on top in `src/a64/fparith.zig`.
- **Dispatch** is one central `while (true) switch` over the op kinds (A64:
  `opexec.runOps`), a loop over a single `br_table`. Keep it that way: a
  threaded `switch` (`continue :sw`) makes LLVM give every handler its own
  `br_table` over all kinds, the run loop about 7x larger, and node's cold
  startup code much slower (Rejected designs). V8 pays most for
  mispredicts and code size on code that does not repeat: 16 hot
  functions run at 3.3 ns per instruction, 256 to 4K distinct functions in
  random order at 6.7-8.7 ns. Op-cache misses are not the cause: 4K
  functions sharing one op sequence run at hot speed.

## JIT tier

**Scope.** A decoded block (not raw instructions) is translated into one
wasm function. Hot blocks that branch to each other share one module (a
region, below), also across pages. What the ISA translates is its own
(a64.md, JIT); an op it does not translate ends the compiled prefix: the
code hands that op back and the interpreter finishes the pass. A block
whose first op is not translated is never compiled.

**Generated code.** `f(x, cpu, irqp, jl: i64) -> i64`, where `x` =
`&regs.x` (x[32] is pc in struct kw_regs). Guest registers live in wasm
locals, loaded on entry and written back at a single exit. Loads and
stores inline the data-TLB fast path on the same `tlb_r`/`tlb_w` arrays.
A miss hands the op back before it executes, which covers faults,
straddles and stores into code pages (`code_flag`), so SMC detection is
unchanged. A self-loop becomes a wasm `loop` that polls `*irqp` and
checks `jl` at each back edge. The result is `(jl_left << 8) | code`:
0..63 = handed back before op k, 64..127 = done (terminator retired, or a
stop), 128+k = side exit at op k. The code depends only on pc, the ops,
cpu-relative offsets and block-table positions, never on host addresses
or generations. So a revalidated block keeps its code, and a re-decoded
one (new bytes, a COW copy at a new host address, a cache reset) frees
it. Emitted modules use MVP instructions plus memory64 for a 64-bit
memory, and fixed-width SIMD only when the host offers it (`cap_simd`),
so they load on every engine the page supports.

**When.** A block is compiled after it has retired 2^17 interpreted
instructions, counted per entry and per self-loop pass. The countdown
lives in the block's state word, so a block that is never compiled costs
one load per entry. Eager mode (caps bit 2) compiles on first entry, for
tests. Compiling everything eagerly is much slower for short programs
(riscv64 guest: a short test program 13 vs 110 MIPS), which is why there
is a threshold.

**Slots.** kwemu owns 1024 stub functions in the function table: no table
growth and no allocator. A stub returns "handed back at op 0", so an empty
slot is harmless. When all slots are in use, a clock (second chance) evicts
one. Slots are freed only from `run` between entries (block lookup and
decode, `resetCache`, `compile`), never from inside compiled code.
`kw_cpu_init` forgets slots without freeing them, so a host must accept a
compile into a slot that is already installed. `kw_host_reset` (a restored
snapshot, where the table is a new instance's and holds the stubs again)
forgets them the same way, sets every block's `jx` back to `never`
(re-decoding a block that still named a slot would free that slot on a
host that never compiled it), asks `kw_host_jit_caps` again and resets the
cache.

**Emit buffer.** Modules are emitted into a 16 KiB buffer inside
`struct kw_cpu`. A module that does not fit is emitted again with less in
it: fewer region members (the ones found last are dropped and the region
is closed), then a shorter prefix of the hot block (3/4 of the ops each
time). Every retry is strictly smaller, and a module that overflowed is
never handed to the host. `struct kw_cpu` has about 28 KiB left below
`KW_CPU_SIZE` with the JIT (`members` and `member_op` take 64 KiB at 16
members; Sizes), so check the headroom before growing JIT tables.

### Regions

A module holds up to 16 decoded blocks (members), on any pages. The body
is a `loop` over a `br_table` with two entries per member: its checked
entry (below), which falls through into the member, and the member itself
(only for the member `run` entered). A member that leaves towards a member
(terminator, side exit, or an indirect branch whose target pc matches a
member's; an indirect branch compares against every member) sets the
index and branches to the loop. Other exits return to `run`. `cpu.jit.cur`
names the member a region left from.

- **Home and guest members.** A block's state word names one region, its
  home (`compiled | member << 16 | pool entry`), and `run` enters the block
  only through that module, at that member. A region may also hold copies
  of blocks whose home is another region (guests). A member's code depends
  only on its decoded ops, so a copy is exact as long as the block holds
  the same decode. `State.members` lists both kinds, `member_op` the low
  16 bits of each member's op index when it was compiled.
- **Membership.** When a block gets hot, `compile` takes it, the members
  (home and guest) of an open region of the same virtual page that has
  room (that region is replaced), then breadth-first the decoded, valid,
  not-yet-compiled blocks reachable through side exits, branch targets
  and call return sites (the ISA's `targets`), on any page. A self-loop
  keeps a module of its own, and that module is closed: as a plain wasm
  loop it is much faster than as a member, and loops over big arrays hand
  back on every data-TLB miss, which is cheap only for a small module. A
  region cut to fit the buffer is closed too, so dropped members do not
  rejoin and push others out, and so is a full one.
- **Growth along exits** (`noteExit`/`noteHot`). After compiled code
  leaves a region (terminator or side exit, not a hand-back), `run` checks
  the block it looks up next. If that block is compiled in another region
  and lies on another page than the region's own, it counts the exit on
  the block (`hits`). After `grow_threshold` such exits per KiB of the
  leaving region's module (`-Dkwemu-jit-grow`, 8192), the block joins that
  region as a guest: the region is emitted again with it and replaces the
  old module. A grown region that does not fit the buffer is not cut: the
  old one stays, closed. Calls into libc and PLT stubs, the returns, and
  functions that span pages then stay in one module. Closed and full
  regions and self-loops are not grown, and targets on the region's own
  page are left to the merge above (Rejected designs).
- **Why the grow threshold is that high.** An exit through `run` costs
  only about 11 ns more than a branch between members (riscv64 guest),
  while a grow compiles the whole region again (a few hundred µs for up
  to 16 KiB). A grow pays only for an edge that will be taken tens of
  thousands of times more. Counting per KiB makes a big region, which
  costs more to recompile, wait longer.
- **Entering a member** (`checkedEntry`). Every branch into another member
  m, from any page, goes through m's checked entry, which tests that m's
  `op` is still the op index it was compiled from (a re-decode takes new
  ops until a cache reset, which frees every module), that m is valid
  under the current exec-TLB fill of its own page (`tgen` equals l_g, the
  `tgen` of the member being run, or else the generation of one of the two
  exec-TLB entries of m's page's set, which is what the lookup checks; l_g
  then becomes m's `tgen`), that `jl` covers all of m, and that `*irqp` is
  0. Then it charges m. An indirect branch to the start of the member
  being run tests only `jl` and `*irqp` and stays in that member's own
  `loop`. If a check fails, it returns "done" with pc = m's start, and
  `run` looks m up (revalidates or re-decodes it). The checks exist once
  per member, and a branch site is 6 bytes (an indirect target 18).
  Inline checks per branch site and target would be 40% of all module
  bytes in apk and close regions early (riscv64 guest, 2026-11-15: 862
  instead of 286 KiB of check bytes per `apk info` run, 54 instead of 26
  regions cut to fit the buffer, at the same speed).
- **Register file.** The prologue loads the union of the registers that
  any member uses (the ISA's `blockUse`), and the single epilogue writes
  back the union of the ones written. ISA state kept in emit-time
  knowledge (A64: lazy NZCV) is made architectural before every branch
  that leaves straight-line code (`sync`).
- **Invalidation.** A re-decoded member loses only its own home state
  (`dropMember`); its copies in other regions fail the op check from then
  on. A region is freed when its last home member goes, when the clock
  evicts it, when it is grown (replaced), or on `resetCache`.

### Invariants (what the tests check)

- Budget and `icount` are exact: `run` charges the entered member in full,
  every further member is charged before it runs and only if `jl` covers
  it, and a side exit refunds the rest of the member it leaves. A budget
  that ends inside a member stops at its start, and `run` single-steps from
  there.
- IRQ latency: every member branch and self-loop pass reads `*irqp`, so it
  is read at most 64 instructions apart, as in `run`.
- Precise state on fault, trap and hand-back: registers are written back at
  the single exit, and `run` continues from op k of the named member (a
  guest member is named like any other).
- A member runs only while it is the decode it was compiled from and valid
  under the current fill of its own page, checked at every branch into it.
  Nothing in compiled code changes the exec TLB, so the check holds until
  the module returns. Flushes, `kw_set_pgd`, IC IVAU, SMC, remaps and
  unmaps of either page of a two-page region stop exactly the branches
  into that page.
- SMC: compiled stores into code pages miss the write TLB and hand back.
  The interpreter's store retires the generations, and any later member
  branch fails its check.
- Flushes, `kw_set_pgd` and IC IVAU only retire generations. Revalidated
  members keep their code, and the tests check that nothing is recompiled.

The A64 tests that check these (the block fuzz, the JIT unit tests, the
guests in every harness mode): a64.md, Tests and JIT, Tests.

### JIT on several CPUs

An SMP kernel (kernel.md, SMP) runs one instance of the module per CPU, in
its own thread, on one shared memory. The JIT is per CPU:

- **Per-CPU code.** Each CPU has its own `struct kw_cpu` (block cache,
  TLBs, slot pool, emit buffer) and its own instance with its own
  `__indirect_function_table`; `kw_cpu_init` on that CPU asks that CPU's
  host for the caps, and `kw_host_jit_compile`/`free` act on that table.
  A `kw_cpu` is used only by its own CPU (the kernel's `wasm_kw_cpu` is the
  running CPU's, and a task that moves starts afresh on the new CPU), so
  a slot or module of one CPU is never reachable from another. A task
  that moves finds a cold cache there and compiles again what is hot.
  Sharing modules between CPUs is not built: it would need a module to
  be instantiated in every CPU's thread (a `WebAssembly.Module` can be
  posted, an instance cannot), a slot installed in every table before
  any CPU enters it, and a free that waits until no CPU runs the module,
  for a gain only where several CPUs run the same hot code.
- **Interrupts.** Compiled code polls the `irqp` it is called with, which
  `enter` takes from the CPU's own `irq_pending` at every call (nothing
  is baked into a module), at every self-loop back edge and member
  entry, as on one CPU. With a shared memory (caps bit 3) the load is
  `i32.atomic.load`: a plain load in a loop that stores nothing may be
  hoisted, and another CPU's IPI (a TLB shootdown waits for the answer)
  would then never be seen. Nothing in compiled code waits for another
  CPU.
- **Compiles do not hold up TLB flushes.** A compile (gathering the
  region, emitting the module, the host's `new WebAssembly.Module`,
  `new Instance`, V8's first-call compile and `table.set`) takes 0.1 to
  0.4 ms of host time, up to a few ms, and the CPU polls no interrupt in
  it. kwemu marks it (kw_emu.h, "jit_busy / flush_all"): `jit_busy` in
  `struct kw_cpu` is 1 from before the region is gathered (`windowOpen`)
  until after the host returns (`windowClose`), and nothing in between
  runs guest code, reads guest memory or walks a page table (only
  `kw_cpu`: decoded ops, exec-TLB generations, the emit buffer, the slot
  tables). A flush (tlb.c `kw_flush_later()`) that finds a target busy
  sets its `flush_all`, `smp_mb()`, and skips it if it still reads
  `jit_busy` (acquire; kwemu's `jit_busy = 1` is a seq_cst store, so the
  user stores made before are visible to the flusher, as `csd_unlock()`
  would make them). kwemu stores 0, then takes `flush_all` with an atomic
  exchange: either the flusher sees the window closed and waits as
  before, or kwemu sees the mark, flushes everything (a range flush
  becomes a full one there) and `run` looks the block up again before it
  runs anything (`Go.again`, also after a grow): the flusher may have
  returned and unmapped or remapped it. V8 compiles a wasm function at
  its first call, which would otherwise come from `run` after the window:
  every module starts with `if (cpu == 0) return 0`, and the host calls
  `f(0, 0, 0, 0)` inside the import (`flags` bit 0), so that compile is in
  the window too. Before it gathers, kwemu looks at its irq word: an
  interrupt already pending (an IPI sent just before the window, whose
  sender now waits) is taken first, and the block compiles at its next
  pass. The 20 ms yield to the host (below) is skipped by flushes the
  same way (kernel.md, SMP, MM). Still waited for: an IPI raised in the
  ~1-2 µs between a flusher's read of `jit_busy` (0) and its IPI, if the
  window opens in between (most of the 50-500 µs waits left under
  constant compiling); IPIs that are not TLB flushes (`membarrier()`,
  other `smp_call_function()` users); a reschedule IPI (a wakeup onto the
  compiling CPU starts after the compile); frees (`table.set`, a few µs,
  outside the window). Measured: Numbers, Compile stalls.
- **Flushes** retire generations on each CPU, as on one CPU: the kernel
  sends `flush_tlb_*()` to every CPU that has the mm loaded and waits,
  marks a CPU in lazy TLB mode (or yielding to its host) stale (it
  flushes everything when it takes the mm again, before any user code),
  and does the same for a CPU that is compiling (above). A flushed CPU
  revalidates each block before it runs it again (same pc, host address
  and raw bits), and a block that was rewritten or moved to another page
  is decoded again and its code freed (`drop`). Code another CPU's guest
  changed is seen after IC IVAU on any CPU (the code epoch, a64.md,
  Coherence and several CPUs). Safety holds regardless of timing: decoded
  blocks and compiled code hold no host addresses (compiled code reaches
  guest memory only through this CPU's data TLB, filled from the current
  page table), so stale code only runs old guest instructions with
  current translations.
- **Atomics** in compiled code are the ISA's (a64.md, Exclusives and
  atomics in compiled code); the exclusive monitor lives in the CPU's
  `Hart` (cleared at every entry to user mode by the kernel), never in a
  module.
- **Task switches.** Compiled code writes the registers back at its
  single exit and returns to `run` before the kernel can run, so a task's
  state is in `kw_regs` whenever it can be switched out or moved;
  `jit.cur` is scratch for one call.
- **Host.** Each CPU's thread has its own `JitHost` (js.md, CPU
  threads), whose counters CPU 0's host reads; it yields to its event
  loop every 20 ms of user code, without which V8 never finished
  collecting freed modules there.

### Host contract

These imports exist only with `-Dkwemu-jit`. The kernel host is
`js/core/jit.ts`, and the test host is `test/kwemu-jit-host.mjs`.

| Import | |
| --- | --- |
| `kw_host_jit_caps() -> u32` | bit 0 = JIT available (0: never compile), bit 1 = 32-bit memory (lowered kernel: the code imports a 32-bit `env.memory` and wraps addresses), bit 2 = eager, bit 3 = shared memory (the code declares its `env.memory` import shared, with a maximum of 65536 pages for memory32 and 262144 for memory64, and reads `*irqp` with `i32.atomic.load`; the host sets it when the kernel's memory is a SharedArrayBuffer), bit 4 = the host passes the kernel's function table to every module as `env.table`, which a module may import (A64 calls its interpreter for `generic` ops through it; a64.md, Generic ops in compiled code; `jit.ts` always sets it), bit 5 = the engine compiles fixed-width SIMD (`jc.cap_simd`; A64 then keeps V registers in v128 locals and translates AdvSIMD and crypto ops, a64.md, AdvSIMD and crypto in compiled code; `jit.ts` sets it when `WebAssembly.validate` accepts a small SIMD module, which V8 on an x86-64 without SSE4.1 does not; the test host unless `KWEMU_JIT_SIMD=0`). Called once, from `kw_cpu_init`, by each CPU on its own host. |
| `kw_host_jit_compile(ptr, len, slot, flags) -> i32` | Compile the module at `ptr` (it imports `env.memory`, with caps bit 4 maybe `env.table`, and exports `f`) synchronously with `new WebAssembly.Module` and `table.set` its `f` into `slot` (a BigInt index for table64). 0 = installed, < 0 = failed (slot untouched, and that block is never compiled). `flags` bit 0: `f` called with `cpu` = 0 returns 0 at once (every module starts with that test), and `jit.ts` calls `f(0, 0, 0, 0)` once so that V8 compiles it there, inside kwemu's compile window (JIT on several CPUs). |
| `kw_host_jit_free(slot)` | Put back the stub that was there before the first compile, and drop the module. |

kwemu's 1024 stubs are the last 1024 entries of the kernel's exported
`__indirect_function_table`, distinct in `vmlinux` and after the Binaryen
lowering. Check that again if you change link flags or Binaryen passes.
`jit.ts` installs only into existing non-null slots, restores only slots it
installed, never throws into the kernel, and counts compiles, frees,
failures, bytes and time (`stats().jit`, CLI `--stats`, page
`KW.jitStats()`).

**Collecting freed modules.** Engines collect a freed module only when
their GC runs, and a module costs more memory than the GC is told about.
JavaScriptCore counts the kernel's wasm memory in its heap size, so with
512 MiB of RAM it waits for about 3 GB of further allocation before
collecting. V8 in Chromium collects for an allocation only about as large
as the external memory it already holds (which includes the kernel's
memory); Node collects for 64 MiB at any memory size. So `jit.ts` tracks
modules with a FinalizationRegistry. While 256 or more freed modules are
uncollected (`RETAINED_NUDGE`), it allocates and detaches an ArrayBuffer
on every compile (not on a free: a free is outside kwemu's compile window,
and an allocation there can start a collection that delays the CPU's
answer to an IPI). The nudge starts at 64 MiB, doubles up to
4 GiB whenever nudges have seen no collection for 250 ms, and halves when
an allocation fails. At 2048 uncollected (`RETAINED_LIMIT`) it refuses
compiles, and kwemu interprets those blocks. Measured 2026-11-13: a
14,000-module WebKit session stays at most ~620 uncollected with no
refusals but grows by about 50 MiB (unexplained); a Chromium page that
only compiles and frees stays below 700. With a 2 GiB memory Chromium
refuses a large enough nudge, so such a page can still refuse compiles
for a few seconds until V8 collects on its own. Counters: `collected`,
`retained`, `maxRetained`, `gcNudges`, `refused`.

**Compile cost, and why it stays on the kernel's thread** (riscv64 guest,
2026-11-14, 1644 real modules from an Alpine boot and two `npx
--version`, 6.5 KiB on average, mean µs per module):

| engine | `new Module` | `new Instance` | `table.set` | first call | later calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 24.22.1 | 60 | 12 | 0.7 | 167 | 0.6 |
| Chromium 151 (headless shell 1234) | 80 | 12 | 1 | 261 | 0.8 |
| WebKit 2388 (Safari 27.2) | 145 | 9 | 0.6 | 2 | 0.6 |

V8 compiles lazily: `new Module` only decodes and validates (about 55 µs
fixed + 6 µs/KiB), and the first call compiles with Liftoff on the
calling thread (16 µs + 30 µs/KiB). `WebAssembly.compile` or a worker that
posts the Module leaves that first-call compile where it was; only a
worker that also instantiates on a dummy memory and calls `f` once moves
it. `jit.ts` makes that first call itself, inside `kw_host_jit_compile`
(`f(0, 0, 0, 0)` returns at once), so it is in kwemu's compile window
(JIT on several CPUs) and counted in `compileMs`; the table's first-call
column is from before that. JavaScriptCore compiles in the constructor
(there the extra call costs only the call). TurboFan tier-up already
runs on background threads. Even if compiling were free and instant, a
set of shell commands would gain 2.4% in sum and `npx --version` 4.5%,
and lower thresholds still would not win; an asynchronous install could
also happen only at the browser's 20 ms yields, leaving a hot block
interpreted that long instead of the ~0.25 ms compiling takes (Rejected
designs).

## Numbers

i7-10700K, Node 24.22. Single runs on a busy machine vary by up to 20%,
and the first command after boot varies most (V8 is still optimising the
kernel), so compare interleaved medians only and give machine, date and
command with any number. A64's numbers are in a64.md (Numbers, JIT
Numbers and the dated sections after them).

**Measuring.** strace and gdb hang in the guest (no regsets) and there
are no perf events. `kernel/build.sh stats` builds a `-Dkwemu-stats`
bundle; the CLI's `--stats` prints its counters for the whole run at exit
(`JitHost.kwemuStats()`, `stats().kwemu`). For a window inside a run, a
host driver calls the exported `kw_debug_stats` at markers the guest
prints. Either finds the cpu through the stats-only export
`kw_debug_cpu_of_jit_buf(ptr)`, where `ptr` is what `kw_host_jit_compile`
receives; `icount` is at offset 32. The exit counters (`[kwemu-exits]`
and `[kwemu-jx]` in the CLI's output, indices in `jc.Jx`): every entry
ends as a hand-back, a side exit (`exit_side`, of which
`exit_side_region` are side exits of region members), a direct or
indirect terminator, or a stop (`exit_stop`: budget, interrupt or a
failed checked entry, at a block's start); compiled code tells `run`
which through the done codes (`code_done_side`, `code_done_stop`), at no
cost to other builds. `next_by` crosses that reason with the class of
the block run next (`jc.Nx`: the same block, never compiled, not compiled
yet, the same region, a self-loop module, another region that could still
grow or one that is full).

**SMP with the JIT** (riscv64 guest, 2026-11-16, Node 24.22.1, 16-core
host, lowered kernels; kernel.md, SMP). kwbench and an Alpine shell per
config in a random order per round, 12 rounds, medians [IQR]; "UP" is the
UP build, "SMP 1" the SMP build on one CPU:

| metric | UP | SMP 1 | SMP 2 | SMP 4 |
| --- | ---: | ---: | ---: | ---: |
| int loop, MIPS | 4087 [4020-4120] | 4002 [3980-4030] | 4006 [3950-4020] | 4016 [3980-4060] |
| mem loop, MB/s | 2382 [2300-2430] | 2204 [2120-2220] | 2135 [2090-2170] | 2185 [2130-2210] |
| fp loop, Miter/s | 55.4 [55.1-55.6] | 55.3 [53.9-55.4] | 55.0 [54.6-55.2] | 55.2 [55.0-55.3] |
| getppid, µs | 0.13 | 0.13 | 0.13 | 0.13 |
| clock_gettime, ns | 349 [338-374] | 416 [403-425] | 436 [429-451] | 439 [423-449] |
| fork+exit+wait, ms | 0.13 | 0.19 | 0.23 | 0.25 |
| spin loop, 1 thread, s | 1.097 | 1.159 | 1.157 | 1.151 |
| spin loop, N threads (N = CPUs), s | | | 1.161 | 1.173 |
| `kwjob 1`, s | 13.42 | 13.84 | 13.96 | 13.47 |
| `kwjob N` (N = CPUs), s | | | 14.38 | 14.15 |

Compiled code costs the same on every CPU count (int and fp within the
IQRs; mem -7% on the SMP build, from its atomics). The kernel-side costs
(clock, fork) are the SMP build's, as with the interpreter (kernel.md,
Costs). Parallel compiled loops scale linearly: N threads of the spin loop
(`kwpar`, 400M iterations each) take as long as one, 1.99x on 2 CPUs and
3.93x on 4. `kwjob N` (N parallel copies of gzip -6, bzip2 -1 and an awk
sqrt loop over an 8 MiB tar, digests identical in every run and with
`--no-jit`) is 1.94x on 2 CPUs and 3.81x on 4.

- **IPI answers** (`kwipi`, scratch tool in `vendor/smp-deferred/tools`:
  CPU 0 mprotects a touched page of the mm back and forth for 15 s, each
  call a shootdown that waits for CPU 1): with CPU 1 in a compiled
  self-loop the call takes p50 1.8 µs, p99 3.3, p99.99 74 (interpreted
  2.0 / 3.8 / 210; CPU 1 making getppid calls 1.9 / 3.8 / 64; CPU 1 idle
  and not waited for, lazy TLB, 1.3 / 2.4 / 60). Single calls of about
  1 ms in every mode are the host's scheduling.
- **Compile stalls** (riscv64 guest, 2026-11-17, Node 24.22.1, 16-core
  host shared with other builds, load average 4-7 unless said; lowered
  kernels; "before" is the tree without the compile window, kernel and
  host; JIT on several CPUs describes the design). Where the time goes,
  from a host trace of CPU 1 compiling all the time (kwipi `churn`: 8192
  generated functions called in turn, each just past the threshold): `new
  Module` 0.10 ms, `new Instance` 0.02, V8's first-call compile 0.27 (p99
  0.7), `table.set` 3 µs, a free 1.4 µs (up to 0.4 ms when it nudged the
  collector), and kwemu's own gathering and emitting about as much again
  before the host call. The 20 ms yield took a median 32 µs but up to
  19 ms (V8's finalizers and collections of freed modules); every
  shootdown that waited over 1 ms overlapped such a yield. kwipi `churn`
  on 2 CPUs, 20 s, 4 interleaved boots each, medians (time of one
  `mprotect()` that shoots down CPU 1's TLB):

  | | before | after | after, no first call in the host | window, but flushes still wait |
  | --- | ---: | ---: | ---: | ---: |
  | mprotects in 20 s | 5.53 M | 7.07 M | 6.29 M | 5.04 M |
  | p50 / p99, µs | 2.0 / 5.1 | 2.0 / 4.1 | 2.2 / 5.4 | 2.3 / 6.4 |
  | p99.9 / p99.99, µs | 130 / 350 | 13 / 230 | 47 / 220 | 120 / 330 |
  | max, ms | 20.0 | 3.9 | 16.5 | 20.5 |
  | calls over 1 ms | 194 | 3 | 5 | 193 |

  (the last two columns come from a kernel with a switch for the skip and
  counters; in the third, 9.5% of the CPUs to answer were skipped as
  compiling and 4.5% as yielding). Beside 16 host spinners (load 15-17, 2
  boots each): p99.9 310 to 130 µs, max 52 to 22 ms, calls over 1 ms
  1561 to 970, 2.47 M to 3.51 M mprotects. Kwipi's `spin` mode (no
  compiles) is unchanged (p99.9 11 µs, max 0.5-0.7 ms). Real workloads
  compile far less: a node set (3 × `node -e`, `npx --version`, a CPU
  loop and 4 worker threads) compiles about 3600 modules and makes about
  12,800 shootdowns on 2 CPUs (10,500 CPUs to answer, of which 1-2% were
  compiling); the time flushes spent waiting fell from 145 to 18 ms on 2
  CPUs and from 206 to 46 ms on 4, and the longest wait from 14.7 to
  0.8 ms (2 CPUs).
- **Cost of the window** (same dates and host, interleaved medians).
  Compile counts are unchanged; `compileMs` rises about 2.6x because it
  now holds V8's first-call compile, which was spent in the first call
  before. kwbench and shell and node sets on UP, 2 and 4 CPUs stayed
  within their noise (the `cpu == 0` test at every entry costs nothing
  measurable). kwstorm + kwmmstress (120 s) and kwtlb (60 s) on 4 CPUs
  with the JIT: no errors, and each secondary still collects what it frees
  (about 1500-1750 compiles per CPU, at most 2 uncollected at the end).
- **Host memory** (peak RSS of the CLI process after `kwjob N` on N CPUs,
  JIT vs `--no-jit`): 1 CPU 244 vs 193 MiB, 2 CPUs 365 vs 300, 4 CPUs 457
  vs 394. A CPU's thread costs about 100 MiB with or without the JIT;
  per-CPU modules add little, since each CPU keeps at most 1024.

**Sizes** (2026-11-18). `struct kw_cpu` with the JIT leaves 28,240
bytes of `KW_CPU_SIZE` spare (the JIT's `jc.State` is 100,992 bytes,
and every block carries an 8-byte `jx`). The wasm64 JIT object
`zig-out/lib/kwemu-jit.o` is about 600 KB.

## Rejected designs

Measured under V8 (Node 24), on the riscv64 guest unless dated later; the
machinery they concern is the same for A64 (a64.md has A64's own). Do not
retry these without a new reason.

| Idea | Result |
| --- | --- |
| Threaded dispatch (`continue :sw` per handler) | a `br_table` per handler, the run loop 7x larger, `kwemu.o` 528 vs 363 KB; `npx --version` 6.14 vs 3.66 s with `--no-jit` |
| Tail-call dispatch (`return_call_indirect` chain) | about 2x slower (138 vs 252 MIPS) |
| Fusing common op pairs (top 32 of `npx`) | no gain (3.65 vs 3.66 s) |
| Multiplicative block-set hash | fixes collisions, but costs the interpreter 3-7% |
| ReleaseSmall for libkwemu | about 5% slower than ReleaseFast |
| Calling the next compiled block from compiled code (`call_indirect`) | almost no gain: each hop still writes back and reloads registers |
| Re-entering the next compiled block straight from `run` | no gain on top of regions |
| Region "light entry" (load only the entered member's registers) | slower everywhere (ash 2.55 to 3.51 s) |
| Self-loops as region members | much slower (sieve+fib 1150 vs 1880 MIPS) |
| Caching modules by content | only 4% of modules repeat |
| Growing regions with a fixed threshold (64-1024 exits per target) | `yes` 30-35% faster, ash 4-9% slower, `md5sum` × 8 +40% (each grow recompiles the whole region) |
| Growing towards targets on the region's own page | ash 2.81 vs 2.65 s |
| Cutting a grown region to fit the buffer | dropped members ran interpreted again: ash compiled 50% instead of 88% |
| Growing only regions of up to 8 members | `yes` 4.45 vs 3.51 s, ash no better |
| Growing only towards a target with a quarter of the region's exits | ash no better |
| Cross-page members only from the breadth-first search, no growth | `yes` 5.90 vs 5.49 s (hot libc callees are already compiled elsewhere) |
| Compiling JIT modules off the kernel's thread | at most 2.4% (shell) / 4.5% (npx) even if free; see Host contract |
| A fixed JIT threshold of 2^19 | npx at parity with `--no-jit`, but kwbench mem -18%, `md5sum` × 8 +60% |
| Per-site data-TLB page cache in self-loop modules (tag + addend in locals, up to 8 sites) | slower (2026-11-14, kwbench mem loop 2623 vs 3054 MB/s, aes-256-cbc 71.9 vs 74.9 MB/s): the TLB loads are L1 hits, and the extra loop-carried locals cost more |
| 32-member regions and a 32 KiB emit buffer, with checked entries (2026-11-15) | apk entries 42.3M to 40.2M, indirect-branch exits -13%, but apk 3.05 vs 2.88 s: bigger modules cost more per entry (prologue and epilogue over the union of registers) and per recompile |
| Grow threshold 1024 per KiB, with checked entries (2026-11-15) | apk entries -7%, PLT exits 4.9M to 3.5M, a quarter to a third more compiles per run; time 2.85 vs 2.88 s (noise). With 32 members too: entries -14%, indirect exits 9.4M, slower |
| Four AES T-tables instead of one table plus `i32.rotl` (AesTab +6 KiB) | aes-256-cbc 8 KiB +3.6% (78.8 vs 76.1 MB/s), aes-256-gcm and curl unchanged (2026-11-14); below the 4% bar for an AesTab change |
| SMP compile stalls: taking a pending interrupt right after the compile, before the block runs (2026-11-17) | the JIT then takes an interrupt that a guest store raised earlier than the interpreter does (fuzz seed 100675: 7 instructions earlier), so the two diverge; kwemu looks at the irq word before the compile instead |
| SMP compile stalls: the host's first call of a new module made to trap (out-of-bounds `x`, `cpu` and `irqp`) instead of a `cpu == 0` test in every module (2026-11-17) | a wasm trap costs 33-43 µs in a CPU's thread (5-6 µs in a small test process, also on a JSPI stack; cause not found), against one compare per entry |
| SMP compile stalls: compiling asynchronously (`WebAssembly.compile`, or a helper worker posting the Module, which could also be shared between CPUs) | a finished Module reaches a CPU's thread only through its event loop, which it runs at the 20 ms yields: a hot block would stay interpreted that long instead of ~0.3 ms; V8's first-call compile stays on the CPU unless the helper also calls `f` on a memory of the same type |
| SMP compile stalls: returning to the kernel between `new Module`, `new Instance` and the first call, to take interrupts there | 0.1, 0.02 and 0.25 ms on average: the first-call compile alone is most of it and cannot be split; for TLB flushes the window covers all of it anyway |

## Next steps

Shared-core levers (A64's own list: a64.md, What is left). Bigger
regions: most exits that remain leave full or closed regions, but more
members need a smaller `members`/`member_op` encoding (or a bigger
`KW_CPU_SIZE`, an ABI change) and a bigger emit buffer; measure the
compile cost (module bytes) with it, since that is what limits growth.
Exits into self-loop modules and back are the other large group: a
self-loop that could also run as a guest member of the region it is left
to would remove both. Node startup: retuning the threshold (an adaptive
scheme that doubles it up to 2^19 while arena resets come less than
2^25 instructions apart gave npx parity on the riscv64 guest), cheaper
modules (declare only the locals used), and cheaper `enter` and region
entries (a smaller register prologue).
