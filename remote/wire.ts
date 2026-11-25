// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The remote kernel's wire format (remote/backend.ts serves it, remote/web/link.ts
// speaks it): one WebSocket carries a kernel's messages (worker-protocol.ts)
// and the calls of a host file system for /work (fs.ts), both as binary
// frames. A frame is a little-endian u32 header length, the header (JSON: the
// value, its binary parts as tags, and the length of each part) and the parts.
// Universal: the browser and Node or Bun encode and decode the same bytes.

import { ERRNO, FsError, type Fs, type FsAttr, type FsDirEntry, type FsFile, type FsOpenFlags, type FsSetAttr, type FsStatFs } from "../js/core/fs.ts";
import type { FromWorker, ToWorker } from "../js/core/worker-protocol.ts";

/** The wire version: the page and the backend must agree on it (their hello). */
export const REMOTE_WIRE = 2;
/** The page's WebSocket, on the backend's origin. */
export const REMOTE_WS_PATH = "/remote/ws";
/** The backend's description of itself (JSON), on the same origin. */
export const REMOTE_INFO_PATH = "/remote/info";
/** The close code a page gets when another page takes its kernel over (a private code: 4000 to 4999). */
export const REMOTE_TAKEN_OVER = 4001;

type ViewCtor = { readonly BYTES_PER_ELEMENT: number; new (buffer: ArrayBuffer, byteOffset: number, length: number): ArrayBufferView };
type Bytes = Uint8Array<ArrayBuffer>;

const VIEWS: Record<string, ViewCtor> = {
	Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

const NUMBERS: Record<string, number> = { NaN, Infinity, "-Infinity": -Infinity, "-0": -0 };

/**
 * Encode a value for the wire: plain data, Map, Set, Date, URL, Error,
 * bigint, undefined, NaN and -0, and binary (ArrayBuffer, typed arrays,
 * DataView) as parts. A function, a symbol, a WebAssembly.Module or a
 * SharedArrayBuffer view would not survive the trip, so they throw.
 */
export function encodeRemote(value: unknown): Bytes {
	const parts: Bytes[] = [];
	const part = (type: string, bytes: Bytes) => {
		parts.push(bytes);
		return { $a: [type, parts.length - 1] };
	};
	const tag = (v: unknown): unknown => {
		if (v === undefined) return { $u: 0 };
		if (v === null || typeof v === "boolean" || typeof v === "string") return v;
		if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $n: Object.is(v, -0) ? "-0" : String(v) };
		if (typeof v === "bigint") return { $b: v.toString() };
		if (typeof v !== "object") throw new TypeError(`remote: a ${typeof v} cannot cross the wire`);
		if (v instanceof ArrayBuffer) return part("ArrayBuffer", new Uint8Array(v.slice(0)));
		if (ArrayBuffer.isView(v)) {
			if (v instanceof DataView) return part("DataView", new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
			return part(Object.prototype.toString.call(v).slice(8, -1), new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
		}
		if (Array.isArray(v)) return v.map(tag);
		if (v instanceof Map) return { $m: [...v].map(([k, x]) => [tag(k), tag(x)]) };
		if (v instanceof Set) return { $s: [...v].map(tag) };
		if (v instanceof Date) return { $d: v.getTime() };
		if (v instanceof URL) return { $U: v.href };
		if (v instanceof Error) {
			const r: Record<string, unknown> = { n: v.name, m: v.message };
			if (v.stack !== undefined) r.s = v.stack;
			if (v.cause !== undefined) r.c = tag(v.cause);
			return { $r: r };
		}
		if (typeof WebAssembly !== "undefined" && v instanceof WebAssembly.Module) throw new TypeError("remote: a WebAssembly.Module cannot cross the wire");
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v)) out[k.startsWith("$") ? `$${k}` : k] = tag((v as Record<string, unknown>)[k]);
		return out;
	};
	const header = new TextEncoder().encode(JSON.stringify({ x: tag(value), b: parts.map((p) => p.byteLength) }));
	let size = 4 + header.byteLength;
	for (const p of parts) size += p.byteLength;
	const out: Bytes = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, header.byteLength, true);
	out.set(header, 4);
	let off = 4 + header.byteLength;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out;
}

/** The inverse of encodeRemote(). Binary parts are copies, so the frame may be reused. */
export function decodeRemote(frame: Uint8Array): unknown {
	const hlen = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
	const head = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + hlen))) as { x: unknown; b: number[] };
	const parts: Bytes[] = [];
	let off = 4 + hlen;
	for (const len of head.b) {
		parts.push(frame.slice(off, off + len) as Bytes);
		off += len;
	}
	const view = (type: string, bytes: Bytes): unknown => {
		if (type === "ArrayBuffer") return bytes.buffer;
		if (type === "DataView") return new DataView(bytes.buffer);
		if (type === "Uint8Array") return bytes;
		const Ctor = VIEWS[type];
		if (!Ctor) throw new TypeError(`remote: unknown binary type ${type}`);
		return new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
	};
	const untag = (t: unknown): unknown => {
		if (t === null || typeof t !== "object") return t;
		if (Array.isArray(t)) return t.map(untag);
		const o = t as Record<string, unknown>;
		const keys = Object.keys(o);
		if (keys.length === 1) {
			const k = keys[0]!;
			const x = o[k];
			switch (k) {
				case "$u": return undefined;
				case "$n": return NUMBERS[x as string];
				case "$b": return BigInt(x as string);
				case "$a": {
					const [type, i] = x as [string, number];
					return view(type, parts[i]!);
				}
				case "$m": return new Map((x as [unknown, unknown][]).map(([a, b]) => [untag(a), untag(b)]));
				case "$s": return new Set((x as unknown[]).map(untag));
				case "$d": return new Date(x as number);
				case "$U": return new URL(x as string);
				case "$r": {
					const r = x as { n?: string; m?: string; s?: string; c?: unknown };
					const e = new Error(r.m ?? "", r.c !== undefined ? { cause: untag(r.c) } : undefined);
					e.name = r.n ?? "Error";
					if (r.s !== undefined) e.stack = r.s;
					return e;
				}
			}
		}
		const out: Record<string, unknown> = {};
		for (const k of keys) out[k.startsWith("$$") ? k.slice(1) : k] = untag(o[k]);
		return out;
	};
	return untag(head.x);
}

/**
 * Page -> backend: a kernel message, a call of the /work file system (id answered
 * by "fsr"), or the page's report that it typed the console command (`typed`).
 */
export type RemoteRequest =
	| { k: "kernel"; m: ToWorker }
	| { k: "fs"; id: number; op: RemoteFsOp; a: unknown[] }
	| { k: "session"; op: "typed" };

/** The kernel the backend runs, as a page connects to it (null machine: none runs). */
export interface RemoteSession {
	machine: RemoteMachineInfo | null;
	/** Why the last kernel ended, once one has (null before that). */
	ended: string | null;
}

/** A kernel's boot spec identity (the kernel and distro URLs, GL) and what it has done. */
export interface RemoteMachineInfo {
	state: "booting" | "running" | "ending";
	kernel: string | null;
	distro: string | null;
	/** Guest GL on: its renderer is the page's, so the kernel stops with that page. */
	gl: boolean;
	/** The kernel outlives the page that boots it (its page asked to keep it, and it has no GL). */
	keep: boolean;
	/** A page reported that it typed the console command. */
	typed: boolean;
}

/** Backend -> page. */
export type RemoteReply =
	| { k: "hello"; wire: number; fs: RemoteFsCaps | null; net: boolean; data: string | null; work: string | null; session: RemoteSession }
	| { k: "kernel"; m: FromWorker }
	| { k: "fsr"; id: number; ok: true; v: unknown }
	| { k: "fsr"; id: number; ok: false; code: string; message: string };

/** The file system calls: an Fs method, or an open file's (f-prefixed). */
export type RemoteFsOp =
	| "getattr" | "readdir" | "readlink" | "open" | "create" | "mkdir" | "symlink" | "remove" | "rename" | "setattr" | "statfs"
	| "fread" | "fwrite" | "fgetattr" | "fsetattr" | "ffsync" | "fclose";

/** Which optional methods of an Fs the backend has (the page's proxy has only those). */
export interface RemoteFsCaps {
	create: boolean;
	mkdir: boolean;
	symlink: boolean;
	readlink: boolean;
	remove: boolean;
	rename: boolean;
	setattr: boolean;
	statfs: boolean;
}

/** Which optional methods of an open file the backend has. */
export interface RemoteFileCaps {
	write: boolean;
	getattr: boolean;
	setattr: boolean;
	fsync: boolean;
}

interface RemoteOpened {
	h: number;
	c: RemoteFileCaps;
}

/** A call's error as the wire carries it: an errno name (ERRNO) and its message. */
export function remoteError(e: unknown): { code: string; message: string } {
	const code = e instanceof FsError ? e.code : typeof (e as { code?: unknown })?.code === "string" && (e as { code: string }).code in ERRNO ? (e as { code: string }).code : "EIO";
	return { code, message: e instanceof Error ? e.message : String(e) };
}

/** The backend's side of the file calls: `fs`, and the open files of this connection. */
export interface RemoteFsServer {
	readonly caps: RemoteFsCaps;
	call(op: RemoteFsOp, args: unknown[]): Promise<unknown>;
	close(): Promise<void>;
}

export function remoteFsServer(fs: Fs): RemoteFsServer {
	const files = new Map<number, FsFile>();
	let next = 1;
	const caps: RemoteFsCaps = {
		create: !!fs.create, mkdir: !!fs.mkdir, symlink: !!fs.symlink, readlink: !!fs.readlink,
		remove: !!fs.remove, rename: !!fs.rename, setattr: !!fs.setattr, statfs: !!fs.statfs,
	};
	const opened = (file: FsFile): RemoteOpened => {
		const h = next++;
		files.set(h, file);
		return { h, c: { write: !!file.write, getattr: !!file.getattr, setattr: !!file.setattr, fsync: !!file.fsync } };
	};
	const handle = (h: unknown): FsFile => {
		const f = files.get(Number(h));
		if (!f) throw new FsError("EBADF", "the file is not open");
		return f;
	};
	const run = async (op: RemoteFsOp, a: unknown[]): Promise<unknown> => {
		switch (op) {
			case "getattr": return fs.getattr(a[0] as string);
			case "readdir": return fs.readdir(a[0] as string);
			case "open": return opened(await fs.open(a[0] as string, a[1] as FsOpenFlags));
			case "create":
				if (!fs.create) throw new FsError("EROFS");
				return opened(await fs.create(a[0] as string, a[1] as number));
			case "mkdir":
				if (!fs.mkdir) throw new FsError("EROFS");
				return fs.mkdir(a[0] as string, a[1] as number);
			case "symlink":
				if (!fs.symlink) throw new FsError("EOPNOTSUPP");
				return fs.symlink(a[0] as string, a[1] as string);
			case "readlink":
				if (!fs.readlink) throw new FsError("EINVAL");
				return fs.readlink(a[0] as string);
			case "remove":
				if (!fs.remove) throw new FsError("EROFS");
				return fs.remove(a[0] as string, a[1] as boolean);
			case "rename":
				if (!fs.rename) throw new FsError("EROFS");
				return fs.rename(a[0] as string, a[1] as string);
			case "setattr":
				if (!fs.setattr) throw new FsError("EROFS");
				return fs.setattr(a[0] as string, a[1] as FsSetAttr);
			case "statfs":
				if (!fs.statfs) throw new FsError("ENOSYS");
				return fs.statfs() as Promise<FsStatFs>;
			case "fread": return handle(a[0]).read(Number(a[1]), Number(a[2]));
			case "fwrite": {
				const f = handle(a[0]);
				if (!f.write) throw new FsError("EROFS");
				return f.write(Number(a[1]), a[2] as Uint8Array);
			}
			case "fgetattr": {
				const f = handle(a[0]);
				if (!f.getattr) throw new FsError("ENOSYS");
				return f.getattr() as Promise<FsAttr>;
			}
			case "fsetattr": {
				const f = handle(a[0]);
				if (!f.setattr) throw new FsError("EROFS");
				return f.setattr(a[1] as FsSetAttr);
			}
			case "ffsync": return handle(a[0]).fsync?.();
			case "fclose": {
				const h = Number(a[0]);
				const f = files.get(h);
				files.delete(h);
				return f?.close?.();
			}
		}
		throw new FsError("ENOSYS", `unknown file call ${String(op)}`);
	};
	return {
		caps,
		call: run,
		async close() {
			const open = [...files.values()];
			files.clear();
			await Promise.all(open.map((f) => Promise.resolve(f.close?.()).catch(() => {})));
		},
	};
}

/** The page's side of the file calls: a host file system over `call`, with the methods the backend has. */
export function remoteFs(call: (op: RemoteFsOp, args: unknown[]) => Promise<unknown>, caps: RemoteFsCaps): Fs {
	const file = (o: RemoteOpened): FsFile => {
		const h = o.h;
		const f: FsFile = {
			read: (offset, length) => call("fread", [h, offset, length]) as Promise<Uint8Array>,
			close: async () => {
				await call("fclose", [h]);
			},
		};
		if (o.c.write) f.write = (offset, data) => call("fwrite", [h, offset, data]) as Promise<number>;
		if (o.c.getattr) f.getattr = () => call("fgetattr", [h]) as Promise<FsAttr>;
		if (o.c.setattr) f.setattr = async (attr) => {
			await call("fsetattr", [h, attr]);
		};
		if (o.c.fsync) f.fsync = async () => {
			await call("ffsync", [h]);
		};
		return f;
	};
	const fs: Fs = {
		getattr: (path) => call("getattr", [path]) as Promise<FsAttr>,
		readdir: (path) => call("readdir", [path]) as Promise<FsDirEntry[]>,
		open: async (path, flags) => file((await call("open", [path, flags])) as RemoteOpened),
	};
	if (caps.create) fs.create = async (path, mode) => file((await call("create", [path, mode])) as RemoteOpened);
	if (caps.mkdir) fs.mkdir = async (path, mode) => {
		await call("mkdir", [path, mode]);
	};
	if (caps.symlink) fs.symlink = async (path, target) => {
		await call("symlink", [path, target]);
	};
	if (caps.readlink) fs.readlink = (path) => call("readlink", [path]) as Promise<string>;
	if (caps.remove) fs.remove = async (path, dir) => {
		await call("remove", [path, dir]);
	};
	if (caps.rename) fs.rename = async (from, to) => {
		await call("rename", [from, to]);
	};
	if (caps.setattr) fs.setattr = async (path, attr) => {
		await call("setattr", [path, attr]);
	};
	if (caps.statfs) fs.statfs = () => call("statfs", []) as Promise<FsStatFs>;
	return fs;
}
