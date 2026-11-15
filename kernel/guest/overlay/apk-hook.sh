#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /etc/apk/commit_hooks.d/kw-overlay.hook: apk runs it before and after it
# changes the system. A marker left behind means a run was cut off, and the
# next boot cleans up after it (/usr/lib/kw-overlay/apk-cleanup). Harmless on
# a plain root, where the marker goes away with the RAM.
case $1 in
pre-commit) : > /lib/apk/db/kw-commit ;;
post-commit) rm -f /lib/apk/db/kw-commit ;;
esac
exit 0
