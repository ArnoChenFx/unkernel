// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The demo launcher: the status line's first item (❯ and its shortcut as
// key caps, LauncherButton) and the overlay it opens (Launchpad), in the manner of
// macOS Launchpad: the page blurred behind a grid of tiles, one per demo
// (../demos/), with a search field over them. A tile runs its demo in a new
// terminal window (launcher.ts).
//
// - Keys: typing filters (title and description), arrows move the
//   selection, Enter runs it, Esc closes. The focus stays in the search
//   field (tiles take no focus), so display.ts never routes these keys to a
//   program holding the guest's keyboard. On touch devices the field is not
//   focused, which would raise the on-screen keyboard.
// - A click on the backdrop closes it; so do its shortcuts (⌘K on Apple
//   devices, Ctrl-Shift-O, Ctrl-A o: shortcuts.ts) and the first item.
// - A running demo (a window named after it) has a dot under its tile, and
//   picking it shows that window (launcher.ts: one run at a time).
// - After the demos, a gray System tile that opens the dialog (PANEL_TILES);
//   it works whatever the system's state.
// - A demo with `hidden` set is left out.
// - A demo the page cannot run (launcher.ts, unavailable()) is dimmed, with
//   why in its tooltip and under the grid while it is selected.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEMOS } from "../demos/index.ts";
import { KW } from "../kw.ts";
import { launch, setLauncher, toggleLauncher, unavailable, type Demo, type DemoIcon } from "../launcher.ts";
import { APPLE, CHORD, PREFIX } from "../shortcuts.ts";
import { useStore, type Tab } from "../store.ts";

/** A key cap: the launcher's shortcut beside ❯. */
const Cap = ({ children }: { children: string }) => (
	<kbd className="inline-grid h-[17px] min-w-[17px] place-items-center rounded-[4px] border border-line-strong bg-hover px-1 font-sans text-[10.5px] leading-none font-medium text-muted shadow-[inset_0_-1px_0_var(--color-line-strong)] transition-colors group-hover:border-faint group-hover:text-fg">{children}</kbd>
);

export function LauncherButton() {
	const open = useStore((s) => s.launcher);
	return (
		<button
			id="bar-launcher" type="button" title={`Demos (${APPLE ? "⌘K" : `${CHORD}-O`}, or ${PREFIX} o)`} aria-label="unkernel: Demos"
			aria-haspopup="dialog" aria-expanded={open} aria-controls="launcher"
			onClick={(e) => { if (e.detail) e.currentTarget.blur(); toggleLauncher(); }}
			className={`brand group flex flex-none items-center gap-2 border-r border-line px-2.5 text-fg transition-colors hover:bg-hover max-sm:px-2 ${open ? "bg-hover" : ""}`}
		>
			<span className="text-fg">❯</span>
			<span aria-hidden="true" className="flex items-center gap-[3px] max-sm:hidden">
				{(APPLE ? ["⌘", "K"] : ["Ctrl", "⇧", "O"]).map((k) => <Cap key={k}>{k}</Cap>)}
			</span>
		</button>
	);
}

/** A tile in the launcher: a demo, or a shortcut into the dialog. */
interface Tile {
	id: string;
	title: string;
	desc: string;
	icon: string | DemoIcon;
	colors: [string, string];
	/** Why it cannot run now, or null. */
	why: string | null;
	/** The window a running demo is in. */
	win?: number;
	tip: string;
	run(): void;
}

const GRAY: [string, string] = ["#52525b", "#18181b"];
/** The System dialog as a tile, after the demos. */
const PANEL_TILES: Array<Omit<Tile, "why" | "tip" | "run"> & { tab: Tab }> = [
	{ id: "system", tab: "status", title: "System", desc: "Options, the data disk and the system's state", colors: GRAY,
		// A gear, generated: eight teeth on r 8.6 to 11.2, a 3.6 hole.
		icon: { svg: '<path fill-rule="evenodd" d="M9.93 3.65 10.16.95h3.68l.23 2.7a8.6 8.6 0 0 1 2.37.98l2.07-1.74 2.6 2.6-1.74 2.07a8.6 8.6 0 0 1 .98 2.37l2.7.23v3.68l-2.7.23a8.6 8.6 0 0 1-.98 2.37l1.74 2.07-2.6 2.6-2.07-1.74a8.6 8.6 0 0 1-2.37.98l-.23 2.7h-3.68l-.23-2.7a8.6 8.6 0 0 1-2.37-.98l-2.07 1.74-2.6-2.6 1.74-2.07a8.6 8.6 0 0 1-.98-2.37l-2.7-.23v-3.68l2.7-.23a8.6 8.6 0 0 1 .98-2.37L2.89 5.49l2.6-2.6 2.07 1.74a8.6 8.6 0 0 1 2.37-.98ZM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/>' } },
];

const matches = (t: Tile, q: string) => !q || `${t.title} ${t.id} ${t.desc}`.toLowerCase().includes(q);

/** A rounded square with the tile's gradient and glyph, or its pictogram at 58%. */
function Icon({ t }: { t: Tile }) {
	const style: CSSProperties = { backgroundImage: `linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})` };
	const g = t.icon;
	return (
		<span style={style} aria-hidden="true"
			className={`grid size-16 place-items-center rounded-[22%] text-3xl text-white shadow-[0_8px_24px_rgba(0,0,0,.5),inset_0_1px_0_rgba(255,255,255,.25)] transition-transform group-hover:scale-105 group-active:scale-95 sm:size-20 sm:text-4xl ${t.why ? "grayscale" : ""}`}>
			{typeof g === "string" ? g : (
				// The markup is a static string from the demo files (and PANEL_TILES),
				// never user input, so setting it as inner HTML is safe.
				<svg viewBox={g.viewBox ?? "0 0 24 24"} fill="currentColor" className="size-[58%] drop-shadow-[0_1px_1.5px_rgba(0,0,0,.3)]" dangerouslySetInnerHTML={{ __html: g.svg }} />
			)}
		</span>
	);
}

export function Launchpad() {
	const open = useStore((s) => s.launcher);
	return open ? <Pad /> : null;
}

function Pad() {
	const state = useStore((s) => s.state);
	const wins = useStore((s) => s.wins);
	const stopped = state === "halted" || state === "error";
	const [query, setQuery] = useState("");
	const [sel, setSel] = useState(0);
	const grid = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const q = query.trim().toLowerCase();
	const tiles = useMemo((): Tile[] => [
		...DEMOS.filter((d) => !d.hidden).map((d: Demo): Tile => {
			const why = stopped ? "the system is not running" : unavailable(d);
			const win = wins.find((x) => x.name === d.id)?.n;
			return {
				id: d.id, title: d.title, desc: d.desc, icon: d.icon ?? d.title[0]!.toUpperCase(), colors: d.colors ?? GRAY, why, win,
				tip: why ? `${d.title}: ${why}` : win ? `${d.title} runs in window ${win}: shows it`
					: `${d.desc}${d.packages?.length ? `\nInstalls: ${d.packages.join(" ")}` : ""}\nRuns: ${d.commands.join("; ")}`,
				run: () => void launch(d),
			};
		}),
		...PANEL_TILES.map(({ tab, ...t }): Tile => ({ ...t, why: null, tip: `${t.title}: ${t.desc}`, run: () => KW.ui!.openPanel(tab) })),
	], [stopped, wins]);
	const shown = useMemo(() => tiles.filter((t) => matches(t, q)), [tiles, q]);
	const cur = shown[Math.min(sel, shown.length - 1)];

	useEffect(() => {
		if (!KW.config.coarse) input.current?.focus({ preventScroll: true });
	}, []);
	useEffect(() => setSel(0), [q]);

	const run = (t: Tile | undefined) => {
		if (!t || t.why) return;
		setLauncher(false);
		t.run();
	};
	/** Columns in the grid now (it is auto-fill). */
	const cols = () => {
		const t = grid.current ? getComputedStyle(grid.current).gridTemplateColumns : "";
		return Math.max(1, t.split(" ").filter(Boolean).length);
	};
	const onKey = (e: ReactKeyboardEvent) => {
		const n = shown.length;
		const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() } as Record<string, number>)[e.key];
		if (step && n) {
			// Left and right move through the text while there is any.
			if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && query) return;
			e.preventDefault();
			setSel((s) => Math.min(n - 1, Math.max(0, Math.min(s, n - 1) + step)));
		} else if (e.key === "Enter") {
			e.preventDefault();
			run(cur);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			if (query) setQuery("");
			else setLauncher(false);
		}
	};

	return (
		<div
			id="launcher" role="dialog" aria-modal="true" aria-label="Launcher" onKeyDown={onKey}
			onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.backdrop) setLauncher(false); }}
			className="fixed inset-0 z-[35] flex flex-col items-center overflow-y-auto bg-black/55 px-[max(16px,var(--sl))] pt-[max(40px,calc(var(--st)+24px))] pb-[max(24px,var(--sb))] backdrop-blur-2xl backdrop-saturate-150 transition-[opacity,scale] duration-200 ease-out starting:scale-105 starting:opacity-0"
		>
			<label className="relative mb-10 flex w-[min(16rem,100%)] items-center sm:mb-14">
				<svg className="pointer-events-none absolute left-2.5 text-white/60" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
				<input
					ref={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
					placeholder="Search" aria-label="Search the launcher" aria-controls="launcher-grid" autoComplete="off" spellCheck={false}
					className="h-8 w-full rounded-lg border border-white/15 bg-white/10 pr-3 pl-8 text-[14px] text-white placeholder:text-white/50 focus:border-white/30 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
				/>
			</label>
			<div
				id="launcher-grid" ref={grid} role="listbox" aria-label="Demos and system" data-backdrop="1"
				className="grid w-full max-w-5xl grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] content-start gap-x-2 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] sm:gap-y-10"
			>
				{shown.map((t) => {
					const on = t === cur;
					return (
						<button
							key={t.id} type="button" role="option" aria-selected={on} aria-disabled={!!t.why} tabIndex={-1} title={t.tip}
							onMouseDown={(e) => e.preventDefault()} // the focus stays in the search field
							onMouseEnter={() => setSel(shown.indexOf(t))}
							onClick={() => run(t)}
							className={`group flex flex-col items-center gap-2 rounded-2xl px-1 py-3 outline-none ${on ? "bg-white/10" : ""} ${t.why ? "cursor-default opacity-45" : ""}`}
						>
							<Icon t={t} />
							<span className="max-w-full truncate text-[13px] text-white [text-shadow:0_1px_3px_rgba(0,0,0,.6)]">{t.title}</span>
							{/* Running: a dot under the title, as in the macOS Dock. */}
							<span aria-hidden="true" className={`-mt-1 size-1 rounded-full ${t.win ? "bg-white/80" : "bg-transparent"}`} />
							{t.win && <span className="sr-only">, running in window {t.win}</span>}
						</button>
					);
				})}
				{!shown.length && <p className="col-span-full text-center text-white/60">Nothing matches “{query.trim()}”.</p>}
			</div>
			<p data-backdrop="1" className="mt-auto max-w-xl pt-10 text-center text-[12px] text-white/60" aria-live="polite">
				{cur ? (cur.why ? `${cur.title}: ${cur.why}` : cur.desc) : ""}
				{cur?.win && " · running: ↵ shows its window"}
				<span className="mt-1 block font-mono text-[11px] text-white/40 max-sm:hidden">↵ open · arrows select · esc close</span>
			</p>
		</div>
	);
}
