// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest VA-API (va/PROTOCOL.md): the host side of createKernel({ va }).
//
//   guest app (ffmpeg, mpv) -> libva -> kw_drv_video.so (the guest's driver, va/driver)
//          -> AF_VSOCK, host CID 2, port VA_PORT (1024), one stream per VADisplay
//          -> VaHost (this file, on the thread that owns the VM, in both modes)
//          -> one WebCodecs VideoDecoder per VA context; pictures back as NV12 when asked
//
// Nothing happens before the guest's first connection: then
// VideoDecoder.isConfigSupported() decides which profiles the hello reply
// offers. The driver sends each VA picture's buffers (picture and slice
// parameters, slice data, ...) tagged with their VA buffer types, a
// session-unique picture id and the picture ids its references name. A
// per-codec adapter (CodecAdapter, va-codec.ts; va-vp9.ts, va-h264.ts,
// va-av1.ts) turns them into EncodedVideoChunks; the rest is
// codec-neutral: chunk timestamps (the decode order, or the output order
// for a codec that reorders) are mapped back to picture ids, so outputs
// may come in any order; each output is copied to NV12 and closed at once,
// or, where the GPU can draw frames, held (a few per context: hardware
// decoders have few frames) until video processing draws it into a BGRX
// surface's texture or a readback copies it; the driver is told the
// picture is ready ("ev"); its pixels go to the guest only on a "get". The chunks
// since the last key chunk are kept, so a decoder that failed, was
// reclaimed by the browser or was flushed is made again and they are
// replayed (outputs the guest no longer waits for dropped). A context
// starts in its adapter's model mode (when each picture comes out is
// predicted) and goes conservative, for good, when its decoder disagrees:
// then a decoder holding a picture the guest waits for is given a filler
// (a chunk that changes no state) or flushed. Where there is no
// VideoDecoder (Node) `va` is ignored with a log line. State is not in
// snapshots: a restore drops the connections.

import { av1Adapter } from "./va-av1.ts";
import { encodeStats, ENCODERS, encWebCodecs, probeEncoders, VaEncoders, type EncSource, type EncSupport, type VaEncodeContextStats, type VaEncodeStats } from "./va-enc.ts";
import type { CodecAdapter, CodecChunk, CodecConfig, CodecMode, VaBuffer, VaPicture } from "./va-codec.ts";
import { h264Adapter } from "./va-h264.ts";
import { hevcAdapter } from "./va-hevc.ts";
import { vp9Adapter } from "./va-vp9.ts";
import type { Vsock, VsockConnection, VsockListener } from "./vsock.ts";

/** The vsock port the host's decoder listens on (the guest's driver connects to CID 2 there). */
export const VA_PORT = 1024;
const VERSION = 4;
/** The largest frame the driver may send (a picture's buffers); a larger one ends the stream. */
const MAX_FRAME = 64 << 20;
/** Bytes of chunks kept since the last key chunk for a replay; beyond, a lost decoder needs the next key frame. */
const HISTORY_MAX = 64 << 20;
/** The hold timer for a picture the adapter's model knows the decoder holds for lack of input (H.264's reorder delay at the stream's end). */
const HELD_MS = 100;
/** Model mode: a picture the guest waits for and the model says is out, with no output for 8 decode latencies (250 ms to 2 s; 500 ms before the first output): the decoder disagrees. */
const MODEL_HOLD = [250, 2000, 500] as const;
/** Conservative mode: 3 decode latencies (10 ms to 1 s; 100 ms before the first output) with no output while the guest waits: fillers, or a flush. */
const CONSERVATIVE_HOLD = [10, 1000, 100] as const;
/** Stalls in a row that fillers resolved, after which fillers go in as soon as the guest waits (no timer); every PROBE_EVERY-th wait checks without. */
const FILLER_STREAK = 4, PROBE_EVERY = 32;
/** Fillers given at once at most (a decoder that holds that many pictures more than it declares). */
const FILLERS_MAX = 8;
/** Contexts kept in vm.va.stats after they are destroyed. */
const CLOSED_KEPT = 8;
/**
 * Decoder outputs (VideoFrames) a context holds uncopied for their first
 * consumer at most (hardware decoders have a small frame pool); beyond, the
 * oldest is copied to NV12 and closed (va.md, Frame lifetime).
 */
const HOLD_MAX = 4;

export interface VaOptions {
	/** WebCodecs' hardwareAcceleration for every decoder (default "no-preference"); prefer-software is tried after it where a decoder fails before its first picture. */
	hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
	/** Log the decoders' errors as "[va] ..." (default true). */
	log?: boolean;
	/** "auto" (default): each context starts in its codec's model mode and goes conservative where the decoder disagrees; "conservative": every context starts there. */
	mode?: "auto" | "conservative";
	/** @internal Test hook: H.264 declares this many more reorder frames than it needs, so a real decoder holds more than the model says. */
	holdExtra?: number;
	/** @internal Test hook: each chunk as it first goes to a decoder (not replays or fillers), e.g. to decode the stream elsewhere. */
	dump?: (chunk: { ctx: number; profile: string; key: boolean; data: Uint8Array }) => void;
	/**
	 * How a video processing output (a BGRX surface, mpv's
	 * --vo=dmabuf-wayland) gets its picture: "auto" (default) draws the
	 * decoder's VideoFrame into the surface's texture on the GPU where it
	 * can (texSubImage2D; the browser converts YUV to RGB) and falls back to
	 * the CPU per picture; "cpu" always copies the frame to NV12 and converts
	 * it on the CPU (the page's `?va=cpu`), for comparison or as an escape
	 * hatch.
	 */
	upload?: "auto" | "cpu";
	/** @internal Test hook: keep each GPU-drawn picture's NV12 too, for VaHost.reference(). */
	verify?: boolean;
}
export type VaOption = boolean | VaOptions;

/** What vm.va.status says. */
export interface VaStatus {
	/** idle: no guest connection yet; ready: the profiles are known; failed (`error`). */
	state: "idle" | "ready" | "failed";
	/** The VA profiles the host offers ("vp9.0": VP9 profile 0), once known. */
	profiles: string[];
	/** Whether WebCodecs says it decodes in hardware here (prefer-hardware supported for an offered profile), once known. */
	hardware: boolean | null;
	/** Per profile asked about: whether isConfigSupported says yes with prefer-hardware and with prefer-software (1080p). */
	support: Record<string, { hardware: boolean; software: boolean }>;
	/** Profiles taken back after their decoders failed before any picture (isConfigSupported said yes): not offered to later connections. */
	broken: string[];
	/** The VA profiles with an encoder (VAEntrypointEncSlice: VideoEncoder.isConfigSupported says yes), once known, and the rate control modes of each (cqp, cbr, vbr). */
	encode: string[];
	encodeModes: Record<string, string[]>;
	error: string | null;
}

/** One VA context, as vm.va.stats shows it: what a report from real hardware needs. */
export interface VaContextStats {
	id: number;
	/** the VA profile ("h264.high") and the context's size */
	profile: string;
	width: number;
	height: number;
	/** VideoDecoder.configure()'s codec string now, and whether it had a description (avcC) */
	codec: string | null;
	description: boolean;
	/** the hardwareAcceleration configured */
	hardwareAcceleration: string;
	/** what decodes, as far as WebCodecs tells: from the configured preference and isConfigSupported's answers for prefer-hardware and prefer-software */
	decoder: "hardware" | "software" | "hardware or software";
	/** the VideoFrame format of its outputs (I420: a software decoder, as a rule; NV12: hardware) */
	format: string | null;
	/** model (the adapter predicts the outputs) or conservative (since `modeWhy`) */
	mode: CodecMode;
	modeWhy: string | null;
	/** the context is still open */
	open: boolean;
	pictures: number;
	frames: number;
	/** pictures that failed */
	failed: number;
	/** decoders made again: for the adapter (restarts), for any reason with the history replayed (replays) */
	restarts: number;
	replays: number;
	/** the hold timer fired: a picture the guest waited for did not come (a stall); then a filler or a flush */
	holdFires: number;
	fillers: number;
	flushes: number;
	/** pictures a decoder dropped (no output after a flush) */
	dropped: number;
	/** outputs that came before the model said */
	early: number;
	/** configurations given up for the next (another packaging, prefer-software) after a decoder failed before its first picture */
	fallbacks: number;
	/** decode latency (ms, moving average) */
	latencyMs: number;
	/** the VideoFrames' colour space as WebCodecs reports it ("bt709 limited"; "null" parts: unspecified), which the browser converts by on the GPU path */
	colorSpace: string | null;
	/** the adapter's own (H.264: reorder, packaging) */
	adapter: Record<string, string | number | boolean>;
}

export interface VaStats {
	/** Guest streams (VADisplays) being served, and served in all. */
	connections: number;
	opened: number;
	/** Bytes from and to the guest. */
	bytesIn: number;
	bytesOut: number;
	/** VideoDecoders now. */
	decoders: number;
	/** Pictures the guest sent, hidden ones (VP9: no output of their own) among them. */
	pictures: number;
	hidden: number;
	/** Decoder outputs, pictures read back by the guest, and their bytes. */
	frames: number;
	readbacks: number;
	bytesRead: number;
	/** Chunks the host added (VP9: a show_existing_frame to take a hidden frame's picture). */
	showExisting: number;
	/** Pictures that failed (the guest gets the last good picture instead). */
	failed: number;
	/** Decoder errors (not reclamations), decoders the browser reclaimed, and flushes of a decoder that held a picture. */
	errors: number;
	reclaims: number;
	flushes: number;
	/** Decoders made again with the stream since its last key frame replayed, and the chunks replayed. */
	replays: number;
	replayed: number;
	/** Of those, the decoders made again because the codec adapter asked (H.264: a deeper reorder delay, conservative mode). */
	restarts: number;
	/** Hold-timer fires (stalls), fillers given, pictures dropped by decoders, contexts gone conservative, configuration fallbacks. */
	holdFires: number;
	fillers: number;
	dropped: number;
	modeSwitches: number;
	fallbacks: number;
	/**
	 * Zero-copy output (va/PROTOCOL.md "export"): vaExportSurfaceHandle calls,
	 * surfaces whose GPU resources the host fills now, pictures uploaded into
	 * them (host memory to the renderer's textures, never through the guest)
	 * with their bytes and time, and uploads that failed (no renderer, or the
	 * resource is gone).
	 */
	exports: number;
	exported: number;
	uploads: number;
	uploadBytes: number;
	uploadMs: number;
	uploadFailed: number;
	/**
	 * Video processing outputs (BGRX surfaces) by path: drawn from the
	 * VideoFrame into the surface's texture on the GPU (no CPU copy of the
	 * pixels) and the time of those draws; converted from NV12 on the CPU
	 * and uploaded as bytes (also counted in uploads) and the time of that;
	 * and, per reason, the pictures that went the CPU way.
	 */
	gpuUploads: number;
	gpuUploadMs: number;
	cpuConversions: number;
	cpuConversionMs: number;
	gpuFallbacks: Record<string, number>;
	/** VideoFrame.copyTo() to NV12 (for a hardware decoder's frame a GPU-to-CPU readback): count and total ms from start to done. */
	copies: number;
	copyMs: number;
	/** Decoder outputs (VideoFrames) not closed yet: held for their first consumer, or being copied to NV12. */
	framesHeld: number;
	/** The most held at once, and frames copied to NV12 because a context held more than its cap (va.md, Frame lifetime). */
	framesHeldPeak: number;
	framesEvicted: number;
	/** Every open context, and the last few destroyed. */
	contexts: VaContextStats[];
	/** Encoding (va-enc.ts): pictures, chunks, where their pixels came from, recoveries; its contexts in `list`. */
	encode: VaEncodeStats;
}

/** @internal VaHost.inject's test hooks. */
export type VaInjection = "reclaim" | "error" | "flush" | "fail";

/** @internal What createKernel({ va }) prepared before the boot. */
export interface VaPrep {
	opts: VaOptions;
}

/**
 * @internal The GL host's side of zero-copy output (gl-gpu.ts GpuRenderer,
 * on this thread in both modes): host pixels into a guest resource's
 * texture, after the virtio-gpu commands before it. Absent without the
 * virtio-gpu device with 3D (`gl` and `gpu` in a browser with WebGL2): then
 * the guest gets readback only.
 */
export interface VaGpu {
	write(resource: number, box: { x: number; y: number; width: number; height: number }, fill: (dst: Uint8Array) => void): boolean;
	/**
	 * A VideoFrame drawn into a resource's texture on the GPU (its visible
	 * picture top left, cropped to width x height): null when done, else why
	 * not (nothing written). Absent: CPU conversion only.
	 */
	video?(resource: number, frame: VideoFrameLike, width: number, height: number): string | null;
	/** A resource's texels back (rows from the top, the guest's layout), or null. */
	read?(resource: number, box: { x: number; y: number; width: number; height: number }): Uint8Array | null;
}

type WebCodecs = {
	VideoDecoder: {
		new (init: { output: (f: VideoFrameLike) => void; error: (e: Error) => void }): VideoDecoderLike;
		isConfigSupported(c: object): Promise<{ supported?: boolean }>;
	};
	EncodedVideoChunk: new (init: { type: "key" | "delta"; timestamp: number; data: Uint8Array }) => unknown;
};
interface VideoDecoderLike {
	readonly state: "unconfigured" | "configured" | "closed";
	readonly decodeQueueSize?: number;
	configure(c: object): void;
	decode(chunk: unknown): void;
	flush(): Promise<void>;
	close(): void;
}
interface PlaneLayout {
	offset: number;
	stride: number;
}
/** @internal The part of a VideoFrame the host uses. */
export interface VideoFrameLike {
	readonly format: string | null;
	readonly timestamp: number;
	readonly visibleRect: { x: number; y: number; width: number; height: number } | null;
	readonly displayWidth: number;
	readonly displayHeight: number;
	readonly colorSpace?: { primaries?: string | null; transfer?: string | null; matrix?: string | null; fullRange?: boolean | null } | null;
	copyTo(dst: Uint8Array, opts?: { layout?: PlaneLayout[]; format?: string; rect?: object }): Promise<PlaneLayout[]>;
	close(): void;
}

function webCodecs(): WebCodecs | undefined {
	const g = globalThis as unknown as Partial<WebCodecs>;
	return g.VideoDecoder && g.EncodedVideoChunk ? (g as WebCodecs) : undefined;
}

const why = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * @internal createKernel's `va` before the boot (both modes, on the thread
 * that owns the VM): the options, or undefined with a log line where
 * WebCodecs or vsock is missing.
 */
export function prepareVa(opt: VaOption | undefined, vsock: boolean, log: (msg: string) => void): VaPrep | undefined {
	if (!opt) return undefined;
	if (!vsock) {
		log("[host] va: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no VA-API decoder");
		return undefined;
	}
	if (!webCodecs()) {
		log("[host] va: no WebCodecs VideoDecoder on this thread, so it is ignored");
		return undefined;
	}
	return { opts: opt === true ? {} : { ...opt } };
}

/** @internal createKernel's `va` once the kernel runs: a VaHost, or undefined. `gpu`: virtio-gpu 3D's renderer side, for zero-copy output. */
export function startVa(prep: VaPrep | undefined, vsock: Vsock | undefined, log: (msg: string) => void, gpu?: VaGpu): VaHost | undefined {
	if (!prep || !vsock) return undefined;
	return new VaHost(vsock, prep.opts, log, gpu);
}

// ---- codecs (va-codec.ts, one module per codec) ----

export { VA_BUF, sliceRanges } from "./va-codec.ts";
export type { CodecAdapter, CodecChunk, CodecConfig, CodecMode, VaBuffer, VaPicture } from "./va-codec.ts";
export { vp9Frames } from "./va-vp9.ts";
export type { Vp9Frame } from "./va-vp9.ts";

/** What a codec's adapter is made with. */
interface AdapterInit {
	width: number;
	height: number;
	log: (msg: string) => void;
	/** start in conservative mode (VaOptions.mode, or an earlier context of the profile disagreed with the model) */
	conservative: boolean;
	/** @internal test hook: declare this many more reorder frames than the stream needs (H.264), a decoder that holds more than the model says */
	holdExtra: number;
}

interface CodecKind {
	/** the VA profile's name on the wire */
	profile: string;
	/** a codec string isConfigSupported is asked about for the hello */
	probe: string;
	/** for log lines */
	label: string;
	create(init: AdapterInit): CodecAdapter;
}

/** The codecs the host offers, by VA profile name. */
const CODECS: CodecKind[] = [
	{ profile: "vp9.0", probe: "vp09.00.51.08", label: "VP9 profile 0", create: (i) => vp9Adapter(0, i.conservative) },
	// H.264 (va-h264.ts): access units with an SPS and a PPS made from VA's parameters
	{ profile: "h264.cb", probe: "avc1.42C033", label: "H.264 Constrained Baseline", create: (i) => h264Adapter("cb", i.log, i.conservative ? "conservative" : "model", i.holdExtra) },
	{ profile: "h264.main", probe: "avc1.4D4033", label: "H.264 Main", create: (i) => h264Adapter("main", i.log, i.conservative ? "conservative" : "model", i.holdExtra) },
	{ profile: "h264.high", probe: "avc1.640033", label: "H.264 High", create: (i) => h264Adapter("high", i.log, i.conservative ? "conservative" : "model", i.holdExtra) },
	// AV1 (va-av1.ts): temporal units with a sequence header and frame headers made from VA's parameters
	{ profile: "av1.0", probe: "av01.0.08M.08", label: "AV1 Main", create: (i) => av1Adapter(i.width, i.height, i.log, i.conservative) },
	// HEVC (va-hevc.ts): access units with a VPS, an SPS and a PPS made from VA's parameters, slice headers written again; conservative only
	{ profile: "hevc.main", probe: "hev1.1.6.L120.90", label: "HEVC Main", create: (i) => hevcAdapter(i.log, i.holdExtra) },
];

// ---- pictures to NV12 ----

/** The NV12 layout of a w x h picture, both sides' (va/PROTOCOL.md "get"): pitch a multiple of 64, the UV plane right after Y. */
export function nv12Layout(w: number, h: number): { pitch: number; offsets: [number, number]; size: number } {
	const pitch = (w + 63) & ~63;
	return { pitch, offsets: [0, pitch * h], size: pitch * h + pitch * ((h + 1) >> 1) };
}

let warnedFormat = "";
/** The frame's visible picture as NV12 in nv12Layout(), then closed. */
export async function frameToNv12(frame: VideoFrameLike, log?: (msg: string) => void): Promise<{ data: Uint8Array; width: number; height: number }> {
	try {
		const r = frame.visibleRect ?? { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight };
		const w = r.width, h = r.height, ch = (h + 1) >> 1, cw = (w + 1) >> 1;
		const { pitch, offsets, size } = nv12Layout(w, h);
		const fmt = frame.format;
		if (fmt === "NV12") {
			const data = new Uint8Array(size);
			await frame.copyTo(data, { layout: [{ offset: 0, stride: pitch }, { offset: offsets[1], stride: pitch }] });
			return { data, width: w, height: h };
		}
		if (fmt === "I420" || fmt === "I420A") {
			// Y in place, U and V after the NV12 picture, then interleaved
			const u0 = size, v0 = size + cw * ch;
			const buf = new Uint8Array(v0 + cw * ch + (fmt === "I420A" ? w * h : 0));
			const layout = [{ offset: 0, stride: pitch }, { offset: u0, stride: cw }, { offset: v0, stride: cw }];
			if (fmt === "I420A") layout.push({ offset: v0 + cw * ch, stride: w });
			await frame.copyTo(buf, { layout });
			for (let y = 0; y < ch; y++) {
				let o = offsets[1] + y * pitch, u = u0 + y * cw, v = v0 + y * cw;
				for (let x = 0; x < cw; x++) {
					buf[o++] = buf[u++]!;
					buf[o++] = buf[v++]!;
				}
			}
			return { data: buf.subarray(0, size), width: w, height: h };
		}
		// anything else (RGB, an opaque GPU frame): WebCodecs' RGBA conversion, or, for a frame copyTo()
		// refuses (format null: copyTo() rejects it whatever the options), a canvas; then back to YUV with
		// the matrix the frame says it has (BT.601 where it says none), limited range
		if (warnedFormat !== String(fmt)) {
			warnedFormat = String(fmt);
			log?.(`[host] va: decoder output in format ${fmt}: converted through RGBA (slower, not exact)`);
		}
		const rgba = new Uint8Array(w * h * 4);
		let copied = false;
		if (fmt !== null) {
			try {
				await frame.copyTo(rgba, { format: "RGBA" });
				copied = true;
			} catch (e) {
				if (typeof OffscreenCanvas === "undefined") throw e;
			}
		}
		if (!copied) {
			const cx = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
			if (!cx) throw new Error(`a frame of format ${fmt}, which copyTo() refuses, and no 2D canvas to draw it`);
			cx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
			rgba.set(cx.getImageData(0, 0, w, h).data);
		}
		const m = frame.colorSpace?.matrix;
		const [kr, kb] = m === "bt709" ? [0.2126, 0.0722] : [0.299, 0.114];
		const kg = 1 - kr - kb, ky = (219 / 255) * 256, kc = (224 / 255) * 256;
		const yr = Math.round(kr * ky), yg = Math.round(kg * ky), yb = Math.round(kb * ky);
		const ur = Math.round((-kr / (2 * (1 - kb))) * kc), ug = Math.round((-kg / (2 * (1 - kb))) * kc), ub = Math.round(0.5 * kc);
		const vg = Math.round((-kg / (2 * (1 - kr))) * kc), vb = Math.round((-kb / (2 * (1 - kr))) * kc);
		const data = new Uint8Array(size);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4;
				data[y * pitch + x] = ((yr * rgba[i]! + yg * rgba[i + 1]! + yb * rgba[i + 2]! + 128) >> 8) + 16;
			}
		for (let y = 0; y < ch; y++)
			for (let x = 0; x < cw; x++) {
				const i = (Math.min(2 * y, h - 1) * w + Math.min(2 * x, w - 1)) * 4, o = offsets[1] + y * pitch + 2 * x;
				const R = rgba[i]!, G = rgba[i + 1]!, B = rgba[i + 2]!;
				data[o] = ((ur * R + ug * G + ub * B + 128) >> 8) + 128;
				data[o + 1] = ((ub * R + vg * G + vb * B + 128) >> 8) + 128;
			}
		return { data, width: w, height: h };
	} finally {
		frame.close();
	}
}

/** A flat NV12 picture: black (Y 16) or grey (Y 128). */
function flatNv12(w: number, h: number, y: number): Uint8Array {
	const { offsets, size } = nv12Layout(w, h), out = new Uint8Array(size);
	out.fill(y, 0, offsets[1]);
	out.fill(128, offsets[1]);
	return out;
}


/**
 * An NV12 picture (w x h, `pitch`, CbCr at `uvOff`) as BGRX (B, G, R, 255
 * bytes: virgl's B8G8R8X8, DRM's XRGB8888) into dst (dw x dh, tightly
 * packed), top left, the rest black; BT.601 or BT.709, limited or full range
 * in and out, chroma from the sample at even coordinates. 16.16 fixed point
 * through tables.
 */
export function nv12ToBgrx(nv12: Uint8Array, w: number, h: number, pitch: number, uvOff: number, dst: Uint8Array, dw: number, dh: number, conv: Conversion): void {
	const [kr, kb] = conv.bt601 ? [0.299, 0.114] : [0.2126, 0.0722], kg = 1 - kr - kb;
	const ys = conv.inFull ? 1 : 255 / 219, yo = conv.inFull ? 0 : 16, cs = conv.inFull ? 1 : 255 / 224;
	const os = conv.outFull ? 1 : 219 / 255, oo = (conv.outFull ? 0 : 16) * 65536 + 32768;
	const Y = new Int32Array(256), RV = new Int32Array(256), GU = new Int32Array(256), GV = new Int32Array(256), BU = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = (i - 128) * cs * os * 65536;
		Y[i] = Math.round((i - yo) * ys * os * 65536) + oo;
		RV[i] = Math.round(c * 2 * (1 - kr));
		GU[i] = Math.round((c * 2 * (1 - kb) * kb) / kg);
		GV[i] = Math.round((c * 2 * (1 - kr) * kr) / kg);
		BU[i] = Math.round(c * 2 * (1 - kb));
	}
	const sat = (v: number) => (v < 0 ? 0 : v > 0xffffff ? 255 : v >> 16);
	const black = sat(Y[conv.inFull ? 0 : 16]!);
	for (let y = 0; y < dh; y++) {
		let o = y * dw * 4;
		const rows = y < h, cw = rows ? Math.min(w, dw) : 0;
		const yl = y * pitch, cl = uvOff + (y >> 1) * pitch;
		for (let x = 0; x < cw; x++, o += 4) {
			const yy = Y[nv12[yl + x]!]!, ci = cl + (x & ~1), u = nv12[ci]!, v = nv12[ci + 1]!;
			dst[o] = sat(yy + BU[u]!);
			dst[o + 1] = sat(yy - GU[u]! - GV[v]!);
			dst[o + 2] = sat(yy + RV[v]!);
			dst[o + 3] = 255;
		}
		for (let x = cw; x < dw; x++, o += 4) {
			dst[o] = dst[o + 1] = dst[o + 2] = black;
			dst[o + 3] = 255;
		}
	}
}

/**
 * How the browser converts a frame to RGB when it is drawn into a texture
 * (texSubImage2D): by its colorSpace, BT.601 for smpte170m and bt470bg and
 * where it names no matrix (Chromium 151, measured), limited range unless
 * fullRange; null for a matrix the CPU path has no match for (rgb, bt2020).
 */
export function frameConversion(f: VideoFrameLike): { bt601: boolean; full: boolean } | null {
	const m = f.colorSpace?.matrix ?? null;
	const bt601 = m === null || m === "smpte170m" || m === "bt470bg" ? true : m === "bt709" ? false : null;
	return bt601 === null ? null : { bt601, full: f.colorSpace?.fullRange === true };
}

const convName = (c: { bt601: boolean; full: boolean }) => `${c.bt601 ? "BT.601" : "BT.709"} ${c.full ? "full" : "limited"}`;

// ---- one guest stream ----

const now = () => globalThis.performance?.now() ?? Date.now();

interface Picture {
	pic: number;
	surface: number;
	ctx: number;
	state: "pending" | "ready" | "error";
	data: Uint8Array | null;
	width: number;
	height: number;
	error: string | null;
	/** the driver waits for it (a "wait"): the hold timer runs for it */
	waited: boolean;
	getters: (() => void)[];
	/** pictures of other surfaces this one also writes, done with it (AV1 with film grain: the display picture) */
	also: Picture[];
	/** a video processing output (op "vpp"): its pixels are its input's NV12, shown converted to BGRX this way */
	conv?: Conversion;
	/** and its input picture's id (the guest waiting for it waits for that) */
	from?: number;
	/** video processing outputs waiting for this picture: it outlives its surface's next picture until done (as `also`) */
	feeds?: number;
	/** its decoder output, held uncopied until a consumer decides (Held), or null */
	held: Held | null;
	/** its frame went to the GPU (video processing) and was closed uncopied: no exact pixels left */
	spent?: boolean;
}
/**
 * A decoder output not copied yet (va.md, Frame lifetime): the VideoFrame,
 * held until the first consumer of its pictures decides: video processing
 * into an exported BGRX surface draws it on the GPU and closes it; a
 * readback, an NV12 export, the cap or the context's end copy it to NV12
 * and close it; the pictures being forgotten (surface rendered again or
 * freed) or the stream's end close it.
 */
interface Held {
	frame: VideoFrameLike | null;
	ctx: Context;
	/** the pictures it is the pixels of (AV1: the display picture too) */
	pics: Picture[];
	/** its copy to NV12 once begun (true when made) */
	copy: Promise<boolean> | null;
	err?: string;
}
/** NV12 to BGRX as a "vpp" asks: the matrix, and the input's and the output's range */
interface Conversion {
	bt601: boolean;
	inFull: boolean;
	outFull: boolean;
}
interface HistoryChunk {
	data: Uint8Array;
	remake?: () => Uint8Array;
	key: boolean;
	/** the picture its output is, or null */
	pic: number | null;
	/** its timestamp in the output order (CodecChunk.order) */
	order?: number;
}
interface Rung {
	hw: string;
	variant: number;
}
interface Context {
	id: number;
	kind: CodecKind;
	adapter: CodecAdapter;
	width: number;
	height: number;
	/** the decoder's configure() now; the history's (its first chunk is a key chunk decoded with it) */
	config: object | null;
	historyConfig: object | null;
	decoder: VideoDecoderLike | null;
	/** the decoder needs a key chunk before more delta chunks (it was flushed, failed or reclaimed): made again, history replayed */
	stale: boolean;
	seq: number;
	/** chunk timestamp -> the picture its output is */
	pending: Map<number, number>;
	/** chunk timestamp -> its sequence number, for the history's chunks the decoder now has */
	tsSeq: Map<number, number>;
	/** the chunks since the last key chunk, or null (none yet, or more than HISTORY_MAX) */
	history: HistoryChunk[] | null;
	historyBytes: number;
	/**
	 * The newest key chunk's index in the history: above 0 while pictures
	 * from before it are still to come out (H.264 holds pictures across an
	 * IDR), so a replay still gives them; trimmed once they are out.
	 */
	keyAt: number;
	/** the sequence number history[0] has in the decoder now, and the decoder's latest output's */
	histBase: number;
	lastOut: number;
	/**
	 * How far into the history the last decoder that failed got (chunks; -1:
	 * none), and the decoder made again for that failure: if it fails without
	 * getting further, the stream since the key frame is bad.
	 */
	failPos: number;
	retry: VideoDecoderLike | null;
	retryNext: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	/** the last picture decoded: what a failed picture's readback gets instead */
	lastGood: { data: Uint8Array; width: number; height: number } | null;
	/** its outputs' colour space (the last one's): an encode of a picture copied to NV12 keeps it (va-enc.ts) */
	colour: EncSource["colorSpace"];
	/** the configurations isConfigSupported accepted, in the order to try them, and the one in use */
	ladder: Rung[];
	rung: number;
	/** some decoder of the context gave an output (a failure after that is not the configuration's) */
	everOutput: boolean;
	/** when the newest chunk went in, and whether the first output since is still to come (a latency sample) */
	lastInput: number;
	sinceInput: boolean;
	/** decode latency, ms (moving average; 0: no sample yet) */
	latency: number;
	/**
	 * The picture the newest fillers were for and how many were given for it;
	 * how many it took last time (given at once at the next stall); pictures
	 * fillers did not release (flushed instead) in a row; fillers since the
	 * newest chunk (their timestamps).
	 */
	lastFiller: number;
	/** a decoder being flushed (its outputs are what the flush forces, not the model's to judge) */
	flushing: VideoDecoderLike | null;
	fillerGiven: number;
	fillerDepth: number;
	fillerMisses: number;
	fillerTs: number;
	/** stalls in a row that fillers resolved, and waits since the last one checked without fillers */
	fillerStreak: number;
	waits: number;
	/** a chunk waiting for the context's next picture (CodecChunk.hold) and its picture */
	parked: { k: CodecChunk; out: Picture | null; p: Picture } | null;
	info: VaContextStats;
}

/** @internal What the sessions of one VaHost share. */
export interface VaShared {
	stats: VaStats;
	open: Set<VaContextStats>;
	closed: VaContextStats[];
	/** profiles whose decoders disagreed with the model: later contexts start conservative */
	learned: Set<string>;
	/** profiles whose every configuration failed before a picture */
	broken: Set<string>;
	support: Record<string, { hardware: boolean; software: boolean }>;
	/** zero-copy output's GL side, or none (readback only) */
	gpu?: VaGpu;
	/** encode contexts open, and the last few destroyed */
	encOpen: Set<VaEncodeContextStats>;
	encClosed: VaEncodeContextStats[];
}

/**
 * A surface the driver exported (va/PROTOCOL.md "export"): the guest
 * resources (virtio-gpu, made by the driver) that hold its planes for
 * importers, NV12 as two: Y in an R8 texture of the surface's size, CbCr in
 * an R8G8 one of half its size (rounded up).
 */
interface Binding {
	y: number;
	uv: number;
	width: number;
	height: number;
	/** the picture in them now (0: black, -1: nothing yet) */
	pic: number;
	/** a BGRX surface (a video processing output): one B8G8R8X8 resource, `y` */
	rgb: boolean;
	/** BGRX: the top left part not known to be black (what the last picture covered) */
	extent: [number, number];
	/** BGRX, VaOptions.verify: the NV12 and conversion of the picture drawn on the GPU now (VaHost.reference) */
	ref?: { data: Uint8Array; width: number; height: number; conv: Conversion };
}

/** @internal One driver stream: framing, contexts and their decoders, pictures. */
export class VaSession {
	#wc: WebCodecs;
	#send: (bytes: Uint8Array) => void;
	#probe: () => Promise<VaStatus>;
	#opts: VaOptions;
	#stats: VaStats;
	#shared: VaShared;
	#log: (msg: string) => void;
	#parts: Uint8Array[] = [];
	#have = 0;
	#chain: Promise<void> = Promise.resolve();
	#ctxs = new Map<number, Context>();
	#pics = new Map<number, Picture>();
	/** surface id -> its picture now */
	#surfaces = new Map<number, number>();
	/**
	 * Pictures whose surface was rendered again (or freed) while they were
	 * pending but that write another surface too (Picture.also): their output
	 * still completes that one. (ffmpeg's AV1 with film grain gives the
	 * reference surface of a picture nothing refers to back to its pool at
	 * once, and the next picture may decode into it.)
	 */
	#orphans = new Map<number, Picture>();
	/** surface id -> its exported resources, filled at each of its pictures' completion */
	#bound = new Map<number, Binding>();
	#uploadWarned = false;
	/** decoder outputs held uncopied, oldest first */
	#held: Held[] = [];
	/** a readback came for a picture whose frame the GPU took: from then on such frames are copied to NV12 too */
	#keepNv12 = false;
	#cpuWhy = new Set<string>();
	#vppAsked = "";
	#closed = false;
	/** test hooks (VaHost.inject): each after every `every` pictures, `left` times */
	#injections: { what: VaInjection; every: number; left: number; n: number }[] = [];
	/** the encode contexts (va-enc.ts), where there is a VideoEncoder */
	#enc: VaEncoders | null = null;

	constructor(wc: WebCodecs, send: (bytes: Uint8Array) => void, probe: () => Promise<VaStatus>, opts: VaOptions, shared: VaShared, log: (msg: string) => void) {
		this.#wc = wc;
		this.#send = send;
		this.#probe = probe;
		this.#opts = opts;
		this.#shared = shared;
		this.#stats = shared.stats;
		this.#log = log;
		const ewc = encWebCodecs();
		if (ewc)
			this.#enc = new VaEncoders({
				wc: ewc, out: (o, b) => this.#out(o, b), log, stats: shared.stats.encode, open: shared.encOpen, closed: shared.encClosed,
				hardwareAcceleration: opts.hardwareAcceleration ?? "no-preference", verbose: opts.log ?? true,
				support: async (): Promise<EncSupport> => {
					const st = await this.#probe();
					return { profiles: st.encode, modes: st.encodeModes as EncSupport["modes"], support: {} };
				},
				source: (pic, surface, use) => this.#encSource(pic, surface, use),
			});
	}

	/** The driver's bytes. Throws for a stream that cannot go on (a bad or too large frame): the caller ends it. */
	feed(bytes: Uint8Array): void {
		this.#parts.push(bytes);
		this.#have += bytes.length;
		while (this.#have >= 8) {
			const head = this.#take(8, false);
			const dv = new DataView(head.buffer, head.byteOffset, 8);
			const total = dv.getUint32(0, true), jl = dv.getUint32(4, true), pad = (4 - (jl & 3)) & 3;
			if (jl + pad > total || total > MAX_FRAME) throw new Error(`a bad frame (${total} bytes, JSON ${jl}; at most ${MAX_FRAME})`);
			if (this.#have < 8 + total) break;
			this.#take(8, true);
			const f = this.#take(total, true);
			const msg = JSON.parse(new TextDecoder().decode(f.subarray(0, jl)));
			if (!msg || typeof msg !== "object") throw new Error("a frame that is not a JSON object");
			const bin = f.subarray(jl + pad);
			// in order: hello and ctx wait for WebCodecs' answers, so later messages wait for them
			this.#chain = this.#chain.then(() => this.#handle(msg, bin)).catch((e) => {
				this.#log(`[host] va: ${msg.op}: ${why(e)}`);
				const p = msg.op === "dec" ? this.#pics.get(msg.pic) : undefined;
				if (p) this.#finish(p, "error", why(e));
			});
		}
	}

	/** n bytes from the front of the parts, copied only when they span parts; consume or peek. */
	#take(n: number, consume: boolean): Uint8Array {
		const first = this.#parts[0]!;
		let out: Uint8Array;
		if (first.length >= n) out = first.subarray(0, n);
		else {
			out = new Uint8Array(n);
			let o = 0;
			for (const p of this.#parts) {
				const k = Math.min(p.length, n - o);
				out.set(p.subarray(0, k), o);
				if ((o += k) === n) break;
			}
		}
		if (consume) {
			let left = n;
			while (left) {
				const p = this.#parts[0]!;
				if (p.length > left) {
					this.#parts[0] = p.subarray(left);
					left = 0;
				} else {
					this.#parts.shift();
					left -= p.length;
				}
			}
			this.#have -= n;
		}
		return out;
	}

	/** The host ends the stream: the driver's last frame says why. */
	lost(reason: string): void {
		this.#out({ lost: reason });
	}

	close(): void {
		this.#closed = true;
		this.#enc?.close();
		for (const h of [...this.#held]) this.#drop(h);
		for (const c of this.#ctxs.values()) this.#freeCtx(c, "the link closed");
		this.#ctxs.clear();
		for (const p of this.#pics.values()) this.#finish(p, "error", "the link closed");
		this.#pics.clear();
		this.#surfaces.clear();
		this.#stats.exported -= this.#bound.size;
		this.#bound.clear();
	}

	#out(obj: object, bin?: Uint8Array): void {
		if (this.#closed) return;
		const json = new TextEncoder().encode(JSON.stringify(obj));
		const pad = (4 - (json.length & 3)) & 3, binlen = bin?.length ?? 0;
		const out = new Uint8Array(8 + json.length + pad + binlen);
		const dv = new DataView(out.buffer);
		dv.setUint32(0, json.length + pad + binlen, true);
		dv.setUint32(4, json.length, true);
		out.set(json, 8);
		if (bin) out.set(bin, 8 + json.length + pad);
		this.#send(out);
	}

	#reply(r: unknown, obj: object, bin?: Uint8Array): void {
		if (typeof r === "number" && r > 0) this.#out({ ...obj, r }, bin);
	}

	async #handle(m: any, bin: Uint8Array): Promise<void> {
		switch (m.op) {
			case "hello": {
				if (m.version !== VERSION) return this.#reply(m.r, { err: `the host speaks protocol version ${VERSION}, the driver ${m.version}` });
				const st = await this.#probe();
				if (st.state === "failed") return this.#reply(m.r, { err: st.error ?? "no decoder" });
				return this.#reply(m.r, { version: VERSION, vendor: st.hardware ? "hardware offered" : "software", profiles: st.profiles, maxWidth: this.#maxW, maxHeight: this.#maxH, export: !!this.#shared.gpu, encode: this.#enc ? st.encodeModes : {} });
			}
			case "ctx":
				if (m.entry === "enc") return this.#reply(m.r, this.#enc ? await this.#enc.ctx(m) : { err: "no VideoEncoder on this host" });
				return this.#reply(m.r, await this.#newCtx(m));
			case "ctx_free": {
				if (this.#enc?.free(m.id)) return;
				const c = this.#ctxs.get(m.id);
				this.#ctxs.delete(m.id);
				if (c) this.#retireCtx(c);
				return;
			}
			case "dec":
				return this.#decode(m, bin);
			case "enc":
				// a picture the host cannot read still gets its notice (the driver waits for it)
				try {
					if (!this.#enc) throw new Error("no VideoEncoder on this host");
					this.#enc.enc(m, bin);
				} catch (e) {
					this.#out({ ev: "coded", pic: Number(m.pic), err: why(e) });
					this.#log(`[host] va: enc: ${why(e)}`);
				}
				return;
			case "wait": {
				const w = this.#pics.get(m.pic);
				// a video processing output waits for its input
				// (an orphan too: its surface was decoded into again while the output still waited for it)
				const p = w?.from !== undefined && w.state === "pending" ? this.#pic(w.from) : w;
				const c = p && this.#ctxs.get(p.ctx);
				if (p?.state === "pending" && c) {
					p.waited = true;
					// the guest is blocked on the parked picture (or the other surface it writes): its chunk goes in now
					if (this.#isParked(c, p)) this.#unpark(c);
					// a decoder that has needed fillers at every stall lately gets them now, without waiting for the timer (but at every PROBE_EVERY-th wait)
					if (c.adapter.mode() === "conservative" && c.fillerStreak >= FILLER_STREAK && ++c.waits % PROBE_EVERY && c.decoder && !c.stale && this.#push(c, false)) return;
					if (c.fillerStreak >= FILLER_STREAK && c.waits % PROBE_EVERY === 0) c.fillerStreak = 0;
					// armed again: a timer armed for another picture may be the longer one
					this.#progress(c);
				}
				return;
			}
			case "get":
				void this.#get(m);
				return;
			case "surf_free":
				this.#enc?.surfFree(Array.isArray(m.surfaces) ? m.surfaces.map(Number) : []);
				for (const id of Array.isArray(m.surfaces) ? m.surfaces : []) {
					const pic = this.#surfaces.get(id);
					this.#surfaces.delete(id);
					if (pic !== undefined) this.#forget(pic);
					if (this.#bound.delete(id)) this.#stats.exported--;
				}
				return;
			case "export":
				return this.#reply(m.r, await this.#export(m));
			case "vpp":
				return this.#vpp(m);
			default:
				// "release" (va/PROTOCOL.md) is reserved: not implemented
				this.#reply(m.r, { err: `${m.op === "release" ? "not implemented" : "unknown op"}: ${m.op}` });
		}
	}

	get #maxW(): number {
		return this.#big ? 4096 : 1920;
	}
	get #maxH(): number {
		return this.#big ? 4096 : 1088;
	}
	#big = true;

	async #newCtx(m: any): Promise<object> {
		const kind = CODECS.find((k) => k.profile === m.profile);
		if (!kind || !(await this.#probe()).profiles.includes(kind.profile)) return { err: `profile ${m.profile} is not offered` };
		const w = Number(m.width), h = Number(m.height);
		if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384)) return { err: `a bad size ${m.width}x${m.height}` };
		const learned = this.#shared.learned.has(kind.profile);
		const conservative = this.#opts.mode === "conservative" || learned;
		let adapter: CodecAdapter;
		try {
			adapter = kind.create({ width: w, height: h, log: this.#log, conservative, holdExtra: this.#opts.holdExtra ?? 0 });
		} catch (e) {
			return { err: `${kind.label}: ${why(e)}` };
		}
		// the configurations to try, in order: each packaging with the preferred acceleration, then with prefer-software
		const base = this.#opts.hardwareAcceleration ?? "no-preference";
		const ladder: Rung[] = [];
		for (const hw of base === "prefer-software" ? [base] : [base, "prefer-software"])
			for (let v = 0; v < (adapter.variants ?? 1); v++) {
				const cfg = { ...(adapter.probe?.(v) ?? { codec: kind.probe }), codedWidth: w, codedHeight: h, optimizeForLatency: true, hardwareAcceleration: hw };
				if ((await this.#wc.VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) ladder.push({ hw, variant: v });
			}
		if (!ladder.length) return { err: `VideoDecoder.isConfigSupported(${kind.probe}, ${w}x${h}) said no` };
		adapter.variant?.(ladder[0]!.variant);
		const info: VaContextStats = {
			id: m.id, profile: kind.profile, width: w, height: h, codec: null, description: false, hardwareAcceleration: ladder[0]!.hw, decoder: this.#kindOf(kind.profile, ladder[0]!.hw),
			format: null, mode: adapter.mode(), modeWhy: adapter.mode() === "conservative" ? (this.#opts.mode === "conservative" ? "VaOptions.mode" : learned ? "an earlier context's decoder disagreed with the model" : "the codec has no model") : null,
			open: true, pictures: 0, frames: 0, failed: 0, restarts: 0, replays: 0, holdFires: 0, fillers: 0, flushes: 0, dropped: 0, early: 0, fallbacks: 0, latencyMs: 0, colorSpace: null, adapter: adapter.info?.() ?? {},
		};
		const c: Context = {
			id: m.id, kind, adapter, width: w, height: h, config: null, historyConfig: null, decoder: null, stale: false, seq: 0, pending: new Map(), tsSeq: new Map(), history: null,
			historyBytes: 0, keyAt: 0, histBase: 0, lastOut: 0, failPos: -1, retry: null, retryNext: false, timer: null, lastGood: null, ladder, rung: 0, everOutput: false,
			lastInput: 0, sinceInput: false, latency: 0, colour: null, lastFiller: 0, flushing: null, fillerGiven: 0, fillerDepth: 1, fillerMisses: 0, fillerTs: 0, fillerStreak: 0, waits: 0, parked: null, info,
		};
		const old = this.#ctxs.get(m.id);
		if (old) this.#freeCtx(old, "its context was replaced");
		this.#ctxs.set(m.id, c);
		this.#shared.open.add(info);
		return {};
	}

	/** What decodes, as far as WebCodecs tells (VaContextStats.decoder). */
	#kindOf(profile: string, hw: string): VaContextStats["decoder"] {
		if (hw === "prefer-hardware") return "hardware";
		if (hw === "prefer-software") return "software";
		const s = this.#shared.support[profile];
		return s?.hardware && !s.software ? "hardware" : s && !s.hardware && s.software ? "software" : "hardware or software";
	}

	#fullConfig(c: Context, base: CodecConfig): object {
		c.info.codec = base.codec;
		c.info.description = !!base.description;
		return { ...base, codedWidth: c.width, codedHeight: c.height, optimizeForLatency: true, hardwareAcceleration: c.ladder[c.rung]!.hw };
	}

	#config(c: Context): object | null {
		const base = c.adapter.config();
		return base ? this.#fullConfig(c, base) : null;
	}

	/**
	 * A context the app destroyed: what it submitted still completes, as on a
	 * hardware decoder (ffmpeg destroys its context at a size change while
	 * pictures it decoded ahead are still to be read): the decoder is flushed,
	 * then closed; pictures it gave nothing for fail.
	 */
	#retireCtx(c: Context): void {
		this.#unpark(c);
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		c.history = null;
		this.#closeInfo(c);
		const dec = c.decoder;
		if (!dec || dec.state !== "configured" || c.stale || !c.pending.size) return this.#freeCtx(c, "its context was destroyed");
		const done = (why: string) => {
			// pictures whose output came are being copied (frameToNv12): they finish by themselves
			const left = [...c.pending.values()];
			c.pending.clear();
			this.#closeDecoder(c);
			this.#endHeld(c);
			for (const id of left) {
				const p = this.#pic(id);
				if (p) this.#finish(p, "error", why);
			}
		};
		c.flushing = dec;
		dec.flush().then(
			() => done("its context was destroyed before the decoder gave it"),
			() => done("its context was destroyed"),
		);
	}

	/** The context's stats move to the closed ones (the last few are kept). */
	#closeInfo(c: Context): void {
		if (!this.#shared.open.delete(c.info)) return;
		c.info.open = false;
		c.info.adapter = c.adapter.info?.() ?? {};
		this.#shared.closed.push(c.info);
		if (this.#shared.closed.length > CLOSED_KEPT) this.#shared.closed.shift();
	}

	#freeCtx(c: Context, reason: string): void {
		this.#closeDecoder(c);
		this.#endHeld(c);
		this.#closeInfo(c);
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		for (const p of [...this.#pics.values(), ...this.#orphans.values()]) if (p.ctx === c.id && p.state === "pending") this.#finish(p, "error", reason);
		c.pending.clear();
		c.history = null;
	}

	#closeDecoder(c: Context): void {
		const dec = c.decoder;
		if (!dec) return;
		c.decoder = null;
		this.#stats.decoders--;
		if (dec.state !== "closed") {
			try {
				dec.close();
			} catch {}
		}
	}

	/** A picture is done: the driver is told (its vaSyncSurface returns), and "get"s waiting for it go on. */
	#finish(p: Picture, state: "ready" | "error", error: string | null = null): void {
		if (p.state !== "pending") return;
		if (this.#orphans.get(p.pic) === p) this.#orphans.delete(p.pic);
		p.state = state;
		p.error = error;
		const c = this.#ctxs.get(p.ctx);
		// (pictures left when the link closes count for nothing: nobody waits for them)
		if (state === "error" && !this.#closed) {
			this.#stats.failed++;
			if (c) c.info.failed++;
		}
		// the hold timer as the pictures still waited for say (one armed while this one was being copied may be stale)
		if (c?.timer) this.#progress(c);
		// an exported surface's resources get the picture before the driver hears it is done
		this.#upload(p);
		this.#out(state === "ready" ? { ev: "ready", surface: p.surface, pic: p.pic } : { ev: "error", surface: p.surface, pic: p.pic, err: error });
		const g = p.getters;
		p.getters = [];
		for (const f of g) f();
		for (const a of p.also) {
			if (this.#pics.get(a.pic) !== a) continue;
			a.data = p.data;
			a.width = p.width;
			a.height = p.height;
			// (a vpp of this picture may have taken the shared frame already)
			if (p.spent) a.spent = true;
			if (p.held && !a.held) {
				a.held = p.held;
				p.held.pics.push(a);
			}
			this.#finish(a, state, error);
		}
		// an orphan's frame nobody took (its vpp consumers ran above)
		if (p.held) this.#settle(p.held);
	}

	/** A pending picture by id, an orphan too. */
	#pic(id: number): Picture | undefined {
		return this.#pics.get(id) ?? this.#orphans.get(id);
	}

	/** A picture the driver no longer has (its surface freed or rendered again). */
	#forget(id: number): void {
		const p = this.#pics.get(id);
		if (!p) return;
		this.#pics.delete(id);
		if (p.held) {
			const h = p.held;
			p.held = null;
			this.#settle(h);
		}
		// still owed to another surface: AV1's display picture, or a video processing output (the app gives the input
		// surface back at vaEndPicture, as a GPU queues the work, and the next picture may decode into it)
		if (p.state === "pending" && (p.also.some((a) => this.#pics.get(a.pic) === a) || (p.feeds ?? 0) > 0)) {
			this.#orphans.set(id, p);
			return;
		}
		p.state = "error";
		p.error = "freed";
		p.data = null;
		const g = p.getters;
		p.getters = [];
		for (const f of g) f();
	}

	/** A picture the driver sent, on its surface (the surface's picture before it forgotten). */
	#newPicture(id: number, sid: number, ctx: number): Picture {
		if (!(id > 0) || !Number.isSafeInteger(id)) throw new Error(`a bad picture id ${id}`);
		const old = this.#surfaces.get(sid);
		if (old !== undefined) this.#forget(old);
		this.#forget(id);
		const p: Picture = { pic: id, surface: sid, ctx, state: "pending", data: null, width: 0, height: 0, error: null, waited: false, getters: [], also: [], held: null };
		this.#pics.set(id, p);
		this.#surfaces.set(sid, id);
		return p;
	}

	#decode(m: any, bin: Uint8Array): void {
		this.#stats.pictures++;
		const p = this.#newPicture(Number(m.pic), Number(m.surface), m.ctx);
		// a second surface the picture writes (AV1 with film grain: current_display_picture)
		if (Array.isArray(m.display) && m.display.length === 2 && Number(m.display[0]) !== p.surface) p.also.push(this.#newPicture(Number(m.display[1]), Number(m.display[0]), m.ctx));
		const c = this.#ctxs.get(m.ctx);
		if (!c) return this.#finish(p, "error", `no context ${m.ctx}`);
		c.info.pictures++;
		p.width = c.width;
		p.height = c.height;
		// the buffers: [type, size, num] each, their bytes one after another
		const bufs: VaBuffer[] = [];
		let off = 0;
		for (const b of Array.isArray(m.bufs) ? m.bufs : []) {
			const [type, size, num] = (Array.isArray(b) ? b : []).map(Number) as [number, number, number];
			const len = size * num;
			if (!Number.isSafeInteger(size) || !Number.isSafeInteger(num) || size < 0 || num < 0 || !Number.isSafeInteger(len) || off + len > bin.length) throw new Error(`buffers beyond the frame's ${bin.length} bytes`);
			bufs.push({ type, size, num, data: bin.subarray(off, off + len) });
			off += len;
		}
		const vp: VaPicture = { pic: p.pic, surface: p.surface, profile: c.kind.profile, width: c.width, height: c.height, bufs, refs: Array.isArray(m.refs) ? m.refs.map(Number) : [] };
		// the chunk parked for this picture goes in first, made knowing it
		this.#unpark(c, vp);
		let chunks: CodecChunk[];
		try {
			chunks = c.adapter.picture(vp);
		} catch (e) {
			return this.#finish(p, "error", `${c.kind.label}: ${why(e)}`);
		}
		c.info.adapter = c.adapter.info?.() ?? {};
		const outputs = chunks.filter((k) => k.output).length;
		if (!chunks.some((k) => k.output && !k.added)) this.#stats.hidden++;
		const due = this.#due();
		if (due.includes("fail")) this.#finish(p, "error", "a failure the host was asked for (test)");
		for (const k of chunks) {
			if (k.hold && k === chunks[chunks.length - 1]) {
				c.parked = { k, out: k.output ? p : null, p };
				break;
			}
			if (!this.#submit(c, k, k.output ? p : null, p)) return;
		}
		if (!outputs && p.state === "pending") {
			// no output of its own and no slot holds it: never shown, black if read
			p.data = flatNv12(c.width, c.height, 16);
			this.#finish(p, "ready");
		}
		// input came: the guest is not blocked, the hold timer starts again
		if (c.timer) this.#progress(c);
		for (const what of due) if (what !== "fail") this.#inject(c, what);
	}

	/** Whether the picture is the parked chunk's, or another surface it writes. */
	#isParked(c: Context, p: Picture): boolean {
		return !!c.parked && (c.parked.p === p || c.parked.p.also.includes(p));
	}

	/** The parked chunk, made for the next picture (or none: the guest waits, the context ends), to the decoder. */
	#unpark(c: Context, next: VaPicture | null = null): void {
		const pk = c.parked;
		if (!pk) return;
		c.parked = null;
		let k: CodecChunk;
		try {
			k = pk.k.hold!(next);
		} catch (e) {
			return this.#finish(pk.p, "error", `${c.kind.label}: ${why(e)}`);
		}
		this.#submit(c, k, pk.out, pk.p);
	}

	/** The injections due at this picture. */
	#due(): VaInjection[] {
		const out: VaInjection[] = [];
		for (const j of this.#injections) if (j.left > 0 && ++j.n % j.every === 0) j.left--, out.push(j.what);
		if (out.length) this.#injections = this.#injections.filter((j) => j.left > 0);
		return out;
	}

	/** One chunk to the decoder (made again first if it must be); false when the picture failed. */
	#submit(c: Context, k: CodecChunk, out: Picture | null, p: Picture, again = false): boolean {
		try {
			if (k.reconfigure || !c.config) {
				const cfg = this.#config(c);
				if (!cfg) {
					this.#finish(p, "error", `${c.kind.label}: no decoder configuration yet`);
					return false;
				}
				if (k.reconfigure && c.decoder && !c.stale) {
					// what the decoder holds comes out first (configure() would drop it); a key chunk follows
					const dec = c.decoder;
					c.flushing = dec;
					dec.flush().then(
						() => c.flushing === dec && (c.flushing = null),
						() => c.flushing === dec && (c.flushing = null),
					);
					dec.configure(cfg);
					c.adapter.reset?.();
					c.tsSeq.clear();
				}
				c.config = cfg;
			}
			const usable = c.decoder && c.decoder.state === "configured" && !c.stale;
			if (k.key) {
				if (!usable) {
					// what is pending is replayed up to its last chunk; the key chunk needs nothing before it
					const cfg = c.config!;
					if (c.decoder || c.pending.size) this.#restart(c, false);
					if (!c.decoder) this.#makeDecoder(c, cfg);
					else if (cfg !== c.config) c.decoder.configure(cfg);
					c.config = cfg;
				}
				if (usable && !k.reconfigure && c.history && this.#owed(c, c.history.length)) c.keyAt = c.history.length;
				else {
					c.history = [];
					c.historyBytes = 0;
					c.keyAt = 0;
					c.historyConfig = c.config;
				}
			} else if (!usable) {
				if (!c.history) {
					this.#finish(p, "error", c.decoder || c.stale ? "the decoder was lost and no key frame came since" : "the decoder waits for a key frame");
					return false;
				}
				this.#restart(c, true);
				if (!c.decoder) {
					this.#finish(p, "error", "the decoder could not be made again");
					return false;
				}
			} else if (k.restart && c.history) {
				this.#stats.restarts++;
				c.info.restarts++;
				this.#restart(c, true);
				if (!c.decoder) {
					this.#finish(p, "error", "the decoder could not be made again");
					return false;
				}
			}
			const seq = ++c.seq, ts = k.order ?? seq * 64;
			c.fillerTs = 0;
			if (k.key && !c.keyAt) {
				c.histBase = seq;
				c.failPos = -1;
				c.retry = null;
			}
			if (c.history) {
				c.historyBytes += k.data.length;
				if (c.historyBytes > HISTORY_MAX) {
					c.history = null;
					this.#log(`[host] va: more than ${HISTORY_MAX >> 20} MiB since the last key frame: a decoder lost now needs the next key frame`);
				} else c.history.push({ data: k.remake ? k.data : k.data.slice(), ...(k.remake ? { remake: k.remake } : {}), key: k.key, pic: out?.pic ?? null, ...(k.order !== undefined ? { order: k.order } : {}) });
			}
			if (out && out.state === "pending") c.pending.set(ts, out.pic);
			c.tsSeq.set(ts, seq);
			if (k.added) this.#stats.showExisting++;
			c.lastInput = now();
			c.sinceInput = true;
			c.decoder!.decode(new this.#wc.EncodedVideoChunk({ type: k.key ? "key" : "delta", timestamp: ts, data: k.data }));
			this.#opts.dump?.({ ctx: c.id, profile: c.kind.profile, key: k.key, data: k.data });
			return true;
		} catch (e) {
			c.stale = true;
			this.#stats.errors++;
			// a configuration that cannot even take its first chunks: the next one, with this chunk again
			if (!again && !c.everOutput && this.#fallback(c, e)) return this.#submit(c, k, out, p, true);
			this.#finish(p, "error", `VideoDecoder: ${why(e)}`);
			return false;
		}
	}

	/** Whether a chunk among the history's first `n` is a picture still to come out. */
	#owed(c: Context, n: number): boolean {
		const owed = new Set(c.pending.values());
		for (let i = 0; i < n; i++) if (c.history![i]!.pic !== null && owed.has(c.history![i]!.pic!) && this.#pic(c.history![i]!.pic!)?.state === "pending") return true;
		return false;
	}

	/** The history from its newest key chunk on, once nothing before it is owed. */
	#trim(c: Context): void {
		if (!c.keyAt || !c.history || this.#owed(c, c.keyAt)) return;
		const gone = c.history.splice(0, c.keyAt);
		for (const k of gone) c.historyBytes -= k.data.length;
		c.histBase += c.keyAt;
		c.failPos = -1;
		c.retry = null;
		c.keyAt = 0;
	}

	#makeDecoder(c: Context, config: object): VideoDecoderLike {
		const dec: VideoDecoderLike = new this.#wc.VideoDecoder({
			output: (f) => this.#output(c, dec, f),
			error: (e) => this.#failed(c, dec, e),
		});
		c.decoder = dec;
		c.tsSeq.clear();
		this.#stats.decoders++;
		dec.configure(config);
		c.adapter.reset?.();
		c.stale = false;
		c.lastOut = c.seq;
		return dec;
	}

	/**
	 * A new decoder, and the history decoded into it again: all of it
	 * (`full`, a delta chunk follows) or up to the last chunk of a picture
	 * still pending. Outputs of pictures no longer pending are dropped;
	 * pending pictures the history cannot give fail.
	 */
	#restart(c: Context, full: boolean): void {
		const waiting = new Set<number>();
		for (const id of c.pending.values()) if (this.#pic(id)?.state === "pending") waiting.add(id);
		c.pending.clear();
		this.#closeDecoder(c);
		c.stale = false;
		const h = c.history;
		let end = -1;
		if (h) {
			if (full) end = h.length - 1;
			else for (let i = 0; i < h.length; i++) if (h[i]!.pic !== null && waiting.has(h[i]!.pic!)) end = i;
		}
		try {
			if (h && c.historyConfig && (full || end >= 0)) {
				// the configuration now: the adapter's chunks may carry another (H.264's level after a deeper reorder, another packaging)
				const cfg = this.#config(c) ?? c.historyConfig;
				const dec = this.#makeDecoder(c, cfg);
				c.config = c.historyConfig = cfg;
				c.histBase = c.seq + 1;
				c.retry = c.retryNext ? dec : null;
				c.retryNext = false;
				for (let i = 0; i <= end; i++) {
					const k = h[i]!, seq = ++c.seq, ts = k.order ?? seq * 64;
					if (k.pic !== null && waiting.delete(k.pic)) c.pending.set(ts, k.pic);
					c.tsSeq.set(ts, seq);
					dec.decode(new this.#wc.EncodedVideoChunk({ type: k.key ? "key" : "delta", timestamp: ts, data: k.remake ? k.remake() : k.data }));
				}
				c.fillerTs = 0;
				c.lastInput = now();
				c.sinceInput = true;
				this.#stats.replays++;
				this.#stats.replayed += end + 1;
				c.info.replays++;
			}
		} catch (e) {
			this.#log(`[host] va: the replay failed: ${why(e)}`);
			this.#closeDecoder(c);
			c.history = null;
			for (const id of c.pending.values()) waiting.add(id);
			c.pending.clear();
		}
		for (const id of waiting) {
			const p = this.#pic(id);
			if (p) this.#finish(p, "error", "the decoder was lost before its picture came, and no key frame to replay from");
		}
	}

	#output(c: Context, dec: VideoDecoderLike, frame: VideoFrameLike): void {
		this.#stats.frames++;
		if (dec !== c.decoder || this.#closed) return frame.close();
		const ts = frame.timestamp, id = c.pending.get(ts), seq = c.tsSeq.get(ts);
		c.pending.delete(ts);
		c.tsSeq.delete(ts);
		c.everOutput = true;
		c.info.frames++;
		c.info.format = frame.format;
		if (c.sinceInput) {
			// the first output since the newest chunk went in: how long the decoder takes
			c.sinceInput = false;
			const l = now() - c.lastInput;
			c.latency = c.latency ? 0.8 * c.latency + 0.2 * l : l;
			c.info.latencyMs = Math.round(c.latency * 10) / 10;
		}
		this.#trim(c);
		if (seq !== undefined && seq > c.lastOut) c.lastOut = seq;
		const p = id === undefined ? undefined : this.#pic(id);
		if (id !== undefined && id === c.lastFiller) {
			// the fillers released it: as many at once next time
			c.fillerMisses = 0;
			c.fillerDepth = Math.max(1, c.fillerGiven);
			c.fillerStreak++;
			c.lastFiller = 0;
		}
		// an output the model says the decoder still holds: not the decoder modelled (after this frame is taken)
		const early = id !== undefined && c.flushing !== dec && c.adapter.mode() === "model" && !!c.adapter.held?.(id);
		this.#progress(c);
		if (!p || p.state !== "pending") frame.close();
		else {
			const cs = frame.colorSpace;
			c.info.colorSpace = cs ? `${cs.matrix ?? "null"} ${cs.fullRange === true ? "full" : cs.fullRange === false ? "limited" : "null"}` : null;
			c.colour = cs ? { primaries: cs.primaries ?? null, transfer: cs.transfer ?? null, matrix: cs.matrix ?? null, fullRange: cs.fullRange ?? null } : null;
			const h: Held = { frame, ctx: c, pics: [p], copy: null };
			p.held = h;
			if (++this.#stats.framesHeld > this.#stats.framesHeldPeak) this.#stats.framesHeldPeak = this.#stats.framesHeld;
			if (this.#holds(p)) {
				// held for its first consumer (a GPU draw needs no copy); done now
				this.#held.push(h);
				this.#finish(p, "ready");
				this.#settle(h);
				this.#cap(c);
			} else
				// copied now (nothing could take it on the GPU, or its NV12 is wanted): then done
				void this.#copy(h).then((ok) => {
					if (this.#pic(p.pic) !== p || p.state !== "pending") return;
					if (ok) this.#finish(p, "ready");
					else this.#finish(p, "error", `VideoFrame.copyTo: ${h.err}`);
				});
		}
		if (early) {
			c.info.early++;
			this.#conservative(c, "the decoder gave a picture the model said it still held");
		}
	}

	/**
	 * The decoder is not the one the adapter's model describes: the context
	 * goes conservative, for good, and later contexts of the profile start
	 * so. True when the decoder was made again (the adapter's chunks changed).
	 */
	#conservative(c: Context, reason: string, replay = true): boolean {
		if (c.adapter.mode() === "conservative") return false;
		// (from decoder callbacks and timers: an adapter that throws must not end the context's recovery)
		let restart = false;
		try {
			restart = c.adapter.conservative?.(reason) ?? false;
		} catch (e) {
			this.#log(`[host] va: ${c.kind.label}: conservative mode: ${why(e)}`);
		}
		c.info.mode = c.adapter.mode();
		c.info.modeWhy = reason;
		c.info.adapter = c.adapter.info?.() ?? {};
		this.#stats.modeSwitches++;
		this.#shared.learned.add(c.kind.profile);
		this.#log(`[host] va: ${c.kind.label} ${c.width}x${c.height} (context ${c.id}, ${c.info.codec ?? c.kind.probe}, ${c.info.decoder}${c.info.format ? `, ${c.info.format} frames` : ""}): conservative mode: ${reason}`);
		if (!restart || !replay || !c.history || !c.decoder || c.stale) return false;
		this.#stats.restarts++;
		c.info.restarts++;
		this.#restart(c, true);
		return true;
	}

	/** The next configuration of the ladder, for a context whose decoder failed before any output; false when none is left. */
	#fallback(c: Context, err: unknown): boolean {
		if (c.rung + 1 >= c.ladder.length) {
			if (!this.#shared.broken.has(c.kind.profile)) {
				this.#shared.broken.add(c.kind.profile);
				this.#log(`[host] va: ${c.kind.label}: every configuration failed before a picture (${why(err)}), though isConfigSupported said yes: not offered to later connections`);
			}
			return false;
		}
		const from = c.ladder[c.rung]!;
		const to = c.ladder[++c.rung]!;
		c.adapter.variant?.(to.variant);
		c.config = null;
		c.historyConfig = this.#config(c) ?? c.historyConfig;
		c.retryNext = false;
		c.failPos = -1;
		c.retry = null;
		c.info.fallbacks++;
		this.#stats.fallbacks++;
		c.info.hardwareAcceleration = to.hw;
		c.info.mode = c.adapter.mode();
		if (c.info.mode === "conservative") c.info.modeWhy ??= "the packaging the decoder takes has no model";
		c.info.decoder = this.#kindOf(c.kind.profile, to.hw);
		c.info.adapter = c.adapter.info?.() ?? {};
		this.#log(`[host] va: ${c.kind.label} ${c.width}x${c.height}: the decoder failed before its first picture (${why(err)}) with ${from.hw}${c.adapter.variants ? `, variant ${from.variant}` : ""}: trying ${to.hw}${c.adapter.variants ? `, ${JSON.stringify(c.info.adapter.packaging ?? to.variant)}` : ""}`);
		return true;
	}

	#failed(c: Context, dec: VideoDecoderLike, err: Error): void {
		if (c.decoder !== dec) return;
		const reclaimed = err?.name === "QuotaExceededError";
		const what = `${c.kind.label} ${c.width}x${c.height}`;
		c.decoder = null;
		this.#stats.decoders--;
		c.stale = true;
		// a configuration the decoder does not take: NotSupportedError, or an error before any output within its first chunks
		if (!reclaimed && !c.everOutput && (err?.name === "NotSupportedError" || c.seq - c.histBase < 3) && this.#fallback(c, err)) {
			this.#stats.errors++;
			if (c.pending.size && c.history) this.#restart(c, true);
			return;
		}
		if (reclaimed) {
			this.#stats.reclaims++;
			c.retryNext = false;
			if (this.#opts.log ?? true) this.#log(`[va] the browser reclaimed the decoder (${what}): ${why(err)}; made again with the stream since its last key frame`);
		} else {
			this.#stats.errors++;
			if (this.#opts.log ?? true) this.#log(`[va] decoder error (${what}): ${err?.name ?? "Error"}: ${why(err)}`);
			const done = c.history ? c.lastOut - c.histBase + 1 : 0, again = dec === c.retry && done <= c.failPos;
			c.failPos = done;
			c.retryNext = true;
			if (again) {
				// a replay failed where the decoder before it did: the stream since the key frame is bad
				c.history = null;
				if (this.#opts.log ?? true) this.#log(`[va] the replay failed at the same place: pictures fail until the next key frame`);
			}
		}
		if (!c.pending.size) return; // made again at the next picture
		if (!c.history) {
			const pending = [...c.pending.values()];
			c.pending.clear();
			c.history = null;
			for (const id of pending) {
				const p = this.#pic(id);
				if (p) this.#finish(p, "error", `the decoder failed: ${why(err)}`);
			}
			return;
		}
		this.#restart(c, true);
	}

	/** Whether the driver waits for a picture of the context: 2 for one the adapter says the decoder holds, 1 for another, 0 for none. */
	#waited(c: Context): number {
		let w = 0;
		for (const p of this.#waitable(c)) {
			if (c.adapter.held?.(p.pic)) return 2;
			w = 1;
		}
		return w;
	}

	/** The first decoded of the pictures the driver waits for (not one the model says is held), or undefined. */
	#waitedPic(c: Context): number | undefined {
		let best: number | undefined;
		for (const p of this.#waitable(c)) if (best === undefined || p.pic < best) best = p.pic;
		return best;
	}

	/** The context's pending pictures the driver waits for: its surfaces' and orphans (a video processing output waits for one). */
	*#waitable(c: Context): Generator<Picture> {
		for (const m of [this.#pics, this.#orphans]) for (const p of m.values()) if (p.ctx === c.id && p.state === "pending" && p.waited) yield p;
	}

	/** How long the hold timer runs: short for a picture the model knows is held; else a multiple of the decode latency (the most until there is a sample). */
	#holdMs(c: Context, w: number): number {
		if (w === 2) return HELD_MS;
		const [lo, hi, first] = c.adapter.mode() === "model" ? MODEL_HOLD : CONSERVATIVE_HOLD;
		if (!c.latency) return first;
		return Math.min(hi, Math.max(lo, c.adapter.mode() === "model" ? 8 * c.latency + 10 : 3 * c.latency + 5));
	}

	/** The hold timer: runs while the driver waits for a picture of the context, restarted by every output and input. */
	#arm(c: Context): void {
		const w = this.#waited(c);
		if (!c.timer && w) c.timer = setTimeout(() => this.#hold(c), this.#holdMs(c, w));
	}

	#progress(c: Context): void {
		if (c.timer) clearTimeout(c.timer);
		c.timer = null;
		this.#arm(c);
	}

	/**
	 * The hold timer fired: no output while the driver waits for a picture.
	 * A decoder still working (decodeQueueSize) is left alone. In model mode a
	 * picture the model says is out by now means the decoder is not the
	 * modelled one: the context goes conservative. In conservative mode the
	 * adapter's filler (a chunk that changes no state) makes the decoder give
	 * what it holds; failing that (none, or it did not release the picture)
	 * the decoder is flushed, and the next delta chunk makes it again with
	 * the history replayed (a flushed decoder needs a key chunk). Pictures a
	 * flush does not give were dropped: the adapter may declare more and the
	 * replay gives them. Without a usable decoder (it failed or was
	 * reclaimed) it is made again now.
	 */
	#hold(c: Context, forced = false): void {
		c.timer = null;
		if (this.#closed || this.#ctxs.get(c.id) !== c || (!forced && !this.#waited(c))) return;
		this.#unpark(c);
		const dec = c.decoder;
		if (!dec || dec.state !== "configured" || c.stale) {
			if (c.pending.size) this.#restart(c, true);
			this.#arm(c);
			return;
		}
		if (!forced && (dec.decodeQueueSize ?? 0) > 0) return this.#arm(c);
		const w = forced ? 0 : this.#waited(c);
		if (!forced) {
			this.#stats.holdFires++;
			c.info.holdFires++;
		}
		if (w === 1 && c.adapter.mode() === "model" && this.#conservative(c, `a picture the model said was out did not come in ${Math.round(this.#holdMs(c, 1))} ms`)) return this.#arm(c);
		if (w === 1 && c.adapter.mode() === "conservative" && this.#push(c, true)) return;
		this.#stats.flushes++;
		c.info.flushes++;
		if (forced || w !== 2) this.#log(forced ? "[host] va: the decoder flushed (test)" : `[host] va: the decoder held a picture for ${Math.round(this.#holdMs(c, w))} ms with nothing queued: flushed`);
		c.stale = true;
		// (what the flush gives is no latency sample)
		c.sinceInput = false;
		c.flushing = dec;
		dec.flush().then(
			() => {
				if (c.flushing === dec) c.flushing = null;
				if (c.decoder !== dec) return;
				const left: number[] = [];
				for (const id of c.pending.values()) if (this.#pic(id)?.state === "pending") left.push(id);
				if (!left.length) return c.pending.clear();
				this.#stats.dropped += left.length;
				c.info.dropped += left.length;
				// the decoder dropped them: not the modelled one; a deeper reorder and a replay may still give them
				this.#conservative(c, `the decoder dropped ${left.length} picture(s)`, false);
				let deeper = false;
				try {
					deeper = !!c.history && !!c.adapter.dropped?.(left);
				} catch (e) {
					this.#log(`[host] va: ${c.kind.label}: ${why(e)}`);
				}
				if (deeper) {
					this.#stats.restarts++;
					c.info.restarts++;
					c.info.adapter = c.adapter.info?.() ?? {};
					this.#restart(c, true);
					return this.#arm(c);
				}
				c.pending.clear();
				for (const id of left) {
					const p = this.#pic(id);
					if (p) this.#finish(p, "error", "the decoder gave no picture for it");
				}
			},
			() => {
				if (c.flushing === dec) c.flushing = null;
			},
		);
	}

	/**
	 * Fillers for the picture the guest waits for: as many at once as it
	 * took last time, then one more each time the timer fires again, as far
	 * as the adapter can make them. False when none went in (none can be made,
	 * or after 3 pictures in a row that fillers did not release): a flush.
	 */
	#push(c: Context, stalled: boolean): boolean {
		const dec = c.decoder;
		if (!dec || c.fillerMisses >= 3) return false;
		const pic = this.#waitedPic(c);
		if (pic === undefined) return false;
		if (pic !== c.lastFiller) (c.lastFiller = pic), (c.fillerGiven = 0);
		let n = 0;
		try {
			for (const want = c.fillerGiven ? 1 : c.fillerDepth; n < want && c.fillerGiven < FILLERS_MAX && c.fillerTs < 63; n++) {
				const f = c.adapter.filler?.(pic, c.fillerGiven);
				if (!f) break;
				c.fillerTs++;
				c.fillerGiven++;
				dec.decode(new this.#wc.EncodedVideoChunk({ type: "delta", timestamp: f.order ?? c.seq * 64 + c.fillerTs, data: f.data }));
				this.#stats.fillers++;
				c.info.fillers++;
			}
		} catch (e) {
			this.#log(`[host] va: a filler failed: ${why(e)}`);
		}
		if (n) {
			c.lastInput = now();
			c.sinceInput = true;
			this.#progress(c);
			return true;
		}
		if (stalled) {
			// fillers cannot release it: flushed, and after 3 such pictures in a row no more fillers
			if (c.fillerGiven) c.fillerMisses++;
			c.fillerStreak = 0;
			c.lastFiller = 0;
		}
		return false;
	}

	// ---- frame lifetime (va.md, Frame lifetime) ----

	/** Whether a picture's frame is held for a later consumer rather than copied to NV12 now: only where a GPU draw could take it, and nothing wants its NV12 already. */
	#holds(p: Picture): boolean {
		if (!this.#shared.gpu?.video || this.#opts.upload === "cpu" || p.getters.length > (p.feeds ?? 0)) return false;
		for (const x of [p, ...p.also]) if (this.#bound.get(x.surface)?.rgb === false) return false;
		return true;
	}

	/** A held frame none of whose pictures the driver still has (and that no copy took): closed. */
	#settle(h: Held): void {
		if (h.frame && !h.copy && !h.pics.some((x) => x.held === h && this.#pics.get(x.pic) === x)) this.#drop(h);
	}

	/** A held frame closed uncopied; `spent`: the GPU took it (its pictures have no exact pixels left). */
	#drop(h: Held, spent = false): void {
		const i = this.#held.indexOf(h);
		if (i >= 0) this.#held.splice(i, 1);
		if (!h.frame) return;
		try {
			h.frame.close();
		} catch {}
		h.frame = null;
		this.#stats.framesHeld--;
		for (const x of h.pics)
			if (x.held === h) {
				x.held = null;
				if (spent) x.spent = true;
			}
	}

	/** A held frame copied to NV12 (into each of its pictures) and closed; true once copied. */
	#copy(h: Held): Promise<boolean> {
		if (h.copy) return h.copy;
		const i = this.#held.indexOf(h);
		if (i >= 0) this.#held.splice(i, 1);
		const f = h.frame;
		if (!f) return (h.copy = Promise.resolve(false));
		h.frame = null;
		const t = now();
		h.copy = frameToNv12(f, this.#log).then(
			(r) => {
				this.#stats.framesHeld--;
				this.#stats.copies++;
				this.#stats.copyMs += now() - t;
				h.ctx.lastGood = r;
				for (const x of h.pics)
					if (x.held === h) {
						x.held = null;
						x.data = r.data;
						x.width = r.width;
						x.height = r.height;
					}
				return true;
			},
			(e) => {
				this.#stats.framesHeld--;
				h.err = why(e);
				for (const x of h.pics) if (x.held === h) x.held = null;
				return false;
			},
		);
		return h.copy;
	}

	/** More than HOLD_MAX frames held for the context: the oldest copied to NV12 and closed (as every frame was before the GPU path). */
	#cap(c: Context): void {
		let n = 0;
		for (const h of this.#held) if (h.ctx === c) n++;
		for (const h of [...this.#held]) {
			if (n <= HOLD_MAX) break;
			if (h.ctx !== c) continue;
			n--;
			this.#stats.framesEvicted++;
			void this.#copy(h);
		}
	}

	/** The context ends: its held frames are copied to NV12 (its pictures may still be read), or closed when the stream ends. */
	#endHeld(c: Context): void {
		for (const h of [...this.#held]) if (h.ctx === c) this.#closed ? this.#drop(h) : void this.#copy(h);
	}

	/** A video processing output goes the CPU way, and why (counted per reason: the text before " ("; the first of each logged). */
	#cpuWay(reason: string): void {
		const key = reason.split(" (")[0]!;
		this.#stats.gpuFallbacks[key] = (this.#stats.gpuFallbacks[key] ?? 0) + 1;
		if (!this.#cpuWhy.has(key)) {
			this.#cpuWhy.add(key);
			this.#log(`[host] va: video processing on the CPU (copy to NV12, convert, upload) rather than the GPU: ${reason}`);
		}
	}

	/**
	 * Video processing on the GPU: the input's held VideoFrame drawn into the
	 * BGRX surface's texture (the browser converts by the frame's colour
	 * space, which must be the conversion asked for), its visible picture top
	 * left, cropped to the surface; the rest black. Null when done (the
	 * frame then closed uncopied), else why not (nothing written).
	 */
	#draw(q: Picture, src: Picture): string | null {
		const gpu = this.#shared.gpu, b = this.#bound.get(q.surface), conv = q.conv!;
		if (!b?.rgb) return "not exported (yet)";
		if (!gpu?.video) return "no GPU upload (no renderer)";
		if (this.#opts.upload === "cpu") return "upload: cpu";
		const h = src.held;
		if (!h?.frame) return src.data ? "copied to NV12 already (read back first, or over the cap)" : "no frame";
		const f = h.frame;
		const r = f.visibleRect ?? { x: 0, y: 0, width: f.displayWidth, height: f.displayHeight };
		if (f.displayWidth !== r.width || f.displayHeight !== r.height) return `display size (${f.displayWidth}x${f.displayHeight} for a ${r.width}x${r.height} picture: drawn scaled)`;
		const fc = frameConversion(f);
		if (!fc || fc.bt601 !== conv.bt601 || fc.full !== conv.inFull) return `colour (the frame's ${fc ? convName(fc) : `matrix ${f.colorSpace?.matrix}`}, asked ${convName({ bt601: conv.bt601, full: conv.inFull })})`;
		if (!conv.outFull) return "limited-range RGB asked";
		const w = Math.min(r.width, b.width), hh = Math.min(r.height, b.height);
		const t = now();
		// what the last picture covered beyond this one's rectangle: black first (once, at a size change)
		if (b.extent[0] > w || b.extent[1] > hh) {
			const black = gpu.write(b.y, { x: 0, y: 0, width: b.width, height: b.height }, (dst) => {
				dst.fill(0);
				for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
			});
			if (!black) return "the black fill failed";
			b.extent = [0, 0];
		}
		let err: string | null;
		try {
			err = gpu.video(b.y, f, w, hh);
		} catch (e) {
			err = why(e);
		}
		if (err) return `the draw failed (${err})`;
		this.#stats.gpuUploads++;
		this.#stats.gpuUploadMs += now() - t;
		b.extent = [w, hh];
		b.pic = q.pic;
		q.width = r.width;
		q.height = r.height;
		// the input's frame was taken: closed, or first copied to NV12 where its exact pixels may still be read
		if (this.#keepNv12 || this.#opts.verify)
			void this.#copy(h).then(() => {
				if (this.#opts.verify && b.pic === q.pic && src.data) b.ref = { data: src.data, width: src.width, height: src.height, conv };
			});
		else this.#drop(h, true);
		return null;
	}

	/**
	 * A video processing output read back (BGRX, pitch width * 4): its
	 * exported texture where its picture was written there (what importers
	 * see, GPU-drawn or not), else its input's NV12 converted on the CPU.
	 */
	#getBgrx(m: any, q: Picture): void {
		const b = this.#bound.get(q.surface), gpu = this.#shared.gpu;
		let data: Uint8Array | null = null, w = 0, h = 0;
		const failed = q.state === "error" ? (q.error ?? "failed") : undefined;
		if (b?.rgb && b.pic === q.pic && gpu?.read) {
			data = gpu.read(b.y, { x: 0, y: 0, width: b.width, height: b.height });
			(w = b.width), (h = b.height);
		}
		if (!data) {
			let nv = q.data, nw = q.width, nh = q.height;
			if (q.state === "error" || !nv) {
				const g = this.#ctxs.get(this.#pic(q.from ?? 0)?.ctx ?? -1)?.lastGood;
				if (g) (nv = g.data), (nw = g.width), (nh = g.height);
				else (nw ||= 16), (nh ||= 16), (nv = flatNv12(nw, nh, 128));
			}
			const l = nv12Layout(nw, nh);
			(w = nw), (h = nh), (data = new Uint8Array(w * h * 4));
			nv12ToBgrx(nv, nw, nh, l.pitch, l.offsets[1], data, w, h, q.conv!);
		}
		this.#stats.readbacks++;
		this.#stats.bytesRead += data.length;
		this.#reply(m.r, { pic: q.pic, format: "BGRX", width: w, height: h, pitches: [w * 4], offsets: [0], ...(failed ? { failed } : {}) }, data);
	}

	async #get(m: any): Promise<void> {
		const p = this.#pics.get(m.pic);
		if (!p || p.surface !== m.surface) return this.#reply(m.r, { err: `no picture ${m.pic} of surface ${m.surface}` });
		const pc = this.#ctxs.get(p.ctx);
		if (p.state === "pending" && pc && this.#isParked(pc, p)) this.#unpark(pc);
		if (p.state === "pending") await new Promise<void>((res) => p.getters.push(res));
		if (this.#pics.get(m.pic) !== p) return this.#reply(m.r, { err: `picture ${m.pic} was freed` });
		if (p.conv) return this.#getBgrx(m, p);
		// a held frame: copied now (its first consumer)
		if (p.held) {
			await this.#copy(p.held);
			if (this.#pics.get(m.pic) !== p) return this.#reply(m.r, { err: `picture ${m.pic} was freed` });
		}
		let data = p.data, w = p.width, h = p.height;
		let failed: string | undefined;
		if (p.state !== "error" && !data && p.spent) {
			// its frame went to the GPU and was closed uncopied: a stand-in this once; such frames are copied from now on
			p.state = "error";
			p.error = "its frame went to the GPU (video processing) uncopied; frames are copied to NV12 too from now on";
			if (!this.#keepNv12) this.#log(`[host] va: a picture was read back after video processing drew its frame on the GPU: a stand-in for it; this stream's frames are copied to NV12 as well from now on`);
			this.#keepNv12 = true;
		}
		if (p.state === "error") {
			// the last good picture of its context, or grey
			failed = p.error ?? "failed";
			const g = this.#ctxs.get(p.ctx)?.lastGood;
			if (g) (data = g.data), (w = g.width), (h = g.height);
			else data = flatNv12(w || 16, h || 16, 128), (w ||= 16), (h ||= 16);
		}
		if (!data) return this.#reply(m.r, { err: `picture ${m.pic} was read back already` });
		// the driver keeps it; an exported surface's picture stays for an upload (export after a readback)
		if (!this.#bound.has(p.surface)) p.data = null;
		const l = nv12Layout(w, h);
		this.#stats.readbacks++;
		this.#stats.bytesRead += data.length;
		this.#reply(m.r, { pic: p.pic, format: "NV12", width: w, height: h, pitches: [l.pitch, l.pitch], offsets: l.offsets, ...(failed ? { failed } : {}) }, data);
	}

	/**
	 * vaExportSurfaceHandle (va/PROTOCOL.md "export"): the surface's planes
	 * are in guest resources the driver made (`res`: Y as R8, CbCr as R8G8),
	 * which the host fills from here on with each of the surface's pictures
	 * as it completes, before its notice, so a guest that syncs the surface
	 * (or got this reply for a picture that was done) samples it complete.
	 * A picture done before the export is uploaded now, before the reply.
	 */
	async #export(m: any): Promise<object> {
		const gpu = this.#shared.gpu;
		if (!gpu) return { err: "no zero-copy output on this host (no virtio-gpu device with 3D)" };
		const sid = Number(m.surface), w = Number(m.width), h = Number(m.height), rgb = m.format === "BGRX";
		const res = Array.isArray(m.res) ? m.res.map(Number) : [];
		if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384) || res.length !== (rgb ? 1 : 2) || !res.every((r: number) => r > 0 && Number.isSafeInteger(r))) return { err: "a bad export" };
		this.#stats.exports++;
		let b = this.#bound.get(sid);
		if (!b || b.y !== res[0] || b.uv !== (res[1] ?? 0) || b.width !== w || b.height !== h || b.rgb !== rgb) {
			if (!b) this.#stats.exported++;
			b = { y: res[0], uv: res[1] ?? 0, width: w, height: h, pic: -1, rgb, extent: [w, h] };
			this.#bound.set(sid, b);
		}
		const id = this.#surfaces.get(sid);
		const p = id === undefined ? undefined : this.#pics.get(id);
		if (!p) {
			// no picture: black, as a readback of it
			if (b.pic !== 0 && !this.#writePlanes(b, flatNv12(w, h, 16), w, h)) return { err: "the renderer has no such resource (or no renderer)" };
			b.pic = 0;
			return {};
		}
		// pending: its completion uploads it; a held frame is copied first (NV12 planes are written exact)
		if (p.state !== "pending" && b.pic !== p.pic) {
			if (p.held) await this.#copy(p.held);
			if (!this.#upload(p)) return { err: "the renderer has no such resource (or no renderer)" };
		}
		return {};
	}

	/** A done picture into its surface's exported resources, if the surface has some (the stand-in for a failed one, as a readback gets). */
	#upload(p: Picture): boolean {
		const b = this.#bound.get(p.surface);
		if (!b || b.pic === p.pic || this.#closed) return true;
		if (this.#surfaces.get(p.surface) !== p.pic) return true;
		let data = p.data, w = p.width, h = p.height;
		if (p.state === "error" || !data) {
			const g = this.#ctxs.get(p.ctx)?.lastGood;
			if (p.state !== "error" && !this.#uploadWarned) {
				this.#uploadWarned = true;
				this.#log("[host] va: a picture read back before its surface was exported has no pixels left for the export: grey instead");
			}
			if (p.state === "error" && g) (data = g.data), (w = g.width), (h = g.height);
			else (w ||= b.width), (h ||= b.height), (data = flatNv12(w, h, 128));
		}
		b.pic = p.pic;
		return this.#writePlanes(b, data, w, h, p.conv);
	}

	/**
	 * Video processing (va/PROTOCOL.md "vpp"): a picture on a BGRX surface that
	 * is its input picture converted, done when that is (from the host's NV12
	 * copy: nothing decoded again, nothing read back); its pixels exist only
	 * in the surface's exported resource.
	 */
	#vpp(m: any): void {
		const src = this.#pic(Number(m.srcPic));
		const q = this.#newPicture(Number(m.pic), Number(m.surface), 0);
		q.conv = { bt601: m.matrix === "bt601", inFull: !!m.inFull, outFull: m.outFull !== false };
		const asked = `${convName({ bt601: q.conv.bt601, full: q.conv.inFull })} to ${q.conv.outFull ? "full" : "limited"}-range RGB`;
		if (asked !== this.#vppAsked) this.#log(`[host] va: video processing asked for ${(this.#vppAsked = asked)}`);
		q.from = Number(m.srcPic);
		if (!src || src.surface !== Number(m.src)) return this.#finish(q, "error", `no picture ${m.srcPic} of surface ${m.src} to process`);
		const done = () => {
			if (this.#pics.get(q.pic) !== q || q.state !== "pending") return;
			// a failed (or freed) input: its stand-in, as a readback of it gets
			if (src.state !== "ready") return this.#finish(q, "error", `its input ${src.error ?? "failed"}`);
			// on the GPU from the input's frame where it can; else from its NV12 on the CPU (copied first if held)
			const no = this.#draw(q, src);
			if (!no) return this.#finish(q, "ready");
			this.#cpuWay(no);
			const fill = () => {
				if (this.#pics.get(q.pic) !== q || q.state !== "pending") return;
				q.data = src.data;
				q.width = src.width;
				q.height = src.height;
				this.#finish(q, "ready");
			};
			if (src.held) void this.#copy(src.held).then(fill);
			else fill();
		};
		if (src.state === "pending") {
			src.feeds = (src.feeds ?? 0) + 1;
			src.getters.push(() => {
				src.feeds!--;
				done();
			});
		} else done();
	}

	/**
	 * A decoded picture of the surface as an encode's input (va-enc.ts;
	 * va/PROTOCOL.md "enc"): when it is done, its held frame (open only
	 * during `use`: the encoder clones it) or its NV12; the stand-in a
	 * readback gets where it failed or its pixels are gone. Waited for as a
	 * video processing input is (a feed: its surface decoded into again
	 * first does not take it away).
	 */
	#encSource(id: number, surface: number, use: (s: EncSource | null) => void): void {
		const src = this.#pic(id);
		if (!src || src.surface !== surface || src.conv) return use(null);
		const done = () => {
			if (src.state === "ready" && src.held?.frame) return use({ frame: src.held.frame, data: null, width: src.width, height: src.height });
			// (NV12 copied from the decoder's frame: its colour space, so frames and copies of one stream are alike to the encoder)
			if (src.state === "ready" && src.data) return use({ frame: null, data: src.data, width: src.width, height: src.height, colorSpace: this.#ctxs.get(src.ctx)?.colour ?? null });
			const failed = src.state === "error" ? (src.error ?? "failed") : "its pixels were taken (read back, or drawn on the GPU)";
			const g = this.#ctxs.get(src.ctx)?.lastGood;
			if (g) return use({ frame: null, data: g.data, width: g.width, height: g.height, failed });
			const w = src.width || 16, h = src.height || 16;
			use({ frame: null, data: flatNv12(w, h, 128), width: w, height: h, failed });
		};
		if (src.state !== "pending") return done();
		src.feeds = (src.feeds ?? 0) + 1;
		src.getters.push(() => {
			src.feeds!--;
			done();
		});
	}

	/** A w x h NV12 picture (nv12Layout) into a binding's two textures (or, converted, its BGRX one), top left, the rest black. */
	#writePlanes(b: Binding, nv12: Uint8Array, w: number, h: number, conv?: Conversion): boolean {
		const gpu = this.#shared.gpu!;
		const t = now();
		const { pitch, offsets } = nv12Layout(w, h);
		// The resources are named by the guest: one of another format (bytes per texel) is refused, not
		// written partly or past its rows (a throw here would also skip the picture's notice).
		const sized = (dst: Uint8Array, n: number) => {
			if (dst.length !== n) throw new Error(`resource of ${dst.length} bytes for ${n}: another format`);
		};
		if (b.rgb) {
			let ok = false;
			try {
				ok = gpu.write(b.y, { x: 0, y: 0, width: b.width, height: b.height }, (dst) => {
					sized(dst, b.width * b.height * 4);
					nv12ToBgrx(nv12, w, h, pitch, offsets[1], dst, b.width, b.height, conv ?? { bt601: h < 720, inFull: false, outFull: true });
				});
			} catch {}
			if (ok) {
				b.extent = [Math.min(w, b.width), Math.min(h, b.height)];
				// (a video processing picture's; not the black of a surface without one)
				if (conv) {
					this.#stats.cpuConversions++;
					this.#stats.cpuConversionMs += now() - t;
				}
			}
			return this.#counted(b, ok, b.width * b.height * 4, t);
		}
		const plane = (res: number, pw: number, ph: number, bpp: number, off: number, rows: number, rowBytes: number, fill: number): boolean =>
			gpu.write(res, { x: 0, y: 0, width: pw, height: ph }, (dst) => {
				sized(dst, pw * ph * bpp);
				const line = pw * bpp, n = Math.min(rowBytes, line);
				for (let y = 0; y < ph; y++) {
					const o = y * line;
					if (y < rows) {
						dst.set(nv12.subarray(off + y * pitch, off + y * pitch + n), o);
						if (n < line) dst.fill(fill, o + n, o + line);
					} else dst.fill(fill, o, o + line);
				}
			});
		const cw = (b.width + 1) >> 1, ch = (b.height + 1) >> 1;
		let ok = false;
		try {
			ok = plane(b.y, b.width, b.height, 1, 0, h, w, 16) && plane(b.uv, cw, ch, 2, offsets[1], (h + 1) >> 1, ((w + 1) >> 1) * 2, 128);
		} catch {}
		return this.#counted(b, ok, b.width * b.height + cw * ch * 2, t);
	}

	#counted(b: Binding, ok: boolean, bytes: number, t: number): boolean {
		if (ok) {
			this.#stats.uploads++;
			this.#stats.uploadBytes += bytes;
			this.#stats.uploadMs += now() - t;
		} else {
			if (!this.#stats.uploadFailed++) this.#log(`[host] va: an exported surface's resources (${b.y}, ${b.uv}) could not be filled: no renderer, or the resources are gone (the app gets an export error or a stale picture)`);
			b.pic = -1;
		}
		return ok;
	}

	/** @internal VaHost.reference: the CPU conversion of the picture drawn on the GPU into a BGRX resource now (VaOptions.verify). */
	reference(resource: number): { width: number; height: number; data: Uint8Array } | null {
		for (const b of this.#bound.values()) {
			if (!b.rgb || b.y !== resource || !b.ref) continue;
			const { data, width, height, conv } = b.ref, l = nv12Layout(width, height), out = new Uint8Array(b.width * b.height * 4);
			nv12ToBgrx(data, width, height, l.pitch, l.offsets[1], out, b.width, b.height, conv);
			return { width: b.width, height: b.height, data: out };
		}
		return null;
	}

	/** @internal for VaHost: whether 4K is offered */
	set big(v: boolean) {
		this.#big = v;
	}

	/** @internal test hook (VaHost.inject): now on every context, or after every `every` pictures, `count` times. */
	inject(what: VaInjection | null, count: number, every: number): void {
		this.#enc?.inject(what, count, every);
		if (!what) this.#injections = [];
		else if (every > 0) this.#injections.push({ what, every, left: count, n: 0 });
		else if (what !== "fail") for (const c of this.#ctxs.values()) this.#inject(c, what);
	}

	#inject(c: Context, what: Exclude<VaInjection, "fail">): void {
		this.#unpark(c);
		const dec = c.decoder;
		if (!dec) return;
		if (what === "flush") return this.#hold(c, true);
		// as Chrome does: the decoder is closed, then its error callback runs
		try {
			dec.close();
		} catch {}
		const e = new Error(what === "reclaim" ? "Codec reclaimed due to inactivity (test)." : "Decoding error (test).");
		e.name = what === "reclaim" ? "QuotaExceededError" : "EncodingError";
		this.#failed(c, dec, e);
	}
}

/** The guest's VA-API decoder: vsock port 1024 served on this thread (vm.va). */
export class VaHost {
	/** Resolves once the host listens. */
	readonly ready: Promise<string>;
	#opts: VaOptions;
	#log: (msg: string) => void;
	#listener: VsockListener | undefined;
	#conns = new Set<VsockConnection>();
	#sessions = new Set<VaSession>();
	#status: VaStatus = { state: "idle", profiles: [], hardware: null, support: {}, broken: [], encode: [], encodeModes: {}, error: null };
	#probe: Promise<VaStatus> | undefined;
	#big = false;
	#shared: VaShared = {
		stats: {
			connections: 0, opened: 0, bytesIn: 0, bytesOut: 0, decoders: 0, pictures: 0, hidden: 0, frames: 0, readbacks: 0, bytesRead: 0, showExisting: 0, failed: 0, errors: 0, reclaims: 0,
			flushes: 0, replays: 0, replayed: 0, restarts: 0, holdFires: 0, fillers: 0, dropped: 0, modeSwitches: 0, fallbacks: 0, exports: 0, exported: 0, uploads: 0,
			uploadBytes: 0, uploadMs: 0, uploadFailed: 0, gpuUploads: 0, gpuUploadMs: 0, cpuConversions: 0, cpuConversionMs: 0, gpuFallbacks: {}, copies: 0, copyMs: 0,
			framesHeld: 0, framesHeldPeak: 0, framesEvicted: 0, contexts: [], encode: encodeStats(),
		},
		open: new Set(),
		closed: [],
		learned: new Set(),
		broken: new Set(),
		support: {},
		encOpen: new Set(),
		encClosed: [],
	};
	#stats = this.#shared.stats;
	#down = false;

	/** @internal Use createKernel({ va }). */
	constructor(vsock: Vsock, opts: VaOptions, log: (msg: string) => void, gpu?: VaGpu) {
		this.#opts = opts;
		this.#log = log;
		this.#shared.gpu = gpu;
		this.#listener = vsock.listen(VA_PORT, (conn) => this.#serve(conn));
		const what = `WebCodecs VideoDecoder, asked on the guest's first VA-API connection, on vsock port ${VA_PORT}; ${gpu ? "zero-copy output through virtio-gpu" : "readback only (no virtio-gpu device with 3D)"}`;
		log(`[host] va: ${what}`);
		this.ready = Promise.resolve(what);
	}

	/** idle (no guest connection yet), ready (profiles known), failed. */
	get status(): VaStatus {
		const broken = [...this.#shared.broken];
		return { ...this.#status, profiles: this.#status.profiles.filter((p) => !broken.includes(p)), support: { ...this.#status.support }, broken, encode: [...this.#status.encode], encodeModes: { ...this.#status.encodeModes } };
	}

	/** Streams, decoders, pictures, read-backs and errors; each context's decoder, mode, stalls and recoveries. */
	get stats(): VaStats {
		const contexts = [...this.#shared.open, ...this.#shared.closed].map((c) => ({ ...c, adapter: { ...c.adapter } }));
		const encode = { ...this.#stats.encode, list: [...this.#shared.encOpen, ...this.#shared.encClosed].map((c) => ({ ...c })) };
		return { ...this.#stats, gpuFallbacks: { ...this.#stats.gpuFallbacks }, contexts, encode };
	}

	/**
	 * @internal Test hook (VaOptions.verify): for a BGRX resource a picture
	 * was drawn into on the GPU, the CPU path's conversion of that picture
	 * (BGRX, the resource's size), to compare with what the compositor shows.
	 */
	reference(resource: number): { width: number; height: number; data: Uint8Array } | null {
		for (const s of this.#sessions) {
			const r = s.reference(resource);
			if (r) return r;
		}
		return null;
	}

	/**
	 * @internal Test hook: change the options for contexts made from now on
	 * (mode, holdExtra, hardwareAcceleration), and forget which profiles'
	 * decoders disagreed with the model.
	 */
	setOptions(o: Partial<VaOptions>): void {
		Object.assign(this.#opts, o);
		this.#shared.learned.clear();
	}

	/** Ask WebCodecs now which profiles it decodes, as the guest's first connection would. */
	load(): Promise<VaStatus> {
		return this.#support();
	}

	/**
	 * @internal Test hook: every decoder as if the browser reclaimed it
	 * ("reclaim"), it failed ("error") or held its picture ("flush"), or a
	 * picture fails ("fail": decoded, its output dropped). Now on every
	 * stream (not "fail"), or with `every` after every that many pictures
	 * of each stream, now and later ones, `count` times (default always).
	 * null clears them.
	 */
	inject(what: VaInjection | null, opts: { every?: number; count?: number } = {}): void {
		const count = opts.count ?? Infinity, every = opts.every ?? 0;
		if (!what) this.#injections = [];
		else if (every > 0) this.#injections.push({ what, every, count });
		for (const s of this.#sessions) s.inject(what, count, every);
	}
	/** for streams opened later */
	#injections: { what: VaInjection; every: number; count: number }[] = [];

	#support(): Promise<VaStatus> {
		this.#probe ??= (async () => {
			const wc = webCodecs();
			try {
				if (!wc) throw new Error("no VideoDecoder");
				const hw = this.#opts.hardwareAcceleration ?? "no-preference";
				const ask = (cfg: CodecConfig, w: number, h: number, a: string) =>
					wc.VideoDecoder.isConfigSupported({ ...cfg, codedWidth: w, codedHeight: h, optimizeForLatency: true, hardwareAcceleration: a }).then((s) => !!s.supported, () => false);
				// encoders (va-enc.ts): VideoEncoder.isConfigSupported for each, with the rate control modes it takes
				const encoders = probeEncoders(encWebCodecs(), hw);
				const res = await Promise.all(CODECS.map(async (k) => {
					// every packaging the adapter has (H.264: Annex B, avcC): one that works is enough
					let a: CodecAdapter | null = null;
					try {
						a = k.create({ width: 1920, height: 1080, log: () => {}, conservative: false, holdExtra: 0 });
					} catch {}
					const cfgs = a?.probe ? Array.from({ length: a.variants ?? 1 }, (_, i) => a!.probe!(i)) : [{ codec: k.probe }];
					const any = async (w: number, h: number, acc: string) => (await Promise.all(cfgs.map((c) => ask(c, w, h, acc)))).some(Boolean);
					const [hd, uhd, hard, soft] = await Promise.all([any(1920, 1080, hw), any(3840, 2160, hw), any(1920, 1080, "prefer-hardware"), any(1920, 1080, "prefer-software")]);
					return { k, hd: hd && !!a, uhd, hard, soft };
				}));
				const offered = res.filter((r) => r.hd);
				this.#big = offered.length > 0 && offered.every((r) => r.uhd);
				const support: VaStatus["support"] = {};
				for (const r of res) support[r.k.profile] = { hardware: r.hard, software: r.soft };
				this.#shared.support = support;
				const enc = await encoders;
				this.#status = { state: "ready", profiles: offered.map((r) => r.k.profile), hardware: offered.some((r) => r.hard), support, broken: [], encode: enc.profiles, encodeModes: enc.modes, error: null };
				if (enc.profiles.length) this.#log(`[host] va: WebCodecs encodes ${enc.profiles.map((p) => `${ENCODERS.find((k) => k.profile === p)?.label ?? p} (${enc.modes[p]!.join(", ")}${enc.support[p]?.hardware ? "; hardware offered" : ""})`).join(", ")}`);
				this.#log(`[host] va: WebCodecs decodes ${offered.length ? offered.map((r) => `${r.k.label}${r.hard ? " (hardware offered)" : ""}`).join(", ") + (this.#big ? " up to 4K" : " up to 1080p") : "none of the offered profiles"}`);
			} catch (e) {
				this.#status = { state: "failed", profiles: [], hardware: null, support: {}, broken: [], encode: [], encodeModes: {}, error: why(e) };
			}
			return this.#status;
		})();
		return this.#probe;
	}

	#serve(conn: VsockConnection): void {
		const wc = webCodecs();
		if (this.#down || !wc) {
			conn.reset();
			return;
		}
		this.#conns.add(conn);
		this.#stats.connections++;
		this.#stats.opened++;
		const writer = conn.writable.getWriter();
		const stats = this.#stats;
		let broken = false;
		const fail = (what: string, e: unknown) => {
			if (broken) return;
			broken = true;
			if (!this.#down) this.#log(`[host] va: ${what}: ${why(e)}`);
			conn.reset();
		};
		let last: Promise<void> = Promise.resolve();
		const send = (bytes: Uint8Array) => {
			stats.bytesOut += bytes.length;
			last = writer.write(bytes);
			last.catch((e) => fail("a write to the guest failed", e));
		};
		const session = new VaSession(wc, send, () => this.#support().then(() => ((session.big = this.#big), this.status)), this.#opts, this.#shared, this.#log);
		this.#sessions.add(session);
		for (const j of this.#injections) session.inject(j.what, j.count, j.every);
		const run = async () => {
			const reader = conn.readable.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				stats.bytesIn += value.length;
				try {
					session.feed(value);
				} catch (e) {
					session.lost(why(e));
					// the lost frame goes out before the reset
					await last.catch(() => {});
					throw e;
				}
			}
		};
		run()
			.catch((e) => fail("the stream ended", e))
			.finally(() => {
				session.close();
				this.#sessions.delete(session);
				if (!broken) writer.close().catch(() => {});
				this.#conns.delete(conn);
				this.#stats.connections--;
			});
	}

	/** @internal The kernel exited. */
	shutdown(): void {
		this.#down = true;
		this.#listener?.close();
		for (const c of this.#conns) c.reset();
	}
}
