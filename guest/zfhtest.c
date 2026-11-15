// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * Zfhmin (RV64; built with +zfhmin): flh, fsh, fmv.x.h, fmv.h.x and the
 * conversions between half and single/double precision. Every one of the
 * 65536 half values is converted to single and double (exact) and back
 * (exact for non-NaNs), checked against a portable C model of the format;
 * then random singles and doubles are narrowed to half in every static
 * rounding mode and dynamically, each with its flags; NaN-boxing (a half
 * read from a register that is not boxed is the canonical NaN, flh and
 * fmv.h.x box, fmv.x.h sign-extends without checking) and what the
 * compiler emits for _Float16 conversions and memory accesses, in loops
 * long enough for the JIT. A digest of every result lets the output be
 * compared with
 *   qemu-riscv64-static -cpu rv64,zfhmin=true zfhtest.elf
 * Exit 0 iff all pass.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int checks, failures;

#define EQ(a, b)                                                                                \
    do {                                                                                        \
        checks++;                                                                               \
        uint64_t _a = (uint64_t)(a), _b = (uint64_t)(b);                                        \
        if (_a != _b && failures++ < 20)                                                        \
            printf("FAIL line %d: %s = 0x%016llx, want 0x%016llx\n", __LINE__, #a,              \
                   (unsigned long long)_a, (unsigned long long)_b);                             \
    } while (0)

#define MODEL __attribute__((optnone, noinline)) static

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint64_t next(void)
{
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}

static uint64_t digest = 0xcbf29ce484222325ull;
static void mix(uint64_t v)
{
    digest = (digest ^ v) * 0x100000001b3ull;
}

static unsigned flags(void)
{
    unsigned f;
    __asm__ volatile("frflags %0\n\tfsflags x0" : "=r"(f));
    return f;
}

/* A half as single precision bits (exact): the model. NaNs give the
 * canonical NaN, as RISC-V conversions do. */
MODEL uint32_t m_h2s(uint16_t h)
{
    uint32_t s = (uint32_t)(h >> 15) << 31, e = (h >> 10) & 31, m = h & 0x3ff;
    if (e == 31)
        return m ? 0x7fc00000 : s | 0x7f800000;
    if (e == 0) {
        if (!m)
            return s;
        int k = 0;
        while (!(m & 0x400)) {
            m <<= 1;
            k++;
        }
        return s | (uint32_t)(113 - k) << 23 | (m & 0x3ff) << 13;
    }
    return s | (e + 112) << 23 | m << 13;
}
MODEL uint64_t m_s2d(uint32_t f)
{
    uint64_t s = (uint64_t)(f >> 31) << 63, e = (f >> 23) & 255, m = f & 0x7fffff;
    if (e == 255)
        return m ? 0x7ff8000000000000ull : s | 0x7ff0000000000000ull;
    if (e == 0) {
        if (!m)
            return s;
        int k = 0;
        while (!(m & 0x800000)) {
            m <<= 1;
            k++;
        }
        return s | (uint64_t)(897 - k) << 52 | (m & 0x7fffff) << 29;
    }
    return s | (e + 896) << 52 | m << 29;
}

/* the instructions; fa registers hold raw 64-bit patterns */
static uint64_t fmv_h_x(uint64_t x)
{
    double r;
    uint64_t u;
    __asm__ volatile("fmv.h.x %0, %1" : "=f"(r) : "r"(x));
    memcpy(&u, &r, 8);
    return u;
}
static int64_t fmv_x_h(uint64_t raw)
{
    double f;
    int64_t r;
    memcpy(&f, &raw, 8);
    __asm__ volatile("fmv.x.h %0, %1" : "=r"(r) : "f"(f));
    return r;
}
#define CVT1(op, rm, raw) ({ double _f, _r; uint64_t _u = (raw); memcpy(&_f, &_u, 8); \
    __asm__ volatile(op " %0, %1, " rm : "=f"(_r) : "f"(_f)); memcpy(&_u, &_r, 8); _u; })
#define CVTW(op, raw) ({ double _f, _r; uint64_t _u = (raw); memcpy(&_f, &_u, 8); \
    __asm__ volatile(op " %0, %1" : "=f"(_r) : "f"(_f)); memcpy(&_u, &_r, 8); _u; })

static uint64_t narrow(int dbl, int k, uint64_t raw)
{
    if (dbl)
        switch (k) {
        case 0: return CVT1("fcvt.h.d", "rne", raw);
        case 1: return CVT1("fcvt.h.d", "rtz", raw);
        case 2: return CVT1("fcvt.h.d", "rdn", raw);
        case 3: return CVT1("fcvt.h.d", "rup", raw);
        case 4: return CVT1("fcvt.h.d", "rmm", raw);
        default: return CVT1("fcvt.h.d", "dyn", raw);
        }
    switch (k) {
    case 0: return CVT1("fcvt.h.s", "rne", raw);
    case 1: return CVT1("fcvt.h.s", "rtz", raw);
    case 2: return CVT1("fcvt.h.s", "rdn", raw);
    case 3: return CVT1("fcvt.h.s", "rup", raw);
    case 4: return CVT1("fcvt.h.s", "rmm", raw);
    default: return CVT1("fcvt.h.s", "dyn", raw);
    }
}

/* what the compiler makes of _Float16 */
__attribute__((noinline)) static float sum_halves(const _Float16 *p, int n, _Float16 *out)
{
    float s = 0;
    for (int i = 0; i < n; i++) {
        s += (float)p[i] * 0.5f;
        out[i] = (_Float16)(s * 0.001f);
    }
    return s;
}

int main(void)
{
    const uint64_t boxh = 0xffffffffffff0000ull, boxs = 0xffffffff00000000ull;

    EQ(fmv_h_x(0x12343c00), boxh | 0x3c00);
    EQ(fmv_x_h(0x8000), 0xffffffffffff8000ull);
    EQ(fmv_x_h(0x1234567876540001ull), 0x0001);
    EQ(CVTW("fcvt.s.h", boxh | 0x3c00), boxs | 0x3f800000);
    EQ(CVTW("fcvt.d.h", 0x3c00), 0x7ff8000000000000ull); /* not boxed: canonical NaN */
    flags();

    /* every half: to single and double (exact), and back */
    for (int rep = 0; rep < 3; rep++)
        for (uint32_t h = 0; h < 65536; h++) {
            uint64_t hb = fmv_h_x(h);
            uint64_t s = CVTW("fcvt.s.h", hb), d = CVTW("fcvt.d.h", hb);
            unsigned f1 = flags();
            int nan = ((h >> 10) & 31) == 31 && (h & 0x3ff);
            EQ(s, boxs | m_h2s(h));
            EQ(d, m_s2d(m_h2s(h)));
            EQ(f1, nan && !(h & 0x200) ? 0x10 : 0); /* NV for a signalling NaN */
            uint64_t hs = CVT1("fcvt.h.s", "rne", s), hd = CVT1("fcvt.h.d", "rtz", d);
            unsigned f2 = flags();
            EQ(hs, boxh | (nan ? 0x7e00 : h));
            EQ(hd, boxh | (nan ? 0x7e00 : h));
            EQ(f2, 0);
            EQ(fmv_x_h(hb), (uint64_t)(int64_t)(int16_t)h);
            if (rep == 0)
                mix(s ^ d << 1 ^ hs << 2), mix(f1 | f2 << 8);
        }

    /* random singles and doubles to half, every mode, with flags */
    for (int i = 0; i < 60000; i++) {
        uint64_t r = next();
        uint32_t f32 = (uint32_t)r;
        if (i % 3 == 0) /* mostly near the half range */
            f32 = (f32 & 0x807fffff) | (uint32_t)(100 + next() % 50) << 23;
        uint64_t d = i % 4 == 1 ? (r & 0x800fffffffffffffull) | (uint64_t)(990 + next() % 50) << 52 : r;
        for (int k = 0; k < 5; k++) {
            uint64_t a = narrow(0, k, boxs | f32), b = narrow(1, k, d);
            mix(a), mix(b << 3), mix(flags());
        }
        for (unsigned frm = 0; frm < 5; frm++) {
            __asm__ volatile("fsrm %0" ::"r"(frm));
            mix(narrow(i & 1, 5, i & 1 ? d : boxs | f32)), mix(flags());
        }
        __asm__ volatile("fsrm x0");
        /* single operand not NaN-boxed: the canonical NaN */
        mix(narrow(0, 0, f32)), mix(flags());
    }

    /* flh / fsh: boxing, raw stores, every alignment */
    static uint16_t mem[64];
    for (int i = 0; i < 20000; i++) {
        int k = i % 63;
        uint16_t v = (uint16_t)next();
        mem[k] = v;
        double f;
        uint64_t u;
        __asm__ volatile("flh %0, 0(%1)" : "=f"(f) : "r"(&mem[k]) : "memory");
        memcpy(&u, &f, 8);
        EQ(u, boxh | v);
        uint64_t raw = next();
        memcpy(&f, &raw, 8);
        __asm__ volatile("fsh %0, 0(%1)" ::"f"(f), "r"(&mem[k + 1]) : "memory");
        EQ(mem[k + 1], (uint16_t)raw);
        mix(u ^ mem[k + 1]);
    }

    /* _Float16 as the compiler uses it */
    static _Float16 in[512], out[512];
    for (int i = 0; i < 512; i++)
        in[i] = (_Float16)((int)(next() % 2001) - 1000) * (_Float16)0.125;
    float s = 0;
    for (int rep = 0; rep < 400; rep++)
        s += sum_halves(in, 512, out) * 1e-3f;
    uint64_t h = 0;
    for (int i = 0; i < 512; i++) {
        uint16_t u;
        memcpy(&u, &out[i], 2);
        h = h * 31 + u;
    }
    uint32_t sb;
    memcpy(&sb, &s, 4);
    mix(h), mix(sb), mix(flags());

    printf("zfhtest digest: %016llx\n", (unsigned long long)digest);
    printf("zfhtest: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
