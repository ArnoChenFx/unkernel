# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa
# /etc/profile.d/kw-path.sh (the kw layer, every distro): ~/.local/bin first
# on PATH, for per-user programs (pip --user, npm prefixes, the fx, claude
# and opencode installers' place), and /usr/lib/kw/bin last, for the
# shims that install fx, claude, opencode, node and bun on first use
# (/usr/lib/kw/shim),
# so anything else of those names wins. A distro's /etc/profile sets a
# fixed PATH, and profile.d runs after it (and on Alpine after kw-home.sh,
# which sets HOME for the console). kwtty gives programs it starts directly
# the same PATH (kwtty.c).

case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH=$HOME/.local/bin:$PATH ;; esac
case ":$PATH:" in *":/usr/lib/kw/bin:"*) ;; *) PATH=$PATH:/usr/lib/kw/bin ;; esac
export PATH
