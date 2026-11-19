// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Unit tests of the decoded-op tier (tier.zig, ops.zig, opexec.zig) against
//! the reference loop (run.runRef): the block cache's coherence rules (stores
//! into decoded code, kernel rewrites with flushes, COW copies, aliases, set_pgd,
//! IC IVAU on this and on another CPU), exact budgets, precise faults, the
//! interrupt latency, arena resets, and a randomized block fuzz that runs
//! random instruction soups on two machines (tier and reference) in lockstep
//! (`-Dkwemu-a64-fuzz=N` programs, default 300).

const std = @import("std");
const t = std.testing;
const options = @import("kwemu_options");
const c = @import("common.zig");
const ops = @import("ops.zig");
const tier = @import("tier.zig");
const kwemu = @import("../emu/kwemu.zig");
const jc = @import("../emu/jitcore.zig");
const jit_tests = @import("jit/tests.zig");
const mach = @import("machine.zig");
const Machine = mach.Machine;
const Cpu = kwemu.Cpu;

const R: u64 = 2;
const W: u64 = 4;
const X: u64 = 8;

// ---- an A64 assembler for the few forms the tests use ---------------------------

const A = struct {
    fn movz(rd: u32, imm: u32, hw: u32) u32 {
        return 0xd280_0000 | (hw << 21) | ((imm & 0xffff) << 5) | rd;
    }
    fn movk(rd: u32, imm: u32, hw: u32) u32 {
        return 0xf280_0000 | (hw << 21) | ((imm & 0xffff) << 5) | rd;
    }
    fn addi(rd: u32, rn: u32, imm: u32) u32 {
        return 0x9100_0000 | (imm << 10) | (rn << 5) | rd;
    }
    fn subsi(rd: u32, rn: u32, imm: u32) u32 {
        return 0xf100_0000 | (imm << 10) | (rn << 5) | rd;
    }
    fn ldrx(rt: u32, rn: u32, imm12: u32) u32 {
        return 0xf940_0000 | (imm12 << 10) | (rn << 5) | rt;
    }
    fn strx(rt: u32, rn: u32, imm12: u32) u32 {
        return 0xf900_0000 | (imm12 << 10) | (rn << 5) | rt;
    }
    fn strw(rt: u32, rn: u32, imm12: u32) u32 {
        return 0xb900_0000 | (imm12 << 10) | (rn << 5) | rt;
    }
    fn b(off_words: i32) u32 {
        return 0x1400_0000 | (@as(u32, @bitCast(off_words)) & 0x3ff_ffff);
    }
    fn bl(off_words: i32) u32 {
        return 0x9400_0000 | (@as(u32, @bitCast(off_words)) & 0x3ff_ffff);
    }
    fn bcond(cond: u32, off_words: i32) u32 {
        return 0x5400_0000 | ((@as(u32, @bitCast(off_words)) & 0x7ffff) << 5) | cond;
    }
    fn cbnz(rt: u32, off_words: i32) u32 {
        return 0xb500_0000 | ((@as(u32, @bitCast(off_words)) & 0x7ffff) << 5) | rt;
    }
    fn cbz(rt: u32, off_words: i32) u32 {
        return 0xb400_0000 | ((@as(u32, @bitCast(off_words)) & 0x7ffff) << 5) | rt;
    }
    fn icivau(rt: u32) u32 {
        return 0xd50b_7520 | rt;
    }
    const ret: u32 = 0xd65f_03c0;
    const isb: u32 = 0xd503_3fdf;
    const nop: u32 = 0xd503_201f;
    const svc: u32 = mach.svc0;
};

fn expectEv(m: *Machine, want: u32, got: u32) !void {
    if (want != got) {
        std.debug.print("event {d}, want {d} (pc 0x{x}, ev addr 0x{x} insn 0x{x})\n", .{ got, want, m.regs.pc, m.cpu.ev.addr, m.cpu.ev.insn });
        return error.TestUnexpectedResult;
    }
}

// ---- coherence -------------------------------------------------------------------

test "a64 tier: a store later in the same block, and into a cached block, takes effect at the next instruction" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const code = 0x10000;
    // x19 = code page; the store rewrites the add at index 4 (in this block,
    // after the store) to add #2, then a second pass of a cached block.
    m.map(code, m.frame(), R | W | X);
    const words = [_]u32{
        A.movz(19, 1, 1), // x19 = 0x10000
        A.movz(1, @truncate(A.addi(0, 0, 2) & 0xffff), 0),
        A.movk(1, @truncate(A.addi(0, 0, 2) >> 16), 1),
        A.strw(1, 19, 4), // word 4
        A.addi(0, 0, 1), // replaced by add x0, x0, #2 before it runs
        A.svc,
    };
    @memcpy(m.at(code)[0 .. words.len * 4], std.mem.sliceAsBytes(&words));
    m.regs.pc = code;
    try expectEv(&m, mach.EV_SYSCALL, m.run(1000));
    try t.expectEqual(@as(u64, 2), m.regs.x[0]);
    // Run the block again from the store (cached, store writes the old
    // word back now: x1 = add #1 encoding).
    m.regs.x[1] = A.addi(0, 0, 1);
    m.regs.x[0] = 0;
    m.regs.pc = code + 12;
    try expectEv(&m, mach.EV_SYSCALL, m.run(1000));
    try t.expectEqual(@as(u64, 1), m.regs.x[0]);
}

test "a64 tier: a store through a writable alias of an exec-only mapping" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const pa = m.frame();
    m.map(0x10000, pa, R | X);
    m.map(0x30000, pa, R | W);
    m.code(0x50000, &.{ A.strw(3, 2, 0), A.svc });
    const words = [_]u32{ A.addi(0, 0, 1), A.svc };
    @memcpy(m.at(0x10000)[0..8], std.mem.sliceAsBytes(&words));
    m.regs.pc = 0x10000;
    try expectEv(&m, mach.EV_SYSCALL, m.run(100));
    try t.expectEqual(@as(u64, 1), m.regs.x[0]);
    // A guest store through the alias: no flush, no IC IVAU.
    m.regs.x[2] = 0x30000;
    m.regs.x[3] = A.addi(0, 0, 5);
    m.regs.pc = 0x50000;
    try expectEv(&m, mach.EV_SYSCALL, m.run(100));
    m.regs.x[0] = 0;
    m.regs.pc = 0x10000;
    try expectEv(&m, mach.EV_SYSCALL, m.run(100));
    try t.expectEqual(@as(u64, 5), m.regs.x[0]);
}

test "a64 tier: stores into code of pages that share a wild mark slot" {
    // Three code pages whose host pages hash to one mark slot (16 MiB
    // apart): A, then C makes the slot wild, then D is decoded into it. D's
    // write-TLB entry (through a writable alias) was filled before anything
    // was marked, so it must have been flagged when the slot became wild;
    // decoding D itself scans nothing.
    var m = try Machine.initSize(t.allocator, 56 << 20);
    defer m.deinit();
    const pa_a = m.frame();
    const pa_c = pa_a + (16 << 20);
    const pa_d = pa_a + (32 << 20);
    m.next = (pa_d - mach.pa_base) + 4096;
    m.map(0x10000, pa_a, R | X);
    m.map(0x20000, pa_c, R | X);
    m.map(0x30000, pa_d, R | X);
    m.map(0x40000, pa_d, R | W);
    m.code(0x50000, &.{ A.strw(3, 2, 0), A.svc });
    const put = struct {
        fn f(mm: *Machine, va: u64, imm: u32) void {
            const w = [_]u32{ A.addi(0, 0, imm), A.svc };
            @memcpy(mm.at(va)[0..8], std.mem.sliceAsBytes(&w));
        }
    }.f;
    const go = struct {
        fn f(mm: *Machine, pc: u64) !u64 {
            mm.regs.x[0] = 0;
            mm.regs.pc = pc;
            try expectEv(mm, mach.EV_SYSCALL, mm.run(100));
            return mm.regs.x[0];
        }
    }.f;
    const store = struct {
        fn f(mm: *Machine, va: u64, v: u64) !void {
            mm.regs.x[2] = va;
            mm.regs.x[3] = v;
            mm.regs.pc = 0x50000;
            try expectEv(mm, mach.EV_SYSCALL, mm.run(100));
        }
    }.f;
    put(&m, 0x10000, 1);
    put(&m, 0x20000, 2);
    put(&m, 0x30000, 3);
    try store(&m, 0x40800, 0); // D's write-TLB entry, before any mark
    try t.expectEqual(@as(u64, 1), try go(&m, 0x10000));
    try t.expectEqual(@as(u64, 2), try go(&m, 0x20000)); // the slot becomes wild
    try t.expectEqual(@as(u64, 3), try go(&m, 0x30000));
    try store(&m, 0x40000, A.addi(0, 0, 7)); // through the alias
    try t.expectEqual(@as(u64, 7), try go(&m, 0x30000));
}

test "a64 tier: kernel rewrite + flush, COW copy, set_pgd, and a rewrite made visible only by IC IVAU" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const pa = m.frame();
    m.map(0x10000, pa, R | X);
    // Mapped before anything is decoded: a map flushes this CPU's TLB.
    m.code(0x20000, &.{ A.movz(9, 1, 1), A.icivau(9), A.isb, A.svc });
    const put = struct {
        fn f(mm: *Machine, va: u64, imm: u32) void {
            const w = [_]u32{ A.addi(0, 0, imm), A.svc };
            @memcpy(mm.at(va)[0..8], std.mem.sliceAsBytes(&w));
        }
    }.f;
    const go = struct {
        fn f(mm: *Machine) !u64 {
            mm.regs.x[0] = 0;
            mm.regs.pc = 0x10000;
            try expectEv(mm, mach.EV_SYSCALL, mm.run(100));
            return mm.regs.x[0];
        }
    }.f;
    put(&m, 0x10000, 1);
    try t.expectEqual(@as(u64, 1), try go(&m));
    // The kernel rewrites the page and flushes it.
    put(&m, 0x10000, 2);
    m.cpu.flushRange(0x10000, 0x11000);
    try t.expectEqual(@as(u64, 2), try go(&m));
    // A COW copy with a change at a new physical page.
    const pa2 = m.frame();
    @memcpy(m.bytes(pa2), m.bytes(pa));
    m.map(0x10000, pa2, R | X); // flushes
    put(&m, 0x10000, 3);
    try t.expectEqual(@as(u64, 3), try go(&m));
    // set_pgd drops everything (same table here).
    put(&m, 0x10000, 4);
    kwemu.setPgd(m.cpu, m.root);
    try t.expectEqual(@as(u64, 4), try go(&m));
    // Without a flush, the decoded block stays (as on hardware without
    // IC IVAU); the guest's IC IVAU of the line makes it visible.
    put(&m, 0x10000, 5);
    try t.expectEqual(@as(u64, 4), try go(&m));
    m.regs.pc = 0x20000;
    try expectEv(&m, mach.EV_SYSCALL, m.run(100));
    try t.expectEqual(@as(u64, 5), try go(&m));
}

test "a64 tier: IC IVAU on another CPU makes this CPU's decoded code stale (code epoch)" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const other = try m.newCpu();
    defer m.freeCpu(other);
    const pa = m.frame();
    m.map(0x10000, pa, R | W | X);
    other.flushAll();
    const put = struct {
        fn f(mm: *Machine, imm: u32) void {
            const w = [_]u32{ A.addi(0, 0, imm), A.svc };
            @memcpy(mm.at(0x10000)[0..8], std.mem.sliceAsBytes(&w));
        }
    }.f;
    put(&m, 1);
    const go = struct {
        fn f(mm: *Machine) !u64 {
            mm.regs.x[0] = 0;
            mm.regs.pc = 0x10000;
            try expectEv(mm, mach.EV_SYSCALL, mm.run(100));
            return mm.regs.x[0];
        }
    }.f;
    var r2: c.Regs = .{};
    // The other CPU's program (mapped first: a map flushes this CPU).
    m.code(0x20000, &.{
        A.movz(9, 1, 1), // x9 = 0x10000
        A.movz(1, @truncate(A.addi(0, 0, 7) & 0xffff), 0),
        A.movk(1, @truncate(A.addi(0, 0, 7) >> 16), 1),
        A.strw(1, 9, 0),
        A.svc,
        A.icivau(9),
        A.svc,
    });
    try t.expectEqual(@as(u64, 1), try go(&m)); // decoded on this CPU
    // The other CPU stores new code (its stores are not tracked here)...
    other.flushAll();
    r2.pc = 0x20000;
    other.budget = 100;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), tier.run(other, &r2));
    // ...and without IC IVAU this CPU keeps running what it decoded.
    try t.expectEqual(@as(u64, 1), try go(&m));
    // IC IVAU there: here the next kw_run sees it.
    other.budget = 100;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), tier.run(other, &r2));
    try t.expectEqual(@as(u64, 7), try go(&m));
}

test "a64 tier: IC IVAU on another CPU reaches a CPU inside kw_run at its next block boundary" {
    // Needs host threads (not in the wasm64 unit tests).
    if (@import("builtin").single_threaded) return error.SkipZigTest else return crossCpuInsideRun();
}

fn crossCpuInsideRun() !void {
    // CPU A spins in one kw_run: `loop: add x5, x5, #1; str x5, [x6];
    // bl f; cbz x0, loop; svc` where f is `mov x0, #0; ret`. CPU B (another
    // thread), once A is looping, rewrites f to return 1 and executes
    // IC IVAU. A must leave the loop by the SVC, without returning to the
    // kernel in between.
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const other = try m.newCpu();
    defer m.freeCpu(other);
    m.map(0x10000, m.frame(), R | W | X);
    m.mapData(0x40000, 1);
    const f = 0x10800;
    m.code(0x20000, &.{
        A.movz(9, @truncate(f), 0),
        A.movk(9, @truncate(f >> 16), 1),
        A.movz(1, @truncate(A.movz(0, 1, 0) & 0xffff), 0),
        A.movk(1, @truncate(A.movz(0, 1, 0) >> 16), 1),
        A.strw(1, 9, 0),
        A.icivau(9),
        A.svc,
    });
    other.flushAll();
    const loop = [_]u32{ A.addi(5, 5, 1), A.strx(5, 6, 0), A.bl(@intCast((f - 0x10008) / 4)), A.cbz(0, -3), A.svc };
    @memcpy(m.at(0x10000)[0..20], std.mem.sliceAsBytes(&loop));
    const fw = [_]u32{ A.movz(0, 0, 0), A.ret };
    @memcpy(m.at(f)[0..8], std.mem.sliceAsBytes(&fw));
    m.cpu.flushAll();
    m.regs.x[6] = 0x40000;
    m.regs.pc = 0x10000;
    const counter: *volatile u64 = @ptrCast(@alignCast(m.at(0x40000).ptr));
    const B = struct {
        fn run(cpu: *Cpu, cnt: *volatile u64) void {
            while (cnt.* < 1000) std.atomic.spinLoopHint();
            var r: c.Regs = .{};
            r.pc = 0x20000;
            cpu.budget = 100;
            _ = tier.run(cpu, &r);
        }
    };
    const th = try std.Thread.spawn(.{}, B.run, .{ other, counter });
    const ev = m.run(100_000_000);
    th.join();
    try expectEv(&m, mach.EV_SYSCALL, ev);
    try t.expectEqual(@as(u64, 1), m.regs.x[0]);
}

// ---- exactness -------------------------------------------------------------------

test "a64 tier: a fault in the middle of a block is precise" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.code(0x10000, &.{ A.addi(0, 0, 1), A.addi(1, 1, 1), A.ldrx(2, 3, 0), A.addi(4, 4, 1), A.svc });
    m.regs.x[3] = 0x70000; // unmapped
    try expectEv(&m, mach.EV_FAULT, m.run(1000));
    try t.expectEqual(@as(u64, 0x10008), m.regs.pc);
    try t.expectEqual(@as(u64, 2), m.cpu.icount);
    try t.expectEqual(@as(u64, 998), m.cpu.budget);
    try t.expectEqual(@as(u64, 1), m.regs.x[0]);
    try t.expectEqual(@as(u64, 0), m.regs.x[4]);
    try t.expectEqual(@as(u64, 0x70000), m.cpu.ev.addr);
    // A store pair whose second half is on an unmapped page: nothing written.
    m.mapData(0x40000, 1);
    m.code(0x11000, &.{ 0xa900_0fe2 | 0, A.svc }); // stp x2, x3, [sp]
    m.regs.sp = 0x40ff8;
    m.regs.x[2] = 0x1111;
    m.regs.x[3] = 0x2222;
    m.regs.pc = 0x11000;
    try expectEv(&m, mach.EV_FAULT, m.run(1000));
    try t.expectEqual(@as(u64, 0x11000), m.regs.pc);
    try t.expectEqual(@as(u64, 0x41007), m.cpu.ev.addr); // the last byte, as c.probeWrite
    try t.expectEqual(@as(u64, 0), std.mem.readInt(u64, m.at(0x40ff8)[0..8], .little));
}

test "a64 tier: budgets that end inside a block, and the interrupt poll at block ends" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    var words: [40]u32 = undefined;
    for (&words) |*w| w.* = A.addi(0, 0, 1);
    words[39] = A.b(-39);
    m.code(0x10000, &words);
    for (1..200) |budget| {
        m.regs.x[0] = 0;
        m.regs.pc = 0x10000;
        const ic = m.cpu.icount;
        try expectEv(&m, mach.EV_BUDGET, m.run(budget));
        try t.expectEqual(ic + budget, m.cpu.icount);
        try t.expectEqual(@as(u64, budget - budget / 40), m.regs.x[0]);
        try t.expectEqual(0x10000 + (budget % 40) * 4, m.regs.pc);
    }
    // Interrupt: a doorbell rung by a store is seen at the end of that block.
    m.mapData(0x40000, 1);
    const bell: *volatile u32 = @ptrCast(@alignCast(m.at(0x40000).ptr));
    m.cpu.irq_pending = bell;
    var body: [64]u32 = undefined;
    for (&body) |*w| w.* = A.addi(0, 0, 1);
    body[10] = A.strw(5, 6, 0); // ring
    body[63] = A.b(-63);
    m.code(0x12000, &body);
    m.regs.x[5] = 1;
    m.regs.x[6] = 0x40000;
    m.regs.pc = 0x12000;
    const ic = m.cpu.icount;
    try expectEv(&m, mach.EV_INTERRUPT, m.run(100000));
    try t.expect(m.cpu.icount - ic <= 64);
    try t.expect(m.cpu.icount - ic >= 11);
    bell.* = 0;
    m.cpu.irq_pending = null;
}

test "a64 tier: arena resets keep running the right code" {
    var m = try Machine.initSize(t.allocator, 64 << 20);
    defer m.deinit();
    // 12000 pages, each a block of 40 adds and a branch to the next page:
    // more ops than the arena holds.
    const n = 12000;
    var words: [41]u32 = undefined;
    for (0..40) |i| words[i] = A.addi(0, 0, 1);
    words[40] = A.b(@intCast((4096 - 160) / 4));
    for (0..n) |p| m.code(0x100000 + p * 4096, &words);
    m.code(0x100000 + n * 4096, &.{A.svc});
    m.regs.pc = 0x100000;
    try expectEv(&m, mach.EV_SYSCALL, m.run(1 << 40));
    try t.expectEqual(@as(u64, 40 * n), m.regs.x[0]);
    try t.expect(m.cpu.priv.ops_used < 41 * n);
}

// ---- randomized block fuzz -------------------------------------------------------

const code_va: u64 = 0x10000;
const code_pages = 2;
const data_va: u64 = 0x40000; // x20, x21, x22, sp: 4 RW pages
const lazy_va: u64 = 0x44000; // x23: mapped on its first fault, unmapped at random
const ro_va: u64 = 0x45000; // x24: read only
const bell_off: u64 = 0xff0; // in the first data page

const Rng = std.Random.DefaultPrng;

/// Destination registers the generator may use (not the bases).
fn dst(r: std.Random) u32 {
    const v = r.uintLessThan(u32, 24);
    return if (v >= 19) v + 7 else v; // 0..18, 26..30 (x31 separately)
}
fn anyReg(r: std.Random) u32 {
    return r.uintLessThan(u32, 32);
}
fn base(r: std.Random) u32 {
    return switch (r.uintLessThan(u32, 6)) {
        0 => 20,
        1 => 21,
        2 => 22,
        3 => 23,
        4 => 24,
        else => 31,
    };
}

/// One random instruction (or a short sequence) at word index `i`.
fn gen(r: std.Random, out: []u32, i: usize) usize {
    const rd = dst(r);
    const rn = anyReg(r);
    const rm = if (r.uintLessThan(u32, 6) == 0) rn else anyReg(r); // equal operands now and then
    const sf: u32 = r.uintLessThan(u32, 2) << 31;
    const k = r.uintLessThan(u32, 100);
    const words_left = out.len - i;
    const off = struct {
        fn f(rr: std.Random, lo: i32, hi: i32) i32 {
            return rr.intRangeAtMost(i32, lo, hi);
        }
    }.f;
    var w: u32 = undefined;
    switch (k) {
        0...5 => w = 0x1100_0000 | sf | (r.uintLessThan(u32, 8) << 29) | (r.uintLessThan(u32, 2) << 22) | (r.uintLessThan(u32, 4096) << 10) | (rn << 5) | (if (r.boolean()) rd else 31), // add/sub imm
        6...9 => w = 0x0b00_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 4) << 22) | (rm << 16) | (r.uintLessThan(u32, 64) << 10) | (rn << 5) | (if (r.boolean()) rd else 31), // add/sub shifted
        10...12 => w = 0x0b20_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (rm << 16) | (r.uintLessThan(u32, 8) << 13) | (r.uintLessThan(u32, 6) << 10) | (rn << 5) | (if (r.boolean()) rd else 31), // add/sub extended
        13...16 => w = 0x0a00_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 4) << 22) | (r.uintLessThan(u32, 2) << 21) | (rm << 16) | (r.uintLessThan(u32, 64) << 10) | (rn << 5) | (if (r.boolean()) rd else 31), // logical shifted
        17...19 => w = 0x1200_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 2) << 22) | (r.uintLessThan(u32, 4096) << 10) | (rn << 5) | (if (r.boolean()) rd else 31), // logical imm
        20...22 => w = 0x1280_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 4) << 21) | (r.uintLessThan(u32, 65536) << 5) | rd, // move wide
        23 => w = 0x1000_0000 | (r.uintLessThan(u32, 2) << 31) | (r.uintLessThan(u32, 4) << 29) | (r.uintLessThan(u32, 1 << 19) << 5) | rd, // adr, adrp
        24...27 => w = 0x1300_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (if (sf != 0) @as(u32, 1) << 22 else 0) | (r.uintLessThan(u32, 64) << 16) | (r.uintLessThan(u32, 64) << 10) | (rn << 5) | rd, // bitfield
        28 => w = 0x1380_0000 | sf | (if (sf != 0) @as(u32, 1) << 22 else 0) | (rm << 16) | (r.uintLessThan(u32, 64) << 10) | (rn << 5) | rd, // extr
        29...31 => w = 0x1a40_0000 | sf | (r.uintLessThan(u32, 2) << 30) | (1 << 29) | (rm << 16) | (r.uintLessThan(u32, 16) << 12) | (r.uintLessThan(u32, 2) << 11) | (rn << 5) | r.uintLessThan(u32, 16), // ccmp/ccmn
        32...34 => w = 0x1a80_0000 | sf | (r.uintLessThan(u32, 2) << 30) | (rm << 16) | (r.uintLessThan(u32, 16) << 12) | (r.uintLessThan(u32, 2) << 10) | (rn << 5) | rd, // csel family
        35...36 => w = 0x1ac0_0000 | sf | (rm << 16) | (r.uintLessThan(u32, 16) << 10) | (rn << 5) | rd, // 2-source
        37...38 => w = 0x1b00_0000 | sf | (r.uintLessThan(u32, 8) << 21) | (rm << 16) | (r.uintLessThan(u32, 2) << 15) | (anyReg(r) << 10) | (rn << 5) | rd, // 3-source
        39 => w = switch (r.uintLessThan(u32, 4)) { // 1-source, ADC/SBC
            0 => 0x5ac0_0000 | sf | (r.uintLessThan(u32, 6) << 10) | (rn << 5) | rd,
            else => 0x1a00_0000 | sf | (r.uintLessThan(u32, 4) << 29) | (rm << 16) | (rn << 5) | rd,
        },
        40...54 => { // loads and stores, single register
            const size = r.uintLessThan(u32, 4);
            const v: u32 = if (r.uintLessThan(u32, 5) == 0) 1 else 0;
            const opc = r.uintLessThan(u32, 4);
            const rt = if (v == 1) anyReg(r) else if (opc & 1 == 0 or opc >= 2) (if (r.uintLessThan(u32, 8) == 0) 31 else dst(r)) else dst(r);
            const bn = base(r);
            w = 0x3800_0000 | (size << 30) | (v << 26) | (opc << 22) | (bn << 5) | rt;
            switch (r.uintLessThan(u32, 5)) {
                0, 1 => w |= (1 << 24) | (r.uintLessThan(u32, 64) << 10), // unsigned offset
                2 => w |= ((@as(u32, @bitCast(off(r, -256, 255))) & 0x1ff) << 12) | (r.uintLessThan(u32, 4) << 10), // unscaled, post, unpriv, pre
                3 => w |= (1 << 21) | (dst(r) << 16) | ((2 + 4 * r.uintLessThan(u32, 2) + r.uintLessThan(u32, 2)) << 13) | (r.uintLessThan(u32, 2) << 12) | (2 << 10), // register offset
                else => w |= ((@as(u32, @bitCast(off(r, -32, 32))) & 0x1ff) << 12) | (@as(u32, if (r.boolean()) 1 else 3) << 10), // pre/post small
            }
        },
        55...62 => { // pairs
            const v: u32 = if (r.uintLessThan(u32, 4) == 0) 1 else 0;
            const opc = r.uintLessThan(u32, 3);
            const l = r.uintLessThan(u32, 2);
            const t1 = if (v == 1) anyReg(r) else if (l == 1) dst(r) else anyReg(r);
            const t2 = if (v == 1) anyReg(r) else if (l == 1) dst(r) else anyReg(r);
            w = 0x2800_0000 | (opc << 30) | (v << 26) | (r.uintLessThan(u32, 4) << 23) | (l << 22) | ((@as(u32, @bitCast(off(r, -8, 8))) & 0x7f) << 15) | (t2 << 10) | (base(r) << 5) | t1;
        },
        63 => w = 0x1800_0000 | (r.uintLessThan(u32, 4) << 30) | (r.uintLessThan(u32, 2) << 26) | ((@as(u32, @bitCast(off(r, -200, 200))) & 0x7ffff) << 5) | dst(r), // literal
        64...68 => w = A.bcond(r.uintLessThan(u32, 16), off(r, -12, 24)),
        69...71 => w = (if (r.boolean()) @as(u32, 0x3400_0000) else 0xb400_0000) | (r.uintLessThan(u32, 2) << 24) | ((@as(u32, @bitCast(off(r, -12, 24))) & 0x7ffff) << 5) | anyReg(r), // cbz/cbnz
        72...73 => w = 0x3600_0000 | (r.uintLessThan(u32, 2) << 31) | (r.uintLessThan(u32, 2) << 24) | (r.uintLessThan(u32, 32) << 19) | ((@as(u32, @bitCast(off(r, -12, 24))) & 0x3fff) << 5) | anyReg(r), // tbz
        74...75 => w = A.b(off(r, -16, 40)),
        76 => w = A.bl(off(r, -16, 600)),
        77 => if (words_left >= 2) { // adr x16, target; br/blr x16
            const tgt: i32 = off(r, -20, 40);
            const imm: u32 = @bitCast(tgt * 4);
            out[i] = 0x1000_0000 | ((imm & 3) << 29) | (((imm >> 2) & 0x7ffff) << 5) | 16;
            out[i + 1] = (if (r.boolean()) @as(u32, 0xd61f_0000) else 0xd63f_0000) | (16 << 5);
            return 2;
        } else {
            w = A.nop;
        },
        78 => w = A.ret,
        79...80 => if (words_left >= 3) { // SMC: build a word, store it into the code
            const nw = A.addi(dst(r), dst(r), r.uintLessThan(u32, 4096));
            out[i] = A.movz(25, nw & 0xffff, 0);
            out[i + 1] = A.movk(25, nw >> 16, 1);
            out[i + 2] = 0xb900_0000 | (r.uintLessThan(u32, code_pages * 1024) << 10) | (19 << 5) | 25;
            return 3;
        } else {
            w = A.nop;
        },
        81 => w = switch (r.uintLessThan(u32, 4)) {
            0 => A.icivau(19),
            1 => A.isb,
            2 => 0xd503_3bbf, // dmb ish
            else => 0xd50b_7b20 | 19, // dc cvau, x19
        },
        82 => w = A.svc,
        83 => w = switch (r.uintLessThan(u32, 3)) {
            0 => 0xd420_0000, // brk #0
            1 => 0x0000_0000 | r.uintLessThan(u32, 65536), // udf
            else => r.int(u32),
        },
        84...87 => w = switch (r.uintLessThan(u32, 8)) { // FP and AdvSIMD
            0 => 0x1e60_2800 | (r.uintLessThan(u32, 32) << 16) | (r.uintLessThan(u32, 32) << 5) | r.uintLessThan(u32, 32), // fadd d
            1 => 0x9e67_0000 | (rn << 5) | r.uintLessThan(u32, 32), // fmov d, x
            2 => 0x6f00_e400 | r.uintLessThan(u32, 32), // movi v.2d, #0
            3 => 0x4ea0_1c00 | (r.uintLessThan(u32, 32) << 16) | (r.uintLessThan(u32, 32) << 5) | r.uintLessThan(u32, 32), // mov v.16b
            4 => 0x4ea0_8400 | (r.uintLessThan(u32, 32) << 16) | (r.uintLessThan(u32, 32) << 5) | r.uintLessThan(u32, 32), // add v.4s
            5 => 0x1e62_0000 | (rn << 5) | r.uintLessThan(u32, 32), // scvtf d, w
            6 => 0x1e60_2000 | (r.uintLessThan(u32, 32) << 16) | (r.uintLessThan(u32, 32) << 5), // fcmp d
            else => 0x9e66_0000 | (r.uintLessThan(u32, 32) << 5) | rd, // fmov x, d
        },
        88...89 => w = switch (r.uintLessThan(u32, 6)) { // system registers
            0 => 0xd53b_4200 | rd, // mrs nzcv
            1 => 0xd51b_4200 | rn, // msr nzcv
            2 => 0xd53b_d040 | rd, // mrs tpidr_el0
            3 => 0xd51b_d040 | rn, // msr tpidr_el0
            4 => 0xd53b_e040 | rd, // mrs cntvct_el0
            else => 0xd53b_4400 | rd, // mrs fpcr
        },
        90 => w = switch (r.uintLessThan(u32, 3)) { // exclusives on x20
            0 => 0xc85f_7c00 | (20 << 5) | dst(r), // ldxr
            1 => 0xc800_7c00 | (dst(r) << 16) | (20 << 5) | anyReg(r), // stxr
            else => 0xc8df_fc00 | (20 << 5) | dst(r), // ldar
        },
        91 => w = 0xb900_0000 | (@as(u32, @intCast(bell_off / 4)) << 10) | (20 << 5) | 27, // str w27, [x20, #bell]: doorbell
        92 => { // LSE atomics on a base: LD<op>/SWP (some reserved o3/opc), CAS, CASP
            const size = r.uintLessThan(u32, 4);
            const ar = r.uintLessThan(u32, 4) << 22; // A, R
            const lo0 = (r.uintLessThan(u32, 2) << 22) | (r.uintLessThan(u32, 2) << 15); // CAS(P): L, o0
            const bn = base(r);
            const even = [_]u32{ 0, 2, 4, 6, 8, 10, 12, 14, 16, 26, 28, 30 }; // pairs that leave the bases alone
            w = switch (r.uintLessThan(u32, 5)) {
                0, 1 => 0x3820_0000 | (size << 30) | ar | (anyReg(r) << 16) | (r.uintLessThan(u32, if (r.uintLessThan(u32, 8) == 0) 16 else 9) << 12) | (bn << 5) | (if (r.uintLessThan(u32, 4) == 0) 31 else dst(r)),
                2, 3 => (size << 30) | 0x08a0_7c00 | lo0 | ((if (r.uintLessThan(u32, 6) == 0) 31 else dst(r)) << 16) | (bn << 5) | anyReg(r), // cas
                else => (r.uintLessThan(u32, 2) << 30) | 0x0820_7c00 | lo0 | (even[r.uintLessThan(usize, even.len)] << 16) | (bn << 5) | (2 * r.uintLessThan(u32, 16)), // casp
            };
        },
        93 => w = A.nop,
        else => w = 0x9100_0000 | (r.uintLessThan(u32, 64) << 10) | (rn << 5) | rd,
    }
    out[i] = w;
    return 1;
}

const Fz = struct {
    m: [2]Machine,
    lazy_pa: [2]u64 = .{ 0, 0 },
    rng: Rng,
    events: usize = 0,

    fn both(f: *Fz, comptime func: anytype, args: anytype) void {
        for (&f.m) |*m| @call(.auto, func, .{m} ++ args);
    }
};

fn fuzzSetup(gpa: std.mem.Allocator, seed: u64) !Fz {
    var f: Fz = .{ .m = .{ try Machine.init(gpa), try Machine.init(gpa) }, .rng = Rng.init(seed) };
    const r = f.rng.random();
    var prog: [code_pages * 1024]u32 = undefined;
    var i: usize = 0;
    while (i < prog.len) i += gen(r, &prog, i);
    var regs: c.Regs = .{};
    const edges = [_]u64{ 0, 1, 2, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x1_0000_0000, 0x7fff_ffff_ffff_ffff, 0x8000_0000_0000_0000, std.math.maxInt(u64), 0xffff_ffff_8000_0000, 0x8000_0000_ffff_ffff };
    for (0..31) |k| regs.x[k] = switch (r.uintLessThan(u32, 8)) {
        0 => r.uintLessThan(u64, 16),
        1 => r.int(u64),
        2 => @as(u64, r.int(u32)),
        3 => 0 -% r.uintLessThan(u64, 16),
        4, 5 => edges[r.uintLessThan(usize, edges.len)],
        6 => if (k > 0) regs.x[r.uintLessThan(usize, k)] else 0, // equal operands
        else => r.uintLessThan(u64, 4096),
    };
    for (&regs.v) |*v| v.* = (@as(u128, r.int(u64)) << 64) | r.int(u64);
    regs.nzcv = r.uintLessThan(u32, 16) << 28;
    regs.x[19] = code_va;
    regs.x[20] = data_va + 64;
    regs.x[21] = data_va + 0x1000 + 512;
    regs.x[22] = data_va + 0x2000 + 2048;
    regs.x[23] = lazy_va + 1024;
    regs.x[24] = ro_va + 256;
    regs.x[27] = 1 + r.uintLessThan(u64, 1000);
    regs.sp = data_va + 0x3800;
    regs.pc = code_va;
    for (&f.m) |*m| {
        for (0..code_pages) |p| {
            const pa = m.frame();
            @memcpy(m.bytes(pa), std.mem.sliceAsBytes(prog[p * 1024 ..][0..1024]));
            m.map(code_va + p * 4096, pa, R | W | X);
        }
        for (0..4) |p| {
            const pa = m.frame();
            for (m.bytes(pa), 0..) |*b, j| b.* = @truncate(j *% 7 +% p *% 13 +% seed);
            m.map(data_va + p * 4096, pa, R | W);
        }
        const ro = m.frame();
        for (m.bytes(ro), 0..) |*b, j| b.* = @truncate(j *% 3);
        m.map(ro_va, ro, R);
        m.regs = regs;
    }
    // The tier's machine takes the doorbell; the reference runs to the
    // same instruction count (it would poll at other points).
    f.m[0].cpu.irq_pending = @ptrCast(@alignCast(f.m[0].at(data_va + bell_off).ptr));
    return f;
}

/// Totals of the JIT fuzz (wasm64 unit tests).
var jit_totals: struct { compiles: u64 = 0, entries: u64 = 0, handbacks: u64 = 0, grows: u64 = 0, flushes: u64 = 0 } = .{};

fn fuzzOne(gpa: std.mem.Allocator, seed: u64, max_insns: u64) !void {
    var f = try fuzzSetup(gpa, seed);
    defer for (&f.m) |*m| m.deinit();
    const r = f.rng.random();
    const T = &f.m[0];
    const Rm = &f.m[1];
    {
        // Half the runs on a small op arena: nursery resets (blocks keep
        // their table entry and countdown, their ops are decoded again) and,
        // with the JIT, a tenured ring that drops its oldest compiled blocks
        // happen during the run. A separate random stream, as below.
        var ar = Rng.init(seed ^ 0x3c6e_f372_fe94_f82b);
        if (ar.random().boolean()) {
            T.cpu.priv.nursery = 100 + ar.random().uintLessThan(u64, 3000);
            T.cpu.priv.ten_mask = (@as(u64, 2048) << ar.random().uintLessThan(u6, 3)) - 1;
            T.cpu.resetCache();
        }
    }
    if (jc.enabled) {
        // The JIT machine: a random compile threshold (eager or after a few
        // passes), region size and growth threshold, and a flush asked for
        // during every other compile (another CPU; jitcore.zig windowClose).
        // A separate random stream: the programs stay those of the native run.
        var jr = Rng.init(seed ^ 0x6a09_e667_f3bc_c908);
        const st = &T.cpu.priv.jit;
        st.threshold = if (jr.random().boolean()) 1 else 1 + jr.random().uintLessThan(u32, 200);
        st.region_max = 1 + jr.random().uintLessThan(u32, jc.max_members);
        st.grow_threshold = switch (jr.random().uintLessThan(u32, 3)) {
            0 => 1,
            1 => 16,
            else => 1 << 20,
        };
        jit_tests.hook = .{ .cpu = T.cpu, .flush_every = 2 };
    }
    defer if (jc.enabled) {
        const st = &T.cpu.priv.jit;
        jit_totals.compiles += st.compiles;
        jit_totals.entries += st.entries;
        jit_totals.handbacks += st.handbacks;
        jit_totals.grows += st.grows + st.exit_grows;
        jit_totals.flushes += jit_tests.hook.flushes;
        jit_tests.hook = .{};
    };
    while (T.cpu.icount < max_insns and f.events < 4000) {
        const slice: u64 = switch (r.uintLessThan(u32, 4)) {
            0 => 1 + r.uintLessThan(u64, 8),
            1 => 1 + r.uintLessThan(u64, 70),
            2 => 1 + r.uintLessThan(u64, 500),
            else => 1 + r.uintLessThan(u64, 5000),
        };
        const kt = T.run(slice);
        const delta = T.cpu.icount - Rm.cpu.icount;
        const kr = Rm.runRef(switch (kt) {
            mach.EV_BUDGET, mach.EV_INTERRUPT, mach.EV_SYSCALL => delta,
            else => delta + 1,
        });
        f.events += 1;
        const want: u32 = if (kt == mach.EV_INTERRUPT) mach.EV_BUDGET else kt;
        var bad = kr != want or T.cpu.icount != Rm.cpu.icount or !std.mem.eql(u8, std.mem.asBytes(&T.regs), std.mem.asBytes(&Rm.regs));
        if (kt != mach.EV_BUDGET and kt != mach.EV_INTERRUPT and !std.mem.eql(u8, std.mem.asBytes(&T.cpu.ev), std.mem.asBytes(&Rm.cpu.ev))) bad = true;
        if (!bad and (f.events % 8 == 0 or kt == mach.EV_FAULT) and !std.mem.eql(u8, T.mem[0..@intCast(T.next)], Rm.mem[0..@intCast(Rm.next)])) bad = true;
        if (bad) {
            std.debug.print("a64 fuzz seed {d}: event {d}, slice {d}: tier {d} icount {d} pc 0x{x}, reference {d} icount {d} pc 0x{x}\n", .{
                seed, f.events, slice, kt, T.cpu.icount, T.regs.pc, kr, Rm.cpu.icount, Rm.regs.pc,
            });
            std.debug.print("  ev tier {any}\n  ev ref  {any}\n", .{ T.cpu.ev, Rm.cpu.ev });
            for (0..31) |k| if (T.regs.x[k] != Rm.regs.x[k]) std.debug.print("  x{d}: 0x{x} vs 0x{x}\n", .{ k, T.regs.x[k], Rm.regs.x[k] });
            if (T.regs.sp != Rm.regs.sp) std.debug.print("  sp: 0x{x} vs 0x{x}\n", .{ T.regs.sp, Rm.regs.sp });
            if (T.regs.nzcv != Rm.regs.nzcv) std.debug.print("  nzcv: 0x{x} vs 0x{x}\n", .{ T.regs.nzcv, Rm.regs.nzcv });
            for (0..32) |k| if (T.regs.v[k] != Rm.regs.v[k]) std.debug.print("  v{d} differs\n", .{k});
            if (T.regs.tpidr_el0 != Rm.regs.tpidr_el0 or T.regs.fpsr != Rm.regs.fpsr) std.debug.print("  tpidr/fpsr differ\n", .{});
            if (!std.mem.eql(u8, T.mem[0..@intCast(T.next)], Rm.mem[0..@intCast(Rm.next)])) std.debug.print("  memory differs\n", .{});
            return error.TestUnexpectedResult;
        }
        // The "kernel": the same reaction on both machines.
        const ev = T.cpu.ev;
        switch (kt) {
            mach.EV_BUDGET, mach.EV_INTERRUPT => for (&f.m) |*m| std.mem.writeInt(u32, m.at(data_va + bell_off)[0..4], 0, .little),
            mach.EV_SYSCALL => {
                const v = r.int(u64);
                for (&f.m) |*m| m.regs.x[0] = v;
            },
            mach.EV_FAULT => {
                if (ev.addr >> 12 == lazy_va >> 12 and T.paOf(lazy_va) == 0) {
                    for (&f.m, 0..) |*m, j| {
                        if (f.lazy_pa[j] == 0) {
                            f.lazy_pa[j] = m.frame();
                            for (m.bytes(f.lazy_pa[j]), 0..) |*b, q| b.* = @truncate(q *% 5);
                        }
                        m.map(lazy_va, f.lazy_pa[j], R | W);
                    }
                } else if (ev.access == 2) {
                    for (&f.m) |*m| m.regs.pc = code_va;
                } else for (&f.m) |*m| {
                    m.regs.pc += 4;
                    m.regs.x[20] = data_va + 64;
                    m.regs.x[21] = data_va + 0x1000 + 512;
                    m.regs.x[22] = data_va + 0x2000 + 2048;
                    m.regs.x[23] = lazy_va + 1024;
                    m.regs.x[24] = ro_va + 256;
                    m.regs.sp = data_va + 0x3800;
                }
            },
            mach.EV_MISALIGNED => for (&f.m) |*m| {
                if (m.regs.pc & 3 != 0) m.regs.pc = code_va else m.regs.pc += 4;
            },
            else => for (&f.m) |*m| {
                m.regs.pc += 4; // illegal, breakpoint
            },
        }
        for (&f.m) |*m| kwemu.clearReservation(m.cpu);
        // Now and then the kernel changes things under the code.
        switch (r.uintLessThan(u32, 40)) {
            0 => for (&f.m) |*m| m.cpu.flushAll(),
            1 => for (&f.m) |*m| m.cpu.flushRange(code_va + 4096, code_va + 8192),
            2 => for (&f.m) |*m| kwemu.setPgd(m.cpu, m.root),
            3 => { // kernel rewrite of a code word, then the flush it owes
                const at = code_va + 4 * r.uintLessThan(u64, code_pages * 1024);
                var one: [3]u32 = undefined;
                _ = gen(r, &one, 2);
                for (&f.m) |*m| {
                    std.mem.writeInt(u32, m.at(at)[0..4], one[2], .little);
                    m.cpu.flushRange(at, at + 4);
                }
            },
            4 => { // COW: the second code page moves to a copy, maybe changed
                const at = 4 * r.uintLessThan(u64, 1024);
                var one: [3]u32 = undefined;
                _ = gen(r, &one, 2);
                const change = r.boolean();
                for (&f.m) |*m| {
                    const old = m.paOf(code_va + 4096);
                    const pa = m.frame();
                    @memcpy(m.bytes(pa), m.bytes(old));
                    if (change) std.mem.writeInt(u32, m.bytes(pa)[@intCast(at)..][0..4], one[2], .little);
                    m.map(code_va + 4096, pa, R | W | X);
                }
            },
            5 => if (T.paOf(lazy_va) != 0) for (&f.m) |*m| m.unmap(lazy_va),
            else => {},
        }
    }
}

test "a64 tier fuzz: random instruction soups, tier (wasm64 unit tests: the JIT) vs reference in lockstep (budgets, faults, irq, SMC, flushes, COW)" {
    const n: u64 = if (options.a64_fuzz != 0) options.a64_fuzz else 300;
    for (0..n) |k| {
        // A long run names its programs: a panic does not say the seed.
        if (options.a64_fuzz != 0 and (n <= 64 or k % 64 == 0)) std.debug.print("a64 fuzz: seeds from {d}\n", .{options.a64_fuzz_seed + k});
        try fuzzOne(t.allocator, options.a64_fuzz_seed + k, 30_000);
    }
    if (jc.enabled) std.debug.print("a64 jit fuzz: {d} programs: {d} compiles ({d} regions grown), {d} entries, {d} hand-backs, {d} flushes during a compile\n", .{
        n, jit_totals.compiles, jit_totals.grows, jit_totals.entries, jit_totals.handbacks, jit_totals.flushes,
    });
}
