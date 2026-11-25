// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// The kiosk's Super key (remote/web/keys.ts) through the guest's evdev, the class the
// page drives in worker mode, without a browser. What the guest gets is the key ops
// the evdev sends, so a Super left down shows as a press with no release.
//
//   node --test remote/test/keys.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { INPUT_KEYBOARD } from "../../js/core/input.ts";
import { RemoteEvdev } from "../../js/core/worker-devices.ts";
import { EVDEV_OP, type ToWorker } from "../../js/core/worker-protocol.ts";
import { DEFAULT_MOD, KEY_LEFTMETA, parseMod, routeKey } from "../web/keys.ts";

const SUPER = KEY_LEFTMETA;
const T = 20;
const S = 31;
const B = 48;
const ENTER = 28;
const LEFTALT = 56;
const PAUSE = 119;

type Key = [code: number, down: boolean];
type Guest = ReturnType<typeof guest>;

/** A guest keyboard: the page's evdev, and the key events it sent since the last take(). */
function guest(open = true) {
	const sent: ToWorker[] = [];
	const ev = new RemoteEvdev((m) => sent.push(m));
	ev.setMask(open ? 1 << INPUT_KEYBOARD : 0);
	return {
		ev,
		take(): Key[] {
			ev.flush();
			const keys: Key[] = [];
			for (const m of sent.splice(0)) {
				if (m.t !== "evdev") continue;
				for (let i = 0; i < m.ops.length; i += 3) {
					if (m.ops[i] === EVDEV_OP.key) keys.push([m.ops[i + 1]!, m.ops[i + 2] === 1]);
				}
			}
			return keys;
		},
	};
}

const press = (g: Guest, mod: string | null, code: string) => routeKey(g.ev, mod, true, code);
const release = (g: Guest, mod: string | null, code: string) => routeKey(g.ev, mod, false, code);

test("parseMod takes the listed keys, none, and the default without a value", () => {
	assert.equal(DEFAULT_MOD, "Pause");
	assert.equal(parseMod(null), "Pause");
	assert.equal(parseMod(""), "Pause");
	assert.equal(parseMod("ScrollLock"), "ScrollLock");
	assert.equal(parseMod("none"), null);
	assert.equal(parseMod("pause"), undefined);
	assert.equal(parseMod("KeyA"), undefined);
	assert.equal(parseMod("F12"), undefined);
});

test("the mod key is Super in the guest while it is held", () => {
	const g = guest();
	assert.equal(press(g, "Pause", "Pause"), true);
	assert.deepEqual(g.take(), [[SUPER, true]]);
	assert.equal(release(g, "Pause", "Pause"), true);
	assert.deepEqual(g.take(), [[SUPER, false]]);
});

test("a key pressed with the mod key goes down and up inside Super", () => {
	const g = guest();
	press(g, "Pause", "Pause");
	press(g, "Pause", "KeyT");
	release(g, "Pause", "KeyT");
	release(g, "Pause", "Pause");
	assert.deepEqual(g.take(), [[SUPER, true], [T, true], [T, false], [SUPER, false]]);
});

test("auto-repeat of the mod key does not press Super again", () => {
	const g = guest();
	for (let i = 0; i < 4; i++) press(g, "Pause", "Pause");
	assert.deepEqual(g.take(), [[SUPER, true]]);
});

test("Alt keeps its own meaning with the mod key", () => {
	const g = guest();
	press(g, "Pause", "AltLeft");
	press(g, "Pause", "KeyB");
	release(g, "Pause", "KeyB");
	release(g, "Pause", "AltLeft");
	assert.deepEqual(g.take(), [[LEFTALT, true], [B, true], [B, false], [LEFTALT, false]]);
});

test("nothing reaches the guest while its keyboard is closed", () => {
	const g = guest(false);
	assert.equal(press(g, "Pause", "Pause"), true);
	assert.equal(press(g, "Pause", "KeyT"), false);
	assert.equal(release(g, "Pause", "KeyT"), false);
	assert.equal(release(g, "Pause", "Pause"), true);
	assert.deepEqual(g.take(), []);
});

test("closing the keyboard with Super down leaves nothing to release", () => {
	const g = guest();
	press(g, "Pause", "Pause");
	assert.deepEqual(g.take(), [[SUPER, true]]);
	g.ev.setMask(0);
	release(g, "Pause", "Pause");
	assert.deepEqual(g.take(), []);
	g.ev.setMask(1 << INPUT_KEYBOARD);
	press(g, "Pause", "Pause");
	assert.deepEqual(g.take(), [[SUPER, true]]);
});

test("blur releases Super, and the later release of the mod key sends nothing", () => {
	const g = guest();
	press(g, "Pause", "Pause");
	assert.deepEqual(g.take(), [[SUPER, true]]);
	g.ev.releaseAll();
	assert.deepEqual(g.take(), [[SUPER, false]]);
	release(g, "Pause", "Pause");
	press(g, "Pause", "Enter");
	release(g, "Pause", "Enter");
	assert.deepEqual(g.take(), [[ENTER, true], [ENTER, false]]);
});

test("F11 and F12 stay the browser's", () => {
	const g = guest();
	assert.equal(press(g, "Pause", "F11"), false);
	assert.equal(release(g, "Pause", "F11"), false);
	assert.equal(press(g, "Pause", "F12"), false);
	assert.equal(release(g, "Pause", "F12"), false);
	assert.deepEqual(g.take(), []);
});

test("none turns the mod key off, and Pause is an ordinary key again", () => {
	const g = guest();
	const mod = parseMod("none");
	assert.ok(mod !== undefined);
	assert.equal(press(g, mod, "Pause"), true);
	assert.equal(release(g, mod, "Pause"), true);
	assert.deepEqual(g.take(), [[PAUSE, true], [PAUSE, false]]);
});

test("a named mod key replaces Pause, and Pause is an ordinary key then", () => {
	const g = guest();
	const mod = parseMod("ScrollLock");
	assert.ok(mod !== undefined);
	press(g, mod, "ScrollLock");
	press(g, mod, "KeyS");
	release(g, mod, "KeyS");
	release(g, mod, "ScrollLock");
	press(g, mod, "Pause");
	release(g, mod, "Pause");
	assert.deepEqual(g.take(), [[SUPER, true], [S, true], [S, false], [SUPER, false], [PAUSE, true], [PAUSE, false]]);
});

test("a key the page does not map is taken while the keyboard is open, and sends nothing", () => {
	const g = guest();
	assert.equal(press(g, "Pause", "Unidentified"), true);
	assert.equal(release(g, "Pause", "Unidentified"), true);
	assert.deepEqual(g.take(), []);
});
