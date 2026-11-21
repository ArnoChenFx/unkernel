// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The host side of kwvirtio (drivers/virtio/kwvirtio.c): a virtio transport
// whose "registers" are host imports, and split virtqueues that the host
// reads and writes in kernel memory.
//
// The kernel runs in the direct map (virtual = physical = linear address)
// and the transport offers no VIRTIO_F_ACCESS_PLATFORM, so every address in
// a ring or a command is an offset into the kernel's memory. The device
// model (VirtioDeviceModel; virtio-gpu.ts) pops descriptor chains, reads the
// driver's buffers and writes its answers in place, and pushes each chain to
// the used ring, during the notify import or any time later from this
// thread (the response path is asynchronous: complete() may run from a
// promise). Every push sets the device's interrupt status and raises
// WASM_IRQ_VIRTIO (10), unless the driver asked for no interrupts
// (VIRTQ_AVAIL_F_NO_INTERRUPT); the kernel's handler reads and clears the
// status (wasm_driver_virtio_interrupt) and runs vring_interrupt() on the
// device's queues. A configuration change (configChanged()) sets bit 1.
//
// Devices are numbered 0, 1, ... in the order given; wasm_driver_virtio_init
// answers each one's virtio device ID and 0 past the last, so a kernel
// whose host has no devices registers nothing. No import suspends. On an SMP
// kernel the imports run on CPU 0 only (the kernel sends another CPU's
// notifications through CPU 0), and the memory is shared: the ring indices
// are read and written with Atomics.
//
// Features: VIRTIO_F_VERSION_1 always, plus the model's; no indirect
// descriptors, no event index, no packed rings, no ACCESS_PLATFORM.

const VIRTIO_F_VERSION_1 = 1n << 32n;

/** Status bits (virtio spec 2.1). */
export const VIRTIO_STATUS_ACKNOWLEDGE = 1;
export const VIRTIO_STATUS_DRIVER = 2;
export const VIRTIO_STATUS_DRIVER_OK = 4;
export const VIRTIO_STATUS_FEATURES_OK = 8;
export const VIRTIO_STATUS_FAILED = 0x80;

const VIRTQ_DESC_F_NEXT = 1;
const VIRTQ_DESC_F_WRITE = 2;
const VIRTQ_DESC_F_INDIRECT = 4;
const VIRTQ_AVAIL_F_NO_INTERRUPT = 1;

/** Interrupt status bits (as virtio-mmio's). */
const INT_VRING = 1;
const INT_CONFIG = 2;

/** One buffer of a descriptor chain: kernel memory at `addr`, `len` bytes. */
export interface VirtqBuffer {
	addr: number;
	len: number;
}

/** A descriptor chain the driver made available: what the device reads, then what it writes. */
export interface VirtqChain {
	/** The head descriptor's index, which identifies the chain in the used ring. */
	head: number;
	readable: VirtqBuffer[];
	writable: VirtqBuffer[];
	/** Bytes the device may write. */
	writableLen: number;
}

/** What a snapshot keeps of a queue: where its rings are and how far the device got. */
export interface VirtqSnapshot {
	num: number;
	desc: number;
	avail: number;
	used: number;
	lastAvail: number;
}

/** A device's transport state at a snapshot point. */
export interface VirtioTransportSnapshot {
	status: number;
	features: string;
	isr: number;
	queues: Array<VirtqSnapshot | null>;
}

/**
 * A split virtqueue in kernel memory. The device pops chains and pushes
 * them back to the used ring; the transport raises the interrupt.
 */
export class Virtqueue {
	readonly index: number;
	readonly num: number;
	readonly desc: number;
	readonly avail: number;
	readonly used: number;
	/** The next available-ring slot the device has not taken. */
	lastAvail = 0;
	/**
	 * False once the driver reset the device or took the queue down: its
	 * rings may be freed memory now, so pop() and push() do nothing (a
	 * late asynchronous completion is dropped).
	 */
	alive = true;
	#mem: () => WebAssembly.Memory;
	#onPush: (q: Virtqueue) => void;

	constructor(index: number, num: number, desc: number, avail: number, used: number,
		mem: () => WebAssembly.Memory, onPush: (q: Virtqueue) => void) {
		this.index = index;
		this.num = num;
		this.desc = desc;
		this.avail = avail;
		this.used = used;
		this.#mem = mem;
		this.#onPush = onPush;
	}

	#dv(): DataView {
		return new DataView(this.#mem().buffer);
	}

	#shared(): boolean {
		return typeof SharedArrayBuffer !== "undefined" && this.#mem().buffer instanceof SharedArrayBuffer;
	}

	/** avail->idx (the driver's), read with acquire semantics on a shared memory. */
	#availIdx(): number {
		const a = this.avail + 2;
		if (this.#shared()) return Atomics.load(new Uint16Array(this.#mem().buffer, a & ~1, 1), 0);
		return this.#dv().getUint16(a, true);
	}

	/** Chains made available and not popped yet. */
	pending(): number {
		return (this.#availIdx() - this.lastAvail) & 0xffff;
	}

	/** The driver asked for no used-buffer interrupts (virtqueue_disable_cb). */
	noInterrupt(): boolean {
		return (this.#dv().getUint16(this.avail, true) & VIRTQ_AVAIL_F_NO_INTERRUPT) !== 0;
	}

	/** Take the next available chain, or null. Throws on a malformed chain (the device is then broken). */
	pop(): VirtqChain | null {
		if (!this.alive || !this.pending()) return null;
		const dv = this.#dv();
		const size = dv.byteLength;
		const head = dv.getUint16(this.avail + 4 + 2 * (this.lastAvail % this.num), true);
		this.lastAvail = (this.lastAvail + 1) & 0xffff;
		if (head >= this.num) throw new Error(`queue ${this.index}: head ${head} out of range`);
		const chain: VirtqChain = { head, readable: [], writable: [], writableLen: 0 };
		let i = head;
		for (let n = 0; ; n++) {
			if (n >= this.num) throw new Error(`queue ${this.index}: descriptor loop at ${head}`);
			const d = this.desc + 16 * i;
			const addr = Number(dv.getBigUint64(d, true));
			const len = dv.getUint32(d + 8, true);
			const flags = dv.getUint16(d + 12, true);
			const next = dv.getUint16(d + 14, true);
			if (flags & VIRTQ_DESC_F_INDIRECT) throw new Error(`queue ${this.index}: indirect descriptor (not negotiated)`);
			if (addr + len > size) throw new Error(`queue ${this.index}: buffer 0x${addr.toString(16)}+${len} outside memory`);
			if (flags & VIRTQ_DESC_F_WRITE) {
				chain.writable.push({ addr, len });
				chain.writableLen += len;
			} else {
				if (chain.writable.length) throw new Error(`queue ${this.index}: readable descriptor after a writable one`);
				chain.readable.push({ addr, len });
			}
			if (!(flags & VIRTQ_DESC_F_NEXT)) break;
			if (next >= this.num) throw new Error(`queue ${this.index}: next ${next} out of range`);
			i = next;
		}
		return chain;
	}

	/** Copy of the chain's readable bytes (at most `max`). */
	read(chain: VirtqChain, max = Infinity): Uint8Array {
		const total = Math.min(max, chain.readable.reduce((n, b) => n + b.len, 0));
		const out = new Uint8Array(total);
		const mem = new Uint8Array(this.#mem().buffer);
		let off = 0;
		for (const b of chain.readable) {
			if (off >= total) break;
			const n = Math.min(b.len, total - off);
			out.set(mem.subarray(b.addr, b.addr + n), off);
			off += n;
		}
		return out;
	}

	/** Write `data` into the chain's writable buffers; returns the bytes written. */
	write(chain: VirtqChain, data: Uint8Array): number {
		const mem = new Uint8Array(this.#mem().buffer);
		let off = 0;
		for (const b of chain.writable) {
			if (off >= data.length) break;
			const n = Math.min(b.len, data.length - off);
			mem.set(data.subarray(off, off + n), b.addr);
			off += n;
		}
		return off;
	}

	/** Return the chain to the driver with `len` bytes written, and tell the transport. */
	push(chain: VirtqChain, len: number): void {
		if (!this.alive) return;
		const dv = this.#dv();
		const idx = dv.getUint16(this.used + 2, true);
		const e = this.used + 4 + 8 * (idx % this.num);
		dv.setUint32(e, chain.head, true);
		dv.setUint32(e + 4, len, true);
		const next = (idx + 1) & 0xffff;
		// The element before the index: on a shared memory the store is a release.
		if (this.#shared()) Atomics.store(new Uint16Array(this.#mem().buffer, (this.used + 2) & ~1, 1), 0, next);
		else dv.setUint16(this.used + 2, next, true);
		this.#onPush(this);
	}

	saveState(): VirtqSnapshot {
		return { num: this.num, desc: this.desc, avail: this.avail, used: this.used, lastAvail: this.lastAvail };
	}
}

/**
 * A device model behind the transport. The transport owns the status, the
 * features and the queues; the model answers the config space and serves
 * its queues.
 */
export interface VirtioDeviceModel {
	/** Virtio device ID (16: GPU). */
	readonly deviceId: number;
	/** Device feature bits (VIRTIO_F_VERSION_1 is added by the transport). */
	features(): bigint;
	/** Largest size of each queue; the queue count is the length. */
	readonly queueSizes: readonly number[];
	/** The config space (read at call time; little endian). */
	config(): Uint8Array;
	/** The driver wrote `data` at `offset` of the config space. */
	configWrite?(offset: number, data: Uint8Array): void;
	/** The driver accepted these features (before FEATURES_OK). */
	setFeatures?(features: bigint): void;
	/** The driver set DRIVER_OK: the queues are live. */
	ready?(queues: ReadonlyArray<Virtqueue | null>): void;
	/** Reset (status 0) or the queues went away: forget everything the driver told. */
	reset(): void;
	/** Queue `q` has new available chains (the notify import; never suspend). */
	notify(q: Virtqueue): void;
	/** Why a snapshot cannot be taken now (resources the host would lose), or "". */
	blocker?(): string;
	/** The part of blocker() that lasts while a guest program runs (not commands in flight), or "". */
	held?(): string;
}

interface DeviceSlot {
	model: VirtioDeviceModel;
	status: number;
	features: bigint;
	isr: number;
	queues: Array<Virtqueue | null>;
}

export interface VirtioHostOptions {
	/** The kernel's memory, read at call time. */
	memory: () => WebAssembly.Memory;
	/** Raise WASM_IRQ_VIRTIO. */
	raise: () => void;
	log?: (msg: string) => void;
}

export interface VirtioStats {
	notifies: number;
	pushes: number;
	interrupts: number;
}

/** The transport: the imports, each device's status, features, queues and interrupt status. */
export class VirtioHost {
	#devices: DeviceSlot[] = [];
	#memory: () => WebAssembly.Memory;
	#raise: () => void;
	#log: (msg: string) => void;
	/** The kernel asked for device 0 (it has kwvirtio). */
	probed = false;
	stats: VirtioStats = { notifies: 0, pushes: 0, interrupts: 0 };

	constructor(opts: VirtioHostOptions) {
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.#log = opts.log ?? (() => {});
	}

	/** Add a device; its number is the order of addition. Only before the kernel probes. */
	add(model: VirtioDeviceModel): number {
		this.#devices.push({ model, status: 0, features: 0n, isr: 0, queues: [] });
		return this.#devices.length - 1;
	}

	get enabled(): boolean {
		return this.#devices.length > 0;
	}

	/** The model's configuration changed: tell the driver (config interrupt). */
	configChanged(model: VirtioDeviceModel): void {
		const d = this.#devices.find((s) => s.model === model);
		if (!d || !(d.status & VIRTIO_STATUS_DRIVER_OK)) return;
		d.isr |= INT_CONFIG;
		this.stats.interrupts++;
		this.#raise();
	}

	#slot(dev: number): DeviceSlot | undefined {
		return this.#devices[dev >>> 0];
	}

	#dropQueues(d: DeviceSlot): void {
		for (const q of d.queues) if (q) q.alive = false;
		d.queues = [];
	}

	#reset(d: DeviceSlot): void {
		d.status = 0;
		d.features = 0n;
		d.isr = 0;
		this.#dropQueues(d);
		try {
			d.model.reset();
		} catch (e) {
			this.#log(`[virtio] reset: ${(e as Error)?.message ?? e}`);
		}
	}

	#pushed(d: DeviceSlot, q: Virtqueue): void {
		this.stats.pushes++;
		if (q.noInterrupt()) return;
		d.isr |= INT_VRING;
		this.stats.interrupts++;
		this.#raise();
	}

	/** A model failed on a queue (a malformed chain): the device needs a reset. */
	#broken(d: DeviceSlot, e: unknown): void {
		this.#log(`[virtio] device ${d.model.deviceId}: ${(e as Error)?.message ?? e}; the device stops`);
		d.status |= 0x40; // DEVICE_NEEDS_RESET
		this.#dropQueues(d);
	}

	imports(): Record<string, unknown> {
		return {
			wasm_driver_virtio_init: (index: number): number => {
				this.probed = true;
				return this.#devices[index >>> 0]?.model.deviceId ?? 0;
			},
			wasm_driver_virtio_features: (dev: number): bigint => {
				const d = this.#slot(dev);
				return d ? (d.model.features() | VIRTIO_F_VERSION_1) & 0xffffffffffffffffn : 0n;
			},
			wasm_driver_virtio_set_features: (dev: number, features: bigint): number => {
				const d = this.#slot(dev);
				if (!d) return -19;
				const offered = d.model.features() | VIRTIO_F_VERSION_1;
				const f = BigInt.asUintN(64, features);
				if (f & ~offered) return -22;
				d.features = f;
				d.model.setFeatures?.(f);
				return 0;
			},
			wasm_driver_virtio_config: (dev: number, offset: number, buf: bigint, len: number, write: number): void => {
				const d = this.#slot(dev);
				const mem = new Uint8Array(this.#memory().buffer);
				const at = Number(buf), n = len >>> 0, off = offset >>> 0;
				if (!d) return;
				if (write) {
					d.model.configWrite?.(off, mem.slice(at, at + n));
					return;
				}
				const cfg = d.model.config();
				const out = new Uint8Array(n);
				out.set(cfg.subarray(Math.min(off, cfg.length), Math.min(off + n, cfg.length)));
				mem.set(out, at);
			},
			wasm_driver_virtio_status: (dev: number, status: number): void => {
				const d = this.#slot(dev);
				if (!d) return;
				status &= 0xff;
				if (!status) {
					this.#reset(d);
					return;
				}
				const was = d.status;
				d.status = status;
				if (status & VIRTIO_STATUS_DRIVER_OK && !(was & VIRTIO_STATUS_DRIVER_OK)) d.model.ready?.(d.queues);
			},
			wasm_driver_virtio_queue_max: (dev: number, index: number): number => this.#slot(dev)?.model.queueSizes[index >>> 0] ?? 0,
			wasm_driver_virtio_queue_set: (dev: number, index: number, num: number, desc: bigint, avail: bigint, used: bigint): number => {
				const d = this.#slot(dev);
				const i = index >>> 0, n = num >>> 0;
				if (!d || i >= d.model.queueSizes.length) return -2;
				const old = d.queues[i];
				if (old) old.alive = false;
				if (!n) {
					d.queues[i] = null;
					return 0;
				}
				if (n > d.model.queueSizes[i]! || n & (n - 1)) return -22;
				const size = this.#memory().buffer.byteLength;
				const a = [Number(desc), Number(avail), Number(used)];
				if (a[0]! + 16 * n > size || a[1]! + 6 + 2 * n > size || a[2]! + 6 + 8 * n > size) return -22;
				d.queues[i] = new Virtqueue(i, n, a[0]!, a[1]!, a[2]!, this.#memory, (q) => this.#pushed(d, q));
				return 0;
			},
			wasm_driver_virtio_notify: (dev: number, index: number): void => {
				const d = this.#slot(dev);
				const q = d?.queues[index >>> 0];
				this.stats.notifies++;
				if (!d || !q) return;
				try {
					d.model.notify(q);
				} catch (e) {
					this.#broken(d, e);
				}
			},
			wasm_driver_virtio_interrupt: (dev: number): number => {
				const d = this.#slot(dev);
				if (!d) return 0;
				const isr = d.isr;
				d.isr = 0;
				return isr;
			},
		};
	}

	/** Why a snapshot cannot be taken now, or "". */
	blocker(): string {
		return this.#devices.map((d) => d.model.blocker?.() ?? "").filter(Boolean).join(", ");
	}

	/** State only the host holds while a guest program runs (VirtioGpu.held()): a snapshot is refused before the guest parks. */
	held(): string {
		return this.#devices.map((d) => d.model.held?.() ?? "").filter(Boolean).join(", ");
	}

	/** Each device's transport state (the models keep nothing a snapshot needs while blocker() is ""). */
	saveState(): VirtioTransportSnapshot[] {
		return this.#devices.map((d) => ({
			status: d.status, features: d.features.toString(), isr: d.isr,
			queues: d.queues.map((q) => q?.saveState() ?? null),
		}));
	}

	/** A restored snapshot: the kernel does not set its queues up again. */
	restoreState(s: VirtioTransportSnapshot[]): void {
		this.probed = true;
		s.forEach((t, i) => {
			const d = this.#devices[i];
			if (!d) return;
			d.status = t.status;
			d.features = BigInt(t.features);
			d.isr = t.isr;
			d.model.setFeatures?.(d.features);
			d.queues = t.queues.map((q, qi) => {
				if (!q) return null;
				const vq = new Virtqueue(qi, q.num, q.desc, q.avail, q.used, this.#memory, (x) => this.#pushed(d, x));
				vq.lastAvail = q.lastAvail;
				return vq;
			});
			if (d.status & VIRTIO_STATUS_DRIVER_OK) d.model.ready?.(d.queues);
		});
	}
}
