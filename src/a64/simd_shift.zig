// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! AdvSIMD shift by immediate, vector (`0 Q U 011110 immh immb opcode 1 Rn
//! Rd`, immh != 0) and scalar (`01 U 111110 immh immb opcode 1 Rn Rd`):
//! [SU]SHR, [SU]SRA, [SU]RSHR, [SU]RSRA, SRI, SHL, SLI, SQSHLU, SQSHL,
//! UQSHL, SHRN, RSHRN, SQSHRUN, SQRSHRUN, SQSHRN, UQSHRN, SQRSHRN,
//! UQRSHRN, SSHLL, USHLL (and the "2" forms). The fixed-point conversions
//! of this class (SCVTF, UCVTF, FCVTZS, FCVTZU) are simd_fp.zig's.
//!
//! The element size is the position of immh's top bit (8 << size); right
//! shifts are 2 * esize - immh:immb (1..esize), left shifts immh:immb -
//! esize (0..esize - 1). For the narrowing and long forms the size is the
//! narrow element's.

const std = @import("std");
const c = @import("common.zig");
const si = @import("simd_int.zig");
const fp = @import("simd_fp.zig");
const arith = @import("simd_arith.zig");

const ShOp = enum { sshr, ushr, ssra, usra, srshr, urshr, srsra, ursra, sri, shl, sli, sqshlu, sqshl, uqshl };

fn shOp(comptime T: type, op: ShOp, a: T, d: T, k: u32, qc: *bool) T {
    const n = @bitSizeOf(T);
    const L = std.math.Log2Int(T);
    const ones: T = std.math.maxInt(T);
    return switch (op) {
        .sshr => si.shr(T, a, k, true, false),
        .ushr => si.shr(T, a, k, false, false),
        .ssra => d +% si.shr(T, a, k, true, false),
        .usra => d +% si.shr(T, a, k, false, false),
        .srshr => si.shr(T, a, k, true, true),
        .urshr => si.shr(T, a, k, false, true),
        .srsra => d +% si.shr(T, a, k, true, true),
        .ursra => d +% si.shr(T, a, k, false, true),
        .sri => blk: { // k in 1..n: keep the top k bits of d
            const mk: T = if (k >= n) 0 else ones >> @as(L, @intCast(k));
            break :blk (d & ~mk) | (si.shr(T, a, k, false, false) & mk);
        },
        .shl => a << @as(L, @intCast(k)),
        .sli => blk: { // k in 0..n-1: keep the low k bits of d
            const mk: T = ones << @as(L, @intCast(k));
            break :blk (d & ~mk) | (a << @as(L, @intCast(k)));
        },
        .sqshlu => if (si.sx(T, a) < 0) blk: {
            qc.* = true;
            break :blk 0;
        } else si.shl(T, a, k, false, true, qc),
        .sqshl => si.shl(T, a, k, true, true, qc),
        .uqshl => si.shl(T, a, k, false, true, qc),
    };
}

fn mapSh(comptime T: type, op: ShOp, n: u128, d: u128, k: u32, nl: usize, qc: *bool) u128 {
    const a = c.lanes(T, n);
    const acc = c.lanes(T, d);
    var r: [a.len]T = undefined;
    for (&r, 0..) |*x, i| x.* = if (i < nl) shOp(T, op, a[i], acc[i], k, qc) else 0;
    return c.fromLanes(T, r);
}

/// Narrowing shifts: each wide lane of n shifted right by k (1..esize),
/// optionally rounding, then truncated or saturated to T.
const NarrowSh = struct { src_signed: bool, round: bool, sat: bool, dst_signed: bool };

fn narrowSh(comptime T: type, how: NarrowSh, n: u128, k: u32, nl: usize, qc: *bool) u64 {
    const W = si.Wide(T);
    const a = c.lanes(W, n);
    var r: [8 / @sizeOf(T)]T = undefined;
    for (&r, 0..) |*y, i| {
        const x = si.shr(W, a[i], k, how.src_signed, how.round);
        y.* = if (i >= nl) 0 else if (how.sat) si.narrowSat(T, W, x, how.src_signed, how.dst_signed, qc) else @truncate(x);
    }
    return @bitCast(r);
}

/// SSHLL, USHLL: a half of n widened (sign or zero) and shifted left by k.
fn longSh(comptime T: type, n: u128, part: bool, signed: bool, k: u32) u128 {
    const W = si.Wide(T);
    const a = si.half(T, n, part);
    var r: [a.len]W = undefined;
    for (&r, a) |*x, e| x.* = si.trunc(W, si.int(T, e, signed)) << @as(std.math.Log2Int(W), @intCast(k));
    return c.fromLanes(W, r);
}

pub fn shiftImm(s: c.St, inst: u32, sc: bool) c.Exit {
    const q = c.bit(inst, 30);
    const u = c.bit(inst, 29);
    const immh = c.bits(inst, 22, 19);
    const opcode = c.bits(inst, 15, 11);
    if (immh == 0) return c.ill(s, inst); // scalar only: vector immh = 0 is modified immediate
    if (opcode == 0b11100 or opcode == 0b11111) return fp.shiftImm(s, inst);
    const size: u2 = @intCast(31 - @clz(immh));
    const esize: u32 = @as(u32, 8) << size;
    const immhb = c.bits(inst, 22, 16);
    const right = 2 * esize - immhb; // 1..esize
    const left = immhb - esize; // 0..esize-1
    const n = c.vq(s, c.rn(inst));
    const d = c.rd(inst);
    var qc = false;

    // same element size
    const same: ?ShOp = switch (opcode) {
        0b00000 => if (u) .ushr else .sshr,
        0b00010 => if (u) .usra else .ssra,
        0b00100 => if (u) .urshr else .srshr,
        0b00110 => if (u) .ursra else .srsra,
        0b01000 => if (u) .sri else return c.ill(s, inst),
        0b01010 => if (u) .sli else .shl,
        0b01100 => if (u) .sqshlu else return c.ill(s, inst),
        0b01110 => if (u) .uqshl else .sqshl,
        else => null,
    };
    if (same) |op| {
        const is_left = opcode >= 0b01010;
        if (sc) {
            // the saturating left shifts exist for B, H, S, D; the rest D only
            if (opcode < 0b01100 and size != 3) return c.ill(s, inst);
        } else if (size == 3 and !q) return c.ill(s, inst);
        const nl = if (sc) 1 else si.vlanes(q, size);
        const k = if (is_left) left else right;
        const r = switch (size) {
            inline else => |z| mapSh(c.Elem(z), op, n, c.vq(s, d), k, nl, &qc),
        };
        c.setVq(s, d, r);
        si.setQc(s, qc);
        return .next;
    }

    switch (opcode) {
        0b10000...0b10011 => { // SHRN, RSHRN, SQSHRUN, SQRSHRUN, [SU]QSHRN, [SU]QRSHRN
            if (size == 3) return c.ill(s, inst);
            const round = opcode & 1 != 0;
            const how: NarrowSh = switch (opcode >> 1) {
                0b1000 => if (u) .{ .src_signed = true, .round = round, .sat = true, .dst_signed = false } // SQ[R]SHRUN
                else if (sc) return c.ill(s, inst) // no scalar [R]SHRN
                else .{ .src_signed = false, .round = round, .sat = false, .dst_signed = false }, // [R]SHRN
                0b1001 => .{ .src_signed = !u, .round = round, .sat = true, .dst_signed = !u }, // [SU]Q[R]SHRN
                else => unreachable,
            };
            const nl: usize = if (sc) 1 else @as(usize, 8) >> size;
            const r = switch (size) {
                inline 0, 1, 2 => |z| narrowSh(c.Elem(z), how, n, right, nl, &qc),
                3 => unreachable,
            };
            if (sc) c.setVd(s, d, r) else arith.setHalf(s, d, q, r);
            si.setQc(s, qc);
        },
        0b10100 => { // SSHLL, USHLL (SXTL, UXTL)
            if (sc or size == 3) return c.ill(s, inst);
            const r = switch (size) {
                inline 0, 1, 2 => |z| longSh(c.Elem(z), n, q, !u, left),
                3 => unreachable,
            };
            c.setVq(s, d, r);
        },
        else => return c.ill(s, inst),
    }
    return .next;
}
