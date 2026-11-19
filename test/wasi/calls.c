// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A call-heavy wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts):
// N small requests to kwwasi, to measure the cost of one.
//   calls.wasm write N        N one-byte write()s to stdout
//   calls.wasm pread N FILE   N 16-byte pread()s of FILE at offset 0
//   calls.wasm stat N PATH    N stat()s of PATH
//   calls.wasm copy N         stdin to stdout with one N-byte buffer (large
//                             reads and writes)
//   calls.wasm reread N FILE  N 16-byte read()s of FILE, each after a seek to 0
//   calls.wasm nbread         one read() of a nonblocking stdin: prints
//                             "EAGAIN" or "read N"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if (argc < 3) {
		if (argc == 2 && !strcmp(argv[1], "nbread")) {
			char b[64];
			ssize_t got;

			if (fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK))
				return 1;
			got = read(0, b, sizeof(b));
			if (got < 0 && errno == EAGAIN)
				printf("EAGAIN\n");
			else if (got < 0)
				printf("error %d\n", errno);
			else
				printf("read %zd\n", got);
			return 0;
		}
		fprintf(stderr, "usage: calls.wasm write|pread|stat|copy|reread N [PATH], calls.wasm nbread\n");
		return 2;
	}
	long n = strtol(argv[2], 0, 10);
	char buf[16];
	struct stat st;

	if (!strcmp(argv[1], "write")) {
		for (long i = 0; i < n; i++)
			if (write(1, "x", 1) != 1)
				return 1;
		return 0;
	}
	if (!strcmp(argv[1], "copy")) {
		char *big = malloc(n);
		ssize_t got;

		if (!big)
			return 1;
		while ((got = read(0, big, n)) > 0)
			for (ssize_t at = 0; at < got;) {
				ssize_t w = write(1, big + at, got - at);
				if (w < 0)
					return 1;
				at += w;
			}
		return got < 0;
	}
	if (argc < 4)
		return 2;
	if (!strcmp(argv[1], "pread")) {
		int fd = open(argv[3], O_RDONLY);
		if (fd < 0)
			return 1;
		for (long i = 0; i < n; i++)
			if (pread(fd, buf, sizeof(buf), 0) < 0)
				return 1;
		return 0;
	}
	if (!strcmp(argv[1], "reread")) {
		int fd = open(argv[3], O_RDONLY);
		if (fd < 0)
			return 1;
		for (long i = 0; i < n; i++)
			if (lseek(fd, 0, SEEK_SET) || read(fd, buf, sizeof(buf)) <= 0)
				return 1;
		return 0;
	}
	if (!strcmp(argv[1], "stat")) {
		for (long i = 0; i < n; i++)
			if (stat(argv[3], &st))
				return 1;
		return 0;
	}
	return 2;
}
