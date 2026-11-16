// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A secondary CPU's thread on Node (started by cpu.ts): run it
// (core/cpu.ts) with what the first message brings.

import { parentPort } from "node:worker_threads";
import { runCpu, type CpuInit } from "../core/cpu.ts";

const port = parentPort;
if (!port) throw new Error("unkernel: a CPU runs only in a worker thread (cpu.ts)");
port.once("message", (init: CpuInit) => {
	void runCpu(init, { post: (msg) => port.postMessage(msg) });
});
