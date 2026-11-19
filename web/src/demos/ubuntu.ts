// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Ubuntu: Ubuntu Base 26.10 arm64 (glibc 2.44, dpkg, apt 3.3, bash, uutils
// coreutils; no init system), fetched at run time from cdimage.ubuntu.com,
// the tarball kernel/build.sh ubuntu builds its disk from (same SHA-256 as
// kernel/tools/env.sh), and run in a chroot on the Alpine guest. Nothing from
// Ubuntu is in the page.
//
// The page fetches the tarball (35 MB; `downloads`, download.ts) and pushes
// it into the demo's directory, unless the tree is there already. ubuntu.sh
// extracts that copy and deletes it; without it (the page's fetch failed)
// it downloads the tarball itself over https. Either way the tarball is
// streamed through sha256sum into tar, and a wrong sum deletes what was
// extracted. The tree (about 110 MB)
// goes to /data/ubuntu with the data disk (kept: later runs start at once),
// else /var/lib/ubuntu, on the root in memory (gone at power off). A tree
// whose bash is not an aarch64 program (one a riscv64 guest extracted, on a
// data disk that the guest's architecture reset adopted) is deleted and
// extracted again, and its download is not skipped. The release directory
// is versioned (releases/26.10/release/), so the URL does not move on.
//
// Each run enters a private mount namespace (unshare -m, all mounts private),
// mounts proc, sysfs, /dev (rbind, so /dev/pts too), tmpfs on /run and
// /tmp, and Alpine's /root on Ubuntu's /root, so both share one home (kept
// with the data disk, under the overlay root, like the tree itself; Ubuntu's
// .bashrc is copied in once, and a ~/.bash_profile that sources it, which
// Alpine's sh never reads), copies Alpine's resolv.conf in, and runs bash -l as root in the
// chroot with a clean environment. The mounts go away with the namespace
// when that shell exits, back to Alpine's shell in the window. apt works
// (its sources are archive.ubuntu.com and security.ubuntu.com over plain
// http); apt-get update reads about 20 MB of indexes.
import type { Demo } from "../launcher.ts";

const VER = "26.10";
const NAME = `ubuntu-base-${VER}-base-arm64.tar.gz`;
const TARBALL_URL = `https://cdimage.ubuntu.com/ubuntu-base/releases/${VER}/release/${NAME}`;
const SHA256 = "8b7ea4ed71a92873f7f4e260a3defe0d9ed85cb69c0155b12414208f79fa0f2d";
const SIZE = 36245313;

// Where ubuntu.sh puts the tree; the download is skipped when it is there
// and its bash is an aarch64 program (ELF e_machine 183: bytes b7 00).
const ROOT_SH = 'if mountpoint -q /data; then R=/data/ubuntu; else R=/var/lib/ubuntu; fi';
const OURS_SH = '[ "$(od -An -tx1 -j18 -N2 "$R/usr/bin/bash" 2>/dev/null | tr -d " \\n")" = b700 ]';

const UBUNTU_SH = String.raw`#!/bin/sh
# Ubuntu Base 26.10 arm64 from cdimage.ubuntu.com, in a chroot on this
# Alpine guest. Written by the unkernel launcher's Ubuntu demo.
set -e
NAME=${NAME}
URL=${TARBALL_URL}
SHA256=${SHA256}
B='\033[1m' D='\033[90m' N='\033[0m'

if mountpoint -q /data; then
	R=/data/ubuntu WHERE="on the data disk, kept across reboots"
else
	R=/var/lib/ubuntu WHERE="in memory, gone at power off (no data disk)"
fi

# A tree of another architecture (a riscv64 guest's): start over.
if [ -e "$R/usr/bin/bash" ] && ! ${OURS_SH}; then
	printf "$D%s$N\n" "$R holds Ubuntu for another architecture: deleting it"
	rm -rf "$R"
fi

if [ ! -x "$R/usr/bin/bash" ]; then
	if [ -f "$NAME" ]; then
		printf "$D%s$N\n" "Extracting $NAME (fetched by the page) into $R"
		fetch() { cat "$NAME"; }
	else
		printf "$D%s$N\n" "Fetching $NAME (35 MB) from cdimage.ubuntu.com into $R"
		fetch() { wget -O - "$URL"; }
	fi
	rm -rf "$R.tmp" sum.fifo sum.txt
	mkdir -p "$R.tmp"
	mkfifo sum.fifo
	sha256sum < sum.fifo > sum.txt &
	sum=$!
	status=0
	fetch | tee sum.fifo | tar -xzf - -C "$R.tmp" || status=$?
	wait $sum || true
	got=$(cut -d' ' -f1 sum.txt 2>/dev/null || true)
	rm -f sum.fifo sum.txt
	if [ $status -ne 0 ] || [ "$got" != "$SHA256" ]; then
		rm -rf "$R.tmp" "$NAME"
		echo "ubuntu.sh: download or extraction failed (sha256 $got, tar exit $status)" >&2
		exit 1
	fi
	# The console starts as "linux"; the page's terminal is xterm-compatible.
	printf '%s\n' 'case $TERM in linux|vt102|"") export TERM=xterm-256color ;; esac' > "$R.tmp/etc/profile.d/kw-term.sh"
	mv "$R.tmp" "$R"
	rm -f "$NAME"
fi

# The guest's DNS server, inside.
if [ -e /etc/resolv.conf ]; then
	rm -f "$R/etc/resolv.conf"
	cp /etc/resolv.conf "$R/etc/resolv.conf"
fi

# Home: Alpine's /root, bind-mounted below. Ubuntu's .bashrc is copied in
# once; bash's login reads ~/.bash_profile, which Alpine's sh never does
# (it reads ~/.profile), so each shell keeps its own setup.
[ -e /root/.bashrc ] || cp "$R/root/.bashrc" /root/.bashrc
[ -e /root/.bash_profile ] || printf '%s\n' "# bash login shells (the Ubuntu demo); Alpine's sh reads ~/.profile instead." \
	'[ -f ~/.bashrc ] && . ~/.bashrc' > /root/.bash_profile

. "$R/etc/os-release"
printf "\n$B%s$N\n" "$PRETTY_NAME (arm64, from cdimage.ubuntu.com) in a chroot on the Alpine guest"
printf "$D%s$N\n" "Root: $R, $WHERE; home: /root, shared with Alpine." \
	"Try: cat /etc/os-release; ldd --version; apt-get update && apt-get install -y htop" \
	"(apt-get update reads about 20 MB of indexes). exit returns to Alpine."

# A private mount namespace: the mounts go away when the shell exits.
exec unshare -m /bin/sh -c '
set -e
R=$1
mount --make-rprivate /
mount -t proc proc "$R/proc"
mount -t sysfs sysfs "$R/sys"
mount -o rbind /dev "$R/dev"
mount -t tmpfs -o mode=755 tmpfs "$R/run"
mount -t tmpfs -o mode=1777 tmpfs "$R/tmp"
mount -o bind /root "$R/root"
exec chroot "$R" /usr/bin/env -i HOME=/root TERM="$TERM" LANG=C.UTF-8 \
	PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	/bin/bash -c "cd /root && exec bash -l"
' sh "$R"
`;

export default {
	id: "ubuntu",
	title: "Ubuntu",
	desc: "Ubuntu 26.10, fetched from cdimage.ubuntu.com and run in a chroot: glibc, bash, dpkg and apt",
	// Crafted: a ring with three dots, after Ubuntu's Circle of Friends.
	icon: { svg: '<circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" stroke-width="2.4"/><g stroke="#c34113" stroke-width="1.6"><circle cx="20.6" cy="12" r="2.6"/><circle cx="7.7" cy="19.45" r="2.6"/><circle cx="7.7" cy="4.55" r="2.6"/></g>' },
	colors: ["#e95420", "#5e2750"],
	needs: { net: true },
	files: { "ubuntu.sh": { content: UBUNTU_SH, mode: 0o755 } },
	downloads: [{ url: TARBALL_URL, sha256: SHA256, size: SIZE, path: NAME, unless: `${ROOT_SH}; ${OURS_SH}` }],
	commands: ["./ubuntu.sh"],
} satisfies Demo;
