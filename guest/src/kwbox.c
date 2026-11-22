// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * kwbox: the kw layer's guest tools as one program (static aarch64 musl),
 * /usr/bin/kwbox in the base's kw layer, so that they share one copy of
 * libc. guest/base/build.sh compiles each tool's source as an object of
 * its own with its main renamed (-Dmain=kwtty_main, ...) and links them
 * with this file; each source still builds alone.
 *
 *   kwbox TOOL [ARG...]   run TOOL: tty (kwtty.c), 9p (kw9p.c), vsock
 *                         (kwvsock.c), shm (kwshm.c), wasi (kwwasi.c), cmd
 *                         (kwcmd.c), vtest (gl/bridge/vtest-bridge.c, the
 *                         guest GL forwarder: vtest clients to the host),
 *                         with argv[0] and the process name (comm) the
 *                         program's own (kwtty, ..., vtest-bridge), so ps,
 *                         top and pidof tell the tools apart and their
 *                         messages keep their names
 *   /usr/lib/kw/kwwasi    kwwasi: binfmt_misc's interpreter for WASI
 *                         programs (/usr/lib/kw/rc registers this path,
 *                         and the kernel passes it as argv[0]; it cannot
 *                         pass a TOOL), a link to kwbox
 *   any other name        kwcmd's host command of that name: the links
 *                         /run/kw/bin/NAME -> /usr/bin/kwbox that
 *                         `kwbox cmd sync` makes (kwcmd.c)
 *
 * So a host command may have any name but kwbox and kwcmd
 * (js/core/commands.ts checkCommandName(), kwcmd.c valid_name()), the
 * tools' names included.
 */
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>

typedef int tool_main(int argc, char **argv);
tool_main kwtty_main, kw9p_main, kwvsock_main, kwshm_main, kwwasi_main, kwcmd_main, vtest_bridge_main;

/* kwbox's name for each, and the program's own (argv[0], comm). */
static const struct { const char *name, *prog; tool_main *main; } tools[] = {
	{ "tty", "kwtty", kwtty_main }, { "9p", "kw9p", kw9p_main },
	{ "vsock", "kwvsock", kwvsock_main }, { "shm", "kwshm", kwshm_main },
	{ "wasi", "kwwasi", kwwasi_main }, { "cmd", "kwcmd", kwcmd_main },
	{ "vtest", "vtest-bridge", vtest_bridge_main },
};

int main(int argc, char **argv)
{
	const char *base = argc ? strrchr(argv[0], '/') : NULL;

	base = base ? base + 1 : argc ? argv[0] : "kwbox";
	if (argc && !strcmp(argv[0], "/usr/lib/kw/kwwasi"))
		return kwwasi_main(argc, argv);
	if (strcmp(base, "kwbox"))
		return kwcmd_main(argc, argv);
	for (size_t i = 0; argc >= 2 && i < sizeof(tools) / sizeof(tools[0]); i++) {
		if (!strcmp(argv[1], tools[i].name)) {
			/* kwcmd tells sync and run from a host command by argv[0]. */
			argv[1] = (char *)tools[i].prog;
			prctl(PR_SET_NAME, tools[i].prog);
			return tools[i].main(argc - 1, argv + 1);
		}
	}
	fprintf(stderr, "usage: kwbox TOOL [ARG...], TOOL one of tty 9p vsock shm wasi cmd vtest\n");
	return 2;
}
