// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// va-encode: kwva's VP9 encode driven through the driver's vtable, without
// libva or a display (a test program for va/build.sh's guest and native
// builds): dlopens the driver, encodes FRAMES frames of a moving test
// pattern as ffmpeg's vp9_vaapi does (CQP or a bitrate, a key frame every
// GOP frames, P frames referring to the last, vaSyncBuffer, the coded
// buffer's segments) and writes them as IVF. The pattern reaches the input
// surfaces by vaPutImage (-m put), through a derived image mapped for
// writing (-m derive, ffmpeg's hwupload) or not at all after the first
// frame of each surface (-m same: unchanged surfaces, which the host keeps);
// -s FILE also writes the pattern as raw I420 (to compare a decode of the
// IVF with). Prints the frames per second and the time spent writing
// pixels and in vaEndPicture.
//
//   va-encode [-d DRIVER.so] [-w W] [-h H] [-n FRAMES] [-g GOP] [-b BPS | -q QINDEX] [-m put|derive|same] [-S SURFACES] [-s RAW] OUT.ivf
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <va/va.h>
#include <va/va_backend.h>
#include <va/va_backend_vpp.h>
#include <va/va_enc_vp9.h>

static double now(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec + t.tv_nsec / 1e9;
}

#define CHECK(x)                                                                                    \
	do {                                                                                        \
		VAStatus st_ = (x);                                                                 \
		if (st_ != VA_STATUS_SUCCESS) {                                                     \
			fprintf(stderr, "va-encode: %s: status %#x (line %d)\n", #x, st_, __LINE__); \
			exit(1);                                                                    \
		}                                                                                   \
	} while (0)

/* the test pattern of frame n into NV12 rows (pitch, chroma at uv) */
static void pattern(uint8_t *y, uint8_t *uv, uint32_t py, uint32_t puv, int w, int h, int n)
{
	for (int r = 0; r < h; r++)
		for (int x = 0; x < w; x++)
			y[(size_t)r * py + x] = (uint8_t)(((x >> 2) + (r >> 2) + 3 * n) & 0xff) ^ (((x / 64 + r / 64 + n / 8) & 1) ? 0x40 : 0);
	for (int r = 0; r < (h + 1) / 2; r++)
		for (int x = 0; x < (w + 1) / 2; x++) {
			uv[(size_t)r * puv + 2 * x] = (uint8_t)(128 + ((x + n) & 63) - 32);
			uv[(size_t)r * puv + 2 * x + 1] = (uint8_t)(128 + ((r - n) & 63) - 32);
		}
}

static void le32(uint8_t *p, uint32_t v)
{
	for (int i = 0; i < 4; i++)
		p[i] = (uint8_t)(v >> (8 * i));
}

int main(int argc, char **argv)
{
	const char *drvpath = "/usr/lib/aarch64-linux-gnu/dri/kw_drv_video.so", *raw = NULL, *mode = "derive";
	int w = 640, h = 360, frames = 60, gop = 30, nsurf = 4, qindex = 100;
	unsigned bps = 0;
	int o;
	while ((o = getopt(argc, argv, "d:w:h:n:g:b:q:m:S:s:")) != -1) {
		switch (o) {
		case 'd': drvpath = optarg; break;
		case 'w': w = atoi(optarg); break;
		case 'h': h = atoi(optarg); break;
		case 'n': frames = atoi(optarg); break;
		case 'g': gop = atoi(optarg); break;
		case 'b': bps = (unsigned)atoi(optarg); break;
		case 'q': qindex = atoi(optarg); break;
		case 'm': mode = optarg; break;
		case 'S': nsurf = atoi(optarg); break;
		case 's': raw = optarg; break;
		default: goto usage;
		}
	}
	if (optind + 1 != argc || w <= 0 || h <= 0 || frames <= 0 || nsurf <= 0 || nsurf > 16 || (strcmp(mode, "put") && strcmp(mode, "derive") && strcmp(mode, "same"))) {
	usage:
		fprintf(stderr, "usage: va-encode [-d DRIVER.so] [-w W] [-h H] [-n FRAMES] [-g GOP] [-b BPS | -q QINDEX] [-m put|derive|same] [-S SURFACES] [-s RAW] OUT.ivf\n");
		return 2;
	}
	void *so = dlopen(drvpath, RTLD_NOW | RTLD_LOCAL);
	if (!so) {
		fprintf(stderr, "va-encode: %s\n", dlerror());
		return 1;
	}
	char name[64];
	snprintf(name, sizeof name, "__vaDriverInit_%d_%d", VA_MAJOR_VERSION, VA_MINOR_VERSION);
	VAStatus (*init)(VADriverContextP) = (VAStatus(*)(VADriverContextP))dlsym(so, name);
	if (!init) {
		fprintf(stderr, "va-encode: no %s in %s\n", name, drvpath);
		return 1;
	}
	struct VADriverContext c = {0};
	c.vtable = calloc(1, sizeof *c.vtable);
	c.vtable_vpp = calloc(1, sizeof *c.vtable_vpp);
	CHECK(init(&c));
	struct VADriverVTable *vt = c.vtable;
	VADriverContextP ctx = &c;
	/* the config: CQP, or VBR at bps (as ffmpeg asks: the maximum twice the target, 50%) */
	VAConfigAttrib rc = {.type = VAConfigAttribRateControl, .value = bps ? VA_RC_VBR : VA_RC_CQP};
	VAConfigID cfg;
	CHECK(vt->vaCreateConfig(ctx, VAProfileVP9Profile0, VAEntrypointEncSlice, &rc, 1, &cfg));
	int sw = (w + 63) & ~63, sh = (h + 63) & ~63;
	VASurfaceID in[16], recon[4];
	CHECK(vt->vaCreateSurfaces2(ctx, VA_RT_FORMAT_YUV420, w, h, in, nsurf, NULL, 0));
	CHECK(vt->vaCreateSurfaces2(ctx, VA_RT_FORMAT_YUV420, sw, sh, recon, 4, NULL, 0));
	VAContextID vctx;
	CHECK(vt->vaCreateContext(ctx, cfg, sw, sh, VA_PROGRESSIVE, recon, 4, &vctx));
	VABufferID coded[2];
	for (int i = 0; i < 2; i++)
		CHECK(vt->vaCreateBuffer(ctx, vctx, VAEncCodedBufferType, 3 * sw * sh + (1 << 16), 1, NULL, &coded[i]));
	VAImageFormat nv12 = {.fourcc = VA_FOURCC_NV12, .byte_order = VA_LSB_FIRST, .bits_per_pixel = 12};
	VAImage img;
	CHECK(vt->vaCreateImage(ctx, &nv12, w, h, &img));
	FILE *out = fopen(argv[optind], "wb"), *rawf = raw ? fopen(raw, "wb") : NULL;
	if (!out || (raw && !rawf)) {
		perror("va-encode: open");
		return 1;
	}
	uint8_t hdr[32] = "DKIF";
	hdr[4] = 0, hdr[5] = 0, hdr[6] = 32, hdr[7] = 0;
	memcpy(hdr + 8, "VP90", 4);
	hdr[12] = (uint8_t)w, hdr[13] = (uint8_t)(w >> 8), hdr[14] = (uint8_t)h, hdr[15] = (uint8_t)(h >> 8);
	le32(hdr + 16, 30), le32(hdr + 20, 1), le32(hdr + 24, (uint32_t)frames);
	fwrite(hdr, 1, 32, out);
	uint8_t *tmp = malloc((size_t)w * h * 3 / 2 + w + h + 4);
	double t0 = now(), tpix = 0, tend = 0, tsync = 0;
	size_t bytes = 0;
	int keys = 0;
	for (int n = 0; n < frames; n++) {
		VASurfaceID s = in[n % nsurf];
		/* the input's pixels */
		double tp = now();
		if (!strcmp(mode, "put")) {
			void *p;
			CHECK(vt->vaMapBuffer(ctx, img.buf, &p));
			pattern((uint8_t *)p + img.offsets[0], (uint8_t *)p + img.offsets[1], img.pitches[0], img.pitches[1], w, h, n);
			CHECK(vt->vaUnmapBuffer(ctx, img.buf));
			CHECK(vt->vaPutImage(ctx, s, img.image_id, 0, 0, w, h, 0, 0, w, h));
		} else if (!strcmp(mode, "derive") || n < nsurf) {
			VAImage di;
			void *p;
			CHECK(vt->vaDeriveImage(ctx, s, &di));
			if (vt->vaMapBuffer2)
				CHECK(vt->vaMapBuffer2(ctx, di.buf, &p, VA_MAPBUFFER_FLAG_WRITE));
			else
				CHECK(vt->vaMapBuffer(ctx, di.buf, &p));
			pattern((uint8_t *)p + di.offsets[0], (uint8_t *)p + di.offsets[1], di.pitches[0], di.pitches[1], w, h, n);
			CHECK(vt->vaUnmapBuffer(ctx, di.buf));
			CHECK(vt->vaDestroyImage(ctx, di.image_id));
		}
		tpix += now() - tp;
		if (rawf) {
			/* what the surface holds: frame n, or (same) the frame that first went into it */
			int m = !strcmp(mode, "same") && n >= nsurf ? n % nsurf : n;
			pattern(tmp, tmp + (size_t)w * h, w, w, w, h, m);
			/* NV12 to I420 */
			int cw = (w + 1) / 2, ch = (h + 1) / 2;
			fwrite(tmp, 1, (size_t)w * h, rawf);
			for (int pl = 0; pl < 2; pl++)
				for (int r = 0; r < ch; r++)
					for (int x = 0; x < cw; x++)
						fputc(tmp[(size_t)w * h + (size_t)r * w + 2 * x + pl], rawf);
		}
		/* the picture as ffmpeg's vaapi_encode_vp9.c makes it: a key frame each GOP, else P referring to slot 0 */
		int key = n % gop == 0;
		VAEncSequenceParameterBufferVP9 seq = {.max_frame_width = w, .max_frame_height = h, .bits_per_second = bps, .intra_period = gop};
		VAEncPictureParameterBufferVP9 pp = {0};
		pp.frame_width_src = pp.frame_width_dst = w;
		pp.frame_height_src = pp.frame_height_dst = h;
		pp.reconstructed_frame = recon[n % 4];
		for (int i = 0; i < 8; i++)
			pp.reference_frames[i] = VA_INVALID_SURFACE;
		if (!key)
			pp.reference_frames[0] = recon[(n + 3) % 4];
		pp.coded_buf = coded[n % 2];
		pp.ref_flags.bits.force_kf = key;
		pp.ref_flags.bits.ref_frame_ctrl_l0 = key ? 0 : 1;
		pp.pic_flags.bits.frame_type = !key;
		pp.pic_flags.bits.show_frame = 1;
		pp.refresh_frame_flags = 0xff;
		pp.luma_ac_qindex = (uint8_t)qindex;
		pp.filter_level = 16;
		pp.sharpness_level = 4;
		/* VAEncMiscParameterBuffer: its type, then the parameters */
		struct {
			uint32_t type;
			VAEncMiscParameterRateControl rc;
		} mrc = {VAEncMiscParameterTypeRateControl, {.bits_per_second = 2 * bps, .target_percentage = 50, .window_size = 1000}};
		struct {
			uint32_t type;
			VAEncMiscParameterFrameRate fr;
		} mfr = {VAEncMiscParameterTypeFrameRate, {.framerate = 30}};
		VABufferID bufs[4];
		int nb = 0;
		if (key) {
			CHECK(vt->vaCreateBuffer(ctx, vctx, VAEncSequenceParameterBufferType, sizeof seq, 1, &seq, &bufs[nb++]));
			if (bps)
				CHECK(vt->vaCreateBuffer(ctx, vctx, VAEncMiscParameterBufferType, sizeof mrc, 1, &mrc, &bufs[nb++]));
			CHECK(vt->vaCreateBuffer(ctx, vctx, VAEncMiscParameterBufferType, sizeof mfr, 1, &mfr, &bufs[nb++]));
		}
		CHECK(vt->vaCreateBuffer(ctx, vctx, VAEncPictureParameterBufferType, sizeof pp, 1, &pp, &bufs[nb++]));
		double te = now();
		CHECK(vt->vaBeginPicture(ctx, vctx, s));
		CHECK(vt->vaRenderPicture(ctx, vctx, bufs, nb));
		CHECK(vt->vaEndPicture(ctx, vctx));
		tend += now() - te;
		for (int i = 0; i < nb; i++)
			vt->vaDestroyBuffer(ctx, bufs[i]);
		/* the coded buffer: synced, its segments as one IVF frame */
		double ts = now();
		CHECK(vt->vaSyncBuffer(ctx, pp.coded_buf, VA_TIMEOUT_INFINITE));
		tsync += now() - ts;
		VACodedBufferSegment *seg;
		CHECK(vt->vaMapBuffer(ctx, pp.coded_buf, (void **)&seg));
		size_t len = 0;
		for (VACodedBufferSegment *x = seg; x; x = x->next)
			len += x->size;
		uint8_t fh[12];
		le32(fh, (uint32_t)len), le32(fh + 4, (uint32_t)n), le32(fh + 8, 0);
		fwrite(fh, 1, 12, out);
		for (VACodedBufferSegment *x = seg; x; x = x->next)
			fwrite(x->buf, 1, x->size, out);
		/* a key frame: frame_marker 2, profile 0, show_existing 0, frame_type 0 */
		if (len && (((uint8_t *)seg->buf)[0] & 0xe4) == 0x80 && !(((uint8_t *)seg->buf)[0] & 0x04))
			keys++;
		CHECK(vt->vaUnmapBuffer(ctx, pp.coded_buf));
		bytes += len;
	}
	double t = now() - t0;
	printf("va-encode: %d frames %dx%d (%s, %d surfaces) in %.2f s: %.1f frames/s; %zu bytes (%.0f kbit/s at 30 fps), %d key frames; per frame: pixels %.2f ms, vaEndPicture %.2f ms, sync %.2f ms\n",
	       frames, w, h, mode, nsurf, t, frames / t, bytes, bytes * 8.0 * 30 / frames / 1000, keys, tpix * 1000 / frames, tend * 1000 / frames, tsync * 1000 / frames);
	fclose(out);
	if (rawf)
		fclose(rawf);
	vt->vaDestroyImage(ctx, img.image_id);
	vt->vaDestroyContext(ctx, vctx);
	vt->vaDestroySurfaces(ctx, in, nsurf);
	vt->vaDestroySurfaces(ctx, recon, 4);
	vt->vaDestroyConfig(ctx, cfg);
	vt->vaTerminate(ctx);
	return 0;
}
