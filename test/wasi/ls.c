// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A wasm32-wasi test program for kwwasi (test/wasi-binfmt.ts): lists a
// directory (default ".") sorted, with each entry's type and size from stat.
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static int cmp(const void *a, const void *b)
{
	return strcmp(*(char *const *)a, *(char *const *)b);
}

int main(int argc, char **argv)
{
	const char *dir = argc > 1 ? argv[1] : ".";
	char *names[1024];
	int n = 0;
	DIR *d = opendir(dir);
	struct dirent *e;

	if (!d) {
		perror(dir);
		return 1;
	}
	while ((e = readdir(d)) && n < 1024)
		names[n++] = strdup(e->d_name);
	closedir(d);
	qsort(names, n, sizeof(*names), cmp);
	for (int i = 0; i < n; i++) {
		char path[1024];
		struct stat st;

		snprintf(path, sizeof(path), "%s/%s", dir, names[i]);
		if (stat(path, &st))
			printf("%s ?\n", names[i]);
		else
			printf("%s %s %lld\n", names[i], S_ISDIR(st.st_mode) ? "dir" : S_ISREG(st.st_mode) ? "file" : "other",
			       (long long)st.st_size);
	}
	return 0;
}
