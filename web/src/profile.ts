// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// /profile.html: boot the page's kernel once per configuration (the page's
// thread or a Web Worker, 1..N CPUs), run everyday guest work through
// exec(), and record how long it takes and how long the page's thread went
// without a frame meanwhile. The suggestion picks the fewest CPUs within 5%
// of the fastest, and worker mode unless it is clearly slower than the
// page's thread. Copy JSON gives everything, with the device, for comparing
// devices.
import { DISTROS_OFFERED, DEFAULT_DISTRO, MAX_CPUS, smpBlocker } from "./config.ts";
import { autoMemoryMiB, createKernel, kernelSmpUrl, kernelUrl, loadKernelModule, type KernelHandle } from "./sdk.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// --- the device --------------------------------------------------------------
const hc = navigator.hardwareConcurrency || 1;
const cpuMax = Math.max(1, Math.min(MAX_CPUS, hc));
const coarse = matchMedia("(pointer: coarse)").matches;
const mobile = coarse || /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
const smpWhy = smpBlocker();
const jspi = typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === "function";
const device = {
	ua: navigator.userAgent,
	hardwareConcurrency: hc,
	deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
	mobile,
	crossOriginIsolated,
	jspi,
	smp: smpWhy ?? "yes",
	screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
};
$("device").textContent = Object.entries(device).map(([k, v]) => `${k.padEnd(20)} ${v}`).join("\n");

// --- configurations ----------------------------------------------------------
interface Conf { id: string; label: string; worker: boolean; cpus: number }
const confs: Conf[] = [
	{ id: "main-1", label: "page thread, 1 CPU", worker: false, cpus: 1 },
	{ id: "worker-1", label: "worker, 1 CPU", worker: true, cpus: 1 },
];
// Every count the kernel and this device allow (MAX_CPUS: the SMP kernel's NR_CPUS).
if (!smpWhy) for (let n = 2; n <= cpuMax; n++) confs.push({ id: `worker-${n}`, label: `worker, ${n} CPUs`, worker: true, cpus: n });
const half = Math.max(2, Math.min(4, Math.floor(hc / 2)));
const confOn = (c: Conf) => c.cpus <= 2 || c.cpus === half || c.cpus === 4 || c.cpus === cpuMax;
$("configs").innerHTML = confs.map((c) => `<label><input type="checkbox" data-conf="${c.id}"${confOn(c) ? " checked" : ""}> ${c.label}</label>`).join("") +
	(smpWhy ? `<div class="dim">No SMP: ${smpWhy}</div>` : "") +
	(hc > MAX_CPUS ? `<div class="dim">This device has ${hc} threads; the SMP kernel stops at ${MAX_CPUS} CPUs (CONFIG_NR_CPUS).</div>` : "");

// --- workloads ---------------------------------------------------------------
// Sizes are for about a second each on a desktop at 1x; the size option scales them.
// `par`: parallel work (scored apart from the single-thread rest). `width`: the most CPUs selected.
interface Work { id: string; label: string; on: boolean; par?: boolean; cmd?: (n: (x: number) => number, width: number) => string; run?: (vm: KernelHandle) => Promise<void> }
const loop = (k: number) => `i=0; while [ $i -lt ${k} ]; do i=$((i+1)); done`;
const works: Work[] = [
	{ id: "rtt", label: "exec(true) x10 (command latency)", on: true, run: async (vm) => { for (let i = 0; i < 10; i++) await vm.exec("true"); } },
	{ id: "loop", label: "shell loop (1 core)", on: true, cmd: (n) => loop(n(40000)) },
	{ id: "spawn", label: "fork+exec /bin/true", on: true, cmd: (n) => `for i in $(seq ${n(60)}); do /bin/true; done` },
	{ id: "gzip", label: "seq | gzip", on: true, cmd: (n) => `seq ${n(200000)} | gzip -c | wc -c` },
	{ id: "sort", label: "seq | sort | md5sum", on: true, cmd: (n) => `seq ${n(100000)} | sort -rn | md5sum` },
	{ id: "sha", label: "sha256sum 16 MiB", on: true, cmd: (n) => `dd if=/dev/zero bs=64k count=${n(256)} 2>/dev/null | sha256sum` },
	{ id: "fs", label: "find /usr (image reads)", on: true, cmd: () => "find /usr -xdev 2>/dev/null | wc -l" },
	{ id: "par4", label: "4 shell loops in parallel", on: true, par: true, cmd: (n) => `for j in 1 2 3 4; do (${loop(n(20000))}) & done; wait` },
	{ id: "jobs", label: "8 sort pipelines in parallel", on: true, par: true, cmd: (n) => `for j in 1 2 3 4 5 6 7 8; do (seq ${n(20000)} | sort -rn | md5sum >/dev/null) & done; wait` },
	{ id: "wide", label: "one shell loop per CPU selected (most)", on: true, par: true, cmd: (n, w) => `for j in $(seq ${w}); do (${loop(n(15000))}) & done; wait` },
];
$("workloads").innerHTML = works.map((w) => `<label><input type="checkbox" data-work="${w.id}"${w.on ? " checked" : ""}> ${w.label}</label>`).join("");

$<HTMLSelectElement>("distro").innerHTML = [...DISTROS_OFFERED.map((d) => d.name), "none"]
	.map((n) => `<option${n === DEFAULT_DISTRO ? " selected" : ""}>${n}</option>`).join("");
$<HTMLInputElement>("mem").value = String(autoMemoryMiB({ mobile }).mib);

// --- frame gaps: how long the page's thread went without a frame ---------------
const frames: { t: number; gap: number }[] = [];
let lastFrame = performance.now();
const onFrame = (t: number) => {
	frames.push({ t, gap: t - lastFrame });
	lastFrame = t;
	if (frames.length > 200000) frames.splice(0, 100000);
	requestAnimationFrame(onFrame);
};
requestAnimationFrame(onFrame);
// A hidden tab gets no frames: that is not jank (the first frame back would count the whole time away).
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		log("the tab was hidden: frame gaps meanwhile are not counted, and its timings may be off");
	} else lastFrame = performance.now();
});
interface Jank { maxGap: number; over50: number; frames: number }
function jank(t0: number, t1: number): Jank {
	const fs = frames.filter((f) => f.t > t0 && f.t <= t1);
	// A frame still pending at t1 counts as a gap up to now (not while hidden).
	const pending = document.hidden ? 0 : performance.now() - lastFrame;
	const max = Math.max(0, pending, ...fs.map((f) => f.gap));
	return { maxGap: Math.round(max), over50: fs.filter((f) => f.gap > 50).length, frames: fs.length };
}

// --- running ------------------------------------------------------------------
const logEl = $("log");
function log(m: string) {
	logEl.textContent += `${m}\n`;
	logEl.scrollTop = logEl.scrollHeight;
	console.log(`[profile] ${m}`);
}
const status = (m: string) => { $("status").textContent = m; };
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

interface WorkResult { id: string; runs: number[]; median: number; cold: number; jank: Jank; error?: string }
interface ConfResult { conf: Conf; bootMs?: number; kernelMs?: number; guestCpus?: string; works: WorkResult[]; bootJank?: Jank; error?: string }
interface Report { device: typeof device; date: string; options: Record<string, unknown>; results: ConfResult[]; suggestion?: string; host?: HostResult }

// --- host threads: the browser alone, no kernel ----------------------------------
// "spin": a fixed amount of integer work. "nest": start n "spin" workers from
// inside this one (the kernel's CPUs are nested workers of the kernel worker).
// "pong": take turns on a shared word with Atomics.wait/notify ("wait") or
// by spinning on Atomics.load ("spin"): what a CPU waiting for another costs.
const HOST_SRC = `
const spin = (iters) => { let x = 1; for (let i = 0; i < iters; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; } return x; };
onmessage = async (e) => {
	const d = e.data;
	if (d.kind === "spin") {
		const t0 = performance.now(), x = spin(d.iters);
		postMessage({ ms: performance.now() - t0, x });
	} else if (d.kind === "nest") {
		const ws = Array.from({ length: d.n }, () => new Worker(d.url));
		const t0 = performance.now();
		await Promise.all(ws.map((w) => new Promise((r) => { w.onmessage = r; w.postMessage({ kind: "spin", iters: d.iters }); })));
		ws.forEach((w) => w.terminate());
		postMessage({ ms: performance.now() - t0 });
	} else if (d.kind === "pong") {
		const a = new Int32Array(d.sab), id = d.id;
		postMessage({ ready: true });
		for (let i = 0; i < d.rounds; i++) {
			let v;
			if (d.wait) while ((v = Atomics.load(a, 0)) !== id) Atomics.wait(a, 0, v);
			else while (Atomics.load(a, 0) !== id);
			Atomics.store(a, 0, 1 - id);
			Atomics.notify(a, 0);
		}
		postMessage({ done: true });
	}
};`;
interface HostResult { spin: { n: number; ms: number; speedup: number }[]; nested: { n: number; ms: number; speedup: number }[]; waitPongUs?: number; spinPongUs?: number; error?: string }

async function hostThreads(): Promise<HostResult> {
	const url = URL.createObjectURL(new Blob([HOST_SRC], { type: "text/javascript" }));
	const res: HostResult = { spin: [], nested: [] };
	const iters = 60_000_000;
	const one = (msg: object) => new Promise<MessageEvent>((r, j) => {
		const w = new Worker(url);
		w.onerror = (e) => j(new Error(e.message || "worker error"));
		w.onmessage = (e) => { w.terminate(); r(e); };
		w.postMessage(msg);
	});
	const counts = [...new Set([1, 2, 4, Math.min(hc, 8), hc].filter((n) => n <= Math.max(hc, 1)))].sort((a, b) => a - b);
	try {
		await one({ kind: "spin", iters: iters / 10 }); // warm up the engine
		for (const n of counts) {
			status(`host threads: ${n} workers`);
			const t0 = performance.now();
			await Promise.all(Array.from({ length: n }, () => one({ kind: "spin", iters })));
			const ms = performance.now() - t0;
			res.spin.push({ n, ms: Math.round(ms), speedup: +(n * res.spin[0]?.ms! / ms || 1).toFixed(2) });
		}
		for (const n of counts) {
			status(`host threads: ${n} nested workers`);
			const ms = (await one({ kind: "nest", n, iters, url })).data.ms as number;
			res.nested.push({ n, ms: Math.round(ms), speedup: +(n * res.nested[0]?.ms! / ms || 1).toFixed(2) });
		}
		for (const wait of [true, false]) {
			status(`host threads: ${wait ? "wait/notify" : "spin"} round trips`);
			const rounds = wait ? 20000 : 200000;
			const sab = new SharedArrayBuffer(8), a = new Int32Array(sab);
			a[0] = -1;
			const ws = [0, 1].map(() => new Worker(url));
			const ready = ws.map((w) => new Promise((r) => { w.onmessage = r; }));
			ws.forEach((w, id) => w.postMessage({ kind: "pong", sab, id, rounds, wait }));
			await Promise.all(ready);
			const done = ws.map((w) => new Promise((r) => { w.onmessage = r; }));
			const t0 = performance.now();
			Atomics.store(a, 0, 0);
			Atomics.notify(a, 0);
			await Promise.all(done);
			const us = Math.round(((performance.now() - t0) * 1000 / rounds) * 100) / 100;
			ws.forEach((w) => w.terminate());
			if (wait) res.waitPongUs = us;
			else res.spinPongUs = us;
		}
	} catch (e) {
		res.error = (e as Error)?.message ?? String(e);
	} finally {
		URL.revokeObjectURL(url);
	}
	return res;
}

function hostText(h: HostResult): string {
	const row = (l: { n: number; ms: number; speedup: number }[]) => l.map((r) => `${r.n}: ${r.ms} ms (${r.speedup}x)`).join(", ");
	return [
		`workers, each the same work (ideal speedup = n): ${row(h.spin)}`,
		`nested workers (as the kernel's CPUs):             ${row(h.nested)}`,
		`round trip between two workers: Atomics.wait/notify ${h.waitPongUs ?? "?"} us, spinning ${h.spinPongUs ?? "?"} us`,
		h.error ? `error: ${h.error}` : "",
	].filter(Boolean).join("\n");
}

let report: Report | null = null;
let abort: AbortController | null = null;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1]! : NaN; };

const modules = new Map<string, Promise<WebAssembly.Module>>();
function module(smp: boolean): Promise<WebAssembly.Module> {
	const url = (smp ? kernelSmpUrl : kernelUrl)!.href;
	let p = modules.get(url);
	if (!p) modules.set(url, p = loadKernelModule(url, { what: "kernel" }));
	return p;
}

async function runConf(conf: Conf, sel: Work[], opts: { distro: string; mem: number; runs: number; scale: number; jit: boolean; custom: string; width: number }, signal: AbortSignal): Promise<ConfResult> {
	const res: ConfResult = { conf, works: [] };
	const smp = conf.cpus > 1;
	status(`${conf.label}: loading the kernel`);
	const kernel = await module(smp);
	const distro = DISTROS_OFFERED.find((d) => d.name === opts.distro)?.url;
	status(`${conf.label}: booting`);
	await nextFrame();
	const t0 = performance.now();
	let vm: KernelHandle | undefined;
	try {
		const common = {
			kernel, memoryMiB: opts.mem, jit: opts.jit, distro, vsock: true,
			display: false, sound: false, consoleSize: { cols: 80, rows: 24 },
			log: (m: string) => console.log(m),
		} as const;
		vm = conf.worker ? await createKernel({ ...common, worker: true, cpus: smp ? conf.cpus : undefined }) : await createKernel(common);
		res.kernelMs = Math.round(performance.now() - t0);
		await vm.exec("true", [], { timeout: 300000, signal });
		const t1 = performance.now();
		res.bootMs = Math.round(t1 - t0);
		res.bootJank = jank(t0, t1);
		res.guestCpus = (await vm.exec("nproc", [], { signal }).catch(() => ({ stdout: "?" }))).stdout.trim();
		log(`${conf.label}: kernel up in ${res.kernelMs} ms, shell in ${res.bootMs} ms, guest nproc ${res.guestCpus}, longest frame gap ${res.bootJank.maxGap} ms`);
		const n = (x: number) => Math.max(1, Math.round(x * opts.scale));
		const list = [...sel];
		if (opts.custom) list.push({ id: "custom", label: opts.custom, on: true, cmd: () => opts.custom });
		for (const w of list) {
			if (signal.aborted) break;
			const wr: WorkResult = { id: w.id, runs: [], median: NaN, cold: NaN, jank: { maxGap: 0, over50: 0, frames: 0 } };
			res.works.push(wr);
			const tw = performance.now();
			try {
				for (let i = 0; i <= opts.runs; i++) {
					if (signal.aborted) break;
					status(`${conf.label}: ${w.label} (${i + 1}/${opts.runs + 1})`);
					await nextFrame();
					const s = performance.now();
					if (w.run) await w.run(vm);
					else {
						const r = await vm.exec("sh", ["-c", w.cmd!(n, opts.width)], { signal });
						if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode ?? `signal ${r.signal}`}: ${r.stderr.trim().slice(0, 200)}`);
					}
					const ms = performance.now() - s;
					if (i === 0) wr.cold = Math.round(ms);
					else wr.runs.push(Math.round(ms));
				}
				wr.median = opts.runs ? median(wr.runs) : wr.cold;
			} catch (e) {
				wr.error = (e as Error)?.message ?? String(e);
				log(`${conf.label}: ${w.id} failed: ${wr.error}`);
			}
			wr.jank = jank(tw, performance.now());
			render();
		}
	} catch (e) {
		res.error = (e as Error)?.message ?? String(e);
		log(`${conf.label}: ${res.error}`);
	} finally {
		status(`${conf.label}: stopping`);
		await vm?.stop().catch(() => {});
	}
	return res;
}

// --- results ------------------------------------------------------------------
const geomean = (xs: number[]) => xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(Math.max(1, x)), 0) / xs.length) : NaN;
const isPar = (id: string) => !!works.find((w) => w.id === id)?.par;
/** Geometric mean of the medians of the workloads every configuration finished (so they compare); `only`: single-thread or parallel ones. */
function scores(rs: ConfResult[], only?: "single" | "par"): Map<ConfResult, number> {
	const ids = [...new Set(rs.flatMap((r) => r.works.map((w) => w.id)))].filter((id) =>
		(!only || isPar(id) === (only === "par")) &&
		rs.every((r) => r.error || r.works.some((w) => w.id === id && !w.error && Number.isFinite(w.median))));
	return new Map(rs.filter((r) => !r.error).map((r) => [r, geomean(ids.map((id) => r.works.find((w) => w.id === id)!.median))]));
}

function suggest(rs: ConfResult[]): string {
	const sc = scores(rs);
	if (!sc.size) return "No configuration finished.";
	const lines: string[] = [];
	const by = (id: string) => rs.find((r) => r.conf.id === id);
	const main1 = by("main-1"), w1 = by("worker-1");
	const workers = [...sc].filter(([r]) => r.conf.worker).sort((a, b) => a[1] - b[1]);
	const maxJank = (r: ConfResult) => `${Math.max(0, ...r.works.map((w) => w.jank.maxGap))} ms (${r.works.reduce((a, w) => a + w.jank.over50, 0)} over 50 ms)`;
	let worker = true;
	if (main1 && w1 && sc.has(main1) && sc.has(w1)) {
		const ratio = sc.get(w1)! / sc.get(main1)!;
		lines.push(`worker vs page thread (1 CPU): ${ratio < 1 ? `${((1 - ratio) * 100).toFixed(0)}% faster` : `${((ratio - 1) * 100).toFixed(0)}% slower`}; longest frame gap ${maxJank(w1)} vs ${maxJank(main1)}; boot ${w1.bootMs} vs ${main1.bootMs} ms`);
		worker = ratio <= 1.15;
	}
	let cpus = 1;
	if (workers.length) {
		const best = workers[0]![1];
		const ok = workers.filter(([, s]) => s <= best * 1.05).map(([r]) => r.conf.cpus).sort((a, b) => a - b);
		cpus = ok[0] ?? 1;
		const fmt = (m: Map<ConfResult, number>) => [...m].map(([r, s]) => `${r.conf.id} ${Math.round(s)}`).join(", ");
		lines.push(`scores (geomean ms, lower is better): ${fmt(sc)}`);
		lines.push(`  single-thread: ${fmt(scores(rs, "single"))}`);
		lines.push(`  parallel:      ${fmt(scores(rs, "par"))}`);
		const byCpus = workers.map(([r]) => r).sort((a, b) => a.conf.cpus - b.conf.cpus);
		for (const id of ["par4", "jobs", "wide"]) {
			const t = (r: ConfResult) => r.works.find((w) => w.id === id)?.median;
			const t1 = w1 && t(w1);
			if (t1) lines.push(`speedup ${id.padEnd(5)}: ${byCpus.map((r) => `${r.conf.cpus}: ${(t1 / (t(r) ?? NaN)).toFixed(2)}x`).join(", ")}`);
		}
		const s1 = w1 && scores(rs, "single").get(w1), sBest = scores(rs, "single").get(workers.find(([r]) => r.conf.cpus === cpus)?.[0]!);
		if (s1 && sBest && cpus > 1) lines.push(`single-thread cost of ${cpus} CPUs vs 1: ${(((sBest / s1) - 1) * 100).toFixed(0)}%`);
	}
	if (cpus > 1) worker = true;
	lines.unshift(`suggested defaults on this device (${mobile ? "mobile" : "desktop"}, ${hc} threads): cpus=${cpus}, worker=${worker ? 1 : 0}` +
		(cpus > 1 ? ` (cpus=${cpus} = hardwareConcurrency/${(hc / cpus).toFixed(1)})` : ""));
	return lines.join("\n");
}

function render() {
	if (!report) return;
	const rs = report.results;
	const ids = [...new Set(rs.flatMap((r) => r.works.map((w) => w.id)))];
	const label = (id: string) => works.find((w) => w.id === id)?.label ?? id;
	const best = (id: string) => Math.min(...rs.map((r) => r.works.find((w) => w.id === id)?.median ?? Infinity));
	const bootBest = Math.min(...rs.map((r) => r.bootMs ?? Infinity));
	const sc = scores(rs);
	const scBest = Math.min(...sc.values());
	const cell = (v: number | undefined, b: number, extra = "") => v == null || !Number.isFinite(v) ? "<td>-</td>" : `<td class="${v <= b * 1.05 ? "best" : v > b * 1.5 ? "bad" : ""}">${Math.round(v)}${extra}</td>`;
	const head = `<tr><th></th>${rs.map((r) => `<th>${r.conf.label}${r.guestCpus ? ` <span class="dim">(nproc ${r.guestCpus})</span>` : ""}</th>`).join("")}</tr>`;
	const rows = [
		`<tr><td>boot to shell</td>${rs.map((r) => cell(r.bootMs, bootBest, r.bootJank ? ` <span class="dim">${r.bootJank.maxGap}</span>` : "")).join("")}</tr>`,
		...ids.flatMap((id) => [
			`<tr><td>${label(id)}</td>${rs.map((r) => { const w = r.works.find((x) => x.id === id); return w?.error ? `<td class="bad" title="${w.error.replace(/"/g, "&quot;")}">error</td>` : cell(w?.median, best(id)); }).join("")}</tr>`,
			`<tr class="dim"><td>&nbsp; cold / jank</td>${rs.map((r) => { const w = r.works.find((x) => x.id === id); return `<td>${w ? `${Number.isFinite(w.cold) ? w.cold : "-"} / ${w.jank.maxGap}:${w.jank.over50}` : "-"}</td>`; }).join("")}</tr>`,
		]),
		`<tr><td>score (geomean)</td>${rs.map((r) => cell(sc.get(r), scBest)).join("")}</tr>`,
		...(["single", "par"] as const).map((k) => {
			const m = scores(rs, k), b = Math.min(...m.values());
			return `<tr><td>&nbsp; ${k === "par" ? "parallel" : "single-thread"}</td>${rs.map((r) => cell(m.get(r), b)).join("")}</tr>`;
		}),
		`<tr><td>error</td>${rs.map((r) => `<td class="bad">${r.error ?? ""}</td>`).join("")}</tr>`,
	];
	$("results").innerHTML = head + rows.join("");
}

function markdown(): string {
	if (!report) return "";
	const rs = report.results;
	const ids = [...new Set(rs.flatMap((r) => r.works.map((w) => w.id)))];
	const sc = scores(rs);
	const row = (name: string, cells: (string | number | undefined)[]) => `| ${name} | ${cells.map((c) => c ?? "-").join(" | ")} |`;
	return [
		`${device.ua}  `,
		`threads ${hc}, memory ${device.deviceMemory ?? "?"} GB, ${mobile ? "mobile" : "desktop"}, ${report.date}, distro ${report.options.distro}, ${report.options.mem} MiB, size ${report.options.scale}x, ${report.options.runs} runs`,
		"",
		row("ms (median)", rs.map((r) => r.conf.id)),
		`|${"---|".repeat(rs.length + 1)}`,
		row("boot to shell", rs.map((r) => r.bootMs)),
		...ids.map((id) => row(id, rs.map((r) => { const w = r.works.find((x) => x.id === id); return w?.error ? "err" : w && Number.isFinite(w.median) ? `${w.median} (gap ${w.jank.maxGap})` : undefined; }))),
		row("score", rs.map((r) => (sc.has(r) ? Math.round(sc.get(r)!) : undefined))),
		...(["single", "par"] as const).map((k) => { const m = scores(rs, k); return row(`score ${k}`, rs.map((r) => (m.has(r) ? Math.round(m.get(r)!) : undefined))); }),
		"",
		report.suggestion ?? "",
		report.host ? `\nhost threads:\n${hostText(report.host)}` : "",
	].join("\n");
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		status("copied");
	} catch {
		// No clipboard (plain http): show it to copy by hand.
		$("log").textContent = text;
		status("clipboard unavailable: the log shows it to copy");
	}
}

$("run").onclick = async () => {
	const sel = works.filter((w) => document.querySelector<HTMLInputElement>(`[data-work="${w.id}"]`)!.checked);
	const cs = confs.filter((c) => document.querySelector<HTMLInputElement>(`[data-conf="${c.id}"]`)!.checked);
	const opts = {
		distro: $<HTMLSelectElement>("distro").value,
		mem: Number($<HTMLInputElement>("mem").value) || autoMemoryMiB({ mobile }).mib,
		runs: Math.max(1, Number($<HTMLInputElement>("runs").value) || 3),
		scale: Number($<HTMLSelectElement>("scale").value) || 1,
		jit: $<HTMLInputElement>("jit").checked,
		custom: $<HTMLInputElement>("custom").value.trim(),
		width: Math.max(4, ...cs.map((c) => c.cpus)),
	};
	report = { device, date: new Date().toISOString(), options: { ...opts, workloads: sel.map((w) => w.id) }, results: [], host: report?.host };
	abort = new AbortController();
	$<HTMLButtonElement>("run").disabled = true;
	$<HTMLButtonElement>("stop").disabled = false;
	logEl.textContent = "";
	log(`options: ${JSON.stringify(report.options)}`);
	for (const c of cs) {
		if (abort.signal.aborted) break;
		const r = await runConf(c, sel, opts, abort.signal);
		report.results.push(r);
		report.suggestion = suggest(report.results);
		$("rec").textContent = report.suggestion;
		$("rec").classList.remove("dim");
		render();
		$<HTMLButtonElement>("copy").disabled = $<HTMLButtonElement>("copymd").disabled = false;
	}
	try { localStorage.setItem("kw-profile-last", JSON.stringify(report)); } catch {}
	status(abort.signal.aborted ? "stopped" : "done");
	log(report.suggestion ?? "");
	$<HTMLButtonElement>("run").disabled = false;
	$<HTMLButtonElement>("stop").disabled = true;
};
$("stop").onclick = () => abort?.abort();
$("host").onclick = async () => {
	$<HTMLButtonElement>("host").disabled = $<HTMLButtonElement>("run").disabled = true;
	const h = await hostThreads();
	$("hostout").textContent = hostText(h);
	$("hostout").classList.remove("dim");
	log(`host threads:\n${hostText(h)}`);
	report ??= { device, date: new Date().toISOString(), options: {}, results: [] };
	report.host = h;
	$<HTMLButtonElement>("copy").disabled = $<HTMLButtonElement>("copymd").disabled = false;
	$<HTMLButtonElement>("host").disabled = $<HTMLButtonElement>("run").disabled = false;
	status("done");
};
$("copy").onclick = () => void copy(JSON.stringify(report, null, 1));
$("copymd").onclick = () => void copy(markdown());

// The last run in this browser, for a look after a reload.
try {
	const last = localStorage.getItem("kw-profile-last");
	if (last) {
		report = JSON.parse(last) as Report;
		render();
		$("rec").textContent = `(last run, ${report.date})\n${report.suggestion ?? ""}`;
		$<HTMLButtonElement>("copy").disabled = $<HTMLButtonElement>("copymd").disabled = false;
	}
} catch {}
