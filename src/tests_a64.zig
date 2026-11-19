// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Native unit-test root of `zig build test` (the A64 CPU).
test {
    _ = @import("a64/tests.zig");
    _ = @import("a64/crypto_tests.zig");
    _ = @import("a64/tests_excl.zig");
    _ = @import("a64/tier_tests.zig");
    _ = @import("a64/jit/emit.zig");
}
