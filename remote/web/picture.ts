// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// The kiosk's picture without the DOM: remote/web/kiosk.ts draws the guest's
// display with it, and remote/test/picture.test.ts runs it under Node. What
// the canvas keeps across the events that are not the end of the picture:
//   - the display reports the mode it shows again (a double-buffered program
//     does at every flip, at the same size): the canvas is not touched.
//     Assigning its width or height clears the bitmap, even to the size it
//     has, so each report would blank the picture until the next frame;
//   - the mode changes size (the window was resized): the last picture is
//     kept, stretched to the new size, until a frame of that mode paints over it;
//   - the display closes for a moment (a mode change lets go of it): the
//     picture stays, and the page says the desktop closed only if it stays
//     closed for GONE_MS;
//   - the machine stops: the status says so, and nothing pending overrides it.

/** How long a closed display may stay closed before the desktop counts as closed. */
export const GONE_MS = 8000;

/** The size of the guest's display, in pixels. */
export interface PictureMode {
	width: number;
	height: number;
}

/** The canvas the picture is drawn on, or a stand-in for it. */
export interface PictureCanvas {
	width: number;
	height: number;
	getContext(kind: "2d"): PictureContext | null;
}

export interface PictureContext {
	/** `image` is a PictureCanvas (or the canvas element it stands for). */
	drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
}

export interface PictureHost {
	canvas: PictureCanvas;
	/** A canvas to keep the last picture in while the canvas changes size. */
	spare(): PictureCanvas;
	/** Says a title and its detail; the picture is hidden while it is said. */
	say(title: string, more?: string): void;
	/** Shows the picture. */
	show(): void;
}

export class Picture {
	/** The mode the display shows, null while it is closed. */
	mode: PictureMode | null = null;
	readonly #host: PictureHost;
	/** A frame has been painted: the canvas holds a picture, which is kept and shown from now on. */
	#painted = false;
	#gone: ReturnType<typeof setTimeout> | undefined;

	constructor(host: PictureHost) {
		this.#host = host;
	}

	/** The display opened or changed its mode (m), or closed (null). */
	display(m: PictureMode | null): void {
		this.#cancelGone();
		if (!m) {
			this.mode = null;
			if (this.#painted) this.#gone = setTimeout(() => this.#host.say("The desktop closed", "reload this page to start it again"), GONE_MS);
			return;
		}
		this.mode = { width: m.width, height: m.height };
		this.#fit(m.width, m.height);
		if (this.#painted) this.#host.show();
	}

	/**
	 * Paints a frame of the display's mode (`frame` is its size, null when there
	 * is none) by calling `put`, which returns false when it painted nothing (a
	 * guest GL frame that was drawn already). A frame of another size is the
	 * previous mode's, still in flight after a display report: it is not painted.
	 * True when painted.
	 */
	paint(frame: PictureMode | null, put: () => boolean | void): boolean {
		const m = this.mode;
		if (!m || !frame || frame.width !== m.width || frame.height !== m.height) return false;
		if (put() === false) return false;
		if (!this.#painted) {
			this.#painted = true;
			this.#host.show();
		}
		return true;
	}

	/** The machine stopped: no display any more, and no pending close says anything else. */
	stopped(title: string, more?: string): void {
		this.#cancelGone();
		this.mode = null;
		this.#host.say(title, more);
	}

	#cancelGone(): void {
		clearTimeout(this.#gone);
		this.#gone = undefined;
	}

	#fit(width: number, height: number): void {
		const c = this.#host.canvas;
		if (c.width === width && c.height === height) return;
		let last: PictureCanvas | undefined;
		if (this.#painted) {
			last = this.#host.spare();
			last.width = c.width;
			last.height = c.height;
			last.getContext("2d")?.drawImage(c, 0, 0);
		}
		c.width = width;
		c.height = height;
		if (last) c.getContext("2d")?.drawImage(last, 0, 0, width, height);
	}
}
