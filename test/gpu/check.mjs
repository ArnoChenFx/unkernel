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
//  - the restored snapshot runs the program again with the same results.
//
//   node test/gpu/check.mjs [--kernel BUNDLE] [--size WxH] [--dpi N] [--cpus N [--pin CPU]] [--keep]
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
const dpi = Number(opt("dpi") ?? 96);
const { createKernel, nodeFs } = await import(path.join(root, "js/node.ts"));

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
const expected = (x, y) => (x >= 16 && x < 80 && y >= 16 && y < 80 ? 0xffffff : testPixel(x, y, W, H));

const problems = [];
const fail = (msg) => {
	problems.push(msg);
	process.stdout.write(`gpu-check: FAIL ${msg}\n`);
};
const note = (msg) => process.stdout.write(`gpu-check: ${msg}\n`);

const dir = mkdtempSync(path.join(tmpdir(), "kw-gpu-check-"));
const bin = path.join(dir, "kms-dumb");
const zig = process.env.ZIG ?? "zig";
const cc = spawnSync(zig, ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", bin, path.join(root, "test/gpu/kms-dumb.c")], { stdio: "inherit" });
if (cc.status !== 0) {
	process.stdout.write("gpu-check: FAIL building kms-dumb\n");
	process.exit(1);
}
chmodSync(bin, 0o755);

const log = [];
const boot = (restore) => createKernel({
	kernel: opt("kernel"), cpus: opt("cpus") ? Number(opt("cpus")) : undefined,
	gpu: true, display: { width: W, height: H, dpi },
	mounts: { "/mnt/gpu": { fs: nodeFs(dir), readOnly: true } },
	restore,
	log: (m) => log.push(m),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run kms-dumb on `vm` and check its lines, the frame while it holds the CRTC, a refused snapshot then, and the state after. */
async function draw(vm, label) {
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
	else if (frame.width !== W || frame.height !== H) fail(`${label}: frame ${frame.width}x${frame.height}, want ${W}x${H}`);
	else {
		let bad = 0, first = "", sum = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const got = (frame.data[i] << 16) | (frame.data[i + 1] << 8) | frame.data[i + 2];
			sum = (sum * 31 + got) >>> 0;
			if (got !== expected(x, y) && !bad++) first = `(${x}, ${y}) 0x${got.toString(16)} want 0x${expected(x, y).toString(16)}`;
		}
		if (bad) fail(`${label}: ${bad} pixels differ, first ${first}`);
		else note(`${label}: frame ${W}x${H} matches the pattern and the square (checksum ${sum.toString(16)}; ` +
			`pixels (0,0) 0x${expected(0, 0).toString(16)}, (20,20) 0x${expected(20, 20).toString(16)}, (${W >> 1},${H >> 1}) 0x${expected(W >> 1, H >> 1).toString(16)})`);
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

let vm, vm2;
try {
	vm = await boot();
	const devs = await vm.exec("sh", ["-c", "ls /dev/dri; cat /sys/class/drm/card0/device/uevent 2>/dev/null | head -3; dmesg | grep -i -E 'kwvirtio|virtio_gpu|\\[drm\\]' | head -20"]);
	note(`guest:\n${devs.stdout.trimEnd()}`);
	if (!/card0/.test(devs.stdout) || !/renderD128/.test(devs.stdout)) fail("/dev/dri/card0 or renderD128 missing");
	await draw(vm, "boot");
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
		vm2 = await boot(snap);
		await draw(vm2, "restored");
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
