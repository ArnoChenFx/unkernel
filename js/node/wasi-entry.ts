// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A guest WASI program's worker thread on Node (started by wasi.ts): run
// the program the first message brings (core/wasi-program.ts).

import { parentPort } from "node:worker_threads";
import { serveWasiProgram } from "../core/wasi-program.ts";

const port = parentPort;
if (!port) throw new Error("unkernel: a WASI program runs only in a worker thread (wasi.ts)");
serveWasiProgram({
	post: (msg, transfer) => port.postMessage(msg, transfer),
	listen: (handler) => port.on("message", handler),
});
