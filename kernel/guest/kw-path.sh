# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa
# /etc/profile.d/kw-path.sh: ~/.local/bin first on PATH, for per-user
# programs (pip --user, npm prefixes, the fx, claude and opencode installers'
# place, and the page's stand-ins for them, web/src/shims.ts). Alpine's
# /etc/profile sets a fixed PATH, and profile.d runs after it (and after
# kw-home.sh, which sets HOME for the console). The image installs this file
# (alpine.sh, alpine-disk.sh), and the page writes the same text when it is
# missing. kwtty gives programs it starts directly the same PATH (kwtty.c).
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH=$HOME/.local/bin:$PATH ;; esac
export PATH
