// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote release manifest (remote/scripts/manifest.ts): the archive names
// come from the content they hold, every install file names an asset and its
// URL, the distro images point at upstream, and parseManifest refuses what
// update.ps1 could not install.
//
//   node --test remote/test/manifest.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { archiveName, buildManifest, contentHash, parseManifest, releaseUrl, serializeManifest, servedDistroName, sha256Hex, type InstallFile, type ManifestInput } from "../scripts/manifest.ts";

const file = (path: string, text: string): InstallFile => ({ path, size: text.length, sha256: sha256Hex(new TextEncoder().encode(text)) });

const KERNEL = [file("web/.output/public/assets/unkernel-AAAAAAAA.wasm", "kernel"), file("web/.output/public/assets/virgl-0123456789abcdef/virgl.wasm", "gl")];
const DEBIAN = { name: "debian", file: "debian.erofs", size: 72749056, sha256: "08e8344aae97cfa8b31226da553fe409e39592790d8ac5ddb9928f4530251587" };

function input(app: InstallFile[]): ManifestInput {
	const appArchive = archiveName("app", app);
	const kernelArchive = archiveName("kernel", KERNEL);
	return {
		repo: "owner/fork",
		tag: "remote-v1",
		commit: "a".repeat(40),
		built: "2026-11-23T00:00:00.000Z",
		upstream: { repo: "pithings/unkernel", tag: "v0.2.0-261123-8f039c5", abi: 3, base: "base-67d2aabad8b73f64" },
		app: { name: appArchive, size: 1000, sha256: sha256Hex(new TextEncoder().encode(appArchive)), files: app },
		kernel: { name: kernelArchive, size: 2000, sha256: sha256Hex(new TextEncoder().encode(kernelArchive)), files: KERNEL },
		updater: [{ name: "update.ps1", size: 10, sha256: "b".repeat(64) }],
		distros: [{ ...DEBIAN, served: servedDistroName(DEBIAN.name, DEBIAN.sha256, DEBIAN.file) }],
	};
}

test("the content hash does not depend on the order of the files", () => {
	const a = [file("remote/a.js", "1"), file("web/b.mjs", "2")];
	assert.equal(contentHash(a), contentHash([...a].reverse()));
});

test("an archive's name changes with its files and only with them", () => {
	const app = [file("remote/unkernel-remote.js", "server")];
	const changed = [file("remote/unkernel-remote.js", "server, fixed")];
	assert.notEqual(archiveName("app", app), archiveName("app", changed));
	assert.equal(archiveName("app", app), archiveName("app", [...app]));
	assert.match(archiveName("kernel", KERNEL), /^unkernel-remote-kernel-[0-9a-f]{16}\.zip$/);
});

test("a release that changes only the app keeps the kernel archive's name", () => {
	const first = buildManifest(input([file("remote/unkernel-remote.js", "v1")]));
	const second = buildManifest(input([file("remote/unkernel-remote.js", "v2")]));
	const kernelName = (m: typeof first) => m.assets.find((a) => a.kind === "kernel")!.name;
	assert.equal(kernelName(first), kernelName(second));
	assert.notEqual(first.assets.find((a) => a.kind === "app")!.name, second.assets.find((a) => a.kind === "app")!.name);
});

test("every install file names an asset, and the URLs are the release's or upstream's", () => {
	const m = buildManifest(input([file("remote/unkernel-remote.js", "server"), file("web/.output/public/index.js", "page")]));
	const names = new Set(m.assets.map((a) => a.name));
	assert.deepEqual(m.files.map((f) => f.path), [...m.files.map((f) => f.path)].sort());
	for (const f of m.files) {
		assert.ok(names.has(f.asset), `${f.path} names ${f.asset}`);
		assert.ok(f.url.startsWith(f.asset.startsWith("unkernel-remote-") ? "https://github.com/owner/fork/releases/download/remote-v1/" : "https://github.com/pithings/unkernel/releases/download/v0.2.0-261123-8f039c5/"), f.url);
	}
	const distro = m.files.find((f) => f.path.startsWith("web/.output/public/distros/"))!;
	assert.equal(distro.path, "web/.output/public/distros/debian-08e8344aae97cfa8.erofs");
	assert.equal(distro.asset, "debian.erofs");
	assert.equal(m.assets.find((a) => a.kind === "updater")!.url, "https://github.com/owner/fork/releases/download/remote-v1/update.ps1");
});

test("the manifest parses back and refuses a file without an asset", () => {
	const m = buildManifest(input([file("remote/unkernel-remote.js", "server")]));
	assert.deepEqual(parseManifest(serializeManifest(m)), m);
	const broken = { ...m, files: [...m.files, { ...m.files[0]!, path: "x", asset: "missing.zip" }] };
	assert.throws(() => parseManifest(JSON.stringify(broken)), /not an asset/);
	assert.throws(() => parseManifest(JSON.stringify({ ...m, format: 2 })), /format/);
});

test("the served distro name is the upstream name and the first 16 hex of its sha256", () => {
	assert.equal(servedDistroName("alpine", "72a89c2638ec4cb69767b2071d9a3492134cb00c00168c5c32a932859524ae7f", "alpine.erofs"), "alpine-72a89c2638ec4cb6.erofs");
});

test("release URLs encode the tag and the file name", () => {
	assert.equal(releaseUrl("o/r", "remote-v1 beta", "a b.zip"), "https://github.com/o/r/releases/download/remote-v1%20beta/a%20b.zip");
});

test("an extra distro with a url is listed under that url, not upstream's", () => {
	const base = input([file("remote/unkernel-remote.js", "server")]);
	const url = "https://github.com/owner/fork/releases/download/omarchy-1/omarchy.erofs";
	const extra = { name: "omarchy", file: "omarchy.erofs", size: 5, sha256: "c".repeat(64), served: servedDistroName("omarchy", "c".repeat(64), "omarchy.erofs"), url };
	const m = buildManifest({ ...base, distros: [...base.distros, extra] });
	assert.equal(m.files.find((f) => f.asset === "omarchy.erofs")!.url, url);
	assert.equal(m.assets.find((a) => a.name === "omarchy.erofs")!.url, url);
	assert.equal(m.assets.find((a) => a.name === "omarchy.erofs")!.kind, "distro");
	assert.equal(parseManifest(serializeManifest(m)).files.length, m.files.length);
});
