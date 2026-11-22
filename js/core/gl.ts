// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest GL: createKernel({ gl: true }). The guest's Mesa (virgl driver over
// vtest, GALLIUM_DRIVER=virpipe) renders through virglrenderer compiled to
// wasm (gl/wasm) on one WebGL2 context of this thread, by readback: no
// window system. The pieces (.agents/gl.md):
//
//   guest: GL program -> Mesa virpipe -> /tmp/.virgl_test
//          -> /usr/lib/kw/vtest-bridge (the forwarder, in the base's kw layer)
//          -> AF_VSOCK, host CID 2, port GL_PORT (1019)
//   host:  this thread's VsockHost -> StreamHost (gl-stream.ts) -> renderer
//          (Module.virgl.Renderer of virgl.mjs, gl/wasm/post.js) -> WebGL2
//
// GlHost serves vsock port 1019 and starts the guest's forwarder through
// kwtty as root (`vtest-bridge bridge --link vsock:2:1019 --daemon`, which
// exits at once when one already runs, as after a restore) right after the
// boot. The renderer (GlLoader: the module, fetched only with `gl`, and a
// WebGL2 context on an OffscreenCanvas, 1x1: every frame goes to the
// renderer's own framebuffers and back by readback) is loaded on the
// guest's first GL use: the first vtest client (an OPEN on the forwarder's
// link; LazyVtestRenderer holds its bytes meanwhile) or virtio-gpu's first
// GET_CAPSET or 3D command (gl-gpu.ts). So a guest that never runs a GL
// program costs nothing but the forwarder. `gl.eager` loads it before the
// kernel boots instead, and a failure then rejects `ready` up front. The
// forwarder reconnects every second while the link is down, so a restored
// guest finds the new host by itself. Renderer state (the clients' GL
// contexts) is not in a snapshot: a restore resets the link, which ends the
// guest's GL clients.
//
// Both modes: vsock is served on the thread that owns the VM (worker mode
// too), so GL runs there, which must have OffscreenCanvas and WebGL2 (a
// page's main thread or a worker of the caller's). Where it has not (Node),
// `gl: true` is ignored with a log line, unless `renderer` gives one.
//
// With `gpu` too (createKernel({ gl, gpu })), the same module and WebGL2
// context also serve the guest's virtio-gpu device in 3D (gl-gpu.ts): one
// renderer for both paths. The device offers virgl and its capsets'
// sizes when the driver probes, which needs no renderer (VIRGL_CAPSETS);
// before boot only a WebGL2 context is tried and dropped (probeWebGl2(): a
// few ms), so that a browser without one gets the 2D device rather than a
// 3D one that fails at first use. `gpu` without `gl`, or where there is no
// WebGL2, is the 2D device. GlHost.gpu is that side: the scanout's frames
// (drawFrame()) and resources' textures.

import { PtyError } from "./tty.ts";
import { StreamHost, type StreamHostStats, type VirglTotals, type VtestRenderer } from "./gl-stream.ts";
import { GpuRenderer, type GpuRendererCore, type GpuRendererStats, type VirglGpuApi } from "./gl-gpu.ts";
import { guestRun } from "./mounts.ts";
import type { Vsock, VsockConnection, VsockListener } from "./vsock.ts";

/** The vsock port the host's renderer listens on (the guest's forwarder connects to CID 2 there). */
export const GL_PORT = 1019;
/** The guest's forwarder (gl/bridge/vtest-bridge.c, stream link only), in the base's kw layer. */
export const GL_FORWARDER = "/usr/lib/kw/vtest-bridge";

const FORWARDER_TIMEOUT_MS = 120000;
const LINK_TIMEOUT_MS = 30000;

export interface GlOptions {
	/**
	 * The wasm renderer: the emscripten module virgl.mjs (with virgl.wasm
	 * next to it). Default: the one next to the SDK's web entry
	 * (dist/virgl.mjs, export `unkernel/virgl.mjs`).
	 */
	module?: string | URL;
	/**
	 * A vtest renderer of your own (gl/bridge/README.md, The renderer in the
	 * page) in place of the wasm module, initialized here; works on any
	 * platform.
	 */
	renderer?: VtestRenderer;
	/**
	 * Start the guest's forwarder (GL_FORWARDER) through kwtty once the
	 * renderer is up. Default true; false: start it yourself (`vtest-bridge
	 * bridge --link vsock:2:1019 --daemon`).
	 */
	forwarder?: boolean;
	/**
	 * Load the renderer (fetch and compile the module, make its WebGL2
	 * context) before the kernel boots, as the guest's first GL use would,
	 * so that a failure shows up front (`ready` rejects). Default false: on
	 * the guest's first GL use (a vtest client, or virtio-gpu's first capset
	 * or 3D command), which then waits for it; `status` and `load()` tell
	 * and start it.
	 */
	eager?: boolean;
	/**
	 * The wasm renderer answers every waiting busy wait as vtest does: once
	 * the fences submitted before it have retired, which WebGL tells only
	 * between tasks. Default false: it answers at once where that cannot
	 * make the guest read data before it is valid (gl/wasm/kw_virgl.c,
	 * busy_wait), which saves most of that wait in each frame. With
	 * `gpu`, likewise for virtio-gpu's fences: each fenced command is
	 * answered once its GPU work is done (QEMU's answer), instead of at once
	 * or, after a presented frame, once that frame is done (gl-gpu.ts,
	 * GpuRenderer). For comparison.
	 */
	strictWaits?: boolean;
}

/** createKernel's `gl`: true, or options. */
export type GlOption = boolean | GlOptions;

/**
 * KernelHandle.gl.stats: bridges and clients, the renderer's counters
 * (`renderer`, VirglTotals, once it is loaded; virtio-gpu's commands count
 * there too) and, with `gpu`, the virtio-gpu side's (`gpu`).
 */
export interface GlStats extends StreamHostStats {
	gpu?: GpuRendererStats;
}

export type { VirglTotals };

/** Where the renderer is (KernelHandle.gl.status). */
export interface GlRendererStatus {
	/**
	 * "idle": not loaded yet, it loads on the guest's first GL use; "loading";
	 * "ready"; "failed": it cannot be had (`error` says why), and the guest's
	 * GL programs get no renderer (with virtio-gpu, Mesa falls back to
	 * software rendering).
	 */
	state: "idle" | "loading" | "ready" | "failed";
	/** Loaded before the kernel booted (gl.eager), not on first use. */
	eager: boolean;
	/** performance.now() when the load started, or null. */
	startedAt: number | null;
	/** How long the load took (the module's fetch and compile, the WebGL2 context, the renderer's start), in ms, or null. */
	loadMs: number | null;
	/** Why it failed, or null. */
	error: string | null;
	/** Once ready: the renderer ("virglrenderer (wasm) on WebGL 2.0 ...") and the WebGL2 implementation (WEBGL_debug_renderer_info). */
	what: string | null;
	webgl: string | null;
}

/** The host side of guest GL (KernelHandle.gl). */
export class GlHost {
	/**
	 * Resolves with the renderer's description once guest GL programs can
	 * run: the host listens and (unless `forwarder: false`) the guest's
	 * forwarder is linked and has made its vtest socket. With the default
	 * lazy loading the renderer itself is not loaded then (`status`,
	 * `loaded`); with `eager` it is, and its description is in the string.
	 * Rejects if that cannot happen (also logged).
	 */
	readonly ready: Promise<string>;
	/**
	 * Settles once the renderer is loaded ("<renderer>; <WebGL2
	 * implementation>"), on the guest's first GL use, or at once with
	 * `eager` or load(); rejects if it cannot be (logged). Never settles
	 * while the guest uses no GL.
	 */
	readonly loaded: Promise<string>;
	#vsock: Vsock | undefined;
	#gpu: GpuRenderer | undefined;
	#loader: GlLoader | undefined;
	#custom: VtestRenderer | undefined;
	#log: (msg: string) => void;
	#host: StreamHost | undefined;
	#listener: VsockListener | undefined;
	#conns = new Set<VsockConnection>();
	#down = false;
	#linked!: () => void;

	/** @internal Use createKernel({ gl }). */
	constructor(vsock: Vsock | undefined, prep: GlPrep, log: (msg: string) => void) {
		this.#vsock = vsock;
		this.#gpu = prep.gpu;
		this.#loader = prep.loader;
		this.#custom = prep.opts.renderer;
		this.#log = log;
		this.loaded = this.#loader ? this.#loader.loaded.then((c) => describe(c)) : this.#custom ? Promise.resolve("custom renderer") : Promise.reject(new Error("no renderer"));
		this.loaded.catch(() => {});
		this.ready = this.#start(prep.opts);
		this.ready.catch((e) => log(`[host] gl: ${(e as Error)?.message ?? e}; the guest gets no GL renderer`));
	}

	/** Bridges and clients being served, the renderer's counters, and virtio-gpu's (with `gpu`). */
	get stats(): GlStats {
		const s: GlStats = this.#host?.stats ?? { streams: 0, clients: 0, opened: 0 };
		return this.#gpu ? { ...s, gpu: { ...this.#gpu.stats } } : s;
	}

	/** Where the wasm renderer is: not loaded yet, loading, ready (with how long the load took), failed. */
	get status(): GlRendererStatus {
		if (this.#loader) return { ...this.#loader.status };
		return { state: "ready", eager: true, startedAt: null, loadMs: null, error: null, what: "custom renderer (gl.renderer)", webgl: null };
	}

	/** Load the renderer now, as the guest's first GL use would (nothing if it is loaded or loading); resolves as `loaded`. */
	load(): Promise<string> {
		this.#loader?.load().catch(() => {});
		return this.loaded;
	}

	/**
	 * With `gpu`: virtio-gpu's renderer side (gl-gpu.ts), on this thread:
	 * `scanout`, `drawFrame(ctx)` (the scanout's latest frame into a 2D
	 * canvas, no readback), `frame()` (a readback, for screenshots),
	 * `texture(resourceId)` (a guest resource's WebGLTexture), `stats`,
	 * `onFrame`. Undefined without `gpu` or without WebGL2 (the 2D device).
	 */
	get gpu(): GpuRenderer | undefined {
		return this.#gpu;
	}

	async #start(opts: GlOptions): Promise<string> {
		const loader = this.#loader;
		if (loader?.status.state === "failed") throw new Error(loader.status.error ?? "no renderer");
		// Eager: up now, or the reason it is not (the loader may have started before the kernel booted).
		const core = loader && (opts.eager ? await loader.load() : null);
		if (!this.#vsock) {
			// virtio-gpu alone (no vsock: no vtest link).
			return core ? `${describe(core)}; virtio-gpu only` : "virglrenderer (wasm), loaded on first use; virtio-gpu only";
		}
		let renderer: VtestRenderer;
		let what: string;
		if (this.#custom) {
			renderer = this.#custom;
			what = await renderer.init();
		} else {
			renderer = new LazyVtestRenderer(loader!, opts.strictWaits ?? false);
			what = core ? describe(core) : "virglrenderer (wasm), loaded on the guest's first GL use";
			await renderer.init();
		}
		if (this.#gpu) what += "; virtio-gpu 3D";
		if (this.#down) throw new Error("the kernel exited");
		this.#host = new StreamHost(renderer);
		this.#listener = this.#vsock.listen(GL_PORT, (conn) => this.#serve(conn));
		this.#log(`[host] gl: ${what}, on vsock port ${GL_PORT}`);
		if (opts.forwarder ?? true) {
			// The forwarder logs this over the link once it has its vtest socket.
			const linked = new Promise<void>((r) => (this.#linked = r));
			await this.#startForwarder();
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([linked, new Promise<never>((_, rej) => (timer = setTimeout(() =>
				rej(new Error(`the guest's forwarder did not link within ${LINK_TIMEOUT_MS / 1000} s`)), LINK_TIMEOUT_MS)))])
				.finally(() => clearTimeout(timer));
		}
		return what;
	}

	#serve(conn: VsockConnection): void {
		this.#conns.add(conn);
		const log = (s: string) => {
			this.#log(`[gl] ${s}`);
			if (s.startsWith("ready: vtest clients on ")) this.#linked?.();
		};
		this.#host!.serve(conn.readable, conn.writable as WritableStream<Uint8Array>, { log })
			.catch((e) => {
				if (!this.#down) this.#log(`[host] gl: the forwarder's link broke: ${(e as Error)?.message ?? e}`);
				conn.reset();
			})
			.finally(() => this.#conns.delete(conn));
	}

	/** Runs the forwarder (it exits at once, in the background or because one runs); throws why it failed. */
	async #startForwarder(): Promise<void> {
		let r;
		try {
			r = await guestRun(this.#vsock!, GL_FORWARDER, ["bridge", "--link", `vsock:2:${GL_PORT}`, "--daemon"], FORWARDER_TIMEOUT_MS);
		} catch (e) {
			const msg = (e as Error)?.message ?? String(e);
			if (e instanceof PtyError && e.code === "EREMOTE" && /No such file/.test(msg))
				throw new Error(`the guest has no ${GL_FORWARDER} (a kernel bundle from before guest GL); start a forwarder yourself`, { cause: e });
			throw new Error(`cannot start the guest's forwarder: ${msg}`, { cause: e });
		}
		if (r.exitCode !== 0)
			throw new Error(`the guest's forwarder failed: ${r.stderr.trim() || `exit ${r.exitCode ?? `signal ${r.signal}`}`}`);
	}

	/** @internal The kernel exited. */
	shutdown(): void {
		this.#down = true;
		this.#listener?.close();
		for (const c of this.#conns) c.reset();
		this.#gpu?.reset();
	}
}

/** The module's JS helpers (gl/wasm/post.js) that GlHost uses. */
interface VirglModule {
	virgl: {
		init(gl: WebGL2RenderingContext): number;
		Renderer: new (gl: WebGL2RenderingContext, opts?: { strictWaits?: boolean }) => VtestRenderer;
		gpu: VirglGpuApi;
	};
}

/** One module instance and its WebGL2 context, which the vtest link and virtio-gpu share. */
interface GlCore extends GpuRendererCore {
	module: VirglModule;
}

/** The renderer and the WebGL2 implementation, for the log and `loaded`. */
function describe(c: GlCore): string {
	return `virglrenderer (wasm) on ${c.gl.getParameter(c.gl.VERSION)}; ${webglName(c.gl)}`;
}

/**
 * The WebGL2 context's attributes (the probe's; the renderer's add alpha).
 * vrend draws into its own framebuffers; the drawing buffer only takes
 * blits to become ImageBitmaps (transferToImageBitmap, which takes the
 * buffer whatever preserveDrawingBuffer says).
 */
const WEBGL_ATTRS: WebGLContextAttributes = { alpha: false, depth: false, stencil: false, antialias: false, powerPreference: "high-performance" };

/**
 * The renderer's: with alpha, premultiplied, where the module has
 * kw_vgpu_blit (GpuRenderer.image(): a client's translucent ARGB buffer as
 * a translucent ImageBitmap; without alpha in the drawing buffer every
 * image would be opaque). The scanout stays opaque: kw_vgpu_present writes
 * alpha 1 after its blit. A module without blit keeps alpha: false, as
 * its present copies an X format's undefined fourth byte.
 */
function rendererAttrs(module: VirglModule): WebGLContextAttributes {
	return module.virgl.gpu.blit ? { ...WEBGL_ATTRS, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false } : WEBGL_ATTRS;
}

/**
 * Load the module and start its renderer on a WebGL2 context of an
 * OffscreenCanvas (1x1: vrend draws into its own framebuffers; virtio-gpu
 * sizes it to the scanout to present).
 */
async function loadGlCore(url: string, log: (msg: string) => void): Promise<GlCore> {
	if (typeof OffscreenCanvas !== "function") throw new Error("no OffscreenCanvas here, so no WebGL2");
	const mod = await import(/* @vite-ignore */ url) as { default: (o: object) => Promise<VirglModule> };
	const say = (s: string) => log(`[gl] virgl: ${s}`);
	const Module = await mod.default({ print: say, printErr: say });
	const gl = new OffscreenCanvas(1, 1).getContext("webgl2", rendererAttrs(Module));
	if (!gl) throw new Error("no WebGL2 context (OffscreenCanvas.getContext(\"webgl2\") gave none)");
	gl.canvas.addEventListener("webglcontextlost", () => log("[host] gl: the WebGL2 context was lost; GL clients will fail"));
	Module.virgl.init(gl);
	return { module: Module, gl, gpu: Module.virgl.gpu };
}

/**
 * Whether this thread gives a WebGL2 context: "" if it does, else why not.
 * The context is dropped at once (WEBGL_lose_context): a WebGL context
 * that is merely made costs the GPU process a context, not the renderer.
 */
export function probeWebGl2(): string {
	if (typeof OffscreenCanvas !== "function") return "no WebGL2 on this thread (no OffscreenCanvas)";
	try {
		const gl = new OffscreenCanvas(1, 1).getContext("webgl2", WEBGL_ATTRS);
		if (!gl) return "no WebGL2 context (OffscreenCanvas.getContext(\"webgl2\") gave none: WebGL is off or the GPU is blocklisted)";
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return "";
	} catch (e) {
		return `no WebGL2 context (${(e as Error)?.message ?? e})`;
	}
}

/**
 * @internal The wasm renderer, loaded once, on the first load(): the
 * guest's first GL use (a vtest client, virtio-gpu's first capset or 3D
 * command), GlHost.load(), or before boot with `eager`.
 */
export class GlLoader {
	readonly status: GlRendererStatus;
	readonly loaded: Promise<GlCore>;
	#url: string;
	#log: (msg: string) => void;
	#settle!: { resolve: (c: GlCore) => void; reject: (e: Error) => void };
	#started = false;

	/** `failed`: it cannot be had at all (no WebGL2 context when probed), so load() rejects with that. */
	constructor(url: string, log: (msg: string) => void, eager: boolean, failed?: string) {
		this.#url = url;
		this.#log = log;
		this.status = { state: failed ? "failed" : "idle", eager, startedAt: null, loadMs: null, error: failed || null, what: null, webgl: null };
		this.loaded = new Promise<GlCore>((resolve, reject) => (this.#settle = { resolve, reject }));
		this.loaded.catch(() => {});
		if (failed) {
			this.#started = true;
			this.#settle.reject(new Error(failed));
		}
	}

	load(): Promise<GlCore> {
		if (this.#started) return this.loaded;
		this.#started = true;
		const st = this.status, t0 = performance.now();
		st.state = "loading";
		st.startedAt = t0;
		if (!st.eager) this.#log("[host] gl: the guest's first GL use: loading the renderer (virgl.mjs, virgl.wasm, a WebGL2 context)");
		loadGlCore(this.#url, this.#log).then((c) => {
			st.loadMs = performance.now() - t0;
			st.state = "ready";
			st.webgl = webglName(c.gl);
			st.what = `virglrenderer (wasm) on ${c.gl.getParameter(c.gl.VERSION)}`;
			this.#log(`[host] gl: renderer loaded in ${(st.loadMs / 1000).toFixed(2)} s: ${st.what}; ${st.webgl}`);
			this.#settle.resolve(c);
		}, (e: unknown) => {
			st.loadMs = performance.now() - t0;
			st.state = "failed";
			st.error = (e as Error)?.message ?? String(e);
			this.#log(`[host] gl: the renderer did not load: ${st.error}`);
			this.#settle.reject(e instanceof Error ? e : new Error(st.error));
		});
		return this.loaded;
	}
}

/**
 * The vtest link's renderer, made from the loaded module on the first
 * client (an OPEN on the forwarder's link), which starts the load. Until
 * then clients are only noted, and their bytes wait (feed() returns a
 * promise, so StreamHost reads no more from the link and vsock credit holds
 * the forwarder). If the renderer cannot be had, each client is closed
 * (the guest's Mesa sees its vtest socket end).
 */
class LazyVtestRenderer implements VtestRenderer {
	onreply: (id: number, bytes: Uint8Array) => void = () => {};
	onclose: (id: number, why: string) => void = () => {};
	#loader: GlLoader;
	#strict: boolean;
	#real: VtestRenderer | null = null;
	#failed: string | null = null;
	#ready: Promise<VtestRenderer> | null = null;
	#opened = new Set<number>();

	constructor(loader: GlLoader, strictWaits: boolean) {
		this.#loader = loader;
		this.#strict = strictWaits;
		// Loaded for virtio-gpu (or eagerly): made now too, so that totals() counts from then on.
		loader.loaded.then(() => void this.#start().catch(() => {}), () => {});
	}

	async init(): Promise<string> {
		return "virglrenderer (wasm), loaded on first use";
	}

	#start(): Promise<VtestRenderer> {
		this.#ready ??= this.#loader.load().then(async (c) => {
			const r = new c.module.virgl.Renderer(c.gl, { strictWaits: this.#strict });
			await r.init();
			r.onreply = (id, b) => this.onreply(id, b);
			r.onclose = (id, why) => this.onclose(id, why);
			this.#real = r;
			for (const id of this.#opened) r.open(id);
			this.#opened.clear();
			return r;
		}, (e: unknown) => {
			this.#failed = (e as Error)?.message ?? String(e);
			const ids = [...this.#opened];
			this.#opened.clear();
			for (const id of ids) this.onclose(id, `no renderer: ${this.#failed}`);
			throw e;
		});
		return this.#ready;
	}

	open(id: number): void {
		if (this.#real) return this.#real.open(id);
		if (this.#failed) {
			const why = this.#failed;
			queueMicrotask(() => this.onclose(id, `no renderer: ${why}`));
			return;
		}
		this.#opened.add(id);
		this.#start().catch(() => {});
	}

	feed(id: number, bytes: Uint8Array): unknown {
		if (this.#real) return this.#real.feed(id, bytes);
		if (this.#failed || !this.#ready) return undefined;
		// Busy until the renderer is up; then these bytes go first.
		return this.#ready.then((r) => r.feed(id, bytes), () => {});
	}

	close(id: number): void {
		if (this.#real) return this.#real.close(id);
		this.#opened.delete(id);
	}

	stats(id: number): { parks: number; parkedMs: number } | undefined {
		return this.#real?.stats?.(id);
	}

	totals(): VirglTotals | undefined {
		return this.#real?.totals?.();
	}
}

/** @internal What createKernel({ gl }) prepared before the kernel boots: the options, the renderer's loader, virtio-gpu's side. */
export interface GlPrep {
	opts: GlOptions;
	loader?: GlLoader;
	gpu?: GpuRenderer;
}

/** The WebGL2 implementation's name (WEBGL_debug_renderer_info), for the log. */
function webglName(gl: WebGL2RenderingContext): string {
	const info = gl.getExtension("WEBGL_debug_renderer_info");
	return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
}

/**
 * @internal createKernel's `gl` (both modes, on the thread that owns the
 * VM), before the kernel boots: the renderer's loader (started now with
 * `eager`; else only a WebGL2 context is tried, probeWebGl2()) and, with
 * `gpu`, virtio-gpu's renderer side, or undefined with a log line where GL
 * cannot be had. `defaultModule` is the platform's virgl.mjs (web entry
 * only). `restoring`: a snapshot resumes, whose device offered 3D if it
 * was made where this could load; then the probe is skipped, so the device
 * offers 3D again (a failure shows at the guest's next 3D use).
 */
export function prepareGl(opt: GlOption | undefined, gpu: boolean, vsock: boolean, defaultModule: URL | undefined, log: (msg: string) => void, restoring = false): GlPrep | undefined {
	if (!opt) return undefined;
	const opts: GlOptions = opt === true ? {} : opt;
	const module = opts.module ?? defaultModule;
	if (opts.renderer) {
		if (gpu) log("[host] gpu: 2D only: gl.renderer is a vtest renderer, which virtio-gpu cannot use");
		if (!vsock) {
			log("[host] gl: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no GL renderer");
			return undefined;
		}
		return { opts };
	}
	const why = typeof OffscreenCanvas !== "function" ? "no WebGL2 on this thread (no OffscreenCanvas; Node has none)"
		: !module ? "no renderer module (this entry bundles none; pass gl.module, the URL of virgl.mjs)" : "";
	if (why) {
		if (gpu) log(`[host] gpu: 2D only: ${why}`);
		log(`[host] gl: ${why}, so it is ignored${typeof OffscreenCanvas !== "function" ? "; pass gl.renderer to use a renderer of your own" : ""}`);
		return undefined;
	}
	if (!vsock && !gpu) {
		log("[host] gl: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no GL renderer");
		return undefined;
	}
	const eager = !!opts.eager;
	let failed = "";
	if (!eager && !restoring) {
		const t0 = performance.now();
		failed = probeWebGl2();
		const ms = (performance.now() - t0).toFixed(1);
		log(failed ? `[host] gl: ${failed} (probed in ${ms} ms): no renderer` : `[host] gl: WebGL2 is there (probed in ${ms} ms); the renderer loads on the guest's first GL use`);
	}
	const loader = new GlLoader(String(module), log, eager, failed || undefined);
	if (eager) loader.load().catch(() => {});
	if (!gpu) return { opts, loader };
	if (failed) {
		log(`[host] gpu: 2D only: ${failed}`);
		return { opts, loader };
	}
	const renderer = new GpuRenderer(() => loader.load(), { strictWaits: opts.strictWaits, log });
	if (eager) renderer.start();
	return { opts, loader, gpu: renderer };
}

/**
 * @internal createKernel's `gl` once the kernel runs: a GlHost, or
 * undefined where prepareGl() found GL could not be had.
 */
export function startGl(prep: GlPrep | undefined, vsock: Vsock | undefined, log: (msg: string) => void): GlHost | undefined {
	if (!prep) return undefined;
	return new GlHost(vsock, prep, log);
}
