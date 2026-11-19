// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, bit-manipulation and multiply family (emit.zig; stream "ALU
//! and flags" or its own). Semantics: opexec.zig. All are a few wasm i64
//! ops with the op's shift counts as constants: ubfm/sbfm/bfm are
//! shl/shr(_s)/shl (+ and), extr a shr/shl/or, the variable shifts mask
//! the count (31 or 63) like wasm does natively for 64 bits; madd/maddl
//! i64.mul; umulh/smulh the 32x32 decomposition of jit.zig's mulhu/mulCorr
//! (no i128 in wasm); udiv/sdiv guard the zero divisor and MIN / -1 (wasm
//! traps on both); rev1 is i64.clz, byte swaps by shifts and masks (no
//! wasm bswap), rbit by mask swaps.

const ops = @import("../ops.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;

pub const kinds = [_]ops.H{
    .ubfm, .sbfm, .bfm, .extr, .lslv, .lsrv, .asrv, .rorv, .madd, .maddl, .umulh, .smulh, .udiv, .sdiv, .rev1,
};

pub fn supported(o: Op) bool {
    _ = o;
    return false;
}

pub fn usage(o: Op) Use {
    return switch (o.h) {
        .ubfm, .sbfm, .rev1 => .{ .read = cm.xbit(o.b), .write = cm.xbit(o.a) },
        .bfm => .{ .read = cm.xbit(o.a) | cm.xbit(o.b), .write = cm.xbit(o.a) },
        .madd, .maddl => .{ .read = cm.xbit(o.b) | cm.xbit(o.c) | cm.xbit(o.d), .write = cm.xbit(o.a) },
        else => cm.abc(o),
    };
}

pub fn emit(e: anytype, o: Op, k: usize, pc: u64) void {
    _ = .{ e, o, k, pc };
    unreachable; // not supported yet
}
