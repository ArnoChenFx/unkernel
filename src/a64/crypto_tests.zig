// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Unit tests of crypto.zig (native, `zig build test`): the constant-time
//! AES pieces against core.aes's tables, the carry-less multiply and CRC32
//! against bitwise references, SHA-1/SHA-256/AES known answers through the
//! instruction semantics, and decoding through the run loop: reserved
//! encodings and features disabled with kw_set_isa raise ILLEGAL.

const std = @import("std");
const t = std.testing;
const c = @import("common.zig");
const crypto = @import("crypto.zig");
const core_aes = @import("../cpu/core.zig").aes;
const run_mod = @import("run.zig");
const mach = @import("machine.zig");
const Machine = mach.Machine;

fn bytesOf(v: u128) [16]u8 {
    return @bitCast(v);
}
fn fromBytes(b: [16]u8) u128 {
    return @bitCast(b);
}

test "a64 crypto: bitsliced S-box and inverse match the tables for every byte" {
    for (0..16) |k| {
        var in: [16]u8 = undefined;
        for (0..16) |j| in[j] = @intCast(k * 16 + j);
        const fw = bytesOf(crypto.subBytes(fromBytes(in)));
        const inv = bytesOf(crypto.invSubBytes(fromBytes(in)));
        for (0..16) |j| {
            try t.expectEqual(core_aes.sbox[in[j]], fw[j]);
            try t.expectEqual(core_aes.inv_sbox[in[j]], inv[j]);
        }
    }
}

test "a64 crypto: MixColumns, InvMixColumns, ShiftRows against core.aes" {
    var rng = std.Random.DefaultPrng.init(7);
    const r = rng.random();
    for (0..2000) |_| {
        const v = r.int(u128);
        const cols = c.lanes(u32, v);
        var mc: [4]u32 = undefined;
        var imc: [4]u32 = undefined;
        for (0..4) |i| {
            mc[i] = core_aes.mixColumn(cols[i]);
            imc[i] = core_aes.invMixColumn(cols[i]);
        }
        try t.expectEqual(c.fromLanes(u32, mc), crypto.mixColumns(v));
        try t.expectEqual(c.fromLanes(u32, imc), crypto.invMixColumns(v));
        try t.expectEqual(v, crypto.invMixColumns(crypto.mixColumns(v)));
        // AESE = SubBytes(ShiftRows(d ^ n)), by the definition
        const k = r.int(u128);
        const in = bytesOf(v ^ k);
        var want: [16]u8 = undefined;
        var want_d: [16]u8 = undefined;
        for (0..4) |row| for (0..4) |col| {
            want[row + 4 * col] = core_aes.sbox[in[row + 4 * ((col + row) % 4)]];
            want_d[row + 4 * col] = core_aes.inv_sbox[in[row + 4 * ((col + 4 - row) % 4)]];
        };
        try t.expectEqual(fromBytes(want), crypto.aese(v, k));
        try t.expectEqual(fromBytes(want_d), crypto.aesd(v, k));
    }
}

fn hexBytes(comptime s: []const u8) [s.len / 2]u8 {
    var b: [s.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&b, s) catch unreachable;
    return b;
}

test "a64 crypto: AES-128 FIPS-197 C.1 through AESE/AESMC and AESD/AESIMC" {
    const key = hexBytes("000102030405060708090a0b0c0d0e0f");
    const pt = fromBytes(hexBytes("00112233445566778899aabbccddeeff"));
    const ct = fromBytes(hexBytes("69c4e0d86a7b0430d8cdb78070b4c55a"));
    // key expansion (FIPS-197 5.2) with the table S-box
    var w: [44]u32 = undefined;
    for (0..4) |i| w[i] = std.mem.readInt(u32, key[4 * i ..][0..4], .big);
    for (4..44) |i| {
        var x = w[i - 1];
        if (i % 4 == 0) {
            x = std.math.rotl(u32, x, 8);
            var y: u32 = 0;
            for (0..4) |b| y |= @as(u32, core_aes.sbox[(x >> @intCast(8 * b)) & 0xff]) << @intCast(8 * b);
            x = y ^ (@as(u32, core_aes.rcon[i / 4 - 1]) << 24);
        }
        w[i] = w[i - 4] ^ x;
    }
    var rk: [11]u128 = undefined;
    for (0..11) |i| {
        var b: [16]u8 = undefined;
        for (0..4) |j| std.mem.writeInt(u32, b[4 * j ..][0..4], w[4 * i + j], .big);
        rk[i] = fromBytes(b);
    }
    var s = pt;
    for (0..9) |i| s = crypto.mixColumns(crypto.aese(s, rk[i]));
    s = crypto.aese(s, rk[9]) ^ rk[10];
    try t.expectEqual(ct, s);
    // equivalent inverse cipher: AESD with InvMixColumns'd round keys
    s = ct;
    s = crypto.invMixColumns(crypto.aesd(s, rk[10]));
    var i: usize = 9;
    while (i > 1) : (i -= 1) s = crypto.invMixColumns(crypto.aesd(s, crypto.invMixColumns(rk[i])));
    s = crypto.aesd(s, crypto.invMixColumns(rk[1])) ^ rk[0];
    try t.expectEqual(pt, s);
}

fn clmulRef(a: u64, b: u64) u128 {
    var lo: u64 = 0;
    var hi: u64 = 0;
    for (0..64) |i| if ((b >> @intCast(i)) & 1 != 0) {
        lo ^= a << @intCast(i);
        if (i != 0) hi ^= a >> @intCast(64 - i);
    };
    return c.v128(lo, hi);
}

test "a64 crypto: 64x64 carry-less multiply" {
    var rng = std.Random.DefaultPrng.init(3);
    const r = rng.random();
    const edges = [_]u64{ 0, 1, 2, 0x8000_0000_0000_0000, std.math.maxInt(u64), 0x5555_5555_5555_5555, 0x87 };
    for (edges) |a| for (edges) |b| try t.expectEqual(clmulRef(a, b), crypto.clmul128(a, b));
    for (0..5000) |_| {
        const a = r.int(u64);
        const b = r.int(u64);
        try t.expectEqual(clmulRef(a, b), crypto.clmul128(a, b));
    }
    // pmull64 answers exactly when KW_ISA_PMULL is implemented
    try t.expectEqual(c.implemented & c.featureBit(.pmull) != 0, crypto.pmull64(3, 3) != null);
}

fn crcRef(poly: u32, acc: u32, val: u64, nbits: u32) u32 {
    var x = acc;
    for (0..nbits) |i| {
        x ^= @intCast((val >> @intCast(i)) & 1);
        x = if (x & 1 != 0) (x >> 1) ^ poly else x >> 1;
    }
    return x;
}

test "a64 crypto: CRC32 and CRC32C" {
    var rng = std.Random.DefaultPrng.init(5);
    const r = rng.random();
    for (0..3000) |_| {
        const acc = r.int(u32);
        const val = r.int(u64);
        for (0..4) |sz| {
            const nb: u32 = @as(u32, 8) << @intCast(sz);
            try t.expectEqual(crcRef(crypto.crc32_poly, acc, val, nb), crypto.crcUpdate(crypto.crc32_poly, acc, val, @intCast(sz)));
            try t.expectEqual(crcRef(crypto.crc32c_poly, acc, val, nb), crypto.crcUpdate(crypto.crc32c_poly, acc, val, @intCast(sz)));
        }
    }
    // check values of "123456789" (pre- and post-inverted)
    var a: u32 = 0xffff_ffff;
    var b: u32 = 0xffff_ffff;
    for ("123456789") |ch| {
        a = crypto.crcUpdate(crypto.crc32_poly, a, ch, 0);
        b = crypto.crcUpdate(crypto.crc32c_poly, b, ch, 0);
    }
    try t.expectEqual(@as(u32, 0xcbf4_3926), ~a);
    try t.expectEqual(@as(u32, 0xe306_9283), ~b);
}

// ---- SHA through the instruction semantics -------------------------------------

/// SHA-256 of one padded block, the way OpenSSL's sha256_block_armv8 drives
/// the instructions.
fn sha256Block(state: *[8]u32, block: [64]u8) void {
    const K = [64]u32{
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    };
    var w: [4]u128 = undefined;
    for (0..4) |i| {
        var l: [4]u32 = undefined;
        for (0..4) |j| l[j] = std.mem.readInt(u32, block[16 * i + 4 * j ..][0..4], .big);
        w[i] = c.fromLanes(u32, l);
    }
    var abcd = c.fromLanes(u32, state[0..4].*);
    var efgh = c.fromLanes(u32, state[4..8].*);
    const abcd0 = abcd;
    const efgh0 = efgh;
    for (0..16) |q| {
        const wk = c.fromLanes(u32, @as([4]u32, @bitCast(c.lanes(u32, w[q % 4]) +% @as(@Vector(4, u32), K[4 * q ..][0..4].*))));
        const a2 = abcd;
        abcd = crypto.sha256Hash(abcd, efgh, wk, true);
        efgh = crypto.sha256Hash(a2, efgh, wk, false); // sha256h2 q1, q2, v4.4s: X = Vn, Y = Vd
        if (q < 12) w[q % 4] = crypto.sha256su1(crypto.sha256su0(w[q % 4], w[(q + 1) % 4]), w[(q + 2) % 4], w[(q + 3) % 4]);
    }
    const x = c.lanes(u32, abcd) +% @as(@Vector(4, u32), c.lanes(u32, abcd0));
    const y = c.lanes(u32, efgh) +% @as(@Vector(4, u32), c.lanes(u32, efgh0));
    state[0..4].* = x;
    state[4..8].* = y;
}

fn sha1Block(state: *[5]u32, block: [64]u8) void {
    const K = [4]u32{ 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6 };
    var w: [4]u128 = undefined;
    for (0..4) |i| {
        var l: [4]u32 = undefined;
        for (0..4) |j| l[j] = std.mem.readInt(u32, block[16 * i + 4 * j ..][0..4], .big);
        w[i] = c.fromLanes(u32, l);
    }
    var abcd = c.fromLanes(u32, state[0..4].*);
    var e = state[4];
    for (0..20) |q| {
        const k = K[q / 5];
        const wk = c.fromLanes(u32, @as([4]u32, @bitCast(c.lanes(u32, w[q % 4]) +% @as(@Vector(4, u32), @splat(k)))));
        const e_next = std.math.rotl(u32, c.lane(u32, abcd, 0), 30); // SHA1H
        abcd = switch (q / 5) {
            0 => crypto.sha1Hash(.choose, abcd, e, wk),
            1, 3 => crypto.sha1Hash(.parity, abcd, e, wk),
            else => crypto.sha1Hash(.majority, abcd, e, wk),
        };
        e = e_next;
        if (q < 16) w[q % 4] = crypto.sha1su1(crypto.sha1su0(w[q % 4], w[(q + 1) % 4], w[(q + 2) % 4]), w[(q + 3) % 4]);
    }
    const x = c.lanes(u32, abcd) +% @as(@Vector(4, u32), state[0..4].*);
    state[0..4].* = x;
    state[4] +%= e;
}

fn abcBlock() [64]u8 {
    var b = [_]u8{0} ** 64;
    @memcpy(b[0..3], "abc");
    b[3] = 0x80;
    b[63] = 24;
    return b;
}

/// SHA-512 of one padded 128-byte block, the way OpenSSL's
/// sha512_block_armv8 drives the instructions: state in four 2D registers
/// (ab, cd, ef, gh) and a fifth that rotates through the roles, the
/// message in eight, two rounds per step.
fn sha512Block(state: *[8]u64, block: *const [128]u8) void {
    var msg: [8]u128 = undefined;
    for (0..8) |i| msg[i] = c.v128(std.mem.readInt(u64, block[16 * i ..][0..8], .big), std.mem.readInt(u64, block[16 * i + 8 ..][0..8], .big));
    var h: [5]u128 = .{ c.v128(state[0], state[1]), c.v128(state[2], state[3]), c.v128(state[4], state[5]), c.v128(state[6], state[7]), 0 };
    var hi = [5]usize{ 0, 1, 2, 3, 4 }; // the roles @H[0..4] of OpenSSL's perlasm
    var mi: usize = 0; // msg[(mi + k) % 8] is @MSG[k]
    const saved = h;
    for (0..40) |i| {
        const m0 = &msg[mi % 8];
        const k = sha512_k[2 * i ..][0..2];
        const kw0 = c.lanes(u64, m0.*);
        const kw = c.v128(k[1] +% kw0[1], k[0] +% kw0[0]); // add, then ext #8 (swap halves)
        const h1 = h[hi[1]];
        const h2 = h[hi[2]];
        const h3 = h[hi[3]];
        const v5 = c.v128(c.lanes(u64, h2)[1], c.lanes(u64, h3)[0]); // ext v5, H2, H3, #8
        const v6 = c.v128(c.lanes(u64, h1)[1], c.lanes(u64, h2)[0]); // ext v6, H1, H2, #8
        var t3 = add2(h3, kw);
        if (i < 32) {
            m0.* = crypto.sha512su0(m0.*, msg[(mi + 1) % 8]);
        }
        const v7 = c.v128(c.lanes(u64, msg[(mi + 4) % 8])[1], c.lanes(u64, msg[(mi + 5) % 8])[0]);
        t3 = crypto.sha512h(t3, v5, v6);
        if (i < 32) m0.* = crypto.sha512su1(m0.*, msg[(mi + 7) % 8], v7);
        h[hi[4]] = add2(h1, t3);
        h[hi[3]] = crypto.sha512h2(t3, h1, h[hi[0]]);
        mi += 1;
        const next = [5]usize{ hi[3], hi[0], hi[4], hi[2], hi[1] }; // a temporary: `hi = .{ hi[3], ... }` would alias
        hi = next;
    }
    for (0..4) |j| {
        const r = c.lanes(u64, add2(h[hi[j]], saved[j]));
        state[2 * j] = r[0];
        state[2 * j + 1] = r[1];
    }
}
fn add2(a: u128, b: u128) u128 {
    const x = c.lanes(u64, a);
    const y = c.lanes(u64, b);
    return c.v128(x[0] +% y[0], x[1] +% y[1]);
}
const sha512_k = [80]u64{
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
const sha512_iv = [8]u64{ 0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1, 0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179 };

test "a64 crypto: SHA-512 of \"abc\" and of the two-block FIPS 180 message through the instruction semantics" {
    var st = sha512_iv;
    var b = [_]u8{0} ** 128;
    @memcpy(b[0..3], "abc");
    b[3] = 0x80;
    b[127] = 24;
    sha512Block(&st, &b);
    try t.expectEqual([8]u64{ 0xddaf35a193617aba, 0xcc417349ae204131, 0x12e6fa4e89a97ea2, 0x0a9eeee64b55d39a, 0x2192992a274fc1a8, 0x36ba3c23a3feebbd, 0x454d4423643ce80e, 0x2a9ac94fa54ca49f }, st);
    const msg = "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
    var two = [_]u8{0} ** 256;
    @memcpy(two[0..msg.len], msg);
    two[msg.len] = 0x80;
    two[255] = msg.len * 8 & 0xff;
    two[254] = msg.len * 8 >> 8;
    st = sha512_iv;
    sha512Block(&st, two[0..128]);
    sha512Block(&st, two[128..256]);
    try t.expectEqual([8]u64{ 0x8e959b75dae313da, 0x8cf4f72814fc143f, 0x8f7779c6eb9f7fa1, 0x7299aeadb6889018, 0x501d289e4900f7e4, 0x331b99dec4b5433a, 0xc7d329eeb6dd2654, 0x5e96e55b874be909 }, st);
}

/// Keccak-f[1600] through the SHA3 instruction semantics, the way OpenSSL's
/// ARMv8.2 code uses them (theta's column sums by EOR3, D by RAX1, theta
/// and rho by XAR, chi by BCAX); each lane a 2D value, so lane 0 and lane
/// 1 are two independent states.
fn keccakF(a: *[25]u128) void {
    const rho = [25]u6{ 0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 };
    const rc = [24]u64{
        0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
        0x8000000080008081, 0x8000000000008009, 0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
        0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
        0x000000000000800a, 0x800000008000000a, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    };
    for (0..24) |r| {
        var cs: [5]u128 = undefined;
        for (0..5) |x| cs[x] = crypto.eor3(crypto.eor3(a[x], a[x + 5], a[x + 10]), a[x + 15], a[x + 20]);
        var d: [5]u128 = undefined;
        for (0..5) |x| d[x] = crypto.rax1(cs[(x + 4) % 5], cs[(x + 1) % 5]);
        var b: [25]u128 = undefined;
        for (0..5) |x| for (0..5) |y| {
            b[y + 5 * ((2 * x + 3 * y) % 5)] = crypto.xar(a[x + 5 * y], d[x], 0 -% rho[x + 5 * y]);
        };
        for (0..5) |y| for (0..5) |x| {
            a[x + 5 * y] = crypto.bcax(b[x + 5 * y], b[(x + 2) % 5 + 5 * y], b[(x + 1) % 5 + 5 * y]);
        };
        a[0] ^= c.v128(rc[r], rc[r]);
    }
}

/// One-block sponge in both lanes (lane 0: m0, lane 1: m1): `out` bytes.
fn keccakOne(comptime out: usize, rate: usize, pad: u8, m0: []const u8, m1: []const u8) [2][out]u8 {
    var a = [_]u128{0} ** 25;
    var blk: [2][200]u8 = .{ [_]u8{0} ** 200, [_]u8{0} ** 200 };
    const msgs = [2][]const u8{ m0, m1 };
    for (msgs, 0..) |m, l| {
        @memcpy(blk[l][0..m.len], m);
        blk[l][m.len] ^= pad;
        blk[l][rate - 1] ^= 0x80;
    }
    for (0..rate / 8) |i| a[i] = c.v128(std.mem.readInt(u64, blk[0][8 * i ..][0..8], .little), std.mem.readInt(u64, blk[1][8 * i ..][0..8], .little));
    keccakF(&a);
    var r: [2][out]u8 = undefined;
    for (0..out / 8) |i| for (0..2) |l| std.mem.writeInt(u64, r[l][8 * i ..][0..8], c.lanes(u64, a[i])[l], .little);
    return r;
}

test "a64 crypto: SHA3-256 and SHAKE128 through EOR3, RAX1, XAR, BCAX" {
    const h = keccakOne(32, 136, 0x06, "", "abc");
    var want: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&want, "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
    try t.expectEqual(want, h[0]);
    _ = try std.fmt.hexToBytes(&want, "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532");
    try t.expectEqual(want, h[1]);
    const k = keccakOne(32, 168, 0x1f, "", "");
    _ = try std.fmt.hexToBytes(&want, "7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26");
    try t.expectEqual(want, k[0]);
    // single instructions at edges: RAX1 carries bit 63 round, XAR #0 is EOR
    try t.expectEqual(c.v128(1, 0x8000_0000_0000_0001), crypto.rax1(0, c.v128(0x8000_0000_0000_0000, 0xc000_0000_0000_0000)));
    try t.expectEqual(c.v128(3, 5), crypto.xar(c.v128(1, 4), c.v128(2, 1), 0));
    try t.expectEqual(c.v128(0x8000_0000_0000_0001, 1 << 63), crypto.xar(c.v128(3, 0), c.v128(0, 1), 1));
    try t.expectEqual(@as(u128, 0xf0), crypto.bcax(0xff, 0x0f, 0xf0));
    try t.expectEqual(@as(u128, 0xf0), crypto.bcax(0, 0xff, 0x0f));
    try t.expectEqual(@as(u128, 7), crypto.eor3(1, 2, 4));
}

test "a64 crypto: SHA512 needs SHA2: kw_set_isa, ID_AA64ISAR0_EL1.SHA2" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const mrs_isar0: u32 = 0xd538_0600; // mrs x0, id_aa64isar0_el1
    const sha2 = c.featureBit(.sha2);
    const sha512 = c.featureBit(.sha512);
    const cases = [_]struct { ask: u64, got: u64, field: u64 }{
        .{ .ask = c.implemented, .got = c.implemented, .field = 2 },
        .{ .ask = c.implemented & ~sha512, .got = c.implemented & ~sha512, .field = 1 },
        .{ .ask = c.implemented & ~sha2, .got = c.implemented & ~sha2 & ~sha512, .field = 0 },
        .{ .ask = sha512, .got = 0, .field = 0 },
        .{ .ask = sha2 | sha512, .got = sha2 | sha512, .field = 2 },
    };
    for (cases) |cs| {
        try t.expectEqual(cs.got, run_mod.setIsa(m.cpu, cs.ask));
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), runWord(&m, mrs_isar0));
        try t.expectEqual(cs.field, (m.regs.x[0] >> 12) & 15);
        try t.expectEqual(@as(u32, if (cs.got & sha512 != 0) mach.EV_SYSCALL else mach.EV_ILLEGAL), runWord(&m, 0xce628020));
    }
    _ = run_mod.setIsa(m.cpu, std.math.maxInt(u64));
}

test "a64 crypto: SHA-256 and SHA-1 of \"abc\" through the instruction semantics" {
    var st = [8]u32{ 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
    sha256Block(&st, abcBlock());
    try t.expectEqual([8]u32{ 0xba7816bf, 0x8f01cfea, 0x414140de, 0x5dae2223, 0xb00361a3, 0x96177a9c, 0xb410ff61, 0xf20015ad }, st);
    var s1 = [5]u32{ 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0 };
    sha1Block(&s1, abcBlock());
    try t.expectEqual([5]u32{ 0xa9993e36, 0x4706816a, 0xba3e2571, 0x7850c26c, 0x9cd0d89d }, s1);
}

// ---- decode, gating ------------------------------------------------------------

/// Run one word with v0..v3 and x1, x2 set; returns the event.
fn runWord(m: *Machine, w: u32) u32 {
    m.code(0x10000, &.{ w, mach.svc0 });
    for (0..4) |i| m.regs.v[i] = @as(u128, 0x0123_4567_89ab_cdef_fedc_ba98_7654_3210) +% i;
    m.regs.x[1] = 0xffff_ffff;
    m.regs.x[2] = 0x1234_5678_9abc_def0;
    return m.run(10);
}

test "a64 crypto: implemented features, kw_set_isa, reserved encodings" {
    var m = try Machine.init(t.allocator);
    defer m.deinit();
    const all = c.featureBit(.aes) | c.featureBit(.sha1) | c.featureBit(.sha2) | c.featureBit(.crc32) | c.featureBit(.sha512) | c.featureBit(.sha3);
    try t.expectEqual(all, c.implemented & all);
    try t.expectEqual(c.implemented, m.cpu.priv.a64.isa); // kw_cpu_init enables all
    const Case = struct { w: u32, f: c.Feature };
    const cases = [_]Case{
        .{ .w = 0x4e284820, .f = .aes }, // aese v0.16b, v1.16b
        .{ .w = 0x4e285820, .f = .aes }, // aesd v0.16b, v1.16b
        .{ .w = 0x4e286820, .f = .aes }, // aesmc v0.16b, v1.16b
        .{ .w = 0x4e287820, .f = .aes }, // aesimc v0.16b, v1.16b
        .{ .w = 0x5e020020, .f = .sha1 }, // sha1c q0, s1, v2.4s
        .{ .w = 0x5e021020, .f = .sha1 }, // sha1p q0, s1, v2.4s
        .{ .w = 0x5e022020, .f = .sha1 }, // sha1m q0, s1, v2.4s
        .{ .w = 0x5e023020, .f = .sha1 }, // sha1su0 v0.4s, v1.4s, v2.4s
        .{ .w = 0x5e280820, .f = .sha1 }, // sha1h s0, s1
        .{ .w = 0x5e281820, .f = .sha1 }, // sha1su1 v0.4s, v1.4s
        .{ .w = 0x5e024020, .f = .sha2 }, // sha256h q0, q1, v2.4s
        .{ .w = 0x5e025020, .f = .sha2 }, // sha256h2 q0, q1, v2.4s
        .{ .w = 0x5e026020, .f = .sha2 }, // sha256su1 v0.4s, v1.4s, v2.4s
        .{ .w = 0x5e282820, .f = .sha2 }, // sha256su0 v0.4s, v1.4s
        .{ .w = 0xce628020, .f = .sha512 }, // sha512h q0, q1, v2.2d
        .{ .w = 0xce628420, .f = .sha512 }, // sha512h2 q0, q1, v2.2d
        .{ .w = 0xce628820, .f = .sha512 }, // sha512su1 v0.2d, v1.2d, v2.2d
        .{ .w = 0xcec08020, .f = .sha512 }, // sha512su0 v0.2d, v1.2d
        .{ .w = 0xce020c20, .f = .sha3 }, // eor3 v0.16b, v1.16b, v2.16b, v3.16b
        .{ .w = 0xce220c20, .f = .sha3 }, // bcax v0.16b, v1.16b, v2.16b, v3.16b
        .{ .w = 0xce628c20, .f = .sha3 }, // rax1 v0.2d, v1.2d, v2.2d
        .{ .w = 0xce821c20, .f = .sha3 }, // xar v0.2d, v1.2d, v2.2d, #7
        .{ .w = 0x1ac24020, .f = .crc32 }, // crc32b w0, w1, w2
        .{ .w = 0x1ac24420, .f = .crc32 }, // crc32h w0, w1, w2
        .{ .w = 0x1ac24820, .f = .crc32 }, // crc32w w0, w1, w2
        .{ .w = 0x9ac24c20, .f = .crc32 }, // crc32x w0, w1, x2
        .{ .w = 0x1ac25020, .f = .crc32 }, // crc32cb w0, w1, w2
        .{ .w = 0x1ac25420, .f = .crc32 }, // crc32ch w0, w1, w2
        .{ .w = 0x1ac25820, .f = .crc32 }, // crc32cw w0, w1, w2
        .{ .w = 0x9ac25c20, .f = .crc32 }, // crc32cx w0, w1, x2
    };
    for (cases) |cs| {
        try t.expectEqual(@as(u32, mach.EV_SYSCALL), runWord(&m, cs.w));
        // disabled: ILLEGAL with the raw word, nothing changed
        try t.expectEqual(c.consistentIsa(c.implemented & ~c.featureBit(cs.f)), run_mod.setIsa(m.cpu, ~c.featureBit(cs.f)));
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), runWord(&m, cs.w));
        try t.expectEqual(@as(u64, cs.w), m.cpu.ev.insn);
        try t.expectEqual(@as(u128, 0x0123_4567_89ab_cdef_fedc_ba98_7654_3210), m.regs.v[0]);
        try t.expectEqual(@as(u64, 0x1234_5678_9abc_def0), m.regs.x[2]);
        try t.expectEqual(c.implemented, run_mod.setIsa(m.cpu, std.math.maxInt(u64)));
    }
    // a W result: crc32x of (0xffffffff, x2) zero-extends into x0
    _ = runWord(&m, 0x9ac24c20);
    try t.expectEqual(@as(u64, crypto.crcUpdate(crypto.crc32_poly, 0xffff_ffff, 0x1234_5678_9abc_def0, 3)), m.regs.x[0]);
    // sha1h writes s0 and zeroes the rest
    _ = runWord(&m, 0x5e280820);
    try t.expectEqual(@as(u128, std.math.rotl(u32, 0x7654_3211, 30)), m.regs.v[0]);
    const reserved = [_]u32{
        0x4e684820, // aese with size = 01
        0x4e280820, 0x4e281820, 0x4e283820, 0x4e288820, // AES opcodes 0, 1, 3, 8
        0x5e027020, // three-register SHA opcode 111
        0x5e420020, // sha1c with size = 01
        0x5e283820, 0x5e284820, // two-register SHA opcodes 3, 4
        0x5e680820, // sha1h with size = 01
        0x9ac24020, 0x9ac24820, 0x1ac24c20, 0x1ac25c20, // crc32b/w with sf = 1, crc32x/cx with sf = 0
        0x3ac24020, // crc32b with S = 1
        0x1ac26020, 0x1ac27020, // 2-source opcode 0110xx, 0111xx
        0xce60c020, 0xce60c420, 0xce60c820, 0xce60cc20, // O = 1: SM3PARTW1/2, SM4EKEY, unallocated
        0xce609020, 0xce60a020, // sha512h with bit 12 or 13 set
        0xcec08820, 0xcec08c20, // two-register SHA512 opcodes 10, 11
        0xce420c20, 0xce620c20, // four-register Op0 = 10 (SM3SS1), 11
        0xce028c20, // eor3 with bit 15 set (SM3TT1A space)
        0xce62cc20, // rax1 with O = 1
        0xcec08420, // sm4e v0.4s, v1.4s
    };
    for (reserved) |w| {
        try t.expectEqual(@as(u32, mach.EV_ILLEGAL), runWord(&m, w));
        try t.expectEqual(@as(u64, w), m.cpu.ev.insn);
    }
}
