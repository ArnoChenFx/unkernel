// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Node.js: Alpine's aarch64 nodejs (main, about 25 MB) serving a live
// dashboard on port 3000 with node:http alone, so no npm install.
//
// The page polls api/stats every 2 s with fetch: the preview relays plain
// HTTP only (no WebSockets, no streamed responses such as SSE, no cookies).
// URLs are relative, since the page is served under /vm/<id>/3000/. The
// server listens on 0.0.0.0, not ::, because the guest has no IPv6 and the
// preview connects to 127.0.0.1. index.html is read on every request, so
// edits show on reload; server.mjs needs Ctrl-C and ./run.sh. Each request
// logs one line in the window, the page's own polls included, so the
// terminal shows the preview's traffic. api/bench runs only on a click.
import type { Demo } from "../launcher.ts";

const SERVER = `// The unkernel Node.js demo: node:http and nothing else, so no npm install.
//   GET /           index.html, read on every request (edit it and reload)
//   GET /api/stats  the live numbers the page polls
//   GET /api/bench  a short benchmark, run when the page asks
// PORT and HOST override where it listens. One log line per request.
import http from "node:http";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // IPv4: the guest has no IPv6
const PAGE = new URL("index.html", import.meta.url);
const readyIn = process.uptime(); // seconds from exec to here
let requests = 0;

// The histogram's samples include its own timer interval: lag subtracts it.
const RESOLUTION = 20;
const loop = monitorEventLoopDelay({ resolution: RESOLUTION });
loop.enable();
let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();
const lag = (ns) => Math.max(0, Math.round(((ns || 0) / 1e6 - RESOLUTION) * 100) / 100);

function stats() {
	const now = process.hrtime.bigint();
	const cpu = process.cpuUsage(lastCpu); // microseconds since the last poll
	const wall = Number(now - lastAt) / 1000;
	lastCpu = process.cpuUsage();
	lastAt = now;
	const cpus = os.cpus();
	const s = {
		versions: process.versions,
		platform: process.platform,
		arch: os.arch(),
		machine: os.machine(),
		type: os.type(),
		release: os.release(),
		hostname: os.hostname(),
		cpus: cpus.length,
		cpuModel: cpus[0] && cpus[0].model !== "unknown" ? cpus[0].model : "", // unknown where /proc/cpuinfo names no model (as here)
		loadavg: os.loadavg(),
		totalmem: os.totalmem(),
		freemem: os.freemem(),
		osUptime: os.uptime(),
		uptime: process.uptime(),
		readyIn,
		pid: process.pid,
		execPath: process.execPath,
		memory: process.memoryUsage(),
		cpuPercent: wall > 0 ? Math.round(((cpu.user + cpu.system) / wall) * 1000) / 10 : 0,
		loop: { mean: lag(loop.mean), p99: lag(loop.percentile(99)), max: lag(loop.max) },
		requests,
		now: Date.now(),
	};
	loop.reset();
	return s;
}

function bench() {
	// SHA-256 through OpenSSL for 300 ms, then a sieve in plain JavaScript,
	// which V8 compiles to arm64 code.
	const buf = crypto.randomBytes(64 * 1024);
	let bytes = 0;
	const t0 = performance.now();
	while (performance.now() - t0 < 300) {
		crypto.createHash("sha256").update(buf).digest();
		bytes += buf.length;
	}
	const shaMiBs = bytes / 1048576 / ((performance.now() - t0) / 1000);
	const n = 1000000;
	const t1 = performance.now();
	const composite = new Uint8Array(n + 1);
	let primes = 0;
	for (let i = 2; i <= n; i++) {
		if (composite[i]) continue;
		primes++;
		for (let j = i * i; j <= n; j += i) composite[j] = 1;
	}
	const sieveMs = performance.now() - t1;
	return { shaMiBs: Math.round(shaMiBs * 10) / 10, sieveN: n, primes, sieveMs: Math.round(sieveMs * 10) / 10 };
}

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? "\\x1b[" + code + "m" + s + "\\x1b[0m" : s);

function log(req, res, t0, n) {
	const time = new Date().toTimeString().slice(0, 8);
	const st = res.statusCode;
	const took = (performance.now() - t0).toFixed(1) + " ms";
	console.log(paint(90, time) + "  " + paint(90, "#" + n) + "  " + req.method + " " + req.url + "  " +
		paint(st < 300 ? 32 : st < 400 ? 36 : 33, String(st)) + "  " + paint(90, took));
}

function send(res, status, type, body) {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(body);
}

const server = http.createServer(async (req, res) => {
	const t0 = performance.now();
	const n = ++requests;
	res.on("finish", () => log(req, res, t0, n));
	const path = new URL(req.url, "http://localhost").pathname;
	try {
		if (path === "/" || path === "/index.html") send(res, 200, "text/html; charset=utf-8", await fs.readFile(PAGE));
		else if (path === "/api/stats") send(res, 200, "application/json", JSON.stringify(stats()));
		else if (path === "/api/bench") send(res, 200, "application/json", JSON.stringify(bench()));
		else if (path === "/favicon.ico") send(res, 204, "text/plain", "");
		else send(res, 404, "text/plain", "not found: " + path + "\\n");
	} catch (e) {
		send(res, 500, "text/plain", String((e && e.stack) || e) + "\\n");
	}
});

server.listen(PORT, HOST, () => {
	console.log(paint(1, "Node.js " + process.version) + " on " + os.type() + " " + os.release() + " " + os.arch() +
		", pid " + process.pid + ", ready " + readyIn.toFixed(1) + " s after exec");
	console.log("Listening on http://" + HOST + ":" + PORT + "/, one line per request. Ctrl-C stops it.");
});
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Node.js in unkernel</title>
<style>
	:root { color-scheme: dark; --fg: #ededed; --dim: #a1a1a1; --line: #262626; --card: #0a0a0a; --green: #5fa04e; --lime: #8cc84b; }
	* { box-sizing: border-box; }
	body { margin: 0; background: #000; color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
	main { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
	header { display: flex; gap: 1rem; align-items: center; }
	header svg { flex: none; width: 3rem; height: 3rem; }
	h1 { margin: 0; font-size: 1.6rem; }
	h2 { margin: 0 0 .75rem; font-size: .8rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
	p { color: var(--dim); max-width: 44rem; }
	code, .mono { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
	code { background: #1a1a1a; padding: .1rem .35rem; border-radius: 4px; color: var(--fg); }
	.live { display: inline-flex; align-items: center; gap: .4rem; margin-left: auto; padding: .2rem .7rem; border: 1px solid var(--line); border-radius: 99px; font-size: 13px; color: var(--dim); white-space: nowrap; }
	.live i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--dim); }
	.live.ok i { background: var(--lime); animation: pulse 2s infinite; }
	.live.bad i { background: #f87171; }
	@keyframes pulse { 50% { opacity: .35; } }
	.hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .75rem; margin: 1.5rem 0 .75rem; }
	.hero div { padding: 1rem; border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(135deg, #10200c, var(--card) 70%); }
	.hero span { display: block; color: var(--dim); font: 12px ui-monospace, monospace; }
	.hero b { display: block; margin-top: .25rem; font-size: 1.5rem; font-weight: 600; color: var(--lime); overflow-wrap: anywhere; }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: .75rem; }
	section { padding: 1rem; border: 1px solid var(--line); border-radius: 10px; background: var(--card); min-width: 0; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; margin: 0; }
	dt { color: var(--dim); }
	dd { margin: 0; text-align: right; font: 13px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; }
	.bar { height: 6px; margin: .2rem 0 .7rem; border-radius: 3px; background: #1f1f1f; overflow: hidden; }
	.bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--green), var(--lime)); transition: width .4s; }
	.spark { display: block; width: 100%; height: 3rem; margin-top: .75rem; }
	.spark polyline { fill: none; stroke: var(--lime); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
	.spark polygon { fill: rgba(140, 200, 75, .12); }
	.cap { display: flex; justify-content: space-between; font-size: 12px; color: var(--dim); }
	button { font: inherit; color: #000; background: var(--lime); border: 0; border-radius: 6px; padding: .4rem .9rem; cursor: pointer; font-weight: 600; }
	button:disabled { opacity: .5; cursor: progress; }
	footer { margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
	<header>
		<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 3l18 10.5v21L24 45 6 34.5v-21z" fill="none" stroke="#8cc84b" stroke-width="3" stroke-linejoin="round"/><text x="24" y="30" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" font-weight="700" fill="#8cc84b">JS</text></svg>
		<div>
			<h1>Node.js, running in your browser</h1>
			<div class="mono" style="color:var(--dim)" id="who">connecting...</div>
		</div>
		<span class="live" id="live"><i></i><span id="livetext">waiting</span></span>
	</header>
	<p>This page comes from <code>node:http</code> in <code>server.mjs</code>. Node is Alpine's aarch64 build, unmodified, on a Linux kernel compiled to WebAssembly, in your browser. Every number below is the guest's own, polled every 2 seconds.</p>

	<div class="hero">
		<div><span>process.version</span><b id="h-version">-</b></div>
		<div><span>os.arch()</span><b id="h-arch">-</b></div>
		<div><span>os.release()</span><b id="h-release">-</b></div>
		<div><span>requests served</span><b id="h-requests">-</b></div>
	</div>

	<div class="grid">
		<section>
			<h2>Runtime</h2>
			<dl>
				<dt>V8</dt><dd id="v8">-</dd>
				<dt>libuv</dt><dd id="uv">-</dd>
				<dt>OpenSSL</dt><dd id="openssl">-</dd>
				<dt>process.platform</dt><dd id="platform">-</dd>
				<dt>pid</dt><dd id="pid">-</dd>
				<dt>execPath</dt><dd id="exec">-</dd>
				<dt>exec to listening</dt><dd id="ready">-</dd>
				<dt>process.uptime()</dt><dd id="uptime">-</dd>
			</dl>
		</section>
		<section>
			<h2>System</h2>
			<dl>
				<dt>os.type()</dt><dd id="type">-</dd>
				<dt>os.machine()</dt><dd id="machine">-</dd>
				<dt>os.hostname()</dt><dd id="host">-</dd>
				<dt>os.cpus()</dt><dd id="cpus">-</dd>
				<dt>os.loadavg()</dt><dd id="load">-</dd>
				<dt>os.uptime()</dt><dd id="osup">-</dd>
			</dl>
		</section>
		<section>
			<h2>Memory</h2>
			<div class="cap"><span>V8 heap used / total</span><span class="mono" id="heap">-</span></div>
			<div class="bar"><i id="heapbar"></i></div>
			<div class="cap"><span>Guest RAM used / total</span><span class="mono" id="ram">-</span></div>
			<div class="bar"><i id="rambar"></i></div>
			<dl>
				<dt>rss</dt><dd id="rss">-</dd>
				<dt>external</dt><dd id="ext">-</dd>
			</dl>
			<svg class="spark" id="heapspark" viewBox="0 0 59 100" preserveAspectRatio="none"><polygon/><polyline/></svg>
			<div class="cap"><span>heap used, last 2 min</span><span class="mono" id="heapmax"></span></div>
		</section>
		<section>
			<h2>Event loop</h2>
			<dl>
				<dt>node CPU</dt><dd id="cpu">-</dd>
				<dt>loop delay mean / p99</dt><dd id="loop">-</dd>
				<dt>round trip (this page)</dt><dd id="rtt">-</dd>
			</dl>
			<svg class="spark" id="rttspark" viewBox="0 0 59 100" preserveAspectRatio="none"><polygon/><polyline/></svg>
			<div class="cap"><span>round trip: page, service worker, vsock, node, and back</span><span class="mono" id="rttmax"></span></div>
		</section>
		<section>
			<h2>Benchmark</h2>
			<p style="margin-top:0">SHA-256 through Node's OpenSSL for 300 ms, then a sieve of Eratosthenes in plain JavaScript, which V8 compiles to arm64 code for the emulated CPU to run.</p>
			<button id="bench">Run</button>
			<dl style="margin-top:.75rem">
				<dt>sha256</dt><dd id="sha">-</dd>
				<dt>sieve</dt><dd id="sieve">-</dd>
			</dl>
		</section>
	</div>

	<footer><p>Edit <code>index.html</code> in the terminal and reload this preview: the server reads it on every request. After changing <code>server.mjs</code>, press Ctrl-C there and run <code>./run.sh</code> again.</p></footer>
</main>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const set = (id, v) => { $(id).textContent = v; };
const mib = (b) => (b / 1048576).toFixed(1) + " MiB";
function dur(s) {
	s = Math.floor(s);
	const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
	return (d ? d + " d " : "") + (d || h ? h + " h " : "") + (d || h || m ? m + " min " : "") + (s % 60) + " s";
}
function spark(id, data, maxId, unit) {
	const svg = $(id), max = Math.max(1e-9, ...data);
	const pts = data.map((v, i) => (59 - (data.length - 1) + i) + "," + (98 - (v / max) * 92).toFixed(1)).join(" ");
	svg.querySelector("polyline").setAttribute("points", pts);
	const x0 = 59 - (data.length - 1);
	svg.querySelector("polygon").setAttribute("points", x0 + ",100 " + pts + " 59,100");
	set(maxId, "max " + unit(max));
}
const heapHist = [], rttHist = [];
const push = (a, v) => { a.push(v); if (a.length > 60) a.shift(); };

async function poll() {
	if (document.hidden) return setTimeout(poll, 2000);
	const t0 = performance.now();
	try {
		const r = await fetch("api/stats", { cache: "no-store" });
		if (!r.ok) throw new Error("HTTP " + r.status);
		const s = await r.json();
		const rtt = performance.now() - t0;
		render(s, rtt);
		$("live").className = "live ok";
		set("livetext", "live");
	} catch (e) {
		$("live").className = "live bad";
		set("livetext", "offline: is node still running?");
	}
	setTimeout(poll, 2000);
}

function render(s, rtt) {
	const v = s.versions;
	set("who", "node " + v.node + " · " + s.type + " " + s.release + " · " + s.arch);
	set("h-version", "v" + v.node);
	set("h-arch", s.arch);
	set("h-release", s.release);
	set("h-requests", s.requests.toLocaleString());
	set("v8", v.v8);
	set("uv", v.uv);
	set("openssl", v.openssl);
	set("platform", s.platform);
	set("pid", s.pid);
	set("exec", s.execPath);
	set("ready", s.readyIn.toFixed(2) + " s");
	set("uptime", dur(s.uptime));
	set("type", s.type + " " + s.release);
	set("machine", s.machine);
	set("host", s.hostname);
	set("cpus", s.cpus + (s.cpuModel ? " × " + s.cpuModel : ""));
	set("load", s.loadavg.map((x) => x.toFixed(2)).join("  "));
	set("osup", dur(s.osUptime));
	const m = s.memory, used = s.totalmem - s.freemem;
	set("heap", mib(m.heapUsed) + " / " + mib(m.heapTotal));
	$("heapbar").style.width = (100 * m.heapUsed / m.heapTotal).toFixed(1) + "%";
	set("ram", mib(used) + " / " + mib(s.totalmem));
	$("rambar").style.width = (100 * used / s.totalmem).toFixed(1) + "%";
	set("rss", mib(m.rss));
	set("ext", mib(m.external));
	set("cpu", s.cpuPercent.toFixed(1) + " %");
	set("loop", s.loop.mean.toFixed(1) + " / " + s.loop.p99.toFixed(1) + " ms");
	set("rtt", rtt.toFixed(0) + " ms");
	push(heapHist, m.heapUsed);
	push(rttHist, rtt);
	spark("heapspark", heapHist, "heapmax", mib);
	spark("rttspark", rttHist, "rttmax", (x) => x.toFixed(0) + " ms");
}

$("bench").onclick = async () => {
	const b = $("bench");
	b.disabled = true;
	b.textContent = "Running...";
	try {
		const r = await fetch("api/bench", { cache: "no-store" });
		const x = await r.json();
		set("sha", x.shaMiBs.toFixed(1) + " MiB/s");
		set("sieve", x.primes.toLocaleString() + " primes below " + x.sieveN.toLocaleString() + " in " + x.sieveMs.toFixed(0) + " ms");
	} catch (e) {
		set("sha", "failed: " + e.message);
	} finally {
		b.disabled = false;
		b.textContent = "Run again";
	}
};
poll();
</script>
</body>
</html>
`;

export default {
	id: "node",
	title: "Node.js",
	desc: "A node:http server with a live dashboard of the guest's runtime, CPU and memory",
	// The Node.js logo, from Simple Icons (CC0 1.0), slug nodedotjs.
	icon: { svg: '<path d="M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z"/>' },
	colors: ["#7cc35a", "#1f4d22"],
	needs: { net: true },
	files: {
		"server.mjs": SERVER,
		"index.html": PAGE,
	},
	packages: ["nodejs"],
	commands: ["node server.mjs"],
	ports: [3000],
} satisfies Demo;
