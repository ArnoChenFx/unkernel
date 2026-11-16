// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A secondary CPU of an SMP kernel (CONFIG_SMP; kernel.md, SMP): another
// instance of the same module on the same shared memory, in its own thread
// (a worker the platform starts: Platform.spawnCpu, js/node/cpu.ts). CPU 0
// (Kernel, kernel.ts) keeps every device; this side serves only what any
// CPU needs: task switching (its own JSPI stacks: a task's stack lives in
// the thread that started it; a task the kernel moves starts on a fresh
// stack on its new CPU, and wasm_stack_drop then tells the old one's host),
// the clocks, randomness, and console and panic output, which it forwards
// to CPU 0's host. Its idle blocks the thread in the kernel itself
// (memory.atomic.wait32 on its word of pending interrupts), so nothing here
// waits. Any other import is a kernel bug on this CPU: it ends the session.
// Universal: no node: imports, no DOM.

import { ERRNO, never } from "./wasi.ts";

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
}

/** Messages from a CPU to CPU 0's host. */
export type CpuMessage =
	| { t: "running" }
	| { t: "out"; bytes: Uint8Array }
	| { t: "err"; bytes: Uint8Array }
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
		// The console (1) and panic text (2), forwarded to CPU 0's host.
		fd_write(fd: number, iovs: number, n: number, nwritten: number): number {
			if (fd !== 1 && fd !== 2) return ERRNO.BADF;
			const v = dv(), m = u8();
			let total = 0;
			for (let i = 0; i < n; i++) {
				const p = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
				if (!len) continue;
				port.post({ t: fd === 1 ? "out" : "err", bytes: m.slice(p, p + len) });
				total += len;
			}
			v.setUint32(nwritten, total, true);
			return ERRNO.SUCCESS;
		},
		// Only CPU 0 yields (traps.c); a stray call returns at once.
		sched_yield: (): number => ERRNO.SUCCESS,
		proc_exit: new WebAssembly.Suspending((code: number) => {
			if (!exited) {
				exited = true;
				port.post({ t: "exit", code });
				stopCpu0();
			}
			return never();
		}),
	};
	const unkernel: Record<string, unknown> = {
		wasm_init_flag: (): bigint => BigInt(init.initFlag),
		wasm_cpu_count: (): number => init.cpus,
		wasm_cpu_start: (): number => -38, // ENOSYS: only CPU 0 starts CPUs
		kw_host_jit_caps: (): number => 0, // the interpreter only (SMP)
		kw_host_jit_compile: (): number => -1,
		kw_host_jit_free: (): void => {},
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
	retFromFork = WebAssembly.promising(ex.ret_from_fork as (...args: unknown[]) => unknown) as typeof retFromFork;
	const entry = WebAssembly.promising(ex.kw_secondary_entry as (idle: bigint) => unknown);
	port.post({ t: "running" });
	entry(init.idle).then(() => trap(new Error("kw_secondary_entry returned")), trap);
}
