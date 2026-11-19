// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Doom: fbDOOM on the guest's framebuffer, built in the guest on first use
// by doom/fbdoom.sh (see its header). No image carries it: the page brings
// the script and its patches (doom/patches/) as text, with the README, in
// doom/files.ts, loaded only when the demo launches.
//
// The script goes to /usr/local/bin (in the login PATH, so `fbdoom` works
// in any terminal afterwards), the patches to /usr/share/unkernel/fbdoom,
// where it looks for them. It installs tcc itself (apk, enabling community
// first, or apt-get), so the demo needs neither `packages` nor `community`.
// The first
// run downloads tcc and Freedoom and compiles; the game and the WAD go to
// /data/fbdoom with the data disk (kept), else /var/lib/fbdoom (gone at
// power off). A patch removed or renamed upstream stays behind in the
// guest's patch directory from an earlier launch.
import type { Demo } from "../launcher.ts";

export default {
	id: "doom",
	title: "Doom",
	desc: "fbDOOM with Freedoom on the framebuffer; the first run builds it in the guest (under a minute)",
	// A horned skull (not id Software's logo).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3.5c5 0 8.5 3.4 8.5 7.9 0 2.5-1 4.3-2.8 5.4v1.7H6.3v-1.7c-1.8-1.1-2.8-2.9-2.8-5.4C3.5 6.9 7 3.5 12 3.5ZM5.6 10.4l5 1.4-.4 2.2c-.2 1.1-1.2 1.9-2.4 1.9-1.4 0-2.4-1.1-2.4-2.5Zm12.8 0-5 1.4.4 2.2c.2 1.1 1.2 1.9 2.4 1.9 1.4 0 2.4-1.1 2.4-2.5ZM12 14.8l-1.3 2.3h2.6Z"/><path d="M6.6 19.2h3v3H7.6a1 1 0 0 1-1-1Zm3.9 0h3v3h-3Zm3.9 0h3v2a1 1 0 0 1-1 1h-2ZM5.4 6.6C3.6 5.2 3 3.3 3.4 1.2 4.6 2.9 6 3.8 7.8 4.3Zm13.2 0c1.8-1.4 2.4-3.3 2-5.4-1.2 1.7-2.6 2.6-4.4 3.1Z"/>' },
	colors: ["#dc2626", "#451a03"],
	needs: { display: true, net: true },
	files: () => import("./doom/files.ts").then((m) => m.default),
	commands: ["cat README", "fbdoom"],
} satisfies Demo;
