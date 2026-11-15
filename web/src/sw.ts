// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's service worker (public/vm-sw.js): its registration, which
// preview.ts shares, and the update check. In a production build the scope
// is /, so the worker also keeps the offline copy: the page and its build's
// files, the kernel among them, answered from the Cache API. Under the dev
// server it is /vm/ (the preview only), so Vite's modules are never cached.
// .agents/web.md, Offline and updates, has the design.

const SW_URL = "/vm-sw.js";
const SCOPE = import.meta.env.PROD ? "/" : "/vm/";
/** The tab came back after this long: check for an update again. */
const RECHECK_MS = 3600_000;

/** Service workers exist (secure contexts: https, localhost). */
export const swSupported = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator && isSecureContext;

let reg: Promise<ServiceWorkerRegistration> | null = null;

/** Register the worker (once); resolves when a worker is active. */
export function serviceWorker(): Promise<ServiceWorkerRegistration> {
	if (!swSupported()) return Promise.reject(new Error("service workers need a secure context (https or localhost)"));
	reg ??= register();
	return reg;
}

async function register(): Promise<ServiceWorkerRegistration> {
	// Not navigator.serviceWorker.ready: under /vm/ the worker does not control this page, so it never resolves.
	const r = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE, updateViaCache: "none" });
	if (!r.active) {
		const w = r.installing ?? r.waiting;
		if (!w) throw new Error("the service worker did not install");
		await new Promise<void>((resolve, reject) => {
			const check = () => {
				if (w.state === "activated") resolve();
				else if (w.state === "redundant") reject(new Error("the service worker failed to install"));
			};
			w.addEventListener("statechange", check);
			check();
		});
	}
	// Pages before the offline copy registered the same script at /vm/: scope / covers it now.
	if (SCOPE === "/") {
		navigator.serviceWorker.getRegistration("/vm/").then((old) => {
			if (old && new URL(old.scope).pathname === "/vm/") return old.unregister();
		}).catch(() => {});
	}
	return r;
}

export interface UpdateStatus {
	/** A newer build is cached and ready: a reload starts it. */
	update: boolean;
	/** This build is the cached one: it loads without the network. */
	offline: boolean;
}

/** This page's entry script (/assets/index-<hash>.js), which names its build. */
function entryScript(): string {
	const s = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
	return s ? new URL(s.src).pathname : "";
}

async function check(): Promise<UpdateStatus> {
	const w = (await serviceWorker()).active;
	if (!w) throw new Error("no active service worker");
	const ch = new MessageChannel();
	const reply = new Promise<UpdateStatus & { error?: string }>((resolve) => { ch.port1.onmessage = (e) => resolve(e.data); });
	w.postMessage({ t: "kw-check", entry: entryScript() }, [ch.port2]);
	const r = await reply;
	ch.port1.close();
	if (r.error) throw new Error(r.error);
	return { update: !!r.update, offline: !!r.offline };
}

/**
 * Production builds in a secure context: register the worker, which
 * updates the offline copy, and report the outcome (onStatus) now and when
 * the tab comes back after an hour. boot.ts calls it once the kernel is
 * downloaded, so that on a first visit the worker caches it from the HTTP
 * cache instead of downloading it a second time.
 */
export function watchUpdates(onStatus: (s: UpdateStatus | { error: string }) => void): void {
	if (!import.meta.env.PROD || !swSupported()) return;
	let at = 0;
	const run = () => {
		at = Date.now();
		check().then(onStatus, (e: Error) => onStatus({ error: e?.message ?? String(e) }));
	};
	run();
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible" || Date.now() - at < RECHECK_MS) return;
		reg?.then((r) => r.update()).catch(() => {}); // a new vm-sw.js too
		run();
	});
}
