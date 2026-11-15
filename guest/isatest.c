// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * ISA-level self-checks for rv64gc (inline asm): F/D with static rounding
 * modes and exception flags, NaN boxing, fclass, fmin/fmax, compressed FP
 * loads/stores, misaligned page-straddling accesses, AMOs/LR/SC, M edge
 * cases, counters, fence.i with rewritten code. Exit 0 iff all pass.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

static int checks, failures;

#define CHECK(cond, ...)                                    \
    do {                                                    \
        checks++;                                           \
        if (!(cond)) {                                      \
            failures++;                                     \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);     \
            printf(__VA_ARGS__);                            \
            printf("\n");                                   \
        }                                                   \
    } while (0)
#define EQ(a, b) do { uint64_t _a = (uint64_t)(a), _b = (uint64_t)(b); \
    CHECK(_a == _b, "%s = 0x%llx, want 0x%llx", #a, (unsigned long long)_a, (unsigned long long)_b); } while (0)

enum { NV = 16, DZ = 8, OF = 4, UF = 2, NX = 1 };

static inline unsigned rdflags(void) { /* read and clear fflags */
    unsigned long f;
    __asm__ volatile("csrrw %0, fflags, zero" : "=r"(f));
    return (unsigned)f;
}
static inline uint64_t d2u(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
static inline double u2d(uint64_t u) { double d; memcpy(&d, &u, 8); return d; }
static inline uint32_t f2u(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static inline float u2f(uint32_t u) { float f; memcpy(&f, &u, 4); return f; }

/* raw FP register bits */
static inline uint64_t fbits_d(double d) { uint64_t r; __asm__ volatile("fmv.x.d %0, %1" : "=r"(r) : "f"(d)); return r; }
static inline uint64_t fbits_s(float f) { uint64_t r; __asm__ volatile("fmv.x.d %0, %1" : "=r"(r) : "f"(f)); return r; }
static inline double fraw(uint64_t u) { double d; __asm__ volatile("fmv.d.x %0, %1" : "=f"(d) : "r"(u)); return d; }

#define CVT(insn, rm, x) ({ long _r; __asm__ volatile(insn " %0, %1, " rm : "=r"(_r) : "f"(x)); _r; })
#define CVTF(insn, rm, x) ({ double _r; __asm__ volatile(insn " %0, %1, " rm : "=f"(_r) : "r"(x)); _r; })
#define FOP2(insn, rm, a, b) ({ double _r; __asm__ volatile(insn " %0, %1, %2, " rm : "=f"(_r) : "f"(a), "f"(b)); _r; })
#define FOP2N(insn, a, b) ({ double _r; __asm__ volatile(insn " %0, %1, %2" : "=f"(_r) : "f"(a), "f"(b)); _r; })
#define FCMP(insn, a, b) ({ long _r; __asm__ volatile(insn " %0, %1, %2" : "=r"(_r) : "f"(a), "f"(b)); _r; })
#define FMA(insn, a, b, c) ({ double _r; __asm__ volatile(insn " %0, %1, %2, %3" : "=f"(_r) : "f"(a), "f"(b), "f"(c)); _r; })

static void test_fcvt(void) {
    double v[] = {2.5, -2.5, 0.5, -0.5, 1.5, 2.4999999999999996, -0.0, 7.0};
    long want[][5] = {
        /* rne rtz rdn rup rmm */
        {2, 2, 2, 3, 3},
        {-2, -2, -3, -2, -3},
        {0, 0, 0, 1, 1},
        {0, 0, -1, 0, -1},
        {2, 1, 1, 2, 2},
        {2, 2, 2, 3, 2},
        {0, 0, 0, 0, 0},
        {7, 7, 7, 7, 7},
    };
    for (int i = 0; i < 8; i++) {
        rdflags();
        EQ(CVT("fcvt.w.d", "rne", v[i]), want[i][0]);
        EQ(CVT("fcvt.l.d", "rtz", v[i]), want[i][1]);
        EQ(CVT("fcvt.w.d", "rdn", v[i]), want[i][2]);
        EQ(CVT("fcvt.l.d", "rup", v[i]), want[i][3]);
        EQ(CVT("fcvt.w.d", "rmm", v[i]), want[i][4]);
        EQ(rdflags(), (v[i] == 7.0 || v[i] == 0.0) ? 0 : NX);
        float f = (float)v[i];
        EQ(CVT("fcvt.w.s", "rdn", f), want[i][2]);
    }
    rdflags();
    /* saturation + invalid */
    EQ(CVT("fcvt.w.d", "rtz", 3e9), 0x7fffffff);
    EQ(rdflags(), NV);
    EQ(CVT("fcvt.w.d", "rtz", -3e9), (long)(int32_t)0x80000000);
    EQ(CVT("fcvt.wu.d", "rtz", 3e9), (long)(int32_t)0xb2d05e00); /* sign-extended */
    EQ(rdflags(), NV);
    EQ(CVT("fcvt.wu.d", "rtz", -1.0), 0);
    EQ(rdflags(), NV);
    EQ(CVT("fcvt.wu.d", "rtz", -0.4), 0);
    EQ(rdflags(), NX);
    EQ(CVT("fcvt.lu.d", "rtz", 1.8446744073709552e19), -1L);
    EQ(rdflags(), NV);
    EQ(CVT("fcvt.l.d", "rtz", u2d(0x7ff8000000000000)), 0x7fffffffffffffffL);
    EQ(CVT("fcvt.l.d", "rtz", -__builtin_inf()), (long)0x8000000000000000UL);
    EQ(CVT("fcvt.lu.d", "rtz", __builtin_inf()), -1L);
    EQ(CVT("fcvt.w.s", "rtz", __builtin_nanf("")), 0x7fffffff);
    EQ(CVT("fcvt.wu.s", "rtz", 3e9f), (long)(int32_t)0xb2d05e00);
    EQ(rdflags(), NV);
    EQ(CVT("fcvt.l.d", "rne", -9.223372036854775808e18), (long)0x8000000000000000UL);
    EQ(rdflags(), 0);

    /* int -> float rounding */
    long big = (1L << 53) + 1;
    EQ(d2u(CVTF("fcvt.d.l", "rne", big)), d2u(9007199254740992.0));
    EQ(d2u(CVTF("fcvt.d.l", "rup", big)), d2u(9007199254740994.0));
    EQ(rdflags(), NX);
    EQ(d2u(CVTF("fcvt.d.lu", "rne", -1L)), d2u(18446744073709551616.0));
    EQ(d2u(CVTF("fcvt.d.lu", "rtz", -1L)), d2u(18446744073709549568.0));
    EQ(d2u(CVTF("fcvt.d.w", "rne", -5L)), d2u(-5.0));
    EQ(d2u(CVTF("fcvt.d.wu", "rne", -5L)), d2u(4294967291.0));
    rdflags();
    {
        float r;
        __asm__ volatile("fcvt.s.w %0, %1, rdn" : "=f"(r) : "r"(16777217L));
        EQ(f2u(r), f2u(16777216.0f));
        __asm__ volatile("fcvt.s.w %0, %1, rup" : "=f"(r) : "r"(16777217L));
        EQ(f2u(r), f2u(16777218.0f));
        __asm__ volatile("fcvt.s.w %0, %1, rmm" : "=f"(r) : "r"(16777217L));
        EQ(f2u(r), f2u(16777218.0f));
        __asm__ volatile("fcvt.s.w %0, %1, rne" : "=f"(r) : "r"(16777217L));
        EQ(f2u(r), f2u(16777216.0f));
        EQ(rdflags(), NX);
    }
    /* double -> float */
    {
        float r;
        double x = 1.0 + 0x1p-30;
        __asm__ volatile("fcvt.s.d %0, %1, rne" : "=f"(r) : "f"(x));
        EQ(f2u(r), 0x3f800000);
        __asm__ volatile("fcvt.s.d %0, %1, rup" : "=f"(r) : "f"(x));
        EQ(f2u(r), 0x3f800001);
        EQ(rdflags(), NX);
        __asm__ volatile("fcvt.s.d %0, %1, rne" : "=f"(r) : "f"(1e300));
        EQ(f2u(r), 0x7f800000);
        EQ(rdflags(), OF | NX);
        __asm__ volatile("fcvt.s.d %0, %1, rtz" : "=f"(r) : "f"(1e300));
        EQ(f2u(r), 0x7f7fffff);
        EQ(rdflags(), OF | NX);
        __asm__ volatile("fcvt.s.d %0, %1, rne" : "=f"(r) : "f"(1e-50));
        EQ(f2u(r), 0);
        EQ(rdflags(), UF | NX);
        __asm__ volatile("fcvt.s.d %0, %1" : "=f"(r) : "f"(u2d(0x7ff4000000000000))); /* sNaN */
        EQ(f2u(r), 0x7fc00000);
        EQ(rdflags(), NV);
        double d;
        __asm__ volatile("fcvt.d.s %0, %1" : "=f"(d) : "f"(u2f(0x7f800001))); /* sNaN */
        EQ(d2u(d), 0x7ff8000000000000);
        EQ(rdflags(), NV);
    }
}

static void test_boxing_class(void) {
    /* an improperly NaN-boxed single reads as the canonical NaN */
    double bad = fraw(0x000000003f800000ULL);
    float r;
    __asm__ volatile("fadd.s %0, %1, %1" : "=f"(r) : "f"(bad));
    EQ(fbits_s(r), 0xffffffff7fc00000ULL);
    __asm__ volatile("fmv.s %0, %1" : "=f"(r) : "f"(bad)); /* fsgnj.s also unboxes */
    EQ(fbits_s(r), 0xffffffff7fc00000ULL);
    long x;
    __asm__ volatile("fmv.x.w %0, %1" : "=r"(x) : "f"(bad)); /* fmv.x.w does not */
    EQ(x, 0x3f800000);
    __asm__ volatile("fmv.x.w %0, %1" : "=r"(x) : "f"(-1.5f));
    EQ(x, (long)(int32_t)0xbfc00000);
    float one = 1.0f;
    EQ(fbits_s(one), 0xffffffff3f800000ULL);
    rdflags();
    /* fclass */
    uint64_t dv[] = {0xfff0000000000000, 0xbff0000000000000, 0x800fffffffffffff, 0x8000000000000000,
                     0, 1, 0x3ff0000000000000, 0x7ff0000000000000, 0x7ff4000000000000, 0x7ff8000000000000};
    for (int i = 0; i < 10; i++) {
        __asm__ volatile("fclass.d %0, %1" : "=r"(x) : "f"(u2d(dv[i])));
        EQ(x, 1L << i);
    }
    uint32_t fv[] = {0xff800000, 0xbf800000, 0x807fffff, 0x80000000, 0, 1, 0x3f800000, 0x7f800000, 0x7fa00000, 0x7fc00000};
    for (int i = 0; i < 10; i++) {
        __asm__ volatile("fclass.s %0, %1" : "=r"(x) : "f"(u2f(fv[i])));
        EQ(x, 1L << i);
    }
    EQ(rdflags(), 0);
}

static void test_arith(void) {
    double qnan = u2d(0x7ff8000000000000), snan = u2d(0x7ff4000000000000);
    rdflags();
    /* min/max */
    EQ(d2u(FOP2N("fmin.d", 0.0, -0.0)), d2u(-0.0));
    EQ(d2u(FOP2N("fmax.d", -0.0, 0.0)), d2u(0.0));
    EQ(d2u(FOP2N("fmin.d", qnan, 1.0)), d2u(1.0));
    EQ(d2u(FOP2N("fmax.d", 2.0, qnan)), d2u(2.0));
    EQ(rdflags(), 0);
    EQ(d2u(FOP2N("fmin.d", snan, 1.0)), d2u(1.0));
    EQ(rdflags(), NV);
    EQ(d2u(FOP2N("fmax.d", qnan, qnan)), 0x7ff8000000000000);
    /* compares */
    rdflags();
    EQ(FCMP("feq.d", qnan, 1.0), 0);
    EQ(rdflags(), 0);
    EQ(FCMP("flt.d", qnan, 1.0), 0);
    EQ(rdflags(), NV);
    EQ(FCMP("feq.d", snan, snan), 0);
    EQ(rdflags(), NV);
    EQ(FCMP("fle.d", -0.0, 0.0), 1);
    EQ(FCMP("flt.d", -0.0, 0.0), 0);
    EQ(FCMP("feq.d", -0.0, 0.0), 1);
    /* invalid / div-by-zero / overflow / underflow / inexact */
    EQ(d2u(FOP2("fdiv.d", "rne", 1.0, 0.0)), d2u(__builtin_inf()));
    EQ(rdflags(), DZ);
    EQ(d2u(FOP2("fdiv.d", "rne", 0.0, 0.0)), 0x7ff8000000000000);
    EQ(rdflags(), NV);
    EQ(d2u(FOP2("fsub.d", "rne", __builtin_inf(), __builtin_inf())), 0x7ff8000000000000);
    EQ(rdflags(), NV);
    EQ(d2u(FOP2("fmul.d", "rne", 1e308, 10.0)), d2u(__builtin_inf()));
    EQ(rdflags(), OF | NX);
    EQ(d2u(FOP2("fmul.d", "rtz", 1e308, 10.0)), 0x7fefffffffffffff);
    EQ(d2u(FOP2("fmul.d", "rdn", -1e308, 10.0)), d2u(-__builtin_inf()));
    rdflags();
    FOP2("fmul.d", "rne", 1e-300, 1e-300);
    EQ(rdflags(), UF | NX);
    EQ(d2u(FOP2("fmul.d", "rne", 0x1p-1022, 0x1p-3)), d2u(0x1p-1025)); /* exact subnormal */
    EQ(rdflags(), 0);
    EQ(d2u(FOP2("fadd.d", "rne", 0.5, 0.25)), d2u(0.75));
    EQ(rdflags(), 0);
    double third_ne = FOP2("fdiv.d", "rne", 1.0, 3.0);
    double third_up = FOP2("fdiv.d", "rup", 1.0, 3.0);
    double third_dn = FOP2("fdiv.d", "rdn", 1.0, 3.0);
    EQ(d2u(third_ne), 0x3fd5555555555555);
    EQ(d2u(third_up), 0x3fd5555555555556);
    EQ(d2u(third_dn), 0x3fd5555555555555);
    EQ(rdflags(), NX);
    EQ(d2u(FOP2("fadd.d", "rdn", 1.0, -1.0)), d2u(-0.0));
    EQ(d2u(FOP2("fadd.d", "rne", 1.0, -1.0)), d2u(0.0));
    /* sqrt */
    {
        double r;
        __asm__ volatile("fsqrt.d %0, %1, rne" : "=f"(r) : "f"(2.0));
        EQ(d2u(r), 0x3ff6a09e667f3bcd);
        __asm__ volatile("fsqrt.d %0, %1, rdn" : "=f"(r) : "f"(2.0));
        EQ(d2u(r), 0x3ff6a09e667f3bcc);
        __asm__ volatile("fsqrt.d %0, %1, rup" : "=f"(r) : "f"(2.0));
        EQ(d2u(r), 0x3ff6a09e667f3bcd);
        EQ(rdflags(), NX);
        __asm__ volatile("fsqrt.d %0, %1" : "=f"(r) : "f"(144.0));
        EQ(d2u(r), d2u(12.0));
        EQ(rdflags(), 0);
        __asm__ volatile("fsqrt.d %0, %1" : "=f"(r) : "f"(-1.0));
        EQ(d2u(r), 0x7ff8000000000000);
        EQ(rdflags(), NV);
        __asm__ volatile("fsqrt.d %0, %1" : "=f"(r) : "f"(-0.0));
        EQ(d2u(r), d2u(-0.0));
        float s;
        __asm__ volatile("fsqrt.s %0, %1" : "=f"(s) : "f"(2.0f));
        EQ(f2u(s), 0x3fb504f3);
        EQ(rdflags(), NX);
    }
    /* fused multiply-add family */
    {
        double a = 1.0 + 0x1p-30, p = a * a;
        rdflags();
        EQ(d2u(FMA("fmadd.d", a, a, -p)), d2u(0x1p-60));
        EQ(d2u(FMA("fmsub.d", a, a, p)), d2u(0x1p-60));
        EQ(d2u(FMA("fnmsub.d", a, a, p)), d2u(-0x1p-60));
        EQ(d2u(FMA("fnmadd.d", a, a, -p)), d2u(-0x1p-60));
        EQ(rdflags(), 0);
        EQ(d2u(FMA("fmadd.d", 0.1, 10.0, -1.0)), d2u(0x1p-54));
        EQ(d2u(FMA("fmadd.d", __builtin_inf(), 0.0, qnan)), 0x7ff8000000000000);
        EQ(rdflags(), NV);
        float fa = 1.0f + 0x1p-12f, fp = fa * fa, r;
        __asm__ volatile("fmadd.s %0, %1, %1, %2" : "=f"(r) : "f"(fa), "f"(-fp));
        EQ(f2u(r), f2u(0x1p-24f));
        /* signed zero: (+0 * x) - (+0) = +0 in rne, -0 in rdn */
        double z;
        __asm__ volatile("fmsub.d %0, %1, %2, %1, rdn" : "=f"(z) : "f"(0.0), "f"(5.0));
        EQ(d2u(z), d2u(-0.0));
        __asm__ volatile("fmsub.d %0, %1, %2, %1, rne" : "=f"(z) : "f"(0.0), "f"(5.0));
        EQ(d2u(z), d2u(0.0));
    }
    /* sign injection */
    EQ(d2u(FOP2N("fsgnj.d", 1.5, -0.0)), d2u(-1.5));
    EQ(d2u(FOP2N("fsgnjn.d", 1.5, -0.0)), d2u(1.5));
    EQ(d2u(FOP2N("fsgnjx.d", -1.5, -2.0)), d2u(1.5));
    rdflags();
}

static void test_csr(void) {
    unsigned long v;
    __asm__ volatile("fsrm %0, %1" : "=r"(v) : "r"(3L)); /* returns old = 0 */
    EQ(v, 0);
    __asm__ volatile("frrm %0" : "=r"(v));
    EQ(v, 3);
    double r = FOP2("fdiv.d", "dyn", 1.0, 3.0);
    EQ(d2u(r), 0x3fd5555555555556);
    __asm__ volatile("frcsr %0" : "=r"(v));
    EQ(v, (3 << 5) | NX);
    __asm__ volatile("fscsr %0, %1" : "=r"(v) : "r"(0x1ffL));
    __asm__ volatile("frcsr %0" : "=r"(v));
    EQ(v, 0xff);
    __asm__ volatile("csrwi fcsr, 0");
    __asm__ volatile("csrsi fflags, 5");
    __asm__ volatile("frflags %0" : "=r"(v));
    EQ(v, 5);
    __asm__ volatile("csrci fflags, 1");
    __asm__ volatile("frflags %0" : "=r"(v));
    EQ(v, 4);
    __asm__ volatile("csrwi fcsr, 0");
    unsigned long c0, c1, i0, i1, t0, t1;
    __asm__ volatile("rdcycle %0; rdinstret %1; rdtime %2" : "=r"(c0), "=r"(i0), "=r"(t0));
    for (volatile int i = 0; i < 100; i++) {}
    __asm__ volatile("rdcycle %0; rdinstret %1; rdtime %2" : "=r"(c1), "=r"(i1), "=r"(t1));
    CHECK(i1 - i0 >= 300 && c1 > c0 && t1 >= t0, "counters %lu %lu %lu", i1 - i0, c1 - c0, t1 - t0);
}

static void test_compressed_fp(void) {
    double buf[4] = {1.25, -2.5, 0, 0};
    register double fa0 __asm__("fa0");
    register double fa1 __asm__("fa1") = 3.75;
    register double *a1 __asm__("a1") = buf;
    __asm__ volatile(".option push\n.option rvc\n"
                     "c.fld fa0, 8(a1)\n"
                     "c.fsd fa1, 16(a1)\n"
                     ".option pop"
                     : "=f"(fa0) : "f"(fa1), "r"(a1) : "memory");
    EQ(d2u(fa0), d2u(-2.5));
    EQ(d2u(buf[2]), d2u(3.75));
    register double fa2 __asm__("fa2");
    __asm__ volatile(".option push\n.option rvc\n"
                     "addi sp, sp, -32\n"
                     "c.fsdsp fa1, 16(sp)\n"
                     "c.fldsp fa2, 16(sp)\n"
                     "addi sp, sp, 32\n"
                     ".option pop"
                     : "=f"(fa2) : "f"(fa1) : "memory");
    EQ(d2u(fa2), d2u(3.75));
    /* make sure these really are 16-bit encodings */
    uint16_t enc;
    __asm__ volatile(".option push\n.option rvc\n"
                     "1: c.fld fa0, 8(a1)\n"
                     ".option pop\n"
                     "la t0, 1b\n lhu %0, 0(t0)" : "=r"(enc) : "r"(a1) : "t0", "fa0");
    EQ(enc, 0x2588);
}

static void test_misaligned(void) {
    unsigned char *p = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(p != MAP_FAILED, "mmap");
    unsigned char *q = p + 4093; /* straddles the page boundary; 2nd page not yet touched */
    uint64_t v = 0x0102030405060708ULL, r;
    __asm__ volatile("sd %1, 0(%0)" ::"r"(q), "r"(v) : "memory");
    __asm__ volatile("ld %0, 0(%1)" : "=r"(r) : "r"(q) : "memory");
    EQ(r, v);
    EQ(p[4095], 0x06);
    EQ(p[4096], 0x05);
    double d;
    __asm__ volatile("fld %0, 0(%1)" : "=f"(d) : "r"(p + 4094) : "memory");
    EQ(d2u(d), 0x0102030405060708ULL >> 8 | ((uint64_t)p[4101] << 56));
    __asm__ volatile("fsd %1, 0(%0)" ::"r"(p + 4091), "f"(1.0) : "memory");
    EQ(p[4098], 0x3f);
    EQ(p[4097], 0xf0);
    int32_t w;
    __asm__ volatile("lw %0, 0(%1)" : "=r"(w) : "r"(p + 4095) : "memory");
    EQ((uint32_t)w, 0x3ff00000);
    munmap(p, 8192);
}

static void test_amo(void) {
    static uint64_t m64 __attribute__((aligned(8)));
    static uint32_t m32 __attribute__((aligned(4)));
    long old;
#define AMO(insn, mem, val) ({ long _o; __asm__ volatile(insn " %0, %2, %1" : "=r"(_o), "+A"(mem) : "r"((long)(val)) : "memory"); _o; })
    m64 = 10;
    EQ(AMO("amoadd.d", m64, 5), 10); EQ(m64, 15);
    EQ(AMO("amoswap.d", m64, -1), 15); EQ(m64, (uint64_t)-1);
    EQ(AMO("amoand.d", m64, 0xff0), -1); EQ(m64, 0xff0);
    EQ(AMO("amoor.d", m64, 0xf), 0xff0); EQ(m64, 0xfff);
    EQ(AMO("amoxor.d", m64, 0x0f0), 0xfff); EQ(m64, 0xf0f);
    EQ(AMO("amomin.d", m64, -3), 0xf0f); EQ(m64, (uint64_t)-3);
    EQ(AMO("amomax.d", m64, 7), -3); EQ(m64, 7);
    EQ(AMO("amominu.d", m64, -3), 7); EQ(m64, 7);
    EQ(AMO("amomaxu.d", m64, -3), 7); EQ(m64, (uint64_t)-3);
    m32 = 0x7fffffff;
    EQ(AMO("amoadd.w", m32, 1), 0x7fffffff); EQ(m32, 0x80000000u);
    EQ(AMO("amoswap.w.aqrl", m32, 5), (long)(int32_t)0x80000000); /* sign-extended */
    EQ(AMO("amomin.w", m32, -2), 5); EQ(m32, 0xfffffffeu);
    EQ(AMO("amomaxu.w", m32, 3), -2); EQ(m32, 0xfffffffeu);
    EQ(AMO("amominu.w", m32, 3), -2); EQ(m32, 3);
    /* lr/sc */
    long fail;
    m64 = 100;
    __asm__ volatile("1: lr.d %0, %2\n addi %0, %0, 1\n sc.d %1, %0, %2\n bnez %1, 1b"
                     : "=&r"(old), "=&r"(fail), "+A"(m64) :: "memory");
    EQ(m64, 101);
    EQ(fail, 0);
    __asm__ volatile("sc.w %0, %2, %1" : "=r"(fail), "+A"(m32) : "r"(9L) : "memory"); /* no reservation */
    EQ(fail, 1);
    EQ(m32, 3);
    m32 = 0xffffffff;
    __asm__ volatile("lr.w %0, %1" : "=r"(old) : "A"(m32));
    EQ(old, -1);
}

static void test_muldiv(void) {
    long r;
#define OP(insn, a, b) ({ long _r; __asm__ volatile(insn " %0, %1, %2" : "=r"(_r) : "r"((long)(a)), "r"((long)(b))); _r; })
    EQ(OP("mulh", -1, -1), 0);
    EQ(OP("mulhu", -1, -1), -2);
    EQ(OP("mulhsu", -1, -1), -1);
    EQ(OP("mulh", 0x8000000000000000L, 0x8000000000000000L), 0x4000000000000000L);
    EQ(OP("mulhsu", 0x8000000000000000L, 2), -1);
    EQ(OP("div", 7, 0), -1);
    EQ(OP("divu", 7, 0), -1);
    EQ(OP("rem", 7, 0), 7);
    EQ(OP("div", 0x8000000000000000L, -1), 0x8000000000000000L);
    EQ(OP("rem", 0x8000000000000000L, -1), 0);
    EQ(OP("divw", 0x80000000L, -1), (long)(int32_t)0x80000000);
    EQ(OP("remuw", -7, 0), -7);
    EQ(OP("mulw", 0x10000, 0x10000), 0);
    EQ(OP("divuw", -1, 2), 0x7fffffff);
    r = OP("remw", -7, 2);
    EQ(r, -1);
}

static void test_fence_i(void) {
    uint32_t *code = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(code != MAP_FAILED, "mmap exec");
    long (*fn)(void) = (long (*)(void))code;
    code[0] = 0x02a00513; /* li a0, 42 */
    code[1] = 0x00008067; /* ret */
    __asm__ volatile("fence.i" ::: "memory");
    EQ(fn(), 42);
    code[0] = 0x02b00513; /* li a0, 43 */
    __asm__ volatile("fence.i" ::: "memory");
    EQ(fn(), 43);
    munmap(code, 4096);
}

int main(void) {
    test_fcvt();
    test_boxing_class();
    test_arith();
    test_csr();
    test_compressed_fp();
    test_misaligned();
    test_amo();
    test_muldiv();
    test_fence_i();
    printf("isatest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
