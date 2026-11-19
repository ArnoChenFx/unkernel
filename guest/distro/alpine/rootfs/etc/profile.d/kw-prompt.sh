# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Prompt: a minimal take on oh-my-zsh's pygmalion theme, "dir ⇒".
# 20locale.sh (sourced first) sets LANG=C.UTF-8, so ash counts ⇒ as one
# column. ENV: busybox ash reads /usr/lib/kw/shrc (the kw-*.sh files) in
# interactive shells that are not login shells, such as `sh` typed at the
# prompt; a login shell has read them already.

PS1='\[\033[36m\]\w \[\033[35m\]⇒\[\033[0m\] '
export PS1 ENV=/usr/lib/kw/shrc
