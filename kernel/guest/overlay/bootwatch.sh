#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /usr/lib/kw-overlay/bootwatch: confirms that a boot into the overlay root
# got as far as an interactive shell. Started by /usr/lib/kw-overlay/root
# right after the switch, from the lower layer (/run/kw-lower), so the
# changes cannot remove or alter it; it needs a working /bin/sh, which root
# has just checked.
#
# Ready: a session leader with a controlling terminal that is a shell (or a
# getty or login) sleeping with the terminal in its own foreground process
# group and no child processes, the same process in two samples 0.25 s
# apart. That is a shell waiting at its prompt; a shell still in a hanging
# /etc/profile has a child (sleep, ...) or is running, and one that exits
# is replaced by a new one. The shell of a kwtty session (a terminal of
# the host's, over vsock) counts too. Ready removes /data/overlay/attempts
# (and a safe-mode request this script made), and the script ends.
# Not ready: while a boot works there is always some process besides init
# and this script (a sysinit script, then the shell; kwtty, which is always
# there, does not count). A shell that exits right away (busybox init
# respawns it once a second) or an inittab that starts none leaves the
# system empty: 12 empty samples (3 s) before a prompt request safe mode
# for the next boot at once (/data/overlay/safe, withdrawn if a prompt
# appears later after all). A shell that hangs is left to the attempt
# count; after 20 s a hint says how to get out.
ov=/data/overlay
y='\033[33m' off='\033[0m'
note() { printf "${y}kw-overlay: %s$off\n" "$*"; }
syncdata() { sync -f $ov 2>/dev/null || sync; }

# Sets $ready to the pid of a shell waiting for input (or empty), and $busy
# if any process other than init, kernel threads, kwtty and this script runs.
scan() {
	cand= ppids=" " ready= busy=
	for d in /proc/[0-9]*; do
		{ read -r l < $d/stat; } 2>/dev/null || continue # it may have exited
		p=${d#/proc/}
		c=${l#*\(}
		c=${c%\)*}
		set -- ${l##*\) }
		# $1 state, $2 ppid, $3 pgrp, $4 session, $5 tty_nr, $6 tpgid
		ppids="$ppids$2 "
		case $p:$2:$c in 1:*|2:*|*:2:*|$$:*|*:$$:*|*:kwtty) ;; *) busy=1 ;; esac
		[ "$4" = "$p" ] && [ "$5" != 0 ] || continue
		case $c in sh|ash|bash|zsh|dash|mksh|fish|getty|agetty|login) ;; *) continue ;; esac
		[ "$1" = S ] && [ "$3" = "$6" ] && cand="$cand $p"
	done
	for p in $cand; do
		case $ppids in *" $p "*) ;; *) ready=$p ;; esac
	done
}

empty=0 last= t=0 asked=
sleep 0.2
while :; do
	scan
	if [ -n "$ready" ] && [ "$ready" = "$last" ]; then
		rm -f $ov/attempts
		if [ -n "$asked" ]; then
			rm -f $ov/safe
			note "a shell prompt appeared after all: the next boot uses your root changes again"
		fi
		syncdata
		exit 0
	fi
	last=$ready
	[ -n "$busy" ] || empty=$((empty + 1))
	if [ $empty -ge 12 ] && [ -z "$asked" ] && [ ! -s $ov/safe ]; then
		asked=1
		echo "no console shell stayed up: it kept exiting before its prompt (a broken /etc/profile, shell or inittab entry?) ($(date -Iseconds))" > $ov/safe
		syncdata
		note "the console shell keeps exiting before it shows a prompt."
		note "The next boot starts in safe mode (the plain image, your changes kept in $ov/upper): reboot."
	fi
	t=$((t + 1))
	if [ $t = 80 ] && [ -z "$asked" ]; then
		note "no shell prompt after 20 s. If the system is stuck, reboot: after 2 boots like this the next one starts in safe mode (the plain image; your changes are kept). kw.root=initramfs on the kernel command line (page: ?root=initramfs, or Boot without root changes in the panel) does so at once."
	fi
	# After a minute, look less often.
	if [ $t -lt 240 ]; then sleep 0.25; else sleep 2; fi
done
