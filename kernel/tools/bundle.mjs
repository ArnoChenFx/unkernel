#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Bundle a root file system (and a default command line) into a kernel module.
//
//   node kernel/tools/bundle.mjs <vmlinux|vmlinux32.wasm> <initrd.cpio[.gz]> -o <out.wasm>
//        [--cmdline "console=hvc0 rdinit=/init"] [--datadisk kwdata.kwsparse.gz] [--no-gzip]
//
// The initramfs goes into a custom section "unkernel.initrd", the command
// line into "unkernel.cmdline", and the data disk template (a gzipped
// kwsparse image, kernel/build.sh datadisk) into "unkernel.datadisk".
// Custom sections are ignored by the engine, so
// the module is otherwise unchanged (same code, imports and memory type), and
// the kernel needs no rebuild. The host runtime (js/core/kernel.ts, see
// bundledBoot) uses them when it is given no initrd / command line of its own:
//
//   node js/cli.ts vendor/build/bundle/unkernel-alpine.wasm
//
// The cpio is gzipped (CONFIG_RD_GZIP) unless it already is or --no-gzip is
// given. Existing unkernel.* sections are replaced, so re-bundling works.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { gzipSync } from "node:zlib";

export const INITRD_SECTION = "unkernel.initrd";
export const CMDLINE_SECTION = "unkernel.cmdline";
export const DATADISK_SECTION = "unkernel.datadisk";

function uleb(n) {
	const out = [];
	do {
		let b = n & 0x7f;
		n = Math.floor(n / 128);
		if (n) b |= 0x80;
		out.push(b);
	} while (n);
	return Uint8Array.from(out);
}

function customSection(name, payload) {
	const nm = new TextEncoder().encode(name);
	const body = [uleb(nm.length), nm, payload];
	const size = body.reduce((s, b) => s + b.length, 0);
	return [Uint8Array.of(0), uleb(size), ...body];
}

/** Split a wasm binary into its sections: [{id, name?, start, end}]. */
function sections(wasm) {
	if (wasm.length < 8 || wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d)
		throw new Error("not a WebAssembly module");
	let p = 8;
	const leb = () => {
		let v = 0, s = 1, c;
		do { c = wasm[p++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
		return v;
	};
	const out = [];
	while (p < wasm.length) {
		const start = p, id = wasm[p++], size = leb(), body = p;
		let name;
		if (id === 0) {
			const n = leb();
			name = new TextDecoder().decode(wasm.subarray(p, p + n));
		}
		p = body + size;
		if (p > wasm.length) throw new Error("truncated section");
		out.push({ id, name, start, end: p });
	}
	return out;
}

export function bundle(wasm, initrd, { cmdline, datadisk, gzip = true } = {}) {
	const isGz = initrd[0] === 0x1f && initrd[1] === 0x8b;
	if (gzip && !isGz) initrd = gzipSync(initrd, { level: 9 });
	const parts = [wasm.subarray(0, 8)];
	for (const s of sections(wasm))
		if (!(s.id === 0 && s.name.startsWith("unkernel."))) parts.push(wasm.subarray(s.start, s.end));
	const kernelBytes = parts.reduce((n, b) => n + b.length, 0);
	parts.push(...customSection(INITRD_SECTION, initrd));
	if (cmdline) parts.push(...customSection(CMDLINE_SECTION, new TextEncoder().encode(cmdline)));
	if (datadisk) {
		if (!(datadisk[0] === 0x1f && datadisk[1] === 0x8b)) throw new Error("the data disk template must be a gzipped kwsparse image");
		parts.push(...customSection(DATADISK_SECTION, datadisk));
	}
	return { bytes: Buffer.concat(parts), kernelBytes, initrdBytes: initrd.length, datadiskBytes: datadisk?.length ?? 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const take = (name) => {
		const i = args.indexOf(name);
		if (i < 0) return undefined;
		const v = args[i + 1];
		args.splice(i, 2);
		return v;
	};
	const out = take("-o");
	const cmdline = take("--cmdline");
	const datadiskPath = take("--datadisk");
	const noGzip = args.includes("--no-gzip");
	const [kernelPath, initrdPath] = args.filter((a) => a !== "--no-gzip");
	if (!kernelPath || !initrdPath || !out) {
		console.error("usage: bundle.mjs <vmlinux|vmlinux32.wasm> <initrd.cpio[.gz]> -o <out.wasm> [--cmdline STR] [--datadisk FILE] [--no-gzip]");
		process.exit(2);
	}
	const wasm = readFileSync(kernelPath);
	const datadisk = datadiskPath ? readFileSync(datadiskPath) : undefined;
	const { bytes, kernelBytes, initrdBytes, datadiskBytes } = bundle(wasm, readFileSync(initrdPath), { cmdline, datadisk, gzip: !noGzip });
	writeFileSync(out + ".tmp", bytes);
	renameSync(out + ".tmp", out);
	const mib = (n) => (n / 1048576).toFixed(1) + " MiB";
	console.log(`bundle: ${out} (${mib(bytes.length)}: kernel ${mib(kernelBytes)} + initrd ${mib(initrdBytes)}` +
		`${datadiskBytes ? ` + data disk template ${(datadiskBytes / 1024).toFixed(0)} KiB` : ""}${cmdline ? `, cmdline "${cmdline}"` : ""})`);
}
