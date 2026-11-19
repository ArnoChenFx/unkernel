// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The defaults profiler on Node (web/profile.html's twin, the same
// workloads and scores): boot the bundled kernel once per configuration
// (on this thread or in a worker thread, 1..N CPUs), run everyday guest
// work through exec(), and record how long it takes and how long Node's
// event loop went without a turn meanwhile (what a server on this thread
// would feel). Prints a markdown table and a suggestion; --json writes
// everything.
//
//   node test/profile.ts [--cpus 1,2,4,8] [--main] [--runs 3] [--scale 1]
//                        [--distro debian|alpine|none] [--mem MiB] [--no-jit]
//                        [--json FILE]
//   UNKERNEL_TEST_KERNEL=path ...   another bundle instead of the bundled kernel
//
// --cpus: the worker configurations (default 1, 2, 4, 8, 16 and this host's
// threads, up to 16); --main adds 1 CPU on this thread (on by default;
// --no-main leaves it out).
import { writeFileSync } from "node:fs";
import os from "node:os";
import { createKernel, fetchDistro, type KernelHandle } from "../js/node.ts";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };

const MAX_CPUS = 16; // the SMP kernel's NR_CPUS
const threads = os.availableParallelism();
const cpuList = opt("--cpus", [...new Set([1, 2, 4, 8, 16, Math.min(threads, MAX_CPUS)])].filter((n) => n <= Math.min(threads, MAX_CPUS)).join(","))
	.split(",").map(Number).filter((n) => n >= 1 && n <= MAX_CPUS);
const runs = Math.max(1, Number(opt("--runs", "3")));
const scale = Number(opt("--scale", "1")) || 1;
const distroName = opt("--distro", "debian");
const mem = Number(opt("--mem", "512"));
const jit = !flag("--no-jit");
const kernel = process.env.UNKERNEL_TEST_KERNEL;

interface Conf { id: string; label: string; worker: boolean; cpus: number }
const confs: Conf[] = [
	...(flag("--no-main") ? [] : [{ id: "main-1", label: "this thread, 1 CPU", worker: false, cpus: 1 }]),
	...cpuList.map((n) => ({ id: `worker-${n}`, label: `worker, ${n} CPU${n > 1 ? "s" : ""}`, worker: true, cpus: n })),
];
const width = Math.max(4, ...confs.map((c) => c.cpus));

// The same workloads as web/src/profile.ts; `par`: parallel (scored apart).
interface Work { id: string; par?: boolean; cmd?: (n: (x: number) => number) => string; run?: (vm: KernelHandle) => Promise<void> }
const loop = (k: number) => `i=0; while [ $i -lt ${k} ]; do i=$((i+1)); done`;
const works: Work[] = [
	{ id: "rtt", run: async (vm) => { for (let i = 0; i < 10; i++) await vm.exec("true"); } },
	{ id: "loop", cmd: (n) => loop(n(40000)) },
	{ id: "spawn", cmd: (n) => `for i in $(seq ${n(60)}); do /bin/true; done` },
	{ id: "gzip", cmd: (n) => `seq ${n(200000)} | gzip -c | wc -c` },
	{ id: "sort", cmd: (n) => `seq ${n(100000)} | sort -rn | md5sum` },
	{ id: "sha", cmd: (n) => `dd if=/dev/zero bs=64k count=${n(256)} 2>/dev/null | sha256sum` },
	{ id: "fs", cmd: () => "find /usr -xdev 2>/dev/null | wc -l" },
	{ id: "par4", par: true, cmd: (n) => `for j in 1 2 3 4; do (${loop(n(20000))}) & done; wait` },
	{ id: "jobs", par: true, cmd: (n) => `for j in 1 2 3 4 5 6 7 8; do (seq ${n(20000)} | sort -rn | md5sum >/dev/null) & done; wait` },
	{ id: "wide", par: true, cmd: (n) => `for j in $(seq ${width}); do (${loop(n(15000))}) & done; wait` },
];
const isPar = (id: string) => !!works.find((w) => w.id === id)?.par;

// --- event-loop lag: how long this thread went without a turn ----------------------
interface Lag { max: number; over50: number }
const TICK = 10;
const lags: { t: number; lag: number }[] = [];
let expect = performance.now() + TICK;
const ticker = setInterval(() => {
	const now = performance.now();
	lags.push({ t: now, lag: Math.max(0, now - expect) });
	expect = now + TICK;
}, TICK);
const lag = (t0: number, t1: number): Lag => {
	const l = lags.filter((x) => x.t > t0 && x.t <= t1);
	return { max: Math.round(Math.max(0, ...l.map((x) => x.lag))), over50: l.filter((x) => x.lag > 50).length };
};

interface WorkResult { id: string; runs: number[]; median: number; cold: number; lag: Lag; error?: string }
interface ConfResult { conf: Conf; bootMs?: number; guestCpus?: string; works: WorkResult[]; error?: string }
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1]! : NaN; };

const distro = distroName === "none" ? undefined : await fetchDistro(distroName);
const log = (m: string) => process.stderr.write(`${m}\n`);

async function runConf(conf: Conf): Promise<ConfResult> {
	const res: ConfResult = { conf, works: [] };
	const t0 = performance.now();
	let vm: KernelHandle | undefined;
	try {
		const common = { kernel, memoryMiB: mem, jit, distro, vsock: true, log: () => {}, cpus: conf.cpus > 1 ? conf.cpus : undefined };
		vm = conf.worker ? await createKernel({ ...common, worker: true }) : await createKernel(common);
		await vm.exec("true", [], { timeout: 300000 });
		res.bootMs = Math.round(performance.now() - t0);
		res.guestCpus = (await vm.exec("nproc").catch(() => ({ stdout: "?" }))).stdout.trim();
		log(`${conf.label}: shell in ${res.bootMs} ms, nproc ${res.guestCpus}`);
		const n = (x: number) => Math.max(1, Math.round(x * scale));
		for (const w of works) {
			const wr: WorkResult = { id: w.id, runs: [], median: NaN, cold: NaN, lag: { max: 0, over50: 0 } };
			res.works.push(wr);
			const tw = performance.now();
			try {
				for (let i = 0; i <= runs; i++) {
					const s = performance.now();
					if (w.run) await w.run(vm);
					else {
						const r = await vm.exec("sh", ["-c", w.cmd!(n)]);
						if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode ?? `signal ${r.signal}`}: ${r.stderr.trim().slice(0, 200)}`);
					}
					const ms = Math.round(performance.now() - s);
					if (i === 0) wr.cold = ms;
					else wr.runs.push(ms);
				}
				wr.median = median(wr.runs);
			} catch (e) {
				wr.error = (e as Error)?.message ?? String(e);
				log(`${conf.label}: ${w.id} failed: ${wr.error}`);
			}
			wr.lag = lag(tw, performance.now());
			log(`  ${w.id}: ${wr.median} ms (cold ${wr.cold}, event loop max lag ${wr.lag.max} ms)`);
		}
	} catch (e) {
		res.error = (e as Error)?.message ?? String(e);
		log(`${conf.label}: ${res.error}`);
	} finally {
		await vm?.stop().catch(() => {});
	}
	return res;
}

// --- scores and the suggestion (as web/src/profile.ts) ---------------------------
const geomean = (xs: number[]) => xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(Math.max(1, x)), 0) / xs.length) : NaN;
function scores(rs: ConfResult[], only?: "single" | "par"): Map<ConfResult, number> {
	const ids = works.map((w) => w.id).filter((id) => (!only || isPar(id) === (only === "par")) &&
		rs.every((r) => r.error || r.works.some((w) => w.id === id && !w.error && Number.isFinite(w.median))));
	return new Map(rs.filter((r) => !r.error).map((r) => [r, geomean(ids.map((id) => r.works.find((w) => w.id === id)!.median))]));
}

const results: ConfResult[] = [];
log(`host: ${os.cpus()[0]?.model}, ${threads} threads, ${Math.round(os.totalmem() / 2 ** 30)} GiB, Node ${process.version}; distro ${distroName}, ${mem} MiB, jit ${jit}, ${runs} runs, size ${scale}x`);
for (const c of confs) results.push(await runConf(c));
clearInterval(ticker);

const sc = scores(results), single = scores(results, "single"), par = scores(results, "par");
const row = (name: string, cells: (string | number | undefined)[]) => `| ${name} | ${cells.map((c) => c ?? "-").join(" | ")} |`;
const fmt = (v: number | undefined) => (v == null || !Number.isFinite(v) ? undefined : Math.round(v));
const table = [
	row("ms (median)", results.map((r) => `${r.conf.id}${r.guestCpus ? ` (nproc ${r.guestCpus})` : ""}`)),
	`|${"---|".repeat(results.length + 1)}`,
	row("boot to shell", results.map((r) => r.bootMs)),
	...works.map((w) => row(w.id, results.map((r) => {
		const x = r.works.find((y) => y.id === w.id);
		return x?.error ? "err" : x && Number.isFinite(x.median) ? `${x.median} (lag ${x.lag.max})` : undefined;
	}))),
	row("score", results.map((r) => fmt(sc.get(r)))),
	row("score single", results.map((r) => fmt(single.get(r)))),
	row("score parallel", results.map((r) => fmt(par.get(r)))),
].join("\n");

const lines: string[] = [];
const w1 = results.find((r) => r.conf.id === "worker-1"), m1 = results.find((r) => r.conf.id === "main-1");
if (w1 && m1 && sc.has(w1) && sc.has(m1)) {
	const ratio = sc.get(w1)! / sc.get(m1)!;
	const maxLag = (r: ConfResult) => `${Math.max(0, ...r.works.map((w) => w.lag.max))} ms (${r.works.reduce((a, w) => a + w.lag.over50, 0)} over 50 ms)`;
	lines.push(`worker vs this thread (1 CPU): ${ratio < 1 ? `${((1 - ratio) * 100).toFixed(0)}% faster` : `${((ratio - 1) * 100).toFixed(0)}% slower`}; event loop max lag ${maxLag(w1)} vs ${maxLag(m1)}`);
}
const workers = results.filter((r) => r.conf.worker && sc.has(r)).sort((a, b) => a.conf.cpus - b.conf.cpus);
if (workers.length) {
	const best = Math.min(...workers.map((r) => sc.get(r)!));
	const cpus = workers.find((r) => sc.get(r)! <= best * 1.05)!.conf.cpus;
	lines.push(`fewest CPUs within 5% of the best score: ${cpus} (of ${threads} threads)`);
	for (const id of ["par4", "jobs", "wide"]) {
		const t1 = w1?.works.find((w) => w.id === id)?.median;
		if (t1) lines.push(`speedup ${id.padEnd(5)}: ${workers.map((r) => `${r.conf.cpus}: ${(t1 / (r.works.find((w) => w.id === id)?.median ?? NaN)).toFixed(2)}x`).join(", ")}`);
	}
}
console.log(`${os.cpus()[0]?.model}, ${threads} threads, Node ${process.version}, ${new Date().toISOString().slice(0, 10)}; distro ${distroName}, ${mem} MiB, ${runs} runs, size ${scale}x\n\n${table}\n\n${lines.join("\n")}`);

const json = opt("--json", "");
if (json) {
	writeFileSync(json, JSON.stringify({ host: { cpu: os.cpus()[0]?.model, threads, mem: os.totalmem(), node: process.version, platform: `${os.platform()} ${os.release()}` },
		date: new Date().toISOString(), options: { distro: distroName, mem, jit, runs, scale, width }, results, suggestion: lines }, null, 1));
	log(`wrote ${json}`);
}
process.exit(0);
