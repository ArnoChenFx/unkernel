// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// The remote pages' guest GL, what needs no browser: the ?gl=1 gate, the
// software WebGL2 names and the note the kiosk and the desktop show
// (remote/web/gl.ts). The renderer itself is tested in test/gl-gpu.test.ts.
//
//   node --test remote/test/gl.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { glAsked, glNote, softwareName } from "../web/gl.ts";

const SWIFTSHADER = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
const NVIDIA = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)";

test("guest GL is asked for by ?gl=1 only", () => {
	assert.equal(glAsked("?gl=1"), true);
	assert.equal(glAsked("?remote=1&gl=1"), true);
	assert.equal(glAsked(""), false);
	assert.equal(glAsked("?gl=0"), false);
	assert.equal(glAsked("?gl"), false);
	assert.equal(glAsked("?gl=true"), false);
});

test("a software WebGL2 is named, a GPU's name is not", () => {
	assert.equal(softwareName(SWIFTSHADER), "SwiftShader");
	assert.equal(softwareName("llvmpipe (LLVM 19.1.7, 256 bits)"), "llvmpipe");
	assert.equal(softwareName("Google Inc. (Mesa Offscreen)"), null);
	assert.equal(softwareName(NVIDIA), null);
	assert.equal(softwareName(null), null);
});

test("the note is absent until guest GL is asked for", () => {
	assert.equal(glNote(false, { state: "ready", webgl: SWIFTSHADER, error: null }, null), null);
});

test("the note says why there is no renderer", () => {
	assert.equal(glNote(true, null, "this browser has no WebGL2 on the page's thread"), "guest GL off: this browser has no WebGL2 on the page's thread");
	assert.equal(glNote(true, null, null), "guest GL off: no renderer");
	assert.equal(glNote(true, { state: "failed", webgl: null, error: "the module did not load" }, null), "guest GL off: the module did not load");
});

test("the note walks through the renderer's states", () => {
	assert.equal(glNote(true, { state: "idle", webgl: null, error: null }, null), "guest GL: the renderer loads on the guest's first GL use");
	assert.equal(glNote(true, { state: "loading", webgl: null, error: null }, null), "guest GL: loading the renderer");
	assert.equal(glNote(true, { state: "lost", webgl: NVIDIA, error: "a GPU reset" }, null), "guest GL: the WebGL2 context was lost, and the guest's GL programs stop; reload this page (a GPU reset)");
});

test("a ready renderer on SwiftShader says it is software, not a GPU", () => {
	const note = glNote(true, { state: "ready", webgl: SWIFTSHADER, error: null }, null);
	assert.ok(note?.includes("software (SwiftShader), not a GPU"), note ?? "null");
	assert.ok(note?.startsWith("guest GL: virgl on WebGL2, ANGLE"), note ?? "null");
});

test("a ready renderer on another WebGL2 is named without a software or GPU claim", () => {
	const note = glNote(true, { state: "ready", webgl: NVIDIA, error: null }, null);
	assert.equal(note, `guest GL: virgl on WebGL2, ${NVIDIA}`);
	assert.ok(!note?.includes("software"));
	assert.ok(!note?.includes("GPU"));
});
