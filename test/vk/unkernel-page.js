// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page of unkernel-check.mjs: boots unkernel from the built package
// (/dist/web.mjs) with the Debian image and the prepared data disk (the
// Vulkan loader and vulkan-tools installed: debian-disk.mjs; read over
// HTTP, the guest's writes kept in memory) and `vk: true`, puts the ICD
// and its manifest into the guest where the base has none (/files/...),
// runs the steps in the guest through vm.exec() and posts what they
// printed; the harness judges. Query: worker=1 (worker mode), skip=a,b,c,
// tests=NAME,NAME (the guest test programs served at /files/test/NAME),
// push=0 (use the base's ICD), cmd=SHELL (one more step, "cmd"), kernel=URL (another
// bundle), src=1 (the SDK from its sources, /js/web.ts, instead of /dist/web.mjs).
const q = new URLSearchParams(location.search);
const { createKernel } = await import(q.has("src") ? "/js/web.ts" : "/dist/web.mjs");
const skip = new Set((q.get("skip") || "").split(",").filter(Boolean));
const tests = (q.get("tests") || "").split(",").filter(Boolean);
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);

const post = (path, body) => fetch(path, { method: "POST", body }).catch(() => {});
function log(s) {
	const line = `[${secs()}] ${s}`;
	document.getElementById("log").append(line + "\n");
	post("/log", line);
}
let consoleBuf = "";
setInterval(() => {
	if (consoleBuf) post("/console", consoleBuf), (consoleBuf = "");
}, 500);
addEventListener("error", (e) => log(`error: ${e.message}`));
addEventListener("unhandledrejection", (e) => log(`error: ${e.reason?.stack || e.reason}`));

const WL = `#!/bin/sh
# kwvk-wl CMD...: CMD on the guest's headless weston (started once)
export XDG_RUNTIME_DIR=/tmp/kwvk-xdg WAYLAND_DISPLAY=kwvk-0
if [ ! -S $XDG_RUNTIME_DIR/kwvk-0 ]; then
	rm -rf $XDG_RUNTIME_DIR; mkdir -m 700 $XDG_RUNTIME_DIR
	setsid weston --backend=headless --renderer=pixman --socket=kwvk-0 --width=640 --height=480 --idle-time=0 --debug >/tmp/weston.log 2>&1 </dev/null &
	i=0; while [ ! -S $XDG_RUNTIME_DIR/kwvk-0 ] && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
	[ -S $XDG_RUNTIME_DIR/kwvk-0 ] || { echo "weston did not start:"; cat /tmp/weston.log; exit 1; }
fi
exec "$@"
`;
const ICD = "/usr/lib/kw/libvulkan_kw.so";
const MANIFEST = "/usr/share/vulkan/icd.d/kw_icd.json";

async function main() {
	const adapter = await navigator.gpu?.requestAdapter();
	const result = { worker: q.has("worker"), steps: {}, webgpu: adapter ? {} : null };
	for (const k of ["vendor", "architecture", "device", "description"]) if (adapter) result.webgpu[k] = adapter.info?.[k];
	log(`WebGPU adapter: ${JSON.stringify(result.webgpu)}`);
	const vmOpts = {
		distro: "/img/debian.erofs",
		// snap: the overlay in IndexedDB (this run's own browser profile), so the machine can be snapshotted
		disks: [{ kind: "http", url: "/img/debian-vk.img", ...(q.has("snap") ? { persist: "kwtest-vk-snapshot" } : {}) }],
		...(q.get("kernel") ? { kernel: q.get("kernel") } : {}),
		...(q.get("cpus") ? { cpus: Number(q.get("cpus")) } : {}),
		vk: true,
		worker: q.has("worker"),
		memoryMiB: 1024,
		log,
	};
	let vm = await createKernel(vmOpts);
	vm.onOutput((b) => (consoleBuf += new TextDecoder().decode(b)));
	log(`booted (transport ${vm.transport})`);
	if (!vm.vk) throw new Error("vm.vk is undefined: the vk option was ignored (see the log)");
	result.ready = await vm.vk.ready;
	result.statusAtBoot = vm.vk.status;
	log(`vk ready: ${result.ready}; status ${JSON.stringify(result.statusAtBoot)}`);

	const run = async (name, cmd, opts = {}) => {
		log(`run ${name}: ${cmd}`);
		const t = performance.now();
		const r = await vm.exec("bash", ["-c", cmd], { timeout: 900_000, ...opts });
		const s = { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Math.round(performance.now() - t) };
		log(`${name}: exit ${r.exitCode ?? r.signal} after ${(s.ms / 1000).toFixed(1)} s`);
		result.steps[name] = s;
		return s;
	};
	const put = async (url, path, mode) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		const bin = new Uint8Array(await res.arrayBuffer());
		const r = await vm.exec("sh", ["-c", `mkdir -p "$(dirname ${path})" && cat >${path} && chmod ${mode} ${path}`], { input: bin, user: "root" });
		if (r.exitCode !== 0) throw new Error(`writing ${path}: ${r.stderr}`);
	};

	// The ICD: the base's (push=0) or the one under test.
	if (q.get("push") !== "0") {
		await put("/files/libvulkan_kw.so", ICD, 755);
		await put("/files/kw_icd.json", MANIFEST, 644);
		log(`put ${ICD} and ${MANIFEST} into the guest`);
	}
	await run("icd", `ls -l ${ICD} ${MANIFEST}; cat ${MANIFEST}; ls /usr/share/vulkan/icd.d/`);

	// (h) the link without the ICD: a hello frame through kwbox vsock to the host's port 1018
	if (!skip.has("h")) await run("hello", `printf '\\040\\000\\000\\000\\040\\000\\000\\000{"op":"hello","r":1,"version":1}' | timeout 60 kwbox vsock connect 1018 | tail -c +9 | tr -d '\\000' | head -c 100000`);
	result.statusAfterHello = vm.vk.status;

	// (a) the device the guest sees
	if (!skip.has("a")) await run("vulkaninfo", "vulkaninfo --summary 2>&1");
	result.statusAfterA = vm.vk.status;

	// (b) the ICD's test programs (test/vk/guest/), each judged by its exit status
	if (!skip.has("b")) {
		for (const t of tests) {
			await put(`/files/test/${t}`, `/tmp/vk-${t}`, 755);
			await run(`test-${t}`, `cd /tmp && timeout 600 /tmp/vk-${t} 2>&1`);
		}
		// any picture a test left behind
		const r = await vm.exec("sh", ["-c", "ls /tmp/*.ppm /tmp/*.png 2>/dev/null"]);
		for (const f of r.stdout.split("\n").filter(Boolean)) {
			const b = await vm.exec("cat", [f], { encoding: "buffer" }).catch(() => null);
			if (b?.exitCode === 0) await post(`/file/${f.slice(5)}`, b.stdout);
		}
	}

	// The guest's compositor: weston's headless backend (pixman, no GL), started once with
	// --debug (for weston-screenshooter); `kwvk-wl CMD...` runs CMD on it.
	await vm.exec("sh", ["-c", "cat >/usr/local/bin/kwvk-wl && chmod 755 /usr/local/bin/kwvk-wl"], { user: "root", input: new TextEncoder().encode(WL) });

	// (c) vkcube on Wayland, 30 frames; then a frame of a running vkcube taken by weston-screenshooter
	if (!skip.has("c")) {
		await run("vkcube", "command -v weston >/dev/null || { echo 'no weston in the guest: vkcube not run'; exit 77; }; kwvk-wl timeout 300 vkcube --wsi wayland --c 30 2>&1");
		if (result.steps.vkcube.exitCode === 0) {
			await run("vkcube-shot", "cd /tmp && rm -f wayland-screenshot*.png; kwvk-wl sh -c 'vkcube --wsi wayland --width 300 --height 300 >/tmp/vkcube.log 2>&1 & p=$!; sleep 4; weston-screenshooter; s=$?; kill $p; wait $p; exit $s' 2>&1; ls -l /tmp/wayland-screenshot*.png");
			const f = result.steps["vkcube-shot"].stdout.match(/\/tmp\/(wayland-screenshot[\w.-]*\.png)/)?.[1];
			const b = f && (await vm.exec("cat", [`/tmp/${f}`], { encoding: "buffer" }).catch(() => null));
			if (b?.exitCode === 0) await post("/file/vkcube.png", b.stdout);
		}
	}

	if (q.get("cmd")) {
		await run("cmd", q.get("cmd"));
		// files the command left in /tmp/kwvk-out (e.g. screenshots) go to the harness's --out
		const r = await vm.exec("sh", ["-c", "ls /tmp/kwvk-out 2>/dev/null"]);
		for (const f of r.stdout.split("\n").filter((f) => /^[\w.-]+$/.test(f))) {
			const b = await vm.exec("cat", [`/tmp/kwvk-out/${f}`], { encoding: "buffer" }).catch(() => null);
			if (b?.exitCode === 0) await post(`/file/${f}`, b.stdout);
		}
	}
	if (q.get("cpus")) result.cpus = vm.stats?.().cpus ?? null;

	// (l) lose: the WebGPU device destroyed while vkcube runs: vkcube must end, and new programs
	// (vulkaninfo, vk-compute) get a new device and renderer
	if (q.has("lose")) {
		const out = (result.lose = {});
		await put("/files/test/vk-compute", "/tmp/vk-vk-compute", 755);
		await run("lose-start", "rm -f /tmp/lose-vkcube.log; setsid nohup kwvk-wl vkcube --wsi wayland </dev/null >/tmp/lose-vkcube.log 2>&1 & sleep 3; pgrep -x vkcube");
		out.before = { status: vm.vk.status, losses: vm.vk.stats.losses, presents: vm.vk.stats.renderer?.presents };
		const dev = vm.vk.device;
		out.hadDevice = !!dev;
		dev?.destroy();
		for (let i = 0; i < 50 && vm.vk.status.state !== "lost"; i++) await new Promise((r) => setTimeout(r, 100));
		out.after = { status: vm.vk.status, losses: vm.vk.stats.losses };
		await run("lose-vkcube", "for i in $(seq 50); do pgrep -x vkcube >/dev/null || break; sleep 0.2; done; if pgrep -x vkcube >/dev/null; then echo 'vkcube still runs'; pkill -x vkcube; exit 1; fi; echo 'vkcube ended'; tail -3 /tmp/lose-vkcube.log");
		await run("lose-compute", "timeout 300 /tmp/vk-vk-compute 2>&1");
		await run("lose-vulkaninfo", "vulkaninfo --summary 2>&1 | grep -E 'deviceName|apiVersion'");
		out.end = { status: vm.vk.status, losses: vm.vk.stats.losses };
	}

	// (s) snap: a snapshot (with stop) while vkcube runs on its link, restored in the same page:
	// the restored vkcube's link is gone (it must end), and new Vulkan programs work
	if (q.has("snap")) {
		const out = (result.snapshot = { attempts: [] });
		await put("/files/test/vk-compute", "/tmp/vk-vk-compute", 755);
		await run("snap-start", "rm -f /tmp/snap-vkcube.log; setsid nohup kwvk-wl vkcube --wsi wayland </dev/null >/tmp/snap-vkcube.log 2>&1 & sleep 3; pgrep -x vkcube");
		out.statsBefore = vm.vk.stats;
		let snap = null;
		for (let i = 0; i < 20 && !snap; i++) {
			try {
				snap = await vm.snapshot({ stop: true });
				out.attempts.push("taken");
			} catch (e) {
				out.attempts.push(String(e?.message || e));
				await new Promise((r) => setTimeout(r, 250));
			}
		}
		if (!snap) out.error = "no snapshot";
		else {
			const t = performance.now();
			vm = await createKernel({ ...vmOpts, restore: snap });
			out.restoreMs = Math.round(performance.now() - t);
			out.statusAfterRestore = vm.vk?.status;
			await run("snap-vkcube", "for i in $(seq 50); do pgrep -x vkcube >/dev/null || break; sleep 0.2; done; if pgrep -x vkcube >/dev/null; then echo 'vkcube still runs'; pkill -x vkcube; exit 1; fi; echo 'vkcube ended'; tail -5 /tmp/snap-vkcube.log");
			await run("snap-compute", "timeout 300 /tmp/vk-vk-compute 2>&1");
			await run("snap-vulkaninfo", "vulkaninfo --summary 2>&1 | grep -E 'deviceName|apiVersion'");
			out.statsAfter = vm.vk?.stats;
		}
	}

	result.status = vm.vk.status;
	result.stats = vm.vk.stats;
	result.totalS = Number(secs());
	await post("/result", JSON.stringify(result));
	log("done");
	await vm.stop();
}

main().catch(async (e) => {
	log(`error: ${e?.stack || e}`);
	await post("/result", JSON.stringify({ error: String(e?.stack || e) }));
});
