// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 AdvSIMD moves, permutes and structure loads/stores (simd_move.zig,
 * simd_ldst.zig). Each form runs (inline asm) over pseudo-random register
 * and memory contents: v0..v7 and v28..v31 are loaded from `vin`, the
 * instruction runs with a base pointer into `mem`, then the registers, the
 * base after writeback, a general register and the memory are folded into
 * one hash per form. test/a64-test.mjs requires the same output as
 * qemu-aarch64. A few known answers are checked here too (exit status 1
 * and a FAIL line if one is wrong).
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef uint64_t u64;
typedef uint8_t u8;

#define ITER 12

static u8 vin[12][16] __attribute__((aligned(16)));
static u8 vout[12][16] __attribute__((aligned(16)));
static u8 mem[512] __attribute__((aligned(16)));
static const u64 xoffs[4] = { 0, 16, (u64)-16, 33 };

static u64 rng = 0x9e3779b97f4a7c15;
static u64 next(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}
static u64 hash = 0xcbf29ce484222325;
static void mix(u64 v) {
    hash ^= v;
    hash *= 0x100000001b3;
    hash ^= hash >> 29;
}
static void report(const char *name) {
    printf("%-22s %016llx\n", name, (unsigned long long)hash);
    hash = 0xcbf29ce484222325;
}
static void setup(void) {
    for (unsigned r = 0; r < 12; r++)
        for (unsigned k = 0; k < 16; k += 8) {
            u64 v = next();
            memcpy(&vin[r][k], &v, 8);
        }
    for (unsigned k = 0; k < sizeof mem; k += 8) {
        u64 v = next();
        memcpy(&mem[k], &v, 8);
    }
}
static void fold(const u8 *p, u64 g) {
    u64 w;
    for (unsigned r = 0; r < 12; r++)
        for (unsigned k = 0; k < 16; k += 8) {
            memcpy(&w, &vout[r][k], 8);
            mix(w);
        }
    for (unsigned k = 0; k < sizeof mem; k += 8) {
        memcpy(&w, &mem[k], 8);
        mix(w);
    }
    mix((u64)(p - mem));
    mix(g);
}

#define LOADV "ldp q0, q1, [%[i]]\n\tldp q2, q3, [%[i], #32]\n\tldp q4, q5, [%[i], #64]\n\tldp q6, q7, [%[i], #96]\n\t" \
    "ldp q28, q29, [%[i], #128]\n\tldp q30, q31, [%[i], #160]\n\t"
#define STOREV "\n\tstp q0, q1, [%[o]]\n\tstp q2, q3, [%[o], #32]\n\tstp q4, q5, [%[o], #64]\n\tstp q6, q7, [%[o], #96]\n\t" \
    "stp q28, q29, [%[o], #128]\n\tstp q30, q31, [%[o], #160]"
#define CLOB "memory", "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v28", "v29", "v30", "v31"

/* One form: %[p] base pointer into mem (+r, written back), %[x] a post-index
 * register (0, 16, -16, 33), %[g] a general register (in and out). */
#define T(name, insn) do { for (unsigned it = 0; it < ITER; it++) { setup(); \
    u8 *p = mem + 160 + (it * 5) % 16; u64 g = next(); u64 x = xoffs[it % 4]; \
    __asm__ volatile(LOADV insn STOREV : [p] "+r"(p), [g] "+r"(g) : [i] "r"(vin), [o] "r"(vout), [x] "r"(x) : CLOB); \
    fold(p, g); } report(name); } while (0)

/* arrangements */
#define ALL7(X, op) X(op, "8b") X(op, "16b") X(op, "4h") X(op, "8h") X(op, "2s") X(op, "4s") X(op, "2d")
#define ALL8(X, op) ALL7(X, op) X(op, "1d")
#define BYTES(X, op) X(op, "8b") X(op, "16b")

/* ---- simd_move ---------------------------------------------------------------- */

#define PERM(op, a) T(op "." a, op " v0." a ", v1." a ", v2." a);
#define LOGIC(op, a) T(op "." a, op " v0." a ", v1." a ", v2." a);

static void permutes(void) {
    ALL7(PERM, "zip1") ALL7(PERM, "zip2") ALL7(PERM, "uzp1") ALL7(PERM, "uzp2")
    ALL7(PERM, "trn1") ALL7(PERM, "trn2")
    T("zip1.same", "zip1 v0.16b, v0.16b, v0.16b");
    T("uzp2.dn", "uzp2 v1.8h, v1.8h, v2.8h");
    T("trn1.dm", "trn1 v2.4s, v1.4s, v2.4s");
    T("ext.8b.0", "ext v0.8b, v1.8b, v2.8b, #0");
    T("ext.8b.3", "ext v0.8b, v1.8b, v2.8b, #3");
    T("ext.8b.7", "ext v0.8b, v1.8b, v2.8b, #7");
    T("ext.16b.0", "ext v0.16b, v1.16b, v2.16b, #0");
    T("ext.16b.1", "ext v0.16b, v1.16b, v2.16b, #1");
    T("ext.16b.8", "ext v0.16b, v1.16b, v2.16b, #8");
    T("ext.16b.15", "ext v0.16b, v1.16b, v2.16b, #15");
    T("ext.16b.same", "ext v1.16b, v1.16b, v1.16b, #9");
}

/* index vector v7: masked to 0..63 (mostly in range) or raw */
#define TBLM(name, insn) T(name ".m", "movi v6.16b, #0x3f\n\tand v7.16b, v7.16b, v6.16b\n\t" insn); \
    T(name ".s", "movi v6.16b, #0x47\n\tand v7.16b, v7.16b, v6.16b\n\t" insn); T(name, insn)
#define TBL(op, a) \
    TBLM(op "1." a, op " v0." a ", {v1.16b}, v7." a); \
    TBLM(op "2." a, op " v0." a ", {v1.16b, v2.16b}, v7." a); \
    TBLM(op "3." a, op " v0." a ", {v1.16b, v2.16b, v3.16b}, v7." a); \
    TBLM(op "4." a, op " v0." a ", {v1.16b, v2.16b, v3.16b, v4.16b}, v7." a);

static void tables(void) {
    BYTES(TBL, "tbl") BYTES(TBL, "tbx")
    TBLM("tbl4.wrap", "tbl v5.16b, {v30.16b, v31.16b, v0.16b, v1.16b}, v7.16b");
    TBLM("tbx3.wrap", "tbx v5.8b, {v31.16b, v0.16b, v1.16b}, v7.8b");
    TBLM("tbx2.dn", "tbx v1.16b, {v1.16b, v2.16b}, v7.16b");
    TBLM("tbl1.dm", "tbl v7.16b, {v1.16b}, v7.16b");
}

static void copies(void) {
    T("dup.8b.e", "dup v0.8b, v1.b[13]");
    T("dup.16b.e", "dup v0.16b, v1.b[2]");
    T("dup.4h.e", "dup v0.4h, v1.h[7]");
    T("dup.8h.e", "dup v0.8h, v1.h[1]");
    T("dup.2s.e", "dup v0.2s, v1.s[3]");
    T("dup.4s.e", "dup v0.4s, v1.s[2]");
    T("dup.2d.e", "dup v0.2d, v1.d[1]");
    T("dup.8b.g", "dup v0.8b, %w[g]");
    T("dup.16b.g", "dup v0.16b, %w[g]");
    T("dup.4h.g", "dup v0.4h, %w[g]");
    T("dup.8h.g", "dup v0.8h, %w[g]");
    T("dup.2s.g", "dup v0.2s, %w[g]");
    T("dup.4s.g", "dup v0.4s, %w[g]");
    T("dup.2d.g", "dup v0.2d, %[g]");
    T("dup.b.scalar", "mov b0, v1.b[15]");
    T("dup.h.scalar", "mov h0, v1.h[5]");
    T("dup.s.scalar", "mov s0, v1.s[3]");
    T("dup.d.scalar", "mov d0, v1.d[1]");
    T("ins.b.g", "mov v0.b[13], %w[g]");
    T("ins.h.g", "mov v0.h[6], %w[g]");
    T("ins.s.g", "mov v0.s[1], %w[g]");
    T("ins.d.g", "mov v0.d[1], %[g]");
    T("ins.b.e", "mov v0.b[3], v1.b[9]");
    T("ins.h.e", "mov v0.h[7], v1.h[0]");
    T("ins.s.e", "mov v0.s[0], v1.s[3]");
    T("ins.d.e", "mov v0.d[1], v1.d[0]");
    T("umov.b", "umov %w[g], v1.b[7]");
    T("umov.h", "umov %w[g], v1.h[6]");
    T("umov.s", "mov %w[g], v1.s[3]");
    T("umov.d", "mov %[g], v1.d[1]");
    T("smov.w.b", "smov %w[g], v1.b[15]");
    T("smov.w.h", "smov %w[g], v1.h[3]");
    T("smov.x.b", "smov %[g], v1.b[4]");
    T("smov.x.h", "smov %[g], v1.h[7]");
    T("smov.x.s", "smov %[g], v1.s[1]");
}

static void immediates(void) {
    T("movi.8b", "movi v0.8b, #0xa5");
    T("movi.16b", "movi v0.16b, #0x5a");
    T("movi.4h", "movi v0.4h, #0x81");
    T("movi.8h.8", "movi v0.8h, #0x7e, lsl #8");
    T("movi.2s", "movi v0.2s, #0x81");
    T("movi.4s.8", "movi v0.4s, #0x81, lsl #8");
    T("movi.2s.16", "movi v0.2s, #0x81, lsl #16");
    T("movi.4s.24", "movi v0.4s, #0xfe, lsl #24");
    T("movi.2s.msl8", "movi v0.2s, #0x81, msl #8");
    T("movi.4s.msl16", "movi v0.4s, #0x42, msl #16");
    T("movi.d", "movi d0, #0xff00ff0000ffff00");
    T("movi.2d", "movi v0.2d, #0x00ffff00ff0000ff");
    T("mvni.4h", "mvni v0.4h, #0x81");
    T("mvni.8h.8", "mvni v0.8h, #0x81, lsl #8");
    T("mvni.2s", "mvni v0.2s, #0x7f");
    T("mvni.4s.8", "mvni v0.4s, #0x7f, lsl #8");
    T("mvni.2s.16", "mvni v0.2s, #0x7f, lsl #16");
    T("mvni.4s.24", "mvni v0.4s, #0x7f, lsl #24");
    T("mvni.2s.msl8", "mvni v0.2s, #0x18, msl #8");
    T("mvni.4s.msl16", "mvni v0.4s, #0x18, msl #16");
    T("orr.4h", "orr v1.4h, #0x81");
    T("orr.8h.8", "orr v1.8h, #0x81, lsl #8");
    T("orr.2s", "orr v1.2s, #0x81");
    T("orr.4s.24", "orr v1.4s, #0x81, lsl #24");
    T("bic.4h", "bic v1.4h, #0x81");
    T("bic.8h.8", "bic v1.8h, #0xff, lsl #8");
    T("bic.2s.8", "bic v1.2s, #0x81, lsl #8");
    T("bic.4s.16", "bic v1.4s, #0x81, lsl #16");
    T("fmov.2s", "fmov v0.2s, #-1.25");
    T("fmov.4s", "fmov v0.4s, #31.0");
    T("fmov.2d", "fmov v0.2d, #0.125");
    T("fmov.2d.neg", "fmov v0.2d, #-15.5");
}

static void logic(void) {
    BYTES(LOGIC, "and") BYTES(LOGIC, "bic") BYTES(LOGIC, "orr") BYTES(LOGIC, "orn")
    BYTES(LOGIC, "eor") BYTES(LOGIC, "bsl") BYTES(LOGIC, "bit") BYTES(LOGIC, "bif")
    T("mov.16b", "mov v0.16b, v1.16b");
    T("mov.8b", "mov v0.8b, v1.8b");
}

/* ---- simd_ldst ---------------------------------------------------------------- */

#define LD1N(op, a) \
    T(op "1x1." a, op "1 {v0." a "}, [%[p]]"); \
    T(op "1x2." a, op "1 {v0." a ", v1." a "}, [%[p]]"); \
    T(op "1x3." a, op "1 {v0." a ", v1." a ", v2." a "}, [%[p]]"); \
    T(op "1x4." a, op "1 {v0." a ", v1." a ", v2." a ", v3." a "}, [%[p]]"); \
    T(op "1x1." a ".pr", op "1 {v1." a "}, [%[p]], %[x]"); \
    T(op "1x4." a ".pr", op "1 {v1." a ", v2." a ", v3." a ", v4." a "}, [%[p]], %[x]");
#define LDN(op, a) \
    T(op "2." a, op "2 {v0." a ", v1." a "}, [%[p]]"); \
    T(op "3." a, op "3 {v0." a ", v1." a ", v2." a "}, [%[p]]"); \
    T(op "4." a, op "4 {v0." a ", v1." a ", v2." a ", v3." a "}, [%[p]]"); \
    T(op "3." a ".pr", op "3 {v2." a ", v3." a ", v4." a "}, [%[p]], %[x]");

static void multiple(void) {
    ALL8(LD1N, "ld") ALL8(LD1N, "st")
    ALL7(LDN, "ld") ALL7(LDN, "st")
    T("ld1x1.16b.pi", "ld1 {v0.16b}, [%[p]], #16");
    T("ld1x2.8b.pi", "ld1 {v0.8b, v1.8b}, [%[p]], #16");
    T("ld1x3.2d.pi", "ld1 {v5.2d, v6.2d, v7.2d}, [%[p]], #48");
    T("ld1x4.4s.pi", "ld1 {v0.4s, v1.4s, v2.4s, v3.4s}, [%[p]], #64");
    T("st1x1.1d.pi", "st1 {v3.1d}, [%[p]], #8");
    T("st1x2.8h.pi", "st1 {v0.8h, v1.8h}, [%[p]], #32");
    T("st1x4.2s.pi", "st1 {v0.2s, v1.2s, v2.2s, v3.2s}, [%[p]], #32");
    T("ld2.8h.pi", "ld2 {v0.8h, v1.8h}, [%[p]], #32");
    T("ld4.8b.pi", "ld4 {v0.8b, v1.8b, v2.8b, v3.8b}, [%[p]], #32");
    T("st2.4s.pi", "st2 {v0.4s, v1.4s}, [%[p]], #32");
    T("st3.16b.pi", "st3 {v0.16b, v1.16b, v2.16b}, [%[p]], #48");
    T("st4.2d.pi", "st4 {v0.2d, v1.2d, v2.2d, v3.2d}, [%[p]], #64");
    T("st4.4h.pr", "st4 {v0.4h, v1.4h, v2.4h, v3.4h}, [%[p]], %[x]");
    T("ld4.wrap", "ld4 {v30.4s, v31.4s, v0.4s, v1.4s}, [%[p]]");
    T("ld1x4.wrap", "ld1 {v31.16b, v0.16b, v1.16b, v2.16b}, [%[p]]");
    T("st3.wrap", "st3 {v31.8b, v0.8b, v1.8b}, [%[p]]");
    T("st1x3.wrap", "st1 {v30.2d, v31.2d, v0.2d}, [%[p]]");
}

#define LANE(op, n, regs, b, h, s, d) \
    T(op n ".b", op n " {" regs(b) "}[13], [%[p]]"); \
    T(op n ".b0", op n " {" regs(b) "}[0], [%[p]]"); \
    T(op n ".h", op n " {" regs(h) "}[5], [%[p]]"); \
    T(op n ".s", op n " {" regs(s) "}[3], [%[p]]"); \
    T(op n ".s1", op n " {" regs(s) "}[1], [%[p]]"); \
    T(op n ".d", op n " {" regs(d) "}[1], [%[p]]"); \
    T(op n ".d0", op n " {" regs(d) "}[0], [%[p]]"); \
    T(op n ".b.pr", op n " {" regs(b) "}[7], [%[p]], %[x]"); \
    T(op n ".s.pr", op n " {" regs(s) "}[2], [%[p]], %[x]");
#define R1(e) "v1." e
#define R2(e) "v1." e ", v2." e
#define R3(e) "v1." e ", v2." e ", v3." e
#define R4(e) "v1." e ", v2." e ", v3." e ", v4." e
#define LANES(op) \
    LANE(op, "1", R1, "b", "h", "s", "d") LANE(op, "2", R2, "b", "h", "s", "d") \
    LANE(op, "3", R3, "b", "h", "s", "d") LANE(op, "4", R4, "b", "h", "s", "d")
#define REP(op, a) \
    T("ld1r." a, "ld1r {v0." a "}, [%[p]]"); \
    T("ld2r." a, "ld2r {v0." a ", v1." a "}, [%[p]]"); \
    T("ld3r." a, "ld3r {v0." a ", v1." a ", v2." a "}, [%[p]]"); \
    T("ld4r." a, "ld4r {v0." a ", v1." a ", v2." a ", v3." a "}, [%[p]]"); \
    T("ld4r." a ".pr", "ld4r {v4." a ", v5." a ", v6." a ", v7." a "}, [%[p]], %[x]");

static void single(void) {
    LANES("ld") LANES("st")
    T("ld1.b.pi", "ld1 {v0.b}[1], [%[p]], #1");
    T("ld2.h.pi", "ld2 {v0.h, v1.h}[3], [%[p]], #4");
    T("ld3.s.pi", "ld3 {v0.s, v1.s, v2.s}[3], [%[p]], #12");
    T("ld4.d.pi", "ld4 {v0.d, v1.d, v2.d, v3.d}[1], [%[p]], #32");
    T("st1.d.pi", "st1 {v0.d}[1], [%[p]], #8");
    T("st2.b.pi", "st2 {v0.b, v1.b}[15], [%[p]], #2");
    T("st3.h.pi", "st3 {v0.h, v1.h, v2.h}[0], [%[p]], #6");
    T("st4.s.pi", "st4 {v0.s, v1.s, v2.s, v3.s}[2], [%[p]], #16");
    T("ld4.lane.wrap", "ld4 {v30.s, v31.s, v0.s, v1.s}[1], [%[p]]");
    T("st2.lane.wrap", "st2 {v31.h, v0.h}[6], [%[p]]");
    ALL8(REP, "")
    T("ld1r.16b.pi", "ld1r {v0.16b}, [%[p]], #1");
    T("ld2r.4h.pi", "ld2r {v0.4h, v1.4h}, [%[p]], #4");
    T("ld3r.4s.pi", "ld3r {v0.4s, v1.4s, v2.4s}, [%[p]], #12");
    T("ld4r.2d.pi", "ld4r {v0.2d, v1.2d, v2.2d, v3.2d}, [%[p]], #32");
    T("ld4r.wrap", "ld4r {v29.8b, v30.8b, v31.8b, v0.8b}, [%[p]]");
}

/* ---- known answers ------------------------------------------------------------ */

static int fails;
static void check(const char *what, const u8 *got, const u8 *want, unsigned n) {
    if (memcmp(got, want, n)) {
        fails++;
        printf("FAIL %s:", what);
        for (unsigned i = 0; i < n; i++) printf(" %02x", got[i]);
        printf("\n");
    }
}

static void known(void) {
    u8 seq[64], out[64], want[64];
    for (unsigned i = 0; i < 64; i++) seq[i] = (u8)i;
    /* ld3 de-interleaves bytes: v0 = 0,3,6.., v1 = 1,4,.., v2 = 2,5,.. */
    __asm__ volatile("ld3 {v0.16b, v1.16b, v2.16b}, [%0]\n\tst1 {v0.16b, v1.16b, v2.16b}, [%1]"
                     :: "r"(seq), "r"(out) : "memory", "v0", "v1", "v2");
    for (unsigned r = 0; r < 3; r++) for (unsigned e = 0; e < 16; e++) want[16 * r + e] = (u8)(3 * e + r);
    check("ld3.16b", out, want, 48);
    /* zip1 .8h of 0..15 and 16..31 */
    __asm__ volatile("ld1 {v0.16b, v1.16b}, [%0]\n\tzip1 v2.8h, v0.8h, v1.8h\n\tst1 {v2.16b}, [%1]"
                     :: "r"(seq), "r"(out) : "memory", "v0", "v1", "v2");
    {
        static const u8 w[16] = { 0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23 };
        check("zip1.8h", out, w, 16);
    }
    /* tbl with indices 31..0 over two registers reverses them; 0xff -> 0 */
    {
        static const u8 idx[16] = { 31, 30, 29, 28, 27, 26, 25, 24, 7, 6, 5, 4, 3, 2, 1, 0 };
        __asm__ volatile("ld1 {v0.16b, v1.16b}, [%0]\n\tld1 {v2.16b}, [%3]\n\t"
                         "tbl v4.16b, {v0.16b, v1.16b}, v2.16b\n\tmovi v5.16b, #0xff\n\ttbl v6.8b, {v0.16b}, v5.8b\n\t"
                         "st1 {v4.16b}, [%1]\n\tst1 {v6.16b}, [%2]"
                         :: "r"(seq), "r"(out), "r"(out + 16), "r"(idx) : "memory", "v0", "v1", "v2", "v4", "v5", "v6");
        memcpy(want, idx, 16);
    }
    memset(want + 16, 0, 16);
    check("tbl", out, want, 32);
    /* ext #3 of 0..15 and 16..31 */
    __asm__ volatile("ld1 {v0.16b, v1.16b}, [%0]\n\text v2.16b, v0.16b, v1.16b, #3\n\tst1 {v2.16b}, [%1]"
                     :: "r"(seq), "r"(out) : "memory", "v0", "v1", "v2");
    for (unsigned i = 0; i < 16; i++) want[i] = (u8)(3 + i);
    check("ext", out, want, 16);
    /* st4 interleaves .4h, ld1r replicates */
    __asm__ volatile("ld1 {v0.16b, v1.16b, v2.16b, v3.16b}, [%0]\n\tst4 {v0.4h, v1.4h, v2.4h, v3.4h}, [%1]"
                     :: "r"(seq), "r"(out) : "memory", "v0", "v1", "v2", "v3");
    for (unsigned e = 0; e < 4; e++) for (unsigned r = 0; r < 4; r++) {
        want[8 * e + 2 * r] = (u8)(16 * r + 2 * e);
        want[8 * e + 2 * r + 1] = (u8)(16 * r + 2 * e + 1);
    }
    check("st4.4h", out, want, 32);
    __asm__ volatile("ld1r {v0.4s}, [%0]\n\tst1 {v0.4s}, [%1]" :: "r"(seq + 4), "r"(out) : "memory", "v0");
    for (unsigned i = 0; i < 16; i++) want[i] = (u8)(4 + i % 4);
    check("ld1r.4s", out, want, 16);
}

int main(void) {
    known();
    permutes();
    tables();
    copies();
    immediates();
    logic();
    multiple();
    single();
    printf("simdmovetest done, %d failure(s)\n", fails);
    return fails != 0;
}
