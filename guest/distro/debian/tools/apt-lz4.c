// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// stdin to stdout as an lz4 frame byte for byte as apt writes its package
// lists with Acquire::GzipIndexes (apt-pkg/contrib/fileutl.cc, Lz4FileImpl;
// methods/store.cc copies in APT_BUFFER_SIZE pieces): LZ4F_compressBegin
// with the default preferences (64 KiB linked blocks, no checksums, level
// 0) and one LZ4F_compressUpdate per 64 KiB of input. The lz4 tool makes
// another (equally valid) frame. Built by apt-lz4.sh with the pinned lz4.
#include <stdio.h>
#include <stdlib.h>
#include "lz4frame.h"

#define APT_BUFFER_SIZE (64 * 1024)

static void fail(const char *what, size_t r)
{
	fprintf(stderr, "apt-lz4: %s: %s\n", what, LZ4F_getErrorName(r));
	exit(1);
}

static void put(const void *b, size_t n)
{
	if (fwrite(b, 1, n, stdout) != n) {
		perror("apt-lz4: write");
		exit(1);
	}
}

int main(void)
{
	static unsigned char in[APT_BUFFER_SIZE];
	size_t cap = LZ4F_compressBound(APT_BUFFER_SIZE, NULL) + 64;
	unsigned char *out = malloc(cap);
	LZ4F_cctx *c;
	size_t r = LZ4F_createCompressionContext(&c, LZ4F_VERSION);

	if (!out || LZ4F_isError(r))
		fail("context", r);
	r = LZ4F_compressBegin(c, out, cap, NULL);
	if (LZ4F_isError(r))
		fail("begin", r);
	put(out, r);
	for (;;) {
		size_t n = 0, k;

		// FileFd::Read fills the buffer unless the input ends.
		while (n < APT_BUFFER_SIZE && (k = fread(in + n, 1, APT_BUFFER_SIZE - n, stdin)) > 0)
			n += k;
		if (ferror(stdin)) {
			perror("apt-lz4: read");
			return 1;
		}
		if (n == 0)
			break;
		r = LZ4F_compressUpdate(c, out, cap, in, n, NULL);
		if (LZ4F_isError(r))
			fail("update", r);
		put(out, r);
		if (n < APT_BUFFER_SIZE)
			break;
	}
	r = LZ4F_compressEnd(c, out, cap, NULL);
	if (LZ4F_isError(r))
		fail("end", r);
	put(out, r);
	if (fclose(stdout)) {
		perror("apt-lz4: write");
		return 1;
	}
	return 0;
}
