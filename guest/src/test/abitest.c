// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Freestanding arm64 ABI test (no libc: no locks, no exclusives, no TLS),
 * the first program to run on a new kernel or kwemu before a libc does, and
 * the only one that sees the registers as exec left them (a libc's startup
 * changes them).
 *
 * Checks: the register state at exec (x0..x30, V0..V31, FPCR, FPSR, NZCV
 * and TPIDR_EL0 all 0, for this process and for one that execs itself with
 * all of them set), uname, the auxv (HWCAP, HWCAP2/3, no vDSO,
 * MINSIGSTKSZ, platform), personality(PER_LINUX32) and an unaligned mmap
 * offset (EINVAL), the signal frame (fpsimd record, V8, FPCR, x8, pstate,
 * sp alignment, the {x29, x30} frame record), sigreturn (x19, V9 and FPCR
 * from the frame), the return to sa_restorer and, without SA_RESTORER, to
 * [sigpage] (its two instructions), a read() interrupted without
 * SA_RESTART (EINTR) and restarted with it, fork by clone(SIGCHLD) with the
 * child's x0 = 0 and wait4's status, and clone(CLONE_SETTLS) setting the
 * thread's TPIDR_EL0 with CLONE_CHILD_CLEARTID.
 *
 * Build and run (kernel.md, Kernel tests):
 *   zig cc -target aarch64-linux-none -nostdlib -ffreestanding -static -O2 \
 *     -fno-stack-protector -o abitest guest/src/test/abitest.c
 *   (as usr/bin/abitest in an initramfs, guest/tools/mkcpio.py)
 *   node js/cli.ts --kernel vendor/build/kernel/vmlinux32.wasm --initrd <cpio> \
 *     --append "console=hvc0 rdinit=/usr/bin/abitest"
 * It prints "abitest: 0 failure(s)" and powers off (exit 0), or halts
 * (exit 1). It checks this kernel's ABI, not qemu-user's (which has a
 * vDSO, another signal frame and NZCV.Z set at entry).
 */
typedef unsigned long u64;
typedef unsigned int u32;

static long sys6(long n, long a, long b, long c, long d, long e, long f)
{
	register long x8 __asm__("x8") = n;
	register long x0 __asm__("x0") = a;
	register long x1 __asm__("x1") = b;
	register long x2 __asm__("x2") = c;
	register long x3 __asm__("x3") = d;
	register long x4 __asm__("x4") = e;
	register long x5 __asm__("x5") = f;

	__asm__ volatile("svc #0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5) : "memory");
	return x0;
}
#define sys(n, ...) sys6_(n, __VA_ARGS__, 0, 0, 0, 0, 0, 0)
#define sys6_(n, a, b, c, d, e, f, ...) sys6(n, (long)(a), (long)(b), (long)(c), (long)(d), (long)(e), (long)(f))

enum { NR_write = 64, NR_exit_group = 94, NR_kill = 129, NR_rt_sigaction = 134, NR_rt_sigreturn = 139,
       NR_getpid = 172, NR_clone = 220, NR_execve = 221, NR_wait4 = 260, NR_mmap = 222, NR_munmap = 215,
       NR_reboot = 142, NR_uname = 160, NR_pipe2 = 59, NR_read = 63, NR_setitimer = 103, NR_exit = 93,
       NR_futex = 98, NR_personality = 92, NR_nanosleep = 101 };

void *memset(void *d, int c, unsigned long n) { char *p = d; while (n--) *p++ = c; return d; }
void *memcpy(void *d, const void *s, unsigned long n) { char *p = d; const char *q = s; while (n--) *p++ = *q++; return d; }
static unsigned long slen(const char *s) { unsigned long n = 0; while (s[n]) n++; return n; }
static int seq(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return *a == *b; }
static void puts_(const char *s) { sys(NR_write, 1, s, slen(s)); }
static void hex(u64 v)
{
	char b[19] = "0x";

	for (int i = 0; i < 16; i++)
		b[2 + i] = "0123456789abcdef"[(v >> (60 - 4 * i)) & 15];
	b[18] = 0;
	puts_(b);
}
static int failures;
static void check(int ok, const char *what) { puts_(ok ? "ok   " : "FAIL "); puts_(what); puts_("\n"); failures += !ok; }

struct ksa { void *handler; u64 flags; void *restorer; u64 mask; };
#define SA_SIGINFO 4UL
#define SA_RESTART 0x10000000UL
#define SA_RESTORER 0x04000000UL
#define SIGUSR2 12
#define SIGALRM 14
#define SIGCHLD 17

/*
 * The registers as _start found them: x0..x30, V0..V31, FPCR, FPSR, NZCV,
 * TPIDR_EL0 (_start's layout, 800 bytes on the initial stack).
 */
struct entry_regs {
	u64 x[31], pad;
	__uint128_t v[32];
	u64 fpcr, fpsr, nzcv, tpidr;
};
_Static_assert(sizeof(struct entry_regs) == 800, "entry_regs layout");

/* Which entry registers are not 0, as a list on stdout; 0 if none. */
static int entry_dirty(const struct entry_regs *r)
{
	int bad = 0;

	for (int i = 0; i < 31; i++)
		if (r->x[i]) {
			puts_("     x");
			hex(i);
			puts_(" = ");
			hex(r->x[i]);
			puts_("\n");
			bad++;
		}
	for (int i = 0; i < 32; i++)
		if (r->v[i]) {
			puts_("     v");
			hex(i);
			puts_(" != 0\n");
			bad++;
		}
	if (r->fpcr || r->fpsr || r->nzcv || r->tpidr) {
		puts_("     fpcr ");
		hex(r->fpcr);
		puts_(" fpsr ");
		hex(r->fpsr);
		puts_(" nzcv ");
		hex(r->nzcv);
		puts_(" tpidr ");
		hex(r->tpidr);
		puts_("\n");
		bad++;
	}
	return bad;
}

static volatile int ran;
static volatile u64 lr_seen, x29_seen, sp_seen, frame_ok;
static u64 *auxv;

static u64 getauxval(u64 t)
{
	for (u64 *a = auxv; a[0]; a += 2)
		if (a[0] == t)
			return a[1];
	return 0;
}

__attribute__((naked)) static void my_restorer(void)
{
	__asm__ volatile("mov x8, #139\n\tsvc #0");
}

struct fpsimd { u32 magic, size, fpsr, fpcr; __uint128_t v[32]; };
struct mctx { u64 fault_address, regs[31], sp, pc, pstate; __attribute__((aligned(16))) unsigned char res[4096]; };
struct uctx { u64 flags; void *link; struct { void *sp; int flags; u64 size; } stack; u64 sigmask; unsigned char pad[120]; struct mctx mc; };

static void handler(int sig, void *si, void *ucv)
{
	struct uctx *uc = ucv;
	struct fpsimd *fp = (struct fpsimd *)uc->mc.res;
	u32 *end = (u32 *)(fp + 1);

	(void)si;
	ran++;
	lr_seen = (u64)__builtin_return_address(0);
	__asm__ volatile("mov %0, x29" : "=r"(x29_seen));
	sp_seen = (u64)uc;
	frame_ok = sig == SIGUSR2 && fp->magic == 0x46508001 && fp->size == 528 && end[0] == 0 && end[1] == 0 &&
		   (u64)fp->v[8] == 0x1122334455667788UL && ((fp->fpcr >> 22) & 3) == 1 && uc->mc.regs[8] == NR_kill &&
		   (uc->mc.pstate & ~0xf0000000UL) == 0 && ((u64)uc->mc.sp & 15) == 0;
	fp->v[9] = 0xa5a5a5a5deadbeefUL;
	fp->fpcr = (fp->fpcr & ~(3U << 22)) | (3U << 22);
	uc->mc.regs[19] = 0x1919;	/* sigreturn restores x19 from the frame */
}

static volatile int alarms;
static void on_alarm(int sig) { (void)sig; alarms++; }

static volatile u64 child_tp;
static int child_fn(void)
{
	u64 tp;

	__asm__ volatile("mrs %0, tpidr_el0" : "=r"(tp));
	child_tp = tp;
	return 0;
}

static long clone_thread(u64 flags, void *stack, int *ptid, u64 tls, int *ctid)
{
	register long x8 __asm__("x8") = NR_clone;
	register long x0 __asm__("x0") = flags;
	register long x1 __asm__("x1") = (long)stack;
	register long x2 __asm__("x2") = (long)ptid;
	register long x3 __asm__("x3") = tls;
	register long x4 __asm__("x4") = (long)ctid;

	__asm__ volatile("svc #0\n\t"
			 "cbnz x0, 1f\n\t"
			 "bl child_fn_tramp\n\t"
			 "mov x8, #93\n\t"
			 "svc #0\n"
			 "1:"
			 : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3), "r"(x4) : "x30", "memory");
	return x0;
}
__attribute__((used)) void child_fn_tramp(void) { child_fn(); }

/* Set every register exec must clear, then execve(path, {path, "exec"}). */
__attribute__((noreturn)) static void exec_dirty(const char *path, char **envp)
{
	const char *av[3] = { path, "exec", 0 };
	register long x0 __asm__("x0") = (long)path;
	register long x1 __asm__("x1") = (long)av;
	register long x2 __asm__("x2") = (long)envp;
	register long x8 __asm__("x8") = NR_execve;

	__asm__ volatile(
		"mov x9, #0x1234\n\tmsr tpidr_el0, x9\n\t"
		"mov x9, #(7 << 23)\n\tmsr fpcr, x9\n\tmov x9, #0x9f\n\tmsr fpsr, x9\n\t"
		"mov x9, #0xf0000000\n\tmsr nzcv, x9\n\t"
		"movi v0.2d, #0xffffffffffffffff\n\tmovi v1.2d, #0xffffffffffffffff\n\tmovi v2.2d, #0xffffffffffffffff\n\tmovi v3.2d, #0xffffffffffffffff\n\t"
		"movi v4.2d, #0xffffffffffffffff\n\tmovi v5.2d, #0xffffffffffffffff\n\tmovi v6.2d, #0xffffffffffffffff\n\tmovi v7.2d, #0xffffffffffffffff\n\t"
		"movi v8.2d, #0xffffffffffffffff\n\tmovi v9.2d, #0xffffffffffffffff\n\tmovi v10.2d, #0xffffffffffffffff\n\tmovi v11.2d, #0xffffffffffffffff\n\t"
		"movi v12.2d, #0xffffffffffffffff\n\tmovi v13.2d, #0xffffffffffffffff\n\tmovi v14.2d, #0xffffffffffffffff\n\tmovi v15.2d, #0xffffffffffffffff\n\t"
		"movi v16.2d, #0xffffffffffffffff\n\tmovi v17.2d, #0xffffffffffffffff\n\tmovi v18.2d, #0xffffffffffffffff\n\tmovi v19.2d, #0xffffffffffffffff\n\t"
		"movi v20.2d, #0xffffffffffffffff\n\tmovi v21.2d, #0xffffffffffffffff\n\tmovi v22.2d, #0xffffffffffffffff\n\tmovi v23.2d, #0xffffffffffffffff\n\t"
		"movi v24.2d, #0xffffffffffffffff\n\tmovi v25.2d, #0xffffffffffffffff\n\tmovi v26.2d, #0xffffffffffffffff\n\tmovi v27.2d, #0xffffffffffffffff\n\t"
		"movi v28.2d, #0xffffffffffffffff\n\tmovi v29.2d, #0xffffffffffffffff\n\tmovi v30.2d, #0xffffffffffffffff\n\tmovi v31.2d, #0xffffffffffffffff\n\t"
		"mov x3, #-1\n\tmov x4, #-1\n\tmov x5, #-1\n\tmov x6, #-1\n\tmov x7, #-1\n\t"
		"mov x9, #-1\n\tmov x10, #-1\n\tmov x11, #-1\n\tmov x12, #-1\n\tmov x13, #-1\n\t"
		"mov x14, #-1\n\tmov x15, #-1\n\tmov x16, #-1\n\tmov x17, #-1\n\tmov x18, #-1\n\t"
		"mov x19, #-1\n\tmov x20, #-1\n\tmov x21, #-1\n\tmov x22, #-1\n\tmov x23, #-1\n\t"
		"mov x24, #-1\n\tmov x25, #-1\n\tmov x26, #-1\n\tmov x27, #-1\n\tmov x28, #-1\n\t"
		"mov x30, #-1\n\tsvc #0\n\t"
		"mov x0, #99\n\tmov x8, %4\n\tsvc #0"
		: "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x8) : "i"(NR_exit_group)
		: "x3", "x4", "x5", "x6", "x7", "x9", "x10", "x11", "x12", "x13",
		  "x14", "x15", "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23", "x24", "x25", "x26",
		  "x27", "x28", "x30", "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11",
		  "v12", "v13", "v14", "v15", "v16", "v17", "v18", "v19", "v20", "v21", "v22", "v23", "v24",
		  "v25", "v26", "v27", "v28", "v29", "v30", "v31", "cc", "memory");
	__builtin_unreachable();
}

static void tests(const struct entry_regs *entry, const char *self, char **envp)
{
	char uts[6 * 65];

	check(!entry_dirty(entry), "exec: this process started with x0..x30, V0..V31, FPCR, FPSR, NZCV, TPIDR_EL0 all 0");
	long pid = sys(NR_clone, SIGCHLD, 0, 0, 0, 0);
	if (pid == 0)
		exec_dirty(self, envp);
	int st = -1;
	long w = sys(NR_wait4, pid, &st, 0, 0);
	check(w == pid && (st & 0x7f) == 0 && ((st >> 8) & 0xff) == 0,
	      "exec: a process with all of them set execs one with all of them 0");

	sys(NR_uname, uts);
	check(seq(uts + 4 * 65, "aarch64"), "uname -m aarch64");
	check((getauxval(16) & 3) == 3, "AT_HWCAP has FP and ASIMD");
	hex(getauxval(16));
	puts_(" AT_HWCAP\n");
	check(getauxval(26) == 0 && getauxval(29) == 0 && getauxval(33) == 0 && getauxval(51) == 4720 &&
	      seq((char *)getauxval(15), "aarch64"), "auxv: HWCAP2/3 0, no vDSO, MINSIGSTKSZ 4720, platform aarch64");
	check(sys(NR_personality, 8 /* PER_LINUX32 */) == -22 && sys(NR_personality, 0xffffffff) == 0,
	      "personality(PER_LINUX32) = -EINVAL");
	check(sys(NR_mmap, 0, 4096, 3, 0x22, -1, 1) == -22, "mmap with an unaligned offset: -EINVAL");

	/* signal frame + sigreturn, with our own SA_RESTORER */
	struct ksa sa = { handler, SA_SIGINFO | SA_RESTORER, my_restorer, 0 };
	sys(NR_rt_sigaction, SIGUSR2, &sa, 0, 8);
	u64 d8, d9, fpcr, x19, pc_svc;
	ran = 0;
	__asm__ volatile(
		"mrs x9, fpcr\n\tbic x9, x9, #(3 << 22)\n\torr x9, x9, #(1 << 22)\n\tmsr fpcr, x9\n\t"
		"movz x9, #0x7788\n\tmovk x9, #0x5566, lsl #16\n\tmovk x9, #0x3344, lsl #32\n\tmovk x9, #0x1122, lsl #48\n\t"
		"fmov d8, x9\n\tmov x9, #1\n\tfmov d9, x9\n\tmov x19, #7\n\t"
		"mov x0, %5\n\tmov x1, #12\n\tmov x8, #129\n\tadr %4, 1f\n\tsvc #0\n"
		"1:\tfmov %0, d8\n\tfmov %1, d9\n\tmrs %2, fpcr\n\tmov %3, x19\n\tbic x9, %2, #(3 << 22)\n\tmsr fpcr, x9"
		: "=&r"(d8), "=&r"(d9), "=&r"(fpcr), "=&r"(x19), "=&r"(pc_svc)
		: "r"(sys(NR_getpid, 0))
		: "x0", "x1", "x8", "x9", "x19", "v8", "v9", "memory");
	check(ran == 1 && frame_ok, "signal frame: fpsimd record, V8, FPCR, x8, pstate, sp alignment");
	check(lr_seen == (u64)my_restorer, "SA_RESTORER: handler returns to sa_restorer");
	check(d8 == 0x1122334455667788UL && d9 == 0xa5a5a5a5deadbeefUL && ((fpcr >> 22) & 3) == 3 && x19 == 0x1919,
	      "sigreturn: x19, V9 and FPCR from the frame, V8 kept");
	check(x29_seen > sp_seen, "x29 points to the frame record above the frame");

	/* without SA_RESTORER: [sigpage] */
	sa.flags = SA_SIGINFO;
	sa.restorer = 0;
	sys(NR_rt_sigaction, SIGUSR2, &sa, 0, 8);
	ran = 0;
	lr_seen = 0;
	sys(NR_kill, sys(NR_getpid, 0), SIGUSR2);
	check(ran == 1 && lr_seen && lr_seen != (u64)my_restorer && (lr_seen & 0xfff) == 0 &&
	      ((u32 *)lr_seen)[0] == 0xd2801168 && ((u32 *)lr_seen)[1] == 0xd4000001,
	      "no SA_RESTORER: handler returns to [sigpage] (mov x8, #139; svc #0)");

	/* syscall restart: read() on an empty pipe, SIGALRM with and without SA_RESTART */
	int pfd[2];
	sys(NR_pipe2, pfd, 0);
	struct ksa al = { on_alarm, SA_RESTORER, my_restorer, 0 };
	sys(NR_rt_sigaction, SIGALRM, &al, 0, 8);
	long it[4] = { 0, 0, 0, 20000 };
	sys(NR_setitimer, 0, it, 0);
	char c;
	long r = sys(NR_read, pfd[0], &c, 1);
	check(r == -4 && alarms == 1, "read() interrupted without SA_RESTART: -EINTR");
	al.flags |= SA_RESTART;
	sys(NR_rt_sigaction, SIGALRM, &al, 0, 8);
	/* a child writes after the parent's read has been restarted */
	pid = sys(NR_clone, SIGCHLD, 0, 0, 0, 0);
	if (pid == 0) {
		/*
		 * Write after the parent's 20 ms alarm: a 100 ms sleep, so on the
		 * same clock and not on how fast this process runs (a busy loop
		 * ran out before the alarm once the JIT compiled it).
		 */
		long ts[2] = { 0, 100000000 };
		sys(NR_nanosleep, ts, 0);
		sys(NR_write, pfd[1], "x", 1);
		sys(NR_exit_group, 5);
	}
	sys(NR_setitimer, 0, it, 0);
	r = sys(NR_read, pfd[0], &c, 1);
	st = 0;
	w = sys(NR_wait4, pid, &st, 0, 0);
	check(r == 1 && c == 'x' && alarms == 2, "read() restarted with SA_RESTART after SIGALRM");
	check(w == pid && ((st >> 8) & 0xff) == 5 && (st & 0x7f) == 0, "fork (clone SIGCHLD): child x0 = 0, wait4 status 5");

	/* clone a thread with CLONE_SETTLS: the child's TPIDR_EL0 */
	static char stack[16384] __attribute__((aligned(16)));
	static volatile int ctid = 1;
	/* CLONE_VM | FS | FILES | SIGHAND | THREAD | SETTLS | CHILD_CLEARTID */
	u64 flags = 0x100 | 0x200 | 0x400 | 0x800 | 0x10000 | 0x80000 | 0x200000;
	long tid = clone_thread(flags, stack + sizeof(stack), 0, 0x5eed0000UL, (int *)&ctid);
	while (ctid)
		sys(NR_futex, &ctid, 0 /* WAIT */, 1, 0, 0, 0);
	check(tid > 0 && child_tp == 0x5eed0000UL, "clone(CLONE_SETTLS): TPIDR_EL0 in the thread, CLONE_CHILD_CLEARTID");
	u64 tp;
	__asm__ volatile("mrs %0, tpidr_el0" : "=r"(tp));
	check(tp == 0, "the parent's TPIDR_EL0 unchanged by the thread's");
}

__attribute__((used)) void cstart(const struct entry_regs *entry, u64 *sp)
{
	u64 argc = sp[0];
	char **argv = (char **)(sp + 1), **envp = argv + argc + 1, **e = envp;

	while (*e)
		e++;
	auxv = (u64 *)(e + 1);
	/* exec'd by exec_dirty(): the exit status says whether it started clean */
	if (argc > 1 && seq(argv[1], "exec"))
		sys(NR_exit_group, entry_dirty(entry) ? 1 : 0);
	puts_("abitest: arm64 ABI on unkernel\n");
	tests(entry, argv[0], envp);
	puts_(failures ? "abitest: FAILED\n" : "abitest: 0 failure(s)\n");
	if (sys(NR_getpid, 0) == 1)
		sys(NR_reboot, 0xfee1dead, 672274793, failures ? 0xcdef0123 : 0x4321fedc, 0);
	sys(NR_exit_group, failures != 0);
}

/* Save the registers as exec left them (struct entry_regs) below the initial sp. */
__attribute__((naked)) void _start(void)
{
	__asm__ volatile(
		"sub sp, sp, #800\n\t"
		"stp x0, x1, [sp]\n\tstp x2, x3, [sp, #16]\n\tstp x4, x5, [sp, #32]\n\tstp x6, x7, [sp, #48]\n\t"
		"stp x8, x9, [sp, #64]\n\tstp x10, x11, [sp, #80]\n\tstp x12, x13, [sp, #96]\n\t"
		"stp x14, x15, [sp, #112]\n\tstp x16, x17, [sp, #128]\n\tstp x18, x19, [sp, #144]\n\t"
		"stp x20, x21, [sp, #160]\n\tstp x22, x23, [sp, #176]\n\tstp x24, x25, [sp, #192]\n\t"
		"stp x26, x27, [sp, #208]\n\tstp x28, x29, [sp, #224]\n\tstp x30, xzr, [sp, #240]\n\t"
		"mrs x1, nzcv\n\tstr x1, [sp, #784]\n\t"
		"add x0, sp, #256\n\t"
		"stp q0, q1, [x0]\n\tstp q2, q3, [x0, #32]\n\tstp q4, q5, [x0, #64]\n\tstp q6, q7, [x0, #96]\n\t"
		"stp q8, q9, [x0, #128]\n\tstp q10, q11, [x0, #160]\n\tstp q12, q13, [x0, #192]\n\t"
		"stp q14, q15, [x0, #224]\n\tstp q16, q17, [x0, #256]\n\tstp q18, q19, [x0, #288]\n\t"
		"stp q20, q21, [x0, #320]\n\tstp q22, q23, [x0, #352]\n\tstp q24, q25, [x0, #384]\n\t"
		"stp q26, q27, [x0, #416]\n\tstp q28, q29, [x0, #448]\n\tstp q30, q31, [x0, #480]\n\t"
		"mrs x1, fpcr\n\tstr x1, [sp, #768]\n\tmrs x1, fpsr\n\tstr x1, [sp, #776]\n\t"
		"mrs x1, tpidr_el0\n\tstr x1, [sp, #792]\n\t"
		"mov x0, sp\n\tadd x1, sp, #800\n\tmov x29, #0\n\tmov x30, #0\n\tbl cstart\n\tbrk #0");
}
