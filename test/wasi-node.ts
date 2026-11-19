#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Boot the kernel with Node's own node:wasi (uvwasi) providing every
// wasi_snapshot_preview1 import, instead of the SDK's js/core/wasi.ts. This checks
// that the kernel works with a third-party WASI preview 1 implementation.
// Only the `unkernel` imports come from here: task switching (JSPI) and
// stubs for no block device, no network device and no JIT (kwemu interprets).
//
//   node test/wasi-node.ts [--verbose]
//   node test/wasi-node.ts --run KERNEL INITRD "CMDLINE" [MiB]
//
// Cases: kwtest on vmlinux32.wasm and on vmlinux (memory64), and Alpine on
// vmlinux32.wasm with commands typed into a stdin pipe. The Alpine case
// guards against uvwasi's zero-timeout poll_oneoff, which reports only the
// clock event even when stdin is readable (kernel wasi.c, wasi_stdin_readable).
// --run boots one kernel with the console on stdio; proc_exit's code
// becomes the process exit code.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleIsMemory64 } from "../js/core/kernel.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);

if (args[0] === "--run") await run(args[1]!, args[2]!, args[3], args[4]);
else await test();

async function run(kernelPath: string, initrdPath: string, cmdline = "console=hvc0", mib = "256"): Promise<void> {
	const { WASI } = await import("node:wasi");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unkernel-wasi-"));
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	fs.copyFileSync(initrdPath, path.join(dir, "initrd"));

	const wasi = new WASI({
		version: "preview1",
		args: ["vmlinux", cmdline],
		env: {},
		preopens: { "/": dir },
		returnOnExit: false, // proc_exit -> process.exit(code)
	});
	const module = new WebAssembly.Module(fs.readFileSync(kernelPath));
	const pages = Math.ceil((Number(mib) * 1048576) / 65536);
	const memory = moduleIsMemory64(module)
		? new WebAssembly.Memory({ initial: BigInt(pages), maximum: BigInt(pages), address: "i64" } as unknown as WebAssembly.MemoryDescriptor)
		: new WebAssembly.Memory({ initial: pages, maximum: pages });
	wasi.initialize({ exports: { memory } }); // binds node:wasi to the imported memory

	const fatal = (m: string): never => {
		process.stderr.write(`[wasi-node] ${m}\n`);
		process.exit(255);
	};
	const ENODEV = 19;
	const resumers = new Map<bigint, (t: bigint) => void>();
	let retFromFork: (prev: bigint, next: bigint) => Promise<unknown>;
	const unkernel = {
		// Same contract as kernel.mjs: park prev, run next; resolves with the
		// task that later switches back to prev.
		wasm_switch_to: new WebAssembly.Suspending((prev: bigint, next: bigint, isNew: unknown, prevDead: unknown) => {
			const parked = prevDead ? new Promise(() => {}) : new Promise<bigint>((r) => resumers.set(prev, r));
			if (isNew) {
				resumers.delete(next); // a parked task resumes on a fresh stack (park.c)
				queueMicrotask(() => retFromFork(prev, next).then(
					() => fatal("task returned from ret_from_fork"), (e) => fatal(`wasm trap: ${e?.stack ?? e}`)));
			} else {
				const resume = resumers.get(next);
				if (!resume) fatal(`switch to unknown task 0x${next.toString(16)}`);
				resumers.delete(next);
				resume!(prev);
			}
			return parked;
		}),
		wasm_dump_stacktrace: () => {},
		wasm_snapshot_point: () => -95, // EOPNOTSUPP; called only after IRQ 8, which this host never raises
		wasm_driver_console_size: () => 0,
		wasm_driver_block_info: () => -ENODEV,
		wasm_driver_block_submit: () => -ENODEV,
		wasm_driver_block_reap: () => 0n,
		wasm_driver_net_init: () => -BigInt(ENODEV),
		wasm_driver_net_rx_len: () => 0n,
		wasm_driver_net_recv: () => 0n,
		wasm_driver_net_send: () => 0n,
		wasm_driver_fb_init: () => -BigInt(ENODEV),
		wasm_driver_fb_attach: () => 0,
		wasm_driver_fb_mode: () => 0,
		wasm_driver_input_init: () => -BigInt(ENODEV),
		wasm_driver_input_read: () => 0n,
		wasm_driver_input_state: () => {},
		wasm_driver_sound_init: () => -BigInt(ENODEV),
		wasm_driver_sound_event: () => {},
		wasm_driver_sound_write: () => 0n,
		wasm_driver_vsock_init: () => -ENODEV,
		wasm_driver_vsock_send: () => -ENODEV,
		wasm_driver_vsock_rx_len: () => 0,
		wasm_driver_vsock_recv: () => 0,
		wasm_driver_vsock_keep: () => 0,
		wasm_driver_shm_init: () => -ENODEV,
		wasm_driver_shm_request: () => 0,
		wasm_driver_shm_attach: () => {},
		wasm_driver_shm_detach: () => {},
		wasm_driver_shm_reply: () => {},
		// kwemu's JIT tier (js/core/jit.ts): not offered here, so kwemu
		// only interprets and never calls the other two.
		kw_host_jit_caps: () => 0,
		kw_host_jit_compile: () => -1,
		kw_host_jit_free: () => {},
	};
	const instance = new WebAssembly.Instance(module, {
		env: { memory },
		unkernel,
		wasi_snapshot_preview1: wasi.wasiImport,
	} as unknown as WebAssembly.Imports);
	retFromFork = WebAssembly.promising(instance.exports.ret_from_fork as () => unknown);
	WebAssembly.promising(instance.exports._start as () => unknown)().then(
		() => fatal("_start returned"), (e) => fatal(`wasm trap: ${e?.stack ?? e}`));
}

interface Case {
	name: string;
	kernel: string;
	initrd: string;
	cmdline?: string;
	mib?: number;
	/** [wait for, then type] */
	script?: Array<[RegExp, string] & { from?: number }>;
	expect: RegExp[];
}

async function test(): Promise<void> {
	const verbose = args.includes("--verbose");
	const k32 = path.join(root, "vendor/build/kernel/vmlinux32.wasm");
	const k64 = path.join(root, "vendor/build/kernel/vmlinux");
	const alpineCpio = path.join(root, "vendor/build/initramfs/alpine.cpio");
	const testCpio = path.join(root, "vendor/build/initramfs/alpine-test.cpio");
	const kwtest = { initrd: testCpio, cmdline: "console=hvc0 rdinit=/usr/bin/kwtest", expect: [/kwtest: 0 failure\(s\)/] };
	const cases: Case[] = [
		{ name: "kwtest vmlinux32.wasm", kernel: k32, ...kwtest },
		{ name: "kwtest vmlinux (memory64)", kernel: k64, ...kwtest },
		{
			name: "alpine vmlinux32.wasm, stdin pipe", kernel: k32, initrd: alpineCpio, mib: 512,
			cmdline: "console=hvc0 rdinit=/init",
			// [wait for, then type]
			script: [[/⇒/, "uname -a; apk --version\n"], [/apk-tools \S+/, "poweroff\n"]],
			expect: [/Linux unkernel .* aarch64 Linux/, /apk-tools \S+, compiled for aarch64/, /reboot: Power down/],
		},
	];

	const results: boolean[] = [];
	for (const c of cases) {
		const missing = [c.kernel, c.initrd].filter((f) => !fs.existsSync(f));
		if (missing.length) {
			console.log(`FAIL ${c.name}: missing ${missing.map((f) => path.relative(root, f)).join(", ")}`);
			results.push(false);
			continue;
		}
		const { code, out } = await boot(c, verbose);
		const unmet = c.expect.filter((re) => !re.test(out));
		const ok = code === 0 && !unmet.length;
		const detail = ok ? `exit 0` : `exit ${code}${unmet.length ? `, no match for ${unmet.join(" ")}` : ""}`;
		console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: ${detail}`);
		if (!ok && !verbose) process.stdout.write(out.split("\n").slice(-15).map((l) => `     | ${l}`).join("\n") + "\n");
		results.push(ok);
	}
	const ok = results.every(Boolean);
	console.log(ok ? "PASS" : "FAIL");
	process.exit(ok ? 0 : 1);
}

function boot(c: Case, verbose: boolean, timeoutMs = 120000): Promise<{ code: number | string; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath,
			["--no-warnings", fileURLToPath(import.meta.url), "--run", c.kernel, c.initrd, c.cmdline ?? "console=hvc0", String(c.mib ?? 256)],
			{ stdio: [c.script ? "pipe" : "ignore", "pipe", "pipe"] });
		let out = "";
		let step = 0;
		const onData = (d: string) => {
			out += d;
			if (verbose) process.stdout.write(d);
			// Type the next line once its trigger shows up after the previous one.
			while (c.script && step < c.script.length && c.script[step]![0].test(out.slice(c.script[step]!.from ?? 0))) {
				child.stdin!.write(c.script[step]![1]);
				if (++step < c.script.length) c.script[step]!.from = out.length;
			}
		};
		child.stdout!.setEncoding("utf8").on("data", onData);
		child.stderr!.setEncoding("utf8").on("data", onData);
		const timer = setTimeout(() => {
			out += `\n[wasi-node] timeout after ${timeoutMs / 1000} s\n`;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code ?? signal ?? "?", out });
		});
	});
}
