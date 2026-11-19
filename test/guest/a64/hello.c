// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * The smallest A64 guest: static musl startup, stdio, argv/envp, TLS
 * (tpidr_el0), the exit status. test/a64-test.mjs compares its output and
 * exit status under kwemu with qemu-aarch64.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static __thread int tls_counter = 40;

int main(int argc, char **argv) {
    printf("hello from a64: argc=%d\n", argc);
    for (int i = 0; i < argc; i++) printf("argv[%d] = %s\n", i, argv[i]);
    const char *home = getenv("HOME");
    printf("HOME=%s\n", home ? home : "(unset)");
    tls_counter += 2;
    char buf[64];
    memset(buf, 'x', sizeof buf);
    memcpy(buf + 3, "copy", 4);
    buf[20] = 0;
    printf("tls=%d buf=%s len=%zu\n", tls_counter, buf, strlen(buf));
    return 42;
}
