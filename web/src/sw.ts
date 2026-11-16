// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's service worker (public/vm-sw.js): its registration, which
// preview.ts shares. The scope is /vm/, the guest preview only: the page
// and its build's files always come from the network (and the HTTP cache).
// .agents/web.md, Guest preview, has the design.

const SW_URL = "/vm-sw.js";
const SCOPE = "/vm/";
/** The tab came back after this long: check for a new vm-sw.js again. */
const RECHECK_MS = 3600_000;

/** Service workers exist (secure contexts: https, localhost). */
export const swSupported = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator && isSecureContext;

let reg: Promise<ServiceWorkerRegistration> | null = null;
/** When this page last looked for a new vm-sw.js. */
let checkedAt = Date.now();

/** Register the worker (once); resolves when a worker is active. */
export function serviceWorker(): Promise<ServiceWorkerRegistration> {
	if (!swSupported()) return Promise.reject(new Error("service workers need a secure context (https or localhost)"));
	reg ??= register();
	return reg;
}

async function register(): Promise<ServiceWorkerRegistration> {
	// Not navigator.serviceWorker.ready: the scope /vm/ does not control this page, so it never resolves.
	const r = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE, updateViaCache: "none" });
	// register() with an unchanged URL does not look for a new script, and loads of / are not in
	// the scope, so nothing else would: ask now. A new vm-sw.js activates at once (skipWaiting).
	if (r.active) r.update().catch(() => {});
	else {
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
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && Date.now() - checkedAt >= RECHECK_MS) {
			checkedAt = Date.now();
			r.update().catch(() => {});
		}
	});
	return r;
}

/**
 * Builds that kept an offline copy registered the same script at scope /,
 * where it answered / and /assets/ from the Cache API. Drop that
 * registration (the worker itself deleted its caches when the new
 * vm-sw.js reached it). Called on every load, not only once the preview
 * starts, so that the next load cannot come from it.
 */
export function dropLegacyScope(): void {
	if (!swSupported()) return;
	navigator.serviceWorker.getRegistration("/").then((old) => {
		if (old && new URL(old.scope).pathname === "/") return old.unregister();
	}).catch(() => {});
}
