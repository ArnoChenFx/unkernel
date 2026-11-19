# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Command not found (e.g. node, htop): install whatever provides it with
# `apk add cmd:NAME` (in gray) when there is a network, then run it. Alpine's
# busybox ash calls command_not_found_handle with the name only, so the
# arguments come from the history line, and only for a simple line (no ; & |
# < > ` $(): re-running a compound line would repeat its other parts. The
# exit status is 127 either way (ash sets it after the hook). Interactive
# shells only; KW_AUTO_APK=0 turns it off.
#
# For a user who cannot write apk's database (not root), with sudo: apk
# typed at the prompt runs as `sudo apk ...` (an alias: only the first word
# of a line is one, so `sudo apk` stays as typed, and `\apk` or `command
# apk` is the real one). Scripts get no aliases.
#
# The hook must not fork subshells: in busybox 1.37 a $(...) or pipeline
# child forked inside command_not_found_handle does not exit at its end but
# unwinds into the interactive loop, which then reads the next lines with
# stdout on the pipe. So the work is in a separate script (/etc/kw-apk-install),
# and the hook uses builtins and plain external commands only.

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
if [ ! -w /lib/apk/db ] && command -v sudo >/dev/null; then
	alias apk='sudo apk'
fi
;; esac
