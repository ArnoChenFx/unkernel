// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's end of the remote kernel (remote/backend.ts is the backend's): a
// RemoteLink is one WebSocket to a backend that runs the kernel. It is the
// kernel's WorkerEndpoint (createKernel({ worker: true }) posts to it as to a
// Web Worker) and the host file system of /work (fs()), both over that socket.
// connect() resolves once the backend has said hello, so the page knows what
// the backend offers before it boots.

import { BootError } from "../../js/core/load.ts";
import { FsError, type Fs } from "../../js/core/fs.ts";
import { REMOTE_TAKEN_OVER, REMOTE_WIRE, REMOTE_WS_PATH, decodeRemote, encodeRemote, remoteFs, type RemoteFsCaps, type RemoteFsOp, type RemoteReply, type RemoteRequest, type RemoteSession } from "../wire.ts";
import type { FromWorker, ToWorker, WorkerEndpoint } from "../../js/core/worker-protocol.ts";

/**
 * What the backend said first: its wire version, its file calls for /work (null:
 * none), the paths it shows, and what its kernel is doing (session).
 */
export interface RemoteHello {
	wire: number;
	fs: RemoteFsCaps | null;
	net: boolean;
	data: string | null;
	work: string | null;
	session: RemoteSession;
}

/** Options of RemoteLink.connect(). */
export interface RemoteConnectOptions {
	/** The kernel this page boots outlives the page: a page that connects later resumes it (remote/README.md, Lifecycle). */
	keep?: boolean;
	timeoutMs?: number;
}

interface Listeners {
	message(m: FromWorker): void;
	error(e: unknown): void;
	exit(): void;
}

export class RemoteLink {
	/** The backend's answer to the connection. */
	readonly hello: RemoteHello;
	readonly url: string;
	#ws: WebSocket;
	#listeners?: Listeners;
	#pending: FromWorker[] = [];
	#closed = false;
	#takenOver = false;
	#used = false;
	#fsSeq = 0;
	#fsCalls = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
	#fail?: Error;

	private constructor(url: URL, ws: WebSocket, hello: RemoteHello) {
		this.url = url.href;
		this.#ws = ws;
		this.hello = hello;
		ws.onmessage = (ev) => this.#onFrame(new Uint8Array(ev.data as ArrayBuffer));
		ws.onerror = null;
		ws.onclose = (ev) => this.#onClose(ev);
	}

	/** Another page took the kernel over: this connection was closed for it (reload this page to take it back). */
	get takenOver(): boolean {
		return this.#takenOver;
	}

	/** Connect to the backend at `base` (its origin; /remote/ws is added). */
	static connect(base: string | URL, options: RemoteConnectOptions = {}): Promise<RemoteLink> {
		const url = new URL(REMOTE_WS_PATH, base);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		if (options.keep) url.searchParams.set("keep", "1");
		const timeoutMs = options.timeoutMs ?? 10000;
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url.href);
			ws.binaryType = "arraybuffer";
			const fail = (why: string) => {
				clearTimeout(timer);
				try { ws.close(); } catch {}
				reject(new BootError("support", `cannot reach the remote kernel at ${url.origin} (${why}); is its backend running?`));
			};
			const timer = setTimeout(() => fail("no hello within " + timeoutMs / 1000 + " s"), timeoutMs);
			ws.onerror = () => fail("the connection failed");
			ws.onclose = (ev) => fail(`closed with ${ev.code}`);
			ws.onmessage = (ev) => {
				let r: RemoteReply;
				try {
					r = decodeRemote(new Uint8Array(ev.data as ArrayBuffer)) as RemoteReply;
				} catch {
					return fail("the first message is not a hello");
				}
				if (r.k !== "hello") return fail("the first message is not a hello");
				clearTimeout(timer);
				if (r.wire !== REMOTE_WIRE) {
					try { ws.close(); } catch {}
					return reject(new BootError("support", `the remote kernel speaks wire ${r.wire}, this page ${REMOTE_WIRE}: reload the page or restart the backend`));
				}
				resolve(new RemoteLink(url, ws, r));
			};
		});
	}

	/** The kernel's WorkerEndpoint: one per link (one kernel per backend connection). */
	endpoint(): WorkerEndpoint {
		if (this.#used) throw new Error("a remote link runs one kernel");
		this.#used = true;
		return {
			post: (msg: ToWorker) => {
				if (this.#closed) return;
				this.#send({ k: "kernel", m: msg });
			},
			listen: (handlers) => {
				this.#listeners = handlers;
				for (const m of this.#pending.splice(0)) handlers.message(m);
				if (this.#closed) {
					if (this.#fail) handlers.error(this.#fail);
					handlers.exit();
				}
			},
			terminate: () => this.close(),
		};
	}

	/** The host file system of /work, or undefined when the backend has none. */
	fs(): Fs | undefined {
		const caps = this.hello.fs;
		if (!caps) return undefined;
		return remoteFs((op, a) => this.#call(op, a), caps);
	}

	/** Close the socket: the backend stops the kernel this page booted, unless it was kept for the next page. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try { this.#ws.close(1000, "the page closed its connection"); } catch {}
	}

	/** The console command was typed: a page that binds to this kernel later does not type it again. */
	reportTyped(): void {
		this.#send({ k: "session", op: "typed" });
	}

	#send(req: RemoteRequest): void {
		if (this.#ws.readyState !== WebSocket.OPEN) return;
		this.#ws.send(encodeRemote(req));
	}

	#call(op: RemoteFsOp, a: unknown[]): Promise<unknown> {
		if (this.#closed) return Promise.reject(new FsError("ECONNABORTED", "the backend is gone"));
		const id = ++this.#fsSeq;
		return new Promise((resolve, reject) => {
			this.#fsCalls.set(id, { resolve, reject });
			this.#send({ k: "fs", id, op, a });
		});
	}

	#onFrame(frame: Uint8Array): void {
		const r = decodeRemote(frame) as RemoteReply;
		if (r.k === "kernel") {
			if (this.#listeners) this.#listeners.message(r.m);
			else this.#pending.push(r.m);
		} else if (r.k === "fsr") {
			const c = this.#fsCalls.get(r.id);
			if (!c) return;
			this.#fsCalls.delete(r.id);
			if (r.ok) c.resolve(r.v);
			else c.reject(new FsError(r.code, r.message));
		}
	}

	#onClose(ev: CloseEvent): void {
		const wasClosed = this.#closed;
		this.#closed = true;
		if (ev.code === REMOTE_TAKEN_OVER) this.#takenOver = true;
		for (const c of this.#fsCalls.values()) c.reject(new FsError("ECONNABORTED", "the backend closed the connection"));
		this.#fsCalls.clear();
		if (!wasClosed && ev.code !== 1000 && ev.code !== REMOTE_TAKEN_OVER) this.#fail = new Error(`the remote kernel's connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
		if (this.#listeners) {
			if (this.#fail) this.#listeners.error(this.#fail);
			this.#listeners.exit();
		}
	}
}
