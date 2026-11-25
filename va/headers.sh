# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Sourced after kernel/tools/env.sh (root, vendor, fetch_verified).
# va_headers DIR: the pinned libva headers (va/pins.sh) into DIR/va, with the
# va_version.h meson would generate, downloaded once into vendor/downloads
# ($KW_VA_DOWNLOADS overrides the directory) and checked against their
# SHA-256 sum.
. "$root/va/pins.sh"
va_headers() {
	local dir="$1" dl="${KW_VA_DOWNLOADS:-$vendor/downloads}"
	local tgz="$dl/libva-$LIBVA_VERSION.tar.gz"
	fetch_verified "$LIBVA_URL" "$tgz" "$LIBVA_SHA256"
	mkdir -p "$dir"
	tar -xzf "$tgz" -C "$dir" --strip-components=1 --wildcards "libva-$LIBVA_VERSION/va/*.h" "libva-$LIBVA_VERSION/va/va_version.h.in"
	local maj min mic
	IFS=. read -r maj min mic <<<"$LIBVA_API_VERSION"
	sed -e "s/@VA_API_MAJOR_VERSION@/$maj/; s/@VA_API_MINOR_VERSION@/$min/; s/@VA_API_MICRO_VERSION@/$mic/; s/@VA_API_VERSION@/$LIBVA_API_VERSION/g" \
		"$dir/va/va_version.h.in" >"$dir/va/va_version.h"
}
