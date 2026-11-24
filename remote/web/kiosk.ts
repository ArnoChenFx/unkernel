// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// The Omarchy kiosk page (/kiosk, served by remote/server.ts): the guest's display
// fills the browser window and nothing else of the web app is there (no windows, dock
// or terminal). It boots the Omarchy image on the remote backend through the same link
// as the app, types `omarchy desktop` on the guest's console once the shell is up (so
// the image needs no change), shows the boot status until the first frame of the
// desktop, and sends the keyboard and mouse to the guest. The guest's display size
// follows the window.

import { createKernelOn, type CreateKernelOptions, type Platform, type WorkerOption } from "../../js/core/instance.ts";
import type { DisplayMode } from "../../js/core/display.ts";
import { BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, domButtonToLinux, domCodeToLinux } from "../../js/core/input.ts";
import type { WorkerKernel } from "../../js/core/worker-host.ts";
import { RemoteLink } from "./link.ts";
import { Picture } from "./picture.ts";

interface KioskConfig {
	kernel: string;
	distro: string;
	/** What is typed on the console once the shell is up. */
	command: string;
}

const cfg = (window as unknown as { __KIOSK__: KioskConfig }).__KIOSK__;
const canvas = document.getElementById("fb") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const detail = document.getElementById("detail") as HTMLElement;
const ctx = canvas.getContext("2d")!;

const say = (title: string, more = ""): void => {
	status.textContent = title;
	detail.textContent = more;
	document.body.classList.remove("live");
};
let kept: HTMLCanvasElement | undefined;
const picture = new Picture({
	canvas,
	spare: () => (kept ??= document.createElement("canvas")),
	say,
	show: () => document.body.classList.add("live"),
});
// The guest renders in software (no virgl over the link), so its display is capped at about
// 1280x800 worth of pixels whatever the window (a 5120x1440 window would ask for 6.6 MP,
// slow in the guest and heavy frames for the page); the canvas is scaled up to the window.
// ?size=WxH asks for that size exactly; ?max=WxH moves the cap.
const params = new URLSearchParams(location.search);
const wxh = (v: string | null): [number, number] | undefined => {
	const m = v ? /^(\d{3,4})x(\d{3,4})$/.exec(v) : null;
	return m ? [Number(m[1]), Number(m[2])] : undefined;
};
const fixed = wxh(params.get("size"));
const cap = wxh(params.get("max")) ?? [1280, 800];
const size = () => {
	if (fixed) return { width: fixed[0], height: fixed[1], dpi: 96 };
	let w = Math.max(320, innerWidth), h = Math.max(240, innerHeight);
	const scale = Math.min(1, Math.sqrt((cap[0] * cap[1]) / (w * h)));
	w = Math.floor((w * scale) / 8) * 8;
	h = Math.floor((h * scale) / 2) * 2;
	return { width: Math.max(320, w), height: Math.max(240, h), dpi: Math.round(96 * scale) || 96 };
};

async function main(): Promise<void> {
	say("Connecting…");
	const link = await RemoteLink.connect(location.origin);
	const platform: Platform = {
		defaultKernel: () => new URL(cfg.kernel, location.href),
		spawnWorker: () => link.endpoint(),
		absoluteUrl: (src) => new URL(src, location.href).href,
		distroSpec: (src) => ({ kind: "http", url: new URL(String(src), location.href).href, readOnly: true }),
	};
	say("Starting Linux…", "first start downloads the Omarchy image, which takes a while");
	const opts: CreateKernelOptions & WorkerOption & { worker: true } = {
		worker: true,
		shared: false,
		kernel: new URL(cfg.kernel, location.href).href,
		compileInWorker: true,
		cpus: 1,
		memoryMiB: 1024,
		display: size(),
		gpu: true,
		distro: new URL(cfg.distro, location.href).href,
		disks: [{ kind: "data", template: "bundled", optional: true }],
		vsock: true,
		onInput: () => {},
		onDisplay: (m: DisplayMode | null) => picture.display(m),
	} as never;
	const vm: WorkerKernel = await createKernelOn(platform, opts);

	// The console: type the command once the shell's prompt shows (Omarchy's prompt ends in ⇒), or after 90 s anyway.
	let out = "";
	let typed = false;
	const type = (): void => {
		if (typed) return;
		typed = true;
		say("Starting the desktop…");
		vm.write(`${cfg.command}\n`);
	};
	vm.onOutput((b) => {
		out = (out + new TextDecoder().decode(b)).slice(-4000);
		if (!typed && out.includes("⇒")) setTimeout(type, 300);
	});
	setTimeout(type, 90_000);
	void vm.exited.then((r) => picture.stopped("The machine stopped", `exit ${r.code ?? ""} ${r.reason ?? ""}; reload this page to start it again`));

	// Frames.
	const evdev = () => vm.evdev;
	let image: ImageData | null = null;
	let seq = -1;
	const paint = (): void => {
		requestAnimationFrame(paint);
		const mode = picture.mode;
		if (!mode) return;
		if (vm.frameSeq === seq) {
			vm.requestFrame();
			return;
		}
		const img = image && image.width === mode.width && image.height === mode.height ? image : (image = new ImageData(mode.width, mode.height));
		if (picture.paint(vm.frame(img.data), () => ctx.putImageData(img, 0, 0))) seq = vm.frameSeq;
	};
	requestAnimationFrame(paint);

	// The display follows the window.
	let timer = 0;
	addEventListener("resize", () => {
		clearTimeout(timer);
		timer = window.setTimeout(() => vm.updateDisplaySize(size()), 300);
	});

	// Keyboard: everything goes to the guest (F11 and F12 stay the browser's).
	const onKey = (e: KeyboardEvent): void => {
		const ev = evdev();
		if (!ev) return;
		const code = domCodeToLinux(e.code);
		const down = e.type === "keydown";
		if (!down && code !== undefined && ev.key(code, false)) {
			e.preventDefault();
			return;
		}
		if (e.code === "F11" || e.code === "F12" || !ev.keyboardOpen) return;
		e.preventDefault();
		if (down && code !== undefined) ev.key(code, true);
	};
	addEventListener("keydown", onKey, true);
	addEventListener("keyup", onKey, true);
	addEventListener("blur", () => evdev()?.releaseAll());

	// Mouse: the guest's tablet (absolute) when a program reads it, else its relative mouse with pointer lock.
	const BUTTONS: [number, number][] = [[1, BTN_LEFT], [2, BTN_RIGHT], [4, BTN_MIDDLE]];
	const aim = (e: PointerEvent): void => {
		const r = canvas.getBoundingClientRect();
		const x = Math.min(0.999999, Math.max(0, (e.clientX - r.left) / r.width));
		const y = Math.min(0.999999, Math.max(0, (e.clientY - r.top) / r.height));
		evdev()?.moveTo(x, y);
	};
	const sync = (e: PointerEvent): void => {
		for (const [bit, code] of BUTTONS) evdev()?.tabletButton(code, !!(e.buttons & bit));
	};
	canvas.addEventListener("pointerdown", (e) => {
		const ev = evdev();
		if (!ev) return;
		e.preventDefault();
		if (ev.tabletOpen) {
			canvas.setPointerCapture(e.pointerId);
			aim(e);
			sync(e);
		} else if (ev.mouseOpen) {
			if (document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
			else {
				const b = domButtonToLinux(e.button);
				if (b !== undefined) ev.button(b, true);
			}
		}
	});
	canvas.addEventListener("pointermove", (e) => {
		const ev = evdev();
		if (!ev) return;
		if (ev.tabletOpen) {
			aim(e);
			sync(e);
		} else if (document.pointerLockElement === canvas) ev.move(e.movementX * (canvas.width / canvas.clientWidth), e.movementY * (canvas.height / canvas.clientHeight));
	});
	const up = (e: PointerEvent): void => {
		const ev = evdev();
		if (!ev) return;
		if (ev.tabletOpen) sync(e);
		else {
			const b = domButtonToLinux(e.button);
			if (b !== undefined) ev.button(b, false);
		}
	};
	canvas.addEventListener("pointerup", up);
	canvas.addEventListener("pointercancel", up);
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());
	canvas.addEventListener(
		"wheel",
		(e) => {
			const ev = evdev();
			if (!ev || !e.deltaY) return;
			e.preventDefault();
			const clicks = e.deltaY < 0 ? 1 : -1;
			if (ev.tabletOpen) ev.tabletWheel(clicks);
			else ev.wheel(clicks);
		},
		{ passive: false },
	);
	// Ctrl+Alt+F: full screen (the browser keeps Esc).
	addEventListener("dblclick", () => {
		if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
	});
	(window as unknown as { __kiosk: unknown }).__kiosk = { vm, link };
}

main().catch((e: unknown) => say("Could not start", (e as Error)?.message ?? String(e)));
