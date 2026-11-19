// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Branches, exception generation and system instructions (op0 = 101x):
//! B, BL, B.cond, CBZ, CBNZ, TBZ, TBNZ, BR, BLR, RET; SVC, BRK; the hint
//! space (all NOPs: NOP, YIELD, WFE, WFI, SEV, SEVL, and the PAC/BTI hints,
//! no FEAT_PAuth/FEAT_BTI); barriers (CLREX, DMB, DSB, ISB); cache
//! maintenance EL0 may use (DC ZVA, DC CVAU/CVAC/CIVAC, IC IVAU); MRS/MSR of
//! the EL0 system registers Linux allows (`sysreg`), including CNTVCT_EL0
//! (retired instructions, see `finishCounter`), CNTFRQ_EL0 and the ID
//! registers Linux emulates for EL0 (`idReg`).
//!
//! ILLEGAL: HVC, SMC, HLT, DCPS, ERET, DRPS, UDF (decode.zig), the PAC
//! branch forms (BRAA, RETAA, ...), MSR (immediate) PSTATE fields, SYSL,
//! SB, DSB nXS, and every system register or SYS operation not listed in
//! `sysreg` and `sysOp`.

const c = @import("common.zig");
const core = @import("../cpu/core.zig");

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    if (inst & 0x7c00_0000 == 0x1400_0000) return branchImm(s, inst);
    if (inst & 0x7e00_0000 == 0x3400_0000) return cmpBranch(s, inst);
    if (inst & 0x7e00_0000 == 0x3600_0000) return testBranch(s, inst);
    if (inst & 0xff00_0010 == 0x5400_0000) return condBranch(s, inst);
    if (inst & 0xff00_0000 == 0xd400_0000) return exception(s, inst);
    if (inst & 0xffc0_0000 == 0xd500_0000) return system(s, inst);
    if (inst & 0xfe00_0000 == 0xd600_0000) return branchReg(s, inst);
    return c.ill(s, inst);
}

fn branchImm(s: c.St, inst: u32) c.Exit {
    const off = c.sextN(@as(u64, c.bits(inst, 25, 0)) << 2, 28);
    if (c.bit(inst, 31)) s.r.x[30] = s.r.pc +% 4; // BL
    return c.jump(s, s.r.pc +% off);
}

fn cmpBranch(s: c.St, inst: u32) c.Exit {
    const v = c.reg(s, c.bit(inst, 31), c.rd(inst));
    if ((v == 0) == c.bit(inst, 24)) return .next; // CBZ: bit 24 = 0
    return c.jump(s, s.r.pc +% c.sextN(@as(u64, c.bits(inst, 23, 5)) << 2, 21));
}

fn testBranch(s: c.St, inst: u32) c.Exit {
    const b: u6 = @intCast((c.bits(inst, 31, 31) << 5) | c.bits(inst, 23, 19));
    const set = (c.xr(s, c.rd(inst)) >> b) & 1 != 0;
    if (set != c.bit(inst, 24)) return .next; // TBZ: bit 24 = 0
    return c.jump(s, s.r.pc +% c.sextN(@as(u64, c.bits(inst, 18, 5)) << 2, 16));
}

fn condBranch(s: c.St, inst: u32) c.Exit {
    if (c.bit(inst, 24)) return c.ill(s, inst);
    if (!c.condHolds(s.r.nzcv, @intCast(inst & 15))) return .next;
    return c.jump(s, s.r.pc +% c.sextN(@as(u64, c.bits(inst, 23, 5)) << 2, 21));
}

fn branchReg(s: c.St, inst: u32) c.Exit {
    // opc<24:21> op2<20:16> = 11111, op3<15:10> = 0, op4<4:0> = 0
    if (inst & 0x001f_fc1f != 0x001f_0000) return c.ill(s, inst);
    const target = c.xr(s, c.rn(inst));
    switch (c.bits(inst, 24, 21)) {
        0 => {}, // BR
        1 => s.r.x[30] = s.r.pc +% 4, // BLR (target read first: BLR x30)
        2 => {}, // RET
        else => return c.ill(s, inst),
    }
    return c.jump(s, target);
}

fn exception(s: c.St, inst: u32) c.Exit {
    // opc<23:21>, op2<4:2>, LL<1:0>
    return switch (inst & 0x00e0_001f) {
        0x0000_0001 => c.syscall(s), // SVC #imm16 (Linux ignores the immediate)
        0x0020_0000 => c.breakpoint(s, inst), // BRK #imm16
        else => c.ill(s, inst), // HVC, SMC, HLT, TCANCEL, DCPS
    };
}

fn system(s: c.St, inst: u32) c.Error!c.Exit {
    const l = c.bit(inst, 21);
    const op0 = c.bits(inst, 20, 19);
    const op1 = c.bits(inst, 18, 16);
    const crn = c.bits(inst, 15, 12);
    const crm = c.bits(inst, 11, 8);
    const op2 = c.bits(inst, 7, 5);
    const rt = c.rd(inst);
    if (op0 == 0) {
        // MSR (immediate) PSTATE fields (CRn = 4: EL0 may set none of them
        // in ARMv8.0, Linux leaves SCTLR_EL1.UMA clear), WFET/WFIT (CRn = 1),
        // CFINV/XAFLAG/AXFLAG: not ARMv8.0 or not EL0.
        if (l or op1 != 3 or rt != 31) return c.ill(s, inst);
        switch (crn) {
            // Hints: every one is a NOP here, including WFE and WFI (Linux
            // sets SCTLR_EL1.nTWE/nTWI, so they do not trap at EL0 and may
            // return at once), YIELD, SEV, SEVL, the PAC hints (PACIASP,
            // AUTIASP, XPACLRI, ...), BTI, and unallocated hints (the
            // architecture makes those NOPs).
            2 => return .next,
            3 => switch (op2) { // barriers
                2 => s.h.resv = core.no_resv, // CLREX (any CRm)
                4, 5 => c.barrier(s), // DSB, DMB (any option, incl. SSBB, PSSBB)
                6 => {}, // ISB: nothing is fetched ahead
                else => return c.ill(s, inst), // DSB nXS (FEAT_XS), TCOMMIT, SB (FEAT_SB), unallocated
            },
            else => return c.ill(s, inst),
        }
        return .next;
    }
    if (op0 == 1) {
        if (l) return c.ill(s, inst); // SYSL
        return sysOp(s, inst, op1, crn, crm, op2, rt);
    }
    // op0 = 2 (debug registers: Linux traps EL0 DCC access) or 3: MRS / MSR (register)
    const v = sysreg(op0, op1, crn, crm, op2) orelse return c.ill(s, inst);
    if (l) {
        if (v == .cntvct_el0) {
            // The run loop knows the count: it calls finishCounter.
            s.h.trap = .counter;
            s.h.trap_val = rt;
            return .trap;
        }
        c.setX(s, rt, switch (v) {
            .tpidr_el0 => s.r.tpidr_el0,
            .nzcv => s.r.nzcv,
            .fpcr => s.r.fpcr,
            .fpsr => s.r.fpsr,
            .tpidrro_el0 => 0,
            .dczid_el0 => dczid,
            .ctr_el0 => ctr,
            .cntfrq_el0 => cntfrq,
            .cntvct_el0 => unreachable,
            .midr_el1 => midr,
            .mpidr_el1 => mpidr,
            .revidr_el1 => 0,
            .id => idReg(s, crm, op2),
        });
    } else {
        const x = c.xr(s, rt);
        switch (v) {
            .tpidr_el0 => s.r.tpidr_el0 = x,
            .nzcv => s.r.nzcv = @as(u32, @truncate(x)) & 0xf000_0000,
            .fpcr => s.r.fpcr = @as(u32, @truncate(x)) & c.FPCR_MASK,
            .fpsr => s.r.fpsr = @as(u32, @truncate(x)) & c.FPSR_MASK,
            else => return c.ill(s, inst), // read-only from EL0
        }
    }
    return .next;
}

/// Complete an MRS CNTVCT_EL0 (Hart.trap == .counter, Hart.trap_val = Rt):
/// `now` is the number of instructions this CPU retired before it
/// (kw_cpu.icount plus the current run's), the A64 counterpart of riscv's
/// time CSR. The caller counts it as retired.
pub fn finishCounter(s: c.St, now: u64) void {
    c.setX(s, @intCast(s.h.trap_val), now);
    s.r.pc +%= 4;
}

/// DCZID_EL0: DC ZVA allowed (DZP = 0), 2^4 words = 64-byte blocks.
pub const dczid: u64 = 4;
pub const zva_bytes: u64 = 64;
/// CTR_EL0: 64-byte I and D cache lines (IminLine = DminLine = 4), ERG and
/// CWG 4, PIPT I-cache, IDC = DIC = 0 (software must clean and invalidate
/// to make new code visible: IC IVAU is the point where decoded code goes).
pub const ctr: u64 = 0x8444_c004;
/// CNTFRQ_EL0: the nominal frequency of CNTVCT_EL0, 1 GHz (the value
/// ARMv8.6 fixes). CNTVCT_EL0 counts retired instructions, not time: one
/// tick per instruction, per CPU (CPUs do not agree), so it is neither wall
/// time nor synchronised. The kernel must not build a vDSO clock on it.
pub const cntfrq: u64 = 1_000_000_000;
/// MIDR_EL1 as Linux's EL0 emulation reports it: implementer 0 (reserved
/// for software use), architecture 0xf, so no software picks core-specific
/// tunings.
pub const midr: u64 = 0x000f_0000;
/// MPIDR_EL1 as Linux emulates it for EL0 (SYS_MPIDR_SAFE_VAL): RES1 only.
pub const mpidr: u64 = 0x8000_0000;

/// ID_AA64PFR0_EL1: EL0 and EL1 AArch64 only (Linux's safe values for the
/// hidden fields), FP and AdvSIMD implemented without half precision (0),
/// no SVE, no CSV2/CSV3, no DIT.
pub const id_aa64pfr0: u64 = 0x11;
/// ID_AA64DFR0_EL1: only the hidden DebugVer field at Linux's safe value 6.
pub const id_aa64dfr0: u64 = 0x6;
/// ID_AA64MMFR0_EL1: Linux's safe values for its hidden fields (TGRAN4_2,
/// TGRAN16_2, TGRAN64_2 = 1; TGRAN4, TGRAN64 = 0xf), ECV (visible) 0.
pub const id_aa64mmfr0: u64 = 0x0000_0111_ff00_0000;

/// ID_AA64ISAR0_EL1 for the enabled optional features (`c.has`, so it
/// follows common.implemented and kw_set_isa like AT_HWCAP does): AES 1
/// (2 with PMULL; PMULL without AES cannot be expressed and shows 0), SHA1
/// 1, SHA2 1 (no SHA512), CRC32 1. Atomic (LSE), RDM, SHA3, SM3/SM4,
/// DotProd, FHM, TS, RNDR are 0.
pub fn idAa64isar0(s: c.St) u64 {
    var v: u64 = 0;
    if (c.has(s, .aes)) v |= @as(u64, if (c.has(s, .pmull)) 2 else 1) << 4;
    if (c.has(s, .sha1)) v |= 1 << 8;
    if (c.has(s, .sha2)) v |= 1 << 12;
    if (c.has(s, .crc32)) v |= 1 << 16;
    return v;
}

/// An ID register of the space Linux emulates for EL0 (cpufeature.c,
/// emulate_sys_reg): op0 = 3, op1 = 0, CRn = 0, CRm = 2..7, any op2. Its
/// user view: visible fields describe kwemu, hidden fields show Linux's
/// safe values, and the AArch32 registers (no AArch32 at EL0), the
/// untracked and the unallocated ones read 0. ID_AA64PFR1, ISAR1, ISAR2,
/// MMFR1, MMFR2, ZFR0 are 0 in ARMv8.0 without the optional features.
pub fn idReg(s: c.St, crm: u32, op2: u32) u64 {
    return switch ((crm << 3) | op2) {
        (4 << 3) | 0 => id_aa64pfr0,
        (5 << 3) | 0 => id_aa64dfr0,
        (6 << 3) | 0 => idAa64isar0(s),
        (7 << 3) | 0 => id_aa64mmfr0,
        else => 0,
    };
}

const SysReg = enum { tpidr_el0, nzcv, fpcr, fpsr, tpidrro_el0, dczid_el0, ctr_el0, cntfrq_el0, cntvct_el0, midr_el1, mpidr_el1, revidr_el1, id };

/// The system registers EL0 may access on Linux, by (op0, op1, CRn, CRm,
/// op2). Not here (ILLEGAL): DAIF (SCTLR_EL1.UMA = 0), CNTPCT_EL0 and the
/// timers (Linux leaves EL0PCTEN, EL0VTEN, EL0PTEN clear), PMU and debug
/// registers, CNTVCTSS_EL0 (FEAT_ECV), RNDR/RNDRRS (FEAT_RNG), SSBS, DIT,
/// TCO, TPIDR2_EL0, and in the ID space CRm = 1 and CRm = 0 other than
/// MIDR, MPIDR, REVIDR (Linux does not emulate them: SIGILL).
fn sysreg(op0: u32, op1: u32, crn: u32, crm: u32, op2: u32) ?SysReg {
    if (op0 == 3 and op1 == 0 and crn == 0 and crm >= 2) return .id; // CRm = 2..7
    return switch (enc(op0, op1, crn, crm, op2)) {
        enc(3, 3, 13, 0, 2) => .tpidr_el0,
        enc(3, 3, 13, 0, 3) => .tpidrro_el0,
        enc(3, 3, 4, 2, 0) => .nzcv,
        enc(3, 3, 4, 4, 0) => .fpcr,
        enc(3, 3, 4, 4, 1) => .fpsr,
        enc(3, 3, 0, 0, 7) => .dczid_el0,
        enc(3, 3, 0, 0, 1) => .ctr_el0,
        enc(3, 3, 14, 0, 0) => .cntfrq_el0,
        enc(3, 3, 14, 0, 2) => .cntvct_el0,
        enc(3, 0, 0, 0, 0) => .midr_el1,
        enc(3, 0, 0, 0, 5) => .mpidr_el1,
        enc(3, 0, 0, 0, 6) => .revidr_el1,
        else => null,
    };
}
fn enc(op0: u32, op1: u32, crn: u32, crm: u32, op2: u32) u32 {
    return (op0 << 14) | (op1 << 11) | (crn << 7) | (crm << 3) | op2;
}

/// SYS: the cache maintenance EL0 may use (Linux sets SCTLR_EL1.UCI and
/// DZE). DC CVAP and DC CVADP (FEAT_DPB, FEAT_DPB2), the MTE forms (DC
/// GVA, GZVA, ...) and every EL1 operation are ILLEGAL.
fn sysOp(s: c.St, inst: u32, op1: u32, crn: u32, crm: u32, op2: u32, rt: u32) c.Error!c.Exit {
    if (op1 != 3 or crn != 7 or op2 != 1) return c.ill(s, inst);
    const va = c.xr(s, rt);
    switch (crm) {
        4 => try dcZva(s, va),
        // DC CVAC, DC CVAU, DC CIVAC: no caches to clean, but the address
        // must translate (a read-permission check, as on hardware).
        10, 11, 14 => try s.m.probe(va, .read),
        5 => icIvau(s, va),
        else => return c.ill(s, inst),
    }
    return .next;
}

/// DC ZVA: zero the aligned `zva_bytes` block that holds va, all or nothing.
pub fn dcZva(s: c.St, va: u64) c.Error!void {
    const base = va & ~(zva_bytes - 1);
    try c.probeWrite(s, base, zva_bytes);
    var i: u64 = 0;
    while (i < zva_bytes) : (i += 8) try c.store(s, u64, base + i, 0);
}

/// IC IVAU: the guest made new code at va visible (after DC CVAU and DSB;
/// CTR_EL0.DIC = 0 requires it). The decoded-op tier drops what this CPU
/// decoded from va's physical page, ends the running block, and makes every
/// other CPU drop its decoded code at its next block boundary (tier.icIvau,
/// the code epoch). No permission check (an IC IVAU of an unmapped address
/// does nothing here).
pub fn icIvau(s: c.St, va: u64) void {
    @import("tier.zig").icIvau(s.m, va);
}
