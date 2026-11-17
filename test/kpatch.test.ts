// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Kernel patches (.agents/js.md, CPU threads): kernel/tools/kwdiff.mjs
// makes them, js/core/kpatch.ts applies them. Synthetic data always; the
// real UP and SMP kernels when given (byte-identical result, remapped and
// not, and the bundle path of bundle.mjs --smp):
//
//   node --test test/kpatch.test.ts
//   KPATCH_UP=up/vmlinux32.wasm KPATCH_SMP=smp/vmlinux32.wasm node --test test/kpatch.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyKernelPatch, kernelPatchInfo, smpKernelFromBundle } from "../js/core/kpatch.ts";
// @ts-expect-error: a build tool in plain JavaScript, without types
import { makePatch } from "../kernel/tools/kwdiff.mjs";
// @ts-expect-error: a build tool in plain JavaScript, without types
import { bundle } from "../kernel/tools/bundle.mjs";

function rand(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
		out[i] = x & 0xff;
	}
	return out;
}

test("byte patch: edits, inserts, deletes and moved blocks round-trip", async () => {
	const base = rand(200_000, 7);
	const parts = [base.subarray(50_000, 90_000), rand(3000, 9), base.subarray(0, 50_000), base.subarray(120_000)];
	const target = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { target.set(p, o); o += p.length; }
	for (let i = 0; i < target.length; i += 997) target[i] = (target[i]! + 3) & 0xff;
	const { patch } = makePatch(base, target);
	assert.ok(patch.length < target.length / 4, `patch ${patch.length} bytes`);
	const info = kernelPatchInfo(patch);
	assert.equal(info.baseLength, base.length);
	assert.equal(info.targetLength, target.length);
	assert.deepEqual(await applyKernelPatch(base, patch), target);
	await assert.rejects(applyKernelPatch(base.subarray(1), patch), /the base is/);
	const wrong = base.slice();
	wrong[5]! ^= 1;
	await assert.rejects(applyKernelPatch(wrong, patch), /not the one/);
});

const up = process.env.KPATCH_UP, smp = process.env.KPATCH_SMP;
test("real kernels: UP -> SMP and SMP -> UP, remapped, byte-identical", { skip: !(up && smp) && "KPATCH_UP and KPATCH_SMP not set" }, async () => {
	const a = new Uint8Array(fs.readFileSync(up!)), b = new Uint8Array(fs.readFileSync(smp!));
	for (const [x, y] of [[a, b], [b, a]] as const) {
		const { patch } = makePatch(x, y, { remap: true });
		assert.ok(kernelPatchInfo(patch).remap);
		assert.ok(Buffer.compare(Buffer.from(await applyKernelPatch(x, patch)), Buffer.from(y)) === 0);
	}
});

test("bundle.mjs --smp: the loader's SMP kernel is the SMP build plus the bundle's sections", { skip: !(up && smp) && "KPATCH_UP and KPATCH_SMP not set" }, async () => {
	const a = fs.readFileSync(up!), b = fs.readFileSync(smp!);
	const initrd = rand(1000, 3);
	const { bytes } = bundle(a, initrd, { cmdline: "console=hvc0", gzip: false, smp: b });
	const out = await smpKernelFromBundle(new Uint8Array(bytes));
	assert.ok(out);
	assert.ok(Buffer.compare(Buffer.from(out.subarray(0, b.length)), b) === 0);
	const m = await WebAssembly.compile(out as Uint8Array<ArrayBuffer>);
	assert.deepEqual(new Uint8Array(WebAssembly.Module.customSections(m, "unkernel.initrd")[0]!), initrd);
	assert.equal(new TextDecoder().decode(WebAssembly.Module.customSections(m, "unkernel.cmdline")[0]!), "console=hvc0");
	assert.equal(WebAssembly.Module.customSections(m, "unkernel.kernel.smp.kwpatch").length, 0);
	assert.ok(WebAssembly.Module.imports(m).some((i) => i.name === "wasm_cpu_start"));
	// No patch: undefined (the loader then uses the bundle as it is).
	assert.equal(await smpKernelFromBundle(new Uint8Array(bundle(a, initrd, { gzip: false }).bytes)), undefined);
});
