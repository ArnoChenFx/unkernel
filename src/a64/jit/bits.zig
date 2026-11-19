// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, bit-manipulation and multiply family (emit.zig; stream "ALU
//! and flags"). Semantics: opexec.zig. Every kind of the family is
//! translated, a few wasm i64 ops each with the op's shift counts and masks
//! as constants: ubfm/sbfm/bfm are shl/shr(_s)/shl (+ and), extr a
//! shr/shl/or; the variable shifts use wasm's own count masking (i64 ops for
//! X, i32 ops on the low halves for W, zero-extended); madd/maddl i64.mul;
//! umulh/smulh the 32x32 decomposition of riscv's jit.zig `mulhu` and
//! `mulCorr` (wasm has no 64x64 -> 128 multiply); udiv/sdiv guard the zero
//! divisor (result 0) and, for sdiv, MIN / -1 (wasm traps on both; -1 is
//! done as a negation), W forms on the low halves as dp_reg.sdiv does;
//! rev1: i64.clz/i32.clz, byte and bit reversals by mask swaps (MVP wasm
//! has no bswap or bit reverse). None of them touches NZCV.

const std = @import("std");
const ops = @import("../ops.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const W = jc.W;

pub const kinds = [_]ops.H{
    .ubfm, .sbfm, .bfm, .extr, .lslv, .lsrv, .asrv, .rorv, .madd, .maddl, .umulh, .smulh, .udiv, .sdiv, .rev1,
};

/// This family's part of the module's emission state (`e.x.bits`).
pub const Ext = struct {};

const i32_sub: u8 = 0x6b; // not in jc.W

pub fn supported(o: Op) bool {
    return jit.family(o.h) == .bits;
}

pub fn usage(o: Op) Use {
    return switch (o.h) {
        .ubfm, .sbfm, .rev1 => .{ .read = cm.xbit(o.b), .write = cm.xbit(o.a) },
        .bfm => .{ .read = cm.xbit(o.a) | cm.xbit(o.b), .write = cm.xbit(o.a) },
        .madd, .maddl => .{ .read = cm.xbit(o.b) | cm.xbit(o.c) | cm.xbit(o.d), .write = cm.xbit(o.a) },
        else => cm.abc(o),
    };
}

const ones: u64 = std.math.maxInt(u64);

fn shift(e: *Emit, opc: u8, n: u64) void {
    if (n == 0) return;
    e.k64(n);
    e.op(opc);
}
fn mask(e: *Emit, m: u64) void {
    if (m == ones) return;
    e.k64(m);
    e.op(W.i64_and);
}
/// Push the low half of slot as an i32.
fn lo32(e: *Emit, slot: u8) void {
    cm.get(e, slot);
    e.op(W.i32_wrap);
}

/// x = ((x >> s) & m) | ((x & m) << s) on local l (one mask-swap step).
fn swap(e: *Emit, l: u32, s: u64, m: u64) void {
    e.get(l);
    e.k64(s);
    e.op(W.i64_shr_u);
    e.k64(m);
    e.op(W.i64_and);
    e.get(l);
    e.k64(m);
    e.op(W.i64_and);
    e.k64(s);
    e.op(W.i64_shl);
    e.op(W.i64_or);
    e.set(l);
}

/// Push the high 64 bits of the unsigned product of slots b and c (l_t +
/// 0..4; riscv's jit.zig `mulhu`).
fn mulhu(e: *Emit, b: u8, c: u8) void {
    const t0 = cm.l_t;
    const t1 = cm.l_t + 1;
    const t2 = cm.l_t + 2;
    const t3 = cm.l_t + 3;
    const t4 = cm.l_t + 4;
    const lo: u64 = 0xffff_ffff;
    cm.get(e, b);
    e.k64(lo);
    e.op(W.i64_and);
    e.set(t0);
    cm.get(e, b);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.set(t1);
    cm.get(e, c);
    e.k64(lo);
    e.op(W.i64_and);
    e.set(t2);
    cm.get(e, c);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.set(t3);
    // t4 = bhi*clo + (blo*clo >> 32)
    e.get(t1);
    e.get(t2);
    e.op(W.i64_mul);
    e.get(t0);
    e.get(t2);
    e.op(W.i64_mul);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.op(W.i64_add);
    e.set(t4);
    // bhi*chi + (t4 >> 32) + ((blo*chi + (t4 & lo)) >> 32)
    e.get(t1);
    e.get(t3);
    e.op(W.i64_mul);
    e.get(t4);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.op(W.i64_add);
    e.get(t0);
    e.get(t3);
    e.op(W.i64_mul);
    e.get(t4);
    e.k64(lo);
    e.op(W.i64_and);
    e.op(W.i64_add);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.op(W.i64_add);
}

/// Signed-operand correction of mulhu: subtract (s >>a 63) & other.
fn mulCorr(e: *Emit, s: u8, other: u8) void {
    cm.get(e, s);
    e.k64(63);
    e.op(W.i64_shr_s);
    cm.get(e, other);
    e.op(W.i64_and);
    e.op(W.i64_sub);
}

pub fn emit(e: *Emit, o: Op, at: At) void {
    _ = at;
    switch (o.h) {
        .ubfm => { // ((b << d) >> e) << f
            cm.get(e, o.b);
            shift(e, W.i64_shl, o.d);
            shift(e, W.i64_shr_u, o.e);
            shift(e, W.i64_shl, o.f);
            cm.set(e, o.a);
        },
        .sbfm => { // (((b << d) >>a e) << f) & (~0 >> g)
            cm.get(e, o.b);
            shift(e, W.i64_shl, o.d);
            shift(e, W.i64_shr_s, o.e);
            shift(e, W.i64_shl, o.f);
            mask(e, ones >> @intCast(o.g));
            cm.set(e, o.a);
        },
        .bfm => { // ((a & ~imm) | ((b << d) >> e) << f) & (~0 >> g)
            cm.get(e, o.a);
            mask(e, ~o.imm);
            cm.get(e, o.b);
            shift(e, W.i64_shl, o.d);
            shift(e, W.i64_shr_u, o.e);
            shift(e, W.i64_shl, o.f);
            e.op(W.i64_or);
            mask(e, ones >> @intCast(o.g));
            cm.set(e, o.a);
        },
        .extr => { // EXTR(b:c, d) at 64 (e = 0) or 32 bits, d in 1..63
            const lsb: u64 = o.d;
            if (o.e == 0) {
                cm.get(e, o.c);
                shift(e, W.i64_shr_u, lsb);
                cm.get(e, o.b);
                shift(e, W.i64_shl, 64 - lsb);
                e.op(W.i64_or);
            } else {
                // ((c & m) | (b << 32)) >> lsb, & m
                cm.get(e, o.c);
                mask(e, 0xffff_ffff);
                cm.get(e, o.b);
                shift(e, W.i64_shl, 32);
                e.op(W.i64_or);
                shift(e, W.i64_shr_u, lsb);
                mask(e, 0xffff_ffff);
            }
            cm.set(e, o.a);
        },
        .lslv, .lsrv, .asrv, .rorv => {
            // wasm masks the count to 63 (i64) or 31 (i32), as A64 does
            if (o.d == 0) {
                cm.get(e, o.b);
                cm.get(e, o.c);
                e.op(switch (o.h) {
                    .lslv => W.i64_shl,
                    .lsrv => W.i64_shr_u,
                    .asrv => W.i64_shr_s,
                    else => W.i64_rotr,
                });
            } else {
                lo32(e, o.b);
                lo32(e, o.c);
                e.op(switch (o.h) {
                    .lslv => W.i32_shl,
                    .lsrv => W.i32_shr_u,
                    .asrv => W.i32_shr_s,
                    else => W.i32_rotr,
                });
                e.op(W.i64_ext_u);
            }
            cm.set(e, o.a);
        },
        .madd => { // d + b * c or d - b * c (e: SUB), & (~0 >> f)
            cm.get(e, o.d);
            cm.get(e, o.b);
            cm.get(e, o.c);
            e.op(W.i64_mul);
            e.op(if (o.e != 0) W.i64_sub else W.i64_add);
            mask(e, ones >> @intCast(o.f));
            cm.set(e, o.a);
        },
        .maddl => { // d +- ext(b) * ext(c): f = 1 sign, 0 zero extension of the low halves
            cm.get(e, o.d);
            for ([_]u8{ o.b, o.c }) |s| {
                lo32(e, s);
                e.op(if (o.f != 0) W.i64_ext_s else W.i64_ext_u);
            }
            e.op(W.i64_mul);
            e.op(if (o.e != 0) W.i64_sub else W.i64_add);
            cm.set(e, o.a);
        },
        .umulh, .smulh => {
            mulhu(e, o.b, o.c);
            if (o.h == .smulh) {
                mulCorr(e, o.b, o.c);
                mulCorr(e, o.c, o.b);
            }
            cm.set(e, o.a);
        },
        .udiv => { // c == 0: 0 (d = w32: the low halves)
            const t = cm.l_t;
            const m = ones >> @intCast(o.d);
            cm.get(e, o.c);
            mask(e, m);
            e.tee(t);
            e.op(W.i64_eqz);
            e.open(W.@"if", W.i64_t);
            e.k64(0);
            e.op(W.@"else");
            cm.get(e, o.b);
            mask(e, m);
            e.get(t);
            e.op(W.i64_div_u);
            e.close();
            cm.set(e, o.a);
        },
        .sdiv => sdiv(e, o),
        .rev1 => rev1(e, o),
        else => unreachable,
    }
}

/// SDIV (dp_reg.sdiv): towards zero, 0 for a zero divisor, -1 as a negation
/// (MIN / -1 = MIN; wasm's div_s traps on it). W: on the low halves,
/// zero-extended.
fn sdiv(e: *Emit, o: Op) void {
    const t = cm.l_t;
    if (o.d == 0) {
        cm.get(e, o.c);
        e.tee(t);
        e.k64(ones);
        e.op(W.i64_eq);
        e.open(W.@"if", W.i64_t);
        e.k64(0);
        cm.get(e, o.b);
        e.op(W.i64_sub);
        e.op(W.@"else");
        e.get(t);
        e.op(W.i64_eqz);
        e.open(W.@"if", W.i64_t);
        e.k64(0);
        e.op(W.@"else");
        cm.get(e, o.b);
        e.get(t);
        e.op(W.i64_div_s);
        e.close();
        e.close();
    } else {
        // t = the low half of c, sign-extended (only compared and divided by)
        lo32(e, o.c);
        e.op(W.i64_ext_s);
        e.tee(t);
        e.k64(ones);
        e.op(W.i64_eq);
        e.open(W.@"if", W.i32_t);
        e.k32(0);
        lo32(e, o.b);
        e.op(i32_sub);
        e.op(W.@"else");
        e.get(t);
        e.op(W.i64_eqz);
        e.open(W.@"if", W.i32_t);
        e.k32(0);
        e.op(W.@"else");
        lo32(e, o.b);
        e.get(t);
        e.op(W.i32_wrap);
        e.op(W.i32_div_s);
        e.close();
        e.close();
        e.op(W.i64_ext_u);
    }
    cm.set(e, o.a);
}

/// RBIT (d = 0), REV16 (1), REV32 / REV W (2), REV X (3), CLZ (4), CLS (5);
/// e = w32.
fn rev1(e: *Emit, o: Op) void {
    const w = o.e != 0;
    const t = cm.l_t;
    switch (o.d) {
        0, 1, 2, 3 => {
            cm.get(e, o.b);
            e.set(t);
            if (o.d == 0) {
                swap(e, t, 1, 0x5555_5555_5555_5555);
                swap(e, t, 2, 0x3333_3333_3333_3333);
                swap(e, t, 4, 0x0f0f_0f0f_0f0f_0f0f);
            }
            swap(e, t, 8, 0x00ff_00ff_00ff_00ff);
            if (o.d != 1) swap(e, t, 16, 0x0000_ffff_0000_ffff);
            // each word of t is reversed (by bits or bytes) in place now
            e.get(t);
            if (w) {
                mask(e, 0xffff_ffff); // RBIT W, REV16 W, REV W
            } else if (o.d == 0 or o.d == 3) {
                e.k64(32); // RBIT, REV: swap the words too
                e.op(W.i64_rotr);
            }
        },
        4 => { // CLZ
            if (w) {
                lo32(e, o.b);
                e.op(W.i32_clz);
                e.op(W.i64_ext_u);
            } else {
                cm.get(e, o.b);
                e.op(W.i64_clz);
            }
        },
        5 => { // CLS: clz(a ^ (a << 1) | 1); W on v = b << 32 with the 1 at bit 32
            const s: u64 = if (w) 32 else 0;
            cm.get(e, o.b);
            shift(e, W.i64_shl, s);
            e.tee(t);
            e.get(t);
            e.k64(1);
            e.op(W.i64_shl);
            e.op(W.i64_xor);
            e.k64(@as(u64, 1) << @intCast(s));
            e.op(W.i64_or);
            e.op(W.i64_clz);
        },
        else => unreachable,
    }
    cm.set(e, o.a);
}

pub fn beginMember(e: *Emit, o: []const Op) void {
    _ = .{ e, o };
}

pub fn sync(e: *Emit) void {
    _ = e;
}

// ---- tests (kindtest.zig) -----------------------------------------------------------

const kt = @import("kindtest.zig");
const Rel = @import("alu.zig").Rel;

/// A bitfield field (immr, imms) value, edges often.
fn bf(r: std.Random, sf: u32) u32 {
    const top: u32 = if (sf != 0) 63 else 31;
    return switch (r.uintLessThan(u32, 4)) {
        0 => 0,
        1 => top,
        else => r.uintLessThan(u32, top + 1),
    };
}
/// SBFM (opc 0), BFM (1), UBFM (2) and their aliases.
fn bitfield(r: std.Random, n: u32, opc: u32) u32 {
    const sf = kt.sf(r);
    return 0x1300_0000 | sf | (opc << 29) | (sf >> 9) | (bf(r, sf) << 16) | (bf(r, sf) << 10) | (n << 5) | kt.dst(r);
}
fn wSbfm(r: std.Random, n: u32, m: u32) u32 {
    _ = m;
    return bitfield(r, n, 0);
}
fn wBfm(r: std.Random, n: u32, m: u32) u32 {
    _ = m;
    return bitfield(r, n, 1);
}
fn wUbfm(r: std.Random, n: u32, m: u32) u32 {
    _ = m;
    return bitfield(r, n, 2);
}
fn wExtr(r: std.Random, n: u32, m: u32) u32 { // EXTR, ROR (immediate) when n == m
    const sf = kt.sf(r);
    return 0x1380_0000 | sf | (sf >> 9) | (m << 16) | (bf(r, sf) << 10) | (n << 5) | kt.dst(r);
}
/// LSLV (0), LSRV (1), ASRV (2), RORV (3).
fn shiftv(r: std.Random, n: u32, m: u32, op: u32) u32 {
    return 0x1ac0_2000 | kt.sf(r) | (m << 16) | (op << 10) | (n << 5) | kt.dst(r);
}
fn wLslv(r: std.Random, n: u32, m: u32) u32 {
    return shiftv(r, n, m, 0);
}
fn wLsrv(r: std.Random, n: u32, m: u32) u32 {
    return shiftv(r, n, m, 1);
}
fn wAsrv(r: std.Random, n: u32, m: u32) u32 {
    return shiftv(r, n, m, 2);
}
fn wRorv(r: std.Random, n: u32, m: u32) u32 {
    return shiftv(r, n, m, 3);
}
fn wUdiv(r: std.Random, n: u32, m: u32) u32 {
    return 0x1ac0_0800 | kt.sf(r) | (m << 16) | (n << 5) | kt.dst(r);
}
fn wSdiv(r: std.Random, n: u32, m: u32) u32 {
    return 0x1ac0_0c00 | kt.sf(r) | (m << 16) | (n << 5) | kt.dst(r);
}
fn wMadd(r: std.Random, n: u32, m: u32) u32 { // MADD, MSUB (MUL, MNEG with Ra = XZR)
    return 0x1b00_0000 | kt.sf(r) | (m << 16) | (r.uintLessThan(u32, 2) << 15) | (kt.anyReg(r) << 10) | (n << 5) | kt.dst(r);
}
fn wMaddl(r: std.Random, n: u32, m: u32) u32 { // SMADDL, SMSUBL, UMADDL, UMSUBL (SMULL, UMULL, ...)
    return (if (r.boolean()) @as(u32, 0x9b20_0000) else 0x9ba0_0000) | (m << 16) | (r.uintLessThan(u32, 2) << 15) | (kt.anyReg(r) << 10) | (n << 5) | kt.dst(r);
}
fn wUmulh(r: std.Random, n: u32, m: u32) u32 {
    return 0x9bc0_7c00 | (m << 16) | (n << 5) | kt.dst(r);
}
fn wSmulh(r: std.Random, n: u32, m: u32) u32 {
    return 0x9b40_7c00 | (m << 16) | (n << 5) | kt.dst(r);
}
fn wRev1(r: std.Random, n: u32, m: u32) u32 { // RBIT, REV16, REV32, REV, CLZ, CLS
    _ = m;
    const sf = kt.sf(r);
    const opc = r.uintLessThan(u32, 6);
    return 0x5ac0_0000 | (if (opc == 3) 1 << 31 else sf) | (opc << 10) | (n << 5) | kt.dst(r);
}

test "a64 jit bits: ubfm" {
    try kt.kind(.ubfm, Rel(wUbfm), .{});
}
test "a64 jit bits: sbfm" {
    try kt.kind(.sbfm, Rel(wSbfm), .{});
}
test "a64 jit bits: bfm" {
    try kt.kind(.bfm, Rel(wBfm), .{});
}
test "a64 jit bits: extr" {
    try kt.kind(.extr, Rel(wExtr), .{});
}
test "a64 jit bits: lslv" {
    try kt.kind(.lslv, Rel(wLslv), .{});
}
test "a64 jit bits: lsrv" {
    try kt.kind(.lsrv, Rel(wLsrv), .{});
}
test "a64 jit bits: asrv" {
    try kt.kind(.asrv, Rel(wAsrv), .{});
}
test "a64 jit bits: rorv" {
    try kt.kind(.rorv, Rel(wRorv), .{});
}
test "a64 jit bits: madd" {
    try kt.kind(.madd, Rel(wMadd), .{});
}
test "a64 jit bits: maddl" {
    try kt.kind(.maddl, Rel(wMaddl), .{});
}
test "a64 jit bits: umulh" {
    try kt.kind(.umulh, Rel(wUmulh), .{});
}
test "a64 jit bits: smulh" {
    try kt.kind(.smulh, Rel(wSmulh), .{});
}
test "a64 jit bits: udiv" {
    try kt.kind(.udiv, Rel(wUdiv), .{});
}
test "a64 jit bits: sdiv" {
    try kt.kind(.sdiv, Rel(wSdiv), .{});
}
test "a64 jit bits: rev1 (RBIT, REV16, REV32, REV, CLZ, CLS)" {
    try kt.kind(.rev1, Rel(wRev1), .{});
}
