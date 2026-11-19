// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Native unit-test root of the riscv reference code (zig build test-riscv
//! with -Driscv-legacy; the A64 tests are tests_a64.zig).
test {
    _ = @import("cpu/fpu.zig");
    _ = @import("emu/kwemu_test.zig");
}
