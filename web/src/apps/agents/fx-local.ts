// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fx (local model): the fx coding agent (fx.ts) talking to a model that
// this browser tab's GPU runs: Ollama's server on guest Vulkan, as in the
// Ollama app (ollama.ts: Ollama -> llama.cpp's llama-server -> Vulkan, the
// base's ICD kwvk -> WebGPU; .agents/vk.md). Debian only, as Ollama.
//
// Nothing of Ollama is repeated here: the app writes the Ollama app's own
// files (ollama.sh, its README) and downloads into that app's directory,
// installs its packages (and jq), and fx-local.sh runs `SERVE=1 ./ollama.sh`
// there in the background: ollama.sh installs Ollama and llama.cpp's Vulkan
// build on its first run, starts `ollama serve` on kwvk, makes or pulls the
// model, checks that its layers are on kwvk and writes the model's name to
// ollama.ready. Both apps share that directory's ollama.pid, so one server
// runs at a time. fx comes from the kw layer's shim, as for the fx app.
//
// fx's side is a custom connection named "local" (protocol
// openai-chat-completions, http://127.0.0.1:11434/v1, auth none; fields as
// fx.sh/docs/configure-fx/custom-model-connections describes them for fx
// 0.0.17, whose strict parsing rejects unknown ones). It lives in an
// app-private FX_HOME (~/.apps/fx-local/fx-home): the user's ~/.fx (the fx
// app's sign-in and settings) is not touched. fx-local.sh merges the
// connection into that settings.json with jq on every run (fx's own saved
// preferences there stay), and selects it per run with FX_PROVIDER=local and
// FX_MODEL, with FX_AUTO_UPGRADE=0. The server's OLLAMA_CONTEXT_LENGTH and
// the connection's context_window agree: CTX, by default the model's
// trained context (8192 for SmolLM2) but 16384 for Qwen2.5-Coder (of 32768:
// device memory), and context_window never above what Ollama's /api/show
// reports for the model; supports_tool_use is what /api/show's capabilities
// say ("tools": from the model's template), or OLLAMA_MODEL_TOOLS for the
// Ollama app's own default, or TOOLS=0|1.
//
// The default model is Qwen2.5-Coder 0.5B Instruct (F16, 994 MiB, Ollama's
// library tag qwen2.5-coder:0.5b-instruct-fp16), the smallest model
// ollama.sh offers that can call tools, which fx needs: it sends its tools
// with every request whatever supports_tool_use says, and Ollama answers a
// model without them with HTTP 400 ("does not support tools": SmolLM2 135M,
// the user's first run on a real GPU, 2026-11-24, where it did load; and the
// Ollama app's story model, which has no chat template). So fx-local.sh
// stops before fx with such a model. Qwen2.5-Coder aborts on software WebGPU
// (SwiftShader) at a 512-wide shader; with fx on a real GPU it is untested.
import type { TerminalApp } from "../types.ts";
import ollama, { OLLAMA_MODEL, OLLAMA_MODEL_CTX, OLLAMA_MODEL_TOOLS } from "./ollama.ts";

/** The Ollama app's directory, which holds its ollama.sh, models, log and pid file. */
const OLLAMA_DIR = (ollama as TerminalApp).dir ?? `~/.apps/${ollama.id}`;
const inOllama = (p: string) => (p.startsWith("/") || p.startsWith("~/") ? p : `${OLLAMA_DIR}/${p}`);

const FX_LOCAL_SH = String.raw`#!/bin/bash
# fx, the coding agent, on a model this page's GPU runs: the Ollama app's
# server (SERVE=1 ollama.sh) on guest Vulkan (kwvk: this browser's WebGPU),
# as fx's custom connection "local". Written by the unkernel launcher's
# "fx (local model)" app.
#   ./fx-local.sh                       Qwen2.5-Coder 0.5B Instruct (F16, 994 MiB): tool calls; guest memory 3 GiB or more
#   MODEL=PATH.gguf|NAME ./fx-local.sh  another F32 or F16 model, as ollama.sh takes it
#   CTX=N                               the context length (server and fx; default: the model's, at most 16384)
#   TOOLS=0|1                           declare tool use off or on (default: what Ollama reports)
# fx's settings for this: FX_HOME=$PWD/fx-home (your ~/.fx is not touched).
set -e
OLLAMA_DIR="${OLLAMA_DIR.replace(/^~(?=\/)/, "$HOME")}"
HOST=127.0.0.1:11434
FXH=$PWD/fx-home
D='\033[90m' B='\033[1m' R='\033[31m' N='\033[0m'
say() { printf "$D%s$N\n" "$*"; }
die() { printf "$R%s$N\n" "$*" >&2; exit 1; }

# fx first: the kw layer's shim installs it into ~/.local/bin on its first
# call (any call: it then runs fx with the same arguments).
if [ "$(command -v fx)" = /usr/lib/kw/bin/fx ] && [ ! -x "$HOME/.local/bin/fx" ]; then
	printf "$B%s$N\n" "Installing fx (the kw shim: ~/.local/bin/fx)"
	fx --version >/dev/null || true
	[ -x "$HOME/.local/bin/fx" ] || die "fx did not install (it needs the network): run fx in a terminal to see why."
fi
command -v fx >/dev/null || die "No fx on PATH."
command -v jq >/dev/null || die "No jq (the launcher installs it): sudo apt-get install jq"
[ -x "$OLLAMA_DIR/ollama.sh" ] || die "No $OLLAMA_DIR/ollama.sh (the launcher writes it): start this app from the launcher."

# The model, and the context length the server starts with (Ollama cannot
# change it later), which fx's context_window matches.
[ -n "$MODEL" ] || MODEL=qwen-coder
case $MODEL in
*.gguf) [ ! -e "$MODEL" ] || MODEL=$(realpath "$MODEL") ;;
esac
case $MODEL in
stories260K) c=${OLLAMA_MODEL_CTX} ;;
smollm2) c=8192 ;;
qwen-coder) c=16384 ;;
*) c=8192 ;;
esac
[ -n "$CTX" ] || CTX=$c
case $CTX in '' | *[!0-9]*) die "CTX=$CTX: a number of tokens" ;; esac
export MODEL OLLAMA_CONTEXT_LENGTH=$CTX

# The server: ollama.sh in the Ollama app's directory, in the background
# (a background job of this script ignores Ctrl-C, which fx uses); stopped
# when this script ends (its traps stop ollama serve).
mkdir -p "$FXH" work
rm -f "$OLLAMA_DIR/ollama.ready"
say "Starting Ollama on kwvk (the Ollama app's ollama.sh, SERVE=1; context $CTX tokens; its log: $OLLAMA_DIR/ollama.log)"
(cd "$OLLAMA_DIR" && SERVE=1 exec ./ollama.sh) </dev/null &
OSH=$!
stop() {
	kill -0 $OSH 2>/dev/null || return 0
	say "Stopping the Ollama server"
	kill $OSH 2>/dev/null || true
	for i in $(seq 100); do kill -0 $OSH 2>/dev/null || return 0; sleep 0.2; done
	kill -9 $OSH 2>/dev/null || true
}
trap stop EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
trap 'exit 130' INT
until [ -s "$OLLAMA_DIR/ollama.ready" ]; do
	if ! kill -0 $OSH 2>/dev/null; then
		st=0
		wait $OSH || st=$?
		# ollama.sh's status: 3 a download failed, 4 a shader refused, 5 device lost.
		case $st in
		3) say "A download failed (above: which); run ./fx-local.sh again to resume it." ;;
		4) case $MODEL in
			stories260K) ;;
			*) say "On software WebGPU (SwiftShader) $MODEL aborts at a 512-wide shader: fx on a local model needs a real GPU." ;;
			esac ;;
		esac
		die "ollama.sh stopped before the model was ready (exit $st; above: why)."
	fi
	sleep 0.5
done
NAME=$(head -n 1 "$OLLAMA_DIR/ollama.ready")

# What Ollama knows of the model: its trained context, and whether its
# template takes tools (capabilities).
info=$(curl -fs "$HOST/api/show" -d "$(jq -nc --arg m "$NAME" '{model: $m}')") || info='{}'
trained=$(printf '%s' "$info" | jq -r '[(.model_info // {}) | to_entries[] | select(.key | endswith(".context_length")) | .value][0] // empty' 2>/dev/null) || trained=
WIN=$CTX
if [ -n "$trained" ] && [ "$trained" -lt "$CTX" ]; then
	say "$NAME was trained on $trained tokens of context: fx gets $trained (CTX=$trained next time)."
	WIN=$trained
fi
OUT=$((WIN / 4))
[ $OUT -le 2048 ] || OUT=2048
if [ -n "$TOOLS" ]; then
	case $TOOLS in 0 | false | no) T=false ;; *) T=true ;; esac
elif [ "$NAME" = ${OLLAMA_MODEL} ]; then
	T=${OLLAMA_MODEL_TOOLS}
else
	T=$(printf '%s' "$info" | jq -r '(.capabilities // []) | index("tools") != null' 2>/dev/null) || T=false
	[ "$T" = true ] || T=false
fi

# fx's connection "local", merged into the app-private settings.json: the
# rest of the file (preferences fx saved there) stays. Long timeouts: a
# first reply waits for fx's whole prompt to go through the GPU.
S=$FXH/settings.json
{ [ -s "$S" ] && jq -e 'type == "object"' "$S" >/dev/null 2>&1; } || echo '{}' >"$S"
jq --arg m "$NAME" --arg url "http://$HOST/v1" --argjson win "$WIN" --argjson out "$OUT" --argjson tools "$T" '
	.provider = "local"
	| .providers.local = ((.providers.local // {}) * {
		protocol: "openai-chat-completions",
		base_url: $url,
		auth: {type: "none"},
		timeouts: {first_response_ms: 1800000, stall_ms: 1800000},
		model_metadata: {($m): {context_window: $win, max_output_tokens: $out, supports_tool_use: $tools, supports_vision: false}}
	})
	| .models.local = $m' "$S" >"$S.new"
mv "$S.new" "$S"

printf "$B%s$N\n" "fx on $NAME: context $WIN tokens, replies up to $OUT, tool use $T (the connection local in $S)"
# fx sends its tools with every request, and Ollama refuses them (HTTP 400)
# for a model whose template takes none.
[ "$T" = true ] || die "$NAME cannot call tools (Ollama's capabilities for it), and fx needs them: Ollama would answer its requests with HTTP 400. Run ./fx-local.sh for the default, Qwen2.5-Coder, or MODEL= another model with tools; to talk with $NAME without fx: cd $OLLAMA_DIR && MODEL=$MODEL ./ollama.sh"
say "fx works in $PWD/work. Slow: each turn sends fx's whole prompt and tool list through this tab's GPU, so a first reply can take minutes. Quitting fx stops the server."
cd work
trap : INT
set +e
FX_HOME=$FXH FX_PROVIDER=local FX_MODEL=$NAME FX_AUTO_UPGRADE=0 fx
exit $?
`;

const README = "fx, the coding agent, talking to a model that runs in this browser tab's GPU:\n" +
	"Ollama's server, llama.cpp's llama-server, Vulkan (the guest's kwvk), WebGPU.\n" +
	"fx-local.sh starts the Ollama app's server (" + OLLAMA_DIR + "/ollama.sh, its log\n" +
	"ollama.log there) with the model on the GPU, runs fx with the connection local,\n" +
	"and stops the server when fx quits. fx's settings for it are in\n" +
	"~/.apps/fx-local/fx-home (FX_HOME): your own ~/.fx is not touched.\n" +
	"\n" +
	"The default model is Qwen2.5-Coder 0.5B Instruct (F16, 994 MiB, fetched\n" +
	"once): small, but it can call tools, which fx needs. It needs guest memory\n" +
	"of 3 GiB or more (Settings) and a GPU whose WebGPU allows 512-wide\n" +
	"workgroups (most real GPUs; not software WebGPU, SwiftShader, where it\n" +
	"aborts). Others:\n" +
	"  MODEL=NAME ./fx-local.sh          (another model of Ollama's library with\n" +
	"                                     tools, an fp16 tag; fx cannot use a model\n" +
	"                                     without tools, such as smollm2)\n" +
	"  MODEL=PATH.gguf ./fx-local.sh     (another F32 or F16 GGUF with tools)\n" +
	"  CTX=4096 ./fx-local.sh            (a smaller context: less device memory)\n" +
	"\n" +
	"Slow and limited: every turn sends fx's whole prompt and tool list (thousands\n" +
	"of tokens) through the GPU, so a first reply can take minutes, and models this\n" +
	"small often miss what fx asks of them. Custom connections have no gateway\n" +
	"search, credit checks, /usage, Fast mode or provider order. Not offline: web\n" +
	"search and remote MCP servers still use the network (update checks are off\n" +
	"for this run).\n" +
	"\n" +
	"If it fails: quantized models (q4_0, q4_K_M ...) abort on guest Vulkan for\n" +
	"now (F32 and F16 run); the GPU's memory here is half the guest's memory, so a\n" +
	"model and its context that do not fit load partly or not at all on the GPU:\n" +
	"more guest memory (Settings), or a smaller CTX; a lost WebGPU device: run\n" +
	"./fx-local.sh again.\n";

export default {
	id: "fx-local",
	title: "fx (local model)",
	desc: "fx on a model in this browser's GPU: Ollama on guest Vulkan as fx's local connection; Qwen2.5-Coder 0.5B (994 MiB, tool calls; guest memory 3 GiB or more), Ollama and llama.cpp on first run",
	icon: "𝒇x",
	// fx's tile in the Ollama app's teal.
	colors: ["#0f766e", "#09090b"],
	needs: ollama.needs,
	packages: { debian: [...ollama.packages.debian, "jq"] },
	terminal: "window",
	files: {
		...Object.fromEntries(Object.entries(ollama.files).map(([p, f]) => [inOllama(p), f])),
		"fx-local.sh": { content: FX_LOCAL_SH, mode: 0o755 },
		README,
	},
	downloads: ollama.downloads.map((f) => ({ ...f, path: inOllama(f.path) })),
	commands: ["cat README", "./fx-local.sh"],
} satisfies TerminalApp;
