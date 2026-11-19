// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Skeleton of the A64 JIT emitter (not built into kw_run yet; a64.md, "JIT
//! plan"). The decoded-op tier's op kinds (ops.H) are split into families,
//! one file each, so that the JIT streams own disjoint files:
//!
//!   alu.zig     moves, ALU immediate and register, logical, CSEL, CCMP,
//!               ADC, and the NZCV model (lazy flags) the others consume
//!   bits.zig    bitfield, extract, variable shifts, multiply, divide,
//!               1-source
//!   mem.zig     every load and store (data-TLB fast path, pairs, Q)
//!   branch.zig  side exits, terminators, followed branches (self-loops and
//!               region transfers through the core)
//!
//! Each family file declares `kinds` (the op kinds it owns) and implements
//!   supported(o: Op) bool              translated (else handed back)
//!   usage(o: Op) Use                   registers and flags it reads/writes
//!   emit(e: anytype, o: Op, k: usize, pc: u64) void
//! against the core's `Emit` (src/emu/jit.zig, factored to be ISA-neutral
//! by the core stream). This file only dispatches; `generic` ops are never
//! translated (hand back), as riscv's are not. The comptime check below
//! makes sure every kind has exactly one owner, so adding an op touches
//! ops.zig, opexec.zig and one family file.

const std = @import("std");
const ops = @import("../ops.zig");
const Op = ops.Op;
const H = ops.H;

pub const alu = @import("alu.zig");
pub const bits = @import("bits.zig");
pub const mem = @import("mem.zig");
pub const branch = @import("branch.zig");

/// What a translated op reads and writes: X0..X30 and SP (bits 0..31),
/// V0..V31, NZCV. A region's prologue loads the union of what its members
/// read or write, its epilogue stores what they write (as riscv's `Use`).
pub const Use = struct {
    read: u32 = 0,
    write: u32 = 0,
    vread: u32 = 0,
    vwrite: u32 = 0,
    flags_read: bool = false,
    flags_write: bool = false,

    pub fn add(u: *Use, x: Use) void {
        u.read |= x.read;
        u.write |= x.write;
        u.vread |= x.vread;
        u.vwrite |= x.vwrite;
        u.flags_read = u.flags_read or x.flags_read;
        u.flags_write = u.flags_write or x.flags_write;
    }
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

pub fn emitOp(e: anytype, o: Op, k: usize, pc: u64) void {
    switch (family(o.h)) {
        .alu => alu.emit(e, o, k, pc),
        .bits => bits.emit(e, o, k, pc),
        .mem => mem.emit(e, o, k, pc),
        .branch => branch.emit(e, o, k, pc),
        .none => unreachable, // not supported: the core hands it back
    }
}

test "a64 jit skeleton: every op kind has one family" {
    inline for (@typeInfo(H).@"enum".fields) |f| {
        const h: H = @enumFromInt(f.value);
        try std.testing.expect((family(h) == .none) == (h == .generic));
        // Nothing is translated yet.
        try std.testing.expect(!supported(.{ .h = h }));
    }
}
