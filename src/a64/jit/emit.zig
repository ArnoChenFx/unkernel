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
//! `generic` ops are never translated (handed back), as riscv's are not.
//! common.zig has the locals, slot access and Use helpers.

const std = @import("std");
const O = @import("../ops.zig");
const state = @import("../state.zig");
const kwemu = @import("../../emu/kwemu.zig");
const jc = @import("../../emu/jitcore.zig");
const tier = @import("../tier.zig");
const cm = @import("common.zig");
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
        .none => false,
    };
}

pub fn usage(o: Op) Use {
    return switch (family(o.h)) {
        .alu => alu.usage(o),
        .bits => bits.usage(o),
        .mem => mem.usage(o),
        .branch => branch.usage(o),
        .none => .{},
    };
}

pub fn emitOp(e: *Emit, o: Op, k: usize, pc: u64, b: *const Block, self_loop: bool) void {
    const at: At = .{ .k = k, .pc = pc, .b = b, .self_loop = self_loop };
    switch (family(o.h)) {
        .alu => alu.emit(e, o, at),
        .bits => bits.emit(e, o, at),
        .mem => mem.emit(e, o, at),
        .branch => branch.emit(e, o, at),
        .none => unreachable, // not supported: the core hands it back
    }
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
    alu.beginMember(e, o);
    bits.beginMember(e, o);
    mem.beginMember(e, o);
    branch.beginMember(e, o);
}

pub fn sync(e: *Emit) void {
    alu.sync(e);
    bits.sync(e);
    mem.sync(e);
    branch.sync(e);
}

/// `sync` before a branch back to the start of the block or member being
/// emitted (a self-loop's back edge; jitcore.zig): alu.zig skips NZCV when
/// the block writes it before anything reads it or can leave.
pub fn syncHead(e: *Emit) void {
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
