// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// virtio-gpu PRIME between two openers, as a Wayland client and its
// compositor share a buffer: one opens the render node and creates a 3D
// resource (DRM_IOCTL_VIRTGPU_RESOURCE_CREATE, as Mesa's virgl winsys does
// for a texture), exports it as a dmabuf (PRIME_HANDLE_TO_FD), and a second
// open of the device (another DRM file, as another process would have)
// imports the fd (PRIME_FD_TO_HANDLE) and asks which host resource it is
// (DRM_IOCTL_VIRTGPU_RESOURCE_INFO). Both must name the same resource. It
// then uploads a 64x64 pattern through the importer's handle
// (TRANSFER_TO_HOST) and waits, so that the host can look the resource's
// texture up: unkernel-check.mjs --drm step e.
//
//   prime [DEVICE] [SECONDS]     prints "res N" and the steps; exit 0 when they agree
#define _GNU_SOURCE
#include <drm/drm.h>
#include <drm/virtgpu_drm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define W 64
#define H 64

static int xioctl(int fd, unsigned long req, void *arg, const char *what)
{
	int r;

	do
		r = ioctl(fd, req, arg);
	while (r < 0 && (errno == EINTR || errno == EAGAIN));
	if (r < 0)
		fprintf(stderr, "prime: %s: %s\n", what, strerror(errno));
	return r;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/renderD128";
	int secs = argc > 2 ? atoi(argv[2]) : 5;
	int a = open(dev, O_RDWR | O_CLOEXEC), b = open(dev, O_RDWR | O_CLOEXEC);
	struct drm_virtgpu_getparam gp;
	struct drm_virtgpu_resource_create rc;
	struct drm_prime_handle ph;
	struct drm_virtgpu_resource_info ia, ib;
	struct drm_virtgpu_map map;
	struct drm_virtgpu_3d_transfer_to_host t;
	struct drm_virtgpu_3d_wait w;
	uint64_t v3d = 0;
	uint32_t *px;

	if (a < 0 || b < 0) {
		perror(dev);
		return 1;
	}
	gp = (struct drm_virtgpu_getparam){ .param = VIRTGPU_PARAM_3D_FEATURES, .value = (uintptr_t)&v3d };
	if (xioctl(a, DRM_IOCTL_VIRTGPU_GETPARAM, &gp, "GETPARAM 3D_FEATURES") || !v3d) {
		fprintf(stderr, "prime: no 3D on %s\n", dev);
		return 1;
	}
	// A 2D texture, B8G8R8X8, render target and sampler view (bind 2 | 8), 64x64.
	rc = (struct drm_virtgpu_resource_create){ .target = 2, .format = 2, .bind = 2 | 8,
		.width = W, .height = H, .depth = 1, .array_size = 1, .size = W * H * 4, .stride = W * 4 };
	if (xioctl(a, DRM_IOCTL_VIRTGPU_RESOURCE_CREATE, &rc, "RESOURCE_CREATE"))
		return 1;
	ph = (struct drm_prime_handle){ .handle = rc.bo_handle, .flags = DRM_CLOEXEC | DRM_RDWR };
	if (xioctl(a, DRM_IOCTL_PRIME_HANDLE_TO_FD, &ph, "PRIME_HANDLE_TO_FD"))
		return 1;
	printf("exporter: handle %u, resource %u, dmabuf fd %d\n", rc.bo_handle, rc.res_handle, ph.fd);
	ph.handle = 0;
	if (xioctl(b, DRM_IOCTL_PRIME_FD_TO_HANDLE, &ph, "PRIME_FD_TO_HANDLE"))
		return 1;
	ia = (struct drm_virtgpu_resource_info){ .bo_handle = rc.bo_handle };
	ib = (struct drm_virtgpu_resource_info){ .bo_handle = ph.handle };
	if (xioctl(a, DRM_IOCTL_VIRTGPU_RESOURCE_INFO, &ia, "RESOURCE_INFO (exporter)") ||
	    xioctl(b, DRM_IOCTL_VIRTGPU_RESOURCE_INFO, &ib, "RESOURCE_INFO (importer)"))
		return 1;
	printf("importer: handle %u, resource %u, size %u\n", ph.handle, ib.res_handle, ib.size);
	if (ia.res_handle != rc.res_handle || ib.res_handle != rc.res_handle) {
		fprintf(stderr, "prime: the importer's resource %u is not the exporter's %u\n", ib.res_handle, rc.res_handle);
		return 1;
	}
	// The importer writes the pattern into the shared pages and uploads it.
	map = (struct drm_virtgpu_map){ .handle = ph.handle };
	if (xioctl(b, DRM_IOCTL_VIRTGPU_MAP, &map, "MAP"))
		return 1;
	px = mmap(NULL, W * H * 4, PROT_READ | PROT_WRITE, MAP_SHARED, b, (off_t)map.offset);
	if (px == MAP_FAILED) {
		perror("mmap");
		return 1;
	}
	for (int y = 0; y < H; y++)
		for (int x = 0; x < W; x++)
			px[y * W + x] = 0xff000000u | (uint32_t)(x * 4) << 16 | (uint32_t)(y * 4) << 8 | (x < W / 2 ? 0x40 : 0xc0);
	// No strides: the kernel refuses them for a resource that is not a blob
	// (the host takes the level's own, W * 4 here).
	t = (struct drm_virtgpu_3d_transfer_to_host){ .bo_handle = ph.handle,
		.box = { .x = 0, .y = 0, .z = 0, .w = W, .h = H, .d = 1 }, .level = 0, .offset = 0 };
	if (xioctl(b, DRM_IOCTL_VIRTGPU_TRANSFER_TO_HOST, &t, "TRANSFER_TO_HOST"))
		return 1;
	w = (struct drm_virtgpu_3d_wait){ .handle = ph.handle };
	if (xioctl(b, DRM_IOCTL_VIRTGPU_WAIT, &w, "WAIT"))
		return 1;
	printf("res %u\n", rc.res_handle);
	fflush(stdout);
	sleep(secs);
	return 0;
}
