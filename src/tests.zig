// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Native unit-test root.
test {
    _ = @import("cpu/fpu.zig");
    _ = @import("emu/kwemu_test.zig");
}
