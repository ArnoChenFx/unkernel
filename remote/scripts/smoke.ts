// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The smoke test of a remote install (release.ts writes one to remote/dist/install):
// the bundled backend runs with Bun on a free port, serves its page and a distro
// image's Range reads, boots the base kernel through the page's own link and waits
// for the kernel's first line, then stops the kernel and the backend (SIGINT saves
// the data disk and releases its lock). Every worker entry the bundle starts must
// be in the install.
//
//   node remote/scripts/smoke.ts <install-dir>     (BUN names the bun binary, default "bun")

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { RemoteLink } from "../web/link.ts";
import { REMOTE_WIRE } from "../wire.ts";
import type { FromWorker, ToWorker } from "../../js/core/worker-protocol.ts";

const BOOT_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 60_000;

function fail(message: string): never {
	throw new Error(`smoke: ${message}`);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

function exitOf(child: ChildProcess, timeoutMs: number): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`smoke: the backend did not exit within ${timeoutMs / 1000} s`)), timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

/** The worker entries the bundle starts with `new URL("./<name>", import.meta.url)`: each must be beside it. */
function checkEntries(install: string): string[] {
	const dir = path.join(install, "remote");
	const bundle = readFileSync(path.join(dir, "unkernel-remote.js"), "utf8");
	const refs = [...new Set([...bundle.matchAll(/new URL\("\.\/([^"]+)",\s*import\.meta\.url\)/g)].map((m) => m[1]!))];
	if (refs.length === 0) fail("the bundle starts no worker entry: the entry rewrite did not run");
	for (const ref of refs) {
		if (!existsSync(path.join(dir, ref))) fail(`the bundle starts ./${ref}, which the install does not have`);
	}
	return refs;
}

async function main(): Promise<void> {
	const install = path.resolve(process.argv[2] ?? fail("usage: node remote/scripts/smoke.ts <install-dir>"));
	const bundle = path.join(install, "remote", "unkernel-remote.js");
	const web = path.join(install, "web", ".output", "public");
	if (!existsSync(bundle)) fail(`no backend bundle at ${bundle}`);
	const entries = checkEntries(install);
	const kernelName = readdirSync(path.join(web, "assets")).find((f) => /^unkernel-(?!smp-)[A-Za-z0-9_-]+\.wasm$/.test(f));
	if (!kernelName) fail("the web build has no UP kernel (assets/unkernel-*.wasm)");

	const tmp = mkdtempSync(path.join(os.tmpdir(), "unkernel-smoke-"));
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const data = path.join(tmp, "data", "vm1.img");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		UNKERNEL_REMOTE_WEB: web,
		UNKERNEL_REMOTE_DATA: data,
		UNKERNEL_REMOTE_WORK: "none",
		UNKERNEL_REMOTE_CACHE: path.join(tmp, "cache"),
		UNKERNEL_REMOTE_PORT: String(port),
		UNKERNEL_REMOTE_NET: "off",
		UNKERNEL_REMOTE_CONFIG: "",
	};
	const log: string[] = [];
	const backend = spawn(process.env.BUN ?? "bun", [bundle], { env, cwd: install, stdio: ["ignore", "pipe", "pipe"] });
	backend.stdout?.on("data", (b: Buffer) => log.push(b.toString()));
	backend.stderr?.on("data", (b: Buffer) => log.push(b.toString()));
	let link: RemoteLink | undefined;
	try {
		const info = await until("the backend's /remote/info", 30_000, async () => {
			const res = await fetch(`${origin}/remote/info`).catch(() => undefined);
			return res?.ok ? ((await res.json()) as { app?: string; wire?: number; net?: boolean; data?: string }) : undefined;
		});
		if (info.app !== "unkernel-remote" || info.wire !== REMOTE_WIRE || info.net !== false) fail(`unexpected /remote/info: ${JSON.stringify(info)}`);
		if (info.data !== data) fail(`the backend uses ${info.data}, not ${data}`);

		const page = await fetch(`${origin}/`);
		const html = await page.text();
		if (page.status !== 200 || !/name="unkernel-remote"/.test(html)) fail(`the page is not the remote page (status ${page.status})`);

		const kiosk = await fetch(`${origin}/kiosk?distro=alpine`);
		const kioskHtml = await kiosk.text();
		if (kiosk.status !== 200 || !/window\.__KIOSK__=\{"kernel":"\/assets\/unkernel-[^"]+\.wasm","distro":"\/distros\/alpine-[0-9a-f]+\.erofs"/.test(kioskHtml)) fail(`the kiosk page is wrong (status ${kiosk.status})`);
		const kioskJs = await fetch(`${origin}/kiosk.js`);
		if (kioskJs.status !== 200 || (await kioskJs.text()).length < 10_000) fail("the kiosk script is not served");

		const alpine = readdirSync(path.join(web, "distros")).find((f) => /^alpine-[0-9a-f]+\.erofs$/.test(f));
		if (!alpine) fail("the web build has no Alpine distro image (distros/alpine-*.erofs)");
		const range = await fetch(`${origin}/distros/${alpine}`, { headers: { range: "bytes=0-15" } });
		const rangeBody = new Uint8Array(await range.arrayBuffer());
		if (range.status !== 206 || rangeBody.length !== 16) fail(`the distro image's Range read answered ${range.status} with ${rangeBody.length} bytes`);

		link = await RemoteLink.connect(origin, { timeoutMs: 15_000 });
		const endpoint = link.endpoint();
		const decoder = new TextDecoder();
		let output = "";
		let started = false;
		let exited = false;
		let bootError: string | undefined;
		endpoint.listen({
			message(m: FromWorker) {
				if (m.t === "output") output += decoder.decode(m.bytes, { stream: true });
				else if (m.t === "started") started = true;
				else if (m.t === "boot-error") bootError = `${m.stage}: ${m.message}`;
				else if (m.t === "exit") exited = true;
			},
			error(e: unknown) {
				bootError ??= (e as Error)?.message ?? String(e);
			},
			exit() {
				exited = true;
			},
		});
		const bootStart = Date.now();
		const boot: ToWorker = {
			t: "boot",
			spec: { kernel: `${origin}/assets/${kernelName}`, initrd: undefined, memoryMiB: 512, statsIntervalMs: 1000, disks: [{ kind: "data", template: "bundled", optional: true }] },
		};
		endpoint.post(boot);
		await until("the kernel's first line", BOOT_TIMEOUT_MS, () => {
			if (bootError) fail(`the boot failed: ${bootError}`);
			if (exited) fail("the kernel exited before its first line");
			return /Linux version /.test(output) ? true : undefined;
		});
		const bootMs = Date.now() - bootStart;
		const firstLine = output.split("\n").find((l) => l.includes("Linux version"))?.trim() ?? "";
		if (!started) fail("the kernel printed a line but never reported started");

		endpoint.post({ t: "stop", reason: "smoke" });
		await until("the kernel to stop", STOP_TIMEOUT_MS, () => (exited ? true : undefined));
		link.close();
		link = undefined;

		backend.kill("SIGINT");
		const code = await exitOf(backend, STOP_TIMEOUT_MS);
		if (code !== 0) fail(`the backend exited with ${code} after SIGINT`);
		if (existsSync(`${data}.lock`)) fail("the data disk's lock is still there after the backend stopped");
		if (!existsSync(data)) fail("the data disk was not created");

		console.log(`smoke: ok`);
		console.log(`  backend ${origin}, page and distro Range read ok (206, 16 bytes)`);
		console.log(`  kernel ${kernelName} printed in ${(bootMs / 1000).toFixed(1)} s: ${firstLine}`);
		console.log(`  worker entries present: ${entries.join(", ")}`);
		console.log("  SIGINT: exit 0, data disk lock released");
	} catch (e) {
		console.error((e as Error).message);
		console.error(log.join("").split("\n").slice(-40).join("\n"));
		process.exitCode = 1;
	} finally {
		link?.close();
		if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGKILL");
		rmSync(tmp, { recursive: true, force: true });
	}
}

await main();
