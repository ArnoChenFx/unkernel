// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// va-decode's export check (-e, -E): each shown picture exported with
// vaExportSurfaceHandle (DRM PRIME 2) and imported as EGLImages on the
// render node (EGL's surfaceless platform; libEGL.so.1 loaded at run time,
// GL entry points through eglGetProcAddress, so the program links nothing
// of EGL), then drawn into RGBA framebuffers and read back:
//
//   -e  separate layers (mpv's and Firefox's way): the Y plane (R8) and the
//       CbCr plane (GR88) as two GL_TEXTURE_2D images, each drawn as it is
//       (must equal the readback's planes exactly: 8-bit texels in, 8-bit
//       channels out, sampled at texel centres with GL_NEAREST through
//       normalized coordinates, so a size mismatch shows), then a BT.601
//       limited-range conversion to RGB in the shader against the same
//       formula on the CPU from the readback's NV12: within 1 per channel
//       (the GPU's float arithmetic and its rounding to 8 bits are not the
//       CPU's double; nothing else differs);
//   -E  also composed layers: NV12 as one EGLImage of two planes, sampled
//       through samplerExternalOES, Mesa converting (EGL's default hints:
//       BT.601, narrow range) against the CPU formula: within 3 (Mesa's own
//       coefficients and chroma siting differ in the last bits).
//
// The modifier the driver gives (LINEAR) is passed, as mpv, Firefox and
// GStreamer pass it. Large pictures have the RGB check on every 4th row
// (the CPU side runs under kwemu).
#include <dlfcn.h>
#include <fcntl.h>
#include <va/va_drmcommon.h>

#define KW_FOURCC(a, b, c, d) ((uint32_t)(a) | (uint32_t)(b) << 8 | (uint32_t)(c) << 16 | (uint32_t)(d) << 24)
#define KW_FOURCC_R8 KW_FOURCC('R', '8', ' ', ' ')
#define KW_FOURCC_GR88 KW_FOURCC('G', 'R', '8', '8')
#define KW_FOURCC_NV12 KW_FOURCC('N', 'V', '1', '2')

typedef void *EGLDisplay_, *EGLContext_, *EGLImage_;
typedef int32_t EGLint_;

#define X_EGL_NONE 0x3038
#define X_EGL_WIDTH 0x3057
#define X_EGL_HEIGHT 0x3056
#define X_EGL_OPENGL_ES_API 0x30A0
#define X_EGL_CONTEXT_MAJOR_VERSION 0x3098
#define X_EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#define X_EGL_LINUX_DMA_BUF_EXT 0x3270
#define X_EGL_LINUX_DRM_FOURCC_EXT 0x3271
#define X_EGL_DMA_BUF_PLANE0_FD_EXT 0x3272
#define X_EGL_DMA_BUF_PLANE0_OFFSET_EXT 0x3273
#define X_EGL_DMA_BUF_PLANE0_PITCH_EXT 0x3274
#define X_EGL_DMA_BUF_PLANE1_FD_EXT 0x3275
#define X_EGL_DMA_BUF_PLANE1_OFFSET_EXT 0x3276
#define X_EGL_DMA_BUF_PLANE1_PITCH_EXT 0x3277
#define X_EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT 0x3443
#define X_EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT 0x3444
#define X_EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT 0x3445
#define X_EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT 0x3446
#define X_EGL_EXTENSIONS 0x3055

#define X_GL_TEXTURE_2D 0x0DE1
#define X_GL_TEXTURE_EXTERNAL_OES 0x8D65
#define X_GL_TEXTURE_MIN_FILTER 0x2801
#define X_GL_TEXTURE_MAG_FILTER 0x2800
#define X_GL_NEAREST 0x2600
#define X_GL_TEXTURE_WRAP_S 0x2802
#define X_GL_TEXTURE_WRAP_T 0x2803
#define X_GL_CLAMP_TO_EDGE 0x812F
#define X_GL_FRAMEBUFFER 0x8D40
#define X_GL_COLOR_ATTACHMENT0 0x8CE0
#define X_GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define X_GL_RGBA 0x1908
#define X_GL_RGBA8 0x8058
#define X_GL_UNSIGNED_BYTE 0x1401
#define X_GL_VERTEX_SHADER 0x8B31
#define X_GL_FRAGMENT_SHADER 0x8B30
#define X_GL_COMPILE_STATUS 0x8B81
#define X_GL_LINK_STATUS 0x8B82
#define X_GL_TRIANGLES 0x0004
#define X_GL_TEXTURE0 0x84C0
#define X_GL_RENDERER 0x1F01
#define X_GL_PACK_ALIGNMENT 0x0D05

static struct {
	int on, composed;
	EGLDisplay_ dpy;
	unsigned prog[3]; /* plane copy, RGB from two planes, RGB from an external image */
	unsigned fbo, rt, vao;
	int rtw, rth;
	uint8_t *px;
	size_t pxcap;
	/* results */
	int frames, plane_bad, rgb_bad, ext_bad, ext_frames;
	int rgb_max, ext_max;
	double ms;
	/* EGL */
	EGLDisplay_ (*GetPlatformDisplay)(unsigned, void *, const intptr_t *);
	unsigned (*Initialize)(EGLDisplay_, EGLint_ *, EGLint_ *);
	unsigned (*BindAPI)(unsigned);
	EGLContext_ (*CreateContext)(EGLDisplay_, void *, EGLContext_, const EGLint_ *);
	unsigned (*MakeCurrent)(EGLDisplay_, void *, void *, EGLContext_);
	EGLImage_ (*CreateImageKHR)(EGLDisplay_, EGLContext_, unsigned, void *, const EGLint_ *);
	unsigned (*DestroyImageKHR)(EGLDisplay_, EGLImage_);
	EGLint_ (*GetError)(void);
	const char *(*QueryString)(EGLDisplay_, EGLint_);
	/* GL */
	void (*ImageTarget)(unsigned, void *);
	void (*GenTextures)(int, unsigned *);
	void (*DeleteTextures)(int, const unsigned *);
	void (*BindTexture)(unsigned, unsigned);
	void (*TexParameteri)(unsigned, unsigned, int);
	void (*TexImage2D)(unsigned, int, int, int, int, int, unsigned, unsigned, const void *);
	void (*GenFramebuffers)(int, unsigned *);
	void (*BindFramebuffer)(unsigned, unsigned);
	void (*FramebufferTexture2D)(unsigned, unsigned, unsigned, unsigned, int);
	unsigned (*CheckFramebufferStatus)(unsigned);
	unsigned (*CreateShader)(unsigned);
	void (*ShaderSource)(unsigned, int, const char *const *, const int *);
	void (*CompileShader)(unsigned);
	void (*GetShaderiv)(unsigned, unsigned, int *);
	void (*GetShaderInfoLog)(unsigned, int, int *, char *);
	unsigned (*CreateProgram)(void);
	void (*AttachShader)(unsigned, unsigned);
	void (*LinkProgram)(unsigned);
	void (*GetProgramiv)(unsigned, unsigned, int *);
	void (*GetProgramInfoLog)(unsigned, int, int *, char *);
	void (*UseProgram)(unsigned);
	int (*GetUniformLocation)(unsigned, const char *);
	void (*Uniform1i)(int, int);
	void (*Uniform2f)(int, float, float);
	void (*ActiveTexture)(unsigned);
	void (*Viewport)(int, int, int, int);
	void (*DrawArrays)(unsigned, int, int);
	void (*ReadPixels)(int, int, int, int, unsigned, unsigned, void *);
	void (*PixelStorei)(unsigned, int);
	void (*GenVertexArrays)(int, unsigned *);
	void (*BindVertexArray)(unsigned);
	const char *(*GetString)(unsigned);
	unsigned (*GetGLError)(void);
} X;

static const char *vs_src = "#version 300 es\n"
			    "void main() {\n"
			    "  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);\n"
			    "  gl_Position = vec4(p, 0.0, 1.0);\n"
			    "}\n";
/* each texel of a plane as it is: R8 -> r, GR88 -> r, g */
static const char *fs_plane = "#version 300 es\n"
			      "precision highp float;\n"
			      "uniform highp sampler2D t;\n"
			      "uniform vec2 size;\n"
			      "out vec4 o;\n"
			      "void main() { vec4 v = texture(t, gl_FragCoord.xy / size); o = vec4(v.r, v.g, 0.0, 1.0); }\n";
/* BT.601 limited range from the two planes, chroma at the even luma sample (as the CPU side) */
static const char *fs_rgb = "#version 300 es\n"
			    "precision highp float;\n"
			    "uniform highp sampler2D ty, tc;\n"
			    "uniform vec2 size, csize;\n"
			    "out vec4 o;\n"
			    "void main() {\n"
			    "  vec2 p = floor(gl_FragCoord.xy);\n"
			    "  float y = texture(ty, (p + 0.5) / size).r * 255.0 - 16.0;\n"
			    "  vec2 c = texture(tc, (floor(p / 2.0) + 0.5) / csize).rg * 255.0 - 128.0;\n"
			    "  vec3 rgb = vec3(1.164383 * y + 1.596027 * c.y, 1.164383 * y - 0.391762 * c.x - 0.812968 * c.y, 1.164383 * y + 2.017232 * c.x);\n"
			    "  o = vec4(clamp(rgb / 255.0, 0.0, 1.0), 1.0);\n"
			    "}\n";
static const char *fs_ext = "#version 300 es\n"
			    "#extension GL_OES_EGL_image_external_essl3 : require\n"
			    "precision highp float;\n"
			    "uniform samplerExternalOES t;\n"
			    "uniform vec2 size;\n"
			    "out vec4 o;\n"
			    "void main() { o = vec4(texture(t, gl_FragCoord.xy / size).rgb, 1.0); }\n";

static void *egl_lib;

static void *gp(const char *name)
{
	void *(*get)(const char *) = (void *(*)(const char *))dlsym(egl_lib, "eglGetProcAddress");
	void *f = get ? get(name) : NULL;
	return f ? f : dlsym(egl_lib, name);
}

static unsigned shader(unsigned kind, const char *src)
{
	unsigned s = X.CreateShader(kind);
	int ok = 0;
	X.ShaderSource(s, 1, &src, NULL);
	X.CompileShader(s);
	X.GetShaderiv(s, X_GL_COMPILE_STATUS, &ok);
	if (!ok) {
		char log[1024] = "";
		X.GetShaderInfoLog(s, sizeof log, NULL, log);
		fprintf(stderr, "va-decode: a shader did not compile: %s\n", log);
		exit(1);
	}
	return s;
}

static unsigned program(const char *fs)
{
	unsigned p = X.CreateProgram();
	int ok = 0;
	X.AttachShader(p, shader(X_GL_VERTEX_SHADER, vs_src));
	X.AttachShader(p, shader(X_GL_FRAGMENT_SHADER, fs));
	X.LinkProgram(p);
	X.GetProgramiv(p, X_GL_LINK_STATUS, &ok);
	if (!ok) {
		char log[1024] = "";
		X.GetProgramInfoLog(p, sizeof log, NULL, log);
		fprintf(stderr, "va-decode: a program did not link: %s\n", log);
		exit(1);
	}
	return p;
}

#define LOAD(field, name)                                                         \
	do {                                                                      \
		*(void **)&X.field = gp(name);                                    \
		if (!X.field) {                                                   \
			fprintf(stderr, "va-decode: no %s in libEGL.so.1\n", name); \
			exit(2);                                                  \
		}                                                                 \
	} while (0)

static void exp_init(int composed)
{
	X.on = 1;
	X.composed = composed;
	if (!(egl_lib = dlopen("libEGL.so.1", RTLD_NOW | RTLD_GLOBAL))) {
		fprintf(stderr, "va-decode: %s (apt-get install libegl1 libegl-mesa0)\n", dlerror());
		exit(2);
	}
	LOAD(GetPlatformDisplay, "eglGetPlatformDisplay");
	LOAD(Initialize, "eglInitialize");
	LOAD(BindAPI, "eglBindAPI");
	LOAD(CreateContext, "eglCreateContext");
	LOAD(MakeCurrent, "eglMakeCurrent");
	LOAD(CreateImageKHR, "eglCreateImageKHR");
	LOAD(DestroyImageKHR, "eglDestroyImageKHR");
	LOAD(GetError, "eglGetError");
	LOAD(QueryString, "eglQueryString");
	X.dpy = X.GetPlatformDisplay(X_EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
	EGLint_ maj = 0, min = 0;
	if (!X.dpy || !X.Initialize(X.dpy, &maj, &min)) {
		fprintf(stderr, "va-decode: no surfaceless EGL display (0x%x)\n", X.GetError());
		exit(1);
	}
	const char *ext = X.QueryString(X.dpy, X_EGL_EXTENSIONS);
	if (!ext || !strstr(ext, "EGL_EXT_image_dma_buf_import") || !strstr(ext, "EGL_KHR_no_config_context") ||
	    !strstr(ext, "EGL_KHR_surfaceless_context")) {
		fprintf(stderr, "va-decode: EGL lacks dma-buf import or no-config surfaceless contexts: %s\n", ext ? ext : "?");
		exit(1);
	}
	X.BindAPI(X_EGL_OPENGL_ES_API);
	EGLint_ ca[] = {X_EGL_CONTEXT_MAJOR_VERSION, 3, X_EGL_NONE};
	EGLContext_ ctx = X.CreateContext(X.dpy, NULL, NULL, ca);
	if (!ctx || !X.MakeCurrent(X.dpy, NULL, NULL, ctx)) {
		fprintf(stderr, "va-decode: no GLES 3 context (0x%x)\n", X.GetError());
		exit(1);
	}
	LOAD(ImageTarget, "glEGLImageTargetTexture2DOES");
	LOAD(GenTextures, "glGenTextures");
	LOAD(DeleteTextures, "glDeleteTextures");
	LOAD(BindTexture, "glBindTexture");
	LOAD(TexParameteri, "glTexParameteri");
	LOAD(TexImage2D, "glTexImage2D");
	LOAD(GenFramebuffers, "glGenFramebuffers");
	LOAD(BindFramebuffer, "glBindFramebuffer");
	LOAD(FramebufferTexture2D, "glFramebufferTexture2D");
	LOAD(CheckFramebufferStatus, "glCheckFramebufferStatus");
	LOAD(CreateShader, "glCreateShader");
	LOAD(ShaderSource, "glShaderSource");
	LOAD(CompileShader, "glCompileShader");
	LOAD(GetShaderiv, "glGetShaderiv");
	LOAD(GetShaderInfoLog, "glGetShaderInfoLog");
	LOAD(CreateProgram, "glCreateProgram");
	LOAD(AttachShader, "glAttachShader");
	LOAD(LinkProgram, "glLinkProgram");
	LOAD(GetProgramiv, "glGetProgramiv");
	LOAD(GetProgramInfoLog, "glGetProgramInfoLog");
	LOAD(UseProgram, "glUseProgram");
	LOAD(GetUniformLocation, "glGetUniformLocation");
	LOAD(Uniform1i, "glUniform1i");
	LOAD(Uniform2f, "glUniform2f");
	LOAD(ActiveTexture, "glActiveTexture");
	LOAD(Viewport, "glViewport");
	LOAD(DrawArrays, "glDrawArrays");
	LOAD(ReadPixels, "glReadPixels");
	LOAD(PixelStorei, "glPixelStorei");
	LOAD(GenVertexArrays, "glGenVertexArrays");
	LOAD(BindVertexArray, "glBindVertexArray");
	LOAD(GetString, "glGetString");
	LOAD(GetGLError, "glGetError");
	printf("export check: EGL %d.%d, GL_RENDERER %s, %s layers%s\n", maj, min, X.GetString(X_GL_RENDERER),
	       composed ? "separate and composed" : "separate", strstr(ext, "EGL_EXT_image_dma_buf_import_modifiers") ? ", modifiers" : "");
	X.prog[0] = program(fs_plane);
	X.prog[1] = program(fs_rgb);
	if (composed)
		X.prog[2] = program(fs_ext);
	X.GenVertexArrays(1, &X.vao);
	X.BindVertexArray(X.vao);
	X.GenFramebuffers(1, &X.fbo);
	X.GenTextures(1, &X.rt);
	X.PixelStorei(X_GL_PACK_ALIGNMENT, 1);
}

/* draw with the bound program into a w x h RGBA8 target and read it back into X.px (row 0 first) */
static void draw_read(int w, int h)
{
	if (w != X.rtw || h != X.rth) {
		/* on a unit of its own: the planes' textures are bound on 0 and 1 */
		X.ActiveTexture(X_GL_TEXTURE0 + 7);
		X.BindTexture(X_GL_TEXTURE_2D, X.rt);
		X.TexImage2D(X_GL_TEXTURE_2D, 0, X_GL_RGBA8, w, h, 0, X_GL_RGBA, X_GL_UNSIGNED_BYTE, NULL);
		X.ActiveTexture(X_GL_TEXTURE0);
		X.BindFramebuffer(X_GL_FRAMEBUFFER, X.fbo);
		X.FramebufferTexture2D(X_GL_FRAMEBUFFER, X_GL_COLOR_ATTACHMENT0, X_GL_TEXTURE_2D, X.rt, 0);
		if (X.CheckFramebufferStatus(X_GL_FRAMEBUFFER) != X_GL_FRAMEBUFFER_COMPLETE) {
			fprintf(stderr, "va-decode: the %dx%d framebuffer is incomplete\n", w, h);
			exit(1);
		}
		X.rtw = w, X.rth = h;
	}
	if ((size_t)w * h * 4 > X.pxcap && !(X.px = realloc(X.px, X.pxcap = (size_t)w * h * 4)))
		exit(1);
	X.BindFramebuffer(X_GL_FRAMEBUFFER, X.fbo);
	X.Viewport(0, 0, w, h);
	X.DrawArrays(X_GL_TRIANGLES, 0, 3);
	X.ReadPixels(0, 0, w, h, X_GL_RGBA, X_GL_UNSIGNED_BYTE, X.px);
}

static unsigned image_tex(unsigned target, EGLImage_ img)
{
	unsigned t;
	X.GenTextures(1, &t);
	X.BindTexture(target, t);
	X.TexParameteri(target, X_GL_TEXTURE_MIN_FILTER, X_GL_NEAREST);
	X.TexParameteri(target, X_GL_TEXTURE_MAG_FILTER, X_GL_NEAREST);
	X.TexParameteri(target, X_GL_TEXTURE_WRAP_S, X_GL_CLAMP_TO_EDGE);
	X.TexParameteri(target, X_GL_TEXTURE_WRAP_T, X_GL_CLAMP_TO_EDGE);
	X.ImageTarget(target, img);
	return t;
}

static int clamp255(double v)
{
	/* round to nearest (libm-free: the program links only libdl) */
	return v < 0 ? 0 : v >= 254.5 ? 255 : (int)(v + 0.5);
}

/* BT.601 limited range, as fs_rgb */
static void rgb601(int Y, int U, int V, int out[3])
{
	double y = Y - 16.0, u = U - 128.0, v = V - 128.0;
	out[0] = clamp255(1.164383 * y + 1.596027 * v);
	out[1] = clamp255(1.164383 * y - 0.391762 * u - 0.812968 * v);
	out[2] = clamp255(1.164383 * y + 2.017232 * u);
}

/* the largest channel difference of X.px against the CPU's conversion of the I420 picture, on every `step`-th row */
static int rgb_diff(const uint8_t *i420, int w, int h, int step)
{
	int cw = (w + 1) / 2, ch = (h + 1) / 2, worst = 0;
	const uint8_t *py = i420, *pu = i420 + (size_t)w * h, *pv = pu + (size_t)cw * ch;
	for (int y = 0; y < h; y += step)
		for (int x = 0; x < w; x++) {
			int ref[3];
			rgb601(py[(size_t)y * w + x], pu[(size_t)(y / 2) * cw + x / 2], pv[(size_t)(y / 2) * cw + x / 2], ref);
			const uint8_t *g = X.px + ((size_t)y * w + x) * 4;
			for (int k = 0; k < 3; k++) {
				int d = abs(g[k] - ref[k]);
				if (d > worst)
					worst = d;
			}
		}
	return worst;
}

static int exp_import(int fourcc, int w, int h, int nplanes, const int *fd, const uint32_t *off, const uint32_t *pitch, const uint64_t *mod, EGLImage_ *out)
{
	EGLint_ a[40];
	int n = 0;
	a[n++] = X_EGL_LINUX_DRM_FOURCC_EXT, a[n++] = fourcc, a[n++] = X_EGL_WIDTH, a[n++] = w, a[n++] = X_EGL_HEIGHT, a[n++] = h;
	static const EGLint_ keys[2][5] = {{X_EGL_DMA_BUF_PLANE0_FD_EXT, X_EGL_DMA_BUF_PLANE0_OFFSET_EXT, X_EGL_DMA_BUF_PLANE0_PITCH_EXT, X_EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, X_EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT},
					   {X_EGL_DMA_BUF_PLANE1_FD_EXT, X_EGL_DMA_BUF_PLANE1_OFFSET_EXT, X_EGL_DMA_BUF_PLANE1_PITCH_EXT, X_EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT, X_EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT}};
	for (int i = 0; i < nplanes; i++) {
		a[n++] = keys[i][0], a[n++] = fd[i];
		a[n++] = keys[i][1], a[n++] = (EGLint_)off[i];
		a[n++] = keys[i][2], a[n++] = (EGLint_)pitch[i];
		a[n++] = keys[i][3], a[n++] = (EGLint_)(mod[i] & 0xffffffffu);
		a[n++] = keys[i][4], a[n++] = (EGLint_)(mod[i] >> 32);
	}
	a[n] = X_EGL_NONE;
	*out = X.CreateImageKHR(X.dpy, NULL, X_EGL_LINUX_DMA_BUF_EXT, NULL, a);
	if (!*out) {
		fprintf(stderr, "va-decode: eglCreateImageKHR(%.4s %dx%d, %d plane(s)): 0x%x\n", (const char *)&fourcc, w, h, nplanes, X.GetError());
		return -1;
	}
	return 0;
}

static VADRMPRIMESurfaceDescriptor exp_desc;
static double exp_t0;

/* a shown picture's export, before its readback and sync (as mpv: export, then vaSyncSurface) */
static VAStatus exp_export(struct VADriverVTable *vt, VADriverContextP c, VASurfaceID s)
{
	exp_t0 = now();
	return vt->vaExportSurfaceHandle(c, s, VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2, VA_EXPORT_SURFACE_READ_ONLY | VA_EXPORT_SURFACE_SEPARATE_LAYERS, &exp_desc);
}

/* then, synced and read back (I420, w x h): import, draw, read the framebuffers back, compare */
static int exp_frame(struct VADriverVTable *vt, VADriverContextP c, VASurfaceID s, const uint8_t *i420, int w, int h, char *note, size_t notecap)
{
	double t0 = exp_t0;
	VAStatus st;
	VADRMPRIMESurfaceDescriptor d = exp_desc;
	int bad = 0, cw = (w + 1) / 2, ch = (h + 1) / 2, sw = (int)d.width, sh = (int)d.height;
	if (d.fourcc != VA_FOURCC_NV12 || d.num_layers != 2 || d.layers[0].drm_format != KW_FOURCC_R8 || d.layers[1].drm_format != KW_FOURCC_GR88) {
		snprintf(note, notecap, " export: an unexpected descriptor");
		bad = 1;
	}
	EGLImage_ im[2] = {NULL, NULL};
	for (int i = 0; i < 2 && !bad; i++) {
		int o = d.layers[i].object_index[0];
		uint64_t mod = d.objects[o].drm_format_modifier;
		if (exp_import(d.layers[i].drm_format, i ? (sw + 1) / 2 : sw, i ? (sh + 1) / 2 : sh, 1, &d.objects[o].fd, &d.layers[i].offset[0], &d.layers[i].pitch[0], &mod, &im[i]))
			bad = 1;
	}
	int worst = -1;
	if (!bad) {
		unsigned ty = image_tex(X_GL_TEXTURE_2D, im[0]), tc = image_tex(X_GL_TEXTURE_2D, im[1]);
		/* the planes as they are: exact */
		X.UseProgram(X.prog[0]);
		X.Uniform1i(X.GetUniformLocation(X.prog[0], "t"), 0);
		X.ActiveTexture(X_GL_TEXTURE0);
		X.BindTexture(X_GL_TEXTURE_2D, ty);
		X.Uniform2f(X.GetUniformLocation(X.prog[0], "size"), (float)sw, (float)sh);
		draw_read(w, h);
		for (int y = 0; y < h && !bad; y++)
			for (int x = 0; x < w; x++)
				if (X.px[((size_t)y * w + x) * 4] != i420[(size_t)y * w + x]) {
					snprintf(note, notecap, " Y differs at %d,%d: %d, read back %d", x, y, X.px[((size_t)y * w + x) * 4], i420[(size_t)y * w + x]);
					bad = 1;
					break;
				}
		X.BindTexture(X_GL_TEXTURE_2D, tc);
		X.Uniform2f(X.GetUniformLocation(X.prog[0], "size"), (float)((sw + 1) / 2), (float)((sh + 1) / 2));
		draw_read(cw, ch);
		const uint8_t *pu = i420 + (size_t)w * h, *pv = pu + (size_t)cw * ch;
		for (int y = 0; y < ch && !bad; y++)
			for (int x = 0; x < cw; x++) {
				const uint8_t *g = X.px + ((size_t)y * cw + x) * 4;
				if (g[0] != pu[(size_t)y * cw + x] || g[1] != pv[(size_t)y * cw + x]) {
					snprintf(note, notecap, " CbCr differs at %d,%d: %d,%d, read back %d,%d", x, y, g[0], g[1], pu[(size_t)y * cw + x], pv[(size_t)y * cw + x]);
					bad = 1;
					break;
				}
			}
		X.plane_bad += bad;
		/* converted in the shader: within 1 */
		X.UseProgram(X.prog[1]);
		X.Uniform1i(X.GetUniformLocation(X.prog[1], "ty"), 0);
		X.Uniform1i(X.GetUniformLocation(X.prog[1], "tc"), 1);
		X.Uniform2f(X.GetUniformLocation(X.prog[1], "size"), (float)sw, (float)sh);
		X.Uniform2f(X.GetUniformLocation(X.prog[1], "csize"), (float)((sw + 1) / 2), (float)((sh + 1) / 2));
		X.ActiveTexture(X_GL_TEXTURE0);
		X.BindTexture(X_GL_TEXTURE_2D, ty);
		X.ActiveTexture(X_GL_TEXTURE0 + 1);
		X.BindTexture(X_GL_TEXTURE_2D, tc);
		X.ActiveTexture(X_GL_TEXTURE0);
		draw_read(w, h);
		worst = rgb_diff(i420, w, h, w * h > 640 * 480 ? 4 : 1);
		if (worst > X.rgb_max)
			X.rgb_max = worst;
		if (worst > 1) {
			X.rgb_bad++;
			bad = 1;
		}
		unsigned del[2] = {ty, tc};
		X.DeleteTextures(2, del);
	}
	for (int i = 0; i < 2; i++)
		if (im[i])
			X.DestroyImageKHR(X.dpy, im[i]);
	for (uint32_t i = 0; i < d.num_objects; i++)
		close(d.objects[i].fd);
	int eworst = -1;
	if (X.composed && !bad) {
		/* NV12 as one image, Mesa converting */
		VADRMPRIMESurfaceDescriptor e;
		st = vt->vaExportSurfaceHandle(c, s, VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2, VA_EXPORT_SURFACE_READ_ONLY | VA_EXPORT_SURFACE_COMPOSED_LAYERS, &e);
		EGLImage_ img = NULL;
		if (st != VA_STATUS_SUCCESS || e.num_layers != 1 || e.layers[0].num_planes != 2 || e.layers[0].drm_format != KW_FOURCC_NV12) {
			snprintf(note, notecap, " composed export: status %d, %u layers", st, st == VA_STATUS_SUCCESS ? e.num_layers : 0);
			bad = 1;
		} else {
			int fds[2] = {e.objects[e.layers[0].object_index[0]].fd, e.objects[e.layers[0].object_index[1]].fd};
			uint64_t mods[2] = {e.objects[e.layers[0].object_index[0]].drm_format_modifier, e.objects[e.layers[0].object_index[1]].drm_format_modifier};
			if (exp_import(KW_FOURCC_NV12, (int)e.width, (int)e.height, 2, fds, e.layers[0].offset, e.layers[0].pitch, mods, &img))
				bad = 1;
			else {
				unsigned t = image_tex(X_GL_TEXTURE_EXTERNAL_OES, img);
				X.UseProgram(X.prog[2]);
				X.Uniform1i(X.GetUniformLocation(X.prog[2], "t"), 0);
				X.Uniform2f(X.GetUniformLocation(X.prog[2], "size"), (float)e.width, (float)e.height);
				draw_read(w, h);
				eworst = rgb_diff(i420, w, h, w * h > 640 * 480 ? 4 : 1);
				X.ext_frames++;
				if (eworst > X.ext_max)
					X.ext_max = eworst;
				if (eworst > 3) {
					X.ext_bad++;
					bad = 1;
				}
				X.DeleteTextures(1, &t);
				X.DestroyImageKHR(X.dpy, img);
			}
			for (uint32_t i = 0; i < e.num_objects; i++)
				close(e.objects[i].fd);
		}
	}
	unsigned ge = X.GetGLError();
	if (ge) {
		snprintf(note + strlen(note), notecap - strlen(note), " GL error 0x%x", ge);
		bad = 1;
	}
	X.frames++;
	X.ms += (now() - t0) * 1000;
	if (!bad)
		snprintf(note, notecap, " export: planes exact, RGB within %d%s", worst, eworst >= 0 ? "" : "");
	if (eworst >= 0 && !bad)
		snprintf(note + strlen(note), notecap - strlen(note), ", composed RGB within %d", eworst);
	return bad ? -1 : 0;
}

static void exp_summary(void)
{
	if (!X.on)
		return;
	printf("export check: %d frames, planes exact on %d, RGB within 1 on %d (largest difference %d)", X.frames, X.frames - X.plane_bad,
	       X.frames - X.plane_bad - X.rgb_bad, X.rgb_max);
	if (X.composed)
		printf(", composed RGB within 3 on %d of %d (largest %d)", X.ext_frames - X.ext_bad, X.ext_frames, X.ext_max);
	printf("; %.1f ms a frame\n", X.frames ? X.ms / X.frames : 0);
}
