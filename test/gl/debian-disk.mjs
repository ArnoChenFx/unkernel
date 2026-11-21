#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The prepared data disk of the guest GL tests (unkernel-check.mjs): a data
// disk (.agents/data-disk.md) whose Debian upper layer has Mesa and the GL
// test programs installed, so that test runs download nothing. Made once:
// boots the Debian image on Node with the guest network (the SDK's direct
// backend), apt-installs the packages below as root, powers off cleanly and
// renames the image into place. Skipped when the image exists (delete it to
// make it again, e.g. after a new Debian image: the upper layer belongs to
// the image it was made on).
//
//   node test/gl/debian-disk.mjs [--out FILE] [--kernel unkernel.wasm] [--distro debian.erofs]
//
// Default out: $KW_BUILD/gl/debian-gl.img (vendor/build). The packages:
// surfaceless EGL (eglinfo, libEGL and libGLESv2 for kwgl-state), X11
// (Xvfb, glmark2 for GLES 2 and GL) and KMS (kmscube, glmark2-es2-drm,
// modetest).
import { existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImageFromKwsparse, createKernel } from "../../js/node.ts";

export const GL_PACKAGES = [
	"mesa-utils", "libegl-mesa0", "libgles2",
	"libgl1-mesa-dri", "libglx-mesa0", "xvfb", "xauth", "glmark2-es2-x11", "glmark2-x11",
	// virtio-gpu (KMS and GBM clients on /dev/dri): unkernel-check.mjs --drm
	"libgbm1", "kmscube", "glmark2-es2-drm", "libdrm-tests",
];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const out = resolve(opt("--out", join(build, "gl/debian-gl.img")));
const kernel = opt("--kernel");
const distro = resolve(opt("--distro", join(build, "distro/debian.erofs")));

if (existsSync(out)) {
	console.log(`${out} exists (${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used); delete it to make it again`);
	process.exit(0);
}
if (!existsSync(distro)) {
	console.error(`no ${distro} (kernel/build.sh distro debian)`);
	process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
rmSync(tmp, { force: true });
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(0);
await createImageFromKwsparse(tmp, readFileSync(join(build, "disk/kwdata.kwsparse.gz")));

const vm = await createKernel({
	...(kernel ? { kernel: resolve(kernel) } : {}),
	distro,
	disks: [{ kind: "file", path: tmp }],
	net: { kind: "net", backend: { kind: "direct" } },
	memoryMiB: 1024,
});
vm.onOutput((b) => process.stderr.write(b));
// apt as the image's kw-apt-install does it: the image's package lists
// first, fetched again if a version is gone from the mirror.
const script = `set -e
export DEBIAN_FRONTEND=noninteractive
inst() { apt-get install -y -q --no-install-recommends ${GL_PACKAGES.join(" ")} </dev/null; }
inst || { apt-get update -q && inst; }
apt-get clean
for c in eglinfo glxinfo Xvfb xvfb-run glmark2-es2 glmark2 kmscube glmark2-es2-drm modetest; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
ls /usr/lib/aarch64-linux-gnu/dri/ | grep -c . >/dev/null
sync`;
let code = 1;
try {
	const r = await vm.exec("bash", ["-c", script], { user: "root", timeout: 3 * 3600_000 });
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	code = r.exitCode ?? 1;
	console.log(`[gl-disk] apt-get finished with ${code} after ${secs()} s`);
} catch (e) {
	console.error(`[gl-disk] ${e?.message ?? e}`);
}
// A clean shutdown: the base stops the overlay and syncs the data disk.
vm.write("sudo poweroff\n");
const res = await Promise.race([vm.exited, new Promise((r) => setTimeout(() => r(null), 120_000))]);
if (!res) {
	console.error("[gl-disk] no power-off within 120 s");
	await vm.stop();
	code = 1;
}
if (code !== 0) {
	rmSync(tmp, { force: true });
	console.error(`[gl-disk] failed after ${secs()} s`);
	process.exit(1);
}
renameSync(tmp, out);
console.log(`[gl-disk] ${out}: ${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used (sparse, ${statSync(out).size / 1048576} MiB), made in ${secs()} s`);
process.exit(0);
