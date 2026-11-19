// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! LSE atomics (FEAT_LSE, ARMv8.1, `KW_ISA_LSE`): CAS, CASP, SWP and the
//! atomic memory operations LDADD, LDCLR, LDEOR, LDSET, LDSMAX, LDSMIN,
//! LDUMAX, LDUMIN (ST<op> is LD<op> with Rt = XZR), every size and every
//! acquire/release variant. ldst.zig routes the atomic memory operations
//! (`size 111 0 00 A R 1 Rs o3 opc 00 Rn Rt`) here, excl.zig the compare
//! and swaps (`size 001000 1 L 1 Rs o0 11111 Rn Rt`, CASP: `0 sz 001000 0 L
//! 1 Rs o0 11111 Rn Rt`).
//!
//! ILLEGAL: everything while `.lse` is off; the rest of the atomic memory
//! operation space (V = 1, FEAT_LSFE; o3 = 1 with opc != 000: LDAPR
//! (FEAT_LRCPC), ST64B/LD64B, the RCW forms); CAS and CASP with Rt2 (the
//! should-be-one field) != 11111, CASP with an odd Rs or Rt (UNDEFINED in
//! the Arm ARM).
//!
//! Rules (Arm ARM, C3.2.12 and the instruction pages):
//!  - The address must be aligned to the access size (CASP: to the whole
//!    pair), else KW_EV_MISALIGNED: kwemu has no FEAT_LSE2
//!    (ID_AA64MMFR2_EL1.AT = 0). qemu's `max` cpu has LSE2 and accepts
//!    unaligned accesses inside 16 bytes.
//!  - Every form needs write permission, also a CAS whose compare fails and
//!    an LD<op> whose result is discarded: they are read-modify-writes for
//!    the MMU, as on hardware and in qemu-user (a CAS on a read-only page is
//!    a write fault, SIGSEGV). A fault (alignment or page) has no effect:
//!    the host pointer is obtained before anything is read or written, and
//!    registers are written last.
//!  - Results: LD<op>/SWP write the old value, zero-extended, to Rt; CAS
//!    writes it to Rs (also when the compare passed), CASP to Rs and Rs+1.
//!    The memory operand comes from Rs (CAS: Rs is the compare value, Rt
//!    the new one), read before anything is written, so Rs == Rt works.
//!  - Ordering: one CPU needs none; with -Dkwemu-atomics (`c.smp`) every
//!    access is a seq_cst wasm atomic, which covers A, L and AL.
//!  - The exclusive monitor: an LSE store is a store like any other. On
//!    one CPU it does not close this CPU's monitor (as plain stores do not;
//!    IMPLEMENTATION DEFINED); on SMP an STXR is a compare-and-swap against
//!    the value its LDXR read, so it fails when an LSE atomic of any CPU
//!    changed the location in between (modulo ABA), as in qemu.
//!
//! Atomicity: one CPU: an instruction is atomic by construction (kw_run
//! never stops inside one). SMP: 1, 2, 4 and 8-byte operations are single
//! wasm atomics (`rmwShared`, `casShared`; min and max are compare-and-swap
//! loops, wasm has no atomic min/max), a W pair CASP is one 8-byte
//! compare-and-swap, and an X pair CASP takes excl.zig's `pair_lock`
//! (`casPair128Shared`), the lock every 128-bit STXP takes: all 128-bit
//! writers are serialised, and each one compares both halves inside the
//! lock. Not covered, as for STXP: a racing plain or 64-bit store (or
//! 64-bit atomic) to one half of a pair while a 128-bit CASP runs.

const std = @import("std");
const c = @import("common.zig");
const excl = @import("excl.zig");

/// The operation of an atomic memory instruction (opc, then SWP).
pub const Op = enum(u4) { add = 0, clr = 1, eor = 2, set = 3, smax = 4, smin = 5, umax = 6, umin = 7, swp = 8 };

// ---- decode -------------------------------------------------------------------

/// Atomic memory operations: size 111 V 00 A R 1 Rs o3 opc 00 Rn Rt
/// (ldst.zig routes bit 24 = 0, bit 21 = 1, bits 11..10 = 00 here).
pub fn atomicOp(s: c.St, inst: u32) c.Error!c.Exit {
    if (!c.has(s, .lse) or c.bit(inst, 26) or c.bit(inst, 25)) return c.ill(s, inst);
    const opc = c.bits(inst, 14, 12);
    const op: Op = if (!c.bit(inst, 15)) @enumFromInt(opc) else if (opc == 0) .swp else return c.ill(s, inst);
    return ldOp(s, @intCast(c.bits(inst, 31, 30)), op, c.rm(inst), c.rn(inst), c.rd(inst));
}

/// CAS (o2 = 1, o1 = 1) and CASP (o2 = 0, o1 = 1, size 0x) of the exclusive
/// class `size 001000 o2 L o1 Rs o0 Rt2 Rn Rt` (excl.zig routes them here).
pub fn compareSwap(s: c.St, inst: u32) c.Error!c.Exit {
    if (!c.has(s, .lse) or c.rt2(inst) != 31) return c.ill(s, inst);
    const size: u2 = @intCast(c.bits(inst, 31, 30));
    const rs = c.rm(inst);
    const t = c.rd(inst);
    const n = c.rn(inst);
    if (c.bit(inst, 23)) return cas(s, size, rs, n, t);
    if (size >= 2 or rs & 1 != 0 or t & 1 != 0) return c.ill(s, inst); // excl.zig took size 1x
    return casp(s, size == 1, rs, n, t);
}

// ---- semantics (decoded operands) ---------------------------------------------

/// LD<op>/SWP: Rt = the old 1 << size bytes at [Xn|SP] (zero-extended),
/// memory = op(old, Rs).
pub fn ldOp(s: c.St, size: u2, op: Op, rs: u32, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    if (!c.checkAlign(s, va, @as(u64, 1) << size)) return .trap;
    const v = c.xr(s, rs);
    const old: u64 = switch (size) {
        0 => try rmw(s, u8, va, op, @truncate(v)),
        1 => try rmw(s, u16, va, op, @truncate(v)),
        2 => try rmw(s, u32, va, op, @truncate(v)),
        3 => try rmw(s, u64, va, op, v),
    };
    c.setX(s, t, old);
    return .next;
}

/// CAS: if the 1 << size bytes at [Xn|SP] equal Rs, store Rt there; Rs =
/// the old value (zero-extended) either way.
pub fn cas(s: c.St, size: u2, rs: u32, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    if (!c.checkAlign(s, va, @as(u64, 1) << size)) return .trap;
    const cmp = c.xr(s, rs);
    const new = c.xr(s, t);
    const old: u64 = switch (size) {
        0 => try casMem(s, u8, va, @truncate(cmp), @truncate(new)),
        1 => try casMem(s, u16, va, @truncate(cmp), @truncate(new)),
        2 => try casMem(s, u32, va, @truncate(cmp), @truncate(new)),
        3 => try casMem(s, u64, va, cmp, new),
    };
    c.setX(s, rs, old);
    return .next;
}

/// CASP: two W (x = false) or X registers: if memory holds Rs:Rs+1 (Rs at
/// the lower address), store Rt:Rt+1; Rs, Rs+1 = what memory held.
pub fn casp(s: c.St, x: bool, rs: u32, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    if (!c.checkAlign(s, va, if (x) 16 else 8)) return .trap;
    const s1 = c.xr(s, rs);
    const s2 = c.xr(s, rs + 1);
    const t1 = c.xr(s, t);
    const t2 = c.xr(s, t + 1);
    var o1: u64 = undefined;
    var o2: u64 = undefined;
    if (x) {
        const p = try s.m.rmwPtr([2]u64, va);
        const old = if (c.smp) casPair128Shared(host([2]u64, p), s1, s2, t1, t2) else casPair128Plain(p, s1, s2, t1, t2);
        o1 = old[0];
        o2 = old[1];
    } else {
        const lo: u64 = 0xffff_ffff;
        const w = try casMem(s, u64, va, (s1 & lo) | (s2 << 32), (t1 & lo) | (t2 << 32));
        o1 = w & lo;
        o2 = w >> 32;
    }
    c.setX(s, rs, o1);
    c.setX(s, rs + 1, o2);
    return .next;
}

// ---- memory -------------------------------------------------------------------
//
// The address is aligned, so the access stays in one page. `rmwPtr` checks
// write permission (and tracks stores into decoded code) before anything
// happens, so a fault leaves memory and registers alone.

/// The aligned host pointer for an atomic builtin.
inline fn host(comptime T: type, p: anytype) *T {
    return @ptrFromInt(@intFromPtr(p));
}

fn rmw(s: c.St, comptime T: type, va: u64, op: Op, v: T) c.Error!T {
    const p = try s.m.rmwPtr(T, va);
    if (c.smp) return rmwShared(T, host(T, p), op, v);
    const old = p.*;
    p.* = apply(T, op, old, v);
    return old;
}

fn casMem(s: c.St, comptime T: type, va: u64, cmp: T, new: T) c.Error!T {
    const p = try s.m.rmwPtr(T, va);
    if (c.smp) return casShared(T, host(T, p), cmp, new);
    const old = p.*;
    if (old == cmp) p.* = new;
    return old;
}

/// The value an atomic memory operation stores: op(old, v).
pub fn apply(comptime T: type, op: Op, old: T, v: T) T {
    const S = std.meta.Int(.signed, @bitSizeOf(T));
    const so: S = @bitCast(old);
    const sv: S = @bitCast(v);
    return switch (op) {
        .add => old +% v,
        .clr => old & ~v,
        .eor => old ^ v,
        .set => old | v,
        .smax => if (so > sv) old else v,
        .smin => if (so < sv) old else v,
        .umax => @max(old, v),
        .umin => @min(old, v),
        .swp => v,
    };
}

/// The atomic memory operation on shared memory (SMP builds; called
/// directly by the unit tests on host threads): one wasm atomic
/// read-modify-write, or a compare-and-swap loop for min and max.
pub fn rmwShared(comptime T: type, p: *T, op: Op, v: T) T {
    switch (op) {
        .add => return @atomicRmw(T, p, .Add, v, .seq_cst),
        .clr => return @atomicRmw(T, p, .And, ~v, .seq_cst),
        .eor => return @atomicRmw(T, p, .Xor, v, .seq_cst),
        .set => return @atomicRmw(T, p, .Or, v, .seq_cst),
        .swp => return @atomicRmw(T, p, .Xchg, v, .seq_cst),
        else => {
            var old = @atomicLoad(T, p, .seq_cst);
            while (true) old = @cmpxchgWeak(T, p, old, apply(T, op, old, v), .seq_cst, .seq_cst) orelse return old;
        },
    }
}

/// CAS on shared memory: the old value.
pub fn casShared(comptime T: type, p: *T, cmp: T, new: T) T {
    return @cmpxchgStrong(T, p, cmp, new, .seq_cst, .seq_cst) orelse cmp;
}

fn casPair128Plain(p: *allowzero align(1) [2]u64, s1: u64, s2: u64, t1: u64, t2: u64) [2]u64 {
    const old: [2]u64 = .{ p[0], p[1] };
    if (old[0] == s1 and old[1] == s2) {
        p[0] = t1;
        p[1] = t2;
    }
    return old;
}

/// CASP of two X registers on shared memory (SMP builds; the unit tests
/// call it on host threads): under excl.zig's `pair_lock`, which every
/// 128-bit STXP takes too, read both halves; if they match, compare-and-swap
/// the low half, then the high half, undoing the low half if the high one
/// changed meanwhile (only a racing 64-bit writer, which is not covered, can
/// do that). Returns what memory held (on a lost race, what it held when the
/// swap failed, which also differs from s1:s2).
pub fn casPair128Shared(p: *[2]u64, s1: u64, s2: u64, t1: u64, t2: u64) [2]u64 {
    excl.pairLock();
    defer excl.pairUnlock();
    const o1 = @atomicLoad(u64, &p[0], .seq_cst);
    const o2 = @atomicLoad(u64, &p[1], .seq_cst);
    if (o1 != s1 or o2 != s2) return .{ o1, o2 };
    if (@cmpxchgStrong(u64, &p[0], s1, t1, .seq_cst, .seq_cst)) |now| return .{ now, o2 };
    if (@cmpxchgStrong(u64, &p[1], s2, t2, .seq_cst, .seq_cst)) |now| {
        _ = @cmpxchgStrong(u64, &p[0], t1, s1, .seq_cst, .seq_cst);
        return .{ s1, now };
    }
    return .{ s1, s2 };
}
