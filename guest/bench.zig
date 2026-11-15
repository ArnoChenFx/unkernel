// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! CPU benchmark: sieve of Eratosthenes + recursive fib.
//! usage: bench [sieve_limit] [rounds]

const std = @import("std");
const rt = @import("rt");

fn fib(n: u32) u32 {
    return if (n < 2) n else fib(n - 1) + fib(n - 2);
}

fn arg(args: *std.process.Args.Iterator, default: usize) usize {
    const s = args.next() orelse return default;
    return std.fmt.parseInt(usize, s, 10) catch default;
}

pub fn main(init: std.process.Init.Minimal) void {
    var it = init.args.iterate();
    _ = it.next();
    const limit = arg(&it, 2_000_000);
    const rounds = arg(&it, 3);

    const sieve = rt.mmapAnon(limit + 1);
    var count: usize = 0;
    for (0..rounds) |_| {
        @memset(sieve, 1);
        sieve[0] = 0;
        sieve[1] = 0;
        var i: usize = 2;
        while (i * i <= limit) : (i += 1) {
            if (sieve[i] == 0) continue;
            var j = i * i;
            while (j <= limit) : (j += i) sieve[j] = 0;
        }
        count = 0;
        for (sieve) |v| count += v;
    }
    rt.print("primes below {d}: {d} ({d} rounds)\n", .{ limit, count, rounds });
    const f = fib(@intCast(@min(arg(&it, 27), 40)));
    rt.print("fib: {d}\n", .{f});
}
