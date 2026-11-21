// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The far end of vtest-bridge's stream link (gl/bridge/README.md, Stream
// framing): one byte stream carries every client of one bridge, each
// message after its u32 length. StreamHost.serve() takes that stream as web
// streams (a vsock connection's readable and writable: the SDK's `gl`
// option, gl.ts) and drives one renderer of the shape in gl/bridge/README.md
// (The renderer in the page), which may serve several streams (a bridge
// that reconnects). test/gl/stream-relay.js runs it on Node against the
// relay renderer. Universal: no Node or DOM APIs.

/** The link's message types (gl/bridge/mux.js has the same for the WebSocket link). */
export const MUX = { OPEN: 1, DATA: 2, CLOSE: 3, READY: 4, LOG: 5 } as const;

const MAX = 512 << 20;

/**
 * A vtest renderer as gl/bridge/README.md describes it: the wasm module's
 * `Module.virgl.Renderer` (gl/wasm/post.js), or the relay of the test pages.
 */
export interface VtestRenderer {
	/** Once, before any client; resolves with a description. */
	init(): Promise<string>;
	/** A new client. */
	open(id: number): void;
	/** The client's bytes, any chunking, in order; a promise: busy, feed no more until it settles. */
	feed(id: number, bytes: Uint8Array): unknown;
	/** The client is gone: free its context and resources. */
	close(id: number): void;
	/** Set by the host: reply bytes, in order. */
	onreply: (id: number, bytes: Uint8Array) => void;
	/** Set by the host: the renderer dropped the client. */
	onclose: (id: number, why: string) => void;
	/** How often and how long the client's busy waits were parked. */
	stats?(id: number): { parks: number; parkedMs: number } | undefined;
}

/** One message for the stream link: u32 length, u32 client id, u8 type, payload. */
export function frame(type: number, id: number, payload?: Uint8Array): Uint8Array {
	const n = 5 + (payload ? payload.length : 0);
	const f = new Uint8Array(4 + n);
	const v = new DataView(f.buffer);
	v.setUint32(0, n, true);
	v.setUint32(4, id, true);
	f[8] = type;
	if (payload) f.set(payload, 9);
	return f;
}

/** Cuts a byte stream into the link's messages (each without its length). */
export class Deframer {
	#b = new Uint8Array(1 << 16);
	#r = 0;
	#w = 0;

	push(chunk: Uint8Array): void {
		if (this.#w + chunk.length > this.#b.length) {
			this.#b.copyWithin(0, this.#r, this.#w);
			this.#w -= this.#r;
			this.#r = 0;
			if (this.#w + chunk.length > this.#b.length) {
				const b = new Uint8Array(Math.max(this.#b.length * 2, this.#w + chunk.length));
				b.set(this.#b.subarray(0, this.#w));
				this.#b = b;
			}
		}
		this.#b.set(chunk, this.#w);
		this.#w += chunk.length;
	}

	/** The next whole message (a copy), or null. Throws on a length out of range. */
	next(): Uint8Array | null {
		if (this.#w - this.#r < 4) return null;
		const n = new DataView(this.#b.buffer, this.#r, 4).getUint32(0, true);
		if (n < 5 || n > MAX) throw new Error(`stream frame of ${n} bytes`);
		if (this.#w - this.#r - 4 < n) return null;
		const m = this.#b.slice(this.#r + 4, this.#r + 4 + n);
		this.#r += 4 + n;
		if (this.#r === this.#w) this.#r = this.#w = 0;
		return m;
	}
}

type Send = (type: number, id: number, payload?: Uint8Array) => void;
interface Route { id: number; send: Send; mine: Map<number, number> }

export interface StreamHostStats {
	/** Bridges being served now. */
	streams: number;
	/** Clients open now, over all streams. */
	clients: number;
	/** Clients opened since the start. */
	opened: number;
}

export class StreamHost {
	#renderer: VtestRenderer;
	#routes = new Map<number, Route>(); // the renderer's client id -> the stream's
	#nextId = 1;
	#streams = 0;
	#opened = 0;

	/** renderer: initialized (init() settled); StreamHost takes its onreply and onclose. */
	constructor(renderer: VtestRenderer) {
		this.#renderer = renderer;
		renderer.onreply = (rid, bytes) => {
			const r = this.#routes.get(rid);
			if (r) r.send(MUX.DATA, r.id, bytes);
		};
		renderer.onclose = (rid) => {
			const r = this.#routes.get(rid);
			if (!r) return;
			this.#routes.delete(rid);
			r.mine.delete(r.id);
			r.send(MUX.CLOSE, r.id);
		};
	}

	get stats(): StreamHostStats {
		return { streams: this.#streams, clients: this.#routes.size, opened: this.#opened };
	}

	/**
	 * Serves one bridge until its stream ends; its clients are closed then.
	 * Tells the bridge at once that the renderer is ready (it creates its
	 * vtest socket on that). Rejects on a broken frame, after resetting the
	 * stream. `log` gets the bridge's LOG messages.
	 */
	async serve(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, { log = (_: string) => {} } = {}): Promise<void> {
		const writer = writable.getWriter();
		const reader = readable.getReader();
		// The reply direction is never held up (gl/bridge/README.md, back pressure).
		const send: Send = (type, id, payload) => void writer.write(frame(type, id, payload)).catch(() => {});
		const mine = new Map<number, number>(); // the stream's client id -> the renderer's
		const deframer = new Deframer();
		const text = new TextDecoder();
		this.#streams++;
		send(MUX.READY, 0);
		try {
			for (;;) {
				let m: Uint8Array | null;
				while ((m = deframer.next())) {
					const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
					const id = v.getUint32(0, true), type = m[4]!, payload = m.subarray(5);
					const rid = mine.get(id);
					if (type === MUX.OPEN && rid === undefined) {
						const r = this.#nextId++;
						mine.set(id, r);
						this.#routes.set(r, { id, send, mine });
						this.#opened++;
						this.#renderer.open(r);
					} else if (type === MUX.DATA && rid !== undefined) {
						// busy: read no more from the stream, so its credit stops the bridge
						const busy = this.#renderer.feed(rid, payload);
						if (busy) await busy;
					} else if (type === MUX.CLOSE && rid !== undefined) {
						mine.delete(id);
						this.#routes.delete(rid);
						this.#renderer.close(rid);
					} else if (type === MUX.LOG) {
						log(text.decode(payload));
					}
				}
				const { value, done } = await reader.read();
				if (done) break;
				deframer.push(value);
			}
			writer.close().catch(() => {});
		} catch (e) {
			reader.cancel(e).catch(() => {});
			writer.abort(e).catch(() => {});
			throw e;
		} finally {
			this.#streams--;
			for (const rid of mine.values()) {
				this.#routes.delete(rid);
				this.#renderer.close(rid);
			}
			mine.clear();
		}
	}
}
