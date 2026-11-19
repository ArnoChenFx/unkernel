// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Differential tests of the A64 CPU: every guest in zig-out/guest/a64 runs
// under qemu-aarch64 (the reference) and under kwemu through the test
// harness (src/emu/harness.zig, C ABI only), native and wasm64; stdout and
// the exit status must be identical. A third run ("lockstep") runs kw_run's
// decoded-op tier and the reference interpreter side by side in the native
// harness and stops at the first event, register or memory difference. Without qemu-aarch64 on PATH (or
// $QEMU_AARCH64) the comparison is skipped with a note, and the kwemu runs
// must still exit with the status the guest expects.
// Also checks that the wasm64 object imports nothing the kernel does not
// provide (compiler-rt helpers such as __multi3 for u128 arithmetic).
// usage: node test/a64-test.mjs <zig-out prefix>
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const prefix = resolve(process.argv[2] ?? "zig-out");
const guestDir = join(prefix, "guest", "a64");
const dec = new TextDecoder();
const env = { HOME: "/", PATH: "/bin", TERM: "dumb" }; // what the harness passes

// guest, args, expected exit status
const cases = [
  { guest: "hello", args: ["x", "y z"], status: 42 },
  { guest: "inttest", args: [], status: 0 },
  { guest: "simdmovetest", args: [], status: 0 },
  { guest: "cryptotest", args: [], status: 0 },
  { guest: "atomictest", args: [], status: 0 },
  { guest: "simdtest", args: [], status: 0 },
  { guest: "fptest", args: [], status: 0 },
  { guest: "simdfptest", args: [], status: 0 },
  { guest: "bench", args: ["200000", "2", "20"], status: 0 },
  { guest: "kbench", args: ["interp", "2"], status: 0 },
];

let failed = 0;

// ---- wasm64 object: only the imports the kernel link provides -----------------
{
  const obj = await WebAssembly.compile(await readFile(join(prefix, "lib", "kwemu.o")));
  const bad = WebAssembly.Module.imports(obj).filter((i) => i.kind === "function" && !i.name.startsWith("kw_host_jit_"));
  if (bad.length) {
    failed++;
    console.log(`FAIL a64 kwemu.o imports functions: ${bad.map((i) => i.name).join(", ")} (u128 shifts/multiplies? see src/a64/common.zig)`);
  } else console.log("ok   a64 kwemu.o imports no functions");
}

// ---- runners ------------------------------------------------------------------
const qemu = process.env.QEMU_AARCH64 ?? "qemu-aarch64";
const haveQemu = spawnSync(qemu, ["--version"], { encoding: "utf8" }).status === 0;

function runQemu(elf, args) {
  const p = spawnSync(qemu, [elf, ...args], { encoding: "utf8", env });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

function runNative(elf, args) {
  const p = spawnSync(join(prefix, "bin", "kwemu-harness"), ["--stats", elf, ...args], { encoding: "utf8" });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

function runLockstep(elf, args) {
  const p = spawnSync(join(prefix, "bin", "kwemu-harness"), ["--stats", "--lockstep", "1", elf, ...args], { encoding: "utf8" });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

const wasmModule = await WebAssembly.compile(await readFile(join(prefix, "bin", "kwemu-harness.wasm")));
async function runWasm(elf, args) {
  let out = "", err = "", mem;
  const stub = () => 0; // a library built with -Dkwemu-jit imports the JIT host; never used by A64
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
  const argBytes = new TextEncoder().encode([elf, ...args].join("\0") + "\0");
  const total = image.length + argBytes.length;
  const ptr = Number(ex.kwh_buf(BigInt(total)));
  if (!ptr) throw new Error("image too large");
  new Uint8Array(mem.buffer, ptr, total).set(image);
  new Uint8Array(mem.buffer, ptr + image.length, argBytes.length).set(argBytes);
  const status = ex.kwh_run(BigInt(image.length), BigInt(argBytes.length), 1);
  return { status, out, err };
}

function stats(r) {
  const m = /instret=(\d+).*MIPS=([\d.]+)/.exec(r.err);
  return m ? `${(Number(m[1]) / 1e6).toFixed(2)}M insns, ${m[2]} MIPS` : "";
}

/** First differing line of two outputs, for the failure message. */
function firstDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i]) return `line ${i + 1}: qemu ${JSON.stringify(x[i])}, kwemu ${JSON.stringify(y[i])}`;
  return "";
}

if (!haveQemu) console.log(`skipped a64 qemu comparison: ${qemu} not found (only the exit statuses are checked)`);
for (const c of cases) {
  const elf = join(guestDir, `${c.guest}.elf`);
  const ref = haveQemu ? runQemu(elf, c.args) : null;
  if (ref && ref.status !== c.status) {
    failed++;
    console.log(`FAIL a64 qemu ${c.guest}: status ${ref.status}, want ${c.status}\n${ref.err}`);
    continue;
  }
  for (const [mode, run] of [["native", runNative], ["wasm64", runWasm], ["lockstep", runLockstep]]) {
    const r = await run(elf, c.args);
    let why = "";
    if (r.status !== c.status) why = `status ${r.status}, want ${c.status}`;
    else if (ref && r.out !== ref.out) why = `stdout differs from qemu-aarch64 (${firstDiff(ref.out, r.out)})`;
    if (why) {
      failed++;
      console.log(`FAIL a64 ${mode} ${c.guest}: ${why}\n--- stdout ---\n${r.out}--- stderr ---\n${r.err}`);
    } else console.log(`ok   a64 ${mode.padEnd(8)} ${c.guest.padEnd(12)} ${ref ? "= qemu" : ""} (${stats(r)})`);
  }
}

if (failed) {
  console.log(`${failed} a64 test(s) failed`);
  process.exit(1);
}
