// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/* Rough guest speed: integer loop, memory loop, fork+exit, getpid syscalls. */
#include <stdio.h>
#include <stdlib.h>
#include <sys/reboot.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double now(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec * 1e-9;
}

int main(void)
{
	double t;
	volatile unsigned long sink;
	unsigned long i, acc = 1;
	const unsigned long N = 50000000;

	t = now();
	for (i = 0; i < N; i++)
		acc = acc * 6364136223846793005UL + i;	/* ~4 insns/iter */
	sink = acc;
	t = now() - t;
	printf("int loop: %lu iters in %.2f s = %.1f Miter/s (~%.0f MIPS)\n", N, t, N / t / 1e6, 4 * N / t / 1e6);

	unsigned long *buf = malloc(8 << 20);
	t = now();
	for (int r = 0; r < 8; r++)
		for (i = 0; i < (1 << 20); i++)
			buf[i] += i ^ r;
	t = now() - t;
	printf("mem loop: 64 MiB rw in %.2f s = %.0f MB/s\n", t, 64 / t);

	/* double: a dependent fmadd chain, fsqrt, fadd, fdiv and an fadd per
	   iteration (7 insns/iter with zig cc -O2) */
	const unsigned long NF = 10000000;
	volatile double seed = 1.0;
	double a = seed, s = 0;
	t = now();
	for (i = 0; i < NF; i++) {
		a = a * 1.0000001 + 1e-9;
		s += __builtin_sqrt(a) / (a + 1.0);
	}
	t = now() - t;
	printf("fp loop: %lu iters in %.2f s = %.1f Miter/s (s = %.6f)\n", NF, t, NF / t / 1e6, s);

	t = now();
	for (i = 0; i < 100000; i++)
		getppid();
	t = now() - t;
	printf("syscall: %.2f us/getppid\n", t / 100000 * 1e6);

	struct timespec ts;
	t = now();
	for (i = 0; i < 100000; i++)
		clock_gettime(CLOCK_MONOTONIC, &ts);
	t = now() - t;
	printf("clock: %.0f ns/clock_gettime(MONOTONIC)\n", t / 100000 * 1e9);

	t = now();
	for (i = 0; i < 100000; i++)
		clock_gettime(CLOCK_REALTIME, &ts);
	t = now() - t;
	printf("clock: %.0f ns/clock_gettime(REALTIME)\n", t / 100000 * 1e9);

	t = now();
	for (i = 0; i < 200; i++) {
		pid_t p = fork();
		if (!p)
			_exit(0);
		waitpid(p, NULL, 0);
	}
	t = now() - t;
	printf("fork+exit+wait: %.2f ms each\n", t / 200 * 1e3);
	(void)sink;
	fflush(stdout);
	if (getpid() == 1)
		reboot(RB_POWER_OFF);
	return 0;
}
