// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's WASI programs in browsers (core/wasi-exec.ts): each in a
// module Web Worker running web-wasi-entry.ts, started by the owner of
// vm.vsock (the page's thread, or the thread that runs the kernel inline).
// A cross-origin isolated page passes requests through a SharedArrayBuffer
// (no JSPI needed); any other needs JSPI in workers. The counterpart of
// js/node/wasi.ts.
//
// From source (Vite) the worker is `new Worker(new URL(...), { type:
// "module" })` on the entry file. `pnpm build` (build.config.ts, WORKERS)
// replaces the URL below (the expression must appear exactly once in this
// file) with inlineWasiUrl(code): a Blob URL, revoked once the worker has
// started.

import type { Vsock } from "../core/vsock.ts";
import { serveWasiProgramsWith, type WasiExecOptions, type WasiExecServer } from "../core/wasi-exec.ts";
import type { WasiFromProgram, WasiProgramEndpoint } from "../core/wasi-program.ts";

let blobUrl: string | undefined;

/** @internal The dist's WASI program worker: its code (inlined by the build) as a Blob URL. */
export function inlineWasiUrl(code: string): URL {
	blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
	return new URL(blobUrl);
}

export function spawnWebWasi(): WasiProgramEndpoint {
	blobUrl = undefined;
	const w = new Worker(new URL("./web-wasi-entry.ts", import.meta.url), { type: "module", name: "unkernel-wasi" });
	const url = blobUrl as string | undefined;
	const revoke = () => {
		if (url) URL.revokeObjectURL(url);
	};
	w.addEventListener("message", revoke, { once: true });
	w.addEventListener("error", revoke, { once: true });
	let onExit: (() => void) | undefined;
	return {
		post: (msg, transfer) => w.postMessage(msg, transfer ?? []),
		listen(h) {
			onExit = h.exit;
			w.addEventListener("message", (e: MessageEvent<WasiFromProgram>) => h.message(e.data));
			w.addEventListener("messageerror", () => h.error(new Error("a message from a WASI program's worker could not be read (structured clone failed)")));
			// A script that fails to load or throws at top level: an ErrorEvent, often without a message.
			w.addEventListener("error", (e) => {
				e.preventDefault();
				h.error(new Error(e.message || "a WASI program's worker failed to start (its script did not load, or threw before it ran)"));
			});
		},
		// A Web Worker has no exit event: it is gone once terminated.
		terminate: () => {
			w.terminate();
			const exit = onExit;
			onExit = undefined;
			exit?.();
		},
	};
}

/** Run the guest's WASI programs (kwwasi, vsock port 1021) on this host, each in a Web Worker. */
export function serveWasiPrograms(vsock: Vsock, opts: WasiExecOptions = {}): WasiExecServer {
	return serveWasiProgramsWith(vsock, { ...opts, spawn: spawnWebWasi });
}
