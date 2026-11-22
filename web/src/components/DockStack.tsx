// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Dock's stack (#dock-stack): the popover a pinned group's tile opens
// (Dock.tsx, pins.ts), as a macOS Dock folder: the group's title, small, over
// a compact grid of its apps' tiles (the launcher's look, smaller: the app's
// gradient and glyph, its name, a running dot, an install's bar), in a plain
// black popover (style.css .popover) above the tile, centred on it and kept
// EDGE px inside the viewport; under sm (phones) a sheet across the page above
// the Dock. Portaled to <body> at the menus' layer (--z-menu); taller than
// the room above the tile, it scrolls.
//
// - A click on an app runs it (launcher.ts launch(): a running one is shown)
//   and closes the stack; one that cannot run now (unavailable(), or the
//   system not running) is dimmed, with why in its tooltip and in a toast.
// - An app's menu (Menu.tsx #dock-stack-menu, at the pointer): a right click,
//   a long press on touch, the ContextMenu key or Shift-F10. Open, then Keep
//   in Dock or Remove from Dock (the app). A press in the stack that closes
//   that menu does nothing else.
// - A press outside it (but on its tile, whose click toggles it), Esc, a
//   pick, a resize or the page losing the focus close it. Esc closes it
//   wherever the focus is (opened with the mouse, the terminal keeps the
//   focus: presses in it never take it; the guest does not get that Esc).
//   Opened from the keyboard its first app takes the focus; the arrows move
//   it through the grid (up and down by a row), Home and End, Enter or
//   Space runs it, Esc or Tab closes the stack and the opener puts the focus
//   back on the tile (onClose "key").
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { isPageApp, type App, type Group } from "../apps/types.ts";
import { useOutsidePress, useLongPress } from "../hooks.ts";
import { useInstalls } from "../installer.ts";
import { KW } from "../kw.ts";
import { launch, unavailable } from "../launcher.ts";
import { canPin, groupApps, isPinned, pin, unpin, usePins } from "../pins.ts";
import { isRunning, useStore } from "../store.ts";
import { useTermTabs } from "../termtabs.ts";
import { useWm } from "../wm.ts";
import { AppGlyph } from "./icons.tsx";
import { TileProgress } from "./Installer.tsx";
import { Menu, type MenuClose, type MenuEntry } from "./Menu.tsx";

/** How it closed: Esc or Tab in it (the focus goes back to the tile), a press elsewhere (Esc elsewhere, a resize), an app picked. */
export type StackClose = "key" | "away" | "pick";

const EDGE = 8, GAP = 8;
/** A tile's width on wide screens (px). */
const CELL = 76;
const GRAY: [string, string] = ["#52525b", "#18181b"];
const MENU_ID = "dock-stack-menu";

/** Columns for n apps: a row of up to four, then three to five across. */
const columnsFor = (n: number, sheet: boolean): number => (sheet ? Math.min(4, n) : n <= 4 ? n : n <= 9 ? 3 : n <= 16 ? 4 : 5);

/** One app's tile: icon, name, running dot; a long press on touch opens its menu. */
function StackTile({ app, idx, sel, why, running, onPick, onMenu, onFocus }: {
	app: App; idx: number; sel: boolean; why: string | null; running: boolean;
	onPick(): void; onMenu(at: DOMRect, el: HTMLElement): void; onFocus(): void;
}) {
	const long = useLongPress((at) => onMenu(new DOMRect(at.x, at.y, 0, 0), at.el), { ms: 500 });
	const inst = useInstalls()[app.id];
	const tip = inst ? `${app.title}: ${inst.state === "failed" ? "the install failed" : "installing"}` : why ? `${app.title}: ${why}` : running ? `${app.title}: running` : `${app.title}: ${app.desc}`;
	const face: CSSProperties = { backgroundImage: `linear-gradient(135deg, ${(app.colors ?? GRAY)[0]}, ${(app.colors ?? GRAY)[1]})` };
	return (
		<button type="button" data-app={app.id} data-idx={idx} tabIndex={sel ? 0 : -1} title={tip} aria-label={`${app.title}${running ? ", running" : ""}`} aria-disabled={!!why || undefined}
			onClick={() => { if (!long.consumed()) onPick(); }} onFocus={onFocus}
			onContextMenu={(e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); long.context(); onMenu(new DOMRect(e.clientX, e.clientY, 0, 0), e.currentTarget); }}
			{...long.handlers}
			className={`group flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 pt-2 pb-1 outline-none transition-colors hover:bg-white/10 focus-visible:bg-white/10 [-webkit-touch-callout:none] ${why ? "opacity-45" : ""}`}>
			<span aria-hidden="true" style={face}
				className={`relative grid size-11 place-items-center rounded-[22%] text-[22px] leading-none text-white shadow-[0_2px_6px_rgba(0,0,0,.45)] transition-transform group-active:scale-95 ${why ? "grayscale" : ""}`}>
				<AppGlyph icon={app.icon ?? app.title[0]!.toUpperCase()} className="size-[58%]" />
				<TileProgress inst={inst} className="right-[16%] bottom-[12%] left-[16%]" />
			</span>
			<span className="max-w-full truncate font-sans text-[11px] leading-tight text-muted group-hover:text-fg">{app.title}</span>
			<span aria-hidden="true" className={`size-1 flex-none rounded-full ${running ? "bg-white/80" : "bg-transparent"}`} />
		</button>
	);
}

export function DockStack({ group, anchor, kb, inside, onClose }: {
	group: Group;
	/** The tile's rect when it opened. */
	anchor: DOMRect;
	/** Opened from the keyboard: its first app takes the focus. */
	kb: boolean;
	/** Presses on these do not close it (its tile: its click toggles it). */
	inside: (t: EventTarget | null) => boolean;
	onClose: (how: StackClose) => void;
}) {
	const system = useStore(isRunning);
	const terms = useTermTabs((s) => s.terms);
	const windows = useWm((s) => s.windows);
	usePins(); // an app menu's Keep in Dock or Remove from Dock follows the pins
	const apps = groupApps(group);
	const box = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const [sel, setSel] = useState(0);
	const [menu, setMenu] = useState<{ app: App; at: DOMRect; el: HTMLElement } | null>(null);
	/** A press while the app menu was open (it closed the menu): its click does nothing else. */
	const eat = useRef(false);
	const [pos, setPos] = useState<{ left: number; width?: number } | null>(null);
	const sheet = innerWidth < 640;
	const cols = columnsFor(apps.length, sheet);

	const whyOf = (a: App): string | null => (!isPageApp(a) && !system ? "the system is not running" : unavailable(a));
	const runningOf = (a: App): boolean => (isPageApp(a) ? !!a.win && windows.some((w) => w.id === a.win) : terms.some((x) => x.name === a.id));
	const pick = (a: App) => {
		const why = whyOf(a);
		if (why) { KW.ui?.toast(`${a.title}: ${why}`); return; }
		close.current("pick");
		void launch(a);
	};
	const tiles = () => [...(box.current?.querySelectorAll<HTMLButtonElement>("[data-idx]") ?? [])];

	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		if (sheet) { setPos({ left: EDGE, width: innerWidth - 2 * EDGE }); return; }
		const w = el.offsetWidth;
		setPos({ left: Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - w / 2, innerWidth - EDGE - w)) });
	}, [anchor, sheet, apps.length]);
	useOutsidePress((t) => !!box.current?.contains(t as Node) || !!(t as Element | null)?.closest?.(`#${MENU_ID}`) || inside(t), () => close.current("away"));
	useEffect(() => { if (kb) tiles()[0]?.focus({ preventScroll: true }); }, [kb]);
	useEffect(() => {
		// Esc closes it wherever the focus is (in it, its own handler below; in its app menu, the menu's).
		const key = (e: globalThis.KeyboardEvent) => {
			if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
			if (box.current?.contains(e.target as Node) || document.getElementById(MENU_ID)) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			close.current("away");
		};
		const away = () => close.current("away");
		addEventListener("keydown", key, true);
		addEventListener("resize", away);
		addEventListener("blur", away);
		return () => {
			removeEventListener("keydown", key, true);
			removeEventListener("resize", away);
			removeEventListener("blur", away);
		};
	}, []);

	// A press in the stack while the app menu is open (which closes it, Menu.tsx) does nothing else:
	// on the window, ahead of the menu's own listener; its click comes right after the pointerup.
	useEffect(() => {
		if (!menu) return;
		const down = (e: PointerEvent) => {
			if (!box.current?.contains(e.target as Node)) return;
			eat.current = true;
			const done = () => {
				removeEventListener("pointerup", done, true);
				removeEventListener("pointercancel", done, true);
				setTimeout(() => { eat.current = false; }, 0);
			};
			addEventListener("pointerup", done, true);
			addEventListener("pointercancel", done, true);
		};
		addEventListener("pointerdown", down, true);
		return () => removeEventListener("pointerdown", down, true);
	}, [menu]);
	const openMenu = (a: App, at: DOMRect, el: HTMLElement) => setMenu((m) => (m?.app.id === a.id ? m : { app: a, at, el })); // Android: a long press opens it twice
	const closeMenu = (how: MenuClose) => {
		const el = menu?.el;
		setMenu(null);
		if (how === "key" && el?.isConnected) el.focus({ preventScroll: true });
	};
	const menuItems = (a: App): MenuEntry[] => {
		const items: MenuEntry[] = [{ label: "Open", disabled: !!whyOf(a), run: () => pick(a) }];
		if (canPin(a)) items.push(null, isPinned({ app: a }) ? { label: "Remove from Dock", run: () => unpin({ app: a }) } : { label: "Keep in Dock", run: () => pin({ app: a }) });
		return items;
	};

	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		e.stopPropagation();
		const list = tiles(), n = list.length;
		const i = Math.max(0, list.indexOf(document.activeElement as HTMLButtonElement));
		const go = (j: number) => list[Math.max(0, Math.min(n - 1, j))]?.focus({ preventScroll: false });
		switch (e.key) {
			case "ArrowRight": go(i + 1); break;
			case "ArrowLeft": go(i - 1); break;
			case "ArrowDown": if (i + cols < n) go(i + cols); break;
			case "ArrowUp": if (i - cols >= 0) go(i - cols); break;
			case "Home": go(0); break;
			case "End": go(n - 1); break;
			case "Escape": case "Tab": close.current("key"); break;
			case "ContextMenu": case "F10": {
				if (e.key === "F10" && !e.shiftKey) return;
				const el = list[i], a = el && apps.find((x) => x.id === el.dataset.app);
				if (!el || !a) return;
				const r = el.getBoundingClientRect();
				openMenu(a, new DOMRect(r.left + r.width / 2, r.top + r.height / 2, 0, 0), el);
				break;
			}
			default: return; // Enter and Space click the focused tile
		}
		e.preventDefault();
	};

	const grid: CSSProperties = { gridTemplateColumns: sheet ? `repeat(${cols}, minmax(0, 1fr))` : `repeat(${cols}, ${CELL}px)` };
	return (
		<>
			{createPortal(
				<div ref={box} id="dock-stack" role="dialog" aria-label={group.title} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}
					// The focus stays where it is (the terminal), as on the Dock's tiles.
					onMouseDown={(e) => e.preventDefault()}
					onClickCapture={(e) => { if (eat.current) { eat.current = false; e.stopPropagation(); e.preventDefault(); } }}
					className="popover fixed z-(--z-menu) flex flex-col overflow-y-auto overscroll-contain rounded-2xl p-1.5 select-none"
					style={{ left: pos?.left ?? -9999, width: pos?.width, bottom: innerHeight - anchor.top + GAP, maxHeight: Math.max(120, anchor.top - GAP - EDGE) }}>
					<div aria-hidden="true" className="truncate px-1.5 pt-1 pb-0.5 font-sans text-[11.5px] font-medium text-faint">{group.title}</div>
					<div className="grid gap-0.5" style={grid}>
						{apps.map((a, i) => (
							<StackTile key={a.id} app={a} idx={i} sel={i === sel} why={whyOf(a)} running={runningOf(a)}
								onPick={() => pick(a)} onMenu={(at, el) => openMenu(a, at, el)} onFocus={() => setSel(i)} />
						))}
					</div>
				</div>,
				document.body,
			)}
			{menu && <Menu id={MENU_ID} label={menu.app.title} header={menu.app.title} items={menuItems(menu.app)} anchor={menu.at} point onClose={closeMenu} />}
		</>
	);
}
