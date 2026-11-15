// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Root of the kwemu library build (static archive + relocatable object).
//! The implementation is in emu/kwemu.zig; the contract is include/kw_emu.h.

const kwemu = @import("emu/kwemu.zig");

comptime {
    kwemu.exportAbi();
}

/// Safety checks are compiled out in release builds; anything that still
/// panics just traps (no formatting, no imports from the embedding kernel).
pub const panic = @import("std").debug.no_panic;
