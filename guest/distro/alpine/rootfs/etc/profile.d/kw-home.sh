# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Home: busybox init starts the console shell (no login) with HOME=/ in /,
# so give root its home (/root, as in /etc/passwd) and start there, as login
# would.

if [ "$HOME" = / ] && [ "$(id -u)" = 0 ] && [ -d /root ]; then
	export HOME=/root
	[ "$PWD" = / ] && cd /root
fi
