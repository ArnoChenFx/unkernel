// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest PC sampling (CreateKernelOptions.profile): a histogram of where guest
// user time goes, by command, process and user pc, in two domains.
//
// The kernel (arch/wasm/kernel/prof.c, asm/kwprof.h) writes samples into a
// ring per CPU in its memory (the exported struct kw_prof); this host drains
// them on the kernel's thread (a timer, which runs at the kernel's 20 ms
// yields and while it idles, and at exit) and aggregates them.
//
// - Time samples: a sampler thread (Platform.spawnSampler; Node:
//   node/sampler.ts) sets WASM_IRQ_PROFILE in every CPU's word of pending
//   interrupts `hz` times a second, without a notify (an idle CPU is not
//   woken). kwemu sees the bit at its next block end, so a sample lands on
//   the pc where user code stopped, with the block that ran before it
//   (`prevBlockPc`: the stop pc is the next block's start, so the block
//   before is the code that used the time) and the tier that saw the bit.
//   The sampler needs the kernel's memory to be shared (the SMP kernel);
//   with an unshared memory there are instruction samples only. A tick
//   whose bit the CPU had not taken yet since the last one is "missed":
//   the CPU was idle or in one long stay in the kernel.
// - Instruction samples: the kernel takes one every `insns` user
//   instructions of each CPU, exactly (it lowers kwemu's budget to the end
//   of the period), at the next pc to retire.
//
// Comparing a range's share of time with its share of instructions shows
// where code is slow per instruction (the report's `pages`, and the table
// formatProfile() prints).

/** CreateKernelOptions.profile. */
export interface ProfileOptions {
	/** Time samples per second and CPU (needs a shared memory: the SMP kernel). Default 1000; 0: none. */
	hz?: number;
	/** An instruction sample every this many user instructions of a CPU. Default 1000000; 0: none. */
	insns?: number;
}

/** One (command, process, pc) of the report. */
export interface ProfileRow {
	comm: string;
	/** The process (thread group) id. */
	pid: number;
	/** The user pc, hex: where a time sample stopped, or the next instruction of an instruction sample. */
	pc: string;
	/** Time samples in user code that stopped at `pc`. */
	timeSamples: number;
	/** Time samples in the kernel while the task's user pc was `pc` (a system call or fault from there). */
	kernelSamples: number;
	/** Instruction samples at `pc`. */
	insnSamples: number;
	/** The block that ran before most of the time samples here (hex), and their share. */
	prevBlockPc?: string;
	prevBlockShare?: number;
	/** The tier that saw most of the time samples here (ProfileTier), and the count per tier. */
	tier?: ProfileTier;
	tiers?: Partial<Record<ProfileTier, number>>;
}

/**
 * How kwemu saw a time sample's bit: pending when kw_run began (after a
 * stop for an instruction sample), after a single step or in the reference
 * loop, after decoded ops, after compiled code, or at the end of a slice.
 */
export type ProfileTier = "none" | "entry" | "reference" | "decoded" | "compiled" | "budget";
const TIERS: ProfileTier[] = ["none", "entry", "reference", "decoded", "compiled", "budget"];

/** Time and instruction samples of a 4 KiB page of user code, time at the block that ran (prevBlockPc). */
export interface ProfilePage {
	comm: string;
	pid: number;
	/** The page's first address, hex. */
	page: string;
	timeSamples: number;
	insnSamples: number;
}

export interface ProfileCpu {
	cpu: number;
	/** Sampler ticks for this CPU, and those that found its last bit not taken (idle, or in the kernel all along). */
	ticks: number;
	missed: number;
	user: number;
	kernel: number;
	idle: number;
	insns: number;
	/** Samples the kernel dropped (its ring was full). */
	dropped: number;
}

export interface ProfileReport {
	version: 1;
	/** Time samples asked per second and CPU (0: none), and whether a sampler ran (a shared memory and a platform that starts one). */
	hz: number;
	timeSampling: boolean;
	/** The instruction period (0: none). */
	insnPeriod: number;
	/** Milliseconds from the start of sampling to this report. */
	durationMs: number;
	cpus: number;
	totals: { user: number; kernel: number; idle: number; insns: number; dropped: number; ticks: number; missed: number };
	perCpu: ProfileCpu[];
	/** Per command: time samples in user code, in the kernel and idle, and instruction samples. */
	comms: { comm: string; user: number; kernel: number; idle: number; insns: number }[];
	/** Most time first. */
	pages: ProfilePage[];
	/** Most time first, then most instructions. */
	rows: ProfileRow[];
}

/** What a sampler thread gets (Platform.spawnSampler). */
export interface SamplerInit {
	/** The kernel's shared memory. */
	buffer: SharedArrayBuffer;
	/** Address of CPU 0's word (wasm_host_irqs), and of kw_prof.irq_word[] (the others' words, 0 until the kernel fills them). */
	irq0: number;
	words: number;
	cpus: number;
	bit: number;
	periodMs: number;
	/** Int32: [0] stop (set and notified to end it), [1 + cpu] ticks, [1 + cpus + cpu] missed. */
	ctl: SharedArrayBuffer;
}

export interface SamplerHandle {
	stop(): void;
}

/** What Profiler needs of the Kernel (kernel.ts). */
export interface ProfiledKernel {
	memory: WebAssembly.Memory;
	sharedMemory: boolean;
	exports: WebAssembly.Exports | undefined;
	irqAddr: number | undefined;
	cpus: number;
	log: (msg: string) => void;
}

// struct kw_prof (asm/kwprof.h).
const KW_PROF_VERSION = 1;
const P_FLAGS = 4, P_PERIOD = 8, P_NR = 16, P_RING = 20, P_REC = 24, P_STRIDE = 28, P_RINGS = 32, P_BIT = 36, P_WORDS = 40;
const R_HEAD = 0, R_DROPPED = 4, R_TAIL = 32, R_SAMPLES = 64;
const S_PC = 0, S_BLOCK = 8, S_PID = 24, S_TGID = 28, S_CPU = 32, S_KIND = 34, S_TIER = 35, S_COMM = 40;
const FLAG_TIME = 1, FLAG_INSNS = 2;
const KIND_USER = 1, KIND_KERNEL = 2, KIND_IDLE = 3, KIND_INSN = 4;
const DRAIN_MS = 20;

interface Row {
	comm: string;
	pid: number;
	pc: bigint;
	time: number;
	kernel: number;
	insns: number;
	tiers: number[];
	blocks: Map<bigint, number>;
}

const hex = (v: bigint): string => `0x${v.toString(16)}`;
const decoder = new TextDecoder();

/** The kernel's struct kw_prof, if it has one. */
function profAddr(k: ProfiledKernel): number | undefined {
	const g = k.exports?.kw_prof;
	if (!(g instanceof WebAssembly.Global)) return undefined;
	const addr = Number(g.value);
	return new DataView(k.memory.buffer).getUint32(addr, true) === KW_PROF_VERSION ? addr : undefined;
}

/** Turn the kernel's sampling off (a restored snapshot that was taken while profiling, booted without it). */
export function profileOff(k: ProfiledKernel): void {
	const addr = profAddr(k);
	if (addr !== undefined) new DataView(k.memory.buffer).setUint32(addr + P_FLAGS, 0, true);
}

export class Profiler {
	hz: number;
	insns: number;
	k: ProfiledKernel | undefined;
	addr = 0;
	nr = 0;
	ringSize = 0;
	rec = 0;
	stride = 0;
	rings = 0;
	/** Each ring's dropped count when this host attached (a restored kernel's are older). */
	dropBase: number[] = [];
	sampler: SamplerHandle | null = null;
	ctl: Int32Array | null = null;
	timer: ReturnType<typeof setInterval> | undefined;
	t0 = 0;
	tEnd = 0;
	rowMap = new Map<string, Row>();
	pageMap = new Map<string, ProfilePage>();
	commMap = new Map<string, { comm: string; user: number; kernel: number; idle: number; insns: number }>();
	perCpu: ProfileCpu[] = [];

	constructor(opts: ProfileOptions) {
		this.hz = Math.max(0, Math.min(10000, Number(opts.hz ?? 1000) || 0));
		this.insns = Math.max(0, Math.floor(Number(opts.insns ?? 1_000_000) || 0));
		if (this.insns && this.insns < 1000) this.insns = 1000;
	}

	/**
	 * After instantiation (and after a snapshot's memory is in): find
	 * kw_prof, start from what the rings hold now, and set what to sample.
	 * False if the kernel has no profiler.
	 */
	attach(k: ProfiledKernel, spawnSampler?: (init: SamplerInit) => SamplerHandle): boolean {
		const addr = profAddr(k);
		if (addr === undefined) {
			k.log("[host] profile: this kernel has no profiler (kw_prof); nothing is sampled");
			return false;
		}
		this.k = k;
		this.addr = addr;
		const dv = new DataView(k.memory.buffer);
		this.nr = dv.getUint32(addr + P_NR, true);
		this.ringSize = dv.getUint32(addr + P_RING, true);
		this.rec = dv.getUint32(addr + P_REC, true);
		this.stride = dv.getUint32(addr + P_STRIDE, true);
		this.rings = addr + dv.getUint32(addr + P_RINGS, true);
		const cpus = Math.min(k.cpus, this.nr);
		for (let c = 0; c < this.nr; c++) {
			const r = this.rings + c * this.stride;
			dv.setUint32(r + R_TAIL, dv.getUint32(r + R_HEAD, true), true);
			this.dropBase[c] = dv.getUint32(r + R_DROPPED, true);
		}
		this.perCpu = Array.from({ length: cpus }, (_, cpu) => ({ cpu, ticks: 0, missed: 0, user: 0, kernel: 0, idle: 0, insns: 0, dropped: 0 }));
		let flags = this.insns ? FLAG_INSNS : 0;
		if (this.hz && !k.sharedMemory) {
			k.log("[host] profile: time samples need the kernel's memory shared (the SMP kernel: --cpus 2 or more); instruction samples only");
			this.hz = 0;
		} else if (this.hz && !spawnSampler) {
			k.log("[host] profile: this platform starts no sampler thread; instruction samples only");
			this.hz = 0;
		}
		if (this.hz) {
			const ctl = new SharedArrayBuffer(4 * (1 + 2 * cpus));
			this.ctl = new Int32Array(ctl);
			try {
				this.sampler = spawnSampler!({
					buffer: k.memory.buffer as unknown as SharedArrayBuffer, irq0: k.irqAddr ?? 0, words: addr + P_WORDS,
					cpus, bit: dv.getUint32(addr + P_BIT, true), periodMs: 1000 / this.hz, ctl,
				});
				flags |= FLAG_TIME;
			} catch (e) {
				k.log(`[host] profile: cannot start the sampler (${(e as Error)?.message ?? e}); instruction samples only`);
				this.hz = 0;
				this.ctl = null;
			}
		}
		dv.setBigUint64(addr + P_PERIOD, BigInt(this.insns), true);
		dv.setUint32(addr + P_FLAGS, flags, true);
		this.t0 = performance.now();
		this.timer = setInterval(() => this.drain(), DRAIN_MS);
		(this.timer as { unref?: () => void }).unref?.();
		return true;
	}

	/** The kernel has ended: take the rest and stop the sampler. */
	stop(): void {
		if (!this.k || this.tEnd) return;
		this.drain();
		this.tEnd = performance.now();
		clearInterval(this.timer);
		this.timer = undefined;
		this.sampler?.stop();
		this.sampler = null;
	}

	/** Take every sample the rings hold. */
	drain(): void {
		const k = this.k;
		if (!k || this.tEnd) return;
		const buf = k.memory.buffer;
		const dv = new DataView(buf);
		const i32 = k.sharedMemory ? new Int32Array(buf) : null;
		const u8 = new Uint8Array(buf);
		for (let c = 0; c < this.perCpu.length; c++) {
			const r = this.rings + c * this.stride;
			const head = (i32 ? Atomics.load(i32, (r + R_HEAD) >> 2) : dv.getUint32(r + R_HEAD, true)) >>> 0;
			let tail = dv.getUint32(r + R_TAIL, true);
			if (head === tail) continue;
			for (; tail !== head; tail = (tail + 1) >>> 0) {
				const s = r + R_SAMPLES + (tail % this.ringSize) * this.rec;
				this.add(dv, u8, s);
			}
			if (i32) Atomics.store(i32, (r + R_TAIL) >> 2, tail | 0);
			else dv.setUint32(r + R_TAIL, tail, true);
		}
	}

	add(dv: DataView, u8: Uint8Array, s: number): void {
		const kind = dv.getUint8(s + S_KIND);
		const cpu = this.perCpu[dv.getUint16(s + S_CPU, true)];
		let end = s + S_COMM;
		while (end < s + S_COMM + 16 && u8[end] !== 0) end++;
		const comm = decoder.decode(u8.slice(s + S_COMM, end));
		const pid = dv.getUint32(s + S_TGID, true) || dv.getUint32(s + S_PID, true);
		const pc = dv.getBigUint64(s + S_PC, true);
		let c = this.commMap.get(comm);
		if (!c) this.commMap.set(comm, c = { comm, user: 0, kernel: 0, idle: 0, insns: 0 });
		if (kind === KIND_IDLE) {
			c.idle++;
			if (cpu) cpu.idle++;
			return;
		}
		const key = `${comm}\0${pid}\0${pc}`;
		let row = this.rowMap.get(key);
		if (!row) this.rowMap.set(key, row = { comm, pid, pc, time: 0, kernel: 0, insns: 0, tiers: [0, 0, 0, 0, 0, 0], blocks: new Map() });
		let at = pc;
		if (kind === KIND_USER) {
			row.time++;
			c.user++;
			if (cpu) cpu.user++;
			const tier = dv.getUint8(s + S_TIER);
			row.tiers[tier < TIERS.length ? tier : 0]!++;
			const block = dv.getBigUint64(s + S_BLOCK, true);
			if (block) {
				row.blocks.set(block, (row.blocks.get(block) ?? 0) + 1);
				at = block;
			}
		} else if (kind === KIND_KERNEL) {
			row.kernel++;
			c.kernel++;
			if (cpu) cpu.kernel++;
			return;
		} else if (kind === KIND_INSN) {
			row.insns++;
			c.insns++;
			if (cpu) cpu.insns++;
		} else return;
		const page = at & ~0xfffn;
		const pkey = `${comm}\0${pid}\0${page}`;
		let p = this.pageMap.get(pkey);
		if (!p) this.pageMap.set(pkey, p = { comm, pid, page: hex(page), timeSamples: 0, insnSamples: 0 });
		if (kind === KIND_USER) p.timeSamples++;
		else p.insnSamples++;
	}

	/** The histogram so far (drains first while the kernel runs). */
	report(): ProfileReport {
		this.drain();
		const k = this.k;
		if (k && this.ctl) {
			const n = this.perCpu.length;
			for (const c of this.perCpu) {
				c.ticks = Atomics.load(this.ctl, 1 + c.cpu);
				c.missed = Atomics.load(this.ctl, 1 + n + c.cpu);
			}
		}
		if (k) {
			const dv = new DataView(k.memory.buffer);
			for (const c of this.perCpu) c.dropped = (dv.getUint32(this.rings + c.cpu * this.stride + R_DROPPED, true) - (this.dropBase[c.cpu] ?? 0)) >>> 0;
		}
		const sum = (f: keyof ProfileCpu) => this.perCpu.reduce((a, c) => a + c[f], 0);
		const rows: ProfileRow[] = [...this.rowMap.values()].map((r) => {
			const out: ProfileRow = { comm: r.comm, pid: r.pid, pc: hex(r.pc), timeSamples: r.time, kernelSamples: r.kernel, insnSamples: r.insns };
			if (r.time) {
				let best = 0;
				for (let i = 1; i < TIERS.length; i++) if (r.tiers[i]! > r.tiers[best]!) best = i;
				out.tier = TIERS[best];
				out.tiers = Object.fromEntries(TIERS.map((t, i) => [t, r.tiers[i]!]).filter(([, n]) => n)) as ProfileRow["tiers"];
				let bb = 0n, bn = 0;
				for (const [b, n] of r.blocks) if (n > bn) { bb = b; bn = n; }
				if (bn) {
					out.prevBlockPc = hex(bb);
					out.prevBlockShare = Math.round((bn / r.time) * 1000) / 1000;
				}
			}
			return out;
		}).sort((a, b) => b.timeSamples - a.timeSamples || b.insnSamples - a.insnSamples || b.kernelSamples - a.kernelSamples);
		return {
			version: 1,
			hz: this.hz,
			timeSampling: !!this.ctl,
			insnPeriod: this.insns,
			durationMs: Math.round((this.tEnd || performance.now()) - this.t0),
			cpus: this.perCpu.length,
			totals: { user: sum("user"), kernel: sum("kernel"), idle: sum("idle"), insns: sum("insns"), dropped: sum("dropped"), ticks: sum("ticks"), missed: sum("missed") },
			perCpu: this.perCpu.map((c) => ({ ...c })),
			comms: [...this.commMap.values()].map((c) => ({ ...c })).sort((a, b) => b.user + b.kernel - (a.user + a.kernel) || b.insns - a.insns),
			pages: [...this.pageMap.values()].map((p) => ({ ...p })).sort((a, b) => b.timeSamples - a.timeSamples || b.insnSamples - a.insnSamples),
			rows,
		};
	}
}

const pct = (n: number, d: number): string => (d ? `${((n * 100) / d).toFixed(1)}%` : "-");
const ratio = (t: number, tt: number, i: number, it: number): string => {
	if (!tt || !it) return "-";
	if (!i) return t ? "inf" : "-";
	return ((t / tt) / (i / it)).toFixed(2);
};

/**
 * A short text summary of a report: the split, the commands, and the top
 * `top` pages by time share with their instruction share and the ratio of
 * the two (>1: slower per instruction than the average), then the top
 * stop pcs with the block before and the tier.
 */
export function formatProfile(r: ProfileReport, top = 15): string {
	const t = r.totals;
	const time = t.user + t.kernel;
	const lines: string[] = [];
	lines.push(`[profile] ${(r.durationMs / 1000).toFixed(1)} s, ${r.cpus} CPU${r.cpus > 1 ? "s" : ""}; ` +
		(r.timeSampling ? `time ${r.hz} Hz: ${t.user} user, ${t.kernel} kernel, ${t.idle} idle samples, ${t.missed} of ${t.ticks} ticks missed (idle or in the kernel)` : "no time samples") +
		`; instructions every ${r.insnPeriod || "-"}: ${t.insns} samples; ${t.dropped} dropped`);
	lines.push("[profile] command            user%  kernel%  insn%");
	for (const c of r.comms.slice(0, 6))
		lines.push(`[profile] ${c.comm.padEnd(16)} ${pct(c.user, time).padStart(7)} ${pct(c.kernel, time).padStart(8)} ${pct(c.insns, t.insns).padStart(6)}`);
	lines.push("[profile] time%   insn%  ratio  command          pid     page");
	const pages = r.timeSampling ? r.pages : [...r.pages].sort((a, b) => b.insnSamples - a.insnSamples);
	for (const p of pages.slice(0, top))
		lines.push(`[profile] ${pct(p.timeSamples, t.user).padStart(6)} ${pct(p.insnSamples, t.insns).padStart(6)} ${ratio(p.timeSamples, t.user, p.insnSamples, t.insns).padStart(6)}  ${p.comm.padEnd(16)} ${String(p.pid).padStart(6)}  ${p.page}`);
	if (r.timeSampling) {
		lines.push("[profile] time%   command          pid     stop pc             block before (share)       tier");
		for (const row of r.rows.slice(0, Math.min(top, 10))) {
			if (!row.timeSamples) break;
			const before = row.prevBlockPc ? `${row.prevBlockPc} (${((row.prevBlockShare ?? 0) * 100).toFixed(0)}%)` : "-";
			lines.push(`[profile] ${pct(row.timeSamples, t.user).padStart(6)}  ${row.comm.padEnd(16)} ${String(row.pid).padStart(6)}  ${row.pc.padEnd(18)}  ${before.padEnd(25)}  ${row.tier ?? "-"}`);
		}
	}
	return lines.join("\n");
}
