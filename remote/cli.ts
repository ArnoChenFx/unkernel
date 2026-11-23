// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote kernel backend: unkernel's kernel runs on this computer, for the
// web desktop served from it at 127.0.0.1 (config.ts has the settings, the
// server is server.ts). Start it with `bun --bun remote/cli.ts`; on Windows
// remote/start-windows.ps1 does that and opens the page. Ctrl+C, a closed
// console or SIGTERM saves the guest's disk, stops the kernel and releases
// the data disk's lock before the process exits.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConfigError, USAGE, loadConfig } from "./config.ts";
import { ImageInUseError, lockImage } from "./lock.ts";
import { startRemoteServer } from "./server.ts";

function log(line: string): void {
	console.log(`${new Date().toLocaleTimeString()} ${line}`);
}

function openBrowser(url: string): void {
	const cmd = process.platform === "win32" ? ["cmd", "/c", "start", "", url]
		: process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
	try {
		spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
	} catch {}
}

async function main(): Promise<void> {
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(process.argv.slice(2));
	} catch (e) {
		if (!(e instanceof ConfigError)) throw e;
		console.error(`unkernel remote: ${e.message}`);
		process.exit(2);
	}
	if (config.help) {
		console.log(USAGE);
		return;
	}
	if (!existsSync(config.web)) {
		console.error(`unkernel remote: no page at ${config.web}: build it first (pnpm build:web), or point --web at a build`);
		process.exit(2);
	}
	mkdirSync(path.dirname(config.data), { recursive: true });
	if (config.work) mkdirSync(config.work, { recursive: true });

	let lock: ReturnType<typeof lockImage>;
	try {
		lock = lockImage(config.data);
	} catch (e) {
		console.error(`unkernel remote: ${(e instanceof ImageInUseError ? "" : "cannot lock the data disk: ") + (e as Error).message}`);
		process.exit(1);
	}

	let running: Awaited<ReturnType<typeof startRemoteServer>>;
	try {
		running = await startRemoteServer(config, log);
	} catch (e) {
		lock.release();
		console.error(`unkernel remote: ${(e as Error).message}`);
		process.exit(1);
	}

	log(`unkernel remote kernel listening on ${running.url}`);
	log(`page: ${running.url}?remote=1`);
	log(`data disk: ${config.data} (lock ${lock.path})`);
	log(`/work: ${config.work ?? "none"}`);
	log(`distro cache: ${config.cache}`);
	log(`network: ${config.net ? "direct host sockets" : "off"}`);
	log("Ctrl+C stops the kernel after saving the disk.");
	if (config.open) openBrowser(`${running.url}?remote=1`);

	let stopping: Promise<void> | undefined;
	const stop = (why: string) => {
		stopping ??= (async () => {
			log(`stopping (${why}): saving the guest's disk`);
			await running.hub.end(`the backend stops (${why})`);
			running.stop();
			lock.release();
			log("stopped");
			process.exit(0);
		})();
	};
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => stop(sig));
	process.on("exit", () => lock.release());
}

void main();
