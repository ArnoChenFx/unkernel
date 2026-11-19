// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A guest WASI program's worker in browsers (started by wasi.ts): run the
// program the first message brings (core/wasi-program.ts). The build
// bundles it into a module that imports nothing.

import { serveWasiProgram, type WasiFromProgram, type WasiToProgram } from "../core/wasi-program.ts";

/** The dedicated worker's global (the page's tsconfig has no webworker lib). */
const scope = globalThis as unknown as {
	postMessage(msg: WasiFromProgram, transfer: Transferable[]): void;
	addEventListener(type: "message", fn: (e: MessageEvent<WasiToProgram>) => void): void;
};
serveWasiProgram({
	post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
	listen: (handler) => scope.addEventListener("message", (e) => handler(e.data)),
});
