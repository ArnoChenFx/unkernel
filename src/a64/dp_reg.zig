// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Data processing -- register (op0 = x101): logical (shifted register),
//! add/subtract (shifted and extended register), add/subtract with carry,
//! conditional compare (register and immediate), conditional select,
//! data-processing 1-source (RBIT, REV16, REV32, REV, CLZ, CLS),
//! 2-source (UDIV, SDIV, LSLV, LSRV, ASRV, RORV) and 3-source (MADD, MSUB,
//! SMADDL, SMSUBL, UMADDL, UMSUBL, SMULH, UMULH). Complete for ARMv8.0;
//! CRC32/CRC32C (optional, KW_ISA_CRC32) are crypto.crc32, called from
//! `twoSource`. FEAT_FlagM (RMIF, SETF8/16), PAC and MTE forms are ILLEGAL.

const std = @import("std");
const c = @import("common.zig");
const fpu = c.fpu;
const addSub = @import("dp_imm.zig").addSub;

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    const op1 = c.bit(inst, 28);
    const op2 = c.bits(inst, 24, 21);
    if (!op1) {
        if (op2 & 8 == 0) return logicalShifted(s, inst);
        if (op2 & 1 == 0) return addSubShifted(s, inst);
        return addSubExtended(s, inst);
    }
    if (op2 & 8 != 0) return threeSource(s, inst);
    return switch (op2) {
        0 => if (c.bits(inst, 15, 10) == 0) addSubCarry(s, inst) else c.ill(s, inst),
        2 => condCompare(s, inst),
        4 => condSelect(s, inst),
        6 => if (c.bit(inst, 30)) oneSource(s, inst) else twoSource(s, inst),
        else => c.ill(s, inst),
    };
}

fn logicalShifted(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const amount: u6 = @intCast(c.bits(inst, 15, 10));
    if (!sf and amount >= 32) return c.ill(s, inst);
    const a = c.reg(s, sf, c.rn(inst));
    var b = c.shiftReg(sf, c.reg(s, sf, c.rm(inst)), @intCast(c.bits(inst, 23, 22)), amount);
    if (c.bit(inst, 21)) b = ~b; // BIC, ORN, EON, BICS
    const opc = c.bits(inst, 30, 29);
    const r = switch (opc) {
        0, 3 => a & b,
        1 => a | b,
        2 => a ^ b,
        else => unreachable,
    };
    if (opc == 3) s.r.nzcv = c.nzLogic(sf, r);
    c.setR(s, sf, c.rd(inst), r);
    return .next;
}

fn addSubShifted(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const typ = c.bits(inst, 23, 22);
    const amount: u6 = @intCast(c.bits(inst, 15, 10));
    if (typ == 3 or (!sf and amount >= 32)) return c.ill(s, inst);
    const b = c.shiftReg(sf, c.reg(s, sf, c.rm(inst)), @intCast(typ), amount);
    return addSubFinish(s, inst, sf, c.reg(s, sf, c.rn(inst)), b, false);
}

fn addSubExtended(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const shift = c.bits(inst, 12, 10);
    if (c.bits(inst, 23, 22) != 0 or shift > 4) return c.ill(s, inst);
    const b = c.extendReg(c.xr(s, c.rm(inst)), @intCast(c.bits(inst, 15, 13)), @intCast(shift));
    return addSubFinish(s, inst, sf, c.regSp(s, sf, c.rn(inst)), b, true);
}

/// ADD/ADDS/SUB/SUBS: Rd is SP for the extended form without flags.
fn addSubFinish(s: c.St, inst: u32, sf: bool, a: u64, b: u64, sp_dest: bool) c.Exit {
    const res = addSub(sf, a, b, c.bit(inst, 30));
    if (c.bit(inst, 29)) {
        s.r.nzcv = res.nzcv;
        c.setR(s, sf, c.rd(inst), res.r);
    } else if (sp_dest) c.setRsp(s, sf, c.rd(inst), res.r) else c.setR(s, sf, c.rd(inst), res.r);
    return .next;
}

fn addSubCarry(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const a = c.reg(s, sf, c.rn(inst));
    var b = c.reg(s, sf, c.rm(inst));
    if (c.bit(inst, 30)) b = ~b; // SBC, SBCS
    const res = c.addWithCarry(sf, a, b, @intFromBool(s.r.nzcv & c.C != 0));
    if (c.bit(inst, 29)) s.r.nzcv = res.nzcv;
    c.setR(s, sf, c.rd(inst), res.r);
    return .next;
}

/// CCMP, CCMN (register and immediate).
fn condCompare(s: c.St, inst: u32) c.Exit {
    if (!c.bit(inst, 29) or c.bit(inst, 10) or c.bit(inst, 4)) return c.ill(s, inst);
    const sf = c.bit(inst, 31);
    if (c.condHolds(s.r.nzcv, @intCast(c.bits(inst, 15, 12)))) {
        const a = c.reg(s, sf, c.rn(inst));
        const b: u64 = if (c.bit(inst, 11)) c.bits(inst, 20, 16) else c.reg(s, sf, c.rm(inst));
        s.r.nzcv = addSub(sf, a, b, c.bit(inst, 30)).nzcv; // op 1 = CCMP
    } else s.r.nzcv = c.bits(inst, 3, 0) << 28;
    return .next;
}

/// CSEL, CSINC, CSINV, CSNEG.
fn condSelect(s: c.St, inst: u32) c.Exit {
    if (c.bit(inst, 29) or c.bit(inst, 11)) return c.ill(s, inst);
    const sf = c.bit(inst, 31);
    const r = if (c.condHolds(s.r.nzcv, @intCast(c.bits(inst, 15, 12))))
        c.reg(s, sf, c.rn(inst))
    else blk: {
        const b = c.reg(s, sf, c.rm(inst));
        break :blk switch ((@as(u32, @intFromBool(c.bit(inst, 30))) << 1) | c.bits(inst, 10, 10)) {
            0 => b,
            1 => b +% 1,
            2 => ~b,
            3 => 0 -% b,
            else => unreachable,
        };
    };
    c.setR(s, sf, c.rd(inst), r);
    return .next;
}

fn oneSource(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    if (c.bit(inst, 29) or c.bits(inst, 20, 16) != 0) return c.ill(s, inst); // PAC (opcode2 = 1), unallocated
    const a = c.reg(s, sf, c.rn(inst));
    const r: u64 = switch (c.bits(inst, 15, 10)) {
        0 => if (sf) @bitReverse(a) else @bitReverse(@as(u32, @truncate(a))), // RBIT
        1 => rev16(a), // REV16
        2 => if (sf) rev32(a) else @byteSwap(@as(u32, @truncate(a))), // REV32 / REV (W)
        3 => if (sf) @byteSwap(a) else return c.ill(s, inst), // REV (X)
        4 => if (sf) @clz(a) else @clz(@as(u32, @truncate(a))), // CLZ
        5 => cls(sf, a), // CLS
        else => return c.ill(s, inst),
    };
    c.setR(s, sf, c.rd(inst), r);
    return .next;
}

/// Byte-swap each halfword.
pub fn rev16(a: u64) u64 {
    return ((a >> 8) & 0x00ff_00ff_00ff_00ff) | ((a & 0x00ff_00ff_00ff_00ff) << 8);
}
/// Byte-swap each word.
pub fn rev32(a: u64) u64 {
    return std.math.rotr(u64, @byteSwap(a), 32);
}
/// Count leading sign bits (not counting the sign bit itself).
pub fn cls(sf: bool, a: u64) u64 {
    if (sf) return @clz(a ^ (a << 1) | 1);
    const w: u32 = @truncate(a);
    return @clz(w ^ (w << 1) | 1);
}

fn twoSource(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    if (c.bit(inst, 29)) return c.ill(s, inst);
    const a = c.reg(s, sf, c.rn(inst));
    const b = c.reg(s, sf, c.rm(inst));
    const r: u64 = switch (c.bits(inst, 15, 10)) {
        2 => udiv(sf, a, b),
        3 => sdiv(sf, a, b),
        8, 9, 10, 11 => c.shiftReg(sf, a, @intCast(c.bits(inst, 11, 10)), @truncate(if (sf) b & 63 else b & 31)), // LSLV, LSRV, ASRV, RORV
        16...23 => return @import("crypto.zig").crc32(s, inst), // CRC32B/H/W/X, CRC32CB/CH/CW/CX
        else => return c.ill(s, inst), // MTE, PACGA
    };
    c.setR(s, sf, c.rd(inst), r);
    return .next;
}

/// UDIV: division by zero gives 0.
pub fn udiv(sf: bool, a: u64, b: u64) u64 {
    if (b == 0) return 0;
    if (sf) return a / b;
    return @as(u32, @truncate(a)) / @as(u32, @truncate(b));
}
/// SDIV: rounds towards zero; division by zero gives 0, MIN / -1 gives MIN.
pub fn sdiv(sf: bool, a: u64, b: u64) u64 {
    if (b == 0) return 0;
    if (sf) {
        const x: i64 = @bitCast(a);
        const y: i64 = @bitCast(b);
        if (y == -1) return 0 -% a;
        return @bitCast(@divTrunc(x, y));
    }
    const x: i32 = @bitCast(@as(u32, @truncate(a)));
    const y: i32 = @bitCast(@as(u32, @truncate(b)));
    if (y == -1) return @as(u32, @bitCast(0 -% @as(u32, @bitCast(x))));
    return @as(u32, @bitCast(@divTrunc(x, y)));
}

fn threeSource(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    if (c.bits(inst, 30, 29) != 0) return c.ill(s, inst);
    const op31 = c.bits(inst, 23, 21);
    const sub = c.bit(inst, 15);
    const n = c.xr(s, c.rn(inst));
    const m = c.xr(s, c.rm(inst));
    const acc = c.xr(s, c.ra(inst));
    const r: u64 = switch (op31) {
        0 => blk: { // MADD, MSUB
            const p = n *% m;
            break :blk if (sub) acc -% p else acc +% p;
        },
        1, 5 => blk: { // SMADDL, SMSUBL, UMADDL, UMSUBL
            if (!sf) return c.ill(s, inst);
            const p = if (op31 == 1) c.sext(n, 32) *% c.sext(m, 32) else (n & 0xffff_ffff) * (m & 0xffff_ffff);
            break :blk if (sub) acc -% p else acc +% p;
        },
        2 => if (sf and !sub) fpu.mulh(n, m) else return c.ill(s, inst), // SMULH
        6 => if (sf and !sub) fpu.mul64(n, m).hi else return c.ill(s, inst), // UMULH
        else => return c.ill(s, inst),
    };
    c.setR(s, sf, c.rd(inst), r);
    return .next;
}
