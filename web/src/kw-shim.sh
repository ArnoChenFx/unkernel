#!/bin/sh
# kw-shim 1
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Pooya Parsa
#
# @TOOL@ on first use. This file is a stand-in that the unkernel page writes
# (web/src/shims.ts): the first call downloads the real @TOOL@ for this machine,
# checks it, puts it at ~/.local/bin/@TOOL@ (in place of this file, when this
# file is there) and runs it with the same arguments. Later calls start the
# real program directly. Delete ~/.local/bin/@TOOL@ to uninstall (the page
# writes this stand-in again at its next start).
#
# What it fetches (derived from the official installers, without running them):
#   fx        https://releases.fx.sh/VERSION/fx-linux-ARCH.tar.gz
#             VERSION from releases.fx.sh/latest.txt (or KW_FX_VERSION=vX.Y.Z).
#             fx publishes no checksums, so, as fx.sh/setup.sh, nothing is
#             verified beyond gzip's CRC and an ELF program in the tarball.
#   claude    https://downloads.claude.ai/claude-code-releases/VERSION/PLATFORM/claude[.zst]
#             VERSION from .../latest (or KW_CLAUDE_VERSION=stable|latest|X.Y.Z),
#             checked against manifest.json's SHA-256 and size, laid out as
#             `claude install` does: ~/.local/share/claude/versions/VERSION,
#             symlinked from ~/.local/bin/claude.
#   opencode  https://registry.npmjs.org/SCOPE/cli-PLATFORM/-/cli-PLATFORM-VERSION.tgz
#             VERSION and SCOPE from opencode.ai/update/api/latest/cli/npm (or
#             KW_OPENCODE_VERSION=X.Y.Z), checked against the registry's
#             sha512 integrity; ~/.opencode/bin/opencode, symlinked from
#             ~/.local/bin/opencode.
# The download streams straight into its final directory (no copy in /tmp)
# and is hashed on the way; free space is checked first. One install at a
# time per tool (flock); an interrupted one leaves nothing behind.
tool=@TOOL@

[ "${HOME:-/}" = / ] && [ "$(id -u)" = 0 ] && HOME=/root
bin=$HOME/.local/bin
link=$bin/$tool
# installed: the command at ~/.local/bin is the real program (not a script).
installed() { [ -x "$link" ] && [ "$(head -c 2 "$link" 2>/dev/null)" != '#!' ]; }
run() { exec 9>&-; exec "$link" "$@"; }
installed && run "$@"

set -o pipefail
gray= reset=
[ -t 2 ] && gray='\033[90m' reset='\033[0m'
say() { printf "${gray}%s${reset}\n" "$tool: $*" >&2; }
die() { printf '%s\n' "$tool: $*" >&2; exit 127; }
# get URL: the body on stdout, quiet; fails on an HTTP error.
get() { wget -q -U kw-shim -O - "$1"; }
# pkg CMD: CMD is there, or apk installs it now (as root). Only for speed:
# without it the install still works, slower.
pkg() {
	command -v "$1" >/dev/null && return
	[ "$(id -u)" = 0 ] || return 1
	say "apk add $1 (unpacks the download faster)"
	apk add -q --no-progress "$1" >/dev/null 2>&1
	command -v "$1" >/dev/null
}

case $(uname -m) in
aarch64|arm64) fxarch=aarch64 plat=arm64 ;;
x86_64|amd64) fxarch=x86_64 plat=x64 ;;
*) die "no $tool build for $(uname -m)" ;;
esac
libc=
ls /lib/ld-musl-* >/dev/null 2>&1 && libc=-musl

awk '$2 == "00000000" { f = 1 } END { exit !f }' /proc/net/route 2>/dev/null ||
	die "not installed yet, and installing it needs a network (this machine has none)"

mkdir -p "$bin" || die "cannot create $bin"
exec 9>"/tmp/.kw-shim-$tool.lock" && flock 9 || die "cannot lock /tmp/.kw-shim-$tool.lock"
installed && run "$@"  # another call installed it while this one waited

# --- what to fetch -----------------------------------------------------------
# url, dir (final directory), file (final name in dir), size (bytes, for the
# space check and, with exact=1, the result), hash (sha256 or sha512), sum
# (expected hex digest), what (archive: hash the download; output: the result)
exact= sum= what=archive
case $tool in
fx)
	ver=${KW_FX_VERSION:-latest}
	[ "$ver" = latest ] && { ver=$(get https://releases.fx.sh/latest.txt | tr -d '[:space:]') || die "cannot reach releases.fx.sh"; }
	case $ver in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "unexpected version '$ver'" ;; esac
	url=https://releases.fx.sh/$ver/fx-linux-$fxarch.tar.gz
	dir=$bin file=fx size=16000000 hash=sha256
	unpack() { tar -xzOf - fx && cat >/dev/null; } ;;
claude)
	B=https://downloads.claude.ai/claude-code-releases
	ver=${KW_CLAUDE_VERSION:-latest}
	case $ver in stable|latest) ver=$(get "$B/$ver") || die "cannot reach downloads.claude.ai" ;; esac
	case $ver in [0-9]*.[0-9]*.[0-9]*) ;; *) die "unexpected version '$ver'" ;; esac
	p=linux-$plat$libc
	m=$(get "$B/$ver/manifest.json" | tr -d ' \n\r\t') || die "cannot get the manifest of $ver"
	case $m in *"\"$p\":{"*) m=${m#*\"$p\":\{}; m=${m%%\}*} ;; *) m= ;; esac  # the platform's own object
	sum=$(printf %s "$m" | sed -n 's/.*"checksum":"\([0-9a-f]\{64\}\)".*/\1/p')
	size=$(printf %s "$m" | sed -n 's/.*"size":\([0-9][0-9]*\).*/\1/p')
	[ -n "$sum" ] && [ -n "$size" ] || die "no $p build in the manifest of $ver"
	dir=$HOME/.local/share/claude/versions file=$ver hash=sha256 exact=1 what=output
	url=$B/$ver/$p/claude
	unpack() { cat; } ;;
opencode)
	scope=@opencode
	ver=${KW_OPENCODE_VERSION:-}
	if [ -z "$ver" ]; then
		m=$(get https://opencode.ai/update/api/latest/cli/npm) || die "cannot reach opencode.ai"
		ver=$(printf %s "$m" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
		pkg=$(printf %s "$m" | sed -n 's/.*"package":"\([^"]*\)".*/\1/p')
		[ -n "$ver" ] && [ -n "$pkg" ] || die "unexpected answer from opencode.ai"
		scope=${pkg%/cli}
	fi
	ver=${ver#v}
	case $scope in @[a-z0-9]*) ;; *) die "unexpected package scope '$scope'" ;; esac
	t=linux-$plat$libc
	m=$(get "https://registry.npmjs.org/$scope%2fcli-$t/$ver") || die "no opencode $ver for $t on the npm registry"
	url=$(printf %s "$m" | sed -n 's/.*"tarball":"\(https:[^"]*\)".*/\1/p')
	i=$(printf %s "$m" | sed -n 's/.*"integrity":"sha512-\([A-Za-z0-9+\/=]*\)".*/\1/p')
	size=$(printf %s "$m" | sed -n 's/.*"unpackedSize":\([0-9][0-9]*\).*/\1/p')
	[ -n "$url" ] && [ -n "$i" ] && [ -n "$size" ] || die "unexpected npm metadata for opencode $ver"
	sum=$(printf %s "$i" | base64 -d | od -An -v -tx1 | tr -d ' \n')
	[ ${#sum} = 128 ] || die "bad integrity in the npm metadata"
	dir=$HOME/.opencode/bin file=opencode hash=sha512
	unpack() { tar -xzOf - package/bin/opencode && cat >/dev/null; } ;;
*) die "kw-shim: unknown tool" ;;
esac

# --- space ---------------------------------------------------------------------
rm -f "$dir"/*.kw-part.* "$bin"/.*.kw-link.* 2>/dev/null  # left by a killed install
free=$(( $(stat -f -c '%a * %S' "$bin") ))  # $dir is under $HOME too
need=$(( size + 16 * 1048576 ))
if [ "$free" -lt "$need" ]; then
	mib() { echo "$(( ($1 + 1048575) / 1048576 )) MiB"; }
	case $(stat -f -c %T "$bin") in
	tmpfs|ramfs)
		die "needs $(mib "$need") free, and only $(mib "$free") is: without a data disk the files live in memory." \
			"Attach one (the page does unless ?data=0; the CLI with --data FILE) or give more memory (?mem=, --mem)." ;;
	esac
	die "needs $(mib "$need") free in $bin, and only $(mib "$free") is; not installed"
fi
mkdir -p "$dir" || die "cannot create $dir"

# --- faster unpacking (measured under kwemu, 2026-11-18) ----------------------
case $tool in
claude)
	# The .zst is a third of the size (127 against 357 MB for 2.1.327; TLS
	# 10 s, zstd 7 s, sha256 of the .zst 3 s, the plain one 8 s). It is
	# checked against manifest.zst.json (and zstd checks its frame checksum),
	# the result's size against manifest.json. zstd is a 1 MB package.
	if pkg zstd; then
		z=$(get "$B/$ver/manifest.zst.json" | tr -d ' \n\r\t') || z=
		case $z in *"\"$p\":{"*) z=${z#*\"$p\":\{}; z=${z%%\}*} ;; *) z= ;; esac
		z=$(printf %s "$z" | sed -n 's/.*"checksum":"\([0-9a-f]\{64\}\)".*/\1/p')
		if [ -n "$z" ]; then
			url=$url.zst sum=$z what=archive
			unpack() { zstd -dcq; }
		fi
	fi ;;
opencode)
	# pigz (zlib's inflate) unpacks the 120 MB tarball in 8 s, busybox's
	# gunzip in 21 s. pigz is a 0.1 MB package.
	if pkg pigz; then
		unpack() { pigz -dc | { tar -xOf - package/bin/opencode && cat >/dev/null; }; }
	fi ;;
esac

# --- download, unpack, check -------------------------------------------------
part=$dir/$file.kw-part.$$
tmp=$(mktemp -d) || die "mktemp failed"
pp= hp=
# The pipeline runs in the background so that a signal to this shell alone
# (kill, timeout) interrupts the wait at once; the trap then stops it.
cleanup() {
	[ -z "$pp" ] || { pkill -P "$pp"; kill "$pp"; } 2>/dev/null
	[ -z "$hp" ] || kill "$hp" 2>/dev/null
	rm -rf "$part" "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT HUP
trap 'exit 143' TERM
mkfifo "$tmp/fifo" || die "mkfifo failed"
${hash}sum < "$tmp/fifo" > "$tmp/sum" &
hp=$!
say "installing $tool $ver ($url)"
if [ $what = archive ]; then
	(get "$url" | tee "$tmp/fifo" | unpack > "$part") &
else
	(get "$url" | unpack | tee "$tmp/fifo" > "$part") &
fi
pp=$!
wait $pp
rc=$?
pp=
wait $hp
hp=
[ $rc = 0 ] || die "download failed: $url"
got=$(cut -d' ' -f1 "$tmp/sum")
if [ -n "$sum" ] && [ "$got" != "$sum" ]; then
	die "$hash mismatch for $url (got ${got%"${got#????????????????}"}...); not installed"
fi
[ -z "$exact" ] || [ "$(stat -c %s "$part")" = "$size" ] || die "size mismatch for $url; not installed"
[ "$(head -c 4 "$part" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] || die "$url: not an ELF program; not installed"
chmod 755 "$part"
mv -f "$part" "$dir/$file" || die "cannot move it into $dir"
if [ "$dir/$file" != "$link" ]; then
	ln -sfn "$dir/$file" "$bin/.$tool.kw-link.$$" && mv -f "$bin/.$tool.kw-link.$$" "$link" ||
		die "cannot link $link"
fi
rm -rf "$tmp"
trap - EXIT INT HUP TERM
say "installed $link"
run "$@"
