// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// The kiosk's Super key (kiosk.ts). The Omarchy desktop's modifier is Super, the
// Windows or Command key (niri's Mod: distros/omarchy/rootfs/etc/skel/.config/niri/
// config.kdl), and Windows takes the Win key before Chrome sees it. So a key the page
// does see stands for Super: the mod key, Pause by default; ?mod=NAME picks another
// key from MOD_KEYS and ?mod=none turns it off. Held, the mod key is Super down in the
// guest, released Super up. Every other key goes to the guest as before, Alt included.

import { domCodeToLinux, type Evdev } from "../../js/core/input.ts";

/** Linux KEY_LEFTMETA: the Super key. */
export const KEY_LEFTMETA = 125;

// Pause is the default: the desktop binds nothing to it, and it sets no state on Windows
// (ScrollLock lights a lamp, CapsLock changes the case of typing, ContextMenu opens a
// menu, Insert is a paste key in many terminals).
export const MOD_KEYS = ["Pause", "ScrollLock", "Insert", "ContextMenu", "CapsLock", "ControlRight", "AltRight"] as const;
export const DEFAULT_MOD = "Pause";

/** The mod key that ?mod= names: a key from MOD_KEYS, null for none, the default without a value, undefined for anything else. */
export function parseMod(value: string | null): string | null | undefined {
	if (!value) return DEFAULT_MOD;
	if (value === "none") return null;
	return (MOD_KEYS as readonly string[]).includes(value) ? value : undefined;
}

/** What routeKey uses of the guest's keyboard: RemoteEvdev, or any Evdev. */
export type GuestKeys = Pick<Evdev, "key" | "keyboardOpen">;

/**
 * Routes one key event to the guest (a press when `down`, else a release) and returns
 * whether the page takes it, so the caller prevents its default action. The evdev drops a
 * press while the keyboard is closed and a release of a key it did not send, so no key is
 * left down in the guest or released twice.
 */
export function routeKey(guest: GuestKeys, mod: string | null, down: boolean, code: string): boolean {
	if (code === "F11" || code === "F12") return false;
	if (code === mod) {
		guest.key(KEY_LEFTMETA, down);
		return true;
	}
	const linux = domCodeToLinux(code);
	if (!down && linux !== undefined && guest.key(linux, false)) return true;
	if (!guest.keyboardOpen) return false;
	if (down && linux !== undefined) guest.key(linux, true);
	return true;
}
