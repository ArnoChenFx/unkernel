// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page-facing side of the wasm virglrenderer module (kw_virgl.h): the
// GL context hooks (in place of an EGL/GLX winsys: the renderer runs in its
// single GL context mode, VIRGL_RENDERER_SINGLE_GL_CONTEXT, and the one GL
// context it creates is the WebGL2 context the page registered; the renderer
// itself saves and restores each client's GL state) and the I/O layer of the vtest
// protocol decoder (vtest/vtest_renderer.c, in place of vtest_server.c:
// no sockets, no fork, no fds, no blocking read).
//
// A client's bytes are queued until a whole command is in; the command is
// then dispatched to the decoder with its bytes as the input (vtest_buf_read),
// and its reply bytes, written through vtest_block_write, are queued for the
// page.
//
// Protocol version 2 and later hand the client a memfd per resource
// (SCM_RIGHTS), its backing store, which TRANSFER_PUT2 and TRANSFER_GET2 then
// go through. There are no fds here, so a client speaks one of two dialects,
// chosen when it is opened:
//
//   plain (flags 0)       vtest_shm_check says no, the client falls back to
//     protocol version 0: VCMD_TRANSFER_PUT carries its data in the stream,
//     VCMD_TRANSFER_GET returns it in the reply. Stock Mesa speaks it over a
//     byte pipe that knows nothing of vtest. Resource ids are the client's
//     own, so two such clients at once collide.
//   inline (KW_VIRGL_INLINE)   protocol version 3 without fds, as
//     gl/bridge/vtest-bridge.c speaks it to the page: the client side keeps
//     the memfds; RESOURCE_CREATE2 and RESOURCE_CREATE_BLOB get no fd here,
//     the backing store is module memory; TRANSFER_PUT2's length counts its
//     data (padded to 4 bytes), which follows the command and is copied into
//     the backing store first; TRANSFER_GET2 is answered with a reply
//     (id VCMD_TRANSFER_GET2, the data padded to 4 bytes). Resource ids are
//     the renderer's: any number of clients.

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>

#include <emscripten/emscripten.h>
#include <emscripten/html5_webgl.h>

#include "virglrenderer.h"
#include "vtest.h"
#include "vtest_protocol.h"

#include "kw_virgl.h"

#define KW_MAX_CLIENTS 64
#define KW_MAX_COMMAND (256u << 20) // bytes; a longer command breaks the stream

struct kw_bytes {
	uint8_t *data;
	uint32_t len, cap;
};

struct kw_client {
	bool used;
	bool inline_data; // the inline dialect
	int state; // KW_VIRGL_OK, KW_VIRGL_PARKED or a negative errno
	bool waiting; // in a waiting VCMD_RESOURCE_BUSY_WAIT: for implicit fence wait_seq
	uint32_t wait_seq;
	bool strict; // KW_VIRGL_STRICT_WAIT
	bool ahead; // a wait was answered ahead of fences ahead_seq (busy_wait)
	uint32_t ahead_seq;
	double parked_at; // when the wait parked (emscripten_get_now), or 0
	uint32_t got; // resource handle of the client's last request when that was
		      // a TRANSFER_GET(2) or a busy wait following one, else 0
	struct vtest_context *context;
	struct kw_bytes in, out;
	uint32_t in_pos; // first unconsumed byte of in
};

static struct kw_client clients[KW_MAX_CLIENTS + 1]; // [0] unused: ids start at 1
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE gl_context;
static bool initialized;
static struct kw_client *current; // the client whose command runs
static double stats[KW_VIRGL_STAT_COUNT]; // kw_virgl_stats

static void stat_time(int count, int ms, double since)
{
	stats[count]++;
	stats[ms] += emscripten_get_now() - since;
}

static int bytes_reserve(struct kw_bytes *b, uint32_t more)
{
	uint32_t need = b->len + more, cap;
	uint8_t *p;

	if (need < b->len)
		return -ENOMEM;
	if (need <= b->cap)
		return 0;
	cap = b->cap ? b->cap : 4096;
	while (cap < need)
		cap = cap > UINT32_MAX / 2 ? need : cap * 2;
	p = realloc(b->data, cap);
	if (!p)
		return -ENOMEM;
	b->data = p;
	b->cap = cap;
	return 0;
}

static struct kw_client *client_get(int id)
{
	if (id < 1 || id > KW_MAX_CLIENTS || !clients[id].used)
		return NULL;
	return &clients[id];
}

// --- GL context hooks: the renderer's one GL context is the page's WebGL2 context ---

static virgl_renderer_gl_context kw_create_gl_context(void *cookie, int scanout,
		struct virgl_renderer_gl_ctx_param *param)
{
	(void)cookie;
	(void)scanout;
	(void)param; // any GL version asked for: what WebGL2 gives is what it gets
	// In the single GL context mode the renderer asks once, at init.
	return (virgl_renderer_gl_context)gl_context;
}

static void kw_destroy_gl_context(void *cookie, virgl_renderer_gl_context ctx)
{
	(void)cookie;
	(void)ctx; // the page owns the context
}

static int kw_make_current(void *cookie, int scanout, virgl_renderer_gl_context ctx)
{
	(void)cookie;
	(void)scanout;
	if ((EMSCRIPTEN_WEBGL_CONTEXT_HANDLE)ctx != gl_context)
		return -1;
	if (emscripten_webgl_get_current_context() == gl_context)
		return 0;
	return emscripten_webgl_make_context_current(gl_context) == EMSCRIPTEN_RESULT_SUCCESS ? 0 : -1;
}

// --- the decoder's I/O ---

// shared memory (protocol version 2 and later): for inline clients, whose
// backing stores are module memory (vtest_create_resource_setup_shm with
// VTEST_EXTERNAL_IO) and pass no fd
int vtest_shm_check(void)
{
	return current && current->inline_data;
}

int vtest_new_shm(uint32_t handle, size_t size)
{
	(void)handle;
	(void)size;
	if (!current || !current->inline_data)
		return -ENOSYS;
	// a placeholder the decoder closes again
	return open("/dev/null", O_RDWR | O_CLOEXEC);
}

int vtest_send_fd(int socket_fd, int fd)
{
	struct kw_client *c = client_get(socket_fd);

	(void)fd;
	return c && c->inline_data ? 0 : -ENOSYS;
}

int vtest_block_write(int fd, void *buf, int size)
{
	struct kw_client *c = client_get(fd);

	if (!c || size < 0)
		return -EBADF;
	if (bytes_reserve(&c->out, (uint32_t)size))
		return -ENOMEM;
	memcpy(c->out.data + c->out.len, buf, (size_t)size);
	c->out.len += (uint32_t)size;
	return size;
}

static const struct kw_command {
	int (*dispatch)(uint32_t);
	bool init_context;
} commands[] = {
#define CMD(N, n, init) [VCMD_##N] = { vtest_##n, init }
	// as vtest_server.c, without what needs eventfd or DRM
	CMD(GET_CAPS, send_caps, false),
	CMD(RESOURCE_CREATE, create_resource, true),
	CMD(RESOURCE_UNREF, resource_unref, true),
	CMD(TRANSFER_GET, transfer_get, true),
	CMD(TRANSFER_PUT, transfer_put, true),
	CMD(SUBMIT_CMD, submit_cmd, true),
	CMD(RESOURCE_BUSY_WAIT, resource_busy_wait, false),
	CMD(GET_CAPS2, send_caps2, false),
	CMD(PING_PROTOCOL_VERSION, ping_protocol_version, false),
	CMD(PROTOCOL_VERSION, protocol_version, false),
	// protocol version 2 and 3 (inline dialect)
	CMD(RESOURCE_CREATE2, create_resource2, true),
	CMD(TRANSFER_GET2, transfer_get2, true),
	CMD(TRANSFER_PUT2, transfer_put2, true),
	CMD(GET_PARAM, get_param, false),
	CMD(GET_CAPSET, get_capset, false),
	CMD(CONTEXT_INIT, context_init, false),
	CMD(RESOURCE_CREATE_BLOB, resource_create_blob, true),
#undef CMD
};

// The bytes command HDR occupies with its payload, header included, or 0
// when more bytes must arrive to tell (AVAIL bytes are in), or -1 when the
// stream cannot be framed.
static int64_t command_size(const uint32_t *hdr, uint32_t avail)
{
	uint32_t len = hdr[VTEST_CMD_LEN];

	switch (hdr[VTEST_CMD_ID]) {
	case VCMD_CREATE_RENDERER: // the length is the name's, in bytes
		return 8 + (int64_t)len;
	case VCMD_TRANSFER_PUT: // the header, then data_size bytes of data
		if (len != VCMD_TRANSFER_HDR_SIZE)
			return -1;
		if (avail < 8 + 4 * VCMD_TRANSFER_HDR_SIZE)
			return 0;
		return 8 + 4 * VCMD_TRANSFER_HDR_SIZE +
			(int64_t)hdr[VTEST_CMD_DATA_START + VCMD_TRANSFER_DATA_SIZE];
	default:
		return 8 + 4 * (int64_t)len;
	}
}

// The backing range a TRANSFER_PUT2/GET2 names (inline dialect), or NULL:
// data_size bytes at offset, of which *avail are in the backing. The native
// server does not bound data_size by the backing either (Mesa asks for whole
// strides past the end of a resource's last row); vtest-bridge clamps the
// same way.
static uint8_t *inline_range(struct kw_client *c, const uint32_t *hdr, uint32_t size,
		uint32_t *len, uint32_t *avail)
{
	const uint32_t *a = hdr + VTEST_CMD_DATA_START;
	struct iovec *iov;
	uint32_t n, off;

	if (size < 8 + 4 * VCMD_TRANSFER2_HDR_SIZE)
		return NULL;
	n = a[VCMD_TRANSFER2_DATA_SIZE];
	off = a[VCMD_TRANSFER2_OFFSET];
	iov = vtest_resource_backing(c->context, a[VCMD_TRANSFER2_RES_HANDLE]);
	if (!iov || off > iov->iov_len) {
		fprintf(stderr, "kw_virgl: %s of resource %u: offset %u is outside its backing (%zu bytes)\n",
			hdr[VTEST_CMD_ID] == VCMD_TRANSFER_PUT2 ? "TRANSFER_PUT2" : "TRANSFER_GET2",
			a[VCMD_TRANSFER2_RES_HANDLE], off, iov ? iov->iov_len : 0);
		return NULL;
	}
	*len = n;
	*avail = n < iov->iov_len - off ? n : iov->iov_len - off;
	return (uint8_t *)iov->iov_base + off;
}

// TRANSFER_PUT2, inline: its data, after the command, into the backing store.
static int inline_put2(struct kw_client *c, const uint32_t *hdr, uint32_t size)
{
	uint32_t n, avail;
	uint8_t *p = inline_range(c, hdr, size, &n, &avail);

	if (!p || size - (8 + 4 * VCMD_TRANSFER2_HDR_SIZE) < n)
		return -EINVAL;
	memcpy(p, (const uint8_t *)hdr + 8 + 4 * VCMD_TRANSFER2_HDR_SIZE, avail);
	return 0;
}

// TRANSFER_GET2, inline: the data the transfer put in the backing store, as
// the reply (data_size bytes, zeros past the backing, padded to 4).
static int inline_get2_reply(int id, struct kw_client *c, const uint32_t *hdr, uint32_t size)
{
	uint32_t n, avail, reply[2];
	uint8_t *p = inline_range(c, hdr, size, &n, &avail), *q;

	if (!p)
		return -EINVAL;
	reply[VTEST_CMD_LEN] = (n + 3) / 4;
	reply[VTEST_CMD_ID] = VCMD_TRANSFER_GET2;
	if (vtest_block_write(id, reply, sizeof(reply)) < 0 ||
	    bytes_reserve(&c->out, 4 * reply[VTEST_CMD_LEN]))
		return -ENOMEM;
	q = c->out.data + c->out.len;
	memcpy(q, p, avail);
	memset(q + avail, 0, 4 * reply[VTEST_CMD_LEN] - avail);
	c->out.len += 4 * reply[VTEST_CMD_LEN];
	return 0;
}

static int run_command(int id, struct kw_client *c, const uint32_t *hdr, uint32_t size)
{
	struct vtest_buffer buf = { (const char *)hdr + 8, (int)(size - 8) };
	struct vtest_input input = { .data.buffer = &buf, .read = vtest_buf_read };
	uint32_t cmd = hdr[VTEST_CMD_ID];
	const struct kw_command *k;
	int ret;

	if (!c->context) {
		// the first command must be VCMD_CREATE_RENDERER
		if (cmd != VCMD_CREATE_RENDERER)
			return -EPROTO;
		ret = vtest_create_context(&input, id, hdr[VTEST_CMD_LEN], &c->context);
		vtest_poll_resource_busy_wait();
		return ret < 0 ? -EIO : 0;
	}
	vtest_poll_resource_busy_wait();
	if (cmd == 0 || cmd >= sizeof(commands) / sizeof(commands[0]) || !commands[cmd].dispatch) {
		fprintf(stderr, "kw_virgl: client %d: unsupported vtest command %u\n", id, cmd);
		return -ENOSYS;
	}
	k = &commands[cmd];
	if (k->init_context && vtest_lazy_init_context(c->context))
		return -EIO;
	vtest_set_current_context(c->context);
	if (c->inline_data && cmd == VCMD_PROTOCOL_VERSION && size >= 12 &&
	    hdr[VTEST_CMD_DATA_START] > 3)
		((uint32_t *)hdr)[VTEST_CMD_DATA_START] = 3; // the inline dialect is version 3
	if (c->inline_data && cmd == VCMD_TRANSFER_PUT2) {
		ret = inline_put2(c, hdr, size);
		if (ret < 0)
			return ret;
	}
	ret = k->dispatch(hdr[VTEST_CMD_LEN]);
	// The native server reads a command's bytes as its handler asks for
	// them; a handler that asked for fewer than the command carried
	// (VCMD_TRANSFER_PUT with a short read) would leave the stream out of
	// step there as here: skip the rest, as framed.
	if (ret < 0)
		return -EIO;
	if (c->inline_data && cmd == VCMD_TRANSFER_GET2)
		return inline_get2_reply(id, c, hdr, size);
	return 0;
}

enum { WAIT_RUN, WAIT_ANSWERED, WAIT_PARKED };

// A waiting VCMD_RESOURCE_BUSY_WAIT. vtest loops in it until no client has
// a fence in flight (the implicit fence of every VCMD_SUBMIT_CMD), and a
// WebGL fence only signals between tasks, so it cannot loop here. What
// Mesa needs of the wait (.agents/gl.md, Busy waits): after a
// TRANSFER_GET2 it reads the data from its memfd, and before mapping a
// resource or at glFinish (fences) it wants the GPU done with the work
// submitted. Here the guest shares no memory with the GPU: every byte it
// reads came in a TRANSFER_GET2 (inline) or TRANSFER_GET (plain) reply,
// read with glReadPixels or getBufferSubData, which return only once the
// commands before them that write those bytes have run, and every byte it
// writes goes in with TRANSFER_PUT(2), which GL orders after the commands
// before it. The one result the host writes outside the command stream, a
// query's, reads as pending until it is there (patch 12), and Mesa reads
// it again until then. So no answer to a wait can make the guest read
// data that is not valid; what the answer decides is timing: how far the
// guest may run ahead of the GPU. The answer:
//
// - at once (WAIT_ANSWERED), right after a TRANSFER_GET(2) of the same
//   resource with only busy waits between: its reply carried the data;
// - by vtest (WAIT_RUN) when the fences submitted before it have retired;
// - at once, ahead of those fences, when the client's last answer ahead
//   has retired or has been followed by a TRANSFER_GET(2) of the client
//   (a read that waited for the GPU work it reads), so that a client runs
//   at most one wait ahead of the GPU, and one that reads back each frame
//   never parks;
// - else it parks (WAIT_PARKED) until the fences of that earlier answer
//   have retired, and kw_virgl_poll answers it ahead then.
//
// A strict client (KW_VIRGL_STRICT_WAIT) parks until the fences submitted
// before the wait have retired, every time: vtest's answer.
static int busy_wait(int id, struct kw_client *c, uint32_t handle)
{
	static const uint32_t idle[3] = { 1, VCMD_RESOURCE_BUSY_WAIT, 0 };
	uint32_t done, submitted = vtest_renderer_fences(&done);
	bool read = handle && handle == c->got && !c->strict;
	int ret;

	if (!c->waiting) {
		c->waiting = true;
		c->wait_seq = submitted;
		stats[KW_VIRGL_STAT_WAITS]++;
	}
	if (c->ahead && (int32_t)(done - c->ahead_seq) >= 0)
		c->ahead = false;
	if (read) {
		stats[KW_VIRGL_STAT_WAITS_READ]++;
		ret = WAIT_ANSWERED;
	} else if ((int32_t)(done - c->wait_seq) >= 0) {
		if (!c->parked_at)
			stats[KW_VIRGL_STAT_WAITS_DONE]++;
		// others' work may be in flight, which vtest would wait for
		ret = done == submitted ? WAIT_RUN : WAIT_ANSWERED;
	} else if (!c->ahead && !c->strict) {
		c->ahead = true;
		c->ahead_seq = c->wait_seq;
		if (!c->parked_at)
			stats[KW_VIRGL_STAT_WAITS_AHEAD]++;
		ret = WAIT_ANSWERED;
	} else {
		if (!c->parked_at) {
			c->parked_at = emscripten_get_now();
			stats[KW_VIRGL_STAT_PARKS]++;
		}
		c->state = KW_VIRGL_PARKED;
		return WAIT_PARKED;
	}
	c->waiting = false;
	if (c->parked_at) {
		double ms = emscripten_get_now() - c->parked_at;

		stats[KW_VIRGL_STAT_PARKED_MS] += ms;
		if (ms > stats[KW_VIRGL_STAT_PARK_MAX_MS])
			stats[KW_VIRGL_STAT_PARK_MAX_MS] = ms;
		c->parked_at = 0;
	}
	if (ret == WAIT_ANSWERED && vtest_block_write(id, (void *)idle, sizeof(idle)) < 0)
		c->state = -ENOMEM;
	return ret;
}

// Run the client's complete commands until it runs out of bytes, parks or
// fails; sets and returns its state.
static int client_run(int id, struct kw_client *c)
{
	while (c->state == KW_VIRGL_OK) {
		uint32_t avail = c->in.len - c->in_pos;
		const uint32_t *hdr;
		int64_t size;
		uint32_t cmd;
		double t;
		int ret;

		if (avail < 8)
			break;
		// in.data is malloc-aligned and every command is a whole number of
		// dwords but CREATE_RENDERER and TRANSFER_PUT, which may leave the
		// next header unaligned: move the rest down first.
		if (c->in_pos & 3) {
			memmove(c->in.data, c->in.data + c->in_pos, avail);
			c->in.len = avail;
			c->in_pos = 0;
		}
		hdr = (const uint32_t *)(c->in.data + c->in_pos);
		size = command_size(hdr, avail);
		if (size < 0 || size > KW_MAX_COMMAND) {
			c->state = -EPROTO;
			break;
		}
		if (size == 0 || size > avail)
			break;
		if (hdr[VTEST_CMD_ID] == VCMD_RESOURCE_BUSY_WAIT && c->context &&
		    size >= 8 + 4 * VCMD_BUSY_WAIT_SIZE &&
		    (hdr[VTEST_CMD_DATA_START + VCMD_BUSY_WAIT_FLAGS] & VCMD_BUSY_WAIT_FLAG_WAIT)) {
			int w = busy_wait(id, c, hdr[VTEST_CMD_DATA_START + VCMD_BUSY_WAIT_HANDLE]);

			if (w == WAIT_PARKED)
				break;
			if (w == WAIT_ANSWERED) {
				c->in_pos += (uint32_t)size;
				continue;
			}
		}
		cmd = hdr[VTEST_CMD_ID];
		t = emscripten_get_now();
		current = c;
		ret = run_command(id, c, hdr, (uint32_t)size);
		current = NULL;
		switch (cmd) {
		case VCMD_SUBMIT_CMD:
			stat_time(KW_VIRGL_STAT_SUBMITS, KW_VIRGL_STAT_SUBMIT_MS, t);
			c->got = 0;
			break;
		case VCMD_TRANSFER_GET:
		case VCMD_TRANSFER_GET2:
			stat_time(KW_VIRGL_STAT_READS, KW_VIRGL_STAT_READ_MS, t);
			// the handle, the first argument of either
			c->got = size >= 12 ? hdr[VTEST_CMD_DATA_START] : 0;
			c->ahead = false; // busy_wait
			break;
		case VCMD_TRANSFER_PUT:
		case VCMD_TRANSFER_PUT2:
			stat_time(KW_VIRGL_STAT_WRITES, KW_VIRGL_STAT_WRITE_MS, t);
			c->got = 0;
			break;
		case VCMD_RESOURCE_BUSY_WAIT:
			stat_time(KW_VIRGL_STAT_OTHERS, KW_VIRGL_STAT_OTHER_MS, t);
			break;
		default:
			stat_time(KW_VIRGL_STAT_OTHERS, KW_VIRGL_STAT_OTHER_MS, t);
			c->got = 0;
		}
		c->in_pos += (uint32_t)size;
		if (ret < 0)
			c->state = ret;
	}
	if (c->in_pos == c->in.len) {
		c->in.len = 0;
		c->in_pos = 0;
	}
	return c->state;
}

// --- the API ---

EMSCRIPTEN_KEEPALIVE int kw_virgl_init(int webgl_context)
{
	struct virgl_renderer_callbacks *cbs;

	if (initialized)
		return -EBUSY;
	if (webgl_context <= 0)
		return -EINVAL;
	gl_context = webgl_context;
	if (emscripten_webgl_make_context_current(gl_context) != EMSCRIPTEN_RESULT_SUCCESS)
		return -EINVAL;
	cbs = vtest_renderer_callbacks();
	cbs->create_gl_context = kw_create_gl_context;
	cbs->destroy_gl_context = kw_destroy_gl_context;
	cbs->make_current = kw_make_current;
	// No VIRGL_RENDERER_USE_EGL/GLX: the hooks above are the winsys. Every
	// client shares the one WebGL2 context, so the renderer must switch GL
	// state between them: VIRGL_RENDERER_SINGLE_GL_CONTEXT. It ignores the
	// VIRGL_RENDERER_THREAD_SYNC that vtest_init_renderer asks for.
	// glGetError is a round trip in WebGL: VIRGL_RENDERER_COARSE_GL_ERRORS.
	if (vtest_init_renderer(false, VIRGL_RENDERER_USE_GLES | VIRGL_RENDERER_SINGLE_GL_CONTEXT |
				VIRGL_RENDERER_COARSE_GL_ERRORS, NULL))
		return -EIO;
	initialized = true;
	return 0;
}

EMSCRIPTEN_KEEPALIVE int kw_virgl_open(uint32_t flags)
{
	int id;

	if (flags & ~(KW_VIRGL_INLINE | KW_VIRGL_STRICT_WAIT))
		return -EINVAL;
	if (!initialized)
		return -ENODEV;
	for (id = 1; id <= KW_MAX_CLIENTS; id++) {
		if (!clients[id].used) {
			memset(&clients[id], 0, sizeof(clients[id]));
			clients[id].used = true;
			clients[id].inline_data = flags & KW_VIRGL_INLINE;
			clients[id].strict = flags & KW_VIRGL_STRICT_WAIT;
			return id;
		}
	}
	return -EMFILE;
}

EMSCRIPTEN_KEEPALIVE void kw_virgl_close(int id)
{
	struct kw_client *c = client_get(id);

	if (!c)
		return;
	if (c->context) {
		current = c;
		vtest_destroy_context(c->context);
		current = NULL;
	}
	free(c->in.data);
	free(c->out.data);
	memset(c, 0, sizeof(*c));
}

EMSCRIPTEN_KEEPALIVE int kw_virgl_feed(int id, const uint8_t *data, uint32_t len)
{
	struct kw_client *c = client_get(id);

	if (!c)
		return -ENOENT;
	if (c->state < 0)
		return c->state;
	if (len) {
		if (bytes_reserve(&c->in, len))
			return c->state = -ENOMEM;
		memcpy(c->in.data + c->in.len, data, len);
		c->in.len += len;
	}
	if (c->state == KW_VIRGL_PARKED)
		return c->state;
	return client_run(id, c);
}

EMSCRIPTEN_KEEPALIVE int kw_virgl_poll(void)
{
	int id, parked = 0;
	bool polled = false;

	if (!initialized)
		return 0;
	vtest_poll_resource_busy_wait();
	for (id = 1; id <= KW_MAX_CLIENTS; id++) {
		struct kw_client *c = &clients[id];

		if (!c->used || c->state != KW_VIRGL_PARKED)
			continue;
		if (!polled) {
			polled = true;
			stats[KW_VIRGL_STAT_POLLS]++;
		}
		c->state = KW_VIRGL_OK;
		if (client_run(id, c) == KW_VIRGL_PARKED)
			parked++;
	}
	return parked;
}

EMSCRIPTEN_KEEPALIVE const uint8_t *kw_virgl_reply_ptr(int id)
{
	struct kw_client *c = client_get(id);

	return c ? c->out.data : NULL;
}

EMSCRIPTEN_KEEPALIVE uint32_t kw_virgl_reply_len(int id)
{
	struct kw_client *c = client_get(id);

	return c ? c->out.len : 0;
}

EMSCRIPTEN_KEEPALIVE void kw_virgl_consume(int id, uint32_t n)
{
	struct kw_client *c = client_get(id);

	if (!c)
		return;
	if (n >= c->out.len) {
		c->out.len = 0;
		return;
	}
	memmove(c->out.data, c->out.data + n, c->out.len - n);
	c->out.len -= n;
}

EMSCRIPTEN_KEEPALIVE const double *kw_virgl_stats(void)
{
	return stats;
}

EMSCRIPTEN_KEEPALIVE int kw_virgl_state(int id)
{
	struct kw_client *c = client_get(id);

	return c ? c->state : -ENOENT;
}
