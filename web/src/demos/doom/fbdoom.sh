#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# fbdoom [fbDOOM options]: Doom on /dev/fb0 (the page's display, or the
# CLI's --display), with sound effects on /dev/dsp; installed as
# /usr/bin/fbdoom.
#
# The first run builds the game here, in the guest, then starts it; later
# runs start at once:
# - installs a C compiler with apk (Alpine) or apt-get (Debian): tcc by
#   default, about 8 MiB to download; FBDOOM_CC=gcc or clang works too, if
#   slower to get,
# - downloads fbDOOM's source at a pinned commit (github.com/maximevince/
#   fbDOOM, GPL-2.0-or-later), checks its sha256, applies the patches in
#   /usr/share/unkernel/fbdoom (web/src/demos/doom/patches) and compiles it,
# - downloads the Freedoom 0.13.0 release zip (BSD-3-Clause), of which
#   freedoom1.wad (Phase 1) and its COPYING.txt are kept.
# Everything goes to /data/fbdoom when the persistent data disk is mounted
# (kept across boots, safe mode, kw-overlay discard and image updates), else to
# /var/lib/fbdoom (gone at power off); FBDOOM_DIR overrides the place.
# The compiler goes wherever the package manager installs (with the data
# disk: the overlay root, so it persists too). Settings and saves are in
# DIR/.fbdoom/.
#   fbdoom --remove-compiler   remove the packages the build installed
#   fbdoom --remove            delete DIR (the game, the WAD, saves)
# A new image with other patches rebuilds the game at the next run.
#
# Keys: an evdev keyboard (the page, the CLI's {key=...}) with real
# presses and releases, else the console: arrows move, Ctrl fires (f on the
# console), Space opens doors, Alt strafes (, and . on the console), Shift
# runs, Tab shows the map, Esc is the menu, Enter selects; on the console a
# key counts as held for 0.3 s (no releases there). Ctrl-C on the console
# quits, as does the menu's Quit Game.
# Extra arguments go to fbDOOM (-warp 1 1, -skill 3, -nosound, -fbmode WxH
# or -fbmode 0, ...); with -iwad, that WAD replaces Freedoom.

src_commit=e52885ff8a4cba99586c33b09339a9a56a69c041
src_url=https://github.com/maximevince/fbDOOM/archive/$src_commit.tar.gz
src_sha256=216901bd4afeb0d37fd0100e986c909d8b4300d9c4eb9feeabe569b1e8b0551e
patch_dir=/usr/share/unkernel/fbdoom
wad_url=https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
wad_sha256=3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
wad_zip_dir=freedoom-0.13.0
wad_kib=55296    # zip 23.6 MiB + WAD 27.5 MiB, with some room

cc=${FBDOOM_CC:-tcc}
case $cc in
tcc) cc_flags= cc_kib=40960 cc_mib=8 ;;
gcc) cc_flags="-O2 -std=gnu99" cc_kib=256000 cc_mib=78 ;;
clang) cc_flags="-O2 -std=gnu99" cc_kib=307200 cc_mib=108 ;;
*) echo "fbdoom: FBDOOM_CC must be tcc, gcc or clang" >&2; exit 2 ;;
esac
# The packages: Alpine's (apk) or Debian's (apt-get; libc6-dev brings the
# kernel's headers, linux-libc-dev).
if command -v apk >/dev/null; then
	pm=apk
	case $cc in
	tcc) cc_pkgs="tcc tcc-libs-static musl-dev linux-headers patch" ;;
	gcc) cc_pkgs="gcc musl-dev linux-headers patch" ;;
	clang) cc_pkgs="clang21 linux-headers patch" ;;
	esac
	pkg_installed() { apk info -e "$1" >/dev/null 2>&1; }
	pkg_remove() { apk del -q --no-progress "$@"; }
else
	pm=apt-get
	case $cc in
	tcc) cc_pkgs="tcc libc6-dev patch" ;;
	gcc) cc_pkgs="gcc libc6-dev patch" ;;
	clang) cc_pkgs="clang libc6-dev patch" ;;
	esac
	pkg_installed() { [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = installed ]; }
	pkg_remove() { apt-get remove -y -q "$@" </dev/null >/dev/null; }
fi

gray=$(printf '\033[90m') reset=$(printf '\033[0m')
[ -t 1 ] || gray= reset=
say() {
	echo "${gray}fbdoom: $*${reset}"
}
die() {
	echo "fbdoom: $*" >&2
	exit 1
}

if [ -n "$FBDOOM_DIR" ]; then
	dir=$FBDOOM_DIR
	keep=
elif mountpoint -q /data 2>/dev/null && [ -w /data ]; then
	dir=/data/fbdoom
	keep=
else
	dir=/var/lib/fbdoom
	keep=" (no data disk: kept only until power off)"
fi

case $1 in
--remove)
	rm -rf "$dir" && echo "fbdoom: removed $dir"
	exit ;;
--remove-compiler)
	pkgs=$(cat "$dir/.compiler-added" 2>/dev/null)
	[ -n "$pkgs" ] || { echo "fbdoom: the build installed no packages"; exit 0; }
	pkg_remove $pkgs && rm -f "$dir/.compiler-added" && echo "fbdoom: removed $pkgs"
	exit ;;
esac

[ -c /dev/fb0 ] || die "no /dev/fb0: the host gives this system no display (CLI: --display)"

# Each part is (re)made when it is missing or this script names another
# version of it: the game by the source, the patches and the compiler.
bin_stamp=$( { echo "$src_sha256 $cc $cc_flags"; cat "$patch_dir"/*.patch; } 2>/dev/null | sha256sum | cut -c1-64)
get_bin=
get_wad=
[ "$(cat "$dir/.bin-stamp" 2>/dev/null)" = "$bin_stamp" ] && [ -x "$dir/fbdoom" ] || get_bin=1
[ "$(cat "$dir/.wad-sha256" 2>/dev/null)" = $wad_sha256 ] && [ -s "$dir/freedoom1.wad" ] || get_wad=1

if [ -n "$get_bin$get_wad" ]; then
	ls "$patch_dir"/*.patch >/dev/null 2>&1 || die "no patches in $patch_dir"
	mkdir -p "$dir" || die "cannot create $dir"
	cd "$dir" || exit 1
	rm -rf .part
	mkdir .part || die "cannot write to $dir"

	# Space: the compiler where packages install (/), the build and the WAD in DIR.
	need_cc=0
	missing=
	if [ -n "$get_bin" ]; then
		for p in $cc_pkgs; do
			pkg_installed "$p" || missing="$missing $p"
		done
		[ -n "$missing" ] && need_cc=$cc_kib
	fi
	need=4096
	[ -n "$get_bin" ] && need=$((need + 16384))
	[ -n "$get_wad" ] && need=$((need + wad_kib))
	free_kib() {
		df -Pk "$1" | awk 'NR == 2 && $2 > 0 { print $4 }'
	}
	if [ "$(df -P / | awk 'NR == 2 { print $6 }')" = "$(df -P . | awk 'NR == 2 { print $6 }')" ]; then
		need=$((need + need_cc))
		need_cc=0
	fi
	avail=$(free_kib .)
	[ -n "$avail" ] && [ "$avail" -lt $need ] &&
		die "not enough space in $dir: $((avail / 1024)) MiB free, $((need / 1024)) MiB needed"
	avail=$(free_kib /)
	[ $need_cc -gt 0 ] && [ -n "$avail" ] && [ "$avail" -lt $need_cc ] &&
		die "not enough space for the compiler on /: $((avail / 1024)) MiB free, $((need_cc / 1024)) MiB needed"
	ip route 2>/dev/null | grep -q '^default' ||
		die "no network: the first run downloads a compiler, fbDOOM's source and Freedoom"

	# fetch URL FILE SHA256
	fetch() {
		# wget (Alpine) or curl (Debian) shows its progress on a terminal (the
		# WAD is 24 MiB, and the page's network may be slow).
		if command -v wget >/dev/null; then
			q=-q
			[ -t 2 ] && q=
			get() { wget $q -O "$2" "$1"; }
		else
			q=-sS
			[ -t 2 ] && q=-#
			get() { curl -fL $q -o "$2" "$1"; }
		fi
		get "$1" "$2" || {
			rm -rf .part
			die "download failed: $1 (network or server problem)"
		}
		set -- "$1" "$2" "$3" $(sha256sum "$2")
		[ "$4" = "$3" ] || {
			rm -rf .part
			die "checksum mismatch for $1: expected $3, got $4"
		}
	}

	if [ -n "$get_bin" ]; then
		echo "fbdoom: first run: building fbDOOM here with $cc, into $dir$keep"
		if [ $cc = tcc ]; then
			echo "fbdoom: about 33 MiB to download and 81 files to compile: half a minute to a few minutes"
		else
			echo "fbdoom: compiling with $cc takes 10 minutes or more"
		fi
	else
		echo "fbdoom: getting Freedoom into $dir$keep"
	fi
	step=0
	steps=0
	[ -n "$get_bin" ] && steps=3 && [ -z "$missing" ] && steps=2
	[ -n "$get_wad" ] && steps=$((steps + 1))
	next() {
		step=$((step + 1))
		say "[$step/$steps] $*"
	}

	if [ -n "$get_bin" ]; then
		if [ -n "$missing" ]; then
			next "installing the compiler:$missing (about $cc_mib MiB to download)"
			if [ $pm = apk ]; then
				# tcc is in community, which the image leaves off until needed.
				[ $cc != tcc ] || [ ! -x /etc/kw-apk-enable ] || /etc/kw-apk-enable
				if ! ls /var/cache/apk/APKINDEX.*.tar.gz >/dev/null 2>&1; then
					apk update -q --no-progress || die "apk update failed (network?)"
				fi
				apk add -q --no-progress $missing || die "apk add$missing failed"
			else
				# The image's package lists are baked in and age: when a version
				# is gone from the mirror, fetch them again and retry once.
				inst() { apt-get install -y -q --no-install-recommends $missing </dev/null; }
				inst || { apt-get update -q </dev/null && inst; } || die "apt-get install$missing failed"
			fi
			# Remember what was added for this, for --remove-compiler.
			echo $missing $(cat .compiler-added 2>/dev/null) | tr ' ' '\n' | sort -u | tr '\n' ' ' > .compiler-added
		fi
		next "downloading fbDOOM's source (0.5 MiB)"
		fetch "$src_url" .part/src.tar.gz $src_sha256
		tar -xzf .part/src.tar.gz -C .part || die "cannot unpack the source (out of space?)"
		src=.part/fbDOOM-$src_commit
		for p in "$patch_dir"/*.patch; do
			patch -s -p1 -d "$src" < "$p" || die "patch ${p##*/} does not apply"
		done
		srcs="i_video_fbdev.c i_input_tty.c i_sound_oss.c $(sed -n 's/^SRC_DOOM = //p' "$src/fbdoom/Makefile" | sed 's/\.o/.c/g')"
		n=$(echo $srcs | wc -w)
		next "compiling $n files with $cc"
		i=0
		start=$(date +%s)
		for f in $srcs; do
			i=$((i + 1))
			[ -t 1 ] && printf '\r%s  %d/%d %-20s%s' "$gray" $i $n "$f" "$reset"
			(cd "$src/fbdoom" && $cc $cc_flags -DNORMALUNIX -DLINUX -w -c "$f" -o "${f%.c}.o") ||
				die "compiling $f failed"
		done
		[ -t 1 ] && printf '\r%-40s\r' ''
		(cd "$src/fbdoom" && $cc -o fbdoom $(for f in $srcs; do printf '%s ' "${f%.c}.o"; done) -lm) ||
			die "linking failed"
		say "compiled in $(($(date +%s) - start)) s"
		rm -rf fbdoom .bin-stamp .bin-sha256
		mv "$src/fbdoom/fbdoom" fbdoom || die "cannot write to $dir"
		echo "$bin_stamp" > .bin-stamp
		rm -rf .part/src.tar.gz "$src"
	fi
	if [ -n "$get_wad" ]; then
		next "downloading Freedoom (24 MiB) and unpacking freedoom1.wad"
		fetch "$wad_url" .part/wad.zip $wad_sha256
		mkdir .part/new
		unzip -q -o -j .part/wad.zip "$wad_zip_dir/freedoom1.wad" "$wad_zip_dir/COPYING.txt" \
			-d .part/new || die "cannot unpack freedoom1.wad (out of space?)"
		[ -s .part/new/freedoom1.wad ] || die "the Freedoom zip holds no freedoom1.wad"
		rm -f freedoom1.wad .wad-sha256
		mv .part/new/COPYING.txt freedoom-COPYING.txt &&
			mv .part/new/freedoom1.wad . || die "cannot write to $dir"
		echo $wad_sha256 > .wad-sha256
	fi
	rm -rf .part
	sync
	[ -s .compiler-added ] &&
		echo "fbdoom: ready. The compiler stays installed; 'fbdoom --remove-compiler' removes it ($(cat .compiler-added))"
fi

case " $* " in
*" -iwad "*) ;;
*) set -- -iwad "$dir/freedoom1.wad" "$@" ;;
esac
cd "$dir" || exit 1
# HOME: fbDOOM keeps default.cfg and the saves in $HOME/.fbdoom.
# -mb 16: Chocolate Doom's zone size (fbDOOM's default of 6 MiB is small
# for Freedoom's maps).
HOME=$dir exec ./fbdoom -mb 16 "$@"
