// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Unit tests of the LSE atomics (lse.zig): encodings against the
//! assembler, known answers of every operation and size at the edges,
//! register aliasing (Rs == Rt, Rn == SP, XZR forms), CAS and CASP results,
//! alignment and precise faults (write permission also for a failing CAS),
//! the feature switch, ILLEGAL neighbours, the exclusive monitor, and the
//! shared-memory (SMP) paths on host threads. test/guest/a64/lsetest.c compares
//! every form with qemu.

const std = @import("std");
const t = std.testing;
const c = @import("common.zig");
const core = @import("../cpu/core.zig");
const lse = @import("lse.zig");
const excl = @import("excl.zig");
const run = @import("run.zig");
const mach = @import("machine.zig");
const Machine = mach.Machine;

const svc0 = mach.svc0;

/// LD<op>/SWP: size 111 0 00 A R 1 Rs o3 opc 00 Rn Rt
fn ldop(size: u32, a: u32, r: u32, op: lse.Op, rs: u32, rn: u32, rt: u32) u32 {
    const o3: u32 = if (op == .swp) 1 else 0;
    const opc: u32 = if (op == .swp) 0 else @intFromEnum(op);
    return (size << 30) | 0x3820_0000 | (a << 23) | (r << 22) | (rs << 16) | (o3 << 15) | (opc << 12) | (rn << 5) | rt;
}
/// CAS: size 001000 1 L 1 Rs o0 11111 Rn Rt
fn casw(size: u32, l: u32, o0: u32, rs: u32, rn: u32, rt: u32) u32 {
    return (size << 30) | 0x08a0_7c00 | (l << 22) | (rs << 16) | (o0 << 15) | (rn << 5) | rt;
}
/// CASP: 0 sz 001000 0 L 1 Rs o0 11111 Rn Rt
fn caspw(x: bool, l: u32, o0: u32, rs: u32, rn: u32, rt: u32) u32 {
    return (@as(u32, @intFromBool(x)) << 30) | 0x0820_7c00 | (l << 22) | (rs << 16) | (o0 << 15) | (rn << 5) | rt;
}

fn get64(m: *Machine, va: u64) u64 {
    return std.mem.readInt(u64, m.at(va)[0..8], .little);
}
fn put64(m: *Machine, va: u64, v: u64) void {
    std.mem.writeInt(u64, m.at(va)[0..8], v, .little);
}
/// Rewrite the code page at `va` (mapped by m.code once) in place: m.code
/// takes a new frame per call.
fn recode(m: *Machine, va: u64, words: []const u32) void {
    @memcpy(m.at(va)[0 .. words.len * 4], std.mem.sliceAsBytes(words));
    m.cpu.flushAll();
    m.regs.pc = va;
}

test "a64 lse: encodings match the assembler" {
    // llvm-objdump of `.arch armv8.1-a` assembled by zig cc
    try t.expectEqual(@as(u32, 0xf8210062), ldop(3, 0, 0, .add, 1, 3, 2)); // ldadd x1, x2, [x3]
    try t.expectEqual(@as(u32, 0xb8e103e2), ldop(2, 1, 1, .add, 1, 31, 2)); // ldaddal w1, w2, [sp]
    try t.expectEqual(@as(u32, 0x38210062), ldop(0, 0, 0, .add, 1, 3, 2)); // ldaddb
    try t.expectEqual(@as(u32, 0x78a10062), ldop(1, 1, 0, .add, 1, 3, 2)); // ldaddah
    try t.expectEqual(@as(u32, 0xf8611062), ldop(3, 0, 1, .clr, 1, 3, 2)); // ldclrl
    try t.expectEqual(@as(u32, 0xb8a420c5), ldop(2, 1, 0, .eor, 4, 6, 5)); // ldeora w4, w5, [x6]
    try t.expectEqual(@as(u32, 0xf8273128), ldop(3, 0, 0, .set, 7, 9, 8)); // ldset x7, x8, [x9]
    try t.expectEqual(@as(u32, 0xb8214062), ldop(2, 0, 0, .smax, 1, 3, 2));
    try t.expectEqual(@as(u32, 0xf8215062), ldop(3, 0, 0, .smin, 1, 3, 2));
    try t.expectEqual(@as(u32, 0xb8216062), ldop(2, 0, 0, .umax, 1, 3, 2));
    try t.expectEqual(@as(u32, 0xf8217062), ldop(3, 0, 0, .umin, 1, 3, 2));
    try t.expectEqual(@as(u32, 0xf8218062), ldop(3, 0, 0, .swp, 1, 3, 2)); // swp x1, x2, [x3]
    try t.expectEqual(@as(u32, 0xb8e18062), ldop(2, 1, 1, .swp, 1, 3, 2)); // swpal
    try t.expectEqual(@as(u32, 0x38218062), ldop(0, 0, 0, .swp, 1, 3, 2)); // swpb
    try t.expectEqual(@as(u32, 0xf821007f), ldop(3, 0, 0, .add, 1, 3, 31)); // stadd x1, [x3]
    try t.expectEqual(@as(u32, 0xb861007f), ldop(2, 0, 1, .add, 1, 3, 31)); // staddl w1, [x3]
    try t.expectEqual(@as(u32, 0xc8a17c62), casw(3, 0, 0, 1, 3, 2)); // cas x1, x2, [x3]
    try t.expectEqual(@as(u32, 0x88e1ffe2), casw(2, 1, 1, 1, 31, 2)); // casal w1, w2, [sp]
    try t.expectEqual(@as(u32, 0x08a17c62), casw(0, 0, 0, 1, 3, 2)); // casb
    try t.expectEqual(@as(u32, 0x48e17c62), casw(1, 1, 0, 1, 3, 2)); // casah
    try t.expectEqual(@as(u32, 0x48207c82), caspw(true, 0, 0, 0, 4, 2)); // casp x0, x1, x2, x3, [x4]
    try t.expectEqual(@as(u32, 0x0864ffe6), caspw(false, 1, 1, 4, 31, 6)); // caspal w4, w5, w6, w7, [sp]
}

/// The independent reference of an atomic memory operation at `bits` bits
/// (on i128/u128 values, not lse.apply).
fn refOp(op: lse.Op, bits_: u7, old: u64, v: u64) u64 {
    const mask: u64 = if (bits_ == 64) std.math.maxInt(u64) else (@as(u64, 1) << @intCast(bits_)) - 1;
    const a = old & mask;
    const b = v & mask;
    const sa: i128 = @as(i64, @bitCast(c.sextN(a, bits_)));
    const sb: i128 = @as(i64, @bitCast(c.sextN(b, bits_)));
    return mask & switch (op) {
        .add => a +% b,
        .clr => a & ~b,
        .eor => a ^ b,
        .set => a | b,
        .smax => if (sa >= sb) a else b,
        .smin => if (sa <= sb) a else b,
        .umax => if (a >= b) a else b,
        .umin => if (a <= b) a else b,
        .swp => b,
    };
}

const edges = [_]u64{
    0,                     1,                     0x7f,                  0x80,                  0xff,
    0x7fff,                0x8000,                0xffff,                0x7fff_ffff,           0x8000_0000,
    0xffff_ffff,           0x1_0000_0000,         0x7fff_ffff_ffff_ffff, 0x8000_0000_0000_0000, 0xffff_ffff_ffff_ffff,
    0x0123_4567_89ab_cdef, 0xfedc_ba98_7654_3210, 0x8000_0000_8000_8080, 0x7fff_7fff_7fff_7f7f,
};

test "a64 lse: every operation and size on edge values, Rt zero-extended, memory beside untouched" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    m.code(0x10000, &.{ svc0, svc0 });
    const ops = [_]lse.Op{ .add, .clr, .eor, .set, .smax, .smin, .umax, .umin, .swp };
    for (ops) |op| for (0..4) |size_| for (edges) |old| for (edges) |v| {
        const size: u2 = @intCast(size_);
        const bits_: u7 = @as(u7, 8) << size;
        const va: u64 = 0x20100 + (@as(u64, 1) << size); // aligned, not at the start of a word
        put64(&m, 0x20100, 0x5a5a_5a5a_5a5a_5a5a);
        put64(&m, 0x20108, 0xa5a5_a5a5_a5a5_a5a5);
        const mask: u64 = if (size == 3) std.math.maxInt(u64) else (@as(u64, 1) << @intCast(bits_)) - 1;
        var buf = m.at(va)[0..8];
        var before: [16]u8 = undefined;
        std.mem.writeInt(u64, buf, (std.mem.readInt(u64, buf, .little) & ~mask) | (old & mask), .little);
        @memcpy(&before, m.at(0x20100)[0..16]);
        m.regs.x[1] = v;
        m.regs.x[2] = 0xdead_beef_dead_beef;
        m.regs.x[3] = va;
        const a: u32 = @intCast((old ^ v) & 1);
        const r: u32 = @intCast((old >> 1) & 1);
        recode(&m, 0x10000, &.{ ldop(size, a, r, op, 1, 3, 2), svc0 });
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
        try t.expectEqual(old & mask, m.regs.x[2]);
        try t.expectEqual(v, m.regs.x[1]);
        buf = m.at(va)[0..8];
        const now = std.mem.readInt(u64, buf, .little);
        try t.expectEqual(refOp(op, bits_, old, v), now & mask);
        // the bytes outside the access are unchanged
        const after = m.at(0x20100)[0..16];
        const off: usize = @intCast(va - 0x20100);
        for (0..16) |i| if (i < off or i >= off + (@as(usize, 1) << size)) try t.expectEqual(before[i], after[i]);
    };
}

test "a64 lse: register aliasing: Rs == Rt, Rn == SP, XZR as Rs and Rt (ST<op>), Rn == Rt" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    put64(&m, 0x20000, 10);
    put64(&m, 0x20008, 0x8000_0000_0000_0005);
    put64(&m, 0x20010, 0xffff_ffff_0000_0003);
    m.regs.sp = 0x20008;
    m.regs.x[0] = 0x20000;
    m.regs.x[5] = 7;
    m.regs.x[6] = 0x20010;
    m.code(0x10000, &.{
        ldop(3, 1, 1, .add, 5, 0, 5), // ldaddal x5, x5, [x0]: x5 = 10, mem = 17
        ldop(3, 0, 0, .add, 0, 31, 7), // ldadd x0, x7, [sp]: x7 = old, mem += 0x20000
        ldop(3, 0, 0, .set, 31, 0, 8), // ldset xzr, x8, [x0]: a load (x8 = 17), mem unchanged
        ldop(3, 0, 1, .add, 5, 0, 31), // staddl x5, [x0]: mem = 27, no register written
        ldop(2, 0, 0, .swp, 6, 6, 6), // swp w6, w6, [x6]: w6 = old low word, mem = low word of x6
        casw(3, 0, 0, 9, 0, 9), // cas x9, x9, [x0]: compare fails (x9 = 0 != 27): x9 = 27
        casw(3, 1, 1, 9, 0, 31), // casal x9, xzr, [x0]: passes: mem = 0, x9 = 27
        casw(2, 0, 0, 31, 0, 10), // cas wzr, w10, [x0]: compare with 0 passes, mem = w10; xzr not written
        svc0,
    });
    m.regs.x[9] = 0;
    m.regs.x[10] = 0x1234_5678_9abc_def0;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(20));
    try t.expectEqual(@as(u64, 10), m.regs.x[5]);
    try t.expectEqual(@as(u64, 0x8000_0000_0000_0005), m.regs.x[7]);
    try t.expectEqual(@as(u64, 0x8000_0000_0002_0005), get64(&m, 0x20008));
    try t.expectEqual(@as(u64, 17), m.regs.x[8]);
    try t.expectEqual(@as(u64, 3), m.regs.x[6]); // the old low word, zero-extended
    try t.expectEqual(@as(u64, 0xffff_ffff_0002_0010), get64(&m, 0x20010));
    try t.expectEqual(@as(u64, 27), m.regs.x[9]);
    try t.expectEqual(@as(u64, 0x9abc_def0), get64(&m, 0x20000)); // W store into a zero word
    try t.expectEqual(@as(u64, 0x20008), m.regs.sp);
}

test "a64 lse: CAS of every size writes Rs zero-extended, passes on the low bits only" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    for (0..4) |size_| for ([_]bool{ false, true }) |match| {
        const size: u2 = @intCast(size_);
        put64(&m, 0x20000, 0x8899_aabb_ccdd_eeff);
        const mask: u64 = if (size == 3) std.math.maxInt(u64) else (@as(u64, 1) << (@as(u6, 8) << size)) - 1;
        // Rs has its high bits set beyond the size: they do not take part
        m.regs.x[1] = if (match) (0x8899_aabb_ccdd_eeff & mask) | (~mask & 0x1111_1111_1111_1111) else 0x42;
        m.regs.x[2] = 0x0102_0304_0506_0708;
        m.regs.x[3] = 0x20000;
        m.code(0x10000, &.{ casw(size, @intCast(size & 1), @intCast(size >> 1), 1, 3, 2), svc0 });
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
        try t.expectEqual(0x8899_aabb_ccdd_eeff & mask, m.regs.x[1]);
        const want = if (match) (0x8899_aabb_ccdd_eeff & ~mask) | (0x0102_0304_0506_0708 & mask) else 0x8899_aabb_ccdd_eeff;
        try t.expectEqual(want, get64(&m, 0x20000));
    };
}

test "a64 lse: CASP of W and X pairs, Rs = 30 with XZR, odd registers ILLEGAL" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    put64(&m, 0x20000, 0x1111_1111_2222_2222);
    put64(&m, 0x20010, 0x3333);
    put64(&m, 0x20018, 0x4444);
    m.regs.x[0] = 0x2222_2222;
    m.regs.x[1] = 0xffff_ffff_1111_1111; // the high half of a W register is ignored
    m.regs.x[2] = 0xaaaa_0000_0000_0005;
    m.regs.x[3] = 6;
    m.regs.x[4] = 0x3333;
    m.regs.x[5] = 0x4444;
    m.regs.x[6] = 0x20000;
    m.regs.x[7] = 0x20010;
    m.regs.x[8] = 0x5555;
    m.regs.x[9] = 0x6666;
    m.code(0x10000, &.{
        caspw(false, 0, 0, 0, 6, 2), // casp w0, w1, w2, w3, [x6]: passes
        caspw(true, 1, 1, 4, 7, 8), // caspal x4, x5, x8, x9, [x7]: passes
        caspw(true, 0, 0, 4, 7, 8), // again: fails (memory holds x8:x9), x4:x5 = it
        svc0,
    });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 0x2222_2222), m.regs.x[0]);
    try t.expectEqual(@as(u64, 0x1111_1111), m.regs.x[1]);
    try t.expectEqual(@as(u64, 0x0000_0006_0000_0005), get64(&m, 0x20000));
    try t.expectEqual(@as(u64, 0x5555), get64(&m, 0x20010));
    try t.expectEqual(@as(u64, 0x6666), get64(&m, 0x20018));
    try t.expectEqual(@as(u64, 0x5555), m.regs.x[4]);
    try t.expectEqual(@as(u64, 0x6666), m.regs.x[5]);
    // Rs = 30: the pair is x30 and XZR (compare with 0, the write to it dropped)
    put64(&m, 0x20010, 0x77);
    put64(&m, 0x20018, 0);
    m.regs.x[30] = 0x77;
    m.code(0x11000, &.{ caspw(true, 0, 0, 30, 7, 8), svc0 });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 0x77), m.regs.x[30]);
    try t.expectEqual(@as(u64, 0x5555), get64(&m, 0x20010));
    // a mismatch in the high half alone fails
    m.regs.x[4] = 0x5555;
    m.regs.x[5] = 0x6667;
    m.code(0x12000, &.{ caspw(true, 0, 0, 4, 7, 8), svc0 });
    m.regs.x[8] = 1;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 0x5555), get64(&m, 0x20010));
    try t.expectEqual(@as(u64, 0x6666), m.regs.x[5]);
    // odd Rs or Rt
    for ([_]u32{ caspw(true, 0, 0, 1, 7, 8), caspw(false, 0, 0, 4, 7, 9), caspw(true, 1, 1, 31, 7, 8) }) |w| {
        m.code(0x13000, &.{w});
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), m.run(10));
        try t.expectEqual(@as(u64, w), m.cpu.ev.insn);
    }
}

test "a64 lse: alignment faults, write faults (also a failing CAS), no effect" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    const mis = [_]struct { inst: u32, addr: u64 }{
        .{ .inst = ldop(3, 0, 0, .add, 1, 3, 2), .addr = 0x20004 },
        .{ .inst = ldop(1, 1, 1, .umax, 1, 3, 2), .addr = 0x20001 },
        .{ .inst = ldop(2, 0, 0, .swp, 1, 3, 2), .addr = 0x20002 },
        .{ .inst = casw(3, 0, 0, 1, 3, 2), .addr = 0x2000c },
        .{ .inst = casw(1, 0, 0, 1, 3, 2), .addr = 0x20003 },
        .{ .inst = caspw(false, 0, 0, 0, 3, 4), .addr = 0x20004 }, // a W pair needs 8
        .{ .inst = caspw(true, 0, 0, 0, 3, 4), .addr = 0x20008 }, // an X pair needs 16
    };
    for (mis) |cs| {
        for (0..6) |r| m.regs.x[r] = 0xa0 + r;
        m.regs.x[3] = cs.addr;
        m.code(0x10000, &.{cs.inst});
        try t.expectEqual(@as(u32, mach.EV_MISALIGNED), m.run(10));
        try t.expectEqual(cs.addr, m.cpu.ev.addr);
        try t.expectEqual(@as(u64, 0x10000), m.regs.pc);
        for (0..6) |r| if (r != 3) try t.expectEqual(0xa0 + r, m.regs.x[r]);
    }
    // byte accesses are always aligned
    m.regs.x[3] = 0x20003;
    m.code(0x10000, &.{ ldop(0, 0, 0, .add, 1, 3, 2), casw(0, 0, 0, 1, 3, 2), svc0 });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));

    // A read-only page: every form is a write fault with no effect, even a
    // CAS whose compare fails and an LD<op> into XZR; a W pair too.
    const ro = m.frame();
    m.map(0x30000, ro, 2); // R
    m.bytes(ro)[16] = 0x5a;
    const words = [_]u32{
        ldop(3, 0, 0, .add, 1, 3, 2),
        ldop(2, 1, 1, .set, 31, 3, 31),
        ldop(0, 0, 0, .swp, 1, 3, 2),
        casw(3, 0, 0, 1, 3, 2), // compare fails (memory 0x5a, x1 = 0xa1)
        casw(0, 0, 0, 1, 3, 2),
        caspw(false, 0, 0, 0, 3, 4),
        caspw(true, 1, 1, 0, 3, 4),
    };
    for (words) |w| {
        for (0..6) |r| m.regs.x[r] = 0xa0 + r;
        m.regs.x[3] = 0x30010;
        m.code(0x11000, &.{ w, svc0 });
        try t.expectEqual(@as(u32, mach.EV_FAULT), m.run(10));
        try t.expectEqual(@as(u32, 1), m.cpu.ev.access);
        try t.expectEqual(@as(u64, 0x11000), m.regs.pc);
        for (0..6) |r| if (r != 3) try t.expectEqual(0xa0 + r, m.regs.x[r]);
        try t.expectEqual(@as(u8, 0x5a), m.bytes(ro)[16]);
    }
    // once writable, the same CAS completes (compare fails: x1 = memory)
    m.map(0x30000, ro, 2 | 4);
    m.regs.x[1] = 0xa1;
    m.code(0x11000, &.{ casw(3, 0, 0, 1, 3, 2), svc0 });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 0x5a), m.regs.x[1]);
    // unmapped: a write fault too
    m.regs.x[3] = 0x40000;
    m.regs.x[2] = 0xa2;
    m.code(0x12000, &.{ldop(3, 0, 0, .add, 1, 3, 2)});
    try t.expectEqual(@as(u32, mach.EV_FAULT), m.run(10));
    try t.expectEqual(@as(u32, 1), m.cpu.ev.access);
    try t.expectEqual(@as(u64, 0xa2), m.regs.x[2]);
}

test "a64 lse: ILLEGAL while disabled, reserved neighbours ILLEGAL, ID_AA64ISAR0_EL1.Atomic" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    m.regs.x[3] = 0x20000;
    m.regs.x[4] = 0x20000;
    const legal = [_]u32{ ldop(3, 0, 0, .add, 1, 3, 2), ldop(2, 1, 1, .swp, 1, 3, 2), ldop(0, 0, 1, .umin, 1, 3, 31), casw(3, 1, 1, 1, 3, 2), caspw(true, 0, 0, 0, 4, 2), caspw(false, 1, 0, 6, 4, 8) };
    for (legal) |w| {
        m.code(0x10000, &.{ w, svc0 });
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    }
    const reserved = [_]u32{
        ldop(3, 0, 0, .add, 1, 3, 2) | (1 << 26), // V = 1 (FEAT_LSFE)
        ldop(3, 0, 0, .add, 1, 3, 2) | (1 << 15) | (1 << 12), // o3 = 1, opc = 001 (ST64BV0, RCWCLR)
        ldop(3, 0, 0, .add, 1, 3, 2) | (1 << 15) | (2 << 12),
        ldop(3, 0, 0, .add, 1, 3, 2) | (1 << 15) | (3 << 12), // ST64B, LD64B
        ldop(3, 1, 0, .add, 31, 3, 2) | (1 << 15) | (4 << 12), // LDAPR (FEAT_LRCPC)
        ldop(3, 0, 0, .add, 1, 3, 2) | (1 << 15) | (5 << 12),
        ldop(3, 0, 0, .add, 1, 3, 2) | (1 << 15) | (7 << 12),
        casw(3, 0, 0, 1, 3, 2) & ~@as(u32, 1 << 10), // CAS with Rt2 != 11111
        caspw(true, 0, 0, 0, 4, 2) & ~@as(u32, 1 << 12), // CASP with Rt2 != 11111
        caspw(true, 0, 0, 0, 4, 2) | (1 << 16), // CASP with an odd Rs
        caspw(true, 0, 0, 0, 4, 2) | 1, // CASP with an odd Rt
    };
    for (reserved) |w| {
        m.code(0x11000, &.{w});
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), m.run(10));
        try t.expectEqual(@as(u64, w), m.cpu.ev.insn);
    }
    // ID_AA64ISAR0_EL1.Atomic = 2 while enabled
    const mrs_isar0: u32 = 0xd538_0600; // mrs x0, id_aa64isar0_el1
    m.code(0x12000, &.{ mrs_isar0, svc0 });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 2), (m.regs.x[0] >> 20) & 15);
    // disabled: every legal form is ILLEGAL, nothing written; Atomic = 0
    try t.expectEqual(c.implemented & ~c.featureBit(.lse), run.setIsa(m.cpu, c.implemented & ~c.featureBit(.lse)));
    put64(&m, 0x20000, 99);
    for (legal) |w| {
        m.regs.x[2] = 0xa2;
        m.code(0x13000, &.{w});
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), m.run(10));
        try t.expectEqual(@as(u64, 0xa2), m.regs.x[2]);
        try t.expectEqual(@as(u64, 99), get64(&m, 0x20000));
    }
    m.code(0x14000, &.{ mrs_isar0, svc0 });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 0), (m.regs.x[0] >> 20) & 15);
}

test "a64 lse: stores into the running block take effect at the next instruction" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    // code in a writable page: SWP replaces the next instruction (nop) by
    // `mov x0, #42`, CAS the one after it by `mov x1, #7`
    const pa = m.frame();
    const words = [_]u32{ ldop(2, 0, 0, .swp, 5, 3, 6), 0xd503201f, casw(2, 0, 0, 7, 4, 8), 0xd503201f, svc0 };
    @memcpy(m.bytes(pa)[0 .. words.len * 4], std.mem.sliceAsBytes(&words));
    m.map(0x10000, pa, 2 | 4 | 8);
    m.regs.pc = 0x10000;
    m.regs.x[3] = 0x10004;
    m.regs.x[4] = 0x1000c;
    m.regs.x[5] = 0xd280_0540; // mov x0, #42
    m.regs.x[7] = 0xd503201f;
    m.regs.x[8] = 0xd280_00e1; // mov x1, #7
    for (0..2) |pass| {
        if (pass == 1) {
            // again from the reference loop
            @memcpy(m.bytes(pa)[0 .. words.len * 4], std.mem.sliceAsBytes(&words));
            m.cpu.flushAll();
            m.regs.pc = 0x10000;
            m.regs.x[7] = 0xd503201f;
        }
        m.regs.x[0] = 0;
        m.regs.x[1] = 0;
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), if (pass == 0) m.run(10) else m.runRef(10));
        try t.expectEqual(@as(u64, 42), m.regs.x[0]);
        try t.expectEqual(@as(u64, 7), m.regs.x[1]);
        try t.expectEqual(@as(u64, 0xd503201f), m.regs.x[6]);
    }
}

test "a64 lse: the exclusive monitor stays open across an LSE store on one CPU" {
    // One CPU: stores do not close the monitor (IMPLEMENTATION DEFINED); an
    // LSE atomic is a store like STR. On SMP builds the STXR compares the
    // value its LDXR read, so there it would fail (lse.zig).
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    m.regs.x[1] = 0x20000;
    m.regs.x[2] = 5;
    m.code(0x10000, &.{
        0xc85f7c20, // ldxr x0, [x1]
        ldop(3, 0, 0, .add, 2, 1, 3), // ldadd x2, x3, [x1]
        0xc8047c20, // stxr w4, x0, [x1]
        svc0,
    });
    m.regs.x[4] = 9;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    if (!c.smp) try t.expectEqual(@as(u64, 0), m.regs.x[4]);
    try t.expectEqual(core.no_resv, m.cpu.priv.hart.resv);
}

// ---- the shared-memory paths (SMP builds), natively on host threads -----------

test "a64 lse: rmwShared and casShared equal the plain semantics on edge values" {
    const ops = [_]lse.Op{ .add, .clr, .eor, .set, .smax, .smin, .umax, .umin, .swp };
    inline for (.{ u8, u16, u32, u64 }) |T| {
        for (ops) |op| for (edges) |a| for (edges) |b| {
            var cell: T = @truncate(a);
            const old = lse.rmwShared(T, &cell, op, @truncate(b));
            try t.expectEqual(@as(T, @truncate(a)), old);
            try t.expectEqual(@as(T, @truncate(refOp(op, @bitSizeOf(T), a, b))), cell);
            try t.expectEqual(@as(T, @truncate(refOp(op, @bitSizeOf(T), a, b))), lse.apply(T, op, @truncate(a), @truncate(b)));
            cell = @truncate(a);
            try t.expectEqual(@as(T, @truncate(a)), lse.casShared(T, &cell, @truncate(b), 0x5a));
            try t.expectEqual(if (@as(T, @truncate(a)) == @as(T, @truncate(b))) @as(T, 0x5a) else @as(T, @truncate(a)), cell);
        };
    }
    var pair: [2]u64 = .{ 1, 2 };
    try t.expectEqual([2]u64{ 1, 2 }, lse.casPair128Shared(&pair, 1, 3, 7, 8));
    try t.expectEqual([2]u64{ 1, 2 }, pair);
    try t.expectEqual([2]u64{ 1, 2 }, lse.casPair128Shared(&pair, 0, 2, 7, 8));
    try t.expectEqual([2]u64{ 1, 2 }, lse.casPair128Shared(&pair, 1, 2, 7, 8));
    try t.expectEqual([2]u64{ 7, 8 }, pair);
}

test "a64 lse: shared-memory atomics on host threads: counters, a CAS lock, 128-bit CASP with STXP" {
    const per = 20000;
    const nthreads = 4;
    const Shared = struct {
        add: u64 align(64) = 0,
        add8: u8 = 0,
        add16: u16 = 0,
        set: u32 = 0,
        max: u64 = 0,
        smin: i32 = 0,
        swp: u64 = 0,
        swp_sum: u64 = 0,
        lock: u32 = 0,
        locked: u64 = 0,
        pair: [2]u64 align(16) = .{ std.math.maxInt(u64) - per * nthreads / 2, 7 },
    };
    const Worker = struct {
        fn work(sh: *Shared, id: usize) void {
            var i: u64 = 0;
            while (i < per) : (i += 1) {
                _ = lse.rmwShared(u64, &sh.add, .add, 3);
                _ = lse.rmwShared(u8, &sh.add8, .add, 1);
                _ = lse.rmwShared(u16, &sh.add16, .add, 1);
                _ = lse.rmwShared(u32, &sh.set, .set, @as(u32, 1) << @intCast(id));
                _ = lse.rmwShared(u64, &sh.max, .umax, i * nthreads + id);
                _ = lse.rmwShared(u32, @ptrCast(&sh.smin), .smin, @bitCast(-@as(i32, @intCast(i))));
                // SWP: every value put in comes out exactly once
                const got = lse.rmwShared(u64, &sh.swp, .swp, i * nthreads + id + 1);
                _ = lse.rmwShared(u64, &sh.swp_sum, .add, got);
                // a CAS spin lock around a plain increment
                while (lse.casShared(u32, &sh.lock, 0, 1) != 0) std.atomic.spinLoopHint();
                sh.locked += 1;
                _ = lse.rmwShared(u32, &sh.lock, .swp, 0);
                // a 128-bit counter: CASP on even rounds, LDXP/STXP on odd ones
                while (true) {
                    const lo = @atomicLoad(u64, &sh.pair[0], .seq_cst);
                    const hi = @atomicLoad(u64, &sh.pair[1], .seq_cst);
                    const r = @addWithOverflow(lo, 1);
                    if (i & 1 == 0) {
                        const old = lse.casPair128Shared(&sh.pair, lo, hi, r[0], hi + r[1]);
                        if (old[0] == lo and old[1] == hi) break;
                    } else if (excl.storePair128Shared(&sh.pair, lo, hi, r[0], hi + r[1])) break;
                }
            }
        }
    };
    var sh: Shared = .{};
    var th: [nthreads]std.Thread = undefined;
    for (&th, 0..) |*h, id| h.* = try std.Thread.spawn(.{}, Worker.work, .{ &sh, id });
    for (th) |h| h.join();
    const n: u64 = per * nthreads;
    try t.expectEqual(3 * n, sh.add);
    try t.expectEqual(@as(u8, @truncate(n)), sh.add8);
    try t.expectEqual(@as(u16, @truncate(n)), sh.add16);
    try t.expectEqual(@as(u32, (1 << nthreads) - 1), sh.set);
    try t.expectEqual(n - 1, sh.max);
    try t.expectEqual(-@as(i32, per - 1), sh.smin);
    try t.expectEqual(n * (n + 1) / 2, sh.swp_sum + sh.swp);
    try t.expectEqual(n, sh.locked);
    try t.expectEqual(@as(u64, per * nthreads / 2 - 1), sh.pair[0]);
    try t.expectEqual(@as(u64, 8), sh.pair[1]);
}
