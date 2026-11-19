// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! riscv's JIT emitter (kept for reference; `-Driscv-legacy`): the ISA hooks
//! of the ISA-neutral JIT core (src/emu/jitcore.zig, which documents the
//! generated function, the slot pool, the compile policy and regions) and
//! everything riscv-specific below them: which ops are translated
//! (`opSupported`), their register usage, `emitOp` (ALU, M, loads and
//! stores, branches, F/D with `fcsr`, Zkne/Zknd, Zb*), the register file in
//! locals (x1..x31, f0..f31, fcsr) and the FMA, AES and clmul/xperm helper
//! functions. This file is the hook namespace `I` of `jc.Jit(@This())`; it
//! also re-exports what kwemu.zig's riscv `run` and the riscv unit tests use.

const std = @import("std");
const kwemu = @import("kwemu.zig");
const exec = @import("exec.zig");
const core = @import("../cpu/core.zig");
const jc = @import("jitcore.zig");
const Cpu = kwemu.Cpu;
const Block = kwemu.Block;
pub const Op = exec.Op;
const W = jc.W;
const Region = jc.Region;
const State = jc.State;
const AesTab = jc.AesTab;
const jit_off = jc.jit_off;
pub const code_done = jc.code_done;
pub const code_side = jc.code_side;
const l_x = jc.l_x;
const l_cpu = jc.l_cpu;
const l_irq = jc.l_irq;
const l_jl = jc.l_jl;

const JC = jc.Jit(@This());
const Emit = JC.Emit;

// ---- what kwemu.zig and the riscv tests use -------------------------------------

pub const enabled = jc.enabled;
pub const npool = jc.npool;
pub const buf_size = jc.buf_size;
pub const max_jl = jc.max_jl;
pub const max_members = jc.max_members;
pub const code_done_side = jc.code_done_side;
pub const code_done_stop = jc.code_done_stop;
pub const BlockState = jc.BlockState;
pub const Jx = jc.Jx;
pub const Xr = jc.Xr;
pub const Nx = jc.Nx;
pub const slotOf = jc.slotOf;
pub const memberOf = jc.memberOf;
pub const slotIndex = jc.slotIndex;
pub const enter = jc.enter;
pub const handedBack = jc.handedBack;
pub const lastBlock = jc.lastBlock;
pub const loopLimit = jc.loopLimit;
pub const loopDone = jc.loopDone;
pub const ready = JC.ready;
pub const noteExit = JC.noteExit;
pub const countExit = JC.countExit;
pub const countNext = JC.countNext;

// ---- ISA hooks (jitcore.zig, `Jit`) ----------------------------------------------

pub const EmitExt = struct {
    /// The frm == RNE test for dynamic rounding modes has been emitted (frm
    /// cannot change inside compiled code, so the first test covers every
    /// later op of the pass). Per region member: a member can be entered
    /// without running the code of the members emitted before it.
    frm_checked: bool = false,
    /// Function indices of the FMA helpers (0 = not in this module).
    fn_fmad: u32 = 0,
    fn_fmas: u32 = 0,
    /// FMA bodies are emitted inline (see fma_inline_max).
    fma_inline: bool = false,
    /// Function indices of the AES helpers per `AesK` (0 = not in this module).
    fn_aes: [n_aes_k]u32 = @splat(0),
    /// AES bodies are emitted inline (see aes_inline_max).
    aes_inline: bool = false,
    /// Function indices of the clmul/xperm helpers per `BkK` (0 = not in
    /// this module).
    fn_bk: [n_bk_k]u32 = @splat(0),
    /// clmul/xperm bodies are emitted inline (see bk_inline_max).
    bk_inline: bool = false,
    /// While an inline FMA body is emitted: the nesting level of its
    /// result block (its "return" is a br there).
    fma_nest: u32 = 0,
};

pub fn ops(cpu: *Cpu, b: *const Block) []const Op {
    return cpu.priv.ops[cpu.opIndex(b.op)..][0..b.n];
}

/// Arena slots of a block (its ops; the raw bits are in them).
pub fn slots(b: *const Block) u32 {
    return b.n;
}

pub fn supported(o: Op) bool {
    return opSupported(o);
}

pub const nextPc = kwemu.nextPc;

/// Usage of a translated prefix; helper usage only if its FMAs (AES ops,
/// clmul/xperm ops) are too many to inline (see `helpers`).
pub fn blockUse(o: []const Op) Use {
    var u: Use = .{};
    for (o) |x| u.add(usage(x));
    helpers(&u);
    return u;
}

/// Per block / member: frm not tested yet; FMA, AES and clmul/xperm bodies
/// inline when the member has few of them.
pub fn beginMember(e: *Emit, o: []const Op) void {
    e.x.frm_checked = false;
    var u: Use = .{};
    for (o) |x| u.add(usage(x));
    e.x.fma_inline = u.nfma <= fma_inline_max;
    e.x.aes_inline = u.naes <= aes_inline_max;
    e.x.bk_inline = u.nbk <= bk_inline_max;
}

pub fn helperCount(e: *Emit, use: Use) u32 {
    var nfn: u32 = 1;
    if (use.fmad) {
        e.x.fn_fmad = nfn;
        nfn += 1;
    }
    if (use.fmas) {
        e.x.fn_fmas = nfn;
        nfn += 1;
    }
    for (0..n_aes_k) |i| {
        if (use.aes & (@as(u8, 1) << @intCast(i)) == 0) continue;
        e.x.fn_aes[i] = nfn;
        nfn += 1;
    }
    for (0..n_bk_k) |i| {
        if (use.bk & (@as(u8, 1) << @intCast(i)) == 0) continue;
        e.x.fn_bk[i] = nfn;
        nfn += 1;
    }
    return nfn - 1;
}

/// i64 x n_i64, f64 x n_f64, and a region's i64 x n_region_locals.
pub fn locals(e: *Emit, region: bool) void {
    e.op(if (region) 0x03 else 0x02);
    e.uleb(n_i64);
    e.op(W.i64_t);
    e.uleb(n_f64);
    e.op(W.f64_t);
    if (region) {
        e.uleb(jc.n_region_locals);
        e.op(W.i64_t);
    }
}

pub fn prologue(e: *Emit, use: Use) void {
    const live = use.read | use.write;
    const flive = use.fread | use.fwrite;
    for (1..32) |r| {
        if (live & (@as(u32, 1) << @intCast(r)) == 0) continue;
        e.get(l_x);
        e.addr();
        e.mem(W.i64_load, 3, r * 8);
        e.set(lreg(@intCast(r)));
    }
    for (0..32) |r| {
        if (flive & (@as(u32, 1) << @intCast(r)) == 0) continue;
        e.get(l_x);
        e.addr();
        e.mem(W.i64_load, 3, f_off + r * 8);
        e.set(lf(@intCast(r)));
    }
    if (use.fcsr_r or use.fcsr_w) {
        e.get(l_x);
        e.addr();
        e.mem(W.i64_load32_u, 2, fcsr_off);
        e.set(l_fcsr);
    }
}

pub fn epilogue(e: *Emit, use: Use) void {
    for (1..32) |r| {
        if (use.write & (@as(u32, 1) << @intCast(r)) == 0) continue;
        e.get(l_x);
        e.addr();
        e.get(lreg(@intCast(r)));
        e.mem(W.i64_store, 3, r * 8);
    }
    for (0..32) |r| {
        if (use.fwrite & (@as(u32, 1) << @intCast(r)) == 0) continue;
        e.get(l_x);
        e.addr();
        e.get(lf(@intCast(r)));
        e.mem(W.i64_store, 3, f_off + r * 8);
    }
    if (use.fcsr_w) {
        e.get(l_x);
        e.addr();
        e.get(l_fcsr);
        e.mem(W.i64_store32, 2, fcsr_off);
    }
}

pub fn emitHelpers(e: *Emit) void {
    if (e.x.fn_fmad != 0) fmaBody(e, u64, false);
    if (e.x.fn_fmas != 0) fmaBody(e, u32, false);
    for (0..n_aes_k) |i| if (e.x.fn_aes[i] != 0) aesHelper(e, @enumFromInt(i));
    for (0..n_bk_k) |i| if (e.x.fn_bk[i] != 0) bkHelper(e, @enumFromInt(i));
}

pub fn selfLoop(last: Op, b: *const Block) bool {
    return switch (last.h) {
        .beq, .bne, .blt, .bge, .bltu, .bgeu, .jal, .goto => last.imm == b.pc,
        else => false,
    };
}

/// Targets of side exits and terminators; return sites of calls.
pub fn targets(o: Op, m: *const Block) [2]?u64 {
    const call = o.rd != 0 and o.rd < 32;
    return switch (o.h) {
        .beq_x, .bne_x, .blt_x, .bge_x, .bltu_x, .bgeu_x, .goto => .{ o.imm, null },
        .jal_c => .{ if (call) o.imm else null, null },
        .beq, .bne, .blt, .bge, .bltu, .bgeu => .{ o.imm, m.end_pc },
        .jal => .{ o.imm, if (call) m.end_pc else null },
        .jalr => .{ if (call) m.end_pc else null, null },
        else => .{ null, null },
    };
}

pub fn memberTail(e: *Emit, rg: *Region, b: *const Block, last: Op) void {
    switch (last.h) {
        .jal, .goto => if (rg.memberAt(last.imm)) |t| e.toMember(rg, t),
        .beq, .bne, .blt, .bge, .bltu, .bgeu => {
            for ([_]u64{ last.imm, b.end_pc }) |pt| {
                if (rg.memberAt(pt)) |t| e.targetIf(rg, t);
            }
        },
        .jalr => for (0..rg.n) |t| e.targetIf(rg, t),
        else => {},
    }
}

pub fn indirect(last: Op) bool {
    return last.h == .jalr;
}

pub fn poll(e: *Emit) void {
    e.irqWord();
}

pub fn sync(e: *Emit) void {
    _ = e;
}

/// Push guest register r (x0 reads as 0).
fn reg(e: *Emit, r: u8) void {
    if (r == 0) e.k64(0) else e.get(lreg(r));
}
/// Pop into guest register r (x0 / the redirected x0 slot: dropped).
fn setReg(e: *Emit, r: u8) void {
    if (r == 0 or r >= 32) e.op(W.drop) else e.set(lreg(r));
}

/// Inline data-TLB lookup for an access of `size` bytes at x[rs1] + imm:
/// leaves the host address on the stack, or hands op k back on a miss.
fn hostAddr(e: *Emit, o: Op, k: usize, pc: u64, tlb_off: u64, size: u64) void {
    reg(e, o.rs1);
    if (o.imm != 0) {
        e.k64(o.imm);
        e.op(W.i64_add);
    }
    e.set(l_va);
    e.tlbCheck(k, pc, tlb_off, size);
}

// ---- riscv emitter ---------------------------------------------------------------

// ---- emitter ---------------------------------------------------------------------

/// Whether the JIT translates op `o` (anything else hands back to the
/// interpreter at that op). FP arithmetic is translated only with a static
/// RNE rounding mode or a dynamic one (checked against frm at run time).
/// Optional extensions (core.Ext) need no gate here: the decoder emits
/// their dedicated ops only while they are enabled, and `generic` ops that
/// hold their encodings must stay handed back (core.exec gates them).
fn opSupported(o: Op) bool {
    return switch (o.h) {
        .addi, .addiw, .andi, .ori, .xori, .slti, .sltiu, .slli, .srli, .srai, .slliw, .srliw, .sraiw, .li => true,
        .add, .sub, .and_, .or_, .xor_, .sll, .srl, .sra, .slt, .sltu, .addw, .subw, .sllw, .srlw, .sraw => true,
        .mul, .mulh, .mulhsu, .mulhu, .div, .divu, .rem, .remu, .mulw, .divw, .divuw, .remw, .remuw => true,
        .aes64es, .aes64esm, .aes64ds, .aes64dsm, .aes64im, .aes64ks1i, .aes64ks2 => true,
        .andn, .orn, .xnor, .rol, .ror, .rolw, .rorw, .pack, .packh, .packw, .rori, .roriw, .rev8, .brev8 => true,
        .clmul, .clmulh, .clmulr, .xperm4, .xperm8 => true,
        .shadd, .clz, .ctz, .cpop, .minmax, .sext, .orc_b, .bitop, .bext, .czero => true,
        .lb, .lh, .lw, .ld, .lbu, .lhu, .lwu, .sb, .sh, .sw, .sd, .nop => true,
        .beq_x, .bne_x, .blt_x, .bge_x, .bltu_x, .bgeu_x, .jal_c => true,
        .beq, .bne, .blt, .bge, .bltu, .bgeu, .jal, .jalr, .goto => true,
        .flw, .fld, .fsw, .fsd, .fmv_x_w, .fmv_x_d, .fmv_w_x, .fmv_d_x, .fcmp_s, .fcmp_d => true,
        // fsgnj*, fmin/fmax(m); fround(nx) only with a static mode but RMM, or dynamic
        .fsgnj_s, .fsgnj_d => o.imm < 16 or o.imm & 7 != 4,
        .fadd_s, .fsub_s, .fmul_s, .fdiv_s, .fadd_d, .fsub_d, .fmul_d, .fdiv_d => rmOk(o),
        .fmadd_s, .fmsub_s, .fnmsub_s, .fnmadd_s, .fmadd_d, .fmsub_d, .fnmsub_d, .fnmadd_d => rmOk(o),
        .generic => fpGeneric(o.raw) != null,
        else => false,
    };
}

/// Static rounding mode RNE (0) or dynamic (7).
fn rmOk(o: Op) bool {
    const rm = o.imm & 7;
    return rm == 0 or rm == 7;
}

/// FP instructions that the decoder leaves to `generic` (core.exec) but the
/// JIT translates: the exact encodings core.zig accepts, with rm checked
/// like rmOk. null = not translated (hand back).
const FpGen = enum { fsqrt_s, fsqrt_d, fcvt_s_d, fcvt_d_s, fcvt_f_x_s, fcvt_f_x_d, fcvt_x_f_s, fcvt_x_f_d, fclass_s, fclass_d };

fn fpGeneric(raw: u32) ?FpGen {
    if (raw & 0x7f != 0x53) return null;
    const f3 = (raw >> 12) & 7;
    const rs2 = (raw >> 20) & 31;
    const dbl = switch ((raw >> 25) & 3) {
        0 => false,
        1 => true,
        else => return null,
    };
    const rm_ok = f3 == 0 or f3 == 7;
    return switch (raw >> 27) {
        0x0b => if (rs2 == 0 and rm_ok) (if (dbl) .fsqrt_d else .fsqrt_s) else null,
        0x08 => if (!rm_ok) null else if (dbl and rs2 == 0) .fcvt_d_s else if (!dbl and rs2 == 1) .fcvt_s_d else null,
        // fcvt.{s,d}.{w,wu,l,lu}: fcvt.d.w/wu are always exact, so any
        // legal static mode does; the others need RNE.
        0x1a => if (rs2 <= 3 and (rm_ok or (dbl and rs2 <= 1 and f3 <= 4))) (if (dbl) .fcvt_f_x_d else .fcvt_f_x_s) else null,
        // fcvt.{w,wu,l,lu}.{s,d}: any static mode but RMM, or dynamic
        0x18 => if (rs2 <= 3 and f3 != 4 and f3 != 5 and f3 != 6) (if (dbl) .fcvt_x_f_d else .fcvt_x_f_s) else null,
        0x1c => if (rs2 == 0 and f3 == 1) (if (dbl) .fclass_d else .fclass_s) else null,
        else => null,
    };
}

pub const Use = struct {
    read: u32 = 0,
    write: u32 = 0,
    fread: u32 = 0,
    fwrite: u32 = 0,
    /// Reads fcsr (dynamic rounding mode) / accrues flags into it.
    fcsr_r: bool = false,
    fcsr_w: bool = false,
    fmad: bool = false,
    fmas: bool = false,
    nfma: u32 = 0,
    /// AES ops with a table body (bit per `AesK`), and how many.
    aes: u8 = 0,
    naes: u32 = 0,
    /// clmul/xperm ops (bit per `BkK`), and how many.
    bk: u8 = 0,
    nbk: u32 = 0,

    pub fn add(u: *Use, x: Use) void {
        u.read |= x.read;
        u.write |= x.write;
        u.fread |= x.fread;
        u.fwrite |= x.fwrite;
        u.fcsr_r = u.fcsr_r or x.fcsr_r;
        u.fcsr_w = u.fcsr_w or x.fcsr_w;
        u.fmad = u.fmad or x.fmad;
        u.fmas = u.fmas or x.fmas;
        u.nfma += x.nfma;
        u.aes |= x.aes;
        u.naes += x.naes;
        u.bk |= x.bk;
        u.nbk += x.nbk;
    }
};

fn regBit(r: u8) u32 {
    return if (r == 0 or r >= 32) 0 else @as(u32, 1) << @intCast(r);
}
fn fregBit(r: u32) u32 {
    return @as(u32, 1) << @intCast(r & 31);
}

fn usage(o: Op) Use {
    const a = regBit(o.rs1);
    const b = regBit(o.rs2);
    const d = regBit(o.rd);
    const fa = fregBit(o.rs1);
    const fb = fregBit(o.rs2);
    const fd = fregBit(o.rd);
    return switch (o.h) {
        .addi, .addiw, .andi, .ori, .xori, .slti, .sltiu, .slli, .srli, .srai, .slliw, .srliw, .sraiw => .{ .read = a, .write = d },
        .lb, .lh, .lw, .ld, .lbu, .lhu, .lwu => .{ .read = a, .write = d },
        .li, .jal_c, .jal => .{ .write = d },
        .jalr => .{ .read = a, .write = d },
        .sb, .sh, .sw, .sd, .beq_x, .bne_x, .blt_x, .bge_x, .bltu_x, .bgeu_x, .beq, .bne, .blt, .bge, .bltu, .bgeu => .{ .read = a | b },
        .nop, .goto => .{},
        .flw, .fld => .{ .read = a, .fwrite = fd },
        .fsw, .fsd => .{ .read = a, .fread = fb },
        .fmv_x_w, .fmv_x_d => .{ .fread = fa, .write = d },
        .fmv_w_x, .fmv_d_x => .{ .read = a, .fwrite = fd },
        .fsgnj_s, .fsgnj_d => if (o.imm < 4)
            .{ .fread = fa | fb, .fwrite = fd }
        else if (o.imm < 8) // fmin/fmax(m): NV
            .{ .fread = fa | fb, .fwrite = fd, .fcsr_r = true, .fcsr_w = true }
        else // fround(nx): frm, NV/NX
            .{ .fread = fa, .fwrite = fd, .fcsr_r = true, .fcsr_w = true },
        .fcmp_s, .fcmp_d => .{ .fread = fa | fb, .write = d, .fcsr_r = true, .fcsr_w = true },
        .fadd_s, .fsub_s, .fmul_s, .fdiv_s, .fadd_d, .fsub_d, .fmul_d, .fdiv_d => .{ .fread = fa | fb, .fwrite = fd, .fcsr_r = true, .fcsr_w = true },
        .fmadd_s, .fmsub_s, .fnmsub_s, .fnmadd_s, .fmadd_d, .fmsub_d, .fnmsub_d, .fnmadd_d => .{
            .fread = fa | fb | fregBit(@intCast(o.imm >> 8)),
            .fwrite = fd,
            .fcsr_r = true,
            .fcsr_w = true,
            .fmad = o.h == .fmadd_d or o.h == .fmsub_d or o.h == .fnmsub_d or o.h == .fnmadd_d,
            .fmas = o.h == .fmadd_s or o.h == .fmsub_s or o.h == .fnmsub_s or o.h == .fnmadd_s,
            .nfma = 1,
        },
        .generic => genUsage(o.raw),
        .aes64es, .aes64esm, .aes64ds, .aes64dsm, .aes64im => .{
            .read = a | b,
            .write = d,
            .aes = @as(u8, 1) << @intFromEnum(aesKind(o.h)),
            .naes = 1,
        },
        .clmul, .clmulh, .clmulr, .xperm4, .xperm8 => .{
            .read = a | b,
            .write = d,
            .bk = @as(u8, 1) << @intFromEnum(bkKind(o.h)),
            .nbk = 1,
        },
        // R-type; also the I-forms with rs2 = 0 (aes64ks1i, rori, rev8, ...)
        else => .{ .read = a | b, .write = d },
    };
}

fn genUsage(raw: u32) Use {
    const rd: u8 = @intCast((raw >> 7) & 31);
    const rs1: u8 = @intCast((raw >> 15) & 31);
    const fl: Use = .{ .fcsr_r = true, .fcsr_w = true };
    var u = fl;
    switch (fpGeneric(raw).?) {
        .fsqrt_s, .fsqrt_d, .fcvt_s_d, .fcvt_d_s => {
            u.fread = fregBit(rs1);
            u.fwrite = fregBit(rd);
        },
        .fcvt_f_x_s, .fcvt_f_x_d => {
            u.read = regBit(rs1);
            u.fwrite = fregBit(rd);
        },
        .fcvt_x_f_s, .fcvt_x_f_d, .fclass_s, .fclass_d => {
            u.fread = fregBit(rs1);
            u.write = regBit(rd);
        },
    }
    return u;
}

// locals (params l_x, l_cpu, l_irq, l_jl: jitcore.zig)
inline fn lreg(r: u8) u32 {
    return 3 + @as(u32, r); // x1..x31 -> 4..34
}
pub const l_npc = 35;
pub const l_va = 36;
pub const l_e = 37;
pub const l_code = 38;
const l_t0 = 39; // ..43
/// f0..f31 (raw 64-bit register contents) -> 44..75
inline fn lf(r: u32) u32 {
    return 44 + (r & 31);
}
const l_fcsr = 76;
const l_t5 = 77; // ..81
/// An inline FMA body's i64 locals (its a, b, c and temporaries) ..91,
/// and its status (0 exact, 1 inexact, 2 hand back).
const l_fma_i = 82;
const l_fma_st = 92;
const n_i64 = 93 - 4;
const l_d0 = 93; // f64 temporaries ..98
/// An inline FMA body's f64 locals ..114.
const l_fma_f = 99;
const n_f64 = 22;
/// Blocks with at most this many FMA ops get them inline; more share one
/// helper function per format (bounding the module size). Decided per
/// block, also for region members (a region of several FMA blocks keeps
/// them inline; the buffer limit cuts the region if needed).
const fma_inline_max = 4;

/// The FMA, AES and clmul/xperm helpers a block with usage `x` calls: none
/// if its FMAs (AES ops, clmul/xperm ops) are inline (fmad/fmas, aes, bk
/// then cleared).
fn helpers(x: *Use) void {
    if (x.nfma <= fma_inline_max) {
        x.fmad = false;
        x.fmas = false;
    }
    if (x.naes <= aes_inline_max) x.aes = 0;
    if (x.nbk <= bk_inline_max) x.bk = 0;
}

/// Blocks with at most this many AES table ops (aes64es/esm/ds/dsm/im) get
/// them inline; more call one helper function per kind, shared by the
/// module. Decided per block, like FMAs.
const aes_inline_max = 4;

/// Register file offsets (core.Regs: x[32], pc, f[32], fcsr).
const f_off: u64 = 33 * 8;
const fcsr_off: u64 = 65 * 8;
const box_hi: u64 = 0xffff_ffff_0000_0000;
const sign_d: u64 = 1 << 63;
const sign_s: u64 = 1 << 31;
const inf_d: u64 = 0x7ff0_0000_0000_0000;
const inf_s: u64 = 0x7f80_0000;
const qnan_d: u64 = 0x7ff8_0000_0000_0000;
const qnan_s: u64 = 0x7fc0_0000;

/// The core's region locals: a third group of i64 locals, after the f64 ones.
pub const l_region = l_d0 + n_f64;

fn cmpOp(h: exec.H) u8 {
    return switch (h) {
        .beq, .beq_x => W.i64_eq,
        .bne, .bne_x => W.i64_ne,
        .blt, .blt_x => W.i64_lt_s,
        .bge, .bge_x => W.i64_ge_s,
        .bltu, .bltu_x => W.i64_lt_u,
        .bgeu, .bgeu_x => W.i64_ge_u,
        else => unreachable,
    };
}

/// Upper 64 bits of the unsigned product of x[rs1] and x[rs2] (t0..t4).
fn mulhu(e: *Emit, o: Op) void {
    const t0 = l_t0;
    const t1 = l_t0 + 1;
    const t2 = l_t0 + 2;
    const t3 = l_t0 + 3;
    const t4 = l_t0 + 4;
    const lo: u64 = 0xffff_ffff;
    reg(e, o.rs1);
    e.k64(lo);
    e.op(W.i64_and);
    e.set(t0);
    reg(e, o.rs1);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.set(t1);
    reg(e, o.rs2);
    e.k64(lo);
    e.op(W.i64_and);
    e.set(t2);
    reg(e, o.rs2);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.set(t3);
    // t4 = ahi*blo + (alo*blo >> 32)
    e.get(t1);
    e.get(t2);
    e.op(W.i64_mul);
    e.get(t0);
    e.get(t2);
    e.op(W.i64_mul);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.op(W.i64_add);
    e.set(t4);
    // ahi*bhi + (t4 >> 32) + ((alo*bhi + (t4 & lo)) >> 32)
    e.get(t1);
    e.get(t3);
    e.op(W.i64_mul);
    e.get(t4);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.op(W.i64_add);
    e.get(t0);
    e.get(t3);
    e.op(W.i64_mul);
    e.get(t4);
    e.k64(lo);
    e.op(W.i64_and);
    e.op(W.i64_add);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.op(W.i64_add);
}

/// Signed-operand correction: subtract ((s >> 63) & other).
fn mulCorr(e: *Emit, s: u8, other: u8) void {
    reg(e, s);
    e.k64(63);
    e.op(W.i64_shr_s);
    reg(e, other);
    e.op(W.i64_and);
    e.op(W.i64_sub);
}

/// x[rs2] == 0 test for the M-extension divisions (`w`: low 32 bits).
fn divZero(e: *Emit, o: Op, w: bool) void {
    reg(e, o.rs2);
    if (w) {
        e.op(W.i32_wrap);
        e.op(W.i32_eqz);
    } else e.op(W.i64_eqz);
    e.open(W.@"if", W.i64_t);
}

fn lo32(e: *Emit, r: u8) void {
    reg(e, r);
    e.op(W.i32_wrap);
}

pub fn emitOp(e: *Emit, o: Op, k: usize, pc: u64, b: *const Block, self_loop: bool) void {
    switch (o.h) {
        .addi, .andi, .ori, .xori, .addiw => {
            reg(e, o.rs1);
            e.k64(o.imm);
            e.op(switch (o.h) {
                .addi, .addiw => W.i64_add,
                .andi => W.i64_and,
                .ori => W.i64_or,
                else => W.i64_xor,
            });
            if (o.h == .addiw) e.ops(&.{ W.i32_wrap, W.i64_ext_s });
            setReg(e, o.rd);
        },
        .slti, .sltiu => {
            reg(e, o.rs1);
            e.k64(o.imm);
            e.ops(&.{ if (o.h == .slti) W.i64_lt_s else W.i64_lt_u, W.i64_ext_u });
            setReg(e, o.rd);
        },
        .slli, .srli, .srai => {
            reg(e, o.rs1);
            e.k64(o.imm & 63);
            e.op(switch (o.h) {
                .slli => W.i64_shl,
                .srli => W.i64_shr_u,
                else => W.i64_shr_s,
            });
            setReg(e, o.rd);
        },
        .slliw, .srliw, .sraiw => {
            lo32(e, o.rs1);
            e.k32(@intCast(o.imm & 31));
            e.op(switch (o.h) {
                .slliw => W.i32_shl,
                .srliw => W.i32_shr_u,
                else => W.i32_shr_s,
            });
            e.op(W.i64_ext_s);
            setReg(e, o.rd);
        },
        .li => {
            e.k64(o.imm);
            setReg(e, o.rd);
        },
        .add, .sub, .and_, .or_, .xor_, .sll, .srl, .sra, .mul, .addw, .subw, .mulw => {
            reg(e, o.rs1);
            reg(e, o.rs2);
            e.op(switch (o.h) {
                .add, .addw => W.i64_add,
                .sub, .subw => W.i64_sub,
                .and_ => W.i64_and,
                .or_ => W.i64_or,
                .xor_ => W.i64_xor,
                .sll => W.i64_shl, // wasm masks the count to 6 bits, as RV does
                .srl => W.i64_shr_u,
                .sra => W.i64_shr_s,
                else => W.i64_mul,
            });
            if (o.h == .addw or o.h == .subw or o.h == .mulw) e.ops(&.{ W.i32_wrap, W.i64_ext_s });
            setReg(e, o.rd);
        },
        .slt, .sltu => {
            reg(e, o.rs1);
            reg(e, o.rs2);
            e.ops(&.{ if (o.h == .slt) W.i64_lt_s else W.i64_lt_u, W.i64_ext_u });
            setReg(e, o.rd);
        },
        .sllw, .srlw, .sraw => {
            lo32(e, o.rs1);
            lo32(e, o.rs2); // wasm masks the count to 5 bits
            e.op(switch (o.h) {
                .sllw => W.i32_shl,
                .srlw => W.i32_shr_u,
                else => W.i32_shr_s,
            });
            e.op(W.i64_ext_s);
            setReg(e, o.rd);
        },
        .mulhu, .mulh, .mulhsu => {
            mulhu(e, o);
            if (o.h != .mulhu) mulCorr(e, o.rs1, o.rs2);
            if (o.h == .mulh) mulCorr(e, o.rs2, o.rs1);
            setReg(e, o.rd);
        },
        .div, .divu, .rem, .remu => {
            // RV: x/0 = -1 (all ones), x%0 = x, MIN/-1 = MIN, MIN%-1 = 0
            // (wasm rem_s(MIN, -1) is 0; div_s would trap, so divide by 1).
            divZero(e, o, false);
            if (o.h == .div or o.h == .divu) e.k64(std.math.maxInt(u64)) else reg(e, o.rs1);
            e.op(W.@"else");
            reg(e, o.rs1);
            if (o.h == .div) {
                e.k64(1);
                reg(e, o.rs2);
                reg(e, o.rs1);
                e.k64(1 << 63);
                e.op(W.i64_eq);
                reg(e, o.rs2);
                e.k64(std.math.maxInt(u64));
                e.op(W.i64_eq);
                e.op(W.i32_and);
                e.op(W.select);
            } else reg(e, o.rs2);
            e.op(switch (o.h) {
                .div => W.i64_div_s,
                .divu => W.i64_div_u,
                .rem => W.i64_rem_s,
                else => W.i64_rem_u,
            });
            e.close();
            setReg(e, o.rd);
        },
        .divw, .divuw, .remw, .remuw => {
            divZero(e, o, true);
            if (o.h == .divw or o.h == .divuw) e.k64(std.math.maxInt(u64)) else {
                lo32(e, o.rs1);
                e.op(W.i64_ext_s);
            }
            e.op(W.@"else");
            lo32(e, o.rs1);
            if (o.h == .divw) {
                e.k32(1);
                lo32(e, o.rs2);
                lo32(e, o.rs1);
                e.k32(std.math.minInt(i32));
                e.op(W.i32_eq);
                lo32(e, o.rs2);
                e.k32(-1);
                e.op(W.i32_eq);
                e.op(W.i32_and);
                e.op(W.select);
            } else lo32(e, o.rs2);
            e.op(switch (o.h) {
                .divw => W.i32_div_s,
                .divuw => W.i32_div_u,
                .remw => W.i32_rem_s,
                else => W.i32_rem_u,
            });
            e.op(W.i64_ext_s);
            e.close();
            setReg(e, o.rd);
        },
        .lb, .lh, .lw, .ld, .lbu, .lhu, .lwu => {
            const size: u64, const opc: u8 = switch (o.h) {
                .lb => .{ 1, 0x30 },
                .lbu => .{ 1, 0x31 },
                .lh => .{ 2, 0x32 },
                .lhu => .{ 2, 0x33 },
                .lw => .{ 4, 0x34 },
                .lwu => .{ 4, 0x35 },
                else => .{ 8, 0x29 },
            };
            hostAddr(e, o, k, pc, jc.tlb_r_off, size);
            e.mem(opc, 0, 0);
            setReg(e, o.rd);
        },
        .sb, .sh, .sw, .sd => {
            const size: u64, const opc: u8 = switch (o.h) {
                .sb => .{ 1, 0x3c },
                .sh => .{ 2, 0x3d },
                .sw => .{ 4, 0x3e },
                else => .{ 8, 0x37 },
            };
            hostAddr(e, o, k, pc, jc.tlb_w_off, size);
            reg(e, o.rs2);
            e.mem(opc, 0, 0);
        },
        .nop => {},
        .beq_x, .bne_x, .blt_x, .bge_x, .bltu_x, .bgeu_x => {
            reg(e, o.rs1);
            reg(e, o.rs2);
            e.op(cmpOp(o.h));
            e.open(W.@"if", W.void_t);
            if (e.rg) |r| e.regionSide(r, o.imm, k, b) else {
                e.exit(o.imm, code_side + k);
                e.brExit();
            }
            e.close();
        },
        .jal_c => {
            e.k64(o.imm);
            setReg(e, o.rd);
        },
        .beq, .bne, .blt, .bge, .bltu, .bgeu => {
            if (self_loop) {
                reg(e, o.rs1);
                reg(e, o.rs2);
                e.op(cmpOp(o.h));
                e.open(W.@"if", W.void_t);
                e.backEdge(b);
                e.close();
                e.exit(b.end_pc, code_done);
            } else {
                e.k64(o.imm);
                e.k64(b.end_pc);
                reg(e, o.rs1);
                reg(e, o.rs2);
                e.op(cmpOp(o.h));
                e.op(W.select);
                e.set(l_npc);
                e.k64(code_done);
                e.set(l_code);
            }
        },
        .jal => {
            e.k64(b.end_pc);
            setReg(e, o.rd);
            if (self_loop) e.backEdge(b) else e.exit(o.imm, code_done);
        },
        .jalr => {
            reg(e, o.rs1);
            e.k64(o.imm);
            e.op(W.i64_add);
            e.k64(~@as(u64, 1));
            e.op(W.i64_and);
            e.set(l_npc);
            e.k64(b.end_pc);
            setReg(e, o.rd);
            e.k64(code_done);
            e.set(l_code);
        },
        .goto => {
            if (self_loop) e.backEdge(b) else e.exit(o.imm, code_done);
        },
        .flw, .fld => {
            const size: u64 = if (o.h == .flw) 4 else 8;
            hostAddr(e, o, k, pc, jc.tlb_r_off, size);
            if (o.h == .flw) {
                e.mem(W.i64_load32_u, 0, 0);
                e.k64(box_hi);
                e.op(W.i64_or);
            } else e.mem(W.i64_load, 0, 0);
            e.set(lf(o.rd));
        },
        .fsw, .fsd => {
            hostAddr(e, o, k, pc, jc.tlb_w_off, if (o.h == .fsw) 4 else 8);
            e.get(lf(o.rs2)); // fsw stores the low 32 bits as they are (no unboxing)
            e.mem(if (o.h == .fsw) W.i64_store32 else W.i64_store, 0, 0);
        },
        .fmv_x_w => {
            e.get(lf(o.rs1));
            e.ops(&.{ W.i32_wrap, W.i64_ext_s });
            setReg(e, o.rd);
        },
        .fmv_x_d => {
            e.get(lf(o.rs1));
            setReg(e, o.rd);
        },
        .fmv_w_x, .fmv_d_x => { // f[rd] = x[rs1] | imm (fli: rs1 = x0)
            if (o.rs1 == 0) {
                e.k64((if (o.h == .fmv_w_x) box_hi else 0) | o.imm);
            } else {
                reg(e, o.rs1);
                if (o.h == .fmv_w_x or o.imm != 0) {
                    e.k64((if (o.h == .fmv_w_x) box_hi else 0) | o.imm);
                    e.op(W.i64_or);
                }
            }
            e.set(lf(o.rd));
        },
        .fsgnj_s, .fsgnj_d => if (o.imm < 4) fSgnj(e, o) else if (o.imm < 8) fMinMax(e, o) else fRound(e, o, k, pc),
        .fcmp_s, .fcmp_d => fCmp(e, o),
        .fadd_s, .fsub_s, .fmul_s, .fdiv_s, .fadd_d, .fsub_d, .fmul_d, .fdiv_d => fArith(e, o, k, pc),
        .fmadd_s, .fmsub_s, .fnmsub_s, .fnmadd_s, .fmadd_d, .fmsub_d, .fnmsub_d, .fnmadd_d => fFma(e, o, k, pc),
        .generic => fGeneric(e, o.raw, k, pc),
        .aes64es, .aes64esm, .aes64ds, .aes64dsm, .aes64im => {
            const kind = aesKind(o.h);
            if (e.x.aes_inline) {
                aesBody(e, kind, .{ .reg = o.rs1 }, .{ .reg = o.rs2 }, .{ .local = l_cpu });
            } else {
                reg(e, o.rs1);
                reg(e, o.rs2);
                e.get(l_cpu);
                e.call(e.x.fn_aes[@intFromEnum(kind)]);
            }
            setReg(e, o.rd);
        },
        .aes64ks1i => aesKs1i(e, o),
        .andn, .orn, .xnor, .rol, .ror, .rolw, .rorw, .pack, .packh, .packw, .rori, .roriw, .rev8, .brev8 => bkSimple(e, o),
        .shadd, .clz, .ctz, .cpop, .minmax, .sext, .orc_b, .bitop, .bext, .czero => zbOp(e, o),
        .clmul, .clmulh, .clmulr, .xperm4, .xperm8 => {
            const kind = bkKind(o.h);
            if (e.x.bk_inline) {
                bkBody(e, kind, .{ .reg = o.rs1 }, .{ .reg = o.rs2 }, l_bk);
            } else {
                reg(e, o.rs1);
                reg(e, o.rs2);
                e.k64(0);
                e.call(e.x.fn_bk[@intFromEnum(kind)]);
            }
            setReg(e, o.rd);
        },
        .aes64ks2 => {
            // w0 = hi(rs1) ^ lo(rs2); rd = (w0 ^ hi(rs2)) << 32 | w0
            reg(e, o.rs1);
            e.k64(32);
            e.op(W.i64_shr_u);
            reg(e, o.rs2);
            e.op(W.i64_xor);
            e.k64(0xffff_ffff);
            e.op(W.i64_and);
            e.tee(l_t0);
            reg(e, o.rs2);
            e.k64(32);
            e.op(W.i64_shr_u);
            e.op(W.i64_xor);
            e.k64(32);
            e.op(W.i64_shl);
            e.get(l_t0);
            e.op(W.i64_or);
            setReg(e, o.rd);
        },
        else => unreachable,
    }
}

// ---- Zkne / Zknd -----------------------------------------------------------------
//
// The same results as core.aes, from the tables in `AesTab` (cpu-relative):
// SubBytes is a byte-table load, SubBytes + (Inv)MixColumns of a column is
// four word-table loads, rotated by row, XORed. Pure integer code, so the
// results are exact by construction; the tests compare them with the
// interpreter (core.aes, which computes MixColumns arithmetically).

const AesK = enum(u3) { es, esm, ds, dsm, im };
const n_aes_k = @typeInfo(AesK).@"enum".fields.len;

fn aesKind(h: exec.H) AesK {
    return switch (h) {
        .aes64es => .es,
        .aes64esm => .esm,
        .aes64ds => .ds,
        .aes64dsm => .dsm,
        .aes64im => .im,
        else => unreachable,
    };
}

const aes_off = jit_off + @offsetOf(State, "aes");

/// An i64 operand: a guest register (x0 reads as 0) or a local.
const Src = union(enum) {
    reg: u8,
    local: u32,

    fn push(s: Src, e: *Emit) void {
        switch (s) {
            .reg => |r| reg(e, r),
            .local => |l| e.get(l),
        }
    }
};

/// Push the address cpu + (byte k of src) << sc (sc = 2: a u32 table).
fn aesIdx(e: *Emit, src: Src, k: u6, sc: u6, cpu: Src) void {
    src.push(e);
    const sh: i32 = 8 * @as(i32, k) - @as(i32, sc);
    if (sh > 0) {
        e.k64(@intCast(sh));
        e.op(W.i64_shr_u);
    } else if (sh < 0) {
        e.k64(@intCast(-sh));
        e.op(W.i64_shl);
    }
    e.k64(@as(u64, 0xff) << sc);
    e.op(W.i64_and);
    cpu.push(e);
    e.op(W.i64_add);
    e.addr();
}

/// Push the i64 result of AES op `kind` on operands a (rs1) and b (rs2).
fn aesBody(e: *Emit, kind: AesK, a: Src, b: Src, cpu: Src) void {
    // state bytes of the result's 8 bytes before SubBytes: (operand b?, byte)
    const BS = struct { bool, u6 };
    const fwd = [8]BS{ .{ false, 0 }, .{ false, 5 }, .{ true, 2 }, .{ true, 7 }, .{ false, 4 }, .{ true, 1 }, .{ true, 6 }, .{ false, 3 } };
    const inv = [8]BS{ .{ false, 0 }, .{ true, 5 }, .{ true, 2 }, .{ false, 7 }, .{ false, 4 }, .{ false, 1 }, .{ true, 6 }, .{ true, 3 } };
    const ident = [8]BS{ .{ false, 0 }, .{ false, 1 }, .{ false, 2 }, .{ false, 3 }, .{ false, 4 }, .{ false, 5 }, .{ false, 6 }, .{ false, 7 } };
    const src = switch (kind) {
        .es, .esm => fwd,
        .ds, .dsm => inv,
        .im => ident,
    };
    switch (kind) {
        .es, .ds => {
            const off: u64 = aes_off + @as(u64, if (kind == .es) @offsetOf(AesTab, "s") else @offsetOf(AesTab, "is"));
            for (src, 0..) |sb, j| {
                aesIdx(e, if (sb[0]) b else a, sb[1], 0, cpu);
                e.mem(W.i64_load8_u, 0, off);
                if (j > 0) {
                    e.k64(8 * j);
                    e.op(W.i64_shl);
                    e.op(W.i64_or);
                }
            }
        },
        .esm, .dsm, .im => {
            const off: u64 = aes_off + @as(u64, switch (kind) {
                .esm => @offsetOf(AesTab, "te"),
                .dsm => @offsetOf(AesTab, "td"),
                else => @offsetOf(AesTab, "im"),
            });
            for (0..2) |c| {
                for (0..4) |r| {
                    const sb = src[4 * c + r];
                    aesIdx(e, if (sb[0]) b else a, sb[1], 2, cpu);
                    e.mem(W.i32_load, 2, off);
                    if (r > 0) {
                        e.k32(@intCast(8 * r));
                        e.op(W.i32_rotl);
                        e.op(W.i32_xor);
                    }
                }
                e.op(W.i64_ext_u);
                if (c == 1) {
                    e.k64(32);
                    e.op(W.i64_shl);
                    e.op(W.i64_or);
                }
            }
        },
    }
}

/// A helper function of type 1, (rs1, rs2, cpu) -> result, for AES op `kind`.
fn aesHelper(e: *Emit, kind: AesK) void {
    const body = e.reserve();
    e.op(0x00); // no locals besides the parameters
    aesBody(e, kind, .{ .local = 0 }, .{ .local = 1 }, .{ .local = 2 });
    e.op(W.end);
    e.patch(body);
}

/// aes64ks1i: w = SubWord(rnum == 10 ? hi(rs1) : ror32(hi(rs1), 8)) ^ rcon;
/// rd = w << 32 | w (t0 holds the word).
fn aesKs1i(e: *Emit, o: Op) void {
    const rnum: u4 = @intCast(o.imm & 0xf);
    reg(e, o.rs1);
    e.k64(32);
    e.op(W.i64_shr_u);
    if (rnum != 0xa) {
        e.tee(l_t0);
        e.k64(8);
        e.op(W.i64_shr_u);
        e.get(l_t0);
        e.k64(24);
        e.op(W.i64_shl);
        e.op(W.i64_or);
    }
    e.set(l_t0);
    const off: u64 = aes_off + @offsetOf(AesTab, "s");
    for (0..4) |j| {
        aesIdx(e, .{ .local = l_t0 }, @intCast(j), 0, .{ .local = l_cpu });
        e.mem(W.i64_load8_u, 0, off);
        if (j > 0) {
            e.k64(8 * j);
            e.op(W.i64_shl);
            e.op(W.i64_or);
        }
    }
    e.k64(core.aes.rcon[rnum]);
    e.op(W.i64_xor);
    e.tee(l_t0);
    e.k64(32);
    e.op(W.i64_shl);
    e.get(l_t0);
    e.op(W.i64_or);
    setReg(e, o.rd);
}

// ---- Zbkb / Zbc / Zbkc / Zbkx --------------------------------------------------------
//
// The same results as core.bitmanip, in MVP integer code: rotates are wasm
// rotates (whose counts wrap like RISC-V's), rev8 and brev8 swap bit groups
// with masks, clmul* are core.bitmanip's fixed multiplication sequence
// (bmul64, and bit reversals for the high half), xperm* select every byte
// or nibble with a shift (and `select` for an out-of-range byte index). No
// branches, so like the interpreter's these take the same time for any
// data. clmul* and xperm* are 100-300 instructions: a block with at most
// `bk_inline_max` of them gets them inline, more call one helper per kind.

const BkK = enum(u3) { clmul, clmulh, clmulr, xperm4, xperm8 };
const n_bk_k = @typeInfo(BkK).@"enum".fields.len;

/// Blocks with at most this many clmul/clmulh/clmulr/xperm4/xperm8 ops get
/// them inline; more call one helper function per kind, shared by the
/// module. Decided per block, like FMAs and AES ops. 12 covers OpenSSL's
/// GHASH loop (6 clmul + 6 clmulh, about 6.5 KB of module inline), which
/// runs 3-4% faster inline than through helpers.
const bk_inline_max = 12;

/// The i64 scratch locals of an inline clmul/xperm body: those of an inline
/// FMA body (which holds nothing across ops either).
const l_bk = l_fma_i;
/// How many of them a body uses (t .. t + 9).
const n_bk_locals = 10;

fn bkKind(h: exec.H) BkK {
    return switch (h) {
        .clmul => .clmul,
        .clmulh => .clmulh,
        .clmulr => .clmulr,
        .xperm4 => .xperm4,
        .xperm8 => .xperm8,
        else => unreachable,
    };
}

/// The i64 on the stack, v -> ((v >> s) & m) | ((v & m) << s): swaps the
/// bit groups that m selects with their neighbours s bits up (t: scratch).
fn swapBits(e: *Emit, s: u6, m: u64, t: u32) void {
    e.tee(t);
    e.k64(s);
    e.op(W.i64_shr_u);
    e.k64(m);
    e.op(W.i64_and);
    e.get(t);
    e.k64(m);
    e.op(W.i64_and);
    e.k64(s);
    e.op(W.i64_shl);
    e.op(W.i64_or);
}
/// Byte-reverse the i64 on the stack (rev8).
fn rev8Seq(e: *Emit, t: u32) void {
    e.k64(32);
    e.op(W.i64_rotl);
    swapBits(e, 16, 0x0000_ffff_0000_ffff, t);
    swapBits(e, 8, 0x00ff_00ff_00ff_00ff, t);
}
/// Reverse the bits of every byte of the i64 on the stack (brev8).
fn brev8Seq(e: *Emit, t: u32) void {
    swapBits(e, 4, 0x0f0f_0f0f_0f0f_0f0f, t);
    swapBits(e, 2, 0x3333_3333_3333_3333, t);
    swapBits(e, 1, 0x5555_5555_5555_5555, t);
}

/// Push clmul(a, b), core.bitmanip.clmul's sequence (locals t .. t + 7).
fn bmul64(e: *Emit, a: Src, b: Src, t: u32) void {
    const m0: u64 = 0x1111_1111_1111_1111;
    for (0..4) |i| {
        a.push(e);
        e.k64(m0 << @intCast(i));
        e.op(W.i64_and);
        e.set(t + @as(u32, @intCast(i)));
    }
    for (0..4) |i| {
        b.push(e);
        e.k64(m0 << @intCast(i));
        e.op(W.i64_and);
        e.set(t + 4 + @as(u32, @intCast(i)));
    }
    for (0..4) |k| {
        for (0..4) |i| {
            e.get(t + @as(u32, @intCast(i)));
            e.get(t + 4 + @as(u32, @intCast((k + 4 - i) % 4)));
            e.op(W.i64_mul);
            if (i > 0) e.op(W.i64_xor);
        }
        e.k64(m0 << @intCast(k));
        e.op(W.i64_and);
        if (k > 0) e.op(W.i64_or);
    }
}

/// Push the i64 result of op `kind` on a (rs1) and b (rs2); scratch locals
/// t .. t + n_bk_locals - 1.
fn bkBody(e: *Emit, kind: BkK, a: Src, b: Src, t: u32) void {
    switch (kind) {
        .clmul => bmul64(e, a, b, t),
        .clmulh, .clmulr => {
            // rev(clmul(rev a, rev b)), shifted right by one for clmulh
            const ra = t + 8;
            const rb = t + 9;
            a.push(e);
            rev8Seq(e, ra);
            brev8Seq(e, ra);
            e.set(ra);
            b.push(e);
            rev8Seq(e, rb);
            brev8Seq(e, rb);
            e.set(rb);
            bmul64(e, .{ .local = ra }, .{ .local = rb }, t);
            rev8Seq(e, ra);
            brev8Seq(e, ra);
            if (kind == .clmulh) {
                e.k64(1);
                e.op(W.i64_shr_u);
            }
        },
        .xperm8 => for (0..8) |i| {
            // idx = byte i of b; (a >> 8 idx) & 0xff if idx < 8, else 0
            b.push(e);
            if (i > 0) {
                e.k64(8 * i);
                e.op(W.i64_shr_u);
            }
            e.k64(0xff);
            e.op(W.i64_and);
            e.set(t);
            a.push(e);
            e.get(t);
            e.k64(3);
            e.op(W.i64_shl);
            e.op(W.i64_shr_u);
            e.k64(0xff);
            e.op(W.i64_and);
            if (i > 0) {
                e.k64(8 * i);
                e.op(W.i64_shl);
            }
            e.k64(0);
            e.get(t);
            e.k64(8);
            e.op(W.i64_lt_u);
            e.op(W.select);
            if (i > 0) e.op(W.i64_or);
        },
        .xperm4 => for (0..16) |i| {
            // (a >> 4 idx) & 0xf, idx = nibble i of b (4 idx = (b >> (4i - 2)) & 0x3c)
            a.push(e);
            b.push(e);
            if (i == 0) {
                e.k64(2);
                e.op(W.i64_shl);
            } else {
                e.k64(4 * i - 2);
                e.op(W.i64_shr_u);
            }
            e.k64(0x3c);
            e.op(W.i64_and);
            e.op(W.i64_shr_u);
            e.k64(0xf);
            e.op(W.i64_and);
            if (i > 0) {
                e.k64(4 * i);
                e.op(W.i64_shl);
                e.op(W.i64_or);
            }
        },
    }
}

/// A helper function of type 1, (rs1, rs2, unused) -> result, for op `kind`.
fn bkHelper(e: *Emit, kind: BkK) void {
    const body = e.reserve();
    e.ops(&.{ 0x01, n_bk_locals, W.i64_t });
    bkBody(e, kind, .{ .local = 0 }, .{ .local = 1 }, 3);
    e.op(W.end);
    e.patch(body);
}

/// The Zbkb ops (and those Zbb shares), always inline.
fn bkSimple(e: *Emit, o: Op) void {
    const ones = std.math.maxInt(u64);
    switch (o.h) {
        .andn, .orn => {
            reg(e, o.rs1);
            reg(e, o.rs2);
            e.k64(ones);
            e.op(W.i64_xor);
            e.op(if (o.h == .andn) W.i64_and else W.i64_or);
        },
        .xnor => {
            reg(e, o.rs1);
            reg(e, o.rs2);
            e.op(W.i64_xor);
            e.k64(ones);
            e.op(W.i64_xor);
        },
        .rol, .ror => {
            reg(e, o.rs1);
            reg(e, o.rs2); // wasm takes the count mod 64, as RISC-V does
            e.op(if (o.h == .rol) W.i64_rotl else W.i64_rotr);
        },
        .rori => {
            reg(e, o.rs1);
            e.k64(o.imm & 63);
            e.op(W.i64_rotr);
        },
        .rolw, .rorw => {
            lo32(e, o.rs1);
            lo32(e, o.rs2); // mod 32
            e.ops(&.{ if (o.h == .rolw) W.i32_rotl else W.i32_rotr, W.i64_ext_s });
        },
        .roriw => {
            lo32(e, o.rs1);
            e.k32(@intCast(o.imm & 31));
            e.ops(&.{ W.i32_rotr, W.i64_ext_s });
        },
        .pack => {
            reg(e, o.rs1);
            e.ops(&.{ W.i32_wrap, W.i64_ext_u });
            reg(e, o.rs2);
            e.k64(32);
            e.op(W.i64_shl);
            e.op(W.i64_or);
        },
        .packh => {
            reg(e, o.rs1);
            e.k64(0xff);
            e.op(W.i64_and);
            reg(e, o.rs2);
            e.k64(0xff);
            e.op(W.i64_and);
            e.k64(8);
            e.op(W.i64_shl);
            e.op(W.i64_or);
        },
        .packw => {
            lo32(e, o.rs1);
            e.k32(0xffff);
            e.op(W.i32_and);
            lo32(e, o.rs2);
            e.k32(16);
            e.op(W.i32_shl);
            e.ops(&.{ W.i32_or, W.i64_ext_s });
        },
        .rev8 => {
            reg(e, o.rs1);
            rev8Seq(e, l_t0);
        },
        .brev8 => {
            reg(e, o.rs1);
            brev8Seq(e, l_t0);
        },
        else => unreachable,
    }
    setReg(e, o.rd);
}

// ---- Zba / Zbb / Zbs / Zicond ------------------------------------------------------
//
// One short MVP sequence per op, specialised on the op's imm (which picks
// the variant, see exec.H): wasm clz/ctz/popcnt (i32 forms for the W
// variants), compare + select for min/max and czero, shifts for sext.b/h
// (sign-extension opcodes are not MVP), shift-and-mask for the bit ops.

fn zbOp(e: *Emit, o: Op) void {
    const ones = std.math.maxInt(u64);
    switch (o.h) {
        .shadd => {
            reg(e, o.rs1);
            if (o.imm & 64 != 0) e.ops(&.{ W.i32_wrap, W.i64_ext_u }); // .uw
            if (o.imm & 63 != 0) {
                e.k64(o.imm & 63);
                e.op(W.i64_shl);
            }
            if (o.rs2 != 0) {
                reg(e, o.rs2);
                e.op(W.i64_add);
            }
        },
        .clz, .ctz, .cpop => {
            const w = o.imm != 0 and o.imm != ones; // clzw, ctzw, cpopw
            if (w) {
                lo32(e, o.rs1);
                e.ops(&.{ switch (o.h) {
                    .clz => W.i32_clz,
                    .ctz => W.i32_ctz,
                    else => W.i32_popcnt,
                }, W.i64_ext_u });
            } else {
                reg(e, o.rs1);
                e.op(switch (o.h) {
                    .clz => W.i64_clz,
                    .ctz => W.i64_ctz,
                    else => W.i64_popcnt,
                });
            }
        },
        .minmax => {
            // select(rs1, rs2, rs1 > rs2) (max) or rs1 < rs2 (min)
            reg(e, o.rs1);
            reg(e, o.rs2);
            reg(e, o.rs1);
            reg(e, o.rs2);
            const u = o.imm >> 63 != 0;
            e.op(if (o.imm & 1 != 0) (if (u) W.i64_gt_u else W.i64_gt_s) else (if (u) W.i64_lt_u else W.i64_lt_s));
            e.op(W.select);
        },
        .sext => {
            reg(e, o.rs1);
            e.k64(o.imm & 63);
            e.op(W.i64_shl);
            e.k64(o.imm & 63);
            e.op(W.i64_shr_s);
        },
        .orc_b => {
            // core.bitmanip.orcb: ((((a & 0x7f..) + 0x7f..) | a) >> 7 & 0x01..) * 0xff
            const lo7: u64 = 0x7f7f_7f7f_7f7f_7f7f;
            reg(e, o.rs1);
            e.k64(lo7);
            e.op(W.i64_and);
            e.k64(lo7);
            e.op(W.i64_add);
            reg(e, o.rs1);
            e.op(W.i64_or);
            e.k64(7);
            e.op(W.i64_shr_u);
            e.k64(0x0101_0101_0101_0101);
            e.op(W.i64_and);
            e.k64(0xff);
            e.op(W.i64_mul);
        },
        .bitop => {
            // bclr (imm 1): a & ~m, bset (3): a | m, binv (2): a ^ m
            reg(e, o.rs1);
            e.k64(1);
            reg(e, o.rs2); // wasm takes the count mod 64, as RISC-V does
            e.op(W.i64_shl);
            if (o.imm == 1) {
                e.k64(ones);
                e.op(W.i64_xor);
            }
            e.op(switch (o.imm) {
                1 => W.i64_and,
                3 => W.i64_or,
                else => W.i64_xor,
            });
        },
        .bext => {
            reg(e, o.rs1);
            if (o.rs2 == 0) e.k64(o.imm & 63) else {
                reg(e, o.rs2);
                if (o.imm != 0) {
                    e.k64(o.imm);
                    e.op(W.i64_add);
                }
            }
            e.op(W.i64_shr_u);
            e.k64(1);
            e.op(W.i64_and);
        },
        .czero => {
            // eqz: select(0, rs1, rs2 == 0); nez: select(rs1, 0, rs2 == 0)
            if (o.imm == 0) {
                e.k64(0);
                reg(e, o.rs1);
            } else {
                reg(e, o.rs1);
                e.k64(0);
            }
            reg(e, o.rs2);
            e.op(W.i64_eqz);
            e.op(W.select);
        },
        else => unreachable,
    }
    setReg(e, o.rd);
}

// ---- F/D -------------------------------------------------------------------------
//
// The emitted code computes exactly what exec.doOp / core.exec compute
// (src/cpu/fpu.zig), bit for bit and flag for flag, or hands the op back:
//   * Pure bit operations (loads, stores, moves, sign injection, NaN-boxing,
//     compares, classify, min/max) are mirrored exactly; wasm float compares
//     are deterministic.
//   * Arithmetic mirrors fpu.zig's RNE fast paths: the same host operation
//     (IEEE round-to-nearest-even in wasm as on the native host), the same
//     result-range test (a normal result with biased exponent in
//     [2, emax - 2], so no NaN, infinity, zero, subnormal or overflow), and
//     the same exact inexact test. Everything outside that range (where the
//     interpreter takes its integer path, or where wasm NaN bits would be
//     nondeterministic) is handed back before it executes.
//   * Rounding: static RNE, or dynamic with frm == RNE (tested at run time;
//     anything else, including an illegal frm, is handed back).
//   * Flags are ORed into a local copy of fcsr, written back at the exit.

/// The bits of FP operand f[r]: the register's local for doubles; for
/// singles the unboxed value (a register that is not NaN-boxed reads as the
/// canonical NaN, core.unbox) zero-extended, in local `tmp`.
fn fsrc(e: *Emit, r: u32, dbl: bool, tmp: u32) u32 {
    if (dbl) return lf(r);
    e.get(lf(r));
    e.k64(qnan_s);
    e.get(lf(r));
    e.k64(box_hi);
    e.op(W.i64_ge_u);
    e.op(W.select);
    e.k64(0xffff_ffff);
    e.op(W.i64_and);
    e.set(tmp);
    return tmp;
}

/// Hand op k back unless frm is RNE (only for a dynamic rounding mode, and
/// only once per module: see Emit.frm_checked).
fn frmCheck(e: *Emit, dyn: bool, k: usize, pc: u64) void {
    if (!dyn or e.x.frm_checked) return;
    e.x.frm_checked = true;
    e.get(l_fcsr);
    e.k64(0xe0);
    e.op(W.i64_and);
    e.op(W.i64_eqz);
    e.op(W.i32_eqz);
    e.open(W.@"if", W.void_t);
    e.handBack(k, pc);
    e.close();
}

/// fcsr |= (the i32 condition on the stack) << shift.
fn orFlag(e: *Emit, shift: u6) void {
    e.op(W.i64_ext_u);
    if (shift != 0) {
        e.k64(shift);
        e.op(W.i64_shl);
    }
    e.get(l_fcsr);
    e.op(W.i64_or);
    e.set(l_fcsr);
}

/// Push i32: the biased exponent of the result bits in local l is outside
/// [2, emax - 2] (fpu.zig's fast-path range).
fn outOfRange(e: *Emit, l: u32, dbl: bool) void {
    e.get(l);
    e.k64(if (dbl) 52 else 23);
    e.op(W.i64_shr_u);
    e.k64(if (dbl) 0x7ff else 0xff);
    e.op(W.i64_and);
    e.k64(2);
    e.op(W.i64_sub);
    e.k64(if (dbl) 2044 else 252);
    e.op(W.i64_ge_u);
}

fn handBackIf(e: *Emit, k: usize, pc: u64) void {
    e.open(W.@"if", W.void_t);
    e.handBack(k, pc);
    e.close();
}

/// Push fpu.oddSig of the finite bits in local l (tmp: scratch).
fn oddSig(e: *Emit, l: u32, dbl: bool, tmp: u32) void {
    const mb: u64 = if (dbl) 52 else 23;
    e.get(l);
    e.k64((@as(u64, 1) << @intCast(mb)) - 1);
    e.op(W.i64_and);
    e.get(l);
    e.k64(if (dbl) inf_d else inf_s);
    e.op(W.i64_and);
    e.k64(0);
    e.op(W.i64_ne);
    e.op(W.i64_ext_u);
    e.k64(mb);
    e.op(W.i64_shl);
    e.op(W.i64_or);
    e.tee(tmp);
    e.get(tmp);
    e.op(W.i64_ctz);
    e.op(W.i64_shr_u);
}

/// Push i32: bits in l are a NaN / a signalling NaN (fpu isNan / isSnan).
fn isNan(e: *Emit, l: u32, dbl: bool) void {
    e.get(l);
    e.k64(if (dbl) ~sign_d else sign_s - 1);
    e.op(W.i64_and);
    e.k64(if (dbl) inf_d else inf_s);
    e.op(W.i64_gt_u);
}
fn isSnan(e: *Emit, l: u32, dbl: bool, tmp: u32) void {
    e.get(l);
    e.k64(if (dbl) ~sign_d else sign_s - 1);
    e.op(W.i64_and);
    e.tee(tmp);
    e.k64(if (dbl) inf_d else inf_s);
    e.op(W.i64_gt_u);
    e.get(tmp);
    e.k64(if (dbl) qnan_d else qnan_s);
    e.op(W.i64_lt_u);
    e.op(W.i32_and);
}

/// Push the float compare `la <op> lb` (i32) of the bits in two locals.
fn fCompare(e: *Emit, la: u32, lb: u32, dbl: bool, comptime which: enum { eq, lt, le }) void {
    for ([_]u32{ la, lb }) |l| {
        e.get(l);
        if (dbl) e.op(W.f64_reinterpret) else e.ops(&.{ W.i32_wrap, W.f32_reinterpret });
    }
    e.op(switch (which) {
        .eq => if (dbl) W.f64_eq else W.f32_eq,
        .lt => if (dbl) W.f64_lt else W.f32_lt,
        .le => if (dbl) W.f64_le else W.f32_le,
    });
}

/// Pop result bits into f[rd] (NaN-boxing singles).
fn fdst(e: *Emit, rd: u32, dbl: bool) void {
    if (!dbl) {
        e.k64(box_hi);
        e.op(W.i64_or);
    }
    e.set(lf(rd));
}

fn fSgnj(e: *Emit, o: Op) void {
    const dbl = o.h == .fsgnj_d;
    const sg: u64 = if (dbl) sign_d else sign_s;
    const a = fsrc(e, o.rs1, dbl, l_t5);
    const b = fsrc(e, o.rs2, dbl, l_t5 + 1);
    e.get(a);
    e.k64(sg - 1); // ~sign within the format
    e.op(W.i64_and);
    switch (o.imm) {
        0, 1 => {
            e.get(b);
            e.k64(sg);
            e.op(W.i64_and);
            if (o.imm == 1) {
                e.k64(sg);
                e.op(W.i64_xor);
            }
        },
        else => {
            e.get(a);
            e.get(b);
            e.op(W.i64_xor);
            e.k64(sg);
            e.op(W.i64_and);
        },
    }
    e.op(W.i64_or);
    fdst(e, o.rd, dbl);
}

fn fCmp(e: *Emit, o: Op) void {
    const dbl = o.h == .fcmp_d;
    const a = fsrc(e, o.rs1, dbl, l_t5);
    const b = fsrc(e, o.rs2, dbl, l_t5 + 1);
    // feq, fleq and fltq are quiet compares (NV only for signalling NaNs);
    // flt/fle signal on any NaN.
    if (o.imm == 2 or o.imm >= 4) {
        isSnan(e, a, dbl, l_t5 + 2);
        isSnan(e, b, dbl, l_t5 + 2);
    } else {
        isNan(e, a, dbl);
        isNan(e, b, dbl);
    }
    e.op(W.i32_or);
    orFlag(e, 4);
    switch (o.imm) {
        2 => fCompare(e, a, b, dbl, .eq),
        1, 5 => fCompare(e, a, b, dbl, .lt),
        else => fCompare(e, a, b, dbl, .le),
    }
    e.op(W.i64_ext_u);
    setReg(e, o.rd);
}

/// fmin / fmax, fminm / fmaxm (Zfa): fsgnj kind, imm = 4 | funct3.
fn fMinMax(e: *Emit, o: Op) void {
    const dbl = o.h == .fsgnj_d;
    const a = fsrc(e, o.rs1, dbl, l_t5);
    const b = fsrc(e, o.rs2, dbl, l_t5 + 1);
    const max = o.imm & 1 != 0;
    const m = o.imm & 2 != 0; // fminm / fmaxm: any NaN gives the canonical NaN
    isSnan(e, a, dbl, l_t5 + 2);
    isSnan(e, b, dbl, l_t5 + 2);
    e.op(W.i32_or);
    orFlag(e, 4);
    // nan(a) ? (nan(b) or m ? qnan : b) : nan(b) ? (m ? qnan : a) : compare
    e.k64(if (dbl) qnan_d else qnan_s);
    if (!m) {
        e.get(b);
        isNan(e, b, dbl);
        e.op(W.select);
    }
    if (m) e.k64(if (dbl) qnan_d else qnan_s) else e.get(a);
    // compare: min: a < b ? a : b < a ? b : a | b
    //          max: b < a ? a : a < b ? b : a & b
    e.get(a);
    e.get(b);
    e.get(a);
    e.get(b);
    e.op(if (max) W.i64_and else W.i64_or);
    if (max) fCompare(e, a, b, dbl, .lt) else fCompare(e, b, a, dbl, .lt);
    e.op(W.select);
    if (max) fCompare(e, b, a, dbl, .lt) else fCompare(e, a, b, dbl, .lt);
    e.op(W.select);
    isNan(e, b, dbl);
    e.op(W.select);
    isNan(e, a, dbl);
    e.op(W.select);
    fdst(e, o.rd, dbl);
}

/// fround / froundnx (Zfa): fsgnj kind, imm = 16 | rm (24 | rm: froundnx).
/// wasm's nearest/trunc/floor/ceil are exact (RNE/RTZ/RDN/RUP) and keep
/// the sign of a zero result; a NaN is handed back, RMM is not translated,
/// a dynamic mode must be RNE (frmCheck). A single rounds through f64:
/// promoting is exact, and so is demoting an integral value.
fn fRound(e: *Emit, o: Op, k: usize, pc: u64) void {
    const dbl = o.h == .fsgnj_d;
    const rm = o.imm & 7;
    frmCheck(e, rm == 7, k, pc);
    const a = fsrc(e, o.rs1, dbl, l_t5);
    const r = l_t5 + 1;
    isNan(e, a, dbl);
    handBackIf(e, k, pc);
    if (dbl) e.getD(a) else e.getS(a);
    e.op(switch (rm) {
        1 => W.f64_trunc,
        2 => W.f64_floor,
        3 => W.f64_ceil,
        else => W.f64_nearest, // 0, or 7 with frm = RNE
    });
    if (dbl) e.op(W.i64_reinterpret) else e.ops(&.{ W.f32_demote, W.i32_reinterpret, W.i64_ext_u });
    e.set(r);
    if (o.imm & 8 != 0) { // froundnx: inexact iff the value changed
        if (dbl) e.getD(r) else e.getS(r);
        if (dbl) e.getD(a) else e.getS(a);
        e.op(W.f64_ne);
        orFlag(e, 0);
    }
    e.get(r);
    fdst(e, o.rd, dbl);
}

fn fArith(e: *Emit, o: Op, k: usize, pc: u64) void {
    const dbl = switch (o.h) {
        .fadd_d, .fsub_d, .fmul_d, .fdiv_d => true,
        else => false,
    };
    const kind: enum { add, mul, div } = switch (o.h) {
        .fadd_s, .fsub_s, .fadd_d, .fsub_d => .add,
        .fmul_s, .fmul_d => .mul,
        else => .div,
    };
    const x = l_d0;
    const y = l_d0 + 1;
    const r = l_d0 + 2;
    const tr = l_t5 + 2;
    frmCheck(e, o.imm & 7 == 7, k, pc);
    const a = fsrc(e, o.rs1, dbl, l_t5);
    var b = fsrc(e, o.rs2, dbl, l_t5 + 1);
    if (o.h == .fsub_s or o.h == .fsub_d) { // sub(a, b) = add(a, b ^ sign)
        e.get(b);
        e.k64(if (dbl) sign_d else sign_s);
        e.op(W.i64_xor);
        e.set(l_t5 + 1);
        b = l_t5 + 1;
    }
    if (dbl) e.getD(a) else e.getS(a);
    e.set(x);
    if (dbl) e.getD(b) else e.getS(b);
    e.set(y);
    e.get(x);
    e.get(y);
    e.op(switch (kind) {
        .add => W.f64_add,
        .mul => W.f64_mul,
        .div => W.f64_div,
    });
    // f64: rb = bits(x op y); f32: rb = bits(f32(x op y)) (the f64 sum and
    // product are what fpu.zig rounds, the quotient is rounded directly)
    if (dbl) {
        e.tee(r);
        e.op(W.i64_reinterpret);
    } else {
        if (kind != .div) e.tee(r);
        e.ops(&.{ W.f32_demote, W.i32_reinterpret, W.i64_ext_u });
    }
    e.set(tr);
    outOfRange(e, tr, dbl);
    handBackIf(e, k, pc);
    // inexact (only while NX is clear: once set, it cannot change fcsr)
    nxClear(e);
    switch (kind) {
        .add => {
            // TwoSum: bv = r - x, av = r - bv, err = (x - av) + (y - bv)
            const bv = l_d0 + 3;
            const av = l_d0 + 4;
            e.get(r);
            e.get(x);
            e.op(W.f64_sub);
            e.set(bv);
            e.get(r);
            e.get(bv);
            e.op(W.f64_sub);
            e.set(av);
            e.get(x);
            e.get(av);
            e.op(W.f64_sub);
            e.get(y);
            e.get(bv);
            e.op(W.f64_sub);
            e.op(W.f64_add);
            e.kf(0);
            e.op(W.f64_ne);
            if (!dbl) {
                e.getS(tr);
                e.get(r);
                e.op(W.f64_ne);
                e.op(W.i32_or);
            }
        },
        .mul => if (dbl) {
            // exact iff the product of the odd significands fits in 53 bits
            const oa = l_t5 + 3;
            const ob = l_t5 + 4;
            const n = l_t5;
            oddSig(e, a, true, oa);
            e.set(oa);
            oddSig(e, b, true, ob);
            e.set(ob);
            e.k64(128);
            e.get(oa);
            e.op(W.i64_clz);
            e.op(W.i64_sub);
            e.get(ob);
            e.op(W.i64_clz);
            e.op(W.i64_sub);
            e.tee(n);
            e.k64(53);
            e.op(W.i64_le_u);
            e.get(n);
            e.k64(54);
            e.op(W.i64_eq);
            e.get(oa);
            e.get(ob);
            e.op(W.i64_mul);
            e.k64(1 << 53);
            e.op(W.i64_lt_u);
            e.op(W.i32_and);
            e.op(W.i32_or);
            e.op(W.i32_eqz);
        } else {
            e.getS(tr);
            e.get(r);
            e.op(W.f64_ne);
        },
        .div => if (dbl) {
            // exact iff oddSig(b) divides oddSig(a)
            oddSig(e, a, true, l_t5 + 3);
            oddSig(e, b, true, l_t5 + 4);
            e.op(W.i64_rem_u);
            e.k64(0);
            e.op(W.i64_ne);
        } else {
            e.getS(tr);
            e.get(y);
            e.op(W.f64_mul);
            e.get(x);
            e.op(W.f64_ne);
        },
    }
    orFlag(e, 0);
    e.close();
    e.get(tr);
    fdst(e, o.rd, dbl);
}

/// if (fcsr.NX == 0) { ... }: the caller closes it.
fn nxClear(e: *Emit) void {
    e.get(l_fcsr);
    e.k64(1);
    e.op(W.i64_and);
    e.op(W.i64_eqz);
    e.open(W.@"if", W.void_t);
}

fn fFma(e: *Emit, o: Op, k: usize, pc: u64) void {
    const dbl = switch (o.h) {
        .fmadd_d, .fmsub_d, .fnmsub_d, .fnmadd_d => true,
        else => false,
    };
    const neg_a = switch (o.h) {
        .fnmsub_s, .fnmsub_d, .fnmadd_s, .fnmadd_d => true,
        else => false,
    };
    const neg_c = switch (o.h) {
        .fmsub_s, .fmsub_d, .fnmadd_s, .fnmadd_d => true,
        else => false,
    };
    const sg: u64 = if (dbl) sign_d else sign_s;
    frmCheck(e, o.imm & 7 == 7, k, pc);
    const regs = [3]u32{ o.rs1, o.rs2, @intCast((o.imm >> 8) & 31) };
    for (regs, 0..) |rr, i| {
        const l = fsrc(e, rr, dbl, l_t5 + @as(u32, @intCast(i)));
        e.get(l);
        if ((i == 0 and neg_a) or (i == 2 and neg_c)) {
            e.k64(sg);
            e.op(W.i64_xor);
        }
    }
    if (e.x.fma_inline) {
        for (0..3) |i| e.set(l_fma_i + 2 - @as(u32, @intCast(i)));
        e.open(W.block, W.i64_t);
        e.x.fma_nest = e.nest;
        if (dbl) fmaBody(e, u64, true) else fmaBody(e, u32, true);
        e.close();
        e.x.fma_nest = 0;
    } else e.call(if (dbl) e.x.fn_fmad else e.x.fn_fmas);
    e.set(l_t5 + 3);
    // status: 0 exact, 1 inexact, 2 hand back
    fmaStatus(e);
    e.k32(2);
    e.op(W.i32_eq);
    handBackIf(e, k, pc);
    fmaStatus(e);
    orFlag(e, 0);
    e.get(l_t5 + 3);
    fdst(e, o.rd, dbl);
}

/// Push the last FMA body's status (i32).
fn fmaStatus(e: *Emit) void {
    if (e.x.fma_inline) {
        e.get(l_fma_st);
        e.op(W.i32_wrap);
    } else e.gget();
}

/// The FMA body for format B: (a, b, c) -> result bits, operands already
/// sign-adjusted and unboxed, mirroring fpu.Fmt(B).fma for RNE: the
/// zero-product case, for f64 the zero-addend case (the product, as fpu's
/// mul fast path) and Boldo & Melquiond's emulated FMA (fma64Fast) with its
/// operand and result guards, for f32 fma32Fast. Its status is 0 (exact),
/// 1 (inexact) or 2 (the interpreter must do it: NaN/infinite operands,
/// out-of-range operands or results). Emitted either as a helper function
/// of type 1 (status in global 0) or inline in f inside a `block (result
/// i64)` whose nesting level is e.x.fma_nest (operands in l_fma_i.., status
/// in l_fma_st).
fn fmaBody(e: *Emit, comptime B: type, comptime inl: bool) void {
    const dbl = B == u64;
    const shift: u64 = if (dbl) 52 else 23;
    const emax: u64 = if (dbl) 0x7ff else 0xff;
    const body = if (inl) 0 else e.reserve();
    if (!inl) {
        e.op(0x02);
        e.uleb(7);
        e.op(W.i64_t);
        e.uleb(16);
        e.op(W.f64_t);
    }
    // i64 locals 0..9 (params a, b, c first), f64 locals 10..25
    const L = struct {
        fn i(n: u32) u32 {
            return if (inl) l_fma_i + n else n;
        }
        fn f(n: u32) u32 {
            return if (inl) l_fma_f + n - 10 else n;
        }
    };
    const pa = L.i(0);
    const pb = L.i(1);
    const pc_ = L.i(2);
    const ea = L.i(3);
    const eb = L.i(4);
    const ec = L.i(5);
    const t = L.i(6);
    const t2 = L.i(7);
    const t3 = L.i(8);
    const t4 = L.i(9);
    const fx = L.f(10);
    const fy = L.f(11);
    const fz = L.f(12);
    const fp = L.f(13);
    const xh = L.f(14);
    const xl = L.f(15);
    const yh = L.f(16);
    const yl = L.f(17);
    const pl = L.f(18);
    const sh = L.f(19);
    const sl = L.f(20);
    const fu = L.f(21);
    const ue = L.f(22);
    const fr = L.f(23);
    const tmp = L.f(24);
    const tmp2 = L.f(25);
    const H = struct {
        /// status = (i32 on the stack)
        fn status(em: *Emit) void {
            if (inl) {
                em.op(W.i64_ext_u);
                em.set(l_fma_st);
            } else em.gset();
        }
        /// return (the result bits on the stack)
        fn ret(em: *Emit) void {
            if (inl) {
                em.op(W.br);
                em.uleb(em.nest - em.x.fma_nest);
            } else em.op(W.@"return");
        }
        fn handBack(em: *Emit) void {
            em.k32(2);
            status(em);
            em.k64(0);
            ret(em);
        }
        fn handBackIf(em: *Emit) void {
            em.open(W.@"if", W.void_t);
            handBack(em);
            em.close();
        }
        /// Push f64 of the operand bits in local l.
        fn val(em: *Emit, l: u32) void {
            if (dbl) em.getD(l) else em.getS(l);
        }
        fn sub(em: *Emit, a: u32, b: u32) void {
            em.get(a);
            em.get(b);
            em.op(W.f64_sub);
        }
    };
    for ([_][2]u32{ .{ pa, ea }, .{ pb, eb }, .{ pc_, ec } }) |pe| {
        e.get(pe[0]);
        e.k64(shift);
        e.op(W.i64_shr_u);
        e.k64(emax);
        e.op(W.i64_and);
        e.set(pe[1]);
    }
    if (dbl) {
        // fma64Fast's operand guards (exponents of a, b in [33, 2013], of c
        // in [1, 2023], product exponent in [-900, 1000]) exclude NaN,
        // infinite, zero and subnormal operands, so when they hold, fpu's
        // fma goes straight to fma64Fast; test them first (the common case)
        // and take the special cases below only when they fail.
        e.get(ea);
        e.k64(33);
        e.op(W.i64_sub);
        e.k64(1981);
        e.op(W.i64_lt_u);
        e.get(eb);
        e.k64(33);
        e.op(W.i64_sub);
        e.k64(1981);
        e.op(W.i64_lt_u);
        e.op(W.i32_and);
        e.get(ec);
        e.k64(1);
        e.op(W.i64_sub);
        e.k64(2023);
        e.op(W.i64_lt_u);
        e.op(W.i32_and);
        e.get(ea);
        e.get(eb);
        e.op(W.i64_add);
        e.k64(1146);
        e.op(W.i64_sub);
        e.k64(1901);
        e.op(W.i64_lt_u);
        e.op(W.i32_and);
        e.op(W.i32_eqz);
        e.open(W.@"if", W.void_t);
    }
    // NaN or infinite operand
    for ([_]u32{ ea, eb, ec }, 0..) |l, i| {
        e.get(l);
        e.k64(emax);
        e.op(W.i64_eq);
        if (i > 0) e.op(W.i32_or);
    }
    H.handBackIf(e);
    // a or b zero (all finite): c, or for c = 0 the RNE sign rule
    const zshift: u64 = if (dbl) 1 else 33;
    for ([_]u32{ pa, pb }, 0..) |l, i| {
        e.get(l);
        e.k64(zshift);
        e.op(W.i64_shl);
        e.op(W.i64_eqz);
        if (i > 0) e.op(W.i32_or);
    }
    e.open(W.@"if", W.void_t);
    e.k32(0);
    H.status(e);
    e.get(pc_);
    e.k64(zshift);
    e.op(W.i64_shl);
    e.op(W.i64_eqz);
    e.open(W.@"if", W.i64_t);
    e.get(pc_);
    e.k64(0);
    e.get(pc_);
    e.get(pa);
    e.op(W.i64_xor);
    e.get(pb);
    e.op(W.i64_xor);
    e.k64(if (dbl) 63 else 31);
    e.op(W.i64_shr_u);
    e.op(W.i64_eqz);
    e.op(W.select);
    e.op(W.@"else");
    e.get(pc_);
    e.close();
    H.ret(e);
    e.close();
    if (dbl) {
        // c = 0, a and b finite non-zero: fmaSlow returns mulCore(a, b),
        // which is fpu's mul (fast path) for RNE.
        e.get(pc_);
        e.k64(1);
        e.op(W.i64_shl);
        e.op(W.i64_eqz);
        e.open(W.@"if", W.void_t);
        e.getD(pa);
        e.getD(pb);
        e.op(W.f64_mul);
        e.op(W.i64_reinterpret);
        e.set(t);
        outOfRange(e, t, true);
        H.handBackIf(e);
        oddSig(e, pa, true, t2);
        e.set(t2);
        oddSig(e, pb, true, t3);
        e.set(t3);
        e.k64(128);
        e.get(t2);
        e.op(W.i64_clz);
        e.op(W.i64_sub);
        e.get(t3);
        e.op(W.i64_clz);
        e.op(W.i64_sub);
        e.tee(t4);
        e.k64(53);
        e.op(W.i64_le_u);
        e.get(t4);
        e.k64(54);
        e.op(W.i64_eq);
        e.get(t2);
        e.get(t3);
        e.op(W.i64_mul);
        e.k64(1 << 53);
        e.op(W.i64_lt_u);
        e.op(W.i32_and);
        e.op(W.i32_or);
        e.op(W.i32_eqz);
        H.status(e);
        e.get(t);
        H.ret(e);
        e.close();
        // anything else outside the guards: the integer path
        H.handBack(e);
        e.close();
        H.val(e, pa);
        e.set(fx);
        H.val(e, pb);
        e.set(fy);
        H.val(e, pc_);
        e.set(fz);
        // Dekker TwoProduct (Veltkamp split with 2^27 + 1)
        e.get(fx);
        e.get(fy);
        e.op(W.f64_mul);
        e.set(fp);
        for ([_][3]u32{ .{ fx, xh, xl }, .{ fy, yh, yl } }) |s| {
            e.kf(134217729.0);
            e.get(s[0]);
            e.op(W.f64_mul);
            e.tee(tmp);
            H.sub(e, tmp, s[0]);
            e.op(W.f64_sub);
            e.set(s[1]); // h = t - (t - v)
            H.sub(e, s[0], s[1]);
            e.set(s[2]); // l = v - h
        }
        // pl = ((xh*yh - p) + xh*yl + xl*yh) + xl*yl
        e.get(xh);
        e.get(yh);
        e.op(W.f64_mul);
        e.get(fp);
        e.op(W.f64_sub);
        e.get(xh);
        e.get(yl);
        e.op(W.f64_mul);
        e.op(W.f64_add);
        e.get(xl);
        e.get(yh);
        e.op(W.f64_mul);
        e.op(W.f64_add);
        e.get(xl);
        e.get(yl);
        e.op(W.f64_mul);
        e.op(W.f64_add);
        e.set(pl);
        // TwoSum(z, p): sh + sl
        e.get(fz);
        e.get(fp);
        e.op(W.f64_add);
        e.set(sh);
        twoSumErr(e, sh, fz, fp, tmp, tmp2);
        e.set(sl);
        // Exact product (pl = ±0): the steps below reduce to u = sl (or ±0
        // when sl is), ue = 0, r = RN(sh + u) = sh and re = u, so the result
        // is sh and it is inexact iff sl != 0. Taking that shortcut keeps
        // the addend's dependency chain at one add.
        e.get(pl);
        e.kf(0);
        e.op(W.f64_eq);
        e.open(W.@"if", W.void_t);
        e.get(sh);
        e.op(W.i64_reinterpret);
        e.set(t);
        outOfRange(e, t, true);
        H.handBackIf(e);
        e.get(sl);
        e.kf(0);
        e.op(W.f64_ne);
        H.status(e);
        e.get(t);
        H.ret(e);
        e.close();
        // u = sl + pl, ue = its TwoSum error
        e.get(sl);
        e.get(pl);
        e.op(W.f64_add);
        e.set(fu);
        twoSumErr(e, fu, sl, pl, tmp, tmp2);
        e.set(ue);
        // round u to odd: ue != 0 (u must be normal), even u moves one ulp
        // towards the exact sum
        e.get(ue);
        e.kf(0);
        e.op(W.f64_ne);
        e.open(W.@"if", W.void_t);
        e.get(fu);
        e.op(W.i64_reinterpret);
        e.set(t);
        e.get(t);
        e.k64(52);
        e.op(W.i64_shr_u);
        e.k64(0x7ff);
        e.op(W.i64_and);
        e.tee(t2);
        e.op(W.i64_eqz);
        e.get(t2);
        e.k64(0x7ff);
        e.op(W.i64_eq);
        e.op(W.i32_or);
        H.handBackIf(e);
        roundOdd(e, t, ue, fu);
        e.close();
        // r = sh + u
        e.get(sh);
        e.get(fu);
        e.op(W.f64_add);
        e.tee(fr);
        e.op(W.i64_reinterpret);
        e.set(t);
        outOfRange(e, t, true);
        H.handBackIf(e);
        twoSumErr(e, fr, sh, fu, tmp, tmp2);
        e.kf(0);
        e.op(W.f64_ne);
        e.get(ue);
        e.kf(0);
        e.op(W.f64_ne);
        e.op(W.i32_or);
        H.status(e);
        e.get(t);
    } else {
        // fma32Fast: the f64 product is exact; the f64 sum is rounded to
        // odd, so rounding it to f32 is correct.
        H.val(e, pa);
        H.val(e, pb);
        e.op(W.f64_mul);
        e.set(fp);
        H.val(e, pc_);
        e.set(fy);
        e.get(fp);
        e.get(fy);
        e.op(W.f64_add);
        e.set(fr);
        twoSumErr(e, fr, fp, fy, tmp, tmp2);
        e.set(ue); // err
        e.get(ue);
        e.kf(0);
        e.op(W.f64_ne);
        e.open(W.@"if", W.void_t);
        e.get(fr);
        e.op(W.i64_reinterpret);
        e.set(t);
        roundOdd(e, t, ue, fr);
        e.close();
        e.get(fr);
        e.ops(&.{ W.f32_demote, W.i32_reinterpret, W.i64_ext_u });
        e.set(t);
        outOfRange(e, t, false);
        H.handBackIf(e);
        e.get(ue);
        e.kf(0);
        e.op(W.f64_ne);
        e.getS(t);
        e.get(fr);
        e.op(W.f64_ne);
        e.op(W.i32_or);
        H.status(e);
        e.get(t);
    }
    if (!inl) {
        e.op(W.end);
        e.patch(body);
    }
}

/// Push the TwoSum error of s = a + b (s already computed):
/// (a - (s - (s - a))) + (b - (s - a)).
fn twoSumErr(e: *Emit, s: u32, a: u32, b: u32, tmp: u32, tmp2: u32) void {
    e.get(s);
    e.get(a);
    e.op(W.f64_sub);
    e.set(tmp); // bv
    e.get(s);
    e.get(tmp);
    e.op(W.f64_sub);
    e.set(tmp2); // av
    e.get(a);
    e.get(tmp2);
    e.op(W.f64_sub);
    e.get(b);
    e.get(tmp);
    e.op(W.f64_sub);
    e.op(W.f64_add);
}

/// If the bits t of v are even, move v one ulp towards the exact value
/// (away from zero iff (err > 0) == (v > 0)), as fpu.zig's round-to-odd.
fn roundOdd(e: *Emit, t: u32, err: u32, v: u32) void {
    e.get(t);
    e.k64(1);
    e.op(W.i64_and);
    e.op(W.i64_eqz);
    e.open(W.@"if", W.void_t);
    e.get(t);
    e.k64(1);
    e.op(W.i64_add);
    e.get(t);
    e.k64(1);
    e.op(W.i64_sub);
    e.get(err);
    e.kf(0);
    e.op(W.f64_gt);
    e.get(v);
    e.kf(0);
    e.op(W.f64_gt);
    e.op(W.i32_eq);
    e.op(W.select);
    e.op(W.f64_reinterpret);
    e.set(v);
    e.close();
}

/// FP instructions that reach the JIT as `generic` ops (see fpGeneric).
fn fGeneric(e: *Emit, raw: u32, k: usize, pc: u64) void {
    const g = fpGeneric(raw).?;
    const rd = (raw >> 7) & 31;
    const rs1 = (raw >> 15) & 31;
    const rs2 = (raw >> 20) & 31;
    const f3 = (raw >> 12) & 7;
    const dbl = switch (g) {
        .fsqrt_d, .fcvt_d_s, .fcvt_f_x_d, .fcvt_x_f_d, .fclass_d => true,
        else => false,
    };
    const sg: u64 = if (dbl) sign_d else sign_s;
    const inf: u64 = if (dbl) inf_d else inf_s;
    frmCheck(e, f3 == 7 and g != .fclass_s and g != .fclass_d, k, pc);
    switch (g) {
        .fsqrt_s, .fsqrt_d => {
            // NaN or negative non-zero: NaN result (interpreter)
            const a = fsrc(e, rs1, dbl, l_t5);
            e.get(a);
            e.k64(inf);
            e.op(W.i64_gt_u);
            e.get(a);
            e.k64(sg);
            e.op(W.i64_ne);
            e.op(W.i32_and);
            handBackIf(e, k, pc);
            // rb = host sqrt (correctly rounded; ±0 and +inf give themselves)
            if (dbl) {
                e.getD(a);
                e.ops(&.{ W.f64_sqrt, W.i64_reinterpret });
            } else {
                e.get(a);
                e.ops(&.{ W.i32_wrap, W.f32_reinterpret, W.f32_sqrt, W.i32_reinterpret, W.i64_ext_u });
            }
            e.set(l_t5 + 1);
            // inexact unless a is ±0/+inf or odd(rb)^2 == odd(a) with
            // bitLen(odd(rb)) <= (mb + 2) / 2
            nxClear(e);
            oddSig(e, l_t5 + 1, dbl, l_t5 + 2);
            e.set(l_t5 + 2);
            e.k64(64);
            e.get(l_t5 + 2);
            e.op(W.i64_clz);
            e.op(W.i64_sub);
            e.k64(if (dbl) 27 else 12);
            e.op(W.i64_le_u);
            e.get(l_t5 + 2);
            e.get(l_t5 + 2);
            e.op(W.i64_mul);
            oddSig(e, a, dbl, l_t5 + 3);
            e.op(W.i64_eq);
            e.op(W.i32_and);
            e.get(a);
            e.k64(if (dbl) 1 else 33);
            e.op(W.i64_shl);
            e.op(W.i64_eqz);
            e.op(W.i32_or);
            e.get(a);
            e.k64(inf);
            e.op(W.i64_eq);
            e.op(W.i32_or);
            e.op(W.i32_eqz);
            orFlag(e, 0);
            e.close();
            e.get(l_t5 + 1);
            fdst(e, rd, dbl);
        },
        .fcvt_d_s => {
            // f32 -> f64 is exact; a NaN source is handed back
            const a = fsrc(e, rs1, false, l_t5);
            isNan(e, a, false);
            handBackIf(e, k, pc);
            e.getS(a);
            e.op(W.i64_reinterpret);
            e.set(lf(rd));
        },
        .fcvt_s_d => {
            const a = lf(rs1);
            const m = l_t5;
            const r = l_t5 + 1;
            e.get(a);
            e.k64(~sign_d);
            e.op(W.i64_and);
            e.tee(m);
            e.k64(inf_d);
            e.op(W.i64_gt_u);
            handBackIf(e, k, pc);
            e.getD(a);
            e.ops(&.{ W.f32_demote, W.i32_reinterpret, W.i64_ext_u });
            e.set(r);
            // ±0 and ±inf convert exactly; finite values only to a result
            // in the fast-path range (roundPack is IEEE RNE there)
            outOfRange(e, r, false);
            e.get(m);
            e.op(W.i64_eqz);
            e.op(W.i32_eqz);
            e.op(W.i32_and);
            e.get(m);
            e.k64(inf_d);
            e.op(W.i64_ne);
            e.op(W.i32_and);
            handBackIf(e, k, pc);
            e.getS(r);
            e.getD(a);
            e.op(W.f64_ne);
            orFlag(e, 0);
            e.get(r);
            fdst(e, rd, false);
        },
        .fcvt_f_x_s, .fcvt_f_x_d => {
            // integer -> FP: wasm converts with RNE; no overflow or
            // underflow is possible, inexact iff the magnitude spans more
            // than the significand's bits
            const mag = l_t5;
            reg(e, @intCast(rs1));
            switch (rs2) {
                0 => e.ops(&.{ W.i32_wrap, W.i64_ext_s }),
                1 => {
                    e.k64(0xffff_ffff);
                    e.op(W.i64_and);
                },
                else => {},
            }
            e.set(mag);
            e.get(mag);
            if (rs2 == 0 or rs2 == 1) {
                e.op(W.i32_wrap);
                e.op(if (rs2 == 0)
                    (if (dbl) W.f64_convert_i32_s else W.f32_convert_i32_s)
                else
                    (if (dbl) W.f64_convert_i32_u else W.f32_convert_i32_u));
            } else e.op(if (rs2 == 2)
                (if (dbl) W.f64_convert_i64_s else W.f32_convert_i64_s)
            else
                (if (dbl) W.f64_convert_i64_u else W.f32_convert_i64_u));
            if (dbl) e.op(W.i64_reinterpret) else e.ops(&.{ W.i32_reinterpret, W.i64_ext_u });
            fdst(e, rd, dbl);
            if (!(dbl and rs2 <= 1)) {
                if (rs2 == 0 or rs2 == 2) { // |v|
                    e.k64(0);
                    e.get(mag);
                    e.op(W.i64_sub);
                    e.get(mag);
                    e.get(mag);
                    e.k64(0);
                    e.op(W.i64_lt_s);
                    e.op(W.select);
                    e.set(mag);
                }
                e.k64(64);
                e.get(mag);
                e.op(W.i64_clz);
                e.op(W.i64_sub);
                e.get(mag);
                e.op(W.i64_ctz);
                e.op(W.i64_sub);
                e.k64(if (dbl) 53 else 24);
                e.op(W.i64_gt_s);
                orFlag(e, 0);
            }
        },
        .fcvt_x_f_s, .fcvt_x_f_d => {
            // FP -> integer: round with the instruction's mode, then
            // convert only when the rounded value is in range (anything
            // else, NaN and infinities included, is the NV case)
            const x = l_d0;
            const r = l_d0 + 1;
            if (dbl) e.getD(lf(rs1)) else e.getS(fsrc(e, rs1, false, l_t5));
            e.tee(x);
            e.op(switch (if (f3 == 7) 0 else f3) {
                0 => W.f64_nearest,
                1 => W.f64_trunc,
                2 => W.f64_floor,
                else => W.f64_ceil,
            });
            e.set(r);
            const lo: f64, const hi: f64, const hi_incl = switch (rs2) {
                0 => .{ -2147483648.0, 2147483647.0, true },
                1 => .{ 0.0, 4294967295.0, true },
                2 => .{ -9223372036854775808.0, 9223372036854775808.0, false },
                else => .{ 0.0, 18446744073709551616.0, false },
            };
            e.get(r);
            e.kf(lo);
            e.op(W.f64_ge);
            e.get(r);
            e.kf(hi);
            e.op(if (hi_incl) W.f64_le else W.f64_lt);
            e.op(W.i32_and);
            e.op(W.i32_eqz);
            handBackIf(e, k, pc);
            e.get(r);
            e.op(if (rs2 == 3) W.i64_trunc_f64_u else W.i64_trunc_f64_s);
            if (rs2 <= 1) e.ops(&.{ W.i32_wrap, W.i64_ext_s });
            setReg(e, @intCast(rd));
            e.get(r);
            e.get(x);
            e.op(W.f64_ne);
            orFlag(e, 0);
        },
        .fclass_s, .fclass_d => {
            const a = fsrc(e, rs1, dbl, l_t5);
            const m = l_t5 + 1;
            const s = l_t5 + 2;
            e.get(a);
            e.k64(if (dbl) 63 else 31);
            e.op(W.i64_shr_u);
            e.set(s);
            e.get(a);
            e.k64(sg - 1);
            e.op(W.i64_and);
            e.set(m);
            const r = l_t5 + 3;
            const C = struct {
                /// push (sign ? neg : pos)
                fn pick(em: *Emit, sl: u32, neg: u64, pos: u64) void {
                    em.k64(neg);
                    em.k64(pos);
                    em.get(sl);
                    em.op(W.i32_wrap);
                    em.op(W.select);
                }
                /// r = cond ? (the value pushed before) : r; cond: m <cmp> v
                fn over(em: *Emit, rl: u32, ml: u32, cmp: u8, v: u64) void {
                    em.get(rl);
                    em.get(ml);
                    em.k64(v);
                    em.op(cmp);
                    em.op(W.select);
                    em.set(rl);
                }
            };
            // normal, then overridden by subnormal, zero, infinity, NaN
            C.pick(e, s, 1 << 1, 1 << 6);
            e.set(r);
            C.pick(e, s, 1 << 2, 1 << 5);
            C.over(e, r, m, W.i64_lt_u, if (dbl) 1 << 52 else 1 << 23);
            C.pick(e, s, 1 << 3, 1 << 4);
            C.over(e, r, m, W.i64_eq, 0);
            C.pick(e, s, 1 << 0, 1 << 7);
            C.over(e, r, m, W.i64_eq, inf);
            e.k64(1 << 8);
            e.k64(1 << 9);
            e.get(m);
            e.k64(if (dbl) qnan_d else qnan_s);
            e.op(W.i64_lt_u);
            e.op(W.select);
            C.over(e, r, m, W.i64_gt_u, inf);
            e.get(r);
            setReg(e, @intCast(rd));
        },
    }
}
