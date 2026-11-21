#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds vtest-bridge for the guest: static aarch64-linux-musl with the
# guest toolchain (cc_guest, guest/lib/env.sh; zig on PATH or $ZIG), the
# stream link only (no WebSocket, no helper), so libc is all it needs.
#
#   gl/bridge/build-guest.sh [OUT]    (default: $build/gl/vtest-bridge)
set -eu
. "$(cd "$(dirname "$0")/../.." && pwd)/guest/lib/env.sh"
need_zig
out=${1:-$build/gl/vtest-bridge}
mkdir -p "$(dirname "$out")"
"${cc_guest[@]}" -Wall -DVTEST_BRIDGE_STREAM_ONLY -o "$out" "$root/gl/bridge/vtest-bridge.c"
