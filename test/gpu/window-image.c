// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Window buffers as a Wayland EGL client makes them, for the host's
// GpuRenderer.image() (unkernel-check.mjs --drm step g): GBM surfaces on
// the render node, an EGL window surface on each (Mesa's virgl driver),
// a known picture drawn with GL and swapped, and the front buffer's
// virtio-gpu resource id (DRM_IOCTL_VIRTGPU_RESOURCE_INFO on the bo's
// handle; a compositor would import the dmabuf first, as prime.c does).
// The picture, W x H = 64 x 48, by quadrant from the top left, as
// premultiplied RGBA:
//
//   top left      255,   0,   0, 255   opaque red
//   top right       0, 128,   0, 128   green at 50%
//   bottom left     0,   0,   0,   0   transparent
//   bottom right    0,   0,  64,  64   blue at 25%
//
// in ARGB8888, XRGB8888, ABGR8888 and XBGR8888 (the last two where Mesa
// has an EGL config for them), plus 800x600 and 1920x1080 ARGB8888 buffers
// cleared to one colour (for timing). It prints one line per buffer,
//
//   buf NAME res ID fourcc 0xFOURCC WxH
//
// then "ready", and holds them for SECONDS (default 30) before it exits.
// With WINDOW_IMAGE_DEBUG set it also prints each buffer's EGL config and
// what glReadPixels reads of each quadrant before the swap.
//
//   window-image [DEVICE] [SECONDS]
#define _GNU_SOURCE
#define EGL_NO_X11
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <drm/drm.h>
#include <drm/virtgpu_drm.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define W 64
#define H 48

static int fd;
static struct gbm_device *gbm;
static EGLDisplay dpy;

static _Noreturn void die(const char *what)
{
	fprintf(stderr, "window-image: %s (EGL 0x%x, GL 0x%x)\n", what, eglGetError(), glGetError());
	exit(1);
}

// The config whose native visual is FOURCC, or NULL.
static EGLConfig config_for(uint32_t fourcc, int alpha)
{
	EGLint n = 0, attr[] = { EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
		EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, alpha ? 8 : 0, EGL_NONE };
	EGLConfig cfgs[256];

	if (!eglChooseConfig(dpy, attr, cfgs, 256, &n))
		die("eglChooseConfig");
	for (EGLint i = 0; i < n; i++) {
		EGLint id = 0;

		if (eglGetConfigAttrib(dpy, cfgs[i], EGL_NATIVE_VISUAL_ID, &id) && (uint32_t)id == fourcc)
			return cfgs[i];
	}
	return NULL;
}

static void quad(int x, int y, int w, int h, float r, float g, float b, float a)
{
	glScissor(x, y, w, h);
	glClearColor(r, g, b, a);
	glClear(GL_COLOR_BUFFER_BIT);
}

// A surface of FOURCC, W x H (or w x h cleared to one colour), drawn,
// swapped and locked: its resource id, or 0 when there is no config.
static uint32_t window(const char *name, uint32_t fourcc, int alpha, int w, int h)
{
	static const EGLint ctx_attr[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
	EGLConfig cfg = config_for(fourcc, alpha);
	struct gbm_surface *gs;
	struct gbm_bo *bo;
	EGLSurface surf;
	EGLContext ctx;
	struct drm_virtgpu_resource_info ri;

	if (!cfg) {
		printf("skip %s: no EGL config for 0x%08x\n", name, fourcc);
		return 0;
	}
	gs = gbm_surface_create(gbm, (uint32_t)w, (uint32_t)h, fourcc, GBM_BO_USE_RENDERING);
	if (!gs)
		die("gbm_surface_create");
	surf = eglCreateWindowSurface(dpy, cfg, (EGLNativeWindowType)(uintptr_t)gs, NULL);
	if (surf == EGL_NO_SURFACE)
		die("eglCreateWindowSurface");
	ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctx_attr);
	if (ctx == EGL_NO_CONTEXT || !eglMakeCurrent(dpy, surf, surf, ctx))
		die("eglCreateContext");
	glViewport(0, 0, w, h);
	glEnable(GL_SCISSOR_TEST);
	if (w == W && h == H) {
		// GL's rows count from the bottom: y H / 2 and up is the top half.
		quad(0, H / 2, W / 2, H / 2, 1, 0, 0, 1);
		quad(W / 2, H / 2, W / 2, H / 2, 0, 128 / 255.0f, 0, 128 / 255.0f);
		quad(0, 0, W / 2, H / 2, 0, 0, 0, 0);
		quad(W / 2, 0, W / 2, H / 2, 0, 0, 64 / 255.0f, 64 / 255.0f);
	} else
		quad(0, 0, w, h, 0.25f, 0.5f, 0.75f, 1);
	glFinish();
	if (glGetError() != GL_NO_ERROR)
		die("GL error");
	if (getenv("WINDOW_IMAGE_DEBUG")) {
		uint8_t px[4][4];
		int at[4][2] = { { 8, h - 8 }, { w - 8, h - 8 }, { 8, 8 }, { w - 8, 8 } };
		EGLint r, g, b, a, id;

		eglGetConfigAttrib(dpy, cfg, EGL_RED_SIZE, &r);
		eglGetConfigAttrib(dpy, cfg, EGL_GREEN_SIZE, &g);
		eglGetConfigAttrib(dpy, cfg, EGL_BLUE_SIZE, &b);
		eglGetConfigAttrib(dpy, cfg, EGL_ALPHA_SIZE, &a);
		eglGetConfigAttrib(dpy, cfg, EGL_CONFIG_ID, &id);
		for (int i = 0; i < 4; i++)
			glReadPixels(at[i][0], at[i][1], 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px[i]);
		printf("debug %s: config %d (%d%d%d%d), read TL %u,%u,%u,%u TR %u,%u,%u,%u BL %u,%u,%u,%u BR %u,%u,%u,%u\n", name, id, r, g, b, a,
		       px[0][0], px[0][1], px[0][2], px[0][3], px[1][0], px[1][1], px[1][2], px[1][3],
		       px[2][0], px[2][1], px[2][2], px[2][3], px[3][0], px[3][1], px[3][2], px[3][3]);
	}
	if (!eglSwapBuffers(dpy, surf))
		die("eglSwapBuffers");
	bo = gbm_surface_lock_front_buffer(gs);
	if (!bo)
		die("gbm_surface_lock_front_buffer");
	ri = (struct drm_virtgpu_resource_info){ .bo_handle = gbm_bo_get_handle(bo).u32 };
	if (ioctl(fd, DRM_IOCTL_VIRTGPU_RESOURCE_INFO, &ri))
		die("RESOURCE_INFO");
	printf("buf %s res %u fourcc 0x%08x %dx%d\n", name, ri.res_handle, fourcc, w, h);
	eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
	return ri.res_handle;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/renderD128";
	int secs = argc > 2 ? atoi(argv[2]) : 30;
	EGLint major, minor;

	setvbuf(stdout, NULL, _IOLBF, 0);
	fd = open(dev, O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		perror(dev);
		return 1;
	}
	gbm = gbm_create_device(fd);
	if (!gbm)
		die("gbm_create_device");
	dpy = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, NULL);
	if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, &major, &minor))
		die("eglInitialize");
	if (!eglBindAPI(EGL_OPENGL_ES_API))
		die("eglBindAPI");
	printf("egl %d.%d, %s\n", major, minor, eglQueryString(dpy, EGL_VENDOR));
	if (!window("argb", GBM_FORMAT_ARGB8888, 1, W, H) || !window("xrgb", GBM_FORMAT_XRGB8888, 0, W, H))
		return 1;
	window("abgr", GBM_FORMAT_ABGR8888, 1, W, H);
	window("xbgr", GBM_FORMAT_XBGR8888, 0, W, H);
	if (!window("argb-800x600", GBM_FORMAT_ARGB8888, 1, 800, 600) ||
	    !window("argb-1920x1080", GBM_FORMAT_ARGB8888, 1, 1920, 1080))
		return 1;
	printf("ready\n");
	sleep(secs);
	return 0;
}
