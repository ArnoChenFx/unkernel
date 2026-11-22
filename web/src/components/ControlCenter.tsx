// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The top bar's Control Center (#tb-cc), a macOS menu-bar extra: one plain
// black popover (style.css .popover) for the machine, opened by the bar's
// last item (TopBar.tsx #tb-status, two switches) or by hovering or clicking
// a resource meter (#tb-cpu…#tb-gpu: that resource's row is marked). Top to
// bottom:
// - the machine's state, quietly: a dot in its colour (running green;
//   starting, suspending or held amber; suspended grey; halted dim; error
//   red), the state's name (store label) and the guest's uptime;
// - quick settings, as small round icon buttons (the word is the tooltip; pressed ones lighter),
//   only what changes at once: Full screen (the page; where the browser has
//   it, or iPhone's hint), Wallpaper (Random: the next photo, the popover
//   stays; any other wallpaper: Settings, Desktop), Display (while a program
//   has the display open: shows the Display window, or minimizes it). Boot
//   options (network, guest GL, sound, memory…) apply on reboot, so they stay
//   in Settings;
// - the resources (Glance.tsx Resources: rows with sparklines; the sampler
//   runs at the full rate while it is open);
// - System… and Settings… (with their keys, as in the menus);
// - power: Suspend (Resume once suspended), Reboot ("Reboot to apply" while
//   Settings' options differ from this boot's; asks first, ui.confirmReboot()),
//   and while in safe mode with a distro, Leave safe mode (asks first). The
//   items keep the old power menu's ids (#tb-suspend, #tb-resume,
//   #tb-reboot); System… is #tb-cc-system, Settings… #tb-cc-settings.
// Behaviour (the opener, TopBar.tsx, keeps how it opened and which row is
// marked): a press anywhere but on it, the bar's item or the meters closes
// it; Esc closes it wherever the focus is (a mouse open leaves the focus in
// the terminal: presses on its buttons never take it); Tab, Shift-Tab and
// the arrow keys move through its buttons (wrapping), Home and End. Opened
// from the keyboard its first button takes the focus. Picking System…,
// Settings…, a power item or Display closes it; the other tiles keep it.
// Portaled to <body> at the menus' layer (--z-menu, over the toast); under
// sm (phones) a sheet across the page under the bar, else WIDTH px wide,
// its right edge under the item's, kept EDGE px inside the viewport; taller
// than the room below the bar, it scrolls.
import { useEffect, useReducer, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { nextRandom, setWallpaper, useDesktop } from "../desktop.ts";
import { DISPLAY_WIN, offerFullscreen, toggleDisplay, toggleFullscreen, useFullscreen } from "../display.ts";
import { fmtUptime } from "../format.ts";
import { useOutsidePress } from "../hooks.ts";
import { KW } from "../kw.ts";
import { useStats } from "../stats.ts";
import { isRunning, phase, useStore, type Phase } from "../store.ts";
import { openSection, openSettings, SETTINGS, SYSTEM } from "../sysapps.ts";
import { openItem } from "../winmenu.tsx";
import { isVisible, useWm } from "../wm.ts";
import { Resources, type ResKey } from "./Glance.tsx";
import { DisplayIcon, FullscreenIcon, LayersIcon, PauseIcon, PlayIcon, RebootIcon, ShuffleIcon } from "./icons.tsx";
import { menuKeys } from "./KeyHint.tsx";
import type { MenuEntry, MenuItem } from "./Menu.tsx";

/** How it closed: Esc, a press elsewhere, an item picked. */
export type CcClose = "key" | "away" | "pick";

const EDGE = 8, GAP = 6, WIDTH = 360;

/** The state dot's colour by phase. */
const DOT: Record<Phase, string> = {
	running: "var(--color-ok)", starting: "var(--color-warn)", suspending: "var(--color-warn)", held: "var(--color-warn)",
	suspended: "var(--color-muted)", halted: "var(--color-off)", error: "var(--color-err)",
};

/** A quick setting: a small round icon button (its word is the tooltip and the label); `on` draws it pressed. */
function Tile({ id, label, title, icon, on, busy, onClick }: {
	id: string; label: string; title: string; icon: ReactNode; on?: boolean; busy?: boolean; onClick: () => void;
}) {
	return (
		<button id={id} type="button" title={title} aria-label={label} aria-pressed={on} aria-busy={busy || undefined} onClick={() => { if (!busy) onClick(); }}
			className={`flex size-8 flex-none items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50 pointer-coarse:size-(--hit) ${
				on ? "bg-white/[0.22] text-fg" : "bg-white/[0.08] text-muted hover:bg-white/[0.14] hover:text-fg"} ${busy ? "opacity-60" : ""}`}>
			<span aria-hidden="true" className="flex">{icon}</span>
		</button>
	);
}

/** A row as in the menus (Menu.tsx): icon, label, its key on the right. */
function Item({ it, onPick }: { it: MenuItem; onPick: (it: MenuItem) => void }) {
	return (
		<button id={it.id} type="button" disabled={it.disabled} onClick={() => onPick(it)}
			className="mx-1 flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12.5px] text-muted enabled:hover:bg-white/10 enabled:hover:text-fg focus-visible:bg-white/10 focus-visible:text-fg focus-visible:outline-none disabled:opacity-40 pointer-coarse:py-3">
			<span aria-hidden="true" className="inline-flex w-[13px] flex-none justify-center">{it.icon}</span>
			<span className="truncate">{it.label}</span>
			{it.keys && <span className="ml-auto pl-4 text-[11px] text-faint">{it.keys}</span>}
		</button>
	);
}

const Sep = () => <div role="separator" className="my-1 border-t border-white/10" />;

export function ControlCenter({ anchorId, current, kb, inside, onClose }: {
	/** The bar's item, under which it opens (its rect is read on each render: it moves with the bar). */
	anchorId: string;
	/** The resource row marked (opened from a meter), or null. */
	current: ResKey | null;
	/** Opened from the keyboard: its first button takes the focus. */
	kb: boolean;
	/** Presses on these do not close it (the bar's item and meters: their click toggles it). */
	inside: (t: EventTarget | null) => boolean;
	onClose: (how: CcClose) => void;
}) {
	const ui = KW.ui!;
	const cfg = KW.config;
	const st = useStats();
	const label = useStore((s) => s.label);
	const ph = useStore(phase);
	const running = useStore(isRunning);
	const suspended = useStore((s) => s.suspended);
	useStore((s) => s.options); // "Reboot to apply" follows the options
	const displayOn = useStore((s) => s.display.attached);
	const displayShown = useWm((s) => { const w = s.windows.find((x) => x.id === DISPLAY_WIN); return !!w && isVisible(w, s); });
	const fs = useFullscreen();
	const random = useDesktop((s) => s.prefs.wallpaper.kind === "random");
	const rolling = useDesktop((s) => s.pending === "random");
	const box = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const [, relayout] = useReducer((n: number) => n + 1, 0);
	useOutsidePress((t) => !!box.current?.contains(t as Node) || inside(t), () => close.current("away"));
	const buttons = () => [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
	// Opened (or kept, after a hover opened it) from the keyboard: its first button takes the focus.
	useEffect(() => { if (kb) buttons()[0]?.focus({ preventScroll: true }); }, [kb]);
	useEffect(() => {
		// Esc closes it wherever the focus is (opened with the mouse, the terminal keeps it); the guest does not get that Esc.
		const key = (e: globalThis.KeyboardEvent) => {
			if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			close.current("key");
		};
		addEventListener("keydown", key, true);
		addEventListener("resize", relayout);
		return () => {
			removeEventListener("keydown", key, true);
			removeEventListener("resize", relayout);
		};
	}, []);
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		e.stopPropagation();
		const list = buttons(), i = list.indexOf(document.activeElement as HTMLButtonElement);
		const go = (n: number) => list[(n + list.length) % list.length]?.focus({ preventScroll: false });
		switch (e.key) {
			case "ArrowDown": case "ArrowRight": go(i + 1); break;
			case "ArrowUp": case "ArrowLeft": go(i < 0 ? -1 : i - 1); break;
			case "Tab": go(e.shiftKey ? (i < 0 ? -1 : i - 1) : i + 1); break;
			case "Home": go(0); break;
			case "End": go(-1); break;
			default: return;
		}
		e.preventDefault();
	};
	const pick = (it: MenuItem) => { close.current("pick"); it.run(); };

	// ---- where ----
	const a = document.getElementById(anchorId)?.getBoundingClientRect();
	const bar = document.getElementById("topbar")?.getBoundingClientRect();
	const top = (a && a.height > 0 ? a.bottom : bar?.bottom ?? 32) + GAP;
	const sheet = innerWidth < 640;
	const right = a && a.width > 0 ? a.right : innerWidth - EDGE;
	const left = Math.max(EDGE, Math.min(right - WIDTH, innerWidth - EDGE - WIDTH));
	const place = sheet ? { left: EDGE, right: EDGE, top } : { left, top, width: WIDTH };

	// ---- what ----
	const up = ph === "running" || ph === "held" || ph === "suspending" ? st.guest?.raw.uptime ?? null : null;
	const tiles: ReactNode[] = [];
	if (offerFullscreen())
		tiles.push(<Tile key="fs" id="tb-cc-fullscreen" label="Full screen" title={fs ? "Leave full screen" : "Full screen: the page without the browser's bars"} on={fs}
			icon={<FullscreenIcon on={fs} size={16} />} onClick={() => void toggleFullscreen().then((msg) => { if (msg) ui.toast(msg); })} />);
	// Always the shuffle: another random photo, which also turns Random on when a wallpaper was pinned (Settings, Desktop pins one again).
	tiles.push(<Tile key="wp" id="tb-cc-wallpaper" label="Random wallpaper" title="Random wallpaper: another photo" busy={rolling} icon={<ShuffleIcon size={16} />}
		onClick={() => void (random ? nextRandom() : setWallpaper({ kind: "random" }))} />);
	if (displayOn)
		tiles.push(<Tile key="dpy" id="tb-cc-display" label="Display" title={displayShown ? "Minimize the Display window" : "Show the Display window"} on={displayShown}
			icon={<DisplayIcon size={16} />} onClick={() => { close.current("pick"); toggleDisplay(); }} />);

	const apps = [
		{ ...openItem(SYSTEM, () => openSection("status"))!, id: "tb-cc-system" },
		{ ...openItem(SETTINGS, openSettings)!, id: "tb-cc-settings" },
	];
	const changed = ui.optionsChanged();
	const power: MenuEntry[] = [
		...(suspended ? [{ id: "tb-resume", label: "Resume", icon: <PlayIcon />, run: ui.resume }]
			: running && KW.suspend ? [{ id: "tb-suspend", label: "Suspend", icon: <PauseIcon />, keys: menuKeys("suspend"), run: () => ui.suspend() }] : []),
		{ id: "tb-reboot", label: changed ? "Reboot to apply" : "Reboot", icon: <RebootIcon />, keys: menuKeys("reboot"), run: () => void ui.confirmReboot() },
		...(cfg.root === "initramfs" && cfg.distro ? [{ id: "tb-safe-leave", label: "Leave safe mode", icon: <LayersIcon size={13} />, run: () => void ui.safeModeToggle() }] : []),
	];

	return createPortal(
		<div ref={box} id="tb-cc" role="dialog" aria-label="Control Center" onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}
			// A press on a button keeps the focus where it is (the terminal), as the bar's own buttons do.
			onMouseDown={(e) => { if ((e.target as Element).closest("button")) e.preventDefault(); }}
			className="popover fixed z-(--z-menu) flex flex-col overflow-y-auto overscroll-contain rounded-xl py-1 font-mono select-none"
			style={{ ...place, maxHeight: `calc(100dvh - ${Math.round(top) + EDGE}px)` }}>
			<div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-2.5">
				<p className="flex min-w-0 flex-1 items-center gap-2 font-sans text-[12px]">
					<span aria-hidden="true" className="size-2 flex-none rounded-full" style={{ background: DOT[ph] }} />
					<span className="truncate text-fg">{label}</span>
					{up != null && <span className="flex-none text-[11.5px] text-faint tabular-nums" title="The guest's uptime">up {fmtUptime(up)}</span>}
				</p>
				<div role="group" aria-label="Quick settings" className="flex flex-none items-center gap-1.5">
					{tiles}
				</div>
			</div>
			<Sep />
			<Resources current={current} />
			<Sep />
			{apps.map((it) => <Item key={it.id} it={it} onPick={pick} />)}
			<Sep />
			{power.map((it) => it && <Item key={it.id ?? it.label} it={it} onPick={pick} />)}
		</div>,
		document.body,
	);
}
