// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The backend's end of the remote kernel, on Node or Bun (remote/web/link.ts is
// the page's). A RemoteHub takes one page at a time, and the RemoteKernel for
// it runs the kernel in a worker thread (worker.ts). The boot spec the page
// sends is rewritten here rather than trusted: its kernel and distro are URLs
// the host maps to files (RemoteHost.file), its data disk is the host's image
// (RemoteHost.dataDisk), its network is direct host sockets, and anything
// else the worker would open is refused. /work is a host directory behind the
// file calls of the wire (workFs).

import { pathToFileURL } from "node:url";
import { REMOTE_WIRE, decodeRemote, encodeRemote, remoteError, remoteFsServer, type RemoteFsOp, type RemoteFsServer, type RemoteReply, type RemoteRequest } from "./wire.ts";
import { FsError, type Fs, type FsAttr, type FsFile } from "../js/core/fs.ts";
import type { DiskSpec } from "../js/core/devices.ts";
import type { FromWorker, ToWorker, WorkerBootSpec, WorkerEndpoint } from "../js/core/worker-protocol.ts";
import { spawnNodeWorker } from "../js/node/worker.ts";
import { nodeFs } from "../js/node/nodefs.ts";

/**
 * The host's side of one kernel: the files the page's URLs stand for, the
 * data disk, /work and the network. A refusal is an Error from here, which
 * the page sees as a failed boot.
 */
export interface RemoteHost {
	/** The local file of a kernel or distro URL under the backend's origin (role "distro": a copy the running guest may keep). */
	file(url: string, role: "kernel" | "distro"): Promise<string>;
	/** The data disk's image file, created from the kernel at `kernelPath` when missing. */
	dataDisk(kernelPath: string): Promise<string>;
	/** The host directory of /work, when the backend has one. */
	work?: string;
	/** The data disk's file, as the page shows it. */
	data?: string;
	/** Whether the kernel may use the network (direct host sockets). */
	net: boolean;
	log(line: string): void;
}

/** One WebSocket to a page: frames out, and closing it. */
export interface RemoteSocket {
	send(frame: Uint8Array): void;
	close(code: number, reason: string): void;
}

const STOP_TIMEOUT_MS = 20000;
const SYNC_TIMEOUT_MS = 15000;

/**
 * /work's file system: nodeFs with modes the guest can use. Windows reports
 * directories without an execute bit, so the guest could not enter them
 * (EACCES), and reports no execute bit on files either; so on Windows files
 * get it too, as WSL's drvfs shows them. Elsewhere only directories do.
 */
export function workFs(dir: string, platform: NodeJS.Platform = process.platform): Fs {
	const base = nodeFs(dir);
	const withMode = (a: FsAttr): FsAttr => {
		if (a.type === "symlink") return a;
		const mode = a.mode ?? (a.type === "dir" ? 0o755 : 0o644);
		return { ...a, mode: a.type === "dir" || platform === "win32" ? mode | 0o111 : mode };
	};
	const file = (f: FsFile): FsFile => ({ ...f, getattr: f.getattr ? async () => withMode(await f.getattr!()) : undefined });
	return {
		...base,
		getattr: async (p) => withMode(await base.getattr(p)),
		open: async (p, flags) => file(await base.open(p, flags)),
		create: base.create ? async (p, mode) => file(await base.create!(p, mode)) : undefined,
	};
}

/** Resolves when `p` settles or after `ms`, whichever comes first, and the timer is cleared. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
	return Promise.race([p.then(() => undefined), late]).finally(() => clearTimeout(timer));
}

/** One page's kernel: its socket, its worker and its /work calls. */
export class RemoteKernel {
	/** Resolves once the kernel is stopped and the socket is closed. */
	readonly finished: Promise<void>;
	#socket: RemoteSocket;
	#host: RemoteHost;
	#queue: Promise<void>;
	#resolveFinished!: () => void;
	#worker?: WorkerEndpoint;
	#fs?: RemoteFsServer;
	#open = true;
	#ending?: Promise<void>;
	#started = false;
	#exited = false;
	#resolveExit!: () => void;
	#exitedSignal: Promise<void>;
	#syncWaiters = new Map<number, () => void>();
	#nextSyncId = -1;

	constructor(socket: RemoteSocket, host: RemoteHost, after: Promise<void> = Promise.resolve()) {
		this.#socket = socket;
		this.#host = host;
		this.finished = new Promise((resolve) => (this.#resolveFinished = resolve));
		this.#exitedSignal = new Promise((resolve) => (this.#resolveExit = resolve));
		if (host.work) this.#fs = remoteFsServer(workFs(host.work));
		this.#send({
			k: "hello", wire: REMOTE_WIRE, fs: this.#fs?.caps ?? null, net: host.net,
			data: host.data ?? null, work: host.work ?? null,
		});
		this.#queue = after.then(() => this.#spawn());
	}

	/** A binary frame from the page. */
	receive(frame: Uint8Array): void {
		let msg: RemoteRequest;
		try {
			msg = decodeRemote(frame) as RemoteRequest;
		} catch (e) {
			this.#host.log(`remote: a frame that does not decode (${(e as Error).message})`);
			this.#socket.close(1003, "bad frame");
			return;
		}
		if (msg.k === "fs") {
			void this.#fsCall(msg.id, msg.op, msg.a);
			return;
		}
		this.#queue = this.#queue.then(() => this.#kernelCall(msg.m)).catch((e) => this.#host.log(`remote: ${(e as Error)?.message ?? e}`));
	}

	/** The page closed its socket: stop the kernel. */
	closed(): void {
		this.#open = false;
		void this.end("the page closed the connection");
	}

	/** Sync the guest, stop it and its worker. Idempotent; resolves with `finished`. */
	end(reason: string): Promise<void> {
		this.#ending ??= this.#stop(reason);
		return this.#ending;
	}

	#spawn(): void {
		if (this.#ending) return;
		const worker = spawnNodeWorker();
		this.#worker = worker;
		worker.listen({
			message: (m) => this.#fromWorker(m),
			error: (e) => this.#host.log(`kernel worker: ${(e as Error)?.message ?? e}`),
			exit: () => {
				this.#exited = true;
				this.#resolveExit();
				if (this.#open) {
					this.#open = false;
					this.#socket.close(1000, "the kernel has stopped");
				}
			},
		});
	}

	async #kernelCall(m: ToWorker): Promise<void> {
		const worker = this.#worker;
		if (!worker || this.#ending) return;
		if (m.t !== "boot") {
			worker.post(m);
			return;
		}
		try {
			const spec = await this.#rewrite(m.spec);
			if (this.#ending) return;
			worker.post({ t: "boot", spec });
		} catch (e) {
			const message = (e as Error)?.message ?? String(e);
			this.#host.log(`remote: boot refused: ${message}`);
			this.#send({ k: "kernel", m: { t: "boot-error", stage: "boot", message } });
			void this.end("the boot was refused");
		}
	}

	async #rewrite(spec: WorkerBootSpec): Promise<WorkerBootSpec> {
		if (spec.restore) throw new Error("a saved session cannot be resumed in remote mode (start the page fresh)");
		if (spec.cpus !== undefined && spec.cpus > 1) throw new Error("remote mode runs the kernel on one CPU");
		if (typeof spec.kernel !== "string") throw new Error("the page must name its kernel by URL");
		if (spec.initrd !== undefined && spec.initrd !== null) throw new Error("remote mode boots the kernel's bundled initramfs");
		const disks = spec.disks ?? [];
		if (disks.some((d) => d.kind !== "data")) throw new Error("remote mode takes no disk from the page but the data disk");
		if (disks.length > 1) throw new Error("remote mode has one data disk");
		const kernelPath = await this.#host.file(spec.kernel, "kernel");
		const out: DiskSpec[] = [];
		if (disks.length) out.push({ kind: "file", path: await this.#host.dataDisk(kernelPath) });
		let distro: DiskSpec | undefined;
		if (spec.distro) {
			if (spec.distro.kind !== "http") throw new Error("the distro must be a URL under the backend's web root");
			distro = { kind: "file", path: await this.#host.file(spec.distro.url, "distro"), readOnly: true };
		}
		return {
			...spec,
			kernel: pathToFileURL(kernelPath).href,
			shared: undefined,
			console: undefined,
			disks: out,
			distro,
			net: spec.net && this.#host.net ? { kind: "net", backend: { kind: "direct" } } : undefined,
		};
	}

	#fromWorker(m: FromWorker): void {
		switch (m.t) {
			case "started":
				this.#started = true;
				break;
			case "synced":
				this.#syncWaiters.get(m.id)?.();
				break;
			case "exit":
				this.#exited = true;
				this.#resolveExit();
				break;
		}
		this.#send({ k: "kernel", m });
	}

	async #fsCall(id: number, op: RemoteFsOp, a: unknown[]): Promise<void> {
		try {
			if (!this.#fs) throw new FsError("ENOENT", "the backend has no host directory for /work");
			const v = await this.#fs.call(op, a);
			this.#send({ k: "fsr", id, ok: true, v });
		} catch (e) {
			const { code, message } = remoteError(e);
			if (code === "EIO") this.#host.log(`/work: ${op}: ${message}`);
			this.#send({ k: "fsr", id, ok: false, code, message });
		}
	}

	#send(m: RemoteReply): void {
		if (!this.#open) return;
		try {
			this.#socket.send(encodeRemote(m));
		} catch (e) {
			this.#host.log(`remote: a reply did not encode (${(e as Error)?.message ?? e})`);
		}
	}

	async #stop(reason: string): Promise<void> {
		this.#host.log(`ending the kernel: ${reason}`);
		try {
			const worker = this.#worker;
			if (worker && !this.#exited) {
				if (this.#started) {
					const id = this.#nextSyncId--;
					const synced = new Promise<void>((resolve) => this.#syncWaiters.set(id, resolve));
					worker.post({ t: "sync", id, timeout: SYNC_TIMEOUT_MS });
					await within(synced, SYNC_TIMEOUT_MS + 2000);
					this.#syncWaiters.delete(id);
					worker.post({ t: "stop", reason: reason.slice(0, 100) });
				} else {
					worker.post({ t: "abort" });
				}
				await within(this.#exitedSignal, STOP_TIMEOUT_MS);
			}
		} finally {
			this.#worker?.terminate();
			this.#worker = undefined;
			await this.#fs?.close().catch(() => {});
			if (this.#open) {
				this.#open = false;
				this.#socket.close(1000, "the kernel has stopped");
			}
			this.#resolveFinished();
		}
	}
}

/**
 * The backend's connections: one kernel at a time. A page that connects
 * while another kernel runs takes it over: the old one is stopped (its disk
 * saved) before the new one starts.
 */
export class RemoteHub {
	#host: RemoteHost;
	#active?: RemoteKernel;

	constructor(host: RemoteHost) {
		this.#host = host;
	}

	attach(socket: RemoteSocket): RemoteKernel {
		const previous = this.#active;
		const kernel = new RemoteKernel(socket, this.#host, previous?.finished);
		this.#active = kernel;
		if (previous) void previous.end("another page took the kernel over");
		return kernel;
	}

	end(reason: string): Promise<void> {
		return this.#active?.end(reason) ?? Promise.resolve();
	}
}
