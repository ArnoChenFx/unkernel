// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts): creates
// files and directories, for the cwd checks.
//   put.wasm PATH TEXT   PATH (created or truncated) gets TEXT and a newline
//   put.wasm -d PATH     mkdir PATH
// Exit 1 with the error on stderr when it fails.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if (argc != 3) {
		fprintf(stderr, "usage: put.wasm PATH TEXT | -d PATH\n");
		return 2;
	}
	if (!strcmp(argv[1], "-d")) {
		if (mkdir(argv[2], 0777)) {
			fprintf(stderr, "put.wasm: mkdir %s: %s\n", argv[2], strerror(errno));
			return 1;
		}
		return 0;
	}
	int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0666);
	if (fd < 0 || dprintf(fd, "%s\n", argv[2]) < 0 || close(fd)) {
		fprintf(stderr, "put.wasm: %s: %s\n", argv[1], strerror(errno));
		return 1;
	}
	return 0;
}
