// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Wayland apps in the guest as windows on the page: wland
// (https://github.com/pithings/wland), its compositor (wasm) on this
// thread, in the desktop view (components/Desktop.tsx). The guest runs
// wland's relay (/usr/lib/kw/wlandr, in the Debian image: started at boot
// where the command line has kw.wayland=1, which boot.ts adds with kwshm,
// else by `wland CMD`): apps speak Wayland to it over its unix socket, and
// it connects to the page over vsock port WAYLAND_PORT when the first app
// connects (--link-on-demand; a relay without it dials at once); the apps'
// buffers stay in guest memory, exported through /dev/kwshm, and the
// compositor reads them in place with vm.shm (createKernel({ shm }), boot.ts).
// - attachWayland(vm) (boot.ts, once the kernel runs; the kernel needs vsock
//   and kwshm) listens on the port. The first connection loads wland (a
//   chunk of its own, with its wasm: a page that never runs a Wayland app
//   fetches neither) and mounts it in the desktop's container; the relay's
//   next connection after a drop (a reload, a resume, the relay killed: it
//   dials again at its next app) goes to the same wland, which starts a
//   fresh compositor. The relay counts a completed connect as the
//   compositor attached, and the SDK's listener completes every connect, so
//   a connection is only taken when wland will serve it: one at a time (a
//   second relay's is reset, so its apps fail at once instead of waiting),
//   none once wland failed to load (the listener closes: dials are refused).
//   A connection gone before wland took it (a dial that timed out while
//   wland loaded) is skipped. The link stays up after the last window
//   closes (wland stays loaded; nothing to free but the compositor's state,
//   and closing would race an app that connects meanwhile). Its result
//   stops it all (at the kernel's exit).
// - Buffers (handleSource()): opening a buffer is a round trip (openId()).
//   Wherever this thread sees the kernel's memory (ShmFile.inPlace: inline,
//   and worker mode on an SMP kernel with the shared transport) wland takes
//   the export's page runs in place (view: ShmFile.views(), no copy of
//   ours; it presents a single run as is and gathers the damaged spans of
//   several); else it reads every damaged span of a commit in one call
//   (readv), each span a round trip to the kernel's worker (ShmFile.read():
//   with the shared transport served at the kernel's next clock read, about
//   0.6 ms, without it at the kernel's next yield), all posted together.
//   A token stays bound to its export: once the guest releases it, reads
//   fail and the commit is skipped; nothing ever resolves an id again.
// - GPU apps (gpuSource()): with guest GL's virtio-gpu device and its
//   renderer on this thread (vm.gl.gpu) the relay runs with --dmabuf
//   virtgpu (the guest's wland script, where /dev/dri/renderD128 exists)
//   and names each GL client's buffer by its virtio-gpu resource; wland
//   asks us for the resource's picture at each commit, which the renderer
//   blits into an ImageBitmap (vm.gl.gpu.image(): no readback, the pixels
//   never leave the WebGL2 context's GPU memory until the 2D canvas draws
//   them). Without vm.gl.gpu (GL off, ?gpu=0, no WebGL2) or with ?wlgpu=0
//   wland offers no linux-dmabuf, and GL apps render in software (llvmpipe)
//   into wl_shm buffers like any other app.
// - The view: the store's desktop state. attached while the relay is
//   connected (the status line's desktop icon, #bar-desktop, shows then);
//   shown when the first window maps and hidden when the last one goes (or
//   by hand: the icon, Ctrl-A w; a terminal window or the display picked
//   hides it). wland owns the container's children and does its own input:
//   a click focuses a window, whose keys then go to a hidden editable sink
//   of wland's (display.ts and the terminals leave editable targets alone).
import { KW } from "./kw.ts";
import { ui$, type DesktopWindow } from "./store.ts";
import type { KernelHandle, ShmFile, VsockConnection, VsockListener } from "./sdk.ts";
import type { BufferHandle, GpuRef, GpuSource, HandleRead, HandleSource } from "wland/engine";
import type { Wland } from "wland/client";

/** The host port wland's relay connects to (wlandr --link vsock:2:1023). */
export const WAYLAND_PORT = 1023;

let container: HTMLElement | null = null;
let current: Wland | null = null;
let windowsSeen = 0;
/**
 * What the compositor did with the guest's buffers (KW.wayland.stats()):
 * handles opened, reads (a view, a readv or a read: one per commit, or one
 * per span with wland 0.1.0), how many of them in place (synchronous; views
 * among them) and the bytes they covered, the time reads took (a round trip
 * each unless in place), commits that latched new pixels (shm and GPU
 * alike); GPU commits (gpuCommits), the images the renderer made for them
 * (gpuImages; the rest were null: unknown resource, an offset, no
 * renderer), how many waited for the renderer to load (gpuWaits), the
 * time image() took (total, longest) and the time from resolve() to
 * release() of each image (gpuDrawMs: image() and wland drawing it into the
 * window's canvas, where a GPU-backed image's work is waited for).
 */
const stats = {
	opens: 0, reads: 0, inPlace: 0, views: 0, bytes: 0, readMs: 0, readMaxMs: 0, commits: 0,
	gpuCommits: 0, gpuImages: 0, gpuWaits: 0, gpuMs: 0, gpuMaxMs: 0, gpuDrawMs: 0,
};
type Stats = typeof stats;
const timed = (t: number, total: "readMs" | "gpuMs", max: "readMaxMs" | "gpuMaxMs") => {
	const ms = performance.now() - t;
	stats[total] += ms;
	if (ms > stats[max]) stats[max] = ms;
};
/** The last GPU buffer a commit named (KW.wayland.gpuLast(), for the tests). */
let gpuLast: GpuRef | null = null;
/** DRM fourccs of the formats without alpha that the relay offers: XR24 (XRGB8888), XB24 (XBGR8888). */
const XRGB8888 = 0x34325258, XBGR8888 = 0x34324258;
/** wland's wire-level log (every decoded Wayland message), the last LOG_LINES, for KW.wayland.log(). */
const LOG_LINES = 500;
const wireLog: string[] = [];
let wireAt = 0;
/** The popups mapped now (menus, tooltips), "conn:surface", for KW.wayland.popups(). */
const popups = new Set<string>();
/** wland's Role for xdg_popup (engine.ts). */
const ROLE_POPUP = 4;

/** components/Desktop.tsx: the element wland mounts windows into (null when unmounted). */
export function setDesktopContainer(el: HTMLElement | null): void {
	container = el;
}

/**
 * Show the desktop, or what is under it. Hiding it gives the terminal the
 * keyboard when a window had it (not on touch devices, where that raises
 * the on-screen keyboard); Desktop.tsx focuses the top window once the
 * layer is shown (focusDesktop(): before that the layer is inert).
 */
export function setDesktopShown(shown: boolean): void {
	const $ = ui$();
	const d = $.get().desktop;
	if (d.shown === shown) return;
	$.set({ desktop: { ...d, shown } });
	if (!shown && container?.contains(document.activeElement)) {
		(document.activeElement as HTMLElement).blur();
		if (!KW.config.coarse) KW.term?.focus();
	}
}

/** Desktop.tsx, once the layer is shown: the top window (not minimized) takes the keyboard. */
export function focusDesktop(): void {
	current?.windows().filter((w) => !w.minimized).at(-1)?.raise();
}

function checkHandle(h: BufferHandle): asserts h is Extract<BufferHandle, { kind: "kwshm" }> {
	if (h.kind !== "kwshm") throw new Error(`a ${h.kind} buffer handle: the relay must run with --buffers kwshm`);
}

/** The compositor's access to the guest's buffers: vm.shm (see the top). */
function handleSource(vm: KernelHandle): HandleSource<ShmFile> {
	const shm = vm.shm!;
	const open = async (h: BufferHandle) => {
		checkHandle(h);
		const f = await shm.openId(h.id);
		if (f.size !== h.size) {
			void f.close();
			throw new Error(`kwshm export ${h.id}: ${f.size} bytes, the relay says ${h.size}`);
		}
		stats.opens++;
		return f;
	};
	const close = (f: ShmFile) => { void f.close(); }; // a guest export: ends this handle only
	const counted = (t: number, n: number, inPlace: boolean) => {
		stats.reads++;
		if (inPlace) stats.inPlace++;
		stats.bytes += n;
		timed(t, "readMs", "readMaxMs");
	};
	/** EAGAIN from readSync()/views(): the page list is being replaced or withdrawn; read() says which. */
	const again = (e: unknown) => (e as { code?: string }).code === "EAGAIN";
	/** In place, no copy: the export's page runs (null declines: wland then reads). */
	const view = (f: ShmFile, offset: number, length: number): Uint8Array[] | null => {
		if (!f.inPlace) return null;
		const t = performance.now();
		try {
			const v = f.views(offset, length);
			stats.views++;
			counted(t, length, true);
			return v;
		} catch (e) {
			if (again(e)) return null;
			throw e;
		}
	};
	/** Every damaged span of a commit: copies in place, else one read() each, posted together. */
	const readv = (f: ShmFile, reads: readonly HandleRead[]): void | Promise<void> => {
		const t = performance.now();
		let n = 0;
		for (const r of reads) n += r.dst.length;
		if (f.inPlace) {
			try {
				for (const r of reads) f.readSync(r.offset, r.dst.length, r.dst);
				counted(t, n, true);
				return;
			} catch (e) {
				if (!again(e)) throw e;
			}
		}
		return Promise.all(reads.map(async (r) => { r.dst.set(await f.read(r.offset, r.dst.length)); }))
			.then(() => counted(t, n, false));
	};
	/** One span (what wland 0.1.0 calls; a later one uses view, else readv). */
	const read = (f: ShmFile, offset: number, dst: Uint8Array): void | Promise<void> => readv(f, [{ offset, dst }]);
	return { open, close, view, readv, read };
}

/**
 * GPU apps' buffers by resource (see the top): the resource's picture now,
 * as an ImageBitmap of the renderer's (a promise only while the renderer
 * loads), which wland draws during the commit and then closes. Row 0 at the
 * top (y_invert flips), alpha premultiplied as the client rendered it, X
 * formats opaque. A plane offset is not supported (Mesa's virgl gives 0):
 * null, so the window keeps its last content.
 */
function gpuSource(gpu: NonNullable<NonNullable<KernelHandle["gl"]>["gpu"]>, log: (line: string) => void): GpuSource<ImageBitmap> {
	let offsetSaid = false;
	const started = new WeakMap<ImageBitmap, number>();
	const done = (t: number, img: ImageBitmap | null) => {
		if (img) {
			stats.gpuImages++;
			started.set(img, t);
		}
		timed(t, "gpuMs", "gpuMaxMs");
		return img;
	};
	return {
		resolve(ref: GpuRef) {
			stats.gpuCommits++;
			gpuLast = ref;
			if (ref.offset !== 0) {
				if (!offsetSaid) log(`[host] wayland: a GPU buffer at offset ${ref.offset} of resource ${ref.resource}: not supported, not shown`);
				offsetSaid = true;
				return null;
			}
			const t = performance.now();
			const r = gpu.image(ref.resource, {
				width: ref.width,
				height: ref.height,
				opaque: ref.format === XRGB8888 || ref.format === XBGR8888,
				flipY: (ref.flags & 1) !== 0,
			});
			if (!(r instanceof Promise)) return done(t, r);
			stats.gpuWaits++;
			return r.then((img) => done(t, img));
		},
		release(img) {
			const t = started.get(img);
			if (t !== undefined) stats.gpuDrawMs += performance.now() - t;
			img.close();
		},
	};
}

function windowsChanged(): void {
	const list: DesktopWindow[] = (current?.windows() ?? []).map((w) => ({ key: w.key, title: w.title, focused: w.focused, minimized: w.minimized }));
	const $ = ui$();
	$.set((s) => ({ desktop: { ...s.desktop, windows: list } }));
	// The first window shows the desktop; the last one gone shows what was under it.
	if (list.length && !windowsSeen) setDesktopShown(true);
	else if (!list.length && windowsSeen) setDesktopShown(false);
	windowsSeen = list.length;
}

/**
 * Listen for wland's relay and show its apps (see the top). Returns the stop
 * function, or null when the kernel has no vsock or no kwshm.
 */
export function attachWayland(vm: KernelHandle, log: (line: string) => void): (() => void) | null {
	if (!vm.vsock || !vm.shm) return null;
	const listener: VsockListener = vm.vsock.listen(WAYLAND_PORT);
	let stopped = false;
	let mine: Wland | null = null;
	ui$().set((s) => ({ desktop: { ...s.desktop, available: true } }));
	// The connections wland's link takes (see the top): `pending` waits for wland to take it
	// (the first while wland loads), `idle` is wland's link asking for the next one.
	let loading = false;
	let pending: VsockConnection | null = null;
	let idle = null as ((c: VsockConnection | null) => void) | null;
	const gone = new WeakSet<VsockConnection>();
	let refusedSaid = false;
	const take = (): Promise<VsockConnection | null> => {
		const c = pending;
		pending = null;
		if (c && !gone.has(c)) return Promise.resolve(c);
		if (stopped) return Promise.resolve(null);
		return new Promise((r) => { idle = r; });
	};
	const link: AsyncIterable<VsockConnection> & { close(): void } = {
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<VsockConnection>> => {
				const c = await take();
				return c ? { value: c, done: false } : { value: undefined, done: true };
			},
		}),
		close: () => listener.close(),
	};
	const load = async (first: VsockConnection) => {
		loading = true;
		pending = first;
		const gpu = KW.config.wlGpu ? vm.gl?.gpu : undefined;
		log(`[host] wayland: the relay connected (vsock port ${WAYLAND_PORT}); loading wland${gpu ? " (GPU buffers by resource: guest GL's renderer)" : ""}`);
		const [{ createWland, createStreamLink }, { default: wasm }] = await Promise.all([import("wland/client"), import("wland/wland.wasm?url")]);
		if (stopped) return;
		if (!container) throw new Error("no desktop container");
		const wl = await createWland({
			container,
			wasm,
			link: createStreamLink(link),
			buffers: handleSource(vm),
			...(gpu ? { gpu: gpuSource(gpu, log) } : {}),
			onEvent(ev) {
				if (stopped) return;
				if (ev.type === "log") wireLog[wireAt++ % LOG_LINES] = ev.line;
				else if (ev.type === "commit") stats.commits++;
				else if (ev.type === "surface") {
					if (ev.role === ROLE_POPUP) popups.add(`${ev.conn}:${ev.surface}`);
					else popups.delete(`${ev.conn}:${ev.surface}`);
				} else if (ev.type === "destroy") popups.delete(`${ev.conn}:${ev.surface}`);
				else if (ev.type === "disconnect") { for (const k of popups) if (k.startsWith(`${ev.conn}:`)) popups.delete(k); }
				else if (ev.type === "open") {
					ui$().set((s) => ({ desktop: { ...s.desktop, attached: true } }));
					log("[host] wayland: compositor started");
				} else if (ev.type === "close") {
					popups.clear();
					ui$().set((s) => ({ desktop: { ...s.desktop, attached: false } }));
					log("[host] wayland: the relay's link closed; its apps are gone (it dials again for the next app)");
				} else if (ev.type === "error") {
					log(`[host] wayland: ${ev.detail}`);
				}
			},
			onWindowsChange: () => { if (!stopped) windowsChanged(); },
		});
		// Stopped while wland loaded: this kernel is gone, and a later one may have its own.
		if (stopped) wl.dispose();
		else current = mine = wl;
		loading = false;
	};
	void (async () => {
		for (;;) {
			const c = await listener.accept();
			if (!c || stopped) return;
			void c.closed.then(() => gone.add(c));
			if (idle) {
				// wland's link waits for the relay's next connection.
				const r = idle;
				idle = null;
				r(c);
			} else if (!mine && !loading) {
				load(c).catch((e: unknown) => {
					// Nothing will serve the relay: refuse its dials from now on (its apps fail at once).
					loading = false;
					pending = null;
					c.reset();
					listener.close();
					log(`[host] wayland: wland did not load (${(e as Error)?.message ?? e}); the relay's connections are refused`);
				});
			} else if (pending && gone.has(pending)) {
				// The relay dialed again while wland loaded for a connection it gave up on.
				pending = c;
			} else {
				// wland serves a link (or loads for one): one at a time.
				c.reset();
				if (!refusedSaid) log(`[host] wayland: a second connection on vsock port ${WAYLAND_PORT} while the relay's link is up: refused (one relay at a time)`);
				refusedSaid = true;
			}
		}
	})();
	return () => {
		if (stopped) return;
		stopped = true;
		listener.close();
		const r = idle;
		idle = null;
		r?.(null);
		pending = null;
		if (mine) {
			mine.dispose();
			if (current === mine) current = null;
			mine = null;
		}
		windowsSeen = 0;
		popups.clear();
		ui$().set((s) => ({ desktop: { ...s.desktop, available: false, attached: false, shown: false, windows: [] } }));
	};
}

/** KW.wayland, for the tests: the desktop's windows as wland lists them. */
export const waylandApi = {
	windows: () => current?.windows().map((w) => ({ key: w.key, title: w.title, focused: w.focused, maximized: w.maximized, fullscreen: w.fullscreen, minimized: w.minimized })) ?? [],
	/** wland itself (its engine, view, input, window manager), for debugging. */
	wland: () => current,
	/** The desktop's container (its window elements hold canvases). */
	container: () => container,
	loaded: () => !!current,
	/** Popups (menus) mapped now. */
	popups: () => popups.size,
	/** Their keys (wland's c<conn>s<surface>: the data-wland of their canvases). */
	popupKeys: () => [...popups].map((k) => { const [c, sf] = k.split(":"); return `c${c}s${sf}`; }),
	/** wland's last wire-level log lines (decoded Wayland messages), oldest first. */
	log: () => (wireAt <= LOG_LINES ? wireLog.slice(0, wireAt) : [...wireLog.slice(wireAt % LOG_LINES), ...wireLog.slice(0, wireAt % LOG_LINES)]),
	/** The last GPU buffer a commit named (wland's GpuRef, the modifier as a hex string), or null. */
	gpuLast: () => (gpuLast ? { ...gpuLast, modifier: `0x${gpuLast.modifier.toString(16)}` } : null),
	/** What the compositor read of the guest's buffers and what GPU commits cost (see `stats` above). */
	stats: (): Stats => ({ ...stats }),
};
