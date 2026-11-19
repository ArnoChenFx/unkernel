// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! AdvSIMD integer element primitives shared by simd_arith.zig,
//! simd_shift.zig and simd_long.zig: saturation (SatQ), shifts with the
//! exact (unbounded) values of the pseudocode, halving, absolute
//! difference, doubling multiplies, polynomial multiply, the unsigned
//! reciprocal (square root) estimates, and the lane-wise loops for
//! operations whose operands and result have the same element size.
//!
//! Element values travel as unsigned `T` (u8, u16, u32, u64; `c.Elem`).
//! Exact intermediate values are i128 for additions, subtractions and
//! comparisons only: no i128/u128 multiply and no variable i128 shift
//! (compiler-rt calls on wasm; see .agents/a64.md). Shifts use T itself
//! and handle amounts of the element width and more explicitly.

const std = @import("std");
const c = @import("common.zig");

pub fn Sgn(comptime T: type) type {
    return std.meta.Int(.signed, @bitSizeOf(T));
}
/// The unsigned type of twice T's width (T up to u32).
pub fn Wide(comptime T: type) type {
    return std.meta.Int(.unsigned, 2 * @bitSizeOf(T));
}
pub inline fn sx(comptime T: type, a: T) Sgn(T) {
    return @bitCast(a);
}
/// SInt(a) or UInt(a).
pub inline fn int(comptime T: type, a: T, signed: bool) i128 {
    if (signed) return sx(T, a);
    return a;
}
/// The low bits of x (two's complement) as T.
pub inline fn trunc(comptime T: type, x: i128) T {
    return @truncate(@as(u128, @bitCast(x)));
}
/// All ones for true, zero for false.
pub inline fn mask(comptime T: type, b: bool) T {
    return if (b) std.math.maxInt(T) else 0;
}

/// SatQ(x, bits(T), !signed): x clamped to T's signed or unsigned range;
/// sets `qc` when it clamps.
pub fn satq(comptime T: type, x: i128, signed: bool, qc: *bool) T {
    const lo: i128 = if (signed) std.math.minInt(Sgn(T)) else 0;
    const hi: i128 = if (signed) std.math.maxInt(Sgn(T)) else std.math.maxInt(T);
    if (x < lo) {
        qc.* = true;
        return trunc(T, lo);
    }
    if (x > hi) {
        qc.* = true;
        return trunc(T, hi);
    }
    return trunc(T, x);
}

/// a << k for any k >= 0: the low bits of the exact value, or (saturate)
/// SatQ of the exact value in a's signedness.
pub fn shl(comptime T: type, a: T, k: u32, signed: bool, saturate: bool, qc: *bool) T {
    const n = @bitSizeOf(T);
    const L = std.math.Log2Int(T);
    if (!saturate) return if (k >= n) 0 else a << @as(L, @intCast(k));
    if (a == 0 or k == 0) return a;
    if (signed) {
        const sa = sx(T, a);
        if (k < n) {
            const r = @shlWithOverflow(sa, @as(L, @intCast(k)));
            if (r[1] == 0) return @bitCast(r[0]);
        }
        qc.* = true;
        const v: Sgn(T) = if (sa < 0) std.math.minInt(Sgn(T)) else std.math.maxInt(Sgn(T));
        return @bitCast(v);
    }
    if (k < n) {
        const r = @shlWithOverflow(a, @as(L, @intCast(k)));
        if (r[1] == 0) return r[0];
    }
    qc.* = true;
    return std.math.maxInt(T);
}

/// (a + (round ? 2^(k-1) : 0)) >> k with exact values, k >= 1 (any size):
/// arithmetic for signed, logical for unsigned. The result always fits T.
pub fn shr(comptime T: type, a: T, k: u32, signed: bool, round: bool) T {
    const n = @bitSizeOf(T);
    const L = std.math.Log2Int(T);
    // floor((a + 2^(k-1)) / 2^k) = (a >> k) + bit k-1 of a
    if (signed) {
        const sa = sx(T, a);
        var q: Sgn(T) = if (k >= n) (if (sa < 0) -1 else 0) else sa >> @as(L, @intCast(k));
        if (round) {
            const b = if (k - 1 >= n) sa < 0 else (sa >> @as(L, @intCast(k - 1))) & 1 != 0;
            if (b) q += 1;
        }
        return @bitCast(q);
    }
    var q: T = if (k >= n) 0 else a >> @as(L, @intCast(k));
    if (round and k - 1 < n and (a >> @as(L, @intCast(k - 1))) & 1 != 0) q += 1;
    return q;
}

/// [SU][Q][R]SHL (register): a shifted by the signed low byte of b, left
/// for positive amounts, right (rounding if `round`) for negative ones.
pub fn shlReg(comptime T: type, a: T, b: T, signed: bool, round: bool, saturate: bool, qc: *bool) T {
    const sh: i8 = @bitCast(@as(u8, @truncate(b)));
    if (sh >= 0) return shl(T, a, @intCast(sh), signed, saturate, qc);
    return shr(T, a, @intCast(-@as(i32, sh)), signed, round);
}

/// [SU][R]HADD, [SU]HSUB: (a +- b (+1)) >> 1 at full precision.
pub fn halve(comptime T: type, a: T, b: T, signed: bool, round: bool, sub: bool) T {
    const x = if (sub) int(T, a, signed) - int(T, b, signed) else int(T, a, signed) + int(T, b, signed) + @intFromBool(round);
    return trunc(T, x >> 1);
}

/// |a - b| (low bits; [SU]ABD, [SU]ABA, [SU]ABDL).
pub fn absDiff(comptime T: type, a: T, b: T, signed: bool) i128 {
    const x = int(T, a, signed) - int(T, b, signed);
    return if (x < 0) -x else x;
}

/// SQDMULH, SQRDMULH (T u16 or u32): SatQ((2ab (+ 2^(e-1))) >> e).
pub fn sqdmulh(comptime T: type, a: T, b: T, round: bool, qc: *bool) T {
    comptime std.debug.assert(T == u16 or T == u32);
    const e = @bitSizeOf(T);
    // (2p + 2^(e-1)) >> e == (p + 2^(e-2)) >> (e-1), without overflowing i64
    const p: i64 = @as(i64, sx(T, a)) * sx(T, b);
    const r = (p + (if (round) @as(i64, 1) << (e - 2) else 0)) >> (e - 1);
    return satq(T, r, true, qc);
}

/// SQDMULL (T u16 or u32): SatQ(2ab) at twice the width.
pub fn sqdmull(comptime T: type, a: T, b: T, qc: *bool) Wide(T) {
    comptime std.debug.assert(T == u16 or T == u32);
    const p: i64 = @as(i64, sx(T, a)) * sx(T, b);
    return satq(Wide(T), @as(i128, p) + p, true, qc);
}

/// SQDMLAL, SQDMLSL: SatQ(acc +- SatQ(2ab)), both saturations count.
pub fn sqdmlal(comptime T: type, acc: Wide(T), a: T, b: T, sub: bool, qc: *bool) Wide(T) {
    const W = Wide(T);
    const p = int(W, sqdmull(T, a, b, qc), true);
    const x = int(W, acc, true);
    return satq(W, if (sub) x - p else x + p, true, qc);
}

/// Polynomial (carry-less) multiply of two bytes (PMUL keeps the low
/// byte, PMULL the whole 16 bits).
pub fn clmul8(a: u8, b: u8) u16 {
    var r: u16 = 0;
    for (0..8) |i| {
        if ((b >> @intCast(i)) & 1 != 0) r ^= @as(u16, a) << @intCast(i);
    }
    return r;
}

/// CLS: leading bits after the sign bit that equal it.
pub fn cls(comptime T: type, a: T) T {
    const v: T = a ^ @as(T, @bitCast(sx(T, a) >> 1));
    return @clz(v) - 1;
}

/// UnsignedRecipEstimate (URECPE), ARMv8.0 (no FEAT_RPRES).
pub fn urecpe(a: u32) u32 {
    if (a >> 31 == 0) return 0xffff_ffff;
    const x: u32 = (a >> 23) * 2 + 1; // UInt(a<31:23>), 256..511
    const b: u32 = (1 << 19) / x;
    const r: u32 = (b + 1) / 2;
    return r << 23;
}

/// UnsignedRSqrtEstimate (URSQRTE), ARMv8.0.
pub fn ursqrte(a: u32) u32 {
    if (a >> 30 == 0) return 0xffff_ffff;
    var x: u64 = a >> 23; // 128..511, then in units of 1/1024
    x = if (x < 256) x * 2 + 1 else (((x >> 1) << 1) + 1) * 2;
    var b: u64 = 512;
    while (x * (b + 1) * (b + 1) < (1 << 28)) b += 1;
    const r: u32 = @intCast((b + 1) / 2);
    return r << 23;
}

/// SatQ to a narrow signedness from a wide value of the given signedness
/// (SQXTN, UQXTN, SQXTUN and the saturating narrowing shifts).
pub inline fn narrowSat(comptime T: type, comptime W: type, x: W, src_signed: bool, dst_signed: bool, qc: *bool) T {
    return satq(T, int(W, x, src_signed), dst_signed, qc);
}

/// The elements of the 64-bit half `part` of v (the "2" forms of the long
/// ops read the upper half). Indexed through memory like `c.lane`: a
/// select between the two halves becomes a variable u128 shift.
pub inline fn half(comptime T: type, v: u128, part: bool) [8 / @sizeOf(T)]T {
    return @bitCast(c.lane(u64, v, @intFromBool(part)));
}

// ---- same-size lane-wise operations ----------------------------------------------

/// Two-operand integer ops with operands and result of one element size
/// (three same, by element, pairwise after pairing); `d` is the old
/// destination element for the accumulating ones.
pub const Op2 = enum {
    add, sub, mul, mla, mls, pmul,
    shadd, uhadd, srhadd, urhadd, shsub, uhsub,
    sqadd, uqadd, sqsub, uqsub,
    cmgt, cmhi, cmge, cmhs, cmeq, cmtst,
    sshl, ushl, sqshl, uqshl, srshl, urshl, sqrshl, uqrshl,
    smax, umax, smin, umin, sabd, uabd, saba, uaba,
    sqdmulh, sqrdmulh,
};

pub fn op2(comptime T: type, op: Op2, a: T, b: T, d: T, qc: *bool) T {
    return switch (op) {
        .add => a +% b,
        .sub => a -% b,
        .mul => a *% b,
        .mla => d +% a *% b,
        .mls => d -% a *% b,
        .pmul => if (comptime T == u8) @truncate(clmul8(a, b)) else unreachable,
        .shadd => halve(T, a, b, true, false, false),
        .uhadd => halve(T, a, b, false, false, false),
        .srhadd => halve(T, a, b, true, true, false),
        .urhadd => halve(T, a, b, false, true, false),
        .shsub => halve(T, a, b, true, false, true),
        .uhsub => halve(T, a, b, false, false, true),
        .sqadd => satq(T, int(T, a, true) + int(T, b, true), true, qc),
        .uqadd => satq(T, int(T, a, false) + int(T, b, false), false, qc),
        .sqsub => satq(T, int(T, a, true) - int(T, b, true), true, qc),
        .uqsub => satq(T, int(T, a, false) - int(T, b, false), false, qc),
        .cmgt => mask(T, sx(T, a) > sx(T, b)),
        .cmhi => mask(T, a > b),
        .cmge => mask(T, sx(T, a) >= sx(T, b)),
        .cmhs => mask(T, a >= b),
        .cmeq => mask(T, a == b),
        .cmtst => mask(T, a & b != 0),
        .sshl => shlReg(T, a, b, true, false, false, qc),
        .ushl => shlReg(T, a, b, false, false, false, qc),
        .sqshl => shlReg(T, a, b, true, false, true, qc),
        .uqshl => shlReg(T, a, b, false, false, true, qc),
        .srshl => shlReg(T, a, b, true, true, false, qc),
        .urshl => shlReg(T, a, b, false, true, false, qc),
        .sqrshl => shlReg(T, a, b, true, true, true, qc),
        .uqrshl => shlReg(T, a, b, false, true, true, qc),
        .smax => if (sx(T, a) >= sx(T, b)) a else b,
        .umax => @max(a, b),
        .smin => if (sx(T, a) <= sx(T, b)) a else b,
        .umin => @min(a, b),
        .sabd => trunc(T, absDiff(T, a, b, true)),
        .uabd => trunc(T, absDiff(T, a, b, false)),
        .saba => d +% trunc(T, absDiff(T, a, b, true)),
        .uaba => d +% trunc(T, absDiff(T, a, b, false)),
        .sqdmulh => if (comptime T == u16 or T == u32) sqdmulh(T, a, b, false, qc) else unreachable,
        .sqrdmulh => if (comptime T == u16 or T == u32) sqdmulh(T, a, b, true, qc) else unreachable,
    };
}

/// op2 over the low `nl` lanes of n, m (and d); the other lanes are zero.
pub fn map2(comptime T: type, op: Op2, n: u128, m: u128, d: u128, nl: usize, qc: *bool) u128 {
    const a = c.lanes(T, n);
    const b = c.lanes(T, m);
    const acc = c.lanes(T, d);
    var r: [a.len]T = undefined;
    for (&r, 0..) |*x, i| x.* = if (i < nl) op2(T, op, a[i], b[i], acc[i], qc) else 0;
    return c.fromLanes(T, r);
}
/// map2 with the element size as a run-time field (0..3).
pub fn map2s(size: u2, op: Op2, n: u128, m: u128, d: u128, nl: usize, qc: *bool) u128 {
    return switch (size) {
        inline else => |z| map2(c.Elem(z), op, n, m, d, nl, qc),
    };
}
/// Lanes of a vector operation: 8 or 16 bytes of elements of 8 << size bits.
pub inline fn vlanes(q: bool, size: u2) usize {
    return @as(usize, if (q) 16 else 8) >> size;
}
/// Element `i` (of 8 << size bits) of v in every lane (by-element operands).
pub fn bcast(v: u128, size: u2, i: usize) u128 {
    const x: u64 = switch (size) {
        0 => c.lane(u8, v, i),
        1 => c.lane(u16, v, i),
        2 => c.lane(u32, v, i),
        3 => c.lane(u64, v, i),
    };
    const r = c.replicate(x, @as(u7, 8) << size);
    return c.v128(r, r);
}
/// FPSR.QC |= qc (call after the last thing that can trap).
pub inline fn setQc(s: c.St, qc: bool) void {
    if (qc) s.r.fpsr |= c.FPSR_QC;
}

test "simd_int: shifts against i128 references" {
    const t = std.testing;
    var qc = false;
    const vals = [_]u64{ 0, 1, 2, 3, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x7fff_ffff_ffff_ffff, 0x8000_0000_0000_0000, std.math.maxInt(u64), 0x1234_5678_9abc_def0 };
    inline for (.{ u8, u16, u32, u64 }) |T| {
        const n = @bitSizeOf(T);
        for (vals) |v0| {
            const a: T = @truncate(v0);
            for ([_]bool{ false, true }) |signed| {
                const ai = int(T, a, signed);
                var sh: i32 = -128;
                while (sh < 128) : (sh += 1) {
                    for ([_]bool{ false, true }) |round| {
                        // reference: exact value via i128 (natively; never in kwemu.o)
                        var exact: i128 = undefined;
                        var big = false; // left shift beyond i128
                        if (sh >= 0) {
                            if (ai != 0 and sh >= 64 and sh + n > 125) big = true else exact = ai << @intCast(sh);
                        } else {
                            const k: u7 = @intCast(@min(-sh, 100)); // same result for any k > 65
                            const rc: i128 = if (round) @as(i128, 1) << (k - 1) else 0;
                            exact = (ai + rc) >> k;
                        }
                        qc = false;
                        const got = shlReg(T, a, @truncate(@as(u64, @bitCast(@as(i64, sh)))), signed, round, false, &qc);
                        if (!big) try t.expectEqual(trunc(T, exact), got);
                        if (big) try t.expectEqual(@as(T, 0), got);
                        try t.expect(!qc);
                        var qc2 = false;
                        const sat = shlReg(T, a, @truncate(@as(u64, @bitCast(@as(i64, sh)))), signed, round, true, &qc2);
                        if (big) {
                            try t.expect(qc2);
                            try t.expectEqual(if (ai < 0) trunc(T, std.math.minInt(Sgn(T))) else if (signed) trunc(T, std.math.maxInt(Sgn(T))) else std.math.maxInt(T), sat);
                        } else {
                            var q3 = false;
                            try t.expectEqual(satq(T, exact, signed, &q3), sat);
                            try t.expectEqual(q3, qc2);
                        }
                    }
                }
            }
        }
    }
}

test "simd_int: doubling multiplies, estimates, cls" {
    const t = std.testing;
    var qc = false;
    try t.expectEqual(@as(u16, 0x7fff), sqdmulh(u16, 0x8000, 0x8000, false, &qc));
    try t.expect(qc);
    qc = false;
    try t.expectEqual(@as(u32, 0xc000_0000), sqdmulh(u32, 0x8000_0000, 0x4000_0000, true, &qc));
    try t.expectEqual(@as(u64, 0x7fff_ffff_ffff_ffff), sqdmull(u32, 0x8000_0000, 0x8000_0000, &qc));
    try t.expect(qc);
    qc = false;
    try t.expectEqual(@as(u32, 2), sqdmull(u16, 0xffff, 0xffff, &qc));
    try t.expect(!qc);
    try t.expectEqual(@as(u8, 7), cls(u8, 0));
    try t.expectEqual(@as(u8, 7), cls(u8, 0xff));
    try t.expectEqual(@as(u8, 2), cls(u8, 0x10));
    try t.expectEqual(@as(u8, 0), cls(u8, 0x40));
    try t.expectEqual(@as(u32, 0xffff_ffff), urecpe(0x7fff_ffff));
    try t.expectEqual(@as(u32, 0xff80_0000), urecpe(0x8000_0000));
    try t.expectEqual(@as(u32, 0xffff_ffff), ursqrte(0x3fff_ffff));
    try t.expectEqual(@as(u16, 0x5555), clmul8(0xff, 0xff));
    try t.expectEqual(@as(u16, 0x0f), clmul8(0x3, 0x5)); // (x+1)(x^2+1) = x^3+x^2+x+1
}

// Plain references for the tests (native only: i128 multiplies and shifts).
fn refSat(x: i128, signed: bool, comptime bits: u7, q: *bool) i128 {
    const lo: i128 = if (signed) -(@as(i128, 1) << (bits - 1)) else 0;
    const hi: i128 = if (signed) (@as(i128, 1) << (bits - 1)) - 1 else (@as(i128, 1) << bits) - 1;
    if (x < lo or x > hi) q.* = true;
    return @max(lo, @min(hi, x));
}
fn refShift(x: i128, sh: i8, round: bool) i128 {
    if (sh >= 0) return x << @intCast(@min(sh, 20)); // 8-bit x: any shift >= 9 is as good as 20
    const k: u7 = @intCast(@min(-@as(i16, sh), 20)); // same result for any k > 9
    return (x + (if (round) @as(i128, 1) << (k - 1) else 0)) >> k;
}
fn ref2(op: Op2, a: u8, b: u8, d: u8, q: *bool) u8 {
    const sa: i128 = @as(i8, @bitCast(a));
    const sb: i128 = @as(i8, @bitCast(b));
    const ua: i128 = a;
    const ub: i128 = b;
    const ud: i128 = d;
    const sh: i8 = @bitCast(b);
    const r: i128 = switch (op) {
        .add => ua + ub,
        .sub => ua - ub,
        .mul => ua * ub,
        .mla => ud + ua * ub,
        .mls => ud - ua * ub,
        .pmul => blk: {
            var p: i128 = 0;
            for (0..8) |i| if ((b >> @intCast(i)) & 1 != 0) {
                p ^= ua << @intCast(i);
            };
            break :blk p;
        },
        .shadd => (sa + sb) >> 1,
        .uhadd => (ua + ub) >> 1,
        .srhadd => (sa + sb + 1) >> 1,
        .urhadd => (ua + ub + 1) >> 1,
        .shsub => (sa - sb) >> 1,
        .uhsub => (ua - ub) >> 1,
        .sqadd => refSat(sa + sb, true, 8, q),
        .uqadd => refSat(ua + ub, false, 8, q),
        .sqsub => refSat(sa - sb, true, 8, q),
        .uqsub => refSat(ua - ub, false, 8, q),
        .cmgt => if (sa > sb) 255 else 0,
        .cmhi => if (ua > ub) 255 else 0,
        .cmge => if (sa >= sb) 255 else 0,
        .cmhs => if (ua >= ub) 255 else 0,
        .cmeq => if (a == b) 255 else 0,
        .cmtst => if (a & b != 0) 255 else 0,
        .sshl => refShift(sa, sh, false),
        .ushl => refShift(ua, sh, false),
        .srshl => refShift(sa, sh, true),
        .urshl => refShift(ua, sh, true),
        .sqshl => refSat(refShift(sa, sh, false), true, 8, q),
        .uqshl => refSat(refShift(ua, sh, false), false, 8, q),
        .sqrshl => refSat(refShift(sa, sh, true), true, 8, q),
        .uqrshl => refSat(refShift(ua, sh, true), false, 8, q),
        .smax => @max(sa, sb),
        .umax => @max(ua, ub),
        .smin => @min(sa, sb),
        .umin => @min(ua, ub),
        .sabd => @intCast(@abs(sa - sb)),
        .uabd => @intCast(@abs(ua - ub)),
        .saba => ud + @as(i128, @intCast(@abs(sa - sb))),
        .uaba => ud + @as(i128, @intCast(@abs(ua - ub))),
        .sqdmulh, .sqrdmulh => unreachable,
    };
    return @truncate(@as(u128, @bitCast(r)));
}

test "simd_int: every same-size op on all 8-bit operand pairs" {
    const t = std.testing;
    for (std.enums.values(Op2)) |op| {
        if (op == .sqdmulh or op == .sqrdmulh) continue;
        const acc = op == .mla or op == .mls or op == .saba or op == .uaba;
        const ds: []const u8 = if (acc) &.{ 0, 0x7f, 0x80, 0xff } else &.{0x5a};
        for (0..256) |ai| for (0..256) |bi| for (ds) |d| {
            const a: u8 = @intCast(ai);
            const b: u8 = @intCast(bi);
            var q1 = false;
            var q2 = false;
            const want = ref2(op, a, b, d, &q1);
            const got = op2(u8, op, a, b, d, &q2);
            if (want != got or q1 != q2) {
                std.debug.print("{t} a={x} b={x} d={x}: want {x} qc {} got {x} qc {}\n", .{ op, a, b, d, want, q1, got, q2 });
                return error.TestUnexpectedResult;
            }
        };
    }
    // narrowing saturation, all 16-bit inputs
    for (0..65536) |xi| {
        const x: u16 = @intCast(xi);
        for ([_][2]bool{ .{ true, true }, .{ false, false }, .{ true, false } }) |m| {
            var q1 = false;
            var q2 = false;
            const want: u8 = @truncate(@as(u128, @bitCast(refSat(int(u16, x, m[0]), m[1], 8, &q1))));
            try t.expectEqual(want, narrowSat(u8, u16, x, m[0], m[1], &q2));
            try t.expectEqual(q1, q2);
        }
    }
}

test "simd_int: doubling multiplies on 16-bit boundaries" {
    const t = std.testing;
    var rng = std.Random.DefaultPrng.init(7);
    const r = rng.random();
    var bs: [32]u16 = undefined;
    const edges = [_]u16{ 0, 1, 2, 0x7fff, 0x8000, 0x8001, 0xffff, 0xfffe, 0x4000, 0xc000, 0x3fff, 0xc001 };
    for (&bs, 0..) |*b, i| b.* = if (i < edges.len) edges[i] else r.int(u16);
    for (0..65536) |ai| for (bs) |b| for ([_]bool{ false, true }) |round| {
        const a: u16 = @intCast(ai);
        const p: i128 = @as(i128, @as(i16, @bitCast(a))) * @as(i16, @bitCast(b));
        var q1 = false;
        var q2 = false;
        const want = refSat((2 * p + (if (round) @as(i128, 1) << 15 else 0)) >> 16, true, 16, &q1);
        try t.expectEqual(@as(u16, @truncate(@as(u128, @bitCast(want)))), sqdmulh(u16, a, b, round, &q2));
        try t.expectEqual(q1, q2);
        // SQDMLAL/SQDMLSL with accumulators at the 32-bit boundaries
        if (ai % 61 != 0 and ai & 0x7ffe != 0 and ai & 0x7ffe != 0x7ffe) continue;
        for ([_]u32{ 0, 1, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x8000_0001, 0x7fff_fffe }) |acc| {
            q1 = false;
            q2 = false;
            const prod = refSat(2 * p, true, 32, &q1);
            const sum = refSat(@as(i128, @as(i32, @bitCast(acc))) + (if (round) -prod else prod), true, 32, &q1);
            try t.expectEqual(@as(u32, @truncate(@as(u128, @bitCast(sum)))), sqdmlal(u16, acc, a, b, round, &q2));
            try t.expectEqual(q1, q2);
        }
    };
}
