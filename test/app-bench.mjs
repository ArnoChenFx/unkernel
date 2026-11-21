#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Node, Bun and Claude Code timings of one or more bundles on the profile
// disk (.agents/a64/performance.md, Measuring): boots Debian with
// test/app-bench.sh for every bundle in every round (the order rotates per
// round), and prints per command the median first run and the median later
// run in ms, with the difference to the first bundle.
//
//   node test/app-bench.mjs [--rounds N] [--runs N] [--cpus N] [--stats] [NAME=]BUNDLE.wasm[,VAR=VALUE...] ...
//
// VAR=VALUE after a bundle sets test/app-bench.sh's variables for that
// variant (ASLR=0, BUN_CPU=...), so one bundle can be listed twice.
// Without a bundle: vendor/build/bundle/unkernel.wasm. --cpus 2 boots the
// SMP kernel of each bundle. One boot takes about a minute. The disk is
// opened with --snapshot, so several runs can share it. --stats passes
// --stats to the CLI (a stats bundle) and keeps each boot's output in
// app-bench-NAME-ROUND.log in the current directory.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const num = (f, d) => (argv.includes(f) ? Number(argv.splice(argv.indexOf(f), 2)[1]) : d);
const rounds = num("--rounds", 3), runs = num("--runs", 3), cpus = num("--cpus", 1);
const stats = argv.includes("--stats") && !!argv.splice(argv.indexOf("--stats"), 1);
const bundles = (argv.length ? argv : ["vendor/build/bundle/unkernel.wasm"]).map((a) => {
	const [spec, ...env] = a.split(",");
	const i = spec.indexOf("=");
	const file = path.resolve(i < 0 ? spec : spec.slice(i + 1));
	if (env.some((e) => !/^[A-Z_]+=[\w.]+$/.test(e))) throw new Error(`bad variable in ${a}`);
	return { name: i < 0 ? [path.basename(file, ".wasm"), ...env].join(",") : spec.slice(0, i), file, env: env.join(" ") };
});
const disk = path.join(root, "vendor/build/profile/debian-node.img");
for (const f of [disk, ...bundles.map((b) => b.file)]) {
	if (!existsSync(f)) {
		console.error(`missing ${f}`);
		process.exit(1);
	}
}

/** One boot: the RES lines of test/app-bench.sh as [name, run, ms]. */
function boot(b, round) {
	return new Promise((resolve, reject) => {
		const args = [path.join(root, "js/cli.ts"), "--kernel", b.file, "--distro", "debian", "--data", disk, "--snapshot", "--mem", "1024", "--no-net",
			"--mount", `${path.join(root, "test")}:/t:ro`, "--timeout", "900", "--input", `{8}RUNS=${runs} ${b.env} sh /t/app-bench.sh${stats ? "; sudo poweroff -f" : ""}\\n`];
		if (cpus > 1) args.push("--cpus", String(cpus));
		if (stats) args.push("--stats");
		const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", done = false;
		const onData = (d) => {
			out += d;
			if (!done && /^ALL-DONE/m.test(out)) {
				done = true;
				// With --stats the guest powers off, and the CLI prints its counters at exit.
				if (!stats) child.kill("SIGINT");
				setTimeout(() => child.kill("SIGKILL"), stats ? 30000 : 5000).unref();
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", reject);
		child.on("close", () => {
			if (stats) writeFileSync(`app-bench-${b.name.replace(/\W+/g, "_")}-${round}.log`, out);
			const res = [...out.matchAll(/^RES (\S+) (\d+) (\d+) rc=(\d+)/gm)].map((m) => ({ name: m[1], run: +m[2], ms: +m[3], rc: +m[4] }));
			if (!done || !res.length) return reject(new Error(`${b.name}: the bench did not finish:\n${out.slice(-2000)}`));
			for (const r of res) if (r.rc) console.error(`warning: ${b.name}: ${r.name} run ${r.run} exited ${r.rc}`);
			resolve(res);
		});
	});
}

const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// samples[bundle][row] = ms of every boot; a row is "name first" or "name later".
const samples = bundles.map(() => new Map());
const rows = [];
for (let r = 0; r < rounds; r++) {
	for (let k = 0; k < bundles.length; k++) {
		const i = (k + r) % bundles.length;
		const t0 = performance.now();
		const res = await boot(bundles[i], r + 1);
		const names = [...new Set(res.map((x) => x.name))];
		for (const name of names) {
			const of = res.filter((x) => x.name === name);
			const add = (row, ms) => {
				if (!rows.includes(row)) rows.push(row);
				const m = samples[i];
				m.set(row, [...(m.get(row) ?? []), ms]);
			};
			add(`${name} first`, of[0].ms);
			if (of.length > 1) add(`${name} later`, median(of.slice(1).map((x) => x.ms)));
		}
		console.error(`round ${r + 1}/${rounds} ${bundles[i].name}: ${((performance.now() - t0) / 1000).toFixed(0)} s`);
	}
}
console.log(`${new Date().toISOString().slice(0, 10)}, ${cpus} CPU${cpus > 1 ? "s" : ""}, ${rounds} boots per bundle, ${runs} runs per command; ms, medians (min-max)`);
console.log(`| command | ${bundles.map((b) => b.name).join(" | ")} |`);
console.log(`| --- | ${bundles.map(() => "---:").join(" | ")} |`);
for (const row of rows) {
	const base = median(samples[0].get(row) ?? [NaN]);
	const cells = bundles.map((b, i) => {
		const a = samples[i].get(row);
		if (!a) return "-";
		const m = median(a);
		const d = i ? ` ${m >= base ? "+" : ""}${(((m - base) / base) * 100).toFixed(1)}%` : "";
		return `${m.toFixed(0)} (${Math.min(...a)}-${Math.max(...a)})${d}`;
	});
	console.log(`| ${row} | ${cells.join(" | ")} |`);
}
