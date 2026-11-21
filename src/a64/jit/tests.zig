// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Unit tests of the A64 JIT core (emit.zig, the JIT parts of tier.zig and
//! jitcore.zig as A64 uses it): hand-backs resume at op k with XZR = 0,
//! compiled self-loops keep the budget exact and poll *irq_pending and the
//! code epoch at their back edges, regions across pages, a flush asked for
//! during a compile. Each test also runs natively (the tier alone) where it
//! does not depend on compiled code. The per-kind tests are in the family
//! files (kindtest.zig), the block fuzz in tier_tests.zig.

const std = @import("std");
const t = std.testing;
const kwemu = @import("../../emu/kwemu.zig");
const jc = @import("../../emu/jitcore.zig");
const mach = @import("../machine.zig");
const tier = @import("../tier.zig");
const Machine = mach.Machine;
const Cpu = kwemu.Cpu;

/// The JIT host calls `kwemu_test_compile_hook` (tests_a64_wasm.zig) after
/// every compile, inside kwemu's compile window: what "another CPU" does
/// then.
pub const Hook = struct {
    /// Set this word to 1 (an interrupt raised during the compile).
    irq: ?*u32 = null,
    /// Ask this CPU for a full flush during every `flush_every`-th compile
    /// (0: never), as a CPU flushing TLBs would (jitcore.zig, windowClose).
    cpu: ?*Cpu = null,
    flush_every: u32 = 0,
    compiles: u32 = 0,
    flushes: u32 = 0,
    /// Called after every compile (after the above), with the compile's
    /// number (1, 2, ...): a family test's own stand-in for another CPU.
    call: ?*const fn (n: u32) void = null,
};
pub var hook: Hook = .{};

pub fn compileHook() void {
    hook.compiles += 1;
    if (hook.irq) |p| p.* = 1;
    if (hook.cpu) |cpu| {
        if (hook.flush_every != 0 and hook.compiles % hook.flush_every == 0) {
            // Another CPU sees the window open and asks instead of waiting.
            if (@atomicLoad(u32, &cpu.jit_busy, .seq_cst) == 1) {
                @atomicStore(u32, &cpu.flush_all, 1, .seq_cst);
                hook.flushes += 1;
            }
        }
    }
    if (hook.call) |f| f(hook.compiles);
}

const movz_x0_1: u32 = 0xd280_0020;
const movz_x0_7: u32 = 0xd280_00e0;
const movz_x1_5: u32 = 0xd280_00a1;
const movz_x2_3: u32 = 0xd280_0062;
const add_x4_x1_xzr: u32 = 0x8b1f_0024; // add x4, x1, xzr (shifted register): reads slot 32
const svc = mach.svc0;

fn b(from: u64, to: u64) u32 {
    return 0x1400_0000 | (@as(u32, @truncate((to -% from) >> 2)) & 0x3ff_ffff);
}

fn jitStats(m: *Machine) if (jc.enabled) *jc.State else void {
    if (jc.enabled) return &m.cpu.priv.jit;
}

test "a64 jit: a hand-back resumes at op k of the same decode with XZR = 0" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    // movi, movi (compiled), add_rr reading XZR (handed back), svc.
    m.code(0x10000, &.{ movz_x0_1, movz_x1_5, add_x4_x1_xzr, svc });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(100));
    try t.expectEqual(@as(u64, 5), m.regs.x[4]);
    try t.expectEqual(@as(u64, 1), m.regs.x[0]);
    try t.expectEqual(@as(u64, 0x10010), m.regs.pc);
    try t.expectEqual(@as(u64, 4), m.cpu.icount);
    if (jc.enabled) {
        const st = jitStats(&m);
        try t.expect(st.compiles >= 1);
        try t.expect(st.handbacks >= 1);
    }
}

/// movz x0, #7; b . - 4: a self-loop of two instructions at 0x10000.
fn selfLoop(m: *Machine) void {
    m.code(0x10000, &.{ movz_x0_7, b(0x10004, 0x10000) });
}

test "a64 jit: a compiled self-loop retires exactly its budget" {
    for ([_]u64{ 1, 2, 3, 999, 1000, 1001 }) |budget| {
        var m = try Machine.init(t.allocator);
        defer m.deinit();
        selfLoop(&m);
        try t.expectEqual(@as(u32, mach.EV_BUDGET), m.run(budget));
        try t.expectEqual(budget, m.cpu.icount);
        try t.expectEqual(@as(u64, if (budget % 2 == 0) 0x10000 else 0x10004), m.regs.pc);
        try t.expectEqual(@as(u64, 7), m.regs.x[0]);
        if (jc.enabled and budget >= 1000) try t.expect(jitStats(&m).entries <= 2);
    }
}

test "a64 jit: a compiled self-loop polls *irq_pending at its back edge" {
    if (!jc.enabled) return error.SkipZigTest;
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    var irq: u32 = 0;
    m.cpu.irq_pending = &irq;
    selfLoop(&m);
    hook = .{ .irq = &irq };
    defer hook = .{};
    // The interrupt is raised during the compile: the first pass runs, the
    // back edge sees it.
    try t.expectEqual(@as(u32, mach.EV_INTERRUPT), m.run(100_000));
    try t.expectEqual(@as(u64, 2), m.cpu.icount);
    try t.expectEqual(@as(u64, 0x10000), m.regs.pc);
}

test "a64 jit: a compiled self-loop polls the code epoch at its back edge" {
    if (!jc.enabled) return error.SkipZigTest;
    for ([_]bool{ false, true }) |changed| {
        var m = try Machine.init(t.allocator);
        defer m.deinit();
        selfLoop(&m);
        // A stand-in for the global epoch that another CPU bumped: compiled
        // code reads it through epoch_ptr; `run` reads the real one (which
        // did not change), so each stop resumes at the next lookup.
        var fake: u64 = m.cpu.priv.a64.seen_epoch +% @intFromBool(changed);
        m.cpu.priv.a64.epoch_ptr = @intFromPtr(&fake);
        try t.expectEqual(@as(u32, mach.EV_BUDGET), m.run(1000));
        try t.expectEqual(@as(u64, 1000), m.cpu.icount);
        try t.expectEqual(@as(u64, 0x10000), m.regs.pc);
        const entries = jitStats(&m).entries;
        if (changed) try t.expect(entries >= 450) else try t.expectEqual(@as(u64, 1), entries);
    }
}

test "a64 jit: two blocks on two pages that branch to each other form a region" {
    // Every budget from 1 to 40 stops at some member boundary or inside a
    // member (single-stepped); registers start nonzero, so a member's
    // registers written back without having been loaded would show.
    var budgets: [44]u64 = undefined;
    for (0..40) |i| budgets[i] = i + 1;
    budgets[40..].* = .{ 1000, 9999, 10000, 10001 };
    for (budgets) |budget| {
        var ms: [2]Machine = .{ try Machine.init(t.allocator), try Machine.init(t.allocator) };
        defer for (&ms) |*m| m.deinit();
        for (&ms) |*m| {
            m.code(0x20000, &.{ movz_x1_5, b(0x20004, 0x10000) });
            m.code(0x10000, &.{ movz_x0_1, movz_x2_3, b(0x10008, 0x20000) });
            for (0..3) |k| m.regs.x[k] = 0x1111 * (k + 7);
            if (jc.enabled) m.cpu.priv.jit.grow_threshold = 1;
        }
        const kt = ms[0].run(budget);
        const kr = ms[1].runRef(budget);
        try t.expectEqual(kr, kt);
        try t.expectEqual(ms[1].cpu.icount, ms[0].cpu.icount);
        try t.expect(std.mem.eql(u8, std.mem.asBytes(&ms[0].regs), std.mem.asBytes(&ms[1].regs)));
        if (jc.enabled and budget >= 1000) {
            const st = jitStats(&ms[0]);
            // The first region grew along its exit to the other page.
            try t.expect(st.exit_grows >= 1);
            try t.expect(st.entries < 100);
        }
    }
}

test "a64 jit: a flush asked for during a compile looks the block up again" {
    if (!jc.enabled) return error.SkipZigTest;
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.code(0x10000, &.{ movz_x0_1, movz_x1_5, svc });
    hook = .{ .cpu = m.cpu, .flush_every = 1 };
    defer hook = .{};
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(100));
    try t.expectEqual(@as(u64, 5), m.regs.x[1]);
    try t.expectEqual(@as(u64, 3), m.cpu.icount);
    try t.expect(hook.flushes >= 1);
}

/// ADDs per chain page: with the branch, one block (`tier.max_block`).
const chain_adds = @min(40, tier.max_block - 1);

/// An outer loop of `iters` passes over a self-loop at 0x10000 (x1 counts
/// down from 100) and a chain of 19 pages from 0x40000, each `chain_adds`
/// ADDs of x3 and a branch to the next; a 20th page counts x2 down and
/// branches back to 0x10000, then SVC. Each pass decodes 800 to 1000 arena
/// slots.
fn chainProgram(m: *Machine, iters: u16) void {
    const add_x0_1: u32 = 0x9100_0400; // add x0, x0, #1
    const add_x3_1: u32 = 0x9100_0463; // add x3, x3, #1
    const subs_x1_1: u32 = 0xf100_0421; // subs x1, x1, #1
    const subs_x2_1: u32 = 0xf100_0442; // subs x2, x2, #1
    const bne_back3: u32 = 0x5400_0000 | ((@as(u32, @bitCast(@as(i32, -2))) & 0x7ffff) << 5) | 1; // b.ne . - 8
    const movz_x1_100: u32 = 0xd280_0c81;
    m.code(0x10000, &.{ add_x0_1, subs_x1_1, bne_back3, movz_x1_100, b(0x10010, 0x40000) });
    var w: [chain_adds + 1]u32 = undefined;
    for (0..chain_adds) |i| w[i] = add_x3_1;
    for (0..19) |p| {
        const va = 0x40000 + p * 4096;
        w[chain_adds] = b(va + 4 * chain_adds, va + 4096);
        m.code(va, &w);
    }
    const last = 0x40000 + 19 * 4096;
    m.code(last, &.{ subs_x2_1, 0x5400_0000 | ((@as(u32, @truncate((0x10000 -% (last + 4)) >> 2)) & 0x7ffff) << 5) | 1, svc });
    m.regs.x[1] = 100;
    m.regs.x[2] = iters;
    m.regs.pc = 0x10000;
}

fn shrinkArena(m: *Machine, nursery: u64, tenured: u64) void {
    m.cpu.priv.nursery = nursery;
    m.cpu.priv.ten_mask = tenured - 1;
    m.cpu.resetCache();
}

test "a64 jit: nursery resets and the tenured ring keep running the right code" {
    // Nursery of 600 slots (a reset every pass); tenured rings that hold
    // less than everything compiled (the oldest go), or all of it.
    for ([_]u64{ 2048, 4096, 65536 }) |ten| {
        var ms: [2]Machine = .{ try Machine.init(t.allocator), try Machine.init(t.allocator) };
        defer for (&ms) |*m| m.deinit();
        for (&ms) |*m| {
            chainProgram(m, 6);
            shrinkArena(m, 600, ten);
        }
        const kt = ms[0].run(1 << 30);
        const kr = ms[1].runRef(1 << 30);
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), kr);
        try t.expectEqual(kr, kt);
        try t.expectEqual(ms[1].cpu.icount, ms[0].cpu.icount);
        try t.expect(std.mem.eql(u8, std.mem.asBytes(&ms[0].regs), std.mem.asBytes(&ms[1].regs)));
        try t.expectEqual(@as(u64, 6 * 19 * chain_adds), ms[0].regs.x[3]);
        if (jc.enabled and ten >= 4096) {
            // Everything is compiled once (eager host: at its first pass) and
            // stays compiled across the nursery resets of later passes.
            const st = jitStats(&ms[0]);
            try t.expect(st.compiles <= 23);
            try t.expect(st.entries >= 6 * 20);
        }
    }
}

test "a64 jit: a block decoded again after a nursery reset goes on counting" {
    if (!jc.enabled) return error.SkipZigTest;
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    chainProgram(&m, 5);
    shrinkArena(&m, 600, 60000);
    m.cpu.priv.jit.threshold = 1000;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(1 << 30));
    // The first chain page (one block) ran 5 times, each pass decoded anew
    // after a reset: 5 passes charged in all, not just the last pass.
    const pc: u64 = 0x40000;
    const set = kwemu.blockSet(pc);
    const blk = for (m.cpu.priv.blocks[set..][0..2]) |*x| {
        if (x.pc == pc) break x;
    } else return error.TestUnexpectedResult;
    try t.expectEqual(@as(u32, 1000 - 5 * (chain_adds + 1)), blk.jx.st);
}
