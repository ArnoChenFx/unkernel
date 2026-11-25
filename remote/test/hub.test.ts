// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The backend's kernel lifecycle (remote/backend.ts RemoteHub) with a fake worker
// and fake sockets, so no kernel boots: a kept kernel outlives its page and a page
// that connects again resumes it (replay, the cached frame, released input, the
// console tail's bound), a second page takes over (the first is closed with 4001,
// its late close and messages change nothing), a kernel that is not kept stops with
// its page, guest GL is never kept, and a stop saves the disk first.
//
//   node --test remote/test/hub.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { REMOTE_TAKEN_OVER, REMOTE_WIRE, decodeRemote, encodeRemote, type RemoteReply, type RemoteRequest } from "../wire.ts";
import { RemoteHub, type RemoteHost, type RemoteSocket } from "../backend.ts";
import { EVDEV_OP, type FromWorker, type ToWorker, type WorkerBootSpec, type WorkerEndpoint } from "../../js/core/worker-protocol.ts";
import type { DisplayMode } from "../../js/core/display.ts";

const KERNEL = "http://127.0.0.1:8787/assets/unkernel-test.wasm";
const DISTRO = "http://127.0.0.1:8787/distros/omarchy-0123456789abcdef.erofs";
const MODE: DisplayMode = { width: 4, height: 2, stride: 16, format: 0x34325258 };
const PIXELS = (fill: number) => new Uint8Array(4 * 4 * 2).fill(fill);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const events: string[] = [];
let spawned = 0;

/**
 * A worker the test drives. It records what the backend posts, answers sync,
 * and ends like the real one: its last message is "exit", then the thread
 * ends (the owner's exit listener). A stop or an abort ends it at once.
 */
class FakeWorker implements WorkerEndpoint {
	readonly posted: ToWorker[] = [];
	readonly id = spawned++;
	terminated = false;
	#handlers?: Parameters<WorkerEndpoint["listen"]>[0];

	constructor() {
		events.push(`spawn#${this.id}`);
	}

	post(m: ToWorker): void {
		this.posted.push(m);
		if (m.t === "sync") queueMicrotask(() => this.emit({ t: "synced", id: m.id, ok: true }));
		if (m.t === "stop") queueMicrotask(() => this.end(m.reason ?? "stopped"));
		if (m.t === "abort") queueMicrotask(() => this.end("aborted"));
	}

	listen(handlers: Parameters<WorkerEndpoint["listen"]>[0]): void {
		this.#handlers = handlers;
	}

	terminate(): void {
		this.terminated = true;
		events.push(`terminate#${this.id}`);
	}

	emit(m: FromWorker): void {
		this.#handlers?.message(m);
	}

	end(reason: string, kind: "stopped" | "halt" = "stopped"): void {
		this.emit({ t: "exit", result: { code: 0, reason, kind }, stats: {} as never, disks: [] });
		this.#handlers?.exit();
	}
}

class FakeSocket implements RemoteSocket {
	readonly frames: RemoteReply[] = [];
	readonly closes: Array<{ code: number; reason: string }> = [];

	send(frame: Uint8Array): void {
		this.frames.push(decodeRemote(frame) as RemoteReply);
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
	}

	kernel(): FromWorker[] {
		return this.frames.flatMap((f) => (f.k === "kernel" ? [f.m] : []));
	}

	hello(): Extract<RemoteReply, { k: "hello" }> {
		const h = this.frames.find((f): f is Extract<RemoteReply, { k: "hello" }> => f.k === "hello");
		assert.ok(h, "the page got a hello");
		return h;
	}
}

const fromPage = (m: ToWorker): Uint8Array => encodeRemote({ k: "kernel", m } satisfies RemoteRequest);

function spec(over: Partial<WorkerBootSpec> = {}): WorkerBootSpec {
	return {
		kernel: KERNEL,
		initrd: undefined,
		memoryMiB: 1024,
		statsIntervalMs: 500,
		disks: [{ kind: "data", template: "bundled", optional: true }],
		distro: { kind: "http", url: DISTRO, readOnly: true },
		display: { width: 4, height: 2, dpi: 96 },
		gpu: true,
		...over,
	};
}

function makeHub(logs: string[] = []) {
	const workers: FakeWorker[] = [];
	const host: RemoteHost = {
		file: async (url, role) => `/fake/${role}/${new URL(url).pathname.split("/").pop()}`,
		dataDisk: async () => "/fake/data/vm1.img",
		net: false,
		log: (line) => logs.push(line),
	};
	const hub = new RemoteHub(host, () => {
		const w = new FakeWorker();
		workers.push(w);
		return w;
	});
	return { hub, workers, logs };
}

/** A page boots and the worker reports it running, with a display, the console and a stats line. */
async function bootRunning(hub: RemoteHub, workers: FakeWorker[], keep: boolean, options: Partial<WorkerBootSpec> = {}) {
	const socket = new FakeSocket();
	const att = hub.attach(socket, { keep });
	hub.receive(att, fromPage({ t: "boot", spec: spec(options) }));
	await settle();
	const w = workers.at(-1)!;
	w.emit({ t: "started", cmdline: "console=hvc0", memoryMiB: 1024, memory64: false, stats: {} as never, disks: [], skipped: [] });
	w.emit({ t: "display", mode: MODE });
	w.emit({ t: "stats", stats: {} as never, disks: [] });
	return { socket, att, w };
}

test("a kept kernel outlives its page: a page that connects again resumes it with what it missed", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	a.w.emit({ t: "output", bytes: new TextEncoder().encode("login: ") });
	hub.receive(a.att, fromPage({ t: "frame-want", id: 1, now: true }));
	a.w.emit({ t: "frame", id: 1, mode: MODE, data: PIXELS(7) });
	assert.equal(a.socket.kernel().filter((m) => m.t === "frame").length, 1);

	hub.detach(a.att);
	assert.equal(a.w.terminated, false, "the kernel keeps running with no page");
	assert.ok(a.w.posted.some((m) => m.t === "evdev" && m.ops[0] === EVDEV_OP.releaseAll), "the input the page held is released");
	const sentWhileDetached = a.socket.frames.length;
	a.w.emit({ t: "stats", stats: {} as never, disks: [] });
	a.w.emit({ t: "frame", id: 2, mode: MODE, data: PIXELS(9) });
	assert.equal(a.socket.frames.length, sentWhileDetached, "nothing is sent to a page that has left");

	const b = new FakeSocket();
	const attB = hub.attach(b, { keep: true });
	const session = b.hello().session;
	assert.equal(session.machine?.state, "running");
	assert.equal(session.machine?.keep, true);
	hub.receive(attB, fromPage({ t: "boot", spec: spec() }));
	await settle();
	assert.equal(workers.length, 1, "no second kernel");
	assert.equal(a.w.posted.filter((m) => m.t === "boot").length, 1, "no second boot, so no second automatic command");

	const got = b.kernel().map((m) => m.t);
	assert.ok(got.indexOf("started") < got.indexOf("display"), "the page is shown the start first");
	assert.ok(got.includes("stats") && got.includes("output"));
	assert.deepEqual(a.w.posted.at(-1), { t: "frame-want", id: -1, now: true }, "a replay asks for the picture now");

	a.w.emit({ t: "frame", id: -1, mode: MODE, data: null });
	const replayed = b.kernel().filter((m): m is Extract<FromWorker, { t: "frame" }> => m.t === "frame");
	assert.equal(replayed.length, 1);
	assert.deepEqual([...replayed[0]!.data!], [...PIXELS(9)], "the unchanged picture is the last one the kernel sent");

	hub.receive(attB, fromPage({ t: "display-size", size: { width: 8, height: 4, dpi: 96 } }));
	await settle();
	assert.ok(a.w.posted.some((m) => m.t === "display-size"), "a resize reaches the resumed kernel");

	hub.detach(a.att);
	assert.equal(a.w.terminated, false, "the page the kernel left does not stop it when its close comes late");
	await hub.end("test over");
	assert.equal(a.w.terminated, true);
});

test("the console tail a detached kernel keeps is bounded", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	hub.detach(a.att);
	const chunk = new Uint8Array(64 * 1024).fill(0x41);
	for (let i = 0; i < 40; i++) a.w.emit({ t: "output", bytes: chunk });
	const b = new FakeSocket();
	const attB = hub.attach(b, { keep: true });
	hub.receive(attB, fromPage({ t: "boot", spec: spec() }));
	await settle();
	const outputs = b.kernel().flatMap((m) => (m.t === "output" ? [m.bytes] : []));
	assert.equal(outputs.length, 1);
	assert.ok(outputs[0]!.length <= 16 * 1024 && outputs[0]!.length > 0, `the tail is ${outputs[0]!.length} bytes`);
	await hub.end("test over");
});

test("a second page takes the kernel over: the first is closed for it, and its late messages and close change nothing", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	const b = new FakeSocket();
	const attB = hub.attach(b, { keep: true });
	assert.deepEqual(a.socket.closes, [{ code: REMOTE_TAKEN_OVER, reason: "another page took the desktop over" }]);

	const before = a.w.posted.length;
	hub.receive(a.att, fromPage({ t: "input", data: "x" }));
	assert.equal(a.w.posted.length, before, "a taken-over page's input is dropped");

	hub.detach(a.att);
	assert.equal(a.w.terminated, false, "the late close of the page taken over does not stop the kernel");

	hub.receive(attB, fromPage({ t: "boot", spec: spec() }));
	await settle();
	assert.equal(workers.length, 1);
	a.w.emit({ t: "stats", stats: {} as never, disks: [] });
	assert.ok(b.kernel().some((m) => m.t === "stats"), "the new page gets the kernel's messages");
	assert.equal(a.socket.kernel().filter((m) => m.t === "stats").length, 1, "and the page taken over does not");
	await hub.end("test over");
});

test("a page's boot that was taken over before it ran is ignored", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	const b = new FakeSocket();
	const attB = hub.attach(b, { keep: true });
	hub.receive(attB, fromPage({ t: "boot", spec: spec() }));
	const c = new FakeSocket();
	hub.attach(c, { keep: true });
	await settle();
	assert.equal(b.kernel().length, 0, "the page taken over before its boot gets nothing from the kernel");
	assert.equal(workers.length, 1);
	assert.equal(a.w.terminated, false);
	await hub.end("test over");
});

test("a kernel that its page did not keep stops with that page, and the next page boots once it has stopped", async () => {
	const logs: string[] = [];
	const { hub, workers } = makeHub(logs);
	const a = await bootRunning(hub, workers, false, { gpu: false });
	hub.detach(a.att);
	const b = new FakeSocket();
	const attB = hub.attach(b, { keep: false });
	assert.equal(b.hello().session.machine?.state, "ending", "a page that connects while the kernel stops is told so");
	hub.receive(attB, fromPage({ t: "boot", spec: spec({ gpu: false }) }));
	await settle();
	assert.deepEqual(events.slice(-3), [`spawn#${workers[0]!.id}`, `terminate#${workers[0]!.id}`, `spawn#${workers[1]!.id}`]);
	assert.ok(a.w.posted.some((m) => m.t === "sync") && a.w.posted.some((m) => m.t === "stop"), "the disk is saved before the stop");
	assert.match(logs.join("\n"), /does not outlive its page/);
	const c = new FakeSocket();
	hub.attach(c, { keep: false });
	assert.match(c.hello().session.ended ?? "", /does not outlive its page/);
	await hub.end("test over");
});

test("guest GL is never kept, even when its page asks to keep it", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true, { gpu: "virgl" });
	hub.detach(a.att);
	await settle();
	assert.equal(a.w.terminated, true, "the GL kernel stops with its page");
	await hub.end("test over");
});

test("a page that boots another kernel stops the kept one first, after its disk is saved", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	hub.detach(a.att);
	const b = new FakeSocket();
	const attB = hub.attach(b, { keep: true });
	hub.receive(attB, fromPage({ t: "boot", spec: spec({ distro: { kind: "http", url: DISTRO.replace("0123456789abcdef", "fedcba9876543210"), readOnly: true } }) }));
	await settle();
	assert.deepEqual(events.slice(-3), [`spawn#${workers[0]!.id}`, `terminate#${workers[0]!.id}`, `spawn#${workers[1]!.id}`]);
	assert.equal(b.kernel().filter((m) => m.t === "display").length, 0, "the new kernel's messages only, none of the old one's");
	await hub.end("test over");
});

test("a stop saves the disk first, also for a kept kernel with no page", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	hub.detach(a.att);
	await hub.end("the backend stops (SIGINT)");
	const order = workers[0]!.posted.map((m) => m.t);
	assert.ok(order.indexOf("sync") >= 0 && order.indexOf("sync") < order.indexOf("stop"), `${order.join(", ")}`);
	assert.equal(workers[0]!.terminated, true);
});

test("the guest's exit ends the kernel and closes the page it had, with the kernel stopped", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	workers[0]!.end("the guest powered off", "halt");
	await settle();
	assert.deepEqual(a.socket.closes.at(-1), { code: 1000, reason: "the kernel has stopped" });
	const b = new FakeSocket();
	hub.attach(b, { keep: true });
	assert.equal(b.hello().session.machine, null);
	assert.equal(b.hello().session.ended, "the guest powered off");
});

test("the page's report that it typed the command is kept with the kernel", async () => {
	const { hub, workers } = makeHub();
	const a = await bootRunning(hub, workers, true);
	hub.receive(a.att, encodeRemote({ k: "session", op: "typed" }));
	const b = new FakeSocket();
	hub.attach(b, { keep: true });
	assert.equal(b.hello().session.machine?.typed, true);
	await hub.end("test over");
});

test("a boot the backend refuses is reported to the page", async () => {
	const { hub } = makeHub();
	const a = new FakeSocket();
	const att = hub.attach(a, { keep: true });
	hub.receive(att, fromPage({ t: "boot", spec: spec({ cpus: 2 }) }));
	await settle();
	assert.deepEqual(a.kernel().find((m) => m.t === "boot-error"), { t: "boot-error", stage: "boot", message: "remote mode runs the kernel on one CPU" });
});

test("a frame that does not decode closes the page with 1003", () => {
	const { hub } = makeHub();
	const a = new FakeSocket();
	const att = hub.attach(a, { keep: true });
	hub.receive(att, new Uint8Array([1, 0, 0, 0, 0x7b]));
	assert.deepEqual(a.closes.at(-1), { code: 1003, reason: "bad frame" });
});

test("the hello carries the wire version and the kernel's state to a page that connects", () => {
	const { hub } = makeHub();
	const a = new FakeSocket();
	hub.attach(a, { keep: false });
	assert.equal(a.hello().wire, REMOTE_WIRE);
	assert.deepEqual(a.hello().session, { machine: null, ended: null });
});