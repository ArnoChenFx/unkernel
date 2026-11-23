// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The zip archives of a remote release, written and read here so that the
// same files always pack to the same bytes: fixed timestamps, deflate at level
// 9, names as given (the caller sorts them), no directory entries, UTF-8 names.
// Windows reads them with System.IO.Compression (update.ps1), which needs the
// forward-slash names and the central directory written here.

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
	/** A relative path with forward slashes; no "..", no leading slash, no drive letter. */
	name: string;
	data: Uint8Array;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // UNIX host: the external attributes hold a mode
const FLAG_UTF8 = 0x0800;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const UNIX_FILE_MODE = 0o100644;

export function checkEntryName(name: string): void {
	if (!name || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) throw new Error(`zip: bad entry name ${JSON.stringify(name)}`);
	for (const part of name.split("/")) {
		if (part === "" || part === "." || part === "..") throw new Error(`zip: bad entry name ${JSON.stringify(name)}`);
	}
}

export function writeZip(entries: ZipEntry[]): Buffer {
	if (entries.length >= 0xffff) throw new Error("zip: too many entries for the classic format");
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	const seen = new Set<string>();
	let offset = 0;
	for (const entry of entries) {
		checkEntryName(entry.name);
		if (seen.has(entry.name)) throw new Error(`zip: duplicate entry ${entry.name}`);
		seen.add(entry.name);
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
		const packed = deflateRawSync(data, { level: 9 });
		const crc = crc32(data);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(SIG_LOCAL, 0);
		head.writeUInt16LE(VERSION_NEEDED, 4);
		head.writeUInt16LE(FLAG_UTF8, 6);
		head.writeUInt16LE(METHOD_DEFLATE, 8);
		head.writeUInt16LE(0, 10);
		head.writeUInt16LE(DOS_DATE_1980_01_01, 12);
		head.writeUInt32LE(crc, 14);
		head.writeUInt32LE(packed.length, 18);
		head.writeUInt32LE(data.length, 22);
		head.writeUInt16LE(name.length, 26);
		head.writeUInt16LE(0, 28);
		local.push(head, name, packed);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(SIG_CENTRAL, 0);
		dir.writeUInt16LE(VERSION_MADE_BY, 4);
		dir.writeUInt16LE(VERSION_NEEDED, 6);
		dir.writeUInt16LE(FLAG_UTF8, 8);
		dir.writeUInt16LE(METHOD_DEFLATE, 10);
		dir.writeUInt16LE(0, 12);
		dir.writeUInt16LE(DOS_DATE_1980_01_01, 14);
		dir.writeUInt32LE(crc, 16);
		dir.writeUInt32LE(packed.length, 20);
		dir.writeUInt32LE(data.length, 24);
		dir.writeUInt16LE(name.length, 28);
		dir.writeUInt16LE(0, 30);
		dir.writeUInt16LE(0, 32);
		dir.writeUInt16LE(0, 34);
		dir.writeUInt16LE(0, 36);
		dir.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
		dir.writeUInt32LE(offset, 42);
		central.push(dir, name);
		offset += head.length + name.length + packed.length;
	}
	const directory = Buffer.concat(central);
	if (offset >= 0xffffffff) throw new Error("zip: archive too large for the classic format");
	const end = Buffer.alloc(22);
	end.writeUInt32LE(SIG_END, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...local, directory, end]);
}

export interface ReadEntry {
	name: string;
	data: Buffer;
}

/** Reads a zip written by writeZip (or any archive of stored and deflated entries), checking each entry's CRC-32. */
export function readZip(zip: Buffer): ReadEntry[] {
	let end = -1;
	for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
		if (zip.readUInt32LE(at) === SIG_END) {
			end = at;
			break;
		}
	}
	if (end < 0) throw new Error("zip: no end of central directory");
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	const out: ReadEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(at) !== SIG_CENTRAL) throw new Error("zip: bad central directory entry");
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const packedSize = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLen = zip.readUInt16LE(at + 28);
		const extraLen = zip.readUInt16LE(at + 30);
		const commentLen = zip.readUInt16LE(at + 32);
		const localAt = zip.readUInt32LE(at + 42);
		const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
		at += 46 + nameLen + extraLen + commentLen;
		if (zip.readUInt32LE(localAt) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${name}`);
		const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
		const packed = zip.subarray(dataAt, dataAt + packedSize);
		const data = method === METHOD_STORE ? Buffer.from(packed) : method === METHOD_DEFLATE ? inflateRawSync(packed) : null;
		if (!data) throw new Error(`zip: ${name} uses method ${method}`);
		if (data.length !== size || crc32(data) !== crc) throw new Error(`zip: ${name} does not match its header`);
		out.push({ name, data });
	}
	return out;
}
