// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's AV1 and HEVC adapters (js/core/va-av1.ts, va-hevc.ts)
// without a browser: AV1's bit codes (ns, su, leb128, the sub-exponential
// code of global motion against libavcodec's decoder of it), the sequence
// and frame headers read back, the decoder slots the AV1 adapter keeps
// (a picture stored in a slot the app no longer uses, or held for the next
// picture's map, or decoded again), the refusals; HEVC's reference picture
// set rebuilt from VA's ReferenceFrames and a slice header written again
// with it inline, its slice data kept; hostile buffers (slice and tile
// ranges repeating their bytes, slice header counts beyond the spec's) each
// refused at little cost. (Decoding is checked end to end by
// test/va/relay.mjs and check.mjs: .agents/va.md, Testing.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { av1Adapter, av1CodecString, av1TileGroups, av1Level, VA_AV1_PIC_SIZE, writeSequenceHeader, writeSignedSubexpWithRef } from "../js/core/va-av1.ts";
import { BitReader, BitWriter, leb128, sliceRanges, VA_BUF, type VaPicture } from "../js/core/va-codec.ts";
import { hevcAdapter, hevcNal, hevcRps, parseHevcSliceHeader, parseVaHevcPicParams, rewriteHevcSlice, VA_HEVC_PIC_SIZE, VA_HEVC_SLICE_SIZE, vaHevcSlices, type VaHevcPicParams } from "../js/core/va-hevc.ts";

test("AV1 bit codes: ns, su, leb128", () => {
	for (const n of [1, 2, 3, 5, 7, 8, 13, 64, 100])
		for (let v = 0; v < n; v++) {
			const w = new BitWriter();
			w.ns(n, v);
			w.su(7, v - 50);
			w.trailing();
			const r = new BitReader(w.bytes());
			assert.equal(r.ns(n), v);
			assert.equal(r.su(7), v - 50);
		}
	assert.deepEqual(leb128(0), [0]);
	assert.deepEqual(leb128(127), [127]);
	assert.deepEqual(leb128(128), [0x80, 1]);
	assert.deepEqual(leb128(300), [0xac, 2]);
});

// libavcodec's av1dec.c: inverse_recenter, decode_unsigned/signed_subexp_with_ref; the spec's decode_subexp
const inverseRecenter = (r: number, v: number) => (v > 2 * r ? v : v & 1 ? r - ((v + 1) >> 1) : r + (v >> 1));
function readSubexpWithRef(rd: BitReader, low: number, high: number, r: number): number {
	const mx = high - low;
	let i = 0, mk = 0, sub = 0;
	for (;;) {
		const b2 = i ? 3 + i - 1 : 3, a = 1 << b2;
		if (mx <= mk + 3 * a) {
			sub = rd.ns(mx - mk) + mk;
			break;
		}
		if (rd.u(1)) i++, (mk += a);
		else {
			sub = rd.u(b2) + mk;
			break;
		}
	}
	const rr = r - low;
	const x = rr << 1 <= mx ? inverseRecenter(rr, sub) : mx - 1 - inverseRecenter(mx - 1 - rr, sub);
	return x + low;
}

test("AV1 global motion: the sub-exponential code with reference decodes as libavcodec decodes it", () => {
	for (const absBits of [8, 9, 12]) {
		const mx = 1 << absBits;
		for (const r of [-mx, -mx + 1, -100, -1, 0, 1, 7, 100, mx - 1, mx])
			for (const v of [-mx, -mx + 3, -511, -8, -1, 0, 1, 8, 255, 511, mx - 1, mx]) {
				if (v < -mx || v > mx) continue;
				const w = new BitWriter();
				writeSignedSubexpWithRef(w, v, -mx, mx + 1, r);
				w.trailing();
				assert.equal(readSubexpWithRef(new BitReader(w.bytes()), -mx, mx + 1, r), v, `v ${v} r ${r} bits ${absBits}`);
			}
	}
});

test("AV1 sequence header: the fields read back; levels and codec strings", () => {
	const seq = { stillPicture: false, level: av1Level(1280, 720), maxWidth: 1280, maxHeight: 720, sb128: false, enableFilterIntra: true, enableIntraEdge: true, enableInterintra: true,
		enableMasked: true, enableDualFilter: true, enableOrderHint: true, enableJntComp: true, orderHintBits: 7, enableCdef: true, colorRange: false, chromaSamplePosition: 0, filmGrainPresent: true };
	const r = new BitReader(writeSequenceHeader(seq));
	assert.deepEqual([r.u(3), r.u(1), r.u(1), r.u(1), r.u(1), r.u(5), r.u(12), r.u(5)], [0, 0, 0, 0, 0, 0, 0, 5], "profile 0, one operating point, level 3.1");
	assert.deepEqual([r.u(4), r.u(4), r.u(16) + 1, r.u(16) + 1], [15, 15, 1280, 720]);
	assert.deepEqual([r.u(1), r.u(1), r.u(1), r.u(1), r.u(1), r.u(1), r.u(1), r.u(1), r.u(1)], [0, 0, 1, 1, 1, 1, 1, 1, 1], "frame ids off, 64x64 SBs, tools on, warped motion on");
	assert.deepEqual([r.u(1), r.u(1), r.u(1), r.u(1), r.u(3) + 1], [1, 1, 1, 1, 7], "jnt_comp, ref frame mvs, screen content and integer MVs chosen per frame, order hint bits");
	assert.deepEqual([r.u(1), r.u(1), r.u(1)], [1, 1, 1], "superres, cdef, restoration");
	assert.deepEqual([r.u(1), r.u(1), r.u(1), r.u(1), r.u(2), r.u(1), r.u(1)], [0, 0, 0, 0, 0, 1, 1], "8 bits, colour, separate_uv_delta_q, film grain");
	assert.deepEqual([av1Level(1920, 1080), av1Level(3840, 2160), av1Level(320, 240)], [8, 12, 0]);
	assert.equal(av1CodecString(8), "av01.0.08M.08");
});

/** An AV1 picture as ffmpeg's vaapi_av1.c sends it: 64x64, one tile of tag bytes, order hints of 7 bits. */
function av1Pic(pic: number, refs: number[], o: { type?: number; show?: boolean; hint?: number; refIdx?: number[]; bitDepth?: number; lst?: boolean } = {}): VaPicture {
	const pp = new Uint8Array(VA_AV1_PIC_SIZE), dv = new DataView(pp.buffer);
	pp[1] = 6; // order_hint_bits_minus_1
	pp[2] = o.bitDepth ?? 0;
	dv.setUint32(4, (1 << 7) | (1 << 9) | (1 << 12) | (1 << 13), true); // enable_order_hint, enable_cdef, 4:2:0
	dv.setUint16(32, 63, true);
	dv.setUint16(34, 63, true);
	(o.refIdx ?? [0, 1, 2, 3, 4, 5, 6]).forEach((v, i) => (pp[72 + i] = v));
	pp[79] = 7; // primary_ref_frame: none
	pp[80] = o.hint ?? pic;
	pp[416] = 1;
	pp[417] = 1;
	const type = o.type ?? (pic === 1 ? 0 : 1);
	dv.setUint32(676, type | ((o.show ?? true) ? 4 : 0) | (1 << 14) | (o.lst ? 1 << 16 : 0), true); // frame_type, show_frame, uniform tiles
	pp[680] = 8;
	pp[681] = 4; // switchable interpolation filter
	pp[697] = 100; // base_q_idx
	const tile = new Uint8Array(8).fill(pic), sp = new Uint8Array(40);
	new DataView(sp.buffer).setUint32(0, tile.length, true);
	return { pic, surface: pic, profile: "av1.0", width: 64, height: 64, refs, bufs: [{ type: VA_BUF.picture, size: VA_AV1_PIC_SIZE, num: 1, data: pp }, { type: VA_BUF.sliceParameter, size: 40, num: 1, data: sp }, { type: VA_BUF.sliceData, size: 8, num: 1, data: tile }] };
}

/** refresh_frame_flags of an inter frame's chunk (temporal delimiter, then the frame header OBU after the sequence header if any). */
function refreshOf(chunk: Uint8Array): number {
	let i = 0;
	while (i < chunk.length) {
		const type = (chunk[i]! >> 3) & 15, size = chunk[i + 1]!;
		if (type === 3) {
			const r = new BitReader(chunk.subarray(i + 2, i + 2 + size));
			r.u(1);
			const ft = r.u(2), show = r.u(1);
			if (!show) r.u(1);
			r.u(1), r.u(1), r.u(1), r.u(1); // error_resilient, disable_cdf_update, allow_screen_content_tools, frame_size_override
			r.u(7);
			if (ft === 1) r.u(3); // primary_ref_frame
			return r.u(8);
		}
		i += 2 + size;
	}
	throw new Error("no frame header");
}

test("AV1 slots: a picture goes into a slot the app no longer uses; with none free it waits for the next picture's map, or is decoded again", () => {
	const a = av1Adapter(64, 64);
	assert.equal(a.mode(), "model");
	const key = a.picture(av1Pic(1, []));
	assert.equal(key.length, 1);
	assert.ok(key[0]!.key);
	assert.deepEqual(a.state().slots, [1, 1, 1, 1, 1, 1, 1, 1]);
	// inter pictures 2..8, each referring to the app's slots: stored in a second copy of the key frame
	let map = [1, 1, 1, 1, 1, 1, 1, 1];
	for (let pic = 2; pic <= 8; pic++) {
		const c = a.picture(av1Pic(pic, map));
		assert.equal(c.length, 1);
		assert.equal(refreshOf(c[0]!.data), 1 << (pic - 1), `picture ${pic} into slot ${pic - 1}`);
		map = map.slice();
		map[pic - 1] = pic; // the app stores it in its slot pic - 1 as well
	}
	assert.deepEqual(a.state().slots, [1, 2, 3, 4, 5, 6, 7, 8]);
	// the app's map holds 8 pictures: picture 9 has no free slot and waits for the next picture
	const nine = a.picture(av1Pic(9, map));
	assert.ok(nine[0]!.hold, "held for the next picture");
	// the next picture's map shows the app kept 9 in place of 4: stored where 4 was
	const next = map.slice();
	next[3] = 9;
	const made = nine[0]!.hold!(av1Pic(10, next));
	assert.equal(refreshOf(made.data), 1 << 3);
	assert.deepEqual(a.state().slots, [1, 2, 3, 9, 5, 6, 7, 8]);
	// 10 is waited for at once (no next picture): not stored; picture 11's map keeps it, so 10 is decoded again, hidden, first
	const ten = a.picture(av1Pic(10, next));
	const tenNow = ten[0]!.hold!(null);
	assert.equal(refreshOf(tenNow.data), 0);
	const after = next.slice();
	after[6] = 10;
	const eleven = a.picture(av1Pic(11, after));
	assert.equal(eleven.length, 2, "10 again, then 11");
	assert.ok(eleven[0]!.added && !eleven[0]!.output);
	assert.equal(refreshOf(eleven[0]!.data), 1 << 6, "into the slot of 7, which the app gave up");
	assert.deepEqual(a.state().slots, [1, 2, 3, 9, 5, 6, 10, 8]);
	assert.equal(a.state().redecodes, 1);
	// a filler: a show_existing_frame of a slot holding a non-key frame
	const f = a.filler!(11, 0)!;
	assert.deepEqual([...f.data.subarray(0, 2)], [0x12, 0], "a temporal delimiter");
	assert.equal(f.data[2]! >> 3, 3, "a frame header OBU");
	assert.equal(f.data[4]! >> 7, 1, "show_existing_frame");
});

test("AV1 refusals: hidden key frames, large-scale tile, 10 bits", () => {
	const a = av1Adapter(64, 64);
	assert.throws(() => a.picture(av1Pic(1, [], { show: false })), /hidden key frames/);
	assert.throws(() => a.picture(av1Pic(1, [], { lst: true })), /large-scale tile/);
	assert.throws(() => a.picture(av1Pic(1, [], { bitDepth: 1 })), /bit depth of 10/);
	assert.throws(() => av1Adapter(64, 64).picture(av1Pic(2, [1, 1, 1, 1, 1, 1, 1, 1])), /start with a key frame/);
});

// ---- HEVC ----

/** VA's HEVC picture parameters for a 64x64 stream with 64x64 CTBs, POC lsb of 8 bits, as the slice header parser needs them. */
function hevcPp(poc: number, refs: { poc: number; flags: number }[], o: Partial<VaHevcPicParams> = {}): VaHevcPicParams {
	return {
		poc, refs: refs.map((r, i) => ({ surface: i + 1, ...r })), width: 64, height: 64, chromaFormatIdc: 1, separateColourPlane: false, pcm: false, scalingList: false, transformSkip: false,
		amp: false, strongIntraSmoothing: false, signDataHiding: false, constrainedIntraPred: false, cuQpDelta: false, weightedPred: false, weightedBipred: false, transquantBypass: false,
		tiles: false, entropyCodingSync: false, loopFilterAcrossSlices: false, loopFilterAcrossTiles: false, pcmLoopFilterDisabled: false, maxDecPicBufferingMinus1: 4, bitDepthLuma: 8,
		bitDepthChroma: 8, pcmBitDepthLuma: 8, pcmBitDepthChroma: 8, log2MinCb: 3, log2DiffMaxMinCb: 3, log2MinTb: 2, log2DiffMaxMinTb: 3, log2MinPcm: 3, log2DiffMaxMinPcm: 0,
		maxTransformHierarchyDepthIntra: 1, maxTransformHierarchyDepthInter: 1, initQpMinus26: 0, diffCuQpDeltaDepth: 0, cbQpOffset: 0, crQpOffset: 0, log2ParallelMergeLevelMinus2: 0,
		tileColumns: [], tileRows: [], listsModification: false, longTermRefs: false, temporalMvp: true, cabacInitPresent: false, outputFlagPresent: false, dependentSlices: false,
		sliceChromaQpOffsets: false, sao: true, deblockingOverride: false, ppsDeblockingDisabled: false, sliceHeaderExtension: false, idr: false, log2MaxPocLsb: 8,
		numShortTermRefPicSets: 3, numLongTermRefPicsSps: 0, numRefIdxL0Default: 2, numRefIdxL1Default: 1, betaOffsetDiv2: 0, tcOffsetDiv2: 0, numExtraSliceHeaderBits: 0, stRpsBits: 0, ...o,
	};
}

test("HEVC: the RPS from VA's ReferenceFrames, and a slice naming an SPS set written again with it inline, slice data kept", () => {
	// POC 8 with references 4 (used), 0 (kept for later), 16 (used), as ffmpeg flags them
	const pp = hevcPp(8, [{ poc: 0, flags: 0 }, { poc: 16, flags: 32 }, { poc: 4, flags: 16 }]);
	const rps = hevcRps(pp);
	assert.deepEqual(rps.neg, [{ poc: 4, used: true }, { poc: 0, used: false }], "negative pictures by decreasing POC");
	assert.deepEqual(rps.pos, [{ poc: 16, used: true }]);
	assert.equal(rps.usedCount, 2);
	// a B slice header naming SPS set 2 of 3
	const w = new BitWriter();
	w.u(1, 1); // first_slice_segment_in_pic_flag
	w.ue(0); // slice_pic_parameter_set_id
	w.ue(0); // slice_type B
	w.u(8, 8); // slice_pic_order_cnt_lsb
	w.u(1, 1); // short_term_ref_pic_set_sps_flag
	w.u(2, 2); // short_term_ref_pic_set_idx
	w.u(1, 1); // slice_temporal_mvp_enabled_flag
	w.u(1, 1), w.u(1, 0); // slice_sao_luma_flag, slice_sao_chroma_flag
	w.u(1, 0); // num_ref_idx_active_override_flag
	w.u(1, 0); // mvd_l1_zero_flag
	w.u(1, 1); // collocated_from_l0_flag
	w.ue(1); // collocated_ref_idx (2 references in L0)
	w.ue(2); // five_minus_max_num_merge_cand
	w.se(-3); // slice_qp_delta
	w.u(1, 1); // byte_alignment
	w.align();
	const data = Uint8Array.of(0, 0, 3, 1, 0xaa, 0x55); // slice data with an emulation prevention byte
	const nal = new Uint8Array([...hevcNal(1, w.bytes()), ...data]);
	const out = rewriteHevcSlice(nal, pp);
	assert.equal(out.header.ppsId, 0);
	assert.deepEqual([...out.nal.subarray(out.nal.length - data.length)], [...data], "the slice data as it was");
	// read back against an SPS with no sets: the set inline, the rest the same
	const pp0 = { ...pp, numShortTermRefPicSets: 0 };
	const rbsp = Uint8Array.from(out.nal.subarray(2, out.nal.length - data.length));
	const r = new BitReader(rbsp);
	assert.deepEqual([r.u(1), r.ue(), r.ue(), r.u(8), r.u(1)], [1, 0, 0, 8, 0], "short_term_ref_pic_set_sps_flag 0");
	assert.deepEqual([r.ue(), r.ue()], [2, 1], "two negative pictures, one positive");
	assert.deepEqual([r.ue(), r.u(1), r.ue(), r.u(1)], [3, 1, 3, 0], "POC 4 used, POC 0 kept");
	assert.deepEqual([r.ue(), r.u(1)], [7, 1], "POC 16 used");
	const h = parseHevcSliceHeader(1, rbsp, pp0, 2);
	assert.equal(h.dataStart, rbsp.length, "the header ends where the slice data starts");
	// a slice whose long-term pictures in use disagree with VA's is refused: VA has one in use, the slice none
	const lt = new BitWriter();
	lt.u(1, 1), lt.ue(0), lt.ue(1), lt.u(8, 8), lt.u(1, 1), lt.u(2, 1); // a P slice naming SPS set 1
	lt.ue(0); // num_long_term_pics
	lt.u(1, 0), lt.u(1, 0), lt.u(1, 0); // temporal mvp, sao luma, sao chroma
	lt.u(1, 0), lt.ue(2), lt.se(0), lt.u(1, 1); // override, merge cand, qp delta, byte_alignment
	lt.align();
	const ppLt = hevcPp(8, [{ poc: 4, flags: 16 }, { poc: 2, flags: 8 | 64 }], { longTermRefs: true });
	assert.throws(() => rewriteHevcSlice(new Uint8Array([...hevcNal(1, lt.bytes()), 0x80]), ppLt), /differ/);
});

// ---- hostile buffers (any guest process can connect): each fails its picture at little cost ----

test("slice and tile data: ranges naming the same bytes many times over are refused (VP9, AV1, HEVC); AV1 tiles beyond 64 x 64", () => {
	const data = new Uint8Array(1 << 20), n = 256;
	const params = (size: number) => {
		const d = new Uint8Array(size * n), dv = new DataView(d.buffer);
		for (let i = 0; i < n; i++) dv.setUint32(size * i, data.length, true), size > 16 && dv.setUint16(size * i + 14, i, true); // (AV1: tile_column)
		return { type: VA_BUF.sliceParameter, size, num: n, data: d };
	};
	const pic = (profile: string, size: number, pp?: Uint8Array): VaPicture => ({
		pic: 1, surface: 1, profile, width: 64, height: 64, refs: [],
		bufs: [...(pp ? [{ type: VA_BUF.picture, size: pp.length, num: 1, data: pp }] : []), params(size), { type: VA_BUF.sliceData, size: data.length, num: 1, data }],
	});
	assert.throws(() => sliceRanges(pic("vp9.0", 12)), /slices of more bytes than their slice data buffer/);
	assert.throws(() => vaHevcSlices(pic("hevc.main", VA_HEVC_SLICE_SIZE)), /slices of more bytes than their slice data buffer/);
	// AV1: 256 tiles of one row (tile_column 0..255) in a 64 x 64 tile layout, each the whole buffer
	const av1 = av1Pic(1, []);
	av1.bufs[0]!.data[416] = 64;
	av1.bufs[0]!.data[417] = 64;
	const tiles = pic("av1.0", 40, av1.bufs[0]!.data);
	assert.throws(() => av1Adapter(64, 64).picture(tiles), /tiles of more bytes than their tile data buffer/);
	const empty = new Uint8Array(40 * 5000);
	tiles.bufs[1] = { type: VA_BUF.sliceParameter, size: 40, num: 5000, data: empty };
	assert.throws(() => av1Adapter(64, 64).picture(tiles), /more than 4096 tiles/);
});

test("HEVC: slice header counts beyond the spec's are refused before they are looped over", () => {
	const pp = hevcPp(8, [{ poc: 4, flags: 16 }]);
	const header = (f: (w: BitWriter) => void) => {
		const w = new BitWriter();
		w.u(1, 1), w.ue(0); // first_slice_segment_in_pic_flag, slice_pic_parameter_set_id
		f(w);
		for (let i = 0; i < 64; i++) w.u(8, 0x55);
		w.trailing();
		return w.bytes();
	};
	const pSlice = (w: BitWriter) => (w.ue(1), w.u(8, 8)); // slice_type P, slice_pic_order_cnt_lsb
	// a set of its own with VA's st_rps_bits beyond the slice: passed over at once, not bit by bit
	assert.throws(() => parseHevcSliceHeader(1, header((w) => (pSlice(w), w.u(1, 0))), { ...pp, stRpsBits: 0xffffffff }, 1), /cut short/);
	// the set inline (no SPS sets) with 2^31 negative pictures
	assert.throws(() => parseHevcSliceHeader(1, header((w) => (pSlice(w), w.u(1, 0), w.ue(2 ** 31), w.ue(0))), { ...pp, numShortTermRefPicSets: 0 }, 1), /short-term reference picture set/);
	// num_long_term_pics 2^31
	assert.throws(() => parseHevcSliceHeader(1, header((w) => (pSlice(w), w.u(1, 1), w.u(2, 0), w.ue(2 ** 31))), { ...pp, longTermRefs: true }, 1), /num_long_term_pics/);
	// num_ref_idx_active_override with 2^20 references (each a weight flag)
	const sao0 = (w: BitWriter) => (w.u(1, 0), w.u(1, 0), w.u(1, 0)); // slice_temporal_mvp_enabled_flag, slice_sao_luma_flag, slice_sao_chroma_flag
	assert.throws(() => parseHevcSliceHeader(1, header((w) => (pSlice(w), w.u(1, 1), w.u(2, 0), sao0(w), w.u(1, 1), w.ue(2 ** 20))), { ...pp, weightedPred: true }, 1), /num_ref_idx_active_minus1/);
	// entry points with offset_len_minus1 2^31
	const iSlice = (w: BitWriter) => (w.ue(2), w.u(8, 8), w.u(1, 1), w.u(2, 0), sao0(w), w.se(0)); // slice_type I, ..., slice_qp_delta
	assert.throws(() => parseHevcSliceHeader(1, header((w) => (iSlice(w), w.ue(5), w.ue(2 ** 31))), { ...pp, tiles: true }, 1), /offset_len_minus1/);
	// and 2^31 entry points of 32 bits: more than the slice has
	assert.throws(() => parseHevcSliceHeader(1, header((w) => (iSlice(w), w.ue(2 ** 31), w.ue(31))), { ...pp, tiles: true }, 1), /cut short/);
	// VA's picture parameters with more tile columns than VAPictureParameterBufferHEVC has room for
	const vpp = new Uint8Array(VA_HEVC_PIC_SIZE);
	new DataView(vpp.buffer).setUint32(452, 1 | (1 << 14), true); // 4:2:0, tiles
	vpp[474] = 200;
	assert.throws(() => parseVaHevcPicParams(vpp), /a bad tile layout of 201x1/);
});

test("HEVC adapter: a replay (remake) takes the slices from the chunk, not from the guest's buffers", () => {
	const pp = new Uint8Array(VA_HEVC_PIC_SIZE), dv = new DataView(pp.buffer);
	for (let i = 0; i < 15; i++) dv.setUint32(28 + 28 * i + 8, 1, true); // VA_PICTURE_HEVC_INVALID
	dv.setUint16(448, 64, true), dv.setUint16(450, 64, true), dv.setUint32(452, 1, true); // 64x64, 4:2:0
	pp[456] = 4, pp[462] = 3, pp[464] = 3, pp[560] = 4; // 64x64 CTBs, POC lsb of 8 bits
	const w = new BitWriter();
	w.u(1, 1), w.u(1, 0), w.ue(0), w.ue(2), w.se(0), w.u(1, 1), w.align(); // an IDR's I slice: kept as it is
	const nal = new Uint8Array([...hevcNal(19, w.bytes()), 0xaa, 0x55]), sp = new Uint8Array(VA_HEVC_SLICE_SIZE);
	new DataView(sp.buffer).setUint32(0, nal.length, true);
	const p: VaPicture = { pic: 1, surface: 1, profile: "hevc.main", width: 64, height: 64, refs: [], bufs: [
		{ type: VA_BUF.picture, size: VA_HEVC_PIC_SIZE, num: 1, data: pp }, { type: VA_BUF.sliceParameter, size: VA_HEVC_SLICE_SIZE, num: 1, data: sp },
		{ type: VA_BUF.sliceData, size: nal.length, num: 1, data: nal },
	] };
	const [c] = hevcAdapter().picture(p);
	const want = [...c!.data];
	nal.fill(0);
	assert.deepEqual([...c!.remake!()], want);
});

test("av1TileGroups: parameters before or after their data, and several structures as one element (Chromium)", () => {
	// two tiles in one row: 3 bytes at 0, 5 bytes at 3
	const sp = new Uint8Array(80), dv = new DataView(sp.buffer), data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
	dv.setUint32(0, 3, true), dv.setUint32(4, 0, true), dv.setUint16(14, 0, true);
	dv.setUint32(40, 5, true), dv.setUint32(44, 3, true), dv.setUint16(54, 1, true);
	const pic = (bufs: VaPicture["bufs"]): VaPicture => ({ pic: 1, surface: 1, profile: "av1.0", width: 64, height: 64, refs: [], bufs });
	const d = { type: VA_BUF.sliceData, size: 8, num: 1, data };
	const want = [{ start: 0, end: 1, tiles: [data.subarray(0, 3), data.subarray(3, 8)] }];
	for (const params of [{ type: VA_BUF.sliceParameter, size: 40, num: 2, data: sp }, { type: VA_BUF.sliceParameter, size: 80, num: 1, data: sp }]) {
		assert.deepEqual(av1TileGroups(pic([params, d]), 2), want);
		assert.deepEqual(av1TileGroups(pic([d, params]), 2), want);
	}
	// a parameter buffer per tile, after the one data buffer (Chromium) or before it
	const one = (o: number) => ({ type: VA_BUF.sliceParameter, size: 40, num: 1, data: sp.subarray(o, o + 40) });
	assert.deepEqual(av1TileGroups(pic([d, one(0), one(40)]), 2), want);
	assert.deepEqual(av1TileGroups(pic([one(40), one(0), d]), 2), want);
	assert.throws(() => av1TileGroups(pic([d]), 2), /without slice parameters/);
	assert.throws(() => av1TileGroups(pic([d, d]), 2), /without slice parameters/);
});
