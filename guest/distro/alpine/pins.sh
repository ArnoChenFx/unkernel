# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the Alpine image (build.sh, opt/build.sh), sourced: the
# aarch64 minirootfs. ALPINE_TARBALL=file overrides the download.
ALPINE_VERSION=3.24.4
ALPINE_TARBALL_NAME="alpine-minirootfs-$ALPINE_VERSION-aarch64.tar.gz"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/aarch64/$ALPINE_TARBALL_NAME"
ALPINE_SHA256=4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de
# The packages the image comes with on top of the minirootfs (build.sh), from
# main: "SHA-256 NAME-VERSION" each. apk installs them without the network,
# so their dependencies must be in the minirootfs or in this list.
# libgcc: the musl Node.js build links libgcc_s (the kw layer's node shim).
ALPINE_MAIN_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/main/aarch64"
ALPINE_PACKAGES="
369aaa6e9d099a737bad6dd3e6c2fe7bb1547ca26d22b94ee0411228f709b403 libgcc-15.2.0-r5
"
