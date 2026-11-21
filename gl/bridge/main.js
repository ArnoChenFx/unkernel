// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page: connects to vtest-bridge (the server it was loaded from), hosts
// one renderer, and moves each client's bytes between the two in order.
// ?renderer=wasm (the default) is virglrenderer compiled to wasm
// (gl/wasm) on this page's WebGL2 context, loaded from ./virgl.mjs or
// ?module=URL; ?renderer=relay&relay=ws://HOST:PORT/ is the stand-in that
// relays to a native server (README.md).
import { MUX, encode, decode, connect } from "./mux.js";
import { RelayRenderer } from "./relay.js";

const params = new URLSearchParams(location.search);
const text = new TextEncoder();
// ?transport=websocket: plain WebSocket in place of WebSocketStream
const transport = { stream: params.get("transport") !== "websocket" };
let bridge = null;

function log(...args) {
  const s = args.join(" ");
  console.log(s);
  document.getElementById("log")?.append(s + "\n");
  bridge?.send(encode(MUX.LOG, 0, text.encode(s)));
}
addEventListener("error", (e) => log("error:", e.message, e.filename + ":" + e.lineno));
addEventListener("unhandledrejection", (e) => log("error:", e.reason?.stack || e.reason));

function webgl2() {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  if (!gl) return "none";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return `${gl.getParameter(gl.VERSION)}, ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "?"}`;
}

// ?glcheck=1: the renderer gets a wrapper of the context that logs every call
// that raises a GL error (getError still reports it), for debugging.
function checkedGL(gl) {
  let pending = 0;
  const fmt = (a) =>
    typeof a === "number" ? (a > 255 ? "0x" + a.toString(16) : a) : a?.constructor ? a.constructor.name : String(a);
  return new Proxy(gl, {
    get(t, p) {
      const val = t[p];
      if (typeof val !== "function") return val;
      if (p === "getError") return () => { const e = pending || t.getError(); pending = 0; return e; };
      return (...a) => {
        const r = val.apply(t, a);
        const e = t.getError();
        if (e) {
          log(`GL error 0x${e.toString(16)} from ${String(p)}(${a.map(fmt).join(", ")})`);
          pending ||= e;
        }
        return r;
      };
    },
  });
}

// ?glcount=1: the renderer gets a wrapper of the context that logs the 25
// WebGL calls it made most often every 2 s, for profiling.
function countedGL(gl) {
  const n = {};
  setInterval(() => {
    const top = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 25);
    log("glcount " + top.map(([k, c]) => `${k}=${c}`).join(" "));
    for (const k in n) delete n[k];
  }, 2000);
  return new Proxy(gl, {
    get(t, p) {
      const val = t[p];
      if (typeof val !== "function") return val;
      return (...a) => ((n[p] = (n[p] || 0) + 1), val.apply(t, a));
    },
  });
}

// The wasm renderer: one WebGL2 context on an OffscreenCanvas, which the
// renderer never draws to (every frame goes to its own framebuffers and back
// by readback), so the default framebuffer is as small as it gets.
async function wasmRenderer() {
  const { default: createVirgl } = await import(params.get("module") || "./virgl.mjs");
  const say = (s) => log("virgl:", s);
  const Module = await createVirgl({ print: say, printErr: say });
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2", {
    alpha: false, depth: false, stencil: false, antialias: false, powerPreference: "high-performance",
  });
  if (!gl) throw new Error("no WebGL2");
  gl.canvas.addEventListener("webglcontextlost", () => log("error: the WebGL2 context was lost"));
  return new Module.virgl.Renderer(params.has("glcheck") ? checkedGL(gl) : params.has("glcount") ? countedGL(gl) : gl);
}

async function createRenderer() {
  const kind = params.get("renderer") || "wasm";
  if (kind === "wasm") return wasmRenderer();
  if (kind === "relay") return new RelayRenderer(params.get("relay") || "ws://127.0.0.1:7801/", transport);
  throw new Error(`unknown renderer ${kind}`);
}

async function main() {
  bridge = await connect(`ws://${location.host}/`, transport);
  const renderer = await createRenderer();
  renderer.onreply = (id, bytes) => bridge.send(encode(MUX.DATA, id, bytes));
  renderer.onclose = (id, why) => {
    log(`client ${id}: ${why}`);
    bridge.send(encode(MUX.CLOSE, id));
  };
  const what = await renderer.init();
  log(`ready: ${what}; bridge over ${bridge.kind}; WebGL2: ${webgl2()}`);
  bridge.send(encode(MUX.READY, 0));
  for (;;) {
    const m = await bridge.read();
    if (!m) break;
    const { type, id, payload } = decode(m);
    if (type === MUX.OPEN) renderer.open(id);
    else if (type === MUX.CLOSE) {
      const s = renderer.stats?.(id);
      if (s) log(`client ${id}: closed after ${s.parks} parked busy waits, ${s.parkedMs.toFixed(0)} ms parked`);
      renderer.close(id);
    }
    else if (type === MUX.DATA) {
      const busy = renderer.feed(id, payload);
      if (busy) await busy;
    }
  }
  log("bridge closed");
}

main().catch((e) => log("error:", e?.stack || e));
