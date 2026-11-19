# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the Alpine image (build.sh), sourced: the aarch64
# minirootfs. ALPINE_TARBALL=file overrides the download.
ALPINE_VERSION=3.24.4
ALPINE_TARBALL_NAME="alpine-minirootfs-$ALPINE_VERSION-aarch64.tar.gz"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/aarch64/$ALPINE_TARBALL_NAME"
ALPINE_SHA256=4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de
