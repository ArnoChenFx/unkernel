// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The backend's end of the remote kernel, on Node or Bun (remote/web/link.ts is
// the page's). A RemoteHub runs one kernel at a time, in a worker thread
// (worker.ts), and attaches one page to it: a page that connects takes the
// attachment over, and the page before it is closed with REMOTE_TAKEN_OVER.
// A kernel that its page booted with keep=1 (and no guest GL) outlives that page:
// it runs on with its input released and its frames unsent, and the next page
// with the same kernel and distro binds to it and is shown what it has
// (RemoteKernel.replayMessages). Any other kernel stops with its page. The boot
// spec the page sends is rewritten here rather than trusted: its kernel and distro
// are URLs the host maps to files (RemoteHost.file), its data disk is the host's
// image (RemoteHost.dataDisk), its network is direct host sockets, and anything
// else the worker would open is refused. /work is a host directory behind the
// file calls of the wire (workFs).

import { pathToFileURL } from "node:url";
import { REMOTE_TAKEN_OVER, REMOTE_WIRE, decodeRemote, encodeRemote, remoteError, remoteFsServer, type RemoteFsOp, type RemoteFsServer, type RemoteMachineInfo, type RemoteReply, type RemoteRequest, type RemoteSession } from "./wire.ts";
import { FsError, type Fs, type FsAttr, type FsFile } from "../js/core/fs.ts";
import type { DiskSpec } from "../js/core/devices.ts";
import type { DisplayMode } from "../js/core/display.ts";
import { EVDEV_OP, type FromWorker, type ToWorker, type WorkerBootSpec, type WorkerEndpoint } from "../js/core/worker-protocol.ts";
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
/** The console output kept for a page that comes later: its last bytes, which include the shell's prompt. */
const CONSOLE_TAIL = 16 * 1024;
/** The frame id of a replay's request (a page's ids count up from 1). */
const REPLAY_FRAME = -1;

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

/** What a boot spec asks for: a kernel is kept for a page that asks for the same identity. */
interface KernelIdentity {
	kernel: string | null;
	distro: string | null;
	gl: boolean;
	key: string;
}

function identityOf(spec: WorkerBootSpec): KernelIdentity {
	const kernel = typeof spec.kernel === "string" ? spec.kernel : null;
	const distro = spec.distro?.kind === "http" ? spec.distro.url : null;
	const gl = spec.gpu === "virgl";
	const key = JSON.stringify([kernel, distro, spec.memoryMiB, spec.cpus ?? 1, spec.cmdline ?? null, spec.gpu ?? false, spec.disks?.length ?? 0, !!spec.net]);
	return { kernel, distro, gl, key };
}

function keepTail(tail: Uint8Array, bytes: Uint8Array): Uint8Array {
	const joined = new Uint8Array(tail.length + bytes.length);
	joined.set(tail);
	joined.set(bytes, tail.length);
	return joined.length > CONSOLE_TAIL ? joined.slice(joined.length - CONSOLE_TAIL) : joined;
}

const sameSize = (a: DisplayMode, b: DisplayMode): boolean => a.width === b.width && a.height === b.height;

interface KernelOptions {
	host: RemoteHost;
	spawn: () => WorkerEndpoint;
	identity: KernelIdentity;
	emit(m: FromWorker): void;
	ended(reason: string): void;
}

/**
 * One kernel: its worker, and what a page that binds to it is shown. The
 * worker's messages go to the page bound to it (emit); the state recorded
 * here is what a later page needs (replayMessages, requestReplayFrame).
 */
export class RemoteKernel {
	/** Resolves once the kernel is stopped and its worker is gone. */
	readonly finished: Promise<void>;
	readonly identity: KernelIdentity;
	/** The kernel outlives the page bound to it: set by the binding (keep, and no GL). */
	keep = false;
	/** A page reported that it typed the console command: a page that binds later does not type it again. */
	typed = false;
	#host: RemoteHost;
	#spawn: () => WorkerEndpoint;
	#emit: (m: FromWorker) => void;
	#ended: (reason: string) => void;
	#state: "booting" | "running" | "ending" | "ended" = "booting";
	#worker?: WorkerEndpoint;
	#ending?: Promise<void>;
	#started = false;
	#exited = false;
	#exitReason?: string;
	#resolveExit!: () => void;
	#exitedSignal: Promise<void>;
	#resolveFinished!: () => void;
	#syncWaiters = new Map<number, () => void>();
	#nextSyncId = -1;
	#record: Partial<Record<"started" | "stats" | "display" | "inputState" | "vsockReady", FromWorker>> = {};
	#tail: Uint8Array = new Uint8Array(0);
	#frame?: { mode: DisplayMode; data: Uint8Array };

	constructor(options: KernelOptions) {
		this.#host = options.host;
		this.#spawn = options.spawn;
		this.identity = options.identity;
		this.#emit = options.emit;
		this.#ended = options.ended;
		this.finished = new Promise((resolve) => (this.#resolveFinished = resolve));
		this.#exitedSignal = new Promise((resolve) => (this.#resolveExit = resolve));
	}

	get state(): "booting" | "running" | "ending" | "ended" {
		return this.#state;
	}

	/** A page may still bind to it: it is booting or running, and not asked to stop. */
	get reusable(): boolean {
		return this.#state === "booting" || this.#state === "running";
	}

	/** The page's boot: once the kernel before this one has finished, the spec is rewritten and the worker starts. */
	async boot(spec: WorkerBootSpec, after: Promise<void>): Promise<void> {
		await after;
		if (this.#ending) return;
		let rewritten: WorkerBootSpec;
		try {
			rewritten = await this.#rewrite(spec);
		} catch (e) {
			const message = (e as Error)?.message ?? String(e);
			this.#host.log(`remote: boot refused: ${message}`);
			this.#emit({ t: "boot-error", stage: "boot", message });
			void this.end("the boot was refused");
			return;
		}
		if (this.#ending) return;
		const worker = this.#spawn();
		this.#worker = worker;
		worker.listen({
			message: (m) => this.#fromWorker(m),
			error: (e) => this.#host.log(`kernel worker: ${(e as Error)?.message ?? e}`),
			exit: () => {
				this.#exited = true;
				this.#resolveExit();
				void this.end(this.#exitReason ?? "the kernel's worker ended");
			},
		});
		worker.post({ t: "boot", spec: rewritten });
	}

	/** A page's message for the worker. */
	post(m: ToWorker): void {
		if (this.#ending || !this.#worker) return;
		this.#worker.post(m);
	}

	/** Release the keys and buttons the guest saw pressed: the page that pressed them may be gone. */
	releaseInput(): void {
		if (this.#started) this.post({ t: "evdev", ops: [EVDEV_OP.releaseAll, 0, 0] });
	}

	/** What a page that binds to this kernel is shown first: the kernel's last state, and the console's tail. */
	replayMessages(): FromWorker[] {
		const r = this.#record;
		const out: FromWorker[] = [];
		for (const m of [r.started, r.stats, r.vsockReady, r.inputState, r.display]) if (m) out.push(m);
		if (this.#tail.length) out.push({ t: "output", bytes: this.#tail });
		return out;
	}

	/** The picture now: a frame, or "unchanged" for which the cached frame stands (fromWorker). */
	requestReplayFrame(): void {
		if (this.#started) this.post({ t: "frame-want", id: REPLAY_FRAME, now: true });
	}

	/** Sync the guest, stop it and its worker. Idempotent; resolves with `finished`. */
	end(reason: string): Promise<void> {
		this.#ending ??= this.#stop(reason);
		return this.#ending;
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
				if (this.#state === "booting") this.#state = "running";
				this.#record.started = m;
				break;
			case "stats":
				this.#record.stats = m;
				break;
			case "display":
				this.#record.display = m;
				break;
			case "input-state":
				this.#record.inputState = m;
				break;
			case "vsock-ready":
				this.#record.vsockReady = m;
				break;
			case "output":
				this.#tail = keepTail(this.#tail, m.bytes);
				break;
			case "synced":
				this.#syncWaiters.get(m.id)?.();
				break;
			case "exit":
				this.#exited = true;
				this.#exitReason = m.result.reason;
				this.#resolveExit();
				break;
			case "frame":
				if (m.data && m.mode) this.#frame = { mode: m.mode, data: m.data };
				else if (m.id === REPLAY_FRAME && m.mode && this.#frame && sameSize(this.#frame.mode, m.mode)) m = { ...m, data: this.#frame.data };
				break;
		}
		this.#emit(m);
	}

	async #stop(reason: string): Promise<void> {
		this.#state = "ending";
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
			this.#state = "ended";
			this.#record = {};
			this.#tail = new Uint8Array(0);
			this.#frame = undefined;
			this.#ended(reason);
			this.#resolveFinished();
		}
	}
}

/** A page's connection to the hub: its socket, the kernel it is bound to, and whether it asked to keep that kernel. */
export class RemoteAttachment {
	/** The kernel this page is bound to, from its boot until the page leaves or the kernel ends. */
	kernel?: RemoteKernel;
	/** False once the socket is closed or taken over. */
	open = true;
	readonly socket: RemoteSocket;
	readonly keep: boolean;

	constructor(socket: RemoteSocket, keep: boolean) {
		this.socket = socket;
		this.keep = keep;
	}
}

/**
 * The backend's connections: one kernel at a time, and the page attached to it.
 * A page that connects takes the attachment over (the old page is closed with
 * REMOTE_TAKEN_OVER). A page that leaves does not stop a kernel it booted with
 * keep=1; a page that boots a different kernel stops the one before it, after
 * its disk is saved.
 */
export class RemoteHub {
	#host: RemoteHost;
	#spawn: () => WorkerEndpoint;
	#fs?: RemoteFsServer;
	#kernel?: RemoteKernel;
	#attachment?: RemoteAttachment;
	#queue: Promise<void> = Promise.resolve();
	#ended: string | null = null;
	#closing = false;

	constructor(host: RemoteHost, spawn: () => WorkerEndpoint = spawnNodeWorker) {
		this.#host = host;
		this.#spawn = spawn;
		if (host.work) this.#fs = remoteFsServer(workFs(host.work));
	}

	/** A page connects: it takes the attachment over, and is told what the kernel is doing. */
	attach(socket: RemoteSocket, options: { keep: boolean }): RemoteAttachment {
		const att = new RemoteAttachment(socket, options.keep);
		const previous = this.#attachment;
		this.#attachment = att;
		if (previous?.open) {
			previous.open = false;
			previous.socket.close(REMOTE_TAKEN_OVER, "another page took the desktop over");
			this.#leave(previous, "another page took the desktop over");
		}
		this.#send(att, {
			k: "hello", wire: REMOTE_WIRE, fs: this.#fs?.caps ?? null, net: this.#host.net,
			data: this.#host.data ?? null, work: this.#host.work ?? null, session: this.#session(),
		});
		return att;
	}

	/** The page's socket closed. Only the attached page's close counts: a page taken over (or one whose kernel ended) has none left. */
	detach(att: RemoteAttachment): void {
		if (att !== this.#attachment) return;
		this.#attachment = undefined;
		att.open = false;
		this.#leave(att, "the page closed its connection");
	}

	/** A binary frame from a page. */
	receive(att: RemoteAttachment, frame: Uint8Array): void {
		if (att !== this.#attachment || !att.open) return;
		let msg: RemoteRequest;
		try {
			msg = decodeRemote(frame) as RemoteRequest;
		} catch (e) {
			this.#host.log(`remote: a frame that does not decode (${(e as Error).message})`);
			att.socket.close(1003, "bad frame");
			return;
		}
		if (msg.k === "fs") {
			void this.#fsCall(att, msg.id, msg.op, msg.a);
			return;
		}
		if (msg.k === "session") {
			if (att.kernel) att.kernel.typed = true;
			return;
		}
		this.#run(() => this.#kernelCall(att, msg.m));
	}

	/** Stop the kernel (its disk saved first) and any boot still waiting for it; resolves once nothing runs. */
	end(reason: string): Promise<void> {
		this.#closing = true;
		return Promise.all([this.#kernel?.end(reason), this.#queue]).then(() => undefined);
	}

	#run(task: () => Promise<void>): void {
		this.#queue = this.#queue.then(task).catch((e) => this.#host.log(`remote: ${(e as Error)?.message ?? e}`));
	}

	async #kernelCall(att: RemoteAttachment, m: ToWorker): Promise<void> {
		if (att !== this.#attachment || !att.open) return;
		if (m.t === "boot") return this.#boot(att, m.spec);
		att.kernel?.post(m);
	}

	async #boot(att: RemoteAttachment, spec: WorkerBootSpec): Promise<void> {
		if (this.#closing) return;
		if (att.kernel) {
			this.#host.log("remote: a page asked for a second boot");
			return;
		}
		const identity = identityOf(spec);
		const current = this.#kernel;
		if (current?.reusable && current.identity.key === identity.key) {
			this.#bind(att, current);
			for (const m of current.replayMessages()) this.#send(att, { k: "kernel", m });
			current.requestReplayFrame();
			return;
		}
		if (current?.reusable) void current.end("a page asked for another kernel");
		const next: RemoteKernel = new RemoteKernel({
			host: this.#host,
			spawn: this.#spawn,
			identity,
			emit: (m) => this.#forward(next, m),
			ended: (reason) => this.#kernelEnded(next, reason),
		});
		this.#kernel = next;
		this.#bind(att, next);
		await next.boot(spec, current?.finished ?? Promise.resolve());
	}

	#bind(att: RemoteAttachment, kernel: RemoteKernel): void {
		att.kernel = kernel;
		kernel.keep = att.keep && !kernel.identity.gl;
	}

	/** The page left its kernel: a kernel that outlives its page keeps running; any other stops now. */
	#leave(att: RemoteAttachment, why: string): void {
		const kernel = att.kernel;
		att.kernel = undefined;
		void this.#fs?.close();
		if (!kernel?.reusable) return;
		if (kernel.keep) {
			kernel.releaseInput();
			this.#host.log(`${why}: the kernel keeps running with its input released; the next page with the same kernel resumes it`);
			return;
		}
		void kernel.end(`${why}: this kernel does not outlive its page (guest GL, or a page that did not ask to keep it)`);
	}

	#kernelEnded(kernel: RemoteKernel, reason: string): void {
		this.#ended = reason;
		const att = this.#attachment;
		if (!att || att.kernel !== kernel) return;
		this.#attachment = undefined;
		att.kernel = undefined;
		att.open = false;
		att.socket.close(1000, "the kernel has stopped");
	}

	#forward(kernel: RemoteKernel, m: FromWorker): void {
		const att = this.#attachment;
		if (att && att.kernel === kernel) this.#send(att, { k: "kernel", m });
	}

	async #fsCall(att: RemoteAttachment, id: number, op: RemoteFsOp, a: unknown[]): Promise<void> {
		try {
			if (!this.#fs) throw new FsError("ENOENT", "the backend has no host directory for /work");
			const v = await this.#fs.call(op, a);
			this.#send(att, { k: "fsr", id, ok: true, v });
		} catch (e) {
			const { code, message } = remoteError(e);
			if (code === "EIO") this.#host.log(`/work: ${op}: ${message}`);
			this.#send(att, { k: "fsr", id, ok: false, code, message });
		}
	}

	#session(): RemoteSession {
		const k = this.#kernel;
		if (!k) return { machine: null, ended: this.#ended };
		const state = k.state;
		if (state === "ended") return { machine: null, ended: this.#ended };
		const machine: RemoteMachineInfo = {
			state, kernel: k.identity.kernel, distro: k.identity.distro, gl: k.identity.gl, keep: k.keep, typed: k.typed,
		};
		return { machine, ended: this.#ended };
	}

	#send(att: RemoteAttachment, m: RemoteReply): void {
		if (!att.open) return;
		try {
			att.socket.send(encodeRemote(m));
		} catch (e) {
			this.#host.log(`remote: a reply did not encode (${(e as Error)?.message ?? e})`);
		}
	}
}
