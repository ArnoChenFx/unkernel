// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's H.264 adapter (js/core/va-h264.ts) without a browser: the
// bit writer and reader, emulation prevention, SPS and PPS written and read
// back, the SPS and PPS the adapter makes from VA's parameters checked
// against the real ones of x264 streams (Baseline, High with B-frames,
// custom scaling lists in the PPS, MBAFF) as ffmpeg's vaapi_h264.c fills
// VA's buffers from them, slice headers of those streams, the output model
// (libavcodec's) and its reorder depth, levels, and the refusals.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	annexBUnits, avcCodecString, BitReader, BitWriter, h264Adapter, type H264Pps, type H264Sps, leastReorder, nalUnit, OutputModel, parsePps, parseSliceHeader, parseSps,
	pickLevel, type ScalingLists, streamReorder, unescapeRbsp, VA_H264_IQ_SIZE, VA_H264_PIC_SIZE, VA_H264_SLICE_SIZE, writePps, writeSps,
} from "../js/core/va-h264.ts";
import { VA_BUF, type VaPicture } from "../js/core/va.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
const bitsOf = (f: (w: BitWriter) => void) => {
	const w = new BitWriter();
	f(w);
	let s = "";
	const n = w.bits;
	while (w.bits % 8) w.bit(0);
	for (const b of w.bytes()) s += b.toString(2).padStart(8, "0");
	return s.slice(0, n);
};

// x264 (ffmpeg 7.1's libx264) streams of test/va: SPS, PPS, and the first 48 bytes of an IDR, a P and a B slice
const X264 = {
	baseline: {
		sps: "6742c01fd9005005bb0110000003001000000303c0f1832480", pps: "68cb83cb20",
		idr: "6588845f1c478ffc0f30001011f6561e854d90f7a9875decb7faab8c0140663f8b5c64a3539fd79a4fc2ed45b77eaf16",
		p: "419a384e372568117743efae1d5710ff976d57d1bbbffffad56becefbfd6bfffa238ffffeae7eb408c5ddddcf37b598f",
	},
	high: {
		sps: "6764001facd9405005bb0110000003001000000303c0f1831960", pps: "68e938f2c8b0",
		idr: "65888403ff5bd6576f3ffd4fa9c53bed56d74817e9db7cb837f01f92d3ceea5ee0cb18ce443b0b4b6ec8055d22e04699",
		p: "419a246c7fcde4ed7d6c90c6ec959935a67930d90b1f0d299555e4058136498071d050ccb2b637acf63a4a370bae48af",
		b: "419e427888fff3a2cde3a8cfde61727c366e94008f1aefeac220d63d1f5d1ef081567744df92329cea3d36a68dfacb19",
	},
	cqm: {
		sps: "6764001facd9405005bb0110000003001000000303c0f1831960",
		pps: "68ebe3cb39461020ca392429c6211630810651c9214e310848210c7114899a698c86388a44cd10944231c86d127245459220852a92497525f93f27939b24942110a89a23292495249bd492ea4bf5f4bd7264a2c0",
		idr: "65888403ff5bd6576f3fe35e42198f18da7bebc392f6fc9d363b172dba44fc0f4cfe8230eb8c184daaa720201ea376cf",
		b: "419e427888fff3a2cde3a8cd1f9fdbf42c3c2f4e5f7be69fe00bb4793b83350bf20dcaa563ea1821562ec4617142bbb3",
	},
	mbaff: {
		sps: "67640020acd940500bbf2e0220000003002000000783e2c5b2c0", pps: "68fba3cb22c0",
		idr: "6588820b3f595226a026bdad101d88682530deb3917be4d5eff2dfa597c76414316525eac1a2ff2c4647923c07c27201",
		b: "419e415f888ff0bee08fea5ec748efdb756c641d42e5af87131bf75f40f58337eae8b3ad1b25f037f925143a8dda668e",
	},
};
const spsOf = (h: string) => parseSps(unescapeRbsp(hex(h)));
const ppsOf = (h: string) => parsePps(unescapeRbsp(hex(h)));

test("BitWriter: fixed-length and exp-Golomb codes, read back by BitReader", () => {
	assert.equal(bitsOf((w) => w.ue(0)), "1");
	assert.equal(bitsOf((w) => w.ue(1)), "010");
	assert.equal(bitsOf((w) => w.ue(2)), "011");
	assert.equal(bitsOf((w) => w.ue(3)), "00100");
	assert.equal(bitsOf((w) => w.ue(7)), "0001000");
	assert.equal(bitsOf((w) => w.se(1)), "010");
	assert.equal(bitsOf((w) => w.se(-1)), "011");
	assert.equal(bitsOf((w) => w.se(-3)), "00111");
	assert.equal(bitsOf((w) => w.u(5, 0b10110)), "10110");
	assert.equal(bitsOf((w) => w.ue(0xfffffffe)), "0".repeat(31) + "1" + "1".repeat(31));
	assert.throws(() => new BitWriter().u(3, 8), RangeError);
	assert.throws(() => new BitWriter().ue(-1), RangeError);
	const w = new BitWriter();
	w.bit(1);
	assert.throws(() => w.bytes(), /not byte aligned/);
	// random values round trip
	let seed = 1;
	const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
	const vals: [string, number, number][] = [];
	const w2 = new BitWriter();
	for (let i = 0; i < 500; i++) {
		const k = rnd(3);
		if (k === 0) {
			const n = 1 + rnd(32), v = rnd(2 ** Math.min(n, 31));
			w2.u(n, v), vals.push(["u", n, v]);
		} else if (k === 1) {
			const v = rnd(2 ** (1 + rnd(31)));
			w2.ue(v), vals.push(["ue", 0, v]);
		} else {
			const v = rnd(200001) - 100000;
			w2.se(v), vals.push(["se", 0, v]);
		}
	}
	w2.trailing();
	const r = new BitReader(w2.bytes());
	for (const [k, n, v] of vals) assert.equal(k === "u" ? r.u(n) : k === "ue" ? r.ue() : r.se(), v);
	assert.equal(r.more(), false, "only the stop bit is left");
});

test("nalUnit / unescapeRbsp: emulation prevention bytes in and out", () => {
	const rbsp = Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0x80]);
	const nal = nalUnit(7, 3, rbsp);
	assert.deepEqual([...nal], [0x67, 0, 0, 3, 0, 0, 3, 0, 1, 0, 0, 3, 2, 0, 0, 3, 3, 0, 0, 4, 0x80]);
	assert.deepEqual([...unescapeRbsp(nal)], [...rbsp]);
	assert.deepEqual([...nalUnit(1, 0, Uint8Array.from([5, 0]))], [1, 5, 0, 3], "a trailing zero byte is protected");
	assert.deepEqual(annexBUnits(Uint8Array.from([0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 0, 0, 1, 0x65, 3])).map((u) => [...u]), [[0x67, 1], [0x68, 2], [0x65, 3]]);
});

test("SPS and PPS: x264's parsed, written and parsed again to the same fields", () => {
	const b = spsOf(X264.baseline.sps), h = spsOf(X264.high.sps), m = spsOf(X264.mbaff.sps);
	assert.deepEqual([b.profileIdc, b.constraintFlags, b.levelIdc, b.pocType, b.maxNumRefFrames, b.widthMbs, b.heightMapUnits], [66, 0xc0, 31, 2, 3, 80, 45]);
	assert.deepEqual([h.profileIdc, h.levelIdc, h.pocType, h.log2MaxPocLsb, h.log2MaxFrameNum, h.direct8x8Inference], [100, 31, 0, 6, 4, true]);
	assert.deepEqual(h.vui?.bitstreamRestriction, { maxNumReorderFrames: 2, maxDecFrameBuffering: 4 }, "x264's VUI: b-pyramid, 3 B-frames");
	assert.equal(h.vui?.other, true, "x264 writes aspect ratio, video signal type and timing too");
	assert.deepEqual([m.frameMbsOnly, m.mbAdaptiveFrameField, m.heightMapUnits, m.levelIdc], [false, true, 23, 32]);
	for (const s of [b, h, m]) {
		const again = parseSps(writeSps(s));
		assert.deepEqual({ ...again, vui: again.vui?.bitstreamRestriction }, { ...s, vui: s.vui?.bitstreamRestriction });
	}
	const hp = ppsOf(X264.high.pps), cq = ppsOf(X264.cqm.pps);
	assert.deepEqual([hp.entropyCodingMode, hp.weightedPred, hp.weightedBipredIdc, hp.transform8x8Mode, hp.numRefIdxL0Default, hp.numRefIdxL1Default, hp.scaling], [true, true, 2, true, 4, 1, null]);
	assert.equal(cq.scaling?.length, 8, "x264 puts a cqmfile's lists into the PPS");
	assert.deepEqual(cq.scaling![0], [6, 12, 19, 26, 14, 21, 27, 33, 22, 28, 33, 39, 29, 34, 40, 44], "raster order, as the cqmfile gives it");
	for (const p of [ppsOf(X264.baseline.pps), hp, cq, ppsOf(X264.mbaff.pps)]) assert.deepEqual(parsePps(writePps(p)), p);
	assert.equal(avcCodecString(h), "avc1.64001F");
	assert.equal(avcCodecString(b), "avc1.42C01F");
});

test("parseSliceHeader: x264's slices, as far as the SPS and PPS say", () => {
	const ctxOf = (sps: H264Sps, pps: H264Pps) => ({ ...sps, ...pps, chromaArrayType: 1 });
	const h = ctxOf(spsOf(X264.high.sps), ppsOf(X264.high.pps));
	const idr = parseSliceHeader(hex(X264.high.idr), h, { counts: [3, 1] });
	assert.deepEqual([idr.nalType, idr.refIdc, idr.firstMb, idr.sliceType, idr.ppsId, idr.frameNum, idr.idrPicId, idr.pocLsb, idr.noOutputOfPriorPics, idr.mmco5], [5, 3, 0, 2, 0, 0, 0, 0, false, false]);
	const p = parseSliceHeader(hex(X264.high.p), h, { counts: [3, 1] });
	assert.deepEqual([p.sliceType, p.frameNum, p.override], [0, 1, true]);
	const bs = parseSliceHeader(hex(X264.high.b), h, { counts: [2, 1] });
	assert.deepEqual([bs.refIdc, bs.sliceType, bs.directSpatial, bs.override], [2, 1, true, true], "a reference B (b-pyramid), spatial direct");
	assert.deepEqual(parseSliceHeader(hex(X264.high.b)), { nalType: 1, refIdc: 2, firstMb: 0, sliceType: 1, ppsId: 0 }, "without a context: up to the PPS id");
	const m = parseSliceHeader(hex(X264.mbaff.b), ctxOf(spsOf(X264.mbaff.sps), ppsOf(X264.mbaff.pps)), { counts: [2, 1] });
	assert.equal(m.fieldPic, false, "MBAFF: frame pictures");
	assert.throws(() => parseSliceHeader(Uint8Array.from([0x62, 0x88])), /data partitioning/);
	assert.throws(() => parseSliceHeader(Uint8Array.from([0x74, 0x88])), /MVC/);
	assert.throws(() => parseSliceHeader(Uint8Array.from([0xe5, 0x88])), /forbidden_zero_bit/);
});

// ---- VA's buffers as ffmpeg's vaapi_h264.c fills them ----

/** The effective scaling lists (fall-back rule B in the PPS over rule A in the SPS), or null for flat. */
function effectiveLists(sps: H264Sps, pps: H264Pps): ScalingLists | null {
	const flat4 = new Array(16).fill(16), flat8 = new Array(64).fill(16);
	const seq = (sps.scaling ?? []).slice();
	const pic = pps.scaling;
	if (!sps.scaling && !pic) return null;
	const out: number[][] = [];
	for (let i = 0; i < 8; i++) {
		const own = pic ? pic[i] : seq[i];
		const fallback = i === 0 || i === 3 || i === 6 || i === 7 ? (pic && sps.scaling ? (seq[i] ?? (i < 6 ? flat4 : flat8)) : i < 6 ? flat4 : flat8) : out[i - 1]!;
		out.push(own ?? fallback);
	}
	return out;
}

interface PicOpts {
	poc: number;
	frameNum: number;
	ref?: boolean;
	surface?: number;
}

function vaPicParams(sps: H264Sps, pps: H264Pps, o: PicOpts): Uint8Array {
	const d = new Uint8Array(VA_H264_PIC_SIZE), dv = new DataView(d.buffer);
	const pic = (at: number, surface: number, flags: number, top: number, bottom: number) => {
		dv.setUint32(at, surface, true);
		dv.setUint32(at + 8, flags, true);
		dv.setInt32(at + 12, top, true);
		dv.setInt32(at + 16, bottom, true);
	};
	pic(0, o.surface ?? 1, 0, o.poc, o.poc);
	for (let i = 0; i < 16; i++) pic(36 + 36 * i, 0xffffffff, 1, 0, 0);
	dv.setUint16(612, sps.widthMbs - 1, true);
	dv.setUint16(614, sps.heightMapUnits * (sps.frameMbsOnly ? 1 : 2) - 1, true);
	d[616] = sps.bitDepthLuma - 8;
	d[617] = sps.bitDepthChroma - 8;
	d[618] = sps.maxNumRefFrames;
	const seq = sps.chromaFormatIdc | (+sps.separateColourPlane << 2) | (+sps.gapsInFrameNumAllowed << 3) | (+sps.frameMbsOnly << 4) | (+sps.mbAdaptiveFrameField << 5) |
		(+sps.direct8x8Inference << 6) | (+(sps.levelIdc >= 31) << 7) | ((sps.log2MaxFrameNum - 4) << 8) | (sps.pocType << 12) | ((sps.log2MaxPocLsb - 4) << 14) |
		(+sps.deltaPicOrderAlwaysZero << 18);
	dv.setUint32(620, seq, true);
	dv.setInt8(628, pps.picInitQp - 26);
	dv.setInt8(629, pps.picInitQs - 26);
	dv.setInt8(630, pps.chromaQpIndexOffset);
	dv.setInt8(631, pps.secondChromaQpIndexOffset);
	const picf = +pps.entropyCodingMode | (+pps.weightedPred << 1) | (pps.weightedBipredIdc << 2) | (+pps.transform8x8Mode << 4) | (+pps.constrainedIntraPred << 6) |
		(+pps.bottomFieldPicOrderInFramePresent << 7) | (+pps.deblockingFilterControlPresent << 8) | (+pps.redundantPicCntPresent << 9) | (+(o.ref ?? true) << 10);
	dv.setUint32(632, picf, true);
	dv.setUint16(636, o.frameNum, true);
	return d;
}

function vaIq(lists: ScalingLists | null): Uint8Array {
	const d = new Uint8Array(VA_H264_IQ_SIZE).fill(16, 0, 224);
	if (lists) lists.forEach((l, i) => d.set(l!, i < 6 ? 16 * i : 96 + 64 * (i - 6)));
	return d;
}

function vaSlice(nal: Uint8Array, firstMb: number, sliceType: number, l0: number, l1: number): Uint8Array {
	const d = new Uint8Array(VA_H264_SLICE_SIZE), dv = new DataView(d.buffer);
	dv.setUint32(0, nal.length, true);
	dv.setUint16(14, firstMb, true);
	d[16] = sliceType;
	d[18] = l0 - 1;
	d[19] = l1 - 1;
	return d;
}

let picId = 0;
function vaPicture(sps: H264Sps, pps: H264Pps, slices: { nal: Uint8Array; l0?: number; l1?: number }[], o: PicOpts): VaPicture {
	const bufs: VaPicture["bufs"] = [
		{ type: VA_BUF.picture, size: VA_H264_PIC_SIZE, num: 1, data: vaPicParams(sps, pps, o) },
		{ type: VA_BUF.iqMatrix, size: VA_H264_IQ_SIZE, num: 1, data: vaIq(effectiveLists(sps, pps)) },
	];
	for (const s of slices) {
		const h = parseSliceHeader(s.nal);
		bufs.push({ type: VA_BUF.sliceParameter, size: VA_H264_SLICE_SIZE, num: 1, data: vaSlice(s.nal, h.firstMb, h.sliceType, s.l0 ?? pps.numRefIdxL0Default, s.l1 ?? pps.numRefIdxL1Default) });
		bufs.push({ type: VA_BUF.sliceData, size: s.nal.length, num: 1, data: s.nal });
	}
	return { pic: ++picId, surface: o.surface ?? 1, profile: "h264.high", width: sps.widthMbs * 16, height: sps.heightMapUnits * 16, bufs, refs: [] };
}

/** The SPS and PPS the adapter put before the slices of its chunk, and the slices. */
function unitsOf(data: Uint8Array) {
	const us = annexBUnits(data);
	assert.deepEqual(us.slice(0, 2).map((u) => u[0]! & 31), [7, 8], "SPS and PPS first");
	return { sps: parseSps(unescapeRbsp(us[0]!)), pps: parsePps(unescapeRbsp(us[1]!)), slices: us.slice(2) };
}

test("h264Adapter: the SPS and PPS made from VA's parameters parse every slice as x264's do", () => {
	const parsing = (s: H264Sps) => [s.chromaFormatIdc, s.bitDepthLuma, s.log2MaxFrameNum, s.pocType, s.log2MaxPocLsb, s.deltaPicOrderAlwaysZero, s.maxNumRefFrames, s.gapsInFrameNumAllowed,
		s.widthMbs, s.heightMapUnits, s.frameMbsOnly, s.mbAdaptiveFrameField, s.direct8x8Inference];
	// (the default reference counts are not known from an IDR's I slices, nor needed: the PPS id test has them)
	const ppsParsing = (p: H264Pps) => [p.entropyCodingMode, p.bottomFieldPicOrderInFramePresent, p.weightedPred, p.weightedBipredIdc,
		p.picInitQp, p.picInitQs, p.chromaQpIndexOffset, p.deblockingFilterControlPresent, p.constrainedIntraPred, p.redundantPicCntPresent, p.transform8x8Mode,
		p.secondChromaQpIndexOffset];
	for (const [name, x, profile] of [["baseline", X264.baseline, "cb"], ["high", X264.high, "high"], ["cqm", X264.cqm, "high"], ["mbaff", X264.mbaff, "high"]] as const) {
		const sps = spsOf(x.sps), pps = ppsOf(x.pps), a = h264Adapter(profile);
		const [chunk] = a.picture(vaPicture(sps, pps, [{ nal: hex(x.idr) }], { poc: 0, frameNum: 0 }));
		assert.ok(chunk!.key, `${name}: an IDR is a key chunk`);
		const u = unitsOf(chunk!.data);
		assert.deepEqual(parsing(u.sps), parsing(sps), `${name}: SPS fields that parsing depends on`);
		assert.deepEqual(ppsParsing(u.pps), ppsParsing(pps), `${name}: PPS fields`);
		assert.deepEqual(effectiveLists(u.sps, u.pps), effectiveLists(sps, pps), `${name}: the effective scaling lists`);
		assert.deepEqual([u.sps.crop, u.sps.vui?.bitstreamRestriction?.maxNumReorderFrames, u.sps.profileIdc], [null, 0, profile === "cb" ? 66 : 100], `${name}: no cropping, reorder 0 to start`);
		assert.deepEqual([...u.slices[0]!], [...hex(x.idr)], `${name}: the slice as it was`);
		assert.equal(a.config()?.codec, avcCodecString(u.sps));
		// the same slice headers parse to the same values against both
		const ctx = (s: H264Sps, p: H264Pps) => ({ ...s, ...p, chromaArrayType: 1 });
		for (const k of ["p", "b"] as const) {
			const nal = (x as Record<string, string>)[k];
			if (!nal) continue;
			const counts: [number, number] = [pps.numRefIdxL0Default, pps.numRefIdxL1Default];
			assert.deepEqual(parseSliceHeader(hex(nal), ctx(u.sps, u.pps), { counts }), parseSliceHeader(hex(nal), ctx(sps, pps), { counts }), `${name}: its ${k} slice`);
		}
	}
});

test("h264Adapter: PPS ids from the slice header, default reference counts from slices that do not override them", () => {
	const sps = spsOf(X264.high.sps), pps = ppsOf(X264.high.pps);
	// a slice with pps id 3 and no override: the IDR's header bits again, with pic_parameter_set_id 3 (ue 00100 instead of 1)
	const w = new BitWriter();
	w.ue(0), w.ue(7), w.ue(3); // first_mb, slice_type (P, all slices), pps id
	w.u(4, 1); // frame_num
	w.u(6, 4); // pic_order_cnt_lsb
	w.u(1, 0); // num_ref_idx_active_override_flag
	w.u(1, 0); // ref_pic_list_modification_flag_l0
	w.ue(0), w.u(1, 0), w.u(1, 0); // pred_weight_table: denom 0, flags 0 (weighted_pred), chroma denom ...
	w.trailing();
	const nal = nalUnit(1, 2, w.bytes());
	const a = h264Adapter("high");
	a.picture(vaPicture(sps, pps, [{ nal: hex(X264.high.idr) }], { poc: 0, frameNum: 0 }));
	void nal;
	const w2 = new BitWriter();
	w2.ue(0), w2.ue(5), w2.ue(3), w2.u(4, 1), w2.u(6, 4), w2.u(1, 0), w2.u(1, 0), w2.u(1, 0), w2.trailing();
	const [c] = a.picture(vaPicture(sps, { ...pps, weightedPred: false }, [{ nal: nalUnit(1, 2, w2.bytes()), l0: 5 }], { poc: 4, frameNum: 1 }));
	const u = unitsOf(c!.data);
	assert.deepEqual([u.pps.ppsId, u.pps.numRefIdxL0Default], [3, 5], "the PPS has the slice's id and the count the slice used without override");
});

test("h264Adapter: refusals say why", () => {
	const sps = spsOf(X264.high.sps), pps = ppsOf(X264.high.pps), idr = [{ nal: hex(X264.high.idr) }];
	const bad = (patch: (d: Uint8Array) => void, re: RegExp) => {
		const p = vaPicture(sps, pps, idr, { poc: 0, frameNum: 0 });
		patch(p.bufs[0]!.data);
		assert.throws(() => h264Adapter("high").picture(p), re);
	};
	const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset);
	bad((d) => dv(d).setUint32(632, dv(d).getUint32(632, true) | 1 << 5, true), /field pictures/);
	bad((d) => (d[616] = 2), /bit depth of 10/);
	bad((d) => dv(d).setUint32(620, (dv(d).getUint32(620, true) & ~3) | 2, true), /chroma_format_idc 2/);
	bad((d) => (d[624] = 1), /FMO/);
	bad((d) => dv(d).setUint32(620, (dv(d).getUint32(620, true) & ~0x3000) | 0x1000, true), /pic_order_cnt_type 1/);
	bad((d) => dv(d).setUint16(636, 5, true), /frame_num 0 in the slice header, 5/);
});

test("OutputModel: libavcodec's output order, and the least reorder depth that drops nothing", () => {
	// I0 P8 B4 b2 b6 (b-pyramid), then P16 B12 b10 b14: decode order
	const pocs = [0, 8, 4, 2, 6, 16, 12, 10, 14];
	const pics = pocs.map((poc, i) => ({ pic: i + 1, poc, key: i === 0, mmco: false }));
	assert.equal(leastReorder(pics), 2);
	const run = (r: number) => {
		const m = new OutputModel(), out: number[] = [], dropped: number[] = [];
		for (const p of pics) {
			const o = m.push(p, r);
			if (o.out) out.push(o.out.poc);
			if (o.dropped) dropped.push(o.dropped.poc);
		}
		return { out, dropped, m };
	};
	assert.deepEqual(run(0).dropped, [4, 2, 6, 12, 10, 14], "reorder 0: every B dropped");
	const r2 = run(2);
	assert.deepEqual([r2.out, r2.dropped], [[0, 2, 4, 6, 8, 10, 12], []], "in POC order, two held");
	assert.ok(r2.m.held(6) && r2.m.held(9) && !r2.m.held(7), "P16 and b14 are held until more comes");
	// an IDR mid-stream: the pictures before it come out first
	const two = [...pics, { pic: 10, poc: 0, key: true, mmco: false }, { pic: 11, poc: 4, key: false, mmco: false }, { pic: 12, poc: 2, key: false, mmco: false }];
	assert.equal(leastReorder(two), 2);
	assert.equal(leastReorder(pocs.map((_, i) => ({ pic: i, poc: i * 2, key: i === 0, mmco: false }))), 0, "no reordering");
});

test("h264Adapter: a picture that would come out of order raises the reorder depth and asks for a restart", () => {
	const sps = spsOf(X264.high.sps), pps = ppsOf(X264.high.pps);
	const logs: string[] = [];
	const a = h264Adapter("high", (m) => logs.push(m));
	// x264's IDR, then non-reference I slices standing for P and B pictures: only the POCs VA gives matter here
	const at = (poc: number, idr: boolean) => {
		const w = new BitWriter();
		w.ue(0), w.ue(7), w.ue(0), w.u(4, 0), w.u(6, poc & 63), w.trailing(); // first_mb, slice_type, pps id, frame_num, pic_order_cnt_lsb
		return vaPicture(sps, pps, [{ nal: idr ? hex(X264.high.idr) : nalUnit(1, 0, w.bytes()) }], { poc, frameNum: 0, ref: idr });
	};
	const pics = [0, 8, 4, 2, 6].map((poc, i) => at(poc, i === 0));
	const chunks = pics.map((p) => a.picture(p)[0]!);
	assert.deepEqual(chunks.map((c) => !!c.restart), [false, false, true, true, false], "made again before the first B and before b2");
	assert.equal(a.state().reorder, 2);
	assert.equal(logs.length, 2);
	assert.equal(unitsOf(chunks[1]!.remake!()).sps.vui?.bitstreamRestriction?.maxNumReorderFrames, 2, "a replayed chunk carries the deeper reorder");
	assert.equal(unitsOf(chunks[1]!.data).sps.vui?.bitstreamRestriction?.maxNumReorderFrames, 0, "as it was first sent");
	// POC 0, 2 and 4 are out; 8 and 6 wait for more input
	assert.deepEqual(pics.map((p) => a.held!(p.pic)), [false, true, false, false, true]);
});

/** A non-reference picture of x264's High stream standing for any POC (an IDR when `idr`): only the POC VA gives matters. */
function pocPicture(poc: number, idr: boolean): VaPicture {
	const sps = spsOf(X264.high.sps), pps = ppsOf(X264.high.pps), w = new BitWriter();
	w.ue(0), w.ue(7), w.ue(0), w.u(4, 0), w.u(6, poc & 63), w.trailing();
	return vaPicture(sps, pps, [{ nal: idr ? hex(X264.high.idr) : nalUnit(1, 0, w.bytes()) }], { poc, frameNum: 0, ref: idr });
}

test("h264Adapter (conservative): the reorder depth is the stream's own (streamReorder), and a long period without an IDR costs little per picture", () => {
	let seed = 7;
	const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n;
	for (let round = 0; round < 20; round++) {
		const a = h264Adapter("high", undefined, "conservative");
		const periods: { pic: number; poc: number; key: boolean; mmco: boolean }[][] = [];
		for (let i = 0; i < 60; i++) {
			const idr = i === 0 || rnd(12) === 0, poc = idr ? 0 : 2 * rnd(40);
			const p = pocPicture(poc, idr);
			a.picture(p);
			if (idr) periods.push([]);
			periods.at(-1)!.push({ pic: p.pic, poc, key: idr, mmco: false });
		}
		assert.equal(a.state().reorder, Math.max(...periods.map((q) => streamReorder(q))), `round ${round}`);
	}
	// 3000 pictures after one IDR: each picture's cost grows with the period at most linearly (it took seconds when it was quadratic)
	const a = h264Adapter("high", undefined, "conservative");
	const t = performance.now();
	for (let i = 0; i < 3000; i++) a.picture(pocPicture(2 * i, i === 0));
	a.dropped!([1]);
	assert.ok(performance.now() - t < 3000, `3000 pictures in ${Math.round(performance.now() - t)} ms`);
});

test("h264Adapter: hostile buffers fail their picture, at little cost, and leave the adapter as it was", () => {
	const sps = spsOf(X264.high.sps), pps = ppsOf(X264.high.pps);
	// slice parameters naming the same bytes many times over (a 1 MiB buffer copied 256 times into the chunk)
	const p = vaPicture(sps, pps, [{ nal: hex(X264.high.idr) }], { poc: 0, frameNum: 0 });
	const nal = new Uint8Array(1 << 20);
	nal.set(hex(X264.high.idr));
	const one = vaSlice(nal, 0, 2, 1, 1), many = new Uint8Array(VA_H264_SLICE_SIZE * 256);
	for (let i = 0; i < 256; i++) many.set(one, VA_H264_SLICE_SIZE * i);
	p.bufs.splice(2, 2, { type: VA_BUF.sliceParameter, size: VA_H264_SLICE_SIZE, num: 256, data: many }, { type: VA_BUF.sliceData, size: nal.length, num: 1, data: nal });
	assert.throws(() => h264Adapter("high").picture(p), /slices of more bytes than their slice data buffer/);
	// frame_mbs_only 0 with one MB row: no SPS can say it; refused before anything changes (config() would throw after)
	const a = h264Adapter("high");
	const q = vaPicture(sps, pps, [{ nal: hex(X264.high.idr) }], { poc: 0, frameNum: 0 });
	const dv = new DataView(q.bufs[0]!.data.buffer);
	dv.setUint16(614, 0, true);
	dv.setUint32(620, dv.getUint32(620, true) & ~(1 << 4), true);
	assert.throws(() => a.picture(q), /1 MB row\(s\) without frame_mbs_only/);
	assert.equal(a.config(), null);
	// a replay (remake) takes the slices from the chunk, not from the guest's buffers (which it would keep alive)
	const r = vaPicture(sps, pps, [{ nal: hex(X264.high.idr) }], { poc: 0, frameNum: 0 });
	const [c] = h264Adapter("high").picture(r);
	r.bufs.find((b) => b.type === VA_BUF.sliceData)!.data.fill(0);
	assert.deepEqual([...unitsOf(c!.remake!()).slices[0]!], [...hex(X264.high.idr)]);
});

test("pickLevel: the smallest level for the size and DPB", () => {
	assert.deepEqual(pickLevel(120, 68, 4), { level: 40, dpb: 4 }, "1080p, 4 frames");
	assert.deepEqual(pickLevel(120, 68, 5), { level: 50, dpb: 13 });
	assert.deepEqual(pickLevel(80, 45, 3), { level: 31, dpb: 5 }, "720p");
	assert.deepEqual(pickLevel(80, 45, 3, true), { level: 31, dpb: 5 });
	assert.deepEqual(pickLevel(40, 30, 1), { level: 30, dpb: 6 });
	assert.deepEqual(pickLevel(240, 135, 4), { level: 51, dpb: 5 }, "4K");
	assert.deepEqual(pickLevel(500, 500, 1), { level: 62, dpb: 16 }, "beyond any level");
});
