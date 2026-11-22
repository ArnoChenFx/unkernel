// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Integer vertex attributes and an integer colour buffer on Mesa's virgl
// driver (unkernel-check.mjs --drm step h): what Firefox's WebRender draws
// with from its first frame (instanced ivec4 attributes). WebGL refuses a
// draw whose vertex shader input is not of its attribute's base type (and a
// fragment output not of its colour buffer's), and the renderer's context
// is then in error: every later command buffer and transfer of it fails
// (the guest's kernel logs "response 0x1200" for each), so a readback here
// gets nothing (renderer patch 15).
//
// Surfaceless EGL on GBM (the render node), a GLES 3.0 context, 16x16
// framebuffers:
//
//   int    RGBA8, a quad drawn instanced (2 instances, divisor 1) with an
//          ivec4 attribute (GL_INT) and a uvec4 one (GL_UNSIGNED_BYTE):
//          instance 0 colours the left half, instance 1 the right, each
//          from its attributes
//   uint   RGBA8UI, the same quad with a uvec4 fragment output
//
// It reads each back and prints one line per check, "ok NAME" or
// "bad NAME ...", and exits 0 when all are ok.
//
//   int-attrib [DEVICE]
#define _GNU_SOURCE
#define EGL_NO_X11
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define S 16

static _Noreturn void die(const char *what)
{
	fprintf(stderr, "int-attrib: %s (EGL 0x%x, GL 0x%x)\n", what, eglGetError(), glGetError());
	exit(1);
}

static GLuint shader(GLenum type, const char *src)
{
	GLuint s = glCreateShader(type);
	GLint ok = 0;
	char log[1024];

	glShaderSource(s, 1, &src, NULL);
	glCompileShader(s);
	glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
	if (!ok) {
		glGetShaderInfoLog(s, sizeof(log), NULL, log);
		fprintf(stderr, "int-attrib: shader: %s\n", log);
		exit(1);
	}
	return s;
}

static GLuint program(const char *fs)
{
	static const char *vs =
		"#version 300 es\n"
		"in vec2 a_pos;\n"
		"in ivec4 a_int;\n"
		"in uvec4 a_uint;\n"
		"flat out ivec4 v_int;\n"
		"flat out uvec4 v_uint;\n"
		"void main() {\n"
		"  v_int = a_int;\n"
		"  v_uint = a_uint;\n"
		"  gl_Position = vec4(a_pos.x * 0.5 + (gl_InstanceID == 0 ? -0.5 : 0.5), a_pos.y, 0.0, 1.0);\n"
		"}\n";
	GLuint p = glCreateProgram();
	GLint ok = 0;

	glAttachShader(p, shader(GL_VERTEX_SHADER, vs));
	glAttachShader(p, shader(GL_FRAGMENT_SHADER, fs));
	glBindAttribLocation(p, 0, "a_pos");
	glBindAttribLocation(p, 1, "a_int");
	glBindAttribLocation(p, 2, "a_uint");
	glLinkProgram(p);
	glGetProgramiv(p, GL_LINK_STATUS, &ok);
	if (!ok)
		die("link");
	return p;
}

// The quad and the two instances' attributes.
static void draw(GLuint prog)
{
	static const float pos[] = { -1, -1, 1, -1, -1, 1, 1, 1 };
	// instance 0: red 200, green 10, blue 30; instance 1: red 5, green 150, blue 250 (minus 2 from the uint side)
	static const int32_t ints[] = { 198, 10, 30, 255, 3, 150, 248, 255 };
	static const uint8_t uints[] = { 2, 0, 0, 0, 2, 0, 2, 0 };
	GLuint vao, buf[3];

	glGenVertexArrays(1, &vao);
	glBindVertexArray(vao);
	glGenBuffers(3, buf);
	glBindBuffer(GL_ARRAY_BUFFER, buf[0]);
	glBufferData(GL_ARRAY_BUFFER, sizeof(pos), pos, GL_STATIC_DRAW);
	glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, 0);
	glEnableVertexAttribArray(0);
	glBindBuffer(GL_ARRAY_BUFFER, buf[1]);
	glBufferData(GL_ARRAY_BUFFER, sizeof(ints), ints, GL_STATIC_DRAW);
	glVertexAttribIPointer(1, 4, GL_INT, 16, 0);
	glVertexAttribDivisor(1, 1);
	glEnableVertexAttribArray(1);
	glBindBuffer(GL_ARRAY_BUFFER, buf[2]);
	glBufferData(GL_ARRAY_BUFFER, sizeof(uints), uints, GL_STATIC_DRAW);
	glVertexAttribIPointer(2, 4, GL_UNSIGNED_BYTE, 4, 0);
	glVertexAttribDivisor(2, 1);
	glEnableVertexAttribArray(2);
	glUseProgram(prog);
	glViewport(0, 0, S, S);
	glDrawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, 2);
}

static GLuint target(GLenum format)
{
	GLuint fb, rb;

	glGenRenderbuffers(1, &rb);
	glBindRenderbuffer(GL_RENDERBUFFER, rb);
	glRenderbufferStorage(GL_RENDERBUFFER, format, S, S);
	glGenFramebuffers(1, &fb);
	glBindFramebuffer(GL_FRAMEBUFFER, fb);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb);
	if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
		die("framebuffer");
	return fb;
}

// Pixel (x, 8) against the colour expected there.
static int check(const char *name, const uint32_t *px, int x, const uint32_t *want)
{
	const uint32_t *p = px + (8 * S + x) * 4;

	if (p[0] == want[0] && p[1] == want[1] && p[2] == want[2] && p[3] == want[3])
		return 0;
	printf("bad %s at x %d: %u %u %u %u, not %u %u %u %u\n", name, x, p[0], p[1], p[2], p[3], want[0], want[1], want[2], want[3]);
	return 1;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/renderD128";
	static const EGLint ctx_attr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
	static const uint32_t left[4] = { 200, 10, 30, 255 }, right[4] = { 5, 150, 250, 255 };
	uint32_t px[S * S * 4];
	uint8_t px8[S * S * 4];
	int fd, bad = 0, n;
	struct gbm_device *gbm;
	EGLDisplay dpy;
	EGLContext ctx;
	GLuint fb;

	fd = open(dev, O_RDWR | O_CLOEXEC);
	if (fd < 0)
		die("open");
	gbm = gbm_create_device(fd);
	if (!gbm)
		die("gbm_create_device");
	dpy = eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, NULL);
	if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, NULL, NULL))
		die("eglInitialize");
	if (!eglBindAPI(EGL_OPENGL_ES_API))
		die("eglBindAPI");
	ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ctx_attr);
	if (ctx == EGL_NO_CONTEXT || !eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx))
		die("context");
	printf("renderer %s\n", glGetString(GL_RENDERER));

	// int: an RGBA8 colour buffer, the attributes' sum as the colour
	fb = target(GL_RGBA8);
	glClearColor(0, 0, 0, 0);
	glClear(GL_COLOR_BUFFER_BIT);
	draw(program("#version 300 es\n"
		     "precision highp float;\n"
		     "flat in ivec4 v_int;\n"
		     "flat in uvec4 v_uint;\n"
		     "out vec4 o;\n"
		     "void main() { o = vec4(v_int + ivec4(v_uint)) / 255.0; }\n"));
	memset(px8, 0, sizeof(px8));
	glReadPixels(0, 0, S, S, GL_RGBA, GL_UNSIGNED_BYTE, px8);
	for (n = 0; n < S * S * 4; n++)
		px[n] = px8[n];
	n = check("int", px, 3, left) + check("int", px, S - 4, right);
	printf("%s int\n", n ? "bad" : "ok");
	bad += n;
	glDeleteFramebuffers(1, &fb);

	// uint: an RGBA8UI colour buffer and a uvec4 output
	fb = target(GL_RGBA8UI);
	{
		static const GLuint zero[4] = { 0, 0, 0, 0 };

		glClearBufferuiv(GL_COLOR, 0, zero);
	}
	draw(program("#version 300 es\n"
		     "precision highp float;\n"
		     "flat in ivec4 v_int;\n"
		     "flat in uvec4 v_uint;\n"
		     "out uvec4 o;\n"
		     "void main() { o = uvec4(v_int) + v_uint; }\n"));
	memset(px, 0, sizeof(px));
	glReadPixels(0, 0, S, S, GL_RGBA_INTEGER, GL_UNSIGNED_INT, px);
	n = check("uint", px, 3, left) + check("uint", px, S - 4, right);
	printf("%s uint\n", n ? "bad" : "ok");
	bad += n;
	n = glGetError();
	if (n != GL_NO_ERROR) {
		printf("bad GL error 0x%x\n", n);
		bad++;
	}
	return bad ? 1 : 0;
}
