// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Per-kind JIT tests (core stream; the families call `kind` with one line
//! per op kind, a64.md "JIT"): random programs built from one generator run
//! on a kw_run machine (in the wasm64 unit tests: the JIT with an eager host,
//! so every block compiles on its first entry) and on a reference machine
//! (`run.runRef`, the oracle), from the same edge and random register values
//! and memory; event, icount, every register and all memory must match.
//! Natively the same tests run kw_run's decoded-op tier.
//!
//!   test "a64 jit alu: add_i" {
//!       try kt.kind(.add_i, kt.one(genAddI), .{});
//!   }
//!
//! A program is `opt.words` words from the generator at code_va (a page
//! filled with SVC behind them, and a second code page of SVC, so a branch
//! anywhere lands on one), then SVC. Register conventions (as the block
//! fuzz): x19 = code_va; x20, x21, x22 and SP point into four RW data pages,
//! x23 into a page that is not mapped (faults), x24 into a read-only page;
//! every other register gets an edge value (0, 1, 2^31 - 1, ..., ~0, the
//! value of another register) or a random one, the V registers and NZCV
//! random. Use `dst` for destinations, `anyReg` for sources, `base` for
//! address registers.
//!
//! The test fails if no op of kind `h` was decoded (the generator does not
//! make it), and in JIT builds, unless `opt.translated = false`, if none was
//! in the translated part of a compiled block (the kind is not supported or
//! never compiled): a kind's test proves it is compiled, not only that the
//! results match.

const std = @import("std");
const c = @import("../common.zig");
const ops = @import("../ops.zig");
const kwemu = @import("../../emu/kwemu.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const mach = @import("../machine.zig");
const Machine = mach.Machine;

pub const code_va: u64 = 0x10000;
pub const data_va: u64 = 0x40000; // x20, x21, x22, sp: 4 RW pages
pub const lazy_va: u64 = 0x44000; // x23: not mapped
pub const ro_va: u64 = 0x45000; // x24: read only

const R: u64 = 2;
const Wp: u64 = 4;
const X: u64 = 8;

/// Writes one or more instruction words at out[0..] (at least 4 words of
/// room), the first at pc; returns how many.
pub const Gen = *const fn (r: std.Random, out: []u32, pc: u64) usize;

pub const Opt = struct {
    /// Programs, each with new registers and memory.
    rounds: u32 = 200,
    /// Generated words per program (up to 1000).
    words: u32 = 24,
    /// JIT builds: some op of the kind must have been compiled.
    translated: bool = true,
    /// kw_run's budget (an endless loop ends with a budget event).
    budget: u64 = 100_000,
    seed: u64 = 1,
    /// Map the code pages writable too (stores into decoded code: SMC).
    rwx_code: bool = false,
    /// Fill the data TLBs for every mapped page before each program, so
    /// that compiled code can hit on its first access to a page.
    warm_tlb: bool = false,
};

/// A generator of single words from `f`.
pub fn one(comptime f: fn (std.Random) u32) Gen {
    return struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            _ = pc;
            out[0] = f(r);
            return 1;
        }
    }.g;
}

/// A destination register: 0..18 or 25..30 (not the code and data bases).
pub fn dst(r: std.Random) u32 {
    const v = r.uintLessThan(u32, 24);
    return if (v >= 19) v + 7 else v;
}
/// Any register number (31 is SP or XZR by operand).
pub fn anyReg(r: std.Random) u32 {
    return r.uintLessThan(u32, 32);
}
/// An address register: x20..x24 or SP.
pub fn base(r: std.Random) u32 {
    const v = r.uintLessThan(u32, 6);
    return if (v == 5) 31 else 20 + v;
}
/// sf (bit 31) at random.
pub fn sf(r: std.Random) u32 {
    return r.uintLessThan(u32, 2) << 31;
}

/// A word that decodes to `movi`: MOVZ, MOVN, ADR, ADRP or MOV (bitmask
/// immediate; reserved bitmasks are generic).
pub fn movi(r: std.Random) u32 {
    const rd = dst(r);
    return switch (r.uintLessThan(u32, 5)) {
        0 => 0x5280_0000 | sf(r) | (r.uintLessThan(u32, 2) << 21) | (r.uintLessThan(u32, 65536) << 5) | rd, // movz
        1 => 0x1280_0000 | sf(r) | (r.uintLessThan(u32, 2) << 21) | (r.uintLessThan(u32, 65536) << 5) | rd, // movn
        2 => 0x1000_0000 | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 1 << 19) << 5) | rd, // adr
        3 => 0x9000_0000 | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 1 << 19) << 5) | rd, // adrp
        else => 0x3200_0000 | sf(r) | (if (r.boolean()) @as(u32, 1) << 22 else 0) | (r.uintLessThan(u32, 64) << 16) | (r.uintLessThan(u32, 64) << 10) | (31 << 5) | rd, // orr rd, xzr, #imm
    };
}

/// A word that decodes to `nop`: hints, PRFM, a logical op to XZR.
pub fn nop(r: std.Random) u32 {
    return switch (r.uintLessThan(u32, 4)) {
        0 => 0xd503_201f | (r.uintLessThan(u32, 128) << 5), // hint #n (NOP, YIELD, PAC hints, BTI, ...)
        1 => 0xf980_0000 | (r.uintLessThan(u32, 4096) << 10) | (base(r) << 5) | r.uintLessThan(u32, 32), // prfm
        else => 0x0a00_0000 | sf(r) | (r.uintLessThan(u32, 3) << 29) | (r.uintLessThan(u32, 4) << 22) | (anyReg(r) << 16) | (r.uintLessThan(u32, 32) << 10) | (anyReg(r) << 5) | 31, // and/orr/eor xzr, ...
    };
}

const edges = [_]u64{ 0, 1, 2, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x1_0000_0000, 0x7fff_ffff_ffff_ffff, 0x8000_0000_0000_0000, std.math.maxInt(u64), 0xffff_ffff_8000_0000, 0x8000_0000_ffff_ffff };

const svc = mach.svc0;

const Pair = struct {
    m: [2]Machine,
    code: [2][2]u64 = undefined,
    data: [2][4]u64 = undefined,
    ro: [2]u64 = undefined,

    fn init(gpa: std.mem.Allocator) !Pair {
        var p: Pair = .{ .m = .{ try Machine.init(gpa), try Machine.init(gpa) } };
        for (&p.m, 0..) |*m, j| {
            for (0..2) |k| {
                p.code[j][k] = m.frame();
                m.map(code_va + k * 4096, p.code[j][k], R | X);
            }
            for (0..4) |k| {
                p.data[j][k] = m.frame();
                m.map(data_va + k * 4096, p.data[j][k], R | Wp);
            }
            p.ro[j] = m.frame();
            m.map(ro_va, p.ro[j], R);
        }
        return p;
    }
    fn deinit(p: *Pair) void {
        for (&p.m) |*m| m.deinit();
    }
};

/// Run `opt.rounds` programs of kind `h`'s generator `gen` on the JIT (or
/// tier) and on the reference; see above.
pub fn kind(comptime h: ops.H, gen: Gen, opt: Opt) !void {
    var p = try Pair.init(std.testing.allocator);
    defer p.deinit();
    if (opt.rwx_code) for (&p.m, 0..) |*m, j| for (0..2) |k| m.map(code_va + k * 4096, p.code[j][k], R | Wp | X);
    var prng = std.Random.DefaultPrng.init(opt.seed *% 0x9e37_79b9_7f4a_7c15 +% @intFromEnum(h));
    const r = prng.random();
    var seen: usize = 0;
    var translated: usize = 0;
    for (0..opt.rounds) |round| {
        var prog: [2048]u32 = @splat(svc);
        var i: usize = 0;
        while (i < @min(opt.words, 1000)) i += gen(r, prog[i..], code_va + 4 * i);
        var regs: c.Regs = .{};
        for (0..31) |k| regs.x[k] = switch (r.uintLessThan(u32, 8)) {
            0 => r.uintLessThan(u64, 16),
            1, 2 => r.int(u64),
            3 => @as(u64, r.int(u32)),
            4, 5 => edges[r.uintLessThan(usize, edges.len)],
            6 => if (k > 0) regs.x[r.uintLessThan(usize, k)] else 0,
            else => 0 -% r.uintLessThan(u64, 16),
        };
        for (&regs.v) |*v| v.* = (@as(u128, r.int(u64)) << 64) | r.int(u64);
        regs.nzcv = r.uintLessThan(u32, 16) << 28;
        regs.tpidr_el0 = r.int(u64);
        regs.x[19] = code_va;
        regs.x[20] = data_va + 64;
        regs.x[21] = data_va + 0x1000 + 512;
        regs.x[22] = data_va + 0x2000 + 2048;
        regs.x[23] = lazy_va + 1024;
        regs.x[24] = ro_va + 256;
        regs.sp = data_va + 0x3800;
        regs.pc = code_va;
        const fill = r.int(u8);
        for (&p.m, 0..) |*m, j| {
            for (0..2) |k| @memcpy(m.bytes(p.code[j][k]), std.mem.sliceAsBytes(prog[k * 1024 ..][0..1024]));
            for (0..4) |k| for (m.bytes(p.data[j][k]), 0..) |*b, q| {
                b.* = @truncate(q *% 7 +% k *% 13 +% fill);
            };
            for (m.bytes(p.ro[j]), 0..) |*b, q| b.* = @truncate(q *% 3 +% fill);
            // The "kernel" rewrote the code: drop what was decoded (and
            // compiled) from the previous program.
            m.cpu.resetCache();
            m.cpu.flushAll();
            m.cpu.icount = 0;
            m.regs = regs;
            if (opt.warm_tlb) {
                for (0..2) |k| {
                    m.cpu.probe(code_va + k * 4096, .read) catch unreachable;
                    if (opt.rwx_code) m.cpu.probe(code_va + k * 4096, .write) catch unreachable;
                }
                for (0..4) |k| m.cpu.probe(data_va + k * 4096, .write) catch unreachable;
                for (0..4) |k| m.cpu.probe(data_va + k * 4096, .read) catch unreachable;
                m.cpu.probe(ro_va, .read) catch unreachable;
            }
        }
        const T = &p.m[0];
        const Rf = &p.m[1];
        const kt = T.run(opt.budget);
        const kr = Rf.runRef(opt.budget);
        var bad = kt != kr or T.cpu.icount != Rf.cpu.icount or !std.mem.eql(u8, std.mem.asBytes(&T.regs), std.mem.asBytes(&Rf.regs));
        if (kt != mach.EV_BUDGET and !std.mem.eql(u8, std.mem.asBytes(&T.cpu.ev), std.mem.asBytes(&Rf.cpu.ev))) bad = true;
        if (!std.mem.eql(u8, T.mem[0..@intCast(T.next)], Rf.mem[0..@intCast(Rf.next)])) bad = true;
        // What was decoded and compiled.
        const arena = T.cpu.opArena(ops.Op);
        for (&T.cpu.priv.blocks) |*b| {
            if (b.pc == std.math.maxInt(u64)) continue;
            const o = arena[b.op..][0..b.n];
            var u: usize = 0;
            while (u < o.len and jit.supported(o[u])) u += 1;
            for (o, 0..) |x, k| {
                if (x.h != h) continue;
                seen += 1;
                if (jc.enabled and b.jx.st >= jc.compiled and k < u) translated += 1;
            }
        }
        if (bad) {
            std.debug.print("a64 jit kind {s}, round {d}: kw_run event {d} icount {d} pc 0x{x}, reference {d} icount {d} pc 0x{x}\n", .{
                @tagName(h), round, kt, T.cpu.icount, T.regs.pc, kr, Rf.cpu.icount, Rf.regs.pc,
            });
            std.debug.print("  ev kw_run {any}\n  ev ref    {any}\n", .{ T.cpu.ev, Rf.cpu.ev });
            for (0..31) |k| if (T.regs.x[k] != Rf.regs.x[k]) std.debug.print("  x{d}: 0x{x} vs 0x{x}\n", .{ k, T.regs.x[k], Rf.regs.x[k] });
            if (T.regs.sp != Rf.regs.sp) std.debug.print("  sp: 0x{x} vs 0x{x}\n", .{ T.regs.sp, Rf.regs.sp });
            if (T.regs.nzcv != Rf.regs.nzcv) std.debug.print("  nzcv: 0x{x} vs 0x{x}\n", .{ T.regs.nzcv, Rf.regs.nzcv });
            for (0..32) |k| if (T.regs.v[k] != Rf.regs.v[k]) std.debug.print("  v{d} differs\n", .{k});
            if (T.regs.tpidr_el0 != Rf.regs.tpidr_el0 or T.regs.fpsr != Rf.regs.fpsr or T.regs.fpcr != Rf.regs.fpcr) std.debug.print("  tpidr/fpsr/fpcr differ\n", .{});
            std.debug.print("  program:", .{});
            for (prog[0..i]) |w| std.debug.print(" {x:0>8}", .{w});
            std.debug.print("\n", .{});
            return error.TestUnexpectedResult;
        }
    }
    if (seen == 0) {
        std.debug.print("a64 jit kind {s}: the generator made no op of this kind\n", .{@tagName(h)});
        return error.TestUnexpectedResult;
    }
    if (jc.enabled and opt.translated and translated == 0) {
        std.debug.print("a64 jit kind {s}: {d} ops decoded, none compiled\n", .{ @tagName(h), seen });
        return error.TestUnexpectedResult;
    }
}
