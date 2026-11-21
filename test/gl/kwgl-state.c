// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Stale-state check for a virgl renderer that keeps every client on one GL
// context. Each VARIANT runs in its own process (its own vtest connection)
// with deliberately different GL state, set once and then relied on. The
// processes take turns, one turn each in ring order, and every turn ends in
// glReadPixels, which returns only after the server has run that turn, so
// the server sees the turns strictly interleaved. Each turn prints
//
//   VARIANT TURN CHECKSUM
//
// (FNV-1a of the RGBA pixels). A variant's frames depend only on its own
// state, so the lines of an interleaved run must equal those of the same
// variant run alone on the multi-context renderer (vtest-check.sh state).
//
//   kwgl-state [-t TURNS] [-o DIR] VARIANT...
//
// VARIANT: tex raster stencil plain query mip dual. -o writes each
// variant's last frame to DIR/VARIANT.ppm. Build:
//   cc -O2 -o kwgl-state kwgl-state.c -lEGL -lGLESv2
// Run under GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 (surfaceless EGL).

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define W 64
#define H 64

static const char *name;
static const char *outdir;
static int rd_fd = -1, wr_fd = -1;

static void die(const char *what)
{
	fprintf(stderr, "kwgl-state %s: %s\n", name ? name : "", what);
	exit(1);
}

static void check(const char *where)
{
	GLenum e = glGetError();
	if (e != GL_NO_ERROR) {
		fprintf(stderr, "kwgl-state %s: GL error 0x%x at %s\n", name, e, where);
		exit(1);
	}
}

static void take_turn(void)
{
	char c;
	if (read(rd_fd, &c, 1) != 1)
		die("lost the turn token");
}

static void pass_turn(void)
{
	char c = 't';
	if (write(wr_fd, &c, 1) != 1)
		die("cannot pass the turn token");
}

/* ---- EGL, surfaceless, no config ---- */

static EGLDisplay dpy;

static EGLContext make_context(void)
{
	static const EGLint attr[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
	EGLContext c = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, attr);
	if (c == EGL_NO_CONTEXT)
		die("eglCreateContext failed");
	return c;
}

static void use_context(EGLContext c)
{
	if (!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, c))
		die("eglMakeCurrent failed");
}

static void init_egl(void)
{
	PFNEGLGETPLATFORMDISPLAYEXTPROC gpd =
		(PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
	if (!gpd)
		die("no eglGetPlatformDisplayEXT");
	dpy = gpd(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
	if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, NULL, NULL))
		die("no surfaceless EGL display");
	if (!eglBindAPI(EGL_OPENGL_ES_API))
		die("eglBindAPI failed");
}

/* ---- per-context GL objects ---- */

static const char *vs_src =
	"#version 300 es\n"
	"layout(location=0) in vec4 pos;\n"
	"layout(location=1) in vec4 col;\n"
	"layout(location=2) in vec2 tc;\n"
	"uniform vec2 shift;\n"
	"out vec4 v_col; out vec2 v_tc;\n"
	"void main() { gl_Position = pos + vec4(shift, 0.0, 0.0); v_col = col; v_tc = tc; }\n";

static const char *fs_src =
	"#version 300 es\n"
	"precision mediump float;\n"
	"in vec4 v_col; in vec2 v_tc;\n"
	"uniform sampler2D tex0; uniform sampler2D tex1;\n"
	"uniform float use_tex;\n"
	"layout(std140) uniform Tint { vec4 tint; };\n"
	"out vec4 o;\n"
	"void main() {\n"
	"  vec4 t = texture(tex0, v_tc) * texture(tex1, v_tc * 2.0);\n"
	"  o = mix(v_col, v_col * t, use_tex) * tint;\n"
	"}\n";

struct gl {
	EGLContext ctx;
	GLuint prog, vbo, fbo, color, depth, tex[2], sampler, ubo, query;
	GLint shift_loc;
	float clear[4];
	float clear_depth;
};

/* Three triangles: CCW front, CW behind, and a CCW quad half deep, each with
 * its own colour and texture coordinates. pos(4) col(4) tc(2). */
static const float verts[] = {
	-0.9f, -0.9f, 0.2f, 1, 1.0f, 0.2f, 0.1f, 1, 0, 0,
	 0.6f, -0.8f, 0.2f, 1, 0.9f, 0.8f, 0.1f, 1, 1, 0,
	-0.2f,  0.7f, 0.2f, 1, 0.1f, 0.5f, 0.9f, 1, 0.5f, 1,

	-0.6f,  0.9f, -0.3f, 1, 0.2f, 0.9f, 0.3f, 0.8f, 0, 1,
	 0.9f,  0.6f, -0.3f, 1, 0.8f, 0.3f, 0.9f, 0.8f, 1, 1,
	 0.0f, -0.6f, -0.3f, 1, 0.5f, 0.5f, 0.5f, 0.8f, 0.5f, 0,

	-0.5f, -0.5f, 0.6f, 1, 0.3f, 0.3f, 1.0f, 0.6f, 0, 0,
	 0.5f, -0.5f, 0.6f, 1, 0.3f, 1.0f, 0.3f, 0.6f, 1, 0,
	 0.5f,  0.5f, 0.6f, 1, 1.0f, 0.3f, 0.3f, 0.6f, 1, 1,
	-0.5f, -0.5f, 0.6f, 1, 0.3f, 0.3f, 1.0f, 0.6f, 0, 0,
	 0.5f,  0.5f, 0.6f, 1, 1.0f, 0.3f, 0.3f, 0.6f, 1, 1,
	-0.5f,  0.5f, 0.6f, 1, 0.9f, 0.9f, 0.9f, 0.6f, 0, 1,
};
#define NVERTS 12
#define STRIDE (10 * sizeof(float))

static GLuint shader(GLenum type, const char *src)
{
	GLuint s = glCreateShader(type);
	GLint ok;
	glShaderSource(s, 1, &src, NULL);
	glCompileShader(s);
	glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
	if (!ok)
		die("shader compile failed");
	return s;
}

static GLuint make_texture(int seed, int n)
{
	unsigned char px[16 * 16 * 4];
	GLuint t;
	for (int y = 0; y < n; y++)
		for (int x = 0; x < n; x++) {
			unsigned char *p = &px[(y * n + x) * 4];
			int on = ((x + y) & 1) ^ (seed & 1);
			p[0] = on ? 255 : (unsigned char)(40 * seed);
			p[1] = (unsigned char)(x * 255 / (n - 1));
			p[2] = (unsigned char)(y * 255 / (n - 1));
			p[3] = 255;
		}
	glGenTextures(1, &t);
	glBindTexture(GL_TEXTURE_2D, t);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, n, n, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	return t;
}

/* Objects and the state every variant starts from: program, FBO with depth
 * and stencil, vertex arrays with all three attributes, textures off. */
static void init_gl(struct gl *g, const float tint[4], const float clear[4])
{
	GLuint vs = shader(GL_VERTEX_SHADER, vs_src), fs = shader(GL_FRAGMENT_SHADER, fs_src);
	GLint ok;
	GLuint vao;

	g->prog = glCreateProgram();
	glAttachShader(g->prog, vs);
	glAttachShader(g->prog, fs);
	glLinkProgram(g->prog);
	glGetProgramiv(g->prog, GL_LINK_STATUS, &ok);
	if (!ok)
		die("program link failed");
	glUseProgram(g->prog);
	g->shift_loc = glGetUniformLocation(g->prog, "shift");
	glUniform1i(glGetUniformLocation(g->prog, "tex0"), 0);
	glUniform1i(glGetUniformLocation(g->prog, "tex1"), 1);
	glUniform1f(glGetUniformLocation(g->prog, "use_tex"), 0.0f);
	glUniformBlockBinding(g->prog, glGetUniformBlockIndex(g->prog, "Tint"), 0);

	glGenBuffers(1, &g->ubo);
	glBindBuffer(GL_UNIFORM_BUFFER, g->ubo);
	glBufferData(GL_UNIFORM_BUFFER, 16, tint, GL_STATIC_DRAW);
	glBindBufferBase(GL_UNIFORM_BUFFER, 0, g->ubo);

	glGenVertexArrays(1, &vao);
	glBindVertexArray(vao);
	glGenBuffers(1, &g->vbo);
	glBindBuffer(GL_ARRAY_BUFFER, g->vbo);
	glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
	glVertexAttribPointer(0, 4, GL_FLOAT, GL_FALSE, STRIDE, (void *)0);
	glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, STRIDE, (void *)(4 * sizeof(float)));
	glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, STRIDE, (void *)(8 * sizeof(float)));
	glEnableVertexAttribArray(0);
	glEnableVertexAttribArray(1);
	glEnableVertexAttribArray(2);

	glGenTextures(1, &g->color);
	glBindTexture(GL_TEXTURE_2D, g->color);
	glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, W, H);
	glGenRenderbuffers(1, &g->depth);
	glBindRenderbuffer(GL_RENDERBUFFER, g->depth);
	glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, W, H);
	glGenFramebuffers(1, &g->fbo);
	glBindFramebuffer(GL_FRAMEBUFFER, g->fbo);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g->color, 0);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g->depth);
	if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
		die("framebuffer incomplete");
	glViewport(0, 0, W, H);
	memcpy(g->clear, clear, sizeof(g->clear));
	g->clear_depth = 1.0f;
	glBindTexture(GL_TEXTURE_2D, 0);
	check("init");
}

/* Two textures on units 0 and 1 through a sampler object, which the shader
 * multiplies. */
static void textures(struct gl *g, int seed, GLenum filter, GLenum wrap)
{
	glActiveTexture(GL_TEXTURE1);
	g->tex[1] = make_texture(seed + 1, 8);
	glActiveTexture(GL_TEXTURE0);
	g->tex[0] = make_texture(seed, 4);
	glGenSamplers(1, &g->sampler);
	glSamplerParameteri(g->sampler, GL_TEXTURE_MIN_FILTER, filter);
	glSamplerParameteri(g->sampler, GL_TEXTURE_MAG_FILTER, filter);
	glSamplerParameteri(g->sampler, GL_TEXTURE_WRAP_S, wrap);
	glSamplerParameteri(g->sampler, GL_TEXTURE_WRAP_T, wrap);
	glBindSampler(0, g->sampler);
	glBindSampler(1, g->sampler);
	glUniform1f(glGetUniformLocation(g->prog, "use_tex"), 1.0f);
}

static uint64_t frame_sum(int turn, const char *tag)
{
	static unsigned char px[W * H * 4];
	uint64_t h = 1469598103934665603ull;
	glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
	check("glReadPixels");
	for (size_t i = 0; i < sizeof(px); i++)
		h = (h ^ px[i]) * 1099511628211ull;
	printf("%s %d %016llx\n", tag, turn, (unsigned long long)h);
	fflush(stdout);
	if (outdir) {
		char path[512];
		FILE *f;
		snprintf(path, sizeof(path), "%s/%s.ppm", outdir, tag);
		f = fopen(path, "wb");
		if (f) {
			fprintf(f, "P6 %d %d 255\n", W, H);
			for (int y = H - 1; y >= 0; y--)
				for (int x = 0; x < W; x++)
					fwrite(&px[(y * W + x) * 4], 1, 3, f);
			fclose(f);
		}
	}
	return h;
}

static void sync_point(void)
{
	unsigned char px[4];
	glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
}

/* Clear and draw the twelve vertices, moved a little every turn. */
static void draw(struct gl *g, int turn)
{
	glClearColor(g->clear[0], g->clear[1], g->clear[2], g->clear[3]);
	glClearDepthf(g->clear_depth);
	glClearStencil(0);
	glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
	glUniform2f(g->shift_loc, 0.02f * (turn % 5), -0.03f * (turn % 3));
	glDrawArrays(GL_TRIANGLES, 0, NVERTS);
}

/* ---- variants: state set once in setup, relied on in every turn ---- */

static struct gl G[2];

static void v_tex(int turn)
{
	if (turn == 0) {
		static const float tint[4] = { 1.0f, 0.9f, 0.8f, 1.0f }, clr[4] = { 0.1f, 0.1f, 0.2f, 1 };
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], tint, clr);
		textures(&G[0], 2, GL_NEAREST, GL_REPEAT);
	}
	draw(&G[0], turn);
	frame_sum(turn, name);
}

static void v_raster(int turn)
{
	if (turn == 0) {
		static const float tint[4] = { 0.7f, 1.0f, 1.0f, 1.0f }, clr[4] = { 0.3f, 0.0f, 0.0f, 1 };
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], tint, clr);
		glEnable(GL_CULL_FACE);
		glCullFace(GL_FRONT);
		glFrontFace(GL_CW);
		glEnable(GL_SCISSOR_TEST);
		glScissor(6, 4, 50, 44);
		glViewport(4, 8, 52, 48);
		glDepthRangef(0.25f, 0.75f);
		glEnable(GL_DEPTH_TEST);
		glDepthFunc(GL_GEQUAL);
		G[0].clear_depth = 0.0f;
		glEnable(GL_POLYGON_OFFSET_FILL);
		glPolygonOffset(1.0f, 4.0f);
		glColorMask(GL_TRUE, GL_FALSE, GL_TRUE, GL_TRUE);
		glEnable(GL_BLEND);
		glBlendColor(0.2f, 0.4f, 0.6f, 0.5f);
		glBlendFuncSeparate(GL_CONSTANT_COLOR, GL_ONE, GL_ONE, GL_ZERO);
		glBlendEquation(GL_FUNC_ADD);
	}
	draw(&G[0], turn);
	frame_sum(turn, name);
}

static void v_stencil(int turn)
{
	if (turn == 0) {
		static const float tint[4] = { 1.0f, 1.0f, 1.0f, 0.5f }, clr[4] = { 0.0f, 0.2f, 0.1f, 1 };
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], tint, clr);
		textures(&G[0], 5, GL_LINEAR, GL_MIRRORED_REPEAT);
		glEnable(GL_STENCIL_TEST);
		glStencilFunc(GL_EQUAL, 0, 0xff);
		glStencilOp(GL_KEEP, GL_KEEP, GL_INCR);
		glStencilMask(0x0f);
		glEnable(GL_DEPTH_TEST);
		glDepthFunc(GL_ALWAYS);
		glDepthMask(GL_FALSE);
		glEnable(GL_BLEND);
		glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
		glBlendEquation(GL_MAX);
	}
	draw(&G[0], turn);
	frame_sum(turn, name);
}

/* Default state throughout, so any state left by another client shows; and
 * a vertex layout that alternates between two and three arrays, which
 * enables and disables attribute 1 every turn. */
static void v_plain(int turn)
{
	if (turn == 0) {
		static const float tint[4] = { 1, 1, 1, 1 }, clr[4] = { 0.2f, 0.2f, 0.2f, 1 };
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], tint, clr);
	}
	if (turn & 1) {
		glDisableVertexAttribArray(1);
		glVertexAttrib4f(1, 0.9f, 0.6f, 0.2f, 1.0f);
	} else {
		glEnableVertexAttribArray(1);
	}
	draw(&G[0], turn);
	frame_sum(turn, name);
}

/* An occlusion query open across a turn: begun on even turns around a draw
 * that is entirely clipped away, ended on odd turns. Any sample counted in
 * it came from another client. The frame shows the result as a colour. */
static void v_query(int turn)
{
	static const float off[] = { 3, 3, 0, 1, 1, 1, 1, 1, 0, 0,  4, 3, 0, 1, 1, 1, 1, 1, 0, 0,  3, 4, 0, 1, 1, 1, 1, 1, 0, 0 };
	if (turn == 0) {
		static const float tint[4] = { 1, 1, 1, 1 }, clr[4] = { 0, 0, 0.3f, 1 };
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], tint, clr);
		glGenQueries(1, &G[0].query);
		glEnable(GL_DEPTH_TEST);
		glDepthFunc(GL_LEQUAL);
	}
	if (!(turn & 1)) {
		glBeginQuery(GL_ANY_SAMPLES_PASSED, G[0].query);
		glBufferSubData(GL_ARRAY_BUFFER, 0, sizeof(off), off);
		glDrawArrays(GL_TRIANGLES, 0, 3);
		glFlush();
		sync_point();
		glBufferSubData(GL_ARRAY_BUFFER, 0, sizeof(off), verts);
		printf("%s %d begun\n", name, turn);
		fflush(stdout);
		return;
	}
	glEndQuery(GL_ANY_SAMPLES_PASSED);
	GLuint any = 7;
	glGetQueryObjectuiv(G[0].query, GL_QUERY_RESULT, &any);
	check("query");
	G[0].clear[0] = any ? 1.0f : 0.0f;
	G[0].clear[1] = any ? 0.0f : 1.0f;
	draw(&G[0], turn);
	printf("%s %d samples-passed=%u\n", name, turn, any);
	frame_sum(turn, name);
}

/* glGenerateMipmap on a 3D texture every turn: virgl sends blits between
 * levels of different depth, which the host runs through its GL blitter
 * (glBlitFramebuffer cannot). The level-1 result is checked too ("mip.l1"),
 * and the depth, scissor, blend, cull and luminance texture state set once
 * must survive the blitter. */
static void v_mip(int turn)
{
	static GLuint tex3d, rfbo;
	unsigned char vox[8 * 8 * 8 * 4];
	char tag[64];
	if (turn == 0) {
		static const float tint[4] = { 1, 1, 1, 1 }, clr[4] = { 0.25f, 0.1f, 0.3f, 1 };
		unsigned char lum[16 * 16];
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], tint, clr);
		glActiveTexture(GL_TEXTURE1);
		G[0].tex[1] = make_texture(3, 8);
		glActiveTexture(GL_TEXTURE0);
		glGenTextures(1, &G[0].tex[0]);
		glBindTexture(GL_TEXTURE_2D, G[0].tex[0]);
		for (int i = 0; i < 16 * 16; i++)
			lum[i] = (unsigned char)((i % 16) * 16 + (i / 16) * 5);
		glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, 16, 16, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, lum);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
		glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
		glUniform1f(glGetUniformLocation(G[0].prog, "use_tex"), 1.0f);
		glEnable(GL_DEPTH_TEST);
		glDepthFunc(GL_GREATER);
		G[0].clear_depth = 0.0f;
		glEnable(GL_SCISSOR_TEST);
		glScissor(2, 10, 58, 40);
		glEnable(GL_BLEND);
		glBlendFunc(GL_ONE, GL_ONE);
		glEnable(GL_CULL_FACE);
		glCullFace(GL_BACK);
		glColorMask(GL_TRUE, GL_TRUE, GL_FALSE, GL_TRUE);

		glActiveTexture(GL_TEXTURE2);
		glGenTextures(1, &tex3d);
		glBindTexture(GL_TEXTURE_3D, tex3d);
		glTexStorage3D(GL_TEXTURE_3D, 4, GL_RGBA8, 8, 8, 8);
		glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_NEAREST);
		glActiveTexture(GL_TEXTURE0);
		glGenFramebuffers(1, &rfbo);
	}
	for (int i = 0; i < 8 * 8 * 8; i++) {
		vox[i * 4 + 0] = (unsigned char)((i & 7) * 32 + turn * 11);
		vox[i * 4 + 1] = (unsigned char)(((i >> 3) & 7) * 32);
		vox[i * 4 + 2] = (unsigned char)((i >> 6) * 32 + turn * 5);
		vox[i * 4 + 3] = 255;
	}
	glActiveTexture(GL_TEXTURE2);
	glTexSubImage3D(GL_TEXTURE_3D, 0, 0, 0, 0, 8, 8, 8, GL_RGBA, GL_UNSIGNED_BYTE, vox);
	glGenerateMipmap(GL_TEXTURE_3D);
	glActiveTexture(GL_TEXTURE0);

	draw(&G[0], turn);
	frame_sum(turn, name);

	unsigned char px[4 * 4 * 4];
	uint64_t h = 1469598103934665603ull;
	glBindFramebuffer(GL_FRAMEBUFFER, rfbo);
	glFramebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, tex3d, 1, 1);
	glReadPixels(0, 0, 4, 4, GL_RGBA, GL_UNSIGNED_BYTE, px);
	glBindFramebuffer(GL_FRAMEBUFFER, G[0].fbo);
	check("mip level 1");
	for (size_t i = 0; i < sizeof(px); i++)
		h = (h ^ px[i]) * 1099511628211ull;
	snprintf(tag, sizeof(tag), "%s.l1", name);
	printf("%s %d %016llx\n", tag, turn, (unsigned long long)h);
	fflush(stdout);
}

/* Two contexts in one process (two renderer sub-contexts), alternated every
 * turn, each with its own state. */
static void v_dual(int turn)
{
	char tag[64];
	int i = turn & 1;
	if (turn == 0) {
		static const float t0[4] = { 1, 0.8f, 1, 1 }, c0[4] = { 0.1f, 0.3f, 0.1f, 1 };
		static const float t1[4] = { 0.9f, 1, 0.7f, 1 }, c1[4] = { 0.3f, 0.3f, 0.0f, 1 };
		G[0].ctx = make_context();
		use_context(G[0].ctx);
		init_gl(&G[0], t0, c0);
		textures(&G[0], 1, GL_LINEAR, GL_CLAMP_TO_EDGE);
		glEnable(GL_CULL_FACE);
		glEnable(GL_DEPTH_TEST);
		glDepthFunc(GL_LESS);
		glViewport(8, 0, 56, 60);
		G[1].ctx = make_context();
		use_context(G[1].ctx);
		init_gl(&G[1], t1, c1);
		glEnable(GL_BLEND);
		glBlendFunc(GL_ONE_MINUS_DST_COLOR, GL_ONE);
		glColorMask(GL_TRUE, GL_TRUE, GL_FALSE, GL_TRUE);
		glEnable(GL_SCISSOR_TEST);
		glScissor(0, 0, 40, 64);
	}
	use_context(G[i].ctx);
	draw(&G[i], turn);
	snprintf(tag, sizeof(tag), "%s.%d", name, i);
	frame_sum(turn, tag);
}

static const struct {
	const char *name;
	void (*turn)(int);
} variants[] = {
	{ "tex", v_tex }, { "raster", v_raster }, { "stencil", v_stencil },
	{ "plain", v_plain }, { "query", v_query }, { "mip", v_mip }, { "dual", v_dual },
};

static void run_variant(void (*fn)(int), int turns)
{
	init_egl();
	for (int t = 0; t < turns; t++) {
		take_turn();
		fn(t);
		check("turn");
		pass_turn();
	}
	eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
	eglTerminate(dpy);
}

int main(int argc, char **argv)
{
	int turns = 8, opt, n, (*pipes)[2], failed = 0;
	pid_t *pids;

	while ((opt = getopt(argc, argv, "t:o:")) != -1) {
		if (opt == 't')
			turns = atoi(optarg);
		else if (opt == 'o')
			outdir = optarg;
		else
			return 2;
	}
	n = argc - optind;
	if (n < 1 || turns < 2) {
		fprintf(stderr, "usage: kwgl-state [-t TURNS] [-o DIR] VARIANT...\n");
		return 2;
	}
	pipes = calloc(n, sizeof(*pipes));
	pids = calloc(n, sizeof(*pids));
	for (int i = 0; i < n; i++)
		if (pipe(pipes[i]))
			return 1;
	signal(SIGPIPE, SIG_IGN);
	for (int i = 0; i < n; i++) {
		const char *v = argv[optind + i];
		void (*fn)(int) = NULL;
		for (size_t k = 0; k < sizeof(variants) / sizeof(variants[0]); k++)
			if (!strcmp(variants[k].name, v))
				fn = variants[k].turn;
		if (!fn) {
			fprintf(stderr, "kwgl-state: unknown variant %s\n", v);
			return 2;
		}
		pids[i] = fork();
		if (pids[i] < 0)
			return 1;
		if (pids[i] == 0) {
			name = v;
			rd_fd = pipes[i][0];
			wr_fd = pipes[(i + 1) % n][1];
			run_variant(fn, turns);
			exit(0);
		}
	}
	if (write(pipes[0][1], "t", 1) != 1)
		return 1;
	for (int left = n; left > 0; left--) {
		int st, i;
		pid_t pid = wait(&st);
		if (pid < 0)
			return 1;
		for (i = 0; i < n && pids[i] != pid; i++)
			;
		if (i == n)
			continue;
		pids[i] = 0;
		if (!WIFEXITED(st) || WEXITSTATUS(st)) {
			if (!failed)
				fprintf(stderr, "kwgl-state: %s failed\n", argv[optind + i]);
			failed = 1;
			/* the ring is broken: stop the others, who wait for the token */
			for (int j = 0; j < n; j++)
				if (pids[j] > 0)
					kill(pids[j], SIGTERM);
		}
	}
	return failed;
}
