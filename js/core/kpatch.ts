// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Apply a kernel patch made by kernel/tools/kwdiff.mjs (a prototype for
// shipping the UP and SMP kernels in one bundle, .agents/status.md item 8).
// Universal: no Node or DOM APIs; the hash check uses crypto.subtle where
// there is one.

import { applyRemap, decodeRemap, moduleSections } from "./kremap.ts";

/** The custom section of a bundle (kernel/tools/bundle.mjs --smp) with the patch from its kernel to the SMP kernel. */
export const SMP_PATCH_SECTION = "unkernel.kernel.smp.kwpatch";

/** The patch's header: what it needs and what it makes. */
export interface KernelPatchInfo {
	remap: boolean;
	baseLength: number;
	targetLength: number;
	baseSha256: Uint8Array;
	targetSha256: Uint8Array;
}

export class Reader {
	p = 0;
	readonly u8: Uint8Array;
	constructor(u8: Uint8Array) {
		this.u8 = u8;
	}
	uleb(): number {
		let v = 0, s = 1, c: number;
		do {
			if (this.p >= this.u8.length) throw new Error("kernel patch: truncated");
			c = this.u8[this.p++]!;
			v += (c & 0x7f) * s;
			s *= 128;
		} while (c & 0x80);
		return v;
	}
	zig(): number {
		const v = this.uleb();
		return v % 2 ? -(v + 1) / 2 : v / 2;
	}
	take(n: number): Uint8Array {
		if (this.p + n > this.u8.length) throw new Error("kernel patch: truncated");
		const r = this.u8.subarray(this.p, this.p + n);
		this.p += n;
		return r;
	}
}

function header(r: Reader): KernelPatchInfo {
	const magic = r.take(4);
	if (magic[0] !== 0x4b || magic[1] !== 0x57 || magic[2] !== 0x50 || magic[3] !== 0x31) throw new Error("kernel patch: not a KWP1 patch");
	const flags = r.uleb();
	return { remap: !!(flags & 1), baseLength: r.uleb(), targetLength: r.uleb(), baseSha256: r.take(32), targetSha256: r.take(32) };
}

export function kernelPatchInfo(patch: Uint8Array): KernelPatchInfo {
	return header(new Reader(patch));
}

/**
 * The target module's bytes from the base module's and the patch. Throws if
 * the base has the wrong length; `verify` (default true) also compares
 * SHA-256 hashes of the base and the result where crypto.subtle exists.
 */
export async function applyKernelPatch(base: Uint8Array, patch: Uint8Array, { verify = true } = {}): Promise<Uint8Array> {
	const r = new Reader(patch);
	const h = header(r);
	if (base.length !== h.baseLength) throw new Error(`kernel patch: the base is ${base.length} bytes, the patch wants ${h.baseLength}`);
	const subtle = verify ? globalThis.crypto?.subtle : undefined;
	if (subtle && !equal(new Uint8Array(await subtle.digest("SHA-256", base as Uint8Array<ArrayBuffer>)), h.baseSha256))
		throw new Error("kernel patch: the base module is not the one the patch was made for");
	let src = base;
	if (h.remap) src = applyRemap(base, decodeRemap(r));
	const n = r.uleb();
	const ctrl = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		ctrl[i * 3] = r.uleb();
		ctrl[i * 3 + 1] = r.uleb();
		ctrl[i * 3 + 2] = r.zig();
	}
	let addTotal = 0;
	for (let i = 0; i < n; i++) addTotal += ctrl[i * 3]!;
	const diff = new Uint8Array(addTotal);
	for (let i = 0; i < addTotal;) {
		i += r.uleb(); // zeros
		const lit = r.uleb();
		if (i + lit > addTotal) throw new Error("kernel patch: corrupt difference bytes");
		diff.set(r.take(lit), i);
		i += lit;
	}
	const extra = r.u8.subarray(r.p);
	const out = new Uint8Array(h.targetLength);
	let o = 0, op = 0, dp = 0, ep = 0;
	for (let i = 0; i < n; i++) {
		const add = ctrl[i * 3]!, copy = ctrl[i * 3 + 1]!, seek = ctrl[i * 3 + 2]!;
		if (o + add + copy > out.length || op < 0 || op + add > src.length) throw new Error("kernel patch: corrupt control");
		for (let k = 0; k < add; k++) out[o + k] = src[op + k]! + diff[dp + k]!;
		o += add; op += add; dp += add;
		out.set(extra.subarray(ep, ep + copy), o);
		o += copy; ep += copy;
		op += seek;
	}
	if (o !== out.length) throw new Error("kernel patch: short output");
	if (subtle && !equal(new Uint8Array(await subtle.digest("SHA-256", out)), h.targetSha256))
		throw new Error("kernel patch: the result does not match the patch's hash");
	return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

const BUNDLE_PREFIX = "unkernel.";

function customName(w: Uint8Array, payload: number, end: number): [string, number] {
	let p = payload, n = 0, s = 1, c: number;
	do { c = w[p++]!; n += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
	if (p + n > end) throw new Error("kernel bundle: bad custom section");
	let name = "";
	for (let i = 0; i < n; i++) name += String.fromCharCode(w[p + i]!);
	return [name, p + n];
}

/**
 * The SMP kernel from a bundle that carries a patch for it: the bundle's
 * kernel (every section but the unkernel.* ones, so byte for byte the
 * module that bundle.mjs was given) patched, followed by the bundle's other
 * unkernel.* sections (initramfs, command line, data disk template), so
 * that bundledBoot() reads the result as it reads the bundle. Undefined if
 * the bundle has no patch.
 */
export async function smpKernelFromBundle(bundle: Uint8Array, opts?: { verify?: boolean }): Promise<Uint8Array | undefined> {
	const secs = moduleSections(bundle);
	let patch: Uint8Array | undefined;
	const kernel: Uint8Array[] = [bundle.subarray(0, 8)], extra: Uint8Array[] = [];
	for (const [id, start, payload, end] of secs) {
		if (id === 0) {
			const [n, data] = customName(bundle, payload, end);
			if (n === SMP_PATCH_SECTION) { patch = bundle.subarray(data, end); continue; }
			if (n.startsWith(BUNDLE_PREFIX)) { extra.push(bundle.subarray(start, end)); continue; }
		}
		kernel.push(bundle.subarray(start, end));
	}
	if (!patch) return undefined;
	const smp = await applyKernelPatch(concat(kernel), patch, opts);
	return concat([smp, ...extra]);
}

/**
 * The bundle without its SMP patch section (every other section as it is,
 * in order), or the bundle itself if it has none: the UP bundle as
 * bundle.mjs makes it without --smp.
 */
export function withoutSmpPatch(bundle: Uint8Array): Uint8Array {
	const keep: Uint8Array[] = [bundle.subarray(0, 8)];
	let found = false;
	for (const [id, start, payload, end] of moduleSections(bundle)) {
		if (id === 0 && customName(bundle, payload, end)[0] === SMP_PATCH_SECTION) { found = true; continue; }
		keep.push(bundle.subarray(start, end));
	}
	return found ? concat(keep) : bundle;
}

function concat(parts: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) { out.set(p, n); n += p.length; }
	return out;
}
