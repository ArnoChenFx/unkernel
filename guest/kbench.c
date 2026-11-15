// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/* kwemu micro-benchmarks (rv64gc, static musl). usage: kbench <name> [n]
 *   mem    read-modify-write + memcpy over an 8 MiB buffer
 *   fib    recursive fib (call-heavy)
 *   fp     double-precision matrix multiply + nbody-ish update
 *   sha    sha256 over a 1 MiB buffer (branchy/ALU-heavy)
 *   interp a tiny switch-dispatched bytecode interpreter
 * Prints a checksum so the result can be verified across emulators. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t bench_mem(int n)
{
	size_t words = (8u << 20) / 8;
	uint64_t *a = malloc(words * 8), *b = malloc(words * 8);
	for (size_t i = 0; i < words; i++)
		a[i] = i;
	uint64_t s = 0;
	for (int r = 0; r < n; r++) {
		for (size_t i = 0; i < words; i++)
			a[i] = a[i] * 3 + 1;
		memcpy(b, a, words * 8);
		for (size_t i = 0; i < words; i += 7)
			s += b[i];
	}
	free(a);
	free(b);
	return s;
}

static int fib(int n)
{
	return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

static uint64_t bench_fp(int n)
{
	enum { N = 96 };
	static double A[N][N], B[N][N], C[N][N];
	for (int i = 0; i < N; i++)
		for (int j = 0; j < N; j++) {
			A[i][j] = (i * 7 + j * 3) % 17 * 0.25;
			B[i][j] = (i + 2 * j) % 13 * 0.5 - 1.0;
		}
	double acc = 0;
	for (int r = 0; r < n; r++) {
		for (int i = 0; i < N; i++)
			for (int j = 0; j < N; j++) {
				double s = 0;
				for (int k = 0; k < N; k++)
					s += A[i][k] * B[k][j];
				C[i][j] = s;
			}
		/* nbody-ish: positions/velocities with a sqrt per pair */
		double px[32], py[32], vx[32] = {0}, vy[32] = {0};
		for (int i = 0; i < 32; i++) {
			px[i] = C[i][i] * 0.01 + i;
			py[i] = C[i][N - 1 - i] * 0.01 - i;
		}
		for (int step = 0; step < 20; step++)
			for (int i = 0; i < 32; i++)
				for (int j = 0; j < 32; j++) {
					if (i == j)
						continue;
					double dx = px[j] - px[i], dy = py[j] - py[i];
					double d2 = dx * dx + dy * dy + 0.01;
					double inv = 1.0 / (d2 * __builtin_sqrt(d2));
					vx[i] += dx * inv * 0.001;
					vy[i] += dy * inv * 0.001;
				}
		for (int i = 0; i < 32; i++)
			acc += px[i] + vx[i] + py[i] + vy[i];
		acc += C[r % N][(r * 5) % N];
	}
	return (uint64_t)(int64_t)(acc * 1000.0);
}

static const uint32_t K[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};
#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha_block(uint32_t h[8], const uint8_t *p)
{
	uint32_t w[64];
	for (int i = 0; i < 16; i++)
		w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
	for (int i = 16; i < 64; i++) {
		uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
		uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
	for (int i = 0; i < 64; i++) {
		uint32_t t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
		uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
		hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
	}
	h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

static uint64_t bench_sha(int n)
{
	size_t len = 1 << 20;
	uint8_t *buf = malloc(len);
	for (size_t i = 0; i < len; i++)
		buf[i] = (uint8_t)(i * 131 + (i >> 9));
	uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
	for (int r = 0; r < n; r++) {
		for (size_t off = 0; off < len; off += 64)
			sha_block(h, buf + off);
		buf[r % len] ^= (uint8_t)h[0];
	}
	free(buf);
	return (uint64_t)h[0] << 32 | h[7];
}

/* bytecode: PUSH imm, ADD, SUB, MUL, DUP, SWAP, JNZ off, DEC, LOAD i, STORE i, HALT */
enum { PUSH, ADD, SUB, MUL, DUP, SWAP, JNZ, DEC, LOAD, STORE, XOR, HALT };

static int64_t run_vm(const int32_t *code, int64_t *vars)
{
	int64_t st[64];
	int sp = 0, pc = 0;
	for (;;) {
		int32_t op = code[pc++];
		switch (op) {
		case PUSH: st[sp++] = code[pc++]; break;
		case ADD: sp--; st[sp - 1] += st[sp]; break;
		case SUB: sp--; st[sp - 1] -= st[sp]; break;
		case MUL: sp--; st[sp - 1] *= st[sp]; break;
		case XOR: sp--; st[sp - 1] ^= st[sp]; break;
		case DUP: st[sp] = st[sp - 1]; sp++; break;
		case SWAP: { int64_t t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; } break;
		case DEC: st[sp - 1]--; break;
		case LOAD: st[sp++] = vars[code[pc++]]; break;
		case STORE: vars[code[pc++]] = st[--sp]; break;
		case JNZ: { int32_t off = code[pc++]; if (st[--sp]) pc += off; } break;
		case HALT: return sp ? st[sp - 1] : 0;
		default: abort();
		}
	}
}

static uint64_t bench_interp(int n)
{
	/* v0 = n; v1 = 1; loop: v1 = (v1*31 + v0) ^ (v1 >> ...) ; v0--; jnz loop */
	const int32_t code[] = {
		/* 0 */ LOAD, 1, PUSH, 31, MUL, LOAD, 0, ADD, PUSH, 12345, XOR, STORE, 1,
		/* 13 */ LOAD, 0, DEC, DUP, STORE, 0,
		/* 19 */ JNZ, -21,
		/* 21 */ LOAD, 1, HALT,
	};
	int64_t vars[2] = {(int64_t)n * 100000, 1};
	return (uint64_t)run_vm(code, vars);
}

int main(int argc, char **argv)
{
	const char *what = argc > 1 ? argv[1] : "fib";
	int n = argc > 2 ? atoi(argv[2]) : 0;
	uint64_t r;
	if (!strcmp(what, "mem"))
		r = bench_mem(n ? n : 6);
	else if (!strcmp(what, "fib"))
		r = (uint64_t)fib(n ? n : 30);
	else if (!strcmp(what, "fp"))
		r = bench_fp(n ? n : 20);
	else if (!strcmp(what, "sha"))
		r = bench_sha(n ? n : 3);
	else if (!strcmp(what, "interp"))
		r = bench_interp(n ? n : 8);
	else {
		fprintf(stderr, "unknown benchmark %s\n", what);
		return 2;
	}
	printf("%s: %llx\n", what, (unsigned long long)r);
	return 0;
}
