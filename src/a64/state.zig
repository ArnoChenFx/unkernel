// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 architectural state: the register file (`struct kw_regs` of
//! include/kw_emu.h, checked in run.zig) and the A64 part of the private
//! area of struct kw_cpu (`Priv`, a field of kwemu.Priv).

const std = @import("std");

comptime {
    // Lane helpers bitcast u128 <-> [N]T: only right on a little-endian host
    // (x86-64, aarch64 and wasm all are).
    std.debug.assert(@import("builtin").cpu.arch.endian() == .little);
}

/// Guest registers; identical layout to `struct kw_regs`.
pub const Regs = extern struct {
    /// x0..x30. Register number 31 is SP or XZR, depending on the operand
    /// (common.zig: `xr`/`setX` for XZR forms, `xsp`/`setXsp` for SP forms).
    x: [31]u64 = @splat(0),
    sp: u64 = 0,
    pc: u64 = 0,
    /// N, Z, C, V in bits 31..28 (common.N/Z/C/V); the other bits stay 0.
    nzcv: u32 = 0,
    fpcr: u32 = 0,
    fpsr: u32 = 0,
    _pad: u32 = 0,
    tpidr_el0: u64 = 0,
    /// V0..V31. Never shift a u128 by a variable amount or multiply one:
    /// on wasm that becomes a compiler-rt call (__ashlti3, __multi3) that
    /// the kernel does not link. Use common.lanes/fromLanes instead.
    v: [32]u128 align(16) = @splat(0),
};

/// The A64 part of kwemu's private area in struct kw_cpu. Everything here
/// is emulator-private (not ABI); the exclusive monitor's address is
/// `core.Hart.resv` (cleared by kw_clear_reservation and kw_set_pgd), its
/// first value `Hart.resv_val`.
pub const Priv = extern struct {
    /// Enabled optional features (common.Feature bits, a subset of
    /// common.implemented); kw_set_isa.
    isa: u64 = 0,
    /// Bytes the open exclusive access covers (LDXR: 1..8, LDXP: 8 or 16);
    /// meaningful only while Hart.resv is set.
    excl_size: u32 = 0,
    /// Set by the tier's load slow path on a fault (opexec.zig, `ld`).
    fault: u32 = 0,
    /// Second value of an LDXP (the word at resv + excl_size / 2).
    excl_val2: u64 = 0,
    /// The cross-CPU code epoch this CPU has caught up with (tier.zig, code
    /// coherence).
    seen_epoch: u64 = 0,
    /// Address of the global code epoch for compiled code, which addresses
    /// memory only cpu-relative (jit/emit.zig `poll`). Set by kw_cpu_init
    /// and kw_host_reset (tier.epochInit).
    epoch_ptr: u64 = 0,
};
