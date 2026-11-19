#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# apt-lz4 (apt-lz4.c), which compresses the package lists that build.sh
# bakes into the Debian image exactly as the image's apt would: built with
# zig cc (static, musl) from the pinned lz4 sources (LZ4_* in
# guest/tools/pins.sh, the same as erofs-utils.sh's) into
# vendor/toolchain/apt-lz4.
#
#   guest/distro/debian/tools/apt-lz4.sh    builds unless the stamp is
#                                           current, prints the path of
#                                           the program
set -euo pipefail

. "$(dirname "$0")/../../../lib/env.sh"   # root, vendor, zig, fetch_verified
. "$guest/tools/pins.sh"                  # LZ4_*
need_zig
dest="$vendor/toolchain/apt-lz4"
c="$(dirname "$0")/apt-lz4.c"
want="$({ grep -v '^[[:space:]]*#' "${BASH_SOURCE[0]}"; cat "$c"; } | sha256sum | cut -c1-16) $LZ4_VERSION $("$zig" version)"
if [ -x "$dest/apt-lz4" ] && [ "$(cat "$dest/.stamp" 2>/dev/null)" = "$want" ]; then
	echo "$dest/apt-lz4"
	exit 0
fi

fetch_verified "$LZ4_URL" "$vendor/downloads/lz4-$LZ4_VERSION.tar.gz" "$LZ4_SHA256" >&2
rm -rf "$dest"
mkdir -p "$dest/src"
tar -xzf "$vendor/downloads/lz4-$LZ4_VERSION.tar.gz" -C "$dest/src"
l="$dest/src/lz4-$LZ4_VERSION/lib"
"$zig" cc -target "$(uname -m)-linux-musl" -O2 -g0 -static -s -I"$l" -o "$dest/apt-lz4" \
	"$c" "$l/lz4.c" "$l/lz4hc.c" "$l/lz4frame.c" "$l/xxhash.c"
rm -rf "$dest/src"
echo "$want" > "$dest/.stamp"
echo "$dest/apt-lz4"
