// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest shmem files read and written in place: the host side of kwshm
// (drivers/misc/kwshm.c in the kernel tree).
//
// The kernel runs in the direct map, so the pages of a guest shmem file (a
// memfd, a file in /dev/shm) already lie in the kernel's memory; kwshm
// tells the host which pages a file occupies and holds them (pinned) while
// the host may look. An export is a file, or a page-aligned range of one,
// with an id; the kernel announces each one with its page list
// (wasm_driver_shm_attach, copied during the call), withdraws it with
// wasm_driver_shm_detach and only then lets the pages go. Exports come from
// two places:
//  - the host: open or create a file in /dev/shm by name, refresh it, check
//    whether it went stale, close it. These are requests: queued here,
//    signalled with IRQ 7, taken by a kernel work item
//    (wasm_driver_shm_request) and answered (wasm_driver_shm_reply), so
//    each is a round trip through the kernel;
//  - the guest: ioctl KWSHM_IOC_EXPORT on /dev/kwshm exports a shmem fd and
//    returns its id, which a guest program sends to the host however it
//    likes; openId() picks it up (the page list is already here). It lives
//    until the guest releases it or closes /dev/kwshm.
// Holes are allocated on export, so every page is the file's. Pages a
// truncation removes stay held, so the host's view may go stale but never
// points at freed memory; isStale() asks the kernel, refresh() takes the
// file's current pages.
//
// Layers: ShmDevice is the kernel's end on the kernel's thread (the five
// imports, the request queue, the page lists, and the copies). ShmClient is
// the API (`vm.shm`), built on a backend that runs ShmCalls: inline it calls
// ShmDevice directly; in worker mode the calls cross as messages and run in
// the worker (worker-serve.ts), where the kernel's memory is, and read()
// returns the bytes transferred back. Either way read() and write() copy
// once across the page list. No import suspends.
//
// In place (readSync(), views(); ShmFile.inPlace): inline always. In worker
// mode where the kernel's memory is a SharedArrayBuffer (an SMP kernel) and
// the shared transport is on, the worker posts that memory and a slot table
// (ShmShareServer, ShmInPlace below); each info reply then carries the
// export's page runs, and reads and views run on the owner's thread with no
// message. The slot table keeps that safe without the kernel's help: a slot
// per export holds a token while its page list is current, and a pin the
// owner sets while it touches the pages. The kernel frees an export's pages
// only after its detach (or, for a refresh, the new list's attach) import
// returned; in that import the worker clears the token and, if the owner
// has the slot pinned, waits (Atomics.wait, at most PIN_WAIT_MS) for the
// unpin. The owner pins, then checks the token (both sequentially
// consistent), so either it sees the token gone (EAGAIN: take the message
// path, which says what happened) or the worker sees the pin and waits. A
// read pins for its copy; views() pins until the current task's microtasks
// run. Elsewhere (the UP kernel's memory is not shared) the worker's
// shared transport serves read() at the kernel's next clock read
// (worker-shared.ts), and without the shared transport it is a message.

/** kwshm's page size. */
export const SHM_PAGE_SIZE = 4096;
/** sizeof(struct kwshm_req) in the kernel: op, tag, id, flags (u32), size (u64), name[256]. */
const REQ_SIZE = 280;
const NAME_MAX = 255;
const OP_OPEN = 1;
const OP_CREATE = 2;
const OP_REFRESH = 3;
const OP_CHECK = 4;
const OP_CLOSE = 5;
const REFRESH_FORCE = 1;
/** wasm_driver_shm_attach() flags. */
const FLAG_WRITABLE = 1;
const FLAG_GUEST = 2;
const DEFAULT_TIMEOUT_MS = 10000;

const ERRNO_NAMES: Record<number, string> = {
	1: "EPERM", 2: "ENOENT", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 16: "EBUSY",
	17: "EEXIST", 19: "ENODEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 27: "EFBIG", 28: "ENOSPC",
	30: "EROFS", 36: "ENAMETOOLONG", 40: "ELOOP", 95: "EOPNOTSUPP",
};

/** Why a shm operation failed: `code` is the errno name (ENOENT, EINVAL, ...). */
export class ShmError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ShmError";
		this.code = code;
	}
}

function errnoError(errno: number, what: string): ShmError {
	const code = ERRNO_NAMES[errno] ?? `E${errno}`;
	return new ShmError(code, `${what}: ${code}`);
}

/** An export, as the kernel last described it. */
export interface ShmInfo {
	id: number;
	/** Bytes exported. */
	size: number;
	/** Pages held (size rounded up to whole pages). */
	pages: number;
	/** Whether the host may write (the guest's fd was writable and not sealed against writes, or a file the host opened read-write). */
	writable: boolean;
	/** Made by the guest (KWSHM_IOC_EXPORT) rather than opened or created by the host. */
	guest: boolean;
	/** Counts the page lists the kernel announced for this export (1 at first; refresh() adds one when it changes). */
	generation: number;
}

/** What a machine snapshot keeps of kwshm (ShmDevice.saveState()): the exports and their pages. */
export interface ShmSnapshot {
	exports: { info: ShmInfo; runOff: number[]; runAddr: number[]; runLen: number[] }[];
	nextTag: number;
}

/** One request the API runs: inline on ShmDevice, in worker mode in the worker. */
export type ShmCall =
	| { op: "open"; name: string; timeout?: number }
	| { op: "create"; name: string; size: number; mode?: number; timeout?: number }
	| { op: "openId"; id: number }
	| { op: "refresh"; id: number; force?: boolean; timeout?: number }
	| { op: "check"; id: number; timeout?: number }
	| { op: "close"; id: number; timeout?: number }
	| { op: "read"; id: number; offset: number; length: number }
	| { op: "write"; id: number; offset: number; data: Uint8Array };

/** What a ShmCall gives: an export's info (open, create, openId, refresh), a flag (check), bytes (read) or nothing. */
export type ShmCallResult = ShmInfo | boolean | Uint8Array | undefined;

/** Runs of consecutive pages: start offset in the export, linear address, length (bytes). */
interface Runs {
	runOff: Float64Array;
	runAddr: Uint32Array;
	runLen: Float64Array;
}

interface Rec extends Runs {
	info: ShmInfo;
}

/**
 * An export's page runs for the owner's thread (worker mode with a shared
 * memory): its slot in ShmShareServer's table and the token the slot holds
 * while these runs are current, and the bytes they cover.
 */
export interface ShmPlace extends Runs {
	slot: number;
	token: number;
	size: number;
	writable: boolean;
}

/** Visit the runs under [offset, offset + length): fn(linear address, position in the range, bytes). */
function eachRun(r: Runs, offset: number, length: number, fn: (addr: number, pos: number, n: number) => void): void {
	const off = r.runOff;
	let lo = 0, hi = off.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (off[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	for (let i = lo, pos = 0; pos < length; i++) {
		const inRun = offset + pos - off[i]!;
		const n = Math.min(r.runLen[i]! - inRun, length - pos);
		fn(r.runAddr[i]! + inRun, pos, n);
		pos += n;
	}
}

function checkRange(id: number, size: number, offset: number, length: number, what: string): void {
	if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size)
		throw new ShmError("EINVAL", `${what}: ${offset}+${length} is outside export ${id} (${size} bytes)`);
}

/** Copy [offset, offset + length) of runs `r` out of `mem` into `out` (or a new array). */
function copyOut(mem: Uint8Array, r: Runs, offset: number, length: number, out: Uint8Array | undefined, what: string): Uint8Array {
	const dst = out ?? new Uint8Array(length);
	if (dst.length < length) throw new ShmError("EINVAL", `${what}: the buffer is smaller than ${length} bytes`);
	eachRun(r, offset, length, (a, pos, n) => dst.set(mem.subarray(a, a + n), pos));
	return dst;
}

/** Merge a page list into runs of consecutive pages. */
function toRuns(pages: Uint32Array): Pick<Rec, "runOff" | "runAddr" | "runLen"> {
	let n = 0;
	for (let i = 0; i < pages.length; i++) if (!i || pages[i] !== pages[i - 1]! + SHM_PAGE_SIZE) n++;
	const runOff = new Float64Array(n), runAddr = new Uint32Array(n), runLen = new Float64Array(n);
	let r = -1;
	for (let i = 0; i < pages.length; i++) {
		if (!i || pages[i] !== pages[i - 1]! + SHM_PAGE_SIZE) {
			r++;
			runOff[r] = i * SHM_PAGE_SIZE;
			runAddr[r] = pages[i]!;
		}
		runLen[r] = runLen[r]! + SHM_PAGE_SIZE;
	}
	return { runOff, runAddr, runLen };
}

export interface ShmDeviceOptions {
	/** Offer the device (the kernel registers kwshm only then). Default false. */
	enabled?: boolean;
	/** False when the kernel has no kwshm (no wasm_driver_shm_init import): requests fail with ENODEV at once. */
	driver?: boolean;
	/** The kernel's memory, read at call time. */
	memory: () => WebAssembly.Memory;
	/** Set IRQ_SHM and wake the kernel. */
	raise: () => void;
}

export interface ShmDeviceStats {
	/** Requests sent to the kernel, and how many it refused. */
	requests: number;
	failed: number;
	/** Page lists announced (exports and refreshes) and exports withdrawn. */
	attaches: number;
	detaches: number;
	/** Exports alive now. */
	exports: number;
	/** Bytes copied out of and into exported pages. */
	bytesRead: number;
	bytesWritten: number;
}

interface Pending {
	resolve: (v: number) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	what: string;
}

/**
 * The kernel's end of kwshm, on the kernel's thread: the imports, the
 * request queue and the page lists of every live export.
 */
export class ShmDevice {
	readonly enabled: boolean;
	readonly driver: boolean;
	/** Did the kernel ask (wasm_driver_shm_init)? */
	probed = false;
	/** An export's page list arrived or changed (inside the import: do not call into the kernel). */
	onAttach: ((info: ShmInfo) => void) | undefined;
	/** An export is gone (inside the import). */
	onDetach: ((id: number) => void) | undefined;
	/**
	 * Export `id`'s current page list stops being current: inside its detach
	 * import, or the attach of a refreshed list, before the kernel may free
	 * the old pages (they are still held while this runs); also for every
	 * export at close(). ShmShareServer hooks it.
	 */
	onRetire: ((id: number) => void) | undefined;
	stats: ShmDeviceStats = { requests: 0, failed: 0, attaches: 0, detaches: 0, exports: 0, bytesRead: 0, bytesWritten: 0 };
	#recs = new Map<number, Rec>();
	#queue: Uint8Array[] = [];
	#pending = new Map<number, Pending>();
	#nextTag = 1;
	#memory: () => WebAssembly.Memory;
	#raise: () => void;
	#closed = false;
	#encoder = new TextEncoder();

	constructor(opts: ShmDeviceOptions) {
		this.enabled = !!opts.enabled;
		this.driver = opts.driver ?? true;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
	}

	imports(): Record<string, unknown> {
		return {
			wasm_driver_shm_init: (reqSize: number): number => {
				this.probed = true;
				if (!this.enabled) return -19; // ENODEV
				if (reqSize >>> 0 !== REQ_SIZE) return -22;
				return 0;
			},
			wasm_driver_shm_request: (buf: bigint, max: number): number => {
				const req = this.#queue.shift();
				if (!req) return 0;
				const n = Math.min(req.length, max >>> 0);
				new Uint8Array(this.#memory().buffer).set(req.subarray(0, n), Number(buf));
				return n;
			},
			wasm_driver_shm_attach: (id: number, flags: number, gen: number, size: bigint, pages: bigint, npages: number): void => {
				const n = npages >>> 0;
				const list = n ? new Uint32Array(this.#memory().buffer, Number(pages), n).slice() : new Uint32Array(0);
				const info: ShmInfo = {
					id: id >>> 0, size: Number(size), pages: n, generation: gen >>> 0,
					writable: !!(flags & FLAG_WRITABLE), guest: !!(flags & FLAG_GUEST),
				};
				if (!this.#recs.has(info.id)) this.stats.exports++;
				else this.#retire(info.id);
				this.#recs.set(info.id, { info, ...toRuns(list) });
				this.stats.attaches++;
				try { this.onAttach?.({ ...info }); } catch {}
			},
			wasm_driver_shm_detach: (id: number): void => {
				if (!this.#recs.has(id >>> 0)) return;
				this.#retire(id >>> 0);
				this.#recs.delete(id >>> 0);
				this.stats.exports--;
				this.stats.detaches++;
				try { this.onDetach?.(id >>> 0); } catch {}
			},
			wasm_driver_shm_reply: (tag: number, result: number): void => {
				const p = this.#pending.get(tag >>> 0);
				if (!p) return;
				this.#pending.delete(tag >>> 0);
				clearTimeout(p.timer);
				if (result < 0) {
					this.stats.failed++;
					p.reject(errnoError(-result, p.what));
				} else p.resolve(result);
			},
		};
	}

	#retire(id: number): void {
		try { this.onRetire?.(id); } catch {}
	}

	/** Is there an export `id`? */
	has(id: number): boolean {
		return this.#recs.has(id);
	}

	/** Export `id`'s page runs and size (ShmShareServer), or undefined if there is no such export. */
	runs(id: number): (Runs & { size: number; writable: boolean }) | undefined {
		const r = this.#recs.get(id);
		return r && { runOff: r.runOff, runAddr: r.runAddr, runLen: r.runLen, size: r.info.size, writable: r.info.writable };
	}

	/** Requests queued or waiting for the kernel's answer (a snapshot refuses then). */
	get busy(): number {
		return this.#queue.length + this.#pending.size;
	}

	/** The state a snapshot keeps (the pages stay held by the kernel). */
	saveState(): ShmSnapshot {
		return {
			exports: [...this.#recs.values()].map((r) => ({
				info: { ...r.info }, runOff: [...r.runOff], runAddr: [...r.runAddr], runLen: [...r.runLen],
			})),
			nextTag: this.#nextTag,
		};
	}

	/**
	 * A restored snapshot: the kernel does not announce its exports again,
	 * so take their page lists from the snapshot. Guest exports can be
	 * opened by id again (openId()); exports the old host opened stay held
	 * in the kernel until closed by id.
	 */
	restoreState(s: ShmSnapshot): void {
		this.probed = true;
		for (const id of this.#recs.keys()) this.#retire(id);
		this.#recs.clear();
		for (const e of s.exports)
			this.#recs.set(e.info.id, {
				info: { ...e.info }, runOff: Float64Array.from(e.runOff), runAddr: Uint32Array.from(e.runAddr), runLen: Float64Array.from(e.runLen),
			});
		this.stats.exports = this.#recs.size;
		this.#nextTag = s.nextTag || 1;
	}

	/** The export's current description, or undefined if there is no such export. */
	info(id: number): ShmInfo | undefined {
		const r = this.#recs.get(id);
		return r && { ...r.info };
	}

	/** Send a request to the kernel; resolves with its answer (>= 0) or rejects with a ShmError. */
	request(op: number, what: string, f: { id?: number; flags?: number; size?: number; name?: string; timeout?: number }): Promise<number> {
		if (this.#closed) return Promise.reject(new ShmError("ECONNABORTED", `${what}: the kernel exited`));
		if (!this.enabled || !this.driver) return Promise.reject(new ShmError("ENODEV", `${what}: the kernel has no kwshm`));
		const req = new Uint8Array(REQ_SIZE);
		const dv = new DataView(req.buffer);
		if (f.name !== undefined) {
			const name = this.#encoder.encode(f.name);
			if (name.length > NAME_MAX) return Promise.reject(new ShmError("ENAMETOOLONG", `${what}: name longer than ${NAME_MAX} bytes`));
			if (name.includes(0)) return Promise.reject(new ShmError("EINVAL", `${what}: name contains NUL`));
			req.set(name, 24);
		}
		const tag = this.#nextTag;
		this.#nextTag = (this.#nextTag % 0xffffffff) + 1;
		dv.setUint32(0, op, true);
		dv.setUint32(4, tag, true);
		dv.setUint32(8, f.id ?? 0, true);
		dv.setUint32(12, f.flags ?? 0, true);
		dv.setBigUint64(16, BigInt(f.size ?? 0), true);
		this.stats.requests++;
		return new Promise<number>((resolve, reject) => {
			const timeout = f.timeout ?? DEFAULT_TIMEOUT_MS;
			const timer = timeout > 0 && Number.isFinite(timeout) ? setTimeout(() => {
				this.#pending.delete(tag);
				const i = this.#queue.indexOf(req);
				if (i >= 0) this.#queue.splice(i, 1);
				reject(new ShmError("ETIMEDOUT", `${what}: no answer from the kernel within ${timeout} ms`));
			}, timeout) : undefined;
			this.#pending.set(tag, { resolve, reject, timer, what });
			this.#queue.push(req);
			this.#raise();
		});
	}

	#rec(id: number, what: string): Rec {
		const r = this.#recs.get(id);
		if (!r) throw new ShmError("ENOENT", `${what}: no export ${id}`);
		return r;
	}

	/** Copy bytes out of export `id` (into `out` at 0 if given). Synchronous: call it on the kernel's thread. */
	read(id: number, offset: number, length: number, out?: Uint8Array): Uint8Array {
		const r = this.#rec(id, "read");
		checkRange(id, r.info.size, offset, length, "read");
		const dst = copyOut(new Uint8Array(this.#memory().buffer), r, offset, length, out, "read");
		this.stats.bytesRead += length;
		return dst;
	}

	/** Copy `data` into export `id` at `offset`. Synchronous: call it on the kernel's thread. */
	write(id: number, offset: number, data: Uint8Array): void {
		const r = this.#rec(id, "write");
		if (!r.info.writable) throw new ShmError("EACCES", `write: export ${id} is read-only for the host`);
		checkRange(id, r.info.size, offset, data.length, "write");
		const mem = new Uint8Array(this.#memory().buffer);
		eachRun(r, offset, data.length, (a, pos, n) => mem.set(data.subarray(pos, pos + n), a));
		this.stats.bytesWritten += data.length;
	}

	/**
	 * Views of the kernel's memory covering [offset, offset + length) of
	 * export `id`, one per run of consecutive pages, in order. No copy. They
	 * are valid only until the kernel runs again (the guest may release or
	 * refresh the export then): use them synchronously and ask again later.
	 */
	views(id: number, offset: number, length: number): Uint8Array[] {
		const r = this.#rec(id, "views");
		checkRange(id, r.info.size, offset, length, "views");
		const buf = this.#memory().buffer;
		const out: Uint8Array[] = [];
		eachRun(r, offset, length, (a, _pos, n) => out.push(new Uint8Array(buf, a, n)));
		return out;
	}

	/** Run one API call (the inline backend, and the worker's side of worker mode). */
	async run(call: ShmCall): Promise<ShmCallResult> {
		switch (call.op) {
		case "open":
		case "create": {
			const create = call.op === "create";
			if (create && (!Number.isSafeInteger(call.size) || call.size < 0))
				throw new ShmError("EINVAL", `create: bad size ${call.size}`);
			const id = await this.request(create ? OP_CREATE : OP_OPEN, `${call.op} ${JSON.stringify(call.name)}`, {
				name: call.name, timeout: call.timeout,
				size: create ? call.size : 0, flags: create ? (call.mode ?? 0o600) & 0o777 : 0,
			});
			return this.#infoOr(id, call.op);
		}
		case "openId":
			return this.#infoOr(call.id, "openId");
		case "refresh":
			this.#rec(call.id, "refresh");
			await this.request(OP_REFRESH, `refresh ${call.id}`, { id: call.id, flags: call.force ? REFRESH_FORCE : 0, timeout: call.timeout });
			return this.#infoOr(call.id, "refresh");
		case "check":
			this.#rec(call.id, "isStale");
			return (await this.request(OP_CHECK, `isStale ${call.id}`, { id: call.id, timeout: call.timeout })) === 1;
		case "close":
			if (!this.#recs.has(call.id)) return undefined; // already gone
			await this.request(OP_CLOSE, `close ${call.id}`, { id: call.id, timeout: call.timeout });
			return undefined;
		case "read":
			return this.read(call.id, call.offset, call.length);
		case "write":
			this.write(call.id, call.offset, call.data);
			return undefined;
		}
	}

	#infoOr(id: number, what: string): ShmInfo {
		const info = this.info(id);
		if (!info) throw new ShmError("ENOENT", `${what}: no export ${id}`);
		return info;
	}

	/** The kernel exited: fail what is pending and forget every export (the memory stays readable, but nothing in it is held any more). */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ShmError("ECONNABORTED", `${p.what}: the kernel exited`));
		}
		this.#pending.clear();
		this.#queue = [];
		// No detach events: the API ends its handles with "exit" itself (ShmClient.shutdown).
		for (const id of this.#recs.keys()) this.#retire(id);
		this.#recs.clear();
		this.stats.exports = 0;
	}
}

// ---------------------------------------------------------------------------
// In place across threads (worker mode with a shared memory; see the top).

/** Slots in the table: exports the owner has opened at once (more: those read by message). */
const SHARE_SLOTS = 4096;
/** How long a retiring export waits for the owner's pin (it pins only for a synchronous run of its own). */
const PIN_WAIT_MS = 1000;

/** The worker's side: the slot table, and the waits in the imports (ShmDevice.onRetire). */
export class ShmShareServer {
	/** TOKEN[SHARE_SLOTS], then PIN[SHARE_SLOTS] (Int32), for the owner. */
	readonly table = new SharedArrayBuffer(SHARE_SLOTS * 8);
	/** Retires that found the owner's pin and waited, and those that gave up waiting. */
	readonly stats = { waits: 0, timeouts: 0 };
	#tok = new Int32Array(this.table, 0, SHARE_SLOTS);
	#pin = new Int32Array(this.table, SHARE_SLOTS * 4, SHARE_SLOTS);
	#slots = new Map<number, number>();
	#free: number[] = [];
	#next = 0;
	#token = 0;
	#dev: ShmDevice;
	#log: (msg: string) => void;

	constructor(dev: ShmDevice, log: (msg: string) => void) {
		this.#dev = dev;
		this.#log = log;
		dev.onRetire = (id) => this.#retire(id);
	}

	/** Export `id`'s runs for the owner, with a slot holding a token while they are current; undefined: no such export, or no slot free. */
	place(id: number): ShmPlace | undefined {
		const r = this.#dev.runs(id);
		if (!r) return undefined;
		let slot = this.#slots.get(id);
		if (slot === undefined) {
			slot = this.#free.pop() ?? (this.#next < SHARE_SLOTS ? this.#next++ : undefined);
			if (slot === undefined) return undefined;
			this.#token = (this.#token % 0x7fffffff) + 1;
			Atomics.store(this.#tok, slot, this.#token);
			this.#slots.set(id, slot);
		}
		return { slot, token: Atomics.load(this.#tok, slot), size: r.size, writable: r.writable, runOff: r.runOff, runAddr: r.runAddr, runLen: r.runLen };
	}

	/** Inside the import, before the kernel may free the pages: end the token, then wait out the owner's pin. */
	#retire(id: number): void {
		const slot = this.#slots.get(id);
		if (slot === undefined) return;
		this.#slots.delete(id);
		Atomics.store(this.#tok, slot, 0);
		if (Atomics.load(this.#pin, slot)) {
			this.stats.waits++;
			const end = performance.now() + PIN_WAIT_MS;
			for (let left = PIN_WAIT_MS; Atomics.load(this.#pin, slot) && left > 0; left = end - performance.now())
				Atomics.wait(this.#pin, slot, 1, left);
			if (Atomics.load(this.#pin, slot)) {
				this.stats.timeouts++;
				this.#log(`[host] shm: export ${id} retired while the owner still had it pinned after ${PIN_WAIT_MS} ms`);
			}
		}
		this.#free.push(slot);
	}
}

/**
 * The owner's side: the kernel's memory and the slot table from the worker,
 * and the places of the exports it opened. read() and views() pin the slot
 * and check its token (see the top); EAGAIN when the export has no current
 * place here (never opened by id, refreshed or withdrawn since): the message
 * path then answers.
 */
export class ShmInPlace {
	#mem: Uint8Array;
	#tok: Int32Array;
	#pin: Int32Array;
	#places = new Map<number, ShmPlace>();
	/** Slots views() pinned in this task, unpinned by a microtask. */
	#held = new Set<number>();
	#closed = false;

	constructor(memory: SharedArrayBuffer, table: SharedArrayBuffer) {
		this.#mem = new Uint8Array(memory);
		this.#tok = new Int32Array(table, 0, SHARE_SLOTS);
		this.#pin = new Int32Array(table, SHARE_SLOTS * 4, SHARE_SLOTS);
	}

	/** An info reply's place for export `id`. */
	set(id: number, place: ShmPlace): void {
		if (!this.#closed) this.#places.set(id, place);
	}

	/** The export is gone. */
	drop(id: number): void {
		this.#places.delete(id);
	}

	/** Whether export `id` has a current place here (a later call may still find it gone). */
	ready(id: number): boolean {
		const p = this.#places.get(id);
		return !!p && Atomics.load(this.#tok, p.slot) === p.token;
	}

	read(id: number, offset: number, length: number, out?: Uint8Array): Uint8Array {
		const p = this.#place(id, offset, length, "read");
		const held = this.#held.has(p.slot);
		if (!held) Atomics.store(this.#pin, p.slot, 1);
		try {
			this.#current(id, p, "read");
			return copyOut(this.#mem, p, offset, length, out, "read");
		} finally {
			if (!held) this.#unpin(p.slot);
		}
	}

	write(id: number, offset: number, data: Uint8Array): void {
		const p = this.#place(id, offset, data.length, "write");
		if (!p.writable) throw new ShmError("EACCES", `write: export ${id} is read-only for the host`);
		const held = this.#held.has(p.slot);
		if (!held) Atomics.store(this.#pin, p.slot, 1);
		try {
			this.#current(id, p, "write");
			eachRun(p, offset, data.length, (a, pos, n) => this.#mem.set(data.subarray(pos, pos + n), a));
		} finally {
			if (!held) this.#unpin(p.slot);
		}
	}

	views(id: number, offset: number, length: number): Uint8Array[] {
		const p = this.#place(id, offset, length, "views");
		if (!this.#held.has(p.slot)) {
			Atomics.store(this.#pin, p.slot, 1);
			if (!this.#held.size) queueMicrotask(() => this.#release());
			this.#held.add(p.slot);
		}
		this.#current(id, p, "views");
		const out: Uint8Array[] = [];
		eachRun(p, offset, length, (a, _pos, n) => out.push(this.#mem.subarray(a, a + n)));
		return out;
	}

	/** The kernel exited: forget every place (the memory stays readable, but nothing in it is held). */
	close(): void {
		this.#closed = true;
		this.#places.clear();
		this.#release();
	}

	#place(id: number, offset: number, length: number, what: string): ShmPlace {
		const p = this.#places.get(id);
		if (!p) throw new ShmError("EAGAIN", `${what}: export ${id} has no page list on this thread`);
		checkRange(id, p.size, offset, length, what);
		return p;
	}

	/** After the pin: is the token still the one of these runs? */
	#current(id: number, p: ShmPlace, what: string): void {
		if (Atomics.load(this.#tok, p.slot) === p.token) return;
		if (this.#places.get(id) === p) this.#places.delete(id);
		throw new ShmError("EAGAIN", `${what}: export ${id}'s page list changed or went away`);
	}

	#unpin(slot: number): void {
		Atomics.store(this.#pin, slot, 0);
		Atomics.notify(this.#pin, slot);
	}

	#release(): void {
		for (const s of this.#held) this.#unpin(s);
		this.#held.clear();
	}
}

// ---------------------------------------------------------------------------
// The API.

/** Why a ShmFile handle ended: close() on it, the export went away (the guest released it, or another handle closed it), or the kernel exited. */
export type ShmCloseReason = "closed" | "released" | "exit";

export interface ShmStats {
	/** Handles open now. */
	open: number;
	/** read() and write() calls, and their bytes. */
	reads: number;
	bytesRead: number;
	/** Reads (read(), readSync()) that copied on this thread: inline, or in place in worker mode. */
	inPlaceReads: number;
	writes: number;
	bytesWritten: number;
}

/** One export, seen from the host. Calls on a closed handle reject with ShmError EBADF. */
export interface ShmFile {
	/** The export's id: the kernel's (for a guest export, the one KWSHM_IOC_EXPORT returned). */
	readonly id: number;
	/** The name in /dev/shm, for files the host opened or created. */
	readonly name: string | undefined;
	/** "host" (open(), create()) or "guest" (openId()). */
	readonly origin: "host" | "guest";
	/** Bytes exported, as of the latest page list (refresh() updates it). */
	readonly size: number;
	readonly pages: number;
	readonly writable: boolean;
	/** Counts the page lists; refresh() bumps it when the kernel took the file's pages again. */
	readonly generation: number;
	/**
	 * Copy `length` bytes from `offset` (default: everything from offset).
	 * In place (see inPlace) the copy happens at once. Otherwise the worker
	 * copies and transfers the bytes here: with the shared transport at the
	 * kernel's next clock read (about every 0.6 ms while the guest runs, at
	 * once when it idles), else when the kernel next yields or idles (up to
	 * 20 ms while the guest is busy).
	 */
	read(offset?: number, length?: number): Promise<Uint8Array>;
	/**
	 * Whether readSync() and views() work now: inline always; in worker mode
	 * where the kernel's memory is shared with this thread (an SMP kernel,
	 * the shared transport) while this thread has the export's current page
	 * list (after a refresh, until its answer: no). False once the handle
	 * ended. A true answer can still be followed by an EAGAIN from those two
	 * if the guest withdraws the export meanwhile.
	 */
	readonly inPlace: boolean;
	/**
	 * read(), synchronously, into `out` (at 0) if given: the copy happens on
	 * this thread. Throws a ShmError: EOPNOTSUPP where this thread cannot see
	 * the kernel's memory, EAGAIN when inPlace is false for now (read()
	 * answers then), EBADF on an ended handle, EINVAL outside the export.
	 */
	readSync(offset?: number, length?: number, out?: Uint8Array): Uint8Array;
	/**
	 * Views of the kernel's memory for [offset, offset + length), one per run
	 * of consecutive pages (a shmem file's pages are scattered), no copy; the
	 * same errors as readSync(). Use them synchronously: they are valid until
	 * the calling code awaits or returns to the event loop (inline the kernel
	 * cannot run before; in worker mode the export's pages stay held until
	 * then: a guest release meanwhile waits for it). The guest may write the
	 * pages meanwhile in worker mode (its other CPUs run), so a view can see a
	 * frame being drawn, as inline between two yields. Over a shared memory
	 * the views are shared: APIs that refuse those (TextDecoder, WebGL
	 * uploads in some engines) need a copy.
	 */
	views(offset?: number, length?: number): Uint8Array[];
	/** Copy `data` into the file at `offset` (it must fit within size; the export must be writable). */
	write(offset: number, data: Uint8Array): Promise<void>;
	/**
	 * Take the file's current pages if the view is stale (another size, or a
	 * held page no longer in the file); `force` takes them anyway. Resolves
	 * true when a new page list came (size and generation updated).
	 */
	refresh(opts?: { force?: boolean; timeout?: number }): Promise<boolean>;
	/** Ask the kernel whether the view is stale: the file changed size, or a held page left the file (truncated or punched). */
	isStale(opts?: { timeout?: number }): Promise<boolean>;
	/**
	 * End this handle. For a file the host opened or created this releases
	 * the export (other handles to it end with "released"); a guest export
	 * stays until the guest releases it.
	 */
	close(): Promise<void>;
	/** Settles once the handle has ended. */
	readonly closed: Promise<ShmCloseReason>;
}

/** @deprecated Every ShmFile has views() now (ShmFile.inPlace says where it works). */
export type InlineShmFile = ShmFile;

/** The surface both inline and worker mode give as `vm.shm`. */
export interface Shm<F extends ShmFile = ShmFile> {
	/**
	 * Open /dev/shm/`name` in the guest (one path component; resolved in
	 * the init mount namespace). The kernel refuses names with "/" or "..",
	 * directories (EISDIR), anything that is not a regular file (EINVAL) and
	 * files that are not shmem (EOPNOTSUPP), e.g. a bind mount. Holes are
	 * allocated. Rejects with a ShmError (ENOENT, ...; ENODEV without kwshm,
	 * ETIMEDOUT after `timeout` ms, default 10000).
	 */
	open(name: string, opts?: { timeout?: number }): Promise<F>;
	/**
	 * Create /dev/shm/`name` with `size` bytes (zeros, all allocated) and
	 * open it, for data from the host to the guest. Fails with EEXIST if it
	 * exists. `mode` defaults to 0o600 (root's).
	 */
	create(name: string, size: number, opts?: { mode?: number; timeout?: number }): Promise<F>;
	/** A guest export, by the id KWSHM_IOC_EXPORT gave the guest. Rejects with ENOENT if there is none. */
	openId(id: number): Promise<F>;
	/**
	 * Whether this thread can read exports in place (ShmFile.inPlace,
	 * readSync(), views()): inline, and in worker mode once the worker
	 * shared the kernel's memory (an SMP kernel with the shared transport).
	 */
	readonly inPlace: boolean;
	readonly stats: ShmStats;
}

/** Synchronous access to the kernel's memory from this thread: ShmDevice inline, ShmInPlace in worker mode. */
export interface ShmLocal {
	/** Whether export `id` can be read in place now. */
	ready(id: number): boolean;
	read(id: number, offset: number, length: number, out?: Uint8Array): Uint8Array;
	write(id: number, offset: number, data: Uint8Array): void;
	views(id: number, offset: number, length: number): Uint8Array[];
}

/** How a ShmClient runs calls: on ShmDevice (inline) or across to the worker. */
export interface ShmBackend {
	run(call: ShmCall): Promise<ShmCallResult>;
	/** In-place access where there is some (read at call time: in worker mode it comes after the start). */
	readonly local?: ShmLocal;
}

class Handle implements ShmFile {
	readonly id: number;
	readonly name: string | undefined;
	readonly origin: "host" | "guest";
	readonly closed: Promise<ShmCloseReason>;
	info: ShmInfo;
	done: ShmCloseReason | undefined;
	/** close() asked the kernel to release it: its detach ends this handle as "closed". */
	closing = false;
	#client: ShmClient<ShmFile>;
	#resolve!: (r: ShmCloseReason) => void;

	constructor(client: ShmClient<ShmFile>, info: ShmInfo, name: string | undefined) {
		this.#client = client;
		this.id = info.id;
		this.info = info;
		this.name = name;
		this.origin = info.guest ? "guest" : "host";
		this.closed = new Promise((r) => (this.#resolve = r));
	}

	get size(): number { return this.info.size; }
	get pages(): number { return this.info.pages; }
	get writable(): boolean { return this.info.writable; }
	get generation(): number { return this.info.generation; }

	end(reason: ShmCloseReason): void {
		if (this.done) return;
		this.done = reason;
		this.#client.forget(this);
		this.#resolve(reason);
	}

	#live(what: string): void {
		if (this.done) throw new ShmError("EBADF", `${what}: the handle is closed (${this.done})`);
	}

	async read(offset = 0, length?: number): Promise<Uint8Array> {
		this.#live("read");
		const n = length ?? Math.max(0, this.info.size - offset);
		const local = this.#client.backend.local;
		if (local?.ready(this.id)) {
			try {
				const data = local.read(this.id, offset, n);
				this.#client.count(true, data.length, true);
				return data;
			} catch (e) {
				if ((e as ShmError).code !== "EAGAIN") throw e;
			}
		}
		const data = await this.#client.backend.run({ op: "read", id: this.id, offset, length: n }) as Uint8Array;
		this.#client.count(true, data.length);
		return data;
	}

	get inPlace(): boolean {
		return !this.done && !!this.#client.backend.local?.ready(this.id);
	}

	#local(what: string): ShmLocal {
		this.#live(what);
		const local = this.#client.backend.local;
		if (!local) throw new ShmError("EOPNOTSUPP", `${what}: this thread cannot see the kernel's memory (worker mode without a shared memory: use read())`);
		return local;
	}

	readSync(offset = 0, length?: number, out?: Uint8Array): Uint8Array {
		const local = this.#local("readSync");
		const n = length ?? Math.max(0, this.info.size - offset);
		const data = local.read(this.id, offset, n, out);
		this.#client.count(true, n, true);
		return data;
	}

	async write(offset: number, data: Uint8Array): Promise<void> {
		this.#live("write");
		const local = this.#client.backend.local;
		if (local?.ready(this.id)) {
			try {
				local.write(this.id, offset, data);
				this.#client.count(false, data.length);
				return;
			} catch (e) {
				if ((e as ShmError).code !== "EAGAIN") throw e;
			}
		}
		await this.#client.backend.run({ op: "write", id: this.id, offset, data });
		this.#client.count(false, data.length);
	}

	async refresh(opts: { force?: boolean; timeout?: number } = {}): Promise<boolean> {
		this.#live("refresh");
		const gen = this.info.generation;
		const info = await this.#client.backend.run({ op: "refresh", id: this.id, force: opts.force, timeout: opts.timeout }) as ShmInfo;
		this.#client.update(info);
		return info.generation !== gen;
	}

	async isStale(opts: { timeout?: number } = {}): Promise<boolean> {
		this.#live("isStale");
		return await this.#client.backend.run({ op: "check", id: this.id, timeout: opts.timeout }) as boolean;
	}

	async close(): Promise<void> {
		if (this.done) return;
		if (this.origin === "host") {
			this.closing = true;
			try {
				await this.#client.backend.run({ op: "close", id: this.id });
			} finally {
				this.closing = false;
			}
		}
		this.end("closed");
	}

	views(offset = 0, length?: number): Uint8Array[] {
		return this.#local("views").views(this.id, offset, length ?? Math.max(0, this.info.size - offset));
	}
}

/**
 * `vm.shm`: handles to exports, on a backend (ShmDevice inline, messages
 * in worker mode). Feed it the kernel's announcements with attached(),
 * detached() and shutdown().
 */
export class ShmClient<F extends ShmFile = ShmFile> implements Shm<F> {
	readonly backend: ShmBackend;
	#handles = new Map<number, Set<Handle>>();
	#exited = false;
	#stats: ShmStats = { open: 0, reads: 0, bytesRead: 0, inPlaceReads: 0, writes: 0, bytesWritten: 0 };

	constructor(backend: ShmBackend) {
		this.backend = backend;
	}

	get stats(): ShmStats {
		return { ...this.#stats };
	}

	get inPlace(): boolean {
		return !this.#exited && !!this.backend.local;
	}

	async open(name: string, opts: { timeout?: number } = {}): Promise<F> {
		return this.#add(await this.backend.run({ op: "open", name, timeout: opts.timeout }) as ShmInfo, name);
	}

	async create(name: string, size: number, opts: { mode?: number; timeout?: number } = {}): Promise<F> {
		return this.#add(await this.backend.run({ op: "create", name, size, mode: opts.mode, timeout: opts.timeout }) as ShmInfo, name);
	}

	async openId(id: number): Promise<F> {
		return this.#add(await this.backend.run({ op: "openId", id }) as ShmInfo, undefined);
	}

	#add(info: ShmInfo, name: string | undefined): F {
		if (this.#exited) throw new ShmError("ECONNABORTED", "the kernel exited");
		const h = new Handle(this as unknown as ShmClient<ShmFile>, info, name);
		let set = this.#handles.get(info.id);
		if (!set) this.#handles.set(info.id, (set = new Set()));
		set.add(h);
		this.#stats.open++;
		return h as unknown as F;
	}

	/** @internal */
	forget(h: Handle): void {
		const set = this.#handles.get(h.id);
		if (set?.delete(h)) this.#stats.open--;
		if (set && !set.size) this.#handles.delete(h.id);
	}

	/** @internal */
	count(read: boolean, bytes: number, inPlace = false): void {
		if (read) {
			this.#stats.reads++;
			this.#stats.bytesRead += bytes;
			if (inPlace) this.#stats.inPlaceReads++;
		} else {
			this.#stats.writes++;
			this.#stats.bytesWritten += bytes;
		}
	}

	/** An export's page list changed (or arrived): handles to it take the new size and generation. */
	update(info: ShmInfo): void {
		for (const h of this.#handles.get(info.id) ?? []) if (info.generation >= h.info.generation) h.info = { ...info };
	}

	/** The export is gone: its handles end with "released". */
	detached(id: number): void {
		for (const h of [...(this.#handles.get(id) ?? [])]) h.end(h.closing ? "closed" : "released");
	}

	/** The kernel exited: every handle ends with "exit". */
	shutdown(): void {
		this.#exited = true;
		for (const set of [...this.#handles.values()]) for (const h of [...set]) h.end("exit");
	}
}

/** The inline `vm.shm`: ShmClient straight on the kernel's ShmDevice. */
export function inlineShm(dev: ShmDevice): ShmClient {
	const client = new ShmClient({
		run: (call) => dev.run(call),
		local: {
			ready: (id) => dev.has(id),
			read: (id, offset, length, out) => dev.read(id, offset, length, out),
			write: (id, offset, data) => dev.write(id, offset, data),
			views: (id, offset, length) => dev.views(id, offset, length),
		},
	});
	dev.onAttach = (info) => client.update(info);
	dev.onDetach = (id) => client.detached(id);
	return client;
}
