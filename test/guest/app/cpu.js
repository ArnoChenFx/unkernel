// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A CPU workload for Node and Bun in the guest (test/app-bench.sh): numbers,
// strings, objects, a Map and a sort, N rounds (default 100). Prints a
// checksum, the same for a given N on every runtime.
const n = Number(process.argv[2] || 100);
let sum = 0;
for (let r = 0; r < n; r++) {
	// numbers: an LCG and a float accumulation
	let x = (r * 2654435761) >>> 0, f = 0;
	for (let i = 0; i < 20000; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		f += Math.sqrt(x & 0xffff) * 0.5;
	}
	sum = (sum + x + (f | 0)) >>> 0;
	// strings: build, split, join, search
	const words = [];
	for (let i = 0; i < 400; i++) words.push("w" + ((x + i * 7919) % 9973).toString(36));
	const text = words.join(" ");
	const parts = text.split(" ").map((w) => w.toUpperCase());
	sum = (sum + text.length + parts.filter((w) => w.includes("A")).length + text.indexOf("w1")) >>> 0;
	// objects and JSON
	const objs = [];
	for (let i = 0; i < 300; i++) objs.push({ id: i, name: words[i], tags: [i % 7, i % 11], score: (x >>> (i % 16)) & 255 });
	const back = JSON.parse(JSON.stringify(objs));
	for (const o of back) sum = (sum + o.score + o.tags[1] + o.name.length) >>> 0;
	// a Map and a sort
	const m = new Map();
	for (const w of words) m.set(w, (m.get(w) || 0) + 1);
	const keys = [...m.keys()].sort();
	back.sort((a, b) => a.score - b.score || a.id - b.id);
	sum = (sum + m.size + keys[0].length + back[0].id + back[back.length - 1].id) >>> 0;
}
console.log(sum);
