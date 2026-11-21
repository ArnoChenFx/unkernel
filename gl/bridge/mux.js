// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The framing between vtest-bridge and the page, and between the page and
// the helper: one WebSocket binary message is u32 client id (little-endian),
// u8 type, payload. See README.md.

export const MUX = { OPEN: 1, DATA: 2, CLOSE: 3, READY: 4, LOG: 5 };

export function encode(type, id, payload) {
  const m = new Uint8Array(5 + (payload ? payload.length : 0));
  new DataView(m.buffer).setUint32(0, id, true);
  m[4] = type;
  if (payload) m.set(payload, 5);
  return m;
}

export function decode(m) {
  const id = new DataView(m.buffer, m.byteOffset, 4).getUint32(0, true);
  return { type: m[4], id, payload: m.subarray(5) };
}

const HIGH_WATER = 8 << 20;

// A WebSocket as read() (one message as a Uint8Array, null at the end),
// send(), and congested/ready() for what send() has queued. WebSocketStream
// gives back pressure on the receiving side: a message is not read off the
// socket until read() asks for it, so a slow consumer slows the sender
// through TCP. Plain WebSocket is the fallback, without that.
export async function connect(url, { stream = true } = {}) {
  let queued = 0;
  let wake = null;
  const sent = (n) => {
    queued -= n;
    if (wake && queued <= HIGH_WATER) wake(), (wake = null);
  };
  const link = {
    get congested() {
      return queued > HIGH_WATER;
    },
    ready() {
      return queued > HIGH_WATER ? new Promise((r) => (wake = r)) : Promise.resolve();
    },
  };
  if (stream && typeof WebSocketStream === "function") {
    const wss = new WebSocketStream(url);
    const { readable, writable } = await wss.opened;
    const reader = readable.getReader();
    const writer = writable.getWriter();
    link.kind = "WebSocketStream";
    link.send = (m) => {
      queued += m.length;
      writer.write(m).then(
        () => sent(m.length),
        () => sent(m.length),
      );
    };
    link.read = async () => {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return null;
      return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    };
    link.close = () => wss.close();
    return link;
  }
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const inbox = [];
  let waiting = null;
  const push = (m) => (waiting ? (waiting(m), (waiting = null)) : inbox.push(m));
  ws.onmessage = (e) => push(new Uint8Array(e.data));
  ws.onclose = () => push(null);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  link.kind = "WebSocket";
  link.send = (m) => ws.send(m);
  Object.defineProperty(link, "congested", { get: () => ws.bufferedAmount > HIGH_WATER });
  link.ready = async () => {
    while (ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 1));
  };
  link.read = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => (waiting = r)));
  link.close = () => ws.close();
  return link;
}
