// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's configuration, from its URL. The kernel is always the page's
// own unkernel-alpine.wasm (sdk.ts), with Alpine bundled. Each parameter
// except ?simulate, ?demo and ?showcase has a control under Options in the status panel
// (ui.ts), which rebuilds the URL on Reboot (keeping the others).
//
//   ?mem=MiB                           kernel memory (default: auto, from the SDK's autoMemoryMiB():
//                                      256 on phones, 512 otherwise, less on low-memory devices)
//   ?append=<cmdline>                  kernel command line
//   ?net=0                             no network device (else: the Wisp server(s), default:
//                                      the project's)
//   ?wisp=<url>[,<url>...] | ?wisp=0   Wisp servers to race (0 = no network device)
//   ?jit=0                             kwemu interprets only (default: its JIT tier compiles hot
//                                      guest code to WebAssembly; counters in KW.jitStats())
//   ?verbose=1                         write every kernel message to the terminal, in gray
//                                      (default: kernel messages go to the Kernel log tab, and
//                                      during boot the newest one shows on the transient line)
//   ?data=0                            no data disk. By default (when IndexedDB exists) the data
//                                      disk, an ext4 fs labelled kwdata, is attached as /dev/wda
//                                      and kept in IndexedDB (data.ts); the guest's root is an
//                                      overlay whose changes live on it. Its template is the
//                                      kernel bundle's section unkernel.datadisk. One tab at a
//                                      time: another tab gets an unsaved in-memory copy.
//                                      KW.exportData(), KW.importData(file), KW.resetData() (also
//                                      buttons in the panel). Hiding or leaving the page and
//                                      Reboot ask the guest to sync first (KW.sync(), the SDK's
//                                      sync()).
//   ?display=0                         no display. By default the guest gets /dev/fb0 (kwfb,
//                                      640x480), and a canvas over the terminal shows it while a
//                                      program has it open (try `glimmer`). Nothing is
//                                      allocated until then.
//   ?sound=0                           no sound card. By default the guest gets ALSA hw:0,0 and
//                                      /dev/dsp (kwsnd, playback), played with Web Audio
//                                      (audio.ts; try `glimmer`). Nothing runs until a program
//                                      plays; the first tap or key press after that unmutes.
//   ?root=initramfs                   safe mode for this boot (kw.root=initramfs): the plain
//                                      image root instead of the overlay root; /data stays
//                                      mounted (the panel's Safe mode button; kernel/README.md)
//   ?worker=1                          experimental: run the kernel in a Web Worker (the SDK's
//                                      createKernel({ worker: true })), so it never blocks the
//                                      page. The data disk and the Wisp network are built in the
//                                      worker from specs; the display, input devices and sound
//                                      work as on the page's thread. Console and evdev input and
//                                      frames go through shared memory when the page is
//                                      cross-origin isolated (https or localhost; a plain-http
//                                      LAN page has no SharedArrayBuffer), else as messages,
//                                      which wait up to 20 ms while the guest is busy. Default:
//                                      on the page's thread.
//   ?shared=0                          with ?worker=1: messages even where shared memory works
//                                      (to compare the two)
//   ?fx (or ?fx=1)                     start fx, the coding agent, in its side panel once the
//                                      page passes its preflight (fx.ts; the status line's fx
//                                      button does the same later). ?fx=0 is off, as is no ?fx.
//   ?demo=<id>                         launch that demo once the guest is up (launcher.ts). The
//                                      launcher sets it on each launch, so a reload reopens the
//                                      last demo, and closing its window removes it; read
//                                      there, not here. ?demo=- runs the showcase.
//   ?showcase[=warm,<step>,...]        a fast scripted tour of the demos with captions; warm
//                                      pre-installs them, step ids pick a subset (showcase.ts);
//                                      read in launcher.ts
//   ?simulate=nojspi,oom,lowmem        fake a failure (for tests)
import { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB, kernelUrl } from "./sdk.ts";

/** The project's source, linked from About and the boot notes. */
export const REPO = "https://github.com/pithings/unkernel";

/** The command line without ?append=. */
export const DEFAULT_CMDLINE = "console=hvc0 rdinit=/init";

export interface Config {
	kernelUrl: string;
	memMiB: number;
	memWhy: string;
	/** What auto would pick on this device, even when ?mem= is given. */
	memAutoMiB: number;
	/** ?mem= as given, or null for auto. */
	memParam: string | null;
	memFallbackMiB: number[];
	cmdline: string;
	/** The command line as ?append= sets it (cmdline without kw.root=). */
	baseCmdline: string;
	/** ?append= or ?root= was given (the command line is shown only then). */
	cmdlineGiven: boolean;
	/** The guest network device (?net=0 or ?wisp=0 removes it). */
	net: boolean;
	/** ?wisp= servers, or null for the SDK's DEFAULT_WISP_SERVERS. */
	wisp: string[] | null;
	/** kwemu's JIT tier (?jit=0 turns it off). */
	jit: boolean;
	/** A display, /dev/fb0 (on unless ?display=0). */
	display: boolean;
	/** A sound card, played with Web Audio (on unless ?sound=0). */
	sound: boolean;
	/** Attach the data disk (?data=0 turns it off). */
	data: boolean;
	/** ?root=initramfs: safe mode (kw.root=initramfs) for this boot, else null. */
	root: "initramfs" | null;
	/** ?worker=1: the kernel runs in a Web Worker (with the data disk, network, display, input and sound). */
	worker: boolean;
	/** Worker mode: shared memory for input and frames where it works (?shared=0: messages). */
	shared: boolean;
	/** ?fx: start fx (fx.ts) in its panel at load. */
	fx: boolean;
	verbose: boolean;
	simulate: string[];
	/** A touch device or a mobile user agent. */
	mobile: boolean;
	coarse: boolean;
	mobileUA: boolean;
	fontSize: number;
}

export function readConfig(search: string = location.search): Config {
	const params = new URLSearchParams(search);
	const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	const mobileUA = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
	const mobile = coarse || mobileUA;
	const memParam = params.get("mem");
	const auto = autoMemoryMiB({ mobile });
	const fixed = memParam !== null && Number(memParam) > 0;
	const append = params.get("append");
	const root = params.get("root") === "initramfs" ? "initramfs" : null;
	const wispParam = params.get("wisp");
	const wisp = wispParam && wispParam !== "0" ? wispParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
	return {
		kernelUrl: kernelUrl.pathname,
		memMiB: fixed ? Number(memParam) : auto.mib,
		memWhy: fixed ? `?mem=${memParam}` : auto.why,
		memAutoMiB: auto.mib,
		memParam: fixed ? memParam : null,
		memFallbackMiB: [...DEFAULT_MEMORY_FALLBACK_MIB],
		cmdline: root ? `${append || DEFAULT_CMDLINE} kw.root=${root}` : append || DEFAULT_CMDLINE,
		baseCmdline: append || DEFAULT_CMDLINE,
		cmdlineGiven: !!append || !!root,
		net: params.get("net") !== "0" && wispParam !== "0",
		wisp: wisp?.length ? wisp : null,
		jit: params.get("jit") !== "0",
		display: params.get("display") !== "0",
		sound: params.get("sound") !== "0",
		data: params.get("data") !== "0",
		root,
		worker: params.get("worker") === "1",
		shared: params.get("shared") !== "0",
		fx: params.has("fx") && params.get("fx") !== "0",
		verbose: params.get("verbose") === "1",
		simulate: (params.get("simulate") || "").split(",").filter(Boolean),
		mobile,
		coarse,
		mobileUA,
		fontSize: 14,
	};
}
