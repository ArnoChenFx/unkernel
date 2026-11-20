// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest pc sampling (createKernel({ profile }), js/core/profile.ts and the
// kernel's arch/wasm/kernel/prof.c) on the bundled kernel's base shell: a
// busy awk is the dominant command in instruction samples (the UP kernel,
// inline) and in time samples (the SMP kernel on 2 CPUs, in a worker);
// without the option the kernel's rings stay untouched; a snapshot taken
// while sampling restores without it, sampling off.
//
//   node --test test/profile.test.ts
//   UNKERNEL_TEST_KERNEL=path ...    # another bundle instead of the bundled kernel
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, bundledKernelUrl, type KernelHandle, type KernelInstance } from "../js/node.ts";

const testKernel = process.env.UNKERNEL_TEST_KERNEL ? path.resolve(process.env.UNKERNEL_TEST_KERNEL) : undefined;
const kernelModule = await WebAssembly.compile(readFileSync(testKernel ?? fileURLToPath(bundledKernelUrl)));
const hasSmp = WebAssembly.Module.customSections(kernelModule, "unkernel.kernel.smp.kwpatch").length > 0;

/** About 1.6 G instructions of busybox awk (a second or two with the JIT). */
const BUSY = ["BEGIN{for(i=0;i<200000;i++)s+=i; print s}"];
const BUSY_OUT = "19999900000\n";

type BootOptions = NonNullable<Parameters<typeof createKernel>[0]>;
const boot = async (t: { after(fn: () => unknown): void }, opts: BootOptions) => {
	const logs: string[] = [];
	const vm = await createKernel({ kernel: testKernel, log: (m) => logs.push(m), ...opts });
	t.after(() => vm.stop({ reason: "test cleanup" }));
	return { vm, logs };
};

/** The kernel's struct kw_prof (asm/kwprof.h): flags, and each ring's head, tail and dropped count. */
function rings(vm: KernelHandle): { flags: number; rings: { head: number; tail: number; dropped: number }[] } {
	const k = (vm as KernelInstance).kernel; // inline instances only
	const g = k.exports!.kw_prof as WebAssembly.Global;
	const a = Number(g.value);
	const dv = new DataView(k.memory.buffer);
	const nr = dv.getUint32(a + 16, true), stride = dv.getUint32(a + 28, true), off = dv.getUint32(a + 32, true);
	return {
		flags: dv.getUint32(a + 4, true),
		rings: Array.from({ length: nr }, (_, c) => {
			const r = a + off + c * stride;
			return { head: dv.getUint32(r, true), tail: dv.getUint32(r + 32, true), dropped: dv.getUint32(r + 4, true) };
		}),
	};
}

test("profile off: the kernel's rings stay untouched, and profile() is undefined", async (t) => {
	const { vm } = await boot(t, {});
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const r = rings(vm);
	assert.equal(r.flags, 0);
	assert.ok(r.rings.every((x) => x.head === 0 && x.tail === 0 && x.dropped === 0), JSON.stringify(r.rings));
	assert.equal(await vm.profile(), undefined);
});

test("profile on the UP kernel: instruction samples only, awk dominant", async (t) => {
	const { vm, logs } = await boot(t, { profile: { insns: 100000 } });
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const p = (await vm.profile())!;
	assert.ok(logs.some((l) => l.includes("time samples need")), logs.join("\n"));
	assert.equal(p.timeSampling, false);
	assert.equal(p.insnPeriod, 100000);
	assert.equal(p.totals.user, 0);
	assert.ok(p.totals.insns > 5000, `${p.totals.insns} instruction samples`);
	assert.equal(p.totals.dropped, 0);
	const top = [...p.comms].sort((a, b) => b.insns - a.insns)[0]!;
	assert.equal(top.comm, "awk");
	assert.ok(top.insns > p.totals.insns * 0.8, JSON.stringify(p.comms.slice(0, 4)));
	assert.ok(p.rows.length > 10 && p.pages.length > 1);
	assert.equal(rings(vm).flags, 2);
});

test("profile on 2 CPUs (SMP kernel, worker): time and instruction samples, awk dominant, tiers named", { skip: !hasSmp && "the bundle has no SMP kernel (kernel/build.sh smp)" }, async (t) => {
	const { vm } = await boot(t, { worker: true, cpus: 2, profile: { hz: 1000, insns: 1000000 } });
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const p = (await vm.profile())!;
	assert.equal(p.timeSampling, true);
	assert.equal(p.cpus, 2);
	assert.ok(p.totals.ticks > 1000, `${p.totals.ticks} ticks`);
	assert.ok(p.totals.user > 500, `${p.totals.user} user samples`);
	assert.ok(p.totals.insns > 500, `${p.totals.insns} instruction samples`);
	const top = p.comms[0]!;
	assert.equal(top.comm, "awk", JSON.stringify(p.comms.slice(0, 4)));
	assert.ok(top.user > p.totals.user * 0.6);
	const awkRows = p.rows.filter((r) => r.comm === "awk" && r.timeSamples);
	assert.ok(awkRows.some((r) => r.tier === "compiled" || r.tier === "decoded"), JSON.stringify(awkRows.slice(0, 4)));
	assert.ok(awkRows.some((r) => r.prevBlockPc), "time samples name the block that ran before");
	const res = await vm.stop();
	assert.equal(res.kind, "stopped");
	const last = (await vm.profile())!;
	assert.ok(last.totals.user >= p.totals.user);
});

test("profile and snapshots: a snapshot taken while sampling restores without the option, sampling off", async (t) => {
	const { vm } = await boot(t, { profile: { insns: 100000 } });
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const snap = await vm.snapshot({ stop: true });
	await vm.exited;
	const before = rings(vm).rings[0]!;
	const { vm: vm2 } = await boot(t, { restore: snap });
	assert.equal(rings(vm2).flags, 0);
	assert.equal((await vm2.exec("awk", BUSY)).stdout, BUSY_OUT);
	const after = rings(vm2).rings[0]!;
	assert.equal(after.head, before.head);
	assert.equal(await vm2.profile(), undefined);
	// And with the option again: it starts from what the rings hold.
	const snap2 = await vm2.snapshot({ stop: true });
	await vm2.exited;
	const { vm: vm3 } = await boot(t, { restore: snap2, profile: { insns: 100000 } });
	assert.equal((await vm3.exec("awk", BUSY)).stdout, BUSY_OUT);
	const p = (await vm3.profile())!;
	assert.equal(p.comms[0]!.comm, "awk"); // by instructions, without time samples
	assert.ok(p.totals.insns > 5000 && p.totals.insns < 40000, `${p.totals.insns} instruction samples (only this boot's)`);
});
