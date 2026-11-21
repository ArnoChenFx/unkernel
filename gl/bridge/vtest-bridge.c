// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Carries vtest clients (Mesa's virgl driver, GALLIUM_DRIVER=virpipe) to a
// renderer in a web page, and stands in for that renderer with the native
// virgl_test_server. One program, two modes, the bridge with two links:
//
//   vtest-bridge bridge --socket PATH [--www DIR] [--port N] [--port-file F]
//       Listens on the vtest unix socket PATH (only while a page is
//       connected and ready) and carries every client over one WebSocket to
//       the page, which connects to ws://127.0.0.1:N/. Plain GETs on the
//       same port serve the page from DIR.
//   vtest-bridge bridge --link unix:PATH|vsock:CID:PORT [--socket PATH] [--daemon]
//       The same with the far side on one connected byte stream in place of
//       the WebSocket: the guest's end of kwvsock in unkernel, a unix socket
//       for testing. It connects to the address (again every second while
//       it cannot, or after the link closes) and sends each WebSocket
//       message there after its length (README.md, Stream framing), and
//       its log lines as LOG messages. The vtest socket defaults to
//       /tmp/.virgl_test, Mesa's default VTEST_SOCKET_NAME. --daemon: once
//       it holds the socket's lock, it goes on in the background (a new
//       session, stdio on /dev/null) and the command exits 0.
//
// One bridge per vtest socket: a bridge holds an abstract unix socket named
// after its vtest socket while it runs, and another bridge for the same
// socket exits (0 with --daemon, so starting it is idempotent; else 1).
// The vtest socket is made mode 0666, so that any user's clients connect.
//   vtest-bridge helper --server PATH [--port N] [--port-file F]
//       Accepts the page's relay WebSocket and opens one connection to the
//       vtest server at PATH per client.
//
// The far side gets the "inline" vtest dialect (README.md): protocol
// version 3 without file descriptors. Mesa expects a memfd per resource
// (VCMD_RESOURCE_CREATE2, VCMD_RESOURCE_CREATE_BLOB) and transfers through
// it; the bridge creates that memfd itself and copies its contents into and
// out of the byte stream at TRANSFER_PUT2 and TRANSFER_GET2. The helper does
// the reverse against a real server. Both directions are framed per command,
// which needs each command's real size: vtest's length field is not always
// honest (TRANSFER_PUT2 from Mesa counts data it does not send, the caps
// replies count bytes plus one), so sizes come from the tables below.
//
// Parts: the vtest core (clients, fd termination, per-command framing),
// which sees the far side only as messages (link_send(), on_mux(), the
// link's queue for back pressure, the link going away); the stream link;
// the WebSocket link with its HTTP server. -DVTEST_BRIDGE_STREAM_ONLY
// leaves out the WebSocket link and helper mode: the guest's build, which
// needs nothing but libc.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

// vtest/vtest_protocol.h (virglrenderer 1.3.0)
enum {
	VCMD_GET_CAPS = 1,
	VCMD_RESOURCE_CREATE = 2,
	VCMD_RESOURCE_UNREF = 3,
	VCMD_TRANSFER_GET = 4,
	VCMD_TRANSFER_PUT = 5,
	VCMD_SUBMIT_CMD = 6,
	VCMD_RESOURCE_BUSY_WAIT = 7,
	VCMD_CREATE_RENDERER = 8,
	VCMD_GET_CAPS2 = 9,
	VCMD_PING_PROTOCOL_VERSION = 10,
	VCMD_PROTOCOL_VERSION = 11,
	VCMD_RESOURCE_CREATE2 = 12,
	VCMD_TRANSFER_GET2 = 13,
	VCMD_TRANSFER_PUT2 = 14,
	VCMD_GET_PARAM = 15,
	VCMD_GET_CAPSET = 16,
	VCMD_CONTEXT_INIT = 17,
	VCMD_RESOURCE_CREATE_BLOB = 18,
};
#define DIALECT_VERSION 3
// src/virgl_hw.h: offsetof(struct virgl_caps_v2, capability_bits) and bits.
// Without VIRGL_CAP_TRANSFER Mesa does not encode transfers in the command
// stream (where the host would read the memfd during SUBMIT_CMD), and so no
// staging either (virgl_context.c, virgl_context_create); without
// VIRGL_CAP_ARB_BUFFER_STORAGE it creates no persistent or coherent blobs
// (virgl_screen.c, buffer_map_persistent_coherent).
#define CAPS_V2_CAPABILITY_BITS 392
#define CAP_TRANSFER (1u << 17)
#define CAP_COPY_TRANSFER (1u << 26)
#define CAP_ARB_BUFFER_STORAGE (1u << 31)

// One message to or from the far side: u32 client id, u8 type, payload. A
// WebSocket binary message each; on the stream link each after a u32 length.
enum { MUX_OPEN = 1, MUX_DATA = 2, MUX_CLOSE = 3, MUX_READY = 4, MUX_LOG = 5 };
#define MUX_HDR 5
#define MUX_CHUNK (1u << 20)
#define MUX_MAX (512u << 20)
#define HIGH_WATER (32u << 20)
#define READ_SIZE (256u << 10)
// Mesa's VTEST_DEFAULT_SOCKET_NAME (src/gallium/winsys/virgl/vtest)
#define DEFAULT_SOCKET "/tmp/.virgl_test"

#ifdef VTEST_BRIDGE_STREAM_ONLY
static const bool helper_mode = false;
#else
static bool helper_mode;
#endif
static const char *sock_path, *server_path, *www_dir = ".", *port_file, *link_addr;
static int tcp_port;
static int verbose;
static bool daemonize;

static double now(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static void link_log(const char *s, size_t n);

// A log line to stderr and, on the stream link, to the far side as LOG (a
// daemon's stderr is /dev/null; the SDK logs what it gets).
static void logf_(const char *fmt, ...)
{
	char line[1024];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(line, sizeof(line), fmt, ap);
	va_end(ap);
	if (n < 0)
		return;
	if ((size_t)n >= sizeof(line))
		n = sizeof(line) - 1;
	fprintf(stderr, "%s: %s\n", helper_mode ? "helper" : "bridge", line);
	link_log(line, n);
}

static void die(const char *what)
{
	logf_("%s: %s", what, strerror(errno));
	if (sock_path && !helper_mode)
		unlink(sock_path);
	exit(1);
}

// ---- byte buffers

struct buf {
	uint8_t *p;
	size_t r, w, cap;
};

static size_t blen(const struct buf *b) { return b->w - b->r; }
static uint8_t *bdata(const struct buf *b) { return b->p + b->r; }

static uint8_t *bput(struct buf *b, const void *d, size_t n)
{
	if (b->w + n > b->cap) {
		if (b->r) {
			memmove(b->p, b->p + b->r, b->w - b->r);
			b->w -= b->r;
			b->r = 0;
		}
		if (b->w + n > b->cap) {
			size_t c = b->cap ? b->cap : 4096;
			while (c < b->w + n)
				c *= 2;
			if (!(b->p = realloc(b->p, c)))
				die("realloc");
			b->cap = c;
		}
	}
	uint8_t *q = b->p + b->w;
	if (d)
		memcpy(q, d, n);
	else
		memset(q, 0, n);
	b->w += n;
	return q;
}

static void bconsume(struct buf *b, size_t n)
{
	b->r += n;
	if (b->r == b->w)
		b->r = b->w = 0;
}

static void bfree(struct buf *b)
{
	free(b->p);
	memset(b, 0, sizeof(*b));
}

// vtest is little-endian, as are the hosts this runs on.
static uint32_t rd32(const uint8_t *p)
{
	uint32_t v;
	memcpy(&v, p, 4);
	return v;
}

static void bput32(struct buf *b, uint32_t v) { bput(b, &v, 4); }

static void bput_hdr(struct buf *b, uint32_t len, uint32_t cmd)
{
	bput32(b, len);
	bput32(b, cmd);
}

static uint32_t pad4(uint32_t n) { return (n + 3) & ~3u; }

// ---- the link to the far side, as the core sees it

// A connection: an HTTP request or WebSocket (the WebSocket link), or the
// stream link. far is the one that carries the clients, when there is one.
enum { CONN_HTTP, CONN_WS, CONN_CLOSING, CONN_FAILED, CONN_STREAM };

struct conn {
	int fd;
	int state; // CONN_*; CONN_CLOSING: close once out is written
	struct buf in, out, msg;
	uint8_t msgop;
	struct conn *next;
};

static struct conn *conns, *far;

#ifndef VTEST_BRIDGE_STREAM_ONLY
static void ws_frame(struct conn *k, uint8_t op, const void *a, size_t alen, const void *b, size_t blen_);
#endif

// Queues one message for the far side (dropped while there is none).
static void link_send(uint8_t type, uint32_t id, const void *data, size_t len)
{
	if (!far)
		return;
	uint8_t h[4 + MUX_HDR];
	uint32_t n = MUX_HDR + len;
	memcpy(h, &n, 4);
	memcpy(h + 4, &id, 4);
	h[8] = type;
	if (far->state == CONN_STREAM) {
		bput(&far->out, h, sizeof(h));
		if (len)
			bput(&far->out, data, len);
		return;
	}
#ifndef VTEST_BRIDGE_STREAM_ONLY
	ws_frame(far, 2, h + 4, MUX_HDR, data, len);
#endif
}

static void link_log(const char *s, size_t n)
{
	if (far && far->state == CONN_STREAM)
		link_send(MUX_LOG, 0, s, n);
}

// ---- clients

// What a request leaves the client waiting for, in order.
enum { E_PLAIN = 1, E_CAPS, E_PV, E_CREATE, E_GET2, E_GET2PING };

struct expect {
	uint8_t kind;
	uint32_t id, res, offset, size;
	double t;
};

struct res {
	uint32_t id, size;
	uint8_t *map;
	struct res *next;
};

#define RES_BUCKETS 256

struct client {
	uint32_t id;
	int fd; // the Mesa client (bridge) or the server connection (helper)
	struct buf in; // requests: from Mesa (bridge), from the page (helper)
	struct buf rin; // replies: from the page (bridge), from the server (helper)
	struct buf out; // to fd
	struct buf up; // to the page: requests (bridge), replies (helper)
	struct {
		uint64_t pos;
		int fd;
	} *marks; // bridge: fds to pass at these positions of the out stream
	size_t nmarks, capmarks;
	uint64_t written; // bytes of out written so far
	int rfds[64]; // helper: fds received from the server, oldest first
	size_t nrfds;
	struct expect *ex;
	size_t exr, exw, excap;
	struct res *res[RES_BUCKETS];
	uint32_t version;
	bool need_fdbyte;
	uint32_t fd_res, fd_size;
	bool closing; // the far side is gone: flush out, then close
	uint64_t nup, ndown;
	unsigned replies;
	double wait, t0;
	char name[32];
	struct client *next;
};

static struct client *clients;

static struct client *client_find(uint32_t id)
{
	for (struct client *c = clients; c; c = c->next)
		if (c->id == id)
			return c;
	return NULL;
}

static void ex_push(struct client *c, uint8_t kind, uint32_t id, uint32_t res, uint32_t offset, uint32_t size)
{
	if (c->exw == c->excap) {
		if (c->exr) {
			memmove(c->ex, c->ex + c->exr, (c->exw - c->exr) * sizeof(*c->ex));
			c->exw -= c->exr;
			c->exr = 0;
		}
		if (c->exw == c->excap) {
			c->excap = c->excap ? c->excap * 2 : 16;
			if (!(c->ex = realloc(c->ex, c->excap * sizeof(*c->ex))))
				die("realloc");
		}
	}
	c->ex[c->exw++] = (struct expect){ kind, id, res, offset, size, now() };
}

static struct res *res_get(struct client *c, uint32_t id)
{
	for (struct res *r = c->res[id % RES_BUCKETS]; r; r = r->next)
		if (r->id == id)
			return r;
	return NULL;
}

static void res_del(struct client *c, uint32_t id)
{
	for (struct res **pp = &c->res[id % RES_BUCKETS]; *pp; pp = &(*pp)->next) {
		struct res *r = *pp;
		if (r->id == id) {
			*pp = r->next;
			munmap(r->map, r->size);
			free(r);
			return;
		}
	}
}

static void res_add(struct client *c, uint32_t id, uint32_t size, uint8_t *map)
{
	res_del(c, id);
	struct res *r = malloc(sizeof(*r));
	if (!r)
		die("malloc");
	*r = (struct res){ id, size, map, c->res[id % RES_BUCKETS] };
	c->res[id % RES_BUCKETS] = r;
}

// Copies between a resource's backing and the stream, clamped to its size.
static void res_read(struct client *c, uint32_t id, uint32_t offset, uint32_t size, struct buf *to)
{
	uint8_t *q = bput(to, NULL, pad4(size));
	struct res *r = res_get(c, id);
	if (r && offset < r->size)
		memcpy(q, r->map + offset, size < r->size - offset ? size : r->size - offset);
	else if (size)
		logf_("%s: transfer of %u bytes at %u to resource %u without backing", c->name, size, offset, id);
}

static void res_write(struct client *c, uint32_t id, uint32_t offset, uint32_t size, const uint8_t *from)
{
	struct res *r = res_get(c, id);
	if (r && offset < r->size)
		memcpy(r->map + offset, from, size < r->size - offset ? size : r->size - offset);
	else if (size)
		logf_("%s: transfer of %u bytes at %u from resource %u without backing", c->name, size, offset, id);
}

// ---- requests: Mesa -> bridge -> page (bridge), page -> helper -> server (helper)

static int parse_requests(struct client *c)
{
	struct buf *to = helper_mode ? &c->out : &c->up;
	for (;;) {
		if (blen(&c->in) < 8)
			return 0;
		const uint8_t *p = bdata(&c->in);
		uint32_t len = rd32(p), cmd = rd32(p + 4);
		const uint8_t *a = p + 8;
		size_t avail = blen(&c->in) - 8;
		uint32_t fixed = 0;
		size_t body = SIZE_MAX; // bytes after the header, when not fixed dwords
		uint8_t expect = 0;
		bool needs_v3 = true;
		switch (cmd) {
		// Whole commands only, these too, so that a client that dies in
		// the middle of one leaves no half command for the renderer.
		case VCMD_CREATE_RENDERER: // the name, len bytes
			body = len;
			needs_v3 = false;
			break;
		case VCMD_SUBMIT_CMD: // len dwords
			body = (size_t)len * 4;
			break;
		case VCMD_GET_CAPS:
		case VCMD_GET_CAPS2:
			expect = E_CAPS;
			needs_v3 = false;
			break;
		case VCMD_PING_PROTOCOL_VERSION:
			expect = E_PLAIN;
			needs_v3 = false;
			break;
		case VCMD_RESOURCE_BUSY_WAIT:
			fixed = 2;
			expect = E_PLAIN;
			needs_v3 = false;
			break;
		case VCMD_PROTOCOL_VERSION:
			fixed = 1;
			expect = E_PV;
			needs_v3 = false;
			break;
		case VCMD_RESOURCE_UNREF:
		case VCMD_CONTEXT_INIT:
			fixed = 1;
			break;
		case VCMD_GET_PARAM:
			fixed = 1;
			expect = E_PLAIN;
			break;
		case VCMD_GET_CAPSET:
			fixed = 2;
			expect = E_PLAIN;
			break;
		case VCMD_RESOURCE_CREATE: // no backing in version 3, a res_id reply
			fixed = 10;
			expect = E_PLAIN;
			break;
		case VCMD_RESOURCE_CREATE2:
			fixed = 11;
			expect = E_CREATE;
			break;
		case VCMD_RESOURCE_CREATE_BLOB:
			fixed = 6;
			expect = E_CREATE;
			break;
		case VCMD_TRANSFER_GET2:
			fixed = 10;
			break;
		case VCMD_TRANSFER_PUT2:
			fixed = 10;
			// the dialect carries the data inline, as many bytes as data_size
			if (helper_mode && avail >= 40)
				fixed += pad4(rd32(a + 32)) / 4;
			break;
		default:
			// version 0 transfers (raw replies) and everything that
			// passes fds (syncs, fences, DRM syncobjs, export)
			logf_("%s: unsupported command %u (length %u)", c->name, cmd, len);
			return -1;
		}
		if (needs_v3 && !helper_mode && c->version != DIALECT_VERSION) {
			logf_("%s: command %u with protocol version %u, the bridge needs %u", c->name, cmd,
			      c->version, DIALECT_VERSION);
			return -1;
		}
		if (body == SIZE_MAX)
			body = fixed * 4;
		else if (body > (64u << 20)) {
			logf_("%s: command %u of %zu bytes", c->name, cmd, body);
			return -1;
		}
		if (avail < body)
			return 0;
		size_t total = 8 + body;
		uint32_t id = cmd;
		if (cmd == VCMD_GET_CAPS2)
			id = 2; // the reply comes as capset 2, VCMD_GET_CAPS as capset 1
		switch (cmd) {
		case VCMD_PROTOCOL_VERSION:
			bput(to, p, 8);
			bput32(to, rd32(a) < DIALECT_VERSION ? rd32(a) : DIALECT_VERSION);
			ex_push(c, E_PV, cmd, 0, 0, 0);
			break;
		case VCMD_RESOURCE_CREATE2:
			bput(to, p, total);
			ex_push(c, E_CREATE, cmd, 0, 0, rd32(a + 40));
			break;
		case VCMD_RESOURCE_CREATE_BLOB:
			if (rd32(a + 12) || rd32(a + 8) > (1u << 30)) {
				logf_("%s: blob too large", c->name);
				return -1;
			}
			bput(to, p, total);
			ex_push(c, E_CREATE, cmd, 0, 0, rd32(a + 8));
			break;
		case VCMD_RESOURCE_UNREF:
			bput(to, p, total);
			res_del(c, rd32(a));
			break;
		case VCMD_TRANSFER_PUT2: {
			uint32_t res = rd32(a), size = rd32(a + 32), offset = rd32(a + 36);
			if (helper_mode) {
				res_write(c, res, offset, size, a + 40);
				bput_hdr(to, 10, cmd);
				bput(to, a, 40);
			} else {
				bput_hdr(to, 10 + pad4(size) / 4, cmd);
				bput(to, a, 40);
				res_read(c, res, offset, size, to);
			}
			break;
		}
		case VCMD_TRANSFER_GET2: {
			uint32_t res = rd32(a), size = rd32(a + 32), offset = rd32(a + 36);
			bput(to, p, total);
			if (helper_mode) {
				// The server writes the backing before it reads the
				// next command: a ping's answer means the data is there.
				bput_hdr(to, 0, VCMD_PING_PROTOCOL_VERSION);
				ex_push(c, E_GET2PING, VCMD_PING_PROTOCOL_VERSION, res, offset, size);
			} else {
				ex_push(c, E_GET2, cmd, res, offset, size);
			}
			break;
		}
		default:
			bput(to, p, total);
			if (expect)
				ex_push(c, expect, id, 0, 0, 0);
		}
		if (verbose > 1)
			logf_("%s: request %u length %u", c->name, cmd, len);
		bconsume(&c->in, total);
	}
}

// ---- replies: page -> bridge -> Mesa (bridge), server -> helper -> page (helper)

static void pass_fd(struct client *c, int fd)
{
	if (c->nmarks == c->capmarks) {
		c->capmarks = c->capmarks ? c->capmarks * 2 : 16;
		if (!(c->marks = realloc(c->marks, c->capmarks * sizeof(*c->marks))))
			die("realloc");
	}
	c->marks[c->nmarks].pos = c->written + blen(&c->out);
	c->marks[c->nmarks].fd = fd;
	c->nmarks++;
	bput(&c->out, NULL, 1); // the byte that carries it, as vtest_send_fd sends
}

static int parse_replies(struct client *c)
{
	struct buf *to = helper_mode ? &c->up : &c->out;
	for (;;) {
		if (c->need_fdbyte) {
			if (!blen(&c->rin))
				return 0;
			if (!c->nrfds) {
				logf_("%s: no fd with resource %u", c->name, c->fd_res);
				return -1;
			}
			int fd = c->rfds[0];
			memmove(c->rfds, c->rfds + 1, --c->nrfds * sizeof(int));
			bconsume(&c->rin, 1);
			c->need_fdbyte = false;
			void *map = mmap(NULL, c->fd_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
			close(fd);
			if (map == MAP_FAILED) {
				logf_("%s: mmap of resource %u: %s", c->name, c->fd_res, strerror(errno));
				return -1;
			}
			res_add(c, c->fd_res, c->fd_size, map);
			continue;
		}
		if (blen(&c->rin) < 8)
			return 0;
		const uint8_t *p = bdata(&c->rin);
		uint32_t len = rd32(p), id = rd32(p + 4);
		if (c->exr == c->exw) {
			logf_("%s: reply %u (length %u) to no request", c->name, id, len);
			return -1;
		}
		struct expect *e = &c->ex[c->exr];
		if (id != e->id || (e->kind == E_CAPS && !len)) {
			logf_("%s: reply %u (length %u) where %u was due", c->name, id, len, e->id);
			return -1;
		}
		uint64_t n = e->kind == E_CAPS ? (uint64_t)len - 1 : (uint64_t)len * 4;
		if (n > (256u << 20)) {
			logf_("%s: reply %u of %llu bytes", c->name, id, (unsigned long long)n);
			return -1;
		}
		if (blen(&c->rin) < 8 + n)
			return 0;
		const uint8_t *a = p + 8;
		switch (e->kind) {
		case E_PV:
			if (n >= 4)
				c->version = rd32(a);
			if (c->version != DIALECT_VERSION)
				logf_("%s: protocol version %u, the bridge needs %u", c->name, c->version,
				      DIALECT_VERSION);
			bput(to, p, 8 + n);
			break;
		case E_CAPS: {
			uint8_t *q = bput(to, p, 8 + n) + 8;
			if (!helper_mode && id == 2 && n >= CAPS_V2_CAPABILITY_BITS + 4) {
				uint32_t bits = rd32(q + CAPS_V2_CAPABILITY_BITS);
				bits &= ~(CAP_TRANSFER | CAP_COPY_TRANSFER | CAP_ARB_BUFFER_STORAGE);
				memcpy(q + CAPS_V2_CAPABILITY_BITS, &bits, 4);
			}
			break;
		}
		case E_CREATE:
			bput(to, p, 8 + n);
			if (n < 4 || !e->size)
				break;
			if (helper_mode) {
				c->need_fdbyte = true;
				c->fd_res = rd32(a);
				c->fd_size = e->size;
			} else {
				int fd = memfd_create("vtest-bridge", MFD_CLOEXEC);
				if (fd < 0 || ftruncate(fd, e->size) < 0)
					die("memfd");
				void *map = mmap(NULL, e->size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
				if (map == MAP_FAILED)
					die("mmap");
				res_add(c, rd32(a), e->size, map);
				pass_fd(c, fd);
			}
			break;
		case E_GET2: // the data, into the backing; Mesa reads it after its busy wait
			res_write(c, e->res, e->offset, n < e->size ? n : e->size, a);
			break;
		case E_GET2PING:
			bput_hdr(to, pad4(e->size) / 4, VCMD_TRANSFER_GET2);
			res_read(c, e->res, e->offset, e->size, to);
			break;
		default:
			bput(to, p, 8 + n);
		}
		if (verbose > 1)
			logf_("%s: reply %u length %u", c->name, id, len);
		c->replies++;
		c->wait += now() - e->t;
		c->exr++;
		bconsume(&c->rin, 8 + n);
	}
}

// ---- clients and the messages of the far side

static void flush_up(struct client *c)
{
	while (blen(&c->up)) {
		size_t n = blen(&c->up) < MUX_CHUNK ? blen(&c->up) : MUX_CHUNK;
		link_send(MUX_DATA, c->id, bdata(&c->up), n);
		bconsume(&c->up, n);
		c->nup += n;
	}
}

static void client_free(struct client *c, bool tell_page)
{
	for (struct client **pp = &clients; *pp; pp = &(*pp)->next)
		if (*pp == c) {
			*pp = c->next;
			break;
		}
	if (tell_page)
		link_send(MUX_CLOSE, c->id, NULL, 0);
	if (verbose || c->exr != c->exw)
		logf_("%s: closed after %.1f s: %llu bytes to the page, %llu from it, %u replies, mean wait %.3f ms%s",
		      c->name, now() - c->t0, (unsigned long long)c->nup, (unsigned long long)c->ndown, c->replies,
		      c->replies ? c->wait * 1e3 / c->replies : 0.0, c->exr != c->exw ? ", replies outstanding" : "");
	if (c->fd >= 0)
		close(c->fd);
	for (size_t i = 0; i < c->nmarks; i++)
		close(c->marks[i].fd);
	for (size_t i = 0; i < c->nrfds; i++)
		close(c->rfds[i]);
	for (int i = 0; i < RES_BUCKETS; i++)
		while (c->res[i])
			res_del(c, c->res[i]->id);
	bfree(&c->in), bfree(&c->rin), bfree(&c->out), bfree(&c->up);
	free(c->marks);
	free(c->ex);
	free(c);
}

static struct client *client_new(uint32_t id, int fd)
{
	struct client *c = calloc(1, sizeof(*c));
	if (!c)
		die("calloc");
	c->id = id;
	c->fd = fd;
	c->t0 = now();
	snprintf(c->name, sizeof(c->name), "client %u", id);
	c->next = clients;
	clients = c;
	if (verbose)
		logf_("%s: open", c->name);
	return c;
}

// Writes out to the client's fd, passing fds at their marks. -1: gone.
static int client_flush(struct client *c)
{
	while (blen(&c->out)) {
		if (c->nmarks && c->marks[0].pos == c->written) {
			char cbuf[CMSG_SPACE(sizeof(int))] = { 0 };
			struct iovec iov = { bdata(&c->out), 1 };
			struct msghdr mh = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = cbuf,
					     .msg_controllen = sizeof(cbuf) };
			struct cmsghdr *cm = CMSG_FIRSTHDR(&mh);
			cm->cmsg_level = SOL_SOCKET;
			cm->cmsg_type = SCM_RIGHTS;
			cm->cmsg_len = CMSG_LEN(sizeof(int));
			memcpy(CMSG_DATA(cm), &c->marks[0].fd, sizeof(int));
			ssize_t k = sendmsg(c->fd, &mh, MSG_NOSIGNAL);
			if (k < 0)
				return errno == EAGAIN || errno == EINTR ? 0 : -1;
			close(c->marks[0].fd);
			memmove(c->marks, c->marks + 1, --c->nmarks * sizeof(*c->marks));
			bconsume(&c->out, 1);
			c->written++;
			continue;
		}
		size_t n = blen(&c->out);
		if (c->nmarks && c->marks[0].pos - c->written < n)
			n = c->marks[0].pos - c->written;
		ssize_t k = send(c->fd, bdata(&c->out), n, MSG_NOSIGNAL);
		if (k < 0)
			return errno == EAGAIN || errno == EINTR ? 0 : -1;
		bconsume(&c->out, k);
		c->written += k;
	}
	return 0;
}

static void client_fail(struct client *c)
{
	client_free(c, true);
}

// Bytes from the page for client id.
static void on_data(uint32_t id, const uint8_t *d, size_t n)
{
	struct client *c = client_find(id);
	if (!c || c->closing)
		return;
	c->ndown += n;
	if (helper_mode) {
		bput(&c->in, d, n);
		if (parse_requests(c) < 0)
			return client_fail(c);
	} else {
		bput(&c->rin, d, n);
		if (parse_replies(c) < 0)
			return client_fail(c);
	}
	if (client_flush(c) < 0)
		client_fail(c);
}

static int listen_unix = -1;

static void start_unix(void)
{
	if (listen_unix >= 0)
		return;
	struct sockaddr_un sa = { .sun_family = AF_UNIX };
	if (strlen(sock_path) >= sizeof(sa.sun_path)) {
		errno = ENAMETOOLONG;
		die(sock_path);
	}
	strcpy(sa.sun_path, sock_path);
	unlink(sock_path);
	listen_unix = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	if (listen_unix < 0 || bind(listen_unix, (void *)&sa, sizeof(sa)) < 0 || listen(listen_unix, 64) < 0)
		die(sock_path);
	// bind() made it with the umask; every user may connect (in the guest,
	// any user's GL program, whoever started the bridge).
	chmod(sock_path, 0666);
	logf_("ready: vtest clients on %s", sock_path);
}

static void stop_unix(void)
{
	if (listen_unix < 0)
		return;
	close(listen_unix);
	listen_unix = -1;
	unlink(sock_path);
}

// One message from the far side.
static void on_mux(const uint8_t *m, size_t n)
{
	if (n < MUX_HDR) {
		logf_("short message from the page");
		return;
	}
	uint32_t id = rd32(m);
	uint8_t type = m[4];
	m += MUX_HDR, n -= MUX_HDR;
	switch (type) {
	case MUX_DATA:
		on_data(id, m, n);
		break;
	case MUX_CLOSE: {
		struct client *c = client_find(id);
		if (!c)
			break;
		// once what is queued for it is written: the replies (bridge),
		// the client's last requests (helper)
		c->closing = true;
		break;
	}
	case MUX_OPEN:
		if (!helper_mode || client_find(id))
			break;
		{
			struct sockaddr_un sa = { .sun_family = AF_UNIX };
			snprintf(sa.sun_path, sizeof(sa.sun_path), "%s", server_path);
			int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
			if (fd < 0 || connect(fd, (void *)&sa, sizeof(sa)) < 0) {
				logf_("connect %s: %s", server_path, strerror(errno));
				if (fd >= 0)
					close(fd);
				link_send(MUX_CLOSE, id, NULL, 0);
				break;
			}
			fcntl(fd, F_SETFL, O_NONBLOCK);
			client_new(id, fd);
		}
		break;
	case MUX_READY:
		if (!helper_mode)
			start_unix();
		break;
	case MUX_LOG:
		fprintf(stderr, "page: %.*s\n", (int)n, m);
		break;
	}
}

static double link_retry; // stream link: when to connect again

static void conn_close(struct conn *k)
{
	for (struct conn **pp = &conns; *pp; pp = &(*pp)->next)
		if (*pp == k) {
			*pp = k->next;
			break;
		}
	if (k == far) {
		far = NULL;
		logf_(link_addr ? "link closed" : "page disconnected");
		if (!helper_mode)
			stop_unix();
		while (clients)
			client_free(clients, false);
		link_retry = now() + 1;
	}
	close(k->fd);
	bfree(&k->in), bfree(&k->out), bfree(&k->msg);
	free(k);
}

// ---- the stream link: u32 length (little-endian), then one message

static void on_stream(struct conn *k)
{
	while (blen(&k->in) >= 4 && k->state == CONN_STREAM) {
		uint32_t n = rd32(bdata(&k->in));
		if (n < MUX_HDR || n > MUX_MAX) {
			logf_("stream frame of %u bytes", n);
			k->state = CONN_FAILED;
			return;
		}
		if (blen(&k->in) - 4 < n)
			return;
		on_mux(bdata(&k->in) + 4, n);
		bconsume(&k->in, 4 + (size_t)n);
	}
}

static unsigned link_cid, link_port;

// Checks link_addr: 0 if it names unix:PATH or vsock:CID:PORT.
static int link_parse(void)
{
	char extra;
	if (!strncmp(link_addr, "unix:", 5))
		return strlen(link_addr + 5) && strlen(link_addr + 5) < sizeof(((struct sockaddr_un *)0)->sun_path)
			       ? 0
			       : -1;
	return sscanf(link_addr, "vsock:%u:%u%c", &link_cid, &link_port, &extra) == 2 ? 0 : -1;
}

static int link_connect(void)
{
	int fd;
	if (!strncmp(link_addr, "unix:", 5)) {
		struct sockaddr_un sa = { .sun_family = AF_UNIX };
		strcpy(sa.sun_path, link_addr + 5);
		fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, (void *)&sa, sizeof(sa)) < 0)
			goto fail;
	} else {
		struct sockaddr_vm sa = { .svm_family = AF_VSOCK, .svm_cid = link_cid, .svm_port = link_port };
		fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, (void *)&sa, sizeof(sa)) < 0)
			goto fail;
	}
	if (fd >= 0)
		fcntl(fd, F_SETFL, O_NONBLOCK);
	return fd;
fail: {
	int e = errno;
	close(fd);
	errno = e;
	return -1;
}
}

// ---- the WebSocket link and the HTTP server that serves the page

#ifndef VTEST_BRIDGE_STREAM_ONLY
static void sha1(const uint8_t *data, size_t len, uint8_t out[20])
{
	uint32_t h[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };
	size_t total = ((len + 8) / 64 + 1) * 64;
	uint8_t *m = calloc(1, total);
	memcpy(m, data, len);
	m[len] = 0x80;
	uint64_t bits = (uint64_t)len * 8;
	for (int i = 0; i < 8; i++)
		m[total - 1 - i] = bits >> (8 * i);
	for (size_t off = 0; off < total; off += 64) {
		uint32_t w[80];
		for (int i = 0; i < 16; i++)
			w[i] = (uint32_t)m[off + 4 * i] << 24 | m[off + 4 * i + 1] << 16 | m[off + 4 * i + 2] << 8 |
			       m[off + 4 * i + 3];
		for (int i = 16; i < 80; i++) {
			uint32_t x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
			w[i] = x << 1 | x >> 31;
		}
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
		for (int i = 0; i < 80; i++) {
			uint32_t f, k;
			if (i < 20)
				f = (b & c) | (~b & d), k = 0x5A827999;
			else if (i < 40)
				f = b ^ c ^ d, k = 0x6ED9EBA1;
			else if (i < 60)
				f = (b & c) | (b & d) | (c & d), k = 0x8F1BBCDC;
			else
				f = b ^ c ^ d, k = 0xCA62C1D6;
			uint32_t t = (a << 5 | a >> 27) + f + e + k + w[i];
			e = d, d = c, c = b << 30 | b >> 2, b = a, a = t;
		}
		h[0] += a, h[1] += b, h[2] += c, h[3] += d, h[4] += e;
	}
	free(m);
	for (int i = 0; i < 20; i++)
		out[i] = h[i / 4] >> (24 - 8 * (i % 4));
}

static void base64(const uint8_t *in, size_t n, char *out)
{
	static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t i, o = 0;
	for (i = 0; i + 2 < n; i += 3) {
		uint32_t v = in[i] << 16 | in[i + 1] << 8 | in[i + 2];
		out[o++] = t[v >> 18], out[o++] = t[v >> 12 & 63], out[o++] = t[v >> 6 & 63], out[o++] = t[v & 63];
	}
	if (i < n) {
		uint32_t v = in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0);
		out[o++] = t[v >> 18], out[o++] = t[v >> 12 & 63];
		out[o++] = i + 1 < n ? t[v >> 6 & 63] : '=';
		out[o++] = '=';
	}
	out[o] = 0;
}

static void ws_frame(struct conn *k, uint8_t op, const void *a, size_t alen, const void *b, size_t blen_)
{
	uint8_t h[10];
	size_t n = alen + blen_, hl;
	h[0] = 0x80 | op;
	if (n < 126) {
		h[1] = n;
		hl = 2;
	} else if (n < 65536) {
		h[1] = 126, h[2] = n >> 8, h[3] = n;
		hl = 4;
	} else {
		h[1] = 127;
		for (int i = 0; i < 8; i++)
			h[2 + i] = (uint64_t)n >> (56 - 8 * i);
		hl = 10;
	}
	bput(&k->out, h, hl);
	if (alen)
		bput(&k->out, a, alen);
	if (blen_)
		bput(&k->out, b, blen_);
}

static const char *header(const char *req, const char *name)
{
	size_t n = strlen(name);
	for (const char *l = strstr(req, "\r\n"); l; l = strstr(l + 2, "\r\n"))
		if (!strncasecmp(l + 2, name, n) && l[2 + n] == ':') {
			const char *v = l + 3 + n;
			while (*v == ' ')
				v++;
			return v;
		}
	return NULL;
}

static void http_reply(struct conn *k, const char *status, const char *type, const void *body, size_t n)
{
	char h[512];
	int hl = snprintf(h, sizeof(h),
			  "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\n"
			  "Cross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\n"
			  "Connection: close\r\n\r\n",
			  status, type, n);
	bput(&k->out, h, hl);
	bput(&k->out, body, n);
	k->state = CONN_CLOSING;
}

static void serve_file(struct conn *k, const char *path)
{
	static const char *types[][2] = { { ".html", "text/html; charset=utf-8" },
					  { ".js", "text/javascript" },
					  { ".mjs", "text/javascript" },
					  { ".wasm", "application/wasm" },
					  { ".json", "application/json" },
					  { ".css", "text/css" } };
	const char *type = NULL, *dot = strrchr(path, '.');
	for (size_t i = 0; dot && i < sizeof(types) / sizeof(types[0]); i++)
		if (!strcmp(dot, types[i][0]))
			type = types[i][1];
	bool ok = type && !strstr(path, "..") && !helper_mode;
	for (const char *s = path; ok && *s; s++)
		ok = (*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || (*s >= '0' && *s <= '9') ||
		     strchr("._-/", *s);
	char full[4096];
	FILE *f = NULL;
	if (ok && snprintf(full, sizeof(full), "%s/%s", www_dir, path) < (int)sizeof(full))
		f = fopen(full, "rb");
	if (!f)
		return http_reply(k, "404 Not Found", "text/plain", "not found\n", 10);
	struct buf b = { 0 };
	char tmp[65536];
	size_t r;
	while ((r = fread(tmp, 1, sizeof(tmp), f)) > 0)
		bput(&b, tmp, r);
	fclose(f);
	http_reply(k, "200 OK", type, bdata(&b), blen(&b));
	bfree(&b);
}

static void on_http(struct conn *k)
{
	bput(&k->in, "", 1); // terminate for the string functions
	char *req = (char *)bdata(&k->in);
	char *end = strstr(req, "\r\n\r\n");
	k->in.w--;
	if (!end) {
		if (blen(&k->in) > 16384)
			k->state = CONN_CLOSING;
		return;
	}
	end[2] = 0;
	char path[1024] = "";
	if (sscanf(req, "GET %1023s HTTP/1.1", path) != 1)
		return http_reply(k, "400 Bad Request", "text/plain", "bad request\n", 12);
	char *q = strchr(path, '?');
	if (q)
		*q = 0;
	const char *key = header(req, "Sec-WebSocket-Key");
	if (key) {
		if (far)
			return http_reply(k, "409 Conflict", "text/plain", "a page is connected\n", 20);
		char kb[128], acc[64];
		size_t kl = strcspn(key, "\r\n");
		uint8_t dig[20];
		snprintf(kb, sizeof(kb), "%.*s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", (int)(kl < 64 ? kl : 64), key);
		sha1((uint8_t *)kb, strlen(kb), dig);
		base64(dig, 20, acc);
		char h[256];
		int hl = snprintf(h, sizeof(h),
				  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
				  "Sec-WebSocket-Accept: %s\r\n\r\n",
				  acc);
		bput(&k->out, h, hl);
		bconsume(&k->in, end + 4 - req);
		k->state = CONN_WS;
		far = k;
		logf_("page connected");
		return;
	}
	serve_file(k, path[1] ? path + 1 : "index.html");
}

static void on_ws(struct conn *k)
{
	while (blen(&k->in) >= 2 && k->state == CONN_WS) {
		uint8_t *p = bdata(&k->in);
		size_t avail = blen(&k->in), h = 2;
		bool fin = p[0] & 0x80, masked = p[1] & 0x80;
		uint8_t op = p[0] & 15;
		uint64_t n = p[1] & 127;
		if (n == 126) {
			if (avail < 4)
				return;
			n = p[2] << 8 | p[3];
			h = 4;
		} else if (n == 127) {
			if (avail < 10)
				return;
			n = 0;
			for (int i = 0; i < 8; i++)
				n = n << 8 | p[2 + i];
			h = 10;
		}
		if (n > MUX_MAX) {
			logf_("WebSocket frame of %llu bytes", (unsigned long long)n);
			k->state = CONN_CLOSING;
			return;
		}
		uint8_t *mask = p + h;
		if (masked)
			h += 4;
		if (avail < h + n)
			return;
		uint8_t *d = p + h;
		if (masked) {
			uint64_t i = 0, m8;
			uint32_t m4;
			memcpy(&m4, mask, 4);
			m8 = (uint64_t)m4 << 32 | m4;
			for (; i + 8 <= n; i += 8) {
				uint64_t v;
				memcpy(&v, d + i, 8);
				v ^= m8;
				memcpy(d + i, &v, 8);
			}
			for (; i < n; i++)
				d[i] ^= mask[i & 3];
		}
		switch (op) {
		case 0:
		case 1:
		case 2:
			if (op)
				k->msgop = op;
			if (fin && !blen(&k->msg)) {
				on_mux(d, n);
			} else {
				bput(&k->msg, d, n);
				if (fin) {
					on_mux(bdata(&k->msg), blen(&k->msg));
					bfree(&k->msg);
				}
			}
			break;
		case 8:
			ws_frame(k, 8, d, n < 2 ? n : 2, NULL, 0);
			k->state = CONN_CLOSING;
			break;
		case 9:
			ws_frame(k, 10, d, n, NULL, 0);
			break;
		}
		if (far != k)
			return; // closed while handling
		bconsume(&k->in, h + n);
	}
}
#endif // VTEST_BRIDGE_STREAM_ONLY

// ---- main loop

static volatile sig_atomic_t stop;

static void on_signal(int sig)
{
	(void)sig;
	stop = 1;
}

// The bridge's lock: an abstract unix socket named after the vtest socket,
// held until it exits. 0, 1 if another bridge holds it, -1 on an error.
static int instance_lock(void)
{
	struct sockaddr_un sa = { .sun_family = AF_UNIX };
	int n = snprintf(sa.sun_path + 1, sizeof(sa.sun_path) - 1, "vtest-bridge:%s", sock_path);
	if (n < 0)
		return -1;
	if ((size_t)n > sizeof(sa.sun_path) - 1)
		n = sizeof(sa.sun_path) - 1;
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return -1;
	if (bind(fd, (void *)&sa, offsetof(struct sockaddr_un, sun_path) + 1 + n) < 0) {
		int e = errno;
		close(fd);
		errno = e;
		return e == EADDRINUSE ? 1 : -1;
	}
	return 0; // fd stays open: the lock
}

// --daemon: the parent exits 0, the child goes on in a session of its own
// with stdio on /dev/null (it logs over the link).
static void go_background(void)
{
	pid_t pid = fork();
	if (pid < 0)
		die("fork");
	if (pid > 0)
		_exit(0);
	setsid();
	if (chdir("/") < 0)
		die("chdir");
	int fd = open("/dev/null", O_RDWR | O_CLOEXEC);
	if (fd >= 0) {
		dup2(fd, 0), dup2(fd, 1), dup2(fd, 2);
		if (fd > 2)
			close(fd);
	}
}

static void usage(void)
{
#ifdef VTEST_BRIDGE_STREAM_ONLY
	fprintf(stderr, "usage: vtest-bridge bridge --link unix:PATH|vsock:CID:PORT [--socket PATH] [--daemon] [-v]\n");
#else
	fprintf(stderr, "usage: vtest-bridge bridge --socket PATH [--www DIR] [--port N] [--port-file F] [-v]\n"
			"       vtest-bridge bridge --link unix:PATH|vsock:CID:PORT [--socket PATH] [--daemon] [-v]\n"
			"       vtest-bridge helper --server PATH [--port N] [--port-file F] [-v]\n");
#endif
	exit(2);
}

static struct conn *conn_new(int fd, int state)
{
	struct conn *k = calloc(1, sizeof(*k));
	if (!k)
		die("calloc");
	k->fd = fd;
	k->state = state;
	k->next = conns;
	conns = k;
	return k;
}

int main(int argc, char **argv)
{
	if (argc < 2)
		usage();
#ifndef VTEST_BRIDGE_STREAM_ONLY
	if (!strcmp(argv[1], "helper"))
		helper_mode = true;
	else
#endif
		if (strcmp(argv[1], "bridge"))
		usage();
	for (int i = 2; i < argc; i++) {
		const char *o = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
		if (!strcmp(o, "-v")) {
			verbose++;
			continue;
		}
		if (!strcmp(o, "--daemon")) {
			daemonize = true;
			continue;
		}
		if (!v)
			usage();
		if (!strcmp(o, "--socket"))
			sock_path = v;
		else if (!strcmp(o, "--link"))
			link_addr = v;
		else if (!strcmp(o, "--server"))
			server_path = v;
		else if (!strcmp(o, "--www"))
			www_dir = v;
		else if (!strcmp(o, "--port"))
			tcp_port = atoi(v);
		else if (!strcmp(o, "--port-file"))
			port_file = v;
		else
			usage();
		i++;
	}
	if (link_addr && !helper_mode && !sock_path)
		sock_path = DEFAULT_SOCKET;
	if (helper_mode ? !server_path || link_addr : !sock_path)
		usage();
#ifdef VTEST_BRIDGE_STREAM_ONLY
	if (!link_addr)
		usage();
#endif
	if (link_addr && link_parse() < 0) {
		fprintf(stderr, "vtest-bridge: --link takes unix:PATH (under 108 bytes) or vsock:CID:PORT\n");
		exit(2);
	}
	if (daemonize && (helper_mode || !link_addr))
		usage();
	if (!helper_mode) {
		int r = instance_lock();
		if (r < 0) {
			fprintf(stderr, "vtest-bridge: lock: %s\n", strerror(errno));
			exit(1);
		}
		if (r > 0) {
			fprintf(stderr, "vtest-bridge: a bridge already serves %s\n", sock_path);
			exit(daemonize ? 0 : 1);
		}
	}
	if (daemonize)
		go_background();

	signal(SIGPIPE, SIG_IGN);
	struct sigaction sa = { .sa_handler = on_signal };
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);

	int lt = -1;
#ifndef VTEST_BRIDGE_STREAM_ONLY
	int one = 1;
	if (!link_addr) {
		lt = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
		setsockopt(lt, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
		struct sockaddr_in in = { .sin_family = AF_INET, .sin_port = htons(tcp_port),
					  .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
		socklen_t inl = sizeof(in);
		if (lt < 0 || bind(lt, (void *)&in, sizeof(in)) < 0 || listen(lt, 16) < 0 ||
		    getsockname(lt, (void *)&in, &inl) < 0)
			die("listen");
		logf_("listening on 127.0.0.1:%d", ntohs(in.sin_port));
		if (port_file) {
			char tmp[4096];
			snprintf(tmp, sizeof(tmp), "%s.tmp", port_file);
			FILE *f = fopen(tmp, "w");
			if (!f || fprintf(f, "%d\n", ntohs(in.sin_port)) < 0 || fclose(f) || rename(tmp, port_file))
				die(port_file);
		}
	}
#endif

	uint32_t next_id = 1;
	struct pollfd *pfd = NULL;
	size_t npfd = 0;
	uint8_t *rbuf = malloc(READ_SIZE);
	bool link_failed = false;
	while (!stop) {
		int timeout = -1;
		if (link_addr && !far) {
			double t = now();
			if (t >= link_retry) {
				int fd = link_connect();
				if (fd >= 0) {
					far = conn_new(fd, CONN_STREAM);
					logf_("link connected: %s", link_addr);
					link_failed = false;
				} else {
					if (!link_failed)
						logf_("link %s: %s; trying again every second", link_addr,
						      strerror(errno));
					link_failed = true;
					link_retry = t + 1;
				}
			}
			if (!far)
				timeout = (int)((link_retry - t) * 1000) + 1;
		}
		for (struct client *c = clients, *next; c; c = next) {
			next = c->next;
			if (c->closing && !blen(&c->out))
				client_free(c, false);
		}
		size_t nc = 0, nk = 0;
		for (struct client *c = clients; c; c = c->next)
			nc++;
		for (struct conn *k = conns; k; k = k->next)
			nk++;
		if (npfd < nc + nk + 2) {
			npfd = (nc + nk + 2) * 2;
			pfd = realloc(pfd, npfd * sizeof(*pfd));
		}
		size_t n = 0;
		pfd[n++] = (struct pollfd){ lt, POLLIN, 0 }; // -1 is ignored
		pfd[n++] = (struct pollfd){ listen_unix, POLLIN, 0 };
		// Back pressure: stop reading Mesa clients while the far side
		// lags (bridge), stop reading the page while a server lags
		// (helper). The reply direction is always read, so this cannot
		// deadlock.
		bool far_lags = far && blen(&far->out) > HIGH_WATER, server_lags = false;
		for (struct client *c = clients; c; c = c->next) {
			server_lags |= blen(&c->out) > HIGH_WATER;
			short ev = (blen(&c->out) ? POLLOUT : 0) | (helper_mode || !far_lags ? POLLIN : 0);
			pfd[n++] = (struct pollfd){ c->fd, ev, 0 };
		}
		for (struct conn *k = conns; k; k = k->next) {
			short ev = (blen(&k->out) ? POLLOUT : 0) | (k == far && server_lags ? 0 : POLLIN);
			pfd[n++] = (struct pollfd){ k->fd, ev, 0 };
		}
		if (poll(pfd, n, timeout) < 0) {
			if (errno == EINTR)
				continue;
			die("poll");
		}
		size_t i = 2;
		for (struct client *c = clients, *next; c; c = next, i++) {
			next = c->next;
			short re = pfd[i].revents;
			if (pfd[i].fd != c->fd)
				break; // the list changed under us; next round
			if (re & POLLOUT || c->closing) {
				if (client_flush(c) < 0) {
					client_free(c, true);
					continue;
				}
				if (c->closing && !blen(&c->out)) {
					client_free(c, false);
					continue;
				}
			}
			if (!(re & (POLLIN | POLLHUP | POLLERR)))
				continue;
			ssize_t r;
			if (helper_mode) {
				char cbuf[CMSG_SPACE(sizeof(int) * 16)];
				struct iovec iov = { rbuf, READ_SIZE };
				struct msghdr mh = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = cbuf,
						     .msg_controllen = sizeof(cbuf) };
				r = recvmsg(c->fd, &mh, MSG_CMSG_CLOEXEC);
				for (struct cmsghdr *cm = r > 0 ? CMSG_FIRSTHDR(&mh) : NULL; cm; cm = CMSG_NXTHDR(&mh, cm))
					if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
						size_t nf = (cm->cmsg_len - CMSG_LEN(0)) / sizeof(int);
						for (size_t f = 0; f < nf; f++) {
							int fd;
							memcpy(&fd, CMSG_DATA(cm) + f * sizeof(int), sizeof(int));
							if (c->nrfds < sizeof(c->rfds) / sizeof(int))
								c->rfds[c->nrfds++] = fd;
							else
								close(fd);
						}
					}
			} else {
				r = recv(c->fd, rbuf, READ_SIZE, 0);
			}
			if (r < 0 && (errno == EAGAIN || errno == EINTR))
				continue;
			if (r <= 0) {
				if (verbose)
					logf_("%s: %s hung up", c->name, helper_mode ? "server" : "client");
				client_free(c, true);
				continue;
			}
			int ret;
			if (helper_mode) {
				bput(&c->rin, rbuf, r);
				ret = parse_replies(c);
			} else {
				bput(&c->in, rbuf, r);
				ret = parse_requests(c);
			}
			if (ret < 0) {
				client_fail(c);
				continue;
			}
			flush_up(c);
		}
		i = 2 + nc;
		for (struct conn *k = conns, *next; k; k = next, i++) {
			next = k->next;
			if (i >= n || pfd[i].fd != k->fd)
				break;
			short re = pfd[i].revents;
			if (re & (POLLIN | POLLHUP | POLLERR)) {
				ssize_t r = recv(k->fd, rbuf, READ_SIZE, 0);
				if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {
					conn_close(k);
					continue;
				}
				if (r > 0) {
					bput(&k->in, rbuf, r);
					if (k->state == CONN_STREAM)
						on_stream(k);
#ifndef VTEST_BRIDGE_STREAM_ONLY
					if (k->state == CONN_HTTP)
						on_http(k);
					if (k->state == CONN_WS)
						on_ws(k);
#endif
				}
			}
		}
		// every link and HTTP write, including what the loop above queued
		for (struct conn *k = conns, *next; k; k = next) {
			next = k->next;
			while (blen(&k->out)) {
				ssize_t w = send(k->fd, bdata(&k->out), blen(&k->out), MSG_NOSIGNAL);
				if (w < 0) {
					if (errno != EAGAIN && errno != EINTR)
						k->state = CONN_FAILED;
					break;
				}
				bconsume(&k->out, w);
			}
			if (k->state == CONN_FAILED || (k->state == CONN_CLOSING && !blen(&k->out)))
				conn_close(k);
		}
#ifndef VTEST_BRIDGE_STREAM_ONLY
		if (lt >= 0 && pfd[0].revents & POLLIN) {
			int fd = accept4(lt, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
			if (fd >= 0) {
				setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
				conn_new(fd, CONN_HTTP);
			}
		}
#endif
		if (listen_unix >= 0 && pfd[1].fd == listen_unix && pfd[1].revents & POLLIN) {
			int fd = accept4(listen_unix, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
			if (fd >= 0) {
				struct client *c = client_new(next_id++, fd);
				link_send(MUX_OPEN, c->id, NULL, 0);
			}
		}
	}
	if (!helper_mode)
		stop_unix();
	return 0;
}
