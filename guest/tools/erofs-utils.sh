#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# mkfs.erofs, fsck.erofs and dump.erofs for the distro images, built from
# pinned sources (erofs-utils, lz4, zstd: versions and SHA-256 in
# pins.sh) into vendor/toolchain/erofs-utils/bin, without autotools and
# without system libraries: a fixed config.h, the sources compiled directly
# with zig cc (static, musl), lz4 and zstd linked in from their own sources.
# No zlib, liblzma, libdeflate, libuuid, selinux, FUSE, OCI or S3: the
# images need lz4hc (default) or zstd, plain tar input and a fixed UUID.
# erofs-utils-patches/*.patch are applied in name order (patch -p1; one that
# does not apply fails the build): file data in tar stream order and the
# metadata zone at the front (--sort=tar, --nofrag-first, --MZ-front; see
# the patch).
#
#   guest/tools/erofs-utils.sh    builds unless the stamp is current (this
#                                 script without its comments, the patches,
#                                 the pins, zig's version), prints the bin
#                                 directory
set -euo pipefail

. "$(dirname "$0")/../lib/env.sh"   # root, vendor, zig, fetch_verified
. "$(dirname "$0")/pins.sh"          # EROFS_UTILS_*, LZ4_*, ZSTD_*
need_zig
dest="$vendor/toolchain/erofs-utils"
dl="$vendor/downloads"
stamp="$dest/.stamp"
patches=("$(dirname "${BASH_SOURCE[0]}")"/erofs-utils-patches/*.patch)
want="$(grep -v '^[[:space:]]*#' "${BASH_SOURCE[0]}" | sha256sum | cut -c1-16) $(cat "${patches[@]}" | sha256sum | cut -c1-16) $EROFS_UTILS_VERSION $LZ4_VERSION $ZSTD_VERSION $("$zig" version)"
if [ -x "$dest/bin/mkfs.erofs" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
	echo "$dest/bin"
	exit 0
fi

fetch_verified "$EROFS_UTILS_URL" "$dl/erofs-utils-$EROFS_UTILS_VERSION.tar.gz" "$EROFS_UTILS_SHA256" >&2
fetch_verified "$LZ4_URL" "$dl/lz4-$LZ4_VERSION.tar.gz" "$LZ4_SHA256" >&2
fetch_verified "$ZSTD_URL" "$dl/zstd-$ZSTD_VERSION.tar.gz" "$ZSTD_SHA256" >&2

rm -rf "$dest"
src="$dest/src" obj="$dest/obj"
mkdir -p "$src" "$obj" "$dest/bin"
for t in "erofs-utils-$EROFS_UTILS_VERSION" "lz4-$LZ4_VERSION" "zstd-$ZSTD_VERSION"; do
	tar -xzf "$dl/$t.tar.gz" -C "$src"
done
e="$src/erofs-utils-$EROFS_UTILS_VERSION" l="$src/lz4-$LZ4_VERSION/lib" z="$src/zstd-$ZSTD_VERSION/lib"
for p in "${patches[@]}"; do
	patch -d "$e" -p1 --forward --batch --no-backup-if-mismatch -s < "$p" ||
		{ echo "erofs-utils: ${p##*/} does not apply to erofs-utils $EROFS_UTILS_VERSION" >&2; exit 1; }
done

# What configure would find on a Linux host with lz4 and zstd and nothing
# else optional; multi-threaded compression (-E... --workers) as upstream's
# default build.
cat > "$obj/config.h" <<EOF
#define PACKAGE_VERSION "$EROFS_UTILS_VERSION"
#define LZ4_ENABLED 1
#define LZ4HC_ENABLED 1
#define HAVE_LIBZSTD 1
#define HAVE_ZSTD_GETFRAMECONTENTSIZE 1
#define EROFS_MT_ENABLED 1
#define HAVE_PTHREAD_H 1
#define HAVE_ENDIAN_H 1
#define HAVE_LINUX_FALLOC_H 1
#define HAVE_LINUX_FS_H 1
#define HAVE_LINUX_TYPES_H 1
#define HAVE_LINUX_XATTR_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_RANDOM_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_SENDFILE_H 1
#define HAVE_SYS_STATFS_H 1
#define HAVE_SYS_SYSMACROS_H 1
#define HAVE_SYS_XATTR_H 1
#define HAVE_UNISTD_H 1
#define HAVE_STRUCT_STAT_ST_ATIM 1
#define HAVE_MEMRCHR 1
#define HAVE_COPY_FILE_RANGE 1
#define HAVE_FALLOCATE 1
#define HAVE_GETRANDOM 1
#define HAVE_GETRLIMIT 1
#define HAVE_GETTID 1
#define HAVE_LGETXATTR 1
#define HAVE_LLISTXATTR 1
#define HAVE_LSETXATTR 1
#define HAVE_PREAD64 1
#define HAVE_PWRITE64 1
#define HAVE_PWRITEV 1
#define HAVE_POSIX_FADVISE 1
#define HAVE_FSTATFS 1
#define HAVE_SENDFILE 1
#define HAVE_SYSCONF 1
#define HAVE_UTIMENSAT 1
EOF

cc=("$zig" cc -target "$(uname -m)-linux-musl" -O2 -g0 -D_GNU_SOURCE -D_FILE_OFFSET_BITS=64)
lib=(config io cache super inode xattr exclude namei data compress compressor zmap decompress
	compress_hints hashmap sha256 blobchunk dir fragments dedupe uuid_unparse uuid tar block_list
	rebuild diskbuf bitops dedupe_ext vmdk metabox global importer base64 kite_deflate
	compressor_deflate compressor_lz4 compressor_lz4hc compressor_libzstd xxhash workqueue gzran
	remotes/oci remotes/docker_config)
jobs=()
for f in "${lib[@]}"; do jobs+=("$e/lib/$f.c|-DHAVE_CONFIG_H -include $obj/config.h -I$obj -I$e/include -I$e/lib -I$l -I$z"); done
for p in mkfs fsck dump; do jobs+=("$e/$p/main.c|-DHAVE_CONFIG_H -include $obj/config.h -I$obj -I$e/include -I$e/lib"); done
for f in lz4 lz4hc; do jobs+=("$l/$f.c|"); done
for f in "$z"/common/*.c "$z"/compress/*.c "$z"/decompress/*.c; do
	jobs+=("$f|-DZSTD_DISABLE_ASM=1 -DZSTD_MULTITHREAD=0 -DZSTD_LEGACY_SUPPORT=0")
done
# Each job is "SOURCE|FLAGS"; xargs -P compiles them in parallel (the
# compiler command goes through a file, arrays do not export).
export src obj
printf '%s\n' "${cc[@]}" > "$obj/cc.args"
printf '%s\n' "${jobs[@]}" | xargs -P "$(nproc)" -I{} bash -c '
	mapfile -t cc < "$obj/cc.args"
	f=${1%%|*} flags=${1#*|}
	g=${f#"$src"/}
	o="$obj/$(echo "${g%.c}" | tr / _).o"
	"${cc[@]}" $flags -w -c -o "$o" "$f"' _ {}
common=()
for o in "$obj"/*.o; do
	case $o in *_mkfs_main.o|*_fsck_main.o|*_dump_main.o) ;; *) common+=("$o") ;; esac
done
for p in mkfs fsck dump; do
	"${cc[@]}" -static -s -o "$dest/bin/$p.erofs" "$obj/erofs-utils-${EROFS_UTILS_VERSION}_${p}_main.o" "${common[@]}" -lpthread
done
rm -rf "$src"
"$dest/bin/mkfs.erofs" --version >&2
echo "$want" > "$stamp"
echo "$dest/bin"
