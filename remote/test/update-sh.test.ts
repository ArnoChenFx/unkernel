// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// remote/update.sh and remote/start.sh against a fixture release server, built
// with the packer's own zip and manifest code, like update.test.ts does for
// update.ps1: the first install; a re-run with nothing to do; an app-only
// release, which downloads the app archive and nothing else; a corrupt
// download; an unreachable API; a tampered file; an unsafe manifest path; a live
// lock; the data directory guard; absolute and relative install directories;
// the hand-over of the root update.sh; and start.sh (Bun version check,
// options, exec). Skipped on Windows. The server lives in this process, so the
// scripts run as child processes.
//
//   node --test remote/test/update-sh.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveName, buildManifest, serializeManifest, sha256Hex, type InstallFile } from "../scripts/manifest.ts";
import { writeZip, type ZipEntry } from "../scripts/zip.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const updateSh = readFileSync(path.join(repo, "remote", "update.sh"));
const startSh = readFileSync(path.join(repo, "remote", "start.sh"));
const startOmarchySh = readFileSync(path.join(repo, "remote", "start-omarchy.sh"));
const UP_TAG = "v0.2.0-test";
const FORK = "owner/fork";
const DISTROS = [
	{ name: "alpine", file: "alpine.erofs", served: "alpine-72a89c2638ec4cb6.erofs", bytes: Buffer.alloc(30_000, 3) },
	{ name: "debian", file: "debian.erofs", served: "debian-08e8344aae97cfa8.erofs", bytes: Buffer.alloc(50_000, 5) },
];
const run = process.platform === "win32" ? test.skip : test;

const published = new Map<string, Buffer>();
const releases: string[] = [];
const requests: string[] = [];
let base = "";
let server: Server | undefined;
let tmp = "";
let app = "";
let home = "";
let cwd = "";
let bin = "";

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
		// Both layouts: GitHub pretty-prints, the fixture's default is compact.
		res.end(JSON.stringify(listed, null, requests.length % 2 ? 2 : 0));
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
		"remote/start.sh": startSh,
		"remote/start-omarchy.sh": startOmarchySh,
		"remote/unkernel-remote.js": Buffer.from(`bundle ${version}\n`),
		"remote/update.sh": updateSh,
		"remote/worker-entry.js": Buffer.from("worker\n"),
		"web/.output/public/assets/index.js": Buffer.from(`page ${version}\n`),
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

function publish(tag: string, files: Record<string, Buffer>, options: { corrupt?: boolean; unsafe?: boolean } = {}): void {
	const kernel = kernelFiles();
	const appZip = writeZip(sorted(files).map(([name, data]): ZipEntry => ({ name, data })));
	const kernelZip = writeZip(sorted(kernel).map(([name, data]): ZipEntry => ({ name, data })));
	const appName = archiveName("app", fileList(files));
	const kernelName = archiveName("kernel", fileList(kernel));
	const manifest = buildManifest({
		repo: FORK,
		tag,
		commit: "c".repeat(40),
		built: "2026-11-23T00:00:00.000Z",
		upstream: { repo: "pithings/unkernel", tag: UP_TAG, abi: 3, base: "base-test" },
		app: { name: appName, size: appZip.length, sha256: sha256Hex(appZip), files: fileList(files) },
		kernel: { name: kernelName, size: kernelZip.length, sha256: sha256Hex(kernelZip), files: fileList(kernel) },
		updater: [
			{ name: "update.sh", size: updateSh.length, sha256: sha256Hex(updateSh) },
			{ name: "start.sh", size: startSh.length, sha256: sha256Hex(startSh) },
		],
		distros: DISTROS.map((d) => ({ name: d.name, file: d.file, size: d.bytes.length, sha256: sha256Hex(d.bytes), served: d.served })),
	});
	let json = serializeManifest(manifest).replaceAll("https://github.com/", `${base}/`);
	if (options.unsafe) json = json.replace('"remote/README.md"', '"remote/../../escape"');
	const served = options.corrupt ? Buffer.from(appZip).fill(appZip[100]! ^ 0xff, 100, 101) : appZip;
	published.set(`${tag}/${appName}`, served);
	published.set(`${tag}/${kernelName}`, kernelZip);
	published.set(`${tag}/manifest.json`, Buffer.from(json));
	published.set(`${tag}/update.sh`, updateSh);
	published.set(`${tag}/start.sh`, startSh);
	releases.unshift(tag);
}

function assetsRequested(): string[] {
	return requests
		.filter((p) => p.includes("/releases/download/") && !p.endsWith("/manifest.json"))
		.map((p) => decodeURIComponent(p.split("/").pop()!))
		.sort();
}

function sh(args: string[], extraEnv: Record<string, string | undefined> = {}, dir = cwd): Promise<{ status: number | null; out: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, UNKERNEL_APP: undefined, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extraEnv };
	return new Promise((resolve, reject) => {
		const child = spawn("sh", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (b: Buffer) => (out += b.toString()));
		child.stderr.on("data", (b: Buffer) => (out += b.toString()));
		const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.on("error", reject);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, out });
		});
	});
}

const updater = () => path.join(repo, "remote", "update.sh");
const flags = (extra: string[] = [], api = base) => ["--dir", app, "--repo", FORK, "--api-base", api, "--download-base", base, "--no-start", ...extra];
const installedFile = (version: string, rel: string) => readFileSync(path.join(app, "versions", version, ...rel.split("/"))).toString();
const currentVersion = () => readFileSync(path.join(app, "current.txt"), "utf8");
const appArchive = (files: Record<string, Buffer>) => archiveName("app", fileList(files));
const kernelName = () => archiveName("kernel", fileList(kernelFiles()));

function fakeBun(version: string): void {
	writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\npwd > "${tmp}/bun-cwd"\nprintf '%s\\n' "$@" > "${tmp}/bun-args"\n`);
	chmodSync(path.join(bin, "bun"), 0o755);
}

before(async () => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "unkernel-update-sh-"));
	app = path.join(tmp, "app");
	home = path.join(tmp, "home");
	cwd = path.join(tmp, "cwd");
	bin = path.join(tmp, "bin");
	for (const d of [home, cwd, bin]) mkdirSync(d, { recursive: true });
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
	const r = await sh([updater(), ...flags()]);
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v1")), kernelName(), "alpine.erofs", "debian.erofs"].sort());
	assert.equal(currentVersion(), "remote-v1");
	for (const [rel, data] of [...sorted(appFiles("v1")), ...sorted(kernelFiles())]) {
		assert.deepEqual(readFileSync(path.join(app, "versions", "remote-v1", ...rel.split("/"))), data, rel);
	}
	for (const d of DISTROS) {
		assert.deepEqual(readFileSync(path.join(app, "versions", "remote-v1", "web", ".output", "public", "distros", d.served)), d.bytes);
	}
	assert.ok(existsSync(path.join(app, "update.sh")) && existsSync(path.join(app, "start.sh")), "the launchers are in the install directory");
	assert.deepEqual(readFileSync(path.join(app, "start-omarchy.sh")), startOmarchySh, "the Omarchy launcher is installed too");
	assert.equal(existsSync(path.join(app, "downloads")), false);
	assert.equal(existsSync(path.join(app, "update.lock")), false);
});

run("start-omarchy.sh says so when the installed version has no Omarchy image", async () => {
	const r = await sh([path.join(app, "start-omarchy.sh"), "--no-open"]);
	assert.equal(r.status, 2);
	assert.match(r.out, /no Omarchy image/);
});

run("a re-run with nothing changed downloads nothing", async () => {
	requests.length = 0;
	const r = await sh([updater(), ...flags()]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /up to date: remote-v1/);
	assert.deepEqual(assetsRequested(), []);
});

run("an app-only release downloads the app archive and nothing else", async () => {
	publish("remote-v2", appFiles("v2"));
	requests.length = 0;
	const check = await sh([updater(), ...flags(["--check"])]);
	assert.equal(check.status, 0, check.out);
	assert.match(check.out, /update available: remote-v1 -> remote-v2, 1 download\(s\)/);
	assert.deepEqual(assetsRequested(), [], "a check downloads no asset");
	assert.equal(currentVersion(), "remote-v1");

	requests.length = 0;
	const r = await sh([updater(), ...flags()]);
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v2"))], "only the app archive");
	assert.equal(currentVersion(), "remote-v2");
	assert.equal(installedFile("remote-v2", "remote/unkernel-remote.js"), "bundle v2\n");
	assert.equal(installedFile("remote-v1", "remote/unkernel-remote.js"), "bundle v1\n", "the previous version stays for a rollback");
});

run("a corrupt download is refused and the running version stays", async () => {
	publish("remote-v3", appFiles("v3"), { corrupt: true });
	const r = await sh([updater(), ...flags()]);
	releases.shift();
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /does not match its size or sha256/);
	assert.match(r.out, /starting the installed version remote-v2/);
	assert.equal(currentVersion(), "remote-v2");
	assert.equal(existsSync(path.join(app, "versions", "remote-v3")), false);
	assert.equal(readdirSync(app).some((n) => n.startsWith("partial-")), false);
	assert.equal(existsSync(path.join(app, "update.lock")), false);
});

run("an unreachable API starts the installed version, and a check fails", async () => {
	const dead = `http://127.0.0.1:${await freePort()}`;
	const started = await sh([updater(), ...flags([], dead)]);
	assert.equal(started.status, 0, started.out);
	assert.match(started.out, /starting the installed version remote-v2|cannot read the releases/);
	const check = await sh([updater(), ...flags(["--check"], dead)]);
	assert.equal(check.status, 1, check.out);
});

run("a tampered installed file is the only thing downloaded again", async () => {
	writeFileSync(path.join(app, "versions", "remote-v2", "remote", "worker-entry.js"), "tampered\n");
	requests.length = 0;
	const r = await sh([updater(), ...flags()]);
	assert.equal(r.status, 0, r.out);
	assert.deepEqual(assetsRequested(), [appArchive(appFiles("v2"))]);
	assert.equal(installedFile("remote-v2", "remote/worker-entry.js"), "worker\n");
});

run("a manifest with an unsafe path is refused before any download", async () => {
	publish("remote-v4", appFiles("v4"), { unsafe: true });
	requests.length = 0;
	const r = await sh([updater(), ...flags()]);
	releases.shift();
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /unsafe path/);
	assert.equal(currentVersion(), "remote-v2");
	assert.deepEqual(assetsRequested(), []);
	const first = await sh([updater(), "--dir", path.join(tmp, "unsafe-app"), "--repo", FORK, "--api-base", base, "--download-base", base, "--no-start", "--tag", "remote-v4"]);
	assert.equal(first.status, 1, first.out);
});

run("a live lock stops a second updater", async () => {
	const holder = spawn("sleep", ["30"]);
	try {
		writeFileSync(path.join(app, "update.lock"), String(holder.pid));
		const r = await sh([updater(), ...flags()]);
		assert.equal(r.status, 1, r.out);
		assert.match(r.out, /another update is running/);
		assert.ok(existsSync(path.join(app, "update.lock")), "the other updater's lock is left alone");
	} finally {
		holder.kill();
		rmSync(path.join(app, "update.lock"), { force: true });
	}
});

run("a stale lock is taken over", async () => {
	writeFileSync(path.join(app, "update.lock"), "999999");
	const r = await sh([updater(), ...flags(["--check"])]);
	assert.equal(r.status, 0, r.out);
	assert.equal(existsSync(path.join(app, "update.lock")), false);
});

run("the data directory is refused as the install directory", async () => {
	const data = path.join(home, ".unkernel", "remote");
	const r = await sh([updater(), "--dir", data, "--repo", FORK, "--api-base", base, "--download-base", base, "--no-start"]);
	assert.equal(r.status, 1, r.out);
	assert.match(r.out, /must not be the data directory/);
});

run("an absolute and a relative install directory, and UNKERNEL_APP", async () => {
	for (const [args, env, want] of [
		[["--dir", path.join(tmp, "abs-app")], {}, path.join(tmp, "abs-app")],
		[["-d", "rel-app"], {}, path.join(cwd, "rel-app")],
		[["--dir=rel2"], {}, path.join(cwd, "rel2")],
		[[], { UNKERNEL_APP: path.join(tmp, "env-app") }, path.join(tmp, "env-app")],
	] as [string[], Record<string, string>, string][]) {
		const r = await sh([updater(), ...args, "--repo", FORK, "--api-base", base, "--download-base", base, "--no-start"], env);
		assert.equal(r.status, 0, r.out);
		assert.equal(readFileSync(path.join(want, "current.txt"), "utf8"), "remote-v2", want);
	}
});

run("the default install directory is ~/.unkernel/app", async () => {
	const r = await sh([updater(), "--repo", FORK, "--api-base", base, "--download-base", base, "--no-start"]);
	assert.equal(r.status, 0, r.out);
	assert.equal(readFileSync(path.join(home, ".unkernel", "app", "current.txt"), "utf8"), "remote-v2");
});

run("the install's root update.sh hands over to the installed version", async () => {
	requests.length = 0;
	const r = await sh([path.join(app, "update.sh"), ...flags(["--check", "--tag", "remote-v2"])]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, /up to date: remote-v2/);
	assert.deepEqual(assetsRequested(), []);
});

run("start.sh needs Bun 1.4.5 or newer", async () => {
	fakeBun("1.4.4");
	const old = await sh([path.join(app, "start.sh"), "--no-open"]);
	assert.equal(old.status, 2, old.out);
	assert.match(old.out, /Bun 1\.4\.5 or newer is needed, found 1\.4\.4/);
	rmSync(path.join(bin, "bun"));
	const none = await sh([path.join(app, "start.sh")], { PATH: `${bin}:/usr/bin:/bin` });
	assert.equal(none.status, 2, none.out);
	assert.match(none.out, /Bun is not installed/);
});

run("start.sh runs the installed bundle with the options, paths made absolute", async () => {
	fakeBun("1.5.0");
	const r = await sh([path.join(app, "start.sh"), "--data", "d/vm.img", "--work=none", "--cache", path.join(tmp, "c"), "--port", "8790", "--no-net", "--no-open"]);
	assert.equal(r.status, 0, r.out);
	const args = readFileSync(path.join(tmp, "bun-args"), "utf8").split("\n").filter(Boolean);
	assert.deepEqual(args, ["remote/unkernel-remote.js", "--data", path.join(cwd, "d", "vm.img"), "--work", "none", "--cache", path.join(tmp, "c"), "--port", "8790", "--no-net"]);
	assert.equal(readFileSync(path.join(tmp, "bun-cwd"), "utf8").trim(), path.join(app, "versions", "remote-v2"));
	const open = await sh([path.join(app, "start.sh")]);
	assert.equal(open.status, 0, open.out);
	assert.ok(readFileSync(path.join(tmp, "bun-args"), "utf8").split("\n").includes("--open"));
});

run("update.sh starts the backend after updating and forwards the options and the settings file", async () => {
	fakeBun("1.4.5");
	writeFileSync(path.join(app, "unkernel-remote.json"), "{}");
	const r = await sh([updater(), "--dir", app, "--repo", FORK, "--api-base", base, "--download-base", base, "--port", "8791", "--no-open"]);
	assert.equal(r.status, 0, r.out);
	const args = readFileSync(path.join(tmp, "bun-args"), "utf8").split("\n").filter(Boolean);
	assert.deepEqual(args, ["remote/unkernel-remote.js", "--port", "8791", "--config", path.join(app, "unkernel-remote.json")]);
	assert.equal(existsSync(path.join(app, "update.lock")), false, "the lock is released before the backend starts");
});

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
