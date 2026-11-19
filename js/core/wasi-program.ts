// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// One guest WASI program, in its own worker (the program side of
// wasi-exec.ts). The owner (serveWasiPrograms(), where vm.vsock's VsockHost
// runs) compiles the module once and gives each running program a worker
// of its own (spawned by js/node/wasi.ts, js/web/wasi.ts); the worker's
// entry calls serveWasiProgram() with its port. A "start" message brings
// the compiled module, argv, the environment and the preopened
// directories; the worker instantiates the module with a
// wasi_snapshot_preview1 and calls `_start`. A module importing preview 0
// (`wasi_unstable`, older toolchains) gets the same calls, adapted where
// preview 0 differs (WASI0 below).
//
// WASI imports are synchronous. Those answered here (args, environ,
// clocks, random_get, preopens, proc_exit) are plain functions. Those that
// kwwasi does in the guest (files, poll_oneoff on descriptors) are one
// round trip each: the request frame (kwwasi.c's protocol, built here) goes
// to the owner, which writes it to the vsock connection, reads kwwasi's
// REPLY frame and hands its body back. Two ways:
// - Shared (the "start" message brings a `channel`; the owner's choice,
//   where SharedArrayBuffer can be used: Node, isolated pages): the frame
//   is written into the channel (CH_*), and the import spins briefly, then
//   sleeps in Atomics.wait until the owner has written the reply there. The
//   imports are plain functions and `_start` runs to its end inside the
//   "start" message's handler; no JSPI, no message per request.
// - Messages (the fallback, no cross-origin isolation needed): the imports
//   are JSPI Suspending imports, `_start` is called through
//   WebAssembly.promising, the frame goes as a "request" message and the
//   body comes back as "reply".
// One body of code serves both: #call() returns a Reply or a promise of
// one, and then() continues either way.
//
// The program never waits for anything but its own replies: a computation
// runs on this thread without holding up the kernel or the owner, and the
// owner ends it with terminate() wherever it is (kwwasi gone, the machine
// stopped). proc_exit, a return from `_start`, a trap and a failed
// instantiation end with an "exit" message; the stack has unwound and the
// instance is garbage then, so the owner may keep the worker for its next
// program (wasi-exec.ts, WorkerPool).
// Universal: no node: imports, no DOM.

/** @internal kwwasi.c's protocol version and the frames the owner handles. */
export const WASI_PROTOCOL_VERSION = 2;
export const OP_START = 1;
export const OP_REPLY = 2;
export const OP_EXIT = 3;
export const OP_MODULE = 4;
export const OP_DATA = 5;
export const OP_END = 6;
const R_READ = 16;
const R_PREAD = 17;
const R_WRITE = 18;
const R_PWRITE = 19;
const R_SEEK = 20;
const R_CLOSE = 21;
const R_FSTAT = 22;
const R_FDSTAT = 23;
const R_SETFL = 24;
const R_OPENAT = 25;
const R_STATAT = 26;
const R_READDIR = 27;
const R_MKDIRAT = 28;
const R_UNLINKAT = 29;
const R_RENAMEAT = 30;
const R_READLINKAT = 31;
const R_SYMLINKAT = 32;
const R_FTRUNCATE = 33;
const R_FSYNC = 34;
const R_UTIMENS = 35;
const R_LINKAT = 36;
const R_POLL = 37;
const R_RENUMBER = 38;

/** @internal The import modules a program may use: WASI preview 1, and preview 0 (adapted). */
export const WASI_MODULES = ["wasi_snapshot_preview1", "wasi_unstable"];

/** The most one read or write asks of kwwasi. */
const MAX_IO = 1 << 20;

/**
 * @internal The shared channel (one growable SharedArrayBuffer per program):
 * Int32 control words, then the frame area at CH_DATA. The worker writes a
 * request frame there, its length to CH_LEN, and bumps CH_REQ; the owner
 * writes the REPLY body (errno, result) over it, its length to CH_LEN, and
 * sets CH_REP to that CH_REQ. CH_SLEEP is never notified (poll_oneoff's
 * sleeps wait on it).
 */
export const CH_REQ = 0, CH_REP = 1, CH_LEN = 2, CH_SLEEP = 3;
export const CH_DATA = 64;
export const CH_INITIAL = CH_DATA + (256 << 10);
/** kwwasi's MAX_FRAME and a frame header. */
export const CH_MAX = CH_DATA + 8 + (64 << 20);
/** @internal Make room for `bytes` in the frame area (false: more than CH_MAX). */
export function channelRoom(sab: SharedArrayBuffer, bytes: number): boolean {
	const need = CH_DATA + bytes;
	if (need > CH_MAX) return false;
	if (sab.byteLength < need) {
		let size = sab.byteLength;
		while (size < need) size *= 2;
		sab.grow(Math.min(size, CH_MAX));
	}
	return true;
}
/**
 * How long the worker spins on a reply before it sleeps in Atomics.wait
 * (ms). A small request takes kwwasi 40-90 us; waking from Atomics.wait
 * adds tens of us to each (numbers in .agents/status.md).
 */
const SPIN_MS = 0.2;
const pause: (() => void) | undefined = (Atomics as { pause?: () => void }).pause;

type Maybe<T> = T | Promise<T>;
/** f(x), after x settles if it is a promise: one body for the shared (sync) and the message (JSPI) path. */
function then<T, U>(x: Maybe<T>, f: (v: T) => Maybe<U>): Maybe<U> {
	return x instanceof Promise ? x.then(f) : f(x);
}

// Linux open and at flags with their asm-generic values, which is how they
// cross the connection: kwwasi maps the open flags to its architecture's.
const O_WRONLY = 0x1;
const O_RDWR = 0x2;
const O_CREAT = 0x40;
const O_EXCL = 0x80;
const O_TRUNC = 0x200;
const O_APPEND = 0x400;
const O_NONBLOCK = 0x800;
const O_DSYNC = 0x1000;
const O_SYNC = 0x101000;
const O_DIRECTORY = 0x10000;
const O_NOFOLLOW = 0x20000;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_REMOVEDIR = 0x200;
const AT_SYMLINK_FOLLOW = 0x400;

// WASI errno values.
const E = {
	SUCCESS: 0, BADF: 8, FAULT: 21, INVAL: 28, IO: 29, NAMETOOLONG: 37, NOSYS: 52, NOTSUP: 58,
} as const;
// Linux errno -> WASI errno.
const LINUX_TO_WASI: Record<number, number> = {
	1: 63, 2: 44, 3: 71, 4: 27, 5: 29, 6: 60, 7: 1, 8: 45, 9: 8, 10: 12, 11: 6, 12: 48, 13: 2, 14: 21,
	16: 10, 17: 20, 18: 75, 19: 43, 20: 54, 21: 31, 22: 28, 23: 41, 24: 33, 25: 59, 26: 74, 27: 22,
	28: 51, 29: 70, 30: 69, 31: 34, 32: 64, 33: 18, 34: 68, 35: 16, 36: 37, 37: 46, 38: 52, 39: 55,
	40: 32, 61: 29, 71: 65, 75: 61, 84: 25, 88: 57, 95: 58, 104: 15, 107: 53, 110: 73, 111: 14,
	116: 72, 122: 19, 125: 11,
};
const wasiErrno = (linux: number) => LINUX_TO_WASI[linux] ?? E.IO;

// WASI file types.
const FT_UNKNOWN = 0;
const FT_BLOCK = 1;
const FT_CHAR = 2;
const FT_DIR = 3;
const FT_REG = 4;
const FT_SOCK = 6;
const FT_LINK = 7;
function fileType(mode: number): number {
	switch (mode & 0o170000) {
		case 0o060000: return FT_BLOCK;
		case 0o020000: return FT_CHAR;
		case 0o040000: return FT_DIR;
		case 0o100000: return FT_REG;
		case 0o140000: return FT_SOCK;
		case 0o120000: return FT_LINK;
		default: return FT_UNKNOWN;
	}
}

const RIGHTS_ALL = (1n << 30n) - 1n;
const RIGHT_FD_READ = 1n << 1n;
const RIGHT_FD_SEEK = 1n << 2n;
const RIGHT_FD_TELL = 1n << 5n;
const RIGHT_FD_WRITE = 1n << 6n;

/** proc_exit. */
class ProcExit extends Error {
	readonly code: number;
	constructor(code: number) {
		super(`proc_exit(${code})`);
		this.code = code;
	}
}

/** @internal Little-endian frame builder. */
export class Enc {
	#buf = new Uint8Array(64);
	#dv = new DataView(this.#buf.buffer);
	#len = 8; // room for the frame header
	#grow(n: number): void {
		if (this.#len + n <= this.#buf.length) return;
		let cap = this.#buf.length * 2;
		while (cap < this.#len + n) cap *= 2;
		const b = new Uint8Array(cap);
		b.set(this.#buf.subarray(0, this.#len));
		this.#buf = b;
		this.#dv = new DataView(b.buffer);
	}
	u32(v: number): this {
		this.#grow(4);
		this.#dv.setUint32(this.#len, v >>> 0, true);
		this.#len += 4;
		return this;
	}
	u64(v: bigint): this {
		this.#grow(8);
		this.#dv.setBigUint64(this.#len, BigInt.asUintN(64, v), true);
		this.#len += 8;
		return this;
	}
	bytes(b: Uint8Array): this {
		this.#grow(b.length);
		this.#buf.set(b, this.#len);
		this.#len += b.length;
		return this;
	}
	str(b: Uint8Array): this {
		return this.u32(b.length).bytes(b);
	}
	/** The frame so far, its header filled in; `more`: payload bytes that the caller puts after it. */
	frame(op: number, more = 0): Uint8Array {
		this.#dv.setUint32(0, op, true);
		this.#dv.setUint32(4, this.#len - 8 + more, true);
		return this.#buf.subarray(0, this.#len);
	}
}

interface LinuxStat {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	atim: bigint;
	mtim: bigint;
	ctim: bigint;
	mode: number;
}
function decodeStat(b: Uint8Array): LinuxStat {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const q = (i: number) => dv.getBigUint64(i * 8, true);
	return { dev: q(0), ino: q(1), nlink: q(2), size: q(3), atim: q(4), mtim: q(5), ctim: q(6), mode: dv.getUint32(56, true) };
}

/** What the owner sends a program's worker (structured-cloneable). */
export type WasiToProgram =
	/** The first message: run this program. */
	| {
		t: "start"; module: WebAssembly.Module; name: string; args: Uint8Array[]; env: Uint8Array[]; preopens: Array<[number, Uint8Array]>;
		/** The shared channel (CH_*): requests go through it, not as messages, and the imports block instead of suspending. */
		channel?: SharedArrayBuffer;
	}
	/** kwwasi's REPLY to the last request: i32 Linux errno, then the result. */
	| { t: "reply"; body: Uint8Array };

/** What a program's worker sends its owner. */
export type WasiFromProgram =
	/** A request frame for kwwasi (op, length, payload); its REPLY comes back as "reply". */
	| { t: "request"; frame: Uint8Array }
	/** The program ended: kwwasi exits with `code` and writes `msg` (if any) to stderr. `failed`: a trap or an error. */
	| { t: "exit"; code: number; msg: string; failed: boolean }
	| { t: "log"; msg: string };

/** The owner's handle on a program's worker (WasiExecOptions.spawn). */
export interface WasiProgramEndpoint {
	post(msg: WasiToProgram, transfer?: ArrayBuffer[]): void;
	listen(h: {
		message(msg: WasiFromProgram): void;
		/** An uncaught error in the worker (or one that failed to start). */
		error(err: unknown): void;
		/** The worker thread ended (also after terminate()). */
		exit(): void;
	}): void;
	/** End the worker now, even in the middle of a computation. */
	terminate(): void;
}

/** The worker's way to its owner (its entry's port). */
export interface WasiProgramPort {
	post(msg: WasiFromProgram, transfer?: ArrayBuffer[]): void;
	listen(handler: (msg: WasiToProgram) => void): void;
}

/**
 * A program's worker (called by the worker's entry): run the program a
 * "start" brings; once it has ended by itself ("exit" sent), the owner may
 * send the next one.
 */
export function serveWasiProgram(port: WasiProgramPort): void {
	let prog: Program | undefined;
	port.listen((msg) => {
		if (msg.t === "start" && !prog) {
			const p = prog = new Program(port, msg.args, msg.env, new Map(msg.preopens), msg.channel);
			void p.run(msg.module, msg.name).finally(() => {
				if (prog === p) prog = undefined;
			});
		} else if (msg.t === "reply") {
			prog?.reply(msg.body);
		}
	});
}

interface Reply {
	err: number;
	data: Uint8Array;
}

class Program {
	memory: WebAssembly.Memory | undefined;
	#port: WasiProgramPort;
	#args: Uint8Array[];
	#env: Uint8Array[];
	#preopens: Map<number, Uint8Array>;
	/** Takes the reply to the request in flight (one at a time; the message path). */
	#pending: ((body: Uint8Array) => void) | undefined;
	/** The shared channel, its control words and the last request's number (the shared path). */
	#ch: SharedArrayBuffer | undefined;
	#ctl: Int32Array | undefined;
	#seq = 0;

	constructor(port: WasiProgramPort, args: Uint8Array[], env: Uint8Array[], preopens: Map<number, Uint8Array>, channel?: SharedArrayBuffer) {
		this.#port = port;
		this.#args = args;
		this.#env = env;
		this.#preopens = preopens;
		this.#ch = channel;
		this.#ctl = channel && new Int32Array(channel, 0, CH_DATA / 4);
	}

	#exit(code: number, msg = "", failed = false): void {
		this.#port.post({ t: "exit", code, msg, failed });
	}

	/** Instantiate the module and run `_start`; ends with an "exit" message. */
	async run(module: WebAssembly.Module, name: string): Promise<void> {
		let instance: WebAssembly.Instance;
		try {
			instance = await WebAssembly.instantiate(module, this.imports(module));
		} catch (e) {
			return this.#exit(126, `kwwasi: ${name}: ${(e as Error)?.message ?? e}`);
		}
		const memory = instance.exports.memory;
		if (!(memory instanceof WebAssembly.Memory)) return this.#exit(126, `kwwasi: ${name}: exports no memory`);
		this.memory = memory;
		try {
			const start = instance.exports._start as () => void;
			// Shared: the imports block, so `_start` runs to its end right here; else they suspend.
			if (this.#ch) start();
			else await WebAssembly.promising(start)();
			this.#exit(0);
		} catch (e) {
			if (e instanceof ProcExit) return this.#exit(e.code);
			const msg = e instanceof WebAssembly.RuntimeError ? `wasm trap: ${e.message}` : `${(e as Error)?.message ?? e}`;
			this.#exit(134, `kwwasi: ${name}: ${msg}`, true);
		}
	}

	/** kwwasi's reply to the request in flight. */
	reply(body: Uint8Array): void {
		const p = this.#pending;
		this.#pending = undefined;
		p?.(body);
	}

	get #u8(): Uint8Array<ArrayBuffer> {
		return new Uint8Array(this.memory!.buffer as ArrayBuffer);
	}
	get #dv(): DataView {
		return new DataView(this.memory!.buffer);
	}

	/**
	 * One request to kwwasi and its reply (the owner checked the frame). The
	 * shared path returns at once with a view of the channel, valid until the
	 * next request; the message path returns a promise. `tail`: the rest of
	 * the payload (a write's data, views of the program's memory), copied
	 * once, into the channel or the frame.
	 */
	#call(op: number, req: Enc, tail?: Uint8Array[]): Maybe<Reply> {
		const toReply = (body: Uint8Array): Reply => {
			const err = new DataView(body.buffer, body.byteOffset, body.byteLength).getInt32(0, true);
			return { err: err ? wasiErrno(err) : 0, data: body.subarray(4) };
		};
		const ch = this.#ch, ctl = this.#ctl;
		if (!ch || !ctl) {
			if (tail) for (const t of tail) req.bytes(t);
			// The Enc's buffer goes with the message: this request is its only use.
			const frame = req.frame(op);
			return new Promise<Uint8Array>((resolve) => {
				this.#pending = resolve;
				this.#port.post({ t: "request", frame }, [frame.buffer as ArrayBuffer]);
			}).then(toReply);
		}
		const more = tail ? tail.reduce((n, t) => n + t.length, 0) : 0;
		const head = req.frame(op, more);
		if (!channelRoom(ch, head.length + more)) return { err: E.NAMETOOLONG, data: new Uint8Array() };
		const area = new Uint8Array(ch, CH_DATA, head.length + more);
		area.set(head);
		if (tail) {
			let at = head.length;
			for (const t of tail) {
				area.set(t, at);
				at += t.length;
			}
		}
		Atomics.store(ctl, CH_LEN, area.length);
		const seq = ++this.#seq | 0;
		Atomics.store(ctl, CH_REQ, seq);
		Atomics.notify(ctl, CH_REQ);
		if (Atomics.load(ctl, CH_REP) !== seq) {
			const t = performance.now();
			while (Atomics.load(ctl, CH_REP) !== seq && performance.now() - t < SPIN_MS) pause?.();
		}
		for (let rep; (rep = Atomics.load(ctl, CH_REP)) !== seq;) Atomics.wait(ctl, CH_REP, rep);
		return toReply(new Uint8Array(ch, CH_DATA, Atomics.load(ctl, CH_LEN)));
	}
	/** Sleep `ms` (poll_oneoff with only clocks). */
	#sleep(ms: number): Maybe<void> {
		if (!this.#ctl) return new Promise((r) => setTimeout(r, ms));
		Atomics.wait(this.#ctl, CH_SLEEP, 0, ms);
	}

	#bytes(ptr: number, len: number): Uint8Array {
		return this.#u8.slice(ptr, ptr + len);
	}
	#iovs(ptr: number, n: number): Array<[number, number]> {
		const dv = this.#dv;
		return Array.from({ length: n }, (_, i) => [dv.getUint32(ptr + i * 8, true), dv.getUint32(ptr + i * 8 + 4, true)]);
	}
	/** A filestat: preview 1's 64 bytes (u64 nlink), or preview 0's 56 (u32 nlink at 20, the rest 8 bytes earlier). */
	#putFilestat(ptr: number, st: LinuxStat, p0: boolean): void {
		const dv = this.#dv;
		dv.setBigUint64(ptr, st.dev, true);
		dv.setBigUint64(ptr + 8, st.ino, true);
		dv.setUint8(ptr + 16, fileType(st.mode));
		let at = ptr + 24;
		if (p0) {
			dv.setUint32(ptr + 20, st.nlink > 0xffffffffn ? 0xffffffff : Number(st.nlink), true);
		} else {
			dv.setBigUint64(at, st.nlink, true);
			at += 8;
		}
		dv.setBigUint64(at, st.size, true);
		dv.setBigUint64(at + 8, st.atim, true);
		dv.setBigUint64(at + 16, st.mtim, true);
		dv.setBigUint64(at + 24, st.ctim, true);
	}
	#strings(list: Uint8Array[], ptrs: number, buf: number): number {
		const u8 = this.#u8, dv = this.#dv;
		list.forEach((s, i) => {
			dv.setUint32(ptrs + i * 4, buf, true);
			u8.set(s, buf);
			u8[buf + s.length] = 0;
			buf += s.length + 1;
		});
		return E.SUCCESS;
	}
	#sizes(list: Uint8Array[], countPtr: number, sizePtr: number): number {
		this.#dv.setUint32(countPtr, list.length, true);
		this.#dv.setUint32(sizePtr, list.reduce((n, s) => n + s.length + 1, 0), true);
		return E.SUCCESS;
	}
	/** The u32 or u64 at the start of a reply's result. */
	#u32(r: Reply): number {
		return new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getUint32(0, true);
	}
	#u64(r: Reply): bigint {
		return new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getBigUint64(0, true);
	}

	#read(fd: number, iovs: number, n: number, nread: number, offset?: bigint): Maybe<number> {
		const vec = this.#iovs(iovs, n);
		const total = Math.min(MAX_IO, vec.reduce((s, [, l]) => s + l, 0));
		const req = new Enc().u32(fd).u32(total);
		if (offset !== undefined) req.u64(offset);
		return then(this.#call(offset === undefined ? R_READ : R_PREAD, req), (r) => {
			if (r.err) return r.err;
			const u8 = this.#u8;
			let at = 0;
			for (const [p, l] of this.#iovs(iovs, n)) {
				if (at >= r.data.length) break;
				const take = Math.min(l, r.data.length - at);
				u8.set(r.data.subarray(at, at + take), p);
				at += take;
			}
			this.#dv.setUint32(nread, at, true);
			return E.SUCCESS;
		});
	}
	#write(fd: number, iovs: number, n: number, nwritten: number, offset?: bigint): Maybe<number> {
		const req = new Enc().u32(fd);
		if (offset !== undefined) req.u64(offset);
		let total = 0;
		const u8 = this.#u8, data: Uint8Array[] = [];
		for (const [p, l] of this.#iovs(iovs, n)) {
			const take = Math.min(l, MAX_IO - total);
			data.push(u8.subarray(p, p + take));
			total += take;
			if (total >= MAX_IO) break;
		}
		return then(this.#call(offset === undefined ? R_WRITE : R_PWRITE, req, data), (r) => {
			if (r.err) return r.err;
			this.#dv.setUint32(nwritten, this.#u32(r), true);
			return E.SUCCESS;
		});
	}
	#stat(op: number, req: Enc, out: number, p0: boolean): Maybe<number> {
		return then(this.#call(op, req), (r) => {
			if (r.err) return r.err;
			this.#putFilestat(out, decodeStat(r.data), p0);
			return E.SUCCESS;
		});
	}
	#times(atim: bigint, mtim: bigint, flags: number): [bigint, bigint] {
		// fstflags: 1 ATIM, 2 ATIM_NOW, 4 MTIM, 8 MTIM_NOW. -1 = now, -2 = omit.
		const a = flags & 2 ? -1n : flags & 1 ? atim : -2n;
		const m = flags & 8 ? -1n : flags & 4 ? mtim : -2n;
		return [a, m];
	}
	#simple(op: number, req: Enc): Maybe<number> {
		return then(this.#call(op, req), (r) => r.err);
	}
	/** A request whose result is a u32 (`fd`, a count) or u64 (a position) to store at `out`. */
	#scalar(op: number, req: Enc, out: number, wide: boolean): Maybe<number> {
		return then(this.#call(op, req), (r) => {
			if (r.err) return r.err;
			if (wide) this.#dv.setBigUint64(out, this.#u64(r), true);
			else this.#dv.setUint32(out, this.#u32(r), true);
			return E.SUCCESS;
		});
	}
	/** A request whose result is bytes for the program's buffer (`buf`, at most `len`; `used` gets the count). */
	#into(op: number, req: Enc, buf: number, len: number, used: number): Maybe<number> {
		return then(this.#call(op, req), (r) => {
			if (r.err) return r.err;
			const n = Math.min(len, r.data.length);
			this.#u8.set(r.data.subarray(0, n), buf);
			this.#dv.setUint32(used, n, true);
			return E.SUCCESS;
		});
	}
	#now(id: number): bigint {
		if (id === 0) return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
		return BigInt(Math.round(performance.now() * 1e6));
	}

	/**
	 * poll_oneoff. Subscriptions are 48 bytes in preview 1; preview 0's are
	 * 56, its clock subscription starting with a u64 `identifier` (so id,
	 * timeout and flags are 8 bytes later). Events are the same in both.
	 */
	#poll(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number, p0: boolean): Maybe<number> {
		if (nsubs === 0) return E.INVAL;
		const dv = this.#dv;
		const size = p0 ? 56 : 48, clock = p0 ? 24 : 16;
		interface Sub { userdata: bigint; tag: number; fd: number; timeout: number }
		const subs: Sub[] = [];
		for (let i = 0; i < nsubs; i++) {
			const p = inPtr + i * size;
			const tag = dv.getUint8(p + 8);
			const sub: Sub = { userdata: dv.getBigUint64(p, true), tag, fd: 0, timeout: Infinity };
			if (tag === 0) {
				const id = dv.getUint32(p + clock, true);
				let t = dv.getBigUint64(p + clock + 8, true);
				if (dv.getUint16(p + clock + 24, true) & 1) t = t > this.#now(id) ? t - this.#now(id) : 0n;
				sub.timeout = Number(t) / 1e6;
			} else {
				sub.fd = dv.getUint32(p + 16, true);
			}
			subs.push(sub);
		}
		const min = Math.min(...subs.map((s) => s.timeout));
		const fdSubs = subs.filter((s) => s.tag !== 0);
		const events: Array<{ sub: Sub; flags: number; error: number }> = [];
		const finish = () => {
			if (!events.length) for (const s of subs) if (s.tag === 0 && s.timeout <= min) events.push({ sub: s, flags: 0, error: 0 });
			const out = this.#dv;
			events.forEach((ev, i) => {
				const p = outPtr + i * 32;
				for (let j = 0; j < 32; j += 8) out.setBigUint64(p + j, 0n, true);
				out.setBigUint64(p, ev.sub.userdata, true);
				out.setUint16(p + 8, ev.error, true);
				out.setUint8(p + 10, ev.sub.tag);
				out.setUint16(p + 24, ev.flags, true);
			});
			out.setUint32(neventsPtr, events.length, true);
			return E.SUCCESS;
		};
		if (fdSubs.length) {
			const req = new Enc().u32(min === Infinity ? -1 : Math.ceil(min)).u32(fdSubs.length);
			for (const s of fdSubs) req.u32(s.fd).u32(s.tag === 1 ? 1 : 4); // POLLIN, POLLOUT
			return then(this.#call(R_POLL, req), (r) => {
				if (r.err) return r.err;
				const rv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
				fdSubs.forEach((s, i) => {
					const revents = rv.getUint32(i * 4, true);
					if (revents & 0x8) events.push({ sub: s, flags: 0, error: E.IO }); // POLLERR
					else if (revents & 0x20) events.push({ sub: s, flags: 0, error: E.BADF }); // POLLNVAL
					else if (revents) events.push({ sub: s, flags: revents & 0x10 ? 1 : 0, error: 0 }); // POLLHUP
				});
				return finish();
			});
		}
		return min > 0 ? then(this.#sleep(min), finish) : finish();
	}

	/** The import object for `module`: the functions it imports from wasi_snapshot_preview1 and wasi_unstable (WASI0). */
	imports(module: WebAssembly.Module): WebAssembly.Imports {
		const self = this;
		// Calls that ask kwwasi (block on the shared channel, or suspend), then those answered here.
		const remote: Record<string, (...a: any[]) => Maybe<number>> = {
			fd_read: (fd: number, iovs: number, n: number, nread: number) => this.#read(fd, iovs, n, nread),
			fd_pread: (fd: number, iovs: number, n: number, off: bigint, nread: number) => this.#read(fd, iovs, n, nread, off),
			fd_write: (fd: number, iovs: number, n: number, nw: number) => this.#write(fd, iovs, n, nw),
			fd_pwrite: (fd: number, iovs: number, n: number, off: bigint, nw: number) => this.#write(fd, iovs, n, nw, off),
			// whence: SET 0, CUR 1, END 2, as Linux's lseek().
			fd_seek: (fd: number, off: bigint, whence: number, out: number) =>
				whence > 2 ? E.INVAL : this.#scalar(R_SEEK, new Enc().u32(fd).u32(whence).u64(off), out, true),
			fd_tell: (fd: number, out: number) => this.#scalar(R_SEEK, new Enc().u32(fd).u32(1).u64(0n), out, true),
			fd_close: (fd: number) =>
				then(this.#simple(R_CLOSE, new Enc().u32(fd)), (err) => {
					if (!err) self.#preopens.delete(fd);
					return err;
				}),
			fd_renumber: (from: number, to: number) =>
				then(this.#simple(R_RENUMBER, new Enc().u32(from).u32(to)), (err) => {
					if (!err && from !== to) {
						const p = self.#preopens.get(from);
						self.#preopens.delete(from);
						self.#preopens.delete(to);
						if (p) self.#preopens.set(to, p);
					}
					return err;
				}),
			fd_filestat_get: (fd: number, out: number) => this.#stat(R_FSTAT, new Enc().u32(fd), out, false),
			fd_fdstat_get: (fd: number, out: number) =>
				then(this.#call(R_FDSTAT, new Enc().u32(fd)), (r) => {
					if (r.err) return r.err;
					const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
					const mode = v.getUint32(0, true), fl = v.getUint32(4, true), tty = v.getUint32(8, true);
					let flags = 0;
					if (fl & O_APPEND) flags |= 1;
					if (fl & O_DSYNC) flags |= 2;
					if (fl & O_NONBLOCK) flags |= 4;
					if ((fl & O_SYNC) === O_SYNC) flags |= 16;
					const dv = self.#dv;
					dv.setUint8(out, fileType(mode));
					dv.setUint16(out + 2, flags, true);
					// isatty() in wasi-libc: a character device without seek and tell rights.
					dv.setBigUint64(out + 8, tty ? RIGHTS_ALL & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL) : RIGHTS_ALL, true);
					dv.setBigUint64(out + 16, RIGHTS_ALL, true);
					return E.SUCCESS;
				}),
			fd_fdstat_set_flags: (fd: number, flags: number) =>
				this.#simple(R_SETFL, new Enc().u32(fd).u32((flags & 1 ? O_APPEND : 0) | (flags & 4 ? O_NONBLOCK : 0))),
			fd_filestat_set_size: (fd: number, size: bigint) => this.#simple(R_FTRUNCATE, new Enc().u32(fd).u64(size)),
			fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, flags: number) {
				const [a, m] = self.#times(atim, mtim, flags);
				return self.#simple(R_UTIMENS, new Enc().u32(fd).u32(0).u64(a).u64(m));
			},
			fd_sync: (fd: number) => this.#simple(R_FSYNC, new Enc().u32(fd).u32(0)),
			fd_datasync: (fd: number) => this.#simple(R_FSYNC, new Enc().u32(fd).u32(1)),
			fd_readdir: (fd: number, buf: number, len: number, cookie: bigint, used: number) =>
				this.#into(R_READDIR, new Enc().u32(fd).u32(len).u64(cookie), buf, len, used),
			path_open(dirfd: number, lookup: number, path: number, plen: number, oflags: number,
				base: bigint, _inheriting: bigint, fdflags: number, out: number) {
				let fl = 0;
				if (oflags & 2) fl |= O_DIRECTORY;
				else if (base & RIGHT_FD_WRITE) fl |= base & RIGHT_FD_READ ? O_RDWR : O_WRONLY;
				if (oflags & 1) fl |= O_CREAT;
				if (oflags & 4) fl |= O_EXCL;
				if (oflags & 8) fl |= O_TRUNC;
				if (fdflags & 1) fl |= O_APPEND;
				if (fdflags & 2) fl |= O_DSYNC;
				if (fdflags & 4) fl |= O_NONBLOCK;
				if (fdflags & 24) fl |= O_SYNC;
				if (!(lookup & 1)) fl |= O_NOFOLLOW;
				return self.#scalar(R_OPENAT, new Enc().u32(dirfd).u32(fl).bytes(self.#bytes(path, plen)), out, false);
			},
			path_filestat_get: (fd: number, lookup: number, path: number, plen: number, out: number) =>
				this.#stat(R_STATAT, new Enc().u32(fd).u32(lookup & 1 ? 0 : AT_SYMLINK_NOFOLLOW).bytes(this.#bytes(path, plen)), out, false),
			path_filestat_set_times(fd: number, lookup: number, path: number, plen: number, atim: bigint, mtim: bigint, flags: number) {
				const [a, m] = self.#times(atim, mtim, flags);
				const p = self.#bytes(path, plen);
				if (!p.length) return 44; // ENOENT, as utimensat("")
				return self.#simple(R_UTIMENS, new Enc().u32(fd).u32(lookup & 1 ? 0 : AT_SYMLINK_NOFOLLOW).u64(a).u64(m).bytes(p));
			},
			path_create_directory: (fd: number, path: number, plen: number) =>
				this.#simple(R_MKDIRAT, new Enc().u32(fd).bytes(this.#bytes(path, plen))),
			path_remove_directory: (fd: number, path: number, plen: number) =>
				this.#simple(R_UNLINKAT, new Enc().u32(fd).u32(AT_REMOVEDIR).bytes(this.#bytes(path, plen))),
			path_unlink_file: (fd: number, path: number, plen: number) =>
				this.#simple(R_UNLINKAT, new Enc().u32(fd).u32(0).bytes(this.#bytes(path, plen))),
			path_rename: (fd: number, old: number, olen: number, nfd: number, np: number, nlen: number) =>
				this.#simple(R_RENAMEAT, new Enc().u32(fd).u32(nfd).str(this.#bytes(old, olen)).str(this.#bytes(np, nlen))),
			path_link: (fd: number, lookup: number, old: number, olen: number, nfd: number, np: number, nlen: number) =>
				this.#simple(R_LINKAT, new Enc().u32(fd).u32(nfd).u32(lookup & 1 ? AT_SYMLINK_FOLLOW : 0)
					.str(this.#bytes(old, olen)).str(this.#bytes(np, nlen))),
			path_symlink: (old: number, olen: number, fd: number, np: number, nlen: number) =>
				this.#simple(R_SYMLINKAT, new Enc().u32(fd).str(this.#bytes(old, olen)).str(this.#bytes(np, nlen))),
			path_readlink: (fd: number, path: number, plen: number, buf: number, blen: number, used: number) =>
				this.#into(R_READLINKAT, new Enc().u32(fd).bytes(this.#bytes(path, plen)), buf, blen, used),
			poll_oneoff: (inp: number, out: number, n: number, nev: number) => this.#poll(inp, out, n, nev, false),
		};
		/**
		 * Preview 0 (`wasi_unstable`; WebAssembly/WASI's legacy preview0 witx,
		 * wasmtime crates/wasi/witx/p0): the same functions but for whence
		 * (CUR 0, END 1, SET 2), filestat (56 bytes, u32 nlink) and poll_oneoff's
		 * subscriptions (56 bytes); it has no sock_accept.
		 */
		const WASI0_WHENCE = [1, 2, 0];
		const remote0: Record<string, (...a: any[]) => Maybe<number>> = {
			...remote,
			fd_seek: (fd: number, off: bigint, whence: number, out: number) =>
				remote.fd_seek!(fd, off, WASI0_WHENCE[whence] ?? 3, out),
			fd_filestat_get: (fd: number, out: number) => this.#stat(R_FSTAT, new Enc().u32(fd), out, true),
			path_filestat_get: (fd: number, lookup: number, path: number, plen: number, out: number) =>
				this.#stat(R_STATAT, new Enc().u32(fd).u32(lookup & 1 ? 0 : AT_SYMLINK_NOFOLLOW).bytes(this.#bytes(path, plen)), out, true),
			poll_oneoff: (inp: number, out: number, n: number, nev: number) => this.#poll(inp, out, n, nev, true),
		};
		const local: Record<string, (...a: any[]) => number> = {
			args_sizes_get: (c: number, s: number) => this.#sizes(this.#args, c, s),
			args_get: (p: number, b: number) => this.#strings(this.#args, p, b),
			environ_sizes_get: (c: number, s: number) => this.#sizes(this.#env, c, s),
			environ_get: (p: number, b: number) => this.#strings(this.#env, p, b),
			fd_prestat_get(fd: number, out: number) {
				const name = self.#preopens.get(fd);
				if (!name) return E.BADF;
				self.#dv.setUint32(out, 0, true); // tag 0: a directory
				self.#dv.setUint32(out + 4, name.length, true);
				return E.SUCCESS;
			},
			fd_prestat_dir_name(fd: number, buf: number, len: number) {
				const name = self.#preopens.get(fd);
				if (!name) return E.BADF;
				self.#u8.set(name.subarray(0, len), buf);
				return E.SUCCESS;
			},
			fd_advise: () => E.SUCCESS,
			fd_allocate: () => E.NOTSUP,
			fd_fdstat_set_rights: () => E.SUCCESS,
			clock_res_get(_id: number, out: number) {
				self.#dv.setBigUint64(out, 1000n, true);
				return E.SUCCESS;
			},
			clock_time_get(id: number, _precision: bigint, out: number) {
				self.#dv.setBigUint64(out, self.#now(id), true);
				return E.SUCCESS;
			},
			random_get(buf: number, len: number) {
				const u8 = self.#u8;
				for (let at = 0; at < len; at += 65536) crypto.getRandomValues(u8.subarray(buf + at, buf + Math.min(len, at + 65536)));
				return E.SUCCESS;
			},
			sched_yield: () => E.SUCCESS,
			proc_raise: () => E.NOSYS,
			proc_exit(code: number) {
				throw new ProcExit(code);
			},
			sock_accept: () => E.NOTSUP,
			sock_recv: () => E.NOTSUP,
			sock_send: () => E.NOTSUP,
			sock_shutdown: () => E.NOTSUP,
		};
		const out: Record<string, Record<string, unknown>> = {};
		for (const imp of WebAssembly.Module.imports(module)) {
			if (!WASI_MODULES.includes(imp.module) || imp.kind !== "function") continue;
			const ns = (out[imp.module] ??= {});
			const r = (imp.module === "wasi_unstable" ? remote0 : remote)[imp.name];
			const l = imp.name === "sock_accept" && imp.module === "wasi_unstable" ? undefined : local[imp.name];
			if (r) {
				ns[imp.name] = this.#ch ? r : new WebAssembly.Suspending(r as (...a: any[]) => Promise<number>);
			} else if (l) {
				ns[imp.name] = l;
			} else {
				this.#port.post({ t: "log", msg: `[wasi] ${imp.module}.${imp.name} is not implemented (ENOSYS)` });
				ns[imp.name] = () => E.NOSYS;
			}
		}
		return out as WebAssembly.Imports;
	}
}
