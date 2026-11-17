// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A secondary CPU of an SMP kernel (CONFIG_SMP; kernel.md, SMP): another
// instance of the same module on the same shared memory, in its own thread
// (a worker the platform starts: Platform.spawnCpu, js/node/cpu.ts and
// js/web/cpu.ts). CPU 0
// (Kernel, kernel.ts) keeps every device; this side serves only what any
// CPU needs: task switching (its own JSPI stacks: a task's stack lives in
// the thread that started it; a task the kernel moves starts on a fresh
// stack on its new CPU, and wasm_stack_drop then tells the old one's host),
// the clocks, randomness, console and panic output, which it forwards to
// CPU 0's host (console writes numbered, so that CPU 0's host puts them in
// the kernel's order: ConsoleOrder), and kwemu's JIT tier: this CPU's kwemu compiles what it
// finds hot into this instance's own function table (jit.ts), whose
// counters it mirrors for CPU 0's stats(). Its idle blocks the thread in
// the kernel itself (memory.atomic.wait32 on its word of pending
// interrupts), so nothing here waits. Any other import is a kernel bug on
// this CPU: it ends the session.
// Universal: no node: imports, no DOM.

import { JitHost } from "./jit.ts";
import { ERRNO, never, yieldToEventLoop } from "./wasi.ts";

/** What CPU 0's host sends to start a CPU (structured-cloneable). */
export interface CpuInit {
	/** The CPU number (1..). */
	cpu: number;
	/** The idle task (kw_secondary_entry's argument). */
	idle: bigint;
	module: WebAssembly.Module;
	/** The kernel's shared memory. */
	memory: WebAssembly.Memory;
	/** How many CPUs the kernel was offered (wasm_cpu_count). */
	cpus: number;
	/** Address of __wasm_init_memory_flag: it must read 2 (the data is initialised) before the start function runs. */
	initFlag: number;
	/**
	 * Address of CPU 0's word of pending interrupts (wasm_host_irqs). When
	 * this CPU ends the session (exit, trap), it raises the stop IPI there:
	 * CPU 0 may be spinning for this one, and its host takes the exit only
	 * once CPU 0 suspends.
	 */
	irqWord0: number;
	/**
	 * The guest's monotonic clock reads `performance.timeOrigin +
	 * performance.now() - epochMs` (ms) on every thread: CPU 0's clock.
	 */
	epochMs: number;
	/** Offer kwemu's JIT tier on this CPU (KernelConfig.jit). */
	jit: boolean;
	/** The memory is a memory64 one (the JIT's modules import it as such). */
	memory64: boolean;
	/** Where this CPU's JIT host mirrors its counters (JIT_MIRROR_WORDS on a SharedArrayBuffer), for CPU 0's stats(). */
	jitMirror?: Float64Array;
	/** The console write counter every CPU numbers its writes from (ConsoleOrder.counter). */
	conSeq: Int32Array;
}

/** Messages from a CPU to CPU 0's host. */
export type CpuMessage =
	| { t: "running" }
	/** Console output, numbered from CpuInit.conSeq (ConsoleOrder). */
	| { t: "out"; seq: number; bytes: Uint8Array }
	| { t: "err"; bytes: Uint8Array }
	/** A host log line (the JIT's warnings). */
	| { t: "log"; msg: string }
	| { t: "exit"; code: number }
	| { t: "fatal"; msg: string }
	| { t: "trap"; error: string };

/** CPU 0's handle on a started CPU (Platform.spawnCpu). */
export interface CpuEndpoint {
	listen(h: { message: (msg: CpuMessage) => void; error: (e: unknown) => void }): void;
	terminate(): void;
}

/** This CPU's way to CPU 0's host. */
export interface CpuPort {
	post(msg: CpuMessage): void;
}

/**
 * Console output from every CPU, put in the order the kernel wrote it. Each
 * CPU's host writes the console as the kernel calls fd_write, but only CPU
 * 0's host has the output: another CPU posts its bytes there, and CPU 0's
 * host takes those messages only once CPU 0 suspends (idle, or its 20 ms
 * yield), so they used to come after whatever CPU 0 wrote meanwhile. So
 * every write takes a number from one shared counter inside the import,
 * that is, while the kernel still holds the lock that orders the writes
 * (hp->lock for tty output, the console lock for printk), and CPU 0's host
 * writes them by number: its own write goes out at once when nothing
 * earlier is still on the way, otherwise it waits here for the messages
 * before it (which come at CPU 0's next suspension, when worker mode would
 * post CPU 0's output anyway). At exit, what waits goes out in order
 * without the numbers that never came. Panic text (fd 2) is one CPU's
 * (panic_cpu) and is not ordered.
 */
export class ConsoleOrder {
	/** The next number to take (Atomics.add), shared with every CPU (CpuInit.conSeq). */
	readonly counter = new Int32Array(new SharedArrayBuffer(4));
	/** The next number to write (wraps as an int32, as the counter does). */
	private next = 0;
	private held = new Map<number, Uint8Array>();
	private emit: (bytes: Uint8Array) => void;

	constructor(emit: (bytes: Uint8Array) => void) {
		this.emit = emit;
	}

	/** A write of CPU 0's: number it and write it, or hold it behind earlier ones. */
	local(bytes: Uint8Array): void {
		this.put(Atomics.add(this.counter, 0, 1), bytes);
	}

	/** Write number `seq` (from any CPU) once every earlier one is written. */
	put(seq: number, bytes: Uint8Array): void {
		if (seq !== this.next) {
			// One that flush() gave up on: write it now rather than never.
			if (((seq - this.next) | 0) < 0) this.emit(bytes);
			else this.held.set(seq, bytes);
			return;
		}
		this.next = (seq + 1) | 0;
		this.emit(bytes);
		if (!this.held.size) return;
		for (let b = this.held.get(this.next); b; b = this.held.get(this.next)) {
			this.held.delete(this.next);
			this.next = (this.next + 1) | 0;
			this.emit(b);
		}
	}

	/** At exit: write everything held, in order, skipping the numbers still on the way. */
	flush(): void {
		if (!this.held.size) return;
		const base = this.next;
		const seqs = [...this.held.keys()].sort((a, b) => ((a - base) | 0) - ((b - base) | 0));
		for (const s of seqs) {
			const b = this.held.get(s)!;
			this.held.delete(s);
			this.next = (s + 1) | 0;
			this.emit(b);
		}
	}
}

const CLOCK_REALTIME = 0;
const CLOCK_THREAD_CPUTIME = 3;
/** KW_IPI_STOP (kernel asm/irq.h). */
const IPI_STOP = 1 << 26;

/** Run CPU `init.cpu` on this thread until the session ends (the owner terminates the thread). */
export async function runCpu(init: CpuInit, port: CpuPort): Promise<void> {
	const { cpu, memory, module } = init;
	const i32 = new Int32Array(memory.buffer);
	// The session ends here: stop CPU 0 (the stop IPI, which the kernel
	// takes even while spinning with interrupts off), which may wait for
	// this CPU and then never take the message.
	const stopCpu0 = () => {
		if (!init.irqWord0) return;
		Atomics.or(i32, init.irqWord0 >> 2, IPI_STOP);
		Atomics.notify(i32, init.irqWord0 >> 2);
	};
	const fatal = (msg: string) => {
		port.post({ t: "fatal", msg: `CPU ${cpu}: ${msg}` });
		stopCpu0();
	};
	// JSPI is per thread in principle (a browser's worker may lack what its page has).
	if (typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") {
		fatal("this thread has no JSPI (WebAssembly.Suspending / WebAssembly.promising)");
		return;
	}
	// The start function initialises the data only while this reads 0
	// (CPU 0's instance did, and the kernel keeps the word reserved).
	if (!init.initFlag || Atomics.load(i32, init.initFlag >> 2) !== 2) {
		fatal(`the data-segment flag at ${init.initFlag} is not 2: a new instance would initialise the memory again`);
		return;
	}
	// The memory never grows (initial == maximum), so one view of each kind
	// serves every call: a new DataView per clock read cost about 150 ns.
	const u8View = new Uint8Array(memory.buffer);
	const dvView = new DataView(memory.buffer);
	const u8 = () => u8View;
	const dv = () => dvView;
	const resumers = new Map<bigint, (task: bigint) => void>();
	let exited = false;
	let retFromFork!: (prev: bigint, next: bigint) => Promise<unknown>;
	const trap = (e: unknown) => {
		if (exited) return;
		exited = true;
		port.post({ t: "trap", error: `CPU ${cpu}: ${(e as Error)?.stack ?? String(e)}` });
		stopCpu0();
	};

	const wasi: Record<string, unknown> = {
		clock_time_get(id: number, _precision: bigint, time: number): number {
			if (id === CLOCK_REALTIME) {
				dv().setBigUint64(time, BigInt(Date.now()) * 1000000n, true);
				return ERRNO.SUCCESS;
			}
			if (id > CLOCK_THREAD_CPUTIME) return ERRNO.INVAL;
			const ns = Math.round((performance.timeOrigin + performance.now() - init.epochMs) * 1e6);
			const v = dv();
			v.setUint32(time, ns >>> 0, true);
			v.setUint32(time + 4, Math.floor(ns / 4294967296), true);
			return ERRNO.SUCCESS;
		},
		random_get(buf: number, len: number): number {
			const m = u8();
			// Through a copy: getRandomValues refuses a shared memory's view in browsers.
			for (let off = 0; off < len; off += 65536) {
				const n = Math.min(len - off, 65536);
				m.set(crypto.getRandomValues(new Uint8Array(n)), buf + off);
			}
			return ERRNO.SUCCESS;
		},
		// The console (1, numbered: ConsoleOrder) and panic text (2), forwarded to CPU 0's host.
		fd_write(fd: number, iovs: number, n: number, nwritten: number): number {
			if (fd !== 1 && fd !== 2) return ERRNO.BADF;
			const v = dv(), m = u8();
			let total = 0;
			for (let i = 0; i < n; i++) {
				const p = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
				if (!len) continue;
				const bytes = m.slice(p, p + len);
				port.post(fd === 1 ? { t: "out", seq: Atomics.add(init.conSeq, 0, 1), bytes } : { t: "err", bytes });
				total += len;
			}
			v.setUint32(nwritten, total, true);
			return ERRNO.SUCCESS;
		},
		// (JSPI) Every CPU yields to its host now and then (traps.c, every
		// 20 ms of user code): this thread's event loop runs the engine's
		// housekeeping there, which nothing else would let it do (the
		// thread idles in the kernel itself). V8 collects the JIT's freed
		// modules only then: finalizers and the collector's last pass
		// are tasks, and without them the JIT host saw nothing collected,
		// prompted collections with ever larger allocations (one stalled
		// this CPU for 0.58 s) and would have refused to compile.
		sched_yield: new WebAssembly.Suspending(() => {
			if (exited) return never();
			return yieldToEventLoop().then(() => (exited ? never() : ERRNO.SUCCESS));
		}),
		proc_exit: new WebAssembly.Suspending((code: number) => {
			if (!exited) {
				exited = true;
				port.post({ t: "exit", code });
				stopCpu0();
			}
			return never();
		}),
	};
	// This instance's own table (attached below, before the kernel runs
	// here) and its own modules: kwemu's state for this CPU is used only
	// by this instance.
	const jit = new JitHost({
		enabled: init.jit, memory: () => memory, memory64: () => init.memory64, mirror: init.jitMirror,
		log: (msg) => port.post({ t: "log", msg: `CPU ${cpu}: ${msg}` }),
	});
	const unkernel: Record<string, unknown> = {
		wasm_init_flag: (): bigint => BigInt(init.initFlag),
		wasm_cpu_count: (): number => init.cpus,
		wasm_cpu_start: (): number => -38, // ENOSYS: only CPU 0 starts CPUs
		...jit.imports(),
		// A task started on a fresh stack on another CPU: its old one here never runs again.
		wasm_stack_drop(task: bigint): void {
			resumers.delete(task);
		},
		wasm_dump_stacktrace(buf: bigint, max: bigint): void {
			const s = new TextEncoder().encode(new Error().stack ?? "");
			const n = Math.min(s.length, Number(max) - 1);
			u8().set(s.subarray(0, n), Number(buf));
			u8()[Number(buf) + n] = 0;
		},
		// (JSPI) Park prev, run next, as on CPU 0 (kernel.ts), with this thread's stacks.
		wasm_switch_to: new WebAssembly.Suspending((prev: bigint, next: bigint, isNew: unknown, prevDead: unknown) => {
			if (exited) return never();
			const parked = prevDead ? never() : new Promise<bigint>((r) => resumers.set(prev, r));
			if (isNew) {
				resumers.delete(next);
				queueMicrotask(() => {
					retFromFork(prev, next).then(() => trap(new Error("task returned from ret_from_fork")), trap);
				});
			} else {
				const resume = resumers.get(next);
				if (!resume) {
					trap(new Error(`switch to unknown task 0x${next.toString(16)}`));
					return never();
				}
				resumers.delete(next);
				resume(prev);
			}
			return parked;
		}),
	};
	const imports: Record<string, Record<string, unknown>> = { env: { memory }, unkernel, wasi_snapshot_preview1: wasi };
	for (const imp of WebAssembly.Module.imports(module)) {
		const mod = (imports[imp.module] ??= {});
		if (imp.name in mod) continue;
		const name = `${imp.module}.${imp.name}`;
		mod[imp.name] = () => {
			fatal(`the kernel called ${name}, which only CPU 0's host serves`);
			throw new Error(`${name} called on CPU ${cpu}`);
		};
	}

	let instance: WebAssembly.Instance;
	try {
		instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
	} catch (e) {
		fatal(`instantiation failed: ${(e as Error)?.message ?? e}`);
		return;
	}
	const ex = instance.exports;
	if (typeof ex.kw_secondary_entry !== "function") {
		fatal("this kernel has no kw_secondary_entry export");
		return;
	}
	jit.attach(ex);
	retFromFork = WebAssembly.promising(ex.ret_from_fork as (...args: unknown[]) => unknown) as typeof retFromFork;
	const entry = WebAssembly.promising(ex.kw_secondary_entry as (idle: bigint) => unknown);
	port.post({ t: "running" });
	entry(init.idle).then(() => trap(new Error("kw_secondary_entry returned")), trap);
}
