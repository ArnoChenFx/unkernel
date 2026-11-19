# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Command not found (e.g. htop, rg): install the package that provides it
# with `apt-get install` (in gray) when there is a network, then run it with
# its arguments (/usr/local/sbin/kw-apt-install does the work). bash runs
# command_not_found_handle in the forked child that was to exec the
# command, with the whole command line as arguments, so running "$@" here
# is running the command; its status is the line's. 127 when nothing
# provides it. Interactive shells only; KW_AUTO_APT=0 turns it off.

# unkernel: install missing commands.
case $- in *i*)
command_not_found_handle() {
	if [ "${KW_AUTO_APT:-1}" = 0 ]; then
		echo "bash: $1: command not found" >&2
		return 127
	fi
	/usr/local/sbin/kw-apt-install "$1" || return 127
	"$@"
}
;; esac
