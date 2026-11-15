// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Test helper: the server side of RFC 6455 (binary messages, ping/pong,
// close), enough for a fake Wisp server.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface TestWebSocket {
	send(payload: Uint8Array): void;
	close(code?: number): void;
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex & { setNoDelay?(v: boolean): void }, head: Buffer | undefined,
	onMessage: (msg: Buffer) => void, onClose: () => void): TestWebSocket {
	const key = req.headers["sec-websocket-key"];
	const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
	socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		`Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
	socket.setNoDelay?.(true);
	let buf: Buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
	let frags: Buffer[] = [], closed = false;

	const frame = (op: number, payload: Uint8Array) => {
		const n = payload.length;
		const h = n < 126 ? Buffer.from([0x80 | op, n])
			: n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
			: Buffer.from([0x80 | op, 127, 0, 0, 0, 0, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
		socket.write(h);
		if (n) socket.write(payload);
	};
	const ws: TestWebSocket = {
		send: (payload) => { if (!closed) frame(2, payload); },
		close: (code = 1000) => {
			if (closed) return;
			frame(8, Buffer.from([code >> 8, code & 255]));
			closed = true;
			socket.end();
		},
	};

	socket.on("data", (chunk: Buffer) => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
		while (buf.length >= 2 && !closed) {
			const fin = buf[0]! & 0x80, op = buf[0]! & 15;
			let len = buf[1]! & 127, off = 2;
			if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
			else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
			if (buf.length < off + 4 + len) return;
			const mask = buf.subarray(off, off + 4);
			const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
			for (let i = 0; i < len; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
			buf = buf.subarray(off + 4 + len);
			if (op === 8) { ws.close(); return; }
			if (op === 9) { frame(10, payload); continue; }
			if (op === 10) continue;
			if (op !== 0) frags = [];
			frags.push(payload);
			if (fin) {
				const msg = frags.length === 1 ? frags[0]! : Buffer.concat(frags);
				frags = [];
				onMessage(msg);
			}
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => { closed = true; onClose(); });
	return ws;
}
