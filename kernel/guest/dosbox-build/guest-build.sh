#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# dosbox-build [--remove-compiler]: build DOSBox 0.74-3 (GPL-2.0-or-later)
# here, in the unkernel guest, against a static SDL 1.2 (LGPL-2.1-or-later)
# with its fbcon video driver, for the `dosbox` command (kernel/guest/dosbox),
# which then runs this build instead of downloading dosbox-riscv64.tar.gz.
# The guest-side twin of build.sh next to it: the same sources, patches and
# configure options, built with Alpine's g++ instead of a zig cross build.
#
# - installs g++, make, musl-dev, linux-headers and patch with apk (main;
#   about 60 MiB to download, 250 MiB installed),
# - downloads SDL 1.2 at a pinned commit (a GitHub archive) and the DOSBox
#   0.74-3 release tarball, both sha256-pinned,
# - applies the patches in /usr/share/unkernel/dosbox-build (sdl-*.patch to
#   SDL, dosbox-*.patch to DOSBox; build.sh lists what they do),
# - configures and compiles both, links DOSBox statically and installs it
#   as DIR/dosbox/dosbox, where the dosbox command looks for it.
# DIR is the dosbox command's: /data/dosbox with the persistent data disk,
# else /var/lib/dosbox; DOSBOX_DIR overrides it. The compiler goes wherever
# apk installs (with the data disk: the overlay root, so it persists).
# DIR/.built holds a hash of the sources, the flags and the patches: a run
# with the same ones returns at once, other ones rebuild.
#   dosbox-build --remove-compiler   apk del the packages the build installed

sdl_commit=81490298a02fe6806c05ac7b5afde7d88fcc7bf9   # main, 2026-10-15
sdl_url=https://github.com/libsdl-org/SDL-1.2/archive/$sdl_commit.tar.gz
sdl_sha256=7b6f01594a13388be2bc55b4c5c54e524d2860ec036b2c51a2c207842e10d667
dosbox_url=https://downloads.sourceforge.net/project/dosbox/dosbox/0.74-3/dosbox-0.74-3.tar.gz
dosbox_sha256=c0d13dd7ed2ed363b68de615475781e891cd582e8162b5c3669137502222260a
patch_dir=/usr/share/unkernel/dosbox-build
cc_pkgs="g++ make musl-dev linux-headers patch"
# -O1: g++ under the guest's CPU emulator is the slow part of the first run;
# -O2 costs more time and memory for little more speed in DOSBox.
cflags=${DOSBOX_CFLAGS:--O1}
need_kib=262144    # sources and objects, with some room
cc_kib=307200      # the compiler where apk installs

gray=$(printf '\033[90m') reset=$(printf '\033[0m')
[ -t 1 ] || gray= reset=
say() {
	echo "${gray}dosbox-build: $*${reset}"
}
die() {
	echo "dosbox-build: $*" >&2
	exit 1
}

if [ -n "$DOSBOX_DIR" ]; then
	dir=$DOSBOX_DIR
	keep=
elif mountpoint -q /data 2>/dev/null && [ -w /data ]; then
	dir=/data/dosbox
	keep=
else
	dir=/var/lib/dosbox
	keep=" (no data disk: kept only until power off)"
fi

if [ "$1" = --remove-compiler ]; then
	pkgs=$(cat "$dir/.compiler-added" 2>/dev/null)
	[ -n "$pkgs" ] || { echo "dosbox-build: the build installed no packages"; exit 0; }
	apk del -q --no-progress $pkgs && rm -f "$dir/.compiler-added" && echo "dosbox-build: removed $pkgs"
	exit
fi

ls "$patch_dir"/*.patch >/dev/null 2>&1 || die "no patches in $patch_dir"
stamp=$( { echo "$sdl_sha256 $dosbox_sha256 $cflags"; cat "$patch_dir"/*.patch; } | sha256sum | cut -c1-64)
[ "$(cat "$dir/.built" 2>/dev/null)" = "$stamp" ] && [ -x "$dir/dosbox/dosbox" ] && exit 0

mkdir -p "$dir" || die "cannot create $dir"
cd "$dir" || exit 1
rm -rf .build
mkdir .build || die "cannot write to $dir"

missing=
for p in $cc_pkgs; do
	apk info -e "$p" >/dev/null 2>&1 || missing="$missing $p"
done
free_kib() {
	df -Pk "$1" | awk 'NR == 2 && $2 > 0 { print $4 }'
}
need=$need_kib
need_cc=0
[ -n "$missing" ] && need_cc=$cc_kib
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
	die "no network: the build downloads a compiler and the sources"

# fetch URL FILE SHA256
fetch() {
	q=-q
	[ -t 2 ] && q=
	wget $q -O "$2" "$1" || die "download failed: $1 (network or server problem)"
	set -- "$1" "$2" "$3" $(sha256sum "$2")
	[ "$4" = "$3" ] || die "checksum mismatch for $1: expected $3, got $4"
}

jobs=$(nproc 2>/dev/null || echo 1)
start=$(date +%s)
echo "dosbox-build: building DOSBox here with g++ $cflags, into $dir$keep"
echo "dosbox-build: this compiles about 250 files and takes a long time"
step=0
steps=5
[ -n "$missing" ] && steps=6
next() {
	step=$((step + 1))
	say "[$step/$steps] $* ($(($(date +%s) - start)) s)"
}

if [ -n "$missing" ]; then
	next "installing the compiler:$missing (about 60 MiB to download)"
	if ! ls /var/cache/apk/APKINDEX.*.tar.gz >/dev/null 2>&1; then
		apk update -q --no-progress || die "apk update failed (network?)"
	fi
	apk add -q --no-progress $missing || die "apk add$missing failed"
	echo $missing $(cat .compiler-added 2>/dev/null) | tr ' ' '\n' | sort -u | tr '\n' ' ' > .compiler-added
fi

next "downloading SDL 1.2 (4 MiB) and DOSBox 0.74-3 (1.3 MiB)"
fetch "$sdl_url" .build/sdl.tar.gz $sdl_sha256
fetch "$dosbox_url" .build/dosbox.tar.gz $dosbox_sha256
mkdir .build/sdl .build/dosbox
tar -xzf .build/sdl.tar.gz -C .build/sdl --strip-components=1 &&
	tar -xzf .build/dosbox.tar.gz -C .build/dosbox --strip-components=1 ||
	die "cannot unpack the sources (out of space?)"
rm .build/sdl.tar.gz .build/dosbox.tar.gz
for p in "$patch_dir"/sdl-*.patch; do
	patch -s -p1 -d .build/sdl <"$p" || die "patch ${p##*/} does not apply"
done
for p in "$patch_dir"/dosbox-*.patch; do
	[ -e "$p" ] || continue
	patch -s -p1 -d .build/dosbox <"$p" || die "patch ${p##*/} does not apply"
done

# The logs stay in DIR/.build when a step fails.
prefix=$dir/.build/sdl-prefix
next "configuring SDL 1.2"
(
	cd .build/sdl && ./configure --prefix="$prefix" \
		--disable-shared --enable-static --disable-rpath CFLAGS="$cflags" \
		--disable-video-x11 --disable-video-dga --disable-video-directfb \
		--disable-video-ggi --disable-video-svga --disable-video-vgl \
		--disable-video-wscons --disable-video-opengl --disable-video-aalib \
		--disable-video-caca --disable-video-qtopia --disable-video-picogui \
		--disable-video-photon --disable-video-ps3 \
		--enable-video-fbcon --enable-video-dummy \
		--disable-alsa --disable-esd --disable-pulseaudio --disable-arts \
		--disable-nas --disable-sndio --disable-diskaudio \
		--enable-dummyaudio --enable-oss \
		--disable-input-tslib --disable-loadso >configure.log 2>&1
) || die "configuring SDL failed (see $dir/.build/sdl/configure.log)"
next "compiling SDL 1.2"
(cd .build/sdl && make -j"$jobs" >make.log 2>&1 && make install >>make.log 2>&1) ||
	die "compiling SDL failed (see $dir/.build/sdl/make.log)"

next "configuring DOSBox"
(
	cd .build/dosbox && ./configure --prefix=/usr \
		CFLAGS="$cflags" CXXFLAGS="$cflags -std=gnu++11 -w" LDFLAGS="-static -s" \
		--with-sdl-prefix="$prefix" --disable-opengl --disable-dynamic-x86 \
		--disable-fpu-x86 --disable-alsa-midi --disable-debug >configure.log 2>&1
) || die "configuring DOSBox failed (see $dir/.build/dosbox/configure.log)"
next "compiling DOSBox"
(cd .build/dosbox && make -j"$jobs" >make.log 2>&1) ||
	die "compiling DOSBox failed (see $dir/.build/dosbox/make.log)"

mkdir .build/new
cp .build/dosbox/src/dosbox .build/dosbox/COPYING "$patch_dir"/*.patch .build/new/ &&
	cat >.build/new/README <<EOF || die "cannot write to $dir"
DOSBox 0.74-3 for riscv64 Linux (static, musl), built in this guest by
dosbox-build with g++ $cflags, with SDL 1.2 (fbcon video) linked in.
Sources: $dosbox_url (sha256 $dosbox_sha256)
         $sdl_url (sha256 $sdl_sha256)
plus the patches here.
Licenses: DOSBox GNU GPL version 2 or later (COPYING); SDL 1.2 GNU LGPL
version 2.1 or later.
EOF
rm -rf dosbox .installed .built
mv .build/new dosbox || die "cannot write to $dir"
echo "$stamp" >.built
rm -rf .build
sync
echo "dosbox-build: built in $(($(date +%s) - start)) s: $dir/dosbox/dosbox"
[ -s .compiler-added ] &&
	echo "dosbox-build: the compiler stays installed; 'dosbox-build --remove-compiler' removes it ($(cat .compiler-added))"
exit 0
