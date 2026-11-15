// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * C11 atomics as the compiler emits them for rv64gc: AMOs for 32/64-bit
 * RMW ops, LR/SC loops for CAS and for 8/16-bit (masked) operations,
 * fences. Single-threaded, checks values. Exit 0 iff all pass.
 */
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

static int checks, failures;
#define EQ(a, b)                                                                              \
    do {                                                                                      \
        checks++;                                                                             \
        unsigned long long _a = (unsigned long long)(a), _b = (unsigned long long)(b);        \
        if (_a != _b) {                                                                       \
            failures++;                                                                       \
            printf("FAIL line %d: %s = 0x%llx, want 0x%llx\n", __LINE__, #a, _a, _b);         \
        }                                                                                     \
    } while (0)

#define RMW_TESTS(T, var)                                                    \
    do {                                                                     \
        atomic_store(&var, (T)100);                                          \
        EQ(atomic_fetch_add(&var, (T)5), (T)100);                            \
        EQ(atomic_load(&var), (T)105);                                       \
        EQ(atomic_fetch_sub_explicit(&var, (T)6, memory_order_acq_rel), (T)105); \
        EQ(atomic_fetch_or(&var, (T)0x40), (T)99);                           \
        EQ(atomic_fetch_and(&var, (T)0x4f), (T)(99 | 0x40));                 \
        EQ(atomic_fetch_xor(&var, (T)0xff), (T)((99 | 0x40) & 0x4f));        \
        EQ(atomic_exchange(&var, (T)-1), (T)(((99 | 0x40) & 0x4f) ^ 0xff));  \
        EQ(atomic_load(&var), (T)-1);                                        \
        T exp_ = (T)7;                                                       \
        EQ(atomic_compare_exchange_strong(&var, &exp_, (T)8), 0);            \
        EQ(exp_, (T)-1);                                                     \
        EQ(atomic_compare_exchange_strong(&var, &exp_, (T)8), 1);            \
        EQ(atomic_load(&var), (T)8);                                         \
        int spins = 0;                                                       \
        exp_ = atomic_load(&var);                                            \
        while (!atomic_compare_exchange_weak(&var, &exp_, (T)(exp_ * 3))) spins++; \
        EQ(atomic_load(&var), (T)24);                                        \
        EQ(spins < 100, 1);                                                  \
    } while (0)

static _Atomic uint8_t a8[4];
static _Atomic uint16_t a16[4];
static _Atomic uint32_t a32;
static _Atomic uint64_t a64;
static _Atomic int32_t s32;
static _Atomic int64_t s64;
static atomic_flag flag = ATOMIC_FLAG_INIT;

int main(void) {
    RMW_TESTS(uint32_t, a32);
    RMW_TESTS(uint64_t, a64);
    RMW_TESTS(int32_t, s32);
    RMW_TESTS(int64_t, s64);
    /* sub-word atomics share their aligned word with neighbours */
    for (int i = 0; i < 4; i++) {
        atomic_store(&a8[i], (uint8_t)(0x11 * (i + 1)));
        atomic_store(&a16[i], (uint16_t)(0x1111 * (i + 1)));
    }
    RMW_TESTS(uint8_t, a8[1]);
    RMW_TESTS(uint16_t, a16[2]);
    EQ(atomic_load(&a8[0]), 0x11);
    EQ(atomic_load(&a8[2]), 0x33);
    EQ(atomic_load(&a8[3]), 0x44);
    EQ(atomic_load(&a16[1]), 0x2222);
    EQ(atomic_load(&a16[3]), 0x4444);
    /* sign extension of 32-bit AMO results into 64-bit registers */
    atomic_store(&s32, -5);
    int64_t wide = atomic_fetch_add(&s32, 1);
    EQ(wide, (uint64_t)-5);
    atomic_store(&a32, 0x80000000u);
    uint64_t z = atomic_fetch_add(&a32, 0);
    EQ(z, 0x80000000u);
    {
    /* min/max via builtins (amomin/amomax[u]) on plain integers */
    static int64_t s64 = 0;
    static uint64_t a64 = 0;
    static int32_t s32 = 0;
    static uint32_t a32 = 0x80000000u;
    __atomic_store_n(&s64, 10, __ATOMIC_SEQ_CST);
    EQ(__atomic_fetch_min(&s64, -20, __ATOMIC_SEQ_CST), 10);
    EQ(s64, (uint64_t)-20);
    EQ(__atomic_fetch_max(&s64, 3, __ATOMIC_SEQ_CST), (uint64_t)-20);
    a64 = 10;
    EQ(__atomic_fetch_max(&a64, (uint64_t)-1, __ATOMIC_SEQ_CST), 10);
    EQ(__atomic_fetch_min(&a64, 4, __ATOMIC_SEQ_CST), (uint64_t)-1);
    EQ(a64, 4);
    s32 = 7;
    EQ(__atomic_fetch_min(&s32, -1, __ATOMIC_SEQ_CST), 7);
    EQ(__atomic_fetch_max(&a32, 0xffffffffu, __ATOMIC_SEQ_CST), 0x80000000u);
    EQ(a32, 0xffffffffu);
    }
    /* flag + fences */
    EQ(atomic_flag_test_and_set(&flag), 0);
    EQ(atomic_flag_test_and_set(&flag), 1);
    atomic_flag_clear(&flag);
    EQ(atomic_flag_test_and_set(&flag), 0);
    atomic_thread_fence(memory_order_seq_cst);
    atomic_signal_fence(memory_order_seq_cst);
    /* a contended-looking counter loop */
    atomic_store(&a64, 0);
    for (int i = 0; i < 100000; i++) atomic_fetch_add_explicit(&a64, 3, memory_order_relaxed);
    EQ(atomic_load(&a64), 300000);
    printf("atomics: %d checks, %d failures\n", checks, failures);
    return failures != 0;
}
