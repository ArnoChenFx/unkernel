#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# vtest-check.sh with every byte through a page in headless Chromium:
#
#   Mesa -> unix socket -> vtest-bridge bridge -> WebSocket -> page (gl/bridge)
#        -> renderer, one of
#   --wasm   virglrenderer compiled to wasm (gl/wasm/build.sh) on the page's
#            WebGL2 context (ANGLE on SwiftShader here)
#   relay    (the default) the stand-in: WebSocket -> vtest-bridge helper ->
#            unix socket -> virgl_test_server
#
#   test/gl/bridge-check.sh [--wasm] [--glcheck|--glcount] [--strict-waits] [--server PATH]
#                           [--single] [--loose] [--keep] [--transport websocket] [TEST...]
#
# Starts the renderer side (relay: the server, configured as vtest-check.sh
# configures its own, and the helper), the bridge and Chromium, runs
# vtest-check.sh --socket on the bridge's socket with TEST (default: all of
# its tests), checks the logs of the server, the bridge and the page, and
# tears everything down. --single and --loose are vtest-check.sh's, for the
# server of the relay. --transport websocket makes the page use WebSocket in
# place of WebSocketStream. --strict-waits (--wasm) has the renderer answer
# busy waits as vtest does (KW_VIRGL_STRICT_WAIT). --glcheck (--wasm) logs every WebGL call that
# raises an error, slowly; --glcount the calls made most often (both fail
# bridge-log by design). CHROMIUM names the browser (default:
# chromium-headless, else Playwright's headless shell). Needs: what
# vtest-check.sh needs, cc, chromium-headless; --wasm: the module in
# $KW_BUILD/gl-wasm (default vendor/build/gl-wasm).
#
# With --wasm the page's log (the renderer's stderr included) is the server
# log: every line of it that is not routine fails bridge-log. state's
# reference, the same clients each run alone, comes from a second page with
# a fresh wasm renderer (vtest-check.sh --ref-socket): the multi-context
# native renderer rasterizes on another GL, so its checksums need not match.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
build=${KW_BUILD:-$root/vendor/build}
server=$build/gl-native/vtest/virgl_test_server
[ -x "$server" ] || server=$(command -v virgl_test_server || true)
loose=0 keep=0 wasm=0 single=() pass=() tests=() query=""
while [ $# -gt 0 ]; do
	case $1 in
	--wasm) wasm=1 ;;
	--glcheck) query+="&glcheck=1" ;;
	--glcount) query+="&glcount=1" ;;
	--server) server=$2; shift ;;
	--single) single=(--single-gl-context) ;;
	--loose) loose=1; pass+=(--loose) ;;
	--keep) keep=1; pass+=(--keep) ;;
	--transport) query+="&transport=$2"; shift ;;
	--strict-waits) query+="&wait=strict" ;;
	-*) pass+=("$1") ;;
	*) tests+=("$1") ;;
	esac
	shift
done
# the reference server of state, and the relay's server
[ -x "$server" ] || { echo "no virgl_test_server (gl/wasm/build.sh native, or pass --server)"; exit 2; }
[ $wasm = 0 ] || [ -s "$build/gl-wasm/virgl.wasm" ] || { echo "no wasm renderer in $build/gl-wasm (gl/wasm/build.sh)"; exit 2; }
chromium=${CHROMIUM:-$(command -v chromium-headless || ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/headless_shell 2>/dev/null | tail -1)}
[ -x "$chromium" ] || { echo "no Chromium (dnf install chromium-headless, or set CHROMIUM)"; exit 2; }

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

# the page's files, and the module next to them
www=$root/gl/bridge
if [ $wasm = 1 ]; then
	www=$work/www
	mkdir -p "$www"
	ln -s "$root"/gl/bridge/*.html "$root"/gl/bridge/*.js "$build/gl-wasm/virgl.mjs" "$build/gl-wasm/virgl.wasm" "$www/"
	query+="&renderer=wasm"
else
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
	query+="&renderer=relay&relay=ws://127.0.0.1:$(cat "$work/helper.port")/"
fi

page() { # name: a bridge on $work/NAME.sock and a browser with its page
	local n=$1
	"$work/vtest-bridge" bridge --socket "$work/$n.sock" --www "$www" \
		--port-file "$work/$n.port" -v >"$work/$n.log" 2>&1 &
	pids+=($!)
	wait_for '[ -s "$work/$n.port" ]' 5 || fail "$n did not start"
	setsid "$chromium" --no-sandbox --headless --use-angle=swiftshader --enable-unsafe-swiftshader \
		--user-data-dir="$work/chrome-$n" --no-first-run --enable-logging=stderr \
		"http://127.0.0.1:$(cat "$work/$n.port")/index.html?${query#&}" >"$work/chrome-$n.log" 2>&1 &
	pids=(-$! "${pids[@]}") # the browser's process group first
}
page bridge
refs=()
if [ $wasm = 1 ] && { [ ${#tests[@]} = 0 ] || [[ " ${tests[*]} " == *" state "* ]]; }; then
	page ref
	refs=(--ref-socket "$work/ref.sock")
fi
# a bridge creates its socket once its page has the renderer ready
wait_for '[ -S "$work/bridge.sock" ] && { [ ${#refs[@]} = 0 ] || [ -S "$work/ref.sock" ]; }' 60 ||
	fail "the page did not get ready"
grep -h 'page: ready' "$work/bridge.log"

fails=0
# a server stuck in a busy wait would hang the clients, and their timeouts with them
timeout -k 10 900 "$here/vtest-check.sh" --server "$server" --socket "$work/bridge.sock" \
	${refs[@]+"${refs[@]}"} ${pass[@]+"${pass[@]}"} ${tests[@]+"${tests[@]}"} || fails=$((fails + 1))

report() { # name, unexpected lines
	local n; n=$(printf '%s' "$2" | grep -c .)
	if [ "$n" = 0 ]; then echo "PASS $1  0 unexpected lines"; else
		echo "FAIL $1  $n unexpected lines"; printf '%s\n' "$2" | sort | uniq -c | sort -rn | head -10
		fails=$((fails + 1))
	fi
}
routine='listening on\|page connected\|page: ready\|ready: vtest clients\|: open$\|hung up\|closed after'
report bridge-log "$(grep -v "$routine" "$work/bridge.log")"
if [ $wasm = 1 ]; then
	[ ${#refs[@]} = 0 ] || report ref-log "$(grep -v "$routine" "$work/ref.log")"
else
	report helper-log "$(grep -v "$routine" "$work/helper.log")"
	report server-log "$(log_errors "$work/server.log")"
fi
[ $fails = 0 ] || keep=1
exit $((fails > 0))
