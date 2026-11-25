// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API encode without a browser (va/PROTOCOL.md "enc", .agents/va.md,
// Encode): VaEncoders (js/core/va-enc.ts) on a fake WebCodecs whose
// VideoEncoder makes one chunk per frame carrying the frame's first luma
// byte, as the guest's driver drives it: pictures with their pixels, kept
// pixels of an unchanged surface, decoded pictures as inputs, key frames
// where asked, rate control from the misc buffers and changes of it, CQP's
// quantizer, an encoder that fails, is reclaimed, holds its output, drops
// it at a flush or fails for good, a context destroyed with pictures in
// flight, and hostile input; through VaHost (va.ts): the hello, an encode
// context, decoded pictures as inputs (pending ones, and on the GPU path a
// held frame cloned, not copied, then read back); every VideoFrame closed
// once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeStats, probeEncoders, VaEncoders, vp9Quantizer, type EncHost, type EncSource, type EncWebCodecs } from "../js/core/va-enc.ts";
import { prepareVa, startVa, type VaGpu, type VaHost } from "../js/core/va.ts";
import { fakeWebCodecs, guest, VP9_INTER, VP9_KEY, vp9Dec, type Fake, type Guest } from "./va-fake.ts";

// ---- a fake WebCodecs encoder side ----

interface FakeEncKind {
	/** outputs only at flush() */
	hold?: boolean;
	/** a flush gives nothing (the held frames are dropped) */
	dropOnFlush?: boolean;
	/** the n-th encode() of each encoder (from 1) fails it (error callback, state closed); "always": every one */
	failAt?: number | "always";
	/** encoders made in all before failures stop (failAt applies to the first `failEncoders`) */
	failEncoders?: number;
	/** isConfigSupported says no to bitrateMode "quantizer" */
	noQuantizer?: boolean;
	/** ms per encode */
	delay?: number;
}

interface FakeEnc {
	wc: EncWebCodecs;
	frames: { made: number; open: number; twice: number };
	encoders: { configs: any[]; encodes: { tag: number; ts: number; opts: any; w: number; h: number }[]; state: string; fail(e: Error): void }[];
}

function fakeEnc(kind: FakeEncKind = {}): FakeEnc {
	const fake: FakeEnc = { wc: null as unknown as EncWebCodecs, frames: { made: 0, open: 0, twice: 0 }, encoders: [] };
	class VideoFrame {
		timestamp: number;
		visibleRect: { x: number; y: number; width: number; height: number };
		displayWidth: number;
		displayHeight: number;
		tag: number;
		#closed = false;
		constructor(src: Uint8Array | VideoFrame | { tag: number; visibleRect: VideoFrame["visibleRect"]; timestamp: number; closed?: boolean }, init: any) {
			if (!(src instanceof Uint8Array)) {
				// another frame (a decoder's output too): it must be open
				if (src instanceof VideoFrame ? src.#closed : src.closed) throw new Error("a closed frame");
				this.tag = src.tag;
				this.visibleRect = init.visibleRect ?? src.visibleRect;
			} else {
				const l = init.layout;
				if (init.format !== "NV12" || !l || l.length !== 2) throw new Error("not NV12");
				const ch = (init.codedHeight + 1) >> 1;
				if (l[1].offset + l[1].stride * (ch - 1) + init.codedWidth > src.length || l[0].stride < init.codedWidth) throw new Error(`planes beyond ${src.length} bytes`);
				this.tag = src[l[0].offset]!;
				this.visibleRect = init.visibleRect ?? { x: 0, y: 0, width: init.codedWidth, height: init.codedHeight };
			}
			this.displayWidth = this.visibleRect.width;
			this.displayHeight = this.visibleRect.height;
			this.timestamp = init.timestamp ?? (src as VideoFrame).timestamp ?? 0;
			fake.frames.made++;
			fake.frames.open++;
		}
		get closed() {
			return this.#closed;
		}
		close() {
			if (this.#closed) fake.frames.twice++;
			else fake.frames.open--;
			this.#closed = true;
		}
	}
	class VideoEncoder {
		state = "unconfigured";
		encodeQueueSize = 0;
		configs: any[] = [];
		encodes: { tag: number; ts: number; opts: any; w: number; h: number }[] = [];
		#out: (c: any) => void;
		#err: (e: Error) => void;
		#held: any[] = [];
		#n = 0;
		#index: number;
		#queue: Promise<void> = Promise.resolve();
		constructor(i: { output: (c: any) => void; error: (e: Error) => void }) {
			this.#out = i.output;
			this.#err = i.error;
			this.#index = fake.encoders.push(this as any);
		}
		static async isConfigSupported(c: any) {
			return { supported: String(c.codec).startsWith("vp09.00") && !(kind.noQuantizer && c.bitrateMode === "quantizer") };
		}
		configure(c: any) {
			if (this.state === "closed") throw new Error("configure on a closed encoder");
			this.configs.push(c);
			this.state = "configured";
		}
		encode(f: VideoFrame, opts: any) {
			if (this.state !== "configured") throw new Error(`encode on a ${this.state} encoder`);
			if (f.closed) throw new Error("encode of a closed frame");
			const tag = f.tag, ts = f.timestamp, n = ++this.#n;
			this.encodes.push({ tag, ts, opts, w: f.visibleRect.width, h: f.visibleRect.height });
			const failing = (kind.failAt === "always" || kind.failAt === n) && this.#index <= (kind.failEncoders ?? Infinity);
			this.encodeQueueSize++;
			this.#queue = this.#queue.then(async () => {
				if (kind.delay) await new Promise((r) => setTimeout(r, kind.delay));
				this.encodeQueueSize--;
				if (this.state === "closed") return;
				if (failing) return this.fail(Object.assign(new Error("Encoding error (fake)"), { name: "EncodingError" }));
				const chunk = { type: opts?.keyFrame || n === 1 ? "key" : "delta", timestamp: ts, byteLength: 3, copyTo: (d: Uint8Array) => d.set([tag, opts?.keyFrame ? 1 : 0, 0x86]) };
				if (kind.hold) this.#held.push(chunk);
				else this.#out(chunk);
			});
		}
		async flush() {
			await this.#queue;
			const held = this.#held.splice(0);
			if (!kind.dropOnFlush) for (const c of held) if (this.state === "configured") this.#out(c);
		}
		close() {
			this.state = "closed";
		}
		fail(e: Error) {
			this.state = "closed";
			this.#err(e);
		}
	}
	fake.wc = { VideoEncoder, VideoFrame } as unknown as EncWebCodecs;
	return fake;
}

// ---- a stand-in session ----

interface Notice {
	json: any;
	bin: Uint8Array | undefined;
}

function session(fake: FakeEnc, sources: Map<number, () => EncSource | null> = new Map()) {
	const notices: Notice[] = [];
	const logs: string[] = [];
	let waiting: (() => void) | undefined;
	const stats = encodeStats();
	const host: EncHost = {
		wc: fake.wc,
		out: (json, bin) => {
			notices.push({ json, bin });
			waiting?.();
		},
		log: (m) => logs.push(m),
		stats,
		closed: [],
		open: new Set(),
		hardwareAcceleration: "no-preference",
		verbose: false,
		support: () => probeEncoders(fake.wc, "no-preference"),
		source: (pic, _surface, use) => {
			const s = sources.get(pic);
			// done later, as a decode would be
			setTimeout(() => use(s ? s() : null), 5);
		},
	};
	const enc = new VaEncoders(host);
	/** the notice of a picture */
	const coded = async (pic: number, ms = 4000): Promise<Notice> => {
		const t0 = Date.now();
		for (;;) {
			const i = notices.findIndex((n) => n.json.pic === pic);
			if (i >= 0) return notices.splice(i, 1)[0]!;
			if (Date.now() - t0 > ms) throw new Error(`no notice for picture ${pic} in ${ms} ms; have ${JSON.stringify(notices.map((n) => n.json))}; log ${logs.join(" | ")}`);
			await new Promise<void>((res) => {
				waiting = res;
				setTimeout(res, 10);
			});
		}
	};
	return { enc, host, stats, notices, logs, coded };
}

// ---- VA pictures ----

/** VAEncPictureParameterBufferVP9 (132 bytes) as ffmpeg's vaapi_encode_vp9.c fills it. */
function vp9Pic(o: { w: number; h: number; key?: boolean; show?: boolean; qindex?: number; forceKf?: boolean }): Uint8Array {
	const b = new Uint8Array(132), dv = new DataView(b.buffer);
	dv.setUint32(0, o.w, true), dv.setUint32(4, o.h, true), dv.setUint32(8, o.w, true), dv.setUint32(12, o.h, true);
	dv.setUint32(56, o.forceKf ? 1 : 0, true);
	dv.setUint32(60, (o.key ? 0 : 1) | (o.show === false ? 0 : 2), true);
	b[64] = o.key ? 0xff : 0xff;
	b[65] = o.qindex ?? 100;
	return b;
}
/** VAEncSequenceParameterBufferVP9 (44 bytes). */
function vp9Seq(w: number, h: number, bps: number, intra: number): Uint8Array {
	const b = new Uint8Array(44), dv = new DataView(b.buffer);
	dv.setUint32(0, w, true), dv.setUint32(4, h, true), dv.setUint32(20, bps, true), dv.setUint32(24, intra, true);
	return b;
}
/** VAEncMiscParameterBuffer of a rate control (64 bytes) or a frame rate (28). */
const miscRc = (bps: number, pct: number) => {
	const b = new Uint8Array(64), dv = new DataView(b.buffer);
	dv.setUint32(0, 1, true), dv.setUint32(4, bps, true), dv.setUint32(8, pct, true);
	return b;
};
const miscFr = (num: number, den: number) => {
	const b = new Uint8Array(28), dv = new DataView(b.buffer);
	dv.setUint32(0, 0, true), dv.setUint32(4, (den << 16) | num, true);
	return b;
};
/** NV12 pixels of w x h (pitch (w + 63) & ~63) whose luma is all `y`. */
function nv12(w: number, h: number, y: number): { bytes: Uint8Array; pitch: number } {
	const pitch = (w + 63) & ~63, b = new Uint8Array(pitch * h + pitch * ((h + 1) >> 1));
	b.fill(y, 0, pitch * h);
	b.fill(128, pitch * h);
	return { bytes: b, pitch };
}

let picId = 0;
/** One `enc` as the driver sends it: buffers ([type, bytes] each), then the input. */
function encMsg(ctx: number, surface: number, bufs: [number, Uint8Array][], src: object = {}, pixels?: Uint8Array): { m: any; bin: Uint8Array } {
	const pic = ++picId;
	const parts = [...bufs.map(([, d]) => d), ...(pixels ? [pixels] : [])];
	const bin = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
	let o = 0;
	for (const p of parts) bin.set(p, o), (o += p.length);
	return { m: { op: "enc", ctx, surface, pic, profile: "vp9.0", bufs: bufs.map(([t, d]) => [t, d.length, 1]), src }, bin };
}
/** A picture of a w x h stream, its pixels sent (luma `y`, generation `gen` of the surface). */
function frameMsg(ctx: number, surface: number, w: number, h: number, y: number, o: { key?: boolean; gen?: number; extra?: [number, Uint8Array][]; qindex?: number; show?: boolean } = {}) {
	const px = nv12(w, h, y);
	const bufs: [number, Uint8Array][] = [...(o.key ? [[22, vp9Seq(w, h, 0, 250)] as [number, Uint8Array]] : []), ...(o.extra ?? []), [23, vp9Pic({ w, h, key: o.key, qindex: o.qindex, show: o.show })]];
	return encMsg(ctx, surface, bufs, { pixels: { gen: o.gen ?? 1, width: w, height: h, pitch: px.pitch } }, px.bytes);
}
const send = (s: ReturnType<typeof session>, x: { m: any; bin: Uint8Array }) => {
	s.enc.enc(x.m, x.bin);
	return x.m.pic as number;
};

test("probeEncoders: VP9 with CQP where the quantizer mode works, without it where not", async () => {
	const a = await probeEncoders(fakeEnc().wc, "no-preference");
	assert.deepEqual(a.profiles, ["vp9.0"]);
	assert.deepEqual(a.modes["vp9.0"], ["cqp", "cbr", "vbr"]);
	const b = await probeEncoders(fakeEnc({ noQuantizer: true }).wc, "no-preference");
	assert.deepEqual(b.modes["vp9.0"], ["cbr", "vbr"]);
	assert.deepEqual((await probeEncoders(undefined, "no-preference")).profiles, []);
	assert.equal(vp9Quantizer(0), 0);
	assert.equal(vp9Quantizer(100), 25);
	assert.equal(vp9Quantizer(255), 63);
	assert.equal(vp9Quantizer(250), 62);
});

test("encode: each picture's chunk in its notice, a key frame first and where asked, kept pixels reused", async () => {
	const fake = fakeEnc(), s = session(fake);
	assert.deepEqual(await s.enc.ctx({ id: 1, profile: "vp9.0", width: 64, height: 64, rc: "cqp" }), {});
	const pics: number[] = [];
	for (let i = 0; i < 6; i++) pics.push(send(s, frameMsg(1, 100 + (i % 3), 50, 30, 10 + i, { key: i === 0 || i === 4, gen: i + 1 })));
	for (let i = 0; i < 6; i++) {
		const n = await s.coded(pics[i]!);
		assert.equal(n.json.ev, "coded");
		assert.equal(n.json.err, undefined);
		assert.equal(n.bin![0], 10 + i, `picture ${i}: its own frame`);
		assert.equal(n.json.key, i === 0 || i === 4, `picture ${i}: key where asked`);
		assert.equal(n.json.kept, true);
	}
	const e = fake.encoders[0]!;
	assert.equal(fake.encoders.length, 1);
	assert.equal(e.configs.length, 1, "configured once");
	assert.equal(e.configs[0].codec, "vp09.00.10.08");
	assert.equal(e.configs[0].bitrateMode, "quantizer");
	assert.equal(e.configs[0].latencyMode, "realtime");
	assert.deepEqual([e.configs[0].width, e.configs[0].height], [50, 30]);
	assert.deepEqual(e.encodes[1]!.opts.vp9, { quantizer: 25 }, "CQP: qindex 100 is libvpx's quantizer 25");
	assert.deepEqual([e.encodes[0]!.w, e.encodes[0]!.h], [50, 30], "the visible picture is the source size, not the pitch");
	// timestamps rise
	assert.ok(e.encodes.every((x, i) => i === 0 || x.ts > e.encodes[i - 1]!.ts));
	// the surface unchanged: its kept pixels, nothing sent
	const k = send(s, encMsg(1, 102, [[23, vp9Pic({ w: 50, h: 30 })]], { kept: 6 }));
	const kn = await s.coded(k);
	assert.equal(kn.bin![0], 15, "the kept pixels of surface 102 (its 6th generation)");
	assert.equal(s.stats.kept, 1);
	// a kept generation the host does not have
	const bad = send(s, encMsg(1, 102, [[23, vp9Pic({ w: 50, h: 30 })]], { kept: 5 }));
	assert.match((await s.coded(bad)).json.err, /no kept pixels/);
	// surf_free forgets them
	s.enc.surfFree([102]);
	const gone = send(s, encMsg(1, 102, [[23, vp9Pic({ w: 50, h: 30 })]], { kept: 6 }));
	assert.match((await s.coded(gone)).json.err, /no kept pixels/);
	// a surface never written: black
	const black = send(s, encMsg(1, 106, [[23, vp9Pic({ w: 50, h: 30 })]], {}));
	assert.equal((await s.coded(black)).bin![0], 16);
	assert.equal(s.stats.uploads, 6);
	assert.equal(s.stats.black, 1);
	assert.equal(fake.frames.open, 0, "no frame left open");
	assert.equal(fake.frames.twice, 0);
	s.enc.close();
});

test("encode: rate control from the misc buffers; a change reconfigures without a key frame", async () => {
	const fake = fakeEnc(), s = session(fake);
	await s.enc.ctx({ id: 2, profile: "vp9.0", width: 64, height: 64, rc: "vbr" });
	// ffmpeg's -b:v 2M in VBR: maximum 4M, target 50%, 25 fps
	const a = send(s, frameMsg(2, 1, 64, 64, 1, { key: true, extra: [[27, miscRc(4_000_000, 50)], [27, miscFr(25, 1)]] }));
	const b = send(s, frameMsg(2, 2, 64, 64, 2));
	const c = send(s, frameMsg(2, 1, 64, 64, 3, { extra: [[27, miscRc(1_000_000, 100)]] }));
	for (const p of [a, b, c]) assert.equal((await s.coded(p)).json.err, undefined);
	const e = fake.encoders[0]!;
	assert.equal(e.configs.length, 2);
	assert.equal(e.configs[0].bitrateMode, "variable");
	assert.equal(e.configs[0].bitrate, 2_000_000);
	assert.equal(e.configs[0].framerate, 25);
	assert.equal(e.configs[1].bitrate, 1_000_000);
	assert.equal(e.encodes[2]!.opts.keyFrame, false, "a new rate needs no key frame");
	assert.equal(e.encodes[2]!.ts - e.encodes[1]!.ts, 40000, "25 fps: 40 ms apart");
	assert.equal(s.stats.reconfigures, 1);
	// without a rate: the sequence's, else about 0.1 bit a pixel
	await s.enc.ctx({ id: 3, profile: "vp9.0", width: 64, height: 64, rc: "cbr" });
	const px = nv12(64, 64, 9);
	const d = send(s, encMsg(3, 1, [[22, vp9Seq(64, 64, 300_000, 30)], [23, vp9Pic({ w: 64, h: 64, key: true })]], { pixels: { gen: 1, width: 64, height: 64, pitch: px.pitch } }, px.bytes));
	await s.coded(d);
	assert.equal(fake.encoders[1]!.configs[0].bitrateMode, "constant");
	assert.equal(fake.encoders[1]!.configs[0].bitrate, 300_000);
	assert.equal(fake.encoders[1]!.encodes[0]!.opts.vp9, undefined, "no quantizer outside CQP");
	// a mode the host does not offer: its first
	await s.enc.ctx({ id: 4, profile: "vp9.0", width: 64, height: 64, rc: "icq" });
	const f = send(s, frameMsg(4, 1, 64, 64, 1, { key: true }));
	await s.coded(f);
	assert.equal(fake.encoders[2]!.configs[0].bitrateMode, "quantizer");
	s.enc.close();
	assert.equal(fake.frames.open, 0);
});

test("encode: a failed encoder is made again, the pictures it owed encoded again from a key frame", async () => {
	const fake = fakeEnc({ failAt: 3, failEncoders: 1, delay: 2 }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	const pics: number[] = [];
	for (let i = 0; i < 6; i++) pics.push(send(s, frameMsg(1, 1 + i, 32, 32, 40 + i, { key: i === 0, gen: 1 })));
	const got = [];
	for (const p of pics) got.push(await s.coded(p));
	assert.deepEqual(got.map((n) => n.bin?.[0]), [40, 41, 42, 43, 44, 45], "every picture its own chunk");
	assert.ok(got.every((n) => !n.json.err));
	assert.equal(fake.encoders.length, 2);
	// the second encoder starts at the picture the first failed on, with a key frame
	assert.equal(fake.encoders[1]!.encodes[0]!.tag, 42);
	assert.equal(fake.encoders[1]!.encodes[0]!.opts.keyFrame, true);
	assert.equal(got[2]!.json.key, true);
	assert.equal(s.stats.recoveries, 1);
	assert.equal(s.stats.errors, 1);
	assert.equal(fake.frames.open, 0);
	s.enc.close();
});

test("encode: reclaimed (closed before its error callback), then a new picture: nothing lost", async () => {
	const fake = fakeEnc({ delay: 5 }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	const a = send(s, frameMsg(1, 1, 32, 32, 1, { key: true }));
	const b = send(s, frameMsg(1, 2, 32, 32, 2));
	// as Chrome reclaims: closed now, the error callback a task later; a picture comes in between
	const e0 = fake.encoders[0]!;
	e0.state = "closed";
	const c = send(s, frameMsg(1, 3, 32, 32, 3));
	setTimeout(() => e0.fail(Object.assign(new Error("Codec reclaimed due to inactivity."), { name: "QuotaExceededError" })), 1);
	const got = await Promise.all([a, b, c].map((p) => s.coded(p)));
	assert.deepEqual(got.map((n) => n.bin?.[0]), [1, 2, 3]);
	assert.equal(fake.encoders[1]!.encodes[0]!.opts.keyFrame, true, "the new encoder starts with a key frame");
	assert.equal(s.stats.reclaims, 1);
	assert.equal(fake.frames.open, 0);
	s.enc.close();
});

test("encode: inject reclaim, error and flush every few pictures: every picture its own chunk", async () => {
	const fake = fakeEnc({ delay: 1 }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	s.enc.inject("reclaim", Infinity, 3);
	s.enc.inject("flush", Infinity, 4);
	s.enc.inject("error", Infinity, 5);
	// two pictures in flight, as ffmpeg's async_depth 2
	const pics: number[] = [], got: Notice[] = [];
	for (let i = 0; i < 20; i++) {
		pics.push(send(s, frameMsg(1, 1 + (i % 4), 32, 32, 60 + i, { key: i === 0, gen: i + 1 })));
		if (i >= 1) got.push(await s.coded(pics[i - 1]!));
	}
	got.push(await s.coded(pics[19]!));
	assert.deepEqual(got.map((n) => n.bin?.[0] ?? n.json.err), pics.map((_, i) => 60 + i));
	assert.ok(got.every((n) => !n.json.err));
	assert.ok(s.stats.reclaims >= 5 && s.stats.errors >= 3, JSON.stringify(s.stats));
	s.enc.close();
	assert.equal(fake.frames.open, 0);
	assert.equal(fake.frames.twice, 0);
});

test("encode: an encoder that holds its output is flushed by the stall timer", async () => {
	const fake = fakeEnc({ hold: true }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	const t0 = Date.now();
	const a = send(s, frameMsg(1, 1, 32, 32, 7, { key: true }));
	const n = await s.coded(a);
	assert.equal(n.bin![0], 7);
	assert.ok(Date.now() - t0 >= 900, "after the first stall timer (1 s before any latency sample)");
	assert.equal(s.stats.flushes, 1);
	s.enc.close();
});

test("encode: a flush that gives nothing: a new encoder encodes them again", async () => {
	const fake = fakeEnc({ hold: true, dropOnFlush: true }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	const a = send(s, frameMsg(1, 1, 32, 32, 7, { key: true }));
	// every encoder drops: after RECOVER_MAX new ones the picture fails rather than hang
	const n = await s.coded(a, 8000);
	assert.match(n.json.err, /failed again/);
	assert.ok(s.stats.flushes >= 3);
	assert.equal(fake.frames.open, 0);
	s.enc.close();
});

test("encode: an encoder that always fails: pictures fail (each tries once more), nothing hangs or leaks", async () => {
	const fake = fakeEnc({ failAt: "always" }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	const pics = [];
	for (let i = 0; i < 4; i++) pics.push(send(s, frameMsg(1, 1, 32, 32, i, { key: i === 0, gen: i + 1 })));
	const got = await Promise.all(pics.map((p) => s.coded(p)));
	assert.ok(got.every((n) => /failed/.test(n.json.err)), JSON.stringify(got.map((n) => n.json)));
	assert.ok(fake.encoders.length <= 2 + pics.length, `${fake.encoders.length} encoders`);
	assert.equal(fake.frames.open, 0);
	assert.equal(s.stats.failed, 4);
	s.enc.close();
});

test("encode: decoded pictures as inputs (their frames cloned and closed), a missing one fails", async () => {
	const fake = fakeEnc(), VF = fake.wc.VideoFrame;
	const dec = new Map<number, () => EncSource | null>();
	// the decoder's frames: the session closes them after use() returns (the encoder side clones)
	const decoded: { close(): void }[] = [];
	for (const [id, tag] of [[500, 77], [501, 78]] as const)
		dec.set(id, () => {
			const px = nv12(48, 32, tag);
			const f = new VF(px.bytes, { format: "NV12", codedWidth: px.pitch, codedHeight: 32, visibleRect: { x: 0, y: 0, width: 48, height: 32 }, layout: [{ offset: 0, stride: px.pitch }, { offset: px.pitch * 32, stride: px.pitch }], timestamp: 9 });
			decoded.push(f);
			queueMicrotask(() => f.close());
			return { frame: f, data: null, width: 48, height: 32 };
		});
	dec.set(502, () => ({ frame: null, data: nv12(48, 32, 79).bytes, width: 48, height: 32 }));
	const s = session(fake, dec);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 64, height: 64, rc: "cqp" });
	// a picture with pixels behind two decoded ones keeps its order
	const a = send(s, encMsg(1, 7, [[23, vp9Pic({ w: 48, h: 32, key: true })]], { pic: 500 }));
	const b = send(s, encMsg(1, 8, [[23, vp9Pic({ w: 48, h: 32 })]], { pic: 501 }));
	const c = send(s, frameMsg(1, 9, 48, 32, 80));
	const d = send(s, encMsg(1, 7, [[23, vp9Pic({ w: 48, h: 32 })]], { pic: 502 }));
	const e = send(s, encMsg(1, 7, [[23, vp9Pic({ w: 48, h: 32 })]], { pic: 999 }));
	const got = await Promise.all([a, b, c, d, e].map((p) => s.coded(p)));
	assert.deepEqual(got.slice(0, 4).map((n) => n.bin?.[0]), [77, 78, 80, 79]);
	assert.deepEqual(fake.encoders[0]!.encodes.map((x) => x.tag), [77, 78, 80, 79], "in picture order");
	assert.match(got[4]!.json.err, /no decoded picture/);
	assert.equal(s.stats.decoded, 4);
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(fake.frames.open, 0, "the clones closed after their chunks");
	assert.equal(fake.frames.twice, 0);
	s.enc.close();
});

test("encode: ctx_free with pictures in flight: they complete, then the encoder is closed", async () => {
	const fake = fakeEnc({ delay: 20 }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	const pics = [0, 1, 2].map((i) => send(s, frameMsg(1, 1 + i, 32, 32, i + 1, { key: i === 0 })));
	assert.equal(s.enc.free(1), true);
	assert.equal(s.enc.free(1), false);
	const got = await Promise.all(pics.map((p) => s.coded(p)));
	assert.deepEqual(got.map((n) => n.bin?.[0]), [1, 2, 3]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(fake.encoders[0]!.state, "closed");
	assert.equal(s.stats.encoders, 0);
	assert.equal(s.stats.contexts, 0);
	assert.equal(s.host.closed.length, 1);
	// a picture for it now fails
	const late = send(s, frameMsg(1, 1, 32, 32, 9));
	assert.match((await s.coded(late)).json.err, /no encode context/);
	assert.equal(fake.frames.open, 0);
});

test("encode: hostile input", async () => {
	const fake = fakeEnc(), s = session(fake);
	assert.match(((await s.enc.ctx({ id: 1, profile: "h264.high", width: 32, height: 32 })) as any).err, /no encoder/);
	assert.match(((await s.enc.ctx({ id: 1, profile: "vp9.0", width: 0, height: 32 })) as any).err, /bad size/);
	assert.match(((await s.enc.ctx({ id: 1, profile: "vp9.0", width: 1e9, height: 32 })) as any).err, /bad size/);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	// buffers beyond the frame: the stream cannot go on (the session ends it)
	assert.throws(() => s.enc.enc({ op: "enc", ctx: 1, surface: 1, pic: ++picId, bufs: [[23, 132, 2]], src: {} }, new Uint8Array(132)), /beyond/);
	assert.throws(() => s.enc.enc({ op: "enc", ctx: 1, surface: 1, pic: -1, bufs: [], src: {} }, new Uint8Array(0)), /picture id/);
	const errs: string[] = [];
	const errOf = async (x: { m: any; bin: Uint8Array }) => {
		send(s, x);
		errs.push((await s.coded(x.m.pic)).json.err);
	};
	// no picture parameters; too short ones; a silly size
	await errOf(encMsg(1, 1, [[22, vp9Seq(32, 32, 0, 0)]]));
	await errOf(encMsg(1, 1, [[23, new Uint8Array(40)]]));
	await errOf(encMsg(1, 1, [[23, vp9Pic({ w: 0, h: 99999 })]]));
	// pixels: a layout that does not fit, fewer bytes than it says, a pitch below the width
	const px = nv12(32, 32, 1);
	await errOf(encMsg(1, 1, [[23, vp9Pic({ w: 32, h: 32 })]], { pixels: { gen: 1, width: 32, height: 32, pitch: 64 } }, px.bytes.subarray(0, 100)));
	await errOf(encMsg(1, 1, [[23, vp9Pic({ w: 32, h: 32 })]], { pixels: { gen: 1, width: 32, height: 32, pitch: 16 } }, px.bytes));
	await errOf(encMsg(1, 1, [[23, vp9Pic({ w: 32, h: 32 })]], { pixels: { gen: 1, width: 1e6, height: 32, pitch: 2e6 } }, px.bytes));
	await errOf(encMsg(9, 1, [[23, vp9Pic({ w: 32, h: 32 })]]));
	assert.equal(errs.length, 7);
	assert.ok(errs.every((e) => typeof e === "string" && e.length > 0), JSON.stringify(errs));
	// a misc buffer of nonsense is ignored; a picture asking for a hidden frame is encoded shown (logged once)
	const junk = new Uint8Array(64).fill(0xff);
	const ok = send(s, frameMsg(1, 1, 32, 32, 5, { key: true, show: false, extra: [[27, junk], [27, new Uint8Array(2)]] }));
	assert.equal((await s.coded(ok)).bin![0], 5);
	assert.equal(s.stats.hidden, 1);
	assert.equal(s.logs.filter((l) => /hidden frames/.test(l)).length, 1);
	assert.equal(fake.frames.open, 0);
	s.enc.close();
});

test("encode: the stream's end closes everything and sends nothing more", async () => {
	const fake = fakeEnc({ delay: 30 }), s = session(fake);
	await s.enc.ctx({ id: 1, profile: "vp9.0", width: 32, height: 32, rc: "cqp" });
	send(s, frameMsg(1, 1, 32, 32, 1, { key: true }));
	send(s, encMsg(1, 7, [[23, vp9Pic({ w: 32, h: 32 })]], { pic: 1234 }));
	s.enc.close();
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(s.notices.length, 0);
	assert.equal(fake.encoders[0]!.state, "closed");
	assert.equal(fake.frames.open, 0);
});

// ---- through VaHost (va.ts): the hello, an encode context, a decoded picture as the input ----

async function withHost(fake: FakeEnc, fn: (g: Guest, host: VaHost, dec: Fake) => Promise<void>, gpu?: VaGpu) {
	const glob = globalThis as Record<string, unknown>;
	const dec = fakeWebCodecs({ name: "decode order", hold: 0, honourReorder: false, drop: false, ts: "pass" });
	Object.assign(glob, { VideoDecoder: dec.VideoDecoder, EncodedVideoChunk: dec.EncodedVideoChunk, VideoEncoder: fake.wc.VideoEncoder, VideoFrame: fake.wc.VideoFrame });
	const logs: string[] = [];
	const g = guest();
	const host = startVa(prepareVa(true, true, (m) => logs.push(m)), g.vsock, (m) => logs.push(m), gpu)!;
	try {
		g.connect();
		await fn(g, host, dec);
	} finally {
		host.shutdown();
		for (const k of ["VideoDecoder", "EncodedVideoChunk", "VideoEncoder", "VideoFrame"]) delete glob[k];
	}
}

/** the notice of an encode picture */
const codedOf = (g: Guest, pic: number) => g.next((f) => f.json.ev === "coded" && f.json.pic === pic);

test("VaHost: the hello offers VP9 encode, an encode context encodes pictures sent and decoded ones", async () => {
	const fake = fakeEnc();
	await withHost(fake, async (g, host) => {
		const hello = await g.call({ op: "hello", version: 4 });
		assert.deepEqual(hello.json.encode, { "vp9.0": ["cqp", "cbr", "vbr"] });
		assert.deepEqual(host.status.encode, ["vp9.0"]);
		assert.equal((await g.call({ op: "ctx", id: 1, profile: "vp9.0", width: 16, height: 16 })).json.err, undefined);
		assert.equal((await g.call({ op: "ctx", id: 2, profile: "vp9.0", width: 64, height: 64, entry: "enc", rc: "vbr" })).json.err, undefined);
		// a decoded picture (the fake decoder's output has the chunk's tag as its luma) on surface 7, encoded from there
		const d = vp9Dec(g, 1, 7, VP9_KEY(91));
		const x = encMsg(2, 7, [[23, vp9Pic({ w: 16, h: 16, key: true })]], { pic: d });
		g.send(x.m, x.bin);
		const a = await codedOf(g, x.m.pic);
		assert.equal(a.json.err, undefined);
		assert.equal(a.bin[0], 91, "the decoded picture's pixels, not sent");
		// pixels sent, then the same surface unchanged
		const y = frameMsg(2, 8, 16, 16, 33, { gen: 4 });
		g.send(y.m, y.bin);
		const b = await codedOf(g, y.m.pic);
		assert.equal(b.bin[0], 33);
		assert.equal(b.json.kept, true);
		const z = encMsg(2, 8, [[23, vp9Pic({ w: 16, h: 16 })]], { kept: 4 });
		g.send(z.m, z.bin);
		assert.equal((await codedOf(g, z.m.pic)).bin[0], 33);
		// buffers beyond the frame: the picture's notice says so (the driver waits for it); the stream goes on
		const pic = 9000;
		g.send({ op: "enc", ctx: 2, surface: 8, pic, bufs: [[23, 132, 9]], src: {} }, new Uint8Array(132));
		assert.match((await codedOf(g, pic)).json.err, /beyond/);
		const st = host.stats.encode;
		assert.equal(st.decoded, 1);
		assert.equal(st.uploads, 1);
		assert.equal(st.kept, 1);
		assert.equal(st.list.length, 1);
		assert.equal(st.list[0]!.codec, "vp09.00.10.08");
		// surf_free: the host forgets the kept pixels; ctx_free closes the encoder
		g.send({ op: "surf_free", surfaces: [8] });
		const w = encMsg(2, 8, [[23, vp9Pic({ w: 16, h: 16 })]], { kept: 4 });
		g.send(w.m, w.bin);
		assert.match((await codedOf(g, w.m.pic)).json.err, /no kept pixels/);
		g.send({ op: "ctx_free", id: 2 });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(host.stats.encode.encoders, 0);
		assert.equal(host.stats.encode.list[0]!.open, false);
		assert.equal(fake.frames.open, 0);
	});
});

test("VaHost: a decoded picture still pending is waited for; its surface decoded into again first does not take it", async () => {
	const fake = fakeEnc();
	await withHost(fake, async (g) => {
		await g.call({ op: "hello", version: 4 });
		await g.call({ op: "ctx", id: 1, profile: "vp9.0", width: 16, height: 16 });
		await g.call({ op: "ctx", id: 2, profile: "vp9.0", width: 64, height: 64, entry: "enc", rc: "cqp" });
		// the encode names the picture before it is decoded (the app gave the surface to the encoder at once), then the surface is decoded into again
		const d = vp9Dec(g, 1, 7, VP9_KEY(51));
		const x = encMsg(2, 7, [[23, vp9Pic({ w: 16, h: 16, key: true })]], { pic: d });
		g.send(x.m, x.bin);
		vp9Dec(g, 1, 7, VP9_INTER(52));
		assert.equal((await codedOf(g, x.m.pic)).bin[0], 51);
		// a picture that is not the surface's: refused
		const y = encMsg(2, 9, [[23, vp9Pic({ w: 16, h: 16 })]], { pic: d });
		g.send(y.m, y.bin);
		assert.match((await codedOf(g, y.m.pic)).json.err, /no decoded picture/);
		assert.equal(fake.frames.open, 0);
	});
});

test("VaHost: on the GPU path a decoded picture's held frame is encoded (cloned, not copied), and closed after", async () => {
	const fake = fakeEnc();
	// a renderer that draws frames: decoder outputs are held for their first consumer
	const gpu: VaGpu = { write: () => true, video: () => null };
	await withHost(fake, async (g, host, dec) => {
		await g.call({ op: "hello", version: 4 });
		await g.call({ op: "ctx", id: 1, profile: "vp9.0", width: 16, height: 16 });
		await g.call({ op: "ctx", id: 2, profile: "vp9.0", width: 64, height: 64, entry: "enc", rc: "cqp" });
		const d = vp9Dec(g, 1, 7, VP9_KEY(61));
		await g.next((f) => f.json.ev === "ready" && f.json.pic === d);
		assert.equal(host.stats.framesHeld, 1, "held for its first consumer");
		const x = encMsg(2, 7, [[23, vp9Pic({ w: 16, h: 16, key: true })]], { pic: d });
		g.send(x.m, x.bin);
		assert.equal((await codedOf(g, x.m.pic)).bin[0], 61);
		assert.equal(host.stats.copies, 0, "the frame went to the encoder uncopied");
		assert.equal(fake.frames.open, 0, "the encoder side's clones closed");
		assert.equal(host.stats.framesHeld, 1, "still held: the encoder only cloned it");
		// a later readback of the same picture: its first consumer that needs NV12 copies the held frame then
		const got = await g.read(7, d);
		assert.equal(got.y, 61);
		assert.equal(host.stats.copies, 1);
		assert.equal(host.stats.framesHeld, 0);
		g.send({ op: "surf_free", surfaces: [7] });
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(host.stats.framesHeld, 0);
		assert.equal(dec.frames.open, 0);
		assert.equal(dec.frames.twice, 0);
	}, gpu);
});
