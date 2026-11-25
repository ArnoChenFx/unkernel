// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// The kiosk's picture (remote/web/picture.ts) without a browser: the canvas is
// a stand-in whose bitmap is cleared by assigning its width or height, even to
// the size it has, as a browser clears it.
//
//   node --test remote/test/picture.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { GONE_MS, Picture, type PictureContext, type PictureMode, type PictureCanvas } from "../web/picture.ts";

/** A canvas whose picture is a label, null when blank. */
class FakeCanvas implements PictureCanvas {
	#width = 640;
	#height = 480;
	picture: string | null = null;
	/** Assignments of width or height: each one clears the picture. */
	assignments = 0;
	readonly #context: PictureContext = {
		drawImage: (image) => {
			if (image instanceof FakeCanvas && image.picture !== null) this.picture = image.picture;
		},
	};

	get width(): number {
		return this.#width;
	}
	set width(v: number) {
		this.#width = v;
		this.picture = null;
		this.assignments++;
	}
	get height(): number {
		return this.#height;
	}
	set height(v: number) {
		this.#height = v;
		this.picture = null;
		this.assignments++;
	}
	getContext(kind: "2d"): PictureContext | null {
		return kind === "2d" ? this.#context : null;
	}
}

const WIDE: PictureMode = { width: 1248, height: 676 };
const LARGER: PictureMode = { width: 1344, height: 758 };

function setup() {
	const canvas = new FakeCanvas();
	const said: string[] = [];
	const state = { visible: false };
	const picture = new Picture({
		canvas,
		spare: () => new FakeCanvas(),
		say: (title) => {
			said.push(title);
			state.visible = false;
		},
		show: () => {
			state.visible = true;
		},
	});
	const paint = (frame: PictureMode, label: string) => picture.paint(frame, () => {
		canvas.picture = label;
	});
	return { canvas, picture, said, paint, state };
}

test("a display that reports its mode again leaves the canvas alone", () => {
	const { canvas, picture, paint, state } = setup();
	picture.display(WIDE);
	assert.equal(paint(WIDE, "frame 1"), true);
	const assignments = canvas.assignments;
	for (let i = 0; i < 1000; i++) picture.display({ ...WIDE });
	assert.equal(canvas.assignments, assignments);
	assert.equal(canvas.picture, "frame 1");
	assert.equal(state.visible, true);
});

test("the picture is shown from its first painted frame", () => {
	const { picture, paint, state } = setup();
	picture.display(WIDE);
	assert.equal(state.visible, false);
	paint(WIDE, "frame 1");
	assert.equal(state.visible, true);
});

test("a put that paints nothing is not a painted frame", () => {
	const { picture, paint, state } = setup();
	picture.display(WIDE);
	assert.equal(picture.paint(WIDE, () => false), false);
	assert.equal(state.visible, false);
	assert.equal(picture.paint(WIDE, () => true), true);
	assert.equal(state.visible, true);
	assert.equal(paint(WIDE, "frame"), true);
});

test("nothing is painted while the display is closed", () => {
	const { picture, paint } = setup();
	assert.equal(paint(WIDE, "frame"), false);
	picture.display(WIDE);
	picture.display(null);
	assert.equal(paint(WIDE, "frame"), false);
});

test("a frame of the previous mode is not painted over a new mode", () => {
	const { canvas, picture, paint } = setup();
	picture.display(WIDE);
	paint(WIDE, "frame 1");
	picture.display(LARGER);
	assert.equal(paint(WIDE, "in flight"), false);
	assert.equal(canvas.picture, "frame 1");
	assert.equal(paint(LARGER, "frame 2"), true);
	assert.equal(canvas.picture, "frame 2");
});

test("a new size keeps the last picture until a frame of that size paints", () => {
	const { canvas, picture, paint } = setup();
	picture.display(WIDE);
	paint(WIDE, "frame 1");
	picture.display(LARGER);
	assert.equal(canvas.width, LARGER.width);
	assert.equal(canvas.height, LARGER.height);
	assert.equal(canvas.picture, "frame 1");
});

test("a new size before any frame keeps nothing", () => {
	const { canvas, picture } = setup();
	picture.display(WIDE);
	picture.display(LARGER);
	assert.equal(canvas.picture, null);
});

test("a closed display keeps the picture and says the desktop closed only if it stays closed", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { canvas, picture, paint, said } = setup();
	picture.display(WIDE);
	paint(WIDE, "frame 1");
	picture.display(null);
	assert.equal(canvas.picture, "frame 1");
	t.mock.timers.tick(GONE_MS - 1);
	assert.deepEqual(said, []);
	t.mock.timers.tick(1);
	assert.deepEqual(said, ["The desktop closed"]);
	assert.equal(canvas.picture, "frame 1");
});

test("a display that comes back in time says nothing", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { canvas, picture, paint, said } = setup();
	picture.display(WIDE);
	paint(WIDE, "frame 1");
	picture.display(null);
	t.mock.timers.tick(GONE_MS / 2);
	picture.display(LARGER);
	t.mock.timers.tick(GONE_MS * 2);
	assert.deepEqual(said, []);
	assert.equal(canvas.picture, "frame 1");
});

test("the machine stopping is not overridden by a pending close", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { picture, paint, said } = setup();
	picture.display(WIDE);
	paint(WIDE, "frame 1");
	picture.display(null);
	picture.stopped("The machine stopped", "exit 0");
	t.mock.timers.tick(GONE_MS * 2);
	assert.deepEqual(said, ["The machine stopped"]);
});

test("a stopped machine paints nothing more", () => {
	const { canvas, picture, paint, state } = setup();
	picture.display(WIDE);
	paint(WIDE, "frame 1");
	picture.stopped("The machine stopped", "exit 0");
	assert.equal(state.visible, false);
	assert.equal(paint(WIDE, "late"), false);
	assert.equal(canvas.picture, "frame 1");
});
