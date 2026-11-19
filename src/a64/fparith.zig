// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Arm floating-point arithmetic primitives (the FP* functions of the Arm
//! ARM pseudocode, ARMv8.0 with FPCR.AH = 0) for scalar FP (fp.zig) and,
//! lane by lane, for AdvSIMD FP (simd_fp.zig).
//!
//! API. Every primitive is a pure function of raw bits and FPCR: no CPU
//! state. B is the operand format as raw bits, `u32` (single) or `u64`
//! (double); `u16` (half) only where named (conversions, `expandImm`,
//! `abs`/`neg`). `fpcr` is the FPCR value (only RMode, FZ, DN and AHP
//! matter). `fl` accumulates FPSR cumulative exception bits (common.FPSR_
//! IOC, DZC, OFC, UFC, IXC, IDC): the function ORs in what the operation
//! raises and never clears anything, so a vector op passes one `fl` for all
//! its lanes and then does `fpsr |= fl` once, after everything that can
//! fault. Results are raw bits of the destination format.
//!
//!   add sub mul div mulx         FPAdd FPSub FPMul FPDiv FPMulX
//!   mulAdd(addend, op1, op2)     FPMulAdd: addend + op1*op2, one rounding.
//!                                FMSUB/FNMADD/FNMSUB/FMLS negate operands
//!                                with `neg` first (as the pseudocode does,
//!                                so a NaN operand's sign flips too).
//!   sqrt                         FPSqrt
//!   max min maxNum minNum        FPMax FPMin FPMaxNum FPMinNum
//!   compare(a, b, signal)        FPCompare: NZCV in bits 31..28 (FCMP:
//!                                signal = false, FCMPE: true)
//!   cmpEq cmpGe cmpGt            FPCompareEQ/GE/GT (FCMEQ/FCMGE/FCMGT;
//!                                FCMLE/FCMLT swap the operands)
//!   abs neg                      FPAbs FPNeg (sign bit only, no flags)
//!   roundInt(a, rnd, exact)      FPRoundInt (FRINT*; exact: FRINTX)
//!   convert(To, From, a, rnd)    FPConvert between h/s/d (FCVT; FCVTXN
//!                                passes .odd), AHP for halves
//!   toFixed(a, fbits, unsigned, n, rnd)   FPToFixed: n = 32 or 64-bit
//!                                integer (fbits = 0 for FCVT*), saturated;
//!                                the result is zero-extended from n bits
//!   fromFixed(v, n, fbits, unsigned, rnd) FixedToFP (SCVTF/UCVTF)
//!   expandImm(imm8)              VFPExpandImm (FMOV immediate)
//!   recipStep rsqrtStep          FPRecipStepFused, FPRSqrtStepFused
//!                                (FRECPS: 2 - a*b, FRSQRTS: (3 - a*b)/2,
//!                                one rounding, Inf*0 gives 2.0 / 1.5)
//!   recipEstimate rsqrtEstimate  FPRecipEstimate, FPRSqrtEstimate (FRECPE,
//!                                FRSQRTE; ARMv8.0 8-bit tables, no RPRES),
//!                                recipEstimateInt/rsqrtEstimateInt the
//!                                table functions
//!   recpX                        FPRecpX (FRECPX)
//!   defaultNaN, isNaN, fpcrRounding
//!
//! Every Arm rule is applied here, unlike fpu.zig (RISC-V rules), which
//! does the core arithmetic of add/sub/mul/div/fma/sqrt and round to
//! integral:
//!  - NaNs: operands are checked in the pseudocode's FPProcessNaNs order
//!    (signalling first, then quiet, left to right; FPMulAdd puts the
//!    addend first), quieted, or replaced by the default NaN under FPCR.DN.
//!    A quiet-NaN addend with an Inf*0 product gives the default NaN and
//!    IOC.
//!  - FPCR.FZ: single and double denormal inputs read as a zero of the same
//!    sign and raise IDC (also for compares, min/max, conversions); a result
//!    whose exact value is below the smallest normal becomes a zero of its
//!    sign and raises UFC only (no IXC). Halves are never flushed (FZ16
//!    belongs to FEAT_FP16; conversions ignore it).
//!  - Underflow: tininess is detected before rounding. fpu.zig detects it
//!    after rounding; the two differ only for a result that rounds to the
//!    smallest normal, which `arith` resolves by asking fpu for the result
//!    rounded towards zero.
//!  - FPCR.AHP: half-precision conversions use the alternative format (no
//!    Inf or NaN encodings: NaN converts to zero with IOC, Inf and
//!    overflow to the largest value with IOC).
//!
//! Not here: FP16 arithmetic, FRINT32/64, FJCVTZS, BF16, FEAT_RPRES.

const std = @import("std");
const c = @import("common.zig");
const fpu = c.fpu;

pub const IOC = c.FPSR_IOC;
pub const DZC = c.FPSR_DZC;
pub const OFC = c.FPSR_OFC;
pub const UFC = c.FPSR_UFC;
pub const IXC = c.FPSR_IXC;
pub const IDC = c.FPSR_IDC;

/// The rounding modes of the pseudocode (FPRounding_*). `odd` is round to
/// odd (von Neumann), only for FCVTXN through `convert`.
pub const Rounding = enum(u3) { tieeven, posinf, neginf, zero, tieaway, odd };

/// FPRoundingMode(fpcr): FPCR.RMode (RN, RP, RM, RZ).
pub fn fpcrRounding(fpcr: u32) Rounding {
    return @enumFromInt((fpcr >> c.FPCR_RMODE_SHIFT) & 3);
}

fn fpuMode(r: Rounding) u32 {
    return switch (r) {
        .tieeven => fpu.RNE,
        .posinf => fpu.RUP,
        .neginf => fpu.RDN,
        .zero => fpu.RTZ,
        .tieaway => fpu.RMM,
        .odd => unreachable,
    };
}

// ---- format parameters ---------------------------------------------------------

fn P(comptime B: type) type {
    return struct {
        const F = fpu.Fmt(B);
        const nbits = @bitSizeOf(B);
        const mb = F.mb;
        const eb = nbits - 1 - mb;
        const bias: i32 = (1 << (eb - 1)) - 1;
        const emaxf: B = F.emaxf;
        const sign: B = F.sign;
        const inf: B = F.inf;
        const qbit: B = @as(B, 1) << (mb - 1);
        const mmask: B = (@as(B, 1) << mb) - 1;
        const min_normal: B = @as(B, 1) << mb;
        const extra = 62 - mb;
    };
}

/// FPDefaultNaN: positive, quiet, zero payload.
pub fn defaultNaN(comptime B: type) B {
    return P(B).inf | P(B).qbit;
}
pub inline fn isNaN(comptime B: type, x: B) bool {
    return x & ~P(B).sign > P(B).inf;
}
inline fn isSnan(comptime B: type, x: B) bool {
    return isNaN(B, x) and x & P(B).qbit == 0;
}
inline fn isQnan(comptime B: type, x: B) bool {
    return isNaN(B, x) and x & P(B).qbit != 0;
}
inline fn isInf(comptime B: type, x: B) bool {
    return x & ~P(B).sign == P(B).inf;
}
inline fn isZero(comptime B: type, x: B) bool {
    return x & ~P(B).sign == 0;
}
inline fn signOf(comptime B: type, x: B) bool {
    return x & P(B).sign != 0;
}

/// FPAbs (FPCR.AH = 0: also for NaNs; no exceptions).
pub inline fn abs(comptime B: type, a: B) B {
    return a & ~P(B).sign;
}
/// FPNeg (FPCR.AH = 0: also for NaNs; no exceptions).
pub inline fn neg(comptime B: type, a: B) B {
    return a ^ P(B).sign;
}

/// The FZ part of FPUnpack: a single or double denormal reads as a zero of
/// the same sign under FPCR.FZ and raises IDC. Halves are not flushed.
inline fn flushIn(comptime B: type, x: B, fpcr: u32, fl: *u32) B {
    if (B == u16 or fpcr & c.FPCR_FZ == 0) return x;
    if (x & (P(B).inf) == 0 and x & P(B).mmask != 0) {
        fl.* |= IDC;
        return x & P(B).sign;
    }
    return x;
}

// ---- NaN handling --------------------------------------------------------------

/// FPProcessNaN: `a` (a NaN) quieted, or the default NaN under FPCR.DN; IOC
/// for a signalling NaN.
pub fn processNaN(comptime B: type, a: B, fpcr: u32, fl: *u32) B {
    if (a & P(B).qbit == 0) fl.* |= IOC;
    return if (fpcr & c.FPCR_DN != 0) defaultNaN(B) else a | P(B).qbit;
}
/// FPProcessNaNs: the NaN result of a two-operand operation, or null when
/// neither operand is a NaN.
fn nans2(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) ?B {
    if (!isNaN(B, a) and !isNaN(B, b)) return null;
    if (isSnan(B, a)) return processNaN(B, a, fpcr, fl);
    if (isSnan(B, b)) return processNaN(B, b, fpcr, fl);
    if (isNaN(B, a)) return processNaN(B, a, fpcr, fl);
    return processNaN(B, b, fpcr, fl);
}
/// FPProcessNaNs3 (callers pass at least one NaN).
fn nans3(comptime B: type, a: B, b: B, d: B, fpcr: u32, fl: *u32) B {
    if (isSnan(B, a)) return processNaN(B, a, fpcr, fl);
    if (isSnan(B, b)) return processNaN(B, b, fpcr, fl);
    if (isSnan(B, d)) return processNaN(B, d, fpcr, fl);
    if (isNaN(B, a)) return processNaN(B, a, fpcr, fl);
    if (isNaN(B, b)) return processNaN(B, b, fpcr, fl);
    return processNaN(B, d, fpcr, fl);
}

// ---- arithmetic through fpu.zig ------------------------------------------------

const Op = enum { add, sub, mul, div, fma };

inline fn run(comptime B: type, comptime op: Op, x: B, y: B, z: B, rm: u32, f: *u32) B {
    const F = fpu.Fmt(B);
    return switch (op) {
        .add => F.add(x, y, rm, f),
        .sub => F.sub(x, y, rm, f),
        .mul => F.mul(x, y, rm, f),
        .div => F.div(x, y, rm, f),
        .fma => F.fma(x, y, z, rm, f), // x*y + z
    };
}

/// fpu's result for NaN-free (and already flushed) operands, with Arm's
/// underflow rules applied (FPRound): for every non-NaN input fpu's value
/// and its IOC/DZC/OFC/IXC agree with the pseudocode; only UFC (tininess
/// before rounding) and FZ's flush of tiny results differ.
inline fn arith(comptime B: type, comptime op: Op, x: B, y: B, z: B, fpcr: u32, fl: *u32) B {
    var f: u32 = 0;
    var r = run(B, op, x, y, z, fpuMode(fpcrRounding(fpcr)), &f);
    if (r & ~P(B).sign <= P(B).min_normal) r = tiny(B, op, r, &f, x, y, z, fpcr);
    fl.* |= c.fpsrBits(f);
    return r;
}

/// A result of at most the smallest normal magnitude: decide whether the
/// exact value was below 2^emin (tiny before rounding) and apply FZ or UFC.
fn tiny(comptime B: type, comptime op: Op, r: B, f: *u32, x: B, y: B, z: B, fpcr: u32) B {
    @branchHint(.unlikely);
    const mag = r & ~P(B).sign;
    const was_tiny = if (mag == P(B).min_normal) blk: {
        if (f.* & fpu.NX == 0) break :blk false; // exactly the smallest normal
        // rounded to it: the exact value was below it iff truncation is
        var g: u32 = 0;
        break :blk run(B, op, x, y, z, fpu.RTZ, &g) & ~P(B).sign < P(B).min_normal;
    } else mag != 0 or f.* & fpu.NX != 0; // a non-zero exact value
    if (!was_tiny) return r;
    if (fpcr & c.FPCR_FZ != 0) {
        f.* = fpu.UF; // flushed: UFC, never IXC
        return r & P(B).sign;
    }
    if (f.* & fpu.NX != 0) f.* |= fpu.UF;
    return r;
}

/// FPAdd.
pub fn add(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    return arith(B, .add, x, y, 0, fpcr, fl);
}
/// FPSub (NaN operands propagate with their own sign).
pub fn sub(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    return arith(B, .sub, x, y, 0, fpcr, fl);
}
/// FPMul. FNMUL is `neg(mul(a, b))`.
pub fn mul(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    return arith(B, .mul, x, y, 0, fpcr, fl);
}
/// FPMulX (FMULX): like FPMul, but Inf * 0 is 2.0 with the product's sign
/// (no IOC).
pub fn mulx(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    if ((isInf(B, x) and isZero(B, y)) or (isZero(B, x) and isInf(B, y)))
        return ((x ^ y) & P(B).sign) | (@as(B, @intCast(P(B).bias + 1)) << P(B).mb);
    return arith(B, .mul, x, y, 0, fpcr, fl);
}
/// FPDiv.
pub fn div(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    return arith(B, .div, x, y, 0, fpcr, fl);
}
/// FPMulAdd: addend + op1 * op2 with a single rounding.
pub fn mulAdd(comptime B: type, addend: B, op1: B, op2: B, fpcr: u32, fl: *u32) B {
    const a = flushIn(B, addend, fpcr, fl);
    const x = flushIn(B, op1, fpcr, fl);
    const y = flushIn(B, op2, fpcr, fl);
    if (isNaN(B, a) or isNaN(B, x) or isNaN(B, y)) {
        const inf_zero = (isInf(B, x) and isZero(B, y)) or (isZero(B, x) and isInf(B, y));
        if (isQnan(B, a) and inf_zero) {
            fl.* |= IOC;
            return defaultNaN(B);
        }
        return nans3(B, a, x, y, fpcr, fl);
    }
    return arith(B, .fma, x, y, a, fpcr, fl);
}
/// FPSqrt (the result is never tiny).
pub fn sqrt(comptime B: type, a: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    if (isNaN(B, x)) return processNaN(B, x, fpcr, fl);
    var f: u32 = 0;
    const r = fpu.Fmt(B).sqrt(x, fpuMode(fpcrRounding(fpcr)), &f);
    fl.* |= c.fpsrBits(f);
    return r;
}

// ---- min / max -----------------------------------------------------------------

/// x > y for non-NaN values (-0 == +0).
inline fn gtv(comptime B: type, x: B, y: B) bool {
    const H = fpu.Fmt(B).H;
    return @as(H, @bitCast(x)) > @as(H, @bitCast(y));
}

/// FPMax: NaNs propagate; of two zeros +0 wins.
pub fn max(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    if (gtv(B, x, y)) return x;
    if (gtv(B, y, x)) return y;
    return x & y; // equal: identical, or zeros (sign1 AND sign2)
}
/// FPMin: NaNs propagate; of two zeros -0 wins.
pub fn min(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    if (gtv(B, y, x)) return x;
    if (gtv(B, x, y)) return y;
    return x | y; // equal: identical, or zeros (sign1 OR sign2)
}
/// FPMaxNum (IEEE maxNum): a single quiet NaN loses to a number;
/// signalling NaNs propagate.
pub fn maxNum(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    var x = a;
    var y = b;
    if (isQnan(B, x) and !isQnan(B, y)) x = P(B).sign | P(B).inf else if (!isQnan(B, x) and isQnan(B, y)) y = P(B).sign | P(B).inf;
    return max(B, x, y, fpcr, fl);
}
/// FPMinNum (IEEE minNum).
pub fn minNum(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    var x = a;
    var y = b;
    if (isQnan(B, x) and !isQnan(B, y)) x = P(B).inf else if (!isQnan(B, x) and isQnan(B, y)) y = P(B).inf;
    return min(B, x, y, fpcr, fl);
}

// ---- compares ------------------------------------------------------------------

/// FPCompare: NZCV (bits 31..28) for a vs b: 0110 equal, 1000 less, 0010
/// greater, 0011 unordered. IOC for a signalling NaN, or for any NaN when
/// `signal` (FCMPE).
pub fn compare(comptime B: type, a: B, b: B, signal: bool, fpcr: u32, fl: *u32) u32 {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (isNaN(B, x) or isNaN(B, y)) {
        if (signal or isSnan(B, x) or isSnan(B, y)) fl.* |= IOC;
        return c.C | c.V;
    }
    if (gtv(B, x, y)) return c.C;
    if (gtv(B, y, x)) return c.N;
    return c.Z | c.C;
}
/// FPCompareEQ: quiet (IOC only for a signalling NaN).
pub fn cmpEq(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) bool {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (isNaN(B, x) or isNaN(B, y)) {
        if (isSnan(B, x) or isSnan(B, y)) fl.* |= IOC;
        return false;
    }
    return !gtv(B, x, y) and !gtv(B, y, x);
}
/// FPCompareGE: signalling (IOC for any NaN).
pub fn cmpGe(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) bool {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (isNaN(B, x) or isNaN(B, y)) {
        fl.* |= IOC;
        return false;
    }
    return !gtv(B, y, x);
}
/// FPCompareGT: signalling (IOC for any NaN).
pub fn cmpGt(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) bool {
    const x = flushIn(B, a, fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (isNaN(B, x) or isNaN(B, y)) {
        fl.* |= IOC;
        return false;
    }
    return gtv(B, x, y);
}

// ---- reciprocal steps and estimates --------------------------------------------

inline fn fpOne(comptime B: type) B {
    return @as(B, @intCast(P(B).bias)) << P(B).mb;
}
/// The biased exponent field of x.
inline fn expField(comptime B: type, x: B) u32 {
    return @intCast((x >> P(B).mb) & P(B).emaxf);
}

/// FPRecipStepFused (FRECPS): 2 - a*b with a single rounding; Inf * 0 is
/// +2.0. An exact zero is -0 only when rounding towards minus infinity.
pub fn recipStep(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, neg(B, a), fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    const two = fpOne(B) + (@as(B, 1) << P(B).mb);
    if ((isInf(B, x) and isZero(B, y)) or (isZero(B, x) and isInf(B, y))) return two;
    if (isInf(B, x) or isInf(B, y)) return ((x ^ y) & P(B).sign) | P(B).inf;
    return arith(B, .fma, x, y, two, fpcr, fl);
}

/// FPRSqrtStepFused (FRSQRTS): (3 - a*b) / 2 with a single rounding; Inf * 0
/// is +1.5.
pub fn rsqrtStep(comptime B: type, a: B, b: B, fpcr: u32, fl: *u32) B {
    const p = P(B);
    const x = flushIn(B, neg(B, a), fpcr, fl);
    const y = flushIn(B, b, fpcr, fl);
    if (nans2(B, x, y, fpcr, fl)) |n| return n;
    const one_half = fpOne(B) | p.qbit; // 1.5
    if ((isInf(B, x) and isZero(B, y)) or (isZero(B, x) and isInf(B, y))) return one_half;
    if (isInf(B, x) or isInf(B, y)) return ((x ^ y) & p.sign) | p.inf;
    // 1.5 + x * (y / 2): halving an operand with an exponent field of 2 or
    // more is exact, and 3 + x*y would overflow where the result does not.
    const unit: B = @as(B, 1) << p.mb;
    if (expField(B, y) >= 2) return arith(B, .fma, x, y - unit, one_half, fpcr, fl);
    if (expField(B, x) >= 2) return arith(B, .fma, x - unit, y, one_half, fpcr, fl);
    // both tiny: the product is far below 1, 3 + x*y lies in [2, 4) and
    // halving the rounded value is exact
    const r = arith(B, .fma, x, y, fpOne(B) + p.qbit + unit, fpcr, fl);
    return r - unit;
}

/// RecipEstimate (ARMv8.0, no FEAT_RPRES): a in 256..511 (0.5 .. 1.0 in
/// steps of 1/512) to 256..511 (1.0 .. 2.0 in steps of 1/256).
pub fn recipEstimateInt(a: u32) u32 {
    const x = a * 2 + 1;
    const b = (@as(u32, 1) << 19) / x;
    return (b + 1) / 2;
}
/// RecipSqrtEstimate (ARMv8.0): a in 128..511 (0.25 .. 1.0) to 256..511.
pub fn rsqrtEstimateInt(a: u32) u32 {
    const x: u64 = if (a < 256) a * 2 + 1 else (((a >> 1) << 1) + 1) * 2;
    var b: u64 = 512;
    while (x * (b + 1) * (b + 1) < (1 << 28)) b += 1;
    return @intCast((b + 1) / 2);
}

/// FPRecipEstimate (FRECPE), ARMv8.0: an 8-bit estimate of 1/a.
pub fn recipEstimate(comptime B: type, a: B, fpcr: u32, fl: *u32) B {
    const p = P(B);
    const x = flushIn(B, a, fpcr, fl);
    const sb = x & p.sign;
    if (isNaN(B, x)) return processNaN(B, x, fpcr, fl);
    if (isInf(B, x)) return sb;
    if (isZero(B, x)) {
        fl.* |= DZC;
        return sb | p.inf;
    }
    const e: i32 = @intCast(expField(B, x));
    var frac: u64 = @as(u64, x & p.mmask) << (52 - p.mb); // 52-bit fraction
    if (e == 0 and frac >> 50 == 0) { // |x| < 2^(emin - 2): overflows
        fl.* |= OFC | IXC;
        const to_inf = switch (fpcrRounding(fpcr)) {
            .tieeven => true,
            .posinf => sb == 0,
            .neginf => sb != 0,
            else => false,
        };
        return sb | (if (to_inf) p.inf else p.inf - 1);
    }
    if (fpcr & c.FPCR_FZ != 0 and e >= 2 * p.bias - 1) { // the result would be denormal
        fl.* |= UFC;
        return sb;
    }
    var ex = e;
    const fmask: u64 = (@as(u64, 1) << 52) - 1;
    if (ex == 0) {
        if (frac >> 51 == 0) {
            ex = -1;
            frac = (frac << 2) & fmask;
        } else frac = (frac << 1) & fmask;
    }
    const est = recipEstimateInt(@intCast(256 | (frac >> 44)));
    var rexp: i32 = 2 * p.bias - 1 - ex;
    var rf: u64 = @as(u64, est & 0xff) << 44;
    if (rexp == 0) {
        rf = (@as(u64, 1) << 51) | (rf >> 1);
    } else if (rexp == -1) {
        rf = (@as(u64, 1) << 50) | (rf >> 2);
        rexp = 0;
    }
    return sb | (@as(B, @intCast(rexp)) << p.mb) | @as(B, @intCast(rf >> (52 - p.mb)));
}

/// FPRSqrtEstimate (FRSQRTE), ARMv8.0: an 8-bit estimate of 1/sqrt(a).
pub fn rsqrtEstimate(comptime B: type, a: B, fpcr: u32, fl: *u32) B {
    const p = P(B);
    const x = flushIn(B, a, fpcr, fl);
    if (isNaN(B, x)) return processNaN(B, x, fpcr, fl);
    if (isZero(B, x)) {
        fl.* |= DZC;
        return (x & p.sign) | p.inf;
    }
    if (signOf(B, x)) {
        fl.* |= IOC;
        return defaultNaN(B);
    }
    if (isInf(B, x)) return 0;
    var ex: i32 = @intCast(expField(B, x));
    const fmask: u64 = (@as(u64, 1) << 52) - 1;
    var frac: u64 = @as(u64, x & p.mmask) << (52 - p.mb);
    if (ex == 0) {
        while (frac >> 51 == 0) {
            frac <<= 1;
            ex -= 1;
        }
        frac = (frac << 1) & fmask;
    }
    const scaled: u32 = if (ex & 1 == 0) @intCast(256 | (frac >> 44)) else @intCast(128 | (frac >> 45));
    const rexp: i32 = @divFloor(3 * p.bias - 1 - ex, 2);
    const est = rsqrtEstimateInt(scaled);
    return (@as(B, @intCast(rexp)) << p.mb) | (@as(B, @intCast(est & 0xff)) << (p.mb - 8));
}

/// FPRecpX (FRECPX): the exponent field inverted (zero and denormals give
/// the largest finite exponent), fraction zero, sign kept.
pub fn recpX(comptime B: type, a: B, fpcr: u32, fl: *u32) B {
    const p = P(B);
    _ = flushIn(B, a, fpcr, fl); // IDC for a flushed denormal
    if (isNaN(B, a)) return processNaN(B, a, fpcr, fl);
    const e: B = (a >> p.mb) & p.emaxf;
    const re: B = if (e == 0) p.emaxf - 1 else ~e & p.emaxf;
    return (a & p.sign) | (re << p.mb);
}

// ---- round to integral ---------------------------------------------------------

/// FPRoundInt: `a` rounded to an integral value in its own format with
/// `rnd` (not .odd). `exact` (FRINTX) raises IXC when the value changes.
/// Zeros, infinities and results of zero keep their sign.
pub fn roundInt(comptime B: type, a: B, rnd: Rounding, exact: bool, fpcr: u32, fl: *u32) B {
    const x = flushIn(B, a, fpcr, fl);
    if (isNaN(B, x)) return processNaN(B, x, fpcr, fl);
    var f: u32 = 0;
    const r = fpu.Fmt(B).roundInt(x, fpuMode(rnd), exact, &f);
    fl.* |= c.fpsrBits(f);
    return r;
}

// ---- conversions ---------------------------------------------------------------

/// value = m / 2^62 * 2^e, m in [2^62, 2^63).
const Un = struct { s: bool, e: i32, m: u64 };

/// The exact value of a finite non-zero `x` (an AHP half with exponent 31
/// is a normal number too).
fn unpack(comptime B: type, x: B) Un {
    const p = P(B);
    const ef: i32 = @intCast((x >> p.mb) & p.emaxf);
    const m: u64 = x & p.mmask;
    if (ef == 0) {
        const k: u6 = @intCast(@clz(m) - 1);
        return .{ .s = signOf(B, x), .e = 1 - p.bias - p.mb + 62 - @as(i32, k), .m = m << k };
    }
    return .{ .s = signOf(B, x), .e = ef - p.bias, .m = (m | (@as(u64, 1) << p.mb)) << p.extra };
}

fn shrJam(x: u64, n: u32) u64 {
    if (n == 0) return x;
    if (n >= 64) return @intFromBool(x != 0);
    return (x >> @intCast(n)) | @intFromBool((x << @intCast(64 - n)) != 0);
}

inline fn roundUp(r: Rounding, s: bool, lsb: u64, rem: u64, half: u64) bool {
    return switch (r) {
        .tieeven => rem > half or (rem == half and lsb & 1 != 0),
        .posinf => !s and rem != 0,
        .neginf => s and rem != 0,
        .zero, .odd => false,
        .tieaway => rem >= half,
    };
}

/// FPRound of the non-zero value m / 2^62 * 2^e (m normalized, sticky bit
/// folded into bit 0) into format B: tininess before rounding, `flush`
/// (FZ, not for halves) gives a zero with UFC, `ahp` the alternative half
/// format (exponent 31 is normal; overflow gives the largest value, IOC).
fn roundArm(comptime B: type, s: bool, e: i32, m: u64, rnd: Rounding, flush: bool, ahp: bool, fl: *u32) B {
    const p = P(B);
    const sb: B = if (s) p.sign else 0;
    const rmask: u64 = (@as(u64, 1) << p.extra) - 1;
    const half: u64 = @as(u64, 1) << (p.extra - 1);
    var biased: i32 = e + p.bias;
    if (biased < 1) {
        if (flush) {
            fl.* |= UFC;
            return sb;
        }
        const m2 = shrJam(m, @intCast(@min(1 - biased, 64)));
        var q = m2 >> p.extra;
        const rem = m2 & rmask;
        if (rem != 0) fl.* |= UFC | IXC;
        if (roundUp(rnd, s, q, rem, half)) q += 1;
        if (rnd == .odd and rem != 0) q |= 1;
        return sb | @as(B, @intCast(q)); // q == 2^mb carries into the exponent
    }
    var q = m >> p.extra;
    const rem = m & rmask;
    if (roundUp(rnd, s, q, rem, half)) q += 1;
    if (q >> (p.mb + 1) != 0) {
        q >>= 1;
        biased += 1;
    }
    if (rnd == .odd and rem != 0) q |= 1;
    if (ahp) {
        if (biased > p.emaxf) {
            fl.* |= IOC;
            return sb | ~p.sign;
        }
    } else if (biased >= p.emaxf) {
        fl.* |= OFC | IXC;
        const to_inf = switch (rnd) {
            .tieeven, .tieaway => true,
            .posinf => !s,
            .neginf => s,
            .zero, .odd => false,
        };
        return sb | (if (to_inf) p.inf else p.inf - 1);
    }
    if (rem != 0) fl.* |= IXC;
    return sb | (@as(B, @intCast(biased)) << p.mb) | (@as(B, @truncate(q)) & p.mmask);
}

/// FPConvertNaN: sign kept, quieted, payload truncated or zero-extended
/// from the top.
fn convertNaN(comptime To: type, comptime From: type, a: From) To {
    const pf = P(From);
    const pt = P(To);
    const frac: u64 = a & (pf.qbit - 1);
    const f: u64 = if (pt.mb >= pf.mb) frac << (pt.mb - pf.mb) else frac >> (pf.mb - pt.mb);
    const sb: To = if (signOf(From, a)) pt.sign else 0;
    return sb | pt.inf | pt.qbit | @as(To, @intCast(f));
}

/// FPConvert (FCVT, FCVTXN with .odd): `a` from format From to To (u16,
/// u32 or u64; different), rounded with `rnd`. Half operands and results
/// use the alternative format under FPCR.AHP and are never flushed.
pub fn convert(comptime To: type, comptime From: type, a: From, rnd: Rounding, fpcr: u32, fl: *u32) To {
    comptime std.debug.assert(To != From);
    const ahp = fpcr & c.FPCR_AHP != 0;
    const from_ahp = From == u16 and ahp;
    const to_ahp = To == u16 and ahp;
    const pt = P(To);
    const x = flushIn(From, a, fpcr, fl);
    const sb: To = if (signOf(From, x)) pt.sign else 0;
    if (!from_ahp and isNaN(From, x)) {
        if (isSnan(From, x) or to_ahp) fl.* |= IOC;
        if (to_ahp) return sb;
        if (fpcr & c.FPCR_DN != 0) return defaultNaN(To);
        return convertNaN(To, From, x);
    }
    if (!from_ahp and isInf(From, x)) {
        if (to_ahp) {
            fl.* |= IOC;
            return sb | ~pt.sign;
        }
        return sb | pt.inf;
    }
    if (isZero(From, x)) return sb;
    const u = unpack(From, x);
    const flush = To != u16 and fpcr & c.FPCR_FZ != 0;
    return roundArm(To, u.s, u.e, u.m, rnd, flush, to_ahp, fl);
}

/// FPToFixed: `a` * 2^fbits (fbits 0..64) rounded with `rnd` (not .odd) to
/// an `n`-bit (32 or 64) signed or unsigned integer, zero-extended to 64
/// bits. NaN gives 0, out-of-range values saturate; both raise IOC (and
/// then never IXC). B is u32 or u64.
pub fn toFixed(comptime B: type, a: B, fbits: u32, unsigned: bool, n: u7, rnd: Rounding, fpcr: u32, fl: *u32) u64 {
    const nmask = c.ones(n);
    const smax: u64 = nmask >> 1; // 2^(n-1) - 1
    const x = flushIn(B, a, fpcr, fl);
    const s = signOf(B, x);
    if (isNaN(B, x)) {
        fl.* |= IOC;
        return 0;
    }
    const sat: u64 = if (unsigned) (if (s) 0 else nmask) else (if (s) smax + 1 else smax);
    if (isInf(B, x)) {
        fl.* |= IOC;
        return sat;
    }
    if (isZero(B, x)) return 0;
    const u = unpack(B, x);
    const e = u.e + @as(i32, @intCast(fbits)); // value = m / 2^62 * 2^e
    if (e > 63) {
        fl.* |= IOC;
        return sat;
    }
    var int: u64 = 0;
    var rem: u64 = 1; // e < -1: below one half, not zero
    var hf: u64 = 2;
    if (e >= 62) {
        int = u.m << @intCast(e - 62);
        rem = 0;
    } else if (e >= -1) {
        const sh: u6 = @intCast(62 - e);
        int = u.m >> sh;
        rem = u.m & ((@as(u64, 1) << sh) - 1);
        hf = @as(u64, 1) << (sh - 1);
    }
    const mag = int + @intFromBool(roundUp(rnd, s, int, rem, hf)); // no wrap: e == 63 has rem == 0
    const over = if (unsigned) (s and mag != 0) or mag > nmask else mag > smax + @intFromBool(s);
    if (over) {
        fl.* |= IOC;
        return sat;
    }
    if (rem != 0) fl.* |= IXC;
    return (if (s) 0 -% mag else mag) & nmask;
}

/// FixedToFP: the `n`-bit (32 or 64) signed or unsigned integer `v` / 2^fbits
/// (fbits 0..64) rounded to format B with `rnd`. Zero is +0.
pub fn fromFixed(comptime B: type, v: u64, n: u7, fbits: u32, unsigned: bool, rnd: Rounding, fpcr: u32, fl: *u32) B {
    const x = v & c.ones(n);
    const s = !unsigned and (x >> @intCast(n - 1)) & 1 != 0;
    const mag = if (s) (0 -% x) & c.ones(n) else x;
    if (mag == 0) return 0;
    const lz: u32 = @clz(mag);
    const e: i32 = 63 - @as(i32, @intCast(lz)) - @as(i32, @intCast(fbits));
    const m = if (lz == 0) shrJam(mag, 1) else mag << @intCast(lz - 1);
    const flush = B != u16 and fpcr & c.FPCR_FZ != 0;
    return roundArm(B, s, e, m, rnd, flush, B == u16 and fpcr & c.FPCR_AHP != 0, fl);
}

/// VFPExpandImm: the FMOV immediate imm8 (sign, 3-bit exponent, 4-bit
/// fraction) in format B.
pub fn expandImm(comptime B: type, imm8: u8) B {
    const p = P(B);
    const b6: B = (imm8 >> 6) & 1;
    const run_: B = if (b6 != 0) (1 << (p.eb - 3)) - 1 else 0; // Replicate(imm8<6>, E - 3)
    const exp: B = ((b6 ^ 1) << (p.eb - 1)) | (run_ << 2) | ((imm8 >> 4) & 3);
    const sb: B = @as(B, imm8 >> 7) << (p.nbits - 1);
    return sb | (exp << p.mb) | (@as(B, imm8 & 15) << (p.mb - 4));
}

// ---- tests ---------------------------------------------------------------------

const t = std.testing;

fn f32b(x: f32) u32 {
    return @bitCast(x);
}
fn f64b(x: f64) u64 {
    return @bitCast(x);
}

const RM_P: u32 = 1 << c.FPCR_RMODE_SHIFT;

test "a64 fparith: NaN propagation, default NaN, FMA's quiet-NaN addend" {
    var fl: u32 = 0;
    const sn: u32 = 0xff80_1234;
    const qn: u32 = 0x7fc0_0042;
    try t.expectEqual(@as(u32, 0xffc0_1234), add(u32, qn, sn, 0, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(qn, mul(u32, f32b(1), qn, 0, &fl));
    try t.expectEqual(@as(u32, 0), fl);
    try t.expectEqual(@as(u32, 0x7fc0_0000), sub(u32, qn, f32b(1), c.FPCR_DN, &fl));
    // sub keeps the second operand's NaN sign
    try t.expectEqual(@as(u32, 0xffc0_0042), sub(u32, f32b(1), qn | 0x8000_0000, 0, &fl));
    // fma: addend first, Inf*0 + qNaN = default NaN with IOC
    fl = 0;
    try t.expectEqual(@as(u32, 0x7fc0_0000), mulAdd(u32, qn, f32b(std.math.inf(f32)), 0, 0, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(qn, mulAdd(u32, qn, 0x7fc0_0001, f32b(1), 0, &fl));
    try t.expectEqual(@as(u32, 0x7fc0_0007), mulAdd(u32, qn, f32b(2), 0x7f80_0007, 0, &fl));
    try t.expectEqual(IOC, fl);
    // conversions keep the payload's top bits
    fl = 0;
    try t.expectEqual(@as(u64, 0xfff8_0000_0000_0000 | 0x12340 << 29), convert(u64, u32, 0xff81_2340, .tieeven, 0, &fl));
    try t.expectEqual(@as(u32, 0x7fc0_0001), convert(u32, u64, 0x7ff0_0000_2000_0000, .tieeven, 0, &fl));
    try t.expectEqual(@as(u16, 0x7e01), convert(u16, u32, 0x7f80_2000, .tieeven, 0, &fl));
}

test "a64 fparith: tininess before rounding and flush to zero" {
    // the largest single below 2^-126 times (1 + 2^-23) rounds up to 2^-126
    const below: u32 = 0x007f_ffff;
    const up = f32b(1.0) + 1;
    var fl: u32 = 0;
    try t.expectEqual(@as(u32, 0x0080_0000), mul(u32, below, up, 0, &fl));
    try t.expectEqual(UFC | IXC, fl); // RISC-V: IXC only
    fl = 0;
    try t.expectEqual(@as(u32, 0x0080_0000), mul(u32, 0x0080_0001, f32b(1.0) - 1, 0, &fl));
    try t.expectEqual(IXC, fl); // above 2^-126 before rounding
    fl = 0;
    try t.expectEqual(@as(u32, 0), mul(u32, below, up, c.FPCR_FZ, &fl)); // denormal input
    try t.expectEqual(IDC, fl);
    // normal inputs: (2^-126)(1 + 2^-23)(1 - 2^-23) rounds to 2^-126: tiny before rounding
    fl = 0;
    try t.expectEqual(@as(u32, 0x0080_0000), mul(u32, 0x0080_0001, 0x3f7f_fffe, 0, &fl));
    try t.expectEqual(UFC | IXC, fl);
    fl = 0;
    try t.expectEqual(@as(u32, 0), mul(u32, 0x0080_0001, 0x3f7f_fffe, c.FPCR_FZ, &fl));
    try t.expectEqual(UFC, fl);
    fl = 0;
    try t.expectEqual(@as(u32, 0), mul(u32, 0x0080_0001, 0x3f7f_fffe, c.FPCR_FZ | RM_P, &fl));
    try t.expectEqual(UFC, fl);
    fl = 0;
    try t.expectEqual(@as(u32, 0x8000_0000), mul(u32, f32b(-0x1p-100), f32b(0x1p-30), c.FPCR_FZ, &fl));
    try t.expectEqual(UFC, fl); // exact denormal flushed: no IXC
    fl = 0;
    try t.expectEqual(@as(u32, 0x0000_0002), mul(u32, f32b(0x1p-100), f32b(0x1p-48), 0, &fl));
    try t.expectEqual(@as(u32, 0), fl); // exact denormal: no UFC
    fl = 0;
    try t.expectEqual(f32b(1), add(u32, f32b(1), 1, c.FPCR_FZ, &fl));
    try t.expectEqual(IDC, fl);
    fl = 0;
    // fz: denormal divisor is zero
    try t.expectEqual(f32b(-std.math.inf(f32)), div(u32, f32b(1), 0x8000_0001, c.FPCR_FZ, &fl));
    try t.expectEqual(IDC | DZC, fl);
    fl = 0;
    try t.expectEqual(@as(u32, 0x8000_0000), sqrt(u32, 0x8000_0001, c.FPCR_FZ, &fl));
    try t.expectEqual(IDC, fl);
    // double to single
    fl = 0;
    try t.expectEqual(@as(u32, 0x0080_0000), convert(u32, u64, f64b(0x1p-126) - 1, .tieeven, 0, &fl));
    try t.expectEqual(UFC | IXC, fl);
    fl = 0;
    try t.expectEqual(@as(u32, 0), convert(u32, u64, f64b(0x1p-126) - 1, .tieeven, c.FPCR_FZ, &fl));
    try t.expectEqual(UFC, fl);
}

test "a64 fparith: min, max, compare" {
    var fl: u32 = 0;
    const qn: u64 = 0x7ff8_0000_0000_0009;
    try t.expectEqual(f64b(0.0), max(u64, f64b(-0.0), f64b(0.0), 0, &fl));
    try t.expectEqual(f64b(-0.0), min(u64, f64b(0.0), f64b(-0.0), 0, &fl));
    try t.expectEqual(qn, max(u64, f64b(1), qn, 0, &fl));
    try t.expectEqual(f64b(1), maxNum(u64, f64b(1), qn, 0, &fl));
    try t.expectEqual(f64b(-5), minNum(u64, qn, f64b(-5), 0, &fl));
    try t.expectEqual(@as(u32, 0), fl);
    try t.expectEqual(@as(u64, 0x7ff8_0000_0000_0001), maxNum(u64, qn, 0x7ff0_0000_0000_0001, 0, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(c.C | c.V, compare(u64, qn, f64b(1), false, 0, &fl));
    try t.expectEqual(@as(u32, 0), fl);
    try t.expectEqual(c.C | c.V, compare(u64, qn, f64b(1), true, 0, &fl));
    try t.expectEqual(IOC, fl);
    try t.expectEqual(c.Z | c.C, compare(u64, f64b(-0.0), 0, false, 0, &fl));
    try t.expectEqual(c.N, compare(u64, f64b(-1), 0, false, 0, &fl));
    try t.expectEqual(c.C, compare(u64, f64b(1), 0, false, 0, &fl));
    fl = 0;
    try t.expectEqual(c.Z | c.C, compare(u64, 1, 0, false, c.FPCR_FZ, &fl));
    try t.expectEqual(IDC, fl);
    try t.expect(cmpEq(u32, 0x8000_0000, 0, 0, &fl));
    try t.expect(cmpGe(u32, 0x8000_0000, 0, 0, &fl));
    try t.expect(!cmpGt(u32, 0x8000_0000, 0, 0, &fl));
    try t.expectEqual(f64b(2.0), mulx(u64, f64b(std.math.inf(f64)), 0, 0, &fl));
    try t.expectEqual(f64b(-2.0), mulx(u64, f64b(-0.0), f64b(std.math.inf(f64)), 0, &fl));
}

test "a64 fparith: integer and fixed-point conversions, rounding to integral" {
    var fl: u32 = 0;
    try t.expectEqual(@as(u64, 0), toFixed(u64, 0x7ff8_0000_0000_0000, 0, false, 64, .zero, 0, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(@as(u64, 0x8000_0000), toFixed(u64, f64b(-3e9), 0, false, 32, .zero, 0, &fl));
    try t.expectEqual(@as(u64, 0xffff_ffff), toFixed(u64, f64b(5e9), 0, true, 32, .zero, 0, &fl));
    try t.expectEqual(@as(u64, 0), toFixed(u64, f64b(-1.0), 0, true, 64, .zero, 0, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(@as(u64, 0), toFixed(u64, f64b(-0.4), 0, true, 64, .tieeven, 0, &fl));
    try t.expectEqual(IXC, fl);
    try t.expectEqual(@as(u64, 0xffff_fffd), toFixed(u32, f32b(-2.5), 0, false, 32, .tieaway, 0, &fl));
    try t.expectEqual(@as(u64, 0xffff_fffe), toFixed(u32, f32b(-2.5), 0, false, 32, .tieeven, 0, &fl));
    try t.expectEqual(@as(u64, 0xffff_fffd), toFixed(u32, f32b(-2.5), 0, false, 32, .neginf, 0, &fl));
    try t.expectEqual(@as(u64, 3), toFixed(u32, f32b(2.5), 0, false, 32, .posinf, 0, &fl));
    try t.expectEqual(@as(u64, 0x8000_0000_0000_0000), toFixed(u64, f64b(-0x1p63), 0, false, 64, .zero, 0, &fl));
    try t.expectEqual(@as(u64, 0xffff_ffff_ffff_f800), toFixed(u64, f64b(0x1p64) - 1, 0, true, 64, .zero, 0, &fl));
    try t.expectEqual(@as(u64, 10), toFixed(u32, f32b(2.5), 2, false, 32, .zero, 0, &fl));
    try t.expectEqual(@as(u64, 1 << 63), toFixed(u64, f64b(1.0), 63, true, 64, .zero, 0, &fl));
    fl = 0;
    try t.expectEqual(@as(u64, 0xffff_ffff_ffff_ffff), toFixed(u64, f64b(1.0), 64, true, 64, .zero, 0, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(f32b(0.25), fromFixed(u32, 1, 32, 2, false, .tieeven, 0, &fl));
    try t.expectEqual(f32b(-1.0), fromFixed(u32, 0xffff_ffff, 32, 0, false, .tieeven, 0, &fl));
    try t.expectEqual(f32b(4294967296.0), fromFixed(u32, 0xffff_ffff, 32, 0, true, .tieeven, 0, &fl));
    try t.expectEqual(f64b(-0x1p63), fromFixed(u64, 1 << 63, 64, 0, false, .tieeven, 0, &fl));
    try t.expectEqual(f64b(0x1p-64), fromFixed(u64, 1, 64, 64, true, .tieeven, 0, &fl));
    try t.expectEqual(f32b(3.0), roundInt(u32, f32b(2.5), .tieaway, false, 0, &fl));
    try t.expectEqual(f32b(-0.0), roundInt(u32, f32b(-0.4), .tieeven, true, 0, &fl));
    try t.expectEqual(f32b(-1.0), roundInt(u32, f32b(-0.4), .neginf, true, 0, &fl));
    try t.expectEqual(@as(u32, 0x7fc0_0001), roundInt(u32, 0x7f80_0001, .zero, false, 0, &fl));
}

test "a64 fparith: half precision and AHP" {
    var fl: u32 = 0;
    try t.expectEqual(f32b(65504.0), convert(u32, u16, 0x7bff, .tieeven, 0, &fl));
    try t.expectEqual(f32b(65536.0), convert(u32, u16, 0x7c00, .tieeven, c.FPCR_AHP, &fl));
    try t.expectEqual(f32b(131008.0), convert(u32, u16, 0x7fff, .tieeven, c.FPCR_AHP, &fl));
    try t.expectEqual(f32b(0x1p-24), convert(u32, u16, 0x0001, .tieeven, c.FPCR_FZ, &fl));
    try t.expectEqual(@as(u32, 0), fl);
    try t.expectEqual(@as(u16, 0x7c00), convert(u16, u32, f32b(65520.0), .tieeven, 0, &fl));
    try t.expectEqual(OFC | IXC, fl);
    fl = 0;
    try t.expectEqual(@as(u16, 0x7bff), convert(u16, u32, f32b(65520.0), .zero, 0, &fl));
    fl = 0;
    try t.expectEqual(@as(u16, 0x7c00), convert(u16, u32, f32b(65520.0), .tieeven, c.FPCR_AHP, &fl));
    try t.expectEqual(IXC, fl);
    fl = 0;
    try t.expectEqual(@as(u16, 0xffff), convert(u16, u64, f64b(-1e6), .tieeven, c.FPCR_AHP, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(@as(u16, 0x8000), convert(u16, u32, 0xffc0_0000, .tieeven, c.FPCR_AHP, &fl));
    try t.expectEqual(IOC, fl);
    fl = 0;
    try t.expectEqual(@as(u16, 0x0001), convert(u16, u32, f32b(0x1p-24), .tieeven, c.FPCR_FZ, &fl));
    try t.expectEqual(@as(u16, 0x0001), convert(u16, u32, f32b(0x1p-25) + 1, .tieeven, 0, &fl));
    try t.expectEqual(UFC | IXC, fl);
    fl = 0;
    try t.expectEqual(@as(u32, 0x3f80_0001), convert(u32, u64, f64b(1.0) + 1, .odd, 0, &fl));
    try t.expectEqual(IXC, fl);
    try t.expectEqual(@as(u32, 0x7f7f_ffff), convert(u32, u64, f64b(1e300), .odd, 0, &fl));
    try t.expectEqual(f32b(2.0), expandImm(u32, 0x00));
    try t.expectEqual(f64b(-0.125), expandImm(u64, 0xc0));
    try t.expectEqual(f32b(31.0), expandImm(u32, 0x3f));
    try t.expectEqual(f64b(1.0), expandImm(u64, 0x70));
    try t.expectEqual(@as(u16, 0x3c00), expandImm(u16, 0x70));
}

/// A random value of format B biased towards NaNs, infinities, zeros,
/// denormals and the edges of the normal and integer ranges.
fn rndFp(comptime B: type, r: std.Random) B {
    const p = P(B);
    var m: B = r.int(B) & p.mmask;
    if (r.boolean()) m &= ~((@as(B, 1) << (p.mb / 2)) - 1);
    const emax: u32 = p.emaxf;
    const bias: u32 = @intCast(p.bias);
    const e: u32 = switch (r.uintLessThan(u32, 10)) {
        0 => 0,
        1 => emax,
        2 => r.uintLessThan(u32, 3),
        3 => emax - 1 - r.uintLessThan(u32, 2),
        4 => bias + r.uintLessThan(u32, 70),
        5 => bias / 2 + r.uintLessThan(u32, 5) - 2,
        else => r.uintAtMost(u32, emax),
    };
    return (if (r.boolean()) p.sign else 0) | (@as(B, @intCast(e)) << p.mb) | m;
}

test "a64 fparith: every primitive over random operands and FPCR values (safety checks)" {
    var prng = std.Random.DefaultPrng.init(0xa64f);
    const r = prng.random();
    const rnds = [_]Rounding{ .tieeven, .posinf, .neginf, .zero, .tieaway };
    var sink: u64 = 0;
    for (0..60_000) |_| {
        const fc: u32 = @as(u32, r.uintLessThan(u32, 32)) << c.FPCR_RMODE_SHIFT;
        const rnd = rnds[r.uintLessThan(usize, rnds.len)];
        var fl: u32 = 0;
        inline for (.{ u32, u64 }) |B| {
            const a = rndFp(B, r);
            const b = rndFp(B, r);
            const d = rndFp(B, r);
            sink +%= add(B, a, b, fc, &fl) +% sub(B, a, b, fc, &fl) +% mul(B, a, b, fc, &fl);
            sink +%= div(B, a, b, fc, &fl) +% mulx(B, a, b, fc, &fl) +% mulAdd(B, d, a, b, fc, &fl);
            sink +%= sqrt(B, a, fc, &fl) +% max(B, a, b, fc, &fl) +% minNum(B, a, b, fc, &fl);
            sink +%= compare(B, a, b, r.boolean(), fc, &fl) +% @intFromBool(cmpGe(B, a, b, fc, &fl));
            sink +%= roundInt(B, a, rnd, r.boolean(), fc, &fl);
            sink +%= recipStep(B, a, b, fc, &fl) +% rsqrtStep(B, a, b, fc, &fl) +% recpX(B, a, fc, &fl);
            sink +%= recipEstimate(B, a, fc, &fl) +% rsqrtEstimate(B, a, fc, &fl);
            const fb = r.uintAtMost(u32, 64);
            sink +%= toFixed(B, a, fb, r.boolean(), 64, rnd, fc, &fl) +% toFixed(B, a, fb % 33, r.boolean(), 32, rnd, fc, &fl);
            sink +%= fromFixed(B, r.int(u64), 64, fb, r.boolean(), rnd, fc, &fl);
            sink +%= fromFixed(B, r.int(u64), 32, fb % 33, r.boolean(), rnd, fc, &fl);
            sink +%= convert(u16, B, a, rnd, fc, &fl) +% convert(B, u16, rndFp(u16, r), rnd, fc, &fl);
            // integral round trips: an integral value converts back exactly
            const ri = roundInt(B, a, .zero, false, 0, &fl);
            if (!isNaN(B, ri) and !isInf(B, ri) and abs(B, ri) < (@as(B, @intCast(P(B).bias + 52)) << P(B).mb)) {
                var f2: u32 = 0;
                const iv = toFixed(B, ri, 0, false, 64, .zero, 0, &f2);
                if (f2 == 0) try t.expectEqual(ri & ~@as(B, if (iv == 0) P(B).sign else 0), fromFixed(B, iv, 64, 0, false, .zero, 0, &f2));
            }
        }
        sink +%= convert(u32, u64, rndFp(u64, r), .odd, fc, &fl) +% convert(u64, u32, rndFp(u32, r), rnd, fc, &fl);
        try t.expect(fl & ~@as(u32, 0x9f) == 0);
    }
    std.mem.doNotOptimizeAway(sink);
}
