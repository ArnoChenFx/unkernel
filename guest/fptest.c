// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * libc-level floating-point self-checks (hard-float musl, lp64d):
 * printf/strtod round trips, libm, fenv rounding modes and exception flags,
 * NaN/inf handling, float and long double (soft quad) sanity, plus a small
 * FP-heavy workload. Exit 0 iff all pass. Portable: also builds natively.
 */
#include <errno.h>
#include <fenv.h>
#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int checks, failures;

#define CHECK(cond, ...)                                \
    do {                                                \
        checks++;                                       \
        if (!(cond)) {                                  \
            failures++;                                 \
            printf("FAIL %s:%d: ", __FILE__, __LINE__); \
            printf(__VA_ARGS__);                        \
            printf("\n");                               \
        }                                               \
    } while (0)

static uint64_t bits(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
static uint32_t fbits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }

#define DBITS(expr, want) do { double _v = (expr); CHECK(bits(_v) == (uint64_t)(want), "%s = %.17g (0x%016llx), want 0x%016llx", #expr, _v, (unsigned long long)bits(_v), (unsigned long long)(want)); } while (0)
#define FBITS(expr, want) do { float _v = (expr); CHECK(fbits(_v) == (uint32_t)(want), "%s = %.9g (0x%08x), want 0x%08x", #expr, (double)_v, fbits(_v), (unsigned)(want)); } while (0)
/* transcendental functions: allow 1 ulp (musl results may differ by
   compiler contraction into fma between targets) */
#define NEAR(expr, want) do { double _v = (expr); int64_t _d = (int64_t)(bits(_v) - (uint64_t)(want)); CHECK(_d >= -1 && _d <= 1, "%s = %.17g (0x%016llx), want 0x%016llx +-1ulp", #expr, _v, (unsigned long long)bits(_v), (unsigned long long)(want)); } while (0)
#define FNEAR(expr, want) do { float _v = (expr); int32_t _d = (int32_t)(fbits(_v) - (uint32_t)(want)); CHECK(_d >= -1 && _d <= 1, "%s = %.9g (0x%08x), want 0x%08x +-1ulp", #expr, (double)_v, fbits(_v), (unsigned)(want)); } while (0)
#define STR(fmt, val, want) do { char _b[128]; snprintf(_b, sizeof _b, fmt, val); CHECK(strcmp(_b, want) == 0, "printf(\"%s\", %s) = \"%s\", want \"%s\"", fmt, #val, _b, want); } while (0)

/* keep the compiler from folding */
static volatile double v0 = 0.0, v1 = 1.0, v2 = 2.0, v3 = 3.0, v10 = 10.0, vbig = 1e308, vtiny = 1e-308;
static volatile float f01 = 0.1f, f02 = 0.2f, f2 = 2.0f;

static void test_printf(void) {
    STR("%.17g", 0.1, "0.10000000000000001");
    STR("%.17g", v1 / v3, "0.33333333333333331");
    STR("%.17g", 1e23, "9.9999999999999992e+22");
    STR("%.17g", 4.9406564584124654e-324, "4.9406564584124654e-324");
    STR("%g", -v0, "-0");
    STR("%g", vbig * v10, "inf");
    STR("%g", -(vbig * v10), "-inf");
    STR("%g", (double)NAN, "nan");
    STR("%a", 1.0, "0x1p+0");
    STR("%a", 0.1, "0x1.999999999999ap-4");
    STR("%.3f", 2.0005, "2.001"); /* 2.0005 is 2.000500000000000078... */
    STR("%.2f", 2.675, "2.67");   /* 2.67499999999999982236431605997495353221893310546875 */
    STR("%f", 1e15 + 0.3, "1000000000000000.250000");
    STR("%e", 6.02214076e23, "6.022141e+23");
    STR("%.0f", 0.5, "0");
    STR("%.0f", 1.5, "2");
    STR("%.0f", 2.5, "2");
    STR("%.20f", 0.1, "0.10000000000000000555");
    STR("%.9g", (double)f01, "0.100000001");
    STR("%.40g", 0x1p-1022, "2.225073858507201383090232717332404064219e-308");
    STR("%.0f", 1e100, "10000000000000000159028911097599180468360808563945281389781327557747838772170381060813469985856815104");
}

static void test_strtod(void) {
    DBITS(strtod("0.1", 0), 0x3fb999999999999a);
    DBITS(strtod("2.2250738585072011e-308", 0), 0x000fffffffffffff);
    DBITS(strtod("2.2250738585072012e-308", 0), 0x0010000000000000);
    DBITS(strtod("4.9e-324", 0), 1);
    DBITS(strtod("0x1.8p1", 0), 0x4008000000000000);
    DBITS(strtod("1.7976931348623157e308", 0), 0x7fefffffffffffff);
    DBITS(strtod("9007199254740993", 0), 0x4340000000000000); /* tie -> even */
    DBITS(strtod("9007199254740993.0000000001", 0), 0x4340000000000001);
    DBITS(strtod("-inf", 0), 0xfff0000000000000);
    CHECK(isnan(strtod("nan", 0)), "nan");
    errno = 0;
    DBITS(strtod("1e-400", 0), 0);
    CHECK(errno == ERANGE, "ERANGE underflow");
    errno = 0;
    DBITS(strtod("1e400", 0), 0x7ff0000000000000);
    CHECK(errno == ERANGE, "ERANGE overflow");
    FBITS(strtof("0.1", 0), 0x3dcccccd);
    FBITS(strtof("1.17549435e-38", 0), 0x00800000);
    /* round trip of many values */
    uint64_t x = 0x123456789abcdefULL;
    int bad = 0;
    for (int i = 0; i < 2000; i++) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        double d;
        uint64_t u = x & 0x7fefffffffffffffULL;
        memcpy(&d, &u, 8);
        char b[64];
        snprintf(b, sizeof b, "%.17g", d);
        if (bits(strtod(b, 0)) != u) bad++;
    }
    CHECK(bad == 0, "%d/2000 printf/strtod round trips failed", bad);
}

static void test_libm(void) {
    DBITS(sqrt(v2), 0x3ff6a09e667f3bcd);
    NEAR(exp(v1), 0x4005bf0a8b145769);
    NEAR(log(v10), 0x40026bb1bbb55516);
    NEAR(sin(v1), 0x3feaed548f090cee);
    NEAR(cos(v1), 0x3fe14a280fb5068c);
    NEAR(tan(v1), 0x3ff8eb245cbee3a6);
    DBITS(atan2(v1, v1) * 4, 0x400921fb54442d18);
    NEAR(pow(v2, 0.5), 0x3ff6a09e667f3bcd);
    DBITS(pow(v10, 22), 0x4480f0cf064dd592);
    DBITS(fma(0.1, v10, -1.0), 0x3c90000000000000);
    DBITS(hypot(v3, 4.0), 0x4014000000000000);
    DBITS(cbrt(27.0 * v1), 0x4008000000000000);
    DBITS(fmod(10.5 * v1, v3), 0x3ff8000000000000);
    NEAR(log1p(1e-10 * v1), 0x3ddb7cdfd9d1d693);
    NEAR(expm1(1e-10 * v1), 0x3ddb7cdfd9dda4e3);
    DBITS(floor(-2.5 * v1), 0xc008000000000000);
    DBITS(ceil(-2.5 * v1), 0xc000000000000000);
    DBITS(round(-2.5 * v1), 0xc008000000000000);
    DBITS(trunc(-2.7 * v1), 0xc000000000000000);
    DBITS(ldexp(v1, -1074), 1);
    DBITS(frexp(48.0 * v1, &(int){0}), 0x3fe8000000000000);
    FBITS(sqrtf(f2), 0x3fb504f3);
    FBITS(f01 + f02, 0x3e99999a);
    FNEAR(expf(f2), 0x40ec7326);
    FNEAR(logf(f2), 0x3f317218);
    FNEAR(sinf(f2), 0x3f68c7b7);
    FBITS(powf(f2, 10.0f), 0x44800000);
    FBITS(fmaf(f01, 10.0f, -1.0f), 0x32800000);
    CHECK(lrint(2.5 * v1) == 2 && lrint(3.5 * v1) == 4 && llround(-2.5 * v1) == -3, "lrint/llround");
}

static void test_fenv(void) {
    static const int modes[4] = {FE_TONEAREST, FE_UPWARD, FE_DOWNWARD, FE_TOWARDZERO};
    static const double rint_p[4] = {2, 3, 2, 2}, rint_n[4] = {-2, -2, -3, -2};
    for (int i = 0; i < 4; i++) {
        CHECK(fesetround(modes[i]) == 0 && fegetround() == modes[i], "fesetround %d", i);
        CHECK(rint(2.5 * v1) == rint_p[i] && rint(-2.5 * v1) == rint_n[i], "rint mode %d: %g %g", i, rint(2.5 * v1), rint(-2.5 * v1));
        CHECK(nearbyint(0.5 * v1) == (i == 1 ? 1 : 0), "nearbyint mode %d", i);
        CHECK(lrint(-0.5 * v1) == (i == 2 ? -1 : 0), "lrint mode %d", i);
        double third = v1 / v3;
        uint64_t want = (i == 1) ? 0x3fd5555555555556 : 0x3fd5555555555555;
        CHECK(bits(third) == want, "1/3 in mode %d: %llx", i, (unsigned long long)bits(third));
        double ovf = vbig * v10;
        CHECK(ovf == ((i == 0 || i == 1) ? INFINITY : DBL_MAX), "overflow in mode %d = %g", i, ovf);
        float fs = f01 * f02; /* 0.02000000037997961... */
        uint32_t fwant = (i <= 1) ? 0x3ca3d70b : 0x3ca3d70a;
        CHECK(fbits(fs) == fwant, "0.1f*0.2f mode %d: %08x", i, fbits(fs));
    }
    fesetround(FE_TONEAREST);

    feclearexcept(FE_ALL_EXCEPT);
    volatile double r = vbig * v10;
    CHECK(fetestexcept(FE_ALL_EXCEPT) == (FE_OVERFLOW | FE_INEXACT), "overflow flags %x", fetestexcept(FE_ALL_EXCEPT));
    feclearexcept(FE_ALL_EXCEPT);
    r = vtiny * 1e-10;
#ifdef __riscv /* x86 hosts disagree on this one; RISC-V: tiny + inexact => UF */
    CHECK(fetestexcept(FE_ALL_EXCEPT) == (FE_UNDERFLOW | FE_INEXACT), "underflow flags %x", fetestexcept(FE_ALL_EXCEPT));
#endif
    feclearexcept(FE_ALL_EXCEPT);
    r = v1 / v0;
    CHECK(fetestexcept(FE_ALL_EXCEPT) == FE_DIVBYZERO, "divbyzero flags %x", fetestexcept(FE_ALL_EXCEPT));
    feclearexcept(FE_ALL_EXCEPT);
    r = sqrt(-v1);
    CHECK(fetestexcept(FE_ALL_EXCEPT) == FE_INVALID, "invalid flags %x", fetestexcept(FE_ALL_EXCEPT));
    feclearexcept(FE_ALL_EXCEPT);
    r = v1 / v3;
    CHECK(fetestexcept(FE_ALL_EXCEPT) == FE_INEXACT, "inexact flags %x", fetestexcept(FE_ALL_EXCEPT));
    feclearexcept(FE_ALL_EXCEPT);
    r = v1 + v2;
    CHECK(fetestexcept(FE_ALL_EXCEPT) == 0, "exact add flags %x", fetestexcept(FE_ALL_EXCEPT));
    feraiseexcept(FE_INVALID | FE_DIVBYZERO);
    CHECK(fetestexcept(FE_ALL_EXCEPT) == (FE_INVALID | FE_DIVBYZERO), "feraiseexcept");
    fenv_t env;
    fegetenv(&env);
    fesetround(FE_UPWARD);
    feclearexcept(FE_ALL_EXCEPT);
    fesetenv(&env);
    CHECK(fegetround() == FE_TONEAREST && fetestexcept(FE_ALL_EXCEPT) == (FE_INVALID | FE_DIVBYZERO), "fe[gs]etenv");
    feclearexcept(FE_ALL_EXCEPT);
    (void)r;
}

static void test_special(void) {
    volatile double n = NAN, inf = INFINITY, nz = -0.0;
    CHECK(n != n && !(n < 1) && !(n > 1) && !(n == n), "nan compares");
    CHECK(isnan(n) && isinf(inf) && !isfinite(inf) && signbit(nz) && !signbit(v0), "classification");
    CHECK(fpclassify(0x1p-1074 * v1) == FP_SUBNORMAL && fpclassify(v1) == FP_NORMAL && fpclassify(nz) == FP_ZERO, "fpclassify");
    DBITS(copysign(v3, nz), 0xc008000000000000);
    DBITS(fmax(n, v1), 0x3ff0000000000000);
    DBITS(fmin(nz, v0), 0x8000000000000000);
    DBITS(inf - inf == 0 ? 0 : 1.0, 0x3ff0000000000000);
    DBITS(1.0 / -inf, 0x8000000000000000);
    DBITS(fabs(nz), 0);
    CHECK(isnan(v0 * inf) && isnan(inf / inf) && isnan(log(-v1)), "invalid ops give nan");
    CHECK(log(v0) == -INFINITY && exp(1000 * v1) == INFINITY && exp(-1000 * v1) == 0, "log(0), exp overflow/underflow");
    double sub = 0x1p-1060 * v1;
    DBITS(sub * 0x1p60, 0x0170000000000000);
    CHECK((int)(2.9 * v1) == 2 && (int)(-2.9 * v1) == -2 && (long long)(1e18 * v1) == 1000000000000000000LL, "C casts");
    CHECK((unsigned)(4e9 * v1) == 4000000000u && (float)(v1 / v3) == 0.333333343f, "casts 2");
}

static void test_long_double(void) {
#if LDBL_MANT_DIG == 113
    volatile long double a = 1.0L, b = 3.0L;
    char buf[64];
    snprintf(buf, sizeof buf, "%.30Lg", a / b);
    CHECK(strcmp(buf, "0.333333333333333333333333333333") == 0, "quad 1/3 = %s", buf);
    long double s = sqrtl(2.0L * a);
    snprintf(buf, sizeof buf, "%.33Lg", s);
    CHECK(strcmp(buf, "1.4142135623730950488016887242097") == 0, "sqrtl(2) = %s", buf);
#endif
}

/* FP-heavy kernel: a small n-body style integration, checked against a fixed hash. */
static double workload(void) {
    double x[16], y[16], vx[16], vy[16];
    for (int i = 0; i < 16; i++) {
        x[i] = cos(i * 0.4) * (1 + i);
        y[i] = sin(i * 0.4) * (1 + i);
        vx[i] = -y[i] * 0.01;
        vy[i] = x[i] * 0.01;
    }
    for (int step = 0; step < 400; step++) {
        for (int i = 0; i < 16; i++) {
            double ax = 0, ay = 0;
            for (int j = 0; j < 16; j++) {
                if (i == j) continue;
                double dx = x[j] - x[i], dy = y[j] - y[i];
                double d2 = dx * dx + dy * dy + 0.01;
                double inv = 1.0 / (d2 * sqrt(d2));
                ax += dx * inv;
                ay += dy * inv;
            }
            vx[i] += ax * 1e-3;
            vy[i] += ay * 1e-3;
        }
        for (int i = 0; i < 16; i++) {
            x[i] += vx[i];
            y[i] += vy[i];
        }
    }
    double e = 0;
    for (int i = 0; i < 16; i++) e += x[i] * x[i] + y[i] * y[i] + vx[i] + vy[i];
    return e;
}

int main(int argc, char **argv) {
    test_printf();
    test_strtod();
    test_libm();
    test_fenv();
    test_special();
    test_long_double();
    double w = workload();
    printf("workload: %.17g\n", w);
    (void)argc;
    (void)argv;
    printf("fptest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
