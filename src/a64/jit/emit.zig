// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! The A64 JIT: the ISA hooks of the ISA-neutral core (src/emu/jitcore.zig:
//! slot pool, compile policy, module skeleton, regions; this file is its
//! hook namespace `I`, `C = jc.Jit(@This())`) and the dispatch to the op
//! families, one file each so that the JIT streams own disjoint files
//! (a64.md, "JIT"):
//!
//!   alu.zig     moves, ALU immediate and register, logical, CSEL, CCMP,
//!               ADC, and the NZCV model (lazy flags) the others consume
//!   bits.zig    bitfield, extract, variable shifts, multiply, divide,
//!               1-source
//!   mem.zig     every load and store (data-TLB fast path, pairs, Q)
//!   branch.zig  side exits, terminators, followed branches, and the
//!               region hooks (targets, member transfers, self-loops)
//!
//! Each family file declares `kinds` (the op kinds it owns; the comptime
//! check below gives every kind exactly one owner) and implements
//!   supported(o: Op) bool          translated (else handed back before it)
//!   usage(o: Op) Use               slots and flags it reads and writes
//!   emit(e: *Emit, o: Op, at: At)  its code (only called when supported)
//!   Ext                            its part of the module's emission state
//!                                  (e.x.<family>), default-initialised
//!   beginMember(e, o: []const Op)  a block's or member's code starts
//!   sync(e: *Emit)                 before a branch out of straight-line
//!                                  code (jitcore.zig, `I.sync`)
//! `generic` ops (FP, AdvSIMD, system, exclusives, LSE, crypto: what the
//! tier runs through the reference interpreter) become calls of
//! `opexec.jitGeneric` through the kernel's function table, where the host
//! offers it (jitcore.zig, cap_table; else they are handed back): `generic`
//! below; the frequent ones are translated inline (generic.zig). common.zig
//! has the locals, slot access and Use helpers.

const std = @import("std");
const O = @import("../ops.zig");
const state = @import("../state.zig");
const kwemu = @import("../../emu/kwemu.zig");
const jc = @import("../../emu/jitcore.zig");
const tier = @import("../tier.zig");
const cm = @import("common.zig");
const opexec = @import("../opexec.zig");
const gen = @import("generic.zig");
const Cpu = kwemu.Cpu;
const Block = kwemu.Block;
const H = O.H;
const W = jc.W;

pub const alu = @import("alu.zig");
pub const bits = @import("bits.zig");
pub const mem = @import("mem.zig");
pub const branch = @import("branch.zig");

pub const Op = O.Op;
/// The core instantiated for A64: `C.ready`, `C.noteExit`, ... (tier.zig).
pub const C = jc.Jit(@This());
pub const Emit = C.Emit;

/// What translated ops read and write: X0..X30 and SP (bits 0..31 of
/// read/write), V0..V31 (both halves; vread/vwrite), TPIDR_EL0, NZCV. A
/// module's prologue loads the union of what its members read or write
/// (every written slot too: a hand-back writes all of them back), its
/// epilogue stores what they write. common.zig `rd`/`wr` give the bits of
/// any slot.
pub const Use = struct {
    read: u32 = 0,
    write: u32 = 0,
    vread: u32 = 0,
    vwrite: u32 = 0,
    tpidr_read: bool = false,
    tpidr_write: bool = false,
    flags_read: bool = false,
    flags_write: bool = false,

    pub fn add(u: *Use, x: Use) void {
        u.read |= x.read;
        u.write |= x.write;
        u.vread |= x.vread;
        u.vwrite |= x.vwrite;
        u.tpidr_read = u.tpidr_read or x.tpidr_read;
        u.tpidr_write = u.tpidr_write or x.tpidr_write;
        u.flags_read = u.flags_read or x.flags_read;
        u.flags_write = u.flags_write or x.flags_write;
    }
    /// u and x together.
    pub fn with(u: Use, x: Use) Use {
        var r = u;
        r.add(x);
        return r;
    }
};

/// Where an op is: its index k in block b (k instructions of b retired
/// before it), its pc, and whether b is emitted as a self-loop (its
/// terminator branches to b.pc and continues the module's `loop`; only for
/// a block compiled on its own).
pub const At = struct {
    k: usize,
    pc: u64,
    b: *const Block,
    self_loop: bool,
};

/// The module's A64 emission state (`Emit.x`): one part per family.
pub const EmitExt = struct {
    /// Position of the padded local count (`locals`), patched once the
    /// code is emitted.
    locals_at: usize = 0,
    /// A `generic` call ran last: regs in memory are current and the
    /// register locals are not; the next op of a family (and every exit,
    /// through `sync`) loads them first, so a run of generic ops spills and
    /// reloads once.
    stale: bool = false,
    alu: alu.Ext = .{},
    bits: bits.Ext = .{},
    mem: mem.Ext = .{},
    branch: branch.Ext = .{},
};

pub const Family = enum { alu, bits, mem, branch, none };

/// The family that owns op kind h (`none`: generic, never translated).
pub fn family(h: H) Family {
    return owner[@intFromEnum(h)];
}

const owner: [@typeInfo(H).@"enum".fields.len]Family = blk: {
    var t: [@typeInfo(H).@"enum".fields.len]Family = @splat(.none);
    var seen: [t.len]bool = @splat(false);
    for (.{ .{ Family.alu, alu.kinds }, .{ Family.bits, bits.kinds }, .{ Family.mem, mem.kinds }, .{ Family.branch, branch.kinds } }) |fk| {
        for (fk[1]) |h| {
            const i = @intFromEnum(h);
            if (seen[i]) @compileError("op kind in two JIT families: " ++ @tagName(h));
            seen[i] = true;
            t[i] = fk[0];
        }
    }
    for (@typeInfo(H).@"enum".fields, 0..) |f, i| {
        if (!seen[i] and !std.mem.eql(u8, f.name, "generic")) @compileError("op kind without a JIT family: " ++ f.name);
    }
    break :blk t;
};

pub fn supported(o: Op) bool {
    return switch (family(o.h)) {
        .alu => alu.supported(o),
        .bits => bits.supported(o),
        .mem => mem.supported(o),
        .branch => branch.supported(o),
        .none => jc.table_ok or gen.decode(o.aux()) != null,
    };
}

pub fn usage(o: Op) Use {
    return switch (family(o.h)) {
        .alu => alu.usage(o),
        .bits => bits.usage(o),
        .mem => mem.usage(o),
        .branch => branch.usage(o),
        // A call spills and reloads what the module holds (`generic`).
        .none => if (gen.decode(o.aux())) |f| gen.usage(f) else .{},
    };
}

pub fn emitOp(e: *Emit, o: Op, k: usize, pc: u64, b: *const Block, self_loop: bool) void {
    const at: At = .{ .k = k, .pc = pc, .b = b, .self_loop = self_loop };
    const fast = if (family(o.h) == .none) gen.decode(o.aux()) else null;
    if (e.x.stale and (family(o.h) != .none or fast != null)) {
        reload(e);
        e.x.stale = false;
    }
    switch (family(o.h)) {
        .alu => alu.emit(e, o, at),
        .bits => bits.emit(e, o, at),
        .mem => mem.emit(e, o, at),
        .branch => branch.emit(e, o, at),
        .none => if (fast) |f| gen.emit(e, f, at) else generic(e, o, at),
    }
}

/// A `generic` op: the reference interpreter runs it (`opexec.jitGeneric`,
/// called through env.table). It may read and write any register, so the
/// module's registers are written back before the call (the ones it
/// writes; NZCV synced first) and loaded again after it (all it holds),
/// and NZCV is exact afterwards. The call returns 0: retired, go on; 1: not
/// executed (a fault, a trap, MRS CNTVCT_EL0): hand it back, the
/// interpreter runs it again and raises what it raises; 2: retired, and
/// the block must end after it (it stored into decoded code, IC IVAU):
/// leave as a side exit to the next instruction.
fn generic(e: *Emit, o: Op, at: At) void {
    const u = e.use.?.*;
    if (!e.x.stale) spill(e, u);
    e.get(jc.l_x);
    e.get(jc.l_cpu);
    e.k64(o.aux());
    e.k64(at.pc);
    e.callTable(@intFromPtr(&opexec.jitGeneric));
    e.set(cm.l_t);
    e.x.stale = true;
    alu.exactNow(e);
    e.get(cm.l_t);
    e.op(W.i64_eqz);
    e.op(W.i32_eqz);
    e.open(W.@"if", W.void_t);
    e.get(cm.l_t);
    e.k64(1);
    e.op(W.i64_eq);
    e.open(W.@"if", W.void_t);
    e.handBack(at.k, at.pc); // sync reloads on the way out
    e.close();
    if (e.rg) |rg| e.regionSide(rg, at.pc +% 4, at.k, at.b) else {
        e.exit(at.pc +% 4, jc.code_side + at.k);
        e.brExit();
    }
    e.close();
}

/// Write back what the module's code wrote (lazy NZCV first).
fn spill(e: *Emit, u: Use) void {
    alu.sync(e);
    for (0..32) |s| {
        if (u.write & (@as(u32, 1) << @intCast(s)) != 0) store(e, W.i64_store, 3, @intCast(s), cm.local(@intCast(s)));
    }
    for (0..32) |n| {
        if (u.vwrite & (@as(u32, 1) << @intCast(n)) == 0) continue;
        const lo: u8 = @intCast(O.v0_slot + 2 * n);
        store(e, W.i64_store, 3, lo, cm.local(lo));
        store(e, W.i64_store, 3, lo + 1, cm.local(lo + 1));
    }
    if (u.tpidr_write) store(e, W.i64_store, 3, O.tpidr_slot, cm.local(O.tpidr_slot));
    if (u.flags_write) store(e, W.i64_store32, 2, O.nzcv_slot, cm.l_nzcv);
}

/// Load every register local of the module again (after `generic`).
fn reload(e: *Emit) void {
    const u = e.use.?.*;
    prologue(e, u);
}

// ---- the core's hooks (jitcore.zig, `Jit`) ----------------------------------------

pub const l_npc = cm.l_npc;
pub const l_code = cm.l_code;
pub const l_va = cm.l_va;
pub const l_e = cm.l_e;
pub const l_region = cm.l_region;

pub fn ops(cpu: *Cpu, b: *const Block) []const Op {
    return cpu.opArena(Op)[b.op..][0..b.n];
}

pub const nextPc = O.nextPc;

pub fn blockUse(o: []const Op) Use {
    var u: Use = .{};
    for (o) |x| u.add(usage(x));
    return u;
}

pub fn beginMember(e: *Emit, o: []const Op) void {
    e.x.stale = false; // a member is entered with its locals current
    alu.beginMember(e, o);
    bits.beginMember(e, o);
    mem.beginMember(e, o);
    branch.beginMember(e, o);
}

pub fn sync(e: *Emit) void {
    if (e.x.stale) reload(e); // on this path only
    alu.sync(e);
    bits.sync(e);
    mem.sync(e);
    branch.sync(e);
}

/// `sync` before a branch back to the start of the block or member being
/// emitted (a self-loop's back edge; jitcore.zig): alu.zig skips NZCV when
/// the block writes it before anything reads it or can leave.
pub fn syncHead(e: *Emit) void {
    if (e.x.stale) reload(e);
    alu.syncHead(e);
    bits.sync(e);
    mem.sync(e);
    branch.sync(e);
}

/// No helper functions yet.
pub fn helperCount(e: *Emit, use: Use) u32 {
    _ = .{ e, use };
    return 0;
}

/// One group of i64 locals; its count is patched in `emitHelpers` once the
/// code is emitted (up to the highest local it uses, `Emit.top`).
pub fn locals(e: *Emit, region: bool) void {
    _ = region; // the region locals are among the first (common.zig)
    e.op(0x01);
    e.x.locals_at = e.reserve();
    e.op(W.i64_t);
}

pub fn emitHelpers(e: *Emit) void {
    if (!e.ok) return;
    var v: u32 = @max(e.top + 1, jc.l_jl + 2) - (jc.l_jl + 1);
    for (0..5) |i| {
        e.buf[e.x.locals_at + i] = @as(u8, @truncate(v & 0x7f)) | (if (i < 4) @as(u8, 0x80) else 0);
        v >>= 7;
    }
}

fn load(e: *Emit, opc: u8, alignment: u8, slot: u8, l: u32) void {
    e.get(jc.l_x);
    e.addr();
    e.mem(opc, alignment, cm.off(slot));
    e.set(l);
}
fn store(e: *Emit, opc: u8, alignment: u8, slot: u8, l: u32) void {
    e.get(jc.l_x);
    e.addr();
    e.get(l);
    e.mem(opc, alignment, cm.off(slot));
}

pub fn prologue(e: *Emit, use: Use) void {
    const live = use.read | use.write;
    for (0..32) |s| {
        if (live & (@as(u32, 1) << @intCast(s)) != 0) load(e, W.i64_load, 3, @intCast(s), cm.local(@intCast(s)));
    }
    const vlive = use.vread | use.vwrite;
    for (0..32) |n| {
        if (vlive & (@as(u32, 1) << @intCast(n)) == 0) continue;
        const lo: u8 = @intCast(O.v0_slot + 2 * n);
        load(e, W.i64_load, 3, lo, cm.local(lo));
        load(e, W.i64_load, 3, lo + 1, cm.local(lo + 1));
    }
    if (use.tpidr_read or use.tpidr_write) load(e, W.i64_load, 3, O.tpidr_slot, cm.local(O.tpidr_slot));
    // regs.nzcv is the low half of its slot (fpcr the high half).
    if (use.flags_read or use.flags_write) load(e, W.i64_load32_u, 2, O.nzcv_slot, cm.l_nzcv);
}

pub fn epilogue(e: *Emit, use: Use) void {
    for (0..32) |s| {
        if (use.write & (@as(u32, 1) << @intCast(s)) != 0) store(e, W.i64_store, 3, @intCast(s), cm.local(@intCast(s)));
    }
    for (0..32) |n| {
        if (use.vwrite & (@as(u32, 1) << @intCast(n)) == 0) continue;
        const lo: u8 = @intCast(O.v0_slot + 2 * n);
        store(e, W.i64_store, 3, lo, cm.local(lo));
        store(e, W.i64_store, 3, lo + 1, cm.local(lo + 1));
    }
    if (use.tpidr_write) store(e, W.i64_store, 3, O.tpidr_slot, cm.local(O.tpidr_slot));
    if (use.flags_write) store(e, W.i64_store32, 2, O.nzcv_slot, cm.l_nzcv);
}

pub const selfLoop = branch.selfLoop;
pub const targets = branch.targets;
pub const memberTail = branch.memberTail;
pub const indirect = branch.indirect;

const a64_off = jc.priv_off + @offsetOf(@FieldType(Cpu, "priv"), "a64");

/// Push an i32, nonzero when compiled code must stop at this block or
/// member start: an interrupt is pending (*irqp), or, where several CPUs
/// exist (tier.multi_cpu), another CPU invalidated code since this one last
/// caught up (tier.zig, code coherence: the global code epoch, through the
/// pointer in a64.epoch_ptr, differs from a64.seen_epoch). Called at every
/// self-loop back edge and checked member entry, which `run` cannot see.
pub fn poll(e: *Emit) void {
    e.irqWord();
    if (!tier.multi_cpu) return;
    e.get(jc.l_cpu);
    e.addr();
    e.mem(W.i64_load, 3, a64_off + @offsetOf(state.Priv, "epoch_ptr"));
    e.addr();
    if (e.shared) {
        e.ops(&.{ 0xfe, 0x11 }); // i64.atomic.load
        e.uleb(3);
        e.uleb(0);
    } else e.mem(W.i64_load, 3, 0);
    e.get(jc.l_cpu);
    e.addr();
    e.mem(W.i64_load, 3, a64_off + @offsetOf(state.Priv, "seen_epoch"));
    e.op(W.i64_ne);
    e.op(W.i32_or);
}

test {
    _ = gen;
    _ = alu;
    _ = bits;
    _ = mem;
    _ = branch;
}

test "a64 jit: every op kind has one family" {
    inline for (@typeInfo(H).@"enum".fields) |f| {
        const h: H = @enumFromInt(f.value);
        try std.testing.expect((family(h) == .none) == (h == .generic));
    }
}

// ---- `generic` calls (kindtest.zig) -------------------------------------------------

const kt = @import("kindtest.zig");

/// Words that decode to `generic` ops of every class `jitGeneric` meets on
/// the image (scalar FP moves, compares, converts and arithmetic, AdvSIMD
/// DUP/MOVI/UMOV/INS, MRS/MSR of FPCR, FPSR and NZCV, CNTVCT (handed back),
/// DMB, exclusives on the data pages, the unmapped one (a fault: handed
/// back) and misaligned, a reserved FP word (ILLEGAL: handed back)), with
/// CMP and B.cond around them so that lazy flags meet the call and its
/// FCMP, and DC ZVA over the code page when it is writable (a store into
/// decoded code: the block ends after it).
fn genGeneric(r: std.Random, out: []u32, pc: u64) usize {
    _ = pc;
    const d = kt.dst(r);
    const n = kt.anyReg(r) & 31;
    const vd = r.uintLessThan(u32, 32);
    const vn = r.uintLessThan(u32, 32);
    const vm = r.uintLessThan(u32, 32);
    const ex: u32 = 20 + r.uintLessThan(u32, 4); // x20..x22 aligned data, x23 unmapped
    // The words that end a program (faults, ILLEGAL) are rarer.
    const sel = r.uintLessThan(u32, 64);
    out[0] = switch (if (sel < 24) sel else sel % 22) {
        0 => 0x9e67_0000 | (n << 5) | vd, // fmov dN, xN
        1 => 0x9e66_0000 | (vn << 5) | d, // fmov xD, dN
        2 => 0x1e27_0000 | (n << 5) | vd, // fmov sD, wN
        3 => 0x1e60_2800 | (vm << 16) | (vn << 5) | vd, // fadd d
        4 => 0x1e20_0800 | (vm << 16) | (vn << 5) | vd, // fmul s
        5 => 0x1e60_2010 | (vm << 16) | (vn << 5), // fcmpe d
        6 => 0x9e62_0000 | (n << 5) | vd, // scvtf dD, xN
        7 => 0x9e78_0000 | (vn << 5) | d, // fcvtzs xD, dN
        8 => 0x1e60_0c00 | (vm << 16) | (r.uintLessThan(u32, 16) << 12) | (vn << 5) | vd, // fcsel d
        9 => 0x4e01_0c00 | (n << 5) | vd, // dup vD.16b, wN
        10 => 0x6f00_e400 | vd, // movi vD.2d, #0
        11 => 0x4e18_3c00 | (vn << 5) | d, // umov xD, vN.d[1]
        12 => 0x4e18_1c00 | (n << 5) | vd, // mov vD.d[1], xN
        13 => 0xd53b_4400 | d, // mrs xD, fpcr
        14 => 0xd51b_4420 | (n & 30), // msr fpsr, xN
        15 => 0xd53b_4200 | d, // mrs xD, nzcv
        16 => 0xd51b_4200 | d, // msr nzcv, xD
        17 => 0xd53b_e040 | d, // mrs xD, cntvct_el0
        18 => 0xd503_3bbf, // dmb ish
        19 => 0xc85f_fc00 | (ex << 5) | d, // ldaxr xD, [xEX]
        20 => 0xc800_fc00 | (r.uintLessThan(u32, 19) << 16) | (ex << 5) | kt.anyReg(r) & 30, // stlxr wS, xT, [xEX]
        21 => 0x885f_7c00 | ((20 + r.uintLessThan(u32, 3)) << 5) | d, // ldxr wD, [x20..22]
        22 => 0x1ee0_2800 | (vm << 16) | (vn << 5) | vd, // fadd h: ILLEGAL (FEAT_FP16)
        else => 0xd50b_7420 | 19, // dc zva, x19 (the code page)
    };
    var i: usize = 1;
    switch (r.uintLessThan(u32, 4)) {
        0 => { // cmp xN, xM before
            out[i] = out[0];
            out[0] = 0xeb00_001f | (kt.anyReg(r) << 16) | ((kt.anyReg(r) & 30) << 5);
            i += 1;
        },
        1 => { // b.cond over one word after
            out[i] = 0x5400_0040 | r.uintLessThan(u32, 14);
            out[i + 1] = kt.movi(r);
            i += 2;
        },
        2 => {
            out[i] = kt.movi(r);
            i += 1;
        },
        else => {},
    }
    return i;
}

/// The forms generic.zig translates inline, every field at random (so
/// also their reserved and untranslated neighbours, which are calls), with
/// MSR FPCR (FZ set at random: FCMP hands back) and the same CMP / B.cond
/// surroundings as `genGeneric`.
fn genFast(r: std.Random, out: []u32, pc: u64) usize {
    const d = if (r.uintLessThan(u32, 8) == 0) 31 else kt.dst(r);
    const n = kt.anyReg(r);
    const vd = r.uintLessThan(u32, 32);
    const vn = r.uintLessThan(u32, 32);
    const vm = if (r.boolean()) vn else r.uintLessThan(u32, 32);
    const q = r.uintLessThan(u32, 2) << 30;
    out[0] = switch (r.uintLessThan(u32, 14)) {
        0 => 0x1e26_0000 | (vn << 5) | d, // fmov wD, sN
        1 => 0x1e27_0000 | (n << 5) | vd, // fmov sD, wN
        2 => 0x9e66_0000 | (vn << 5) | d, // fmov xD, dN
        3 => 0x9e67_0000 | (n << 5) | vd, // fmov dD, xN
        4 => 0x9eae_0000 | (vn << 5) | d, // fmov xD, vN.d[1]
        5 => 0x9eaf_0000 | (n << 5) | vd, // fmov vD.d[1], xN
        6, 7 => blk: { // DUP (general), INS (general), UMOV: any imm5
            const imm4: u32 = switch (r.uintLessThan(u32, 3)) {
                0 => 1,
                1 => 3,
                else => 7,
            };
            const rn = if (imm4 == 7) vn else n;
            const rd = if (imm4 == 7) d else vd;
            break :blk 0x0e00_0400 | q | (r.uintLessThan(u32, 32) << 16) | (imm4 << 11) | (rn << 5) | rd;
        },
        8 => 0x0f00_0400 | q | (r.uintLessThan(u32, 2) << 29) | (r.uintLessThan(u32, 8) << 16) | (r.uintLessThan(u32, 16) << 12) |
            (if (r.uintLessThan(u32, 16) == 0) @as(u32, 1) << 11 else 0) | (r.uintLessThan(u32, 32) << 5) | vd, // MOVI, MVNI, ORR, BIC, FMOV
        9 => 0x0e20_1c00 | q | (r.uintLessThan(u32, 2) << 29) | (r.uintLessThan(u32, 4) << 22) | (vm << 16) | (vn << 5) | vd, // AND .. BIF
        10, 11 => 0x1e20_2000 | (r.uintLessThan(u32, 2) << 22) | (vm << 16) | (vn << 5) | (r.uintLessThan(u32, 4) << 3), // FCMP(E) S/D, reg or #0
        12 => @as(u32, switch (r.uintLessThan(u32, 4)) { // MRS
            0 => 0xd53b_4400,
            1 => 0xd53b_4420,
            2 => 0xd53b_4200,
            else => 0xd53b_00e0,
        }) | d,
        else => 0xd51b_4400 | n, // msr fpcr, xN
    };
    var i: usize = 1;
    switch (r.uintLessThan(u32, 4)) {
        0 => {
            out[i] = out[0];
            out[0] = 0xeb00_001f | (kt.anyReg(r) << 16) | ((kt.anyReg(r) & 30) << 5);
            i += 1;
        },
        1 => {
            out[i] = 0x5400_0040 | r.uintLessThan(u32, 14);
            out[i + 1] = kt.movi(r);
            i += 2;
        },
        2 => {
            out[i] = kt.movi(r);
            i += 1;
        },
        else => {},
    }
    _ = pc;
    return i;
}

test "a64 jit: generic, inline forms" {
    try kt.kind(.generic, genFast, .{});
    try kt.kind(.generic, genFast, .{ .seed = 2, .words = 60 });
}

test "a64 jit: generic" {
    try kt.kind(.generic, genGeneric, .{});
    try kt.kind(.generic, genGeneric, .{ .warm_tlb = true, .seed = 2 });
    try kt.kind(.generic, genGeneric, .{ .rwx_code = true, .warm_tlb = true, .seed = 3, .rounds = 100 });
}
