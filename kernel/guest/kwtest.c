// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/* unkernel smoke test (static riscv64 musl): /usr/bin/kwtest in the Alpine
 * initramfs, as /init with rdinit=/usr/bin/kwtest or from a shell. */
#include <errno.h>
#include <fcntl.h>
#include <fenv.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/reboot.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int got_signal;

static void on_usr1(int sig)
{
	got_signal = sig;
}

/* Wrong tp (clone tls/ctid swapped) shows up as a bad pthread_self or TLS. */
static _Thread_local int tls_var;

static void *thread_fn(void *arg)
{
	(void)arg;
	if (tls_var != 0)
		return NULL;
	tls_var = 2;
	return (void *)pthread_self();
}

/*
 * Hot loops for kwemu's JIT tier, which compiles a block once it has
 * retired 2^17 instructions: 64-bit and W integer ops, mul/div/rem, and
 * byte/half/word loads and stores over fresh anonymous pages, so the first
 * touch of each page faults from inside compiled code. HOT_EXPECT is what a
 * native build computes: `cc -O2 -o /tmp/kwtest kernel/guest/kwtest.c
 * -lpthread && /tmp/kwtest hot` on any 64-bit host.
 */
#define HOT_SEED 0x2545f4914f6cdd1dUL
#define HOT_EXPECT 0xd096af30f48152faUL
#define HOT_WORDS 4096

static unsigned long hot(unsigned long seed)
{
	unsigned long *w = mmap(NULL, HOT_WORDS * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	unsigned char *b = (unsigned char *)w;
	unsigned long a = seed, sum = 0;

	if (w == MAP_FAILED)
		return 0;
	for (unsigned long r = 0; r < 24; r++) {
		for (unsigned long i = 0; i < HOT_WORDS; i++) {
			a = a * 6364136223846793005UL + i;
			unsigned long q = a / ((i | 1) + r) + a % 1000003;
			int32_t h = (int32_t)((uint32_t)(a >> 17) * 2654435761u);
			long s = (long)(h >> 3) / (long)(r + 3);
			uint16_t hw;
			uint32_t word;

			w[i] += q ^ (unsigned long)s;
			b[(i * 13) & (HOT_WORDS * 8 - 1)] ^= (unsigned char)a;
			memcpy(&hw, b + 2 * ((i * 7) & (HOT_WORDS * 4 - 1)), 2);
			memcpy(&word, b + 4 * ((i * 5) & (HOT_WORDS * 2 - 1)), 4);
			sum += w[(i * 7) & (HOT_WORDS - 1)] + hw + (unsigned long)(int32_t)word;
		}
	}
	munmap(w, HOT_WORDS * 8);
	return sum ^ a;
}

/*
 * FP hot loop for the JIT's F/D translation: double and float arithmetic,
 * fma(), sqrt(), fmax(), conversions both ways, compares, and a last round
 * in FE_UPWARD (dynamic rounding, which the JIT hands back). Returns a hash
 * of the results and of the accrued flags. FPHOT_EXPECT is what a native
 * build computes: `cc -O2 -ffp-contract=off -o /tmp/kwtest
 * kernel/guest/kwtest.c -lpthread -lm && /tmp/kwtest fphot` on a 64-bit
 * host with IEEE double/float (x86-64, aarch64).
 */
#pragma STDC FP_CONTRACT OFF
#pragma STDC FENV_ACCESS ON
#define FPHOT_EXPECT 0x75228a7bc4a10579UL

static unsigned long fphot(unsigned long seed)
{
	double x = 1.0 + (double)(seed & 0xffff) / 65536.0, acc = 0.0, m = 0.0;
	float fx = 0.5f, facc = 0.0f;
	unsigned long h = seed, bd, bm;
	uint32_t bf;

	feclearexcept(FE_ALL_EXCEPT);
	for (int r = 0; r < 4; r++) {
		if (r == 3)
			fesetround(FE_UPWARD);
		for (int i = 1; i <= 20000; i++) {
			double y = x * 1.000001 + 1.0 / i;
			acc = fma(y, 0.999, acc * 0.5);
			acc += sqrt(y) - (double)(i & 7);
			fx = fx * 1.0001f + (float)acc * 1e-3f;
			facc += sqrtf(fx > 0 ? fx : -fx) - fx / 3.0f;
			m = fmax(m, acc);
			long l = (long)(acc * 1024.0);
			h = (h ^ (unsigned long)l) * 0x100000001b3UL;
			if (y > acc)
				h += 1;
			x = y - (double)l / 4096.0 * 1e-6;
		}
	}
	fesetround(FE_TONEAREST);
	int ex = (fetestexcept(FE_INEXACT) ? 1 : 0) | (fetestexcept(FE_INVALID) ? 2 : 0) |
		 (fetestexcept(FE_OVERFLOW) ? 4 : 0) | (fetestexcept(FE_UNDERFLOW) ? 8 : 0) |
		 (fetestexcept(FE_DIVBYZERO) ? 16 : 0);
	memcpy(&bd, &acc, 8);
	memcpy(&bm, &m, 8);
	memcpy(&bf, &facc, 4);
	return h ^ bd ^ (bm * 3) ^ ((unsigned long)bf << 7) ^ (unsigned long)ex;
}

static int failures;
#define CHECK(cond, ...) do { \
	if (cond) printf("ok   " __VA_ARGS__); \
	else { printf("FAIL " __VA_ARGS__); failures++; } \
	printf("\n"); \
} while (0)

#ifdef __riscv
#include <setjmp.h>
#include <sys/auxv.h>
#include <linux/futex.h>
#include <poll.h>
#include <sys/epoll.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/syscall.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sysmacros.h>
#include <linux/vm_sockets.h>

#ifndef __NR_riscv_hwprobe
#define __NR_riscv_hwprobe 258
#endif
struct hwprobe_pair {
	int64_t key;
	uint64_t value;
};

/*
 * The extensions the kernel may list after "rv64imafdc" in /proc/cpuinfo,
 * in that canonical order, with their riscv_hwprobe IMA_EXT_0 bits (and
 * ext1, the IMA_EXT_1 bit of a platform property; see
 * arch/wasm/kernel/cpu.c). kind: 2 = part of rv64gc (always listed), 1 =
 * listed unless kw.isa= masks it (every kwemu has it, or it is an optional
 * extension kwemu implements), 0 = an optional extension kwemu does not
 * implement yet (either). probe: an instruction (rd = a0, rs1 = a0, rs2 =
 * a1, fd = fa0; a compressed one followed by c.nop in the same word) that
 * only this extension (or alt) defines; it must raise SIGILL exactly when
 * neither is listed, and give `want` for a0 = 3, a1 = 5 when want is not
 * 0. With `mem`, a0 is the address of a writable buffer instead of 3.
 */
static const struct isa_ext {
	const char *name;
	unsigned long hwprobe;
	int kind;
	uint32_t probe;
	const char *alt;
	unsigned long want;
	int mem;
	unsigned long ext1;
} isa_exts[] = {
	{ "zicbom", 1UL << 55, 1, 0x0015200f, NULL, 0, 1 },	/* cbo.clean (a0) */
	{ "zicbop", 1UL << 60, 1 },
	{ "zicboz", 1UL << 6, 1, 0x0045200f, NULL, 0, 1 },	/* cbo.zero (a0) */
	{ "ziccamoa", 0, 1, .ext1 = 1UL << 2 },
	{ "ziccif", 0, 1, .ext1 = 1UL << 3 },
	{ "zicclsm", 0, 1, .ext1 = 1UL << 1 },
	{ "ziccrse", 0, 1, .ext1 = 1UL << 4 },
	{ "zicntr", 1UL << 50, 1 },
	{ "zicond", 1UL << 35, 1, 0x0eb55533, NULL, 3 },	/* czero.eqz */
	{ "zicsr", 0, 2 },
	{ "zifencei", 0, 2 },
	{ "zihintntl", 1UL << 29, 1 },
	{ "zihintpause", 1UL << 36, 1 },
	{ "zihpm", 1UL << 51, 1, 0xc0302573 },	/* csrr a0, hpmcounter3 (0: checked below) */
	{ "zimop", 1UL << 42, 1, 0x81c54573 },	/* mop.r.0 a0, a0 (0: checked below) */
	{ "za64rs", 0, 1, .ext1 = 1UL << 5 },
	{ "zaamo", 1UL << 56, 1 },
	{ "zalrsc", 1UL << 57, 1 },
	{ "zawrs", 1UL << 48, 1, 0x00d00073, NULL, 3 },	/* wrs.nto */
	{ "zfa", 1UL << 32, 1, 0xf2180553, NULL, 3 },	/* fli.d fa0, 1.0 */
	{ "zfhmin", 1UL << 28, 1, 0xf4050553, NULL, 3 },	/* fmv.h.x fa0, a0 */
	{ "zca", 1UL << 43, 1 },
	{ "zcb", 1UL << 44, 1, 0x00019d75, NULL, ~3UL },	/* c.not a0; c.nop */
	{ "zcd", 1UL << 45, 1 },
	{ "zcmop", 1UL << 47, 1, 0x00016081, NULL, 3 },	/* c.mop.1; c.nop */
	{ "zba", 1UL << 3, 1, 0x20b52533, NULL, 11 },	/* sh1add */
	{ "zbb", 1UL << 4, 1, 0x60051513, NULL, 62 },	/* clz */
	{ "zbc", 1UL << 7, 1, 0x0ab52533 },	/* clmulr (3, 5) = 0: not checked */
	{ "zbkb", 1UL << 8, 1, 0x08b54533, NULL, 0x0000000500000003 },	/* pack */
	{ "zbkc", 1UL << 9, 1, 0x0ab51533, "zbc", 15 },	/* clmul */
	{ "zbkx", 1UL << 10, 1, 0x28b54533, NULL, 0x0303030303030300 },	/* xperm8 */
	{ "zbs", 1UL << 5, 1, 0x28b51533, NULL, 35 },	/* bset */
	{ "zknd", 1UL << 11, 1, 0x3ab50533, NULL, 0x52525252525252d5 },	/* aes64ds */
	{ "zkne", 1UL << 12, 1, 0x32b50533, NULL, 0x636363636363637b },	/* aes64es */
};
#define NISA (int)(sizeof(isa_exts) / sizeof(isa_exts[0]))

static int isa_find(const char *name, size_t len)
{
	for (int i = 0; i < NISA; i++)
		if (strlen(isa_exts[i].name) == len && !strncmp(isa_exts[i].name, name, len))
			return i;
	return -1;
}

/* The first line of `path` that starts with `key`, from after ": " or `key`. */
static int read_line(const char *path, const char *key, int colon, char *out, size_t n)
{
	char line[1024];
	FILE *f = fopen(path, "r");
	int found = 0;

	if (!f)
		return 0;
	while (!found && fgets(line, sizeof(line), f)) {
		char *v = line;

		if (strncmp(line, key, strlen(key)))
			continue;
		if (colon) {
			v = strstr(line, ": ");
			if (!v)
				continue;
			v += 2;
		}
		v[strcspn(v, "\n")] = 0;
		snprintf(out, n, "%s", v);
		found = 1;
	}
	fclose(f);
	return found;
}

static sigjmp_buf ill_jmp;

static void on_ill(int sig)
{
	(void)sig;
	siglongjmp(ill_jmp, 1);
}

/* Run n instruction words (ending in ret) as long f(a0, a1); -1 on SIGILL. */
static int run_code(const uint32_t *w, int n, long a0, long a1, long *ret)
{
	static uint32_t *page;
	struct sigaction sa = { .sa_handler = on_ill }, old;
	volatile int ill = 0;

	if (!page) {
		page = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (page == MAP_FAILED) {
			page = NULL;
			return -2;
		}
	}
	memcpy(page, w, n * 4);
	__asm__ volatile("fence.i" ::: "memory");
	sigaction(SIGILL, &sa, &old);
	if (sigsetjmp(ill_jmp, 1))
		ill = 1;
	else
		*ret = ((long (*)(long, long))(void *)page)(a0, a1);
	sigaction(SIGILL, &old, NULL);
	return ill ? -1 : 0;
}

/* Zkne / Zknd through .insn, so any assembler takes them. */
#define AESR(f7, a, b) ({ unsigned long _r; \
	__asm__ volatile(".insn r 0x33, 0, " #f7 ", %0, %1, %2" : "=r"(_r) : "r"(a), "r"(b)); _r; })
#define AESI(imm, a) ({ unsigned long _r; \
	__asm__ volatile(".insn i 0x13, 1, %0, %1, " #imm : "=r"(_r) : "r"(a)); _r; })
#define AES_ES(a, b) AESR(0x19, a, b)
#define AES_ESM(a, b) AESR(0x1b, a, b)
#define AES_DS(a, b) AESR(0x1d, a, b)
#define AES_DSM(a, b) AESR(0x1f, a, b)
#define AES_KS2(a, b) AESR(0x3f, a, b)
#define AES_IM(a) AESI(0x300, a)
#define AES_KS(i, rk) do { \
	rk[i + 1][0] = AES_KS2(AESI(0x31##i, rk[i][1]), rk[i][0]); \
	rk[i + 1][1] = AES_KS2(rk[i + 1][0], rk[i][1]); } while (0)

/* AES-128 encrypt + decrypt of FIPS-197 C.1, 5000 times; returns the misses. */
static int aes_fips(int *reps)
{
	unsigned long rk[11][2], dk[11][2];
	const unsigned long pt[2] = { 0x7766554433221100, 0xffeeddccbbaa9988 };
	const unsigned long ct[2] = { 0x30047b6ad8e0c469, 0x5ac5b47080b7cdd8 };
	int bad = 0;

	rk[0][0] = 0x0706050403020100;
	rk[0][1] = 0x0f0e0d0c0b0a0908;
	AES_KS(0, rk); AES_KS(1, rk); AES_KS(2, rk); AES_KS(3, rk); AES_KS(4, rk);
	AES_KS(5, rk); AES_KS(6, rk); AES_KS(7, rk); AES_KS(8, rk); AES_KS(9, rk);
	for (int r = 1; r < 10; r++) {
		dk[r][0] = AES_IM(rk[r][0]);
		dk[r][1] = AES_IM(rk[r][1]);
	}
	for (*reps = 0; *reps < 5000; ++*reps) {
		unsigned long s0 = pt[0] ^ rk[0][0], s1 = pt[1] ^ rk[0][1], n0, n1;

		for (int r = 1; r < 10; r++) {
			n0 = AES_ESM(s0, s1);
			n1 = AES_ESM(s1, s0);
			s0 = n0 ^ rk[r][0];
			s1 = n1 ^ rk[r][1];
		}
		n0 = AES_ES(s0, s1) ^ rk[10][0];
		n1 = AES_ES(s1, s0) ^ rk[10][1];
		bad += n0 != ct[0] || n1 != ct[1];
		s0 = n0 ^ rk[10][0];
		s1 = n1 ^ rk[10][1];
		for (int r = 9; r >= 1; r--) {
			n0 = AES_DSM(s0, s1);
			n1 = AES_DSM(s1, s0);
			s0 = n0 ^ dk[r][0];
			s1 = n1 ^ dk[r][1];
		}
		n0 = AES_DS(s0, s1) ^ rk[0][0];
		n1 = AES_DS(s1, s0) ^ rk[0][1];
		bad += n0 != pt[0] || n1 != pt[1];
	}
	return bad;
}

/* Zbc / Zbkb through .insn too. */
#define BKR(f3, f7, a, b) ({ unsigned long _r; \
	__asm__ volatile(".insn r 0x33, " #f3 ", " #f7 ", %0, %1, %2" : "=r"(_r) : "r"(a), "r"(b)); _r; })
#define CLMUL(a, b) BKR(1, 0x05, a, b)
#define CLMULH(a, b) BKR(3, 0x05, a, b)
#define BREV8(a) ({ unsigned long _r; \
	__asm__ volatile(".insn i 0x13, 5, %0, %1, 0x687" : "=r"(_r) : "r"(a)); _r; })
#define REV8(a) ({ unsigned long _r; \
	__asm__ volatile(".insn i 0x13, 5, %0, %1, 0x6b8" : "=r"(_r) : "r"(a)); _r; })

/* GHASH multiply as OpenSSL's Zbc + Zbkb code does it; x, y, z are blocks
 * as two big-endian halves. */
static void gf_mul(const unsigned long x[2], const unsigned long y[2], unsigned long z[2])
{
	unsigned long x0 = BREV8(REV8(x[0])), x1 = BREV8(REV8(x[1]));
	unsigned long y0 = BREV8(REV8(y[0])), y1 = BREV8(REV8(y[1]));
	unsigned long z0 = CLMUL(x0, y0);
	unsigned long z1 = CLMULH(x0, y0) ^ CLMUL(x0, y1) ^ CLMUL(x1, y0);
	unsigned long z2 = CLMULH(x0, y1) ^ CLMULH(x1, y0) ^ CLMUL(x1, y1);
	unsigned long z3 = CLMULH(x1, y1);

	z1 ^= CLMUL(z3, 0x87);
	z2 ^= CLMULH(z3, 0x87);
	z0 ^= CLMUL(z2, 0x87);
	z1 ^= CLMULH(z2, 0x87);
	z[0] = REV8(BREV8(z0));
	z[1] = REV8(BREV8(z1));
}

/* GHASH of the GCM spec's test case 2 (H, C = one block, no AAD) 5000
 * times; returns the misses. */
static int ghash_kat(int *reps)
{
	const unsigned long h[2] = { 0x66e94bd4ef8a2c3b, 0x884cfa59ca342b2e };
	const unsigned long c[2] = { 0x0388dace60b6a392, 0xf328c2b971b2fe78 };
	const unsigned long want[2] = { 0xf38cbb1ad69223dc, 0xc3457ae5b6b0f885 };
	int bad = 0;

	for (*reps = 0; *reps < 5000; ++*reps) {
		unsigned long y[2];

		gf_mul(c, h, y);
		y[1] ^= 128; /* len(A) = 0, len(C) = 128 bits */
		gf_mul(y, h, y);
		bad += y[0] != want[0] || y[1] != want[1];
	}
	return bad;
}

/* Zba / Zbb / Zbs / Zicond through .insn too. */
#define ZR(op, f3, f7, a, b) ({ unsigned long _r; \
	__asm__ volatile(".insn r " #op ", " #f3 ", " #f7 ", %0, %1, %2" : "=r"(_r) : "r"(a), "r"(b)); _r; })
#define ZI(op, f3, imm, a) ({ unsigned long _r; \
	__asm__ volatile(".insn i " #op ", " #f3 ", %0, %1, " #imm : "=r"(_r) : "r"(a)); _r; })

/*
 * A mix of Zba, Zbb, Zbs and Zicond instructions (sh3add, add.uw,
 * slli.uw, clz, cpopw, sext.h, orc.b, max, minu, bset, bext, binvi,
 * czero.nez) in a loop long enough to compile, against the same in plain C
 * (this file is built for rv64gc, so the C uses none of them). Returns the
 * misses.
 */
static int zb_mix(int *reps)
{
	unsigned long x = 0x0123456789abcdef, y = 0x0123456789abcdef;
	int bad = 0;

	for (*reps = 0; *reps < 20000; ++*reps) {
		unsigned long i = *reps, a = x ^ (i << 7), b = x >> (i & 31);
		unsigned long r = ZR(0x33, 6, 0x10, a, b);		/* sh3add */
		unsigned long c, w;

		r ^= ZR(0x3b, 0, 0x04, b, a);				/* add.uw */
		r += ZI(0x1b, 1, 0x083, a);				/* slli.uw 3 */
		r ^= ZI(0x13, 1, 0x600, b) << 8;			/* clz */
		r += ZI(0x1b, 1, 0x602, a) << 16;			/* cpopw */
		r ^= ZI(0x13, 1, 0x605, a);				/* sext.h */
		r += ZI(0x13, 5, 0x287, b & 0xff00ff0000ff00ff);	/* orc.b */
		r ^= ZR(0x33, 6, 0x05, a, b) + ZR(0x33, 5, 0x05, b, a);	/* max, minu */
		r = ZR(0x33, 1, 0x14, r, i) ^ ZR(0x33, 5, 0x24, a, i);	/* bset, bext */
		r = ZI(0x13, 1, 0x687, r);				/* binvi 7 */
		r += ZR(0x33, 7, 0x07, a, i & 1);			/* czero.nez */

		c = (a << 3) + b;
		c ^= (b & 0xffffffff) + a;
		c += (a & 0xffffffff) << 3;
		c ^= (unsigned long)(b ? __builtin_clzl(b) : 64) << 8;
		c += (unsigned long)__builtin_popcount((unsigned)a) << 16;
		c ^= (unsigned long)(long)(short)a;
		w = 0;
		for (int k = 0; k < 64; k += 8)
			if ((b & 0xff00ff0000ff00ff) >> k & 0xff)
				w |= 0xffUL << k;
		c += w;
		c ^= ((long)a > (long)b ? a : b) + (b < a ? b : a);
		c = (c | 1UL << (i & 63)) ^ (a >> (i & 63) & 1);
		c ^= 1UL << 7;
		c += i & 1 ? 0 : a;
		bad += r != c;
		x = x * 6364136223846793005UL + r;
		y = y * 6364136223846793005UL + c;
	}
	return bad + (x != y);
}

/* Writable, 64-byte aligned memory for the probes with `mem`. */
static unsigned char probe_buf[128] __attribute__((aligned(64)));

/*
 * Zcb (with Zbb and Zba for c.sext.*, c.zext.h and c.zext.w), Zimop and
 * Zcmop as the compiler emits them for a function built with them (the
 * rest of this file is rv64gc); zcb_plain() is the same C for rv64gc.
 */
#define ZCB_BODY \
	unsigned long x = p[1] * a + (unsigned short)b + (unsigned char)a + (unsigned)(a >> 7); \
	x += (unsigned long)(long)(signed char)b + (unsigned long)(long)(short)(a >> 3); \
	x ^= ~a + ((unsigned short *)p)[1] + (unsigned long)(long)((short *)p)[2]; \
	p[3] = (unsigned char)x; \
	((unsigned short *)p)[3] = (unsigned short)(x >> 8); \
	return x * b;
__attribute__((target("arch=+zcb,+zbb,+zba"), noinline)) static unsigned long zcb_fn(unsigned char *p, unsigned long a, unsigned long b)
{
	ZCB_BODY
}
__attribute__((noinline)) static unsigned long zcb_plain(unsigned char *p, unsigned long a, unsigned long b)
{
	ZCB_BODY
}

/* mop.r.N / mop.rr.N write 0, c.mop.N does nothing; returns the misses */
__attribute__((target("arch=+zimop"), noinline)) static int mop_check(unsigned long a, unsigned long b)
{
	unsigned long r0, r1;

	__asm__ volatile("mop.r.0 %0, %1" : "=r"(r0) : "r"(a));
	__asm__ volatile("mop.rr.7 %0, %1, %2" : "=r"(r1) : "r"(a), "r"(b));
	return (r0 != 0) + (r1 != 0);
}
__attribute__((target("arch=+zcmop"), noinline)) static unsigned long cmop_check(unsigned long a)
{
	__asm__ volatile("c.mop.1\n\tc.mop.3\n\tc.mop.5\n\tc.mop.7\n\tc.mop.15\n\tmv %0, %0" : "+r"(a));
	return a;
}

/*
 * Zfa: fround/froundnx in each static mode and dynamically, fli constants
 * and fmin/fmax, against libm's floor/ceil/trunc/round/rint and plain
 * constants in rv64gc code; plus fminm, fcvtmod.w.d and fltq.
 */
#define FRND(op, rm, x) ({ double _r; __asm__ volatile(op " %0, %1, " rm : "=f"(_r) : "f"(x)); _r; })
#define ZFA_BODY(FL, CE, TR, RO, RI, K) \
	double r = FL(a * 0.5) + CE(a) * K(0.25) - TR(a * 1.5) + RO(a) + RI(a * 0.75); \
	return fmin(r, 1e12) + fmax(r * K(0.125), -16.0) + RI(b) + K(0.3125);
#define Z_FL(x) FRND("fround.d", "rdn", x)
#define Z_CE(x) FRND("froundnx.d", "rup", x)
#define Z_TR(x) FRND("fround.d", "rtz", x)
#define Z_RO(x) FRND("froundnx.d", "rmm", x)
#define Z_RI(x) FRND("froundnx.d", "dyn", x)
#define Z_K(c) ({ double _r; __asm__ volatile("fli.d %0, " #c : "=f"(_r)); _r; })
#define P_K(c) (c)
__attribute__((target("arch=+zfa"), noinline)) static double zfa_fn(double a, double b)
{
	ZFA_BODY(Z_FL, Z_CE, Z_TR, Z_RO, Z_RI, Z_K)
}
__attribute__((noinline)) static double zfa_plain(double a, double b)
{
	ZFA_BODY(floor, ceil, trunc, round, rint, P_K)
}
__attribute__((target("arch=+zfa"), noinline)) static unsigned long zfa_minm(double a, double b)
{
	double m;
	unsigned long u;

	__asm__ volatile("fminm.d %0, %1, %2" : "=f"(m) : "f"(a), "f"(b));
	memcpy(&u, &m, 8);
	return u;
}
__attribute__((target("arch=+zfa"), noinline)) static long zfa_insns(double a, double b)
{
	double m;
	long w, q;

	__asm__ volatile("fminm.d %0, %1, %2" : "=f"(m) : "f"(a), "f"(b));
	__asm__ volatile("fcvtmod.w.d %0, %1, rtz" : "=r"(w) : "f"(a));
	__asm__ volatile("fltq.d %0, %1, %2" : "=r"(q) : "f"(a), "f"(b));
	return w + (long)m * 3 + q;
}

/*
 * Zfhmin: every half through fmv.h.x, fcvt.s.h, fcvt.h.s, fcvt.d.h,
 * fcvt.h.d and fmv.x.h, against a C decoding of the format; returns the
 * misses (NaNs convert to the canonical NaN).
 */
static unsigned h2s(unsigned h)
{
	unsigned s = (h >> 15) << 31, e = (h >> 10) & 31, m = h & 0x3ff;
	int k = 0;

	if (e == 31)
		return m ? 0x7fc00000 : s | 0x7f800000;
	if (e)
		return s | (e + 112) << 23 | m << 13;
	if (!m)
		return s;
	while (!(m & 0x400)) {
		m <<= 1;
		k++;
	}
	return s | (unsigned)(113 - k) << 23 | (m & 0x3ff) << 13;
}
__attribute__((target("arch=+zfhmin"), noinline)) static int zfh_all(void)
{
	int bad = 0;

	for (unsigned h = 0; h < 65536; h++) {
		float s;
		double d;
		long back, back2;
		unsigned sb;
		int nan = ((h >> 10) & 31) == 31 && (h & 0x3ff);

		__asm__ volatile("fmv.h.x ft0, %3\n\tfcvt.s.h %0, ft0\n\tfcvt.d.h %1, ft0\n\t"
				 "fcvt.h.s ft1, %0\n\tfmv.x.h %2, ft1"
				 : "=&f"(s), "=&f"(d), "=&r"(back) : "r"((long)h) : "ft0", "ft1");
		__asm__ volatile("fcvt.h.d ft1, %1, rtz\n\tfmv.x.h %0, ft1" : "=r"(back2) : "f"(d) : "ft1");
		memcpy(&sb, &s, 4);
		bad += sb != h2s(h) || (!nan && (double)s != d);
		bad += (back & 0xffff) != (nan ? 0x7e00 : h) || back != (long)(short)back;
		bad += (back2 & 0xffff) != (nan ? 0x7e00 : h);
	}
	__asm__ volatile("csrw fflags, x0");
	return bad;
}

static sigjmp_buf sig_jmp;

static void on_sig(int sig)
{
	siglongjmp(sig_jmp, sig);
}

/* Run fn(arg); the signal it raised (SIGSEGV, SIGILL), or 0. */
static int catch_sig(void (*fn)(void *), void *arg)
{
	struct sigaction sa = { .sa_handler = on_sig }, o1, o2;
	volatile int sig;

	sigaction(SIGSEGV, &sa, &o1);
	sigaction(SIGILL, &sa, &o2);
	sig = sigsetjmp(sig_jmp, 1);
	if (!sig)
		fn(arg);
	sigaction(SIGSEGV, &o1, NULL);
	sigaction(SIGILL, &o2, NULL);
	return sig;
}
static void do_cbo_zero(void *p)
{
	__asm__ volatile(".insn i 0x0f, 2, x0, %0, 4" :: "r"(p) : "memory");
}
static void do_cbo_clean(void *p)
{
	__asm__ volatile(".insn i 0x0f, 2, x0, %0, 1" :: "r"(p) : "memory");
}
static void do_cbo_flush(void *p)
{
	__asm__ volatile(".insn i 0x0f, 2, x0, %0, 2" :: "r"(p) : "memory");
}
static void do_cbo_inval(void *p)
{
	__asm__ volatile(".insn i 0x0f, 2, x0, %0, 0" :: "r"(p) : "memory");
}

/* The RVA23 extensions beyond probes: results, long enough to compile. */
static void rva23_checks(const int *have)
{
	int bad = 0;

	if (have[isa_find("zcb", 3)] && have[isa_find("zbb", 3)] && have[isa_find("zba", 3)]) {
		unsigned char p1[8], p2[8];
		unsigned long x = 0x0123456789abcdef;

		for (int i = 0; i < 20000; i++) {
			unsigned long a = x ^ ((unsigned long)i << 13), b = x >> (i & 31), r1, r2;

			for (int k = 0; k < 8; k++)
				p1[k] = p2[k] = (unsigned char)(x >> (8 * k));
			r1 = zcb_fn(p1, a, b);
			r2 = zcb_plain(p2, a, b);
			bad += r1 != r2 || memcmp(p1, p2, 8);
			x = x * 6364136223846793005UL + r1;
		}
		CHECK(!bad, "Zcb (compiled with Zbb, Zba): 20000 calls against rv64gc code, %d wrong", bad);
	}
	if (have[isa_find("zimop", 5)] && have[isa_find("zcmop", 5)]) {
		bad = 0;
		for (int i = 0; i < 20000; i++)
			bad += mop_check(i + 1, ~(unsigned long)i) + (cmop_check(i) != (unsigned long)i);
		CHECK(!bad, "Zimop, Zcmop: mop.r/mop.rr write 0, c.mop does nothing (20000 times), %d wrong", bad);
	}
	if (have[isa_find("zfa", 3)]) {
		double x = 0.37;

		bad = 0;
		for (int i = 0; i < 20000; i++) {
			double a = (double)(i % 2000) * 0.75 - 700.25 + x, b = x * 1e3 - (double)i;
			double r1 = zfa_fn(a, b), r2 = zfa_plain(a, b);

			bad += memcmp(&r1, &r2, 8) != 0;
			x = fmod(x * 3.7 + r1 * 1e-9, 1.0);
		}
		/* fcvtmod(-2^31 - 1) = 2^31 - 1, fminm = a, fltq = 1; fminm with a NaN is the canonical NaN */
		bad += zfa_insns(-2147483649.0, -3.0) != 2147483647L - 3 * 2147483649L + 1;
		bad += zfa_insns(5.75, 2.0) != 5 + 6 + 0;
		bad += zfa_minm(1.0, NAN) != 0x7ff8000000000000UL;
		CHECK(!bad, "Zfa: fround(nx) in 5 modes, fli, fmin/fmax 20000 times against libm, fminm, fcvtmod.w.d, fltq: %d wrong", bad);
	}
	if (have[isa_find("zihpm", 5)]) {
		unsigned long h3 = 1, h31 = 1;

		for (int i = 0; i < 1000; i++) {
			__asm__ volatile("csrr %0, 0xc03" : "=r"(h3));
			__asm__ volatile("csrr %0, 0xc1f" : "=r"(h31));
		}
		CHECK(h3 == 0 && h31 == 0, "Zihpm: hpmcounter3 = %lu, hpmcounter31 = %lu (no events counted)", h3, h31);
	}
	if (have[isa_find("zfhmin", 6)]) {
		bad = 0;
		for (int rep = 0; rep < 3; rep++)
			bad += zfh_all();
		CHECK(!bad, "Zfhmin: every half to single and double and back (3 times), %d wrong", bad);
	}
	if (have[isa_find("zicboz", 6)] && have[isa_find("zicbom", 6)]) {
		unsigned char *pg = mmap(NULL, 3 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		int s_ro, s_none, s_clean_ro, s_flush_none, s_inval;

		bad = 0;
		for (int i = 0; i < 2000 && pg != MAP_FAILED; i++) {
			int off = 64 + (i * 97) % 3900, b0 = off & ~63;

			memset(pg, 0x5a, 4096);
			do_cbo_clean(pg + off);
			do_cbo_flush(pg + off);
			do_cbo_zero(pg + off);
			for (int j = 0; j < 4096; j++)
				bad += pg[j] != (j >= b0 && j < b0 + 64 ? 0 : 0x5a);
		}
		/* read-only: cbo.clean works, cbo.zero faults; no access: both fault */
		memset(pg + 4096, 0x77, 4096);
		mprotect(pg + 4096, 4096, PROT_READ);
		mprotect(pg + 8192, 4096, PROT_NONE);
		s_ro = catch_sig(do_cbo_zero, pg + 4096 + 100);
		s_clean_ro = catch_sig(do_cbo_clean, pg + 4096 + 100);
		s_none = catch_sig(do_cbo_zero, pg + 8192);
		s_flush_none = catch_sig(do_cbo_flush, pg + 8192);
		s_inval = catch_sig(do_cbo_inval, pg);
		for (int j = 4096; j < 8192; j++)
			bad += pg[j] != 0x77;
		CHECK(!bad && s_ro == SIGSEGV && s_clean_ro == 0 && s_none == SIGSEGV && s_flush_none == SIGSEGV &&
		      s_inval == SIGILL,
		      "Zicbom, Zicboz: cbo.zero zeroes its 64-byte block (2000 times, %d wrong); read-only: zero %d, clean %d; "
		      "no access: zero %d, flush %d; cbo.inval %d", bad, s_ro, s_clean_ro, s_none, s_flush_none, s_inval);
		munmap(pg, 3 * 4096);
	}
}

/*
 * ISA advertising: the /proc/cpuinfo isa line, riscv_hwprobe and AT_HWCAP
 * agree with each other and with kw.isa= on the command line, the
 * extensions kwemu always has work, and an optional extension's
 * instructions run exactly when it is listed.
 */
static void isa_checks(void)
{
	char isa[512] = "", cmdline[1024] = "", mask[256] = "-";
	int want[NISA], have[NISA] = { 0 }, ordered = 1, unknown = 0, bad = 0, last = -1;
	unsigned long ext0 = 1UL << 0 | 1UL << 1; /* IMA_FD | IMA_C */
	unsigned long ext1 = 0;
	const char *p;

	mkdir("/proc", 0555);
	mount("proc", "/proc", "proc", 0, NULL); /* EBUSY when it is mounted */
	read_line("/proc/cpuinfo", "isa", 1, isa, sizeof(isa));
	read_line("/proc/cmdline", "", 0, cmdline, sizeof(cmdline));

	/* What should be listed: kind 2 and 1, then kw.isa= from left to right. */
	for (int i = 0; i < NISA; i++)
		want[i] = isa_exts[i].kind ? 1 : -1; /* -1: either */
	p = strstr(cmdline, "kw.isa=");
	if (p && (p == cmdline || p[-1] == ' ')) {
		p += 7;
		snprintf(mask, sizeof(mask), "%.*s", (int)strcspn(p, " "), p);
		for (char *tok = mask, *end; *tok; tok = *end ? end + 1 : end) {
			int on = *tok != '-', i;

			end = tok + strcspn(tok, ",");
			if (end - tok == 6 && !strncmp(tok, "rv64gc", 6)) {
				for (i = 0; i < NISA; i++)
					if (isa_exts[i].kind != 2)
						want[i] = 0;
				continue;
			}
			if (*tok == '-' || *tok == '+')
				tok++;
			i = isa_find(tok, end - tok);
			if (i >= 0 && isa_exts[i].kind != 2)
				want[i] = on ? (isa_exts[i].kind ? 1 : -1) : 0;
		}
	}

	/* Parse the isa line: rv64imafdc, then _ext in canonical order. */
	if (!strncmp(isa, "rv64imafdc", 10)) {
		for (p = isa + 10; *p == '_'; ) {
			size_t len = strcspn(p + 1, "_");
			int i = isa_find(p + 1, len);

			if (i < 0)
				unknown++;
			else {
				ordered &= i > last;
				last = i;
				have[i] = 1;
				ext0 |= isa_exts[i].hwprobe;
				ext1 |= isa_exts[i].ext1;
			}
			p += 1 + len;
		}
		unknown += *p != 0;
	} else
		unknown++;
	for (int i = 0; i < NISA; i++)
		if (want[i] >= 0 && want[i] != have[i]) {
			printf("     %s: want %s\n", isa_exts[i].name, want[i] ? "listed" : "not listed");
			bad++;
		}
	CHECK(!unknown && ordered && !bad, "cpuinfo isa: %s (kw.isa=%s)", isa, mask);

	/* IMA_EXT_0, then the ZICBOP, ZICBOZ and ZICBOM block sizes */
	struct hwprobe_pair pr[4] = { { 4 }, { 15 }, { 6 }, { 12 } };
	long rc = syscall(__NR_riscv_hwprobe, pr, 4, 0, NULL, 0);
	unsigned long zicbop = have[isa_find("zicbop", 6)] ? 64 : 0;
	unsigned long zicboz = have[isa_find("zicboz", 6)] ? 64 : 0;
	unsigned long zicbom = have[isa_find("zicbom", 6)] ? 64 : 0;
	CHECK(rc == 0 && pr[0].value == ext0 && pr[1].key == 15 && pr[1].value == zicbop &&
	      pr[2].key == 6 && pr[2].value == zicboz && pr[3].key == 12 && pr[3].value == zicbom,
	      "riscv_hwprobe IMA_EXT_0 %#lx (want %#lx), Zicbop/Zicboz/Zicbom blocks %lu/%lu/%lu (want %lu/%lu/%lu)",
	      (unsigned long)pr[0].value, ext0, (unsigned long)pr[1].value, (unsigned long)pr[2].value,
	      (unsigned long)pr[3].value, zicbop, zicboz, zicbom);

	/*
	 * IMA_EXT_1 (the platform properties) against the isa line; misaligned
	 * scalar accesses are fast (3) whatever kw.isa= says, vector ones
	 * unsupported (4).
	 */
	struct hwprobe_pair pr1[3] = { { 16 }, { 9 }, { 10 } };
	rc = syscall(__NR_riscv_hwprobe, pr1, 3, 0, NULL, 0);
	CHECK(rc == 0 && pr1[0].key == 16 && pr1[0].value == ext1 && pr1[1].key == 9 && pr1[1].value == 3 &&
	      pr1[2].key == 10 && pr1[2].value == 4,
	      "riscv_hwprobe IMA_EXT_1 %#lx (want %#lx), misaligned scalar/vector perf %lu/%lu (want 3/4)",
	      (unsigned long)pr1[0].value, ext1, (unsigned long)pr1[1].value, (unsigned long)pr1[2].value);

	/*
	 * HIGHEST_VIRT_ADDRESS is the end of Sv39 user space (1 << 38, as on
	 * riscv), the THEAD, SIFIVE and MIPS vendor keys are 0, and
	 * TIME_CSR_FREQ is unknown (key -1): the time CSR counts instructions.
	 */
	struct hwprobe_pair pr2[5] = { { 7 }, { 11 }, { 13 }, { 14 }, { 8 } };
	rc = syscall(__NR_riscv_hwprobe, pr2, 5, 0, NULL, 0);
	CHECK(rc == 0 && pr2[0].key == 7 && pr2[0].value == 1UL << 38 &&
	      pr2[1].key == 11 && pr2[1].value == 0 && pr2[2].key == 13 && pr2[2].value == 0 &&
	      pr2[3].key == 14 && pr2[3].value == 0 && pr2[4].key == -1 && pr2[4].value == 0,
	      "riscv_hwprobe highest virt %#lx (want %#lx), vendor keys %ld/%ld/%ld = %lu/%lu/%lu, time freq key %ld",
	      (unsigned long)pr2[0].value, 1UL << 38, (long)pr2[1].key, (long)pr2[2].key, (long)pr2[3].key,
	      (unsigned long)pr2[1].value, (unsigned long)pr2[2].value, (unsigned long)pr2[3].value,
	      (long)pr2[4].key);

	/*
	 * Zicclsm (a property of every kwemu, also when kw.isa= hides it):
	 * misaligned ld/sd, lw/sw and fld/fsd work, inside a page and across
	 * the boundary of two, long enough to compile.
	 */
	uint8_t *mp = mmap(NULL, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	int mis = mp == MAP_FAILED;
	for (int r = 0; !mis && r < 2000; r++)
		for (int off = 4085; off < 4100; off++) {
			uint8_t *q = mp + off;
			uint64_t v = 0x0123456789abcdefUL * (uint64_t)(r + off), d = 0, x;
			uint32_t w;
			double f, g;

			__asm__ volatile("sd %1, 0(%0)" :: "r"(q), "r"(v) : "memory");
			for (int k = 7; k >= 0; k--)
				d = d << 8 | q[k];
			__asm__ volatile("ld %0, 0(%1)" : "=r"(x) : "r"(q) : "memory");
			mis += d != v || x != v;
			__asm__ volatile("sw %2, 1(%1)\n\tlw %0, 1(%1)" : "=&r"(x) : "r"(q), "r"(~v) : "memory");
			memcpy(&w, q + 1, 4);
			mis += (uint32_t)x != (uint32_t)~v || w != (uint32_t)~v;
			memcpy(&f, &v, 8);
			__asm__ volatile("fsd %2, 3(%1)\n\tfld %0, 3(%1)" : "=&f"(g) : "r"(q), "f"(f) : "memory");
			memcpy(&x, &g, 8);
			memcpy(&d, q + 3, 8);
			mis += x != v || d != v;
		}
	CHECK(!mis, "Zicclsm: misaligned ld/sd, lw/sw, fld/fsd in a page and across pages (%d wrong)", mis);
	if (mp != MAP_FAILED)
		munmap(mp, 8192);
	CHECK(getauxval(AT_HWCAP) == 0x112d, "AT_HWCAP %#lx (IMAFDC)", getauxval(AT_HWCAP));

	/* Hints run as no-ops; instret counts the instruction between two reads. */
	static const uint32_t hints[] = {
		0x0100000f,				/* pause */
		0x00200033, 0x00300033, 0x00400033, 0x00500033, /* ntl.p1 ntl.pall ntl.s1 ntl.all */
		0x00056013, 0x00156013, 0x00356013,	/* prefetch.i/r/w 0(a0) */
		0x900e900a, 0x90169012,			/* c.ntl.p1 c.ntl.pall c.ntl.s1 c.ntl.all */
		0xc0002673, 0xc0102673,			/* rdcycle a2; rdtime a2 */
		0xc0202573, 0x00000013, 0xc02025f3,	/* rdinstret a0; nop; rdinstret a1 */
		0x40a58533, 0x00008067,			/* sub a0, a1, a0; ret */
	};
	long d = 0;
	rc = run_code(hints, sizeof(hints) / 4, 0, 0, &d);
	CHECK(rc == 0 && d == 2, "hints (pause, ntl, c.ntl, prefetch) and cycle/time/instret: instret delta %ld", d);

	/* Optional extensions: an instruction of each runs iff it is listed. */
	int ran = 0, trapped = 0;
	bad = 0;
	for (int i = 0; i < NISA; i++) {
		const struct isa_ext *e = &isa_exts[i];
		uint32_t code[2] = { e->probe, 0x00008067 };
		long r = 0;
		int listed;

		if (!e->probe)
			continue;
		listed = have[i] || (e->alt && have[isa_find(e->alt, strlen(e->alt))]);
		rc = run_code(code, 2, e->mem ? (long)probe_buf : 3, 5, &r);
		if (rc == 0)
			ran++;
		else
			trapped++;
		if ((rc == 0) != listed) {
			printf("     %s (%#x): %s but %s\n", e->name, e->probe, listed ? "listed" : "not listed",
			       rc == 0 ? "ran" : "raised SIGILL");
			bad++;
		} else if (rc == 0 && e->want && (unsigned long)r != e->want) {
			printf("     %s (%#x): %#lx, want %#lx\n", e->name, e->probe, (unsigned long)r, e->want);
			bad++;
		}
	}
	CHECK(!bad, "optional extensions: %d ran (listed), %d raised SIGILL (not listed)", ran, trapped);

	/* Zkne + Zknd: FIPS-197 C.1 (AES-128) as OpenSSL runs it, long enough to compile */
	if (have[isa_find("zkne", 4)] && have[isa_find("zknd", 4)]) {
		int reps = 0;

		bad = aes_fips(&reps);
		CHECK(!bad, "AES-128 (Zkne, Zknd): FIPS-197 C.1 %d times, %d wrong", reps, bad);
	}
	/* Zba + Zbb + Zbs + Zicond: a mix of them, long enough to compile */
	if (have[isa_find("zba", 3)] && have[isa_find("zbb", 3)] && have[isa_find("zbs", 3)] &&
	    have[isa_find("zicond", 6)]) {
		int reps = 0;

		bad = zb_mix(&reps);
		CHECK(!bad, "Zba, Zbb, Zbs, Zicond: a mix of 13 of them %d times, %d wrong", reps, bad);
	}
	/* Zbc (or Zbkc) + Zbkb: GHASH as OpenSSL runs it, long enough to compile */
	if ((have[isa_find("zbc", 3)] || have[isa_find("zbkc", 4)]) && have[isa_find("zbkb", 4)]) {
		int reps = 0;

		bad = ghash_kat(&reps);
		CHECK(!bad, "GHASH (Zbc, Zbkb): GCM test case 2 %d times, %d wrong", reps, bad);
	}
	rva23_checks(have);
}
#endif /* __riscv */

static volatile int alarms;

static void on_alarm(int sig)
{
	(void)sig;
	alarms++;
}

#ifdef __riscv
static int file_has(const char *path, const char *word)
{
	char buf[4096];
	int fd = open(path, O_RDONLY), n;

	if (fd < 0)
		return 0;
	n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	buf[n > 0 ? n : 0] = 0;
	return strstr(buf, word) != NULL;
}

/*
 * Optional kernel features in kw_defconfig (needs /proc, which isa_checks
 * mounted): the pids controller, user namespaces, userfaultfd, PSI, task
 * I/O accounting, sysrq and the loop-control and tun misc devices.
 */
static void config_checks(void)
{
	int status, uffd;
	pid_t pid = fork();

	if (pid == 0)
		_exit(syscall(SYS_unshare, 0x10000000 /* CLONE_NEWUSER */) ? 1 : 0);
	waitpid(pid, &status, 0);
	uffd = syscall(SYS_userfaultfd, O_CLOEXEC);
	if (uffd >= 0)
		close(uffd);
	CHECK(WIFEXITED(status) && !WEXITSTATUS(status) && uffd >= 0 && file_has("/proc/cgroups", "pids") &&
	      file_has("/proc/pressure/cpu", "some") && file_has("/proc/self/io", "rchar") &&
	      !access("/proc/sysrq-trigger", W_OK) && file_has("/proc/misc", "loop-control") &&
	      file_has("/proc/misc", " tun"),
	      "config: user ns %s, userfaultfd %s, pids cgroup, PSI, /proc/self/io, sysrq, loop-control, tun",
	      WIFEXITED(status) && !WEXITSTATUS(status) ? "ok" : "BAD", uffd >= 0 ? "ok" : "BAD");
}

/*
 * The input handlers. kwinput tells the host when a device is opened, and
 * the host then sends that device the keys and the pointer instead of the
 * console and the page, so only user space may open one: evdev opens a
 * device for a program that reads it, and sysrq is a passive observer
 * (drivers/tty/sysrq.c on wasm). Any other handler (VT kbd, leds, mousedev,
 * joydev, ...) opens every device it matches from boot. Before adding one
 * here, make it passive or keep it off the kwinput devices.
 */
static void input_handler_checks(void)
{
	char buf[1024], other[256] = "";
	int fd = open("/proc/bus/input/handlers", O_RDONLY), n, evdev = 0;
	char *p;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	for (p = buf; (p = strstr(p, "Name=")); ) {
		size_t len = strcspn(p += 5, " \n");

		if (len == 5 && !strncmp(p, "evdev", 5))
			evdev = 1;
		else if (!(len == 5 && !strncmp(p, "sysrq", 5)) && strlen(other) + len + 2 < sizeof(other))
			strncat(strcat(other, " "), p, len);
		p += len;
	}
	CHECK(n > 0 && evdev && !other[0], "input handlers: evdev %s, others besides sysrq:%s",
	      evdev ? "ok" : "MISSING", other[0] ? other : " none");
}
/*
 * A path for the char device maj:min: devtmpfs's node dev when it is there,
 * else one made at tmp (as /init, /dev may have no devtmpfs). The node in
 * /dev comes first because a shell on the overlay root (the page with its
 * data disk) has /tmp mounted nodev, where opening a device node fails with
 * EACCES. *made says whether tmp was made (the caller unlinks it). NULL if
 * neither works.
 */
static const char *chrdev_node(const char *dev, const char *tmp, unsigned int maj, unsigned int min, int *made)
{
	struct stat st;

	*made = 0;
	if (!stat(dev, &st) && S_ISCHR(st.st_mode) && st.st_rdev == makedev(maj, min))
		return dev;
	unlink(tmp);   /* left over from a run that was killed */
	if (mknod(tmp, S_IFCHR | 0600, makedev(maj, min)))
		return NULL;
	*made = 1;
	return tmp;
}

/*
 * AF_VSOCK (kwvsock, net/vmw_vsock/kwvsock.c). The guest's CID comes from
 * /dev/vsock (its minor from /proc/misc; chrdev_node). With a host device
 * (the CLI's and the page's default) it is 3, and a connect to host port 9,
 * where nothing listens, is refused (the host answers the request with RST:
 * ECONNRESET). Without one (CLI --no-vsock) there is no transport:
 * VMADDR_CID_ANY, and connect fails with ENODEV.
 */
static void vsock_checks(void)
{
	struct sockaddr_vm a = { .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = 9 };
	const char *node;
	unsigned int cid = VMADDR_CID_ANY, minor;
	char buf[4096], *p;
	int fd = open("/proc/misc", O_RDONLY), n, s, rc, err = 0, made;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	p = strstr(buf, " vsock\n");
	while (p && p > buf && p[-1] != '\n')
		p--;
	if (p && sscanf(p, "%u vsock", &minor) == 1 &&
	    (node = chrdev_node("/dev/vsock", "/tmp/.kwtest-vsock", 10, minor, &made))) {
		fd = open(node, O_RDONLY);
		if (made)
			unlink(node);
		if (fd >= 0) {
			ioctl(fd, IOCTL_VM_SOCKETS_GET_LOCAL_CID, &cid);
			close(fd);
		}
	}
	s = socket(AF_VSOCK, SOCK_STREAM, 0);
	rc = s < 0 ? -1 : connect(s, (struct sockaddr *)&a, sizeof(a));
	err = rc ? errno : 0;
	if (s >= 0)
		close(s);
	if (cid == VMADDR_CID_ANY)
		CHECK(s >= 0 && rc && err == ENODEV, "vsock: no host device (CLI --no-vsock): socket %s, connect: %s",
		      s >= 0 ? "ok" : "FAILED", rc ? strerror(err) : "succeeded?");
	else
		CHECK(cid == 3 && s >= 0 && rc && err == ECONNRESET, "vsock: guest CID %u, connect to host port 9 (nothing listens): %s",
		      cid, rc ? strerror(err) : "succeeded?");
}

/*
 * 9p (NET_9P, NET_9P_FD, 9P_FS in kw_defconfig): the file system type the
 * SDK's host mounts use (kernel/guest/kw9p.c, js/core/9p.ts). Kconfig drops
 * options silently, so pin that it is registered.
 */
static void ninep_checks(void)
{
	char buf[4096];
	int fd = open("/proc/filesystems", O_RDONLY), n;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	CHECK(strstr(buf, "\t9p\n") != NULL, "9p: file system type %s", strstr(buf, "\t9p\n") ? "registered" : "MISSING from /proc/filesystems");
}

/* From the kernel's include/uapi/linux/kwshm.h. */
struct kwshm_export {
	int32_t fd;
	uint32_t flags;
	uint64_t offset;
	uint64_t length;
	uint64_t size;
	uint32_t id;
	uint32_t pages;
};
#define KWSHM_IOC_EXPORT	_IOWR(0xBB, 0x00, struct kwshm_export)
#define KWSHM_IOC_RELEASE	_IOW(0xBB, 0x01, uint32_t)
#ifndef F_ADD_SEALS
#define F_ADD_SEALS	1033
#define F_SEAL_WRITE	0x0008
#endif

/* A minor from /proc/misc ("NN name"), -1 if absent. */
static int misc_minor(const char *name)
{
	char buf[4096], pat[64], *p;
	int fd = open("/proc/misc", O_RDONLY), n;
	unsigned int minor;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	snprintf(pat, sizeof(pat), " %s\n", name);
	p = strstr(buf, pat);
	while (p && p > buf && p[-1] != '\n')
		p--;
	return p && sscanf(p, "%u", &minor) == 1 ? (int)minor : -1;
}

static int shm_memfd(size_t size)
{
	int fd = syscall(__NR_memfd_create, "kwtest", 2 /* MFD_ALLOW_SEALING */);

	if (fd >= 0 && ftruncate(fd, size)) {
		close(fd);
		fd = -1;
	}
	return fd;
}

/*
 * kwshm (drivers/misc/kwshm.c): /dev/kwshm exists only with a host device
 * (CLI --shm). With one: a 1 MiB memfd, half of it written (the rest are
 * holes, allocated by the export), exports as 256 pages with an id; an
 * unaligned offset, a range past the end and a pipe are refused (EINVAL);
 * while exported its pages are pinned, so F_SEAL_WRITE fails with EBUSY
 * (the extra references that also stop migration); after KWSHM_IOC_RELEASE
 * a second release is ENOENT, and a range export released by closing
 * /dev/kwshm no longer blocks the seal either.
 */
static void shm_checks(void)
{
	const char *node = "/tmp/.kwtest-kwshm";
	int minor = misc_minor("kwshm"), dev, fd, fd2, p[2] = { -1, -1 };
	struct kwshm_export e = { 0 }, bad = { 0 }, r = { 0 };
	int rc, rc_unal, rc_past, rc_pipe, seal_busy, seal_after, rel2, seal_closed;
	static char half[512 * 1024];

	if (minor < 0) {
		CHECK(1, "kwshm: no host device (skipped; CLI --shm adds one)");
		return;
	}
	dev = mknod(node, S_IFCHR | 0600, makedev(10, minor)) ? -1 : open(node, O_RDWR);
	unlink(node);
	fd = shm_memfd(1 << 20);
	memset(half, 0x5a, sizeof(half));
	if (fd >= 0)
		write(fd, half, sizeof(half));
	e.fd = fd;
	rc = ioctl(dev, KWSHM_IOC_EXPORT, &e) ? errno : 0;
	bad.fd = fd;
	bad.offset = 100;
	rc_unal = ioctl(dev, KWSHM_IOC_EXPORT, &bad) ? errno : 0;
	bad.offset = 4096;
	bad.length = 1 << 20;
	rc_past = ioctl(dev, KWSHM_IOC_EXPORT, &bad) ? errno : 0;
	pipe(p);
	bad.fd = p[0];
	bad.offset = bad.length = 0;
	rc_pipe = ioctl(dev, KWSHM_IOC_EXPORT, &bad) ? errno : 0;
	close(p[0]);
	close(p[1]);
	seal_busy = fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE) ? errno : 0;
	rc = rc ? rc : ioctl(dev, KWSHM_IOC_RELEASE, &e.id) ? errno : 0;
	rel2 = ioctl(dev, KWSHM_IOC_RELEASE, &e.id) ? errno : 0;
	seal_after = fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE) ? errno : 0;
	close(fd);
	/* A range export, released by closing the device. */
	fd2 = shm_memfd(1 << 20);
	r.fd = fd2;
	r.offset = 8192;
	r.length = 10000;
	if (ioctl(dev, KWSHM_IOC_EXPORT, &r))
		r.pages = 0;
	close(dev);
	seal_closed = fcntl(fd2, F_ADD_SEALS, F_SEAL_WRITE) ? errno : 0;
	close(fd2);
	CHECK(dev >= 0 && !rc && e.id > 0 && e.size == 1 << 20 && e.pages == 256 && rc_unal == EINVAL &&
	      rc_past == EINVAL && rc_pipe == EINVAL && seal_busy == EBUSY && rel2 == ENOENT && !seal_after &&
	      r.size == 10000 && r.pages == 3 && !seal_closed,
	      "kwshm: export id %u, %llu bytes in %u pages (%s); refused: unaligned %s, past the end %s, a pipe %s; "
	      "F_SEAL_WRITE while exported: %s, after release: %s; second release: %s; range: %llu bytes in %u pages, "
	      "seal after closing /dev/kwshm: %s",
	      e.id, (unsigned long long)e.size, e.pages, rc ? strerror(rc) : "ok", strerror(rc_unal), strerror(rc_past),
	      strerror(rc_pipe), seal_busy ? strerror(seal_busy) : "allowed?", seal_after ? strerror(seal_after) : "ok",
	      strerror(rel2), (unsigned long long)r.size, r.pages, seal_closed ? strerror(seal_closed) : "ok");
}

/* Open and close @path: 0, or the errno of the open. */
static int open_err(const char *path)
{
	int fd = open(path, O_RDWR);

	if (fd < 0)
		return errno;
	close(fd);
	return 0;
}

/*
 * kwfb (drivers/video/fbdev/kwfb.c): /dev/fb0 (char 29:0; chrdev_node)
 * exists only with a host display (CLI --display). One program at a time:
 * while an open file exists a second open fails with EBUSY, also once its
 * opener has closed it but a forked child still holds the shared file, and
 * while a mapping outlives close(); when the last reference is gone (the
 * child's exit, munmap) the device opens again.
 */
static void fb_checks(void)
{
	const char *node;
	int fd = open("/proc/fb", O_RDONLY), n, a, b, go[2] = { -1, -1 }, status = 0, made;
	int a_err, busy_open, busy_child, after_child, busy_map, after_map;
	char buf[256], c = 0;
	void *map = MAP_FAILED;
	pid_t pid;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	if (!strstr(buf, "0 kwfb")) {
		CHECK(1, "kwfb: no host display (skipped; CLI --display adds one)");
		return;
	}
	node = chrdev_node("/dev/fb0", "/tmp/.kwtest-fb0", 29, 0, &made);
	a = node ? open(node, O_RDWR) : -1;
	a_err = a < 0 ? errno : 0;
	if (!node)
		node = "/tmp/.kwtest-fb0";   /* so the opens below fail and report */
	busy_open = open_err(node);
	/* The child shares the file; it outlives the parent's close. */
	pipe(go);
	pid = fork();
	if (pid == 0) {
		read(go[0], &c, 1);
		_exit(0);
	}
	if (a >= 0)
		close(a);
	busy_child = open_err(node);
	write(go[1], &c, 1);
	waitpid(pid, &status, 0);
	close(go[0]);
	close(go[1]);
	/* A mapping keeps the file after close(). */
	b = open(node, O_RDWR);
	if (b >= 0) {
		after_child = 0;
		map = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, b, 0);
		close(b);
	} else {
		after_child = errno;
	}
	busy_map = open_err(node);
	if (map != MAP_FAILED)
		munmap(map, 4096);
	after_map = open_err(node);
	if (made)
		unlink(node);
	CHECK(a >= 0 && busy_open == EBUSY && busy_child == EBUSY && WIFEXITED(status) && !after_child &&
	      map != MAP_FAILED && busy_map == EBUSY && !after_map,
	      "kwfb: first open %s; second open: %s, held by a forked child: %s, after its exit: %s; mmap %s, "
	      "open while mapped after close: %s, after munmap: %s",
	      a >= 0 ? "ok" : strerror(a_err), busy_open ? strerror(busy_open) : "allowed?",
	      busy_child ? strerror(busy_child) : "allowed?", after_child ? strerror(after_child) : "ok",
	      map != MAP_FAILED ? "ok" : "FAILED", busy_map ? strerror(busy_map) : "allowed?",
	      after_map ? strerror(after_map) : "ok");
}

/*
 * Parking (arch/wasm/kernel/park.c): every task stops at a point where its
 * state is all in memory and resumes on a fresh stack. Children sleep in
 * read, poll, nanosleep, futex and epoll_wait, or run hot() in user mode,
 * while this process requests cycles through /proc/kwpark (and is parked
 * itself while it waits). Interrupted sleeps must restart transparently;
 * only epoll_wait may return EINTR (as after SIGSTOP and SIGCONT).
 */
struct park_info {
	unsigned req, done, users, kthreads;
	int result;
	unsigned long long us;
	char blocker[64];
};

static int park_read(struct park_info *p)
{
	char buf[256];
	int fd = open("/proc/kwpark", O_RDONLY), n;

	if (fd < 0)
		return -1;
	n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	if (n <= 0)
		return -1;
	buf[n] = 0;
	return sscanf(buf, "requests %u done %u result %d users %u kthreads %u us %llu blocker %63s",
		      &p->req, &p->done, &p->result, &p->users, &p->kthreads, &p->us, p->blocker) == 7 ? 0 : -1;
}

/* Request a cycle and wait for it (or one that started after the request). */
static int park_cycle(struct park_info *p)
{
	struct timespec ms = { 0, 1000000 };
	unsigned want;
	int fd, i;

	if (park_read(p))
		return -1;
	want = p->req + 1;
	fd = open("/proc/kwpark", O_WRONLY);
	if (fd < 0 || write(fd, "1", 1) != 1)
		return -1;
	close(fd);
	for (i = 0; i < 5000; i++) {
		nanosleep(&ms, NULL);
		if (park_read(p))
			return -1;
		if ((int)(p->done - want) >= 0)
			return 0;
	}
	return -1;
}

static double mono(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec * 1e-9;
}

enum { PK_READ, PK_POLL, PK_SLEEP, PK_FUTEX, PK_EPOLL, PK_HOT, PK_N };
static const char *const park_names[PK_N] = { "read", "poll", "nanosleep", "futex", "epoll_wait", "hot" };

/* Exit status: 0 ok, 1 wrong result. Writes the number of EINTRs to *eintr. */
static int park_child(int kind, int rfd, volatile int *shared, volatile int *eintr)
{
	char c = 0;
	int r;

	switch (kind) {
	case PK_READ:
		r = read(rfd, &c, 1);
		return !(r == 1 && c == 'r');
	case PK_POLL: {
		struct pollfd pf = { rfd, POLLIN, 0 };

		r = poll(&pf, 1, 20000);
		return !(r == 1 && (pf.revents & POLLIN) && read(rfd, &c, 1) == 1 && c == 'p');
	}
	case PK_SLEEP: {
		struct timespec ts = { 0, 600000000 };	/* 0.6 s, across many cycles */
		double t = mono();

		r = nanosleep(&ts, NULL);
		t = mono() - t;
		return !(r == 0 && t >= 0.6);
	}
	case PK_FUTEX:
		while (!*shared) {
			r = syscall(SYS_futex, shared, FUTEX_WAIT, 0, NULL, NULL, 0);
			if (r < 0 && errno != EAGAIN)
				return 1;	/* EINTR would be a bug: FUTEX_WAIT restarts */
		}
		return 0;
	case PK_EPOLL: {
		struct epoll_event ev = { .events = EPOLLIN }, out;
		int ep = epoll_create1(0);

		epoll_ctl(ep, EPOLL_CTL_ADD, rfd, &ev);
		for (;;) {
			r = epoll_wait(ep, &out, 1, -1);
			if (r < 0 && errno == EINTR) {
				(*eintr)++;
				continue;
			}
			return !(r == 1 && read(rfd, &c, 1) == 1 && c == 'e');
		}
	}
	case PK_HOT: {
		int bad = 0, runs = 0;

		while (!*shared || runs < 2) {
			bad += hot(HOT_SEED) != HOT_EXPECT;
			runs++;
		}
		return bad != 0;
	}
	}
	return 1;
}

static void park_checks(void)
{
	struct park_info p = { 0 }, first;
	int fds[PK_N][2], st[PK_N], bad_cycles = 0, ok_children = 0, i, n = 0;
	unsigned long long us_sum = 0, us_max = 0;
	volatile int *shared;
	pid_t pid[PK_N];
	char wake[PK_N] = { 'r', 'p', 0, 0, 'e', 0 };

	if (park_read(&first)) {
		struct utsname u;

		/* An SMP kernel has no parking (kernel.md, Parking). */
		if (!uname(&u) && strstr(u.version, " SMP "))
			CHECK(1, "park: skipped (SMP kernel: no parking)");
		else
			CHECK(0, "park: no /proc/kwpark");
		return;
	}
	shared = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
	shared[0] = 0;	/* futex word and hot()'s stop flag */
	shared[1] = 0;	/* epoll_wait EINTRs */
	for (i = 0; i < PK_N; i++) {
		pipe(fds[i]);
		pid[i] = fork();
		if (pid[i] == 0)
			_exit(park_child(i, fds[i][0], &shared[0], &shared[1]));
	}

	/* Let them block (or start computing), then park and resume 20 times. */
	usleep(50000);
	for (i = 0; i < 20; i++) {
		if (park_cycle(&p) || p.result) {
			if (!bad_cycles++)
				printf("     park cycle %d: result %d, blocker %s\n", i, p.result, p.blocker);
			continue;
		}
		n++;
		us_sum += p.us;
		if (p.us > us_max)
			us_max = p.us;
	}

	shared[0] = 1;
	syscall(SYS_futex, &shared[0], FUTEX_WAKE, 1, NULL, NULL, 0);
	for (i = 0; i < PK_N; i++)
		if (wake[i])
			write(fds[i][1], &wake[i], 1);
	for (i = 0; i < PK_N; i++) {
		waitpid(pid[i], &st[i], 0);
		ok_children += WIFEXITED(st[i]) && !WEXITSTATUS(st[i]);
		if (!(WIFEXITED(st[i]) && !WEXITSTATUS(st[i])))
			printf("     park: %s child: status %#x\n", park_names[i], st[i]);
		close(fds[i][0]);
		close(fds[i][1]);
	}
	CHECK(!bad_cycles && ok_children == PK_N && p.users >= PK_N + 1 && p.kthreads > 0,
	      "park: %d/20 cycles (%u user tasks, %u kernel threads, %llu us mean, %llu us max); "
	      "read, poll, nanosleep, futex restarted, epoll_wait EINTR %d times, hot() in user mode: %d/%d children ok",
	      n, p.users, p.kthreads, n ? us_sum / n : 0, us_max, shared[1], ok_children, PK_N);
	munmap((void *)shared, 4096);
}

/*
 * SMP (more than one CPU online): threads on several CPUs hammer shared
 * counters through AMOs (amoadd), LR/SC (a compare-and-swap loop) and a
 * pthread mutex (LR/SC plus futex wait and wake across CPUs); every
 * increment must count, and the threads must have run on more than one
 * CPU (tasks stay on the CPU they first ran on).
 */
#define SMP_THREADS 3
#define SMP_ITERS 300000
static struct {
	unsigned amo, lrsc, locked;
	pthread_mutex_t lock;
	volatile int go;
} smp_shared = { .lock = PTHREAD_MUTEX_INITIALIZER };

static void *smp_worker(void *arg)
{
	unsigned long cpus = 0;
	unsigned cpu;
	int i;

	while (!smp_shared.go)
		;
	for (i = 0; i < SMP_ITERS; i++) {
		unsigned old = __atomic_load_n(&smp_shared.lrsc, __ATOMIC_RELAXED);

		__atomic_fetch_add(&smp_shared.amo, 1, __ATOMIC_RELAXED);
		while (!__atomic_compare_exchange_n(&smp_shared.lrsc, &old, old + 1, 1,
						    __ATOMIC_ACQ_REL, __ATOMIC_RELAXED))
			;
		if (!(i & 15)) {
			pthread_mutex_lock(&smp_shared.lock);
			smp_shared.locked++;
			pthread_mutex_unlock(&smp_shared.lock);
		}
		if (!(i & 4095) && !syscall(SYS_getcpu, &cpu, NULL, NULL) && cpu < 64)
			cpus |= 1UL << cpu;
	}
	return (void *)cpus;
}

static void smp_checks(void)
{
	long online = sysconf(_SC_NPROCESSORS_ONLN);
	unsigned long cpus = 0;
	pthread_t th[SMP_THREADS];
	int i, made = 0;
	void *r;

	if (online < 2) {
		printf("ok   smp: one CPU online (skipped)\n");
		return;
	}
	/* This thread works too: new threads go to the least busy CPU. */
	for (i = 1; i < SMP_THREADS; i++)
		made += !pthread_create(&th[i], NULL, smp_worker, NULL);
	smp_shared.go = 1;
	cpus = (unsigned long)smp_worker(NULL);
	made++;
	for (i = 1; i < SMP_THREADS; i++)
		if (!pthread_join(th[i], &r))
			cpus |= (unsigned long)r;
	CHECK(made == SMP_THREADS && smp_shared.amo == SMP_THREADS * SMP_ITERS &&
	      smp_shared.lrsc == SMP_THREADS * SMP_ITERS &&
	      smp_shared.locked == SMP_THREADS * (SMP_ITERS / 16) && __builtin_popcountl(cpus) >= 2,
	      "smp: %ld CPUs; %d threads on CPUs %#lx: amoadd %u, lr/sc %u, mutex %u (want %u, %u, %u)",
	      online, made, cpus, smp_shared.amo, smp_shared.lrsc, smp_shared.locked,
	      SMP_THREADS * SMP_ITERS, SMP_THREADS * SMP_ITERS, SMP_THREADS * (SMP_ITERS / 16));
}
#endif /* __riscv */

static void *hot_thread(void *arg)
{
	return (void *)hot((unsigned long)arg);
}

int main(int argc, char **argv)
{
	struct utsname u;
	const char msg[] = "hello from riscv64 user mode via write()\n";

	if (argc > 1 && !strcmp(argv[1], "child"))
		return 7;	/* exec'd by the execve test */
	if (argc > 1 && !strcmp(argv[1], "hot")) {
		printf("%#lx\n", hot(HOT_SEED));	/* HOT_EXPECT, see hot() */
		return 0;
	}
	if (argc > 1 && !strcmp(argv[1], "fphot")) {
		printf("%#lx\n", fphot(HOT_SEED));	/* FPHOT_EXPECT, see fphot() */
		return 0;
	}

	write(1, msg, sizeof(msg) - 1);

	uname(&u);
	CHECK(!strcmp(u.machine, "riscv64"), "uname: %s %s %s", u.sysname, u.release, u.machine);
	CHECK(getpid() == 1 || getppid() > 0, "getpid = %d", getpid());
#ifdef __riscv
	isa_checks();
#endif

	/* brk/malloc and anonymous mmap */
	char *big = malloc(1 << 20);
	memset(big, 0x5a, 1 << 20);
	CHECK(big[12345] == 0x5a, "malloc 1 MiB");
	char *m = mmap(NULL, 3 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	CHECK(m != MAP_FAILED && m[4096] == 0, "mmap anon");
	strcpy(m + 4096, "cow");

	/* fork + COW + wait */
	int pipefd[2];
	pipe(pipefd);
	pid_t pid = fork();
	if (pid == 0) {
		strcpy(m + 4096, "child");
		write(pipefd[1], m + 4096, 6);
		_exit(42);
	}
	int status = 0;
	char buf[16] = { 0 };
	read(pipefd[0], buf, sizeof(buf));
	waitpid(pid, &status, 0);
	CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 42, "fork/wait status %d", WEXITSTATUS(status));
	CHECK(!strcmp(buf, "child") && !strcmp(m + 4096, "cow"), "pipe '%s', COW kept parent '%s'", buf, m + 4096);

	/* signals */
	signal(SIGUSR1, on_usr1);
	kill(getpid(), SIGUSR1);
	CHECK(got_signal == SIGUSR1, "signal handler + sigreturn");

	/* floating point survives a signal */
	volatile double d = 1.5;
	kill(getpid(), SIGUSR1);
	d = d * 3.0;
	CHECK(d == 4.5, "fp %.2f", d);

	/* mprotect + SIGSEGV in a child */
	pid = fork();
	if (pid == 0) {
		mprotect(m, 4096, PROT_READ);
		m[0] = 1;
		_exit(0);
	}
	waitpid(pid, &status, 0);
	CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGSEGV, "SIGSEGV on write to read-only page");

	/* threads: clone(CLONE_SETTLS | CLONE_CHILD_CLEARTID) argument order */
	pthread_t th;
	void *thr = NULL;
	tls_var = 1;
	int prc = pthread_create(&th, NULL, thread_fn, NULL);
	CHECK(prc == 0 && pthread_join(th, &thr) == 0 && thr == (void *)th && tls_var == 1,
	      "pthread: create/join, pthread_self and TLS in the thread");

	/* exec */
	pid = fork();
	if (pid == 0) {
		char *av[] = { argv[0], "child", NULL };
		execvp(argv[0], av);
		_exit(99);
	}
	waitpid(pid, &status, 0);
	CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 7, "execve child exited %d", WEXITSTATUS(status));

	/*
	 * JIT tier: hot() in this process, in a thread and in a forked child
	 * (COW), while a 1 ms SIGALRM timer interrupts the compiled loops. Runs
	 * until at least 3 signals arrived.
	 */
	struct itimerval it = { { 0, 1000 }, { 0, 1000 } }, off = { 0 };
	pthread_t ht;
	void *hres = NULL;
	int runs = 0, bad = 0;

	signal(SIGALRM, on_alarm);
	setitimer(ITIMER_REAL, &it, NULL);
	prc = pthread_create(&ht, NULL, hot_thread, (void *)HOT_SEED);
	pid = fork();
	if (pid == 0)
		_exit(hot(HOT_SEED) == HOT_EXPECT ? 0 : 1);
	do {
		bad += hot(HOT_SEED) != HOT_EXPECT;
		runs++;
	} while ((alarms < 3 || runs < 2) && runs < 200);
	if (prc == 0)
		pthread_join(ht, &hres);
	waitpid(pid, &status, 0);
	setitimer(ITIMER_REAL, &off, NULL);
	CHECK(!bad && prc == 0 && (unsigned long)hres == HOT_EXPECT && WIFEXITED(status) && !WEXITSTATUS(status) && alarms >= 3,
	      "hot loops (JIT): %d runs, %d bad; thread %s, child %s; %d SIGALRMs", runs, bad,
	      (unsigned long)hres == HOT_EXPECT ? "ok" : "BAD", WIFEXITED(status) && !WEXITSTATUS(status) ? "ok" : "BAD", alarms);

	/* JIT tier, F/D: the FP hot loop twice (the second run is compiled) */
	unsigned long fp1 = fphot(HOT_SEED), fp2 = fphot(HOT_SEED);
	CHECK(fp1 == FPHOT_EXPECT && fp2 == FPHOT_EXPECT, "FP hot loop (JIT): %#lx %#lx, want %#lx", fp1, fp2, FPHOT_EXPECT);

#ifdef __riscv
	config_checks();
	input_handler_checks();
	vsock_checks();
	ninep_checks();
	shm_checks();
	fb_checks();
	park_checks();
	smp_checks();
#endif

	printf("kwtest: %d failure(s)\n", failures);
	fflush(stdout);
	if (getpid() == 1) {
		sync();
		reboot(failures ? RB_HALT_SYSTEM : RB_POWER_OFF);
	}
	return failures != 0;
}
