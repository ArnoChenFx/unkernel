# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# Pinned inputs of the Omarchy image (build.sh), sourced. The base is the
# Debian image's (guest/distro/debian/pins.sh: the pinned trixie-slim root,
# the package lists of its snapshot date, the wland relay), so the two
# images move together; what is pinned here is the package set on top, and
# the niri release (build-niri.sh: NIRI_TAG, NIRI_COMMIT).
# OMARCHY_PACKAGES is installed in the image's own apt with no recommends
# (build.sh joins it with spaces); adding one is adding its name here.
# Sizes: README.md.

. "$(dirname "${BASH_SOURCE[0]}")/../../guest/distro/debian/pins.sh"

OMARCHY_PACKAGES=(
	# the base of every image (guest/distro/debian/build.sh), minus htop (btop)
	curl ca-certificates unzip procps less vim-tiny xz-utils zstd iproute2 sudo libatomic1 sysv-rc
	# the desktop's compositor is niri (build-niri.sh, not apt). These are the
	# shared libraries it links and the ones its renderer loads: Mesa's EGL, GLES
	# and GBM (virgl when the display has it, the software rasterizer through
	# kms_swrast otherwise: rootfs/usr/local/bin/niri-session), cairo and pango
	# (its overlays), seatd for its seat, libinput, libdisplay-info, pixman and
	# xkbcommon; udev gives libinput the input devices' properties (the standalone
	# sysusers keeps systemd out); dbus for dbus-run-session and its clients;
	# mesa-utils for eglinfo
	seatd udev systemd-standalone-sysusers dbus-daemon dmz-cursor-theme
	libegl1 libegl-mesa0 libgles2 libgl1 libglx-mesa0 libgl1-mesa-dri libgbm1 mesa-utils
	libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libseat1 libinput10 libdisplay-info2 libpixman-1-0 libxkbcommon0
	# the bar (waybar: the workspaces, the focused window, the clock, cpu and
	# memory), the wallpaper, screenshots, clipboard, outputs, notifications,
	# the lock, the launcher's font
	waybar swaybg grim slurp wl-clipboard wlr-randr wayland-utils libnotify-bin mako-notifier swaylock
	foot foot-terminfo fuzzel fonts-jetbrains-mono
	# the terminal: shell completion, prompt, search, files, git, editor, monitor
	bash-completion starship zoxide fzf ripgrep fd-find bat eza jq
	tmux neovim git lazygit btop
)
