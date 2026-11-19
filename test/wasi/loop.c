// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A compute loop for comparing wasm on the host with aarch64 in the guest
// (test/wasi-binfmt.ts): N rounds (default 100000000) of an xorshift hash.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv)
{
	uint64_t n = argc > 1 ? strtoull(argv[1], 0, 10) : 100000000, x = 88172645463325252ull, s = 0;

	for (uint64_t i = 0; i < n; i++) {
		x ^= x << 13;
		x ^= x >> 7;
		x ^= x << 17;
		s += x % 1000003;
	}
	printf("%llu\n", (unsigned long long)s);
	return 0;
}
