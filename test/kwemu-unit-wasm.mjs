// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Runs the kwemu unit tests built as wasm64 with the JIT tier
// (src/tests_a64_wasm.zig + src/test_runner_wasm.zig, run by `zig build
// test`) against an eager JS JIT host, and checks the host's slot bookkeeping:
// every compile goes into a free slot, every free into an installed one,
// no module fails to compile, and nothing is left installed at the end
// (each test's Machine.deinit resets the block cache).
// usage: node test/kwemu-unit-wasm.mjs <unit-test.wasm> [--name NAME]
//   --name: the label in the output (default a64)
import { readFile } from "node:fs/promises";
import { createJitHost } from "./kwemu-jit-host.mjs";

const dec = new TextDecoder();
const jit = createJitHost({ eager: true, strict: true });
const name = process.argv.includes("--name") ? process.argv[process.argv.indexOf("--name") + 1] : "a64";
let mem, out = "";
const { instance } = await WebAssembly.instantiate(await readFile(process.argv[2]), {
  env: {
    host_write: (fd, ptr, len) => {
      const s = dec.decode(new Uint8Array(mem.buffer, Number(ptr), Number(len)));
      if (fd === 2) process.stderr.write(s);
      else out += s;
    },
  },
  unkernel: jit.imports,
});
mem = instance.exports.memory;
jit.attach(instance.exports);
let failed;
try {
  failed = instance.exports.run_tests();
} catch (e) {
  const last = out.split("\n").pop().split("\t")[0];
  console.log(`FAIL ${name} unit (wasm64+jit): trapped in "${last}": ${e.message}`);
  process.exit(1);
}
const lines = out.trim().split("\n").map((l) => l.split("\t"));
for (const [test, st] of lines) console.log(`${(st.startsWith("FAIL") ? st : st.padEnd(4))} wasm64+jit ${test}`);
const n = (p) => lines.filter(([, st]) => st?.startsWith(p)).length;
const s = jit.stats;
console.log(`${name} unit (wasm64+jit): ${n("ok")} passed, ${n("skip")} skipped, ${failed} failed; ` +
  `host: ${s.compiles} compiles, ${s.frees} frees, ${s.failures} compile failures, ${jit.installed()} left installed, ` +
  `${(Number(s.compileNs) / 1e6).toFixed(0)} ms compiling ${(s.bytes / 1024).toFixed(0)} KiB`);
for (const e of s.errors) console.log(`FAIL jit host: ${e}`);
if (jit.installed()) console.log("FAIL jit host: slots left installed");
if (failed || s.errors.length || jit.installed() || s.compiles === 0) process.exit(1);
