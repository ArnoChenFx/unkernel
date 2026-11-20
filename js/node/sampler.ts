// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The profiler's time sampler (core/profile.ts) on a worker_threads Worker:
// Platform.spawnSampler on Node. Called from the kernel's own thread. The
// worker runs a few lines of code from a string (nothing to bundle): every
// period (Atomics.wait with a timeout as the clock) it sets the profile bit
// in each CPU's word of pending interrupts with Atomics.or, without a
// notify, and counts the ticks and the ones whose last bit was still set.

import { Worker } from "node:worker_threads";
import type { SamplerHandle, SamplerInit } from "../core/profile.ts";

const SAMPLER = `"use strict";
const { workerData: d } = require("node:worker_threads");
const mem = new Int32Array(d.buffer), ctl = new Int32Array(d.ctl);
const n = d.cpus, bit = 1 << d.bit, words = d.words >> 2;
let next = performance.now();
for (;;) {
	next += d.periodMs;
	let wait = next - performance.now();
	if (wait < -50 * d.periodMs) next = performance.now(); // descheduled for long: no burst of ticks
	if (wait > 0) Atomics.wait(ctl, 0, 0, wait);
	if (Atomics.load(ctl, 0)) break;
	for (let c = 0; c < n; c++) {
		const w = c === 0 ? d.irq0 : Atomics.load(mem, words + c) >>> 0;
		if (!w) continue;
		Atomics.add(ctl, 1 + c, 1);
		if (Atomics.or(mem, w >> 2, bit) & bit) Atomics.add(ctl, 1 + n + c, 1);
	}
}
`;

export function spawnNodeSampler(init: SamplerInit): SamplerHandle {
	const w = new Worker(SAMPLER, { eval: true, workerData: init });
	// The sampler never keeps the process alive.
	w.unref();
	w.on("error", () => {});
	return {
		stop() {
			const ctl = new Int32Array(init.ctl);
			Atomics.store(ctl, 0, 1);
			Atomics.notify(ctl, 0);
			void w.terminate();
		},
	};
}
