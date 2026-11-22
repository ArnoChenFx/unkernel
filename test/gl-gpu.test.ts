// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for virtio-gpu 3D's device side (core/gl-gpu.ts,
// VirglGpuBackend) against a fake renderer link: what blocks a snapshot (3D
// resources, contexts that submitted commands; not a context that only had
// buffers attached, as a Wayland relay's), and how a restored device makes
// such a context again in the renderer when a command first names it.
//
//   node --test test/gl-gpu.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { VirglGpuBackend, type GpuLink, type GpuRequest } from "../js/core/gl-gpu.ts";
import { GPU_CMD, type GpuBackendContext } from "../js/core/virtio-gpu.ts";

function fakeLink() {
	const sent: GpuRequest[] = [];
	const link: GpuLink = {
		init: Promise.resolve({ capsets: [], formats: new Uint32Array(512) }),
		start() {},
		call(req) {
			sent.push(req);
			return { code: 0 };
		},
		post(req) {
			sent.push(req);
		},
		reset() {},
	};
	return { link, sent };
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
	const { link, sent } = fakeLink();
	const b = new VirglGpuBackend(link);
	await link.init;
	return { b, sent };
}

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
