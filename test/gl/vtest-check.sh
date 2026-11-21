#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Headless check of a virglrenderer build on this host, no unkernel involved:
# Mesa's virgl driver (GALLIUM_DRIVER=virpipe) talks the vtest protocol to
# virgl_test_server, whose host GL is llvmpipe held to GLES 3.0 with the
# extensions WebGL2 lacks disabled (as far as Mesa lets them be disabled).
#
#   test/gl/vtest-check.sh [--server PATH] [--single] [--fork] [--loose] [--keep]
#                          [--socket PATH] [--ref-socket PATH] [TEST...]
#
# TEST: info es2 gl sdl weston multi state (default: all). One server process
# serves every client (--no-fork), as the renderer in the page will; --fork
# gives each client a server process of its own instead. multi's
# screenshot wants a look (--keep): the check only knows that six clients
# drew something. state runs kwgl-state.c: clients with different GL state
# take turns, and each frame must equal the same client's frame when it runs
# alone on a multi-context server started for the comparison.
# --single puts every renderer context on one GL context, as WebGL2 needs
# (--single-gl-context, from gl/patches/virglrenderer). --loose leaves
# the host's extensions alone. --keep leaves the work directory (logs,
# screenshots, the state frames). VTEST_ENV adds environment to the server.
# --socket uses the vtest socket PATH (a bridge, say) in place of starting a
# server; checking that server's log is then the caller's job. --ref-socket
# gives state its reference renderer in place of the multi-context server.
# The default server is the build of gl/patches/virglrenderer that
# `gl/wasm/build.sh native` makes.
# Needs: virgl_test_server, Xvfb, glmark2, eglinfo, neverball, weston,
# xdotool, ImageMagick, cc with EGL and GLES 3 headers (Fedora:
# virglrenderer-test-server glmark2 weston xorg-x11-server-Xvfb egl-utils
# neverball-neverball xdotool ImageMagick gcc libglvnd-devel).
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
server=${KW_BUILD:-$root/vendor/build}/gl-native/vtest/virgl_test_server
[ -x "$server" ] || server=$(command -v virgl_test_server || true)
loose=0 keep=0 single=() fork=--no-fork socket= ref_socket= tests=()
while [ $# -gt 0 ]; do
	case $1 in
	--server) server=$2; shift ;;
	--single) single=(--single-gl-context) ;;
	--fork) fork= ;;
	--loose) loose=1 ;;
	--keep) keep=1 ;;
	--socket) socket=$2; shift ;;
	--ref-socket) ref_socket=$2; shift ;;
	*) tests+=("$1") ;;
	esac
	shift
done
[ ${#tests[@]} -gt 0 ] || tests=(info es2 gl sdl weston multi state)
[ -x "$server" ] || { echo "no virgl_test_server (gl/wasm/build.sh native, or pass --server)"; exit 2; }
{ [ -n "$socket" ] && [ -n "$ref_socket" ]; } || echo "server: $server"
case ${VTEST_ENV:-} in *KW_SINGLE_CTX*)
	echo "KW_SINGLE_CTX is gone: pass --single (or VTEST_ENV=VTEST_SINGLE_GL_CONTEXT=1)"; exit 2 ;;
esac

# Unix socket paths are limited to 108 bytes: keep the work directory short.
work=$(mktemp -d /tmp/kwgl.XXXXXX)
export XDG_RUNTIME_DIR=$work VTEST_SOCKET_NAME=${socket:-$work/vtest.sock} HOME=$work
chmod 700 "$work"

# Beyond WebGL2 and safely disabled in Mesa. BGRA8888, texture_border_clamp,
# KHR_debug, separate_shader_objects, NV_read_depth/stencil and OES_mapbuffer
# also are, but share one always-on flag in Mesa: disabling any of them
# disables all always-on extensions, so they stay.
deny="ARM_shader_framebuffer_fetch_depth_stencil EXT_EGL_image_storage
EXT_EGL_image_storage_compression EXT_conservative_depth EXT_copy_image
OES_copy_image EXT_memory_object EXT_memory_object_fd EXT_robustness
KHR_robustness KHR_robust_buffer_access_behavior EXT_sRGB_write_control
EXT_shader_framebuffer_fetch EXT_shader_framebuffer_fetch_non_coherent
EXT_shader_group_vote EXT_shader_integer_mix EXT_texture_filter_minmax
EXT_texture_mirror_clamp_to_edge EXT_texture_query_lod EXT_texture_sRGB_R8
EXT_texture_sRGB_RG8 EXT_texture_sRGB_decode EXT_texture_shadow_lod
KHR_blend_equation_advanced KHR_blend_equation_advanced_coherent
KHR_texture_compression_astc_ldr KHR_texture_compression_astc_sliced_3d
MESA_framebuffer_flip_y MESA_shader_integer_functions
NV_alpha_to_coverage_dither_control NV_conditional_render
NV_generate_mipmap_sRGB NV_sample_locations
NV_shader_noperspective_interpolation NV_texture_barrier OES_EGL_image
OES_EGL_image_external OES_EGL_image_external_essl3 OES_sample_shading
OES_sample_variables OES_shader_multisample_interpolation"
override=""
[ $loose = 1 ] || for e in $deny; do override+="-GL_$e "; done

pids=()
cleanup() {
	for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
	wait 2>/dev/null
	[ $keep = 1 ] && echo "kept: $work" || rm -rf "$work"
}
trap cleanup EXIT

d=90
while [ -e /tmp/.X$d-lock ]; do d=$((d + 1)); done
Xvfb :$d -screen 0 1280x720x24 >"$work/xvfb.log" 2>&1 &
pids+=($!)
export DISPLAY=:$d

start_server() { # socket log extra-args...
	local sock=$1 log=$2; shift 2
	env -u DISPLAY LIBGL_ALWAYS_SOFTWARE=1 MESA_GLES_VERSION_OVERRIDE=3.0 \
		MESA_EXTENSION_OVERRIDE="$override" ${VTEST_ENV:-} \
		"$server" --use-egl-surfaceless --use-gles $fork --multi-clients \
		"$@" --socket-path "$sock" >"$log" 2>&1 &
	pids+=($!)
	for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
	[ -S "$sock" ] || { echo "server did not start"; cat "$log"; exit 2; }
}
if [ -n "$socket" ]; then : >"$work/server.log" # and give Xvfb the time a server start would
	for _ in $(seq 50); do xdotool getdisplaygeometry >/dev/null 2>&1 && break; sleep 0.1; done
else start_server "$VTEST_SOCKET_NAME" "$work/server.log" "${single[@]}"; fi

guest() { LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=virpipe "$@"; }
log_errors() { # the lines of a server log that are not routine
	grep -v 'context created\|DISCONNECTED\|multi-clients\|ERROR_INPUT_READ\|cannot be disabled\|without ARB/KHR robustness' "$1"
}
fails=0
report() { # name ok detail
	if [ "$2" = 1 ]; then echo "PASS $1  $3"; else echo "FAIL $1  $3"; fails=$((fails + 1)); fi
}
# A screenshot counts when it is not flat: standard deviation above 2%.
lively() {
	import -window root "$1" 2>/dev/null || return 1
	awk -v s="$(identify -format '%[fx:standard_deviation]' "$1")" 'BEGIN { exit !(s > 0.02) }'
}
bench() { # log, binary, scenes...: and log.png, a frame from the middle of each scene
	local log=$1 bin=$2 args=() pid i=0 shots=(); shift 2
	for s in "$@"; do args+=(-b "$s:duration=2"); done
	guest timeout 120 "$bin" -s 640x480 "${args[@]}" >"$log" 2>&1 &
	pid=$!
	# a scene runs 2 s and prints its FPS when it ends: the frame is 1 s
	# after the previous scene's line (the header's, for the first)
	for s in "$@"; do
		for _ in $(seq 300); do
			if [ $i = 0 ]; then grep -q 'Surface Size' "$log" && break
			else [ "$(grep -c 'FPS:' "$log")" -ge $i ] && break; fi
			kill -0 $pid 2>/dev/null || break; sleep 0.1
		done
		kill -0 $pid 2>/dev/null || break
		sleep 1
		import -window root -crop 640x480+0+0 "${log%.log}-$i.png" 2>/dev/null && shots+=(-label "$s" "${log%.log}-$i.png")
		i=$((i + 1))
	done
	wait $pid
	[ ${#shots[@]} = 0 ] || montage "${shots[@]}" -tile 4x -geometry 320x240+2+2 "${log%.log}.png" 2>/dev/null
	rm -f "${log%.log}"-[0-9]*.png
	local n; n=$(grep -c 'FPS: [1-9]' "$log")
	[ "$n" = $# ] && grep -q 'virgl' "$log"
}
scenes="build texture shading bump effect2d pulsar desktop buffer ideas jellyfish terrain shadow refract conditionals function loop"

for t in "${tests[@]}"; do
	case $t in
	info)
		guest eglinfo -B -p x11 >"$work/info.log" 2>&1
		es=$(sed -n 's/^OpenGL ES profile version: //p' "$work/info.log")
		gl=$(sed -n 's/^OpenGL compatibility profile version: //p' "$work/info.log")
		ok=0; grep -q 'renderer: virgl' "$work/info.log" && [[ $es == "OpenGL ES 3."* ]] && ok=1
		report info $ok "ES: ${es:-none}; GL: ${gl:-none}" ;;
	es2)
		ok=0; bench "$work/es2.log" glmark2-es2 $scenes && ok=1
		report es2 $ok "$(grep -c 'FPS: [1-9]' "$work/es2.log") of $(echo $scenes | wc -w) scenes, $work/es2.png" ;;
	gl)
		ok=0; bench "$work/gl.log" glmark2 $scenes && ok=1
		report gl $ok "$(grep -c 'FPS: [1-9]' "$work/gl.log") of $(echo $scenes | wc -w) scenes, $work/gl.png" ;;
	sdl)
		SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy guest timeout 25 neverball >"$work/sdl.log" 2>&1 &
		sleep 10; ok=0; lively "$work/sdl.png" && ok=1
		wait $! 2>/dev/null
		report sdl $ok "neverball menu, $work/sdl.png" ;;
	weston)
		guest timeout 30 weston --backend=x11 --renderer=gl --width=1024 --height=640 \
			--socket=wl-kwgl >"$work/weston.log" 2>&1 &
		w=$!; sleep 4
		WAYLAND_DISPLAY=wl-kwgl guest timeout 15 glmark2-es2-wayland -s 500x400 \
			-b jellyfish:duration=6 >"$work/weston-client.log" 2>&1 &
		sleep 5; ok=0
		lively "$work/weston.png" && grep -q 'GL renderer: virgl' "$work/weston.log" && ok=1
		wait $! 2>/dev/null; grep -q 'FPS: [1-9]' "$work/weston-client.log" || ok=0
		kill $w 2>/dev/null; wait $w 2>/dev/null
		report weston $ok "GL compositor with a GL client, $work/weston.png" ;;
	multi)
		# six different clients at once: every switch between renderer contexts
		n=0; cl=()
		for a in "glmark2-es2 shading:shading=phong" "glmark2-es2 texture" "glmark2 bump:bump-render=normals" \
			"glmark2-es2 jellyfish" "glmark2 desktop" "glmark2-es2 refract"; do
			set -- $a
			guest timeout 20 "$1" -s 400x300 -b "$2:duration=12" >"$work/multi$n.log" 2>&1 &
			cl+=($!); n=$((n + 1))
		done
		sleep 8; n=0
		for i in $(xdotool search --name glmark2); do
			xdotool windowmove "$i" $((n % 3 * 420)) $((n / 3 * 340)); n=$((n + 1))
		done
		sleep 1; ok=0; lively "$work/multi.png" && ok=1
		wait "${cl[@]}" 2>/dev/null
		[ "$(cat "$work"/multi?.log | grep -c 'FPS: [1-9]')" = 6 ] || ok=0
		report multi $ok "six clients at once, look at $work/multi.png" ;;
	state)
		# The order matters: plain (default state) follows raster (depth
		# GEQUAL), so that state a switch fails to reset shows.
		vs="tex stencil raster plain query mip dual"
		ok=0; detail="cannot build kwgl-state.c"
		if cc -O2 -o "$work/kwgl-state" "$here/kwgl-state.c" -lEGL -lGLESv2 2>"$work/state-cc.log"; then
			# the reference is the multi-context renderer unless given
			ref=${ref_socket:-$work/ref.sock}
			if [ -n "$ref_socket" ]; then : >"$work/state-ref.log"; else
				ref_env=${VTEST_ENV:-}; VTEST_ENV=${ref_env//VTEST_SINGLE_GL_CONTEXT=1/} \
					start_server "$work/ref.sock" "$work/state-ref.log"
			fi
			mkdir -p "$work/state"
			for v in $vs; do
				VTEST_SOCKET_NAME=$ref guest timeout 60 "$work/kwgl-state" -t 8 "$v"
			done 2>"$work/state-ref.err" | sort >"$work/state-ref.txt"
			guest timeout 120 "$work/kwgl-state" -t 8 -o "$work/state" $vs 2>"$work/state.err" |
				sort >"$work/state.txt"
			sums=$(grep -c '^[a-z.0-9]* [0-9]* [0-9a-f]\{16\}$' "$work/state-ref.txt")
			flat=$(awk 'NF == 3 && length($3) == 16 { n[$1]++; d[$1 " " $3] = 1 }
				END { for (k in d) { split(k, a, " "); u[a[1]]++ }
				      for (t in n) if (u[t] < 2) print t }' "$work/state-ref.txt")
			bad=$(diff "$work/state-ref.txt" "$work/state.txt" | grep -c '^>')
			detail="$bad of $sums frames differ from the clients alone"
			if [ "$sums" = 60 ] && [ -z "$flat" ] && [ "$bad" = 0 ] &&
				cmp -s "$work/state-ref.txt" "$work/state.txt" &&
				! grep -q 'samples-passed=[^0]' "$work/state.txt" &&
				[ -z "$(log_errors "$work/state-ref.log")" ]; then
				ok=1
			fi
			[ -z "$flat" ] || detail="$detail; reference frames do not change: $flat"
			[ -z "$(log_errors "$work/state-ref.log")" ] || detail="$detail; errors in $work/state-ref.log"
			[ $ok = 1 ] || diff "$work/state-ref.txt" "$work/state.txt" | head -12
		fi
		report state $ok "$detail" ;;
	*) echo "unknown test $t"; fails=$((fails + 1)) ;;
	esac
done

errs=$(log_errors "$work/server.log" | wc -l)
[ -n "$socket" ] || report server-log $([ "$errs" = 0 ] && echo 1 || echo 0) "$errs unexpected lines"
[ "$errs" = 0 ] || log_errors "$work/server.log" | sort | uniq -c | sort -rn | head -10
[ $fails = 0 ] || keep=1
exit $((fails > 0))
