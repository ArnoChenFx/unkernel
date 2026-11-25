// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's AV1 (the CodecAdapter of js/core/va.ts for the VA profile
// "av1.0": profile 0, 8-bit 4:2:0; .agents/va.md, AV1).
//
// VA-API hands the driver VADecPictureParameterBufferAV1 (the parsed
// sequence and frame header) and per tile group the tile data with
// VASliceParameterBufferAV1 (each tile's offset, size, row and column);
// WebCodecs wants temporal units of OBUs. So each picture becomes a
// temporal delimiter, a sequence header OBU (in key chunks), a frame header
// OBU and tile group OBUs, all written here:
//
// - The sequence header carries VA's fields and chooses the rest so that
//   every frame header field VA has can be written as VA has it:
//   enable_warped_motion, enable_superres, enable_restoration and
//   enable_ref_frame_mvs on, screen content tools and integer MVs chosen
//   per frame, separate_uv_delta_q on, 16-bit frame sizes (max: the
//   context's), no frame ids, no timing or decoder model, no colour
//   description (it changes no decoded sample).
// - The frame header is written field by field from VA's values (effective
//   ones, as ffmpeg's CBS infers them from the reference frames: loop
//   filter deltas written with update flags for all, segmentation and its
//   update flags as VA has them, film grain always with update_grain);
//   global motion parameters are coded relative to those the decoder loads
//   from the primary reference frame, which the adapter keeps per slot.
// - VA has no refresh_frame_flags (the app keeps its own reference map,
//   ref_frame_map[8], as surfaces): the adapter keeps the decoder's 8 slots
//   itself. A picture goes into a slot whose picture the app's map no longer
//   has (no later picture can refer to it) or holds twice, so the decoder holds every
//   picture the app may still use; when the app's map holds 8 distinct
//   pictures there is none, and the picture is not stored: if the next
//   picture's map shows the app kept it, it is decoded again first, hidden
//   (show_frame 0, showable_frame 1), into a slot the app has just freed.
//   Decoding depends only on the slots ref_frame_idx names, so the second
//   decode is the first's. ref_frame_idx names the slots holding the app's
//   references.
// - Hidden frames (show_frame 0) are written with show_frame 1, so their
//   picture comes out right away (VA expects every picture to complete; the
//   app shows them later through show_existing_frame, which it handles
//   without VA). That changes nothing the frame stores: show_frame only
//   decides whether showable_frame is read (inferred 1 for a shown inter or
//   intra-only frame) and film grain is read for shown or showable frames,
//   reset otherwise, which VA's apply_grain 0 writes as well. Hidden key
//   frames (they would refresh every slot when shown) are refused.
// - Tile data is copied into tile group OBUs with 4-byte tile sizes
//   (tile_size_bytes_minus_1 3), whatever sizes the app's stream had.
// - Large-scale tile, 10 and 12 bits, monochrome and other profiles are
//   refused.
//
// The output model: one output per picture, right after its chunk (AV1
// decoders output in decode order). The filler for a decoder that holds
// its last output: a show_existing_frame of a slot holding a non-key frame
// (only showing a key frame changes the decoder's state).

import { BitWriter, type CodecAdapter, type CodecChunk, type CodecMode, leb128, type VaPicture, VA_BUF } from "./va-codec.ts";

// ---- VA's buffers (va_dec_av1.h 1.22; the same layout on aarch64 and x86-64) ----

/** sizeof(VADecPictureParameterBufferAV1) and the bytes the host reads (before va_reserved); the slice parameters' likewise */
export const VA_AV1_PIC_SIZE = 1160, VA_AV1_PIC_USED = 1124, VA_AV1_SLICE_SIZE = 40, VA_AV1_SLICE_USED = 24;

export interface Av1GrainParams {
	apply: boolean;
	chromaScalingFromLuma: boolean;
	scalingMinus8: number;
	arLag: number;
	arShiftMinus6: number;
	scaleShift: number;
	overlap: boolean;
	clip: boolean;
	seed: number;
	/** [value, scaling] points */
	y: [number, number][];
	cb: [number, number][];
	cr: [number, number][];
	arY: number[];
	arCb: number[];
	arCr: number[];
	cbMult: number;
	cbLumaMult: number;
	cbOffset: number;
	crMult: number;
	crLumaMult: number;
	crOffset: number;
}

/** VADecPictureParameterBufferAV1, the fields used */
export interface VaAv1PicParams {
	profile: number;
	orderHintBits: number;
	bitDepthIdx: number;
	stillPicture: boolean;
	sb128: boolean;
	enableFilterIntra: boolean;
	enableIntraEdge: boolean;
	enableInterintra: boolean;
	enableMasked: boolean;
	enableDualFilter: boolean;
	enableOrderHint: boolean;
	enableJntComp: boolean;
	enableCdef: boolean;
	mono: boolean;
	colorRange: boolean;
	ssx: number;
	ssy: number;
	chromaSamplePosition: number;
	filmGrainPresent: boolean;
	currentFrame: number;
	displayPicture: number;
	width: number;
	height: number;
	refFrameMap: number[];
	refFrameIdx: number[];
	primaryRefFrame: number;
	orderHint: number;
	seg: { enabled: boolean; updateMap: boolean; temporalUpdate: boolean; updateData: boolean; data: number[][]; mask: number[] };
	grain: Av1GrainParams;
	tileCols: number;
	tileRows: number;
	widthSbs: number[];
	heightSbs: number[];
	contextUpdateTileId: number;
	frameType: number;
	showFrame: boolean;
	showableFrame: boolean;
	errorRes: boolean;
	disableCdfUpdate: boolean;
	screenContent: boolean;
	forceIntegerMv: boolean;
	intrabc: boolean;
	superres: boolean;
	hpMv: boolean;
	motionSwitchable: boolean;
	refFrameMvs: boolean;
	disableFrameEndUpdateCdf: boolean;
	uniformTiles: boolean;
	warpedMotion: boolean;
	largeScaleTile: boolean;
	superresDenom: number;
	interpFilter: number;
	lfLevel: [number, number, number, number];
	sharpness: number;
	deltaEnabled: boolean;
	deltaUpdate: boolean;
	refDeltas: number[];
	modeDeltas: number[];
	baseQ: number;
	dq: { ydc: number; udc: number; uac: number; vdc: number; vac: number };
	qm: { using: boolean; y: number; u: number; v: number };
	deltaQPresent: boolean;
	deltaQRes: number;
	deltaLfPresent: boolean;
	deltaLfRes: number;
	deltaLfMulti: boolean;
	txMode: number;
	referenceSelect: boolean;
	reducedTxSet: boolean;
	skipModePresent: boolean;
	cdefDampingMinus3: number;
	cdefBits: number;
	cdefY: number[];
	cdefUv: number[];
	/** FrameRestorationType per plane (NONE 0, WIENER 1, SGRPROJ 2, SWITCHABLE 3) */
	lrType: number[];
	lrUnitShift: number;
	lrUvShift: number;
	/** global motion of LAST..ALTREF: type (IDENTITY 0, TRANSLATION 1, ROTZOOM 2, AFFINE 3) and gm_params[0..5] */
	gm: { type: number; mat: number[] }[];
}

const KEY = 0, INTER = 1, INTRA_ONLY = 2, SWITCH = 3;
const NONE = 7;
const IDENTITY = 0, TRANSLATION = 1, ROTZOOM = 2, AFFINE = 3;

export function parseVaAv1PicParams(d: Uint8Array): VaAv1PicParams {
	if (d.length < VA_AV1_PIC_USED) throw new Error(`picture parameters of ${d.length} bytes (VADecPictureParameterBufferAV1 is ${VA_AV1_PIC_SIZE})`);
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const u8 = (o: number) => d[o]!, s8 = (o: number) => dv.getInt8(o), u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true);
	const bit = (v: number, at: number, n = 1) => (v >>> at) & ((1 << n) - 1);
	const seq = u32(4), pic = u32(676), lf = u8(686), qm = u16(704), mc = u32(708), lr = u16(730), segf = u32(84), fg = u32(240);
	const points = (n: number, vo: number, so: number) => Array.from({ length: n }, (_, i) => [u8(vo + i), u8(so + i)] as [number, number]);
	return {
		profile: u8(0), orderHintBits: u8(1) + 1, bitDepthIdx: u8(2),
		stillPicture: !!bit(seq, 0), sb128: !!bit(seq, 1), enableFilterIntra: !!bit(seq, 2), enableIntraEdge: !!bit(seq, 3), enableInterintra: !!bit(seq, 4), enableMasked: !!bit(seq, 5),
		enableDualFilter: !!bit(seq, 6), enableOrderHint: !!bit(seq, 7), enableJntComp: !!bit(seq, 8), enableCdef: !!bit(seq, 9), mono: !!bit(seq, 10), colorRange: !!bit(seq, 11),
		ssx: bit(seq, 12), ssy: bit(seq, 13), chromaSamplePosition: bit(seq, 14), filmGrainPresent: !!bit(seq, 15),
		currentFrame: u32(8), displayPicture: u32(12), width: u16(32) + 1, height: u16(34) + 1,
		refFrameMap: Array.from({ length: 8 }, (_, i) => u32(40 + 4 * i)), refFrameIdx: Array.from({ length: 7 }, (_, i) => u8(72 + i)), primaryRefFrame: u8(79), orderHint: u8(80),
		seg: {
			enabled: !!bit(segf, 0), updateMap: !!bit(segf, 1), temporalUpdate: !!bit(segf, 2), updateData: !!bit(segf, 3),
			data: Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => dv.getInt16(88 + 16 * i + 2 * j, true))), mask: Array.from({ length: 8 }, (_, i) => u8(84 + 132 + i)),
		},
		grain: {
			apply: !!bit(fg, 0), chromaScalingFromLuma: !!bit(fg, 1), scalingMinus8: bit(fg, 2, 2), arLag: bit(fg, 4, 2), arShiftMinus6: bit(fg, 6, 2), scaleShift: bit(fg, 8, 2),
			overlap: !!bit(fg, 10), clip: !!bit(fg, 11), seed: u16(244), y: points(Math.min(14, u8(246)), 247, 261), cb: points(Math.min(10, u8(275)), 276, 286), cr: points(Math.min(10, u8(296)), 297, 307),
			arY: Array.from({ length: 24 }, (_, i) => s8(317 + i)), arCb: Array.from({ length: 25 }, (_, i) => s8(341 + i)), arCr: Array.from({ length: 25 }, (_, i) => s8(366 + i)),
			cbMult: u8(391), cbLumaMult: u8(392), cbOffset: u16(394), crMult: u8(396), crLumaMult: u8(397), crOffset: u16(398),
		},
		tileCols: u8(416), tileRows: u8(417), widthSbs: Array.from({ length: 63 }, (_, i) => u16(418 + 2 * i) + 1), heightSbs: Array.from({ length: 63 }, (_, i) => u16(544 + 2 * i) + 1),
		contextUpdateTileId: u16(672),
		frameType: bit(pic, 0, 2), showFrame: !!bit(pic, 2), showableFrame: !!bit(pic, 3), errorRes: !!bit(pic, 4), disableCdfUpdate: !!bit(pic, 5), screenContent: !!bit(pic, 6),
		forceIntegerMv: !!bit(pic, 7), intrabc: !!bit(pic, 8), superres: !!bit(pic, 9), hpMv: !!bit(pic, 10), motionSwitchable: !!bit(pic, 11), refFrameMvs: !!bit(pic, 12),
		disableFrameEndUpdateCdf: !!bit(pic, 13), uniformTiles: !!bit(pic, 14), warpedMotion: !!bit(pic, 15), largeScaleTile: !!bit(pic, 16),
		superresDenom: u8(680), interpFilter: u8(681), lfLevel: [u8(682), u8(683), u8(684), u8(685)], sharpness: bit(lf, 0, 3), deltaEnabled: !!bit(lf, 3), deltaUpdate: !!bit(lf, 4),
		refDeltas: Array.from({ length: 8 }, (_, i) => s8(687 + i)), modeDeltas: [s8(695), s8(696)], baseQ: u8(697),
		dq: { ydc: s8(698), udc: s8(699), uac: s8(700), vdc: s8(701), vac: s8(702) },
		qm: { using: !!bit(qm, 0), y: bit(qm, 1, 4), u: bit(qm, 5, 4), v: bit(qm, 9, 4) },
		deltaQPresent: !!bit(mc, 0), deltaQRes: bit(mc, 1, 2), deltaLfPresent: !!bit(mc, 3), deltaLfRes: bit(mc, 4, 2), deltaLfMulti: !!bit(mc, 6), txMode: bit(mc, 7, 2),
		referenceSelect: !!bit(mc, 9), reducedTxSet: !!bit(mc, 10), skipModePresent: !!bit(mc, 11),
		cdefDampingMinus3: u8(712), cdefBits: u8(713), cdefY: Array.from({ length: 8 }, (_, i) => u8(714 + i)), cdefUv: Array.from({ length: 8 }, (_, i) => u8(722 + i)),
		lrType: [bit(lr, 0, 2), bit(lr, 2, 2), bit(lr, 4, 2)], lrUnitShift: bit(lr, 6, 2), lrUvShift: bit(lr, 8),
		gm: Array.from({ length: 7 }, (_, i) => ({ type: u32(732 + 56 * i), mat: Array.from({ length: 6 }, (_, j) => dv.getInt32(732 + 56 * i + 4 + 4 * j, true)) })),
	};
}

/** One tile group of a picture: its tiles (raster index from tile_row and tile_column), each tile's data. */
export interface Av1TileGroup {
	start: number;
	end: number;
	tiles: Uint8Array[];
}

/**
 * The tile groups of a picture: each slice data buffer cut by its slice
 * parameters, its tiles consecutive in raster order. With one data buffer
 * every parameter buffer is for it, wherever it comes (Chromium: the data,
 * then a parameter buffer per tile); with several, each has the parameter
 * buffer next to it (ffmpeg: before it). Parameters are num elements, or
 * one element of several structures' bytes.
 */
export function av1TileGroups(p: VaPicture, tileCols: number): Av1TileGroup[] {
	type Buf = VaPicture["bufs"][number];
	const out: Av1TileGroup[] = [];
	let count = 0;
	const group = (all: Buf[], b: Buf): void => {
		const tiles: { idx: number; data: Uint8Array }[] = [];
		let total = 0;
		for (const params of all) {
			const dv = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
			const whole = params.num === 1 && params.size > VA_AV1_SLICE_SIZE && params.size % VA_AV1_SLICE_SIZE === 0;
			const stride = whole ? VA_AV1_SLICE_SIZE : params.size, num = whole ? params.size / VA_AV1_SLICE_SIZE : params.num;
			if (num * stride > params.data.byteLength) throw new Error(`slice parameters of ${params.data.byteLength} bytes for ${num} tiles`);
			// a frame has at most 64 x 64 tiles
			if ((count += num) > 4096) throw new Error("more than 4096 tiles");
			for (let i = 0; i < num; i++) {
				const o = i * stride, size = dv.getUint32(o, true), off = dv.getUint32(o + 4, true);
				if (off + size > b.data.length) throw new Error(`tile ${tiles.length}: bytes ${off} to ${off + size} of a tile data buffer of ${b.data.length}`);
				// tiles do not overlap: more bytes than the buffer has would copy it many times over
				if ((total += size) > b.data.length) throw new Error(`tiles of more bytes than their tile data buffer's ${b.data.length}`);
				tiles.push({ idx: dv.getUint16(o + 12, true) * tileCols + dv.getUint16(o + 14, true), data: b.data.subarray(off, off + size) });
			}
		}
		tiles.sort((a, c) => a.idx - c.idx);
		if (tiles.some((t, i) => t.idx !== tiles[0]!.idx + i)) throw new Error("a tile group whose tiles are not consecutive");
		if (tiles.length) out.push({ start: tiles[0]!.idx, end: tiles[tiles.length - 1]!.idx, tiles: tiles.map((t) => t.data) });
	};
	const allParams = p.bufs.filter((b) => b.type === VA_BUF.sliceParameter), allData = p.bufs.filter((b) => b.type === VA_BUF.sliceData);
	for (const b of allParams) if (b.size < VA_AV1_SLICE_USED) throw new Error(`slice parameters of ${b.size} bytes`);
	if (allData.length === 1) {
		if (!allParams.length) throw new Error("tile data without slice parameters");
		group(allParams, allData[0]!);
	} else {
		let params: Buf | null = null, data: Buf | null = null;
		for (const b of p.bufs) {
			if (b.type === VA_BUF.sliceParameter) {
				if (data) group([b], data), (data = null);
				else params = b;
			} else if (b.type === VA_BUF.sliceData) {
				if (params) group([params], b), (params = null);
				else if (data) throw new Error("tile data without slice parameters");
				else data = b;
			}
		}
		if (data) throw new Error("tile data without slice parameters");
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}

// ---- the bitstream ----

/** An OBU: header (no extension, with obu_size) and payload. */
export function obu(type: number, payload: Uint8Array): Uint8Array {
	const size = leb128(payload.length), out = new Uint8Array(1 + size.length + payload.length);
	out[0] = (type << 3) | 2;
	out.set(size, 1);
	out.set(payload, 1 + size.length);
	return out;
}
export const OBU_SEQUENCE_HEADER = 1, OBU_TEMPORAL_DELIMITER = 2, OBU_FRAME_HEADER = 3, OBU_TILE_GROUP = 4;

/** The sequence header's fields the adapter writes (the rest are fixed: see the top of this file). */
export interface Av1Seq {
	stillPicture: boolean;
	level: number;
	maxWidth: number;
	maxHeight: number;
	sb128: boolean;
	enableFilterIntra: boolean;
	enableIntraEdge: boolean;
	enableInterintra: boolean;
	enableMasked: boolean;
	enableDualFilter: boolean;
	enableOrderHint: boolean;
	enableJntComp: boolean;
	orderHintBits: number;
	enableCdef: boolean;
	colorRange: boolean;
	chromaSamplePosition: number;
	filmGrainPresent: boolean;
}

export function writeSequenceHeader(s: Av1Seq): Uint8Array {
	const w = new BitWriter();
	w.u(3, 0); // seq_profile
	w.u(1, s.stillPicture ? 1 : 0);
	w.u(1, 0); // reduced_still_picture_header
	w.u(1, 0); // timing_info_present_flag
	w.u(1, 0); // initial_display_delay_present_flag
	w.u(5, 0); // operating_points_cnt_minus_1
	w.u(12, 0); // operating_point_idc[0]
	w.u(5, s.level);
	if (s.level > 7) w.u(1, 0); // seq_tier
	w.u(4, 15); // frame_width_bits_minus_1
	w.u(4, 15);
	w.u(16, s.maxWidth - 1);
	w.u(16, s.maxHeight - 1);
	w.u(1, 0); // frame_id_numbers_present_flag
	w.u(1, s.sb128 ? 1 : 0);
	w.u(1, s.enableFilterIntra ? 1 : 0);
	w.u(1, s.enableIntraEdge ? 1 : 0);
	w.u(1, s.enableInterintra ? 1 : 0);
	w.u(1, s.enableMasked ? 1 : 0);
	w.u(1, 1); // enable_warped_motion
	w.u(1, s.enableDualFilter ? 1 : 0);
	w.u(1, s.enableOrderHint ? 1 : 0);
	if (s.enableOrderHint) {
		w.u(1, s.enableJntComp ? 1 : 0);
		w.u(1, 1); // enable_ref_frame_mvs
	}
	w.u(1, 1); // seq_choose_screen_content_tools: SELECT_SCREEN_CONTENT_TOOLS
	w.u(1, 1); // seq_choose_integer_mv: SELECT_INTEGER_MV
	if (s.enableOrderHint) w.u(3, s.orderHintBits - 1);
	w.u(1, 1); // enable_superres
	w.u(1, s.enableCdef ? 1 : 0);
	w.u(1, 1); // enable_restoration
	// color_config: 8 bits, not monochrome, no colour description, 4:2:0
	w.u(1, 0); // high_bitdepth
	w.u(1, 0); // mono_chrome
	w.u(1, 0); // color_description_present_flag
	w.u(1, s.colorRange ? 1 : 0);
	w.u(2, s.chromaSamplePosition);
	w.u(1, 1); // separate_uv_delta_q
	w.u(1, s.filmGrainPresent ? 1 : 0);
	w.trailing();
	return w.bytes();
}

/** seq_level_idx for a picture size (by MaxPicSize and MaxHSize/MaxVSize of levels 2.0 to 6.0, A.3). */
export function av1Level(w: number, h: number): number {
	const LEVELS: [number, number, number, number][] = [[0, 147456, 2048, 1152], [1, 278784, 2816, 1584], [4, 665856, 4352, 2448], [5, 1065024, 5504, 3096], [8, 2359296, 6144, 3456], [12, 8912896, 8192, 4352], [16, 35651584, 16384, 8704]];
	for (const [idx, size, hs, vs] of LEVELS) if (w * h <= size && w <= hs && h <= vs) return idx;
	return 31;
}

/** av01.P.LLT.DD */
export function av1CodecString(level: number): string {
	return `av01.0.${String(level).padStart(2, "0")}M.08`;
}

const tileLog2 = (blk: number, target: number) => {
	let k = 0;
	while (blk << k < target) k++;
	return k;
};

/** Signed sub-exponential code with reference (5.9.26 decode_signed_subexp_with_ref, written). */
export function writeSignedSubexpWithRef(w: BitWriter, v: number, low: number, high: number, r: number): void {
	const x = v - low, mx = high - low, rr = r - low;
	if (x < 0 || x >= mx) throw new RangeError(`a global motion parameter ${v} outside [${low}, ${high})`);
	const recenter = (r: number, v: number) => (v > 2 * r ? v : v >= r ? (v - r) << 1 : ((r - v) << 1) - 1);
	const sub = rr << 1 <= mx ? recenter(rr, x) : recenter(mx - 1 - rr, mx - 1 - x);
	// decode_subexp(numSyms = mx)
	let i = 0, mk = 0;
	const k = 3;
	for (;;) {
		const b2 = i ? k + i - 1 : k, a = 1 << b2;
		if (mx <= mk + 3 * a) return w.ns(mx - mk, sub - mk);
		if (sub >= mk + a) {
			w.u(1, 1);
			i++;
			mk += a;
		} else {
			w.u(1, 0);
			return w.u(b2, sub - mk);
		}
	}
}

/** The saved state of a decoder slot the adapter needs: which picture, its order hint and frame type, its global motion parameters. */
interface Slot {
	pic: number;
	orderHint: number;
	frameType: number;
	gm: number[][];
}
const DEFAULT_GM = () => Array.from({ length: 7 }, () => [0, 0, 1 << 16, 0, 0, 1 << 16]);

/** What a frame header needs besides VA's parameters. */
export interface Av1FrameEnv {
	seq: Av1Seq;
	/** show_frame and showable_frame as written */
	show: boolean;
	showable: boolean;
	refresh: number;
	/** the decoder's slots for ref_frame_idx[] (LAST..ALTREF) */
	refIdx: number[];
	slots: (Slot | null)[];
}

/** The frame header OBU's payload (uncompressed_header, 5.9) for VA's parameters; also what its tile groups need. */
export function writeFrameHeader(pp: VaAv1PicParams, env: Av1FrameEnv): { data: Uint8Array; tileBits: number; numTiles: number } {
	const w = new BitWriter(), seq = env.seq;
	const ft = pp.frameType, intra = ft === KEY || ft === INTRA_ONLY;
	const ohBits = seq.enableOrderHint ? seq.orderHintBits : 0;
	w.u(1, 0); // show_existing_frame
	w.u(2, ft);
	w.u(1, env.show ? 1 : 0);
	if (!env.show) w.u(1, env.showable ? 1 : 0);
	const errorRes = ft === SWITCH || (ft === KEY && env.show) ? true : pp.errorRes;
	if (!(ft === SWITCH || (ft === KEY && env.show))) w.u(1, errorRes ? 1 : 0);
	w.u(1, pp.disableCdfUpdate ? 1 : 0);
	w.u(1, pp.screenContent ? 1 : 0);
	const forceIntegerMv = intra ? true : pp.screenContent ? pp.forceIntegerMv : false;
	if (pp.screenContent) w.u(1, pp.forceIntegerMv ? 1 : 0);
	const override = ft === SWITCH || pp.width !== seq.maxWidth || pp.height !== seq.maxHeight;
	if (ft !== SWITCH) w.u(1, override ? 1 : 0);
	if (ohBits) w.u(ohBits, pp.orderHint);
	const primary = intra || errorRes ? NONE : pp.primaryRefFrame;
	if (!(intra || errorRes)) w.u(3, primary);
	const refresh = ft === SWITCH || (ft === KEY && env.show) ? 0xff : env.refresh;
	if (!(ft === SWITCH || (ft === KEY && env.show))) w.u(8, refresh);
	if ((!intra || refresh !== 0xff) && errorRes && seq.enableOrderHint) for (let i = 0; i < 8; i++) w.u(ohBits, env.slots[i]?.orderHint ?? 0);
	// frame_size() with superres_params(), render_size()
	const upscaledWidth = pp.width;
	const frameWidth = pp.superres ? Math.floor((upscaledWidth * 8 + (pp.superresDenom >> 1)) / pp.superresDenom) : upscaledWidth;
	const frameSize = () => {
		if (override) {
			w.u(16, pp.width - 1);
			w.u(16, pp.height - 1);
		}
		w.u(1, pp.superres ? 1 : 0);
		if (pp.superres) w.u(3, pp.superresDenom - 9);
		w.u(1, 0); // render_and_frame_size_different
	};
	let hpMv = false;
	if (intra) {
		frameSize();
		if (pp.screenContent && upscaledWidth === frameWidth) w.u(1, pp.intrabc ? 1 : 0);
	} else {
		if (seq.enableOrderHint) w.u(1, 0); // frame_refs_short_signaling
		for (let i = 0; i < 7; i++) w.u(3, env.refIdx[i]!);
		if (override && !errorRes) for (let i = 0; i < 7; i++) w.u(1, 0); // found_ref
		frameSize();
		if (!forceIntegerMv) {
			hpMv = pp.hpMv;
			w.u(1, hpMv ? 1 : 0);
		}
		w.u(1, pp.interpFilter === 4 ? 1 : 0);
		if (pp.interpFilter !== 4) w.u(2, pp.interpFilter);
		w.u(1, pp.motionSwitchable ? 1 : 0);
		if (!errorRes && seq.enableOrderHint) w.u(1, pp.refFrameMvs ? 1 : 0);
	}
	if (!pp.disableCdfUpdate) w.u(1, pp.disableFrameEndUpdateCdf ? 1 : 0);
	const intrabc = intra && pp.screenContent && upscaledWidth === frameWidth && pp.intrabc;

	// tile_info()
	const miCols = 2 * ((frameWidth + 7) >> 3), miRows = 2 * ((pp.height + 7) >> 3);
	const sbShift = seq.sb128 ? 5 : 4, sbSize = sbShift + 2;
	const sbCols = seq.sb128 ? (miCols + 31) >> 5 : (miCols + 15) >> 4, sbRows = seq.sb128 ? (miRows + 31) >> 5 : (miRows + 15) >> 4;
	const maxTileWidthSb = 4096 >> sbSize, maxTileAreaSbAll = (4096 * 2304) >> (2 * sbSize);
	const minLog2TileCols = tileLog2(maxTileWidthSb, sbCols), maxLog2TileCols = tileLog2(1, Math.min(sbCols, 64)), maxLog2TileRows = tileLog2(1, Math.min(sbRows, 64));
	const minLog2Tiles = Math.max(minLog2TileCols, tileLog2(maxTileAreaSbAll, sbRows * sbCols));
	w.u(1, pp.uniformTiles ? 1 : 0);
	let colsLog2: number, rowsLog2: number;
	if (pp.uniformTiles) {
		const count = (sb: number, k: number) => {
			const t = (sb + (1 << k) - 1) >> k;
			return Math.ceil(sb / t);
		};
		const pick = (min: number, max: number, sb: number, want: number, what: string) => {
			for (let k = min; k <= max; k++) if (count(sb, k) === want) return k;
			throw new Error(`${want} uniform tile ${what} do not fit ${sb} superblocks`);
		};
		colsLog2 = pick(minLog2TileCols, maxLog2TileCols, sbCols, pp.tileCols, "columns");
		for (let k = minLog2TileCols; k < maxLog2TileCols; k++) {
			w.u(1, k < colsLog2 ? 1 : 0);
			if (k >= colsLog2) break;
		}
		const minLog2TileRows = Math.max(minLog2Tiles - colsLog2, 0);
		rowsLog2 = pick(minLog2TileRows, maxLog2TileRows, sbRows, pp.tileRows, "rows");
		for (let k = minLog2TileRows; k < maxLog2TileRows; k++) {
			w.u(1, k < rowsLog2 ? 1 : 0);
			if (k >= rowsLog2) break;
		}
	} else {
		let widest = 0, start = 0;
		for (let i = 0; i < pp.tileCols; i++) {
			const size = pp.widthSbs[i]!;
			w.ns(Math.min(sbCols - start, maxTileWidthSb), size - 1);
			widest = Math.max(widest, size);
			start += size;
		}
		if (start !== sbCols) throw new Error(`tile columns of ${start} superblocks in a frame of ${sbCols}`);
		colsLog2 = tileLog2(1, pp.tileCols);
		const maxTileAreaSb = minLog2Tiles > 0 ? (sbRows * sbCols) >> (minLog2Tiles + 1) : sbRows * sbCols;
		const maxTileHeightSb = Math.max(Math.floor(maxTileAreaSb / widest), 1);
		start = 0;
		for (let i = 0; i < pp.tileRows; i++) {
			const size = pp.heightSbs[i]!;
			w.ns(Math.min(sbRows - start, maxTileHeightSb), size - 1);
			start += size;
		}
		if (start !== sbRows) throw new Error(`tile rows of ${start} superblocks in a frame of ${sbRows}`);
		rowsLog2 = tileLog2(1, pp.tileRows);
	}
	if (colsLog2 > 0 || rowsLog2 > 0) {
		w.u(rowsLog2 + colsLog2, pp.contextUpdateTileId);
		w.u(2, 3); // tile_size_bytes_minus_1: 4-byte tile sizes
	}

	// quantization_params(): separate_uv_delta_q is on
	const deltaQ = (v: number) => {
		w.u(1, v ? 1 : 0);
		if (v) w.su(7, v);
	};
	w.u(8, pp.baseQ);
	deltaQ(pp.dq.ydc);
	const diffUv = pp.dq.udc !== pp.dq.vdc || pp.dq.uac !== pp.dq.vac;
	w.u(1, diffUv ? 1 : 0);
	deltaQ(pp.dq.udc);
	deltaQ(pp.dq.uac);
	if (diffUv) {
		deltaQ(pp.dq.vdc);
		deltaQ(pp.dq.vac);
	}
	w.u(1, pp.qm.using ? 1 : 0);
	if (pp.qm.using) {
		w.u(4, pp.qm.y);
		w.u(4, pp.qm.u);
		w.u(4, pp.qm.v);
	}

	// segmentation_params()
	const SEG_BITS = [8, 6, 6, 6, 6, 3, 0, 0], SEG_SIGNED = [1, 1, 1, 1, 1, 0, 0, 0], SEG_MAX = [255, 63, 63, 63, 63, 7, 0, 0];
	w.u(1, pp.seg.enabled ? 1 : 0);
	if (pp.seg.enabled) {
		let updateData = true;
		if (primary !== NONE) {
			w.u(1, pp.seg.updateMap ? 1 : 0);
			if (pp.seg.updateMap) w.u(1, pp.seg.temporalUpdate ? 1 : 0);
			w.u(1, pp.seg.updateData ? 1 : 0);
			updateData = pp.seg.updateData;
		}
		if (updateData)
			for (let i = 0; i < 8; i++)
				for (let j = 0; j < 8; j++) {
					const en = (pp.seg.mask[i]! >> j) & 1;
					w.u(1, en);
					if (!en || !SEG_BITS[j]) continue;
					const v = Math.max(SEG_SIGNED[j] ? -SEG_MAX[j]! : 0, Math.min(SEG_MAX[j]!, pp.seg.data[i]![j]!));
					if (SEG_SIGNED[j]) w.su(1 + SEG_BITS[j]!, v);
					else w.u(SEG_BITS[j]!, v);
				}
	}
	// delta_q_params(), delta_lf_params()
	if (pp.baseQ > 0) {
		w.u(1, pp.deltaQPresent ? 1 : 0);
		if (pp.deltaQPresent) w.u(2, pp.deltaQRes);
	}
	if (pp.baseQ > 0 && pp.deltaQPresent) {
		if (!intrabc) {
			w.u(1, pp.deltaLfPresent ? 1 : 0);
			if (pp.deltaLfPresent) {
				w.u(2, pp.deltaLfRes);
				w.u(1, pp.deltaLfMulti ? 1 : 0);
			}
		}
	}
	// CodedLossless: every segment's qindex 0 and no DC/AC deltas
	let codedLossless = true;
	for (let s = 0; s < 8; s++) {
		let q = pp.baseQ;
		if (pp.seg.enabled && (pp.seg.mask[s]! & 1)) q = Math.max(0, Math.min(255, q + pp.seg.data[s]![0]!));
		if (!(q === 0 && !pp.dq.ydc && !pp.dq.uac && !pp.dq.udc && !pp.dq.vac && !pp.dq.vdc)) codedLossless = false;
	}
	const allLossless = codedLossless && frameWidth === upscaledWidth;
	// loop_filter_params()
	if (!codedLossless && !intrabc) {
		w.u(6, pp.lfLevel[0]);
		w.u(6, pp.lfLevel[1]);
		if (pp.lfLevel[0] || pp.lfLevel[1]) {
			w.u(6, pp.lfLevel[2]);
			w.u(6, pp.lfLevel[3]);
		}
		w.u(3, pp.sharpness);
		w.u(1, pp.deltaEnabled ? 1 : 0);
		if (pp.deltaEnabled) {
			w.u(1, pp.deltaUpdate ? 1 : 0);
			if (pp.deltaUpdate) {
				// VA's deltas are the effective ones (ffmpeg's CBS infers the rest from the reference): all written
				for (let i = 0; i < 8; i++) w.u(1, 1), w.su(7, pp.refDeltas[i]!);
				for (let i = 0; i < 2; i++) w.u(1, 1), w.su(7, pp.modeDeltas[i]!);
			}
		}
	}
	// cdef_params()
	if (!codedLossless && !intrabc && seq.enableCdef) {
		w.u(2, pp.cdefDampingMinus3);
		w.u(2, pp.cdefBits);
		for (let i = 0; i < 1 << pp.cdefBits; i++) {
			w.u(4, pp.cdefY[i]! >> 2);
			w.u(2, pp.cdefY[i]! & 3);
			w.u(4, pp.cdefUv[i]! >> 2);
			w.u(2, pp.cdefUv[i]! & 3);
		}
	}
	// lr_params(): FrameRestorationType to lr_type
	if (!allLossless && !intrabc) {
		const CODED = [0, 2, 3, 1];
		let usesLr = false, usesChromaLr = false;
		for (let i = 0; i < 3; i++) {
			w.u(2, CODED[pp.lrType[i]!]!);
			if (pp.lrType[i]) (usesLr = true), (usesChromaLr ||= i > 0);
		}
		if (usesLr) {
			if (seq.sb128) {
				if (pp.lrUnitShift < 1) throw new Error("lr_unit_shift 0 with 128x128 superblocks");
				w.u(1, pp.lrUnitShift - 1);
			} else {
				w.u(1, pp.lrUnitShift ? 1 : 0);
				if (pp.lrUnitShift) w.u(1, pp.lrUnitShift - 1);
			}
			if (usesChromaLr) w.u(1, pp.lrUvShift);
		}
	}
	// read_tx_mode(), frame_reference_mode()
	if (!codedLossless) w.u(1, pp.txMode === 2 ? 1 : 0);
	if (!intra) w.u(1, pp.referenceSelect ? 1 : 0);
	// skip_mode_params()
	const rel = (a: number, b: number) => {
		if (!seq.enableOrderHint) return 0;
		const diff = a - b, m = 1 << (ohBits - 1);
		return (diff & (m - 1)) - (diff & m);
	};
	let skipAllowed = false;
	if (!intra && pp.referenceSelect && seq.enableOrderHint) {
		let fwd = -1, bwd = -1, fwdHint = 0, bwdHint = 0;
		const hint = (i: number) => env.slots[env.refIdx[i]!]?.orderHint ?? 0;
		for (let i = 0; i < 7; i++) {
			const h = hint(i);
			if (rel(h, pp.orderHint) < 0) {
				if (fwd < 0 || rel(h, fwdHint) > 0) (fwd = i), (fwdHint = h);
			} else if (rel(h, pp.orderHint) > 0) {
				if (bwd < 0 || rel(h, bwdHint) < 0) (bwd = i), (bwdHint = h);
			}
		}
		if (fwd < 0) skipAllowed = false;
		else if (bwd >= 0) skipAllowed = true;
		else {
			let second = -1, secondHint = 0;
			for (let i = 0; i < 7; i++) {
				const h = hint(i);
				if (rel(h, fwdHint) < 0 && (second < 0 || rel(h, secondHint) > 0)) (second = i), (secondHint = h);
			}
			skipAllowed = second >= 0;
		}
	}
	if (skipAllowed) w.u(1, pp.skipModePresent ? 1 : 0);
	if (!intra && !errorRes) w.u(1, pp.warpedMotion ? 1 : 0);
	w.u(1, pp.reducedTxSet ? 1 : 0);
	// global_motion_params(): relative to what the primary reference frame saved
	if (!intra) {
		const prev = primary === NONE ? DEFAULT_GM() : env.slots[env.refIdx[primary]!]?.gm ?? DEFAULT_GM();
		for (let ref = 0; ref < 7; ref++) {
			const { type, mat } = pp.gm[ref]!;
			w.u(1, type !== IDENTITY ? 1 : 0);
			if (type !== IDENTITY) {
				w.u(1, type === ROTZOOM ? 1 : 0);
				if (type !== ROTZOOM) w.u(1, type === TRANSLATION ? 1 : 0);
			}
			const param = (idx: number) => {
				let absBits = 12, precBits = 15;
				if (idx < 2) {
					if (type === TRANSLATION) (absBits = 9 - (hpMv ? 0 : 1)), (precBits = 3 - (hpMv ? 0 : 1));
					else (absBits = 12), (precBits = 6);
				}
				const precDiff = 16 - precBits, round = idx % 3 === 2 ? 1 << 16 : 0, sub = idx % 3 === 2 ? 1 << precBits : 0, mx = 1 << absBits;
				const r = (prev[ref]![idx]! >> precDiff) - sub, v = (mat[idx]! - round) >> precDiff;
				if (v * 2 ** precDiff + round !== mat[idx]) throw new Error(`a global motion parameter ${mat[idx]} not on its ${precBits}-bit grid`);
				writeSignedSubexpWithRef(w, v, -mx, mx + 1, r);
			};
			if (type >= ROTZOOM) {
				param(2);
				param(3);
				if (type === AFFINE) param(4), param(5);
			}
			if (type >= TRANSLATION) param(0), param(1);
		}
	}
	// film_grain_params(): always update_grain (VA's are the effective ones)
	if (seq.filmGrainPresent && (env.show || env.showable)) {
		const g = pp.grain;
		w.u(1, g.apply ? 1 : 0);
		if (g.apply) {
			w.u(16, g.seed);
			if (ft === INTER) w.u(1, 1); // update_grain
			w.u(4, g.y.length);
			for (const [v, s] of g.y) w.u(8, v), w.u(8, s);
			w.u(1, g.chromaScalingFromLuma ? 1 : 0);
			const noChroma = g.chromaScalingFromLuma || (pp.ssx === 1 && pp.ssy === 1 && g.y.length === 0);
			if (!noChroma) {
				w.u(4, g.cb.length);
				for (const [v, s] of g.cb) w.u(8, v), w.u(8, s);
				w.u(4, g.cr.length);
				for (const [v, s] of g.cr) w.u(8, v), w.u(8, s);
			}
			const numCb = noChroma ? 0 : g.cb.length, numCr = noChroma ? 0 : g.cr.length;
			w.u(2, g.scalingMinus8);
			w.u(2, g.arLag);
			const numPosLuma = 2 * g.arLag * (g.arLag + 1);
			const numPosChroma = g.y.length ? numPosLuma + 1 : numPosLuma;
			if (g.y.length) for (let i = 0; i < numPosLuma; i++) w.u(8, g.arY[i]! + 128);
			if (g.chromaScalingFromLuma || numCb) for (let i = 0; i < numPosChroma; i++) w.u(8, g.arCb[i]! + 128);
			if (g.chromaScalingFromLuma || numCr) for (let i = 0; i < numPosChroma; i++) w.u(8, g.arCr[i]! + 128);
			w.u(2, g.arShiftMinus6);
			w.u(2, g.scaleShift);
			if (numCb) w.u(8, g.cbMult), w.u(8, g.cbLumaMult), w.u(9, g.cbOffset);
			if (numCr) w.u(8, g.crMult), w.u(8, g.crLumaMult), w.u(9, g.crOffset);
			w.u(1, g.overlap ? 1 : 0);
			w.u(1, g.clip ? 1 : 0);
		}
	}
	w.trailing();
	return { data: w.bytes(), tileBits: colsLog2 + rowsLog2, numTiles: pp.tileCols * pp.tileRows };
}

/** A tile group OBU's payload: its tiles with 4-byte sizes (but the last). */
export function writeTileGroup(tg: Av1TileGroup, numTiles: number, tileBits: number, whole: boolean): Uint8Array {
	const w = new BitWriter();
	if (numTiles > 1) {
		w.u(1, whole ? 0 : 1);
		if (!whole) w.u(tileBits, tg.start), w.u(tileBits, tg.end);
	}
	w.align();
	for (const [i, t] of tg.tiles.entries()) {
		if (i < tg.tiles.length - 1) {
			const n = t.length - 1;
			w.bytes8(Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24));
		}
		w.bytes8(t);
	}
	return w.bytes();
}

/** A show_existing_frame of slot idx (frame header OBU payload; no decoder model, no frame ids). */
export function showExistingHeader(idx: number): Uint8Array {
	const w = new BitWriter();
	w.u(1, 1);
	w.u(3, idx);
	w.trailing();
	return w.bytes();
}

// ---- the adapter ----

const TD = obu(OBU_TEMPORAL_DELIMITER, new Uint8Array(0));
const cat = (parts: Uint8Array[]) => {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) out.set(p, n), (n += p.length);
	return out;
};

export interface Av1AdapterState {
	slots: (number | null)[];
	/** pictures decoded again into a slot (the app kept them when its map had no free slot), hidden frames shown */
	redecodes: number;
	hidden: number;
}

/** The AV1 adapter of one VA context. */
export function av1Adapter(width: number, height: number, log?: (msg: string) => void, conservative = false): CodecAdapter & { state(): Av1AdapterState } {
	let mode: CodecMode = conservative ? "conservative" : "model";
	let seq: Av1Seq | null = null, seqKey = "";
	let seqObu: Uint8Array | null = null;
	let slots: (Slot | null)[] = new Array(8).fill(null);
	/** the newest picture, when it was not stored (the app's map had no picture it no longer uses): how to decode it again, hidden, into a slot */
	let unstored: { pic: number; slot: (refresh: number) => Slot; chunk: (refresh: number) => Uint8Array } | null = null;
	let redecodes = 0, hidden = 0, stored = 0;
	const warned = new Set<string>();
	const warn = (m: string) => {
		if (!warned.has(m)) warned.add(m), log?.(`[host] va: AV1: ${m}`);
	};
	void warn;
	return {
		config: () => (seq ? { codec: av1CodecString(seq.level) } : null),
		mode: () => mode,
		conservative() {
			mode = "conservative";
			return false;
		},
		state: () => ({ slots: slots.map((s) => s?.pic ?? null), redecodes, hidden }),
		info: () => ({ redecodes, deferred: stored, hidden }),
		filler() {
			// a show_existing_frame of a slot holding a non-key frame: no state changes
			const i = slots.findIndex((s) => s && s.frameType !== KEY);
			return i < 0 ? null : { data: cat([TD, obu(OBU_FRAME_HEADER, showExistingHeader(i))]), key: false, output: false, added: true };
		},
		picture(p: VaPicture): CodecChunk[] {
			const pb = p.bufs.find((b) => b.type === VA_BUF.picture);
			if (!pb) throw new Error("no picture parameters");
			const pp = parseVaAv1PicParams(pb.data);
			if (pp.profile !== 0) throw new Error(`profile ${pp.profile} (only Main, profile 0, is supported)`);
			if (pp.bitDepthIdx !== 0) throw new Error(`a bit depth of ${[8, 10, 12][pp.bitDepthIdx] ?? "?"} (only 8 is supported)`);
			if (pp.mono) throw new Error("monochrome is not supported");
			if (pp.ssx !== 1 || pp.ssy !== 1) throw new Error("only 4:2:0 is supported");
			if (pp.largeScaleTile) throw new Error("large-scale tile is not supported");
			if (pp.frameType === KEY && !pp.showFrame) throw new Error("hidden key frames are not supported");
			if (!pp.tileCols || !pp.tileRows || pp.tileCols > 64 || pp.tileRows > 64) throw new Error(`a bad tile layout ${pp.tileCols}x${pp.tileRows}`);
			const groups = av1TileGroups(p, pp.tileCols);
			if (!groups.length) throw new Error("no tile data");
			const numTiles = pp.tileCols * pp.tileRows;
			if (groups[0]!.start !== 0 || groups[groups.length - 1]!.end !== numTiles - 1 || groups.some((g, i) => i && g.start !== groups[i - 1]!.end + 1))
				throw new Error(`tile groups that do not cover the ${numTiles} tiles`);
			const key = pp.frameType === KEY && pp.showFrame;

			// the sequence header: from a key frame's parameters; another one only at a key frame
			const s: Av1Seq = {
				stillPicture: pp.stillPicture, level: 0, maxWidth: Math.max(width, pp.width, seq?.maxWidth ?? 0), maxHeight: Math.max(height, pp.height, seq?.maxHeight ?? 0), sb128: pp.sb128,
				enableFilterIntra: pp.enableFilterIntra, enableIntraEdge: pp.enableIntraEdge, enableInterintra: pp.enableInterintra, enableMasked: pp.enableMasked,
				enableDualFilter: pp.enableDualFilter, enableOrderHint: pp.enableOrderHint, enableJntComp: pp.enableJntComp, orderHintBits: pp.orderHintBits, enableCdef: pp.enableCdef,
				colorRange: pp.colorRange, chromaSamplePosition: pp.chromaSamplePosition, filmGrainPresent: pp.filmGrainPresent,
			};
			if (key) {
				s.maxWidth = Math.max(width, pp.width);
				s.maxHeight = Math.max(height, pp.height);
			}
			s.level = av1Level(s.maxWidth, s.maxHeight);
			const k = JSON.stringify(s);
			let reconfigure = false;
			if (k !== seqKey) {
				if (!key) {
					if (!seq) throw new Error("the stream does not start with a key frame");
					throw new Error("a new sequence header in an inter frame");
				}
				reconfigure = seq !== null && av1CodecString(seq.level) !== av1CodecString(s.level);
				seq = s;
				seqKey = k;
				seqObu = obu(OBU_SEQUENCE_HEADER, writeSequenceHeader(s));
			}
			const sq = seq!;

			const chunks: CodecChunk[] = [];
			const live = new Set(key ? [] : pp.refFrameMap.map((_, i) => p.refs[i] ?? 0).filter((x) => x > 0));
			const has = (pic: number) => slots.findIndex((x) => x?.pic === pic);
			// a slot no later picture needs: empty, a picture the app's map no longer has, or a second copy of one
			const dead = () => slots.findIndex((x, i) => !x || !live.has(x.pic) || has(x.pic) !== i);
			if (key) {
				unstored = null;
			} else {
				// the previous picture, not stored when it came, that the app kept: decoded again into a slot the app has freed
				if (unstored && live.has(unstored.pic) && has(unstored.pic) < 0) {
					const d = dead();
					if (d < 0) throw new Error("no decoder slot for a reference (the app's map holds 9 pictures?)");
					chunks.push({ data: unstored.chunk(1 << d), key: false, output: false, added: true });
					slots[d] = unstored.slot(1 << d);
					redecodes++;
				}
				unstored = null;
				for (const pic of live) if (has(pic) < 0) throw new Error(`a reference (picture ${pic}) the decoder does not hold`);
			}
			const refIdx = pp.refFrameIdx.map((i) => {
				if (key || pp.frameType === INTRA_ONLY) return 0;
				const pic = p.refs[i] ?? 0, at = pic ? has(pic) : -1;
				if (at < 0) throw new Error(`ref_frame_idx names slot ${i}, which holds no picture the decoder has`);
				return at;
			});
			// where this picture goes: a slot the app's map no longer uses, else none (decoded again later if the app kept it)
			const d = key ? -1 : dead();
			const refresh = key ? 0xff : d >= 0 ? 1 << d : 0;
			const intra = pp.frameType === KEY || pp.frameType === INTRA_ONLY;
			const ownGm = intra ? DEFAULT_GM() : pp.gm.map((g) => (g.type === IDENTITY ? [0, 0, 1 << 16, 0, 0, 1 << 16] : g.mat.slice()));
			const slotOf = (): Slot => ({ pic: p.pic, orderHint: pp.orderHint, frameType: pp.frameType, gm: ownGm });
			const before = slots.slice();
			const header = (show: boolean, showable: boolean, r: number) => writeFrameHeader(pp, { seq: sq, show, showable, refresh: r, refIdx, slots: before });
			const tus = (show: boolean, showable: boolean, r: number, withSeq: boolean) => {
				const h = header(show, showable, r);
				const parts = [TD, ...(withSeq ? [seqObu!] : []), obu(OBU_FRAME_HEADER, h.data)];
				for (const g of groups) parts.push(obu(OBU_TILE_GROUP, writeTileGroup(g, h.numTiles, h.tileBits, groups.length === 1)));
				return cat(parts);
			};
			if (!pp.showFrame) hidden++;
			// shown (a hidden inter or intra-only frame too: its picture comes out now)
			const chunk: CodecChunk = { data: tus(true, false, refresh, key), key, output: true, ...(reconfigure ? { reconfigure } : {}) };
			if (key) slots = new Array(8).fill(null).map(() => slotOf());
			else if (d >= 0) slots[d] = slotOf();
			else {
				// no slot is free now: the chunk waits for the next picture, whose map says whether the app kept this one and
				// which picture it gave up for it; else (the guest waits for it first) not stored, and decoded again if kept
				const notStored = () => {
					unstored = { pic: p.pic, slot: slotOf, chunk: (r) => tus(false, true, r, false) };
					return { ...chunk, data: tus(true, false, 0, false) };
				};
				chunk.hold = (next) => {
					if (!next) return notStored();
					const kept = new Set(pp.refFrameMap.map((_, i) => next.refs[i] ?? 0).filter((x) => x > 0));
					if (!kept.has(p.pic)) return { ...chunk, data: tus(true, false, 0, false) };
					const free = slots.findIndex((x, i) => !x || !kept.has(x.pic) || has(x.pic) !== i);
					if (free < 0) return notStored();
					stored++;
					slots[free] = slotOf();
					return { ...chunk, data: tus(true, false, 1 << free, false) };
				};
			}
			chunks.push(chunk);
			return chunks;
		},
	};
}
