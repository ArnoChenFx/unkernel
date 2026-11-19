// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Loads and stores (op0 = x1x0) except the AdvSIMD structure forms
//! (simd_ldst.zig).
//!
//! Implemented: load register (literal) incl. LDRSW and PRFM; load/store
//! pair (STP, LDP, LDPSW, STNP, LDNP; offset, pre- and post-indexed; W, X,
//! S, D, Q); load/store register (unsigned offset, unscaled LDUR/STUR,
//! pre- and post-indexed, register offset with extend/shift, unprivileged
//! LDTR/STTR, which at EL0 are plain accesses), all sizes and sign
//! extensions, B/H/S/D/Q registers, PRFM/PRFUM (no effect).
//!
//! Load/store exclusive and ordered (LDXR, STXR, LDAXR, STLXR, LDXP, STXP,
//! LDAXP, STLXP, LDAR, STLR and the B/H forms) are excl.zig. Not in
//! ARMv8.0 (stay ILLEGAL): LSE (CAS*, LDADD and other atomics, SWP),
//! LDAPR/RCpc, MTE tag loads/stores, LDRAA/LDRAB, LDLAR/STLLR.

const std = @import("std");
const c = @import("common.zig");
const excl = @import("excl.zig");

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    if (inst & 0x3f00_0000 == 0x0800_0000) return exclusive(s, inst);
    if (inst & 0x3b00_0000 == 0x1800_0000) return literal(s, inst);
    if (inst & 0x3800_0000 == 0x2800_0000) return pair(s, inst);
    if (inst & 0x3800_0000 == 0x3800_0000) return single(s, inst);
    return c.ill(s, inst);
}

/// Load/store exclusive, load-acquire/store-release (size 001000 o2 L o1 Rs o0 Rt2 Rn Rt).
fn exclusive(s: c.St, inst: u32) c.Error!c.Exit {
    return excl.exec(s, inst);
}

// ---- access helpers ------------------------------------------------------------

/// Load 1 << size bytes (size 0..3), zero-extended.
pub fn loadN(s: c.St, size: u2, va: u64) c.Error!u64 {
    return switch (size) {
        0 => try c.load(s, u8, va),
        1 => try c.load(s, u16, va),
        2 => try c.load(s, u32, va),
        3 => try c.load(s, u64, va),
    };
}
/// Store the low 1 << size bytes of v (size 0..3).
pub fn storeN(s: c.St, size: u2, va: u64, v: u64) c.Error!void {
    switch (size) {
        0 => try c.store(s, u8, va, @truncate(v)),
        1 => try c.store(s, u16, va, @truncate(v)),
        2 => try c.store(s, u32, va, @truncate(v)),
        3 => try c.store(s, u64, va, v),
    }
}
/// Load a SIMD/FP register's worth of 1 << scale bytes (scale 0..4).
pub fn loadV(s: c.St, scale: u3, va: u64) c.Error!u128 {
    if (scale == 4) return c.load128(s, va);
    return try loadN(s, @intCast(scale), va);
}
/// Store the low 1 << scale bytes of a SIMD/FP register (scale 0..4).
pub fn storeV(s: c.St, scale: u3, va: u64, v: u128) c.Error!void {
    if (scale == 4) return c.store128(s, va, v);
    return storeN(s, @intCast(scale), va, @truncate(v));
}

// ---- literal -------------------------------------------------------------------

fn literal(s: c.St, inst: u32) c.Error!c.Exit {
    const va = s.r.pc +% c.sextN(@as(u64, c.bits(inst, 23, 5)) << 2, 21);
    const t = c.rd(inst);
    const opc = c.bits(inst, 31, 30);
    if (c.bit(inst, 26)) {
        if (opc == 3) return c.ill(s, inst);
        const scale: u3 = @intCast(opc + 2);
        c.setVq(s, t, try loadV(s, scale, va));
        return .next;
    }
    switch (opc) {
        0 => c.setX(s, t, try c.load(s, u32, va)),
        1 => c.setX(s, t, try c.load(s, u64, va)),
        2 => c.setX(s, t, c.sext(try c.load(s, u32, va), 32)), // LDRSW
        3 => {}, // PRFM (literal)
        else => unreachable,
    }
    return .next;
}

// ---- pairs ---------------------------------------------------------------------

fn pair(s: c.St, inst: u32) c.Error!c.Exit {
    const idx = c.bits(inst, 25, 23); // 0 no-allocate, 1 post, 2 offset, 3 pre
    if (idx > 3) return c.ill(s, inst);
    const opc = c.bits(inst, 31, 30);
    const simd = c.bit(inst, 26);
    const load = c.bit(inst, 22);
    if (opc == 3) return c.ill(s, inst);
    const scale: u3 = if (simd) @intCast(2 + opc) else if (opc == 2) 3 else 2;
    const signed = !simd and opc == 1;
    if (signed and (!load or idx == 0)) return c.ill(s, inst); // STGP (MTE), unallocated
    const off = c.sextN(c.bits(inst, 21, 15), 7) << scale;
    const n = c.rn(inst);
    const base = c.xsp(s, n);
    const va = if (idx == 1) base else base +% off;
    const size = @as(u64, 1) << scale;
    const t = c.rd(inst);
    const t2 = c.rt2(inst);
    if (load) {
        if (simd) {
            const v1 = try loadV(s, scale, va);
            const v2 = try loadV(s, scale, va +% size);
            writeback(s, idx, n, base, off);
            c.setVq(s, t, v1);
            c.setVq(s, t2, v2);
        } else {
            var v1 = try loadN(s, @intCast(scale), va);
            var v2 = try loadN(s, @intCast(scale), va +% size);
            if (signed) {
                v1 = c.sext(v1, 32);
                v2 = c.sext(v2, 32);
            }
            writeback(s, idx, n, base, off);
            c.setX(s, t, v1);
            c.setX(s, t2, v2);
        }
    } else {
        try c.probeWrite(s, va, 2 * size);
        if (simd) {
            try storeV(s, scale, va, c.vq(s, t));
            try storeV(s, scale, va +% size, c.vq(s, t2));
        } else {
            try storeN(s, @intCast(scale), va, c.xr(s, t));
            try storeN(s, @intCast(scale), va +% size, c.xr(s, t2));
        }
        writeback(s, idx, n, base, off);
    }
    return .next;
}

/// Pre-/post-index writeback of base + off into Rn (SP for 31).
inline fn writeback(s: c.St, idx: u32, n: u32, base: u64, off: u64) void {
    if (idx == 1 or idx == 3) c.setXsp(s, n, base +% off);
}

// ---- single register -----------------------------------------------------------

const Mode = enum { uimm, unscaled, post, unpriv, pre, regoff };

fn single(s: c.St, inst: u32) c.Error!c.Exit {
    const mode: Mode = if (c.bit(inst, 24)) .uimm else if (!c.bit(inst, 21)) switch (c.bits(inst, 11, 10)) {
        0 => .unscaled,
        1 => .post,
        2 => .unpriv,
        3 => .pre,
        else => unreachable,
    } else if (c.bits(inst, 11, 10) == 2) .regoff else return c.ill(s, inst); // LSE atomics, LDRAA/LDRAB
    if (c.bit(inst, 25)) return c.ill(s, inst);
    const size = c.bits(inst, 31, 30);
    const opc = c.bits(inst, 23, 22);
    const simd = c.bit(inst, 26);
    // Access: scale (log2 bytes), and for integer loads the extension.
    const Kind = enum { store, zext, sext64, sext32, prfm };
    var scale: u3 = @intCast(size);
    var kind: Kind = undefined;
    if (simd) {
        if (opc >= 2) {
            if (size != 0) return c.ill(s, inst);
            scale = 4;
        }
        if (mode == .unpriv) return c.ill(s, inst);
        kind = if (opc & 1 == 0) .store else .zext;
    } else kind = switch (opc) {
        0 => .store,
        1 => .zext,
        2 => if (size == 3) .prfm else .sext64,
        3 => if (size <= 1) .sext32 else return c.ill(s, inst),
        else => unreachable,
    };
    if (kind == .prfm and (mode == .post or mode == .pre or mode == .unpriv)) return c.ill(s, inst);
    const n = c.rn(inst);
    const base = c.xsp(s, n);
    var off: u64 = 0;
    switch (mode) {
        .uimm => off = @as(u64, c.bits(inst, 21, 10)) << scale,
        .regoff => {
            const option: u3 = @intCast(c.bits(inst, 15, 13));
            if (option & 2 == 0) return c.ill(s, inst);
            off = c.extendReg(c.xr(s, c.rm(inst)), option, if (c.bit(inst, 12)) scale else 0);
        },
        else => off = c.sextN(c.bits(inst, 20, 12), 9),
    }
    const va = if (mode == .post) base else base +% off;
    const wb = mode == .pre or mode == .post;
    const t = c.rd(inst);
    switch (kind) {
        .prfm => {},
        .store => {
            if (simd) try storeV(s, scale, va, c.vq(s, t)) else try storeN(s, @intCast(scale), va, c.xr(s, t));
            if (wb) c.setXsp(s, n, base +% off);
        },
        else => {
            if (simd) {
                const v = try loadV(s, scale, va);
                if (wb) c.setXsp(s, n, base +% off);
                c.setVq(s, t, v);
            } else {
                const raw = try loadN(s, @intCast(scale), va);
                const bitsz: u7 = @as(u7, 8) << scale;
                const v = switch (kind) {
                    .zext => raw,
                    .sext64 => c.sextN(raw, bitsz),
                    .sext32 => c.sextN(raw, bitsz) & 0xffff_ffff,
                    else => unreachable,
                };
                if (wb) c.setXsp(s, n, base +% off);
                c.setX(s, t, v);
            }
        },
    }
    return .next;
}
