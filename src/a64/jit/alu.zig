// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, ALU family (emit.zig; stream "ALU and flags"). Semantics:
//! opexec.zig, field layout: ops.zig.
//!
//! NZCV model (owned here, consumed by branch.zig, csel, ccmp, adc): a
//! flag-setting op records its operands and result in locals instead of
//! packing NZCV (lazy flags); a consumer evaluates its condition from them
//! directly (CMP + B.cond becomes one i64 compare); NZCV is materialised
//! into regs.nzcv only where it is live: at every exit and hand-back of the
//! block or region (an event must leave regs exact) and before an op that
//! reads it as a whole (adc, generic). A flag-setting op whose flags are
//! overwritten before any consumer or exit in the same block emits no flag
//! code at all (dead-flag elimination, a backward scan per block).

const ops = @import("../ops.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;

pub const kinds = [_]ops.H{
    .nop,       .movi,   .movk,    .mov,     .add_i,     .adds_i, .logic_i, .ands_i, .addsub_r,
    .addsubs_r, .add_rr, .adds_rr, .logic_r, .logic_ror, .ands_r, .csel,    .ccmp,   .adc,
};

pub fn supported(o: Op) bool {
    _ = o;
    return false;
}

pub fn usage(o: Op) Use {
    return switch (o.h) {
        .nop => .{},
        .movi => .{ .write = cm.xbit(o.a) },
        .movk => .{ .read = cm.xbit(o.a), .write = cm.xbit(o.a) },
        .mov, .add_i, .logic_i => .{ .read = cm.xbit(o.b), .write = cm.xbit(o.a) },
        .adds_i, .ands_i => .{ .read = cm.xbit(o.b), .write = cm.xbit(o.a), .flags_write = true },
        .addsub_r, .add_rr, .logic_r, .logic_ror => cm.abc(o),
        .addsubs_r, .adds_rr, .ands_r => blk: {
            var u = cm.abc(o);
            u.flags_write = true;
            break :blk u;
        },
        .csel => blk: {
            var u = cm.abc(o);
            u.flags_read = true;
            break :blk u;
        },
        .ccmp => .{ .read = cm.xbit(o.b) | cm.xbit(o.c), .flags_read = true, .flags_write = true },
        .adc => blk: {
            var u = cm.abc(o);
            u.flags_read = true;
            u.flags_write = o.g & 2 != 0;
            break :blk u;
        },
        else => unreachable,
    };
}

pub fn emit(e: anytype, o: Op, k: usize, pc: u64) void {
    _ = .{ e, o, k, pc };
    unreachable; // not supported yet
}
