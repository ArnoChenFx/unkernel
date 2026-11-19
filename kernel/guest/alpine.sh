#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Alpine Linux aarch64 minirootfs as an initramfs (dynamic musl userland),
# vendor/build/initramfs/alpine.cpio, the only root fs image.
# /init mounts the pseudo filesystems and hands over to busybox init with a
# login-less shell on hvc0; with a disk labelled kwdata, mounted at /data,
# the root becomes an overlay that keeps every change on it (kw-overlay).
# It also carries the kernel smoke test and benchmark (static, so they work
# as /init too), except with KW_RELEASE=1 (release bundles; see the end of
# this file). vendor/build/initramfs/alpine-test.cpio always has them:
#   rdinit=/usr/bin/kwtest    kernel/guest/kwtest.c, powers off (halts on a failure)
#   rdinit=/usr/bin/kwbench   kernel/guest/kwbench.c, rough guest speed
# Always in the image:
#   /usr/bin/glimmer        kernel/guest/glimmer.c, a small game on /dev/fb0, evdev and
#                             ALSA; glimmer --test draws a check pattern, plays a test
#                             signal and prints input events
#   /usr/bin/kwvsock          kernel/guest/kwvsock.c, a byte pipe over AF_VSOCK (connect or
#                             listen), for the SDK's vsock test
#   /usr/bin/kwshm            kernel/guest/kwshm.c, exports a memfd or a shmem file to the
#                             host through /dev/kwshm, for the SDK's shm test
#   /usr/bin/kwtty            kernel/guest/kwtty.c, terminal sessions for the host over
#                             AF_VSOCK port 1022 (host side js/core/tty.ts), run by inittab
#   /usr/bin/kw9p             kernel/guest/kw9p.c, mounts a 9p file system the host serves
#                             over AF_VSOCK (host side js/core/9p.ts)
set -euo pipefail

. "$(dirname "$0")/../tools/env.sh"   # root, zig, ALPINE_*, fetch_verified, need_zig
need_zig
out="$build/initramfs"
dl="$root/vendor/downloads"
mkdir -p "$out" "$dl"
# Images of the test and busybox root fs variants, which no longer exist.
rm -rf "$out"/{test,busybox}{.cpio,-root} "$build/busybox-riscv64"

# ALPINE_TARBALL=file overrides the pinned release (tools/env.sh).
if [ -z "${ALPINE_TARBALL:-}" ]; then
	ALPINE_TARBALL="$dl/$ALPINE_TARBALL_NAME"
	fetch_verified "$ALPINE_URL" "$ALPINE_TARBALL" "$ALPINE_SHA256"
fi
echo "alpine: $ALPINE_TARBALL"

stage="$out/alpine-root"
rm -rf "$stage"
mkdir -p "$stage"
tar -xzf "$ALPINE_TARBALL" -C "$stage" --no-same-owner --no-same-permissions 2>/dev/null || true
chmod -R u+rwX "$stage"
# --no-same-permissions applies the umask, which turns the tarball's
# drwxrwxrwt into 755: daemons that drop root (mariadbd, postgres) then
# cannot write their temporary files.
chmod 1777 "$stage/tmp" "$stage/var/tmp"
# OpenSSL parts that are of no use here, about 200 KiB of RAM (initramfs
# pages stay resident): the engines are for VIA PadLock, Windows CAPI, the
# kernel's AF_ALG sockets (not built) and old key formats, legacy.so only
# loads on request for MD4, RC4 and the like, and *.dist are copies of the
# configs. apk still lists them in its database (`apk audit` reports them),
# and upgrading libcrypto3 or libssl3 brings them back.
rm -rf "$stage/usr/lib/engines-3" "$stage/usr/lib/ossl-modules/legacy.so" \
	"$stage/etc/ssl/openssl.cnf.dist" "$stage/etc/ssl/ct_log_list.cnf.dist"
# With KW_ALPINE_OPT=1: busybox, zlib, libcrypto, libssl, libapk and apk
# rebuilt for kwemu's CPU (gcc 16 -O2, linked with lld), from the same
# source as these packages; see alpine-opt.sh. Off by default for aarch64
# (Alpine's own builds). alpine-disk.sh does the same.
"$root/kernel/guest/alpine-opt.sh" --install "$stage"
# apk starts with main only. Every apk command that loads the indexes parses
# all of them, and community (21k packages to main's 6k) makes that ~2.7 s
# instead of ~0.65 s under kwemu. Its line moves to /etc/kw-apk-lazy, and
# /etc/kw-apk-enable adds it back the first time something needs it
# (kw-apk-install, kw-qemu). alpine-disk.sh does the same.
r="$stage/etc/apk/repositories"
grep '/community$' "$r" > "$stage/etc/kw-apk-lazy" || { echo "alpine: no community line in $r" >&2; exit 1; }
grep -v '/community$' "$r" > "$r.kw" && mv "$r.kw" "$r"

cat > "$stage/init" <<'EOF'
#!/bin/sh
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sys /sys
/bin/mount -t cgroup2 -o nosuid,nodev,noexec cgroup2 /sys/fs/cgroup
/bin/mount -t devtmpfs dev /dev
/bin/mkdir -p /dev/pts /dev/shm
/bin/mount -t devpts devpts /dev/pts
/bin/mount -t tmpfs tmpfs /dev/shm
/bin/mount -t tmpfs tmpfs /run
/bin/hostname unkernel
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
# /data, and the overlay root on it: after this, / may be the overlay
# (pivot_root), with the mounts above moved along.
/etc/kw-data.sh root
exec /sbin/init
EOF
chmod 755 "$stage/init"

cat > "$stage/etc/inittab" <<'EOF'
# unkernel: a root shell on the console, and kwtty for the host's
# terminal sessions over vsock (it sleeps when there is no vsock device).
::sysinit:/bin/echo "Welcome to $(. /etc/os-release; echo $PRETTY_NAME) on unkernel ($(uname -m))"
::sysinit:/etc/kw-data.sh
::sysinit:/etc/kw-net.sh
::sysinit:/etc/kw-binfmt.sh
hvc0::respawn:-/bin/sh
::respawn:/usr/bin/kwtty serve
::ctrlaltdel:/sbin/reboot
::shutdown:/etc/kw-shutdown
EOF
echo 'hvc0' >> "$stage/etc/securetty"
# Networking: lo, and eth0 by DHCP when the host provides kwnet (js/core/net.ts).
cat > "$stage/etc/kw-net.sh" <<'EOF'
#!/bin/sh
ip link set lo up
[ -e /sys/class/net/eth0 ] || exit 0
ip link set eth0 up
udhcpc -i eth0 -q -n -t 3 -T 1 >/dev/null 2>&1 || echo "kw-net: no DHCP lease on eth0"
EOF
chmod 755 "$stage/etc/kw-net.sh"
# /data (a disk labelled kwdata) and, with it, the overlay root: the
# initramfs is the lower layer, and every change to the root persists in
# /data/overlay. /init runs "kw-data.sh root"; see kernel/guest/kw-data.sh
# and kernel/guest/overlay/ (root.sh has the boot health checks and safe
# mode, bootwatch.sh confirms a boot, rebase.sh rebases apk's database after
# an image update, apk-cleanup.sh and apk-hook.sh deal with a cut-off apk
# run, kw-overlay.sh is the kw-overlay command).
g="$root/kernel/guest"
install -m 755 "$g/kw-data.sh" "$stage/etc/kw-data.sh"
install -m 755 "$g/overlay/kw-overlay.sh" "$stage/usr/sbin/kw-overlay"
mkdir -p "$stage/usr/lib/kw-overlay" "$stage/etc/apk/commit_hooks.d"
for f in root bootwatch rebase apk-cleanup; do
	install -m 755 "$g/overlay/$f.sh" "$stage/usr/lib/kw-overlay/$f"
done
install -m 755 "$g/overlay/apk-hook.sh" "$stage/etc/apk/commit_hooks.d/kw-overlay.hook"
# poweroff/reboot: with /data mounted, stop everything first so that nothing
# keeps it busy (init would only do that after this), then unmount it.
cat > "$stage/etc/kw-shutdown" <<'EOF'
#!/bin/sh
if mountpoint -q /data; then
	kill -TERM -1 2>/dev/null
	sleep 0.2
	kill -KILL -1 2>/dev/null
	/etc/kw-data.sh stop
fi
sync
EOF
chmod 755 "$stage/etc/kw-shutdown"
# TERM: busybox init gives the console vt102 (no colors); the page's xterm.js
# and the CLI's host terminal are xterm-compatible.
printf '%s\n' 'case $TERM in linux|vt102|"") export TERM=xterm-256color ;; esac' > "$stage/etc/profile.d/kw-term.sh"
# Home: busybox init starts the console shell (no login) with HOME=/ in /,
# so give root its home (/root, as in /etc/passwd) and start there, as login
# would.
cat > "$stage/etc/profile.d/kw-home.sh" <<'EOF'
if [ "$HOME" = / ] && [ "$(id -u)" = 0 ] && [ -d /root ]; then
	export HOME=/root
	[ "$PWD" = / ] && cd /root
fi
EOF
# Prompt: a minimal take on oh-my-zsh's pygmalion theme, "dir ⇒".
# 20locale.sh (sourced first) sets LANG=C.UTF-8, so ash counts ⇒ as one column.
cat > "$stage/etc/profile.d/kw-prompt.sh" <<'EOF'
PS1='\[\033[36m\]\w \[\033[35m\]⇒\[\033[0m\] '
export PS1
EOF
# Command not found (e.g. node, htop): install whatever provides it with
# `apk add cmd:NAME` (in gray) when there is a network, then run it. Alpine's
# busybox ash calls command_not_found_handle with the name only, so the
# arguments come from the history line, and only for a simple line (no ; & |
# < > ` $(): re-running a compound line would repeat its other parts. The
# exit status is 127 either way (ash sets it after the hook). Interactive
# shells only; KW_AUTO_APK=0 turns it off.
#
# The hook must not fork subshells: in busybox 1.37 a $(...) or pipeline
# child forked inside command_not_found_handle does not exit at its end but
# unwinds into the interactive loop, which then reads the next lines with
# stdout on the pipe. So the work is in a separate script, and the hook uses
# builtins and plain external commands only.
cat > "$stage/etc/profile.d/kw-apk.sh" <<'EOF'
case $- in *i*)
command_not_found_handle() {
	local cmd=$1 n l line= rest h=/tmp/.kw-apk-history.$$
	if [ "${KW_AUTO_APK:-1}" = 0 ]; then
		echo "sh: $cmd: not found" >&2
		return 127
	fi
	/etc/kw-apk-install "$cmd" || return 127
	history > "$h" 2>/dev/null
	while read -r n l; do line=$l; done < "$h"
	rm -f "$h"
	case $line in
	*';'*|*'&'*|*'|'*|*'<'*|*'>'*|*'`'*|*'$('*) ;;
	"$cmd"|"$cmd "*)
		rest=${line#"$cmd"}
		eval "set -- $rest" && { "$cmd" "$@"; return; } ;;
	esac
	echo "$cmd: installed, run the command again" >&2
	return 127
}
;; esac
EOF
# kw-apk-install NAME: install the package providing command NAME. Exit 0 if
# NAME is installed now, else print the shell's "not found". The lookup does
# not ask apk, which parses all enabled indexes on every run (~0.65 s main,
# ~2.7 s with community, under kwemu). A command in no enabled repository is
# looked up in the ones in /etc/kw-apk-lazy (community); on a hit, that
# repository is enabled for good, then installed from.
#
# Lookups go through a list of the command names an index provides (its
# cmd: entries on p: lines), built from the index the first time it is
# needed and kept in /var/cache/kw-apk/<index file name>.cmds. Its first
# line records the index's mtime and size; when the index changes (apk
# refreshed it, the page pushed a newer one) the list is built again.
# Building takes ~1.2 s for main and ~3.1 s for community, a lookup in a list
# ~0.1 s, where a grep of the index itself took ~2.9 s for community every
# time. busybox is slow per line (~10 us), so the pipeline first cuts the
# 323k lines of community's index down to the ~4.4k with "cmd:" (grep -F,
# the cheapest filter), then takes the p: lines; a p: line starts with its
# first provide ("p:cmd:htop=3.5.3-r0"), hence the sed rather than grep.
#
# A lazy repository's index is fetched with wget straight to the name apk
# gives its cache file (APKINDEX.<first 8 hex digits of sha1(index URL)>
# .tar.gz), so once the repository is enabled apk uses that file instead of
# downloading it again (while its mtime is less than 4 h old). The page may
# have pushed it there already (web/src/apk.ts). apk ignores the file while
# the repository is not enabled, and checks its signature on every load,
# so the grep here is the only thing that reads it unverified.
cat > "$stage/etc/kw-apk-install" <<'EOF'
#!/bin/sh
cmd=$1
notfound() { echo "sh: $cmd: not found" >&2; exit 127; }
case $cmd in ''|*[!A-Za-z0-9._+-]*) notfound ;; esac
[ "$(id -u)" = 0 ] || notfound
awk '$2 == "00000000" { f = 1 } END { exit !f }' /proc/net/route 2>/dev/null || notfound
gray= reset=
[ -t 2 ] && gray='\033[90m' reset='\033[0m'
trap 'printf "$reset" >&2; exit 130' INT TERM
# "NAME: not found, " starts the first status line only.
pre="$cmd: not found, "
say() { printf "${gray}%s%s${reset}\n" "$pre" "$1" >&2; pre=; }
arch=$(cat /etc/apk/arch)
# The plain repository URLs (optionally after an @tag) in the given files.
repos() { sed -n 's/^@[^ ]*  *//; s/[[:space:]]*$//; /^https\{0,1\}:\/\/[^[:space:]]*$/p' "$@" 2>/dev/null; }
# apk's cache file for a repository's index.
index() { echo "/var/cache/apk/APKINDEX.$(printf %s "${1%/}/$arch/APKINDEX.tar.gz" | sha1sum | cut -c1-8).tar.gz"; }
# has INDEX: whether the cached index provides cmd:NAME (see above).
has() {
	local l=/var/cache/kw-apk/${1##*/}.cmds stamp
	stamp=$(stat -c '#%Y %s' "$1" 2>/dev/null) || return 1
	if [ "$(head -n1 "$l" 2>/dev/null)" != "$stamp" ]; then
		mkdir -p /var/cache/kw-apk
		{ echo "$stamp"; zcat "$1" | grep -F cmd: | sed -n 's/^p://p' | tr ' =' '\n\n' | sed -n 's/^cmd://p'; } > "$l.$$" &&
			mv -f "$l.$$" "$l" || { rm -f "$l.$$"; return 1; }
	fi
	grep -qxF "$cmd" "$l"
}
on=" $(echo $(repos /etc/apk/repositories /etc/apk/repositories.d/*.list)) "
for r in $on; do
	[ -e "$(index "$r")" ] && continue
	say "fetching the apk index"
	apk update -q >&2 || notfound
	break
done
found=
for r in $on; do has "$(index "$r")" && { found=1; break; }; done
if [ -z "$found" ]; then
	for r in $(repos /etc/kw-apk-lazy); do
		case $on in *" $r "*) continue ;; esac
		f=$(index "$r")
		if [ ! -e "$f" ]; then
			say "fetching the ${r##*/} index"
			if ! wget -qO "$f.kw" "${r%/}/$arch/APKINDEX.tar.gz" 2>/dev/null; then
				rm -f "$f.kw"
				continue
			fi
			mv -f "$f.kw" "$f"
		fi
		has "$f" || continue
		say "$cmd is in ${r##*/}, adding it to /etc/apk/repositories"
		/etc/kw-apk-enable "$r" || notfound
		found=1
		break
	done
fi
# Lists of indexes that are gone (a repository was removed).
for l in /var/cache/kw-apk/*.cmds; do
	[ ! -e "$l" ] || [ -e "/var/cache/apk/$(basename "$l" .cmds)" ] || rm -f "$l"
done
[ -n "$found" ] || notfound
printf "${gray}%sapk add cmd:%s\n" "$pre" "$cmd" >&2
apk add "cmd:$cmd" >&2
printf "$reset" >&2
command -v "$cmd" >/dev/null
EOF
chmod 755 "$stage/etc/kw-apk-install"
# kw-apk-enable [URL...]: add repositories from /etc/kw-apk-lazy (all of them
# without arguments) to /etc/apk/repositories, unless they are there already.
# It runs no `apk update`: that would fetch every index again, while the next
# apk command fetches only the indexes that are missing or older than 4 h.
cat > "$stage/etc/kw-apk-enable" <<'EOF'
#!/bin/sh
f=/etc/apk/repositories
[ $# -gt 0 ] || set -- $(grep -v '^[[:space:]]*#' /etc/kw-apk-lazy 2>/dev/null)
for r; do
	grep -qxF "$r" $f 2>/dev/null && continue
	[ -z "$(tail -c1 $f 2>/dev/null)" ] || echo >> $f
	echo "$r" >> $f || exit 1
done
EOF
chmod 755 "$stage/etc/kw-apk-enable"
# Foreign binaries: x86_64, riscv64, i386 (i486-i686 too) and 32-bit arm
# (armv5-armv7, armhf) little-endian ELF executables run through qemu-user,
# by binfmt_misc in the guest kernel (aarch64 is native; the kernel has no
# AArch32, so 32-bit arm needs qemu too). The magic/mask pairs are the ones
# from qemu's scripts/qemu-binfmt-conf.sh: 20 bytes, up to e_machine,
# matching ET_EXEC and ET_DYN. Flag P passes the original argv[0] to the
# interpreter.
cat > "$stage/etc/kw-binfmt.sh" <<'EOF'
#!/bin/sh
d=/proc/sys/fs/binfmt_misc
[ -d $d ] || exit 0
mountpoint -q $d || mount -t binfmt_misc binfmt_misc $d 2>/dev/null || exit 0
reg() { [ -e $d/$1 ] || printf '%s\n' ":$1:M::$2:$3:/etc/kw-qemu:P" > $d/register; }
reg x86_64 '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00' \
	'\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
reg riscv64 '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xf3\x00' \
	'\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
reg i386 '\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x03\x00' \
	'\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
reg arm '\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x28\x00' \
	'\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
EOF
chmod 755 "$stage/etc/kw-binfmt.sh"
# The binfmt_misc interpreter: $1 = the binary, $2 = its argv[0], then its
# arguments. Picks qemu-ARCH from e_machine (the masks above admit only
# those four values, so e_ident[EI_CLASS] needs no check here) and execs the
# binary under it. The first time, as root with a network, it installs
# qemu-ARCH and a library root for dynamic binaries at qemu's default
# prefix /usr/gnemul/qemu-ARCH: musl, libgcc and libstdc++, plus gcompat for
# glibc binaries (/lib64/ld-linux-x86-64.so.2 etc. on top of musl), checked
# with that architecture's keys from alpine-keys. qemu-ARCH is in community,
# so it enables that repository first (kw-apk-enable). One install at a time,
# because apk locks its database. Without root or a network it runs with
# what is there, and fails only without qemu.
cat > "$stage/etc/kw-qemu" <<'EOF'
#!/bin/sh
case $(od -An -tx1 -j18 -N1 "$1" 2>/dev/null) in
*3e) arch=x86_64 apkarch=x86_64 ;;
*f3) arch=riscv64 apkarch=riscv64 ;;
*03) arch=i386 apkarch=x86 ;;
*28) arch=arm apkarch=armv7 ;;
*) echo "$1: cannot tell the architecture" >&2; exit 126 ;;
esac
q=/usr/bin/qemu-$arch r=/usr/gnemul/qemu-$arch
need() { [ ! -x $q ] || [ ! -e $r/.kw-ready ]; }
if need && [ "$(id -u)" = 0 ] &&
	awk '$2 == "00000000" { f = 1 } END { exit !f }' /proc/net/route 2>/dev/null; then
	exec 9>/run/kw-qemu.lock && flock 9
	if need; then
		gray= reset=
		[ -t 2 ] && gray='\033[90m' reset='\033[0m'
		trap 'printf "$reset" >&2; exit 130' INT TERM
		if [ ! -x $q ]; then
			printf "${gray}%s: %s binary, apk add qemu-%s\n" "$1" $arch $arch >&2
			/etc/kw-apk-enable   # qemu-ARCH is in community
			apk add qemu-$arch >&2
		fi
		if [ -x $q ] && [ ! -e $r/.kw-ready ]; then
			printf "${gray}%s: %s libraries in %s\n" "$1" $arch $r >&2
			init=
			[ -d $r/lib/apk/db ] || init=--initdb
			mkdir -p $r
			apk add --root $r --arch $apkarch $init --no-scripts --no-cache \
				--keys-dir /usr/share/apk/keys/$apkarch \
				--repositories-file /etc/apk/repositories \
				musl libgcc libstdc++ gcompat >&2 && : > $r/.kw-ready
		fi
		printf "$reset" >&2
		trap - INT TERM
	fi
	exec 9>&-
fi
if [ ! -x $q ]; then
	echo "$1: $arch binary, needs qemu-$arch (apk add qemu-$arch)" >&2
	exit 126
fi
f=$1 a0=$2
shift 2
exec $q -0 "$a0" "$f" "$@"
EOF
chmod 755 "$stage/etc/kw-qemu"
# kw-arch ARCH [COMMAND [ARG...]]: run COMMAND (default: a shell) with uname
# and arch reporting ARCH instead of aarch64, for installers that pick their
# download by `uname -m` (or have no aarch64 build); what they fetch then
# runs through /etc/kw-qemu. E.g. `curl -fsSL URL | kw-arch x86_64 bash`.
# Only the commands are faked (PATH), not the uname() syscall. aarch64
# (arm64) is accepted and changes nothing.
cat > "$stage/usr/bin/kw-arch" <<'EOF'
#!/bin/sh
case $1 in
x86_64|amd64|x64) m=x86_64 ;;
riscv64) m=riscv64 ;;
i386|i486|i586|i686|x86) m=i686 ;;
arm|armv7|armv7l|armhf) m=armv7l ;;
aarch64|arm64) m=aarch64 ;;
*) echo "usage: kw-arch x86_64|riscv64|i686|armv7l|aarch64 [command [arg...]]" >&2; exit 2 ;;
esac
shift
[ $# = 0 ] && set -- "${SHELL:-/bin/sh}"
KW_ARCH=$m PATH=/usr/lib/kw-arch:$PATH exec "$@"
EOF
mkdir -p "$stage/usr/lib/kw-arch"
cat > "$stage/usr/lib/kw-arch/uname" <<'EOF'
#!/bin/sh
/bin/busybox "${0##*/}" "$@" | sed "s/aarch64/${KW_ARCH:-aarch64}/g"
EOF
ln -sf uname "$stage/usr/lib/kw-arch/arch"
chmod 755 "$stage/usr/bin/kw-arch" "$stage/usr/lib/kw-arch/uname"
# curl: a shim over busybox wget for plain GET downloads (`curl -fsSL URL |
# sh`); anything else installs and runs the real curl. See the file's header.
install -m 755 "$root/kernel/guest/curl-shim.sh" "$stage/usr/local/bin/curl"
# bwrap: a shim that drops --seccomp, which the kernel does not have, so GTK
# programs can load images (Xfce). See the file's header.
install -m 755 "$root/kernel/guest/bwrap-shim.sh" "$stage/usr/local/bin/bwrap"

# X.Org on the framebuffer: the image has no udev, so X cannot find the
# display or the input devices by itself. With these files, `apk add
# xorg-server xf86-video-fbdev xf86-input-evdev` and `X :0` use /dev/fb0
# (kwfb) and the evdev keyboard, mouse and tablet (kwinput). With the tablet
# (absolute) open, the page sends the pointer there and the host cursor moves
# in and out of the picture freely; the relative mouse stays configured
# (the page sends it nothing while the tablet is open; {rel=..} works).
install -d "$stage/etc/X11/xorg.conf.d"
cat > "$stage/etc/X11/xorg.conf.d/10-kw-fb.conf" <<'EOF'
Section "ServerFlags"
	Option "AutoAddDevices" "false"
EndSection
Section "Device"
	Identifier "kwfb"
	Driver "fbdev"
EndSection
EOF
cat > "$stage/etc/X11/xorg.conf.d/20-kw-input.conf" <<'EOF'
Section "InputDevice"
	Identifier "kwinput keyboard"
	Driver "evdev"
	Option "Device" "/dev/input/event0"
	Option "AutoServerLayout" "true"
EndSection
Section "InputDevice"
	Identifier "kwinput mouse"
	Driver "evdev"
	Option "Device" "/dev/input/event1"
	Option "AutoServerLayout" "true"
EndSection
Section "InputDevice"
	Identifier "kwinput tablet"
	Driver "evdev"
	Option "Device" "/dev/input/event2"
	Option "AutoServerLayout" "true"
EndSection
EOF

# The display, input and sound game and self-test (glimmer.c; it needs the CLI's
# --display or the page, and plays sound with --sound/--sound-wav or on the page),
# the vsock pipe (kwvsock.c; it needs a host with vsock, CLI --vsock or the SDK),
# the shm exporter (kwshm.c; it needs a host with shm, CLI --shm or the SDK)
# the terminal server (kwtty.c, from inittab; it serves a host with vsock)
# and the 9p mounter (kw9p.c; it needs a host serving 9p over vsock).
# All static aarch64 musl for the generic CPU (ARMv8.0, what kwemu runs).
cc_guest=("$zig" cc -target aarch64-linux-musl -mcpu=generic -static -O2 -s)
for t in glimmer kwvsock kwshm kwtty kw9p; do
	"${cc_guest[@]}" -o "$stage/usr/bin/$t" "$root/kernel/guest/$t.c"
done
# The kernel smoke test and benchmark (see the top of this file) are not in
# the image: they go into a second archive, below.
tstage="$out/kwtest-root"
rm -rf "$tstage"
mkdir -p "$tstage/usr/bin"
for t in kwtest kwbench; do
	"${cc_guest[@]}" -o "$tstage/usr/bin/$t" "$root/kernel/guest/$t.c"
done

# Image id, for the overlay root (overlay/root.sh): a hash of the tree (names,
# modes, links, contents; no times or owners), so an identical rebuild keeps
# the id and any change gets a new one.
id=$(tar -C "$stage" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | sha256sum | cut -c1-16)
echo "alpine-$ALPINE_VERSION-$id" > "$stage/usr/lib/kw-image"
echo "image id: alpine-$ALPINE_VERSION-$id"

# alpine-test.cpio is the image plus kwtest and kwbench: two archives back
# to back, which the kernel unpacks in turn (the second adds its files).
# alpine.cpio, which kernel/build.sh bundles, is the same, or with
# KW_RELEASE=1 (the release workflow) the image alone. The image id above
# leaves the test programs out, so all carry the same one. (The choice is
# made here, not in build.sh: build.sh is part of CI's kernel cache key.)
python3 "$root/kernel/tools/mkcpio.py" "$stage" "$out/alpine-image.cpio"
python3 "$root/kernel/tools/mkcpio.py" "$tstage" "$out/kwtest.cpio"
cat "$out/alpine-image.cpio" "$out/kwtest.cpio" > "$out/alpine-test.cpio"
rm "$out/kwtest.cpio"
if [ "${KW_RELEASE:-0}" = 1 ]; then
	mv "$out/alpine-image.cpio" "$out/alpine.cpio"
	echo "initramfs: $out/alpine.cpio (KW_RELEASE=1: without kwtest and kwbench)"
else
	rm "$out/alpine-image.cpio"
	cp "$out/alpine-test.cpio" "$out/alpine.cpio"
	echo "initramfs: $out/alpine.cpio (with kwtest and kwbench; KW_RELEASE=1 leaves them out)"
fi
echo "initramfs with kwtest and kwbench: $out/alpine-test.cpio"
