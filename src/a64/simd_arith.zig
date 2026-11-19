// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! AdvSIMD arithmetic, vector and scalar: three same (except the logical
//! ops, simd_move.zig), three different, two-register misc, across lanes,
//! pairwise, shift by immediate, x indexed element, three same extra and
//! FP16 forms. decode.zig sends every AdvSIMD encoding here that is not a
//! move/permute/logic (simd_move.zig), a structure load/store
//! (simd_ldst.zig) or crypto (crypto.zig).
//!
//! Files: this one decodes the classes and implements three same, two-reg
//! misc, across lanes and scalar pairwise; simd_shift.zig shift by
//! immediate; simd_long.zig three different and by element; simd_int.zig
//! the element primitives; simd_fp.zig the FP slot of every class.
//!
//! Implemented: every ARMv8.0 instruction of these classes, integer and FP
//! (single and double precision, simd_fp.zig), vector and scalar. ILLEGAL:
//! PMULL/PMULL2 on 64-bit lanes while the PMULL feature is off (crypto.zig's
//! `pmull64`), and everything after v8.0: three same extra (SQRDMLAH,
//! SQRDMLSH, SDOT, UDOT, FCMLA, FCADD, ...), the FP16 classes and forms,
//! FRINT32/64, by-element SQRDMLAH/SQRDMLSH, DOT and FMLAL.

const std = @import("std");
const c = @import("common.zig");
const si = @import("simd_int.zig");
const fp = @import("simd_fp.zig");
const shift = @import("simd_shift.zig");
const long = @import("simd_long.zig");

const Op2 = si.Op2;

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    if (c.bit(inst, 28)) return scalar(s, inst);
    if (inst & 0x9f20_0400 == 0x0e20_0400) return threeSame(s, inst, false);
    if (inst & 0x9f3e_0c00 == 0x0e30_0800) return acrossLanes(s, inst);
    if (inst & 0x9f3e_0c00 == 0x0e20_0800) return twoRegMisc(s, inst);
    if (inst & 0x9f20_0c00 == 0x0e20_0000) return long.threeDiff(s, inst, false);
    if (inst & 0x9f80_0400 == 0x0f00_0400) return shift.shiftImm(s, inst, false); // immh != 0 (else modified immediate)
    if (inst & 0x9f00_0400 == 0x0f00_0000) return long.indexed(s, inst, false);
    return c.ill(s, inst); // three same extra, FP16 three same / two-reg misc, unallocated
}

/// AdvSIMD scalar (op0 = 01x1): three same, three different, two-reg misc,
/// pairwise, shift by immediate, x indexed element (three same extra and
/// FP16 are ILLEGAL).
fn scalar(s: c.St, inst: u32) c.Exit {
    if (inst & 0xdf20_0400 == 0x5e20_0400) return threeSame(s, inst, true);
    if (inst & 0xdf3e_0c00 == 0x5e30_0800) return scalarPairwise(s, inst);
    if (inst & 0xdf3e_0c00 == 0x5e20_0800) return scalarTwoRegMisc(s, inst);
    if (inst & 0xdf20_0c00 == 0x5e20_0000) return long.threeDiff(s, inst, true);
    if (inst & 0xdf80_0400 == 0x5f00_0400) return shift.shiftImm(s, inst, true);
    if (inst & 0xdf00_0400 == 0x5f00_0000) return long.indexed(s, inst, true);
    return c.ill(s, inst);
}

// ---- three same --------------------------------------------------------------------

/// Allowed element sizes (bit i: size i).
const ALL: u4 = 0b1111;
const NO_D: u4 = 0b0111;
const HS: u4 = 0b0110;
const B: u4 = 0b0001;
const D: u4 = 0b1000;
const NONE: u4 = 0;

const TsInfo = struct { op: Op2, vec: u4, scal: u4, pair: bool = false };

/// Integer three same by opcode (inst<15:11>) and U, from the Arm ARM
/// tables: the op and its allowed sizes in the vector and scalar forms.
fn tsInfo(u: bool, opcode: u32) ?TsInfo {
    const T = TsInfo;
    return switch (opcode) {
        0b00000 => T{ .op = if (u) .uhadd else .shadd, .vec = NO_D, .scal = NONE },
        0b00001 => T{ .op = if (u) .uqadd else .sqadd, .vec = ALL, .scal = ALL },
        0b00010 => T{ .op = if (u) .urhadd else .srhadd, .vec = NO_D, .scal = NONE },
        0b00100 => T{ .op = if (u) .uhsub else .shsub, .vec = NO_D, .scal = NONE },
        0b00101 => T{ .op = if (u) .uqsub else .sqsub, .vec = ALL, .scal = ALL },
        0b00110 => T{ .op = if (u) .cmhi else .cmgt, .vec = ALL, .scal = D },
        0b00111 => T{ .op = if (u) .cmhs else .cmge, .vec = ALL, .scal = D },
        0b01000 => T{ .op = if (u) .ushl else .sshl, .vec = ALL, .scal = D },
        0b01001 => T{ .op = if (u) .uqshl else .sqshl, .vec = ALL, .scal = ALL },
        0b01010 => T{ .op = if (u) .urshl else .srshl, .vec = ALL, .scal = D },
        0b01011 => T{ .op = if (u) .uqrshl else .sqrshl, .vec = ALL, .scal = ALL },
        0b01100 => T{ .op = if (u) .umax else .smax, .vec = NO_D, .scal = NONE },
        0b01101 => T{ .op = if (u) .umin else .smin, .vec = NO_D, .scal = NONE },
        0b01110 => T{ .op = if (u) .uabd else .sabd, .vec = NO_D, .scal = NONE },
        0b01111 => T{ .op = if (u) .uaba else .saba, .vec = NO_D, .scal = NONE },
        0b10000 => T{ .op = if (u) .sub else .add, .vec = ALL, .scal = D },
        0b10001 => T{ .op = if (u) .cmeq else .cmtst, .vec = ALL, .scal = D },
        0b10010 => T{ .op = if (u) .mls else .mla, .vec = NO_D, .scal = NONE },
        0b10011 => if (u) T{ .op = .pmul, .vec = B, .scal = NONE } else T{ .op = .mul, .vec = NO_D, .scal = NONE },
        0b10100 => T{ .op = if (u) .umax else .smax, .vec = NO_D, .scal = NONE, .pair = true }, // [SU]MAXP
        0b10101 => T{ .op = if (u) .umin else .smin, .vec = NO_D, .scal = NONE, .pair = true }, // [SU]MINP
        0b10110 => T{ .op = if (u) .sqrdmulh else .sqdmulh, .vec = HS, .scal = HS },
        0b10111 => if (u) null else T{ .op = .add, .vec = ALL, .scal = NONE, .pair = true }, // ADDP
        else => null, // 00011: logical (simd_move.zig, unallocated in scalar)
    };
}

/// AdvSIMD three same, vector (`0 Q U 01110 size 1 Rm opcode 1 Rn Rd`) and
/// scalar (`01 U 11110 size 1 Rm opcode 1 Rn Rd`).
fn threeSame(s: c.St, inst: u32, sc: bool) c.Exit {
    const q = c.bit(inst, 30);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const opcode = c.bits(inst, 15, 11);
    if (opcode >= 0b11000) return if (sc) fp.scalarThreeSame(s, inst) else fp.threeSame(s, inst);
    const info = tsInfo(c.bit(inst, 29), opcode) orelse return c.ill(s, inst);
    const allowed = if (sc) info.scal else info.vec;
    if ((allowed >> size) & 1 == 0) return c.ill(s, inst);
    if (!sc and size == 3 and !q) return c.ill(s, inst);
    const n = c.vq(s, c.rn(inst));
    const m = c.vq(s, c.rm(inst));
    const d = c.rd(inst);
    const nl = if (sc) 1 else si.vlanes(q, size);
    var qc = false;
    const r = if (info.pair) pairwise(size, info.op, n, m, nl) else si.map2s(size, info.op, n, m, c.vq(s, d), nl, &qc);
    c.setVq(s, d, r);
    si.setQc(s, qc);
    return .next;
}

/// ADDP, [SU]MAXP, [SU]MINP (vector): op over adjacent pairs of the low
/// `nl` lanes of n then of m (no op here saturates).
fn pairwise(size: u2, op: Op2, n: u128, m: u128, nl: usize) u128 {
    return switch (size) {
        inline else => |z| pairT(c.Elem(z), op, n, m, nl),
    };
}
fn pairT(comptime T: type, op: Op2, n: u128, m: u128, nl: usize) u128 {
    const a = c.lanes(T, n);
    const b = c.lanes(T, m);
    var x: [a.len]T = undefined;
    var y: [a.len]T = undefined;
    const h = nl / 2;
    for (0..a.len) |i| {
        const src = if (i < h) a[2 * i ..][0..2] else if (i < nl) b[2 * (i - h) ..][0..2] else &[2]T{ 0, 0 };
        x[i] = src[0];
        y[i] = src[1];
    }
    var qc = false;
    return si.map2(T, op, c.fromLanes(T, x), c.fromLanes(T, y), 0, nl, &qc);
}

// ---- across lanes and scalar pairwise ----------------------------------------------

/// AdvSIMD across lanes (`0 Q U 01110 size 11000 opcode 10 Rn Rd`).
fn acrossLanes(s: c.St, inst: u32) c.Exit {
    const q = c.bit(inst, 30);
    const u = c.bit(inst, 29);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const Op = enum { addl, add, max, min };
    const op: Op = switch (c.bits(inst, 16, 12)) {
        0b00011 => .addl, // SADDLV, UADDLV
        0b11011 => if (u) return c.ill(s, inst) else .add, // ADDV
        0b01010 => .max, // SMAXV, UMAXV
        0b11010 => .min, // SMINV, UMINV
        0b01100, 0b01111 => return fp.acrossLanes(s, inst),
        else => return c.ill(s, inst),
    };
    if (size == 3 or (size == 2 and !q)) return c.ill(s, inst);
    const v = c.vq(s, c.rn(inst));
    const r: u64 = switch (size) {
        inline 0, 1, 2 => |z| if (op == .addl) addlv(c.Elem(z), q, u, v) else reduce(c.Elem(z), q, u, op, v),
        3 => unreachable,
    };
    c.setVd(s, c.rd(inst), r);
    return .next;
}

fn reduce(comptime T: type, q: bool, unsigned: bool, op: anytype, v: u128) T {
    const S = si.Sgn(T);
    const a = c.lanes(T, v);
    const n = if (q) a.len else a.len / 2;
    var r: T = a[0];
    for (a[1..n]) |x| {
        r = switch (op) {
            .add => r +% x,
            .max => if (unsigned) @max(r, x) else @bitCast(@max(@as(S, @bitCast(r)), @as(S, @bitCast(x)))),
            .min => if (unsigned) @min(r, x) else @bitCast(@min(@as(S, @bitCast(r)), @as(S, @bitCast(x)))),
            .addl => unreachable,
        };
    }
    return r;
}

/// SADDLV, UADDLV: the sum at twice the element width.
fn addlv(comptime T: type, q: bool, unsigned: bool, v: u128) si.Wide(T) {
    const a = c.lanes(T, v);
    const n = if (q) a.len else a.len / 2;
    var r: i128 = 0;
    for (a[0..n]) |x| r += si.int(T, x, !unsigned);
    return si.trunc(si.Wide(T), r);
}

/// AdvSIMD scalar pairwise (`01 U 11110 size 11000 opcode 10 Rn Rd`).
fn scalarPairwise(s: c.St, inst: u32) c.Exit {
    const opcode = c.bits(inst, 16, 12);
    switch (opcode) {
        0b11011 => { // ADDP (scalar): Dd = Vn.d[0] + Vn.d[1]
            if (c.bit(inst, 29) or c.bits(inst, 23, 22) != 3) return c.ill(s, inst);
            const h = c.lanes(u64, c.vq(s, c.rn(inst)));
            c.setVd(s, c.rd(inst), h[0] +% h[1]);
            return .next;
        },
        0b01100, 0b01101, 0b01111 => return fp.scalarPairwise(s, inst),
        else => return c.ill(s, inst),
    }
}

// ---- two-register miscellaneous ----------------------------------------------------

const Op1 = enum { cls, clz, cnt, not, rbit, sqabs, sqneg, abs, neg, cmgt0, cmge0, cmeq0, cmle0, cmlt0, suqadd, usqadd, urecpe, ursqrte };

fn op1(comptime T: type, op: Op1, a: T, d: T, qc: *bool) T {
    const x = si.int(T, a, true);
    return switch (op) {
        .cls => si.cls(T, a),
        .clz => @clz(a),
        .cnt => @popCount(a),
        .not => ~a,
        .rbit => @bitReverse(a),
        .sqabs => si.satq(T, if (x < 0) -x else x, true, qc),
        .sqneg => si.satq(T, -x, true, qc),
        .abs => si.trunc(T, if (x < 0) -x else x),
        .neg => 0 -% a,
        .cmgt0 => si.mask(T, x > 0),
        .cmge0 => si.mask(T, x >= 0),
        .cmeq0 => si.mask(T, x == 0),
        .cmle0 => si.mask(T, x <= 0),
        .cmlt0 => si.mask(T, x < 0),
        .suqadd => si.satq(T, si.int(T, a, false) + si.int(T, d, true), true, qc),
        .usqadd => si.satq(T, x + si.int(T, d, false), false, qc),
        .urecpe => if (comptime T == u32) si.urecpe(a) else unreachable,
        .ursqrte => if (comptime T == u32) si.ursqrte(a) else unreachable,
    };
}
fn map1(comptime T: type, op: Op1, n: u128, d: u128, nl: usize, qc: *bool) u128 {
    const a = c.lanes(T, n);
    const acc = c.lanes(T, d);
    var r: [a.len]T = undefined;
    for (&r, 0..) |*x, i| x.* = if (i < nl) op1(T, op, a[i], acc[i], qc) else 0;
    return c.fromLanes(T, r);
}
fn map1s(size: u2, op: Op1, n: u128, d: u128, nl: usize, qc: *bool) u128 {
    return switch (size) {
        inline else => |z| map1(c.Elem(z), op, n, d, nl, qc),
    };
}

/// The same-size ops of two-reg misc that exist for every size (the 64-bit
/// one vector only with Q = 1, scalar only as D): opcode, U -> op.
fn miscAll(u: bool, opcode: u32) ?Op1 {
    return switch (opcode) {
        0b00011 => if (u) .usqadd else .suqadd,
        0b00111 => if (u) .sqneg else .sqabs,
        0b01000 => if (u) .cmge0 else .cmgt0,
        0b01001 => if (u) .cmle0 else .cmeq0,
        0b01010 => if (u) null else .cmlt0,
        0b01011 => if (u) .neg else .abs,
        else => null,
    };
}

const Narrow = enum { xtn, sqxtn, uqxtn, sqxtun };

/// XTN, SQXTN, UQXTN, SQXTUN: the low `nl` lanes of n (twice T's width)
/// narrowed to T, packed into 64 bits.
fn narrow(comptime T: type, mode: Narrow, n: u128, nl: usize, qc: *bool) u64 {
    const W = si.Wide(T);
    const a = c.lanes(W, n);
    var r: [8 / @sizeOf(T)]T = undefined;
    for (&r, 0..) |*x, i| x.* = if (i >= nl) 0 else switch (mode) {
        .xtn => @truncate(a[i]),
        .sqxtn => si.narrowSat(T, W, a[i], true, true, qc),
        .uqxtn => si.narrowSat(T, W, a[i], false, false, qc),
        .sqxtun => si.narrowSat(T, W, a[i], true, false, qc),
    };
    return @bitCast(r);
}
fn narrowS(size: u2, mode: Narrow, n: u128, nl: usize, qc: *bool) u64 {
    return switch (size) {
        inline 0, 1, 2 => |z| narrow(c.Elem(z), mode, n, nl, qc),
        3 => unreachable,
    };
}
/// Write a narrow result: the lower half (upper zeroed) or, for the "2"
/// forms (Q = 1), the upper half keeping the lower.
pub fn setHalf(s: c.St, d: u32, part: bool, r: u64) void {
    c.setVq(s, d, if (part) c.v128(c.vd(s, d), r) else r);
}

/// REV16, REV32, REV64: reverse the elements of each 2^cont-byte container.
fn rev(comptime T: type, v: u128, per: usize) u128 {
    const a = c.lanes(T, v);
    var r: [a.len]T = undefined;
    for (&r, 0..) |*x, i| x.* = a[i ^ (per - 1)];
    return c.fromLanes(T, r);
}

/// [SU]ADDLP, [SU]ADALP: adjacent pairs summed at twice the width.
fn addlp(comptime T: type, n: u128, d: u128, q: bool, signed: bool, acc: bool) u128 {
    const W = si.Wide(T);
    const a = c.lanes(T, n);
    const dw = c.lanes(W, d);
    var r: [8 / @sizeOf(T)]W = undefined;
    const cnt: usize = @as(usize, if (q) 16 else 8) / (2 * @sizeOf(T));
    for (&r, 0..) |*y, i| {
        const x = si.trunc(W, si.int(T, a[2 * i], signed) + si.int(T, a[2 * i + 1], signed));
        y.* = if (i >= cnt) 0 else if (acc) x +% dw[i] else x;
    }
    return c.fromLanes(W, r);
}

/// SHLL, SHLL2: each element of a half widened and shifted left by its width.
fn shll(comptime T: type, n: u128, part: bool) u128 {
    const W = si.Wide(T);
    const a = si.half(T, n, part);
    var r: [a.len]W = undefined;
    for (&r, a) |*x, e| x.* = @as(W, e) << @bitSizeOf(T);
    return c.fromLanes(W, r);
}

/// AdvSIMD two-register misc, vector (`0 Q U 01110 size 10000 opcode 10 Rn Rd`).
fn twoRegMisc(s: c.St, inst: u32) c.Exit {
    const q = c.bit(inst, 30);
    const u = c.bit(inst, 29);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const opcode = c.bits(inst, 16, 12);
    const n = c.vq(s, c.rn(inst));
    const d = c.rd(inst);
    var qc = false;
    if (miscAll(u, opcode)) |op| {
        if (size == 3 and !q) return c.ill(s, inst);
        const r = map1s(size, op, n, c.vq(s, d), si.vlanes(q, size), &qc);
        c.setVq(s, d, r);
        si.setQc(s, qc);
        return .next;
    }
    switch (opcode) {
        0b00000, 0b00001 => { // REV64, REV32 (U = 1), REV16
            if (opcode == 1 and u) return c.ill(s, inst);
            const cont: u2 = if (opcode == 1) 1 else if (u) 2 else 3; // log2 container bytes
            if (size >= cont) return c.ill(s, inst);
            const per = @as(usize, 1) << (cont - size);
            const r = switch (size) {
                inline 0, 1, 2 => |z| rev(c.Elem(z), n, per),
                3 => unreachable,
            };
            c.setVec(s, d, q, r);
        },
        0b00010, 0b00110 => { // [SU]ADDLP, [SU]ADALP
            if (size == 3) return c.ill(s, inst);
            const acc = opcode == 0b00110;
            const r = switch (size) {
                inline 0, 1, 2 => |z| addlp(c.Elem(z), n, c.vq(s, d), q, !u, acc),
                3 => unreachable,
            };
            c.setVq(s, d, r);
        },
        0b00100 => { // CLS, CLZ
            if (size == 3) return c.ill(s, inst);
            c.setVq(s, d, map1s(size, if (u) .clz else .cls, n, 0, si.vlanes(q, size), &qc));
        },
        0b00101 => { // CNT; NOT, RBIT (U = 1): byte lanes
            const op: Op1 = if (!u and size == 0) .cnt else if (u and size == 0) .not else if (u and size == 1) .rbit else return c.ill(s, inst);
            c.setVq(s, d, map1(u8, op, n, 0, si.vlanes(q, 0), &qc));
        },
        0b10010, 0b10100 => { // XTN, SQXTUN (U = 1); SQXTN, UQXTN
            if (size == 3) return c.ill(s, inst);
            const mode: Narrow = if (opcode == 0b10010) (if (u) .sqxtun else .xtn) else (if (u) .uqxtn else .sqxtn);
            const r = narrowS(size, mode, n, @as(usize, 8) >> size, &qc);
            setHalf(s, d, q, r);
            si.setQc(s, qc);
        },
        0b10011 => { // SHLL, SHLL2
            if (!u or size == 3) return c.ill(s, inst);
            const r = switch (size) {
                inline 0, 1, 2 => |z| shll(c.Elem(z), n, q),
                3 => unreachable,
            };
            c.setVq(s, d, r);
        },
        0b11100 => { // URECPE, URSQRTE (size 10); FCVTAS, FCVTAU (size 0x)
            if (size < 2) return fp.twoRegMisc(s, inst);
            if (size == 3) return c.ill(s, inst);
            c.setVq(s, d, map1(u32, if (u) .ursqrte else .urecpe, n, 0, si.vlanes(q, 2), &qc));
        },
        0b01100...0b01111, 0b10110, 0b10111, 0b11000...0b11011, 0b11101...0b11111 => return fp.twoRegMisc(s, inst),
        else => return c.ill(s, inst),
    }
    return .next;
}

/// AdvSIMD scalar two-register misc (`01 U 11110 size 10000 opcode 10 Rn Rd`).
fn scalarTwoRegMisc(s: c.St, inst: u32) c.Exit {
    const u = c.bit(inst, 29);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const opcode = c.bits(inst, 16, 12);
    const n = c.vq(s, c.rn(inst));
    const d = c.rd(inst);
    var qc = false;
    if (miscAll(u, opcode)) |op| {
        // SUQADD, USQADD, SQABS, SQNEG: B, H, S, D; the others D only
        const any = opcode == 0b00011 or opcode == 0b00111;
        if (!any and size != 3) return c.ill(s, inst);
        c.setVq(s, d, map1s(size, op, n, c.vq(s, d), 1, &qc));
        si.setQc(s, qc);
        return .next;
    }
    switch (opcode) {
        0b10010, 0b10100 => { // SQXTUN (U = 1); SQXTN, UQXTN
            if (size == 3 or (opcode == 0b10010 and !u)) return c.ill(s, inst);
            const mode: Narrow = if (opcode == 0b10010) .sqxtun else if (u) .uqxtn else .sqxtn;
            c.setVd(s, d, narrowS(size, mode, n, 1, &qc));
            si.setQc(s, qc);
            return .next;
        },
        0b01100...0b01111, 0b10110...0b11111 => return fp.scalarTwoRegMisc(s, inst),
        else => return c.ill(s, inst),
    }
}

test "simd_arith: two-reg misc ops on all 8-bit values" {
    for (std.enums.values(Op1)) |op| {
        if (op == .urecpe or op == .ursqrte) continue;
        for (0..256) |ai| for (0..256) |di| {
            const a: u8 = @intCast(ai);
            const d: u8 = @intCast(di);
            const sa: i32 = @as(i8, @bitCast(a));
            const sd: i32 = @as(i8, @bitCast(d));
            var q1 = false;
            const sat = struct {
                fn f(x: i32, signed: bool, q: *bool) i32 {
                    const lo: i32 = if (signed) -128 else 0;
                    const hi: i32 = if (signed) 127 else 255;
                    if (x < lo or x > hi) q.* = true;
                    return @max(lo, @min(hi, x));
                }
            }.f;
            const want: i32 = switch (op) {
                .cls => blk: {
                    var k: i32 = 0;
                    var i: u3 = 6;
                    while ((a >> i) & 1 == a >> 7) : (i -= 1) {
                        k += 1;
                        if (i == 0) break;
                    }
                    break :blk k;
                },
                .clz => @clz(a),
                .cnt => @popCount(a),
                .not => ~a,
                .rbit => @bitReverse(a),
                .sqabs => sat(@intCast(@abs(sa)), true, &q1),
                .sqneg => sat(-sa, true, &q1),
                .abs => @intCast(@abs(sa)),
                .neg => -sa,
                .cmgt0 => if (sa > 0) 255 else 0,
                .cmge0 => if (sa >= 0) 255 else 0,
                .cmeq0 => if (sa == 0) 255 else 0,
                .cmle0 => if (sa <= 0) 255 else 0,
                .cmlt0 => if (sa < 0) 255 else 0,
                .suqadd => sat(@as(i32, a) + sd, true, &q1),
                .usqadd => sat(sa + @as(i32, d), false, &q1),
                .urecpe, .ursqrte => unreachable,
            };
            var q2 = false;
            const got = op1(u8, op, a, d, &q2);
            if (@as(u8, @truncate(@as(u32, @bitCast(want)))) != got or q1 != q2) {
                std.debug.print("{t} a={x} d={x}: want {x} qc {} got {x} qc {}\n", .{ op, a, d, want, q1, got, q2 });
                return error.TestUnexpectedResult;
            }
        };
    }
}
