// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa
//! A64 JIT: exclusives, load-acquire/store-release and the LSE atomics
//! inline (`generic` ops in the tier; emit.zig decodes them here before
//! falling back to an interpreter call). Semantics: excl.zig and lse.zig,
//! which these must match exactly, also in the exclusive monitor:
//!
//!   LDAR, STLR (B, H, W, X)          an aligned load / store
//!   LDXR, LDAXR (B, H, W, X)         load, then open the monitor: Hart.resv
//!                                    = va, Hart.resv_val = the value,
//!                                    Priv.excl_size = bytes, excl_val2 = 0
//!   STXR, STLXR (B, H, W, X)         store if resv == va and excl_size ==
//!                                    bytes (SMP: a compare-and-swap against
//!                                    resv_val), close the monitor, Ws = 0
//!                                    on success, else 1
//!   LD<op>, SWP (every size, op)     read-modify-write, Rt = old value
//!   CAS (every size)                 compare-and-swap, Rs = old value
//!   CLREX                            close the monitor (resv = no_resv)
//!   DMB, DSB (SMP builds; on one CPU   c.barrier: a seq_cst read-modify-
//!   the tier makes them nops)          write of Hart.fence_word
//!   ISB                                nothing (the block ends after it,
//!                                    and `run` checks the code epoch)
//!   DC ZVA                           zero the aligned 64 bytes (branch.zig
//!                                    dcZva: one write-TLB check over the
//!                                    block, plain 8-byte stores, as the
//!                                    interpreter's c.store also on SMP)
//!
//! Pairs (LDXP/STXP, LDAXP/STLXP) and CASP stay interpreter calls: no
//! workload measured runs them (a64.md, Generic ops by word).
//!
//! Faults: a misaligned address and every data-TLB miss (unmapped, no
//! permission, a page holding decoded code: code_flag in the write TLB)
//! hand the op back before anything is written; the interpreter then
//! raises what it raises (or, for an STXR whose monitor does not hold,
//! fails it without touching memory: the same result). Every form that
//! writes takes the write TLB, also a CAS whose compare fails and an LD<op>
//! into XZR (lse.zig: read-modify-writes need write permission), and an
//! STXR (a store when the monitor holds; when it does not, the hand-back
//! leaves the interpreter to fail it).
//!
//! Atomicity: one CPU needs none (a compiled module never stops inside an
//! op), so the accesses are plain wasm loads and stores. With
//! -Dkwemu-atomics (`c.smp`, what the interpreter's semantics depend on)
//! every access is a wasm atomic (seq_cst), exactly as the interpreter's
//! builtins compile: LDAR/LDXR `i64.atomic.load*`, STLR `i64.atomic.store*`,
//! STXR and CAS `i64.atomic.rmw*.cmpxchg` (the narrow forms wrap the
//! expected value; it is masked here too), LDADD/LDCLR (AND of ~Rs)/LDEOR/
//! LDSET/SWP one `i64.atomic.rmw*` each, the min/max forms a
//! compare-and-swap loop. So another CPU's interpreter or compiled code
//! never sees a window in which an update is lost. Atomic instructions are
//! valid on a non-shared memory too (the wasm64 unit tests of an atomics
//! build), and the address is naturally aligned on the host (aligned guest
//! address, page-aligned host page), as wasm atomics require.

const std = @import("std");
const builtin = @import("builtin");
const c = @import("../common.zig");
const ops = @import("../ops.zig");
const lse = @import("../lse.zig");
const state = @import("../state.zig");
const core = @import("../../cpu/core.zig");
const kwemu = @import("../../emu/kwemu.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const W = jc.W;

pub const Kind = enum(u8) { ldar, stlr, ldxr, stxr, ldop, cas, clrex, dczva, barrier, isb };

pub const A = struct {
    kind: Kind,
    /// log2 of the access size
    size: u2,
    /// Rt, Rn (31: SP), Rs (register numbers; 31 is XZR for Rt and Rs)
    t: u8,
    n: u8,
    s: u8 = 31,
    op: lse.Op = .add,
};

/// Test builds: ops emitted inline (the kind test checks it grew).
pub var emitted: usize = 0;

/// The word's inline form, only for encodings the reference accepts with
/// exactly that meaning (ldst.zig, excl.zig, lse.zig decode).
pub fn decode(raw: u32) ?A {
    const size: u2 = @intCast(raw >> 30);
    const rs: u8 = @intCast((raw >> 16) & 31);
    const t2 = (raw >> 10) & 31;
    const n: u8 = @intCast((raw >> 5) & 31);
    const t: u8 = @intCast(raw & 31);
    // Load/store exclusive and ordered: size 001000 o2 L o1 Rs o0 Rt2 Rn Rt
    if (raw & 0x3f00_0000 == 0x0800_0000) {
        const o2 = raw & (1 << 23) != 0;
        const is_load = raw & (1 << 22) != 0;
        const o1 = raw & (1 << 21) != 0;
        const o0 = raw & (1 << 15) != 0;
        if (o2) {
            if (o1) return if (t2 == 31) .{ .kind = .cas, .size = size, .t = t, .n = n, .s = rs } else null;
            if (!o0 or rs != 31 or t2 != 31) return null; // LDLAR/STLLR, should-be-one fields
            return .{ .kind = if (is_load) .ldar else .stlr, .size = size, .t = t, .n = n };
        }
        if (o1 or t2 != 31) return null; // pairs, CASP
        if (is_load) return if (rs == 31) .{ .kind = .ldxr, .size = size, .t = t, .n = n } else null;
        return .{ .kind = .stxr, .size = size, .t = t, .n = n, .s = rs };
    }
    if (raw & 0xffff_f0ff == 0xd503_305f) return .{ .kind = .clrex, .size = 0, .t = 31, .n = 31 }; // any CRm
    if (raw & 0xffff_f0df == 0xd503_309f) return .{ .kind = .barrier, .size = 0, .t = 31, .n = 31 }; // DSB, DMB (any option)
    if (raw & 0xffff_f0ff == 0xd503_30df) return .{ .kind = .isb, .size = 0, .t = 31, .n = 31 };
    if (raw & 0xffff_ffe0 == 0xd50b_7420) return .{ .kind = .dczva, .size = 3, .t = t, .n = 31 }; // DC ZVA, Xt
    // Atomic memory operations: size 111 V 00 A R 1 Rs o3 opc 00 Rn Rt (V = 0)
    if (raw & 0x3f20_0c00 == 0x3820_0000) {
        const opc: u4 = @intCast((raw >> 12) & 7);
        const op: lse.Op = if (raw & (1 << 15) == 0) @enumFromInt(opc) else if (opc == 0) .swp else return null;
        return .{ .kind = .ldop, .size = size, .t = t, .n = n, .s = rs, .op = op };
    }
    return null;
}

/// Whether the CPU that compiles runs this form (the LSE ones need FEAT_LSE
/// enabled; kw_set_isa drops compiled code when it changes).
pub fn enabled(e: *Emit, a: A) bool {
    return switch (a.kind) {
        .ldop, .cas => c.implemented & c.featureBit(.lse) != 0 and e.cpu().priv.a64.isa & c.featureBit(.lse) != 0,
        else => true,
    };
}

fn xs(r: u8) u8 {
    return if (r == 31) ops.zr else r;
}

pub fn usage(a: A) Use {
    const base = switch (a.kind) {
        .clrex, .dczva, .barrier, .isb => Use{},
        else => cm.rd(a.n), // 31: SP
    };
    return switch (a.kind) {
        .ldar, .ldxr => base.with(cm.wr(xs(a.t))),
        .stlr => base.with(cm.rd(xs(a.t))),
        .stxr => base.with(cm.rd(xs(a.t))).with(cm.wr(xs(a.s))),
        .ldop => base.with(cm.rd(xs(a.s))).with(cm.wr(xs(a.t))),
        .cas => base.with(cm.rd(xs(a.s))).with(cm.rd(xs(a.t))).with(cm.wr(xs(a.s))),
        .clrex, .barrier, .isb => .{},
        .dczva => cm.rd(xs(a.t)),
    };
}

// ---- emission -----------------------------------------------------------------

const Priv = @FieldType(kwemu.Cpu, "priv");
const hart_off = jc.priv_off + @offsetOf(Priv, "hart");
const resv_off = hart_off + @offsetOf(core.Hart, "resv");
const resv_val_off = hart_off + @offsetOf(core.Hart, "resv_val");
const fence_off = hart_off + @offsetOf(core.Hart, "fence_word");
const a64_off = jc.priv_off + @offsetOf(Priv, "a64");
const excl_size_off = a64_off + @offsetOf(state.Priv, "excl_size");
const excl_val2_off = a64_off + @offsetOf(state.Priv, "excl_val2");

/// One op's scratch (l_t): the host address, the old value, the register
/// operand, the compare value, a new value.
const l_host = cm.l_t;
const l_old = cm.l_t + 1;
const l_v = cm.l_t + 2;
const l_cmp = cm.l_t + 3;
const l_new = cm.l_t + 4;

/// DC ZVA's block (DCZID_EL0 = 4: 64 bytes).
const zva: u64 = 64;
comptime {
    std.debug.assert(@import("../branch.zig").zva_bytes == zva);
}

fn mask(size: u2) u64 {
    return if (size == 3) ~@as(u64, 0) else (@as(u64, 1) << (@as(u6, 8) << size)) - 1;
}

/// l_va = Xn|SP; hand back unless it is aligned to `bytes`; then the data
/// TLB (write or read) over the access, the host address in l_host.
fn address(e: *Emit, a: A, at: At, write: bool) void {
    const bytes = @as(u64, 1) << a.size;
    cm.get(e, a.n);
    e.set(cm.l_va);
    if (bytes > 1) {
        e.get(cm.l_va);
        e.k64(bytes - 1);
        e.op(W.i64_and);
        e.op(W.i64_eqz);
        e.op(W.i32_eqz);
        e.open(W.@"if", W.void_t);
        e.handBack(at.k, at.pc);
        e.close();
    }
    e.tlbCheck(at.k, at.pc, if (write) jc.tlb_w_off else jc.tlb_r_off, bytes);
    if (e.mem32) e.op(W.i64_ext_u);
    e.set(l_host);
}

fn host(e: *Emit) void {
    e.get(l_host);
    e.addr();
}

/// A threads-proposal memory instruction (0xfe prefix) of 1 << size bytes.
fn atom(e: *Emit, code: u8, size: u2) void {
    atomAt(e, code, size, 0);
}
fn atomAt(e: *Emit, code: u8, size: u2, off: u64) void {
    e.ops(&.{ 0xfe, code });
    e.uleb(size); // atomics take exactly the natural alignment
    e.uleb(off);
}

/// Opcodes by size (8, 16, 32, 64 bits; i64 forms, zero-extending).
const at_load = [4]u8{ 0x14, 0x15, 0x16, 0x11 };
const at_store = [4]u8{ 0x1b, 0x1c, 0x1d, 0x18 };
const at_add = [4]u8{ 0x22, 0x23, 0x24, 0x1f };
const at_and = [4]u8{ 0x30, 0x31, 0x32, 0x2d };
const at_or = [4]u8{ 0x37, 0x38, 0x39, 0x34 };
const at_xor = [4]u8{ 0x3e, 0x3f, 0x40, 0x3b };
const at_xchg = [4]u8{ 0x45, 0x46, 0x47, 0x42 };
const at_cmpxchg = [4]u8{ 0x4c, 0x4d, 0x4e, 0x49 };
const pl_load = [4]u8{ W.i64_load8_u, W.i64_load16_u, W.i64_load32_u, W.i64_load };
const pl_store = [4]u8{ W.i64_store8, W.i64_store16, W.i64_store32, W.i64_store };

/// Load 1 << size bytes at the address operand on the stack (zero-extended).
fn load(e: *Emit, size: u2) void {
    if (c.smp) atom(e, at_load[size], size) else e.mem(pl_load[size], size, 0);
}
/// Store the low 1 << size bytes of the i64 on the stack at the address
/// operand under it.
fn store(e: *Emit, size: u2) void {
    if (c.smp) atom(e, at_store[size], size) else e.mem(pl_store[size], size, 0);
}

fn cpuAddr(e: *Emit) void {
    e.get(jc.l_cpu);
    e.addr();
}

/// Push l (an i64 local) sign-extended from 8 << size bits.
fn sext(e: *Emit, l: u32, size: u2) void {
    e.get(l);
    if (size == 3) return;
    const sh: u64 = 64 - (@as(u64, 8) << size);
    e.k64(sh);
    e.op(W.i64_shl);
    e.k64(sh);
    e.op(W.i64_shr_s);
}

/// Push op(l_old, l_v) (lse.apply; the store truncates to the size).
fn apply(e: *Emit, op: lse.Op, size: u2) void {
    switch (op) {
        .add, .eor, .set => {
            e.get(l_old);
            e.get(l_v);
            e.op(switch (op) {
                .add => W.i64_add,
                .eor => W.i64_xor,
                else => W.i64_or,
            });
        },
        .clr => {
            e.get(l_old);
            e.get(l_v);
            e.k64(~@as(u64, 0));
            e.op(W.i64_xor);
            e.op(W.i64_and);
        },
        .swp => e.get(l_v),
        .smax, .smin, .umax, .umin => {
            e.get(l_old);
            e.get(l_v);
            switch (op) {
                .smax, .smin => {
                    sext(e, l_old, size);
                    sext(e, l_v, size);
                    e.op(if (op == .smax) W.i64_gt_s else W.i64_lt_s);
                },
                else => {
                    e.get(l_old); // zero-extended
                    e.get(l_v);
                    if (size != 3) {
                        e.k64(mask(size));
                        e.op(W.i64_and);
                    }
                    e.op(if (op == .umax) W.i64_gt_u else W.i64_lt_u);
                },
            }
            e.op(W.select); // old if it wins, else v
        },
    }
}

pub fn emit(e: *Emit, a: A, at: At) void {
    if (builtin.is_test) emitted += 1;
    const sz = a.size;
    switch (a.kind) {
        .isb => {},
        .barrier => if (c.smp) {
            cpuAddr(e);
            e.k32(0);
            atomAt(e, 0x1e, 2, fence_off); // i32.atomic.rmw.add
            e.op(W.drop);
        },
        .clrex => {
            cpuAddr(e);
            e.k64(core.no_resv);
            e.mem(W.i64_store, 3, resv_off);
        },
        .dczva => {
            cm.get(e, xs(a.t));
            e.k64(~@as(u64, zva - 1));
            e.op(W.i64_and);
            e.set(cm.l_va);
            e.tlbCheck(at.k, at.pc, jc.tlb_w_off, zva);
            if (e.mem32) e.op(W.i64_ext_u);
            e.set(l_host);
            var off: u64 = 0;
            while (off < zva) : (off += 8) {
                host(e);
                e.k64(0);
                e.mem(W.i64_store, 3, off);
            }
        },
        .ldar => {
            address(e, a, at, false);
            host(e);
            load(e, sz);
            cm.set(e, xs(a.t));
        },
        .stlr => {
            address(e, a, at, true);
            host(e);
            cm.get(e, xs(a.t));
            store(e, sz);
        },
        .ldxr => {
            address(e, a, at, false);
            host(e);
            load(e, sz);
            e.set(l_old);
            // excl.open: resv = va, resv_val = v, excl_size = bytes, excl_val2 = 0
            cpuAddr(e);
            e.get(cm.l_va);
            e.mem(W.i64_store, 3, resv_off);
            cpuAddr(e);
            e.get(l_old);
            e.mem(W.i64_store, 3, resv_val_off);
            cpuAddr(e);
            e.k32(@as(i32, 1) << sz);
            e.mem(W.i32_store, 2, excl_size_off);
            cpuAddr(e);
            e.k64(0);
            e.mem(W.i64_store, 3, excl_val2_off);
            e.get(l_old);
            cm.set(e, xs(a.t));
        },
        .stxr => {
            address(e, a, at, true);
            cm.get(e, xs(a.t));
            e.set(l_v);
            // holds: resv == va and excl_size == bytes
            cpuAddr(e);
            e.mem(W.i64_load, 3, resv_off);
            e.get(cm.l_va);
            e.op(W.i64_eq);
            cpuAddr(e);
            e.mem(W.i32_load, 2, excl_size_off);
            e.k32(@as(i32, 1) << sz);
            e.op(W.i32_eq);
            e.op(W.i32_and);
            e.open(W.@"if", W.i64_t);
            if (c.smp) {
                // compare-and-swap against what the exclusive load read
                host(e);
                cpuAddr(e);
                e.mem(W.i64_load, 3, resv_val_off);
                if (sz != 3) {
                    e.k64(mask(sz));
                    e.op(W.i64_and);
                }
                e.tee(l_cmp);
                e.get(l_v);
                atom(e, at_cmpxchg[sz], sz);
                e.get(l_cmp);
                e.op(W.i64_eq);
                e.op(W.i64_ext_u);
            } else {
                host(e);
                e.get(l_v);
                store(e, sz);
                e.k64(1);
            }
            e.op(W.@"else");
            e.k64(0);
            e.close();
            e.set(l_old); // stored
            // excl.close
            cpuAddr(e);
            e.k64(core.no_resv);
            e.mem(W.i64_store, 3, resv_off);
            e.get(l_old);
            e.k64(1);
            e.op(W.i64_xor);
            cm.set(e, xs(a.s));
        },
        .ldop => {
            address(e, a, at, true);
            cm.get(e, xs(a.s));
            e.set(l_v);
            if (!c.smp) {
                host(e);
                load(e, sz);
                e.set(l_old);
                host(e);
                apply(e, a.op, sz);
                store(e, sz);
            } else switch (a.op) {
                .add, .clr, .eor, .set, .swp => {
                    host(e);
                    e.get(l_v);
                    if (a.op == .clr) {
                        e.k64(~@as(u64, 0));
                        e.op(W.i64_xor);
                    }
                    atom(e, switch (a.op) {
                        .add => at_add[sz],
                        .clr => at_and[sz],
                        .eor => at_xor[sz],
                        .set => at_or[sz],
                        else => at_xchg[sz],
                    }, sz);
                    e.set(l_old);
                },
                else => {
                    // lse.rmwShared: a compare-and-swap loop from an atomic load
                    host(e);
                    load(e, sz);
                    e.set(l_old);
                    e.open(W.loop, W.void_t);
                    host(e);
                    e.get(l_old);
                    apply(e, a.op, sz);
                    atom(e, at_cmpxchg[sz], sz);
                    e.tee(l_new);
                    e.get(l_old);
                    e.op(W.i64_ne);
                    e.open(W.@"if", W.void_t);
                    e.get(l_new);
                    e.set(l_old);
                    e.op(W.br);
                    e.uleb(1); // the loop
                    e.close();
                    e.close();
                },
            }
            e.get(l_old);
            cm.set(e, xs(a.t));
        },
        .cas => {
            address(e, a, at, true);
            cm.get(e, xs(a.s));
            if (sz != 3) {
                e.k64(mask(sz));
                e.op(W.i64_and);
            }
            e.set(l_cmp);
            cm.get(e, xs(a.t));
            e.set(l_v);
            if (c.smp) {
                host(e);
                e.get(l_cmp);
                e.get(l_v);
                atom(e, at_cmpxchg[sz], sz);
                e.set(l_old);
            } else {
                host(e);
                load(e, sz);
                e.tee(l_old);
                e.get(l_cmp);
                e.op(W.i64_eq);
                e.open(W.@"if", W.void_t);
                host(e);
                e.get(l_v);
                store(e, sz);
                e.close();
            }
            e.get(l_old);
            cm.set(e, xs(a.s));
        },
    }
}

// ---- tests (kindtest.zig) ---------------------------------------------------------
//
// Programs of every inline form, every size, with what makes them differ:
// an address register (x25..x28) set by ADD from a data page base (x20..x22,
// SP), the read-only page (x24: stores and read-modify-writes fault), the
// unmapped one (x23), or the code page (x19: with `rwx_code` stores hit
// decoded code), at an offset that is mostly aligned to the access and
// sometimes not (KW_EV_MISALIGNED), often the same address in a row; then
// LDXR/LDAXR followed by an STXR/STLXR of the same or another size or
// address (passes, fails), a plain STR into the monitored bytes in between,
// CLREX, LDAR/STLR, LD<op>/SWP and CAS whose compare is made to pass by an
// LDAR of the same location first; Rs and Rt now and then XZR, the address
// register or each other. kindtest compares the exclusive monitor too.

const kt = @import("kindtest.zig");

fn ldxrW(size: u32, acq: bool, n: u32, t: u32) u32 {
    return (size << 30) | 0x085f_7c00 | (@as(u32, @intFromBool(acq)) << 15) | (n << 5) | t;
}
fn stxrW(size: u32, rel: bool, s: u32, n: u32, t: u32) u32 {
    return (size << 30) | 0x0800_7c00 | (s << 16) | (@as(u32, @intFromBool(rel)) << 15) | (n << 5) | t;
}
fn ldarW(size: u32, n: u32, t: u32) u32 {
    return (size << 30) | 0x08df_fc00 | (n << 5) | t;
}
fn stlrW(size: u32, n: u32, t: u32) u32 {
    return (size << 30) | 0x089f_fc00 | (n << 5) | t;
}
fn casW(size: u32, r: std.Random, s: u32, n: u32, t: u32) u32 {
    return (size << 30) | 0x08a0_7c00 | (r.uintLessThan(u32, 2) << 22) | (s << 16) | (r.uintLessThan(u32, 2) << 15) | (n << 5) | t;
}
fn lseW(size: u32, r: std.Random, s: u32, n: u32, t: u32) u32 {
    const op = r.uintLessThan(u32, 9); // 8: SWP
    const o3: u32 = if (op == 8) 1 else 0;
    const opc: u32 = if (op == 8) 0 else op;
    return (size << 30) | 0x3820_0000 | (r.uintLessThan(u32, 4) << 22) | (s << 16) | (o3 << 15) | (opc << 12) | (n << 5) | t;
}

/// A register for data (Rt, Rs): mostly 0..18, sometimes XZR or an
/// address register.
fn dataReg(r: std.Random) u32 {
    return switch (r.uintLessThan(u32, 16)) {
        0 => 31,
        1 => 25 + r.uintLessThan(u32, 4),
        else => r.uintLessThan(u32, 19),
    };
}

fn genAtomic(r: std.Random, out: []u32, pc: u64) usize {
    _ = pc;
    const size = r.uintLessThan(u32, 4);
    const bytes = @as(u32, 1) << @intCast(size);
    const a: u32 = 25 + r.uintLessThan(u32, 4);
    var i: usize = 0;
    // add xA, xBASE, #off (or keep xA from the last group: the same address)
    if (r.uintLessThan(u32, 4) != 0) {
        const b: u32 = switch (r.uintLessThan(u32, 16)) {
            0 => 23, // unmapped
            1 => 24, // read only
            2 => 19, // code
            3 => 31, // sp
            else => 20 + r.uintLessThan(u32, 3),
        };
        var off = r.uintLessThan(u32, 8) * 8;
        if (r.uintLessThan(u32, 8) == 0) off += 1 + r.uintLessThan(u32, 7); // misaligned for most sizes
        out[i] = 0x9100_0000 | (off << 10) | (b << 5) | a;
        i += 1;
    }
    const n = if (r.uintLessThan(u32, 16) == 0) 31 else a; // sometimes [sp] itself
    switch (r.uintLessThan(u32, 10)) {
        0, 1, 2 => { // LDXR (after an LDXP: excl_val2 set); maybe a plain store or CLREX; STXR
            if (r.uintLessThan(u32, 4) == 0) {
                out[i] = 0xc87f_0000 | (r.uintLessThan(u32, 19) << 10) | (n << 5) | r.uintLessThan(u32, 19); // ldxp (a call)
                i += 1;
            }
            out[i] = ldxrW(size, r.boolean(), n, dataReg(r));
            i += 1;
            switch (r.uintLessThan(u32, 6)) {
                0 => {
                    out[i] = 0xf900_0000 | (dataReg(r) << 0) | (n << 5); // str xT, [xA]
                    out[i] = (out[i] & ~@as(u32, 31)) | r.uintLessThan(u32, 19);
                    i += 1;
                },
                1 => {
                    out[i] = 0xd503_305f | (r.uintLessThan(u32, 16) << 8); // clrex
                    i += 1;
                },
                2 => {
                    out[i] = 0x9100_0400 | (r.uintLessThan(u32, 19) << 5) | r.uintLessThan(u32, 19); // add xT, xT', #1
                    i += 1;
                },
                else => {},
            }
            const ss = if (r.uintLessThan(u32, 4) == 0) r.uintLessThan(u32, 4) else size;
            const nn = if (r.uintLessThan(u32, 6) == 0) 20 + r.uintLessThan(u32, 3) else n;
            out[i] = stxrW(ss, r.boolean(), dataReg(r), nn, dataReg(r));
            i += 1;
        },
        3 => {
            out[i] = switch (r.uintLessThan(u32, 8)) {
                0 => 0xd503_30bf | (r.uintLessThan(u32, 16) << 8), // dmb
                1 => 0xd503_309f | (r.uintLessThan(u32, 16) << 8), // dsb
                2 => 0xd503_30df | (r.uintLessThan(u32, 16) << 8), // isb
                else => stxrW(size, r.boolean(), dataReg(r), n, dataReg(r)), // monitor from before (or closed)
            };
            i += 1;
        },
        4 => {
            out[i] = if (r.uintLessThan(u32, 3) == 0) 0xd50b_7420 | (if (r.uintLessThan(u32, 8) == 0) r.uintLessThan(u32, 32) else n) else ldarW(size, n, dataReg(r)); // dc zva, xN (any register now and then)
            i += 1;
        },
        5 => {
            out[i] = stlrW(size, n, dataReg(r));
            i += 1;
        },
        6, 7 => {
            out[i] = lseW(size, r, dataReg(r), n, dataReg(r));
            i += 1;
        },
        else => { // CAS, made to pass half the time by an LDAR of its location
            const s = dataReg(r);
            if (r.boolean() and s != 31) {
                out[i] = ldarW(size, n, s);
                i += 1;
                if (r.boolean()) { // high bits a narrow CAS must ignore
                    out[i] = 0xf2e0_0000 | (r.uintLessThan(u32, 65536) << 5) | s; // movk xS, #imm, lsl 48
                    i += 1;
                }
            }
            out[i] = casW(size, r, s, n, dataReg(r));
            i += 1;
        },
    }
    _ = bytes;
    return i;
}

/// A loop now and then (B back to the program's start, so later passes
/// run compiled with a warm TLB and an open monitor from the last pass).
fn genAtomicLoop(r: std.Random, out: []u32, pc: u64) usize {
    if (r.uintLessThan(u32, 24) == 0) {
        const back: i64 = @divExact(@as(i64, @intCast(kt.code_va)) - @as(i64, @intCast(pc)), 4);
        out[0] = 0x1400_0000 | @as(u32, @truncate(@as(u64, @bitCast(back)) & 0x3ff_ffff));
        return 1;
    }
    return genAtomic(r, out, pc);
}

test "a64 jit atomic: decode against the reference" {
    // Every word decode accepts must be one the reference runs as the same
    // instruction; spot-check neighbours that must stay calls.
    try std.testing.expect(decode(0x885f_7c00) != null); // ldxr w0, [x0]
    try std.testing.expect(decode(0x8841_7c00) == null); // Rs != 31
    try std.testing.expect(decode(0x885f_0000) == null); // Rt2 != 31
    try std.testing.expect(decode(0x889f_7c00) == null); // stllr (LOR)
    try std.testing.expect(decode(0xc87f_0000) == null); // ldxp
    try std.testing.expect(decode(0x4820_7c00) == null); // casp
    try std.testing.expect(decode(0xf8e0_0000).?.kind == .ldop); // ldaddal
    try std.testing.expect(decode(0xf8e0_8000).?.op == .swp); // swpal
    try std.testing.expect(decode(0xf8e0_9000) == null); // o3 = 1, opc != 0 (LDAPR, ...)
    try std.testing.expect(decode(0xfce0_0000) == null); // V = 1
    try std.testing.expect(decode(0xc8e0_fc00).?.kind == .cas); // casal
    try std.testing.expect(decode(0xc8e0_fc00 & ~@as(u32, 0x7c00)) == null); // Rt2 != 31
}

test "a64 jit atomic: exclusives, ordered, LSE" {
    const before = emitted;
    try kt.kind(.generic, genAtomic, .{ .words = 40 });
    try kt.kind(.generic, genAtomic, .{ .warm_tlb = true, .seed = 2, .words = 40 });
    try kt.kind(.generic, genAtomicLoop, .{ .warm_tlb = true, .seed = 3, .words = 60, .budget = 20_000 });
    try kt.kind(.generic, genAtomic, .{ .rwx_code = true, .warm_tlb = true, .seed = 4, .rounds = 100, .words = 40 });
    if (jc.enabled) try std.testing.expect(emitted > before);
}
