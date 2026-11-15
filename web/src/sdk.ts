// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The SDK from source (the page is built with it, not with the published
// dist/), with the page's own kernel: web/kernel/unkernel-alpine.wasm, the
// bundle of the newest GitHub release (web/scripts/kernel.ts fetches it when
// the dev server starts or the page is built), a Vite asset. js/web.ts is not imported, so the SDK's own bundled kernel (the
// symlink into vendor/) is not part of the page.
import { createKernelOn, type CreateKernelOptions, type KernelHandle, type KernelInstance, type WorkerOption } from "../../js/core/instance.ts";
import type { WorkerKernel } from "../../js/core/worker-host.ts";
import { webPlatform } from "../../js/web/platform.ts";

export * from "../../js/core/index.ts";
export { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB } from "../../js/web/memory.ts";
export { DATA_DISK_NAME, importDataDisk, openDataDisk, resetDataDisk } from "../../js/web/disk.ts";

/** The kernel with Alpine bundled (vmlinux32.wasm + the initramfs, kernel/tools/bundle.mjs). */
export const kernelUrl: URL = new URL("../kernel/unkernel-alpine.wasm", import.meta.url);

const platform = webPlatform(kernelUrl);

/**
 * js/web.ts's createKernel(), with the page's kernel as the default; with
 * `worker: true` (?worker=1) on a Web Worker (js/web/worker.ts, which Vite
 * bundles as a worker).
 */
export function createKernel(opts: CreateKernelOptions & { worker: true }): Promise<WorkerKernel>;
export function createKernel(opts?: CreateKernelOptions & { worker?: false }): Promise<KernelInstance>;
export function createKernel(opts?: CreateKernelOptions & WorkerOption): Promise<KernelHandle>;
export function createKernel(opts: CreateKernelOptions & WorkerOption = {}): Promise<KernelHandle> {
	return createKernelOn(platform, opts);
}
