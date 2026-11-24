#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Installs and updates the remote kernel backend from a release of the fork,
# then starts it (remote/README.md): the Linux and macOS counterpart of
# update.ps1, with the same layout and rules. The release's manifest.json lists
# every file of the install with its sha256; a file already installed with that
# hash is reused, an archive is downloaded only when one of its files changed,
# and every download is checked before anything is installed.
#
#   curl -fsSL https://github.com/ArnoChenFx/unkernel/releases/latest/download/update.sh | sh
#   sh update.sh [-d DIR] [--check] [--no-update] [--no-start] [--force] [--tag TAG]
#                [--data FILE] [--work DIR] [--cache DIR] [--port N] [--config FILE] [--no-net] [--no-open]
#
# Under DIR (default $UNKERNEL_APP, else ~/.unkernel/app):
#   versions/<tag>/   one complete install, at the paths of the repository, with its manifest.json
#   current.txt       the tag that runs; replaced by a rename
#   update.sh, start.sh  the launchers (update.sh hands over to versions/<tag>/remote/update.sh)
#   downloads/        the verified archives of the update in progress
# The install is assembled in partial-<tag>/ and renamed into versions/, so a
# failed update leaves the running version alone. The data directory
# (~/.unkernel/remote) is never touched.
#
# Needs sh, curl or wget, sha256sum or shasum, and unzip (or bsdtar, tar on macOS, or python3).
# Starting needs Bun 1.4.5 or newer (start.sh).

set -eu

REPO=ArnoChenFx/unkernel
API_BASE=https://api.github.com
DOWNLOAD_BASE=https://github.com
UA=unkernel-remote-update
DIR=
TAG=
CHECK=0
NO_UPDATE=0
NO_START=0
FORCE=0
FWD_DATA=
FWD_WORK=
FWD_CACHE=
FWD_PORT=
FWD_CONFIG=
FWD_NONET=0
FWD_NOOPEN=0

say() { printf '[update] %s\n' "$*"; }
die() { printf '[update] %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'USAGE'
usage: update.sh [-d DIR] [--check] [--no-update] [--no-start] [--force] [--tag TAG]
                 [--repo OWNER/NAME] [--data FILE] [--work DIR|none] [--cache DIR]
                 [--port N] [--config FILE] [--no-net] [--no-open]
The install directory is DIR, $UNKERNEL_APP or ~/.unkernel/app.
USAGE
}

parse() {
	while [ $# -gt 0 ]; do
		a=$1
		case $a in
			--*=*) shift; set -- "${a%%=*}" "${a#*=}" "$@"; a=$1 ;;
		esac
		need() { [ $# -ge 2 ] || die "$a needs a value"; }
		case $a in
			-h|--help) usage; exit 0 ;;
			-d|--dir) need "$@"; DIR=$2; shift ;;
			--repo) need "$@"; REPO=$2; shift ;;
			--tag) need "$@"; TAG=$2; shift ;;
			--api-base) need "$@"; API_BASE=$2; shift ;;
			--download-base) need "$@"; DOWNLOAD_BASE=$2; shift ;;
			--check) CHECK=1 ;;
			--no-update) NO_UPDATE=1 ;;
			--no-start) NO_START=1 ;;
			--force) FORCE=1 ;;
			--data) need "$@"; FWD_DATA=$2; shift ;;
			--work) need "$@"; FWD_WORK=$2; shift ;;
			--cache) need "$@"; FWD_CACHE=$2; shift ;;
			--port) need "$@"; FWD_PORT=$2; shift ;;
			--config) need "$@"; FWD_CONFIG=$2; shift ;;
			--no-net) FWD_NONET=1 ;;
			--no-open) FWD_NOOPEN=1 ;;
			*) usage >&2; die "unknown option: $a" ;;
		esac
		shift
	done
}
parse "$@"

HOME_DIR=${HOME:-}
[ -n "$HOME_DIR" ] || die "HOME is not set"
[ -n "$DIR" ] || DIR=${UNKERNEL_APP:-$HOME_DIR/.unkernel/app}
case $DIR in /*) ;; *) DIR=$PWD/$DIR ;; esac
mkdir -p "$DIR"
APP=$(cd "$DIR" && pwd -P)
mkdir -p "$HOME_DIR/.unkernel"
DATA_DIR=$(cd "$HOME_DIR/.unkernel" && pwd -P)/remote
case $APP in
	"$DATA_DIR"|"$DATA_DIR"/*) die "the install directory ($APP) must not be the data directory ($DATA_DIR)" ;;
esac

# --- helpers -----------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

if have curl; then
	fetch() { curl -fsSL -A "$UA" -o "$2" "$1"; }
elif have wget; then
	fetch() { wget -q -U "$UA" -O "$2" "$1"; }
else
	die "curl or wget is needed"
fi

if have sha256sum; then
	sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif have shasum; then
	sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
	die "sha256sum or shasum is needed"
fi

size_of() { wc -c < "$1" | tr -d ' '; }

# The file exists with this size and sha256.
check_file() {
	[ -f "$1" ] || return 1
	[ "$(size_of "$1")" = "$2" ] || return 1
	[ "$(sha256_of "$1")" = "$3" ]
}

format_size() {
	awk -v b="$1" 'BEGIN { if (b >= 1048576) printf "%.1f MiB", b / 1048576; else printf "%d KiB", b / 1024 }'
}

safe_relative() {
	case $1 in
		''|/*|*\\*|[A-Za-z]:*|./*|../*|*/./*|*/../*|*//*|*/.|*/..|.|..|*/) return 1 ;;
	esac
	return 0
}

unzip_all() {
	if have unzip; then unzip -q -o "$1" -d "$2"
	elif have bsdtar; then bsdtar -xf "$1" -C "$2"
	elif tar --version 2>/dev/null | grep -qi bsdtar; then tar -xf "$1" -C "$2"
	elif have python3; then python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
	else die "unzip (or bsdtar, or python3) is needed to unpack the archives"
	fi
}

# Hard link when possible, a copy otherwise.
copy_installed() {
	mkdir -p "$(dirname "$2")"
	ln "$1" "$2" 2>/dev/null || cp -p "$1" "$2"
}

installed_version() {
	[ -f "$APP/current.txt" ] || return 0
	name=$(tr -d ' \r\n\t' < "$APP/current.txt")
	case $name in ''|*[!A-Za-z0-9._-]*) return 0 ;; esac
	[ -d "$APP/versions/$name" ] && printf '%s' "$name"
	return 0
}

LOCK=$APP/update.lock
LOCKED=0
enter_lock() {
	attempt=0
	while [ $attempt -lt 2 ]; do
		if (set -C; printf '%s' "$$" > "$LOCK") 2>/dev/null; then
			LOCKED=1
			return 0
		fi
		holder=$(cat "$LOCK" 2>/dev/null || true)
		case $holder in
			''|*[!0-9]*) ;;
			*) if kill -0 "$holder" 2>/dev/null; then die "another update is running (process $holder)"; fi ;;
		esac
		rm -f "$LOCK"
		attempt=$((attempt + 1))
	done
	die "cannot take $LOCK"
}
exit_lock() {
	if [ "$LOCKED" = 1 ]; then rm -f "$LOCK"; LOCKED=0; fi
}
cleanup() { exit_lock; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# --- the install ---------------------------------------------------------------

# The newest release named remote-v* that is neither a draft nor a prerelease.
latest_tag() {
	list=$APP/downloads/releases.json
	fetch "$API_BASE/repos/$REPO/releases?per_page=30" "$list" || die "cannot read the releases of $REPO"
	picked=$(tr -d '\r\n' < "$list" | tr '{' '\n' | awk '
		/"tag_name" *: *"remote-v[^"]*"/ && !/"draft" *: *true/ && !/"prerelease" *: *true/ {
			s = $0; sub(/.*"tag_name" *: *"/, "", s); sub(/".*/, "", s); print s; exit
		}')
	rm -f "$list"
	[ -n "$picked" ] || die "no remote-v* release in $REPO"
	printf '%s' "$picked"
}

# Reads a manifest into lines: "F path size sha256 asset" and "A name kind size sha256 url" (tab separated),
# and "H format product tag".
read_manifest() {
	tr -d '\r\n' < "$1" | tr '{' '\n' | awk -F '\t' '
		function sv(k,   s) {
			if (match($0, "\"" k "\" *: *\"[^\"]*\"")) { s = substr($0, RSTART, RLENGTH); sub(/^[^:]*: *"/, "", s); sub(/"$/, "", s); return s }
			return ""
		}
		function nv(k,   s) {
			if (match($0, "\"" k "\" *: *[0-9]+")) { s = substr($0, RSTART, RLENGTH); sub(/^[^:]*: */, "", s); return s }
			return ""
		}
		/"format" *:/ && /"product" *:/ { print "H\t" nv("format") "\t" sv("product") "\t" sv("tag") }
		/"path" *: *"/ { print "F\t" sv("path") "\t" nv("size") "\t" sv("sha256") "\t" sv("asset") }
		/"kind" *: *"/ && /"name" *: *"/ { print "A\t" sv("name") "\t" sv("kind") "\t" nv("size") "\t" sv("sha256") "\t" sv("url") }
	'
}

get_asset() { # name kind size sha256 url -> prints the path of the verified download
	cached=$APP/downloads/$1
	if check_file "$cached" "$3" "$4"; then printf '%s' "$cached"; return 0; fi
	say "downloading $1 ($(format_size "$3"))" >&2
	rm -f "$cached.partial"
	fetch "$5" "$cached.partial" || { rm -f "$cached.partial"; die "cannot download $1"; }
	if ! check_file "$cached.partial" "$3" "$4"; then
		rm -f "$cached.partial"
		die "$1 does not match its size or sha256 in the manifest"
	fi
	mv -f "$cached.partial" "$cached"
	printf '%s' "$cached"
}

install_launchers() {
	for name in update.sh start.sh; do
		[ -f "$APP/$name" ] && continue
		[ -f "$1/remote/$name" ] && cp "$1/remote/$name" "$APP/$name"
	done
	# The Omarchy launcher follows each release: replaced every update.
	[ -f "$1/remote/start-omarchy.sh" ] && cp "$1/remote/start-omarchy.sh" "$APP/start-omarchy.sh"
	return 0
}

# Installs the release named by --tag (or the newest) and prints the version to run;
# nothing when only checking. Messages go to stderr.
update_install() {
	current=$1
	if [ "$NO_UPDATE" = 1 ]; then
		[ -n "$current" ] || die "nothing is installed yet (run without --no-update)"
		printf '%s' "$current"
		return 0
	fi
	mkdir -p "$APP/downloads"
	tag=$TAG
	[ -n "$tag" ] || tag=$(latest_tag)
	case $tag in ''|*[!A-Za-z0-9._-]*) die "unsafe release tag: $tag" ;; esac
	manifest_file=$APP/downloads/manifest-$tag.json
	fetch "$DOWNLOAD_BASE/$REPO/releases/download/$tag/manifest.json" "$manifest_file" || die "cannot download the manifest of $tag"
	table=$APP/downloads/manifest-$tag.tsv
	read_manifest "$manifest_file" > "$table"
	head=$(awk -F '\t' '$1 == "H" { print $2 "|" $3 "|" $4; exit }' "$table")
	[ "$head" = "1|unkernel-remote|$tag" ] || die "the manifest of $tag is not an unkernel-remote manifest of format 1 for $tag"

	need_list=$APP/downloads/need-$tag.txt
	: > "$need_list"
	keep_list=$APP/downloads/keep-$tag.tsv
	stale_list=$APP/downloads/stale-$tag.tsv
	: > "$keep_list"; : > "$stale_list"
	cur_dir=
	[ -z "$current" ] || cur_dir=$APP/versions/$current
	while IFS='	' read -r kind path size sha asset; do
		[ "$kind" = F ] || continue
		safe_relative "$path" || die "the manifest names an unsafe path: $path"
		awk -F '\t' -v a="$asset" '$1 == "A" && $2 == a { f = 1 } END { exit !f }' "$table" || die "$path names no asset in the manifest"
		if [ -n "$cur_dir" ] && check_file "$cur_dir/$path" "$size" "$sha"; then
			printf '%s\t%s\n' "$path" "$asset" >> "$keep_list"
		else
			printf '%s\t%s\t%s\t%s\n' "$path" "$size" "$sha" "$asset" >> "$stale_list"
		fi
	done < "$table"
	cut -f4 "$stale_list" | sort -u > "$need_list"
	count=$(wc -l < "$need_list" | tr -d ' ')
	bytes=0
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		s=$(awk -F '\t' -v a="$name" '$1 == "A" && $2 == a { print $4; exit }' "$table")
		bytes=$((bytes + s))
	done < "$need_list"

	nstale=$(wc -l < "$stale_list" | tr -d ' ')
	if [ "$current" = "$tag" ] && [ "$nstale" = 0 ] && [ "$FORCE" = 0 ]; then
		say "up to date: $tag" >&2
		rm -f "$manifest_file" "$table" "$need_list" "$keep_list" "$stale_list"
		[ "$CHECK" = 1 ] || printf '%s' "$tag"
		return 0
	fi
	if [ "$CHECK" = 1 ]; then
		say "update available: ${current:-nothing installed} -> $tag, $count download(s), $(format_size "$bytes")" >&2
		return 0
	fi

	say "installing $tag ($count download(s), $(format_size "$bytes"))" >&2
	for old in "$APP"/partial-*; do [ -e "$old" ] && rm -rf "$old"; done
	partial=$APP/partial-$tag
	mkdir -p "$partial"
	if ! install_partial; then
		rm -rf "$partial"
		return 1
	fi
	cp "$manifest_file" "$partial/manifest.json"

	target=$APP/versions/$tag
	old_dir=
	if [ -e "$target" ]; then
		old_dir=$target.old-$$
		mv "$target" "$old_dir"
	fi
	mv "$partial" "$target" || die "cannot move the install into place"
	printf '%s' "$tag" > "$APP/current.txt.tmp"
	mv -f "$APP/current.txt.tmp" "$APP/current.txt"
	[ -z "$old_dir" ] || rm -rf "$old_dir"
	install_launchers "$target"
	rm -rf "$APP/downloads"
	for dir in "$APP"/versions/*; do
		[ -d "$dir" ] || continue
		n=$(basename "$dir")
		[ "$n" = "$tag" ] || [ "$n" = "$current" ] || rm -rf "$dir"
	done
	say "installed $tag" >&2
	printf '%s' "$tag"
}

# Fills $partial from the kept files, the archives and the manifest lists; returns 1 after saying why.
install_partial() {
	while IFS='	' read -r path asset; do
		[ -n "$path" ] || continue
		copy_installed "$cur_dir/$path" "$partial/$path" || { say "cannot copy $path" >&2; return 1; }
	done < "$keep_list"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		line=$(awk -F '\t' -v a="$name" '$1 == "A" && $2 == a { print $3 "\t" $4 "\t" $5 "\t" $6; exit }' "$table")
		akind=$(printf '%s' "$line" | cut -f1)
		asize=$(printf '%s' "$line" | cut -f2)
		asha=$(printf '%s' "$line" | cut -f3)
		aurl=$(printf '%s' "$line" | cut -f4)
		archive=$(get_asset "$name" "$akind" "$asize" "$asha" "$aurl") || return 1
		if [ "$akind" = distro ]; then
			while IFS='	' read -r path size sha a; do
				[ "$a" = "$name" ] || continue
				copy_installed "$archive" "$partial/$path" || return 1
			done < "$stale_list"
		else
			ex=$APP/downloads/extract-$name
			rm -rf "$ex"; mkdir -p "$ex"
			unzip_all "$archive" "$ex" || { say "cannot unpack $name" >&2; return 1; }
			while IFS='	' read -r path size sha a; do
				[ "$a" = "$name" ] || continue
				[ -f "$ex/$path" ] || { say "$path is not in $name" >&2; return 1; }
				mkdir -p "$(dirname "$partial/$path")"
				mv -f "$ex/$path" "$partial/$path"
			done < "$stale_list"
			rm -rf "$ex"
		fi
	done < "$need_list"
	while IFS='	' read -r kind path size sha asset; do
		[ "$kind" = F ] || continue
		check_file "$partial/$path" "$size" "$sha" || { say "$path does not match the manifest after the install" >&2; return 1; }
	done < "$table"
	return 0
}

start_backend() {
	script=$APP/versions/$1/remote/start.sh
	[ -f "$script" ] || die "$script is missing"
	set --
	[ -z "$FWD_DATA" ] || set -- "$@" --data "$FWD_DATA"
	[ -z "$FWD_WORK" ] || set -- "$@" --work "$FWD_WORK"
	[ -z "$FWD_CACHE" ] || set -- "$@" --cache "$FWD_CACHE"
	[ -z "$FWD_PORT" ] || set -- "$@" --port "$FWD_PORT"
	[ "$FWD_NONET" = 0 ] || set -- "$@" --no-net
	[ "$FWD_NOOPEN" = 0 ] || set -- "$@" --no-open
	if [ -n "$FWD_CONFIG" ]; then
		set -- "$@" --config "$FWD_CONFIG"
	elif [ -f "$APP/unkernel-remote.json" ]; then
		set -- "$@" --config "$APP/unkernel-remote.json"
	fi
	# exec: Ctrl+C reaches the backend itself, which saves the disk, and the lock is already released.
	exec sh "$script" "$@"
}

# update.sh in the install root only hands over to the updater of the installed version, so that
# the newest updater (which the release installs) does the work and the launcher never rewrites itself.
if [ -f "$0" ]; then
	self_dir=$(cd "$(dirname "$0")" && pwd -P)
	if [ "$self_dir" = "$APP" ]; then
		handover=$(installed_version)
		other=$APP/versions/$handover/remote/update.sh
		if [ -n "$handover" ] && [ -f "$other" ]; then
			exec sh "$other" "$@"
		fi
	fi
fi

mkdir -p "$APP/versions"
CURRENT=$(installed_version)
enter_lock
mkdir -p "$APP/downloads"
rc=0
TO_START=$(update_install "$CURRENT") || rc=$?
exit_lock
if [ "$rc" != 0 ]; then
	if [ "$CHECK" = 1 ] || [ -z "$CURRENT" ]; then
		exit 1
	fi
	say "starting the installed version $CURRENT"
	TO_START=$CURRENT
fi
if [ "$CHECK" = 1 ] || [ "$NO_START" = 1 ] || [ -z "$TO_START" ]; then exit 0; fi
start_backend "$TO_START"
