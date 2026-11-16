/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * Contract between the wasm Linux kernel (arch side) and the guest CPU
 * emulator ("kwemu", Zig, src/emu). The emulator is a freestanding library
 * with no allocator and no global mutable state: everything lives in the
 * kernel-owned struct kw_cpu, and guest registers in a kernel-owned
 * struct kw_regs (normally inside the task's pt_regs).
 *
 * Guest ISA: riscv64 (rv64gc), user mode only, plus the optional
 * extensions below (KW_ISA_*) that kwemu implements and the kernel enables.
 *
 * Memory model: kernel and emulator share one wasm64 linear memory. A
 * "physical address" is a linear-memory address minus cpu->phys_base.
 * The emulator walks the kernel's user page tables itself, like hardware:
 * the kernel writes PTEs and calls the flush hooks below.
 *
 * Page-table format (RISC-V Sv39 layout, 4 KiB pages, 3 levels, 512
 * entries per level, 8-byte little-endian PTEs):
 *   bit 0 V, 1 R, 2 W, 3 X, 4 U, 5 G, 6 A, 7 D, bits 8-9 software,
 *   bits 10..53 PPN (physical address >> 12).
 * A valid PTE with R=W=X=0 points to the next level. Leaves are only
 * honoured at the last level (no huge pages). User access needs U=1.
 * The emulator never writes PTEs: an access with A=0, or a store with
 * D=0, raises KW_EV_FAULT so the kernel can set the bits.
 *
 * Decoded-code cache (ABI 2): the emulator keeps predecoded basic blocks
 * in struct kw_cpu, keyed by virtual pc and physical address and checked
 * against the raw instruction bits. Coherence rules:
 *  - guest stores (any mapping, incl. AMOs) are tracked exactly: code
 *    rewritten by the guest is seen by the next instruction;
 *  - code rewritten by the kernel (page reuse, COW copy, file data,
 *    ptrace) is seen after kw_flush_tlb_range() of a page that maps it,
 *    kw_flush_tlb_all(), kw_set_pgd(), or a guest FENCE.I -- i.e. the
 *    flushes the kernel already does when it changes a mapping or flushes
 *    the icache. (Rewriting a currently mapped exec page in place with no
 *    flush at all may keep running the old code until one of those, as an
 *    incoherent icache would.)
 *
 * Several CPUs (ABI 7): an SMP kernel gives each CPU its own struct
 * kw_cpu, used only by that CPU's thread, on one shared memory. kwemu
 * built with wasm atomics (zig build -Dkwemu-atomics) makes guest AMOs
 * atomic read-modify-writes, SC a compare-and-swap against the value LR
 * read, and FENCE a full barrier; without atomics they assume one hart.
 * Guest stores are tracked only by the struct kw_cpu that runs them: code
 * another CPU rewrites is seen after a flush on this one (riscv's
 * flush_icache syscall, FENCE.I alone is local), as on hardware.
 */
#ifndef KW_EMU_H
#define KW_EMU_H

#ifdef __KERNEL__
#include <linux/types.h>
#else
#include <stdint.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define KW_ABI_VERSION 7

struct kw_regs {
	uint64_t x[32];   /* x[0] is ignored and reads as zero */
	uint64_t pc;
	uint64_t f[32];   /* raw 64-bit FP registers (NaN-boxed singles) */
	uint32_t fcsr;
	uint32_t _pad;
};

enum kw_event_kind {
	KW_EV_BUDGET = 0,      /* instruction budget used up (timer tick point) */
	KW_EV_SYSCALL = 1,     /* ecall; pc already advanced past it */
	KW_EV_FAULT = 2,       /* page fault; pc at the faulting instruction */
	KW_EV_ILLEGAL = 3,     /* illegal instruction; pc at it */
	KW_EV_BREAKPOINT = 4,  /* ebreak; pc at it */
	KW_EV_MISALIGNED = 5,  /* misaligned fetch/atomic; pc at it */
	KW_EV_INTERRUPT = 6,   /* *cpu->irq_pending became non-zero */
};

enum kw_access {
	KW_ACCESS_READ = 0,
	KW_ACCESS_WRITE = 1,
	KW_ACCESS_EXEC = 2,
};

struct kw_event {
	uint32_t kind;    /* enum kw_event_kind */
	uint32_t access;  /* enum kw_access, for KW_EV_FAULT */
	uint64_t addr;    /* faulting guest virtual address (FAULT: any byte of
			     the faulting page; MISALIGNED: the address;
			     ILLEGAL/BREAKPOINT: the pc) */
	uint64_t insn;    /* raw instruction, for KW_EV_ILLEGAL (16 bits if
			     compressed) */
};

/*
 * Bytes the kernel must reserve for a struct kw_cpu (8-byte aligned).
 * ABI 5: 8 MiB (a 3x larger op arena); ABI 2 to 4: 4 MiB (TLBs +
 * decoded-block cache); ABI 1 was 64 KiB.
 */
#define KW_CPU_SIZE (8 * 1024 * 1024)

/*
 * Only the leading fields are public. The rest of the KW_CPU_SIZE bytes
 * (TLBs, decoded-block cache, LR/SC reservation) belong to the emulator.
 */
struct kw_cpu {
	uint64_t phys_base;            /* linear address of physical address 0 */
	uint64_t pgd;                  /* physical address of the root table */
	const volatile uint32_t *irq_pending; /* polled at block boundaries; may be NULL */
	uint64_t budget;               /* instructions kw_run may execute */
	uint64_t icount;               /* total instructions executed (stats) */
	struct kw_event ev;            /* details of the last event */
};

/* Zero and initialise the whole KW_CPU_SIZE block. */
void kw_cpu_init(struct kw_cpu *cpu);

/*
 * Run guest code from regs until an event. Returns enum kw_event_kind and
 * fills cpu->ev. Never blocks, never re-enters the kernel.
 * cpu->budget is decremented per retired instruction (ecall retires;
 * faulting/illegal instructions do not) and cpu->icount advanced by the
 * same amount; KW_EV_BUDGET when it reaches exactly 0 (returns at once if
 * 0 on entry). *irq_pending is checked on entry and at the end of every
 * decoded block, i.e. at least every 64 instructions (ABI 1: after every
 * taken branch/jump). The cycle/time/instret CSRs read cpu->icount.
 * Every event leaves regs (incl. pc) exactly at an instruction boundary.
 */
uint32_t kw_run(struct kw_cpu *cpu, struct kw_regs *regs);

/* Switch address space: sets cpu->pgd, drops the TLB and LR/SC reservation. */
void kw_set_pgd(struct kw_cpu *cpu, uint64_t pgd);

void kw_flush_tlb_all(struct kw_cpu *cpu);
void kw_flush_tlb_range(struct kw_cpu *cpu, uint64_t start, uint64_t end);

/* Drop the LR/SC reservation (call on every context switch / trap return). */
void kw_clear_reservation(struct kw_cpu *cpu);

uint32_t kw_abi_version(void);

/*
 * Optional ISA extensions (ABI 3; ABI 4 added bits 10..18). RV64GC is
 * always there; these are the extensions beyond it that a kwemu build may
 * implement, one bit each. Bits 19..63 are reserved for more. An
 * instruction of an extension that is not implemented, or not enabled,
 * raises KW_EV_ILLEGAL like any other unknown encoding. (Hints such as
 * PAUSE, the NTL hints and the Zicbop prefetches are plain RV64GC
 * encodings that run as no-ops: always there, no bit.)
 */
#define KW_ISA_ZBA	(1ULL << 0)	/* address generation */
#define KW_ISA_ZBB	(1ULL << 1)	/* basic bit manipulation */
#define KW_ISA_ZBC	(1ULL << 2)	/* carry-less multiplication */
#define KW_ISA_ZBS	(1ULL << 3)	/* single-bit instructions */
#define KW_ISA_ZBKB	(1ULL << 4)	/* bit manipulation for cryptography */
#define KW_ISA_ZBKC	(1ULL << 5)	/* carry-less multiplication for cryptography */
#define KW_ISA_ZBKX	(1ULL << 6)	/* crossbar permutations */
#define KW_ISA_ZKND	(1ULL << 7)	/* AES decryption (aes64ds, aes64dsm, aes64im, aes64ks1i, aes64ks2) */
#define KW_ISA_ZKNE	(1ULL << 8)	/* AES encryption (aes64es, aes64esm, aes64ks1i, aes64ks2) */
#define KW_ISA_ZICOND	(1ULL << 9)	/* czero.eqz, czero.nez */
#define KW_ISA_ZCB	(1ULL << 10)	/* c.lbu, c.lhu, c.lh, c.sb, c.sh, c.mul, c.zext.*, c.sext.*, c.not */
#define KW_ISA_ZIMOP	(1ULL << 11)	/* mop.r.N, mop.rr.N (rd = 0) */
#define KW_ISA_ZCMOP	(1ULL << 12)	/* c.mop.N (no effect) */
#define KW_ISA_ZICBOM	(1ULL << 13)	/* cbo.clean, cbo.flush (64-byte blocks; cbo.inval stays illegal) */
#define KW_ISA_ZICBOZ	(1ULL << 14)	/* cbo.zero (64-byte blocks) */
#define KW_ISA_ZAWRS	(1ULL << 15)	/* wrs.nto, wrs.sto (no-ops) */
#define KW_ISA_ZFA	(1ULL << 16)	/* fli, fminm/fmaxm, fround(nx), fcvtmod.w.d, fleq/fltq (S and D) */
#define KW_ISA_ZFHMIN	(1ULL << 17)	/* flh, fsh, fmv.x.h, fmv.h.x, fcvt between H and S/D */
#define KW_ISA_ZIHPM	(1ULL << 18)	/* hpmcounter3..31 (read as 0) */

/* The KW_ISA_* extensions this kwemu build implements. */
uint64_t kw_isa_supported(void);

/*
 * Enable the extensions in `isa` that are implemented (isa &
 * kw_isa_supported()) and disable all others; returns the enabled set.
 * kw_cpu_init enables every implemented extension. This drops all decoded
 * (and compiled) code, so call it once at boot, after kw_cpu_init and
 * before the first kw_run; it is correct, only slow, at any other time
 * between kw_run calls. The kernel advertises exactly the returned set to
 * user space.
 */
uint64_t kw_set_isa(struct kw_cpu *cpu, uint64_t isa);

/*
 * The host changed under a live struct kw_cpu: the kernel's memory was
 * restored into a new module instance (a snapshot). Forget every compiled
 * slot without calling kw_host_jit_free (the instance that held them is
 * gone, and its table slots hold their stubs again), ask kw_host_jit_caps
 * again (the new host may have no JIT) and drop all decoded code. Call it
 * before the first kw_run on the new instance.
 */
void kw_host_reset(struct kw_cpu *cpu);

/*
 * Optional JIT tier (emulator built with -Dkwemu-jit; wasm64 only; not part
 * of the ABI version). Without it the object has no such imports. With it,
 * the object imports these from wasm module "unkernel", and hot decoded
 * blocks are compiled to wasm and entered through call_indirect. kwemu owns
 * a fixed pool of stub functions in the module's function table; their
 * table indices are the "slots" below, and the table never grows. See
 * src/emu/jit.zig and docs/kwemu.md.
 *
 *   uint32_t kw_host_jit_caps(void);
 *     bit 0: JIT available (0: kwemu never compiles);
 *     bit 1: memory is 32-bit (module lowered with --memory64-lowering:
 *            generated code imports a 32-bit memory);
 *     bit 2: eager, compile blocks on first entry (tests).
 *     Called from kw_cpu_init and kw_host_reset.
 *   int32_t kw_host_jit_compile(const uint8_t *module, size_t len, uint32_t slot);
 *     Synchronously compile the module (it imports "env" "memory", i.e.
 *     this memory, and exports function "f", type (i64 i64 i64 i64) -> i64)
 *     and install "f" into table slot `slot`. 0 = installed; < 0 = failed,
 *     slot untouched.
 *   void kw_host_jit_free(uint32_t slot);
 *     Restore the function the slot held before its first compile and drop
 *     the module.
 * kw_cpu_init forgets installed slots without freeing them; a compile into
 * a slot that is still installed must replace its function. Only one
 * struct kw_cpu per module instance may use the JIT (the slots are
 * per-table).
 */

#ifdef __cplusplus
}
#endif

#endif /* KW_EMU_H */
