// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 crypto and CRC32 self-test: AESE, AESD, AESMC, AESIMC, SHA1C/P/M,
 * SHA1H, SHA1SU0/1, SHA256H/H2, SHA256SU0/1, SHA512H/H2, SHA512SU0/1,
 * EOR3, BCAX, RAX1, XAR, CRC32{,C}{B,H,W,X}.
 *
 * Known answers (exit status 1 if one is wrong): AES-128 (FIPS-197 C.1)
 * encryption and decryption with the key expanded through AESE, SHA-1 and
 * SHA-256 of "abc" and of the two-block FIPS 180 message, SHA-512 of
 * "abc" and of its two-block message (OpenSSL's ARMv8.2 round structure),
 * SHA3-256 of "" and "abc" and SHAKE128 of "" (Keccak-f[1600] on EOR3,
 * RAX1, XAR, BCAX), CRC-32 and
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

#define EXT ".arch_extension aes\n\t.arch_extension sha2\n\t.arch_extension sha3\n\t.arch_extension crc\n\t"

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
V3(sha512h, "sha512h q0, q1, v2.2d")
V3(sha512h2, "sha512h2 q0, q1, v2.2d")
V3(sha512su1, "sha512su1 v0.2d, v1.2d, v2.2d")
V2(sha512su0, "sha512su0 v0.2d, v1.2d")
V3(sha512h_same, "sha512h q0, q0, v0.2d")
V3(sha512h2_same, "sha512h2 q0, q0, v0.2d")
V2(sha512su0_same, "sha512su0 v0.2d, v0.2d")
/* d = insn(n, m, a) with v0 = d (overwritten), v1 = n, v2 = m, v3 = a (from d's old value) */
#define V4(fn, insn) static void fn(u8 *d, const u8 *n, const u8 *m) { \
    __asm__ volatile(EXT "ldr q3, [%0]\n\tldr q1, [%1]\n\tldr q2, [%2]\n\t" insn "\n\tstr q0, [%0]" \
        : : "r"(d), "r"(n), "r"(m) : "v0", "v1", "v2", "v3", "memory"); }
V4(eor3, "eor3 v0.16b, v1.16b, v2.16b, v3.16b")
V4(bcax, "bcax v0.16b, v1.16b, v2.16b, v3.16b")
V4(eor3_same, "eor3 v3.16b, v3.16b, v3.16b, v1.16b\n\tmov v0.16b, v3.16b")
V4(bcax_same, "bcax v3.16b, v1.16b, v3.16b, v3.16b\n\tmov v0.16b, v3.16b")
V3(rax1, "rax1 v0.2d, v1.2d, v2.2d")
V3(rax1_same, "rax1 v0.2d, v0.2d, v0.2d")
V3(xar0, "xar v0.2d, v1.2d, v2.2d, #0")
V3(xar1, "xar v0.2d, v1.2d, v2.2d, #1")
V3(xar37, "xar v0.2d, v1.2d, v2.2d, #37")
V3(xar63, "xar v0.2d, v1.2d, v2.2d, #63")
V3(xar_same, "xar v0.2d, v0.2d, v2.2d, #13")

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

/*
 * SHA-512 of one 128-byte block, driven the way OpenSSL's
 * sha512_block_armv8 does: the state in four 2D registers (ab, cd, ef, gh)
 * and a fifth that rotates through the roles, two rounds per step.
 */
static const u64 K512[80] = {
    0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc, 0x3956c25bf348b538, 0x59f111f1b605d019,
    0x923f82a4af194f9b, 0xab1c5ed5da6d8118, 0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
    0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694, 0xe49b69c19ef14ad2, 0xefbe4786384f25e3,
    0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65, 0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
    0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4, 0xc6e00bf33da88fc2, 0xd5a79147930aa725,
    0x06ca6351e003826f, 0x142929670a0e6e70, 0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
    0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b, 0xa2bfe8a14cf10364, 0xa81a664bbc423001,
    0xc24b8b70d0f89791, 0xc76c51a30654be30, 0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
    0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8, 0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb,
    0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3, 0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
    0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b, 0xca273eceea26619c, 0xd186b8c721c0c207,
    0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178, 0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
    0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c, 0x4cc5d4becb3e42b6, 0x597f299cfc657e2a,
    0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
};
typedef struct { u64 v[2]; } __attribute__((aligned(16))) q128;
static q128 q2(u64 lo, u64 hi) { q128 r = { { lo, hi } }; return r; }
static q128 qadd(q128 a, q128 b) { return q2(a.v[0] + b.v[0], a.v[1] + b.v[1]); }
static q128 qext8(q128 n, q128 m) { return q2(n.v[1], m.v[0]); } /* ext vd.16b, vn.16b, vm.16b, #8 */
static u64 be64(const u8 *p) { u64 v = 0; for (int i = 0; i < 8; i++) v = v << 8 | p[i]; return v; }

static void sha512_block(u64 st[8], const u8 *blk) {
    q128 msg[8], h[5], saved[4];
    int hi[5] = { 0, 1, 2, 3, 4 };
    for (int i = 0; i < 8; i++) msg[i] = q2(be64(blk + 16 * i), be64(blk + 16 * i + 8));
    for (int i = 0; i < 4; i++) saved[i] = h[i] = q2(st[2 * i], st[2 * i + 1]);
    for (int i = 0; i < 40; i++) {
        q128 *m0 = &msg[i % 8];
        q128 kw = qadd(*m0, q2(K512[2 * i], K512[2 * i + 1]));
        kw = qext8(kw, kw);
        q128 v5 = qext8(h[hi[2]], h[hi[3]]), v6 = qext8(h[hi[1]], h[hi[2]]);
        q128 t3 = qadd(h[hi[3]], kw);
        if (i < 32) sha512su0((u8 *)m0, (u8 *)&msg[(i + 1) % 8]);
        q128 v7 = qext8(msg[(i + 4) % 8], msg[(i + 5) % 8]);
        sha512h((u8 *)&t3, (u8 *)&v5, (u8 *)&v6);
        if (i < 32) sha512su1((u8 *)m0, (u8 *)&msg[(i + 7) % 8], (u8 *)&v7);
        h[hi[4]] = qadd(h[hi[1]], t3);
        sha512h2((u8 *)&t3, (u8 *)&h[hi[1]], (u8 *)&h[hi[0]]);
        h[hi[3]] = t3;
        int n[5] = { hi[3], hi[0], hi[4], hi[2], hi[1] };
        memcpy(hi, n, sizeof n);
    }
    for (int i = 0; i < 4; i++) {
        q128 r = qadd(h[hi[i]], saved[i]);
        st[2 * i] = r.v[0];
        st[2 * i + 1] = r.v[1];
    }
}

static void sha512_known(void) {
    static const char *msgs[2] = { "abc", "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu" };
    static const u64 want[2][8] = {
        { 0xddaf35a193617aba, 0xcc417349ae204131, 0x12e6fa4e89a97ea2, 0x0a9eeee64b55d39a, 0x2192992a274fc1a8, 0x36ba3c23a3feebbd, 0x454d4423643ce80e, 0x2a9ac94fa54ca49f },
        { 0x8e959b75dae313da, 0x8cf4f72814fc143f, 0x8f7779c6eb9f7fa1, 0x7299aeadb6889018, 0x501d289e4900f7e4, 0x331b99dec4b5433a, 0xc7d329eeb6dd2654, 0x5e96e55b874be909 },
    };
    for (int m = 0; m < 2; m++) {
        u8 buf[256];
        size_t n = strlen(msgs[m]);
        int blocks = n < 112 ? 1 : 2;
        memset(buf, 0, sizeof buf);
        memcpy(buf, msgs[m], n);
        buf[n] = 0x80;
        for (int i = 0; i < 8; i++) buf[128 * blocks - 1 - i] = (u8)((u64)n * 8 >> (8 * i));
        u64 s[8] = { 0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
                     0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179 };
        for (int b = 0; b < blocks; b++) sha512_block(s, buf + 128 * b);
        check(m ? "sha512-2b" : "sha512-abc", memcmp(s, want[m], sizeof s) == 0);
    }
}

/*
 * Keccak-f[1600] on the SHA3 instructions, the way OpenSSL's ARMv8.2 path
 * (KeccakF1600_ce) uses them: theta's column sums by EOR3, D by RAX1, rho
 * by XAR, chi by BCAX. Each of the 25 lanes is a 2D register, so lane 0
 * and lane 1 of the vectors are two independent states.
 */
typedef struct { u64 v[2]; } __attribute__((aligned(16))) kq;
#define K_EXT ".arch_extension sha3\n\t"
static void k_eor3(kq *d, const kq *n, const kq *m, const kq *a) {
    __asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\tldr q3, [%3]\n\teor3 v0.16b, v1.16b, v2.16b, v3.16b\n\tstr q0, [%0]"
        : : "r"(d), "r"(n), "r"(m), "r"(a) : "v0", "v1", "v2", "v3", "memory");
}
static void k_bcax(kq *d, const kq *n, const kq *m, const kq *a) {
    __asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\tldr q3, [%3]\n\tbcax v0.16b, v1.16b, v2.16b, v3.16b\n\tstr q0, [%0]"
        : : "r"(d), "r"(n), "r"(m), "r"(a) : "v0", "v1", "v2", "v3", "memory");
}
static void k_rax1(kq *d, const kq *n, const kq *m) {
    __asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\trax1 v0.2d, v1.2d, v2.2d\n\tstr q0, [%0]"
        : : "r"(d), "r"(n), "r"(m) : "v0", "v1", "v2", "memory");
}
#define K_XAR1(k) case k: __asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\txar v0.2d, v1.2d, v2.2d, %3\n\tstr q0, [%0]" \
        : : "r"(d), "r"(n), "r"(m), "i"(k) : "v0", "v1", "v2", "memory"); break;
#define K_XAR8(k) K_XAR1(k) K_XAR1(k + 1) K_XAR1(k + 2) K_XAR1(k + 3) K_XAR1(k + 4) K_XAR1(k + 5) K_XAR1(k + 6) K_XAR1(k + 7)
static void k_xar(kq *d, const kq *n, const kq *m, int imm) {
    switch (imm) { K_XAR8(0) K_XAR8(8) K_XAR8(16) K_XAR8(24) K_XAR8(32) K_XAR8(40) K_XAR8(48) K_XAR8(56) }
}

static const u64 keccak_rc[24] = {
    0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
    0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800a, 0x800000008000000a, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
};
/* rotation of lane x + 5y */
static const int keccak_rho[25] = { 0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 };

static void keccak_f(kq a[25]) {
    kq c[5], d[5], b[25];
    for (int r = 0; r < 24; r++) {
        for (int x = 0; x < 5; x++) {
            k_eor3(&c[x], &a[x], &a[x + 5], &a[x + 10]);
            k_eor3(&c[x], &c[x], &a[x + 15], &a[x + 20]);
        }
        for (int x = 0; x < 5; x++) k_rax1(&d[x], &c[(x + 4) % 5], &c[(x + 1) % 5]);
        /* theta and rho by XAR (rotate right by 64 - r), pi by where it goes */
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++)
                k_xar(&b[y + 5 * ((2 * x + 3 * y) % 5)], &a[x + 5 * y], &d[x], (64 - keccak_rho[x + 5 * y]) & 63);
        for (int y = 0; y < 5; y++)
            for (int x = 0; x < 5; x++)
                k_bcax(&a[x + 5 * y], &b[x + 5 * y], &b[(x + 2) % 5 + 5 * y], &b[(x + 1) % 5 + 5 * y]);
        a[0].v[0] ^= keccak_rc[r];
        a[0].v[1] ^= keccak_rc[r];
    }
}

/* One-block sponge (message < rate) in both lanes: msg0 in lane 0, msg1 in lane 1. */
static void keccak_one(u8 *out0, u8 *out1, int outlen, int rate, u8 pad, const char *msg0, const char *msg1) {
    kq a[25];
    u8 blk[2][200];
    const char *msg[2] = { msg0, msg1 };
    memset(a, 0, sizeof a);
    for (int l = 0; l < 2; l++) {
        size_t n = strlen(msg[l]);
        memset(blk[l], 0, sizeof blk[l]);
        memcpy(blk[l], msg[l], n);
        blk[l][n] ^= pad;
        blk[l][rate - 1] ^= 0x80;
        for (int i = 0; i < rate / 8; i++) { u64 w; memcpy(&w, blk[l] + 8 * i, 8); a[i].v[l] ^= w; }
    }
    keccak_f(a);
    for (int i = 0; i < outlen / 8; i++) { memcpy(out0 + 8 * i, &a[i].v[0], 8); memcpy(out1 + 8 * i, &a[i].v[1], 8); }
}

static void sha3_known(void) {
    static const u8 sha3_empty[32] = { 0xa7, 0xff, 0xc6, 0xf8, 0xbf, 0x1e, 0xd7, 0x66, 0x51, 0xc1, 0x47, 0x56, 0xa0, 0x61, 0xd6, 0x62,
                                       0xf5, 0x80, 0xff, 0x4d, 0xe4, 0x3b, 0x49, 0xfa, 0x82, 0xd8, 0x0a, 0x4b, 0x80, 0xf8, 0x43, 0x4a };
    static const u8 sha3_abc[32] = { 0x3a, 0x98, 0x5d, 0xa7, 0x4f, 0xe2, 0x25, 0xb2, 0x04, 0x5c, 0x17, 0x2d, 0x6b, 0xd3, 0x90, 0xbd,
                                     0x85, 0x5f, 0x08, 0x6e, 0x3e, 0x9d, 0x52, 0x5b, 0x46, 0xbf, 0xe2, 0x45, 0x11, 0x43, 0x15, 0x32 };
    static const u8 shake_empty[32] = { 0x7f, 0x9c, 0x2b, 0xa4, 0xe8, 0x8f, 0x82, 0x7d, 0x61, 0x60, 0x45, 0x50, 0x76, 0x05, 0x85, 0x3e,
                                        0xd7, 0x3b, 0x80, 0x93, 0xf6, 0xef, 0xbc, 0x88, 0xeb, 0x1a, 0x6e, 0xac, 0xfa, 0x66, 0xef, 0x26 };
    u8 a[32], b[32];
    keccak_one(a, b, 32, 136, 0x06, "", "abc");
    check("sha3-empty", memcmp(a, sha3_empty, 32) == 0);
    check("sha3-abc", memcmp(b, sha3_abc, 32) == 0);
    keccak_one(a, b, 32, 168, 0x1f, "", "");
    check("shake128", memcmp(a, shake_empty, 32) == 0 && memcmp(b, shake_empty, 32) == 0);
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
    form3("sha512h", sha512h);
    form3("sha512h2", sha512h2);
    form3("sha512su1", sha512su1);
    form2("sha512su0", sha512su0);
    form3("sha512h-dd", sha512h_same);
    form3("sha512h2-dd", sha512h2_same);
    form2("sha512su0-dd", sha512su0_same);
    form3("eor3", eor3);
    form3("bcax", bcax);
    form3("eor3-dd", eor3_same);
    form3("bcax-dd", bcax_same);
    form3("rax1", rax1);
    form3("rax1-dd", rax1_same);
    form3("xar0", xar0);
    form3("xar1", xar1);
    form3("xar37", xar37);
    form3("xar63", xar63);
    form3("xar-dd", xar_same);

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
    sha512_known();
    sha3_known();
    crc_known();
    forms();
    printf("cryptotest done, %d failure(s)\n", failures);
    return failures != 0;
}
