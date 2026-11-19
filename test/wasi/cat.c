// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts): cat. Copies
// each file argument ("-" or none: stdin) to stdout; exit 1 if one fails.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int copy(int fd, const char *name)
{
	char buf[65536];
	ssize_t n;

	while ((n = read(fd, buf, sizeof(buf))) > 0)
		for (ssize_t at = 0; at < n;) {
			ssize_t w = write(1, buf + at, n - at);
			if (w < 0) {
				fprintf(stderr, "cat.wasm: write: %s\n", strerror(errno));
				return 1;
			}
			at += w;
		}
	if (n < 0) {
		fprintf(stderr, "cat.wasm: %s: %s\n", name, strerror(errno));
		return 1;
	}
	return 0;
}

int main(int argc, char **argv)
{
	int rc = 0;

	if (argc < 2)
		return copy(0, "-");
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "-")) {
			rc |= copy(0, "-");
			continue;
		}
		int fd = open(argv[i], O_RDONLY);
		if (fd < 0) {
			fprintf(stderr, "cat.wasm: %s: %s\n", argv[i], strerror(errno));
			rc = 1;
			continue;
		}
		rc |= copy(fd, argv[i]);
		close(fd);
	}
	return rc;
}
