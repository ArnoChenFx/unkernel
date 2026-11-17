// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The wasm-aware half of a kernel patch (kpatch.ts, kernel/tools/kwdiff.mjs
// --remap): renumber the base module's function, global and type indices in
// its code to the target's numbering, so that the byte diff that follows
// sees equal bytes where the two kernels call the same function. Only the
// code section is rewritten (instruction immediates, LEB128 re-encoded, body
// sizes and the section size adjusted); everything else stays as it is. The
// build tool runs this same code, so both sides agree byte for byte.
// Universal: no Node or DOM APIs.

/** Index maps from the base's numbering to the target's (an entry for every base index). */
export interface Remap {
	funcs: Int32Array;
	globals: Int32Array;
	types: Int32Array;
	/** Data addresses: [baseStart, baseEnd, delta] ranges, sorted; constants and memarg offsets inside move by delta. */
	data: Float64Array;
}

interface ReaderLike {
	uleb(): number;
	zig(): number;
}

/** Read the tables written by kwremap.mjs encodeRemap(): each map as a count and zigzag deltas from i. */
export function decodeRemap(r: ReaderLike): Remap {
	const map = () => {
		const n = r.uleb();
		const m = new Int32Array(n);
		let prev = -1;
		for (let i = 0; i < n; i++) m[i] = prev = prev + 1 + r.zig();
		return m;
	};
	const funcs = map(), globals = map(), types = map();
	const nd = r.uleb();
	const data = new Float64Array(nd * 3);
	let at = 0;
	for (let i = 0; i < nd; i++) {
		data[i * 3] = at += r.uleb();
		data[i * 3 + 1] = at += r.uleb();
		data[i * 3 + 2] = r.zig();
	}
	return { funcs, globals, types, data };
}

class Out {
	buf: Uint8Array;
	n = 0;
	constructor(size: number) {
		this.buf = new Uint8Array(size);
	}
	grow(k: number) {
		if (this.n + k <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
		b.set(this.buf.subarray(0, this.n));
		this.buf = b;
	}
	bytes(u8: Uint8Array) {
		this.grow(u8.length);
		this.buf.set(u8, this.n);
		this.n += u8.length;
	}
	uleb(v: number) {
		this.grow(10);
		do {
			let b = v % 128;
			v = Math.floor(v / 128);
			if (v) b |= 0x80;
			this.buf[this.n++] = b;
		} while (v);
	}
	sleb(v: number | bigint) {
		this.grow(11);
		if (typeof v === "number") {
			for (;;) {
				const b: number = ((v % 128) + 128) % 128;
				v = (v - b) / 128;
				if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) {
					this.buf[this.n++] = b;
					return;
				}
				this.buf[this.n++] = b | 0x80;
			}
		}
		for (;;) {
			const b = Number(v & 0x7fn);
			v >>= 7n;
			if ((v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40)) {
				this.buf[this.n++] = b;
				return;
			}
			this.buf[this.n++] = b | 0x80;
		}
	}
}

/** Section boundaries of a module: [id, start, payloadStart, end][]. */
export function moduleSections(w: Uint8Array): [number, number, number, number][] {
	let p = 8;
	const out: [number, number, number, number][] = [];
	while (p < w.length) {
		const start = p, id = w[p++]!;
		let size = 0, s = 1, c: number;
		do { c = w[p++]!; size += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
		out.push([id, start, p, p + size]);
		p += size;
	}
	return out;
}

/** The kinds of immediates walkBody() reports. */
export type ImmKind = "func" | "global" | "type" | "blocktype" | "const32" | "const64" | "offset";

/**
 * Walk one function body's instructions, calling `imm(kind, value, start, end)`
 * for each index or address immediate. Exported for the build tool.
 */
export function walkBody(w: Uint8Array, p: number, end: number, imm: (kind: ImmKind, v: number | bigint, s: number, e: number) => void): void {
	const uleb = () => {
		let v = 0, s = 1, c: number;
		do { c = w[p++]!; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
		return v;
	};
	// A signed LEB128 as a number when it has at most 7 bytes (49 bits), else a bigint.
	const sleb = (): number | bigint => {
		const s0 = p;
		let v = 0, mul = 1, c: number;
		do {
			c = w[p++]!;
			if (p - s0 > 7) {
				p = s0;
				let b = 0n, sh = 0n;
				do { c = w[p++]!; b |= BigInt(c & 0x7f) << sh; sh += 7n; } while (c & 0x80);
				if (c & 0x40) b -= 1n << sh;
				return b;
			}
			v += (c & 0x7f) * mul;
			mul *= 128;
		} while (c & 0x80);
		if (c & 0x40) v -= mul;
		return v;
	};
	const memarg = () => {
		const a = uleb();
		if (a & 0x40) uleb(); // memory index (multi-memory)
		const s = p, o = uleb();
		imm("offset", o, s, p);
	};
	const blocktype = () => {
		const b = w[p]!;
		if (b === 0x40 || (b >= 0x6f && b <= 0x7f)) { p++; return; }
		const s = p, t = Number(sleb());
		imm("blocktype", t, s, p);
	};
	const nl = uleb(); // local declarations
	for (let i = 0; i < nl; i++) { uleb(); p++; }
	while (p < end) {
		const op = w[p++]!;
		if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xc4) || op === 0xd1) continue;
		switch (op) {
		case 0x02: case 0x03: case 0x04: blocktype(); break;
		case 0x0c: case 0x0d: case 0x20: case 0x21: case 0x22: case 0x25: case 0x26: uleb(); break;
		case 0x0e: { const n = uleb(); for (let i = 0; i <= n; i++) uleb(); break; }
		case 0x10: case 0x12: case 0xd2: { const s = p, f = uleb(); imm("func", f, s, p); break; }
		case 0x11: case 0x13: { const s = p, t = uleb(); imm("type", t, s, p); uleb(); break; }
		case 0x1c: { const n = uleb(); p += n; break; }
		case 0x23: case 0x24: { const s = p, g = uleb(); imm("global", g, s, p); break; }
		case 0x3f: case 0x40: uleb(); break;
		case 0x41: { const s = p, v = sleb(); imm("const32", v, s, p); break; }
		case 0x42: { const s = p, v = sleb(); imm("const64", v, s, p); break; }
		case 0x43: p += 4; break;
		case 0x44: p += 8; break;
		case 0xd0: p++; break;
		case 0xfc: {
			const sub = uleb();
			if (sub <= 7) break;
			if (sub === 9 || sub === 11 || sub === 13 || sub === 15 || sub === 16 || sub === 17) uleb();
			else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) { uleb(); uleb(); }
			else throw new Error(`kremap: unknown opcode 0xfc ${sub}`);
			break;
		}
		case 0xfe: {
			const sub = uleb();
			if (sub === 3) p++;
			else memarg();
			break;
		}
		default:
			if (op >= 0x28 && op <= 0x3e) { memarg(); break; }
			throw new Error(`kremap: unknown opcode 0x${op.toString(16)} at ${p - 1}`);
		}
	}
}

/** v moved by the data range that holds it, or v. */
export function mapData(data: Float64Array, v: number): number {
	let lo = 0, hi = data.length / 3 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (v < data[mid * 3]!) hi = mid - 1;
		else if (v >= data[mid * 3 + 1]!) lo = mid + 1;
		else return v + data[mid * 3 + 2]!;
	}
	return v;
}

/** The base module with its code section's indices (and data addresses) renumbered. */
export function applyRemap(base: Uint8Array, m: Remap): Uint8Array {
	const secs = moduleSections(base);
	const code = secs.find((s) => s[0] === 10);
	if (!code) return base;
	let p = code[2];
	const uleb = () => {
		let v = 0, s = 1, c: number;
		do { c = base[p++]!; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
		return v;
	};
	const n = uleb();
	const body = new Out(code[3] - code[2] + (1 << 16));
	body.uleb(n);
	const fn = new Out(1 << 16);
	const hasData = m.data.length > 0;
	const map = (t: Int32Array, v: number) => (v < t.length ? t[v]! : v);
	for (let i = 0; i < n; i++) {
		const size = uleb(), start = p, end = p + size;
		fn.n = 0;
		let last = start;
		walkBody(base, start, end, (kind, v, s, e) => {
			let nv: number | bigint;
			switch (kind) {
			case "func": nv = map(m.funcs, v as number); break;
			case "global": nv = map(m.globals, v as number); break;
			case "type": case "blocktype": nv = map(m.types, v as number); break;
			case "offset":
				if (!hasData) return;
				nv = mapData(m.data, v as number);
				break;
			default:
				if (!hasData || typeof v !== "number" || v <= 0 || v > 0xffffffff) return;
				nv = mapData(m.data, v);
			}
			if (nv === v) return;
			fn.bytes(base.subarray(last, s));
			if (kind === "const32" || kind === "const64" || kind === "blocktype") fn.sleb(nv);
			else fn.uleb(nv as number);
			last = e;
		});
		fn.bytes(base.subarray(last, end));
		body.uleb(fn.n);
		body.bytes(fn.buf.subarray(0, fn.n));
		p = end;
	}
	const out = new Out(base.length + body.n - (code[3] - code[2]) + 16);
	out.bytes(base.subarray(0, code[1]));
	out.uleb(10);
	out.uleb(body.n);
	out.bytes(body.buf.subarray(0, body.n));
	out.bytes(base.subarray(code[3]));
	return out.buf.subarray(0, out.n);
}
