// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, memory family (emit.zig; stream "memory"). Semantics:
//! opexec.zig (`ld`, `st`, `ld2`, `stN`). The rule riscv's JIT follows
//! holds here: compute the address, check the data TLB inline (tag == vpn
//! of the access's last byte, so a pair or a Q access checks its whole
//! range once), and on a miss hand the op back BEFORE it executes (no
//! register, no writeback, no store done): faults, page straddles and
//! stores into pages holding decoded code (code_flag) all go back to the
//! interpreter, which keeps them exact. Writeback (pre/post index) is
//! written after the access, then Rt, then Rt2, as the reference does.
//! Q registers are two i64 locals (MVP wasm, no SIMD128; a64.md, JIT plan).

const ops = @import("../ops.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;

pub const kinds = [_]ops.H{
    .ldr8_i,  .ldr16_i, .ldr32_i, .ldr64_i, .ldr8_w,  .ldr16_w, .ldr32_w, .ldr64_w, .ldr8_r,  .ldr16_r,
    .ldr32_r, .ldr64_r, .str8_i,  .str16_i, .str32_i, .str64_i, .str8_w,  .str16_w, .str32_w, .str64_w,
    .str8_r,  .str16_r, .str32_r, .str64_r, .ldp32,   .ldp64,   .ldp32_w, .ldp64_w, .stp32,   .stp64,
    .stp32_w, .stp64_w, .ldr_v,   .ldr_q_i, .ldr_q_w, .ldr_q_r, .str_q_i, .str_q_w, .str_q_r, .ldp_q,
    .ldp_q_w, .stp_q,   .stp_q_w,
};

pub fn supported(o: Op) bool {
    _ = o;
    return false;
}

/// Data slot of a store or load: an X/SP slot or a V slot.
fn data(slot: u8) Use {
    return .{ .read = cm.xbit(slot), .vread = cm.vbit(slot) };
}

pub fn usage(o: Op) Use {
    const base = cm.xbit(o.b);
    return switch (o.h) {
        .ldr8_i, .ldr16_i, .ldr32_i, .ldr64_i => .{ .read = base, .write = cm.xbit(o.a) },
        .ldr8_w, .ldr16_w, .ldr32_w, .ldr64_w => .{ .read = base, .write = base | cm.xbit(o.a) },
        .ldr8_r, .ldr16_r, .ldr32_r, .ldr64_r => .{ .read = base | cm.xbit(o.c), .write = cm.xbit(o.a) },
        .str8_i, .str16_i, .str32_i, .str64_i => blk: {
            var u = data(o.a);
            u.read |= base;
            break :blk u;
        },
        .str8_w, .str16_w, .str32_w, .str64_w => blk: {
            var u = data(o.a);
            u.read |= base;
            u.write = base;
            break :blk u;
        },
        .str8_r, .str16_r, .str32_r, .str64_r => blk: {
            var u = data(o.a);
            u.read |= base | cm.xbit(o.c);
            break :blk u;
        },
        .ldp32, .ldp64 => .{ .read = base, .write = cm.xbit(o.a) | cm.xbit(o.c) },
        .ldp32_w, .ldp64_w => .{ .read = base, .write = base | cm.xbit(o.a) | cm.xbit(o.c) },
        .stp32, .stp64, .stp32_w, .stp64_w => blk: {
            var u = data(o.a);
            u.add(data(o.c));
            u.read |= base;
            if (o.h == .stp32_w or o.h == .stp64_w) u.write = base;
            break :blk u;
        },
        .ldr_v, .ldr_q_i, .ldr_q_r => .{ .read = base | (if (o.h == .ldr_q_r or (o.h == .ldr_v and o.e == 2)) cm.xbit(o.c) else 0), .write = if (o.h == .ldr_v and o.e == 1) base else 0, .vwrite = cm.vbit(o.a) },
        .ldr_q_w => .{ .read = base, .write = base, .vwrite = cm.vbit(o.a) },
        .str_q_i, .str_q_r => .{ .read = base | (if (o.h == .str_q_r) cm.xbit(o.c) else 0), .vread = cm.vbit(o.a) },
        .str_q_w => .{ .read = base, .write = base, .vread = cm.vbit(o.a) },
        .ldp_q => .{ .read = base, .vwrite = cm.vbit(o.a) | cm.vbit(o.c) },
        .ldp_q_w => .{ .read = base, .write = base, .vwrite = cm.vbit(o.a) | cm.vbit(o.c) },
        .stp_q => .{ .read = base, .vread = cm.vbit(o.a) | cm.vbit(o.c) },
        .stp_q_w => .{ .read = base, .write = base, .vread = cm.vbit(o.a) | cm.vbit(o.c) },
        else => unreachable,
    };
}

pub fn emit(e: anytype, o: Op, k: usize, pc: u64) void {
    _ = .{ e, o, k, pc };
    unreachable; // not supported yet
}
