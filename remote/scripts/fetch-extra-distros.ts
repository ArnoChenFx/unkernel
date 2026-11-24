// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// Fetches this repository's newest distro image release (omarchy-<YYMMDD>-<commit>, made by
// .github/workflows/omarchy-image.yml) into remote/extra-distros/: its distros.json, its images
// (size and sha256 checked) and source.json (the repository and tag, for release.ts's URLs).
// web/scripts/kernel.ts adds them to the page's images (KW_EXTRA_DISTROS) when they were made for
// the page's kwemu ABI and base bundle. No such release is not an error: the release has no extra image.
//
//   node remote/scripts/fetch-extra-distros.ts [--repo owner/name] [--out remote/extra-distros]
//   (GITHUB_TOKEN, if set, is used for the API)

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./manifest.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface Entry { name: string; file: string; size: number; sha256: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; created_at: string; assets: { name: string; browser_download_url: string }[] }

async function get(url: string): Promise<Uint8Array> {
	const headers: Record<string, string> = { "user-agent": "unkernel-remote-release" };
	if (process.env.GITHUB_TOKEN && url.startsWith("https://api.github.com/")) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
	const repo = opt("repo") ?? process.env.GITHUB_REPOSITORY ?? "ArnoChenFx/unkernel";
	const out = path.resolve(root, opt("out") ?? "remote/extra-distros");
	rmSync(out, { recursive: true, force: true });
	const list = JSON.parse(Buffer.from(await get(`https://api.github.com/repos/${repo}/releases?per_page=100`)).toString("utf8")) as Release[];
	const release = list
		.filter((r) => /^omarchy-[0-9A-Za-z._-]+$/.test(r.tag_name) && !r.draft && !r.prerelease)
		.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
	if (!release) { console.log(`extra distros: ${repo} has no omarchy-* release; none added`); return; }
	const url = (name: string) => release.assets.find((a) => a.name === name)?.browser_download_url;
	const indexUrl = url("distros.json");
	if (!indexUrl) { console.log(`extra distros: ${release.tag_name} has no distros.json; none added`); return; }
	const indexBytes = await get(indexUrl);
	const index = JSON.parse(Buffer.from(indexBytes).toString("utf8")) as { distros: Entry[] };
	mkdirSync(out, { recursive: true });
	for (const d of index.distros) {
		const u = url(d.file);
		if (!u) throw new Error(`${release.tag_name}: distros.json names ${d.file}, which the release does not have`);
		const bytes = await get(u);
		if (bytes.length !== d.size || sha256Hex(bytes) !== d.sha256) throw new Error(`${release.tag_name}: ${d.file} does not match distros.json`);
		writeFileSync(path.join(out, d.file), bytes);
		console.log(`extra distros: ${release.tag_name}: ${d.file} ${(d.size / 1048576).toFixed(1)} MiB, sha256 ${d.sha256.slice(0, 16)}`);
	}
	writeFileSync(path.join(out, "distros.json"), indexBytes);
	writeFileSync(path.join(out, "source.json"), `${JSON.stringify({ repo, tag: release.tag_name })}\n`);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
