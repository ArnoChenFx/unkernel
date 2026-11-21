// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The C API of the wasm virglrenderer module (gl/wasm/build.sh): the page
// hands the module a WebGL2 context, opens a client per vtest connection,
// feeds each client's bytes as they arrive and sends back the reply bytes.
// Nothing here blocks: input may arrive in any chunks (a command runs once
// all its bytes are in), and a waiting busy wait parks the client until the
// fences submitted before it (every client's) have retired; kw_virgl_poll,
// called from a later task, answers it then (a WebGL fence only signals
// between tasks).
// Single-threaded: call everything from the thread that owns the context.
#ifndef KW_VIRGL_H
#define KW_VIRGL_H

#include <stdint.h>

// kw_virgl_feed and kw_virgl_poll results for a client
#define KW_VIRGL_OK 0      // every complete command ran; a partial one waits for more bytes
#define KW_VIRGL_PARKED 1  // a waiting VCMD_RESOURCE_BUSY_WAIT is pending: kw_virgl_poll later

// Initialise the renderer on the WebGL2 context with this emscripten handle
// (GL.registerContext; the JS helper virgl.init(gl) does both). 0, or a
// negative errno. One renderer, one context, for the life of the module.
int kw_virgl_init(int webgl_context);

// kw_virgl_open flags: the dialect (kw_virgl.c). 0: plain vtest over a byte
// pipe, where the client falls back to protocol version 0 (transfer data in
// the stream; one client at a time). KW_VIRGL_INLINE: protocol version 3
// with no fds, transfer data inline (TRANSFER_PUT2 followed by its data,
// TRANSFER_GET2 answered with it), as gl/bridge/vtest-bridge.c speaks it.
#define KW_VIRGL_INLINE 1

// Open a client (one vtest connection): its id (> 0), or a negative errno.
int kw_virgl_open(uint32_t flags);

// Close a client: destroys its renderer context and resources and drops
// its unread reply bytes.
void kw_virgl_close(int client);

// Queue LEN bytes of the client's vtest stream and run every command that is
// now complete. KW_VIRGL_OK, KW_VIRGL_PARKED, or a negative errno: the
// stream is broken (a protocol error or a failed command, where the native
// server would drop the connection); close the client.
int kw_virgl_feed(int client, const uint8_t *data, uint32_t len);

// Retire finished fences and resume parked clients. Returns how many clients
// are still parked (call again from a later task while it is not 0: WebGL
// sync objects only change between tasks).
int kw_virgl_poll(void);

// The client's reply bytes: a pointer into the module's memory and their
// count, valid until the next call into the module; kw_virgl_consume drops
// the first N of them once sent.
const uint8_t *kw_virgl_reply_ptr(int client);
uint32_t kw_virgl_reply_len(int client);
void kw_virgl_consume(int client, uint32_t n);

// The client's state: KW_VIRGL_OK, KW_VIRGL_PARKED, or a negative errno
// (-ENOENT: no such client).
int kw_virgl_state(int client);

#endif
