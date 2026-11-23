// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's side of remote mode (remote/README.md): what changes when the
// kernel runs in the backend (remote/backend.ts) instead of in this page. The
// upstream page only calls into this file: main.tsx for the configuration
// (remoteConfig), boot.ts for the link, its data disk errors and the kernel
// it creates. The SDK is used as it is (createKernelOn with a link as the
// worker's endpoint).

import { glUrl, kernelUrl } from "virtual:unkernel-kernel";
import { createKernelOn, type CreateKernelOptions, type WorkerOption } from "../../js/core/instance.ts";
import type { WorkerKernel } from "../../js/core/worker-host.ts";
import { webPlatform } from "../../js/web/platform.ts";
import type { Config } from "../../web/src/config.ts";
import type { CheckResult } from "../../web/src/store.ts";
import { RemoteLink } from "./link.ts";

export type { RemoteLink } from "./link.ts";

const platform = webPlatform(kernelUrl, glUrl ?? undefined);

const REMOTE_GL_WHY = "remote mode: guest GL is not carried over the link";

/** The backend's page carries this meta tag (remote/server.ts): its kernel runs in the backend by default. */
function backendPage(): boolean {
	return typeof document !== "undefined" && document.querySelector('meta[name="unkernel-remote"]')?.getAttribute("content") === "1";
}

/**
 * The configuration with remote mode on or off (?remote=1|0; by default on
 * where the backend serves the page). On: one CPU in a worker whose messages
 * travel on the link, no shared memory, no guest GL, no suspend or session
 * resume, the data disk, /work and the network on the backend's computer.
 */
export function remoteConfig(c: Config, search: string = location.search): Config {
	const url = new URLSearchParams(search);
	const remote = url.has("remote") ? url.get("remote") === "1" : backendPage();
	if (!remote) return { ...c, remote };
	return {
		...c,
		remote,
		workerParam: true,
		worker: true,
		cpus: 1,
		smpParam: 1,
		cpuDefault: 1,
		resumeCpus: 0,
		shared: false,
		autosuspend: null,
		autosuspendParam: "0",
		askLeave: false,
		shm: false,
		glWhy: c.glParam ? REMOTE_GL_WHY : null,
		gl: false,
		gpu: false,
	};
}

/** The message a refused data disk operation throws (export, import, reset): the disk is the backend's file. */
export const remoteDataError = (): Error => new Error("remote mode: the data disk is a file on the backend's computer (its --data), which this page does not export, replace or reset");

interface RemoteReport {
	check(id: string, label: string, r: CheckResult, value: string, note?: string): void;
	hostLog(m: string): void;
}

/** Connects to the backend that serves this page, and reports what it offers (its hello) on the boot checks. */
export async function connectRemote(ui: RemoteReport): Promise<RemoteLink> {
	const link = await RemoteLink.connect(location.origin);
	const h = link.hello;
	ui.check("remote", "Remote kernel", "pass", location.origin, `wire ${h.wire}; data disk ${h.data ?? "none"}; /work ${h.work ?? "none"}; network ${h.net ? "the backend's (direct host sockets)" : "none"}`);
	ui.hostLog(`[host] remote kernel at ${location.origin}: data disk ${h.data ?? "none"}, /work ${h.work ?? "none"}`);
	return link;
}

/**
 * createKernel({ worker: true }) with the kernel in the remote backend: the
 * link's WebSocket is the kernel's worker endpoint. The backend's kernel shares
 * no memory with the page, so input and frames are messages even where the
 * page is cross-origin isolated.
 */
export function createRemoteKernel(link: RemoteLink, opts: CreateKernelOptions & WorkerOption & { worker: true }): Promise<WorkerKernel> {
	const workerOpts: CreateKernelOptions & WorkerOption & { worker: true } = { ...opts, shared: false };
	return createKernelOn({ ...platform, spawnWorker: () => link.endpoint() }, workerOpts);
}
