#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds kwgl-state.c for the Debian guest (aarch64, glibc), for
# unkernel-check.mjs: zig cc with this host's EGL and GLES headers, linked
# against stand-ins for libEGL.so.1 and libGLESv2.so.2 made here from the
# symbols it uses, so the guest's own libraries (glvnd, Mesa) serve it at
# run time and the build needs nothing of Debian's.
#
#   test/gl/build-guest-state.sh [OUT]    (default: $build/gl/kwgl-state-aarch64)
set -eu
. "$(cd "$(dirname "$0")/../.." && pwd)/guest/lib/env.sh"
need_zig
out=${1:-$build/gl/kwgl-state-aarch64}
for d in EGL GLES2 GLES3 KHR; do
	[ -d "/usr/include/$d" ] || { echo "no /usr/include/$d (EGL and GLES development headers)" >&2; exit 2; }
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/inc" "$(dirname "$out")"
cp -r /usr/include/EGL /usr/include/GLES2 /usr/include/GLES3 /usr/include/KHR "$work/inc/"
cc=("$zig" cc -target aarch64-linux-gnu.2.36 -mcpu=generic "-ffile-prefix-map=$root/=")
"${cc[@]}" -O2 -Wall -I "$work/inc" -c "$root/test/gl/kwgl-state.c" -o "$work/kwgl-state.o"
syms=$(nm -u "$work/kwgl-state.o" | awk '{ print $2 }')
stub() { # soname, symbol prefix
	grep "^$2" <<<"$syms" | sed 's/$/(void) {}/; s/^/void /' >"$work/$1.c"
	"${cc[@]}" -shared -nostdlib -Wl,-soname,"$1" -o "$work/$1" "$work/$1.c"
}
stub libEGL.so.1 egl
stub libGLESv2.so.2 gl
"${cc[@]}" -s -o "$out" "$work/kwgl-state.o" "$work/libEGL.so.1" "$work/libGLESv2.so.2"
echo "$out"
