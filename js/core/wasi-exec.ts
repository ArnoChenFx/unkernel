// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// WASI programs (wasm32-wasi, preview 1 or 0) that the guest runs, executed by
// the host's own wasm engine (prototype). The guest's binfmt_misc hands an
// executable .wasm file to kwwasi (kernel/guest/kwwasi.c), which connects
// to vsock port 1021 and sends argv, the environment, its preopened
// directory and the module (unless this side has it); kwwasi then does the
// program's file calls with
// its own descriptors, cwd and credentials. The protocol is described at
// the top of kwwasi.c; a change goes in both (and in wasi-program.ts).
//
// This is the owner's side, where `vsock` (VsockHost) runs: on the
// kernel's thread inline, on the owner's thread in worker mode and with
// several CPUs. It reads the START frame, gets the module (ModuleCache:
// compiled once per SHA-256 of its bytes, so a program run again is not
// sent or compiled again and runs the code V8 tiered up), checks its
// imports and gives the program a worker of its own (spawned by the
// platform's binding, js/node/wasi.ts or
// js/web/wasi.ts; WorkerPool), posting it the compiled module. kwwasi sends
// the file's identity first (size, dev, ino, mtime, ctime) and the bytes
// only when asked: ModuleCache maps identities to modules compiled before,
// for this machine. The program
// runs there (wasi-program.ts) and hands kwwasi's requests to this side,
// which writes them to the connection and hands the replies back: through
// a SharedArrayBuffer per program where this thread can use one
// (`sharedMemory`, wasiSharedChannelAvailable(); this side wakes on
// Atomics.waitAsync and never blocks), else as messages. The workers are
// the owner's, not the kernel worker's, because the connection is here: a
// request crosses one thread boundary, not two.
//
// Ending: proc_exit, a return from `_start` or a trap comes as an "exit"
// message, sent to kwwasi as EXIT; kwwasi exits with that status, and the
// worker, idle now, is kept for the next program (at most `idleWorkers`)
// or terminated. When the connection ends first (kwwasi killed: Ctrl-C,
// SIGKILL, SIGPIPE; the kernel exited or was stopped), the worker is
// terminated at once, even in the middle of a computation.
//
// Snapshots: programs are not part of one. Nothing here holds up the
// snapshot point (no VsockDevice.hostBusy, no VsockDevice.keep), so a
// restored kernel resets kwwasi's connection like any other the host does
// not keep, and kwwasi exits with an error (126).

import type { Vsock, VsockConnection, VsockListener } from "./vsock.ts";
import {
	CH_DATA, CH_INITIAL, CH_LEN, CH_MAX, CH_REP, CH_REQ, channelRoom, Enc, OP_DATA, OP_END, OP_EXIT, OP_MODULE, OP_REPLY, OP_START, WASI_MODULES,
	WASI_PROTOCOL_VERSION,
	type WasiFromProgram, type WasiProgramEndpoint,
} from "./wasi-program.ts";
import { sharedMemoryAvailable } from "./worker-shared.ts";

export type { WasiFromProgram, WasiProgramEndpoint, WasiProgramPort, WasiToProgram } from "./wasi-program.ts";

/** The host port kwwasi connects to (kernel/guest/kwwasi.c KWWASI_PORT). */
export const WASI_EXEC_PORT = 1021;

export interface WasiExecOptions {
	/** The vsock port to listen on (default WASI_EXEC_PORT, 1021). */
	port?: number;
	/** The largest module accepted (default 256 MiB). */
	maxModuleBytes?: number;
	log?: (msg: string) => void;
	/** Workers kept for the next program once theirs ended by itself (default 2). */
	idleWorkers?: number;
	/**
	 * Compiled modules kept, least recently used dropped first: at most
	 * `count` (default 16) and `bytes` of module files (default 512 MiB; the
	 * newest is kept even when larger).
	 */
	moduleCache?: { count?: number; bytes?: number };
	/**
	 * Requests through a SharedArrayBuffer per program instead of messages
	 * (default: when this thread can use one, wasiSharedChannelAvailable()).
	 * false: messages and JSPI.
	 */
	sharedMemory?: boolean;
}

/**
 * Can programs use the shared channel: SharedArrayBuffer that can be posted
 * (Node; browsers only when cross-origin isolated), growable, and
 * Atomics.waitAsync (so this thread never blocks).
 */
export function wasiSharedChannelAvailable(): boolean {
	return sharedMemoryAvailable() && typeof Atomics.waitAsync === "function" &&
		typeof (SharedArrayBuffer.prototype as { grow?: unknown }).grow === "function";
}

export interface WasiExecSpawn {
	/** Start a worker running serveWasiProgram() (wasi-program.ts). */
	spawn: () => WasiProgramEndpoint;
}

export interface WasiExecStats {
	/** Programs started, running now, and ended by a trap or an error. */
	started: number;
	running: number;
	failed: number;
	/** Requests made to kwwasi. */
	requests: number;
	/** Modules kwwasi sent (it sends none the host has), and compiled modules kept. */
	received: number;
	cached: number;
	/** Worker threads alive (running a program or idle), and the idle ones. */
	workers: number;
	idle: number;
	/** Shared channels still served (sharedMemory; 0 once no program runs). */
	channels: number;
}

export interface WasiExecServer {
	readonly port: number;
	/** Requests go through a SharedArrayBuffer (WasiExecOptions.sharedMemory), not messages. */
	readonly shared: boolean;
	readonly stats: WasiExecStats;
	/** Stop listening and end the idle workers (running programs go on). */
	close(): void;
}

/**
 * Reads exact byte counts from a stream; null at its end. The stream's
 * chunks are this reader's own (the connection's copies of the guest's
 * packets), so exact() hands out a chunk that is exactly what was asked
 * for as it is, not a copy.
 */
class ByteReader {
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#chunks: Uint8Array[] = [];
	#have = 0;
	constructor(stream: ReadableStream<Uint8Array>) {
		this.#reader = stream.getReader();
	}
	async exact(n: number): Promise<Uint8Array | null> {
		if (!(await this.#fill(n))) return null;
		const c = this.#chunks[0]!;
		if (c.length === n) {
			this.#chunks.shift();
			this.#have -= n;
			return c;
		}
		const out = new Uint8Array(n);
		this.#take(out);
		return out;
	}
	/** Fill `out`; false at the stream's end. */
	async into(out: Uint8Array): Promise<boolean> {
		if (!(await this.#fill(out.length))) return false;
		this.#take(out);
		return true;
	}
	/** Have at least `n` bytes; false at the stream's end. */
	async #fill(n: number): Promise<boolean> {
		while (this.#have < n) {
			let r: ReadableStreamReadResult<Uint8Array>;
			try {
				r = await this.#reader.read();
			} catch {
				return false;
			}
			if (r.done) return false;
			this.#chunks.push(r.value);
			this.#have += r.value.length;
		}
		return true;
	}
	#take(out: Uint8Array): void {
		const n = out.length;
		let at = 0;
		while (at < n) {
			const c = this.#chunks[0]!;
			const take = Math.min(c.length, n - at);
			out.set(c.subarray(0, take), at);
			at += take;
			if (take === c.length) this.#chunks.shift();
			else this.#chunks[0] = c.subarray(take);
		}
		this.#have -= n;
	}
	cancel(): void {
		this.#reader.cancel().catch(() => {});
	}
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Start the host side: compile the guest's WASI programs that kwwasi sends
 * and run each in a worker of its own (`spawn`).
 */
export function serveWasiProgramsWith(vsock: Vsock, opts: WasiExecOptions & WasiExecSpawn): WasiExecServer {
	const port = opts.port ?? WASI_EXEC_PORT;
	const log = opts.log ?? (() => {});
	const maxModule = opts.maxModuleBytes ?? 256 << 20;
	const stats: WasiExecStats = { started: 0, running: 0, failed: 0, requests: 0, received: 0, cached: 0, workers: 0, idle: 0, channels: 0 };
	const cache = new ModuleCache(opts.moduleCache?.count ?? 16, opts.moduleCache?.bytes ?? 512 << 20, stats);
	const pool = new WorkerPool(opts.spawn, opts.idleWorkers ?? 2, stats);
	const shared = opts.sharedMemory ?? wasiSharedChannelAvailable();
	const listener: VsockListener = vsock.listen(port, (conn) => {
		void runProgram(conn, { log, maxModule, stats, cache, pool, shared }).catch((e) => log(`[wasi] ${(e as Error)?.stack ?? e}`));
	});
	return {
		port,
		shared,
		stats,
		close: () => {
			listener.close();
			pool.close();
		},
	};
}

interface RunContext {
	log: (msg: string) => void;
	maxModule: number;
	stats: WasiExecStats;
	cache: ModuleCache;
	pool: WorkerPool;
	shared: boolean;
}

/**
 * Compiled modules, by the SHA-256 of their bytes (a counter where there is
 * no crypto.subtle), and the identities kwwasi gave for those bytes (size,
 * dev, ino, mtime, ctime of the file it opened; only settled ones, whose
 * ctime was 2 s old, kwwasi.c). Identities are this
 * machine's: one ModuleCache belongs to one serveWasiPrograms(), that is
 * one VsockHost, and a machine restored from a snapshot is another
 * VsockHost with its own (inode numbers mean nothing across machines).
 * Bounded by count and bytes, least recently used first; at most
 * ID_LIMIT identities.
 */
class ModuleCache {
	#modules = new Map<string, { module: Promise<WebAssembly.Module>; bytes: number }>();
	#bytes = 0;
	#ids = new Map<string, Promise<string | undefined>>();
	#count: number;
	#limit: number;
	#stats: WasiExecStats;
	#serial = 0;
	static readonly ID_LIMIT = 256;

	constructor(count: number, bytes: number, stats: WasiExecStats) {
		this.#count = Math.max(1, count);
		this.#limit = bytes;
		this.#stats = stats;
	}

	/**
	 * The module for identity `id`, or a claim: the caller gets the bytes
	 * and calls claim() with compile()'s key once they compiled (undefined
	 * when it failed or the file changed while kwwasi read it). A program
	 * that starts while another with the same identity is being sent waits
	 * for that one.
	 */
	async acquire(id: string): Promise<{ module: WebAssembly.Module } | { claim: (key: string | undefined) => void }> {
		for (;;) {
			const p = this.#ids.get(id);
			if (!p) {
				let done!: (key: string | undefined) => void;
				const mine = new Promise<string | undefined>((r) => (done = r));
				this.#ids.set(id, mine);
				while (this.#ids.size > ModuleCache.ID_LIMIT) this.#ids.delete(this.#ids.keys().next().value!);
				let claimed = false;
				return {
					claim: (key) => {
						if (claimed) return;
						claimed = true;
						if (!key && this.#ids.get(id) === mine) this.#ids.delete(id);
						done(key);
					},
				};
			}
			this.#ids.delete(id); // most recently used last
			this.#ids.set(id, p);
			const key = await p;
			const e = key ? this.#touch(key) : undefined;
			const module = e && (await e.module.catch(() => undefined));
			if (module) return { module };
			if (this.#ids.get(id) === p) this.#ids.delete(id);
		}
	}

	#touch(key: string) {
		const e = this.#modules.get(key);
		if (e) {
			this.#modules.delete(key);
			this.#modules.set(key, e);
		}
		return e;
	}

	/** Compile `bytes`, or share the module compiled from the same bytes. */
	async compile(bytes: Uint8Array): Promise<{ key: string; module: Promise<WebAssembly.Module> }> {
		const subtle = globalThis.crypto?.subtle;
		const key = subtle
			? Array.from(new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("")
			: `#${++this.#serial}`;
		const had = this.#touch(key);
		if (had) return { key, module: had.module };
		const e = { module: WebAssembly.compile(bytes as BufferSource), bytes: bytes.length };
		e.module.catch(() => {
			if (this.#modules.get(key) === e) this.#drop(key);
		});
		this.#modules.set(key, e);
		this.#bytes += e.bytes;
		while (this.#modules.size > 1 && (this.#modules.size > this.#count || this.#bytes > this.#limit)) this.#drop(this.#modules.keys().next().value!);
		this.#stats.cached = this.#modules.size;
		return { key, module: e.module };
	}

	#drop(key: string): void {
		const e = this.#modules.get(key);
		if (!e) return;
		this.#modules.delete(key);
		this.#bytes -= e.bytes;
		this.#stats.cached = this.#modules.size;
	}
}

/** kwwasi.c's MAX_FRAME, CHUNK and the identity's size (without its u64 flags). */
const MAX_FRAME = 64 << 20;
const MAX_DATA = 256 << 10;
const IDENTITY = 40;

/**
 * The module's DATA frames, `size` bytes, and END; `same`: END's identity is
 * START's (the file did not change while kwwasi read it). Null when kwwasi
 * went away or broke the protocol.
 */
async function receiveModule(reader: ByteReader, size: number, identity: Uint8Array): Promise<{ bytes: Uint8Array; same: boolean } | null> {
	const bytes = new Uint8Array(size);
	for (let at = 0; ;) {
		const h = await reader.exact(8);
		if (!h) return null;
		const hv = view(h);
		const op = hv.getUint32(0, true), len = hv.getUint32(4, true);
		if (at < size) {
			if (op !== OP_DATA || len === 0 || len > MAX_DATA || len > size - at) return null;
			if (!(await reader.into(bytes.subarray(at, at + len)))) return null;
			at += len;
			continue;
		}
		if (op !== OP_END || len !== IDENTITY + 8) return null;
		const end = await reader.exact(IDENTITY + 8);
		if (!end) return null;
		return { bytes, same: identity.every((b, i) => b === end[i]) };
	}
}

async function runProgram(conn: VsockConnection, ctx: RunContext): Promise<void> {
	const reader = new ByteReader(conn.readable);
	const writer = conn.writable.getWriter();
	// Written as it is, not copied: the connection copies what it is given
	// (vsock.ts), and a request's frame in the shared channel is overwritten
	// only after its reply, which kwwasi sends once it has read all of it.
	const send = (b: Uint8Array) => {
		writer.write(b).catch(() => {});
	};
	const exit = (code: number, msg = "") => {
		send(new Enc().u32(code).bytes(utf8.encode(msg)).frame(OP_EXIT));
		writer.close().catch(() => {});
	};

	const head = await reader.exact(8);
	if (!head) return conn.reset();
	const hv = view(head);
	const op = hv.getUint32(0, true);
	const len = hv.getUint32(4, true);
	if (op !== OP_START || len > MAX_FRAME) {
		ctx.log(`[wasi] bad first frame (op ${op}, ${len} bytes)`);
		return conn.reset();
	}
	const start = await reader.exact(len);
	if (!start) return conn.reset();
	const sv = view(start);
	let at = 0;
	const u32 = () => {
		const v = sv.getUint32(at, true);
		at += 4;
		return v;
	};
	const str = () => {
		const n = u32();
		const s = start.slice(at, at + n);
		at += n;
		return s;
	};
	let args: Uint8Array[], env: Uint8Array[], identity: Uint8Array, size: number, unsettled: boolean;
	const preopens: Array<[number, Uint8Array]> = [];
	try {
		const version = u32();
		if (version !== WASI_PROTOCOL_VERSION)
			return exit(126, `kwwasi: protocol version ${version}, the host speaks ${WASI_PROTOCOL_VERSION}`);
		const argc = u32(), envc = u32(), npre = u32();
		identity = start.slice(at, at + IDENTITY);
		size = Number(sv.getBigUint64(at, true));
		unsettled = (sv.getBigUint64(at + IDENTITY, true) & 1n) !== 0n;
		at += IDENTITY + 8;
		args = Array.from({ length: argc }, str);
		env = Array.from({ length: envc }, str);
		for (let i = 0; i < npre; i++) {
			const fd = u32();
			preopens.push([fd, str()]);
		}
	} catch (e) {
		ctx.log(`[wasi] bad START frame: ${(e as Error).message}`);
		return conn.reset();
	}
	const name = utf8d.decode(args[0] ?? new Uint8Array());
	if (size > ctx.maxModule) return exit(126, `kwwasi: ${name}: ${size} bytes, larger than the host takes (${ctx.maxModule})`);

	// The module: compiled before for this identity, or sent now (always for a file changed just now, UNSETTLED).
	let module: WebAssembly.Module;
	const got = unsettled ? undefined : await ctx.cache.acquire(Array.from(identity).join(","));
	if (got && "module" in got) {
		send(new Enc().u32(0).frame(OP_MODULE));
		module = got.module;
	} else {
		let key: string | undefined;
		try {
			send(new Enc().u32(1).frame(OP_MODULE));
			const bytes = await receiveModule(reader, size, identity);
			if (!bytes) {
				ctx.log(`[wasi] ${name}: kwwasi did not send the module; connection reset`);
				return conn.reset();
			}
			ctx.stats.received++;
			const c = await ctx.cache.compile(bytes.bytes);
			try {
				module = await c.module;
			} catch (e) {
				return exit(126, `kwwasi: ${name}: not a valid WebAssembly module: ${(e as Error).message}`);
			}
			if (bytes.same) key = c.key;
		} finally {
			got?.claim(key);
		}
	}
	for (const imp of WebAssembly.Module.imports(module)) {
		if (!WASI_MODULES.includes(imp.module))
			return exit(126, `kwwasi: ${name}: imports ${imp.module}.${imp.name}; only wasi_snapshot_preview1 and wasi_unstable are provided`);
	}
	const hasStart = WebAssembly.Module.exports(module).some((e) => e.name === "_start" && e.kind === "function");
	if (!hasStart) return exit(126, `kwwasi: ${name}: no _start export (not a WASI command)`);

	let worker: ProgramWorker;
	try {
		worker = ctx.pool.take();
	} catch (e) {
		return exit(126, `kwwasi: ${name}: cannot start a worker: ${(e as Error)?.message ?? e}`);
	}
	ctx.stats.started++;
	ctx.stats.running++;
	/** The program has ended (exit sent, or kwwasi gone). */
	let ended = false;
	const end = (status?: { code: number; msg: string }, reusable = false) => {
		if (ended) return;
		ended = true;
		ctx.stats.running--;
		if (status) exit(status.code, status.msg);
		reader.cancel();
		if (ctl) Atomics.notify(ctl, CH_REQ); // ends the shared path's waitAsync
		// A worker whose program ended by itself is idle and can run the next one; any other is terminated now.
		ctx.pool.release(worker, reusable);
	};
	const replyHead = new Uint8Array(8), replyView = view(replyHead);
	/**
	 * One request to kwwasi: its REPLY body, or null when the program has
	 * ended. `place` gives where the body goes (the shared channel), else it
	 * is a buffer of its own (transferable); undefined from it: no room.
	 */
	const request = async (frame: Uint8Array, place?: (len: number) => Uint8Array | undefined): Promise<Uint8Array | null> => {
		if (ended) return null;
		ctx.stats.requests++;
		send(frame);
		const h = await reader.into(replyHead);
		const len = h && replyView.getUint32(0, true) === OP_REPLY ? replyView.getUint32(4, true) : -1;
		let body: Uint8Array | null = null;
		if (len >= 4) {
			const at = place?.(len);
			if (place && !at) {
				ctx.log(`[wasi] ${name}: a reply of ${len} bytes from kwwasi; connection reset`);
				conn.reset();
				end();
				return null;
			}
			body = at ? ((await reader.into(at)) ? at : null) : await reader.exact(len);
		}
		if (ended) return null;
		if (!body) {
			// kwwasi went away mid-request, or broke the protocol.
			if (h) ctx.log(`[wasi] ${name}: unexpected frame from kwwasi; connection reset`);
			conn.reset();
			end();
			return null;
		}
		return body;
	};
	// Requests come one at a time (the program waits for each reply); keep their order anyway.
	let queue = Promise.resolve();
	const channel = ctx.shared ? new SharedArrayBuffer(CH_INITIAL, { maxByteLength: CH_MAX }) : undefined;
	const ctl = channel && new Int32Array(channel, 0, CH_DATA / 4);
	if (channel && ctl) {
		// The shared path: wait (never block) for the worker to bump CH_REQ, answer in place, set CH_REP.
		const serve = async () => {
			let seen = 0;
			for (;;) {
				const w = Atomics.waitAsync(ctl, CH_REQ, seen);
				if (w.async) await w.value;
				if (ended) return;
				const seq = Atomics.load(ctl, CH_REQ);
				if (seq === seen) continue;
				seen = seq;
				const len = Atomics.load(ctl, CH_LEN);
				// The reply is read straight into the channel, over the request.
				const body = await request(new Uint8Array(channel, CH_DATA, len), (n) => channelRoom(channel, n) ? new Uint8Array(channel, CH_DATA, n) : undefined);
				if (!body) return;
				Atomics.store(ctl, CH_LEN, body.length);
				Atomics.store(ctl, CH_REP, seq);
				Atomics.notify(ctl, CH_REP);
			}
		};
		// "exit" comes after the last reply was taken, so it need not wait for this loop.
		ctx.stats.channels++;
		void serve()
			.catch((e) => {
				ctx.log(`[wasi] ${name}: ${(e as Error)?.stack ?? e}`);
				conn.reset();
				end();
			})
			.finally(() => ctx.stats.channels--);
	}
	worker.on = {
		message: (m) => {
			if (m.t === "request") {
				queue = queue.then(async () => {
					const body = await request(m.frame);
					if (body) worker.ep.post({ t: "reply", body }, [body.buffer as ArrayBuffer]);
				});
			} else if (m.t === "exit") {
				if (m.failed) ctx.stats.failed++;
				queue = queue.then(() => end({ code: m.code, msg: m.msg }, true));
			} else if (m.t === "log") {
				ctx.log(m.msg);
			}
		},
		gone: (e) => {
			if (ended) return;
			ctx.stats.failed++;
			end({ code: 134, msg: `kwwasi: ${name}: ${e ? (e as Error)?.message ?? e : "its worker ended"}` });
		},
	};
	void conn.closed.then(() => {
		if (ended) return;
		ctx.log(`[wasi] ${name}: kwwasi went away; worker terminated`);
		end();
	});
	worker.ep.post({ t: "start", module, name, args, env, preopens, channel });
}

/** A program worker and whoever uses it now. */
interface ProgramWorker {
	ep: WasiProgramEndpoint;
	/** The running program's handlers (undefined while idle). */
	on: { message(m: WasiFromProgram): void; gone(err?: unknown): void } | undefined;
	alive: boolean;
}

/**
 * Program workers: a new one per program, or an idle one whose last
 * program ended by itself (proc_exit, return, trap: its stack unwound and
 * its instance is garbage). Up to `max` idle ones are kept, so a program
 * run again does not wait for a worker to start. A worker ended for a
 * kill is terminated, never reused.
 */
class WorkerPool {
	#spawn: () => WasiProgramEndpoint;
	#idle: ProgramWorker[] = [];
	#max: number;
	#stats: WasiExecStats;
	#closed = false;

	constructor(spawn: () => WasiProgramEndpoint, max: number, stats: WasiExecStats) {
		this.#spawn = spawn;
		this.#max = max;
		this.#stats = stats;
	}

	take(): ProgramWorker {
		const idle = this.#idle.pop();
		if (idle) {
			this.#stats.idle--;
			return idle;
		}
		const w: ProgramWorker = { ep: this.#spawn(), on: undefined, alive: true };
		this.#stats.workers++;
		const gone = (err?: unknown) => {
			if (!w.alive) return;
			w.alive = false;
			this.#stats.workers--;
			const i = this.#idle.indexOf(w);
			if (i >= 0) {
				this.#idle.splice(i, 1);
				this.#stats.idle--;
			}
			const on = w.on;
			w.on = undefined;
			on?.gone(err);
		};
		w.ep.listen({
			message: (m) => w.on?.message(m),
			error: (e) => {
				gone(e);
				w.ep.terminate();
			},
			exit: () => gone(),
		});
		return w;
	}

	release(w: ProgramWorker, reusable: boolean): void {
		w.on = undefined;
		if (!w.alive) return;
		if (reusable && !this.#closed && this.#idle.length < this.#max) {
			this.#idle.push(w);
			this.#stats.idle++;
		} else {
			w.ep.terminate();
		}
	}

	close(): void {
		this.#closed = true;
		// Each leaves #idle (and stats.idle) when it is gone, as any other worker.
		for (const w of [...this.#idle]) w.ep.terminate();
	}
}
