// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts): prints
// "variant " and its build's VARIANT (-DVARIANT='"A"'), so that two builds
// are modules of the same size with different behavior.
#include <stdio.h>

int main(void)
{
	puts("variant " VARIANT);
	return 0;
}
