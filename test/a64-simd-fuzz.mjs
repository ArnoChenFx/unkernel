// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Differential fuzz of the AdvSIMD arithmetic group (src/a64/simd_arith.zig
// and the files it dispatches to) against qemu-aarch64, run by hand:
//
//   zig build && node test/a64-simd-fuzz.mjs [--fp] [count=20000] [seed=1]
//
// Draws random words from the AdvSIMD arithmetic encoding classes (vector
// and scalar; random register numbers, sizes, opcodes and immediates,
// reserved neighbours included; --fp: mostly the FP opcodes of each class),
// keeps those decode.zig routes to simd_arith, and compares
//  1. legality: kwemu-a64-classify (ILLEGAL or not) against qemu-aarch64
//     -cpu cortex-a53 (ARMv8.0 with the crypto extensions; SIGILL or not),
//     disassembling the words where they disagree with llvm-mc. kwemu
//     ILLEGAL where qemu runs it is expected only for PMULL on 64-bit lanes
//     while the PMULL feature is off; anything else is a failure;
//  2. results: every word legal on both runs under qemu and under the
//     native harness; V0..V31 and FPSR must hash the same. Default:
//     guest/a64/simdtest ("W"/"w" mode, 16 integer register states, FPCR
//     0). --fp: guest/a64/simdfptest (48 FP register states under every
//     FPCR mode, made from a new seed for each batch of words).
// Exit status 1 on any unexpected difference.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const prefix = resolve(root, "zig-out");
const args = process.argv.slice(2);
const fpMode = args[0] === "--fp";
if (fpMode) args.shift();
const count = Number(args[0] ?? 20000);
let seed = Number(args[1] ?? 1) >>> 0 || 1;
const qemu = process.env.QEMU_AARCH64 ?? "qemu-aarch64";
const elf = join(prefix, "guest", "a64", fpMode ? "simdfptest.elf" : "simdtest.elf");

function rand32() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

// [mask of the fixed bits, their value]
const templates = [
  [0x9f200400, 0x0e200400], // three same
  [0x9f3e0c00, 0x0e300800], // across lanes
  [0x9f3e0c00, 0x0e200800], // two-register misc
  [0x9f200c00, 0x0e200000], // three different
  [0x9f800400, 0x0f000400], // shift by immediate (and modified immediate)
  [0x9f000400, 0x0f000000], // by element
  [0xdf200400, 0x5e200400], // scalar three same
  [0xdf3e0c00, 0x5e300800], // scalar pairwise
  [0xdf3e0c00, 0x5e200800], // scalar two-register misc
  [0xdf200c00, 0x5e200000], // scalar three different
  [0xdf800400, 0x5f000400], // scalar shift by immediate
  [0xdf000400, 0x5f000000], // scalar by element
  [0x9e000000, 0x0e000000], // any vector AdvSIMD
  [0xde000000, 0x5e000000], // any scalar AdvSIMD
];
// --fp: the FP opcodes of each class (U, size, Q, registers and the other
// fields random)
const fpTemplates = [
  [0x9f20c400, 0x0e20c400], // three same, opcode 11xxx
  [0xdf20c400, 0x5e20c400], // scalar three same, opcode 11xxx
  [0x9f3ecc00, 0x0e20c800], // two-register misc, opcode 011xx
  [0x9f3e8c00, 0x0e208800], // two-register misc, opcode 1xxxx
  [0xdf3ecc00, 0x5e20c800], // scalar two-register misc, opcode 011xx
  [0xdf3e8c00, 0x5e208800], // scalar two-register misc, opcode 1xxxx
  [0x9f3ecc00, 0x0e30c800], // across lanes, opcode 011xx
  [0xdf3ecc00, 0x5e30c800], // scalar pairwise, opcode 011xx
  [0x9f80e400, 0x0f00e400], // shift by immediate, opcode 111xx
  [0xdf80e400, 0x5f00e400], // scalar shift by immediate, opcode 111xx
  [0x9f000400, 0x0f000000], // by element
  [0xdf000400, 0x5f000000], // scalar by element
  [0x9f000400, 0x0f800000], // by element, size 1x
  [0xdf000400, 0x5f800000], // scalar by element, size 1x
];
const pool = fpMode ? fpTemplates : templates;

const hex = (w) => w.toString(16).padStart(8, "0");
const words = new Set();
while (words.size < count) {
  const [m, v] = pool[rand32() % pool.length];
  words.add(hex(((rand32() & ~m) | v) >>> 0));
}

// 1. kwemu's view
const dir = await mkdtemp(join(tmpdir(), "a64-fuzz-"));
const file = join(dir, "words.txt");
await writeFile(file, [...words].join("\n") + "\n");
const cl = spawnSync(join(prefix, "bin", "kwemu-a64-classify"), [file], { encoding: "utf8", maxBuffer: 1 << 28 });
await rm(dir, { recursive: true, force: true });
if (cl.status !== 0) throw new Error(`kwemu-a64-classify failed: ${cl.stderr}`);
const kw = new Map();
for (const line of cl.stdout.trim().split("\n")) {
  const [w, group, st] = line.split(" ");
  if (group === "simd_arith") kw.set(w, st === "ok");
}
const list = [...kw.keys()];

// 2. qemu's view and results
// the harness takes at most 64 argv and envp entries together (src/emu/harness.zig,
// `ptrs`; it passes 3 envp strings): 56 words, the ELF, the mode and the seed
const BATCH = 56;
// simdfptest takes a register-state seed after the mode: one per batch
function runBatches(cmd, pre, mode, ws, size) {
  const out = new Map();
  for (let i = 0; i < ws.length; i += size) {
    const batch = ws.slice(i, i + size);
    const st = fpMode ? [String(seed + i)] : [];
    const p = spawnSync(cmd, [...pre, elf, mode, ...st, ...batch], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (p.status !== 0) throw new Error(`${cmd} exited ${p.status} (${p.signal ?? ""}) on ${[mode, ...st, ...batch].join(" ")}: ${p.stderr}`);
    for (const line of p.stdout.trim().split("\n")) {
      const [w, h] = line.split(" ");
      out.set(w, h);
    }
  }
  return out;
}
const qm = runBatches(qemu, ["-cpu", "cortex-a53"], "W", list, 1500);
const qemuIll = (w) => qm.get(w) === "ILL";

// legality differences, named by llvm-mc
const diff = list.filter((w) => kw.get(w) !== (qm.get(w) !== "ILL"));
const names = new Map();
if (diff.length) {
  const input = diff.map((w) => w.match(/../g).reverse().map((b) => "0x" + b).join(" ")).join("\n");
  const p = spawnSync("llvm-mc", ["--disassemble", "-triple=aarch64", "-mattr=+v8a,+aes", "-show-encoding"], { input, encoding: "utf8" });
  for (const line of (p.stdout ?? "").split("\n")) {
    const m = /^\s+(\S+)\s*(.*?)\s*\/\/ encoding: \[(.*)\]/.exec(line);
    if (!m) continue;
    const w = m[3].split(",").map((b) => b.trim().slice(2)).reverse().join("");
    names.set(w, `${m[1]} ${m[2]}`);
  }
}
let unexpected = 0;
const expected = new Map();
for (const w of diff) {
  const name = names.get(w) ?? "?";
  const mn = name.split(" ")[0];
  const kwOk = kw.get(w);
  if (!kwOk && (mn === "pmull" || mn === "pmull2") && /\.1q/.test(name)) {
    expected.set(mn, (expected.get(mn) ?? 0) + 1);
    continue;
  }
  unexpected++;
  if (unexpected <= 40) console.log(`LEGALITY ${w} kwemu ${kwOk ? "ok" : "ILLEGAL"} qemu ${kwOk ? "SIGILL" : "runs"}: ${name}`);
}

// 3. results of the words both run
const both = list.filter((w) => kw.get(w) && !qemuIll(w));
// same batches on both sides (simdfptest seeds its states per batch)
const qr = fpMode ? runBatches(qemu, ["-cpu", "cortex-a53"], "w", both, BATCH) : qm;
const km = runBatches(join(prefix, "bin", "kwemu-harness"), [], "w", both, BATCH);
let bad = 0;
for (const w of both) {
  if (km.get(w) === qr.get(w)) continue;
  bad++;
  if (bad <= 40) console.log(`RESULT   ${w} qemu ${qr.get(w)} kwemu ${km.get(w)}${fpMode ? ` (states seed ${seed + Math.floor(both.indexOf(w) / BATCH) * BATCH})` : ""}`);
}

const illBoth = list.filter((w) => !kw.get(w) && qemuIll(w)).length;
console.log(`${words.size} words drawn, ${list.length} routed to simd_arith: ${both.length} run on both (${fpMode ? 48 : 16} states each), ${illBoth} ILLEGAL on both`);
console.log(`expected legality differences (PMULL 1Q): ${[...expected].map(([m, n]) => `${m} ${n}`).join(", ") || "none"}`);
console.log(`unexpected: ${unexpected} legality, ${bad} result`);
process.exit(unexpected || bad ? 1 : 0);
