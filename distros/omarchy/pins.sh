# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# Pinned inputs of the Omarchy image (build.sh), sourced. The base is the
# Debian image's (guest/distro/debian/pins.sh: the pinned trixie-slim root,
# the package lists of its snapshot date, the wland relay), so the two
# images move together; what is pinned here is the package set on top.
# OMARCHY_PACKAGES is installed in the image's own apt with no recommends
# (build.sh joins it with spaces); adding one is adding its name here.
# Sizes (2026-11-23): 231 packages on the base's 78 (117.6 MiB of .deb files,
# 522.1 MiB installed by them), omarchy.erofs 198.1 MiB.

. "$(dirname "${BASH_SOURCE[0]}")/../../guest/distro/debian/pins.sh"

OMARCHY_PACKAGES=(
	# the base of every image (guest/distro/debian/build.sh), minus htop (btop)
	curl ca-certificates unzip procps less vim-tiny xz-utils zstd iproute2 sudo libatomic1 sysv-rc
	# the desktop: sway on the display's DRM device, seatd for its seat, udev for the
	# input devices' properties (libinput; the standalone sysusers keeps systemd out),
	# Xwayland for X11 apps
	sway seatd udev systemd-standalone-sysusers xwayland dbus-daemon dmz-cursor-theme
	# screenshots, clipboard, outputs, notifications, lock, the display font
	grim slurp wl-clipboard wlr-randr wayland-utils libnotify-bin mako-notifier swaylock
	foot foot-terminfo fuzzel fonts-jetbrains-mono
	# the terminal: shell completion, prompt, search, files, git, editor, monitor
	bash-completion starship zoxide fzf ripgrep fd-find bat eza jq
	tmux neovim git lazygit btop
)
