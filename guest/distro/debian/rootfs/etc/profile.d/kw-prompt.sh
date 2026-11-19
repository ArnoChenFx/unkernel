# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Prompt: a minimal take on oh-my-zsh's pygmalion theme, "dir ⇒".
# 20locale.sh (sourced first) sets LANG=C.UTF-8, so ash counts ⇒ as one
# column.

export LANG=${LANG:-C.UTF-8}
PS1='\[\033[36m\]\w \[\033[35m\]⇒\[\033[0m\] '
