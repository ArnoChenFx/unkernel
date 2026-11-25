// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// An H.264 stream with two PPS ids, for the guest VA-API check (check.mjs):
// every other picture of a CAVLC (Baseline) Annex B stream refers to a
// second PPS, a copy of the first with pic_init_qp 3 higher, its slice
// headers rewritten (pic_parameter_set_id 1; CAVLC slice data needs no
// realignment, and x264's Baseline has no PCM macroblocks). Decoders must
// pick the PPS each slice names: the host's H.264 adapter emits the PPS of
// the id it reads from the slice header. Runs in Node and in the page.
//
//   node test/va/h264-pps.mjs IN.h264 OUT.h264
import { annexB, annexBUnits, BitReader, BitWriter, nalUnit, parsePps, unescapeRbsp, writePps } from "../../js/core/va-h264.ts";

/** The stream (Annex B bytes) with every odd picture on PPS 1. */
export function twoPps(stream) {
	const out = [];
	let pic = -1;
	for (const u of annexBUnits(stream)) {
		const type = u[0] & 31, refIdc = (u[0] >> 5) & 3;
		if (type === 8) {
			const p = parsePps(unescapeRbsp(u));
			if (p.entropyCodingMode || p.ppsId !== 0) throw new Error("a CAVLC stream with PPS 0 only, please");
			out.push(u, nalUnit(8, refIdc, writePps({ ...p, ppsId: 1, picInitQp: p.picInitQp + 3 })));
			continue;
		}
		if (type !== 1 && type !== 5) {
			out.push(u);
			continue;
		}
		const r = new BitReader(unescapeRbsp(u));
		const firstMb = r.ue(), sliceType = r.ue();
		r.ue();
		if (firstMb === 0) pic++;
		if (pic % 2 === 0) {
			out.push(u);
			continue;
		}
		const w = new BitWriter();
		w.ue(firstMb);
		w.ue(sliceType);
		w.ue(1);
		while (r.more()) w.bit(r.bit());
		w.trailing();
		out.push(nalUnit(type, refIdc, w.bytes()));
	}
	return annexB(out);
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("h264-pps.mjs")) {
	const { readFileSync, writeFileSync } = await import("node:fs");
	writeFileSync(process.argv[3], twoPps(readFileSync(process.argv[2])));
}
