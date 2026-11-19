// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! AdvSIMD three different (long, wide and narrowing ops) and x indexed
//! element, vector and scalar:
//!  - three different (`0 Q U 01110 size 1 Rm opcode 00 Rn Rd`): [SU]ADDL,
//!    [SU]ADDW, [SU]SUBL, [SU]SUBW, ADDHN, RADDHN, SUBHN, RSUBHN, [SU]ABAL,
//!    [SU]ABDL, [SU]MLAL, [SU]MLSL, [SU]MULL, SQDMLAL, SQDMLSL, SQDMULL,
//!    PMULL (8-bit lanes; 64-bit lanes through crypto.pmull64 behind the
//!    PMULL feature), all with their "2" forms; scalar SQDMLAL, SQDMLSL,
//!    SQDMULL;
//!  - by element (`0 Q U 01111 size L M Rm opcode H 0 Rn Rd`): MUL, MLA,
//!    MLS, [SU]MULL, [SU]MLAL, [SU]MLSL, SQDMULL, SQDMLAL, SQDMLSL, SQDMULH,
//!    SQRDMULH; scalar SQDMULL, SQDMLAL, SQDMLSL, SQDMULH, SQRDMULH. A
//!    by-element op is the vector op with the element broadcast as Vm.
//! FMLA, FMLS, FMUL, FMULX (by element) are simd_fp.zig's; the v8.1+
//! by-element ops (SQRDMLAH, SQRDMLSH, SDOT, UDOT, FMLAL, ...) are ILLEGAL.

const std = @import("std");
const c = @import("common.zig");
const si = @import("simd_int.zig");
const fp = @import("simd_fp.zig");
const arith = @import("simd_arith.zig");
const crypto = @import("crypto.zig");

/// Ops whose result elements are twice as wide as (at least one of) the
/// sources: n and m narrow (one 64-bit half), except n wide for ADDW/SUBW.
const LOp = enum { addl, subl, addw, subw, abal, abdl, mlal, mlsl, mull, sqdmlal, sqdmlsl, sqdmull, pmull };

fn mulw(comptime T: type, a: T, b: T, signed: bool) si.Wide(T) {
    if (signed) {
        const p: i64 = @as(i64, si.sx(T, a)) * si.sx(T, b); // T <= 32 bits: exact
        return @truncate(@as(u64, @bitCast(p)));
    }
    return @as(si.Wide(T), a) * b;
}

/// `nl` wide result lanes from the half `part` of n and m (T u8, u16, u32).
fn longOp(comptime T: type, op: LOp, n: u128, m: u128, d: u128, part: bool, nl: usize, signed: bool, qc: *bool) u128 {
    const W = si.Wide(T);
    const a = si.half(T, n, part);
    const b = si.half(T, m, part);
    const aw = c.lanes(W, n);
    const acc = c.lanes(W, d);
    var r: [a.len]W = undefined;
    for (&r, 0..) |*z, i| {
        const x = si.int(T, a[i], signed);
        const y = si.int(T, b[i], signed);
        z.* = if (i >= nl) 0 else switch (op) {
            .addl => si.trunc(W, x + y),
            .subl => si.trunc(W, x - y),
            .addw => si.trunc(W, si.int(W, aw[i], signed) + y),
            .subw => si.trunc(W, si.int(W, aw[i], signed) - y),
            .abal => acc[i] +% si.trunc(W, si.absDiff(T, a[i], b[i], signed)),
            .abdl => si.trunc(W, si.absDiff(T, a[i], b[i], signed)),
            .mlal => acc[i] +% mulw(T, a[i], b[i], signed),
            .mlsl => acc[i] -% mulw(T, a[i], b[i], signed),
            .mull => mulw(T, a[i], b[i], signed),
            .sqdmlal => if (comptime T != u8) si.sqdmlal(T, acc[i], a[i], b[i], false, qc) else unreachable,
            .sqdmlsl => if (comptime T != u8) si.sqdmlal(T, acc[i], a[i], b[i], true, qc) else unreachable,
            .sqdmull => if (comptime T != u8) si.sqdmull(T, a[i], b[i], qc) else unreachable,
            .pmull => if (comptime T == u8) si.clmul8(a[i], b[i]) else unreachable,
        };
    }
    return c.fromLanes(W, r);
}
fn longOpS(size: u2, op: LOp, n: u128, m: u128, d: u128, part: bool, nl: usize, signed: bool, qc: *bool) u128 {
    return switch (size) {
        inline 0, 1, 2 => |z| longOp(c.Elem(z), op, n, m, d, part, nl, signed, qc),
        3 => unreachable,
    };
}

/// ADDHN, RADDHN, SUBHN, RSUBHN: the high halves of the wide sums or
/// differences (modulo 2^(2 esize)), packed into 64 bits.
fn highNarrow(comptime T: type, n: u128, m: u128, sub: bool, round: bool) u64 {
    const W = si.Wide(T);
    const e = @bitSizeOf(T);
    const a = c.lanes(W, n);
    const b = c.lanes(W, m);
    var r: [8 / @sizeOf(T)]T = undefined;
    for (&r, 0..) |*x, i| {
        var v = if (sub) a[i] -% b[i] else a[i] +% b[i];
        if (round) v +%= @as(W, 1) << (e - 1);
        x.* = @truncate(v >> e);
    }
    return @bitCast(r);
}

/// AdvSIMD three different, vector (`0 Q U 01110 size 1 Rm opcode 00 Rn Rd`)
/// and scalar (`01 U 11110 size 1 Rm opcode 00 Rn Rd`: SQDMLAL, SQDMLSL,
/// SQDMULL only).
pub fn threeDiff(s: c.St, inst: u32, sc: bool) c.Exit {
    const q = c.bit(inst, 30);
    const u = c.bit(inst, 29);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const opcode = c.bits(inst, 15, 12);
    const n = c.vq(s, c.rn(inst));
    const m = c.vq(s, c.rm(inst));
    const d = c.rd(inst);
    var qc = false;
    const op: LOp = switch (opcode) {
        0b0000 => .addl,
        0b0001 => .addw,
        0b0010 => .subl,
        0b0011 => .subw,
        0b0101 => .abal,
        0b0111 => .abdl,
        0b1000 => .mlal,
        0b1010 => .mlsl,
        0b1100 => .mull,
        0b1001 => if (u) return c.ill(s, inst) else .sqdmlal,
        0b1011 => if (u) return c.ill(s, inst) else .sqdmlsl,
        0b1101 => if (u) return c.ill(s, inst) else .sqdmull,
        0b1110 => if (u) return c.ill(s, inst) else .pmull,
        0b0100, 0b0110 => { // ADDHN, RADDHN (U = 1), SUBHN, RSUBHN
            if (sc or size == 3) return c.ill(s, inst);
            const sub = opcode == 0b0110;
            const r = switch (size) {
                inline 0, 1, 2 => |z| highNarrow(c.Elem(z), n, m, sub, u),
                3 => unreachable,
            };
            arith.setHalf(s, d, q, r);
            return .next;
        },
        else => return c.ill(s, inst), // 1111
    };
    const sqd = op == .sqdmlal or op == .sqdmlsl or op == .sqdmull;
    if (sc and !sqd) return c.ill(s, inst);
    if (sqd and (size == 0 or size == 3)) return c.ill(s, inst);
    if (op == .pmull) {
        if (size == 3) { // PMULL (1Q from 1D): the PMULL feature
            if (!c.has(s, .pmull)) return c.ill(s, inst);
            const i: usize = @intFromBool(q);
            const r = crypto.pmull64(c.lane(u64, n, i), c.lane(u64, m, i)) orelse return c.ill(s, inst);
            c.setVq(s, d, r);
            return .next;
        }
        if (size != 0) return c.ill(s, inst);
    }
    if (size == 3) return c.ill(s, inst);
    const nl: usize = if (sc) 1 else @as(usize, 8) >> size;
    const r = longOpS(size, op, n, m, c.vq(s, d), q and !sc, nl, !u, &qc);
    c.setVq(s, d, r);
    si.setQc(s, qc);
    return .next;
}

/// AdvSIMD x indexed element, vector (`0 Q U 01111 size L M Rm opcode H 0 Rn
/// Rd`) and scalar (`01 U 11111 size L M Rm opcode H 0 Rn Rd`).
pub fn indexed(s: c.St, inst: u32, sc: bool) c.Exit {
    const q = c.bit(inst, 30);
    const u = c.bit(inst, 29);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const opcode = c.bits(inst, 15, 12);
    if (opcode == 0b0001 or opcode == 0b0101 or opcode == 0b1001) return fp.indexed(s, inst);
    const Kind = union(enum) { same: si.Op2, long: LOp };
    const kind: Kind = switch (opcode) {
        0b0000 => if (u and !sc) .{ .same = .mla } else return c.ill(s, inst),
        0b0100 => if (u and !sc) .{ .same = .mls } else return c.ill(s, inst),
        0b1000 => if (!u and !sc) .{ .same = .mul } else return c.ill(s, inst),
        0b0010 => if (!sc) .{ .long = .mlal } else return c.ill(s, inst),
        0b0110 => if (!sc) .{ .long = .mlsl } else return c.ill(s, inst),
        0b1010 => if (!sc) .{ .long = .mull } else return c.ill(s, inst),
        0b0011 => if (!u) .{ .long = .sqdmlal } else return c.ill(s, inst),
        0b0111 => if (!u) .{ .long = .sqdmlsl } else return c.ill(s, inst),
        0b1011 => if (!u) .{ .long = .sqdmull } else return c.ill(s, inst),
        0b1100 => if (!u) .{ .same = .sqdmulh } else return c.ill(s, inst),
        0b1101 => if (!u) .{ .same = .sqrdmulh } else return c.ill(s, inst), // U = 1: SQRDMLAH (v8.1)
        else => return c.ill(s, inst), // DOT (v8.2), SQRDMLSH (v8.1), FMLAL (FP16)
    };
    // H: index H:L:M, Vm in V0..V15; S: index H:L, Vm in V0..V31
    const h: u32 = @intFromBool(c.bit(inst, 11));
    const l: u32 = @intFromBool(c.bit(inst, 21));
    const index: usize, const mreg: u32 = switch (size) {
        1 => .{ (h << 2) | (l << 1) | @intFromBool(c.bit(inst, 20)), c.bits(inst, 19, 16) },
        2 => .{ (h << 1) | l, c.bits(inst, 20, 16) },
        else => return c.ill(s, inst),
    };
    const n = c.vq(s, c.rn(inst));
    const m = si.bcast(c.vq(s, mreg), size, index);
    const d = c.rd(inst);
    var qc = false;
    const r = switch (kind) {
        .same => |op| si.map2s(size, op, n, m, c.vq(s, d), if (sc) 1 else si.vlanes(q, size), &qc),
        .long => |op| longOpS(size, op, n, m, c.vq(s, d), q and !sc, if (sc) 1 else @as(usize, 8) >> size, !u, &qc),
    };
    c.setVq(s, d, r);
    si.setQc(s, qc);
    return .next;
}
