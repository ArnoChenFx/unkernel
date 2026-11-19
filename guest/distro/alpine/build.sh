#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# The Alpine distro image: vendor/build/distro/alpine.erofs and alpine.ext4
# (guest/lib/image.sh), the read-only root that the base initramfs mounts
# under the root overlay: the aarch64 minirootfs, the packages opt/build.sh
# rebuilds for kwemu, ALPINE_PACKAGES (pins.sh), apk with lazy repositories
# and command-not-found installs, qemu-user for foreign binaries, the curl
# and bwrap shims, the X.Org config. The kw guest tools, the runtime its init calls
# (/usr/lib/kw/) and the overlay root's boot logic come from the base. An
# `apk add` that was cut off needs no cleanup: run it again, and apk
# replaces what it left. The files unkernel adds are in rootfs/, at their
# installed paths (guest/lib/stage.sh: install_tree).
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
# RAM-resident), and the image stays what apk installed (`apk audit` clean
# apart from the rebuilt packages).
# ALPINE_TARBALL=file overrides the pinned release (pins.sh);
# KW_ALPINE_OPT=0 keeps Alpine's builds (opt/build.sh).
set -euo pipefail

. "$(dirname "$0")/../../lib/env.sh"   # root, build, guest, dl, fetch_verified
. "$guest/lib/stage.sh"                # distro_unpack, install_tree, install_common
. "$guest/lib/image.sh"                # distro_images
. "$guest/distro/alpine/pins.sh"       # ALPINE_*
umask 022
here="$guest/distro/alpine"

distro_unpack alpine ALPINE   # $stage, $ALPINE_TARBALL
"$here/opt/build.sh" --install "$stage"
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

# --- in the image: the baked packages ----------------------------------------
# ALPINE_PACKAGES (pins.sh), installed by the image's own apk, as
# distro/debian/build.sh does with apt: the host fetches the pinned .apk
# files (checked against their SHA-256) into /kw-apks of a first image
# (erofs, uncompressed), which boots on the distroless bundle
# (guest/tools/vm-run.ts). apk adds them with no repositories and no network
# (their signatures checked against the image's keys), and /etc/apk/world
# gets their names (apk would pin the files' checksums there). What that
# created or changed in the root overlay's upper layer (a new ctime, from a
# listing before and after) comes out as a tar and goes into the tree, and
# what it deleted (whiteouts) is deleted there; mktree.py then gives the new
# files root:root and the upstream epoch. Without the bundle the image has
# none of them.
kernel=$base_bundle
gen=alpine-apkgen
if [ ! -f "$kernel" ] || ! command -v node >/dev/null; then
	echo "alpine: WARNING: no $kernel (kernel/build.sh base) or no node: the image has not" $ALPINE_PACKAGES >&2
else
	mkdir "$stage/kw-apks"
	names=
	while read -r sum name; do
		[ -n "$name" ] || continue
		fetch_verified "$ALPINE_MAIN_URL/$name.apk" "$dl/apk/$name.apk" "$sum"
		cp "$dl/apk/$name.apk" "$stage/kw-apks/"
		names+=" ${name%-*-*}"
	done <<< "$ALPINE_PACKAGES"
	echo "alpine: installing$names in the image" >&2
	(KW_DISTRO_FORMATS=erofs KW_EROFS_COMPRESS=none KW_DISTRO_HINT=0 \
		distro_images "$gen" "$stage" "$ALPINE_TARBALL" "alpine-$ALPINE_VERSION") >/dev/null
	node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$gen.erofs" --timeout 300 \
		--get /tmp/kw-pkgs.tar="$distro_out/$gen.pkgs.tar" --get /tmp/kw-gone="$distro_out/$gen.gone" "
		set -e
		u=/run/kw-lower/kw/tmp/upper
		[ -d \$u ]
		snap() { (cd \$u && find . -mindepth 1 -exec stat -c '%Z %n' {} + | sort); }
		snap > /tmp/kw-before
		sleep 1   # a change now gets a ctime that is not in the listing
		cp /etc/apk/world /tmp/kw-world
		apk add -q --no-progress --no-network --repositories-file /dev/null /kw-apks/*.apk > /tmp/kw-log 2>&1 ||
			{ cat /tmp/kw-log; exit 1; }
		apk info -e$names > /dev/null
		{ cat /tmp/kw-world; printf '%s\n'$names; } | sort -u > /etc/apk/world
		snap | awk 'NR == FNR { had[\$0]; next } !(\$0 in had) { sub(/^[0-9]+ /, \"\"); print }' /tmp/kw-before - |
			grep -v -e '^\./var/log/' -e '^\./kw-apks' -e '^\./lib/apk/db/lock\$' > /tmp/kw-new || true
		cd \$u
		: > /tmp/kw-gone; : > /tmp/kw-list
		while IFS= read -r p; do if [ -c \"\$p\" ]; then echo \"\$p\" >> /tmp/kw-gone; else echo \"\$p\" >> /tmp/kw-list; fi; done < /tmp/kw-new
		tar -cf /tmp/kw-pkgs.tar -T /tmp/kw-list --no-recursion --numeric-owner" ||
		{ echo "alpine: installing$names in the image failed" >&2; exit 1; }
	rm -rf "$stage/kw-apks"
	while read -r p; do rm -rf "${stage:?}/${p#./}"; done < "$distro_out/$gen.gone"
	tar -xpf "$distro_out/$gen.pkgs.tar" -C "$stage" --no-same-owner
	rm -f "$distro_out/$gen".{erofs,tar,id,debugfs,pkgs.tar,gone}
fi

distro_images alpine "$stage" "$ALPINE_TARBALL" "alpine-$ALPINE_VERSION"
