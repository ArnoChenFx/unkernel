// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// /distros/<name>-<hash>.erofs on the built Node server: the images
// vite.config.ts copies into the output's public/distros/ after Nitro has
// built it, so that Nitro neither compresses them nor lists them as its own
// static assets (its static handler would send a precompressed variant, and
// its types say text/plain). Answered with server/range.ts's single-range
// logic (immutable: the name holds the content's hash). On Vercel the CDN
// serves those files itself (static/distros/), and this handler only sees
// names that are not there (404).
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { defineHandler } from "nitro";
import { distroReply, imageFile } from "./range.ts";

/** The output's public/distros/: next to server/, whose index.mjs Nitro records as __nitro_main__. */
function imageDir(): string {
	const main = (globalThis as { __nitro_main__?: string }).__nitro_main__;
	return main ? fileURLToPath(new URL("../public/distros/", main)) : "";
}

export default defineHandler((event) => {
	let name = event.url.pathname.slice("/distros/".length);
	try { name = decodeURIComponent(name); } catch {}
	const r = distroReply(imageFile(imageDir(), name), name, event.req.method, (h) => event.req.headers.get(h));
	const body = typeof r.body === "string" ? r.body
		: r.body ? (Readable.toWeb(createReadStream(r.body.file, { start: r.body.start, end: r.body.end })) as ReadableStream<Uint8Array>)
		: null;
	return new Response(body, { status: r.status, headers: r.headers });
});
