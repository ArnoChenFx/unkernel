// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API without a browser (va/PROTOCOL.md, .agents/va.md): VP9
// header parsing on libvpx's own frame headers, frameToNv12's paths, and
// VaHost (js/core/va.ts) on a fake vsock with a fake WebCodecs whose
// outputs carry the last byte of the chunk they came from (so replays and
// reordering are visible), driven as the guest's driver drives it: the
// hello, pictures ready by notice and read back on "get", hidden VP9
// pictures, slow and holding decoders, reclaimed and failing decoders,
// picture ids across reused surfaces, freed surfaces and contexts, bad
// frames, zero-copy export into a fake GPU's resources, and prepareVa's
// refusals. H.264 through the session, and decoders
// that are not the modelled one: va-decoders.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { frameToNv12, nv12Layout, prepareVa, startVa, VA_PORT, vp9Frames, type VaGpu, type VaHost, type VideoFrameLike } from "../js/core/va.ts";
import type { Vsock, VsockConnection } from "../js/core/vsock.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

/** Frames as one chunk: one, or a superframe of several (index of one-byte sizes). */
function superframe(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0]!;
	const m = 0xc0 | (parts.length - 1);
	return Uint8Array.from([...parts.flatMap((p) => [...p]), m, ...parts.map((p) => p.length), m]);
}

// libvpx's test vectors, each packet's frames cut to their first 8 bytes (superframes as "+"), and the
// number of frames libvpx's decoder shows for them (the lines of the vector's .md5 file)
const VECTORS: Record<string, { packets: string[]; shown: number; hidden: number }> = {
	"vp90-2-10-show-existing-frame": {
		shown: 13,
		hidden: 4,
		packets: ["824983420015f011", "8400204970288900+8400404970308900+88", "89", "8400204970308900+86008092e0611200", "88", "89", "86004092e0711200", "8400404970308900+88", "89", "86004092e0711200", "86008092e0711200", "88", "89"],
	},
	"vp90-2-10-show-existing-frame2": {
		shown: 16,
		hidden: 1,
		packets: ["824983420015f011", "8402804973c0b280+8604409662a17380", "8608409663617380", "8610409662917380", "8620409662e17380", "8602409662f17380", "8604409663117380", "8608409661f17380", "8e", "8f", "8b", "8c", "8d", "8e", "8f", "8b"],
	},
};

test("vp9Frames: libvpx's frame headers", () => {
	for (const [name, v] of Object.entries(VECTORS)) {
		const frames = v.packets.map((p) => vp9Frames(superframe(p.split("+").map(hex))));
		assert.equal(frames.flat().filter((f) => f.show).length, v.shown, `${name}: frames shown as libvpx shows them`);
		assert.ok(frames[0]![0]!.key && frames[0]![0]!.refresh === 0xff, `${name}: a key frame first`);
		// libvpx shows every frame but the hidden ones, and the show_existing_frames
		assert.equal(frames.flat().filter((f) => !f.show).length, v.hidden, `${name}: hidden frames`);
		assert.equal(frames.flat().length - v.hidden, v.shown);
		assert.ok(frames.flat().every((f) => f.profile === 0));
	}
	const sf = vp9Frames(superframe(VECTORS["vp90-2-10-show-existing-frame"]!.packets[1]!.split("+").map(hex)));
	assert.deepEqual(sf.map((f) => [f.key, f.show, f.showExisting]), [[false, false, false], [false, false, false], [false, true, true]]);
});

test("vp9Frames: refuses what is not a VP9 frame", () => {
	assert.throws(() => vp9Frames(new Uint8Array(0)), /cut short/);
	assert.throws(() => vp9Frames(hex("424983420015f011")), /frame_marker/, "marker 1");
	assert.throws(() => vp9Frames(hex("8249834300")), /frame_sync_code/, "a key frame needs its sync code");
	assert.throws(() => vp9Frames(hex("82498300")), /frame_sync_code/);
	assert.throws(() => vp9Frames(hex("824983")), /cut short/, "a key frame cut short");
	assert.throws(() => vp9Frames(hex("84")), /cut short/, "an inter frame cut short");
	assert.throws(() => vp9Frames(hex("ff0000")), /frame_marker/);
});

// ---- frameToNv12 ----

/** A VideoFrame stand-in: planes as given, copyTo honours layout and format "RGBA". */
function frame(format: string | null, w: number, h: number, planes: Uint8Array[], rgba?: Uint8Array): VideoFrameLike & { closed: boolean } {
	return {
		format, timestamp: 0, visibleRect: { x: 0, y: 0, width: w, height: h }, displayWidth: w, displayHeight: h, closed: false,
		async copyTo(dst: Uint8Array, o?: { layout?: { offset: number; stride: number }[]; format?: string }) {
			if (o?.format === "RGBA") {
				dst.set(rgba!);
				return [{ offset: 0, stride: w * 4 }];
			}
			const dims = format === "NV12" ? [[w, h], [2 * ((w + 1) >> 1), (h + 1) >> 1]] : [[w, h], [(w + 1) >> 1, (h + 1) >> 1], [(w + 1) >> 1, (h + 1) >> 1]];
			o!.layout!.forEach((l, i) => {
				const [pw, ph] = dims[i]!;
				for (let y = 0; y < ph!; y++) dst.set(planes[i]!.subarray(y * pw!, (y + 1) * pw!), l.offset + y * l.stride);
			});
			return o!.layout!;
		},
		close() {
			this.closed = true;
		},
	};
}

test("frameToNv12: NV12, I420 at an odd size, and through RGBA, in the 64-byte-pitch layout", async () => {
	// NV12 as is, 4x2
	const y4 = Uint8Array.from({ length: 8 }, (_, i) => i + 1), uv4 = Uint8Array.from([100, 200, 101, 201]);
	const f1 = frame("NV12", 4, 2, [y4, uv4]);
	const a = await frameToNv12(f1);
	const l = nv12Layout(4, 2);
	assert.deepEqual([l.pitch, l.offsets, l.size], [64, [0, 128], 192]);
	assert.equal(a.data.length, l.size);
	assert.deepEqual([...a.data.subarray(0, 4)], [1, 2, 3, 4]);
	assert.deepEqual([...a.data.subarray(64, 68)], [5, 6, 7, 8]);
	assert.deepEqual([...a.data.subarray(128, 132)], [100, 200, 101, 201]);
	assert.ok(f1.closed, "closed after the copy");
	// I420, 5x3: chroma 3x2, interleaved into the UV rows
	const y5 = Uint8Array.from({ length: 15 }, (_, i) => i), u = Uint8Array.from([10, 11, 12, 13, 14, 15]), v = Uint8Array.from([20, 21, 22, 23, 24, 25]);
	const b = await frameToNv12(frame("I420", 5, 3, [y5, u, v]));
	const l5 = nv12Layout(5, 3);
	assert.deepEqual([b.width, b.height, b.data.length], [5, 3, l5.size]);
	assert.deepEqual([...b.data.subarray(64 * 2, 64 * 2 + 5)], [10, 11, 12, 13, 14], "the third Y row");
	assert.deepEqual([...b.data.subarray(l5.offsets[1], l5.offsets[1] + 6)], [10, 20, 11, 21, 12, 22]);
	assert.deepEqual([...b.data.subarray(l5.offsets[1] + 64, l5.offsets[1] + 70)], [13, 23, 14, 24, 15, 25]);
	// anything else through RGBA: white and black pixels in BT.601 limited range
	const rgba = new Uint8Array(2 * 2 * 4).fill(255);
	rgba.fill(0, 8, 16);
	rgba[11] = rgba[15] = 255;
	const logs: string[] = [];
	const c = await frameToNv12(frame("BGRX", 2, 2, [], rgba), (m) => logs.push(m));
	assert.deepEqual([c.data[0], c.data[1], c.data[64], c.data[65]], [235, 235, 16, 16]);
	assert.deepEqual([c.data[128], c.data[129]], [128, 128], "grey chroma of white");
	assert.match(logs[0]!, /format BGRX: converted through RGBA/);
});

test("frameToNv12: a frame copyTo() refuses (format null) goes through a canvas; the frame's BT.709 matrix is inverted", async () => {
	const glob = globalThis as Record<string, unknown>;
	// red, 2x2: BT.601 limited Y 82, Cb 90, Cr 240; BT.709 Y 63, Cb 102, Cr 240
	const red = Uint8Array.from({ length: 16 }, (_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0));
	const opaque = (colorSpace?: object) => ({
		...frame(null, 2, 2, []), colorSpace,
		async copyTo(): Promise<never> {
			throw Object.assign(new Error("copyTo() of an opaque frame"), { name: "NotSupportedError" });
		},
	});
	await assert.rejects(frameToNv12(opaque()), /format null, which copyTo\(\) refuses, and no 2D canvas/, "no canvas here (Node)");
	const drawn: number[] = [];
	glob.OffscreenCanvas = class {
		getContext() {
			return { drawImage: (_f: unknown, ...a: number[]) => drawn.push(...a), getImageData: () => ({ data: red }) };
		}
	};
	try {
		const f = opaque();
		const a = await frameToNv12(f);
		assert.ok((f as unknown as { closed: boolean }).closed);
		assert.deepEqual(drawn, [0, 0, 2, 2]);
		assert.deepEqual([a.data[0], a.data[65], a.data[128], a.data[129]], [82, 82, 90, 240]);
		const b = await frameToNv12(opaque({ matrix: "bt709" }));
		assert.deepEqual([b.data[0], b.data[128], b.data[129]], [63, 102, 240]);
	} finally {
		delete glob.OffscreenCanvas;
	}
});

// ---- VaHost on a fake guest ----

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
// frame_marker, profile 0, show_existing_frame 0, frame_type, show_frame, error_resilient, ...
const KEY = (tag: number) => bits(tag, [2, 2], [0, 2], [0, 1], [0, 1], [1, 1], [0, 1], [0x498342, 24]);
const HIDDEN = (tag: number, refresh: number) => bits(tag, [2, 2], [0, 2], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [0, 2], [refresh, 8]);
const INTER = (tag: number) => bits(tag, [2, 2], [0, 2], [0, 1], [1, 1], [1, 1], [0, 1], [0, 2], [1, 8]);

interface FakeOpts {
	/** ms before a chunk's output (decoded one after another) */
	delay?: number;
	/** hold each output until the next chunk or a flush (a decoder that waits for more input) */
	hold?: boolean;
	/** H.264 (avc1) is supported too */
	avc?: boolean;
}
interface Fake {
	chunks: { dec: number; type: string; tag: number; ts: number }[];
	decoders: FakeDecoder[];
	opts: FakeOpts;
}
interface FakeDecoder {
	state: string;
	fail(e: Error): void;
}

/**
 * A fake WebCodecs: one output per chunk except hidden VP9 frames (show_frame 0 in the header byte, as the
 * test frames above are built), each an I420 picture whose Y is the chunk's last byte (a one-byte
 * show_existing_frame of slot i gives 200 + i), U 100, V 200. Wants a key chunk first and after a flush.
 */
function fakeWebCodecs(opts: FakeOpts = {}): Fake & { VideoDecoder: unknown; EncodedVideoChunk: unknown } {
	const fake: Fake = { chunks: [], decoders: [], opts };
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
	class VideoDecoder {
		state = "unconfigured";
		decodeQueueSize = 0;
		#out: (f: unknown) => void;
		#err: (e: Error) => void;
		#w = 0;
		#h = 0;
		#keyed = false;
		#queue: Promise<void> = Promise.resolve();
		#held: (() => void) | null = null;
		#n: number;
		constructor(i: { output: (f: unknown) => void; error: (e: Error) => void }) {
			this.#out = i.output;
			this.#err = i.error;
			this.#n = fake.decoders.push(this as unknown as FakeDecoder);
		}
		static async isConfigSupported(c: { codec: string }) {
			return { supported: c.codec.startsWith("vp09.00") || (!!opts.avc && c.codec.startsWith("avc1.")) };
		}
		#avc = false;
		configure(c: { codec: string; codedWidth: number; codedHeight: number }) {
			this.state = "configured";
			this.#avc = c.codec.startsWith("avc1.");
			this.#w = c.codedWidth;
			this.#h = c.codedHeight;
		}
		decode(ch: EncodedVideoChunk) {
			if (this.state !== "configured") throw new Error(`decode on a ${this.state} decoder`);
			if (!this.#keyed && ch.type !== "key") throw new Error("A key frame is required");
			this.#keyed = true;
			const d = ch.data, tag = d.length === 1 ? 200 + (d[0]! & 7) : d[d.length - 1]!;
			fake.chunks.push({ dec: this.#n, type: ch.type, tag, ts: ch.timestamp });
			// profile 0: 10 00 show_existing frame_type show_frame error_resilient
			const hidden = !this.#avc && d.length > 1 && !(d[0]! & 0x08) && !(d[0]! & 0x02);
			this.#held?.();
			this.#held = null;
			if (hidden) return;
			const w = this.#w, h = this.#h, ts = ch.timestamp;
			const emit = () => {
				if (this.state === "closed") return;
				this.#out({
					format: "I420", timestamp: ts, visibleRect: { x: 0, y: 0, width: w, height: h }, displayWidth: w, displayHeight: h,
					async copyTo(dst: Uint8Array, o: { layout: { offset: number; stride: number }[] }) {
						const [Y, U, V] = o.layout as [{ offset: number; stride: number }, { offset: number; stride: number }, { offset: number; stride: number }];
						for (let y = 0; y < h; y++) dst.fill(tag, Y.offset + y * Y.stride, Y.offset + y * Y.stride + w);
						for (let y = 0; y < h / 2; y++) {
							dst.fill(100, U.offset + y * U.stride, U.offset + y * U.stride + w / 2);
							dst.fill(200, V.offset + y * V.stride, V.offset + y * V.stride + w / 2);
						}
						return o.layout;
					},
					close() {},
				});
			};
			this.decodeQueueSize++;
			this.#queue = this.#queue.then(async () => {
				if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
				this.decodeQueueSize--;
				if (opts.hold) {
					// only the newest output is held: the one before it goes out
					this.#held?.();
					this.#held = emit;
				}
				else emit();
			});
		}
		async flush() {
			this.#keyed = false;
			await this.#queue;
			this.#held?.();
			this.#held = null;
		}
		close() {
			this.state = "closed";
		}
		/** the browser's error callback, after closing it (as on a reclamation) */
		fail(e: Error) {
			this.state = "closed";
			this.#err(e);
		}
	}
	return { ...fake, VideoDecoder, EncodedVideoChunk };
}

const VASliceData = 5, VASliceParameter = 4, VAPicture = 0;

/** One guest stream on a fake vsock, speaking as kwva does: requests, pictures, notices. */
function guest() {
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
	let resets = 0;
	const connect = () => accept({
		readable: new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => void (toHost = c) }),
		writable: new WritableStream<Uint8Array>({ write(b) {
			const dv = new DataView(b.buffer, b.byteOffset);
			const total = dv.getUint32(0, true), jl = dv.getUint32(4, true), pad = (4 - (jl & 3)) & 3;
			frames.push({ json: JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + jl))), bin: b.slice(8 + jl + pad, 8 + total) });
			waiting?.();
		} }),
		reset() {
			resets++;
		},
		close() {},
	} as unknown as VsockConnection);
	let r = 0, pic = 0;
	const raw = (bytes: Uint8Array) => toHost.enqueue(bytes as Uint8Array<ArrayBuffer>);
	const send = (msg: object, bin: Uint8Array = new Uint8Array(0)) => {
		const json = new TextEncoder().encode(JSON.stringify(msg)), pad = (4 - (json.length & 3)) & 3;
		const b = new Uint8Array(8 + json.length + pad + bin.length);
		new DataView(b.buffer).setUint32(0, json.length + pad + bin.length, true);
		new DataView(b.buffer).setUint32(4, json.length, true);
		b.set(json, 8);
		b.set(bin, 8 + json.length + pad);
		raw(b);
	};
	const next = async (pred: (f: { json: any; bin: Uint8Array }) => boolean, ms = 5000) => {
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
	/** a picture as the driver sends it: picture parameters, slice parameters (one slice: all of it), the slice data */
	/** (with `raw`, data is every buffer's bytes as `bufs` says) */
	const dec = (ctx: number, surface: number, data: Uint8Array, opts: { pic?: number; bufs?: unknown; raw?: boolean } = {}) => {
		const id = opts.pic ?? ++pic;
		const pp = new Uint8Array(16), sp = new Uint8Array(48);
		new DataView(sp.buffer).setUint32(0, data.length, true);
		send({ op: "dec", ctx, surface, pic: id, profile: "vp9.0", refs: [0, 0, 0, 0, 0, 0, 0, 0], bufs: opts.bufs ?? [[VAPicture, 16, 1], [VASliceParameter, 48, 1], [VASliceData, data.length, 1]] }, opts.raw ? data : new Uint8Array([...pp, ...sp, ...data]));
		return id;
	};
	const notice = (id: number, ms?: number) => next((x) => x.json.ev && x.json.pic === id, ms);
	const get = (surface: number, id: number) => call({ op: "get", surface, pic: id });
	const end = () => toHost.close();
	return { vsock, port: () => port, connect, send, raw, call, dec, notice, get, end, frames, resets: () => resets };
}

async function withHost(opts: FakeOpts, fn: (g: ReturnType<typeof guest>, fake: Fake, host: VaHost, logs: string[]) => Promise<void>, profile = "vp9.0", gpu?: VaGpu) {
	const glob = globalThis as Record<string, unknown>;
	const fake = fakeWebCodecs(opts);
	Object.assign(glob, { VideoDecoder: fake.VideoDecoder, EncodedVideoChunk: fake.EncodedVideoChunk });
	const logs: string[] = [];
	const host = startVa(prepareVa(true, true, (m) => logs.push(m)), undefined as unknown as Vsock, () => {});
	assert.equal(host, undefined, "no vsock: no host");
	const g = guest();
	const h = startVa(prepareVa(true, true, (m) => logs.push(m)), g.vsock, (m) => logs.push(m), gpu)!;
	try {
		g.connect();
		const hello = await g.call({ op: "hello", version: 4 });
		assert.deepEqual(hello.json.profiles, opts.avc ? ["vp9.0", "h264.cb", "h264.main", "h264.high"] : ["vp9.0"]);
		assert.equal(hello.json.export, !!gpu, "export offered with a GPU only");
		assert.deepEqual((await g.call({ op: "ctx", id: 7, profile, width: 4, height: 2 })).json, { r: 2 });
		await fn(g, fake, h, logs);
	} finally {
		h.shutdown();
		delete glob.VideoDecoder;
		delete glob.EncodedVideoChunk;
	}
}

const Y = (bin: Uint8Array) => bin[0];

test("VaHost: lazy probe, hello, a picture ready by notice and read back on get, hidden pictures, a delta frame first", async () => {
	const glob = globalThis as Record<string, unknown>;
	const fake = fakeWebCodecs();
	Object.assign(glob, { VideoDecoder: fake.VideoDecoder, EncodedVideoChunk: fake.EncodedVideoChunk });
	try {
		const logs: string[] = [];
		const g = guest();
		const host = startVa(prepareVa(true, true, (m) => logs.push(m)), g.vsock, (m) => logs.push(m))!;
		assert.equal(g.port(), VA_PORT);
		assert.equal(host.status.state, "idle", "nothing asked before the first connection");
		g.connect();
		assert.match((await g.call({ op: "hello", version: 3 })).json.err, /protocol version 4/);
		const hello = await g.call({ op: "hello", version: 4 });
		assert.deepEqual([hello.json.version, hello.json.profiles, hello.json.maxWidth], [4, ["vp9.0"], 4096]);
		assert.equal(host.status.state, "ready");
		assert.match((await g.call({ op: "ctx", id: 7, profile: "h264.high", width: 4, height: 2 })).json.err, /not offered/);
		assert.deepEqual((await g.call({ op: "ctx", id: 7, profile: "vp9.0", width: 4, height: 2 })).json, { r: 4 });
		assert.equal(fake.decoders.length, 0, "the decoder is made at the first picture");
		// a delta frame before any key frame fails, and says why
		const p0 = g.dec(7, 1, INTER(9));
		assert.match((await g.notice(p0)).json.err, /key frame/);
		// key frame into surface 1, a hidden frame into 2 (refreshing slot 2), a shown one into 3
		const p1 = g.dec(7, 1, KEY(11)), p2 = g.dec(7, 2, HIDDEN(12, 0x04)), p3 = g.dec(7, 3, INTER(13));
		for (const p of [p1, p2, p3]) assert.equal((await g.notice(p)).json.ev, "ready");
		const r1 = await g.get(1, p1);
		const l = nv12Layout(4, 2);
		assert.deepEqual(r1.json, { pic: p1, format: "NV12", width: 4, height: 2, pitches: [64, 64], offsets: [0, 128], r: 5 });
		assert.equal(r1.bin.length, l.size);
		assert.deepEqual([...r1.bin.subarray(0, 4), ...r1.bin.subarray(64, 68)], [11, 11, 11, 11, 11, 11, 11, 11]);
		assert.deepEqual([...r1.bin.subarray(128, 132)], [100, 200, 100, 200], "U and V interleaved");
		assert.equal(Y((await g.get(3, p3)).bin), 13);
		// the hidden one: right after it, before the next frame, a show_existing_frame of slot 2
		assert.deepEqual(fake.chunks.map((c) => c.tag), [11, 12, 202, 13]);
		assert.equal(Y((await g.get(2, p2)).bin), 202);
		assert.match((await g.get(2, p2)).json.err, /read back already/);
		assert.match((await g.get(9, 999)).json.err, /no picture/);
		// a hidden frame refreshing no slot: black
		const p4 = g.dec(7, 4, HIDDEN(14, 0));
		await g.notice(p4);
		assert.equal(Y((await g.get(4, p4)).bin), 16);
		const st = host.stats;
		assert.deepEqual([st.pictures, st.hidden, st.showExisting, st.readbacks, st.failed, st.decoders], [5, 2, 1, 4, 1, 1]);
		assert.match((await g.call({ op: "export", surface: 1, pic: p1, width: 4, height: 2, res: [1, 2] })).json.err, /no zero-copy output/);
		assert.equal(hello.json.export, false);
		host.shutdown();
	} finally {
		delete glob.VideoDecoder;
		delete glob.EncodedVideoChunk;
	}
});

test("VaHost: a slow decoder that keeps giving pictures is not flushed", async () => {
	await withHost({ delay: 300 }, async (g, fake, host) => {
		const ids = [g.dec(7, 1, KEY(1))];
		for (let i = 2; i <= 10; i++) ids.push(g.dec(7, i, INTER(i)));
		g.send({ op: "wait", pic: ids[9] });
		for (const id of ids) assert.equal((await g.notice(id, 6000)).json.ev, "ready");
		assert.equal(Y((await g.get(10, ids[9]!)).bin), 10);
		assert.deepEqual([host.stats.flushes, host.stats.replays, fake.decoders.length], [0, 0, 1]);
	});
});

test("VaHost: a decoder that holds its last picture: conservative once waited for in vain, then a filler releases it and the stream goes on", async () => {
	await withHost({ hold: true }, async (g, fake, host, logs) => {
		const a = g.dec(7, 1, KEY(1)), b = g.dec(7, 2, INTER(2));
		assert.equal((await g.notice(a)).json.ev, "ready", "out once the next chunk came");
		await new Promise((r) => setTimeout(r, 100));
		assert.ok(!g.frames.some((f) => f.json.pic === b), "held");
		g.send({ op: "wait", pic: b });
		const t0 = Date.now();
		assert.equal((await g.notice(b, 4000)).json.ev, "ready");
		const ms = Date.now() - t0;
		assert.ok(ms >= 200 && ms < 1500, `after the model's hold timer (${ms} ms)`);
		assert.deepEqual([host.stats.flushes, host.stats.fillers, host.stats.modeSwitches, host.stats.contexts[0]!.mode], [0, 1, 1, "conservative"]);
		assert.ok(logs.some((l) => /conservative mode: a picture the model said was out did not come/.test(l)));
		// the filler (a show_existing_frame of slot 0) changed nothing: the stream goes on in the same decoder
		const c = g.dec(7, 3, INTER(3));
		g.dec(7, 4, INTER(4));
		assert.equal(Y((await g.get(3, c)).bin), 3);
		assert.deepEqual([host.stats.replays, fake.decoders.length], [0, 1]);
		assert.deepEqual(fake.chunks.map((x) => x.tag), [1, 2, 200, 3, 4], "the filler between the chunks");
	});
});

test("VaHost: a reclaimed decoder is made again and the pictures it owed come from the replay", async () => {
	await withHost({ delay: 20 }, async (g, fake, host, logs) => {
		const a = g.dec(7, 1, KEY(1));
		await g.notice(a);
		const b = g.dec(7, 2, INTER(2)), c = g.dec(7, 3, HIDDEN(3, 0x02));
		await new Promise((r) => setTimeout(r, 5));
		const e = new Error("Codec reclaimed due to inactivity.");
		e.name = "QuotaExceededError";
		fake.decoders[0]!.fail(e);
		assert.equal((await g.notice(b)).json.ev, "ready");
		assert.equal((await g.notice(c)).json.ev, "ready");
		assert.equal(Y((await g.get(2, b)).bin), 2);
		assert.equal(Y((await g.get(3, c)).bin), 201, "the hidden picture's show_existing_frame, replayed");
		assert.deepEqual(fake.chunks.filter((x) => x.dec === 2).map((x) => x.tag), [1, 2, 3, 201]);
		assert.deepEqual([host.stats.reclaims, host.stats.errors, host.stats.replays], [1, 0, 1]);
		assert.ok(logs.some((l) => /reclaimed the decoder/.test(l)) && !logs.some((l) => /decoder error/.test(l)), "logged as a reclamation");
		// reclaimed while idle: made again at the next picture
		const e2 = new Error("idle");
		e2.name = "QuotaExceededError";
		fake.decoders[1]!.fail(e2);
		const d = g.dec(7, 4, INTER(4));
		assert.equal(Y((await g.get(4, d)).bin), 4);
		assert.equal(fake.decoders.length, 3);
	});
});

test("VaHost: decoder errors: a replay first, then the pictures fail until a key frame", async () => {
	await withHost({ delay: 20 }, async (g, fake, host, logs) => {
		const a = g.dec(7, 1, KEY(1));
		await g.notice(a);
		const b = g.dec(7, 2, INTER(2));
		await new Promise((r) => setTimeout(r, 5));
		fake.decoders[0]!.fail(Object.assign(new Error("bad bitstream"), { name: "EncodingError" }));
		await new Promise((r) => setTimeout(r, 5));
		// the replay fails too, before any new output
		fake.decoders[1]!.fail(Object.assign(new Error("bad bitstream"), { name: "EncodingError" }));
		assert.match((await g.notice(b)).json.err, /decoder failed: bad bitstream/);
		assert.ok(logs.some((l) => /\[va\] decoder error .*EncodingError/.test(l)));
		// a failed picture reads back as the last good one, marked
		const rb = await g.get(2, b);
		assert.deepEqual([rb.json.failed, Y(rb.bin)], ["the decoder failed: bad bitstream", 1]);
		const c = g.dec(7, 3, INTER(3));
		assert.match((await g.notice(c)).json.err, /no key frame came since/);
		const d = g.dec(7, 4, KEY(4));
		assert.equal((await g.notice(d)).json.ev, "ready");
		assert.equal(host.stats.errors, 2);
	});
});

test("VaHost: decoder errors with progress between them are each recovered by a replay", async () => {
	await withHost({ delay: 5 }, async (g, fake, host) => {
		await g.notice(g.dec(7, 1, KEY(1)));
		for (let i = 2; i <= 7; i++) {
			const p = g.dec(7, i, INTER(i));
			while (!fake.chunks.some((c) => c.tag === i)) await new Promise((r) => setTimeout(r, 1));
			// fails right after the picture went in, before its output (as the check's injected errors do)
			fake.decoders[fake.decoders.length - 1]!.fail(Object.assign(new Error("glitch"), { name: "EncodingError" }));
			assert.equal(Y((await g.get(i, p)).bin), i);
		}
		assert.deepEqual([host.stats.errors, host.stats.replays, host.stats.failed], [6, 6, 0]);
	});
});

test("VaHost: an error on a decoder made again for a reclamation (not for the error) is replayed, not given up", async () => {
	await withHost({ delay: 5 }, async (g, fake, host) => {
		await g.notice(g.dec(7, 1, KEY(1)));
		for (let i = 2; i <= 5; i++) await g.notice(g.dec(7, i, INTER(i)));
		const p = g.dec(7, 6, INTER(6));
		while (!fake.chunks.some((c) => c.tag === 6)) await new Promise((r) => setTimeout(r, 1));
		const last = () => fake.decoders[fake.decoders.length - 1]!;
		last().fail(Object.assign(new Error("glitch"), { name: "EncodingError" })); // far into the history
		last().fail(Object.assign(new Error("idle"), { name: "QuotaExceededError" })); // the retry, reclaimed
		last().fail(Object.assign(new Error("glitch"), { name: "EncodingError" })); // its successor, before any output
		assert.equal(Y((await g.get(6, p)).bin), 6);
		assert.deepEqual([host.stats.errors, host.stats.reclaims, host.stats.failed], [2, 1, 0]);
	});
});

test("VaHost: picture ids: a freed and reused surface never gets another picture's pixels", async () => {
	await withHost({ delay: 80 }, async (g) => {
		const a = g.dec(7, 5, KEY(1));
		g.send({ op: "surf_free", surfaces: [5] });
		const b = g.dec(7, 5, INTER(2));
		const n = await g.notice(b);
		assert.equal(n.json.ev, "ready");
		assert.equal(Y((await g.get(5, b)).bin), 2, "its own picture, not the earlier one's");
		assert.match((await g.get(5, a)).json.err, /no picture/);
		assert.ok(!g.frames.some((f) => f.json.pic === a), "no notice for the freed picture");
		// a surface rendered again before its picture came: the old picture is gone
		const c = g.dec(7, 6, INTER(3)), d = g.dec(7, 6, INTER(4));
		assert.equal(Y((await g.get(6, d)).bin), 4);
		assert.match((await g.get(6, c)).json.err, /no picture/);
	});
});

/** A GPU whose resources are byte arrays (VaGpu: what the host writes, and when). */
function fakeGpu(sizes: Record<number, [number, number, number]>) {
	const tex = new Map<number, Uint8Array>();
	const log: { res: number; at: number }[] = [];
	let broken = false;
	const gpu: VaGpu = {
		write(res, box, fill) {
			const s = sizes[res];
			if (broken || !s || box.x || box.y || box.width !== s[0] || box.height !== s[1]) return false;
			const b = new Uint8Array(s[0] * s[1] * s[2]);
			fill(b);
			tex.set(res, b);
			log.push({ res, at: log.length });
			return true;
		},
	};
	return { gpu, tex, log, breakIt: () => void (broken = true) };
}

test("VaHost: export: the surface's resources get each picture before its notice, exact NV12 planes; readback still exact", async () => {
	// surface 1: 4x2 like its pictures; surface 2: 6x4, larger than its 4x2 picture (top left, the rest black)
	const f = fakeGpu({ 11: [4, 2, 1], 12: [2, 1, 2], 21: [6, 4, 1], 22: [3, 2, 2] });
	await withHost({ delay: 30 }, async (g, _fake, host) => {
		// exported before any picture: black
		assert.deepEqual((await g.call({ op: "export", surface: 1, pic: 0, width: 4, height: 2, res: [11, 12] })).json.err, undefined);
		assert.deepEqual([...f.tex.get(11)!], [16, 16, 16, 16, 16, 16, 16, 16]);
		assert.deepEqual([...f.tex.get(12)!], [128, 128, 128, 128]);
		// a picture into the exported surface: written at its completion, before the notice reached the guest
		const p1 = g.dec(7, 1, KEY(31));
		await g.notice(p1);
		assert.deepEqual([...f.tex.get(11)!], [31, 31, 31, 31, 31, 31, 31, 31]);
		assert.deepEqual([...f.tex.get(12)!], [100, 200, 100, 200], "Cb, Cr interleaved (R8G8)");
		// exported again (as mpv does per frame): nothing written again
		const n = f.log.length;
		await g.call({ op: "export", surface: 1, pic: p1, width: 4, height: 2, res: [11, 12] });
		assert.equal(f.log.length, n);
		// readback is unchanged, and still works after the export (twice: the host keeps an exported surface's picture)
		for (let i = 0; i < 2; i++) {
			const r = await g.get(1, p1);
			assert.deepEqual([r.json.format, r.json.width, r.json.height, Y(r.bin)], ["NV12", 4, 2, 31]);
		}
		// a picture done before its surface is exported: written before the export's reply
		const p2 = g.dec(7, 2, INTER(32));
		await g.notice(p2);
		assert.equal(f.tex.get(21), undefined);
		await g.call({ op: "export", surface: 2, pic: p2, width: 6, height: 4, res: [21, 22] });
		assert.deepEqual([...f.tex.get(21)!], [32, 32, 32, 32, 16, 16, 32, 32, 32, 32, 16, 16, ...Array(12).fill(16)]);
		assert.deepEqual([...f.tex.get(22)!], [100, 200, 100, 200, 128, 128, ...Array(6).fill(128)]);
		const st = host.stats;
		assert.deepEqual([st.exports, st.exported, st.uploads, st.uploadFailed, st.framesHeld], [3, 2, 3, 0, 0]);
		// freed: forgotten, its next picture (a new surface id) is not written
		g.send({ op: "surf_free", surfaces: [2] });
		const p3 = g.dec(7, 3, INTER(33));
		await g.notice(p3);
		assert.equal(host.stats.exported, 1);
		assert.equal(f.tex.get(21)![0], 32);
		// a renderer that cannot write: the export fails, and says so
		f.breakIt();
		assert.match((await g.call({ op: "export", surface: 3, pic: p3, width: 4, height: 2, res: [11, 12] })).json.err, /no such resource/);
		assert.equal(host.stats.uploadFailed, 1);
		assert.match((await g.call({ op: "export", surface: 3, pic: p3, width: 4, height: 2, res: [11] })).json.err, /bad export/);
	}, "vp9.0", f.gpu);
});

test("VaHost: vpp: a BGRX surface gets its input picture converted (BT.709 limited to full) when the input completes, before the notice; read back as BGRX", async () => {
	const f = fakeGpu({ 50: [4, 2, 4], 60: [6, 2, 4] });
	await withHost({ delay: 30 }, async (g, _fake, host) => {
		await g.call({ op: "export", surface: 5, pic: 0, width: 4, height: 2, format: "BGRX", res: [50] });
		assert.deepEqual([...f.tex.get(50)!.subarray(0, 4)], [0, 0, 0, 255], "no picture: black");
		// the input still pending when the vpp comes: done with it
		const p1 = g.dec(7, 1, KEY(126));
		g.send({ op: "vpp", surface: 5, pic: 900, src: 1, srcPic: p1, matrix: "bt709", inFull: false, outFull: true });
		assert.equal((await g.notice(900)).json.ev, "ready");
		// Y 126, Cb 100, Cr 200 (BT.709, limited in, full out): R 1.164*110 + 1.793*72 = 257 (255), G 1.164*110 - 0.213*-28 - 0.533*72 = 95.6, B 1.164*110 + 2.112*-28 = 68.9
		const px = [...f.tex.get(50)!];
		assert.deepEqual(px.slice(0, 4), [69, 96, 255, 255]);
		assert.deepEqual(px.slice(12, 16), [69, 96, 255, 255]);
		// read back (ffmpeg's hwdownload of bgr0): BGRX of the picture's size, converted on the CPU (no texture read here)
		const rb = await g.get(5, 900);
		assert.deepEqual([rb.json.format, rb.json.width, rb.json.height, rb.json.pitches, rb.json.offsets], ["BGRX", 4, 2, [16], [0]]);
		assert.deepEqual([...rb.bin.subarray(0, 4)], [69, 96, 255, 255]);
		// a done input, a larger output surface: the rest black; BT.601
		await g.call({ op: "export", surface: 6, pic: 0, width: 6, height: 2, format: "BGRX", res: [60] });
		g.send({ op: "vpp", surface: 6, pic: 901, src: 1, srcPic: p1, matrix: "bt601", inFull: false, outFull: true });
		await g.notice(901);
		const q = [...f.tex.get(60)!];
		// BT.601: B 1.164*110 + 2.017*-28 = 71.6, G 1.164*110 - 0.392*-28 - 0.813*72 = 80.5, R 1.164*110 + 1.596*72 = 243
		assert.deepEqual(q.slice(0, 4), [72, 81, 243, 255]);
		assert.deepEqual(q.slice(16, 24), [0, 0, 0, 255, 0, 0, 0, 255]);
		// the input surface given back and decoded into again before the input completed (mpv does so at once): still converted
		const p2 = g.dec(7, 1, KEY(126));
		g.send({ op: "vpp", surface: 5, pic: 903, src: 1, srcPic: p2, matrix: "bt709", inFull: false, outFull: true });
		const p3 = g.dec(7, 1, KEY(40));
		assert.equal((await g.notice(903)).json.ev, "ready");
		assert.deepEqual([...f.tex.get(50)!].slice(0, 4), [69, 96, 255, 255]);
		assert.equal(Y((await g.get(1, p3)).bin), 40, "the surface's new picture is its own");
		// an input that is gone: the output fails
		g.send({ op: "vpp", surface: 6, pic: 902, src: 9, srcPic: 999, matrix: "bt601" });
		assert.equal((await g.notice(902)).json.ev, "error");
		assert.equal(host.stats.readbacks, 2, "the BGRX one and the NV12 surface's, above");
	}, "vp9.0", f.gpu);
});

test("VaHost: export into resources of another format (named by the guest): refused, and the picture's notice still comes", async () => {
	// 13 is R8 where CbCr needs R8G8; 70 is R8 where BGRX needs 4 bytes a texel
	const f = fakeGpu({ 11: [4, 2, 1], 13: [2, 1, 1], 70: [4, 2, 1] });
	await withHost({ delay: 10 }, async (g, _fake, host) => {
		assert.match((await g.call({ op: "export", surface: 1, pic: 0, width: 4, height: 2, res: [11, 13] })).json.err, /no such resource/);
		const p1 = g.dec(7, 1, KEY(5));
		assert.equal((await g.notice(p1)).json.ev, "ready");
		assert.equal(Y((await g.get(1, p1)).bin), 5);
		assert.match((await g.call({ op: "export", surface: 5, pic: 0, width: 4, height: 2, format: "BGRX", res: [70] })).json.err, /no such resource/);
		assert.equal(f.tex.get(13), undefined, "nothing written into it");
		assert.ok(host.stats.uploadFailed >= 2);
	}, "vp9.0", f.gpu);
});

test("VaHost: vpp: an input whose surface was decoded into again and that its decoder holds still gets the hold timer when the output is waited for", async () => {
	const f = fakeGpu({ 50: [4, 2, 4] });
	await withHost({ hold: true }, async (g, _fake, host) => {
		await g.call({ op: "export", surface: 5, pic: 0, width: 4, height: 2, format: "BGRX", res: [50] });
		const p1 = g.dec(7, 1, KEY(126));
		g.send({ op: "vpp", surface: 5, pic: 900, src: 1, srcPic: p1, matrix: "bt709", inFull: false, outFull: true });
		// surface 1 given back and named again, with no input reaching the decoder (no such context): p1 is owed to the vpp only
		g.dec(99, 1, KEY(1));
		await new Promise((r) => setTimeout(r, 50));
		g.send({ op: "wait", pic: 900 });
		assert.equal((await g.notice(900, 4000)).json.ev, "ready");
		assert.deepEqual([...f.tex.get(50)!].slice(0, 4), [69, 96, 255, 255]);
		assert.ok(host.stats.holdFires >= 1);
	}, "vp9.0", f.gpu);
});

test("VaHost: every failure while handling a picture finishes it", async () => {
	await withHost({}, async (g, fake, host) => {
		await g.notice(g.dec(7, 1, KEY(1)));
		// buffers beyond the frame's bytes
		assert.match((await g.notice(g.dec(7, 2, INTER(2), { bufs: [[VASliceData, 99999, 1]] }))).json.err, /beyond the frame/);
		// negative or fractional element sizes and counts (their product fits)
		assert.match((await g.notice(g.dec(7, 2, INTER(2), { bufs: [[VASliceData, -1, -2]] }))).json.err, /beyond the frame/);
		assert.match((await g.notice(g.dec(7, 2, INTER(2), { bufs: [[VASliceData, 0.5, 4]] }))).json.err, /beyond the frame/);
		// not a VP9 frame
		assert.match((await g.notice(g.dec(7, 3, hex("0102030405")))).json.err, /frame_marker/);
		// slice parameters outside their data
		assert.match((await g.notice(g.dec(7, 4, INTER(4), { bufs: [[VASliceParameter, 8, 1], [VASliceData, 4, 1]] }))).json.err, /beyond the frame|slice parameters of 8/);
		// no such context
		assert.match((await g.notice(g.dec(99, 5, INTER(5)))).json.err, /no context 99/);
		// decode() throws
		const orig = (fake.decoders[0] as unknown as { decode: (c: unknown) => void }).decode;
		(fake.decoders[0] as unknown as { decode: (c: unknown) => void }).decode = () => {
			throw new Error("boom");
		};
		assert.match((await g.notice(g.dec(7, 6, INTER(6)))).json.err, /VideoDecoder: boom/);
		void orig;
		// the next picture gets a new decoder with the history replayed
		const p = g.dec(7, 7, INTER(7));
		assert.equal(Y((await g.get(7, p)).bin), 7);
		assert.equal(host.stats.replays, 1);
	});
});

test("VaHost: ctx_free still completes what was submitted (flushed out of a holding decoder), then closes it; get waits for a picture", async () => {
	await withHost({ delay: 200, hold: true }, async (g, fake, host) => {
		const a = g.dec(7, 1, KEY(1));
		const got = g.get(1, a); // waits for it
		g.send({ op: "ctx_free", id: 7 });
		assert.equal((await g.notice(a)).json.ev, "ready", "as on hardware: a destroyed context's pictures still come");
		const r = await got;
		assert.equal(Y(r.bin), 1);
		assert.equal(r.json.failed, undefined);
		await new Promise((res) => setTimeout(res, 10));
		assert.equal(fake.decoders[0]!.state, "closed");
		assert.equal(host.stats.decoders, 0);
		assert.deepEqual((await g.call({ op: "ctx", id: 8, profile: "vp9.0", width: 4, height: 2 })).json.r > 0, true);
		g.dec(8, 2, KEY(2));
		await new Promise((r) => setTimeout(r, 10));
		host.shutdown();
	});
});

test("VaHost: the stream's end closes its decoders and forgets its pictures", async () => {
	await withHost({ delay: 50 }, async (g, fake, host) => {
		g.dec(7, 1, KEY(1));
		g.dec(7, 2, INTER(2));
		assert.equal(host.stats.connections, 1);
		g.end();
		for (let i = 0; i < 100 && host.stats.connections; i++) await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual([host.stats.connections, host.stats.decoders, fake.decoders[0]!.state], [0, 0, "closed"]);
		await new Promise((r) => setTimeout(r, 120));
		assert.ok(!g.frames.some((f) => f.json.ev), "nothing is sent after the end");
	});
});

test("VaHost: a frame larger than 64 MiB ends the stream with a lost frame", async () => {
	await withHost({}, async (g) => {
		const b = new Uint8Array(8);
		new DataView(b.buffer).setUint32(0, 100 << 20, true);
		new DataView(b.buffer).setUint32(4, 2, true);
		g.raw(b);
		const lost = await (async () => {
			for (let i = 0; i < 100; i++) {
				const f = g.frames.find((x) => x.json.lost);
				if (f) return f;
				await new Promise((r) => setTimeout(r, 10));
			}
		})();
		assert.match(lost?.json.lost, /a bad frame/);
		for (let i = 0; i < 100 && !g.resets(); i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(g.resets(), 1);
	});
});

test("VaHost: frames split across reads and several in one read", async () => {
	await withHost({}, async (g) => {
		const sent: Uint8Array[] = [];
		const orig = g.raw;
		const capture = (b: Uint8Array) => sent.push(b);
		(g as { raw: (b: Uint8Array) => void }).raw = capture;
		// build two pictures' frames, then feed them byte-split and joined
		const send = g.send;
		void send;
		(g as { raw: (b: Uint8Array) => void }).raw = orig;
		const bytes: number[] = [];
		const enc = (msg: object, bin: Uint8Array) => {
			const json = new TextEncoder().encode(JSON.stringify(msg)), pad = (4 - (json.length & 3)) & 3;
			const hdr = new Uint8Array(8);
			new DataView(hdr.buffer).setUint32(0, json.length + pad + bin.length, true);
			new DataView(hdr.buffer).setUint32(4, json.length, true);
			bytes.push(...hdr, ...json, ...new Array(pad).fill(0), ...bin);
		};
		const k = KEY(1), i2 = INTER(2);
		enc({ op: "dec", ctx: 7, surface: 1, pic: 101, bufs: [[VASliceData, k.length, 1]] }, k);
		enc({ op: "dec", ctx: 7, surface: 2, pic: 102, bufs: [[VASliceData, i2.length, 1]] }, i2);
		const all = Uint8Array.from(bytes);
		for (let o = 0; o < all.length; o += 3) orig(all.slice(o, Math.min(all.length, o + 3)));
		assert.equal((await g.notice(101)).json.ev, "ready");
		assert.equal(Y((await g.get(2, 102)).bin), 2);
	});
});

test("VaHost.inject: fail makes a picture fail with the decoder's stream intact", async () => {
	await withHost({}, async (g, fake, host) => {
		host.inject("fail", { every: 2, count: 1 });
		const a = g.dec(7, 1, KEY(1)), b = g.dec(7, 2, INTER(2)), c = g.dec(7, 3, INTER(3));
		assert.equal((await g.notice(a)).json.ev, "ready");
		assert.match((await g.notice(b)).json.err, /asked for/);
		assert.equal(Y((await g.get(3, c)).bin), 3);
		assert.deepEqual(fake.chunks.map((x) => x.tag), [1, 2, 3], "the failed picture was still decoded");
	});
});

test("prepareVa: ignored with a log line without WebCodecs or vsock", () => {
	const logs: string[] = [];
	assert.equal(prepareVa(true, true, (m) => logs.push(m)), undefined);
	assert.match(logs.pop()!, /no WebCodecs VideoDecoder/);
	assert.equal(prepareVa(true, false, (m) => logs.push(m)), undefined);
	assert.match(logs.pop()!, /needs the vsock device/);
	assert.equal(prepareVa(undefined, true, (m) => logs.push(m)), undefined);
});
