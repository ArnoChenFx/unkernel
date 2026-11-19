// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, branch family (emit.zig; stream "branches and regions").
//! Semantics: opexec.zig. Side exits (bcond_x, cbz_x, tbz_x) leave with
//! code_side + k and pc = target; terminators set pc and leave with
//! code_done, or branch to a region member through the core's checked
//! entry; b_f is nothing, bl_f sets x30 (both keep the op count exact).
//! Conditions come from alu.zig's lazy NZCV (CMP + B.cond is one compare).
//! A block whose terminator targets its own start is a wasm loop polling
//! *irqp, the code epoch (SMP) and the budget at the back edge.

const ops = @import("../ops.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;

pub const kinds = [_]ops.H{
    .bcond_x, .cbz_x, .tbz_x, .b_f, .bl_f, .bcond, .cbz, .tbz, .b, .bl, .br, .blr, .goto,
};

pub fn supported(o: Op) bool {
    _ = o;
    return false;
}

pub fn usage(o: Op) Use {
    return switch (o.h) {
        .bcond_x, .bcond => .{ .flags_read = true },
        .cbz_x, .tbz_x, .cbz, .tbz => .{ .read = cm.xbit(o.a) },
        .b_f, .b, .goto => .{},
        .bl_f, .bl => .{ .write = cm.xbit(30) },
        .br => .{ .read = cm.xbit(o.b) },
        .blr => .{ .read = cm.xbit(o.b), .write = cm.xbit(30) },
        else => unreachable,
    };
}

pub fn emit(e: anytype, o: Op, k: usize, pc: u64) void {
    _ = .{ e, o, k, pc };
    unreachable; // not supported yet
}
