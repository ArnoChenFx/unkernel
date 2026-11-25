#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API end to end in headless Chrome (WebCodecs): unkernel, the SDK
// from its sources (js/ served as JavaScript through Node's
// module.stripTypeScriptTypes), boots Debian with the prepared data disk
// (debian-disk.mjs: vainfo, ffmpeg, mpv from apt, made once), `va: true` and
// `gpu: true` (the virtio-gpu device: libva's DRM display, and the name it
// loads the driver by). The page (check-page.js) puts the driver under test
// ($KW_BUILD/va/kw_drv_video.so; --no-push: the base's) and va-decode into
// the guest, and the samples into /tmp/va, then runs, with no VA
// environment variables:
//
//   vainfo     plain, and with --display drm: must list VAProfileVP9Profile0,
//              the H.264 profiles and VAProfileAV1Profile0
//   vadecode   va-decode on libvpx's test vectors (hidden frames and
//              show_existing_frame among them): every frame's MD5 must be
//              the vector's .md5 file's
//   ffmpeg     -hwaccel vaapi (hwdownload to NV12) against software decode,
//              framemd5 of yuv420p on each sample: must be equal; for H.264
//              and AV1 also plain -hwaccel vaapi (the decoder thread reads
//              each frame) on some, which must need no flush but at the
//              end; libaom's AV1 vectors also against their MD5s
//   recover    va-decode and ffmpeg with the host's decoders reclaimed, flushed
//              and failed mid-stream (VaHost.inject): frames still exact; and
//              ffmpeg with pictures made to fail: it goes on
//   modes      H.264 with every context conservative, and with Chromium's
//              decoder made to hold 1 and 2 more pictures than the model
//              says (VaHost.setOptions): frames still exact
//   fps        ffmpeg -hwaccel vaapi -f null and va-decode -q on the 720p and
//              1080p clips, and ffmpeg's software decode of the 720p one
//   mpv        mpv --hwdec=vaapi-copy --vo=null: must say it uses vaapi-copy
//              (VP9, H.264, AV1)
//   encode     ffmpeg's vp9_vaapi (VAEntrypointEncSlice) from testsrc2 (CQP,
//              -global_quality, VBR, CBR, -g 30, 641x361, 1080p), the 720p
//              clip, a decode-to-encode transcode and with encoders
//              reclaimed, failed and flushed: each output decoded in software
//              in the guest, every frame, the key frames asked, the bitrate
//              within half to 1.5 times the target, PSNR against the source;
//              va-encode's vaPutImage path; frame rates (ffmpeg, and
//              va-encode with pixels sent each frame against unchanged
//              surfaces: the upload's cost)
//
// --gl adds guest GL (`gl: true`: virtio-gpu with 3D on the page's WebGL2,
// ANGLE on SwiftShader here, so the driver offers vaExportSurfaceHandle)
// and the zero-copy steps (check-page.js zeroSteps):
//
//   export     va-decode -e on the vectors and 30 frames of the 720p clip
//              (-E on the first: composed layers too): every exported
//              picture imported through EGL on the render node, its planes
//              drawn must equal its readback exactly, its RGB within 1
//              (composed, Mesa converting: within 3)
//   wland      mpv --hwdec=vaapi in a Wayland window on wland/headless (the
//              page's compositor, --dmabuf virtgpu relay): --vo=gpu (GLES)
//              must use vaapi, read nothing back (vm.va.stats.readbacks),
//              upload every frame on the host and present by GPU resource
//              a picture that is a video frame; --vo=dmabuf-wayland the
//              same (through video processing: mpv's scale_vaapi to BGRX,
//              as wland takes RGB dmabufs only), each picture drawn from the
//              VideoFrame on the GPU and a sampled frame within a tolerance
//              of the CPU path's conversion, and once with video processing
//              forced onto the CPU; gpu-next reported (--vos)
//   bgr0       ffmpeg scale_vaapi=format=bgr0 + hwdownload (BGRX read back)
//              against swscale's conversion of the same NV12: PSNR
//   mpvfps     mpv --vo=gpu with --hwdec=vaapi against vaapi-copy, and
//              --vo=dmabuf-wayland (GPU and CPU video processing), VP9 and
//              H.264 at 720p and 1080p
//              (--mpv-frames, default 120): frames/s and the guest's CPU
//              time per frame, judged as above
//
//   node test/va/check.mjs [--worker] [--no-push] [--kernel FILE] [--samples DIR] [--skip a,b] [--cmd SHELL] [--out DIR] [--browser BIN]
//        [--gl [--vos gpu,gpu-next,dmabuf-wayland] [--mpv-frames N] [--gl-flags FLAGS] [--firefox] [--gst]] [--disk FILE] [--cpus N] [--mem MIB]
//
// --cpus N boots the SMP kernel on N CPUs in worker mode (the page served
// cross-origin isolated). --mem MIB: the guest's memory (default 1024).
// --firefox / --gst (with --gl, the apps disk) play clips in firefox-esr and
// GStreamer's glimagesink in the Wayland window (check-page.js).
// --disk FILE boots another prepared disk (made on the same Debian image; a
// name ending in -apps.img is made with debian-disk.mjs --apps when
// missing: firefox-esr and GStreamer).
//
// --samples DIR: where the clips are, downloaded there once (default
// $KW_BUILD/va/samples): libvpx's vp90-2-10-show-existing-frame{,2}.webm
// and vp90-2-08-tile-4x4.webm with their .md5 files, and Big Buck Bunny's
// 10 s VP9 clips at 720p and 1080p (test-videos.co.uk), and arf720, 90
// frames of the 720p one encoded again with alt-ref (hidden) frames by
// Playwright's ffmpeg (--ffmpeg BIN; without it no arf720). H.264: Big Buck
// Bunny's 10 s clips at 720p and 1080p (test-videos.co.uk, x264 High), and
// the clips of H264 below (x264 of the 720p VP9 clip: Baseline, Main, High,
// B-pyramid with 4 references, custom scaling lists, 4 slices, open GOP,
// 1000x562, MBAFF, a resolution change, a profile change, two PPS ids),
// made in the guest by Debian's ffmpeg the first time and kept in --samples
// (h264-twopps by h264-pps.mjs). AV1: the clips of AV1 below (libaom's
// vectors and Big Buck Bunny's AV1 clips downloaded, the rest made in the
// guest the first time and kept). Exit 0 when every step run passed, 1 on a
// failure, 2 when it could not run.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webmToIvf } from "./webm-ivf.mjs";

process.removeAllListeners("warning");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);
const browser = opt("--browser", process.env.CHROME || join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"));
const out = resolve(opt("--out", "") || mkdtempSync("/tmp/kwva."));
mkdirSync(out, { recursive: true });
const distro = join(build, "distro/debian.erofs");
const disk = resolve(opt("--disk", "") || join(build, "va/debian-va.img"));
const driver = join(build, "va/kw_drv_video.so"), decoder = join(build, "va/va-decode"), encoder = join(build, "va/va-encode");
const samples = resolve(opt("--samples", join(build, "va/samples")));
const push = !has("--no-push");

const VECTORS = ["vp90-2-10-show-existing-frame", "vp90-2-10-show-existing-frame2", "vp90-2-08-tile-4x4"];
const CLIPS = { bbb720: "https://test-videos.co.uk/vids/bigbuckbunny/webm/vp9/720/Big_Buck_Bunny_720_10s_1MB.webm", bbb1080: "https://test-videos.co.uk/vids/bigbuckbunny/webm/vp9/1080/Big_Buck_Bunny_1080_10s_1MB.webm" };
mkdirSync(samples, { recursive: true });
const fetchOnce = (url, file) => {
	if (existsSync(file)) return;
	console.log(`== ${url}`);
	if (spawnSync("curl", ["-fsSL", "-o", `${file}.part`, url], { stdio: "inherit" }).status !== 0) {
		console.error(`cannot download ${url}`);
		process.exit(2);
	}
	spawnSync("mv", [`${file}.part`, file]);
};
for (const v of VECTORS) for (const ext of [".webm", ".webm.md5"]) fetchOnce(`https://storage.googleapis.com/downloads.webmproject.org/test_data/libvpx/${v}${ext}`, join(samples, v + ext));
for (const [name, url] of Object.entries(CLIPS)) fetchOnce(url, join(samples, `${name}.webm`));
// arf720: 90 frames of the 720p clip encoded again by libvpx in two passes with alt-ref frames
// (hidden frames in superframes), by Playwright's ffmpeg (libvpx-vp9) where there is one
const ffmpeg = opt("--ffmpeg", join(homedir(), ".cache/ms-playwright/ffmpeg-1013/ffmpeg-linux"));
const arf = join(samples, "arf720.webm");
if (!existsSync(arf) && existsSync(ffmpeg)) {
	const enc = (pass, outFile) => spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", join(samples, "bbb720.webm"), "-frames:v", "90", "-c:v", "libvpx-vp9", "-b:v", "800k",
		"-auto-alt-ref", "1", "-lag-in-frames", "25", "-deadline", "good", "-cpu-used", "4", "-pass", String(pass), "-passlogfile", join(samples, "arf720-pass"), "-f", "webm", outFile], { stdio: "inherit" }).status === 0;
	if (enc(1, "/dev/null") && enc(2, `${arf}.part`)) spawnSync("mv", [`${arf}.part`, arf]);
}
const clips = [...Object.keys(CLIPS), ...(existsSync(arf) ? ["arf720"] : [])];
// H.264: file, how the guest makes it (in /tmp/va, from bbb720.webm), and what runs on it
const X264 = "-c:v libx264 -an", SRC = "-hide_banner -loglevel error -y -i bbb720.webm";
const H264 = [
	{ file: "bbb720-h264.mp4", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4", frames: 60, plain: true, fps: true, mpv: true, recover: true, modes: true },
	{ file: "bbb1080-h264.mp4", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4", frames: 30, fps: true },
	{ file: "h264-base.mp4", make: `ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v baseline h264-base.mp4`, modes: true },
	{ file: "h264-main.mp4", make: `ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v main h264-main.mp4` },
	{ file: "h264-high.mp4", make: `ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v high h264-high.mp4` },
	{ file: "h264-bf3.mp4", make: `ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v high -bf 3 -refs 4 -x264-params b-pyramid=normal h264-bf3.mp4`, plain: true, modes: true, hold2: true },
	{ file: "h264-cqm.mp4", make: `printf '%s\n' ${["INTRA4X4_LUMA =", "6,12,19,26,14,21,27,33,22,28,33,39,29,34,40,44", "INTER4X4_LUMA =", "10,14,20,24,15,20,24,28,21,25,28,31,26,28,31,34", "INTRA8X8_LUMA =",
		"6,10,13,16,18,23,25,27,11,11,16,18,23,25,27,29,14,16,16,18,23,25,27,29,17,19,20,23,25,27,29,31,19,20,22,25,27,29,31,33,24,24,26,27,29,31,33,36,26,26,27,29,31,33,36,38,28,28,29,31,33,36,38,40",
		"INTER8X8_LUMA =", "9,13,15,17,19,21,22,24,14,14,17,19,21,22,24,25,16,17,17,19,21,22,24,25,18,19,20,21,22,24,25,27,20,21,21,22,24,25,27,28,22,22,23,24,25,27,28,30,23,23,24,25,27,28,30,32,25,25,26,27,28,30,32,33"].map((l) => `'${l}'`).join(" ")} >cqm.txt; ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v high -x264-params cqmfile=cqm.txt h264-cqm.mp4` },
	{ file: "h264-slices.mp4", make: `ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v high -slices 4 h264-slices.mp4` },
	{ file: "h264-opengop.mp4", make: `ffmpeg ${SRC} -frames:v 90 ${X264} -profile:v high -x264-params open-gop=1:keyint=30:min-keyint=30:scenecut=0 h264-opengop.mp4`, plain: true, modes: true },
	{ file: "h264-crop.mp4", make: `ffmpeg ${SRC} -frames:v 60 -vf scale=1000:562 ${X264} -profile:v high h264-crop.mp4` },
	{ file: "h264-mbaff.mp4", make: `ffmpeg ${SRC} -frames:v 60 ${X264} -profile:v high -flags +ildct+ilme -x264-params interlaced=1:tff=1 h264-mbaff.mp4`, modes: true },
	{ file: "h264-res.h264", make: `ffmpeg ${SRC} -frames:v 30 ${X264} -profile:v high -f h264 r1.h264; ffmpeg -hide_banner -loglevel error -y -ss 3 -i bbb720.webm -frames:v 30 -vf scale=854:480 ${X264} -profile:v high -f h264 r2.h264; cat r1.h264 r2.h264 >h264-res.h264`, plain: true },
	{ file: "h264-prof.h264", make: `ffmpeg ${SRC} -frames:v 30 ${X264} -profile:v main -f h264 p1.h264; ffmpeg -hide_banner -loglevel error -y -ss 3 -i bbb720.webm -frames:v 30 ${X264} -profile:v high -f h264 p2.h264; cat p1.h264 p2.h264 >h264-prof.h264` },
	{ file: "h264-twopps.h264", make: "twopps", plain: true },
];
// AV1: libaom's test vectors with their per-frame MD5s (film grain among them), Big Buck Bunny's AV1 clips
// (test-videos.co.uk), and clips of the 720p VP9 clip made in the guest by Debian's ffmpeg (libaom with hidden
// alt-refs and show_existing_frame, SVT-AV1, film grain, superres, uniform and non-uniform tiles, 638x358)
const AOM = "-c:v libaom-av1 -cpu-used 8 -row-mt 1 -b:v 800k -an", SVT = "-c:v libsvtav1 -preset 10 -crf 35 -an";
const AV1 = [
	...["av1-1-b8-23-film_grain-50", "av1-1-b8-22-svc-L1T2", "av1-1-b8-06-mfmv"].map((v) => ({ file: `${v}.ivf`, url: `https://storage.googleapis.com/aom-test-data/${v}.ivf`, md5: `https://storage.googleapis.com/aom-test-data/${v}.ivf.md5` })),
	{ file: "bbb720-av1.mp4", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/av1/720/Big_Buck_Bunny_720_10s_1MB.mp4", frames: 60, plain: true, fps: true, mpv: true, recover: true },
	{ file: "bbb1080-av1.mp4", url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/av1/1080/Big_Buck_Bunny_1080_10s_1MB.mp4", frames: 30, fps: true },
	{ file: "av1-aom.mkv", make: `ffmpeg ${SRC} -frames:v 60 ${AOM} -g 30 av1-aom.mkv`, plain: true, recover: true },
	{ file: "av1-svt.mkv", make: `ffmpeg ${SRC} -frames:v 60 ${SVT} -g 30 av1-svt.mkv` },
	{ file: "av1-grain.mkv", make: `ffmpeg ${SRC} -frames:v 60 ${SVT} -svtav1-params film-grain=12 av1-grain.mkv`, plain: true },
	{ file: "av1-superres.mkv", make: `ffmpeg ${SRC} -frames:v 30 ${SVT} -svtav1-params superres-mode=1:superres-denom=12:superres-kf-denom=11 av1-superres.mkv` },
	{ file: "av1-tiles.mkv", make: `ffmpeg ${SRC} -frames:v 30 ${AOM} -tile-columns 2 -tile-rows 1 av1-tiles.mkv` },
	{ file: "av1-tiles2.mkv", make: `ffmpeg ${SRC} -frames:v 30 ${AOM} -tiles 3x3 av1-tiles2.mkv` },
	{ file: "av1-odd.mkv", make: `ffmpeg ${SRC} -frames:v 30 -vf scale=638:358 ${AOM} av1-odd.mkv` },
];
for (const c of H264) if (c.url) fetchOnce(c.url, join(samples, c.file));
for (const c of AV1) {
	if (c.url) fetchOnce(c.url, join(samples, c.file));
	if (c.md5) fetchOnce(c.md5, join(samples, `${c.file}.md5`));
}
for (const name of [...VECTORS, ...clips]) {
	const ivf = join(samples, `${name}.ivf`);
	if (!existsSync(ivf)) writeFileSync(ivf, webmToIvf(readFileSync(join(samples, `${name}.webm`))).ivf);
}
if (!existsSync(distro)) {
	console.error(`no ${distro} (kernel/build.sh distro debian)`);
	process.exit(2);
}
for (const f of [driver, decoder, encoder]) if (!existsSync(f)) {
	console.error(`no ${f} (va/build.sh)`);
	process.exit(2);
}
if (spawnSync(process.execPath, [join(here, "debian-disk.mjs"), "--out", disk, ...(/-apps\.img$/.test(disk) ? ["--apps"] : [])], { stdio: "inherit" }).status !== 0) process.exit(2);

const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
let resolveResult;
const result = new Promise((r) => (resolveResult = r));
const pageLog = join(out, "page.log"), consoleLog = join(out, "console.log");
writeFileSync(pageLog, "");
writeFileSync(consoleLog, "");
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
		status = 206;
		h["content-range"] = `bytes ${start}-${end}/${st.size}`;
	}
	h["content-length"] = String(end - start + 1);
	res.writeHead(status, h);
	if (req.method === "HEAD") res.end();
	else createReadStream(file, { start, end }).pipe(res);
}
const server = createServer(async (req, res) => {
	if (opt("--cpus")) {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	}
	const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
	if (req.method === "POST") {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		res.end("ok");
		if (p.startsWith("/save/") && /^[\w.-]+$/.test(p.slice(6))) {
			writeFileSync(join(samples, p.slice(6)), body);
			console.log(`kept ${p.slice(6)} (${body.length} bytes, made in the guest)`);
		} else if (p === "/log") {
			appendFileSync(pageLog, body + "\n");
			console.log(`page: ${body}`);
		} else if (p === "/console") appendFileSync(consoleLog, body);
		else if (p === "/result") resolveResult(body.toString());
		return;
	}
	if (p === "/") {
		res.writeHead(200, { "content-type": "text/html" });
		return res.end(`<!doctype html><meta charset="utf-8"><title>kwva check</title><pre id="log"></pre><script type="module" src="/test/va/check-page.js"></script>`);
	}
	if (p === "/img/debian.erofs") return sendFile(req, res, distro, "application/octet-stream");
	if (p === "/img/debian-va.img") return sendFile(req, res, disk, "application/octet-stream");
	if (p === "/img/unkernel.wasm" && opt("--kernel")) return sendFile(req, res, resolve(opt("--kernel")), "application/wasm");
	if (p === "/files/kw_drv_video.so") return sendFile(req, res, driver, "application/octet-stream");
	if (p === "/files/va-decode") return sendFile(req, res, decoder, "application/octet-stream");
	if (p === "/files/va-encode") return sendFile(req, res, encoder, "application/octet-stream");
	if (p.startsWith("/samples/") && /^[\w.-]+$/.test(p.slice(9)) && existsSync(join(samples, p.slice(9)))) return sendFile(req, res, join(samples, p.slice(9)), "application/octet-stream");
	if (p === "/test/va/check-page.js") return sendFile(req, res, join(here, "check-page.js"), "text/javascript");
	if (p === "/test/va/h264-pps.mjs") return sendFile(req, res, join(here, "h264-pps.mjs"), "text/javascript");
	// --gl: the renderer next to the SDK's web entry (bundledGlUrl), and wland/headless
	if ((p === "/js/virgl.mjs" || p === "/js/virgl.wasm") && existsSync(join(build, "gl-wasm", p.slice(4)))) return sendFile(req, res, join(build, "gl-wasm", p.slice(4)), p.endsWith(".mjs") ? "text/javascript" : "application/wasm");
	if (p.startsWith("/wland/") && /^[\w.-]+$/.test(p.slice(7)) && existsSync(join(root, "web/node_modules/wland/dist", p.slice(7)))) return sendFile(req, res, join(root, "web/node_modules/wland/dist", p.slice(7)), types[p.slice(p.lastIndexOf("."))] || "application/octet-stream");
	if (p === "/h264.json" || p === "/av1.json") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify((p === "/h264.json" ? H264 : AV1).map((c) => ({ ...c, have: existsSync(join(samples, c.file)) }))));
	}
	if (p.startsWith("/js/")) {
		const rel = normalize(p.slice(1));
		const file = join(root, rel);
		if (rel.startsWith("js/") && existsSync(file)) {
			if (rel.endsWith(".ts")) {
				res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
				return res.end(stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip", sourceUrl: rel }));
			}
			return sendFile(req, res, file, types[rel.slice(rel.lastIndexOf("."))] || "application/octet-stream");
		}
	}
	res.writeHead(404);
	res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const query = new URLSearchParams();
if (has("--worker")) query.set("worker", "1");
if (!push) query.set("push", "0");
if (opt("--skip")) query.set("skip", opt("--skip"));
if (opt("--cmd")) query.set("cmd", opt("--cmd"));
if (opt("--kernel")) query.set("kernel", "/img/unkernel.wasm");
if (opt("--mem")) query.set("mem", opt("--mem"));
// --cpus N: the SMP kernel in worker mode, which needs a cross-origin isolated page (the headers below)
const cpus = opt("--cpus");
if (cpus) query.set("cpus", cpus);
const gl = has("--gl");
if (gl) {
	if (!existsSync(join(build, "gl-wasm/virgl.mjs"))) {
		console.error(`no ${join(build, "gl-wasm/virgl.mjs")} (gl/wasm/build.sh)`);
		process.exit(2);
	}
	query.set("gl", "1");
	if (opt("--vos")) query.set("vos", opt("--vos"));
	if (opt("--mpv-frames")) query.set("mpvframes", opt("--mpv-frames"));
	if (has("--firefox")) query.set("firefox", "1");
	if (has("--gst")) query.set("gst", "1");
	if (opt("--ffclips")) query.set("ffclips", opt("--ffclips"));
	if (opt("--ffsecs")) query.set("ffsecs", opt("--ffsecs"));
	if (opt("--fps-paths")) query.set("fpspaths", opt("--fps-paths"));
	if (opt("--mpv-env")) query.set("mpvenv", opt("--mpv-env"));
	if (opt("--mpv-grep")) query.set("mpvgrep", opt("--mpv-grep"));
	if (opt("--gst-env")) query.set("gstenv", opt("--gst-env"));
	if (opt("--gst-grep")) query.set("gstgrep", opt("--gst-grep"));
}
query.set("vectors", VECTORS.join(","));
query.set("clips", clips.join(","));
const pageUrl = `http://127.0.0.1:${server.address().port}/?${query}`;
console.log(`== ${pageUrl}\n   output in ${out}`);
const t0 = Date.now();
// --gl: WebGL2 on ANGLE/SwiftShader (gl.md, Testing); --gl-flags replaces these
const glFlags = gl ? opt("--gl-flags", "--use-angle=swiftshader --enable-unsafe-swiftshader").split(" ").filter(Boolean) : [];
const chrome = spawn(browser, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", ...glFlags, `--user-data-dir=${join(out, "chromium-profile")}`, pageUrl], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
const exited = new Promise((r) => chrome.on("exit", () => r(null)));
const body = await Promise.race([result, exited, new Promise((r) => setTimeout(() => r(null), 3600_000))]);
chrome.kill("SIGKILL");
server.close();
writeFileSync(join(out, "chromium.log"), chromeErr);
await exited;
rmSync(join(out, "chromium-profile"), { recursive: true, force: true });
if (body === null) {
	console.error(`no result from the page (or the browser exited); see ${out}`);
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
	console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (ok === false) fails++;
};
console.log(`${res.worker ? "worker" : "inline"} mode; va status at boot ${res.statusAtBoot?.state}`);
report("lazy", res.statusAtBoot?.state === "idle", `status at boot ${res.statusAtBoot?.state} (idle: nothing asked of WebCodecs before the guest's first connection)`);
for (const name of ["vainfo", "vainfo-drm"]) {
	const s = res.steps[name];
	const want = ["VP9Profile0", "H264ConstrainedBaseline", "H264Main", "H264High", "AV1Profile0"];
	// and VP9 encode (VideoEncoder takes VP9 here)
	if (s) report(name, want.every((p) => new RegExp(`VAProfile${p}\\s*:\\s*VAEntrypointVLD`).test(s.stdout)) && /VAProfileVP9Profile0\s*:\s*VAEntrypointEncSlice/.test(s.stdout), `exit ${s.exitCode}; ${want.filter((p) => new RegExp(`VAProfile${p}\\s*:`).test(s.stdout)).length} of ${want.length} profiles; ${(/Driver version: (.*)/.exec(s.stdout)?.[1] ?? s.stdout.trim().split("\n").slice(-3).join(" | "))}`);
}
const md5s = (text) => text.split("\n").map((l) => /^([0-9a-f]{32})\s/.exec(l)?.[1]).filter(Boolean);
for (const v of VECTORS) {
	const s = res.steps[`vadecode-${v}`];
	if (!s) continue;
	const want = md5s(readFileSync(join(samples, `${v}.webm.md5`), "utf8")), got = md5s(s.stdout);
	const same = got.length === want.length && got.every((m, i) => m === want[i]);
	report(`va-decode ${v}`, s.exitCode === 0 && same, `${got.length} frames, ${got.filter((m, i) => m === want[i]).length} of ${want.length} MD5s equal to libvpx's; ${s.stdout.trim().split("\n").pop()}`);
}
const frameMd5s = (text) => text.split("\n").filter((l) => /^\d/.test(l)).map((l) => l.split(",").pop().trim());
const vaNote = (s) => (s.va ? `; ${s.va.pictures} pictures, ${s.va.holdFires ?? "?"} stalls, ${s.va.fillers ?? 0} fillers, ${s.va.flushes} flushes, ${s.va.restarts} restarts, ${s.va.replays} replays${s.va.dropped ? `, ${s.va.dropped} dropped` : ""}${s.va.modes?.length ? `; ${[...new Set(s.va.modes)].join(", ")}` : ""}` : "");
for (const [step, hw] of Object.entries(res.steps).filter(([n]) => /^ffmpeg-(hw|plain)-/.test(n))) {
	const [, mode, name] = /^ffmpeg-(hw|plain)-(.*)$/.exec(step);
	const sw = res.steps[`ffmpeg-sw-${name}`];
	if (!sw) continue;
	const a = frameMd5s(hw.stdout), b = frameMd5s(sw.stdout);
	const eq = a.filter((m, i) => m === b[i]).length;
	// plain mode syncs each frame right after ffmpeg's own reorder delay: a hold-timer flush there is a stall,
	// allowed only at the stream's end (one per VA context)
	const stalls = mode === "plain" && hw.va ? hw.va.flushes > (/-res\./.test(name) ? 2 : 1) : false;
	report(`ffmpeg vaapi${mode === "plain" ? " (plain)" : ""} = software, ${name}`, hw.exitCode === 0 && a.length > 0 && a.length === b.length && eq === a.length && !stalls, `${a.length} frames by VA-API, ${b.length} in software, ${eq} equal${vaNote(hw)}; ${hw.stderr.trim().split("\n").slice(-2).join(" | ")}`);
}
// conservative mode and over-holding decoders (job of VaHost.setOptions): exact frames whatever the stalls
for (const [step, hw] of Object.entries(res.steps).filter(([n]) => /^mode-/.test(n))) {
	const [, what, mode, name] = /^mode-(cons|hold1|hold2)-(plain|hw)-(.*)$/.exec(step);
	const sw = res.steps[`ffmpeg-sw-${name}`];
	if (!sw) continue;
	const a = frameMd5s(hw.stdout), b = frameMd5s(sw.stdout);
	const eq = a.filter((m, i) => m === b[i]).length;
	const label = { cons: "conservative from the start", hold1: "decoder holding 1 more", hold2: "decoder holding 2 more" }[what];
	report(`ffmpeg vaapi (${mode === "plain" ? "plain" : "decode-ahead"}, ${label}) = software, ${name}`, hw.exitCode === 0 && a.length > 0 && a.length === b.length && eq === a.length, `${a.length} frames, ${eq} equal; ${(hw.ms / 1000).toFixed(1)} s${vaNote(hw)}`);
}
// AV1: libaom's per-frame MD5s of its vectors (with film grain applied: the reference decoder's output)
for (const c of AV1.filter((c) => c.md5)) {
	const s = res.steps[`ffmpeg-hw-${c.file}`];
	if (!s) continue;
	const want = md5s(readFileSync(join(samples, `${c.file}.md5`), "utf8")), got = frameMd5s(s.stdout);
	report(`ffmpeg vaapi = libaom's MD5s, ${c.file}`, s.exitCode === 0 && got.length === want.length && got.every((m, i) => m === want[i]), `${got.length} frames, ${got.filter((m, i) => m === want[i]).length} of ${want.length} MD5s equal to libaom's`);
}
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("recover-vadecode-"))) {
	const v = name.slice("recover-vadecode-".length);
	const want = md5s(readFileSync(join(samples, `${v}.webm.md5`), "utf8")), got = md5s(s.stdout);
	const same = got.length === want.length && got.every((m, i) => m === want[i]);
	report(`recovery, va-decode ${v}`, s.exitCode === 0 && same, `decoders reclaimed, flushed and failed mid-stream: ${got.filter((m, i) => m === want[i]).length} of ${want.length} MD5s equal to libvpx's`);
}
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("recover-ffmpeg-"))) {
	const n = name.slice("recover-ffmpeg-".length);
	const a = frameMd5s(s.stdout), b = frameMd5s(res.steps[`recover-sw-${n.replace(/^plain-/, "")}`]?.stdout ?? "");
	const eq = a.filter((m, i) => m === b[i]).length;
	report(`recovery, ffmpeg ${n}`, s.exitCode === 0 && a.length > 0 && a.length === b.length && eq === a.length, `decoders reclaimed, flushed and failed mid-stream: ${a.length} frames by VA-API, ${b.length} in software, ${eq} equal`);
}
const ff = res.steps["fail-ffmpeg-bbb720"], ffsw = res.steps["ffmpeg-sw-bbb720"];
if (ff && ffsw) {
	const a = frameMd5s(ff.stdout), b = frameMd5s(ffsw.stdout);
	const eq = a.filter((m, i) => m === b[i]).length;
	// every 20th picture fails on the host: ffmpeg goes on, those frames read back as the last good one
	report("failed pictures, ffmpeg bbb720", ff.exitCode === 0 && a.length === b.length && eq >= a.length - 3 && eq < a.length, `${a.length} frames, ${b.length} in software, ${eq} equal (every 20th picture made to fail); ${ff.stderr.trim().split("\n").slice(-2).join(" | ")}`);
}
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("fps-"))) {
	const fps = /([\d.]+) frames\/s/.exec(s.stdout)?.[1] ?? /fps=\s*([\d.]+)/.exec(s.stdout.split("\r").join("\n").split("\n").filter((l) => /fps=/.test(l)).pop() ?? "")?.[1];
	const wall = /wall ([\d.]+)/.exec(s.stdout)?.[1];
	report(name, s.exitCode === 0, `${fps ?? "?"} frames/s${wall ? `; ${wall} s wall` : ""}${vaNote(s)}; ${s.stdout.trim().split("\n").filter((l) => /bench|frames shown|wall|frame=|va-encode/.test(l)).slice(-3).join(" | ")}`);
}
for (const [name, m] of Object.entries(res.steps).filter(([n]) => n === "mpv" || n.startsWith("mpv-")))
	report(`mpv vaapi-copy${name === "mpv" ? "" : `, ${name.slice(4)}`}`, m.exitCode === 0 && /Using hardware decoding \(vaapi-copy\)/.test(m.stdout), m.stdout.trim().split("\n").filter((l) => /hwdec|vaapi|VO|Exiting/i.test(l)).slice(0, 6).join(" | "));
// --gl: zero-copy output
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("export-"))) {
	const sum = /export check: (\d+) frames, planes exact on (\d+), RGB within 1 on (\d+) \(largest difference (\d+)\)(?:, composed RGB within 3 on (\d+) of (\d+) \(largest (\d+)\))?; ([\d.]+) ms/.exec(s.stdout);
	const ok = s.exitCode === 0 && !!sum && sum[1] === sum[2] && sum[1] === sum[3] && Number(sum[1]) > 0 && (!sum[6] || sum[5] === sum[6]) && s.va.readbacks > 0 && s.va.uploads > 0;
	report(`export, ${name.slice(7)}`, ok, `${sum ? `${sum[1]} frames: planes exact ${sum[2]}, RGB within 1 ${sum[3]} (largest ${sum[4]})${sum[6] ? `, composed within 3 ${sum[5]} of ${sum[6]} (largest ${sum[7]})` : ""}, ${sum[8]} ms a frame` : "no summary"}; host: ${s.va.exports} exports, ${s.va.uploads} uploads (${(s.va.uploadMs / Math.max(1, s.va.uploads)).toFixed(2)} ms each), ${s.va.uploadFailed} failed; ${s.stdout.trim().split("\n").filter((l) => /export check: EGL|rror|differs|status/.test(l)).slice(0, 3).join(" | ")}`);
}
if (res.zero?.error) report("zero-copy steps", false, res.zero.error);
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("wl-"))) {
	const [, vo, hw0] = /^wl-(gpu-next|gpu|dmabuf-wayland)-(vaapi-copy|vaapi-cpu|vaapi)-/.exec(name) ?? [];
	// vaapi-cpu: --hwdec=vaapi with video processing forced onto the CPU (VaOptions.upload "cpu"); a name ending in -cpu likewise
	const onCpu = hw0 === "vaapi-cpu" || /-cpu$/.test(name), hw = hw0 === "vaapi-cpu" ? "vaapi" : hw0;
	const hwUsed = new RegExp(`Using hardware decoding \\(${hw}\\)`).test(s.stdout);
	const f = s.wl?.frame, t = s.time, n = t?.frames ?? 0;
	const fps = t ? (n / t.wall).toFixed(1) : "?", cpu = t ? (((t.user + t.sys) * 1000) / n).toFixed(1) : "?";
	// zero-copy: nothing read back and every frame uploaded on the host (dmabuf-wayland: drawn on the GPU from the
	// VideoFrame, all but the frames before mpv exported its BGRX surfaces, or converted on the CPU where forced);
	// the copy path: every frame read back
	const gpuPath = vo === "dmabuf-wayland" && hw === "vaapi" ? (onCpu ? s.va.cpuConversions >= n * 0.9 && s.va.gpuUploads === 0 : s.va.gpuUploads >= n * 0.9) : true;
	const path = hw === "vaapi" ? s.va.readbacks === 0 && s.va.uploads + s.va.gpuUploads >= n * 0.9 && gpuPath : s.va.readbacks >= n * 0.9;
	// the sampled frame (what the compositor shows) against the CPU path's conversion of that picture: BT.601/709
	// by the browser (libyuv on this host's software frames; a GPU shader for hardware ones) is not bit-defined
	// against the host's 16.16 fixed point: mean difference at most 2 a channel, 99% within 8
	// (a step named -verify must have sampled one)
	const d = s.wl.diff, close = d ? !d.error && d.mean <= 2 && d.p99 <= 8 : !/-verify$/.test(name);
	const ok = s.exitCode === 0 && hwUsed && path && s.wl.gpuCommits >= n * 0.5 && !!f && f.colours > 500 && close;
	const gpuNote = vo === "dmabuf-wayland" ? `; video processing: ${s.va.gpuUploads} on the GPU (${(s.va.gpuUploadMs / Math.max(1, s.va.gpuUploads)).toFixed(2)} ms each), ${s.va.cpuConversions} on the CPU (${(s.va.cpuConversionMs / Math.max(1, s.va.cpuConversions)).toFixed(2)} ms each, convert + upload), ${s.va.copies} copies to NV12 (${(s.va.copyMs / Math.max(1, s.va.copies)).toFixed(2)} ms each)${Object.keys(s.va.gpuFallbacks ?? {}).length ? `, CPU because ${JSON.stringify(s.va.gpuFallbacks)}` : ""}, frames held at most ${s.va.framesHeldPeak} (${s.va.framesHeld} now, ${s.va.framesEvicted} over the cap), frames' colour space ${s.va.colorSpace}${d ? `; sampled frame against the CPU path's: ${d.error ?? `max ${d.max}, mean ${d.mean}, 99% within ${d.p99}`}` : ""}` : "";
	// --vo=gpu and dmabuf-wayland (through video processing to BGRX) are judged; gpu-next is reported
	report(`mpv --vo=${vo} --hwdec=${hw}${onCpu ? " (video processing on the CPU)" : ""}, ${name.replace(/^wl-(gpu-next|gpu|dmabuf-wayland)-(vaapi-copy|vaapi-cpu|vaapi)-/, "")}`, vo === "gpu-next" ? ok || null : ok,
		`exit ${s.exitCode}; ${hwUsed ? `uses ${hw}` : "no hwdec"}; ${fps} frames/s, guest CPU ${cpu} ms a frame (wall ${t?.wall ?? "?"} s, user ${t?.user ?? "?"}, sys ${t?.sys ?? "?"}); host: ${s.va.readbacks} readbacks (${((s.va.bytesRead ?? 0) / 1048576).toFixed(0)} MiB), ${s.va.exports} exports, ${s.va.uploads} uploads (${(s.va.uploadMs / Math.max(1, s.va.uploads)).toFixed(2)} ms each)${gpuNote}; wland: ${s.wl.gpuCommits} commits by GPU resource, ${s.wl.shmCommits} other, resolve ${s.wl.resolveMs?.toFixed(2) ?? "?"} ms each, frame ${f ? `${f.width}x${f.height} ${f.colours} colours, luma ${f.luma}` : "none"}; ${s.stdout.trim().split("\n").filter((l) => /VO: \[|interop|not supported|rror|ailed/.test(l) && !/List of enabled|hook command/.test(l)).slice(0, 4).join(" | ")}`);
}
// ffmpeg scale_vaapi=format=bgr0 + hwdownload (BGRX read back, converted on the host's CPU) against swscale's
// conversion of the same NV12 with the matrix and ranges ffmpeg asked for: about 40 dB here, what is left being
// chroma upsampling (swscale interpolates, the host takes the nearest sample) and rounding; at least 38 dB
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("bgr0-"))) {
	const psnr = /average:([\d.]+|inf)/.exec(s.stdout)?.[1];
	report(`ffmpeg scale_vaapi bgr0 read back, ${name.slice(5)}`, s.exitCode === 0 && !!psnr && (psnr === "inf" || Number(psnr) >= 38) && s.va.readbacks >= 10,
		`exit ${s.exitCode}; ${s.va.readbacks} readbacks; ${s.stdout.trim().split("\n").filter((l) => /stream|PSNR/.test(l)).join(" | ")}; ${s.stderr.trim().split("\n").slice(-2).join(" | ")}`);
}
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("gst-"))) {
	const dmabuf = /memory:DMABuf/.test(s.stdout);
	report(`GStreamer ${name.slice(4)} into glimagesink`, s.exitCode === 0 && dmabuf && s.va.readbacks === 0 && s.va.uploads > 0 && s.wl.gpuCommits > 30,
		`exit ${s.exitCode}; decoder output ${dmabuf ? "memory:DMABuf" : /video\/x-raw, format=\(string\)NV12/.test(s.stdout) ? "system memory" : "?"}; host: ${s.va.pictures} pictures, ${s.va.readbacks} readbacks, ${s.va.exports} exports, ${s.va.uploads} uploads; wland: ${s.wl.gpuCommits} commits by GPU resource; ${s.stdout.trim().split("\n").filter((l) => /rror|EOS|ended/.test(l)).slice(0, 2).join(" | ")}`);
}
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("firefox-"))) {
	const f = s.ff;
	report(`Firefox VA-API, ${name.slice(8)}`, !!f && f.pictures >= 30 && f.exports > 0 && f.readbacks === 0 && f.gpuCommits > 0,
		f ? `page title "${f.title ?? ""}"; host: ${f.pictures} pictures decoded for it, ${f.exports} exports, ${f.uploads} uploads, ${f.readbacks} readbacks in ${f.seconds} s; wland: ${f.gpuCommits} commits by GPU resource, ${f.shmCommits} other; log: ${s.stdout.trim().split("\n").slice(0, 6).join(" | ")}` : "did not run");
}
// encode (VP9, vp9_vaapi; check-page.js encodeSteps): each output decoded in software in the guest (/tmp/enc/check.sh):
// every frame, the key frames asked, the bitrate within half to one and a half times the target, PSNR against the
// source through NV12; and the host's view of where the pixels came from (va.enc)
const ENC = {
	cqp: { n: 120, keys: "0", psnr: 40 },
	"cqp-q60": { n: 60, keys: "0", psnr: 40 },
	"vbr-2M": { n: 120, keys: "0", kbps: 2000, psnr: 30 },
	"cbr-2M": { n: 120, keys: "0", kbps: 2000, psnr: 30 },
	gop30: { n: 120, keys: "0 30 60 90", kbps: 2000, psnr: 30 },
	"odd-641x361": { n: 60, keys: "0", kbps: 1000, psnr: 30 },
	"1080p": { n: 60, keys: "0", kbps: 4000, psnr: 30 },
	"bbb720-1M": { n: 120, keys: "0 60", kbps: 1000, psnr: 30 },
	transcode: { n: 120, keys: "0", kbps: 2000, psnr: 30, decoded: true },
	recover: { n: 120, kbps: 2000, psnr: 30, recover: true },
};
for (const [step, s] of Object.entries(res.steps).filter(([n]) => /^enc-/.test(n))) {
	const name = step.slice(4), want = ENC[name];
	if (!want) continue;
	const m = /enc check: packets (\d+) decoded (\d+) keys \[([\d ]*)\] kbps (\d+) psnr ([\d.]+|inf)/.exec(s.stdout);
	const e = s.va.enc ?? {};
	const [pk, dec, keys, kbps, psnr] = m ? [Number(m[1]), Number(m[2]), m[3].trim(), Number(m[4]), m[5] === "inf" ? Infinity : Number(m[5])] : [];
	const ok = s.exitCode === 0 && !!m && pk === want.n && dec === want.n && (want.recover || keys === want.keys) && (!want.kbps || (kbps >= want.kbps * 0.5 && kbps <= want.kbps * 1.5)) && psnr >= want.psnr &&
		e.pictures === want.n && e.chunks === want.n && !e.failed && (!want.decoded || (e.decoded === want.n && e.uploads === 0)) && (!want.recover || e.recoveries > 0);
	report(`encode ${name}`, ok, `exit ${s.exitCode}; ${m ? `${pk} packets, ${dec} decoded in software, key frames [${keys}], ${kbps} kbit/s${want.kbps ? ` (target ${want.kbps})` : ""}, PSNR ${psnr} dB` : "no check line"}; host: ${e.pictures} pictures, ${e.chunks} chunks, ${e.keyFrames} key, pixels: ${e.uploads} sent (${((e.uploadBytes ?? 0) / 1048576).toFixed(0)} MiB), ${e.kept} kept, ${e.decoded} decoded pictures; ${e.recoveries} recoveries (${e.reclaims} reclaimed, ${e.errors} errors, ${e.flushes} flushes), ${e.failed} failed; ${(s.ms / 1000).toFixed(1)} s; ${s.stderr.trim().split("\n").slice(-2).join(" | ")}`);
}
{
	const s = res.steps["enc-va-encode-put"];
	if (s) report("encode va-encode vaPutImage 641x361", s.exitCode === 0 && /va-encode: 30 frames/.test(s.stdout) && s.stdout.trim().split("\n").pop() === "30", s.stdout.trim().split("\n").join(" | "));
}
if (res.steps.cmd) console.log(`--cmd (exit ${res.steps.cmd.exitCode}):\n${res.steps.cmd.stdout}${res.steps.cmd.stderr}`);
if (res.gl) console.log(`gl ${JSON.stringify(res.gl.status)}; gpu ${JSON.stringify(res.gl.gpu)}`);
console.log(`va status ${JSON.stringify(res.status)}; stats ${JSON.stringify(res.stats)}; ${((Date.now() - t0) / 1000).toFixed(0)} s in the browser; output in ${out}`);
process.exit(fails ? 1 : 0);
