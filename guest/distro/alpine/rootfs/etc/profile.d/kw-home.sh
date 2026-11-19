# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Home: a shell started with HOME=/ in / (busybox init's environment, for
# a shell an inittab line starts without kwtty login) gets its account's
# home from /etc/passwd and starts there, as login would.

if [ "$HOME" = / ]; then
	_kw_home=$(awk -F: -v id="$(id -u)" '$3 == id { print $6; exit }' /etc/passwd)
	if [ -n "$_kw_home" ] && [ -d "$_kw_home" ]; then
		export HOME=$_kw_home
		[ "$PWD" = / ] && cd "$HOME"
	fi
	unset _kw_home
fi
