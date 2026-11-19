// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! Semantics of the decoded-op tier's ops (ops.zig) and their dispatch: one
//! central `while (true) switch` over the op kinds (kwemu.md, Interpreter:
//! threaded dispatch and tail calls lost under V8).
//!
//! Register slots are u64 indexes from `x` = &regs.x (ops.zig). While ops
//! run, slot 32 (regs.pc) holds 0 and serves as XZR: `run` stores 0 there
//! before it runs a block, a `generic` op puts the real pc there for the
//! reference interpreter and 0 back after it, and every way out of
//! `runOps` (a branch, a side exit, a fault, a trap) leaves pc set or has
//! `run` set it. NZCV stays architectural in regs.nzcv: flag-setting ops
//! write all four bits, condition tests read them through a 16-bit mask
//! (`ops.condMask`).

const std = @import("std");
const c = @import("common.zig");
const ops = @import("ops.zig");
const decode = @import("decode.zig");
const tier = @import("tier.zig");
const kwemu = @import("../emu/kwemu.zig");
const Op = ops.Op;
const H = ops.H;
const Cpu = kwemu.Cpu;
const Regs = c.Regs;

/// How an op left the block.
pub const Next = enum(u8) {
    /// Continue with the next op.
    cont,
    /// The block's terminator ran; pc is set.
    done,
    /// This op faulted (no effect; earlier ops retired).
    fault,
    /// This (generic) op trapped (Hart.trap says why); pc is on it.
    trap,
    /// This op retired and the block must stop after it (a store hit
    /// decoded code, IC IVAU).
    stop,
    /// This (generic) op is MRS CNTVCT_EL0; `run` supplies the count
    /// (branch.finishCounter) and resumes after it.
    counter,
    /// This side exit was taken; pc is set.
    side,
};

/// How `runOps` ended: the op that did not continue, and the budget left
/// after the self-loop passes it charged.
pub const Exit = struct { next: Next, op: [*]const Op, left: u64 };

const ones: u64 = std.math.maxInt(u64);

/// Field byte k of the op word (1 = a ... 7 = g).
inline fn fld(w: u64, comptime k: u6) u64 {
    return (w >> (8 * k)) & 0xff;
}
/// A shift count from field k.
inline fn sh(w: u64, comptime k: u6) u6 {
    return @truncate(w >> (8 * k));
}
/// The register slot named by field byte k.
inline fn slot(x: [*]u64, w: u64, comptime k: u6) *u64 {
    const off: usize = @intCast((w >> (8 * k - 3)) & (0xff << 3));
    return @ptrFromInt(@intFromPtr(x) + off);
}
inline fn nzcvPtr(x: [*]u64) *u32 {
    return @ptrCast(x + ops.nzcv_slot);
}
/// 0 -> 0, else all ones.
inline fn all(v: u64) u64 {
    return 0 -% v;
}
inline fn condTaken(x: [*]u64, mask: u64) bool {
    return (mask >> @intCast(nzcvPtr(x).* >> 28)) & 1 != 0;
}

/// Result and NZCV of a + b + cin (cin 0 or 1) on 64-bit operands; a 32-bit
/// operation passes its operands shifted left by 32, which gives the same
/// flags, and its result is r >> 32.
inline fn addFlags(a: u64, b: u64, cin: u64) struct { r: u64, f: u32 } {
    const s1 = a +% b;
    const r = s1 +% cin;
    const cy: u64 = @intFromBool(s1 < a) | @intFromBool(r < s1);
    const n = r >> 63;
    const z: u64 = @intFromBool(r == 0);
    const v = ((a ^ r) & (b ^ r)) >> 63;
    return .{ .r = r, .f = @truncate((n << 31) | (z << 30) | (cy << 29) | (v << 28)) };
}
/// NZ of a logical result shifted left by 0 or 32 (C = V = 0).
inline fn logicFlags(r: u64) u32 {
    return @truncate(((r >> 63) << 31) | (@as(u64, @intFromBool(r == 0)) << 30));
}
/// Operand 2: ((v << s1) >>a s2) & mask.
inline fn op2(v: u64, s1: u6, s2: u6, mask: u64) u64 {
    const t: i64 = @bitCast(v << s1);
    return @as(u64, @bitCast(t >> s2)) & mask;
}
/// Load result: sign extension by d (0 = none) and a 32-bit mask by g.
inline fn ext(v: u64, w: u64) u64 {
    const s = sh(w, 4);
    const t: i64 = @bitCast(v << s);
    return @as(u64, @bitCast(t >> s)) & (ones >> @intCast((w >> 51) & 32));
}

inline fn Width(comptime h: H) type {
    return switch (h) {
        .ldr8_i, .ldr8_w, .ldr8_r, .str8_i, .str8_w, .str8_r => u8,
        .ldr16_i, .ldr16_w, .ldr16_r, .str16_i, .str16_w, .str16_r => u16,
        .ldr32_i, .ldr32_w, .ldr32_r, .str32_i, .str32_w, .str32_r, .ldp32, .ldp32_w, .stp32, .stp32_w => u32,
        else => u64,
    };
}

// ---- memory accesses ------------------------------------------------------------
//
// No error unions cross a call here: on wasm, the result of a non-inlined
// function returning one goes through a shadow-stack slot, and the slots
// gave runOps a stack frame set up on every call. Loads return null on a
// fault (the slow path flags it in a64.fault); stores return st_ok,
// st_smc (done, and it hit decoded code: the block must stop) or st_fault
// (nothing written). Faults record their address as the reference does.

const st_ok: u32 = 0;
const st_smc: u32 = 1;
const st_fault: u32 = 2;

inline fn ld(comptime T: type, cpu: *Cpu, va: u64) ?T {
    if (cpu.readFast(va, @sizeOf(T))) |hst| return Cpu.hostRead(T, hst);
    const v = ldSlow(T, cpu, va);
    if (cpu.priv.a64.fault != 0) {
        cpu.priv.a64.fault = 0;
        return null;
    }
    return v;
}
noinline fn ldSlow(comptime T: type, cpu: *Cpu, va: u64) T {
    return cpu.load(T, va) catch {
        cpu.priv.a64.fault = 1;
        return 0;
    };
}
inline fn st(comptime T: type, cpu: *Cpu, va: u64, v: T) u32 {
    if (cpu.writeFast(va, @sizeOf(T))) |hst| {
        Cpu.hostWrite(T, hst, v);
        return st_ok;
    }
    return stSlow(T, cpu, va, v);
}
noinline fn stSlow(comptime T: type, cpu: *Cpu, va: u64, v: T) u32 {
    const smc = cpu.storeChk(T, va, v) catch return st_fault;
    return @intFromBool(smc);
}

/// Two T at va, va + size (a pair, or the halves of a Q register): one TLB
/// check when both lie in one page, else two accesses in the reference
/// order (the first fault wins).
const Two = struct { a: u64, b: u64 };
inline fn ld2(comptime T: type, cpu: *Cpu, va: u64) ?Two {
    if (cpu.readFast(va, 2 * @sizeOf(T))) |hst|
        return .{ .a = Cpu.hostRead(T, hst), .b = Cpu.hostRead(T, hst + @sizeOf(T)) };
    const a = ld(T, cpu, va) orelse return null;
    const b = ld(T, cpu, va +% @sizeOf(T)) orelse return null;
    return .{ .a = a, .b = b };
}
/// Store the low T of v[0..n] at va, va + size, ..., all or nothing.
inline fn stN(comptime T: type, comptime n: usize, cpu: *Cpu, va: u64, v0: u64, v1: u64, v2: u64, v3: u64) u32 {
    const v = [4]u64{ v0, v1, v2, v3 };
    if (cpu.writeFast(va, n * @sizeOf(T))) |hst| {
        inline for (0..n) |i| Cpu.hostWrite(T, hst + i * @sizeOf(T), @truncate(v[i]));
        return st_ok;
    }
    return stNSlow(T, n, cpu, va, v0, v1, v2, v3);
}
noinline fn stNSlow(comptime T: type, comptime n: usize, cpu: *Cpu, va: u64, v0: u64, v1: u64, v2: u64, v3: u64) u32 {
    // As the reference (c.probeWrite, then each store through the path
    // that tracks stores into decoded code).
    cpu.probe(va, .write) catch return st_fault;
    const last = va +% (n * @sizeOf(T) - 1);
    if (last >> 12 != va >> 12) cpu.probe(last, .write) catch return st_fault;
    const v = [4]u64{ v0, v1, v2, v3 };
    var smc = false;
    inline for (0..n) |i| smc = (cpu.storeChk(T, va +% i * @sizeOf(T), @truncate(v[i])) catch return st_fault) or smc;
    return @intFromBool(smc or cpu.priv.smc != 0);
}
/// The op's exit after a store.
inline fn stored(r: u32) Next {
    return switch (r) {
        st_ok => .cont,
        st_smc => .stop,
        else => .fault,
    };
}

noinline fn execGeneric(cpu: *Cpu, x: [*]u64, raw: u32, pc: u64) Next {
    kwemu.count(cpu, "generic_ops", 1);
    if (kwemu.stats_on) cpu.priv.stats.jit.hb_gen[tier.Ax.gen_class + tier.genClass(raw)] += 1;
    if (kwemu.stats_on) cpu.priv.stats.op_hist[tier.fp_base + tier.fpForm(raw)] += 1;
    if (kwemu.stats_on) kwemu.countGenWord(cpu, raw, false);
    const regs: *Regs = @ptrCast(@alignCast(x));
    regs.pc = pc;
    const s: c.St = .{ .r = regs, .h = &cpu.priv.hart, .m = cpu };
    const e = decode.exec(s, raw) catch return .fault;
    return switch (e) {
        .next => blk: {
            if (cpu.priv.smc != 0) break :blk .stop;
            x[ops.zr] = 0;
            break :blk .cont;
        },
        .jump => unreachable, // every A64 branch has its own op
        .trap => if (cpu.priv.hart.trap == .counter) .counter else .trap,
    };
}

/// A `generic` op called from compiled code (jit/emit.zig, `generic`;
/// through the kernel's function table, so it has the type of a compiled
/// function): x = &regs.x, with the registers written back; returns 0
/// (retired), 1 (not executed: a fault, a trap, MRS CNTVCT_EL0; the
/// interpreter runs it again) or 2 (retired, the block must end: a store
/// into decoded code, IC IVAU).
pub fn jitGeneric(x: u64, cpu: u64, raw: u64, pc: u64) callconv(.c) u64 {
    const cp: *Cpu = @ptrFromInt(@as(usize, @intCast(cpu)));
    if (kwemu.stats_on) kwemu.countGenWord(cp, @truncate(raw), true);
    return switch (execGeneric(cp, @ptrFromInt(@as(usize, @intCast(x))), @truncate(raw), pc)) {
        .cont => 0,
        .stop => blk: {
            cp.priv.smc = 0;
            break :blk 2;
        },
        else => 1,
    };
}

noinline fn ldrV(cpu: *Cpu, x: [*]u64, w: u64, imm: u64) Next {
    const b = slot(x, w, 2);
    const base = b.*;
    const va = switch (fld(w, 5)) {
        0 => base +% imm,
        1 => base +% (imm & all(fld(w, 6))),
        else => base +% op2(slot(x, w, 3).*, sh(w, 6), sh(w, 7), imm),
    };
    const v: u64 = switch (sh(w, 4)) {
        0 => cpu.load(u8, va) catch return .fault,
        1 => cpu.load(u16, va) catch return .fault,
        2 => cpu.load(u32, va) catch return .fault,
        else => cpu.load(u64, va) catch return .fault,
    };
    if (fld(w, 5) == 1) b.* = base +% imm;
    const d = slot(x, w, 1);
    d.* = v;
    @as([*]u64, @ptrCast(d))[1] = 0;
    return .cont;
}

/// RBIT, REV16, REV32, REV, CLZ, CLS (dp_reg's semantics).
noinline fn rev1(x: [*]u64, w: u64) void {
    const dp = @import("dp_reg.zig");
    const sf = fld(w, 5) == 0;
    const a = slot(x, w, 2).*;
    slot(x, w, 1).* = switch (fld(w, 4)) {
        0 => if (sf) @bitReverse(a) else @bitReverse(@as(u32, @truncate(a))),
        1 => dp.rev16(a) & (ones >> sh(w, 5)),
        2 => if (sf) dp.rev32(a) else @byteSwap(@as(u32, @truncate(a))),
        3 => @byteSwap(a),
        4 => if (sf) @clz(a) else @clz(@as(u32, @truncate(a))),
        else => dp.cls(sf, a),
    };
}

/// Execute op `o` (kind `h`, comptime; `w` its first 8 bytes). `end_pc`: the
/// block's fall-through.
pub inline fn doOp(comptime h: H, w: u64, o: [*]const Op, x: [*]u64, cpu: *Cpu, end_pc: u64) Next {
    const imm = o[0].imm;
    switch (h) {
        .nop => return .cont,
        .movi => {
            slot(x, w, 1).* = imm;
            return .cont;
        },
        .movk => {
            const d = slot(x, w, 1);
            d.* = (d.* & imm) | (((w >> 40) & 0xffff) << sh(w, 4));
            return .cont;
        },
        .mov => {
            slot(x, w, 1).* = slot(x, w, 2).* & imm;
            return .cont;
        },
        .add_i => {
            slot(x, w, 1).* = (slot(x, w, 2).* +% imm) & (ones >> sh(w, 4));
            return .cont;
        },
        .adds_i => {
            const cw = sh(w, 4);
            const r = addFlags(slot(x, w, 2).* << cw, imm, fld(w, 5));
            nzcvPtr(x).* = r.f;
            slot(x, w, 1).* = (r.r >> cw) & all(fld(w, 6));
            return .cont;
        },
        .logic_i => {
            const a = slot(x, w, 2).*;
            const e = fld(w, 5);
            slot(x, w, 1).* = (((a & imm) & all(e & 1)) | ((a ^ imm) & all(e >> 1))) & (ones >> sh(w, 4));
            return .cont;
        },
        .ands_i => {
            const r = slot(x, w, 2).* & imm;
            nzcvPtr(x).* = logicFlags(r << sh(w, 4));
            slot(x, w, 1).* = r & all(fld(w, 6));
            return .cont;
        },
        .addsub_r => {
            const g = fld(w, 7);
            const b = op2(slot(x, w, 3).*, sh(w, 4), sh(w, 5), imm) ^ all(g & 1);
            slot(x, w, 1).* = (slot(x, w, 2).* +% b +% (g & 1)) & (ones >> @intCast((g & 8) << 2));
            return .cont;
        },
        .addsubs_r => {
            const g = fld(w, 7);
            const cw: u6 = @intCast((g & 8) << 2);
            const b = (op2(slot(x, w, 3).*, sh(w, 4), sh(w, 5), imm) << cw) ^ all(g & 1);
            const r = addFlags(slot(x, w, 2).* << cw, b, g & 1);
            nzcvPtr(x).* = r.f;
            slot(x, w, 1).* = (r.r >> cw) & all((g >> 1) & 1);
            return .cont;
        },
        .add_rr => {
            const g = fld(w, 7);
            const b = slot(x, w, 3).* ^ all(g & 1);
            slot(x, w, 1).* = (slot(x, w, 2).* +% b +% (g & 1)) & (ones >> @intCast((g & 8) << 2));
            return .cont;
        },
        .adds_rr => {
            const g = fld(w, 7);
            const cw: u6 = @intCast((g & 8) << 2);
            const r = addFlags(slot(x, w, 2).* << cw, (slot(x, w, 3).* << cw) ^ all(g & 1), g & 1);
            nzcvPtr(x).* = r.f;
            slot(x, w, 1).* = (r.r >> cw) & all((g >> 1) & 1);
            return .cont;
        },
        .logic_r => {
            const g = fld(w, 7);
            const a = slot(x, w, 2).*;
            const b = op2(slot(x, w, 3).*, sh(w, 4), sh(w, 5), imm) ^ all((g >> 2) & 1);
            slot(x, w, 1).* = (((a & b) & all(g & 1)) | ((a ^ b) & all((g >> 1) & 1))) & (ones >> @intCast((g & 8) << 2));
            return .cont;
        },
        .logic_ror => {
            const g = fld(w, 7);
            const cw: u6 = @intCast((g & 8) << 2);
            const m = ones >> cw;
            const v = slot(x, w, 3).*;
            const b = std.math.rotr(u64, (v & m) | ((v << cw) & ~m), sh(w, 4)) ^ all((g >> 2) & 1);
            const a = slot(x, w, 2).*;
            slot(x, w, 1).* = (((a & b) & all(g & 1)) | ((a ^ b) & all((g >> 1) & 1))) & m;
            return .cont;
        },
        .ands_r => {
            const g = fld(w, 7);
            const cw: u6 = @intCast((g & 8) << 2);
            const b = op2(slot(x, w, 3).*, sh(w, 4), sh(w, 5), imm) ^ all((g >> 2) & 1);
            const r = (slot(x, w, 2).* & b) << cw;
            nzcvPtr(x).* = logicFlags(r);
            slot(x, w, 1).* = (r >> cw) & all((g >> 1) & 1);
            return .cont;
        },
        .ubfm => {
            slot(x, w, 1).* = ((slot(x, w, 2).* << sh(w, 4)) >> sh(w, 5)) << sh(w, 6);
            return .cont;
        },
        .sbfm => {
            const t: i64 = @bitCast(slot(x, w, 2).* << sh(w, 4));
            slot(x, w, 1).* = (@as(u64, @bitCast(t >> sh(w, 5))) << sh(w, 6)) & (ones >> sh(w, 7));
            return .cont;
        },
        .bfm => {
            const d = slot(x, w, 1);
            const v = ((slot(x, w, 2).* << sh(w, 4)) >> sh(w, 5)) << sh(w, 6);
            d.* = ((d.* & ~imm) | v) & (ones >> sh(w, 7));
            return .cont;
        },
        .extr => {
            const lsb = sh(w, 4);
            const cw = sh(w, 5);
            const m = ones >> cw;
            const hi = slot(x, w, 2).*;
            const lo = (slot(x, w, 3).* & m) | ((hi << cw) & ~m);
            slot(x, w, 1).* = ((lo >> lsb) | (hi << @intCast(64 - @as(u7, lsb)))) & m;
            return .cont;
        },
        .lslv, .lsrv, .asrv, .rorv => {
            const cw = sh(w, 4);
            const m = ones >> cw;
            const a = slot(x, w, 2).*;
            const s: u6 = @truncate(slot(x, w, 3).* & (@as(u64, 63) >> @intCast(cw >> 5)));
            slot(x, w, 1).* = switch (h) {
                .lslv => (a << s) & m,
                .lsrv => (a & m) >> s,
                .asrv => @as(u64, @bitCast(@as(i64, @bitCast(a << cw)) >> @intCast(@as(u7, s) + cw))) & m,
                .rorv => blk: {
                    const t = (a & m) | ((a << cw) & ~m);
                    break :blk std.math.rotr(u64, t, s) & m;
                },
                else => comptime unreachable,
            };
            return .cont;
        },
        .csel => {
            const r = if (condTaken(x, imm)) slot(x, w, 2).* else (slot(x, w, 3).* ^ all((imm >> 17) & 1)) +% ((imm >> 16) & 1);
            slot(x, w, 1).* = r & (ones >> @intCast(((imm >> 18) & 1) << 5));
            return .cont;
        },
        .ccmp => {
            const cw = sh(w, 4);
            const sub = (imm >> 20) & 1;
            const b = ((slot(x, w, 3).* +% (imm >> 24)) << cw) ^ all(sub);
            const f = addFlags(slot(x, w, 2).* << cw, b, sub).f;
            nzcvPtr(x).* = if (condTaken(x, imm)) f else @as(u32, @truncate((imm >> 16) & 15)) << 28;
            return .cont;
        },
        .madd => {
            const sub = fld(w, 5);
            const p = (slot(x, w, 2).* *% slot(x, w, 3).*) ^ all(sub);
            slot(x, w, 1).* = (slot(x, w, 4).* +% p +% sub) & (ones >> sh(w, 6));
            return .cont;
        },
        .maddl => {
            const sub = fld(w, 5);
            const em = ones >> @intCast((fld(w, 6) ^ 1) << 5);
            const n = @as(u64, @bitCast(@as(i64, @bitCast(slot(x, w, 2).* << 32)) >> 32)) & em;
            const m = @as(u64, @bitCast(@as(i64, @bitCast(slot(x, w, 3).* << 32)) >> 32)) & em;
            slot(x, w, 1).* = slot(x, w, 4).* +% ((n *% m) ^ all(sub)) +% sub;
            return .cont;
        },
        .umulh => {
            slot(x, w, 1).* = c.fpu.mul64(slot(x, w, 2).*, slot(x, w, 3).*).hi;
            return .cont;
        },
        .smulh => {
            slot(x, w, 1).* = c.fpu.mulh(slot(x, w, 2).*, slot(x, w, 3).*);
            return .cont;
        },
        .udiv => {
            const m = ones >> sh(w, 4);
            const b = slot(x, w, 3).* & m;
            slot(x, w, 1).* = if (b == 0) 0 else (slot(x, w, 2).* & m) / b;
            return .cont;
        },
        .sdiv => {
            // W operands are the low halves (dp_reg.sdiv tests the divisor
            // for 0 before it narrows it).
            const m = ones >> sh(w, 4);
            slot(x, w, 1).* = sdiv(sh(w, 4) == 0, slot(x, w, 2).* & m, slot(x, w, 3).* & m);
            return .cont;
        },
        .ldr8_i, .ldr16_i, .ldr32_i, .ldr64_i => {
            const v = ld(Width(h), cpu, slot(x, w, 2).* +% imm) orelse return .fault;
            slot(x, w, 1).* = if (h == .ldr64_i) v else ext(v, w);
            return .cont;
        },
        .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w => {
            const b = slot(x, w, 2);
            const base = b.*;
            const v = ld(Width(h), cpu, base +% (imm & all(fld(w, 6)))) orelse return .fault;
            b.* = base +% imm;
            slot(x, w, 1).* = if (h == .ldr64_w) v else ext(v, w);
            return .cont;
        },
        .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => {
            const va = slot(x, w, 2).* +% op2(slot(x, w, 3).*, sh(w, 5), sh(w, 6), imm);
            const v = ld(Width(h), cpu, va) orelse return .fault;
            slot(x, w, 1).* = if (h == .ldr64_r) v else ext(v, w);
            return .cont;
        },
        .str8_i, .str16_i, .str32_i, .str64_i => {
            return stored(st(Width(h), cpu, slot(x, w, 2).* +% imm, @truncate(slot(x, w, 1).*)));
        },
        .str8_w, .str16_w, .str32_w, .str64_w => {
            const b = slot(x, w, 2);
            const base = b.*;
            const r = st(Width(h), cpu, base +% (imm & all(fld(w, 6))), @truncate(slot(x, w, 1).*));
            if (r == st_fault) return .fault;
            b.* = base +% imm;
            return stored(r);
        },
        .str8_r, .str16_r, .str32_r, .str64_r => {
            const va = slot(x, w, 2).* +% op2(slot(x, w, 3).*, sh(w, 5), sh(w, 6), imm);
            return stored(st(Width(h), cpu, va, @truncate(slot(x, w, 1).*)));
        },
        .ldp32, .ldp64, .ldp32_w, .ldp64_w => {
            const T = Width(h);
            const wb = h == .ldp32_w or h == .ldp64_w;
            const b = slot(x, w, 2);
            const base = b.*;
            const va = if (wb) base +% (imm & all(fld(w, 5))) else base +% imm;
            const v = ld2(T, cpu, va) orelse return .fault;
            if (wb) b.* = base +% imm;
            if (T == u64) {
                slot(x, w, 1).* = v.a;
                slot(x, w, 3).* = v.b;
            } else {
                // LDPSW: d = 32
                const s = sh(w, 4);
                slot(x, w, 1).* = @bitCast(@as(i64, @bitCast(v.a << s)) >> s);
                slot(x, w, 3).* = @bitCast(@as(i64, @bitCast(v.b << s)) >> s);
            }
            return .cont;
        },
        .stp32, .stp64, .stp32_w, .stp64_w => {
            const T = Width(h);
            const wb = h == .stp32_w or h == .stp64_w;
            const b = slot(x, w, 2);
            const base = b.*;
            const va = if (wb) base +% (imm & all(fld(w, 5))) else base +% imm;
            const r = stN(T, 2, cpu, va, slot(x, w, 1).*, slot(x, w, 3).*, 0, 0);
            if (r == st_fault) return .fault;
            if (wb) b.* = base +% imm;
            return stored(r);
        },
        .ldr_v => return ldrV(cpu, x, w, imm),
        .rev1 => {
            rev1(x, w);
            return .cont;
        },
        .adc => {
            const g = fld(w, 7);
            const cw: u6 = @intCast((g & 8) << 2);
            const nz = nzcvPtr(x);
            const cin: u64 = (nz.* >> 29) & 1;
            // Carry in at bit cw: the W form's low halves must stay zero.
            const r = addFlags(slot(x, w, 2).* << cw, (slot(x, w, 3).* ^ all(g & 1)) << cw, cin << cw);
            if (g & 2 != 0) nz.* = r.f;
            slot(x, w, 1).* = (r.r >> cw) & all((g >> 2) & 1);
            return .cont;
        },
        .ldr_q_i, .ldr_q_w, .ldr_q_r => {
            const b = slot(x, w, 2);
            const base = b.*;
            const va = switch (h) {
                .ldr_q_i => base +% imm,
                .ldr_q_w => base +% (imm & all(fld(w, 6))),
                else => base +% op2(slot(x, w, 3).*, sh(w, 5), sh(w, 6), imm),
            };
            const v = ld2(u64, cpu, va) orelse return .fault;
            if (h == .ldr_q_w) b.* = base +% imm;
            const d: [*]u64 = @ptrCast(slot(x, w, 1));
            d[0] = v.a;
            d[1] = v.b;
            return .cont;
        },
        .str_q_i, .str_q_w, .str_q_r => {
            const b = slot(x, w, 2);
            const base = b.*;
            const va = switch (h) {
                .str_q_i => base +% imm,
                .str_q_w => base +% (imm & all(fld(w, 6))),
                else => base +% op2(slot(x, w, 3).*, sh(w, 5), sh(w, 6), imm),
            };
            const s: [*]u64 = @ptrCast(slot(x, w, 1));
            const r = stN(u64, 2, cpu, va, s[0], s[1], 0, 0);
            if (r == st_fault) return .fault;
            if (h == .str_q_w) b.* = base +% imm;
            return stored(r);
        },
        .ldp_q, .ldp_q_w => {
            const b = slot(x, w, 2);
            const base = b.*;
            const va = if (h == .ldp_q_w) base +% (imm & all(fld(w, 5))) else base +% imm;
            const lo = ld2(u64, cpu, va) orelse return .fault;
            const hi = ld2(u64, cpu, va +% 16) orelse return .fault;
            if (h == .ldp_q_w) b.* = base +% imm;
            const d1: [*]u64 = @ptrCast(slot(x, w, 1));
            d1[0] = lo.a;
            d1[1] = lo.b;
            const d2: [*]u64 = @ptrCast(slot(x, w, 3));
            d2[0] = hi.a;
            d2[1] = hi.b;
            return .cont;
        },
        .stp_q, .stp_q_w => {
            const b = slot(x, w, 2);
            const base = b.*;
            const va = if (h == .stp_q_w) base +% (imm & all(fld(w, 5))) else base +% imm;
            const s1: [*]u64 = @ptrCast(slot(x, w, 1));
            const s2: [*]u64 = @ptrCast(slot(x, w, 3));
            const r = stN(u64, 4, cpu, va, s1[0], s1[1], s2[0], s2[1]);
            if (r == st_fault) return .fault;
            if (h == .stp_q_w) b.* = base +% imm;
            return stored(r);
        },
        .bcond_x, .cbz_x, .tbz_x, .bcond, .cbz, .tbz => {
            const taken = switch (h) {
                .bcond, .bcond_x => condTaken(x, w >> 32),
                .cbz, .cbz_x => ((slot(x, w, 1).* & (ones >> sh(w, 5))) == 0) != (fld(w, 4) != 0),
                .tbz, .tbz_x => (slot(x, w, 1).* >> sh(w, 4)) & 1 == fld(w, 5),
                else => comptime unreachable,
            };
            switch (h) {
                .bcond, .cbz, .tbz => {
                    x[ops.zr] = if (taken) imm else end_pc;
                    return .done;
                },
                else => {
                    if (!taken) return .cont;
                    x[ops.zr] = imm;
                    return .side;
                },
            }
        },
        .b_f => return .cont,
        .bl_f => {
            x[30] = (imm & ~@as(u64, 0xfff)) +% ((w >> 32) & 0xffff);
            return .cont;
        },
        .b => {
            x[ops.zr] = imm;
            return .done;
        },
        .bl => {
            x[30] = end_pc;
            x[ops.zr] = imm;
            return .done;
        },
        .br => {
            x[ops.zr] = slot(x, w, 2).*;
            return .done;
        },
        .blr => {
            const t = slot(x, w, 2).*;
            x[30] = end_pc;
            x[ops.zr] = t;
            return .done;
        },
        .goto => {
            x[ops.zr] = imm;
            return .done;
        },
        .generic => return execGeneric(cpu, x, @truncate(w >> 32), imm),
    }
}

/// SDIV at 32 (sf = false) or 64 bits: towards zero, 0 for a zero divisor,
/// MIN / -1 = MIN (dp_reg.sdiv).
fn sdiv(sf: bool, a: u64, b: u64) u64 {
    return @import("dp_reg.zig").sdiv(sf, a, b);
}

/// The first 8 bytes of an op in one load.
inline fn word(o: [*]const Op) u64 {
    return @as(*const u64, @ptrCast(o)).*;
}

/// Run the ops from `o0` until one does not return .cont. A block of `n`
/// instructions that branches back to its own start (pc0) runs again
/// here, each pass charged to `left0` while it covers the pass, no
/// interrupt is pending and no other CPU invalidated code (the poll at
/// every block end); anything that could invalidate the block itself (a
/// store into decoded code, IC IVAU) ends it with .stop.
pub fn runOps(o0: [*]const Op, x: [*]u64, cpu: *Cpu, end_pc: u64, pc0: u64, n: u64, left0: u64) Exit {
    @setEvalBranchQuota(10000);
    var left = left0;
    var o = o0;
    var w = word(o);
    // One central dispatch (a plain loop around the switch); see kwemu.md.
    // What follows an op that does not continue is outside the switch, so
    // `inline else` does not copy it into every kind that can leave
    // (a64/performance.md, Rejected designs: the smaller function runs cold
    // code 4-8% faster).
    while (true) {
        const r: Next = switch (@as(H, @enumFromInt(@as(u8, @truncate(w))))) {
            inline else => |h| blk: {
                if (kwemu.stats_on) {
                    cpu.priv.stats.op_hist[@intFromEnum(h)] += 1;
                    const g = &cpu.priv.stats.jit.hb_gen;
                    if (h != .goto) g[@intCast(g[tier.Ax.cur])] += 1;
                }
                break :blk doOp(h, w, o, x, cpu, end_pc);
            },
        };
        if (r != .cont) {
            if (r == .done and x[ops.zr] == pc0 and left >= n and tier.quiet(cpu)) {
                left -= n;
                x[ops.zr] = 0;
                o = o0;
                w = word(o);
                continue;
            }
            return .{ .next = r, .op = o, .left = left };
        }
        o += 1;
        w = word(o);
    }
}

comptime {
    std.debug.assert(@import("builtin").cpu.arch.endian() == .little); // word() field layout
}
