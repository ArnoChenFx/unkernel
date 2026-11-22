// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for virtio-gpu 3D's device side (core/gl-gpu.ts,
// VirglGpuBackend) against a fake renderer link: a dumb-buffer KMS client
// leaves the renderer unloaded, the contexts made before it loads are made
// first when it does, what blocks a snapshot (3D
// resources, contexts that submitted commands; not a context that only had
// buffers attached, as a Wayland relay's), and how a restored device makes
// such a context again in the renderer when a command first names it. And
// the renderer side (GpuRenderer) against fake renderer cores: a lost
// WebGL2 context, the stale ids it leaves, a new renderer for the next new
// GL context, twice, and without `renew` a final loss.
//
//   node --test test/gl-gpu.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { GpuRenderer, VIRGL_CAPSETS, VirglGpuBackend, type GpuLink, type GpuRendererCore, type GpuRequest } from "../js/core/gl-gpu.ts";
import { GPU_CMD, GPU_RESP, type GpuBackendContext } from "../js/core/virtio-gpu.ts";

function fakeLink() {
	const sent: GpuRequest[] = [];
	const starts: number[] = [];
	const link: GpuLink = {
		init: Promise.resolve({ capsets: [], formats: new Uint32Array(512) }),
		start() {
			starts.push(sent.length);
		},
		call(req) {
			sent.push(req);
			return { code: 0 };
		},
		post(req) {
			sent.push(req);
		},
		reset() {},
	};
	return { link, sent, starts };
}

const ctx: GpuBackendContext = { memory: () => new WebAssembly.Memory({ initial: 1 }), backing: () => null };

/** A command: header (type, ctx_id) and then little-endian words. */
function cmd(type: number, ctxId: number, words: number[] = []): Uint8Array {
	const b = new Uint8Array(24 + 4 * Math.max(words.length, 18));
	const dv = new DataView(b.buffer);
	dv.setUint32(0, type, true);
	dv.setUint32(16, ctxId, true);
	words.forEach((w, i) => dv.setUint32(24 + 4 * i, w, true));
	return b;
}

/** RESOURCE_CREATE_3D of a 64x64 B8G8R8X8 texture. */
const create3d = (id: number) => cmd(GPU_CMD.RESOURCE_CREATE_3D, 0, [id, 2, 2, 2 | 8, 64, 64, 1, 1, 0, 0, 0]);
const sentAs = (sent: GpuRequest[]) => sent.map((r) => {
	const dv = new DataView(r.cmd.buffer, r.cmd.byteOffset);
	return `${dv.getUint32(0, true).toString(16)}:${dv.getUint32(16, true)}`;
});

async function backend() {
	const { link, sent, starts } = fakeLink();
	const b = new VirglGpuBackend(link);
	await link.init;
	return { b, sent, starts };
}

test("a dumb-buffer KMS client does not load the renderer", async () => {
	const { b, sent, starts } = await backend();
	// what the driver sends for kms-dumb with virgl on: its DRM file's context
	// at the first dumb buffer (resource 2, a 2D one), the scanout off, the exit
	b.command(cmd(GPU_CMD.CTX_CREATE, 1), ctx);
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 1, [2]), ctx);
	b.command(cmd(GPU_CMD.SET_SCANOUT, 0, [0, 0, 0, 0, 0, 0]), ctx);
	b.command(cmd(GPU_CMD.CTX_DETACH_RESOURCE, 1, [2]), ctx);
	b.command(cmd(GPU_CMD.CTX_DESTROY, 1), ctx);
	// a context from before a restore, used for dumb buffers only
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 7, [3]), ctx);
	b.command(cmd(GPU_CMD.CTX_DESTROY, 7), ctx);
	assert.deepEqual(starts, []);
	assert.deepEqual(sentAs(sent), []);
	assert.equal(b.blocker(), "");
});

test("contexts made before the renderer loads are made there first when it does", async () => {
	const { b, sent, starts } = await backend();
	b.command(cmd(GPU_CMD.CTX_CREATE, 1), ctx);
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 1, [2]), ctx);
	b.command(cmd(GPU_CMD.CTX_CREATE, 3), ctx);
	b.command(cmd(GPU_CMD.CTX_DESTROY, 3), ctx);
	// a GL client (another file): its context, then the first 3D resource
	b.command(cmd(GPU_CMD.CTX_CREATE, 4), ctx);
	assert.deepEqual(starts, []);
	b.command(create3d(9), ctx);
	assert.deepEqual(starts, [0]);
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 4, [9]), ctx);
	b.command(cmd(GPU_CMD.SUBMIT_3D, 4, [0, 0]), ctx);
	assert.deepEqual(sentAs(sent), ["200:1", "200:4", "204:0", "202:4", "207:4"]);
	// the held CTX_CREATE as the guest sent it (its debug name)
	assert.equal(sent[0]!.cmd.length, cmd(GPU_CMD.CTX_CREATE, 1).length);
	// once loaded, contexts go to the renderer as they come
	b.command(cmd(GPU_CMD.CTX_CREATE, 5), ctx);
	b.command(cmd(GPU_CMD.CTX_DESTROY, 1), ctx);
	assert.deepEqual(sentAs(sent).slice(5), ["200:5", "201:1"]);
	assert.equal(b.blocker(), "virtio-gpu resources");
});

test("a context that only had buffers attached does not block a snapshot", async () => {
	const { b } = await backend();
	b.command(cmd(GPU_CMD.CTX_CREATE, 1), ctx);
	assert.equal(b.blocker(), "");
	b.command(create3d(5), ctx);
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 1, [5]), ctx);
	assert.equal(b.blocker(), "virtio-gpu resources");
	b.command(cmd(GPU_CMD.CTX_DETACH_RESOURCE, 1, [5]), ctx);
	b.command(cmd(GPU_CMD.RESOURCE_UNREF, 0, [5]), ctx);
	assert.equal(b.blocker(), "");
});

test("a context that submitted blocks a snapshot until it is destroyed", async () => {
	const { b } = await backend();
	b.command(cmd(GPU_CMD.CTX_CREATE, 2), ctx);
	b.command(cmd(GPU_CMD.SUBMIT_3D, 2, [0, 0]), ctx);
	assert.equal(b.blocker(), "virtio-gpu contexts");
	b.command(cmd(GPU_CMD.CTX_DESTROY, 2), ctx);
	assert.equal(b.blocker(), "");
});

test("a restored device makes a context from before the restore again, once", async () => {
	const { b, sent } = await backend();
	// the guest's kernel still has context 7 (made before the snapshot); a
	// new client's buffer is imported by its file
	b.command(create3d(9), ctx);
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 7, [9]), ctx);
	b.command(cmd(GPU_CMD.CTX_DETACH_RESOURCE, 7, [9]), ctx);
	assert.deepEqual(sentAs(sent), ["204:0", "200:7", "202:7", "203:7"]);
	const made = sent[1]!.cmd;
	assert.equal(made.length, 24 + 72);
	// a context this side saw made is not made twice
	b.command(cmd(GPU_CMD.CTX_CREATE, 8), ctx);
	b.command(cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 8, [9]), ctx);
	assert.deepEqual(sentAs(sent).slice(4), ["200:8", "202:8"]);
	b.command(cmd(GPU_CMD.RESOURCE_UNREF, 0, [9]), ctx);
	assert.equal(b.blocker(), "");
});

/** A renderer core whose module records the commands it runs and whose context can be lost. */
function fakeCore(name: string) {
	const canvas = new EventTarget();
	let lost = false;
	const ran: string[] = [];
	const gpu = {
		buffer: (n: number) => new Uint8Array(n),
		command(c: Uint8Array) {
			const dv = new DataView(c.buffer, c.byteOffset);
			const type = dv.getUint32(0, true);
			ran.push(`${type.toString(16)}:${dv.getUint32(16, true)}${type === GPU_CMD.RESOURCE_CREATE_3D || type === GPU_CMD.RESOURCE_UNREF ? `/${dv.getUint32(24, true)}` : ""}`);
			return 0;
		},
		capset: (id: number) => {
			const c = VIRGL_CAPSETS.find((x) => x.id === id)!;
			return { version: c.version, data: new Uint8Array(c.size) };
		},
		format: () => 0x40101,
		fence: () => 1,
		fencesDone: () => 1,
		info: () => null,
		present: () => 0,
		read: () => null,
	};
	const core = { gpu, gl: { canvas, isContextLost: () => lost } } as unknown as GpuRendererCore;
	return {
		core, ran, name,
		lose() {
			lost = true;
			canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
		},
	};
}

/** Send a command as the device side would: fenced ones by call(), the others by post(). */
async function send(r: GpuRenderer, c: Uint8Array, fenced = false): Promise<number> {
	if (fenced) new DataView(c.buffer).setUint32(4, 1, true);
	if (!fenced) {
		r.post({ cmd: c });
		return 0;
	}
	return (await r.call({ cmd: c })).code;
}

test("a lost WebGL2 context: stale ids fail, the next new GL context gets a new renderer, twice", async () => {
	const cores = [fakeCore("first"), fakeCore("second"), fakeCore("third")];
	let next = 1;
	const lines: string[] = [];
	const r = new GpuRenderer(async () => cores[0]!.core, { renew: async () => cores[next++]!.core, log: (s) => lines.push(s) });
	r.start();
	await r.init;
	const [a, b, c] = cores as [ReturnType<typeof fakeCore>, ReturnType<typeof fakeCore>, ReturnType<typeof fakeCore>];
	// a GL program (context 1, resource 5, submitted) and a relay's context 2 (never submitted)
	await send(r, cmd(GPU_CMD.CTX_CREATE, 1));
	await send(r, cmd(GPU_CMD.CTX_CREATE, 2));
	await send(r, create3d(5));
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 1, [0]), true), 0);
	a.lose();
	assert.equal(r.stats.contextLost, true);
	assert.equal(r.stats.losses, 1);
	// while lost: everything fails at once, but destroy, unref, detach
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 1, [0]), true), GPU_RESP.ERR_UNSPEC);
	assert.equal(await send(r, cmd(GPU_CMD.TRANSFER_FROM_HOST_3D, 1, [0, 0, 0, 1, 1, 1, 0, 0, 5]), true), GPU_RESP.ERR_UNSPEC);
	assert.equal(await send(r, cmd(GPU_CMD.CTX_DETACH_RESOURCE, 1, [5]), true), 0);
	assert.equal(r.image(5), null);
	assert.equal(r.texture(5), null);
	const ranBefore = a.ran.length;
	// a new program: its context makes a new renderer; the commands after it wait for it
	await send(r, cmd(GPU_CMD.CTX_CREATE, 3));
	await send(r, create3d(6));
	const submit = send(r, cmd(GPU_CMD.SUBMIT_3D, 3, [0]), true);
	assert.equal(await submit, 0);
	assert.equal(a.ran.length, ranBefore, "no call into the lost renderer");
	assert.equal(r.stats.contextLost, false);
	assert.equal(r.stats.renewals, 1);
	// the relay's context is made again first, then the new program's commands
	assert.deepEqual(b.ran, ["200:2", "200:3", "204:0/6", "207:3"]);
	// the old program: its context and resource are stale
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 1, [0]), true), GPU_RESP.ERR_UNSPEC);
	assert.equal(await send(r, cmd(GPU_CMD.TRANSFER_TO_HOST_3D, 3, [0, 0, 0, 1, 1, 1, 0, 0, 5]), true), GPU_RESP.ERR_UNSPEC);
	assert.match(r.stats.lastError, /lost: restart the program/);
	// ... and dropped where nothing is left to do
	assert.equal(await send(r, cmd(GPU_CMD.RESOURCE_UNREF, 0, [5]), true), 0);
	assert.equal(await send(r, cmd(GPU_CMD.CTX_DESTROY, 1), true), 0);
	assert.deepEqual(b.ran.slice(4), [], "stale ids never reach the new renderer");
	// the relay's context attaches a new client's buffer in the new renderer
	assert.equal(await send(r, cmd(GPU_CMD.CTX_ATTACH_RESOURCE, 2, [6]), true), 0);
	assert.deepEqual(b.ran.slice(4), ["202:2"]);
	// a second loss and a second new renderer
	b.lose();
	assert.equal(r.stats.losses, 2);
	await send(r, cmd(GPU_CMD.CTX_CREATE, 4));
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 4, [0]), true), 0);
	assert.equal(r.stats.renewals, 2);
	// context 2 never submitted: made again; 3 submitted: stale
	assert.deepEqual(c.ran, ["200:2", "200:4", "207:4"]);
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 3, [0]), true), GPU_RESP.ERR_UNSPEC);
	assert.ok(lines.some((l) => /next GL program gets a new renderer/.test(l)));
});

test("without renew a lost WebGL2 context is final", async () => {
	const a = fakeCore("only");
	const r = new GpuRenderer(async () => a.core);
	r.start();
	await r.init;
	await send(r, cmd(GPU_CMD.CTX_CREATE, 1));
	a.lose();
	await send(r, cmd(GPU_CMD.CTX_CREATE, 2));
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 2, [0]), true), GPU_RESP.ERR_UNSPEC);
	assert.equal(r.stats.contextLost, true);
	assert.equal(r.stats.renewals, 0);
	assert.deepEqual(a.ran, ["200:1"]);
});

test("a new renderer that cannot be made: the new context fails too, and nothing waits", async () => {
	const a = fakeCore("only");
	let tries = 0;
	const r = new GpuRenderer(async () => a.core, { renew: async () => { tries++; throw new Error("no WebGL2 context"); } });
	r.start();
	await r.init;
	a.lose();
	await send(r, cmd(GPU_CMD.CTX_CREATE, 2));
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 2, [0]), true), GPU_RESP.ERR_UNSPEC);
	assert.equal(tries, 1);
	assert.match(r.stats.lastError, /no new renderer could be made: no WebGL2 context/);
	// within a second the next context does not try again
	await send(r, cmd(GPU_CMD.CTX_CREATE, 3));
	assert.equal(await send(r, cmd(GPU_CMD.SUBMIT_3D, 3, [0]), true), GPU_RESP.ERR_UNSPEC);
	assert.equal(tries, 1);
	assert.equal(r.stats.contextLost, true);
});
