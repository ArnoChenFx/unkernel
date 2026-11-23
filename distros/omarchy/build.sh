#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# The Omarchy distro image: vendor/build/distro/omarchy.erofs (guest/lib/image.sh),
# a Debian 13 arm64 root with a keyboard-driven desktop: niri, a scrolling Wayland
# compositor drawn on the display's DRM device (niri-session: virgl when the
# display has it, kms_swrast otherwise), with a top bar (waybar), the wallpaper
# (swaybg), foot, fuzzel, mako and swaylock, and the terminal tools (bash with
# starship, fzf, zoxide, ripgrep, fd, bat, eza, neovim, tmux, lazygit, btop, git),
# themed Tokyo Night throughout. README.md describes the desktop and its keys.
#
# The root is the Debian image's (guest/distro/debian/pins.sh: the trixie-slim
# arm64 root, the package lists of its snapshot date, the wland relay), with the
# kw layer's Debian files (guest/distro/debian/rootfs: PID 1, the sysv-rc services,
# apt and sudo setup, the command-not-found hook, the docker shim) installed as
# they are, the packages of pins.sh installed in the image's own apt the way the
# Debian image does it (guest/distro/debian/build.sh), and this distro's own files
# over them (rootfs/). boot-files and warm-files here are this distro's records.
#
#   distros/omarchy/build.sh          vendor/build/distro/omarchy.erofs and omarchy.id.
#                                     Needs kernel/build.sh base (the bundle that the
#                                     apt steps boot) and node.
#   KW_DISTRO_OUT=DIR                 the image and its staging tree in DIR
#   KW_DISTRO_TRACE=1                 record boot-files and warm-files again (after a
#                                     change to what a boot or the first commands read)
#   KW_WLANDR=FILE                    a local wlandr for development (refused with KW_RELEASE=1)
#   KW_RELEASE=1                      a release build: the pinned wland relay only
#   KW_OMARCHY_APT_CACHE=0            no apt cache in the image (no boot at build time)
#   KW_NIRI_BIN=FILE                  niri built elsewhere (default vendor/build/niri-arm64/niri,
#                                     which build-niri.sh builds when it is missing)
#
# distros.json next to the image: guest/build.sh index (with KW_DISTRO_OUT set to
# this directory). The release workflow (.github/workflows/omarchy-image.yml) runs
# this script and publishes the result. Packages: pins.sh; the image's own files:
# rootfs/, the kw layer's Debian files: guest/distro/debian/rootfs/.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../guest/lib/env.sh"   # root, build, guest, dl, base_bundle, fetch_verified, cc_guest
. "$guest/lib/stage.sh"            # distro_unpack, install_tree, install_common, install_user
export KW_DISTRO_FORMATS="${KW_DISTRO_FORMATS:-erofs}"
. "$guest/lib/image.sh"            # distro_images, distro_out, KW_WARM_*
. "$here/pins.sh"                  # DEBIAN_*, WLANDR_*, OMARCHY_PACKAGES
umask 022
export KW_DISTRO_DIR="$here"
name=omarchy
pkgs="${OMARCHY_PACKAGES[*]}"
debian="$guest/distro/debian"
niri="${KW_NIRI_BIN:-$root/vendor/build/niri-arm64/niri}"
[ -n "${KW_NIRI_BIN:-}" ] || [ -x "$niri" ] || "$here/build-niri.sh"
[ -x "$niri" ] || { echo "omarchy: no niri at $niri (build-niri.sh builds it)" >&2; exit 1; }

distro_unpack "$name" DEBIAN   # $stage, $DEBIAN_TARBALL

# debconf asks nothing, for every program (DEBIAN_FRONTEND too: the kw shells
# start programs without one). Set in its database, as the Debian image does.
sed -i '/^Name: debconf\/frontend$/,/^$/ s/^Value: .*/Value: Noninteractive/' "$stage/var/cache/debconf/config.dat"
grep -q '^Value: Noninteractive$' "$stage/var/cache/debconf/config.dat" ||
	{ echo "omarchy: could not set debconf/frontend" >&2; exit 1; }

# --- apt: package lists and source cache -----------------------------------------
# The docker-clean edit and the lists are the Debian image's (its build.sh has
# the reasons): the source cache stays on and the image comes with it.
python3 -I - "$stage/etc/apt/apt.conf.d/docker-clean" <<'EOF'
import sys
f = sys.argv[1]
bins = " /var/cache/apt/*.bin"
hooks = [f'{k} {{ "rm -f /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial/*.deb{bins} || true"; }};'
         for k in ("DPkg::Post-Invoke", "APT::Update::Post-Invoke")]
off = ['Dir::Cache::pkgcache "";', 'Dir::Cache::srcpkgcache "";']
lines = open(f).read().split("\n")
for l in hooks + off:
    if lines.count(l) != 1:
        sys.exit(f"omarchy: {f}: expected the line {l!r} once (upstream changed it?)")
out = []
for l in lines:
    if l in hooks:
        out.append(l.replace(bins, ""))
    elif l == off[1]:
        out.append("# unkernel: the source cache stays on and")
        out.append("# the image comes with it.")
    else:
        out.append(l)
text = "\n".join(out)
if ".bin" in text or "srcpkgcache" in text or text.count("Dir::Cache") != 1:
    sys.exit(f"omarchy: {f}: the edit went wrong")
open(f, "w").write(text)
EOF

grep -qxF "# http://snapshot.debian.org/archive/debian/$DEBIAN_LISTS_SNAPSHOT" "$stage/etc/apt/sources.list.d/debian.sources" &&
	grep -qxF "# http://snapshot.debian.org/archive/debian-security/$DEBIAN_LISTS_SNAPSHOT" "$stage/etc/apt/sources.list.d/debian.sources" ||
	{ echo "omarchy: debian.sources does not name the snapshot $DEBIAN_LISTS_SNAPSHOT (DEBIAN_LISTS_SNAPSHOT in guest/distro/debian/pins.sh)" >&2; exit 1; }
lz4=$("$debian/tools/apt-lz4.sh")
lists="$stage/var/lib/apt/lists"
keyring="$stage/usr/share/keyrings/debian-archive-keyring.pgp"
command -v gpgv >/dev/null || echo "omarchy: no gpgv on this host: the InRelease files are checked by their pinned SHA-256 only" >&2
while read -r archive suite path sum mtime; do
	[ -n "$archive" ] || continue
	file="$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/$archive/$suite/$path"
	fetch_verified "https://snapshot.debian.org/archive/$archive/$DEBIAN_LISTS_SNAPSHOT/dists/$suite/$path" "$file" "$sum"
	name_l="deb.debian.org_${archive}_dists_${suite}_${path//\//_}"
	case $path in
	InRelease)
		if command -v gpgv >/dev/null; then
			gpgv --keyring "$keyring" "$file" 2>/dev/null ||
				{ echo "omarchy: $file: no good signature by $keyring" >&2; exit 1; }
		fi
		cp "$file" "$lists/$name_l"
		release="$lists/$name_l"
		;;
	*.xz)
		read -r want size < <(awk -v p="${path%.xz}" '/^[^ ]/ { s = ($1 == "SHA256:") } s && $3 == p { print $1, $2 }' "$release")
		xz -dc "$file" > "$file.plain"
		[ "$(sha256sum < "$file.plain" | cut -d' ' -f1)" = "${want:-}" ] && [ "$(stat -c %s "$file.plain")" = "${size:-}" ] ||
			{ echo "omarchy: $file does not match ${path%.xz} in $release" >&2; exit 1; }
		name_l="${name_l%.xz}.lz4"
		"$lz4" < "$file.plain" > "$lists/$name_l"
		rm -f "$file.plain"
		;;
	*) echo "omarchy: DEBIAN_LISTS: $path: InRelease or *.xz only" >&2; exit 1 ;;
	esac
	touch -d "@$mtime" "$lists/$name_l"
done <<< "$DEBIAN_LISTS"

# --- command not found: the command -> package map ----------------------------
contents=()
while read -r path sum; do
	[ -n "$path" ] || continue
	file="$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/debian/trixie/$path"
	fetch_verified "https://snapshot.debian.org/archive/debian/$DEBIAN_LISTS_SNAPSHOT/dists/trixie/$path" "$file" "$sum"
	contents+=("$file")
done <<< "$DEBIAN_CONTENTS"
python3 -I "$debian/tools/commands.py" \
	<(xz -dc "$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/debian/trixie/main/binary-arm64/Packages.xz") \
	"${contents[@]}" > "$stage/usr/lib/kw-commands"
grep -qx 'rg ripgrep' "$stage/usr/lib/kw-commands" ||
	{ echo "omarchy: /usr/lib/kw-commands has no rg -> ripgrep" >&2; exit 1; }

# --- boot ---------------------------------------------------------------------
echo unkernel > "$stage/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tunkernel\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$stage/etc/hosts"
[ -L "$stage/sbin" ] && [ ! -e "$stage/usr/sbin/init" ] && [ ! -L "$stage/usr/sbin/init" ] ||
	{ echo "omarchy: expected /sbin -> usr/sbin and no /usr/sbin/init" >&2; exit 1; }

# The kw layer's Debian files as the Debian image has them (PID 1, services,
# apt and sudo setup, the command-not-found hook, the docker shim), then this
# distro's own, which replace any of them.
install_tree "$debian/rootfs" "$stage"
install_tree "$here/rootfs" "$stage"
# niri (build-niri.sh) and the wallpaper (wallpaper.py draws it, so the repository
# carries no image).
install -D -m 755 "$niri" "$stage/usr/bin/niri"
install -d -m 755 "$stage/usr/share/backgrounds/omarchy"
python3 -I "$here/wallpaper.py" "$stage/usr/share/backgrounds/omarchy/tokyo-night.png"
chmod 440 "$stage/etc/sudoers.d/kw-user"
install_common "$stage"

# wland's relay (guest/distro/debian/pins.sh): the kw layer's bin/wland starts it
# for Wayland windows in the page. KW_WLANDR: a local build, for development.
mkdir -p "$stage/usr/lib/kw"
if [ -n "${KW_WLANDR:-}" ]; then
	[ "${KW_RELEASE:-}" != 1 ] || { echo "KW_WLANDR is for development: a release carries the pinned relay (pins.sh)" >&2; exit 1; }
	[ -f "$KW_WLANDR" ] || { echo "KW_WLANDR=$KW_WLANDR: no such file" >&2; exit 1; }
	echo "omarchy: wlandr from KW_WLANDR=$KW_WLANDR (not the pinned $WLANDR_VERSION)" >&2
	cp "$KW_WLANDR" "$stage/usr/lib/kw/wlandr"
else
	fetch_verified "$WLANDR_URL" "$dl/$WLANDR_TARBALL" "$WLANDR_SHA256"
	tar -xzf "$dl/$WLANDR_TARBALL" -O wlandr > "$stage/usr/lib/kw/wlandr"
fi
chmod 755 "$stage/usr/lib/kw/wlandr"

# --- in the image: apt's source cache, the packages ---------------------------
# Both are made by the image's own programs, as the Debian image makes them: the
# tree so far is a first image (erofs, uncompressed) that boots on the bundle
# (guest/tools/vm-run.ts). 1. srcpkgcache.bin (apt-cache gencaches) and the .deb
# names the packages need (--print-uris). 2. The host fetches those .deb files
# from snapshot.debian.org, checked against the baked lists' SHA-256, into
# /kw-debs; the image's apt installs them with --no-download, and what the install
# changed in the overlay's upper layer (a tmpfs in this boot, guest RAM: --mem)
# comes out as a tar. mktree.py then gives the new files their owners and modes.
mktree_opts=(--keep-mtime var/lib/apt/lists)
kernel="$base_bundle"
gen=omarchy-aptgen
genimage() { (KW_DISTRO_FORMATS=erofs KW_EROFS_COMPRESS=none KW_DISTRO_HINT=0 distro_images "$gen" "$stage" "$DEBIAN_TARBALL" "$name-$DEBIAN_VERSION" "${mktree_opts[@]}") >/dev/null; }
if [ ! -f "$kernel" ] || ! command -v node >/dev/null; then
	echo "omarchy: no $kernel (kernel/build.sh base) or no node: the image has no apt cache and not $pkgs" >&2
	exit 1
fi
script='set -e' gets=()
if [ "${KW_OMARCHY_APT_CACHE:-1}" = 0 ]; then
	echo "omarchy: KW_OMARCHY_APT_CACHE=0: no apt cache in the image" >&2
else
	script+='; apt-cache gencaches; [ ! -e /var/cache/apt/pkgcache.bin ]'
	gets+=(--get /var/cache/apt/srcpkgcache.bin="$distro_out/$gen.srcpkgcache.bin")
fi
script+="; apt-get install -qq --print-uris --no-install-recommends $pkgs > /tmp/kw-uris"
genimage
node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$gen.erofs" --timeout 300 \
	"${gets[@]}" --get /tmp/kw-uris="$distro_out/$gen.uris" "$script" ||
	{ echo "omarchy: apt-cache gencaches or apt-get --print-uris in the image failed" >&2; exit 1; }
if [ "${KW_OMARCHY_APT_CACHE:-1}" != 0 ]; then
	mv "$distro_out/$gen.srcpkgcache.bin" "$stage/var/cache/apt/srcpkgcache.bin"
	chmod 644 "$stage/var/cache/apt/srcpkgcache.bin"
fi

# "ARCHIVE POOL-PATH SHA256" of every package in the baked lists.
sums="$distro_out/$gen.sums"
while read -r archive suite path sum mtime; do
	case $path in *Packages.xz) ;; *) continue ;; esac
	xz -dc "$dl/debian-lists/$DEBIAN_LISTS_SNAPSHOT/$archive/$suite/$path" |
		awk -v a="$archive" '/^Filename: / { f = $2 } /^SHA256: / { s = $2 } /^$/ { if (f != "") print a, f, s; f = "" }'
done <<< "$DEBIAN_LISTS" > "$sums"
archives="$stage/kw-debs"
mkdir "$archives"
n=0
while read -r url debname _; do
	url=${url//\'/}
	rest=${url#http://deb.debian.org/}
	archive=${rest%%/*}
	path=${rest#*/}
	path=${path//%/\\x}; printf -v path '%b' "$path"   # %2b -> +
	sum=$(awk -v a="$archive" -v p="$path" '$1 == a && $2 == p { print $3; exit }' "$sums")
	[ -n "$sum" ] || { echo "omarchy: $url is in none of the baked package lists" >&2; exit 1; }
	file="$dl/debian-pool/$archive/$path"
	fetch_verified "https://snapshot.debian.org/archive/$archive/$DEBIAN_LISTS_SNAPSHOT/$path" "$file" "$sum"
	cp "$file" "$archives/$debname"
	n=$((n + 1))
done < "$distro_out/$gen.uris"
echo "omarchy: installing $n packages in the image (${pkgs// /, })" >&2
genimage
u=/run/kw-lower/kw/tmp/upper
node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$gen.erofs" --mem 3072 --timeout 7200 \
	--get /tmp/kw-pkgs.tar="$distro_out/$gen.pkgs.tar" --get /tmp/kw-gone="$distro_out/$gen.gone" "
	set -e
	[ -d $u ]
	touch /tmp/kw-stamp
	apt-get install -y -q --no-download --no-install-recommends -o Dir::Cache::Archives=/kw-debs/ \
		$pkgs > /tmp/kw-log 2>&1 ||
		{ cat /tmp/kw-log; exit 1; }
	[ \"\$(dpkg-query -W -f '\${db:Status-Abbrev}\n' $pkgs | sort -u)\" = 'ii ' ]
	update-rc.d sudo disable >> /tmp/kw-log 2>&1 || { cat /tmp/kw-log; exit 1; }
	update-rc.d omarchy defaults >> /tmp/kw-log 2>&1 || { cat /tmp/kw-log; exit 1; }
	cd $u
	find . -mindepth 1 -cnewer /tmp/kw-stamp -type c | sort > /tmp/kw-gone
	find . -mindepth 1 -cnewer /tmp/kw-stamp ! -type c ! -path './var/log/*' \\
		! -path ./var/cache/ldconfig/aux-cache ! -path './var/cache/apt/*' ! -path './kw-debs*' | sort > /tmp/kw-list
	tar -cf /tmp/kw-pkgs.tar --no-recursion --numeric-owner -T /tmp/kw-list" ||
	{ echo "omarchy: installing the packages in the image failed" >&2; exit 1; }
rm -rf "$archives"
while read -r p; do rm -rf "${stage:?}/${p#./}"; done < "$distro_out/$gen.gone"
tar -xpf "$distro_out/$gen.pkgs.tar" -C "$stage" --no-same-owner
rm -f "$distro_out/$gen".{erofs,tar,id,uris,sums,pkgs.tar,gone}

# seatd's seat is not bound to a VT: this console has none (hvc0). The package's
# /etc/default/seatd is sourced by its init script, so the variable goes there;
# the file is the package's own (no rootfs copy: dpkg would prompt over it).
grep -qx 'DAEMON_ARGS="-g video"' "$stage/etc/default/seatd" ||
	{ echo "omarchy: /etc/default/seatd is not the seatd package's (upstream changed it?)" >&2; exit 1; }
echo 'export SEATD_VTBOUND=0' >> "$stage/etc/default/seatd"

# Two files the packages write at install time differ from one build to the next,
# and the image does without them: dbus's machine id (random; the omarchy service
# makes one at each boot) and fontconfig's caches (fontconfig makes them on first
# use, in the user's cache directory).
rm -f "$stage/var/lib/dbus/machine-id" "$stage"/var/cache/fontconfig/*

# --- services and policy --------------------------------------------------------
# The image's policy-rc.d (docker's: exit 101) stays for the install above; with it
# gone, an apt-get install starts its service as on a Debian system.
policy="$stage/usr/sbin/policy-rc.d"
[ ! -e "$policy" ] || { grep -qx 'exit 101' "$policy" && rm "$policy"; } ||
	{ echo "omarchy: $policy is not docker's exit 101 (upstream changed it?)" >&2; exit 1; }

# --- the user ---------------------------------------------------------------------
grep -q '^input:' "$stage/etc/group" || {
	! awk -F: '$3 == 101 { f = 1 } END { exit !f }' "$stage/etc/group" ||
		{ echo "omarchy: gid 101 is taken: pick another for the input group" >&2; exit 1; }
	echo "input:x:101:" >> "$stage/etc/group"
	echo "input:!::" >> "$stage/etc/gshadow"
}
printf '\n%s\n%s\n' '# unkernel: the kw profile files in interactive shells that are not login shells too' \
	'[ -r /usr/lib/kw/shrc ] && . /usr/lib/kw/shrc' >> "$stage/etc/bash.bashrc"
if [ -x "$stage/usr/bin/sudo" ]; then
	install_user "$stage" /bin/bash sudo audio video render input users
fi

# The command map without the commands the image has (/usr/local: the kw-init's
# poweroff, halt and reboot).
awk 'NR == FNR { have[$0]; next } !($1 in have)' \
	<(find "$stage/usr/bin" "$stage/usr/sbin" "$stage/usr/local/bin" "$stage/usr/local/sbin" -maxdepth 1 ! -type d -printf '%f\n') \
	"$stage/usr/lib/kw-commands" > "$stage/usr/lib/kw-commands.new"
mv "$stage/usr/lib/kw-commands.new" "$stage/usr/lib/kw-commands"

# The warm set (guest/lib/image.sh): what the first commands read, fetched after
# the boot. The desktop's programs and the terminal tools, the offline apt reads
# and dpkg's unpackers (the Debian image's list, plus this distro's commands).
KW_WARM_SCRIPT='apt-cache show bash >/dev/null; apt-cache policy >/dev/null; apt-get -s install git >/dev/null; dpkg -l >/dev/null; niri --version >/dev/null; waybar --version >/dev/null; foot --version >/dev/null; fuzzel --version >/dev/null; swaylock --version >/dev/null; nvim --version >/dev/null; starship --version >/dev/null; zoxide --version >/dev/null; fzf --version >/dev/null; rg --version >/dev/null; fdfind --version >/dev/null; batcat --version >/dev/null; eza --version >/dev/null; btop --version >/dev/null; lazygit --version >/dev/null; git --version >/dev/null; tmux -V >/dev/null; jq --version >/dev/null; omarchy version >/dev/null'
KW_WARM_EXCLUDE='var/lib/apt/lists/*'
KW_WARM_FILES='usr/lib/apt/methods/http usr/bin/dpkg-deb usr/bin/dpkg-split'
export KW_WARM_SCRIPT KW_WARM_EXCLUDE KW_WARM_FILES
distro_images "$name" "$stage" "$DEBIAN_TARBALL" "$name-$DEBIAN_VERSION" "${mktree_opts[@]}" "${user_owner[@]}"

# apt in the image takes its source cache as it is: a new one would have been
# written to the upper layer, with a new mtime.
if [ -f "$stage/var/cache/apt/srcpkgcache.bin" ]; then
	node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$name.erofs" --timeout 120 \
		'apt-cache policy bash >/dev/null && c=/var/cache/apt/srcpkgcache.bin &&
		[ "$(stat -c %Y $c)" = "$(stat -c %Y /etc/apt/sources.list.d/debian.sources)" ]' ||
		{ echo "omarchy: apt in $name.erofs does not take its srcpkgcache.bin" >&2; exit 1; }
fi

# A boot of the image that runs each program of the desktop once, and the
# omarchy commands, on the bundle the page boots: it fails the build when one
# is missing or cannot start.
node "$guest/tools/vm-run.ts" "$kernel" "$distro_out/$name.erofs" --timeout 300 \
	'set -e
	for c in niri niri-session waybar swaybg foot fuzzel swaylock grim slurp wl-copy wl-paste wlr-randr mako makoctl notify-send lazygit nvim starship zoxide fzf rg fdfind batcat eza btop tmux git jq udevadm omarchy dbus-run-session; do
		command -v "$c" >/dev/null || { echo "omarchy: missing $c" >&2; exit 1; }
	done
	[ -x /usr/sbin/seatd ] || { echo "omarchy: missing seatd" >&2; exit 1; }
	[ -x /usr/lib/systemd/systemd-udevd ] || { echo "omarchy: missing systemd-udevd" >&2; exit 1; }
	grep -qx "export SEATD_VTBOUND=0" /etc/default/seatd || { echo "omarchy: /etc/default/seatd does not unbind the seat" >&2; exit 1; }
	[ -r /usr/share/backgrounds/omarchy/tokyo-night.png ] || { echo "omarchy: no wallpaper" >&2; exit 1; }
	niri validate -c /etc/skel/.config/niri/config.kdl || { echo "omarchy: the niri config does not validate" >&2; exit 1; }
	niri --version; waybar --version; foot --version; fuzzel --version; swaylock --version; lazygit --version; nvim --version | head -1
	starship --version; btop --version; tmux -V; omarchy version' ||
	{ echo "omarchy: the smoke test in $name.erofs failed" >&2; exit 1; }
echo "omarchy: $name.erofs passed the smoke test" >&2
