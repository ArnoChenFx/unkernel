#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /usr/lib/kw-overlay/root: make / an overlay whose changes live on /data.
# Run by "/etc/kw-data.sh root" from /init, on the initramfs root, with
# /data mounted. Everything here runs from the initramfs (the lower layer),
# so nothing in the changes can break it.
#
# Lower layer: the initramfs root (rootfs, remounted read-only). Upper and
# work dirs: /data/overlay/{upper,work}. The overlay is mounted at /mnt,
# checked, and entered with pivot_root (busybox switch_root would empty the
# old root first, and that is the lower layer); the old root stays visible,
# read-only, at /run/kw-lower.
#
# Boot health (safe mode = this boot stays on the plain initramfs root, with
# /data mounted and the changes left untouched in /data/overlay/upper):
#   - before mounting: /data/overlay/safe (written below or by bootwatch)
#     keeps safe mode on until "kw-overlay restore"; MAX consecutive boots
#     that did not reach a shell prompt (/data/overlay/attempts) write it;
#   - after mounting: the merged root must have a working /bin/sh (this
#     runs it, so a broken shell, busybox or C library shows up here),
#     /sbin/init and an inittab with a console shell, else this one boot
#     falls back (the next boot checks again);
#   - after the switch: bootwatch (started here, from the lower layer)
#     clears the attempt count once an interactive shell waits for input.
# Messages go to /run/kw-overlay.msg; the sysinit run of kw-data.sh prints
# them.
ov=/data/overlay
lib=/usr/lib/kw-overlay
msg=/run/kw-overlay.msg
MAX=2
now() { date +%Y%m%d-%H%M%S; }
syncdata() { sync -f $ov 2>/dev/null || sync; }
case $(awk '$2 == "/" { t = $3 } END { print t }' /proc/mounts) in
rootfs|tmpfs|ramfs) ;;
*) exit 0 ;; # a disk root persists anyway
esac
mode=
for a in $(cat /proc/cmdline); do
	case $a in kw.root=*) mode=${a#kw.root=} ;; esac
done
case $mode in
'') ;;
initramfs)
	echo "kw-overlay: kw.root=initramfs: the plain image this time; your root changes stay in $ov/upper, unmounted" >> $msg
	exit 0 ;;
*) echo "kw-overlay: ignoring kw.root=$mode (only kw.root=initramfs is known)" >> $msg ;;
esac
mkdir -p $ov

# fallback STICKY REASON: stay on the plain root for this boot.
fallback() {
	if [ "$1" = sticky ]; then
		how="  kw-overlay restore   boot with them again (from the next boot)"
	else
		how="  Fix it in $ov/upper and reboot: each boot checks again."
	fi
	cat >> $msg <<-EOT
	kw-overlay: SAFE MODE: $2
	  This boot runs the plain image. Your changes to the root are kept,
	  unmounted, in $ov/upper; nothing was deleted.
	  kw-overlay status    what happened
	$how
	  kw-overlay discard   set them aside and start over from the image
	EOT
	exit 0
}

# "kw-overlay discard" on the overlay root takes effect here.
if [ -e $ov/discard ]; then
	old=$ov/discarded-$(now)
	mkdir -p $old
	mv $ov/upper $ov/lower $ov/image $old/ 2>/dev/null
	rm -rf $ov/work $ov/discard $ov/safe $ov/attempts
	echo "kw-overlay: starting over from the image; the previous changes are in $old" >> $msg
fi
[ -s $ov/safe ] && fallback sticky "$(cat $ov/safe)"
n=$(cat $ov/attempts 2>/dev/null)
case $n in ''|*[!0-9]*) n=0 ;; esac
if [ "$n" -ge $MAX ]; then
	echo "the last $n boots with your root changes did not reach a shell prompt ($(date -Iseconds))" > $ov/safe
	rm -f $ov/attempts
	syncdata
	fallback sticky "$(cat $ov/safe)"
fi
mkdir -p $ov/upper $ov/work

# An apk run that was cut off (its pre-commit hook left the marker).
if [ -e $ov/upper/lib/apk/db/kw-commit ]; then
	"$lib/apk-cleanup" $ov/upper >> $msg 2>&1
fi
# A new image under existing changes: rebase the user's packages onto its
# apk database. /data/overlay/image holds the package list and world of the
# image the changes were last used with.
img=$(cat /usr/lib/kw-image 2>/dev/null)
was=$(cat $ov/lower 2>/dev/null)
if [ -n "$was" ] && [ "$was" != "$img" ]; then
	echo "kw-overlay: the root image changed: $was -> $img" >> $msg
	"$lib/rebase" $ov/upper $ov/rebase-$(now) $ov/image >> $msg 2>&1
	echo "$(date -Iseconds) $was -> $img" >> $ov/history
fi
if [ "$was" != "$img" ] || [ ! -s $ov/image/world ]; then
	mkdir -p $ov/image
	awk -F: '/^P:/ { p = $2 } /^V:/ { print p, $2 }' /lib/apk/db/installed > $ov/image/pkgs
	cp /etc/apk/world $ov/image/world
	echo "$img" > $ov/lower
fi

# The default features: overlayfs defines offline changes of the lower
# layer only when redirect_dir, index, xino and metacopy are off.
mount -t overlay overlay -o lowerdir=/,upperdir=$ov/upper,workdir=$ov/work,redirect_dir=off,index=off,xino=off,metacopy=off /mnt ||
	fallback once "the overlay could not be mounted (see dmesg)"
# The merged root must be able to start a console shell (kwtty's respawn
# entry, the host's terminals over vsock, is not one).
bad=
if ! chroot /mnt /bin/sh -c : 2>/dev/null; then
	if [ -e /mnt/bin/sh ] || [ -L /mnt/bin/sh ]; then
		bad="/bin/sh does not run (a broken shell, busybox or C library in the changes)"
	else
		bad="/bin/sh is missing"
	fi
elif ! chroot /mnt /bin/sh -c '[ -x /sbin/init ]'; then
	bad="/sbin/init is missing or not executable"
elif ! chroot /mnt /bin/sh -c 'grep -E "^[^#:]*:[^:]*:(respawn|askfirst):." /etc/inittab | grep -qv /usr/bin/kwtty' 2>/dev/null; then
	bad="/etc/inittab starts no console shell (no respawn or askfirst entry)"
fi
if [ -n "$bad" ]; then
	umount /mnt
	fallback once "$bad"
fi
echo $((n + 1)) > $ov/attempts
syncdata

# The lower layer must not change while it is in use.
mount -o remount,ro / || echo "kw-overlay: cannot make the initramfs root read-only"
for m in data dev proc sys run; do mount --move /$m /mnt/$m; done
# /tmp stays in memory, as on the plain root.
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /mnt/tmp
mkdir -p /mnt/run/kw-lower
if cd /mnt && pivot_root . run/kw-lower; then
	# Confirms the boot (or detects a shell that keeps exiting); from the
	# lower layer, which the changes cannot touch.
	setsid /bin/sh /run/kw-lower$lib/bootwatch </dev/null >/dev/console 2>&1 &
	exit 0
fi
cd /
for m in data dev proc sys run; do mount --move /mnt/$m /$m; done
umount /mnt/tmp /mnt
mount -o remount,rw /
echo $n > $ov/attempts
fallback once "pivot_root into the overlay failed"
