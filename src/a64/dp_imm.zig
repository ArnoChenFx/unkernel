// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Data processing -- immediate (op0 = 100x): PC-relative addressing (ADR,
//! ADRP), add/subtract immediate (ADD, ADDS, SUB, SUBS and the aliases MOV
//! to/from SP, CMP, CMN), logical immediate (AND, ORR, EOR, ANDS; MOV,
//! TST), move wide (MOVN, MOVZ, MOVK), bitfield (SBFM, BFM, UBFM and their
//! aliases ASR, LSL, LSR, SXT*, UXT*, BFI, BFXIL, SBFX, UBFX, ...), and
//! extract (EXTR, ROR). Complete for ARMv8.0; the MTE forms (ADDG, SUBG)
//! and anything reserved are ILLEGAL.

const std = @import("std");
const c = @import("common.zig");

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    return switch (c.bits(inst, 25, 23)) {
        0b000, 0b001 => pcRel(s, inst),
        0b010 => addSubImm(s, inst),
        0b100 => logicalImm(s, inst),
        0b101 => moveWide(s, inst),
        0b110 => bitfield(s, inst),
        0b111 => extract(s, inst),
        else => c.ill(s, inst), // 011: add/subtract immediate with tags (MTE)
    };
}

fn pcRel(s: c.St, inst: u32) c.Exit {
    const imm = c.sextN((c.bits(inst, 23, 5) << 2) | c.bits(inst, 30, 29), 21);
    const pc = s.r.pc;
    const v = if (c.bit(inst, 31)) (pc & ~@as(u64, 0xfff)) +% (imm << 12) else pc +% imm;
    c.setX(s, c.rd(inst), v);
    return .next;
}

fn addSubImm(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const sub = c.bit(inst, 30);
    const setflags = c.bit(inst, 29);
    var imm: u64 = c.bits(inst, 21, 10);
    if (c.bit(inst, 22)) imm <<= 12;
    const a = c.regSp(s, sf, c.rn(inst));
    const res = addSub(sf, a, imm, sub);
    if (setflags) {
        s.r.nzcv = res.nzcv;
        c.setR(s, sf, c.rd(inst), res.r);
    } else c.setRsp(s, sf, c.rd(inst), res.r);
    return .next;
}

/// a + b or a - b with flags, at 32 or 64 bits (shared with dp_reg).
pub fn addSub(sf: bool, a: u64, b: u64, sub: bool) c.Flagged {
    return if (sub) c.addWithCarry(sf, a, ~b, 1) else c.addWithCarry(sf, a, b, 0);
}

fn logicalImm(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const n: u1 = @intFromBool(c.bit(inst, 22));
    if (!sf and n == 1) return c.ill(s, inst);
    const m = c.decodeBitMasks(n, @intCast(c.bits(inst, 15, 10)), @intCast(c.bits(inst, 21, 16)), true, if (sf) 64 else 32) orelse
        return c.ill(s, inst);
    const a = c.reg(s, sf, c.rn(inst));
    const opc = c.bits(inst, 30, 29);
    const r = switch (opc) {
        0, 3 => a & m.wmask,
        1 => a | m.wmask,
        2 => a ^ m.wmask,
        else => unreachable,
    };
    if (opc == 3) {
        s.r.nzcv = c.nzLogic(sf, r);
        c.setR(s, sf, c.rd(inst), r);
    } else c.setRsp(s, sf, c.rd(inst), r);
    return .next;
}

fn moveWide(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const hw = c.bits(inst, 22, 21);
    if (!sf and hw >= 2) return c.ill(s, inst);
    const sh: u6 = @intCast(hw * 16);
    const imm = @as(u64, c.bits(inst, 20, 5)) << sh;
    const d = c.rd(inst);
    switch (c.bits(inst, 30, 29)) {
        0 => c.setR(s, sf, d, ~imm), // MOVN
        2 => c.setR(s, sf, d, imm), // MOVZ
        3 => c.setR(s, sf, d, (c.xr(s, d) & ~(@as(u64, 0xffff) << sh)) | imm), // MOVK
        else => return c.ill(s, inst),
    }
    return .next;
}

fn bitfield(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const n = c.bit(inst, 22);
    const opc = c.bits(inst, 30, 29);
    const immr: u6 = @intCast(c.bits(inst, 21, 16));
    const imms: u6 = @intCast(c.bits(inst, 15, 10));
    if (opc == 3 or sf != n) return c.ill(s, inst);
    if (!sf and (immr >= 32 or imms >= 32)) return c.ill(s, inst);
    const m = c.decodeBitMasks(@intFromBool(n), imms, immr, false, if (sf) 64 else 32) orelse return c.ill(s, inst);
    const d = c.rd(inst);
    const src = c.reg(s, sf, c.rn(inst));
    c.setR(s, sf, d, bitfieldOp(sf, opc, c.reg(s, sf, d), src, immr, imms, m));
    return .next;
}

/// SBFM (opc 0), BFM (1), UBFM (2) given the decoded masks; `dst` is the
/// old destination (used by BFM only).
pub fn bitfieldOp(sf: bool, opc: u32, dst: u64, src: u64, immr: u6, imms: u6, m: c.BitMasks) u64 {
    const base = if (opc == 1) dst else 0;
    const bot = (base & ~m.wmask) | (c.shiftReg(sf, src, 3, immr) & m.wmask);
    const top: u64 = if (opc == 0) 0 -% ((src >> imms) & 1) else base;
    return (top & ~m.tmask) | (bot & m.tmask);
}

fn extract(s: c.St, inst: u32) c.Exit {
    const sf = c.bit(inst, 31);
    const lsb: u6 = @intCast(c.bits(inst, 15, 10));
    if (c.bits(inst, 30, 29) != 0 or c.bit(inst, 21) or c.bit(inst, 22) != sf) return c.ill(s, inst);
    if (!sf and lsb >= 32) return c.ill(s, inst);
    const hi = c.reg(s, sf, c.rn(inst));
    const lo = c.reg(s, sf, c.rm(inst));
    c.setR(s, sf, c.rd(inst), extr(sf, hi, lo, lsb));
    return .next;
}

/// EXTR: bits lsb.. of hi:lo, at 32 or 64 bits.
pub fn extr(sf: bool, hi: u64, lo: u64, lsb: u6) u64 {
    if (lsb == 0) return lo;
    const w: u7 = if (sf) 64 else 32;
    return (lo >> lsb) | (hi << @intCast(w - lsb));
}
