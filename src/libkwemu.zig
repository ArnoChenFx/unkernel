// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Root of the kwemu library build (static archive + relocatable object).
//! The contract is include/kw_emu.h (A64); the C ABI is exported from
//! a64/run.zig, on top of the MMU in emu/kwemu.zig.

const a64 = @import("a64/run.zig");

comptime {
    a64.exportAbi();
}

/// Safety checks are compiled out in release builds; anything that still
/// panics just traps (no formatting, no imports from the embedding kernel).
pub const panic = @import("std").debug.no_panic;
