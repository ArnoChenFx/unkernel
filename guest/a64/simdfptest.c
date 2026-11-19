// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 AdvSIMD floating-point self-test. For every AdvSIMD class with FP
 * instructions (three same, two-register misc, across lanes, scalar
 * pairwise, shift by immediate, by element; vector and scalar) it
 * enumerates every value of the non-register fields (Q, U, size, opcode,
 * immh:immb, L, M, H), keeps the ARMv8.0 single and double precision
 * encodings (its own tables from the Arm ARM; FCVTN/FCVTL also convert
 * halves), and runs each one, patched into a small trampoline in an RWX
 * page, over register states full of FP edge values (NaNs of both kinds,
 * infinities, zeros, denormals, the edges of the normal and integer
 * ranges, operand pairs whose product is tiny or cancels in FMLA, FRECPS
 * and FRSQRTS) under every FPCR rounding mode with FZ, DN and AHP. V0..V31
 * and FPSR after each run are folded into one hash per class, U and
 * opcode. A few known answers come first (exit status = failures).
 * test/a64-test.mjs requires the same output as qemu-aarch64.
 *
 *   simdfptest              known answers, then hashes per class/U/opcode
 *   simdfptest v            one line per word (to find a differing word)
 *   simdfptest w SEED HEX.. run the given words over register states made
 *                           from SEED, print "<word> <hash>" (the
 *                           differential fuzz, test/a64-simd-fuzz.mjs --fp)
 *   simdfptest W SEED HEX.. the same, "<word> ILL" for SIGILL (qemu only:
 *                           musl's sigaction needs exclusives)
 *   simdfptest d SEED HEX   dump every state's FPCR, V0, V1, V2, V18 before
 *                           and V0, FPSR after (to find a differing lane)
 */
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

typedef uint64_t u64;
typedef uint32_t u32;

/* x0 = struct st: q0..q31, fpsr, fpcr. Saves d8..d15 (callee-saved), leaves
 * FPCR = 0 for the C code. */
__asm__(".text\n.balign 4\n.global tramp_start\ntramp_start:\n"
        "  stp d8, d9, [sp, #-64]!\n  stp d10, d11, [sp, #16]\n"
        "  stp d12, d13, [sp, #32]\n  stp d14, d15, [sp, #48]\n"
        "  ldp q0, q1, [x0, #0]\n  ldp q2, q3, [x0, #32]\n  ldp q4, q5, [x0, #64]\n"
        "  ldp q6, q7, [x0, #96]\n  ldp q8, q9, [x0, #128]\n  ldp q10, q11, [x0, #160]\n"
        "  ldp q12, q13, [x0, #192]\n  ldp q14, q15, [x0, #224]\n  ldp q16, q17, [x0, #256]\n"
        "  ldp q18, q19, [x0, #288]\n  ldp q20, q21, [x0, #320]\n  ldp q22, q23, [x0, #352]\n"
        "  ldp q24, q25, [x0, #384]\n  ldp q26, q27, [x0, #416]\n  ldp q28, q29, [x0, #448]\n"
        "  ldp q30, q31, [x0, #480]\n"
        "  ldr x1, [x0, #512]\n  ldr x2, [x0, #520]\n  msr fpsr, x1\n  msr fpcr, x2\n"
        ".global tramp_slot\ntramp_slot:\n  nop\n"
        "  mrs x1, fpsr\n  msr fpcr, xzr\n  str x1, [x0, #512]\n"
        "  stp q0, q1, [x0, #0]\n  stp q2, q3, [x0, #32]\n  stp q4, q5, [x0, #64]\n"
        "  stp q6, q7, [x0, #96]\n  stp q8, q9, [x0, #128]\n  stp q10, q11, [x0, #160]\n"
        "  stp q12, q13, [x0, #192]\n  stp q14, q15, [x0, #224]\n  stp q16, q17, [x0, #256]\n"
        "  stp q18, q19, [x0, #288]\n  stp q20, q21, [x0, #320]\n  stp q22, q23, [x0, #352]\n"
        "  stp q24, q25, [x0, #384]\n  stp q26, q27, [x0, #416]\n  stp q28, q29, [x0, #448]\n"
        "  stp q30, q31, [x0, #480]\n"
        "  ldp d10, d11, [sp, #16]\n  ldp d12, d13, [sp, #32]\n  ldp d14, d15, [sp, #48]\n"
        "  ldp d8, d9, [sp], #64\n  ret\n"
        ".global tramp_end\ntramp_end:\n");
extern const char tramp_start[], tramp_slot[], tramp_end[];

struct st {
    u64 v[64];
    u64 fpsr, fpcr;
} __attribute__((aligned(16)));

static char *code;
static u32 *slot;

static void setup(void) {
    code = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (code == MAP_FAILED) {
        puts("mmap failed");
        exit(1);
    }
    memcpy(code, tramp_start, tramp_end - tramp_start);
    slot = (u32 *)(code + (tramp_slot - tramp_start));
}
static void patch(u32 w) {
    *slot = w;
    __builtin___clear_cache((char *)slot, (char *)(slot + 1));
}
static void run(struct st *s) { ((void (*)(struct st *))code)(s); }

/* ---- operands ------------------------------------------------------------------ */

static u64 rng;
static u64 next(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}

/* A random FP value of width w (16, 32, 64), biased towards the cases
 * where rounding, flags and NaN rules differ (as in fptest.c). */
static u64 rnd_fp(int w) {
    int mb = w == 16 ? 10 : w == 32 ? 23 : 52, eb = w - 1 - mb;
    u64 emax = (1ull << eb) - 1, bias = emax >> 1, mmask = (1ull << mb) - 1;
    u64 r = next(), m = next() & mmask, e;
    switch (next() % 8) {
    case 0: m &= ~((1ull << (mb / 2)) - 1); break;
    case 1: m |= mmask & ~((1ull << (next() % mb)) - 1); break;
    case 2: m &= 0xf | (0xfull << (mb - 4)); break;
    case 3: m = next() % 4; break;
    case 4: m = mmask - next() % 4; break;
    }
    switch (r % 20) {
    case 0: e = 0; m = 0; break;
    case 1: e = emax; m = 0; break;
    case 2: e = emax; m |= 1ull << (mb - 1); break;
    case 3: e = emax; m &= ~(1ull << (mb - 1)); if (!m) m = 1; break;
    case 4: case 5: e = 0; if (!m) m = 1; break;
    case 6: e = 1 + next() % 2; break;
    case 7: e = emax - 1 - next() % 2; break;
    case 8: case 9: e = bias - 3 + next() % 7; break;
    case 10: e = bias + next() % (mb + 3); break;
    case 11: e = bias + 29 + next() % 7; break;
    case 12: e = bias + 61 + next() % 6; break;
    case 13: case 14: e = bias / 2 - 2 + next() % 5; break;
    case 15: e = 2 * bias - 3 + next() % 5; break; /* FRECPE/FRSQRTE edges */
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
    case 1: v = (1ull << k) + (next() % 7) - 3; break;
    case 2: v = -((1ull << k) + (next() % 7) - 3); break;
    case 3: v = (next() >> (next() % 64)); break;
    case 4: v = (1ull << k) - 1 - (next() & ~(~0ull << (k / 2))); break;
    default: v = next(); break;
    }
    return w == 32 ? (u32)v : v;
}

static const u32 edge32[] = {
    0, 0x80000000, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc00001,
    0x7f800001, 0xff812345, 0x7fd23456, 0x00000001, 0x80000001, 0x007fffff, 0x00800000,
    0x80800000, 0x00800001, 0x7f7fffff, 0xff7fffff, 0x3f000000, 0x3fc00000, 0x40000000,
    0x40400000, 0xc0200000, 0x4f000000, 0x4f800000, 0xcf000000, 0x3effffff, 0x4b000001,
    0x3f7fffff, 0x3f800001, 0x00200000, 0x001fffff, 0x00400000, 0x7e800000, 0x7effffff,
    0x7e7fffff, 0x3e800000, 0x40490fdb, 0x5f800000, 0xdf800000,
};
static const u64 edge64[] = {
    0, 0x8000000000000000, 0x3ff0000000000000, 0xbff0000000000000, 0x7ff0000000000000,
    0xfff0000000000000, 0x7ff8000000000000, 0xfff8000000000001, 0x7ff0000000000001,
    0xfff0000123456789, 0x7ffa5a5a5a5a5a5a, 0x0000000000000001, 0x8000000000000001,
    0x000fffffffffffff, 0x0010000000000000, 0x8010000000000000, 0x0010000000000001,
    0x7fefffffffffffff, 0xffefffffffffffff, 0x3fe0000000000000, 0x3ff8000000000000,
    0x4000000000000000, 0x4008000000000000, 0xc004000000000000, 0x41e0000000000000,
    0x43e0000000000000, 0xc3e0000000000000, 0x3fefffffffffffff, 0x3ff0000000000001,
    0x0004000000000000, 0x0003ffffffffffff, 0x0008000000000000, 0x7fd0000000000000,
    0x7fdfffffffffffff, 0x380fffffffffffff, 0x36a0000000000000, 0x3810000000000000,
    0x47efffffe0000000, 0x47effffff0000000, 0x400921fb54442d18, 0x5ff0000000000000,
};
static const u32 edge16[] = {
    0, 0x8000, 0x3c00, 0xbc00, 0x7c00, 0xfc00, 0x7e00, 0xfe01, 0x7d00, 0xfd55, 0x7fff,
    0x0001, 0x8001, 0x03ff, 0x0400, 0x7bff, 0xfbff, 0x3555, 0x3800, 0x4248,
};
#define N32 (sizeof edge32 / sizeof edge32[0])
#define N64 (sizeof edge64 / sizeof edge64[0])
#define N16 (sizeof edge16 / sizeof edge16[0])

static float f32(u32 x) { float f; memcpy(&f, &x, 4); return f; }
static u32 b32(float f) { u32 x; memcpy(&x, &f, 4); return x; }
static double f64(u64 x) { double f; memcpy(&f, &x, 8); return f; }
static u64 b64(double f) { u64 x; memcpy(&x, &f, 8); return x; }

/* Lane i (of width w) of register r in state s. */
static u64 get(struct st *s, int r, int w, int i) {
    int b = i * w;
    u64 x = s->v[2 * r + b / 64] >> (b % 64);
    return w == 64 ? x : x & ((1ull << w) - 1);
}
static void put(struct st *s, int r, int w, int i, u64 x) {
    int b = i * w;
    u64 mask = w == 64 ? ~0ull : ((1ull << w) - 1) << (b % 64);
    if (w < 64) x &= (1ull << w) - 1;
    s->v[2 * r + b / 64] = (s->v[2 * r + b / 64] & ~mask) | x << (b % 64);
}

/* Operand relations between lanes of V1 (n), V2 (m) and V0 (d): products
 * and quotients next to the smallest normal (tininess, FZ), n*m next to 2
 * (FRECPS) and 3 (FRSQRTS), d next to -(n*m) and n*m (FMLA, FMLS
 * cancellation). */
static void relate(struct st *s, int w) {
    int nl = 128 / w;
    for (int i = 0; i < nl; i++) {
        int kind = next() % 8;
        if (kind >= 5) continue;
        int jit = (int)(next() % 7) - 3;
        if (w == 32) {
            float n = f32(get(s, 1, 32, i)), m = f32(get(s, 2, 32, i));
            switch (kind) {
            case 0: put(s, 2, 32, i, b32(next() & 1 ? n / 0x1p-126f : 0x1p-126f / n) + jit); break;
            case 1: put(s, 2, 32, i, b32(2.0f / n) + jit); break;
            case 2: put(s, 2, 32, i, b32(3.0f / n) + jit); break;
            case 3: put(s, 0, 32, i, (b32(n * m) ^ 0x80000000u) + jit); break;
            case 4: put(s, 0, 32, i, b32(n * m) + jit); break;
            }
        } else {
            double n = f64(get(s, 1, 64, i)), m = f64(get(s, 2, 64, i));
            switch (kind) {
            case 0: put(s, 2, 64, i, b64(next() & 1 ? n / 0x1p-1022 : 0x1p-1022 / n) + jit); break;
            case 1: put(s, 2, 64, i, b64(2.0 / n) + jit); break;
            case 2: put(s, 2, 64, i, b64(3.0 / n) + jit); break;
            case 3: put(s, 0, 64, i, (b64(n * m) ^ (1ull << 63)) + jit); break;
            case 4: put(s, 0, 64, i, b64(n * m) + jit); break;
            }
        }
    }
}

#define NSTATE 48
static struct st states[NSTATE];

/* State k: lane kind k % 6 (single, double, single, double, half,
 * integer), FPCR RMode/FZ/DN from k % 16 and AHP for k % 3 == 0, FPSR
 * preset (IXC, QC) for k % 7 == 6. */
static void make_states(u64 seed) {
    rng = seed ? seed : 1;
    for (int k = 0; k < NSTATE; k++) {
        struct st *s = &states[k];
        int kind = k % 6, w = kind == 4 ? 16 : kind == 5 ? 64 : kind & 1 ? 64 : 32;
        for (int r = 0; r < 32; r++)
            for (int i = 0; i < 128 / w; i++) {
                u64 x;
                if (kind == 5) x = next() & 1 ? rnd_int(64) : rnd_int(32) | rnd_int(32) << 32;
                else if (next() % 3 == 0) x = w == 16 ? edge16[next() % N16] : w == 32 ? edge32[next() % N32] : edge64[next() % N64];
                else x = rnd_fp(w);
                put(s, r, w, i, x);
            }
        if (kind < 4) relate(s, w);
        int f = k % 16;
        s->fpcr = (u64)(f & 3) << 22 | (u64)(f >> 2 & 1) << 24 | (u64)(f >> 3 & 1) << 25 | (u64)(k % 3 == 0) << 26;
        s->fpsr = k % 7 == 6 ? (1u << 27 | 1u << 4) : 0;
    }
}

static u64 mix(u64 h, u64 v) { return (h ^ v) * 0x100000001b3ull; }

/* run word w over the first n states, hash all of V and FPSR */
static u64 test_word(u32 w, int n) {
    struct st s;
    u64 h = 0xcbf29ce484222325ull;
    patch(w);
    for (int k = 0; k < n; k++) {
        s = states[k];
        run(&s);
        for (int i = 0; i < 64; i++) h = mix(h, s.v[i]);
        h = mix(h, s.fpsr);
    }
    return h;
}

/* ---- the ARMv8.0 FP encodings (Arm ARM, AdvSIMD classes) ------------------------ */

/* three same, opcode 11000..11111: bit 0 vector, bit 1 scalar, by U, a
 * (size<1>), opcode<2:0> */
static const unsigned char same_fp[2][2][8] = {
    /* U=0 a=0: FMAXNM FMLA FADD FMULX FCMEQ (FMLAL) FMAX FRECPS */
    {{1, 1, 1, 3, 3, 0, 1, 3},
     /* U=0 a=1: FMINNM FMLS FSUB - - (FMLSL) FMIN FRSQRTS */
     {1, 1, 1, 0, 0, 0, 1, 3}},
    /* U=1 a=0: FMAXNMP (FMLAL2) FADDP FMUL FCMGE FACGE FMAXP FDIV */
    {{1, 0, 1, 1, 3, 3, 1, 1},
     /* U=1 a=1: FMINNMP (FMLSL2) FABD - FCMGT FACGT FMINP - */
     {1, 0, 3, 0, 3, 3, 1, 0}},
};
static int ok_same(int sc, int q, int u, int size, int op) {
    if (op < 0x18) return 0;
    int f = same_fp[u][size >> 1][op & 7];
    if (sc) return (f & 2) != 0;
    return (f & 1) && !((size & 1) && !q);
}

/* two-register misc, same-size ops: bit 0 vector, bit 1 scalar, by U, a,
 * opcode (0x0c..0x0f -> 0..3, 0x18..0x1f -> 4..11) */
static const unsigned char misc_fp[2][2][12] = {
    /* U=0 a=0: - - - - FRINTN FRINTM FCVTNS FCVTMS FCVTAS SCVTF (FRINT32Z FRINT64Z) */
    {{0, 0, 0, 0, 1, 1, 3, 3, 3, 3, 0, 0},
     /* U=0 a=1: FCMGT0 FCMEQ0 FCMLT0 FABS FRINTP FRINTZ FCVTPS FCVTZS (URECPE) FRECPE - FRECPX */
     {3, 3, 3, 1, 1, 1, 3, 3, 0, 3, 0, 2}},
    /* U=1 a=0: - - - - FRINTA FRINTX FCVTNU FCVTMU FCVTAU UCVTF (FRINT32X FRINT64X) */
    {{0, 0, 0, 0, 1, 1, 3, 3, 3, 3, 0, 0},
     /* U=1 a=1: FCMGE0 FCMLE0 - FNEG - FRINTI FCVTPU FCVTZU (URSQRTE) FRSQRTE - FSQRT */
     {3, 3, 0, 1, 0, 1, 3, 3, 0, 3, 0, 1}},
};
static int ok_misc(int sc, int q, int u, int size, int op) {
    int a = size >> 1, sz = size & 1;
    if (op == 0x16) return !a && (u ? sz : !sc);          /* FCVTN(2) FCVTXN(2), scalar FCVTXN */
    if (op == 0x17) return !a && !u && !sc;               /* FCVTL(2) */
    int i = op >= 0x0c && op <= 0x0f ? op - 0x0c : op >= 0x18 ? op - 0x18 + 4 : -1;
    if (i < 0) return 0;
    int f = misc_fp[u][a][i];
    if (sc) return (f & 2) != 0;
    return (f & 1) && !(sz && !q);
}

/* ---- enumeration --------------------------------------------------------------- */

static int verbose;
static int total;

struct group {
    const char *cls;
    int u, op, n;
    u64 h;
};
static struct group cur;
static void flush(void) {
    if (cur.n) printf("%-7s U%d op%02x n=%-4d %016llx\n", cur.cls, cur.u, cur.op, cur.n, (unsigned long long)cur.h);
    cur.n = 0;
    cur.h = 0xcbf29ce484222325ull;
}
static void group(const char *cls, int u, int op) {
    flush();
    cur.cls = cls;
    cur.u = u;
    cur.op = op;
}
static void word(u32 w, int nstates) {
    u64 h = test_word(w, nstates);
    if (verbose) printf("%08x %016llx\n", w, (unsigned long long)h);
    cur.h = mix(cur.h, h);
    cur.n++;
    total++;
}

#define RD 0
#define RN 1
#define RM 2

static void enumerate(void) {
    /* three same: 0 Q U 01110 size 1 Rm opcode 1 Rn Rd; scalar 01 U 11110 ... */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0x18; op < 0x20; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "s3same" : "3same", u, op);
                for (int size = 0; size < 4; size++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!ok_same(sc, q, u, size, op)) continue;
                        word((sc ? 0x5e200400u : 0x0e200400u) | q << 30 | u << 29 | size << 22 | RM << 16 | op << 11 | RN << 5 | RD, NSTATE);
                    }
            }
    /* two-register misc: 0 Q U 01110 size 10000 opcode 10 Rn Rd */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0x0c; op < 0x20; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "s2misc" : "2misc", u, op);
                for (int size = 0; size < 4; size++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!ok_misc(sc, q, u, size, op)) continue;
                        word((sc ? 0x5e200800u : 0x0e200800u) | q << 30 | u << 29 | size << 22 | op << 12 | RN << 5 | RD, NSTATE);
                    }
            }
    /* across lanes (4S only): 0 1 1 01110 a 0 11000 opcode 10 Rn Rd */
    group("across", 1, 0x0c);
    word(0x6e30c800u | RN << 5 | RD, NSTATE); /* fmaxnmv */
    word(0x6eb0c800u | RN << 5 | RD, NSTATE); /* fminnmv */
    group("across", 1, 0x0f);
    word(0x6e30f800u | RN << 5 | RD, NSTATE); /* fmaxv */
    word(0x6eb0f800u | RN << 5 | RD, NSTATE); /* fminv */
    /* scalar pairwise: 01 1 11110 a sz 11000 opcode 10 Rn Rd */
    for (int op = 0x0c; op < 0x10; op++) {
        if (op == 0x0e) continue;
        group("spair", 1, op);
        for (int size = 0; size < 4; size++)
            if (!(op == 0x0d && size >= 2)) word(0x7e300800u | size << 22 | op << 12 | RN << 5 | RD, NSTATE);
    }
    /* shift by immediate: 0 Q U 011110 immh immb opcode 1 Rn Rd (immh 01xx, 1xxx) */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0x1c; op < 0x20; op += 3)
            for (int u = 0; u < 2; u++) {
                group(sc ? "sshift" : "shift", u, op);
                for (int hb = 32; hb < 128; hb++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!sc && hb >= 64 && !q) continue;
                        word((sc ? 0x5f000400u : 0x0f000400u) | q << 30 | u << 29 | hb << 16 | op << 11 | RN << 5 | RD, 16);
                    }
            }
    /* by element: 0 Q U 01111 1 sz L M Rm opcode H 0 Rn Rd (Rm<3:0> = 2: V2 or V18) */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 1; op <= 9; op += 4)
            for (int u = 0; u < 2; u++) {
                if (u && op != 9) continue;
                group(sc ? "selem" : "elem", u, op);
                for (int sz = 0; sz < 2; sz++)
                    for (int hlm = 0; hlm < 8; hlm++)
                        for (int q = 0; q < 2; q++) {
                            if (sc && !q) continue;
                            u32 h = hlm >> 2, l = (hlm >> 1) & 1, m = hlm & 1;
                            if (sz && (l || (!sc && !q))) continue;
                            word((sc ? 0x5f800000u : 0x0f800000u) | q << 30 | u << 29 | sz << 22 | l << 21 | m << 20 | RM << 16 | op << 12 | h << 11 | RN << 5 | RD, NSTATE);
                        }
            }
    flush();
}

/* ---- known answers ------------------------------------------------------------- */

static int failures;
/* run w with V1 = n, V2 = m, V0 = d (the rest zero) and FPCR fc; compare V0
 * and FPSR */
static void check(const char *what, u32 w, u64 n_lo, u64 n_hi, u64 m_lo, u64 d_lo, u64 fc, u64 want_lo, u64 want_hi, u64 want_f) {
    struct st s;
    memset(&s, 0, sizeof s);
    s.v[2] = n_lo;
    s.v[3] = n_hi;
    s.v[4] = m_lo;
    s.v[0] = d_lo;
    s.fpcr = fc;
    patch(w);
    run(&s);
    if (s.v[0] != want_lo || s.v[1] != want_hi || s.fpsr != want_f) {
        printf("FAIL %s: %08x = %016llx:%016llx fpsr %llx, want %016llx:%016llx fpsr %llx\n", what, w,
               (unsigned long long)s.v[1], (unsigned long long)s.v[0], (unsigned long long)s.fpsr,
               (unsigned long long)want_hi, (unsigned long long)want_lo, (unsigned long long)want_f);
        failures++;
    }
}

enum { IOC = 1, DZC = 2, OFC = 4, UFC = 8, IXC = 16, IDC = 128 };
enum { FZ = 1 << 24, DN = 1 << 25, RM_ = 2 << 22, RZ = 3 << 22 };

static void known(void) {
    /* frecpe s0, s1: 1.0 -> 255/256; frsqrte; 0 -> inf, DZC */
    check("frecpe 1.0", 0x5ea1d820, 0x3f800000, 0, 0, 0, 0, 0x3f7f8000, 0, 0);
    check("frsqrte 1.0", 0x7ea1d820, 0x3f800000, 0, 0, 0, 0, 0x3f7f8000, 0, 0);
    check("frecpe 0", 0x5ea1d820, 0x80000000, 0, 0, 0, 0, 0xff800000, 0, DZC);
    check("frsqrte -1", 0x7ea1d820, 0xbf800000, 0, 0, 0, 0, 0x7fc00000, 0, IOC);
    check("frecpe tiny", 0x5ea1d820, 0x00100000, 0, 0, 0, RZ, 0x7f7fffff, 0, OFC | IXC);
    check("frecpe fz huge", 0x5ea1d820, 0x7f000000, 0, 0, 0, FZ, 0, 0, UFC);
    /* frecpx d0, d1 */
    check("frecpx denormal", 0x5ee1f820, 1, 0, 0, 0, 0, 0x7fe0000000000000, 0, 0);
    /* frecps s0, s1, s2: inf * 0 = 2; 2 - 1*2 = +0, -0 when rounding down */
    check("frecps inf*0", 0x5e22fc20, 0x7f800000, 0, 0x80000000, 0, 0, 0x40000000, 0, 0);
    check("frecps exact 0", 0x5e22fc20, 0x3f800000, 0, 0x40000000, 0, RM_, 0x80000000, 0, 0);
    /* frsqrts s0, s1, s2: (3 - 2^64 * -2^64) / 2 = 2^127 (no overflow) */
    check("frsqrts big", 0x5ea2fc20, 0x5f800000, 0, 0xdf800000, 0, 0, 0x7f000000, 0, IXC);
    /* fmulx d0, d1, d2: inf * -0 = -2 */
    check("fmulx inf*0", 0x5e62dc20, 0x7ff0000000000000, 0, 0x8000000000000000, 0, 0, 0xc000000000000000, 0, 0);
    /* fcvtxn s0, d1: round to odd */
    check("fcvtxn odd", 0x7e616820, 0x3ff0000000000001, 0, 0, 0, 0, 0x3f800001, 0, IXC);
    /* fcvtn2 v0.4s, v1.2d keeps the low half */
    check("fcvtn2", 0x4e616820, 0x3ff0000000000000, 0xc000000000000000, 0, 0x1234, 0, 0x1234, 0xc00000003f800000, 0);
    /* fcvtl v0.4s, v1.4h: sNaN (quieted, payload kept), 2^-24, -1, inf */
    check("fcvtl", 0x0e217820, 0x7c00bc000001fc01ull, 0, 0, 0, 0, 0x33800000ffc02000ull, 0x7f800000bf800000ull, IOC);
    /* fmaxnmv s0, v1.4s: maxnm(maxnm(sNaN, 1), maxnm(2, 3)) = maxnm(qNaN, 3) = 3 */
    check("fmaxnmv order", 0x6e30c820, 0x3f8000007f800001, 0x4040000040000000, 0, 0, 0, 0x40400000, 0, IOC);
    /* faddp v0.4s, v1.4s, v2.4s */
    check("faddp", 0x6e22d420, 0x400000003f800000, 0x4080000040400000, 0x3f800000, 0, 0, 0x40e0000040400000, 0x3f800000, 0);
    /* fmla v0.2d, v1.2d, v2.d[0]: one rounding (1 + 2^-52)^2 - 1 - 2^-51 = 2^-104 */
    check("fmla fused", 0x4fc21020, 0x3ff0000000000001, 0, 0x3ff0000000000001, 0xbff0000000000002, 0, 0x3970000000000000, 0, 0);
    /* fcmge v0.4s, v1.4s, #0.0 with a quiet NaN: false, IOC (signalling compare) */
    check("fcmge0 nan", 0x6ea0c820, 0x7fc0000000000000, 0, 0, 0, 0, 0xffffffff, ~0ull, IOC);
    /* fcmeq v0.2s, v1.2s, #0.0 with FZ: denormal == 0, IDC */
    check("fcmeq0 fz", 0x0ea0d820, 0x0000000100000000, 0, 0, 0, FZ, 0xffffffffffffffff, 0, IDC);
    /* scvtf v0.4s, v1.4s, #1; fcvtzu v0.2d, v1.2d, #64 */
    check("scvtf fixed", 0x4f3fe420, 0xffffffff00000003, 0, 0, 0, 0, 0xbf0000003fc00000, 0, 0);
    check("fcvtzu fixed", 0x6f40fc20, 0x3fe0000000000000, 0, 0, 0, 0, 0x8000000000000000, 0, 0);
}

/* ---- words mode (differential fuzz) --------------------------------------------- */

static sigjmp_buf jb;
static void on_ill(int sig) {
    (void)sig;
    siglongjmp(jb, 1);
}

static void dump(u32 w) {
    patch(w);
    for (int k = 0; k < NSTATE; k++) {
        struct st s = states[k];
        printf("%2d fpcr %08llx fpsr %08llx d %016llx:%016llx n %016llx:%016llx m %016llx:%016llx m18 %016llx:%016llx",
               k, (unsigned long long)s.fpcr, (unsigned long long)s.fpsr, (unsigned long long)s.v[1],
               (unsigned long long)s.v[0], (unsigned long long)s.v[3], (unsigned long long)s.v[2],
               (unsigned long long)s.v[5], (unsigned long long)s.v[4], (unsigned long long)s.v[37],
               (unsigned long long)s.v[36]);
        run(&s);
        printf(" -> %016llx:%016llx fpsr %08llx\n", (unsigned long long)s.v[1], (unsigned long long)s.v[0],
               (unsigned long long)s.fpsr);
    }
}

int main(int argc, char **argv) {
    setup();
    if (argc > 3 && (argv[1][0] == 'w' || argv[1][0] == 'W' || argv[1][0] == 'd')) {
        make_states(strtoull(argv[2], 0, 0));
        if (argv[1][0] == 'd') {
            dump(strtoul(argv[3], 0, 16));
            return 0;
        }
        int catch = argv[1][0] == 'W';
        if (catch) {
            struct sigaction sa;
            memset(&sa, 0, sizeof sa);
            sa.sa_handler = on_ill;
            sigaction(SIGILL, &sa, 0);
        }
        for (int i = 3; i < argc; i++) {
            u32 w = strtoul(argv[i], 0, 16);
            if (catch && sigsetjmp(jb, 1)) {
                printf("%08x ILL\n", w);
                continue;
            }
            u64 h = test_word(w, NSTATE);
            printf("%08x %016llx\n", w, (unsigned long long)h);
        }
        return 0;
    }
    verbose = argc > 1 && argv[1][0] == 'v';
    known();
    make_states(0x2545f4914f6cdd1dull);
    cur.h = 0xcbf29ce484222325ull;
    enumerate();
    printf("words %d, %d known-answer failure(s)\n", total, failures);
    return failures;
}
