#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# vtest-check.sh with every byte through vtest-bridge's stream link, the
# link the guest's bridge uses over kwvsock (a unix socket here):
#
#   Mesa -> unix socket -> vtest-bridge bridge --link unix:... -> stream
#        -> stream-relay.js (js/core/gl-stream.ts, the relay renderer)
#        -> WebSocket -> vtest-bridge helper -> unix socket -> virgl_test_server
#
#   test/gl/stream-check.sh [--server PATH] [--single] [--loose] [--keep]
#                           [--guest] [TEST...]
#
# Starts the server (configured as vtest-check.sh configures its own), the
# helper, stream-relay.js and the bridge, runs vtest-check.sh --socket on
# the bridge's socket with TEST (default: all of its tests), checks the
# logs and tears everything down. --single and --loose are vtest-check.sh's,
# for the server here. --guest runs the guest's build of the bridge
# (gl/bridge/build-guest.sh: static aarch64-linux-musl, stream link only)
# under qemu-aarch64 user mode (QEMU names it). Needs: what vtest-check.sh
# needs, cc, node; with --guest zig (guest/lib/env.sh) and qemu-aarch64.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
server=${KW_BUILD:-$root/vendor/build}/gl-native/vtest/virgl_test_server
[ -x "$server" ] || server=$(command -v virgl_test_server || true)
loose=0 keep=0 guest=0 single=() pass=()
while [ $# -gt 0 ]; do
	case $1 in
	--server) server=$2; shift ;;
	--single) single=(--single-gl-context) ;;
	--loose) loose=1; pass+=(--loose) ;;
	--keep) keep=1; pass+=(--keep) ;;
	--guest) guest=1 ;;
	*) pass+=("$1") ;;
	esac
	shift
done
[ -x "$server" ] || { echo "no virgl_test_server (build it or pass --server)"; exit 2; }
qemu=${QEMU:-$(command -v qemu-aarch64 || true)}
[ $guest = 0 ] || [ -x "$qemu" ] || { echo "no qemu-aarch64 (set QEMU)"; exit 2; }

# the server's configuration and the log filter, from vtest-check.sh
eval "$(sed -n '/^deny="/,/"$/p; /^log_errors()/,/^}/p' "$here/vtest-check.sh")"
[ -n "${deny:-}" ] && declare -F log_errors >/dev/null || { echo "cannot read vtest-check.sh"; exit 2; }
override=""
[ $loose = 1 ] || for e in $deny; do override+="-GL_$e "; done

work=$(mktemp -d /tmp/kwgl.XXXXXX)
pids=()
cleanup() {
	for p in "${pids[@]}"; do kill -- "$p" 2>/dev/null; done
	wait 2>/dev/null
	[ $keep = 1 ] && echo "kept: $work" || rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "$1"; keep=1; for f in "$work"/*.log; do echo "== $f"; tail -20 "$f"; done; exit 2; }
wait_for() { # test, seconds
	for _ in $(seq $(($2 * 10))); do eval "$1" && return 0; sleep 0.1; done
	return 1
}

cc -O2 -Wall -o "$work/vtest-bridge" "$root/gl/bridge/vtest-bridge.c" || fail "cannot build vtest-bridge"
bridge=("$work/vtest-bridge")
if [ $guest = 1 ]; then
	"$root/gl/bridge/build-guest.sh" "$work/vtest-bridge-aarch64" || fail "cannot build the guest's vtest-bridge"
	file "$work/vtest-bridge-aarch64" 2>/dev/null | sed 's/^[^:]*: /guest bridge: /'
	bridge=("$qemu" "$work/vtest-bridge-aarch64")
fi

env -u DISPLAY LIBGL_ALWAYS_SOFTWARE=1 MESA_GLES_VERSION_OVERRIDE=3.0 \
	MESA_EXTENSION_OVERRIDE="$override" ${VTEST_ENV:-} \
	"$server" --use-egl-surfaceless --use-gles --no-fork --multi-clients \
	"${single[@]}" --socket-path "$work/server.sock" >"$work/server.log" 2>&1 &
pids+=($!)
wait_for '[ -S "$work/server.sock" ]' 5 || fail "server did not start"

"$work/vtest-bridge" helper --server "$work/server.sock" --port-file "$work/helper.port" -v \
	>"$work/helper.log" 2>&1 &
pids+=($!)
wait_for '[ -s "$work/helper.port" ]' 5 || fail "helper did not start"

node "$here/stream-relay.js" --listen "$work/link.sock" --relay "ws://127.0.0.1:$(cat "$work/helper.port")/" \
	>"$work/relay.log" 2>&1 &
pids+=($!)
wait_for '[ -S "$work/link.sock" ]' 10 || fail "stream-relay did not start"

"${bridge[@]}" bridge --link "unix:$work/link.sock" --socket "$work/bridge.sock" -v >"$work/bridge.log" 2>&1 &
pids+=($!)
# the bridge creates its socket once the far side says it is ready
wait_for '[ -S "$work/bridge.sock" ]' 10 || fail "the bridge did not get ready"
grep 'link connected' "$work/bridge.log"

fails=0
timeout -k 10 900 "$here/vtest-check.sh" --server "$server" --socket "$work/bridge.sock" ${pass[@]+"${pass[@]}"} ||
	fails=$((fails + 1))

report() { # name, unexpected lines
	local n; n=$(printf '%s' "$2" | grep -c .)
	if [ "$n" = 0 ]; then echo "PASS $1  0 unexpected lines"; else
		echo "FAIL $1  $n unexpected lines"; printf '%s\n' "$2" | sort | uniq -c | sort -rn | head -10
		fails=$((fails + 1))
	fi
}
routine='listening on\|page connected\|link connected\|ready: vtest clients\|: open$\|hung up\|closed after'
report bridge-log "$(grep -v "$routine" "$work/bridge.log")"
report helper-log "$(grep -v "$routine" "$work/helper.log")"
# (the bridge's own lines come over the link too, as "bridge: ...")
report relay-log "$(grep -v 'stream-relay: renderer: relay\|bridge connected' "$work/relay.log" | grep -v "$routine")"
report server-log "$(log_errors "$work/server.log")"
[ $fails = 0 ] || keep=1
exit $((fails > 0))
