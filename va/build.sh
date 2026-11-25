#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds kwva, the guest's VA-API driver (kw_drv_video.so, .agents/va.md),
# and its test programs va-decode and va-encode (va/test/: the driver
# through its vtable, without libva).
#
#   va/build.sh          aarch64 glibc (the Debian guest): $build/va/
#                        kw_drv_video.so, va-decode and va-encode; the base
#                        build (guest/base/build.sh) puts the driver into the
#                        kw layer
#   va/build.sh native   this host: $build/va/native/, for test/va/relay.mjs
#
# The libva headers are pinned (va/pins.sh, fetched by va/headers.sh), so
# the build needs none on the host; neither program links libva.
set -eu
. "$(cd "$(dirname "$0")/.." && pwd)/kernel/tools/env.sh"
mode=${1:-guest}
src="$root/va"
. "$root/va/headers.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
va_headers "$work/inc"
case "$mode" in
guest)
	[ -n "$zig" ] || { echo "va: no zig on PATH" >&2; exit 1; }
	out="$build/va"
	cc=("$zig" cc -target aarch64-linux-gnu.2.36 -mcpu=generic "-ffile-prefix-map=$root/=")
	strip=(-s)
	;;
native)
	out="$build/va/native"
	cc=(cc)
	strip=()
	;;
*) echo "usage: $0 [guest|native]" >&2; exit 2 ;;
esac
mkdir -p "$out"
flags=(-O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers -I "$work/inc" -D_GNU_SOURCE)
"${cc[@]}" "${flags[@]}" "${strip[@]}" -fPIC -fvisibility=hidden -shared -Wl,-soname,kw_drv_video.so \
	-o "$out/kw_drv_video.so" "$src/driver/kwva.c" -lpthread
"${cc[@]}" "${flags[@]}" "${strip[@]}" -o "$out/va-decode" "$src/test/va-decode.c" -ldl
"${cc[@]}" "${flags[@]}" "${strip[@]}" -o "$out/va-encode" "$src/test/va-encode.c" -ldl
ls -l "$out/kw_drv_video.so" "$out/va-decode" "$out/va-encode"
