// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Aquarium: asciiquarium, the perl aquarium animation, in the foreground.
// It is in community and pulls in perl, Term::Animation and Curses (9.9 MB
// to download, 40 MB installed), so the first run takes a while; after
// that it starts in about a second under the emulator. Its frame rate
// suits the page's terminal as it is: it redraws at most every 0.1 s
// (halfdelay(1)), and only what moved, about 11 KiB/s on 100x30. On q or
// Ctrl-C, Term::Animation ends curses (cursor shown, alternate screen
// left), so the terminal is back to normal for the shell after it.
import type { Demo } from "../launcher.ts";

export default {
	id: "aquarium",
	title: "Aquarium",
	desc: "asciiquarium: fish, sharks and a castle in the terminal (q quits, p pauses, r redraws)",
	// A fish and its bubbles.
	icon: { svg: '<path fill-rule="evenodd" d="M1.5 13c2.2-4 5.7-6.2 9.5-6.2 3.4 0 5.9 1.9 7.3 4.5L22.5 8v10l-4.2-3.3C16.9 17.3 14.4 19.2 11 19.2 7.2 19.2 3.7 17 1.5 13Zm5.6-2.3a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/><path d="M8.6 7.6c1.2-2.3 3.2-3.6 6-3.8-.7 1.3-.8 2.6-.4 3.9Z"/><circle opacity=".7" cx="4" cy="7" r="1.3"/><circle opacity=".55" cx="6.5" cy="3.3" r=".9"/>' },
	colors: ["#38bdf8", "#1e3a8a"],
	community: true,
	files: {
		"README": "asciiquarium: an aquarium animation in perl (Term::Animation), the riscv64\n" +
			"build from Alpine, running on Linux in this browser tab.\n\n" +
			"  q quits   p pauses   r redraws (new fish, and the window's new size)\n\n" +
			"Ctrl-C quits too.\n",
	},
	packages: ["asciiquarium"],
	commands: ["cat README", "asciiquarium"],
} satisfies Demo;
