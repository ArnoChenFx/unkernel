# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the Alpine image (build.sh), sourced: the aarch64
# minirootfs, and the packages the build adds (ALPINE_APKS: "FILE SHA256"
# per line, from main of the same release: doas, and doas-sudo-shim, its
# `sudo` command). ALPINE_TARBALL=file overrides the download.
ALPINE_VERSION=3.24.4
ALPINE_TARBALL_NAME="alpine-minirootfs-$ALPINE_VERSION-aarch64.tar.gz"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/aarch64/$ALPINE_TARBALL_NAME"
ALPINE_SHA256=4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de
ALPINE_APKS_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/main/aarch64"
ALPINE_APKS="
doas-6.8.2-r8.apk 7d35ce1a0a76de43f7621e2099e45bfd83e6d8cf667db657633ab1f374d05f72
doas-sudo-shim-0.2.0-r0.apk 731e5a2b9e564c66c10fa98f5db2dc8f8c55ae31017ec5068744d31116691822
"
