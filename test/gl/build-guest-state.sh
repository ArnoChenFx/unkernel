#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds kwgl-state.c (or another GL test program, SRC) for the Debian
# guest (aarch64, glibc), for unkernel-check.mjs: zig cc with this host's
# EGL, GLES and GBM headers, linked against stand-ins for libEGL.so.1,
# libGLESv2.so.2 and libgbm.so.1 (when it uses GBM) made here from the
# symbols it uses, so the guest's own libraries (glvnd, Mesa) serve it at
# run time and the build needs nothing of Debian's.
#
#   test/gl/build-guest-state.sh [OUT [SRC]]    (default: $build/gl/kwgl-state-aarch64, test/gl/kwgl-state.c)
set -eu
. "$(cd "$(dirname "$0")/../.." && pwd)/guest/lib/env.sh"
need_zig
out=${1:-$build/gl/kwgl-state-aarch64}
src=${2:-$root/test/gl/kwgl-state.c}
for d in EGL GLES2 GLES3 KHR; do
	[ -d "/usr/include/$d" ] || { echo "no /usr/include/$d (EGL and GLES development headers)" >&2; exit 2; }
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/inc" "$(dirname "$out")"
cp -r /usr/include/EGL /usr/include/GLES2 /usr/include/GLES3 /usr/include/KHR "$work/inc/"
[ -f /usr/include/gbm.h ] && cp /usr/include/gbm.h "$work/inc/"
cc=("$zig" cc -target aarch64-linux-gnu.2.36 -mcpu=generic "-ffile-prefix-map=$root/=")
"${cc[@]}" -O2 -Wall -I "$work/inc" -c "$src" -o "$work/prog.o"
syms=$(nm -u "$work/prog.o" | awk '{ print $2 }')
libs=()
stub() { # soname, symbol prefix
	grep "^$2" <<<"$syms" | sed 's/$/(void) {}/; s/^/void /' >"$work/$1.c"
	[ -s "$work/$1.c" ] || return 0
	"${cc[@]}" -shared -nostdlib -Wl,-soname,"$1" -o "$work/$1" "$work/$1.c"
	libs+=("$work/$1")
}
stub libEGL.so.1 egl
stub libGLESv2.so.2 gl
stub libgbm.so.1 gbm_
"${cc[@]}" -s -o "$out" "$work/prog.o" "${libs[@]}"
echo "$out"
