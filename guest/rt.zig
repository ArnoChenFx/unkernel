// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Tiny guest runtime: raw Linux syscalls via std.os.linux (no libc).

const std = @import("std");
pub const linux = std.os.linux;

pub fn print(comptime fmt: []const u8, args: anytype) void {
    var buf: [512]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    _ = linux.write(1, s.ptr, s.len);
}

pub fn fail(comptime fmt: []const u8, args: anytype) noreturn {
    print("FAIL: " ++ fmt ++ "\n", args);
    linux.exit_group(1);
}

pub fn isErr(rc: usize) bool {
    return @as(isize, @bitCast(rc)) < 0 and @as(isize, @bitCast(rc)) > -4096;
}

pub fn mmapAnon(len: usize) []u8 {
    const rc = linux.mmap(null, len, .{ .READ = true, .WRITE = true }, .{ .TYPE = .PRIVATE, .ANONYMOUS = true }, -1, 0);
    if (isErr(rc)) fail("mmap errno {d}", .{-@as(isize, @bitCast(rc))});
    return @as([*]u8, @ptrFromInt(rc))[0..len];
}
