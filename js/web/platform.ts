// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel()'s browser platform: memory sized for the device (decided
// here, on the page's thread, since a worker has no say in it), worker mode
// on a Web Worker (worker.ts), and relative locations made absolute against
// the page, because the worker (a Blob URL in the package) has no useful
// base URL. Disk and network specs are built by webDevices (devices.ts).
// The entry (web.ts, or the page's web/src/sdk.ts) passes the
// default kernel's URL, so `new URL(..., import.meta.url)` stays in it.

import type { Platform } from "../core/instance.ts";
import { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB } from "./memory.ts";
import { webDevices } from "./devices.ts";
import { spawnWebWorker } from "./worker.ts";

export function webPlatform(defaultKernel: URL): Platform {
	return {
		defaultKernel: () => defaultKernel,
		defaultMemoryMiB: () => autoMemoryMiB().mib,
		defaultMemoryFallbackMiB: [...DEFAULT_MEMORY_FALLBACK_MIB],
		spawnWorker: spawnWebWorker,
		absoluteUrl: (src) => new URL(src, location.href).href,
		devices: webDevices,
	};
}
