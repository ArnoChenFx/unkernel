// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * LSE atomics (FEAT_LSE): every encoding of LDADD, LDCLR, LDEOR, LDSET,
 * LDSMAX, LDSMIN, LDUMAX, LDUMIN and SWP (4 sizes x A/R variants), CAS (4
 * sizes x L/o0) and CASP (W and X pairs x L/o0), over edge values of the
 * memory operand and the register operand, plus register aliasing (Rs ==
 * Rt, Rt = XZR (ST<op>), Rs = XZR, Rn = SP, Rn == Rs, Rn == Rt, overlapping
 * CASP pairs). Each instruction word is written into an executable page
 * between a few fixed words and run there (DC CVAU + IC IVAU by
 * __builtin___clear_cache), on registers x0..x7 loaded from and stored back
 * to an array; one hash per form over the registers and the 48 bytes
 * around the access, compared with qemu-aarch64 by test/a64-test.mjs. A few
 * known answers set the exit status (1 if one fails).
 *
 * It executes the instructions without looking at HWCAP. Every access is
 * naturally aligned (qemu's default cpu has FEAT_LSE2, which accepts
 * unaligned atomics inside 16 bytes; kwemu raises an alignment fault).
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

typedef uint64_t u64;
typedef uint32_t u32;
typedef uint8_t u8;

static int fails;
#define CHECK(name, cond) do { int _ok = !!(cond); if (!_ok) { printf("FAIL %s\n", name); fails++; } } while (0)

static u64 hash;
static void mix(u64 v) {
    hash ^= v;
    hash *= 0x100000001b3ULL;
    hash ^= hash >> 29;
}

/*
 * The code page: x15 = sp; sp = x7; <word>; sp = x15; ret. x7 points to the
 * SP-based operand (16-byte aligned), x6 to the X-register-based one.
 */
static u32 *page;
static u64 regs[8];
static u8 mem[96] __attribute__((aligned(64)));

static void put_word(u32 w) {
    page[0] = 0x910003ef; /* add x15, sp, #0 */
    page[1] = 0x910000ff; /* add sp, x7, #0 */
    page[2] = w;
    page[3] = 0x910001ff; /* add sp, x15, #0 */
    page[4] = 0xd65f03c0; /* ret */
    __builtin___clear_cache((char *)page, (char *)(page + 5));
}

static void call_page(void) {
    __asm__ volatile(
        "mov x16, %1\n\t"
        "mov x17, %0\n\t"
        "ldp x0, x1, [x17]\n\t"
        "ldp x2, x3, [x17, #16]\n\t"
        "ldp x4, x5, [x17, #32]\n\t"
        "ldp x6, x7, [x17, #48]\n\t"
        "str x17, [sp, #-16]!\n\t"
        "blr x16\n\t"
        "ldr x17, [sp], #16\n\t"
        "stp x0, x1, [x17]\n\t"
        "stp x2, x3, [x17, #16]\n\t"
        "stp x4, x5, [x17, #32]\n\t"
        "stp x6, x7, [x17, #48]"
        :
        : "r"(regs), "r"(page)
        : "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x15", "x16", "x17", "x30", "memory", "cc");
}

static void mix_state(void) {
    for (int i = 0; i < 8; i++)
        if (i != 6 && i != 7)
            mix(regs[i]);
        else
            mix(regs[i] - (u64)(uintptr_t)mem); /* addresses differ between runs */
    u64 m;
    for (int i = 0; i < 96; i += 8) {
        memcpy(&m, mem + i, 8);
        mix(m);
    }
}

static const u64 edges[] = {
    0,
    1,
    0x7f,
    0x80,
    0xff,
    0x7fff,
    0x8000,
    0xffff,
    0x7fffffff,
    0x80000000,
    0xffffffff,
    0x7fffffffffffffffULL,
    0x8000000000000000ULL,
    0xffffffffffffffffULL,
    0x0123456789abcdefULL,
    0xfedcba9876543210ULL,
    0x8000000080008080ULL,
};
#define NEDGE (int)(sizeof(edges) / sizeof(edges[0]))

/* The memory around the access: a pattern, then `old` at `off`. */
static void set_mem(int off, int bytes, u64 old, u64 old2) {
    for (int i = 0; i < 96; i++)
        mem[i] = (u8)(0xa5 ^ (i * 29));
    memcpy(mem + off, &old, bytes > 8 ? 8 : bytes);
    if (bytes == 16)
        memcpy(mem + off + 8, &old2, 8);
}

static void set_regs(u64 seed) {
    for (int i = 0; i < 8; i++)
        regs[i] = 0x1111111111111111ULL * (u64)(i + 1) ^ seed;
}

static const char *opname[] = { "ldadd", "ldclr", "ldeor", "ldset", "ldsmax", "ldsmin", "ldumax", "ldumin", "swp" };
static const char *ar_suffix[] = { "", "l", "a", "al" };
static const char *sz_suffix[] = { "b", "h", "", "x" };

/* LD<op>/SWP: size 111 0 00 A R 1 Rs o3 opc 00 Rn Rt */
static u32 ldop(int size, int ar, int op, int rs, int rn, int rt) {
    u32 o3opc = op == 8 ? 8 : (u32)op;
    return (u32)size << 30 | 0x38200000u | (u32)ar << 22 | (u32)rs << 16 | o3opc << 12 | (u32)rn << 5 | (u32)rt;
}
/* CAS: size 001000 1 L 1 Rs o0 11111 Rn Rt */
static u32 casw(int size, int l, int o0, int rs, int rn, int rt) {
    return (u32)size << 30 | 0x08a07c00u | (u32)l << 22 | (u32)rs << 16 | (u32)o0 << 15 | (u32)rn << 5 | (u32)rt;
}
/* CASP: 0 sz 001000 0 L 1 Rs o0 11111 Rn Rt */
static u32 caspw(int x, int l, int o0, int rs, int rn, int rt) {
    return (u32)x << 30 | 0x08207c00u | (u32)l << 22 | (u32)rs << 16 | (u32)o0 << 15 | (u32)rn << 5 | (u32)rt;
}

/*
 * One LD<op>/SWP word over all edge pairs (memory operand, register
 * operand). Rs = 1, Rt = 2, Rn = 6 by default; `rs`, `rn`, `rt` change them.
 */
static void run_ldop(const char *name, int size, u32 w, int rs, int rn) {
    int off = rn == 31 ? 0 : 16 + (1 << size);
    hash = 0xcbf29ce484222325ULL;
    for (int i = 0; i < NEDGE; i++)
        for (int j = 0; j < NEDGE; j++) {
            set_mem(rn == 31 ? 48 : off, 1 << size, edges[i], 0);
            set_regs(edges[j] * 3);
            regs[6] = (u64)(uintptr_t)(mem + off);
            regs[7] = (u64)(uintptr_t)(mem + 48);
            if (rs < 6)
                regs[rs] = edges[j];
            put_word(w);
            call_page();
            mix_state();
        }
    printf("%-14s %08x %016llx\n", name, w, (unsigned long long)hash);
}

static void run_cas(const char *name, int size, u32 w, int rn) {
    int off = rn == 31 ? 48 : 16 + (1 << size);
    u64 mask = size == 3 ? ~0ULL : (1ULL << (8 << size)) - 1;
    hash = 0xcbf29ce484222325ULL;
    for (int i = 0; i < NEDGE; i++)
        for (int j = 0; j < NEDGE; j++)
            for (int eq = 0; eq < 2; eq++) {
                set_mem(off, 1 << size, edges[i], 0);
                set_regs(edges[j] * 5);
                /* compare value: equal in the low bits, high bits anything */
                regs[1] = eq ? (edges[i] & mask) | (edges[j] & ~mask) : edges[j];
                regs[2] = edges[NEDGE - 1 - j];
                regs[6] = (u64)(uintptr_t)(mem + off);
                regs[7] = (u64)(uintptr_t)(mem + 48);
                put_word(w);
                call_page();
                mix_state();
            }
    printf("%-14s %08x %016llx\n", name, w, (unsigned long long)hash);
}

/* CASP with Rs = s, Rt = t (even), Rn = 6 or SP (31). */
static void run_casp(const char *name, int x, u32 w, int s, int rn) {
    int bytes = x ? 16 : 8, off = rn == 31 ? 48 : 32;
    u64 mask = x ? ~0ULL : 0xffffffffULL;
    hash = 0xcbf29ce484222325ULL;
    for (int i = 0; i < NEDGE; i++)
        for (int j = 0; j < NEDGE; j += 2)
            for (int eq = 0; eq < 4; eq++) {
                u64 a = edges[i], b = edges[(i + j) % NEDGE];
                u64 lo = x ? a : (a & mask) | (b << 32), hi = x ? b : 0;
                set_mem(off, bytes, lo, hi);
                set_regs(edges[j] * 7);
                /* eq: 0 none, 1 both halves, 2 first only, 3 second only */
                regs[s] = eq == 1 || eq == 2 ? (a & mask) | (edges[j] & ~mask) : edges[j];
                regs[s + 1] = eq == 1 || eq == 3 ? (b & mask) | (edges[i] & ~mask) : edges[i] ^ 1;
                regs[6] = (u64)(uintptr_t)(mem + off);
                regs[7] = (u64)(uintptr_t)(mem + 48);
                put_word(w);
                call_page();
                mix_state();
            }
    printf("%-14s %08x %016llx\n", name, w, (unsigned long long)hash);
}

/* ---- known answers (exit status) ---------------------------------------------- */

static void known_answers(void) {
    char name[32];
    (void)name;
    /* ldadd x1, x2, [x6]: 40 + 2 */
    set_mem(16, 8, 40, 0);
    set_regs(0);
    regs[1] = 2;
    regs[6] = (u64)(uintptr_t)(mem + 16);
    put_word(ldop(3, 0, 0, 1, 6, 2));
    call_page();
    u64 v;
    memcpy(&v, mem + 16, 8);
    CHECK("ldadd 40 + 2", regs[2] == 40 && v == 42);
    /* ldsmaxb: -1 (0xff) against 1: 1 wins; Wt zero-extended 0xff */
    set_mem(16, 1, 0xff, 0);
    regs[1] = 1;
    put_word(ldop(0, 0, 4, 1, 6, 2));
    call_page();
    CHECK("ldsmaxb -1, 1", regs[2] == 0xff && mem[16] == 1);
    /* ldumaxb: 0xff against 1: 0xff stays */
    set_mem(16, 1, 0xff, 0);
    put_word(ldop(0, 0, 6, 1, 6, 2));
    call_page();
    CHECK("ldumaxb 0xff, 1", regs[2] == 0xff && mem[16] == 0xff);
    /* casal w1, w2, [x6] passes; x1 = old, zero-extended */
    set_mem(16, 4, 0x80000000, 0);
    regs[1] = 0xffffffff80000000ULL;
    regs[2] = 7;
    put_word(casw(2, 1, 1, 1, 6, 2));
    call_page();
    memcpy(&v, mem + 16, 8);
    CHECK("casal passes on the low word", regs[1] == 0x80000000 && (u32)v == 7);
    /* casp x2, x3, x4, x5, [x6]: fails on the high half */
    set_mem(32, 16, 5, 6);
    regs[2] = 5;
    regs[3] = 7;
    regs[4] = 8;
    regs[5] = 9;
    regs[6] = (u64)(uintptr_t)(mem + 32);
    put_word(caspw(1, 0, 0, 2, 6, 4));
    call_page();
    memcpy(&v, mem + 32, 8);
    CHECK("casp fails on the high half", regs[2] == 5 && regs[3] == 6 && v == 5);
    /* swp: returns the old value, stores the new one */
    set_mem(32, 16, 5, 6);
    regs[1] = 77;
    put_word(ldop(3, 3, 8, 1, 6, 2));
    call_page();
    memcpy(&v, mem + 32, 8);
    CHECK("swpal", regs[2] == 5 && v == 77);
}

int main(void) {
    char name[32];
    page = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (page == MAP_FAILED) {
        printf("mmap rwx failed\n");
        return 1;
    }
    known_answers();

    /* every LD<op>/SWP encoding: Rs = 1, Rt = 2, Rn = 6 */
    for (int op = 0; op < 9; op++)
        for (int size = 0; size < 4; size++)
            for (int ar = 0; ar < 4; ar++) {
                snprintf(name, sizeof(name), "%s%s%s", opname[op], ar_suffix[ar], sz_suffix[size]);
                run_ldop(name, size, ldop(size, ar, op, 1, 6, 2), 1, 6);
            }
    /* aliasing, per operation, X and B */
    for (int op = 0; op < 9; op++)
        for (int size = 0; size < 4; size += 3) {
            snprintf(name, sizeof(name), "%s%s rs=rt", opname[op], sz_suffix[size]);
            run_ldop(name, size, ldop(size, 0, op, 1, 6, 1), 1, 6);
            snprintf(name, sizeof(name), "%s%s rt=zr", opname[op], sz_suffix[size]);
            run_ldop(name, size, ldop(size, 1, op, 1, 6, 31), 1, 6);
            snprintf(name, sizeof(name), "%s%s rs=zr", opname[op], sz_suffix[size]);
            run_ldop(name, size, ldop(size, 2, op, 31, 6, 2), 31, 6);
            snprintf(name, sizeof(name), "%s%s rn=sp", opname[op], sz_suffix[size]);
            run_ldop(name, size, ldop(size, 3, op, 1, 31, 2), 1, 31);
            snprintf(name, sizeof(name), "%s%s rs=rn", opname[op], sz_suffix[size]);
            run_ldop(name, size, ldop(size, 0, op, 6, 6, 2), 6, 6);
            snprintf(name, sizeof(name), "%s%s rt=rn", opname[op], sz_suffix[size]);
            run_ldop(name, size, ldop(size, 0, op, 1, 6, 6), 1, 6);
        }
    /* every CAS encoding, then aliasing */
    for (int size = 0; size < 4; size++)
        for (int k = 0; k < 4; k++) {
            snprintf(name, sizeof(name), "cas%s%s%s", (k & 1) ? "a" : "", (k & 2) ? "l" : "", sz_suffix[size]);
            run_cas(name, size, casw(size, k & 1, k >> 1, 1, 6, 2), 6);
        }
    for (int size = 0; size < 4; size += 3) {
        snprintf(name, sizeof(name), "cas%s rs=rt", sz_suffix[size]);
        run_cas(name, size, casw(size, 0, 0, 1, 6, 1), 6);
        snprintf(name, sizeof(name), "cas%s rt=zr", sz_suffix[size]);
        run_cas(name, size, casw(size, 1, 1, 1, 6, 31), 6);
        snprintf(name, sizeof(name), "cas%s rn=sp", sz_suffix[size]);
        run_cas(name, size, casw(size, 0, 1, 1, 31, 2), 31);
        snprintf(name, sizeof(name), "cas%s rt=rn", sz_suffix[size]);
        run_cas(name, size, casw(size, 0, 0, 1, 6, 6), 6);
    }
    /* every CASP encoding (Rs = 0, Rt = 2), then overlapping pairs and SP */
    for (int x = 0; x < 2; x++) {
        for (int k = 0; k < 4; k++) {
            snprintf(name, sizeof(name), "casp%s%s%s", (k & 1) ? "a" : "", (k & 2) ? "l" : "", x ? "" : " w");
            run_casp(name, x, caspw(x, k & 1, k >> 1, 0, 6, 2), 0, 6);
        }
        snprintf(name, sizeof(name), "casp%s rs=rt", x ? "" : " w");
        run_casp(name, x, caspw(x, 0, 0, 2, 6, 2), 2, 6);
        snprintf(name, sizeof(name), "casp%s rn=sp", x ? "" : " w");
        run_casp(name, x, caspw(x, 1, 0, 4, 31, 0), 4, 31);
        snprintf(name, sizeof(name), "casp%s rt=rn", x ? "" : " w");
        run_casp(name, x, caspw(x, 0, 1, 0, 6, 6), 0, 6);
    }
    printf("lsetest: %d failure(s)\n", fails);
    return fails != 0;
}
