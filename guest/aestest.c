// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Zkne / Zknd (RV64 scalar AES, built with +zkne,+zknd): every instruction
 * against a portable C model of the scalar crypto spec v1.0.1 over many
 * random operands (in loops long enough for the JIT to compile them, with
 * fewer and more than 4 table ops per block), the FIPS-197 AES-128 and
 * AES-256 vectors through the instructions as OpenSSL uses them, and a
 * digest of every result, so the output can be compared with
 *   qemu-riscv64-static -cpu rv64,zkne=true,zknd=true aestest.elf
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

/* ---- C model ---------------------------------------------------------------- */

static uint8_t sbox[256], isbox[256];

static uint8_t xt(uint8_t x) { return (uint8_t)((x << 1) ^ ((x & 0x80) ? 0x1b : 0)); }
static uint8_t gmul(uint8_t a, uint8_t b)
{
    uint8_t p = 0;
    for (; b; b >>= 1, a = xt(a))
        if (b & 1)
            p ^= a;
    return p;
}
static uint8_t rotl8(uint8_t x, int n) { return (uint8_t)((x << n) | (x >> (8 - n))); }

static void init_sbox(void)
{
    for (int i = 0; i < 256; i++) {
        uint8_t inv = 0;
        for (int j = 1; j < 256 && i; j++)
            if (gmul((uint8_t)i, (uint8_t)j) == 1)
                inv = (uint8_t)j;
        uint8_t s = inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63;
        sbox[i] = s;
        isbox[s] = (uint8_t)i;
    }
}

static uint8_t B(uint64_t v, int i) { return (uint8_t)(v >> (8 * i)); }
static uint64_t pack8(const uint8_t b[8])
{
    uint64_t v = 0;
    for (int i = 0; i < 8; i++)
        v |= (uint64_t)b[i] << (8 * i);
    return v;
}

/* state byte r + 4c: rs1 holds columns 0-1, rs2 columns 2-3 */
static uint8_t st(uint64_t rs1, uint64_t rs2, int i) { return i < 8 ? B(rs1, i) : B(rs2, i - 8); }

static uint64_t m_sr(uint64_t rs1, uint64_t rs2, int inv, const uint8_t *box)
{
    uint8_t o[8];
    for (int c = 0; c < 2; c++)
        for (int r = 0; r < 4; r++) {
            int sc = inv ? (c - r + 4) % 4 : (c + r) % 4;
            o[r + 4 * c] = box[st(rs1, rs2, r + 4 * sc)];
        }
    return pack8(o);
}

static uint32_t m_mix(uint32_t col, int inv)
{
    static const uint8_t f[4] = { 2, 3, 1, 1 }, g[4] = { 14, 11, 13, 9 };
    const uint8_t *m = inv ? g : f;
    uint32_t r = 0;
    for (int i = 0; i < 4; i++) {
        uint8_t v = 0;
        for (int j = 0; j < 4; j++)
            v ^= gmul((uint8_t)(col >> (8 * j)), m[(j - i + 4) % 4]);
        r |= (uint32_t)v << (8 * i);
    }
    return r;
}
static uint64_t m_mix64(uint64_t v, int inv)
{
    return m_mix((uint32_t)v, inv) | (uint64_t)m_mix((uint32_t)(v >> 32), inv) << 32;
}

static uint64_t m_es(uint64_t a, uint64_t b) { return m_sr(a, b, 0, sbox); }
static uint64_t m_esm(uint64_t a, uint64_t b) { return m_mix64(m_es(a, b), 0); }
static uint64_t m_ds(uint64_t a, uint64_t b) { return m_sr(a, b, 1, isbox); }
static uint64_t m_dsm(uint64_t a, uint64_t b) { return m_mix64(m_ds(a, b), 1); }
static uint64_t m_im(uint64_t a) { return m_mix64(a, 1); }
static uint64_t m_ks1i(uint64_t a, int rnum)
{
    static const uint8_t rcon[11] = { 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0 };
    uint32_t t = (uint32_t)(a >> 32);
    if (rnum != 10)
        t = (t >> 8) | (t << 24);
    uint32_t w = 0;
    for (int i = 0; i < 4; i++)
        w |= (uint32_t)sbox[(t >> (8 * i)) & 0xff] << (8 * i);
    w ^= rcon[rnum];
    return (uint64_t)w << 32 | w;
}
static uint64_t m_ks2(uint64_t a, uint64_t b)
{
    uint32_t w0 = (uint32_t)(a >> 32) ^ (uint32_t)b;
    uint32_t w1 = w0 ^ (uint32_t)(b >> 32);
    return (uint64_t)w1 << 32 | w0;
}

/* ---- the instructions ----------------------------------------------------------- */

#define R2(op, a, b) ({ uint64_t _r; __asm__ volatile(op " %0, %1, %2" : "=r"(_r) : "r"(a), "r"(b)); _r; })
static inline uint64_t es(uint64_t a, uint64_t b) { return R2("aes64es", a, b); }
static inline uint64_t esm(uint64_t a, uint64_t b) { return R2("aes64esm", a, b); }
static inline uint64_t ds(uint64_t a, uint64_t b) { return R2("aes64ds", a, b); }
static inline uint64_t dsm(uint64_t a, uint64_t b) { return R2("aes64dsm", a, b); }
static inline uint64_t ks2(uint64_t a, uint64_t b) { return R2("aes64ks2", a, b); }
static inline uint64_t im(uint64_t a)
{
    uint64_t r;
    __asm__ volatile("aes64im %0, %1" : "=r"(r) : "r"(a));
    return r;
}
#define KS1I(a, n) ({ uint64_t _r; __asm__ volatile("aes64ks1i %0, %1, %2" : "=r"(_r) : "r"(a), "i"(n)); _r; })
static uint64_t ks1i(uint64_t a, int n)
{
    switch (n) {
    case 0: return KS1I(a, 0);
    case 1: return KS1I(a, 1);
    case 2: return KS1I(a, 2);
    case 3: return KS1I(a, 3);
    case 4: return KS1I(a, 4);
    case 5: return KS1I(a, 5);
    case 6: return KS1I(a, 6);
    case 7: return KS1I(a, 7);
    case 8: return KS1I(a, 8);
    case 9: return KS1I(a, 9);
    default: return KS1I(a, 10);
    }
}

/* ---- AES as OpenSSL's riscv64 Zkn code runs it ------------------------------------ */

struct key { uint64_t rk[15][2]; int nr; };

static uint64_t ld64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }

static void expand(struct key *k, const uint8_t *key, int bits)
{
    uint64_t w[4];
    for (int i = 0; i < bits / 64; i++)
        w[i] = ld64(key + 8 * i);
    k->rk[0][0] = w[0];
    k->rk[0][1] = w[1];
    if (bits == 128) {
        k->nr = 10;
        for (int i = 0; i < 10; i++) {
            w[0] = ks2(ks1i(w[1], i), w[0]);
            w[1] = ks2(w[0], w[1]);
            k->rk[i + 1][0] = w[0];
            k->rk[i + 1][1] = w[1];
        }
        return;
    }
    k->nr = 14;
    k->rk[1][0] = w[2];
    k->rk[1][1] = w[3];
    for (int r = 2, i = 0; r <= 14; i++) {
        w[0] = ks2(ks1i(w[3], i), w[0]);
        w[1] = ks2(w[0], w[1]);
        k->rk[r][0] = w[0];
        k->rk[r++][1] = w[1];
        if (r > 14)
            break;
        w[2] = ks2(ks1i(w[1], 10), w[2]);
        w[3] = ks2(w[2], w[3]);
        k->rk[r][0] = w[2];
        k->rk[r++][1] = w[3];
    }
}

static void encrypt(const struct key *k, const uint8_t in[16], uint8_t out[16])
{
    uint64_t s0 = ld64(in) ^ k->rk[0][0], s1 = ld64(in + 8) ^ k->rk[0][1], n0, n1;
    for (int r = 1; r < k->nr; r++) {
        n0 = esm(s0, s1);
        n1 = esm(s1, s0);
        s0 = n0 ^ k->rk[r][0];
        s1 = n1 ^ k->rk[r][1];
    }
    n0 = es(s0, s1) ^ k->rk[k->nr][0];
    n1 = es(s1, s0) ^ k->rk[k->nr][1];
    memcpy(out, &n0, 8);
    memcpy(out + 8, &n1, 8);
}

static void decrypt(const struct key *k, const uint8_t in[16], uint8_t out[16])
{
    uint64_t s0 = ld64(in) ^ k->rk[k->nr][0], s1 = ld64(in + 8) ^ k->rk[k->nr][1], n0, n1;
    for (int r = k->nr - 1; r >= 1; r--) {
        n0 = dsm(s0, s1);
        n1 = dsm(s1, s0);
        s0 = n0 ^ im(k->rk[r][0]);
        s1 = n1 ^ im(k->rk[r][1]);
    }
    n0 = ds(s0, s1) ^ k->rk[0][0];
    n1 = ds(s1, s0) ^ k->rk[0][1];
    memcpy(out, &n0, 8);
    memcpy(out + 8, &n1, 8);
}

static void hex(const char *s, uint8_t *out)
{
    for (int i = 0; s[2 * i]; i++) {
        unsigned v;
        sscanf(s + 2 * i, "%2x", &v);
        out[i] = (uint8_t)v;
    }
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
    init_sbox();
    EQ(sbox[0x00], 0x63);
    EQ(sbox[0x53], 0xed);
    EQ(isbox[0x16], 0xff);

    /* every instruction against the model; 5 table ops in one loop body */
    for (int i = 0; i < 40000; i++) {
        uint64_t a = next(), b = next();
        if (i < 4) { /* edge operands */
            a = i & 1 ? ~0ull : 0;
            b = i & 2 ? ~0ull : 0;
        }
        uint64_t r0 = es(a, b), r1 = esm(a, b), r2 = ds(a, b), r3 = dsm(a, b), r4 = im(a), r5 = ks2(a, b);
        EQ(r0, m_es(a, b));
        EQ(r1, m_esm(a, b));
        EQ(r2, m_ds(a, b));
        EQ(r3, m_dsm(a, b));
        EQ(r4, m_im(a));
        EQ(r5, m_ks2(a, b));
        mix(r0), mix(r1), mix(r2), mix(r3), mix(r4), mix(r5);
    }
    /* one table op per loop body (compiled inline) */
    uint64_t acc = 1;
    for (int i = 0; i < 100000; i++)
        acc = esm(acc, (uint64_t)i) ^ (uint64_t)i;
    mix(acc);
    uint64_t want = 1;
    for (int i = 0; i < 100000; i++)
        want = m_esm(want, (uint64_t)i) ^ (uint64_t)i;
    EQ(acc, want);
    for (int i = 0; i < 20000; i++) {
        uint64_t a = next();
        int n = i % 11;
        uint64_t r = ks1i(a, n);
        EQ(r, m_ks1i(a, n));
        mix(r);
    }

    /* FIPS-197 appendix C.1 / C.3 through the instructions, many times */
    static const char *vec[][3] = {
        { "000102030405060708090a0b0c0d0e0f", "00112233445566778899aabbccddeeff", "69c4e0d86a7b0430d8cdb78070b4c55a" },
        { "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "00112233445566778899aabbccddeeff",
          "8ea2b7ca516745bfeafc49904b496089" },
        { "2b7e151628aed2a6abf7158809cf4f3c", "3243f6a8885a308d313198a2e0370734", "3925841d02dc09fbdc118597196a0b32" },
    };
    for (int v = 0; v < 3; v++) {
        uint8_t keyb[32], pt[16], ct[16], out[16], back[16];
        struct key k;
        int bits = (int)strlen(vec[v][0]) * 4;
        hex(vec[v][0], keyb);
        hex(vec[v][1], pt);
        hex(vec[v][2], ct);
        expand(&k, keyb, bits);
        int ok = 1;
        for (int rep = 0; rep < 3000; rep++) {
            encrypt(&k, pt, out);
            decrypt(&k, out, back);
            ok &= !memcmp(out, ct, 16) && !memcmp(back, pt, 16);
        }
        EQ(ok, 1);
        mix(ld64(out) ^ ld64(out + 8));
    }
    /* chained: 10000 AES-128 encryptions of the previous ciphertext, then back */
    {
        uint8_t keyb[16], blk[16] = { 0 };
        struct key k;
        hex("000102030405060708090a0b0c0d0e0f", keyb);
        expand(&k, keyb, 128);
        for (int i = 0; i < 10000; i++)
            encrypt(&k, blk, blk);
        mix(ld64(blk)), mix(ld64(blk + 8));
        for (int i = 0; i < 10000; i++)
            decrypt(&k, blk, blk);
        EQ(ld64(blk) | ld64(blk + 8), 0);
    }

    printf("aestest digest: %016llx\n", (unsigned long long)digest);
    printf("aestest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
