// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel()'s Node platform: file paths and file: URLs are read from
// disk, disk and network specs are built by nodeDevices (devices.ts), and
// worker mode runs on worker_threads (worker.ts). The bundled
// kernel's URL is passed in by the entry (node.ts) so that
// `new URL(..., import.meta.url)` stays in the entry module itself (a shared
// chunk lives in dist/_chunks/, which would resolve next to the chunk).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Platform } from "../core/instance.ts";
import { BootError } from "../core/load.ts";
import { nodeDevices } from "./devices.ts";
import { spawnNodeCpu } from "./cpu.ts";
import { spawnNodeWorker } from "./worker.ts";

/** A file: URL, or a string without a URL scheme (a path). */
function localPath(src: URL | string): string | undefined {
	if (src instanceof URL) return src.protocol === "file:" ? fileURLToPath(src) : undefined;
	if (src.startsWith("file:")) return fileURLToPath(src);
	return /^[a-z][a-z0-9+.-]+:/i.test(src) ? undefined : src;
}

/** Platform.readFile for Node: file: URLs and paths from disk, anything else fetched. */
export function nodeReadFile(bundledPath?: string): NonNullable<Platform["readFile"]> {
	return (src) => {
		const path = localPath(src);
		if (path === undefined) return undefined;
		return readFile(path).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength), (e: NodeJS.ErrnoException) => {
			const hint = e.code === "ENOENT" && path === bundledPath
				? " (the bundled kernel is missing; in a source checkout, build it with kernel/build.sh bundle)" : "";
			throw new BootError("download", `cannot read ${path}: ${e.message}${hint}`, { cause: e });
		});
	};
}

export function nodePlatform(bundledKernel: URL): Platform {
	return {
		defaultKernel: () => bundledKernel,
		readFile: nodeReadFile(fileURLToPath(bundledKernel)),
		spawnWorker: spawnNodeWorker,
		spawnCpu: spawnNodeCpu,
		absoluteUrl: (src) => pathToFileURL(resolve(src)).href,
		devices: nodeDevices,
	};
}
