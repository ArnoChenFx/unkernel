// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// remote/update.ps1 against a fixture release server, built with the packer's own
// zip and manifest code: the first install; a re-run with nothing to do; an
// app-only release, which downloads the app archive and nothing else; a corrupt
// download; an unreachable API with and without an installed version; a tampered
// installed file; an unsafe path in the manifest; a lock held by a live process;
// the data directory guard; and the root update.ps1 handing over to the
// installed version. It runs pwsh (or powershell.exe on Windows) and is skipped
// without one. The server lives in this process, so the updater runs as a child
// process and nothing here blocks the event loop.
//
//   node --test remote/test/update.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveName, buildManifest, serializeManifest, sha256Hex, type InstallFile } from "../scripts/manifest.ts";
import { writeZip, type ZipEntry } from "../scripts/zip.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const updaterSource = readFileSync(path.join(repo, "remote", "update.ps1"));
const updaterCmd = readFileSync(path.join(repo, "remote", "update.cmd"));
const UP_TAG = "v0.2.0-test";
const FORK = "owner/fork";
const DISTROS = [
	{ name: "alpine", file: "alpine.erofs", served: "alpine-72a89c2638ec4cb6.erofs", bytes: Buffer.alloc(30_000, 3) },
	{ name: "debian", file: "debian.erofs", served: "debian-08e8344aae97cfa8.erofs", bytes: Buffer.alloc(50_000, 5) },
];

function findPowerShell(): string | null {
	const candidates = [process.env.PWSH, "pwsh", process.platform === "win32" ? "powershell" : undefined];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

const shell = findPowerShell();
const run = shell ? test : test.skip;

const published = new Map<string, Buffer>();
const releases: string[] = [];
const requests: string[] = [];
let base = "";
let server: Server | undefined;
let tmp = "";
let app = "";
let home = "";

function serve(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? "/", "http://fixture");
	requests.push(url.pathname);
	if (url.pathname === `/repos/${FORK}/releases`) {
		const listed = [
			{ tag_name: "remote-v9-draft", draft: true, prerelease: false },
			// Oldest first, with times: the newest is by published_at, whatever the order (the API's is not the publication order).
			...releases.map((tag, i) => ({ tag_name: tag, draft: false, prerelease: false, published_at: new Date(Date.UTC(2026, 10, 24) - i * 3_600_000).toISOString() })).reverse(),
			{ tag_name: "remote-v99-pre", draft: false, prerelease: true, published_at: "2027-01-01T00:00:00Z" },
			{ tag_name: UP_TAG, draft: false, prerelease: false },
		];
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(listed));
		return;
	}
	const m = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
	const body = m ? published.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`) : undefined;
	if (!body) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
	res.end(body);
}

function appFiles(version: string): Record<string, Buffer> {
	return {
		"LICENSE": Buffer.from("license\n"),
		"remote/README.md": Buffer.from(`readme ${version}\n`),
		"remote/start-windows.cmd": Buffer.from("rem stub\n"),
		"remote/start-windows.ps1": Buffer.from("# stub\n"),
		"remote/unkernel-remote.js": Buffer.from(`bundle ${version}\n`),
		"remote/update.cmd": updaterCmd,
		"remote/update.ps1": updaterSource,
		"remote/worker-entry.js": Buffer.from("worker\n"),
		"web/.output/public/index.js": Buffer.from(`page ${version}\n`),
	};
}

function kernelFiles(): Record<string, Buffer> {
	return {
		"web/.output/public/assets/unkernel-AAAAAAAA.wasm": Buffer.alloc(200_000, 7),
		"web/.output/public/assets/virgl-0123456789abcdef/virgl.wasm": Buffer.alloc(40_000, 9),
	};
}

function sorted(files: Record<string, Buffer>): [string, Buffer][] {
	return Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function fileList(files: Record<string, Buffer>): InstallFile[] {
	return sorted(files).map(([p, d]) => ({ path: p, size: d.length, sha256: sha256Hex(d) }));
}

function publish(tag: string, app: Record<string, Buffer>, options: { kernel?: Record<string, Buffer>; corrupt?: boolean } = {}): void {
	const kernel = options.kernel ?? kernelFiles();
	const appZip = writeZip(sorted(app).map(([name, data]): ZipEntry => ({ name, data })));
	const kernelZip = writeZip(sorted(kernel).map(([name, data]): ZipEntry => ({ name, data })));
	const appName = archiveName("app", fileList(app));
	const kernelName = archiveName("kernel", fileList(kernel));
	const manifest = buildManifest({
		repo: FORK,
		tag,
		commit: "c".repeat(40),
		built: "2026-11-23T00:00:00.000Z",
		upstream: { repo: "pithings/unkernel", tag: UP_TAG, abi: 3, base: "base-test" },
		app: { name: appName, size: appZip.length, sha256: sha256Hex(appZip), files: fileList(app) },
		kernel: { name: kernelName, size: kernelZip.length, sha256: sha256Hex(kernelZip), files: fileList(kernel) },
		updater: [
			{ name: "update.ps1", size: updaterSource.length, sha256: sha256Hex(updaterSource) },
			{ name: "update.cmd", size: updaterCmd.length, sha256: sha256Hex(updaterCmd) },
		],
		distros: DISTROS.map((d) => ({ name: d.name, file: d.file, size: d.bytes.length, sha256: sha256Hex(d.bytes), served: d.served })),
	});
	const json = serializeManifest(manifest).replaceAll("https://github.com/", `${base}/`);
	const served = options.corrupt ? Buffer.from(appZip).fill(appZip[100]! ^ 0xff, 100, 101) : appZip;
	published.set(`${tag}/${appName}`, served);
	published.set(`${tag}/${kernelName}`, kernelZip);
	published.set(`${tag}/manifest.json`, Buffer.from(json));
	published.set(`${tag}/update.ps1`, updaterSource);
	published.set(`${tag}/update.cmd`, updaterCmd);
	releases.unshift(tag);
}

function assetsRequested(): string[] {
	return requests
		.filter((p) => p.includes("/releases/download/") && !p.endsWith("/manifest.json"))
		.map((p) => decodeURIComponent(p.split("/").pop()!))
		.sort();
}

function pwsh(args: string[], extraEnv: Record<string, string> = {}): Promise<{ status: number | null; out: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv };
	delete env.USERPROFILE;
	return new Promise((resolve, reject) => {
		const child = spawn(shell!, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (b: Buffer) => (out += b.toString()));
		child.stderr.on("data", (b: Buffer) => (out += b.toString()));
		const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, out });
		});
	});
}

const updater = () => path.join(repo, "remote", "update.ps1");

function updaterArgs(extra: string[] = [], { api = base, noStart = true }: { api?: string; noStart?: boolean } = {}): string[] {
	return [updater(), "-Dir", app, "-Repo", FORK, "-ApiBase", api, "-DownloadBase", base, ...(noStart ? ["-NoStart"] : []), ...extra];
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const address = s.address();
			s.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

function installedFile(version: string, rel: string): string {
	return readFileSync(path.join(app, "versions", version, ...rel.split("/"))).toString();
}

function currentVersion(): string {
	return readFileSync(path.join(app, "current.txt"), "utf8");
}

const appArchive = (files: Record<string, Buffer>) => archiveName("app", fileList(files));
const kernelName = () => archiveName("kernel", fileList(kernelFiles()));

before(async () => {
	if (!shell) return;
	tmp = mkdtempSync(path.join(os.tmpdir(), "unkernel-update-"));
	app = path.join(tmp, "app");
	home = path.join(tmp, "home");
	mkdirSync(home, { recursive: true });
	server = createServer(serve);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	for (const d of DISTROS) published.set(`${UP_TAG}/${d.file}`, d.bytes);
});

after(() => {
	server?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

run("the first run installs the release and downloads each asset once", async () => {
	publish("remote-v1", appFiles("v1"));
	requests.length = 0;
	const r = await pwsh(updaterArgs());
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v1")), kernelName(), "alpine.erofs", "debian.erofs"].sort());
	assert.equal(currentVersion(), "remote-v1");
	for (const [rel, data] of [...sorted(appFiles("v1")), ...sorted(kernelFiles())]) {
		assert.deepEqual(readFileSync(path.join(app, "versions", "remote-v1", ...rel.split("/"))), data, rel);
	}
	for (const d of DISTROS) {
		assert.deepEqual(readFileSync(path.join(app, "versions", "remote-v1", "web", ".output", "public", "distros", d.served)), d.bytes);
	}
	assert.ok(existsSync(path.join(app, "update.ps1")) && existsSync(path.join(app, "update.cmd")), "the launchers are in the install directory");
	assert.deepEqual(readdirSync(path.join(app, "downloads")), []);
	assert.equal(existsSync(path.join(app, "update.lock")), false);
});

run("a re-run with nothing changed downloads nothing", async () => {
	requests.length = 0;
	const r = await pwsh(updaterArgs());
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /up to date: remote-v1/);
	assert.deepEqual(assetsRequested(), []);
});

run("an app-only release downloads the app archive and nothing else", async () => {
	publish("remote-v2", appFiles("v2"), { kernel: kernelFiles() });
	requests.length = 0;
	const check = await pwsh(updaterArgs(["-Check"]));
	assert.equal(check.status, 0, check.out);
	assert.match(check.out, /update available: remote-v1 -> remote-v2, 1 download\(s\)/);
	assert.deepEqual(assetsRequested(), [], "a check downloads no asset");

	requests.length = 0;
	const r = await pwsh(updaterArgs());
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v2"))], "only the app archive");
	assert.equal(currentVersion(), "remote-v2");
	assert.equal(installedFile("remote-v2", "remote/unkernel-remote.js"), "bundle v2\n");
	assert.equal(installedFile("remote-v1", "remote/unkernel-remote.js"), "bundle v1\n", "the previous version stays for a rollback");
});

run("a corrupt download is refused and the running version stays", async () => {
	publish("remote-v3", appFiles("v3"), { corrupt: true });
	requests.length = 0;
	const r = await pwsh(updaterArgs());
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /the update failed: .*does not match its size or sha256/);
	assert.match(r.out, /starting the installed version remote-v2/);
	assert.equal(currentVersion(), "remote-v2");
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v3"))]);
	assert.equal(existsSync(path.join(app, "versions", "remote-v3")), false);
	assert.equal(readdirSync(app).some((n) => n.startsWith("partial-")), false);
	assert.equal(readdirSync(path.join(app, "downloads")).some((n) => n.endsWith(".partial")), false);
});

run("an unreachable API starts the installed version, and a check fails", async () => {
	const dead = `http://127.0.0.1:${await freePort()}`;
	requests.length = 0;
	const started = await pwsh(updaterArgs([], { api: dead }));
	assert.equal(started.status, 0, started.out);
	assert.match(started.out, /the update failed/);
	assert.match(started.out, /starting the installed version remote-v2/);
	assert.deepEqual(assetsRequested(), []);

	const check = await pwsh(updaterArgs(["-Check"], { api: dead, noStart: false }));
	assert.equal(check.status, 1, check.out);
});

run("a tampered installed file is the only thing downloaded again", async () => {
	const file = path.join(app, "versions", "remote-v2", "web", ".output", "public", "index.js");
	rmSync(file);
	writeFileSync(file, "tampered\n");
	requests.length = 0;
	const r = await pwsh(updaterArgs(["-Tag", "remote-v2"]));
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v2"))]);
	assert.equal(installedFile("remote-v2", "web/.output/public/index.js"), "page v2\n");
});

run("-Force reinstalls a release whose files are all present, without downloads", async () => {
	requests.length = 0;
	const r = await pwsh(updaterArgs(["-Tag", "remote-v2", "-Force"]));
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), []);
	assert.equal(currentVersion(), "remote-v2");
});

run("a manifest with an unsafe path is refused before any download", async () => {
	publish("remote-v4", appFiles("v4"));
	const key = "remote-v4/manifest.json";
	published.set(key, Buffer.from(published.get(key)!.toString().replace('"path": "LICENSE"', '"path": "../LICENSE"')));
	requests.length = 0;
	const r = await pwsh(updaterArgs());
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /unsafe path: \.\.\/LICENSE/);
	assert.deepEqual(assetsRequested(), []);
	assert.equal(currentVersion(), "remote-v2");
});

run("a live lock stops a second updater", async () => {
	writeFileSync(path.join(app, "update.lock"), String(process.pid));
	try {
		const r = await pwsh(updaterArgs());
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /another update is running/);
	} finally {
		rmSync(path.join(app, "update.lock"), { force: true });
	}
});

run("the data directory is refused as the install directory", async () => {
	const data = path.join(home, ".unkernel", "remote");
	const r = await pwsh([updater(), "-Dir", data, "-Repo", FORK, "-ApiBase", base, "-DownloadBase", base, "-NoStart"]);
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /must not be the data directory/);
});

run("the install's root update.ps1 hands over to the installed version", async () => {
	requests.length = 0;
	const r = await pwsh([path.join(app, "update.ps1"), "-Check", "-Tag", "remote-v2", "-Dir", app, "-Repo", FORK, "-ApiBase", base, "-DownloadBase", base]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /up to date: remote-v2/);
	assert.deepEqual(assetsRequested(), []);
});
