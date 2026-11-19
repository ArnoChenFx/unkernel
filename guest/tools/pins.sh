# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the host tools in this directory, sourced: erofs-utils
# for the distro images' mkfs.erofs (erofs-utils.sh), with lz4 (lz4hc) and
# zstd built in from their release sources; lz4 also for apt-lz4
# (distro/debian/tools/apt-lz4.sh). The kernel.org snapshot of the tag
# (GitHub's archive of it is the same file).
EROFS_UTILS_VERSION=1.9.4
EROFS_UTILS_URL="https://git.kernel.org/pub/scm/linux/kernel/git/xiang/erofs-utils.git/snapshot/erofs-utils-$EROFS_UTILS_VERSION.tar.gz"
EROFS_UTILS_SHA256=7d135aa2550326a5acf20f53c518aea5a8900015ce50700044e40f818c31dd80
LZ4_VERSION=1.10.0
LZ4_URL="https://github.com/lz4/lz4/releases/download/v$LZ4_VERSION/lz4-$LZ4_VERSION.tar.gz"
LZ4_SHA256=537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b
ZSTD_VERSION=1.5.7
ZSTD_URL="https://github.com/facebook/zstd/releases/download/v$ZSTD_VERSION/zstd-$ZSTD_VERSION.tar.gz"
ZSTD_SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
