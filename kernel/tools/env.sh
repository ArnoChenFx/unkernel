# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Sourced by setup.sh and the kernel/ and guest/ build scripts (bash). Sets:
#   root, vendor        repository root and its vendor/ directory
#   build               where the build outputs go: $KW_BUILD (an absolute
#                       path), default vendor/build; sources, downloads and
#                       the toolchain stay in vendor/
#   zig                 the zig binary ($ZIG, else zig on PATH)
# and provides real_bin, use_real_host_tools and fetch_verified.
#
# The guest's pins are next to their builders (guest/*/pins.sh,
# guest/tools/pins.sh), the kernel's and the toolchain's in kernel/build.sh.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
vendor="$root/vendor"
build="$(realpath -m "${KW_BUILD:-$vendor/build}")"
zig="${ZIG:-$(command -v zig || true)}"

# real_bin NAME: the first NAME on PATH that is an ELF executable, else the
# first NAME on PATH at all (empty if none). Some hosts put wrapper scripts
# (for example auto-installing shims) ahead of the real tools; a wrapper that
# does not pass stdin through breaks steps that pipe into a tool
# (flex -> m4, `echo $HZ | bc` in the kernel build, `cc -x c -` probes).
real_bin() {
	local p magic
	while IFS= read -r p; do
		magic="$(head -c 4 "$p" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
		if [ "$magic" = 7f454c46 ]; then
			echo "$p"
			return
		fi
	done < <(type -aP "$1")
	type -P "$1" || true
}

# use_real_host_tools: put symlinks to the real binaries of the host tools the
# builds run (see real_bin) first on PATH, in vendor/toolchain/host-bin. On a
# host without wrappers this changes nothing.
use_real_host_tools() {
	local dir="$vendor/toolchain/host-bin" t p
	mkdir -p "$dir"
	for t in m4 bc flex bison gcc g++ cc c++ clang clang++ ld.lld cmake ninja make perl python3; do
		p="$(real_bin "$t")"
		if [ -n "$p" ] && [ "$p" != "$dir/$t" ]; then
			ln -sfn "$p" "$dir/$t"
		fi
	done
	case ":$PATH:" in *":$dir:"*) ;; *) export PATH="$dir:$PATH" ;; esac
	export M4="${M4:-$dir/m4}"
}

# fetch_verified URL FILE SHA256: download URL to FILE unless FILE already
# exists with that checksum; fails if the download does not match.
fetch_verified() {
	local url="$1" file="$2" sum="$3"
	if [ -f "$file" ] && echo "$sum  $file" | sha256sum -c --status; then
		return 0
	fi
	mkdir -p "$(dirname "$file")"
	curl -fL --retry 3 -o "$file.part" "$url"
	if ! echo "$sum  $file.part" | sha256sum -c --status; then
		echo "checksum mismatch for $url (expected $sum, got $(sha256sum "$file.part" | cut -d' ' -f1))" >&2
		rm -f "$file.part"
		return 1
	fi
	mv "$file.part" "$file"
}

need_zig() {
	if [ -z "$zig" ] || [ ! -x "$zig" ]; then
		echo "zig not found (need Zig 0.16; put it on PATH or set ZIG=/path/to/zig)" >&2
		exit 1
	fi
}
