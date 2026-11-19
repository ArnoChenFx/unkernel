// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! The A64 decoded-op tier behind kw_run (a64.md, "Decoded-op tier"): the
//! block hooks of kwemu.Cpu's block cache (decode, validate), `run`, and
//! code coherence (IC IVAU and the cross-CPU code epoch).
//!
//! A block is up to `max_block` instructions inside one page in execution
//! order: conditional branches (B.cond, CBZ/CBNZ, TBZ/TBNZ) are side exits,
//! B and BL inside the page are followed; it ends at an indirect branch, a
//! branch to another page or back to its own start, SVC/BRK/ISB and
//! unallocated space, or the page end. Its ops sit in the op arena at
//! b.op, followed by the raw words (4 per slot) that `validate` compares.
//! Budget and icount are exact (a block that does not fit the budget is
//! single-stepped through the reference interpreter), faults are precise
//! (pc from `pcAt`, the op had no effect), *irq_pending is polled at every
//! block end.

const std = @import("std");
const builtin = @import("builtin");
const c = @import("common.zig");
const ops = @import("ops.zig");
const opexec = @import("opexec.zig");
const decode = @import("decode.zig");
const branch = @import("branch.zig");
const core = @import("../cpu/core.zig");
const kwemu = @import("../emu/kwemu.zig");
const jc = @import("../emu/jitcore.zig");
const jit = @import("jit/emit.zig");
const Op = ops.Op;
const Cpu = kwemu.Cpu;
const Block = kwemu.Block;
const Regs = c.Regs;

pub const max_block = 64;
const page_mask: u64 = 0xfff;

// ---- block hooks (kwemu.Cpu.lookupIn) ------------------------------------------

/// The hooks kwemu's block cache calls for A64 blocks.
pub const Blocks = struct {
    /// Ops, a trailing goto, and the raw words (4 per slot).
    pub const max_slots = max_block + 1 + max_block / 4;
    pub const LookupError = core.Error || error{Misaligned};

    pub inline fn check(pc: u64) LookupError!void {
        if (pc & 3 != 0) return error.Misaligned;
    }

    /// Same raw words at the same pcs (pc, host address: checked by the caller).
    pub fn validate(cpu: *Cpu, b: *const Block) bool {
        const page = b.host & ~page_mask;
        const arena = cpu.opArena(Op);
        const o = arena[b.op..][0..b.ninsn];
        const raw: [*]const u32 = @ptrCast(arena + b.op + b.n);
        var pc = b.pc;
        for (o, 0..) |op, k| {
            if (Cpu.hostRead(u32, page + (pc & page_mask)) != raw[k]) return false;
            pc = ops.nextPc(op, pc);
        }
        return true;
    }

    pub fn decode(cpu: *Cpu, b: *Block, pc: u64, host: u64) void {
        const start: u32 = @intCast(cpu.priv.ops_used);
        const arena = cpu.opArena(Op);
        const o = arena[start..][0 .. max_block + 1];
        var raw: [max_block]u32 = undefined;
        const page = host & ~page_mask;
        const vpage = pc & ~page_mask;
        var n: usize = 0;
        var cur = pc;
        var end = false;
        var mask: u64 = 0;
        while (n < max_block) {
            const inst = Cpu.hostRead(u32, page + (cur & page_mask));
            var d = ops.decode(inst, cur);
            raw[n] = inst;
            mask |= @as(u64, 1) << @intCast((cur & page_mask) >> 6);
            const next = cur +% 4;
            cur = next;
            end = d.ends;
            // Superblock: keep going past conditional branches (side exits)
            // and direct branches that stay in this page, except towards
            // the block's own start: those end it, so a loop re-enters it
            // without a lookup (see `run`).
            if (end and n + 1 < max_block) {
                if (ops.sideExit(d.op.h)) |hx| {
                    if (d.op.imm != pc) {
                        d.op.h = hx;
                        end = false;
                    }
                } else if (d.op.h == .b or d.op.h == .bl) {
                    const t = d.op.imm;
                    if (t & ~page_mask == vpage and t != pc) {
                        if (d.op.h == .bl) {
                            const link = (next -% vpage); // 4..4096: may be the next page
                            d.op = .{ .h = .bl_f, .d = @truncate(link), .e = @truncate(link >> 8), .imm = t };
                        } else d.op = .{ .h = .b_f, .imm = t };
                        cur = t;
                        end = false;
                    }
                }
            }
            o[n] = d.op;
            n += 1;
            if (end or cur & page_mask == 0 or cur & ~page_mask != vpage) break;
        }
        const ninsn = n;
        if (!end or o[n - 1].h == .generic) {
            o[n] = .{ .h = .goto, .imm = cur };
            n += 1;
        }
        // Volatile: a plain copy loop becomes a memcpy call (an import).
        const words: [*]volatile u32 = @ptrCast(arena + start + n);
        for (0..ninsn) |k| words[k] = raw[k];
        cpu.priv.ops_used += n + (ninsn + 3) / 4;
        b.* = .{
            .pc = pc,
            .tgen = 0,
            .host = host,
            .end_pc = cur,
            .op = start,
            .n = @intCast(n),
            .ninsn = @intCast(ninsn),
            .mask = mask,
        };
    }
};

/// pc of the op `k` instructions into block `b`.
pub fn pcAt(cpu: *Cpu, b: *const Block, k: usize) u64 {
    var pc = b.pc;
    for (cpu.opArena(Op)[b.op..][0..k]) |o| pc = ops.nextPc(o, pc);
    return pc;
}

// ---- code coherence ------------------------------------------------------------
//
// One CPU: stores into decoded code are tracked exactly (kwemu.zig: code-page
// marks and code_flag write-TLB entries), so self-modifying code takes effect
// at the next instruction; IC IVAU (`icIvau`) drops what this CPU decoded
// from the line's page, which covers writers it does not see (the kernel).
//
// Several CPUs (an SMP kernel, each CPU with its own struct kw_cpu): a store
// by one CPU is not seen by another's tracking. On hardware IC IVAU is
// broadcast to the inner-shareable domain. Here it bumps `code_epoch`, the
// one word of kwemu's static data besides excl.zig's pair_lock (all CPU
// threads share the linear memory), and every CPU compares the epoch with
// the one it last saw at each kw_run entry (every exception return) and at
// every block end, where it also polls *irq_pending; on a change it retires
// all its exec-TLB generations (each block is revalidated against memory
// before it runs again). Guarantee: once IC IVAU has retired on one CPU,
// every other CPU runs the new instructions from its next block boundary
// on, that is within 64 instructions (or at once if it is not in kw_run),
// without an ISB of its own; that is stronger than the architecture asks
// (the other PE must context-synchronise), and what a guest that skips the
// ISB still gets on hardware in practice.

/// Whether the cross-CPU epoch exists: atomics builds (several CPUs) and the
/// unit tests (two struct kw_cpu on one memory, one thread).
pub const multi_cpu = c.smp or builtin.is_test;

var code_epoch: u64 = 0;

inline fn epochNow() u64 {
    return @atomicLoad(u64, &code_epoch, .seq_cst);
}

/// Called by kw_cpu_init and kw_host_reset: this CPU has seen every change
/// so far; compiled code finds the epoch through a64.epoch_ptr.
pub fn epochInit(cpu: *Cpu) void {
    if (!multi_cpu) return;
    cpu.priv.a64.seen_epoch = epochNow();
    cpu.priv.a64.epoch_ptr = @intFromPtr(&code_epoch);
}

/// Retire everything if another CPU invalidated code since this one last
/// looked; true if it did.
inline fn epochCheck(cpu: *Cpu) bool {
    if (!multi_cpu) return false;
    const e = epochNow();
    if (e == cpu.priv.a64.seen_epoch) return false;
    epochCatchUp(cpu, e);
    return true;
}
noinline fn epochCatchUp(cpu: *Cpu, e: u64) void {
    cpu.priv.a64.seen_epoch = e;
    cpu.retireAll();
}

/// No interrupt pending and no code changed by another CPU (the poll at a
/// block end inside a self-loop; runOps): the loop may go on.
pub inline fn quiet(cpu: *Cpu) bool {
    if (cpu.irq_pending) |p| if (p.* != 0) return false;
    return !epochCheck(cpu);
}

/// IC IVAU of `va` (branch.icIvau, the reference and `generic` ops alike).
pub fn icIvau(cpu: *Cpu, va: u64) void {
    if (multi_cpu) {
        const old = @atomicRmw(u64, &code_epoch, .Add, 1, .seq_cst);
        // This CPU is current if it was before: it invalidates here.
        if (old == cpu.priv.a64.seen_epoch) cpu.priv.a64.seen_epoch = old +% 1;
    }
    cpu.icInvalidate(va);
}

// ---- run -----------------------------------------------------------------------

fn event(cpu: *Cpu, kind: core.Kind, access: u32, addr: u64, insn: u64) u32 {
    cpu.ev = .{ .kind = @intFromEnum(kind), .access = access, .addr = addr, .insn = insn };
    return @intFromEnum(kind);
}

/// The event of a trapped instruction (Hart.trap; pc on it). SVC retires:
/// pc moves past it (the caller charges it).
pub fn trapEvent(cpu: *Cpu, regs: *Regs) u32 {
    const h = &cpu.priv.hart;
    cpu.priv.smc = 0;
    return switch (h.trap) {
        .syscall => blk: {
            regs.pc +%= 4;
            break :blk event(cpu, .syscall, 0, 0, 0);
        },
        .breakpoint => event(cpu, .breakpoint, 0, regs.pc, h.trap_val),
        .misaligned => event(cpu, .misaligned, 0, h.trap_val, 0),
        else => event(cpu, .illegal, 0, regs.pc, h.trap_val),
    };
}

/// kw_run: blocks run compiled (`-Dkwemu-jit`, once hot: jit.C.ready) or
/// through `runOps`. Compiled code returns "done" (pc set; a side exit
/// refunds the rest of its block here, a region's own side exits did it
/// themselves) or hands op k of `lastBlock` back: `runOps` then finishes
/// that pass from op k of the same decode, with slot 32 set back to 0 first
/// (compiled code stores pc there at its exit, and the ops read the slot as
/// XZR). A compiled block's further self-loop passes enter its code again,
/// so after a hand-back runOps runs no further pass; a block counting
/// towards its compile threshold runs at most the countdown's worth of
/// passes in runOps, so its next pass compiles it.
pub fn run(cpu: *Cpu, regs: *Regs) u32 {
    const start = cpu.budget;
    var left = start;
    defer {
        cpu.budget = left;
        cpu.icount +%= start - left;
    }
    _ = epochCheck(cpu); // an exception return: a context synchronisation
    const irq = cpu.irq_pending;
    if (irq) |p| if (p.* != 0) return event(cpu, .interrupt, 0, 0, 0);
    const x: [*]u64 = @ptrCast(&regs.x);
    const h = &cpu.priv.hart;
    const s: c.St = .{ .r = regs, .h = h, .m = cpu };
    const arena = cpu.opArena(Op);
    // JIT: pool entry of the region entered last, and whether its code left
    // through an exit (not a hand-back) towards the block looked up next.
    var xs: u32 = 0;
    var left_region = false;
    while (true) {
        if (left == 0) return event(cpu, .budget, 0, 0, 0);
        const b = cpu.lookupIn(Blocks, regs.pc) catch |e| return switch (e) {
            error.Misaligned => event(cpu, .misaligned, 0, regs.pc, 0),
            error.PageFault => event(cpu, .fault, cpu.priv.fault_access, cpu.priv.fault_addr, 0),
        };
        if (jc.enabled and left_region) {
            left_region = false;
            // A grow compiled, and a flush came during the compile: look b
            // up again (jitcore.zig, windowClose).
            if (jit.C.noteExit(cpu, xs, b)) continue;
        }
        if (b.ninsn > left) {
            // Single-step: the budget ends inside this block.
            kwemu.count(cpu, "single_steps", 1);
            const e = decode.step(s) catch {
                cpu.priv.smc = 0;
                return event(cpu, .fault, cpu.priv.fault_access, cpu.priv.fault_addr, 0);
            };
            cpu.priv.smc = 0;
            switch (e) {
                .next => left -= 1,
                .jump => {
                    left -= 1;
                    if (irq) |p| if (p.* != 0) return event(cpu, .interrupt, 0, 0, 0);
                },
                .trap => {
                    if (h.trap == .counter) {
                        branch.finishCounter(s, cpu.icount +% (start - left));
                        left -= 1;
                        continue;
                    }
                    if (h.trap == .syscall) left -= 1; // SVC retires
                    return trapEvent(cpu, regs);
                },
            }
            continue;
        }
        kwemu.count(cpu, "blocks", 1);
        kwemu.count(cpu, "block_insns", b.ninsn);
        left -= b.ninsn;
        var blk = b;
        var first: [*]const Op = arena + blk.op;
        var o = first;
        // Budget runOps may spend on further self-loop passes.
        var cap = left;
        if (jc.enabled) {
            const go = jit.C.ready(cpu, blk);
            if (go == .again) {
                // It compiled, and a flush came during the compile: blk may
                // be gone. Nothing of it ran; take it back and look it up
                // again (jitcore.zig, windowClose).
                left += blk.ninsn;
                continue;
            }
            if (go == .compiled) {
                const jl = @min(left, jc.max_jl);
                xs = jc.slotIndex(blk);
                const ret = jc.enter(cpu, blk, x, jl);
                left = left - jl + (ret >> 8);
                // A region charges every further member in full before it
                // runs (like blk above); `code` refers to the last one.
                blk = jc.lastBlock(cpu);
                first = arena + blk.op;
                const code: u32 = @intCast(ret & 0xff);
                if (kwemu.stats_on) jitStats(cpu, b, blk, jl -% (ret >> 8), code);
                if (code >= jc.code_done) {
                    if (code >= jc.code_side) left += blk.ninsn - (code - jc.code_side + 1);
                    left_region = true;
                    if (irq) |p| if (p.* != 0) return event(cpu, .interrupt, 0, 0, 0);
                    _ = epochCheck(cpu);
                    continue;
                }
                // Handed back before op `code`: the ops finish the pass.
                jc.handedBack(cpu);
                o = first + code;
                cap = 0;
            } else if (blk.jx.st != jc.never) cap = @min(left, blk.jx.st);
        }
        x[ops.zr] = 0; // XZR while the ops run (compiled code left pc there)
        // Self-loop passes that fit `cap` run inside runOps.
        const r = opexec.runOps(o, x, cpu, blk.end_pc, blk.pc, blk.ninsn, cap);
        const passes = cap - r.left;
        left -= passes;
        if (jc.enabled and passes != 0) jc.loopDone(blk, passes);
        if (r.next == .done or r.next == .side) {
            if (r.next == .side) {
                // Side exit after k + 1 instructions: refund the rest.
                const k = (@intFromPtr(r.op) - @intFromPtr(first)) / @sizeOf(Op);
                left += blk.ninsn - (k + 1);
            }
            if (irq) |p| if (p.* != 0) return event(cpu, .interrupt, 0, 0, 0);
            _ = epochCheck(cpu);
            continue;
        }
        // Left the block early: k instructions before r.op retired.
        const k: usize = (@intFromPtr(r.op) - @intFromPtr(first)) / @sizeOf(Op);
        left += blk.ninsn - k;
        cpu.priv.smc = 0;
        switch (r.next) {
            .done, .cont, .side => unreachable,
            .fault => {
                regs.pc = pcAt(cpu, blk, k);
                return event(cpu, .fault, cpu.priv.fault_access, cpu.priv.fault_addr, 0);
            },
            .trap => {
                regs.pc = pcAt(cpu, blk, k);
                if (h.trap == .syscall) left -= 1; // SVC retires
                return trapEvent(cpu, regs);
            },
            .counter => {
                // MRS CNTVCT_EL0: retires with the instructions retired before it.
                regs.pc = pcAt(cpu, blk, k);
                branch.finishCounter(s, cpu.icount +% (start - left));
                left -= 1;
            },
            .stop => {
                left -= 1;
                regs.pc = pcAt(cpu, blk, k + 1);
            },
        }
        if (irq) |p| if (p.* != 0) return event(cpu, .interrupt, 0, 0, 0);
        _ = epochCheck(cpu);
    }
}

/// -Dkwemu-stats: account one call into compiled code that entered block
/// `entry` (charged by `run`) and left from `b` (`lastBlock`), `extra` =
/// what it charged against its budget beyond `entry` (wraps when a side
/// exit of `entry` refunded into it), `code` its exit code.
noinline fn jitStats(cpu: *Cpu, entry: *const Block, b: *const Block, extra: u64, code: u32) void {
    const st = &cpu.priv.stats.jit;
    const charged = entry.ninsn +% extra;
    if (code >= jc.code_side) {
        st.insns += charged - (b.ninsn - (code - jc.code_side + 1));
    } else if (code >= jc.code_done) {
        st.insns += charged;
    } else {
        st.insns += charged - (b.ninsn - code);
        st.handbacks += 1;
        st.hb[@intFromEnum(cpu.opArena(Op)[b.op + code].h)] += 1;
    }
    _ = jit.C.countExit(cpu, b, code);
}
