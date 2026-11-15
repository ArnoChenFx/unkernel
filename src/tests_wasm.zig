// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! wasm64 unit-test root (JIT tier enabled; run by test/kwemu-unit-wasm.mjs
//! through src/test_runner_wasm.zig). The softfloat tests in cpu/fpu.zig
//! stay native-only.
test {
    _ = @import("emu/kwemu_test.zig");
}
