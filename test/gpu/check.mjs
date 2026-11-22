#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Checks the guest's virtio-gpu device (kwvirtio, js/core/virtio-gpu.ts)
// end to end under Node: boots the base shell with createKernel({ gpu: true,
// display: WxH }), mounts a host directory with test/gpu/kms-dumb.c built
// for the guest (zig cc, static aarch64 musl), and runs it. It checks
//  - /dev/dri/card0 and renderD128 exist and the driver is virtio_gpu
//    (DRM_IOCTL_VERSION, what drmGetVersion() asks);
//  - the connector's first mode is the display size, with the physical
//    size of --dpi (the EDID);
//  - while the program holds the CRTC, the host's frame (vm.frame(), the
//    scanout's host copy) is glimmer's test pattern with a white 64x64
//    square at (16, 16) that it painted after the modeset, pixel for pixel
//    (the square arrives with the DIRTYFB transfer);
//  - a snapshot is refused then (the device holds resources), and taken
//    once the program has exited and the display is back to kwfb (no frame);
//  - a display size change (vm.updateDisplaySize()) reaches a running KMS
//    client, test/gpu/kms-hotplug.c: it reads a drm uevent with HOTPLUG=1
//    from netlink (no udev) and probes the new preferred mode, an odd size
//    as it is; while it keeps its old mode the host's display and frame
//    stay at that mode (they follow what the guest sets), and when it sets
//    the new one the frame is the pattern at the new size. The device
//    raises nothing for an unchanged size, and a size it cannot offer is
//    fitted (fitGpuSize(): 64..4095 a side, the EDID's pixel clock);
//  - the same in worker mode (WorkerKernel.updateDisplaySize()): the client
//    hears the hotplug and sets the new mode, and the display and the
//    frames the worker sends follow it;
//  - the restored snapshot runs the program again with the same results,
//    at the size the restoring machine offers (--restore-size, default
//    720x400: the restore offers it with a display event).
//
//   node test/gpu/check.mjs [--kernel BUNDLE] [--size WxH] [--restore-size WxH] [--dpi N] [--cpus N [--pin CPU]] [--keep]
//
// --pin runs the program on that CPU (sched_setaffinity), so that on an SMP kernel
// its notifications go through CPU 0's interrupt (kwvirtio on SMP).
//
// Exit status 0 when everything matches.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const [W, H] = (opt("size") ?? "640x480").split("x").map(Number);
const [RW, RH] = (opt("restore-size") ?? "720x400").split("x").map(Number);
const dpi = Number(opt("dpi") ?? 96);
const { createKernel, nodeFs } = await import(path.join(root, "js/node.ts"));
const { fitGpuSize } = await import(path.join(root, "js/core/virtio-gpu.ts"));

/** guest/src/glimmer.c test_pixel() (0xRRGGBB). */
function testPixel(x, y, w, h) {
	const bars = [0xffffff, 0xffff00, 0x00ffff, 0x00ff00, 0xff00ff, 0xff0000, 0x0000ff, 0x000000];
	const div = (a, b) => Math.floor(a / b);
	if (x >= w || y >= h) return 0;
	if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return 0xffffff;
	if (x < 9 && y < 9) return 0xff0000;
	if (x >= w - 9 && y < 9) return 0x00ff00;
	if (x < 9 && y >= h - 9) return 0x0000ff;
	if (x >= w - 9 && y >= h - 9) return 0xffff00;
	if (y < div(h, 4)) return bars[div(x * 8, w)];
	if (y < div(h, 2)) return div(x * 255, w - 1) * 0x010101;
	if (y < div(h * 3, 4)) return (div(x, 8) + div(y, 8)) & 1 ? 0xff8000 : 0x000040;
	const v = div(y * 255, h - 1);
	return (v << 8) | (255 - v);
}
const expected = (x, y, w, h, square = true) => (square && x >= 16 && x < 80 && y >= 16 && y < 80 ? 0xffffff : testPixel(x, y, w, h));

/** Compare a frame with the pattern at w x h (with kms-dumb's square, or without): "" or what differs. */
function frameDiff(frame, w, h, square = true) {
	if (!frame) return "no frame";
	if (frame.width !== w || frame.height !== h) return `frame ${frame.width}x${frame.height}, want ${w}x${h}`;
	let bad = 0, first = "";
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = (y * w + x) * 4;
		const got = (frame.data[i] << 16) | (frame.data[i + 1] << 8) | frame.data[i + 2];
		if (got !== expected(x, y, w, h, square) && !bad++) first = `(${x}, ${y}) 0x${got.toString(16)} want 0x${expected(x, y, w, h, square).toString(16)}`;
	}
	return bad ? `${bad} pixels differ, first ${first}` : "";
}

const problems = [];
const fail = (msg) => {
	problems.push(msg);
	process.stdout.write(`gpu-check: FAIL ${msg}\n`);
};
const note = (msg) => process.stdout.write(`gpu-check: ${msg}\n`);

const dir = mkdtempSync(path.join(tmpdir(), "kw-gpu-check-"));
const zig = process.env.ZIG ?? "zig";
for (const name of ["kms-dumb", "kms-hotplug"]) {
	const bin = path.join(dir, name);
	const cc = spawnSync(zig, ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", bin, path.join(root, `test/gpu/${name}.c`)], { stdio: "inherit" });
	if (cc.status !== 0) {
		process.stdout.write(`gpu-check: FAIL building ${name}\n`);
		process.exit(1);
	}
	chmodSync(bin, 0o755);
}

const log = [];
const boot = (restore, w = W, h = H) => createKernel({
	kernel: opt("kernel"), cpus: opt("cpus") ? Number(opt("cpus")) : undefined,
	gpu: true, display: { width: w, height: h, dpi },
	mounts: { "/mnt/gpu": { fs: nodeFs(dir), readOnly: true } },
	restore,
	log: (m) => log.push(m),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run kms-dumb on `vm` and check its lines, the frame while it holds the CRTC, a refused snapshot then, and the state after. */
async function draw(vm, label, W, H) {
	const sh = (cmd) => vm.exec("sh", ["-c", cmd]);
	const run = sh(`/mnt/gpu/kms-dumb /dev/dri/card0 4${opt("pin") !== undefined ? ` ${Number(opt("pin"))}` : ""}`);
	// Wait for the picture: the modeset's flush and the DIRTYFB one.
	const gpu = vm.kernel.gpu;
	const flushes = gpu.stats.flushes;
	let frame = null;
	for (let t = 0; t < 600 && !frame; t++) {
		await sleep(50);
		if (gpu.stats.flushes >= flushes + 2 && vm.display?.mode) frame = vm.frame();
	}
	let refused = "";
	if (frame) {
		try {
			await vm.snapshot();
			fail(`${label}: a snapshot was taken while the device held resources`);
		} catch (e) {
			refused = e.message;
		}
	}
	const r = await run;
	note(`${label}: kms-dumb (exit ${r.exitCode}):\n${r.stdout.trimEnd()}`);
	if (r.exitCode !== 0) fail(`${label}: kms-dumb exited ${r.exitCode}${r.stderr ? `: ${r.stderr}` : ""}`);
	if (!/driver virtio_gpu /.test(r.stdout)) fail(`${label}: the driver is not virtio_gpu`);
	const m = /first (\S+) \((\d+)x(\d+)\), (\d+)x(\d+) mm/.exec(r.stdout);
	if (!m || Number(m[2]) !== W || Number(m[3]) !== H) fail(`${label}: first mode ${m?.[1]}, want ${W}x${H}`);
	const mm = (px) => Math.round((px * 25.4) / dpi);
	if (m && (Math.abs(Number(m[4]) - mm(W)) > 10 || Math.abs(Number(m[5]) - mm(H)) > 10))
		fail(`${label}: physical size ${m[4]}x${m[5]} mm, want about ${mm(W)}x${mm(H)} (EDID, ${dpi} dpi; cm precision)`);

	if (!frame) fail(`${label}: no frame (flushes ${gpu.stats.flushes}, mode ${JSON.stringify(vm.display?.mode)})`);
	else {
		const diff = frameDiff(frame, W, H);
		if (diff) fail(`${label}: ${diff}`);
		else note(`${label}: frame ${W}x${H} matches the pattern and the square`);
	}
	if (frame && !/virtio-gpu resources/.test(refused)) fail(`${label}: snapshot while held: ${refused || "no error"}, want a refusal over virtio-gpu resources`);
	else if (frame) note(`${label}: snapshot while held refused: ${refused}`);

	// After the exit: the framebuffer is gone, the scanout off, the display kwfb's (closed: no frame).
	for (let t = 0; t < 40 && (gpu.resourceCount || vm.display?.mode); t++) await sleep(50);
	if (gpu.resourceCount) fail(`${label}: ${gpu.resourceCount} resources left after the exit`);
	if (vm.frame()) fail(`${label}: a frame after the exit (the scanout should be off and /dev/fb0 closed)`);
	const st = vm.stats().gpu;
	note(`${label}: device: ${st.commands} commands, ${st.errors} errors, ${st.transfers} transfers (${st.transferBytes} bytes), ${st.flushes} flushes, ${st.cursor} cursor`);
	if (st.errors) fail(`${label}: ${st.errors} command errors`);
}

/** Lines of a guest program's stdout as they come; next(re) waits for a line that matches. */
function lines(stream) {
	const seen = [];
	let buf = "", wake = () => {};
	void (async () => {
		const dec = new TextDecoder();
		for await (const b of stream) {
			buf += dec.decode(b, { stream: true });
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				seen.push(buf.slice(0, i));
				buf = buf.slice(i + 1);
			}
			wake();
		}
	})().catch(() => {}).finally(() => { seen.push(null); wake(); });
	let at = 0;
	return {
		seen,
		async next(re, ms = 30000) {
			const end = Date.now() + ms;
			for (;;) {
				while (at < seen.length) {
					const l = seen[at++];
					if (l === null) return null;
					const m = re.exec(l);
					if (m) return m;
				}
				if (Date.now() > end) return null;
				await Promise.race([new Promise((r) => (wake = r)), sleep(200)]);
			}
		},
	};
}

/** Wait until the host's display shows a w x h mode, then the frame. */
async function frameAt(vm, w, h) {
	for (let t = 0; t < 200; t++) {
		const m = vm.display?.mode;
		if (m && m.width === w && m.height === h) return vm.frame();
		await sleep(50);
	}
	return null;
}

/**
 * Display size changes on a running machine (vm.updateDisplaySize()): a
 * running KMS client hears the hotplug and finds the new preferred mode;
 * the host follows the mode the client sets, not the size asked for.
 */
async function hotplug(vm) {
	const gpu = vm.kernel.gpu;
	const label = "hotplug";
	const [A, B] = [{ width: 801, height: 601, dpi }, { width: 1024, height: 768, dpi }];
	if (gpu.displayChanged()) fail(`${label}: a display event for an unchanged size`);
	const p = await vm.spawn("/mnt/gpu/kms-hotplug", ["/dev/dri/card0", "60", "rs", "2"], { pty: false });
	p.stderr.cancel();
	const out = lines(p.stdout);
	const ready = await out.next(/ready (\d+)x(\d+)/);
	if (!ready || Number(ready[1]) !== W || Number(ready[2]) !== H) fail(`${label}: kms-hotplug ready ${ready?.[0]}, want ${W}x${H}`);
	const f0 = await frameAt(vm, W, H);
	let diff = frameDiff(f0, W, H, false);
	if (diff) fail(`${label}: before: ${diff}`);

	// An odd size: the client probes it as it is, keeps its mode, and so does the host.
	vm.updateDisplaySize(A);
	const h1 = await out.next(/hotplug 1: preferred (\d+)x(\d+), (\d+) modes, (\d+)x(\d+) mm/);
	if (!h1 || Number(h1[1]) !== A.width || Number(h1[2]) !== A.height) fail(`${label}: hotplug 1: ${h1?.[0]}, want preferred ${A.width}x${A.height}`);
	else note(`${label}: ${h1[0]}`);
	if (gpu.displaySize?.width !== A.width) fail(`${label}: the driver read ${JSON.stringify(gpu.displaySize)}`);
	await sleep(300);
	const m1 = vm.display?.mode;
	if (!m1 || m1.width !== W || m1.height !== H) fail(`${label}: the display is ${m1 && `${m1.width}x${m1.height}`} while the client keeps ${W}x${H}`);
	diff = frameDiff(vm.frame(), W, H, false);
	if (diff) fail(`${label}: after hotplug 1 (mode kept): ${diff}`);
	else note(`${label}: the host still shows the client's ${W}x${H} after the size changed to ${A.width}x${A.height}`);

	// Another size, which the client sets: the host follows.
	vm.updateDisplaySize(B);
	const set = await out.next(/set (\d+)x(\d+)/);
	if (!set || Number(set[1]) !== B.width || Number(set[2]) !== B.height) fail(`${label}: set ${set?.[0]}, want ${B.width}x${B.height}`);
	const f2 = await frameAt(vm, B.width, B.height);
	diff = frameDiff(f2, B.width, B.height, false);
	if (diff) fail(`${label}: after the client set ${B.width}x${B.height}: ${diff}`);
	else note(`${label}: the client set ${B.width}x${B.height} and the frame is its pattern at that size`);
	const done = await out.next(/done|FAILED/);
	const end = await p.ended;
	const text = out.seen.filter((l) => l !== null).join("\n");
	if (!done || done[0] !== "done" || end.type !== "exit" || end.code !== 0) fail(`${label}: kms-hotplug ended ${JSON.stringify(end)}:\n${text}`);
	else note(`${label}: kms-hotplug:\n${text}`);

	// Sizes the device fits: a client started afterwards finds them.
	for (const want of [{ width: 10000, height: 40 }, { width: 5000, height: 3000 }, { width: 2560, height: 1440 }]) {
		const fit = fitGpuSize(want);
		vm.updateDisplaySize({ ...want, dpi });
		for (let t = 0; t < 100 && gpu.displaySize?.width !== fit.width; t++) await sleep(50);
		const r = await vm.exec("/mnt/gpu/kms-hotplug", ["/dev/dri/card0", "30", ""]);
		const m = /ready (\d+)x(\d+)/.exec(r.stdout);
		if (r.exitCode !== 0 || !m || Number(m[1]) !== fit.width || Number(m[2]) !== fit.height)
			fail(`${label}: ${want.width}x${want.height}: ${r.stdout.trim()} (exit ${r.exitCode}), want ${fit.width}x${fit.height}`);
		else note(`${label}: ${want.width}x${want.height} offered as ${m[1]}x${m[2]}`);
	}
	vm.updateDisplaySize({ width: W, height: H, dpi });
	for (let t = 0; t < 100 && gpu.displaySize?.width !== W; t++) await sleep(50);
	for (let t = 0; t < 40 && (gpu.resourceCount || vm.display?.mode); t++) await sleep(50);
	const st = vm.stats().gpu;
	if (st.errors) fail(`${label}: ${st.errors} command errors`);
}

/** Worker mode: updateDisplaySize() reaches the worker's device, and the display follows the client's mode. */
async function workerHotplug() {
	const label = "worker hotplug";
	const C = { width: 960, height: 540, dpi };
	const wv = await createKernel({
		kernel: opt("kernel"), cpus: opt("cpus") ? Number(opt("cpus")) : undefined, worker: true,
		gpu: true, display: { width: W, height: H, dpi },
		mounts: { "/mnt/gpu": { fs: nodeFs(dir), readOnly: true } },
		log: (m) => log.push(m),
	});
	try {
		const p = await wv.spawn("/mnt/gpu/kms-hotplug", ["/dev/dri/card0", "60", "s", "2"], { pty: false });
		p.stderr.cancel();
		const out = lines(p.stdout);
		const ready = await out.next(/ready (\d+)x(\d+)/);
		if (!ready || Number(ready[1]) !== W || Number(ready[2]) !== H) fail(`${label}: ready ${ready?.[0]}, want ${W}x${H}`);
		wv.updateDisplaySize(C);
		const set = await out.next(/set (\d+)x(\d+)/);
		if (!set || Number(set[1]) !== C.width || Number(set[2]) !== C.height) fail(`${label}: set ${set?.[0]}, want ${C.width}x${C.height}`);
		let f = null;
		for (let t = 0; t < 100 && !f; t++) {
			const m = wv.display?.mode;
			if (m?.width === C.width && m.height === C.height) f = await wv.readFrame();
			else await sleep(50);
		}
		const diff = frameDiff(f, C.width, C.height, false);
		if (diff) fail(`${label}: ${diff}`);
		else note(`${label}: the client set ${C.width}x${C.height}; the worker's frame is its pattern at that size`);
		const end = await p.ended;
		if (end.type !== "exit" || end.code !== 0) fail(`${label}: kms-hotplug ended ${JSON.stringify(end)}:\n${out.seen.filter((l) => l !== null).join("\n")}`);
	} finally {
		await wv.stop();
	}
}

let vm, vm2;
try {
	vm = await boot();
	const devs = await vm.exec("sh", ["-c", "ls /dev/dri; cat /sys/class/drm/card0/device/uevent 2>/dev/null | head -3; dmesg | grep -i -E 'kwvirtio|virtio_gpu|\\[drm\\]' | head -20"]);
	note(`guest:\n${devs.stdout.trimEnd()}`);
	if (!/card0/.test(devs.stdout) || !/renderD128/.test(devs.stdout)) fail("/dev/dri/card0 or renderD128 missing");
	await draw(vm, "boot", W, H);
	await hotplug(vm);
	await workerHotplug();
	// The device is idle again: a snapshot is taken, and its restore drives the device as before.
	let snap;
	try {
		snap = await vm.snapshot({ stop: true });
		note(`snapshot after the exit: ${(snap.memory.length / 1048576).toFixed(0)} MiB, devices ${Object.keys(snap.devices).join(", ")}`);
		if (!snap.devices.gpu) fail("the snapshot has no gpu state");
	} catch (e) {
		fail(`snapshot after the exit: ${e.message}`);
	}
	if (snap) {
		vm2 = await boot(snap, RW, RH);
		await draw(vm2, `restored at ${RW}x${RH}`, RW, RH);
	}
} catch (e) {
	fail(e.stack ?? String(e));
} finally {
	vm?.stop();
	vm2?.stop();
	if (!args.includes("--keep")) rmSync(dir, { recursive: true, force: true });
	else note(`kept ${dir}`);
}
if (problems.length) process.stdout.write(`gpu-check: host log:\n${log.join("\n")}\n`);
process.stdout.write(problems.length ? `gpu-check: ${problems.length} problem(s)\n` : "gpu-check: ok\n");
process.exit(problems.length ? 1 : 0);
