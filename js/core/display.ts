// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The host side of kwfb (drivers/video/fbdev/kwfb.c): an optional display.
//
// The kernel asks wasm_driver_fb_init() once at boot; < 0 means no display
// and no /dev/fb0. With one, the guest's framebuffer memory exists only while
// some program has /dev/fb0 open. At the first open the kernel asks
// wasm_driver_fb_mode() for the size wanted (`size`, read then), fits it to
// its limits (64..4096 per side, at most 1M pixels: a larger size is divided
// by the smallest integer that fits) and calls wasm_driver_fb_attach() with
// the address of the pixels in its memory (direct-mapped, so one linear range
// of `stride * height` bytes) and the mode it chose. It calls it again on
// every change: a program setting another size (FBIOPUT_VSCREENINFO), and
// with 0 when the last user closes the device. A size change of the host's
// window while the device is open does not change the mode: scale the
// picture. The host reads the pixels in place, whenever it runs: the kernel
// is suspended then (idle, its 20 ms yields, task switches), and memory is
// not shared with other threads, so nothing else writes it meanwhile. There
// is no flush or vsync; a frame read while a program is mid-draw is torn.
// Neither import suspends.
//
// Another source may take the display over (setScanout): the virtio-gpu
// scanout (virtio-gpu.ts), while a KMS client has a framebuffer on it. The
// display then shows that picture (mode, pixels(), readRGBA()), and kwfb's
// again when the scanout goes; both devices stay registered. The size
// wanted (wantedSize()) is the same for both. virtio-gpu tells a running
// guest when it changes (KernelInstance.updateDisplaySize(): a hotplug);
// kwfb takes it at the next first open.

/** DRM fourcc of XRGB8888 ("XR24"): 32-bit pixels, little endian B, G, R, X. */
export const FOURCC_XRGB8888 = 0x34325258;
const ENODEV = 19;

export interface DisplayMode {
	width: number;
	height: number;
	/** Bytes per row. */
	stride: number;
	/** DRM fourcc; only FOURCC_XRGB8888 so far. */
	format: number;
}

/** A picture that takes the display over from kwfb (DisplayHost.setScanout). */
export interface DisplaySource {
	mode: DisplayMode;
	/**
	 * `mode.height` rows of `mode.stride` bytes (the last may be just
	 * `width * 4`), XRGB8888; read at once. Null for a picture that is not
	 * in this thread's memory: a virtio-gpu 3D resource, a GL texture where
	 * the renderer runs (GlHost presents it; KernelHandle.frame() reads it
	 * back there).
	 */
	pixels(): Uint8Array | null;
}

/** A copy of the frame, RGBA (the layout of canvas ImageData). */
export interface DisplayFrame {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

/** A display size in pixels. */
export interface DisplaySize {
	width: number;
	height: number;
	/**
	 * Pixels per inch of this size on the host's screen (a browser's CSS
	 * pixels: 96). With it the guest learns the physical size of its picture
	 * (fb_var_screeninfo width and height, in mm), scaled to fit this area
	 * when the mode differs from it. Default: unknown.
	 */
	dpi?: number;
}

/**
 * The display option: false (none), true (640x480), a size, or a function
 * that returns the size wanted each time a program first opens /dev/fb0.
 */
export type DisplayOption = boolean | DisplaySize | (() => DisplaySize);

export const DEFAULT_DISPLAY_SIZE: DisplaySize = { width: 640, height: 480 };

export interface DisplayHostOptions {
	/** Offer a display to the kernel, and the size wanted. Default false: no /dev/fb0. */
	enabled?: DisplayOption;
	/** The kernel's memory, read at call time. */
	memory: () => WebAssembly.Memory;
	/** A program opened the display (mode), or the last one closed it (null). */
	onChange?: (mode: DisplayMode | null) => void;
	log?: (msg: string) => void;
}

/** What a machine snapshot keeps of the display (DisplayHost.saveState()). */
export interface DisplaySnapshot {
	/** Address of the pixels in kernel memory, 0 while detached. */
	addr: number;
	mode: DisplayMode | null;
	/** The size last offered to the kernel (for the physical size). */
	offered: DisplaySize | null;
}

export interface DisplayStats {
	/** wasm_driver_fb_attach() calls with pixels. */
	attaches: number;
	/** ... and without (the last close). */
	detaches: number;
}

export class DisplayHost {
	readonly enabled: boolean;
	#size: DisplayOption;
	/** The size last offered to the kernel (wasm_driver_fb_mode). */
	#offered: DisplaySize | null = null;
	/** Address of kwfb's pixels in kernel memory; 0 while nothing has /dev/fb0 open. */
	addr = 0;
	/** kwfb's mode while attached, else null. */
	#fbMode: DisplayMode | null = null;
	/** A source that has the display instead of kwfb (virtio-gpu), or null. */
	#source: DisplaySource | null = null;
	/** Did the kernel ask (wasm_driver_fb_init)? False for a kernel without kwfb. */
	probed = false;
	stats: DisplayStats = { attaches: 0, detaches: 0 };
	#memory: () => WebAssembly.Memory;
	#onChange: ((mode: DisplayMode | null) => void) | undefined;
	#log: (msg: string) => void;

	constructor(opts: DisplayHostOptions) {
		this.enabled = !!opts.enabled;
		this.#size = opts.enabled ?? false;
		this.#memory = opts.memory;
		this.#onChange = opts.onChange;
		this.#log = opts.log ?? (() => {});
	}

	/** The size in mm at which the host shows @mode: fitted into the offered area, aspect kept. */
	#physical(mode: DisplayMode): number {
		const o = this.#offered;
		if (!o?.dpi || !(o.dpi > 0) || !mode.width || !mode.height) return 0;
		const scale = Math.min(o.width / mode.width, o.height / mode.height);
		const mm = (px: number) => Math.min(0xffff, Math.max(1, Math.round((px * scale * 25.4) / o.dpi!)));
		return ((mm(mode.width) << 16) | mm(mode.height)) >>> 0;
	}

	/** The mode of what the display shows (the scanout's, else kwfb's while attached), else null. */
	get mode(): DisplayMode | null {
		return this.#source?.mode ?? this.#fbMode;
	}

	/** The size the host wants now (the option, or its function's answer; default 640x480). */
	wantedSize(): DisplaySize {
		let s = DEFAULT_DISPLAY_SIZE;
		try {
			const o = this.#size;
			if (typeof o === "function") s = o();
			else if (typeof o === "object") s = o;
		} catch (e) {
			this.#log(`[display] size callback failed: ${e}`);
		}
		return s;
	}

	/** Replace the size wanted (the option's size or function) from now on; ignored without a display. */
	setSize(size: DisplaySize | (() => DisplaySize)): void {
		if (this.enabled) this.#size = size;
	}

	/**
	 * Let another source have the display (virtio-gpu's scanout), or give
	 * it back to kwfb (null). onChange hears the mode that is shown now.
	 */
	setScanout(src: DisplaySource | null): void {
		if (!src && !this.#source) return;
		this.#source = src;
		if (src) this.stats.attaches++;
		else this.stats.detaches++;
		try { this.#onChange?.(this.mode); } catch {}
	}

	imports(): Record<string, unknown> {
		return {
			wasm_driver_fb_init: (): bigint => {
				this.probed = true;
				return this.enabled ? 0n : -BigInt(ENODEV);
			},
			// The size wanted at first open: width << 16 | height (the kernel fits it).
			wasm_driver_fb_mode: (): number => {
				const s = this.wantedSize();
				this.#offered = s;
				const w = Math.min(0xffff, Math.max(1, Math.round(s.width) || DEFAULT_DISPLAY_SIZE.width));
				const h = Math.min(0xffff, Math.max(1, Math.round(s.height) || DEFAULT_DISPLAY_SIZE.height));
				return ((w << 16) | h) >>> 0;
			},
			// Returns the picture's physical size, width_mm << 16 | height_mm (0: unknown).
			wasm_driver_fb_attach: (pixels: bigint, width: number, height: number, stride: number, format: number): number => {
				const addr = Number(pixels);
				if (addr) {
					const mode = { width: width >>> 0, height: height >>> 0, stride: stride >>> 0, format: format >>> 0 };
					if (mode.format !== FOURCC_XRGB8888 || mode.stride < mode.width * 4 || addr % 4 ||
						addr + mode.stride * mode.height > this.#memory().buffer.byteLength) {
						this.#log(`[display] unusable framebuffer at 0x${addr.toString(16)}: ${JSON.stringify(mode)}`);
						return 0;
					}
					this.addr = addr;
					this.#fbMode = mode;
					this.stats.attaches++;
				} else {
					this.addr = 0;
					this.#fbMode = null;
					this.stats.detaches++;
				}
				// While a scanout has the display, kwfb changes nothing that is shown.
				if (!this.#source) try { this.#onChange?.(this.mode); } catch {}
				return this.#fbMode ? this.#physical(this.#fbMode) : 0;
			},
		};
	}

	/** The state a snapshot keeps (the pixels are in the kernel's memory). */
	saveState(): DisplaySnapshot {
		const o = this.#offered;
		const m = this.#fbMode;
		return { addr: this.addr, mode: m && { ...m }, offered: o && { width: o.width, height: o.height, dpi: o.dpi } };
	}

	/**
	 * A restored snapshot: the kernel does not ask init or attach again, so
	 * take the saved attachment and tell onChange, as an attach would.
	 */
	restoreState(s: DisplaySnapshot): void {
		this.probed = true;
		this.#offered = s.offered;
		this.addr = s.mode ? s.addr : 0;
		this.#fbMode = s.mode && this.addr ? { ...s.mode } : null;
		if (this.#fbMode) try { this.#onChange?.(this.#fbMode); } catch {}
	}

	/**
	 * The pixels shown, in place (no copy): `mode.height` rows of
	 * `mode.stride` bytes, XRGB8888 (kwfb's in the guest's memory, or the
	 * scanout's host copy). Null while nothing is shown. Valid only until
	 * the kernel runs again (the program may close the device and the
	 * kernel reuse the memory), so read it at once and do not keep it.
	 */
	pixels(): Uint8Array | null {
		if (this.#source) return this.#source.pixels();
		const m = this.#fbMode;
		if (!m || !this.addr) return null;
		return new Uint8Array(this.#memory().buffer, this.addr, m.stride * m.height);
	}

	/**
	 * Copy the current frame as RGBA (alpha 255), e.g. for
	 * `new ImageData(frame.data, frame.width)`. `out` is reused when it has
	 * the right size. Null while detached.
	 */
	readRGBA(out?: Uint8ClampedArray): DisplayFrame | null {
		const m = this.mode;
		const px = this.pixels();
		if (!m || !px) return null;
		const { width, height, stride } = m;
		const data = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4);
		const dst = new Uint32Array(data.buffer, data.byteOffset, width * height);
		// Typed arrays use the platform byte order, which is little endian on
		// every engine that runs this kernel: XRGB8888 reads as 0xXXRRGGBB,
		// RGBA is written as 0xAABBGGRR. Rows start 4-byte aligned (kwfb's
		// address and the host copy's offsets are multiples of 4).
		for (let y = 0; y < height; y++) {
			const src = new Uint32Array(px.buffer, px.byteOffset + y * stride, width);
			const o = y * width;
			for (let x = 0; x < width; x++) {
				const p = src[x]!;
				dst[o + x] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
			}
		}
		return { width, height, data };
	}
}

/**
 * Convert packed XRGB8888 rows (`width * 4` bytes each, as worker mode
 * sends frames) to RGBA with alpha 255. `out` is reused when it has the
 * right size.
 */
export function xrgbToRgba(src: Uint8Array, width: number, height: number, out?: Uint8ClampedArray): Uint8ClampedArray {
	const n = width * height;
	const data = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
	const dst = new Uint32Array(data.buffer, data.byteOffset, n);
	// Little endian, as in readRGBA(): 0xXXRRGGBB in, 0xAABBGGRR out.
	const s = new Uint32Array(src.buffer, src.byteOffset, n);
	for (let i = 0; i < n; i++) {
		const p = s[i]!;
		dst[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
	}
	return data;
}

/** A frame as a binary PPM (P6) image. */
export function frameToPpm(frame: DisplayFrame): Uint8Array {
	const header = new TextEncoder().encode(`P6\n${frame.width} ${frame.height}\n255\n`);
	const n = frame.width * frame.height;
	const out = new Uint8Array(header.length + n * 3);
	out.set(header);
	for (let i = 0, o = header.length; i < n; i++, o += 3) {
		out[o] = frame.data[i * 4]!;
		out[o + 1] = frame.data[i * 4 + 1]!;
		out[o + 2] = frame.data[i * 4 + 2]!;
	}
	return out;
}
