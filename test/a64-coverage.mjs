// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A64 coverage: which instruction encodings that real programs execute the
// interpreter still rejects as ILLEGAL, per decode group (src/a64/*.zig
// file) and per mnemonic. The report is plain sorted text, stable between
// runs, so two reports diff cleanly.
//
// Corpora are distinct raw instruction words with a qemu disassembly, one
// per line: "<8 hex digits> <mnemonic> <operands>". Build them from
// qemu-aarch64 traces:
//   qemu-aarch64 -L <aarch64 rootfs> -d in_asm,nochain -D trace.log <program> [args]
//   node test/a64-coverage.mjs --import sh=trace.log [name=log ...]
// which writes vendor/a64-corpus/<name>.txt (vendor/ is not committed).
// A static corpus (every instruction in a binary, run or not) imports the
// same way from `llvm-objdump -d <aarch64 binary> > file.dis`.
// Then:
//   zig build && node test/a64-coverage.mjs [corpus.txt ...]
// (default: every vendor/a64-corpus/*.txt). Options: --words (list every
// ILLEGAL word, not one example per mnemonic), --classify <path> (the
// kwemu-a64-classify binary; default zig-out/bin/kwemu-a64-classify).
import { readFile, writeFile, readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const corpusDir = join(root, "vendor", "a64-corpus");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};

// ---- import: qemu in_asm logs -> corpora ----------------------------------------
const imports = [];
for (let v; (v = opt("--import")) !== null;) imports.push(v);
if (imports.length) {
  await mkdir(corpusDir, { recursive: true });
  for (const spec of imports) {
    const eq = spec.indexOf("=");
    if (eq < 0) throw new Error(`--import wants name=trace.log, got ${spec}`);
    const name = spec.slice(0, eq), log = spec.slice(eq + 1);
    const words = new Map();
    for (const line of (await readFile(log, "utf8")).split("\n")) {
      // qemu "0xADDR:  WORD  mnemonic ops" or llvm-objdump "  ADDR: WORD \tmnemonic\tops"
      const m = /^\s*(?:0x)?[0-9a-f]+:\s+([0-9a-f]{8})\s+(\S+)\s*(.*?)\s*$/.exec(line);
      if (!m || m[2] === "<unknown>" || m[2] === "udf" || m[2].startsWith(".")) continue;
      if (!words.has(m[1])) words.set(m[1], `${m[2]} ${m[3].replace(/\s+/g, " ")}`.trim());
    }
    const lines = [...words].sort(([a], [b]) => (a < b ? -1 : 1)).map(([w, d]) => `${w} ${d}`);
    await writeFile(join(corpusDir, `${name}.txt`), lines.join("\n") + "\n");
    console.log(`${name}: ${lines.length} distinct words -> ${join(corpusDir, `${name}.txt`)}`);
  }
  process.exit(0);
}

// ---- report ----------------------------------------------------------------------
const showWords = flag("--words");
const classify = resolve(opt("--classify") ?? join(root, "zig-out", "bin", "kwemu-a64-classify"));
let files = argv.map((f) => resolve(f));
if (!files.length) {
  try {
    files = (await readdir(corpusDir)).filter((f) => f.endsWith(".txt")).sort().map((f) => join(corpusDir, f));
  } catch {}
}
if (!files.length) {
  console.error(`no corpora: give files, or build ${corpusDir} with --import (see the header of this script)`);
  process.exit(2);
}

/** word -> { desc, mn, corpora:Set } */
const words = new Map();
const perCorpus = [];
for (const f of files) {
  const name = basename(f, ".txt");
  const list = [];
  for (const line of (await readFile(f, "utf8")).split("\n")) {
    const m = /^([0-9a-f]{8})\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    list.push(m[1]);
    const e = words.get(m[1]) ?? { desc: m[2], mn: (m[2].split(/\s+/)[0] || "?"), corpora: new Set() };
    e.corpora.add(name);
    words.set(m[1], e);
  }
  perCorpus.push({ name, list });
}

const dir = await mkdtemp(join(tmpdir(), "a64-cov-"));
const input = join(dir, "words.txt");
await writeFile(input, [...words.keys()].join("\n") + "\n");
const p = spawnSync(classify, [input], { encoding: "utf8", maxBuffer: 1 << 30 });
await rm(dir, { recursive: true, force: true });
if (p.status !== 0) {
  console.error(`${classify} failed (zig build first?): ${p.error ?? p.stderr}`);
  process.exit(1);
}
for (const line of p.stdout.split("\n")) {
  const [w, group, st] = line.split(" ");
  if (!w) continue;
  const e = words.get(w);
  e.group = group;
  e.ok = st === "ok";
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0.0").padStart(5) + "%";
const out = [];
out.push("# A64 coverage: distinct instruction words the interpreter rejects as ILLEGAL");
out.push("");
out.push("## per corpus");
for (const { name, list } of perCorpus) {
  const ill = list.filter((w) => !words.get(w).ok).length;
  out.push(`${name.padEnd(16)} ${String(list.length).padStart(6)} words ${String(ill).padStart(6)} ILLEGAL ${pct(ill, list.length)}`);
}
const all = [...words.values()];
const illAll = all.filter((e) => !e.ok).length;
out.push(`${"all".padEnd(16)} ${String(all.length).padStart(6)} words ${String(illAll).padStart(6)} ILLEGAL ${pct(illAll, all.length)}`);

const groups = [...new Set(all.map((e) => e.group))].sort();
out.push("");
out.push("## per group (all corpora)");
for (const g of groups) {
  const es = all.filter((e) => e.group === g);
  const ill = es.filter((e) => !e.ok);
  const mns = new Set(ill.map((e) => e.mn));
  out.push(`${g.padEnd(12)} ${String(es.length).padStart(6)} words ${String(ill.length).padStart(6)} ILLEGAL ${pct(ill.length, es.length)} ${String(mns.size).padStart(4)} mnemonics`);
}

out.push("");
out.push("## ILLEGAL by group and mnemonic: illegal/total words, corpora, example");
for (const g of groups) {
  const es = all.filter((e) => e.group === g);
  const byMn = new Map();
  for (const e of es) {
    const m = byMn.get(e.mn) ?? { mn: e.mn, total: 0, ill: [], corpora: new Set() };
    m.total++;
    if (!e.ok) {
      m.ill.push(e);
      for (const c of e.corpora) m.corpora.add(c);
    }
    byMn.set(e.mn, m);
  }
  const rows = [...byMn.values()].filter((m) => m.ill.length).sort((a, b) => b.ill.length - a.ill.length || (a.mn < b.mn ? -1 : 1));
  if (!rows.length) continue;
  out.push(`### ${g} (${rows.length} mnemonics)`);
  for (const m of rows) {
    const ex = [...words].find(([, e]) => e === m.ill[0])[0];
    out.push(`${m.mn.padEnd(10)} ${`${m.ill.length}/${m.total}`.padStart(9)}  ${[...m.corpora].sort().join(",").padEnd(28)} ${ex} ${m.ill[0].desc}`);
    if (showWords) for (const e of m.ill.slice(1)) out.push(`${"".padEnd(10)} ${"".padStart(9)}  ${"".padEnd(28)} ${[...words].find(([, x]) => x === e)[0]} ${e.desc}`);
  }
}
console.log(out.join("\n"));
