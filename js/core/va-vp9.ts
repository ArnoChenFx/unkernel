// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API's VP9 (the CodecAdapter of js/core/va.ts for the VA profile
// "vp9.0"; .agents/va.md, VP9). VA's VP9 slice data is the whole frame (a
// superframe too), so the chunk is the slice data as is; the host reads each
// frame header itself (frame_marker, sync code, show_frame, refresh flags).

import { type CodecAdapter, type CodecMode, concat, sliceRanges } from "./va-codec.ts";

export interface Vp9Frame {
	profile: number;
	showExisting: boolean;
	/** frame_to_show_map_idx of a show_existing_frame */
	idx: number;
	key: boolean;
	show: boolean;
	/** refresh_frame_flags (0xff for a key frame) */
	refresh: number;
}

/** The frames of a VP9 chunk: one, or a superframe's (its index at the end). Throws for a frame that is not VP9. */
export function vp9Frames(p: Uint8Array): Vp9Frame[] {
	const parts: Uint8Array[] = [];
	const m = p.length ? p[p.length - 1]! : 0;
	if ((m & 0xe0) === 0xc0) {
		const frames = (m & 7) + 1, mag = ((m >> 3) & 3) + 1, idx = 2 + mag * frames;
		if (p.length >= idx && p[p.length - idx] === m) {
			let off = 0, q = p.length - idx + 1;
			for (let i = 0; i < frames; i++) {
				let size = 0;
				for (let j = 0; j < mag; j++) size += p[q++]! * 2 ** (8 * j);
				parts.push(p.subarray(off, off + size));
				off += size;
			}
			if (off > p.length - idx) parts.length = 0;
		}
	}
	if (!parts.length) parts.push(p);
	return parts.map(vp9Header);
}

function vp9Header(p: Uint8Array): Vp9Frame {
	let pos = 0;
	const rb = (k: number) => {
		if (pos + k > p.length * 8) throw new Error(`a VP9 frame header cut short (${p.length} bytes)`);
		let v = 0;
		while (k--) {
			v = v * 2 + ((p[pos >> 3]! >> (7 - (pos & 7))) & 1);
			pos++;
		}
		return v;
	};
	const sync = () => {
		if (rb(24) !== 0x498342) throw new Error("not a VP9 frame (bad frame_sync_code)");
	};
	if (rb(2) !== 2) throw new Error("not a VP9 frame (frame_marker is not 2)");
	let profile = rb(1);
	profile |= rb(1) << 1;
	if (profile === 3 && rb(1)) throw new Error("not a VP9 frame (reserved bit set)");
	const f: Vp9Frame = { profile, showExisting: false, idx: 0, key: false, show: false, refresh: 0 };
	if (rb(1)) {
		f.showExisting = true;
		f.idx = rb(3);
		f.show = true;
		return f;
	}
	f.key = rb(1) === 0;
	f.show = rb(1) === 1;
	const errorRes = rb(1);
	if (f.key) {
		sync();
		f.refresh = 0xff;
		return f;
	}
	const intraOnly = f.show ? 0 : rb(1);
	if (!errorRes) rb(2); // reset_frame_context
	if (intraOnly) {
		sync();
		if (profile > 0) {
			if (profile >= 2) rb(1);
			const cs = rb(3);
			if (cs !== 7) {
				rb(1);
				if (profile === 1 || profile === 3) rb(3);
			} else if (profile === 1 || profile === 3) rb(1);
		}
	}
	f.refresh = rb(8);
	return f;
}

/** A show_existing_frame of reference slot idx (profiles 0 to 2: one byte). */
export function showExistingChunk(profile: number, idx: number): Uint8Array {
	return new Uint8Array([0x80 | ((profile & 1) << 5) | ((profile >> 1) << 4) | 0x08 | (idx & 7)]);
}

/**
 * VP9: the chunk is the slice data as is (a superframe too). Frames with
 * show_frame 0 (alt-refs) give WebCodecs no output, while VA expects every
 * picture to complete: right after a hidden picture comes a one-byte
 * show_existing_frame of a slot its last frame refreshed, whose output is
 * its picture. Right after, not when it is read: ffmpeg shows a hidden
 * frame only through a later show_existing_frame, which it handles
 * without a VA picture, and its decoder thread runs ahead of the read, so
 * the slot may hold another picture by then. A show_existing_frame
 * changes no decoder state (libvpx vp9_receive_compressed_data keeps
 * last_show_frame, prev_frame and the segmentation map), so one of slot 0
 * is also the filler that makes a decoder holding its last output give it
 * (conservative mode). A hidden frame that refreshes no slot is never
 * shown: black. The model: each shown frame comes out right after its
 * chunk.
 */
export function vp9Adapter(profile: number, conservative = false): CodecAdapter {
	let mode: CodecMode = conservative ? "conservative" : "model";
	let keyed = false;
	return {
		config: () => ({ codec: `vp09.0${profile}.51.08` }),
		mode: () => mode,
		conservative() {
			mode = "conservative";
			return false;
		},
		filler: () => (keyed && profile <= 2 ? { data: showExistingChunk(profile, 0), key: false, output: false, added: true } : null),
		picture(p) {
			const data = concat(sliceRanges(p));
			if (!data.length) throw new Error("no slice data");
			const frames = vp9Frames(data);
			const key = frames[0]!.key;
			keyed ||= key;
			if (frames.some((f) => f.show)) return [{ data, key, output: true }];
			// slots the last frame refreshed and no later one of the chunk (there is none: it is the last)
			const last = frames[frames.length - 1]!;
			const slot = last.refresh ? 31 - Math.clz32(last.refresh & -last.refresh) : -1;
			if (slot < 0 || profile > 2) return [{ data, key, output: false }];
			return [{ data, key, output: false }, { data: showExistingChunk(profile, slot), key: false, output: true, added: true }];
		},
	};
}
