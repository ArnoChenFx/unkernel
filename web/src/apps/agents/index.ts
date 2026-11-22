// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Agents folder: coding agents that run in a terminal.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import claude from "./claude.ts";
import fx from "./fx.ts";

export default defineGroup({
	id: "agents", title: "Agents", desc: "Coding agents in a terminal",
	// A four-pointed spark with a small one beside it.
	icon: { svg: '<path fill="currentColor" d="M10 3c.6 3.9 2.1 5.4 6 6-3.9.6-5.4 2.1-6 6-.6-3.9-2.1-5.4-6-6 3.9-.6 5.4-2.1 6-6Zm8 10c.3 1.95 1.05 2.7 3 3-1.95.3-2.7 1.05-3 3-.3-1.95-1.05-2.7-3-3 1.95-.3 2.7-1.05 3-3Z"/>' },
	colors: ["#f97316", "#431407"],
}, [fx, claude]);
