// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's host (js/core/va.ts): the lifetime of decoder outputs
// (VideoFrames) with a GPU that can draw them (va.md, Frame lifetime), on
// the fake decoders of test/va-fake.ts, which count frames not closed yet.
// Video processing into an exported BGRX surface draws the frame on the
// GPU and closes it uncopied; a readback, an NV12 export, the cap (4 per
// context), the context's end copy it to NV12; the surface rendered again
// or freed, and the stream's end, close it; AV1-like display pictures
// share one frame; fillers' and replays' outputs are closed at once. No
// frame is left open or closed twice on any path, and a colour space the
// vpp did not ask for, a failing draw, VaOptions.upload "cpu" go the CPU
// way, counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareVa, startVa, type VaGpu, type VaHost, type VaOptions } from "../js/core/va.ts";
import { type Fake, fakeWebCodecs, type FakeDecoderKind, guest, type Guest, h264Dec, h264Stream, VP9_INTER, VP9_KEY, vp9Dec } from "./va-fake.ts";

const VP9: FakeDecoderKind = { name: "vp9", hold: 0, honourReorder: false, drop: false, ts: "pass", colorSpace: { matrix: "bt709", fullRange: false } };

/** A GPU whose textures are byte arrays: write() as the renderer's, video() draws a frame as [tag, tag, tag, 255] texels, read() gives a texture back. */
function fakeGpu(sizes: Record<number, [number, number, number]>) {
	const tex = new Map<number, Uint8Array>();
	const drawn: number[] = [];
	let fail: string | null = null;
	const gpu: VaGpu = {
		write(res, box, fill) {
			const s = sizes[res];
			if (!s || box.x || box.y || box.width !== s[0] || box.height !== s[1]) return false;
			const b = new Uint8Array(s[0] * s[1] * s[2]);
			fill(b);
			tex.set(res, b);
			return true;
		},
		video(res, frame, w, h) {
			const s = sizes[res];
			if (fail) return fail;
			if (!s || s[2] !== 4) return "no such texture";
			const tag = (frame as unknown as { tag: number }).tag, b = tex.get(res) ?? new Uint8Array(s[0] * s[1] * 4);
			for (let y = 0; y < Math.min(h, s[1]); y++) for (let x = 0; x < Math.min(w, s[0]); x++) b.set([tag, tag, tag, 255], (y * s[0] + x) * 4);
			tex.set(res, b);
			drawn.push(tag);
			return null;
		},
		read(res, box) {
			const t = tex.get(res), s = sizes[res];
			return t && s && box.width === s[0] && box.height === s[1] ? t.slice() : null;
		},
	};
	return { gpu, tex, drawn, failWith: (why: string | null) => void (fail = why) };
}

async function withGpu(kind: FakeDecoderKind, opts: VaOptions, gpu: VaGpu, fn: (g: Guest, host: VaHost, fake: Fake, logs: string[]) => Promise<void>) {
	const glob = globalThis as Record<string, unknown>;
	const fake = fakeWebCodecs(kind);
	Object.assign(glob, { VideoDecoder: fake.VideoDecoder, EncodedVideoChunk: fake.EncodedVideoChunk });
	const logs: string[] = [];
	const g = guest();
	const host = startVa(prepareVa(opts, true, (m) => logs.push(m)), g.vsock, (m) => logs.push(m), gpu)!;
	try {
		g.connect();
		assert.equal((await g.call({ op: "hello", version: 4 })).json.export, true);
		assert.ok((await g.call({ op: "ctx", id: 7, profile: "vp9.0", width: 16, height: 16 })).json.r > 0);
		await fn(g, host, fake, logs);
	} finally {
		host.shutdown();
		delete glob.VideoDecoder;
		delete glob.EncodedVideoChunk;
	}
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const vpp = (g: Guest, surface: number, pic: number, src: number, srcPic: number, matrix = "bt709") => g.send({ op: "vpp", surface, pic, src, srcPic, matrix, inFull: false, outFull: true });
const bgrx = (g: Guest, surface: number, res: number) => g.call({ op: "export", surface, pic: 0, width: 16, height: 16, format: "BGRX", res: [res] });

test("frames: video processing draws the frame on the GPU and closes it uncopied; a later readback of its input learns to copy", async () => {
	const f = fakeGpu({ 50: [16, 16, 4] });
	await withGpu(VP9, {}, f.gpu, async (g, host, fake, logs) => {
		await bgrx(g, 5, 50);
		// the vpp before its input is decoded (mpv: the input's output may not have come yet)
		const p1 = vp9Dec(g, 7, 1, VP9_KEY(41));
		vpp(g, 5, 900, 1, p1);
		assert.equal((await g.next((x) => x.json.pic === 900)).json.ev, "ready");
		assert.deepEqual(f.drawn, [41], "drawn before the notice");
		let st = host.stats;
		assert.deepEqual([st.gpuUploads, st.cpuConversions, st.copies, st.framesHeld, fake.frames.open, fake.frames.twice], [1, 0, 0, 0, 0, 0]);
		// read back: the texture, as importers see it
		const rb = await g.call({ op: "get", surface: 5, pic: 900 });
		assert.deepEqual([rb.json.format, rb.json.width, rb.json.pitches[0], ...rb.bin.subarray(0, 4)], ["BGRX", 16, 64, 41, 41, 41, 255]);
		// the input read back after the GPU took its frame: a stand-in (failed) this once, then frames are copied too
		const r1 = await g.call({ op: "get", surface: 1, pic: p1 });
		assert.match(r1.json.failed, /went to the GPU/);
		assert.ok(logs.some((l) => /read back after video processing drew its frame/.test(l)));
		const p2 = vp9Dec(g, 7, 2, VP9_INTER(42));
		vpp(g, 5, 901, 2, p2);
		await g.next((x) => x.json.pic === 901);
		assert.equal((await g.read(2, p2)).y, 42, "exact after the GPU draw");
		await settle();
		st = host.stats;
		assert.deepEqual([st.gpuUploads, st.copies, st.framesHeld, fake.frames.open, fake.frames.twice], [2, 1, 0, 0, 0]);
	});
});

test("frames: a colour space other than the one asked for, a failing draw, upload: cpu, an unexported output go the CPU way; each counted, every frame closed", async () => {
	const f = fakeGpu({ 50: [16, 16, 4], 60: [16, 16, 4] });
	await withGpu(VP9, {}, f.gpu, async (g, host, fake) => {
		await bgrx(g, 5, 50);
		// BT.601 asked of a BT.709 frame
		const p1 = vp9Dec(g, 7, 1, VP9_KEY(41));
		vpp(g, 5, 900, 1, p1, "bt601");
		await g.next((x) => x.json.pic === 900);
		// the draw fails (a GL error)
		f.failWith("GL error 0x502");
		const p2 = vp9Dec(g, 7, 2, VP9_INTER(42));
		vpp(g, 5, 901, 2, p2);
		await g.next((x) => x.json.pic === 901);
		f.failWith(null);
		// forced
		host.setOptions({ upload: "cpu" });
		const p3 = vp9Dec(g, 7, 3, VP9_INTER(43));
		vpp(g, 5, 902, 3, p3);
		await g.next((x) => x.json.pic === 902);
		host.setOptions({ upload: "auto" });
		// a BGRX surface not exported (ffmpeg's scale_vaapi + hwdownload): converted, read back as BGRX
		const p4 = vp9Dec(g, 7, 4, VP9_INTER(44));
		vpp(g, 6, 903, 4, p4);
		await g.next((x) => x.json.pic === 903);
		const rb = await g.call({ op: "get", surface: 6, pic: 903 });
		assert.deepEqual([rb.json.format, rb.json.width, rb.json.height], ["BGRX", 16, 16]);
		assert.equal(f.drawn.length, 0);
		await settle();
		const st = host.stats;
		assert.deepEqual(st.gpuFallbacks, { colour: 1, "the draw failed": 1, "upload: cpu": 1, "not exported": 1 });
		assert.deepEqual([st.cpuConversions, st.copies, st.framesHeld, fake.frames.open, fake.frames.twice], [3, 4, 0, 0, 0]);
		// the inputs' NV12 stays exact
		for (const [s, p, t] of [[1, p1, 41], [2, p2, 42], [3, p3, 43], [4, p4, 44]] as const) assert.equal((await g.read(s, p)).y, t);
	});
});

test("frames: at most 4 held per context, the oldest copied beyond; readback copies a held frame; surface reuse, surf_free, ctx_free and the stream's end close the rest", async () => {
	const f = fakeGpu({});
	await withGpu(VP9, {}, f.gpu, async (g, host, fake) => {
		const pics: number[] = [];
		for (let i = 0; i < 7; i++) pics.push(vp9Dec(g, 7, i + 1, i ? VP9_INTER(60 + i) : VP9_KEY(60)));
		for (const p of pics) await g.next((x) => x.json.ev && x.json.pic === p);
		await settle();
		let st = host.stats;
		assert.deepEqual([st.framesHeld, st.framesEvicted, st.copies, fake.frames.open], [4, 3, 3, 4], "4 held, the 3 oldest copied");
		assert.ok(st.framesHeldPeak <= 7);
		// read back: the evicted from their copy, the held ones copied now; all exact
		for (let i = 0; i < 7; i++) assert.equal((await g.read(i + 1, pics[i]!)).y, 60 + i);
		st = host.stats;
		assert.deepEqual([st.framesHeld, st.copies, fake.frames.open], [0, 7, 0]);
		// held, then its surface rendered again: closed uncopied
		const a = vp9Dec(g, 7, 1, VP9_INTER(70));
		await g.next((x) => x.json.ev && x.json.pic === a);
		assert.equal(fake.frames.open, 1);
		const b = vp9Dec(g, 7, 1, VP9_INTER(71));
		await g.next((x) => x.json.ev && x.json.pic === b);
		assert.equal(fake.frames.open, 1, "a's frame closed, b's held");
		// freed
		g.send({ op: "surf_free", surfaces: [1] });
		await settle();
		assert.equal(fake.frames.open, 0);
		// an NV12 export: copied at once (exact planes), not held
		await g.call({ op: "export", surface: 2, pic: 0, width: 16, height: 16, res: [11, 12] });
		const c = vp9Dec(g, 7, 2, VP9_INTER(72));
		await g.next((x) => x.json.ev && x.json.pic === c);
		assert.equal(fake.frames.open, 0);
		// the context's end: its held frames copied (still readable)
		const d = vp9Dec(g, 7, 3, VP9_INTER(73));
		await g.next((x) => x.json.ev && x.json.pic === d);
		assert.equal(fake.frames.open, 1);
		g.send({ op: "ctx_free", id: 7 });
		await settle();
		assert.equal(fake.frames.open, 0);
		assert.equal((await g.read(3, d)).y, 73);
		// the stream's end: closed uncopied
		assert.ok((await g.call({ op: "ctx", id: 8, profile: "vp9.0", width: 16, height: 16 })).json.r > 0);
		const e = vp9Dec(g, 8, 4, VP9_KEY(74));
		await g.next((x) => x.json.ev && x.json.pic === e);
		assert.equal(fake.frames.open, 1);
		const copies = host.stats.copies;
		g.end();
		await settle();
		assert.deepEqual([fake.frames.open, fake.frames.twice, host.stats.framesHeld, host.stats.copies], [0, 0, 0, copies]);
	});
});

test("frames: a picture that writes a second surface (AV1's display picture) shares one frame: drawn once, closed once; an input decoded over while its vpp waits", async () => {
	const f = fakeGpu({ 50: [16, 16, 4] });
	await withGpu(VP9, {}, f.gpu, async (g, host, fake) => {
		await bgrx(g, 5, 50);
		// the picture on surface 1 also writes surface 2 (picture 500), the vpp reads the display picture
		const p1 = g.dec(7, 1, "vp9.0", [[0, 16, 1], [4, 48, 1], [5, VP9_KEY(81).length, 1]], (() => {
			const d = VP9_KEY(81), sp = new Uint8Array(48);
			new DataView(sp.buffer).setUint32(0, d.length, true);
			return new Uint8Array([...new Uint8Array(16), ...sp, ...d]);
		})(), [0, 0, 0, 0, 0, 0, 0, 0], { display: [2, 500] });
		vpp(g, 5, 900, 2, 500);
		await g.next((x) => x.json.pic === 900);
		assert.deepEqual(f.drawn, [81]);
		assert.deepEqual([fake.frames.open, fake.frames.twice], [0, 0]);
		g.send({ op: "surf_free", surfaces: [1, 2] });
		await settle();
		assert.equal(fake.frames.twice, 0);
		void p1;
		// the input's surface given back and decoded into again before the input came out (an orphan the vpp still waits for)
		const slow = vp9Dec(g, 7, 3, VP9_INTER(82));
		vpp(g, 5, 901, 3, slow);
		vp9Dec(g, 7, 3, VP9_INTER(83));
		await g.next((x) => x.json.pic === 901);
		await settle();
		assert.deepEqual(f.drawn, [81, 82]);
		assert.deepEqual([fake.frames.open, fake.frames.twice, host.stats.framesHeld], [1, 0, 1], "only 83's frame is held");
	});
});

test("frames: an H.264 decoder holding more than declared (fillers, flushes and replays) leaves no frame open", async () => {
	const f = fakeGpu({ 50: [16, 16, 4] });
	const kind: FakeDecoderKind = { name: "holds 2 more", hold: 2, honourReorder: true, drop: false, ts: "pass", colorSpace: { matrix: null, fullRange: null } };
	await withGpu(kind, { mode: "conservative" }, f.gpu, async (g, host, fake) => {
		await bgrx(g, 5, 50);
		assert.ok((await g.call({ op: "ctx", id: 9, profile: "h264.high", width: 16, height: 16 })).json.r > 0);
		const pics = h264Stream([0, 2, 4, 6, 8, 10, 12, 14]);
		for (const [i, p] of pics.entries()) {
			const id = h264Dec(g, 9, 10 + i, p);
			// as mpv: sync, then convert for the compositor (BT.601: frames without a matrix)
			g.send({ op: "wait", pic: id });
			await g.next((x) => x.json.ev && x.json.pic === id, 8000);
			vpp(g, 5, 1000 + i, 10 + i, id, "bt601");
			await g.next((x) => x.json.pic === 1000 + i);
		}
		const st = host.stats;
		assert.ok(st.fillers + st.flushes > 0, "the decoder held pictures");
		assert.equal(st.gpuUploads, 8);
		assert.deepEqual(f.drawn, pics.map((p) => p.tag));
		g.end();
		await settle();
		assert.deepEqual([fake.frames.open, fake.frames.twice], [0, 0]);
	});
});
