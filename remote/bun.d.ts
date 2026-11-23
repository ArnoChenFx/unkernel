// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The part of Bun's API the remote kernel backend uses (Bun 1.4), declared
// here rather than with bun-types: its global ReadableStream types clash with
// the DOM lib that js/ is written against.

declare namespace Bun {
	interface ServerWebSocket<T> {
		readonly data: T;
		send(data: string | ArrayBufferLike | ArrayBufferView, compress?: boolean): number;
		close(code?: number, reason?: string): void;
	}

	interface WebSocketHandler<T> {
		maxPayloadLength?: number;
		perMessageDeflate?: boolean;
		open?(ws: ServerWebSocket<T>): void;
		message?(ws: ServerWebSocket<T>, message: string | Uint8Array): void;
		close?(ws: ServerWebSocket<T>, code: number, reason: string): void;
	}

	interface Server<T> {
		readonly port: number;
		upgrade(req: Request, options?: { data?: T; headers?: HeadersInit }): boolean;
		stop(closeActiveConnections?: boolean): void;
	}

	interface ServeOptions<T> {
		hostname?: string;
		port?: number;
		fetch(req: Request, server: Server<T>): Response | undefined | Promise<Response | undefined>;
		websocket?: WebSocketHandler<T>;
	}

	interface BunFile extends Blob {
		exists(): Promise<boolean>;
	}

	function serve<T>(options: ServeOptions<T>): Server<T>;
	function file(path: string): BunFile;
}
