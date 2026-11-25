// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's H.264 (the CodecAdapter of js/core/va.ts for the VA
// profiles "h264.cb", "h264.main" and "h264.high"; .agents/va.md, H.264).
//
// VA-API hands the driver parsed parameters (VAPictureParameterBufferH264,
// VAIQMatrixBufferH264, VASliceParameterBufferH264) and the raw slice NAL
// units; WebCodecs wants whole access units. So each picture becomes one
// Annex B access unit: an SPS and a PPS synthesised from the VA parameters,
// then the picture's slices. The real decoder parses the slice headers
// against them, so every field that slice header or slice data parsing
// depends on comes from VA, and what VA does not carry is recovered:
//
// - the PPS id: read from the first slice header (the PPS is emitted with
//   it); the SPS id is always 0 (only the PPS names it);
// - num_ref_idx_l0/l1_default_active_minus1: the effective counts of the
//   picture's slices that do not override them (their header says so), else
//   the last ones known for that PPS id;
// - scaling lists: VA gives the effective ones (raster order); non-flat
//   lists go into the PPS, all of them, so no fall-back rule applies;
// - profile_idc from the VA profile, raised to Main or High when the
//   picture uses their tools (sticky); level_idc the smallest that fits the
//   picture size and the DPB; no cropping (the guest's surfaces hold the
//   whole coded picture, as a hardware decoder's do, and its app crops);
// - VUI with bitstream_restriction: max_num_reorder_frames is the output
//   delay (below), max_dec_frame_buffering the level's DPB size (in
//   conservative mode the least the SPS allows).
//
// Output delay: WebCodecs outputs in presentation order and may hold
// pictures up to the DPB size, while the guest's app syncs each surface in
// its own order (a single-threaded app right after submitting it, past its
// own reorder delay). VA does not carry the stream's reorder depth. The
// adapter starts at 0 and keeps an exact model of libavcodec's output
// process (h264_select_output_frame, which Chromium's software decoder
// runs, with bitstream_restriction present): a picture that would come
// after one already output (dropped as out of order) raises
// max_num_reorder_frames to the least depth that loses nothing since the
// IDR, and the decoder is made again with the stream since the IDR replayed
// (`restart`). So the host's delay is the least the stream needs, never more
// than the guest's own decoder uses, and nothing is dropped. `held()` tells
// the session which pictures the model says the decoder still holds for
// lack of input (the stream's end, a flush in the guest): the session's
// hold timer flushes those sooner. That is model mode; when the decoder
// disagrees (it is not libavcodec) the context goes conservative (see
// h264Adapter): the stream's own reorder depth, the least DPB, and a
// filler picture for a decoder that holds the picture the guest waits for.
// Each chunk's timestamp is its place in the output order (`order`).
// Packagings: Annex B, avcC (a description; for decoders that want one),
// Annex B without the VUI (for one that rejects it).
//
// Refused with a clear message: field pictures (PAFF), FMO, 4:2:2/4:4:4,
// more than 8 bits, pic_order_cnt_type 1, data partitioning, MVC.

import { BitReader, BitWriter, type CodecAdapter, type CodecChunk, type CodecConfig, type CodecMode, type VaPicture, VA_BUF } from "./va-codec.ts";

// ---- bits (va-codec.ts) ----

export { BitReader, BitWriter } from "./va-codec.ts";

/** A NAL unit: its header byte and the RBSP with emulation prevention bytes. */
export function nalUnit(type: number, refIdc: number, rbsp: Uint8Array): Uint8Array {
	const out: number[] = [(refIdc << 5) | type];
	let zeros = 0;
	for (const b of rbsp) {
		if (zeros >= 2 && b <= 3) {
			out.push(3);
			zeros = 0;
		}
		out.push(b);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	if (zeros) out.push(3); // an RBSP ending in a zero byte (cabac_zero_word)
	return Uint8Array.from(out);
}

/** The RBSP of a NAL unit's payload (after its header byte), at most `limit` bytes of it. */
export function unescapeRbsp(nal: Uint8Array, start = 1, limit = Infinity): Uint8Array {
	const out: number[] = [];
	let zeros = 0;
	for (let i = start; i < nal.length && out.length < limit; i++) {
		const b = nal[i]!;
		if (zeros >= 2 && b === 3) {
			zeros = 0;
			continue;
		}
		out.push(b);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	return Uint8Array.from(out);
}

/** NAL units of an Annex B stream (start codes removed). */
export function annexBUnits(d: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	let i = 0, start = -1;
	while (i + 2 < d.length) {
		if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
			if (start >= 0) {
				let e = i;
				while (e > start && d[e - 1] === 0) e--;
				out.push(d.subarray(start, e));
			}
			i += 3;
			start = i;
		} else i++;
	}
	if (start >= 0 && start < d.length) out.push(d.subarray(start));
	return out;
}

// ---- parameter sets ----

/** Raster positions of the zig-zag scan: 4x4 and 8x8 (frame scan; scaling lists always use it). */
const ZIGZAG4 = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const ZIGZAG8 = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37,
	44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
/** Default_4x4_Intra/Inter and Default_8x8_Intra/Inter (Table 7-3, 7-4), in zig-zag order */
const DEFAULT4 = [
	[6, 13, 13, 20, 20, 20, 28, 28, 28, 28, 32, 32, 32, 37, 37, 42],
	[10, 14, 14, 20, 20, 20, 24, 24, 24, 24, 27, 27, 27, 30, 30, 34],
];
const DEFAULT8 = [
	[
		6, 10, 10, 13, 11, 13, 16, 16, 16, 16, 18, 18, 18, 18, 18, 23, 23, 23, 23, 23, 23, 25, 25, 25, 25, 25, 25, 25, 27, 27, 27, 27, 27, 27, 27, 27, 29, 29, 29, 29, 29, 29, 29,
		31, 31, 31, 31, 31, 31, 33, 33, 33, 33, 33, 36, 36, 36, 36, 38, 38, 38, 40, 40, 42,
	],
	[
		9, 13, 13, 15, 13, 15, 17, 17, 17, 17, 19, 19, 19, 19, 19, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 22, 24, 24, 24, 24, 24, 24, 24, 24, 25, 25, 25, 25, 25, 25, 25,
		27, 27, 27, 27, 27, 27, 28, 28, 28, 28, 28, 30, 30, 30, 30, 32, 32, 32, 33, 33, 35,
	],
];
function fromZigzag(z: number[], scan: number[]): number[] {
	const r = new Array<number>(z.length);
	z.forEach((v, i) => (r[scan[i]!] = v));
	return r;
}

/**
 * Scaling lists, each in raster order (as VA's VAIQMatrixBufferH264 has
 * them), or null where not present (the fall-back rule applies): 6 4x4
 * lists, then the 8x8 ones (2 for 4:2:0).
 */
export type ScalingLists = (number[] | null)[];

function writeScalingLists(w: BitWriter, lists: ScalingLists, count: number): void {
	for (let i = 0; i < count; i++) {
		const l = lists[i] ?? null;
		w.u(1, l ? 1 : 0);
		if (!l) continue;
		const scan = i < 6 ? ZIGZAG4 : ZIGZAG8;
		let last = 8;
		for (let j = 0; j < scan.length; j++) {
			const v = l[scan[j]!]!;
			w.se(((v - last + 128) & 255) - 128);
			last = v;
		}
	}
}

function readScalingLists(r: BitReader, count: number): ScalingLists {
	const out: ScalingLists = [];
	for (let i = 0; i < count; i++) {
		if (!r.u(1)) {
			out.push(null);
			continue;
		}
		const scan = i < 6 ? ZIGZAG4 : ZIGZAG8, z: number[] = [];
		let last = 8, next = 8, dflt = false;
		for (let j = 0; j < scan.length; j++) {
			if (next) {
				next = (last + r.se() + 256) % 256;
				if (j === 0 && next === 0) {
					dflt = true;
					break;
				}
			}
			z.push(next || last);
			last = next || last;
		}
		const inter = i < 6 ? (i >= 3 ? 1 : 0) : (i - 6) % 2;
		out.push(dflt ? fromZigzag((i < 6 ? DEFAULT4 : DEFAULT8)[inter]!, scan) : fromZigzag(z, scan));
	}
	return out;
}

/** profile_idc values whose SPS carries chroma_format_idc and the rest (7.3.2.1.1) */
const HIGH_SPS = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export interface H264Vui {
	/** VUI fields this module does not write (aspect ratio, timing, HRD, ...) were present (parse only) */
	other?: boolean;
	bitstreamRestriction: { maxNumReorderFrames: number; maxDecFrameBuffering: number } | null;
}

export interface H264Sps {
	profileIdc: number;
	/** constraint_set0..5_flag and reserved_zero_2bits: the byte after profile_idc */
	constraintFlags: number;
	levelIdc: number;
	spsId: number;
	chromaFormatIdc: number;
	separateColourPlane: boolean;
	bitDepthLuma: number;
	bitDepthChroma: number;
	qpprimeYZeroTransformBypass: boolean;
	scaling: ScalingLists | null;
	log2MaxFrameNum: number;
	pocType: number;
	log2MaxPocLsb: number;
	deltaPicOrderAlwaysZero: boolean;
	offsetForNonRefPic: number;
	offsetForTopToBottomField: number;
	offsetForRefFrame: number[];
	maxNumRefFrames: number;
	gapsInFrameNumAllowed: boolean;
	widthMbs: number;
	/** pic_height_in_map_units_minus1 + 1 (frame MB rows / 2 without frame_mbs_only) */
	heightMapUnits: number;
	frameMbsOnly: boolean;
	mbAdaptiveFrameField: boolean;
	direct8x8Inference: boolean;
	crop: { left: number; right: number; top: number; bottom: number } | null;
	vui: H264Vui | null;
}

export interface H264Pps {
	ppsId: number;
	spsId: number;
	entropyCodingMode: boolean;
	bottomFieldPicOrderInFramePresent: boolean;
	numRefIdxL0Default: number;
	numRefIdxL1Default: number;
	weightedPred: boolean;
	weightedBipredIdc: number;
	picInitQp: number;
	picInitQs: number;
	chromaQpIndexOffset: number;
	deblockingFilterControlPresent: boolean;
	constrainedIntraPred: boolean;
	redundantPicCntPresent: boolean;
	/** the fields after redundant_pic_cnt_present_flag are written (High profiles) */
	extended: boolean;
	transform8x8Mode: boolean;
	scaling: ScalingLists | null;
	secondChromaQpIndexOffset: number;
}

const b1 = (v: boolean) => (v ? 1 : 0);

/** An SPS's RBSP. */
export function writeSps(s: H264Sps): Uint8Array {
	const w = new BitWriter();
	w.u(8, s.profileIdc);
	w.u(8, s.constraintFlags);
	w.u(8, s.levelIdc);
	w.ue(s.spsId);
	if (HIGH_SPS.has(s.profileIdc)) {
		w.ue(s.chromaFormatIdc);
		if (s.chromaFormatIdc === 3) w.u(1, b1(s.separateColourPlane));
		w.ue(s.bitDepthLuma - 8);
		w.ue(s.bitDepthChroma - 8);
		w.u(1, b1(s.qpprimeYZeroTransformBypass));
		w.u(1, b1(!!s.scaling));
		if (s.scaling) writeScalingLists(w, s.scaling, s.chromaFormatIdc !== 3 ? 8 : 12);
	}
	w.ue(s.log2MaxFrameNum - 4);
	w.ue(s.pocType);
	if (s.pocType === 0) w.ue(s.log2MaxPocLsb - 4);
	else if (s.pocType === 1) {
		w.u(1, b1(s.deltaPicOrderAlwaysZero));
		w.se(s.offsetForNonRefPic);
		w.se(s.offsetForTopToBottomField);
		w.ue(s.offsetForRefFrame.length);
		for (const o of s.offsetForRefFrame) w.se(o);
	}
	w.ue(s.maxNumRefFrames);
	w.u(1, b1(s.gapsInFrameNumAllowed));
	w.ue(s.widthMbs - 1);
	w.ue(s.heightMapUnits - 1);
	w.u(1, b1(s.frameMbsOnly));
	if (!s.frameMbsOnly) w.u(1, b1(s.mbAdaptiveFrameField));
	w.u(1, b1(s.direct8x8Inference));
	w.u(1, b1(!!s.crop));
	if (s.crop) {
		w.ue(s.crop.left);
		w.ue(s.crop.right);
		w.ue(s.crop.top);
		w.ue(s.crop.bottom);
	}
	w.u(1, b1(!!s.vui));
	if (s.vui) {
		// aspect_ratio_info, overscan_info, video_signal_type, chroma_loc_info, timing_info, nal_hrd, vcl_hrd, pic_struct: none
		for (let i = 0; i < 8; i++) w.u(1, 0);
		const br = s.vui.bitstreamRestriction;
		w.u(1, b1(!!br));
		if (br) {
			w.u(1, 1); // motion_vectors_over_pic_boundaries_flag
			w.ue(0); // max_bytes_per_pic_denom: no limit
			w.ue(0); // max_bits_per_mb_denom: no limit
			w.ue(15); // log2_max_mv_length_horizontal
			w.ue(15); // log2_max_mv_length_vertical
			w.ue(br.maxNumReorderFrames);
			w.ue(br.maxDecFrameBuffering);
		}
	}
	w.trailing();
	return w.bytes();
}

function skipHrd(r: BitReader): void {
	const cpbs = r.ue() + 1;
	r.u(4);
	r.u(4);
	for (let i = 0; i < cpbs; i++) {
		r.ue();
		r.ue();
		r.u(1);
	}
	r.u(20);
}

/** An SPS from its RBSP (for tests and checks). */
export function parseSps(rbsp: Uint8Array): H264Sps {
	const r = new BitReader(rbsp);
	const s: H264Sps = {
		profileIdc: r.u(8), constraintFlags: r.u(8), levelIdc: r.u(8), spsId: r.ue(), chromaFormatIdc: 1, separateColourPlane: false, bitDepthLuma: 8, bitDepthChroma: 8,
		qpprimeYZeroTransformBypass: false, scaling: null, log2MaxFrameNum: 4, pocType: 0, log2MaxPocLsb: 4, deltaPicOrderAlwaysZero: false, offsetForNonRefPic: 0,
		offsetForTopToBottomField: 0, offsetForRefFrame: [], maxNumRefFrames: 0, gapsInFrameNumAllowed: false, widthMbs: 0, heightMapUnits: 0, frameMbsOnly: true,
		mbAdaptiveFrameField: false, direct8x8Inference: false, crop: null, vui: null,
	};
	if (HIGH_SPS.has(s.profileIdc)) {
		s.chromaFormatIdc = r.ue();
		if (s.chromaFormatIdc === 3) s.separateColourPlane = !!r.u(1);
		s.bitDepthLuma = r.ue() + 8;
		s.bitDepthChroma = r.ue() + 8;
		s.qpprimeYZeroTransformBypass = !!r.u(1);
		if (r.u(1)) s.scaling = readScalingLists(r, s.chromaFormatIdc !== 3 ? 8 : 12);
	}
	s.log2MaxFrameNum = r.ue() + 4;
	s.pocType = r.ue();
	if (s.pocType === 0) s.log2MaxPocLsb = r.ue() + 4;
	else if (s.pocType === 1) {
		s.deltaPicOrderAlwaysZero = !!r.u(1);
		s.offsetForNonRefPic = r.se();
		s.offsetForTopToBottomField = r.se();
		const n = r.ue();
		for (let i = 0; i < n; i++) s.offsetForRefFrame.push(r.se());
	}
	s.maxNumRefFrames = r.ue();
	s.gapsInFrameNumAllowed = !!r.u(1);
	s.widthMbs = r.ue() + 1;
	s.heightMapUnits = r.ue() + 1;
	s.frameMbsOnly = !!r.u(1);
	if (!s.frameMbsOnly) s.mbAdaptiveFrameField = !!r.u(1);
	s.direct8x8Inference = !!r.u(1);
	if (r.u(1)) s.crop = { left: r.ue(), right: r.ue(), top: r.ue(), bottom: r.ue() };
	if (r.u(1)) {
		const v: H264Vui = { other: false, bitstreamRestriction: null };
		if (r.u(1)) {
			v.other = true;
			if (r.u(8) === 255) r.u(32);
		}
		if (r.u(1)) (v.other = true), r.u(1);
		if (r.u(1)) {
			v.other = true;
			r.u(4);
			if (r.u(1)) r.u(24);
		}
		if (r.u(1)) (v.other = true), r.ue(), r.ue();
		if (r.u(1)) (v.other = true), r.u(32), r.u(32), r.u(1);
		const nal = r.u(1);
		if (nal) skipHrd(r);
		const vcl = r.u(1);
		if (vcl) skipHrd(r);
		if (nal || vcl) (v.other = true), r.u(1);
		if (r.u(1)) v.other = true;
		if (r.u(1)) {
			r.u(1);
			r.ue();
			r.ue();
			r.ue();
			r.ue();
			v.bitstreamRestriction = { maxNumReorderFrames: r.ue(), maxDecFrameBuffering: r.ue() };
		}
		s.vui = v;
	}
	return s;
}

/** A PPS's RBSP. */
export function writePps(p: H264Pps, chromaFormatIdc = 1): Uint8Array {
	const w = new BitWriter();
	w.ue(p.ppsId);
	w.ue(p.spsId);
	w.u(1, b1(p.entropyCodingMode));
	w.u(1, b1(p.bottomFieldPicOrderInFramePresent));
	w.ue(0); // num_slice_groups_minus1: no FMO
	w.ue(p.numRefIdxL0Default - 1);
	w.ue(p.numRefIdxL1Default - 1);
	w.u(1, b1(p.weightedPred));
	w.u(2, p.weightedBipredIdc);
	w.se(p.picInitQp - 26);
	w.se(p.picInitQs - 26);
	w.se(p.chromaQpIndexOffset);
	w.u(1, b1(p.deblockingFilterControlPresent));
	w.u(1, b1(p.constrainedIntraPred));
	w.u(1, b1(p.redundantPicCntPresent));
	if (p.extended) {
		w.u(1, b1(p.transform8x8Mode));
		w.u(1, b1(!!p.scaling));
		if (p.scaling) writeScalingLists(w, p.scaling, 6 + (chromaFormatIdc !== 3 ? 2 : 6) * b1(p.transform8x8Mode));
		w.se(p.secondChromaQpIndexOffset);
	}
	w.trailing();
	return w.bytes();
}

/** A PPS from its RBSP (for tests and checks). Throws for FMO. */
export function parsePps(rbsp: Uint8Array, chromaFormatIdc = 1): H264Pps {
	const r = new BitReader(rbsp);
	const ppsId = r.ue(), spsId = r.ue(), entropyCodingMode = !!r.u(1), bottomFieldPicOrderInFramePresent = !!r.u(1);
	if (r.ue() !== 0) throw new Error("slice groups (FMO)");
	const p: H264Pps = {
		ppsId, spsId, entropyCodingMode, bottomFieldPicOrderInFramePresent, numRefIdxL0Default: r.ue() + 1, numRefIdxL1Default: r.ue() + 1, weightedPred: !!r.u(1),
		weightedBipredIdc: r.u(2), picInitQp: r.se() + 26, picInitQs: r.se() + 26, chromaQpIndexOffset: r.se(), deblockingFilterControlPresent: !!r.u(1),
		constrainedIntraPred: !!r.u(1), redundantPicCntPresent: !!r.u(1), extended: false, transform8x8Mode: false, scaling: null, secondChromaQpIndexOffset: 0,
	};
	p.secondChromaQpIndexOffset = p.chromaQpIndexOffset;
	if (r.more()) {
		p.extended = true;
		p.transform8x8Mode = !!r.u(1);
		if (r.u(1)) p.scaling = readScalingLists(r, 6 + (chromaFormatIdc !== 3 ? 2 : 6) * b1(p.transform8x8Mode));
		p.secondChromaQpIndexOffset = r.se();
	}
	return p;
}

/** avc1.PPCCLL of an SPS */
export function avcCodecString(s: Pick<H264Sps, "profileIdc" | "constraintFlags" | "levelIdc">): string {
	const h = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
	return `avc1.${h(s.profileIdc)}${h(s.constraintFlags)}${h(s.levelIdc)}`;
}

// ---- slice headers ----

/** What a slice header needs from the SPS and PPS it refers to. */
export interface SliceContext {
	separateColourPlane: boolean;
	log2MaxFrameNum: number;
	frameMbsOnly: boolean;
	pocType: number;
	log2MaxPocLsb: number;
	deltaPicOrderAlwaysZero: boolean;
	bottomFieldPicOrderInFramePresent: boolean;
	redundantPicCntPresent: boolean;
	weightedPred: boolean;
	weightedBipredIdc: number;
	chromaArrayType: number;
}

export interface H264Slice {
	nalType: number;
	refIdc: number;
	firstMb: number;
	/** slice_type % 5: 0 P, 1 B, 2 I, 3 SP, 4 SI */
	sliceType: number;
	ppsId: number;
	/** parsed only with a context: */
	frameNum?: number;
	fieldPic?: boolean;
	bottomField?: boolean;
	idrPicId?: number;
	pocLsb?: number;
	directSpatial?: boolean;
	/** num_ref_idx_active_override_flag, and the counts it gives */
	override?: boolean;
	numRefIdxL0?: number;
	numRefIdxL1?: number;
	/** parsed with `full` (the dec_ref_pic_marking): */
	noOutputOfPriorPics?: boolean;
	mmco5?: boolean;
}

/**
 * A slice header from its NAL unit (header byte first, emulation prevention
 * bytes in): up to the PPS id without a context, up to the reference counts
 * with one, and through dec_ref_pic_marking with `full` (which needs the
 * effective reference counts, `counts`, when the header does not override
 * them).
 */
export function parseSliceHeader(nal: Uint8Array, ctx?: SliceContext, full?: { counts: [number, number] }): H264Slice {
	if (!nal.length || nal[0]! & 0x80) throw new Error("not a NAL unit (forbidden_zero_bit)");
	const nalType = nal[0]! & 31, refIdc = (nal[0]! >> 5) & 3;
	if (nalType !== 1 && nalType !== 5) {
		const what = nalType >= 2 && nalType <= 4 ? "data partitioning (Extended profile)" : nalType === 20 || nalType === 21 ? "MVC/3D slices" : `NAL unit type ${nalType}`;
		throw new Error(`${what} is not supported`);
	}
	const r = new BitReader(unescapeRbsp(nal, 1, 4096));
	const firstMb = r.ue(), rawType = r.ue(), ppsId = r.ue();
	if (rawType > 9) throw new Error(`a bad slice_type ${rawType}`);
	if (ppsId > 255) throw new Error(`a bad pic_parameter_set_id ${ppsId}`);
	const s: H264Slice = { nalType, refIdc, firstMb, sliceType: rawType % 5, ppsId };
	if (!ctx) return s;
	if (ctx.separateColourPlane) r.u(2);
	s.frameNum = r.u(ctx.log2MaxFrameNum);
	s.fieldPic = false;
	if (!ctx.frameMbsOnly && (s.fieldPic = !!r.u(1))) s.bottomField = !!r.u(1);
	if (nalType === 5) s.idrPicId = r.ue();
	if (ctx.pocType === 0) {
		s.pocLsb = r.u(ctx.log2MaxPocLsb);
		if (ctx.bottomFieldPicOrderInFramePresent && !s.fieldPic) r.se();
	} else if (ctx.pocType === 1 && !ctx.deltaPicOrderAlwaysZero) {
		r.se();
		if (ctx.bottomFieldPicOrderInFramePresent && !s.fieldPic) r.se();
	}
	if (ctx.redundantPicCntPresent) r.ue();
	const st = s.sliceType, isB = st === 1, isP = st === 0 || st === 3;
	if (isB) s.directSpatial = !!r.u(1);
	s.override = false;
	if (isP || isB) {
		if ((s.override = !!r.u(1))) {
			s.numRefIdxL0 = r.ue() + 1;
			if (isB) s.numRefIdxL1 = r.ue() + 1;
		}
	}
	if (!full) return s;
	const l0 = s.numRefIdxL0 ?? full.counts[0], l1 = s.numRefIdxL1 ?? full.counts[1];
	// ref_pic_list_modification
	const mod = () => {
		if (!r.u(1)) return;
		for (let n = 0; ; n++) {
			const idc = r.ue();
			if (idc === 3) break;
			if (idc > 5 || n > 100) throw new Error(`a bad modification_of_pic_nums_idc ${idc}`);
			r.ue();
		}
	};
	if (st !== 2 && st !== 4) mod();
	if (isB) mod();
	// pred_weight_table
	if ((ctx.weightedPred && isP) || (ctx.weightedBipredIdc === 1 && isB)) {
		r.ue();
		if (ctx.chromaArrayType) r.ue();
		for (let list = 0; list < (isB ? 2 : 1); list++)
			for (let i = 0; i < (list ? l1 : l0); i++) {
				if (r.u(1)) r.se(), r.se();
				if (ctx.chromaArrayType && r.u(1)) r.se(), r.se(), r.se(), r.se();
			}
	}
	// dec_ref_pic_marking
	s.mmco5 = false;
	if (refIdc) {
		if (nalType === 5) {
			s.noOutputOfPriorPics = !!r.u(1);
			r.u(1);
		} else if (r.u(1)) {
			for (let n = 0; ; n++) {
				const op = r.ue();
				if (op === 0) break;
				if (op > 6 || n > 100) throw new Error(`a bad memory_management_control_operation ${op}`);
				if (op === 5) s.mmco5 = true;
				if (op === 1 || op === 3) r.ue();
				if (op === 2) r.ue();
				if (op === 3 || op === 6) r.ue();
				if (op === 4) r.ue();
			}
		}
	}
	return s;
}

// ---- VA's H.264 buffers (va.h 1.22; the same layout on aarch64 and x86-64) ----

export interface VaPicH264 {
	surface: number;
	frameIdx: number;
	flags: number;
	top: number;
	bottom: number;
}

/** VAPictureParameterBufferH264, the fields used */
export interface VaH264PicParams {
	curr: VaPicH264;
	refs: VaPicH264[];
	widthMbs: number;
	heightMbs: number;
	bitDepthLuma: number;
	bitDepthChroma: number;
	numRefFrames: number;
	chromaFormatIdc: number;
	separateColourPlane: boolean;
	gapsInFrameNumAllowed: boolean;
	frameMbsOnly: boolean;
	mbAdaptiveFrameField: boolean;
	direct8x8Inference: boolean;
	/** MinLumaBiPredSize8x8: ffmpeg sets it for level_idc >= 31 */
	minLumaBiPred8x8: boolean;
	log2MaxFrameNum: number;
	pocType: number;
	log2MaxPocLsb: number;
	deltaPicOrderAlwaysZero: boolean;
	numSliceGroups: number;
	picInitQp: number;
	picInitQs: number;
	chromaQpIndexOffset: number;
	secondChromaQpIndexOffset: number;
	entropyCodingMode: boolean;
	weightedPred: boolean;
	weightedBipredIdc: number;
	transform8x8Mode: boolean;
	fieldPic: boolean;
	constrainedIntraPred: boolean;
	bottomFieldPicOrderInFramePresent: boolean;
	deblockingFilterControlPresent: boolean;
	redundantPicCntPresent: boolean;
	referencePic: boolean;
	frameNum: number;
}
/** sizeof() of VAPictureParameterBufferH264, VAIQMatrixBufferH264 and VASliceParameterBufferH264 (the host reads what comes before va_reserved: 640 and 224 bytes; 28 of the slice parameters) */
export const VA_H264_PIC_SIZE = 672, VA_H264_IQ_SIZE = 240, VA_H264_SLICE_SIZE = 3128;

function vaPic(dv: DataView, o: number): VaPicH264 {
	return { surface: dv.getUint32(o, true), frameIdx: dv.getUint32(o + 4, true), flags: dv.getUint32(o + 8, true), top: dv.getInt32(o + 12, true), bottom: dv.getInt32(o + 16, true) };
}

export function parseVaH264PicParams(d: Uint8Array): VaH264PicParams {
	if (d.length < 640) throw new Error(`picture parameters of ${d.length} bytes (VAPictureParameterBufferH264 is ${VA_H264_PIC_SIZE})`);
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const seq = dv.getUint32(620, true), pic = dv.getUint32(632, true);
	const bits = (v: number, at: number, n: number) => (v >>> at) & ((1 << n) - 1);
	return {
		curr: vaPic(dv, 0),
		refs: Array.from({ length: 16 }, (_, i) => vaPic(dv, 36 + 36 * i)),
		widthMbs: dv.getUint16(612, true) + 1,
		heightMbs: dv.getUint16(614, true) + 1,
		bitDepthLuma: d[616]! + 8,
		bitDepthChroma: d[617]! + 8,
		numRefFrames: d[618]!,
		chromaFormatIdc: bits(seq, 0, 2),
		separateColourPlane: !!bits(seq, 2, 1),
		gapsInFrameNumAllowed: !!bits(seq, 3, 1),
		frameMbsOnly: !!bits(seq, 4, 1),
		mbAdaptiveFrameField: !!bits(seq, 5, 1),
		direct8x8Inference: !!bits(seq, 6, 1),
		minLumaBiPred8x8: !!bits(seq, 7, 1),
		log2MaxFrameNum: bits(seq, 8, 4) + 4,
		pocType: bits(seq, 12, 2),
		log2MaxPocLsb: bits(seq, 14, 4) + 4,
		deltaPicOrderAlwaysZero: !!bits(seq, 18, 1),
		numSliceGroups: d[624]! + 1,
		picInitQp: dv.getInt8(628) + 26,
		picInitQs: dv.getInt8(629) + 26,
		chromaQpIndexOffset: dv.getInt8(630),
		secondChromaQpIndexOffset: dv.getInt8(631),
		entropyCodingMode: !!bits(pic, 0, 1),
		weightedPred: !!bits(pic, 1, 1),
		weightedBipredIdc: bits(pic, 2, 2),
		transform8x8Mode: !!bits(pic, 4, 1),
		fieldPic: !!bits(pic, 5, 1),
		constrainedIntraPred: !!bits(pic, 6, 1),
		bottomFieldPicOrderInFramePresent: !!bits(pic, 7, 1),
		deblockingFilterControlPresent: !!bits(pic, 8, 1),
		redundantPicCntPresent: !!bits(pic, 9, 1),
		referencePic: !!bits(pic, 10, 1),
		frameNum: dv.getUint16(636, true),
	};
}

/** VAIQMatrixBufferH264: 6 4x4 and 2 8x8 lists in raster order; null when every entry is 16 (flat) or a list is bad (zeros). */
export function parseVaH264Iq(d: Uint8Array | null): ScalingLists | null {
	if (!d || d.length < 224) return null;
	const lists: number[][] = [];
	for (let i = 0; i < 6; i++) lists.push([...d.subarray(16 * i, 16 * i + 16)]);
	for (let i = 0; i < 2; i++) lists.push([...d.subarray(96 + 64 * i, 96 + 64 * i + 64)]);
	if (lists.every((l) => l.every((v) => v === 16)) || lists.some((l) => l.some((v) => v === 0))) return null;
	return lists;
}

/** One slice of a picture: its VA slice parameters (the fields used) and its NAL unit. */
export interface VaH264Slice {
	firstMb: number;
	sliceType: number;
	numRefIdxL0: number;
	numRefIdxL1: number;
	nal: Uint8Array;
}

/** The slices of a picture, each slice data buffer cut by the slice parameter buffer before it (start codes stripped). */
export function vaH264Slices(p: VaPicture): VaH264Slice[] {
	const out: VaH264Slice[] = [];
	let params: VaPicture["bufs"][number] | null = null;
	for (const b of p.bufs) {
		if (b.type === VA_BUF.sliceParameter) {
			if (b.size < 28) throw new Error(`slice parameters of ${b.size} bytes`);
			params = b;
		} else if (b.type === VA_BUF.sliceData) {
			if (!params) throw new Error("slice data without slice parameters");
			const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
			let total = 0;
			for (let i = 0; i < params.num; i++) {
				const o = i * params.size, size = dv.getUint32(o, true), off = dv.getUint32(o + 4, true);
				if (off + size > b.data.length) throw new Error(`slice ${out.length}: bytes ${off} to ${off + size} of a slice data buffer of ${b.data.length}`);
				// slices do not overlap: more bytes than the buffer has would copy it many times over
				if ((total += size) > b.data.length) throw new Error(`slices of more bytes than their slice data buffer's ${b.data.length}`);
				let nal = b.data.subarray(off, off + size);
				// some apps pass the start code too
				if (nal.length > 3 && nal[0] === 0 && nal[1] === 0 && (nal[2] === 1 || (nal[2] === 0 && nal[3] === 1))) nal = nal.subarray(nal[2] === 1 ? 3 : 4);
				out.push({ firstMb: dv.getUint16(o + 14, true), sliceType: params.data[o + 16]! % 5, numRefIdxL0: params.data[o + 18]! + 1, numRefIdxL1: params.data[o + 19]! + 1, nal });
			}
			params = null;
		}
	}
	return out;
}

// ---- the output model ----

/** A picture as libavcodec's output process sees it. */
export interface ModelPic {
	pic: number;
	poc: number;
	/** an IDR (AV_FRAME_FLAG_KEY: no SEI reaches the decoder, so no recovery points) */
	key: boolean;
	/** mmco_reset: an MMCO 5, or a POC below the last 16 (libavcodec's "Invalid POC") */
	mmco: boolean;
}

const DPB = 16;

/**
 * libavcodec's h264_select_output_frame (FFmpeg 7.1, the decoder of
 * Chromium's software path) with bitstream_restriction_flag set:
 * has_b_frames = max(has_b_frames, max_num_reorder_frames); a picture is
 * output once more than has_b_frames wait, the lowest POC first (up to the
 * next key or reset picture); one whose POC is below the last output's is
 * dropped.
 */
export class OutputModel {
	delayed: ModelPic[] = [];
	#next = -Infinity;
	#lastPocs: number[] = new Array(DPB).fill(-Infinity);
	#hasB = 0;

	clone(): OutputModel {
		const m = new OutputModel();
		m.delayed = this.delayed.slice();
		m.#next = this.#next;
		m.#lastPocs = this.#lastPocs.slice();
		m.#hasB = this.#hasB;
		return m;
	}

	/** The picture decoded: what is output, and what is dropped. */
	push(p: ModelPic, reorder: number): { out: ModelPic | null; dropped: ModelPic | null } {
		const cur = { ...p };
		this.#hasB = Math.max(this.#hasB, reorder);
		const lp = this.#lastPocs;
		let i = 0;
		for (; ; i++) {
			if (i === DPB || cur.poc < lp[i]!) {
				if (i) lp[i - 1] = cur.poc;
				break;
			} else if (i) lp[i - 1] = lp[i]!;
		}
		if (i === 0) {
			lp.fill(-Infinity);
			lp[0] = cur.poc;
			cur.mmco = true;
		}
		const d = this.delayed;
		d.push(cur);
		const pics = d.length;
		let out = d[0]!, idx = 0;
		for (let j = 1; j < d.length && !d[j]!.key && !d[j]!.mmco; j++)
			if (d[j]!.poc < out.poc) {
				out = d[j]!;
				idx = j;
			}
		if (this.#hasB === 0 && (d[0]!.key || d[0]!.mmco)) this.#next = -Infinity;
		const ooo = out.poc < this.#next;
		if (ooo || pics > this.#hasB) d.splice(idx, 1);
		if (!ooo && pics > this.#hasB) {
			this.#next = idx === 0 && d[0] && (d[0].key || d[0].mmco) ? -Infinity : out.poc;
			return { out, dropped: null };
		}
		return { out: null, dropped: ooo ? out : null };
	}

	held(pic: number): boolean {
		return this.delayed.some((p) => p.pic === pic);
	}
}

/** The least reorder depth (from `from`) with which the pictures, decoded from a fresh decoder, lose none; 16 at most. */
export function leastReorder(pics: ModelPic[], from = 0): number {
	for (let r = from; r < DPB; r++) {
		const m = new OutputModel();
		if (pics.every((p) => !m.push(p, r).dropped)) return r;
	}
	return DPB;
}

// ---- levels ----

/** level_idc, MaxFS, MaxDpbMbs (Table A-1), from 3.0 up */
const LEVELS: [number, number, number][] = [
	[30, 1620, 8100], [31, 3600, 18000], [32, 5120, 20480], [40, 8192, 32768], [41, 8192, 32768], [42, 8704, 34816], [50, 22080, 110400], [51, 36864, 184320],
	[52, 36864, 184320], [60, 139264, 696320], [61, 139264, 696320], [62, 139264, 696320],
];

/** The smallest level (from 3.0, or 3.1 when `min31`) for a picture of w x h MBs and a DPB of `frames`, and that level's DPB size in frames (at most 16). */
export function pickLevel(wMbs: number, hMbs: number, frames: number, min31 = false): { level: number; dpb: number } {
	const fs = wMbs * hMbs;
	for (const [level, maxFs, maxDpbMbs] of LEVELS) {
		if (min31 && level < 31) continue;
		if (fs > maxFs || wMbs * wMbs > 8 * maxFs || hMbs * hMbs > 8 * maxFs) continue;
		const dpb = Math.min(DPB, Math.floor(maxDpbMbs / fs));
		if (dpb >= frames) return { level, dpb };
	}
	return { level: 62, dpb: DPB };
}

// ---- the adapter ----

const PROFILES = { cb: { idc: 66, flags: 0xc0 }, main: { idc: 77, flags: 0x40 }, high: { idc: 100, flags: 0 } } as const;
export type H264VaProfile = keyof typeof PROFILES;

function concatAll(parts: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) out.set(p, n), (n += p.length);
	return out;
}
const START = new Uint8Array([0, 0, 0, 1]);

/** Annex B: each NAL unit after a 4-byte start code. */
export function annexB(units: Uint8Array[]): Uint8Array {
	return concatAll(units.flatMap((u) => [START, u]));
}

/** AVC format: each NAL unit after its size (4 bytes, big-endian), as avcC's lengthSizeMinusOne 3 says. */
export function lengthPrefixed(units: Uint8Array[]): Uint8Array {
	return concatAll(units.flatMap((u) => [Uint8Array.of(u.length >>> 24, (u.length >> 16) & 255, (u.length >> 8) & 255, u.length & 255), u]));
}

/** An AVCDecoderConfigurationRecord (avcC) of one SPS and one PPS (NAL units with their header bytes). */
export function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
	const out = [1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 255, ...sps, 1, pps.length >> 8, pps.length & 255, ...pps];
	// High profiles: chroma_format 4:2:0, 8 bits, no SPS extensions
	if (HIGH_SPS.has(sps[1]!)) out.push(0xfd, 0xf8, 0xf8, 0);
	return Uint8Array.from(out);
}

/**
 * The stream's own reorder depth as H.264 defines max_num_reorder_frames:
 * the most pictures that precede one in decoding order and follow it in
 * output order (from an IDR or an MMCO 5 on).
 */
export function streamReorder(pics: ModelPic[]): number {
	let r = 0, from = 0;
	for (let i = 0; i < pics.length; i++) {
		if (pics[i]!.key || pics[i]!.mmco) from = i;
		let n = 0;
		for (let j = from; j < i; j++) if (pics[j]!.poc > pics[i]!.poc) n++;
		r = Math.max(r, n);
	}
	return r;
}

/** How the adapter packages its chunks: Annex B, avcC (description and length-prefixed units), Annex B without the VUI. */
const VARIANTS = ["annexb", "avcc", "annexb-novui"] as const;

export interface H264AdapterState {
	/** max_num_reorder_frames now */
	reorder: number;
	profileIdc: number;
	/** the decoders made again for a deeper reorder */
	raises: number;
	mode: CodecMode;
	packaging: (typeof VARIANTS)[number];
}

/** A period's picture as the adapter keeps it (for the model, its replays and fillers). */
interface PeriodPic extends ModelPic {
	/** the chunk's timestamp: the period and the POC */
	order: number;
}

/**
 * The H.264 adapter of one VA context. Two modes: "model" (libavcodec's
 * output process predicts when the decoder gives each picture; the reorder
 * depth is the least that drops nothing in it) and "conservative" (nothing
 * is assumed of the decoder: the reorder depth is the stream's own, the
 * DPB the least the SPS allows, and a decoder holding pictures for lack
 * of input is given a filler: a non-reference picture of skipped
 * macroblocks whose POC is one past the picture waited for, which makes
 * the decoder give it and changes nothing a later picture uses).
 */
export function h264Adapter(vaProfile: H264VaProfile, log?: (msg: string) => void, initial: CodecMode = "model", holdExtra = 0): CodecAdapter & { state(): H264AdapterState } {
	let profileIdc: number = PROFILES[vaProfile].idc;
	let reorder = 0, raises = 0, variant = 0;
	let mode: CodecMode = initial;
	/** the pictures since the last IDR, for the model and its replays */
	let period: PeriodPic[] = [];
	let periodIndex = 0;
	/** streamReorder(period), kept up to date as pictures come (a period may be long: every picture since the IDR), and where its last IDR or MMCO 5 is */
	let periodReorder = 0, periodFrom = 0;
	let model = new OutputModel();
	let lastConfig: string | null = null;
	let config: CodecConfig | null = null;
	/** the newest picture's VA parameters (fillers are made with them) */
	let lastPp: VaH264PicParams | null = null;
	/** the newest reference picture: frame_num and its POC's MSB and LSB (null after an MMCO 5, or before an IDR) */
	let lastRef: { frameNum: number; msb: number; lsb: number; poc: number } | null = null;
	/** a POC that is not even (fillers need the odd ones free) */
	let oddPoc = false;
	/** the filler PPS's id (one the stream does not use), once made */
	let fillerPps = -1;
	/** per PPS id: the default reference counts last known */
	const defaults = new Map<number, [number, number]>();
	const warned = new Set<string>();
	const warn = (m: string) => {
		if (!warned.has(m)) warned.add(m), log?.(`[host] va: H.264: ${m}`);
	};
	const vui = () => VARIANTS[variant] !== "annexb-novui";
	const pack = (units: Uint8Array[]) => (VARIANTS[variant] === "avcc" ? lengthPrefixed(units) : annexB(units));
	const orderOf = (poc: number) => periodIndex * 2 ** 24 + Math.max(-(2 ** 23), Math.min(2 ** 23 - 1, poc)) + 2 ** 23;

	const spsOf = (pp: VaH264PicParams): H264Sps => {
		const heightMapUnits = pp.frameMbsOnly ? pp.heightMbs : pp.heightMbs >> 1;
		// (holdExtra, a test hook: a decoder that holds more than the model says)
		const declared = Math.min(DPB, reorder + holdExtra), frames = Math.max(pp.numRefFrames, declared, 1);
		const { level, dpb } = pickLevel(pp.widthMbs, pp.heightMbs, frames, pp.minLumaBiPred8x8);
		const flags = profileIdc === 66 ? 0xc0 : profileIdc === 77 ? 0x40 : 0;
		// conservative: the least DPB the SPS may declare, for decoders that hold pictures until it is full
		const maxDecFrameBuffering = mode === "conservative" ? frames : dpb;
		return {
			profileIdc, constraintFlags: flags, levelIdc: level, spsId: 0, chromaFormatIdc: 1, separateColourPlane: false, bitDepthLuma: 8, bitDepthChroma: 8,
			qpprimeYZeroTransformBypass: false, scaling: null, log2MaxFrameNum: pp.log2MaxFrameNum, pocType: pp.pocType, log2MaxPocLsb: pp.log2MaxPocLsb,
			deltaPicOrderAlwaysZero: pp.deltaPicOrderAlwaysZero, offsetForNonRefPic: 0, offsetForTopToBottomField: 0, offsetForRefFrame: [], maxNumRefFrames: pp.numRefFrames,
			gapsInFrameNumAllowed: pp.gapsInFrameNumAllowed, widthMbs: pp.widthMbs, heightMapUnits, frameMbsOnly: pp.frameMbsOnly, mbAdaptiveFrameField: pp.mbAdaptiveFrameField,
			direct8x8Inference: pp.direct8x8Inference, crop: null, vui: vui() ? { bitstreamRestriction: { maxNumReorderFrames: declared, maxDecFrameBuffering } } : null,
		};
	};
	/** the model again from the period's pictures (a fresh decoder given the stream since the IDR) */
	const remodel = (upto = period.length) => {
		model = new OutputModel();
		for (const q of period.slice(0, upto)) model.push(q, reorder);
	};
	const makeConfig = (pp: VaH264PicParams, ppsNal: Uint8Array): CodecConfig => {
		const spsNal = nalUnit(7, 3, writeSps(spsOf(pp)));
		const codec = avcCodecString(spsOf(pp));
		return VARIANTS[variant] === "avcc" ? { codec, description: avcC(spsNal, ppsNal) } : { codec };
	};
	let lastPpsNal: Uint8Array | null = null;

	return {
		config: () => (lastPp && lastPpsNal ? makeConfig(lastPp, lastPpsNal) : config),
		held: (pic) => mode === "model" && model.held(pic),
		mode: () => mode,
		reset() {
			// a fresh decoder (libavcodec's output state included) given the stream since the IDR
			remodel();
		},
		state: () => ({ reorder, profileIdc, raises, mode, packaging: VARIANTS[variant]! }),
		info: () => ({ reorder, profileIdc, packaging: VARIANTS[variant]!, raises }),
		variants: VARIANTS.length,
		variant(i) {
			variant = i;
			if (!vui() && mode === "model") {
				mode = "conservative";
				warn("decoded without the VUI: conservative mode");
			}
		},
		probe(i) {
			// a 1080p High picture's SPS and PPS
			const sps = nalUnit(7, 3, writeSps({
				profileIdc: PROFILES[vaProfile].idc, constraintFlags: PROFILES[vaProfile].flags, levelIdc: 40, spsId: 0, chromaFormatIdc: 1, separateColourPlane: false, bitDepthLuma: 8,
				bitDepthChroma: 8, qpprimeYZeroTransformBypass: false, scaling: null, log2MaxFrameNum: 4, pocType: 0, log2MaxPocLsb: 6, deltaPicOrderAlwaysZero: false,
				offsetForNonRefPic: 0, offsetForTopToBottomField: 0, offsetForRefFrame: [], maxNumRefFrames: 4, gapsInFrameNumAllowed: false, widthMbs: 120, heightMapUnits: 68,
				frameMbsOnly: true, mbAdaptiveFrameField: false, direct8x8Inference: true, crop: null, vui: VARIANTS[i] === "annexb-novui" ? null : { bitstreamRestriction: { maxNumReorderFrames: 2, maxDecFrameBuffering: 4 } },
			}));
			const pps = nalUnit(8, 3, writePps({
				ppsId: 0, spsId: 0, entropyCodingMode: vaProfile !== "cb", bottomFieldPicOrderInFramePresent: false, numRefIdxL0Default: 1, numRefIdxL1Default: 1, weightedPred: false,
				weightedBipredIdc: 0, picInitQp: 26, picInitQs: 26, chromaQpIndexOffset: 0, deblockingFilterControlPresent: true, constrainedIntraPred: false,
				redundantPicCntPresent: false, extended: false, transform8x8Mode: false, scaling: null, secondChromaQpIndexOffset: 0,
			}));
			const codec = avcCodecString({ profileIdc: PROFILES[vaProfile].idc, constraintFlags: PROFILES[vaProfile].flags, levelIdc: 40 });
			return VARIANTS[i] === "avcc" ? { codec, description: avcC(sps, pps) } : { codec };
		},
		conservative(why) {
			if (mode === "conservative") return false;
			mode = "conservative";
			const r = periodReorder;
			log?.(`[host] va: H.264: conservative mode (${why}): max_num_reorder_frames ${reorder} -> ${r} (the stream's own), max_dec_frame_buffering the least the SPS allows`);
			reorder = r;
			remodel();
			return true;
		},
		dropped(pics) {
			if (!vui() || reorder >= DPB) return false;
			const r = Math.min(DPB, Math.max(reorder + 1, periodReorder));
			log?.(`[host] va: H.264: the decoder dropped ${pics.length} picture(s): max_num_reorder_frames ${reorder} -> ${r}`);
			reorder = r;
			raises++;
			remodel();
			return true;
		},
		filler(pic, given) {
			// one per picture: the one POC between it and the next is the only free one
			if (given) return null;
			// eligible: conservative, frames only, a reference picture to skip from; POC type 0 with only even POCs so far (the
			// next one up is free) or type 2 (a non-reference picture right after the last reference one: its POC + 1)
			const pp = lastPp;
			if (mode !== "conservative" || !pp || !pp.frameMbsOnly || !lastRef || pp.numRefFrames < 1 || (pp.pocType === 0 && oddPoc) || pp.pocType === 1) return null;
			const x = period.find((q) => q.pic === pic);
			if (!x) return null;
			const target = pp.pocType === 2 ? lastRef.poc + 1 : x.poc + 1;
			if (target <= x.poc) return null;
			// pic_order_cnt_lsb that gives the target POC after the last reference picture (8.2.1.1)
			const max = 2 ** pp.log2MaxPocLsb, lsb = ((target % max) + max) % max;
			let msb = lastRef.msb;
			if (lsb < lastRef.lsb && lastRef.lsb - lsb >= max / 2) msb += max;
			else if (lsb > lastRef.lsb && lsb - lastRef.lsb > max / 2) msb -= max;
			if (pp.pocType === 0 && msb + lsb !== target) return null;
			if (fillerPps < 0) {
				for (let id = 255; id >= 0 && fillerPps < 0; id--) if (!defaults.has(id)) fillerPps = id;
				if (fillerPps < 0) return null;
			}
			const ppsNal = nalUnit(8, 3, writePps({
				ppsId: fillerPps, spsId: 0, entropyCodingMode: false, bottomFieldPicOrderInFramePresent: false, numRefIdxL0Default: 1, numRefIdxL1Default: 1, weightedPred: false,
				weightedBipredIdc: 0, picInitQp: 26, picInitQs: 26, chromaQpIndexOffset: 0, deblockingFilterControlPresent: true, constrainedIntraPred: false,
				redundantPicCntPresent: false, extended: false, transform8x8Mode: false, scaling: null, secondChromaQpIndexOffset: 0,
			}));
			const w = new BitWriter();
			w.ue(0); // first_mb_in_slice
			w.ue(0); // slice_type P
			w.ue(fillerPps);
			w.u(pp.log2MaxFrameNum, (lastRef.frameNum + 1) % 2 ** pp.log2MaxFrameNum);
			if (pp.pocType === 0) w.u(pp.log2MaxPocLsb, lsb);
			w.u(1, 0); // num_ref_idx_active_override_flag
			w.u(1, 0); // ref_pic_list_modification_flag_l0
			w.se(0); // slice_qp_delta
			w.ue(1); // disable_deblocking_filter_idc
			w.ue(pp.widthMbs * pp.heightMbs); // mb_skip_run: every macroblock P_Skip
			w.trailing();
			return { data: pack([ppsNal, nalUnit(1, 0, w.bytes())]), key: false, output: false, added: true, order: orderOf(target) };
		},
		picture(p: VaPicture): CodecChunk[] {
			const pb = p.bufs.find((b) => b.type === VA_BUF.picture);
			if (!pb) throw new Error("no picture parameters");
			const pp = parseVaH264PicParams(pb.data);
			if (pp.fieldPic) throw new Error("field pictures (PAFF interlacing) are not supported");
			if (pp.chromaFormatIdc !== 1) throw new Error(`chroma_format_idc ${pp.chromaFormatIdc} (only 4:2:0 is supported)`);
			if (pp.bitDepthLuma !== 8 || pp.bitDepthChroma !== 8) throw new Error(`a bit depth of ${pp.bitDepthLuma}/${pp.bitDepthChroma} (only 8 is supported)`);
			if (pp.numSliceGroups > 1) throw new Error("slice groups (FMO) are not supported");
			if (pp.pocType === 1) throw new Error("pic_order_cnt_type 1 is not supported (VA does not carry its offsets)");
			if (pp.pocType > 2) throw new Error(`a bad pic_order_cnt_type ${pp.pocType}`);
			if (!pp.frameMbsOnly && pp.heightMbs < 2) throw new Error(`a frame of ${pp.heightMbs} MB row(s) without frame_mbs_only`);
			const iq = parseVaH264Iq(p.bufs.find((b) => b.type === VA_BUF.iqMatrix)?.data ?? null);
			const slices = vaH264Slices(p);
			if (!slices.length) throw new Error("no slices");
			const ctx: SliceContext = { ...pp, chromaArrayType: 1 };
			let first: H264Slice | null = null;
			let l0: number | null = null, l1: number | null = null, anyB = false;
			for (const sl of slices) {
				const h = parseSliceHeader(sl.nal, ctx, first ? undefined : { counts: [sl.numRefIdxL0, sl.numRefIdxL1] });
				if (h.firstMb !== sl.firstMb || h.sliceType !== sl.sliceType)
					throw new Error(`slice header (first_mb ${h.firstMb}, slice_type ${h.sliceType}) and VA's slice parameters (${sl.firstMb}, ${sl.sliceType}) differ`);
				if (first && (h.ppsId !== first.ppsId || h.nalType !== first.nalType)) throw new Error("slices of one picture with different PPS ids or NAL unit types");
				first ??= h;
				if (h.frameNum !== pp.frameNum) throw new Error(`frame_num ${h.frameNum} in the slice header, ${pp.frameNum} in VA's picture parameters`);
				const isB = h.sliceType === 1, isP = h.sliceType === 0 || h.sliceType === 3;
				anyB ||= isB;
				if ((isP || isB) && !h.override) {
					if (l0 !== null && l0 !== sl.numRefIdxL0) throw new Error("slices disagree on the default reference count");
					l0 = sl.numRefIdxL0;
					if (isB) l1 = sl.numRefIdxL1;
				}
			}
			const f = first!;
			const idr = f.nalType === 5;
			// what the PPS defaults are: these slices', else what was known for this PPS id
			if (f.ppsId === fillerPps) fillerPps = -1; // the stream uses it after all: the next filler takes another
			const known = defaults.get(f.ppsId) ?? [1, 1];
			const dflt: [number, number] = [l0 ?? known[0], l1 ?? known[1]];
			defaults.set(f.ppsId, dflt);

			// the profile: the context's, raised to what the picture uses (sticky)
			const needHigh = pp.transform8x8Mode || !!iq || pp.secondChromaQpIndexOffset !== pp.chromaQpIndexOffset;
			const needMain = pp.entropyCodingMode || pp.weightedPred || pp.weightedBipredIdc !== 0 || anyB || !pp.frameMbsOnly;
			const need = needHigh ? 100 : needMain ? 77 : 66;
			let restart = false;
			if (need > profileIdc) {
				warn(`the stream uses ${need === 100 ? "High" : "Main"} profile tools in a ${vaProfile} context: decoded as ${need === 100 ? "High" : "Main"}`);
				profileIdc = need;
				restart = !idr;
			}

			// the output order: a new period at an IDR or an MMCO 5 (the pictures before it come out first)
			const poc = Math.min(pp.curr.top, pp.curr.bottom);
			if (idr || f.mmco5) periodIndex++;
			const mp: PeriodPic = { pic: p.pic, poc: f.mmco5 && !idr ? 0 : poc, key: idr, mmco: !!f.mmco5, order: 0 };
			mp.order = orderOf(mp.poc);
			if (pp.curr.top % 2 || pp.curr.bottom % 2) oddPoc = true;
			if (idr) (period = []), (periodReorder = 0);
			period.push(mp);
			// streamReorder(period) for the new picture only: the pictures before it since the last IDR or MMCO 5 that come after it
			if (mp.key || mp.mmco) periodFrom = period.length - 1;
			for (let j = periodFrom, n = 0; j < period.length - 1; j++) if (period[j]!.poc > mp.poc && ++n > periodReorder) periodReorder = n;
			// the reorder depth: raised before a picture would be dropped (model) or come out of order (conservative)
			const r = mode === "model" ? (model.clone().push(mp, reorder).dropped ? leastReorder(period, reorder + 1) : reorder) : Math.max(reorder, periodReorder);
			if (r > reorder && vui()) {
				log?.(`[host] va: H.264: max_num_reorder_frames ${reorder} -> ${r} (picture POC ${mp.poc} would have come out ${mode === "model" ? "of order" : "late"}); the decoder is made again with the stream since the IDR`);
				reorder = r;
				raises++;
				restart = !idr;
			}
			// the decoder made again before this chunk decodes the pictures since the IDR from scratch
			if (restart) remodel(period.length - 1);
			model.push(mp, reorder);
			// what a filler needs: the newest reference picture
			if (pp.referencePic || idr) lastRef = f.mmco5 ? null : { frameNum: idr ? 0 : pp.frameNum, msb: pp.curr.top - (f.pocLsb ?? 0), lsb: f.pocLsb ?? 0, poc };
			lastPp = pp;

			const pps: H264Pps = {
				ppsId: f.ppsId, spsId: 0, entropyCodingMode: pp.entropyCodingMode, bottomFieldPicOrderInFramePresent: pp.bottomFieldPicOrderInFramePresent,
				numRefIdxL0Default: dflt[0], numRefIdxL1Default: dflt[1], weightedPred: pp.weightedPred, weightedBipredIdc: pp.weightedBipredIdc, picInitQp: pp.picInitQp,
				picInitQs: pp.picInitQs, chromaQpIndexOffset: pp.chromaQpIndexOffset, deblockingFilterControlPresent: pp.deblockingFilterControlPresent,
				constrainedIntraPred: pp.constrainedIntraPred, redundantPicCntPresent: pp.redundantPicCntPresent, extended: needHigh, transform8x8Mode: pp.transform8x8Mode,
				scaling: iq, secondChromaQpIndexOffset: pp.secondChromaQpIndexOffset,
			};
			const ppsNal = nalUnit(8, 3, writePps(pps));
			lastPpsNal = ppsNal;
			const nals = slices.map((s) => s.nal);
			// the SPS as it is when the chunk is decoded (a replay after a raise carries the deeper reorder), in the packaging of then
			const build = () => pack([nalUnit(7, 3, writeSps(spsOf(pp))), ppsNal, ...nals]);
			const data = build();
			// replays take the slices from the chunk's own bytes (the last units, 4 bytes before each in both packagings): the
			// guest's buffers, which may be much larger than the chunk, are not kept alive by the session's history
			for (let i = nals.length - 1, at = data.length; i >= 0; i--) (nals[i] = data.subarray(at - nals[i]!.length, at)), (at -= nals[i]!.length + 4);
			config = makeConfig(pp, ppsNal);
			const cfgKey = `${config.codec} ${pp.widthMbs}x${pp.heightMbs}`;
			const reconfigure = idr && lastConfig !== null && lastConfig !== cfgKey;
			if (idr) lastConfig = cfgKey;
			return [{ data, key: idr, output: true, order: mp.order, ...(reconfigure ? { reconfigure } : {}), ...(restart ? { restart } : {}), remake: build }];
		},
	};
}
