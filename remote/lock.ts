// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The data disk's lock: IMAGE.lock beside the image, holding the pid of the
// backend that has it open. While that process is alive, another backend is
// refused (and so is anything else that honours the lock); a lock left by a
// process that is gone is taken over. The lock is taken before the image is
// touched and released when the backend stops.

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface ImageLock {
	readonly path: string;
	release(): void;
}

export class ImageInUseError extends Error {
	readonly lock: string;
	readonly pid: number;
	constructor(image: string, lock: string, pid: number, started?: string) {
		super(`${image} is in use by the unkernel backend with pid ${pid}${started ? ` (since ${started})` : ""}. Stop that backend first; if none is running, delete ${lock}.`);
		this.name = "ImageInUseError";
		this.lock = lock;
		this.pid = pid;
	}
}

interface Holder {
	pid: number;
	started?: string;
}

function holderOf(lock: string): Holder | undefined {
	try {
		const j = JSON.parse(readFileSync(lock, "utf8")) as Partial<Holder>;
		return Number.isInteger(j.pid) ? (j as Holder) : undefined;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take the image's lock, or throw ImageInUseError while another live process holds it. */
export function lockImage(image: string): ImageLock {
	const lock = `${image}.lock`;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const fd = openSync(lock, "wx");
			try {
				writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString(), image })}\n`);
			} finally {
				closeSync(fd);
			}
			let released = false;
			return {
				path: lock,
				release() {
					if (released) return;
					released = true;
					if (holderOf(lock)?.pid === process.pid) rmSync(lock, { force: true });
				},
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const holder = holderOf(lock);
		if (!holder) {
			pause(100); // another process may be writing it right now
			continue;
		}
		if (holder.pid !== process.pid && alive(holder.pid)) throw new ImageInUseError(image, lock, holder.pid, holder.started);
		rmSync(lock, { force: true });
	}
	const last = holderOf(lock);
	if (!last) throw new Error(`${lock} cannot be read; delete it if no backend is running`);
	throw new ImageInUseError(image, lock, last.pid, last.started);
}
