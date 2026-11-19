// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 integer self-test: runs each instruction form (inline asm) over a
 * fixed set of edge values and pseudo-random operands, folds the results
 * and the NZCV flags into one hash per form and prints it. Not
 * self-checking: test/a64-test.mjs requires the same output (and exit
 * status) as qemu-aarch64. A differing line names the form to look at.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef uint64_t u64;
typedef uint32_t u32;

static const u64 edge[] = {
    0, 1, 2, 3, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff,
    0x7fffffff, 0x80000000, 0xffffffff, 0x100000000, 0x7fffffffffffffff,
    0x8000000000000000, 0xffffffffffffffff, 0xfffffffffffffffe,
    0x123456789abcdef0, 0xfedcba9876543210, 0x00ff00ff00ff00ff,
    0x5555555555555555, 0xaaaaaaaaaaaaaaaa, 0x8000000080000000,
};
#define NEDGE (sizeof edge / sizeof edge[0])
#define NRAND 40

static u64 rng = 0x9e3779b97f4a7c15;
static u64 next(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}
static u64 vals[NEDGE + NRAND];
#define NV (sizeof vals / sizeof vals[0])

static u64 hash;
static void mix(u64 v) {
    hash ^= v;
    hash *= 0x100000001b3;
    hash ^= hash >> 29;
}
static void report(const char *name) {
    printf("%-10s %016llx\n", name, (unsigned long long)hash);
    hash = 0xcbf29ce484222325;
}

/* r = insn(a, b) and the flags it leaves, from the given input flags */
#define BIN(insn, a, b, fin) ({ u64 _r, _f; __asm__ volatile("msr nzcv, %3\n\t" insn "\n\tmrs %1, nzcv" \
    : "=&r"(_r), "=&r"(_f) : "r"(a), "r"((u64)(fin)), "r"(b) : "cc"); mix(_r); mix(_f); })
/* %0 = result, %2 = a, %4 = b */
#define T2(name, insn) do { for (unsigned i = 0; i < NV; i++) for (unsigned j = 0; j < NV; j += 3) \
    BIN(insn, vals[i], vals[j], (i * 7 + j) << 28); report(name); } while (0)
#define T1(name, insn) do { for (unsigned i = 0; i < NV; i++) BIN(insn, vals[i], vals[i] >> 3, (i * 5) << 28); report(name); } while (0)
#define T3(name, insn) do { for (unsigned i = 0; i < NV; i++) for (unsigned j = 0; j < NV; j += 5) { \
    u64 _r, _c = vals[(i + j) % NV]; __asm__ volatile(insn : "=&r"(_r) : "r"(vals[i]), "r"(vals[j]), "r"(_c)); mix(_r); } \
    report(name); } while (0)

#define CONDS(X) X(eq) X(ne) X(cs) X(cc) X(mi) X(pl) X(vs) X(vc) X(hi) X(ls) X(ge) X(lt) X(gt) X(le) X(al) X(nv)

static void arith(void) {
    T2("add", "add %0, %2, %4");
    T2("adds", "adds %0, %2, %4");
    T2("sub", "sub %0, %2, %4");
    T2("subs", "subs %0, %2, %4");
    T2("adds.w", "adds %w0, %w2, %w4");
    T2("subs.w", "subs %w0, %w2, %w4");
    T2("adc", "adc %0, %2, %4");
    T2("adcs", "adcs %0, %2, %4");
    T2("sbc", "sbc %0, %2, %4");
    T2("sbcs", "sbcs %0, %2, %4");
    T2("adcs.w", "adcs %w0, %w2, %w4");
    T2("sbcs.w", "sbcs %w0, %w2, %w4");
    T2("add.lsl", "add %0, %2, %4, lsl #13");
    T2("sub.asr", "sub %0, %2, %4, asr #63");
    T2("adds.lsr", "adds %0, %2, %4, lsr #1");
    T2("subs.w.as", "subs %w0, %w2, %w4, asr #7");
    T2("add.sxtb", "add %0, %2, %w4, sxtb #2");
    T2("sub.uxth", "sub %0, %2, %w4, uxth #4");
    T2("adds.sxtw", "adds %0, %2, %w4, sxtw");
    T2("subs.uxtx", "subs %0, %2, %4, uxtx #3");
    T2("add.w.uxb", "add %w0, %w2, %w4, uxtb #1");
    T1("addi", "add %0, %2, #0xfff");
    T1("addi.lsl", "adds %0, %2, #0x7ff, lsl #12");
    T1("subi.w", "subs %w0, %w2, #1");
    T1("cmp", "cmp %2, #0x80");
    T1("cmn.w", "cmn %w2, #1");
    T1("neg", "negs %0, %2");
    T1("ngc", "ngcs %w0, %w2");
}

static void logic(void) {
    T2("and", "and %0, %2, %4");
    T2("bic.ror", "bic %0, %2, %4, ror #17");
    T2("orr.lsl", "orr %0, %2, %4, lsl #3");
    T2("orn", "orn %0, %2, %4");
    T2("eor.asr", "eor %0, %2, %4, asr #9");
    T2("eon.w", "eon %w0, %w2, %w4, ror #31");
    T2("ands", "ands %0, %2, %4");
    T2("bics.w", "bics %w0, %w2, %w4, lsr #5");
    T1("andi", "and %0, %2, #0x00ff00ff00ff00ff");
    T1("orri.w", "orr %w0, %w2, #0x0f0f0f0f");
    T1("eori", "eor %0, %2, #0xfffffffffffffffe");
    T1("andsi", "ands %0, %2, #0x8000000000000000");
    T1("tsti.w", "tst %w2, #0x3fe");
    T1("andi.rep", "and %0, %2, #0x6666666666666666");
    T1("mvn", "mvn %0, %2");
}

static void moves(void) {
    T1("movk", "mov %0, %2\n\tmovk %0, #0xbeef, lsl #32");
    T1("movk.w", "mov %0, %2\n\tmovk %w0, #0x1234, lsl #16");
    T1("movz", "movz %0, #0xabcd, lsl #48\n\tadd %0, %0, %2");
    T1("movn.w", "movn %w0, #0x7f, lsl #16\n\tadd %0, %0, %2");
}

static void bitfield(void) {
    T1("ubfx", "ubfx %0, %2, #13, #21");
    T1("sbfx", "sbfx %0, %2, #3, #40");
    T1("ubfx.w", "ubfx %w0, %w2, #31, #1");
    T1("sbfx.w", "sbfx %w0, %w2, #4, #8");
    T1("bfi", "mov %0, %4\n\tbfi %0, %2, #7, #19");
    T1("bfxil", "mov %0, %4\n\tbfxil %0, %2, #60, #4");
    T1("bfi.w", "mov %0, %4\n\tbfi %w0, %w2, #20, #12");
    T1("ubfiz", "ubfiz %0, %2, #33, #11");
    T1("sbfiz", "sbfiz %0, %2, #2, #62");
    T1("sxtb", "sxtb %0, %w2");
    T1("sxth.w", "sxth %w0, %w2");
    T1("sxtw", "sxtw %0, %w2");
    T1("uxtb", "uxtb %w0, %w2");
    T1("uxth", "uxth %w0, %w2");
    T1("lsl", "lsl %0, %2, #37");
    T1("lsr.w", "lsr %w0, %w2, #9");
    T1("asr", "asr %0, %2, #63");
    T1("asr.w", "asr %w0, %w2, #17");
    T2("extr", "extr %0, %2, %4, #23");
    T2("extr.w", "extr %w0, %w2, %w4, #31");
    T1("ror", "ror %0, %2, #1");
    T1("ror.w", "ror %w0, %w2, #30");
}

static void condsel(void) {
#define CS(c) T2("csel." #c, "csel %0, %2, %4, " #c);
    CONDS(CS)
    T2("csinc", "csinc %0, %2, %4, lt");
    T2("csinv.w", "csinv %w0, %w2, %w4, hi");
    T2("csneg", "csneg %0, %2, %4, vs");
    T1("cset", "cset %0, ge");
    T1("csetm.w", "csetm %w0, ls");
    T1("cinc", "cinc %0, %2, mi");
    T2("ccmp", "ccmp %2, %4, #5, ne");
    T2("ccmp.w", "ccmp %w2, %w4, #10, gt");
    T2("ccmn", "ccmn %2, %4, #3, cs");
    T1("ccmp.imm", "ccmp %2, #17, #9, le");
    T1("ccmn.imm", "ccmn %w2, #31, #6, vc");
}

static void muldiv(void) {
    T3("madd", "madd %0, %1, %2, %3");
    T3("msub.w", "msub %w0, %w1, %w2, %w3");
    T3("smaddl", "smaddl %0, %w1, %w2, %3");
    T3("umaddl", "umaddl %0, %w1, %w2, %3");
    T3("smsubl", "smsubl %0, %w1, %w2, %3");
    T3("umsubl", "umsubl %0, %w1, %w2, %3");
    T3("smulh", "smulh %0, %1, %2");
    T3("umulh", "umulh %0, %1, %2");
    T3("mul.w", "mul %w0, %w1, %w2");
    T3("udiv", "udiv %0, %1, %2");
    T3("sdiv", "sdiv %0, %1, %2");
    T3("udiv.w", "udiv %w0, %w1, %w2");
    T3("sdiv.w", "sdiv %w0, %w1, %w2");
    T3("lslv", "lsl %0, %1, %2");
    T3("lsrv.w", "lsr %w0, %w1, %w2");
    T3("asrv", "asr %0, %1, %2");
    T3("asrv.w", "asr %w0, %w1, %w2");
    T3("rorv", "ror %0, %1, %2");
}

static void onesrc(void) {
    T1("rbit", "rbit %0, %2");
    T1("rbit.w", "rbit %w0, %w2");
    T1("rev", "rev %0, %2");
    T1("rev.w", "rev %w0, %w2");
    T1("rev16", "rev16 %0, %2");
    T1("rev16.w", "rev16 %w0, %w2");
    T1("rev32", "rev32 %0, %2");
    T1("clz", "clz %0, %2");
    T1("clz.w", "clz %w0, %w2");
    T1("cls", "cls %0, %2");
    T1("cls.w", "cls %w0, %w2");
}

static void branches(void) {
    /* b.cond on every condition, for every flag combination */
#define BC(c) for (u64 f = 0; f < 16; f++) { u64 r; __asm__ volatile("msr nzcv, %1\n\tmov %0, #1\n\tb." #c " 1f\n\tmov %0, #0\n1:" \
    : "=&r"(r) : "r"(f << 28) : "cc"); mix(r << f); }
    CONDS(BC)
    report("b.cond");
    for (unsigned i = 0; i < NV; i++) {
        u64 r, v = vals[i];
        __asm__ volatile("mov %0, #0\n\tcbz %1, 1f\n\torr %0, %0, #1\n1:\tcbnz %w1, 2f\n\torr %0, %0, #2\n2:\t"
                         "tbz %1, #63, 3f\n\torr %0, %0, #4\n3:\ttbnz %1, #3, 4f\n\torr %0, %0, #8\n4:\t"
                         "tbz %w1, #31, 5f\n\torr %0, %0, #16\n5:"
                         : "=&r"(r) : "r"(v));
        mix(r);
    }
    report("cbz/tbz");
    /* bl / blr / br / ret, adr / adrp relative to each other */
    u64 a, b, c2;
    __asm__ volatile("adr %0, 1f\n\tadrp %1, 1f\n\tbl 2f\n1:\tb 3f\n2:\tmov %2, x30\n\tret\n3:"
                     : "=&r"(a), "=&r"(b), "=&r"(c2) : : "x30");
    mix(a - c2);
    mix((a & ~0xfffull) - b);
    u64 t;
    __asm__ volatile("adr %0, 1f\n\tblr %0\n\tb 2f\n1:\tret\n2:\tadr %0, 3f\n\tbr %0\n\tbrk #1\n3:" : "=&r"(t) : : "x30");
    report("bl/br/adr");
}

static unsigned char buf[512] __attribute__((aligned(16)));

static void mem(void) {
    for (unsigned i = 0; i < sizeof buf; i++) buf[i] = (unsigned char)(i * 37 + 11);
    for (unsigned i = 0; i < 64; i++) {
        unsigned char *p = buf + 64 + i;
        u64 r1, r2, r3, r4, r5, r6, r7;
        __asm__ volatile("ldrb %w0, [%7]\n\tldrsb %1, [%7, #1]\n\tldrh %w2, [%7, #3]\n\tldrsh %w3, [%7, #-5]\n\t"
                         "ldr %w4, [%7, #7]\n\tldrsw %5, [%7, #-13]\n\tldur %6, [%7, #-1]"
                         : "=&r"(r1), "=&r"(r2), "=&r"(r3), "=&r"(r4), "=&r"(r5), "=&r"(r6), "=&r"(r7) : "r"(p));
        mix(r1); mix(r2); mix(r3); mix(r4); mix(r5); mix(r6); mix(r7);
    }
    report("ld.imm");
    for (unsigned i = 0; i < 32; i++) { /* stays inside buf: other data holds the random canary */
        u64 r1, r2, r3, r4, idx = i;
        long neg = -(long)i;
        __asm__ volatile("ldr %0, [%4, %5, lsl #3]\n\tldrh %w1, [%4, %w5, uxtw #1]\n\tldrsb %w2, [%4, %w6, sxtw]\n\t"
                         "ldrsw %3, [%4, %6, lsl #2]"
                         : "=&r"(r1), "=&r"(r2), "=&r"(r3), "=&r"(r4) : "r"(buf + 256), "r"(idx), "r"(neg));
        mix(r1); mix(r2); mix(r3); mix(r4);
    }
    report("ld.reg");
    unsigned char *p = buf, *q = buf + 250;
    u64 s1 = 0;
    for (unsigned i = 0; i < 16; i++) {
        u64 v;
        __asm__ volatile("ldr %0, [%1], #8\n\tstr %0, [%2, #-8]!" : "=&r"(v), "+r"(p), "+r"(q) : : "memory");
        s1 += v;
        __asm__ volatile("ldrh %w0, [%1, #2]!\n\tstrh %w0, [%2], #-2" : "=&r"(v), "+r"(p), "+r"(q) : : "memory");
        s1 ^= v;
    }
    mix(s1); mix((u64)(p - buf)); mix((u64)(q - buf));
    report("ld.wback");
    for (unsigned i = 0; i < 32; i++) {
        u64 a = vals[i], b = vals[i + 1], ra, rb;
        long sa, sb;
        unsigned char *pp = buf + 300;
        __asm__ volatile("stp %5, %6, [%4, #16]\n\tldp %0, %1, [%4, #16]\n\tldpsw %2, %3, [%4, #20]\n\t"
                         "stp %w6, %w5, [%4, #-8]!\n\tstp %5, %5, [%4], #24"
                         : "=&r"(ra), "=&r"(rb), "=&r"(sa), "=&r"(sb), "+r"(pp) : "r"(a), "r"(b) : "memory");
        mix(ra); mix(rb); mix((u64)sa); mix((u64)sb); mix((u64)(pp - buf));
        __asm__ volatile("strb %w1, [%2, #3]\n\tsturh %w1, [%2, #-3]\n\tstr %w1, [%2, %3]\n\tstur %1, [%2, #1]\n\t"
                         "ldr %0, [%2]" : "=&r"(ra) : "r"(b), "r"(buf + 400), "r"((u64)i & 7) : "memory");
        mix(ra);
    }
    for (unsigned i = 0; i < sizeof buf; i++) mix(buf[i]);
    report("st/pair");
    /* literal pool, prfm */
    u64 lit, lit2;
    __asm__ volatile("ldr %0, 1f\n\tldrsw %1, 2f\n\tprfm pldl1keep, [%0]\n\tb 3f\n\t.balign 8\n1:\t.quad 0x0123456789abcdef\n2:\t.word 0x80000001\n3:"
                     : "=&r"(lit), "=&r"(lit2));
    mix(lit); mix(lit2);
    report("literal");
}

static void simd(void) {
    unsigned char a[64] __attribute__((aligned(16))), b[64] __attribute__((aligned(16)));
    for (unsigned i = 0; i < 64; i++) a[i] = (unsigned char)(i * 13 + 5), b[i] = 0;
    unsigned char *pb = b;
    __asm__ volatile("ldr q0, [%1]\n\tldp q1, q2, [%1, #16]\n\tstr q2, [%0]\n\tstp q0, q1, [%0, #16]!\n\tldur q3, [%1, #3]\n\tstur q3, [%0, #-15]\n\t"
                     "ldr d4, [%1, #48]\n\tstr d4, [%0, #40]\n\tldr s5, [%1, #56]\n\tstr s5, [%0, #36]"
                     : "+r"(pb) : "r"(a) : "v0", "v1", "v2", "v3", "v4", "v5", "memory");
    mix((u64)(pb - b));
    for (unsigned i = 0; i < 64; i++) mix(b[i]);
    report("ldst.q");
    for (unsigned i = 0; i < NV; i++) {
        u64 v = vals[i], lo, hi, x, y, z, w, m;
        __asm__ volatile("dup v0.16b, %w7\n\tdup v1.8h, %w7\n\tins v1.s[1], %w7\n\tdup v2.2d, %7\n\tmov v2.b[3], v1.b[2]\n\t"
                         "umov %w0, v1.h[3]\n\tsmov %1, v2.b[3]\n\tmovi v3.4s, #0x5c, lsl #8\n\tmvni v4.8h, #0x12\n\t"
                         "orr v3.4s, #0x40, lsl #24\n\tbic v4.4h, #0x1\n\tbit v3.16b, v2.16b, v0.16b\n\tbsl v4.16b, v2.16b, v1.16b\n\t"
                         "eor v5.16b, v3.16b, v4.16b\n\tdup v6.4s, v5.s[2]\n\tbif v6.16b, v0.16b, v4.16b\n\tmov %2, v5.d[0]\n\tmov %3, v5.d[1]\n\t"
                         "mov %4, v6.d[1]\n\tcmeq v7.16b, v2.16b, v0.16b\n\tumaxv b7, v7.16b\n\tfmov %w5, s7\n\tmovi v7.2d, #0xff00ff00ff00ff00\n\t"
                         "fmov d7, %7\n\tfmov v7.d[1], %7\n\tuminv h7, v7.8h\n\tumov %w6, v7.h[0]"
                         : "=&r"(lo), "=&r"(hi), "=&r"(x), "=&r"(y), "=&r"(z), "=&r"(w), "=&r"(m) : "r"(v)
                         : "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7");
        mix(lo); mix(hi); mix(x); mix(y); mix(z); mix(w); mix(m);
    }
    report("simd.mov");
}

static void sysregs(void) {
    u64 tp, old, fpcr, fpsr, dcz;
    __asm__ volatile("mrs %0, tpidr_el0" : "=r"(old));
    __asm__ volatile("msr tpidr_el0, %1\n\tmrs %0, tpidr_el0\n\tmsr tpidr_el0, %2" : "=&r"(tp) : "r"(0x1234567890ull), "r"(old));
    mix(tp);
    __asm__ volatile("mrs %0, fpcr\n\tmrs %1, fpsr" : "=r"(fpcr), "=r"(fpsr));
    mix(fpcr); mix(fpsr);
    __asm__ volatile("mrs %0, dczid_el0" : "=r"(dcz));
    mix(dcz & 0x10); /* DZP; the block size may differ */
    __asm__ volatile("nop\n\tyield\n\thint #34\n\tdmb ish\n\tdsb sy\n\tisb\n\tclrex");
    report("sysreg");
}

int main(void) {
    for (unsigned i = 0; i < NEDGE; i++) vals[i] = edge[i];
    for (unsigned i = NEDGE; i < NV; i++) vals[i] = next();
    hash = 0xcbf29ce484222325;
    arith();
    logic();
    moves();
    bitfield();
    condsel();
    muldiv();
    onesrc();
    branches();
    mem();
    simd();
    sysregs();
    printf("inttest done\n");
    return 0;
}
