// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwemu benchmarks (A64): runs each benchmark guest on the native and wasm64
// harness and prints a guest-MIPS table. Each mode runs kw_run (the
// decoded-op tier); --ref adds the same harness with the reference
// interpreter (kw_debug_run_ref) as a column, the "before" of the tier.
// usage: node test/kwemu-bench.mjs [zig-out prefix] [--reps N] [--median] [--only name,name]
//        [--wasm-only|--native-only] [--ref]
// (sieve+fib = test/guest/a64/bench.c; mem/fib/fp/sha/interp = test/guest/kbench.c)
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const prefix = resolve(argv.find((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").match(/^--(reps|only)$/)) ?? "zig-out");
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const reps = Number(opt("--reps", "3"));
// --median: report the median of the reps instead of the best
const median = argv.includes("--median");
const only = opt("--only", "")?.split(",").filter(Boolean);
const withRef = argv.includes("--ref");
const guestDir = join(prefix, "guest", "a64");
const dec = new TextDecoder();
const wasmModule = await WebAssembly.compile(await readFile(join(prefix, "bin", "kwemu-harness.wasm")));

async function runWasm(elf, args, ref) {
  let out = "", err = "", mem;
  const stub = () => 0; // a library built with -Dkwemu-jit imports the JIT host; A64 never calls it
  const imports = {
    env: {
      host_write: (fd, ptr, len) => {
        const s = dec.decode(new Uint8Array(mem.buffer, Number(ptr), Number(len)));
        if (fd === 2) err += s; else out += s;
      },
      host_now_ns: () => Number(process.hrtime.bigint()),
    },
    unkernel: { kw_host_jit_caps: stub, kw_host_jit_compile: () => -1, kw_host_jit_free: () => {} },
  };
  const inst = await WebAssembly.instantiate(wasmModule, imports);
  const ex = inst.exports;
  mem = ex.memory;
  const image = await readFile(elf);
  const argBytes = new TextEncoder().encode(args.join("\0") + "\0");
  const total = image.length + argBytes.length;
  const ptr = Number(ex.kwh_buf(BigInt(total)));
  new Uint8Array(mem.buffer, ptr, total).set(image);
  new Uint8Array(mem.buffer, ptr + image.length, argBytes.length).set(argBytes);
  const status = ex.kwh_run(BigInt(image.length), BigInt(argBytes.length), ref ? 5 : 1);
  return { status, out, err };
}

function runNative(elf, args, ref) {
  const p = spawnSync(join(prefix, "bin", "kwemu-harness"), ["--stats", ...(ref ? ["--ref"] : []), elf, ...args.slice(1)], { encoding: "utf8" });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

const cases = [
  { name: "sieve+fib", guest: "bench", args: ["2000000", "3", "27"] },
  { name: "mem", guest: "kbench", args: ["mem"] },
  { name: "fib", guest: "kbench", args: ["fib"] },
  { name: "fp", guest: "kbench", args: ["fp"] },
  { name: "sha", guest: "kbench", args: ["sha"] },
  { name: "interp", guest: "kbench", args: ["interp"] },
].filter((c) => !only?.length || only.includes(c.name));

const modes = [];
for (const [m, run] of [["native", runNative], ["wasm64", runWasm]]) {
  if ((argv.includes("--wasm-only") && m === "native") || (argv.includes("--native-only") && m === "wasm64")) continue;
  if (withRef) modes.push([`${m} ref`, (elf, args) => run(elf, args, true)]);
  modes.push([m, (elf, args) => run(elf, args, false)]);
}

console.log(`| benchmark | Minsns | ${modes.map(([m]) => `${m} MIPS`).join(" | ")} | checksum |`);
console.log(`| --- | ---: | ${modes.map(() => "---:").join(" | ")} | --- |`);
let failed = 0;
for (const c of cases) {
  const elf = join(guestDir, `${c.guest}.elf`);
  const cols = [];
  let insns = "", sum = "";
  for (const [, run] of modes) {
    let best = 0;
    const all = [];
    for (let i = 0; i < reps; i++) {
      const r = await run(elf, [c.guest, ...c.args]);
      const m = /instret=(\d+) .*MIPS=([\d.]+)/.exec(r.err);
      if (r.status !== 0 || !m) {
        failed++;
        console.error(`FAIL ${c.name}: status ${r.status}\n${r.out}\n${r.err}`);
        break;
      }
      insns = (Number(m[1]) / 1e6).toFixed(1);
      const s = r.out.trim().split("\n").pop();
      if (sum && sum !== s) { failed++; console.error(`checksum mismatch ${c.name}: ${sum} vs ${s}`); }
      sum = s;
      best = Math.max(best, Number(m[2]));
      all.push(Number(m[2]));
    }
    all.sort((a, b) => a - b);
    cols.push((median && all.length ? all[(all.length - 1) >> 1] : best).toFixed(1));
  }
  console.log(`| ${c.name} | ${insns} | ${cols.join(" | ")} | ${sum} |`);
}
if (failed) process.exit(1);
