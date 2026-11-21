// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Writes a TypeScript file of about 0.5 MB for `bun build` (test/app-bench.sh).
const out = [];
for (let i = 0; i < 2600; i++) {
	out.push(`export interface Item${i} { id: number; name: string; tags: string[]; next?: Item${i} }`);
	out.push(`export function make${i}(id: number, name = "n${i}"): Item${i} { const tags: string[] = []; for (let k = 0; k < ${i % 5}; k++) tags.push(name + k); return { id: id + ${i}, name, tags }; }`);
}
out.push("let total = 0;");
for (let i = 0; i < 2600; i += 13) out.push(`total += make${i}(${i}).id;`);
out.push("console.log(total);");
require("fs").writeFileSync(process.argv[2], out.join("\n") + "\n");
