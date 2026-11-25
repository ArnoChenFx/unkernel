// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API (va/PROTOCOL.md): what the codec adapters (va-vp9.ts,
// va-h264.ts, va-av1.ts) share with the session in va.ts: a VA picture as
// the driver sends it, the chunks an adapter makes of it, the adapter
// interface, and the bit writer and reader the headers are made with.

/** VA buffer types (va.h VABufferType) the decoders use. */
export const VA_BUF = { picture: 0, iqMatrix: 1, bitPlane: 2, sliceParameter: 4, sliceData: 5, huffmanTable: 12, probability: 13 } as const;

/** One VA buffer of a picture, as vaCreateBuffer had it: `num` elements of `size` bytes. */
export interface VaBuffer {
	type: number;
	size: number;
	num: number;
	data: Uint8Array;
}

/** A VA picture: everything vaRenderPicture got between vaBeginPicture and vaEndPicture. */
export interface VaPicture {
	/** session-unique picture id (the driver's), and the surface it decodes into */
	pic: number;
	surface: number;
	/** the context's VA profile ("vp9.0") and size */
	profile: string;
	width: number;
	height: number;
	/** the buffers in the order the app rendered them */
	bufs: VaBuffer[];
	/** the picture ids of the surfaces the picture parameters name as references, in the codec's order (VP9: reference_frames[8]); 0: none */
	refs: number[];
}

/**
 * The slice data of a picture: each slice data buffer cut into the ranges
 * the slice parameter buffer before it gives (VASliceParameterBufferBase at
 * the start of each element, `size` bytes apart), or whole where none came
 * before it. Throws for a range outside its buffer, or ranges of more bytes
 * than it has (they would overlap).
 */
export function sliceRanges(p: VaPicture): Uint8Array[] {
	const out: Uint8Array[] = [];
	let params: VaBuffer | null = null;
	for (const b of p.bufs) {
		if (b.type === VA_BUF.sliceParameter) {
			if (b.size < 12) throw new Error(`slice parameters of ${b.size} bytes (VASliceParameterBufferBase is 12)`);
			params = b;
		} else if (b.type === VA_BUF.sliceData) {
			if (!params) {
				out.push(b.data);
				continue;
			}
			const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
			let total = 0;
			for (let i = 0; i < params.num; i++) {
				const size = dv.getUint32(i * params.size, true), off = dv.getUint32(i * params.size + 4, true);
				if (off + size > b.data.length) throw new Error(`slice ${i}: bytes ${off} to ${off + size} of a slice data buffer of ${b.data.length}`);
				// slices do not overlap: more bytes than the buffer has would copy it many times over
				if ((total += size) > b.data.length) throw new Error(`slices of more bytes than their slice data buffer's ${b.data.length}`);
				out.push(b.data.subarray(off, off + size));
			}
			params = null;
		}
	}
	return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0]!;
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) out.set(p, n), (n += p.length);
	return out;
}

// ---- adapters ----

/** VideoDecoder.configure()'s codec string and description (the session adds the rest). */
export interface CodecConfig {
	codec: string;
	description?: Uint8Array;
}

/** One EncodedVideoChunk of a picture. */
export interface CodecChunk {
	data: Uint8Array;
	/** a key chunk: a decoder can start here (the replay history starts again) */
	key: boolean;
	/** its decoder output is the picture's (at most one chunk of a picture has one) */
	output: boolean;
	/** configure the decoder again (adapter.config()) before this key chunk: a new sequence header, another size */
	reconfigure?: boolean;
	/** a chunk the adapter added, not from the app's bitstream (VP9's show_existing_frame of a hidden frame) */
	added?: boolean;
	/**
	 * make the decoder again and replay the stream since the last key chunk
	 * before this (delta) chunk: what the adapter's chunks carry changed (H.264:
	 * the SPS's reorder delay); replayed chunks are made again with `remake`
	 */
	restart?: boolean;
	/** the chunk's bytes as they are to be decoded now (a replay, another packaging); without it, `data` as it was */
	remake?: () => Uint8Array;
	/**
	 * For a codec whose decoder reorders (H.264: from the POC): the chunk's
	 * place in the output order, used as its timestamp, so that a decoder
	 * that hands out timestamps in sorted order (as presentation times)
	 * still pairs each picture with its own. Unique among a decoder's
	 * chunks. Without it the timestamp is the decode order.
	 */
	order?: number;
	/**
	 * The chunk may wait for the context's next picture (the last chunk of a
	 * picture only): the session parks it and, when the next picture comes,
	 * decodes `hold(next)` before it; when the guest waits for a picture
	 * first (or the context ends), `hold(null)` right away. (AV1: where to
	 * store the picture is known from the next picture's reference map.)
	 */
	hold?: (next: VaPicture | null) => CodecChunk;
}

/** How a context's decoder is expected to give its outputs (vm.va.stats). */
export type CodecMode = "model" | "conservative";

/**
 * One VA context's codec knowledge; the session does the rest (decoders,
 * timestamps, replay, flushes, picture ids, NV12). A new codec is a
 * CodecKind in va.ts's CODECS and an adapter.
 */
export interface CodecAdapter {
	/**
	 * VideoDecoder.configure()'s codec string and, where the codec has one,
	 * description (H.264 avcC); the session adds the size,
	 * optimizeForLatency and hardwareAcceleration. null: not known yet (a
	 * codec whose sequence header comes with the first picture).
	 */
	config(): CodecConfig | null;
	/**
	 * One picture's chunks in decode order, built from its buffers: the
	 * bitstream split and parsed, the key-frame test, and pictures that give
	 * the decoder no output of their own (a chunk added whose output is the
	 * picture; with no output chunk the picture is black). Throws, saying
	 * why, for a picture it cannot decode.
	 */
	picture(p: VaPicture): CodecChunk[];
	/** Whether the decoder holds the picture until more input comes (H.264: its reorder delay), as far as the adapter's model knows. */
	held?(pic: number): boolean;
	/** The decoder was made again, or flushed and configured again: it decodes the stream since the last key chunk from scratch. */
	reset?(): void;
	/**
	 * "model": the adapter predicts when the decoder gives each picture
	 * (VP9, AV1: right after its chunk; H.264: libavcodec's output process);
	 * "conservative": it assumes nothing of the decoder's timing.
	 */
	mode(): CodecMode;
	/**
	 * The decoder disagreed with the model (`why`): go conservative. true:
	 * what the chunks carry changed (H.264: the SPS), so the decoder is made
	 * again with the history replayed (remade).
	 */
	conservative?(why: string): boolean;
	/**
	 * A chunk that makes a decoder that holds outputs for lack of input give
	 * the one it holds longest, changing none of its state; its own output is
	 * dropped. `pic` is the picture the guest waits for, `given` the fillers
	 * given for it so far. null: none can be made now (another would not
	 * help). Fillers are not in the replay history.
	 */
	filler?(pic: number, given: number): CodecChunk | null;
	/**
	 * A flush left these pictures without an output: the decoder dropped
	 * them. true: the adapter changed what its chunks declare (H.264: a
	 * deeper reorder), so a replay (with remade chunks) will give them.
	 */
	dropped?(pics: number[]): boolean;
	/**
	 * Ways to package the chunks (H.264: Annex B, avcC, Annex B without
	 * the VUI), tried in turn when a decoder fails before its first output;
	 * `variant(i)` switches (the history is remade), `probe(i)` is a config
	 * for isConfigSupported before the first picture. Without them, one.
	 */
	variants?: number;
	variant?(i: number): void;
	probe?(i: number): CodecConfig;
	/** For vm.va.stats: the adapter's state (H.264: the declared reorder depth, the packaging). */
	info?(): Record<string, string | number | boolean>;
}

// ---- bits ----

/** Bits, most significant first: fixed-width fields, exp-Golomb codes (H.264, HEVC) and AV1's ns, su, le and leb128. */
export class BitWriter {
	#out: number[] = [];
	#acc = 0;
	#n = 0;

	bit(b: number): void {
		this.#acc = (this.#acc << 1) | (b & 1);
		if (++this.#n === 8) {
			this.#out.push(this.#acc);
			this.#acc = 0;
			this.#n = 0;
		}
	}

	/** v in `bits` bits (up to 32) */
	u(bits: number, v: number): void {
		if (!Number.isInteger(v) || v < 0 || v >= 2 ** bits) throw new RangeError(`u(${bits}) of ${v}`);
		for (let i = bits - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1);
	}

	ue(v: number): void {
		if (!Number.isInteger(v) || v < 0 || v > 0xfffffffe) throw new RangeError(`ue(v) of ${v}`);
		const x = v + 1, len = 31 - Math.clz32(x);
		this.u(len, 0);
		this.u(len + 1, x);
	}

	se(v: number): void {
		this.ue(v > 0 ? 2 * v - 1 : -2 * v);
	}

	/** AV1 su(n): n bits, two's complement */
	su(n: number, v: number): void {
		if (!Number.isInteger(v) || v < -(2 ** (n - 1)) || v >= 2 ** (n - 1)) throw new RangeError(`su(${n}) of ${v}`);
		this.u(n, v < 0 ? v + 2 ** n : v);
	}

	/** AV1 ns(n): v in [0, n) */
	ns(n: number, v: number): void {
		if (!Number.isInteger(v) || v < 0 || v >= n) throw new RangeError(`ns(${n}) of ${v}`);
		const w = 32 - Math.clz32(n), m = 2 ** w - n;
		if (v < m) return this.u(w - 1, v);
		const t = v + m;
		this.u(w - 1, t >>> 1);
		this.bit(t & 1);
	}

	/** rbsp_trailing_bits (H.264, HEVC) and AV1's trailing_bits */
	trailing(): void {
		this.bit(1);
		while (this.#n) this.bit(0);
	}

	/** zero bits up to a byte boundary (AV1's byte_alignment) */
	align(): void {
		while (this.#n) this.bit(0);
	}

	/** whole bytes, at a byte boundary */
	bytes8(d: Uint8Array): void {
		if (this.#n) throw new Error("not byte aligned");
		for (const b of d) this.#out.push(b);
	}

	get bits(): number {
		return this.#out.length * 8 + this.#n;
	}

	bytes(): Uint8Array {
		if (this.#n) throw new Error("RBSP not byte aligned");
		return Uint8Array.from(this.#out);
	}
}

/** Reads bits (for H.264 and HEVC: RBSP without emulation prevention bytes, which more() knows the end of). */
export class BitReader {
	#d: Uint8Array;
	#pos = 0;
	#end: number;

	constructor(d: Uint8Array) {
		this.#d = d;
		// the rbsp_stop_one_bit: the last 1 bit
		let e = d.length * 8;
		while (e > 0 && !((d[(e - 1) >> 3]! >> (7 - ((e - 1) & 7))) & 1)) e--;
		this.#end = e > 0 ? e - 1 : 0;
	}

	get pos(): number {
		return this.#pos;
	}

	bit(): number {
		if (this.#pos >= this.#d.length * 8) throw new Error(`cut short (${this.#d.length} bytes)`);
		const b = (this.#d[this.#pos >> 3]! >> (7 - (this.#pos & 7))) & 1;
		this.#pos++;
		return b;
	}

	u(n: number): number {
		let v = 0;
		while (n--) v = v * 2 + this.bit();
		return v;
	}

	/** n bits passed over (throws, as reading them would, when fewer are left) */
	skip(n: number): void {
		if (!(n >= 0) || this.#pos + n > this.#d.length * 8) throw new Error(`cut short (${this.#d.length} bytes)`);
		this.#pos += n;
	}

	ue(): number {
		let z = 0;
		while (!this.bit()) if (++z > 31) throw new Error("an exp-Golomb code longer than 32 bits");
		return 2 ** z - 1 + this.u(z);
	}

	se(): number {
		const k = this.ue();
		return k % 2 ? (k + 1) / 2 : -(k / 2);
	}

	/** AV1 su(n) */
	su(n: number): number {
		const v = this.u(n);
		return v >= 2 ** (n - 1) ? v - 2 ** n : v;
	}

	/** AV1 ns(n) */
	ns(n: number): number {
		const w = 32 - Math.clz32(n), m = 2 ** w - n, v = this.u(w - 1);
		return v < m ? v : (v << 1) - m + this.bit();
	}

	/** zero bits to a byte boundary */
	align(): void {
		while (this.#pos & 7) this.bit();
	}

	/** more_rbsp_data(): bits left before the rbsp_stop_one_bit */
	more(): boolean {
		return this.#pos < this.#end;
	}
}

/** AV1 leb128() of v (at most 8 bytes; for sizes below 2^32). */
export function leb128(v: number): number[] {
	const out: number[] = [];
	do {
		let b = v % 128;
		v = Math.floor(v / 128);
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return out;
}
