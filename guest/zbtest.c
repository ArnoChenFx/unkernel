// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Zba, Zbb, Zbs, Zicond (RV64; built with +zba,+zbb,+zbs,+zicond): every
 * instruction (inline asm) against a portable C model of the specs (the
 * bit-manipulation spec v1.0.0, Zicond v1.0) over many random operands and
 * every immediate, in loops long enough for the JIT to compile them; then
 * the same operations as the compiler emits them (builtins, address
 * arithmetic, conditional zeroing, bit tests). The models are `optnone`, so
 * the compiler cannot turn them into the instructions under test. A digest
 * of every result lets the output be compared with
 *   qemu-riscv64-static -cpu rv64,zba=true,zbb=true,zbs=true,zicond=true zbtest.elf
 * Exit 0 iff all pass.
 */
#include <stdint.h>
#include <stdio.h>

static int checks, failures;

#define EQ(a, b)                                                                                \
    do {                                                                                        \
        checks++;                                                                               \
        uint64_t _a = (uint64_t)(a), _b = (uint64_t)(b);                                        \
        if (_a != _b && failures++ < 20)                                                        \
            printf("FAIL line %d: %s = 0x%016llx, want 0x%016llx\n", __LINE__, #a,              \
                   (unsigned long long)_a, (unsigned long long)_b);                             \
    } while (0)

#define MODEL __attribute__((optnone, noinline)) static

/* ---- C model (the specs' pseudocode) ---------------------------------------- */

MODEL uint64_t m_shadd(uint64_t a, uint64_t b, int n, int uw)
{
    if (uw)
        a &= 0xffffffffull;
    return (a << n) + b;
}
MODEL uint64_t m_clz(uint64_t a, int w)
{
    uint64_t n = 0;
    for (int i = w - 1; i >= 0 && !((a >> i) & 1); i--)
        n++;
    return n;
}
MODEL uint64_t m_ctz(uint64_t a, int w)
{
    uint64_t n = 0;
    while ((int)n < w && !((a >> n) & 1))
        n++;
    return n;
}
MODEL uint64_t m_cpop(uint64_t a, int w)
{
    uint64_t n = 0;
    for (int i = 0; i < w; i++)
        n += (a >> i) & 1;
    return n;
}
MODEL uint64_t m_max(uint64_t a, uint64_t b, int u)
{
    if (u)
        return a > b ? a : b;
    return (int64_t)a > (int64_t)b ? a : b;
}
MODEL uint64_t m_min(uint64_t a, uint64_t b, int u)
{
    if (u)
        return a < b ? a : b;
    return (int64_t)a < (int64_t)b ? a : b;
}
MODEL uint64_t m_sext(uint64_t a, int bits)
{
    uint64_t sign = 1ull << (bits - 1), mask = (sign << 1) - 1;
    a &= mask;
    return a & sign ? a | ~mask : a;
}
MODEL uint64_t m_orcb(uint64_t a)
{
    uint64_t x = 0;
    for (int i = 0; i < 64; i += 8)
        if ((a >> i) & 0xff)
            x |= 0xffull << i;
    return x;
}
MODEL uint64_t m_rev8(uint64_t a)
{
    uint64_t x = 0;
    for (int i = 0; i < 8; i++)
        x |= ((a >> (8 * i)) & 0xff) << (56 - 8 * i);
    return x;
}
MODEL uint64_t m_bit(uint64_t a, uint64_t b, int op)
{
    uint64_t m = 1ull << (b & 63);
    switch (op) {
    case 0: return a & ~m;          /* bclr */
    case 1: return a | m;           /* bset */
    case 2: return a ^ m;           /* binv */
    default: return (a & m) != 0;   /* bext */
    }
}
MODEL uint64_t m_czero(uint64_t a, uint64_t b, int nez)
{
    if (nez)
        return b != 0 ? 0 : a;
    return b == 0 ? 0 : a;
}

/* ---- the instructions ------------------------------------------------------- */

#define R2(op, a, b) ({ uint64_t _r; __asm__ volatile(op " %0, %1, %2" : "=r"(_r) : "r"(a), "r"(b)); _r; })
#define R1(op, a) ({ uint64_t _r; __asm__ volatile(op " %0, %1" : "=r"(_r) : "r"(a)); _r; })
#define RI(op, a, n) ({ uint64_t _r; __asm__ volatile(op " %0, %1, %2" : "=r"(_r) : "r"(a), "i"(n)); _r; })

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

/* Operands with structure: zero, all ones, short values, sign-boundary and
 * 32-bit-boundary values, and random ones. */
static uint64_t operand(int i)
{
    static const uint64_t edge[] = {
        0, 1, ~0ull, 0x80, 0x7f, 0x8000, 0x7fffffff, 0x80000000ull, 0xffffffffull, 0x100000000ull,
        1ull << 63, (1ull << 63) - 1, 0xffffffff80000000ull, 0x00ff00ff00ff0000ull,
    };
    uint64_t r = next();
    switch (i % 8) {
    case 0: return edge[(i / 8) % (sizeof(edge) / sizeof(edge[0]))];
    case 1: return r >> (next() & 63);
    case 2: return r & 63;
    case 3: return r & 0x0101010001000100ull;
    default: return r;
    }
}

/* every Zba/Zbs immediate form: shamt 0..63 (a switch, as asm needs constants) */
#define SH8(x, b) x(b) x(b + 1) x(b + 2) x(b + 3) x(b + 4) x(b + 5) x(b + 6) x(b + 7)
#define SH64(x) SH8(x, 0) SH8(x, 8) SH8(x, 16) SH8(x, 24) SH8(x, 32) SH8(x, 40) SH8(x, 48) SH8(x, 56)

static uint64_t imm_op(int op, uint64_t a, int sh)
{
    switch (op * 64 + sh) {
#define C_SLLIUW(n) case 0 * 64 + n: return RI("slli.uw", a, n);
#define C_BCLRI(n) case 1 * 64 + n: return RI("bclri", a, n);
#define C_BSETI(n) case 2 * 64 + n: return RI("bseti", a, n);
#define C_BINVI(n) case 3 * 64 + n: return RI("binvi", a, n);
#define C_BEXTI(n) case 4 * 64 + n: return RI("bexti", a, n);
    SH64(C_SLLIUW)
    SH64(C_BCLRI)
    SH64(C_BSETI)
    SH64(C_BINVI)
    SH64(C_BEXTI)
    }
    return 0;
}

/* The same operations written in C: with zba/zbb/zbs/zicond the compiler
 * emits sh*add(.uw), add.uw, clz/ctz/cpop(w), min/max(u), sext.b/h,
 * zext.h, rev8, orc.b-free byte tests, bset/bclr/binv/bext(i), czero. */
__attribute__((noinline)) static uint64_t compiled(const uint64_t *t, uint64_t a, uint64_t b, uint32_t i)
{
    uint64_t x = t[i & 7] + t[(uint32_t)a & 3];               /* sh3add, sh3add.uw / slli.uw */
    x ^= (uint64_t)__builtin_clzll(a | 1) + __builtin_ctzll(b | (1ull << 63));
    x ^= (uint64_t)__builtin_popcountll(a) << 8;
    x ^= (uint64_t)__builtin_clz((uint32_t)b | 1) << 16;         /* clzw */
    x ^= (uint64_t)__builtin_popcount((uint32_t)a) << 24;        /* cpopw */
    x ^= (int64_t)a > (int64_t)b ? a : b;                        /* max */
    x += a < b ? a : b;                                          /* minu */
    x ^= (uint64_t)(int64_t)(int8_t)a + (uint64_t)(int64_t)(int16_t)b; /* sext.b, sext.h */
    x += (uint16_t)a;                                            /* zext.h */
    x ^= __builtin_bswap64(b);                                   /* rev8 */
    x ^= (a & (1ull << (b & 63))) ? 3 : 0;                       /* bext */
    x ^= b | (1ull << (a & 63));                                 /* bset */
    x ^= a & ~(1ull << 37);                                      /* bclri */
    x += (b != 0) ? 0 : a;                                       /* czero */
    x += (a & 1) ? b : 0;                                        /* czero */
    return x;
}
MODEL uint64_t m_compiled(const uint64_t *t, uint64_t a, uint64_t b, uint32_t i)
{
    uint64_t x = t[i & 7] + t[(uint32_t)a & 3];
    x ^= m_clz(a | 1, 64) + m_ctz(b | (1ull << 63), 64);
    x ^= m_cpop(a, 64) << 8;
    x ^= m_clz((uint32_t)b | 1, 32) << 16;
    x ^= m_cpop(a, 32) << 24;
    x ^= m_max(a, b, 0);
    x += m_min(a, b, 1);
    x ^= m_sext(a, 8) + m_sext(b, 16);
    x += a & 0xffff;
    x ^= m_rev8(b);
    x ^= m_bit(a, b, 3) ? 3 : 0;
    x ^= m_bit(b, a, 1);
    x ^= m_bit(a, 37, 0);
    x += m_czero(a, b, 1);
    x += m_czero(b, a & 1, 0);
    return x;
}

int main(void)
{
    EQ(R2("sh1add", 3, 5), 11);
    EQ(R1("clz", 3), 62);
    EQ(R2("bset", 3, 5), 35);
    EQ(R2("czero.eqz", 3, 5), 3);
    EQ(R1("orc.b", 0x0100800000000001ull), 0xff00ff00000000ffull);
    EQ(R1("cpopw", 0xffffffff00000000ull), 0);
    EQ(R2("add.uw", ~0ull, 1), 0x100000000ull);

    /* register forms, against the model */
    for (int i = 0; i < 30000; i++) {
        uint64_t a = operand(i), b = operand(i / 3 + 5);
        if (i % 11 == 0)
            b = 0;
        uint64_t r[17] = {
            R2("sh1add", a, b), R2("sh2add", a, b), R2("sh3add", a, b), R2("add.uw", a, b),
            R2("sh1add.uw", a, b), R2("sh2add.uw", a, b), R2("sh3add.uw", a, b),
            R2("max", a, b), R2("maxu", a, b), R2("min", a, b), R2("minu", a, b),
            R2("bclr", a, b), R2("bset", a, b), R2("binv", a, b), R2("bext", a, b),
            R2("czero.eqz", a, b), R2("czero.nez", a, b),
        };
        EQ(r[0], m_shadd(a, b, 1, 0));
        EQ(r[1], m_shadd(a, b, 2, 0));
        EQ(r[2], m_shadd(a, b, 3, 0));
        EQ(r[3], m_shadd(a, b, 0, 1));
        EQ(r[4], m_shadd(a, b, 1, 1));
        EQ(r[5], m_shadd(a, b, 2, 1));
        EQ(r[6], m_shadd(a, b, 3, 1));
        EQ(r[7], m_max(a, b, 0));
        EQ(r[8], m_max(a, b, 1));
        EQ(r[9], m_min(a, b, 0));
        EQ(r[10], m_min(a, b, 1));
        for (int k = 0; k < 4; k++)
            EQ(r[11 + k], m_bit(a, b, k));
        EQ(r[15], m_czero(a, b, 0));
        EQ(r[16], m_czero(a, b, 1));
        for (int k = 0; k < 17; k++)
            mix(r[k]);

        uint64_t u[12] = {
            R1("clz", a), R1("ctz", a), R1("cpop", a), R1("clzw", a), R1("ctzw", a), R1("cpopw", a),
            R1("sext.b", a), R1("sext.h", a), R1("zext.h", a), R1("orc.b", a), R1("rev8", a),
            R2("czero.eqz", a, a),
        };
        EQ(u[0], m_clz(a, 64));
        EQ(u[1], m_ctz(a, 64));
        EQ(u[2], m_cpop(a, 64));
        EQ(u[3], m_clz(a & 0xffffffff, 32));
        EQ(u[4], m_ctz(a, 32));
        EQ(u[5], m_cpop(a, 32));
        EQ(u[6], m_sext(a, 8));
        EQ(u[7], m_sext(a, 16));
        EQ(u[8], a & 0xffff);
        EQ(u[9], m_orcb(a));
        EQ(u[10], m_rev8(a));
        EQ(u[11], a);
        for (int k = 0; k < 12; k++)
            mix(u[k]);
    }

    /* every immediate */
    for (int i = 0; i < 3000; i++) {
        uint64_t a = operand(i);
        for (int sh = 0; sh < 64; sh++) {
            uint64_t s0 = imm_op(0, a, sh), s1 = imm_op(1, a, sh), s2 = imm_op(2, a, sh);
            uint64_t s3 = imm_op(3, a, sh), s4 = imm_op(4, a, sh);
            EQ(s0, (a & 0xffffffff) << sh);
            EQ(s1, m_bit(a, sh, 0));
            EQ(s2, m_bit(a, sh, 1));
            EQ(s3, m_bit(a, sh, 2));
            EQ(s4, m_bit(a, sh, 3));
            mix(s0 ^ s1 ^ s2), mix(s3 ^ s4);
        }
    }

    /* what the compiler makes of plain C */
    uint64_t tab[8];
    for (int i = 0; i < 8; i++)
        tab[i] = next();
    for (uint32_t i = 0; i < 40000; i++) {
        uint64_t a = operand(i), b = operand(i * 7 + 1);
        uint64_t x = compiled(tab, a, b, i);
        EQ(x, m_compiled(tab, a, b, i));
        mix(x);
    }

    /* a hot loop of address arithmetic (sh*add, add.uw) and bit counts */
    uint64_t acc = 0, want = 0;
    static uint64_t arr[256];
    for (int i = 0; i < 256; i++)
        arr[i] = next();
    for (uint32_t i = 0; i < 200000; i++) {
        uint32_t j = (uint32_t)(acc ^ i) & 255;
        acc += arr[j] + (uint64_t)__builtin_popcountll(acc ^ arr[j]) + __builtin_ctzll(acc | 0x10000);
    }
    for (uint32_t i = 0; i < 200000; i++) {
        uint32_t j = (uint32_t)(want ^ i) & 255;
        want += arr[j] + m_cpop(want ^ arr[j], 64) + m_ctz(want | 0x10000, 64);
    }
    EQ(acc, want);
    mix(acc);

    printf("zbtest digest: %016llx\n", (unsigned long long)digest);
    printf("zbtest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
