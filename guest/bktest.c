// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Zbc, Zbkb, Zbkc, Zbkx (RV64; built with +zbc,+zbkb,+zbkc,+zbkx): every
 * instruction against a portable C model of the specs (the bit-manipulation
 * spec v1.0.0, the scalar crypto spec v1.0.1) over many random operands, in
 * loops long enough for the JIT to compile them (with up to 12 and with more
 * than 12 clmul/xperm ops per block), GHASH through clmul as OpenSSL does it
 * against a bit-by-bit GF(2^128) model and the GCM spec's test vectors, and a
 * digest of every result, so the output can be compared with
 *   qemu-riscv64-static -cpu rv64,zbc=true,zbkb=true,zbkc=true,zbkx=true bktest.elf
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

/* ---- C model (the specs' loops) ------------------------------------------------- */

static uint64_t m_clmul(uint64_t a, uint64_t b)
{
    uint64_t x = 0;
    for (int i = 0; i < 64; i++)
        if ((b >> i) & 1)
            x ^= a << i;
    return x;
}
static uint64_t m_clmulh(uint64_t a, uint64_t b)
{
    uint64_t x = 0;
    for (int i = 1; i < 64; i++)
        if ((b >> i) & 1)
            x ^= a >> (64 - i);
    return x;
}
static uint64_t m_clmulr(uint64_t a, uint64_t b)
{
    uint64_t x = 0;
    for (int i = 0; i < 64; i++)
        if ((b >> i) & 1)
            x ^= a >> (63 - i);
    return x;
}
static uint64_t m_xperm(uint64_t a, uint64_t b, int sz)
{
    uint64_t mask = (1ull << sz) - 1, x = 0;
    for (int i = 0; i < 64; i += sz) {
        uint64_t idx = (b >> i) & mask;
        if (idx * sz < 64)
            x |= ((a >> (idx * sz)) & mask) << i;
    }
    return x;
}
static uint64_t m_rev8(uint64_t a)
{
    uint64_t x = 0;
    for (int i = 0; i < 8; i++)
        x |= ((a >> (8 * i)) & 0xff) << (56 - 8 * i);
    return x;
}
static uint64_t m_brev8(uint64_t a)
{
    uint64_t x = 0;
    for (int i = 0; i < 64; i++)
        if ((a >> i) & 1)
            x |= 1ull << ((i & ~7) | (7 - (i & 7)));
    return x;
}
static uint64_t sx32(uint32_t v) { return (uint64_t)(int64_t)(int32_t)v; }
static uint64_t m_rol(uint64_t a, unsigned n) { n &= 63; return n ? a << n | a >> (64 - n) : a; }
static uint64_t m_ror(uint64_t a, unsigned n) { return m_rol(a, (64 - (n & 63)) & 63); }
static uint64_t m_rolw(uint64_t a, unsigned n)
{
    uint32_t v = (uint32_t)a;
    n &= 31;
    return sx32(n ? v << n | v >> (32 - n) : v);
}
static uint64_t m_rorw(uint64_t a, unsigned n) { return m_rolw(a, (32 - (n & 31)) & 31); }
static uint64_t m_pack(uint64_t a, uint64_t b) { return b << 32 | (a & 0xffffffff); }
static uint64_t m_packh(uint64_t a, uint64_t b) { return (b & 0xff) << 8 | (a & 0xff); }
static uint64_t m_packw(uint64_t a, uint64_t b) { return sx32((uint32_t)((b & 0xffff) << 16 | (a & 0xffff))); }

/* ---- the instructions ----------------------------------------------------------- */

#define R2(op, a, b) ({ uint64_t _r; __asm__ volatile(op " %0, %1, %2" : "=r"(_r) : "r"(a), "r"(b)); _r; })
#define R1(op, a) ({ uint64_t _r; __asm__ volatile(op " %0, %1" : "=r"(_r) : "r"(a)); _r; })
#define RI(op, a, n) ({ uint64_t _r; __asm__ volatile(op " %0, %1, %2" : "=r"(_r) : "r"(a), "i"(n)); _r; })
static inline uint64_t clmul(uint64_t a, uint64_t b) { return R2("clmul", a, b); }
static inline uint64_t clmulh(uint64_t a, uint64_t b) { return R2("clmulh", a, b); }
static inline uint64_t clmulr(uint64_t a, uint64_t b) { return R2("clmulr", a, b); }
static inline uint64_t xperm4(uint64_t a, uint64_t b) { return R2("xperm4", a, b); }
static inline uint64_t xperm8(uint64_t a, uint64_t b) { return R2("xperm8", a, b); }
static inline uint64_t brev8(uint64_t a) { return R1("brev8", a); }
static inline uint64_t rev8(uint64_t a) { return R1("rev8", a); }

/* ---- GHASH (GCM's GF(2^128) multiplication) ------------------------------------- */

/* NIST SP 800-38D algorithm 1, bit by bit; blocks as two big-endian halves. */
static void gf_ref(const uint64_t x[2], const uint64_t y[2], uint64_t z[2])
{
    uint64_t v0 = y[0], v1 = y[1], z0 = 0, z1 = 0;
    for (int i = 0; i < 128; i++) {
        if ((x[i / 64] >> (63 - i % 64)) & 1)
            z0 ^= v0, z1 ^= v1;
        int lsb = v1 & 1;
        v1 = v1 >> 1 | v0 << 63;
        v0 >>= 1;
        if (lsb)
            v0 ^= 0xe1ull << 56;
    }
    z[0] = z0, z[1] = z1;
}

/* As OpenSSL's gcm_gmult_rv64i_zbc__zbkb: brev8 the little-endian loaded
 * words (byte-swapped big-endian halves here), schoolbook 128 x 128 with
 * clmul/clmulh, reduce by 0x87. Eight clmul* ops per call (a helper call
 * each when compiled). */
static void gf_clmul(const uint64_t x[2], const uint64_t y[2], uint64_t z[2])
{
    uint64_t x0 = brev8(rev8(x[0])), x1 = brev8(rev8(x[1]));
    uint64_t y0 = brev8(rev8(y[0])), y1 = brev8(rev8(y[1]));
    uint64_t z0 = clmul(x0, y0);
    uint64_t z1 = clmulh(x0, y0) ^ clmul(x0, y1) ^ clmul(x1, y0);
    uint64_t z2 = clmulh(x0, y1) ^ clmulh(x1, y0) ^ clmul(x1, y1);
    uint64_t z3 = clmulh(x1, y1);
    z1 ^= clmul(z3, 0x87);
    z2 ^= clmulh(z3, 0x87);
    z0 ^= clmul(z2, 0x87);
    z1 ^= clmulh(z2, 0x87);
    z[0] = rev8(brev8(z0));
    z[1] = rev8(brev8(z1));
}

static void hex(const char *s, uint8_t *out)
{
    for (int i = 0; s[2 * i]; i++) {
        unsigned v;
        sscanf(s + 2 * i, "%2x", &v);
        out[i] = (uint8_t)v;
    }
}
static uint64_t be64(const uint8_t *p)
{
    uint64_t v = 0;
    for (int i = 0; i < 8; i++)
        v = v << 8 | p[i];
    return v;
}

/* GHASH_H(A, C) (zero-padded blocks, then the length block); a and c are
 * zero-padded to whole blocks. */
static void ghash(const uint64_t h[2], const uint8_t *a, size_t al, const uint8_t *c, size_t cl, uint64_t out[2])
{
    uint64_t y[2] = { 0, 0 };
    for (int part = 0; part < 2; part++) {
        const uint8_t *p = part ? c : a;
        size_t n = part ? cl : al;
        for (size_t i = 0; i < n; i += 16) {
            y[0] ^= be64(p + i), y[1] ^= be64(p + i + 8);
            gf_clmul(y, h, y);
        }
    }
    y[0] ^= (uint64_t)al * 8, y[1] ^= (uint64_t)cl * 8;
    gf_clmul(y, h, out);
}

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

int main(void)
{
    EQ(clmul(3, 5), 15);
    EQ(clmulr(~0ull, ~0ull), 0xaaaaaaaaaaaaaaaaull);
    EQ(rev8(0x0123456789abcdefull), 0xefcdab8967452301ull);
    EQ(xperm8(3, 5), 0x0303030303030300ull);

    /* every instruction against the model */
    for (int i = 0; i < 40000; i++) {
        uint64_t a = next(), b = next();
        if (i < 4) { /* edge operands */
            a = i & 1 ? ~0ull : 0;
            b = i & 2 ? ~0ull : 0;
        } else if (i % 5 == 0)
            b &= 0x0707070707070707ull; /* xperm8 indices in range */
        uint64_t r0 = clmul(a, b), r1 = clmulh(a, b), r2 = clmulr(a, b), r3 = xperm4(a, b), r4 = xperm8(a, b);
        uint64_t r5 = clmul(b, a);
        EQ(r0, m_clmul(a, b));
        EQ(r1, m_clmulh(a, b));
        EQ(r2, m_clmulr(a, b));
        EQ(r3, m_xperm(a, b, 4));
        EQ(r4, m_xperm(a, b, 8));
        EQ(r5, r0);
        mix(r0), mix(r1), mix(r2), mix(r3), mix(r4);

        uint64_t s0 = R2("andn", a, b), s1 = R2("orn", a, b), s2 = R2("xnor", a, b);
        uint64_t s3 = R2("rol", a, b), s4 = R2("ror", a, b), s5 = R2("rolw", a, b), s6 = R2("rorw", a, b);
        uint64_t s7 = R2("pack", a, b), s8 = R2("packh", a, b), s9 = R2("packw", a, b);
        uint64_t s10 = rev8(a), s11 = brev8(a), s12 = R1("zext.h", a);
        EQ(s0, a & ~b);
        EQ(s1, a | ~b);
        EQ(s2, ~(a ^ b));
        EQ(s3, m_rol(a, (unsigned)b));
        EQ(s4, m_ror(a, (unsigned)b));
        EQ(s5, m_rolw(a, (unsigned)b));
        EQ(s6, m_rorw(a, (unsigned)b));
        EQ(s7, m_pack(a, b));
        EQ(s8, m_packh(a, b));
        EQ(s9, m_packw(a, b));
        EQ(s10, m_rev8(a));
        EQ(s11, m_brev8(a));
        EQ(s12, a & 0xffff);
        mix(s0 ^ s1 ^ s2), mix(s3 ^ s4), mix(s5 ^ s6), mix(s7 ^ s8 ^ s9), mix(s10 ^ s11 ^ s12);

        uint64_t t0 = RI("rori", a, 0), t1 = RI("rori", a, 1), t2 = RI("rori", a, 37), t3 = RI("rori", a, 63);
        uint64_t t4 = RI("roriw", a, 0), t5 = RI("roriw", a, 9), t6 = RI("roriw", a, 31);
        EQ(t0, a);
        EQ(t1, m_ror(a, 1));
        EQ(t2, m_ror(a, 37));
        EQ(t3, m_ror(a, 63));
        EQ(t4, sx32((uint32_t)a));
        EQ(t5, m_rorw(a, 9));
        EQ(t6, m_rorw(a, 31));
        mix(t0 ^ t1 ^ t2 ^ t3), mix(t4 ^ t5 ^ t6);
    }
    /* 14 clmul/xperm ops in one block (more than the JIT inlines: helper calls) */
    for (int i = 0; i < 20000; i++) {
        uint64_t a = next(), b = next(), c = a ^ (b >> 7);
        uint64_t f = clmul(a, b) ^ clmulh(a, c) ^ clmulr(b, c) ^ xperm4(a, b) ^ xperm8(b, c) ^ clmul(c, b) ^ clmulh(b, a);
        f ^= clmulr(a, a) ^ clmul(c, c) ^ clmulh(c, b) ^ xperm8(a, c & 0x0707070707070707ull) ^ xperm4(c, a) ^ clmul(f, a) ^ clmulh(f, b);
        uint64_t g = m_clmul(a, b) ^ m_clmulh(a, c) ^ m_clmulr(b, c) ^ m_xperm(a, b, 4) ^ m_xperm(b, c, 8) ^ m_clmul(c, b) ^ m_clmulh(b, a);
        g ^= m_clmulr(a, a) ^ m_clmul(c, c) ^ m_clmulh(c, b) ^ m_xperm(a, c & 0x0707070707070707ull, 8) ^ m_xperm(c, a, 4) ^ m_clmul(g, a) ^ m_clmulh(g, b);
        EQ(f, g);
        mix(f);
    }
    /* one clmul per loop body (compiled inline): a carry-less power chain */
    uint64_t acc = 1, want = 1;
    for (int i = 0; i < 100000; i++)
        acc = clmul(acc, (uint64_t)i | 1) ^ clmulh(acc, 0x87);
    for (int i = 0; i < 100000; i++)
        want = m_clmul(want, (uint64_t)i | 1) ^ m_clmulh(want, 0x87);
    EQ(acc, want);
    mix(acc);

    /* GHASH: clmul against SP 800-38D algorithm 1, and the GCM spec's vectors */
    for (int i = 0; i < 20000; i++) {
        uint64_t x[2] = { next(), next() }, y[2] = { next(), next() }, z[2], w[2];
        gf_clmul(x, y, z);
        gf_ref(x, y, w);
        EQ(z[0], w[0]);
        EQ(z[1], w[1]);
        mix(z[0] ^ z[1]);
    }
    static const char *vec[][4] = {
        /* test case 2: H, A, C, GHASH(H, A, C) */
        { "66e94bd4ef8a2c3b884cfa59ca342b2e", "", "0388dace60b6a392f328c2b971b2fe78", "f38cbb1ad69223dcc3457ae5b6b0f885" },
        /* test case 4 */
        { "b83b533708bf535d0aa6e52980d53b78", "feedfacedeadbeeffeedfacedeadbeefabaddad2",
          "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091",
          "698e57f70e6ecc7fd9463b7260a9ae5f" },
    };
    for (int v = 0; v < 2; v++) {
        uint8_t hb[16], ab[64] = { 0 }, cb[64] = { 0 }, wb[16];
        uint64_t h[2], g[2] = { 0, 0 };
        size_t al = strlen(vec[v][1]) / 2, cl = strlen(vec[v][2]) / 2;
        hex(vec[v][0], hb);
        hex(vec[v][1], ab);
        hex(vec[v][2], cb);
        hex(vec[v][3], wb);
        h[0] = be64(hb), h[1] = be64(hb + 8);
        int ok = 1;
        for (int rep = 0; rep < 2000; rep++) {
            ghash(h, ab, al, cb, cl, g);
            ok &= g[0] == be64(wb) && g[1] == be64(wb + 8);
        }
        EQ(ok, 1);
        mix(g[0]), mix(g[1]);
    }

    printf("bktest digest: %016llx\n", (unsigned long long)digest);
    printf("bktest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
