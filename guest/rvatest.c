// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Zcb, Zimop, Zcmop, Zicbom, Zicboz, Zawrs (RV64; built with +zcb, +zimop,
 * +zcmop, +zicbom, +zicboz, +zawrs, and +zba, +zbb for the Zcb forms that
 * need them): every Zcb instruction (inline asm) against a portable C model
 * over many random operands and every offset, in loops long enough for the
 * JIT to compile them; the MOPs write 0 (mop.r.N, mop.rr.N) or nothing
 * (c.mop.N); cbo.zero zeroes exactly its aligned 64-byte block, cbo.clean
 * and cbo.flush leave memory as it is, wrs.nto and wrs.sto return; then what
 * the compiler emits for plain C with Zcb (byte and halfword accesses,
 * multiplies, extensions). The models are `optnone`. A digest of every
 * result lets the output be compared with
 *   qemu-riscv64-static -cpu rv64,zba=true,zbb=true,zcb=true,zimop=true,zcmop=true,zicbom=true,zicboz=true,zawrs=true rvatest.elf
 * Exit 0 iff all pass.
 */
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

#define MODEL __attribute__((optnone, noinline)) static

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

static uint64_t operand(int i)
{
    static const uint64_t edge[] = {
        0, 1, ~0ull, 0x80, 0x7f, 0xff, 0x8000, 0x7fff, 0xffff, 0x7fffffff, 0x80000000ull,
        0xffffffffull, 0x100000000ull, 1ull << 63, (1ull << 63) - 1, 0xffffffff80000000ull,
    };
    uint64_t r = next();
    switch (i % 8) {
    case 0: return edge[(i / 8) % (sizeof(edge) / sizeof(edge[0]))];
    case 1: return r >> (next() & 63);
    case 2: return r & 0xffff;
    case 3: return r | 0x8080808080808080ull;
    default: return r;
    }
}

/* ---- C models --------------------------------------------------------------- */

MODEL uint64_t m_sext(uint64_t a, int bits)
{
    uint64_t sign = 1ull << (bits - 1), mask = (sign << 1) - 1;
    a &= mask;
    return a & sign ? a | ~mask : a;
}
MODEL uint64_t m_zext(uint64_t a, int bits)
{
    return bits == 64 ? a : a & ((1ull << bits) - 1);
}
MODEL uint64_t m_mul(uint64_t a, uint64_t b)
{
    uint64_t r = 0;
    for (int i = 0; i < 64; i++)
        if ((b >> i) & 1)
            r += a << i;
    return r;
}
MODEL uint64_t m_load(const uint8_t *p, int n, int sign)
{
    uint64_t v = 0;
    for (int i = 0; i < n; i++)
        v |= (uint64_t)p[i] << (8 * i);
    return sign ? m_sext(v, 8 * n) : v;
}

/* ---- the instructions (rd'/rs1'/rs2' must be x8..x15: "cr" constraints) ---- */

#define CU(op, a) ({ uint64_t _r = (a); __asm__ volatile(op " %0" : "+cr"(_r)); _r; })
#define CMUL(a, b) ({ uint64_t _r = (a); __asm__ volatile("c.mul %0, %1" : "+cr"(_r) : "cr"(b)); _r; })
#define CLD(op, p, off) ({ uint64_t _r; __asm__ volatile(op " %0, " #off "(%1)" : "=cr"(_r) : "cr"(p) : "memory"); _r; })
#define CST(op, v, p, off) __asm__ volatile(op " %0, " #off "(%1)" :: "cr"(v), "cr"(p) : "memory")

static uint8_t buf[512] __attribute__((aligned(64)));

static uint64_t loads(const uint8_t *p, int k)
{
    switch (k) {
    case 0: return CLD("c.lbu", p, 0);
    case 1: return CLD("c.lbu", p, 1);
    case 2: return CLD("c.lbu", p, 2);
    case 3: return CLD("c.lbu", p, 3);
    case 4: return CLD("c.lhu", p, 0);
    case 5: return CLD("c.lhu", p, 2);
    case 6: return CLD("c.lh", p, 0);
    default: return CLD("c.lh", p, 2);
    }
}
static void stores(uint64_t v, uint8_t *p, int k)
{
    switch (k) {
    case 0: CST("c.sb", v, p, 0); break;
    case 1: CST("c.sb", v, p, 1); break;
    case 2: CST("c.sb", v, p, 2); break;
    case 3: CST("c.sb", v, p, 3); break;
    case 4: CST("c.sh", v, p, 0); break;
    default: CST("c.sh", v, p, 2); break;
    }
}

/* What the compiler makes of plain C with Zcb: c.lbu/c.lhu/c.lh, c.sb/c.sh,
 * c.mul, c.zext.*, c.sext.*, c.not. */
__attribute__((noinline)) static uint64_t compiled(uint8_t *p, uint64_t a, uint64_t b)
{
    uint16_t *h = (uint16_t *)p;
    int16_t *sh = (int16_t *)p;
    uint64_t x = p[1] + (uint64_t)h[1] * 3 + (uint64_t)(int64_t)sh[3];
    x = x * (a | 1) + ~b;
    x ^= (uint8_t)a + (uint64_t)(uint16_t)b + (uint64_t)(uint32_t)(a >> 3);
    x += (uint64_t)(int64_t)(int8_t)b + (uint64_t)(int64_t)(int16_t)(a >> 5);
    p[2] = (uint8_t)x;
    h[2] = (uint16_t)(x >> 8);
    return x * b;
}
MODEL uint64_t m_compiled(uint8_t *p, uint64_t a, uint64_t b)
{
    uint64_t x = m_load(p + 1, 1, 0) + m_mul(m_load(p + 2, 2, 0), 3) + m_load(p + 6, 2, 1);
    x = m_mul(x, a | 1) + ~b;
    x ^= m_zext(a, 8) + m_zext(b, 16) + m_zext(a >> 3, 32);
    x += m_sext(b, 8) + m_sext(a >> 5, 16);
    p[2] = (uint8_t)x;
    p[4] = (uint8_t)(x >> 8);
    p[5] = (uint8_t)(x >> 16);
    return m_mul(x, b);
}

int main(void)
{
    EQ(CU("c.not", 0), ~0ull);
    EQ(CU("c.zext.w", ~0ull), 0xffffffffull);
    EQ(CU("c.sext.b", 0x80), 0xffffffffffffff80ull);
    EQ(CMUL(3, 5), 15);

    /* register forms, against the model */
    for (int i = 0; i < 40000; i++) {
        uint64_t a = operand(i), b = operand(i / 3 + 5);
        uint64_t r[7] = {
            CU("c.zext.b", a), CU("c.sext.b", a), CU("c.zext.h", a), CU("c.sext.h", a),
            CU("c.zext.w", a), CU("c.not", a), CMUL(a, b),
        };
        EQ(r[0], m_zext(a, 8));
        EQ(r[1], m_sext(a, 8));
        EQ(r[2], m_zext(a, 16));
        EQ(r[3], m_sext(a, 16));
        EQ(r[4], m_zext(a, 32));
        EQ(r[5], ~a);
        EQ(r[6], m_mul(a, b));
        for (int k = 0; k < 7; k++)
            mix(r[k]);
    }

    /* loads and stores, every offset, at every alignment of the base */
    for (int i = 0; i < (int)sizeof(buf); i++)
        buf[i] = (uint8_t)next();
    for (int i = 0; i < 20000; i++) {
        uint8_t *p = buf + 8 + (next() % 480);
        int k = i & 7;
        uint64_t v = loads(p, k);
        static const int off[8] = { 0, 1, 2, 3, 0, 2, 0, 2 };
        EQ(v, m_load(p + off[k], k < 4 ? 1 : 2, k >= 6));
        mix(v);
        uint64_t s = operand(i);
        int ks = i % 6;
        uint8_t before[8], *q = p + (ks < 4 ? ks : (ks - 4) * 2);
        int n = ks < 4 ? 1 : 2;
        memcpy(before, p - 4, 8);
        stores(s, p, ks);
        for (int j = 0; j < n; j++)
            EQ(q[j], (uint8_t)(s >> (8 * j)));
        for (int j = -4; j < 4; j++)
            if (p + j < q || p + j >= q + n)
                EQ(p[j], before[j + 4]);
        mix(m_load(p - 4, 8, 0));
    }

    /* MOPs: mop.r.N and mop.rr.N write 0 to rd; c.mop.N does nothing */
    for (int i = 0; i < 20000; i++) {
        uint64_t a = operand(i), b = operand(i + 1), r0, r1, r2, r3, r4 = a;
        __asm__ volatile("mop.r.0 %0, %1" : "=r"(r0) : "r"(a));
        __asm__ volatile("mop.r.31 %0, %1" : "=r"(r1) : "r"(a));
        __asm__ volatile("mop.rr.3 %0, %1, %2" : "=r"(r2) : "r"(a), "r"(b));
        __asm__ volatile("mv %0, %1\n\tmop.r.28 %0, %0" : "=&r"(r3) : "r"(b));
        __asm__ volatile("c.mop.1\n\tc.mop.3\n\tc.mop.5\n\tc.mop.15\n\tmv %0, %0" : "+r"(r4));
        EQ(r0, 0);
        EQ(r1, 0);
        EQ(r2, 0);
        EQ(r3, 0);
        EQ(r4, a);
        mix(r0 | r1 | r2 | r3);
        mix(r4);
    }

    /* cbo.zero: the aligned block of 64 bytes, nothing else; cbo.clean and
     * cbo.flush change nothing */
    static uint8_t blocks[64 * 8] __attribute__((aligned(64)));
    for (int i = 0; i < 4000; i++) {
        for (int j = 0; j < (int)sizeof(blocks); j++)
            blocks[j] = (uint8_t)(j * 7 + i);
        int off = 64 + (int)(next() % (64 * 6));
        uint8_t *p = blocks + off;
        __asm__ volatile("cbo.clean (%0)\n\tcbo.flush (%0)" :: "r"(p) : "memory");
        for (int j = 0; j < (int)sizeof(blocks); j++)
            EQ(blocks[j], (uint8_t)(j * 7 + i));
        __asm__ volatile("cbo.zero (%0)" :: "r"(p) : "memory");
        int b0 = off & ~63;
        uint64_t sum = 0;
        for (int j = 0; j < (int)sizeof(blocks); j++) {
            EQ(blocks[j], j >= b0 && j < b0 + 64 ? 0 : (uint8_t)(j * 7 + i));
            sum = sum * 31 + blocks[j];
        }
        mix(sum);
    }

    /* Zawrs: an LR, then wrs.nto / wrs.sto: they return */
    static uint64_t word = 5;
    for (int i = 0; i < 20000; i++) {
        uint64_t v;
        __asm__ volatile("lr.d %0, (%1)\n\twrs.nto\n\twrs.sto" : "=r"(v) : "r"(&word) : "memory");
        EQ(v, 5);
        mix(v + i);
    }

    /* what the compiler emits */
    for (int i = 0; i < 40000; i++) {
        uint64_t a = operand(i), b = operand(i * 7 + 1);
        uint8_t p1[8], p2[8];
        for (int j = 0; j < 8; j++)
            p1[j] = p2[j] = (uint8_t)next();
        uint64_t x = compiled(p1, a, b), y = m_compiled(p2, a, b);
        EQ(x, y);
        EQ(memcmp(p1, p2, 8), 0);
        mix(x);
        mix(m_load(p1, 8, 0));
    }

    printf("rvatest digest: %016llx\n", (unsigned long long)digest);
    printf("rvatest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
