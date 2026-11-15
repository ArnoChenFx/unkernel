// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Windows 3.1 in DOSBox: DOSBox 0.74-3 on the guest's framebuffer, built in
// the guest on first use by kernel/guest/dosbox-build/guest-build.sh and
// run by kernel/guest/dosbox (see their headers), booting a Windows 3.1
// that is already installed. The image does not carry them yet, so the page
// brings both scripts and the build's patches as text, imported with Vite's
// ?raw from kernel/guest/, so they always match the image's sources. The
// imported texts keep their own license (GPL-2.0-or-later), not this file's.
//
// The scripts go to /usr/local/bin as dosbox and dosbox-build, the patches
// to /usr/share/unkernel/dosbox-build, where dosbox-build looks for them.
// dosbox-build installs g++ with apk, downloads SDL 1.2 and DOSBox and
// compiles them into /data/dosbox with the data disk (kept), else
// /var/lib/dosbox (gone at power off); later runs find its stamp and return
// at once. dosbox then runs that build instead of downloading one.
//
// Nothing from Windows is in the page or the repository: setup.sh
// downloads it in the guest, at run time, from the Internet Archive (the
// item named in WINDOWS below), checks its sha256 and unpacks its WINDOWS
// directory as C:\WINDOWS on DOSBox's drive C: (DIR/c). It skips that when
// C:\WINDOWS\WIN.COM is there.
//
// windows.conf holds the DOSBox settings for Windows and an [autoexec] that
// mounts drive C: and starts WIN; it is passed with -conf, read after the
// script's unkernel.conf and the user's dosbox.conf, so plain `dosbox`
// keeps booting to the DOS prompt.
import type { Demo, DemoFile } from "../launcher.ts";
import dosbox from "../../../kernel/guest/dosbox?raw";
import dosboxBuild from "../../../kernel/guest/dosbox-build/guest-build.sh?raw";

const PATCHES = import.meta.glob<string>("../../../kernel/guest/dosbox-build/*.patch", { query: "?raw", import: "default", eager: true });

// Windows 3.1, installed (WINDOWS\ with WIN.COM, Program Manager, the
// accessories and the games; VGA 640x480 in 16 colours), from
// https://archive.org/details/windows-3.1_20250322. Its zip holds
// Win/WINDOWS/, which setup.sh moves to C:\WINDOWS, where its .ini files
// expect it.
const WINDOWS = {
	url: "https://archive.org/download/windows-3.1_20250322/Win.zip",
	sha256: "897bfa12e0c52eac169d1fbd4c98b3c85e86d6d5616abf226f21f50715e55d0f",
	size: 6489253,
	dir: "Win/WINDOWS",
};

const SETUP_SH = `#!/bin/sh
# Builds DOSBox (dosbox-build) and puts Windows 3.1 on its drive C:, once;
# later runs check and return at once. Written by the unkernel launcher's
# Windows 3.1 demo.
set -e

die() {
	echo "setup.sh: $*" >&2
	exit 1
}

# DOSBox: built here the first time (long), then only checked.
dosbox-build

# DOSBox's directory, chosen as /usr/local/bin/dosbox chooses it.
if [ -n "$DOSBOX_DIR" ]; then
	dir=$DOSBOX_DIR
elif mountpoint -q /data 2>/dev/null && [ -w /data ]; then
	dir=/data/dosbox
else
	dir=/var/lib/dosbox
fi
c=$dir/c

# Windows 3.1, from the Internet Archive.
url=${WINDOWS.url}
sha256=${WINDOWS.sha256}
size=${WINDOWS.size}
if [ ! -f "$c/WINDOWS/WIN.COM" ]; then
	[ -e "$c/WINDOWS" ] && die "$c/WINDOWS exists but holds no WIN.COM; move it away and run ./run.sh again"
	mkdir -p "$c"
	ip route 2>/dev/null | grep -q '^default' ||
		die "no network: Windows 3.1 is downloaded from the Internet Archive"
	echo "setup.sh: downloading Windows 3.1 ($((size / 1024)) KiB) from the Internet Archive"
	echo "setup.sh: $url"
	part=$dir/.windows-part
	rm -rf "$part"
	mkdir "$part"
	wget -q -O "$part/win.zip" "$url" || {
		rm -rf "$part"
		die "download failed: $url"
	}
	sum=$(sha256sum "$part/win.zip" | awk '{ print $1 }')
	[ "$sum" = "$sha256" ] || {
		rm -rf "$part"
		die "checksum mismatch for $url: expected $sha256, got $sum"
	}
	echo "setup.sh: unpacking it into $c/WINDOWS"
	unzip -q "$part/win.zip" -d "$part/x" || {
		rm -rf "$part"
		die "cannot unpack $url (out of space?)"
	}
	[ -f "$part/x/${WINDOWS.dir}/WIN.COM" ] || die "the downloaded file is not as expected"
	mv "$part/x/${WINDOWS.dir}" "$c/WINDOWS"
	rm -rf "$part"
	sync
fi
mkdir -p "$c/WINDOWS/TEMP"
echo "setup.sh: Windows 3.1 is in $c/WINDOWS"
`;

const WINDOWS_CONF = `# DOSBox settings for Windows 3.1, read after DOSBox's unkernel.conf and
# dosbox.conf: dosbox -conf "$PWD/windows.conf". The launcher rewrites this
# file at every launch; ./run.sh alone keeps your changes.

[dosbox]
machine=svga_s3
memsize=16

[cpu]
core=normal
cputype=auto
cycles=max

[mixer]
# This Windows has no sound driver.
nosound=true

[autoexec]
@echo off
rem DOSBox runs in its directory, so c is its drive C: (DIR/c).
mount c c
c:
set TEMP=C:\\WINDOWS\\TEMP
path C:\\WINDOWS;Z:\\
win
`;

const README = `Windows 3.1 in DOSBox, drawn on /dev/fb0, with the keyboard and the mouse
through evdev.

The first run builds DOSBox here, in the guest: it installs g++ with apk
(about 60 MiB), downloads SDL 1.2 and DOSBox 0.74-3 and compiles them, which
takes BUILD_TIME. It then downloads Windows 3.1 (about 6 MiB, from the
Internet Archive: ${WINDOWS.url.replace(/\/download\/([^/]+)\/.*/, "/details/$1")}).
With the data disk all of it is kept in /data/dosbox and later runs start
Windows in about BOOT_TIME. DOSBox emulates a 386 with an interpreter,
inside the guest's own CPU emulator, so Windows is slow to redraw.

Exit Windows (File, Exit Windows in Program Manager) to get the DOS prompt,
then type exit. Ctrl-C in this terminal ends DOSBox at once. The status
line's fb item switches between Windows and this shell.

Settings: windows.conf here. Drive C: is DIR/c (C:\\WINDOWS is Windows);
plain \`dosbox\` starts at the DOS prompt, where WIN starts Windows.
dosbox-build --remove-compiler removes g++; dosbox --remove deletes DOSBox,
drive C: and Windows.
`;

export default {
	id: "windows",
	// Hidden until DOSBox builds in the guest in a reasonable time (guest-build.sh).
	hidden: true,
	title: "Windows 3.1",
	desc: "Windows 3.1 in DOSBox on the framebuffer; the first run builds DOSBox in the guest (BUILD_TIME) and downloads Windows from the Internet Archive",
	// An old-style window with program groups (not Microsoft's logo).
	icon: { svg: '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-.5 4.5v12h17v-12ZM4 4.4h2.2v1.7H4Z"/><path d="M5.5 9.5h5.5v4H5.5Zm7.5 0h5.5v4H13Zm-7.5 5.5h5.5v3H5.5Zm7.5 0h5.5v3H13Z"/>' },
	colors: ["#008080", "#000080"],
	needs: { display: true, net: true },
	files: {
		"/usr/local/bin/dosbox": { content: dosbox, mode: 0o755 },
		"/usr/local/bin/dosbox-build": { content: dosboxBuild, mode: 0o755 },
		...Object.fromEntries(Object.entries(PATCHES).map(([path, text]): [string, DemoFile] =>
			[`/usr/share/unkernel/dosbox-build/${path.slice(path.lastIndexOf("/") + 1)}`, { content: text }])),
		"setup.sh": { content: SETUP_SH, mode: 0o755 },
		"windows.conf": WINDOWS_CONF,
		"README": README,
	},
	commands: ["cat README", "./setup.sh", `dosbox -conf "$PWD/windows.conf"`],
} satisfies Demo;
