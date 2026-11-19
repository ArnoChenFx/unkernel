// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Doom demo's guest files (../doom.ts), a separate chunk that the page
// loads only when the demo launches: the script fbdoom.sh, its patches
// (patches/) and the README. The script and patches come as text, imported
// with Vite's ?raw; they keep their own license (GPL-2.0-or-later, their
// SPDX headers), not this file's: the page ships them as text.
//
// A file imported with ?raw needs an extension. The dev server's Nitro
// middleware tells a module from a page by Sec-Fetch-Dest, which browsers
// send only to secure origins; without it, by ?import (which Vite leaves
// off an extensionless path) or an extension. So on plain http (a LAN
// address) an extensionless import got index.html and the page failed.
import type { DemoFile, DemoFiles } from "../../launcher.ts";
import fbdoom from "./fbdoom.sh?raw";

const PATCHES = import.meta.glob<string>("./patches/*.patch", { query: "?raw", import: "default", eager: true });

const README = `Doom in unkernel: fbDOOM with Freedoom (Phase 1), drawn on /dev/fb0, with
keyboard input through evdev and sound effects on /dev/dsp.

The first run builds the game here, in the guest: it installs tcc
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
	"/usr/local/bin/fbdoom": { content: fbdoom, mode: 0o755 },
	...Object.fromEntries(Object.entries(PATCHES).map(([path, text]): [string, DemoFile] =>
		[`/usr/share/unkernel/fbdoom/${path.slice(path.lastIndexOf("/") + 1)}`, { content: text }])),
	"README": README,
} satisfies DemoFiles;
