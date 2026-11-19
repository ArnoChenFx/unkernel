// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! AdvSIMD moves, logic and permutes: copy (DUP, INS, UMOV, SMOV; vector
//! and scalar DUP element), modified immediate (MOVI, MVNI, ORR, BIC,
//! FMOV vector), three-same logical (AND, BIC, ORR, ORN, EOR, BSL, BIT,
//! BIF), table lookup (TBL, TBX), permute (UZP1/2, TRN1/2, ZIP1/2) and
//! extract (EXT). decode.zig routes exactly these classes here.
//!
//! Complete for ARMv8.0. The FP16 FMOV (vector, immediate) (o2 = 1) is
//! FEAT_FP16 and stays ILLEGAL, as do the reserved neighbours of each class
//! (imm5 = x0000, the size/Q and imm4 combinations the Arm ARM marks
//! reserved or unallocated, op2 != 00 of TBL/TBX and EXT).

const std = @import("std");
const c = @import("common.zig");

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    if (inst & 0xdfe0_8400 == 0x5e00_0400) return scalarCopy(s, inst);
    if (inst & 0x9fe0_8400 == 0x0e00_0400) return copy(s, inst);
    if (inst & 0xbf20_8c00 == 0x0e00_0000) return tableLookup(s, inst);
    if (inst & 0xbf20_8c00 == 0x0e00_0800) return permute(s, inst);
    if (inst & 0xbf20_8400 == 0x2e00_0000) return extract(s, inst);
    if (inst & 0x9ff8_0400 == 0x0f00_0400) return modifiedImm(s, inst);
    if (inst & 0x9f20_fc00 == 0x0e20_1c00) return logical(s, inst);
    return c.ill(s, inst);
}

/// Element size (log2 bytes) and index from imm5; null for imm5 = x0000.
fn sizeIndex(imm5: u32) ?struct { size: u2, index: u32 } {
    if (imm5 & 15 == 0) return null;
    const size: u2 = @intCast(@ctz(imm5));
    return .{ .size = size, .index = imm5 >> (@as(u5, size) + 1) };
}
/// Element `i` (of 8 << size bits) of v, zero-extended.
pub fn elem(v: u128, size: u2, i: usize) u64 {
    return switch (size) {
        0 => c.lane(u8, v, i),
        1 => c.lane(u16, v, i),
        2 => c.lane(u32, v, i),
        3 => c.lane(u64, v, i),
    };
}
/// v with element `i` (of 8 << size bits) replaced by the low bits of x.
pub fn setElem(v: u128, size: u2, i: usize, x: u64) u128 {
    return switch (size) {
        0 => c.setLane(u8, v, i, @truncate(x)),
        1 => c.setLane(u16, v, i, @truncate(x)),
        2 => c.setLane(u32, v, i, @truncate(x)),
        3 => c.setLane(u64, v, i, x),
    };
}
/// The low 8 << size bits of x in every element of a 128-bit value.
pub fn dup(size: u2, x: u64) u128 {
    const r = c.replicate(x, @as(u7, 8) << size);
    return c.v128(r, r);
}

/// DUP (element), scalar form: Vd = Vn.Ts[index].
fn scalarCopy(s: c.St, inst: u32) c.Exit {
    if (c.bit(inst, 29) or c.bits(inst, 14, 11) != 0) return c.ill(s, inst);
    const si = sizeIndex(c.bits(inst, 20, 16)) orelse return c.ill(s, inst);
    c.setVq(s, c.rd(inst), elem(c.vq(s, c.rn(inst)), si.size, si.index));
    return .next;
}

fn copy(s: c.St, inst: u32) c.Exit {
    const q = c.bit(inst, 30);
    const si = sizeIndex(c.bits(inst, 20, 16)) orelse return c.ill(s, inst);
    const d = c.rd(inst);
    const n = c.rn(inst);
    const imm4 = c.bits(inst, 14, 11);
    if (c.bit(inst, 29)) { // INS (element): Vd.Ts[index] = Vn.Ts[index2]
        if (!q) return c.ill(s, inst);
        const x = elem(c.vq(s, n), si.size, imm4 >> si.size);
        c.setVq(s, d, setElem(c.vq(s, d), si.size, si.index, x));
        return .next;
    }
    switch (imm4) {
        0b0000 => { // DUP (element)
            if (si.size == 3 and !q) return c.ill(s, inst);
            c.setVec(s, d, q, dup(si.size, elem(c.vq(s, n), si.size, si.index)));
        },
        0b0001 => { // DUP (general)
            if (si.size == 3 and !q) return c.ill(s, inst);
            c.setVec(s, d, q, dup(si.size, c.xr(s, n)));
        },
        0b0011 => { // INS (general)
            if (!q) return c.ill(s, inst);
            c.setVq(s, d, setElem(c.vq(s, d), si.size, si.index, c.xr(s, n)));
        },
        0b0101 => { // SMOV
            if (si.size == 3 or (si.size == 2 and !q)) return c.ill(s, inst);
            const v = c.sextN(elem(c.vq(s, n), si.size, si.index), @as(u7, 8) << si.size);
            c.setR(s, q, d, v);
        },
        0b0111 => { // UMOV
            if ((q and si.size != 3) or (!q and si.size == 3)) return c.ill(s, inst);
            c.setX(s, d, elem(c.vq(s, n), si.size, si.index));
        },
        else => return c.ill(s, inst),
    }
    return .next;
}

/// AdvSIMDExpandImm(op, cmode, imm8); null where it is UNDEFINED.
pub fn expandImm(op: bool, cmode: u4, imm8: u8, q: bool) ?u64 {
    const i: u64 = imm8;
    return switch (cmode >> 1) {
        0 => c.replicate(i, 32),
        1 => c.replicate(i << 8, 32),
        2 => c.replicate(i << 16, 32),
        3 => c.replicate(i << 24, 32),
        4 => c.replicate(i, 16),
        5 => c.replicate(i << 8, 16),
        6 => c.replicate(if (cmode & 1 == 0) (i << 8) | 0xff else (i << 16) | 0xffff, 32),
        7 => if (cmode & 1 == 0) blk: {
            if (!op) break :blk c.replicate(i, 8);
            var r: u64 = 0;
            for (0..8) |k| {
                if ((imm8 >> @intCast(k)) & 1 != 0) r |= @as(u64, 0xff) << @intCast(8 * k);
            }
            break :blk r;
        } else if (!op) blk: { // FMOV (vector, single)
            const b6 = (i >> 6) & 1;
            const f: u64 = ((i >> 7) << 31) | ((b6 ^ 1) << 30) | ((if (b6 != 0) @as(u64, 0x1f) else 0) << 25) | ((i & 0x3f) << 19);
            break :blk c.replicate(f, 32);
        } else blk: { // FMOV (vector, double)
            if (!q) return null;
            const b6 = (i >> 6) & 1;
            break :blk ((i >> 7) << 63) | ((b6 ^ 1) << 62) | ((if (b6 != 0) @as(u64, 0xff) else 0) << 54) | ((i & 0x3f) << 48);
        },
        else => unreachable,
    };
}

fn modifiedImm(s: c.St, inst: u32) c.Exit {
    if (c.bit(inst, 11)) return c.ill(s, inst); // o2: FMOV (half), FEAT_FP16
    const q = c.bit(inst, 30);
    const op = c.bit(inst, 29);
    const cmode: u4 = @intCast(c.bits(inst, 15, 12));
    const imm8: u8 = @intCast((c.bits(inst, 18, 16) << 5) | c.bits(inst, 9, 5));
    const imm64 = expandImm(op, cmode, imm8, q) orelse return c.ill(s, inst);
    const imm = c.v128(imm64, imm64);
    const d = c.rd(inst);
    // ORR/BIC: cmode 0xx1 or 10x1; MVNI: op = 1 except cmode 1110 (MOVI 64-bit) and 1111 (FMOV)
    const orr_bic = cmode & 1 == 1 and cmode < 12;
    const r: u128 = if (orr_bic)
        (if (op) c.vq(s, d) & ~imm else c.vq(s, d) | imm)
    else if (op and cmode < 14) ~imm else imm;
    c.setVec(s, d, q, r);
    return .next;
}

fn logical(s: c.St, inst: u32) c.Exit {
    const q = c.bit(inst, 30);
    const d = c.rd(inst);
    const n = c.vq(s, c.rn(inst));
    const m = c.vq(s, c.rm(inst));
    const v = c.vq(s, d);
    const r: u128 = switch ((@as(u32, @intFromBool(c.bit(inst, 29))) << 2) | c.bits(inst, 23, 22)) {
        0 => n & m, // AND
        1 => n & ~m, // BIC
        2 => n | m, // ORR (MOV)
        3 => n | ~m, // ORN
        4 => n ^ m, // EOR
        5 => m ^ ((m ^ n) & v), // BSL
        6 => v ^ ((v ^ n) & m), // BIT
        7 => v ^ ((v ^ n) & ~m), // BIF
        else => unreachable,
    };
    c.setVec(s, d, q, r);
    return .next;
}

/// TBL, TBX (`0 Q 001110 op2 0 Rm 0 len op 00 Rn Rd`, op2 = 00): each byte
/// of Vm indexes the bytes of len + 1 table registers Vn, Vn+1, ... (wrapping
/// from V31 to V0); an index out of range gives 0 (TBL) or leaves the byte
/// of Vd (TBX).
fn tableLookup(s: c.St, inst: u32) c.Exit {
    if (c.bits(inst, 23, 22) != 0) return c.ill(s, inst);
    const q = c.bit(inst, 30);
    const regs = c.bits(inst, 14, 13) + 1;
    const n = c.rn(inst);
    var table: [64]u8 = @splat(0);
    for (0..4) |r| {
        if (r < regs) table[16 * r ..][0..16].* = c.lanes(u8, c.vq(s, (n + @as(u32, @intCast(r))) & 31));
    }
    const idx = c.lanes(u8, c.vq(s, c.rm(inst)));
    const d = c.rd(inst);
    var r = if (c.bit(inst, 12)) c.lanes(u8, c.vq(s, d)) else @as([16]u8, @splat(0));
    const limit = 16 * regs;
    for (0..16) |i| {
        if (idx[i] < limit) r[i] = table[idx[i]];
    }
    c.setVec(s, d, q, c.fromLanes(u8, r));
    return .next;
}

/// UZP1, TRN1, ZIP1, UZP2, TRN2, ZIP2 (`0 Q 001110 size 0 Rm 0 opcode 10 Rn
/// Rd`; opcode<2> selects the second form, opcode<1:0> 01 UZP, 10 TRN, 11
/// ZIP; 000, 100 and size = 11 with Q = 0 are unallocated).
fn permute(s: c.St, inst: u32) c.Exit {
    const q = c.bit(inst, 30);
    const size: u2 = @intCast(c.bits(inst, 23, 22));
    const opcode: u3 = @intCast(c.bits(inst, 14, 12));
    if (opcode & 3 == 0 or (size == 3 and !q)) return c.ill(s, inst);
    const n = c.vq(s, c.rn(inst));
    const m = c.vq(s, c.rm(inst));
    const r = switch (size) {
        0 => permuteOp(u8, opcode, q, n, m),
        1 => permuteOp(u16, opcode, q, n, m),
        2 => permuteOp(u32, opcode, q, n, m),
        3 => permuteOp(u64, opcode, q, n, m),
    };
    c.setVec(s, c.rd(inst), q, r);
    return .next;
}
/// The permute `opcode` (see `permute`) on elements of type T; Q = 0 uses
/// the low halves of n and m. Unused upper lanes are zero.
pub fn permuteOp(comptime T: type, opcode: u3, q: bool, n: u128, m: u128) u128 {
    const L = 16 / @sizeOf(T);
    const a = c.lanes(T, n);
    const b = c.lanes(T, m);
    const elems: usize = if (q) L else L / 2;
    const half = elems / 2;
    const part: usize = opcode >> 2;
    var r: [L]T = @splat(0);
    switch (opcode & 3) {
        1 => for (0..elems) |e| { // UZP: even (odd) elements of m:n
            const i = 2 * e + part;
            r[e] = if (i < elems) a[i] else b[i - elems];
        },
        2 => for (0..half) |p| { // TRN
            r[2 * p] = a[2 * p + part];
            r[2 * p + 1] = b[2 * p + part];
        },
        3 => for (0..half) |p| { // ZIP: interleave the low (high) halves
            r[2 * p] = a[part * half + p];
            r[2 * p + 1] = b[part * half + p];
        },
        else => unreachable,
    }
    return c.fromLanes(T, r);
}

/// EXT (`0 Q 101110 op2 0 Rm 0 imm4 0 Rn Rd`, op2 = 00): bytes imm4 ..
/// imm4 + 7 (+ 15) of Vm:Vn. Q = 0 with imm4<3> set is reserved.
fn extract(s: c.St, inst: u32) c.Exit {
    const q = c.bit(inst, 30);
    const imm4 = c.bits(inst, 14, 11);
    if (c.bits(inst, 23, 22) != 0 or (!q and imm4 >= 8)) return c.ill(s, inst);
    c.setVec(s, c.rd(inst), q, ext(q, imm4, c.vq(s, c.rn(inst)), c.vq(s, c.rm(inst))));
    return .next;
}
pub fn ext(q: bool, pos: u32, n: u128, m: u128) u128 {
    const a = c.lanes(u8, n);
    const b = c.lanes(u8, m);
    const bytes: u32 = if (q) 16 else 8;
    var r: [16]u8 = @splat(0);
    for (0..16) |i| {
        if (i >= bytes) break;
        const k = pos + @as(u32, @intCast(i));
        r[i] = if (k < bytes) a[k] else b[k - bytes];
    }
    return c.fromLanes(u8, r);
}
