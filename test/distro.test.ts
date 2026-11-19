// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel({ distro }): the distroless bundle (kernel + base initramfs)
// with a read-only distro image, for each of Alpine and Debian.
//
//   node --test test/distro.test.ts
//   UNKERNEL_TEST_BASE_KERNEL=path ...      # another distroless bundle (default vendor/build/bundle/unkernel.wasm)
//   UNKERNEL_TEST_DISTRO_FORMAT=ext4 ...    # the .ext4 images (default: .erofs if the kernel has erofs, else .ext4)
//   UNKERNEL_TEST_DISTRO_DIR=dir ...        # where the images are (default vendor/build/distro; KW_DISTRO_OUT of a build)
//
// Skips what is not built (kernel/build.sh base, kernel/build.sh distro).
// The images are copied to a temporary directory first, so a rebuild while
// the tests run does not matter, and checked byte for byte at the end.
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, createImageFromKwsparse, bundledBoot, decodeSnapshot, encodeSnapshot, openDistroDisk, snapshotDiskMismatch } from "../js/node.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernelFile = path.resolve(process.env.UNKERNEL_TEST_BASE_KERNEL ?? path.join(root, "vendor/build/bundle/unkernel.wasm"));
const kernelBytes = existsSync(kernelFile) ? readFileSync(kernelFile) : undefined;
/** A message of the kernel's erofs driver (fs/erofs/super.c). */
const hasErofs = !!kernelBytes?.includes("cannot find valid erofs superblock");
const format = process.env.UNKERNEL_TEST_DISTRO_FORMAT ?? (hasErofs ? "erofs" : "ext4");
const module = kernelBytes && await WebAssembly.compile(kernelBytes);
const bundled = module && bundledBoot(module);
const shown = kernelFile.startsWith(root + path.sep) ? path.relative(root, kernelFile) : kernelFile;
const noKernel = !kernelBytes ? `no ${shown} (kernel/build.sh base)` : !bundled?.initrd ? `${shown} has no bundled base initramfs` : false;

const tmp = mkdtempSync(path.join(tmpdir(), "unkernel-distro-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const MEM = 512, EXEC = { timeout: 120000 };
const distroDir = path.resolve(process.env.UNKERNEL_TEST_DISTRO_DIR ?? path.join(root, "vendor/build/distro"));

/** The test's copy of a distro image, and its hash at copy time; undefined if it is not built. */
function image(name: string): { file: string; sha: string } | undefined {
	const src = path.join(distroDir, `${name}.${format}`);
	if (!existsSync(src)) return undefined;
	const file = path.join(tmp, `${name}.${format}`);
	if (!existsSync(file)) copyFileSync(src, file);
	return { file, sha: sha(file) };
}

/** A new data disk image (sparse) from the bundle's template. */
async function dataDisk(name: string): Promise<string> {
	const file = path.join(tmp, `${name}-data.img`);
	rmSync(file, { force: true });
	const tpl = bundled?.datadisk ?? readFileSync(path.join(root, "vendor/build/disk/kwdata.kwsparse.gz"));
	await createImageFromKwsparse(file, tpl);
	return file;
}

type Vm = Awaited<ReturnType<typeof createKernel>>;
const sh = async (vm: Vm, cmd: string) => {
	const r = await vm.exec("sh", ["-c", cmd], EXEC);
	assert.equal(r.exitCode, 0, `${cmd}: exit ${r.exitCode}, ${r.stderr}`);
	return r.stdout.trim();
};
/** Power off cleanly (the data disk's file systems are written back) and wait for the exit. */
const poweroff = async (vm: Vm) => {
	vm.write("\npoweroff\n");
	const res = await vm.exited;
	assert.equal(res.code, 0, res.reason);
};

for (const name of ["alpine", "debian"]) {
	const img = noKernel ? undefined : image(name);
	const skip = noKernel || (!img && `no ${path.join(distroDir, `${name}.${format}`)} (kernel/build.sh distro ${name})`);
	describe(`distro ${name} (${format})`, { skip, concurrency: 1 }, () => {
		const boot = async (t: { after(fn: () => unknown): void }, opts: NonNullable<Parameters<typeof createKernel>[0]>) => {
			const vm = await createKernel({ kernel: module, memoryMiB: MEM, log: () => {}, ...opts });
			t.after(() => vm.stop({ reason: "test cleanup" }));
			return vm;
		};

		test("boots through the SDK: exec() (the base's kwtty), /usr/lib/kw-distro, an overlay root, a read-only /dev/wda", async (t) => {
			const vm = await boot(t, { distro: img!.file });
			assert.equal(vm.distro?.fs, format);
			assert.equal(vm.distro?.label, "kwroot");
			assert.equal(await sh(vm, "cat /usr/lib/kw-distro"), name);
			assert.match(await sh(vm, "grep ' / ' /proc/self/mounts"), /^overlay \/ overlay .*lowerdir=\/kw\/layer:\/kw\/distro/m);
			assert.match(await sh(vm, "ls /usr/bin/kwtty"), /kwtty/);
			assert.equal(await sh(vm, "cat /sys/block/wda/ro"), "1");
			const w = await vm.exec("sh", ["-c", "echo x > /dev/wda"], EXEC);
			assert.notEqual(w.exitCode, 0, "a write to the distro's disk fails");
			await poweroff(vm);
		});

		test("a data disk keeps the root's changes across two boots, in /data/distros/<name>/upper", async (t) => {
			const data = await dataDisk(name);
			const token = `kw-${Math.random().toString(36).slice(2)}`;
			const vm1 = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }] });
			await sh(vm1, `echo ${token} > /root/persist && sync`);
			await poweroff(vm1);
			const vm2 = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }] });
			assert.equal(await sh(vm2, "cat /root/persist"), token);
			assert.equal(await sh(vm2, `cat /data/distros/${name}/upper/root/persist`), token);
			await poweroff(vm2);
		});

		/** Boot with a data disk; the console's text so far is out(). */
		const bootData = async (t: { after(fn: () => unknown): void }, data: string, cmdline?: string) => {
			const vm = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }], ...(cmdline ? { cmdline: `${bundled!.cmdline} ${cmdline}` } : {}) });
			let text = "";
			const dec = new TextDecoder();
			vm.onOutput((b) => { text += dec.decode(b, { stream: true }); });
			await sh(vm, "true");   // kwtty runs: the distro's init has printed the welcome and the base's messages
			return { vm, out: () => text };
		};
		const st = `/data/distros/${name}`;

		test("a root on the data disk that cannot boot (/bin/sh deleted) falls back to safe mode, and the next boot checks again", async (t) => {
			const data = await dataDisk(`${name}-safe`);
			const b1 = await bootData(t, data);
			await sh(b1.vm, "echo kept > /root/kept");
			const r = await b1.vm.exec("rm", ["/bin/sh"], EXEC);
			assert.equal(r.exitCode, 0, r.stderr);
			await b1.vm.exec("sync", [], EXEC);
			b1.vm.stop({ reason: "test: /bin/sh is gone, so no clean poweroff" });
			const b2 = await bootData(t, data);
			assert.match(b2.out(), /kw-overlay: SAFE MODE: \/bin\/sh is missing/);
			assert.match(await sh(b2.vm, "cat /run/kw-base"), /^upper=tmpfs$/m);
			assert.equal(await sh(b2.vm, "cat /root/kept 2>/dev/null || echo gone"), "gone");
			assert.equal(await sh(b2.vm, `cat ${st}/upper/root/kept`), "kept");
			assert.match(await sh(b2.vm, "kw-overlay status"), /SAFE MODE/);
			// The repair: remove the whiteout of /bin/sh (on Debian /bin is usr/bin).
			await sh(b2.vm, `rm -f ${st}/upper/bin/sh ${st}/upper/usr/bin/sh`);
			await poweroff(b2.vm);
			const b3 = await bootData(t, data);
			assert.doesNotMatch(b3.out(), /SAFE MODE/);
			assert.match(await sh(b3.vm, "cat /run/kw-base"), /^upper=data$/m);
			assert.equal(await sh(b3.vm, "cat /root/kept"), "kept");
			await poweroff(b3.vm);
		});

		test("kw.root=initramfs boots the plain image on a tmpfs upper, the data upper unmounted", async (t) => {
			const data = await dataDisk(`${name}-initramfs`);
			const b1 = await bootData(t, data);
			await sh(b1.vm, "echo kept > /root/kept");
			await poweroff(b1.vm);
			const b2 = await bootData(t, data, "kw.root=initramfs");
			assert.match(b2.out(), /kw-overlay: kw\.root=initramfs: the plain image this time/);
			assert.match(await sh(b2.vm, "cat /run/kw-base"), /^upper=tmpfs$/m);
			assert.equal(await sh(b2.vm, "cat /root/kept 2>/dev/null || echo gone"), "gone");
			assert.equal(await sh(b2.vm, `cat ${st}/upper/root/kept`), "kept");
			await poweroff(b2.vm);
		});

		test("kw-overlay discard: at the next boot on the data upper, at once when it is not mounted", async (t) => {
			const data = await dataDisk(`${name}-discard`);
			const b1 = await bootData(t, data);
			await sh(b1.vm, "echo one > /root/one");
			assert.match(await sh(b1.vm, "kw-overlay discard"), /at the next boot/);
			assert.equal(await sh(b1.vm, "cat /root/one"), "one", "still there this boot");
			await poweroff(b1.vm);
			const b2 = await bootData(t, data);
			assert.match(b2.out(), /kw-overlay: starting over from the image; the previous changes are in \/data\/distros\/\w+\/discarded-/);
			assert.equal(await sh(b2.vm, "cat /root/one 2>/dev/null || echo gone"), "gone");
			assert.equal(await sh(b2.vm, `cat ${st}/discarded-*/upper/root/one`), "one");
			await sh(b2.vm, "echo two > /root/two");
			await poweroff(b2.vm);
			const b3 = await bootData(t, data, "kw.root=initramfs");
			assert.match(await sh(b3.vm, "kw-overlay discard"), /your changes are now in/);
			assert.equal(await sh(b3.vm, `ls ${st}/upper 2>/dev/null | wc -l; ls -d ${st}/discarded-* | wc -l`), "0\n2");
			await poweroff(b3.vm);
			const b4 = await bootData(t, data);
			assert.equal(await sh(b4.vm, "cat /root/two 2>/dev/null || echo gone"), "gone");
			await poweroff(b4.vm);
		});

		test("an image id change under the changes prints one line and goes into the history", async (t) => {
			const data = await dataDisk(`${name}-update`);
			const b1 = await bootData(t, data);
			const id = await sh(b1.vm, "cat /usr/lib/kw-image");
			assert.equal(await sh(b1.vm, `cat ${st}/lower`), id);
			await sh(b1.vm, `echo ${name}-0-older > ${st}/lower`);
			await poweroff(b1.vm);
			const b2 = await bootData(t, data);
			const lines = b2.out().split(/\r?\n/).filter((l) => l.includes("image updated"));
			assert.equal(lines.length, 1, b2.out());
			assert.match(lines[0]!, new RegExp(`${name} image updated: ${id}`));
			assert.match(await sh(b2.vm, `cat ${st}/history`), new RegExp(` ${name}-0-older -> ${id}$`));
			assert.equal(await sh(b2.vm, `cat ${st}/lower`), id);
			await poweroff(b2.vm);
			const b3 = await bootData(t, data);
			assert.doesNotMatch(b3.out(), /image updated/);
			await poweroff(b3.vm);
		});

		test("both distros keep their own changes on one data disk", { skip: name !== "debian" && "once, from the Debian suite" }, async (t) => {
			const other = image("alpine");
			if (!other) return t.skip("no alpine image");
			const data = await dataDisk("shared");
			const vm1 = await boot(t, { distro: other.file, disks: [{ kind: "file", path: data }] });
			await sh(vm1, "echo alpine > /root/who");
			await poweroff(vm1);
			const vm2 = await boot(t, { distro: img!.file, disks: [{ kind: "file", path: data }] });
			assert.equal(await sh(vm2, "cat /root/who 2>/dev/null || echo none"), "none");
			await sh(vm2, "echo debian > /root/who");
			assert.equal(await sh(vm2, "cat /data/distros/alpine/upper/root/who"), "alpine");
			await poweroff(vm2);
			const vm3 = await boot(t, { distro: other.file, disks: [{ kind: "file", path: data }] });
			assert.equal(await sh(vm3, "cat /root/who"), "alpine");
			await poweroff(vm3);
		});

		test("worker mode boots, with the distro as a spec", async (t) => {
			const vm = await boot(t, { worker: true, distro: img!.file });
			assert.equal(vm.distro?.fs, format);
			assert.equal(await sh(vm, "cat /usr/lib/kw-distro"), name);
			await poweroff(vm);
		});

		test("a snapshot is refused with another distro image, and resumes with its own", async (t) => {
			const other = image(name === "alpine" ? "debian" : "alpine");
			const vm = await boot(t, { distro: img!.file, vsock: false });
			const dec = new TextDecoder();
			let out = "";
			vm.onOutput((b) => { out += dec.decode(b, { stream: true }); });
			const until = async (re: RegExp) => { for (let i = 0; i < 1200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 100)); assert.match(out, re); };
			vm.write("\necho ready-$((6*7))\n");
			await until(/ready-42/);
			const snap = decodeSnapshot(encodeSnapshot(await vm.snapshot({ stop: true })));
			assert.equal(snap.disks.length, 1);
			assert.match(snap.disks[0]!.identity, new RegExp(`^distro ${format} `));
			assert.equal(snapshotDiskMismatch(snap.disks, [await openDistroDisk(img!.file)]), null);
			await assert.rejects(boot(t, { restore: snap, vsock: false }), /disk wda .* is missing/);
			if (other) await assert.rejects(boot(t, { restore: snap, vsock: false, distro: other.file }), /is not the disk of the snapshot/);
			const vm2 = await boot(t, { restore: snap, vsock: false, distro: img!.file });
			out = "";
			vm2.onOutput((b) => { out += dec.decode(b, { stream: true }); });
			vm2.write("echo resumed-$((6*8))\n");
			await until(/resumed-48/);
			await poweroff(vm2);
		});

		test("the image file is unchanged", () => {
			assert.equal(sha(img!.file), img!.sha);
			assert.ok(!existsSync(`${img!.file}.kwsnap`), "no snapshot sidecar for a read-only image");
		});
	});
}
