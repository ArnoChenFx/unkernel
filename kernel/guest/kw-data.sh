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
roottype() { awk '$2 == "/" { t = $3 } END { print t }' /proc/mounts; }
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
