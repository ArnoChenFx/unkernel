// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// X.Org on the guest's DRM device: the modesetting driver with glamor
// (the kw layer's /etc/X11/kw-kms.conf), then glxgears as a GLX client;
// both render through Mesa's virgl driver and the page's WebGL2 (Debian).
import type { Demo } from "../launcher.ts";

const START = `#!/bin/sh
# Start X on /dev/dri/card0 (modesetting + glamor), run a GLX client, and
# stop X when the client ends (Ctrl-C in this window, or Esc in glxgears).
set -e
stop() { sudo pkill -x Xorg 2>/dev/null || true; }
trap stop EXIT
trap 'exit 130' INT TERM
if [ ! -S /tmp/.X11-unix/X0 ]; then
	sudo sh -c 'Xorg :0 -config kw-kms.conf -nolisten tcp >/tmp/Xorg.kms.out 2>&1 &'
	i=0
	while [ ! -S /tmp/.X11-unix/X0 ]; do
		i=$((i + 1))
		[ $i -gt 120 ] && { echo "X did not start: /var/log/Xorg.0.log, /tmp/Xorg.kms.out"; exit 1; }
		sleep 0.5
	done
	sleep 1
fi
export DISPLAY=:0
grep -E 'glamor X acceleration|\\(EE\\) modeset' /var/log/Xorg.0.log || true
glxinfo -B | grep -E 'OpenGL renderer|OpenGL version|direct rendering' || true
echo "\${1:-glxgears}: Ctrl-C here stops it and X"
"\${@:-glxgears}"
`;

export default {
	id: "xglamor",
	title: "X + glamor",
	desc: "X.Org with the modesetting driver and glamor on /dev/dri, and glxgears on the GPU",
	icon: "X",
	colors: ["#475569", "#0f172a"],
	needs: { display: true, net: true },
	packages: { debian: ["xserver-xorg-core", "xserver-xorg-input-evdev", "libgl1-mesa-dri", "libglx-mesa0", "mesa-utils"] },
	files: {
		"start.sh": { content: START, mode: 0o755 },
		"README": "./start.sh [CLIENT ARGS...] starts X on /dev/dri/card0 with glamor\n" +
			"(Xorg :0 -config kw-kms.conf, /etc/X11/kw-kms.conf) and runs CLIENT on it,\n" +
			"glxgears by default; X stops when the client does. Try, after\n" +
			"sudo apt-get install glmark2-x11 xterm:  ./start.sh glmark2   ./start.sh xterm\n",
	},
	commands: ["cat README", "./start.sh"],
} satisfies Demo;
