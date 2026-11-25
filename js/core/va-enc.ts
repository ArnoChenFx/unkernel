// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API encode (va/PROTOCOL.md "enc"; .agents/va.md, Encode): the
// host side of VAEntrypointEncSlice. Each VA encode context gets one
// WebCodecs VideoEncoder (latencyMode "realtime": one chunk per frame, in
// order), configured at its first picture. A picture's input is the input
// surface's NV12 pixels sent with it, the host's kept copy of them when the
// surface did not change since, or a decoded picture of the same stream
// (decode-to-encode, nothing crosses vsock); its chunk goes back in the
// picture's notice and the driver hands it to the app as the coded buffer.
// Codec knowledge is an EncoderAdapter per context (the VA picture's
// parameters read, the codec string, per-frame options, chunk fix-ups); the
// rest is codec-neutral: rate control from the misc parameter buffers
// (reconfigured when it changes), key frames where VA asks, recovery (a
// failed or reclaimed encoder made again and the pictures it still owed
// encoded again, the first a key frame), a stall timer with a flush.
//
// What VA lets the app dictate and WebCodecs does not (reference slots and
// refresh flags, the reconstructed surface, QP of each frame in other than
// CQP, loop filter, hidden frames) is not honoured: the encoder keeps its
// own references, so the stream is valid whatever the app believed it
// asked for; the driver advertises one reference (P frames only, no
// B-frames, no hidden frames) so apps stay on what can be honoured.

import type { VaBuffer, VaPicture } from "./va-codec.ts";

/** VA buffer types (va.h VABufferType) of encoding. */
export const VA_ENC_BUF = { coded: 21, sequence: 22, picture: 23, slice: 24, packedHeaderParameter: 25, packedHeaderData: 26, misc: 27 } as const;
/** VAEncMiscParameterType values the host reads. */
export const VA_MISC = { frameRate: 0, rateControl: 1, maxFrameSize: 4, hrd: 5, qualityLevel: 6 } as const;

/** Rate control as VA names it: VA_RC_CBR, VA_RC_VBR, VA_RC_CQP. */
export type RcMode = "cbr" | "vbr" | "cqp";
const BITRATE_MODE: Record<RcMode, string> = { cbr: "constant", vbr: "variable", cqp: "quantizer" };

/** The largest chunk handed back (a notice's frame is at most 64 MiB). */
const CHUNK_MAX = 63 << 20;
/** Bytes of input pixels the host keeps per stream for surfaces that may be encoded again unchanged. */
const KEPT_MAX = 256 << 20;
/** Stall timer: no output for this long (8 encode latencies, 100 ms to 2 s; 1 s before the first) with frames in the encoder: flushed. */
const STALL = [100, 2000, 1000] as const;
/** Encoders made again in a row without an output, after which the pictures owed fail (each new picture still tries once). */
const RECOVER_MAX = 2;
/** The colour space of the guest's NV12 (VA has none: what ffmpeg's swscale makes by default). */
const GUEST_COLOUR = { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false };
/** Encode contexts kept in the stats after they are destroyed. */
const CLOSED_KEPT = 8;

// ---- what a codec's adapter does ----

/** What one VA encode picture asks, as its codec's adapter reads the parameters. */
export interface EncodeParams {
	/** the size to encode, and the source's (the input picture's part that is encoded, top left) */
	width: number;
	height: number;
	srcWidth: number;
	srcHeight: number;
	/** the app asks for a key frame */
	key: boolean;
	/** the app asks for a shown frame (false: a hidden frame, which WebCodecs does not make: encoded shown) */
	show: boolean;
	/** CQP: the codec's quantizer index the app gives (VP9 luma_ac_qindex, 0 to 255), else null */
	qindex: number | null;
	/** bits per second the sequence parameters give (0: none), and the key frame period (0: none) */
	bitrate: number;
	intraPeriod: number;
}

/** One VA encode context's codec knowledge (a VideoEncoder per context; the session does the rest). */
export interface EncoderAdapter {
	/** VideoEncoderConfig's codec string for a size, and keys of its own (H.264: avc: { format: "annexb" }). */
	config(width: number, height: number): { codec: string } & Record<string, unknown>;
	/** The picture's codec parameters (sequence, picture) read; throws for a picture it cannot encode. */
	picture(p: VaPicture): EncodeParams;
	/** VideoEncoder.encode()'s codec options for the picture (CQP: its quantizer, bitrateMode "quantizer"). */
	options(params: EncodeParams, mode: RcMode): Record<string, unknown>;
	/** The chunk as the app gets it (H.264: parameter sets in band); without it, as is. */
	chunk?(data: Uint8Array, key: boolean): Uint8Array;
}

/** A codec the host can encode, by VA profile name. */
export interface EncodeKind {
	profile: string;
	label: string;
	/** codec strings for isConfigSupported */
	probe(width: number, height: number): string;
	create(): EncoderAdapter;
}

// ---- VP9 ----

/** VP9 level (the luma picture size only) for a codec string. */
function vp9Level(w: number, h: number): number {
	const s = w * h;
	for (const [max, level] of [[36864, 10], [73728, 11], [122880, 20], [245760, 21], [552960, 30], [983040, 31], [2228224, 40], [8912896, 50], [35651584, 60]] as const) if (s <= max) return level;
	return 62;
}

/** libvpx's quantizer (0 to 63, WebCodecs' VP9 quantizer) to qindex table (vp9_quantizer_to_qindex). */
const VP9_QINDEX = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 148, 152, 156, 160, 164, 168, 172, 176, 180, 184, 188, 192, 196, 200, 204, 208, 212, 216, 220, 224, 228, 232, 236, 240, 244, 249, 255];

/** A VP9 qindex (0 to 255) as libvpx's quantizer: the nearest. */
export function vp9Quantizer(qindex: number): number {
	let best = 0;
	for (let q = 1; q < 64; q++) if (Math.abs(VP9_QINDEX[q]! - qindex) < Math.abs(VP9_QINDEX[best]! - qindex)) best = q;
	return best;
}

const u32 = (b: VaBuffer, off: number) => new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength).getUint32(off, true);

/**
 * VP9 profile 0 (va_enc_vp9.h): VAEncSequenceParameterBufferVP9 (44 bytes;
 * bits_per_second at 20, intra_period at 24) and
 * VAEncPictureParameterBufferVP9 (132; the fields before va_reserved at 100
 * are read: sizes at 0 to 12, ref_flags at 56 (force_kf bit 0), pic_flags at
 * 60 (frame_type bit 0, show_frame bit 1), luma_ac_qindex at 65). The rest
 * (reference_frames, refresh_frame_flags, reconstructed_frame, loop filter,
 * segmentation, tiles) is the encoder's own choice. The chunk is the frame
 * as libvpx wrote it (no superframes: realtime has no hidden frames).
 */
export function vp9Encoder(): EncoderAdapter {
	return {
		config: (w, h) => ({ codec: `vp09.00.${vp9Level(w, h)}.08` }),
		picture(p) {
			let seq: VaBuffer | undefined, pic: VaBuffer | undefined;
			for (const b of p.bufs) {
				if (b.type === VA_ENC_BUF.sequence && b.num) seq = b;
				else if (b.type === VA_ENC_BUF.picture && b.num) pic = b;
			}
			if (!pic) throw new Error("no picture parameters");
			if (pic.size < 100) throw new Error(`picture parameters of ${pic.size} bytes (at least 100)`);
			if (seq && seq.size < 28) throw new Error(`sequence parameters of ${seq.size} bytes (at least 28)`);
			const srcWidth = u32(pic, 0), srcHeight = u32(pic, 4);
			let width = u32(pic, 8), height = u32(pic, 12);
			if (!width || !height) (width = srcWidth), (height = srcHeight);
			for (const v of [srcWidth, srcHeight, width, height]) if (!(v >= 1 && v <= 16384)) throw new Error(`a frame of ${srcWidth}x${srcHeight} encoded as ${width}x${height}`);
			const refFlags = u32(pic, 56), picFlags = u32(pic, 60);
			return {
				width, height, srcWidth, srcHeight,
				key: (picFlags & 1) === 0 || (refFlags & 1) === 1,
				show: (picFlags & 2) !== 0,
				qindex: pic.data[65]!,
				bitrate: seq ? u32(seq, 20) : 0,
				intraPeriod: seq ? u32(seq, 24) : 0,
			};
		},
		options: (params, mode) => (mode === "cqp" && params.qindex !== null ? { vp9: { quantizer: vp9Quantizer(params.qindex) } } : {}),
	};
}

/** The codecs the host encodes, by VA profile name. */
export const ENCODERS: EncodeKind[] = [
	{ profile: "vp9.0", label: "VP9 profile 0", probe: (w, h) => `vp09.00.${vp9Level(w, h)}.08`, create: vp9Encoder },
];

// ---- WebCodecs, as far as the host uses it ----

/** @internal The part of a VideoFrame the encoder side uses (a decoded picture's frame, or one made from NV12). */
export interface EncFrame {
	readonly timestamp: number;
	readonly visibleRect: { x: number; y: number; width: number; height: number } | null;
	readonly displayWidth: number;
	readonly displayHeight: number;
	close(): void;
}
interface VideoEncoderLike {
	readonly state: "unconfigured" | "configured" | "closed";
	readonly encodeQueueSize?: number;
	configure(c: object): void;
	encode(frame: EncFrame, opts?: object): void;
	flush(): Promise<void>;
	close(): void;
}
interface ChunkLike {
	readonly type: "key" | "delta";
	readonly timestamp: number;
	readonly byteLength: number;
	copyTo(dst: Uint8Array): void;
}
/** @internal WebCodecs' encoder side: VideoEncoder and VideoFrame. */
export interface EncWebCodecs {
	VideoEncoder: {
		new (init: { output: (c: ChunkLike, meta?: unknown) => void; error: (e: Error) => void }): VideoEncoderLike;
		isConfigSupported(c: object): Promise<{ supported?: boolean }>;
	};
	VideoFrame: new (src: Uint8Array | EncFrame, init: object) => EncFrame;
}

/** @internal WebCodecs' encoder side on this thread, or undefined. */
export function encWebCodecs(): EncWebCodecs | undefined {
	const g = globalThis as unknown as Partial<EncWebCodecs>;
	return g.VideoEncoder && g.VideoFrame ? (g as EncWebCodecs) : undefined;
}

// ---- support (the hello) ----

/** What the hello offers for encoding. */
export interface EncSupport {
	/** VA profiles with VAEntrypointEncSlice, and the rate control modes of each */
	profiles: string[];
	modes: Record<string, RcMode[]>;
	/** per profile: whether isConfigSupported says yes with prefer-hardware and prefer-software (1080p) */
	support: Record<string, { hardware: boolean; software: boolean }>;
}

/**
 * VideoEncoder.isConfigSupported for each codec: offered where some rate
 * control mode works at 1080p (realtime); CQP only where bitrateMode
 * "quantizer" does (a per-frame quantizer).
 */
export async function probeEncoders(wc: EncWebCodecs | undefined, hw: string): Promise<EncSupport> {
	const out: EncSupport = { profiles: [], modes: {}, support: {} };
	if (!wc) return out;
	const ask = (k: EncodeKind, bitrateMode: string, acc: string) =>
		wc.VideoEncoder.isConfigSupported({ codec: k.probe(1920, 1080), width: 1920, height: 1080, bitrate: 4_000_000, bitrateMode, framerate: 30, latencyMode: "realtime", hardwareAcceleration: acc }).then((s) => !!s.supported, () => false);
	await Promise.all(ENCODERS.map(async (k) => {
		const [cbr, vbr, cqp, hard, soft] = await Promise.all([ask(k, "constant", hw), ask(k, "variable", hw), ask(k, "quantizer", hw), ask(k, "variable", "prefer-hardware"), ask(k, "variable", "prefer-software")]);
		out.support[k.profile] = { hardware: hard, software: soft };
		const modes: RcMode[] = [];
		if (cqp) modes.push("cqp");
		if (cbr) modes.push("cbr");
		if (vbr) modes.push("vbr");
		if (!modes.length) return;
		out.modes[k.profile] = modes;
		out.profiles.push(k.profile);
	}));
	out.profiles.sort((a, b) => ENCODERS.findIndex((k) => k.profile === a) - ENCODERS.findIndex((k) => k.profile === b));
	return out;
}

// ---- stats ----

/** One encode context, as vm.va.stats.encode.list shows it. */
export interface VaEncodeContextStats {
	id: number;
	profile: string;
	/** the context's size (surfaces: VP9's are aligned to 64) and the frames' */
	width: number;
	height: number;
	frameWidth: number;
	frameHeight: number;
	/** VideoEncoder.configure()'s codec string, bitrateMode, bitrate (bits/s; 0 for quantizer), frame rate, hardwareAcceleration */
	codec: string | null;
	rc: RcMode;
	bitrate: number;
	framerate: number;
	hardwareAcceleration: string;
	open: boolean;
	pictures: number;
	chunks: number;
	keyFrames: number;
	bytes: number;
	failed: number;
	recoveries: number;
	reconfigures: number;
	/** encode latency, ms (moving average): picture in to its chunk out */
	latencyMs: number;
}

export interface VaEncodeStats {
	/** encode contexts open now, and made in all; VideoEncoders now */
	contexts: number;
	opened: number;
	encoders: number;
	/** pictures the guest sent, chunks back (key frames among them) and their bytes */
	pictures: number;
	chunks: number;
	keyFrames: number;
	codedBytes: number;
	/**
	 * Where pictures' pixels came from: sent with the picture over vsock
	 * (uploads, uploadBytes), the host's kept copy of a surface that did not
	 * change (kept), a decoded picture of the stream (decoded: nothing sent),
	 * a surface never written (black); keptBytes held now.
	 */
	uploads: number;
	uploadBytes: number;
	kept: number;
	decoded: number;
	black: number;
	keptBytes: number;
	/** pictures that failed; encoder errors, reclamations, stall flushes, encoders made again with the owed pictures encoded again, configure() for a new rate or size, configurations given up */
	failed: number;
	errors: number;
	reclaims: number;
	flushes: number;
	recoveries: number;
	reconfigures: number;
	fallbacks: number;
	/** hidden frames asked (show_frame 0), encoded shown */
	hidden: number;
	/** open contexts and the last few destroyed */
	list: VaEncodeContextStats[];
}

export function encodeStats(): VaEncodeStats {
	return { contexts: 0, opened: 0, encoders: 0, pictures: 0, chunks: 0, keyFrames: 0, codedBytes: 0, uploads: 0, uploadBytes: 0, kept: 0, decoded: 0, black: 0, keptBytes: 0, failed: 0, errors: 0, reclaims: 0, flushes: 0, recoveries: 0, reconfigures: 0, fallbacks: 0, hidden: 0, list: [] };
}

// ---- the session side ----

/** @internal A decoded picture used as an encode's input (VaSession resolves it). */
export interface EncSource {
	/** its decoder output, still open (the encoder clones it), or null */
	frame: EncFrame | null;
	/** else its NV12 (va.ts nv12Layout of width x height) */
	data: Uint8Array | null;
	width: number;
	height: number;
	/** it failed: the input is its stand-in */
	failed?: string;
	/** NV12 copied from a decoder's frame: that frame's colour space (else the guest's, BT.601 limited) */
	colorSpace?: { primaries: string | null; transfer: string | null; matrix: string | null; fullRange: boolean | null } | null;
}

/** @internal What VaEncoders needs of its session. */
export interface EncHost {
	wc: EncWebCodecs;
	out(obj: object, bin?: Uint8Array): void;
	log(msg: string): void;
	stats: VaEncodeStats;
	/** the closed contexts' stats (shared by the host's sessions) */
	closed: VaEncodeContextStats[];
	open: Set<VaEncodeContextStats>;
	hardwareAcceleration: string;
	verbose: boolean;
	support(): Promise<EncSupport>;
	/** a decoded picture of this surface: `use` runs when it is done (synchronously then: its frame is open only during the call), null where there is none */
	source(pic: number, surface: number, use: (s: EncSource | null) => void): void;
}

/** The pixels a picture is encoded from. */
type Input =
	| { kind: "nv12"; data: Uint8Array; pitch: number; uv: number; width: number; height: number; colorSpace?: EncSource["colorSpace"] }
	/** a clone of a decoded picture's frame, owned (closed after its chunk) */
	| { kind: "frame"; frame: EncFrame; width: number; height: number };

interface Job {
	pic: number;
	surface: number;
	params: EncodeParams;
	input: Input | null;
	/** the input is known (pixels came, or the decoded picture is done) */
	ready: boolean;
	failed: string | null;
	/** its pixels are the kept copy of its surface now (the notice says so) */
	kept: boolean;
	/** rate control the picture's misc buffers changed */
	rc: Partial<{ mode: RcMode; bitrate: number; framerate: number }>;
	ts: number;
	seq: number;
	t0: number;
}

interface Ctx {
	id: number;
	kind: EncodeKind;
	adapter: EncoderAdapter;
	width: number;
	height: number;
	mode: RcMode;
	bitrate: number;
	framerate: number;
	encoder: VideoEncoderLike | null;
	/** configure()'s now, as JSON (a change reconfigures) */
	configKey: string;
	frameW: number;
	frameH: number;
	/** the acceleration preferences to try, and the one in use */
	ladder: string[];
	rung: number;
	everOutput: boolean;
	/** pictures not yet given to the encoder (in order; the first waits for its input), and those it has, by timestamp */
	queue: Job[];
	inflight: Map<number, Job>;
	seq: number;
	/** the next frame's timestamp (µs; frame durations from the frame rate, which may change) */
	tsNext: number;
	/** the next frame must be a key frame (a new encoder, another size) */
	needKey: boolean;
	/** encoders made again since the last output */
	fails: number;
	timer: ReturnType<typeof setTimeout> | null;
	flushing: VideoEncoderLike | null;
	flushSeq: number;
	latency: number;
	/** destroyed by the app: closed once what it submitted is done */
	closing: boolean;
	info: VaEncodeContextStats;
}

const now = () => globalThis.performance?.now() ?? Date.now();
const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * @internal The encode contexts of one VaSession (va.ts): ctx with
 * `entry: "enc"`, `enc`, their part of `ctx_free` and `surf_free`.
 */
export class VaEncoders {
	#h: EncHost;
	#ctxs = new Map<number, Ctx>();
	/** surface id -> the pixels of its last upload, kept for an encode of it unchanged */
	#kept = new Map<number, { gen: number; data: Uint8Array; pitch: number; width: number; height: number }>();
	#keptBytes = 0;
	#warned = new Set<string>();
	#black = new Map<string, Uint8Array>();
	#closed = false;
	#injections: { what: "reclaim" | "error" | "flush"; every: number; left: number; n: number }[] = [];

	constructor(h: EncHost) {
		this.#h = h;
	}

	has(id: number): boolean {
		return this.#ctxs.has(id);
	}

	#once(key: string, msg: string): void {
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		this.#h.log(msg);
	}

	/** `ctx` with `entry: "enc"`: an encode context (its encoder is made at its first picture, whose size it takes). */
	async ctx(m: any): Promise<object> {
		const kind = ENCODERS.find((k) => k.profile === m.profile);
		const sup = await this.#h.support();
		if (!kind || !sup.profiles.includes(kind.profile)) return { err: `profile ${m.profile} has no encoder here` };
		const w = Number(m.width), h = Number(m.height);
		if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && h <= 16384)) return { err: `a bad size ${m.width}x${m.height}` };
		const modes = sup.modes[kind.profile] ?? [];
		const mode: RcMode = modes.includes(m.rc) ? m.rc : modes[0]!;
		const base = this.#h.hardwareAcceleration;
		const ladder = base === "prefer-software" ? [base] : [base, "prefer-software"];
		const ok: string[] = [];
		for (const acc of ladder) {
			const cfg = { codec: kind.probe(w, h), width: w, height: h, bitrate: 2_000_000, bitrateMode: BITRATE_MODE[mode], framerate: 30, latencyMode: "realtime", hardwareAcceleration: acc };
			if ((await this.#h.wc.VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) ok.push(acc);
		}
		if (!ok.length) return { err: `VideoEncoder.isConfigSupported(${kind.probe(w, h)}, ${w}x${h}, ${BITRATE_MODE[mode]}) said no` };
		const info: VaEncodeContextStats = {
			id: Number(m.id), profile: kind.profile, width: w, height: h, frameWidth: 0, frameHeight: 0, codec: null, rc: mode, bitrate: 0, framerate: 30, hardwareAcceleration: ok[0]!, open: true,
			pictures: 0, chunks: 0, keyFrames: 0, bytes: 0, failed: 0, recoveries: 0, reconfigures: 0, latencyMs: 0,
		};
		const c: Ctx = {
			id: Number(m.id), kind, adapter: kind.create(), width: w, height: h, mode, bitrate: 0, framerate: 30, encoder: null, configKey: "", frameW: 0, frameH: 0, ladder: ok, rung: 0, everOutput: false,
			queue: [], inflight: new Map(), seq: 0, tsNext: 0, needKey: true, fails: 0, timer: null, flushing: null, flushSeq: 0, latency: 0, closing: false, info,
		};
		const old = this.#ctxs.get(c.id);
		if (old) this.#drop(old, "its context was replaced");
		this.#ctxs.set(c.id, c);
		this.#h.open.add(info);
		this.#h.stats.contexts++;
		this.#h.stats.opened++;
		return {};
	}

	/** `ctx_free` of an encode context (false: not one): what it submitted still completes, then the encoder is closed. */
	free(id: number): boolean {
		const c = this.#ctxs.get(id);
		if (!c) return false;
		this.#ctxs.delete(id);
		c.closing = true;
		this.#retire(c);
		return true;
	}

	/** `surf_free`: kept pixels of these surfaces go. */
	surfFree(ids: number[]): void {
		for (const id of ids) this.#unkeep(id);
	}

	#unkeep(id: number): void {
		const k = this.#kept.get(id);
		if (!k) return;
		this.#kept.delete(id);
		this.#keptBytes -= k.data.length;
		this.#h.stats.keptBytes = this.#keptBytes;
	}

	/** The stream ended: encoders closed, frames closed, nothing more sent. */
	close(): void {
		this.#closed = true;
		for (const c of this.#ctxs.values()) this.#drop(c, "the link closed");
		this.#ctxs.clear();
		this.#kept.clear();
		this.#keptBytes = 0;
		this.#h.stats.keptBytes = 0;
	}

	/** `enc`: one VA encode picture (its buffers, then its input's pixels when sent). */
	enc(m: any, bin: Uint8Array): void {
		const st = this.#h.stats;
		st.pictures++;
		const pic = Number(m.pic), surface = Number(m.surface);
		if (!(pic > 0) || !Number.isSafeInteger(pic)) throw new Error(`a bad picture id ${m.pic}`);
		const c = this.#ctxs.get(Number(m.ctx));
		const fail = (why: string) => {
			st.failed++;
			if (c) c.info.failed++;
			this.#notice({ ev: "coded", pic, err: why });
		};
		if (!c || c.closing) return fail(`no encode context ${m.ctx}`);
		c.info.pictures++;
		// the buffers: [type, size, num] each, their bytes one after another; the input's pixels after them
		const bufs: VaBuffer[] = [];
		let off = 0;
		for (const b of Array.isArray(m.bufs) ? m.bufs : []) {
			const [type, size, num] = (Array.isArray(b) ? b : []).map(Number) as [number, number, number];
			const len = size * num;
			if (!Number.isSafeInteger(size) || !Number.isSafeInteger(num) || size < 0 || num < 0 || !Number.isSafeInteger(len) || off + len > bin.length) throw new Error(`buffers beyond the frame's ${bin.length} bytes`);
			bufs.push({ type, size, num, data: bin.subarray(off, off + len) });
			off += len;
		}
		const vp: VaPicture = { pic, surface, profile: c.kind.profile, width: c.width, height: c.height, bufs, refs: [] };
		let params: EncodeParams;
		try {
			params = c.adapter.picture(vp);
		} catch (e) {
			return fail(`${c.kind.label}: ${errText(e)}`);
		}
		if (!params.show) {
			st.hidden++;
			this.#once("hidden", `[host] va: ${c.kind.label} encode: the app asks for hidden frames (show_frame 0), which WebCodecs does not make: encoded shown (the stream stays valid; a player shows them)`);
		}
		const job: Job = { pic, surface, params, input: null, ready: false, failed: null, kept: false, rc: this.#misc(bufs, params), ts: 0, seq: 0, t0: now() };
		const src = m.src && typeof m.src === "object" ? m.src : {};
		try {
			if (src.pixels) {
				const p = src.pixels, w = Number(p.width), hh = Number(p.height), pitch = Number(p.pitch), gen = Number(p.gen);
				if (!(Number.isInteger(w) && Number.isInteger(hh) && Number.isInteger(pitch) && w > 0 && hh > 0 && w <= 16384 && hh <= 16384 && pitch >= w && pitch <= 65536)) throw new Error(`pixels of a bad layout (${p.width}x${p.height}, pitch ${p.pitch})`);
				const n = pitch * hh + pitch * ((hh + 1) >> 1);
				if (off + n > bin.length) throw new Error(`pixels of ${n} bytes, ${bin.length - off} sent`);
				const data = bin.subarray(off, off + n);
				job.input = { kind: "nv12", data, pitch, uv: pitch * hh, width: w, height: hh };
				job.ready = true;
				st.uploads++;
				st.uploadBytes += n;
				// kept for an encode of the surface unchanged (the driver sends it again until the notice says so)
				this.#unkeep(surface);
				if (Number.isSafeInteger(gen) && gen > 0 && this.#keptBytes + n <= KEPT_MAX) {
					this.#kept.set(surface, { gen, data, pitch, width: w, height: hh });
					this.#keptBytes += n;
					st.keptBytes = this.#keptBytes;
					job.kept = true;
				}
			} else if (src.kept !== undefined) {
				const k = this.#kept.get(surface);
				if (!k || k.gen !== Number(src.kept)) throw new Error(`no kept pixels of surface ${surface} (generation ${src.kept})`);
				job.input = { kind: "nv12", data: k.data, pitch: k.pitch, uv: k.pitch * k.height, width: k.width, height: k.height };
				job.ready = true;
				job.kept = true;
				st.kept++;
			} else if (src.pic !== undefined) {
				st.decoded++;
				const id = Number(src.pic);
				// resolved when the decoded picture is done (synchronously then: its frame is open only during the call)
				this.#h.source(id, surface, (s) => this.#resolved(c, job, s));
			} else {
				st.black++;
				job.input = this.#blackInput(params.srcWidth, params.srcHeight);
				job.ready = true;
			}
		} catch (e) {
			return fail(errText(e));
		}
		c.queue.push(job);
		const due = this.#due();
		this.#pump(c);
		for (const what of due) this.#inject(c, what);
	}

	/** The misc parameter buffers (VAEncMiscParameterBuffer: a u32 type, then its struct): rate control, frame rate. */
	#misc(bufs: VaBuffer[], params: EncodeParams): Job["rc"] {
		const rc: Job["rc"] = {};
		if (params.bitrate > 0) rc.bitrate = params.bitrate;
		for (const b of bufs) {
			if (b.type !== VA_ENC_BUF.misc || b.size < 8) continue;
			for (let i = 0; i < b.num; i++) {
				const e = b.data.subarray(i * b.size, (i + 1) * b.size);
				const dv = new DataView(e.buffer, e.byteOffset, e.byteLength), type = dv.getUint32(0, true);
				if (type === VA_MISC.rateControl && e.length >= 12) {
					// VAEncMiscParameterRateControl: bits_per_second, target_percentage (VBR: the target is that share of the maximum)
					const bps = dv.getUint32(4, true), pct = dv.getUint32(8, true);
					if (bps > 0) rc.bitrate = Math.round((bps * (pct > 0 && pct <= 100 ? pct : 100)) / 100);
				} else if (type === VA_MISC.frameRate) {
					// VAEncMiscParameterFrameRate: numerator in the low 16 bits, denominator in the high 16 (0: 1)
					const fr = dv.getUint32(4, true), num = fr & 0xffff, den = fr >>> 16 || 1;
					if (num > 0 && num / den <= 1000) rc.framerate = num / den;
				}
			}
		}
		return rc;
	}

	#blackInput(w: number, h: number): Input {
		const pitch = (w + 63) & ~63, key = `${w}x${h}`;
		let data = this.#black.get(key);
		if (!data) {
			data = new Uint8Array(pitch * h + pitch * ((h + 1) >> 1));
			data.fill(16, 0, pitch * h);
			data.fill(128, pitch * h);
			this.#black.set(key, data);
		}
		return { kind: "nv12", data, pitch, uv: pitch * h, width: w, height: h };
	}

	/** A decoded picture came for a job: its frame cloned (owned), or its NV12. */
	#resolved(c: Ctx, job: Job, s: EncSource | null): void {
		if (job.ready || job.failed) return;
		if (this.#closed) return;
		try {
			if (!s) job.failed = "no decoded picture of that surface to encode";
			else if (s.frame) job.input = { kind: "frame", frame: new this.#h.wc.VideoFrame(s.frame, { timestamp: 0 }), width: s.width, height: s.height };
			else if (s.data) {
				const pitch = (s.width + 63) & ~63;
				job.input = { kind: "nv12", data: s.data, pitch, uv: pitch * s.height, width: s.width, height: s.height, colorSpace: s.colorSpace ?? null };
			} else job.failed = "the decoded picture has no pixels left";
			if (s?.failed) this.#once("srcfailed", `[host] va: an encode's input picture failed to decode (${s.failed}): its stand-in is encoded`);
		} catch (e) {
			job.failed = `its decoded picture: ${errText(e)}`;
		}
		job.ready = true;
		this.#pump(c);
	}

	/** Jobs to the encoder in order, as far as their inputs are known. */
	#pump(c: Ctx): void {
		while (!this.#closed && c.queue.length && c.queue[0]!.ready) this.#submit(c, c.queue.shift()!);
		if (c.closing && !c.queue.length) this.#retire(c);
	}

	#config(c: Ctx, w: number, h: number): object {
		const cfg: Record<string, unknown> = {
			...c.adapter.config(w, h), width: w, height: h, framerate: c.framerate, latencyMode: "realtime", bitrateMode: BITRATE_MODE[c.mode], hardwareAcceleration: c.ladder[c.rung],
		};
		// a bitrate where the mode has one: the app's, else about 0.1 bit a pixel
		if (c.mode !== "cqp") cfg.bitrate = c.bitrate > 0 ? c.bitrate : Math.max(100_000, Math.round(w * h * c.framerate * 0.1));
		return cfg;
	}

	#makeEncoder(c: Ctx): VideoEncoderLike {
		const enc: VideoEncoderLike = new this.#h.wc.VideoEncoder({
			output: (chunk) => this.#output(c, enc, chunk),
			error: (e) => this.#failed(c, enc, e),
		});
		c.encoder = enc;
		this.#h.stats.encoders++;
		c.configKey = "";
		c.needKey = true;
		return enc;
	}

	#closeEncoder(c: Ctx): void {
		const enc = c.encoder;
		if (!enc) return;
		c.encoder = null;
		this.#h.stats.encoders--;
		if (enc.state !== "closed") {
			try {
				enc.close();
			} catch {}
		}
	}

	/** One picture to the encoder: configured (again) as its size and rate control say, a key frame where asked or needed. */
	#submit(c: Ctx, job: Job): void {
		if (job.failed) return this.#fail(c, job, job.failed);
		// closed by the browser with its error callback still to come (a reclamation): what it owes first, then this picture
		if (c.encoder && c.encoder.state === "closed") {
			c.queue.unshift(job);
			return this.#failed(c, c.encoder, Object.assign(new Error("the encoder was closed"), { name: "QuotaExceededError" }));
		}
		let frame: EncFrame | null = null;
		try {
			if (job.rc.mode) c.mode = job.rc.mode;
			if (job.rc.bitrate) c.bitrate = job.rc.bitrate;
			if (job.rc.framerate) c.framerate = job.rc.framerate;
			const { width: w, height: h } = job.params;
			if (!c.encoder) this.#makeEncoder(c);
			const cfg = this.#config(c, w, h), key = JSON.stringify(cfg);
			if (key !== c.configKey) {
				if (c.configKey) {
					this.#h.stats.reconfigures++;
					c.info.reconfigures++;
				}
				// another size needs a key frame; another rate does not (libvpx takes it at the next frame)
				if (w !== c.frameW || h !== c.frameH) c.needKey = true;
				c.encoder!.configure(cfg);
				c.configKey = key;
				c.frameW = w;
				c.frameH = h;
				Object.assign(c.info, { codec: (cfg as { codec: string }).codec, rc: c.mode, bitrate: (cfg as { bitrate?: number }).bitrate ?? 0, framerate: c.framerate, frameWidth: w, frameHeight: h, hardwareAcceleration: c.ladder[c.rung]! });
			}
			const dur = Math.round(1e6 / c.framerate);
			job.seq = ++c.seq;
			job.ts = c.tsNext;
			c.tsNext += dur;
			frame = this.#frame(job, dur);
			const keyFrame = job.params.key || c.needKey;
			c.needKey = false;
			c.inflight.set(job.ts, job);
			c.encoder!.encode(frame, { keyFrame, ...c.adapter.options(job.params, c.mode) });
			this.#progress(c);
		} catch (e) {
			// configure() or encode() threw (a configuration it does not take, a closed encoder): the next configuration,
			// or a new encoder with what this one owes and this picture; once encoders failed RECOVER_MAX times in a row, the picture fails
			c.inflight.delete(job.ts);
			this.#h.stats.errors++;
			if (!c.everOutput && c.rung + 1 < c.ladder.length) this.#fallback(c, e);
			else if (c.fails >= RECOVER_MAX) {
				this.#fail(c, job, `VideoEncoder: ${errText(e)}`);
				return this.#recover(c, errText(e));
			}
			c.queue.unshift(job);
			this.#recover(c, errText(e));
		} finally {
			try {
				frame?.close();
			} catch {}
		}
	}

	/** The frame the encoder gets (closed after encode(), which clones it): the input's source part, top left, with the picture's timestamp. */
	#frame(job: Job, dur: number): EncFrame {
		const inp = job.input!, VF = this.#h.wc.VideoFrame;
		const sw = job.params.srcWidth, sh = job.params.srcHeight;
		const vw = Math.min(sw, inp.width), vh = Math.min(sh, inp.height);
		if (vw < sw || vh < sh) this.#once("small", `[host] va: an encode's input (${inp.width}x${inp.height}) is smaller than the source it names (${sw}x${sh}): the encoder scales it`);
		if (inp.kind === "frame") {
			const r = inp.frame.visibleRect ?? { x: 0, y: 0, width: inp.frame.displayWidth, height: inp.frame.displayHeight };
			return new VF(inp.frame, { timestamp: job.ts, duration: dur, visibleRect: { x: r.x, y: r.y, width: Math.min(r.width, sw), height: Math.min(r.height, sh) } });
		}
		// NV12: Y rows at `pitch`, CbCr after them, the visible part at the origin. VA says nothing of the guest's colour:
		// BT.601 limited, as ffmpeg's swscale makes NV12 by default and its decoders read a VP9 stream of unknown colour
		// (libvpx would otherwise write BT.709 into the stream); a decoded picture's copy keeps its decoder's (mixing the two
		// in one stream made Chromium's encoder start key frames and convert)
		return new VF(inp.data, {
			format: "NV12", codedWidth: inp.pitch, codedHeight: inp.height, timestamp: job.ts, duration: dur, colorSpace: inp.colorSpace ?? GUEST_COLOUR,
			visibleRect: { x: 0, y: 0, width: vw, height: vh }, layout: [{ offset: 0, stride: inp.pitch }, { offset: inp.uv, stride: inp.pitch }],
		});
	}

	#output(c: Ctx, enc: VideoEncoderLike, chunk: ChunkLike): void {
		if (enc !== c.encoder || this.#closed) return;
		const job = c.inflight.get(chunk.timestamp);
		if (!job) return;
		c.inflight.delete(chunk.timestamp);
		c.everOutput = true;
		c.fails = 0;
		const st = this.#h.stats;
		try {
			if (chunk.byteLength > CHUNK_MAX) throw new Error(`a chunk of ${chunk.byteLength} bytes (at most ${CHUNK_MAX})`);
			let data: Uint8Array = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			const key = chunk.type === "key";
			if (c.adapter.chunk) data = c.adapter.chunk(data, key);
			const l = now() - job.t0;
			c.latency = c.latency ? 0.8 * c.latency + 0.2 * l : l;
			c.info.latencyMs = Math.round(c.latency * 10) / 10;
			st.chunks++;
			st.codedBytes += data.length;
			c.info.chunks++;
			c.info.bytes += data.length;
			if (key) st.keyFrames++, c.info.keyFrames++;
			this.#release(job);
			this.#notice({ ev: "coded", pic: job.pic, key, ...(job.kept ? { kept: true } : {}) }, data);
		} catch (e) {
			this.#fail(c, job, errText(e));
		}
		this.#progress(c);
		if (c.closing) this.#retire(c);
	}

	/** The encoder failed or was reclaimed: made again, and the pictures it owed encoded again (the first a key frame). */
	#failed(c: Ctx, enc: VideoEncoderLike, err: Error): void {
		if (enc !== c.encoder) return;
		const reclaimed = err?.name === "QuotaExceededError";
		c.encoder = null;
		this.#h.stats.encoders--;
		if (reclaimed) this.#h.stats.reclaims++;
		else this.#h.stats.errors++;
		if (this.#h.verbose) this.#h.log(reclaimed ? `[va] the browser reclaimed the encoder (${c.kind.label} ${c.frameW}x${c.frameH}): ${errText(err)}; made again, a key frame next` : `[va] encoder error (${c.kind.label} ${c.frameW}x${c.frameH}): ${err?.name ?? "Error"}: ${errText(err)}`);
		// a configuration the encoder does not take: the next one
		if (!reclaimed && !c.everOutput && c.rung + 1 < c.ladder.length) this.#fallback(c, err);
		// (a reclamation is no fault of the stream: it does not count towards giving up)
		this.#recover(c, errText(err), !reclaimed);
	}

	#fallback(c: Ctx, err: unknown): void {
		const from = c.ladder[c.rung]!;
		c.rung++;
		c.configKey = "";
		this.#h.stats.fallbacks++;
		this.#h.log(`[host] va: ${c.kind.label} encoder failed before its first chunk with ${from} (${errText(err)}): trying ${c.ladder[c.rung]}`);
	}

	/** The pictures the encoder owed go to a new one (first a key frame), unless encoders failed RECOVER_MAX times in a row without an output: then they fail. */
	#recover(c: Ctx, why: string, counts = true): void {
		const owed = [...c.inflight.values()].sort((a, b) => a.seq - b.seq);
		c.inflight.clear();
		this.#closeEncoder(c);
		if (this.#closed) return;
		if (counts && ++c.fails > RECOVER_MAX) {
			for (const j of owed) this.#fail(c, j, `the encoder failed again: ${why}`);
			c.fails = RECOVER_MAX;
			return;
		}
		if (!owed.length) return; // made again at the next picture
		this.#h.stats.recoveries++;
		c.info.recoveries++;
		c.queue.unshift(...owed);
		this.#pump(c);
	}

	/** A picture fails: the guest's coded buffer gets nothing and its sync an error. */
	#fail(c: Ctx, job: Job, why: string): void {
		this.#release(job);
		this.#h.stats.failed++;
		c.info.failed++;
		this.#notice({ ev: "coded", pic: job.pic, err: why });
	}

	#release(job: Job): void {
		if (job.input?.kind === "frame") {
			try {
				job.input.frame.close();
			} catch {}
		}
		job.input = null;
	}

	#notice(obj: object, bin?: Uint8Array): void {
		if (!this.#closed) this.#h.out(obj, bin);
	}

	/** The stall timer: runs while the encoder has pictures, restarted by every input and output. */
	#progress(c: Ctx): void {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		if (!c.inflight.size || this.#closed) return;
		const [lo, hi, first] = STALL;
		const ms = c.latency ? Math.min(hi, Math.max(lo, 8 * c.latency + 20)) : first;
		c.timer = setTimeout(() => this.#stall(c), ms);
	}

	/** No output for a while with pictures in the encoder: flushed (an encoder holding output gives it); pictures the flush does not give go to a new encoder. */
	#stall(c: Ctx, forced = false): void {
		// (forced: the timer armed now is stale)
		if (forced && c.timer) clearTimeout(c.timer);
		c.timer = null;
		const enc = c.encoder;
		if (this.#closed || !enc || !c.inflight.size || c.flushing === enc) return;
		if (!forced && (enc.encodeQueueSize ?? 0) > 0) return this.#progress(c);
		this.#h.stats.flushes++;
		if (!forced) this.#h.log(`[host] va: the ${c.kind.label} encoder held its output with nothing queued: flushed`);
		c.flushing = enc;
		c.flushSeq = c.seq;
		const done = () => {
			if (c.flushing === enc) c.flushing = null;
			if (c.encoder !== enc) return;
			const lost = [...c.inflight.values()].filter((j) => j.seq <= c.flushSeq);
			if (lost.length) this.#recover(c, "the flush gave no chunk for them");
			else this.#progress(c);
		};
		enc.flush().then(done, () => {
			if (c.flushing === enc) c.flushing = null;
		});
	}

	/** A context the app destroyed: once its pictures are done (or none can be), the encoder is closed. */
	#retire(c: Ctx): void {
		if (c.queue.length) return;
		const enc = c.encoder;
		if (enc && c.inflight.size) {
			if (c.flushing === enc) return;
			c.flushing = enc;
			const done = () => {
				for (const j of c.inflight.values()) this.#fail(c, j, "its context was destroyed before the encoder gave it");
				c.inflight.clear();
				this.#drop(c, "its context was destroyed");
			};
			enc.flush().then(done, done);
			return;
		}
		this.#drop(c, "its context was destroyed");
	}

	#drop(c: Ctx, why: string): void {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		this.#closeEncoder(c);
		for (const j of [...c.queue, ...c.inflight.values()]) {
			if (this.#closed) this.#release(j);
			else this.#fail(c, j, why);
		}
		c.queue = [];
		c.inflight.clear();
		if (this.#h.open.delete(c.info)) {
			this.#h.stats.contexts--;
			c.info.open = false;
			this.#h.closed.push(c.info);
			if (this.#h.closed.length > CLOSED_KEPT) this.#h.closed.shift();
		}
	}

	/** @internal test hook (VaHost.inject): now on every encode context, or after every `every` pictures, `count` times. */
	inject(what: string | null, count: number, every: number): void {
		if (what !== "reclaim" && what !== "error" && what !== "flush") {
			if (!what) this.#injections = [];
			return;
		}
		if (every > 0) this.#injections.push({ what, every, left: count, n: 0 });
		else for (const c of this.#ctxs.values()) this.#inject(c, what);
	}

	#due(): ("reclaim" | "error" | "flush")[] {
		const out: ("reclaim" | "error" | "flush")[] = [];
		for (const j of this.#injections) if (j.left > 0 && ++j.n % j.every === 0) j.left--, out.push(j.what);
		if (out.length) this.#injections = this.#injections.filter((j) => j.left > 0);
		return out;
	}

	#inject(c: Ctx, what: "reclaim" | "error" | "flush"): void {
		const enc = c.encoder;
		if (!enc) return;
		if (what === "flush") return this.#stall(c, true);
		// as Chrome does: the encoder is closed, then its error callback runs
		try {
			enc.close();
		} catch {}
		const e = new Error(what === "reclaim" ? "Codec reclaimed due to inactivity (test)." : "Encoding error (test).");
		e.name = what === "reclaim" ? "QuotaExceededError" : "EncodingError";
		this.#failed(c, enc, e);
	}
}
