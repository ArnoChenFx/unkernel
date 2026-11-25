// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page of check.mjs: boots unkernel (the SDK from its sources) with the
// Debian image, the prepared data disk (read over HTTP, writes in memory),
// `va: true` and `gpu: true`, puts the driver under test, va-decode and the
// samples into the guest, runs the steps through vm.exec() and posts what
// they printed; the harness judges. Query: worker=1, push=0 (the base's
// driver), skip=STEP,... (vainfo, vadecode, ffmpeg, recover, fps, mpv, h264, modes, av1, encode; with gl also export, wland, bgr0, mpvfps), cmd=SHELL, kernel=URL, vectors=NAME,..., clips=NAME,...
// gl=1: guest GL too (`gl: true`: virtio-gpu with 3D, so the driver offers
// vaExportSurfaceHandle) and the zero-copy steps (zeroSteps below);
// vos=VO,... and mpvframes=N for its mpv runs; firefox=1 (the apps disk)
// plays a clip in firefox-esr there too, gst=1 GStreamer's glimagesink;
// mem=MIB the guest's memory, cpus=N the SMP kernel in worker mode; mpvenv=VARS, mpvgrep=REGEX, gstenv=VARS, gstgrep=REGEX (debugging); fpspaths=VO:HWDEC,... limits mpvfps.
// The H.264 clips come from the harness's /h264.json: on the host, or made in
// the guest (Debian's ffmpeg has libx264) and posted back to be kept.
const q = new URLSearchParams(location.search);
const { createKernel } = await import("/js/web.ts");
const skip = new Set((q.get("skip") || "").split(",").filter(Boolean));
const vectors = (q.get("vectors") || "").split(",").filter(Boolean);
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
const post = (path, body) => fetch(path, { method: "POST", body }).catch(() => {});
function log(s) {
	const line = `[${secs()}] ${s}`;
	document.getElementById("log").append(line + "\n");
	post("/log", line);
}
let consoleBuf = "";
setInterval(() => {
	if (consoleBuf) post("/console", consoleBuf), (consoleBuf = "");
}, 500);
addEventListener("unhandledrejection", (e) => log(`error: ${e.reason?.stack || e.reason}`));

const DRI = "/usr/lib/aarch64-linux-gnu/dri";

async function main() {
	const result = { worker: q.has("worker"), steps: {} };
	const vm = await createKernel({
		distro: "/img/debian.erofs",
		disks: [{ kind: "http", url: "/img/debian-va.img" }],
		...(q.get("kernel") ? { kernel: q.get("kernel") } : {}),
		va: true,
		gpu: true,
		...(q.has("gl") ? { gl: true } : {}),
		worker: q.has("worker") || q.has("cpus"),
		...(q.get("cpus") ? { cpus: Number(q.get("cpus")) } : {}),
		memoryMiB: Number(q.get("mem") || 1024),
		log,
	});
	vm.onOutput((b) => (consoleBuf += new TextDecoder().decode(b)));
	log(`booted (transport ${vm.transport})`);
	if (!vm.va) throw new Error("vm.va is undefined: the va option was ignored (see the log)");
	result.statusAtBoot = vm.va.status;
	const run = async (name, cmd) => {
		log(`run ${name}: ${cmd}`);
		const t = performance.now(), before = vm.va.stats;
		const r = await vm.exec("bash", ["-c", cmd], { timeout: 1200_000 });
		const after = vm.va.stats, va = {};
		for (const k of ["pictures", "flushes", "restarts", "replays", "failed", "errors", "reclaims", "holdFires", "fillers", "dropped", "modeSwitches", "fallbacks", "readbacks", "bytesRead", "exports", "uploads", "uploadBytes", "uploadMs", "uploadFailed",
			"gpuUploads", "gpuUploadMs", "cpuConversions", "cpuConversionMs", "copies", "copyMs", "framesEvicted"]) va[k] = after[k] - before[k];
		va.gpuFallbacks = {};
		for (const [k, n] of Object.entries(after.gpuFallbacks)) if (n - (before.gpuFallbacks[k] ?? 0)) va.gpuFallbacks[k] = n - (before.gpuFallbacks[k] ?? 0);
		va.exported = after.exported;
		va.framesHeld = after.framesHeld;
		va.framesHeldPeak = after.framesHeldPeak;
		va.colorSpace = after.contexts.at(-1)?.colorSpace ?? null;
		// encoding (va-enc.ts): pictures, chunks, where their pixels came from, recoveries
		va.enc = {};
		for (const k of ["pictures", "chunks", "keyFrames", "codedBytes", "uploads", "uploadBytes", "kept", "decoded", "black", "failed", "errors", "reclaims", "flushes", "recoveries", "reconfigures"]) va.enc[k] = after.encode[k] - before.encode[k];
		va.modes = after.contexts.filter((c) => !before.contexts.some((b) => b.id === c.id && b.pictures === c.pictures)).map((c) => `${c.profile} ${c.mode}${c.adapter.reorder !== undefined ? ` reorder ${c.adapter.reorder}` : ""}`);
		const s = { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Math.round(performance.now() - t), va };
		const { contexts, ...totals } = vm.va.stats;
		log(`${name}: exit ${r.exitCode ?? r.signal} after ${(s.ms / 1000).toFixed(1)} s; host ${JSON.stringify(totals)}; contexts ${JSON.stringify(contexts.slice(-2))}`);
		result.steps[name] = s;
		return s;
	};
	const put = async (url, path, mode) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		const r = await vm.exec("sh", ["-c", `mkdir -p "$(dirname ${path})" && cat >${path} && chmod ${mode} ${path}`], { input: new Uint8Array(await res.arrayBuffer()), user: "root" });
		if (r.exitCode !== 0) throw new Error(`writing ${path}: ${r.stderr}`);
	};
	if (q.get("push") !== "0") {
		await put("/files/kw_drv_video.so", `${DRI}/kw_drv_video.so`, 755);
		await vm.exec("sh", ["-c", `ln -sf kw_drv_video.so ${DRI}/virtio_gpu_drv_video.so`], { user: "root" });
	}
	await put("/files/va-decode", "/tmp/va-decode", 755);
	await put("/files/va-encode", "/tmp/va-encode", 755);
	const clips = (q.get("clips") || "bbb720,bbb1080").split(",").filter(Boolean);
	const names = [...vectors, ...clips];
	for (const n of names) {
		await put(`/samples/${n}.webm`, `/tmp/va/${n}.webm`, 644);
		await put(`/samples/${n}.ivf`, `/tmp/va/${n}.ivf`, 644);
	}
	// H.264 clips: from the host, or made here once and kept there
	const h264 = skip.has("h264") ? [] : await (await fetch("/h264.json")).json();
	const b64 = (s) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
	for (const c of h264) {
		if (c.have) {
			await put(`/samples/${c.file}`, `/tmp/va/${c.file}`, 644);
			continue;
		}
		log(`making ${c.file} in the guest`);
		let bytes;
		if (c.make === "twopps") {
			const r = await vm.exec("bash", ["-c", "ffmpeg -hide_banner -loglevel error -i /tmp/va/h264-base.mp4 -c copy -bsf:v h264_mp4toannexb -f h264 - | base64 -w0"], { timeout: 600_000 });
			const { twoPps } = await import("/test/va/h264-pps.mjs");
			bytes = twoPps(b64(r.stdout));
			const w = await vm.exec("sh", ["-c", `cat >/tmp/va/${c.file}`], { input: bytes });
			if (w.exitCode !== 0) throw new Error(`writing ${c.file}: ${w.stderr}`);
		} else {
			const r = await vm.exec("bash", ["-c", `set -e; cd /tmp/va; ${c.make}; base64 -w0 ${c.file}`], { timeout: 1800_000 });
			if (r.exitCode !== 0) throw new Error(`making ${c.file}: ${r.stderr}`);
			bytes = b64(r.stdout);
		}
		await fetch(`/save/${c.file}`, { method: "POST", body: bytes });
	}
	// AV1 clips: from the host, or made here once and kept there (as the H.264 ones)
	const av1 = skip.has("av1") ? [] : await (await fetch("/av1.json")).json();
	for (const c of av1) {
		if (c.have) {
			await put(`/samples/${c.file}`, `/tmp/va/${c.file}`, 644);
			continue;
		}
		log(`making ${c.file} in the guest`);
		const r = await vm.exec("bash", ["-c", `set -e; cd /tmp/va; ${c.make}; base64 -w0 ${c.file}`], { timeout: 3600_000 });
		if (r.exitCode !== 0) throw new Error(`making ${c.file}: ${r.stderr}`);
		await fetch(`/save/${c.file}`, { method: "POST", body: b64(r.stdout) });
	}
	await run("info", `ls -l /dev/dri ${DRI}/; env | grep -i -E 'libva|display' ; true`);
	if (!skip.has("vainfo")) {
		await run("vainfo", "vainfo 2>&1");
		await run("vainfo-drm", "vainfo --display drm --device /dev/dri/renderD128 2>&1");
	}
	if (!skip.has("vadecode")) for (const v of vectors) await run(`vadecode-${v}`, `/tmp/va-decode -d ${DRI}/kw_drv_video.so /tmp/va/${v}.ivf`);
	if (!skip.has("ffmpeg"))
		for (const n of [...vectors, ...clips.filter((c) => c !== "bbb1080")]) {
			const lim = n === "bbb720" ? "-frames:v 60" : "";
			await run(`ffmpeg-hw-${n}`, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/${n}.webm ${lim} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`);
			await run(`ffmpeg-sw-${n}`, `ffmpeg -hide_banner -loglevel warning -i /tmp/va/${n}.webm ${lim} -pix_fmt yuv420p -f framemd5 -`);
		}
	// H.264: decode-ahead (hwdownload in ffmpeg's filter thread) for each, and plain -hwaccel vaapi (the
	// decoder thread syncs and reads each frame right after ffmpeg's own reorder delay) for some
	if (!skip.has("ffmpeg"))
		for (const c of h264) {
			const lim = c.frames ? `-frames:v ${c.frames}` : "", f = `/tmp/va/${c.file}`;
			await run(`ffmpeg-hw-${c.file}`, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i ${f} ${lim} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`);
			if (c.plain) await run(`ffmpeg-plain-${c.file}`, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -i ${f} ${lim} -pix_fmt yuv420p -f framemd5 -`);
			await run(`ffmpeg-sw-${c.file}`, `ffmpeg -hide_banner -loglevel warning -i ${f} ${lim} -pix_fmt yuv420p -f framemd5 -`);
		}
	// AV1: decode-ahead on each (framemd5 with every frame, -fps_mode passthrough: the vectors' timestamps repeat), plain on some
	if (!skip.has("ffmpeg"))
		for (const c of av1) {
			const lim = c.frames ? `-frames:v ${c.frames}` : "", f = `/tmp/va/${c.file}`, all = "-fps_mode passthrough";
			await run(`ffmpeg-hw-${c.file}`, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i ${f} ${lim} -vf hwdownload,format=nv12,format=yuv420p ${all} -f framemd5 -`);
			if (c.plain) await run(`ffmpeg-plain-${c.file}`, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -i ${f} ${lim} -pix_fmt yuv420p ${all} -f framemd5 -`);
			await run(`ffmpeg-sw-${c.file}`, `ffmpeg -hide_banner -loglevel warning -i ${f} ${lim} -pix_fmt yuv420p ${all} -f framemd5 -`);
		}
	// the recovery paths for real (VaHost.inject): a decoder reclaimed, flushed or failed mid-stream is
	// made again and the stream since its key frame replayed, so the frames must still be exact; a
	// picture that fails reads back as the last good one and ffmpeg goes on
	const injected = async (name, inj, cmd) => {
		for (const [what, every] of inj) vm.va.inject(what, { every });
		try {
			await run(name, cmd);
		} finally {
			vm.va.inject(null);
		}
	};
	if (!skip.has("recover")) {
		const v = vectors[0];
		if (v) await injected(`recover-vadecode-${v}`, [["reclaim", 3], ["flush", 5], ["error", 7]], `/tmp/va-decode -d ${DRI}/kw_drv_video.so /tmp/va/${v}.ivf`);
		const n = clips.includes("arf720") ? "arf720" : "bbb720";
		const frames = "-frames:v 60";
		await injected(`recover-ffmpeg-${n}`, [["reclaim", 7], ["flush", 11], ["error", 13]], `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/${n}.webm ${frames} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`);
		await run(`recover-sw-${n}`, `ffmpeg -hide_banner -loglevel warning -i /tmp/va/${n}.webm ${frames} -pix_fmt yuv420p -f framemd5 -`);
		await injected("fail-ffmpeg-bbb720", [["fail", 20]], `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/bbb720.webm ${frames} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`);
		if (!result.steps["ffmpeg-sw-bbb720"]) await run("ffmpeg-sw-bbb720", `ffmpeg -hide_banner -loglevel warning -i /tmp/va/bbb720.webm ${frames} -pix_fmt yuv420p -f framemd5 -`);
		// H.264 (reorder delay 2, replays carrying the SPS made again), decode-ahead and plain
		const hc = h264.find((c) => c.recover);
		if (hc) {
			const f = `/tmp/va/${hc.file}`, inj = [["reclaim", 7], ["flush", 11], ["error", 13]];
			await injected(`recover-ffmpeg-${hc.file}`, inj, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i ${f} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`);
			await injected(`recover-ffmpeg-plain-${hc.file}`, inj, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -i ${f} -pix_fmt yuv420p -f framemd5 -`);
			await run(`recover-sw-${hc.file}`, `ffmpeg -hide_banner -loglevel warning -i ${f} -pix_fmt yuv420p -f framemd5 -`);
		}
		// AV1 (slots kept by the host, pictures stored late or decoded again), decode-ahead and plain
		for (const ac of av1.filter((c) => c.recover)) {
			const f = `/tmp/va/${ac.file}`, inj = [["reclaim", 7], ["flush", 11], ["error", 13]], lim = ac.frames ? `-frames:v ${ac.frames}` : "";
			await injected(`recover-ffmpeg-${ac.file}`, inj, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i ${f} ${lim} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`);
			await injected(`recover-ffmpeg-plain-${ac.file}`, inj, `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -i ${f} ${lim} -pix_fmt yuv420p -f framemd5 -`);
			await run(`recover-sw-${ac.file}`, `ffmpeg -hide_banner -loglevel warning -i ${f} ${lim} -pix_fmt yuv420p -f framemd5 -`);
		}
	}
	const timed = (cmd) => `s=$(date +%s.%N); ${cmd} 2>&1 | tr '\\r' '\\n' | grep -E 'bench|frame=|frames shown|Error|error' | tail -4; r=\${PIPESTATUS[0]}; e=$(date +%s.%N); awk "BEGIN{print \\"wall \\" ($e - $s)}"; exit $r`;
	if (!skip.has("fps")) {
		for (const n of ["bbb720", "bbb1080"]) {
			await run(`fps-ffmpeg-vaapi-${n}`, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/${n}.webm -vf hwdownload,format=nv12 -f null -`));
			await run(`fps-va-decode-${n}`, timed(`/tmp/va-decode -q -d ${DRI}/kw_drv_video.so /tmp/va/${n}.ivf`));
		}
		await run("fps-ffmpeg-auto-bbb720", timed("ffmpeg -hide_banner -benchmark -hwaccel vaapi -i /tmp/va/bbb720.webm -f null -"));
		await run("fps-ffmpeg-software-bbb720", timed("ffmpeg -hide_banner -benchmark -i /tmp/va/bbb720.webm -f null -"));
		for (const c of [...h264, ...av1].filter((c) => c.fps)) {
			await run(`fps-ffmpeg-vaapi-${c.file}`, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/${c.file} -vf hwdownload,format=nv12 -f null -`));
			await run(`fps-ffmpeg-auto-${c.file}`, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -i /tmp/va/${c.file} -f null -`));
		}
	}
	// conservative mode and decoders that hold more than the model says, on the real decoder (VaHost.setOptions):
	// every context conservative from the start; H.264 declaring 1 (fillers) and 2 (fillers, then flushes) more
	// reorder frames than it needs, so Chromium's decoder holds that many more than the model; plain and decode-ahead
	if (!skip.has("modes")) {
		const modes = async (name, o, cmd) => {
			vm.va.setOptions(o);
			try {
				await run(name, cmd);
			} finally {
				vm.va.setOptions({ mode: "auto", holdExtra: 0 });
			}
		};
		const plain = (f, lim) => `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -i ${f} ${lim} -pix_fmt yuv420p -f framemd5 -`;
		const ahead = (f, lim) => `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i ${f} ${lim} -vf hwdownload,format=nv12,format=yuv420p -f framemd5 -`;
		for (const c of h264.filter((c) => c.modes)) {
			const f = `/tmp/va/${c.file}`, lim = c.frames ? `-frames:v ${c.frames}` : "";
			if (!result.steps[`ffmpeg-sw-${c.file}`]) await run(`ffmpeg-sw-${c.file}`, `ffmpeg -hide_banner -loglevel warning -i ${f} ${lim} -pix_fmt yuv420p -f framemd5 -`);
			await modes(`mode-cons-plain-${c.file}`, { mode: "conservative" }, plain(f, lim));
			await modes(`mode-cons-hw-${c.file}`, { mode: "conservative" }, ahead(f, lim));
			await modes(`mode-hold1-plain-${c.file}`, { holdExtra: 1 }, plain(f, lim));
			if (c.hold2) await modes(`mode-hold2-plain-${c.file}`, { holdExtra: 2 }, plain(f, lim));
		}
		if (!skip.has("fps")) {
			const c = h264.find((c) => c.fps), f = `/tmp/va/${c.file}`;
			await modes(`fps-cons-vaapi-${c.file}`, { mode: "conservative" }, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -hwaccel_output_format vaapi -i ${f} -vf hwdownload,format=nv12 -f null -`));
			await modes(`fps-cons-auto-${c.file}`, { mode: "conservative" }, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -i ${f} -f null -`));
			await modes(`fps-hold1-auto-${c.file}`, { holdExtra: 1 }, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -i ${f} -f null -`));
			await modes(`fps-hold2-auto-60-${c.file}`, { holdExtra: 2 }, timed(`ffmpeg -hide_banner -benchmark -hwaccel vaapi -i ${f} -frames:v 60 -f null -`));
		}
	}
	const mpv = (f) => `timeout 600 mpv --no-config --hwdec=vaapi-copy --vo=null --ao=null --frames=60 -v ${f} 2>&1 | grep -v '^\\[cplayer\\] Set property' | head -400`;
	if (!skip.has("mpv")) await run("mpv", mpv("/tmp/va/bbb720.webm"));
	for (const mc of [h264.find((c) => c.mpv), av1.find((c) => c.mpv)]) if (!skip.has("mpv") && mc) await run(`mpv-${mc.file}`, mpv(`/tmp/va/${mc.file}`));
	// encode (VAEntrypointEncSlice, VP9): encodeSteps below
	if (!skip.has("encode")) await encodeSteps(vm, run, skip);
	if (q.has("gl")) await zeroSteps(vm, run, result);
	if (q.get("cmd")) await run("cmd", q.get("cmd"));
	result.status = vm.va.status;
	if (vm.gl) result.gl = { status: vm.gl.status, gpu: vm.gl.stats.gpu };
	result.stats = vm.va.stats;
	await post("/result", JSON.stringify(result));
	log("done");
	await vm.stop();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toRgba = (bmp) => {
	const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext("2d");
	g.drawImage(bmp, 0, 0);
	return { width: bmp.width, height: bmp.height, data: new Uint8Array(g.getImageData(0, 0, bmp.width, bmp.height).data.buffer) };
};
/** An RGBA image against a BGRX one of the same size: per channel, the largest and mean absolute difference, and the 99th percentile. */
const diffBgrx = (img, ref) => {
	if (img.width !== ref.width || img.height !== ref.height) return { error: `${img.width}x${img.height} against ${ref.width}x${ref.height}` };
	const hist = new Uint32Array(256);
	let sum = 0;
	for (let i = 0; i < img.data.length; i += 4)
		for (const [a, b] of [[0, 2], [1, 1], [2, 0]]) {
			const d = Math.abs(img.data[i + a] - ref.data[i + b]);
			hist[d]++;
			sum += d;
		}
	const n = (img.data.length / 4) * 3;
	let max = 0, p99 = -1, acc = 0;
	for (let d = 0; d < 256; d++) {
		if (hist[d]) max = d;
		acc += hist[d];
		if (p99 < 0 && acc >= n * 0.99) p99 = d;
	}
	return { max, mean: Math.round((sum / n) * 1000) / 1000, p99 };
};
/** an RGBA image's distinct colours and mean luma (a video frame: many colours, not flat) */
const judge = (img) => {
	if (!img) return null;
	const colours = new Set();
	let luma = 0;
	for (let i = 0; i < img.data.length; i += 4) {
		colours.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
		luma += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
	}
	return { width: img.width, height: img.height, colours: colours.size, luma: Math.round(luma / (img.data.length / 4)) };
};

/**
 * Zero-copy output (gl=1): the driver's vaExportSurfaceHandle, imported by
 * EGL on the render node, and mpv's --hwdec=vaapi (not -copy) in a Wayland
 * window: wland/headless on this page (web/node_modules/wland) serves vsock
 * port 1023, the image's relay runs in the guest with --dmabuf virtgpu (GL
 * clients' buffers by virtio-gpu resource), and gpu.resolve is
 * vm.gl.gpu.image(), as the page's desktop has it. Steps:
 * - export-NAME: va-decode -e (-E: composed layers too) on the vectors, 30
 *   frames of the 720p clip
 * - wl-VO-HWDEC-CLIP: mpv --vo=VO --hwdec=HWDEC (vaapi, vaapi-copy) for
 *   `mpvframes` frames (untimed, swap interval 0) in the Wayland window:
 *   its log, guest CPU time, wland's commits by GPU resource, a frame's
 *   pixels, the host's VA counters (readbacks, uploads)
 */
async function zeroSteps(vm, run, result) {
	const z = (result.zero = { gl: vm.gl ? vm.gl.status : null });
	const drv = `${DRI}/kw_drv_video.so`;
	if (!skip.has("export")) {
		for (const v of vectors) await run(`export-${v}`, `/tmp/va-decode -e -d ${drv} /tmp/va/${v}.ivf 2>&1`);
		if (vectors[0]) await run(`export-composed-${vectors[0]}`, `/tmp/va-decode -E -d ${drv} /tmp/va/${vectors[0]}.ivf 2>&1`);
		await run("export-bbb720", `/tmp/va-decode -e -n 30 -d ${drv} /tmp/va/bbb720.ivf 2>&1`);
	}
	if (skip.has("wland")) return;
	let W;
	try {
		W = await import("/wland/headless.mjs");
	} catch (e) {
		z.error = `wland/headless did not load: ${e.message}`;
		return;
	}
	const relay = "/usr/lib/kw/wlandr";
	z.relay = (await vm.exec("sh", ["-c", `${relay} --version 2>&1`])).stdout.trim();
	const listener = vm.vsock.listen(1023);
	const conns = { [Symbol.asyncIterator]: () => ({ next: async () => { const c = await listener.accept(); return c ? { value: c, done: false } : { value: undefined, done: true }; } }) };
	const st = { gpu: 0, shm: 0, resolves: 0, nulls: 0, resolveMs: 0, errors: [], lastRef: null };
	let want = false, sampled = null, verify = false, sampledDiff = null;
	const blank = new Map();
	const XR24 = 0x34325258, XB24 = 0x34324258;
	const hl = await W.createHeadless({
		link: conns, width: 1600, height: 1000, frameInterval: 4,
		gpu: {
			async resolve(ref) {
				st.lastRef = { resource: ref.resource, width: ref.width, height: ref.height, format: `0x${ref.format.toString(16)}`, modifier: String(ref.modifier) };
				const t = performance.now();
				const bmp = await vm.gl.gpu.image(ref.resource, { width: ref.width, height: ref.height, opaque: ref.format === XR24 || ref.format === XB24, flipY: !!(ref.flags & 1) });
				st.resolveMs += performance.now() - t;
				st.resolves++;
				if (!bmp) {
					st.nulls++;
					return null;
				}
				let img;
				// (VaOptions.verify: the CPU path's conversion of the picture drawn into this resource now, taken in the same task as the image)
				const cpuRef = want && verify ? vm.va.reference(ref.resource) : null;
				if (want && (!verify || cpuRef)) {
					img = sampled = toRgba(bmp);
					if (cpuRef) sampledDiff = diffBgrx(img, cpuRef);
					want = false;
				} else {
					const k = `${ref.width}x${ref.height}`;
					if (!blank.has(k)) blank.set(k, { width: ref.width, height: ref.height, data: new Uint8Array(ref.width * ref.height * 4) });
					img = blank.get(k);
				}
				bmp.close();
				return img;
			},
			release() {},
		},
		onEvent(ev) {
			if (ev.type === "commit") ev.format === "gpu" && !ev.external ? st.gpu++ : st.shm++;
			else if (ev.type === "error" && st.errors.length < 20) st.errors.push(ev.detail);
		},
	});
	const env = "export XDG_RUNTIME_DIR=/tmp/kwva-wlr WAYLAND_DISPLAY=kwva-w";
	z.relayLog = (await vm.exec("sh", ["-c", `pkill -x wlandr; sleep 0.3; rm -rf /tmp/kwva-wlr; mkdir -m 700 /tmp/kwva-wlr; ${env}; setsid ${relay} --link vsock:2:1023 --display kwva-w --dmabuf virtgpu:/dev/dri/renderD128 --no-fence-wait </dev/null >/tmp/kwva-wlandr.log 2>&1 & ` +
		"for i in $(seq 100); do [ -S /tmp/kwva-wlr/kwva-w ] && break; sleep 0.1; done; sleep 1; cat /tmp/kwva-wlandr.log"])).stdout.trim();
	const frames = Number(q.get("mpvframes") || 120);
	// opts.cpu: VaOptions.upload "cpu" (video processing on the CPU); opts.verify: VaOptions.verify, the sampled frame compared with the CPU path's conversion
	const mpv = async (name, vo, hwdec, clip, extra = "", opts = {}) => {
		const before = { ...st };
		want = false;
		sampled = null;
		sampledDiff = null;
		verify = !!opts.verify;
		vm.va.setOptions({ upload: opts.cpu ? "cpu" : "auto", verify });
		// a frame from the middle of the run
		let done = false;
		const sampler = (async () => {
			for (let i = 0; i < 60000 && !done && st.gpu - before.gpu < frames / 2; i++) await sleep(20);
			want = true;
		})();
		const cmd = `${env}; cd /tmp/va; TIMEFORMAT='mpvtime %R %U %S'; { time ${q.get("mpvenv") || ""} timeout 900 mpv --no-config --vo=${vo} --hwdec=${hwdec} --ao=null --untimed --opengl-swapinterval=0 --frames=${frames} -v ${extra} ${clip} >/tmp/kwva-mpv.log 2>&1; } 2>&1; r=$?; ` +
			(q.get("mpvgrep") ? `grep -E '${q.get("mpvgrep")}' /tmp/kwva-mpv.log | head -60; ` : "") + "grep -E 'Using hardware decoding|VO: \\[|vaapi|hwdec|dmabuf|interop|rror|ailed|EGL|GL_RENDERER|GL_VERSION|Exiting' /tmp/kwva-mpv.log | grep -v 'Set property' | head -80; exit $r";
		const s = await run(name, cmd);
		done = true;
		await sampler;
		want = false;
		const m = /mpvtime ([\d.]+) ([\d.]+) ([\d.]+)/.exec(s.stdout);
		s.wl = { gpuCommits: st.gpu - before.gpu, shmCommits: st.shm - before.shm, resolves: st.resolves - before.resolves, nulls: st.nulls - before.nulls,
			resolveMs: st.resolves - before.resolves ? (st.resolveMs - before.resolveMs) / (st.resolves - before.resolves) : null, lastRef: st.lastRef, frame: judge(sampled), diff: sampledDiff, errors: st.errors.slice() };
		vm.va.setOptions({ upload: "auto", verify: false });
		verify = false;
		if (m) s.time = { wall: Number(m[1]), user: Number(m[2]), sys: Number(m[3]), frames };
		log(`${name}: ${JSON.stringify(s.wl)} ${JSON.stringify(s.time)}`);
		await vm.exec("sh", ["-c", "pkill -x mpv; true"]);
		await sleep(300);
	};
	try {
		if (q.has("gst")) await gstStep(vm, run, env, st);
		if (q.has("firefox")) await firefoxStep(vm, run, env, st, hl);
		for (const vo of (q.get("vos") || "gpu,gpu-next,dmabuf-wayland").split(",").filter((v) => v && v !== "none")) {
			const extra = vo === "gpu" ? "--gpu-context=wayland --opengl-es=yes" : vo === "gpu-next" ? "--gpu-context=wayland --gpu-api=opengl --opengl-es=yes" : "";
			await mpv(`wl-${vo}-vaapi-bbb720${vo === "dmabuf-wayland" ? "-verify" : ""}`, vo, "vaapi", "bbb720.webm", extra, { verify: vo === "dmabuf-wayland" });
		}
		// dmabuf-wayland (video processing to BGRX): the GPU path against the CPU one, with the sampled frame
		// compared with the CPU path's conversion of the same picture; H.264 too, and the CPU path forced
		if ((q.get("vos") || "gpu,gpu-next,dmabuf-wayland").split(",").includes("dmabuf-wayland")) {
			await mpv("wl-dmabuf-wayland-vaapi-bbb720-h264-verify", "dmabuf-wayland", "vaapi", "bbb720-h264.mp4", "", { verify: true });
			await mpv("wl-dmabuf-wayland-vaapi-bbb720-cpu", "dmabuf-wayland", "vaapi", "bbb720.webm", "", { cpu: true });
		}
		// ffmpeg's scale_vaapi to bgr0 read back (hwdownload, not exported: converted on the host's CPU) against
		// swscale's conversion of the same NV12 (hwdownload) with what ffmpeg's pipeline parameters ask for these
		// streams without a matrix (the host logs it: BT.709, limited range in; out: the input's range where it has
		// one, as the output frame keeps it, else full; limited-range RGB, which swscale does not make, by lutrgb),
		// as PSNR
		if (!skip.has("bgr0"))
			for (const clip of ["bbb720.webm", "bbb720-h264.mp4", "av1-odd.mkv"]) {
				const src = `-hide_banner -loglevel error -y -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/${clip} -frames:v 10`;
				await run(`bgr0-${clip.replace(/\.\w+$/, "")}`, `cd /tmp && s=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,color_space,color_range -of csv=p=0 /tmp/va/${clip}) && echo "stream $s" && w=\${s%%,*} && r=\${s#*,} && h=\${r%%,*} && ` +
					`m=bt709 && o=$(case "$s" in *,tv,*) echo ",lutrgb=r=val*219/255+16:g=val*219/255+16:b=val*219/255+16" ;; *) echo ;; esac) && ffmpeg ${src} -vf scale_vaapi=format=bgr0,hwdownload,format=bgr0 -f rawvideo hw.bgr0 && ` +
					`ffmpeg ${src} -vf hwdownload,format=nv12,scale=in_color_matrix=$m:in_range=tv:out_range=pc:flags=accurate_rnd+bitexact,format=bgr0$o,format=bgr0 -f rawvideo sw.bgr0 && ls -l hw.bgr0 sw.bgr0 && echo "matrix $m, out \${o:-full}" && ` +
					`ffmpeg -hide_banner -f rawvideo -pix_fmt bgr0 -s \${w}x\${h} -i hw.bgr0 -f rawvideo -pix_fmt bgr0 -s \${w}x\${h} -i sw.bgr0 -lavfi psnr -f null - 2>&1 | grep -o 'PSNR.*'`);
			}
		if (!skip.has("mpvfps")) {
			const extra = "--gpu-context=wayland --opengl-es=yes";
			for (const clip of ["bbb720.webm", "bbb1080.webm", "bbb720-h264.mp4", "bbb1080-h264.mp4"])
				for (const [vo, hw] of [["gpu", "vaapi"], ["gpu", "vaapi-copy"], ["dmabuf-wayland", "vaapi"], ["dmabuf-wayland", "vaapi-cpu"]].filter(([v, h]) => !q.get("fpspaths") || q.get("fpspaths").split(",").includes(`${v}:${h}`)))
					await mpv(`wl-${vo}-${hw}-${clip.replace(/\.\w+$/, "")}`, vo, hw === "vaapi-cpu" ? "vaapi" : hw, clip, vo === "gpu" ? extra : "", { cpu: hw === "vaapi-cpu" });
		}
	} catch (e) {
		z.error = String(e?.stack || e);
	} finally {
		z.wlErrors = st.errors;
		await vm.exec("sh", ["-c", "pkill -x mpv; pkill -x wlandr; true"]);
		hl.dispose?.();
		listener.close();
	}
}

/** pictures, exports, readbacks, uploads of the host's VA side now */
const vaNow = (vm) => {
	const s = vm.va.stats;
	return { pictures: s.pictures, exports: s.exports, readbacks: s.readbacks, uploads: s.uploads, contexts: s.contexts.length };
};

/**
 * GStreamer's va decoder into glimagesink in the Wayland window (gst=1, the
 * apps disk): GST_VA_ALL_DRIVERS=1 (the va plugin registers elements only
 * for the drivers it knows by vendor), the decoder's output caps
 * (memory:DMABuf when glupload takes the dmabufs), the host's counters and
 * wland's commits by GPU resource.
 */
async function gstStep(vm, run, env, st) {
	for (const [name, clip, dec] of [["gst-h264", "bbb720-h264.mp4", "qtdemux ! h264parse ! vah264dec"], ["gst-vp9", "bbb720.webm", "matroskademux ! vp9parse ! vavp9dec"]]) {
		const b0 = { ...st };
		const s = await run(name, `${env}; cd /tmp/va; GST_VA_ALL_DRIVERS=1 ${q.get("gstenv") || ""} timeout 600 gst-launch-1.0 -v filesrc location=${clip} ! ${dec} ! glimagesink sync=false 2>&1 | grep -E "vah264dec0.GstPad:src: caps|vavp9dec0.GstPad:src: caps|rror|ERROR|Execution ended|Got EOS${q.get("gstgrep") ? `|${q.get("gstgrep")}` : ""}" | cut -c1-${q.get("gstgrep") ? 900 : 240} | head -${q.get("gstgrep") ? 40 : 6}`);
		s.wl = { gpuCommits: st.gpu - b0.gpu, shmCommits: st.shm - b0.shm };
		log(`${name}: ${JSON.stringify(s.wl)}`);
	}
}

/**
 * firefox-esr in the Wayland window (firefox=1, the apps disk): a page with
 * the 720p clips in <video autoplay muted loop>, a fresh profile (autoplay
 * allowed, hardware decoding forced past the blocklist), the RDD process's
 * sandbox off (MOZ_DISABLE_RDD_SANDBOX=1: it refuses socket(), and the
 * driver reaches the host over vsock), FFmpegVideo logging. Runs until the
 * host has decoded 90 pictures for it or 600 s; the host's counters
 * (contexts made by Firefox, exports, readbacks) and wland's commits say
 * what happened.
 */
async function firefoxStep(vm, run, env, st, hl) {
	const hlTitle = () => (hl?.windows?.() ?? []).map((w) => w.title).filter(Boolean).join(" | ");
	const prefs = [
		["media.hardware-video-decoding.force-enabled", true], ["media.autoplay.default", 0], ["media.autoplay.blocking_policy", 0],
		["browser.shell.checkDefaultBrowser", false], ["browser.startup.homepage_override.mstone", "\"ignore\""], ["datareporting.policy.dataSubmissionEnabled", false],
		["toolkit.telemetry.reportingpolicy.firstRun", false], ["browser.aboutwelcome.enabled", false], ["app.update.auto", false], ["browser.tabs.warnOnClose", false],
		// VA-API needs hardware WebRender and DMABuf (FFmpegVideoDecoder.cpp, gfxPlatformGtk.cpp)
		["gfx.webrender.all", true], ["widget.dmabuf.force-enabled", true], ["layers.acceleration.force-enabled", true],
	].map(([k, v]) => `user_pref("${k}", ${v});`).join("\n");
	for (const clip of (q.get("ffclips") || "bbb720-h264.mp4,bbb720.webm").split(",").filter(Boolean)) {
		const name = `firefox-${clip.replace(/\.\w+$/, "")}`;
		await vm.exec("sh", ["-c", `rm -rf /tmp/ffp /tmp/ff.log*; mkdir -p /tmp/ffp; cat >/tmp/ffp/user.js; printf '<!doctype html><title>kwva</title><body style="margin:0;background:#000"><video id=v src="${clip}" autoplay muted loop style="width:100%%"></video><script>setInterval(function(){var v=document.getElementById("v"),q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():{};document.title="kwva t="+v.currentTime.toFixed(1)+" rs="+v.readyState+" frames="+(q.totalVideoFrames||0)+" err="+(v.error?v.error.code:0)},1000)</script>' >/tmp/va/play.html`], { input: new TextEncoder().encode(prefs + "\n") });
		const b0 = { ...st }, v0 = vaNow(vm), t0 = performance.now();
		await vm.exec("sh", ["-c", `${env}; cd /tmp/va; MOZ_DISABLE_RDD_SANDBOX=1 MOZ_LOG=sync,FFmpegVideo:5,PlatformDecoderModule:4,Dmabuf:4,MediaDecoder:3 MOZ_LOG_FILE=/tmp/ff.log setsid firefox-esr --no-remote --profile /tmp/ffp file:///tmp/va/play.html </dev/null >/tmp/ff.out 2>&1 &`]);
		let v = v0;
		for (let i = 0; i < Number(q.get("ffsecs") || 600) * 2; i++) {
			await sleep(500);
			v = vaNow(vm);
			if (v.pictures - v0.pictures >= 90) break;
		}
		const ms = performance.now() - t0;
		await sleep(2000);
		const s = await run(name, `pkill -x firefox-esr; sleep 2; pkill -9 -f '^/usr/lib/firefox-esr/'; ls -la /tmp/ff.log* 2>&1 | head; cat /tmp/ff.log* 2>/dev/null | grep -iE '${q.get("ffgrep") || "va-?api|vaexport|dmabuf|hw.?decod|hardware|zero.?copy|surface|FFmpeg.*(init|Init|fail|rror|support|Creat)|PDM|decoder"}' | sed -E 's/^\\[[^]]*\\] *//; s/[0-9a-fx]{8,}//g' | sort | uniq -c | sort -rn | head -60; echo '--- stdout'; grep -v 'channel error' /tmp/ff.out | tail -20`);
		s.ff = { title: hlTitle(), pictures: v.pictures - v0.pictures, exports: v.exports - v0.exports, readbacks: v.readbacks - v0.readbacks, uploads: v.uploads - v0.uploads, gpuCommits: st.gpu - b0.gpu, shmCommits: st.shm - b0.shm, seconds: Math.round(ms / 1000) };
		log(`${name}: ${JSON.stringify(s.ff)}`);
	}
}

main().catch(async (e) => {
	log(`error: ${e?.stack || e}`);
	await post("/result", JSON.stringify({ error: String(e?.stack || e) }));
});

/**
 * The judge of an encode step (in the guest): the output decoded in
 * software, its packets, frames, key frames, kbit/s and PSNR against INPUT
 * through NV12 (what the encode got), frame by frame (both renumbered in
 * one time base: WebM's 1 ms timestamps against 1/30 s would pair a frame
 * with its neighbour).
 */
const ENC_CHECK = `# /tmp/enc/check.sh OUT FRAMES INPUT...
out=$1 n=$2; shift 2
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags,size -of csv=p=0 "$out" >"$out.pk"
pk=$(wc -l <"$out.pk")
dec=$(ffmpeg -v error -i "$out" -f framemd5 - | grep -c '^0,')
keys=$(awk -F, '{ if ($3 ~ /K/) printf "%d ", NR-1 }' "$out.pk")
kbps=$(awk -F, 'NR==2{d=$1} {s+=$2; t=$1} END{printf "%.0f", s*8/(t+d)/1000}' "$out.pk")
psnr=$(ffmpeg -hide_banner -i "$out" "$@" -frames:v "$n" -lavfi "[0:v]settb=1/30,setpts=N,format=yuv420p[a];[1:v]settb=1/30,setpts=N,format=nv12,format=yuv420p[b];[a][b]psnr" -f null - 2>&1 | grep -o 'average:[0-9.inf]*' | cut -d: -f2)
echo "enc check: packets $pk decoded $dec keys [$keys] kbps $kbps psnr $psnr"
`;

/**
 * Encode (VAEntrypointEncSlice, VP9; skip=encode): ffmpeg's vp9_vaapi from
 * testsrc2 (CQP by default, -global_quality, VBR, CBR, -g 30), odd and
 * 1080p sizes, the 720p clip (decoded in software, uploaded), a
 * decode-to-encode transcode (-hwaccel vaapi: nothing uploaded), recovery
 * (encoders reclaimed, failed and flushed mid-stream), each judged by
 * ENC_CHECK; and frame rates: ffmpeg's, and va-encode's with pixels sent
 * each frame against unchanged surfaces (the upload's cost).
 */
async function encodeSteps(vm, run, skip) {
	const w = await vm.exec("sh", ["-c", "mkdir -p /tmp/enc && cat >/tmp/enc/check.sh"], { input: new TextEncoder().encode(ENC_CHECK) });
	if (w.exitCode !== 0) throw new Error(`writing /tmp/enc/check.sh: ${w.stderr}`);
	const t2 = (s) => `-f lavfi -i testsrc2=size=${s}:rate=30`;
	const enc = (name, input, n, args, inj = null) => {
		const out = `/tmp/enc/${name}.webm`;
		const cmd = `ffmpeg -hide_banner -loglevel warning -vaapi_device /dev/dri/renderD128 ${input} -frames:v ${n} -vf format=nv12,hwupload -c:v vp9_vaapi ${args} -y ${out} && sh /tmp/enc/check.sh ${out} ${n} ${input}`;
		return inj ? injectedRun(vm, run, `enc-${name}`, inj, cmd) : run(`enc-${name}`, cmd);
	};
	await enc("cqp", t2("1280x720"), 120, "");
	await enc("cqp-q60", t2("1280x720"), 60, "-rc_mode CQP -global_quality 60");
	await enc("vbr-2M", t2("1280x720"), 120, "-b:v 2M");
	await enc("cbr-2M", t2("1280x720"), 120, "-b:v 2M -maxrate 2M");
	await enc("gop30", t2("1280x720"), 120, "-b:v 2M -g 30");
	await enc("odd-641x361", t2("641x361"), 60, "-b:v 1M");
	await enc("1080p", t2("1920x1080"), 60, "-b:v 4M");
	await enc("bbb720-1M", "-i /tmp/va/bbb720.webm", 120, "-b:v 1M -g 60");
	// decode to encode: the decoded surfaces go to the encoder as they are (the host encodes its own decoded picture)
	await run("enc-transcode", `ffmpeg -hide_banner -loglevel warning -hwaccel vaapi -hwaccel_output_format vaapi -i /tmp/va/bbb720.webm -frames:v 120 -c:v vp9_vaapi -b:v 2M -y /tmp/enc/transcode.webm && sh /tmp/enc/check.sh /tmp/enc/transcode.webm 120 -i /tmp/va/bbb720.webm`);
	// recovery: encoders reclaimed, failed and flushed mid-stream (a new encoder starts with a key frame)
	await enc("recover", t2("1280x720"), 120, "-b:v 2M", [["reclaim", 7], ["error", 11], ["flush", 13]]);
	// vaPutImage (ffmpeg uploads through derived images): va-encode's 30 frames at 641x361 decode in software
	await run("enc-va-encode-put", `/tmp/va-encode -d ${DRI}/kw_drv_video.so -w 641 -h 361 -n 30 -m put /tmp/enc/put.ivf && ffmpeg -v error -i /tmp/enc/put.ivf -f framemd5 - | grep -c '^0,'`);
	if (skip.has("fps")) return;
	const timed = (cmd) => `s=$(date +%s.%N); ${cmd} 2>&1 | tr '\\r' '\\n' | grep -E 'bench|frame=|va-encode|Error|error' | tail -4; r=\${PIPESTATUS[0]}; e=$(date +%s.%N); awk "BEGIN{print \\"wall \\" ($e - $s)}"; exit $r`;
	for (const [s, n] of [["1280x720", 120], ["1920x1080", 60]]) {
		const [ww, hh] = s.split("x");
		await run(`fps-enc-ffmpeg-${s}`, timed(`ffmpeg -hide_banner -benchmark -vaapi_device /dev/dri/renderD128 ${t2(s)} -frames:v ${n} -vf format=nv12,hwupload -c:v vp9_vaapi -b:v 2M -f null -`));
		await run(`fps-enc-source-${s}`, timed(`ffmpeg -hide_banner -benchmark ${t2(s)} -frames:v ${n} -vf format=nv12 -f null -`));
		for (const m of ["derive", "same"]) await run(`fps-enc-va-encode-${m}-${s}`, timed(`/tmp/va-encode -d ${DRI}/kw_drv_video.so -w ${ww} -h ${hh} -n ${n} -g 30 -b 2000000 -m ${m} /tmp/enc/vae.ivf`));
	}
}

/** run() with VaHost.inject() test hooks on (each [what, every]), cleared after. */
async function injectedRun(vm, run, name, inj, cmd) {
	for (const [what, every] of inj) vm.va.inject(what, { every });
	try {
		return await run(name, cmd);
	} finally {
		vm.va.inject(null);
	}
}
