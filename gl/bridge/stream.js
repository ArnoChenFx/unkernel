// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The far end of vtest-bridge's stream link (README.md, Stream framing): one
// byte stream carries every client of one bridge, each message after its u32
// length. StreamHost.serve() takes that stream as web streams, which is what
// the unkernel SDK gives for a vsock connection (VsockConnection.readable
// and .writable), and drives one renderer of the shape in README.md, which
// may serve several streams (a bridge that reconnects). Universal: no Node
// or DOM APIs.
import { MUX, decode } from "./mux.js";

const MAX = 512 << 20;

/** One message for the stream link: u32 length, u32 client id, u8 type, payload. */
export function frame(type, id, payload) {
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

  push(chunk) {
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
  next() {
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

export class StreamHost {
  #renderer;
  #routes = new Map(); // the renderer's client id -> { id: the stream's, send, mine }
  #nextId = 1;

  /** renderer: initialized (init() settled); StreamHost takes its onreply and onclose. */
  constructor(renderer) {
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

  /**
   * Serves one bridge until its stream ends; its clients are closed then.
   * Tells the bridge at once that the renderer is ready (it creates its
   * vtest socket on that). Rejects on a broken frame, after resetting the
   * stream. log gets the bridge's LOG messages.
   */
  async serve(readable, writable, { log = () => {} } = {}) {
    const writer = writable.getWriter();
    const reader = readable.getReader();
    // The reply direction is never held up (README.md, back pressure).
    const send = (type, id, payload) => writer.write(frame(type, id, payload)).catch(() => {});
    const mine = new Map(); // the stream's client id -> the renderer's
    const deframer = new Deframer();
    send(MUX.READY, 0);
    try {
      for (;;) {
        let m;
        while ((m = deframer.next())) {
          const { type, id, payload } = decode(m);
          const rid = mine.get(id);
          if (type === MUX.OPEN && rid === undefined) {
            const r = this.#nextId++;
            mine.set(id, r);
            this.#routes.set(r, { id, send, mine });
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
            log(new TextDecoder().decode(payload));
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
      for (const rid of mine.values()) {
        this.#routes.delete(rid);
        this.#renderer.close(rid);
      }
      mine.clear();
    }
  }
}
