// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa
//! A64 JIT: the `generic` ops that compiled code runs inline instead of
//! calling the interpreter (emit.zig, `generic`). The tier keeps them
//! `generic` (the reference interpreter runs them there); these are the
//! frequent ones on the image, measured 2026-11-18 with a stats kernel:
//! musl's soft long double in printf (busybox `seq`: FMOV between general
//! and FP registers, MRS FPCR, MOVI, ORR (vector) as MOV, FCMPE) and its
//! memset (DUP, MOVI, MVNI, MRS DCZID_EL0), and UMOV/INS of 64-bit lanes.
//!
//!   decode(raw) ?Fast   the word's fast form, only for encodings the
//!                       reference accepts with exactly that meaning
//!   usage(f) Use        what it reads and writes
//!   emit(e, f, at)      its code; FCMP hands back on a NaN operand or
//!                       FPCR.FZ (flags or flushing to compute)
//!
//! Each is checked against the reference by emit.zig's generic kind test.

const std = @import("std");
const c = @import("../common.zig");
const ops = @import("../ops.zig");
const jc = @import("../../emu/jitcore.zig");
const simd_move = @import("../simd_move.zig");
const branch = @import("../branch.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const alu = @import("alu.zig");
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const W = jc.W;

pub const Kind = enum(u8) {
    /// Xd = (Vn's 64-bit half h) & mask (FMOV Wd/Xd from Sn/Dn/Vn.D[1], UMOV)
    to_x,
    /// Vd: lo = Xn & mask, hi = 0 (FMOV Sd, Wn and Dd, Xn)
    from_x,
    /// Vd's half h = Xn (FMOV Vd.D[1], Xn; INS Vd.D[i], Xn)
    ins64,
    /// Vd = the constant k in lo and, if q, in hi (MOVI, MVNI)
    movi,
    /// Vd = n op m per half (AND, BIC, ORR, ORN, EOR; vector)
    logic,
    /// Vd = (Xn & mask) * pattern in lo and, if q, in hi (DUP general)
    dup,
    /// Xt = regs.fpcr / regs.fpsr (MRS)
    mrs_fp,
    /// Xt = NZCV (MRS)
    mrs_nzcv,
    /// Xt = the constant k (MRS DCZID_EL0, CTR_EL0, CNTFRQ_EL0)
    mrs_k,
    /// NZCV = compare of Sn/Dn with Sm/Dm or +0 (FCMP, FCMPE)
    fcmp,
};

pub const Fast = struct {
    kind: Kind,
    /// Register numbers (V or X by kind; 31 is XZR for X).
    d: u8 = 0,
    n: u8 = 0,
    m: u8 = 0,
    /// to_x: which half (0 lo, 1 hi) and the shift in it; ins64: the half;
    /// mrs_fp: 0 FPCR, 1 FPSR; fcmp: 1 = double.
    h: u8 = 0,
    shift: u8 = 0,
    q: bool = false,
    /// fcmp: compare with +0.0
    zero: bool = false,
    /// logic: 0 AND, 1 BIC, 2 ORR, 3 ORN, 4 EOR
    op: u8 = 0,
    mask: u64 = 0,
    k: u64 = 0,
};

fn bits(x: u32, comptime hi: u5, comptime lo: u5) u32 {
    return c.bits(x, hi, lo);
}

pub fn decode(raw: u32) ?Fast {
    const d: u8 = @intCast(raw & 31);
    const n: u8 = @intCast((raw >> 5) & 31);
    const m: u8 = @intCast((raw >> 16) & 31);
    // FMOV (general): sf 0 0 11110 ftype 1 rmode opcode 000000 Rn Rd
    switch (raw & 0xffff_fc00) {
        0x1e26_0000 => return .{ .kind = .to_x, .d = d, .n = n, .mask = 0xffff_ffff }, // fmov wd, sn
        0x9e66_0000 => return .{ .kind = .to_x, .d = d, .n = n, .mask = ~@as(u64, 0) }, // fmov xd, dn
        0x9eae_0000 => return .{ .kind = .to_x, .d = d, .n = n, .h = 1, .mask = ~@as(u64, 0) }, // fmov xd, vn.d[1]
        0x1e27_0000 => return .{ .kind = .from_x, .d = d, .n = n, .mask = 0xffff_ffff }, // fmov sd, wn
        0x9e67_0000 => return .{ .kind = .from_x, .d = d, .n = n, .mask = ~@as(u64, 0) }, // fmov dd, xn
        0x9eaf_0000 => return .{ .kind = .ins64, .d = d, .n = n, .h = 1 }, // fmov vd.d[1], xn
        else => {},
    }
    // MRS Xt, <reg> (L = 1, op0 = 3, op1 = 3)
    switch (raw & 0xffff_ffe0) {
        0xd53b_4400 => return .{ .kind = .mrs_fp, .d = d, .h = 0 }, // FPCR
        0xd53b_4420 => return .{ .kind = .mrs_fp, .d = d, .h = 1 }, // FPSR
        0xd53b_4200 => return .{ .kind = .mrs_nzcv, .d = d },
        0xd53b_00e0 => return .{ .kind = .mrs_k, .d = d, .k = branch.dczid },
        else => {},
    }
    // AdvSIMD modified immediate: MOVI, MVNI (not ORR/BIC, not FMOV half)
    if (raw & 0x9ff8_0c00 == 0x0f00_0400) {
        const q = raw & (1 << 30) != 0;
        const op = raw & (1 << 29) != 0;
        const cmode: u4 = @intCast(bits(raw, 15, 12));
        if (cmode & 1 == 1 and cmode < 12) return null; // ORR, BIC: read Vd
        const imm8: u8 = @intCast((bits(raw, 18, 16) << 5) | bits(raw, 9, 5));
        const imm = simd_move.expandImm(op, cmode, imm8, q) orelse return null;
        return .{ .kind = .movi, .d = d, .q = q, .k = if (op and cmode < 14) ~imm else imm };
    }
    // AdvSIMD three same, logical: AND, BIC, ORR, ORN, EOR (not BSL/BIT/BIF)
    if (raw & 0x9f20_fc00 == 0x0e20_1c00) {
        const op = (bits(raw, 29, 29) << 2) | bits(raw, 23, 22);
        if (op > 4) return null;
        return .{ .kind = .logic, .d = d, .n = n, .m = m, .q = raw & (1 << 30) != 0, .op = @intCast(op) };
    }
    // AdvSIMD copy: DUP (general), INS (general), UMOV
    if (raw & 0xbfe0_8400 == 0x0e00_0400) {
        const q = raw & (1 << 30) != 0;
        const imm5 = bits(raw, 20, 16);
        if (imm5 & 15 == 0) return null;
        const size: u6 = @intCast(@ctz(imm5));
        const index = imm5 >> @intCast(size + 1);
        const esize: u7 = @as(u7, 8) << @intCast(size);
        const mask: u64 = if (esize == 64) ~@as(u64, 0) else (@as(u64, 1) << @intCast(esize)) - 1;
        const bit = index * esize; // 0..127
        switch (bits(raw, 14, 11)) {
            0b0001 => { // DUP (general)
                if (size == 3 and !q) return null;
                return .{ .kind = .dup, .d = d, .n = n, .q = q, .mask = mask, .k = c.replicate(1, esize) };
            },
            0b0011 => { // INS (general): only whole 64-bit lanes
                if (!q or size != 3) return null;
                return .{ .kind = .ins64, .d = d, .n = n, .h = @intCast(bit >> 6) };
            },
            0b0111 => { // UMOV
                if ((q and size != 3) or (!q and size == 3)) return null;
                return .{ .kind = .to_x, .d = d, .n = n, .h = @intCast(bit >> 6), .shift = @intCast(bit & 63), .mask = mask };
            },
            else => return null,
        }
    }
    // FCMP, FCMPE (single, double; register or #0.0)
    if (raw & 0xffa0_fc07 == 0x1e20_2000) {
        return .{ .kind = .fcmp, .n = n, .m = m, .h = @intCast(bits(raw, 22, 22)), .zero = raw & 8 != 0 };
    }
    return null;
}

fn xs(r: u8) u8 {
    return if (r == 31) ops.zr else r;
}
fn vlo(r: u8) u8 {
    return ops.v0_slot + 2 * r;
}

pub fn usage(f: Fast) Use {
    return switch (f.kind) {
        .to_x => cm.rd(vlo(f.n)).with(cm.wr(xs(f.d))),
        .from_x => cm.rd(xs(f.n)).with(cm.wr(vlo(f.d))),
        .ins64 => cm.rd(xs(f.n)).with(cm.rd(vlo(f.d))).with(cm.wr(vlo(f.d))),
        .movi => cm.wr(vlo(f.d)),
        .logic => cm.rd(vlo(f.n)).with(cm.rd(vlo(f.m))).with(cm.wr(vlo(f.d))),
        .dup => cm.rd(xs(f.n)).with(cm.wr(vlo(f.d))),
        .mrs_fp, .mrs_k => cm.wr(xs(f.d)),
        .mrs_nzcv => cm.wr(xs(f.d)).with(.{ .flags_read = true }),
        .fcmp => cm.rd(vlo(f.n)).with(if (f.zero) .{} else cm.rd(vlo(f.m))).with(.{ .flags_write = true }),
    };
}

fn andMask(e: *Emit, m: u64) void {
    if (m == ~@as(u64, 0)) return;
    e.k64(m);
    e.op(W.i64_and);
}

/// Push FP operand r (single: its low 32 bits as f32; double: lo as f64).
fn fp(e: *Emit, r: u8, double: bool) void {
    cm.get(e, vlo(r));
    if (double) e.op(0xbf) else { // f64.reinterpret_i64
        e.op(W.i32_wrap);
        e.op(0xbe); // f32.reinterpret_i32
    }
}
fn fzero(e: *Emit, double: bool) void {
    if (double) e.kf(0.0) else {
        e.op(0x43); // f32.const 0
        e.ops(&.{ 0, 0, 0, 0 });
    }
}
/// Push the i32 "operand is a NaN".
fn isNan(e: *Emit, r: u8, double: bool) void {
    fp(e, r, double);
    fp(e, r, double);
    e.op(if (double) W.f64_ne else 0x5c); // f32.ne
}

const fpcr_off = cm.off(ops.nzcv_slot) + 4;

pub fn emit(e: *Emit, f: Fast, at: At) void {
    switch (f.kind) {
        .to_x => {
            cm.get(e, vlo(f.n) + f.h);
            if (f.shift != 0) {
                e.k64(f.shift);
                e.op(W.i64_shr_u);
            }
            andMask(e, f.mask);
            cm.set(e, xs(f.d));
        },
        .from_x => {
            cm.get(e, xs(f.n));
            andMask(e, f.mask);
            cm.set(e, vlo(f.d));
            e.k64(0);
            cm.set(e, vlo(f.d) + 1);
        },
        .ins64 => {
            cm.get(e, xs(f.n));
            cm.set(e, vlo(f.d) + f.h);
        },
        .movi => {
            e.k64(f.k);
            cm.set(e, vlo(f.d));
            e.k64(if (f.q) f.k else 0);
            cm.set(e, vlo(f.d) + 1);
        },
        .logic => {
            // The halves of n and m go through l_t first: d may be n or m.
            for (0..2) |h| {
                if (h == 1 and !f.q) {
                    e.k64(0);
                } else {
                    cm.get(e, vlo(f.n) + @as(u8, @intCast(h)));
                    cm.get(e, vlo(f.m) + @as(u8, @intCast(h)));
                    if (f.op == 1 or f.op == 3) {
                        e.k64(~@as(u64, 0));
                        e.op(W.i64_xor);
                    }
                    e.op(switch (f.op) {
                        0, 1 => W.i64_and,
                        2, 3 => W.i64_or,
                        else => W.i64_xor,
                    });
                }
                e.set(cm.l_t + @as(u32, @intCast(h)));
            }
            e.get(cm.l_t);
            cm.set(e, vlo(f.d));
            e.get(cm.l_t + 1);
            cm.set(e, vlo(f.d) + 1);
        },
        .dup => {
            cm.get(e, xs(f.n));
            andMask(e, f.mask);
            if (f.k != 1) {
                e.k64(f.k);
                e.op(W.i64_mul);
            }
            e.set(cm.l_t);
            e.get(cm.l_t);
            cm.set(e, vlo(f.d));
            if (f.q) e.get(cm.l_t) else e.k64(0);
            cm.set(e, vlo(f.d) + 1);
        },
        .mrs_fp => {
            e.get(jc.l_x);
            e.addr();
            e.mem(W.i64_load32_u, 2, fpcr_off + 4 * @as(u64, f.h));
            cm.set(e, xs(f.d));
        },
        .mrs_nzcv => {
            alu.nzcv(e);
            cm.set(e, xs(f.d));
        },
        .mrs_k => {
            e.k64(f.k);
            cm.set(e, xs(f.d));
        },
        .fcmp => {
            const dbl = f.h == 1;
            // NaN operands (FPSR.IOC, unordered) and FPCR.FZ (denormal
            // operands flushed, FPSR.IDC): the interpreter.
            isNan(e, f.n, dbl);
            if (!f.zero) {
                isNan(e, f.m, dbl);
                e.op(W.i32_or);
            }
            e.get(jc.l_x);
            e.addr();
            e.mem(W.i32_load, 2, fpcr_off);
            e.k32(24);
            e.op(W.i32_shr_u);
            e.k32(1);
            e.op(W.i32_and);
            e.op(W.i32_or);
            e.open(W.@"if", W.void_t);
            e.handBack(at.k, at.pc);
            e.close();
            // less: N; equal: Z C; greater: C
            e.k64(c.N);
            e.k64(c.Z | c.C);
            e.k64(c.C);
            fp(e, f.n, dbl);
            if (f.zero) fzero(e, dbl) else fp(e, f.m, dbl);
            e.op(if (dbl) W.f64_eq else W.f32_eq);
            e.op(W.select);
            fp(e, f.n, dbl);
            if (f.zero) fzero(e, dbl) else fp(e, f.m, dbl);
            e.op(if (dbl) W.f64_lt else W.f32_lt);
            e.op(W.select);
            e.set(cm.l_nzcv);
            alu.exactNow(e);
        },
    }
}
