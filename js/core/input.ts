// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The host side of kwinput (drivers/input/kwinput.c): a keyboard, a
// relative mouse and an absolute pointer (a tablet, like QEMU's usb-tablet)
// as evdev devices (event0, event1, event2), present when the host has a
// display. Games read the relative mouse (the embedder locks its pointer);
// desktops (X) read the tablet, so the host pointer moves in and out of
// the picture freely. Absolute positions are normalised: 0..1 across the
// picture, sent as ABS_X/ABS_Y over 0..ABS_MAX (X scales them to its
// screen, i.e. the framebuffer mode).
//
// Events are Linux input events (type, code, value; key codes from
// <linux/input-event-codes.h>). They are queued here, IRQ 5 (IRQ_INPUT) is
// raised, and the kernel pulls them with wasm_driver_input_read() into its
// own buffer (12 bytes each: u16 device, type, code, reserved; s32 value).
// The kernel reports through wasm_driver_input_state() which devices some
// program has open (the input_dev open/close callbacks, i.e. an open evdev
// file). Only then are new presses and motion queued: the embedder should
// send input to the guest's console instead while `open` is false. Releases
// of keys pressed while open always go through, and when a device closes
// with keys or buttons still down, they are released, so the kernel's key
// state never sticks. No import suspends.

export const EV_SYN = 0;
export const EV_KEY = 1;
export const EV_REL = 2;
export const EV_ABS = 3;
export const SYN_REPORT = 0;
export const REL_X = 0;
export const REL_Y = 1;
export const REL_WHEEL = 8;
export const ABS_X = 0;
export const ABS_Y = 1;
/** The tablet's ABS_X/ABS_Y range is 0..ABS_MAX. */
export const ABS_MAX = 32767;
export const BTN_LEFT = 0x110;
export const BTN_RIGHT = 0x111;
export const BTN_MIDDLE = 0x112;
/** kwinput device numbers (the bits of the open mask). */
export const INPUT_KEYBOARD = 0;
export const INPUT_MOUSE = 1;
export const INPUT_TABLET = 2;

const ENODEV = 19;
/** Queued events at most (each 4 numbers); further motion is dropped. */
const MAX_QUEUED = 4096;

/** Which kwinput devices some guest program has open. */
export interface InputState {
	keyboard: boolean;
	/** The relative mouse. */
	mouse: boolean;
	/** The absolute pointer (tablet). A kernel without it never sets this. */
	tablet: boolean;
}

/**
 * The evdev injection surface: InputHost inline, and in worker mode a
 * mirror on the owner's thread that forwards each call to the worker's
 * InputHost (worker-devices.ts). Return values say whether the guest gets
 * the event (in worker mode: as far as this thread knows the open state).
 */
export interface Evdev {
	/** Open mask: bit INPUT_KEYBOARD, INPUT_MOUSE, INPUT_TABLET. */
	readonly mask: number;
	readonly keyboardOpen: boolean;
	readonly mouseOpen: boolean;
	readonly tabletOpen: boolean;
	readonly state: InputState;
	key(code: number, down: boolean): boolean;
	button(code: number, down: boolean): boolean;
	move(dx: number, dy: number): boolean;
	wheel(clicks: number): boolean;
	moveTo(x: number, y: number): boolean;
	tabletButton(code: number, down: boolean): boolean;
	tabletWheel(clicks: number): boolean;
	releaseAll(): void;
}

export interface InputHostOptions {
	/** Offer the devices (the kernel registers them only then). Default false. */
	enabled?: boolean;
	/** The kernel's memory, read at call time. */
	memory: () => WebAssembly.Memory;
	/** Set IRQ_INPUT and wake the kernel. */
	raise: () => void;
	/** The open state changed. */
	onChange?: (state: InputState) => void;
}

/** What a machine snapshot keeps of kwinput (InputHost.saveState()). */
export interface InputSnapshot {
	/** Open mask. */
	mask: number;
	/** Keys and buttons the guest saw pressed. */
	keys: number[];
	buttons: number[];
	tabletButtons: number[];
	/** Events the guest had not read yet, flat: device, type, code, value. */
	queue: number[];
}

export interface InputStats {
	/** Events the kernel took. */
	delivered: number;
	/** Presses and motion dropped because no program had the device open, or the queue was full. */
	dropped: number;
}

export class InputHost implements Evdev {
	readonly enabled: boolean;
	/** Did the kernel ask (wasm_driver_input_init)? False for a kernel without kwinput. */
	probed = false;
	/** Open mask from the kernel: bit INPUT_KEYBOARD, INPUT_MOUSE, INPUT_TABLET. */
	mask = 0;
	stats: InputStats = { delivered: 0, dropped: 0 };
	/** Flat queue: device, type, code, value. */
	#queue: number[] = [];
	#keys = new Set<number>();
	#buttons = new Set<number>();
	#tabletButtons = new Set<number>();
	/** Last absolute position sent (device units), to skip repeats. */
	#abs: [number, number] = [-1, -1];
	#memory: () => WebAssembly.Memory;
	#raise: () => void;
	#onChange: ((state: InputState) => void) | undefined;

	constructor(opts: InputHostOptions) {
		this.enabled = !!opts.enabled;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.#onChange = opts.onChange;
	}

	/** Some program has the keyboard open. */
	get keyboardOpen(): boolean {
		return !!(this.mask & (1 << INPUT_KEYBOARD));
	}

	/** Some program has the mouse open. */
	get mouseOpen(): boolean {
		return !!(this.mask & (1 << INPUT_MOUSE));
	}

	/** Some program has the absolute pointer (tablet) open. */
	get tabletOpen(): boolean {
		return !!(this.mask & (1 << INPUT_TABLET));
	}

	get state(): InputState {
		return { keyboard: this.keyboardOpen, mouse: this.mouseOpen, tablet: this.tabletOpen };
	}

	/**
	 * Press (down = true) or release a key, by Linux key code (see
	 * domCodeToLinux()). Returns whether the guest gets it: a press only
	 * while the keyboard is open, a release only of a key it saw pressed.
	 * Repeats of a held key are ignored (the device has no EV_REP).
	 */
	key(code: number, down: boolean): boolean {
		if (down) {
			if (!this.keyboardOpen) return this.#drop();
			if (this.#keys.has(code)) return true;
			this.#keys.add(code);
		} else if (!this.#keys.delete(code)) return false;
		return this.#send(INPUT_KEYBOARD, [EV_KEY, code, down ? 1 : 0]);
	}

	/** Press or release a mouse button (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE); like key(). */
	button(code: number, down: boolean): boolean {
		if (down) {
			if (!this.mouseOpen) return this.#drop();
			if (this.#buttons.has(code)) return true;
			this.#buttons.add(code);
		} else if (!this.#buttons.delete(code)) return false;
		return this.#send(INPUT_MOUSE, [EV_KEY, code, down ? 1 : 0]);
	}

	/** Relative pointer motion in pixels (rounded); dropped while the mouse is closed. */
	move(dx: number, dy: number): boolean {
		dx = Math.round(dx);
		dy = Math.round(dy);
		if (!this.mouseOpen || this.#queue.length >= MAX_QUEUED * 4) return this.#drop();
		const ev: number[] = [];
		if (dx) ev.push(EV_REL, REL_X, dx);
		if (dy) ev.push(EV_REL, REL_Y, dy);
		return ev.length ? this.#send(INPUT_MOUSE, ev) : true;
	}

	/** Wheel clicks: positive = away from the user (up), as REL_WHEEL. */
	wheel(clicks: number): boolean {
		clicks = Math.round(clicks);
		if (!this.mouseOpen) return this.#drop();
		return clicks ? this.#send(INPUT_MOUSE, [EV_REL, REL_WHEEL, clicks]) : true;
	}

	/**
	 * Move the absolute pointer to (x, y), normalised: 0..1 from the left
	 * and top edges of the picture (clamped). For a pixel px of a mode
	 * `width` wide, x = (px + 0.5) / width lands on it. Dropped while the
	 * tablet is closed.
	 */
	moveTo(x: number, y: number): boolean {
		if (!this.tabletOpen || this.#queue.length >= MAX_QUEUED * 4) return this.#drop();
		const ax = Math.min(ABS_MAX, Math.max(0, Math.floor(x * (ABS_MAX + 1))));
		const ay = Math.min(ABS_MAX, Math.max(0, Math.floor(y * (ABS_MAX + 1))));
		const ev: number[] = [];
		if (ax !== this.#abs[0]) ev.push(EV_ABS, ABS_X, ax);
		if (ay !== this.#abs[1]) ev.push(EV_ABS, ABS_Y, ay);
		this.#abs = [ax, ay];
		return ev.length ? this.#send(INPUT_TABLET, ev) : true;
	}

	/** Press or release a button of the absolute pointer; like button(). */
	tabletButton(code: number, down: boolean): boolean {
		if (down) {
			if (!this.tabletOpen) return this.#drop();
			if (this.#tabletButtons.has(code)) return true;
			this.#tabletButtons.add(code);
		} else if (!this.#tabletButtons.delete(code)) return false;
		return this.#send(INPUT_TABLET, [EV_KEY, code, down ? 1 : 0]);
	}

	/** Wheel clicks on the absolute pointer; like wheel(). */
	tabletWheel(clicks: number): boolean {
		clicks = Math.round(clicks);
		if (!this.tabletOpen) return this.#drop();
		return clicks ? this.#send(INPUT_TABLET, [EV_REL, REL_WHEEL, clicks]) : true;
	}

	/** Release every key and button the guest saw pressed (e.g. when the page loses focus). */
	releaseAll(): void {
		for (const c of [...this.#keys]) this.key(c, false);
		for (const b of [...this.#buttons]) this.button(b, false);
		for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
	}

	/** The state a snapshot keeps. */
	saveState(): InputSnapshot {
		return {
			mask: this.mask, keys: [...this.#keys], buttons: [...this.#buttons], tabletButtons: [...this.#tabletButtons],
			queue: this.#queue.slice(),
		};
	}

	/**
	 * A restored snapshot: the kernel does not call init or report the open
	 * state again, so take them from the snapshot. The guest still gets the
	 * events it had not read, then a release of every key and button it saw
	 * pressed (the host's keys are not held in the new session).
	 */
	restoreState(s: InputSnapshot): void {
		this.probed = true;
		this.mask = s.mask >>> 0;
		this.#queue = s.queue.slice(0, MAX_QUEUED * 4);
		this.#keys = new Set(s.keys);
		this.#buttons = new Set(s.buttons);
		this.#tabletButtons = new Set(s.tabletButtons);
		this.#abs = [-1, -1];
		this.releaseAll();
		if (this.#queue.length) this.#raise();
		try { this.#onChange?.(this.state); } catch {}
	}

	#drop(): false {
		this.stats.dropped++;
		return false;
	}

	/** Queue triples (type, code, value) for one device, then SYN_REPORT, and raise the IRQ. */
	#send(dev: number, triples: number[]): true {
		for (let i = 0; i < triples.length; i += 3) this.#queue.push(dev, triples[i]!, triples[i + 1]!, triples[i + 2]!);
		this.#queue.push(dev, EV_SYN, SYN_REPORT, 0);
		this.#raise();
		return true;
	}

	imports(): Record<string, unknown> {
		return {
			wasm_driver_input_init: (): bigint => {
				this.probed = true;
				return this.enabled ? 0n : -BigInt(ENODEV);
			},
			wasm_driver_input_read: (buf: bigint, max: bigint): bigint => {
				const n = Math.min(Number(max), this.#queue.length / 4);
				if (!n) return 0n;
				const dv = new DataView(this.#memory().buffer, Number(buf), n * 12);
				const q = this.#queue;
				for (let i = 0; i < n; i++) {
					dv.setUint16(i * 12, q[i * 4]!, true);
					dv.setUint16(i * 12 + 2, q[i * 4 + 1]!, true);
					dv.setUint16(i * 12 + 4, q[i * 4 + 2]!, true);
					dv.setUint16(i * 12 + 6, 0, true);
					dv.setInt32(i * 12 + 8, q[i * 4 + 3]!, true);
				}
				q.splice(0, n * 4);
				this.stats.delivered += n;
				return BigInt(n);
			},
			wasm_driver_input_state: (mask: number): void => {
				const closed = this.mask & ~mask;
				this.mask = mask >>> 0;
				// A device closed with keys or buttons down: release them, so the
				// kernel's key state matches (the next press must be a change).
				if (closed & (1 << INPUT_KEYBOARD)) for (const c of [...this.#keys]) this.key(c, false);
				if (closed & (1 << INPUT_MOUSE)) for (const b of [...this.#buttons]) this.button(b, false);
				if (closed & (1 << INPUT_TABLET)) for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
				if (closed & (1 << INPUT_TABLET)) this.#abs = [-1, -1];
				try { this.#onChange?.(this.state); } catch {}
			},
		};
	}
}

/**
 * Linux key codes by DOM KeyboardEvent.code (the physical key, independent
 * of the layout), for a US-layout PC keyboard and the usual extra keys.
 */
export const DOM_CODE_TO_LINUX: Readonly<Record<string, number>> = (() => {
	const m: Record<string, number> = {
		Escape: 1, Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
		BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
		Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
		Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55,
		AltLeft: 56, Space: 57, CapsLock: 58, NumLock: 69, ScrollLock: 70,
		Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
		Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
		Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
		IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89, NumpadEnter: 96,
		ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
		Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
		End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
		AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115,
		Power: 116, NumpadEqual: 117, Pause: 119, NumpadComma: 121,
		IntlYen: 124, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
	};
	"1234567890".split("").forEach((d, i) => (m[`Digit${d}`] = 2 + i));
	const rows: Array<[string, number]> = [["QWERTYUIOP", 16], ["ASDFGHJKL", 30], ["ZXCVBNM", 44]];
	for (const [keys, base] of rows) keys.split("").forEach((k, i) => (m[`Key${k}`] = base + i));
	for (let i = 1; i <= 10; i++) m[`F${i}`] = 58 + i;
	for (let i = 13; i <= 24; i++) m[`F${i}`] = 170 + i;
	return Object.freeze(m);
})();

/** The Linux key code of a DOM KeyboardEvent.code, or undefined. */
export function domCodeToLinux(code: string): number | undefined {
	return DOM_CODE_TO_LINUX[code];
}

/** The evdev button of a DOM MouseEvent.button (0 left, 1 middle, 2 right), or undefined. */
export function domButtonToLinux(button: number): number | undefined {
	return button === 0 ? BTN_LEFT : button === 1 ? BTN_MIDDLE : button === 2 ? BTN_RIGHT : undefined;
}
