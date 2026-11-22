// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Wayland desktop (wayland.ts): a layer over the stage, the size of the
// stage (its size is the output size wland offers the apps), holding the
// container (#wl-desktop) that wland mounts the apps' windows into. It is
// always there once the page runs, so wland can mount at any time, and is
// only hidden (visibility, not display: the output keeps its size; and
// inert, so its windows take no focus) while the desktop is not shown.
// Once shown, its top window takes the keyboard (focusDesktop(): only
// after the render, since an inert layer takes no focus).
// Over the guest's display (z-10), under the preview (z-15). React renders
// the container once and never touches its children, which are wland's.
import { memo, useEffect } from "react";
import { focusDesktop, setDesktopContainer } from "../wayland.ts";
import { useStore } from "../store.ts";
import { useSize } from "./Display.tsx";

const Container = memo(() => <div id="wl-desktop" ref={setDesktopContainer} className="relative h-full w-full overflow-hidden" />);

export function Desktop({ stage }: { stage: HTMLElement | null }) {
	const shown = useStore((s) => s.desktop.shown);
	const st = useSize(stage);
	useEffect(() => { if (shown) focusDesktop(); }, [shown]);
	return (
		<div id="wl-layer" inert={!shown} data-shown={shown || undefined}
			className={`absolute top-0 left-0 z-11 bg-[#16161a] ${shown ? "" : "invisible pointer-events-none"}`}
			style={{ width: st.w, height: st.h }}>
			<Container />
		</div>
	);
}
