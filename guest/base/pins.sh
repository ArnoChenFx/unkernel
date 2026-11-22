# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the base initramfs (build.sh), sourced. Static busybox:
# Alpine's busybox-static package (armv8-a, what kwemu runs), from its own
# Alpine release, independent of the Alpine distro image's.
BUSYBOX_ALPINE=3.24
BUSYBOX_STATIC_APK="busybox-static-1.37.0-r31.apk"
BUSYBOX_STATIC_URL="https://dl-cdn.alpinelinux.org/alpine/v$BUSYBOX_ALPINE/main/aarch64/$BUSYBOX_STATIC_APK"
BUSYBOX_STATIC_SHA256=965777e06b94bf11981d5f4ecdfcd577879f4b0dda544294d1dd3f72b217bc75
# wland's relay (https://github.com/pithings/wland, MPL-2.0 AND MIT): the
# static aarch64 wlandr of a wland release, installed as /usr/lib/kw/wlandr
# (/usr/lib/kw/bin/wland starts it; Wayland apps as windows in the page).
# The asset is the --link-only build (wlandr-link-linux-arm64.tar.gz, entry
# wlandr; no HTTP server). GL apps by GPU resource (--dmabuf virtgpu, which
# bin/wland passes only to a relay that has it) need 0.1.0-261122 or later,
# as does the page (web/package.json; .agents/web.md, Wayland desktop).
# The relay at boot (wland --boot: --link-on-demand, read from wlandr
# --version, as --no-fence-wait is) needs 0.1.0-261122-632f589 or later;
# with an older one the boot starts none and wland CMD works as before.
# Bump together: WLANDR_VERSION, WLANDR_SHA256 and wland's version in
# web/package.json. build.sh takes a local relay from KW_WLANDR instead
# (development).
WLANDR_VERSION=v0.1.0-261122-632f589
WLANDR_TARBALL="wlandr-link-$WLANDR_VERSION-linux-arm64.tar.gz"
WLANDR_URL="https://github.com/pithings/wland/releases/download/$WLANDR_VERSION/wlandr-link-linux-arm64.tar.gz"
WLANDR_SHA256=a7cf0ed1d802eee4a96307ce519250e924766df2c584b9bd788447084de3a526
