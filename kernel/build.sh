#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Build the unkernel kernel (wasm64 vmlinux with emulated riscv64 user mode),
# its 32-bit-memory variant (the one the page and the bundle use), the
# Alpine initramfs and disk images, and the single-file bundle; `ubuntu`
# builds the Ubuntu Base disk image (not part of `all`).
# ./setup.sh at the repository root checks the prerequisites and runs `all`.
#
#   kernel/build.sh [toolchain|binaryen|kernel|lower|alpine|disk|datadisk|bundle|ubuntu|stats|all]  (default: all)
#
# `all` is idempotent: finished steps are skipped or rebuilt incrementally, and
# an existing vendor/build/disk/alpine.ext4 is kept (it may hold your changes;
# `kernel/build.sh disk` rebuilds it).
#
# `stats` builds a profiling variant next to the normal outputs, which it
# leaves alone: kwemu with -Dkwemu-stats (exit counters, the kw_debug_stats
# export) in vendor/build/kwemu-stats, the kernel in vendor/build/kernel-stats
# (the first run is a full kernel build) and the bundle
# vendor/build/bundle/unkernel-alpine-stats.wasm. Boot it with
# `node js/cli.ts --kernel vendor/build/bundle/unkernel-alpine-stats.wasm --stats`.
#
# Everything large lives under vendor/ (gitignored):
#   vendor/src/llvm22               llvm-project llvmorg-22.1.8 (sparse: llvm, lld)
#   vendor/build/lld22              wasm-ld with kernel/patches/llvm applied
#   vendor/src/linux-wasm-kernel    Linux at $LINUX_BASE (kernel.org) + kernel/patches/linux
#                                   (branch kw-riscv-user)
#   vendor/build/kernel             kernel build output (vmlinux = the wasm64 module,
#                                   vmlinux32.wasm = the same lowered to a 32-bit memory/table,
#                                   the default for the browser page)
#   vendor/toolchain/binaryen       Binaryen release (wasm-opt), fetched by `binaryen`
#   vendor/build/disk/alpine.ext4   Alpine root file system image for kwblk (`disk`)
#   vendor/build/disk/kwdata.kwsparse.gz  empty ext4 "kwdata" data disk template (`datadisk`)
#   vendor/build/disk/ubuntu.ext4  Ubuntu Base 24.04 root file system image (`ubuntu`)
#   vendor/build/initramfs/         alpine.cpio (also holds /usr/bin/kwtest and kwbench)
#   vendor/build/bundle/            unkernel-alpine.wasm (vmlinux32.wasm + alpine.cpio + cmdline
#                                   + the data disk template in custom sections); the default of
#                                   the CLI (js/cli.ts) and the SDK, and copied to web/kernel/
#                                   for the page's dev server; unkernel-alpine-stats.wasm from `stats`
#
# Environment:
#   KWEMU=path     wasm64 kwemu static library (default: zig-out/lib/libkwemu.a,
#                  rebuilt with `zig build` on every run; set KWEMU=none for the stub)
#   KWEMU_JIT=0    build that library without the JIT tier (default 1: -Dkwemu-jit=true,
#                  the kernel then imports unkernel.kw_host_jit_*; ignored with KWEMU=)
#   KWEMU_STATS=1  build that library with -Dkwemu-stats into vendor/build/kwemu-stats
#                  (what `stats` sets; ignored with KWEMU=)
#   JOBS=n         parallelism (default: nproc)
#   KSRC=dir       kernel source tree, e.g. a git worktree (default: vendor/src/linux-wasm-kernel)
#   KOUT=dir       kernel build output (default: vendor/build/kernel)
#   WASM_OPT=path  wasm-opt for the 32-bit lowering (default: vendor/toolchain/binaryen,
#                  then PATH); `lower` redoes only that step on an existing vmlinux
set -euo pipefail

. "$(dirname "$0")/tools/env.sh"   # root, vendor, zig, pins, real_bin, ...
jobs="${JOBS:-$(nproc)}"
what="${1:-all}"
use_real_host_tools

# Kernel base: Linux v7.3.4 from kernel.org, fetched by exact commit (shallow).
# arch/wasm is based on Joel Severin's linux-wasm (joelseverin/linux, branch
# wasm-7.0); see .agents/kernel.md.
LINUX_REPO=https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
LINUX_BASE=7595a62d45ee1a2297eafa5f2ef5d0a45142d84d
LLVM_REPO=https://github.com/llvm/llvm-project.git
LLVM_TAG=llvmorg-22.1.8
LLVM_COMMIT=ca7933e47d3a3451d81e72ac174dcb5aa28b59d1
BINARYEN_VERSION=133
BINARYEN_SHA256_x86_64=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489
BINARYEN_SHA256_aarch64=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8

ksrc="${KSRC:-$vendor/src/linux-wasm-kernel}"
kout="${KOUT:-$vendor/build/kernel}"
toolchain="$vendor/toolchain/bin"

need_clang() {
	local v
	v="$(clang --version 2>/dev/null | sed -n 's/.*clang version \([0-9]*\).*/\1/p' | head -1)"
	if [ "${v:-0}" -lt 21 ]; then
		echo "need clang >= 21 (wasm64 table64 call_indirect; tested with 22), have ${v:-none}" >&2
		exit 1
	fi
}

# git_am DIR PATCH...: apply a patch series; on failure leave DIR as it was.
git_am() {
	local dir="$1"
	shift
	if ! git -C "$dir" -c user.name=unkernel -c user.email=unkernel@localhost am "$@"; then
		git -C "$dir" am --abort || true
		echo "patches did not apply in $dir" >&2
		return 1
	fi
}

build_toolchain() {
	need_clang
	local src="$vendor/src/llvm22" out="$vendor/build/lld22"
	if [ ! -d "$src/lld/wasm" ]; then
		mkdir -p "$vendor/src"
		rm -rf "$src.tmp"
		git -c advice.detachedHead=false clone --depth 1 --branch "$LLVM_TAG" --filter=blob:none --sparse "$LLVM_REPO" "$src.tmp"
		git -C "$src.tmp" sparse-checkout set llvm lld cmake third-party libunwind/include
		if [ "$(git -C "$src.tmp" rev-parse HEAD)" != "$LLVM_COMMIT" ]; then
			echo "$LLVM_TAG is not $LLVM_COMMIT; refusing to build an unexpected LLVM" >&2
			exit 1
		fi
		mv "$src.tmp" "$src"
	fi
	if ! git -C "$src" log --oneline -3 | grep -q "linker scripts"; then
		git_am "$src" "$root"/kernel/patches/llvm/*.patch
	fi
	if [ ! -f "$out/build.ninja" ]; then
		cmake -G Ninja -S "$src/llvm" -B "$out" -DCMAKE_BUILD_TYPE=Release \
			-DLLVM_ENABLE_PROJECTS=lld -DLLVM_TARGETS_TO_BUILD=WebAssembly \
			-DLLVM_ENABLE_ASSERTIONS=ON -DCMAKE_C_COMPILER="$(real_bin clang)" -DCMAKE_CXX_COMPILER="$(real_bin clang++)" \
			-DLLVM_USE_LINKER=lld -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
			-DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF
	fi
	ninja -C "$out" -j"$jobs" lld
	mkdir -p "$toolchain"
	for t in clang llvm-ar llvm-nm llvm-objcopy llvm-objdump llvm-ranlib llvm-readelf llvm-strip; do
		ln -sf "$(real_bin $t)" "$toolchain/$t"
	done
	ln -sf "$out/bin/lld" "$toolchain/wasm-ld"
}

prepare_kernel_tree() {
	if [ ! -e "$ksrc/.git" ]; then  # -e: a worktree has a .git file
		# Only the base commit (shallow); `git fetch --deepen N` adds history.
		rm -rf "$ksrc.tmp"
		mkdir -p "$ksrc.tmp"
		git -C "$ksrc.tmp" init -q
		git -C "$ksrc.tmp" remote add origin "$LINUX_REPO"
		git -C "$ksrc.tmp" fetch --depth 1 origin "$LINUX_BASE"
		git -C "$ksrc.tmp" checkout -q --detach FETCH_HEAD
		mv "$ksrc.tmp" "$ksrc"
	fi
	if ! git -C "$ksrc" rev-parse -q --verify kw-riscv-user >/dev/null; then
		git -C "$ksrc" checkout -q --detach "$LINUX_BASE"
		git_am "$ksrc" "$root"/kernel/patches/linux/*.patch
		git -C "$ksrc" checkout -q -b kw-riscv-user
	fi
	# An existing branch is never re-applied: say so when it no longer
	# matches the series (an older series, or commits not yet exported).
	local npatch ncommit
	npatch=$(ls "$root"/kernel/patches/linux/*.patch | wc -l)
	ncommit=$(git -C "$ksrc" rev-list --count "$LINUX_BASE..kw-riscv-user" 2>/dev/null || echo "?")
	if [ "$npatch" != "$ncommit" ]; then
		echo "warning: kw-riscv-user has $ncommit commits, kernel/patches/linux has $npatch patches;" >&2
		echo "  export your commits, or rename the branch (git -C $ksrc branch -m kw-riscv-user old) to re-apply the series" >&2
	fi
	# The emulator contract (include/kw_emu.h) is the source of truth; the
	# kernel tree has a copy (arch/wasm/include/asm/kw_emu.h). Keep the build consistent if they
	# drift, and say so: the kernel patch needs updating.
	if ! cmp -s "$root/include/kw_emu.h" "$ksrc/arch/wasm/include/asm/kw_emu.h"; then
		echo "warning: include/kw_emu.h differs from the kernel tree's arch/wasm/include/asm/kw_emu.h;" >&2
		echo "  copying it (commit it on kw-riscv-user and re-export kernel/patches/linux)" >&2
		cp "$root/include/kw_emu.h" "$ksrc/arch/wasm/include/asm/kw_emu.h"
	fi
}

# The zig build option for the kwemu JIT tier (src/emu/jit.zig), on unless
# KWEMU_JIT=0. Hosts without the JIT simply answer kw_host_jit_caps() with 0.
kwemu_jit_flag() {
	if [ "${KWEMU_JIT:-1}" = 0 ]; then echo -Dkwemu-jit=false; else echo -Dkwemu-jit=true; fi
}

kwemu_obj() {
	# A stats library goes to its own prefix, so zig-out keeps the normal one.
	local prefix="$root/zig-out" stats=()
	if [ "${KWEMU_STATS:-0}" = 1 ]; then
		prefix="$vendor/build/kwemu-stats"
		stats=(-Dkwemu-stats=true)
	fi
	local k="${KWEMU:-$prefix/lib/libkwemu.a}"
	if [ "$k" = none ]; then
		echo ""
		return
	fi
	if [ -z "${KWEMU:-}" ]; then
		# Always run it: zig build is incremental and keeps libkwemu.a current
		# (also after a `zig build` or `zig build test` without the JIT option).
		need_zig
		(cd "$root" && "$zig" build "$(kwemu_jit_flag)" "${stats[@]}" --prefix "$prefix" >&2) || return 1
	fi
	if [ ! -f "$k" ]; then
		echo "no kwemu library at $k (KWEMU=none links a stub that cannot run user code)" >&2
		return 1
	fi
	echo "$k"
}

build_kernel() {
	[ -x "$toolchain/wasm-ld" ] || build_toolchain
	prepare_kernel_tree
	local kwemu
	kwemu="$(kwemu_obj)" || exit 1
	local make_cmd=(make -C "$ksrc" O="$kout" ARCH=wasm
		LLVM="$root/kernel/tools/fake-llvm/" REAL_LLVM="$toolchain/"
		CROSS_COMPILE=wasm64-unknown-unknown- HOSTCC=gcc KWEMU="$kwemu")
	# The wrapper (python3) and Kbuild find clang/wasm-ld through REAL_LLVM.
	mkdir -p "$kout"
	# (Re)configure when there is no .config or kw_defconfig changed since.
	if [ ! -f "$kout/.config" ] || [ "$ksrc/arch/wasm/configs/kw_defconfig" -nt "$kout/.config" ]; then
		"${make_cmd[@]}" kw_defconfig
	fi
	"${make_cmd[@]}" -j"$jobs" vmlinux
	echo "kernel: $kout/vmlinux"
	lower_kernel
}

# Binaryen release binaries (wasm-opt) into vendor/toolchain/binaryen.
fetch_binaryen() {
	local v="version_$BINARYEN_VERSION" arch
	case "$(uname -m)" in
	x86_64) arch=x86_64-linux ;;
	aarch64 | arm64) arch=aarch64-linux ;;
	*) echo "no Binaryen release binary for $(uname -m); install binaryen >= $BINARYEN_VERSION and set WASM_OPT" >&2; return 1 ;;
	esac
	local tgz="binaryen-$v-$arch.tar.gz" url="https://github.com/WebAssembly/binaryen/releases/download/$v"
	local sum_var="BINARYEN_SHA256_${arch%%-*}"
	fetch_verified "$url/$tgz" "$vendor/downloads/$tgz" "${!sum_var}"
	mkdir -p "$vendor/toolchain"
	tar xzf "$vendor/downloads/$tgz" -C "$vendor/toolchain"
	ln -sfn "binaryen-$v" "$vendor/toolchain/binaryen"
	"$vendor/toolchain/binaryen/bin/wasm-opt" --version
}

find_wasm_opt() {
	local w
	for w in "${WASM_OPT:-}" "$vendor/toolchain/binaryen/bin/wasm-opt" "$(command -v wasm-opt || true)"; do
		[ -n "$w" ] && [ -x "$w" ] || continue
		# Older releases cannot lower table64 (call_indirect with an i64 index).
		if [[ "$("$w" --help 2>/dev/null)" == *--table64-lowering* ]]; then
			echo "$w"
			return
		fi
		echo "warning: $w ($("$w" --version 2>/dev/null)) has no --table64-lowering; too old" >&2
	done
}

# vmlinux32.wasm: vmlinux with its memory and table lowered to 32 bits. It runs
# on every engine (also those without memory64: Safari/WebKit, so every iOS
# browser), as fast as wasm64 in V8 and faster in JavaScriptCore, so the page
# and the bundle use it. Pointers stay i64 in code and at the JS boundary;
# every load/store, memory and table op wraps its address to i32, which is
# exact because guest RAM is < 4 GiB. The import/export signatures (and with
# them JSPI) are unchanged. Fetches the pinned Binaryen if there is no wasm-opt.
lower_kernel() {
	local wasm_opt
	wasm_opt="$(find_wasm_opt)"
	[ -n "$wasm_opt" ] || { fetch_binaryen && wasm_opt="$(find_wasm_opt)"; } || true
	if [ -z "$wasm_opt" ]; then
		echo "lower: no wasm-opt with --table64-lowering (run '$0 binaryen' or set WASM_OPT);" >&2
		echo "  the browser page and the bundle need vmlinux32.wasm" >&2
		if [ -f "$kout/vmlinux32.wasm" ] && [ "$kout/vmlinux" -nt "$kout/vmlinux32.wasm" ]; then
			rm -f "$kout/vmlinux32.wasm"
			echo "  removed the stale $kout/vmlinux32.wasm (older than vmlinux)" >&2
		fi
		return 1
	fi
	# -g keeps the name section (function names in traps and stack dumps).
	# In current Binaryen --table64-lowering is an alias of --memory64-lowering
	# (which lowers both); giving both is harmless (identical output) and also
	# covers releases where they were separate passes.
	"$wasm_opt" "$kout/vmlinux" -g --memory64-lowering --table64-lowering -o "$kout/vmlinux32.wasm.tmp"
	mv "$kout/vmlinux32.wasm.tmp" "$kout/vmlinux32.wasm"
	echo "kernel (32-bit memory): $kout/vmlinux32.wasm ($("$wasm_opt" --version))"
}

# A single-file kernel (the 32-bit-memory build) with Alpine (gzipped) and its
# command line bundled in custom sections; the runtime boots it when given no
# initrd of its own.
# $1: the bundle's file name (default unkernel-alpine.wasm).
bundle_alpine() {
	local out="$vendor/build/bundle" cpio="$vendor/build/initramfs/alpine.cpio" name="${1:-unkernel-alpine.wasm}"
	[ -f "$cpio" ] || { echo "bundle: no $cpio (run '$0 alpine')" >&2; return 1; }
	[ -f "$kout/vmlinux32.wasm" ] || { echo "bundle: no $kout/vmlinux32.wasm (run '$0 lower')" >&2; return 1; }
	mkdir -p "$out"
	rm -f "$out/unkernel-alpine32.wasm"   # earlier name of this bundle
	local dd=() tpl="$vendor/build/disk/kwdata.kwsparse.gz"
	if [ -f "$tpl" ]; then
		dd=(--datadisk "$tpl")
	else
		echo "warning: no $tpl ('$0 datadisk' needs mke2fs); the bundle has no data disk template" >&2
	fi
	node "$root/kernel/tools/bundle.mjs" "$kout/vmlinux32.wasm" "$cpio" -o "$out/$name" \
		--cmdline "console=hvc0 rdinit=/init" "${dd[@]}"
	# The page's dev server runs web/kernel/'s copy (web/scripts/kernel.ts);
	# a page build replaces it with the newest release's.
	if [ "$name" = unkernel-alpine.wasm ]; then
		mkdir -p "$root/web/kernel"
		cp "$out/$name" "$root/web/kernel/$name"
	fi
}

# The data disk template: an empty ext4 file system labelled kwdata (4 GiB,
# 4 KiB blocks) as a gzipped kwsparse image (only its non-zero blocks). The
# page copies it into IndexedDB on first use, the CLI's --data creates an
# image file from it, and the guest mounts it at /data; a saved disk is never
# replaced by a newer template.
# The output is reproducible: fixed UUID, hash seed and timestamps, a pinned
# mke2fs.conf (the ext4 features of the host defaults that alpine-disk.sh
# uses, which kw_defconfig supports), inode tables and journal zeroed now.
# The orphan file is 32 KiB (8 blocks, ~8000 slots; the default for 4 GiB is
# 1 MiB): the kernel reads it one block at a time at every mount, and on the
# page each read was an IndexedDB round trip.
DATADISK_UUID=6b776461-7461-4000-8000-000000000001
DATADISK_HASH_SEED=6b776461-7461-4000-8000-000000000002
DATADISK_EPOCH=1767225600   # 2026-01-01T00:00:00Z
build_datadisk() {
	local out="$vendor/build/disk" mke2fs e2fsck
	mke2fs="$(PATH="$PATH:/usr/sbin:/sbin" command -v mke2fs || true)"
	e2fsck="$(PATH="$PATH:/usr/sbin:/sbin" command -v e2fsck || true)"
	if [ -z "$mke2fs" ]; then
		echo "warning: no mke2fs (e2fsprogs); no data disk template" >&2
		return 1
	fi
	mkdir -p "$out"
	local img="$out/kwdata.ext4.tmp" conf="$out/kwdata-mke2fs.conf.tmp"
	printf '%s\n' '[defaults]' \
		'	base_features = sparse_super,large_file,filetype,resize_inode,dir_index,ext_attr' \
		'	default_mntopts = acl,user_xattr' \
		'	enable_periodic_fsck = 0' \
		'	blocksize = 4096' \
		'	inode_size = 256' \
		'	inode_ratio = 16384' \
		'[fs_types]' \
		'	ext4 = {' \
		'		features = has_journal,extent,huge_file,flex_bg,metadata_csum,metadata_csum_seed,64bit,dir_nlink,extra_isize,orphan_file' \
		'	}' > "$conf"
	rm -f "$img"
	truncate -s 4G "$img"   # sparse; removed below
	MKE2FS_CONFIG="$conf" E2FSPROGS_FAKE_TIME="$DATADISK_EPOCH" SOURCE_DATE_EPOCH="$DATADISK_EPOCH" \
		"$mke2fs" -q -F -t ext4 -b 4096 -L kwdata -U "$DATADISK_UUID" -m 0 -J size=8 \
		-E "hash_seed=$DATADISK_HASH_SEED,lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,orphan_file_size=32K" "$img"
	if [ -n "$e2fsck" ]; then
		E2FSPROGS_FAKE_TIME="$DATADISK_EPOCH" "$e2fsck" -fn "$img" >/dev/null 2>&1 || { "$e2fsck" -fn "$img"; rm -f "$img" "$conf"; exit 1; }
	fi
	node "$root/kernel/tools/kwsparse.mjs" encode "$img" -o "$out/kwdata.kwsparse.gz"
	rm -f "$img" "$conf"
}
# After a kernel or Alpine rebuild: keep the bundle (the default of the CLI,
# the SDK and the page) in step, when both inputs exist.
refresh_bundle() {
	[ -f "$vendor/build/initramfs/alpine.cpio" ] && [ -f "$kout/vmlinux32.wasm" ] || return 0
	bundle_alpine
}

# The disk image is kept if it is newer than everything it is built from.
disk_is_current() {
	local img="$vendor/build/disk/alpine.ext4" f
	[ -f "$img" ] || return 1
	for f in "$root/kernel/guest/alpine-disk.sh" "$root/kernel/guest/alpine.sh" \
		"$root/kernel/guest/curl-shim.sh" "$root/kernel/guest/kw-data.sh" "$root/kernel/tools/ext4-owners.py" \
		"$root/kernel/tools/env.sh"; do
		[ "$img" -nt "$f" ] || return 1
	done
}

case "$what" in
toolchain) build_toolchain ;;
binaryen) fetch_binaryen ;;
kernel) build_kernel; refresh_bundle ;;
lower) lower_kernel; refresh_bundle ;;
alpine) "$root/kernel/guest/alpine.sh"; refresh_bundle ;;
disk) "$root/kernel/guest/alpine-disk.sh" ;;
datadisk) build_datadisk; refresh_bundle ;;
bundle) bundle_alpine ;;
ubuntu) "$root/kernel/guest/ubuntu-disk.sh" ;;
stats)
	KWEMU_STATS=1
	kout="${KOUT:-$vendor/build/kernel-stats}"
	build_kernel
	bundle_alpine unkernel-alpine-stats.wasm
	;;
all)
	build_kernel
	"$root/kernel/guest/alpine.sh"
	build_datadisk || true   # without mke2fs: a bundle without the data disk
	bundle_alpine
	if disk_is_current; then
		echo "disk: keeping $vendor/build/disk/alpine.ext4 (kernel/build.sh disk rebuilds it)"
	elif PATH="$PATH:/usr/sbin:/sbin" command -v mke2fs >/dev/null; then
		"$root/kernel/guest/alpine-disk.sh"
	else
		echo "warning: no mke2fs (e2fsprogs); skipping the disk image" >&2
	fi
	;;
*) echo "usage: $0 [toolchain|binaryen|kernel|lower|alpine|disk|datadisk|bundle|ubuntu|stats|all]" >&2; exit 2 ;;
esac
