#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# The omarchy-niri image, an experiment: distros/omarchy's image with niri, Mesa's
# GL and EGL and the libraries niri links, as vendor/build/distro/omarchy-niri.erofs
# and omarchy-niri.id. The niri binary (KW_NIRI_BIN, default
# vendor/build/niri-arm64/niri: build-niri.sh) is copied in at build time and not
# committed; rootfs/ is the variant's own files.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
niri="${KW_NIRI_BIN:-$root/vendor/build/niri-arm64/niri}"
[ -x "$niri" ] || { echo "omarchy-niri: no niri binary at $niri (build-niri.sh, or KW_NIRI_BIN=FILE)" >&2; exit 1; }

# Mesa's EGL and GLES (virtio_gpu's virgl driver when the display has it, the
# software rasterizer through kms_swrast otherwise: niri-session chooses);
# cairo and pango (its overlays), seatd, libinput, libdisplay-info, pixman and
# xkbcommon (its other shared libraries); mesa-utils (glxinfo, eglinfo).
packages="libegl1 libegl-mesa0 libgles2 libgl1 libglx-mesa0 libgl1-mesa-dri libgbm1 mesa-utils libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libseat1 libinput10 libdisplay-info2 libpixman-1-0 libxkbcommon0"

tree=$(mktemp -d)
trap 'rm -rf "$tree"' EXIT
cp -a "$here/rootfs/." "$tree/"
install -D -m 755 "$niri" "$tree/usr/bin/niri"
# install_tree copies a file with no comment header as it is when a NAME.license sits next to it.
: > "$tree/usr/bin/niri.license"

echo "omarchy-niri: niri from $niri" >&2
KW_OMARCHY_NAME=omarchy-niri KW_OMARCHY_PACKAGES="$packages" KW_OMARCHY_ROOTFS="$tree" \
	"$root/distros/omarchy/build.sh"
