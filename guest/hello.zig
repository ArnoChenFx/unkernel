// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
const std = @import("std");
const rt = @import("rt");

pub fn main(init: std.process.Init.Minimal) void {
    rt.print("Hello from riscv64 userspace! pid={d}\n", .{rt.linux.getpid()});
    var it = init.args.iterate();
    var i: usize = 0;
    while (it.next()) |a| : (i += 1) rt.print("argv[{d}] = {s}\n", .{ i, a });
}
