// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The far end of vtest-bridge's stream link on this host, for
// stream-check.sh: accepts bridges on a unix socket and serves each with
// the SDK's StreamHost (js/core/gl-stream.ts, which serves the guest's vsock
// connection for the `gl` option) and the relay renderer (gl/bridge/relay.js), which carries every client
// over a WebSocket to `vtest-bridge helper` and on to virgl_test_server.
//
//   node test/gl/stream-relay.js --listen PATH --relay ws://127.0.0.1:PORT/
import { unlinkSync } from "node:fs";
import net from "node:net";
import { Duplex } from "node:stream";
import { RelayRenderer } from "../../gl/bridge/relay.js";
import { StreamHost } from "../../js/core/gl-stream.ts";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const path = opt("--listen");
const relay = opt("--relay");
if (!path || !relay) {
  console.error("usage: node test/gl/stream-relay.js --listen PATH --relay ws://HOST:PORT/");
  process.exit(2);
}
const log = (s) => console.error(`stream-relay: ${s}`);

// Node has WebSocket but not WebSocketStream
const renderer = new RelayRenderer(relay, { stream: false });
log(`renderer: ${await renderer.init()}`);
const host = new StreamHost(renderer);
const server = net.createServer((sock) => {
  log("bridge connected");
  const { readable, writable } = Duplex.toWeb(sock);
  host.serve(readable, writable, { log: (s) => console.error(`bridge: ${s}`) }).then(
    () => log("bridge disconnected"),
    (e) => log(`bridge dropped: ${e.message}`),
  );
});
try {
  unlinkSync(path);
} catch {}
server.listen(path, () => log(`listening on ${path}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (server.close(), process.exit(0)));
