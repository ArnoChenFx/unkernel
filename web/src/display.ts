// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's display and input on the page (kwfb, kwinput; on unless
// ?display=0). This module is the part the SDK calls (boot.ts passes it to
// createKernel): the mode offered to the guest, the display and input state
// (in the store), and keyboard routing. components/Display.tsx draws it:
// the canvas, the backdrop, mouse and touch input and the touch controls.
// - the mode: when a program first opens /dev/fb0 the kernel asks for a
//   size, and gets the stage's (the area above the status line) in CSS
//   pixels (size()); it may pick less (at most 1M pixels: divided by an
//   integer), and a program may set its own;
// - rotation: on touch devices, while the page is portrait and the rotate
//   option is on (off by default; kept in localStorage), the display is drawn
//   a quarter turn clockwise over the whole page, status line included, so
//   the phone is held sideways. The mode offered is then the page's size
//   turned (landscape). Turning the phone itself makes the page landscape,
//   and then nothing is rotated;
// - full screen (the touch controls' chip): the Fullscreen API on the page,
//   then a landscape orientation lock where the browser allows one in full
//   screen (Android Chrome), which makes the page landscape so nothing is
//   rotated. Only after a tap: browsers refuse it without a user gesture.
//   iPhone Safari has no element full screen (iPad does): there the chip
//   says, in a toast, to add the page to the home screen, which opens it
//   without Safari's bars (index.html's apple-mobile-web-app-capable); it
//   is left out once the page runs that way. A refused request is a toast
//   too;
// - keyboard routing: while a program has the evdev keyboard open, keys go
//   there (by KeyboardEvent.code) and never to the terminal; otherwise the
//   terminal gets them as before. With the display switched to the terminal
//   (the bar's toggle), typing goes to the shell;
// - worker mode (?worker=1): the same, through the WorkerKernel's mirror of
//   evdev (its open state follows onInput; calls are forwarded in order).
//   The kernel cannot ask this thread for the size when a program opens
//   /dev/fb0, so the SDK asks size() ahead of time: at boot and on every
//   terminal resize; offerSize() covers the window resizing and the rotate
//   option.
import { WorkerKernel, domCodeToLinux, type DisplayMode, type InputState, type KernelInstance } from "./sdk.ts";
import { useSyncExternalStore } from "react";
import { ui$, type PadLayout, type TouchMode } from "./store.ts";
import { store } from "./ui.ts";

export interface DisplayUiOptions {
	/** The kernel: inline, or in a worker (?worker=1). */
	vm: () => KernelInstance | WorkerKernel | null;
	/** Show the touch overlay (a touch device). */
	touch: boolean;
	/** Type into the guest console. */
	sendTty: (s: string) => void;
	/** The terminal is in application cursor mode (arrows as ESC O x). */
	appCursor: () => boolean;
	/** Give the terminal the keyboard focus. */
	focusTerminal: () => void;
}

export interface DisplayUi {
	/** The size to offer the guest: the stage, in CSS pixels. */
	size(): { width: number; height: number; dpi: number };
	onDisplay(mode: DisplayMode | null): void;
	onInput(state: InputState): void;
}

let current: DisplayUiOptions | null = null;
let stageEl: HTMLElement | null = null;

/** What Display.tsx needs from boot.ts (null until the boot module runs). */
export const displayOpts = (): DisplayUiOptions | null => current;
/** The stage (components/App.tsx): the area the display fills. */
export const setStage = (el: HTMLElement | null): void => { stageEl = el; };
export const evdev = () => current?.vm()?.evdev;
/** The canvas holds pointer lock (components/Display.tsx). */
export const pointerLocked = (): boolean => (document.pointerLockElement as HTMLElement | null)?.id === "fb";

/** The page (#app, the stage's parent): the area the display covers when rotated. */
const appEl = (): HTMLElement | null => stageEl?.closest<HTMLElement>("#app") ?? null;

/** The display is drawn a quarter turn round: a touch device, the rotate option on, and a portrait page (w x h). */
export const isRotated = (w: number, h: number): boolean => !!current?.touch && ui$().get().display.rotate && h > w;

/** Worker mode: send the size to offer to the worker again (inline the kernel asks size() itself). */
function offerSize(): void {
	const vm = current?.vm();
	if (vm instanceof WorkerKernel) vm.updateDisplaySize();
}

/** The rotate option (the touch controls' button). */
export function setRotate(rotate: boolean): void {
	store("fbRotate", rotate ? "1" : "0");
	ui$().set((s) => ({ display: { ...s.display, rotate } }));
	offerSize();
}

/** How touches on the picture move the pointer (the touch controls' button). */
export function setTouchMode(touchMode: TouchMode): void {
	store("touchMode", touchMode);
	ui$().set((s) => ({ display: { ...s.display, touchMode } }));
}

/** Show or hide the stick and buttons (the touch controls' button). */
export function setControls(controls: boolean): void {
	store("padHidden", controls ? "0" : "1");
	ui$().set((s) => ({ display: { ...s.display, controls } }));
}

/** The touch buttons' layout (the touch controls' button). */
export function setPadLayout(layout: PadLayout): void {
	store("padLayout", layout);
	ui$().set((s) => ({ display: { ...s.display, layout } }));
}

// ---- full screen ------------------------------------------------------------
type FsDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
const fsDoc = () => document as FsDoc;
const fsElement = (): Element | null => fsDoc().fullscreenElement ?? fsDoc().webkitFullscreenElement ?? null;

/** The browser can put the page in full screen (not iPhone Safari). */
export const canFullscreen = (): boolean => !!(fsDoc().fullscreenEnabled || fsDoc().webkitFullscreenEnabled);

/** Opened from the home screen (no browser bars already). */
const standalone = (): boolean =>
	(navigator as Navigator & { standalone?: boolean }).standalone === true ||
	matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;

/** Offer the full screen chip: the browser has full screen, or (iPhone) it can say how to get the nearest thing. */
export const offerFullscreen = (): boolean => canFullscreen() || !standalone();

/**
 * Enter full screen (and lock to landscape where allowed), or leave it.
 * Call from a user gesture. Resolves with a message for the user (no full
 * screen here, or the browser refused it), or null.
 */
export async function toggleFullscreen(): Promise<string | null> {
	if (!canFullscreen())
		return "iPhone Safari has no full screen for pages. Share → Add to Home Screen, then open it from the icon: no Safari bars.";
	try {
		if (fsElement()) {
			await (fsDoc().exitFullscreen?.() ?? fsDoc().webkitExitFullscreen?.());
			return null;
		}
		const el = document.documentElement as FsEl;
		await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? el.webkitRequestFullscreen?.());
	} catch (e) {
		return `Full screen refused: ${(e as Error)?.message || e}`;
	}
	// Android Chrome: allowed in full screen; elsewhere it rejects, and the rotate option covers it.
	await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.("landscape").catch(() => {});
	return null;
}

const onFsChange = (l: () => void) => {
	document.addEventListener("fullscreenchange", l);
	document.addEventListener("webkitfullscreenchange", l);
	return () => {
		document.removeEventListener("fullscreenchange", l);
		document.removeEventListener("webkitfullscreenchange", l);
	};
};
/** The page is in full screen (re-renders on change). */
export const useFullscreen = (): boolean => useSyncExternalStore(onFsChange, () => !!fsElement());

/** The bar's toggle: the picture, or the terminal under it. */
export function setDisplayShown(shown: boolean): void {
	const $ = ui$();
	$.set((s) => ({ display: { ...s.display, shown } }));
	if (!shown) {
		evdev()?.releaseAll();
		if (pointerLocked()) document.exitPointerLock();
	}
}

export function createDisplayUi(opts: DisplayUiOptions): DisplayUi {
	current = opts;
	const $ = ui$();

	// ---- keyboard: capture phase, ahead of the terminal ------------------------
	const editable = (t: EventTarget | null) => {
		const el = t as HTMLElement | null;
		return !!el?.closest?.("input, select, textarea, [contenteditable], dialog") && !el.closest("#terms");
	};
	function onKey(e: KeyboardEvent) {
		const ev = evdev();
		if (!ev || editable(e.target)) return;
		const code = domCodeToLinux(e.code);
		const down = e.type === "keydown";
		// A release goes to the guest if the guest saw the press, whatever the state now.
		if (!down && code !== undefined && ev.key(code, false)) {
			e.preventDefault();
			e.stopImmediatePropagation();
			return;
		}
		if (!ev.keyboardOpen || !$.get().display.shown) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		if (down && code !== undefined) ev.key(code, true);
	}
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("keyup", onKey, true);
	window.addEventListener("blur", () => evdev()?.releaseAll());
	window.addEventListener("resize", offerSize);

	return {
		// CSS pixels are 96 to the inch by definition, so the guest can work out a DPI.
		size: () => {
			const app = appEl();
			let w = stageEl?.clientWidth ?? innerWidth, h = stageEl?.clientHeight ?? innerHeight;
			if (app && isRotated(app.clientWidth, app.clientHeight)) [w, h] = [app.clientHeight, app.clientWidth];
			return { width: Math.max(1, Math.floor(w)), height: Math.max(1, Math.floor(h)), dpi: 96 };
		},
		onDisplay(mode) {
			// Closed: the next program starts with the picture shown again.
			if (!mode) $.set((s) => ({ display: { ...s.display, attached: false, shown: true } }));
			else $.set((s) => ({ display: { ...s.display, attached: true, width: mode.width, height: mode.height } }));
		},
		onInput(state) {
			$.set((s) => ({ display: { ...s.display, keyboard: state.keyboard, mouse: state.mouse, tablet: state.tablet } }));
			// Absolute wins: no pointer lock while a program reads the tablet.
			if ((!state.mouse || state.tablet) && pointerLocked()) document.exitPointerLock();
		},
	};
}
