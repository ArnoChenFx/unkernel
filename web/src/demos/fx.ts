// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fx: the fx coding agent (fx.sh), run natively on the aarch64 guest. The
// page writes the stand-in ~/.local/bin/fx (shims.ts, kw-shim.sh), which
// installs fx's newest linux-aarch64 release on its first call (a 4.5 MB
// download, about 2 s under the Node CLI, 2026-11-18) and is replaced by it,
// so this demo only runs `fx`. Nothing from fx is in the page.
import type { Demo } from "../launcher.ts";

export default {
	id: "fx",
	title: "fx",
	desc: "The fx coding agent, installed into ~/.local/bin on first use",
	icon: "𝒇x",
	colors: ["#3f3f46", "#09090b"],
	// Left out of the launcher: the status line's fx button runs fx in the page (fx.ts). ?demo=fx still runs this.
	hidden: true,
	needs: { net: true },
	commands: ["fx"],
} satisfies Demo;
