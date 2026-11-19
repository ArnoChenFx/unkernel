// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Cryptographic extensions (FEAT_AES, FEAT_SHA1, FEAT_SHA256,
//! FEAT_SHA512, FEAT_SHA3) and CRC32 (FEAT_CRC32):
//!
//!   AES (KW_ISA_AES):     AESE, AESD, AESMC, AESIMC
//!   SHA1 (KW_ISA_SHA1):   SHA1C, SHA1P, SHA1M, SHA1H, SHA1SU0, SHA1SU1
//!   SHA2 (KW_ISA_SHA2):   SHA256H, SHA256H2, SHA256SU0, SHA256SU1
//!   SHA512 (KW_ISA_SHA512): SHA512H, SHA512H2, SHA512SU0, SHA512SU1 (op0 =
//!                         1100; kw_set_isa keeps it only with SHA2)
//!   SHA3 (KW_ISA_SHA3):   EOR3, BCAX, RAX1, XAR (op0 = 1100)
//!   CRC32 (KW_ISA_CRC32): CRC32B/H/W/X, CRC32CB/CH/CW/CX (encoded in
//!                         data-processing 2-source; dp_reg.zig calls `crc32`)
//!   PMULL (KW_ISA_PMULL): `pmull64`, the 64x64 -> 128 carry-less multiply of
//!                         PMULL/PMULL2 .1Q, whose decode (AdvSIMD three
//!                         different) is in simd_arith.zig
//!
//! The other ARMv8.2 classes decode.zig routes here (op0 = 1100: SM3,
//! SM4) are ILLEGAL: struct kw_cpu has no feature bit for them, so the
//! kernel never advertises them.
//!
//! None of this branches on or indexes memory by data, so the time these
//! take does not depend on keys or messages (as far as integer
//! multiplication is constant-time on the host; x86-64 and AArch64 are):
//! SubBytes is a bitsliced circuit (Boyar-Peralta) over the 16 state bytes,
//! not the S-box table core.aes (riscv Zkne/Zknd) uses; MixColumns works on
//! packed bytes; the carry-less multiply is core.bitmanip's fixed
//! multiply-and-mask sequence; CRC32 folds every input bit in with a mask
//! instead of a table lookup.

const std = @import("std");
const c = @import("common.zig");
const bitmanip = @import("../cpu/core.zig").bitmanip;

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    if (inst & 0xff3e_0c00 == 0x4e28_0800) return aes(s, inst);
    if (inst & 0xff20_8c00 == 0x5e00_0000) return sha3reg(s, inst);
    if (inst & 0xff3e_0c00 == 0x5e28_0800) return sha2reg(s, inst);
    if (inst & 0xffe0_b000 == 0xce60_8000) return sha512three(s, inst);
    if (inst & 0xffff_f000 == 0xcec0_8000) return sha512two(s, inst);
    if (inst & 0xff80_8000 == 0xce00_0000) return fourReg(s, inst);
    if (inst & 0xffe0_0000 == 0xce80_0000) return xarInst(s, inst);
    return c.ill(s, inst); // the rest of op0 = 1100: SM3, SM4 (ARMv8.2)
}

/// Four-register (`11001110 0 Op0 Rm 0 Ra Rn Rd`): Op0 00 EOR3, 01 BCAX
/// (SHA3); 10 is SM3SS1, 11 unallocated.
fn fourReg(s: c.St, inst: u32) c.Exit {
    const op0 = c.bits(inst, 22, 21);
    if (op0 >= 2 or !c.has(s, .sha3)) return c.ill(s, inst);
    const n = c.vq(s, c.rn(inst));
    const m = c.vq(s, c.rm(inst));
    const a = c.vq(s, c.ra(inst));
    c.setVq(s, c.rd(inst), if (op0 == 0) eor3(n, m, a) else bcax(n, m, a));
    return .next;
}

/// XAR (`11001110 100 Rm imm6 Rn Rd`, SHA3).
fn xarInst(s: c.St, inst: u32) c.Exit {
    if (!c.has(s, .sha3)) return c.ill(s, inst);
    c.setVq(s, c.rd(inst), xar(c.vq(s, c.rn(inst)), c.vq(s, c.rm(inst)), @intCast(c.bits(inst, 15, 10))));
    return .next;
}

/// Three-register SHA512 (`11001110 011 Rm 1 O 00 opcode Rn Rd`): O = 0,
/// opcode 00 SHA512H, 01 SHA512H2, 10 SHA512SU1, 11 RAX1 (SHA3); O = 1 is
/// SM3PARTW1/2, SM4EKEY.
fn sha512three(s: c.St, inst: u32) c.Exit {
    const op = c.bits(inst, 11, 10);
    if (c.bit(inst, 14) or !(if (op == 3) c.has(s, .sha3) else c.has(s, .sha512))) return c.ill(s, inst);
    const d = c.rd(inst);
    const vd = c.vq(s, d);
    const vn = c.vq(s, c.rn(inst));
    const vm = c.vq(s, c.rm(inst));
    c.setVq(s, d, switch (op) {
        0 => sha512h(vd, vn, vm),
        1 => sha512h2(vd, vn, vm),
        2 => sha512su1(vd, vn, vm),
        3 => rax1(vn, vm),
        else => unreachable,
    });
    return .next;
}

/// Two-register SHA512 (`11001110 11000000 1000 opcode Rn Rd`): opcode 00
/// SHA512SU0 (01 is SM4E).
fn sha512two(s: c.St, inst: u32) c.Exit {
    if (c.bits(inst, 11, 10) != 0 or !c.has(s, .sha512)) return c.ill(s, inst);
    const d = c.rd(inst);
    c.setVq(s, d, sha512su0(c.vq(s, d), c.vq(s, c.rn(inst))));
    return .next;
}

/// AES (`01001110 size 10100 opcode 10 Rn Rd`).
fn aes(s: c.St, inst: u32) c.Exit {
    if (c.bits(inst, 23, 22) != 0 or !c.has(s, .aes)) return c.ill(s, inst);
    const d = c.rd(inst);
    const n = c.rn(inst);
    const r = switch (c.bits(inst, 16, 12)) {
        0b00100 => aese(c.vq(s, d), c.vq(s, n)),
        0b00101 => aesd(c.vq(s, d), c.vq(s, n)),
        0b00110 => mixColumns(c.vq(s, n)),
        0b00111 => invMixColumns(c.vq(s, n)),
        else => return c.ill(s, inst),
    };
    c.setVq(s, d, r);
    return .next;
}

/// Three-register SHA (`01011110 size 0 Rm 0 opcode 00 Rn Rd`).
fn sha3reg(s: c.St, inst: u32) c.Exit {
    if (c.bits(inst, 23, 22) != 0) return c.ill(s, inst);
    const op = c.bits(inst, 14, 12);
    if (!(if (op < 4) c.has(s, .sha1) else c.has(s, .sha2)) or op == 7) return c.ill(s, inst);
    const d = c.rd(inst);
    const vd = c.vq(s, d);
    const vn = c.vq(s, c.rn(inst));
    const vm = c.vq(s, c.rm(inst));
    const r = switch (op) {
        0 => sha1Hash(.choose, vd, @truncate(vn), vm), // SHA1C
        1 => sha1Hash(.parity, vd, @truncate(vn), vm), // SHA1P
        2 => sha1Hash(.majority, vd, @truncate(vn), vm), // SHA1M
        3 => sha1su0(vd, vn, vm),
        4 => sha256Hash(vd, vn, vm, true), // SHA256H
        5 => sha256Hash(vn, vd, vm, false), // SHA256H2
        6 => sha256su1(vd, vn, vm),
        else => unreachable,
    };
    c.setVq(s, d, r);
    return .next;
}

/// Two-register SHA (`01011110 size 10100 opcode 10 Rn Rd`).
fn sha2reg(s: c.St, inst: u32) c.Exit {
    if (c.bits(inst, 23, 22) != 0) return c.ill(s, inst);
    const d = c.rd(inst);
    const vn = c.vq(s, c.rn(inst));
    switch (c.bits(inst, 16, 12)) {
        0 => if (c.has(s, .sha1)) c.setVs(s, d, std.math.rotl(u32, @truncate(vn), 30)) else return c.ill(s, inst), // SHA1H
        1 => if (c.has(s, .sha1)) c.setVq(s, d, sha1su1(c.vq(s, d), vn)) else return c.ill(s, inst),
        2 => if (c.has(s, .sha2)) c.setVq(s, d, sha256su0(c.vq(s, d), vn)) else return c.ill(s, inst),
        else => return c.ill(s, inst),
    }
    return .next;
}

// ---- PMULL ---------------------------------------------------------------------

/// PMULL/PMULL2 with 64-bit elements (1Q from 1D): the 128-bit carry-less
/// product of a and b, or null while KW_ISA_PMULL is not in
/// common.implemented (simd_arith.zig then raises ILLEGAL). The caller
/// decodes the instruction and must also check `c.has(s, .pmull)`, so that
/// kw_set_isa can turn it off.
pub fn pmull64(a: u64, b: u64) ?u128 {
    if (c.implemented & c.featureBit(.pmull) == 0) return null;
    return clmul128(a, b);
}

/// The 128-bit carry-less product of a and b (constant-time: no branches,
/// no memory indexed by data, no u128 multiply).
pub fn clmul128(a: u64, b: u64) u128 {
    return c.v128(bitmanip.clmul(a, b), bitmanip.clmulh(a, b));
}

// ---- CRC32 ---------------------------------------------------------------------

/// CRC32B/H/W/X and CRC32CB/CH/CW/CX: data-processing 2-source with
/// opcode = 010 C sz (dp_reg.twoSource routes inst<15:12> = 0100, 0101 here).
/// `Wd = CRC(Wn, Rm<8 << sz - 1:0>)`, the reflected CRC of the low `8 << sz`
/// bits of Rm (Xm for sz = 3, which needs sf = 1; the others sf = 0), with
/// no pre- or post-inversion.
pub fn crc32(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const sz: u2 = @intCast(c.bits(inst, 11, 10));
    if (c.bits(inst, 15, 13) != 0b010 or sf != (sz == 3) or !c.has(s, .crc32)) return c.ill(s, inst);
    const acc = c.wr(s, c.rn(inst));
    const val = c.xr(s, c.rm(inst));
    const r = if (c.bit(inst, 12)) crcUpdate(crc32c_poly, acc, val, sz) else crcUpdate(crc32_poly, acc, val, sz);
    c.setR(s, false, c.rd(inst), r);
    return .next;
}

/// Bit-reflected polynomials: CRC-32 (0x04C11DB7) and CRC-32C (0x1EDC6F41).
pub const crc32_poly: u32 = 0xEDB8_8320;
pub const crc32c_poly: u32 = 0x82F6_3B78;

/// The CRC accumulator `acc` updated with the low 8 << sz bits of `val`.
pub fn crcUpdate(comptime poly: u32, acc: u32, val: u64, sz: u2) u32 {
    return switch (sz) {
        0 => crcSteps(poly, acc ^ (@as(u32, @truncate(val)) & 0xff), 8),
        1 => crcSteps(poly, acc ^ (@as(u32, @truncate(val)) & 0xffff), 16),
        2 => crcSteps(poly, acc ^ @as(u32, @truncate(val)), 32),
        3 => crcSteps(poly, crcSteps(poly, acc ^ @as(u32, @truncate(val)), 32) ^ @as(u32, @truncate(val >> 32)), 32),
    };
}

/// `k` steps of the bitwise reflected CRC (x = x >> 1 ^ (poly if bit 0)):
/// bits >= k only move down by k; each bit i < k contributes a fixed
/// column, folded in under a mask.
inline fn crcSteps(comptime poly: u32, x: u32, comptime k: u6) u32 {
    const cols = comptime crcColumns(poly, k);
    var r: u32 = if (k == 32) 0 else x >> k;
    inline for (0..k) |i| r ^= cols[i] & (0 -% ((x >> i) & 1));
    return r;
}
fn crcColumns(comptime poly: u32, comptime k: u6) [k]u32 {
    @setEvalBranchQuota(10000);
    var t: [k]u32 = undefined;
    for (0..k) |i| {
        var x: u32 = @as(u32, 1) << i;
        for (0..k) |_| x = (x >> 1) ^ (poly & (0 -% (x & 1)));
        t[i] = x;
    }
    return t;
}

// ---- AES -----------------------------------------------------------------------
//
// The state is the register's 16 bytes in FIPS-197 order: byte r + 4c is
// row r of column c.

/// AESE: AddRoundKey (state = Vd ^ Vn), ShiftRows, SubBytes.
pub fn aese(d: u128, n: u128) u128 {
    return subBytes(shuffle(d ^ n, shift_rows));
}
/// AESD: AddRoundKey, InvShiftRows, InvSubBytes.
pub fn aesd(d: u128, n: u128) u128 {
    return invSubBytes(shuffle(d ^ n, inv_shift_rows));
}

/// ShiftRows: out byte r + 4c = in byte r + 4((c + r) % 4); inverse c - r.
const shift_rows = rowShift(1);
const inv_shift_rows = rowShift(3);
fn rowShift(comptime dir: u32) [16]i32 {
    var m: [16]i32 = undefined;
    for (0..16) |i| m[i] = @intCast(i % 4 + 4 * ((i / 4 + dir * (i % 4)) % 4));
    return m;
}
inline fn shuffle(v: u128, comptime mask: [16]i32) u128 {
    const b: @Vector(16, u8) = @bitCast(v);
    return @bitCast(@shuffle(u8, b, undefined, mask));
}

const V4 = @Vector(4, u32);
inline fn rotr4(v: V4, comptime k: u5) V4 {
    return (v >> @splat(k)) | (v << @splat(32 - @as(u6, k)));
}
/// Every byte times x in GF(2^8).
inline fn xtime4(v: V4) V4 {
    const hi = (v >> @splat(7)) & @as(V4, @splat(0x0101_0101));
    return ((v & @as(V4, @splat(0x7f7f_7f7f))) << @splat(1)) ^ (hi * @as(V4, @splat(0x1b)));
}
/// MixColumns of the four columns (AESMC): b_r = 2 s_r ^ 3 s_r+1 ^ s_r+2 ^ s_r+3.
pub fn mixColumns(v: u128) u128 {
    const x: V4 = @bitCast(v);
    const r1 = rotr4(x, 8);
    return @bitCast(xtime4(x ^ r1) ^ r1 ^ rotr4(x, 16) ^ rotr4(x, 24));
}
/// InvMixColumns (AESIMC), as MixColumns after the circulant (5, 0, 4, 0).
pub fn invMixColumns(v: u128) u128 {
    const x: V4 = @bitCast(v);
    const y = x ^ xtime4(xtime4(x ^ rotr4(x, 16)));
    return mixColumns(@bitCast(y));
}

/// SubBytes of all 16 bytes.
pub fn subBytes(v: u128) u128 {
    return fromPlanes(sbox(toPlanes(v)));
}
/// InvSubBytes. The S-box is A(inv(x)) with A(x) = M(x) ^ 0x63, and
/// M^-1 = L(x) = rotl(x, 1) ^ rotl(x, 3) ^ rotl(x, 6), L(0x63) = 0x05, so
/// InvSbox(x) = inv(L(x) ^ 0x05) = L(Sbox(L(x) ^ 0x05)) ^ 0x05.
pub fn invSubBytes(v: u128) u128 {
    return fromPlanes(invAffine(sbox(invAffine(toPlanes(v)))));
}

/// Plane b holds bit b of state byte j in its bit j.
const Planes = [8]u16;

/// Transpose the 8x8 bit matrix whose row j is byte j (bit 8j + i <->
/// bit 8i + j).
fn transpose8(x0: u64) u64 {
    var x = x0;
    var t = (x ^ (x >> 7)) & 0x00aa_00aa_00aa_00aa;
    x ^= t ^ (t << 7);
    t = (x ^ (x >> 14)) & 0x0000_cccc_0000_cccc;
    x ^= t ^ (t << 14);
    t = (x ^ (x >> 28)) & 0x0000_0000_f0f0_f0f0;
    x ^= t ^ (t << 28);
    return x;
}
fn toPlanes(v: u128) Planes {
    const h = c.lanes(u64, v);
    const lo = transpose8(h[0]);
    const hi = transpose8(h[1]);
    var p: Planes = undefined;
    inline for (0..8) |b| p[b] = @as(u16, @as(u8, @truncate(lo >> (8 * b)))) | @as(u16, @as(u8, @truncate(hi >> (8 * b)))) << 8;
    return p;
}
fn fromPlanes(p: Planes) u128 {
    var lo: u64 = 0;
    var hi: u64 = 0;
    inline for (0..8) |b| {
        lo |= @as(u64, @as(u8, @truncate(p[b]))) << (8 * b);
        hi |= @as(u64, p[b] >> 8) << (8 * b);
    }
    return c.v128(transpose8(lo), transpose8(hi));
}

/// L(x) ^ 0x05 on every byte (see invSubBytes): a rotation of a byte is a
/// renaming of planes.
fn invAffine(p: Planes) Planes {
    var r: Planes = undefined;
    inline for (0..8) |i| r[i] = p[(i + 7) % 8] ^ p[(i + 5) % 8] ^ p[(i + 2) % 8];
    r[0] = ~r[0];
    r[2] = ~r[2];
    return r;
}

/// The AES S-box on 16 bytes at once: the 113-gate circuit of Boyar and
/// Peralta ("A depth-16 circuit for the AES S-box", 2011), x0 the most
/// significant bit.
fn sbox(q: Planes) Planes {
    const x0 = q[7];
    const x1 = q[6];
    const x2 = q[5];
    const x3 = q[4];
    const x4 = q[3];
    const x5 = q[2];
    const x6 = q[1];
    const x7 = q[0];

    // top linear transformation
    const y14 = x3 ^ x5;
    const y13 = x0 ^ x6;
    const y9 = x0 ^ x3;
    const y8 = x0 ^ x5;
    const t0 = x1 ^ x2;
    const y1 = t0 ^ x7;
    const y4 = y1 ^ x3;
    const y12 = y13 ^ y14;
    const y2 = y1 ^ x0;
    const y5 = y1 ^ x6;
    const y3 = y5 ^ y8;
    const t1 = x4 ^ y12;
    const y15 = t1 ^ x5;
    const y20 = t1 ^ x1;
    const y6 = y15 ^ x7;
    const y10 = y15 ^ t0;
    const y11 = y20 ^ y9;
    const y7 = x7 ^ y11;
    const y17 = y10 ^ y11;
    const y19 = y10 ^ y8;
    const y16 = t0 ^ y11;
    const y21 = y13 ^ y16;
    const y18 = x0 ^ y16;

    // non-linear section: inversion in GF(2^8) over GF(2^4)
    const t2 = y12 & y15;
    const t3 = y3 & y6;
    const t4 = t3 ^ t2;
    const t5 = y4 & x7;
    const t6 = t5 ^ t2;
    const t7 = y13 & y16;
    const t8 = y5 & y1;
    const t9 = t8 ^ t7;
    const t10 = y2 & y7;
    const t11 = t10 ^ t7;
    const t12 = y9 & y11;
    const t13 = y14 & y17;
    const t14 = t13 ^ t12;
    const t15 = y8 & y10;
    const t16 = t15 ^ t12;
    const t17 = t4 ^ t14;
    const t18 = t6 ^ t16;
    const t19 = t9 ^ t14;
    const t20 = t11 ^ t16;
    const t21 = t17 ^ y20;
    const t22 = t18 ^ y19;
    const t23 = t19 ^ y21;
    const t24 = t20 ^ y18;

    const t25 = t21 ^ t22;
    const t26 = t21 & t23;
    const t27 = t24 ^ t26;
    const t28 = t25 & t27;
    const t29 = t28 ^ t22;
    const t30 = t23 ^ t24;
    const t31 = t22 ^ t26;
    const t32 = t31 & t30;
    const t33 = t32 ^ t24;
    const t34 = t23 ^ t33;
    const t35 = t27 ^ t33;
    const t36 = t24 & t35;
    const t37 = t36 ^ t34;
    const t38 = t27 ^ t36;
    const t39 = t29 & t38;
    const t40 = t25 ^ t39;

    const t41 = t40 ^ t37;
    const t42 = t29 ^ t33;
    const t43 = t29 ^ t40;
    const t44 = t33 ^ t37;
    const t45 = t42 ^ t41;
    const z0 = t44 & y15;
    const z1 = t37 & y6;
    const z2 = t33 & x7;
    const z3 = t43 & y16;
    const z4 = t40 & y1;
    const z5 = t29 & y7;
    const z6 = t42 & y11;
    const z7 = t45 & y17;
    const z8 = t41 & y10;
    const z9 = t44 & y12;
    const z10 = t37 & y3;
    const z11 = t33 & y4;
    const z12 = t43 & y13;
    const z13 = t40 & y5;
    const z14 = t29 & y2;
    const z15 = t42 & y9;
    const z16 = t45 & y14;
    const z17 = t41 & y8;

    // bottom linear transformation (and the affine constant 0x63)
    const t46 = z15 ^ z16;
    const t47 = z10 ^ z11;
    const t48 = z5 ^ z13;
    const t49 = z9 ^ z10;
    const t50 = z2 ^ z12;
    const t51 = z2 ^ z5;
    const t52 = z7 ^ z8;
    const t53 = z0 ^ z3;
    const t54 = z6 ^ z7;
    const t55 = z16 ^ z17;
    const t56 = z12 ^ t48;
    const t57 = t50 ^ t53;
    const t58 = z4 ^ t46;
    const t59 = z3 ^ t54;
    const t60 = t46 ^ t57;
    const t61 = z14 ^ t57;
    const t62 = t52 ^ t58;
    const t63 = t49 ^ t58;
    const t64 = z4 ^ t59;
    const t65 = t61 ^ t62;
    const t66 = z1 ^ t63;
    const s0 = t59 ^ t63;
    const s6 = t56 ^ ~t62;
    const s7 = t48 ^ ~t60;
    const t67 = t64 ^ t65;
    const s3 = t53 ^ t66;
    const s4 = t51 ^ t66;
    const s5 = t47 ^ t65;
    const s1 = t64 ^ ~s3;
    const s2 = t55 ^ ~t67;

    return .{ s7, s6, s5, s4, s3, s2, s1, s0 };
}

// ---- SHA-1 and SHA-256 ---------------------------------------------------------

inline fn choose(x: u32, y: u32, z: u32) u32 {
    return ((y ^ z) & x) ^ z;
}
inline fn majority(x: u32, y: u32, z: u32) u32 {
    return (x & y) | ((x | y) & z);
}
inline fn rotl(x: u32, comptime k: u5) u32 {
    return std.math.rotl(u32, x, k);
}
inline fn rotr(x: u32, comptime k: u5) u32 {
    return std.math.rotr(u32, x, k);
}

const Sha1Fn = enum { choose, parity, majority };

/// SHA1C, SHA1P, SHA1M: four rounds on the hash state x = (a, b, c, d) and
/// y = e with the four schedule words of w; returns the new (a, b, c, d).
pub fn sha1Hash(comptime f: Sha1Fn, x0: u128, y0: u32, w: u128) u128 {
    var x = c.lanes(u32, x0);
    var y = y0;
    const wl = c.lanes(u32, w);
    inline for (0..4) |e| {
        const t = switch (f) {
            .choose => choose(x[1], x[2], x[3]),
            .parity => x[1] ^ x[2] ^ x[3],
            .majority => majority(x[1], x[2], x[3]),
        };
        y = y +% rotl(x[0], 5) +% t +% wl[e];
        x[1] = rotl(x[1], 30);
        // <Y, X> = ROL(Y:X, 32) (through a copy: `x = .{ .., x[0], .. }`
        // would write x while reading it)
        const nx = [4]u32{ y, x[0], x[1], x[2] };
        y = x[3];
        x = nx;
    }
    return c.fromLanes(u32, x);
}

/// SHA1SU0: (n<63:0> : d<127:64>) ^ d ^ m.
pub fn sha1su0(d: u128, n: u128, m: u128) u128 {
    const a = c.lanes(u32, d);
    const b = c.lanes(u32, n);
    return c.fromLanes(u32, .{ a[2], a[3], b[0], b[1] }) ^ d ^ m;
}

/// SHA1SU1: T = d ^ (n >> 32); each word rotated left by 1, the top one
/// also xored with T<31:0> rotated left by 2.
pub fn sha1su1(d: u128, n: u128) u128 {
    const a = c.lanes(u32, d);
    const b = c.lanes(u32, n);
    const t = [4]u32{ a[0] ^ b[1], a[1] ^ b[2], a[2] ^ b[3], a[3] };
    return c.fromLanes(u32, .{ rotl(t[0], 1), rotl(t[1], 1), rotl(t[2], 1), rotl(t[3], 1) ^ rotl(t[0], 2) });
}

/// SHA256hash(X, Y, W, part1): four rounds on X = (a, b, c, d),
/// Y = (e, f, g, h); returns X (SHA256H) or Y (SHA256H2).
pub fn sha256Hash(x0: u128, y0: u128, w: u128, part1: bool) u128 {
    var x = c.lanes(u32, x0);
    var y = c.lanes(u32, y0);
    const wl = c.lanes(u32, w);
    inline for (0..4) |e| {
        const ch = choose(y[0], y[1], y[2]);
        const mj = majority(x[0], x[1], x[2]);
        const t1 = y[3] +% (rotr(y[0], 6) ^ rotr(y[0], 11) ^ rotr(y[0], 25)) +% ch +% wl[e];
        x[3] +%= t1;
        y[3] = t1 +% (rotr(x[0], 2) ^ rotr(x[0], 13) ^ rotr(x[0], 22)) +% mj;
        // <Y, X> = ROL(Y:X, 32), through copies
        const nx = [4]u32{ y[3], x[0], x[1], x[2] };
        const ny = [4]u32{ x[3], y[0], y[1], y[2] };
        x = nx;
        y = ny;
    }
    return c.fromLanes(u32, if (part1) x else y);
}

inline fn sigma0(x: u32) u32 {
    return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3);
}
inline fn sigma1(x: u32) u32 {
    return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10);
}

/// SHA256SU0: T = n<31:0> : d<127:32>; d + sigma0(T) per word.
pub fn sha256su0(d: u128, n: u128) u128 {
    const a = c.lanes(u32, d);
    const b = c.lanes(u32, n);
    const t = [4]u32{ a[1], a[2], a[3], b[0] };
    var r: [4]u32 = undefined;
    inline for (0..4) |e| r[e] = sigma0(t[e]) +% a[e];
    return c.fromLanes(u32, r);
}

/// SHA256SU1: T0 = m<31:0> : n<127:32>; words 0-1 from sigma1(m<127:64>),
/// words 2-3 from sigma1 of the new words 0-1.
pub fn sha256su1(d: u128, n: u128, m: u128) u128 {
    const a = c.lanes(u32, d);
    const b = c.lanes(u32, n);
    const w = c.lanes(u32, m);
    const t0 = [4]u32{ b[1], b[2], b[3], w[0] };
    var r: [4]u32 = undefined;
    r[0] = sigma1(w[2]) +% a[0] +% t0[0];
    r[1] = sigma1(w[3]) +% a[1] +% t0[1];
    r[2] = sigma1(r[0]) +% a[2] +% t0[2];
    r[3] = sigma1(r[1]) +% a[3] +% t0[3];
    return c.fromLanes(u32, r);
}

// ---- SHA-512 (FEAT_SHA512) -------------------------------------------------------
//
// The Arm ARM's pseudocode on the two 64-bit halves (lo = <63:0>, hi =
// <127:64>); Ch, Maj and the sigma functions of FIPS 180-4.

inline fn ror64(x: u64, comptime k: u6) u64 {
    return std.math.rotr(u64, x, k);
}
inline fn bigSigma0(x: u64) u64 {
    return ror64(x, 28) ^ ror64(x, 34) ^ ror64(x, 39);
}
inline fn bigSigma1(x: u64) u64 {
    return ror64(x, 14) ^ ror64(x, 18) ^ ror64(x, 41);
}
inline fn smallSigma0(x: u64) u64 {
    return ror64(x, 1) ^ ror64(x, 8) ^ (x >> 7);
}
inline fn smallSigma1(x: u64) u64 {
    return ror64(x, 19) ^ ror64(x, 61) ^ (x >> 6);
}
inline fn ch64(x: u64, y: u64, z: u64) u64 {
    return (x & y) ^ (~x & z);
}
inline fn maj64(x: u64, y: u64, z: u64) u64 {
    return (x & y) ^ (x & z) ^ (y & z);
}

/// SHA512H Qd, Qn, Vm.2D: two rounds' worth of the T1 sums (d = W, n = X,
/// m = Y in the pseudocode).
pub fn sha512h(d: u128, n: u128, m: u128) u128 {
    const w = c.lanes(u64, d);
    const x = c.lanes(u64, n);
    const y = c.lanes(u64, m);
    const hi = ch64(y[1], x[0], x[1]) +% bigSigma1(y[1]) +% w[1];
    const tmp = hi +% y[0];
    const lo = ch64(tmp, y[1], x[0]) +% bigSigma1(tmp) +% w[0];
    return c.v128(lo, hi);
}

/// SHA512H2 Qd, Qn, Vm.2D: the T2 sums (d = W, n = X, m = Y).
pub fn sha512h2(d: u128, n: u128, m: u128) u128 {
    const w = c.lanes(u64, d);
    const x = c.lanes(u64, n);
    const y = c.lanes(u64, m);
    const hi = maj64(x[0], y[1], y[0]) +% bigSigma0(y[0]) +% w[1];
    const lo = maj64(hi, y[0], y[1]) +% bigSigma0(hi) +% w[0];
    return c.v128(lo, hi);
}

/// SHA512SU0 Vd.2D, Vn.2D: message schedule, sigma0 part.
pub fn sha512su0(d: u128, n: u128) u128 {
    const w = c.lanes(u64, d);
    const x = c.lanes(u64, n);
    return c.v128(w[0] +% smallSigma0(w[1]), w[1] +% smallSigma0(x[0]));
}

/// SHA512SU1 Vd.2D, Vn.2D, Vm.2D: message schedule, sigma1 part.
pub fn sha512su1(d: u128, n: u128, m: u128) u128 {
    const w = c.lanes(u64, d);
    const x = c.lanes(u64, n);
    const y = c.lanes(u64, m);
    return c.v128(w[0] +% smallSigma1(x[0]) +% y[0], w[1] +% smallSigma1(x[1]) +% y[1]);
}

// ---- SHA-3 (FEAT_SHA3) -------------------------------------------------------------

/// EOR3 Vd.16B, Vn.16B, Vm.16B, Va.16B: n ^ m ^ a.
pub fn eor3(n: u128, m: u128, a: u128) u128 {
    return n ^ m ^ a;
}

/// BCAX Vd.16B, Vn.16B, Vm.16B, Va.16B: n ^ (m & ~a).
pub fn bcax(n: u128, m: u128, a: u128) u128 {
    return n ^ (m & ~a);
}

/// RAX1 Vd.2D, Vn.2D, Vm.2D: n ^ rol(m, 1) in each 64-bit lane.
pub fn rax1(n: u128, m: u128) u128 {
    const x = c.lanes(u64, n);
    const y = c.lanes(u64, m);
    return c.v128(x[0] ^ std.math.rotl(u64, y[0], 1), x[1] ^ std.math.rotl(u64, y[1], 1));
}

/// XAR Vd.2D, Vn.2D, Vm.2D, #imm6: ror(n ^ m, imm6) in each 64-bit lane.
pub fn xar(n: u128, m: u128, imm6: u6) u128 {
    const x = c.lanes(u64, n);
    const y = c.lanes(u64, m);
    return c.v128(std.math.rotr(u64, x[0] ^ y[0], imm6), std.math.rotr(u64, x[1] ^ y[1], imm6));
}
