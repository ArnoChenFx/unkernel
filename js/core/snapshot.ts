// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Machine snapshots: what Kernel.snapshot() returns and KernelConfig.restore
// takes, and a compact byte encoding of it.
//
// The kernel parks every task at a point where all of its state is in
// memory (arch/wasm/kernel/park.c), so a snapshot is the memory plus a few
// host values. Disks are not copied: the snapshot records each disk's
// identity and write generation (BlockDevice.snapshotState, core/block.ts),
// and a restore refuses disks that changed since. The other devices keep
// their host side's state (DeviceSnapshots): what the kernel told the host
// once (an attachment, an open mask, a stream state), which a restored
// kernel does not tell again. Connections do not survive: the kernel
// resets its vsock connections after a restore (kwvsock), and the network
// stack answers TCP segments of flows it does not know with RST.

import type { BlockDevice, DiskSnapshotState } from "./block.ts";
import type { DisplaySnapshot } from "./display.ts";
import type { InputSnapshot } from "./input.ts";
import type { ShmSnapshot } from "./shm.ts";
import type { SoundSnapshot } from "./sound.ts";
import type { VsockSnapshot } from "./vsock.ts";

/**
 * The host side of each device the machine had. A key is present when the
 * device was configured; its value is null if the kernel had not started
 * its driver yet (it then starts it after the restore, as at boot).
 */
export interface DeviceSnapshots {
	display?: DisplaySnapshot | null;
	input?: InputSnapshot | null;
	sound?: SoundSnapshot | null;
	vsock?: VsockSnapshot | null;
	shm?: ShmSnapshot | null;
	/** The MAC the guest's kwnet got. */
	network?: { mac: number[] } | null;
}

/** The devices of DeviceSnapshots that a restore must find configured, or not, as saved. */
export type DeviceKind = "display" | "sound" | "vsock" | "shm" | "network";
const DEVICE_KINDS: readonly DeviceKind[] = ["display", "sound", "vsock", "shm", "network"];

/** A saved machine (Kernel.snapshot()). */
export interface KernelSnapshot {
	version: 1;
	/** The kernel build it came from (Kernel.fingerprint); restore refuses another. */
	fingerprint: string;
	memory64: boolean;
	/** All of the kernel's memory; the pages it reported free are zero. */
	memory: Uint8Array;
	/** Bytes of free pages left out of `memory` (0 if the kernel reported none). */
	freeBytes?: number;
	/** The guest's monotonic clock at the snapshot, in ms; a restore continues from it. */
	monotonicMs: number;
	/** rows << 16 | cols, 0 = unknown. */
	consoleSize: number;
	/** Console input the guest had not read yet. */
	input: Uint8Array;
	/** The disks, in order (/dev/wda, wdb, ...); a restore needs the same ones, unchanged. */
	disks: DiskSnapshotState[];
	/** The other devices (empty in snapshots from before devices were saved). */
	devices: DeviceSnapshots;
}

/**
 * Why a machine with the devices `present` (and the network MAC `mac`, if
 * set) cannot resume `saved`, or null if it can: the restored kernel has
 * exactly the drivers it had, so each device must be configured, or not,
 * as it was.
 */
export function snapshotDeviceMismatch(saved: DeviceSnapshots, present: Record<DeviceKind, boolean>, mac?: Uint8Array): string | null {
	for (const kind of DEVICE_KINDS) {
		const had = kind in saved && saved[kind] !== undefined;
		if (had && !present[kind]) return `the snapshot has a ${kind} device, which this machine is not given`;
		if (!had && present[kind]) return `the snapshot has no ${kind} device, but this machine is given one`;
	}
	const m = saved.network?.mac;
	if (m && mac && (m.length !== mac.length || m.some((b, i) => b !== mac[i])))
		return "the network device has another MAC than in the snapshot";
	return null;
}

const diskName = (i: number) => `wd${String.fromCharCode(97 + i)}`;

/**
 * Why `disks` cannot resume `saved` (a snapshot's disks), or null if they
 * can: the same number of disks, each with the same identity, write
 * generation and stamp. A disk that changed after the snapshot would not match the
 * restored kernel's caches (its file systems would be corrupted).
 */
export function snapshotDiskMismatch(saved: DiskSnapshotState[], disks: BlockDevice[]): string | null {
	for (let i = 0; i < Math.max(saved.length, disks.length); i++) {
		const s = saved[i], d = disks[i];
		if (!d) return `disk ${diskName(i)} (${s!.name}) is missing: the snapshot has ${saved.length} disk(s), ${disks.length} given`;
		if (!s) return `disk ${diskName(i)} was not in the snapshot: it has ${saved.length} disk(s), ${disks.length} given`;
		if (typeof d.snapshotState !== "function") return `disk ${diskName(i)} cannot be checked against the snapshot (no snapshotState)`;
		let now: DiskSnapshotState;
		try {
			now = d.snapshotState();
		} catch (e) {
			return `disk ${diskName(i)}: ${(e as Error).message}`;
		}
		if (now.identity !== s.identity)
			return `disk ${diskName(i)} (${now.name}) is not the disk of the snapshot (${s.name})`;
		if (now.gen !== s.gen)
			return `disk ${diskName(i)} (${now.name}) was written after the snapshot (generation ${now.gen}, the snapshot has ${s.gen})`;
		if ((now.stamp ?? "") !== (s.stamp ?? ""))
			return `disk ${diskName(i)} (${now.name}) was changed by another program after the snapshot (${s.stamp ?? "-"}, now ${now.stamp ?? "-"})`;
	}
	return null;
}

const PAGE = 4096;

/**
 * Copy the kernel's memory for a snapshot, leaving out the pages the kernel
 * reported free (`free`: one bit per 4 KiB page, least significant bit
 * first, for the first `bits` pages): they stay zero in the copy, which
 * is what a restore gives them. Without `free` it is a plain copy.
 * Returns the copy and the bytes left out.
 */
export function copySnapshotMemory(mem: Uint8Array, free: Uint8Array | null, bits: number): { memory: Uint8Array; freeBytes: number } {
	if (!free || !bits) return { memory: mem.slice(), freeBytes: 0 };
	const out = new Uint8Array(mem.byteLength); // zero, and untouched pages cost nothing
	const pages = Math.min(bits, Math.floor(mem.byteLength / PAGE), free.length * 8);
	let runStart = -1, skipped = 0;
	const flush = (end: number) => {
		if (runStart >= 0) out.set(mem.subarray(runStart * PAGE, end * PAGE), runStart * PAGE);
		runStart = -1;
	};
	for (let p = 0; p < pages;) {
		const b = free[p >> 3]!;
		if ((p & 7) === 0 && p + 8 <= pages && (b === 0 || b === 0xff)) {
			if (b === 0) { if (runStart < 0) runStart = p; } else { flush(p); skipped += 8; }
			p += 8;
			continue;
		}
		if (b & (1 << (p & 7))) { flush(p); skipped++; } else if (runStart < 0) runStart = p;
		p++;
	}
	flush(pages);
	if (pages * PAGE < mem.byteLength) out.set(mem.subarray(pages * PAGE), pages * PAGE);
	return { memory: out, freeBytes: skipped * PAGE };
}

const MAGIC = "KWSNAP1\n";
const CHUNK = 65536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Int32 words: about 4x faster than BigUint64 (no BigInt per word).
function isZero(u8: Uint8Array, off: number): boolean {
	const w = new Int32Array(u8.buffer, u8.byteOffset + off, CHUNK / 4);
	for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
	return true;
}

/**
 * Encode a snapshot: MAGIC, a u32 header length, the JSON header (everything
 * but the memory and the input), the input, then each non-zero 64 KiB chunk
 * of the memory as a u32 chunk index and its bytes. Little-endian.
 */
export function encodeSnapshot(s: KernelSnapshot): Uint8Array {
	const mem = s.memory;
	if (mem.byteLength % CHUNK || mem.byteOffset % 4) throw new Error("snapshot memory must be whole 64 KiB pages");
	const chunks: number[] = [];
	for (let off = 0; off < mem.byteLength; off += CHUNK) if (!isZero(mem, off)) chunks.push(off / CHUNK);
	const header = encoder.encode(JSON.stringify({
		version: s.version, fingerprint: s.fingerprint, memory64: s.memory64, memoryBytes: mem.byteLength,
		freeBytes: s.freeBytes ?? 0, monotonicMs: s.monotonicMs, consoleSize: s.consoleSize, inputBytes: s.input.length, chunks: chunks.length,
		disks: s.disks, devices: s.devices,
	}));
	const out = new Uint8Array(MAGIC.length + 4 + header.length + s.input.length + chunks.length * (4 + CHUNK));
	const dv = new DataView(out.buffer);
	let p = 0;
	out.set(encoder.encode(MAGIC), p);
	p += MAGIC.length;
	dv.setUint32(p, header.length, true);
	p += 4;
	out.set(header, p);
	p += header.length;
	out.set(s.input, p);
	p += s.input.length;
	for (const c of chunks) {
		dv.setUint32(p, c, true);
		out.set(mem.subarray(c * CHUNK, (c + 1) * CHUNK), p + 4);
		p += 4 + CHUNK;
	}
	return out;
}

export function decodeSnapshot(bytes: Uint8Array): KernelSnapshot {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (decoder.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("not an unkernel snapshot");
	let p = MAGIC.length;
	const hlen = dv.getUint32(p, true);
	p += 4;
	const h = JSON.parse(decoder.decode(bytes.subarray(p, p + hlen)));
	p += hlen;
	if (h.version !== 1) throw new Error(`unsupported snapshot version ${h.version}`);
	const input = bytes.slice(p, p + h.inputBytes);
	p += h.inputBytes;
	const memory = new Uint8Array(h.memoryBytes);
	for (let i = 0; i < h.chunks; i++) {
		const c = dv.getUint32(p, true);
		memory.set(bytes.subarray(p + 4, p + 4 + CHUNK), c * CHUNK);
		p += 4 + CHUNK;
	}
	return { version: 1, fingerprint: h.fingerprint, memory64: h.memory64, memory, freeBytes: h.freeBytes ?? 0, monotonicMs: h.monotonicMs, consoleSize: h.consoleSize, input,
		disks: Array.isArray(h.disks) ? h.disks : [], devices: h.devices && typeof h.devices === "object" ? h.devices : {} };
}
