// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's `open` and `xdg-open`: host commands (js/core/commands.ts)
// that boot.ts adds, so a program in the guest that opens a URL in "the
// browser" (a dev server's address, a login link) reaches this page. A URL
// on the guest's own address (localhost, 127.x, 0.0.0.0, [::1], 10.0.2.15)
// opens in the preview (preview.ts: plain http only), any other http(s) URL
// in a new tab (noopener, noreferrer). The guest is untrusted: every request
// asks first in the confirm dialog with the full URL, one at a time, and
// nothing opens without the user's click; there is no way to skip that.
// No imports at run time, so web/test/open.test.ts runs it without a DOM.
import type { HostCommandContext } from "./sdk.ts";

/** What a URL the guest asks to open is. */
export type OpenTarget =
	/** The guest's own server: the preview on `port`, at `path` (with the query and fragment). */
	| { kind: "preview"; url: string; port: number; path: string }
	/** Anywhere else: a new tab. */
	| { kind: "tab"; url: string; host: string }
	/** Not opened; `msg` says why. */
	| { kind: "refused"; msg: string };

/** Host names that are the guest itself: its loopback, and its address on the virtual network (js/core/net.ts). */
const GUEST_HOST = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10\.0\.2\.15)$/;

/** The arguments of `open URL` or `xdg-open URL` (a leading `--` is ignored; no other option). */
export function parseOpen(args: readonly string[]): OpenTarget {
	const rest = args[0] === "--" ? args.slice(1) : args;
	const arg = rest[0];
	if (arg === undefined) return { kind: "refused", msg: "usage: open URL (an http or https URL)" };
	if (rest === args && arg.startsWith("-")) return { kind: "refused", msg: `${arg}: no options here, only open URL` };
	if (rest.length > 1) return { kind: "refused", msg: "one URL at a time" };
	let u: URL;
	try { u = new URL(arg); } catch { return { kind: "refused", msg: `not a URL: ${arg}` }; }
	if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "refused", msg: `only http and https URLs open here, not ${u.protocol}` };
	if (u.username || u.password) return { kind: "refused", msg: "a URL with a user name or password is not opened" };
	if (GUEST_HOST.test(u.hostname.replace(/\.$/, ""))) {
		if (u.protocol !== "http:") return { kind: "refused", msg: `the preview reaches the guest's servers over plain http only: ${u.href}` };
		return { kind: "preview", url: u.href, port: u.port ? Number(u.port) : 80, path: u.pathname + u.search + u.hash };
	}
	return { kind: "tab", url: u.href, host: u.hostname };
}

/** A question for the confirm dialog (ui.ask()), from the guest. */
export interface OpenAsk { title: string; msg: string; ok: string; url: string; untrusted: true }

/** What the command needs of the page (boot.ts). */
export interface OpenDeps {
	/** Ask in the confirm dialog: true for OK. */
	ask(q: OpenAsk): Promise<boolean>;
	/** Cancel the open question (the one ask() shows). */
	dismiss(): void;
	/** The preview works here (a secure context: preview.ts previewSupported()). */
	previewSupported(): boolean;
	/** Show the guest's port at path in the preview. */
	preview(port: number, path: string): void;
	/** Open url in a new tab (noopener, noreferrer). */
	tab(url: string): void;
}

/** The handler of `open` and `xdg-open`: 0 once the user confirmed and it opened, else 1 with a line on stderr. */
export function openCommand(deps: OpenDeps): (ctx: Pick<HostCommandContext, "name" | "args" | "signal" | "stderr">) => Promise<number> {
	// One question at a time: each request waits for the ones before it.
	let turn = Promise.resolve();
	return async (ctx) => {
		const fail = async (msg: string) => {
			const w = ctx.stderr.getWriter();
			try { await w.write(`${ctx.name}: ${msg}\n`); } catch { /* the guest process is gone */ } finally { w.releaseLock(); }
			return 1;
		};
		const t = parseOpen(ctx.args);
		if (t.kind === "refused") return fail(t.msg);
		if (t.kind === "preview" && !deps.previewSupported()) return fail("the preview needs the page on https or localhost (it runs on a service worker)");
		const before = turn;
		let done = () => {};
		turn = new Promise((r) => { done = r; });
		try {
			await before;
			if (ctx.signal.aborted) return 1;
			let asking = true;
			const gone = () => { if (asking) deps.dismiss(); };
			ctx.signal.addEventListener("abort", gone, { once: true });
			let ok: boolean;
			try {
				ok = await deps.ask(t.kind === "preview"
					? { title: "open in the preview", msg: `A program in the guest asks to show its port ${t.port} in the preview:`, ok: "Open", url: t.url, untrusted: true }
					: { title: `open ${t.host}`, msg: `A program in the guest asks to open a page on ${t.host} in a new tab:`, ok: "Open tab", url: t.url, untrusted: true });
			} finally {
				asking = false;
				ctx.signal.removeEventListener("abort", gone);
			}
			if (!ok || ctx.signal.aborted) return fail("cancelled");
			// Still in the OK click's task, so a popup blocker lets the tab open.
			if (t.kind === "preview") deps.preview(t.port, t.path);
			else deps.tab(t.url);
			return 0;
		} finally {
			done();
		}
	};
}
