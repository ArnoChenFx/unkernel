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
// GlHost loads the module (only now: users without `gl` never fetch it),
// makes the WebGL2 context on an OffscreenCanvas (1x1: every frame goes to
// the renderer's own framebuffers and back by readback), listens on the
// port once the renderer is up, and then starts the forwarder through kwtty
// as root (`vtest-bridge bridge --link vsock:2:1019 --daemon`, which exits
// at once when one already runs, as after a restore). The forwarder
// reconnects every second while the link is down, so a restored guest finds
// the new host by itself. Renderer state (the clients' GL contexts) is not
// in a snapshot: a restore resets the link, which ends the guest's GL
// clients.
//
// Both modes: vsock is served on the thread that owns the VM (worker mode
// too), so GL runs there, which must have OffscreenCanvas and WebGL2 (a
// page's main thread or a worker of the caller's). Where it has not (Node),
// `gl: true` is ignored with a log line, unless `renderer` gives one.
//
// With `gpu` too (createKernel({ gl, gpu })), the same module and WebGL2
// context also serve the guest's virtio-gpu device in 3D (gl-gpu.ts): one
// renderer for both paths, made before the kernel boots (prepareGpuGl), as
// the device offers virgl when the driver probes. `gpu` without `gl`, or
// where there is no WebGL2, is the 2D device. GlHost.gpu is that side: the
// scanout's frames (drawFrame()) and resources' textures.

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
 * (`renderer`, VirglTotals; virtio-gpu's commands count there too) and,
 * with `gpu`, the virtio-gpu side's (`gpu`).
 */
export interface GlStats extends StreamHostStats {
	gpu?: GpuRendererStats;
}

export type { VirglTotals };

/** The host side of guest GL (KernelHandle.gl). */
export class GlHost {
	/**
	 * Resolves with the renderer's description once guest GL programs can
	 * run: the renderer is up, and (unless `forwarder: false`, which
	 * resolves once it listens) the guest's forwarder is linked and has made
	 * its vtest socket. Rejects if that cannot happen (also logged).
	 */
	readonly ready: Promise<string>;
	#vsock: Vsock | undefined;
	#gpu: GpuRenderer | undefined;
	#log: (msg: string) => void;
	#host: StreamHost | undefined;
	#listener: VsockListener | undefined;
	#conns = new Set<VsockConnection>();
	#down = false;
	#linked!: () => void;

	/** @internal Use createKernel({ gl }). */
	constructor(vsock: Vsock | undefined, opts: GlOptions, module: string | undefined, log: (msg: string) => void, start?: GpuGlStart) {
		this.#vsock = vsock;
		this.#gpu = start?.gpu;
		this.#log = log;
		this.ready = this.#start(opts, module, start);
		this.ready.catch((e) => log(`[host] gl: ${(e as Error)?.message ?? e}; the guest gets no GL renderer`));
	}

	/** Bridges and clients being served, the renderer's counters, and virtio-gpu's (with `gpu`). */
	get stats(): GlStats {
		const s: GlStats = this.#host?.stats ?? { streams: 0, clients: 0, opened: 0 };
		return this.#gpu ? { ...s, gpu: { ...this.#gpu.stats } } : s;
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

	async #start(opts: GlOptions, module: string | undefined, start: GpuGlStart | undefined): Promise<string> {
		const core = opts.renderer ? undefined : await (start?.core ?? loadGlCore(module!, this.#log));
		if (core && !this.#vsock) {
			// virtio-gpu alone (no vsock: no vtest link).
			await this.#gpu?.init;
			return `virglrenderer (wasm) on ${core.gl.getParameter(core.gl.VERSION)}; ${webglName(core.gl)}; virtio-gpu only`;
		}
		const renderer = opts.renderer ?? new core!.module.virgl.Renderer(core!.gl, { strictWaits: opts.strictWaits ?? false });
		let what = await renderer.init();
		if (core) what += `; ${webglName(core.gl)}`;
		if (this.#gpu) what += "; virtio-gpu 3D";
		if (this.#down) throw new Error("the kernel exited");
		this.#host = new StreamHost(renderer);
		this.#listener = this.#vsock!.listen(GL_PORT, (conn) => this.#serve(conn));
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
	const gl = new OffscreenCanvas(1, 1).getContext("webgl2", {
		alpha: false, depth: false, stencil: false, antialias: false, powerPreference: "high-performance",
	});
	if (!gl) throw new Error("no WebGL2 context (OffscreenCanvas.getContext(\"webgl2\") gave none)");
	gl.canvas.addEventListener("webglcontextlost", () => log("[host] gl: the WebGL2 context was lost; GL clients will fail"));
	Module.virgl.init(gl);
	return { module: Module, gl, gpu: Module.virgl.gpu };
}

/** @internal What prepareGpuGl() made before the kernel boots: the shared renderer and virtio-gpu's side of it. */
export interface GpuGlStart {
	core: Promise<GlCore>;
	gpu: GpuRenderer;
}

/**
 * @internal createKernel({ gl, gpu }): the renderer for virtio-gpu 3D, made
 * before the kernel boots (the device offers virgl when the driver probes,
 * and its capsets come from this WebGL2 context), or undefined with a log
 * line where there can be none (the device is then 2D).
 */
export function prepareGpuGl(opt: GlOption | undefined, defaultModule: URL | undefined, log: (msg: string) => void): GpuGlStart | undefined {
	if (!opt) return undefined;
	const opts: GlOptions = opt === true ? {} : opt;
	const module = opts.module ?? defaultModule;
	const why = opts.renderer ? "gl.renderer is a vtest renderer, which virtio-gpu cannot use"
		: typeof OffscreenCanvas !== "function" ? "no WebGL2 on this thread (no OffscreenCanvas)"
		: !module ? "no renderer module (pass gl.module)" : "";
	if (why) {
		log(`[host] gpu: 2D only: ${why}`);
		return undefined;
	}
	const core = loadGlCore(String(module), log);
	core.catch(() => {});
	return { core, gpu: new GpuRenderer(core, { strictWaits: opts.strictWaits, log }) };
}

/** The WebGL2 implementation's name (WEBGL_debug_renderer_info), for the log. */
function webglName(gl: WebGL2RenderingContext): string {
	const info = gl.getExtension("WEBGL_debug_renderer_info");
	return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
}

/**
 * @internal createKernel's `gl` (both modes, on the thread that owns the
 * VM): a GlHost, or undefined with a log line where GL cannot be had.
 * `defaultModule` is the platform's virgl.mjs (web entry only).
 */
export function startGl(opt: GlOption | undefined, vsock: Vsock | undefined, defaultModule: URL | undefined, log: (msg: string) => void, start?: GpuGlStart): GlHost | undefined {
	if (!opt) return undefined;
	const opts: GlOptions = opt === true ? {} : opt;
	if (start) return new GlHost(vsock, opts, undefined, log, start);
	if (!vsock) {
		log("[host] gl: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no GL renderer");
		return undefined;
	}
	const module = opts.module ?? defaultModule;
	if (!opts.renderer && typeof OffscreenCanvas !== "function") {
		log("[host] gl: no WebGL2 on this thread (no OffscreenCanvas; Node has none), so it is ignored; pass gl.renderer to use a renderer of your own");
		return undefined;
	}
	if (!opts.renderer && !module) {
		log("[host] gl: no renderer module (this entry bundles none; pass gl.module, the URL of virgl.mjs), so it is ignored");
		return undefined;
	}
	return new GlHost(vsock, opts, module === undefined ? undefined : String(module), log);
}
