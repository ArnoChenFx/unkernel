// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Load/store exclusive and load-acquire/store-release: the ldst class
//! `size 001000 o2 L o1 Rs o0 Rt2 Rn Rt` (ldst.zig routes it here).
//!
//! Implemented (ARMv8.0): LDXR, LDAXR, STXR, STLXR (B, H, W, X), LDXP,
//! LDAXP, STXP, STLXP (two W or two X registers), LDAR, STLR (B, H, W, X).
//! CAS and CASP (FEAT_LSE) are lse.zig. ILLEGAL: LDLAR/STLLR (FEAT_LOR),
//! and every encoding whose should-be-one fields (Rs, Rt2 where the
//! instruction has none) are not 11111: the Arm ARM makes those
//! CONSTRAINED UNPREDICTABLE and UNDEFINED is one of the permitted
//! behaviours.
//!
//! Every access must be naturally aligned (to the whole pair for LDXP/STXP),
//! else KW_EV_MISALIGNED with the address, before anything else happens.
//!
//! The monitor: Hart.resv (address, core.no_resv when open), Priv.excl_size
//! (bytes), Hart.resv_val and Priv.excl_val2 (what the load read: the value,
//! for a W pair the whole 64-bit word, for an X pair the first and second
//! register). STXR/STXP pass
//! only on the same address and size, and always close the monitor (pass or
//! fail). CLREX (branch.zig), kw_clear_reservation and kw_set_pgd close it.
//!
//! One CPU (no wasm atomics): plain accesses; the store passes on a matching
//! monitor, like riscv SC (src/cpu/core.zig, `amo`). A store by this CPU to
//! the monitored address in between does not close the monitor (the Arm ARM
//! leaves that IMPLEMENTATION DEFINED).
//!
//! Several CPUs (`c.smp`, -Dkwemu-atomics), mirroring core.amoShared: every
//! access here is a seq_cst wasm atomic, which covers acquire and release
//! (LDAXR, STLXR, LDAR, STLR) and the ordering of the plain forms. LDXR is an
//! atomic load, STXR a compare-and-swap against the value LDXR read: it
//! fails when another CPU changed the location, but an ABA change (back to
//! the same value) goes unnoticed, as in QEMU. A W pair is one 64-bit
//! access. An X pair has no 128-bit compare-and-swap in wasm: see
//! `storePair128Shared` for the scheme (a lock shared by all CPUs that
//! serialises every 128-bit STXP, two 64-bit compare-and-swaps inside it).

const std = @import("std");
const c = @import("common.zig");
const core = @import("../cpu/core.zig");
const lse = @import("lse.zig");

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    const size: u2 = @intCast(c.bits(inst, 31, 30));
    const o2 = c.bit(inst, 23);
    const load = c.bit(inst, 22);
    const o1 = c.bit(inst, 21);
    const o0 = c.bit(inst, 15); // acquire (loads) / release (stores)
    const rs = c.rm(inst);
    const t2 = c.rt2(inst);
    const n = c.rn(inst);
    const t = c.rd(inst);
    if (o2) {
        // Ordered: LDAR/STLR (o0 = 1); CAS (o1 = 1, FEAT_LSE). LDLAR/STLLR
        // (o0 = 0, FEAT_LOR) are not implemented.
        if (o1) return lse.compareSwap(s, inst);
        if (!o0 or rs != 31 or t2 != 31) return c.ill(s, inst);
        return if (load) loadAcquire(s, size, n, t) else storeRelease(s, size, n, t);
    }
    if (o1) {
        // Pairs of W (size 10) or X (size 11); size 0x is CASP (FEAT_LSE).
        if (size < 2) return lse.compareSwap(s, inst);
        if (load) {
            if (rs != 31) return c.ill(s, inst);
            return loadExclusivePair(s, size == 3, n, t, t2);
        }
        return storeExclusivePair(s, size == 3, rs, n, t, t2);
    }
    if (t2 != 31) return c.ill(s, inst);
    if (load) {
        if (rs != 31) return c.ill(s, inst);
        return loadExclusive(s, size, n, t);
    }
    return storeExclusive(s, size, rs, n, t);
}

// ---- semantics (decoded operands) -------------------------------------------------

/// LDXR/LDAXR: load 1 << size bytes, zero-extended into Xt (Wt), and open
/// the monitor on them.
pub fn loadExclusive(s: c.St, size: u2, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    const bytes = @as(u32, 1) << size;
    if (!c.checkAlign(s, va, bytes)) return .trap;
    const v = try loadAtomic(s, size, va);
    open(s, va, bytes, v, 0);
    c.setX(s, t, v);
    return .next;
}

/// STXR/STLXR: store the low 1 << size bytes of Xt if the monitor holds
/// exactly [va, va + size); Ws = 0 if stored, 1 if not. Closes the monitor.
pub fn storeExclusive(s: c.St, size: u2, rs: u32, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    const bytes = @as(u32, 1) << size;
    if (!c.checkAlign(s, va, bytes)) return .trap;
    const v = c.xr(s, t);
    var ok = false;
    if (holds(s, va, bytes)) ok = try storeConditional(s, size, va, s.h.resv_val, v);
    close(s);
    c.setX(s, rs, @intFromBool(!ok));
    return .next;
}

/// LDXP/LDAXP: two W (x = false) or X registers from [va, va + 8 or 16),
/// aligned to the whole pair.
pub fn loadExclusivePair(s: c.St, x: bool, n: u32, t: u32, t2: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    const bytes: u32 = if (x) 16 else 8;
    if (!c.checkAlign(s, va, bytes)) return .trap;
    var v1: u64 = undefined;
    var v2: u64 = undefined;
    if (x) {
        // Two 64-bit loads: a torn pair (another CPU's STXP between them)
        // never passes the STXP that checks it, so the architectural
        // guarantee (single-copy atomic if the STXP succeeds) holds.
        v1 = try loadAtomic(s, 3, va);
        v2 = try loadAtomic(s, 3, va +% 8);
        open(s, va, bytes, v1, v2);
    } else {
        // One 64-bit access (atomic). The monitor keeps the whole word, as
        // LDXR X does, so mixing the two forms behaves alike on both builds.
        const w = try loadAtomic(s, 3, va);
        v1 = w & 0xffff_ffff;
        v2 = w >> 32;
        open(s, va, bytes, w, v2);
    }
    c.setX(s, t, v1); // t == t2 is CONSTRAINED UNPREDICTABLE: Rt2 wins
    c.setX(s, t2, v2);
    return .next;
}

/// STXP/STLXP: store two W or X registers if the monitor holds the pair.
pub fn storeExclusivePair(s: c.St, x: bool, rs: u32, n: u32, t: u32, t2: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    const bytes: u32 = if (x) 16 else 8;
    if (!c.checkAlign(s, va, bytes)) return .trap;
    const v1 = c.xr(s, t);
    const v2 = c.xr(s, t2);
    var ok = false;
    if (holds(s, va, bytes)) {
        const p = s.priv();
        if (x) {
            ok = try storePair128(s, va, s.h.resv_val, p.excl_val2, v1, v2);
        } else {
            ok = try storeConditional(s, 3, va, s.h.resv_val, (v1 & 0xffff_ffff) | (v2 << 32));
        }
    }
    close(s);
    c.setX(s, rs, @intFromBool(!ok));
    return .next;
}

/// LDAR: an aligned load-acquire of 1 << size bytes.
pub fn loadAcquire(s: c.St, size: u2, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    if (!c.checkAlign(s, va, @as(u64, 1) << size)) return .trap;
    c.setX(s, t, try loadAtomic(s, size, va));
    return .next;
}

/// STLR: an aligned store-release of the low 1 << size bytes of Xt.
pub fn storeRelease(s: c.St, size: u2, n: u32, t: u32) c.Error!c.Exit {
    const va = c.xsp(s, n);
    if (!c.checkAlign(s, va, @as(u64, 1) << size)) return .trap;
    const v = c.xr(s, t);
    switch (size) {
        0 => try storeAtomic(s, u8, va, @truncate(v)),
        1 => try storeAtomic(s, u16, va, @truncate(v)),
        2 => try storeAtomic(s, u32, va, @truncate(v)),
        3 => try storeAtomic(s, u64, va, v),
    }
    return .next;
}

// ---- the monitor ----------------------------------------------------------------

inline fn open(s: c.St, va: u64, bytes: u32, v1: u64, v2: u64) void {
    s.h.resv = va;
    s.h.resv_val = v1;
    const p = s.priv();
    p.excl_size = bytes;
    p.excl_val2 = v2;
}

/// Whether the monitor is open on exactly [va, va + bytes).
inline fn holds(s: c.St, va: u64, bytes: u32) bool {
    return s.h.resv == va and s.priv().excl_size == bytes;
}

inline fn close(s: c.St) void {
    s.h.resv = core.no_resv;
}

// ---- accesses ---------------------------------------------------------------------
//
// All addresses here are naturally aligned, so every access stays in one
// page and the host pointers (Cpu.readPtr/rmwPtr) are aligned too.

/// The aligned host pointer for an atomic builtin.
inline fn host(comptime T: type, p: anytype) *T {
    return @ptrFromInt(@intFromPtr(p));
}

fn loadAtomic(s: c.St, size: u2, va: u64) c.Error!u64 {
    return switch (size) {
        0 => try loadT(s, u8, va),
        1 => try loadT(s, u16, va),
        2 => try loadT(s, u32, va),
        3 => try loadT(s, u64, va),
    };
}

inline fn loadT(s: c.St, comptime T: type, va: u64) c.Error!T {
    if (!c.smp) return c.load(s, T, va);
    return @atomicLoad(T, host(T, try s.m.readPtr(T, va)), .seq_cst);
}

inline fn storeAtomic(s: c.St, comptime T: type, va: u64, v: T) c.Error!void {
    if (!c.smp) return c.store(s, T, va, v);
    @atomicStore(T, host(T, try s.m.rmwPtr(T, va)), v, .seq_cst);
}

/// Store the low 1 << size bytes of `new` at va; on SMP only if memory still
/// holds `old` (the value the exclusive load read). Whether it stored.
fn storeConditional(s: c.St, size: u2, va: u64, old: u64, new: u64) c.Error!bool {
    return switch (size) {
        0 => try casT(s, u8, va, @truncate(old), @truncate(new)),
        1 => try casT(s, u16, va, @truncate(old), @truncate(new)),
        2 => try casT(s, u32, va, @truncate(old), @truncate(new)),
        3 => try casT(s, u64, va, old, new),
    };
}

inline fn casT(s: c.St, comptime T: type, va: u64, old: T, new: T) c.Error!bool {
    if (!c.smp) {
        try c.store(s, T, va, new);
        return true;
    }
    return @cmpxchgStrong(T, host(T, try s.m.rmwPtr(T, va)), old, new, .seq_cst, .seq_cst) == null;
}

/// STXP of two X registers at va (16-byte aligned).
fn storePair128(s: c.St, va: u64, old1: u64, old2: u64, v1: u64, v2: u64) c.Error!bool {
    if (!c.smp) {
        try c.store128(s, va, c.v128(v1, v2));
        return true;
    }
    return storePair128Shared(host([2]u64, try s.m.rmwPtr([2]u64, va)), old1, old2, v1, v2);
}

/// Serialises every 128-bit write by an exclusive or atomic instruction of
/// every CPU (SMP builds only): STXP and CASP (lse.zig) of two X registers.
/// It lives in the module's linear memory, which all CPU threads share, and
/// is never held across instructions, so a parked CPU or a snapshot never
/// sees it taken. The one piece of global state in kwemu besides the code
/// epoch (tier.zig).
var pair_lock: u32 = 0;

pub fn pairLock() void {
    while (@cmpxchgWeak(u32, &pair_lock, 0, 1, .seq_cst, .monotonic) != null) std.atomic.spinLoopHint();
}
pub fn pairUnlock() void {
    @atomicStore(u32, &pair_lock, 0, .seq_cst);
}

/// The 128-bit STXP on shared memory. wasm has no 128-bit compare-and-swap,
/// so: under `pair_lock`, compare-and-swap the low half, then the high half
/// (undoing the low half if the high one changed).
///
/// Guarantee: 128-bit STXPs and CASPs of all CPUs are serialised and each STXP passes only
/// if both halves still hold what its LDXP read (modulo ABA, as for STXR).
/// A torn LDXP (two loads around another CPU's STXP) cannot pass its STXP.
/// Plain loads may see a half-done STXP; the architecture allows that,
/// since only LDXP+STXP is 128-bit atomic in ARMv8.0 (LDP is two 64-bit
/// accesses). Not covered: another CPU writing one half with a plain or
/// 64-bit exclusive store while an STXP runs (mixed-size racing writers);
/// either may then win, and a failed STXP can briefly expose its low half.
/// QEMU instead stops all other CPUs (or uses a host 128-bit cmpxchg).
pub fn storePair128Shared(p: *[2]u64, old1: u64, old2: u64, v1: u64, v2: u64) bool {
    pairLock();
    defer pairUnlock();
    if (@cmpxchgStrong(u64, &p[0], old1, v1, .seq_cst, .seq_cst) != null) return false;
    if (@cmpxchgStrong(u64, &p[1], old2, v2, .seq_cst, .seq_cst) != null) {
        _ = @cmpxchgStrong(u64, &p[0], v1, old1, .seq_cst, .seq_cst);
        return false;
    }
    return true;
}
