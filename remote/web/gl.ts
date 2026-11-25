// SPDX-License-Identifier: MIT
// Copyright (C) 2026 ARNO <arnochen101@gmail.com>
// Guest GL in remote mode, opt-in (?gl=1; remote/README.md, Guest GL): the
// parts the two remote pages share that touch neither the DOM nor the SDK, so
// that node --test can check them (remote/test/gl.test.ts). The renderer is
// the page's (virgl on its WebGL2 context: js/core/gl.ts, gl-gpu.ts). What the
// page says about it names the WebGL2 implementation, and says "software"
// where that is a software rasterizer: SwiftShader is no GPU, whatever the
// guest's renderer reports.

/** Whether the page's query asks for guest GL (?gl=1). Anything else keeps the CPU path. */
export function glAsked(search: string): boolean {
	return new URLSearchParams(search).get("gl") === "1";
}

/** The software rasterizer a WebGL2 implementation's name gives away, or null. */
export function softwareName(webgl: string | null | undefined): string | null {
	const m = webgl ? /swiftshader|llvmpipe|softpipe|software rasteri[sz]er|basic render driver/i.exec(webgl) : null;
	return m ? m[0] : null;
}

/** The renderer's state, as js/core/gl.ts GlRendererStatus gives it (the fields the note reads). */
export interface GlStateView {
	state: "idle" | "loading" | "ready" | "lost" | "failed";
	webgl: string | null;
	error: string | null;
}

/**
 * The note for the page while guest GL is asked for: the renderer's state,
 * and the WebGL2 implementation once there is one, with "software" where it
 * is one. `why` is the reason there is no renderer at all (no view). Null
 * when guest GL was not asked for.
 */
export function glNote(asked: boolean, view: GlStateView | null, why: string | null): string | null {
	if (!asked) return null;
	if (!view) return `guest GL off: ${why ?? "no renderer"}`;
	switch (view.state) {
		case "failed":
			return `guest GL off: ${view.error ?? "the renderer failed"}`;
		case "idle":
			return "guest GL: the renderer loads on the guest's first GL use";
		case "loading":
			return "guest GL: loading the renderer";
		case "lost":
			return `guest GL: the WebGL2 context was lost; the next GL use makes a new one${view.error ? ` (${view.error})` : ""}`;
		case "ready": {
			const sw = softwareName(view.webgl);
			const webgl = view.webgl ? `, ${view.webgl}` : "";
			return sw ? `guest GL: virgl on WebGL2${webgl}: software (${sw}), not a GPU` : `guest GL: virgl on WebGL2${webgl}`;
		}
	}
}
