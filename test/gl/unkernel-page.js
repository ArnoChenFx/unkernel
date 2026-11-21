// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page of unkernel-check.mjs: boots unkernel from the built package
// (/dist/web.mjs) with the Debian image and the prepared data disk (Mesa
// installed: debian-disk.mjs; read over HTTP, the guest's writes kept in
// memory) and `gl: true`, waits for the guest's forwarder, runs the GL
// steps in the guest through vm.exec() and posts what they printed; the
// harness judges. Query: worker=1 (worker mode), size=WxH (glmark2's
// window), scenes= (glmark2 -b list, comma-separated), skip=a,b,c.
import { createKernel } from "/dist/web.mjs";

const q = new URLSearchParams(location.search);
const skip = new Set((q.get("skip") || "").split(",").filter(Boolean));
const size = q.get("size") || "640x480";
const scenes = (q.get("scenes") || "build:duration=10,texture:duration=10,shading:shading=phong:duration=10,jellyfish:duration=10,desktop:duration=10").split(",");
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

const VIRGL = "GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1";
const LLVMPIPE = "LIBGL_ALWAYS_SOFTWARE=1";
const VARIANTS = "tex stencil raster plain query mip dual";

async function main() {
	const result = { worker: q.has("worker"), size, scenes, steps: {} };
	const vm = await createKernel({
		distro: "/img/debian.erofs",
		disks: [{ kind: "http", url: "/img/debian-gl.img" }],
		gl: true,
		worker: q.has("worker"),
		memoryMiB: 1024,
		log,
	});
	vm.onOutput((b) => (consoleBuf += new TextDecoder().decode(b)));
	log(`booted (transport ${vm.transport})`);
	result.renderer = await vm.gl.ready;
	result.readyS = Number(secs());
	log(`gl ready: ${result.renderer}`);

	const run = async (name, cmd, opts = {}) => {
		log(`run ${name}: ${cmd}`);
		const t = performance.now();
		const r = await vm.exec("bash", ["-c", cmd], { timeout: 1800_000, ...opts });
		const s = { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Math.round(performance.now() - t) };
		log(`${name}: exit ${r.exitCode ?? r.signal} after ${(s.ms / 1000).toFixed(1)} s`);
		result.steps[name] = s;
		return s;
	};

	// (a) the renderer the guest sees
	if (!skip.has("a")) await run("eglinfo", `${VIRGL} eglinfo -B -p surfaceless`);

	// (b) pixels: kwgl-state's clients interleaved on the page's one renderer
	// against each run alone (both virgl), and the same on llvmpipe
	if (!skip.has("b")) {
		const bin = new Uint8Array(await (await fetch("/files/kwgl-state")).arrayBuffer());
		await vm.exec("sh", ["-c", "cat >/tmp/kwgl-state && chmod 755 /tmp/kwgl-state"], { input: bin });
		await run("state-alone", `for v in ${VARIANTS}; do ${VIRGL} timeout 600 /tmp/kwgl-state -t 8 $v; done | sort`);
		await run("state", `mkdir -p /tmp/state && ${VIRGL} timeout 900 /tmp/kwgl-state -t 8 -o /tmp/state ${VARIANTS} | sort`);
		await run("state-llvmpipe", `${LLVMPIPE} timeout 900 /tmp/kwgl-state -t 8 ${VARIANTS} | sort`);
		for (const v of VARIANTS.split(" ")) {
			const r = await vm.exec("cat", [`/tmp/state/${v}.ppm`], { encoding: "buffer" }).catch(() => null);
			if (r?.exitCode === 0) await post(`/file/state-${v}.ppm`, r.stdout);
		}
	}

	// (c) the same glmark2-es2 scenes at the same size under Xvfb, on llvmpipe
	// (software rendering under the emulated CPU) and on virgl (the page's WebGL2)
	if (!skip.has("c")) {
		const [w, h] = size.split("x");
		const bench = (env) => `${env} timeout 1500 xvfb-run -a -s "-screen 0 ${w}x${h}x24" glmark2-es2 -s ${size} ${scenes.map((s) => `-b ${s}`).join(" ")} 2>&1`;
		await run("glmark2-virgl", bench(VIRGL));
		await run("glmark2-llvmpipe", bench(LLVMPIPE));
	}

	result.gl = vm.gl.stats;
	result.totalS = Number(secs());
	await post("/result", JSON.stringify(result));
	log("done");
	await vm.stop();
}

main().catch(async (e) => {
	log(`error: ${e?.stack || e}`);
	await post("/result", JSON.stringify({ error: String(e?.stack || e) }));
});
