#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's GL option in headless Chromium: starts the page's Vite dev
// server (web/, on --port, default 8091; never 8080, the one used by hand),
// loads it with ?gl=1 on Debian without a data disk (?data=0: nothing is
// written to any IndexedDB store but this fresh browser profile's) and
// checks, in the real page:
//
//   1  vm.gl.ready resolves (the renderer on the page's WebGL2, the guest's
//      forwarder linked) and the Environment tab's Guest GL row names the
//      WebGL2 renderer
//   2  a login shell in the guest has GALLIUM_DRIVER=virpipe (kw-gl.sh, for
//      the page's kw.gl=1) and /tmp/.virgl_test exists
//   3  unless --no-apt: apt-get installs Mesa over the page's network (the
//      default Wisp server, deb.debian.org through the page's CORS mirror:
//      needs the internet), then `eglinfo -B -p surfaceless` in a login
//      shell reports the renderer `virgl (...)`
//
//   node test/gl/page-check.mjs [--port N] [--no-apt] [--chrome BIN] [--timeout S]
//
// WebGL2 here is ANGLE on SwiftShader (software). Exit 0 when every check
// run passed, 1 on a failure, 2 when it could not run.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, sleep, startServer } from "../../web/test/lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = Number(opt("--port", "8091"));
const timeout = Number(opt("--timeout", "1800")) * 1000;
const apt = !args.includes("--no-apt");
const chromeBin = opt("--chrome", process.env.CHROME || findChrome());
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
const say = (s) => console.log(`[${secs()}] ${s}`);

let fails = 0;
const report = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (!ok) fails++;
};

say(`dev server on 127.0.0.1:${port}`);
const server = await startServer({ port, host: "127.0.0.1", dev: true }).catch((e) => {
	console.error(`the dev server did not start: ${e.message}`);
	process.exit(2);
});
const profile = mkdtempSync(join(tmpdir(), "kw-glpage-"));
const dport = 30000 + Math.floor(Math.random() * 20000);
const chrome = spawn(chromeBin, [
	"--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
	`--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });
const cleanup = async () => {
	chrome.kill("SIGKILL");
	await server.kill();
	rmSync(profile, { recursive: true, force: true });
};
const watchdog = setTimeout(async () => {
	console.error(`no result within ${timeout / 1000} s`);
	await cleanup();
	process.exit(2);
}, timeout);

try {
	let target;
	for (let i = 0; i < 100 && !target; i++) {
		await sleep(100);
		try { target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
	}
	if (!target) throw new Error(`${chromeBin} did not start`);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let id = 0;
	const pending = new Map();
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		if (msg.method === "Runtime.consoleAPICalled") {
			const line = msg.params.args.map((a) => a.value ?? a.description).join(" ");
			if (/guest GL|\[gl\]|gl:/.test(line)) say(`page: ${line}`);
		}
	};
	const send = (method, params = {}) => new Promise((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value;
	};
	await send("Runtime.enable");
	const url = `http://127.0.0.1:${port}/?gl=1&distro=debian&data=0&cpus=1&mem=1024&autosuspend=0&askleave=0`;
	say(`open ${url}`);
	await send("Page.navigate", { url });
	for (let i = 0; i < 600 && !(await evaluate("typeof globalThis.KW?.ready === 'function'").catch(() => false)); i++) await sleep(200);

	// 1: the renderer and the forwarder
	const ready = await evaluate(`KW.ready().then((vm) => vm.gl ? vm.gl.ready : Promise.reject(new Error("no vm.gl (GL off?)")))`);
	say(`vm.gl.ready: ${ready}`);
	// The Environment tab's row, as Copy diagnostics lists it ("  [pass] Guest GL: <renderer> (...)").
	const row = await evaluate(`(async () => { for (let i = 0; i < 50; i++) { const l = KW.ui.diagText().split("\\n").find((x) => / Guest GL: /.test(x)); if (l && !/ Guest GL: starting/.test(l)) return l.trim(); await new Promise((r) => setTimeout(r, 100)); } return ""; })()`);
	say(`row: ${row}`);
	report("gl ready", typeof ready === "string" && ready.length > 0 && /^\[(pass|warn)\] Guest GL: /.test(row), row.slice(0, 160));

	// 2: the guest's shells
	const env = await evaluate(`KW.vm.exec("bash", ["-lc", 'echo "GALLIUM_DRIVER=$GALLIUM_DRIVER LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE"; grep -o "kw.gl=1" /proc/cmdline; test -S /tmp/.virgl_test && echo socket'], { timeout: 60000 }).then((r) => r.stdout)`);
	report("guest env", /GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1/.test(env) && /kw\.gl=1/.test(env) && /socket/.test(env), env.trim().replace(/\n/g, "; "));

	// 3: Mesa from apt, then eglinfo on virgl
	if (apt) {
		say("apt-get install mesa-utils libegl-mesa0 libgles2 (over the page's network)");
		const inst = await evaluate(`KW.vm.exec("bash", ["-c", 'export DEBIAN_FRONTEND=noninteractive; i() { apt-get install -y -q --no-install-recommends mesa-utils libegl-mesa0 libgles2 </dev/null; }; i || { apt-get update -q && i; }'], { user: "root", timeout: 1500000 }).then((r) => ({ code: r.exitCode, tail: (r.stdout + r.stderr).slice(-600) }))`);
		say(`apt-get: exit ${inst.code}`);
		if (inst.code !== 0) report("apt-get", false, inst.tail);
		else {
			const e = await evaluate(`KW.vm.exec("bash", ["-lc", "eglinfo -B -p surfaceless"], { timeout: 300000 }).then((r) => ({ code: r.exitCode, out: r.stdout + r.stderr }))`);
			const es = /OpenGL ES profile renderer: (.*)/.exec(e.out)?.[1] ?? "?";
			const ver = /OpenGL ES profile version: (.*)/.exec(e.out)?.[1] ?? "?";
			report("eglinfo", e.code === 0 && /^virgl \(/.test(es), `GLES renderer "${es}", version "${ver}"`);
		}
	}
	const stats = await evaluate("JSON.stringify(KW.vm.gl.stats)");
	say(`vm.gl.stats ${stats}`);
} catch (e) {
	console.error(`could not run: ${e?.stack || e}`);
	clearTimeout(watchdog);
	await cleanup();
	process.exit(2);
}
clearTimeout(watchdog);
await cleanup();
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
