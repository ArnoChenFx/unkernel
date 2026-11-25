#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The host decoder of guest VA-API (va/PROTOCOL.md) on this host, for the
// driver's native build (va/build.sh native): starts headless Chrome,
// serves it a page with a VaHost (js/core/va.ts, from its sources) on a
// stand-in vsock, and carries each TCP connection to the page and back
// over one WebSocket. The page's log lines come out on stderr.
//
//   node test/va/relay.mjs [--port N] [--browser BIN] [--inject WHAT:EVERY[:COUNT]] [--dump DIR] [-- CMD ARGS...]
//
// --inject: VaHost.inject()'s test hook after every EVERY pictures (COUNT
// times, default always): reclaim, error, flush (the decoder made again and
// the stream replayed) or fail (the picture fails, its output dropped).
// --dump DIR: every chunk the host decodes (not replays or fillers) appended to
// DIR/ctx-ID.PROFILE, the stream the decoder got (H.264: Annex B; AV1: OBUs),
// to decode it with a native decoder against the original. --stub-hevc: HEVC
// decoded by a stand-in (grey pictures) where WebCodecs has no HEVC decoder,
// for --dump. --hold-extra N: VaOptions.holdExtra (H.264 and HEVC declare N
// more reorder frames than they need; 16 keeps HEVC's SPS the same through
// the stream, so a dump decodes natively).
//
// Default port 10220 (0 picks one). With `-- CMD ARGS...` it runs the
// command with KWVA_LINK=tcp:127.0.0.1:PORT once the page is up, then exits
// with its status and prints the host's stats, e.g.
//
//   node test/va/relay.mjs -- vendor/build/va/native/va-decode -d vendor/build/va/native/kw_drv_video.so clip.ivf
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptWebSocket } from "../ws-server.ts";

process.removeAllListeners("warning");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const args = dash >= 0 ? argv.slice(0, dash) : argv;
const cmd = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt("--port", "10220"));
const browser = opt("--browser", process.env.CHROME || join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"));
const say = (s) => console.error(s);

// The page: a VaHost on a vsock of its own; each connection's bytes come and go over the WebSocket.
const PAGE = `<!doctype html><meta charset="utf-8"><title>kwva relay</title><script type="module">
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.binaryType = "arraybuffer";
const enc = new TextEncoder();
function msg(id, kind, payload) {
	const b = new Uint8Array(5 + payload.length);
	new DataView(b.buffer).setUint32(0, id, true);
	b[4] = kind;
	b.set(payload, 5);
	ws.send(b);
}
const log = (line) => { console.log(line); if (ws.readyState === 1) msg(0, 3, enc.encode(String(line))); };
addEventListener("error", (e) => log("page error: " + (e.error?.stack ?? e.message)));
addEventListener("unhandledrejection", (e) => log("page rejection: " + (e.reason?.stack ?? e.reason)));
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const { VaHost } = await import("/js/core/va.ts");
// --stub-hevc: a stand-in decoder for HEVC (none here takes it), whose outputs are grey: with --dump, the access units
// the host makes go to the dump to be decoded natively
if (new URLSearchParams(location.search).get("stubhevc")) {
	const Real = globalThis.VideoDecoder;
	const isHevc = (c) => /^(hev1|hvc1)\./.test(c?.codec ?? "");
	class Stub {
		state = "unconfigured"; decodeQueueSize = 0; #out; #w = 16; #h = 16;
		constructor(init) { this.#out = init.output; }
		configure(c) { this.state = "configured"; this.#w = c.codedWidth; this.#h = c.codedHeight; }
		decode(ch) {
			const ts = ch.timestamp, w = this.#w, h = this.#h;
			queueMicrotask(() => this.state === "configured" && this.#out(new VideoFrame(new Uint8Array(w * h * 3 / 2).fill(128), { format: "I420", codedWidth: w, codedHeight: h, timestamp: ts })));
		}
		async flush() {}
		close() { this.state = "closed"; }
	}
	globalThis.VideoDecoder = class {
		constructor(init) {
			let real = null, stub = null;
			const self = this;
			Object.defineProperty(this, "state", { get: () => (stub ?? real)?.state ?? "unconfigured" });
			Object.defineProperty(this, "decodeQueueSize", { get: () => (stub ?? real)?.decodeQueueSize ?? 0 });
			this.configure = (c) => { if (isHevc(c)) (stub ??= new Stub(init)).configure(c); else (real ??= new Real(init)).configure(c); };
			this.decode = (ch) => (stub ?? real).decode(ch);
			this.flush = () => (stub ?? real).flush();
			this.close = () => { (stub ?? real)?.close(); };
			void self;
		}
		static isConfigSupported(c) { return isHevc(c) ? Promise.resolve({ supported: true, config: c }) : Real.isConfigSupported(c); }
	};
}
let accept;
const vsock = { listen(port, cb) { accept = cb; return { close() {} }; } };
const dump = new URLSearchParams(location.search).get("dump");
const holdExtra = Number(new URLSearchParams(location.search).get("holdextra") || 0);
const host = new VaHost(vsock, dump ? { holdExtra, dump: (c) => {
	const head = enc.encode(JSON.stringify({ ctx: c.ctx, profile: c.profile, key: c.key }));
	const b = new Uint8Array(4 + head.length + c.data.length);
	new DataView(b.buffer).setUint32(0, head.length, true);
	b.set(head, 4);
	b.set(c.data, 4 + head.length);
	msg(0, 7, b);
} } : { holdExtra }, log);
globalThis.host = host;
const inj = new URLSearchParams(location.search).get("inject");
if (inj) {
	const [what, every, count] = inj.split(":");
	host.inject(what, { every: Number(every), count: count ? Number(count) : undefined });
}
const conns = new Map();
ws.addEventListener("message", (ev) => {
	const b = new Uint8Array(ev.data);
	const id = new DataView(b.buffer).getUint32(0, true), kind = b[4], payload = b.slice(5);
	if (kind === 0) {
		let ctl;
		const readable = new ReadableStream({ start(c) { ctl = c; } });
		const writable = new WritableStream({ write(chunk) { msg(id, 1, chunk); } });
		const conn = { readable, writable, reset() { msg(id, 2, new Uint8Array(0)); try { ctl.close(); } catch {} }, close() { msg(id, 2, new Uint8Array(0)); } };
		conns.set(id, ctl);
		accept(conn);
	} else if (kind === 1) conns.get(id)?.enqueue(payload);
	else if (kind === 2) { try { conns.get(id)?.close(); } catch {} conns.delete(id); }
	else if (kind === 6) msg(0, 6, enc.encode(JSON.stringify({ status: host.status, stats: host.stats })));
});
msg(0, 4, enc.encode(JSON.stringify({ VideoDecoder: typeof VideoDecoder })));
</script>`;

let page = null;
const toPage = [];
let resolveReady, resolveStats;
const ready = new Promise((r) => (resolveReady = r));
const sockets = new Map();
let nextId = 1;
function sendPage(id, kind, payload) {
	const b = Buffer.alloc(5 + payload.length);
	b.writeUInt32LE(id, 0);
	b[4] = kind;
	b.set(payload, 5);
	if (page) page.send(b);
	else toPage.push(b);
}
const server = createServer((req, res) => {
	const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
	if (p === "/") {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		return res.end(PAGE);
	}
	const rel = normalize(p.slice(1));
	const file = join(root, rel);
	if (/^js\/.*\.ts$/.test(rel) && existsSync(file) && statSync(file).isFile()) {
		res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
		return res.end(stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip", sourceUrl: rel }));
	}
	res.writeHead(404);
	res.end();
});
server.on("upgrade", (req, socket, head) => {
	page = acceptWebSocket(req, socket, head, (b) => {
		const id = b.readUInt32LE(0), kind = b[4], payload = b.subarray(5);
		if (kind === 1) sockets.get(id)?.write(payload);
		else if (kind === 2) {
			sockets.get(id)?.end();
			sockets.delete(id);
		} else if (kind === 3) say(payload.toString());
		else if (kind === 4) resolveReady(JSON.parse(payload.toString()));
		else if (kind === 6) resolveStats?.(JSON.parse(payload.toString()));
		else if (kind === 7 && dumpDir) {
			// a chunk the host decoded: appended to DIR/ctx-ID.PROFILE (Annex B, OBUs: what the decoder got)
			const n = payload.readUInt32LE(0), head = JSON.parse(payload.subarray(4, 4 + n).toString());
			appendFileSync(join(dumpDir, `ctx-${head.ctx}.${head.profile}`), payload.subarray(4 + n));
		}
	}, () => (page = null));
	for (const b of toPage.splice(0)) page.send(b);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const profile = mkdtempSync(join(tmpdir(), "kwva-relay."));
const inject = opt("--inject");
const dumpDir = opt("--dump") ? resolve(opt("--dump")) : null;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
const query = new URLSearchParams();
if (inject) query.set("inject", inject);
if (dumpDir) query.set("dump", "1");
if (args.includes("--stub-hevc")) query.set("stubhevc", "1");
if (opt("--hold-extra")) query.set("holdextra", opt("--hold-extra"));
const chrome = spawn(browser, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/?${query}`],
	{ stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr = (chromeErr + d).slice(-20000)));
chrome.on("exit", (c) => {
	say(`relay: the browser exited (${c}): ${chromeErr.slice(-2000)}`);
	cleanup(2);
});
function cleanup(code) {
	try {
		chrome.kill("SIGKILL");
	} catch {}
	rmSync(profile, { recursive: true, force: true });
	process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => cleanup(0));
const r = await Promise.race([ready, new Promise((res) => setTimeout(() => res(null), 60_000))]);
if (!r) {
	say(`relay: no answer from the page within 60 s\n${chromeErr.slice(-2000)}`);
	cleanup(2);
}
say(`relay: page up (VideoDecoder: ${r.VideoDecoder})`);
const tcp = net.createServer((sock) => {
	const id = nextId++;
	sockets.set(id, sock);
	sock.setNoDelay(true);
	sendPage(id, 0, Buffer.alloc(0));
	sock.on("data", (d) => sendPage(id, 1, d));
	const end = () => {
		if (!sockets.has(id)) return;
		sockets.delete(id);
		sendPage(id, 2, Buffer.alloc(0));
	};
	sock.on("end", end);
	sock.on("close", end);
	sock.on("error", () => {});
});
await new Promise((res, j) => tcp.listen(port, "127.0.0.1", res).on("error", j));
const link = `tcp:127.0.0.1:${tcp.address().port}`;
say(`relay: listening on ${link}`);
if (cmd.length) {
	const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, KWVA_LINK: link } });
	child.on("exit", async (code, sig) => {
		const st = await Promise.race([new Promise((res) => ((resolveStats = res), sendPage(0, 6, Buffer.alloc(0)))), new Promise((res) => setTimeout(() => res(null), 2000))]);
		say(`relay: host ${JSON.stringify(st)}`);
		cleanup(code ?? (sig ? 128 : 1));
	});
}
