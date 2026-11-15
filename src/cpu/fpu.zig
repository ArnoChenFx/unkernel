// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! RISC-V F/D arithmetic with exact rounding modes and exception flags.
//!
//! Every operation has an integer ("softfloat") implementation that is exact
//! for all five rounding modes and all five flags, with RISC-V semantics:
//! tininess detected after rounding, canonical NaN results, no NaN payload
//! propagation, fmin/fmax per the 2.2+ spec (minimumNumber, -0 < +0).
//!
//! Round-to-nearest-even (the case real code runs in) takes a fast path
//! through host IEEE f32/f64 ops (wasm and x86-64 SSE are both strict RNE)
//! when the result is a normal number away from the overflow/underflow
//! boundaries; the inexact flag is then derived exactly (TwoSum for add,
//! odd-significand tests for mul/div/sqrt, f64-exact products for f32).
//! Anything else (NaN/inf/zero/subnormal/overflow results, directed rounding,
//! f64 fma) uses the integer path. No i128 arithmetic is used, so freestanding
//! wasm builds need no compiler-rt helpers.

const std = @import("std");
const builtin = @import("builtin");

pub const NV: u32 = 0x10;
pub const DZ: u32 = 0x08;
pub const OF: u32 = 0x04;
pub const UF: u32 = 0x02;
pub const NX: u32 = 0x01;

pub const RNE: u32 = 0;
pub const RTZ: u32 = 1;
pub const RDN: u32 = 2;
pub const RUP: u32 = 3;
pub const RMM: u32 = 4;

// ---- 128-bit helpers (hi:lo pairs) -------------------------------------------

pub const W = struct { hi: u64, lo: u64 };

const use_native_u128 = !builtin.cpu.arch.isWasm();

/// Full 64x64 -> 128-bit unsigned product.
pub inline fn mul64(a: u64, b: u64) W {
    if (use_native_u128) {
        const p = @as(u128, a) * @as(u128, b);
        return .{ .hi = @truncate(p >> 64), .lo = @truncate(p) };
    }
    const a0 = a & 0xffff_ffff;
    const a1 = a >> 32;
    const b0 = b & 0xffff_ffff;
    const b1 = b >> 32;
    const p00 = a0 * b0;
    const p01 = a0 * b1;
    const p10 = a1 * b0;
    const p11 = a1 * b1;
    const mid = (p00 >> 32) + (p01 & 0xffff_ffff) + (p10 & 0xffff_ffff);
    return .{
        .hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32),
        .lo = (mid << 32) | (p00 & 0xffff_ffff),
    };
}

/// High 64 bits of signed x signed.
pub fn mulh(a: u64, b: u64) u64 {
    var hi = mul64(a, b).hi;
    if (@as(i64, @bitCast(a)) < 0) hi -%= b;
    if (@as(i64, @bitCast(b)) < 0) hi -%= a;
    return hi;
}
/// High 64 bits of signed a x unsigned b.
pub fn mulhsu(a: u64, b: u64) u64 {
    var hi = mul64(a, b).hi;
    if (@as(i64, @bitCast(a)) < 0) hi -%= b;
    return hi;
}

fn shrJam(x: u64, n: u32) u64 {
    if (n == 0) return x;
    if (n >= 64) return @intFromBool(x != 0);
    return (x >> @intCast(n)) | @intFromBool((x << @intCast(64 - n)) != 0);
}

fn shrJam128(x: W, n: u32) W {
    if (n == 0) return x;
    if (n < 64) {
        const s: u6 = @intCast(n);
        const t: u6 = @intCast(64 - n);
        return .{ .hi = x.hi >> s, .lo = (x.lo >> s) | (x.hi << t) | @intFromBool((x.lo << t) != 0) };
    }
    if (n < 128) {
        const lo = if (n == 64) x.hi else x.hi >> @intCast(n - 64);
        const lost_hi = if (n == 64) false else (x.hi << @intCast(128 - n)) != 0;
        return .{ .hi = 0, .lo = lo | @intFromBool(x.lo != 0 or lost_hi) };
    }
    return .{ .hi = 0, .lo = @intFromBool((x.hi | x.lo) != 0) };
}

inline fn add128(a: W, b: W) W {
    const lo = a.lo +% b.lo;
    return .{ .hi = a.hi +% b.hi +% @intFromBool(lo < a.lo), .lo = lo };
}
inline fn sub128(a: W, b: W) W {
    return .{ .hi = a.hi -% b.hi -% @intFromBool(a.lo < b.lo), .lo = a.lo -% b.lo };
}
inline fn lt128(a: W, b: W) bool {
    return a.hi < b.hi or (a.hi == b.hi and a.lo < b.lo);
}
fn shl128(x: W, n: u32) W {
    if (n == 0) return x;
    if (n >= 128) return .{ .hi = 0, .lo = 0 };
    if (n >= 64) return .{ .hi = x.lo << @intCast(n - 64), .lo = 0 };
    return .{ .hi = (x.hi << @intCast(n)) | (x.lo >> @intCast(64 - n)), .lo = x.lo << @intCast(n) };
}

inline fn roundInc(rm: u32, neg: bool, lsb: u64, rem: u64, half: u64) bool {
    return switch (rm) {
        RNE => rem > half or (rem == half and lsb & 1 != 0),
        RTZ => false,
        RDN => neg and rem != 0,
        RUP => !neg and rem != 0,
        else => rem >= half, // RMM
    };
}

// ---- format-generic implementation ---------------------------------------------

pub fn Fmt(comptime B: type) type {
    return struct {
        pub const H = switch (B) {
            u16 => f16,
            u32 => f32,
            else => f64,
        };
        pub const nbits = @bitSizeOf(B);
        pub const mb = switch (B) {
            u16 => 10,
            u32 => 23,
            else => 52,
        };
        const eb = nbits - 1 - mb;
        const bias: i32 = (1 << (eb - 1)) - 1;
        pub const emaxf: B = (1 << eb) - 1;
        pub const sign: B = @as(B, 1) << (nbits - 1);
        const mmask: B = (@as(B, 1) << mb) - 1;
        pub const inf: B = emaxf << mb;
        pub const qnan: B = inf | (@as(B, 1) << (mb - 1));
        const extra = 62 - mb; // low bits dropped from a 63-bit significand
        const half: u64 = @as(u64, 1) << (extra - 1);

        inline fn expf(x: B) B {
            return (x >> mb) & emaxf;
        }
        pub inline fn isNan(x: B) bool {
            return (x & ~sign) > inf;
        }
        pub inline fn isSnan(x: B) bool {
            return isNan(x) and x & (@as(B, 1) << (mb - 1)) == 0;
        }
        inline fn isInf(x: B) bool {
            return (x & ~sign) == inf;
        }
        inline fn isZero(x: B) bool {
            return (x & ~sign) == 0;
        }
        inline fn neg(x: B) bool {
            return x >> (nbits - 1) != 0;
        }
        inline fn h(x: B) H {
            return @bitCast(x);
        }
        inline fn rmZeroSign(rm: u32) B {
            return if (rm == RDN) sign else 0;
        }

        /// value = m / 2^62 * 2^e with m in [2^62, 2^63); x finite, non-zero.
        const Un = struct { s: bool, e: i32, m: u64 };
        fn unpack(x: B) Un {
            const ef = expf(x);
            const m: u64 = x & mmask;
            if (ef == 0) {
                const k: u6 = @intCast(@clz(m) - 1);
                return .{ .s = neg(x), .e = 1 - bias - mb + 62 - @as(i32, k), .m = m << k };
            }
            return .{ .s = neg(x), .e = @as(i32, @intCast(ef)) - bias, .m = (m | (@as(u64, 1) << mb)) << extra };
        }

        /// Odd part of the integer significand (x finite, non-zero).
        inline fn oddSig(x: B) u64 {
            var m: u64 = x & mmask;
            if (expf(x) != 0) m |= @as(u64, 1) << mb;
            return m >> @intCast(@ctz(m));
        }
        inline fn bitLen(v: u64) u32 {
            return 64 - @as(u32, @clz(v));
        }

        fn overflow(s: bool, rm: u32, fl: *u32) B {
            fl.* |= OF | NX;
            const to_inf = switch (rm) {
                RNE, RMM => true,
                RUP => !s,
                RDN => s,
                else => false,
            };
            return (if (s) sign else 0) | (if (to_inf) inf else inf - 1);
        }

        /// Round and pack m/2^62 * 2^e (m normalized, sticky folded into bit 0).
        pub fn roundPack(s: bool, e: i32, m: u64, rm: u32, fl: *u32) B {
            const sb: B = if (s) sign else 0;
            const rmask: u64 = (@as(u64, 1) << extra) - 1;
            var biased: i32 = e + bias;
            if (biased >= 1) {
                var q = m >> extra;
                const rem = m & rmask;
                if (roundInc(rm, s, q, rem, half)) q += 1;
                if (q >> (mb + 1) != 0) {
                    q >>= 1;
                    biased += 1;
                }
                if (biased >= emaxf) return overflow(s, rm, fl);
                if (rem != 0) fl.* |= NX;
                return sb | (@as(B, @intCast(biased)) << mb) | (@as(B, @truncate(q)) & mmask);
            }
            // Subnormal range. Tininess is detected after rounding: the value is
            // not tiny only if rounding to full precision reaches 2^emin.
            var tiny = true;
            if (biased == 0) {
                const q = m >> extra;
                const inc: u64 = @intFromBool(roundInc(rm, s, q, m & rmask, half));
                if ((q + inc) >> (mb + 1) != 0) tiny = false;
            }
            const m2 = shrJam(m, @intCast(1 - biased));
            var q = m2 >> extra;
            const rem = m2 & rmask;
            if (roundInc(rm, s, q, rem, half)) q += 1;
            if (rem != 0) {
                fl.* |= NX;
                if (tiny) fl.* |= UF;
            }
            return sb | @as(B, @intCast(q)); // q == 2^mb carries into the exponent
        }

        // ---- add / sub ------------------------------------------------------

        pub fn add(a: B, b: B, rm: u32, fl: *u32) B {
            if (rm == RNE) {
                if (B == u64) {
                    const x = h(a);
                    const y = h(b);
                    const r = x + y;
                    const rb: B = @bitCast(r);
                    const ef = expf(rb);
                    if (ef >= 2 and ef < emaxf - 1) {
                        const bv = r - x;
                        const av = r - bv;
                        const err = (x - av) + (y - bv);
                        if (err != 0) fl.* |= NX;
                        return rb;
                    }
                } else {
                    const x: f64 = h(a);
                    const y: f64 = h(b);
                    const r = x + y;
                    const r32: f32 = @floatCast(r);
                    const rb: B = @bitCast(r32);
                    const ef = expf(rb);
                    if (ef >= 2 and ef < emaxf - 1) {
                        const bv = r - x;
                        const av = r - bv;
                        const err = (x - av) + (y - bv);
                        if (err != 0 or @as(f64, r32) != r) fl.* |= NX;
                        return rb;
                    }
                }
            }
            return addSlow(a, b, rm, fl);
        }

        fn addSlow(a: B, b: B, rm: u32, fl: *u32) B {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return qnan;
            }
            if (isInf(a)) {
                if (isInf(b) and neg(a) != neg(b)) {
                    fl.* |= NV;
                    return qnan;
                }
                return a;
            }
            if (isInf(b)) return b;
            if (isZero(a)) {
                if (isZero(b)) return if (neg(a) == neg(b)) a else rmZeroSign(rm);
                return b;
            }
            if (isZero(b)) return a;
            var ua = unpack(a);
            var ub = unpack(b);
            if (ub.e > ua.e or (ub.e == ua.e and ub.m > ua.m)) std.mem.swap(Un, &ua, &ub);
            const mbj = shrJam(ub.m, @intCast(ua.e - ub.e));
            if (ua.s == ub.s) {
                var m = ua.m + mbj;
                var e = ua.e;
                if (m >> 63 != 0) {
                    m = (m >> 1) | (m & 1);
                    e += 1;
                }
                return roundPack(ua.s, e, m, rm, fl);
            }
            var m = ua.m - mbj;
            if (m == 0) return rmZeroSign(rm);
            const lz: u6 = @intCast(@clz(m) - 1);
            m <<= lz;
            return roundPack(ua.s, ua.e - lz, m, rm, fl);
        }

        pub fn sub(a: B, b: B, rm: u32, fl: *u32) B {
            return add(a, b ^ sign, rm, fl);
        }

        // ---- mul ------------------------------------------------------------

        pub fn mul(a: B, b: B, rm: u32, fl: *u32) B {
            if (rm == RNE) {
                if (B == u64) {
                    const rb: B = @bitCast(h(a) * h(b));
                    const ef = expf(rb);
                    if (ef >= 2 and ef < emaxf - 1) {
                        // Exact iff the product of the odd significands fits in 53 bits.
                        const oa = oddSig(a);
                        const ob = oddSig(b);
                        const n = bitLen(oa) + bitLen(ob);
                        const exact = n <= mb + 1 or (n == mb + 2 and oa * ob < (@as(u64, 1) << (mb + 1)));
                        if (!exact) fl.* |= NX;
                        return rb;
                    }
                } else {
                    const r = @as(f64, h(a)) * @as(f64, h(b)); // exact
                    const r32: f32 = @floatCast(r);
                    const rb: B = @bitCast(r32);
                    const ef = expf(rb);
                    if (ef >= 2 and ef < emaxf - 1) {
                        if (@as(f64, r32) != r) fl.* |= NX;
                        return rb;
                    }
                }
            }
            return mulSlow(a, b, rm, fl);
        }

        fn mulSlow(a: B, b: B, rm: u32, fl: *u32) B {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return qnan;
            }
            const s = neg(a) != neg(b);
            const sb: B = if (s) sign else 0;
            if (isInf(a) or isInf(b)) {
                if (isZero(a) or isZero(b)) {
                    fl.* |= NV;
                    return qnan;
                }
                return sb | inf;
            }
            if (isZero(a) or isZero(b)) return sb;
            return mulCore(s, unpack(a), unpack(b), rm, fl);
        }

        fn mulCore(s: bool, ua: Un, ub: Un, rm: u32, fl: *u32) B {
            const p = mul64(ua.m, ub.m); // [2^124, 2^126)
            var e = ua.e + ub.e;
            var m: u64 = undefined;
            if (p.hi >> 61 != 0) {
                m = (p.hi << 1) | (p.lo >> 63) | @intFromBool((p.lo << 1) != 0);
                e += 1;
            } else {
                m = (p.hi << 2) | (p.lo >> 62) | @intFromBool((p.lo << 2) != 0);
            }
            return roundPack(s, e, m, rm, fl);
        }

        // ---- div ------------------------------------------------------------

        pub fn div(a: B, b: B, rm: u32, fl: *u32) B {
            if (rm == RNE) {
                if (B == u64) {
                    const rb: B = @bitCast(h(a) / h(b));
                    const ef = expf(rb);
                    if (ef >= 2 and ef < emaxf - 1) {
                        // a/b = (oa/ob) * 2^k is exact iff ob divides oa (ob odd).
                        if (oddSig(a) % oddSig(b) != 0) fl.* |= NX;
                        return rb;
                    }
                } else {
                    const x: f64 = h(a);
                    const y: f64 = h(b);
                    const r32: f32 = @floatCast(x / y);
                    const rb: B = @bitCast(r32);
                    const ef = expf(rb);
                    if (ef >= 2 and ef < emaxf - 1) {
                        if (@as(f64, r32) * y != x) fl.* |= NX; // product exact in f64
                        return rb;
                    }
                }
            }
            return divSlow(a, b, rm, fl);
        }

        fn divSlow(a: B, b: B, rm: u32, fl: *u32) B {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return qnan;
            }
            const s = neg(a) != neg(b);
            const sb: B = if (s) sign else 0;
            if (isInf(a)) {
                if (isInf(b)) {
                    fl.* |= NV;
                    return qnan;
                }
                return sb | inf;
            }
            if (isInf(b)) return sb;
            if (isZero(b)) {
                if (isZero(a)) {
                    fl.* |= NV;
                    return qnan;
                }
                fl.* |= DZ;
                return sb | inf;
            }
            if (isZero(a)) return sb;
            const ua = unpack(a);
            const ub = unpack(b);
            var e = ua.e - ub.e;
            var x = ua.m;
            const d = ub.m;
            if (x < d) {
                x <<= 1;
                e -= 1;
            }
            var q: u64 = 1;
            var r = x - d;
            var i: u32 = 0;
            while (i < 62) : (i += 1) {
                r <<= 1;
                q <<= 1;
                if (r >= d) {
                    r -= d;
                    q |= 1;
                }
            }
            return roundPack(s, e, q | @intFromBool(r != 0), rm, fl);
        }

        // ---- sqrt -----------------------------------------------------------

        pub fn sqrt(a: B, rm: u32, fl: *u32) B {
            if (isNan(a)) {
                if (isSnan(a)) fl.* |= NV;
                return qnan;
            }
            if (isZero(a)) return a;
            if (neg(a)) {
                fl.* |= NV;
                return qnan;
            }
            if (isInf(a)) return a;
            const rb: B = @bitCast(@sqrt(h(a))); // correctly rounded (RNE), always normal
            const or_ = oddSig(rb);
            const exact = bitLen(or_) <= (mb + 2) / 2 and or_ * or_ == oddSig(a);
            if (exact) return rb;
            fl.* |= NX;
            if (rm == RNE or rm == RMM) return rb; // sqrt never lands on a tie
            // Directed rounding: find which side of sqrt(a) the RNE result is on
            // by comparing rb^2 with a exactly.
            const ur = unpack(rb);
            const ua = unpack(a);
            const p = mul64(ur.m, ur.m); // rb^2 = p / 2^124 * 2^(2 e_r)
            const k = ua.e - 2 * ur.e; // a = (m_a << 62) / 2^124 * 2^(2 e_r + k)
            const q = shl128(.{ .hi = 0, .lo = ua.m }, @intCast(62 + k));
            const above = lt128(q, p);
            return switch (rm) {
                RUP => if (above) rb else rb + 1,
                else => if (above) rb - 1 else rb, // RTZ, RDN (result positive)
            };
        }

        // ---- fused multiply-add: a*b + c --------------------------------------

        pub fn fma(a: B, b: B, c: B, rm: u32, fl: *u32) B {
            const inf_times_zero = (isInf(a) and isZero(b)) or (isZero(a) and isInf(b));
            if (isNan(a) or isNan(b) or isNan(c)) {
                if (isSnan(a) or isSnan(b) or isSnan(c) or inf_times_zero) fl.* |= NV;
                return qnan;
            }
            if (inf_times_zero) {
                fl.* |= NV;
                return qnan;
            }
            const ps = neg(a) != neg(b);
            const psb: B = if (ps) sign else 0;
            if (isInf(a) or isInf(b)) {
                if (isInf(c) and neg(c) != ps) {
                    fl.* |= NV;
                    return qnan;
                }
                return psb | inf;
            }
            if (isInf(c)) return c;
            if (isZero(a) or isZero(b)) {
                if (isZero(c)) return if (neg(c) == ps) c else rmZeroSign(rm);
                return c;
            }
            if (B == u32 and rm == RNE) {
                if (fma32Fast(a, b, c, fl)) |r| return r;
            }
            if (B == u64 and rm == RNE) {
                if (fma64Fast(a, b, c, fl)) |r| return r;
            }
            return fmaSlow(a, b, c, rm, fl);
        }

        /// The integer fma path for finite non-zero a, b (c finite).
        fn fmaSlow(a: B, b: B, c: B, rm: u32, fl: *u32) B {
            const ps = neg(a) != neg(b);
            const ua = unpack(a);
            const ub = unpack(b);
            if (isZero(c)) return mulCore(ps, ua, ub, rm, fl);
            const uc = unpack(c);
            var p = mul64(ua.m, ub.m); // p / 2^124 * 2^(ea+eb)
            var cc: W = .{ .hi = uc.m >> 2, .lo = uc.m << 62 }; // cc / 2^124 * 2^ec
            const ep = ua.e + ub.e;
            var e: i32 = undefined;
            if (ep >= uc.e) {
                cc = shrJam128(cc, @intCast(ep - uc.e));
                e = ep;
            } else {
                p = shrJam128(p, @intCast(uc.e - ep));
                e = uc.e;
            }
            var s: bool = undefined;
            var sum: W = undefined;
            if (ps == uc.s) {
                sum = add128(p, cc);
                s = ps;
            } else if (lt128(p, cc)) {
                sum = sub128(cc, p);
                s = uc.s;
            } else {
                sum = sub128(p, cc);
                s = ps;
                if (sum.hi == 0 and sum.lo == 0) return rmZeroSign(rm);
            }
            const lead: i32 = if (sum.hi != 0) 127 - @as(i32, @clz(sum.hi)) else 63 - @as(i32, @clz(sum.lo));
            const m: u64 = if (lead >= 62) shrJam128(sum, @intCast(lead - 62)).lo else sum.lo << @intCast(62 - lead);
            return roundPack(s, e + lead - 124, m, rm, fl);
        }

        /// f64 fma in RNE with host f64 ops (Boldo & Melquiond, "Emulation of
        /// FMA and correctly rounded sums: proved algorithms using rounding to
        /// odd", IEEE TC 2008, emulated FMA): a*b = ph + pl exactly (Dekker),
        /// c + ph = sh + sl exactly (TwoSum), v = RO(sl + pl), result =
        /// RN(sh + v). Valid without underflow/overflow, so the operand and
        /// result ranges are restricted (null = take the integer path).
        /// Inexact: the exact value is sh + sl + pl; if sl + pl is not
        /// representable the result cannot be exact (the exact value lies
        /// within 1.5 ulp(sh) of sh, so Sterbenz would make sl + pl exact),
        /// otherwise it is exact iff RN(sh + v) has no TwoSum error.
        fn fma64Fast(a: B, b: B, c: B, fl: *u32) ?B {
            if (B != u64) unreachable;
            const xa: i32 = @intCast(expf(a));
            const xb: i32 = @intCast(expf(b));
            const xc: i32 = @intCast(expf(c));
            // normal operands (c may not be zero/subnormal), no split
            // overflow, product error term not subnormal, no overflow
            if (xa == 0 or xb == 0 or xc == 0) return null;
            if (xa > 1023 + 990 or xb > 1023 + 990 or xc > 1023 + 1000) return null;
            if (xa < 1023 - 990 or xb < 1023 - 990) return null;
            const pe = (xa - 1023) + (xb - 1023);
            if (pe < -900 or pe > 1000) return null;
            const x = h(a);
            const y = h(b);
            const z = h(c);
            // Dekker TwoProduct (Veltkamp split with 2^27 + 1)
            const p = x * y;
            const tx = 134217729.0 * x;
            const xh = tx - (tx - x);
            const xl = x - xh;
            const ty = 134217729.0 * y;
            const yh = ty - (ty - y);
            const yl = y - yh;
            const pl = ((xh * yh - p) + xh * yl + xl * yh) + xl * yl;
            // TwoSum(z, p)
            const sh = z + p;
            const sb = sh - z;
            const sa = sh - sb;
            const sl = (z - sa) + (p - sb);
            // v = RO(sl + pl)
            var u = sl + pl;
            const ub = u - sl;
            const ua = u - ub;
            const ue = (sl - ua) + (pl - ub);
            if (ue != 0) {
                var ubits: u64 = @bitCast(u);
                const ue_f = expf(ubits);
                if (ue_f == 0 or ue_f == emaxf) return null;
                if (ubits & 1 == 0) {
                    const away = (ue > 0) == (u > 0);
                    ubits = if (away) ubits + 1 else ubits - 1;
                    u = @bitCast(ubits);
                }
            }
            const r = sh + u;
            const rb: B = @bitCast(r);
            const ef = expf(rb);
            if (ef < 2 or ef >= emaxf - 1) return null;
            const rbv = r - sh;
            const rav = r - rbv;
            const re = (sh - rav) + (u - rbv);
            if (ue != 0 or re != 0) fl.* |= NX;
            return rb;
        }

        /// f32 fma in RNE via f64: the product is exact; the sum is made
        /// round-to-odd so the final f64->f32 rounding is correct.
        fn fma32Fast(a: B, b: B, c: B, fl: *u32) ?B {
            const p = @as(f64, h(a)) * @as(f64, h(b));
            const y: f64 = h(c);
            var r = p + y;
            const bv = r - p;
            const av = r - bv;
            const err = (p - av) + (y - bv);
            if (err != 0) {
                var rbits: u64 = @bitCast(r);
                if (rbits & 1 == 0) {
                    // move one ulp towards the exact value (r is non-zero: err != 0)
                    const away = (err > 0) == (r > 0);
                    rbits = if (away) rbits + 1 else rbits - 1;
                    r = @bitCast(rbits);
                }
            }
            const r32: f32 = @floatCast(r);
            const rb: B = @bitCast(r32);
            const ef = expf(rb);
            if (ef < 2 or ef >= emaxf - 1) return null;
            if (err != 0 or @as(f64, r32) != r) fl.* |= NX;
            return rb;
        }

        // ---- compare / min / max / classify -----------------------------------

        pub fn eq(a: B, b: B, fl: *u32) bool {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return false;
            }
            return h(a) == h(b);
        }
        pub fn lt(a: B, b: B, fl: *u32) bool {
            if (isNan(a) or isNan(b)) {
                fl.* |= NV;
                return false;
            }
            return h(a) < h(b);
        }
        pub fn le(a: B, b: B, fl: *u32) bool {
            if (isNan(a) or isNan(b)) {
                fl.* |= NV;
                return false;
            }
            return h(a) <= h(b);
        }
        pub fn min(a: B, b: B, fl: *u32) B {
            if (isSnan(a) or isSnan(b)) fl.* |= NV;
            if (isNan(a)) return if (isNan(b)) qnan else b;
            if (isNan(b)) return a;
            if (h(a) < h(b)) return a;
            if (h(b) < h(a)) return b;
            return a | b; // equal: -0 wins
        }
        pub fn max(a: B, b: B, fl: *u32) B {
            if (isSnan(a) or isSnan(b)) fl.* |= NV;
            if (isNan(a)) return if (isNan(b)) qnan else b;
            if (isNan(b)) return a;
            if (h(a) > h(b)) return a;
            if (h(b) > h(a)) return b;
            return a & b; // equal: +0 wins
        }
        /// fminm / fmaxm (Zfa): like min / max, but a NaN operand gives the
        /// canonical NaN.
        pub fn minm(a: B, b: B, fl: *u32) B {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return qnan;
            }
            return min(a, b, fl);
        }
        pub fn maxm(a: B, b: B, fl: *u32) B {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return qnan;
            }
            return max(a, b, fl);
        }
        /// fltq / fleq (Zfa): quiet compares (NV only for a signalling NaN).
        pub fn ltq(a: B, b: B, fl: *u32) bool {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return false;
            }
            return h(a) < h(b);
        }
        pub fn leq(a: B, b: B, fl: *u32) bool {
            if (isNan(a) or isNan(b)) {
                if (isSnan(a) or isSnan(b)) fl.* |= NV;
                return false;
            }
            return h(a) <= h(b);
        }
        /// fround / froundnx (Zfa): round to an integral value in this
        /// format with rm. A NaN gives the canonical NaN (NV if signalling),
        /// infinities and zeros stay as they are, a result of zero keeps the
        /// sign. Only froundnx (`nx`) raises NX, when the value changes.
        pub fn roundInt(a: B, rm: u32, nx: bool, fl: *u32) B {
            if (isNan(a)) {
                if (isSnan(a)) fl.* |= NV;
                return qnan;
            }
            const ef: i32 = @intCast(expf(a));
            if (ef >= bias + mb or isZero(a)) return a; // integral (or infinite) already
            const s = neg(a);
            const sig: u64 = if (ef == 0) a & mmask else (a & mmask) | (@as(u64, 1) << mb);
            // a = sig * 2^-sh, sh >= 1
            const sh: i32 = mb - (if (ef == 0) 1 - bias else ef - bias);
            var int: u64 = 0;
            var rem: u64 = 1; // sh >= 64: a tiny non-zero value, below one half
            var hf: u64 = 2;
            if (sh < 64) {
                const k: u6 = @intCast(sh);
                int = sig >> k;
                rem = sig & ((@as(u64, 1) << k) - 1);
                hf = @as(u64, 1) << (k - 1);
            }
            const mag = int + @intFromBool(roundInc(rm, s, int, rem, hf));
            if (nx and rem != 0) fl.* |= NX;
            if (mag == 0) return if (s) sign else 0;
            var exact: u32 = 0;
            return fromInt(s, mag, RNE, &exact); // mag <= 2^mb: exact
        }
        pub fn classify(a: B) u64 {
            const s = neg(a);
            if (isNan(a)) return if (isSnan(a)) 1 << 8 else 1 << 9;
            if (isInf(a)) return if (s) 1 << 0 else 1 << 7;
            if (isZero(a)) return if (s) 1 << 3 else 1 << 4;
            if (expf(a) == 0) return if (s) 1 << 2 else 1 << 5;
            return if (s) 1 << 1 else 1 << 6;
        }

        // ---- conversions ----------------------------------------------------

        /// fcvt.{w,wu,l,lu}: result is sign-extended to 64 bits.
        pub fn toInt(a: B, rm: u32, comptime signed: bool, comptime n: u7, fl: *u32) u64 {
            const maxv: u64 = if (signed) (@as(u64, 1) << (n - 1)) - 1 else if (n == 64) std.math.maxInt(u64) else (@as(u64, 1) << n) - 1;
            const minv: u64 = if (signed) 0 -% (@as(u64, 1) << (n - 1)) else 0;
            const ext = struct {
                inline fn f(v: u64) u64 {
                    return if (n == 32) @bitCast(@as(i64, @as(i32, @bitCast(@as(u32, @truncate(v)))))) else v;
                }
            }.f;
            if (isNan(a)) {
                fl.* |= NV;
                return ext(maxv);
            }
            const s = neg(a);
            if (isInf(a)) {
                fl.* |= NV;
                return ext(if (s) minv else maxv);
            }
            if (isZero(a)) return 0;
            const u = unpack(a);
            if (u.e > 63) {
                fl.* |= NV;
                return ext(if (s) minv else maxv);
            }
            var int: u64 = undefined;
            var rem: u64 = 0;
            var hf: u64 = 1;
            if (u.e >= 62) {
                int = u.m << @intCast(u.e - 62);
            } else if (u.e >= -1) {
                const sh: u6 = @intCast(62 - u.e);
                int = u.m >> sh;
                rem = u.m & ((@as(u64, 1) << sh) - 1);
                hf = @as(u64, 1) << (sh - 1);
            } else {
                int = 0;
                rem = 1;
                hf = 2;
            }
            const mag = int + @intFromBool(roundInc(rm, s, int, rem, hf));
            var res: u64 = undefined;
            if (signed) {
                const limit: u64 = if (s) @as(u64, 1) << (n - 1) else maxv;
                if (mag > limit) {
                    fl.* |= NV;
                    return ext(if (s) minv else maxv);
                }
                res = if (s) 0 -% mag else mag;
            } else {
                if (s and mag != 0) {
                    fl.* |= NV;
                    return 0;
                }
                if (mag > maxv) {
                    fl.* |= NV;
                    return ext(maxv);
                }
                res = mag;
            }
            if (rem != 0) fl.* |= NX;
            return ext(res);
        }

        /// fcvt.{s,d}.{w,wu,l,lu} from a sign + magnitude.
        pub fn fromInt(s: bool, mag: u64, rm: u32, fl: *u32) B {
            if (mag == 0) return 0;
            const lz: u32 = @clz(mag);
            if (lz == 0) return roundPack(s, 63, shrJam(mag, 1), rm, fl);
            return roundPack(s, 63 - @as(i32, @intCast(lz)), mag << @intCast(lz - 1), rm, fl);
        }

        /// Convert from the other format (fcvt.s.d / fcvt.d.s).
        pub fn fromOther(comptime A: type, a: A, rm: u32, fl: *u32) B {
            const Src = Fmt(A);
            const s = Src.neg(a);
            if (Src.isNan(a)) {
                if (Src.isSnan(a)) fl.* |= NV;
                return qnan;
            }
            const sb: B = if (s) sign else 0;
            if (Src.isInf(a)) return sb | inf;
            if (Src.isZero(a)) return sb;
            const u = Src.unpack(a);
            return roundPack(u.s, u.e, u.m, rm, fl);
        }
    };
}

pub const F32 = Fmt(u32);
pub const F64 = Fmt(u64);
/// Half precision (Zfhmin): only loads, stores, moves and the conversions
/// to and from F32/F64 (`fromOther`, which is exact for these formats).
pub const F16 = Fmt(u16);

/// fcvtmod.w.d (Zfa): the double truncated to an integer, modulo 2^32,
/// sign-extended. NaN and infinity give 0; NV when the integer does not fit
/// in 32 bits (then no NX), else NX when the value was not integral.
pub fn fcvtmodWD(a: u64, fl: *u32) u64 {
    const ef: i32 = @intCast((a >> 52) & 0x7ff);
    if (ef == 0x7ff) {
        fl.* |= NV;
        return 0;
    }
    const m = a & ((@as(u64, 1) << 52) - 1);
    if (ef == 0) { // zero or subnormal
        if (m != 0) fl.* |= NX;
        return 0;
    }
    const sig = m | (@as(u64, 1) << 52);
    const e = ef - 1023; // a = sig * 2^(e - 52)
    var low: u64 = 0; // the integer part modulo 2^64
    var inexact = true;
    if (e >= 0 and e <= 52) {
        const k: u6 = @intCast(52 - e);
        low = sig >> k;
        inexact = sig & ((@as(u64, 1) << k) - 1) != 0;
    } else if (e > 52) {
        low = if (e - 52 < 64) sig << @intCast(e - 52) else 0;
        inexact = false;
    }
    const s = a >> 63 != 0;
    const fits = e < 31 or (e == 31 and s and low == 1 << 31);
    if (!fits) fl.* |= NV else if (inexact) fl.* |= NX;
    const r: u32 = @truncate(if (s) 0 -% low else low);
    return @bitCast(@as(i64, @as(i32, @bitCast(r))));
}

// ---- tests -----------------------------------------------------------------------

const tst = std.testing;

fn bits64(x: f64) u64 {
    return @bitCast(x);
}
fn bits32(x: f32) u32 {
    return @bitCast(x);
}

test "fpu: fast path agrees with slow path (RNE) on random inputs" {
    var prng = std.Random.DefaultPrng.init(42);
    const rnd = prng.random();
    var i: usize = 0;
    while (i < 200000) : (i += 1) {
        // Bias exponents towards interesting ranges.
        var a = rnd.int(u64);
        var b = rnd.int(u64);
        if (i % 3 == 0) {
            a = (a & 0x800f_ffff_ffff_ffff) | (@as(u64, 1023 + rnd.intRangeAtMost(u64, 0, 60) - 30) << 52);
            b = (b & 0x800f_ffff_ffff_ffff) | (@as(u64, 1023 + rnd.intRangeAtMost(u64, 0, 60) - 30) << 52);
        }
        if (i % 5 == 0) b = (b & ~@as(u64, 0xffff_ffff)); // short significands -> exact cases
        if (i % 7 == 0) a = (a & ~@as(u64, 0xffff_ffff_ff));
        inline for (.{ "add", "mul", "div" }) |op| {
            var f1: u32 = 0;
            var f2: u32 = 0;
            const r1 = @field(F64, op)(a, b, RNE, &f1);
            const r2 = @field(F64, op ++ "Slow")(a, b, RNE, &f2);
            if (r1 != r2 or f1 != f2) {
                std.debug.print("{s} {x} {x}: fast {x}/{x} slow {x}/{x}\n", .{ op, a, b, r1, f1, r2, f2 });
                return error.TestUnexpectedResult;
            }
            const a32: u32 = @truncate(a >> 32);
            const b32: u32 = @truncate(b);
            f1 = 0;
            f2 = 0;
            const s1 = @field(F32, op)(a32, b32, RNE, &f1);
            const s2 = @field(F32, op ++ "Slow")(a32, b32, RNE, &f2);
            if (s1 != s2 or f1 != f2) {
                std.debug.print("f32 {s} {x} {x}: fast {x}/{x} slow {x}/{x}\n", .{ op, a32, b32, s1, f1, s2, f2 });
                return error.TestUnexpectedResult;
            }
        }
        // slow path vs host for RNE results (values)
        var fl: u32 = 0;
        const x: f64 = @bitCast(a);
        const y: f64 = @bitCast(b);
        const r = F64.addSlow(a, b, RNE, &fl);
        if (!std.math.isNan(x + y) and r != bits64(x + y)) return error.TestUnexpectedResult;
        const m = F64.mulSlow(a, b, RNE, &fl);
        if (!std.math.isNan(x * y) and m != bits64(x * y)) return error.TestUnexpectedResult;
        const d = F64.divSlow(a, b, RNE, &fl);
        if (!std.math.isNan(x / y) and d != bits64(x / y)) return error.TestUnexpectedResult;
        const fm = F64.fma(a, b, a, RNE, &fl);
        const want = @mulAdd(f64, x, y, x);
        if (!std.math.isNan(want) and fm != bits64(want)) {
            std.debug.print("fma {x} {x}: {x} want {x}\n", .{ a, b, fm, bits64(want) });
            return error.TestUnexpectedResult;
        }
        const a32: u32 = @truncate(a >> 32);
        const b32: u32 = @truncate(b);
        const c32: u32 = @truncate(a);
        const w32 = @mulAdd(f32, @bitCast(a32), @bitCast(b32), @bitCast(c32));
        const g32 = F32.fma(a32, b32, c32, RNE, &fl);
        if (!std.math.isNan(w32) and g32 != bits32(w32)) {
            std.debug.print("fmaf {x} {x} {x}: {x} want {x}\n", .{ a32, b32, c32, g32, bits32(w32) });
            return error.TestUnexpectedResult;
        }
        if (x > 0) {
            const sq = F64.sqrt(a, RNE, &fl);
            if (sq != bits64(@sqrt(x))) return error.TestUnexpectedResult;
            // directed: RDN result <= sqrt <= RUP result, adjacent or equal
            var fd: u32 = 0;
            var fu: u32 = 0;
            const lo = F64.sqrt(a, RDN, &fd);
            const hi = F64.sqrt(a, RUP, &fu);
            if (fd & NX == 0) {
                if (lo != hi or lo != sq) return error.TestUnexpectedResult;
            } else if (hi != lo + 1 or (sq != lo and sq != hi)) return error.TestUnexpectedResult;
        }
    }
}

test "fpu: f64 fma fast path agrees with the integer path" {
    var prng = std.Random.DefaultPrng.init(7);
    const rnd = prng.random();
    var hits: usize = 0;
    var i: usize = 0;
    while (i < 3_000_000) : (i += 1) {
        const span: u64 = switch (i % 4) {
            0 => 4,
            1 => 40,
            2 => 200,
            else => 1900,
        };
        const sig = struct {
            fn f(r: std.Random, k: usize) u64 {
                var m = r.int(u64) & 0x000f_ffff_ffff_ffff;
                switch (k % 5) {
                    0 => m &= ~@as(u64, 0xffff_ffff), // short significands: exact cases
                    1 => m |= 0x000f_ffff_ffff_f000, // runs of ones
                    2 => m &= 0x000f_0000_0000_000f,
                    else => {},
                }
                return m;
            }
        }.f;
        const e0: u64 = 1023 - span / 2;
        const a = (rnd.int(u64) & (1 << 63)) | ((e0 + rnd.uintLessThan(u64, span + 1)) << 52) | sig(rnd, i);
        const b = (rnd.int(u64) & (1 << 63)) | ((e0 + rnd.uintLessThan(u64, span + 1)) << 52) | sig(rnd, i / 5);
        var c: u64 = undefined;
        if (i % 3 == 0) {
            // near-cancellation: c = -(a*b) rounded, nudged by a few ulps,
            // or a tie-ish case (half an ulp of the product)
            const pr: u64 = @bitCast(@as(f64, @bitCast(a)) * @as(f64, @bitCast(b)));
            c = (pr ^ (1 << 63)) +% (rnd.uintLessThan(u64, 5) -% 2);
            if (i % 9 == 0) c = (pr & 0xfff0_0000_0000_0000) -% (53 << 52);
        } else {
            c = (rnd.int(u64) & (1 << 63)) | ((e0 + rnd.uintLessThan(u64, span + 1)) << 52) | sig(rnd, i / 25);
        }
        var f1: u32 = 0;
        var f2: u32 = 0;
        const r1 = F64.fma64Fast(a, b, c, &f1) orelse continue;
        hits += 1;
        const r2 = F64.fmaSlow(a, b, c, RNE, &f2);
        if (r1 != r2 or f1 != f2) {
            std.debug.print("fma {x} {x} {x}: fast {x}/{x} slow {x}/{x}\n", .{ a, b, c, r1, f1, r2, f2 });
            return error.TestUnexpectedResult;
        }
        const want = @mulAdd(f64, @bitCast(a), @bitCast(b), @bitCast(c));
        if (r1 != bits64(want)) return error.TestUnexpectedResult;
    }
    try tst.expect(hits > 2_000_000);
}

test "fpu: flags and rounding edge cases" {
    var fl: u32 = 0;
    // 1/0 -> DZ
    try tst.expectEqual(F64.inf, F64.div(bits64(1.0), 0, RNE, &fl));
    try tst.expectEqual(DZ, fl);
    fl = 0;
    // 0/0 -> NV
    try tst.expectEqual(F64.qnan, F64.div(0, 0, RNE, &fl));
    try tst.expectEqual(NV, fl);
    fl = 0;
    // overflow
    try tst.expectEqual(F64.inf, F64.mul(bits64(1e300), bits64(1e300), RNE, &fl));
    try tst.expectEqual(OF | NX, fl);
    fl = 0;
    try tst.expectEqual(F64.inf - 1, F64.mul(bits64(1e300), bits64(1e300), RTZ, &fl));
    fl = 0;
    // underflow
    _ = F64.mul(bits64(1e-300), bits64(1e-300), RNE, &fl);
    try tst.expectEqual(UF | NX, fl);
    fl = 0;
    // exact subnormal result: no flags
    try tst.expectEqual(@as(u64, 1), F64.mul(bits64(std.math.floatMin(f64)), bits64(0x1p-52), RNE, &fl));
    try tst.expectEqual(@as(u32, 0), fl);
    // 1/3 directed
    fl = 0;
    const third_dn = F64.div(bits64(1.0), bits64(3.0), RDN, &fl);
    const third_up = F64.div(bits64(1.0), bits64(3.0), RUP, &fl);
    try tst.expectEqual(third_dn + 1, third_up);
    try tst.expectEqual(NX, fl);
    // conversions
    fl = 0;
    try tst.expectEqual(@as(u64, 2), F64.toInt(bits64(2.5), RNE, true, 32, &fl));
    try tst.expectEqual(@as(u64, 3), F64.toInt(bits64(2.5), RMM, true, 32, &fl));
    try tst.expectEqual(@as(u64, 0) -% 3, F64.toInt(bits64(-2.5), RDN, true, 64, &fl));
    try tst.expectEqual(@as(u64, 0) -% 2, F64.toInt(bits64(-2.5), RTZ, true, 64, &fl));
    try tst.expectEqual(NX, fl);
    fl = 0;
    try tst.expectEqual(@as(u64, 0x7fff_ffff), F64.toInt(bits64(3e9), RNE, true, 32, &fl));
    try tst.expectEqual(NV, fl);
    fl = 0;
    try tst.expectEqual(@as(u64, 0xffff_ffff_b2d0_5e00), F64.toInt(bits64(3e9), RNE, false, 32, &fl));
    try tst.expectEqual(@as(u32, 0), fl);
    try tst.expectEqual(@as(u64, 0), F64.toInt(bits64(-0.4), RNE, false, 64, &fl));
    try tst.expectEqual(NX, fl);
    fl = 0;
    try tst.expectEqual(@as(u64, 0), F64.toInt(bits64(-1.0), RNE, false, 64, &fl));
    try tst.expectEqual(NV, fl);
    fl = 0;
    try tst.expectEqual(@as(u64, 0x7fff_ffff_ffff_ffff), F64.toInt(F64.qnan, RNE, true, 64, &fl));
    try tst.expectEqual(bits64(9007199254740992.0), F64.fromInt(false, (1 << 53) + 1, RNE, &fl));
    try tst.expectEqual(bits64(9007199254740994.0), F64.fromInt(false, (1 << 53) + 1, RUP, &fl));
    try tst.expectEqual(bits64(-18446744073709551616.0), F64.fromInt(true, std.math.maxInt(u64), RNE, &fl));
    // f64 -> f32 rounding
    fl = 0;
    try tst.expectEqual(bits32(1.0), F32.fromOther(u64, bits64(1.0 + 0x1p-30), RNE, &fl));
    try tst.expectEqual(bits32(1.0) + 1, F32.fromOther(u64, bits64(1.0 + 0x1p-30), RUP, &fl));
    try tst.expectEqual(NX, fl);
    // min/max with -0 / NaN
    try tst.expectEqual(bits64(-0.0), F64.min(bits64(0.0), bits64(-0.0), &fl));
    try tst.expectEqual(bits64(0.0), F64.max(bits64(-0.0), bits64(0.0), &fl));
    try tst.expectEqual(bits64(1.0), F64.min(F64.qnan, bits64(1.0), &fl));
    fl = 0;
    try tst.expectEqual(F64.qnan, F64.min(0x7ff0_0000_0000_0001, 0x7ff0_0000_0000_0001, &fl));
    try tst.expectEqual(NV, fl);
    // fma: inf*0 + qNaN is invalid
    fl = 0;
    _ = F64.fma(F64.inf, 0, F64.qnan, RNE, &fl);
    try tst.expectEqual(NV, fl);
    // x*y - x*y with fma gives the rounding error of the product
    fl = 0;
    const x = 1.0 + 0x1p-30;
    const p = x * x;
    try tst.expectEqual(bits64(@mulAdd(f64, x, x, -p)), F64.fma(bits64(x), bits64(x), bits64(-p), RNE, &fl));
    // mulh helpers
    try tst.expectEqual(@as(u64, 0xffff_ffff_ffff_ffff), mulh(@bitCast(@as(i64, -1)), 1));
    try tst.expectEqual(@as(u64, 0x7fff_ffff_ffff_fffe), mul64(std.math.maxInt(u64), std.math.maxInt(u64) >> 1).hi);
}

test "fpu: directed rounding brackets the RNE result (incl. subnormal/overflow ranges)" {
    var prng = std.Random.DefaultPrng.init(7);
    const rnd = prng.random();
    var i: usize = 0;
    while (i < 100000) : (i += 1) {
        var a = rnd.int(u64);
        var b = rnd.int(u64);
        var c = rnd.int(u64);
        switch (i % 4) {
            0 => { // tiny results
                a = (a & 0x800f_ffff_ffff_ffff) | (@as(u64, rnd.intRangeAtMost(u64, 0, 40)) << 52);
                b = (b & 0x800f_ffff_ffff_ffff) | (@as(u64, 1023 - rnd.intRangeAtMost(u64, 0, 40)) << 52);
            },
            1 => { // huge results
                a = (a & 0x800f_ffff_ffff_ffff) | (@as(u64, 2046 - rnd.intRangeAtMost(u64, 0, 3)) << 52);
                b = (b & 0x800f_ffff_ffff_ffff) | (@as(u64, 1023 + rnd.intRangeAtMost(u64, 0, 3)) << 52);
            },
            2 => c = (c & 0x800f_ffff_ffff_ffff) | ((((a >> 52) & 0x7ff) + ((b >> 52) & 0x7ff) -% 1023) & 0x7ff) << 52,
            else => {},
        }
        inline for (.{ F64, F32 }) |F| {
            const T = if (F == F64) u64 else u32;
            const x: T = @truncate(a);
            const y: T = @truncate(b);
            const z: T = @truncate(c);
            inline for (.{ "add", "mul", "div", "fma" }) |op| {
                var fl: [5]u32 = @splat(0);
                var r: [5]T = undefined;
                for (0..5) |rm| {
                    r[rm] = if (comptime std.mem.eql(u8, op, "fma"))
                        F.fma(x, y, z, @intCast(rm), &fl[rm])
                    else
                        @field(F, op)(x, y, @intCast(rm), &fl[rm]);
                }
                if (!F.isNan(r[0])) {
                    const H = F.H;
                    const lo: H = @bitCast(r[RDN]);
                    const hi: H = @bitCast(r[RUP]);
                    const ne: H = @bitCast(r[RNE]);
                    const exact = fl[RNE] & NX == 0;
                    var ok = lo <= ne and ne <= hi and (r[RNE] == r[RMM] or !exact);
                    if (exact) ok = ok and r[RDN] == r[RUP] and r[RTZ] == r[RNE];
                    if (!exact) ok = ok and (r[RTZ] == r[RDN] or r[RTZ] == r[RUP]) and lo < hi;
                    for (fl) |f| ok = ok and ((f & NX) != 0) == !exact;
                    if (!ok) {
                        std.debug.print("{s} {s} {x} {x} {x}: {any} flags {any}\n", .{ @typeName(T), op, x, y, z, r, fl });
                        return error.TestUnexpectedResult;
                    }
                }
            }
        }
    }
}
