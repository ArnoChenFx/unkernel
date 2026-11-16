// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The fx panel (fx.ts): fx's terminal in a terminal-style frame with its
// title in the top border, as the preview's. On wide screens it is docked
// right of the stage (after the preview, if that is open too) and takes part
// of its width; the bar on its left edge sets the split (localStorage
// `kw.fxSplit`). On narrow screens it covers the stage. Hidden (the status
// line's fx button, Ctrl-A f), fx keeps running and the stage gets its width
// back; [×] stops fx.
import { useEffect, useRef, useState } from "react";
import { closeFx, mountFx, toggleFx, type FxControl } from "../fx.ts";
import { KW } from "../kw.ts";
import { useNarrow } from "../preview.ts";
import { useStore } from "../store.ts";
import { store } from "../ui.ts";
import { dragSplit } from "./Preview.tsx";

const SPLIT = 0.38;
const readSplit = (): number => {
	const v = Number(store("fxSplit"));
	return v >= 0.1 && v <= 0.9 ? v : SPLIT;
};

export function Fx() {
	const fx = useStore((s) => s.fx);
	const font = useStore((s) => s.fontSize);
	const narrow = useNarrow();
	const [split, setSplit] = useState(readSplit);
	const host = useRef<HTMLDivElement>(null);
	const ctl = useRef<FxControl | null>(null);
	const open = !!fx, shown = !!fx?.shown;

	useEffect(() => {
		if (!open) return;
		const c = mountFx(host.current!);
		ctl.current = c;
		return () => { c.dispose(); ctl.current = null; };
	}, [open]);
	useEffect(() => { ctl.current?.setFont(font); }, [font, open]);
	useEffect(() => { ctl.current?.show(shown, !KW.config.coarse); }, [shown, open]);

	if (!fx) return null;
	const docked = !narrow;
	const btn = "px-1 text-muted hover:text-fg";

	return (
		<section
			id="fx" aria-label="fx, the coding agent" hidden={!shown}
			className={`flex flex-col border border-line-strong bg-black font-mono text-[12px] ${docked
				? "relative flex-none mt-[max(8px,var(--st))] mr-[max(8px,var(--sr))] mb-1"
				: "absolute inset-[max(8px,var(--st))_max(8px,var(--sr))_4px_max(8px,var(--sl))] z-[16] shadow-[0_16px_48px_rgba(0,0,0,.8)]"}`}
			style={docked ? { width: `calc(${(split * 100).toFixed(2)}% - max(8px, var(--sr)))` } : undefined}
		>
			<h2 className="absolute -top-2 left-3 z-[1] bg-black px-1.5 text-[12px] leading-4 font-normal text-fg">
				<span className="text-faint">┤</span> fx <span className="text-faint">├</span>
			</h2>
			<div className="absolute -top-2 right-3 z-[1] flex bg-black px-1 text-[12px] leading-4">
				<button id="fx-hide" type="button" className={btn} title="Hide (fx keeps running)" aria-label="Hide fx" onClick={toggleFx}>[–]</button>
				<button id="fx-close" type="button" className={btn} title="Stop fx and close" aria-label="Stop fx and close the panel" onClick={closeFx}>[×]</button>
			</div>
			<div className="relative min-h-0 flex-1 px-2 pt-3 pb-1"><div id="fx-term" ref={host} className="h-full w-full" /></div>
			{docked && (
				<div role="separator" aria-orientation="vertical" aria-label="Resize the fx panel" title="Drag to resize"
					onPointerDown={(e) => dragSplit(e, split, setSplit, () => {}, "fxSplit")}
					className="absolute top-0 -left-2 z-[1] h-full w-3 cursor-ew-resize touch-none hover:bg-line/40" />
			)}
		</section>
	);
}
