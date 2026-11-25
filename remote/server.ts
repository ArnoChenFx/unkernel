// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote kernel backend's server (Bun), on 127.0.0.1 only: the page's
// files from the web build (its HTML says the page runs its kernel here, see
// http.ts), /remote/info, and /remote/ws, the page's connection to the kernel
// (remote/backend.ts). Every request passes http.ts's sameSiteGuard, so a page
// on another site cannot reach the kernel. The kernel's files are looked up
// only under the web build, the distro images are copied to the cache, and
// the data disk is created from the kernel's template when missing.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundledBoot } from "../js/core/kernel.ts";
import { REMOTE_INFO_PATH, REMOTE_WIRE, REMOTE_WS_PATH } from "./wire.ts";
import { createImageFromKwsparse } from "../js/node/disk.ts";
import { RemoteHub, type RemoteAttachment, type RemoteHost, type RemoteSocket } from "./backend.ts";
import type { RemoteConfig } from "./config.ts";
import { localNames, sameSiteGuard, withRemoteFlag } from "./http.ts";

export interface RunningRemote {
	readonly url: string;
	readonly hub: RemoteHub;
	stop(): void;
}

const KERNEL_FILE = /^\/assets\/unkernel(?:-smp)?-[A-Za-z0-9_-]+\.wasm$/;
const DISTRO_FILE = /^\/distros\/[a-z0-9]+-[0-9a-f]{16}\.(?:erofs|ext4)$/;

const SECURITY_HEADERS = {
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-resource-policy": "same-origin",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

/** The kiosk page's script (remote/web/kiosk.ts): kiosk.js beside the bundle, or built from the source in a checkout. */
const here = path.dirname(fileURLToPath(import.meta.url));
let kioskCode: Promise<string> | undefined;
function kioskScript(): Promise<string> {
	kioskCode ??= (async () => {
		const beside = path.join(here, "kiosk.js");
		if (existsSync(beside)) return readFileSync(beside, "utf8");
		const built = await Bun.build({ entrypoints: [path.join(here, "web", "kiosk.ts")], target: "browser", format: "esm", minify: true });
		if (!built.success) throw new Error(`the kiosk page does not build: ${built.logs.join("; ")}`);
		return built.outputs[0]!.text();
	})();
	return kioskCode;
}

/** The kiosk page (/kiosk[?distro=NAME]): the kernel and the distro image are the web build's own. */
function kioskHtml(web: string, distro: string): string | undefined {
	const list = (dir: string) => {
		try {
			return readdirSync(path.join(web, dir));
		} catch {
			return [];
		}
	};
	const kernel = list("assets").find((f) => /^unkernel-(?!smp-)[A-Za-z0-9_-]+\.wasm$/.test(f));
	const image = list("distros").find((f) => f.startsWith(`${distro}-`) && DISTRO_FILE.test(`/distros/${f}`));
	if (!kernel || !image) return undefined;
	const glDir = list("assets").find((f) => /^virgl-[0-9a-f]{16}$/.test(f));
	const gl = glDir && list(`assets/${glDir}`).includes("virgl.mjs") ? `/assets/${glDir}/virgl.mjs` : null;
	const config = JSON.stringify({ kernel: `/assets/${kernel}`, distro: `/distros/${image}`, command: distro === "omarchy" ? "omarchy desktop" : "", gl });
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Omarchy</title><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="unkernel-remote" content="1">
<style>
html,body{margin:0;height:100%;background:#0b0c10;color:#c0caf5;font:15px system-ui,sans-serif;overflow:hidden}
#fb{position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;cursor:none;opacity:0;touch-action:none}
body.live #fb{opacity:1}
#msg{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none}
body.live #msg{display:none}
#status{font-size:22px}#detail{opacity:.6}
</style></head><body>
<canvas id="fb" width="640" height="480" tabindex="0"></canvas>
<div id="msg"><div id="status"></div><div id="detail"></div></div>
<script>window.__KIOSK__=${config};</script>
<script type="module" src="/kiosk.js"></script>
</body></html>
`;
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/** A copy of `src` at `dst`, made again only when the size differs; a running guest keeps the copy it opened. */
function cached(src: string, dst: string): string {
	mkdirSync(path.dirname(dst), { recursive: true });
	if (existsSync(dst) && statSync(dst).size === statSync(src).size) return dst;
	const tmp = `${dst}.tmp-${process.pid}`;
	copyFileSync(src, tmp);
	renameSync(tmp, dst);
	return dst;
}

/**
 * The page's HTML. Nitro's build has no index.html in its public directory:
 * the page's shell is Nitro's renderer template (web/.output/server), the same
 * one the built server answers / with.
 */
async function pageHtml(web: string): Promise<string> {
	const built = path.join(web, "index.html");
	if (existsSync(built)) return readFileSync(built, "utf8");
	const template = path.join(web, "..", "server", "_chunks", "renderer-template.mjs");
	if (!existsSync(template)) throw new Error(`no page at ${web}: build it first (pnpm build:web)`);
	const { default: render } = (await import(pathToFileURL(template).href)) as { default: (event: { req: Request }) => { body: unknown } };
	const html = render({ req: new Request("http://127.0.0.1/") }).body;
	if (typeof html !== "string") throw new Error(`${template} does not render the page`);
	return html;
}

export async function startRemoteServer(config: RemoteConfig, log: (line: string) => void): Promise<RunningRemote> {
	const origin = `http://127.0.0.1:${config.port}`;
	const { origins } = localNames(config.port);
	const guard = sameSiteGuard(config.port);
	const web = path.resolve(config.web);
	const index = withRemoteFlag(await pageHtml(web));

	const locate = async (url: string, role: "kernel" | "distro"): Promise<string> => {
		let u: URL;
		try {
			u = new URL(url, origin);
		} catch {
			throw new Error(`${url} is not a URL`);
		}
		if (!origins.has(u.origin)) throw new Error(`${url} is not on this backend (${origin})`);
		const rel = decodeURIComponent(u.pathname);
		if (role === "kernel" ? !KERNEL_FILE.test(rel) : !DISTRO_FILE.test(rel)) throw new Error(`${rel} is not a ${role} of the web build`);
		const src = path.join(web, rel);
		if (!isFile(src)) throw new Error(`${rel} is not in the web build at ${web}`);
		return role === "kernel" ? src : cached(src, path.join(config.cache, "distros", path.basename(rel)));
	};

	const dataDisk = async (kernelPath: string): Promise<string> => {
		if (existsSync(config.data)) return config.data;
		const template = bundledBoot(await WebAssembly.compile(readFileSync(kernelPath))).datadisk;
		if (!template) throw new Error(`the kernel at ${kernelPath} has no data disk template (unkernel.datadisk)`);
		mkdirSync(path.dirname(config.data), { recursive: true });
		log(`creating the data disk ${config.data} from the kernel's template`);
		const made = await createImageFromKwsparse(config.data, template);
		log(`created ${config.data} (${made.blocks} stored blocks, ${Math.round(made.size / 2 ** 20)} MiB)`);
		return config.data;
	};

	const host: RemoteHost = {
		file: locate,
		dataDisk,
		work: config.work ?? undefined,
		data: config.data,
		net: config.net,
		log,
	};
	const hub = new RemoteHub(host);

	const info = () => ({
		app: "unkernel-remote",
		wire: REMOTE_WIRE,
		pid: process.pid,
		url: `${origin}/`,
		data: config.data,
		work: config.work,
		cache: config.cache,
		web,
		net: config.net,
	});

	const staticFile = async (pathname: string): Promise<Response> => {
		let rel: string;
		try {
			rel = decodeURIComponent(pathname);
		} catch {
			return new Response("bad request", { status: 400 });
		}
		if (rel.includes("\0") || rel.includes("\\") || rel.split("/").includes("..")) return new Response("not found", { status: 404 });
		if (rel === "/" || rel === "/index.html") {
			return new Response(index, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
		}
		const abs = path.resolve(web, `.${rel}`);
		if (!abs.startsWith(web + path.sep)) return new Response("not found", { status: 404 });
		const file = Bun.file(abs);
		if (!(await file.exists())) return new Response("not found", { status: 404 });
		const cache = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
		return new Response(file, { headers: { ...SECURITY_HEADERS, "cache-control": cache } });
	};

	const server = Bun.serve<{ attachment?: RemoteAttachment; keep: boolean }>({
		hostname: "127.0.0.1",
		port: config.port,
		async fetch(req, srv) {
			const denied = guard(req);
			if (denied) return denied;
			const url = new URL(req.url);
			if (url.pathname === REMOTE_WS_PATH) {
				if (srv.upgrade(req, { data: { keep: url.searchParams.get("keep") === "1" } })) return undefined;
				return new Response("expected a WebSocket upgrade", { status: 426 });
			}
			if (url.pathname === REMOTE_INFO_PATH) {
				return Response.json(info(), { headers: { ...SECURITY_HEADERS, "cache-control": "no-store" } });
			}
			if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
			if (url.pathname === "/kiosk" || url.pathname === "/kiosk/") {
				const html = kioskHtml(web, url.searchParams.get("distro") ?? "omarchy");
				if (!html) return new Response("the web build has no such distro image", { status: 404 });
				return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
			}
			if (url.pathname === "/kiosk.js") {
				return new Response(await kioskScript(), { headers: { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
			}
			return staticFile(url.pathname);
		},
		websocket: {
			maxPayloadLength: 64 * 1024 * 1024,
			perMessageDeflate: false,
			open(ws) {
				const socket: RemoteSocket = {
					send: (frame) => {
						ws.send(frame);
					},
					close: (code, reason) => ws.close(code, reason),
				};
				ws.data.attachment = hub.attach(socket, { keep: ws.data.keep });
			},
			message(ws, message) {
				if (typeof message === "string") {
					ws.close(1003, "binary frames only");
					return;
				}
				if (ws.data.attachment) hub.receive(ws.data.attachment, new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
			},
			close(ws) {
				if (ws.data.attachment) hub.detach(ws.data.attachment);
			},
		},
	});

	return {
		url: `${origin}/`,
		hub,
		stop() {
			server.stop(true);
		},
	};
}
