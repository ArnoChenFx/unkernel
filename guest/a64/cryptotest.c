// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 crypto and CRC32 self-test: AESE, AESD, AESMC, AESIMC, SHA1C/P/M,
 * SHA1H, SHA1SU0/1, SHA256H/H2, SHA256SU0/1, CRC32{,C}{B,H,W,X}.
 *
 * Known answers (exit status 1 if one is wrong): AES-128 (FIPS-197 C.1)
 * encryption and decryption with the key expanded through AESE, SHA-1 and
 * SHA-256 of "abc" and of the two-block FIPS 180 message, CRC-32 and
 * CRC-32C of "123456789" bytewise and eight bytes at a time. Then each
 * instruction over pseudo-random register values, one hash per form, which
 * test/a64-test.mjs compares with qemu-aarch64.
 *
 * Runs the instructions unconditionally (no HWCAP check). PMULL is decoded
 * in simd_arith.zig and tested with the AdvSIMD arithmetic.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef uint64_t u64;
typedef uint32_t u32;
typedef uint8_t u8;

#define EXT ".arch_extension aes\n\t.arch_extension sha2\n\t.arch_extension crc\n\t"

/* d = insn(d, n, m) on whole q registers: v0 = d, v1 = n, v2 = m */
#define V3(fn, insn) static void fn(u8 *d, const u8 *n, const u8 *m) { \
    __asm__ volatile(EXT "ldr q0, [%0]\n\tldr q1, [%1]\n\tldr q2, [%2]\n\t" insn "\n\tstr q0, [%0]" \
        : : "r"(d), "r"(n), "r"(m) : "v0", "v1", "v2", "memory"); }
/* d = insn(d, n) */
#define V2(fn, insn) static void fn(u8 *d, const u8 *n) { \
    __asm__ volatile(EXT "ldr q0, [%0]\n\tldr q1, [%1]\n\t" insn "\n\tstr q0, [%0]" \
        : : "r"(d), "r"(n) : "v0", "v1", "memory"); }

V2(aese, "aese v0.16b, v1.16b")
V2(aesd, "aesd v0.16b, v1.16b")
V2(aesmc, "aesmc v0.16b, v1.16b")
V2(aesimc, "aesimc v0.16b, v1.16b")
V2(aese_same, "aese v0.16b, v0.16b")
V2(aesmc_same, "aesmc v0.16b, v0.16b")
V2(aesimc_same, "aesimc v0.16b, v0.16b")
V3(sha1c, "sha1c q0, s1, v2.4s")
V3(sha1p, "sha1p q0, s1, v2.4s")
V3(sha1m, "sha1m q0, s1, v2.4s")
V3(sha1su0, "sha1su0 v0.4s, v1.4s, v2.4s")
V2(sha1h, "sha1h s0, s1")
V2(sha1su1, "sha1su1 v0.4s, v1.4s")
V3(sha256h, "sha256h q0, q1, v2.4s")
V3(sha256h2, "sha256h2 q0, q1, v2.4s")
V3(sha256su1, "sha256su1 v0.4s, v1.4s, v2.4s")
V2(sha256su0, "sha256su0 v0.4s, v1.4s")
V3(sha1c_same, "sha1c q0, s0, v0.4s")
V3(sha256h_same, "sha256h q0, q0, v0.4s")
V2(sha1su1_same, "sha1su1 v0.4s, v0.4s")

#define CRC(fn, insn, reg) static u32 fn(u32 a, u64 v) { u32 r; \
    __asm__ volatile(EXT insn " %w0, %w1, %" reg "2" : "=r"(r) : "r"(a), "r"(v)); return r; }
CRC(crc32b, "crc32b", "w")
CRC(crc32h, "crc32h", "w")
CRC(crc32w, "crc32w", "w")
CRC(crc32x, "crc32x", "x")
CRC(crc32cb, "crc32cb", "w")
CRC(crc32ch, "crc32ch", "w")
CRC(crc32cw, "crc32cw", "w")
CRC(crc32cx, "crc32cx", "x")

static int failures;
static void check(const char *name, int ok) {
    printf("%-10s %s\n", name, ok ? "ok" : "FAIL");
    if (!ok) failures++;
}

static u64 rng = 0x9e3779b97f4a7c15;
static u64 next(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}
static void fill(u8 *p) {
    u64 a = next(), b = next();
    memcpy(p, &a, 8);
    memcpy(p + 8, &b, 8);
}

static u64 hash;
static void mix(u64 v) {
    hash ^= v;
    hash *= 0x100000001b3;
    hash ^= hash >> 29;
}
static void mix16(const u8 *p) {
    u64 a, b;
    memcpy(&a, p, 8);
    memcpy(&b, p + 8, 8);
    mix(a);
    mix(b);
}
static void report(const char *name) {
    printf("%-10s %016llx\n", name, (unsigned long long)hash);
    hash = 0xcbf29ce484222325;
}

static u32 be32(const u8 *p) { return (u32)p[0] << 24 | (u32)p[1] << 16 | (u32)p[2] << 8 | p[3]; }
static void put32(u8 *p, u32 v) { memcpy(p, &v, 4); }
static u32 get32(const u8 *p) { u32 v; memcpy(&v, p, 4); return v; }

/* ---- AES -------------------------------------------------------------------- */

static const u8 zero16[16] __attribute__((aligned(16)));

/* SubWord through AESE: with all four columns equal ShiftRows is the identity. */
static u32 subword(u32 w) {
    u8 s[16] __attribute__((aligned(16)));
    for (int i = 0; i < 4; i++) put32(s + 4 * i, w);
    aese(s, zero16);
    return get32(s);
}

static void aes_known(void) {
    static const u8 key[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
    static const u8 pt[16] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff };
    static const u8 ct[16] = { 0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30, 0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a };
    static const u8 rcon[10] = { 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36 };
    u8 rk[11][16] __attribute__((aligned(16)));
    /* little-endian words: byte 0 of the key is the low byte of w[0] */
    u32 w[44];
    for (int i = 0; i < 4; i++) w[i] = get32(key + 4 * i);
    for (int i = 4; i < 44; i++) {
        u32 x = w[i - 1];
        if (i % 4 == 0) x = subword(x >> 8 | x << 24) ^ rcon[i / 4 - 1];
        w[i] = w[i - 4] ^ x;
    }
    for (int r = 0; r < 11; r++)
        for (int j = 0; j < 4; j++) put32(rk[r] + 4 * j, w[4 * r + j]);

    u8 s[16] __attribute__((aligned(16)));
    memcpy(s, pt, 16);
    for (int r = 0; r < 9; r++) {
        aese(s, rk[r]);
        aesmc(s, s);
    }
    aese(s, rk[9]);
    for (int i = 0; i < 16; i++) s[i] ^= rk[10][i];
    check("aes128-enc", memcmp(s, ct, 16) == 0);

    /* equivalent inverse cipher */
    u8 dk[16] __attribute__((aligned(16)));
    memcpy(s, ct, 16);
    aesd(s, rk[10]);
    for (int r = 9; r >= 1; r--) {
        aesimc(s, s);
        aesimc(dk, rk[r]);
        aesd(s, dk);
    }
    for (int i = 0; i < 16; i++) s[i] ^= rk[0][i];
    check("aes128-dec", memcmp(s, pt, 16) == 0);
}

/* ---- SHA -------------------------------------------------------------------- */

static void add4(u8 *d, const u8 *a, const u32 *k) {
    for (int i = 0; i < 4; i++) put32(d + 4 * i, get32(a + 4 * i) + k[i]);
}

static void sha256_block(u32 st[8], const u8 *blk) {
    static const u32 K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    };
    u8 w[4][16] __attribute__((aligned(16)));
    u8 abcd[16] __attribute__((aligned(16))), efgh[16] __attribute__((aligned(16)));
    u8 old[16] __attribute__((aligned(16))), wk[16] __attribute__((aligned(16)));
    for (int i = 0; i < 16; i++) put32(w[i / 4] + 4 * (i % 4), be32(blk + 4 * i));
    for (int i = 0; i < 4; i++) { put32(abcd + 4 * i, st[i]); put32(efgh + 4 * i, st[4 + i]); }
    for (int q = 0; q < 16; q++) {
        add4(wk, w[q % 4], K + 4 * q);
        memcpy(old, abcd, 16);
        sha256h(abcd, efgh, wk);
        sha256h2(efgh, old, wk);
        if (q < 12) {
            sha256su0(w[q % 4], w[(q + 1) % 4]);
            sha256su1(w[q % 4], w[(q + 2) % 4], w[(q + 3) % 4]);
        }
    }
    for (int i = 0; i < 4; i++) { st[i] += get32(abcd + 4 * i); st[4 + i] += get32(efgh + 4 * i); }
}

static void sha1_block(u32 st[5], const u8 *blk) {
    static const u32 K[4] = { 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6 };
    u8 w[4][16] __attribute__((aligned(16)));
    u8 abcd[16] __attribute__((aligned(16))), wk[16] __attribute__((aligned(16)));
    u8 e[16] __attribute__((aligned(16))) = { 0 }, en[16] __attribute__((aligned(16)));
    for (int i = 0; i < 16; i++) put32(w[i / 4] + 4 * (i % 4), be32(blk + 4 * i));
    for (int i = 0; i < 4; i++) put32(abcd + 4 * i, st[i]);
    put32(e, st[4]);
    for (int q = 0; q < 20; q++) {
        u32 k[4] = { K[q / 5], K[q / 5], K[q / 5], K[q / 5] };
        add4(wk, w[q % 4], k);
        memset(en, 0xa5, 16);
        sha1h(en, abcd);
        switch (q / 5) {
        case 0: sha1c(abcd, e, wk); break;
        case 2: sha1m(abcd, e, wk); break;
        default: sha1p(abcd, e, wk); break;
        }
        memcpy(e, en, 16);
        if (q < 16) {
            sha1su0(w[q % 4], w[(q + 1) % 4], w[(q + 2) % 4]);
            sha1su1(w[q % 4], w[(q + 3) % 4]);
        }
    }
    for (int i = 0; i < 4; i++) st[i] += get32(abcd + 4 * i);
    st[4] += get32(e);
}

/* pad msg (< 120 bytes) into one or two blocks; returns the block count */
static int pad(u8 out[128], const char *msg) {
    size_t n = strlen(msg);
    int blocks = n < 56 ? 1 : 2;
    memset(out, 0, 128);
    memcpy(out, msg, n);
    out[n] = 0x80;
    u64 bits = (u64)n * 8;
    for (int i = 0; i < 8; i++) out[64 * blocks - 1 - i] = (u8)(bits >> (8 * i));
    return blocks;
}

static void sha_known(void) {
    static const char *msgs[2] = { "abc", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" };
    static const u32 want256[2][8] = {
        { 0xba7816bf, 0x8f01cfea, 0x414140de, 0x5dae2223, 0xb00361a3, 0x96177a9c, 0xb410ff61, 0xf20015ad },
        { 0x248d6a61, 0xd20638b8, 0xe5c02693, 0x0c3e6039, 0xa33ce459, 0x64ff2167, 0xf6ecedd4, 0x19db06c1 },
    };
    static const u32 want1[2][5] = {
        { 0xa9993e36, 0x4706816a, 0xba3e2571, 0x7850c26c, 0x9cd0d89d },
        { 0x84983e44, 0x1c3bd26e, 0xbaae4aa1, 0xf95129e5, 0xe54670f1 },
    };
    for (int m = 0; m < 2; m++) {
        u8 buf[128];
        int nb = pad(buf, msgs[m]);
        u32 s256[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
        u32 s1[5] = { 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0 };
        for (int b = 0; b < nb; b++) {
            sha256_block(s256, buf + 64 * b);
            sha1_block(s1, buf + 64 * b);
        }
        check(m ? "sha256-2b" : "sha256-abc", memcmp(s256, want256[m], sizeof s256) == 0);
        check(m ? "sha1-2b" : "sha1-abc", memcmp(s1, want1[m], sizeof s1) == 0);
    }
}

/* ---- CRC32 ------------------------------------------------------------------ */

static void crc_known(void) {
    const char *s = "123456789";
    u32 a = ~0u, c = ~0u;
    for (int i = 0; i < 9; i++) {
        a = crc32b(a, (u8)s[i]);
        c = crc32cb(c, (u8)s[i]);
    }
    check("crc32", ~a == 0xcbf43926);
    check("crc32c", ~c == 0xe3069283);
    /* "12345678" by X, then "9" by B; and by H/W pieces */
    u64 v;
    memcpy(&v, s, 8);
    a = crc32b(crc32x(~0u, v), '9');
    c = crc32cb(crc32cx(~0u, v), '9');
    check("crc32-x", ~a == 0xcbf43926);
    check("crc32c-x", ~c == 0xe3069283);
    /* "1234" by W, "56" by H, "7" by B, "89" by H */
    u32 w4 = get32((const u8 *)s);
    u64 h56 = (u64)(u8)s[4] | (u64)(u8)s[5] << 8, h89 = (u64)(u8)s[7] | (u64)(u8)s[8] << 8;
    a = crc32h(crc32b(crc32h(crc32w(~0u, w4), h56), (u8)s[6]), h89);
    c = crc32ch(crc32cb(crc32ch(crc32cw(~0u, w4), h56), (u8)s[6]), h89);
    check("crc32-whb", ~a == 0xcbf43926);
    check("crc32c-whb", ~c == 0xe3069283);
}

/* ---- per-form hashes -------------------------------------------------------- */

#define N 200

typedef void (*fn3)(u8 *, const u8 *, const u8 *);
typedef void (*fn2)(u8 *, const u8 *);

static void form3(const char *name, fn3 f) {
    u8 d[16] __attribute__((aligned(16))), n[16] __attribute__((aligned(16))), m[16] __attribute__((aligned(16)));
    for (int i = 0; i < N; i++) {
        fill(d); fill(n); fill(m);
        if (i == 0) { memset(d, 0, 16); memset(n, 0, 16); memset(m, 0, 16); }
        if (i == 1) { memset(d, 0xff, 16); memset(n, 0xff, 16); memset(m, 0xff, 16); }
        f(d, n, m);
        mix16(d);
    }
    report(name);
}
static void form2(const char *name, fn2 f) {
    u8 d[16] __attribute__((aligned(16))), n[16] __attribute__((aligned(16)));
    for (int i = 0; i < N; i++) {
        fill(d); fill(n);
        if (i == 0) { memset(d, 0, 16); memset(n, 0, 16); }
        if (i == 1) { memset(d, 0xff, 16); memset(n, 0xff, 16); }
        f(d, n);
        mix16(d);
    }
    report(name);
}

static void forms(void) {
    form2("aese", aese);
    form2("aesd", aesd);
    form2("aesmc", aesmc);
    form2("aesimc", aesimc);
    form2("aese-dd", aese_same);
    form2("aesmc-dd", aesmc_same);
    form2("aesimc-dd", aesimc_same);
    form3("sha1c", sha1c);
    form3("sha1p", sha1p);
    form3("sha1m", sha1m);
    form3("sha1su0", sha1su0);
    form2("sha1h", sha1h);
    form2("sha1su1", sha1su1);
    form3("sha256h", sha256h);
    form3("sha256h2", sha256h2);
    form3("sha256su1", sha256su1);
    form2("sha256su0", sha256su0);
    form3("sha1c-dd", sha1c_same);
    form3("sha256h-dd", sha256h_same);
    form2("sha1su1-dd", sha1su1_same);

    static const struct { const char *name; u32 (*f)(u32, u64); } crcs[] = {
        { "crc32b", crc32b }, { "crc32h", crc32h }, { "crc32w", crc32w }, { "crc32x", crc32x },
        { "crc32cb", crc32cb }, { "crc32ch", crc32ch }, { "crc32cw", crc32cw }, { "crc32cx", crc32cx },
    };
    for (unsigned k = 0; k < sizeof crcs / sizeof crcs[0]; k++) {
        for (int i = 0; i < N; i++) {
            u64 a = next(), v = next();
            if (i == 0) a = v = 0;
            if (i == 1) a = v = ~0ull;
            mix(crcs[k].f((u32)a, v));
        }
        report(crcs[k].name);
    }
    u32 r;
    __asm__ volatile(EXT "crc32x %w0, wzr, xzr" : "=r"(r)); mix(r);
    __asm__ volatile(EXT "crc32cw %w0, wzr, %w1" : "=r"(r) : "r"(0x12345678u)); mix(r);
    __asm__ volatile(EXT "mov x9, #-1\n\tcrc32cx w9, w9, x9\n\tmov %w0, w9" : "=r"(r) : : "x9"); mix(r);
    report("crc-zr");
}

int main(void) {
    hash = 0xcbf29ce484222325;
    aes_known();
    sha_known();
    crc_known();
    forms();
    printf("cryptotest done, %d failure(s)\n", failures);
    return failures != 0;
}
