// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, memory family (emit.zig; stream "memory"). Semantics:
//! opexec.zig (`ld`, `st`, `ld2`, `stN`, `ldrV`), field layout: ops.zig.
//! Every kind is translated.
//!
//! The rule riscv's JIT follows holds here: compute the address into
//! cm.l_va, check the data TLB inline (`e.tlbCheck`: tag == vpn of the
//! access's last byte, so a pair or a Q access checks its whole range
//! once), and on a miss hand the op back BEFORE it executes (no register,
//! no writeback, no store done): faults, page straddles (also an access
//! that wraps past 2^64), stores into pages holding decoded code
//! (code_flag), and an LDP/STP Q whose 32 bytes cross a page end all go
//! back to the interpreter, which keeps them exact. Past the check nothing
//! can fail, so the reference's order of register writes (writeback, then
//! Rt, then Rt2) matters only where registers coincide: a writeback whose
//! base is also a loaded register is dropped, Rt2 is written after Rt.
//! Store data is read before the writeback (STR Xn, [Xn], #8 stores the
//! old base). Q registers are two i64 locals (MVP wasm, no SIMD128; a64.md,
//! JIT). Guest data takes plain wasm loads and stores, also on a shared
//! memory, as the tier's fast path takes plain host accesses.

const std = @import("std");
const ops = @import("../ops.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const H = ops.H;
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const W = jc.W;

pub const kinds = [_]ops.H{
    .ldr8_i,  .ldr16_i, .ldr32_i, .ldr64_i, .ldr8_w,  .ldr16_w, .ldr32_w, .ldr64_w, .ldr8_r,  .ldr16_r,
    .ldr32_r, .ldr64_r, .str8_i,  .str16_i, .str32_i, .str64_i, .str8_w,  .str16_w, .str32_w, .str64_w,
    .str8_r,  .str16_r, .str32_r, .str64_r, .ldp32,   .ldp64,   .ldp32_w, .ldp64_w, .stp32,   .stp64,
    .stp32_w, .stp64_w, .ldr_v,   .ldr_q_i, .ldr_q_w, .ldr_q_r, .str_q_i, .str_q_w, .str_q_r, .ldp_q,
    .ldp_q_w, .stp_q,   .stp_q_w,
};

/// This family's part of the module's emission state (`e.x.mem`).
pub const Ext = struct {};

/// The host address of a pair or Q access (i64), kept for its other parts.
const l_host: u32 = cm.l_mem;

/// Bytes of one element of kind h (one register of a pair, a Q half: 8).
fn width(h: H) u64 {
    return switch (h) {
        .ldr8_i, .ldr8_w, .ldr8_r, .str8_i, .str8_w, .str8_r => 1,
        .ldr16_i, .ldr16_w, .ldr16_r, .str16_i, .str16_w, .str16_r => 2,
        .ldr32_i, .ldr32_w, .ldr32_r, .str32_i, .str32_w, .str32_r, .ldp32, .ldp32_w, .stp32, .stp32_w => 4,
        else => 8,
    };
}

pub fn supported(o: Op) bool {
    return switch (o.h) {
        // What the decoder makes: zero extension (d = 0) or sign extension
        // from the access width (d = 64 - width), a W mask by g (0 or 1).
        .ldr8_i, .ldr16_i, .ldr32_i, .ldr64_i, .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w, .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => (o.d == 0 or o.d == 64 - 8 * width(o.h)) and o.g <= 1,
        .ldp32, .ldp32_w => o.d == 0 or o.d == 32,
        .ldr_v => o.d <= 3 and o.e <= 2,
        else => true,
    };
}

/// Data slot of a store or load: an X/SP slot or a V slot.
fn data(slot: u8) Use {
    return .{ .read = cm.xbit(slot), .vread = cm.vbit(slot) };
}

pub fn usage(o: Op) Use {
    const base = cm.xbit(o.b);
    return switch (o.h) {
        .ldr8_i, .ldr16_i, .ldr32_i, .ldr64_i => .{ .read = base, .write = cm.xbit(o.a) },
        .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w => .{ .read = base, .write = base | cm.xbit(o.a) },
        .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => .{ .read = base | cm.xbit(o.c), .write = cm.xbit(o.a) },
        .str8_i, .str16_i, .str32_i, .str64_i => blk: {
            var u = data(o.a);
            u.read |= base;
            break :blk u;
        },
        .str8_w, .str16_w, .str32_w, .str64_w => blk: {
            var u = data(o.a);
            u.read |= base;
            u.write = base;
            break :blk u;
        },
        .str8_r, .str16_r, .str32_r, .str64_r => blk: {
            var u = data(o.a);
            u.read |= base | cm.xbit(o.c);
            break :blk u;
        },
        .ldp32, .ldp64 => .{ .read = base, .write = cm.xbit(o.a) | cm.xbit(o.c) },
        .ldp32_w, .ldp64_w => .{ .read = base, .write = base | cm.xbit(o.a) | cm.xbit(o.c) },
        .stp32, .stp64, .stp32_w, .stp64_w => blk: {
            var u = data(o.a);
            u.add(data(o.c));
            u.read |= base;
            if (o.h == .stp32_w or o.h == .stp64_w) u.write = base;
            break :blk u;
        },
        .ldr_v, .ldr_q_i, .ldr_q_r => .{ .read = base | (if (o.h == .ldr_q_r or (o.h == .ldr_v and o.e == 2)) cm.xbit(o.c) else 0), .write = if (o.h == .ldr_v and o.e == 1) base else 0, .vwrite = cm.vbit(o.a) },
        .ldr_q_w => .{ .read = base, .write = base, .vwrite = cm.vbit(o.a) },
        .str_q_i, .str_q_r => .{ .read = base | (if (o.h == .str_q_r) cm.xbit(o.c) else 0), .vread = cm.vbit(o.a) },
        .str_q_w => .{ .read = base, .write = base, .vread = cm.vbit(o.a) },
        .ldp_q => .{ .read = base, .vwrite = cm.vbit(o.a) | cm.vbit(o.c) },
        .ldp_q_w => .{ .read = base, .write = base, .vwrite = cm.vbit(o.a) | cm.vbit(o.c) },
        .stp_q => .{ .read = base, .vread = cm.vbit(o.a) | cm.vbit(o.c) },
        .stp_q_w => .{ .read = base, .write = base, .vread = cm.vbit(o.a) | cm.vbit(o.c) },
        else => unreachable,
    };
}

// ---- addresses ----------------------------------------------------------------

/// l_va = slot b + off (b = XZR: a literal's absolute address).
fn vaImm(e: *Emit, b: u8, off: u64) void {
    if (b == ops.zr) {
        e.k64(off);
    } else {
        cm.get(e, b);
        if (off != 0) {
            e.k64(off);
            e.op(W.i64_add);
        }
    }
    e.set(cm.l_va);
}

/// l_va = slot b + op2(slot c), op2(v) = ((v << s1) >>a s2) & mask.
fn vaReg(e: *Emit, b: u8, c: u8, s1: u8, s2: u8, mask: u64) void {
    cm.get(e, b);
    cm.get(e, c);
    if (s1 & 63 != 0) {
        e.k64(s1 & 63);
        e.op(W.i64_shl);
    }
    if (s2 & 63 != 0) {
        e.k64(s2 & 63);
        e.op(W.i64_shr_s);
    }
    if (mask != std.math.maxInt(u64)) {
        e.k64(mask);
        e.op(W.i64_and);
    }
    e.op(W.i64_add);
    e.set(cm.l_va);
}

/// Pre/post index: l_va = b + (pre ? imm : 0).
fn vaIndex(e: *Emit, o: Op, pre: u8) void {
    vaImm(e, o.b, if (pre != 0) o.imm else 0);
}

/// b += imm (after the access).
fn writeback(e: *Emit, o: Op) void {
    if (o.imm == 0) return;
    cm.get(e, o.b);
    e.k64(o.imm);
    e.op(W.i64_add);
    cm.set(e, o.b);
}

/// After `e.tlbCheck`: keep the host address in l_host as well (on a
/// memory32 kernel it is an i32 operand by now: widen it for the i64
/// local) and leave it on the stack.
fn keepHost(e: *Emit) void {
    if (e.mem32) e.op(W.i64_ext_u);
    e.tee(l_host);
    e.addr();
}
/// Push the kept host address as a memory operand.
fn host(e: *Emit) void {
    e.get(l_host);
    e.addr();
}

fn loadOp(size: u64, signed: bool) u8 {
    return switch (size) {
        1 => if (signed) W.i64_load8_s else W.i64_load8_u,
        2 => if (signed) W.i64_load16_s else W.i64_load16_u,
        4 => if (signed) W.i64_load32_s else W.i64_load32_u,
        else => W.i64_load,
    };
}
fn storeOp(size: u64) u8 {
    return switch (size) {
        1 => W.i64_store8,
        2 => W.i64_store16,
        4 => W.i64_store32,
        else => W.i64_store,
    };
}

// ---- emission -----------------------------------------------------------------

pub fn emit(e: *Emit, o: Op, at: At) void {
    const r_off = jc.tlb_r_off;
    const w_off = jc.tlb_w_off;
    const size = width(o.h);
    switch (o.h) {
        .ldr8_i, .ldr16_i, .ldr32_i, .ldr64_i, .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w, .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => {
            const wb = switch (o.h) {
                .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w => true,
                else => false,
            };
            switch (o.h) {
                .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => vaReg(e, o.b, o.c, o.e, o.f, o.imm),
                else => if (wb) vaIndex(e, o, o.f) else vaImm(e, o.b, o.imm),
            }
            e.tlbCheck(at.k, at.pc, r_off, size);
            const signed = o.d != 0;
            e.mem(loadOp(size, signed), 0, 0);
            if (signed and o.g & 1 != 0) {
                e.k64(0xffff_ffff);
                e.op(W.i64_and);
            }
            // Writeback, then Rt: with Rt == Rn the loaded value stays.
            if (wb and o.a != o.b) writeback(e, o);
            cm.set(e, o.a);
        },
        .str8_i, .str16_i, .str32_i, .str64_i, .str8_w, .str16_w, .str32_w, .str64_w, .str8_r, .str16_r, .str32_r, .str64_r => {
            const wb = switch (o.h) {
                .str8_w, .str16_w, .str32_w, .str64_w => true,
                else => false,
            };
            switch (o.h) {
                .str8_r, .str16_r, .str32_r, .str64_r => vaReg(e, o.b, o.c, o.e, o.f, o.imm),
                else => if (wb) vaIndex(e, o, o.f) else vaImm(e, o.b, o.imm),
            }
            e.tlbCheck(at.k, at.pc, w_off, size);
            cm.get(e, o.a);
            e.mem(storeOp(size), 0, 0);
            if (wb) writeback(e, o);
        },
        .ldp32, .ldp64, .ldp32_w, .ldp64_w => {
            const wb = o.h == .ldp32_w or o.h == .ldp64_w;
            if (wb) vaIndex(e, o, o.e) else vaImm(e, o.b, o.imm);
            e.tlbCheck(at.k, at.pc, r_off, 2 * size);
            keepHost(e);
            const signed = o.d != 0; // LDPSW
            e.mem(loadOp(size, signed), 0, 0);
            cm.set(e, o.a);
            host(e);
            e.mem(loadOp(size, signed), 0, size);
            cm.set(e, o.c); // after Rt: Rt2 wins when they are equal
            if (wb and o.b != o.a and o.b != o.c) writeback(e, o);
        },
        .stp32, .stp64, .stp32_w, .stp64_w => {
            const wb = o.h == .stp32_w or o.h == .stp64_w;
            if (wb) vaIndex(e, o, o.e) else vaImm(e, o.b, o.imm);
            e.tlbCheck(at.k, at.pc, w_off, 2 * size);
            keepHost(e);
            cm.get(e, o.a);
            e.mem(storeOp(size), 0, 0);
            host(e);
            cm.get(e, o.c);
            e.mem(storeOp(size), 0, size);
            if (wb) writeback(e, o);
        },
        .ldr_v => {
            const n: u64 = @as(u64, 1) << @intCast(o.d);
            switch (o.e) {
                0 => vaImm(e, o.b, o.imm),
                1 => vaIndex(e, o, o.f),
                else => vaReg(e, o.b, o.c, o.f, o.g, o.imm),
            }
            e.tlbCheck(at.k, at.pc, r_off, n);
            e.mem(loadOp(n, false), 0, 0);
            if (o.e == 1) writeback(e, o); // the base is an X register
            cm.set(e, o.a);
            e.k64(0);
            cm.set(e, o.a + 1);
        },
        .ldr_q_i, .ldr_q_w, .ldr_q_r => {
            switch (o.h) {
                .ldr_q_i => vaImm(e, o.b, o.imm),
                .ldr_q_w => vaIndex(e, o, o.f),
                else => vaReg(e, o.b, o.c, o.e, o.f, o.imm),
            }
            e.tlbCheck(at.k, at.pc, r_off, 16);
            keepHost(e);
            e.mem(W.i64_load, 0, 0);
            cm.set(e, o.a);
            host(e);
            e.mem(W.i64_load, 0, 8);
            cm.set(e, o.a + 1);
            if (o.h == .ldr_q_w) writeback(e, o);
        },
        .str_q_i, .str_q_w, .str_q_r => {
            switch (o.h) {
                .str_q_i => vaImm(e, o.b, o.imm),
                .str_q_w => vaIndex(e, o, o.f),
                else => vaReg(e, o.b, o.c, o.e, o.f, o.imm),
            }
            e.tlbCheck(at.k, at.pc, w_off, 16);
            keepHost(e);
            cm.get(e, o.a);
            e.mem(W.i64_store, 0, 0);
            host(e);
            cm.get(e, o.a + 1);
            e.mem(W.i64_store, 0, 8);
            if (o.h == .str_q_w) writeback(e, o);
        },
        .ldp_q, .ldp_q_w => {
            if (o.h == .ldp_q_w) vaIndex(e, o, o.e) else vaImm(e, o.b, o.imm);
            e.tlbCheck(at.k, at.pc, r_off, 32);
            keepHost(e);
            e.mem(W.i64_load, 0, 0);
            cm.set(e, o.a);
            // Rt's halves, then Rt2's: Rt2 wins when they are equal.
            const rest = [3]struct { u64, u8 }{ .{ 8, o.a + 1 }, .{ 16, o.c }, .{ 24, o.c + 1 } };
            for (rest) |p| {
                host(e);
                e.mem(W.i64_load, 0, p[0]);
                cm.set(e, p[1]);
            }
            if (o.h == .ldp_q_w) writeback(e, o);
        },
        .stp_q, .stp_q_w => {
            if (o.h == .stp_q_w) vaIndex(e, o, o.e) else vaImm(e, o.b, o.imm);
            e.tlbCheck(at.k, at.pc, w_off, 32);
            keepHost(e);
            cm.get(e, o.a);
            e.mem(W.i64_store, 0, 0);
            const rest = [3]struct { u64, u8 }{ .{ 8, o.a + 1 }, .{ 16, o.c }, .{ 24, o.c + 1 } };
            for (rest) |p| {
                host(e);
                cm.get(e, p[1]);
                e.mem(W.i64_store, 0, p[0]);
            }
            if (o.h == .stp_q_w) writeback(e, o);
        },
        else => unreachable,
    }
}

pub fn beginMember(e: *Emit, o: []const Op) void {
    _ = .{ e, o };
}

pub fn sync(e: *Emit) void {
    _ = e;
}

// ---- tests (kindtest.zig: one line per kind) ----------------------------------
//
// Each generator makes only its kind, in every variant the decoder gives it
// (sizes, extensions, W/X and B/H/S/D/Q data, every addressing mode), with
// a setup word or two before it (ADR for the base, MOVZ/MOVN for an index:
// `movi` ops, so the compiled prefix reaches the access). The base is
// chosen so the access lands where the generator wants: mostly inside the
// RW pages, else at a page end (straddling into the next RW page, which
// the interpreter performs and the JIT must hand back, or into the
// unmapped page), on the read-only page (stores fault), on the code page
// (stores fault, or with `rwx_code` hit decoded code), unmapped, or
// wrapping past 2^64. Rt is now and then the base or the index register
// (writeback with Rn == Rt, Rt == Rt2), store data XZR.

const kt = @import("kindtest.zig");

const Mode = enum { uimm, unscaled, unpriv, post, pre, regoff, literal, pair_off, pair_nt, pair_post, pair_pre };

/// One encoding of a kind: its fixed fields and how it addresses memory.
const Form = struct {
    /// The word without Rt, Rn, Rt2/Rm and the offset fields.
    word: u32,
    mode: Mode,
    /// log2 of the immediate scale (single: the access size, pairs: one
    /// register).
    scale: u5,
    /// Bytes accessed.
    n: u64,
    load: bool,
    v: bool,
};

fn one(comptime T: type, r: std.Random, xs: []const T) T {
    return xs[r.uintLessThan(usize, xs.len)];
}

/// A random encoding that decodes to kind h.
fn form(comptime h: H, r: std.Random) Form {
    const single = struct {
        fn f(size: u32, v: u32, opc: u32, m: Mode, load: bool) Form {
            const scale: u5 = if (v == 1 and opc >= 2) 4 else @intCast(size);
            const base: u32 = switch (m) {
                .uimm => 0x3900_0000,
                .unscaled => 0x3800_0000,
                .post => 0x3800_0400,
                .unpriv => 0x3800_0800,
                .pre => 0x3800_0c00,
                .regoff => 0x3820_0800,
                else => unreachable,
            };
            return .{ .word = base | (size << 30) | (v << 26) | (opc << 22), .mode = m, .scale = scale, .n = @as(u64, 1) << scale, .load = load, .v = v == 1 };
        }
        fn lit(opc: u32, v: u32, n: u64) Form {
            return .{ .word = 0x1800_0000 | (opc << 30) | (v << 26), .mode = .literal, .scale = 0, .n = n, .load = true, .v = v == 1 };
        }
        fn pair(opc: u32, v: u32, l: u32, m: Mode, scale: u5) Form {
            const idx: u32 = switch (m) {
                .pair_nt => 0,
                .pair_post => 1,
                .pair_off => 2,
                .pair_pre => 3,
                else => unreachable,
            };
            return .{ .word = 0x2800_0000 | (opc << 30) | (v << 26) | (idx << 23) | (l << 22), .mode = m, .scale = scale, .n = @as(u64, 2) << scale, .load = l == 1, .v = v == 1 };
        }
    };
    const S = single;
    const size: u32 = switch (width(h)) {
        1 => 0,
        2 => 1,
        4 => 2,
        else => 3,
    };
    // Integer load opc: 1 zero-extend, 2 sign-extend to X (not 64-bit), 3
    // sign-extend to W (8 and 16 bits).
    const ld_opc: []const u32 = switch (size) {
        0, 1 => &.{ 1, 2, 3 },
        2 => &.{ 1, 2 },
        else => &.{1},
    };
    return switch (h) {
        .ldr8_i, .ldr16_i, .ldr32_i, .ldr64_i => blk: {
            if (size >= 2 and r.uintLessThan(u32, 5) == 0) break :blk if (size == 2)
                (if (r.boolean()) S.lit(0, 0, 4) else S.lit(2, 0, 4)) // LDR W, LDRSW (literal)
            else
                S.lit(1, 0, 8);
            break :blk S.f(size, 0, one(u32, r, ld_opc), one(Mode, r, &.{ .uimm, .uimm, .unscaled, .unpriv }), true);
        },
        .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w => S.f(size, 0, one(u32, r, ld_opc), one(Mode, r, &.{ .post, .pre }), true),
        .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => S.f(size, 0, one(u32, r, ld_opc), .regoff, true),
        // Stores: integer, or STR B/H/S/D (V = 1, opc 0).
        .str8_i, .str16_i, .str32_i, .str64_i => blk: {
            // STTR exists for integer data only (V = 1 there is generic).
            const v = r.uintLessThan(u32, 2);
            break :blk S.f(size, v, 0, if (v == 1) one(Mode, r, &.{ .uimm, .unscaled }) else one(Mode, r, &.{ .uimm, .uimm, .unscaled, .unpriv }), false);
        },
        .str8_w, .str16_w, .str32_w, .str64_w => S.f(size, r.uintLessThan(u32, 2), 0, one(Mode, r, &.{ .post, .pre }), false),
        .str8_r, .str16_r, .str32_r, .str64_r => S.f(size, r.uintLessThan(u32, 2), 0, .regoff, false),
        .ldp32 => if (r.boolean()) S.pair(1, 0, 1, .pair_off, 2) else S.pair(0, 0, 1, one(Mode, r, &.{ .pair_off, .pair_nt }), 2),
        .ldp32_w => S.pair(r.uintLessThan(u32, 2), 0, 1, one(Mode, r, &.{ .pair_post, .pair_pre }), 2),
        .ldp64 => S.pair(2, 0, 1, one(Mode, r, &.{ .pair_off, .pair_nt }), 3),
        .ldp64_w => S.pair(2, 0, 1, one(Mode, r, &.{ .pair_post, .pair_pre }), 3),
        // STP W / S (opc 0), X / D (opc 2 / V opc 1).
        .stp32 => S.pair(0, r.uintLessThan(u32, 2), 0, one(Mode, r, &.{ .pair_off, .pair_nt }), 2),
        .stp32_w => S.pair(0, r.uintLessThan(u32, 2), 0, one(Mode, r, &.{ .pair_post, .pair_pre }), 2),
        .stp64, .stp64_w => blk: {
            const v = r.uintLessThan(u32, 2);
            const m: Mode = if (h == .stp64) one(Mode, r, &.{ .pair_off, .pair_nt }) else one(Mode, r, &.{ .pair_post, .pair_pre });
            break :blk S.pair(if (v == 1) 1 else 2, v, 0, m, 3);
        },
        .ldr_v => blk: {
            if (r.uintLessThan(u32, 6) == 0) break :blk if (r.boolean()) S.lit(0, 1, 4) else S.lit(1, 1, 8);
            break :blk S.f(r.uintLessThan(u32, 4), 1, 1, one(Mode, r, &.{ .uimm, .unscaled, .post, .pre, .regoff }), true);
        },
        .ldr_q_i => if (r.uintLessThan(u32, 5) == 0) S.lit(2, 1, 16) else S.f(0, 1, 3, one(Mode, r, &.{ .uimm, .unscaled }), true),
        .ldr_q_w => S.f(0, 1, 3, one(Mode, r, &.{ .post, .pre }), true),
        .ldr_q_r => S.f(0, 1, 3, .regoff, true),
        .str_q_i => S.f(0, 1, 2, one(Mode, r, &.{ .uimm, .unscaled }), false),
        .str_q_w => S.f(0, 1, 2, one(Mode, r, &.{ .post, .pre }), false),
        .str_q_r => S.f(0, 1, 2, .regoff, false),
        .ldp_q => S.pair(2, 1, 1, one(Mode, r, &.{ .pair_off, .pair_nt }), 4),
        .ldp_q_w => S.pair(2, 1, 1, one(Mode, r, &.{ .pair_post, .pair_pre }), 4),
        .stp_q => S.pair(2, 1, 0, one(Mode, r, &.{ .pair_off, .pair_nt }), 4),
        .stp_q_w => S.pair(2, 1, 0, one(Mode, r, &.{ .pair_post, .pair_pre }), 4),
        else => comptime unreachable,
    };
}

/// Where an access of n bytes should land (see above).
fn target(r: std.Random, n: u64) u64 {
    const page = r.uintLessThan(u64, 4);
    const cut = if (n > 1) r.intRangeAtMost(u64, 1, n - 1) else 0;
    return switch (r.uintLessThan(u32, 100)) {
        0...57 => kt.data_va + page * 4096 + r.uintLessThan(u64, 4096 - n + 1),
        58...63 => kt.data_va + page * 4096 + (if (r.boolean()) 4096 - n else 0), // a page's last or first bytes
        64...71 => kt.data_va + r.uintLessThan(u64, 3) * 4096 + 4096 - cut, // straddles two RW pages
        72...74 => kt.lazy_va - cut, // straddles into the unmapped page
        75...80 => kt.ro_va + r.uintLessThan(u64, 4096 - n + 1),
        81...82 => kt.ro_va + 4096 - cut, // straddles out of the read-only page
        83...89 => kt.code_va + r.uintLessThan(u64, 2 * 4096 - n + 1),
        90...92 => kt.lazy_va + r.uintLessThan(u64, 4096),
        93...96 => 0 -% (if (r.boolean()) cut else r.uintLessThan(u64, 64)), // wraps past 2^64
        else => r.uintLessThan(u64, 4096), // page 0
    };
}

/// ADR xd, t (t within 1 MiB of pc).
fn adr(rd: u32, pc: u64, t: u64) ?u32 {
    const d: i64 = @bitCast(t -% pc);
    if (d < -(1 << 20) or d >= 1 << 20) return null;
    const u: u32 = @truncate(@as(u64, @bitCast(d)));
    return 0x1000_0000 | ((u & 3) << 29) | (((u >> 2) & 0x7ffff) << 5) | rd;
}

fn sext(v: u64, comptime bits: u7) u64 {
    const s: u6 = @intCast(64 - bits);
    return @bitCast(@as(i64, @bitCast(v << s)) >> s);
}

/// After the n words at out (from pc0), now and then B code_va: the block
/// (from code_va) becomes a compiled self-loop, whose later passes find the
/// data TLB filled by the first one (a program's first access to a page
/// always misses and hands back). Returns the word count.
fn closeLoop(r: std.Random, out: []u32, pc0: u64, n: usize) usize {
    if (r.uintLessThan(u32, 8) != 0) return n;
    out[n] = 0x1400_0000 | (@as(u32, @truncate((kt.code_va -% (pc0 + 4 * n)) >> 2)) & 0x3ff_ffff);
    return n + 1;
}

/// The generator of kind h's test.
fn gen(comptime h: H) kt.Gen {
    return struct {
        fn g(r: std.Random, out: []u32, pc0: u64) usize {
            const f = form(h, r);
            var i: usize = 0;
            const t = target(r, f.n);
            // Registers: B the base (set by ADR), I an index (MOVZ/MOVN).
            const b_reg = kt.dst(r);
            var i_reg = kt.dst(r);
            while (i_reg == b_reg) i_reg = kt.dst(r);
            // Rt, Rt2: X loads never 31 (a load into XZR is generic).
            const pick = struct {
                fn rt(rr: std.Random, ff: Form, bb: u32, ii: u32) u32 {
                    return switch (rr.uintLessThan(u32, 10)) {
                        0 => bb,
                        1 => if (ff.mode == .regoff) ii else bb,
                        2 => if (ff.load and !ff.v) kt.dst(rr) else 31,
                        else => if (ff.v) rr.uintLessThan(u32, 32) else kt.dst(rr),
                    };
                }
            }.rt;
            const rt = pick(r, f, b_reg, i_reg);
            var w = f.word | rt;
            // Offset: the access is at base + off (post-index: at base).
            var off: u64 = 0;
            var use_reg_base = true;
            switch (f.mode) {
                .literal => {
                    const d: i64 = @bitCast((t & ~@as(u64, 3)) -% pc0);
                    // Out of reach: offset 0, the literal is the word itself.
                    if (d >= -(1 << 20) and d < 1 << 20) w |= (@as(u32, @truncate(@as(u64, @bitCast(d)) >> 2)) & 0x7ffff) << 5;
                    out[0] = w;
                    return closeLoop(r, out, pc0, 1);
                },
                .uimm => {
                    const imm = if (r.boolean()) r.uintLessThan(u32, 64) else r.uintLessThan(u32, 4096);
                    off = @as(u64, imm) << f.scale;
                    w |= imm << 10;
                },
                .unscaled, .unpriv, .pre, .post => {
                    const imm = r.intRangeAtMost(i32, -256, 255);
                    w |= (@as(u32, @bitCast(imm)) & 0x1ff) << 12;
                    if (f.mode != .post) off = @bitCast(@as(i64, imm));
                },
                .pair_off, .pair_nt, .pair_pre, .pair_post => {
                    const imm = r.intRangeAtMost(i32, -64, 63);
                    // Rt2: like Rt, sometimes equal to it.
                    const rt2 = if (r.uintLessThan(u32, 6) == 0) rt else pick(r, f, b_reg, i_reg);
                    w |= ((@as(u32, @bitCast(imm)) & 0x7f) << 15) | (rt2 << 10);
                    if (f.mode != .pair_post) off = @as(u64, @bitCast(@as(i64, imm))) << f.scale;
                },
                .regoff => {
                    const option = one(u32, r, &.{ 2, 3, 6, 7 }); // UXTW, LSL, SXTW, SXTX
                    const s = r.uintLessThan(u32, 2);
                    const xzr_index = r.uintLessThan(u32, 10) == 0;
                    var v: u64 = 0;
                    if (!xzr_index) {
                        const k = r.uintLessThan(u32, 300);
                        const neg = option != 2 and r.boolean() or r.uintLessThan(u32, 20) == 0;
                        const wide = r.uintLessThan(u32, 4) != 0; // else a W MOVN: 0x0000_0000_ffff_xxxx
                        out[i] = if (neg)
                            (if (wide) @as(u32, 0x9280_0000) else 0x1280_0000) | (k << 5) | i_reg // movn
                        else
                            0xd280_0000 | (k << 5) | i_reg; // movz
                        v = if (!neg) k else if (wide) ~@as(u64, k) else ~@as(u64, k) & 0xffff_ffff;
                        i += 1;
                    }
                    const shift: u6 = if (s == 1) f.scale else 0;
                    off = switch (option) {
                        2 => (v & 0xffff_ffff) << shift,
                        6 => sext(v, 32) << shift,
                        else => v << shift,
                    };
                    w |= ((if (xzr_index) 31 else i_reg) << 16) | (option << 13) | (s << 12);
                },
            }
            // The base: ADR to t - off, or (now and then, and when that is
            // out of reach) one of the fixed bases with this offset.
            if (r.uintLessThan(u32, 7) != 0) {
                if (adr(b_reg, pc0 + 4 * i, t -% off)) |a| {
                    out[i] = a;
                    i += 1;
                } else use_reg_base = false;
            } else use_reg_base = false;
            const rn = if (use_reg_base) b_reg else kt.base(r);
            out[i] = w | (rn << 5);
            return closeLoop(r, out, pc0, i + 1);
        }
    }.g;
}

// Loops end at the budget (or a fault). Half the programs start with
// filled data TLBs, so that also a first access runs compiled (a page end
// straddle into an unmapped page must still hand back).
const mem_opt: kt.Opt = .{ .rounds = 200, .budget = 3000 };
const warm_opt: kt.Opt = .{ .rounds = 200, .budget = 3000, .warm_tlb = true, .seed = 3 };

fn both(comptime h: H) !void {
    try kt.kind(h, gen(h), mem_opt);
    try kt.kind(h, gen(h), warm_opt);
}

test "a64 jit mem: ldr8_i" {
    try both(.ldr8_i);
}
test "a64 jit mem: ldr16_i" {
    try both(.ldr16_i);
}
test "a64 jit mem: ldr32_i" {
    try both(.ldr32_i);
}
test "a64 jit mem: ldr64_i" {
    try both(.ldr64_i);
}
test "a64 jit mem: ldr8_w" {
    try both(.ldr8_w);
}
test "a64 jit mem: ldr16_w" {
    try both(.ldr16_w);
}
test "a64 jit mem: ldr32_w" {
    try both(.ldr32_w);
}
test "a64 jit mem: ldr64_w" {
    try both(.ldr64_w);
}
test "a64 jit mem: ldr8_r" {
    try both(.ldr8_r);
}
test "a64 jit mem: ldr16_r" {
    try both(.ldr16_r);
}
test "a64 jit mem: ldr32_r" {
    try both(.ldr32_r);
}
test "a64 jit mem: ldr64_r" {
    try both(.ldr64_r);
}
test "a64 jit mem: str8_i" {
    try both(.str8_i);
}
test "a64 jit mem: str16_i" {
    try both(.str16_i);
}
test "a64 jit mem: str32_i" {
    try both(.str32_i);
}
test "a64 jit mem: str64_i" {
    try both(.str64_i);
}
test "a64 jit mem: str8_w" {
    try both(.str8_w);
}
test "a64 jit mem: str16_w" {
    try both(.str16_w);
}
test "a64 jit mem: str32_w" {
    try both(.str32_w);
}
test "a64 jit mem: str64_w" {
    try both(.str64_w);
}
test "a64 jit mem: str8_r" {
    try both(.str8_r);
}
test "a64 jit mem: str16_r" {
    try both(.str16_r);
}
test "a64 jit mem: str32_r" {
    try both(.str32_r);
}
test "a64 jit mem: str64_r" {
    try both(.str64_r);
}
test "a64 jit mem: ldp32" {
    try both(.ldp32);
}
test "a64 jit mem: ldp64" {
    try both(.ldp64);
}
test "a64 jit mem: ldp32_w" {
    try both(.ldp32_w);
}
test "a64 jit mem: ldp64_w" {
    try both(.ldp64_w);
}
test "a64 jit mem: stp32" {
    try both(.stp32);
}
test "a64 jit mem: stp64" {
    try both(.stp64);
}
test "a64 jit mem: stp32_w" {
    try both(.stp32_w);
}
test "a64 jit mem: stp64_w" {
    try both(.stp64_w);
}
test "a64 jit mem: ldr_v" {
    try both(.ldr_v);
}
test "a64 jit mem: ldr_q_i" {
    try both(.ldr_q_i);
}
test "a64 jit mem: ldr_q_w" {
    try both(.ldr_q_w);
}
test "a64 jit mem: ldr_q_r" {
    try both(.ldr_q_r);
}
test "a64 jit mem: str_q_i" {
    try both(.str_q_i);
}
test "a64 jit mem: str_q_w" {
    try both(.str_q_w);
}
test "a64 jit mem: str_q_r" {
    try both(.str_q_r);
}
test "a64 jit mem: ldp_q" {
    try both(.ldp_q);
}
test "a64 jit mem: ldp_q_w" {
    try both(.ldp_q_w);
}
test "a64 jit mem: stp_q" {
    try both(.stp_q);
}
test "a64 jit mem: stp_q_w" {
    try both(.stp_q_w);
}

// Stores into the code pages, mapped writable: a store into the decoded
// block (or the page it is on) hands back, and the interpreter's store ends
// the block (SMC); the next instruction is the stored word.
const smc_opt: kt.Opt = .{ .rounds = 300, .budget = 3000, .rwx_code = true, .warm_tlb = true, .seed = 2 };

test "a64 jit mem: str32_i into decoded code" {
    try kt.kind(.str32_i, gen(.str32_i), smc_opt);
}
test "a64 jit mem: str64_r into decoded code" {
    try kt.kind(.str64_r, gen(.str64_r), smc_opt);
}
test "a64 jit mem: stp64_w into decoded code" {
    try kt.kind(.stp64_w, gen(.stp64_w), smc_opt);
}
test "a64 jit mem: stp_q into decoded code" {
    try kt.kind(.stp_q, gen(.stp_q), smc_opt);
}
