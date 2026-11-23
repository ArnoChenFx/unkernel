#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# niri for the omarchy-niri image: NIRI_TAG, cross-compiled for aarch64 on this
# host as vendor/build/niri-arm64/niri (stripped). The libraries it links are the
# trixie arm64 -dev packages of the pinned package lists (guest/distro/debian/
# pins.sh, checked by SHA-256 from snapshot.debian.org), extracted into
# vendor/build/niri-sysroot; glibc is the host's cross toolchain's (libc6-arm64-cross),
# the one the binary runs on in the image (trixie's, which is newer).
# Needs on the host: gcc-aarch64-linux-gnu, libc6-dev-arm64-cross, rustup (the
# stable toolchain, at least niri's rust-version), python3, xz, dpkg-deb, git,
# and libclang for bindgen (LIBCLANG_PATH, default /usr/lib/llvm-22/lib).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
. "$root/guest/lib/env.sh"            # dl, fetch_verified
. "$root/guest/distro/debian/pins.sh" # DEBIAN_LISTS, DEBIAN_LISTS_SNAPSHOT

NIRI_REPO=https://github.com/niri-wm/niri.git
NIRI_TAG=v26.04
NIRI_COMMIT=8ed0da44d974c32c6877d2f4630c314da0717ecb
DEV_PACKAGES="libcairo2-dev libpango1.0-dev libglib2.0-dev libdisplay-info-dev libgbm-dev libegl-dev libgles-dev libgl-dev libdrm-dev libseat-dev libinput-dev libudev-dev libxkbcommon-dev libpixman-1-dev libfontconfig-dev libfreetype-dev libharfbuzz-dev libgdk-pixbuf-2.0-dev libevdev-dev libmtdev-dev libwayland-dev libxrender-dev libpng-dev"

out="$root/vendor/build/niri-arm64"
sys="$root/vendor/build/niri-sysroot"
src="$root/vendor/build/niri-src"
work="$root/vendor/build/niri-work"
mkdir -p "$out" "$work"

if [ ! -d "$src/.git" ]; then
	git clone --quiet --filter=blob:none "$NIRI_REPO" "$src"
fi
git -C "$src" checkout --quiet --detach "$NIRI_COMMIT" ||
	{ echo "build-niri: $NIRI_REPO has no $NIRI_COMMIT ($NIRI_TAG)" >&2; exit 1; }

# The trixie main Packages of the pinned lists (the line the image's build fetches).
read -r archive suite path sum _ < <(awk '$1 == "debian" && $2 == "trixie" && $3 == "main/binary-arm64/Packages.xz"' <<< "$DEBIAN_LISTS")
lists="$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/$archive/$suite/$path"
fetch_verified "https://snapshot.debian.org/archive/$archive/$DEBIAN_LISTS_SNAPSHOT/dists/$suite/$path" "$lists" "$sum"

python3 "$here/resolve-debs.py" <(xz -dc "$lists") $DEV_PACKAGES > "$work/debs.tsv"
rm -rf "$sys"
mkdir -p "$sys"
while IFS=$'\t' read -r pool deb_sum; do
	deb="$dl/debian-pool/$archive/$pool"
	fetch_verified "https://snapshot.debian.org/archive/$archive/$DEBIAN_LISTS_SNAPSHOT/$pool" "$deb" "$deb_sum"
	dpkg-deb -x "$deb" "$sys"
done < "$work/debs.tsv"

# The runtime libraries the sysroot's linker scripts name by absolute path, from the host's cross glibc.
mkdir -p "$sys/lib/aarch64-linux-gnu"
for f in /usr/aarch64-linux-gnu/lib/*.so.[0-9]* /usr/aarch64-linux-gnu/lib/ld-linux-aarch64.so.1; do
	ln -sfn "$f" "$sys/lib/aarch64-linux-gnu/$(basename "$f")"
done
ln -sfn /usr/aarch64-linux-gnu/lib/ld-linux-aarch64.so.1 "$sys/lib/ld-linux-aarch64.so.1"

cat > "$work/aarch64-link.sh" <<EOF
#!/usr/bin/env bash
exec aarch64-linux-gnu-gcc "\$@" -Wl,--sysroot=$sys -Wl,-rpath-link=$sys/usr/lib/aarch64-linux-gnu -Wl,-rpath-link=/usr/aarch64-linux-gnu/lib
EOF
chmod +x "$work/aarch64-link.sh"

export RUSTUP_TOOLCHAIN=${KW_NIRI_TOOLCHAIN:-stable}
rustup target add aarch64-unknown-linux-gnu >/dev/null
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="$work/aarch64-link.sh"
export PKG_CONFIG_ALLOW_CROSS=1
export PKG_CONFIG_SYSROOT_DIR="$sys"
export PKG_CONFIG_LIBDIR="$sys/usr/lib/aarch64-linux-gnu/pkgconfig:$sys/usr/share/pkgconfig"
export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$sys -I$sys/usr/include -I/usr/aarch64-linux-gnu/include --target=aarch64-linux-gnu"
export LIBCLANG_PATH="${LIBCLANG_PATH:-/usr/lib/llvm-22/lib}"

cd "$src"
cargo build --release --locked -p niri --target aarch64-unknown-linux-gnu --no-default-features --features dbus,systemd
aarch64-linux-gnu-strip -o "$out/niri" "$src/target/aarch64-unknown-linux-gnu/release/niri"
echo "build-niri: $out/niri ($(stat -c %s "$out/niri") bytes)" >&2
