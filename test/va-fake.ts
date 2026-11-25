// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Test helpers for guest VA-API's host (js/core/va.ts) without a browser: a
// guest stream on a fake vsock speaking as the driver does, pictures as
// ffmpeg's hwaccels send them (H.264 with POCs and a tag byte, VP9 frames),
// and a fake WebCodecs whose decoders behave as other real ones might:
// holding more pictures than declared or up to the DPB, ignoring the
// declared reorder depth, dropping a late picture or not, handing out
// timestamps as given or in sorted order, refusing Annex B or the VUI.
// Every output's Y is its picture's tag, so a wrong picture shows.
import { BitWriter, nalUnit, OutputModel, parsePps, parseSliceHeader, parseSps, unescapeRbsp, type H264Pps, type H264Sps } from "../js/core/va-h264.ts";
import type { Vsock, VsockConnection } from "../js/core/vsock.ts";

// ---- a guest stream ----

export type Guest = ReturnType<typeof guest>;

/** One guest stream on a fake vsock, speaking as kwva does: requests, pictures, notices. */
export function guest() {
	let accept!: (c: VsockConnection) => void;
	let port = 0;
	const vsock = { listen(p: number, cb: (c: VsockConnection) => void) {
		port = p;
		accept = cb;
		return { close() {} };
	} } as unknown as Vsock;
	const frames: { json: any; bin: Uint8Array }[] = [];
	let waiting: (() => void) | undefined;
	let toHost!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
	const connect = () => accept({
		readable: new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => void (toHost = c) }),
		writable: new WritableStream<Uint8Array>({ write(b) {
			const dv = new DataView(b.buffer, b.byteOffset);
			const total = dv.getUint32(0, true), jl = dv.getUint32(4, true), pad = (4 - (jl & 3)) & 3;
			frames.push({ json: JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + jl))), bin: b.slice(8 + jl + pad, 8 + total) });
			waiting?.();
		} }),
		reset() {},
		close() {},
	} as unknown as VsockConnection);
	let r = 0, pic = 0;
	const send = (msg: object, bin: Uint8Array = new Uint8Array(0)) => {
		const json = new TextEncoder().encode(JSON.stringify(msg)), pad = (4 - (json.length & 3)) & 3;
		const b = new Uint8Array(8 + json.length + pad + bin.length);
		new DataView(b.buffer).setUint32(0, json.length + pad + bin.length, true);
		new DataView(b.buffer).setUint32(4, json.length, true);
		b.set(json, 8);
		b.set(bin, 8 + json.length + pad);
		toHost.enqueue(b as Uint8Array<ArrayBuffer>);
	};
	const next = async (pred: (f: { json: any; bin: Uint8Array }) => boolean, ms = 8000) => {
		const t0 = Date.now();
		for (;;) {
			const i = frames.findIndex(pred);
			if (i >= 0) return frames.splice(i, 1)[0]!;
			if (Date.now() - t0 > ms) throw new Error(`nothing came in ${ms} ms; have ${JSON.stringify(frames.map((f) => f.json))}`);
			await new Promise<void>((res) => {
				waiting = res;
				setTimeout(res, 20);
			});
		}
	};
	const call = async (msg: object) => {
		const id = ++r;
		send({ ...msg, r: id });
		return next((x) => x.json.r === id);
	};
	/** a picture: its buffers ([type, size, num] each) and their bytes */
	const dec = (ctx: number, surface: number, profile: string, bufs: [number, number, number][], bin: Uint8Array, refs: number[] = [], extra: object = {}) => {
		const id = ++pic;
		send({ op: "dec", ctx, surface, pic: id, profile, refs, bufs, ...extra }, bin);
		return id;
	};
	/** as vaSyncSurface then vaGetImage: the picture's Y (its tag) */
	const read = async (surface: number, id: number) => {
		send({ op: "wait", pic: id });
		const got = await call({ op: "get", surface, pic: id });
		if (got.json.err) throw new Error(`get ${id}: ${got.json.err}`);
		return { y: got.bin[0]!, failed: got.json.failed as string | undefined };
	};
	/** the stream's end (the driver's process exits) */
	const end = () => toHost.close();
	return { vsock, port: () => port, connect, send, call, dec, read, next, frames, end };
}

// ---- pictures ----

/** An H.264 picture of a 16x16 stream, POC type 0 (6-bit lsb), as ffmpeg's vaapi_h264.c sends it: one I slice and a tag byte (the fake's output). */
export interface H264Pic {
	poc: number;
	idr: boolean;
	ref: boolean;
	frameNum: number;
	tag: number;
}

/** A stream's pictures in decode order from POCs in that order (IDR at POC 0; references: every picture whose POC is a multiple of 4 or above the last). */
export function h264Stream(pocs: number[], refs: (poc: number, i: number) => boolean = (poc) => poc % 4 === 0, tag0 = 20): H264Pic[] {
	let frameNum = 0;
	return pocs.map((poc, i) => {
		const idr = poc === 0;
		if (idr) frameNum = 0;
		const ref = idr || refs(poc, i);
		const p = { poc, idr, ref, frameNum: frameNum % 16, tag: tag0 + i };
		if (ref) frameNum++;
		return p;
	});
}

export function h264Dec(g: Guest, ctx: number, surface: number, p: H264Pic, numRefFrames = 4): number {
	const pp = new Uint8Array(672), dv = new DataView(pp.buffer);
	dv.setInt32(12, p.poc, true);
	dv.setInt32(16, p.poc, true);
	for (let i = 0; i < 16; i++) dv.setUint32(36 + 36 * i + 8, 1, true); // VA_PICTURE_H264_INVALID
	dv.setUint32(620, 1 | (1 << 4) | (2 << 14), true); // 4:2:0, frame_mbs_only, log2_max_pic_order_cnt_lsb 6 (log2_max_frame_num 4)
	pp[618] = numRefFrames;
	dv.setUint32(632, p.ref ? 1 << 10 : 0, true); // reference_pic_flag
	dv.setUint16(636, p.frameNum, true);
	const w = new BitWriter();
	w.ue(0), w.ue(7), w.ue(0), w.u(4, p.frameNum); // first_mb, slice_type I, pps id, frame_num
	if (p.idr) w.ue(0); // idr_pic_id
	w.u(6, p.poc & 63);
	if (p.idr) w.u(2, 0); // dec_ref_pic_marking: no_output_of_prior_pics, long_term_reference
	else if (p.ref) w.u(1, 0); // adaptive_ref_pic_marking_mode_flag
	w.trailing();
	const nal = new Uint8Array([...nalUnit(p.idr ? 5 : 1, p.idr ? 3 : p.ref ? 2 : 0, w.bytes()), p.tag]);
	const sp = new Uint8Array(3128);
	new DataView(sp.buffer).setUint32(0, nal.length, true);
	sp[16] = 2;
	return g.dec(ctx, surface, "h264.high", [[0, 672, 1], [4, 3128, 1], [5, nal.length, 1]], new Uint8Array([...pp, ...sp, ...nal]));
}

/** VP9 frame header bits ([value, width] pairs), then a tag byte (what the fake decoder's output carries). */
function bits(tag: number, ...fields: [number, number][]): Uint8Array {
	const out: number[] = [];
	let acc = 0, n = 0;
	for (const [v, w] of fields)
		for (let i = w - 1; i >= 0; i--) {
			acc = (acc << 1) | ((v >> i) & 1);
			if (++n === 8) out.push(acc), (acc = 0), (n = 0);
		}
	if (n) out.push(acc << (8 - n));
	out.push(tag);
	return new Uint8Array(out);
}
export const VP9_KEY = (tag: number) => bits(tag, [2, 2], [0, 2], [0, 1], [0, 1], [1, 1], [0, 1], [0x498342, 24]);
export const VP9_HIDDEN = (tag: number, refresh: number) => bits(tag, [2, 2], [0, 2], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [0, 2], [refresh, 8]);
export const VP9_INTER = (tag: number) => bits(tag, [2, 2], [0, 2], [0, 1], [1, 1], [1, 1], [0, 1], [0, 2], [1, 8]);

export function vp9Dec(g: Guest, ctx: number, surface: number, data: Uint8Array): number {
	const pp = new Uint8Array(16), sp = new Uint8Array(48);
	new DataView(sp.buffer).setUint32(0, data.length, true);
	return g.dec(ctx, surface, "vp9.0", [[0, 16, 1], [4, 48, 1], [5, data.length, 1]], new Uint8Array([...pp, ...sp, ...data]), [0, 0, 0, 0, 0, 0, 0, 0]);
}

// ---- a fake WebCodecs ----

/** How a fake decoder behaves. */
export interface FakeDecoderKind {
	name: string;
	/** H.264 output exactly as libavcodec's (the adapter's OutputModel, with the SPS's reorder depth): the decoder the model describes */
	libavcodec?: boolean;
	/** pictures it holds beyond its reorder depth, or "dpb": until max_dec_frame_buffering are held */
	hold: number | "dpb";
	/** it takes the SPS's max_num_reorder_frames as its reorder depth (false: 0) */
	honourReorder: boolean;
	/** a picture whose POC is below the last output's is dropped (libavcodec), else output late */
	drop: boolean;
	/** "pass": an output's timestamp is its chunk's; "sorted": the smallest timestamp not yet handed out */
	ts: "pass" | "sorted";
	/** H.264 only with a description (avcC): configure() without one fails (NotSupportedError) */
	needsDescription?: boolean;
	/** an SPS with a VUI makes it fail (EncodingError) */
	rejectsVui?: boolean;
	/** ms per decode */
	delay?: number;
	/** the outputs' colorSpace (default none: null) */
	colorSpace?: { matrix: string | null; fullRange: boolean | null };
}

export interface FakeChunk {
	dec: number;
	type: string;
	tag: number;
	ts: number;
	filler: boolean;
}
export interface Fake {
	chunks: FakeChunk[];
	/** VideoFrames output, not closed yet, and closed more than once */
	frames: { made: number; open: number; twice: number };
	decoders: { state: string; fail(e: Error): void }[];
	VideoDecoder: unknown;
	EncodedVideoChunk: unknown;
}

const FILLER_TAG = 250;

/** A fake WebCodecs of `kind`'s decoders, for VP9 and H.264. Outputs are I420 pictures whose Y is the tag. */
export function fakeWebCodecs(kind: FakeDecoderKind): Fake {
	const fake: Fake = { chunks: [], frames: { made: 0, open: 0, twice: 0 }, decoders: [], VideoDecoder: null, EncodedVideoChunk: null };
	class EncodedVideoChunk {
		type: string;
		timestamp: number;
		data: Uint8Array;
		constructor(i: { type: string; timestamp: number; data: Uint8Array }) {
			this.type = i.type;
			this.timestamp = i.timestamp;
			this.data = i.data.slice();
		}
	}
	interface Held {
		poc: number;
		ts: number;
		tag: number;
	}
	class VideoDecoder {
		state = "unconfigured";
		decodeQueueSize = 0;
		#out: (f: unknown) => void;
		#err: (e: Error) => void;
		#w = 16;
		#h = 16;
		#keyed = false;
		#avc = false;
		#avcc = false;
		#n: number;
		#sps: H264Sps | null = null;
		#pps = new Map<number, H264Pps>();
		#held: Held[] = [];
		#lastPoc = -Infinity;
		#tsPool: number[] = [];
		#model = new OutputModel();
		#tags = new Map<number, Held>();
		#queue: Promise<void> = Promise.resolve();
		constructor(i: { output: (f: unknown) => void; error: (e: Error) => void }) {
			this.#out = i.output;
			this.#err = i.error;
			this.#n = fake.decoders.push(this as unknown as Fake["decoders"][number]);
		}
		static async isConfigSupported(c: { codec: string; description?: Uint8Array }) {
			return { supported: c.codec.startsWith("vp09.00") || c.codec.startsWith("avc1.") };
		}
		configure(c: { codec: string; codedWidth: number; codedHeight: number; description?: Uint8Array }) {
			this.#avc = c.codec.startsWith("avc1.");
			this.#avcc = !!c.description;
			if (this.#avc && kind.needsDescription && !c.description) {
				this.state = "closed";
				queueMicrotask(() => this.#err(Object.assign(new Error("Unsupported configuration (needs a description)"), { name: "NotSupportedError" })));
				return;
			}
			this.state = "configured";
			this.#w = c.codedWidth;
			this.#h = c.codedHeight;
		}
		#emit(h: Held) {
			let ts = h.ts;
			if (kind.ts === "sorted") {
				this.#tsPool.sort((a, b) => a - b);
				ts = this.#tsPool.shift()!;
			}
			if (this.state === "closed") return;
			const w = this.#w, hh = this.#h, tag = h.tag;
			fake.frames.made++;
			fake.frames.open++;
			let closed = false;
			this.#out({
				format: "I420", timestamp: ts, visibleRect: { x: 0, y: 0, width: w, height: hh }, displayWidth: w, displayHeight: hh, colorSpace: kind.colorSpace ?? null, tag,
				async copyTo(dst: Uint8Array, o: { layout: { offset: number; stride: number }[] }) {
					const [Y, U, V] = o.layout as [{ offset: number; stride: number }, { offset: number; stride: number }, { offset: number; stride: number }];
					for (let y = 0; y < hh; y++) dst.fill(tag, Y.offset + y * Y.stride, Y.offset + y * Y.stride + w);
					for (let y = 0; y < hh / 2; y++) {
						dst.fill(100, U.offset + y * U.stride, U.offset + y * U.stride + w / 2);
						dst.fill(200, V.offset + y * V.stride, V.offset + y * V.stride + w / 2);
					}
					return o.layout;
				},
				close() {
					if (closed) fake.frames.twice++;
					else fake.frames.open--;
					closed = true;
				},
			});
		}
		/** the next picture out: the lowest POC (H.264) or the first in (VP9) */
		#bump() {
			let i = 0;
			for (let j = 1; j < this.#held.length; j++) if (this.#held[j]!.poc < this.#held[i]!.poc) i = j;
			const h = this.#held.splice(i, 1)[0]!;
			if (kind.drop && h.poc < this.#lastPoc) {
				if (kind.ts === "sorted") this.#tsPool.splice(this.#tsPool.indexOf(h.ts), 1);
				return;
			}
			this.#lastPoc = Math.max(this.#lastPoc, h.poc);
			this.#emit(h);
		}
		#depth() {
			const br = this.#sps?.vui?.bitstreamRestriction;
			if (kind.hold === "dpb") return br?.maxDecFrameBuffering ?? 16;
			return (kind.honourReorder && this.#avc ? br?.maxNumReorderFrames ?? 2 : 0) + kind.hold;
		}
		/** the pictures of one chunk: [poc, tag, key, filler] (none for a hidden VP9 frame) */
		#parse(d: Uint8Array, key: boolean): { poc: number; tag: number; idr: boolean; filler: boolean }[] {
			if (!this.#avc) {
				if (d.length === 1) return [{ poc: 0, tag: 200 + (d[0]! & 7), idr: false, filler: false }];
				const hidden = d.length > 1 && !(d[0]! & 0x08) && !(d[0]! & 0x02);
				return hidden ? [] : [{ poc: 0, tag: d[d.length - 1]!, idr: key, filler: false }];
			}
			const units: Uint8Array[] = [];
			if (this.#avcc) for (let i = 0; i + 4 <= d.length; ) {
				const n = (d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!;
				units.push(d.subarray(i + 4, i + 4 + n));
				i += 4 + n;
			}
			else {
				let s = -1;
				for (let i = 0; i + 3 <= d.length; i++)
					if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
						if (s >= 0) units.push(d.subarray(s, i - (d[i - 1] === 0 ? 1 : 0)));
						s = i + 3;
						i += 2;
					}
				if (s >= 0) units.push(d.subarray(s));
				if (!units.length) throw Object.assign(new Error("not Annex B"), { name: "EncodingError" });
			}
			const out: { poc: number; tag: number; idr: boolean; filler: boolean }[] = [];
			for (const u of units) {
				const t = u[0]! & 31;
				if (t === 7) {
					this.#sps = parseSps(unescapeRbsp(u));
					if (kind.rejectsVui && this.#sps.vui) throw Object.assign(new Error("unsupported VUI"), { name: "EncodingError" });
				} else if (t === 8) {
					const p = parsePps(unescapeRbsp(u));
					this.#pps.set(p.ppsId, p);
				} else if (t === 1 || t === 5) {
					const sps = this.#sps!, pps = this.#pps.get(parseSliceHeader(u).ppsId)!;
					const h = parseSliceHeader(u, { ...sps, ...pps, chromaArrayType: 1 });
					const filler = h.ppsId !== 0;
					out.push({ poc: h.pocLsb!, tag: filler ? FILLER_TAG : u[u.length - 1]!, idr: t === 5, filler });
				}
			}
			return out;
		}
		decode(ch: EncodedVideoChunk) {
			if (this.state !== "configured") throw new Error(`decode on a ${this.state} decoder`);
			if (!this.#keyed && ch.type !== "key") throw new Error("A key frame is required");
			this.#keyed = true;
			this.decodeQueueSize++;
			this.#queue = this.#queue.then(async () => {
				if (kind.delay) await new Promise((r) => setTimeout(r, kind.delay));
				this.decodeQueueSize--;
				if (this.state === "closed") return;
				let pics;
				try {
					pics = this.#parse(ch.data, ch.type === "key");
				} catch (e) {
					this.state = "closed";
					this.#err(e as Error);
					return;
				}
				for (const p of pics) {
					fake.chunks.push({ dec: this.#n, type: ch.type, tag: p.tag, ts: ch.timestamp, filler: p.filler });
					if (kind.libavcodec && this.#avc) {
						const h = { poc: p.poc, ts: ch.timestamp, tag: p.tag }, id = fake.chunks.length;
						this.#tags.set(id, h);
						this.#tsPool.push(ch.timestamp);
						const r = this.#model.push({ pic: id, poc: p.poc, key: p.idr, mmco: false }, this.#sps?.vui?.bitstreamRestriction?.maxNumReorderFrames ?? 0);
						if (r.out) this.#emit(this.#tags.get(r.out.pic)!);
						continue;
					}
					if (p.idr) {
						// an IDR: what is held comes out first
						while (this.#held.length) this.#bump();
						this.#lastPoc = -Infinity;
					}
					this.#tsPool.push(ch.timestamp);
					this.#held.push({ poc: this.#avc ? p.poc : this.#held.length + fake.chunks.length, ts: ch.timestamp, tag: p.tag });
					while (this.#held.length > this.#depth()) this.#bump();
				}
			});
		}
		async flush() {
			this.#keyed = false;
			await this.#queue;
			if (kind.libavcodec && this.#avc) {
				for (const q of this.#model.delayed.slice().sort((a, b) => a.poc - b.poc)) this.#emit(this.#tags.get(q.pic)!);
				this.#model = new OutputModel();
				return;
			}
			while (this.#held.length) this.#bump();
			this.#lastPoc = -Infinity;
		}
		close() {
			this.state = "closed";
		}
		fail(e: Error) {
			this.state = "closed";
			this.#err(e);
		}
	}
	fake.VideoDecoder = VideoDecoder;
	fake.EncodedVideoChunk = EncodedVideoChunk;
	return fake;
}
