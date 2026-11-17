// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A secondary CPU's thread in browsers (started by cpu.ts): run it
// (core/cpu.ts) with what the first message brings. It finds nothing
// through import.meta.url: in the package it runs from a Blob URL. The
// build bundles it into a module that imports nothing.

import { runCpu, type CpuInit, type CpuMessage } from "../core/cpu.ts";

/** The dedicated worker's global (the page's tsconfig has no webworker lib). */
const scope = globalThis as unknown as {
	postMessage(msg: CpuMessage): void;
	addEventListener(type: "message", fn: (e: MessageEvent<CpuInit>) => void, opts: { once: true }): void;
};
scope.addEventListener("message", (e) => {
	const init = e.data;
	const post = (msg: CpuMessage) => scope.postMessage(msg);
	// runCpu() reports its own failures; this catches anything it did not
	// (a browser's worker reports no unhandled rejection to its owner).
	runCpu(init, { post }).catch((err: unknown) => post({ t: "fatal", msg: `CPU ${init.cpu}: ${(err as Error)?.stack ?? err}` }));
}, { once: true });
