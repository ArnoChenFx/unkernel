#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#
# The Alpine packages on the guest's hot paths, rebuilt for kwemu's CPU:
# busybox, zlib, openssl (libcrypto3, libssl3) and apk-tools (libapk, apk).
# Same source, patches and configuration as the image's packages (aports at
# the commit recorded for each in the image's apk database), built as their
# APKBUILDs build them, except:
#   - gcc 16 (Bootlin's riscv64 musl toolchain, used with a sysroot of
#     Alpine's own packages: musl-dev is the image's musl) at -O2 for rv64gc
#     + Zba/Zbb/Zbs/Zicond, where Alpine uses gcc 15 at -Os (busybox: -Oz
#     and -finline-limit=0) for rv64gc;
#   - linked with lld, not GNU ld (whose one R+X segment for code and
#     read-only data makes each exec ~0.5 ms slower under kwemu), with RELR
#     relocations; busybox is not PIE (apk is, as in Alpine).
# Numbers, traps and the update procedure: .agents/guest-packages.md.
#
#   kernel/guest/alpine-opt.sh                 build all (again)
#   kernel/guest/alpine-opt.sh PKG...          build some (busybox zlib openssl apk-tools)
#   kernel/guest/alpine-opt.sh --install STAGE put the files into a root fs
#                                              stage (alpine.sh, alpine-disk.sh);
#                                              builds first if out of date
#
# KW_ALPINE_OPT=0 keeps Alpine's builds (--install does nothing); so does a
# stage from an ALPINE_TARBALL override whose versions differ. Building
# needs an x86_64 host (the gcc toolchain).
#
# Output: vendor/build/alpine-opt/root/ (installed files, as in the image;
# the build trees are under vendor/build/alpine-opt/src/). zlib and openssl
# also go into vendor/build/alpine-opt/sysroot, which apk-tools builds
# against. --install refuses a stage whose apk database lists other
# versions of these packages (after an Alpine update: update the commits
# and hashes below).

set -euo pipefail
. "$(dirname "$0")/../tools/env.sh"   # root, vendor, zig, fetch_verified, need_zig
need_zig

# aports commit and APKBUILD sha256 per package. The APKBUILD lists the
# sources with their sha512sums, which are checked.
declare -A commit=(
	[busybox]=c3ef5d10e6ef6528852c51f0564963e2f8c1be19
	[zlib]=0afa2da0e8c8051c6f8f64a7a388e5a259904245
	[openssl]=29b9ec24b1b5b39aeef51fa2a044210e2ec5258e
	[apk-tools]=13685e8f2cf1c103cbba2fb9efcfcf19f4918df0
)
declare -A apkbuild_sha256=(
	[busybox]=98f019f62291aff63cb798f046fb59dfd43340885de63ca2f127651fc21d0450
	[zlib]=c9348892bf3857602fe74fcc1d411e263b408b7d70344170396f5993a62bbe26
	[openssl]=ea459c051ee8d846c06f1d47d09d0f737778502c01de88c9696e96a208de5943
	[apk-tools]=092d5c1a4957bf585a4c9d27a7c68cfa07e54cffeac57b1eec154675d54d50b0
)
pkgs="busybox zlib openssl apk-tools"
# The sysroot: Alpine packages of the image's release (musl is the image's).
APK_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/main/riscv64"
apks="
f21b18f22a511de1e57f70112f761d0daad0c7d74e0734a82fcd5e037387dbb4 musl-1.2.6-r3
f47066d861413b3d76fe200240ea2919cdf807f82770d574a16d10dbd6b56ad7 musl-dev-1.2.6-r3
0b5173b68b701e09c2b1182a238186d87d5956e8474d50dcd8448ea8be1d7aca linux-headers-7.0.0-r1
4f3cb0e704bb9379f1e7c3f60da834b85cc7b2eb2e4b3826cf2017123f745431 utmps-dev-0.1.3.3-r0
777aaa8ad61618418bdcb59b8c37802555620816c43bc76dc3cad305a61630e2 utmps-static-0.1.3.3-r0
df7862d2f21045b0063821f0d8a22e28bb888d0b2f10c67555f456b9579b74e2 skalibs-dev-2.15.0.0-r0
8c1ba6e5644f54fe2ef735ff0f45af708a1e9c7cefa9ca0266a5187084bce12e skalibs-static-2.15.0.0-r0
"
# gcc 16.2.0, binutils 2.46.1, for x86_64 hosts.
GCC_TC=riscv64-lp64d--musl--bleeding-edge-2026.08-1
GCC_TC_URL="https://toolchains.bootlin.com/downloads/releases/toolchains/riscv64-lp64d/tarballs/$GCC_TC.tar.xz"
GCC_TC_SHA256=f8d96c08c00141280103aaf17ed7c19ccbc9b79a35baf94ede05e7f97f37182a

OPT_CFLAGS="-O2 -march=rv64gc_zba_zbb_zbs_zicond -mabi=lp64d"
# --undefined-version: lld rejects version scripts naming symbols a link
# does not define, which GNU ld allows (zlib's configure test does that).
OPT_LDFLAGS="-Wl,--as-needed,-O1,--sort-common -Wl,-z,pack-relative-relocs -Wl,--undefined-version"

dl="$vendor/downloads/alpine-opt"
b="$vendor/build/alpine-opt"
dest="$b/root"
sysroot="$b/sysroot"
jobs="-j${JOBS:-$(nproc)}"
# A change to this script or to the Alpine release means a rebuild.
stamp="$(sha256sum < "${BASH_SOURCE[0]}" | cut -c1-16)-$ALPINE_VERSION"

# fetch PKG: the APKBUILD (pinned) and its sources (checked against its
# sha512sums); sets $srcs (the source list) and $ver (pkgver-rpkgrel).
# aports comes from its GitHub mirror (same commits): gitlab.alpinelinux.org
# answers raw file requests from GitHub's hosted runners with HTTP 418.
# Upstream sources fall back to Alpine's distfiles mirror, as abuild does
# (the builders' copies of them).
fetch() {
	local p=$1 s f u url="https://raw.githubusercontent.com/alpinelinux/aports/${commit[$1]}/main/$1"
	local mirror="https://distfiles.alpinelinux.org/distfiles/v${ALPINE_VERSION%.*}"
	mkdir -p "$dl/$p"
	fetch_verified "$url/APKBUILD" "$dl/$p/APKBUILD" "${apkbuild_sha256[$p]}"
	mapfile -t srcs < <(set +u; . "$dl/$p/APKBUILD"; for s in $source; do echo "$s"; done)
	ver=$(set +u; . "$dl/$p/APKBUILD"; echo "$pkgver-r$pkgrel")
	for s in "${srcs[@]}"; do
		case "$s" in
		https://*|http://*) f="$dl/$p/${s##*/}"; set -- "$s" "$mirror/${s##*/}" ;;
		*) f="$dl/$p/$s"; set -- "$url/$s" ;;
		esac
		[ -f "$f" ] && continue
		for u; do
			curl -fsSL --retry 3 -o "$f.part" "$u" && mv "$f.part" "$f" && break
			echo "alpine-opt: $u failed${2:+, trying the next source}" >&2
			shift
		done
		[ -f "$f" ] || { echo "alpine-opt: cannot download ${f##*/}" >&2; exit 1; }
	done
	(set +u; cd "$dl/$p" && . ./APKBUILD && echo "$sha512sums" | awk 'NF == 2' | sha512sum -c --quiet)
}

# unpack PKG TARBALL DIR: a fresh source tree with the APKBUILD's patches,
# in its order; cd into it.
unpack() {
	local p=$1 s
	rm -rf "$b/src/$3"
	mkdir -p "$b/src"
	tar -xf "$dl/$p/$2" -C "$b/src"
	for s in "${srcs[@]}"; do
		case "$s" in *.patch) patch -s -d "$b/src/$3" -p1 -i "$dl/$p/$s" ;; esac
	done
	cd "$b/src/$3"
}

setup() {
	mkdir -p "$b/bin/lld" "$dl"
	tc="$vendor/toolchain-gcc/$GCC_TC/bin/riscv64-linux"
	if [ ! -x "$tc-gcc" ]; then
		fetch_verified "$GCC_TC_URL" "$dl/$GCC_TC.tar.xz" "$GCC_TC_SHA256"
		rm -rf "$vendor/toolchain-gcc/$GCC_TC"
		mkdir -p "$vendor/toolchain-gcc"
		tar -xJf "$dl/$GCC_TC.tar.xz" -C "$vendor/toolchain-gcc"
	fi
	# .done holds the apk list, so a changed list rebuilds the sysroot.
	if [ "$(cat "$sysroot/.done" 2> /dev/null)" != "$(echo "$apks" | sha256sum)" ]; then
		rm -rf "$sysroot"
		mkdir -p "$sysroot"
		local sum name
		while read -r sum name; do
			[ -n "$name" ] || continue
			fetch_verified "$APK_URL/$name.apk" "$dl/apk/$name.apk" "$sum"
			tar -xzf "$dl/apk/$name.apk" -C "$sysroot" --exclude='.PKGINFO' \
				--exclude='.SIGN.*' --exclude='.pre-*' --exclude='.post-*' 2>/dev/null || true
		done <<< "$apks"
		echo "$apks" | sha256sum > "$sysroot/.done"
	fi
	# gcc against the sysroot, linking with zig's lld. The host compiler
	# (busybox's build tools) is zig cc, which finds the host's libc by
	# asking $CC, so its wrapper unsets that.
	printf '#!/bin/sh\nexec "%s" ld.lld "$@"\n' "$zig" > "$b/bin/lld/ld.lld"
	cat > "$b/bin/cc" <<-EOF
	#!/bin/sh
	exec "$tc-gcc" --sysroot="$sysroot" -fuse-ld=lld -B"$b/bin/lld/" "\$@"
	EOF
	printf '#!/bin/sh\nunset CC\nexec "%s" cc "$@"\n' "$zig" > "$b/bin/host-cc"
	chmod +x "$b/bin/cc" "$b/bin/host-cc" "$b/bin/lld/ld.lld"
	export CC="$b/bin/cc" AR="$tc-ar" RANLIB="$tc-ranlib" NM="$tc-nm" STRIP="$tc-strip"
	export CFLAGS="$OPT_CFLAGS" LDFLAGS="$OPT_LDFLAGS"
	# busybox and openssl embed a build time, and the image id (the overlay
	# root's key) hashes the files: a fixed time keeps a rebuild's output,
	# and so the id, the same.
	export SOURCE_DATE_EPOCH=1767225600   # 2026-01-01
}

build_busybox() {
	fetch busybox
	unpack busybox "busybox-${ver%-r*}.tar.bz2" "busybox-${ver%-r*}"
	# Makefile.flags forces -Oz and, for gcc, -finline-limit=0 and
	# -fno-guess-branch-probability; CONFIG_EXTRA_CFLAGS brings ours.
	local f=Makefile.flags n re='^CFLAGS \+= \$\(call cc-option,(-Oz,|-finline-limit=0,|-fno-guess-branch-probability,)'
	n=$(grep -c -E "$re" $f)
	[ "$n" = 4 ] || { echo "busybox: $f: expected 4 lines to drop, found $n" >&2; exit 1; }
	sed -i -E "/$re/d" $f
	local out="$b/src/busybox-build"
	rm -rf "$out"
	mkdir -p "$out"
	# The APKBUILD's dynamic build: busyboxconfig, utmps linked statically.
	sed -e 's/.*CONFIG_PIE.*/# CONFIG_PIE is not set/' "$dl/busybox/busyboxconfig" > "$out/.config"
	local mk=(make O="$out" $jobs CC="$CC" HOSTCC="$b/bin/host-cc" LD="$tc-ld"
		AR="$AR" STRIP="$STRIP"
		CONFIG_EXTRA_CFLAGS="$OPT_CFLAGS -fno-pie -I$sysroot/usr/include/utmps"
		CONFIG_EXTRA_LDFLAGS="$OPT_LDFLAGS -no-pie"
		CONFIG_EXTRA_LDLIBS="-L$sysroot/usr/lib -l:libutmps.a -l:libskarnet.a")
	CFLAGS= LDFLAGS= "${mk[@]}" silentoldconfig > /dev/null
	CFLAGS= LDFLAGS= "${mk[@]}"
	install -Dm755 "$out/busybox" "$dest/bin/busybox"
}

build_zlib() {
	fetch zlib
	unpack zlib "zlib-${ver%-r*}.tar.gz" "zlib-${ver%-r*}"
	./configure --prefix=/usr --shared --disable-crcvx
	make $jobs
	make install DESTDIR="$dest"
	make install DESTDIR="$sysroot"
	[ -e "$dest/usr/lib/libz.so.1" ] || { echo "zlib: no shared library" >&2; exit 1; }
}

build_openssl() {
	fetch openssl
	unpack openssl "openssl-${ver%-r*}.tar.gz" "openssl-${ver%-r*}"
	# As the APKBUILD's native build (threads on). sha256.c is built at
	# -Os, which runs faster under kwemu (16 MB sha256: 455 ms vs 500 with
	# -O2, stock 480; 2026-11-16); for sha1dgst.c and sha512.c, -Os is
	# slower.
	cat > "$b/bin/cc-openssl" <<-EOF
	#!/bin/sh
	case "\$*" in *crypto/sha/sha256.c*) exec "$b/bin/cc" "\$@" -Os ;; esac
	exec "$b/bin/cc" "\$@"
	EOF
	chmod +x "$b/bin/cc-openssl"
	# The flags go in as arguments, as in the APKBUILD, not also from the
	# environment. CC by name (on PATH): Configure records the compiler
	# command in libcrypto (`openssl version -a`), so a path would put the
	# build host's directory into the image.
	PATH="$b/bin:$PATH" CC=cc-openssl CFLAGS= LDFLAGS= perl ./Configure linux64-riscv64 \
		--prefix=/usr --libdir=lib --openssldir=/etc/ssl enable-fips enable-ktls shared \
		no-zlib no-async no-comp no-idea no-mdc2 no-rc5 no-ec2m no-ssl3 no-seed \
		no-weak-ssl-ciphers $OPT_CFLAGS $OPT_LDFLAGS -Wa,--noexecstack
	PATH="$b/bin:$PATH" make $jobs build_sw
	make install_sw DESTDIR="$dest"
	make install_sw DESTDIR="$sysroot"
}

build_apk_tools() {
	fetch apk-tools
	unpack apk-tools "apk-tools-v${ver%-r*}.tar.gz" "apk-tools-v${ver%-r*}"
	cat > cross.ini <<-EOF
	[binaries]
	c = '$CC'
	ar = '$AR'
	strip = '$STRIP'
	pkg-config = 'pkg-config'
	[properties]
	sys_root = '$sysroot'
	pkg_config_libdir = '$sysroot/usr/lib/pkgconfig'
	[host_machine]
	system = 'linux'
	cpu_family = 'riscv64'
	cpu = 'riscv64'
	endian = 'little'
	EOF
	# abuild-meson's options, then the APKBUILD's, without the lua and
	# python modules and the man pages (not in the image); the help text
	# needs only a lua interpreter.
	VERSION="$ver" meson setup --cross-file cross.ini \
		--prefix=/usr --libdir=/usr/lib --sysconfdir=/etc --localstatedir=/var \
		--buildtype=plain --wrap-mode=nofallback -Db_staticpic=true -Db_pie=true \
		--auto-features=disabled --bindir=/sbin -Darch=riscv64 -Ddocs=disabled \
		-Dhelp=enabled -Dlua_bin="$lua" -Dzstd=disabled -Dlua=disabled -Dpython=disabled \
		-Dtests=disabled output
	ninja -C output
	DESTDIR="$dest" meson install --no-rebuild -C output
}

build() {
	local p t f
	[ "$(uname -m)" = x86_64 ] || { echo "alpine-opt: building needs an x86_64 host (Bootlin's gcc); KW_ALPINE_OPT=0 keeps Alpine's builds" >&2; exit 1; }
	for t in meson ninja pkg-config patch perl; do
		command -v $t > /dev/null || { echo "alpine-opt: need $t" >&2; exit 1; }
	done
	lua=$(command -v lua5.4 || command -v lua || true)
	[ -n "$lua" ] || { echo "alpine-opt: need lua (5.x)" >&2; exit 1; }
	perl -MFindBin -MIPC::Cmd -MFile::Compare -e 1 2> /dev/null ||
		{ echo "alpine-opt: need perl with FindBin, IPC::Cmd, File::Compare (openssl)" >&2; exit 1; }
	setup
	rm -f "$b/.stamp"
	for p in "$@"; do
		echo "alpine-opt: $p"
		(set -e; "build_${p//-/_}")
	done
	# Strip as abuild does: libraries --strip-unneeded, programs fully.
	find "$dest" -type f | while read -r f; do
		case "$(head -c 4 "$f" | od -An -tx1 | tr -d ' ')" in 7f454c46) ;; *) continue ;; esac
		case "$f" in *.so|*.so.*) "$STRIP" --strip-unneeded "$f" ;; *.o|*.a) ;; *) "$STRIP" "$f" ;; esac
	done
	[ "$*" = "$pkgs" ] && echo "$stamp" > "$b/.stamp"
	echo "alpine-opt: $dest"
}

# install_into STAGE: replace the image's files of these packages with the
# rebuilt ones. The apk database keeps Alpine's checksums for them (`apk
# audit` lists them); upgrading a package brings Alpine's build back.
install_into() {
	local stage=$1 db="$1/lib/apk/db/installed" p f want have
	if [ "${KW_ALPINE_OPT:-1}" = 0 ]; then
		echo "alpine-opt: KW_ALPINE_OPT=0, keeping Alpine's builds"
		return
	fi
	[ "$(cat "$b/.stamp" 2> /dev/null)" = "$stamp" ] || build $pkgs
	for p in $pkgs; do
		want=$(set +u; . "$dl/$p/APKBUILD"; echo "$pkgver-r$pkgrel")
		# The package's V: in the db (records end at an empty line).
		have=$(awk -v o="o:$p" '/^$/ { if (m) print v; m = 0; v = ""; next }
			/^V:/ { v = substr($0, 3) } $0 == o { m = 1 } END { if (m) print v }' "$db" | sort -u)
		[ "$have" = "$want" ] && continue
		if [ -n "${ALPINE_TARBALL:-}" ]; then
			echo "alpine-opt: warning: the stage (ALPINE_TARBALL) has $p ${have:-(none)}, the rebuild is $want; keeping Alpine's builds" >&2
			return
		fi
		echo "alpine-opt: the stage has $p ${have:-(none)}, the rebuild is $want (update kernel/guest/alpine-opt.sh)" >&2
		exit 1
	done
	for f in bin/busybox "usr/lib/libz.so.$(set +u; . "$dl/zlib/APKBUILD"; echo "$pkgver")" \
		usr/lib/libcrypto.so.3 usr/lib/libssl.so.3 usr/lib/libapk.so.3.0.0 sbin/apk; do
		[ -f "$stage/$f" ] && [ ! -L "$stage/$f" ] && [ -f "$dest/$f" ] ||
			{ echo "alpine-opt: $f missing in the stage or the build" >&2; exit 1; }
		cat "$dest/$f" > "$stage/$f"
	done
	echo "alpine-opt: installed into $stage"
}

if [ "${1:-}" = --install ]; then
	install_into "${2:?usage: $0 --install STAGE}"
else
	build ${@:-$pkgs}
fi
