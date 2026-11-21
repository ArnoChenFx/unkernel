// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The stand-in renderer: relays each client's bytes, unchanged, over one
// more WebSocket to `vtest-bridge helper`, which speaks them to the native
// virgl_test_server. It has the renderer shape of README.md.
import { MUX, encode, decode, connect } from "./mux.js";

export class RelayRenderer {
  name = "relay";
  #url;
  #transport;
  #link = null;
  #clients = new Set();
  onreply = () => {};
  onclose = () => {};

  constructor(url, transport) {
    this.#url = url;
    this.#transport = transport;
  }

  async init() {
    this.#link = await connect(this.#url, this.#transport);
    this.#pump();
    return `relay to ${this.#url} over ${this.#link.kind}`;
  }

  async #pump() {
    for (;;) {
      const m = await this.#link.read();
      if (!m) break;
      const { type, id, payload } = decode(m);
      if (!this.#clients.has(id)) continue;
      if (type === MUX.DATA) this.onreply(id, payload);
      else if (type === MUX.CLOSE) this.#clients.delete(id), this.onclose(id, "the server closed it");
    }
    for (const id of this.#clients) this.onclose(id, "the relay closed");
    this.#clients.clear();
  }

  open(id) {
    this.#clients.add(id);
    this.#link.send(encode(MUX.OPEN, id));
  }

  feed(id, bytes) {
    if (!this.#clients.has(id)) return;
    this.#link.send(encode(MUX.DATA, id, bytes));
    if (this.#link.congested) return this.#link.ready();
  }

  close(id) {
    if (this.#clients.delete(id)) this.#link.send(encode(MUX.CLOSE, id));
  }
}
