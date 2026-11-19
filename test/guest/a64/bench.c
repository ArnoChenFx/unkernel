// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/* CPU benchmark: sieve of Eratosthenes + recursive fib.
 * usage: bench [sieve_limit] [rounds] [fib_n] */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned fib(unsigned n)
{
	return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

int main(int argc, char **argv)
{
	size_t limit = argc > 1 ? strtoul(argv[1], 0, 10) : 2000000;
	unsigned rounds = argc > 2 ? atoi(argv[2]) : 3;
	unsigned n = argc > 3 ? atoi(argv[3]) : 27;
	unsigned char *sieve = malloc(limit + 1);
	size_t count = 0;

	for (unsigned r = 0; r < rounds; r++) {
		memset(sieve, 1, limit + 1);
		sieve[0] = sieve[1] = 0;
		for (size_t i = 2; i * i <= limit; i++) {
			if (!sieve[i])
				continue;
			for (size_t j = i * i; j <= limit; j += i)
				sieve[j] = 0;
		}
		count = 0;
		for (size_t i = 0; i <= limit; i++)
			count += sieve[i];
	}
	printf("primes below %zu: %zu (%u rounds)\n", limit, count, rounds);
	printf("fib: %u\n", fib(n > 40 ? 40 : n));
	return 0;
}
