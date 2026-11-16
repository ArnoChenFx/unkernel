// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Start a secondary CPU of an SMP kernel (cpu-entry.ts, core/cpu.ts) on a
// worker_threads Worker: Platform.spawnCpu on Node. Called from the
// kernel's own thread (the main thread inline, the kernel worker in worker
// mode). The worker gets the compiled module and the shared memory in its
// first message.

import { Worker } from "node:worker_threads";
import type { CpuEndpoint, CpuInit, CpuMessage } from "../core/cpu.ts";

export function spawnNodeCpu(init: CpuInit): CpuEndpoint {
	const w = new Worker(new URL("./cpu-entry.ts", import.meta.url));
	// The CPU never keeps the process alive: CPU 0's exit ends the session.
	w.unref();
	w.postMessage(init);
	return {
		listen(h) {
			w.on("message", (m: CpuMessage) => h.message(m));
			w.on("error", h.error);
		},
		terminate: () => void w.terminate(),
	};
}
