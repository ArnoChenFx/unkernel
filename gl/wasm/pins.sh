# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Pinned inputs of the wasm build of virglrenderer (build.sh), sourced.
#
# Emscripten is not packaged for the host, and emsdk would download it
# unverified: build.sh fetches the release archive emsdk itself installs
# for this version (the build id is from emsdk's
# emscripten-releases-tags.json) and checks it against this hash.
EMSCRIPTEN_VERSION=6.0.13
EMSCRIPTEN_BUILD=eb132757325583b787fe9414b09afea9442b72ad
EMSCRIPTEN_URL="https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/$EMSCRIPTEN_BUILD/wasm-binaries.tar.xz"
EMSCRIPTEN_SHA256=cda6801012ff3319a539111826ed02a9abd7eff135c2ef261c8941caf5a3763e
# virglrenderer 1.3.0: the tag and the commit it must resolve to; the
# series in gl/patches/virglrenderer/ goes on top (branch kw-wasm).
VIRGLRENDERER_REPO=https://gitlab.freedesktop.org/virgl/virglrenderer.git
VIRGLRENDERER_TAG=1.3.0
VIRGLRENDERER_COMMIT=ca50e008863837e094747a69974dde3ae148aeaa
