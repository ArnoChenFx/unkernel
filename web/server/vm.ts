// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// /vm/** on the server: what a guest preview URL gets when the preview's
// service worker (public/vm-sw.js) does not answer it, e.g. after a
// shift-reload (which bypasses service workers), in another browser, or
// before the worker was installed. A short page saying why, not the app,
// which would boot a second kernel. The route rules in vite.config.ts add
// COOP and COEP, so it also loads in the page's iframe.
import { defineHandler } from "nitro";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><title>unkernel preview</title>
<style>body{font:14px/1.5 ui-monospace,monospace;max-width:40rem;margin:2rem auto;padding:0 1rem}</style></head>
<body><h1 style="font-size:1rem">This is a preview of a server in an unkernel guest</h1>
<p>/vm/&lt;id&gt;/&lt;port&gt;/ is answered by the unkernel page that runs that kernel, through its service worker, in this browser.
This request reached the server instead: a shift-reload skips the service worker, and the page that started the preview may be closed
or reloaded (each boot gets a new id).</p>
<p>Reload normally, or open the preview again from the page (Ctrl-A p, or System, Preview).
<a href="/" rel="noreferrer">Open unkernel</a></p></body></html>
`;

export default defineHandler(() => new Response(PAGE, {
	status: 503,
	headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
}));
