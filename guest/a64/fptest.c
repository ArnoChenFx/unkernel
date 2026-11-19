// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 scalar floating-point self-test. Two parts:
 *
 *  - known answers for the Arm rules that differ from IEEE defaults or
 *    from RISC-V (NaN propagation, default NaN, flush to zero, tininess
 *    before rounding, AHP, saturating conversions): the exit status is the
 *    number of failures;
 *  - every scalar FP instruction form (inline asm), run over edge and
 *    pseudo-random operands under every FPCR rounding mode with FZ and DN
 *    on and off (and AHP for half conversions), folding the result (both
 *    halves of the V register, to see that scalar writes zero the rest),
 *    NZCV and FPSR into one hash per form. test/a64-test.mjs requires the
 *    same output as qemu-aarch64.
 *
 * `fptest fuzz <seed> <count>` instead prints one line per random case
 * (form, FPCR, operands, results): a differential fuzz to run by hand
 * under qemu-aarch64 and under the harness, then diff the outputs.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef uint64_t u64;
typedef uint32_t u32;

#define G 0x5a5a5a5a5a5a5a5aull /* what V and X registers hold before an op */

static u64 o_lo, o_hi, o_f; /* result low and high 64 bits (or NZCV), FPSR */

/* ---- instruction forms ----------------------------------------------------- */

/* FP result in v0 from v1, v2, v3 (and NZCV for fcsel) */
#define FF(name, insn) static void name(u64 a, u64 b, u64 c, u64 fc, u64 nz) { u64 lo, hi, f; \
    __asm__ volatile("fmov d0, %[g]\n\tfmov v0.d[1], %[g]\n\tfmov d1, %[a]\n\tfmov d2, %[b]\n\tfmov d3, %[c]\n\t" \
        "msr nzcv, %[nz]\n\tmsr fpcr, %[fc]\n\tmsr fpsr, xzr\n\t" insn "\n\tmrs %[f], fpsr\n\tmsr fpcr, xzr\n\t" \
        "fmov %[lo], d0\n\tfmov %[hi], v0.d[1]" \
        : [lo] "=&r"(lo), [hi] "=&r"(hi), [f] "=&r"(f) \
        : [a] "r"(a), [b] "r"(b), [c] "r"(c), [fc] "r"(fc), [nz] "r"(nz), [g] "r"(G) : "v0", "v1", "v2", "v3", "cc"); \
    o_lo = lo; o_hi = hi; o_f = f; }
/* FP v1 to x9/w9 */
#define FI(name, insn) static void name(u64 a, u64 b, u64 c, u64 fc, u64 nz) { u64 lo, f; (void)b; (void)c; (void)nz; \
    __asm__ volatile("mov x9, %[g]\n\tfmov d1, %[a]\n\tmsr fpcr, %[fc]\n\tmsr fpsr, xzr\n\t" insn "\n\t" \
        "mrs %[f], fpsr\n\tmsr fpcr, xzr\n\tmov %[lo], x9" \
        : [lo] "=&r"(lo), [f] "=&r"(f) : [a] "r"(a), [fc] "r"(fc), [g] "r"(G) : "x9", "v1"); \
    o_lo = lo; o_hi = 0; o_f = f; }
/* x9/w9 to FP v0 */
#define IF(name, insn) static void name(u64 a, u64 b, u64 c, u64 fc, u64 nz) { u64 lo, hi, f; (void)b; (void)c; (void)nz; \
    __asm__ volatile("fmov d0, %[g]\n\tfmov v0.d[1], %[g]\n\tmov x9, %[a]\n\tmsr fpcr, %[fc]\n\tmsr fpsr, xzr\n\t" insn "\n\t" \
        "mrs %[f], fpsr\n\tmsr fpcr, xzr\n\tfmov %[lo], d0\n\tfmov %[hi], v0.d[1]" \
        : [lo] "=&r"(lo), [hi] "=&r"(hi), [f] "=&r"(f) : [a] "r"(a), [fc] "r"(fc), [g] "r"(G) : "x9", "v0"); \
    o_lo = lo; o_hi = hi; o_f = f; }
/* compares: NZCV out */
#define CM(name, insn) static void name(u64 a, u64 b, u64 c, u64 fc, u64 nz) { u64 lo, f; (void)c; \
    __asm__ volatile("fmov d1, %[a]\n\tfmov d2, %[b]\n\tmsr nzcv, %[nz]\n\tmsr fpcr, %[fc]\n\tmsr fpsr, xzr\n\t" insn "\n\t" \
        "mrs %[f], fpsr\n\tmrs %[lo], nzcv\n\tmsr fpcr, xzr" \
        : [lo] "=&r"(lo), [f] "=&r"(f) : [a] "r"(a), [b] "r"(b), [fc] "r"(fc), [nz] "r"(nz) : "v1", "v2", "cc"); \
    o_lo = lo; o_hi = 0; o_f = f; }

#define BIN(X) X(fadd) X(fsub) X(fmul) X(fdiv) X(fnmul) X(fmax) X(fmin) X(fmaxnm) X(fminnm)
#define TER(X) X(fmadd) X(fmsub) X(fnmadd) X(fnmsub)
#define UN(X) X(fmov) X(fabs) X(fneg) X(fsqrt) X(frintn) X(frintp) X(frintm) X(frintz) X(frinta) X(frintx) X(frinti)
#define CVI(X) X(fcvtns) X(fcvtnu) X(fcvtps) X(fcvtpu) X(fcvtms) X(fcvtmu) X(fcvtzs) X(fcvtzu) X(fcvtas) X(fcvtau)

#define D_BIN(op) FF(op##_s, #op " s0, s1, s2") FF(op##_d, #op " d0, d1, d2")
#define D_TER(op) FF(op##_s, #op " s0, s1, s2, s3") FF(op##_d, #op " d0, d1, d2, d3")
#define D_UN(op) FF(op##_s, #op " s0, s1") FF(op##_d, #op " d0, d1")
#define D_CVI(op) FI(op##_ws, #op " w9, s1") FI(op##_xs, #op " x9, s1") FI(op##_wd, #op " w9, d1") FI(op##_xd, #op " x9, d1")
BIN(D_BIN)
TER(D_TER)
UN(D_UN)
CVI(D_CVI)

FF(fcvt_ds, "fcvt d0, s1") FF(fcvt_sd, "fcvt s0, d1") FF(fcvt_hs, "fcvt h0, s1") FF(fcvt_hd, "fcvt h0, d1")
FF(fcvt_sh, "fcvt s0, h1") FF(fcvt_dh, "fcvt d0, h1")
FF(fcsel_eq_s, "fcsel s0, s1, s2, eq") FF(fcsel_lt_d, "fcsel d0, d1, d2, lt") FF(fcsel_hi_s, "fcsel s0, s1, s2, hi")
FF(fcsel_vs_d, "fcsel d0, d1, d2, vs") FF(fcsel_nv_s, "fcsel s0, s1, s2, nv")
CM(fcmp_s, "fcmp s1, s2") CM(fcmp_d, "fcmp d1, d2") CM(fcmpe_s, "fcmpe s1, s2") CM(fcmpe_d, "fcmpe d1, d2")
CM(fcmp0_s, "fcmp s1, #0.0") CM(fcmp0_d, "fcmp d1, #0.0") CM(fcmpe0_s, "fcmpe s1, #0.0") CM(fcmpe0_d, "fcmpe d1, #0.0")
CM(fccmp_s, "fccmp s1, s2, #0x6, ge") CM(fccmp_d, "fccmp d1, d2, #0xb, ne")
CM(fccmpe_s, "fccmpe s1, s2, #0x3, cs") CM(fccmpe_d, "fccmpe d1, d2, #0x8, al")
IF(scvtf_sw, "scvtf s0, w9") IF(scvtf_sx, "scvtf s0, x9") IF(scvtf_dw, "scvtf d0, w9") IF(scvtf_dx, "scvtf d0, x9")
IF(ucvtf_sw, "ucvtf s0, w9") IF(ucvtf_sx, "ucvtf s0, x9") IF(ucvtf_dw, "ucvtf d0, w9") IF(ucvtf_dx, "ucvtf d0, x9")
IF(scvtf_sw1, "scvtf s0, w9, #1") IF(scvtf_sw32, "scvtf s0, w9, #32") IF(ucvtf_dw16, "ucvtf d0, w9, #16")
IF(ucvtf_dw31, "ucvtf d0, w9, #31") IF(scvtf_dx1, "scvtf d0, x9, #1") IF(scvtf_dx64, "scvtf d0, x9, #64")
IF(ucvtf_sx33, "ucvtf s0, x9, #33") IF(ucvtf_sx64, "ucvtf s0, x9, #64")
FI(fcvtzs_ws1, "fcvtzs w9, s1, #1") FI(fcvtzs_ws32, "fcvtzs w9, s1, #32") FI(fcvtzu_ws16, "fcvtzu w9, s1, #16")
FI(fcvtzu_wd32, "fcvtzu w9, d1, #32") FI(fcvtzs_wd7, "fcvtzs w9, d1, #7") FI(fcvtzs_xs64, "fcvtzs x9, s1, #64")
FI(fcvtzu_xs40, "fcvtzu x9, s1, #40") FI(fcvtzs_xd1, "fcvtzs x9, d1, #1") FI(fcvtzu_xd64, "fcvtzu x9, d1, #64")
FI(fcvtzs_xd52, "fcvtzs x9, d1, #52")
FI(fmov_ws, "fmov w9, s1") FI(fmov_xd, "fmov x9, d1") IF(fmov_sw, "fmov s0, w9") IF(fmov_dx, "fmov d0, x9")
IF(fmov_vx, "fmov v0.d[1], x9")

/* operand types: s, d, h (FP, raw bits), w, x (integers); AHP marks the
 * half conversions (also run with FPCR.AHP) */
enum { AHP = 1 };
struct form {
    const char *name;
    void (*fn)(u64, u64, u64, u64, u64);
    char ty;
    char nops;
    char flags;
};

#define T_BIN(op) {#op ".s", op##_s, 's', 2, 0}, {#op ".d", op##_d, 'd', 2, 0},
#define T_TER(op) {#op ".s", op##_s, 's', 3, 0}, {#op ".d", op##_d, 'd', 3, 0},
#define T_UN(op) {#op ".s", op##_s, 's', 1, 0}, {#op ".d", op##_d, 'd', 1, 0},
#define T_CVI(op) {#op ".ws", op##_ws, 's', 1, 0}, {#op ".xs", op##_xs, 's', 1, 0}, \
    {#op ".wd", op##_wd, 'd', 1, 0}, {#op ".xd", op##_xd, 'd', 1, 0},
static const struct form forms[] = {
    BIN(T_BIN) TER(T_TER) UN(T_UN) CVI(T_CVI)
    {"fcvt.ds", fcvt_ds, 's', 1, 0}, {"fcvt.sd", fcvt_sd, 'd', 1, 0},
    {"fcvt.hs", fcvt_hs, 's', 1, AHP}, {"fcvt.hd", fcvt_hd, 'd', 1, AHP},
    {"fcvt.sh", fcvt_sh, 'h', 1, AHP}, {"fcvt.dh", fcvt_dh, 'h', 1, AHP},
    {"fcsel.eq.s", fcsel_eq_s, 's', 2, 0}, {"fcsel.lt.d", fcsel_lt_d, 'd', 2, 0},
    {"fcsel.hi.s", fcsel_hi_s, 's', 2, 0}, {"fcsel.vs.d", fcsel_vs_d, 'd', 2, 0},
    {"fcsel.nv.s", fcsel_nv_s, 's', 2, 0},
    {"fcmp.s", fcmp_s, 's', 2, 0}, {"fcmp.d", fcmp_d, 'd', 2, 0},
    {"fcmpe.s", fcmpe_s, 's', 2, 0}, {"fcmpe.d", fcmpe_d, 'd', 2, 0},
    {"fcmp0.s", fcmp0_s, 's', 1, 0}, {"fcmp0.d", fcmp0_d, 'd', 1, 0},
    {"fcmpe0.s", fcmpe0_s, 's', 1, 0}, {"fcmpe0.d", fcmpe0_d, 'd', 1, 0},
    {"fccmp.s", fccmp_s, 's', 2, 0}, {"fccmp.d", fccmp_d, 'd', 2, 0},
    {"fccmpe.s", fccmpe_s, 's', 2, 0}, {"fccmpe.d", fccmpe_d, 'd', 2, 0},
    {"scvtf.sw", scvtf_sw, 'w', 1, 0}, {"scvtf.sx", scvtf_sx, 'x', 1, 0},
    {"scvtf.dw", scvtf_dw, 'w', 1, 0}, {"scvtf.dx", scvtf_dx, 'x', 1, 0},
    {"ucvtf.sw", ucvtf_sw, 'w', 1, 0}, {"ucvtf.sx", ucvtf_sx, 'x', 1, 0},
    {"ucvtf.dw", ucvtf_dw, 'w', 1, 0}, {"ucvtf.dx", ucvtf_dx, 'x', 1, 0},
    {"scvtf.sw1", scvtf_sw1, 'w', 1, 0}, {"scvtf.sw32", scvtf_sw32, 'w', 1, 0},
    {"ucvtf.dw16", ucvtf_dw16, 'w', 1, 0}, {"ucvtf.dw31", ucvtf_dw31, 'w', 1, 0},
    {"scvtf.dx1", scvtf_dx1, 'x', 1, 0}, {"scvtf.dx64", scvtf_dx64, 'x', 1, 0},
    {"ucvtf.sx33", ucvtf_sx33, 'x', 1, 0}, {"ucvtf.sx64", ucvtf_sx64, 'x', 1, 0},
    {"fcvtzs.ws1", fcvtzs_ws1, 's', 1, 0}, {"fcvtzs.ws32", fcvtzs_ws32, 's', 1, 0},
    {"fcvtzu.ws16", fcvtzu_ws16, 's', 1, 0}, {"fcvtzu.wd32", fcvtzu_wd32, 'd', 1, 0},
    {"fcvtzs.wd7", fcvtzs_wd7, 'd', 1, 0}, {"fcvtzs.xs64", fcvtzs_xs64, 's', 1, 0},
    {"fcvtzu.xs40", fcvtzu_xs40, 's', 1, 0}, {"fcvtzs.xd1", fcvtzs_xd1, 'd', 1, 0},
    {"fcvtzu.xd64", fcvtzu_xd64, 'd', 1, 0}, {"fcvtzs.xd52", fcvtzs_xd52, 'd', 1, 0},
    {"fmov.ws", fmov_ws, 's', 1, 0}, {"fmov.xd", fmov_xd, 'd', 1, 0},
    {"fmov.sw", fmov_sw, 'w', 1, 0}, {"fmov.dx", fmov_dx, 'x', 1, 0},
    {"fmov.vx", fmov_vx, 'x', 1, 0},
};
#define NFORMS (sizeof forms / sizeof forms[0])

/* ---- operands --------------------------------------------------------------- */

static u64 rng = 0x9e3779b97f4a7c15;
static u64 next(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}

/* A random FP value of width w (16, 32, 64), biased towards the cases
 * where rounding, flags and NaN rules differ. */
static u64 rnd_fp(int w) {
    int mb = w == 16 ? 10 : w == 32 ? 23 : 52, eb = w - 1 - mb;
    u64 emax = (1ull << eb) - 1, bias = emax >> 1, mmask = (1ull << mb) - 1;
    u64 r = next(), m = next() & mmask, e;
    switch (next() % 8) { /* mantissa patterns */
    case 0: m &= ~((1ull << (mb / 2)) - 1); break;   /* short: exact results, ties */
    case 1: m |= mmask & ~((1ull << (next() % mb)) - 1); break; /* runs of ones */
    case 2: m &= 0xf | (0xfull << (mb - 4)); break;
    case 3: m = next() % 4; break;
    case 4: m = mmask - next() % 4; break;
    }
    switch (r % 20) {
    case 0: e = 0; m = 0; break;                       /* zero */
    case 1: e = emax; m = 0; break;                     /* infinity */
    case 2: e = emax; m |= 1ull << (mb - 1); break;     /* quiet NaN */
    case 3: e = emax; m &= ~(1ull << (mb - 1)); if (!m) m = 1; break; /* signalling NaN */
    case 4: case 5: e = 0; if (!m) m = 1; break;        /* subnormal */
    case 6: e = 1 + next() % 2; break;                  /* smallest normals */
    case 7: e = emax - 1 - next() % 2; break;           /* largest normals */
    case 8: case 9: e = bias - 3 + next() % 7; break;   /* around 1 */
    case 10: e = bias + next() % (mb + 3); break;       /* integers, halves, ties */
    case 11: e = bias + 29 + next() % 7; break;         /* around 2^31, 2^32 */
    case 12: e = bias + 61 + next() % 6; break;         /* around 2^63, 2^64 */
    case 13: case 14: e = bias / 2 - 2 + next() % 5; break; /* products near the smallest normal */
    case 15: e = bias / 2 + mb / 2 - 2 + next() % 5; break;
    default: e = next() % (emax + 1); break;
    }
    if (e > emax) e = emax;
    return ((r >> 40) & 1) << (w - 1) | e << mb | m;
}

static u64 rnd_int(int w) {
    u64 r = next(), v;
    int k = next() % 64;
    switch (r % 8) {
    case 0: v = next() % 8; break;
    case 1: v = (1ull << k) + (next() % 7) - 3; break;  /* around powers of two */
    case 2: v = -((1ull << k) + (next() % 7) - 3); break;
    case 3: v = (next() >> (next() % 64)); break;
    case 4: v = (1ull << k) - 1 - (next() & ~(~0ull << (k / 2))); break; /* ties for the rounding */
    default: v = next(); break;
    }
    return w == 32 ? (u32)v : v;
}

static const u64 edge32[] = {
    0, 0x80000000, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc00001,
    0x7f800001, 0xff812345, 0x7fd23456, 0x00000001, 0x80000001, 0x007fffff, 0x00800000,
    0x80800000, 0x00800001, 0x7f7fffff, 0xff7fffff, 0x3f000000, 0x3fc00000, 0x40200000,
    0xc0200000, 0x4f000000, 0x4f800000, 0x5f000000, 0x5f800000, 0xcf000000, 0xdf000000,
    0x4effffff, 0x3effffff, 0x1f800000, 0x20000000, 0x34000000, 0x4b000000, 0x4b000001,
    0x3f7fffff, 0x3f7ffffe, 0x3f800001, 0x477fe000, 0x477ff000, 0x33800000, 0x387fc000,
    0x38800000, 0x40490fdb,
};
static const u64 edge64[] = {
    0, 0x8000000000000000, 0x3ff0000000000000, 0xbff0000000000000, 0x7ff0000000000000,
    0xfff0000000000000, 0x7ff8000000000000, 0xfff8000000000001, 0x7ff0000000000001,
    0xfff0000123456789, 0x7ffa5a5a5a5a5a5a, 0x0000000000000001, 0x8000000000000001,
    0x000fffffffffffff, 0x0010000000000000, 0x8010000000000000, 0x0010000000000001,
    0x7fefffffffffffff, 0xffefffffffffffff, 0x3fe0000000000000, 0x3ff8000000000000,
    0x4004000000000000, 0xc004000000000000, 0x41e0000000000000, 0x41f0000000000000,
    0x43e0000000000000, 0x43f0000000000000, 0xc1e0000000000000, 0xc3e0000000000000,
    0x41dfffffffffffff, 0x43efffffffffffff, 0x3fefffffffffffff, 0x3ff0000000000001,
    0x2000000000000000, 0x3810000000000000, 0x380fffffffffffff, 0x47efffffe0000000,
    0x47efffffefffffff, 0x47effffff0000000, 0x36a0000000000000, 0x3e70000000000000,
    0x4330000000000001, 0x400921fb54442d18, 0x41dfffffffc00000, 0xc1e0000000200000,
};
static const u64 edge16[] = {
    0, 0x8000, 0x3c00, 0xbc00, 0x7c00, 0xfc00, 0x7e00, 0xfe01, 0x7d00, 0xfd55, 0x7fff,
    0x0001, 0x8001, 0x03ff, 0x0400, 0x7bff, 0xfbff, 0x3555, 0x3800, 0x4248,
};
static const u64 edgeint[] = {
    0, 1, 2, 3, 0x7fffffff, 0x80000000, 0xffffffff, 0x01000001, 0x01000003, 0x00ffffff,
    0x7fffffc0, 0x7fffffbf, 0xffffff7f, 0x7fffffffffffffff, 0x8000000000000000,
    0xffffffffffffffff, 0x0020000000000001, 0x0020000000000003, 0x8000000000000400,
    0x8000000000000401, 0xfffffffffffff800, 0xfffffffffffffc00, 0xffffffff00000001,
};

#define NRAND 12
static u64 v32[64], v64[64], v16[32], vint[48];
static unsigned n32, n64, n16, nint;

static void init_vals(void) {
    for (unsigned i = 0; i < sizeof edge32 / 8; i++) v32[n32++] = edge32[i];
    for (unsigned i = 0; i < NRAND; i++) v32[n32++] = rnd_fp(32);
    for (unsigned i = 0; i < sizeof edge64 / 8; i++) v64[n64++] = edge64[i];
    for (unsigned i = 0; i < NRAND; i++) v64[n64++] = rnd_fp(64);
    for (unsigned i = 0; i < sizeof edge16 / 8; i++) v16[n16++] = edge16[i];
    for (unsigned i = 0; i < 12; i++) v16[n16++] = rnd_fp(16);
    for (unsigned i = 0; i < sizeof edgeint / 8; i++) vint[nint++] = edgeint[i];
    for (unsigned i = 0; i < NRAND; i++) vint[nint++] = rnd_int(64);
}

/* Operand i of type ty, with junk above the operand's width (it must be
 * ignored). */
static u64 operand(char ty, unsigned i, unsigned *n) {
    switch (ty) {
    case 's': *n = n32; return v32[i % n32] | 0xdead000000000000ull;
    case 'd': *n = n64; return v64[i % n64];
    case 'h': *n = n16; return v16[i % n16] | 0xbeef0000ull;
    case 'w': *n = nint; return vint[i % nint] ^ 0xa5a5a5a500000000ull;
    default: *n = nint; return vint[i % nint];
    }
}

/* ---- hashing ---------------------------------------------------------------- */

static u64 hash;
static void mix(u64 v) {
    hash ^= v;
    hash *= 0x100000001b3;
    hash ^= hash >> 29;
}

static const u64 fpcrs[] = { /* RMode x FZ x DN, then with AHP */
    0, 1 << 22, 2 << 22, 3 << 22, 1 << 24, 1 << 24 | 1 << 22, 1 << 24 | 2 << 22, 1 << 24 | 3 << 22,
    1 << 25, 1 << 25 | 1 << 22, 1 << 25 | 2 << 22, 1 << 25 | 3 << 22,
    3 << 24, 3 << 24 | 1 << 22, 3 << 24 | 2 << 22, 3 << 24 | 3 << 22,
    1 << 26, 1 << 26 | 3 << 22, 1 << 26 | 1 << 25, 1 << 26 | 1 << 24 | 2 << 22,
};

static void run_form(const struct form *f) {
    unsigned ncfg = f->flags & AHP ? 20 : 16, n;
    hash = 0xcbf29ce484222325;
    operand(f->ty, 0, &n);
    for (unsigned k = 0; k < ncfg; k++) {
        u64 fc = fpcrs[k];
        for (unsigned i = 0; i < n; i++) {
            u64 a = operand(f->ty, i, &n);
            unsigned jn = f->nops >= 2 ? n : 1, step = f->nops == 3 ? 3 : 1;
            for (unsigned j = (k * 5) % step; j < jn; j += step) {
                u64 b = operand(f->ty, j, &n);
                u64 c = operand(f->ty, i * 7 + j * 3 + k, &n);
                u64 nz = (u64)((i + j * 3 + k) & 15) << 28;
                f->fn(a, b, c, fc, nz);
                mix(o_lo);
                mix(o_hi);
                mix(o_f);
            }
        }
    }
    printf("%-12s %016llx\n", f->name, (unsigned long long)hash);
}

/* FMOV (immediate): every imm8, both sizes */
static void fmov_imm(void) {
    static u32 s[256];
    static u64 d[256];
    __asm__ volatile(".set .Lfi, 0\n\t.rept 256\n\t.inst 0x1e201000 | (.Lfi << 13)\n\t"
                     "str s0, [%[p], #(.Lfi * 4)]\n\t.set .Lfi, .Lfi + 1\n\t.endr"
                     : : [p] "r"(s) : "v0", "memory");
    __asm__ volatile(".set .Lfj, 0\n\t.rept 256\n\t.inst 0x1e601000 | (.Lfj << 13)\n\t"
                     "str d0, [%[p], #(.Lfj * 8)]\n\t.set .Lfj, .Lfj + 1\n\t.endr"
                     : : [p] "r"(d) : "v0", "memory");
    hash = 0xcbf29ce484222325;
    for (int i = 0; i < 256; i++) {
        mix(s[i]);
        mix(d[i]);
    }
    printf("%-12s %016llx\n", "fmov.imm", (unsigned long long)hash);
}

/* ---- known answers ---------------------------------------------------------- */

static int failures;
static void check(const char *what, const struct form *f, u64 a, u64 b, u64 c, u64 fc, u64 want, u64 want_f) {
    f->fn(a, b, c, fc, 0);
    if (o_lo != want || o_f != want_f) {
        printf("FAIL %s: %s(%llx, %llx, %llx) fpcr %llx = %llx fpsr %llx, want %llx fpsr %llx\n", what, f->name,
               (unsigned long long)a, (unsigned long long)b, (unsigned long long)c, (unsigned long long)fc,
               (unsigned long long)o_lo, (unsigned long long)o_f, (unsigned long long)want, (unsigned long long)want_f);
        failures++;
    }
}
static const struct form *find(const char *name) {
    for (unsigned i = 0; i < NFORMS; i++)
        if (!strcmp(forms[i].name, name)) return &forms[i];
    printf("no form %s\n", name);
    exit(100);
}

enum { IOC = 1, DZC = 2, OFC = 4, UFC = 8, IXC = 16, IDC = 128 };
enum { FZ = 1 << 24, DN = 1 << 25, AHPB = 1 << 26, RP = 1 << 22, RM = 2 << 22, RZ = 3 << 22 };

static void known(void) {
    check("1 + 2", find("fadd.s"), 0x3f800000, 0x40000000, 0, 0, 0x40400000, 0);
    check("1/3 inexact", find("fdiv.d"), 0x3ff0000000000000, 0x4008000000000000, 0, RZ, 0x3fd5555555555555, IXC);
    check("sNaN wins, quieted", find("fadd.s"), 0x7fc00001, 0xff800002, 0, 0, 0xffc00002, IOC);
    check("first qNaN", find("fmul.d"), 0x7ff8000000000003, 0xfff8000000000004, 0, 0, 0x7ff8000000000003, 0);
    check("default NaN", find("fsub.s"), 0x7fc01234, 0x3f800000, 0, DN, 0x7fc00000, 0);
    check("fnmul negates NaN", find("fnmul.s"), 0x7fc00000, 0x3f800000, 0, 0, 0xffc00000, 0);
    check("fma qNaN + inf*0", find("fmadd.s"), 0x7f800000, 0, 0x7fc00005, 0, 0x7fc00000, IOC);
    check("fma addend NaN first", find("fmadd.d"), 0x7ff8000000000001, 0x3ff0000000000000, 0x7ff8000000000002, 0,
          0x7ff8000000000002, 0);
    check("tiny before rounding", find("fmul.s"), 0x00800001, 0x3f7ffffe, 0, 0, 0x00800000, UFC | IXC);
    check("not tiny", find("fmul.s"), 0x00800001, 0x3f7fffff, 0, 0, 0x00800000, IXC);
    check("fz flushes the result", find("fmul.s"), 0x00800001, 0x3f7ffffe, 0, FZ, 0, UFC);
    check("fz flushes an input", find("fadd.d"), 0x0000000000000001, 0x3ff0000000000000, 0, FZ, 0x3ff0000000000000, IDC);
    check("exact denormal", find("fmul.s"), 0x00000002, 0x3f000000, 0, 0, 0x00000001, 0);
    check("maxnm qNaN", find("fmaxnm.s"), 0x7fc00000, 0xbf800000, 0, 0, 0xbf800000, 0);
    check("max +0", find("fmax.d"), 0x8000000000000000, 0, 0, 0, 0, 0);
    check("fcvtzs NaN", find("fcvtzs.ws"), 0x7fc00000, 0, 0, 0, 0, IOC);
    check("fcvtzu negative", find("fcvtzu.xd"), 0xbff0000000000000, 0, 0, 0, 0, IOC);
    check("fcvtzs saturates", find("fcvtzs.wd"), 0x41f0000000000000, 0, 0, 0, 0x7fffffff, IOC);
    check("fcvtas tie away", find("fcvtas.ws"), 0xc0200000, 0, 0, 0, 0xfffffffd, IXC);
    check("fcvtns tie even", find("fcvtns.xd"), 0xc004000000000000, 0, 0, 0, 0xfffffffffffffffe, IXC);
    check("frintx", find("frintx.s"), 0x3fc00000, 0, 0, RM, 0x3f800000, IXC);
    check("frinta -0.4", find("frinta.d"), 0xbfd999999999999a, 0, 0, 0, 0x8000000000000000, 0);
    check("ahp in", find("fcvt.sh"), 0x7c00, 0, 0, AHPB, 0x47800000, 0);
    check("ahp nan", find("fcvt.hs"), 0xffc00000, 0, 0, AHPB, 0x8000, IOC);
    check("ahp overflow", find("fcvt.hd"), 0x4100000000000000, 0, 0, AHPB, 0x7fff, IOC);
    check("half nan payload", find("fcvt.hs"), 0x7f802000, 0, 0, 0, 0x7e01, IOC);
    check("scvtf fixed", find("scvtf.sw1"), 0xffffffff, 0, 0, 0, 0xbf000000, 0);
    check("ucvtf rounding", find("ucvtf.sx"), 0xffffffffffffffff, 0, 0, RZ, 0x5f7fffff, IXC);
    check("fcmpe nan", find("fcmpe.d"), 0x7ff8000000000000, 0, 0, 0, 0x30000000, IOC);
    check("fcmp nan quiet", find("fcmp.d"), 0x7ff8000000000000, 0, 0, 0, 0x30000000, 0);
}

/* ---- fuzz ------------------------------------------------------------------- */

static u64 rnd_operand(char ty) {
    switch (ty) {
    case 's': return rnd_fp(32);
    case 'd': return rnd_fp(64);
    case 'h': return rnd_fp(16);
    case 'w': return rnd_int(32);
    default: return rnd_int(64);
    }
}

static void fuzz(u64 seed, unsigned long count) {
    rng = seed ? seed : 1;
    for (unsigned long n = 0; n < count; n++) {
        const struct form *f = &forms[next() % NFORMS];
        u64 fc = (next() % 4) << 22 | (next() % 8) << 24; /* RMode, FZ, DN, AHP */
        u64 a = rnd_operand(f->ty), b = rnd_operand(f->ty), c = rnd_operand(f->ty);
        u64 nz = (next() % 16) << 28;
        if (f->nops >= 2 && (f->ty == 's' || f->ty == 'd') && next() % 4 == 0) {
            /* b such that a*b or a/b lands next to the smallest normal:
             * tininess before rounding, FZ */
            int div = next() & 1;
            if (f->ty == 's') {
                float x, y;
                u32 a32 = a, y32;
                memcpy(&x, &a32, 4);
                y = div ? x / 0x1p-126f : 0x1p-126f / x;
                memcpy(&y32, &y, 4);
                b = (u32)(y32 + (next() % 7) - 3);
            } else {
                double x, y;
                memcpy(&x, &a, 8);
                y = div ? x / 0x1p-1022 : 0x1p-1022 / x;
                memcpy(&b, &y, 8);
                b += (next() % 7) - 3;
            }
        }
        if (f->nops == 3 && next() % 3 == 0) {
            /* addend near -(a*b): cancellation, double rounding traps */
            u64 p;
            if (f->ty == 's') {
                float x, y, z;
                u32 a32 = a, b32 = b, z32;
                memcpy(&x, &a32, 4);
                memcpy(&y, &b32, 4);
                z = x * y;
                memcpy(&z32, &z, 4);
                p = z32 ^ 0x80000000u;
            } else {
                double x, y, z;
                memcpy(&x, &a, 8);
                memcpy(&y, &b, 8);
                z = x * y;
                memcpy(&p, &z, 8);
                p ^= 1ull << 63;
            }
            c = p + (next() % 5) - 2;
            if (f->ty == 's') c &= 0xffffffff;
        }
        f->fn(a, b, c, fc, nz);
        printf("%s %08llx %llx %llx %llx %llx -> %llx %llx %llx\n", f->name, (unsigned long long)fc,
               (unsigned long long)nz >> 28, (unsigned long long)a, (unsigned long long)b,
               (unsigned long long)c, (unsigned long long)o_lo, (unsigned long long)o_hi, (unsigned long long)o_f);
    }
}

int main(int argc, char **argv) {
    if (argc == 4 && !strcmp(argv[1], "fuzz")) {
        fuzz(strtoull(argv[2], 0, 0), strtoul(argv[3], 0, 0));
        return 0;
    }
    init_vals();
    known();
    for (unsigned i = 0; i < NFORMS; i++) run_form(&forms[i]);
    fmov_imm();
    printf("%u forms, %d known-answer failure(s)\n", (unsigned)NFORMS + 1, failures);
    return failures;
}
