// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// JSPI (WebAssembly JavaScript Promise Integration), which TypeScript's
// libs do not declare yet. Used inside the runtime only; no public type
// refers to it.

declare namespace WebAssembly {
	/** Wraps a host function that may return a promise; the calling wasm stack suspends until it settles. */
	class Suspending {
		constructor(fn: (...args: any[]) => unknown);
	}
	/** Wraps a wasm export that may suspend; calling it returns a promise of its result. */
	function promising(fn: (...args: any[]) => unknown): (...args: any[]) => Promise<unknown>;
}
