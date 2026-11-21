# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /etc/profile.d/kw-gl.sh (the kw layer, every distro): with guest GL on
# (kw.gl=1 on the kernel command line, which the page adds with its GL
# option; .agents/gl.md), Mesa renders through the host's WebGL2: its virgl
# driver over vtest (GALLIUM_DRIVER=virpipe; LIBGL_ALWAYS_SOFTWARE=1 makes
# GLX and EGL take Mesa's software path, where GALLIUM_DRIVER picks the
# driver) to /tmp/.virgl_test, the socket of /usr/lib/kw/vtest-bridge.
# Mesa itself is not in the images (apt-get install mesa-utils ...).
# `GALLIUM_DRIVER=llvmpipe cmd` runs one program on llvmpipe instead.
# Shell builtins only: every shell start reads this.

if [ -r /proc/cmdline ]; then
	read -r _kw_cmdline < /proc/cmdline || :
	case " $_kw_cmdline " in
	*" kw.gl=1 "*) export GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 ;;
	esac
	unset _kw_cmdline
fi
