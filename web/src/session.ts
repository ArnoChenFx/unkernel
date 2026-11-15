// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The suspended session: Suspend (Ctrl-A s, KW.suspend()) saves the running
// machine with the SDK's snapshot({ stop: true }) and keeps it here, in
// IndexedDB "kwsnap:session-v1" (its own database; the data disk's
// kwdisk:kwdata-v1 is never touched here); the next load offers to resume
// it (boot.ts). One session at a time: "meta" (small, read to decide
// whether to offer) and "bytes" (the encoded snapshot, a Blob) are written
// in one transaction and deleted together.
//
// Saving when the tab closes is not done: the save needs the kernel to
// park, the memory copied and encoded (about 150 ms with the CLI,
// 2026-11-15) and about 30 MiB committed to IndexedDB, and a page that is
// going away gets no guarantee that a transaction it starts commits. A snapshot taken
// without stopping (when the tab is hidden) would not help either: the
// guest keeps writing /data, which makes it unrestorable within seconds.
import { decodeSnapshot, encodeSnapshot, type DiskSnapshotState, type KernelSnapshot } from "./sdk.ts";

const DB = "kwsnap:session-v1";
const STORE = "session";

/** What the page needs to decide whether it can offer to resume. */
export interface SessionMeta {
	/** Date.now() when it was saved. */
	saved: number;
	/** The page's kernel (a hashed asset URL in builds: another release cannot resume it). */
	kernelUrl: string;
	/** Linux's banner of the kernel that saved it. */
	fingerprint: string;
	memoryMiB: number;
	/** The options that decide the machine's devices: a restore needs the same. */
	devices: SessionDevices;
	/** The disks as the snapshot recorded them (identity and write generation). */
	disks: DiskSnapshotState[];
	/** Encoded size in bytes. */
	bytes: number;
	/** What the console showed last (the guest's output, from a line start), shown again on resume. */
	screen?: string;
	/** Saved in worker mode (either mode can resume it). */
	worker: boolean;
}

export interface SessionDevices {
	display: boolean;
	sound: boolean;
	net: boolean;
	data: boolean;
}

const reqP = <T>(r: IDBRequest<T>): Promise<T> =>
	new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T> | T): Promise<T> {
	const db = await openDb();
	try {
		const tx = db.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
		});
		const r = await fn(tx.objectStore(STORE));
		await done;
		return r;
	} finally {
		db.close();
	}
}

/** The saved session's meta, or null (none, or no IndexedDB). */
export async function sessionInfo(): Promise<SessionMeta | null> {
	if (typeof indexedDB === "undefined") return null;
	const m = await run("readonly", (s) => reqP(s.get("meta")));
	return m && typeof m === "object" && typeof (m as SessionMeta).saved === "number" ? m as SessionMeta : null;
}

/** The saved snapshot, decoded. */
export async function loadSession(): Promise<KernelSnapshot> {
	const b = await run("readonly", (s) => reqP(s.get("bytes")));
	if (!(b instanceof Blob)) throw new Error("the suspended session has no snapshot data");
	return decodeSnapshot(new Uint8Array(await b.arrayBuffer()));
}

/** Encode and keep `snap` (replacing any saved session). Returns the encoded size. */
export async function saveSession(snap: KernelSnapshot, meta: Omit<SessionMeta, "fingerprint" | "memoryMiB" | "disks" | "bytes">): Promise<number> {
	const bytes = encodeSnapshot(snap);
	const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
	const full: SessionMeta = { ...meta, fingerprint: snap.fingerprint, memoryMiB: snap.memory.byteLength / 1048576, disks: snap.disks, bytes: bytes.length };
	await run("readwrite", (s) => {
		s.put(blob, "bytes");
		s.put(full, "meta");
	});
	return bytes.length;
}

/** Forget the saved session. */
export async function clearSession(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	await run("readwrite", (s) => { s.clear(); });
}

/** Why `m` cannot be resumed with these options and this kernel, or null if it can. */
export function sessionMismatch(m: SessionMeta, kernelUrl: string, devices: SessionDevices): string | null {
	if (m.kernelUrl !== kernelUrl) return "it was saved by another kernel release";
	const names: Record<keyof SessionDevices, string> = { display: "Display", sound: "Sound", net: "Network", data: "Data disk" };
	for (const k of Object.keys(names) as Array<keyof SessionDevices>)
		if (m.devices[k] !== devices[k]) return `it was saved with ${names[k]} ${m.devices[k] ? "on" : "off"} (Options)`;
	return null;
}

/**
 * What the console showed of the guest, to show again on resume: the last
 * `max` characters, from a line start.
 */
export class ScreenTail {
	#chunks: string[] = [];
	#length = 0;
	readonly max: number;
	constructor(max = 65536) {
		this.max = max;
	}
	push(t: string): void {
		this.#chunks.push(t);
		this.#length += t.length;
		while (this.#length - this.#chunks[0]!.length >= this.max) this.#length -= this.#chunks.shift()!.length;
	}
	text(): string {
		const all = this.#chunks.join("");
		if (all.length <= this.max) return all;
		const from = all.indexOf("\n", all.length - this.max);
		return from < 0 ? all.slice(-this.max) : all.slice(from + 1);
	}
}
