// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Console output fan-out shared by KernelInstance (instance.ts) and
// WorkerKernel (worker-host.ts): listeners, and one ReadableStream that
// starts with a backlog of everything since boot.

/** Console output kept for the `output` stream until it is first read. */
const OUTPUT_BACKLOG = 1 << 20;

export class ConsoleOutput {
	#listeners = new Set<(bytes: Uint8Array) => void>();
	#backlog: Uint8Array[] | null = [];
	#backlogBytes = 0;
	#stream: ReadableStream<Uint8Array> | undefined;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#closed = false;
	#ended: () => boolean;

	/** `ended` tells whether the kernel has exited before close() runs. */
	constructor(ended: () => boolean = () => false) {
		this.#ended = ended;
	}

	/** Console output from the kernel. */
	emit(bytes: Uint8Array): void {
		for (const l of this.#listeners) l(bytes);
		if (this.#controller) {
			this.#controller.enqueue(bytes);
		} else if (this.#backlog) {
			this.#backlog.push(bytes);
			this.#backlogBytes += bytes.length;
			while (this.#backlogBytes > OUTPUT_BACKLOG && this.#backlog.length > 1)
				this.#backlogBytes -= this.#backlog.shift()!.length;
		}
	}

	/** The kernel exited: close the stream and drop a backlog nobody read. */
	close(): void {
		this.#closed = true;
		try { this.#controller?.close(); } catch {}
		this.#backlog = null;
	}

	/** The one output stream: the backlog first, then everything as it comes; closed once the kernel exits. */
	get stream(): ReadableStream<Uint8Array> {
		if (!this.#stream) {
			const backlog = this.#backlog ?? [];
			this.#backlog = null;
			this.#stream = new ReadableStream<Uint8Array>({
				start: (c) => {
					for (const b of backlog) c.enqueue(b);
					if (this.#closed || this.#ended()) c.close();
					else this.#controller = c;
				},
			});
		}
		return this.#stream;
	}

	listen(listener: (bytes: Uint8Array) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
