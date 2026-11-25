// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's HEVC (the CodecAdapter of js/core/va.ts for the VA profile
// "hevc.main": Main, 8-bit 4:2:0; .agents/va.md, HEVC). The WebCodecs leg
// is unverified: no decoder here takes HEVC; the access units are checked
// by decoding them natively (test/va/relay.mjs --dump).
//
// VA-API hands the driver VAPictureParameterBufferHEVC, VAIQMatrixBufferHEVC
// and VASliceParameterBufferHEVC, and the slice NAL units; WebCodecs wants
// access units. Each picture becomes one Annex B access unit: a VPS, an SPS
// and a PPS made from VA's parameters, then the picture's slices. What VA
// does not carry:
//
// - the SPS's short-term reference picture sets (a slice header names one
//   by index, short_term_ref_pic_set_sps_flag 1) and its long-term
//   candidates: VA gives their number and, for a set coded in the slice
//   header, its size in bits (st_rps_bits). So the SPS has none, and every
//   slice header is written again with its set inline: the set rebuilt
//   from VA's ReferenceFrames (ffmpeg names exactly the pictures of the
//   picture's RPS there, flagged ST_CURR_BEFORE, ST_CURR_AFTER, LT_CURR or
//   none for the ones kept for later), negative pictures by decreasing POC,
//   positive ones by increasing POC (the order the spec's sets have). The
//   rest of the header is copied bit for bit (the header is parsed to its
//   end to find it), the slice data byte for byte; entry points count
//   slice data bytes, so they stay right. Long-term pictures coded in the
//   slice header are copied; ones naming SPS candidates are refused.
// - the PPS id: from the slice header; the SPS id is 0.
// - scaling lists: VA's are the effective ones (raster order): all written
//   into the PPS when enabled (they may change from picture to picture; an
//   SPS may not).
// - profile and level (Main; the smallest level for the picture size), no
//   conformance window (the guest's surfaces hold the coded picture; its app
//   crops), 7 temporal sub-layers declared (VA does not say how many; one
//   ordering info for all), no VUI; sps_max_num_reorder_pics is the stream's own reorder depth seen
//   so far, raised (the decoder made again with the stream since the IDR
//   replayed) when a picture needs more.
//
// No output model: HEVC is always in conservative mode (nothing is assumed
// of the decoder's timing; a decoder holding a picture the guest waits for
// is flushed: an HEVC filler would need a CABAC-coded picture).

import { BitReader, BitWriter, type CodecAdapter, type CodecChunk, type CodecMode, type VaPicture, VA_BUF } from "./va-codec.ts";

// ---- VA's buffers (va_dec_hevc.h 1.22; the same layout on aarch64 and x86-64) ----

export const VA_HEVC_PIC_SIZE = 604, VA_HEVC_PIC_USED = 572, VA_HEVC_SLICE_SIZE = 264, VA_HEVC_SLICE_USED = 256, VA_HEVC_IQ_SIZE = 1016, VA_HEVC_IQ_USED = 1000;
const INVALID = 1, LONG_TERM = 8, ST_CURR_BEFORE = 16, ST_CURR_AFTER = 32, LT_CURR = 64;

export interface VaHevcRef {
	surface: number;
	poc: number;
	flags: number;
}

/** VAPictureParameterBufferHEVC, the fields used */
export interface VaHevcPicParams {
	poc: number;
	refs: VaHevcRef[];
	width: number;
	height: number;
	chromaFormatIdc: number;
	separateColourPlane: boolean;
	pcm: boolean;
	scalingList: boolean;
	transformSkip: boolean;
	amp: boolean;
	strongIntraSmoothing: boolean;
	signDataHiding: boolean;
	constrainedIntraPred: boolean;
	cuQpDelta: boolean;
	weightedPred: boolean;
	weightedBipred: boolean;
	transquantBypass: boolean;
	tiles: boolean;
	entropyCodingSync: boolean;
	loopFilterAcrossSlices: boolean;
	loopFilterAcrossTiles: boolean;
	pcmLoopFilterDisabled: boolean;
	maxDecPicBufferingMinus1: number;
	bitDepthLuma: number;
	bitDepthChroma: number;
	pcmBitDepthLuma: number;
	pcmBitDepthChroma: number;
	log2MinCb: number;
	log2DiffMaxMinCb: number;
	log2MinTb: number;
	log2DiffMaxMinTb: number;
	log2MinPcm: number;
	log2DiffMaxMinPcm: number;
	maxTransformHierarchyDepthIntra: number;
	maxTransformHierarchyDepthInter: number;
	initQpMinus26: number;
	diffCuQpDeltaDepth: number;
	cbQpOffset: number;
	crQpOffset: number;
	log2ParallelMergeLevelMinus2: number;
	tileColumns: number[];
	tileRows: number[];
	listsModification: boolean;
	longTermRefs: boolean;
	temporalMvp: boolean;
	cabacInitPresent: boolean;
	outputFlagPresent: boolean;
	dependentSlices: boolean;
	sliceChromaQpOffsets: boolean;
	sao: boolean;
	deblockingOverride: boolean;
	ppsDeblockingDisabled: boolean;
	sliceHeaderExtension: boolean;
	idr: boolean;
	log2MaxPocLsb: number;
	numShortTermRefPicSets: number;
	numLongTermRefPicsSps: number;
	numRefIdxL0Default: number;
	numRefIdxL1Default: number;
	betaOffsetDiv2: number;
	tcOffsetDiv2: number;
	numExtraSliceHeaderBits: number;
	stRpsBits: number;
}

export function parseVaHevcPicParams(d: Uint8Array): VaHevcPicParams {
	if (d.length < VA_HEVC_PIC_USED) throw new Error(`picture parameters of ${d.length} bytes (VAPictureParameterBufferHEVC is ${VA_HEVC_PIC_SIZE})`);
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const u8 = (o: number) => d[o]!, s8 = (o: number) => dv.getInt8(o), u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true);
	const bit = (v: number, at: number, n = 1) => (v >>> at) & ((1 << n) - 1);
	const pf = u32(452), sp = u32(556);
	const tiles = !!bit(pf, 14);
	// (column_width_minus1[19], row_height_minus1[21]: the last column and row are the rest)
	if (tiles && (u8(474) > 19 || u8(475) > 21)) throw new Error(`a bad tile layout of ${u8(474) + 1}x${u8(475) + 1}`);
	return {
		poc: dv.getInt32(4, true),
		refs: Array.from({ length: 15 }, (_, i) => ({ surface: u32(28 + 28 * i), poc: dv.getInt32(28 + 28 * i + 4, true), flags: u32(28 + 28 * i + 8) })).filter((r) => !(r.flags & INVALID) && r.surface !== 0xffffffff),
		width: u16(448), height: u16(450),
		chromaFormatIdc: bit(pf, 0, 2), separateColourPlane: !!bit(pf, 2), pcm: !!bit(pf, 3), scalingList: !!bit(pf, 4), transformSkip: !!bit(pf, 5), amp: !!bit(pf, 6),
		strongIntraSmoothing: !!bit(pf, 7), signDataHiding: !!bit(pf, 8), constrainedIntraPred: !!bit(pf, 9), cuQpDelta: !!bit(pf, 10), weightedPred: !!bit(pf, 11),
		weightedBipred: !!bit(pf, 12), transquantBypass: !!bit(pf, 13), tiles, entropyCodingSync: !!bit(pf, 15), loopFilterAcrossSlices: !!bit(pf, 16), loopFilterAcrossTiles: !!bit(pf, 17),
		pcmLoopFilterDisabled: !!bit(pf, 18),
		maxDecPicBufferingMinus1: u8(456), bitDepthLuma: u8(457) + 8, bitDepthChroma: u8(458) + 8, pcmBitDepthLuma: u8(459) + 1, pcmBitDepthChroma: u8(460) + 1,
		log2MinCb: u8(461) + 3, log2DiffMaxMinCb: u8(462), log2MinTb: u8(463) + 2, log2DiffMaxMinTb: u8(464), log2MinPcm: u8(465) + 3, log2DiffMaxMinPcm: u8(466),
		maxTransformHierarchyDepthIntra: u8(467), maxTransformHierarchyDepthInter: u8(468), initQpMinus26: s8(469), diffCuQpDeltaDepth: u8(470), cbQpOffset: s8(471), crQpOffset: s8(472),
		log2ParallelMergeLevelMinus2: u8(473),
		tileColumns: tiles ? Array.from({ length: u8(474) + 1 }, (_, i) => u16(476 + 2 * i) + 1) : [],
		tileRows: tiles ? Array.from({ length: u8(475) + 1 }, (_, i) => u16(514 + 2 * i) + 1) : [],
		listsModification: !!bit(sp, 0), longTermRefs: !!bit(sp, 1), temporalMvp: !!bit(sp, 2), cabacInitPresent: !!bit(sp, 3), outputFlagPresent: !!bit(sp, 4), dependentSlices: !!bit(sp, 5),
		sliceChromaQpOffsets: !!bit(sp, 6), sao: !!bit(sp, 7), deblockingOverride: !!bit(sp, 8), ppsDeblockingDisabled: !!bit(sp, 9), sliceHeaderExtension: !!bit(sp, 10), idr: !!bit(sp, 12),
		log2MaxPocLsb: u8(560) + 4, numShortTermRefPicSets: u8(561), numLongTermRefPicsSps: u8(562), numRefIdxL0Default: u8(563) + 1, numRefIdxL1Default: u8(564) + 1,
		betaOffsetDiv2: s8(565), tcOffsetDiv2: s8(566), numExtraSliceHeaderBits: u8(567), stRpsBits: u32(568),
	};
}

/** VAIQMatrixBufferHEVC: [sizeId][matrixId] lists in raster order (32x32: matrices 0 and 3), and the DC values of 16x16 and 32x32. */
export interface HevcScalingLists {
	lists: number[][][];
	dc16: number[];
	dc32: number[];
}

export function parseVaHevcIq(d: Uint8Array): HevcScalingLists {
	if (d.length < VA_HEVC_IQ_USED) throw new Error(`an IQ matrix of ${d.length} bytes`);
	const l = (o: number, n: number, k: number) => Array.from({ length: k }, (_, i) => [...d.subarray(o + n * i, o + n * i + n)]);
	return { lists: [l(0, 16, 6), l(96, 64, 6), l(480, 64, 6), l(864, 64, 2)], dc16: [...d.subarray(992, 998)], dc32: [...d.subarray(998, 1000)] };
}

/** One slice of a picture: its NAL unit (header bytes first, emulation prevention bytes in). */
export function vaHevcSlices(p: VaPicture): Uint8Array[] {
	const out: Uint8Array[] = [];
	let params: VaPicture["bufs"][number] | null = null;
	for (const b of p.bufs) {
		if (b.type === VA_BUF.sliceParameter) {
			if (b.size < 20) throw new Error(`slice parameters of ${b.size} bytes`);
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
				if (nal.length > 3 && nal[0] === 0 && nal[1] === 0 && (nal[2] === 1 || (nal[2] === 0 && nal[3] === 1))) nal = nal.subarray(nal[2] === 1 ? 3 : 4);
				out.push(nal);
			}
			params = null;
		}
	}
	return out;
}

// ---- NAL units ----

/** RBSP with emulation prevention bytes. */
export function escapeRbsp(rbsp: Uint8Array): Uint8Array {
	const out: number[] = [];
	let zeros = 0;
	for (const b of rbsp) {
		if (zeros >= 2 && b <= 3) {
			out.push(3);
			zeros = 0;
		}
		out.push(b);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	if (zeros) out.push(3);
	return Uint8Array.from(out);
}

/** An HEVC NAL unit: its 2-byte header (layer 0, temporal id 0) and the RBSP escaped. */
export function hevcNal(type: number, rbsp: Uint8Array): Uint8Array {
	const e = escapeRbsp(rbsp), out = new Uint8Array(2 + e.length);
	out[0] = type << 1;
	out[1] = 1;
	out.set(e, 2);
	return out;
}

/**
 * A NAL unit's RBSP (after its 2-byte header), at most `limit` bytes of it,
 * and, for each RBSP byte and the one after the last, its offset in the NAL
 * unit.
 */
function unescapeMap(nal: Uint8Array, limit = Infinity): { rbsp: Uint8Array; at: number[] } {
	const rbsp: number[] = [], at: number[] = [];
	let zeros = 0, i = 2;
	for (; i < nal.length && rbsp.length < limit; i++) {
		const b = nal[i]!;
		if (zeros >= 2 && b === 3) {
			zeros = 0;
			continue;
		}
		rbsp.push(b);
		at.push(i);
		zeros = b === 0 ? zeros + 1 : 0;
	}
	// (cut at the limit: the next RBSP byte is after an emulation prevention byte there)
	if (i < nal.length && zeros >= 2 && nal[i] === 3) i++;
	at.push(i);
	return { rbsp: Uint8Array.from(rbsp), at };
}

/** The most of a slice NAL unit's RBSP its header may take (with tiles and WPP at 16384x16384, 16x16 CTBs: 20480 entry points of 32 bits, 80 KiB). */
const SLICE_HEADER_MAX = 256 << 10;

// ---- parameter sets ----

/** general_level_idc for a picture size (MaxLumaPs, Table A.8). */
export function hevcLevel(w: number, h: number): number {
	const ps = w * h;
	return ps <= 552960 ? 90 : ps <= 983040 ? 93 : ps <= 2228224 ? 120 : ps <= 8912896 ? 150 : 180;
}

/** Temporal sub-layers declared: all 7 (nothing in the decoding process depends on how many; the ordering info applies to all). */
const SUB_LAYERS = 7;

function profileTierLevel(w: BitWriter, level: number): void {
	w.u(2, 0); // general_profile_space
	w.u(1, 0); // general_tier_flag
	w.u(5, 1); // general_profile_idc: Main
	w.u(32, 0x60000000); // general_profile_compatibility_flag[1] and [2]
	w.u(1, 1); // general_progressive_source_flag
	w.u(1, 0); // general_interlaced_source_flag
	w.u(1, 0); // general_non_packed_constraint_flag
	w.u(1, 1); // general_frame_only_constraint_flag
	w.u(32, 0); // general_reserved_zero_43bits, general_inbld_flag
	w.u(12, 0);
	w.u(8, level);
	// no sub-layer profile or level (sub_layer_profile_present_flag, sub_layer_level_present_flag), then reserved_zero_2bits to 8
	for (let i = 0; i < SUB_LAYERS - 1; i++) w.u(2, 0);
	if (SUB_LAYERS > 1) for (let i = SUB_LAYERS - 1; i < 8; i++) w.u(2, 0);
}

export interface HevcSeq {
	pp: VaHevcPicParams;
	level: number;
	reorder: number;
	scaling: HevcScalingLists | null;
}

export function writeVps(s: HevcSeq): Uint8Array {
	const w = new BitWriter();
	w.u(4, 0); // vps_video_parameter_set_id
	w.u(1, 1); // vps_base_layer_internal_flag
	w.u(1, 1); // vps_base_layer_available_flag
	w.u(6, 0); // vps_max_layers_minus1
	w.u(3, SUB_LAYERS - 1); // vps_max_sub_layers_minus1
	w.u(1, 0); // vps_temporal_id_nesting_flag
	w.u(16, 0xffff);
	profileTierLevel(w, s.level);
	w.u(1, 0); // vps_sub_layer_ordering_info_present_flag: one for all
	w.ue(s.pp.maxDecPicBufferingMinus1);
	w.ue(Math.min(s.reorder, s.pp.maxDecPicBufferingMinus1));
	w.ue(0); // vps_max_latency_increase_plus1
	w.u(6, 0); // vps_max_layer_id
	w.ue(0); // vps_num_layer_sets_minus1
	w.u(1, 0); // vps_timing_info_present_flag
	w.u(1, 0); // vps_extension_flag
	w.trailing();
	return w.bytes();
}

/** Raster positions of the up-right diagonal scan (6.5.3) of a blk x blk block. */
function diagScan(blk: number): number[] {
	const out: number[] = [];
	let x = 0, y = 0;
	while (out.length < blk * blk) {
		while (y >= 0) {
			if (x < blk && y < blk) out.push(y * blk + x);
			y--;
			x++;
		}
		y = x;
		x = 0;
	}
	return out;
}
const DIAG4 = diagScan(4), DIAG8 = diagScan(8);

function writeScalingListData(w: BitWriter, s: HevcScalingLists): void {
	for (let sizeId = 0; sizeId < 4; sizeId++)
		for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
			w.u(1, 1); // scaling_list_pred_mode_flag: coded
			const list = s.lists[sizeId]![sizeId === 3 ? matrixId / 3 : matrixId]!, scan = sizeId === 0 ? DIAG4 : DIAG8;
			let next = 8;
			if (sizeId > 1) {
				const dc = sizeId === 2 ? s.dc16[matrixId]! : s.dc32[matrixId / 3]!;
				w.se(dc - 8);
				next = dc;
			}
			for (const pos of scan) {
				const v = list[pos]!;
				w.se(((v - next + 128) & 255) - 128);
				next = v;
			}
		}
}

export function writeHevcSps(s: HevcSeq): Uint8Array {
	const pp = s.pp, w = new BitWriter();
	w.u(4, 0); // sps_video_parameter_set_id
	w.u(3, SUB_LAYERS - 1); // sps_max_sub_layers_minus1
	w.u(1, 0); // sps_temporal_id_nesting_flag
	profileTierLevel(w, s.level);
	w.ue(0); // sps_seq_parameter_set_id
	w.ue(pp.chromaFormatIdc);
	if (pp.chromaFormatIdc === 3) w.u(1, pp.separateColourPlane ? 1 : 0);
	w.ue(pp.width);
	w.ue(pp.height);
	w.u(1, 0); // conformance_window_flag
	w.ue(pp.bitDepthLuma - 8);
	w.ue(pp.bitDepthChroma - 8);
	w.ue(pp.log2MaxPocLsb - 4);
	w.u(1, 0); // sps_sub_layer_ordering_info_present_flag: one for all
	w.ue(pp.maxDecPicBufferingMinus1);
	w.ue(Math.min(s.reorder, pp.maxDecPicBufferingMinus1));
	w.ue(0); // sps_max_latency_increase_plus1
	w.ue(pp.log2MinCb - 3);
	w.ue(pp.log2DiffMaxMinCb);
	w.ue(pp.log2MinTb - 2);
	w.ue(pp.log2DiffMaxMinTb);
	w.ue(pp.maxTransformHierarchyDepthInter);
	w.ue(pp.maxTransformHierarchyDepthIntra);
	w.u(1, pp.scalingList ? 1 : 0);
	if (pp.scalingList) w.u(1, 0); // sps_scaling_list_data_present_flag: the PPS has them (they may change from picture to picture)
	w.u(1, pp.amp ? 1 : 0);
	w.u(1, pp.sao ? 1 : 0);
	w.u(1, pp.pcm ? 1 : 0);
	if (pp.pcm) {
		w.u(4, pp.pcmBitDepthLuma - 1);
		w.u(4, pp.pcmBitDepthChroma - 1);
		w.ue(pp.log2MinPcm - 3);
		w.ue(pp.log2DiffMaxMinPcm);
		w.u(1, pp.pcmLoopFilterDisabled ? 1 : 0);
	}
	w.ue(0); // num_short_term_ref_pic_sets: the slice headers carry theirs
	w.u(1, pp.longTermRefs ? 1 : 0);
	if (pp.longTermRefs) w.ue(0); // num_long_term_ref_pics_sps
	w.u(1, pp.temporalMvp ? 1 : 0);
	w.u(1, pp.strongIntraSmoothing ? 1 : 0);
	w.u(1, 0); // vui_parameters_present_flag
	w.u(1, 0); // sps_extension_present_flag
	w.trailing();
	return w.bytes();
}

export function writeHevcPps(pp: VaHevcPicParams, ppsId: number, scaling: HevcScalingLists | null): Uint8Array {
	const w = new BitWriter(), b = (v: boolean) => w.u(1, v ? 1 : 0);
	w.ue(ppsId);
	w.ue(0); // pps_seq_parameter_set_id
	b(pp.dependentSlices);
	b(pp.outputFlagPresent);
	w.u(3, pp.numExtraSliceHeaderBits);
	b(pp.signDataHiding);
	b(pp.cabacInitPresent);
	w.ue(pp.numRefIdxL0Default - 1);
	w.ue(pp.numRefIdxL1Default - 1);
	w.se(pp.initQpMinus26);
	b(pp.constrainedIntraPred);
	b(pp.transformSkip);
	b(pp.cuQpDelta);
	if (pp.cuQpDelta) w.ue(pp.diffCuQpDeltaDepth);
	w.se(pp.cbQpOffset);
	w.se(pp.crQpOffset);
	b(pp.sliceChromaQpOffsets);
	b(pp.weightedPred);
	b(pp.weightedBipred);
	b(pp.transquantBypass);
	b(pp.tiles);
	b(pp.entropyCodingSync);
	if (pp.tiles) {
		w.ue(pp.tileColumns.length - 1);
		w.ue(pp.tileRows.length - 1);
		w.u(1, 0); // uniform_spacing_flag: the sizes VA has
		for (const c of pp.tileColumns.slice(0, -1)) w.ue(c - 1);
		for (const r of pp.tileRows.slice(0, -1)) w.ue(r - 1);
		b(pp.loopFilterAcrossTiles);
	}
	b(pp.loopFilterAcrossSlices);
	w.u(1, 1); // deblocking_filter_control_present_flag
	b(pp.deblockingOverride);
	b(pp.ppsDeblockingDisabled);
	if (!pp.ppsDeblockingDisabled) {
		w.se(pp.betaOffsetDiv2);
		w.se(pp.tcOffsetDiv2);
	}
	w.u(1, scaling ? 1 : 0); // pps_scaling_list_data_present_flag
	if (scaling) writeScalingListData(w, scaling);
	b(pp.listsModification);
	w.ue(pp.log2ParallelMergeLevelMinus2);
	b(pp.sliceHeaderExtension);
	w.u(1, 0); // pps_extension_present_flag
	w.trailing();
	return w.bytes();
}

// ---- slice headers ----

const ceilLog2 = (n: number) => (n <= 1 ? 0 : 32 - Math.clz32(n - 1));

/** What a slice header told: the fields the adapter needs, and where its reference picture sets are. */
export interface HevcSliceHeader {
	nalType: number;
	temporalId: number;
	first: boolean;
	ppsId: number;
	dependent: boolean;
	sliceType: number;
	pocLsb: number;
	/** RBSP bit range of short_term_ref_pic_set_sps_flag through the set or its index (empty for IDR and dependent slices) */
	rps: [number, number];
	/** RBSP bit range of the long-term part, and its pictures (poc_lsb_lt, used, msb present, cycle) */
	lt: [number, number];
	ltPics: { pocLsb: number; used: boolean; msbPresent: boolean; msbCycle: number }[];
	/** where the header ends (the bit before byte_alignment()'s one), and the RBSP byte the slice data starts at */
	end: number;
	dataStart: number;
}

/**
 * A slice segment header (7.3.6) of a NAL unit's RBSP, parsed to its end.
 * `numPicTotalCurr` is the pictures of the RPS the current picture uses.
 */
export function parseHevcSliceHeader(nalType: number, rbsp: Uint8Array, pp: VaHevcPicParams, numPicTotalCurr: number): HevcSliceHeader {
	const r = new BitReader(rbsp);
	const irap = nalType >= 16 && nalType <= 23, idr = nalType === 19 || nalType === 20;
	const first = !!r.u(1);
	if (irap) r.u(1); // no_output_of_prior_pics_flag
	const ppsId = r.ue();
	if (ppsId > 63) throw new Error(`a bad slice_pic_parameter_set_id ${ppsId}`);
	const ctb = 1 << (pp.log2MinCb + pp.log2DiffMaxMinCb), ctbs = Math.ceil(pp.width / ctb) * Math.ceil(pp.height / ctb);
	let dependent = false;
	if (!first) {
		if (pp.dependentSlices) dependent = !!r.u(1);
		r.u(ceilLog2(ctbs)); // slice_segment_address
	}
	const h: HevcSliceHeader = { nalType, temporalId: 0, first, ppsId, dependent, sliceType: -1, pocLsb: 0, rps: [0, 0], lt: [0, 0], ltPics: [], end: 0, dataStart: 0 };
	if (!dependent) {
		r.u(pp.numExtraSliceHeaderBits);
		h.sliceType = r.ue();
		if (h.sliceType > 2) throw new Error(`a bad slice_type ${h.sliceType}`);
		if (pp.outputFlagPresent) r.u(1);
		if (pp.separateColourPlane) r.u(2);
		let temporalMvp = false;
		if (!idr) {
			h.pocLsb = r.u(pp.log2MaxPocLsb);
			const at = r.pos;
			const spsFlag = r.u(1);
			if (!spsFlag) {
				if (pp.stRpsBits <= 0 && pp.numShortTermRefPicSets > 0) throw new Error("a slice's own reference picture set with no st_rps_bits from VA");
				if (pp.numShortTermRefPicSets === 0) skipStRps(r);
				else r.skip(pp.stRpsBits);
			} else if (pp.numShortTermRefPicSets > 1) r.u(ceilLog2(pp.numShortTermRefPicSets));
			h.rps = [at, r.pos];
			const lt0 = r.pos;
			if (pp.longTermRefs) {
				const numSps = pp.numLongTermRefPicsSps > 0 ? r.ue() : 0;
				if (numSps) throw new Error("long-term pictures named by the SPS's candidates are not supported");
				const n = r.ue();
				if (n > 32) throw new Error(`a bad num_long_term_pics ${n}`);
				for (let i = 0; i < n; i++) {
					const pocLsb = r.u(pp.log2MaxPocLsb), used = !!r.u(1), msbPresent = !!r.u(1);
					h.ltPics.push({ pocLsb, used, msbPresent, msbCycle: msbPresent ? r.ue() : 0 });
				}
			}
			h.lt = [lt0, r.pos];
			if (pp.temporalMvp) temporalMvp = !!r.u(1);
		}
		let saoLuma = false, saoChroma = false;
		if (pp.sao) {
			saoLuma = !!r.u(1);
			if (pp.chromaFormatIdc !== 0) saoChroma = !!r.u(1);
		}
		let l0 = 0, l1 = 0;
		if (h.sliceType !== 2) {
			l0 = pp.numRefIdxL0Default;
			l1 = h.sliceType === 0 ? pp.numRefIdxL1Default : 0;
			if (r.u(1)) {
				l0 = r.ue() + 1;
				if (h.sliceType === 0) l1 = r.ue() + 1;
				if (l0 > 16 || l1 > 16) throw new Error(`a bad num_ref_idx_active_minus1 (${l0 - 1}, ${l1 - 1})`);
			}
			if (pp.listsModification && numPicTotalCurr > 1) {
				const bits = ceilLog2(numPicTotalCurr);
				if (r.u(1)) for (let i = 0; i < l0; i++) r.u(bits);
				if (h.sliceType === 0 && r.u(1)) for (let i = 0; i < l1; i++) r.u(bits);
			}
			if (h.sliceType === 0) r.u(1); // mvd_l1_zero_flag
			if (pp.cabacInitPresent) r.u(1);
			if (temporalMvp) {
				let fromL0 = true;
				if (h.sliceType === 0) fromL0 = !!r.u(1);
				if ((fromL0 && l0 > 1) || (!fromL0 && l1 > 1)) r.ue(); // collocated_ref_idx
			}
			if ((pp.weightedPred && h.sliceType === 1) || (pp.weightedBipred && h.sliceType === 0)) {
				r.ue(); // luma_log2_weight_denom
				if (pp.chromaFormatIdc !== 0) r.se();
				for (const n of h.sliceType === 0 ? [l0, l1] : [l0]) {
					const luma: number[] = [], chroma: number[] = [];
					for (let i = 0; i < n; i++) luma.push(r.u(1));
					if (pp.chromaFormatIdc !== 0) for (let i = 0; i < n; i++) chroma.push(r.u(1));
					for (let i = 0; i < n; i++) {
						if (luma[i]) r.se(), r.se();
						if (chroma[i]) for (let j = 0; j < 2; j++) r.se(), r.se();
					}
				}
			}
			r.ue(); // five_minus_max_num_merge_cand
		}
		r.se(); // slice_qp_delta
		if (pp.sliceChromaQpOffsets) r.se(), r.se();
		let dbfOverride = false, dbfDisabled = pp.ppsDeblockingDisabled;
		if (pp.deblockingOverride) dbfOverride = !!r.u(1);
		if (dbfOverride) {
			dbfDisabled = !!r.u(1);
			if (!dbfDisabled) r.se(), r.se();
		}
		if (pp.loopFilterAcrossSlices && (saoLuma || saoChroma || !dbfDisabled)) r.u(1);
	}
	if (pp.tiles || pp.entropyCodingSync) {
		const n = r.ue();
		if (n) {
			const len = r.ue() + 1;
			if (len > 32) throw new Error(`a bad offset_len_minus1 ${len - 1}`);
			r.skip(n * len); // entry_point_offset_minus1[]
		}
	}
	if (pp.sliceHeaderExtension) {
		r.skip(8 * r.ue()); // slice_segment_header_extension_data_byte[]
	}
	h.end = r.pos;
	// byte_alignment(): a one, then zeros to the byte boundary
	if (!r.bit()) throw new Error("a slice header that does not end in byte_alignment()");
	r.align();
	h.dataStart = r.pos >> 3;
	return h;
}

/** st_ref_pic_set(0) with stRpsIdx 0 (no prediction): its bits skipped. */
function skipStRps(r: BitReader): void {
	const neg = r.ue(), pos = r.ue();
	if (neg > 16 || pos > 16) throw new Error(`a bad short-term reference picture set (${neg} negative, ${pos} positive pictures)`);
	for (let i = 0; i < neg + pos; i++) r.ue(), r.u(1);
}

/** Copies RBSP bits [from, to) of `src` into `w`. */
function copyBits(w: BitWriter, src: Uint8Array, from: number, to: number): void {
	for (let i = from; i < to; i++) w.bit((src[i >> 3]! >> (7 - (i & 7))) & 1);
}

/** The reference picture set of the current picture from VA's ReferenceFrames: short-term before and after it (with their used flags), long-term. */
export function hevcRps(pp: VaHevcPicParams): { neg: { poc: number; used: boolean }[]; pos: { poc: number; used: boolean }[]; usedCount: number } {
	const st = pp.refs.filter((r) => !(r.flags & LONG_TERM));
	const neg = st.filter((r) => r.poc < pp.poc).sort((a, b) => b.poc - a.poc).map((r) => ({ poc: r.poc, used: !!(r.flags & ST_CURR_BEFORE) }));
	const pos = st.filter((r) => r.poc > pp.poc).sort((a, b) => a.poc - b.poc).map((r) => ({ poc: r.poc, used: !!(r.flags & ST_CURR_AFTER) }));
	const usedCount = pp.refs.filter((r) => r.flags & (ST_CURR_BEFORE | ST_CURR_AFTER | LT_CURR)).length;
	return { neg, pos, usedCount };
}

/** A slice NAL unit written again with its short-term set inline and its long-term part without SPS candidates. */
export function rewriteHevcSlice(nal: Uint8Array, pp: VaHevcPicParams): { nal: Uint8Array; header: HevcSliceHeader } {
	if (nal.length < 3 || nal[0]! & 0x80) throw new Error("not a NAL unit (forbidden_zero_bit)");
	const nalType = (nal[0]! >> 1) & 63, layer = ((nal[0]! & 1) << 5) | (nal[1]! >> 3), tid = (nal[1]! & 7) - 1;
	if (nalType > 21) throw new Error(`NAL unit type ${nalType} is not a slice`);
	if (layer) throw new Error("layered (multi-layer) streams are not supported");
	const rps = hevcRps(pp);
	const { rbsp, at } = unescapeMap(nal, SLICE_HEADER_MAX);
	const h = parseHevcSliceHeader(nalType, rbsp, pp, rps.usedCount);
	h.temporalId = tid;
	if (h.dependent || h.rps[1] === 0) return { nal, header: h };
	const w = new BitWriter();
	copyBits(w, rbsp, 0, h.rps[0]);
	w.u(1, 0); // short_term_ref_pic_set_sps_flag: the set inline, st_ref_pic_set(0)
	w.ue(rps.neg.length);
	w.ue(rps.pos.length);
	let prev = pp.poc;
	for (const p of rps.neg) w.ue(prev - p.poc - 1), w.u(1, p.used ? 1 : 0), (prev = p.poc);
	prev = pp.poc;
	for (const p of rps.pos) w.ue(p.poc - prev - 1), w.u(1, p.used ? 1 : 0), (prev = p.poc);
	if (pp.longTermRefs) {
		w.ue(h.ltPics.length);
		for (const l of h.ltPics) {
			w.u(pp.log2MaxPocLsb, l.pocLsb);
			w.u(1, l.used ? 1 : 0);
			w.u(1, l.msbPresent ? 1 : 0);
			if (l.msbPresent) w.ue(l.msbCycle);
		}
	}
	const usedLt = h.ltPics.filter((l) => l.used).length, usedSt = [...rps.neg, ...rps.pos].filter((p) => p.used).length;
	if (usedLt + usedSt !== rps.usedCount) throw new Error(`the slice's pictures in use (${usedSt} short-term, ${usedLt} long-term) and VA's (${rps.usedCount}) differ`);
	copyBits(w, rbsp, h.lt[1], h.end);
	w.u(1, 1); // byte_alignment()
	w.align();
	const head = escapeRbsp(w.bytes()), data = nal.subarray(at[h.dataStart]!);
	const out = new Uint8Array(2 + head.length + data.length);
	out.set(nal.subarray(0, 2));
	out.set(head, 2);
	out.set(data, 2 + head.length);
	return { nal: out, header: h };
}

// ---- the adapter ----

const START = new Uint8Array([0, 0, 0, 1]);
function annexB(units: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const u of units) n += 4 + u.length;
	const out = new Uint8Array(n);
	n = 0;
	for (const u of units) out.set(START, n), out.set(u, n + 4), (n += 4 + u.length);
	return out;
}

/** hev1.1.6.L<level>.90: Main, in-band parameter sets */
export function hevcCodecString(level: number): string {
	return `hev1.1.6.L${level}.90`;
}

export interface HevcAdapterState {
	reorder: number;
	raises: number;
}

/** The HEVC adapter of one VA context (always conservative). */
export function hevcAdapter(log?: (msg: string) => void, holdExtra = 0): CodecAdapter & { state(): HevcAdapterState } {
	let reorder = 0, raises = 0;
	let period: { poc: number }[] = [];
	let periodIndex = 0;
	let config: { codec: string } | null = null;
	let lastKey = "";
	const mode: CodecMode = "conservative";
	return {
		config: () => config,
		mode: () => mode,
		state: () => ({ reorder, raises }),
		info: () => ({ reorder, raises }),
		picture(p: VaPicture): CodecChunk[] {
			const pb = p.bufs.find((b) => b.type === VA_BUF.picture);
			if (!pb) throw new Error("no picture parameters");
			const pp = parseVaHevcPicParams(pb.data);
			if (pp.chromaFormatIdc !== 1) throw new Error(`chroma_format_idc ${pp.chromaFormatIdc} (only 4:2:0 is supported)`);
			if (pp.bitDepthLuma !== 8 || pp.bitDepthChroma !== 8) throw new Error(`a bit depth of ${pp.bitDepthLuma}/${pp.bitDepthChroma} (only 8 is supported)`);
			const iq = p.bufs.find((b) => b.type === VA_BUF.iqMatrix);
			const scaling = pp.scalingList ? parseVaHevcIq(iq?.data ?? new Uint8Array(VA_HEVC_IQ_USED).fill(16)) : null;
			const slices = vaHevcSlices(p);
			if (!slices.length) throw new Error("no slices");
			const written = slices.map((n) => rewriteHevcSlice(n, pp));
			const first = written[0]!.header;
			if (!first.first) throw new Error("the picture's first slice is not first_slice_segment_in_pic");
			if (written.some((s) => s.header.ppsId !== first.ppsId)) throw new Error("slices of one picture with different PPS ids");
			const idr = first.nalType === 19 || first.nalType === 20;
			const bla = first.nalType >= 16 && first.nalType <= 18;
			// key chunks: IDR and BLA pictures (a CRA's RASL pictures need what came before it), and the stream's first picture
			const key = idr || bla || !config;
			if (idr || bla) periodIndex++, (period = []);
			period.push({ poc: pp.poc });
			// the stream's own reorder depth: the most pictures before one in decode order and after it in output order
			let need = 0;
			for (const q of period) if (q.poc > pp.poc) need++;
			let restart = false;
			if (need > reorder) {
				log?.(`[host] va: HEVC: sps_max_num_reorder_pics ${reorder} -> ${need} (picture POC ${pp.poc} would have come out late); the decoder is made again with the stream since the IDR`);
				reorder = need;
				raises++;
				restart = !key;
			}
			const level = hevcLevel(pp.width, pp.height);
			const ppsNal = hevcNal(34, writeHevcPps(pp, first.ppsId, scaling));
			const nals = written.map((s) => s.nal);
			const build = () => {
				// (holdExtra, a test hook: more declared than needed; 16 keeps the SPS the same however the reorder depth rises)
				const seq: HevcSeq = { pp, level, reorder: Math.min(pp.maxDecPicBufferingMinus1, reorder + holdExtra), scaling };
				return annexB([hevcNal(32, writeVps(seq)), hevcNal(33, writeHevcSps(seq)), ppsNal, ...nals]);
			};
			config = { codec: hevcCodecString(level) };
			const cfgKey = `${config.codec} ${pp.width}x${pp.height}`;
			const reconfigure = key && lastKey !== "" && lastKey !== cfgKey;
			if (key) lastKey = cfgKey;
			const order = periodIndex * 2 ** 24 + Math.max(-(2 ** 23), Math.min(2 ** 23 - 1, pp.poc)) + 2 ** 23;
			const data = build();
			// replays take the slices from the chunk's own bytes (the last units, a start code before each): the guest's
			// buffers, which may be much larger than the chunk, are not kept alive by the session's history
			for (let i = nals.length - 1, at = data.length; i >= 0; i--) (nals[i] = data.subarray(at - nals[i]!.length, at)), (at -= nals[i]!.length + 4);
			return [{ data, key, output: true, order, remake: build, ...(reconfigure ? { reconfigure } : {}), ...(restart ? { restart } : {}) }];
		},
	};
}
