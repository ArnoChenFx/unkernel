// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// foot: a Wayland terminal as a window on the page's Wayland desktop
// (wayland.ts): `wland foot` runs it against wland's relay in the guest (the
// kw layer's /usr/lib/kw/bin/wland starts it unless the boot did), whose
// compositor runs on the page and
// reads foot's buffers in place through kwshm (Debian).
import type { Demo } from "../launcher.ts";

export default {
	id: "foot",
	title: "foot",
	desc: "A Wayland terminal in a window on the page: wland's compositor runs here, the app's pixels stay in guest memory (kwshm)",
	// A window with a prompt (crafted).
	icon: { svg: '<path d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 4v12h16V7Zm2.3 3.3 1.4-1.4 3.6 3.6-3.6 3.6-1.4-1.4 2.2-2.2ZM12 15h6v2h-6Z"/>' },
	colors: ["#22c55e", "#0f766e"],
	needs: { net: true, wayland: true },
	packages: { debian: ["foot", "fonts-dejavu-core", "fontconfig"] },
	files: {
		README: "wland CMD runs a Wayland app (CMD) as a window on this page: it starts wland's\n" +
			"relay in the guest unless it runs (its log is $XDG_RUNTIME_DIR/wlandr.log) and\n" +
			"sets XDG_RUNTIME_DIR and WAYLAND_DISPLAY for CMD. Where the relay runs from boot\n" +
			"(echo $WAYLAND_DISPLAY says wayland-0), apps also start without it: foot.\n" +
			"The status line's desktop icon (Ctrl-A w) switches between the windows and the\n" +
			"terminal; Alt+drag moves a window, Alt+F10 maximizes it. More to try:\n" +
			"  sudo apt-get install wl-clipboard wayland-utils\n" +
			"  wland wayland-info;  echo hi | wland wl-copy;  wland wl-paste\n" +
			"GTK 3 apps work too (systemd- keeps apt from swapping the init system for dbus):\n" +
			"  sudo apt-get install --no-install-recommends l3afpad systemd-;  wland l3afpad\n",
	},
	commands: ["cat README", "wland foot"],
} satisfies Demo;
