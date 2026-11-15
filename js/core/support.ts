// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Feature checks: can this engine run the kernel?

export interface SupportReport {
	/** Everything the default (lowered, 32-bit memory) kernel needs: WebAssembly, BigInt and working JSPI. */
	ok: boolean;
	wasm: boolean;
	bigint: boolean;
	/** WebAssembly.Suspending and WebAssembly.promising exist and a suspend/resume round trip works. */
	jspi: boolean;
	/** memory64: only the wasm64 reference kernel (vmlinux) needs it. */
	memory64: boolean;
	/** Why `ok` is false (empty when it is true). */
	problems: string[];
}

// (module (import "m" "f" (func (result i32))) (func (export "g") (result i32) call 0))
const JSPI_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 2, 7, 1, 1, 109, 1, 102, 0, 0,
	3, 2, 1, 0, 7, 5, 1, 1, 103, 0, 1, 10, 6, 1, 4, 0, 16, 0, 11]);
// (module (memory i64 0))
const MEMORY64_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]);

/** Check JSPI by suspending a tiny module on a timer and resuming it. */
export async function checkJspi(timeoutMs = 5000): Promise<{ ok: boolean; why?: string }> {
	const missing: string[] = [];
	if (typeof WebAssembly.Suspending !== "function") missing.push("WebAssembly.Suspending");
	if (typeof WebAssembly.promising !== "function") missing.push("WebAssembly.promising");
	if (missing.length) return { ok: false, why: `${missing.join(" and ")} not defined (no JSPI)` };
	try {
		const f = new WebAssembly.Suspending(() => new Promise((r) => setTimeout(() => r(42), 0)));
		const inst = new WebAssembly.Instance(new WebAssembly.Module(JSPI_TEST), { m: { f } } as unknown as WebAssembly.Imports);
		const g = WebAssembly.promising(inst.exports.g as () => unknown);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			g().then((v) => (v === 42 ? { ok: true } : { ok: false, why: `JSPI test returned ${v}` }),
				(e) => ({ ok: false, why: `JSPI test threw: ${(e as Error).message}` })),
			new Promise<{ ok: boolean; why: string }>((r) => {
				timer = setTimeout(() => r({ ok: false, why: `JSPI test did not resume within ${timeoutMs / 1000} s` }), timeoutMs);
			}),
		]);
		clearTimeout(timer);
		return result;
	} catch (e) {
		return { ok: false, why: `JSPI present but unusable: ${(e as Error).message}` };
	}
}

/** What this engine supports, and whether that is enough to boot the default kernel. */
export async function checkSupport(): Promise<SupportReport> {
	const problems: string[] = [];
	const wasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
	if (!wasm) problems.push("WebAssembly is unavailable");
	const bigint = typeof BigInt === "function";
	if (!bigint) problems.push("BigInt is required for 64-bit WebAssembly values");
	let jspi = false;
	if (wasm) {
		const j = await checkJspi();
		jspi = j.ok;
		if (!j.ok) problems.push(j.why!);
	}
	let memory64 = false;
	try { memory64 = wasm && WebAssembly.validate(MEMORY64_TEST); } catch {}
	return { ok: !problems.length, wasm, bigint, jspi, memory64, problems };
}
