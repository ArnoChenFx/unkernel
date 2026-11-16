// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest preview: a web server running in the guest (e.g. on port 8000)
// shown in an iframe (components/Preview.tsx) or a tab at
// /vm/<vmId>/<port>/. The page's service worker public/vm-sw.js (sw.ts)
// relays those requests here; this page answers the ones for its vmId (a
// random id per booted kernel) with vm.fetch() on the guest's
// 127.0.0.1:<port>, and streams the body back in chunks. The message format
// is at the top of vm-sw.js. Secure contexts only (service workers), and
// same-origin: the guest's pages can reach this page, so trusted content
// only. .agents/web.md (Guest preview) lists the limits.
import { useSyncExternalStore } from "react";
import { ui$ } from "./store.ts";
import { serviceWorker, swSupported } from "./sw.ts";
import { store } from "./ui.ts";

/** What the relay needs of the kernel handle: the SDK's vm.fetch(). */
export interface GuestFetcher {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface RelayRequest {
	t: "kw-vm-fetch";
	vmId: string;
	port: number;
	method: string;
	/** Path and query. */
	path: string;
	headers: [string, string][];
	body: ArrayBuffer | null;
}

/** Relayed requests running at once; the rest wait. Each guest connection forks a server process. */
const MAX_ACTIVE = 8;
/** Chunks sent ahead of the service worker's asking. */
const CREDITS = 4;
/** Not passed on to the guest: hop-by-hop, and what vm.fetch() sets itself. */
const SKIP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "accept-encoding"]);

/** Service workers exist (secure contexts: https, localhost). */
export const previewSupported = swSupported;

let vm: GuestFetcher | null = null;
let vmId = "";
let sw: Promise<void> | null = null;
let attached: () => void = () => {};
const attachedP = new Promise<void>((r) => { attached = r; });
let active = 0;
const waiting: Array<() => void> = [];

/** The preview URL of a guest port on this page's kernel. */
export const previewUrl = (port: number, path = "/"): string => `/vm/${vmId}/${port}${path}`;

/**
 * Serve previews for this kernel handle (boot.ts, once it runs; null once
 * it stopped: requests then get 503). The first call registers the service
 * worker and picks the vmId.
 */
export function attachPreview(handle: GuestFetcher | null): void {
	vm = handle;
	if (!handle || vmId) return;
	vmId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
	if (previewSupported()) {
		navigator.serviceWorker.addEventListener("message", onRelay);
		navigator.serviceWorker.startMessages(); // this page is not controlled (the scope is /vm/)
		sw = serviceWorker().then(() => {});
		sw.catch((e: Error) => console.warn(`[preview] the service worker failed: ${e.message}`));
	}
	attached();
}

/** Resolves once previews can load: the kernel runs and the service worker is active. */
export async function previewReady(): Promise<void> {
	if (!previewSupported()) throw new Error("The preview needs a secure context (https or localhost): it runs on a service worker.");
	await attachedP;
	await sw;
}

function onRelay(e: MessageEvent) {
	const d = e.data as Partial<RelayRequest> | null;
	const port = e.ports[0];
	// Another tab's kernel: its own page answers.
	if (!port || d?.t !== "kw-vm-fetch" || !vmId || d.vmId !== vmId) return;
	port.postMessage({ t: "accept" });
	void serve(d as RelayRequest, port);
}

const slot = (): Promise<void> => {
	if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
	return new Promise((r) => waiting.push(() => { active++; r(); }));
};
const release = () => { active--; waiting.shift()?.(); };

async function serve(r: RelayRequest, port: MessagePort) {
	const abort = new AbortController();
	let cancelled = false, credits = CREDITS;
	let wake: (() => void) | null = null;
	port.onmessage = (e: MessageEvent<{ t?: string }>) => {
		if (e.data?.t === "more") credits++;
		else if (e.data?.t === "cancel") { cancelled = true; abort.abort(); }
		const w = wake;
		wake = null;
		w?.();
	};
	await slot();
	try {
		if (cancelled) return;
		const handle = vm;
		if (!handle) { port.postMessage({ t: "error", status: 503, message: "The kernel is not running: reboot it, then open the preview again." }); return; }
		if (typeof handle.fetch !== "function") { port.postMessage({ t: "error", status: 501, message: "This kernel handle has no fetch()." }); return; }
		const headers = new Headers();
		for (const [k, v] of r.headers) {
			if (SKIP.has(k.toLowerCase())) continue;
			try { headers.append(k, v); } catch { /* a value Headers refuses */ }
		}
		headers.set("accept-encoding", "identity"); // a synthesized response is not decoded by the browser
		const guest = `http://localhost:${r.port}`;
		if (headers.has("origin")) headers.set("origin", guest); // as the guest's server sees itself (CSRF checks)
		let res: Response;
		try {
			res = await handle.fetch(guest + r.path, { method: r.method, headers, body: r.body, redirect: "manual", signal: abort.signal });
		} catch (e) {
			if (!cancelled) port.postMessage({ t: "error", status: 502, message: `Nothing answered on the guest's port ${r.port} (${(e as Error)?.message ?? e}). Is a server listening there?` });
			return;
		}
		port.postMessage({ t: "head", status: res.status, statusText: res.statusText, headers: [...res.headers] });
		const reader = res.body?.getReader();
		if (reader) {
			for (;;) {
				while (credits <= 0 && !cancelled) await new Promise<void>((w) => { wake = w; });
				if (cancelled) { void reader.cancel().catch(() => {}); return; }
				const { done, value } = await reader.read();
				if (done) break;
				if (!value?.byteLength) continue;
				const copy = value.slice(); // its own ArrayBuffer to transfer (the stream's may be shared or reused)
				credits--;
				port.postMessage({ t: "chunk", data: copy.buffer }, [copy.buffer]);
			}
		}
		if (!cancelled) port.postMessage({ t: "end" });
	} catch (e) {
		if (!cancelled) port.postMessage({ t: "error", status: 502, message: `The guest's response failed: ${(e as Error)?.message ?? e}` });
	} finally {
		release();
		port.close();
	}
}

/**
 * A guest page in the preview followed a root-relative link or redirect out
 * of /vm/<id>/<port>/, which the service worker cannot catch (navigations
 * outside its scope reach the server, which sends this page): the way back
 * under the prefix, or null. main.tsx then goes there instead of booting a
 * second kernel. Known from the iframe's data-kw-preview, or in a tab from
 * the referrer.
 */
export function previewEscape(): string | null {
	if (location.pathname.startsWith("/vm/")) return null;
	let from = "";
	try { from = (window.frameElement as HTMLElement | null)?.dataset.kwPreview ?? ""; } catch { /* a cross-origin parent */ }
	if (!from && document.referrer) {
		try {
			const u = new URL(document.referrer);
			if (u.origin === location.origin) from = u.pathname;
		} catch { /* not a URL */ }
	}
	const m = /^\/vm\/[\w-]+\/\d+(?=\/)/.exec(from);
	return m ? m[0] + location.pathname + location.search + location.hash : null;
}

// ---- the preview panel's actions (Ctrl-A p, the System tab, the status line, KW.preview) ----
const portOf = (v: unknown): number | null => {
	const n = Number(v);
	return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

/** The port opened last (kept in localStorage), else 8000. */
export const lastPreviewPort = (): number => portOf(store("previewPort")) ?? 8000;

/** Open the preview panel on a guest port (shown; replaces the port shown). False: not a port. */
export function openPreview(port: number | string = lastPreviewPort()): boolean {
	const n = portOf(port);
	if (n === null) return false;
	store("previewPort", String(n));
	ui$().set((s) => ({ preview: { port: n, shown: true, fill: s.preview?.fill ?? false } }));
	return true;
}

export function closePreview(): void { ui$().set({ preview: null }); }

/** Ctrl-A p and the status line: open it, else show or hide it (the page in it stays loaded). */
export function togglePreview(): void {
	const p = ui$().get().preview;
	if (!p) openPreview();
	else ui$().set({ preview: { ...p, shown: !p.shown } });
}

/** [□]: fill the stage, or dock beside the terminal. */
export function setPreviewFill(fill: boolean): void {
	const p = ui$().get().preview;
	if (p) ui$().set({ preview: { ...p, fill } });
}

/** Under this window width (px) the preview always fills the stage. */
export const PREVIEW_NARROW = 720;
const narrowNow = () => innerWidth < PREVIEW_NARROW;
const onResize = (cb: () => void) => { addEventListener("resize", cb); return () => removeEventListener("resize", cb); };
/** True while the window is narrower than PREVIEW_NARROW (re-renders on resize). */
export const useNarrow = (): boolean => useSyncExternalStore(onResize, narrowNow);

/**
 * The preview is shown and covers the stage (narrow, or [□]): then it is
 * one of the views like a terminal window or the display, and picking
 * another one hides it.
 */
export function previewCovers(p = ui$().get().preview, narrow = narrowNow()): boolean {
	return !!p?.shown && (p.fill || narrow);
}
/** Another view was picked (a terminal window, the display): hide the preview if it covers the stage. */
export function yieldPreview(): void {
	const p = ui$().get().preview;
	if (p && previewCovers(p)) ui$().set({ preview: { ...p, shown: false } });
}
