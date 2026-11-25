#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The prepared data disk of the guest VA-API check (check.mjs): a data disk
// (.agents/data-disk.md) whose Debian upper layer has libva's tools, ffmpeg
// and mpv installed (no recommends: no mesa-va-drivers, whose
// virtio_gpu_drv_video.so would replace the kw layer's), so that test runs
// download nothing. Made once as test/vk/debian-disk.mjs makes its own:
// boots the Debian image on Node with the guest network, apt-installs the
// packages as root, powers off cleanly and renames the image into place.
// Skipped when the image exists (delete it after a new Debian image).
// --apps adds the consumers of zero-copy output (check.mjs --gl --disk):
// firefox-esr and GStreamer's va, gl and base elements.
//
//   node test/va/debian-disk.mjs [--apps] [--out FILE] [--kernel unkernel.wasm] [--distro debian.erofs]
//
// Default out: $KW_BUILD/va/debian-va.img (vendor/build); with --apps
// debian-va-apps.img.
import { existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImageFromKwsparse, createKernel } from "../../js/node.ts";

export const VA_PACKAGES = ["vainfo", "ffmpeg", "mpv"];
export const VA_APPS = ["firefox-esr", "gstreamer1.0-tools", "gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good", "gstreamer1.0-plugins-bad", "gstreamer1.0-gl", "libegl-mesa0", "mesa-utils", "fonts-dejavu-core"];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const apps = args.includes("--apps");
const out = resolve(opt("--out", join(build, apps ? "va/debian-va-apps.img" : "va/debian-va.img")));
const packages = apps ? [...VA_PACKAGES, ...VA_APPS] : VA_PACKAGES;
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
const script = `set -e
export DEBIAN_FRONTEND=noninteractive
inst() { apt-get install -y -q --no-install-recommends ${packages.join(" ")} </dev/null; }
inst || { apt-get update -q && inst; }
apt-get clean
for c in vainfo ffmpeg mpv${apps ? " firefox-esr gst-launch-1.0" : ""}; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
ls /usr/lib/aarch64-linux-gnu/libva.so.2 /usr/lib/aarch64-linux-gnu/libva-drm.so.2
! dpkg -s mesa-va-drivers >/dev/null 2>&1
sync`;
let code = 1;
try {
	const r = await vm.exec("bash", ["-c", script], { user: "root", timeout: 3 * 3600_000 });
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	code = r.exitCode ?? 1;
	console.log(`[va-disk] apt-get finished with ${code} after ${secs()} s`);
} catch (e) {
	console.error(`[va-disk] ${e?.message ?? e}`);
}
// A clean shutdown: the base stops the overlay and syncs the data disk.
vm.write("sudo poweroff\n");
const res = await Promise.race([vm.exited, new Promise((r) => setTimeout(() => r(null), 120_000))]);
if (!res) {
	console.error("[va-disk] no power-off within 120 s");
	await vm.stop();
	code = 1;
}
if (code !== 0) {
	rmSync(tmp, { force: true });
	console.error(`[va-disk] failed after ${secs()} s`);
	process.exit(1);
}
renameSync(tmp, out);
console.log(`[va-disk] ${out}: ${(statSync(out).blocks * 512 / 1048576).toFixed(0)} MiB used (sparse, ${statSync(out).size / 1048576} MiB), made in ${secs()} s`);
process.exit(0);
