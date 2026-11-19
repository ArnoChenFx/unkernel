# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /etc/profile.d/kw-term.sh: the console starts as "linux" (busybox init:
# vt102), without colors; the page's xterm.js and the CLI's host terminal
# are xterm-compatible.

case $TERM in linux|vt102|"") export TERM=xterm-256color ;; esac
