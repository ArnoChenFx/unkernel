// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote backend as files for `bun remote/unkernel-remote.js`: the server
// (remote/cli.ts) in one module, and the kernel worker it starts beside itself
// (js/node/worker-entry.ts). The worker's starter names it as
// new URL("./worker-entry.ts", import.meta.url); the bundles are written as
// .js, so that URL is rewritten to match. A secondary CPU's worker is not
// bundled: remote mode runs one CPU.
//
//   bun remote/scripts/bundle.ts <out-dir>

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (!process.argv[2]) throw new Error("usage: bun remote/scripts/bundle.ts <out-dir>");
const outDir = path.resolve(process.argv[2]);

const ENTRIES = [
	{ entry: "remote/cli.ts", out: "unkernel-remote.js" },
	{ entry: "js/node/worker-entry.ts", out: "worker-entry.js" },
];

const WORKER_URL_TEST = /new URL\("\.\/[a-z-]+-entry\.ts", import\.meta\.url\)/;
const WORKER_URL = /new URL\("\.\/([a-z-]+-entry)\.ts", import\.meta\.url\)/g;

const workerUrls: Bun.BunPlugin = {
	name: "remote-worker-urls",
	setup(build) {
		build.onLoad({ filter: /\.ts$/ }, async (args) => {
			const src = await Bun.file(args.path).text();
			if (!WORKER_URL_TEST.test(src)) return undefined;
			return { contents: src.replace(WORKER_URL, 'new URL("./$1.js", import.meta.url)'), loader: "ts" };
		});
	},
};

mkdirSync(outDir, { recursive: true });
for (const { entry, out } of ENTRIES) {
	const result = await Bun.build({
		entrypoints: [path.join(root, entry)],
		target: "bun",
		format: "esm",
		minify: true,
		plugins: [workerUrls],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`bundle: ${entry} did not build`);
	}
	const code = await result.outputs[0]!.text();
	if (/-entry\.ts"/.test(code)) throw new Error(`bundle: ${out} still names a worker .ts file`);
	writeFileSync(path.join(outDir, out), code);
	console.log(`bundle: ${out} ${code.length} bytes (from ${entry})`);
}
