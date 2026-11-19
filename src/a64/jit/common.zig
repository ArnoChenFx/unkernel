// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Helpers the A64 JIT family files share (emit.zig): the local layout,
//! register slots in locals, `Use` bits per slot. Owned by the core stream.
//!
//! Register slots are the tier's (ops.zig): 0..30 X, 31 SP, 32 XZR (regs.pc
//! in memory; compiled code never reads or writes it as a register), 33
//! NZCV, 35 TPIDR_EL0, 36 + 2n / 37 + 2n the low / high half of Vn. Every
//! slot a block uses lives in an i64 local from the prologue to the single
//! epilogue (`local`); XZR reads as the constant 0 and writes to it are
//! dropped (`get`, `set`).

const std = @import("std");
const ops = @import("../ops.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const Use = jit.Use;
const Emit = jit.Emit;
const W = jc.W;

// ---- locals (all i64) -------------------------------------------------------------
//
//   0..3     the parameters: x, cpu, irqp, jl (jitcore.zig)
//   4..7     core: next pc, result code, a data address, its TLB entry
//   8..11    core: region state (jitcore.zig, n_region_locals)
//   12       NZCV (bits 31..28, as regs.nzcv); alu.zig decides what it holds
//            between exits (lazy flags), the epilogue stores it
//   13..20   l_t + 0..7: scratch of one op's code (any family; never live
//            from one op to the next)
//   21..28   l_alu + 0..7: alu.zig's (lazy flags)
//   29..32   l_br + 0..3: branch.zig's
//   33..36   l_mem + 0..3: mem.zig's
//   37..68   X0..X30, SP (slot s: 37 + s)
//   69       TPIDR_EL0
//   70..133  V halves (slot 36 + j: 70 + j)
//
// A module declares locals only up to the highest one its code uses
// (emit.zig, `locals`), so they are in the order of how often a block
// needs them.

pub const l_npc: u32 = 4;
pub const l_code: u32 = 5;
pub const l_va: u32 = 6;
pub const l_e: u32 = 7;
pub const l_region: u32 = 8;
pub const l_nzcv: u32 = 12;
pub const l_t: u32 = 13;
pub const n_t = 8;
pub const l_alu: u32 = 21;
pub const n_alu = 8;
pub const l_br: u32 = 29;
pub const n_br = 4;
pub const l_mem: u32 = 33;
pub const n_mem = 4;
const l_xbase: u32 = 37;
const l_tpidr: u32 = 69;
const l_vbase: u32 = 70;
/// One past the last local.
pub const n_locals: u32 = l_vbase + 64;

comptime {
    std.debug.assert(l_region + jc.n_region_locals == l_nzcv);
    std.debug.assert(l_t + n_t == l_alu and l_alu + n_alu == l_br and l_br + n_br == l_mem and l_mem + n_mem == l_xbase);
    std.debug.assert(l_xbase + 32 == l_tpidr);
}

/// Byte offset of a slot in struct kw_regs (from x = &regs.x).
pub inline fn off(slot: u8) u64 {
    return @as(u64, slot) * 8;
}

/// The local of a register slot (X, SP, TPIDR_EL0, a V half; NZCV: l_nzcv;
/// not XZR).
pub fn local(slot: u8) u32 {
    if (slot < ops.zr) return l_xbase + slot;
    if (slot == ops.tpidr_slot) return l_tpidr;
    if (slot == ops.nzcv_slot) return l_nzcv;
    std.debug.assert(slot >= ops.v0_slot and slot < ops.v0_slot + 64);
    return l_vbase + (slot - ops.v0_slot);
}

/// Push the 64-bit value of slot `slot` (XZR: 0).
pub fn get(e: *Emit, slot: u8) void {
    if (slot == ops.zr) e.k64(0) else e.get(local(slot));
}

/// Pop the i64 on the stack into slot `slot` (XZR: dropped).
pub fn set(e: *Emit, slot: u8) void {
    if (slot == ops.zr) e.op(W.drop) else e.set(local(slot));
}

/// Use bit of an X/SP slot (0..31); none for XZR (slot 32) and other slots.
pub fn xbit(slot: u8) u32 {
    return if (slot < 32) @as(u32, 1) << @intCast(slot) else 0;
}
/// Use bit of a V slot (36 + 2n, either half: the whole register).
pub fn vbit(slot: u8) u32 {
    return if (slot >= ops.v0_slot and slot < ops.v0_slot + 64) @as(u32, 1) << @intCast((slot - ops.v0_slot) / 2) else 0;
}
/// What reading slot `slot` uses (any slot; XZR: nothing).
pub fn rd(slot: u8) Use {
    return .{
        .read = xbit(slot),
        .vread = vbit(slot),
        .tpidr_read = slot == ops.tpidr_slot,
        .flags_read = slot == ops.nzcv_slot,
    };
}
/// What writing slot `slot` uses (any slot; XZR: nothing).
pub fn wr(slot: u8) Use {
    return .{
        .write = xbit(slot),
        .vwrite = vbit(slot),
        .tpidr_write = slot == ops.tpidr_slot,
        .flags_write = slot == ops.nzcv_slot,
    };
}
/// Reads b and c, writes a (the common shape).
pub fn abc(o: ops.Op) Use {
    return rd(o.b).with(rd(o.c)).with(wr(o.a));
}
