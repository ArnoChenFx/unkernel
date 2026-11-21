#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest GL end to end in headless Chromium: unkernel (the built package,
// dist/) boots Debian with the prepared data disk (debian-disk.mjs: Mesa
// from apt, made once) and createKernel({ gl: true }), whose wasm renderer
// runs on the page's WebGL2 (ANGLE on SwiftShader here, software: the virgl
// numbers are a floor) and whose forwarder the SDK starts in the guest. The
// page (unkernel-page.js) runs, in the guest:
//
//   a  eglinfo -B -p surfaceless on virpipe: the renderer must be virgl
//   b  kwgl-state.c (built for the guest by build-guest-state.sh): seven
//      clients with different GL state interleaved on the page's renderer,
//      whose 60 frame checksums must equal those of each client run alone
//      (as vtest-check.sh state); with --state-ref FILE (a state.txt of
//      `test/gl/bridge-check.sh --wasm --keep state` on this host) they
//      must also equal the host's; the same clients on llvmpipe are
//      reported, not judged (another rasterizer rounds differently)
//   c  glmark2-es2 under Xvfb, the same scenes at the same size, on
//      llvmpipe and on virgl: FPS of each (default 640x480; build, texture,
//      shading=phong, jellyfish and desktop, 10 s each; --scenes takes a
//      comma-separated list of glmark2 -b values)
//
//   node test/gl/unkernel-check.mjs [--worker] [--size WxH] [--scenes LIST] [--skip a,b,c]
//        [--state-ref FILE] [--out DIR] [--browser BIN] [--gl-flags FLAGS] [--timeout S] [--no-build]
//
// --drm checks the virtio-gpu path instead (drm-page.js): a kernel with
// kwvirtio (--kernel, default $KW_BUILD/drm-base/unkernel.wasm) and
// createKernel({ gl: true, gpu: true }), and in the guest, with no GL
// environment variables:
//
//   a  eglinfo -B on the gbm and surfaceless platforms: the renderer must
//      be virgl, through /dev/dri; libdrm's drmdevice (drmGetDevices2, as
//      Mesa's loader enumerates) must list the card
//   b  kmscube (GBM buffers page-flipped with KMS): its frames must reach
//      the page's canvas (drawn from the renderer's texture, no readback)
//      and equal the scanout read back in the same task, and not be flat
//   c  glmark2-es2-drm against glmark2-es2 under Xvfb on virpipe (the vtest
//      path), the same scenes (default build, texture, shading=phong, 5 s
//      each) at the display's size (--size), on screen (DRM page flips are
//      paced by virtio-gpu's 60 Hz vblank timer; vtest reads each frame
//      back for Xvfb) and with --off-screen: FPS of each, reported
//   d  kwgl-state on the DRM path: interleaved against each client alone,
//      and against the same clients on the vtest path (the same renderer)
//   e  test/gpu/prime.c as the default user: a resource exported as a dmabuf
//      and imported by a second opener names the same host resource
//      (DRM_IOCTL_VIRTGPU_RESOURCE_INFO), and the host finds its texture
//      (GlHost.gpu.texture()) with the pattern the importer uploaded
//
// Builds first, each skipped when done: dist (pnpm build, unless
// --no-build), the disk ($KW_BUILD/gl/debian-gl.img), kwgl-state for the
// guest. Exit 0 when every step run passed, 1 on a failure, 2 when it could
// not run. Writes the steps' output, the frames (PPM), the page's log and
// the guest's console to --out (default a new /tmp/kwgl.* directory,
// printed). The images are served read-only with Range support; the
// guest's writes stay in the page's memory.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);
const timeout = Number(opt("--timeout", "3600")) * 1000;
const browser = opt("--browser", process.env.CHROMIUM || "chromium-headless");
const out = resolve(opt("--out", "") || mkdtempSync("/tmp/kwgl."));
mkdirSync(out, { recursive: true });
const drm = has("--drm");
const kernelFile = resolve(opt("--kernel", join(build, "drm-base/unkernel.wasm")));
const disk = join(build, "gl/debian-gl.img");
const distro = join(build, "distro/debian.erofs");
const stateBin = join(build, "gl/kwgl-state-aarch64");
const primeBin = join(out, "prime");

const step = (what, cmd, cmdArgs) => {
	console.log(`== ${what}`);
	const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`${what} failed`);
		process.exit(2);
	}
};
if (!existsSync(distro)) {
	console.error(`no ${distro} (kernel/build.sh distro debian)`);
	process.exit(2);
}
if (!has("--no-build")) step("pnpm build", "pnpm", ["build"]);
if (!existsSync(join(root, "dist/web.mjs")) || !existsSync(join(root, "dist/virgl.wasm"))) {
	console.error("no dist/web.mjs or dist/virgl.wasm (pnpm build)");
	process.exit(2);
}
step("the prepared disk", process.execPath, [join(here, "debian-disk.mjs"), "--out", disk]);
if (!existsSync(stateBin)) step("kwgl-state for the guest", join(here, "build-guest-state.sh"), [stateBin]);
if (drm && !existsSync(kernelFile)) {
	console.error(`no ${kernelFile} (a bundle with kwvirtio; --kernel)`);
	process.exit(2);
}
if (drm) step("test/gpu/prime.c for the guest", process.env.ZIG ?? "zig", ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", primeBin, join(root, "test/gpu/prime.c")]);

const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };
let resolveResult;
const result = new Promise((r) => (resolveResult = r));
const pageLog = join(out, "page.log"), consoleLog = join(out, "console.log");
writeFileSync(pageLog, "");
writeFileSync(consoleLog, "");

// A file with Range support (one range; HttpBase asks for nothing else).
function sendFile(req, res, file, type) {
	const st = statSync(file);
	const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
	const h = { "content-type": type, "accept-ranges": "bytes", etag, "cache-control": "no-cache" };
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
	let start = 0, end = st.size - 1, status = 200;
	if (m && (m[1] || m[2])) {
		if (m[1]) {
			start = Number(m[1]);
			if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
		} else start = Math.max(0, st.size - Number(m[2]));
		if (start >= st.size || start > end) {
			res.writeHead(416, { "content-range": `bytes */${st.size}`, etag });
			res.end();
			return;
		}
		status = 206;
		h["content-range"] = `bytes ${start}-${end}/${st.size}`;
	}
	h["content-length"] = String(end - start + 1);
	res.writeHead(status, h);
	if (req.method === "HEAD") res.end();
	else createReadStream(file, { start, end }).pipe(res);
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	const p = decodeURIComponent(url.pathname);
	if (req.method === "POST") {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		res.end("ok");
		if (p === "/log") {
			appendFileSync(pageLog, body + "\n");
			console.log(`page: ${body}`);
		} else if (p === "/console") appendFileSync(consoleLog, body);
		else if (p.startsWith("/file/") && /^[\w.-]+$/.test(p.slice(6))) writeFileSync(join(out, p.slice(6)), body);
		else if (p === "/result") resolveResult(body.toString());
		return;
	}
	if (p === "/img/debian.erofs") return sendFile(req, res, distro, "application/octet-stream");
	if (p === "/img/debian-gl.img") return sendFile(req, res, disk, "application/octet-stream");
	if (p === "/img/unkernel.wasm" && drm) return sendFile(req, res, kernelFile, "application/wasm");
	if (p === "/files/kwgl-state") return sendFile(req, res, stateBin, "application/octet-stream");
	if (p === "/files/prime" && drm) return sendFile(req, res, primeBin, "application/octet-stream");
	for (const [prefix, dir] of [["/dist/", join(root, "dist")], ["/test/", here]]) {
		if (!p.startsWith(prefix)) continue;
		const rel = normalize(p.slice(prefix.length));
		if (rel.startsWith("..") || !existsSync(join(dir, rel))) break;
		return sendFile(req, res, join(dir, rel), types[rel.slice(rel.lastIndexOf("."))] || "application/octet-stream");
	}
	res.writeHead(404);
	res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const query = new URLSearchParams();
if (has("--worker")) query.set("worker", "1");
for (const k of ["size", "scenes", "skip", "cmd"]) if (opt(`--${k}`)) query.set(k, opt(`--${k}`));
const url = `http://127.0.0.1:${server.address().port}/test/${drm ? "drm" : "unkernel"}.html?${query}`;
console.log(`== ${url}\n   output in ${out}`);

const t0 = Date.now();
// The WebGL2 here: ANGLE on SwiftShader; --gl-flags replaces these (e.g. "--use-angle=vulkan" or "" on a host with a GPU).
const glFlags = opt("--gl-flags", "--use-angle=swiftshader --enable-unsafe-swiftshader").split(" ").filter(Boolean);
const chrome = spawn(browser, [
	"--no-sandbox", "--headless", ...glFlags,
	"--no-first-run", "--disable-gpu-sandbox", `--user-data-dir=${join(out, "chromium-profile")}`,
	url,
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
chrome.on("error", (e) => {
	console.error(`cannot run ${browser}: ${e.message}`);
	process.exit(2);
});
const exited = new Promise((r) => chrome.on("exit", () => r(null)));
const body = await Promise.race([result, exited, new Promise((r) => setTimeout(() => r(null), timeout))]);
chrome.kill("SIGKILL");
server.close();
writeFileSync(join(out, "chromium.log"), chromeErr);
await exited;
rmSync(join(out, "chromium-profile"), { recursive: true, force: true });
if (body === null) {
	console.error(`no result from the page within ${timeout / 1000} s (or the browser exited); see ${out}`);
	process.exit(2);
}
writeFileSync(join(out, "result.json"), body);
const res = JSON.parse(body);
if (res.error) {
	console.log(`FAIL the page: ${res.error}`);
	process.exit(1);
}
for (const [name, s] of Object.entries(res.steps)) writeFileSync(join(out, `${name}.txt`), s.stdout + (s.stderr ? `\n--- stderr\n${s.stderr}` : ""));

let fails = 0;
const report = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (!ok) fails++;
};
if (drm) {
	judgeDrm(res);
	console.log(`stats: ${JSON.stringify(res.gl)}; display ${JSON.stringify(res.display)}; ${((Date.now() - t0) / 1000).toFixed(0)} s in the browser; output in ${out}`);
	process.exit(fails ? 1 : 0);
}
console.log(`renderer: ${res.renderer} (gl ready ${res.readyS} s after the page started; ${res.worker ? "worker" : "inline"} mode)`);

const e = res.steps.eglinfo;
if (e) {
	const es = /OpenGL ES profile renderer: (.*)/.exec(e.stdout)?.[1] ?? "?";
	const ver = /OpenGL ES profile version: (.*)/.exec(e.stdout)?.[1] ?? "?";
	report("eglinfo", e.exitCode === 0 && /^virgl \(/.test(es), `GLES renderer "${es}", version "${ver}" (${(e.ms / 1000).toFixed(1)} s)`);
}

function lines(s) {
	return s.stdout.split("\n").filter((l) => /^[a-z.0-9]+ \d+ [0-9a-f]{16}$/.test(l) || /samples-passed/.test(l)).sort();
}
if (res.steps.state) {
	const alone = lines(res.steps["state-alone"]), mixed = lines(res.steps.state);
	const sums = alone.filter((l) => / [0-9a-f]{16}$/.test(l));
	const per = new Map();
	for (const l of sums) {
		const [v, , sum] = l.split(" ");
		if (!per.has(v)) per.set(v, new Set());
		per.get(v).add(sum);
	}
	const flat = [...per].filter(([, s]) => s.size < 2).map(([v]) => v);
	const bad = mixed.filter((l, i) => l !== alone[i]).length + Math.max(0, alone.length - mixed.length);
	const samples = mixed.some((l) => /samples-passed=[^0]/.test(l));
	let detail = `${bad} of ${sums.length} frames differ from the clients alone`;
	let ok = sums.length === 60 && !flat.length && bad === 0 && alone.length === mixed.length && !samples && res.steps.state.exitCode === 0;
	if (flat.length) detail += `; frames that do not change: ${flat.join(" ")}`;
	const refFile = opt("--state-ref");
	if (refFile) {
		const ref = readFileSync(refFile, "utf8").split("\n").filter((l) => / [0-9a-f]{16}$/.test(l)).sort();
		const diff = ref.filter((l, i) => l !== sums[i]).length;
		detail += `; ${diff} of ${ref.length} differ from the host's (${refFile})`;
		ok &&= diff === 0 && ref.length === sums.length;
	}
	const llvm = lines(res.steps["state-llvmpipe"]).filter((l) => / [0-9a-f]{16}$/.test(l));
	const llvmDiff = llvm.filter((l, i) => l !== sums[i]).length;
	detail += `; llvmpipe in the guest: ${llvmDiff} of ${llvm.length} differ (rounding; not judged); ${(res.steps.state.ms / 1000).toFixed(1)} s virgl, ${(res.steps["state-llvmpipe"].ms / 1000).toFixed(1)} s llvmpipe`;
	report("state", ok, detail);
}

/** The --drm steps (drm-page.js). */
function judgeDrm(res) {
	console.log(`renderer: ${res.renderer} (gl ready ${res.readyS} s after the page started)`);
	if (res.steps.cmd) console.log(`--cmd (exit ${res.steps.cmd.exitCode}):\n${res.steps.cmd.stdout}${res.steps.cmd.stderr}`);
	const dd = res.steps.drmdevice;
	if (dd) report("drmdevice", dd.exitCode === 0 && /renderD128/.test(dd.stdout) && /platform/i.test(dd.stdout),
		dd.stdout.split("\n").filter((l) => /bustype|platform|fullname|compatible|available_nodes|nodes\[|\/dev\/dri/i.test(l)).map((l) => l.trim()).slice(0, 12).join("; ") || dd.stdout.slice(0, 300));
	for (const p of ["gbm", "surfaceless"]) {
		const e = res.steps[`eglinfo-${p}`];
		if (!e) continue;
		const r = /OpenGL ES profile renderer: (.*)/.exec(e.stdout)?.[1] ?? "?";
		const v = /OpenGL ES profile version: (.*)/.exec(e.stdout)?.[1] ?? "?";
		report(`eglinfo -p ${p}`, e.exitCode === 0 && /^virgl \(/.test(r), `GLES renderer "${r}", version "${v}" (${(e.ms / 1000).toFixed(1)} s)`);
	}
	const k = res.steps.kmscube;
	if (k) {
		const frames = res.frames ?? [];
		const fpsLine = /Rendered.*|[\d.]+ fps.*/i.exec(k.stdout)?.[0] ?? "";
		const good = frames.filter((f) => f.drew && f.differFromReadback === 0 && f.colours > 16);
		const moving = new Set(frames.map((f) => f.checksum)).size === frames.length;
		report("kmscube", k.exitCode === 0 && frames.length >= 2 && good.length === frames.length && moving,
			`${frames.map((f) => `frame ${f.seq} ${f.size}: canvas checksum ${f.checksum} (${f.colours} colours, centre ${f.center}, corner ${f.corner}), ${f.differFromReadback} pixels differ from the readback`).join("; ") || "no frames on the canvas"}; ` +
			`${fpsLine || k.stdout.trim().split("\n").slice(-2).join(" | ")}; host: ${JSON.stringify(res.kmsStats)} (${(k.ms / 1000).toFixed(1)} s)`);
	}
	for (const suffix of ["", "-offscreen"]) {
		const gd = res.steps[`glmark2-drm${suffix}`], gv = res.steps[`glmark2-vtest${suffix}`];
		if (!gd && !gv) continue;
		const d = fps(gd), v = fps(gv);
		const f = (x) => (x ? `${(1000 / x.ms).toFixed(1)} FPS (${x.ms} ms)` : "?");
		const rows = d.map((x, i) => `${x.scene} ${x.opts}: DRM ${f(x)}, vtest ${f(v[i])}`);
		const renderers = [gd, gv].map((s) => /GL_RENDERER:\s*(.*)/.exec(s?.stdout ?? "")?.[1]?.trim() ?? "?");
		report(`glmark2${suffix ? " off screen" : " on screen"}`, d.length > 0 && d.length === v.length && d.every((x) => x.fps > 0) && renderers.every((r) => /^virgl/.test(r)),
			`${rows.join("; ") || "no FPS lines"} (renderers: ${renderers.join(" | ")})`);
	}
	const pr = res.steps.prime;
	if (pr) {
		const p = res.prime;
		// 40 * 4 red, 8 * 4 green, 0xc0 blue (prime.c's pattern)
		const ok = pr.exitCode === 0 && p?.texture && p.width === 64 && p.height === 64 && p.pixel?.join() === "160,32,192";
		report("prime", ok, `${pr.stdout.trim().split("\n").join("; ")}; host: ${JSON.stringify(p)}`);
	}
	if (res.steps.state) {
		const alone = lines(res.steps["state-alone"]), mixed = lines(res.steps.state), vt = lines(res.steps["state-vtest"]);
		const sums = alone.filter((l) => / [0-9a-f]{16}$/.test(l));
		const bad = mixed.filter((l, i) => l !== alone[i]).length + Math.max(0, alone.length - mixed.length);
		const vbad = vt.filter((l, i) => l !== mixed[i]).length + Math.max(0, mixed.length - vt.length);
		const samples = mixed.some((l) => /samples-passed=[^0]/.test(l));
		report("state", sums.length === 60 && bad === 0 && alone.length === mixed.length && !samples && res.steps.state.exitCode === 0,
			`${bad} of ${sums.length} frames differ from the clients alone; ${vbad} differ from the same clients on the vtest path; ` +
			`${(res.steps.state.ms / 1000).toFixed(1)} s DRM, ${(res.steps["state-vtest"].ms / 1000).toFixed(1)} s vtest`);
	}
}

function fps(s) {
	return [...(s?.stdout ?? "").matchAll(/^\[(\S+)\] (.*?): FPS: (\d+) FrameTime: ([\d.]+) ms/gm)].map((m) => ({ scene: m[1], opts: m[2], fps: Number(m[3]), ms: Number(m[4]) }));
}
const gv = res.steps["glmark2-virgl"], gl = res.steps["glmark2-llvmpipe"];
if (gv || gl) {
	const v = fps(gv), l = fps(gl);
	const ok = v.length > 0 && v.length === l.length && v.every((x) => x.fps > 0) && l.every((x) => x.fps > 0) && /virgl/.test(gv.stdout) && /llvmpipe/.test(gl.stdout);
	// glmark2 rounds FPS to an integer; its mean frame time is exact
	const f = (x) => (x ? `${(1000 / x.ms).toFixed(x.ms > 100 ? 2 : 1)} FPS (${x.ms} ms)` : "?");
	const rows = v.map((x, i) => `${x.scene} ${x.opts}: virgl ${f(x)}, llvmpipe ${f(l[i])}`);
	const renderers = [gv, gl].map((s) => /GL_RENDERER:\s*(.*)/.exec(s?.stdout ?? "")?.[1]?.trim() ?? "?");
	report("glmark2", ok, `${res.size}, ${rows.join("; ") || "no FPS lines"} (renderers: ${renderers.join(" | ")})`);
}
console.log(`stats: ${JSON.stringify(res.gl)}; ${((Date.now() - t0) / 1000).toFixed(0)} s in the browser; output in ${out}`);
process.exit(fails ? 1 : 0);
