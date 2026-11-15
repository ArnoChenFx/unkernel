#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# kw-overlay [status|restore|discard]: the overlay root (/usr/lib/kw-overlay/root).
#   status    the root, the image, safe mode and why, the changes' size,
#             image updates, and directories set aside
#   restore   leave safe mode: the next boot uses the changes again
#   discard   set the changes aside (/data/overlay/discarded-TIME) and start
#             over from the image: at once on the plain root (safe mode or
#             kw.root=initramfs), at the next boot on the overlay root
#             ("reset" is the same)
ov=/data/overlay
root=$(awk '$2 == "/" { t = $3 } END { print t }' /proc/mounts)
need_data() { mountpoint -q /data || { echo "kw-overlay: no /data (kwdata disk), so no overlay root" >&2; exit 1; }; }
size() { du -sh "$1" 2>/dev/null | cut -f1; }
case $1 in
status|'')
	need_data
	if [ "$root" = overlay ]; then
		echo "root: overlay, image $(cat /run/kw-lower/usr/lib/kw-image 2>/dev/null); changes in $ov/upper ($(size $ov/upper))"
	else
		echo "root: $root (plain image $(cat /usr/lib/kw-image 2>/dev/null)); changes in $ov/upper ($(size $ov/upper)), not mounted"
		grep -q 'kw\.root=initramfs' /proc/cmdline && echo "  because of kw.root=initramfs on the kernel command line (this boot only)"
	fi
	[ -s $ov/safe ] && printf '%s\n' "safe mode: $(cat $ov/safe)" "  'kw-overlay restore' boots with the changes again"
	[ -s /run/kw-overlay.msg ] && { echo "this boot:"; sed 's/^/  /' /run/kw-overlay.msg; }
	[ -s $ov/attempts ] && echo "boots without a shell prompt so far: $(cat $ov/attempts) (safe mode after 2)"
	[ -e $ov/discard ] && echo "discard pending: the changes are set aside at the next boot"
	[ -s $ov/lower ] && echo "changes last used with image: $(cat $ov/lower)"
	[ -s $ov/history ] && { echo "image updates under the changes:"; sed 's/^/  /' $ov/history; }
	for d in $ov/discarded-* $ov/rebase-* $ov/old-*; do
		[ -d "$d" ] && echo "set aside: $d ($(size "$d"))"
	done
	[ -s $ov/apk-cleanup.log ] && echo "apk cleanups: $(grep -c '^==' $ov/apk-cleanup.log) (log: $ov/apk-cleanup.log)"
	;;
restore)
	need_data
	if [ -s $ov/safe ]; then
		rm -f $ov/safe $ov/attempts
		sync -f $ov 2>/dev/null
		echo "kw-overlay: the next boot uses your changes ($ov/upper) again"
	else
		rm -f $ov/attempts
		echo "kw-overlay: not in safe mode; nothing to restore"
	fi
	;;
discard|reset)
	need_data
	if [ "$root" = overlay ]; then
		: > $ov/discard
		echo "kw-overlay: at the next boot, $ov/upper moves to $ov/discarded-TIME and the root starts over from the image"
	else
		rm -f $ov/discard
		if [ -d $ov/upper ]; then
			old=$ov/discarded-$(date +%Y%m%d-%H%M%S)
			mkdir -p $old
			mv $ov/upper $ov/lower $ov/image $old/ 2>/dev/null
			echo "kw-overlay: your changes are now in $old; the next boot starts over from the image"
		fi
		rm -rf $ov/work $ov/safe $ov/attempts
	fi
	sync -f $ov 2>/dev/null
	;;
*) echo "usage: kw-overlay [status|restore|discard]" >&2; exit 2 ;;
esac
