// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Host side of kwemu's optional JIT imports (src/emu/jit.zig), for the
// tests and benchmarks: compiles each module synchronously against the
// instance's memory and installs its "f" into the requested slot of the
// exported __indirect_function_table (table64: BigInt indices), saving the
// stub that was there; kw_host_jit_free puts the stub back.
//
//   const jit = createJitHost({ eager, mem32, strict });
//   instantiate(..., { unkernel: jit.imports, ... }); jit.attach(instance.exports);
//
// available: caps bit 0 (false: kwemu never compiles, the interpreter alone
// runs); eager: caps bit 2 (compile on first entry); mem32: caps bit 1 (the module
// was lowered with wasm-opt --memory64-lowering); strict: a compile into a
// slot that is already installed is an error (it is legal after a second
// kw_cpu_init, which forgets its slots). Errors are collected in stats.errors.
export function createJitHost({ available = true, eager = false, mem32 = false, strict = false } = {}) {
  let mem, table, big = true;
  const saved = new Map();
  const stats = { compiles: 0, frees: 0, failures: 0, bytes: 0, compileNs: 0n, errors: [] };
  const idx = (slot) => (big ? BigInt(slot) : slot);
  const imports = {
    kw_host_jit_caps: () => (available ? 1 : 0) | (mem32 ? 2 : 0) | (eager ? 4 : 0),
    kw_host_jit_compile(ptr, len, slot) {
      const t0 = process.hrtime.bigint();
      try {
        if (!table) throw new Error("the module does not export __indirect_function_table");
        const bytes = new Uint8Array(mem.buffer, Number(ptr), Number(len)).slice();
        const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: mem } });
        if (saved.has(slot)) {
          if (strict) stats.errors.push(`compile into installed slot ${slot}`);
        } else saved.set(slot, table.get(idx(slot)));
        table.set(idx(slot), inst.exports.f);
        stats.compiles++;
        stats.bytes += Number(len);
        return 0;
      } catch (e) {
        stats.failures++;
        if (stats.errors.length < 20) stats.errors.push(`compile failed (slot ${slot}, ${Number(len)} bytes): ${e.message}`);
        return -1;
      } finally {
        stats.compileNs += process.hrtime.bigint() - t0;
      }
    },
    kw_host_jit_free(slot) {
      if (!saved.has(slot)) {
        stats.errors.push(`free of slot ${slot} that is not installed`);
        return;
      }
      table.set(idx(slot), saved.get(slot));
      saved.delete(slot);
      stats.frees++;
    },
  };
  return {
    imports,
    stats,
    installed: () => saved.size,
    attach(exports) {
      mem = exports.memory;
      table = exports.__indirect_function_table; // needed once kwemu compiles
      big = typeof table?.length === "bigint";
    },
  };
}
