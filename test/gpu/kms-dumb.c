// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A dumb-buffer KMS client for the guest, with raw ioctls (no libdrm), for
 * test/gpu/check.mjs:
 *
 *   kms-dumb [DEVICE] [SECONDS] [CPU]      (default /dev/dri/card0, 5, any)
 *
 * It prints the driver's name and version (DRM_IOCTL_VERSION, what
 * drmGetVersion() asks), takes the first connected connector's first mode
 * (virtio_gpu marks the host's size preferred and lists it first), fills a
 * dumb buffer with glimmer's test pattern (guest/src/glimmer.c
 * test_pixel(), the same picture test/glimmer-check.mjs checks), puts it on
 * the CRTC with SETCRTC, and then paints a 64x64 white square at (16, 16)
 * of the picture, made known with DIRTYFB (a damage clip, which virtio_gpu
 * transfers alone). It
 * prints one line per step, "kms-dumb: ready WxH" when the
 * picture is complete, holds the CRTC for SECONDS and exits (which removes
 * the framebuffer and turns the CRTC off). With CPU it first moves itself
 * there (sched_setaffinity), so that on an SMP kernel its ioctls run on that
 * CPU. Exit status 0 on success.
 */
#define _GNU_SOURCE
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define SQ_X 16
#define SQ_Y 16
#define SQ 64

static uint32_t test_pixel(unsigned x, unsigned y, unsigned w, unsigned h)
{
	static const uint32_t bars[8] = { 0xffffff, 0xffff00, 0x00ffff, 0x00ff00, 0xff00ff, 0xff0000, 0x0000ff, 0x000000 };
	if (x >= w || y >= h)
		return 0;
	if (x == 0 || y == 0 || x == w - 1 || y == h - 1)
		return 0xffffff;
	if (x < 9 && y < 9)
		return 0xff0000;
	if (x >= w - 9 && y < 9)
		return 0x00ff00;
	if (x < 9 && y >= h - 9)
		return 0x0000ff;
	if (x >= w - 9 && y >= h - 9)
		return 0xffff00;
	if (y < h / 4)
		return bars[x * 8 / w];
	if (y < h / 2)
		return x * 255 / (w - 1) * 0x010101u;
	if (y < h * 3 / 4)
		return (x / 8 + y / 8) & 1 ? 0xff8000 : 0x000040;
	unsigned v = y * 255 / (h - 1);
	return v << 8 | (255 - v);
}

static int xioctl(int fd, unsigned long req, void *arg, const char *what)
{
	int r;

	do
		r = ioctl(fd, req, arg);
	while (r < 0 && (errno == EINTR || errno == EAGAIN));
	if (r < 0)
		printf("kms-dumb: %s FAILED: %s\n", what, strerror(errno));
	return r;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/card0";
	unsigned hold = argc > 2 ? (unsigned)atoi(argv[2]) : 5;
	char name[64] = "", date[64] = "", desc[128] = "";
	struct drm_version ver = {
		.name = name, .name_len = sizeof(name) - 1,
		.date = date, .date_len = sizeof(date) - 1,
		.desc = desc, .desc_len = sizeof(desc) - 1,
	};
	struct drm_mode_card_res res = { 0 };
	uint32_t crtcs[8], conns[8];
	struct drm_mode_get_connector conn;
	struct drm_mode_modeinfo modes[32], mode;
	struct drm_mode_create_dumb cd = { 0 };
	struct drm_mode_map_dumb md = { 0 };
	struct drm_mode_fb_cmd fb = { 0 };
	struct drm_mode_crtc crtc = { 0 };
	struct drm_clip_rect clip;
	struct drm_mode_fb_dirty_cmd dirty = { 0 };
	uint32_t conn_id = 0, *px;
	unsigned i, x, y, w, h, stride;
	int fd;

	if (argc > 3) {
		cpu_set_t set;

		CPU_ZERO(&set);
		CPU_SET(atoi(argv[3]), &set);
		if (sched_setaffinity(0, sizeof(set), &set)) {
			printf("kms-dumb: sched_setaffinity FAILED: %s\n", strerror(errno));
			return 1;
		}
		printf("kms-dumb: on cpu %d\n", sched_getcpu());
	}
	fd = open(dev, O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		printf("kms-dumb: open %s FAILED: %s\n", dev, strerror(errno));
		return 1;
	}
	if (xioctl(fd, DRM_IOCTL_VERSION, &ver, "DRM_IOCTL_VERSION"))
		return 1;
	printf("kms-dumb: driver %s %d.%d.%d (%s, %s)\n", name, ver.version_major, ver.version_minor,
	       ver.version_patchlevel, desc, date);

	if (xioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &res, "GETRESOURCES"))
		return 1;
	if (!res.count_crtcs || !res.count_connectors || res.count_crtcs > 8 || res.count_connectors > 8) {
		printf("kms-dumb: %u crtcs, %u connectors FAILED\n", res.count_crtcs, res.count_connectors);
		return 1;
	}
	res.crtc_id_ptr = (uintptr_t)crtcs;
	res.connector_id_ptr = (uintptr_t)conns;
	res.count_fbs = res.count_encoders = 0;
	if (xioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &res, "GETRESOURCES"))
		return 1;
	printf("kms-dumb: %u crtcs, %u connectors, max %ux%u\n", res.count_crtcs, res.count_connectors,
	       res.max_width, res.max_height);

	for (i = 0; i < res.count_connectors && !conn_id; i++) {
		memset(&conn, 0, sizeof(conn));
		conn.connector_id = conns[i];
		if (xioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &conn, "GETCONNECTOR"))
			return 1;
		if (conn.connection != 1 || !conn.count_modes)
			continue;
		if (conn.count_modes > 32)
			conn.count_modes = 32;
		conn.modes_ptr = (uintptr_t)modes;
		conn.count_props = conn.count_encoders = 0;
		if (xioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &conn, "GETCONNECTOR"))
			return 1;
		conn_id = conn.connector_id;
		mode = modes[0];
		printf("kms-dumb: connector %u: %u modes, first %s (%ux%u), %ux%u mm\n", conn_id, conn.count_modes,
		       mode.name, mode.hdisplay, mode.vdisplay, conn.mm_width, conn.mm_height);
	}
	if (!conn_id) {
		printf("kms-dumb: no connected connector FAILED\n");
		return 1;
	}
	w = mode.hdisplay;
	h = mode.vdisplay;

	cd.width = w;
	cd.height = h;
	cd.bpp = 32;
	if (xioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd, "CREATE_DUMB"))
		return 1;
	md.handle = cd.handle;
	if (xioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &md, "MAP_DUMB"))
		return 1;
	px = mmap(NULL, cd.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, md.offset);
	if (px == MAP_FAILED) {
		printf("kms-dumb: mmap FAILED: %s\n", strerror(errno));
		return 1;
	}
	stride = cd.pitch / 4;
	for (y = 0; y < h; y++)
		for (x = 0; x < w; x++)
			px[y * stride + x] = test_pixel(x, y, w, h);
	printf("kms-dumb: dumb buffer %ux%u, pitch %u, %llu bytes, drawn\n", w, h, cd.pitch,
	       (unsigned long long)cd.size);

	fb.width = w;
	fb.height = h;
	fb.pitch = cd.pitch;
	fb.bpp = 32;
	fb.depth = 24;
	fb.handle = cd.handle;
	if (xioctl(fd, DRM_IOCTL_MODE_ADDFB, &fb, "ADDFB"))
		return 1;
	crtc.crtc_id = crtcs[0];
	crtc.fb_id = fb.fb_id;
	crtc.set_connectors_ptr = (uintptr_t)&conn_id;
	crtc.count_connectors = 1;
	crtc.mode = mode;
	crtc.mode_valid = 1;
	if (xioctl(fd, DRM_IOCTL_MODE_SETCRTC, &crtc, "SETCRTC"))
		return 1;
	printf("kms-dumb: crtc %u shows fb %u\n", crtc.crtc_id, fb.fb_id);

	/* A changed rectangle after the modeset: only DIRTYFB makes it known. */
	for (y = SQ_Y; y < SQ_Y + SQ && y < h; y++)
		for (x = SQ_X; x < SQ_X + SQ && x < w; x++)
			px[y * stride + x] = 0xffffff;
	clip.x1 = SQ_X;
	clip.y1 = SQ_Y;
	clip.x2 = SQ_X + SQ;
	clip.y2 = SQ_Y + SQ;
	dirty.fb_id = fb.fb_id;
	dirty.num_clips = 1;
	dirty.clips_ptr = (uintptr_t)&clip;
	if (xioctl(fd, DRM_IOCTL_MODE_DIRTYFB, &dirty, "DIRTYFB"))
		return 1;
	printf("kms-dumb: ready %ux%u\n", w, h);
	fflush(stdout);
	sleep(hold);
	printf("kms-dumb: done\n");
	return 0;
}
