// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Ollama: its server and `ollama run` with every layer on the guest's Vulkan,
// which here is this browser's WebGPU (guest Vulkan: the base's ICD,
// .agents/vk.md). Ollama 0.40 runs models in llama.cpp's llama-server, so
// the GPU path is ggml's Vulkan backend, as in the llama.cpp app
// (llama.ts). Debian only (the ICD links glibc).
//
// Nothing of Ollama is in the page, and nothing is self-built. Ollama's
// linux-arm64 release has no Vulkan backend (its Dockerfile builds
// llama-server-vulkan for amd64 only) and is 1.6 GiB of zstd, almost all
// CUDA, with the CPU libraries at its end; bin/ollama (the Go binary, 40
// MiB) is its first member. So ollama.sh fetches the archive's first 12 MiB
// (an HTTP range: bin/ollama ends 10.9 MiB in) and keeps bin/ollama, checked
// against the SHA-256 below (taken from the whole archive, whose own SHA-256
// is noted beside it), and the licenses of its Go code (lib/ollama/GO_LICENSE);
// llama-server, libllama and ggml (its Vulkan backend in lib/ollama/vulkan/,
// where Ollama looks for GPU backends) come from llama.cpp's own Vulkan
// build for Ubuntu on arm64 of the tag this Ollama pins (LLAMA_CPP_VERSION
// b12651; Ollama's own build of it adds only a model-loading compatibility
// layer for its library's GGUFs, which a GGUF made here does not need). Both
// MIT. The guest's own https over the page's network, since github.com sends
// no CORS headers (download.ts); 12 + 29 MiB took about 12 s on 2026-11-24,
// 97 MiB unpacked into ~/.local/share/ollama/<version> (only ggml's armv8.0
// CPU variant: the guest's CPU has none of the others' extensions). zstd
// unpacks it; libgomp1 and libssl3t64 are llama-server's.
//
// Three switches make Ollama use kwvk (read in its source at that tag):
// OLLAMA_IGPU_ENABLE=1, as it drops integrated GPUs other than CUDA's and
// kwvk is one; LLAMA_ARG_FIT_TARGET=64, as llama-server's -fit keeps 1 GiB
// of device memory free by default and kwvk's heap is half the guest's RAM
// (498 MiB with 1 GiB), so it put no layer on the GPU (Ollama's ps:
// "75%/25% CPU/GPU", the log's "offloaded 0/6 layers to GPU"); and
// OLLAMA_NO_CLOUD=1 (no requests to ollama.com). Its discovery runs
// llama-server --list-devices through the Vulkan loader and finds "kwvk
// (WebGPU)" with no other requirement (no memory budget extension, no sysfs).
//
// The default model is Qwen2.5-Coder 0.5B Instruct (MODEL=qwen-coder, below;
// the fx (local model) app's default too, so the two compare), which loads
// on a real GPU only. MODEL=stories260K, as in llama.ts (F32, 1.1 MiB,
// fetched by the page into the installer), runs on software WebGPU too:
// made an Ollama model by `ollama create` from a
// Modelfile (FROM the GGUF, num_predict 128), which keeps its F32 weights;
// Ollama's library models are quantized and abort on guest Vulkan for now
// (vk.md, Unsupported), except their fp16 tags. F16 GGUFs run too
// (stories260K converted to F16 by llama-quantize: the same text, 100% GPU).
// Wider models need ggml's 512-wide norm shaders (rms_norm_mul_f32_512 is
// the first refused), which SwiftShader's WebGPU (256 invocations) refuses
// and the renderer, asking for the adapter's best limits, gets on most real
// GPUs (1024); so the coding models are MODEL= choices, untried on a real
// GPU: MODEL=smollm2 (SmolLM2 135M Instruct, Ollama's
// smollm2:135m-instruct-fp16, 271 MiB, Apache-2.0; try it first) and
// MODEL=qwen-coder (Qwen2.5-Coder 0.5B Instruct,
// qwen2.5-coder:0.5b-instruct-fp16, 994 MiB, Apache-2.0; kwvk's heap, half
// the guest's RAM, must hold it: 3 GiB of guest memory or more), fetched
// from Ollama's registry by ollama.sh with curl into Ollama's store (manifest
// and blobs, checked): ollama pull cannot, as it refuses redirects to hosts
// that resolve to non-public addresses, and the page's network answers DNS
// with synthetic ones (198.18.0.0/15). ollama.sh's exit status says why it
// stopped: 3 a download failed, 4 guest Vulkan refused a shader, 5 the WebGPU
// device was lost, 1 anything else. Both answered "a Python function that reverses
// a string" correctly at temperature 0 on the host's CPU; on kwvk with
// SwiftShader both abort at that shader, with the hint. A model with a chat
// template gets `ollama run`'s chat. stories260K has no chat template,
// so Ollama sends the text as it is and the model continues it: ollama.sh
// writes a story from "Once upon a time", then reads the user's own story
// starts, each sent as `ollama run stories260k "TEXT"` (Ollama's generate
// path, the text as it is): `ollama run`'s interactive prompt chats through
// llama-server's chat endpoint, which wraps the text in a chat template
// (three words made 48 prompt tokens) and the story began oddly. A GGUF with
// a chat template, or a library model, gets `ollama run`'s chat.
//
// ollama.sh starts `ollama serve` in its own session, its log in ollama.log,
// checks that Ollama took kwvk as its GPU (its "inference compute" line)
// and, after loading the model, that its layers are on it (llama-server's
// "offloaded N/M layers to GPU", N > 0), and stops with a message otherwise,
// since a model on the CPU would be a misleading demo; it stops the server
// when it ends. A loud failure of guest Vulkan (a refused pipeline aborts
// ggml, vk.md, Errors) gets a one-line hint. On 2026-11-24 (the guest in
// headless Chromium on SwiftShader, one CPU, 1 GiB) the server answered
// after 2 s, the model loaded in 7.5-8.5 s and generated 4.5-6.0 tokens/s
// (the same model on the guest's CPU: 43, much faster than on software
// WebGPU).
import type { TerminalApp } from "../types.ts";

const VER = "v0.40.18";
// bin/ollama of ollama-linux-arm64.tar.zst at VER (sha256 63f01dae3b65641866991e75e2aecb7aed8a4041f4c2c3c7d92862c5a47ebed6).
const OLLAMA_BIN_SHA256 = "3f64b5190c9c7b58feefdad2846e2f157274586b2ed82b06589bd66d2b256051";
const LLAMA = "b12651";
const LLAMA_SHA256 = "138f97d9d448b7a55c4b839366bba6e2ac7fba634f9160c9a4775a2051a1c7cb";
const MODELS = "https://huggingface.co/ggml-org/models/resolve/main/tinyllamas";
const MODEL_SHA256 = "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d";
const MODEL_SIZE = 1185376;
/** The story model's (MODEL=stories260K) Ollama name, as ollama.sh creates it (`SERVE=1 ./ollama.sh` writes the name it serves to ollama.ready). */
export const OLLAMA_MODEL = "stories260k";
/** Its context length in tokens (the GGUF's llama.context_length, as `ollama show` gives it). */
export const OLLAMA_MODEL_CTX = 2048;
/** Whether it does tool calls through Ollama's OpenAI-compatible endpoint: no, it has no chat template. */
export const OLLAMA_MODEL_TOOLS = false;

const OLLAMA_SH = String.raw`#!/bin/bash
# Ollama with llama.cpp's Vulkan backend on guest Vulkan (kwvk: this page's
# WebGPU). Written by the unkernel launcher's Ollama app.
#   ./ollama.sh                     Qwen2.5-Coder 0.5B Instruct (F16, 994 MiB): a small coding chat model; guest memory 3 GiB or more
#   MODEL=smollm2 ./ollama.sh       SmolLM2 135M Instruct (F16, 271 MiB): a smaller chat model that writes simple code
#   MODEL=stories260K ./ollama.sh   stories260K (F32, 1.1 MiB): a story, then you type story starts; runs on software WebGPU too
#                                   (both need a GPU whose WebGPU allows 512-wide workgroups: not SwiftShader)
#   MODEL=PATH.gguf ./ollama.sh     another GGUF here (ollama create), F32 or F16
#   SERVE=1 ./ollama.sh             the server only, for other programs: once the model is on kwvk,
#                                   its Ollama name goes to ollama.ready; Ctrl-C stops the server
#   MODEL=NAME ./ollama.sh          another model of Ollama's registry ([user/]name[:tag], fetched by curl): an fp16 tag, as the default ones are quantized
# The server runs while this script does: ollama.log has its log.
# Quantized models (q4_0, q8_0, q4_K_M ...) abort on guest Vulkan for now: use F32 or F16.
set -e
VER=${VER}
URL=https://github.com/ollama/ollama/releases/download/$VER/ollama-linux-arm64.tar.zst
BIN_SHA=${OLLAMA_BIN_SHA256}
LLAMA=${LLAMA}
LURL=https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA/llama-$LLAMA-bin-ubuntu-vulkan-arm64.tar.gz
LSHA=${LLAMA_SHA256}
# Downloads try the page's mirror first: plain HTTP to mirror.unkernel.dev is
# answered by the page's fetch() (config.ts DEFAULT_ROUTES), not carried over
# the network relay; then the upstream itself. dl UPSTREAM MIRROR_PATH CURL_ARGS...
MIRROR=http://mirror.unkernel.dev
dl() {
	local up=$1 mp=$2
	shift 2
	curl "$@" "$MIRROR/$mp" || curl "$@" "$up"
}
DIR=$HOME/.local/share/ollama/$VER
OLLAMA=$DIR/bin/ollama
LOG=$PWD/ollama.log
READY=$PWD/ollama.ready
rm -f "$READY"
D='\033[90m' B='\033[1m' R='\033[31m' N='\033[0m'
say() { printf "$D%s$N\n" "$*"; }
die() { printf "$R%s$N\n" "$*" >&2; exit 1; }
# Exit status: 3 a download failed, 4 guest Vulkan refused a shader, 5 the
# WebGPU device was lost, 1 anything else.
fail() { local st=$1; shift; printf "$R%s$N\n" "$*" >&2; exit $st; }

# Guest Vulkan: the base's ICD, and a device named kwvk.
[ -e /usr/share/vulkan/icd.d/kw_icd.json ] || die "This guest has no kwvk ICD (/usr/share/vulkan/icd.d/kw_icd.json): the page's kernel bundle has no guest Vulkan."
# Twice: a program after a lost WebGPU device gets a new one.
for try in 1 2; do
	vi=$(vulkaninfo --summary 2>&1) || true
	dev=$(printf '%s\n' "$vi" | sed -n 's/^[[:space:]]*deviceName[[:space:]]*=[[:space:]]*//p' | head -n 1)
	case $dev in *kwvk*) break ;; esac
done
case $dev in
*kwvk*) say "Vulkan device: $dev" ;;
*)
	printf '%s\n' "$vi" | grep -a '^kwvk:' >&2 || true
	die "vulkaninfo names no kwvk device: turn on Guest Vulkan (Settings, Display and sound; it needs WebGPU), then run ./ollama.sh again."
	;;
esac

# Ollama, once: its own linux-arm64 build has no Vulkan backend and is 1.6 GiB
# (CUDA), so only its first files (bin/ollama and the licenses of its Go
# code) are taken from the archive's first 12 MiB; llama-server and ggml
# come from llama.cpp's Vulkan build of the tag this Ollama pins ($LLAMA).
if [ ! -x "$OLLAMA" ] || [ ! -e "$DIR/lib/ollama/vulkan/libggml-vulkan.so" ]; then
	free=$(df -Pk "$HOME" | awk 'NR == 2 { print int($4 / 1024) }')
	[ "$free" -ge 150 ] || die "Ollama needs 150 MiB on the disk, $free MiB free."
	rm -rf "$DIR.part" && mkdir -p "$DIR.part/lib/ollama/vulkan" && cd "$DIR.part"
	printf "$B%s$N\n" "Fetching Ollama $VER (arm64: the first 12 MiB of its archive, 40 MiB unpacked) from GitHub"
	dl "$URL" "github/ollama/ollama/releases/download/$VER/ollama-linux-arm64.tar.zst" -fL# -r 0-12582911 -o head.tar.zst || { cd - >/dev/null; rm -rf "$DIR.part"; fail 3 "Download failed: $URL"; }
	{ zstd -dc head.tar.zst 2>/dev/null | tar x --occurrence=1 bin/ollama lib/ollama/GO_LICENSE; } 2>/dev/null || true
	echo "$BIN_SHA  bin/ollama" | sha256sum -c --quiet 2>/dev/null || { cd - >/dev/null; rm -rf "$DIR.part"; die "Ollama: no bin/ollama with the right SHA-256 in the download, deleted"; }
	rm head.tar.zst
	printf "$B%s$N\n" "Fetching llama.cpp $LLAMA (Vulkan, arm64: 29 MiB, 57 MiB of it kept) from GitHub"
	dl "$LURL" "github/ggml-org/llama.cpp/releases/download/$LLAMA/llama-$LLAMA-bin-ubuntu-vulkan-arm64.tar.gz" -fL# -o llama.tar.gz || { cd - >/dev/null; rm -rf "$DIR.part"; fail 3 "Download failed: $LURL"; }
	echo "$LSHA  llama.tar.gz" | sha256sum -c --quiet || { cd - >/dev/null; rm -rf "$DIR.part"; die "llama.cpp: wrong SHA-256, deleted"; }
	# llama-server and what it loads; of ggml's CPU variants only armv8.0
	# (the guest's CPU has no dotprod, fp16 arithmetic or SVE).
	p=llama-$LLAMA
	tar xzf llama.tar.gz -C lib/ollama --strip-components=1 --wildcards "$p/LICENSE" "$p/llama-server" \
		"$p/libllama.so*" "$p/libllama-common.so*" "$p/libllama-server-impl.so" "$p/libmtmd.so*" \
		"$p/libggml.so*" "$p/libggml-base.so*" "$p/libggml-cpu-armv8.0_1.so" "$p/libggml-vulkan.so"
	mv lib/ollama/libggml-vulkan.so lib/ollama/vulkan/
	rm llama.tar.gz
	cd - >/dev/null && mv "$DIR.part" "$DIR"
	say "Ollama $VER is in $DIR"
fi

# The server, here only: its own session (Ctrl-C in ollama run stays
# there), stopped when this script ends.
export OLLAMA_HOST=127.0.0.1:11434
# kwvk is an integrated GPU, which Ollama drops unless told.
export OLLAMA_IGPU_ENABLE=1
# llama-server keeps 1 GiB of device memory free by default, more than kwvk
# has (half the guest's RAM), and would put every layer on the CPU.
export LLAMA_ARG_FIT_TARGET=64
# No ollama.com (cloud models, recommendations).
export OLLAMA_NO_CLOUD=1
# The model stays loaded while the server runs.
export OLLAMA_KEEP_ALIVE=-1
PIDF=$PWD/ollama.pid
if [ -s "$PIDF" ] && grep -qa 'ollama' "/proc/$(cat "$PIDF")/cmdline" 2>/dev/null; then
	say "Stopping the server an earlier run left"
	kill "$(cat "$PIDF")" 2>/dev/null || true
	for i in $(seq 50); do kill -0 "$(cat "$PIDF")" 2>/dev/null || break; sleep 0.2; done
fi
! curl -fs "$OLLAMA_HOST/api/version" >/dev/null 2>&1 || die "Another server answers on $OLLAMA_HOST (an ollama serve of yours?): stop it, then run ./ollama.sh again."
setsid "$OLLAMA" serve >"$LOG" 2>&1 </dev/null &
SRV=$!
echo $SRV >"$PIDF"
stop() {
	rm -f "$READY"
	kill $SRV 2>/dev/null || return 0
	for i in $(seq 50); do kill -0 $SRV 2>/dev/null || break; sleep 0.2; done
	kill -9 $SRV 2>/dev/null || true
	rm -f "$PIDF"
}
trap stop EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
say "Starting the server (ollama serve; its log: ollama.log)"
for i in $(seq 300); do
	grep -qa 'msg="inference compute"' "$LOG" && curl -fs "$OLLAMA_HOST/api/version" >/dev/null 2>&1 && break
	kill -0 $SRV 2>/dev/null || { tail -n 5 "$LOG" >&2; die "ollama serve ended (ollama.log has its log)."; }
	sleep 0.2
done
gpu=$(grep -a 'msg="inference compute"' "$LOG" | grep -a 'library=Vulkan' | grep -a kwvk | head -n 1)
if [ -z "$gpu" ]; then
	grep -aE 'msg="inference compute"|dropping integrated|failure during|timed out' "$LOG" >&2 || true
	die "Ollama did not take kwvk as its GPU, and would run on the CPU: see ollama.log."
fi
say "Ollama's GPU: $(printf '%s\n' "$gpu" | sed -n 's/.*description="\([^"]*\)".* type=\([^ ]*\) total="\([^"]*\)".*/\1 (Vulkan, \2, \3)/p')"

# A model of Ollama's registry, fetched as ollama pull would store it, but
# by curl: ollama pull refuses redirects to hosts that resolve to non-public
# addresses, and the page's network gives every host name one (198.18.0.0/15).
# The manifest goes, byte for byte, where Ollama reads manifests
# (manifests/registry.ollama.ai/NAMESPACE/NAME/TAG), each blob it names to
# blobs/sha256-HEX, checked against its digest.
fetch_model() {
	local ref=$1 path tag store reg man d f mir
	path=$(printf '%s' "$ref" | sed 's/:[^/]*$//')
	tag=$(printf '%s' "$ref" | sed -n 's/^.*:\([^/]*\)$/\1/p')
	[ -n "$tag" ] || tag=latest
	case $path in */*) ;; *) path=library/$path ;; esac
	store=$OLLAMA_MODELS
	[ -n "$store" ] || store=$HOME/.ollama/models
	reg=https://registry.ollama.ai/v2/$path
	man=$store/manifests/registry.ollama.ai/$path/$tag
	mkdir -p "$store/blobs" "$(dirname "$man")"
	printf "$B%s$N\n" "Fetching $path:$tag from Ollama's registry"
	# The mirror has the library's models (library/NAME); others come from the registry only.
	case $path in library/*) mir=ollama/v2/$path ;; *) mir=no-mirror/$path ;; esac
	dl "$reg/manifests/$tag" "$mir/manifests/$tag" -fsSL -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' -o "$man.part" ||
		{ rm -f "$man.part"; fail 3 "Download failed: the manifest of $path:$tag ($reg/manifests/$tag): no such model or tag, or no network."; }
	for d in $(grep -o '"digest" *: *"sha256:[0-9a-f]\{64\}"' "$man.part" | sed 's/.*sha256://; s/"$//'); do
		f=$store/blobs/sha256-$d
		if [ -s "$f" ] && echo "$d  $f" | sha256sum -c --quiet >/dev/null 2>&1; then continue; fi
		dl "$reg/blobs/sha256:$d" "$mir/blobs/sha256:$d" -fL# -C - -o "$f.part" || fail 3 "Download failed: blob sha256:$d of $path:$tag (run ./ollama.sh again to resume)."
		echo "$d  $f.part" | sha256sum -c --quiet >/dev/null 2>&1 || { rm -f "$f.part"; fail 3 "Download failed: blob sha256:$d of $path:$tag has the wrong SHA-256, deleted (run ./ollama.sh again)."; }
		mv "$f.part" "$f"
	done
	grep -q '"digest"' "$man.part" || { rm -f "$man.part"; fail 3 "Download failed: $reg/manifests/$tag is not a manifest."; }
	mv "$man.part" "$man"
}

# The model: Qwen2.5-Coder by default (the fx (local model) app's too), from Ollama's
# registry; stories260K from the page (models/), made an Ollama model once.
M=$MODEL
[ -n "$M" ] || M=qwen-coder
case $M in
stories260K) F=models/stories260K.gguf NAME=stories260k ;;
smollm2) F= NAME=smollm2:135m-instruct-fp16 ;;
qwen-coder) F= NAME=qwen2.5-coder:0.5b-instruct-fp16 ;;
*.gguf) F=$M NAME=$(basename "$M" .gguf | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._\n-' -) ;;
*) F= NAME=$M ;;
esac
if [ -n "$F" ]; then
	[ -s "$F" ] || die "No model at $F"
	if ! "$OLLAMA" show "$NAME" >/dev/null 2>&1; then
		say "Making the Ollama model $NAME from $F (ollama create: weights kept as they are)"
		mkdir -p models
		printf 'FROM %s\nPARAMETER num_predict 128\n' "$(realpath "$F")" >"models/$NAME.Modelfile"
		out=$("$OLLAMA" create "$NAME" -f "models/$NAME.Modelfile" 2>&1) || { printf '%s\n' "$out" | tail -n 3 >&2; die "ollama create failed"; }
	fi
else
	case $NAME in
	*fp16* | *f16* | *fp32* | *f32*) ;;
	*) say "$NAME: Ollama's library models are quantized unless the tag says fp16; quantized ones abort on guest Vulkan for now (their shaders do not translate yet)." ;;
	esac
	"$OLLAMA" show "$NAME" >/dev/null 2>&1 || fetch_model "$NAME"
	"$OLLAMA" show "$NAME" >/dev/null 2>&1 || die "Ollama does not see $NAME after its download (ollama.log has the server's log)."
fi
case $NAME in *[Qq][2-8]_* | *[Ii][Qq][1-4]*) say "A quantized model: these abort on guest Vulkan for now (their shaders do not translate yet); F32 and F16 ones run." ;; esac

hint() {
	if grep -qaE 'pipeline creation failed|ErrorInvalidShaderNV|ErrorFeatureNotPresent' "$LOG"; then
		grep -aE '^kwvk:|pipeline creation failed' "$LOG" | tail -n 2 >&2
		fail 4 "Hint: guest Vulkan refused one of this model's shaders: quantized types, or (models wider than stories260K) 512-wide workgroups, which software WebGPU (SwiftShader: 256) refuses and most real GPUs allow. Try the default stories260K."
	elif grep -qa 'device lost' "$LOG"; then
		fail 5 "Hint: the WebGPU device was lost; run ./ollama.sh again (it gets a new one)."
	fi
	grep -aE 'kwvk:|ggml_vulkan:.*(failed|error)|error' "$LOG" | tail -n 5 >&2 || true
	die "$1 (ollama.log has the server's log)."
}

# Load it now, and check that its layers are on kwvk: a model on the CPU
# would be a misleading demo.
say "Loading $NAME on kwvk"
r=$(curl -s "$OLLAMA_HOST/api/generate" -d "{\"model\":\"$NAME\",\"keep_alive\":-1}") || true
case $r in *'"done":true'*) ;; *) hint "Loading $NAME failed: $(printf '%s' "$r" | head -c 300)" ;; esac
off=$(grep -ao 'offloaded [0-9]*/[0-9]* layers to GPU' "$LOG" | tail -n 1)
case $off in
'') die "$NAME: no layer on kwvk (ollama.log has no offload line)." ;;
'offloaded 0/'*) die "$NAME loaded on the CPU, not on kwvk ($off): see ollama.log." ;;
esac
# (llama.cpp prints that line on a CPU-only run too: the weights must be in a Vulkan buffer.)
grep -qa 'Vulkan0 model buffer size' "$LOG" || die "$NAME loaded on the CPU, not on kwvk (no Vulkan0 model buffer): see ollama.log."
say "On kwvk: $off ($("$OLLAMA" ps | awk 'NR == 2 { for (i = 1; i <= NF; i++) if ($i == "GPU" || $i ~ /GPU$/) { print $(i - 1), $i; exit } }'))"

# SERVE=1: the server only (another app talks to it), until this script is
# stopped; the traps above stop the server.
if [ -n "$SERVE" ]; then
	trap 'exit 130' INT
	echo "$NAME" >"$READY"
	printf "$B%s$N\n" "Ready: $NAME on http://$OLLAMA_HOST (Ollama's API; OpenAI's at /v1). Ctrl-C stops the server."
	wait $SRV
	die "ollama serve ended (ollama.log has its log)."
fi

set +e
# A model with a chat template chats (ollama run). One without continues
# text: each line goes to ollama run NAME "TEXT" (Ollama's generate path,
# the text as it is), since ollama run's own prompt chats through
# llama-server's chat endpoint, which wraps the text in a chat template the
# model never saw. (Its stdin is not the terminal: with a prompt, ollama run
# adds what it reads from a stdin that is not one.)
if [ -n "$F" ] && ! head -c 16777216 "$F" | grep -qa tokenizer.chat_template; then
	# Ctrl-C stops a reply (ollama run) and this script goes on.
	trap : INT
	printf "$B%s$N\n" "A story from \"Once upon a time\" (the speed after it: eval rate, tokens per second):"
	"$OLLAMA" run --verbose "$NAME" "Once upon a time" </dev/null || hint "ollama run failed"
	say "Now you: type the start of a story (a few words: \"The little dragon\") and press Enter, and it goes on from there, 128 tokens at most. It has no chat template: it continues text, it does not answer questions. Ctrl-C stops a reply; Ctrl-D or /bye quits and stops the server."
	while IFS= read -e -r -p $'\001\033[1m\002>>> \001\033[0m\002' line; do
		case $line in /bye) break ;; '') continue ;; esac
		history -s "$line"
		"$OLLAMA" run --verbose "$NAME" "$line" </dev/null
		st=$?
		[ $st -eq 0 ] || [ $st -eq 130 ] || hint "ollama run failed"
	done
	echo
else
	say "Type a message and press Enter. Ctrl-D or /bye quits and stops the server."
	"$OLLAMA" run --verbose "$NAME" || hint "ollama run failed"
fi
`;

export default {
	id: "ollama",
	title: "Ollama",
	desc: "Ollama on the GPU: its server and ollama run on llama.cpp's Vulkan backend, on this browser's WebGPU (guest Vulkan); Qwen2.5-Coder 0.5B (994 MiB; guest memory 3 GiB or more, a real GPU), Ollama (12 MiB) and llama.cpp (29 MiB) on first run; small F16 coding models with MODEL=",
	// A speech bubble with three dots (crafted).
	icon: { svg: '<path d="M5.5 4h13Q20 4 20 5.5v9q0 1.5-1.5 1.5H11l-4.6 3.7q-.4.3-.4-.2V16h-.5Q4 16 4 14.5v-9Q4 4 5.5 4Z"/><circle cx="8.5" cy="10" r="1.2" fill="#0f766e"/><circle cx="12" cy="10" r="1.2" fill="#0f766e"/><circle cx="15.5" cy="10" r="1.2" fill="#0f766e"/>' },
	colors: ["#0f766e", "#1e1b4b"],
	needs: { net: true, vk: true },
	packages: { debian: ["libvulkan1", "vulkan-tools", "libgomp1", "libssl3t64", "zstd", "curl", "ca-certificates"] },
	terminal: "window",
	files: {
		"ollama.sh": { content: OLLAMA_SH, mode: 0o755 },
		README: "Ollama runs this model on the guest's Vulkan, which is this browser's WebGPU\n" +
			"(guest Vulkan in Options): its server (ollama serve, while ollama.sh runs; its\n" +
			"log: ollama.log) loads every layer on the GPU. The default model is\n" +
			"Qwen2.5-Coder 0.5B Instruct (F16, 994 MiB, fetched once), a small coding chat\n" +
			"model: ask it, e.g., Write a Python function that reverses a string.\n" +
			"It needs guest memory of 3 GiB or more (Settings) and a real GPU (software\n" +
			"WebGPU refuses its 512-wide workgroups). Ctrl-D or /bye quits and stops the\n" +
			"server. Quantized models (Ollama's library: q4_K_M ...) abort on guest Vulkan\n" +
			"for now; F32 and F16 ones run. Others:\n" +
			"  MODEL=smollm2 ./ollama.sh              (SmolLM2 135M Instruct, 271 MiB: simple code)\n" +
			"  MODEL=stories260K ./ollama.sh          (a tiny F32 story model, 1.1 MiB, no chat\n" +
			"                                          template: type story starts; runs on\n" +
			"                                          software WebGPU too)\n" +
			"  MODEL=PATH.gguf ./ollama.sh            (another GGUF, made an Ollama model)\n" +
			"  ~/.local/share/ollama/" + VER + "/bin/ollama ps   (in another tab while it runs: 100% GPU)\n",
	},
	downloads: [{ url: `${MODELS}/stories260K.gguf`, sha256: MODEL_SHA256, size: MODEL_SIZE, path: "models/stories260K.gguf", cors: true }],
	commands: ["cat README", "./ollama.sh"],
} satisfies TerminalApp;
