// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// mpv: the media player as a window on the page's Wayland desktop, set up
// for guest VA-API (.agents/va.md): the host decodes with WebCodecs and
// draws each picture into the surface the page's compositor shows, so no
// video pixels pass through guest memory (Debian). mpv.sh plays the files
// or URLs it is given, or a sample it fetches once. mpv.conf is what makes
// it fast here:
// - hwdec=vaapi with vo=dmabuf-wayland: the decoder's surface goes to the
//   compositor as a dmabuf (vo=gpu draws through guest GL, far slower);
// - video-sync=desync: mpv otherwise drops video frames to follow the
//   guest's audio clock (a 30 fps clip played at about 24, M4 Pro,
//   2026-11-25);
// - the builtin Lua scripts off: about 1.3 s of start-up and 0.8-1.4 ms a
//   frame (i7-10700K, 2026-11-25). That includes the on-screen controller:
//   the keys still work (space, arrows, m, f, q); osc=yes brings it back;
// - ao=alsa: the guest's card, without probing PipeWire first.
import type { TerminalApp } from "../types.ts";

const CONF = `# mpv on guest VA-API: see mpv.sh. Edit freely; mpv.sh reads only this file.
hwdec=vaapi
vo=dmabuf-wayland
video-sync=desync
ao=alsa
# The builtin scripts: start-up time, and work on every frame.
osc=no
ytdl=no
load-console=no
load-stats-overlay=no
load-select=no
load-commands=no
load-positioning=no
load-auto-profiles=no
`;

const SAMPLE = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4";

const MPV = String.raw`#!/bin/sh
# mpv with hardware decode through VA-API, in a window on the page.
#   ./mpv.sh [mpv options] [FILE or URL ...]
# Without a file it plays a sample (Big Buck Bunny, 1080p H.264), in a loop.
# Only mpv.conf here is read (--no-config), not ~/.config/mpv.
here=$(dirname "$(readlink -f "$0")")
conf="--no-config --include=$here/mpv.conf"
for a; do
	case $a in -*) ;; *) exec mpv $conf "$@" ;; esac
done
sample=$here/${SAMPLE.slice(SAMPLE.lastIndexOf("/") + 1)}
if [ ! -s "$sample" ]; then
	echo "Fetching the sample (5 MB)..."
	curl -fL --retry 2 -o "$sample.part" "${SAMPLE}" && mv "$sample.part" "$sample" || {
		echo "Could not fetch the sample (is the network up?). Play a file of your own: ./mpv.sh FILE"
		exit 1
	}
fi
echo "space pauses, arrows seek, m mutes, f is full screen, q quits."
exec mpv $conf --loop-file=inf "$@" "$sample"
`;

export default {
	id: "mpv",
	title: "mpv",
	desc: "The mpv media player with hardware video decode (VA-API on the browser's WebCodecs), in a window on the page",
	// A play triangle in a ring.
	icon: { svg: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6ZM10 8l6.5 4-6.5 4Z"/>' },
	colors: ["#8b5cf6", "#2e1065"],
	needs: { net: true, sound: true, wayland: true },
	packages: { debian: ["mpv", "curl"] },
	files: { "mpv.conf": CONF, "mpv.sh": { content: MPV, mode: 0o755 } },
	commands: ["./mpv.sh"],
} satisfies TerminalApp;
