// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// remote/scripts/sync-upstream.sh in temporary repositories (an upstream, the
// fork's origin, a clone of the fork) with a fake gh that logs its calls.
// Nothing new upstream changes nothing; a forced release reports main's head;
// a clean merge is pushed to main as a merge commit by the bot and released;
// a conflict leaves main alone, pushes the conflicted merge to
// upstream-sync/<sha7> and opens one draft pull request, and a second run
// does not push or open it again.
//
//   node --test remote/test/sync.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repo, "remote", "scripts", "sync-upstream.sh");
const IDENT = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const today = new Date().toISOString().slice(2, 10).replaceAll("-", "");
const run = process.platform === "win32" ? test.skip : test;

interface Fixture {
	dir: string;
	upstream: string;
	origin: string;
	clone: string;
	seed: string;
	bin: string;
	ghLog: string;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: IDENT }).trim();
}

function write(dir: string, file: string, text: string): void {
	writeFileSync(path.join(dir, file), text);
}

function commit(dir: string, file: string, text: string, message: string): void {
	write(dir, file, text);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", message);
}

/** An upstream with one commit, a fork cloned from it, and a fake gh first on PATH. */
function fixture(): Fixture {
	const dir = mkdtempSync(path.join(os.tmpdir(), "unkernel-sync-"));
	const upstream = path.join(dir, "upstream.git");
	const origin = path.join(dir, "fork.git");
	const seed = path.join(dir, "seed");
	const clone = path.join(dir, "clone");
	const bin = path.join(dir, "bin");
	const ghLog = path.join(dir, "gh.log");
	git(dir, "init", "-q", "--bare", "-b", "main", upstream);
	git(dir, "init", "-q", "-b", "main", seed);
	commit(seed, "shared.txt", "one\ntwo\nthree\n", "upstream A");
	git(seed, "remote", "add", "origin", upstream);
	git(seed, "push", "-q", "origin", "main");
	git(dir, "clone", "-q", "--bare", upstream, origin);
	git(dir, "clone", "-q", origin, clone);
	mkdirSync(bin);
	writeFileSync(
		path.join(bin, "gh"),
		`#!/bin/sh\necho "$*" >> "$GH_LOG"\ncase "$1 $2" in\n"pr list") echo "\${GH_PR_OPEN:-0}" ;;\n"pr create")\n\twhile [ $# -gt 0 ]; do\n\t\tif [ "$1" = --body-file ]; then cp "$2" "$GH_LOG.body"; fi\n\t\tshift\n\tdone\n\techo "https://example.invalid/pull/1" ;;\nesac\n`,
	);
	chmodSync(path.join(bin, "gh"), 0o755);
	return { dir, upstream, origin, clone, seed, bin, ghLog };
}

function sync(fx: Fixture, env: Record<string, string> = {}) {
	const output = path.join(fx.dir, `output-${Math.random().toString(36).slice(2)}.txt`);
	writeFileSync(output, "");
	const r = spawnSync("bash", [script], {
		cwd: fx.clone,
		encoding: "utf8",
		env: { ...IDENT, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, GH_LOG: fx.ghLog, GITHUB_REPOSITORY: "owner/fork", GITHUB_OUTPUT: output, UPSTREAM_URL: fx.upstream, ...env },
	});
	const outputs = Object.fromEntries(
		readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => {
			const i = line.indexOf("=");
			return [line.slice(0, i), line.slice(i + 1)];
		}),
	);
	return { status: r.status, out: `${r.stdout}${r.stderr}`, outputs };
}

function ghCalls(fx: Fixture): string[] {
	return existsSync(fx.ghLog) ? readFileSync(fx.ghLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

function cleanup(fx: Fixture): void {
	rmSync(fx.dir, { recursive: true, force: true });
}

run("nothing new upstream changes nothing", () => {
	const fx = fixture();
	try {
		const r = sync(fx);
		assert.equal(r.status, 0, r.out);
		assert.equal(r.outputs.released, "false");
		assert.equal(r.outputs.tag, undefined);
		assert.equal(git(fx.origin, "rev-parse", "main"), git(fx.seed, "rev-parse", "HEAD"));
		assert.deepEqual(ghCalls(fx), []);
	} finally {
		cleanup(fx);
	}
});

run("a forced release of main reports main's head without a new commit", () => {
	const fx = fixture();
	try {
		const head = git(fx.clone, "rev-parse", "HEAD");
		const r = sync(fx, { FORCE_RELEASE: "true" });
		assert.equal(r.status, 0, r.out);
		assert.equal(r.outputs.released, "true");
		assert.equal(r.outputs.sha, head);
		assert.equal(r.outputs.tag, `remote-v${today}-${head.slice(0, 7)}`);
	} finally {
		cleanup(fx);
	}
});

run("a clean merge is pushed to main as a merge commit by the bot, and released", () => {
	const fx = fixture();
	try {
		commit(fx.seed, "upstream.txt", "upstream only\n", "upstream B");
		git(fx.seed, "push", "-q", "origin", "main");
		const before = git(fx.origin, "rev-parse", "main");
		const r = sync(fx);
		assert.equal(r.status, 0, r.out);
		const merged = git(fx.origin, "rev-parse", "main");
		assert.notEqual(merged, before);
		assert.equal(r.outputs.released, "true");
		assert.equal(r.outputs.sha, merged);
		assert.equal(r.outputs.tag, `remote-v${today}-${merged.slice(0, 7)}`);
		assert.equal(git(fx.origin, "log", "-1", "--format=%P", "main").split(" ").length, 2, "a merge commit");
		assert.equal(git(fx.origin, "log", "-1", "--format=%an <%ae>", "main"), "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>");
		assert.equal(git(fx.origin, "show", "main:upstream.txt"), "upstream only");
		assert.deepEqual(ghCalls(fx), []);
	} finally {
		cleanup(fx);
	}
});

run("a conflict leaves main alone, pushes the conflicted merge, and opens one draft pull request", () => {
	const fx = fixture();
	try {
		commit(fx.seed, "shared.txt", "one\nupstream two\nthree\n", "upstream B");
		git(fx.seed, "push", "-q", "origin", "main");
		commit(fx.clone, "shared.txt", "one\nfork two\nthree\n", "fork B");
		git(fx.clone, "push", "-q", "origin", "main");
		const mainBefore = git(fx.origin, "rev-parse", "main");
		const upstreamSha = git(fx.seed, "rev-parse", "HEAD");
		const branch = `upstream-sync/${upstreamSha.slice(0, 7)}`;

		const r = sync(fx);
		assert.equal(r.status, 0, r.out);
		assert.equal(r.outputs.released, "false");
		assert.equal(git(fx.origin, "rev-parse", "main"), mainBefore, "main is unchanged");
		assert.match(r.out, /::warning title=Upstream sync conflict::/);
		const conflicted = git(fx.origin, "show", `${branch}:shared.txt`);
		assert.match(conflicted, /<<<<<<< /);
		assert.match(conflicted, /fork two/);
		assert.match(conflicted, /upstream two/);
		const calls = ghCalls(fx);
		const creates = calls.filter((c) => c.startsWith("pr create"));
		assert.equal(creates.length, 1, calls.join("\n"));
		assert.match(creates[0]!, new RegExp(`--draft .*--head ${branch}`));
		const body = readFileSync(`${fx.ghLog}.body`, "utf8");
		assert.match(body, /main` is unchanged/);
		assert.match(body, /^- `shared\.txt`$/m);

		const again = sync(fx, { GH_PR_OPEN: "1" });
		assert.equal(again.status, 0, again.out);
		assert.equal(again.outputs.released, "false");
		assert.equal(ghCalls(fx).filter((c) => c.startsWith("pr create")).length, 1, "no second draft pull request");
		assert.equal(git(fx.origin, "rev-parse", "main"), mainBefore);
	} finally {
		cleanup(fx);
	}
});
