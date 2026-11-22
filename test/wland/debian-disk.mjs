#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The prepared data disk of the wland tests (page-check.mjs):
// a data disk (.agents/data-disk.md) whose Debian upper layer has the Wayland
// clients below installed, so that test runs download nothing. Made once, as
// test/gl/debian-disk.mjs makes the GL one: boots the Debian image on Node
// with the guest network (the SDK's direct backend), apt-installs the
// packages as root, powers off cleanly and renames the image into place;
// then writes the same disk as a gzipped kwsparse image next to it, which
// the page imports (KW.importData()). Skipped when both exist (delete them
// to make them again, e.g. after a new Debian image: the upper layer belongs
// to the image it was made on).
//
//   node test/wland/debian-disk.mjs [--gl | --chromium] [--out FILE] [--kernel unkernel.wasm] [--distro debian.erofs]
//
// Default out: $KW_BUILD/wland/debian-wland.img (vendor/build), with --gl
// $KW_BUILD/wland/debian-wland-gl.img, with --chromium
// $KW_BUILD/wland/debian-wland-chromium.img, and FILE.kwsparse.gz. --gl adds
// the GL clients of page-check.mjs --gpu (WLAND_GL_PACKAGES, below);
// --chromium installs chromium instead, as a user does (apt-get install
// chromium: with its recommends) for page-check.mjs --chromium.
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImageFromKwsparse, createKernel, gzipBlob, kwsparseHeader, isZeroBlock } from "../../js/node.ts";

// foot (the terminal) with a font (foot only recommends one) and fontconfig
// (fc-cache: a font cache, made once, instead of a scan at each start),
// wayland-utils (wayland-info), wl-clipboard (wl-copy, wl-paste) and l3afpad
// (a small GTK 3 editor: menus as popups), with systemd held back (GTK's
// dbus would bring it, and it removes sysv-rc). Not weston, which brings Mesa
// and LLVM (300 MiB more for the page to import): its weston-simple-shm and
// weston-presentation-shm need only libwayland-client, so they are taken
// from its .deb into /usr/local/bin (the frame pacing checks).
export const WLAND_PACKAGES = ["foot", "fonts-dejavu-core", "fontconfig", "wayland-utils", "wl-clipboard", "l3afpad"];
// --gl: Mesa (EGL on Wayland and GBM: virgl on /dev/dri), es2gears_wayland
// and eglinfo (mesa-utils), glmark2-es2-wayland and gtk4-demo (GTK 4 with
// its GL renderer); weston-simple-egl comes from weston's .deb as the shm
// clients do.
export const WLAND_GL_PACKAGES = ["libegl-mesa0", "libgles2", "libgl1-mesa-dri", "libgbm1", "libwayland-egl1", "mesa-utils", "glmark2-es2-wayland", "gtk-4-examples"];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
export const defaultDisk = join(build, "wland/debian-wland.img");
export const defaultGlDisk = join(build, "wland/debian-wland-gl.img");
export const defaultChromiumDisk = join(build, "wland/debian-wland-chromium.img");
const gl = args.includes("--gl");
const chromium = args.includes("--chromium");
const out = resolve(opt("--out", gl ? defaultGlDisk : chromium ? defaultChromiumDisk : defaultDisk));
const sparse = `${out}.kwsparse.gz`;
const kernel = opt("--kernel");
const distro = resolve(opt("--distro", join(build, "distro/debian.erofs")));
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(0);

/** The image as a gzipped kwsparse (the page's import format): its non-zero 4 KiB blocks. */
async function writeKwsparse(img, dest) {
	const BLOCK = 4096;
	const size = statSync(img).size;
	const indices = [];
	const blocks = [];
	let at = 0;
	for await (const chunk of createReadStream(img, { highWaterMark: 1 << 20 })) {
		for (let o = 0; o < chunk.length; o += BLOCK) {
			const b = chunk.subarray(o, o + BLOCK);
			if (!isZeroBlock(b)) { indices.push((at + o) / BLOCK); blocks.push(new Uint8Array(b)); }
		}
		at += chunk.length;
	}
	const gz = await gzipBlob([kwsparseHeader(size, BLOCK, indices), ...blocks]);
	writeFileSync(`${dest}.tmp`, new Uint8Array(await gz.arrayBuffer()));
	renameSync(`${dest}.tmp`, dest);
	console.log(`[wland-disk] ${dest}: ${indices.length} blocks, ${(gz.size / 1048576).toFixed(0)} MiB gzipped`);
}

if (existsSync(out)) {
	console.log(`${out} exists (${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used); delete it to make it again`);
	if (!existsSync(sparse)) await writeKwsparse(out, sparse);
	process.exit(0);
}
if (!existsSync(distro)) {
	console.error(`no ${distro} (kernel/build.sh distro debian)`);
	process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
rmSync(tmp, { force: true });
rmSync(sparse, { force: true });
await createImageFromKwsparse(tmp, readFileSync(join(build, "disk/kwdata.kwsparse.gz")));

const vm = await createKernel({
	...(kernel ? { kernel: resolve(kernel) } : {}),
	distro,
	disks: [{ kind: "file", path: tmp }],
	net: { kind: "net", backend: { kind: "direct" } },
	memoryMiB: chromium ? 2048 : 1024,
});
vm.onOutput((b) => process.stderr.write(b));
// apt as the image's kw-apt-install does it: the image's package lists
// first, fetched again if a version is gone from the mirror. The .debs go
// to /tmp (tmpfs), so their blocks never reach the disk and its image.
const script = chromium ? `set -e
export DEBIAN_FRONTEND=noninteractive
mkdir -p /tmp/debs/partial
inst() { apt-get install -y -q -o Dir::Cache::Archives=/tmp/debs chromium </dev/null; }
inst || { apt-get update -q && inst; }
command -v chromium
dpkg -l | awk '/^ii/ { print $2 }' | grep -E '^(dbus|systemd|libpam-systemd|libgl1-mesa-dri|libegl-mesa0)' || true
sync` : `set -e
export DEBIAN_FRONTEND=noninteractive
mkdir -p /tmp/debs/partial
inst() { apt-get install -y -q --no-install-recommends -o Dir::Cache::Archives=/tmp/debs ${[...WLAND_PACKAGES, ...(gl ? WLAND_GL_PACKAGES : [])].join(" ")} systemd- </dev/null; }
inst || { apt-get update -q && inst; }
(cd /tmp && apt-get download -q weston && dpkg-deb -x weston_*.deb /tmp/weston)
install -m 755 /tmp/weston/usr/bin/weston-simple-shm /tmp/weston/usr/bin/weston-presentation-shm ${gl ? "/tmp/weston/usr/bin/weston-simple-egl " : ""}/usr/local/bin/
for c in foot wayland-info wl-copy wl-paste l3afpad weston-simple-shm weston-presentation-shm${gl ? " weston-simple-egl es2gears_wayland eglinfo glmark2-es2-wayland gtk4-demo" : ""}; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
! ldd /usr/local/bin/weston-* | grep "not found"
fc-list | grep -q . || { echo "no fonts"; exit 1; }
sync`;
let code = 1;
try {
	const r = await vm.exec("bash", ["-c", script], { user: "root", timeout: 3 * 3600_000 });
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	code = r.exitCode ?? 1;
	console.log(`[wland-disk] apt-get finished with ${code} after ${secs()} s`);
} catch (e) {
	console.error(`[wland-disk] ${e?.message ?? e}`);
}
// A clean shutdown: the base stops the overlay and syncs the data disk.
vm.write("sudo poweroff\n");
const res = await Promise.race([vm.exited, new Promise((r) => setTimeout(() => r(null), 120_000))]);
if (!res) {
	console.error("[wland-disk] no power-off within 120 s");
	await vm.stop();
	code = 1;
}
if (code !== 0) {
	rmSync(tmp, { force: true });
	console.error(`[wland-disk] failed after ${secs()} s`);
	process.exit(1);
}
renameSync(tmp, out);
console.log(`[wland-disk] ${out}: ${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used (sparse, ${statSync(out).size / 1048576} MiB), made in ${secs()} s`);
await writeKwsparse(out, sparse);
process.exit(0);
