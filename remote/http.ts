// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote backend's HTTP rules that do not need Bun: which requests may
// reach the backend (sameSiteGuard), the addresses it answers to, and the
// page's remote flag. server.ts serves them with Bun; the tests check them
// under Node.

/** The Host and the Origin this backend answers to on `port`: 127.0.0.1 or localhost. */
export function localNames(port: number): { hosts: Set<string>; origins: Set<string> } {
	return {
		hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
		origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
	};
}

/**
 * Which requests may reach the backend: its own Host, and when they carry
 * them, its own Origin and a same-site Sec-Fetch-Site ("none" is the address
 * bar). Applies to every request, the WebSocket upgrade included.
 */
export function sameSiteGuard(port: number): (req: Request) => Response | null {
	const { hosts, origins } = localNames(port);
	return (req) => {
		if (!hosts.has(req.headers.get("host") ?? "")) return new Response("forbidden: not this backend's address", { status: 403 });
		const reqOrigin = req.headers.get("origin");
		if (reqOrigin !== null && !origins.has(reqOrigin)) return new Response("forbidden: cross-origin request", { status: 403 });
		const site = req.headers.get("sec-fetch-site");
		if (site !== null && site !== "same-origin" && site !== "none") return new Response("forbidden: cross-site request", { status: 403 });
		return null;
	};
}

/** The page's HTML with the remote flag: this backend's page runs its kernel here by default. */
export function withRemoteFlag(html: string): string {
	const tag = '<meta name="unkernel-remote" content="1" />';
	return /<head[\s>]/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${tag}`) : `${tag}\n${html}`;
}
