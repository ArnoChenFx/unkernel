// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 AdvSIMD integer self-test. For every AdvSIMD integer class (three
 * same, three different, two-register misc, across lanes, scalar pairwise,
 * shift by immediate, by element; vector and scalar) it enumerates every
 * value of the non-register fields (Q, U, size, opcode, immh:immb, L, M,
 * H), keeps the ARMv8.0 integer encodings (its own tables from the Arm
 * ARM, so qemu-aarch64 checks them too: a word it rejects is SIGILL), and
 * runs each one, patched into a small trampoline in an RWX page, over
 * register states full of boundary values (saturation both ways, shift
 * counts 0, +-esize and beyond, signed and unsigned extremes). V0..V31 and
 * FPSR (QC) after each run are folded into one hash per class, U and
 * opcode. test/a64-test.mjs requires the same output as qemu-aarch64.
 *
 *   simdtest          hashes per class/U/opcode
 *   simdtest v        one line per word (to find a differing word)
 *   simdtest w HEX..  run the given words, print "<word> <hash>" (the
 *                     differential fuzz, test/a64-simd-fuzz.mjs)
 *   simdtest W HEX..  the same, "<word> ILL" for SIGILL (qemu only: musl's
 *                     sigaction needs exclusives)
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

/* x0 = struct st: q0..q31, then fpsr. Saves d8..d15 (callee-saved). */
__asm__(".text\n.balign 4\n.global tramp_start\ntramp_start:\n"
        "  stp d8, d9, [sp, #-64]!\n  stp d10, d11, [sp, #16]\n"
        "  stp d12, d13, [sp, #32]\n  stp d14, d15, [sp, #48]\n"
        "  ldr x1, [x0, #512]\n  msr fpsr, x1\n"
        "  ldp q0, q1, [x0, #0]\n  ldp q2, q3, [x0, #32]\n  ldp q4, q5, [x0, #64]\n"
        "  ldp q6, q7, [x0, #96]\n  ldp q8, q9, [x0, #128]\n  ldp q10, q11, [x0, #160]\n"
        "  ldp q12, q13, [x0, #192]\n  ldp q14, q15, [x0, #224]\n  ldp q16, q17, [x0, #256]\n"
        "  ldp q18, q19, [x0, #288]\n  ldp q20, q21, [x0, #320]\n  ldp q22, q23, [x0, #352]\n"
        "  ldp q24, q25, [x0, #384]\n  ldp q26, q27, [x0, #416]\n  ldp q28, q29, [x0, #448]\n"
        "  ldp q30, q31, [x0, #480]\n"
        ".global tramp_slot\ntramp_slot:\n  nop\n"
        "  stp q0, q1, [x0, #0]\n  stp q2, q3, [x0, #32]\n  stp q4, q5, [x0, #64]\n"
        "  stp q6, q7, [x0, #96]\n  stp q8, q9, [x0, #128]\n  stp q10, q11, [x0, #160]\n"
        "  stp q12, q13, [x0, #192]\n  stp q14, q15, [x0, #224]\n  stp q16, q17, [x0, #256]\n"
        "  stp q18, q19, [x0, #288]\n  stp q20, q21, [x0, #320]\n  stp q22, q23, [x0, #352]\n"
        "  stp q24, q25, [x0, #384]\n  stp q26, q27, [x0, #416]\n  stp q28, q29, [x0, #448]\n"
        "  stp q30, q31, [x0, #480]\n"
        "  mrs x1, fpsr\n  str x1, [x0, #512]\n"
        "  ldp d10, d11, [sp, #16]\n  ldp d12, d13, [sp, #32]\n  ldp d14, d15, [sp, #48]\n"
        "  ldp d8, d9, [sp], #64\n  ret\n"
        ".global tramp_end\ntramp_end:\n");
extern const char tramp_start[], tramp_slot[], tramp_end[];

struct st {
    u64 v[64];
    u64 fpsr;
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

/* ---- register states --------------------------------------------------------- */

static u64 rng;
static u64 next(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}
static const int64_t small[] = {
    0, 1, 2, 3, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128,
    -1, -2, -7, -8, -9, -15, -16, -17, -31, -32, -33, -63, -64, -65, -127, -128,
};
#define NSMALL (int)(sizeof small / sizeof small[0])
/* a boundary value for an e-bit lane */
static u64 edge(int e, u64 r) {
    u64 mask = e == 64 ? ~0ull : (1ull << e) - 1;
    u64 min = 1ull << (e - 1);
    int k = r % (NSMALL + 10);
    if (k < NSMALL) return (u64)small[k] & mask;
    switch (k - NSMALL) {
    case 0: return min;
    case 1: return min - 1;
    case 2: return min + 1;
    case 3: return min - 2;
    case 4: return 0x5555555555555555ull & mask;
    case 5: return 0xaaaaaaaaaaaaaaaaull & mask;
    case 6: return min >> 1;
    case 7: return (min >> 1) - 1;
    case 8: return mask;
    default: return mask - 1;
    }
}
#define NSTATE 16
static struct st states[NSTATE];
static void make_states(void) {
    rng = 0x2545f4914f6cdd1dull;
    for (int k = 0; k < NSTATE; k++) {
        struct st *s = &states[k];
        int e = 8 << (k & 3);
        for (int r = 0; r < 32; r++) {
            for (int b = 0; b < 128; b += e) {
                u64 x = k >= 12 ? next() : (next() & 3) ? edge(e, next()) : next();
                if (e < 64) x &= (1ull << e) - 1;
                if (e == 64) s->v[2 * r + b / 64] = x;
                else s->v[2 * r + b / 64] |= x << (b % 64);
            }
        }
        s->fpsr = k % 5 == 4 ? 1u << 27 : 0; /* QC already set */
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

/* ---- the ARMv8.0 integer encodings (Arm ARM, C4.1.95..) --------------------- */

/* three same: allowed sizes (bit per size) for vector and scalar */
static int ok_same(int sc, int q, int u, int size, int op) {
    int v = 0, s = 0;
    switch (op) {
    case 0x00: case 0x02: case 0x04: case 0x0c: case 0x0d: case 0x0e: case 0x0f:
    case 0x12: case 0x14: case 0x15: v = 7; break;                /* HADD RHADD HSUB MAX MIN ABD ABA MLA/MLS MAXP MINP */
    case 0x01: case 0x05: case 0x09: case 0x0b: v = 15; s = 15; break; /* QADD QSUB QSHL QRSHL */
    case 0x06: case 0x07: case 0x08: case 0x0a: case 0x10: case 0x11: v = 15; s = 8; break; /* CM* SHL RSHL ADD/SUB */
    case 0x13: v = u ? 1 : 7; break;                              /* PMUL, MUL */
    case 0x16: v = 6; s = 6; break;                               /* SQDMULH, SQRDMULH */
    case 0x17: v = u ? 0 : 15; break;                             /* ADDP */
    default: return 0;
    }
    if (!(((sc ? s : v) >> size) & 1)) return 0;
    return sc || size != 3 || q;
}
static int ok_diff(int sc, int u, int size, int op) {
    if (sc) return !u && (op == 9 || op == 11 || op == 13) && (size == 1 || size == 2);
    switch (op) {
    case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8: case 10: case 12: return size != 3;
    case 9: case 11: case 13: return !u && (size == 1 || size == 2);
    case 14: return !u && size == 0; /* PMULL 8-bit (64-bit: crypto feature, not here) */
    default: return 0;
    }
}
static int ok_misc(int sc, int q, int u, int size, int op) {
    int vec64 = sc ? size == 3 : !(size == 3 && !q); /* the all-sizes ops at D */
    if (sc) {
        switch (op) {
        case 0x03: case 0x07: return 1;              /* SUQADD USQADD SQABS SQNEG */
        case 0x08: case 0x09: case 0x0b: return size == 3;
        case 0x0a: return !u && size == 3;
        case 0x12: return u && size != 3;            /* SQXTUN */
        case 0x14: return size != 3;                 /* SQXTN UQXTN */
        default: return 0;
        }
    }
    switch (op) {
    case 0x00: return u ? size <= 1 : size <= 2;     /* REV32, REV64 */
    case 0x01: return !u && size == 0;               /* REV16 */
    case 0x02: case 0x04: case 0x06: return size != 3; /* ADDLP CLS/CLZ ADALP */
    case 0x03: case 0x07: case 0x08: case 0x09: case 0x0b: return vec64;
    case 0x0a: return !u && vec64;                   /* CMLT */
    case 0x05: return u ? size <= 1 : size == 0;     /* NOT RBIT; CNT */
    case 0x12: case 0x14: return size != 3;          /* XTN SQXTUN SQXTN UQXTN */
    case 0x13: return u && size != 3;                /* SHLL */
    case 0x1c: return size == 2;                     /* URECPE URSQRTE */
    default: return 0;
    }
}
static int ok_across(int q, int u, int size, int op) {
    if (!(op == 0x03 || op == 0x0a || op == 0x1a || (op == 0x1b && !u))) return 0;
    return size != 3 && !(size == 2 && !q);
}
static int ok_shift(int sc, int q, int u, int immh, int op) {
    int size = immh >= 8 ? 3 : immh >= 4 ? 2 : immh >= 2 ? 1 : 0;
    int same = sc ? size == 3 : !(size == 3 && !q);
    if (!immh) return 0;
    switch (op) {
    case 0x00: case 0x02: case 0x04: case 0x06: case 0x0a: return same; /* SHR SRA RSHR RSRA SHL/SLI */
    case 0x08: return u && same;                                       /* SRI */
    case 0x0c: return u && (sc || same);                               /* SQSHLU */
    case 0x0e: return sc || same;                                      /* SQSHL UQSHL */
    case 0x10: case 0x11: return (u || !sc) && size != 3;              /* [R]SHRN SQ[R]SHRUN */
    case 0x12: case 0x13: return size != 3;                            /* [SU]Q[R]SHRN */
    case 0x14: return !sc && size != 3;                                /* [SU]SHLL */
    default: return 0;
    }
}
static int ok_elem(int sc, int u, int size, int op) {
    if (size != 1 && size != 2) return 0;
    switch (op) {
    case 0x0: case 0x4: return !sc && u;            /* MLA MLS */
    case 0x8: return !sc && !u;                     /* MUL */
    case 0x2: case 0x6: case 0xa: return !sc;       /* [SU]MLAL [SU]MLSL [SU]MULL */
    case 0x3: case 0x7: case 0xb: case 0xc: case 0xd: return !u; /* SQDML[AS]L SQDMULL SQ[R]DMULH */
    default: return 0;
    }
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
        for (int op = 0; op < 32; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "s3same" : "3same", u, op);
                for (int size = 0; size < 4; size++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!ok_same(sc, q, u, size, op)) continue;
                        word((sc ? 0x5e200400u : 0x0e200400u) | q << 30 | u << 29 | size << 22 | RM << 16 | op << 11 | RN << 5 | RD, NSTATE);
                    }
            }
    /* three different: 0 Q U 01110 size 1 Rm opcode 00 Rn Rd */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0; op < 16; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "s3diff" : "3diff", u, op);
                for (int size = 0; size < 4; size++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!ok_diff(sc, u, size, op)) continue;
                        word((sc ? 0x5e200000u : 0x0e200000u) | q << 30 | u << 29 | size << 22 | RM << 16 | op << 12 | RN << 5 | RD, NSTATE);
                    }
            }
    /* two-register misc: 0 Q U 01110 size 10000 opcode 10 Rn Rd */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0; op < 32; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "s2misc" : "2misc", u, op);
                for (int size = 0; size < 4; size++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!ok_misc(sc, q, u, size, op)) continue;
                        word((sc ? 0x5e200800u : 0x0e200800u) | q << 30 | u << 29 | size << 22 | op << 12 | RN << 5 | RD, NSTATE);
                    }
            }
    /* across lanes: 0 Q U 01110 size 11000 opcode 10 Rn Rd; scalar pairwise ADDP */
    for (int op = 0; op < 32; op++)
        for (int u = 0; u < 2; u++) {
            group("across", u, op);
            for (int size = 0; size < 4; size++)
                for (int q = 0; q < 2; q++)
                    if (ok_across(q, u, size, op)) word(0x0e300800u | q << 30 | u << 29 | size << 22 | op << 12 | RN << 5 | RD, NSTATE);
        }
    group("spair", 0, 0x1b);
    word(0x5ef1b800u | RN << 5 | RD, NSTATE); /* addp d0, v1.2d */
    /* shift by immediate: 0 Q U 011110 immh immb opcode 1 Rn Rd */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0; op < 32; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "sshift" : "shift", u, op);
                for (int hb = 8; hb < 128; hb++)
                    for (int q = 0; q < 2; q++) {
                        if (sc && !q) continue;
                        if (!ok_shift(sc, q, u, hb >> 3, op)) continue;
                        word((sc ? 0x5f000400u : 0x0f000400u) | q << 30 | u << 29 | hb << 16 | op << 11 | RN << 5 | RD, 8);
                    }
            }
    /* by element: 0 Q U 01111 size L M Rm opcode H 0 Rn Rd (Rm<3:0> = 2, M free) */
    for (int sc = 0; sc < 2; sc++)
        for (int op = 0; op < 16; op++)
            for (int u = 0; u < 2; u++) {
                group(sc ? "selem" : "elem", u, op);
                for (int size = 0; size < 4; size++)
                    for (int hlm = 0; hlm < 8; hlm++)
                        for (int q = 0; q < 2; q++) {
                            if (sc && !q) continue;
                            if (!ok_elem(sc, u, size, op)) continue;
                            u32 h = hlm >> 2, l = (hlm >> 1) & 1, m = hlm & 1;
                            word((sc ? 0x5f000000u : 0x0f000000u) | q << 30 | u << 29 | size << 22 | l << 21 | m << 20 | RM << 16 | op << 12 | h << 11 | RN << 5 | RD, NSTATE);
                        }
            }
    flush();
}

/* ---- words mode (differential fuzz) --------------------------------------------- */

static sigjmp_buf jb;
static void on_ill(int sig) {
    (void)sig;
    siglongjmp(jb, 1);
}

int main(int argc, char **argv) {
    setup();
    make_states();
    if (argc > 1 && (argv[1][0] == 'w' || argv[1][0] == 'W')) {
        int catch = argv[1][0] == 'W';
        if (catch) {
            struct sigaction sa;
            memset(&sa, 0, sizeof sa);
            sa.sa_handler = on_ill;
            sigaction(SIGILL, &sa, 0);
        }
        for (int i = 2; i < argc; i++) {
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
    cur.h = 0xcbf29ce484222325ull;
    enumerate();
    printf("words %d\n", total);
    return 0;
}
