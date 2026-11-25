// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Zed: the code editor as a window on the page's Wayland desktop, its GPU
// renderer (wgpu) on guest Vulkan, which here is this browser's WebGPU (the
// base's ICD, .agents/vk.md) (Debian).
//
// Nothing of Zed is in the page or in Debian. zed.sh installs Zed's own
// aarch64 Linux build on its first run, the way zed.dev/install.sh does: the
// tarball (the version and SHA-256 below are this app's pin; the script's
// cloud.zed.dev URL redirects to the same GitHub release file) unpacked to
// ~/.local/zed.app (190 MiB), ~/.local/bin/zed linked to its CLI and its
// desktop file copied, so a Zed installed with that script is used as it is.
// The guest downloads it (82 MiB) over the page's network: cloud.zed.dev,
// github.com and release-assets.githubusercontent.com send no CORS headers
// (2026-11-25), so the page cannot fetch it (download.ts). The page's mirror
// is asked first, as llama.cpp's script does (it has no copy of Zed's
// releases yet, a quick 404).
//
// Zed runs with --foreground, so zed.sh lasts as long as Zed and the app's
// terminal is its log (launcher.ts); without it the CLI starts the editor
// detached and exits at once. Its window's app id (dev.zed.Zed) ends in this
// app's id. It loads libvulkan.so.1, libwayland-client.so.0, ALSA and GLib
// from the system (the packages below, with rsync for its auto-update; the
// rest is in the tarball). Its Open and Save As dialogs are the desktop
// portal's (D-Bus), which the guest lacks: Zed then shows a ZBus error and
// falls back to its own picker, which "use_system_path_prompts": false takes
// at once. zed.sh writes that into ~/.config/zed/settings.json only when
// there is no such file, and otherwise prints a hint. Its log has harmless
// noise here: D-Bus and keyring errors (no session bus), IPv6 localhost
// probes, xkbcommon's dead_hamza.
import type { TerminalApp } from "../types.ts";

const VER = "1.29.3";
const TARBALL = `https://github.com/zed-industries/zed/releases/download/v${VER}/zed-linux-aarch64.tar.gz`;
const TARBALL_MIRROR = `http://mirror.unkernel.dev/github/zed-industries/zed/releases/download/v${VER}/zed-linux-aarch64.tar.gz`;
const TARBALL_SHA256 = "5f1de233ac02d8c9eff68e9ab4207274df3ddbd2cf9fa6f8a80ef5487f03e8ee";

const ZED_SH = String.raw`#!/bin/sh
# Zed in a window on the page, on guest Vulkan. Written by the unkernel
# launcher's Zed app.
#   ./zed.sh [zed arguments]    (a folder or files to open)
# The first run installs Zed ${VER} into ~/.local/zed.app, as
# zed.dev/install.sh does; delete that directory to install it again.
set -e
URL=${TARBALL}
MURL=${TARBALL_MIRROR}
SHA=${TARBALL_SHA256}
APP=$HOME/.local/zed.app
B='\033[1m' R='\033[31m' N='\033[0m'
die() { printf "$R%s$N\n" "$*" >&2; exit 1; }

if [ ! -x "$APP/bin/zed" ]; then
	free=$(df -Pk "$HOME" | awk 'NR == 2 { print int($4 / 1024) }')
	[ "$free" -ge 300 ] || die "Zed needs 300 MiB on the disk, $free MiB free."
	printf "$B%s$N\n" "Fetching Zed ${VER} (aarch64: 82 MiB, 190 MiB unpacked) from GitHub"
	S=$HOME/.local/zed.app.part
	rm -rf "$S" && mkdir -p "$S"
	# The page's mirror first (plain HTTP, answered by the page's fetch()), then GitHub.
	curl -fsL -o "$S/zed.tar.gz" "$MURL" 2>/dev/null || curl -fL# -o "$S/zed.tar.gz" "$URL"
	echo "$SHA  $S/zed.tar.gz" | sha256sum -c --quiet || { rm -rf "$S"; die "Zed: wrong SHA-256, deleted"; }
	echo "Unpacking..."
	tar -xzf "$S/zed.tar.gz" -C "$S"
	# As install.sh: the app in ~/.local/zed.app, ~/.local/bin/zed, the desktop file.
	rm -rf "$APP" && mv "$S/zed.app" "$APP" && rm -rf "$S"
	mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
	ln -sf "$APP/bin/zed" "$HOME/.local/bin/zed"
	d=$HOME/.local/share/applications/dev.zed.Zed.desktop
	cp "$APP/share/applications/dev.zed.Zed.desktop" "$d"
	sed -i "s|Icon=zed|Icon=$APP/share/icons/hicolor/512x512/apps/zed.png|g; s|Exec=zed|Exec=$APP/bin/zed|g" "$d"
	printf "$B%s$N\n" "Zed is in $APP (zed in ~/.local/bin)"
fi
# Zed's own Open and Save As pickers: the system's dialogs are the desktop
# portal's, on a session bus this guest has none of. Only into a new settings file.
C=${"$"}{XDG_CONFIG_HOME:-$HOME/.config}/zed/settings.json
if [ ! -e "$C" ]; then
	mkdir -p "$(dirname "$C")"
	printf '%s\n' '{' \
		'  // The guest has no desktop portal (no session bus): use Zed'"'"'s own Open and Save As pickers.' \
		'  "use_system_path_prompts": false' '}' >"$C"
elif ! grep -q '"use_system_path_prompts"' "$C"; then
	echo "Hint: add \"use_system_path_prompts\": false to $C, or Open File shows a ZBus error first (no desktop portal here)."
fi
# In the foreground: this script lasts as long as Zed, and its output is the log.
exec "$APP/bin/zed" --foreground "$@"
`;

export default {
	id: "zed",
	title: "Zed",
	desc: "The Zed code editor in a window on the page, drawn on this browser's WebGPU (guest Vulkan); Zed (82 MiB) is fetched on first run",
	// The Zed Industries logo, from Simple Icons (CC0 1.0), slug zedindustries.
	icon: { svg: '<path d="M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z"/>' },
	colors: ["#084ccf", "#172554"],
	needs: { net: true, wayland: true, vk: true },
	packages: { debian: ["libvulkan1", "libwayland-client0", "libasound2t64", "libglib2.0-0t64", "curl", "ca-certificates", "rsync"] },
	files: { "zed.sh": { content: ZED_SH, mode: 0o755 } },
	commands: ["./zed.sh"],
} satisfies TerminalApp;
