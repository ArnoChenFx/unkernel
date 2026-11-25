// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwva: the guest's VA-API driver (libva's kw_drv_video.so). Decode, and
// encode where the host has an encoder (VAEntrypointEncSlice: VP9):
// every picture's buffers go to the host (va/PROTOCOL.md) over one stream
// per VADisplay (AF_VSOCK, host CID 2, port 1024; KWVA_LINK=vsock:, tcp:
// or unix:), where WebCodecs' VideoDecoder decodes it; the host says when
// each picture is ready, and its pixels come back as NV12 only when the
// app reads them (vaGetImage, or vaMapBuffer of a derived image). Profiles:
// what the host's hello reply offers, of the codecs table below (VP9
// profile 0; H.264 Constrained Baseline, Main and High; AV1 profile 0;
// HEVC Main). Surfaces' pixels live in this process's memory; for
// vaExportSurfaceHandle (DRM PRIME) a surface's planes are two virtio-gpu
// resources this driver makes on the render node, which the host fills
// from its own copy of each picture (zero-copy output: the pixels never
// pass through the guest). Video processing only converts NV12 to BGRX
// (mpv's scale_vaapi before --vo=dmabuf-wayland on a compositor that takes
// RGB dmabufs only), on the host too: into the exported resource, or read
// back as BGRX. No PutSurface. Encode: a picture's buffers and the input
// surface's NV12 pixels go to the host (only when they changed since the
// host last kept them, and not at all for a decoded picture the host still
// has), where WebCodecs' VideoEncoder encodes it; its chunk comes back with
// the picture's notice and becomes the coded buffer (VACodedBufferSegment).
// Reconstructed surfaces get nothing: the host's encoder keeps its own
// references.
//
// Threads: one mutex (mu) guards the driver's state; a reader thread reads
// every frame from the host (replies to requests, picture notices), so
// requests from several threads are in flight at once and nothing waits
// on the link with mu held: a request or vaSyncSurface waits on a
// condition variable, and writes take their own mutex (wmu, taken after
// mu is released). Objects can go away while a caller waits: callers look
// them up again by id, and a surface being waited on or read into is only
// freed by the last one using it.
#include <drm/drm.h>
#include <drm/virtgpu_drm.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <va/va.h>
#include <va/va_backend.h>
#include <va/va_dec_av1.h>
#include <va/va_dec_hevc.h>
#include <va/va_dec_vp9.h>
#include <va/va_enc_vp9.h>
#include <va/va_drmcommon.h>
#include <va/va_vpp.h>
#include <va/va_backend_vpp.h>

#define KWVA_EXPORT __attribute__((visibility("default")))
#define KWVA_PORT 1024
#define KWVA_VERSION 4
#define MAX_PROFILES 12
/* the largest frame either way (va/PROTOCOL.md): a picture's buffers, or a picture read back */
#define MAX_FRAME (64u << 20)
/* a picture's buffers, with room for the JSON */
#define MAX_PICTURE (MAX_FRAME - (1u << 20))

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
struct kw_sockaddr_vm {
	unsigned short svm_family, svm_reserved1;
	unsigned int svm_port, svm_cid;
	unsigned char svm_zero[4];
};

/* ---- logging ---- */

static int debug_on(void)
{
	static int on = -1;
	if (on < 0)
		on = getenv("KWVA_DEBUG") != NULL;
	return on;
}

static void kw_log(const char *fmt, ...)
{
	if (!debug_on())
		return;
	va_list ap;
	va_start(ap, fmt);
	fprintf(stderr, "kwva: ");
	vfprintf(stderr, fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
}

/* errors an app's user must see: always, each distinct line once */
static void kw_err(const char *fmt, ...)
{
	static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
	static uint32_t seen[64];
	static int nseen;
	char line[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(line, sizeof line, fmt, ap);
	va_end(ap);
	uint32_t h = 2166136261u;
	for (const char *p = line; *p; p++)
		h = (h ^ (uint8_t)*p) * 16777619u;
	pthread_mutex_lock(&mu);
	int dup = 0;
	for (int i = 0; i < nseen && !dup; i++)
		dup = seen[i] == h;
	if (!dup && nseen < 64)
		seen[nseen++] = h;
	pthread_mutex_unlock(&mu);
	if (!dup)
		fprintf(stderr, "kwva: %s\n", line);
}

/* ---- JSON: writing into a growable buffer, reading by key ---- */

struct jb {
	char *p;
	size_t n, cap;
};

static void jb_printf(struct jb *b, const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(NULL, 0, fmt, ap);
	va_end(ap);
	if (b->n + n + 1 > b->cap) {
		size_t c = b->cap ? b->cap * 2 : 256;
		while (c < b->n + n + 1)
			c *= 2;
		b->p = realloc(b->p, c);
		if (!b->p)
			abort();
		b->cap = c;
	}
	va_start(ap, fmt);
	vsnprintf(b->p + b->n, n + 1, fmt, ap);
	va_end(ap);
	b->n += n;
}

static const char *js_ws(const char *p)
{
	while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')
		p++;
	return p;
}

static const char *js_skip(const char *p)
{
	p = js_ws(p);
	if (*p == '"') {
		for (p++; *p && *p != '"'; p++)
			if (*p == '\\' && p[1])
				p++;
		return *p ? p + 1 : p;
	}
	if (*p == '{' || *p == '[') {
		int d = 0;
		do {
			if (*p == '"') {
				p = js_skip(p);
				continue;
			}
			if (*p == '{' || *p == '[')
				d++;
			else if (*p == '}' || *p == ']')
				d--;
			p++;
		} while (d > 0 && *p);
		return p;
	}
	while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ')
		p++;
	return p;
}

/* the value of key in the object at obj, or NULL */
static const char *js_get(const char *obj, const char *key)
{
	size_t n = strlen(key);
	const char *p = obj ? js_ws(obj) : NULL;
	if (!p || *p != '{')
		return NULL;
	p++;
	for (;;) {
		p = js_ws(p);
		if (*p == ',')
			p = js_ws(p + 1);
		if (*p != '"')
			return NULL;
		const char *k = p + 1, *e = js_skip(p);
		size_t kl = (size_t)(e - p) - 2;
		p = js_ws(e);
		if (*p != ':')
			return NULL;
		const char *v = js_ws(p + 1);
		if (kl == n && !memcmp(k, key, n))
			return v;
		p = js_skip(v);
	}
}

static double js_num(const char *v, double dflt)
{
	if (!v || *v == '"' || *v == '{' || *v == '[' || *v == 'n')
		return dflt;
	if (*v == 't')
		return 1;
	if (*v == 'f')
		return 0;
	return strtod(v, NULL);
}

static void js_str(const char *v, char *out, size_t cap)
{
	size_t n = 0;
	out[0] = 0;
	if (!v || *v != '"')
		return;
	for (v++; *v && *v != '"' && n + 1 < cap; v++) {
		if (*v == '\\' && v[1])
			v++;
		out[n++] = *v;
	}
	out[n] = 0;
}

/* the numbers of the array at v into out (at most max); how many */
static int js_nums(const char *v, double *out, int max)
{
	int n = 0;
	if (!v || *v != '[')
		return 0;
	for (v++; n < max;) {
		v = js_ws(v);
		if (*v == ',')
			v = js_ws(v + 1);
		if (*v == ']' || !*v)
			break;
		out[n++] = js_num(v, 0);
		v = js_skip(v);
	}
	return n;
}

/* ---- per-codec knowledge: one entry per VA profile the driver can offer ---- */

struct codec {
	VAProfile profile;
	const char *name; /* the profile on the wire (va/PROTOCOL.md) */
	/* the smallest element size of each buffer type this codec needs (0: any) */
	uint32_t min_size[VAProbabilityBufferType + 1];
	/* the reference surfaces its picture parameters name (VA_INVALID_SURFACE: none), at most 16 */
	int nrefs;
	void (*refs)(const void *pic, VASurfaceID *out);
	/* a second surface the picture writes besides the render target, or VA_INVALID_SURFACE (AV1 with film grain: the display picture) */
	VASurfaceID (*display)(const void *pic);
	/*
	 * Encode (VAEntrypointEncSlice), where the host has an encoder: the
	 * smallest picture and sequence parameters the host reads, and where the
	 * picture parameters name the coded buffer (0: no encode)
	 */
	uint32_t enc_pic_min, enc_seq_min;
	size_t enc_coded_off;
};

static void vp9_refs(const void *p, VASurfaceID *out)
{
	VADecPictureParameterBufferVP9 pp;
	memcpy(&pp, p, sizeof pp);
	for (int i = 0; i < 8; i++)
		out[i] = pp.reference_frames[i];
}

/*
 * H.264, AV1, HEVC: the picture parameters are only as long as their codec's
 * min_size (everything before va_reserved), so only that much is read
 */
#define PP_LOAD(pp, p) memcpy(&(pp), (p), offsetof(__typeof__(pp), va_reserved))

/* H.264: the DPB as the picture parameters name it (VA_PICTURE_H264_INVALID entries are none) */
static void h264_refs(const void *p, VASurfaceID *out)
{
	VAPictureParameterBufferH264 pp;
	PP_LOAD(pp, p);
	for (int i = 0; i < 16; i++)
		out[i] = pp.ReferenceFrames[i].flags & VA_PICTURE_H264_INVALID ? VA_INVALID_SURFACE : pp.ReferenceFrames[i].picture_id;
}

/* AV1: the reference map (ref_frame_map[8], VA_INVALID_SURFACE for none, as for a key frame) */
static void av1_refs(const void *p, VASurfaceID *out)
{
	VADecPictureParameterBufferAV1 pp;
	PP_LOAD(pp, p);
	for (int i = 0; i < 8; i++)
		out[i] = pp.ref_frame_map[i];
}

/* AV1: with film grain applied the render target (current_frame) is the reference without grain and current_display_picture gets the picture shown */
static VASurfaceID av1_display(const void *p)
{
	VADecPictureParameterBufferAV1 pp;
	PP_LOAD(pp, p);
	return pp.current_display_picture != pp.current_frame ? pp.current_display_picture : VA_INVALID_SURFACE;
}

/* HEVC: the DPB as the picture parameters name it (VA_PICTURE_HEVC_INVALID entries are none) */
static void hevc_refs(const void *p, VASurfaceID *out)
{
	VAPictureParameterBufferHEVC pp;
	PP_LOAD(pp, p);
	for (int i = 0; i < 15; i++)
		out[i] = pp.ReferenceFrames[i].flags & VA_PICTURE_HEVC_INVALID ? VA_INVALID_SURFACE : pp.ReferenceFrames[i].picture_id;
}

/* what the host reads of H.264's buffers: everything before va_reserved; of the slice parameters, the fields before RefPicList0 */
#define H264_CODEC(p, n)                                                                                          \
	{                                                                                                         \
		.profile = p, .name = n,                                                                          \
		.min_size = {[VAPictureParameterBufferType] = offsetof(VAPictureParameterBufferH264, va_reserved),  \
			     [VAIQMatrixBufferType] = offsetof(VAIQMatrixBufferH264, va_reserved),                  \
			     [VASliceParameterBufferType] = offsetof(VASliceParameterBufferH264, RefPicList0)},     \
		.nrefs = 16, .refs = h264_refs,                                                                   \
	}

static const struct codec codecs[] = {
	{
		.profile = VAProfileVP9Profile0,
		.name = "vp9.0",
		.min_size = {[VAPictureParameterBufferType] = sizeof(VADecPictureParameterBufferVP9),
			     [VASliceParameterBufferType] = sizeof(VASliceParameterBufferVP9)},
		.nrefs = 8,
		.refs = vp9_refs,
		/* what the host reads: everything before va_reserved */
		.enc_pic_min = offsetof(VAEncPictureParameterBufferVP9, va_reserved),
		.enc_seq_min = offsetof(VAEncSequenceParameterBufferVP9, va_reserved),
		.enc_coded_off = offsetof(VAEncPictureParameterBufferVP9, coded_buf),
	},
	H264_CODEC(VAProfileH264ConstrainedBaseline, "h264.cb"),
	H264_CODEC(VAProfileH264Main, "h264.main"),
	H264_CODEC(VAProfileH264High, "h264.high"),
	{
		/* what the host reads: everything before va_reserved */
		.profile = VAProfileAV1Profile0,
		.name = "av1.0",
		.min_size = {[VAPictureParameterBufferType] = offsetof(VADecPictureParameterBufferAV1, va_reserved),
			     [VASliceParameterBufferType] = offsetof(VASliceParameterBufferAV1, va_reserved)},
		.nrefs = 8,
		.refs = av1_refs,
		.display = av1_display,
	},
	{
		/* what the host reads: everything before va_reserved */
		.profile = VAProfileHEVCMain,
		.name = "hevc.main",
		.min_size = {[VAPictureParameterBufferType] = offsetof(VAPictureParameterBufferHEVC, va_reserved),
			     [VAIQMatrixBufferType] = offsetof(VAIQMatrixBufferHEVC, va_reserved),
			     [VASliceParameterBufferType] = offsetof(VASliceParameterBufferHEVC, va_reserved)},
		.nrefs = 15,
		.refs = hevc_refs,
	},
};
#define NCODECS (int)(sizeof codecs / sizeof codecs[0])

static const struct codec *codec_by_name(const char *name)
{
	for (int i = 0; i < NCODECS; i++)
		if (!strcmp(codecs[i].name, name))
			return &codecs[i];
	return NULL;
}

/* ---- object ids: kind in the top 4 bits, then a counter, never reused while the counter runs ---- */

#define ID_BITS 28
#define ID_MASK ((1u << ID_BITS) - 1)

struct slot {
	uint32_t id; /* 0: empty */
	void *o;     /* NULL with an id: deleted */
};

struct table {
	uint32_t kind, next;
	uint32_t cap, live, used; /* slots; objects; slots not empty (objects and deleted) */
	struct slot *s;
};

static uint32_t tab_hash(uint32_t id, uint32_t cap)
{
	return (id * 2654435761u) & (cap - 1);
}

static struct slot *tab_slot(struct table *t, uint32_t id)
{
	if (!t->cap || id >> ID_BITS != t->kind || !(id & ID_MASK))
		return NULL;
	for (uint32_t i = tab_hash(id, t->cap), n = 0; n < t->cap; i = (i + 1) & (t->cap - 1), n++) {
		if (!t->s[i].id)
			return NULL;
		if (t->s[i].id == id)
			return &t->s[i];
	}
	return NULL;
}

static void *tab_get(struct table *t, uint32_t id)
{
	struct slot *s = tab_slot(t, id);
	return s ? s->o : NULL;
}

static void tab_put(struct table *t, uint32_t id, void *o)
{
	for (uint32_t i = tab_hash(id, t->cap);; i = (i + 1) & (t->cap - 1))
		if (!t->s[i].id || !t->s[i].o) {
			if (!t->s[i].id)
				t->used++;
			t->s[i].id = id;
			t->s[i].o = o;
			return;
		}
}

/* a new id for o; 0 when out of memory */
static uint32_t tab_add(struct table *t, void *o)
{
	if ((t->used + 1) * 4 > t->cap * 3) {
		uint32_t cap = 64;
		while (cap < (t->live + 1) * 4)
			cap *= 2;
		struct slot *old = t->s;
		uint32_t ocap = t->cap;
		if (!(t->s = calloc(cap, sizeof *t->s))) {
			t->s = old;
			return 0;
		}
		t->cap = cap;
		t->used = 0;
		for (uint32_t i = 0; i < ocap; i++)
			if (old[i].o)
				tab_put(t, old[i].id, old[i].o);
		free(old);
	}
	uint32_t id;
	do {
		t->next = (t->next + 1) & ID_MASK;
		id = t->kind << ID_BITS | t->next;
	} while (!t->next || tab_get(t, id));
	tab_put(t, id, o);
	t->live++;
	return id;
}

static void tab_del(struct table *t, uint32_t id)
{
	struct slot *s = tab_slot(t, id);
	if (s && s->o) {
		s->o = NULL;
		t->live--;
	}
}

#define TAB_EACH(t, i) for (uint32_t i = 0; i < (t)->cap; i++) if ((t)->s[i].o)

/* ---- driver state ---- */

struct kw_config {
	const struct codec *codec; /* NULL: video processing (VAProfileNone, VAEntrypointVideoProc) */
	int enc;		   /* VAEntrypointEncSlice */
	uint32_t rc;		   /* encode: the rate control mode (VA_RC_CQP, VA_RC_CBR, VA_RC_VBR) */
};

enum { PIC_NONE, PIC_PENDING, PIC_READY, PIC_FAILED };

/*
 * A surface's pixels (store_* below): NV12 in this process's memory, in
 * nv12_layout(). A surface whose memory is a host-held picture (a
 * VideoFrame, for export; va/PROTOCOL.md "export") would be another kind of
 * store behind the same functions.
 */
struct store {
	uint8_t *pix;
	uint64_t pic; /* the picture in pix; 0: none (black once filled for no picture: PIC_BLACK) */
	int fetching; /* a readback into pix is in flight */
	/* exported (va/PROTOCOL.md "export"): the planes' virtio-gpu resources (Y: R8, CbCr: R8G8), on xfd */
	uint32_t xbo[2], xres[2];
	int xfd, exporting;
};
#define PIC_BLACK UINT64_MAX

struct kw_surface {
	int w, h;
	VAContextID ctx; /* the context of its last picture */
	uint64_t pic;  /* the picture last rendered into it (session-unique); 0: none */
	int state;     /* of that picture: PIC_* */
	int wait_sent; /* the host was told the driver waits for it */
	int failed;    /* it failed on the host (vaQuerySurfaceError); its pixels are a stand-in */
	int users;     /* callers waiting on it or reading into it */
	int doomed;    /* destroyed while used: freed by the last user */
	int rgb;       /* BGRX (VA_RT_FORMAT_RGB32): a video processing output; its store is BGRX, pitch w * 4 */
	struct store st;
	/*
	 * Pixels the guest wrote (vaPutImage, a derived image mapped for
	 * writing): while guest_pic is still its picture, the store is the
	 * surface's content, generation gen; kept: the generation the host keeps
	 * a copy of (va/PROTOCOL.md "enc"), sent no more
	 */
	int guest;
	uint64_t guest_pic;
	uint32_t gen, kept;
	int enc_busy; /* encodes reading it whose notice has not come (vaSyncSurface waits for them) */
};

struct kw_context {
	const struct codec *codec;
	int w, h;
	VASurfaceID target;
	struct jb bufs;	     /* this picture's buffers: [type,size,num] each */
	uint8_t *data;	     /* and their bytes, one after another */
	size_t n, cap;
	size_t pic_off;	     /* the picture parameters' offset in data (have_pic) */
	int have_pic, nbufs;
	int enc;      /* an encode context */
	uint32_t rc;  /* its rate control mode */
	/* video processing (codec NULL): the pipeline parameters' input and conversion, read at vaRenderPicture */
	VASurfaceID vpp_src;
	int vpp_bt601, vpp_in_full, vpp_out_full;
};

struct kw_buffer {
	VABufferType type;
	uint32_t size, num;
	uint8_t *data;
	VASurfaceID surface; /* a derived image's buffer: the surface's pixels */
	int detached;	     /* that surface was destroyed */
	int wmap;	     /* a derived image mapped for writing: unmapping it makes its pixels the surface's (guest) */
	/* a coded buffer (VAEncCodedBufferType, data NULL): its last picture, and that picture's chunk once the host sent it */
	uint64_t pic;
	int cstate; /* PIC_* */
	uint8_t *chunk;
	size_t chunk_len;
	VACodedBufferSegment seg;
};

/* an encode picture whose notice has not come: its input surface, coded buffer and the pixels' generation sent (0: none) */
struct encp {
	uint64_t pic;
	VASurfaceID surface;
	VABufferID coded;
	uint32_t gen;
	struct encp *next;
};

struct kw_image {
	VAImage image;
	VASurfaceID derived; /* VA_INVALID_ID for vaCreateImage's */
};

/* a request waiting for its reply (link_call) */
struct call {
	uint32_t r;
	void *dst; /* the reply's binary part goes here when it fits */
	size_t dstcap;
	int done, busy, in_place;
	char *json;
	uint8_t *bin;
	size_t binlen;
	struct call *next;
};

struct reply {
	char *json;
	uint8_t *bin;
	size_t binlen;
	int in_place; /* bin is the caller's buffer */
};

struct drv {
	pthread_mutex_t mu, wmu;
	pthread_cond_t cv; /* broadcast on every reply, notice and on the link's end */
	int fd, dead, closing;
	pthread_t reader;
	int reader_on;
	uint32_t next_r;
	uint64_t next_pic;
	struct call *calls;
	VAProfile profiles[MAX_PROFILES];
	int nprofiles;
	int max_w, max_h;
	char vendor[256];
	int failures; /* pictures that failed on the host */
	int can_export; /* the host fills exported surfaces (hello "export") */
	int drm_fd, drm_tried; /* our own open of the render node, for exports; -1: none */
	/* encode (hello "encode"): the profiles the host encodes, the rate control modes of each (VA_RC_*), pictures in flight */
	VAProfile enc_profiles[MAX_PROFILES];
	uint32_t enc_rc[MAX_PROFILES];
	int nenc, enc_failures;
	struct encp *encs;
	struct table configs, contexts, surfaces, buffers, images;
};

#define DRV(ctx) ((struct drv *)(ctx)->pDriverData)
#define LOCK(d) pthread_mutex_lock(&(d)->mu)
#define UNLOCK(d) pthread_mutex_unlock(&(d)->mu)

/* ---- the link (vk/PROTOCOL.md's framing: u32 total, u32 JSON length, JSON, pad to 4, binary) ---- */

static int link_connect(void)
{
	const char *spec = getenv("KWVA_LINK");
	if (!spec || !*spec)
		spec = "vsock:2:1024";
	int fd = -1;
	if (!strncmp(spec, "vsock:", 6)) {
		struct kw_sockaddr_vm a = {0};
		a.svm_family = AF_VSOCK;
		a.svm_cid = strtoul(spec + 6, NULL, 10);
		const char *c = strchr(spec + 6, ':');
		a.svm_port = c ? strtoul(c + 1, NULL, 10) : KWVA_PORT;
		fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
			close(fd);
			fd = -1;
		}
	} else if (!strncmp(spec, "tcp:", 4)) {
		char host[256];
		snprintf(host, sizeof host, "%s", spec + 4);
		char *c = strrchr(host, ':');
		if (!c)
			return -1;
		*c = 0;
		struct addrinfo hints = {0}, *res = NULL;
		hints.ai_socktype = SOCK_STREAM;
		if (getaddrinfo(host, c + 1, &hints, &res) || !res)
			return -1;
		fd = socket(res->ai_family, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, res->ai_addr, res->ai_addrlen) < 0) {
			close(fd);
			fd = -1;
		}
		freeaddrinfo(res);
		if (fd >= 0) {
			int one = 1;
			setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
		}
	} else if (!strncmp(spec, "unix:", 5)) {
		struct sockaddr_un a = {0};
		a.sun_family = AF_UNIX;
		snprintf(a.sun_path, sizeof a.sun_path, "%s", spec + 5);
		fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
		if (fd >= 0 && connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
			close(fd);
			fd = -1;
		}
	}
	if (fd < 0)
		kw_log("cannot connect to %s: %s", spec, strerror(errno));
	return fd;
}

static int write_all(int fd, struct iovec *iov, int n)
{
	while (n > 0) {
		struct msghdr mh = {.msg_iov = iov, .msg_iovlen = n};
		ssize_t w = sendmsg(fd, &mh, MSG_NOSIGNAL);
		if (w < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		while (n > 0 && (size_t)w >= iov->iov_len) {
			w -= iov->iov_len;
			iov++;
			n--;
		}
		if (n > 0) {
			iov->iov_base = (char *)iov->iov_base + w;
			iov->iov_len -= w;
		}
	}
	return 0;
}

static int read_all(int fd, void *p, size_t n)
{
	while (n) {
		ssize_t r = read(fd, p, n);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			return -1;
		p = (char *)p + r;
		n -= r;
	}
	return 0;
}

static int skip_bytes(int fd, size_t n)
{
	char tmp[4096];
	while (n) {
		size_t k = n < sizeof tmp ? n : sizeof tmp;
		if (read_all(fd, tmp, k) < 0)
			return -1;
		n -= k;
	}
	return 0;
}

static void reply_free(struct reply *rep)
{
	if (!rep)
		return;
	free(rep->json);
	if (!rep->in_place)
		free(rep->bin);
	free(rep);
}

static void link_dead(struct drv *d, const char *why)
{
	if (!d->dead && !d->closing)
		kw_err("%s", why);
	d->dead = 1;
	pthread_cond_broadcast(&d->cv);
}

/* one frame to the host, its binary part in two pieces; mu held, released around the write (objects may change meanwhile) */
static void link_send2(struct drv *d, struct jb *b, const void *bin, size_t binlen, const void *bin2, size_t bin2len)
{
	if (d->dead)
		return;
	uint32_t jl = (uint32_t)b->n, pad = (4 - (jl & 3)) & 3;
	uint32_t hdr[2] = {jl + pad + (uint32_t)(binlen + bin2len), jl};
	static const char zeros[4];
	struct iovec iov[5] = {{hdr, 8}, {b->p, jl}, {(void *)zeros, pad}};
	int n = 3;
	if (binlen)
		iov[n++] = (struct iovec){(void *)bin, binlen};
	if (bin2len)
		iov[n++] = (struct iovec){(void *)bin2, bin2len};
	UNLOCK(d);
	pthread_mutex_lock(&d->wmu);
	int bad = write_all(d->fd, iov, n) < 0;
	int e = errno;
	pthread_mutex_unlock(&d->wmu);
	LOCK(d);
	if (bad) {
		char why[160];
		snprintf(why, sizeof why, "the link to the host broke (%s)", strerror(e));
		link_dead(d, why);
	}
}

static void link_send(struct drv *d, struct jb *b, const void *bin, size_t binlen)
{
	link_send2(d, b, bin, binlen, NULL, 0);
}

/*
 * A request and its reply ("r"); mu held, released while it waits. The
 * reply's binary part is read into dst when it fits there. NULL when the
 * link is gone.
 */
static struct reply *link_call(struct drv *d, struct jb *b, void *dst, size_t dstcap)
{
	if (d->dead)
		return NULL;
	struct call c = {.r = d->next_r++, .dst = dst, .dstcap = dstcap};
	c.next = d->calls;
	d->calls = &c;
	while (b->n && b->p[b->n - 1] != '}')
		b->n--;
	if (b->n)
		b->n--;
	jb_printf(b, ",\"r\":%u}", c.r);
	link_send(d, b, NULL, 0);
	while (!c.done && (!d->dead || c.busy))
		pthread_cond_wait(&d->cv, &d->mu);
	for (struct call **pp = &d->calls; *pp; pp = &(*pp)->next)
		if (*pp == &c) {
			*pp = c.next;
			break;
		}
	if (!c.done)
		return NULL;
	struct reply *rep = calloc(1, sizeof *rep);
	if (!rep) {
		free(c.json);
		if (!c.in_place)
			free(c.bin);
		return NULL;
	}
	rep->json = c.json;
	rep->bin = c.bin;
	rep->binlen = c.binlen;
	rep->in_place = c.in_place;
	return rep;
}

static void surface_free(struct kw_surface *s);

/* a picture notice ("ev"); mu held */
static void on_notice(struct drv *d, const char *json, const char *ev)
{
	char kind[16];
	js_str(ev, kind, sizeof kind);
	uint32_t sid = (uint32_t)js_num(js_get(json, "surface"), 0);
	uint64_t pic = (uint64_t)js_num(js_get(json, "pic"), 0);
	struct kw_surface *s = tab_get(&d->surfaces, sid);
	if (!s || s->pic != pic || s->state != PIC_PENDING)
		return;
	if (!strcmp(kind, "ready"))
		s->state = PIC_READY;
	else {
		char why[300];
		js_str(js_get(json, "err"), why, sizeof why);
		s->state = PIC_FAILED;
		s->failed = 1;
		if (!d->failures++)
			kw_err("a picture failed on the host: %s; it reads back as the last good picture (vaQuerySurfaceError "
			       "reports it; later failures are not printed)",
			       why);
		else
			kw_log("picture %llu failed on the host: %s", (unsigned long long)pic, why);
	}
}

/*
 * An encode picture's notice ("coded"): its chunk becomes its coded buffer's
 * (or it failed), its input surface is free again. mu held. Returns bin
 * unless the coded buffer took it.
 */
static uint8_t *on_coded(struct drv *d, const char *json, uint8_t *bin, size_t binlen)
{
	uint64_t pic = (uint64_t)js_num(js_get(json, "pic"), 0);
	struct encp *e = NULL;
	for (struct encp **pp = &d->encs; *pp; pp = &(*pp)->next)
		if ((*pp)->pic == pic) {
			e = *pp;
			*pp = e->next;
			break;
		}
	if (!e)
		return bin;
	const char *err = js_get(json, "err");
	struct kw_surface *s = tab_get(&d->surfaces, e->surface);
	if (s) {
		if (s->enc_busy > 0)
			s->enc_busy--;
		/* the host keeps these pixels: an encode of the surface unchanged sends none */
		if (!err && e->gen && js_num(js_get(json, "kept"), 0) && s->gen == e->gen)
			s->kept = e->gen;
	}
	struct kw_buffer *b = tab_get(&d->buffers, e->coded);
	if (b && b->type == VAEncCodedBufferType && b->pic == pic && b->cstate == PIC_PENDING) {
		if (err) {
			char why[300];
			js_str(err, why, sizeof why);
			b->cstate = PIC_FAILED;
			if (!d->enc_failures++)
				kw_err("a picture failed to encode on the host: %s (later failures are not printed)", why);
			else
				kw_log("encode picture %llu failed on the host: %s", (unsigned long long)pic, why);
		} else {
			b->cstate = PIC_READY;
			b->chunk = bin;
			b->chunk_len = binlen;
			bin = NULL;
		}
	}
	free(e);
	return bin;
}

/* the reader thread: every frame from the host */
static void *reader_main(void *arg)
{
	struct drv *d = arg;
	const char *why = "the host closed the link";
	for (;;) {
		uint32_t hdr[2];
		if (read_all(d->fd, hdr, 8) < 0)
			break;
		uint64_t total = hdr[0], jl = hdr[1], pad = (4 - (jl & 3)) & 3;
		if (jl + pad > total || total > MAX_FRAME) {
			why = "a bad frame from the host";
			break;
		}
		char *json = malloc(jl + pad + 1);
		if (!json || read_all(d->fd, json, jl + pad) < 0) {
			free(json);
			break;
		}
		json[jl] = 0;
		size_t binlen = total - jl - pad;
		uint32_t r = (uint32_t)js_num(js_get(json, "r"), 0);
		if (!r) {
			const char *ev = js_get(json, "ev");
			char kind[16];
			js_str(ev, kind, sizeof kind);
			int coded = !strcmp(kind, "coded"), bad = 0;
			/* an encode's chunk comes with its notice: read without mu held */
			uint8_t *bin = NULL;
			if (binlen && coded)
				bad = !(bin = malloc(binlen)) || read_all(d->fd, bin, binlen) < 0;
			else if (binlen)
				bad = skip_bytes(d->fd, binlen) < 0;
			LOCK(d);
			const char *lost = js_get(json, "lost");
			if (coded && !bad)
				bin = on_coded(d, json, bin, binlen);
			else if (ev)
				on_notice(d, json, ev);
			else if (lost) {
				char w[300], line[340];
				js_str(lost, w, sizeof w);
				snprintf(line, sizeof line, "the host ended the link: %s", w);
				link_dead(d, line);
			}
			pthread_cond_broadcast(&d->cv);
			UNLOCK(d);
			free(json);
			free(bin);
			if (bad)
				break;
			continue;
		}
		LOCK(d);
		struct call *c = d->calls;
		/* a second reply to one request (a host bug) must not reach a caller that may have returned */
		while (c && (c->r != r || c->done))
			c = c->next;
		uint8_t *bin = NULL;
		int in_place = 0;
		if (c && binlen && c->dst && binlen <= c->dstcap) {
			bin = c->dst;
			in_place = 1;
		}
		if (c)
			c->busy = 1; /* its caller waits while its buffer is read into */
		UNLOCK(d);
		int bad = 0;
		if (binlen && !bin && !(bin = malloc(binlen)))
			bad = 1;
		if (!bad && binlen && read_all(d->fd, bin, binlen) < 0)
			bad = 1;
		LOCK(d);
		if (c)
			c->busy = 0;
		if (c && !bad) {
			c->json = json;
			c->bin = bin;
			c->binlen = binlen;
			c->in_place = in_place;
			c->done = 1;
		} else {
			free(json);
			if (!in_place)
				free(bin);
		}
		pthread_cond_broadcast(&d->cv);
		UNLOCK(d);
		if (bad)
			break;
	}
	LOCK(d);
	link_dead(d, why);
	UNLOCK(d);
	return NULL;
}

static int profile_ok(struct drv *d, VAProfile p)
{
	for (int i = 0; i < d->nprofiles; i++)
		if (d->profiles[i] == p)
			return 1;
	return 0;
}

/* the rate control modes the host encodes the profile with (VA_RC_*), 0: no encoder */
static uint32_t enc_rc(struct drv *d, VAProfile p)
{
	for (int i = 0; i < d->nenc; i++)
		if (d->enc_profiles[i] == p)
			return d->enc_rc[i];
	return 0;
}

static const struct codec *codec_of(VAProfile p)
{
	for (int i = 0; i < NCODECS; i++)
		if (codecs[i].profile == p)
			return &codecs[i];
	return NULL;
}

/* ---- surface pixel storage ---- */

/* NV12 as both sides lay it out (va/PROTOCOL.md "get"): pitch a multiple of 64, UV right after Y */
static void nv12_layout(int w, int h, uint32_t *pitch, uint32_t *uv, size_t *size)
{
	uint32_t p = ((uint32_t)w + 63) & ~63u;
	*pitch = p;
	*uv = p * (uint32_t)h;
	*size = (size_t)p * h + (size_t)p * ((h + 1) / 2);
}

static void fill_flat(uint8_t *p, int w, int h, int y)
{
	uint32_t pitch, uv;
	size_t size;
	nv12_layout(w, h, &pitch, &uv, &size);
	memset(p, y, uv);
	memset(p + uv, 128, size - uv);
}

/* a surface's store: NV12 in nv12_layout(), or BGRX (pitch w * 4) for a BGRX surface */
static size_t store_size(const struct kw_surface *s)
{
	uint32_t pitch, uv;
	size_t size;
	if (s->rgb)
		return (size_t)s->w * s->h * 4;
	nv12_layout(s->w, s->h, &pitch, &uv, &size);
	return size;
}

/* black BGRX (X 255) */
static void fill_bgrx_black(uint8_t *p, size_t n)
{
	for (size_t i = 0; i + 3 < n; i += 4) {
		p[i] = p[i + 1] = p[i + 2] = 0;
		p[i + 3] = 255;
	}
}

static void store_black(struct kw_surface *s, int y)
{
	if (s->rgb)
		fill_bgrx_black(s->st.pix, store_size(s));
	else
		fill_flat(s->st.pix, s->w, s->h, y);
}

static uint8_t *store_pixels(struct kw_surface *s)
{
	if (!s->st.pix)
		s->st.pix = malloc(store_size(s));
	return s->st.pix;
}

static void store_free(struct kw_surface *s)
{
	free(s->st.pix);
	s->st.pix = NULL;
	s->st.pic = 0;
	/* the exported resources: importers keep theirs through their dmabufs */
	for (int i = 0; i < 2; i++)
		if (s->st.xbo[i]) {
			struct drm_gem_close gc = {.handle = s->st.xbo[i]};
			ioctl(s->st.xfd, DRM_IOCTL_GEM_CLOSE, &gc);
			s->st.xbo[i] = 0;
		}
}

/* the guest wrote the surface's store (vaPutImage, a derived image unmapped after a write map): its content now, a new generation */
static void surface_written(struct kw_surface *s)
{
	s->guest = 1;
	s->guest_pic = s->pic;
	if (!++s->gen)
		s->gen = 1;
}

/* whether the store is the surface's content: written by the guest, and no picture rendered into it since */
static int guest_valid(const struct kw_surface *s)
{
	return s->guest && s->guest_pic == s->pic && s->st.pix;
}

/* end: now + timeout_ns (CLOCK_REALTIME, for pthread_cond_timedwait) */
static void deadline(struct timespec *end, uint64_t timeout_ns)
{
	clock_gettime(CLOCK_REALTIME, end);
	end->tv_sec += timeout_ns / 1000000000u;
	end->tv_nsec += timeout_ns % 1000000000u;
	if (end->tv_nsec >= 1000000000) {
		end->tv_sec++;
		end->tv_nsec -= 1000000000;
	}
}

/* a new picture is being decoded into the surface: what is stored is stale */
static void store_invalidate(struct kw_surface *s)
{
	s->st.pic = 0;
}

static void surface_free(struct kw_surface *s)
{
	store_free(s);
	free(s);
}

/* the last user of a surface lets go: false when it was destroyed meanwhile (then freed) */
static int surface_put(struct kw_surface *s)
{
	s->users--;
	if (!s->doomed)
		return 1;
	if (!s->users)
		surface_free(s);
	return 0;
}

/*
 * Waits until the surface's picture is decoded (or failed: its pixels are
 * then a stand-in); mu held, released while waiting. timeout_ns:
 * UINT64_MAX for none.
 */
static VAStatus surface_wait(struct drv *d, struct kw_surface *s, uint64_t timeout_ns)
{
	struct timespec end;
	if (timeout_ns != UINT64_MAX) {
		clock_gettime(CLOCK_REALTIME, &end);
		end.tv_sec += timeout_ns / 1000000000u;
		end.tv_nsec += timeout_ns % 1000000000u;
		if (end.tv_nsec >= 1000000000) {
			end.tv_sec++;
			end.tv_nsec -= 1000000000;
		}
	}
	int timedout = 0;
	s->users++;
	/* (an input surface: also until the encodes reading it are done) */
	while ((s->state == PIC_PENDING || s->enc_busy) && !d->dead && !s->doomed && !timedout) {
		if (s->state == PIC_PENDING && !s->wait_sent) {
			/* the host's hold timer runs only for pictures the driver waits for */
			struct jb b = {0};
			s->wait_sent = 1;
			jb_printf(&b, "{\"op\":\"wait\",\"pic\":%llu}", (unsigned long long)s->pic);
			link_send(d, &b, NULL, 0);
			free(b.p);
			continue;
		}
		if (timeout_ns == UINT64_MAX)
			pthread_cond_wait(&d->cv, &d->mu);
		else
			timedout = pthread_cond_timedwait(&d->cv, &d->mu, &end) == ETIMEDOUT;
	}
	if (!surface_put(s))
		return VA_STATUS_ERROR_INVALID_SURFACE;
	if (s->state != PIC_PENDING && !s->enc_busy)
		return VA_STATUS_SUCCESS;
	return d->dead ? VA_STATUS_ERROR_OPERATION_FAILED : VA_STATUS_ERROR_TIMEDOUT;
}

/* a picture of the reply's layout into the surface's: top left, the rest black */
static void store_repack(struct kw_surface *s, const uint8_t *src, size_t len, int rw, int rh, const double *pitches,
			 const double *offsets)
{
	uint32_t dp, duv;
	size_t dsize;
	nv12_layout(s->w, s->h, &dp, &duv, &dsize);
	fill_flat(s->st.pix, s->w, s->h, 16);
	size_t sp0 = (size_t)pitches[0], sp1 = (size_t)pitches[1], so1 = (size_t)offsets[1], so0 = (size_t)offsets[0];
	size_t cw = (size_t)(rw < s->w ? rw : s->w);
	cw = (cw + 1) & ~(size_t)1;
	int ch = rh < s->h ? rh : s->h;
	if (cw > sp0 || cw > sp1 || cw > dp)
		return;
	for (int y = 0; y < ch; y++)
		if (so0 + (size_t)y * sp0 + cw <= len)
			memcpy(s->st.pix + (size_t)y * dp, src + so0 + (size_t)y * sp0, cw);
	for (int y = 0; y < (ch + 1) / 2; y++)
		if (so1 + (size_t)y * sp1 + cw <= len)
			memcpy(s->st.pix + duv + (size_t)y * dp, src + so1 + (size_t)y * sp1, cw);
}

/* a BGRX picture of the reply's size into a BGRX surface's store: top left, the rest black */
static void store_repack_bgrx(struct kw_surface *s, const uint8_t *src, size_t len, int rw, int rh, size_t sp)
{
	size_t dp = (size_t)s->w * 4, n = (size_t)(rw < s->w ? rw : s->w) * 4;
	int rows = rh < s->h ? rh : s->h;
	fill_bgrx_black(s->st.pix, store_size(s));
	if (n > sp)
		return;
	for (int y = 0; y < rows; y++)
		if ((size_t)y * sp + n <= len)
			memcpy(s->st.pix + (size_t)y * dp, src + (size_t)y * sp, n);
}

/*
 * The surface's picture into its storage (va/PROTOCOL.md "get"), once per
 * picture: waits for its decode first. mu held, released while waiting.
 * A failed picture reads back as what the host gives instead (the last
 * good one) and succeeds; only a dead link fails.
 */
static VAStatus store_fetch(struct drv *d, VASurfaceID id, struct kw_surface *s)
{
	if (guest_valid(s))
		return VA_STATUS_SUCCESS; /* the guest's pixels: nothing on the host to fetch */
	VAStatus st = surface_wait(d, s, UINT64_MAX);
	if (st != VA_STATUS_SUCCESS)
		return st;
	s->users++;
	while (s->st.fetching && !s->doomed)
		pthread_cond_wait(&d->cv, &d->mu);
	if (!surface_put(s))
		return VA_STATUS_ERROR_INVALID_SURFACE;
	uint64_t pic = s->pic ? s->pic : PIC_BLACK;
	if (s->st.pic == pic && s->st.pix)
		return VA_STATUS_SUCCESS;
	if (!store_pixels(s))
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	if (pic == PIC_BLACK) {
		store_black(s, 16);
		s->st.pic = pic;
		return VA_STATUS_SUCCESS;
	}
	uint32_t pitch, uv;
	size_t size;
	nv12_layout(s->w, s->h, &pitch, &uv, &size);
	if (s->rgb)
		size = store_size(s);
	struct jb b = {0};
	jb_printf(&b, "{\"op\":\"get\",\"surface\":%u,\"pic\":%llu}", id, (unsigned long long)pic);
	s->users++;
	s->st.fetching = 1;
	struct reply *rep = link_call(d, &b, s->st.pix, size);
	free(b.p);
	s->st.fetching = 0;
	pthread_cond_broadcast(&d->cv);
	if (!surface_put(s)) {
		reply_free(rep);
		return VA_STATUS_ERROR_INVALID_SURFACE;
	}
	if (!rep)
		return VA_STATUS_ERROR_OPERATION_FAILED;
	const char *e = js_get(rep->json, "err");
	if (e) {
		/* the host has no picture for it (freed, or read back already): grey */
		char why[300];
		js_str(e, why, sizeof why);
		kw_err("no picture from the host for a surface: %s; grey instead", why);
		store_black(s, 128);
		s->failed = 1;
	} else if (s->rgb) {
		/* a video processing output: BGRX, pitch width * 4 */
		char fmt[16];
		double pitches[2] = {0, 0};
		js_str(js_get(rep->json, "format"), fmt, sizeof fmt);
		double dw = js_num(js_get(rep->json, "width"), 0), dh = js_num(js_get(rep->json, "height"), 0);
		int rw = dw >= 1 && dw <= 65536 ? (int)dw : 0, rh = dh >= 1 && dh <= 65536 ? (int)dh : 0;
		int np = js_nums(js_get(rep->json, "pitches"), pitches, 2);
		if (js_get(rep->json, "failed"))
			s->failed = 1;
		if (strcmp(fmt, "BGRX") || np < 1 || rw <= 0 || rh <= 0 || pitches[0] < (double)rw * 4 || pitches[0] > MAX_FRAME) {
			kw_err("a picture from the host in a form the driver does not read (%s %dx%d); black instead", fmt, rw, rh);
			store_black(s, 16);
		} else if (rw == s->w && rh == s->h && pitches[0] == (double)s->w * 4 && rep->binlen == size) {
			if (!rep->in_place)
				memcpy(s->st.pix, rep->bin, size);
		} else {
			const uint8_t *src = rep->bin;
			uint8_t *tmp = NULL;
			if (rep->in_place) {
				if (!(tmp = malloc(rep->binlen))) {
					reply_free(rep);
					return VA_STATUS_ERROR_ALLOCATION_FAILED;
				}
				memcpy(tmp, rep->bin, rep->binlen);
				src = tmp;
			}
			store_repack_bgrx(s, src, rep->binlen, rw, rh, (size_t)pitches[0]);
			free(tmp);
		}
	} else {
		char fmt[16];
		double pitches[2] = {0, 0}, offsets[2] = {0, 0};
		js_str(js_get(rep->json, "format"), fmt, sizeof fmt);
		double dw = js_num(js_get(rep->json, "width"), 0), dh = js_num(js_get(rep->json, "height"), 0);
		int rw = dw >= 1 && dw <= 65536 ? (int)dw : 0, rh = dh >= 1 && dh <= 65536 ? (int)dh : 0;
		int np = js_nums(js_get(rep->json, "pitches"), pitches, 2), no = js_nums(js_get(rep->json, "offsets"), offsets, 2);
		if (js_get(rep->json, "failed"))
			s->failed = 1;
		/* the host's layout, within what a frame can carry (store_repack's bounds checks rely on it) */
		int sane = 1;
		for (int i = 0; i < 2; i++)
			sane &= pitches[i] >= 0 && pitches[i] <= MAX_FRAME && offsets[i] >= 0 && offsets[i] <= MAX_FRAME;
		if (strcmp(fmt, "NV12") || np != 2 || no != 2 || rw <= 0 || rh <= 0 || !sane) {
			kw_err("a picture from the host in a form the driver does not read (%s %dx%d); black instead", fmt, rw, rh);
			fill_flat(s->st.pix, s->w, s->h, 16);
		} else if (rw == s->w && rh == s->h && pitches[0] == pitch && pitches[1] == pitch && offsets[0] == 0 &&
			   offsets[1] == uv && rep->binlen == size) {
			if (!rep->in_place)
				memcpy(s->st.pix, rep->bin, size);
		} else {
			/* another size (a VP9 frame smaller than its surface) or layout */
			const uint8_t *src = rep->bin;
			uint8_t *tmp = NULL;
			if (rep->in_place) { /* it was read into pix: move it out first */
				if (!(tmp = malloc(rep->binlen))) {
					reply_free(rep);
					return VA_STATUS_ERROR_ALLOCATION_FAILED;
				}
				memcpy(tmp, rep->bin, rep->binlen);
				src = tmp;
			}
			store_repack(s, src, rep->binlen, rw, rh, pitches, offsets);
			free(tmp);
			kw_log("surface %#x is %dx%d, its picture %dx%d", id, s->w, s->h, rw, rh);
		}
	}
	reply_free(rep);
	s->st.pic = pic;
	return VA_STATUS_SUCCESS;
}

/* ---- the vtable ---- */

static void context_free(struct kw_context *k)
{
	free(k->data);
	free(k->bufs.p);
	free(k);
}

static VAStatus kw_Terminate(VADriverContextP ctx)
{
	struct drv *d = DRV(ctx);
	if (!d)
		return VA_STATUS_SUCCESS;
	LOCK(d);
	d->closing = 1;
	UNLOCK(d);
	shutdown(d->fd, SHUT_RDWR);
	if (d->reader_on)
		pthread_join(d->reader, NULL);
	close(d->fd);
	TAB_EACH(&d->configs, i) free(d->configs.s[i].o);
	TAB_EACH(&d->contexts, i) context_free(d->contexts.s[i].o);
	TAB_EACH(&d->surfaces, i) surface_free(d->surfaces.s[i].o);
	TAB_EACH(&d->buffers, i)
	{
		free(((struct kw_buffer *)d->buffers.s[i].o)->data);
		free(((struct kw_buffer *)d->buffers.s[i].o)->chunk);
		free(d->buffers.s[i].o);
	}
	while (d->encs) {
		struct encp *e = d->encs;
		d->encs = e->next;
		free(e);
	}
	TAB_EACH(&d->images, i) free(d->images.s[i].o);
	if (d->drm_fd >= 0)
		close(d->drm_fd);
	struct table *ts[] = {&d->configs, &d->contexts, &d->surfaces, &d->buffers, &d->images};
	for (int t = 0; t < 5; t++)
		free(ts[t]->s);
	pthread_cond_destroy(&d->cv);
	pthread_mutex_destroy(&d->wmu);
	pthread_mutex_destroy(&d->mu);
	free(d);
	ctx->pDriverData = NULL;
	return VA_STATUS_SUCCESS;
}

static int export_ok(struct drv *d, VADriverContextP ctx);

/* video processing (NV12 to BGRX for an exported surface) is offered where export works */
static int vpp_ok(struct drv *d, VADriverContextP ctx)
{
	LOCK(d);
	int ok = export_ok(d, ctx);
	UNLOCK(d);
	return ok;
}

static VAStatus kw_QueryConfigProfiles(VADriverContextP ctx, VAProfile *list, int *num)
{
	struct drv *d = DRV(ctx);
	for (int i = 0; i < d->nprofiles; i++)
		list[i] = d->profiles[i];
	*num = d->nprofiles;
	for (int i = 0; i < d->nenc; i++)
		if (!profile_ok(d, d->enc_profiles[i]))
			list[(*num)++] = d->enc_profiles[i];
	if (vpp_ok(d, ctx))
		list[(*num)++] = VAProfileNone;
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_QueryConfigEntrypoints(VADriverContextP ctx, VAProfile profile, VAEntrypoint *list, int *num)
{
	struct drv *d = DRV(ctx);
	*num = 0;
	if (profile == VAProfileNone && vpp_ok(d, ctx)) {
		list[0] = VAEntrypointVideoProc;
		*num = 1;
		return VA_STATUS_SUCCESS;
	}
	if (!profile_ok(d, profile) && !enc_rc(d, profile))
		return VA_STATUS_ERROR_UNSUPPORTED_PROFILE;
	if (profile_ok(d, profile))
		list[(*num)++] = VAEntrypointVLD;
	if (enc_rc(d, profile))
		list[(*num)++] = VAEntrypointEncSlice;
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_GetConfigAttributes(VADriverContextP ctx, VAProfile profile, VAEntrypoint ep, VAConfigAttrib *attribs, int n)
{
	struct drv *d = DRV(ctx);
	if (profile == VAProfileNone && ep == VAEntrypointVideoProc && vpp_ok(d, ctx)) {
		for (int i = 0; i < n; i++)
			attribs[i].value = attribs[i].type == VAConfigAttribRTFormat ? VA_RT_FORMAT_YUV420 | VA_RT_FORMAT_RGB32 : VA_ATTRIB_NOT_SUPPORTED;
		return VA_STATUS_SUCCESS;
	}
	if (ep == VAEntrypointEncSlice && enc_rc(d, profile)) {
		/*
		 * What keeps apps on what WebCodecs honours: one reference (P frames
		 * only: no B-frames, so no hidden frames to reorder), no packed headers
		 * (the encoder writes the whole frame), the rate control modes the host
		 * offers (CQP only where VideoEncoder takes a per-frame quantizer)
		 */
		for (int i = 0; i < n; i++) {
			switch (attribs[i].type) {
			case VAConfigAttribRTFormat:
				attribs[i].value = VA_RT_FORMAT_YUV420;
				break;
			case VAConfigAttribRateControl:
				attribs[i].value = enc_rc(d, profile);
				break;
			case VAConfigAttribEncPackedHeaders:
				attribs[i].value = VA_ENC_PACKED_HEADER_NONE;
				break;
			case VAConfigAttribEncMaxRefFrames:
				attribs[i].value = 1; /* list 0: 1, list 1: 0 */
				break;
			case VAConfigAttribMaxPictureWidth:
				attribs[i].value = d->max_w;
				break;
			case VAConfigAttribMaxPictureHeight:
				attribs[i].value = d->max_h;
				break;
			default:
				attribs[i].value = VA_ATTRIB_NOT_SUPPORTED;
			}
		}
		return VA_STATUS_SUCCESS;
	}
	if (!profile_ok(d, profile))
		return enc_rc(d, profile) ? VA_STATUS_ERROR_UNSUPPORTED_ENTRYPOINT : VA_STATUS_ERROR_UNSUPPORTED_PROFILE;
	if (ep != VAEntrypointVLD)
		return VA_STATUS_ERROR_UNSUPPORTED_ENTRYPOINT;
	for (int i = 0; i < n; i++) {
		switch (attribs[i].type) {
		case VAConfigAttribRTFormat:
			attribs[i].value = VA_RT_FORMAT_YUV420;
			break;
		case VAConfigAttribMaxPictureWidth:
			attribs[i].value = d->max_w;
			break;
		case VAConfigAttribMaxPictureHeight:
			attribs[i].value = d->max_h;
			break;
		case VAConfigAttribDecSliceMode:
			attribs[i].value = VA_DEC_SLICE_MODE_NORMAL;
			break;
		default:
			attribs[i].value = VA_ATTRIB_NOT_SUPPORTED;
		}
	}
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_CreateConfig(VADriverContextP ctx, VAProfile profile, VAEntrypoint ep, VAConfigAttrib *attribs, int n, VAConfigID *id)
{
	struct drv *d = DRV(ctx);
	int vpp = profile == VAProfileNone && ep == VAEntrypointVideoProc;
	if (ep == VAEntrypointEncSlice) {
		uint32_t rcs = enc_rc(d, profile), rc = 0;
		if (!rcs)
			return profile_ok(d, profile) ? VA_STATUS_ERROR_UNSUPPORTED_ENTRYPOINT : VA_STATUS_ERROR_UNSUPPORTED_PROFILE;
		for (int i = 0; i < n; i++) {
			uint32_t v = attribs[i].value;
			if (attribs[i].type == VAConfigAttribRTFormat && !(v & VA_RT_FORMAT_YUV420))
				return VA_STATUS_ERROR_UNSUPPORTED_RT_FORMAT;
			/* one mode the host offers (not VA_RC_MB or others) */
			if (attribs[i].type == VAConfigAttribRateControl && (!(v & rcs) || (v & (v - 1))))
				return VA_STATUS_ERROR_INVALID_VALUE;
			if (attribs[i].type == VAConfigAttribRateControl)
				rc = v;
			if (attribs[i].type == VAConfigAttribEncPackedHeaders && v != VA_ENC_PACKED_HEADER_NONE)
				return VA_STATUS_ERROR_INVALID_VALUE;
		}
		if (!rc)
			rc = rcs & VA_RC_CQP ? VA_RC_CQP : rcs & VA_RC_CBR ? VA_RC_CBR : VA_RC_VBR;
		struct kw_config *c = calloc(1, sizeof *c);
		if (!c)
			return VA_STATUS_ERROR_ALLOCATION_FAILED;
		c->codec = codec_of(profile);
		c->enc = 1;
		c->rc = rc;
		LOCK(d);
		*id = tab_add(&d->configs, c);
		UNLOCK(d);
		if (!*id) {
			free(c);
			return VA_STATUS_ERROR_ALLOCATION_FAILED;
		}
		return VA_STATUS_SUCCESS;
	}
	if (vpp ? !vpp_ok(d, ctx) : !profile_ok(d, profile))
		return VA_STATUS_ERROR_UNSUPPORTED_PROFILE;
	if (!vpp && ep != VAEntrypointVLD)
		return VA_STATUS_ERROR_UNSUPPORTED_ENTRYPOINT;
	for (int i = 0; i < n; i++)
		if (attribs[i].type == VAConfigAttribRTFormat && !(attribs[i].value & (VA_RT_FORMAT_YUV420 | (vpp ? VA_RT_FORMAT_RGB32 : 0))))
			return VA_STATUS_ERROR_UNSUPPORTED_RT_FORMAT;
	struct kw_config *c = calloc(1, sizeof *c);
	if (!c)
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	c->codec = vpp ? NULL : codec_of(profile);
	LOCK(d);
	*id = tab_add(&d->configs, c);
	UNLOCK(d);
	if (!*id) {
		free(c);
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	}
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_DestroyConfig(VADriverContextP ctx, VAConfigID id)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	void *c = tab_get(&d->configs, id);
	tab_del(&d->configs, id);
	UNLOCK(d);
	if (!c)
		return VA_STATUS_ERROR_INVALID_CONFIG;
	free(c);
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_QueryConfigAttributes(VADriverContextP ctx, VAConfigID id, VAProfile *profile, VAEntrypoint *ep, VAConfigAttrib *attribs, int *n)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_config *c = tab_get(&d->configs, id);
	if (c) {
		*profile = c->codec ? c->codec->profile : VAProfileNone;
		*ep = c->enc ? VAEntrypointEncSlice : c->codec ? VAEntrypointVLD : VAEntrypointVideoProc;
		attribs[0].type = VAConfigAttribRTFormat;
		attribs[0].value = c->codec ? VA_RT_FORMAT_YUV420 : VA_RT_FORMAT_YUV420 | VA_RT_FORMAT_RGB32;
		*n = 1;
		if (c->enc) {
			attribs[1].type = VAConfigAttribRateControl;
			attribs[1].value = c->rc;
			*n = 2;
		}
	}
	UNLOCK(d);
	return c ? VA_STATUS_SUCCESS : VA_STATUS_ERROR_INVALID_CONFIG;
}

static VAStatus kw_CreateSurfaces2(VADriverContextP ctx, unsigned int format, unsigned int width, unsigned int height,
				   VASurfaceID *surfaces, unsigned int num, VASurfaceAttrib *attribs, unsigned int nattribs)
{
	struct drv *d = DRV(ctx);
	/* BGRX surfaces: video processing outputs, for export (mpv's --vo=dmabuf-wayland on a compositor without NV12) */
	int rgb = format == VA_RT_FORMAT_RGB32;
	if (format != VA_RT_FORMAT_YUV420 && !(rgb && vpp_ok(d, ctx)))
		return VA_STATUS_ERROR_UNSUPPORTED_RT_FORMAT;
	if (!width || !height || width > (unsigned)d->max_w || height > (unsigned)d->max_h)
		return VA_STATUS_ERROR_RESOLUTION_NOT_SUPPORTED;
	for (unsigned i = 0; i < nattribs; i++) {
		if (attribs[i].type == VASurfaceAttribPixelFormat && (attribs[i].flags & VA_SURFACE_ATTRIB_SETTABLE) &&
		    attribs[i].value.value.i != (rgb ? VA_FOURCC_BGRX : VA_FOURCC_NV12))
			return VA_STATUS_ERROR_INVALID_IMAGE_FORMAT;
		if (attribs[i].type == VASurfaceAttribMemoryType && (attribs[i].flags & VA_SURFACE_ATTRIB_SETTABLE) &&
		    !(attribs[i].value.value.i & VA_SURFACE_ATTRIB_MEM_TYPE_VA))
			return VA_STATUS_ERROR_UNSUPPORTED_MEMORY_TYPE;
	}
	LOCK(d);
	for (unsigned i = 0; i < num; i++) {
		struct kw_surface *s = calloc(1, sizeof *s);
		if (s) {
			s->w = width;
			s->h = height;
			s->rgb = rgb;
		}
		if (!s || !(surfaces[i] = tab_add(&d->surfaces, s))) {
			free(s);
			for (unsigned j = 0; j < i; j++) {
				surface_free(tab_get(&d->surfaces, surfaces[j]));
				tab_del(&d->surfaces, surfaces[j]);
			}
			UNLOCK(d);
			return VA_STATUS_ERROR_ALLOCATION_FAILED;
		}
	}
	UNLOCK(d);
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_CreateSurfaces(VADriverContextP ctx, int width, int height, int format, int num, VASurfaceID *surfaces)
{
	return kw_CreateSurfaces2(ctx, format, width, height, surfaces, num, NULL, 0);
}

static VAStatus kw_DestroySurfaces(VADriverContextP ctx, VASurfaceID *list, int num)
{
	struct drv *d = DRV(ctx);
	struct jb b = {0};
	int sent = 0, nfree = 0;
	struct kw_surface **gone = num > 0 ? calloc((size_t)num, sizeof *gone) : NULL;
	LOCK(d);
	jb_printf(&b, "{\"op\":\"surf_free\",\"surfaces\":[");
	for (int i = 0; i < num; i++) {
		struct kw_surface *s = tab_get(&d->surfaces, list[i]);
		if (!s)
			continue;
		if (s->pic || s->st.xbo[0] || s->kept)
			jb_printf(&b, "%s%u", sent++ ? "," : "", list[i]);
		tab_del(&d->surfaces, list[i]);
		/* derived images of it no longer reach its pixels */
		TAB_EACH(&d->buffers, j)
		{
			struct kw_buffer *bb = d->buffers.s[j].o;
			if (bb->surface == list[i]) {
				bb->surface = VA_INVALID_ID;
				bb->detached = 1;
			}
		}
		if (s->users) {
			s->doomed = 1;
			pthread_cond_broadcast(&d->cv);
		} else if (gone)
			gone[nfree++] = s;
		else
			surface_free(s);
	}
	jb_printf(&b, "]}");
	/* the host forgets them (and stops filling their exported resources) before those go */
	if (sent)
		link_send(d, &b, NULL, 0);
	for (int i = 0; i < nfree; i++)
		surface_free(gone[i]);
	UNLOCK(d);
	free(gone);
	free(b.p);
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_CreateContext(VADriverContextP ctx, VAConfigID config, int width, int height, int flag,
				 VASurfaceID *targets, int ntargets, VAContextID *id)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_config *c = tab_get(&d->configs, config);
	if (!c) {
		UNLOCK(d);
		return VA_STATUS_ERROR_INVALID_CONFIG;
	}
	struct kw_context *k = calloc(1, sizeof *k);
	uint32_t cid = k ? tab_add(&d->contexts, k) : 0;
	if (!cid) {
		free(k);
		UNLOCK(d);
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	}
	const struct codec *codec = c->codec;
	k->codec = codec;
	k->enc = c->enc;
	k->rc = c->rc;
	k->w = width;
	k->h = height;
	k->target = VA_INVALID_ID;
	if (!codec) {
		/* video processing: nothing on the host until a picture */
		*id = cid;
		UNLOCK(d);
		return VA_STATUS_SUCCESS;
	}
	struct jb b = {0};
	if (k->enc)
		/* an encode context: its encoder is made at its first picture (VP9: the context is the 64-aligned surfaces' size) */
		jb_printf(&b, "{\"op\":\"ctx\",\"id\":%u,\"profile\":\"%s\",\"width\":%d,\"height\":%d,\"entry\":\"enc\",\"rc\":\"%s\"}", cid, codec->name, width,
			  height, k->rc == VA_RC_CQP ? "cqp" : k->rc == VA_RC_CBR ? "cbr" : "vbr");
	else
		jb_printf(&b, "{\"op\":\"ctx\",\"id\":%u,\"profile\":\"%s\",\"width\":%d,\"height\":%d}", cid, codec->name, width, height);
	struct reply *rep = link_call(d, &b, NULL, 0);
	free(b.p);
	VAStatus st = VA_STATUS_SUCCESS;
	if (!rep)
		st = VA_STATUS_ERROR_OPERATION_FAILED;
	else if (js_get(rep->json, "err")) {
		char why[300];
		js_str(js_get(rep->json, "err"), why, sizeof why);
		kw_err("the host has no %s for %s at %dx%d: %s", k->enc ? "encoder" : "decoder", codec->name, width, height, why);
		st = VA_STATUS_ERROR_RESOLUTION_NOT_SUPPORTED;
	}
	reply_free(rep);
	if (st != VA_STATUS_SUCCESS) {
		if (tab_get(&d->contexts, cid) == k) {
			tab_del(&d->contexts, cid);
			context_free(k);
		}
	} else
		*id = cid;
	UNLOCK(d);
	return st;
}

static VAStatus kw_DestroyContext(VADriverContextP ctx, VAContextID id)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_context *k = tab_get(&d->contexts, id);
	if (k && !k->codec) {
		tab_del(&d->contexts, id);
		context_free(k);
	} else if (k) {
		tab_del(&d->contexts, id);
		context_free(k);
		/* its pictures still being decoded complete as on hardware: the host flushes its decoder and says so */
		struct jb b = {0};
		jb_printf(&b, "{\"op\":\"ctx_free\",\"id\":%u}", id);
		link_send(d, &b, NULL, 0);
		free(b.p);
	}
	UNLOCK(d);
	return k ? VA_STATUS_SUCCESS : VA_STATUS_ERROR_INVALID_CONTEXT;
}

static VAStatus kw_CreateBuffer(VADriverContextP ctx, VAContextID context, VABufferType type, unsigned int size,
				unsigned int num, void *data, VABufferID *id)
{
	struct drv *d = DRV(ctx);
	if ((uint64_t)size * num > MAX_PICTURE)
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	struct kw_buffer *b = calloc(1, sizeof *b);
	if (!b)
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	b->type = type;
	b->size = size;
	b->num = num;
	b->surface = VA_INVALID_ID;
	/* a coded buffer holds no bytes of its own: its picture's chunk, when the host sends it */
	int coded = type == VAEncCodedBufferType;
	b->data = coded ? NULL : malloc((size_t)size * num + 1);
	if (!coded && !b->data) {
		free(b);
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	}
	if (data && !coded)
		memcpy(b->data, data, (size_t)size * num);
	LOCK(d);
	*id = tab_add(&d->buffers, b);
	UNLOCK(d);
	if (!*id) {
		free(b->data);
		free(b);
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	}
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_BufferSetNumElements(VADriverContextP ctx, VABufferID id, unsigned int num)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_buffer *b = tab_get(&d->buffers, id);
	VAStatus st = VA_STATUS_SUCCESS;
	if (!b)
		st = VA_STATUS_ERROR_INVALID_BUFFER;
	else if (b->type == VAImageBufferType || b->type == VAEncCodedBufferType)
		st = VA_STATUS_ERROR_INVALID_PARAMETER;
	else if (num > b->num) {
		uint8_t *p = (uint64_t)b->size * num <= MAX_PICTURE ? realloc(b->data, (size_t)b->size * num + 1) : NULL;
		if (!p)
			st = VA_STATUS_ERROR_INVALID_PARAMETER;
		else {
			b->data = p;
			b->num = num;
		}
	} else
		b->num = num;
	UNLOCK(d);
	return st;
}

/*
 * Waits for a coded buffer's picture (its notice); mu held, released while
 * waiting; *out is the buffer looked up again. timeout_ns: UINT64_MAX for
 * none.
 */
static VAStatus coded_wait(struct drv *d, VABufferID id, uint64_t timeout_ns, struct kw_buffer **out)
{
	struct timespec end;
	if (timeout_ns != UINT64_MAX)
		deadline(&end, timeout_ns);
	struct kw_buffer *b;
	int timedout = 0;
	while ((b = tab_get(&d->buffers, id)) && b->cstate == PIC_PENDING && !d->dead && !timedout) {
		if (timeout_ns == UINT64_MAX)
			pthread_cond_wait(&d->cv, &d->mu);
		else
			timedout = pthread_cond_timedwait(&d->cv, &d->mu, &end) == ETIMEDOUT;
	}
	*out = b;
	if (!b)
		return VA_STATUS_ERROR_INVALID_BUFFER;
	if (b->cstate == PIC_PENDING)
		return d->dead ? VA_STATUS_ERROR_OPERATION_FAILED : VA_STATUS_ERROR_TIMEDOUT;
	return b->cstate == PIC_FAILED ? VA_STATUS_ERROR_ENCODING_ERROR : VA_STATUS_SUCCESS;
}

/* VA_MAPBUFFER_FLAG_*: a derived image mapped write-only (ffmpeg's hwupload) is not read back first */
static VAStatus kw_MapBuffer2(VADriverContextP ctx, VABufferID id, void **p, uint32_t flags)
{
	struct drv *d = DRV(ctx);
	int rd = !flags || (flags & VA_MAPBUFFER_FLAG_READ), wr = !flags || (flags & VA_MAPBUFFER_FLAG_WRITE);
	LOCK(d);
	struct kw_buffer *b = tab_get(&d->buffers, id);
	VAStatus st = VA_STATUS_SUCCESS;
	if (!b || b->detached)
		st = VA_STATUS_ERROR_INVALID_BUFFER;
	else if (b->type == VAEncCodedBufferType) {
		/*
		 * A coded buffer: one segment, its picture's chunk once the host sent it
		 * (a failed picture: empty, VA_CODED_BUF_STATUS_BAD_BITSTREAM; its
		 * vaSyncBuffer says VA_STATUS_ERROR_ENCODING_ERROR)
		 */
		VAStatus w = coded_wait(d, id, UINT64_MAX, &b);
		if (!b)
			st = VA_STATUS_ERROR_INVALID_BUFFER;
		else if (w == VA_STATUS_ERROR_OPERATION_FAILED)
			st = w;
		else {
			memset(&b->seg, 0, sizeof b->seg);
			b->seg.size = (uint32_t)b->chunk_len;
			b->seg.buf = b->chunk;
			b->seg.status = (b->cstate == PIC_FAILED ? VA_CODED_BUF_STATUS_BAD_BITSTREAM : 0) |
					(b->chunk_len > b->size ? VA_CODED_BUF_STATUS_FRAME_SIZE_OVERFLOW : 0);
			*p = &b->seg;
		}
	} else if (b->surface != VA_INVALID_ID) {
		/* a derived image: the surface's own pixels, read back now if they are not yet (unless only written) */
		VASurfaceID sid = b->surface;
		struct kw_surface *s = tab_get(&d->surfaces, sid);
		if (!s)
			st = VA_STATUS_ERROR_INVALID_SURFACE;
		else if (!rd && !guest_valid(s)) {
			if (!store_pixels(s))
				st = VA_STATUS_ERROR_ALLOCATION_FAILED;
			else {
				if (s->st.pic != (s->pic ? s->pic : PIC_BLACK))
					store_black(s, 16);
				*p = s->st.pix;
			}
		} else if ((st = store_fetch(d, sid, s)) == VA_STATUS_SUCCESS)
			*p = s->st.pix;
		/* the fetch may have waited: the buffer again */
		if (st == VA_STATUS_SUCCESS && wr && (b = tab_get(&d->buffers, id)))
			b->wmap = 1;
	} else
		*p = b->data;
	UNLOCK(d);
	return st;
}

static VAStatus kw_MapBuffer(VADriverContextP ctx, VABufferID id, void **p)
{
	return kw_MapBuffer2(ctx, id, p, VA_MAPBUFFER_FLAG_DEFAULT);
}

static VAStatus kw_UnmapBuffer(VADriverContextP ctx, VABufferID id)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_buffer *b = tab_get(&d->buffers, id);
	if (b && b->wmap) {
		/* a derived image mapped for writing: what the app wrote is the surface's content now (an encode's input) */
		b->wmap = 0;
		struct kw_surface *s = b->detached ? NULL : tab_get(&d->surfaces, b->surface);
		if (s && s->st.pix)
			surface_written(s);
	}
	UNLOCK(d);
	return b ? VA_STATUS_SUCCESS : VA_STATUS_ERROR_INVALID_BUFFER;
}

static VAStatus kw_DestroyBuffer(VADriverContextP ctx, VABufferID id)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_buffer *b = tab_get(&d->buffers, id);
	tab_del(&d->buffers, id);
	UNLOCK(d);
	if (!b)
		return VA_STATUS_ERROR_INVALID_BUFFER;
	free(b->data);
	free(b->chunk);
	free(b);
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_BeginPicture(VADriverContextP ctx, VAContextID context, VASurfaceID target)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_context *k = tab_get(&d->contexts, context);
	struct kw_surface *s = tab_get(&d->surfaces, target);
	VAStatus st = !k ? VA_STATUS_ERROR_INVALID_CONTEXT : !s ? VA_STATUS_ERROR_INVALID_SURFACE : VA_STATUS_SUCCESS;
	if (st == VA_STATUS_SUCCESS) {
		k->target = target;
		k->n = 0;
		k->bufs.n = 0;
		k->nbufs = 0;
		k->have_pic = 0;
	}
	UNLOCK(d);
	return st;
}

static int data_put(struct kw_context *k, const uint8_t *p, size_t n)
{
	if (k->n + n > MAX_PICTURE)
		return -1;
	if (k->n + n > k->cap) {
		size_t c = k->cap ? k->cap * 2 : 65536;
		while (c < k->n + n)
			c *= 2;
		uint8_t *q = realloc(k->data, c);
		if (!q)
			return -1;
		k->data = q;
		k->cap = c;
	}
	memcpy(k->data + k->n, p, n);
	k->n += n;
	return 0;
}

/* every buffer is copied as it is now (the app may destroy or reuse it after this call) and goes to the host at EndPicture */
static VAStatus kw_RenderPicture(VADriverContextP ctx, VAContextID context, VABufferID *bufs, int num)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_context *k = tab_get(&d->contexts, context);
	VAStatus st = !k ? VA_STATUS_ERROR_INVALID_CONTEXT : k->target == VA_INVALID_ID ? VA_STATUS_ERROR_INVALID_PARAMETER : VA_STATUS_SUCCESS;
	for (int i = 0; st == VA_STATUS_SUCCESS && k && !k->codec && i < num; i++) {
		/* video processing: the input surface and the conversion (its pointers are the app's, valid only now) */
		struct kw_buffer *b = tab_get(&d->buffers, bufs[i]);
		if (!b || b->type != VAProcPipelineParameterBufferType || b->size < sizeof(VAProcPipelineParameterBuffer) || !b->num) {
			st = b ? VA_STATUS_ERROR_UNSUPPORTED_BUFFERTYPE : VA_STATUS_ERROR_INVALID_BUFFER;
			break;
		}
		const VAProcPipelineParameterBuffer *pp = (const VAProcPipelineParameterBuffer *)b->data;
		if (pp->num_filters || pp->num_forward_references || pp->num_backward_references) {
			kw_err("video processing with filters or references is not supported (scaling and colour conversion only)");
			st = VA_STATUS_ERROR_UNIMPLEMENTED;
			break;
		}
		struct kw_surface *in = tab_get(&d->surfaces, pp->surface);
		if (!in || in->rgb) {
			st = VA_STATUS_ERROR_INVALID_SURFACE;
			break;
		}
		int std = pp->surface_color_standard, mc = pp->input_color_properties.matrix_coefficients;
		k->vpp_src = pp->surface;
		k->vpp_bt601 = std == VAProcColorStandardBT601 || std == VAProcColorStandardSMPTE170M || std == VAProcColorStandardBT470BG ||
			       std == VAProcColorStandardBT470M || std == VAProcColorStandardXVYCC601 ||
			       (std == VAProcColorStandardExplicit && (mc == 5 || mc == 6)) || (std == VAProcColorStandardNone && in->h < 720);
		k->vpp_in_full = pp->input_color_properties.color_range == VA_SOURCE_RANGE_FULL;
		/* RGB out: full range unless asked otherwise */
		k->vpp_out_full = pp->output_color_properties.color_range != VA_SOURCE_RANGE_REDUCED;
		k->have_pic = 1;
	}
	for (int i = 0; st == VA_STATUS_SUCCESS && k && k->codec && i < num; i++) {
		struct kw_buffer *b = tab_get(&d->buffers, bufs[i]);
		if (!b || b->type == VAImageBufferType || b->type == VAEncCodedBufferType) {
			st = VA_STATUS_ERROR_INVALID_BUFFER;
			break;
		}
		uint32_t min = k->enc ? (b->type == VAEncPictureParameterBufferType ? k->codec->enc_pic_min : b->type == VAEncSequenceParameterBufferType ? k->codec->enc_seq_min : 0)
				      : (unsigned)b->type <= VAProbabilityBufferType ? k->codec->min_size[b->type] : 0;
		if (min && b->size < min) {
			kw_err("a %s buffer of type %d with elements of %u bytes (at least %u)", k->codec->name, b->type, b->size, min);
			st = VA_STATUS_ERROR_INVALID_PARAMETER;
			break;
		}
		size_t off = k->n;
		if (data_put(k, b->data, (size_t)b->size * b->num) < 0) {
			st = VA_STATUS_ERROR_ALLOCATION_FAILED;
			break;
		}
		jb_printf(&k->bufs, "%s[%d,%u,%u]", k->nbufs++ ? "," : "", b->type, b->size, b->num);
		if (b->type == (k->enc ? VAEncPictureParameterBufferType : VAPictureParameterBufferType) && b->num) {
			k->pic_off = off;
			k->have_pic = 1;
		}
	}
	UNLOCK(d);
	return st;
}

/*
 * An encode picture (va/PROTOCOL.md "enc"): its buffers, and the input
 * surface's pixels unless the host has them (its kept copy of an unchanged
 * surface, or the decoded picture the surface holds). It completes when the
 * host's notice brings the chunk into the coded buffer the picture
 * parameters name (vaSyncBuffer, vaMapBuffer; vaSyncSurface of the input).
 * mu held.
 */
static VAStatus enc_end(struct drv *d, VAContextID context, struct kw_context *k, struct kw_surface *s)
{
	VASurfaceID sid = k->target;
	if (!k->have_pic)
		return VA_STATUS_ERROR_INVALID_PARAMETER;
	if (s->rgb)
		return VA_STATUS_ERROR_INVALID_SURFACE;
	/* a readback of the surface in flight: its pixels are then here (and the host's are gone) */
	s->users++;
	while (s->st.fetching && !s->doomed && !d->dead)
		pthread_cond_wait(&d->cv, &d->mu);
	if (!surface_put(s) || !(k = tab_get(&d->contexts, context)) || k->target != sid)
		return VA_STATUS_ERROR_INVALID_SURFACE;
	VABufferID cid;
	memcpy(&cid, k->data + k->pic_off + k->codec->enc_coded_off, sizeof cid);
	struct kw_buffer *cb = tab_get(&d->buffers, cid);
	struct encp *e = calloc(1, sizeof *e);
	if (!cb || cb->type != VAEncCodedBufferType || !e) {
		free(e);
		return !e ? VA_STATUS_ERROR_ALLOCATION_FAILED : VA_STATUS_ERROR_INVALID_BUFFER;
	}
	uint64_t pic = ++d->next_pic;
	struct jb b = {0};
	jb_printf(&b, "{\"op\":\"enc\",\"ctx\":%u,\"surface\":%u,\"pic\":%llu,\"profile\":\"%s\",\"bufs\":[%s],\"src\":", context, sid,
		  (unsigned long long)pic, k->codec->name, k->bufs.p ? k->bufs.p : "");
	/* a decoded picture read back already: those pixels are the guest's copy now (the host gave its own up at the readback) */
	if (!guest_valid(s) && s->pic && s->st.pix && s->st.pic == s->pic)
		surface_written(s);
	const uint8_t *px = NULL;
	size_t pxlen = 0;
	if (guest_valid(s) && s->kept == s->gen)
		jb_printf(&b, "{\"kept\":%u}}", s->gen);
	else if (guest_valid(s)) {
		uint32_t pitch, uv;
		nv12_layout(s->w, s->h, &pitch, &uv, &pxlen);
		jb_printf(&b, "{\"pixels\":{\"gen\":%u,\"width\":%d,\"height\":%d,\"pitch\":%u}}}", s->gen, s->w, s->h, pitch);
		px = s->st.pix;
		e->gen = s->gen;
	} else if (s->pic && s->state != PIC_NONE)
		/* the decoded picture the surface holds: nothing crosses (decode to encode) */
		jb_printf(&b, "{\"pic\":%llu}}", (unsigned long long)s->pic);
	else
		jb_printf(&b, "{}}"); /* never written: black */
	free(cb->chunk);
	cb->chunk = NULL;
	cb->chunk_len = 0;
	cb->pic = pic;
	cb->cstate = PIC_PENDING;
	e->pic = pic;
	e->surface = sid;
	e->coded = cid;
	e->next = d->encs;
	d->encs = e;
	s->enc_busy++;
	k->target = VA_INVALID_ID;
	/* the bytes go out without mu held: the context gives its buffers to the write, the surface stays (a user) */
	uint8_t *data = k->data;
	size_t n = k->n, cap = k->cap;
	k->data = NULL;
	k->n = k->cap = 0;
	s->users++;
	link_send2(d, &b, data, n, px, pxlen);
	surface_put(s);
	free(b.p);
	k = tab_get(&d->contexts, context);
	if (k && !k->data) {
		k->data = data;
		k->cap = cap;
	} else
		free(data);
	return d->dead ? VA_STATUS_ERROR_OPERATION_FAILED : VA_STATUS_SUCCESS;
}

static VAStatus kw_EndPicture(VADriverContextP ctx, VAContextID context)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_context *k = tab_get(&d->contexts, context);
	struct kw_surface *s = k ? tab_get(&d->surfaces, k->target) : NULL;
	VAStatus st = !k ? VA_STATUS_ERROR_INVALID_CONTEXT : !s ? VA_STATUS_ERROR_INVALID_SURFACE : VA_STATUS_SUCCESS;
	if (st != VA_STATUS_SUCCESS) {
		UNLOCK(d);
		return st;
	}
	if (k->enc) {
		st = enc_end(d, context, k, s);
		UNLOCK(d);
		return st;
	}
	if (!k->codec) {
		/*
		 * Video processing: NV12 into a BGRX surface, done on the host from its
		 * copy of the input's picture when that completes (va/PROTOCOL.md "vpp").
		 */
		struct kw_surface *in = k->have_pic ? tab_get(&d->surfaces, k->vpp_src) : NULL;
		if (!in || !s->rgb) {
			UNLOCK(d);
			return !in ? VA_STATUS_ERROR_INVALID_SURFACE : VA_STATUS_ERROR_UNSUPPORTED_RT_FORMAT;
		}
		uint64_t pic = ++d->next_pic;
		struct jb b = {0};
		jb_printf(&b, "{\"op\":\"vpp\",\"surface\":%u,\"pic\":%llu,\"src\":%u,\"srcPic\":%llu,\"matrix\":\"%s\",\"inFull\":%s,\"outFull\":%s}",
			  k->target, (unsigned long long)pic, k->vpp_src, (unsigned long long)in->pic, k->vpp_bt601 ? "bt601" : "bt709",
			  k->vpp_in_full ? "true" : "false", k->vpp_out_full ? "true" : "false");
		s->pic = pic;
		s->ctx = context;
		s->state = PIC_PENDING;
		s->wait_sent = 0;
		s->failed = 0;
		VASurfaceID out = k->target;
		k->target = VA_INVALID_ID;
		k->have_pic = 0;
		link_send(d, &b, NULL, 0);
		free(b.p);
		/*
		 * Synchronous: done when this returns. Its consumers take the output
		 * without vaSyncSurface (mpv's dmabuf-wayland keeps a wl_buffer per
		 * surface and commits it as soon as the filter returns, assuming
		 * implicit fencing, which virtio-gpu does not give), and an output still
		 * waiting for its input (H.264's reorder delay) would be overtaken by the
		 * next one into the same surface. It cannot deadlock: apps process
		 * pictures their decoder has output, and the wait goes to the input.
		 */
		struct kw_surface *os = tab_get(&d->surfaces, out);
		if (os && os->pic == pic)
			surface_wait(d, os, UINT64_MAX);
		st = d->dead ? VA_STATUS_ERROR_OPERATION_FAILED : VA_STATUS_SUCCESS;
		UNLOCK(d);
		return st;
	}
	uint64_t pic = ++d->next_pic;
	struct jb b = {0};
	jb_printf(&b, "{\"op\":\"dec\",\"ctx\":%u,\"surface\":%u,\"pic\":%llu,\"profile\":\"%s\",\"refs\":[", context, k->target,
		  (unsigned long long)pic, k->codec->name);
	if (k->have_pic && k->codec->refs) {
		/* the reference surfaces as the pictures they hold now */
		VASurfaceID refs[16];
		k->codec->refs(k->data + k->pic_off, refs);
		for (int i = 0; i < k->codec->nrefs; i++) {
			struct kw_surface *r = refs[i] == VA_INVALID_SURFACE ? NULL : tab_get(&d->surfaces, refs[i]);
			jb_printf(&b, "%s%llu", i ? "," : "", (unsigned long long)(r ? r->pic : 0));
		}
	}
	jb_printf(&b, "],\"bufs\":[%s]", k->bufs.p ? k->bufs.p : "");
	/* a second surface the picture writes (AV1 film grain's display picture): a picture of its own, done with this one */
	VASurfaceID ds = k->have_pic && k->codec->display ? k->codec->display(k->data + k->pic_off) : VA_INVALID_SURFACE;
	struct kw_surface *dsurf = ds != VA_INVALID_SURFACE && ds != k->target ? tab_get(&d->surfaces, ds) : NULL;
	if (dsurf) {
		uint64_t dpic = ++d->next_pic;
		jb_printf(&b, ",\"display\":[%u,%llu]", ds, (unsigned long long)dpic);
		dsurf->pic = dpic;
		dsurf->ctx = context;
		dsurf->state = PIC_PENDING;
		dsurf->wait_sent = 0;
		dsurf->failed = 0;
		store_invalidate(dsurf);
	}
	jb_printf(&b, "}");
	s->pic = pic;
	s->ctx = context;
	s->state = PIC_PENDING;
	s->wait_sent = 0;
	s->failed = 0;
	store_invalidate(s);
	k->target = VA_INVALID_ID;
	/* the bytes go out without mu held: the context gives them to the write and takes them back after */
	uint8_t *data = k->data;
	size_t n = k->n, cap = k->cap;
	k->data = NULL;
	k->n = k->cap = 0;
	link_send(d, &b, data, n);
	free(b.p);
	k = tab_get(&d->contexts, context);
	if (k && !k->data) {
		k->data = data;
		k->cap = cap;
	} else
		free(data);
	if (d->dead)
		st = VA_STATUS_ERROR_OPERATION_FAILED;
	UNLOCK(d);
	return st;
}

static VAStatus kw_SyncSurface2(VADriverContextP ctx, VASurfaceID id, uint64_t timeout_ns)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_surface *s = tab_get(&d->surfaces, id);
	/* a decode that failed on the host is no error here (the picture reads back as a stand-in) */
	VAStatus st = s ? surface_wait(d, s, timeout_ns == VA_TIMEOUT_INFINITE ? UINT64_MAX : timeout_ns) : VA_STATUS_ERROR_INVALID_SURFACE;
	UNLOCK(d);
	return st;
}

static VAStatus kw_SyncSurface(VADriverContextP ctx, VASurfaceID id)
{
	return kw_SyncSurface2(ctx, id, VA_TIMEOUT_INFINITE);
}

/* a coded buffer: until its picture's chunk came (ffmpeg's async encode); other buffers are always ready */
static VAStatus kw_SyncBuffer(VADriverContextP ctx, VABufferID id, uint64_t timeout_ns)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_buffer *b = tab_get(&d->buffers, id);
	VAStatus st = !b ? VA_STATUS_ERROR_INVALID_BUFFER
		: b->type != VAEncCodedBufferType ? VA_STATUS_SUCCESS
		: coded_wait(d, id, timeout_ns == VA_TIMEOUT_INFINITE ? UINT64_MAX : timeout_ns, &b);
	UNLOCK(d);
	return st;
}

static VAStatus kw_QuerySurfaceStatus(VADriverContextP ctx, VASurfaceID id, VASurfaceStatus *status)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_surface *s = tab_get(&d->surfaces, id);
	if (s)
		*status = (s->state == PIC_PENDING || s->enc_busy) && !d->dead ? VASurfaceRendering : VASurfaceReady;
	UNLOCK(d);
	return s ? VA_STATUS_SUCCESS : VA_STATUS_ERROR_INVALID_SURFACE;
}

/* a failed picture: one record over all of its macroblocks, as far as the driver knows (the host says no more) */
static VAStatus kw_QuerySurfaceError(VADriverContextP ctx, VASurfaceID id, VAStatus error, void **info)
{
	static __thread VASurfaceDecodeMBErrors errs[2];
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_surface *s = tab_get(&d->surfaces, id);
	int failed = s && s->failed, mbs = s ? ((s->w + 15) / 16) * ((s->h + 15) / 16) : 0;
	UNLOCK(d);
	if (!s)
		return VA_STATUS_ERROR_INVALID_SURFACE;
	memset(errs, 0, sizeof errs);
	int n = 0;
	if (failed && error == VA_STATUS_ERROR_DECODING_ERROR) {
		errs[0].status = 1;
		errs[0].start_mb = 0;
		errs[0].end_mb = mbs ? mbs - 1 : 0;
		errs[0].decode_error_type = VADecodeMBError;
		errs[0].num_mb = mbs;
		n = 1;
	}
	errs[n].status = -1;
	*info = errs;
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_PutSurface(VADriverContextP ctx, VASurfaceID s, void *draw, short sx, short sy, unsigned short sw,
			      unsigned short sh, short dx, short dy, unsigned short dw, unsigned short dh, VARectangle *clips,
			      unsigned int nclips, unsigned int flags)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static const VAImageFormat nv12_format = {.fourcc = VA_FOURCC_NV12, .byte_order = VA_LSB_FIRST, .bits_per_pixel = 12};

/* BGRX where video processing is offered: its surfaces (ffmpeg's frames of bgr0 need the format listed; images of it read BGRX surfaces back) */
static const VAImageFormat bgrx_format = {.fourcc = VA_FOURCC_BGRX, .byte_order = VA_LSB_FIRST, .bits_per_pixel = 32, .depth = 24,
					  .red_mask = 0x00ff0000, .green_mask = 0x0000ff00, .blue_mask = 0x000000ff};

static VAStatus kw_QueryImageFormats(VADriverContextP ctx, VAImageFormat *list, int *num)
{
	list[0] = nv12_format;
	*num = 1;
	if (vpp_ok(DRV(ctx), ctx))
		list[(*num)++] = bgrx_format;
	return VA_STATUS_SUCCESS;
}

static void nv12_image(VAImage *img, int w, int h)
{
	uint32_t pitch, uv;
	size_t size;
	nv12_layout(w, h, &pitch, &uv, &size);
	img->format = nv12_format;
	img->width = w;
	img->height = h;
	img->num_planes = 2;
	img->pitches[0] = img->pitches[1] = pitch;
	img->offsets[0] = 0;
	img->offsets[1] = uv;
	img->data_size = (uint32_t)size;
}

/* a BGRX image (video processing outputs read back): one plane, pitch w * 4 */
static void bgrx_image(VAImage *img, int w, int h)
{
	img->format = bgrx_format;
	img->width = w;
	img->height = h;
	img->num_planes = 1;
	img->pitches[0] = (uint32_t)w * 4;
	img->offsets[0] = 0;
	img->data_size = (uint32_t)w * h * 4;
}

static VAStatus kw_CreateImage(VADriverContextP ctx, VAImageFormat *format, int width, int height, VAImage *image)
{
	struct drv *d = DRV(ctx);
	int rgb = format->fourcc == VA_FOURCC_BGRX && vpp_ok(d, ctx);
	if (format->fourcc != VA_FOURCC_NV12 && !rgb)
		return VA_STATUS_ERROR_INVALID_IMAGE_FORMAT;
	if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
		return VA_STATUS_ERROR_INVALID_PARAMETER;
	struct kw_image *im = calloc(1, sizeof *im);
	struct kw_buffer *b = calloc(1, sizeof *b);
	if (im && rgb)
		bgrx_image(&im->image, width, height);
	else if (im)
		nv12_image(&im->image, width, height);
	if (!im || !b || !(b->data = malloc(im->image.data_size))) {
		free(im);
		free(b);
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	}
	im->derived = VA_INVALID_ID;
	b->type = VAImageBufferType;
	b->size = im->image.data_size;
	b->num = 1;
	b->surface = VA_INVALID_ID;
	LOCK(d);
	im->image.buf = tab_add(&d->buffers, b);
	im->image.image_id = im->image.buf ? tab_add(&d->images, im) : 0;
	VAStatus st = VA_STATUS_SUCCESS;
	if (!im->image.image_id) {
		tab_del(&d->buffers, im->image.buf);
		free(b->data);
		free(b);
		free(im);
		st = VA_STATUS_ERROR_ALLOCATION_FAILED;
	} else
		*image = im->image;
	UNLOCK(d);
	return st;
}

static VAStatus kw_DeriveImage(VADriverContextP ctx, VASurfaceID surface, VAImage *image)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_surface *s = tab_get(&d->surfaces, surface);
	if (!s) {
		UNLOCK(d);
		return VA_STATUS_ERROR_INVALID_SURFACE;
	}
	struct kw_image *im = calloc(1, sizeof *im);
	struct kw_buffer *b = calloc(1, sizeof *b);
	if (im && s->rgb)
		bgrx_image(&im->image, s->w, s->h);
	else if (im)
		nv12_image(&im->image, s->w, s->h);
	if (im && b) {
		im->derived = surface;
		b->type = VAImageBufferType;
		b->size = im->image.data_size;
		b->num = 1;
		b->surface = surface;
		im->image.buf = tab_add(&d->buffers, b);
		im->image.image_id = im->image.buf ? tab_add(&d->images, im) : 0;
	}
	if (!im || !b || !im->image.image_id) {
		if (im && b && im->image.buf)
			tab_del(&d->buffers, im->image.buf);
		free(im);
		free(b);
		UNLOCK(d);
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	}
	*image = im->image;
	UNLOCK(d);
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_DestroyImage(VADriverContextP ctx, VAImageID id)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_image *im = tab_get(&d->images, id);
	if (im) {
		/* its buffer, unless the app destroyed it already (ids are not reused, so it is no other) */
		struct kw_buffer *b = tab_get(&d->buffers, im->image.buf);
		tab_del(&d->buffers, im->image.buf);
		if (b) {
			free(b->data);
			free(b);
		}
		tab_del(&d->images, id);
		free(im);
	}
	UNLOCK(d);
	return im ? VA_STATUS_SUCCESS : VA_STATUS_ERROR_INVALID_IMAGE;
}

static VAStatus kw_SetImagePalette(VADriverContextP ctx, VAImageID image, unsigned char *palette)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_GetImage(VADriverContextP ctx, VASurfaceID surface, int x, int y, unsigned int width, unsigned int height,
			    VAImageID image)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_surface *s = tab_get(&d->surfaces, surface);
	struct kw_image *im = tab_get(&d->images, image);
	struct kw_buffer *b = im ? tab_get(&d->buffers, im->image.buf) : NULL;
	VAStatus st = !s ? VA_STATUS_ERROR_INVALID_SURFACE : !b || b->detached ? VA_STATUS_ERROR_INVALID_IMAGE
		: s->rgb != (im->image.format.fourcc == VA_FOURCC_BGRX) ? VA_STATUS_ERROR_INVALID_IMAGE_FORMAT : VA_STATUS_SUCCESS;
	if (st == VA_STATUS_SUCCESS && (x < 0 || y < 0 || (uint64_t)x + width > (unsigned)s->w || (uint64_t)y + height > (unsigned)s->h ||
					 width > im->image.width || height > im->image.height))
		st = VA_STATUS_ERROR_INVALID_PARAMETER;
	if (st == VA_STATUS_SUCCESS && b->surface == surface)
		st = store_fetch(d, surface, s); /* its own derived image: already the surface's pixels */
	else if (st == VA_STATUS_SUCCESS && b->surface != VA_INVALID_ID)
		st = VA_STATUS_ERROR_INVALID_IMAGE;
	else if (st == VA_STATUS_SUCCESS && (st = store_fetch(d, surface, s)) == VA_STATUS_SUCCESS) {
		/* the fetch may have waited: look everything up again */
		s = tab_get(&d->surfaces, surface);
		im = tab_get(&d->images, image);
		b = im ? tab_get(&d->buffers, im->image.buf) : NULL;
		if (!s || !b) {
			UNLOCK(d);
			return !s ? VA_STATUS_ERROR_INVALID_SURFACE : VA_STATUS_ERROR_INVALID_IMAGE;
		}
		if (s->rgb) {
			/* BGRX: rows of width * 4 bytes */
			size_t sp = (size_t)s->w * 4;
			for (unsigned r = 0; r < height; r++)
				memcpy(b->data + im->image.offsets[0] + r * im->image.pitches[0], s->st.pix + (size_t)(y + r) * sp + (size_t)x * 4, (size_t)width * 4);
			UNLOCK(d);
			return st;
		}
		uint32_t pitch, uv;
		size_t size;
		nv12_layout(s->w, s->h, &pitch, &uv, &size);
		const uint8_t *sy = s->st.pix, *suv = s->st.pix + uv;
		uint8_t *dy = b->data + im->image.offsets[0], *duv = b->data + im->image.offsets[1];
		for (unsigned r = 0; r < height; r++)
			memcpy(dy + r * im->image.pitches[0], sy + (size_t)(y + r) * pitch + x, width);
		int x2 = x & ~1, y2 = y / 2;
		unsigned cw = (width + 1) & ~1u;
		if ((unsigned)x2 + cw > pitch)
			cw = pitch - x2;
		for (unsigned r = 0; r < (height + 1) / 2; r++)
			memcpy(duv + r * im->image.pitches[1], suv + (size_t)(y2 + r) * pitch + x2, cw);
	}
	UNLOCK(d);
	return st;
}

/*
 * An image's rectangle into a surface of its format (no scaling): the
 * surface's pixels are then the guest's (an encode's input sends them).
 * A rectangle short of the whole surface reads the rest back first.
 */
static VAStatus kw_PutImage(VADriverContextP ctx, VASurfaceID surface, VAImageID image, int sx, int sy, unsigned int sw,
			    unsigned int sh, int dx, int dy, unsigned int dw, unsigned int dh)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_surface *s = tab_get(&d->surfaces, surface);
	struct kw_image *im = tab_get(&d->images, image);
	struct kw_buffer *b = im ? tab_get(&d->buffers, im->image.buf) : NULL;
	VAStatus st = !s ? VA_STATUS_ERROR_INVALID_SURFACE : !b || b->detached ? VA_STATUS_ERROR_INVALID_IMAGE
		: s->rgb != (im->image.format.fourcc == VA_FOURCC_BGRX) ? VA_STATUS_ERROR_INVALID_IMAGE_FORMAT : VA_STATUS_SUCCESS;
	if (st == VA_STATUS_SUCCESS && (sw != dw || sh != dh))
		st = VA_STATUS_ERROR_UNIMPLEMENTED; /* no scaling */
	if (st == VA_STATUS_SUCCESS && (sx < 0 || sy < 0 || dx < 0 || dy < 0 || (uint64_t)sx + sw > im->image.width || (uint64_t)sy + sh > im->image.height ||
					 (uint64_t)dx + dw > (unsigned)s->w || (uint64_t)dy + dh > (unsigned)s->h))
		st = VA_STATUS_ERROR_INVALID_PARAMETER;
	if (st == VA_STATUS_SUCCESS && b->surface != VA_INVALID_ID && b->surface != surface)
		st = VA_STATUS_ERROR_INVALID_IMAGE;
	if (st != VA_STATUS_SUCCESS || b->surface == surface) {
		/* its own derived image: already the surface's pixels */
		if (st == VA_STATUS_SUCCESS && s->st.pix)
			surface_written(s);
		UNLOCK(d);
		return st;
	}
	int whole = !dx && !dy && dw == (unsigned)s->w && dh == (unsigned)s->h;
	if (!whole && !guest_valid(s)) {
		if ((st = store_fetch(d, surface, s)) == VA_STATUS_SUCCESS) {
			/* the fetch may have waited: look everything up again */
			s = tab_get(&d->surfaces, surface);
			im = tab_get(&d->images, image);
			b = im ? tab_get(&d->buffers, im->image.buf) : NULL;
			if (!s || !b)
				st = !s ? VA_STATUS_ERROR_INVALID_SURFACE : VA_STATUS_ERROR_INVALID_IMAGE;
		}
	} else if (!store_pixels(s))
		st = VA_STATUS_ERROR_ALLOCATION_FAILED;
	if (st != VA_STATUS_SUCCESS) {
		UNLOCK(d);
		return st;
	}
	if (s->rgb) {
		size_t dp = (size_t)s->w * 4;
		for (unsigned r = 0; r < dh; r++)
			memcpy(s->st.pix + (size_t)(dy + r) * dp + (size_t)dx * 4, b->data + im->image.offsets[0] + (size_t)(sy + r) * im->image.pitches[0] + (size_t)sx * 4,
			       (size_t)dw * 4);
	} else {
		uint32_t pitch, uv;
		size_t size;
		nv12_layout(s->w, s->h, &pitch, &uv, &size);
		for (unsigned r = 0; r < dh; r++)
			memcpy(s->st.pix + (size_t)(dy + r) * pitch + dx, b->data + im->image.offsets[0] + (size_t)(sy + r) * im->image.pitches[0] + sx, dw);
		/* CbCr pairs from even columns; rows of the half-height plane */
		unsigned dx2 = dx & ~1, sx2 = sx & ~1, cw = (dw + (dx & 1) + 1) & ~1u, rows = (dh + (dy & 1) + 1) / 2;
		if (dx2 + cw > pitch)
			cw = pitch - dx2;
		if (sx2 + cw > im->image.pitches[1])
			cw = im->image.pitches[1] > sx2 ? im->image.pitches[1] - sx2 : 0;
		for (unsigned r = 0; r < rows && dy / 2 + r < (unsigned)(s->h + 1) / 2 && sy / 2 + r < (im->image.height + 1) / 2; r++)
			memcpy(s->st.pix + uv + (size_t)(dy / 2 + r) * pitch + dx2, b->data + im->image.offsets[1] + (size_t)(sy / 2 + r) * im->image.pitches[1] + sx2, cw);
	}
	surface_written(s);
	UNLOCK(d);
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_QuerySubpictureFormats(VADriverContextP ctx, VAImageFormat *list, unsigned int *flags, unsigned int *num)
{
	*num = 0;
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_CreateSubpicture(VADriverContextP ctx, VAImageID image, VASubpictureID *sub)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_DestroySubpicture(VADriverContextP ctx, VASubpictureID sub)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_SetSubpictureImage(VADriverContextP ctx, VASubpictureID sub, VAImageID image)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_SetSubpictureChromakey(VADriverContextP ctx, VASubpictureID sub, unsigned int min, unsigned int max, unsigned int mask)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_SetSubpictureGlobalAlpha(VADriverContextP ctx, VASubpictureID sub, float alpha)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_AssociateSubpicture(VADriverContextP ctx, VASubpictureID sub, VASurfaceID *targets, int n, short sx, short sy,
				       unsigned short sw, unsigned short sh, short dx, short dy, unsigned short dw, unsigned short dh,
				       unsigned int flags)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_DeassociateSubpicture(VADriverContextP ctx, VASubpictureID sub, VASurfaceID *targets, int n)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_QueryDisplayAttributes(VADriverContextP ctx, VADisplayAttribute *list, int *num)
{
	*num = 0;
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_GetDisplayAttributes(VADriverContextP ctx, VADisplayAttribute *list, int num)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_SetDisplayAttributes(VADriverContextP ctx, VADisplayAttribute *list, int num)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_BufferInfo(VADriverContextP ctx, VABufferID id, VABufferType *type, unsigned int *size, unsigned int *num)
{
	struct drv *d = DRV(ctx);
	LOCK(d);
	struct kw_buffer *b = tab_get(&d->buffers, id);
	if (b) {
		*type = b->type;
		*size = b->size;
		*num = b->num;
	}
	UNLOCK(d);
	return b ? VA_STATUS_SUCCESS : VA_STATUS_ERROR_INVALID_BUFFER;
}

static VAStatus kw_LockSurface(VADriverContextP ctx, VASurfaceID s, unsigned int *fourcc, unsigned int *ls, unsigned int *us,
			       unsigned int *vs, unsigned int *lo, unsigned int *uo, unsigned int *vo, unsigned int *name, void **buf)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static VAStatus kw_UnlockSurface(VADriverContextP ctx, VASurfaceID s)
{
	return VA_STATUS_ERROR_UNIMPLEMENTED;
}

static int export_ok(struct drv *d, VADriverContextP ctx);

static VAStatus kw_QuerySurfaceAttributes(VADriverContextP ctx, VAConfigID config, VASurfaceAttrib *list, unsigned int *num)
{
	struct drv *d = DRV(ctx);
	VASurfaceAttrib a[8];
	unsigned n = 0;
	LOCK(d);
	struct kw_config *cfg = tab_get(&d->configs, config);
	int ok = cfg != NULL, vpp = cfg && !cfg->codec;
	UNLOCK(d);
	if (!ok)
		return VA_STATUS_ERROR_INVALID_CONFIG;
	memset(a, 0, sizeof a);
#define ATTR(t, f, v)                                   \
	do {                                            \
		a[n].type = (t);                        \
		a[n].flags = (f);                       \
		a[n].value.type = VAGenericValueTypeInteger; \
		a[n].value.value.i = (v);               \
		n++;                                    \
	} while (0)
	ATTR(VASurfaceAttribPixelFormat, VA_SURFACE_ATTRIB_GETTABLE | VA_SURFACE_ATTRIB_SETTABLE, VA_FOURCC_NV12);
	if (vpp)
		ATTR(VASurfaceAttribPixelFormat, VA_SURFACE_ATTRIB_GETTABLE | VA_SURFACE_ATTRIB_SETTABLE, VA_FOURCC_BGRX);
	ATTR(VASurfaceAttribMinWidth, VA_SURFACE_ATTRIB_GETTABLE, 16);
	ATTR(VASurfaceAttribMinHeight, VA_SURFACE_ATTRIB_GETTABLE, 16);
	ATTR(VASurfaceAttribMaxWidth, VA_SURFACE_ATTRIB_GETTABLE, d->max_w);
	ATTR(VASurfaceAttribMaxHeight, VA_SURFACE_ATTRIB_GETTABLE, d->max_h);
	/* DRM_PRIME_2: what vaExportSurfaceHandle gives (GStreamer offers memory:DMABuf only then); surfaces are made as VA memory */
	LOCK(d);
	int ex = export_ok(d, ctx);
	UNLOCK(d);
	ATTR(VASurfaceAttribMemoryType, VA_SURFACE_ATTRIB_GETTABLE | VA_SURFACE_ATTRIB_SETTABLE,
	     VA_SURFACE_ATTRIB_MEM_TYPE_VA | (ex ? VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2 : 0));
#undef ATTR
	if (!list) {
		*num = n;
		return VA_STATUS_SUCCESS;
	}
	if (*num < n) {
		*num = n;
		return VA_STATUS_ERROR_MAX_NUM_EXCEEDED;
	}
	memcpy(list, a, n * sizeof *a);
	*num = n;
	return VA_STATUS_SUCCESS;
}

/* ---- zero-copy output: vaExportSurfaceHandle (va/PROTOCOL.md "export") ---- */

#define KW_FOURCC(a, b, c, d) ((uint32_t)(a) | (uint32_t)(b) << 8 | (uint32_t)(c) << 16 | (uint32_t)(d) << 24)
#define KW_DRM_R8 KW_FOURCC('R', '8', ' ', ' ')
#define KW_DRM_GR88 KW_FOURCC('G', 'R', '8', '8')
#define KW_DRM_NV12 KW_FOURCC('N', 'V', '1', '2')
#define KW_DRM_XRGB8888 KW_FOURCC('X', 'R', '2', '4')
#define KW_DRM_MOD_LINEAR 0ull
/* virgl's formats and binds (virglrenderer's virgl_hw.h) */
#define KW_VIRGL_B8G8R8X8_UNORM 2
#define KW_VIRGL_R8_UNORM 64
#define KW_VIRGL_R8G8_UNORM 65
#define KW_VIRGL_BIND_RENDER_TARGET (1u << 1)
#define KW_VIRGL_BIND_SAMPLER_VIEW (1u << 3)

static int drm_ioctl(int fd, unsigned long req, void *arg)
{
	int r;
	do
		r = ioctl(fd, req, arg);
	while (r < 0 && (errno == EINTR || errno == EAGAIN));
	return r;
}

/*
 * The render node, opened by the driver itself (once; -1 when there is none
 * with 3D): the device libva's DRM state names (a render node), else
 * renderD128. Its own open, not libva's fd: a GEM handle is per open file
 * and not counted per user, so an importer on the app's fd (Mesa, when the
 * app's GL shares libva's fd) would close the driver's handle with its own.
 * mu held.
 */
static int drm_open(struct drv *d, VADriverContextP ctx)
{
	if (d->drm_tried)
		return d->drm_fd;
	d->drm_tried = 1;
	char path[128] = "/dev/dri/renderD128";
	struct drm_state *ds = ctx->drm_state;
	if (ds && ds->fd >= 0) {
		char link[64], got[128];
		snprintf(link, sizeof link, "/proc/self/fd/%d", ds->fd);
		ssize_t n = readlink(link, got, sizeof got - 1);
		if (n > 0) {
			got[n] = 0;
			if (strstr(got, "/renderD"))
				memcpy(path, got, (size_t)n + 1);
		}
	}
	int fd = open(path, O_RDWR | O_CLOEXEC);
	uint64_t v3d = 0;
	struct drm_virtgpu_getparam gp = {.param = VIRTGPU_PARAM_3D_FEATURES, .value = (uintptr_t)&v3d};
	if (fd >= 0 && (drm_ioctl(fd, DRM_IOCTL_VIRTGPU_GETPARAM, &gp) < 0 || !v3d)) {
		kw_log("%s has no virtio-gpu 3D: no export", path);
		close(fd);
		fd = -1;
	} else if (fd < 0)
		kw_log("cannot open %s: %s; no export", path, strerror(errno));
	d->drm_fd = fd;
	return fd;
}

/* whether vaExportSurfaceHandle can work here; mu held */
static int export_ok(struct drv *d, VADriverContextP ctx)
{
	return d->can_export && drm_open(d, ctx) >= 0;
}

/*
 * A 2D texture resource for one plane; 0 or -errno. Its guest backing is
 * `size` bytes, 0 for one page: nothing maps it, but a Wayland relay that
 * names client buffers by resource (wland's --dmabuf virtgpu) refuses one
 * whose backing is smaller than the buffer it claims.
 */
static int plane_create(int fd, uint32_t format, int w, int h, uint32_t size, uint32_t *bo, uint32_t *res)
{
	struct drm_virtgpu_resource_create rc = {.target = 2 /* PIPE_TEXTURE_2D */, .format = format,
						  .bind = KW_VIRGL_BIND_SAMPLER_VIEW | KW_VIRGL_BIND_RENDER_TARGET,
						  .width = (uint32_t)w, .height = (uint32_t)h, .depth = 1, .array_size = 1, .size = size};
	if (drm_ioctl(fd, DRM_IOCTL_VIRTGPU_RESOURCE_CREATE, &rc) < 0)
		return -errno;
	*bo = rc.bo_handle;
	*res = rc.res_handle;
	/* until the host has made it: an export reply then finds it */
	struct drm_virtgpu_3d_wait w3 = {.handle = rc.bo_handle};
	if (drm_ioctl(fd, DRM_IOCTL_VIRTGPU_WAIT, &w3) < 0)
		return -errno;
	return 0;
}

/*
 * NV12 as two dmabufs, Y (DRM_FORMAT_R8, the surface's size) and CbCr
 * (DRM_FORMAT_GR88, half of it rounded up), each its own virtio-gpu
 * resource at offset 0: Mesa's virgl imports a classic resource whole
 * (plane offsets are not used), so the planes cannot share one. Made at a
 * surface's first export and kept until it is destroyed; the host fills
 * them with each picture of the surface as it completes, before its
 * notice, so vaSyncSurface then sampling (or this call, for a picture done
 * already) sees it. Readback (vaGetImage) works as before, exact.
 */
static VAStatus kw_ExportSurfaceHandle(VADriverContextP ctx, VASurfaceID id, uint32_t mem_type, uint32_t flags, void *descp)
{
	struct drv *d = DRV(ctx);
	if (mem_type != VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2)
		return VA_STATUS_ERROR_UNSUPPORTED_MEMORY_TYPE;
	if (!descp)
		return VA_STATUS_ERROR_INVALID_PARAMETER;
	LOCK(d);
	if (!export_ok(d, ctx)) {
		UNLOCK(d);
		return VA_STATUS_ERROR_UNIMPLEMENTED;
	}
	struct kw_surface *s = tab_get(&d->surfaces, id);
	if (!s) {
		UNLOCK(d);
		return VA_STATUS_ERROR_INVALID_SURFACE;
	}
	int fd = d->drm_fd, w = s->w, h = s->h, cw = (w + 1) / 2, ch = (h + 1) / 2, rgb = s->rgb, nobj = rgb ? 1 : 2;
	s->users++;
	while (s->st.exporting && !s->doomed)
		pthread_cond_wait(&d->cv, &d->mu);
	if (s->doomed) {
		surface_put(s);
		UNLOCK(d);
		return VA_STATUS_ERROR_INVALID_SURFACE;
	}
	s->st.exporting = 1;
	VAStatus st = VA_STATUS_SUCCESS;
	if (!s->st.xbo[0]) {
		uint32_t bo[2] = {0, 0}, res[2] = {0, 0};
		UNLOCK(d);
		/* BGRX surfaces go to compositors (mpv's --vo=dmabuf-wayland): a backing of their size; NV12 planes are sampled only */
		int e = plane_create(fd, rgb ? KW_VIRGL_B8G8R8X8_UNORM : KW_VIRGL_R8_UNORM, w, h, rgb ? (uint32_t)w * (uint32_t)h * 4 : 0, &bo[0], &res[0]);
		if (!e && !rgb)
			e = plane_create(fd, KW_VIRGL_R8G8_UNORM, cw, ch, 0, &bo[1], &res[1]);
		LOCK(d);
		if (e) {
			kw_err("cannot make a surface's export resources on the render node: %s", strerror(-e));
			for (int i = 0; i < 2; i++)
				if (bo[i]) {
					struct drm_gem_close gc = {.handle = bo[i]};
					ioctl(fd, DRM_IOCTL_GEM_CLOSE, &gc);
				}
			st = VA_STATUS_ERROR_ALLOCATION_FAILED;
		} else {
			memcpy(s->st.xbo, bo, sizeof bo);
			memcpy(s->st.xres, res, sizeof res);
			s->st.xfd = fd;
		}
	}
	/* destroyed while its resources were made: its surf_free may have gone out already, so the host is not told of them */
	if (st == VA_STATUS_SUCCESS && s->doomed)
		st = VA_STATUS_ERROR_INVALID_SURFACE;
	if (st == VA_STATUS_SUCCESS) {
		/* the host fills them from now on: now with a picture done already, else at its completion */
		struct jb b = {0};
		if (rgb)
			jb_printf(&b, "{\"op\":\"export\",\"surface\":%u,\"pic\":%llu,\"width\":%d,\"height\":%d,\"format\":\"BGRX\",\"res\":[%u]}", id,
				  (unsigned long long)s->pic, w, h, s->st.xres[0]);
		else
			jb_printf(&b, "{\"op\":\"export\",\"surface\":%u,\"pic\":%llu,\"width\":%d,\"height\":%d,\"res\":[%u,%u]}", id,
				  (unsigned long long)s->pic, w, h, s->st.xres[0], s->st.xres[1]);
		struct reply *rep = link_call(d, &b, NULL, 0);
		free(b.p);
		const char *e = rep ? js_get(rep->json, "err") : NULL;
		if (!rep)
			st = VA_STATUS_ERROR_OPERATION_FAILED;
		else if (e) {
			char why[300];
			js_str(e, why, sizeof why);
			kw_err("the host cannot fill an exported surface: %s", why);
			st = VA_STATUS_ERROR_OPERATION_FAILED;
		}
		reply_free(rep);
	}
	int fds[2] = {-1, -1};
	for (int i = 0; i < nobj && st == VA_STATUS_SUCCESS && !s->doomed; i++) {
		struct drm_prime_handle ph = {.handle = s->st.xbo[i], .flags = DRM_CLOEXEC | DRM_RDWR};
		if (drm_ioctl(fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, &ph) < 0) {
			kw_err("PRIME_HANDLE_TO_FD: %s", strerror(errno));
			st = VA_STATUS_ERROR_OPERATION_FAILED;
		} else
			fds[i] = ph.fd;
	}
	s->st.exporting = 0;
	pthread_cond_broadcast(&d->cv);
	if (!surface_put(s) && st == VA_STATUS_SUCCESS)
		st = VA_STATUS_ERROR_INVALID_SURFACE;
	UNLOCK(d);
	if (st != VA_STATUS_SUCCESS) {
		for (int i = 0; i < 2; i++)
			if (fds[i] >= 0)
				close(fds[i]);
		return st;
	}
	VADRMPRIMESurfaceDescriptor *desc = descp;
	memset(desc, 0, sizeof *desc);
	if (rgb) {
		/* one plane, one layer either way */
		desc->fourcc = VA_FOURCC_BGRX;
		desc->width = (uint32_t)w;
		desc->height = (uint32_t)h;
		desc->num_objects = 1;
		desc->objects[0].fd = fds[0];
		desc->objects[0].size = (uint32_t)w * (uint32_t)h * 4;
		desc->objects[0].drm_format_modifier = KW_DRM_MOD_LINEAR;
		desc->num_layers = 1;
		desc->layers[0].drm_format = KW_DRM_XRGB8888;
		desc->layers[0].num_planes = 1;
		desc->layers[0].pitch[0] = (uint32_t)w * 4;
		kw_log("exported BGRX surface %#x (%dx%d)", id, w, h);
		return VA_STATUS_SUCCESS;
	}
	desc->fourcc = VA_FOURCC_NV12;
	desc->width = (uint32_t)w;
	desc->height = (uint32_t)h;
	desc->num_objects = 2;
	desc->objects[0].fd = fds[0];
	desc->objects[0].size = (uint32_t)w * (uint32_t)h;
	desc->objects[0].drm_format_modifier = KW_DRM_MOD_LINEAR;
	desc->objects[1].fd = fds[1];
	desc->objects[1].size = (uint32_t)cw * (uint32_t)ch * 2;
	desc->objects[1].drm_format_modifier = KW_DRM_MOD_LINEAR;
	if (flags & VA_EXPORT_SURFACE_COMPOSED_LAYERS) {
		desc->num_layers = 1;
		desc->layers[0].drm_format = KW_DRM_NV12;
		desc->layers[0].num_planes = 2;
		desc->layers[0].object_index[0] = 0;
		desc->layers[0].object_index[1] = 1;
		desc->layers[0].pitch[0] = (uint32_t)w;
		desc->layers[0].pitch[1] = (uint32_t)cw * 2;
	} else {
		desc->num_layers = 2;
		desc->layers[0].drm_format = KW_DRM_R8;
		desc->layers[0].num_planes = 1;
		desc->layers[0].object_index[0] = 0;
		desc->layers[0].pitch[0] = (uint32_t)w;
		desc->layers[1].drm_format = KW_DRM_GR88;
		desc->layers[1].num_planes = 1;
		desc->layers[1].object_index[0] = 1;
		desc->layers[1].pitch[0] = (uint32_t)cw * 2;
	}
	kw_log("exported surface %#x (%dx%d, %s layers)", id, w, h, flags & VA_EXPORT_SURFACE_COMPOSED_LAYERS ? "composed" : "separate");
	return VA_STATUS_SUCCESS;
}

/* ---- video processing: NV12 to BGRX, no filters (scale_vaapi's format conversion) ---- */

static VAStatus kw_QueryVideoProcFilters(VADriverContextP ctx, VAContextID context, VAProcFilterType *filters, unsigned int *num)
{
	*num = 0;
	return VA_STATUS_SUCCESS;
}

static VAStatus kw_QueryVideoProcFilterCaps(VADriverContextP ctx, VAContextID context, VAProcFilterType type, void *caps, unsigned int *num)
{
	return VA_STATUS_ERROR_UNSUPPORTED_FILTER;
}

static VAStatus kw_QueryVideoProcPipelineCaps(VADriverContextP ctx, VAContextID context, VABufferID *filters, unsigned int nfilters,
					      VAProcPipelineCaps *caps)
{
	/* the arrays are the driver's: ffmpeg passes caps uninitialised and reads the pointers back (as Intel's drivers fill them) */
	static VAProcColorStandardType in[] = {VAProcColorStandardBT601, VAProcColorStandardBT709, VAProcColorStandardSMPTE170M,
					       VAProcColorStandardBT470BG, VAProcColorStandardExplicit};
	static VAProcColorStandardType out[] = {VAProcColorStandardSRGB, VAProcColorStandardBT709, VAProcColorStandardBT601};
	static uint32_t in_fmt[] = {VA_FOURCC_NV12}, out_fmt[] = {VA_FOURCC_BGRX};
	if (nfilters)
		return VA_STATUS_ERROR_UNSUPPORTED_FILTER;
	memset(caps, 0, sizeof *caps);
	caps->input_color_standards = in;
	caps->num_input_color_standards = sizeof in / sizeof in[0];
	caps->output_color_standards = out;
	caps->num_output_color_standards = sizeof out / sizeof out[0];
	caps->input_pixel_format = in_fmt;
	caps->num_input_pixel_formats = 1;
	caps->output_pixel_format = out_fmt;
	caps->num_output_pixel_formats = 1;
	struct drv *d = DRV(ctx);
	caps->max_input_width = caps->max_output_width = (uint32_t)d->max_w;
	caps->max_input_height = caps->max_output_height = (uint32_t)d->max_h;
	caps->min_input_width = caps->min_output_width = 16;
	caps->min_input_height = caps->min_output_height = 16;
	return VA_STATUS_SUCCESS;
}

/* ---- init ---- */

/* the hello (va/PROTOCOL.md): which profiles the host's WebCodecs decodes; mu held */
static int hello(struct drv *d)
{
	struct jb b = {0};
	jb_printf(&b, "{\"op\":\"hello\",\"version\":%d}", KWVA_VERSION);
	struct reply *rep = link_call(d, &b, NULL, 0);
	free(b.p);
	if (!rep)
		return -1;
	const char *e = js_get(rep->json, "err");
	if (e) {
		char why[300];
		js_str(e, why, sizeof why);
		kw_err("the host refused the link: %s", why);
		reply_free(rep);
		return -1;
	}
	char vendor[160] = "";
	js_str(js_get(rep->json, "vendor"), vendor, sizeof vendor);
	snprintf(d->vendor, sizeof d->vendor, "kwva (WebCodecs%s%s)", *vendor ? ": " : "", vendor);
	d->max_w = (int)js_num(js_get(rep->json, "maxWidth"), 1920);
	d->max_h = (int)js_num(js_get(rep->json, "maxHeight"), 1088);
	if (d->max_w <= 0 || d->max_w > 16384)
		d->max_w = 1920;
	if (d->max_h <= 0 || d->max_h > 16384)
		d->max_h = 1088;
	const char *ex = js_get(rep->json, "export");
	d->can_export = ex && !strncmp(ex, "true", 4);
	const char *p = js_get(rep->json, "profiles");
	if (p && *p == '[') {
		for (p++;;) {
			p = js_ws(p);
			if (*p == ',')
				p = js_ws(p + 1);
			if (*p != '"')
				break;
			char name[32];
			js_str(p, name, sizeof name);
			p = js_skip(p);
			const struct codec *c = codec_by_name(name);
			if (c && d->nprofiles < MAX_PROFILES && !profile_ok(d, c->profile))
				d->profiles[d->nprofiles++] = c->profile;
		}
	}
	/* "encode": {profile: [rate control modes]} of the codecs with encode knowledge */
	const char *en = js_get(rep->json, "encode");
	for (int i = 0; en && *en == '{' && i < NCODECS; i++) {
		const char *m = codecs[i].enc_coded_off ? js_get(en, codecs[i].name) : NULL;
		uint32_t rc = 0;
		if (m && *m == '[')
			for (m++;;) {
				m = js_ws(m);
				if (*m == ',')
					m = js_ws(m + 1);
				if (*m != '"')
					break;
				char mode[16];
				js_str(m, mode, sizeof mode);
				m = js_skip(m);
				rc |= !strcmp(mode, "cqp") ? VA_RC_CQP : !strcmp(mode, "cbr") ? VA_RC_CBR : !strcmp(mode, "vbr") ? VA_RC_VBR : 0;
			}
		if (rc && d->nenc < MAX_PROFILES && !enc_rc(d, codecs[i].profile)) {
			d->enc_profiles[d->nenc] = codecs[i].profile;
			d->enc_rc[d->nenc++] = rc;
		}
	}
	kw_log("host: %s, %d profile(s), %d to encode, up to %dx%d%s", d->vendor, d->nprofiles, d->nenc, d->max_w, d->max_h, d->can_export ? ", export" : "");
	reply_free(rep);
	return 0;
}

#define KW_CAT2(a, b, c) a##b##_##c
#define KW_CAT(a, b, c) KW_CAT2(a, b, c)
#define KW_DRIVER_INIT KW_CAT(__vaDriverInit_, VA_MAJOR_VERSION, VA_MINOR_VERSION)

KWVA_EXPORT VAStatus KW_DRIVER_INIT(VADriverContextP ctx);

VAStatus KW_DRIVER_INIT(VADriverContextP ctx)
{
	struct drv *d = calloc(1, sizeof *d);
	if (!d)
		return VA_STATUS_ERROR_ALLOCATION_FAILED;
	pthread_mutex_init(&d->mu, NULL);
	pthread_mutex_init(&d->wmu, NULL);
	pthread_cond_init(&d->cv, NULL);
	d->next_r = 1;
	d->drm_fd = -1;
	d->configs.kind = 1;
	d->contexts.kind = 2;
	d->surfaces.kind = 3;
	d->buffers.kind = 4;
	d->images.kind = 5;
	d->fd = link_connect();
	int ok = d->fd >= 0;
	if (!ok)
		/* the usual case where the host has no decoder: printed only with KWVA_DEBUG */
		kw_log("no host decoder on %s (the SDK's va option is off, or this host has no WebCodecs)",
		       getenv("KWVA_LINK") && *getenv("KWVA_LINK") ? getenv("KWVA_LINK") : "vsock port 1024");
	else if (pthread_create(&d->reader, NULL, reader_main, d) == 0) {
		d->reader_on = 1;
		LOCK(d);
		ok = hello(d) == 0;
		UNLOCK(d);
	} else
		ok = 0;
	if (!ok) {
		if (d->fd >= 0) {
			LOCK(d);
			d->closing = 1;
			UNLOCK(d);
			shutdown(d->fd, SHUT_RDWR);
			if (d->reader_on)
				pthread_join(d->reader, NULL);
			close(d->fd);
		}
		pthread_cond_destroy(&d->cv);
		pthread_mutex_destroy(&d->wmu);
		pthread_mutex_destroy(&d->mu);
		free(d);
		return VA_STATUS_ERROR_UNKNOWN;
	}
	ctx->pDriverData = d;
	ctx->version_major = VA_MAJOR_VERSION;
	ctx->version_minor = VA_MINOR_VERSION;
	ctx->max_profiles = 2 * MAX_PROFILES + 1; /* decode, encode only, VAProfileNone */
	ctx->max_entrypoints = 2;		  /* VLD and EncSlice */
	ctx->max_attributes = 8;
	ctx->max_image_formats = 2;
	ctx->max_subpic_formats = 1;
	ctx->max_display_attributes = 1;
	ctx->str_vendor = d->vendor;

	struct VADriverVTable *vt = ctx->vtable;
	memset(vt, 0, sizeof *vt);
	vt->vaTerminate = kw_Terminate;
	vt->vaQueryConfigProfiles = kw_QueryConfigProfiles;
	vt->vaQueryConfigEntrypoints = kw_QueryConfigEntrypoints;
	vt->vaGetConfigAttributes = kw_GetConfigAttributes;
	vt->vaCreateConfig = kw_CreateConfig;
	vt->vaDestroyConfig = kw_DestroyConfig;
	vt->vaQueryConfigAttributes = kw_QueryConfigAttributes;
	vt->vaCreateSurfaces = kw_CreateSurfaces;
	vt->vaDestroySurfaces = kw_DestroySurfaces;
	vt->vaCreateContext = kw_CreateContext;
	vt->vaDestroyContext = kw_DestroyContext;
	vt->vaCreateBuffer = kw_CreateBuffer;
	vt->vaBufferSetNumElements = kw_BufferSetNumElements;
	vt->vaMapBuffer = kw_MapBuffer;
	vt->vaUnmapBuffer = kw_UnmapBuffer;
	vt->vaDestroyBuffer = kw_DestroyBuffer;
	vt->vaBeginPicture = kw_BeginPicture;
	vt->vaRenderPicture = kw_RenderPicture;
	vt->vaEndPicture = kw_EndPicture;
	vt->vaSyncSurface = kw_SyncSurface;
	vt->vaQuerySurfaceStatus = kw_QuerySurfaceStatus;
	vt->vaQuerySurfaceError = kw_QuerySurfaceError;
	vt->vaPutSurface = kw_PutSurface;
	vt->vaQueryImageFormats = kw_QueryImageFormats;
	vt->vaCreateImage = kw_CreateImage;
	vt->vaDeriveImage = kw_DeriveImage;
	vt->vaDestroyImage = kw_DestroyImage;
	vt->vaSetImagePalette = kw_SetImagePalette;
	vt->vaGetImage = kw_GetImage;
	vt->vaPutImage = kw_PutImage;
	vt->vaQuerySubpictureFormats = kw_QuerySubpictureFormats;
	vt->vaCreateSubpicture = kw_CreateSubpicture;
	vt->vaDestroySubpicture = kw_DestroySubpicture;
	vt->vaSetSubpictureImage = kw_SetSubpictureImage;
	vt->vaSetSubpictureChromakey = kw_SetSubpictureChromakey;
	vt->vaSetSubpictureGlobalAlpha = kw_SetSubpictureGlobalAlpha;
	vt->vaAssociateSubpicture = kw_AssociateSubpicture;
	vt->vaDeassociateSubpicture = kw_DeassociateSubpicture;
	vt->vaQueryDisplayAttributes = kw_QueryDisplayAttributes;
	vt->vaGetDisplayAttributes = kw_GetDisplayAttributes;
	vt->vaSetDisplayAttributes = kw_SetDisplayAttributes;
	vt->vaBufferInfo = kw_BufferInfo;
	vt->vaLockSurface = kw_LockSurface;
	vt->vaUnlockSurface = kw_UnlockSurface;
	vt->vaCreateSurfaces2 = kw_CreateSurfaces2;
	vt->vaQuerySurfaceAttributes = kw_QuerySurfaceAttributes;
	vt->vaExportSurfaceHandle = kw_ExportSurfaceHandle;
	vt->vaSyncSurface2 = kw_SyncSurface2;
	vt->vaSyncBuffer = kw_SyncBuffer;
	vt->vaMapBuffer2 = kw_MapBuffer2;
	struct VADriverVTableVPP *vpp = ctx->vtable_vpp;
	if (vpp) {
		vpp->version = VA_DRIVER_VTABLE_VPP_VERSION;
		vpp->vaQueryVideoProcFilters = kw_QueryVideoProcFilters;
		vpp->vaQueryVideoProcFilterCaps = kw_QueryVideoProcFilterCaps;
		vpp->vaQueryVideoProcPipelineCaps = kw_QueryVideoProcPipelineCaps;
	}
	return VA_STATUS_SUCCESS;
}
