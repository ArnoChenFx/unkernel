#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Starts the remote kernel backend with the system Bun (1.4.5 or newer): the
# Linux and macOS counterpart of start-windows.ps1. Run from an install made by
# update.sh (the installed bundle) or from a source checkout with a built page
# (remote/cli.ts). From the install directory it starts the current version.
#
#   sh start.sh [--data FILE] [--work DIR|none] [--cache DIR] [--port N] [--config FILE] [--no-net] [--no-open]
#
# It ends in `exec bun`, so Ctrl+C (SIGINT) goes straight to the backend, which
# saves the guest's disk and releases the data disk's lock before it exits.

set -eu

MIN_BUN=1.4.5

fail() { printf 'unkernel remote: %s\n' "$*" >&2; exit 2; }

# An install directory: start the current version.
here=$(cd "$(dirname "$0")" && pwd -P)
if [ -f "$here/current.txt" ] && [ -d "$here/versions" ]; then
	cur=$(tr -d ' \r\n\t' < "$here/current.txt")
	case $cur in ''|*[!A-Za-z0-9._-]*) fail "$here/current.txt does not name a version: run update.sh" ;; esac
	[ -f "$here/versions/$cur/remote/start.sh" ] || fail "version $cur is not installed: run update.sh"
	exec sh "$here/versions/$cur/remote/start.sh" "$@"
fi

repo=$(dirname "$here")

# Paths are made absolute here, because the backend runs in the install.
abs() {
	case $1 in
		none|/*) printf '%s' "$1" ;;
		*) printf '%s' "$PWD/$1" ;;
	esac
}

DATA= WORK= CACHE= PORT= CONFIG= NONET=0 OPEN=1
while [ $# -gt 0 ]; do
	a=$1
	case $a in
		--*=*) shift; set -- "${a%%=*}" "${a#*=}" "$@"; a=$1 ;;
	esac
	case $a in
		-h|--help)
			echo "usage: start.sh [--data FILE] [--work DIR|none] [--cache DIR] [--port N] [--config FILE] [--no-net] [--no-open]"
			exit 0 ;;
		--data|--work|--cache|--port|--config)
			[ $# -ge 2 ] || fail "$a needs a value"
			case $a in
				--data) DATA=$(abs "$2") ;;
				--work) WORK=$(abs "$2") ;;
				--cache) CACHE=$(abs "$2") ;;
				--port) PORT=$2 ;;
				--config) CONFIG=$(abs "$2") ;;
			esac
			shift ;;
		--no-net) NONET=1 ;;
		--no-open) OPEN=0 ;;
		*) fail "unknown option: $a (see --help)" ;;
	esac
	shift
done

# An install's settings file, next to versions/, when --config is not given.
versions=$(dirname "$repo")
if [ -z "$CONFIG" ] && [ "$(basename "$versions")" = versions ] && [ -f "$(dirname "$versions")/unkernel-remote.json" ]; then
	CONFIG=$(dirname "$versions")/unkernel-remote.json
fi
command -v bun >/dev/null 2>&1 || fail "Bun is not installed: get it from https://bun.sh (curl -fsSL https://bun.sh/install | bash), then run this again."
have=$(bun --version 2>/dev/null | head -n 1)
ok=$(awk -v have="$have" -v want="$MIN_BUN" 'BEGIN {
	n = split(have, h, /[.-]/); split(want, w, ".")
	for (i = 1; i <= 3; i++) { a = h[i] + 0; b = w[i] + 0; if (a > b) { print 1; exit } if (a < b) { print 0; exit } }
	print 1 }')
[ "$ok" = 1 ] || fail "Bun $MIN_BUN or newer is needed, found ${have:-an unknown version}: run bun upgrade."

cd "$repo"
if [ -f remote/unkernel-remote.js ]; then
	[ -d web/.output/public/assets ] || fail "this install is incomplete (web/.output/public is missing): run update.sh again"
	set -- bun remote/unkernel-remote.js
else
	[ -d web/.output/public/assets ] || fail "no page at web/.output/public: build it first (pnpm build:web), or install a release with update.sh"
	set -- bun --bun remote/cli.ts
fi
[ -z "$DATA" ] || set -- "$@" --data "$DATA"
[ -z "$WORK" ] || set -- "$@" --work "$WORK"
[ -z "$CACHE" ] || set -- "$@" --cache "$CACHE"
[ -z "$PORT" ] || set -- "$@" --port "$PORT"
[ -z "$CONFIG" ] || set -- "$@" --config "$CONFIG"
[ "$NONET" = 0 ] || set -- "$@" --no-net
[ "$OPEN" = 0 ] || set -- "$@" --open
exec "$@"
