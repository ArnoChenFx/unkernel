// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Zfa (RV64, F and D; built with +zfa): fli.s/d for every index, fminm/
 * fmaxm, fround/froundnx in every static rounding mode and dynamically
 * under every frm, fcvtmod.w.d and fleq/fltq, over edge and random
 * operands, each with the flags it raises; then what the compiler makes
 * of floor/ceil/trunc/round/rint/fmin/fmax and FP constants with Zfa, in
 * loops long enough for the JIT to compile them. Results and flags go into
 * a digest, so the output can be compared with
 *   qemu-riscv64-static -cpu rv64,zfa=true zfatest.elf
 * A few known values are checked directly. Exit 0 iff all pass.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int checks, failures;

#define EQ(a, b)                                                                                \
    do {                                                                                        \
        checks++;                                                                               \
        uint64_t _a = (uint64_t)(a), _b = (uint64_t)(b);                                        \
        if (_a != _b && failures++ < 20)                                                        \
            printf("FAIL line %d: %s = 0x%016llx, want 0x%016llx\n", __LINE__, #a,              \
                   (unsigned long long)_a, (unsigned long long)_b);                             \
    } while (0)

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint64_t next(void)
{
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}

static uint64_t digest = 0xcbf29ce484222325ull;
static void mix(uint64_t v)
{
    digest = (digest ^ v) * 0x100000001b3ull;
}

static uint64_t bd(double d)
{
    uint64_t u;
    memcpy(&u, &d, 8);
    return u;
}
static double db(uint64_t u)
{
    double d;
    memcpy(&d, &u, 8);
    return d;
}
static uint32_t bs(float f)
{
    uint32_t u;
    memcpy(&u, &f, 4);
    return u;
}
static float sb(uint32_t u)
{
    float f;
    memcpy(&f, &u, 4);
    return f;
}

static unsigned flags(void)
{
    unsigned f;
    __asm__ volatile("frflags %0\n\tfsflags x0" : "=r"(f));
    return f;
}
static void set_frm(unsigned rm)
{
    __asm__ volatile("fsrm %0" ::"r"(rm));
}

/* Operands: edge values (zeros, infinities, NaNs of both kinds, subnormals,
 * halves, integer boundaries) and random ones of every magnitude. */
static uint64_t dval(int i)
{
    static const uint64_t edge[] = {
        0, 1ull << 63, 0x7ff0000000000000ull, 0xfff0000000000000ull, 0x7ff8000000000000ull,
        0x7ff4000000000000ull, 0xfff0000000000001ull, 1, 0x800fffffffffffffull, 0x0010000000000000ull,
    };
    static const double nums[] = {
        0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, 4503599627370495.5, 4503599627370496.0,
        -4503599627370497.0, 2147483647.0, 2147483647.75, 2147483648.0, -2147483648.0, -2147483648.75,
        -2147483649.0, 4294967296.0, 4294967301.5, 1e19, -1e19, 1e300, 0x1p63, 0x1p84 + 0x1p32, 0.1, -0.9,
    };
    uint64_t r = next();
    switch (i % 6) {
    case 0: return edge[(i / 6) % (sizeof(edge) / sizeof(edge[0]))];
    case 1: return bd(nums[(i / 6) % (sizeof(nums) / sizeof(nums[0]))]);
    case 2: return bd((double)(int64_t)(r % 100000) / 8.0 - 6000.0);
    case 3: return (r & 0x800fffffffffffffull) | ((uint64_t)(1023 + (int)(next() % 80) - 20) << 52);
    default: return r;
    }
}

/* fround/froundnx: rm must be a constant, so one function per mode */
#define FROUND_D(nm, rm) static double nm(double a) { double r; __asm__ volatile("fround.d %0, %1, " rm : "=f"(r) : "f"(a)); return r; }
#define FROUNDNX_D(nm, rm) static double nm(double a) { double r; __asm__ volatile("froundnx.d %0, %1, " rm : "=f"(r) : "f"(a)); return r; }
#define FROUND_S(nm, rm) static float nm(float a) { float r; __asm__ volatile("fround.s %0, %1, " rm : "=f"(r) : "f"(a)); return r; }
#define FROUNDNX_S(nm, rm) static float nm(float a) { float r; __asm__ volatile("froundnx.s %0, %1, " rm : "=f"(r) : "f"(a)); return r; }
FROUND_D(rd0, "rne") FROUND_D(rd1, "rtz") FROUND_D(rd2, "rdn") FROUND_D(rd3, "rup") FROUND_D(rd4, "rmm") FROUND_D(rd7, "dyn")
FROUNDNX_D(nd0, "rne") FROUNDNX_D(nd1, "rtz") FROUNDNX_D(nd2, "rdn") FROUNDNX_D(nd3, "rup") FROUNDNX_D(nd4, "rmm") FROUNDNX_D(nd7, "dyn")
FROUND_S(rs0, "rne") FROUND_S(rs1, "rtz") FROUND_S(rs2, "rdn") FROUND_S(rs3, "rup") FROUND_S(rs4, "rmm") FROUND_S(rs7, "dyn")
FROUNDNX_S(ns0, "rne") FROUNDNX_S(ns1, "rtz") FROUNDNX_S(ns2, "rdn") FROUNDNX_S(ns3, "rup") FROUNDNX_S(ns4, "rmm") FROUNDNX_S(ns7, "dyn")
static double (*const rnd_d[2][6])(double) = { { rd0, rd1, rd2, rd3, rd4, rd7 }, { nd0, nd1, nd2, nd3, nd4, nd7 } };
static float (*const rnd_s[2][6])(float) = { { rs0, rs1, rs2, rs3, rs4, rs7 }, { ns0, ns1, ns2, ns3, ns4, ns7 } };

#define FLI_D(i) ({ double _r; __asm__ volatile("fli.d %0, " #i : "=f"(_r)); _r; })
#define FLI_S(i) ({ float _r; __asm__ volatile("fli.s %0, " #i : "=f"(_r)); _r; })

static void fli_all(void)
{
    /* the assembler takes the values, not the indexes */
    double d[32] = {
        FLI_D(-1.0), FLI_D(min), FLI_D(1.52587890625e-05), FLI_D(3.0517578125e-05), FLI_D(0.00390625),
        FLI_D(0.0078125), FLI_D(0.0625), FLI_D(0.125), FLI_D(0.25), FLI_D(0.3125), FLI_D(0.375),
        FLI_D(0.4375), FLI_D(0.5), FLI_D(0.625), FLI_D(0.75), FLI_D(0.875), FLI_D(1.0), FLI_D(1.25),
        FLI_D(1.5), FLI_D(1.75), FLI_D(2.0), FLI_D(2.5), FLI_D(3.0), FLI_D(4.0), FLI_D(8.0), FLI_D(16.0),
        FLI_D(128.0), FLI_D(256.0), FLI_D(32768.0), FLI_D(65536.0), FLI_D(inf), FLI_D(nan),
    };
    float s[32] = {
        FLI_S(-1.0), FLI_S(min), FLI_S(1.52587890625e-05), FLI_S(3.0517578125e-05), FLI_S(0.00390625),
        FLI_S(0.0078125), FLI_S(0.0625), FLI_S(0.125), FLI_S(0.25), FLI_S(0.3125), FLI_S(0.375),
        FLI_S(0.4375), FLI_S(0.5), FLI_S(0.625), FLI_S(0.75), FLI_S(0.875), FLI_S(1.0), FLI_S(1.25),
        FLI_S(1.5), FLI_S(1.75), FLI_S(2.0), FLI_S(2.5), FLI_S(3.0), FLI_S(4.0), FLI_S(8.0), FLI_S(16.0),
        FLI_S(128.0), FLI_S(256.0), FLI_S(32768.0), FLI_S(65536.0), FLI_S(inf), FLI_S(nan),
    };
    EQ(bd(d[0]), bd(-1.0));
    EQ(bd(d[1]), 0x0010000000000000ull);
    EQ(bd(d[29]), bd(65536.0));
    EQ(bd(d[30]), 0x7ff0000000000000ull);
    EQ(bd(d[31]), 0x7ff8000000000000ull);
    EQ(bs(s[1]), 0x00800000);
    EQ(bs(s[31]), 0x7fc00000);
    for (int i = 0; i < 32; i++) {
        mix(bd(d[i]));
        mix(bs(s[i]));
        if (i >= 2 && i <= 29)
            EQ(bd(d[i]), bd((double)s[i]));
    }
    EQ(flags(), 0);
}

int main(void)
{
    flags();
    for (int rep = 0; rep < 2000; rep++)
        fli_all();

    /* known values */
    EQ(bd(rd2(-0.5)), bd(-1.0));
    EQ(bd(rd3(-0.5)), 1ull << 63);
    EQ(bd(rd0(2.5)), bd(2.0));
    EQ(bd(rd4(2.5)), bd(3.0));
    flags();
    EQ(bd(nd1(1.5)), bd(1.0));
    EQ(flags(), 1);
    EQ(bd(rd1(1.5)), bd(1.0));
    EQ(flags(), 0);
    {
        int64_t r;
        double a = -2147483649.0;
        __asm__ volatile("fcvtmod.w.d %0, %1, rtz" : "=r"(r) : "f"(a));
        EQ(r, 2147483647);
        EQ(flags(), 0x10);
    }

    /* double precision */
    for (int i = 0; i < 30000; i++) {
        uint64_t ua = dval(i), ub = dval(i * 7 + 3);
        double a = db(ua), b = db(ub), r;
        int64_t x;
        if (i % 13 == 0)
            ub = ua ^ (next() & 3), b = db(ub);
        __asm__ volatile("fminm.d %0, %1, %2" : "=f"(r) : "f"(a), "f"(b));
        mix(bd(r)), mix(flags());
        __asm__ volatile("fmaxm.d %0, %1, %2" : "=f"(r) : "f"(a), "f"(b));
        mix(bd(r)), mix(flags());
        __asm__ volatile("fmin.d %0, %1, %2" : "=f"(r) : "f"(a), "f"(b));
        mix(bd(r)), mix(flags());
        __asm__ volatile("fleq.d %0, %1, %2" : "=r"(x) : "f"(a), "f"(b));
        mix(x), mix(flags());
        __asm__ volatile("fltq.d %0, %1, %2" : "=r"(x) : "f"(a), "f"(b));
        mix(x), mix(flags());
        __asm__ volatile("fcvtmod.w.d %0, %1, rtz" : "=r"(x) : "f"(a));
        mix(x), mix(flags());
        for (int nx = 0; nx < 2; nx++)
            for (int k = 0; k < 5; k++) {
                r = rnd_d[nx][k](a);
                mix(bd(r)), mix(flags());
            }
        for (unsigned frm = 0; frm < 5; frm++) {
            set_frm(frm);
            r = rnd_d[i & 1][5](a);
            mix(bd(r)), mix(flags());
        }
        set_frm(0);
    }

    /* single precision (also unboxed register values: the canonical NaN) */
    for (int i = 0; i < 30000; i++) {
        uint64_t ua = dval(i), ub = dval(i * 5 + 1);
        float a = (float)db(ua), b = (i % 3) ? (float)db(ub) : sb((uint32_t)ub), r;
        int64_t x;
        flags();
        __asm__ volatile("fminm.s %0, %1, %2" : "=f"(r) : "f"(a), "f"(b));
        mix(bs(r)), mix(flags());
        __asm__ volatile("fmaxm.s %0, %1, %2" : "=f"(r) : "f"(a), "f"(b));
        mix(bs(r)), mix(flags());
        __asm__ volatile("fleq.s %0, %1, %2" : "=r"(x) : "f"(a), "f"(b));
        mix(x), mix(flags());
        __asm__ volatile("fltq.s %0, %1, %2" : "=r"(x) : "f"(a), "f"(b));
        mix(x), mix(flags());
        for (int nx = 0; nx < 2; nx++)
            for (int k = 0; k < 5; k++) {
                r = rnd_s[nx][k](a);
                mix(bs(r)), mix(flags());
            }
        for (unsigned frm = 0; frm < 5; frm++) {
            set_frm(frm);
            r = rnd_s[i & 1][5](a);
            mix(bs(r)), mix(flags());
        }
        set_frm(0);
        double u;
        __asm__ volatile("fmv.d.x %0, %1\n\tfround.s %0, %0, rne" : "=&f"(u) : "r"(ua)); /* not NaN-boxed */
        mix(bd(u)), mix(flags());
    }

    /* what the compiler emits with Zfa: libm calls inlined as fround,
     * constants as fli, fmin/fmax(imum) */
    double acc = 0;
    float accs = 0;
    for (int i = 0; i < 300000; i++) {
        double a = db(dval(i % 997 * 3 + 2));
        if (isnan(a) || isinf(a))
            a = i * 0.37;
        acc += floor(a * 0.5) + ceil(a) * 0.25 - trunc(a * 1.5) + round(a) + rint(a * 0.75) + nearbyint(a);
        acc = fmin(acc, 1e12) + fmax(acc * 0.125, -16.0);
        accs += floorf((float)a * 0.5f) + ceilf((float)acc * 1e-9f) + 2.5f;
        if (!(i & 1023))
            mix(bd(acc)), mix(bs(accs));
    }
    mix(bd(acc)), mix(bs(accs)), mix(flags());

    printf("zfatest digest: %016llx\n", (unsigned long long)digest);
    printf("zfatest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
