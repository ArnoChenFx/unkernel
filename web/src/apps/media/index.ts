// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Media folder: VLC, mpv, internet radio, speech and FreeDOS.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import vlc from "./vlc.ts";
import mpv from "./mpv.ts";
import radio from "./radio.ts";
import speak from "./speak.ts";
import dos from "./dos.ts";

export default defineGroup({
	id: "media", title: "Media", desc: "VLC, mpv, internet radio and speech",
	// A speaker with sound waves.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></g>' },
	colors: ["#ec4899", "#500724"],
}, [vlc, mpv, radio, speak, dos]);
