#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Write distros.json, the index of the distro images that go with a base
// bundle (a release's assets, and what the SDK's fetchDistro() reads):
//
//   node guest/tools/distros-json.mjs DIR [--bundle unkernel.wasm] [-o DIR/distros.json]
//
//   { "abi": <KW_ABI_VERSION of the bundle's kwemu>, "base": "<base id>",
//     "distros": [{ "name": "alpine", "file": "alpine.erofs", "size": <bytes>,
//                   "sha256": "<hex>", "image": "<kw-image id>" }, ...] }
//
// One entry per distro in DIR: NAME.erofs, or NAME.ext4 when there is no
// .erofs; Alpine first, then by name. The image id is NAME.id, which
// guest/lib/image.sh writes next to the images. abi and base come from the
// bundle (kernel/tools/bundle.mjs kernelInfo(), and /kw/layer/usr/lib/kw-base
// in its initramfs); null without --bundle or when it does not exist.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { INITRD_SECTION, kernelInfo, sections } from "../../kernel/tools/bundle.mjs";

/** The file `name` in newc cpio archives (concatenated ones too), or undefined. */
function cpioFile(cpio, name) {
	let p = 0;
	while (p + 110 <= cpio.length) {
		const magic = cpio.toString("latin1", p, p + 6);
		if (magic !== "070701" && magic !== "070702") {
			// Padding between concatenated archives.
			if (cpio[p] === 0) { p += 4; continue; }
			throw new Error(`bad cpio header at ${p}`);
		}
		const hex = (i) => parseInt(cpio.toString("latin1", p + 6 + i * 8, p + 14 + i * 8), 16);
		const size = hex(6), nsize = hex(11);
		const n = cpio.toString("latin1", p + 110, p + 110 + nsize - 1);
		const data = (p + 110 + nsize + 3) & ~3;
		if (n.replace(/^\.?\//, "") === name) return cpio.subarray(data, data + size);
		p = (data + size + 3) & ~3;
	}
	return undefined;
}

/** { abi, base } of a base bundle. */
export function bundleInfo(wasm) {
	const { abi } = kernelInfo(wasm);
	const s = sections(wasm).find((x) => x.id === 0 && x.name === INITRD_SECTION);
	let base = null;
	if (s) {
		// The payload starts after the section's size and name.
		let p = s.start + 1;
		const uleb = () => { let v = 0, m = 1, c; do { c = wasm[p++]; v += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return v; };
		uleb();
		const n = uleb();
		p += n;
		let cpio = Buffer.from(wasm.buffer, wasm.byteOffset + p, s.end - p);
		if (cpio[0] === 0x1f && cpio[1] === 0x8b) cpio = gunzipSync(cpio);
		base = cpioFile(cpio, "kw/layer/usr/lib/kw-base")?.toString("utf8").trim() || null;
	}
	return { abi, base };
}

const sha256 = (file) => new Promise((resolve, reject) => {
	const h = createHash("sha256");
	createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
});

/** The index of the images in `dir` (see the top). */
export async function distrosIndex(dir, bundle) {
	const names = new Set(readdirSync(dir).filter((f) => /^[a-z0-9]+\.(erofs|ext4)$/.test(f)).map((f) => f.replace(/\.\w+$/, "")));
	const distros = [];
	for (const name of [...names].sort((a, b) => (a === "alpine" ? -1 : b === "alpine" ? 1 : a < b ? -1 : a > b ? 1 : 0))) {
		const file = existsSync(path.join(dir, `${name}.erofs`)) ? `${name}.erofs` : `${name}.ext4`;
		const idFile = path.join(dir, `${name}.id`);
		if (!existsSync(idFile)) throw new Error(`no ${idFile} (an image built before image ids were recorded: rebuild it with guest/build.sh distro ${name})`);
		const full = path.join(dir, file);
		distros.push({ name, file, size: statSync(full).size, sha256: await sha256(full), image: readFileSync(idFile, "utf8").trim() });
	}
	const info = bundle && existsSync(bundle) ? bundleInfo(readFileSync(bundle)) : { abi: null, base: null };
	return { abi: info.abi, base: info.base, distros };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const take = (name) => {
		const i = args.indexOf(name);
		if (i < 0) return undefined;
		const v = args[i + 1];
		args.splice(i, 2);
		return v;
	};
	const bundle = take("--bundle"), out = take("-o");
	const [dir, extra] = args;
	if (!dir || extra) {
		console.error("usage: distros-json.mjs DIR [--bundle unkernel.wasm] [-o FILE]");
		process.exit(2);
	}
	const file = out ?? path.join(dir, "distros.json");
	try {
		const index = await distrosIndex(dir, bundle);
		if (!bundle || !existsSync(bundle)) console.error(`distros.json: warning: no base bundle${bundle ? ` ${bundle}` : ""}, so no abi and base`);
		writeFileSync(`${file}.tmp`, `${JSON.stringify(index, null, "\t")}\n`);
		renameSync(`${file}.tmp`, file);
		console.log(`distros.json: ${file} (abi ${index.abi}, ${index.base}; ${index.distros.map((d) => `${d.file} ${d.image}`).join(", ") || "no images"})`);
	} catch (e) {
		console.error(`distros.json: ${e.message}`);
		process.exit(1);
	}
}
