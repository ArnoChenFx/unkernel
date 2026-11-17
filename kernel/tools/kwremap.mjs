// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Build side of a remapped kernel patch (kwdiff.mjs --remap): match the base
// module's functions, globals and types to the target's by name (the name
// section, which the kernel keeps: wasm-opt -g; exports for globals) or by
// signature, learn how data addresses moved from the code of matched
// functions (System.map has no data symbols for wasm), and encode the
// resulting index maps and address ranges. js/core/kremap.ts decodes and
// applies them; kwdiff.mjs runs that same code before its byte diff.
import { moduleSections, walkBody } from "../../js/core/kremap.ts";

export { applyRemap } from "../../js/core/kremap.ts";

function info(w) {
	let p;
	const uleb = () => { let v = 0, s = 1, c; do { c = w[p++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80); return v; };
	const str = () => { const n = uleb(); const r = Buffer.from(w.subarray(p, p + n)).toString(); p += n; return r; };
	const r = { types: [], funcImports: [], globalImports: [], funcNames: new Map(), globalNames: new Map(), nfuncs: 0, nglobals: 0, bodies: [], w };
	const exportedGlobals = new Map();
	for (const [id, , start, end] of moduleSections(w)) {
		p = start;
		if (id === 1) {
			const n = uleb();
			for (let i = 0; i < n; i++) {
				const s = p;
				if (w[p++] !== 0x60) throw new Error("kwremap: only function types");
				for (let k = 0; k < 2; k++) { const c = uleb(); p += c; }
				r.types.push(Buffer.from(w.subarray(s, p)).toString("hex"));
			}
		} else if (id === 2) {
			const n = uleb();
			for (let i = 0; i < n; i++) {
				const name = `${str()}.${str()}`, k = w[p++];
				if (k === 0) { uleb(); r.funcImports.push(name); } else if (k === 1) { p++; const fl = uleb(); uleb(); if (fl & 1) uleb(); }
				else if (k === 2) { const fl = uleb(); uleb(); if (fl & 1) uleb(); } else if (k === 3) { p += 2; r.globalImports.push(name); } else if (k === 4) { p++; uleb(); }
			}
		} else if (id === 3) r.nfuncs = uleb();
		else if (id === 6) r.nglobals = uleb();
		else if (id === 7) {
			const n = uleb();
			for (let i = 0; i < n; i++) { const name = str(), k = w[p++], idx = uleb(); if (k === 3) exportedGlobals.set(idx, name); }
		} else if (id === 10) {
			const n = uleb();
			for (let i = 0; i < n; i++) { const size = uleb(); r.bodies.push([p, p + size]); p += size; }
		}
		else if (id === 0) {
			if (str() !== "name") continue;
			while (p < end) {
				const sub = w[p++], size = uleb(), se = p + size;
				const target = sub === 1 ? r.funcNames : sub === 7 ? r.globalNames : undefined;
				if (target) { const n = uleb(); for (let i = 0; i < n; i++) { const idx = uleb(); target.set(idx, str()); } }
				p = se;
			}
		}
	}
	r.funcImports.forEach((n, i) => r.funcNames.set(i, `import:${n}`));
	r.globalImports.forEach((n, i) => r.globalNames.set(i, `import:${n}`));
	for (const [i, n] of exportedGlobals) if (!r.globalNames.has(i)) r.globalNames.set(i, n);
	r.nfuncs += r.funcImports.length;
	r.nglobals += r.globalImports.length;
	return r;
}

/** base index -> target index by key; an unmatched base entry gets the slot after the previous one. */
function matchBy(nBase, keyBase, nTarget, keyTarget) {
	const byKey = new Map();
	for (let i = 0; i < nTarget; i++) { const k = keyTarget(i); if (k !== undefined && !byKey.has(k)) byKey.set(k, i); }
	const m = new Int32Array(nBase), isMatch = new Uint8Array(nBase);
	let prev = -1, matched = 0;
	for (let i = 0; i < nBase; i++) {
		const k = keyBase(i), t = k === undefined ? undefined : byKey.get(k);
		if (t !== undefined) { m[i] = prev = t; matched++; isMatch[i] = 1; } else m[i] = ++prev;
	}
	return { m, matched, isMatch };
}

/** Immediates of one body: [kinds[], values[]]. */
function immediates(x, f) {
	const kinds = [], vals = [];
	const [s, e] = x.bodies[f - x.funcImports.length];
	walkBody(x.w, s, e, (kind, v) => { kinds.push(kind); vals.push(typeof v === "bigint" ? Number(v) : v); });
	return [kinds, vals];
}

/**
 * Learn what the names do not say from the code itself: walk each pair of
 * matched functions with the same immediates in the same order, and count
 * which target global each base global becomes, and which target address
 * each base address (a constant or a load/store offset at or above
 * `dataStart`) becomes. Data: points with their majority delta, merged into
 * ranges where neighbours agree.
 */
function learn(a, b, funcs, dataStart) {
	const gvotes = new Map(), dvotes = new Map();
	const vote = (m, k, v) => { let c = m.get(k); if (!c) m.set(k, (c = new Map())); c.set(v, (c.get(v) ?? 0) + 1); };
	const nimpA = a.funcImports.length;
	for (let i = nimpA; i < a.nfuncs; i++) {
		const j = funcs.m[i];
		if (!funcs.isMatch[i] || j < b.funcImports.length || j >= b.nfuncs) continue;
		const [ka, va] = immediates(a, i), [kb, vb] = immediates(b, j);
		if (ka.length !== kb.length) continue;
		let same = true;
		for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) { same = false; break; }
		if (!same) continue;
		for (let k = 0; k < ka.length; k++) {
			if (ka[k] === "global") vote(gvotes, va[k], vb[k]);
			else if ((ka[k] === "const32" || ka[k] === "const64" || ka[k] === "offset") && va[k] >= dataStart && va[k] < 0x40000000 && vb[k] >= dataStart)
				vote(dvotes, va[k], vb[k] - va[k]);
		}
	}
	const best = (c) => { let bv, bn = 0; for (const [v, n] of c) if (n > bn) { bv = v; bn = n; } return bv; };
	const globals = new Map([...gvotes].map(([g, c]) => [g, best(c)]));
	const pts = [...dvotes].map(([x, c]) => [x, best(c)]).sort((p, q) => p[0] - q[0]);
	const ranges = [];
	for (const [x, d] of pts) {
		const last = ranges.at(-1);
		if (last && last[2] === d) last[1] = x + 1;
		else ranges.push([x, x + 1, d]);
	}
	return { globals, data: ranges.filter((r) => r[2] !== 0) };
}

/** Index maps and data ranges from base to target ({ funcs, globals, types, data, stats }). */
export function remapTables(base, target, { learnData = true, dataStart = 0x10000 } = {}) {
	const a = info(base), b = info(target);
	const funcs = matchBy(a.nfuncs, (i) => a.funcNames.get(i), b.nfuncs, (i) => b.funcNames.get(i));
	const types = matchBy(a.types.length, (i) => a.types[i], b.types.length, (i) => b.types[i]);
	const learned = learn(a, b, funcs, dataStart);
	const named = matchBy(a.nglobals, (i) => a.globalNames.get(i), b.nglobals, (i) => b.globalNames.get(i));
	// Globals by name where they have one, else as the code uses them.
	const globals = Int32Array.from(named.m, (v, i) => (named.isMatch[i] || !learned.globals.has(i) ? v : learned.globals.get(i)));
	const data = learnData ? learned.data : [];
	return {
		funcs: funcs.m, globals, types: types.m, data: Float64Array.from(data.flat()),
		stats: `functions ${funcs.matched}/${a.nfuncs}, globals ${named.matched} by name + ${[...learned.globals.keys()].filter((g) => !named.isMatch[g]).length} learned/${a.nglobals}, types ${types.matched}/${a.types.length}, data ranges ${data.length}`,
	};
}

/** The tables as kremap.ts decodeRemap() reads them. */
export function encodeRemap(t) {
	const out = [];
	const uleb = (n) => { do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); };
	const zig = (n) => uleb(n < 0 ? -2 * n - 1 : 2 * n);
	for (const m of [t.funcs, t.globals, t.types]) {
		uleb(m.length);
		let prev = -1;
		for (const v of m) { zig(v - prev - 1); prev = v; }
	}
	uleb(t.data.length / 3);
	let at = 0;
	for (let i = 0; i < t.data.length; i += 3) {
		const s = t.data[i], e = t.data[i + 1], d = t.data[i + 2];
		uleb(s - at); uleb(e - s); zig(d);
		at = e;
	}
	return Uint8Array.from(out);
}
