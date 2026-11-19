// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Helpers the A64 JIT family files share (emit.zig): register-slot bits
//! for `Use`, op field access. Owned by the core stream.

const ops = @import("../ops.zig");
const Use = @import("emit.zig").Use;

/// Use bit of an X/SP slot (0..31); none for XZR (slot 32) and other slots.
pub fn xbit(slot: u8) u32 {
    return if (slot < 32) @as(u32, 1) << @intCast(slot) else 0;
}
/// Use bit of a V slot (36 + 2n).
pub fn vbit(slot: u8) u32 {
    return if (slot >= ops.v0_slot) @as(u32, 1) << @intCast((slot - ops.v0_slot) / 2) else 0;
}
/// Reads b and c, writes a (the common shape).
pub fn abc(o: ops.Op) Use {
    return .{ .read = xbit(o.b) | xbit(o.c), .write = xbit(o.a) };
}
