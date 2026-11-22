// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A virtio-gpu device model (virtio spec 5.7) for the guest's stock
// drivers/gpu/drm/virtio driver over kwvirtio (virtio.ts): /dev/dri/card0
// (driver name "virtio_gpu") with KMS on one scanout, shown on the host's
// display (display.ts) instead of kwfb's pixels while it is set.
//
// 2D only: GET_DISPLAY_INFO, GET_EDID (VIRTIO_GPU_F_EDID: the size and the
// physical size of the display option, fitted by fitGpuSize(); a change on
// a running machine is a display event, displayChanged()), RESOURCE_CREATE_2D, RESOURCE_UNREF,
// RESOURCE_ATTACH_BACKING and DETACH_BACKING, SET_SCANOUT,
// TRANSFER_TO_HOST_2D, RESOURCE_FLUSH, and the cursor queue (taken and
// ignored). No capsets (no VIRTIO_GPU_F_VIRGL), so Mesa in the guest uses
// software rendering on dumb buffers.
//
// Resources: a guest resource's pixels live in its backing, guest pages the
// driver attached (scattered; kernel memory offsets, read in place). The
// host keeps a copy (XRGB8888) only of resources that have been scanned
// out: SET_SCANOUT fills it from the backing, and TRANSFER_TO_HOST_2D
// copies the transferred rectangle into it, converting the format if need
// be. The display reads that copy, so a frame never tears, and memory goes
// only to resources that are shown. RESOURCE_FLUSH counts frames
// (`stats.flushes`; onFlush).
//
// Commands are taken in order. The 2D ones answer during the notify import.
// Everything else (3D: contexts, SUBMIT_3D, RESOURCE_CREATE_3D, transfers
// 3D, capsets, blobs; and resource commands for ids the 2D model did not
// create) goes to the GpuBackend if there is one, else gets
// ERR_UNSPEC. A backend may answer later (a promise): an unfenced command
// then holds the queue until it is answered; a fenced one does not, and
// fenced answers go back in the order the commands came (the driver
// signals every fence up to the one answered).
//
// With a backend (gl-gpu.ts: virglrenderer on WebGL2) a backend's resource
// may be scanned out: SET_SCANOUT gives the display that mode with no
// pixels here (DisplaySource.pixels() null: the picture is a GL texture
// where the renderer runs, which presents it; GlHost), and SET_SCANOUT,
// RESOURCE_FLUSH and RESOURCE_UNREF of it also go to the backend.

import { FOURCC_XRGB8888, type DisplayMode, type DisplaySize, type DisplaySource } from "./display.ts";
import type { VirtioDeviceModel, VirtqBuffer, VirtqChain, Virtqueue } from "./virtio.ts";

export const VIRTIO_ID_GPU = 16;

/** Feature bits (virtio_gpu.h). */
export const VIRTIO_GPU_F_VIRGL = 1n << 0n;
export const VIRTIO_GPU_F_EDID = 1n << 1n;
export const VIRTIO_GPU_F_RESOURCE_UUID = 1n << 2n;
export const VIRTIO_GPU_F_RESOURCE_BLOB = 1n << 3n;
export const VIRTIO_GPU_F_CONTEXT_INIT = 1n << 4n;

/** Command and response types. */
export const GPU_CMD = {
	GET_DISPLAY_INFO: 0x0100,
	RESOURCE_CREATE_2D: 0x0101,
	RESOURCE_UNREF: 0x0102,
	SET_SCANOUT: 0x0103,
	RESOURCE_FLUSH: 0x0104,
	TRANSFER_TO_HOST_2D: 0x0105,
	RESOURCE_ATTACH_BACKING: 0x0106,
	RESOURCE_DETACH_BACKING: 0x0107,
	GET_CAPSET_INFO: 0x0108,
	GET_CAPSET: 0x0109,
	GET_EDID: 0x010a,
	RESOURCE_ASSIGN_UUID: 0x010b,
	RESOURCE_CREATE_BLOB: 0x010c,
	SET_SCANOUT_BLOB: 0x010d,
	CTX_CREATE: 0x0200,
	CTX_DESTROY: 0x0201,
	CTX_ATTACH_RESOURCE: 0x0202,
	CTX_DETACH_RESOURCE: 0x0203,
	RESOURCE_CREATE_3D: 0x0204,
	TRANSFER_TO_HOST_3D: 0x0205,
	TRANSFER_FROM_HOST_3D: 0x0206,
	SUBMIT_3D: 0x0207,
	RESOURCE_MAP_BLOB: 0x0208,
	RESOURCE_UNMAP_BLOB: 0x0209,
	UPDATE_CURSOR: 0x0300,
	MOVE_CURSOR: 0x0301,
} as const;

export const GPU_RESP = {
	OK_NODATA: 0x1100,
	OK_DISPLAY_INFO: 0x1101,
	OK_CAPSET_INFO: 0x1102,
	OK_CAPSET: 0x1103,
	OK_EDID: 0x1104,
	OK_RESOURCE_UUID: 0x1105,
	OK_MAP_INFO: 0x1106,
	ERR_UNSPEC: 0x1200,
	ERR_OUT_OF_MEMORY: 0x1201,
	ERR_INVALID_SCANOUT_ID: 0x1202,
	ERR_INVALID_RESOURCE_ID: 0x1203,
	ERR_INVALID_CONTEXT_ID: 0x1204,
	ERR_INVALID_PARAMETER: 0x1205,
} as const;

const FLAG_FENCE = 1;
const FLAG_INFO_RING_IDX = 2;
const EVENT_DISPLAY = 1;
/** struct virtio_gpu_ctrl_hdr. */
const HDR = 24;
const MAX_SCANOUTS = 16;

/** virtio_gpu_formats with 4 bytes per pixel (the same numbers as virgl's): the byte offsets of B, G and R in a pixel. */
export const FORMATS: Record<number, [number, number, number]> = {
	1: [0, 1, 2], // B8G8R8A8_UNORM
	2: [0, 1, 2], // B8G8R8X8_UNORM
	3: [3, 2, 1], // A8R8G8B8_UNORM
	4: [3, 2, 1], // X8R8G8B8_UNORM
	67: [2, 1, 0], // R8G8B8A8_UNORM
	68: [1, 2, 3], // X8B8G8R8_UNORM
	121: [1, 2, 3], // A8B8G8R8_UNORM
	134: [2, 1, 0], // R8G8B8X8_UNORM
};

/** A 2D resource (RESOURCE_CREATE_2D). */
interface Resource {
	id: number;
	format: number;
	width: number;
	height: number;
	/** The guest pages behind it (ATTACH_BACKING), with each entry's start offset. */
	backing: VirtqBuffer[] | null;
	starts: number[];
	/** XRGB8888 copy, width * 4 bytes per row; made when it is first scanned out. */
	host: Uint8Array | null;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What a backend is given besides a command. */
export interface GpuBackendContext {
	/** The kernel's memory (read at call time; a backend on another thread gets copies). */
	memory(): WebAssembly.Memory;
	/** The backing pages of a resource the 2D model created, or null. */
	backing(resourceId: number): readonly VirtqBuffer[] | null;
}

/**
 * The 3D side: a renderer such as virglrenderer (gl-gpu.ts). The device
 * hands it every command the 2D model does not handle (GET_CAPSET_INFO and
 * GET_CAPSET included), as a copy, header first, and writes back what it
 * answers (header first; the device fills in the fence fields of the
 * request). Null answers ERR_UNSPEC. A promise answers later (see the file
 * header for the ordering).
 */
export interface GpuBackend {
	/** Feature bits added to the device's (VIRTIO_GPU_F_VIRGL, _CONTEXT_INIT, _RESOURCE_BLOB). */
	readonly features: bigint;
	/** num_capsets in the config space, read when the driver probes; the capsets themselves come through command(). */
	readonly capsetCount: number;
	command(cmd: Uint8Array, ctx: GpuBackendContext): Uint8Array | null | Promise<Uint8Array | null>;
	/** The size of a resource the backend created (SET_SCANOUT of it), or null. */
	resource(id: number): { width: number; height: number } | null;
	/** The driver reset the device: forget every context and resource. */
	reset?(): void;
	/** Why a snapshot cannot be taken now (state only the renderer holds), or "". */
	blocker?(): string;
}

/** Where the picture goes: DisplayHost. */
export interface GpuDisplay {
	/** The size the host wants (GET_DISPLAY_INFO, GET_EDID). */
	wantedSize(): DisplaySize;
	/** Show this picture instead of kwfb's, or kwfb's again (null). */
	setScanout(src: DisplaySource | null): void;
}

export interface VirtioGpuOptions {
	memory: () => WebAssembly.Memory;
	display: GpuDisplay;
	backend?: GpuBackend;
	/** A RESOURCE_FLUSH of the scanout's resource (the rectangle). */
	onFlush?: (rect: Rect) => void;
	log?: (msg: string) => void;
}

export interface VirtioGpuStats {
	commands: number;
	errors: number;
	transfers: number;
	/** Bytes TRANSFER_TO_HOST_2D copied into host copies. */
	transferBytes: number;
	flushes: number;
	cursor: number;
	/** Commands handed to the backend. */
	backend: number;
}

/** Why a command failed (the response type). */
class GpuError extends Error {
	readonly code: number;
	constructor(code: number, msg: string) {
		super(msg);
		this.code = code;
	}
}

export class VirtioGpu implements VirtioDeviceModel {
	readonly deviceId = VIRTIO_ID_GPU;
	/** controlq, cursorq. */
	readonly queueSizes = [256, 16] as const;
	stats: VirtioGpuStats = { commands: 0, errors: 0, transfers: 0, transferBytes: 0, flushes: 0, cursor: 0, backend: 0 };
	#memory: () => WebAssembly.Memory;
	#display: GpuDisplay;
	#backend: GpuBackend | undefined;
	#onFlush: ((rect: Rect) => void) | undefined;
	#log: (msg: string) => void;
	#resources = new Map<number, Resource>();
	/** Scanout 0: the resource and the rectangle shown, or null. */
	#scanout: { res: Resource; rect: Rect } | null = null;
	/** Scanout 0 showing a backend's resource instead (its id and the rectangle), or null. */
	#scanout3d: { id: number; rect: Rect } | null = null;
	#eventsRead = 0;
	/** The size last answered to GET_DISPLAY_INFO, or null before the first (displayChanged()). */
	#told: DisplaySize | null = null;
	/** An unfenced backend command is pending: later ones wait. */
	#stalled = false;
	/** The last fenced answer still to go back (later fenced answers go after it). */
	#fenceTail: Promise<void> | null = null;
	#pending = 0;
	/** Bumped by reset(): answers from before it are dropped. */
	#epoch = 0;
	#notifyFn: (() => void) | null = null;

	constructor(opts: VirtioGpuOptions) {
		this.#memory = opts.memory;
		this.#display = opts.display;
		this.#backend = opts.backend;
		this.#onFlush = opts.onFlush;
		this.#log = opts.log ?? (() => {});
	}

	features(): bigint {
		return VIRTIO_GPU_F_EDID | (this.#backend?.features ?? 0n);
	}

	config(): Uint8Array {
		const b = new Uint8Array(16);
		const dv = new DataView(b.buffer);
		dv.setUint32(0, this.#eventsRead, true);
		dv.setUint32(4, 0, true); // events_clear
		dv.setUint32(8, 1, true); // num_scanouts
		dv.setUint32(12, this.#backend?.capsetCount ?? 0, true);
		return b;
	}

	configWrite(offset: number, data: Uint8Array): void {
		// events_clear (offset 4): write 1 to clear.
		if (offset === 4 && data.length >= 4) this.#eventsRead &= ~new DataView(data.buffer, data.byteOffset).getUint32(0, true);
	}

	/** Set by the owner (Kernel): tells the transport that the config changed. */
	set configNotifier(fn: (() => void) | null) {
		this.#notifyFn = fn;
	}

	/**
	 * The host's display size may have changed (DisplayHost.wantedSize()):
	 * when it differs from the size the driver last read, set
	 * VIRTIO_GPU_EVENT_DISPLAY in events_read and raise a config interrupt.
	 * The driver then asks for the EDID and the display info again and sends
	 * a hotplug uevent; a KMS client that probes the connector finds the new
	 * preferred mode and sets it if it wants (the display follows the mode
	 * set, not this size). Before the driver has read a size nothing is
	 * raised (it reads one when it probes); `force` raises it anyway (after
	 * a restore, where the size the snapshot's driver read is not known).
	 * True when raised.
	 */
	displayChanged(force = false): boolean {
		const s = this.#size(), t = this.#told;
		if (!force && (!t || (t.width === s.width && t.height === s.height && t.dpi === s.dpi))) return false;
		this.#eventsRead |= EVENT_DISPLAY;
		this.#notifyFn?.();
		return true;
	}

	/** The display size the driver last read (GET_DISPLAY_INFO), or null before it has. */
	get displaySize(): DisplaySize | null {
		return this.#told && { ...this.#told };
	}

	reset(): void {
		this.#epoch++;
		this.#resources.clear();
		this.#setScanout(null);
		this.#scanout3d = null;
		this.#eventsRead = 0;
		this.#stalled = false;
		this.#fenceTail = null;
		this.#pending = 0;
		this.#backend?.reset?.();
	}

	blocker(): string {
		return [this.#pending ? "virtio-gpu commands" : "", this.held()].filter(Boolean).join(", ");
	}

	/**
	 * State that only the host holds and a snapshot cannot save, which lasts
	 * while the program that made it runs ("virtio-gpu resources", the 2D
	 * model's or the backend's, "virtio-gpu contexts"), or "" (commands in
	 * flight are blocker()'s too, but pass).
	 */
	held(): string {
		const back = this.#backend?.blocker?.() ?? "";
		return this.#resources.size && !back.includes("virtio-gpu resources") ? ["virtio-gpu resources", back].filter(Boolean).join(", ") : back;
	}

	/** Resources the 2D model holds (for tests and stats). */
	get resourceCount(): number {
		return this.#resources.size;
	}

	/** The scanout's mode, or null while nothing is scanned out. */
	get scanoutMode(): DisplayMode | null {
		const s = this.#scanout, t = this.#scanout3d;
		if (t) return { width: t.rect.width, height: t.rect.height, stride: t.rect.width * 4, format: FOURCC_XRGB8888 };
		return s ? { width: s.rect.width, height: s.rect.height, stride: s.res.width * 4, format: FOURCC_XRGB8888 } : null;
	}

	notify(q: Virtqueue): void {
		if (q.index === 1) {
			// Cursor commands: no answer but the buffer back.
			for (let c = q.pop(); c; c = q.pop()) {
				this.stats.cursor++;
				q.push(c, 0);
			}
			return;
		}
		this.#drain(q);
	}

	#drain(q: Virtqueue): void {
		while (!this.#stalled) {
			const chain = q.pop();
			if (!chain) return;
			const req = q.read(chain);
			this.stats.commands++;
			let res: Uint8Array | null | Promise<Uint8Array | null>;
			try {
				res = this.#command(req);
			} catch (e) {
				res = this.#error(e);
			}
			const fenced = req.length >= HDR && (new DataView(req.buffer).getUint32(4, true) & FLAG_FENCE) !== 0;
			if (!(res instanceof Promise)) {
				if (fenced && this.#fenceTail) this.#later(q, chain, req, Promise.resolve(res), true);
				else this.#answer(q, chain, req, res);
				continue;
			}
			this.#later(q, chain, req, res, fenced);
		}
	}

	/** An answer that comes later: fenced ones in order, an unfenced one holds the queue. */
	#later(q: Virtqueue, chain: VirtqChain, req: Uint8Array, res: Promise<Uint8Array | null>, fenced: boolean): void {
		const epoch = this.#epoch;
		this.#pending++;
		const safe = res.catch((e: unknown) => this.#error(e));
		const done = (r: Uint8Array | null) => {
			if (epoch !== this.#epoch) return;
			this.#pending--;
			this.#answer(q, chain, req, r);
		};
		if (fenced) {
			const tail = (this.#fenceTail ?? Promise.resolve()).then(() => safe).then(done);
			this.#fenceTail = tail;
			void tail.then(() => {
				if (this.#fenceTail === tail) this.#fenceTail = null;
			});
			return;
		}
		this.#stalled = true;
		void safe.then((r) => {
			if (epoch !== this.#epoch) return;
			done(r);
			this.#stalled = false;
			this.#drain(q);
		});
	}

	#error(e: unknown): Uint8Array {
		const code = e instanceof GpuError ? e.code : GPU_RESP.ERR_UNSPEC;
		this.stats.errors++;
		if (!(e instanceof GpuError)) this.#log(`[virtio-gpu] ${(e as Error)?.message ?? e}`);
		return resp(code);
	}

	/** Write the answer (header fields from the request) and return the chain. */
	#answer(q: Virtqueue, chain: VirtqChain, req: Uint8Array, res: Uint8Array | null): void {
		const out = res ?? resp(GPU_RESP.ERR_UNSPEC);
		if (out.length >= HDR && req.length >= HDR) {
			const i = new DataView(req.buffer, req.byteOffset);
			const o = new DataView(out.buffer, out.byteOffset);
			const flags = i.getUint32(4, true);
			if (flags & FLAG_FENCE) {
				o.setUint32(4, o.getUint32(4, true) | (flags & (FLAG_FENCE | FLAG_INFO_RING_IDX)), true);
				o.setBigUint64(8, i.getBigUint64(8, true), true);
				o.setUint32(16, i.getUint32(16, true), true);
				o.setUint8(20, i.getUint8(20));
			}
		}
		q.push(chain, q.write(chain, out));
	}

	#command(req: Uint8Array): Uint8Array | null | Promise<Uint8Array | null> {
		if (req.length < HDR) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "short command");
		const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
		const type = dv.getUint32(0, true);
		const need = (n: number) => {
			if (req.length < n) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, `command 0x${type.toString(16)}: ${req.length} bytes`);
		};
		const rect = (at: number): Rect => ({ x: dv.getUint32(at, true), y: dv.getUint32(at + 4, true), width: dv.getUint32(at + 8, true), height: dv.getUint32(at + 12, true) });
		switch (type) {
			case GPU_CMD.GET_DISPLAY_INFO:
				return this.#displayInfo();
			case GPU_CMD.GET_EDID: {
				need(HDR + 8);
				if (dv.getUint32(HDR, true) !== 0) throw new GpuError(GPU_RESP.ERR_INVALID_SCANOUT_ID, "edid");
				const out = resp(GPU_RESP.OK_EDID, HDR + 8 + 1024);
				const edid = makeEdid(this.#size());
				new DataView(out.buffer).setUint32(HDR, edid.length, true);
				out.set(edid, HDR + 8);
				return out;
			}
			case GPU_CMD.GET_CAPSET_INFO:
				need(HDR + 4);
				if (dv.getUint32(HDR, true) >= (this.#backend?.capsetCount ?? 0)) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "capset index");
				return this.#toBackend(req, GPU_RESP.ERR_INVALID_PARAMETER);
			case GPU_CMD.RESOURCE_CREATE_2D: {
				need(HDR + 16);
				const id = dv.getUint32(HDR, true), format = dv.getUint32(HDR + 4, true);
				const width = dv.getUint32(HDR + 8, true), height = dv.getUint32(HDR + 12, true);
				if (!id || this.#resources.has(id)) throw new GpuError(GPU_RESP.ERR_INVALID_RESOURCE_ID, "create_2d");
				if (!FORMATS[format] || !width || !height || width > 16384 || height > 16384)
					throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "create_2d");
				this.#resources.set(id, { id, format, width, height, backing: null, starts: [], host: null });
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_UNREF: {
				need(HDR + 8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) {
					if (this.#scanout3d?.id === dv.getUint32(HDR, true)) this.#setScanout(null);
					return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				}
				if (this.#scanout?.res === res) this.#setScanout(null);
				this.#resources.delete(res.id);
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_ATTACH_BACKING: {
				need(HDR + 8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				const n = dv.getUint32(HDR + 4, true);
				need(HDR + 8 + 16 * n);
				const size = this.#memory().buffer.byteLength;
				const backing: VirtqBuffer[] = [], starts: number[] = [];
				let total = 0;
				for (let i = 0; i < n; i++) {
					const at = HDR + 8 + 16 * i;
					const addr = Number(dv.getBigUint64(at, true)), len = dv.getUint32(at + 8, true);
					if (addr + len > size) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "backing outside memory");
					backing.push({ addr, len });
					starts.push(total);
					total += len;
				}
				res.backing = backing;
				res.starts = starts;
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_DETACH_BACKING: {
				need(HDR + 8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				res.backing = null;
				res.starts = [];
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.SET_SCANOUT: {
				need(HDR + 24);
				const r = rect(HDR), scanout = dv.getUint32(HDR + 16, true), id = dv.getUint32(HDR + 20, true);
				if (scanout !== 0) throw new GpuError(GPU_RESP.ERR_INVALID_SCANOUT_ID, "set_scanout");
				if (!id || !r.width || !r.height) {
					this.#setScanout(null);
					// The backend presents its resources: it hears that nothing is shown now.
					return this.#backend ? this.#toBackend(req, GPU_RESP.OK_NODATA) : resp(GPU_RESP.OK_NODATA);
				}
				const res = this.#resources.get(id);
				if (!res) {
					const size = this.#backend?.resource(id);
					if (!size) throw new GpuError(GPU_RESP.ERR_INVALID_RESOURCE_ID, "set_scanout");
					if (r.x + r.width > size.width || r.y + r.height > size.height) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "set_scanout rect");
					this.#setScanout3d({ id, rect: r });
					return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				}
				if (r.x + r.width > res.width || r.y + r.height > res.height) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "set_scanout rect");
				if (!res.host) {
					res.host = new Uint8Array(res.width * res.height * 4);
					this.#transfer(res, { x: 0, y: 0, width: res.width, height: res.height }, 0);
				}
				this.#setScanout({ res, rect: r });
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.TRANSFER_TO_HOST_2D: {
				need(HDR + 32);
				const r = rect(HDR), offset = Number(dv.getBigUint64(HDR + 16, true));
				const res = this.#resources.get(dv.getUint32(HDR + 24, true));
				if (!res) return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				if (r.x + r.width > res.width || r.y + r.height > res.height) throw new GpuError(GPU_RESP.ERR_INVALID_PARAMETER, "transfer rect");
				this.stats.transfers++;
				if (res.host) this.#transfer(res, r, offset);
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_FLUSH: {
				need(HDR + 24);
				const r = rect(HDR);
				const res = this.#resources.get(dv.getUint32(HDR + 16, true));
				if (!res) {
					if (this.#scanout3d?.id === dv.getUint32(HDR + 16, true)) {
						this.stats.flushes++;
						try { this.#onFlush?.(r); } catch {}
					}
					return this.#toBackend(req, GPU_RESP.ERR_INVALID_RESOURCE_ID);
				}
				if (this.#scanout?.res === res) {
					this.stats.flushes++;
					try { this.#onFlush?.(r); } catch {}
				}
				return resp(GPU_RESP.OK_NODATA);
			}
			default:
				return this.#toBackend(req, GPU_RESP.ERR_UNSPEC);
		}
	}

	/** A command for the backend (3D, or a resource the 2D model does not know), or `code` without one. */
	#toBackend(req: Uint8Array, code: number): Uint8Array | null | Promise<Uint8Array | null> {
		const b = this.#backend;
		if (!b) throw new GpuError(code, "no backend");
		this.stats.backend++;
		return b.command(req, {
			memory: this.#memory,
			backing: (id) => this.#resources.get(id)?.backing ?? null,
		});
	}

	#size(): DisplaySize {
		return fitGpuSize(this.#display.wantedSize());
	}

	#displayInfo(): Uint8Array {
		const out = resp(GPU_RESP.OK_DISPLAY_INFO, HDR + MAX_SCANOUTS * 24);
		const dv = new DataView(out.buffer);
		const s = this.#size();
		this.#told = s;
		dv.setUint32(HDR + 8, s.width, true);
		dv.setUint32(HDR + 12, s.height, true);
		dv.setUint32(HDR + 16, 1, true); // enabled
		return out;
	}

	#setScanout(s: { res: Resource; rect: Rect } | null): void {
		const was = this.#scanout;
		this.#scanout = s;
		if (this.#scanout3d) {
			this.#scanout3d = null;
			if (!s) this.#display.setScanout(null);
		}
		if (!s) {
			if (was) this.#display.setScanout(null);
			return;
		}
		const { res, rect } = s;
		// The same picture again (a commit that set the scanout without a change): nothing to tell.
		if (was?.res === res && was.rect.x === rect.x && was.rect.y === rect.y && was.rect.width === rect.width && was.rect.height === rect.height) return;
		const stride = res.width * 4;
		const start = rect.y * stride + rect.x * 4;
		this.#display.setScanout({
			mode: { width: rect.width, height: rect.height, stride, format: FOURCC_XRGB8888 },
			pixels: () => res.host!.subarray(start),
		});
	}

	/** A backend's resource on the scanout: the display gets its mode and no pixels (the renderer presents it). */
	#setScanout3d(s: { id: number; rect: Rect }): void {
		const was = this.#scanout3d;
		this.#scanout = null;
		this.#scanout3d = s;
		if (was?.id === s.id && was.rect.x === s.rect.x && was.rect.y === s.rect.y && was.rect.width === s.rect.width && was.rect.height === s.rect.height) return;
		this.#display.setScanout({
			mode: { width: s.rect.width, height: s.rect.height, stride: s.rect.width * 4, format: FOURCC_XRGB8888 },
			pixels: () => null,
		});
	}

	/**
	 * TRANSFER_TO_HOST_2D: the rectangle's rows from the backing (row h at
	 * `offset + h * stride`, stride = width * 4) into the host copy.
	 */
	#transfer(res: Resource, r: Rect, offset: number): void {
		const host = res.host!, back = res.backing;
		if (!back?.length) return;
		const mem = new Uint8Array(this.#memory().buffer);
		const stride = res.width * 4, row = r.width * 4;
		const order = FORMATS[res.format]!;
		const direct = order[0] === 0 && order[1] === 1 && order[2] === 2;
		const tmp = direct ? null : new Uint8Array(row);
		for (let h = 0; h < r.height; h++) {
			const dst = (r.y + h) * stride + r.x * 4;
			if (direct) this.#gather(res, mem, offset + h * stride, host, dst, row);
			else {
				this.#gather(res, mem, offset + h * stride, tmp!, 0, row);
				for (let i = 0; i < row; i += 4) {
					host[dst + i] = tmp![i + order[0]]!;
					host[dst + i + 1] = tmp![i + order[1]]!;
					host[dst + i + 2] = tmp![i + order[2]]!;
					host[dst + i + 3] = 0xff;
				}
			}
		}
		this.stats.transferBytes += row * r.height;
	}

	/** Copy `n` bytes at offset `off` of the backing into `dst` (bytes past the backing stay as they are). */
	#gather(res: Resource, mem: Uint8Array, off: number, dst: Uint8Array, at: number, n: number): void {
		const back = res.backing!, starts = res.starts;
		// The last entry that starts at or before off.
		let lo = 0, hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid]! <= off) lo = mid;
			else hi = mid - 1;
		}
		for (let i = lo; n > 0 && i < back.length; i++) {
			const b = back[i]!, skip = off - starts[i]!;
			if (skip >= b.len) continue;
			const k = Math.min(n, b.len - skip);
			dst.set(mem.subarray(b.addr + skip, b.addr + skip + k), at);
			at += k;
			off += k;
			n -= k;
		}
	}
}

/** A response of `size` bytes with only the type set. */
function resp(type: number, size = HDR): Uint8Array {
	const b = new Uint8Array(size);
	new DataView(b.buffer).setUint32(0, type, true);
	return b;
}

/** CVT-RB vertical blanking lines of a mode `h` lines high at 60 Hz (makeEdid()). */
const cvtVblank = (h: number) => Math.max(15, Math.ceil((460e-6 * 60 * (h + 3)) / (1 - 460e-6 * 60)));
/** makeEdid()'s pixel clock in 10 kHz units: (w + 160) x (h + vblank) at 60 Hz. */
const edidClock = (w: number, h: number) => Math.round(((w + 160) * (h + cvtVblank(h)) * 60) / 10000);

/**
 * The size the device offers for a wanted one (GET_DISPLAY_INFO and
 * GET_EDID agree): whole pixels, 64 to 4095 a side (an EDID detailed timing
 * has 12 bits per side and Linux ignores one under 64), and shrunk with
 * its aspect kept until its 60 Hz pixel clock fits the EDID's 16 bits
 * (655.35 MHz: about 3840x2400). Odd sizes stay as they are: the mode
 * comes from the EDID, not from drm_cvt_mode(), which would round the
 * width down to a multiple of 8.
 */
export function fitGpuSize(s: DisplaySize): DisplaySize {
	let w = Math.round(s.width) || 640, h = Math.round(s.height) || 480;
	if (w > 4095 || h > 4095) {
		const k = Math.min(4095 / w, 4095 / h);
		w = Math.min(4095, Math.round(w * k));
		h = Math.min(4095, Math.round(h * k));
	}
	w = Math.max(64, w);
	h = Math.max(64, h);
	while (edidClock(w, h) > 0xffff) {
		w = Math.max(64, Math.floor(w * 0.99));
		h = Math.max(64, Math.floor(h * 0.99));
	}
	return { width: w, height: h, dpi: s.dpi };
}

/**
 * An EDID 1.4 base block for one mode at 60 Hz (CVT reduced blanking
 * timings), with the physical size from `dpi` when known, named
 * "unkernel". The size must fit (fitGpuSize()).
 */
export function makeEdid(s: DisplaySize): Uint8Array {
	const e = new Uint8Array(128);
	e.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
	// Manufacturer "UNK" (5 bits per letter), product 1, serial 0, week 1 of 2026.
	const id = ((21 << 10) | (14 << 5) | 11);
	e[8] = id >> 8;
	e[9] = id & 0xff;
	e[10] = 1;
	e[16] = 1;
	e[17] = 2026 - 1990;
	e[18] = 1;
	e[19] = 4;
	e[20] = 0xa5; // digital, 8 bits per colour, DisplayPort
	const w = Math.min(4095, s.width), h = Math.min(4095, s.height);
	const mmW = s.dpi ? Math.round((s.width * 25.4) / s.dpi) : 0, mmH = s.dpi ? Math.round((s.height * 25.4) / s.dpi) : 0;
	e[21] = Math.min(255, Math.round(mmW / 10));
	e[22] = Math.min(255, Math.round(mmH / 10));
	e[23] = 120; // gamma 2.2
	e[24] = 0x06; // RGB 4:4:4, sRGB default, preferred timing first
	// sRGB chromaticity.
	e.set([0xee, 0x91, 0xa3, 0x54, 0x4c, 0x99, 0x26, 0x0f, 0x50, 0x54], 25);
	for (let i = 38; i < 54; i++) e[i] = 1; // no standard timings
	// Detailed timing: CVT-RB blanking.
	const hb = 160, hfp = 48, hs = 32, vfp = 3, vs = 6;
	const vb = cvtVblank(h);
	const clock = Math.min(0xffff, edidClock(w, h));
	const d = 54;
	e[d] = clock & 0xff;
	e[d + 1] = clock >> 8;
	e[d + 2] = w & 0xff;
	e[d + 3] = hb & 0xff;
	e[d + 4] = ((w >> 8) << 4) | (hb >> 8);
	e[d + 5] = h & 0xff;
	e[d + 6] = vb & 0xff;
	e[d + 7] = ((h >> 8) << 4) | (vb >> 8);
	e[d + 8] = hfp;
	e[d + 9] = hs;
	e[d + 10] = (vfp << 4) | vs;
	e[d + 11] = 0;
	const dw = Math.min(4095, mmW), dh = Math.min(4095, mmH);
	e[d + 12] = dw & 0xff;
	e[d + 13] = dh & 0xff;
	e[d + 14] = ((dw >> 8) << 4) | (dh >> 8);
	e[d + 17] = 0x1a; // digital separate sync, +hsync, -vsync
	// Monitor name.
	const n = 72;
	e.set([0, 0, 0, 0xfc, 0], n);
	const name = "unkernel\n   ";
	for (let i = 0; i < 13; i++) e[n + 5 + i] = name.charCodeAt(i);
	// Two dummy descriptors.
	e.set([0, 0, 0, 0x10, 0], 90);
	e.set([0, 0, 0, 0x10, 0], 108);
	let sum = 0;
	for (let i = 0; i < 127; i++) sum += e[i]!;
	e[127] = (256 - (sum & 0xff)) & 0xff;
	return e;
}
