// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A WASI preview 0 (wasi_unstable) test program for kwwasi
// (test/wasi-binfmt.ts), without libc: the calls whose layouts differ from
// preview 1 (fd_seek's whence, the 56-byte filestat, poll_oneoff's 56-byte
// subscriptions). Run with the cwd "/": it creates tmp/w/p0.txt through
// descriptor 3. Prints "p0 ok" and exits 0, or names the failed check and
// exits 1.
//   zig cc -target wasm32-wasi -O2 -nostdlib -fno-builtin -o p0.wasm p0.c
#include <stdint.h>

#define IMPORT(name) __attribute__((import_module("wasi_unstable"), import_name(name)))

IMPORT("fd_write") uint16_t fd_write(uint32_t fd, const void *iovs, uint32_t n, uint32_t *written);
IMPORT("fd_read") uint16_t fd_read(uint32_t fd, const void *iovs, uint32_t n, uint32_t *nread);
IMPORT("fd_seek") uint16_t fd_seek(uint32_t fd, int64_t off, uint8_t whence, uint64_t *pos);
IMPORT("fd_close") uint16_t fd_close(uint32_t fd);
IMPORT("fd_filestat_get") uint16_t fd_filestat_get(uint32_t fd, void *out);
IMPORT("path_filestat_get") uint16_t path_filestat_get(uint32_t fd, uint32_t lookup, const char *path, uint32_t len, void *out);
IMPORT("path_open") uint16_t path_open(uint32_t fd, uint32_t lookup, const char *path, uint32_t len, uint16_t oflags,
				       uint64_t base, uint64_t inheriting, uint16_t fdflags, uint32_t *opened);
IMPORT("poll_oneoff") uint16_t poll_oneoff(const void *in, void *out, uint32_t n, uint32_t *nevents);
IMPORT("clock_time_get") uint16_t clock_time_get(uint32_t id, uint64_t precision, uint64_t *t);
IMPORT("proc_exit") _Noreturn void proc_exit(uint32_t code);

/* Preview 0's whence. */
enum { CUR = 0, END = 1, SET = 2 };

static uint32_t len(const char *s)
{
	uint32_t n = 0;

	while (s[n])
		n++;
	return n;
}

static void say(const char *s)
{
	struct { const char *p; uint32_t n; } iov = { s, len(s) };
	uint32_t w;

	fd_write(1, &iov, 1, &w);
}

static void check(int ok, const char *what)
{
	if (ok)
		return;
	say("p0 FAIL ");
	say(what);
	say("\n");
	proc_exit(1);
}

static uint64_t u64(const uint8_t *p)
{
	uint64_t v = 0;

	for (int i = 7; i >= 0; i--)
		v = v << 8 | p[i];
	return v;
}

static uint32_t u32(const uint8_t *p)
{
	return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24;
}

/* A preview 0 filestat (56 bytes) of the 10-byte file; the 8 bytes after it untouched. */
static void check_filestat(const uint8_t *st, const char *what)
{
	check(st[16] == 4, what);              /* filetype: regular file */
	check(u32(st + 20) == 1, what);        /* nlink, u32 */
	check(u64(st + 24) == 10, what);       /* size */
	check(u64(st + 40) > 1000000000000000000ull, what); /* mtim, after 2001 */
	for (int i = 56; i < 64; i++)
		check(st[i] == 0xaa, what);
}

static void put64(uint8_t *p, uint64_t v)
{
	for (int i = 0; i < 8; i++)
		p[i] = v >> (8 * i);
}

void _start(void)
{
	static const char path[] = "tmp/w/p0.txt";
	uint8_t st[64], subs[2 * 56], events[2 * 32];
	uint32_t fd, n, nev;
	uint64_t pos, t0, t1;
	char buf[2];
	struct { const void *p; uint32_t n; } iov = { "0123456789", 10 };

	check(!path_open(3, 1, path, len(path), 1 | 8, 0x1fffffff, 0x1fffffff, 0, &fd), "path_open");
	check(!fd_write(fd, &iov, 1, &n) && n == 10, "fd_write");
	check(!fd_seek(fd, -3, END, &pos) && pos == 7, "fd_seek END");
	check(!fd_seek(fd, 2, SET, &pos) && pos == 2, "fd_seek SET");
	check(!fd_seek(fd, 1, CUR, &pos) && pos == 3, "fd_seek CUR");
	iov.p = buf;
	iov.n = 2;
	check(!fd_read(fd, &iov, 1, &n) && n == 2 && buf[0] == '3' && buf[1] == '4', "fd_read after seeks");

	for (int i = 0; i < 64; i++)
		st[i] = 0xaa;
	check(!fd_filestat_get(fd, st), "fd_filestat_get");
	check_filestat(st, "fd_filestat_get layout");
	for (int i = 0; i < 64; i++)
		st[i] = 0xaa;
	check(!path_filestat_get(3, 1, path, len(path), st), "path_filestat_get");
	check_filestat(st, "path_filestat_get layout");

	/* A 30 ms clock (with an identifier before its clock id) and a readable file: the file's event. */
	for (int i = 0; i < (int)sizeof(subs); i++)
		subs[i] = 0;
	put64(subs, 7);                 /* userdata */
	subs[8] = 0;                    /* clock */
	put64(subs + 16, 0xdeadbeef);   /* identifier */
	subs[24] = 1;                   /* clock id: monotonic */
	put64(subs + 32, 30000000);     /* timeout, relative */
	put64(subs + 56, 9);            /* userdata */
	subs[56 + 8] = 1;               /* fd_read */
	subs[56 + 16] = fd;
	check(!poll_oneoff(subs, events, 2, &nev), "poll_oneoff");
	check(nev == 1 && u64(events) == 9 && events[10] == 1 && events[8] == 0, "poll_oneoff fd event");
	/* The clock alone: it waits its 30 ms. */
	clock_time_get(1, 1, &t0);
	check(!poll_oneoff(subs, events, 1, &nev), "poll_oneoff clock");
	clock_time_get(1, 1, &t1);
	check(nev == 1 && u64(events) == 7 && events[10] == 0, "poll_oneoff clock event");
	check(t1 - t0 >= 25000000, "poll_oneoff clock timeout");
	check(!fd_close(fd), "fd_close");
	say("p0 ok\n");
	proc_exit(0);
}
