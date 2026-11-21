// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page of `unkernel-check.mjs --drm`: boots unkernel from the built
// package (/dist/web.mjs) with a kernel that has kwvirtio (/img/unkernel.wasm),
// the Debian image and the prepared data disk, and createKernel({ gl: true,
// gpu: true }): the guest's virtio-gpu has 3D on the page's renderer. It
// shows the display as the page does (a canvas the size of the mode,
// repainted per animation frame: GlHost.gpu.drawFrame() while a GL client
// has the scanout, frame() otherwise), runs the steps in the guest with no
// GL environment variables and posts what they printed; the harness judges.
// Query: size=WxH (the display), scenes= (glmark2 -b list), skip=a,b,c,d,e,
// cmd= (a command run first, as root; for debugging).
import { createKernel } from "/dist/web.mjs";

const q = new URLSearchParams(location.search);
const skip = new Set((q.get("skip") || "").split(",").filter(Boolean));
const size = q.get("size") || "640x480";
const [W, H] = size.split("x").map(Number);
const scenes = (q.get("scenes") || "build:duration=5,texture:duration=5,shading:shading=phong:duration=5").split(",");
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
addEventListener("error", (e) => log(`error: ${e.message}`));
addEventListener("unhandledrejection", (e) => log(`error: ${e.reason?.stack || e.reason}`));

const VIRPIPE = "GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1";
const VARIANTS = "tex stencil raster plain query mip dual";
// kmscube and glmark2-drm stop at the first byte (or EOF) on stdin: give them
// a FIFO this shell holds open, fd 3 (no /dev/fd here for <(...))
const HOLD = "rm -f /tmp/hold.$$ && mkfifo /tmp/hold.$$ && exec 3<>/tmp/hold.$$ &&";
// glmark2-es2-drm (2023.01) always draws at the mode's size, and with -s of
// that very size (or --fullscreen) it never makes its window (a size check
// in CanvasGeneric::resize_no_viewport()): give it none, so the default
// 800x600 differs from the mode and it makes the mode's. And an XRGB8888
// config: its first pick is RGB565, which drmModeAddFB(24, 32) refuses.
const DRM_GLMARK = "--visual-config red=8:green=8:blue=8:alpha=0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The display as the page shows it: the scanout's frames drawn from the renderer (no readback), else frame(). */
function display(vm) {
	const canvas = document.getElementById("fb");
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const st = { painted: 0, glPainted: 0 };
	const paint = () => {
		const m = vm.display?.mode;
		if (m && (canvas.width !== m.width || canvas.height !== m.height)) {
			canvas.width = m.width;
			canvas.height = m.height;
		}
		const drew = vm.gl?.gpu?.drawFrame(ctx, false);
		if (drew) st.glPainted++;
		else if (drew === null && m) {
			const f = vm.frame();
			if (f) {
				ctx.putImageData(new ImageData(f.data, f.width), 0, 0);
				st.painted++;
			}
		}
		requestAnimationFrame(paint);
	};
	requestAnimationFrame(paint);
	return { canvas, ctx, st };
}

/** A checksum of RGBA pixels and how many distinct colours (of the first 4096 seen). */
function summary(data) {
	let sum = 0;
	const colours = new Set();
	for (let i = 0; i < data.length; i += 4) {
		const p = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
		sum = (Math.imul(sum, 31) + p) >>> 0;
		if (colours.size < 4096) colours.add(p);
	}
	return { checksum: sum.toString(16), colours: colours.size };
}

async function main() {
	const result = { size, scenes, steps: {}, frames: [] };
	const vm = await createKernel({
		kernel: "/img/unkernel.wasm",
		distro: "/img/debian.erofs",
		disks: [{ kind: "http", url: "/img/debian-gl.img" }],
		gl: true,
		gpu: true,
		display: { width: W, height: H, dpi: 96 },
		worker: q.has("worker"),
		memoryMiB: 1024,
		log,
	});
	vm.onOutput((b) => (consoleBuf += new TextDecoder().decode(b)));
	const shown = display(vm);
	log(`booted (transport ${vm.transport})`);
	result.renderer = await vm.gl.ready;
	result.readyS = Number(secs());
	log(`gl ready: ${result.renderer}`);

	const run = async (name, cmd, opts = {}) => {
		log(`run ${name}: ${cmd}`);
		const t = performance.now();
		const r = await vm.exec("bash", ["-c", cmd], { timeout: 1800_000, user: "root", ...opts });
		const s = { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Math.round(performance.now() - t) };
		log(`${name}: exit ${r.exitCode ?? r.signal} after ${(s.ms / 1000).toFixed(1)} s`);
		result.steps[name] = s;
		return s;
	};

	// the test programs, in /tmp
	for (const name of ["kwgl-state", "prime"]) {
		const bin = new Uint8Array(await (await fetch(`/files/${name}`)).arrayBuffer());
		await vm.exec("sh", ["-c", `cat >/tmp/${name} && chmod 755 /tmp/${name}`], { input: bin });
	}

	// cmd=: a command of the caller's first (debugging), its output as the step "cmd"
	if (q.get("cmd")) await run("cmd", q.get("cmd"));

	// (a) what Mesa finds on /dev/dri with no GL variables
	if (!skip.has("a")) {
		await run("drm", "ls -l /dev/dri; cat /sys/kernel/debug/dri/0/name 2>/dev/null; readlink -f /sys/class/drm/renderD128/device; cat /sys/class/drm/renderD128/device/uevent");
		await run("eglinfo-gbm", "eglinfo -B -p gbm 2>&1");
		await run("eglinfo-surfaceless", "eglinfo -B -p surfaceless 2>&1");
		// libdrm's drmGetDevices2(), which Mesa's loader and EGL's device enumeration use
		await run("drmdevice", "command -v drmdevice >/dev/null && drmdevice 2>&1 | head -60");
	}

	// (b) a KMS client page-flipping GBM buffers: its frames on this page's canvas
	if (!skip.has("b")) {
		const gpu = vm.gl.gpu;
		const before = { ...gpu.stats };
		const kms = run("kmscube", `${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 600 2>&1 <&3`);
		// Sample the canvas while it runs: the presented frame (drawn from the
		// renderer's ImageBitmap) against the scanout read back in the same task.
		for (let i = 0; i < 600 && result.frames.length < 3; i++) {
			await sleep(100);
			const s = gpu.scanout;
			if (!s || s.seq < 30 + result.frames.length * 60) continue;
			const drew = gpu.drawFrame(shown.ctx, true);
			const img = shown.ctx.getImageData(0, 0, s.width, s.height);
			const back = vm.frame();
			let diff = 0;
			for (let p = 0; back && p < img.data.length; p += 4)
				if (img.data[p] !== back.data[p] || img.data[p + 1] !== back.data[p + 1] || img.data[p + 2] !== back.data[p + 2]) diff++;
			const px = (x, y) => Array.from(img.data.slice((y * s.width + x) * 4, (y * s.width + x) * 4 + 3));
			result.frames.push({ seq: s.seq, size: `${s.width}x${s.height}`, drew, canvas: `${shown.canvas.width}x${shown.canvas.height}`,
				...summary(img.data), readback: back ? summary(back.data).checksum : null, differFromReadback: back ? diff : -1,
				center: px(s.width >> 1, s.height >> 1), corner: px(2, 2) });
			if (result.frames.length === 1) {
				// the frame as PPM, for a look
				const ppm = new Uint8Array(img.data.length / 4 * 3);
				for (let p = 0, o = 0; p < img.data.length; p += 4) ppm[o++] = img.data[p], ppm[o++] = img.data[p + 1], ppm[o++] = img.data[p + 2];
				const head = new TextEncoder().encode(`P6\n${s.width} ${s.height}\n255\n`);
				await post("/file/kmscube.ppm", new Blob([head, ppm]));
			}
		}
		await kms;
		const after = gpu.stats;
		result.kmsStats = { presents: after.presents - before.presents, fenced: after.fenced - before.fenced, parks: after.parks - before.parks,
			parkedMs: Math.round(after.parkedMs - before.parkedMs), pagePainted: shown.st.glPainted };
	}

	// (c) glmark2-es2 on KMS (the DRM path) against glmark2-es2 under Xvfb on
	// virpipe (the vtest path), the same scenes at the display's size: on
	// screen (DRM: page flips, paced by virtio-gpu's 60 Hz vblank timer;
	// vtest: each frame read back and put to Xvfb) and off screen (the
	// renderer's rate through each transport, nothing presented)
	if (!skip.has("c")) {
		const bs = scenes.map((s) => `-b ${s}`).join(" ");
		const xvfb = (args) => `${VIRPIPE} timeout 1500 xvfb-run -a -s "-screen 0 ${W}x${H}x24" glmark2-es2 -s ${size} ${args} ${bs} 2>&1`;
		await run("glmark2-drm", `${HOLD} timeout 1500 glmark2-es2-drm ${DRM_GLMARK} ${bs} 2>&1 <&3`);
		await run("glmark2-vtest", xvfb(""));
		await run("glmark2-drm-offscreen", `${HOLD} timeout 1500 glmark2-es2-drm --off-screen ${DRM_GLMARK} ${bs} 2>&1 <&3`);
		await run("glmark2-vtest-offscreen", xvfb("--off-screen"));
	}

	// (d) kwgl-state's clients interleaved on the DRM path against each alone,
	// and against the same clients on the vtest path (the same renderer)
	if (!skip.has("d")) {
		await run("state-alone", `for v in ${VARIANTS}; do timeout 600 /tmp/kwgl-state -t 8 $v; done | sort`);
		await run("state", `timeout 900 /tmp/kwgl-state -t 8 ${VARIANTS} | sort`);
		await run("state-vtest", `${VIRPIPE} timeout 900 /tmp/kwgl-state -t 8 ${VARIANTS} | sort`);
	}

	// (e) PRIME: a resource exported as a dmabuf by one opener and imported
	// by another names the same host resource, whose texture host code finds
	if (!skip.has("e")) {
		const p = await vm.spawn("/tmp/prime", ["/dev/dri/renderD128", "4"], { user: "user", pty: false });
		const errText = new Response(p.stderr).text();
		let text = "";
		const dec = new TextDecoder();
		const reader = p.stdout.getReader();
		let res = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += dec.decode(value);
			const m = /^res (\d+)$/m.exec(text);
			if (m && !res) {
				res = Number(m[1]);
				const t = vm.gl.gpu.texture(res);
				let pixel = null;
				if (t?.texture) {
					// read the texture in the renderer's context (a check only; host code would sample it)
					const gl = t.gl, fb = gl.createFramebuffer();
					gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
					gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
					const out = new Uint8Array(4);
					// pixel (40, 8) of the picture: x 40 * 4 = 160 red, y 8 * 4 = 32 green, blue 0xc0;
					// the texture's row k is the picture's row k, or with yTop its row height - 1 - k
					gl.readPixels(40, t.yTop ? t.height - 1 - 8 : 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
					gl.bindFramebuffer(gl.FRAMEBUFFER, null);
					gl.deleteFramebuffer(fb);
					pixel = Array.from(out.slice(0, 3));
				}
				result.prime = { res, texture: !!t?.texture, width: t?.width, height: t?.height, format: t?.format, yTop: t?.yTop, pixel };
			}
		}
		const r = await p.ended;
		result.steps.prime = { exitCode: r.type === "exit" ? r.code : null, end: r, stdout: text, stderr: await errText, ms: 0 };
		log(`prime: ${JSON.stringify(r)}, ${JSON.stringify(result.prime)}`);
	}

	result.gl = vm.gl.stats;
	result.display = { painted: shown.st.painted, glPainted: shown.st.glPainted };
	result.totalS = Number(secs());
	await post("/result", JSON.stringify(result));
	log("done");
	await vm.stop();
}

main().catch(async (e) => {
	log(`error: ${e?.stack || e}`);
	await post("/result", JSON.stringify({ error: String(e?.stack || e) }));
});
