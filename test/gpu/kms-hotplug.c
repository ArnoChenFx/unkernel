// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A KMS client that follows display hotplugs, with raw ioctls (no libdrm)
 * and the kernel's uevents read from netlink (there is no udev in the
 * guest), for test/gpu/check.mjs and by hand:
 *
 *   kms-hotplug [DEVICE] [SECONDS] [STEPS] [HOLD]   (default /dev/dri/card0, 30, "s", 0)
 *
 * It listens for uevents (NETLINK_KOBJECT_UEVENT, the kernel's group),
 * takes the first connected connector's preferred mode (virtio_gpu's EDID
 * mode, the host's display size), puts a dumb buffer with glimmer's test
 * pattern (guest/src/glimmer.c test_pixel(), as kms-dumb.c) on the CRTC
 * and prints "kms-hotplug: ready WxH". Then, for each letter of STEPS, it
 * waits for a drm uevent with HOTPLUG=1 (what virtio_gpu sends after the
 * host's display event), probes the connector again (GETCONNECTOR with no
 * modes, as the DRM master) and prints "kms-hotplug: hotplug N: preferred
 * WxH, M modes, WxH mm"; with "s" it also sets that mode on a new dumb
 * buffer with the pattern ("kms-hotplug: set WxH"), with "r" it only
 * reports and keeps the picture it has. After the last step it holds the
 * CRTC for HOLD seconds and exits ("kms-hotplug: done"); it fails when
 * SECONDS pass before the last hotplug. Exit status 0 on success.
 */
#define _GNU_SOURCE
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/netlink.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

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
		printf("kms-hotplug: %s FAILED: %s\n", what, strerror(errno));
	return r;
}

static int fd;
static uint32_t crtc_id, conn_id;

/* Probe the connector (count_modes 0: the master's GETCONNECTOR probes) and take its preferred mode. */
static int probe(struct drm_mode_modeinfo *mode, unsigned *count, unsigned *mm_w, unsigned *mm_h)
{
	struct drm_mode_modeinfo modes[64];
	struct drm_mode_get_connector conn;
	unsigned i;

	memset(&conn, 0, sizeof(conn));
	conn.connector_id = conn_id;
	if (xioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &conn, "GETCONNECTOR"))
		return -1;
	if (conn.connection != 1 || !conn.count_modes) {
		printf("kms-hotplug: connector %u: connection %u, %u modes FAILED\n", conn_id, conn.connection,
		       conn.count_modes);
		return -1;
	}
	if (conn.count_modes > 64)
		conn.count_modes = 64;
	conn.modes_ptr = (uintptr_t)modes;
	conn.count_props = conn.count_encoders = 0;
	if (xioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &conn, "GETCONNECTOR"))
		return -1;
	*mode = modes[0];
	for (i = 0; i < conn.count_modes; i++)
		if (modes[i].type & DRM_MODE_TYPE_PREFERRED) {
			*mode = modes[i];
			break;
		}
	*count = conn.count_modes;
	*mm_w = conn.mm_width;
	*mm_h = conn.mm_height;
	return 0;
}

/* A dumb buffer with the pattern at the mode's size on the CRTC; the previous framebuffer is removed. */
static int show(struct drm_mode_modeinfo *mode)
{
	static uint32_t old_fb, old_handle;
	struct drm_mode_create_dumb cd = { 0 };
	struct drm_mode_map_dumb md = { 0 };
	struct drm_mode_fb_cmd fb = { 0 };
	struct drm_mode_crtc crtc = { 0 };
	unsigned x, y, w = mode->hdisplay, h = mode->vdisplay, stride;
	uint32_t *px;

	cd.width = w;
	cd.height = h;
	cd.bpp = 32;
	if (xioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd, "CREATE_DUMB"))
		return -1;
	md.handle = cd.handle;
	if (xioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &md, "MAP_DUMB"))
		return -1;
	px = mmap(NULL, cd.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, md.offset);
	if (px == MAP_FAILED) {
		printf("kms-hotplug: mmap FAILED: %s\n", strerror(errno));
		return -1;
	}
	stride = cd.pitch / 4;
	for (y = 0; y < h; y++)
		for (x = 0; x < w; x++)
			px[y * stride + x] = test_pixel(x, y, w, h);
	munmap(px, cd.size);
	fb.width = w;
	fb.height = h;
	fb.pitch = cd.pitch;
	fb.bpp = 32;
	fb.depth = 24;
	fb.handle = cd.handle;
	if (xioctl(fd, DRM_IOCTL_MODE_ADDFB, &fb, "ADDFB"))
		return -1;
	crtc.crtc_id = crtc_id;
	crtc.fb_id = fb.fb_id;
	crtc.set_connectors_ptr = (uintptr_t)&conn_id;
	crtc.count_connectors = 1;
	crtc.mode = *mode;
	crtc.mode_valid = 1;
	if (xioctl(fd, DRM_IOCTL_MODE_SETCRTC, &crtc, "SETCRTC"))
		return -1;
	if (old_fb) {
		struct drm_mode_destroy_dumb dd = { .handle = old_handle };

		xioctl(fd, DRM_IOCTL_MODE_RMFB, &old_fb, "RMFB");
		xioctl(fd, DRM_IOCTL_MODE_DESTROY_DUMB, &dd, "DESTROY_DUMB");
	}
	old_fb = fb.fb_id;
	old_handle = cd.handle;
	return 0;
}

/* The value of KEY in a uevent's NUL-separated KEY=VALUE list, or NULL. */
static const char *prop(const char *buf, size_t len, const char *key)
{
	size_t k = strlen(key), i = 0;

	while (i < len) {
		const char *s = buf + i;
		size_t n = strnlen(s, len - i);

		if (n > k && !strncmp(s, key, k) && s[k] == '=')
			return s + k + 1;
		i += n + 1;
	}
	return NULL;
}

static double now(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec / 1e9;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/card0";
	double end = now() + (argc > 2 ? atoi(argv[2]) : 30);
	const char *steps = argc > 3 ? argv[3] : "s";
	struct sockaddr_nl nl = { .nl_family = AF_NETLINK, .nl_groups = 1 };
	struct drm_mode_card_res res = { 0 };
	struct drm_mode_modeinfo mode;
	uint32_t crtcs[8], conns[8];
	unsigned n, count, mm_w, mm_h;
	int sock;

	setvbuf(stdout, NULL, _IOLBF, 0);
	sock = socket(AF_NETLINK, SOCK_DGRAM | SOCK_CLOEXEC, NETLINK_KOBJECT_UEVENT);
	if (sock < 0 || bind(sock, (struct sockaddr *)&nl, sizeof(nl))) {
		printf("kms-hotplug: uevent socket FAILED: %s\n", strerror(errno));
		return 1;
	}
	fd = open(dev, O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		printf("kms-hotplug: open %s FAILED: %s\n", dev, strerror(errno));
		return 1;
	}
	if (xioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &res, "GETRESOURCES"))
		return 1;
	if (!res.count_crtcs || !res.count_connectors || res.count_crtcs > 8 || res.count_connectors > 8) {
		printf("kms-hotplug: %u crtcs, %u connectors FAILED\n", res.count_crtcs, res.count_connectors);
		return 1;
	}
	res.crtc_id_ptr = (uintptr_t)crtcs;
	res.connector_id_ptr = (uintptr_t)conns;
	res.count_fbs = res.count_encoders = 0;
	if (xioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &res, "GETRESOURCES"))
		return 1;
	crtc_id = crtcs[0];
	conn_id = conns[0];
	if (probe(&mode, &count, &mm_w, &mm_h) || show(&mode))
		return 1;
	printf("kms-hotplug: ready %ux%u, %u modes, %ux%u mm\n", mode.hdisplay, mode.vdisplay, count, mm_w, mm_h);

	for (n = 0; steps[n]; n++) {
		char buf[4096];
		const char *subsystem, *hotplug, *devname;
		ssize_t len;

		for (;;) {
			struct pollfd p = { .fd = sock, .events = POLLIN };
			int left = (int)((end - now()) * 1000);

			if (left <= 0 || poll(&p, 1, left) <= 0) {
				printf("kms-hotplug: no hotplug %u within the time FAILED\n", n + 1);
				return 1;
			}
			len = recv(sock, buf, sizeof(buf) - 1, 0);
			if (len <= 0)
				continue;
			buf[len] = 0;
			subsystem = prop(buf, len, "SUBSYSTEM");
			hotplug = prop(buf, len, "HOTPLUG");
			if (subsystem && !strcmp(subsystem, "drm") && hotplug && !strcmp(hotplug, "1"))
				break;
		}
		devname = prop(buf, len, "DEVNAME");
		printf("kms-hotplug: uevent %s (DEVNAME=%s HOTPLUG=1)\n", buf, devname ? devname : "");
		if (probe(&mode, &count, &mm_w, &mm_h))
			return 1;
		printf("kms-hotplug: hotplug %u: preferred %ux%u, %u modes, %ux%u mm\n", n + 1, mode.hdisplay,
		       mode.vdisplay, count, mm_w, mm_h);
		if (steps[n] == 's') {
			if (show(&mode))
				return 1;
			printf("kms-hotplug: set %ux%u\n", mode.hdisplay, mode.vdisplay);
		}
	}
	if (argc > 4)
		sleep((unsigned)atoi(argv[4]));
	printf("kms-hotplug: done\n");
	return 0;
}
