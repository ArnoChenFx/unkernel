// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for the guest's open and xdg-open (src/open.ts) without a DOM
// or a kernel: which URLs go to the preview, a new tab, or nowhere, and the
// command's questions (one at a time, dismissed when the guest process is
// gone) with a fake page.
//
//   node --test web/test/open.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { openCommand, parseOpen, type OpenAsk, type OpenDeps } from "../src/open.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("parseOpen: the guest's own servers go to the preview", () => {
	assert.deepEqual(parseOpen(["http://localhost:3000/auth?code=1#x"]), { kind: "preview", url: "http://localhost:3000/auth?code=1#x", port: 3000, path: "/auth?code=1#x" });
	assert.deepEqual(parseOpen(["--", "http://127.0.0.1:8000"]), { kind: "preview", url: "http://127.0.0.1:8000/", port: 8000, path: "/" });
	for (const u of ["http://0.0.0.0:5173/", "http://[::1]:4000/", "http://app.localhost:3000/", "http://LOCALHOST./", "http://10.0.2.15:3000/", "http://127.1:9000/"])
		assert.equal(parseOpen([u]).kind, "preview", u);
	assert.equal((parseOpen(["http://localhost/"]) as { port: number }).port, 80);
});

test("parseOpen: anything else over http(s) goes to a new tab", () => {
	assert.deepEqual(parseOpen(["https://example.com/login?x=1"]), { kind: "tab", url: "https://example.com/login?x=1", host: "example.com" });
	assert.deepEqual(parseOpen(["http://10.0.2.2:8080"]), { kind: "tab", url: "http://10.0.2.2:8080/", host: "10.0.2.2" });
	assert.equal((parseOpen(["https://bücher.example/"]) as { host: string }).host, "xn--bcher-kva.example");
	assert.equal((parseOpen(["https://localhost.evil.com/"]) as { host: string }).host, "localhost.evil.com");
});

test("parseOpen: refuses what is not one http(s) URL", () => {
	for (const args of [[], ["--"], ["file:///etc/passwd"], ["javascript:alert(1)"], ["data:text/html,hi"], ["/tmp/x.html"], ["localhost:3000"],
		["-a", "Safari", "http://x.com/"], ["--new-window", "https://x.com/"], ["https://a.com/", "https://b.com/"], ["https://user:pw@example.com/"],
		["https://localhost:3000/"]])
		assert.equal(parseOpen(args).kind, "refused", JSON.stringify(args));
});

/** A fake page: questions wait for answer(), and what opened is recorded. */
function fakePage() {
	const asked: OpenAsk[] = [], opened: string[] = [];
	let pending: ((ok: boolean) => void) | null = null;
	const deps: OpenDeps = {
		ask: (q) => { asked.push(q); return new Promise((r) => { pending = (ok) => { pending = null; r(ok); }; }); },
		dismiss: () => pending?.(false),
		previewSupported: () => true,
		preview: (port, path) => opened.push(`preview ${port} ${path}`),
		tab: (url) => opened.push(`tab ${url}`),
	};
	return { deps, asked, opened, answer: (ok: boolean) => pending?.(ok), open: () => pending !== null };
}

function ctx(args: string[], signal = new AbortController().signal) {
	let err = "";
	const stderr = new WritableStream<Uint8Array | string>({ write(c) { err += typeof c === "string" ? c : new TextDecoder().decode(c); } });
	return { c: { name: "xdg-open", args, signal, stderr }, err: () => err };
}

test("openCommand: asks every time, opens on OK, exits 1 on Cancel or a refused URL", async () => {
	const page = fakePage();
	const run = openCommand(page.deps);
	const a = ctx(["https://example.com/"]);
	const p = run(a.c);
	await tick();
	assert.equal(page.asked.length, 1);
	assert.equal(page.asked[0]!.url, "https://example.com/");
	assert.match(page.asked[0]!.title, /example\.com/);
	page.answer(true);
	assert.equal(await p, 0);
	assert.deepEqual(page.opened, ["tab https://example.com/"]);

	const b = ctx(["http://localhost:3000/x"]);
	const q = run(b.c);
	await tick();
	assert.equal(page.asked.length, 2);
	page.answer(false);
	assert.equal(await q, 1);
	assert.equal(b.err(), "xdg-open: cancelled\n");
	assert.deepEqual(page.opened, ["tab https://example.com/"]);

	const c = ctx(["file:///etc/passwd"]);
	assert.equal(await run(c.c), 1);
	assert.match(c.err(), /^xdg-open: only http and https/);
	assert.equal(page.asked.length, 2);
});

test("openCommand: one question at a time, and a gone process takes its question away", async () => {
	const page = fakePage();
	const run = openCommand(page.deps);
	const ac = new AbortController();
	const first = run(ctx(["http://localhost:8000/"], ac.signal).c);
	const second = run(ctx(["https://example.org/"]).c);
	await tick();
	assert.equal(page.asked.length, 1, "the second waits for the first");
	ac.abort();
	assert.equal(await first, 1);
	await tick();
	assert.equal(page.asked.length, 2);
	assert.equal(page.asked[1]!.url, "https://example.org/");
	page.answer(true);
	assert.equal(await second, 0);
	assert.deepEqual(page.opened, ["tab https://example.org/"]);

	// Gone while waiting its turn: never asked.
	const ac2 = new AbortController();
	const third = run(ctx(["https://a.example/"]).c);
	const fourth = run(ctx(["https://b.example/"], ac2.signal).c);
	await tick();
	ac2.abort();
	page.answer(false);
	assert.equal(await third, 1);
	assert.equal(await fourth, 1);
	assert.equal(page.asked.length, 3);
	assert.equal(page.open(), false);
});
