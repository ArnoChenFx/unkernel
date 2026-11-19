// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwblk backends that need Node (see core/block.ts for the protocol).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { BaseDisk, CowDisk, F_FLUSH, FlushTracker, HttpBase, type BlockDevice, type DiskBase, type DiskSnapshotState } from "../core/block.ts";
import { DistroDisk } from "../core/distro.ts";
import { readKwsparse } from "../core/kwsparse.ts";

/** Size rounded down to whole sectors (not `& ~511`: that is 32-bit and breaks at 2 GiB and above). */
const sectors = (n: number) => Math.floor(n / 512) * 512;

/** Size and modification time (ns) of an open file: changes when anything writes it. */
function fileStamp(fd: number): string {
	const st = fs.fstatSync(fd, { bigint: true });
	return `size=${st.size} mtime=${st.mtimeNs}`;
}

/**
 * A disk image file, read and written in place (synchronous pread/pwrite).
 *
 * Snapshots: a writable image's write generation lives in a sidecar file,
 * `<image>.kwsnap` ({"uid", "gen"}), created by the first snapshot that
 * includes the image. Once it exists, the first write after opening the
 * image or after a snapshot stores the next generation there (synced)
 * before the data is written, in every process that opens the image. The
 * image's size and mtime (the stamp) catch writes by other programs.
 */
export class FileDisk implements BlockDevice {
	path: string;
	readOnly: boolean;
	fd: number;
	size: number;
	flags: number;
	/** Writable: flushes reach the file (Kernel.requestSync waits for them). */
	readonly persistent: boolean;
	flushes: FlushTracker = new FlushTracker();
	/** Write generation (snapshotState), and the sidecar's id once a snapshot created it. */
	gen = 0;
	uid?: string;
	#sealed = true;

	constructor(path: string, { readOnly = false }: { readOnly?: boolean } = {}) {
		this.path = path;
		this.readOnly = readOnly;
		this.fd = fs.openSync(path, readOnly ? "r" : "r+");
		this.size = sectors(fs.fstatSync(this.fd).size);
		this.flags = F_FLUSH;
		this.persistent = !readOnly;
		if (!readOnly) {
			try {
				const j = JSON.parse(fs.readFileSync(this.sidecar, "utf8")) as { uid?: unknown; gen?: unknown };
				if (typeof j.uid === "string" && Number.isSafeInteger(j.gen)) {
					this.uid = j.uid;
					this.gen = j.gen as number;
				}
			} catch {} // none (never in a snapshot), or unreadable: a new uid at the next snapshot
		}
	}

	/** The sidecar file with the write generation. */
	get sidecar(): string {
		return `${this.path}.kwsnap`;
	}

	#writeSidecar(): void {
		const fd = fs.openSync(this.sidecar, "w");
		try {
			fs.writeSync(fd, JSON.stringify({ uid: this.uid, gen: this.gen }) + "\n");
			fs.fdatasyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}

	snapshotState(): DiskSnapshotState {
		const stamp = fileStamp(this.fd);
		if (this.readOnly) return { name: this.path, identity: `file-ro size=${this.size}`, gen: 0, stamp };
		return { name: this.path, identity: `file uid=${this.uid ?? "-"} size=${this.size}`, gen: this.gen, stamp };
	}

	/** Sync the image, store the generation in the sidecar (created now if needed). */
	snapshotSeal(): { state: DiskSnapshotState; done: Promise<void> } {
		if (!this.readOnly) {
			this.flush();
			this.uid ??= randomBytes(16).toString("hex");
			this.#writeSidecar();
			this.#sealed = true;
		}
		return { state: this.snapshotState(), done: Promise.resolve() };
	}

	get flushSeq(): number {
		return this.flushes.flushSeq;
	}

	whenFlushed(after: number): Promise<void> {
		return this.flushes.whenFlushed(after);
	}

	read(off: number, views: Uint8Array[]): void {
		for (const v of views) {
			let done = 0;
			while (done < v.length) {
				const n = fs.readSync(this.fd, v, done, v.length - done, off + done);
				if (n <= 0) { v.fill(0, done); break; }
				done += n;
			}
			off += v.length;
		}
	}

	write(off: number, views: Uint8Array[]): void {
		if (this.#sealed) {
			// A new generation, durable before the data it covers.
			this.#sealed = false;
			this.gen++;
			if (this.uid !== undefined) this.#writeSidecar();
		}
		for (const v of views) {
			let done = 0;
			while (done < v.length)
				done += fs.writeSync(this.fd, v, done, v.length - done, off + done);
			off += v.length;
		}
	}

	flush(): void {
		const seq = this.flushes.begin();
		fs.fdatasyncSync(this.fd);
		this.flushes.done(seq);
	}

	close(): void {
		fs.closeSync(this.fd);
	}
}

/** Read-only file as the base of a CowDisk (`--snapshot`). */
export class FileBase implements DiskBase {
	fd: number;
	size: number;
	/** The path, size and mtime: a snapshot of an unwritten CowDisk over it checks them. */
	identity: string;

	constructor(path: string) {
		this.fd = fs.openSync(path, "r");
		this.size = sectors(fs.fstatSync(this.fd).size);
		this.identity = `${path} ${fileStamp(this.fd)}`;
	}

	read(off: number, len: number): Uint8Array {
		const buf = new Uint8Array(len);
		fs.readSync(this.fd, buf, 0, len, off);
		return buf;
	}

	close(): void {
		fs.closeSync(this.fd);
	}
}

export interface OpenDiskOptions {
	/** Writes go to an in-memory overlay and are lost at exit. */
	snapshot?: boolean;
	/** The guest's writes fail (EROFS); takes precedence over snapshot. */
	readOnly?: boolean;
}

/**
 * Open a disk: a file path, or an http(s) URL served with Range support
 * (lazily fetched, overlay in memory; read-only: no overlay).
 */
export async function openDisk(spec: string, { snapshot = false, readOnly = false }: OpenDiskOptions = {}): Promise<BlockDevice> {
	if (/^https?:\/\//.test(spec)) return readOnly ? new BaseDisk(await HttpBase.open(spec, { strict: true })) : new CowDisk(await HttpBase.open(spec));
	if (snapshot && !readOnly) return new CowDisk(new FileBase(spec));
	return new FileDisk(spec, { readOnly });
}

/**
 * A distro image (a path, or an http(s) URL served with Range support,
 * prefetched as its distro header or `prefetch` says; a file ignores it) as
 * the read-only disk createKernel({ distro }) takes, for a caller that
 * needs the disk before booting (snapshotDiskMismatch(); the distro is the
 * snapshot's first disk). createKernel({ distro: path }) opens it the same way.
 */
export async function openDistroDisk(src: string, { prefetch, log }: { prefetch?: number | false; log?: (msg: string) => void } = {}): Promise<DistroDisk> {
	const dev = /^https?:\/\//.test(src) ? new BaseDisk(await HttpBase.open(src, { strict: true, prefetch, log })) : new FileDisk(src, { readOnly: true });
	try {
		return await DistroDisk.open(dev, { name: src, log });
	} catch (e) {
		if (dev instanceof FileDisk) dev.close();
		throw e;
	}
}

/**
 * Create a disk image file from a kwsparse image (gzipped or not), sparse:
 * only the stored blocks are written. Fails if `path` exists, so it never
 * replaces a data disk.
 */
export async function createImageFromKwsparse(path: string, bytes: Uint8Array | ArrayBuffer): Promise<{ size: number; blocks: number }> {
	const img = await readKwsparse(bytes);
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.ftruncateSync(fd, img.size);
		img.indices.forEach((b, i) => fs.writeSync(fd, img.block(i), 0, img.blockSize, b * img.blockSize));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
	} catch (e) {
		try { fs.closeSync(fd); } catch {}
		fs.rmSync(tmp, { force: true });
		throw e;
	}
	try {
		fs.linkSync(tmp, path); // fails if path exists
	} finally {
		fs.rmSync(tmp, { force: true });
	}
	return { size: img.size, blocks: img.indices.length };
}
