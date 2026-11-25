// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's host (js/core/va.ts) against decoders that are not the one
// its H.264 model describes (test/va-fake.ts): holding more pictures than
// declared or up to the DPB, ignoring the declared reorder depth, dropping
// late pictures or not, sorted timestamps, refusing Annex B or the VUI. Each
// runs H.264 (B-pyramid over two IDR periods, P-only) and VP9 (with a
// hidden frame) as a single-threaded app does (plain: each picture synced
// and read right after its own output delay) and as a decode-ahead one;
// every picture must come out as its own, and the stalls (hold-timer
// fires), fillers, flushes and restarts of each are reported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputModel } from "../js/core/va-h264.ts";
import { prepareVa, startVa, type VaHost, type VaOptions } from "../js/core/va.ts";
import { fakeWebCodecs, type FakeDecoderKind, guest, type Guest, h264Dec, h264Stream, type H264Pic, VP9_HIDDEN, VP9_INTER, VP9_KEY, vp9Dec } from "./va-fake.ts";

const KINDS: FakeDecoderKind[] = [
	{ name: "libavcodec (the model)", libavcodec: true, hold: 0, honourReorder: true, drop: true, ts: "pass" },
	{ name: "holds 1 more", hold: 1, honourReorder: true, drop: false, ts: "pass" },
	{ name: "holds 1 more, drops late ones", hold: 1, honourReorder: true, drop: true, ts: "pass" },
	{ name: "holds 2 more", hold: 2, honourReorder: true, drop: false, ts: "pass" },
	{ name: "holds to the DPB", hold: "dpb", honourReorder: true, drop: false, ts: "pass" },
	{ name: "ignores the reorder depth, holds 4", hold: 4, honourReorder: false, drop: false, ts: "pass" },
	{ name: "decode order at once", hold: 0, honourReorder: false, drop: false, ts: "pass" },
	{ name: "sorted timestamps", hold: 0, honourReorder: true, drop: false, ts: "sorted" },
	{ name: "sorted timestamps, holds 1 more", hold: 1, honourReorder: true, drop: false, ts: "sorted" },
	{ name: "needs a description (avcC)", hold: 0, honourReorder: true, drop: true, ts: "pass", needsDescription: true },
	{ name: "rejects the VUI", hold: 0, honourReorder: true, drop: false, ts: "pass", rejectsVui: true },
];

async function withFake(kind: FakeDecoderKind, opts: VaOptions, fn: (g: Guest, host: VaHost, logs: string[]) => Promise<void>) {
	const glob = globalThis as Record<string, unknown>;
	const fake = fakeWebCodecs(kind);
	Object.assign(glob, { VideoDecoder: fake.VideoDecoder, EncodedVideoChunk: fake.EncodedVideoChunk });
	const logs: string[] = [];
	const g = guest();
	const host = startVa(prepareVa(opts, true, (m) => logs.push(m)), g.vsock, (m) => logs.push(m))!;
	try {
		g.connect();
		await g.call({ op: "hello", version: 4 });
		await fn(g, host, logs);
	} finally {
		host.shutdown();
		delete glob.VideoDecoder;
		delete glob.EncodedVideoChunk;
	}
}

const PYRAMID = [0, 8, 4, 2, 6, 16, 12, 10, 14, 24, 20, 18, 22, 28, 26, 0, 8, 4, 2, 6, 12, 10];
const PONLY = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

/**
 * An H.264 stream as an app with libavcodec's output delay `delay` (the
 * stream's own) decodes it: plain (each output read before the next
 * picture goes in) or ahead (every picture in, then each read). Returns
 * the tags read, in output order, and the tags expected.
 */
async function runH264(g: Guest, pics: H264Pic[], delay: number, plain: boolean): Promise<{ got: number[]; want: number[] }> {
	assert.ok((await g.call({ op: "ctx", id: 7, profile: "h264.high", width: 16, height: 16 })).json.r > 0);
	const model = new OutputModel();
	const surf = new Map<number, number>(), tags = new Map<number, number>();
	const got: number[] = [], want: number[] = [], order: number[] = [];
	for (const [i, p] of pics.entries()) {
		const id = h264Dec(g, 7, i + 1, p);
		surf.set(id, i + 1);
		tags.set(id, p.tag);
		const out = model.push({ pic: id, poc: p.poc, key: p.idr, mmco: false }, delay).out;
		if (out) order.push(out.pic);
		if (plain && out) {
			got.push((await g.read(surf.get(out.pic)!, out.pic)).y);
			want.push(tags.get(out.pic)!);
		}
	}
	// the end: what the app's decoder still holds comes out in POC order
	const rest = model.delayed.slice().sort((a, b) => a.poc - b.poc).map((q) => q.pic);
	if (!plain) for (const id of order) got.push((await g.read(surf.get(id)!, id)).y), want.push(tags.get(id)!);
	for (const id of rest) got.push((await g.read(surf.get(id)!, id)).y), want.push(tags.get(id)!);
	return { got, want };
}

async function runVp9(g: Guest, plain: boolean): Promise<{ got: number[]; want: number[] }> {
	assert.ok((await g.call({ op: "ctx", id: 8, profile: "vp9.0", width: 16, height: 16 })).json.r > 0);
	const frames = [VP9_KEY(1), VP9_INTER(2), VP9_HIDDEN(3, 0x04), VP9_INTER(4), VP9_INTER(5), VP9_INTER(6), VP9_HIDDEN(7, 0x02), VP9_INTER(8), VP9_INTER(9), VP9_INTER(10)];
	// a hidden frame's picture is what the show_existing_frame the host adds gives: 200 + its slot
	const tags = [1, 2, 202, 4, 5, 6, 201, 8, 9, 10];
	const got: number[] = [], ids: number[] = [];
	for (const [i, f] of frames.entries()) {
		ids.push(vp9Dec(g, 8, 100 + i, f));
		if (plain) got.push((await g.read(100 + i, ids[i]!)).y);
	}
	if (!plain) for (const [i, id] of ids.entries()) got.push((await g.read(100 + i, id)).y);
	return { got, want: tags };
}

const rows: string[] = [];
const row = (kind: string, what: string, host: VaHost, ms: number) => {
	const s = host.stats, c = s.contexts[s.contexts.length - 1]!;
	const line = `${kind.padEnd(34)} ${what.padEnd(16)} ${String(s.holdFires).padStart(3)} stalls ${String(s.fillers).padStart(3)} fillers ${String(s.flushes).padStart(3)} flushes ${String(s.restarts).padStart(2)} restarts ${String(s.fallbacks).padStart(2)} fallbacks  ${c.mode}${c.adapter.reorder !== undefined ? ` reorder ${c.adapter.reorder} ${c.adapter.packaging}` : ""}  ${ms} ms`;
	rows.push(line);
	return s;
};

for (const kind of KINDS) {
	test(`decoder "${kind.name}": H.264 B-pyramid and P-only, VP9, plain and ahead: every picture its own`, async () => {
		for (const plain of [true, false]) {
			for (const [what, pocs, delay] of [["B-pyramid", PYRAMID, 2], ["P-only", PONLY, 0]] as const) {
				await withFake(kind, {}, async (g, host) => {
					const t0 = Date.now();
					const { got, want } = await runH264(g, h264Stream([...pocs]), delay, plain);
					assert.deepEqual(got, want, `${what} ${plain ? "plain" : "ahead"}: the pictures read`);
					const s = row(kind.name, `${what} ${plain ? "plain" : "ahead"}`, host, Date.now() - t0);
					assert.equal(s.failed, 0);
				});
			}
			if (kind.needsDescription || kind.rejectsVui) continue;
			await withFake(kind, {}, async (g, host) => {
				const t0 = Date.now();
				const { got, want } = await runVp9(g, plain);
				assert.deepEqual(got, want, `VP9 ${plain ? "plain" : "ahead"}: the pictures read`);
				const s = row(kind.name, `VP9 ${plain ? "plain" : "ahead"}`, host, Date.now() - t0);
				assert.equal(s.failed, 0);
			});
		}
	});
}

test("the model's decoder: no stall in a single-threaded app but the stream's end (one 100 ms flush per IDR period at most)", async () => {
	await withFake(KINDS[0]!, {}, async (g, host) => {
		await runH264(g, h264Stream([...PYRAMID]), 2, true);
		const s = host.stats;
		assert.equal(s.contexts[0]!.mode, "model");
		assert.ok(s.holdFires <= 2, `${s.holdFires} stalls`);
		assert.equal(s.modeSwitches, 0);
	});
});

test("a decoder that holds one more: one stall in model mode, then conservative with a filler per picture and no flush", async () => {
	await withFake(KINDS[1]!, {}, async (g, host, logs) => {
		await runH264(g, h264Stream([...PYRAMID]), 2, true);
		const s = host.stats, c = s.contexts[0]!;
		assert.equal(c.mode, "conservative");
		assert.match(c.modeWhy!, /did not come/);
		assert.equal(logs.filter((l) => /conservative mode:/.test(l)).length, 1, "one log line when it switches");
		assert.ok(s.fillers > 5, `${s.fillers} fillers`);
		assert.equal(s.failed, 0);
	});
});

test("VaOptions.mode conservative: every context starts there; later contexts of a profile that disagreed start there too", async () => {
	await withFake(KINDS[0]!, { mode: "conservative" }, async (g, host) => {
		await runH264(g, h264Stream([...PONLY]), 0, true);
		assert.equal(host.stats.contexts[0]!.mode, "conservative");
		assert.equal(host.stats.contexts[0]!.modeWhy, "VaOptions.mode");
	});
	await withFake(KINDS[1]!, {}, async (g, host) => {
		await runH264(g, h264Stream([...PYRAMID]), 2, true);
		g.send({ op: "ctx_free", id: 7 });
		await new Promise((r) => setTimeout(r, 20));
		await runH264(g, h264Stream([...PONLY], undefined, 60), 0, true);
		const cs = host.stats.contexts;
		assert.deepEqual(cs.map((c) => [c.open, c.mode]), [[true, "conservative"], [false, "conservative"]]);
		assert.match(cs[0]!.modeWhy!, /earlier context/);
	});
});

test("stats: what a report from real hardware needs, per context", async () => {
	await withFake(KINDS[9]!, {}, async (g, host, logs) => {
		await runH264(g, h264Stream([...PONLY]), 0, true);
		const c = host.stats.contexts[0]!;
		assert.equal(c.profile, "h264.high");
		assert.match(c.codec!, /^avc1\.64/);
		assert.equal(c.description, true, "avcC after Annex B failed");
		assert.equal(c.fallbacks, 1);
		assert.equal(c.format, "I420");
		assert.equal(c.adapter.packaging, "avcc");
		assert.ok(["hardware", "software", "hardware or software"].includes(c.decoder));
		assert.ok(c.pictures === PONLY.length && c.frames >= PONLY.length);
		assert.ok(logs.some((l) => /failed before its first picture.*trying/.test(l)));
	});
});

test("report", () => {
	console.log(`\nfake decoder                       stream              stalls  fillers  flushes  restarts fallbacks  mode\n${rows.join("\n")}`);
});
