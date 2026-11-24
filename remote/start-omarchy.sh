#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Starts the Omarchy image (niri desktop) in remote mode on its OWN data disk, work
# directory and port (the Linux and macOS counterpart of start-omarchy.ps1). The image
# is the installed version's own, so this follows every update. Beside the install
# directory (the one holding versions/): data/img/omarchy.img and data/work-omarchy.
# In the guest, run `omarchy desktop` (remote mode has no virgl: niri renders in software).
#
#   sh start-omarchy.sh [--port 8791] [--no-open]

set -eu
fail() { printf 'unkernel remote: %s\n' "$*" >&2; exit 2; }

PORT=8791 OPEN=1
while [ $# -gt 0 ]; do
	case $1 in
		--port) [ $# -ge 2 ] || fail "--port needs a value"; PORT=$2; shift ;;
		--no-open) OPEN=0 ;;
		-h|--help) echo "usage: start-omarchy.sh [--port N] [--no-open]"; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
	shift
done

here=$(cd "$(dirname "$0")" && pwd -P)
if [ -f "$here/current.txt" ]; then
	app=$here
	cur=$(tr -d ' \r\n\t' < "$here/current.txt")
	case $cur in ''|*[!A-Za-z0-9._-]*) fail "current.txt does not name a version: run update.sh" ;; esac
	version=$app/versions/$cur
else
	version=$(dirname "$here")
	app=$(dirname "$(dirname "$version")")
fi
root=$(dirname "$app")
image=
for f in "$version"/web/.output/public/distros/omarchy-*.erofs; do [ -f "$f" ] && image=$f && break; done
[ -n "$image" ] || fail "this version has no Omarchy image: run update.sh for a release that has it"

mkdir -p "$root/data/img" "$root/data/work-omarchy"
url="http://127.0.0.1:$PORT/?remote=1&distro=omarchy"
echo "Omarchy ($(basename "$image")): $url"
if [ "$OPEN" = 1 ]; then
	(
		i=0
		while [ $i -lt 90 ]; do
			if command -v curl >/dev/null 2>&1 && curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
				if command -v open >/dev/null 2>&1; then open "$url"; else xdg-open "$url" >/dev/null 2>&1 || true; fi
				break
			fi
			i=$((i + 1)); sleep 1
		done
	) &
fi
exec sh "$version/remote/start.sh" --data "$root/data/img/omarchy.img" --work "$root/data/work-omarchy" --port "$PORT" --no-open
