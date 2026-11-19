// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Doom: fbDOOM on the guest's framebuffer, built in the guest on first use
// by doom/fbdoom (see its header). No image carries it: the page brings
// the script and its patches (doom/patches/) as text, imported with Vite's
// ?raw. Those files keep their own license (GPL-2.0-or-later, their SPDX
// headers), not this file's: the page ships them as text.
//
// The script goes to /usr/local/bin (in the login PATH, so `fbdoom` works
// in any terminal afterwards), the patches to /usr/share/unkernel/fbdoom,
// where it looks for them. It installs tcc itself, enabling community
// first, so the demo needs neither `packages` nor `community` (but Alpine:
// needs.alpine, for apk). The first
// run downloads tcc and Freedoom and compiles; the game and the WAD go to
// /data/fbdoom with the data disk (kept), else /var/lib/fbdoom (gone at
// power off). A patch removed or renamed upstream stays behind in the
// guest's patch directory from an earlier launch.
import type { Demo, DemoFile } from "../launcher.ts";
import fbdoom from "./doom/fbdoom?raw";

const PATCHES = import.meta.glob<string>("./doom/patches/*.patch", { query: "?raw", import: "default", eager: true });

const README = `Doom in unkernel: fbDOOM with Freedoom (Phase 1), drawn on /dev/fb0, with
keyboard input through evdev and sound effects on /dev/dsp.

The first run builds the game here, in the guest: it installs tcc with apk
(about 8 MiB), downloads fbDOOM's source and Freedoom (about 24 MiB) and
compiles 81 files, which takes under a minute, mostly the downloads. Later
runs start at once. With the data disk the game is kept in /data/fbdoom.

  arrows  move            Ctrl   fire           Space  open doors
  Alt     strafe          Shift  run            Tab    map
  Esc     menu            Enter  select

The status line's fb item switches between the game and this shell.
Arguments go to fbDOOM (fbdoom -warp 1 1 -skill 3); the script is
/usr/local/bin/fbdoom. fbdoom --remove deletes the game and the saves,
fbdoom --remove-compiler removes tcc.
`;

export default {
	id: "doom",
	title: "Doom",
	desc: "fbDOOM with Freedoom on the framebuffer; the first run builds it in the guest (under a minute)",
	// A horned skull (not id Software's logo).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3.5c5 0 8.5 3.4 8.5 7.9 0 2.5-1 4.3-2.8 5.4v1.7H6.3v-1.7c-1.8-1.1-2.8-2.9-2.8-5.4C3.5 6.9 7 3.5 12 3.5ZM5.6 10.4l5 1.4-.4 2.2c-.2 1.1-1.2 1.9-2.4 1.9-1.4 0-2.4-1.1-2.4-2.5Zm12.8 0-5 1.4.4 2.2c.2 1.1 1.2 1.9 2.4 1.9 1.4 0 2.4-1.1 2.4-2.5ZM12 14.8l-1.3 2.3h2.6Z"/><path d="M6.6 19.2h3v3H7.6a1 1 0 0 1-1-1Zm3.9 0h3v3h-3Zm3.9 0h3v2a1 1 0 0 1-1 1h-2ZM5.4 6.6C3.6 5.2 3 3.3 3.4 1.2 4.6 2.9 6 3.8 7.8 4.3Zm13.2 0c1.8-1.4 2.4-3.3 2-5.4-1.2 1.7-2.6 2.6-4.4 3.1Z"/>' },
	colors: ["#dc2626", "#451a03"],
	needs: { display: true, net: true, alpine: true },
	files: {
		"/usr/local/bin/fbdoom": { content: fbdoom, mode: 0o755 },
		...Object.fromEntries(Object.entries(PATCHES).map(([path, text]): [string, DemoFile] =>
			[`/usr/share/unkernel/fbdoom/${path.slice(path.lastIndexOf("/") + 1)}`, { content: text }])),
		"README": README,
	},
	commands: ["cat README", "fbdoom"],
} satisfies Demo;
