// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote kernel backend without a kernel or a browser: the wire codec and
// the /work calls (remote/wire.ts), /work's modes (remote/backend.ts workFs),
// the data disk's lock, the settings (remote/config.ts), and the page guard and
// the page's remote flag (remote/http.ts, which remote/server.ts serves with
// Bun). Nothing here starts a server.
//
//   node --test remote/test/remote.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { REMOTE_WIRE, decodeRemote, encodeRemote, remoteFs, remoteFsServer } from "../wire.ts";
import { workFs } from "../backend.ts";
import { nodeFs } from "../../js/node/nodefs.ts";
import { ConfigError, loadConfig } from "../config.ts";
import { ImageInUseError, lockImage } from "../lock.ts";
import { sameSiteGuard, withRemoteFlag } from "../http.ts";

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "unkernel-remote-"));

test("the wire carries plain data, the types the worker protocol uses, and binary parts", () => {
	const value = {
		k: "kernel", n: NaN, z: -0, big: 2n ** 60n, u: undefined, when: new Date(0), url: new URL("http://127.0.0.1:8787/x"),
		map: new Map([["a", 1]]), set: new Set([1, 2]), bytes: new Uint8Array([1, 2, 3]), buf: new Uint8Array(4).fill(7).buffer,
		view: new Uint16Array([258]), err: new RangeError("bad"),
	};
	const back = decodeRemote(encodeRemote(value)) as typeof value;
	assert.ok(Number.isNaN(back.n));
	assert.ok(Object.is(back.z, -0));
	assert.equal(back.big, 2n ** 60n);
	assert.equal("u" in back, true);
	assert.equal(back.u, undefined);
	assert.deepEqual(back.when, new Date(0));
	assert.equal(back.url.href, "http://127.0.0.1:8787/x");
	assert.deepEqual(back.map, new Map([["a", 1]]));
	assert.deepEqual(back.set, new Set([1, 2]));
	assert.deepEqual([...back.bytes], [1, 2, 3]);
	assert.deepEqual([...new Uint8Array(back.buf)], [7, 7, 7, 7]);
	assert.deepEqual([...back.view], [258]);
	assert.equal(back.err.message, "bad");
	assert.equal(REMOTE_WIRE, 1);
});

test("a /work call goes over the wire and sees the host directory", async () => {
	const dir = tmpDir();
	try {
		mkdirSync(path.join(dir, "sub"));
		writeFileSync(path.join(dir, "a.txt"), "hello");
		const server = remoteFsServer(workFs(dir, "win32"));
		const over = async (op: Parameters<typeof server.call>[0], a: unknown[]) => decodeRemote(encodeRemote(await server.call(op, a)));
		const fs = remoteFs(over, server.caps);
		const names = (await fs.readdir("/")).map((e) => `${e.name}:${e.type}`).sort();
		assert.deepEqual(names, ["a.txt:file", "sub:dir"]);
		assert.equal(((await fs.getattr("/a.txt")).mode ?? 0) & 0o111, 0o111);
		assert.equal(((await fs.getattr("/sub")).mode ?? 0) & 0o111, 0o111);
		await server.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/work's modes: directories are traversable; files get the execute bit only on Windows", async () => {
	const dir = tmpDir();
	const sub = path.join(dir, "locked");
	try {
		mkdirSync(sub);
		chmodSync(sub, 0o600);
		writeFileSync(path.join(dir, "plain.txt"), "x");
		chmodSync(path.join(dir, "plain.txt"), 0o644);
		const linux = workFs(dir, "linux");
		assert.equal(((await linux.getattr("/locked")).mode ?? 0) & 0o111, 0o111);
		assert.equal(((await linux.getattr("/plain.txt")).mode ?? 0) & 0o111, 0);
		const windows = workFs(dir, "win32");
		assert.equal(((await windows.getattr("/plain.txt")).mode ?? 0) & 0o111, 0o111);
		assert.equal(((await windows.getattr("/locked")).mode ?? 0) & 0o111, 0o111);
		assert.equal((await nodeFs(dir).getattr("/locked")).mode! & 0o111, 0);
	} finally {
		chmodSync(sub, 0o755);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the data disk's lock refuses a live holder, takes over a stale one, and is released", async () => {
	const dir = tmpDir();
	const image = path.join(dir, "vm1.img");
	const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		await once(holder, "spawn");
		writeFileSync(`${image}.lock`, `${JSON.stringify({ pid: holder.pid, started: "now", image })}\n`);
		assert.throws(() => lockImage(image), ImageInUseError);
		holder.kill();
		await once(holder, "exit");
		const lock = lockImage(image);
		assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, process.pid);
		lock.release();
		assert.equal(existsSync(lock.path), false);
	} finally {
		holder.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the settings come from the flags, then the environment, then the file", () => {
	const dir = tmpDir();
	try {
		const file = path.join(dir, "unkernel-remote.json");
		writeFileSync(file, JSON.stringify({ data: "img/vm1.img", work: "work", port: 9000, net: false }));
		const fromFile = loadConfig(["--config", file], {});
		assert.equal(fromFile.data, path.join(dir, "img", "vm1.img"));
		assert.equal(fromFile.work, path.join(dir, "work"));
		assert.equal(fromFile.port, 9000);
		assert.equal(fromFile.net, false);
		assert.equal(loadConfig(["--config", file], { UNKERNEL_REMOTE_PORT: "9200" }).port, 9200);
		assert.equal(loadConfig(["--config", file, "--port", "9100"], { UNKERNEL_REMOTE_PORT: "9200" }).port, 9100);
		assert.equal(loadConfig(["--config", file, "--work", "none"], {}).work, null);
		assert.equal(loadConfig(["--config", file, "--net", "on"], {}).net, true);
		assert.throws(() => loadConfig(["--port", "70000"], {}), ConfigError);
		assert.throws(() => loadConfig(["--bogus", "1"], {}), ConfigError);
		writeFileSync(file, JSON.stringify({ port: 9000, unknown: 1 }));
		assert.throws(() => loadConfig(["--config", file], {}), ConfigError);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the page guard admits the backend's own Host and Origin, and refuses cross-site requests", () => {
	const guard = sameSiteGuard(8787);
	const at = (headers: Record<string, string>) => guard(new Request("http://127.0.0.1:8787/remote/ws", { headers: { host: "127.0.0.1:8787", ...headers } }));
	assert.equal(at({}), null);
	assert.equal(at({ origin: "http://localhost:8787", "sec-fetch-site": "same-origin" }), null);
	assert.equal(at({ "sec-fetch-site": "none" }), null);
	assert.equal(at({ host: "localhost:8787" }), null);
	assert.equal(at({ host: "evil.example:8787" })?.status, 403);
	assert.equal(at({ origin: "http://evil.example" })?.status, 403);
	assert.equal(at({ origin: "http://127.0.0.1:8788" })?.status, 403);
	assert.equal(at({ "sec-fetch-site": "cross-site" })?.status, 403);
});

test("the page gets the remote flag in its head", () => {
	assert.match(withRemoteFlag("<html><head><title>x</title></head></html>"), /<head>\n {4}<meta name="unkernel-remote" content="1" \/><title>x<\/title>/);
	assert.match(withRemoteFlag("<p>no head</p>"), /^<meta name="unkernel-remote" content="1" \/>\n<p>no head<\/p>$/);
});
