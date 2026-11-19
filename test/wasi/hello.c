// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts): prints its
// arguments, $KW_GREETING and the cwd, and exits with argc + 40.
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	char cwd[256];
	const char *g = getenv("KW_GREETING");

	for (int i = 0; i < argc; i++)
		printf("argv[%d]=%s\n", i, argv[i]);
	printf("KW_GREETING=%s\n", g ? g : "(unset)");
	printf("getcwd=%s\n", getcwd(cwd, sizeof(cwd)) ? cwd : "(error)");
	return argc + 40;
}
