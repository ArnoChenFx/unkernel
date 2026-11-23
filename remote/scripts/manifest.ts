// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The manifest of a remote release (manifest.json, format 1): every file the
// install holds, with its size, sha256, the archive or upstream file it comes
// from and that file's URL, and the downloadable assets. update.ps1 compares
// the files with the local ones and downloads only the assets that hold a file
// that changed. The archives are named by the hash of their files, so an
// archive whose files did not change keeps its name and its bytes.

import { createHash } from "node:crypto";

export const MANIFEST_FORMAT = 1;

export interface InstallFile {
	/** Relative to the install root, forward slashes. */
	path: string;
	size: number;
	sha256: string;
}

export interface ManifestFile extends InstallFile {
	/** The asset (archive or upstream file) that holds the file. */
	asset: string;
	url: string;
}

export interface Asset {
	name: string;
	kind: "app" | "kernel" | "distro" | "updater";
	size: number;
	sha256: string;
	url: string;
}

export interface Manifest {
	format: typeof MANIFEST_FORMAT;
	product: "unkernel-remote";
	repo: string;
	tag: string;
	commit: string;
	built: string;
	upstream: { repo: string; tag: string; abi: number; base: string };
	assets: Asset[];
	files: ManifestFile[];
}

export function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The hash of a set of files (path, size and sha256 of each, in path order): an archive's name comes from it. */
export function contentHash(files: InstallFile[]): string {
	const h = createHash("sha256");
	for (const f of [...files].sort(byPath)) h.update(`${f.path}\0${f.size}\0${f.sha256}\n`);
	return h.digest("hex");
}

export function archiveName(kind: "app" | "kernel", files: InstallFile[]): string {
	return `unkernel-remote-${kind}-${contentHash(files).slice(0, 16)}.zip`;
}

export function releaseUrl(repo: string, tag: string, name: string): string {
	return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** The name the page's web build serves a distro image under (web/scripts/kernel.ts): name-<first 16 hex of its sha256>.erofs. */
export function servedDistroName(name: string, sha256: string, file: string): string {
	const ext = file.slice(file.lastIndexOf("."));
	return `${name}-${sha256.slice(0, 16)}${ext}`;
}

export interface ManifestInput {
	repo: string;
	tag: string;
	commit: string;
	built: string;
	upstream: { repo: string; tag: string; abi: number; base: string };
	app: { name: string; size: number; sha256: string; files: InstallFile[] };
	kernel: { name: string; size: number; sha256: string; files: InstallFile[] };
	updater: { name: string; size: number; sha256: string }[];
	distros: { name: string; file: string; size: number; sha256: string; served: string }[];
}

/** The manifest of one release: every install file with the asset it comes from, the assets, the upstream release it came with. */
export function buildManifest(input: ManifestInput): Manifest {
	const url = (name: string) => releaseUrl(input.repo, input.tag, name);
	const upstreamUrl = (file: string) => releaseUrl(input.upstream.repo, input.upstream.tag, file);
	const files: ManifestFile[] = [];
	for (const archive of [input.app, input.kernel]) {
		for (const f of archive.files) files.push({ ...f, asset: archive.name, url: url(archive.name) });
	}
	for (const d of input.distros) {
		files.push({ path: `web/.output/public/distros/${d.served}`, size: d.size, sha256: d.sha256, asset: d.file, url: upstreamUrl(d.file) });
	}
	files.sort(byPath);
	const assets: Asset[] = [
		{ name: input.app.name, kind: "app", size: input.app.size, sha256: input.app.sha256, url: url(input.app.name) },
		{ name: input.kernel.name, kind: "kernel", size: input.kernel.size, sha256: input.kernel.sha256, url: url(input.kernel.name) },
		...input.updater.map((u): Asset => ({ name: u.name, kind: "updater", size: u.size, sha256: u.sha256, url: url(u.name) })),
		...input.distros.map((d): Asset => ({ name: d.file, kind: "distro", size: d.size, sha256: d.sha256, url: upstreamUrl(d.file) })),
	];
	return {
		format: MANIFEST_FORMAT,
		product: "unkernel-remote",
		repo: input.repo,
		tag: input.tag,
		commit: input.commit,
		built: input.built,
		upstream: { repo: input.upstream.repo, tag: input.upstream.tag, abi: input.upstream.abi, base: input.upstream.base },
		assets,
		files,
	};
}

export function serializeManifest(m: Manifest): string {
	return `${JSON.stringify(m, null, 2)}\n`;
}

/** Parses and checks a manifest: the format, and that every file names an asset the manifest lists. */
export function parseManifest(text: string): Manifest {
	const m = JSON.parse(text) as Manifest;
	if (m.format !== MANIFEST_FORMAT || m.product !== "unkernel-remote") throw new Error(`manifest: not an unkernel-remote manifest of format ${MANIFEST_FORMAT}`);
	if (!m.tag || !Array.isArray(m.assets) || !Array.isArray(m.files)) throw new Error("manifest: missing tag, assets or files");
	const names = new Set(m.assets.map((a) => a.name));
	for (const f of m.files) {
		if (!names.has(f.asset)) throw new Error(`manifest: ${f.path} names ${f.asset}, which is not an asset`);
		if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`manifest: ${f.path} has no sha256`);
	}
	return m;
}
