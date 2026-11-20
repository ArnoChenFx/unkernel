// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Console output of an SMP kernel (more than one CPU): every CPU's fd_write
// puts its bytes into one shared ring, as a record, in the order the calls
// reserve their space. That reservation happens inside the import, while
// the kernel still holds the lock that orders the writes (hp->lock for tty
// output, the console lock for printk), so the ring's order is the kernel's.
// One reader at a time takes everything committed, in one chunk. Universal.
//
// Who reads (ConsoleRingReader, see the bottom):
// - Worker mode with the shared transport: the owner (the thread that
//   called createKernel: the page, or Node's main thread). It runs
//   independently of every CPU, so the console needs neither CPU 0's host
//   to suspend nor a message per write, and a writer may simply wait for
//   space when the ring is full ("wait"): the reader never waits for the
//   kernel, so that wait cannot be part of a deadlock.
// - Inline and the messages transport: CPU 0's host (Kernel). It reads in
//   its clock import (Kernel.poller), before it suspends and while it waits
//   idle. CPU 0 may be the one a writer waits for (spinning for hp->lock or
//   the console, which that writer holds), so a full ring must never make
//   another CPU wait for it ("post"): that CPU takes the records out itself
//   and posts them to CPU 0's host as one batch. Every take gets a batch
//   number (ConsoleOrder in cpu.ts puts the batches in order). At most
//   MAX_BATCHES batches may be on their way; beyond that the writer waits
//   for CPU 0's host to take one (STALL_MS at most), and if it took none,
//   drops the write (counted in DROPPED) and every later one until it takes
//   one again, without waiting: CPU 0 is stuck in the kernel (perhaps
//   waiting for that writer) while another CPU wrote 4 MiB.
//
// Layout: CTL_BYTES of Int32 control words, then the data (a power of two).
//   HEAD     reservation cursor (bytes, wraps as an int32): writers CAS it
//   TAIL     read cursor: the reader stores it after zeroing what it took
//   WAITING  0 the reader is not waiting; 1 it waits and wants every commit
//            (idle: latency); 2 it waits for a fuller ring (it took output
//            just now, so more is likely: batching). The writer that sees it
//            and swaps it to 0 notifies. Both sides store, then load the
//            other side's word (sequentially consistent), so no commit is
//            missed.
//   SPACE    writers waiting for space ("wait"): the reader notifies TAIL
//   CLOSED   1: the session ended (CPU 0's host closes it at exit, also
//            when another thread reads it), writes are dropped; what was
//            committed before can still be taken
//   LOCK     held by the one taking records out (any thread, "post")
//   BATCH    the next batch number
//   BATCHES  batches posted by other CPUs and not yet taken by CPU 0's host
//   TAKEN    batches CPU 0's host has taken (counts up)
//   DROPPED  bytes dropped (no room and too many batches on their way)
// A record is a 4-byte length (written last with Atomics.store: the commit;
// 0 = not committed) and the bytes, padded to 4. The reader zeroes what it
// took, so a length word is 0 until its writer commits.

const HEAD = 0, TAIL = 1, WAITING = 2, SPACE = 3, CLOSED = 4, LOCK = 5, BATCH = 6, BATCHES = 7, DROPPED = 8, TAKEN = 9;
const CTL_BYTES = 64;
/** Ring data, bytes: 256 KiB. */
const RING_BYTES = 1 << 18;
/** Batches another CPU may post ("post") before its writes are dropped. */
const MAX_BATCHES = 16;
/** How long a "post" writer waits for CPU 0's host to take a batch before it drops. */
const STALL_MS = 50;
/** How long a reader that just took output lets more gather (WAITING 2). */
const LAZY_MS = 2;

/**
 * What a full ring makes a writer do: wait for the reader, take the records
 * out and post them to the reader, or (the reader's own thread) take them out
 * and hand them on.
 */
export type ConsoleFull = "wait" | "post" | "take";

/** A new ring, for ConsoleRing. */
export function newConsoleRing(): SharedArrayBuffer {
	return new SharedArrayBuffer(CTL_BYTES + RING_BYTES);
}

/** One batch of console output taken out of the ring. */
export interface ConsoleBatch {
	/** Batch number (BATCH, wraps as an int32): ConsoleOrder's order. */
	seq: number;
	bytes: Uint8Array;
}

/** Any thread's view of the ring: write records, take them out. */
export class ConsoleRing {
	readonly buffer: SharedArrayBuffer;
	readonly ctl: Int32Array;
	#words: Int32Array;
	#data: Uint8Array;
	#cap: number;
	/** The largest record (a quarter of the ring); a longer write is split. */
	#maxRecord: number;
	/** WAITING 2 wakes the reader once this much waits (an eighth of the ring). */
	#lazyBytes: number;
	/** "post": TAKEN when this thread last waited for CPU 0's host in vain (it drops without waiting until TAKEN moves). */
	#stalledAt = -1;

	constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer;
		this.#cap = buffer.byteLength - CTL_BYTES;
		if (this.#cap <= 0 || this.#cap & (this.#cap - 1)) throw new Error(`console ring: bad size ${buffer.byteLength}`);
		this.ctl = new Int32Array(buffer, 0, CTL_BYTES / 4);
		this.#words = new Int32Array(buffer, CTL_BYTES, this.#cap / 4);
		this.#data = new Uint8Array(buffer, CTL_BYTES, this.#cap);
		this.#maxRecord = this.#cap >> 2;
		this.#lazyBytes = this.#cap >> 3;
	}

	get closed(): boolean {
		return Atomics.load(this.ctl, CLOSED) !== 0;
	}

	/** Bytes dropped so far (DROPPED). */
	get dropped(): number {
		return Atomics.load(this.ctl, DROPPED);
	}

	/** Bytes in the ring (committed or not). Racy, for heuristics. */
	get used(): number {
		return (this.ctl[HEAD]! - this.ctl[TAIL]!) | 0;
	}

	/** Nothing reserved and no batch on its way to the reader. */
	get quiet(): boolean {
		const c = this.ctl;
		return Atomics.load(c, HEAD) === Atomics.load(c, TAIL) && Atomics.load(c, BATCHES) === 0;
	}

	/** Anything reserved since the reader last took (a plain read: at worst stale, as the poll it serves). */
	get pending(): boolean {
		return this.ctl[HEAD] !== this.ctl[TAIL];
	}

	/**
	 * Put src[p, p + len) in as one record (at most a quarter of the ring). False if it
	 * does not fit (nothing written).
	 */
	tryWrite(src: Uint8Array, p: number, len: number): boolean {
		const c = this.ctl, cap = this.#cap;
		const need = 4 + ((len + 3) & ~3);
		let head = Atomics.load(c, HEAD);
		let used: number;
		for (;;) {
			used = ((head - Atomics.load(c, TAIL)) | 0) + need;
			if (used > cap) return false;
			const was = Atomics.compareExchange(c, HEAD, head, (head + need) | 0);
			if (was === head) break;
			head = was;
		}
		const mask = cap - 1;
		const at = (head + 4) & mask;
		const first = Math.min(len, cap - at);
		this.#data.set(src.subarray(p, p + first), at);
		if (len > first) this.#data.set(src.subarray(p + first, p + len), 0);
		Atomics.store(this.#words, (head & mask) >> 2, len);
		const w = Atomics.load(c, WAITING);
		if (w !== 0 && (w === 1 || used >= this.#lazyBytes)) this.kick(w);
		return true;
	}

	/** Whether the record at TAIL is committed. */
	committedAtTail(): boolean {
		const c = this.ctl;
		const tail = Atomics.load(c, TAIL);
		return tail !== Atomics.load(c, HEAD) && Atomics.load(this.#words, (tail & (this.#cap - 1)) >> 2) !== 0;
	}

	/** Wake a waiting reader (WAITING `w`, or whatever it is). */
	kick(w = Atomics.load(this.ctl, WAITING)): void {
		if (w !== 0 && Atomics.compareExchange(this.ctl, WAITING, w, 0) === w) Atomics.notify(this.ctl, WAITING);
	}

	/**
	 * Write src[p, p + len), splitting what is longer than a record; a full
	 * ring does as `full` says (top of this file). `sink` gets the batches
	 * taken out ("post", "take"). Returns the bytes dropped.
	 */
	write(src: Uint8Array, p: number, len: number, full: ConsoleFull, sink?: (b: ConsoleBatch) => void): number {
		// The session ended: nothing written from now on comes out (not counted as dropped).
		if (Atomics.load(this.ctl, CLOSED)) return len;
		for (let off = 0; off < len;) {
			const n = Math.min(len - off, this.#maxRecord);
			if (!this.tryWrite(src, p + off, n) && !(full === "wait" ? this.#waitWrite(src, p + off, n) : this.#takeWrite(src, p + off, n, sink!, full === "post"))) {
				Atomics.add(this.ctl, DROPPED, len - off);
				return len - off;
			}
			off += n;
		}
		return 0;
	}

	/** "wait": block until the reader makes room (false: closed). Only a thread that may block calls this. */
	#waitWrite(src: Uint8Array, p: number, len: number): boolean {
		const c = this.ctl;
		Atomics.add(c, SPACE, 1);
		try {
			for (;;) {
				if (Atomics.load(c, CLOSED)) return false;
				const tail = Atomics.load(c, TAIL);
				if (this.tryWrite(src, p, len)) return true;
				this.kick();
				Atomics.wait(c, TAIL, tail, 100);
			}
		} finally {
			Atomics.sub(c, SPACE, 1);
		}
	}

	/**
	 * "post" and "take": take the records out and hand them to `sink` as one
	 * batch, then write (false: dropped). `post`: the sink posts it to the
	 * reader (counted in BATCHES).
	 */
	#takeWrite(src: Uint8Array, p: number, len: number, sink: (b: ConsoleBatch) => void, post: boolean): boolean {
		const c = this.ctl;
		for (let idle = 0; ;) {
			if (Atomics.load(c, CLOSED)) return false;
			if (this.tryWrite(src, p, len)) return true;
			if (post && Atomics.load(c, BATCHES) >= MAX_BATCHES) {
				// CPU 0's host has not taken the earlier ones: wait for it to
				// take one, but not for one that may never come (it may be
				// waiting for this CPU).
				const taken = Atomics.load(c, TAKEN);
				if (taken === this.#stalledAt) return false;
				const deadline = performance.now() + STALL_MS;
				let left = STALL_MS;
				while (Atomics.load(c, TAKEN) === taken && left > 0 && !Atomics.load(c, CLOSED)) {
					Atomics.wait(c, TAKEN, taken, left);
					left = deadline - performance.now();
				}
				if (Atomics.load(c, TAKEN) === taken) {
					this.#stalledAt = taken;
					return false;
				}
				continue;
			}
			const b = this.take(true);
			if (b) {
				if (post) Atomics.add(c, BATCHES, 1);
				sink(b);
				idle = 0;
				continue;
			}
			// Nothing committed at the tail: its writer is still copying (or
			// another thread holds the lock). Give it 0.1 ms, 20 ms in all.
			if (++idle > 200) return false;
			Atomics.wait(c, CLOSED, 0, 0.1);
		}
	}

	/** CPU 0's host took a posted batch. */
	batchTaken(): void {
		Atomics.sub(this.ctl, BATCHES, 1);
		Atomics.add(this.ctl, TAKEN, 1);
		Atomics.notify(this.ctl, TAKEN);
	}

	/**
	 * Take every committed record, in order, as one chunk with a batch
	 * number; null if there is none or another thread is taking (`spin`:
	 * wait for it instead, briefly).
	 */
	take(spin = false): ConsoleBatch | null {
		const c = this.ctl;
		for (let i = 0; Atomics.compareExchange(c, LOCK, 0, 1) !== 0; i++) {
			if (!spin || i > 100) return null;
			Atomics.wait(c, LOCK, 1, 1);
		}
		try {
			const cap = this.#cap, mask = cap - 1, words = this.#words, data = this.#data;
			const tail0 = Atomics.load(c, TAIL), head = Atomics.load(c, HEAD);
			let tail = tail0, total = 0;
			while (tail !== head) {
				const len = Atomics.load(words, (tail & mask) >> 2);
				if (!len) break; // reserved, not yet committed
				total += len;
				tail = (tail + 4 + ((len + 3) & ~3)) | 0;
			}
			if (tail === tail0) return null;
			const out = new Uint8Array(total);
			for (let t = tail0, o = 0; t !== tail;) {
				const len = words[(t & mask) >> 2]!;
				const at = (t + 4) & mask;
				const first = Math.min(len, cap - at);
				out.set(data.subarray(at, at + first), o);
				if (len > first) out.set(data.subarray(0, len - first), o + first);
				o += len;
				t = (t + 4 + ((len + 3) & ~3)) | 0;
			}
			const a = tail0 & mask, n = (tail - tail0) | 0;
			if (a + n <= cap) data.fill(0, a, a + n);
			else {
				data.fill(0, a);
				data.fill(0, 0, a + n - cap);
			}
			const seq = Atomics.add(c, BATCH, 1);
			Atomics.store(c, TAIL, tail);
			if (Atomics.load(c, SPACE) > 0) Atomics.notify(c, TAIL);
			return { seq, bytes: out };
		} finally {
			Atomics.store(c, LOCK, 0);
			Atomics.notify(c, LOCK);
		}
	}

	/** The session ended: drop later writes, release waiting writers. */
	close(): void {
		Atomics.store(this.ctl, CLOSED, 1);
		Atomics.notify(this.ctl, TAIL);
		Atomics.notify(this.ctl, TAKEN);
		this.kick();
	}
}

/**
 * The reader's loop (one thread): take what is committed, then wait on
 * WAITING with Atomics.waitAsync, eagerly (any commit wakes it) after an
 * empty take, lazily (a fuller ring, or LAZY_MS) after one that found
 * output. take() may also be called directly (CPU 0's host: its clock, its
 * own writes, idle and exit); the loop is on this thread too, so the two
 * never overlap.
 */
export class ConsoleRingReader {
	readonly ring: ConsoleRing;
	#deliver: (b: ConsoleBatch) => void;
	#stopped = false;
	#armed = false;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(ring: ConsoleRing, deliver: (b: ConsoleBatch) => void) {
		this.ring = ring;
		this.#deliver = deliver;
	}

	/** Take what is there now; true if there was something. */
	take(): boolean {
		const b = this.ring.take();
		if (!b) return false;
		this.#deliver(b);
		return true;
	}

	/** Start the loop. */
	start(): void {
		this.#loop();
	}

	/** Stop the loop (after a last take()). */
	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.ring.kick();
	}

	#loop(): void {
		if (this.#stopped || this.#armed) return;
		const got = this.take();
		const mode = got ? 2 : 1;
		const c = this.ring.ctl;
		// Say we wait, then look again: a commit after the store sees WAITING, one before it is seen here.
		Atomics.store(c, WAITING, mode);
		if (mode === 1 && this.ring.committedAtTail()) {
			Atomics.store(c, WAITING, 0);
			queueMicrotask(() => this.#loop());
			return;
		}
		const again = () => {
			this.#armed = false;
			Atomics.compareExchange(c, WAITING, mode, 0);
			this.#loop();
		};
		this.#armed = true;
		const wait = (Atomics as { waitAsync?: typeof Atomics.waitAsync }).waitAsync;
		if (typeof wait === "function") {
			const r = wait(c, WAITING, mode, mode === 2 ? LAZY_MS : 60000);
			if (r.async) void r.value.then(again);
			else queueMicrotask(again);
		} else {
			// No Atomics.waitAsync on this thread: poll.
			this.#timer = setTimeout(again, mode === 2 ? LAZY_MS : 4);
		}
	}
}
