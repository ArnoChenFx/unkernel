// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's service worker (registered by src/sw.ts): scope / in a
// production build, /vm/ under the dev server. Two jobs:
//
// The offline copy (scope / only; .agents/web.md, Offline and updates).
// The page (/) and the build's files (/assets/, the kernel among them) are
// answered from the Cache API at once, so a load needs no network. Each
// load also fetches / in the background; a different page means a new
// build, whose files (the list /kw-assets.json, written by vite.config.ts)
// are all cached before its page replaces the cached one. So the cached
// page always has its files, and a reload after an update is as fast as
// any other. The page asks {t:"kw-check", entry} with its own entry script
// and hears whether a newer build is ready (src/sw.ts shows "update").
//
// The guest preview (.agents/web.md, Guest preview, has the whole design).
// It answers /vm/<vmId>/<port>/<path> by relaying the request to the page
// that runs that kernel, which calls vm.fetch() on the guest's
// 127.0.0.1:<port> and streams the response back. Subresources of a
// controlled document that are same-origin but outside /vm/ (root-relative
// URLs such as /style.css) go to the same kernel and port.
//
// Stateless on purpose: browsers stop idle service workers, so every fetch
// asks the open windows again. Each window that is not itself a preview
// gets the request with a MessagePort of its own; the page that owns the
// vmId answers "accept" on it, the others ignore it. Over the accepted port
// (no transferable streams: Safari lacks them):
//   page -> here: {t:"accept"}, then {t:"head", status, statusText, headers},
//                 {t:"chunk", data: ArrayBuffer}..., {t:"end"} or {t:"error", message}
//   here -> page: {t:"more"} (the body stream wants a chunk), {t:"cancel"}
// The page may send a few chunks ahead (credits, preview.ts), so a chunk
// is not a round trip each.
//
// A plain script, not a module, and not part of the TypeScript build, so
// that every engine with service workers runs it as it is.
"use strict";

/** /vm/<vmId>/<port>[/<path>] */
const PREVIEW_RE = /^\/vm\/([A-Za-z0-9_-]{1,64})\/(\d{1,5})(\/.*)?$/;
/** A page must accept within this, else 502 (no page runs that kernel any more). */
const ACCEPT_MS = 5000;
/** The guest must send the status line and headers within this, else 504. */
const HEAD_MS = 60000;
/**
 * The page is cross-origin isolated (COOP same-origin, COEP require-corp),
 * so a document in its iframe must declare COEP too. require-corp, not
 * credentialless: Safari does not implement credentialless, and an iframe
 * without a COEP it knows is blocked there. The cost: a guest page's
 * cross-origin subresources (a CDN) load only if they send CORP or CORS.
 */
const COEP = "require-corp";
/** Not passed on from the guest: hop-by-hop, and what the browser computes itself. */
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "set-cookie", "set-cookie2",
	"cross-origin-embedder-policy", "cross-origin-resource-policy", "cross-origin-opener-policy"]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Scope / (a production build): keep the offline copy. Under /vm/ (the dev server) only the preview. */
const APP = self.registration.scope === `${location.origin}/`;
/** The offline copy. A new name for a new layout; activate deletes the others. */
const CACHE = "kw-app-v1";
const SHELL = "/";
/** The build's files, {files: ["/assets/…", …]} (vite.config.ts), and the one before (an older tab may still load from it). */
const LIST = "/kw-assets.json", LIST_PREV = "/kw-assets.json?prev";
/** A check this recent answers kw-check without asking the network again. */
const FRESH_MS = 10000;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		await self.clients.claim();
		const names = await caches.keys();
		await Promise.all(names.filter((n) => n.startsWith("kw-app-") && (n !== CACHE || !APP)).map((n) => caches.delete(n)));
	})());
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (url.origin !== location.origin) return; // cross-origin: the network, as usual
	const m = PREVIEW_RE.exec(url.pathname);
	if (m) {
		// /vm/<id>/<port> without the slash: relative URLs in the page need it.
		if (m[3] === undefined) event.respondWith(Response.redirect(new URL(`${url.pathname}/${url.search}`, url).href, 308));
		else event.respondWith(relay(event, m[1], Number(m[2]), m[3] + url.search));
		return;
	}
	if (req.mode === "navigate") {
		if (APP && req.method === "GET") event.respondWith(page(event, url));
		return;
	}
	// A subresource of a controlled document: the page's own, or root-relative from a preview.
	if (!event.clientId) return;
	// A known page (not a preview) and nothing to cache: the browser, as if there were no worker.
	if (pageClients.has(event.clientId) && !(APP && isBuildFile(req, url))) return;
	event.respondWith(fromClient(event, url));
});

/**
 * Clients (the page, its workers) already seen not to be previews, so that
 * their requests the worker would only pass on skip it. Only a shortcut:
 * empty after the browser stops this worker, when fromClient() looks again.
 */
const pageClients = new Set();
/** A GET of the build's files that the offline copy answers (a range request is not: media). */
const isBuildFile = (req, url) => req.method === "GET" && url.pathname.startsWith("/assets/") && !req.headers.has("range");
/**
 * Passed on to the network. A failure (offline, a reset connection, a
 * request the page cancelled) reaches the page as the network error it
 * would be without a worker, not as an uncaught error of the worker's.
 */
const pass = (req) => fetch(req).catch(() => Response.error());

/** A same-origin request outside /vm/: from a preview, relayed to its kernel and port; else the page's own. */
async function fromClient(event, url) {
	const client = await self.clients.get(event.clientId);
	const m = client ? PREVIEW_RE.exec(new URL(client.url).pathname) : null;
	if (m) return relay(event, m[1], Number(m[2]), url.pathname + url.search);
	if (client) {
		if (pageClients.size >= 256) pageClients.clear();
		pageClients.add(event.clientId);
	}
	return APP && isBuildFile(event.request, url) ? asset(event, url) : pass(event.request);
}

// --- the offline copy ----------------------------------------------------------

const isHtml = (r) => /^text\/html\b/i.test(r.headers.get("content-type") || "");
const cached = (cache, key) => cache.match(key, { ignoreVary: true });

/** The page's entry script (/assets/index-<hash>.js) in its HTML: it names the build. */
function entryOf(html) {
	for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
		if (!/\btype=["']?module\b/i.test(tag)) continue;
		const src = /\bsrc=["']?([^"'\s>]+)/i.exec(tag);
		if (src) return new URL(src[1], location.origin).pathname;
	}
	return "";
}

/** A navigation: / from the cache (checked in the background), anything else from the network, or / when offline. */
async function page(event, url) {
	const cache = await caches.open(CACHE);
	if (url.pathname === SHELL) {
		const hit = await cached(cache, SHELL);
		event.waitUntil(refresh());
		if (hit) return hit;
		return pass(event.request);
	}
	// /about from a preview, say: the server sends the page, which sends it back (src/preview.ts).
	try { return await fetch(event.request); }
	catch (e) { return (await cached(cache, SHELL)) ?? Promise.reject(e); }
}

/** One of the build's files (isBuildFile) for the page: from the cache, cached on a miss. */
async function asset(event, url) {
	const req = event.request;
	const key = url.pathname + url.search;
	const cache = await caches.open(CACHE);
	const hit = await cached(cache, key);
	if (hit) return hit;
	const res = await pass(req);
	if (res.status === 200 && res.type === "basic" && !isHtml(res)) event.waitUntil(cache.put(key, res.clone()).catch(() => {}));
	return res;
}

/** Files a new build's precache fetches at once. */
const PRECACHE_JOBS = 4;

/** fn on each item, at most `limit` at a time; rejects with the first failure. */
async function eachLimit(items, limit, fn) {
	let next = 0, failed = false;
	const run = async () => {
		while (!failed && next < items.length) {
			try { await fn(items[next++]); } catch (e) { failed = true; throw e; }
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** The running check: one at a time; a kw-check (not a navigation) within FRESH_MS of the last one takes its result. */
let refreshing = null, checkedAt = 0, netEntry = "";
function refresh(reuse = false) {
	if (refreshing) return refreshing;
	if (reuse && Date.now() - checkedAt < FRESH_MS) return Promise.resolve();
	refreshing = update().then((entry) => { netEntry = entry; checkedAt = Date.now(); },
		(e) => { netEntry = ""; console.warn(`[sw] the offline copy was not updated: ${e?.message ?? e}`); })
		.finally(() => { refreshing = null; });
	return refreshing;
}

/**
 * Fetch / and, when it differs from the cached one, cache every file of its
 * build first, then the page itself, and drop files no build kept needs.
 * Resolves with the network page's entry script ("" for no usable page).
 */
async function update() {
	const cache = await caches.open(CACHE);
	const res = await fetch(SHELL, { cache: "no-cache" });
	if (!res.ok || res.redirected || !isHtml(res)) return "";
	const html = await res.clone().text();
	const entry = entryOf(html);
	const old = await cached(cache, SHELL);
	if (old && (await old.text()) === html) return entry;
	const listRes = await fetch(LIST, { cache: "no-cache" });
	if (!listRes.ok) return ""; // a server without the list (not a production build)
	const files = (await listRes.clone().json())?.files;
	if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && f.startsWith("/assets/"))) throw new Error(`${LIST} is malformed`);
	// The page and the list from two different deploys: the next load tries again.
	if (!entry || !files.includes(entry)) throw new Error(`${LIST} does not list the page's ${entry || "entry script"}`);
	// A few at a time: the page may be loading the kernel meanwhile.
	await eachLimit(files, PRECACHE_JOBS, async (f) => {
		if (await cached(cache, f)) return;
		const r = await fetch(f); // the HTTP cache usually has it: hashed names are immutable
		if (r.status !== 200 || r.type !== "basic" || isHtml(r)) throw new Error(`GET ${f}: ${r.status}`);
		await cache.put(f, r);
	});
	const prev = await cached(cache, LIST);
	const prevFiles = prev ? ((await prev.clone().json().catch(() => null))?.files ?? []) : [];
	const same = prevFiles.length === files.length && prevFiles.every((f, i) => f === files[i]);
	let keepFiles = prevFiles;
	if (prev && !same) await cache.put(LIST_PREV, prev);
	else keepFiles = (await (await cached(cache, LIST_PREV))?.json().catch(() => null))?.files ?? [];
	await cache.put(LIST, listRes);
	await cache.put(SHELL, res);
	const keep = new Set([...files, ...(Array.isArray(keepFiles) ? keepFiles : [])]);
	for (const req of await cache.keys()) {
		const p = new URL(req.url);
		if (p.pathname.startsWith("/assets/") && !keep.has(p.pathname + p.search)) await cache.delete(req);
	}
	return entry;
}

// {t: "kw-check", entry} with a MessagePort, from src/sw.ts: is a build
// other than the asking page's cached and ready (update), and is the page's
// own build the cached one (offline)?
self.addEventListener("message", (event) => {
	const d = event.data, port = event.ports[0];
	if (!port || d?.t !== "kw-check") return;
	if (!APP) { port.postMessage({ t: "kw-check", update: false, offline: false }); return; }
	event.waitUntil((async () => {
		await refresh(true);
		const shell = await cached(await caches.open(CACHE), SHELL);
		const entry = shell ? entryOf(await shell.text()) : "";
		// Only what the network confirmed just now: a cached page older than the asking one is no update.
		port.postMessage({ t: "kw-check", update: !!netEntry && netEntry === entry && entry !== d.entry, offline: !!entry && entry === d.entry });
	})().catch((e) => port.postMessage({ t: "kw-check", error: String(e?.message ?? e) })));
});

function text(status, msg) {
	return new Response(`${msg}\n`, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
			"cross-origin-embedder-policy": COEP, "cross-origin-resource-policy": "same-origin",
		},
	});
}

/** A redirect to the guest itself (http://localhost:<port>/x) or to /x, kept under the prefix. */
function relocate(v, prefix, port) {
	if (v.startsWith("/") && !v.startsWith("//")) return prefix + v;
	if (!/^https?:\/\//i.test(v)) return v; // relative to the request: already under the prefix
	try {
		const u = new URL(v);
		const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
		if (local && u.protocol === "http:" && (u.port || "80") === String(port)) return prefix + u.pathname + u.search + u.hash;
	} catch { /* not a URL: as it is */ }
	return v;
}

async function relay(event, vmId, port, path) {
	const req = event.request;
	const prefix = `/vm/${vmId}/${port}`;
	if (port < 1 || port > 65535) return text(400, `Bad port in ${prefix}/`);
	const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
	const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	const pages = all.filter((c) => !new URL(c.url).pathname.startsWith("/vm/"));
	const gone = `No open unkernel page runs VM ${vmId}: the preview needs the page that started it, in this browser. ` +
		"Each boot gets a new id, so after a reload open the preview again from the page.";
	if (!pages.length) return text(502, gone);

	let finish;
	const done = new Promise((r) => { finish = r; });
	event.waitUntil(done); // keep this worker alive while the body streams
	return new Promise((resolve) => {
		let owner = null, timer = 0, ctrl = null, wake = null;
		const ports = [];
		const settle = (res) => { clearTimeout(timer); resolve(res); };
		const end = () => { clearTimeout(timer); for (const p of ports) p.close(); finish(); };
		const msg = { t: "kw-vm-fetch", vmId, port, method: req.method, path, headers: [...req.headers], body };
		for (const c of pages) {
			const ch = new MessageChannel();
			ports.push(ch.port1);
			ch.port1.onmessage = (e) => onMessage(ch.port1, e.data);
			c.postMessage(msg, [ch.port2]);
		}
		timer = setTimeout(() => { settle(text(502, gone)); end(); }, ACCEPT_MS);

		function onMessage(p, d) {
			if (!d || typeof d.t !== "string") return;
			if (!owner) {
				if (d.t !== "accept") return;
				owner = p;
				for (const q of ports) if (q !== p) q.close();
				ports.length = 0;
				ports.push(p);
				clearTimeout(timer);
				timer = setTimeout(() => { p.postMessage({ t: "cancel" }); settle(text(504, `The guest's port ${port} did not answer within ${HEAD_MS / 1000} s.`)); end(); }, HEAD_MS);
				return;
			}
			if (p !== owner) return;
			if (d.t === "head") head(d);
			else if (d.t === "chunk" && ctrl) ctrl.enqueue(new Uint8Array(d.data));
			else if (d.t === "end") { ctrl?.close(); ctrl = null; end(); }
			else if (d.t === "error") {
				if (ctrl) { ctrl.error(new Error(d.message)); ctrl = null; }
				else settle(text(d.status || 502, d.message || "The relay failed."));
				end();
			}
			if (wake) { const w = wake; wake = null; w(); }
		}

		function head(d) {
			if (d.status < 200 || d.status > 599) { settle(text(502, `The guest sent status ${d.status}.`)); end(); return; }
			const headers = new Headers();
			for (const [k, v] of d.headers) {
				const n = k.toLowerCase();
				if (DROP.has(n)) continue;
				try { headers.append(k, n === "location" ? relocate(v, prefix, port) : v); } catch { /* a value the browser refuses */ }
			}
			headers.set("cross-origin-embedder-policy", COEP);
			headers.set("cross-origin-resource-policy", "same-origin");
			let stream = null;
			if (!NULL_BODY.has(d.status) && req.method !== "HEAD") {
				stream = new ReadableStream({
					start(c) { ctrl = c; },
					// Resolves when the next message comes, so the stream does not pull again at once.
					pull() { owner.postMessage({ t: "more" }); return new Promise((r) => { wake = r; }); },
					cancel() { owner.postMessage({ t: "cancel" }); ctrl = null; end(); },
				});
			}
			let res;
			try { res = new Response(stream, { status: d.status, statusText: d.statusText, headers }); }
			catch { res = new Response(stream, { status: d.status, headers }); } // a reason phrase the browser refuses
			settle(res);
			if (!stream) { owner.postMessage({ t: "cancel" }); end(); }
		}
	});
}
