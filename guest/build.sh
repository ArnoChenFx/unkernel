#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Build the guest side of unkernel (layout and conventions: README.md).
#
#   guest/build.sh base               the base initramfs, base.cpio and
#                                     base-test.cpio (base/build.sh);
#                                     kernel/build.sh base runs this and
#                                     bundles it into unkernel.wasm
#   guest/build.sh distro [NAME...]   the distro images NAME.erofs and
#                                     NAME.ext4 (distro/NAME/build.sh),
#                                     default: every distro; then index
#   guest/build.sh index              distros.json next to the images: the
#                                     index of every image there, with the
#                                     base bundle's ABI and base id
#                                     (tools/distros-json.mjs)
#   guest/build.sh opt [NAME [ARG...]]  a distro's package rebuild
#                                     (distro/NAME/opt/build.sh ARG...),
#                                     default: every distro that has one
#   guest/build.sh list               the distros and their pinned versions
#
# A distro is a directory distro/NAME/ with build.sh and pins.sh; nothing
# here lists them. Environment (see README.md): KW_BUILD, KW_BASE_OUT,
# KW_DISTRO_OUT, KW_DISTRO_FORMATS, KW_EROFS_COMPRESS, KW_EROFS_OPTS,
# KW_RELEASE, NAME_TARBALL=file. A distro's build.sh gets KW_DISTRO (its
# name) and KW_DISTRO_DIR (its directory).
set -euo pipefail

guest="$(cd "$(dirname "$0")" && pwd)"
what="${1:-}"
[ $# = 0 ] || shift

distros() {
	local d
	for d in "$guest"/distro/*/build.sh; do
		d=${d%/build.sh}
		echo "${d##*/}"
	done
}

# run_distro NAME: build its images.
run_distro() {
	local d="$guest/distro/$1"
	[ -f "$d/build.sh" ] && [ -f "$d/pins.sh" ] ||
		{ echo "guest/build.sh: no distro '$1' (have: $(distros | tr '\n' ' '))" >&2; exit 2; }
	KW_DISTRO="$1" KW_DISTRO_DIR="$d" "$d/build.sh"
}

# index: distros.json in the distro output directory (KW_DISTRO_OUT, else
# $KW_BUILD/distro), for the base bundle of KW_BASE_OUT (else
# $KW_BUILD/bundle/unkernel.wasm).
index() {
	(
		. "$guest/lib/env.sh"   # build, base_bundle
		local out
		out="$(realpath -m "${KW_DISTRO_OUT:-$build/distro}")"
		mkdir -p "$out"
		node "$guest/tools/distros-json.mjs" "$out" --bundle "$base_bundle"
	)
}

case $what in
base) "$guest/base/build.sh" ;;
distro)
	[ $# -gt 0 ] || set -- $(distros)
	for n; do run_distro "$n"; done
	index
	;;
index) index ;;
opt)
	if [ $# -gt 0 ]; then
		n=$1
		shift
		[ -x "$guest/distro/$n/opt/build.sh" ] || { echo "guest/build.sh: distro '$n' has no opt/build.sh" >&2; exit 2; }
		"$guest/distro/$n/opt/build.sh" "$@"
	else
		for n in $(distros); do
			[ ! -x "$guest/distro/$n/opt/build.sh" ] || "$guest/distro/$n/opt/build.sh"
		done
	fi
	;;
list)
	for n in $(distros); do
		v=$(N=$(echo "$n" | tr a-z A-Z); . "$guest/distro/$n/pins.sh"; eval echo "\${${N}_VERSION:-?}")
		echo "$n $v"
	done
	;;
*)
	echo "usage: guest/build.sh base | distro [NAME...] | index | opt [NAME [ARG...]] | list" >&2
	exit 2
	;;
esac
