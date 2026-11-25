# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of guest VA-API (va/build.sh), sourced. The libva headers the
# driver builds against: the release of Debian trixie's libva2 (2.22.0,
# VA-API 1.22), so the build needs no headers on the host.
LIBVA_VERSION=2.22.0
LIBVA_API_VERSION=1.22.0
LIBVA_URL="https://github.com/intel/libva/archive/refs/tags/$LIBVA_VERSION.tar.gz"
LIBVA_SHA256=467c418c2640a178c6baad5be2e00d569842123763b80507721ab87eb7af8735
