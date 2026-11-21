// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The three libepoxy queries virglrenderer makes, answered for emscripten's
// WebGL2 bindings: the host is GLES (never desktop GL), its version comes
// from GL_VERSION ("OpenGL ES 3.0 (WebGL 2.0 ...)", with
// -sGL_EMULATE_GLES_VERSION_STRING_FORMAT), and an extension is present when
// emscripten lists it in GL_EXTENSIONS (WebGL names, also with a "GL_" prefix,
// with -sGL_EXTENSIONS_IN_PREFIXED_FORMAT; emscripten lists only the
// extensions it binds, and enables each one when the context is registered).
// WebGL extension names are not GL extension names: a GL extension that
// WebGL provides under another name is not reported (work package 3).

#include <epoxy/gl.h>

#include <stdio.h>
#include <string.h>

bool epoxy_is_desktop_gl(void)
{
	return false;
}

int epoxy_gl_version(void)
{
	const char *v = (const char *)glGetString(GL_VERSION);
	int major = 0, minor = 0;

	if (!v || sscanf(v, "OpenGL ES %d.%d", &major, &minor) != 2)
		return 0;
	return major * 10 + minor;
}

int epoxy_glsl_version(void)
{
	const char *v = (const char *)glGetString(GL_SHADING_LANGUAGE_VERSION);
	int major = 0, minor = 0;

	if (!v || sscanf(v, "OpenGL ES GLSL ES %d.%d", &major, &minor) != 2)
		return 0;
	return major * 100 + minor;
}

bool epoxy_has_gl_extension(const char *ext)
{
	const char *list = (const char *)glGetString(GL_EXTENSIONS);
	size_t n = strlen(ext);
	const char *p;

	if (!list || !n)
		return false;
	for (p = list; (p = strstr(p, ext)); p += n) {
		if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == '\0'))
			return true;
	}
	return false;
}
