// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The unkernel page: Vite for the client (index.html, src/: React and
// Tailwind), Nitro for the build output (.output/ with the Node preset,
// `node .output/server/index.mjs`; .vercel/output/ on Vercel) and the
// response headers. The page is static: it runs the base bundle
// unkernel.wasm (its UP and SMP kernels, hashed assets in a build) with a
// read-only distro image read by URL, both from virtual:unkernel-kernel,
// which scripts/kernel.ts pageSource() picks before anything else. The
// page's service worker (the guest preview's relay) is public/vm-sw.js, the
// preview's server fallback server/vm.ts.
//
// Build settings (environment variables, scripts/kernel.ts): KW_KERNEL and
// KW_DISTROS give the base bundle and the images; else a local build
// (vendor/build) when there is one and it may be used (not where CI or
// VERCEL is set, unless KW_LOCAL=1; KW_LOCAL=0 never); else the newest
// GitHub release (KW_KERNEL_RELEASE=<tag>: that one), downloaded into
// web/kernel/release/; GITHUB_TOKEN for the API.
//
// The images: the dev server answers /distros/<name>.erofs itself
// (serveDistros(), revalidated: a local image is rebuilt in place); a build
// names them /distros/<name>-<sha256 prefix>.erofs and copies them into the
// output after Nitro has built and compressed it (unkernel:distro-images),
// where the Node server answers them (server/distros.ts) and Vercel's CDN
// serves them as static files, immutable either way.
//
// Runtime settings (environment variables of the built Node server):
//   PORT, HOST (NITRO_PORT, NITRO_HOST)  where it listens (default: port 3000, all interfaces)
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";
import { baseSplit, pageSource, rescanImages, servedName, splitBase, type PageImage } from "./scripts/kernel.ts";
import { IMMUTABLE, distroReply } from "./server/range.ts";

const git = (...args: string[]) => {
	try { return execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
	catch { return ""; }
};

/**
 * __KW_BUILD__ (src/env.d.ts), shown in the About dialog: the Linux release
 * from the base bundle's banner, the kernel's release tag ("local" for a
 * local build) and the page's commit. Empty where unknown (no git).
 */
async function buildInfo(dev: boolean) {
	const s = await pageSource(dev);
	const [commit = "", date = ""] = git("log", "-1", "--format=%H %cI").split(" ");
	return {
		linux: s.linux,
		kernel: s.kernel.tag,
		commit: commit || process.env.VERCEL_GIT_COMMIT_SHA || "",
		date,
	};
}

/** The build output's directories and preset (Nitro's), known once Nitro has compiled. */
let output: { dir: string; publicDir: string; preset: string } | undefined;

/** The dev server's images as they are now (sizes and hashes read again: an image may have been rebuilt). */
let devImages: Promise<PageImage[]> | undefined;

export default defineConfig({
	// Every interface, so a phone on the LAN can open http://<this-machine>:8080/.
	server: {
		host: true,
		port: 8080,
		// The dev server's own responses (modules, /@fs/) do not go through
		// Nitro's route rules below. A worker script must carry COEP itself,
		// or a cross-origin isolated page refuses to start it (?worker=1).
		headers: { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" },
		// A page build's output (its index.html) and the kernel files: a change
		// there must not reload an open dev page, which would end its VM.
		watch: { ignored: ["**/.output/**", "**/.vercel/**", "**/kernel/release/**", "**/kernel/page/**"] },
	},
	build: { target: "esnext" },
	// The SDK's worker mode (?worker=1): js/web/worker.ts starts a module worker.
	worker: { format: "es" },
	// libfx names fx-term.wasm with new URL(..., import.meta.url), which pre-bundling would break.
	optimizeDeps: { exclude: ["libfx"] },
	plugins: [
		{
			// The kernel and the images first: picked (and fetched) before the
			// build resolves them, and __KW_BUILD__ reads the base's banner.
			name: "unkernel:kernel",
			async config(_, { command }) {
				return { define: { __KW_BUILD__: JSON.stringify(await buildInfo(command === "serve")) } };
			},
			configureServer(server) {
				// /distros/<name>.erofs with Range support and as they are (erofs
				// compresses inside): Nitro's dev handler would answer public/ files
				// compressed and in full.
				server.middlewares.use(serveDistros);
				// A new base bundle (kernel/build.sh base): split it again. A rebuilt
				// image (kernel/build.sh distro): the list is read again on the next
				// page load.
				void pageSource(true).then((s) => {
					const images = s.distros.map((d) => d.file);
					server.watcher.add([s.base, ...images]);
					const onFile = (file: string) => {
						if (file === s.base) {
							splitBase(file, true).catch((e: unknown) => console.error(`[kernel] ${(e as Error).message}`));
							invalidate();
						}
						if (images.includes(file)) {
							devImages = undefined;
							invalidate();
						}
					};
					const invalidate = () => {
						const mod = server.environments.client.moduleGraph.getModuleById("\0virtual:unkernel-kernel");
						if (mod) server.environments.client.moduleGraph.invalidateModule(mod);
					};
					server.watcher.on("change", onFile);
					server.watcher.on("add", onFile);
				});
			},
			// src/sdk.ts's kernelUrl and kernelSmpUrl (the base bundle's UP and SMP
			// kernels: /@fs/ files in dev, hashed assets in a build; the SMP one
			// null without an SMP patch) and src/config.ts's distros.
			resolveId(id) {
				return id === "virtual:unkernel-kernel" ? "\0virtual:unkernel-kernel" : null;
			},
			async load(id) {
				if (id !== "\0virtual:unkernel-kernel") return null;
				const dev = this.environment.mode === "dev";
				const s = await pageSource(dev);
				let up: string, smp: string;
				if (dev) {
					const files = await splitBase(s.base);
					up = `new URL(${JSON.stringify(`/@fs${files.up}`)}, import.meta.url)`;
					smp = files.smp ? `new URL(${JSON.stringify(`/@fs${files.smp}`)}, import.meta.url)` : "null";
				} else {
					const split = await baseSplit(s.base);
					const asset = (name: string, source: Uint8Array) =>
						`new URL(import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: "asset", name, source })}, import.meta.url)`;
					up = asset("unkernel.wasm", split.up);
					smp = split.smp ? asset("unkernel-smp.wasm", split.smp) : "null";
				}
				const images = dev ? await (devImages ??= rescanImages(s)) : s.distros;
				const distros = images.map(({ name, url, size, imageId }) => ({ name, url, size, ...(imageId ? { imageId } : {}) }));
				return [
					`export const kernelUrl = ${up};`,
					`export const kernelSmpUrl = ${smp};`,
					`export const distros = ${JSON.stringify(distros)};`,
				].join("\n");
			},
		},
		{
			// Files in public/ are answered by Nitro's dev handler, with neither
			// server.headers above nor the route rules below. Set the isolation
			// headers first, so a document there is
			// cross-origin isolated like the page.
			name: "unkernel:isolate-public",
			configureServer(server) {
				server.middlewares.use((_req, res, next) => {
					res.setHeader("cross-origin-opener-policy", "same-origin");
					res.setHeader("cross-origin-embedder-policy", "require-corp");
					next();
				});
			},
		},
		react(),
		tailwindcss(),
		nitro({
			// The kernel (9 MiB) is sent br/zstd/gzip-encoded by the Node server.
			// Every file in the output's public directory is compressed (types
			// it does not know count as text), which is why the distro images
			// are copied in only afterwards (unkernel:distro-images).
			compressPublicAssets: true,
			// An earlier dev server's links to the images (web/public/distros/,
			// gitignored): never part of a build.
			ignore: ["public/distros/**"],
			handlers: [
				// The guest preview (src/preview.ts): /vm/** reaches the server only when the
				// service worker (public/vm-sw.js, served at /vm-sw.js) did not answer.
				{ route: "/vm/**", handler: "./server/vm.ts" },
				// The images on the Node server (the dev server answers them in
				// serveDistros() before Nitro sees them; Vercel's CDN serves them).
				{ route: "/distros/**", handler: "./server/distros.ts" },
			],
			hooks: {
				compiled(n) { output = { dir: n.options.output.dir, publicDir: n.options.output.publicDir, preset: n.options.preset }; },
			},
			routeRules: {
				// Cross-origin isolation (secure contexts only), so SharedArrayBuffer
				// is available. The kernel does not need it yet (its memory is not shared).
				"/**": {
					headers: {
						"cross-origin-opener-policy": "same-origin",
						"cross-origin-embedder-policy": "require-corp",
					},
				},
				// Checked for updates on every load (src/sw.ts); not cached by the CDN.
				"/vm-sw.js": { headers: { "cache-control": "no-cache" } },
				// The images, loadable by the cross-origin-isolated page. Their
				// Cache-Control comes from server/range.ts on Node, and on Vercel from
				// the hit-phase route unkernel:distro-images adds (a found file only,
				// so a 404 is never cached for a year).
				"/distros/**": { headers: { "cross-origin-resource-policy": "same-origin" } },
			},
		}),
		{
			// Copy each image (a real file, never anything else from its
			// directory: vendor/build/distro also holds tar and ext4 files of
			// 100 MB and more) into the output's public/distros/ under its
			// content-addressed name (scripts/kernel.ts servedName()), after
			// Nitro's build (its buildApp hook is "post" too and comes first) and
			// so after it compressed the public files and listed its static
			// assets. The copy keeps the image's mtime. On Vercel, a route in the
			// "hit" phase (a request a static file answers) marks them immutable.
			name: "unkernel:distro-images",
			buildApp: {
				order: "post",
				async handler() {
					const s = await pageSource(false);
					if (!output) throw new Error("[kernel] Nitro gave no output directory for the images");
					const dir = path.join(output.publicDir, "distros");
					await rm(dir, { recursive: true, force: true });
					await mkdir(dir, { recursive: true });
					for (const d of s.distros) {
						const to = path.join(dir, servedName(d));
						await copyFile(d.file, to);
						const st = await stat(d.file);
						await utimes(to, st.atime, st.mtime);
					}
					console.log(`[kernel] distro images in ${path.relative(process.cwd(), dir)}/: ${s.distros.map((d) => `${servedName(d)} (${(d.size / 1048576).toFixed(1)} MiB)`).join(", ")}`);
					if (output.preset.startsWith("vercel")) await vercelImmutable(path.join(output.dir, "config.json"));
				},
			},
		},
	],
});

/**
 * Vercel (Build Output API v3): the images' Cache-Control. Nitro's route
 * rules become routes before the `filesystem` handle, which also apply to a
 * miss (the function's 404). A route after `{ handle: "hit" }` applies only
 * where a static file answered, as Next.js does for its hashed assets.
 */
async function vercelImmutable(file: string): Promise<void> {
	const config = JSON.parse(await readFile(file, "utf8")) as { routes?: Record<string, unknown>[] };
	const routes = config.routes ??= [];
	if (routes.some((r) => r.handle === "hit")) throw new Error(`[kernel] ${file} has a "hit" phase already; add the images' route to it`);
	routes.push({ handle: "hit" }, {
		src: "^/distros/[a-z0-9]+-[0-9a-f]{16}\\.(?:erofs|ext4)$", // a build's names only (scripts/kernel.ts servedName())
		headers: { "cache-control": IMMUTABLE },
		continue: true,
		important: true,
	});
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
	console.log(`[kernel] ${path.relative(process.cwd(), file)}: /distros/ files immutable (hit phase)`);
}

/**
 * The dev server's /distros/<name>.erofs: the image of that name in the
 * page's list, answered by server/range.ts's distroReply() (one range per
 * request, uncompressed, revalidated with a strong ETag from size and
 * mtime, the isolation headers). Anything else under /distros/ is a 404.
 */
function serveDistros(req: IncomingMessage, res: ServerResponse, next: () => void): void {
	const url = (req.url ?? "").split("?")[0]!;
	if (!url.startsWith("/distros/")) return next();
	let name = url.slice("/distros/".length);
	try { name = decodeURIComponent(name); } catch {}
	void pageSource(true).then((s) => {
		const file = s.distros.find((d) => d.url === url)?.file ?? null;
		const r = distroReply(file, name, req.method ?? "GET", (h) => {
			const v = req.headers[h];
			return Array.isArray(v) ? v.join(", ") : v;
		}, `no distro image ${name} on this dev server (${s.distros.map((d) => d.url).join(", ")})`);
		res.writeHead(r.status, r.headers);
		if (typeof r.body === "string") return void res.end(r.body);
		if (!r.body) return void res.end();
		const stream = createReadStream(r.body.file, { start: r.body.start, end: r.body.end });
		stream.on("error", () => res.destroy());
		stream.pipe(res);
	}, (e: unknown) => {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
		res.end(`${(e as Error).message}\n`);
	});
}
