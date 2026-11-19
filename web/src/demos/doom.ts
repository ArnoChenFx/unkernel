// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Doom: fbDOOM on the guest's framebuffer, built in the guest on first use
// by the fbdoom script below (see its header). No image carries it: the
// page brings the script, its patches to fbDOOM and the README as the text
// in this file. The script and the patches keep their own license
// (GPL-2.0-or-later: the script's SPDX header, fbDOOM's for the patches),
// not this file's: the page ships them as text.
//
// The patches are `git format-patch` output, applied in name order with
// patch -p1: keep their trailing whitespace, and escape \, ` and ${ as
// template literals need.
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
import type { Demo, DemoFile } from "../launcher.ts";

const FBDOOM_SH = `#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# fbdoom [fbDOOM options]: Doom on /dev/fb0 (the page's display, or the
# CLI's --display), with sound effects on /dev/dsp; installed as
# /usr/bin/fbdoom.
#
# The first run builds the game here, in the guest, then starts it; later
# runs start at once:
# - installs a C compiler with apk (Alpine) or apt-get (Debian): tcc by
#   default, about 8 MiB to download; FBDOOM_CC=gcc or clang works too, if
#   slower to get,
# - downloads fbDOOM's source at a pinned commit (github.com/maximevince/
#   fbDOOM, GPL-2.0-or-later), checks its sha256, applies the patches in
#   /usr/share/unkernel/fbdoom (web/src/demos/doom.ts) and compiles it,
# - downloads the Freedoom 0.13.0 release zip (BSD-3-Clause), of which
#   freedoom1.wad (Phase 1) and its COPYING.txt are kept.
# Everything goes to /data/fbdoom when the persistent data disk is mounted
# (kept across boots, safe mode, kw-overlay discard and image updates), else to
# /var/lib/fbdoom (gone at power off); FBDOOM_DIR overrides the place.
# The compiler goes wherever the package manager installs (with the data
# disk: the overlay root, so it persists too). Settings and saves are in
# DIR/.fbdoom/.
#   fbdoom --remove-compiler   remove the packages the build installed
#   fbdoom --remove            delete DIR (the game, the WAD, saves)
# A new image with other patches rebuilds the game at the next run.
#
# Keys: an evdev keyboard (the page, the CLI's {key=...}) with real
# presses and releases, else the console: arrows move, Ctrl fires (f on the
# console), Space opens doors, Alt strafes (, and . on the console), Shift
# runs, Tab shows the map, Esc is the menu, Enter selects; on the console a
# key counts as held for 0.3 s (no releases there). Ctrl-C on the console
# quits, as does the menu's Quit Game.
# Extra arguments go to fbDOOM (-warp 1 1, -skill 3, -nosound, -fbmode WxH
# or -fbmode 0, ...); with -iwad, that WAD replaces Freedoom.

src_commit=e52885ff8a4cba99586c33b09339a9a56a69c041
src_url=https://github.com/maximevince/fbDOOM/archive/$src_commit.tar.gz
src_sha256=216901bd4afeb0d37fd0100e986c909d8b4300d9c4eb9feeabe569b1e8b0551e
patch_dir=/usr/share/unkernel/fbdoom
wad_url=https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
wad_sha256=3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
wad_zip_dir=freedoom-0.13.0
wad_kib=55296    # zip 23.6 MiB + WAD 27.5 MiB, with some room

cc=\${FBDOOM_CC:-tcc}
case $cc in
tcc) cc_flags= cc_kib=40960 cc_mib=8 ;;
gcc) cc_flags="-O2 -std=gnu99" cc_kib=256000 cc_mib=78 ;;
clang) cc_flags="-O2 -std=gnu99" cc_kib=307200 cc_mib=108 ;;
*) echo "fbdoom: FBDOOM_CC must be tcc, gcc or clang" >&2; exit 2 ;;
esac
# The packages: Alpine's (apk) or Debian's (apt-get; libc6-dev brings the
# kernel's headers, linux-libc-dev).
if command -v apk >/dev/null; then
	pm=apk
	case $cc in
	tcc) cc_pkgs="tcc tcc-libs-static musl-dev linux-headers patch" ;;
	gcc) cc_pkgs="gcc musl-dev linux-headers patch" ;;
	clang) cc_pkgs="clang21 linux-headers patch" ;;
	esac
	pkg_installed() { apk info -e "$1" >/dev/null 2>&1; }
	pkg_remove() { apk del -q --no-progress "$@"; }
else
	pm=apt-get
	case $cc in
	tcc) cc_pkgs="tcc libc6-dev patch" ;;
	gcc) cc_pkgs="gcc libc6-dev patch" ;;
	clang) cc_pkgs="clang libc6-dev patch" ;;
	esac
	pkg_installed() { [ "$(dpkg-query -W -f='\${db:Status-Status}' "$1" 2>/dev/null)" = installed ]; }
	pkg_remove() { apt-get remove -y -q "$@" </dev/null >/dev/null; }
fi

gray=$(printf '\\033[90m') reset=$(printf '\\033[0m')
[ -t 1 ] || gray= reset=
say() {
	echo "\${gray}fbdoom: $*\${reset}"
}
die() {
	echo "fbdoom: $*" >&2
	exit 1
}

if [ -n "$FBDOOM_DIR" ]; then
	dir=$FBDOOM_DIR
	keep=
elif mountpoint -q /data 2>/dev/null && [ -w /data ]; then
	dir=/data/fbdoom
	keep=
else
	dir=/var/lib/fbdoom
	keep=" (no data disk: kept only until power off)"
fi

case $1 in
--remove)
	rm -rf "$dir" && echo "fbdoom: removed $dir"
	exit ;;
--remove-compiler)
	pkgs=$(cat "$dir/.compiler-added" 2>/dev/null)
	[ -n "$pkgs" ] || { echo "fbdoom: the build installed no packages"; exit 0; }
	pkg_remove $pkgs && rm -f "$dir/.compiler-added" && echo "fbdoom: removed $pkgs"
	exit ;;
esac

[ -c /dev/fb0 ] || die "no /dev/fb0: the host gives this system no display (CLI: --display)"

# Each part is (re)made when it is missing or this script names another
# version of it: the game by the source, the patches and the compiler.
bin_stamp=$( { echo "$src_sha256 $cc $cc_flags"; cat "$patch_dir"/*.patch; } 2>/dev/null | sha256sum | cut -c1-64)
get_bin=
get_wad=
[ "$(cat "$dir/.bin-stamp" 2>/dev/null)" = "$bin_stamp" ] && [ -x "$dir/fbdoom" ] || get_bin=1
[ "$(cat "$dir/.wad-sha256" 2>/dev/null)" = $wad_sha256 ] && [ -s "$dir/freedoom1.wad" ] || get_wad=1

if [ -n "$get_bin$get_wad" ]; then
	ls "$patch_dir"/*.patch >/dev/null 2>&1 || die "no patches in $patch_dir"
	mkdir -p "$dir" || die "cannot create $dir"
	cd "$dir" || exit 1
	rm -rf .part
	mkdir .part || die "cannot write to $dir"

	# Space: the compiler where packages install (/), the build and the WAD in DIR.
	need_cc=0
	missing=
	if [ -n "$get_bin" ]; then
		for p in $cc_pkgs; do
			pkg_installed "$p" || missing="$missing $p"
		done
		[ -n "$missing" ] && need_cc=$cc_kib
	fi
	need=4096
	[ -n "$get_bin" ] && need=$((need + 16384))
	[ -n "$get_wad" ] && need=$((need + wad_kib))
	free_kib() {
		df -Pk "$1" | awk 'NR == 2 && $2 > 0 { print $4 }'
	}
	if [ "$(df -P / | awk 'NR == 2 { print $6 }')" = "$(df -P . | awk 'NR == 2 { print $6 }')" ]; then
		need=$((need + need_cc))
		need_cc=0
	fi
	avail=$(free_kib .)
	[ -n "$avail" ] && [ "$avail" -lt $need ] &&
		die "not enough space in $dir: $((avail / 1024)) MiB free, $((need / 1024)) MiB needed"
	avail=$(free_kib /)
	[ $need_cc -gt 0 ] && [ -n "$avail" ] && [ "$avail" -lt $need_cc ] &&
		die "not enough space for the compiler on /: $((avail / 1024)) MiB free, $((need_cc / 1024)) MiB needed"
	ip route 2>/dev/null | grep -q '^default' ||
		die "no network: the first run downloads a compiler, fbDOOM's source and Freedoom"

	# fetch URL FILE SHA256
	fetch() {
		# wget (Alpine) or curl (Debian) shows its progress on a terminal (the
		# WAD is 24 MiB, and the page's network may be slow).
		if command -v wget >/dev/null; then
			q=-q
			[ -t 2 ] && q=
			get() { wget $q -O "$2" "$1"; }
		else
			q=-sS
			[ -t 2 ] && q=-#
			get() { curl -fL $q -o "$2" "$1"; }
		fi
		get "$1" "$2" || {
			rm -rf .part
			die "download failed: $1 (network or server problem)"
		}
		set -- "$1" "$2" "$3" $(sha256sum "$2")
		[ "$4" = "$3" ] || {
			rm -rf .part
			die "checksum mismatch for $1: expected $3, got $4"
		}
	}

	if [ -n "$get_bin" ]; then
		echo "fbdoom: first run: building fbDOOM here with $cc, into $dir$keep"
		if [ $cc = tcc ]; then
			echo "fbdoom: about 33 MiB to download and 81 files to compile: half a minute to a few minutes"
		else
			echo "fbdoom: compiling with $cc takes 10 minutes or more"
		fi
	else
		echo "fbdoom: getting Freedoom into $dir$keep"
	fi
	step=0
	steps=0
	[ -n "$get_bin" ] && steps=3 && [ -z "$missing" ] && steps=2
	[ -n "$get_wad" ] && steps=$((steps + 1))
	next() {
		step=$((step + 1))
		say "[$step/$steps] $*"
	}

	if [ -n "$get_bin" ]; then
		if [ -n "$missing" ]; then
			next "installing the compiler:$missing (about $cc_mib MiB to download)"
			if [ $pm = apk ]; then
				# tcc is in community, which the image leaves off until needed.
				[ $cc != tcc ] || [ ! -x /etc/kw-apk-enable ] || /etc/kw-apk-enable
				if ! ls /var/cache/apk/APKINDEX.*.tar.gz >/dev/null 2>&1; then
					apk update -q --no-progress || die "apk update failed (network?)"
				fi
				apk add -q --no-progress $missing || die "apk add$missing failed"
			else
				# The image's package lists are baked in and age: when a version
				# is gone from the mirror, fetch them again and retry once.
				inst() { apt-get install -y -q --no-install-recommends $missing </dev/null; }
				inst || { apt-get update -q </dev/null && inst; } || die "apt-get install$missing failed"
			fi
			# Remember what was added for this, for --remove-compiler.
			echo $missing $(cat .compiler-added 2>/dev/null) | tr ' ' '\\n' | sort -u | tr '\\n' ' ' > .compiler-added
		fi
		next "downloading fbDOOM's source (0.5 MiB)"
		fetch "$src_url" .part/src.tar.gz $src_sha256
		tar -xzf .part/src.tar.gz -C .part || die "cannot unpack the source (out of space?)"
		src=.part/fbDOOM-$src_commit
		for p in "$patch_dir"/*.patch; do
			patch -s -p1 -d "$src" < "$p" || die "patch \${p##*/} does not apply"
		done
		srcs="i_video_fbdev.c i_input_tty.c i_sound_oss.c $(sed -n 's/^SRC_DOOM = //p' "$src/fbdoom/Makefile" | sed 's/\\.o/.c/g')"
		n=$(echo $srcs | wc -w)
		next "compiling $n files with $cc"
		i=0
		start=$(date +%s)
		for f in $srcs; do
			i=$((i + 1))
			[ -t 1 ] && printf '\\r%s  %d/%d %-20s%s' "$gray" $i $n "$f" "$reset"
			(cd "$src/fbdoom" && $cc $cc_flags -DNORMALUNIX -DLINUX -w -c "$f" -o "\${f%.c}.o") ||
				die "compiling $f failed"
		done
		[ -t 1 ] && printf '\\r%-40s\\r' ''
		(cd "$src/fbdoom" && $cc -o fbdoom $(for f in $srcs; do printf '%s ' "\${f%.c}.o"; done) -lm) ||
			die "linking failed"
		say "compiled in $(($(date +%s) - start)) s"
		rm -rf fbdoom .bin-stamp .bin-sha256
		mv "$src/fbdoom/fbdoom" fbdoom || die "cannot write to $dir"
		echo "$bin_stamp" > .bin-stamp
		rm -rf .part/src.tar.gz "$src"
	fi
	if [ -n "$get_wad" ]; then
		next "downloading Freedoom (24 MiB) and unpacking freedoom1.wad"
		fetch "$wad_url" .part/wad.zip $wad_sha256
		mkdir .part/new
		unzip -q -o -j .part/wad.zip "$wad_zip_dir/freedoom1.wad" "$wad_zip_dir/COPYING.txt" \\
			-d .part/new || die "cannot unpack freedoom1.wad (out of space?)"
		[ -s .part/new/freedoom1.wad ] || die "the Freedoom zip holds no freedoom1.wad"
		rm -f freedoom1.wad .wad-sha256
		mv .part/new/COPYING.txt freedoom-COPYING.txt &&
			mv .part/new/freedoom1.wad . || die "cannot write to $dir"
		echo $wad_sha256 > .wad-sha256
	fi
	rm -rf .part
	sync
	[ -s .compiler-added ] &&
		echo "fbdoom: ready. The compiler stays installed; 'fbdoom --remove-compiler' removes it ($(cat .compiler-added))"
fi

case " $* " in
*" -iwad "*) ;;
*) set -- -iwad "$dir/freedoom1.wad" "$@" ;;
esac
cd "$dir" || exit 1
# HOME: fbDOOM keeps default.cfg and the saves in $HOME/.fbdoom.
# -mb 16: Chocolate Doom's zone size (fbDOOM's default of 6 MiB is small
# for Freedoom's maps).
HOME=$dir exec ./fbdoom -mb 16 "$@"
`;

const PATCHES: Record<string, string> = {
	"0001-Store-the-configuration-and-saves-in-HOME-.fbdoom.patch": `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Pooya Parsa <pooya@pi0.io>
Date: Sat, 14 Nov 2026 00:53:46 +0000
Subject: [PATCH 1/6] Store the configuration and saves in $HOME/.fbdoom

---
 fbdoom/m_config.c | 5 ++---
 1 file changed, 2 insertions(+), 3 deletions(-)

diff --git a/fbdoom/m_config.c b/fbdoom/m_config.c
index 31ac7a6..4c7c1c5 100644
--- a/fbdoom/m_config.c
+++ b/fbdoom/m_config.c
@@ -2051,8 +2051,7 @@ static char *GetDefaultConfigDir(void)
     char *homedir;
     char *result;
 
-    // frosted HACK - homedir = getenv("HOME");
-    homedir = "/mnt";
+    homedir = getenv("HOME");
 
     if (homedir != NULL)
     {
@@ -2060,7 +2059,7 @@ static char *GetDefaultConfigDir(void)
         // homedir
 
         result = M_StringJoin(homedir, DIR_SEPARATOR_S,
-                              "." PACKAGE_TARNAME, DIR_SEPARATOR_S, NULL);
+                              ".fbdoom", DIR_SEPARATOR_S, NULL);
 
         return result;
     }
`,
	"0002-fbdev-32-bpp-fast-path-with-4-3-scaling.patch": `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Pooya Parsa <pooya@pi0.io>
Date: Sat, 14 Nov 2026 00:53:46 +0000
Subject: [PATCH 2/6] fbdev: 32 bpp fast path with 4:3 scaling

---
 fbdoom/i_video_fbdev.c | 90 +++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 89 insertions(+), 1 deletion(-)

diff --git a/fbdoom/i_video_fbdev.c b/fbdoom/i_video_fbdev.c
index c6e5925..df62519 100644
--- a/fbdoom/i_video_fbdev.c
+++ b/fbdoom/i_video_fbdev.c
@@ -37,7 +37,9 @@ rcsid[] = "$Id: i_x.c,v 1.6 1997/02/03 22:45:10 b1 Exp $";
 #include "doomkeys.h"
 
 #include <stdbool.h>
+#include <stdint.h>
 #include <stdlib.h>
+#include <string.h>
 #include <unistd.h>
 #include <fcntl.h>
 
@@ -54,6 +56,19 @@ struct fb_var_screeninfo fb = {};
 int fb_scaling = 1;
 int usemouse = 0;
 
+/*
+ * 32 bpp fast path: the palette is kept in the framebuffer's pixel format,
+ * columns are scaled by fb32_sx and rows stretched to fb32_h, which is
+ * 240 * fb32_sx (the 4:3 picture that 320x200 was drawn for; 640x480 on a
+ * 640x480 screen) or 200 * fb32_sx with -noaspect. Each frame is one
+ * pwrite() of the rows in use, so a reader never sees half a frame drawn.
+ */
+static int fb32;
+static int fb32_sx, fb32_w, fb32_h, fb32_x0, fb32_y0;
+static unsigned int fb32_stride;
+static uint32_t fb32_palette[256];
+static unsigned char *fb32_buf;
+
 struct color {
     uint32_t b:8;
     uint32_t g:8;
@@ -166,7 +181,7 @@ void I_InitGraphics (void)
     fd_fb = open("/dev/fb0", O_RDWR);
     if (fd_fb < 0)
     {
-        printf("Could not open /dev/fb0");
+        perror("Could not open /dev/fb0");
         exit(-1);
     }
 
@@ -196,6 +211,36 @@ void I_InitGraphics (void)
     }
 
 
+    {
+        struct fb_fix_screeninfo fix;
+        int sx, h;
+
+        if (fb.bits_per_pixel == 32 && !M_CheckParm("-scaling")
+         && ioctl(fd_fb, FBIOGET_FSCREENINFO, &fix) == 0)
+        {
+            sx = fb.xres / SCREENWIDTH;
+            h = M_CheckParm("-noaspect") ? SCREENHEIGHT : 240;
+            if ((int) fb.yres / h < sx)
+                sx = fb.yres / h;
+            if (sx >= 1)
+            {
+                fb32 = 1;
+                fb32_sx = sx;
+                fb32_w = SCREENWIDTH * sx;
+                fb32_h = h * sx;
+                fb32_x0 = (fb.xres - fb32_w) / 2;
+                fb32_y0 = (fb.yres - fb32_h) / 2;
+                fb32_stride = fix.line_length;
+                fb32_buf = calloc(fb32_h, fb32_stride);
+                if (!fb32_buf)
+                    fb32 = 0;
+            }
+        }
+        if (fb32)
+            printf("I_InitGraphics: 32 bpp, %dx%d at %d,%d\\n",
+                   fb32_w, fb32_h, fb32_x0, fb32_y0);
+    }
+
     /* Allocate screen to draw to */
 	I_VideoBuffer = (byte*)Z_Malloc (SCREENWIDTH * SCREENHEIGHT, PU_STATIC, NULL);  // For DOOM to draw on
 	I_VideoBuffer_FB = (byte*)malloc(fb.xres * fb.yres * (fb.bits_per_pixel/8));     // For a single write() syscall to fbdev
@@ -400,12 +445,51 @@ void I_UpdateNoBlit (void)
 // I_FinishUpdate
 //
 
+static void I_FinishUpdate32 (void)
+{
+    int x, y, k, src, prev = -1;
+    unsigned char *line, *last = NULL;
+
+    for (y = 0; y < fb32_h; y++)
+    {
+        line = fb32_buf + (size_t) y * fb32_stride;
+        src = y * SCREENHEIGHT / fb32_h;
+        if (src == prev)
+        {
+            memcpy(line + fb32_x0 * 4, last + fb32_x0 * 4, fb32_w * 4);
+        }
+        else
+        {
+            const byte *in = I_VideoBuffer + src * SCREENWIDTH;
+            uint32_t *out = (uint32_t *) line + fb32_x0;
+
+            for (x = 0; x < SCREENWIDTH; x++)
+            {
+                uint32_t pix = fb32_palette[in[x]];
+
+                for (k = 0; k < fb32_sx; k++)
+                    *out++ = pix;
+            }
+        }
+        prev = src;
+        last = line;
+    }
+    pwrite(fd_fb, fb32_buf, (size_t) fb32_h * fb32_stride,
+           (off_t) fb32_y0 * fb32_stride);
+}
+
 void I_FinishUpdate (void)
 {
     int y;
     int x_offset, y_offset, x_offset_end;
     unsigned char *line_in, *line_out;
 
+    if (fb32)
+    {
+        I_FinishUpdate32();
+        return;
+    }
+
     /* Offsets in case FB is bigger than DOOM */
     /* 600 = fb heigt, 200 screenheight */
     /* 600 = fb heigt, 200 screenheight */
@@ -487,6 +571,10 @@ void I_SetPalette (byte* palette)
         colors[i].r = gammatable[usegamma][*palette++];
         colors[i].g = gammatable[usegamma][*palette++];
         colors[i].b = gammatable[usegamma][*palette++];
+        fb32_palette[i] =
+            ((uint32_t) (colors[i].r >> (8 - fb.red.length)) << fb.red.offset)
+          | ((uint32_t) (colors[i].g >> (8 - fb.green.length)) << fb.green.offset)
+          | ((uint32_t) (colors[i].b >> (8 - fb.blue.length)) << fb.blue.offset);
     }
 
     /* Set new color map in kernel framebuffer driver */
`,
	"0003-Read-the-keyboard-from-evdev-or-the-terminal-when-th.patch": `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Pooya Parsa <pooya@pi0.io>
Date: Sat, 14 Nov 2026 00:53:46 +0000
Subject: [PATCH 3/6] Read the keyboard from evdev or the terminal when there
 is no VT

---
 fbdoom/i_input_tty.c   | 308 ++++++++++++++++++++++++++++++++++++++++-
 fbdoom/i_video_fbdev.c |   6 +-
 2 files changed, 306 insertions(+), 8 deletions(-)

diff --git a/fbdoom/i_input_tty.c b/fbdoom/i_input_tty.c
index 95e1b60..58bb9c8 100644
--- a/fbdoom/i_input_tty.c
+++ b/fbdoom/i_input_tty.c
@@ -28,6 +28,9 @@
 #include <sys/ioctl.h>
 #include <linux/keyboard.h>
 #include <linux/kd.h>
+#include <linux/input.h>
+#include <dirent.h>
+#include <signal.h>
 
 #include "config.h"
 #include "deh_str.h"
@@ -143,8 +146,8 @@ static const char at_to_doom[] =
     /* 0x54 */ 0x0, /* 54 (Alt-SysRq) on a 84+ key keyboard */
     /* 0x55 */ 0x0,
     /* 0x56 */ 0x0,
-    /* 0x57 */ 0x0,
-    /* 0x58 */ 0x0,
+    /* 0x57 */ KEY_F11,
+    /* 0x58 */ KEY_F12,
     /* 0x59 */ 0x0,
     /* 0x5a */ 0x0,
     /* 0x5b */ 0x0,
@@ -153,10 +156,10 @@ static const char at_to_doom[] =
     /* 0x5e */ 0x0,
     /* 0x5f */ 0x0,
     /* 0x60 */ 0x0,
-    /* 0x61 */ 0x0,
+    /* 0x61 */ KEY_FIRE, /* KEY_RIGHTCTRL */
     /* 0x62 */ 0x0,
     /* 0x63 */ 0x0,
-    /* 0x64 */ 0x0,
+    /* 0x64 */ KEY_RALT,
     /* 0x65 */ 0x0,
     /* 0x66 */ 0x0,
     /* 0x67 */ KEY_UPARROW,
@@ -175,7 +178,7 @@ static const char at_to_doom[] =
     /* 0x74 */ 0x0,
     /* 0x75 */ 0x0,
     /* 0x76 */ 0x0,
-    /* 0x77 */ 0x0,
+    /* 0x77 */ KEY_PAUSE,
     /* 0x78 */ 0x0,
     /* 0x79 */ 0x0,
     /* 0x7a */ 0x0,
@@ -426,7 +429,7 @@ static void UpdateShiftStatus(int pressed, unsigned char key)
 }
 
 
-void I_GetEvent(void)
+static void vt_get_event(void)
 {
     event_t event;
     int pressed;
@@ -491,9 +494,300 @@ void I_GetEvent(void)
                 */
 }
 
+/*
+ * Without a virtual terminal (KDSKBMODE) the keyboard comes from an evdev
+ * device (/dev/input/event*, real presses and releases) or from the
+ * terminal on stdin. Both are read until the first evdev key event; from
+ * then on terminal input is only drained, so a host that sends each key to
+ * both does not deliver it twice.
+ *
+ * A terminal sends characters and escape sequences, not releases: a key
+ * goes down at its first byte and up TERM_HOLD_FIRST ms later, or
+ * TERM_HOLD_REPEAT ms after its last repeat while autorepeat runs. There
+ * is no Ctrl, Alt or Shift on their own: 'f' fires, ',' and '.' strafe.
+ * The terminal is raw (no echo, no line editing) while the game runs and is
+ * restored at exit; Ctrl-C still quits.
+ */
+
+#define TERM_HOLD_FIRST 300
+#define TERM_HOLD_REPEAT 100
+#define MAX_EVDEV 8
+
+enum { INPUT_NONE, INPUT_VT, INPUT_EVDEV };
+static int input_mode = INPUT_NONE;
+
+static int evdev_fds[MAX_EVDEV];
+static int evdev_count;
+static int evdev_seen;
+
+static int term_fd = -1;
+static struct termios term_saved;
+static int term_down_until[256]; /* release time per Doom key, 0 = up */
+
+static void term_restore(void)
+{
+    if (term_fd >= 0)
+    {
+        tcsetattr(term_fd, TCSAFLUSH, &term_saved);
+        term_fd = -1;
+    }
+}
+
+static void term_signal(int sig)
+{
+    term_restore();
+    signal(sig, SIG_DFL);
+    raise(sig);
+}
+
+static void term_init(void)
+{
+    struct termios t;
+
+    if (!isatty(0) || tcgetattr(0, &term_saved) != 0)
+        return;
+    t = term_saved;
+    t.c_iflag &= ~(ICRNL | INLCR | IGNCR | IXON);
+    t.c_lflag &= ~(ECHO | ICANON);
+    t.c_cc[VMIN] = 0;   /* read() returns at once, no O_NONBLOCK needed */
+    t.c_cc[VTIME] = 0;
+    if (tcsetattr(0, TCSAFLUSH, &t) != 0)
+        return;
+    term_fd = 0;
+    atexit(term_restore);
+    signal(SIGINT, term_signal);
+    signal(SIGTERM, term_signal);
+    signal(SIGHUP, term_signal);
+}
+
+static void post_key(int down, int key, int ch)
+{
+    event_t event;
+
+    if (key == 0)
+        return;
+    event.type = down ? ev_keydown : ev_keyup;
+    event.data1 = key;
+    event.data2 = down ? ch : 0;
+    event.data3 = 0;
+    D_PostEvent(&event);
+}
+
+static void term_key(int key, int ch)
+{
+    int now = I_GetTimeMS();
+
+    if (key == 0)
+        return;
+    if (term_down_until[key])
+    {
+        term_down_until[key] = now + TERM_HOLD_REPEAT;
+        return;
+    }
+    term_down_until[key] = now + TERM_HOLD_FIRST;
+    post_key(1, key, ch);
+}
+
+/* The key for an escape sequence ESC [ or ESC O, final byte c, number n. */
+static int term_escape(int c, int n)
+{
+    switch (c)
+    {
+        case 'A': return KEY_UPARROW;
+        case 'B': return KEY_DOWNARROW;
+        case 'C': return KEY_RIGHTARROW;
+        case 'D': return KEY_LEFTARROW;
+        case 'H': return KEY_HOME;
+        case 'F': return KEY_END;
+        case 'P': return KEY_F1;
+        case 'Q': return KEY_F2;
+        case 'R': return KEY_F3;
+        case 'S': return KEY_F4;
+        case '~':
+            switch (n)
+            {
+                case 1: case 7: return KEY_HOME;
+                case 2: return KEY_INS;
+                case 3: return KEY_DEL;
+                case 4: case 8: return KEY_END;
+                case 5: return KEY_PGUP;
+                case 6: return KEY_PGDN;
+                case 11: return KEY_F1;
+                case 12: return KEY_F2;
+                case 13: return KEY_F3;
+                case 14: return KEY_F4;
+                case 15: return KEY_F5;
+                case 17: return KEY_F6;
+                case 18: return KEY_F7;
+                case 19: return KEY_F8;
+                case 20: return KEY_F9;
+                case 21: return KEY_F10;
+                case 23: return KEY_F11;
+                case 24: return KEY_F12;
+            }
+    }
+    return 0;
+}
+
+static void term_read(int deliver)
+{
+    unsigned char buf[64];
+    int n, i, j, num, semi, c;
+
+    while ((n = read(term_fd, buf, sizeof(buf))) > 0)
+    {
+        if (!deliver)
+            continue;
+        for (i = 0; i < n; i++)
+        {
+            c = buf[i];
+            if (c == 0x1b)
+            {
+                if (i + 2 < n && (buf[i + 1] == '[' || buf[i + 1] == 'O'))
+                {
+                    /* The first parameter counts ("15;2~" is F5). */
+                    num = 0;
+                    semi = 0;
+                    for (j = i + 2; j < n - 1 && (isdigit(buf[j]) || buf[j] == ';'); j++)
+                    {
+                        if (buf[j] == ';')
+                            semi = 1;
+                        else if (!semi)
+                            num = num * 10 + (buf[j] - '0');
+                    }
+                    term_key(term_escape(buf[j], num), 0);
+                    i = j;
+                }
+                else
+                {
+                    term_key(KEY_ESCAPE, KEY_ESCAPE);
+                }
+            }
+            else if (c == '\\r' || c == '\\n')
+                term_key(KEY_ENTER, KEY_ENTER);
+            else if (c == '\\t')
+                term_key(KEY_TAB, KEY_TAB);
+            else if (c == 0x7f || c == 0x08)
+                term_key(KEY_BACKSPACE, KEY_BACKSPACE);
+            else if (c == ' ')
+                term_key(KEY_USE, ' ');
+            else if (c == 'f')
+                term_key(KEY_FIRE, c);
+            else if (c == ',')
+                term_key(KEY_STRAFE_L, c);
+            else if (c == '.')
+                term_key(KEY_STRAFE_R, c);
+            else if (c > ' ' && c < 0x7f)
+                term_key(tolower(c), c);
+        }
+    }
+}
+
+static void term_release(void)
+{
+    int now = I_GetTimeMS();
+    int key;
+
+    for (key = 0; key < 256; key++)
+    {
+        if (term_down_until[key] && now - term_down_until[key] >= 0)
+        {
+            term_down_until[key] = 0;
+            post_key(0, key, 0);
+        }
+    }
+}
+
+static void evdev_open(void)
+{
+    DIR *dir = opendir("/dev/input");
+    struct dirent *de;
+    unsigned long keys[KEY_MAX / (8 * sizeof(long)) + 1];
+    char path[300];
+    int fd;
+
+    if (!dir)
+        return;
+    while ((de = readdir(dir)) != NULL && evdev_count < MAX_EVDEV)
+    {
+        if (strncmp(de->d_name, "event", 5) != 0)
+            continue;
+        snprintf(path, sizeof(path), "/dev/input/%s", de->d_name);
+        fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
+        if (fd < 0)
+            continue;
+        memset(keys, 0, sizeof(keys));
+        if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keys)), keys) >= 0
+         && (keys[KEY_A / (8 * sizeof(long))] >> (KEY_A % (8 * sizeof(long)))) & 1)
+        {
+            printf("I_InitInput: keyboard %s\\n", path);
+            evdev_fds[evdev_count++] = fd;
+        }
+        else
+        {
+            close(fd);
+        }
+    }
+    closedir(dir);
+}
+
+static void evdev_read(void)
+{
+    struct input_event ev;
+    int i, key;
+
+    for (i = 0; i < evdev_count; i++)
+    {
+        while (read(evdev_fds[i], &ev, sizeof(ev)) == sizeof(ev))
+        {
+            if (ev.type != EV_KEY || ev.value == 2)
+                continue;
+            evdev_seen = 1;
+            if (ev.code >= sizeof(at_to_doom))
+                continue;
+            if (ev.code == 0x2a || ev.code == 0x36)
+                shiftdown = ev.value ? 1 : 0;
+            key = TranslateKey(ev.code);
+            post_key(ev.value, key, ev.value ? GetTypedChar(ev.code) : 0);
+        }
+    }
+}
+
+void I_GetEvent(void)
+{
+    if (input_mode == INPUT_VT)
+    {
+        vt_get_event();
+        return;
+    }
+    if (evdev_count)
+        evdev_read();
+    if (term_fd >= 0)
+    {
+        term_read(!evdev_seen);
+        term_release();
+    }
+}
+
 void I_InitInput(void)
 {
-    kbd_init();
+    if (!M_CheckParm("-ttyinput"))
+    {
+        if (kbd_init() == 0)
+        {
+            input_mode = INPUT_VT;
+            return;
+        }
+        evdev_open();
+    }
+    term_init();
+    if (evdev_count)
+        input_mode = INPUT_EVDEV;
+    if (term_fd >= 0)
+        printf("I_InitInput: reading keys from the terminal "
+               "(arrows move, f fires, space opens, , and . strafe)\\n");
+    else if (!evdev_count)
+        printf("I_InitInput: no keyboard\\n");
 
     //UpdateFocus();
 }
diff --git a/fbdoom/i_video_fbdev.c b/fbdoom/i_video_fbdev.c
index df62519..8353101 100644
--- a/fbdoom/i_video_fbdev.c
+++ b/fbdoom/i_video_fbdev.c
@@ -262,7 +262,11 @@ void I_StartFrame (void)
 
 }
 
-__attribute__ ((weak)) void I_GetEvent (void)
+/* I_GetEvent is i_input_tty.c's. As a weak stub, this one won the link with
+   tcc 0.9.27 (Debian's), which keeps the first definition: no input. */
+void I_GetEvent (void);
+
+static void unused_get_event (void)
 {
 //	event_t event;
 //	bool button_state;
`,
	"0004-Exit-on-I_Error-instead-of-spinning-forever.patch": `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Pooya Parsa <pooya@pi0.io>
Date: Sat, 14 Nov 2026 01:07:50 +0000
Subject: [PATCH 4/6] Exit on I_Error instead of spinning forever

---
 fbdoom/i_system.c | 4 +---
 1 file changed, 1 insertion(+), 3 deletions(-)

diff --git a/fbdoom/i_system.c b/fbdoom/i_system.c
index 5d00091..978117c 100644
--- a/fbdoom/i_system.c
+++ b/fbdoom/i_system.c
@@ -460,9 +460,7 @@ void I_Error (char *error, ...)
 
     exit(-1);
 #else
-    while (true)
-    {
-    }
+    exit(-1);
 #endif
 }
 
`,
	"0005-Sound-effects-through-OSS-dev-dsp-mixed-in-software.patch": `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Pooya Parsa <pooya@pi0.io>
Date: Sat, 14 Nov 2026 08:08:01 +0000
Subject: [PATCH 5/6] Sound effects through OSS /dev/dsp, mixed in software

---
 fbdoom/i_sound.c     |   2 +
 fbdoom/i_sound_oss.c | 282 +++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 284 insertions(+)
 create mode 100644 fbdoom/i_sound_oss.c

diff --git a/fbdoom/i_sound.c b/fbdoom/i_sound.c
index 71947d2..6673bb4 100644
--- a/fbdoom/i_sound.c
+++ b/fbdoom/i_sound.c
@@ -64,6 +64,7 @@ int snd_sfxdevice = SNDDEVICE_SB;
 
 extern void I_InitTimidityConfig(void);
 extern sound_module_t sound_sdl_module;
+extern sound_module_t sound_oss_module;
 extern sound_module_t sound_pcsound_module;
 extern music_module_t music_sdl_module;
 extern music_module_t music_opl_module;
@@ -91,6 +92,7 @@ static int snd_mport = 0;
 
 static sound_module_t *sound_modules[] = 
 {
+    &sound_oss_module,
 #ifdef FEATURE_SOUND
     &sound_sdl_module,
     &sound_pcsound_module,
diff --git a/fbdoom/i_sound_oss.c b/fbdoom/i_sound_oss.c
new file mode 100644
index 0000000..5515913
--- /dev/null
+++ b/fbdoom/i_sound_oss.c
@@ -0,0 +1,282 @@
+//
+// Copyright(C) 2026 Pooya Parsa
+//
+// This program is free software; you can redistribute it and/or
+// modify it under the terms of the GNU General Public License
+// as published by the Free Software Foundation; either version 2
+// of the License, or (at your option) any later version.
+//
+// This program is distributed in the hope that it will be useful,
+// but WITHOUT ANY WARRANTY; without even the implied warranty of
+// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
+// GNU General Public License for more details.
+//
+// DESCRIPTION:
+//	Sound effects through OSS (/dev/dsp), mixed in software.
+//
+//	The WAD's sound effects (DMX format: 8-bit unsigned mono, usually
+//	11025 Hz) are mixed into 16-bit stereo at MIX_RATE, with each
+//	channel's volume and separation, and written from I_UpdateSound
+//	(once per frame) to keep about TARGET_MS of audio queued. The device
+//	is non-blocking and only as much as fits is written, so a stalled
+//	device never stalls the game. Without a device (or with -nosound)
+//	the game runs silently. No music.
+//
+
+#include <errno.h>
+#include <fcntl.h>
+#include <stdio.h>
+#include <stdlib.h>
+#include <string.h>
+#include <sys/ioctl.h>
+#include <unistd.h>
+#include <linux/soundcard.h>
+
+#include "deh_str.h"
+#include "doomtype.h"
+#include "i_sound.h"
+#include "m_misc.h"
+#include "w_wad.h"
+#include "z_zone.h"
+
+#define NUM_CHANNELS 16
+#define MIX_RATE 22050
+#define TARGET_MS 90
+#define MAX_FRAMES 4096
+
+typedef struct
+{
+    const byte *data;   // unsigned 8-bit samples
+    unsigned int length;   // in samples
+    unsigned int pos;      // 16.16 fixed point
+    unsigned int step;     // 16.16 fixed point
+    int left, right;       // 0..255
+} channel_t;
+
+static channel_t channels[NUM_CHANNELS];
+static int dsp = -1;
+static int queued_max;     // bytes we aim to keep queued
+static int out_rate = MIX_RATE;
+static boolean use_sfx_prefix;
+static int16_t mixbuf[MAX_FRAMES * 2];
+
+static snddevice_t sound_oss_devices[] =
+{
+    SNDDEVICE_SB,
+    SNDDEVICE_PAS,
+    SNDDEVICE_GUS,
+    SNDDEVICE_WAVEBLASTER,
+    SNDDEVICE_SOUNDCANVAS,
+    SNDDEVICE_AWE32,
+};
+
+static boolean I_OSS_InitSound(boolean _use_sfx_prefix)
+{
+    int fmt = AFMT_S16_LE, ch = 2, rate = MIX_RATE;
+    int frag = (32 << 16) | 10;   // up to 32 fragments of 1 KiB
+
+    use_sfx_prefix = _use_sfx_prefix;
+    memset(channels, 0, sizeof(channels));
+
+    dsp = open("/dev/dsp", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
+    if (dsp < 0)
+    {
+        printf("I_OSS_InitSound: no /dev/dsp (%s), no sound\\n", strerror(errno));
+        return false;
+    }
+    ioctl(dsp, SNDCTL_DSP_SETFRAGMENT, &frag);
+    if (ioctl(dsp, SNDCTL_DSP_SETFMT, &fmt) < 0 || fmt != AFMT_S16_LE
+     || ioctl(dsp, SNDCTL_DSP_CHANNELS, &ch) < 0 || ch != 2
+     || ioctl(dsp, SNDCTL_DSP_SPEED, &rate) < 0 || rate < 8000)
+    {
+        printf("I_OSS_InitSound: /dev/dsp refuses 16-bit stereo, no sound\\n");
+        close(dsp);
+        dsp = -1;
+        return false;
+    }
+    out_rate = rate;
+    queued_max = rate * 4 * TARGET_MS / 1000;
+    printf("I_OSS_InitSound: /dev/dsp, %d Hz, 16-bit stereo\\n", rate);
+    return true;
+}
+
+static void I_OSS_ShutdownSound(void)
+{
+    if (dsp >= 0)
+    {
+        close(dsp);
+        dsp = -1;
+    }
+}
+
+static int I_OSS_GetSfxLumpNum(sfxinfo_t *sfx)
+{
+    char namebuf[9];
+
+    if (sfx->link != NULL)
+    {
+        sfx = sfx->link;
+    }
+    if (use_sfx_prefix)
+    {
+        M_snprintf(namebuf, sizeof(namebuf), "ds%s", DEH_String(sfx->name));
+    }
+    else
+    {
+        M_StringCopy(namebuf, DEH_String(sfx->name), sizeof(namebuf));
+    }
+    return W_GetNumForName(namebuf);
+}
+
+static void I_OSS_UpdateSoundParams(int handle, int vol, int sep)
+{
+    int left, right;
+
+    if (dsp < 0 || handle < 0 || handle >= NUM_CHANNELS)
+    {
+        return;
+    }
+    left = ((254 - sep) * vol) / 127;
+    right = (sep * vol) / 127;
+    channels[handle].left = left < 0 ? 0 : left > 255 ? 255 : left;
+    channels[handle].right = right < 0 ? 0 : right > 255 ? 255 : right;
+}
+
+static int I_OSS_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep)
+{
+    const byte *lump;
+    unsigned int lumplen, rate, length;
+    channel_t *c;
+
+    if (dsp < 0 || channel < 0 || channel >= NUM_CHANNELS)
+    {
+        return -1;
+    }
+    c = &channels[channel];
+    c->data = NULL;
+    if (sfxinfo->lumpnum < 0)
+    {
+        sfxinfo->lumpnum = I_OSS_GetSfxLumpNum(sfxinfo);
+    }
+    lump = W_CacheLumpNum(sfxinfo->lumpnum, PU_STATIC);
+    lumplen = W_LumpLength(sfxinfo->lumpnum);
+
+    // DMX header: format 3, rate, sample count (with 16 bytes of padding
+    // at each end, which are skipped).
+    if (lumplen < 8 || lump[0] != 0x03 || lump[1] != 0x00)
+    {
+        return -1;
+    }
+    rate = lump[2] | (lump[3] << 8);
+    length = lump[4] | (lump[5] << 8) | (lump[6] << 16) | ((unsigned int) lump[7] << 24);
+    if (length > lumplen - 8 || length <= 48 || rate == 0)
+    {
+        return -1;
+    }
+    c->length = length - 32;
+    c->pos = 0;
+    c->step = (unsigned int) (((unsigned long long) rate << 16) / out_rate);
+    c->data = lump + 8 + 16;
+    I_OSS_UpdateSoundParams(channel, vol, sep);
+    return channel;
+}
+
+static void I_OSS_StopSound(int handle)
+{
+    if (handle >= 0 && handle < NUM_CHANNELS)
+    {
+        channels[handle].data = NULL;
+    }
+}
+
+static boolean I_OSS_SoundIsPlaying(int handle)
+{
+    return handle >= 0 && handle < NUM_CHANNELS && channels[handle].data != NULL;
+}
+
+static void Mix(int frames)
+{
+    int i, f;
+
+    memset(mixbuf, 0, frames * 4);
+    for (i = 0; i < NUM_CHANNELS; ++i)
+    {
+        channel_t *c = &channels[i];
+        int16_t *out = mixbuf;
+
+        if (c->data == NULL)
+        {
+            continue;
+        }
+        for (f = 0; f < frames; ++f)
+        {
+            unsigned int idx = c->pos >> 16;
+            int s, l, r;
+
+            if (idx >= c->length)
+            {
+                c->data = NULL;
+                break;
+            }
+            s = (int) c->data[idx] - 128;
+            l = out[0] + s * c->left;
+            r = out[1] + s * c->right;
+            out[0] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
+            out[1] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
+            out += 2;
+            c->pos += c->step;
+        }
+    }
+}
+
+static void I_OSS_UpdateSound(void)
+{
+    audio_buf_info info;
+    int queued, frames, n;
+
+    if (dsp < 0)
+    {
+        return;
+    }
+    if (ioctl(dsp, SNDCTL_DSP_GETOSPACE, &info) < 0)
+    {
+        return;
+    }
+    queued = info.fragstotal * info.fragsize - info.bytes;
+    frames = (queued_max - queued) / 4;
+    if (frames > info.bytes / 4)
+    {
+        frames = info.bytes / 4;
+    }
+    if (frames > MAX_FRAMES)
+    {
+        frames = MAX_FRAMES;
+    }
+    if (frames <= 0)
+    {
+        return;
+    }
+    Mix(frames);
+    n = write(dsp, mixbuf, frames * 4);
+    (void) n;   // EAGAIN or a short write: the rest is dropped
+}
+
+static void I_OSS_CacheSounds(sfxinfo_t *sounds, int num_sounds)
+{
+    // Loaded on first use.
+}
+
+sound_module_t sound_oss_module =
+{
+    sound_oss_devices,
+    arrlen(sound_oss_devices),
+    I_OSS_InitSound,
+    I_OSS_ShutdownSound,
+    I_OSS_GetSfxLumpNum,
+    I_OSS_UpdateSound,
+    I_OSS_UpdateSoundParams,
+    I_OSS_StartSound,
+    I_OSS_StopSound,
+    I_OSS_SoundIsPlaying,
+    I_OSS_CacheSounds,
+};
`,
	"0006-fbdev-ask-for-a-640x480-mode-fbmode-WxH.patch": `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Pooya Parsa <pooya@pi0.io>
Date: Sat, 14 Nov 2026 08:08:01 +0000
Subject: [PATCH 6/6] fbdev: ask for a 640x480 mode (-fbmode WxH)

---
 fbdoom/i_video_fbdev.c | 37 +++++++++++++++++++++++++++++++++++--
 1 file changed, 35 insertions(+), 2 deletions(-)

diff --git a/fbdoom/i_video_fbdev.c b/fbdoom/i_video_fbdev.c
index 8353101..c8b4e94 100644
--- a/fbdoom/i_video_fbdev.c
+++ b/fbdoom/i_video_fbdev.c
@@ -37,7 +37,9 @@ rcsid[] = "$Id: i_x.c,v 1.6 1997/02/03 22:45:10 b1 Exp $";
 #include "doomkeys.h"
 
 #include <stdbool.h>
+#include <errno.h>
 #include <stdint.h>
+#include <stdio.h>
 #include <stdlib.h>
 #include <string.h>
 #include <unistd.h>
@@ -187,8 +189,39 @@ void I_InitGraphics (void)
 
     /* fetch framebuffer info */
     ioctl(fd_fb, FBIOGET_VSCREENINFO, &fb);
-    /* change params if needed */
-    //ioctl(fd_fb, FBIOPUT_VSCREENINFO, &fb);
+
+    /*
+     * Ask for our own mode, 640x480 by default (-fbmode WxH, or
+     * -fbmode 0 to keep the current one): a display that scales the mode
+     * to its window then shows the whole picture as large as it fits. If
+     * the driver refuses (EBUSY, no mode setting, another size), the
+     * picture is drawn centred in whatever mode there is.
+     */
+    {
+        int w = 640, h = 480;
+
+        i = M_CheckParmWithArgs("-fbmode", 1);
+        if (i > 0 && sscanf(myargv[i + 1], "%dx%d", &w, &h) != 2)
+        {
+            w = h = 0;
+        }
+        if (w > 0 && h > 0 && (fb.xres != w || fb.yres != h))
+        {
+            struct fb_var_screeninfo want = fb;
+
+            want.xres = want.xres_virtual = w;
+            want.yres = want.yres_virtual = h;
+            want.xoffset = want.yoffset = 0;
+            want.bits_per_pixel = 32;
+            want.activate = FB_ACTIVATE_NOW;
+            if (ioctl(fd_fb, FBIOPUT_VSCREENINFO, &want) != 0)
+            {
+                printf("I_InitGraphics: cannot set %dx%d (%s), keeping %dx%d\\n",
+                       w, h, strerror(errno), fb.xres, fb.yres);
+            }
+            ioctl(fd_fb, FBIOGET_VSCREENINFO, &fb);
+        }
+    }
     printf("I_InitGraphics: framebuffer: x_res: %d, y_res: %d, x_virtual: %d, y_virtual: %d, bpp: %d, grayscale: %d\\n",
             fb.xres, fb.yres, fb.xres_virtual, fb.yres_virtual, fb.bits_per_pixel, fb.grayscale);
 
`,
};

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
	id: "doom",
	title: "Doom",
	desc: "fbDOOM with Freedoom on the framebuffer; the first run builds it in the guest (under a minute)",
	// A horned skull (not id Software's logo).
	icon: { svg: '<path fill-rule="evenodd" d="M12 3.5c5 0 8.5 3.4 8.5 7.9 0 2.5-1 4.3-2.8 5.4v1.7H6.3v-1.7c-1.8-1.1-2.8-2.9-2.8-5.4C3.5 6.9 7 3.5 12 3.5ZM5.6 10.4l5 1.4-.4 2.2c-.2 1.1-1.2 1.9-2.4 1.9-1.4 0-2.4-1.1-2.4-2.5Zm12.8 0-5 1.4.4 2.2c.2 1.1 1.2 1.9 2.4 1.9 1.4 0 2.4-1.1 2.4-2.5ZM12 14.8l-1.3 2.3h2.6Z"/><path d="M6.6 19.2h3v3H7.6a1 1 0 0 1-1-1Zm3.9 0h3v3h-3Zm3.9 0h3v2a1 1 0 0 1-1 1h-2ZM5.4 6.6C3.6 5.2 3 3.3 3.4 1.2 4.6 2.9 6 3.8 7.8 4.3Zm13.2 0c1.8-1.4 2.4-3.3 2-5.4-1.2 1.7-2.6 2.6-4.4 3.1Z"/>' },
	colors: ["#dc2626", "#451a03"],
	needs: { display: true, net: true },
	files: {
		"/usr/local/bin/fbdoom": { content: FBDOOM_SH, mode: 0o755 },
		...Object.fromEntries(Object.entries(PATCHES).map(([name, text]): [string, DemoFile] =>
			[`/usr/share/unkernel/fbdoom/${name}`, { content: text }])),
		"README": README,
	},
	commands: ["cat README", "fbdoom"],
} satisfies Demo;
