// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! kwemu-a64-classify: for each raw A64 instruction word, the group file
//! decode.zig routes it to and whether the interpreter implements it
//! (anything but KW_EV_ILLEGAL when executed once on a scratch machine:
//! a fault, syscall or breakpoint counts as implemented).
//!
//! usage: kwemu-a64-classify words.txt
//!   input: one word per line, 8 hex digits first, anything after ignored
//!   output: "<word> <group> ok|ILLEGAL" per input line, same order
//! test/a64-coverage.mjs builds the corpora and the report on top of it.

const std = @import("std");
const decode = @import("decode.zig");
const mach = @import("machine.zig");

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    const gpa = init.gpa;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 2) {
        std.Io.File.stderr().writeStreamingAll(io, "usage: kwemu-a64-classify words.txt\n") catch {};
        return 2;
    }
    const input = try std.Io.Dir.cwd().readFileAlloc(io, args[1], gpa, .limited(1 << 30));
    defer gpa.free(input);

    var m = try mach.Machine.init(gpa);
    defer m.deinit();
    const code_va: u64 = 0x10000;
    const data_va: u64 = 0x40000;
    m.mapData(data_va, 4);
    m.code(code_va, &.{0});
    const word: *align(1) u32 = @ptrCast(m.at(code_va).ptr);

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    var lines = std.mem.splitScalar(u8, input, '\n');
    while (lines.next()) |line| {
        const tok = std.mem.trim(u8, line, " \t\r");
        if (tok.len < 8) continue;
        const w = std.fmt.parseInt(u32, tok[0..8], 16) catch continue;
        word.* = std.mem.nativeToLittle(u32, w);
        // Fresh registers; every base register points at mapped data.
        m.regs = .{};
        for (&m.regs.x) |*x| x.* = data_va + 0x800;
        m.regs.sp = data_va + 0x1000;
        m.regs.pc = code_va;
        const ev = m.run(1);
        const ok = ev != mach.EV_ILLEGAL;
        try out.print(gpa, "{x:0>8} {s} {s}\n", .{ w, @tagName(decode.route(w)), if (ok) "ok" else "ILLEGAL" });
    }
    try std.Io.File.stdout().writeStreamingAll(io, out.items);
    return 0;
}
