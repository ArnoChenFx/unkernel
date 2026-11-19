#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Foreign binaries: x86_64, riscv64, i386 (i486-i686 too) and 32-bit arm
# (armv5-armv7, armhf) little-endian ELF executables run through qemu-user,
# by binfmt_misc in the guest kernel (aarch64 is native; the kernel has no
# AArch32, so 32-bit arm needs qemu too). The magic/mask pairs are the ones
# from qemu's scripts/qemu-binfmt-conf.sh: 20 bytes, up to e_machine,
# matching ET_EXEC and ET_DYN. Flag P passes the original argv[0] to the
# interpreter (/etc/kw-qemu). The kw layer's rc has mounted binfmt_misc
# and registered WebAssembly (kwwasi) before this runs (etc/inittab).

d=/proc/sys/fs/binfmt_misc
[ -d $d ] || exit 0
mountpoint -q $d || exit 0
reg() { [ -e $d/$1 ] || printf '%s\n' ":$1:M::$2:$3:/etc/kw-qemu:P" > $d/register; }
reg x86_64 '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00' \
	'\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
reg riscv64 '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xf3\x00' \
	'\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
reg i386 '\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x03\x00' \
	'\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
reg arm '\x7fELF\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x28\x00' \
	'\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff'
