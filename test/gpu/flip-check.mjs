#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// node flip-check.mjs BUNDLE [FLIPS] [DIRTY]: boot BUNDLE with virtio-gpu, run
// kms-flip.c in the guest and count the kernel's host idles (each one
// a block in the host, i.e. a wakeup after it) over quiet periods: before any
// client, while kms-dumb holds the CRTC without flipping, and after the
// flipping client has exited.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const W = path.resolve(import.meta.dirname, "../..");
const [bundle, flips = "120", dirty = "0"] = process.argv.slice(2);
const { createKernel, nodeFs } = await import(path.join(W, "js/node.ts"));
const dir = mkdtempSync(path.join(tmpdir(), "kw-flip-"));
for (const [src, out] of [[path.join(W, "test/gpu/kms-flip.c"), "kms-flip"], [path.join(W, "test/gpu/kms-dumb.c"), "kms-dumb"]]) {
	const cc = spawnSync("zig", ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", path.join(dir, out), src], { stdio: "inherit" });
	if (cc.status !== 0) process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vm = await createKernel({
	kernel: bundle, cmdline: process.env.CMDLINE, gpu: true, display: { width: 640, height: 480, dpi: 96 },
	mounts: { "/mnt/gpu": { fs: nodeFs(dir), readOnly: true } }, log: () => {},
});
const sh = async (cmd) => { const r = await vm.exec("sh", ["-c", cmd]); return r.stdout.trimEnd() + (r.stderr ? `\n${r.stderr.trimEnd()}` : ""); };
const quiet = async (label, ms) => {
	const a = vm.stats().idles, t = Date.now();
	await sleep(ms);
	const n = vm.stats().idles - a, s = (Date.now() - t) / 1000;
	console.log(`flip-check: ${label}: ${n} host idles in ${s.toFixed(1)} s (${(n / s).toFixed(1)}/s)`);
};
const series = async (label, secs) => {
	const out = [];
	for (let i = 0; i < secs; i++) { const a = vm.stats().idles; await sleep(1000); out.push(vm.stats().idles - a); }
	console.log(`flip-check: ${label}: host idles per second: ${out.join(" ")}`);
};
try {
	await sh("true");
	await sleep(2000);
	await quiet("quiet, no client", 5000);
	const hold = sh("/mnt/gpu/kms-dumb /dev/dri/card0 12");
	await sleep(1500);
	await quiet("kms-dumb holds the CRTC, first 4 s", 4000);
	await sleep(1500);
	await quiet("kms-dumb holds the CRTC, 7 s and later", 4000);
	await hold;
	await sleep(1000);
	const g0 = vm.stats().gpu;
	console.log(await sh(`/mnt/gpu/kms-flip /dev/dri/card0 ${flips} ${dirty}`));
	const g1 = vm.stats().gpu;
	console.log(`flip-check: device during kms-flip: ${g1.commands - g0.commands} commands, ${g1.transfers - g0.transfers} transfers (${g1.transferBytes - g0.transferBytes} bytes), ${g1.flushes - g0.flushes} flushes`);
	await series("after kms-flip exited", 12);
	const hold2 = sh("/mnt/gpu/kms-dumb /dev/dri/card0 14");
	await series("from kms-dumb's start (holds the CRTC 14 s, no flips)", 12);
	await hold2;
	await series("after kms-dumb exited", 8);
} finally {
	await vm.close?.();
	process.exit(0);
}
