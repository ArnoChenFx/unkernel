# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# ~/.bashrc of the Omarchy image: the interactive shell, with the tools of the
# image wired in (fzf, zoxide, starship; the aliases for eza and bat).

case $- in
*i*) ;;
*) return ;;
esac

HISTCONTROL=ignoreboth:erasedups
HISTSIZE=50000
HISTFILESIZE=100000
shopt -s histappend checkwinsize cdspell globstar 2>/dev/null

export EDITOR=nvim VISUAL=nvim PAGER=less LESS=-FRX
export FZF_DEFAULT_OPTS="--height=40% --layout=reverse --border=rounded --info=inline --color=bg:#1a1b26,bg+:#283457,fg:#c0caf5,fg+:#c0caf5,hl:#7aa2f7,hl+:#7dcfff,pointer:#bb9af7,prompt:#7dcfff,info:#7dcfff,header:#7aa2f7,marker:#9ece6a,spinner:#bb9af7"
export FZF_CTRL_T_OPTS="--preview 'bat --color=always --style=plain --line-range=:200 {}'"
export FZF_ALT_C_OPTS="--preview 'eza --tree --level=1 --color=always {}'"

if [ -r /usr/share/bash-completion/bash_completion ]; then
	. /usr/share/bash-completion/bash_completion
fi

alias ls='eza --group-directories-first'
alias ll='eza -lh --group-directories-first --git'
alias la='eza -lah --group-directories-first --git'
alias tree='eza --tree'
alias cat='bat --paging=never --style=plain'
alias v=nvim
alias lg=lazygit
alias top=btop
alias ..='cd ..'
alias ...='cd ../..'

command -v fzf >/dev/null && eval "$(fzf --bash)"
command -v starship >/dev/null && eval "$(starship init bash)"
# Last: zoxide's hook must follow starship's, which sets PROMPT_COMMAND.
command -v zoxide >/dev/null && eval "$(zoxide init bash)"
