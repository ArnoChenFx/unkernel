#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# The Alpine distro image: vendor/build/distro/alpine.erofs and alpine.ext4
# (guest/lib/image.sh), the read-only root that the base initramfs mounts
# under the root overlay: the aarch64 minirootfs as Alpine builds it, apk
# with lazy repositories and command-not-found installs, qemu-user for
# foreign binaries, the curl and bwrap shims, the X.Org config. The kw guest
# tools, the runtime its init calls (/usr/lib/kw/) and the overlay root's
# boot logic come from the base. An `apk add` that was cut off needs no
# cleanup: run it again, and apk replaces what it left. The files unkernel
# adds are in rootfs/, at their installed paths (guest/lib/stage.sh:
# install_tree).
#
#   /sbin/init                busybox init (the minirootfs's), etc/inittab:
#                             the kw layer's rc, welcome and net (/usr/lib/kw/),
#                             the qemu-user binfmt formats, a shell on hvc0
#                             and kwtty serve (respawned); the layer's
#                             shutdown at poweroff
#   /usr/lib/kw-distro        "alpine"
#   /usr/lib/kw-image         alpine-<version>-<hash of the tree>
#
# OpenSSL's engines, legacy.so and *.dist stay (the image is not
# RAM-resident), and the image stays what apk installed (`apk audit`
# clean). Packages beyond the minirootfs come from apk on first use (the
# kw layer's shim installs libgcc for node, for instance).
# ALPINE_TARBALL=file overrides the pinned release (pins.sh).
set -euo pipefail

. "$(dirname "$0")/../../lib/env.sh"   # root, build, guest, dl, fetch_verified
. "$guest/lib/stage.sh"                # distro_unpack, install_tree, install_common
. "$guest/lib/image.sh"                # distro_images
. "$guest/distro/alpine/pins.sh"       # ALPINE_*
umask 022
here="$guest/distro/alpine"

distro_unpack alpine ALPINE   # $stage, $ALPINE_TARBALL
# apk starts with main only. Every apk command that loads the indexes parses
# all of them, and community (21k packages to main's 6k) makes that ~2.7 s
# instead of ~0.65 s under kwemu. Its line moves to /etc/kw-apk-lazy, and
# /etc/kw-apk-enable adds it back the first time something needs it
# (kw-apk-install, kw-qemu).
r="$stage/etc/apk/repositories"
grep '/community$' "$r" > "$stage/etc/kw-apk-lazy" || { echo "alpine: no community line in $r" >&2; exit 1; }
grep -v '/community$' "$r" > "$r.kw" && cat "$r.kw" > "$r" && rm "$r.kw"

install_tree "$here/rootfs" "$stage"
install_common "$stage"
echo 'hvc0' >> "$stage/etc/securetty"

distro_images alpine "$stage" "$ALPINE_TARBALL" "alpine-$ALPINE_VERSION"
