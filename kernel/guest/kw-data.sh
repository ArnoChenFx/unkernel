#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /etc/kw-data.sh: the persistent data disk, an ext4 file system labelled
# kwdata, if the host attached one (found by label: wda, or the disk after
# the root disk). Without one it does nothing.
#
#   kw-data.sh root   /init, on the initramfs root: mount /data, then make /
#                     the overlay with the changes on /data
#                     (/usr/lib/kw-overlay/root)
#   kw-data.sh        inittab sysinit: mount /data if /init did not (a disk
#                     root), print the overlay's messages, if any
#   kw-data.sh stop   /etc/kw-shutdown: leave /data clean
#
# Mounted noatime,commit=1 (plus discard if the device has it), with a 1 s
# dirty expiry, so writes reach the disk within about 2 s; the host can also
# ask for a sync at any time (WASM_IRQ_SYNC).
#
# The guest architecture: /data/.kw-arch names the architecture (apk's,
# /etc/apk/arch) of the guest that uses the disk. Right after mounting,
# before the overlay root is assembled, a disk of another architecture is
# reset: everything on it is deleted but root's home in the upper layer
# (/data/overlay/upper/root), which leaves a new disk (the template) plus
# the marker and that home. A disk without a marker is reset only on
# evidence of another architecture in /data/overlay/upper (apk's database,
# else the ELF machine of system files); with none, or with this one, it is
# adopted and marked. The reset moves everything into /data/.kw-reset,
# moves the home back into a new upper layer, writes the marker, then
# deletes /data/.kw-reset: a boot that finds /data/.kw-reset finishes the
# reset, whatever step was cut off.
# kw.root=initramfs defers a reset that has not started (the disk stays as
# it was, to copy files off). Images without /etc/apk/arch skip all this.
msg=/run/kw-overlay.msg
roottype() { awk '$2 == "/" { t = $3 } END { print t }' /proc/mounts; }
syncdata() { sync -f /data 2>/dev/null || sync; }
isarch() { case $1 in ''|*[!a-z0-9_]*) return 1 ;; esac; [ ${#1} -le 16 ]; }
# The architecture of the changes in upper layer $1, if they show one.
upper_arch() {
	a=$(head -n1 "$1/etc/apk/arch" 2>/dev/null)
	isarch "$a" && { echo "$a"; return; }
	a=$(awk -F: '/^A:/ && $2 != "noarch" { n[$2]++ } END { for (k in n) if (n[k] > m) { m = n[k]; b = k } print b }' \
		"$1/lib/apk/db/installed" 2>/dev/null)
	isarch "$a" && { echo "$a"; return; }
	for d in bin sbin usr/bin usr/sbin lib usr/lib; do
		[ -d "$1/$d" ] && find "$1/$d" -maxdepth 1 -type f 2>/dev/null
	done | head -n 64 | while read -r f; do
		head -c 20 "$f" 2>/dev/null | od -An -tx1 | tr '\n' ' '; echo
	done | awk '$1 == "7f" && $2 == "45" && $3 == "4c" && $4 == "46" && $6 == "01" && $20 == "00" {
		a = $19 == "f3" ? "riscv64" : $19 == "b7" ? "aarch64" : $19 == "3e" ? "x86_64" : $19 == "03" ? "x86" : ""
		if (a != "") n[a]++ } END { for (k in n) if (n[k] > m) { m = n[k]; b = k } print b }'
}
reset_msg() {
	if isarch "$1"; then w="this disk was written by the $1 guest, the guest is now $want"
	else w="this disk was written by a guest of another architecture, the guest is now $want"; fi
}
# Reset /data after a guest of architecture $1 (see above). Root's home in
# the upper layer is kept: moved aside with the rest, then moved (renamed:
# owners, modes, xattrs and whiteouts stay as they are) into a new, empty
# upper layer before the marker is written. At any cut it is in exactly one
# place, set aside or already back, and a resumed reset finds it there.
reset_data() {
	t=/data/.kw-reset
	if [ ! -d $t ]; then
		mkdir $t.new && echo "$1" > $t.new/from && mv $t.new $t || return 1
		syncdata
	fi
	echo "kw-data: deleting what the old guest left on /data (keeping /root)..."
	n=0
	while [ -e $t/$n ]; do n=$((n + 1)); done
	for e in /data/* /data/.[!.]* /data/..?*; do
		[ -e "$e" ] || [ -L "$e" ] || continue
		case ${e#/data/} in lost+found|.kw-reset) continue ;; esac
		[ -d $t/$n ] || mkdir $t/$n || return 1
		mv "$e" $t/$n/ || return 1
	done
	# Root's home, a real directory (not a whiteout, not a link), from the
	# set-aside batch that has it (only ever one does).
	home=
	for h in $t/*/overlay/upper/root; do
		[ -d "$h" ] && [ ! -L "$h" ] && [ ! -L "${h%/upper/root}" ] && [ ! -L "${h%/root}" ] || continue
		home=$h
	done
	mkdir -p /data/overlay/upper || return 1
	[ -z "$home" ] || mv "$home" /data/overlay/upper/root || return 1
	syncdata
	echo "$want" > /data/.kw-arch.new && mv /data/.kw-arch.new /data/.kw-arch || return 1
	syncdata
	finish_reset
}
# The marker is written (root's home is back): delete what the reset set
# aside, then say so.
finish_reset() {
	reset_msg "$(cat /data/.kw-reset/from 2>/dev/null)"
	rm -rf /data/.kw-reset || return 1
	syncdata
	kept=
	[ -d /data/overlay/upper/root ] && [ ! -L /data/overlay/upper/root ] && kept=" /root was kept."
	echo "kw-data: RESET: Installed packages and system changes were reset ($w).$kept" >> $msg
}
check_arch() {
	want=$(head -n1 /etc/apk/arch 2>/dev/null)
	isarch "$want" || return 0
	rm -rf /data/.kw-reset.new /data/.kw-arch.new
	have=$(head -n1 /data/.kw-arch 2>/dev/null)
	isarch "$have" || have=
	if [ "$have" = "$want" ]; then
		[ -d /data/.kw-reset ] || return 0
		finish_reset || echo "kw-data: cannot delete /data/.kw-reset" >> $msg
		return 0
	fi
	if [ -d /data/.kw-reset ]; then
		from=$(cat /data/.kw-reset/from 2>/dev/null) # a reset that was cut off
	else
		from=${have:-$(upper_arch /data/overlay/upper)}
		if [ -z "$from" ] || [ "$from" = "$want" ]; then
			echo "$want" > /data/.kw-arch.new && mv /data/.kw-arch.new /data/.kw-arch && syncdata
			return 0
		fi
		if grep -qw 'kw\.root=initramfs' /proc/cmdline; then
			reset_msg "$from"
			echo "kw-data: $w: installed packages and system changes are reset (/root is kept) at the next boot without kw.root=initramfs; until then /data stays as it was" >> $msg
			return 0
		fi
	fi
	reset_data "$from" || echo "kw-data: the reset of /data failed (it is retried at the next boot)" >> $msg
}
if [ "$1" = stop ]; then
	mountpoint -q /data || exit 0
	sync
	if [ "$(roottype)" = overlay ]; then
		# A shutdown on request means this boot was usable, even if its
		# shell never sat idle at a prompt (bootwatch): not a failed boot.
		[ -s /data/overlay/safe ] || rm -f /data/overlay/attempts
		# /data is busy under the overlay root: read-only commits the
		# journals and marks both file systems clean.
		mount -o remount,ro / 2>/dev/null
		if mount -o remount,ro /data; then
			echo "kw-shutdown: /data is clean (read-only under the overlay root)"
		else
			echo "kw-shutdown: /data is busy"
		fi
	elif umount /data; then
		echo "kw-shutdown: /data is clean"
	elif mount -o remount,ro /data; then
		echo "kw-shutdown: /data is busy, remounted read-only"
	fi
	exit 0
fi
if ! mountpoint -q /data; then
	dev=$(findfs LABEL=kwdata 2>/dev/null) || exit 0
	mkdir -p /data
	o=noatime,commit=1
	[ "$(cat /sys/class/block/${dev#/dev/}/queue/discard_max_bytes 2>/dev/null)" -gt 0 ] 2>/dev/null && o=$o,discard
	mount -t ext4 -o $o "$dev" /data || {
		echo "kw-data: cannot mount $dev (LABEL=kwdata) on /data"; exit 0; }
	[ "$(stat -c %u:%g /data)" = 0:0 ] || chown 0:0 /data
	sysctl -q -w vm.dirty_expire_centisecs=100 vm.dirty_writeback_centisecs=100
	check_arch
fi
[ "$1" = root ] && exec /usr/lib/kw-overlay/root
# Nothing to say when all went well (the hosts already report the disk; df
# and `kw-overlay` show the rest). Written by /usr/lib/kw-overlay/root
# before the switch: safe mode, image update, apk cleanup.
if [ -s /run/kw-overlay.msg ]; then
	y= reset=
	[ -t 1 ] && y='\033[33m' reset='\033[0m'
	printf "$y%s$reset\n" "$(cat /run/kw-overlay.msg)"
fi
exit 0
