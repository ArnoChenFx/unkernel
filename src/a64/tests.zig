// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Unit tests of the A64 interpreter (native, `zig build test`): the shared
//! helpers in common.zig against independent references, the run loop's
//! event contract, and precise faults. Instruction semantics are covered
//! mostly by the differential guests (test/guest/a64, test/a64-test.mjs); add a
//! test here for anything a guest cannot reach (traps, faults, edge cases).

const std = @import("std");
const t = std.testing;
const c = @import("common.zig");
const decode = @import("decode.zig");
const mach = @import("machine.zig");
const Machine = mach.Machine;
const fpu = c.fpu;

// ---- common.zig ----------------------------------------------------------------

/// DecodeBitMasks written as directly from the pseudocode as possible.
fn refBitMasks(n: u1, imms: u6, immr: u6, immediate: bool, datasize: u7) ?c.BitMasks {
    const combined: u7 = (@as(u7, n) << 6) | (~imms & 0x3f);
    var len: i32 = -1;
    var k: i32 = 6;
    while (k >= 0) : (k -= 1) if ((combined >> @intCast(k)) & 1 != 0) {
        len = k;
        break;
    };
    if (len < 1) return null;
    const esize: u32 = @as(u32, 1) << @intCast(len);
    if (esize > datasize) return null;
    const levels: u32 = esize - 1;
    if (immediate and (imms & levels) == levels) return null;
    const S: u32 = imms & levels;
    const R: u32 = immr & levels;
    const d: u32 = (S -% R) & levels;
    var welem: u64 = 0;
    var telem: u64 = 0;
    for (0..S + 1) |i| welem |= @as(u64, 1) << @intCast(i);
    for (0..d + 1) |i| telem |= @as(u64, 1) << @intCast(i);
    // ROR within esize, bit by bit
    var rot: u64 = 0;
    for (0..esize) |i| {
        if ((welem >> @intCast(i)) & 1 != 0) rot |= @as(u64, 1) << @intCast((i + esize - R) % esize);
    }
    var w: u64 = 0;
    var tm: u64 = 0;
    var pos: u32 = 0;
    while (pos < datasize) : (pos += esize) {
        w |= rot << @intCast(pos);
        tm |= telem << @intCast(pos);
    }
    return .{ .wmask = w, .tmask = tm };
}

test "a64 common: decodeBitMasks matches the pseudocode for every encoding" {
    for ([_]u7{ 32, 64 }) |ds| {
        for (0..2) |n| for (0..64) |imms| for (0..64) |immr| for ([_]bool{ true, false }) |imm| {
            const got = c.decodeBitMasks(@intCast(n), @intCast(imms), @intCast(immr), imm, ds);
            const want = refBitMasks(@intCast(n), @intCast(imms), @intCast(immr), imm, ds);
            try t.expectEqual(want == null, got == null);
            if (want) |w| {
                try t.expectEqual(w.wmask, got.?.wmask);
                try t.expectEqual(w.tmask, got.?.tmask);
            }
        };
    }
    // known immediates: AND x0, x0, #0x5555555555555555 (N=0 immr=0 imms=111100)
    try t.expectEqual(@as(u64, 0x5555_5555_5555_5555), c.decodeBitMasks(0, 0b111100, 0, true, 64).?.wmask);
    try t.expectEqual(@as(u64, 0xaaaa_aaaa_aaaa_aaaa), c.decodeBitMasks(0, 0b111100, 1, true, 64).?.wmask);
    try t.expectEqual(@as(u64, 0x00ff_00ff_00ff_00ff), c.decodeBitMasks(0, 0b100111, 0, true, 64).?.wmask);
    try t.expectEqual(@as(u64, 0x8000_0000_0000_0000), c.decodeBitMasks(1, 0, 1, true, 64).?.wmask);
    try t.expect(c.decodeBitMasks(1, 0b111111, 0, true, 64) == null); // all ones: reserved
    try t.expect(c.decodeBitMasks(1, 0, 0, true, 32) == null); // 64-bit element in a W op
}

test "a64 common: addWithCarry flags against wide arithmetic" {
    var rng = std.Random.DefaultPrng.init(1);
    const r = rng.random();
    const edges = [_]u64{ 0, 1, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x7fff_ffff_ffff_ffff, 0x8000_0000_0000_0000, std.math.maxInt(u64) };
    var i: usize = 0;
    while (i < 20000) : (i += 1) {
        const a = if (i < 64) edges[i % 8] else r.int(u64);
        const b = if (i < 64) edges[i / 8] else r.int(u64);
        const cin: u1 = @intCast(i & 1);
        for ([_]bool{ false, true }) |sf| {
            const bits: u7 = if (sf) 64 else 32;
            const mask: u64 = if (sf) std.math.maxInt(u64) else 0xffff_ffff;
            const am = a & mask;
            const bm = b & mask;
            const usum: u128 = @as(u128, am) + bm + cin;
            const sa: i128 = @as(i64, @bitCast(c.sextN(am, bits)));
            const sb: i128 = @as(i64, @bitCast(c.sextN(bm, bits)));
            const ssum = sa + sb + cin;
            const res: u64 = @truncate(usum & mask);
            const got = c.addWithCarry(sf, a, b, cin);
            try t.expectEqual(res, got.r);
            try t.expectEqual(res >> @intCast(bits - 1) & 1 != 0, got.nzcv & c.N != 0);
            try t.expectEqual(res == 0, got.nzcv & c.Z != 0);
            try t.expectEqual(usum > mask, got.nzcv & c.C != 0);
            try t.expectEqual(ssum != @as(i64, @bitCast(c.sextN(res, bits))), got.nzcv & c.V != 0);
        }
    }
}

test "a64 common: conditions, shifts, extends, replicate, lanes" {
    // cond 0..15 against the Arm table, all 16 flag combinations
    for (0..16) |f| {
        const nzcv: u32 = @as(u32, @intCast(f)) << 28;
        const n = f & 8 != 0;
        const z = f & 4 != 0;
        const cy = f & 2 != 0;
        const v = f & 1 != 0;
        const want = [16]bool{ z, !z, cy, !cy, n, !n, v, !v, cy and !z, !(cy and !z), n == v, n != v, !z and n == v, !(!z and n == v), true, true };
        for (0..16) |cond| try t.expectEqual(want[cond], c.condHolds(nzcv, @intCast(cond)));
    }
    try t.expectEqual(@as(u64, 0xffff_ffff_ffff_fff0), c.shiftReg(true, 0xffff_ffff_ffff_ff00, 2, 4));
    try t.expectEqual(@as(u64, 0xffff_fff0), c.shiftReg(false, 0xffff_ffff_ffff_ff00, 2, 4)); // ASR on W, zero-extended
    try t.expectEqual(@as(u64, 0x8000_0000), c.shiftReg(false, 1, 3, 1)); // ROR W
    try t.expectEqual(@as(u64, 0x8000_0000_0000_0000), c.shiftReg(true, 1, 3, 1));
    try t.expectEqual(@as(u64, 0x0f00_0000), c.shiftReg(false, 0xf0, 0, 20));
    try t.expectEqual(@as(u64, 0xffff_ffff_ffff_fe00), c.extendReg(0x1280, 4, 2)); // SXTB #2
    try t.expectEqual(@as(u64, 0x80 << 4), c.extendReg(0xffff_ff80, 0, 4)); // UXTB #4
    try t.expectEqual(@as(u64, 0xffff_ffff_8000_0000), c.extendReg(0x1_8000_0000, 6, 0)); // SXTW
    try t.expectEqual(@as(u64, 0x8000_0000), c.extendReg(0x1_8000_0000, 2, 0)); // UXTW
    try t.expectEqual(@as(u64, 0xabab_abab_abab_abab), c.replicate(0x12ab, 8));
    try t.expectEqual(@as(u64, 0x0001_0001_0001_0001), c.replicate(1, 16));
    try t.expectEqual(@as(u64, 0x1234), c.replicate(0x1234, 64));
    const v: u128 = 0x0f0e0d0c0b0a0908_0706050403020100;
    try t.expectEqual(@as(u8, 5), c.lane(u8, v, 5));
    try t.expectEqual(@as(u16, 0x0f0e), c.lane(u16, v, 7));
    try t.expectEqual(@as(u64, 0x0f0e0d0c0b0a0908), c.lane(u64, v, 1));
    try t.expectEqual(@as(u128, 0x0f0e0d0c0b0a0908_07060504ffff0100), c.setLane(u16, v, 1, 0xffff) | (v & 0xffff));
    try t.expectEqual(v, c.v128(0x0706050403020100, 0x0f0e0d0c0b0a0908));
    try t.expectEqual(@as(u64, 0xffff_ffff_ffff_fff8), c.sextN(0x18, 4));
}

test "a64 common: FP status mapping and NaN propagation" {
    try t.expectEqual(fpu.RNE, c.fpRound(0));
    try t.expectEqual(fpu.RUP, c.fpRound(1 << 22));
    try t.expectEqual(fpu.RDN, c.fpRound(2 << 22));
    try t.expectEqual(fpu.RTZ, c.fpRound(3 << 22));
    try t.expectEqual(c.FPSR_IOC | c.FPSR_IXC, c.fpsrBits(fpu.NV | fpu.NX));
    try t.expectEqual(c.FPSR_DZC | c.FPSR_OFC | c.FPSR_UFC, c.fpsrBits(fpu.DZ | fpu.OF | fpu.UF));
    const snan: u32 = 0x7f80_0001;
    const qnan: u32 = 0xffc0_0002;
    var fl: u32 = 0;
    // a signalling NaN wins over a quiet one, is quieted, and raises NV
    try t.expectEqual(@as(?u32, 0x7fc0_0001), c.processNaNs(u32, qnan, snan, 0, &fl));
    try t.expectEqual(fpu.NV, fl);
    fl = 0;
    try t.expectEqual(@as(?u32, qnan), c.processNaNs(u32, 0x3f80_0000, qnan, 0, &fl));
    try t.expectEqual(@as(u32, 0), fl);
    try t.expectEqual(@as(?u32, 0x7fc0_0000), c.processNaNs(u32, qnan, 0, c.FPCR_DN, &fl)); // default NaN
    try t.expectEqual(@as(?u32, null), c.processNaNs(u32, 0x3f80_0000, 0x4000_0000, 0, &fl));
    try t.expectEqual(@as(?u64, 0x7ff8_0000_0000_0003), c.processNaNs3(u64, 0, 0x7ff8_0000_0000_0005, 0x7ff0_0000_0000_0003, 0, &fl));
}

// ---- decode routing ------------------------------------------------------------

test "a64 decode: routing of representative encodings" {
    const cases = .{
        .{ 0x00000000, .unallocated }, // udf #0
        .{ 0x91000420, .dp_imm }, // add x0, x1, #1
        .{ 0x90000001, .dp_imm }, // adrp x1
        .{ 0x14000001, .branch }, // b
        .{ 0xd4000001, .branch }, // svc #0
        .{ 0xd53bd040, .branch }, // mrs x0, tpidr_el0
        .{ 0xf9400020, .ldst }, // ldr x0, [x1]
        .{ 0xad0007e0, .ldst }, // stp q0, q1, [sp]
        .{ 0x885ffc20, .ldst }, // ldaxr w0, [x1]
        .{ 0x4c407000, .simd_ldst }, // ld1 {v0.16b}, [x0]
        .{ 0x4cdf7000, .simd_ldst }, // ld1 {v0.16b}, [x0], #16
        .{ 0x0d40c000, .simd_ldst }, // ld1r {v0.8b}, [x0]
        .{ 0x8b020020, .dp_reg }, // add x0, x1, x2
        .{ 0x9ac20820, .dp_reg }, // udiv x0, x1, x2
        .{ 0x1e260008, .fp }, // fmov w8, s0
        .{ 0x1e622800, .fp }, // fadd d0, d0, d2
        .{ 0x1f420c20, .fp }, // fmadd d0, d1, d2, d3
        .{ 0x4e010c60, .simd_move }, // dup v0.16b, w3
        .{ 0x6ea11c40, .simd_move }, // bit v0.16b, v2.16b, v1.16b
        .{ 0x4f00e5e0, .simd_move }, // movi v0.16b, #0xf
        .{ 0x4e003800, .simd_move }, // zip1 v0.16b, v0.16b, v0.16b
        .{ 0x6e000000, .simd_move }, // ext v0.16b, v0.16b, v0.16b, #0
        .{ 0x4e000000, .simd_move }, // tbl v0.16b, {v0.16b}, v0.16b
        .{ 0x5e010400, .simd_move }, // dup b0, v0.b[0]
        .{ 0x6e208c21, .simd_arith }, // cmeq v1.16b, v1.16b, v0.16b
        .{ 0x4e205800, .simd_arith }, // cnt v0.16b, v0.16b
        .{ 0x4f085400, .simd_arith }, // shl v0.2d, v0.2d, #8 (shift by immediate)
        .{ 0x5ee08400, .simd_arith }, // add d0, d0, d0 (scalar three same)
        .{ 0x4e284800, .crypto }, // aese v0.16b, v0.16b
        .{ 0x5e280800, .crypto }, // sha1h s0, s0
        .{ 0x5e004000, .crypto }, // sha256h q0, q0, v0.4s
        .{ 0xce608000, .crypto }, // sha512h q0, q0, v0.2d
        .{ 0x0ee0e000, .simd_arith }, // pmull v0.1q, v0.1d, v0.1d (three different)
    };
    inline for (cases) |cs| try t.expectEqual(@as(decode.Group, cs[1]), decode.route(cs[0]));
}

// ---- run loop and events -------------------------------------------------------

fn movz(rd: u32, imm: u16) u32 {
    return 0xd280_0000 | (@as(u32, imm) << 5) | rd;
}

test "a64 run: syscall advances pc, budget and icount are exact" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.code(0x10000, &.{ movz(0, 5), 0x91001c00, movz(8, 93), mach.svc0, movz(1, 1) }); // add x0, x0, #7
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(100));
    try t.expectEqual(@as(u64, 12), m.regs.x[0]);
    try t.expectEqual(@as(u64, 93), m.regs.x[8]);
    try t.expectEqual(@as(u64, 0x10010), m.regs.pc);
    try t.expectEqual(@as(u64, 4), m.cpu.icount);
    try t.expectEqual(@as(u64, 96), m.cpu.budget);
    // budget: an infinite loop (add x5, x5, #1; b .-4)
    m.code(0x20000, &.{ 0x910004a5, 0x17ffffff });
    try t.expectEqual(@as(u32, mach.EV_BUDGET), m.run(1001));
    try t.expectEqual(@as(u64, 501), m.regs.x[5]);
    try t.expectEqual(@as(u64, 0x20004), m.regs.pc);
    try t.expectEqual(@as(u64, 0), m.cpu.budget);
    try t.expectEqual(@as(u32, mach.EV_BUDGET), m.run(0));
}

test "a64 run: illegal, breakpoint, misaligned pc, interrupt polling" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.code(0x10000, &.{ movz(1, 1), 0x0000_dead, movz(1, 2) }); // udf #0xdead
    try t.expectEqual(@as(u32, mach.EV_ILLEGAL), m.run(10));
    try t.expectEqual(@as(u64, 0x10004), m.regs.pc);
    try t.expectEqual(@as(u64, 0x0000_dead), m.cpu.ev.insn);
    try t.expectEqual(@as(u64, 0x10004), m.cpu.ev.addr);
    try t.expectEqual(@as(u64, 1), m.cpu.icount);
    m.code(0x11000, &.{0xd420_7d00}); // brk #0x3e8
    try t.expectEqual(@as(u32, mach.EV_BREAKPOINT), m.run(10));
    try t.expectEqual(@as(u64, 0x11000), m.regs.pc);
    try t.expectEqual(@as(u64, 0xd420_7d00), m.cpu.ev.insn);
    m.code(0x12000, &.{ movz(2, 0x3002), 0xd61f0040 }); // br x2 (misaligned target)
    m.regs.pc = 0x12000;
    try t.expectEqual(@as(u32, mach.EV_MISALIGNED), m.run(10));
    try t.expectEqual(@as(u64, 0x3002), m.cpu.ev.addr);
    // straight-line code polls at least every 64 instructions: the guest
    // itself raises the interrupt (irq_pending points into its memory)
    m.mapData(0x20000, 1);
    m.cpu.irq_pending = @ptrCast(@alignCast(m.at(0x20000).ptr));
    var words: [200]u32 = undefined;
    for (&words) |*w| w.* = 0xd503201f; // nop
    words[0] = movz(1, 1);
    words[1] = movz(2, 2); // x2 = 0x20000 after the shift below
    words[2] = 0xd370bc42; // lsl x2, x2, #16
    words[3] = 0xb9000041; // str w1, [x2]
    m.code(0x13000, &words);
    try t.expectEqual(@as(u32, mach.EV_INTERRUPT), m.run(1000));
    try t.expect(m.regs.pc > 0x1300c and m.regs.pc <= 0x13010 + 64 * 4);
    try t.expectEqual(@as(u32, mach.EV_INTERRUPT), m.run(1000)); // still pending: at once
    m.cpu.irq_pending = null;
}

test "a64 run: faults are precise (pair store across a page end, writeback, loads)" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1); // 0x21000 stays unmapped
    m.regs.x[1] = 0x20ff8;
    m.regs.x[2] = 0x1111_1111_1111_1111;
    m.regs.x[3] = 0x2222_2222_2222_2222;
    // stp x2, x3, [x1], #16: the second half faults, so nothing is written
    m.code(0x10000, &.{0xa8810c22});
    try t.expectEqual(@as(u32, mach.EV_FAULT), m.run(10));
    try t.expectEqual(@as(u64, 0x21000), m.cpu.ev.addr & ~@as(u64, 0xfff));
    try t.expectEqual(@as(u32, 1), m.cpu.ev.access); // write
    try t.expectEqual(@as(u64, 0x10000), m.regs.pc);
    try t.expectEqual(@as(u64, 0x20ff8), m.regs.x[1]); // no writeback
    try t.expectEqualSlices(u8, &(.{0} ** 8), m.at(0x20ff8)[0..8]);
    // after the kernel maps the page the same instruction completes
    m.mapData(0x21000, 1);
    try t.expectEqual(@as(u32, mach.EV_BUDGET), m.run(1));
    try t.expectEqual(@as(u64, 0x21008), m.regs.x[1]);
    try t.expectEqual(@as(u64, 0x1111_1111_1111_1111), std.mem.readInt(u64, m.at(0x20ff8)[0..8], .little));
    try t.expectEqual(@as(u64, 0x2222_2222_2222_2222), std.mem.readInt(u64, m.at(0x21000)[0..8], .little));
    // ldp x4, x5, [x1, #-16]!: a fault leaves x4, x5 and x1 alone
    m.unmap(0x21000);
    m.regs.x[4] = 4;
    m.regs.x[5] = 5;
    m.code(0x11000, &.{0xa9ff1424});
    try t.expectEqual(@as(u32, mach.EV_FAULT), m.run(10));
    try t.expectEqual(@as(u64, 4), m.regs.x[4]);
    try t.expectEqual(@as(u64, 5), m.regs.x[5]);
    try t.expectEqual(@as(u64, 0x21008), m.regs.x[1]);
    // stp q0, q1 across the end too
    m.regs.x[1] = 0x20ff0;
    m.regs.v[0] = std.math.maxInt(u128);
    m.code(0x12000, &.{0xad000420}); // stp q0, q1, [x1]
    try t.expectEqual(@as(u32, mach.EV_FAULT), m.run(10));
    try t.expectEqualSlices(u8, &(.{0} ** 8), m.at(0x20ff0)[0..8]);
}

test "a64 run: tpidr_el0, nzcv, fpcr, dczid, dc zva, ldr literal, q-register loads" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    @memset(m.at(0x20000)[0..256], 0xee);
    m.regs.x[0] = 0x1234_5678_9abc_def0;
    m.regs.x[3] = 0x20047;
    m.regs.x[4] = 0x20080;
    m.code(0x10000, &.{
        0xd51bd040, // msr tpidr_el0, x0
        0xd53bd041, // mrs x1, tpidr_el0
        0xd53b00e2, // mrs x2, dczid_el0
        0xd50b7423, // dc zva, x3
        0xb2600005, // orr x5, x0, #0x100000000
        0xd51b4205, // msr nzcv, x5 (only NZCV kept)
        0xd53b4206, // mrs x6, nzcv
        0x3dc00080, // ldr q0, [x4]
        0x58000047, // ldr x7, .+8
        0x14000003, // b .+12
        0x89abcdef, // literal (low word)
        0x01234567, // literal (high word)
        0xd51b4405, // msr fpcr, x5
        0xd53b4408, // mrs x8, fpcr
        mach.svc0,
    });
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(100));
    try t.expectEqual(@as(u64, 0x1234_5678_9abc_def0), m.regs.tpidr_el0);
    try t.expectEqual(@as(u64, 0x1234_5678_9abc_def0), m.regs.x[1]);
    try t.expectEqual(@as(u64, 4), m.regs.x[2]);
    try t.expectEqualSlices(u8, &(.{0} ** 64), m.at(0x20040)[0..64]);
    try t.expectEqual(@as(u8, 0xee), m.at(0x2003f)[0]);
    try t.expectEqual(@as(u8, 0xee), m.at(0x20080)[0]);
    try t.expectEqual(@as(u64, 0x9000_0000), m.regs.x[6]);
    try t.expectEqual(@as(u128, std.math.maxInt(u128) / 255 * 0xee), m.regs.v[0]);
    try t.expectEqual(@as(u64, 0x0123_4567_89ab_cdef), m.regs.x[7]);
    try t.expectEqual(@as(u64, 0x9abc_def0 & c.FPCR_MASK), m.regs.x[8]);
}

test "a64 run: unimplemented groups raise ILLEGAL with the raw word" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    // fadd (half precision): FP16 arithmetic is not ARMv8.0
    for ([_]u32{0x1ee22800}) |w| {
        m.code(0x10000, &.{w});
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), m.run(10));
        try t.expectEqual(@as(u64, w), m.cpu.ev.insn);
    }
}

// ---- simd_move, simd_ldst ------------------------------------------------------

test "a64 simd_ldst: structure loads/stores across a page end fault precisely" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1); // 0x21000 stays unmapped
    for (0..32) |i| m.regs.v[i] = @as(u128, 0x0101_0101_0101_0101_0101_0101_0101_0101) * i;
    const before = m.regs.v;
    const cases = [_]struct { w: u32, base: u64 }{
        .{ .w = 0x4cdf2020, .base = 0x20fd0 }, // ld1 {v0.16b-v3.16b}, [x1], #64 (last word faults)
        .{ .w = 0x4c820820, .base = 0x20fd0 }, // st4 {v0.4s-v3.4s}, [x1], x2
        .{ .w = 0x4d9fa424, .base = 0x20ff0 }, // st3 {v4.d-v6.d}[1], [x1], #24
        .{ .w = 0x4dffe424, .base = 0x20ffc }, // ld4r {v4.8h-v7.8h}, [x1], #8
        .{ .w = 0x4dff1c3e, .base = 0x20fff }, // ld2 {v30.b, v31.b}[15], [x1], #2
    };
    for (cases) |cs| {
        @memset(m.at(0x20000)[0..4096], 0xee);
        m.regs.x[1] = cs.base;
        m.regs.x[2] = 0x40;
        m.code(0x10000, &.{cs.w});
        try t.expectEqual(@as(u32, mach.EV_FAULT), m.run(10));
        try t.expectEqual(@as(u64, 0x21000), m.cpu.ev.addr & ~@as(u64, 0xfff));
        try t.expectEqual(@as(u64, 0x10000), m.regs.pc);
        try t.expectEqual(cs.base, m.regs.x[1]); // no writeback
        try t.expectEqualSlices(u128, &before, &m.regs.v); // no register loaded
        for (m.at(0x20000)[0..4096]) |b| try t.expectEqual(@as(u8, 0xee), b); // nothing stored
    }
    // mapped: the same ld1 completes and writes back
    m.mapData(0x21000, 1);
    m.regs.x[1] = 0x20fd0;
    m.code(0x10000, &.{0x4cdf2020});
    try t.expectEqual(@as(u32, mach.EV_BUDGET), m.run(1));
    try t.expectEqual(@as(u64, 0x21010), m.regs.x[1]);
    try t.expectEqual(@as(u128, std.math.maxInt(u128) / 255 * 0xee), m.regs.v[0]);
    try t.expectEqual(@as(u128, 0), m.regs.v[3]);
}

test "a64 simd_ldst: SP base, writeback, register lists wrap at V31" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    for (0..64) |i| m.at(0x20000)[i] = @intCast(i);
    m.regs.sp = 0x20000;
    m.regs.v[1] = 0x1111;
    m.regs.v[2] = 0x2222;
    m.regs.v[30] = c.v128(0x3030_3030_3030_3030, 0x3131_3131_3131_3131);
    m.regs.v[31] = c.v128(0x3232_3232_3232_3232, 0x3333_3333_3333_3333);
    m.regs.v[0] = c.v128(0x0a0a_0a0a_0a0a_0a0a, 0x0b0b_0b0b_0b0b_0b0b);
    m.code(0x10000, &.{
        0x4c00afe1, // st1 {v1.2d, v2.2d}, [sp]
        0x4cdf73e5, // ld1 {v5.16b}, [sp], #16
        0x4e0153c0, // tbx v0.16b, {v30.16b, v31.16b, v0.16b}, v1.16b
        mach.svc0,
    });
    m.regs.x[8] = 0;
    try t.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(10));
    try t.expectEqual(@as(u64, 0x20010), m.regs.sp);
    try t.expectEqual(@as(u128, 0x1111), m.regs.v[5]);
    try t.expectEqual(@as(u64, 0x2222), std.mem.readInt(u64, m.at(0x20010)[0..8], .little));
    // v1 = 0x1111: indices 0x11, 0x11, then zeros: byte 0x11 of the table
    // (v31 byte 1 = 0x32), byte 0 (v30 byte 0 = 0x30)
    try t.expectEqual(@as(u8, 0x32), c.lane(u8, m.regs.v[0], 0));
    try t.expectEqual(@as(u8, 0x32), c.lane(u8, m.regs.v[0], 1));
    try t.expectEqual(@as(u8, 0x30), c.lane(u8, m.regs.v[0], 2));
}

test "a64 simd_move, simd_ldst: reserved encodings raise ILLEGAL" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    m.mapData(0x20000, 1);
    const words = [_]u32{
        0x0c408c20, // ld2 {.1d}
        0x4c401020, // multiple, opcode 0001
        0x4c417020, // ld1 (no offset) with Rm != 0
        0x4cff7020, // ld1 (post-index) with bit 21 set
        0x0d00c020, // st1r
        0x0d40d020, // ld1r with S = 1
        0x0d404420, // ld1 {.h}[] with size<0> = 1
        0x0d409420, // ld1 {.d}[] with S = 1
        0x0d408820, // ld1 {.s}[] with size = 10
        0x0d418020, // ld1 lane (no offset) with Rm != 0
        0x4e400000, // tbl, op2 = 01
        0x4e000800, // permute opcode 000
        0x4e004800, // permute opcode 100
        0x0ec03800, // zip1 .1d
        0x2e004000, // ext .8b #8
        0x6e400000, // ext, op2 = 01
        0x4e100400, // dup, imm5 = 10000
        0x0e011c00, // ins (general), Q = 0
        0x4e013c00, // umov x, .b
        0x0e042c00, // smov w, .s
        0x0f00fc00, // fmov .4h (FEAT_FP16)
        0x2f00f400, // fmov .1d (Q = 0)
        0x5e010c00, // scalar copy, imm4 != 0
        0x0e000400, // dup, imm5 = 00000
    };
    for (words) |w| {
        m.regs.x[0] = 0x20000;
        m.regs.x[1] = 0x20000;
        m.code(0x10000, &.{w});
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), m.run(10));
        try t.expectEqual(@as(u64, w), m.cpu.ev.insn);
    }
}
