// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote release, from a web build (`pnpm build:web`, whose kernel comes
// from the upstream release in web/kernel/release) and the backend bundle
// (bundle.ts, run with Bun). It writes, into the output directory:
//   unkernel-remote-app-<hash>.zip     the backend, the page, the updater and the docs
//   unkernel-remote-kernel-<hash>.zip  the page's kernel, GL renderer and Vulkan translator
//   manifest.json                      every install file, its asset and URL; the assets
//   update.ps1, update.cmd, update.sh, start.sh  the updater on its own (the first download)
//   release-notes.md, assets.txt       for the GitHub release (remote-release.yml)
// The distro images are not archived: the manifest refers to their upstream
// release, and the updater downloads them from there. install/ is the same
// files laid out as an install, for smoke.ts.
//
//   node remote/scripts/release.ts --tag remote-v1 [--repo owner/name] [--commit sha] [--out remote/dist]

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveName, buildManifest, releaseUrl, serializeManifest, servedDistroName, sha256Hex, type InstallFile, type Manifest } from "./manifest.ts";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UPSTREAM_REPO = "pithings/unkernel";
const DEFAULT_REPO = "ArnoChenFx/unkernel";
const PUBLIC = "web/.output/public";
const SERVER_TEMPLATE = "web/.output/server/_chunks/renderer-template.mjs";
const PRECOMPRESSED = /\.(?:br|gz|zst)$/;
const KERNEL_FILE = /^web\/\.output\/public\/assets\/unkernel(?:-smp)?-[A-Za-z0-9_-]+\.wasm$/;
const GL_FILE = /^web\/\.output\/public\/assets\/virgl-[0-9a-f]+\//;
const VK_FILE = /^web\/\.output\/public\/assets\/kwvk-naga-[0-9a-f]{16}\.wasm$/;
const DISTRO_FILE = /^web\/\.output\/public\/distros\//;
const ROOT_FILES = ["LICENSE", "LICENSE-MIT"];
const REMOTE_FILES = ["start-windows.ps1", "start-windows.cmd", "unkernel-remote.example.json", "README.md", "update.ps1", "update.cmd", "update.sh", "start.sh", "start-omarchy.ps1", "start-omarchy.cmd", "start-omarchy.sh", "omarchy-desktop.cmd", "omarchy-desktop.sh"];
const BUNDLE_FILES = ["unkernel-remote.js", "worker-entry.js", "kiosk.js"];
const UPDATER_FILES = ["update.ps1", "update.cmd", "update.sh", "start.sh"];

interface UpstreamRelease {
	tag: string;
	abi: number;
	baseId: string;
	distros: { name: string; file: string; size: number; sha256: string }[];
}

interface Staged {
	rel: string;
	src: string;
	part: "app" | "kernel" | "distro";
}

function usage(): never {
	throw new Error("usage: node remote/scripts/release.ts --tag remote-v<...> [--repo owner/name] [--commit sha] [--out dir]");
}

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function parseArgs(argv: string[]) {
	const opts = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (!key?.startsWith("--") || value === undefined) usage();
		opts.set(key.slice(2), value);
	}
	const tag = opts.get("tag");
	if (!tag || !/^remote-v[0-9A-Za-z._-]+$/.test(tag)) usage();
	return {
		tag,
		repo: opts.get("repo") ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO,
		commit: opts.get("commit") ?? process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]),
		out: path.resolve(root, opts.get("out") ?? "remote/dist"),
		built: opts.get("built") ?? new Date().toISOString(),
	};
}

function walk(dir: string, rel = ""): string[] {
	const out: string[] = [];
	const entries = readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const e of entries) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walk(dir, r));
		else if (e.isFile()) out.push(r);
	}
	return out;
}

/** The files a server module imports, transitively, by relative path (the page's renderer template and its helpers). */
function importClosure(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (rel: string) => {
		if (seen.has(rel)) return;
		seen.add(rel);
		const text = readFileSync(path.join(root, rel), "utf8");
		for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)"(\.{1,2}\/[^"]+)"/g)) {
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]!));
			if (!existsSync(path.join(root, target))) throw new Error(`${rel} imports ${m[1]}, which the web build does not have`);
			visit(target);
		}
	};
	visit(entry);
	return [...seen].sort();
}

function sha256File(file: string): string {
	return sha256Hex(readFileSync(file));
}

function readUpstream(): UpstreamRelease {
	const file = path.join(root, "web/kernel/release/release.json");
	if (!existsSync(file)) throw new Error("web/kernel/release/release.json is missing: run pnpm build:web first");
	return JSON.parse(readFileSync(file, "utf8")) as UpstreamRelease;
}

function describe(bytes: number): string {
	return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * The images of remote/extra-distros/ (fetch-extra-distros.ts) that the web build took into the page
 * (kernel.ts leaves out one made for another base bundle): each with its URL in this repository's release.
 */
function extraDistros() {
	const dir = path.join(root, "remote/extra-distros");
	if (!existsSync(path.join(dir, "distros.json")) || !existsSync(path.join(dir, "source.json"))) return [];
	const index = JSON.parse(readFileSync(path.join(dir, "distros.json"), "utf8")) as { distros: UpstreamRelease["distros"] };
	const source = JSON.parse(readFileSync(path.join(dir, "source.json"), "utf8")) as { repo: string; tag: string };
	const out = [];
	for (const d of index.distros) {
		const served = servedDistroName(d.name, d.sha256, d.file);
		const src = path.join(root, PUBLIC, "distros", served);
		if (!existsSync(src)) {
			console.log(`extra distro ${d.name}: not in the web build; left out of the manifest`);
			continue;
		}
		if (statSync(src).size !== d.size || sha256File(src) !== d.sha256) throw new Error(`${served} does not match ${source.tag}'s distros.json (${d.file})`);
		out.push({ ...d, served, url: releaseUrl(source.repo, source.tag, d.file) });
	}
	return out;
}

function main(): void {
	const opts = parseArgs(process.argv.slice(2));
	const upstream = readUpstream();
	const { out } = opts;
	rmSync(out, { recursive: true, force: true });
	const bundleDir = path.join(out, "bundle");
	const install = path.join(out, "install");
	mkdirSync(bundleDir, { recursive: true });

	if (!existsSync(path.join(root, SERVER_TEMPLATE))) throw new Error(`${SERVER_TEMPLATE} is missing: run pnpm build:web first`);
	execFileSync(process.env.BUN ?? "bun", [path.join(root, "remote/scripts/bundle.ts"), bundleDir], { cwd: root, stdio: "inherit" });

	const distros: ((typeof upstream.distros)[number] & { served: string; url?: string })[] = upstream.distros.map((d) => {
		const served = servedDistroName(d.name, d.sha256, d.file);
		const src = path.join(root, PUBLIC, "distros", served);
		if (!existsSync(src)) throw new Error(`${PUBLIC}/distros/${served} is missing: the web build did not place ${d.file}`);
		if (statSync(src).size !== d.size || sha256File(src) !== d.sha256) throw new Error(`${served} does not match the upstream release (${d.file})`);
		return { ...d, served };
	});

	distros.push(...extraDistros());

	const staged: Staged[] = [];
	for (const f of BUNDLE_FILES) staged.push({ rel: `remote/${f}`, src: path.join(bundleDir, f), part: "app" });
	for (const f of REMOTE_FILES) staged.push({ rel: `remote/${f}`, src: path.join(root, "remote", f), part: "app" });
	for (const f of ROOT_FILES) staged.push({ rel: f, src: path.join(root, f), part: "app" });
	for (const rel of walk(path.join(root, PUBLIC))) {
		const r = `${PUBLIC}/${rel}`;
		if (PRECOMPRESSED.test(r) || DISTRO_FILE.test(r)) continue;
		staged.push({ rel: r, src: path.join(root, r), part: KERNEL_FILE.test(r) || GL_FILE.test(r) || VK_FILE.test(r) ? "kernel" : "app" });
	}
	for (const rel of importClosure(SERVER_TEMPLATE)) staged.push({ rel, src: path.join(root, rel), part: "app" });
	for (const d of distros) staged.push({ rel: `${PUBLIC}/distros/${d.served}`, src: path.join(root, PUBLIC, "distros", d.served), part: "distro" });
	staged.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

	const hashed = new Map<string, { data: Buffer; file: InstallFile }>();
	for (const s of staged) {
		if (hashed.has(s.rel)) throw new Error(`release: ${s.rel} is staged twice`);
		const data = readFileSync(s.src);
		hashed.set(s.rel, { data, file: { path: s.rel, size: data.length, sha256: sha256Hex(data) } });
	}
	for (const s of staged) {
		const dst = path.join(install, s.rel);
		mkdirSync(path.dirname(dst), { recursive: true });
		copyFileSync(s.src, dst);
	}

	const partFiles = (part: Staged["part"]) => staged.filter((s) => s.part === part).map((s) => hashed.get(s.rel)!.file);
	const appFiles = partFiles("app");
	const kernelFiles = partFiles("kernel");
	const appName = archiveName("app", appFiles);
	const kernelName = archiveName("kernel", kernelFiles);
	const archives = [
		{ name: appName, staged: staged.filter((s) => s.part === "app") },
		{ name: kernelName, staged: staged.filter((s) => s.part === "kernel") },
	];
	const built = new Map<string, Buffer>();
	for (const a of archives) {
		const entries: ZipEntry[] = a.staged.map((s) => ({ name: s.rel, data: hashed.get(s.rel)!.data }));
		const zip = writeZip(entries);
		const back = readZip(zip);
		if (back.length !== entries.length) throw new Error(`release: ${a.name} lost entries`);
		for (const e of back) {
			const want = hashed.get(e.name);
			if (!want || sha256Hex(e.data) !== want.file.sha256) throw new Error(`release: ${a.name} does not hold ${e.name} as staged`);
		}
		writeFileSync(path.join(out, a.name), zip);
		built.set(a.name, zip);
	}

	const updater = UPDATER_FILES.map((name) => {
		const data = readFileSync(path.join(root, "remote", name));
		writeFileSync(path.join(out, name), data);
		return { name, size: data.length, sha256: sha256Hex(data) };
	});

	const manifest: Manifest = buildManifest({
		repo: opts.repo,
		tag: opts.tag,
		commit: opts.commit,
		built: opts.built,
		upstream: { repo: UPSTREAM_REPO, tag: upstream.tag, abi: upstream.abi, base: upstream.baseId },
		app: { name: appName, size: built.get(appName)!.length, sha256: sha256Hex(built.get(appName)!), files: appFiles },
		kernel: { name: kernelName, size: built.get(kernelName)!.length, sha256: sha256Hex(built.get(kernelName)!), files: kernelFiles },
		updater,
		distros: distros.map((d) => ({ name: d.name, file: d.file, size: d.size, sha256: d.sha256, served: d.served, ...("url" in d ? { url: d.url } : {}) })),
	});
	writeFileSync(path.join(out, "manifest.json"), serializeManifest(manifest));

	const assets = [appName, kernelName, "manifest.json", ...UPDATER_FILES];
	writeFileSync(path.join(out, "assets.txt"), `${assets.join("\n")}\n`);
	writeFileSync(path.join(out, "release-notes.md"), releaseNotes(manifest, opts.repo, opts.commit));

	for (const a of manifest.assets) console.log(`${String(a.size).padStart(12)}  ${a.kind.padEnd(8)} ${a.name}`);
	const plain = (part: Staged["part"]) => staged.filter((s) => s.part === part).reduce((n, s) => n + hashed.get(s.rel)!.data.length, 0);
	console.log(`files: ${manifest.files.length} in the install (app ${appFiles.length}, kernel ${kernelFiles.length}, distro ${distros.length}); uncompressed app ${describe(plain("app"))}, kernel ${describe(plain("kernel"))}, distros ${describe(plain("distro"))}`);
	console.log(`release ${opts.tag} for ${opts.repo} at ${opts.commit.slice(0, 12)}, upstream ${upstream.tag}; written to ${out}`);
}

function releaseNotes(m: Manifest, repo: string, commit: string): string {
	const row = (a: Manifest["assets"][number]) => `| \`${a.name}\` | ${a.kind} | ${a.size} | \`${a.sha256.slice(0, 16)}\` |`;
	return [
		`# Remote ${m.tag}`,
		"",
		`Built from [\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit}) with the kernel of upstream release [${m.upstream.tag}](https://github.com/${m.upstream.repo}/releases/tag/${m.upstream.tag}).`,
		"",
		"Windows: run `update.ps1` (or `update.cmd`) with Bun installed. It installs this release under `%USERPROFILE%\\.unkernel\\app` and starts the backend; later runs update only the files that changed. See `remote/README.md`.",
		"",
		`Linux and macOS (Bun 1.4.5 or newer): \`curl -fsSL https://github.com/${repo}/releases/latest/download/update.sh | sh\` installs this release under \`~/.unkernel/app\` and starts the backend; run \`~/.unkernel/app/update.sh\` again to update, or \`~/.unkernel/app/start.sh\` to start without updating.`,
		"",
		"| Asset | Kind | Bytes | sha256 |",
		"| --- | --- | ---: | --- |",
		...m.assets.map(row),
		"",
		"The distro images are not in this release: the manifest names their upstream release URLs and hashes, and the updater downloads them from there.",
		"",
	].join("\n");
}

main();
