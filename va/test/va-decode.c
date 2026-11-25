// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// va-decode: kwva's driver driven through its vtable, without libva or a
// display (a test program for va/build.sh's guest and native builds):
// dlopens the driver, decodes a VP9 IVF file as ffmpeg's VAAPI hwaccel
// does (superframes split, one picture per frame; a show_existing_frame is
// no picture but the output of the reference slot's surface, so hidden
// frames are read back that way), reads every shown picture back
// (vaDeriveImage and vaGetImage in turn) and prints each one's MD5 as
// libvpx's test vectors' .md5 files have it (the I420 planes), then the
// frames per second of the decode and readback. With -e (-E) each shown
// picture is also exported and drawn through EGL on the render node, its
// planes and an RGB conversion compared with its readback (va-export.h).
//
//   va-decode [-d DRIVER.so] [-n FRAMES] [-q] [-e | -E] [-r DEVICE] FILE.ivf
//
// DRIVER defaults to /usr/lib/aarch64-linux-gnu/dri/kw_drv_video.so (the
// guest's); KWVA_LINK picks the link as for any kwva client. -q prints only
// the summary. -r gives the driver libva's DRM state for DEVICE (default
// /dev/dri/renderD128 with -e; none otherwise). Exit 0 when every frame
// decoded and read back (and, with -e, exported and drawn right).
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <va/va.h>
#include <va/va_backend.h>
#include <va/va_dec_vp9.h>

/* ---- MD5 (RFC 1321) ---- */

struct md5 {
	uint32_t s[4];
	uint64_t n;
	uint8_t buf[64];
};

static const uint32_t md5_k[64] = {
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391};
static const uint8_t md5_r[64] = {7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20,
				  5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
				  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21};

static void md5_block(struct md5 *m, const uint8_t *p)
{
	uint32_t w[16], a = m->s[0], b = m->s[1], c = m->s[2], d = m->s[3];
	for (int i = 0; i < 16; i++)
		w[i] = p[i * 4] | p[i * 4 + 1] << 8 | p[i * 4 + 2] << 16 | (uint32_t)p[i * 4 + 3] << 24;
	for (int i = 0; i < 64; i++) {
		uint32_t f;
		int g;
		if (i < 16)
			f = (b & c) | (~b & d), g = i;
		else if (i < 32)
			f = (d & b) | (~d & c), g = (5 * i + 1) & 15;
		else if (i < 48)
			f = b ^ c ^ d, g = (3 * i + 5) & 15;
		else
			f = c ^ (b | ~d), g = (7 * i) & 15;
		uint32_t t = d;
		d = c;
		c = b;
		uint32_t x = a + f + md5_k[i] + w[g];
		b = b + ((x << md5_r[i]) | (x >> (32 - md5_r[i])));
		a = t;
	}
	m->s[0] += a, m->s[1] += b, m->s[2] += c, m->s[3] += d;
}

static void md5_init(struct md5 *m)
{
	m->s[0] = 0x67452301, m->s[1] = 0xefcdab89, m->s[2] = 0x98badcfe, m->s[3] = 0x10325476;
	m->n = 0;
}

static void md5_put(struct md5 *m, const uint8_t *p, size_t n)
{
	while (n) {
		size_t o = m->n & 63, k = 64 - o < n ? 64 - o : n;
		memcpy(m->buf + o, p, k);
		m->n += k, p += k, n -= k;
		if (((m->n) & 63) == 0)
			md5_block(m, m->buf);
	}
}

static void md5_hex(struct md5 *m, char out[33])
{
	uint64_t bits = m->n * 8;
	uint8_t pad = 0x80, z = 0, len[8];
	md5_put(m, &pad, 1);
	while ((m->n & 63) != 56)
		md5_put(m, &z, 1);
	for (int i = 0; i < 8; i++)
		len[i] = (uint8_t)(bits >> (8 * i));
	md5_put(m, len, 8);
	for (int i = 0; i < 16; i++)
		sprintf(out + i * 2, "%02x", (m->s[i / 4] >> (8 * (i % 4))) & 255);
}

/* ---- VP9 headers: what ffmpeg's vp9 decoder reads before it calls the hwaccel ---- */

struct bits {
	const uint8_t *p;
	size_t n, pos;
};

static unsigned rb(struct bits *b, int k)
{
	unsigned v = 0;
	while (k--) {
		unsigned bit = b->pos / 8 < b->n ? (b->p[b->pos / 8] >> (7 - b->pos % 8)) & 1 : 0;
		v = v << 1 | bit;
		b->pos++;
	}
	return v;
}

struct vp9hdr {
	int show_existing, idx, key, show, refresh;
};

static void vp9_header(const uint8_t *p, size_t n, struct vp9hdr *h)
{
	struct bits b = {p, n, 0};
	memset(h, 0, sizeof *h);
	rb(&b, 2);
	int profile = rb(&b, 1);
	profile |= rb(&b, 1) << 1;
	if (profile == 3)
		rb(&b, 1);
	if ((h->show_existing = rb(&b, 1))) {
		h->idx = rb(&b, 3);
		h->show = 1;
		return;
	}
	h->key = rb(&b, 1) == 0;
	h->show = rb(&b, 1);
	int err_res = rb(&b, 1);
	if (h->key) {
		h->refresh = 0xff;
		return;
	}
	int intra_only = h->show ? 0 : rb(&b, 1);
	if (!err_res)
		rb(&b, 2);
	if (intra_only) {
		rb(&b, 24);
		if (profile > 0) {
			if (profile >= 2)
				rb(&b, 1);
			int cs = rb(&b, 3);
			if (cs != 7) {
				rb(&b, 1);
				if (profile == 1 || profile == 3)
					rb(&b, 3);
			} else if (profile == 1 || profile == 3)
				rb(&b, 1);
		}
	}
	h->refresh = rb(&b, 8);
}

/* the frames of a superframe (or the one frame) */
static int split(const uint8_t *p, size_t n, size_t off[8], size_t len[8])
{
	uint8_t m = n ? p[n - 1] : 0;
	if ((m & 0xe0) == 0xc0) {
		int frames = (m & 7) + 1, mag = ((m >> 3) & 3) + 1;
		size_t idx = 2 + (size_t)mag * frames;
		if (n >= idx && p[n - idx] == m) {
			size_t o = 0;
			const uint8_t *q = p + n - idx + 1;
			for (int i = 0; i < frames; i++) {
				size_t s = 0;
				for (int j = 0; j < mag; j++)
					s |= (size_t)*q++ << (8 * j);
				off[i] = o;
				len[i] = s;
				o += s;
			}
			if (o <= n - idx)
				return frames;
		}
	}
	off[0] = 0;
	len[0] = n;
	return 1;
}

static double now(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec + t.tv_nsec / 1e9;
}

#define CHECK(x)                                                                      \
	do {                                                                          \
		VAStatus st_ = (x);                                                   \
		if (st_ != VA_STATUS_SUCCESS) {                                       \
			fprintf(stderr, "va-decode: %s: status %d (line %d)\n", #x, st_, __LINE__); \
			exit(1);                                                      \
		}                                                                     \
	} while (0)

#include "va-export.h"

#define NSURF 12

int main(int argc, char **argv)
{
	const char *drvpath = "/usr/lib/aarch64-linux-gnu/dri/kw_drv_video.so", *file = NULL;
	long maxframes = -1;
	int quiet = 0, exp = 0;
	const char *rdev = NULL;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "-d") && i + 1 < argc)
			drvpath = argv[++i];
		else if (!strcmp(argv[i], "-n") && i + 1 < argc)
			maxframes = atol(argv[++i]);
		else if (!strcmp(argv[i], "-q"))
			quiet = 1;
		else if (!strcmp(argv[i], "-e") || !strcmp(argv[i], "-E"))
			exp = argv[i][1] == 'E' ? 2 : 1;
		else if (!strcmp(argv[i], "-r") && i + 1 < argc)
			rdev = argv[++i];
		else
			file = argv[i];
	}
	if (!file) {
		fprintf(stderr, "usage: va-decode [-d DRIVER.so] [-n FRAMES] [-q] [-e | -E] [-r DEVICE] FILE.ivf\n");
		return 2;
	}
	FILE *f = fopen(file, "rb");
	uint8_t hdr[32];
	if (!f || fread(hdr, 1, 32, f) != 32 || memcmp(hdr, "DKIF", 4) || memcmp(hdr + 8, "VP90", 4)) {
		fprintf(stderr, "va-decode: %s is not a VP9 IVF file\n", file);
		return 2;
	}
	int w = hdr[12] | hdr[13] << 8, h = hdr[14] | hdr[15] << 8;

	void *so = dlopen(drvpath, RTLD_NOW | RTLD_LOCAL);
	if (!so) {
		fprintf(stderr, "va-decode: %s\n", dlerror());
		return 2;
	}
	char name[64];
	snprintf(name, sizeof name, "__vaDriverInit_%d_%d", VA_MAJOR_VERSION, VA_MINOR_VERSION);
	VAStatus (*init)(VADriverContextP) = (VAStatus(*)(VADriverContextP))dlsym(so, name);
	if (!init) {
		fprintf(stderr, "va-decode: %s has no %s\n", drvpath, name);
		return 2;
	}
	struct VADriverContext c = {0};
	struct drm_state ds = {.fd = -1};
	c.vtable = calloc(1, sizeof *c.vtable);
	if (exp && !rdev)
		rdev = "/dev/dri/renderD128";
	if (rdev) {
		/* as libva's DRM display: the driver finds the device through it */
		if ((ds.fd = open(rdev, O_RDWR | O_CLOEXEC)) < 0) {
			perror(rdev);
			return 2;
		}
		ds.auth_type = VA_DRM_AUTH_CUSTOM;
		c.drm_state = &ds;
		c.display_type = VA_DISPLAY_DRM_RENDERNODES;
	}
	CHECK(init(&c));
	if (exp)
		exp_init(exp == 2);
	struct VADriverVTable *vt = c.vtable;
	printf("vendor: %s\n", c.str_vendor);
	VAProfile profiles[16];
	int np = 0;
	CHECK(vt->vaQueryConfigProfiles(&c, profiles, &np));
	int vp9 = 0;
	for (int i = 0; i < np; i++)
		vp9 |= profiles[i] == VAProfileVP9Profile0;
	printf("profiles: %d%s\n", np, vp9 ? " (VP9 profile 0)" : "");
	if (!vp9)
		return 1;
	VAConfigAttrib rt = {VAConfigAttribRTFormat, VA_RT_FORMAT_YUV420};
	VAConfigID cfg;
	CHECK(vt->vaCreateConfig(&c, VAProfileVP9Profile0, VAEntrypointVLD, &rt, 1, &cfg));
	VASurfaceAttrib sa = {.type = VASurfaceAttribPixelFormat, .flags = VA_SURFACE_ATTRIB_SETTABLE,
			      .value = {.type = VAGenericValueTypeInteger, .value.i = VA_FOURCC_NV12}};
	VASurfaceID surf[NSURF];
	CHECK(vt->vaCreateSurfaces2(&c, VA_RT_FORMAT_YUV420, w, h, surf, NSURF, &sa, 1));
	VAContextID vctx;
	CHECK(vt->vaCreateContext(&c, cfg, w, h, VA_PROGRESSIVE, surf, NSURF, &vctx));
	VAImageFormat fmt = {.fourcc = VA_FOURCC_NV12};
	VAImage gimg;
	CHECK(vt->vaCreateImage(&c, &fmt, w, h, &gimg));

	int slot[8];
	for (int i = 0; i < 8; i++)
		slot[i] = -1;
	int next = 0, shown = 0, pictures = 0, fails = 0;
	size_t cap = 0, bytes = 0;
	uint8_t *buf = NULL, *i420 = malloc((size_t)w * h * 2);
	double t0 = now();
	uint8_t fh[12];
	while ((maxframes < 0 || shown < maxframes) && fread(fh, 1, 12, f) == 12) {
		size_t n = fh[0] | fh[1] << 8 | fh[2] << 16 | (size_t)fh[3] << 24;
		if (n > cap && !(buf = realloc(buf, cap = n)))
			return 1;
		if (fread(buf, 1, n, f) != n)
			break;
		bytes += n;
		size_t off[8], len[8];
		int nf = split(buf, n, off, len);
		for (int k = 0; k < nf; k++) {
			struct vp9hdr vh;
			vp9_header(buf + off[k], len[k], &vh);
			int out = -1;
			if (vh.show_existing)
				out = slot[vh.idx];
			else {
				/* a surface no reference slot holds */
				int s = -1;
				for (int tries = 0; tries < NSURF && s < 0; tries++) {
					int cand = (next + tries) % NSURF, used = 0;
					for (int i = 0; i < 8; i++)
						used |= slot[i] == cand;
					if (!used)
						s = cand;
				}
				next = (s + 1) % NSURF;
				VADecPictureParameterBufferVP9 pp = {.frame_width = w, .frame_height = h};
				pp.pic_fields.bits.frame_type = !vh.key;
				pp.pic_fields.bits.show_frame = vh.show;
				VASliceParameterBufferVP9 sp = {.slice_data_size = len[k], .slice_data_offset = 0,
								.slice_data_flag = VA_SLICE_DATA_FLAG_ALL};
				VABufferID bufs[3];
				CHECK(vt->vaCreateBuffer(&c, vctx, VAPictureParameterBufferType, sizeof pp, 1, &pp, &bufs[0]));
				CHECK(vt->vaCreateBuffer(&c, vctx, VASliceParameterBufferType, sizeof sp, 1, &sp, &bufs[1]));
				CHECK(vt->vaCreateBuffer(&c, vctx, VASliceDataBufferType, len[k], 1, buf + off[k], &bufs[2]));
				CHECK(vt->vaBeginPicture(&c, vctx, surf[s]));
				CHECK(vt->vaRenderPicture(&c, vctx, bufs, 3));
				CHECK(vt->vaEndPicture(&c, vctx));
				for (int i = 0; i < 3; i++)
					CHECK(vt->vaDestroyBuffer(&c, bufs[i]));
				pictures++;
				for (int i = 0; i < 8; i++)
					if (vh.refresh >> i & 1)
						slot[i] = s;
				if (vh.show)
					out = s;
			}
			if (out < 0)
				continue;
			char note[200] = "";
			VAStatus est = exp ? exp_export(vt, &c, surf[out]) : VA_STATUS_SUCCESS;
			if (est != VA_STATUS_SUCCESS)
				snprintf(note, sizeof note, " export: status %d", est);
			/* the readback, as ffmpeg's hwdownload: sync, then a derived image or vaGetImage */
			VAStatus st = vt->vaSyncSurface(&c, surf[out]);
			const uint8_t *py = NULL, *puv = NULL;
			VAImage dimg;
			void *map = NULL;
			int derived = shown % 2 == 0;
			if (st == VA_STATUS_SUCCESS) {
				if (derived) {
					CHECK(vt->vaDeriveImage(&c, surf[out], &dimg));
					st = vt->vaMapBuffer(&c, dimg.buf, &map);
				} else {
					st = vt->vaGetImage(&c, surf[out], 0, 0, w, h, gimg.image_id);
					if (st == VA_STATUS_SUCCESS)
						st = vt->vaMapBuffer(&c, gimg.buf, &map);
					dimg = gimg;
				}
			}
			char hex[33] = "-";
			if (st == VA_STATUS_SUCCESS) {
				py = (uint8_t *)map + dimg.offsets[0];
				puv = (uint8_t *)map + dimg.offsets[1];
				int cw = (w + 1) / 2, ch = (h + 1) / 2;
				uint8_t *o = i420;
				for (int y = 0; y < h; y++, o += w)
					memcpy(o, py + (size_t)y * dimg.pitches[0], w);
				uint8_t *u = o, *v = o + (size_t)cw * ch;
				for (int y = 0; y < ch; y++)
					for (int x = 0; x < cw; x++) {
						u[y * cw + x] = puv[(size_t)y * dimg.pitches[1] + 2 * x];
						v[y * cw + x] = puv[(size_t)y * dimg.pitches[1] + 2 * x + 1];
					}
				struct md5 m;
				md5_init(&m);
				md5_put(&m, i420, (size_t)w * h + 2 * (size_t)cw * ch);
				md5_hex(&m, hex);
				vt->vaUnmapBuffer(&c, dimg.buf);
				if (exp && (est != VA_STATUS_SUCCESS || exp_frame(vt, &c, surf[out], i420, w, h, note, sizeof note)))
					fails++;
			} else
				fails++;
			if (derived && map)
				vt->vaDestroyImage(&c, dimg.image_id);
			shown++;
			if (!quiet)
				printf("%s  frame-%04d%s%s%s\n", hex, shown, vh.show_existing ? " (show_existing)" : "", derived ? " derived" : " getimage", note);
		}
	}
	double dt = now() - t0;
	printf("%d frames shown (%d pictures decoded, %zu bytes), %dx%d, %.2f s: %.1f frames/s; %d failed\n", shown, pictures, bytes, w, h, dt,
	       shown / dt, fails);
	exp_summary();
	vt->vaDestroyImage(&c, gimg.image_id);
	vt->vaDestroyContext(&c, vctx);
	vt->vaDestroySurfaces(&c, surf, NSURF);
	vt->vaDestroyConfig(&c, cfg);
	vt->vaTerminate(&c);
	return fails || !shown ? 1 : 0;
}
