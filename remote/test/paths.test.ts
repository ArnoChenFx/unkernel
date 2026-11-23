// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Path arguments of remote/start-windows.ps1 and remote/update.ps1: an absolute
// path is used as given and a relative one is resolved against the current
// directory. Runs pwsh (or powershell.exe on Windows); skipped without one.
//
//   node --test remote/test/paths.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function findPowerShell(): string | null {
	for (const candidate of [process.env.PWSH, "pwsh", process.platform === "win32" ? "powershell" : undefined]) {
		if (!candidate) continue;
		const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "1"], { encoding: "utf8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

const shell = findPowerShell();
const run = shell && process.platform !== "win32" ? test : test.skip;

function psArgs(file: string, args: string[]): string[] {
	return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args];
}

// A prebuilt install layout with a stub `bun` that records its arguments.
function fixture(): { root: string; cwd: string; env: NodeJS.ProcessEnv; argsFile: string } {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "unkernel-paths-")));
	const inst = path.join(root, "install");
	mkdirSync(path.join(inst, "remote"), { recursive: true });
	mkdirSync(path.join(inst, "web", ".output", "public", "assets"), { recursive: true });
	writeFileSync(path.join(inst, "remote", "unkernel-remote.js"), "");
	copyFileSync(path.join(repo, "remote", "start-windows.ps1"), path.join(inst, "remote", "start-windows.ps1"));
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	const argsFile = path.join(root, "args.txt");
	writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`);
	chmodSync(path.join(bin, "bun"), 0o755);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	return { root, cwd, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, argsFile };
}

run("start-windows.ps1 keeps absolute -Data/-Work/-Cache and resolves relative ones against the cwd", () => {
	const f = fixture();
	try {
		const abs = path.join(f.root, "abs");
		const script = path.join(f.root, "install", "remote", "start-windows.ps1");
		const r = spawnSync(shell!, psArgs(script, ["-NoOpen", "-Data", path.join(abs, "vm.img"), "-Work", abs, "-Cache", path.join("rel", "cache")]), { cwd: f.cwd, env: f.env, encoding: "utf8" });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const args = readFileSync(f.argsFile, "utf8").split("\n");
		const value = (flag: string) => args[args.indexOf(flag) + 1];
		assert.equal(value("--data"), path.join(abs, "vm.img"));
		assert.equal(value("--work"), abs);
		assert.equal(value("--cache"), path.join(f.cwd, "rel", "cache"));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

run("update.ps1 uses an absolute -Dir as given and a relative one from the cwd", () => {
	const f = fixture();
	try {
		const script = path.join(repo, "remote", "update.ps1");
		for (const [dir, want] of [
			[path.join(f.root, "abs-app"), path.join(f.root, "abs-app")],
			["rel-app", path.join(f.cwd, "rel-app")],
		] as const) {
			// An unreachable API with no installed version fails after the directory is created.
			const r = spawnSync(shell!, psArgs(script, ["-Dir", dir, "-Repo", "o/r", "-ApiBase", "http://127.0.0.1:1", "-DownloadBase", "http://127.0.0.1:1", "-NoStart"]), { cwd: f.cwd, env: { ...f.env, HOME: f.root }, encoding: "utf8" });
			assert.notEqual(r.status, 0);
			assert.ok(readdirOk(path.join(want, "versions")), `${want} not created: ${r.stdout}${r.stderr}`);
		}
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

function readdirOk(p: string): boolean {
	try {
		return spawnSync("test", ["-d", p]).status === 0;
	} catch {
		return false;
	}
}
