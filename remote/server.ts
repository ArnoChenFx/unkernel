// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote kernel backend's server (Bun), on 127.0.0.1 only: the page's
// files from the web build (its HTML says the page runs its kernel here, see
// http.ts), /remote/info, and /remote/ws, the page's connection to the kernel
// (remote/backend.ts). Every request passes http.ts's sameSiteGuard, so a page
// on another site cannot reach the kernel. The kernel's files are looked up
// only under the web build, the distro images are copied to the cache, and
// the data disk is created from the kernel's template when missing.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledBoot } from "../js/core/kernel.ts";
import { REMOTE_INFO_PATH, REMOTE_WIRE, REMOTE_WS_PATH } from "./wire.ts";
import { createImageFromKwsparse } from "../js/node/disk.ts";
import { RemoteHub, type RemoteHost, type RemoteKernel, type RemoteSocket } from "./backend.ts";
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

	const server = Bun.serve<{ kernel?: RemoteKernel }>({
		hostname: "127.0.0.1",
		port: config.port,
		async fetch(req, srv) {
			const denied = guard(req);
			if (denied) return denied;
			const url = new URL(req.url);
			if (url.pathname === REMOTE_WS_PATH) {
				if (srv.upgrade(req, { data: {} })) return undefined;
				return new Response("expected a WebSocket upgrade", { status: 426 });
			}
			if (url.pathname === REMOTE_INFO_PATH) {
				return Response.json(info(), { headers: { ...SECURITY_HEADERS, "cache-control": "no-store" } });
			}
			if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
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
				ws.data.kernel = hub.attach(socket);
			},
			message(ws, message) {
				if (typeof message === "string") {
					ws.close(1003, "binary frames only");
					return;
				}
				ws.data.kernel?.receive(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
			},
			close(ws) {
				ws.data.kernel?.closed();
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
