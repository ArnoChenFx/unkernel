#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A WebM file's VP9 track as IVF (va/test/va-decode.c reads IVF): each
// block's frame (a superframe stays one), unlaced blocks only.
//
//   node test/va/webm-ivf.mjs IN.webm OUT.ivf
import { readFileSync, writeFileSync } from "node:fs";

export function webmToIvf(buf) {
	let w = 0, h = 0, track = 0;
	const frames = [];
	const vint = (p, keepMarker) => {
		const b = buf[p];
		let len = 1;
		while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
		let v = keepMarker ? b : b & (0xff >> len);
		for (let i = 1; i < len; i++) v = v * 256 + buf[p + i];
		const unknown = !keepMarker && v === 2 ** (7 * len) - 1;
		return { v, len, unknown };
	};
	const MASTERS = new Set([0x18538067, 0x1f43b675, 0xa0, 0x1654ae6b, 0xae, 0xe0]);
	const walk = (start, end) => {
		let p = start;
		while (p < end) {
			const id = vint(p, true), size = vint(p + id.len, false);
			const body = p + id.len + size.len, stop = size.unknown ? end : Math.min(end, body + size.v);
			if (MASTERS.has(id.v)) walk(body, stop);
			else if (id.v === 0xd7 && !track) track = buf[body];
			else if (id.v === 0xb0) w = buf.readUIntBE(body, size.v);
			else if (id.v === 0xba) h = buf.readUIntBE(body, size.v);
			else if (id.v === 0xa3 || id.v === 0xa1) {
				const tn = vint(body, false);
				const flags = buf[body + tn.len + 2];
				if (tn.v === (track || 1) && !(flags & 0x06)) frames.push(buf.subarray(body + tn.len + 3, stop));
			}
			p = stop;
		}
	};
	walk(0, buf.length);
	const out = [Buffer.alloc(32)];
	const hdr = out[0];
	hdr.write("DKIF", 0);
	hdr.writeUInt16LE(0, 4);
	hdr.writeUInt16LE(32, 6);
	hdr.write("VP90", 8);
	hdr.writeUInt16LE(w, 12);
	hdr.writeUInt16LE(h, 14);
	hdr.writeUInt32LE(30, 16);
	hdr.writeUInt32LE(1, 20);
	hdr.writeUInt32LE(frames.length, 24);
	frames.forEach((f, i) => {
		const fh = Buffer.alloc(12);
		fh.writeUInt32LE(f.length, 0);
		fh.writeBigUInt64LE(BigInt(i), 4);
		out.push(fh, f);
	});
	return { ivf: Buffer.concat(out), width: w, height: h, frames: frames.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const r = webmToIvf(readFileSync(process.argv[2]));
	writeFileSync(process.argv[3], r.ivf);
	console.log(`${process.argv[3]}: ${r.frames} frames, ${r.width}x${r.height}`);
}
