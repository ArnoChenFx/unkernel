// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fx (fx.sh, Vercel Labs' coding agent) in a side panel of the page, working
// on the running VM. The status line's fx button and Ctrl-A f open it, then
// hide and show it (toggleFx()); the panel's [×] stops it (closeFx()); ?fx
// opens it at load (config.ts, main.tsx). This
// is the fx terminal from libfx (Apache-2.0), fx-term.wasm under JSPI on the
// page's thread, not the x86_64 binary of the fx demo (demos/fx.ts).
//
// - The panel (components/Fx.tsx) is docked right of the stage on wide
//   screens and covers the stage on narrow ones, like the preview. It has
//   its own wterm, outside #terms: it is no terminal window, so display.ts
//   never routes its keys to the guest. The fx TUI draws into it through an
//   FxTerminalAdapter and its size follows the panel. Hidden, fx keeps
//   running; fx exiting (/exit, Ctrl-D) closes the panel. The conversation
//   lives in page memory, so a reload ends it.
// - Its one tool, shell.run, is the workspace below: each command is
//   `/bin/sh -lc <command>` through vm.exec() as root in /root, killed when
//   fx's deadline (at most 30 s, fx's own limit) passes or on Ctrl-C.
//   Commands wait for user space (KW.ready). permission "allow-sandboxed":
//   the VM is the sandbox, so fx does not ask before each command.
// - AGENTS.md: fx reads /root/AGENTS.md through readFile(); the guest's
//   own file wins, else it gets INSTRUCTIONS, which tell it where it runs.
// - Sign-in: /login inside fx (Vercel device login, the URL opens in a new
//   tab). Its OAuth session, fx's settings (configStore) and prompt history
//   are kept only in this module's memory: not in storage, not on window or
//   KW, so other scripts cannot read them (a preview iframe gets its own
//   module instance). They outlast closing the panel, not a reload. Model
//   requests go from the page to AI Gateway with fetch() (CORS), which
//   cross-origin isolation allows. vercel.com sends its OAuth discovery
//   document without CORS headers, so fxFetch() falls back to a copy of it
//   (VERCEL_DISCOVERY); without it the sign-in fails in a browser and fx
//   offers API key entry, which its wasm build does not have.
// - Keys: wterm sends what a terminal sends; Shift-Enter (a new line in the
//   composer) and ⌘ with arrows or Backspace become fx's own sequences
//   (encodeXtermKeyEvent), as libfx's xterm adapter does.
// - libfx and fx-term.wasm (4 MB) load on first use, as their own chunk and
//   asset.
import type { WTerm } from "@wterm/dom";
import type { FxTerminal, FxTerminalAdapter, FxWorkspace } from "libfx/browser";
import { KW } from "./kw.ts";
import { PtyError, type KernelHandle } from "./sdk.ts";
import { ui$ } from "./store.ts";

/** fx's workspace root, cwd and home: root's home in the guest. */
const ROOT = "/root";
/** The most a command's stdout or stderr may hold before it is killed (fx keeps 64 KiB of the two). */
const MAX_BUFFER = 8 << 20;

const INSTRUCTIONS = `# Where you run

You run inside the unkernel web page. Your shell tool runs commands in the
page's virtual machine: Linux on WebAssembly with Alpine Linux (aarch64,
musl, busybox) as user space, as root, in ${ROOT}. The user sees the same
machine in the page's other terminal windows.

- Each command runs in a fresh \`/bin/sh -lc\` and must finish within your
  tool's time limit (30 s at most). Start longer work in the background
  (\`nohup cmd > /tmp/cmd.log 2>&1 &\`) and check on it.
- The CPU is emulated (an aarch64 interpreter, in the browser),
  so builds and installs are slow. Prefer prebuilt packages.
- Install software with \`apk add <package>\`; run \`/etc/kw-apk-enable\`
  first to enable the community repository. The network, when the page has
  one, is outbound TCP over the page's proxy: no inbound connections, no IPv6.
- The page can show a web server running in the machine: start it on a
  port (say 8000, listening on 0.0.0.0) and tell the user to open the
  preview (Ctrl-A p, or the globe in the status line).
- With the page's data disk on, the root file system is an overlay kept in
  the browser, so files survive a reload; without it, they do not.
`;

/**
 * The fields of Vercel's OAuth discovery document fx reads, as served on
 * 2026-11-16. The endpoints themselves (api.vercel.com) send CORS headers;
 * the document (vercel.com) does not, so a browser cannot read it.
 */
const VERCEL_DISCOVERY_URL = "https://vercel.com/.well-known/openid-configuration";
const VERCEL_DISCOVERY = {
	issuer: "https://vercel.com",
	device_authorization_endpoint: "https://api.vercel.com/login/oauth/device-authorization",
	token_endpoint: "https://api.vercel.com/login/oauth/token",
	revocation_endpoint: "https://api.vercel.com/login/oauth/token/revoke",
};

/** fx's fetch: the real discovery document if the browser can read it (Vercel may add CORS), else VERCEL_DISCOVERY. */
async function fxFetch(input: string, init: RequestInit): Promise<Response> {
	if (input !== VERCEL_DISCOVERY_URL) return fetch(input, init);
	try {
		return await fetch(input, init);
	} catch (e) {
		if (init.signal?.aborted) throw e;
		return Response.json(VERCEL_DISCOVERY);
	}
}

/** Open a URL fx asks for (the sign-in page) in a new tab; false when the browser blocked it, and fx shows it instead. */
function openUrl(url: string): boolean {
	const w = window.open(url, "_blank");
	if (w) w.opener = null;
	return !!w;
}

// An earlier build kept these in localStorage (kw.fx.*): remove them, the sign-in among them.
try {
	for (const k of Object.keys(localStorage)) if (k.startsWith("kw.fx.")) localStorage.removeItem(k);
} catch {}

const conflict = () => Object.assign(new Error("the fx sign-in changed meanwhile"), { code: "FX_OAUTH_SESSION_REVISION_CONFLICT" });

/** fx's sign-in, in memory only: bytes with a revision, compared before each change. */
let oauth: { bytes: Uint8Array; revision: string } | null = null, oauthRev = 0;
const oauthSessionStore = {
	load: () => (oauth ? { bytes: oauth.bytes.slice(), revision: oauth.revision } : null),
	commit(bytes: Uint8Array, expected?: string): { revision: string } {
		if (expected !== oauth?.revision) throw conflict();
		oauth = { bytes: bytes.slice(), revision: String(++oauthRev) };
		return { revision: oauth.revision };
	},
	remove(expected?: string): "missing" | true {
		if (!oauth) return "missing";
		if (expected !== undefined && expected !== oauth.revision) throw conflict();
		oauth = null;
		return true;
	},
};

const config = new Map<string, string>();
const configStore = {
	get: (id: string) => config.get(id) ?? null,
	set: (id: string, v: string) => { config.set(id, v); },
};

const HISTORY_MAX = 200;
let history: string[] = [];
const promptHistoryStore = {
	load: (_root: string, limit: number) => history.slice(-limit),
	append(_root: string, value: string) { history = [...history, value].slice(-HISTORY_MAX); },
	clear() { history = []; },
};

/** The kernel once user space runs. */
function ready(): Promise<KernelHandle> {
	if (!KW.ready) throw new Error("The VM has not started yet");
	return KW.ready();
}

const workspace: FxWorkspace = {
	info: { version: 1, root: ROOT, cwd: ROOT, home: ROOT, gitAvailable: false, ephemeral: true },
	permission: "allow-sandboxed",
	async exec({ command, cwd, signal }) {
		const vm = await ready();
		try {
			const r = await vm.exec("/bin/sh", ["-lc", command], { cwd, signal, maxBuffer: MAX_BUFFER });
			return { exitCode: r.exitCode ?? 128 + (r.signal ?? 0), stdout: r.stdout, stderr: r.stderr };
		} catch (e) {
			if (e instanceof PtyError && e.code === "ENOBUFS")
				return { exitCode: 1, stdout: "", stderr: `The command printed more than ${MAX_BUFFER >> 20} MiB and was killed. Redirect large output to a file.` };
			if (signal.aborted) throw signal.reason;
			throw e;
		}
	},
	async readFile({ path, signal }) {
		const vm = await ready();
		const r = await vm.exec("/bin/cat", [path], { signal, maxBuffer: 1 << 20 }).catch(() => null);
		if (r?.exitCode === 0) return r.stdout;
		return path === `${ROOT}/AGENTS.md` ? INSTRUCTIONS : null;
	},
};

/** Keys wterm sends as a terminal would, which fx's composer wants as its own sequences. */
function keyHandler(el: HTMLElement, encode: (e: KeyboardEvent) => string | null, send: (d: string) => void): () => void {
	const down = (e: KeyboardEvent) => {
		// ⌘C and ⌘X with text selected copy and cut, as everywhere else.
		if (e.metaKey && /^[cx]$/i.test(e.key) && !!document.getSelection()?.toString()) return;
		const d = encode(e);
		if (d === null) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		send(d);
	};
	el.addEventListener("keydown", down, true);
	return () => el.removeEventListener("keydown", down, true);
}

/** The fx button and Ctrl-A f: start fx, or hide and show its panel. */
export function toggleFx(): void {
	const $ = ui$(), fx = $.get().fx;
	$.set({ fx: { shown: !fx?.shown } });
}

/** ?fx (main.tsx): start fx and show its panel. */
export function openFx(): void {
	ui$().set({ fx: { shown: true } });
}

/** Stop fx and close its panel. */
export function closeFx(): void {
	ui$().set({ fx: null });
}

export interface FxControl {
	/** The panel was shown or hidden: pause painting while hidden, focus when shown. */
	show(on: boolean, focus: boolean): void;
	setFont(px: number): void;
	/** The panel closed: stop fx. */
	dispose(): void;
}

const SGR = { gray: "\x1b[90m", red: "\x1b[1;31m", off: "\x1b[0m" };

/** Run fx in `el` (Fx.tsx, while the panel is open). wterm and libfx load here, not with the page. */
export function mountFx(el: HTMLElement): FxControl {
	let gone = false, fx: FxTerminal | null = null, term: WTerm | null = null, unkey = () => {};
	let shown = true, focus = false, font = KW.config.fontSize;
	const inputs = new Set<(d: string | Uint8Array) => void>(), resizes = new Set<() => void>();
	const send = (d: string | Uint8Array) => { for (const cb of inputs) cb(d); };
	let size = { cols: 80, rows: 24 };
	const write = (d: string | Uint8Array) => { if (!gone) term?.write(d); };
	const adapter: FxTerminalAdapter = {
		// wterm parses at once, so a view of fx's memory is fine here.
		write,
		onData(cb) { inputs.add(cb); return () => { inputs.delete(cb); }; },
		onResize(cb) { resizes.add(cb); return () => { resizes.delete(cb); }; },
		get cols() { return size.cols; },
		get rows() { return size.rows; },
	};
	void (async () => {
		const [{ WTerm }, { TERM_OPTIONS, setTermFont }] = await Promise.all([import("@wterm/dom"), import("./windows.ts")]);
		if (gone) return;
		setTermFont(el, font);
		const t = term = new WTerm(el, {
			...TERM_OPTIONS,
			onData: (d) => send(KW.ui ? KW.ui.applyCtrl(d) : d),
			onBinary: (d) => send(d),
			// Hidden (display: none) the grid collapses: keep the last real size.
			onResize: (cols, rows) => { if (cols < 8 || rows < 4) return; size = { cols, rows }; for (const cb of resizes) cb(); },
		});
		await t.init();
		if (gone) return;
		t.setRenderingPaused(!shown);
		if (shown && focus) t.focus();
		if (t.cols >= 8 && t.rows >= 4) size = { cols: t.cols, rows: t.rows };
		write(`${SGR.gray}[host] loading fx…${SGR.off}`);
		const { createFxTerminal, encodeXtermKeyEvent, supportsJspi } = await import("libfx/browser");
		if (gone) return;
		if (!supportsJspi()) throw new Error("this browser has no JSPI");
		write("\r\x1b[2K");
		const f = await createFxTerminal({
			terminal: adapter,
			workspace,
			fetch: fxFetch,
			openUrl,
			oauthSessionStore, configStore, promptHistoryStore,
			onEvent: (e) => { if (/error/.test(e.type)) KW.ui?.log(`fx: ${e.type}${e.error ? `: ${(e.error as Error)?.message ?? e.error}` : ""}`, "h"); },
		});
		if (gone) { f.abort(); return; }
		fx = f;
		unkey = keyHandler(el, encodeXtermKeyEvent, send);
		void f.exited.then(() => { if (!gone) closeFx(); });
	})().catch((e: unknown) => {
		const msg = `fx could not start: ${(e as Error)?.message ?? e}`;
		KW.ui?.log(msg, "h");
		if (term) write(`\r\n${SGR.red}[host] ${msg}${SGR.off}\r\n${SGR.gray}[host] [×] closes this panel${SGR.off}\r\n`);
		else KW.ui?.toast(msg);
	});
	return {
		show(on, f) {
			shown = on;
			focus = f;
			term?.setRenderingPaused(!on);
			if (on && f) term?.focus();
		},
		setFont(px) {
			font = px;
			// As windows.ts setTermFont(), which loads with wterm.
			el.style.setProperty("--term-font-size", `${px}px`);
			el.style.setProperty("--term-row-height", `${Math.round(px * 1.2)}px`);
		},
		dispose() {
			if (gone) return;
			gone = true;
			unkey();
			fx?.abort();
			term?.destroy();
		},
	};
}
