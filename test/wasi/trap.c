// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts): prints a
// line, then traps (unreachable).
#include <stdio.h>

int main(void)
{
	printf("before trap\n");
	fflush(stdout);
	__builtin_trap();
}
