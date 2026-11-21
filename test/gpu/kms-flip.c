// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A page-flipping KMS client for the guest, with raw ioctls (no libdrm):
 *
 *   kms-flip [DEVICE] [FLIPS] [DIRTY]    (default /dev/dri/card0, 120, 0)
 *
 * It takes the first connected connector's first mode, puts one of two
 * dumb buffers on the CRTC with SETCRTC and then flips between them FLIPS
 * times with DRM_IOCTL_MODE_PAGE_FLIP and DRM_MODE_PAGE_FLIP_EVENT, each
 * flip asked for as soon as the previous one's event has been read, as a
 * client that renders nothing would. It prints the mode's refresh rate,
 * the flips per second (CLOCK_MONOTONIC), the intervals between events as
 * the client saw them and as the events' timestamps say, and the vblank
 * sequence numbers the events carried. With DIRTY > 0 it also runs DIRTY
 * DIRTYFB calls of a 64x64 rectangle on the shown buffer, timed the same
 * way (no events: each returns when the driver has queued the update).
 * Exit status 0 on success.
 */
#define _GNU_SOURCE
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static int xioctl(int fd, unsigned long req, void *arg, const char *what)
{
	int r;

	do
		r = ioctl(fd, req, arg);
	while (r < 0 && (errno == EINTR || errno == EAGAIN));
	if (r < 0)
		printf("kms-flip: %s FAILED: %s\n", what, strerror(errno));
	return r;
}

static double now(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void stats(const char *what, const double *v, unsigned n)
{
	double min = 1e9, max = 0, sum = 0;
	unsigned i;

	for (i = 0; i < n; i++) {
		sum += v[i];
		if (v[i] < min)
			min = v[i];
		if (v[i] > max)
			max = v[i];
	}
	printf("kms-flip: %s: avg %.2f ms, min %.2f, max %.2f (%u)\n", what, n ? sum / n * 1e3 : 0,
	       n ? min * 1e3 : 0, max * 1e3, n);
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/card0";
	unsigned flips = argc > 2 ? (unsigned)atoi(argv[2]) : 120;
	unsigned dirties = argc > 3 ? (unsigned)atoi(argv[3]) : 0;
	struct drm_mode_card_res res = { 0 };
	uint32_t crtcs[8], conns[8], fbs[2], conn_id = 0;
	struct drm_mode_get_connector conn;
	struct drm_mode_modeinfo modes[32], mode;
	struct drm_mode_crtc crtc = { 0 };
	double *wall, *stamp, t0, t1, prev_wall = 0, prev_stamp = 0;
	unsigned i, b, seq_first = 0, seq_last = 0, seq_skips = 0, prev_seq = 0;
	int fd;

	fd = open(dev, O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		printf("kms-flip: open %s FAILED: %s\n", dev, strerror(errno));
		return 1;
	}
	if (xioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &res, "GETRESOURCES"))
		return 1;
	if (!res.count_crtcs || !res.count_connectors || res.count_crtcs > 8 || res.count_connectors > 8)
		return 1;
	res.crtc_id_ptr = (uintptr_t)crtcs;
	res.connector_id_ptr = (uintptr_t)conns;
	res.count_fbs = res.count_encoders = 0;
	if (xioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &res, "GETRESOURCES"))
		return 1;
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
	}
	if (!conn_id) {
		printf("kms-flip: no connected connector FAILED\n");
		return 1;
	}
	printf("kms-flip: mode %s, %u Hz (clock %u kHz, htotal %u, vtotal %u)\n", mode.name, mode.vrefresh,
	       mode.clock, mode.htotal, mode.vtotal);

	for (b = 0; b < 2; b++) {
		struct drm_mode_create_dumb cd = { .width = mode.hdisplay, .height = mode.vdisplay, .bpp = 32 };
		struct drm_mode_map_dumb md = { 0 };
		struct drm_mode_fb_cmd fb = { 0 };
		uint32_t *px;

		if (xioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd, "CREATE_DUMB"))
			return 1;
		md.handle = cd.handle;
		if (xioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &md, "MAP_DUMB"))
			return 1;
		px = mmap(NULL, cd.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, md.offset);
		if (px == MAP_FAILED)
			return 1;
		for (i = 0; i < cd.size / 4; i++)
			px[i] = b ? 0x0000c0 : 0xc00000;
		fb.width = mode.hdisplay;
		fb.height = mode.vdisplay;
		fb.pitch = cd.pitch;
		fb.bpp = 32;
		fb.depth = 24;
		fb.handle = cd.handle;
		if (xioctl(fd, DRM_IOCTL_MODE_ADDFB, &fb, "ADDFB"))
			return 1;
		fbs[b] = fb.fb_id;
	}
	crtc.crtc_id = crtcs[0];
	crtc.fb_id = fbs[0];
	crtc.set_connectors_ptr = (uintptr_t)&conn_id;
	crtc.count_connectors = 1;
	crtc.mode = mode;
	crtc.mode_valid = 1;
	if (xioctl(fd, DRM_IOCTL_MODE_SETCRTC, &crtc, "SETCRTC"))
		return 1;

	wall = calloc(flips + 1, sizeof(*wall));
	stamp = calloc(flips + 1, sizeof(*stamp));
	t0 = now();
	for (i = 0; i < flips; i++) {
		struct drm_mode_crtc_page_flip flip = {
			.crtc_id = crtcs[0], .fb_id = fbs[(i + 1) & 1],
			.flags = DRM_MODE_PAGE_FLIP_EVENT, .user_data = i,
		};
		char buf[256];
		struct drm_event_vblank *ev = (void *)buf;
		ssize_t n;
		double w, s;

		if (xioctl(fd, DRM_IOCTL_MODE_PAGE_FLIP, &flip, "PAGE_FLIP"))
			return 1;
		do
			n = read(fd, buf, sizeof(buf));
		while (n < 0 && errno == EINTR);
		if (n < (ssize_t)sizeof(*ev) || ev->base.type != DRM_EVENT_FLIP_COMPLETE || ev->user_data != i) {
			printf("kms-flip: read event FAILED (%zd, type %u)\n", n, n > 0 ? ev->base.type : 0);
			return 1;
		}
		w = now();
		s = ev->tv_sec + ev->tv_usec / 1e6;
		if (i) {
			wall[i - 1] = w - prev_wall;
			stamp[i - 1] = s - prev_stamp;
			if (ev->sequence != prev_seq + 1)
				seq_skips++;
		} else {
			seq_first = ev->sequence;
		}
		prev_wall = w;
		prev_stamp = s;
		prev_seq = seq_last = ev->sequence;
	}
	t1 = now();
	printf("kms-flip: %u flips in %.3f s: %.1f flips/s\n", flips, t1 - t0, flips / (t1 - t0));
	stats("event to event (client)", wall, flips - 1);
	stats("event to event (timestamps)", stamp, flips - 1);
	printf("kms-flip: sequence %u..%u (%u vblanks for %u flips, %u not consecutive)\n", seq_first, seq_last,
	       seq_last - seq_first, flips - 1, seq_skips);

	if (dirties) {
		struct drm_clip_rect clip = { 16, 16, 80, 80 };
		struct drm_mode_fb_dirty_cmd dirty = {
			.fb_id = fbs[flips & 1], .num_clips = 1, .clips_ptr = (uintptr_t)&clip,
		};

		t0 = prev_wall = now();
		for (i = 0; i < dirties; i++) {
			double w;

			if (xioctl(fd, DRM_IOCTL_MODE_DIRTYFB, &dirty, "DIRTYFB"))
				return 1;
			w = now();
			wall[i] = w - prev_wall;
			prev_wall = w;
		}
		t1 = now();
		printf("kms-flip: %u dirtyfb in %.3f s: %.1f/s\n", dirties, t1 - t0, dirties / (t1 - t0));
		stats("dirtyfb to dirtyfb", wall, dirties);
	}
	printf("kms-flip: done\n");
	return 0;
}
