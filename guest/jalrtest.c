// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Indirect jumps whose targets change while they are hot, for the JIT's
 * jalr dispatch into region members: returns to many call sites (a leaf
 * called from several functions, recursion), indirect calls through a table
 * with a changing index and through a "GOT" slot that is rebound, a jump
 * table (switch), functions on separate pages. Then code in an mmap'ed page
 * that is called hot and rewritten in place, through W^X mprotect, after
 * munmap + mmap at the same address, and with a store from its own caller.
 * Checks against direct calls, prints a digest (what qemu-riscv64-static
 * prints) and exits 0 iff all checks pass.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

static int checks, failures;
#define EQ(a, b)                                                                              \
    do {                                                                                      \
        checks++;                                                                             \
        unsigned long long _a = (unsigned long long)(a), _b = (unsigned long long)(b);        \
        if (_a != _b) {                                                                       \
            failures++;                                                                       \
            printf("FAIL line %d: %s = 0x%llx, want 0x%llx\n", __LINE__, #a, _a, _b);         \
        }                                                                                     \
    } while (0)

static uint64_t digest = 0xcbf29ce484222325ull;
static void mix(uint64_t v) {
    for (int i = 0; i < 8; i++) {
        digest ^= (v >> (8 * i)) & 0xff;
        digest *= 0x100000001b3ull;
    }
}

/* Each on its own page: calls and returns cross pages. */
#define PAGE __attribute__((noinline, aligned(4096)))
typedef uint64_t (*fn)(uint64_t);
PAGE static uint64_t leaf(uint64_t x) { return x * 0x9e3779b97f4a7c15ull + 1; }
PAGE static uint64_t fa(uint64_t x) { return leaf(x) ^ 1; }
PAGE static uint64_t fb(uint64_t x) { return leaf(x + 3) + (leaf(x) >> 7); }
PAGE static uint64_t fc(uint64_t x) { return (x >> 3) | (x << 61); }
PAGE static uint64_t rec(uint64_t n) { return n < 2 ? n : rec(n - 1) + rec(n - 2) + (n & 1); }

static fn volatile table[4] = {fa, fb, fc, leaf};
static fn volatile got = fa;

static uint64_t direct(int k, uint64_t x) {
    switch (k) {
    case 0: return fa(x);
    case 1: return fb(x);
    case 2: return fc(x);
    default: return leaf(x);
    }
}

/* A dense switch: a jump table (jalr x0 through a loaded address). */
PAGE static uint64_t dispatch(unsigned op, uint64_t a) {
    switch (op & 7) {
    case 0: return a + 1;
    case 1: return a ^ 0x5555;
    case 2: return a * 3;
    case 3: return a >> 1;
    case 4: return a - 7;
    case 5: return ~a;
    case 6: return a << 2;
    default: return a | 0x100;
    }
}

static void indirect(void) {
    uint64_t s = 0, r = 0;
    for (uint64_t i = 0; i < 300000; i++) {
        int k = (int)((i * 7) ^ (i >> 3)) & 3; /* the target changes from call to call */
        s += table[k](i);
        r += direct(k, i);
    }
    EQ(s, r);
    mix(s);
    /* The "PLT" slot is rebound in the middle of a hot loop. */
    s = r = 0;
    for (uint64_t i = 0; i < 200000; i++) {
        if (i == 100000) got = fb;
        if (i == 150000) got = leaf;
        s += got(i);
        r += i < 100000 ? fa(i) : i < 150000 ? fb(i) : leaf(i);
    }
    EQ(s, r);
    mix(s);
    uint64_t a = 1;
    for (unsigned i = 0; i < 400000; i++) a = dispatch(i * 5 + (unsigned)(a & 3), a);
    mix(a);
    uint64_t p = 0, q = 1;
    for (uint64_t n = 2; n <= 25; n++) {
        uint64_t t2 = q + p + (n & 1);
        p = q;
        q = t2;
    }
    EQ(rec(25), q);
    mix(q);
}

/* addi a0, a0, imm; ret */
static uint32_t addi_a0(int imm) { return ((uint32_t)(imm & 0xfff) << 20) | (10u << 15) | (10u << 7) | 0x13; }
#define RET 0x00008067u

static void put(uint32_t *code, int imm) {
    code[0] = addi_a0(imm);
    code[1] = RET;
    __builtin___clear_cache((char *)code, (char *)(code + 2));
}

static uint64_t hot(fn f, uint64_t n) {
    uint64_t s = 0;
    for (uint64_t i = 0; i < n; i++) s += f(i);
    return s;
}

static uint64_t sum(uint64_t n, int imm) { return n * (n - 1) / 2 + n * (uint64_t)(int64_t)imm; }

static void rewritten(void) {
    const uint64_t n = 100000;
    uint32_t *code = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    EQ(code != MAP_FAILED, 1);
    if (code == MAP_FAILED) return;
    fn f = (fn)(uintptr_t)code;
    /* Rewritten in place (RWX). */
    for (int imm = 1; imm <= 4; imm++) {
        put(code, imm * 11);
        EQ(hot(f, n), sum(n, imm * 11));
    }
    /* W^X: writable without exec while it is rewritten. */
    for (int imm = 5; imm <= 7; imm++) {
        mprotect(code, 4096, PROT_READ | PROT_WRITE);
        put(code, -imm);
        mprotect(code, 4096, PROT_READ | PROT_EXEC);
        EQ(hot(f, n), sum(n, -imm));
    }
    /* A new page at the same address. */
    munmap(code, 4096);
    uint32_t *again = mmap(code, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
    EQ(again == code, 1);
    if (again != code) return;
    put(code, 100);
    EQ(hot(f, n), sum(n, 100));
    /* Rewritten by its caller in the middle of the loop. */
    put(code, 3);
    uint64_t s = 0;
    for (uint64_t i = 0; i < n; i++) {
        if (i == n / 2) put(code, 9);
        s += f(i);
    }
    EQ(s, sum(n, 3) + (n / 2) * 6);
    mix(s);
    munmap(code, 4096);
}

int main(void) {
    indirect();
    rewritten();
    printf("jalrtest digest: %016llx\n", (unsigned long long)digest);
    printf("jalrtest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
