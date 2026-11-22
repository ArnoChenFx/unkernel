// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Multisampling on Mesa's virgl driver (unkernel-check.mjs --drm step m):
// what Chromium needs before it uses the GPU. Its ANGLE offers OpenGL ES
// 3.0 only where every colour and depth format ES 3.0 requires takes 4
// samples (glGetInternalformativ GL_SAMPLES), and Chromium asks for nothing
// less than ES 3.0; WebGL 2 has no multisample textures, so the renderer
// makes multisample resources renderbuffers (renderer patch 17). Without
// that the guest's driver offered no multisampling at all (GL_MAX_SAMPLES
// 1), ANGLE capped itself at ES 2.0, and Chromium's GPU process exited
// ("eglCreateContext: Requested version is not supported").
//
// Surfaceless EGL on GBM (the render node), a GLES 3.0 context:
//
//   samples  GL_MAX_SAMPLES and the sample counts of RGBA8, RGB565,
//            DEPTH_COMPONENT16, DEPTH24_STENCIL8 and STENCIL_INDEX8: 4 or
//            more each
//   draw     a 16x16 framebuffer of 4-sample RGBA8 and DEPTH24_STENCIL8
//            renderbuffers: a white triangle over the lower left half, a
//            red one behind it (depth test), resolved by glBlitFramebuffer
//            into a single-sample one and read back: white inside, black
//            outside, no red, and grey on the diagonal (partly covered
//            pixels: only multisampling gives a colour between the two)
//
// It prints one line per check, "ok NAME" or "bad NAME ...", and exits 0
// when all are ok.
//
//   msaa [DEVICE]
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
	fprintf(stderr, "msaa: %s (EGL 0x%x, GL 0x%x)\n", what, eglGetError(), glGetError());
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
		fprintf(stderr, "msaa: shader: %s\n", log);
		exit(1);
	}
	return s;
}

static GLuint renderbuffer(GLsizei samples, GLenum format)
{
	GLuint rb;

	glGenRenderbuffers(1, &rb);
	glBindRenderbuffer(GL_RENDERBUFFER, rb);
	glRenderbufferStorageMultisample(GL_RENDERBUFFER, samples, format, S, S);
	return rb;
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/dri/renderD128";
	static const EGLint ctx_attr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
	static const struct { GLenum f; const char *name; } formats[] = {
		{ GL_RGBA8, "RGBA8" }, { GL_RGB565, "RGB565" }, { GL_DEPTH_COMPONENT16, "DEPTH_COMPONENT16" },
		{ GL_DEPTH24_STENCIL8, "DEPTH24_STENCIL8" }, { GL_STENCIL_INDEX8, "STENCIL_INDEX8" },
	};
	// the white triangle at depth 0, the red one at 0.5 over the whole target
	static const float tri[] = { -1, -1, 0, 1, -1, 0, -1, 1, 0,
				     -1, -1, 0.5f, 3, -1, 0.5f, -1, 3, 0.5f };
	uint8_t px[S * S * 4];
	int fd, bad = 0, n, grey = 0, white = 0, black = 0, red = 0;
	GLint max = 0;
	struct gbm_device *gbm;
	EGLDisplay dpy;
	EGLContext ctx;
	GLuint fb[2], prog, vao, buf;
	GLint loc;

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

	glGetIntegerv(GL_MAX_SAMPLES, &max);
	n = max < 4;
	if (n)
		printf("bad samples: GL_MAX_SAMPLES %d\n", max);
	for (unsigned i = 0; i < sizeof(formats) / sizeof(*formats); i++) {
		GLint count = 0, s[16] = { 0 };

		glGetInternalformativ(GL_RENDERBUFFER, formats[i].f, GL_NUM_SAMPLE_COUNTS, 1, &count);
		if (count > 16)
			count = 16;
		if (count > 0)
			glGetInternalformativ(GL_RENDERBUFFER, formats[i].f, GL_SAMPLES, count, s);
		if (count < 1 || s[0] < 4) {
			printf("bad samples: %s takes %d at most\n", formats[i].name, count > 0 ? s[0] : 0);
			n++;
		}
	}
	printf("%s samples (GL_MAX_SAMPLES %d)\n", n ? "bad" : "ok", max);
	bad += n;

	glGenFramebuffers(2, fb);
	glBindFramebuffer(GL_FRAMEBUFFER, fb[0]);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, renderbuffer(4, GL_RGBA8));
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, renderbuffer(4, GL_DEPTH24_STENCIL8));
	if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
		die("multisample framebuffer");
	glBindFramebuffer(GL_FRAMEBUFFER, fb[1]);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, renderbuffer(0, GL_RGBA8));
	if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
		die("single-sample framebuffer");

	prog = glCreateProgram();
	glAttachShader(prog, shader(GL_VERTEX_SHADER, "#version 300 es\n"
				    "in vec3 a_pos;\n"
				    "void main() { gl_Position = vec4(a_pos, 1.0); }\n"));
	glAttachShader(prog, shader(GL_FRAGMENT_SHADER, "#version 300 es\n"
				    "precision highp float;\n"
				    "uniform vec4 u_colour;\n"
				    "out vec4 o;\n"
				    "void main() { o = u_colour; }\n"));
	glBindAttribLocation(prog, 0, "a_pos");
	glLinkProgram(prog);
	glGetProgramiv(prog, GL_LINK_STATUS, &n);
	if (!n)
		die("link");
	loc = glGetUniformLocation(prog, "u_colour");
	glGenVertexArrays(1, &vao);
	glBindVertexArray(vao);
	glGenBuffers(1, &buf);
	glBindBuffer(GL_ARRAY_BUFFER, buf);
	glBufferData(GL_ARRAY_BUFFER, sizeof(tri), tri, GL_STATIC_DRAW);
	glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 0, 0);
	glEnableVertexAttribArray(0);

	glBindFramebuffer(GL_FRAMEBUFFER, fb[0]);
	glViewport(0, 0, S, S);
	glClearColor(0, 0, 0, 1);
	glClearDepthf(1);
	glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
	glEnable(GL_DEPTH_TEST);
	glDepthFunc(GL_LESS);
	glUseProgram(prog);
	glUniform4f(loc, 1, 1, 1, 1);
	glDrawArrays(GL_TRIANGLES, 0, 3);
	// behind the white one: shows only where it is not (and not at all
	// where the clear left depth 1 and the depth test failed it)
	glUniform4f(loc, 1, 0, 0, 1);
	glDrawArrays(GL_TRIANGLES, 3, 3);
	glDisable(GL_DEPTH_TEST);
	(void)red;

	glBindFramebuffer(GL_READ_FRAMEBUFFER, fb[0]);
	glBindFramebuffer(GL_DRAW_FRAMEBUFFER, fb[1]);
	glBlitFramebuffer(0, 0, S, S, 0, 0, S, S, GL_COLOR_BUFFER_BIT, GL_NEAREST);
	glBindFramebuffer(GL_READ_FRAMEBUFFER, fb[1]);
	memset(px, 0x55, sizeof(px));
	glReadPixels(0, 0, S, S, GL_RGBA, GL_UNSIGNED_BYTE, px);

	// Lower left of the diagonal (x + y < 15) white, upper right red (the
	// second triangle where the first is not), the diagonal's pixels
	// (centres on the edge) partly covered by each.
	n = 0;
	for (int y = 0; y < S; y++)
		for (int x = 0; x < S; x++) {
			const uint8_t *p = px + (y * S + x) * 4;

			if (x + y < S - 2 && !(p[0] == 255 && p[1] == 255 && p[2] == 255)) {
				if (n++ < 4)
					printf("bad draw: (%d, %d) %u %u %u %u inside the white triangle\n", x, y, p[0], p[1], p[2], p[3]);
			} else if (x + y > S && !(p[0] == 255 && p[1] == 0 && p[2] == 0)) {
				if (n++ < 4)
					printf("bad draw: (%d, %d) %u %u %u %u outside it, not red\n", x, y, p[0], p[1], p[2], p[3]);
			}
			if (p[0] == 255 && p[1] == 255 && p[2] == 255)
				white++;
			else if (p[0] == 255 && p[1] == 0 && p[2] == 0)
				black++;
			else if (p[0] == 255 && p[1] > 0 && p[1] < 255 && p[1] == p[2])
				grey++;
		}
	if (grey < S / 2) {
		printf("bad draw: %d partly covered pixels on the diagonal (no multisampling)\n", grey);
		n++;
	}
	printf("%s draw (%d white, %d red, %d between)\n", n ? "bad" : "ok", white, black, grey);
	bad += n;
	n = glGetError();
	if (n != GL_NO_ERROR) {
		printf("bad GL error 0x%x\n", n);
		bad++;
	}
	return bad ? 1 : 0;
}
