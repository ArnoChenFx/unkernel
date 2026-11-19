// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A64 exclusives, load-acquire/store-release, barriers, hints and the EL0
 * system registers, single-threaded: the lock and atomic patterns musl
 * uses (a_ll/a_sc = LDAXR/STLXR, a_cas, a_swap, a_fetch_add), LDXR/STXR of
 * every size, 128-bit CAS by LDAXP/STLXP, the monitor rules qemu and kwemu
 * share (STXR fails without LDXR, after CLREX, on another address), LDAR/
 * STLR, NZCV/FPCR/FPSR/TPIDR_EL0 round trips, CNTVCT_EL0, DC ZVA over a
 * buffer, and new code made visible by DC CVAU + IC IVAU.
 *
 * Self-checking (exit status 1 on a failed CHECK) and prints only what is
 * the same on qemu-aarch64 and kwemu: values that differ by design (MIDR,
 * ID register feature fields, CTR_EL0, the DC ZVA block size, counter
 * values) are only checked for properties both must have.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

typedef uint64_t u64;
typedef uint32_t u32;
typedef uint16_t u16;
typedef uint8_t u8;

static int fails;
#define CHECK(name, cond) do { int _ok = !!(cond); printf("%-32s %s\n", name, _ok ? "ok" : "FAIL"); if (!_ok) fails++; } while (0)
#define SHOW(name, v) printf("%-32s %016llx\n", name, (unsigned long long)(v))

/* ---- musl's aarch64 atomic_arch.h ------------------------------------------- */

static inline int a_ll(volatile int *p) {
    int v;
    __asm__ __volatile__("ldaxr %w0,%1" : "=r"(v) : "Q"(*p));
    return v;
}
static inline int a_sc(volatile int *p, int v) {
    int r;
    __asm__ __volatile__("stlxr %w0,%w2,%1" : "=&r"(r), "=Q"(*p) : "r"(v) : "memory");
    return !r;
}
static inline void a_barrier(void) { __asm__ __volatile__("dmb ish" : : : "memory"); }
static inline int a_cas(volatile int *p, int t, int s) {
    int old;
    do {
        old = a_ll(p);
        if (old != t) {
            a_barrier();
            break;
        }
    } while (!a_sc(p, s));
    return old;
}
static inline void *a_ll_p(volatile void *p) {
    void *v;
    __asm__ __volatile__("ldaxr %0, %1" : "=r"(v) : "Q"(*(void *volatile *)p));
    return v;
}
static inline int a_sc_p(volatile int *p, void *v) {
    int r;
    __asm__ __volatile__("stlxr %w0,%2,%1" : "=&r"(r), "=Q"(*(void *volatile *)p) : "r"(v) : "memory");
    return !r;
}
static inline void *a_cas_p(volatile void *p, void *t, void *s) {
    void *old;
    do {
        old = a_ll_p(p);
        if (old != t) {
            a_barrier();
            break;
        }
    } while (!a_sc_p(p, s));
    return old;
}
/* musl's generic a_swap / a_fetch_add / a_and / a_or on top of a_ll/a_sc */
static inline int a_swap(volatile int *p, int v) {
    int old;
    do old = a_ll(p);
    while (!a_sc(p, v));
    return old;
}
static inline int a_fetch_add(volatile int *p, int v) {
    int old;
    do old = a_ll(p);
    while (!a_sc(p, (int)((unsigned)old + v)));
    return old;
}
static inline void a_and(volatile int *p, int v) {
    int old;
    do old = a_ll(p);
    while (!a_sc(p, old & v));
}
static inline void a_or(volatile int *p, int v) {
    int old;
    do old = a_ll(p);
    while (!a_sc(p, old | v));
}

static void musl_patterns(void) {
    volatile int x = 5;
    int r1 = a_cas(&x, 5, 9);
    int r2 = a_cas(&x, 5, 11); /* fails: x is 9 */
    printf("a_cas                            %d %d %d\n", r1, r2, x);
    int s = a_swap(&x, -3);
    printf("a_swap                           %d %d\n", s, x);
    u64 h = 0;
    for (int i = 0; i < 1000; i++) h = h * 31 + (unsigned)a_fetch_add(&x, i * 7 - 300);
    printf("a_fetch_add                      %016llx %d\n", (unsigned long long)h, x);
    x = 0x0ff0;
    a_and(&x, 0x3c3c);
    a_or(&x, 0x8001);
    printf("a_and/a_or                       %x\n", x);
    /* a lock: a_cas acquire, a_swap release, as in musl's __lock */
    volatile int lock = 0;
    int got = 0;
    for (int i = 0; i < 100; i++) {
        if (a_cas(&lock, 0, 1) == 0) got++;
        if (a_cas(&lock, 0, 1) == 0) got += 1000; /* must not get it twice */
        a_swap(&lock, 0);
    }
    printf("lock                             %d %d\n", got, lock);
    static void *volatile ptr;
    void *o1 = a_cas_p(&ptr, 0, (void *)&got);
    void *o2 = a_cas_p(&ptr, 0, (void *)&x);
    CHECK("a_cas_p", o1 == 0 && o2 == (void *)&got && ptr == (void *)&got);
}

/* ---- every size, plain and ordered ------------------------------------------- */

#define LDX(sfx, reg, p) ({ u64 _v; __asm__ volatile("ldxr" sfx " %" reg "0, [%1]" : "=&r"(_v) : "r"(p) : "memory"); _v; })
#define STX(sfx, reg, p, v) ({ u32 _s; __asm__ volatile("stxr" sfx " %w0, %" reg "2, [%1]" : "=&r"(_s) : "r"(p), "r"((u64)(v)) : "memory"); _s; })
#define LDAX(sfx, reg, p) ({ u64 _v; __asm__ volatile("ldaxr" sfx " %" reg "0, [%1]" : "=&r"(_v) : "r"(p) : "memory"); _v; })
#define STLX(sfx, reg, p, v) ({ u32 _s; __asm__ volatile("stlxr" sfx " %w0, %" reg "2, [%1]" : "=&r"(_s) : "r"(p), "r"((u64)(v)) : "memory"); _s; })
#define LDA(sfx, reg, p) ({ u64 _v; __asm__ volatile("ldar" sfx " %" reg "0, [%1]" : "=&r"(_v) : "r"(p) : "memory"); _v; })
#define STL(sfx, reg, p, v) __asm__ volatile("stlr" sfx " %" reg "1, [%0]" : : "r"(p), "r"((u64)(v)) : "memory")

static u64 mem[8] __attribute__((aligned(64)));

static void sizes(void) {
    u8 *b = (u8 *)mem;
    mem[0] = 0x8877665544332211ull;
    mem[1] = 0xffeeddccbbaa9988ull;
    /* increment loops at every size, wrapping */
    for (int i = 0; i < 300; i++) {
        u64 v;
        do v = LDX("b", "w", b + 3);
        while (STX("b", "w", b + 3, v + 1));
        do v = LDAX("h", "w", b + 6);
        while (STLX("h", "w", b + 6, v + 0x1111));
        do v = LDX("", "w", b + 8);
        while (STLX("", "w", b + 8, v * 3 + 1));
        do v = LDAX("", "x", b + 16);
        while (STX("", "x", b + 16, v ^ (v << 7) ^ i));
    }
    SHOW("exclusive sizes [0]", mem[0]);
    SHOW("exclusive sizes [1]", mem[1]);
    SHOW("exclusive sizes [2]", mem[2]);
    /* first attempts, and the monitor rules both implementations share */
    u64 v = LDX("", "x", &mem[3]);
    u32 s1 = STX("", "x", &mem[3], v + 5);
    u32 s2 = STX("", "x", &mem[3], v + 7); /* no LDXR: fails */
    LDX("", "x", &mem[3]);
    __asm__ volatile("clrex" ::: "memory");
    u32 s3 = STX("", "x", &mem[3], 99); /* after CLREX: fails */
    LDX("", "x", &mem[3]);
    u32 s4 = STX("", "x", &mem[4], 99); /* another address: fails */
    LDAX("", "w", &mem[3]);
    u32 s5 = STLX("", "w", &mem[3], 0x1234); /* passes */
    printf("stxr status                      %u %u %u %u %u %016llx %016llx\n", s1, s2, s3, s4, s5,
           (unsigned long long)mem[3], (unsigned long long)mem[4]);
    /* zero-extension of W loads, and an exclusive on SP */
    mem[5] = 0xdeadbeefcafef00dull;
    u64 w = LDX("", "w", &mem[5]);
    STX("", "w", &mem[5], w);
    u64 sp_v, sp_s;
    __asm__ volatile("sub sp, sp, #16\n\tstr %2, [sp]\n\t1: ldaxr %0, [sp]\n\tadd %0, %0, #1\n\tstlxr %w1, %0, [sp]\n\tcbnz %w1, 1b\n\t"
                     "ldr %0, [sp]\n\tadd sp, sp, #16"
                     : "=&r"(sp_v), "=&r"(sp_s) : "r"(0x7fffffffffffffffull) : "memory");
    printf("ldxr w zero-extends, sp base     %016llx %016llx\n", (unsigned long long)w, (unsigned long long)sp_v);
    /* LDAR / STLR */
    STL("", "x", &mem[6], 0x0123456789abcdefull);
    u64 a0 = LDA("b", "w", b + 48), a1 = LDA("h", "w", b + 50), a2 = LDA("", "w", b + 52), a3 = LDA("", "x", &mem[6]);
    STL("b", "w", b + 56, 0x1ff);
    STL("h", "w", b + 58, 0x2ffff);
    STL("", "w", b + 60, 0x3ffffffffull);
    printf("ldar                             %llx %llx %llx %llx\n", (unsigned long long)a0, (unsigned long long)a1,
           (unsigned long long)a2, (unsigned long long)a3);
    SHOW("stlr", mem[7]);
}

/* ---- pairs ---------------------------------------------------------------------- */

static u64 cell[2] __attribute__((aligned(16)));

/* __aarch64_cas16 for ARMv8.0: the compare fails with a store of the value
 * read, so the read is single-copy atomic. */
static int cas128(u64 *p, u64 *elo, u64 *ehi, u64 nlo, u64 nhi) {
    u64 lo, hi;
    u32 st;
    for (;;) {
        __asm__ volatile("ldaxp %0, %1, [%2]" : "=&r"(lo), "=&r"(hi) : "r"(p) : "memory");
        if (lo != *elo || hi != *ehi) {
            __asm__ volatile("stlxp %w0, %1, %2, [%3]" : "=&r"(st) : "r"(lo), "r"(hi), "r"(p) : "memory");
            if (st) continue;
            *elo = lo;
            *ehi = hi;
            return 0;
        }
        __asm__ volatile("stlxp %w0, %1, %2, [%3]" : "=&r"(st) : "r"(nlo), "r"(nhi), "r"(p) : "memory");
        if (!st) return 1;
    }
}

static void pairs(void) {
    cell[0] = ~0ull - 500;
    cell[1] = 41;
    u64 lo = cell[0], hi = cell[1];
    int ok = 0;
    for (int i = 0; i < 1000; i++) { /* 128-bit increments, carrying */
        u64 nlo = lo + 1, nhi = hi + (nlo == 0);
        if (cas128(cell, &lo, &hi, nlo, nhi)) {
            ok++;
            lo = nlo;
            hi = nhi;
        }
    }
    u64 slo = 1, shi = 2;
    int bad = cas128(cell, &slo, &shi, 0, 0); /* stale: fails, returns the current value */
    printf("cas128                           %d %d %016llx %016llx %016llx %016llx\n", ok, bad, (unsigned long long)cell[0],
           (unsigned long long)cell[1], (unsigned long long)slo, (unsigned long long)shi);
    /* plain LDXP/STXP of X and W pairs, first attempts */
    u64 x0, x1;
    u32 s1, s2, s3;
    __asm__ volatile("ldxp %0, %1, [%2]" : "=&r"(x0), "=&r"(x1) : "r"(cell) : "memory");
    __asm__ volatile("stxp %w0, %1, %2, [%3]" : "=&r"(s1) : "r"(x1), "r"(x0), "r"(cell) : "memory");
    __asm__ volatile("stxp %w0, %1, %2, [%3]" : "=&r"(s2) : "r"(x0), "r"(x1), "r"(cell) : "memory");
    u32 w0, w1;
    mem[0] = 0x2222222211111111ull;
    __asm__ volatile("ldaxp %w0, %w1, [%2]" : "=&r"(w0), "=&r"(w1) : "r"(mem) : "memory");
    __asm__ volatile("stlxp %w0, %w1, %w2, [%3]" : "=&r"(s3) : "r"(w1 + 1), "r"(w0 + 2), "r"(mem) : "memory");
    printf("ldxp/stxp                        %u %u %u %016llx %016llx %08x %08x %016llx\n", s1, s2, s3, (unsigned long long)cell[0],
           (unsigned long long)cell[1], w0, w1, (unsigned long long)mem[0]);
}

/* ---- barriers and hints --------------------------------------------------------- */

static void barriers_hints(void) {
    __asm__ volatile("dmb ish\n\tdmb ishld\n\tdmb ishst\n\tdmb sy\n\tdmb oshld\n\tdsb sy\n\tdsb ish\n\tdsb #0\n\tdsb #4\n\tisb\n\tclrex\n\tclrex #5" ::: "memory");
    __asm__ volatile("nop\n\tyield\n\tsev\n\thint #5\n\thint #20\n\thint #0x7f\n\thint #34\n\thint #32" ::: "memory");
    u64 lr0, lr1, p0 = (u64)&fails, p1;
    /* paciasp/autiasp and pacia1716/autia1716 pairs, xpaclri: no change
     * (qemu signs and authenticates; kwemu runs them as NOPs) */
    __asm__ volatile("mov %0, x30\n\thint #25\n\thint #29\n\thint #7\n\tmov %1, x30" : "=&r"(lr0), "=&r"(lr1) : : "x30");
    __asm__ volatile("mov x17, %1\n\tmov x16, #42\n\thint #8\n\thint #12\n\tmov %0, x17" : "=r"(p1) : "r"(p0) : "x16", "x17");
    CHECK("hints, barriers", lr0 == lr1 && p0 == p1);
}

/* ---- system registers ------------------------------------------------------------ */

#define MRS(r) ({ u64 _v; __asm__ volatile("mrs %0, " r : "=r"(_v)); _v; })
#define MSR(r, v) __asm__ volatile("msr " r ", %0" : : "r"((u64)(v)) : "memory", "cc")

static void sysregs(void) {
    u64 tp = MRS("tpidr_el0");
    CHECK("tpidr_el0 = thread pointer", tp == (u64)__builtin_thread_pointer());
    MSR("tpidr_el0", 0x123456789abcdef0ull);
    u64 tp2 = MRS("tpidr_el0");
    MSR("tpidr_el0", tp);
    SHOW("tpidr_el0 round trip", tp2);
    SHOW("tpidrro_el0", MRS("tpidrro_el0"));
    u64 h = 0;
    for (u64 f = 0; f < 16; f++) {
        MSR("nzcv", (f << 28) | 0x0fffffffull | (f << 40));
        h = h * 17 + MRS("nzcv");
    }
    SHOW("nzcv round trips", h);
    /* FPCR: AHP, DN, FZ, RMode are all ARMv8.0 has (qemu keeps more) */
    static const u32 fpcr[] = {0, 1u << 22, 2u << 22, 3u << 22, 1u << 24, 1u << 25, 1u << 26, 0x07c00000, 0xffffffff};
    h = 0;
    for (unsigned i = 0; i < sizeof fpcr / sizeof fpcr[0]; i++) {
        MSR("fpcr", fpcr[i]);
        h = h * 31 + (MRS("fpcr") & 0x07c00000);
    }
    MSR("fpcr", 0);
    SHOW("fpcr round trips", h);
    CHECK("fpcr restored", MRS("fpcr") == 0);
    h = 0;
    for (int i = 0; i < 32; i++) {
        MSR("fpsr", 1u << i);
        h = h * 31 + (MRS("fpsr") & 0x0800009f);
    }
    MSR("fpsr", 0x0800009f);
    h = h * 31 + (MRS("fpsr") & 0x0800009f);
    MSR("fpsr", 0);
    SHOW("fpsr round trips", h);
    /* the counter: never goes back; 1 GHz on both */
    u64 last = MRS("cntvct_el0"), back = 0;
    for (int i = 0; i < 2000; i++) {
        u64 t = MRS("cntvct_el0");
        if (t < last) back++;
        last = t;
    }
    CHECK("cntvct_el0 monotonic", back == 0 && last != 0);
    SHOW("cntfrq_el0", MRS("cntfrq_el0"));
    /* ID registers Linux emulates: only what qemu and kwemu agree on */
    (void)MRS("midr_el1");
    SHOW("mpidr_el1", MRS("mpidr_el1"));
    SHOW("revidr_el1", MRS("revidr_el1"));
    u64 pfr0 = MRS("id_aa64pfr0_el1");
    SHOW("id_aa64pfr0_el1.EL0", pfr0 & 0xf);
    CHECK("id_aa64pfr0_el1 FP, AdvSIMD", ((pfr0 >> 16) & 0xf) != 0xf && ((pfr0 >> 20) & 0xf) != 0xf);
    (void)MRS("id_aa64isar0_el1"); /* feature fields differ (qemu: -cpu max) */
    SHOW("id_aa64dfr0_el1", MRS("id_aa64dfr0_el1"));
    SHOW("unallocated ID reg (RAZ)", MRS("S3_0_C0_C7_7"));
    u64 ctr = MRS("ctr_el0");
    CHECK("ctr_el0", (ctr >> 31) == 1 && ((ctr >> 16) & 0xf) >= 2 && (ctr & 0xf) >= 2);
}

/* ---- DC ZVA ---------------------------------------------------------------------- */

static u8 zbuf[8192] __attribute__((aligned(4096)));

static u64 fnv(const u8 *p, unsigned n) {
    u64 h = 0xcbf29ce484222325ull;
    for (unsigned i = 0; i < n; i++) h = (h ^ p[i]) * 0x100000001b3ull;
    return h;
}

static void dczva(void) {
    u64 dczid = MRS("dczid_el0");
    unsigned bs = 4u << (dczid & 15);
    CHECK("dczid_el0", (dczid & 16) == 0 && bs >= 16 && bs <= 2048);
    u8 *buf = zbuf + 4096; /* 4096-aligned: a whole number of blocks of any size */
    memset(zbuf, 0xa5, sizeof zbuf);
    for (unsigned off = 1024; off < 3072; off += bs) __asm__ volatile("dc zva, %0" : : "r"(buf + off) : "memory");
    SHOW("dc zva blocks", fnv(zbuf, sizeof zbuf));
    /* an unaligned address zeroes exactly its block */
    memset(zbuf, 0x5a, sizeof zbuf);
    u8 *a = buf + 1000 + 7;
    __asm__ volatile("dc zva, %0" : : "r"(a) : "memory");
    uintptr_t lo = (uintptr_t)a & ~(uintptr_t)(bs - 1), hi = lo + bs;
    int good = 1;
    for (uintptr_t q = (uintptr_t)zbuf; q < (uintptr_t)zbuf + sizeof zbuf; q++)
        if (*(u8 *)q != (q >= lo && q < hi ? 0 : 0x5a)) good = 0;
    CHECK("dc zva unaligned", good);
}

/* ---- new code: DC CVAU, IC IVAU ------------------------------------------------- */

static void sync_code(u8 *p, unsigned n) {
    u64 ctr = MRS("ctr_el0");
    uintptr_t dline = 4u << ((ctr >> 16) & 15), iline = 4u << (ctr & 15);
    uintptr_t s = (uintptr_t)p, e = s + n;
    for (uintptr_t q = s & ~(dline - 1); q < e; q += dline) __asm__ volatile("dc cvau, %0" : : "r"(q) : "memory");
    __asm__ volatile("dsb ish" ::: "memory");
    for (uintptr_t q = s & ~(iline - 1); q < e; q += iline) __asm__ volatile("ic ivau, %0" : : "r"(q) : "memory");
    __asm__ volatile("dsb ish\n\tisb" ::: "memory");
    /* DC CIVAC, DC CVAC are allowed at EL0 too */
    __asm__ volatile("dc civac, %0\n\tdc cvac, %0" : : "r"(p) : "memory");
}

static void newcode(void) {
    u32 *code = mmap(0, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (code == MAP_FAILED) {
        CHECK("mmap rwx", 0);
        return;
    }
    int (*fn)(void) = (int (*)(void))(void *)code;
    u64 h = 0;
    for (u32 k = 1; k <= 40; k++) {
        code[0] = 0x52800000 | ((k * 997) & 0xffff) << 5; /* mov w0, #imm */
        code[1] = 0xd65f03c0;                               /* ret */
        sync_code((u8 *)code, 8);
        h = h * 131 + (u32)fn();
    }
    SHOW("code rewritten, ic ivau", h);
    munmap(code, 4096);
}

int main(void) {
    musl_patterns();
    sizes();
    pairs();
    barriers_hints();
    sysregs();
    dczva();
    newcode();
    printf("%s\n", fails ? "FAILED" : "all ok");
    return fails ? 1 : 0;
}
