#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
"""Write a newc cpio archive of a directory tree (all files owned by root).

usage: mkcpio.py <dir> <out.cpio> [--gzip]
Directories, regular files, symlinks and hard links (as copies) are stored;
modes are kept. Device nodes are skipped (devtmpfs provides /dev).
"""
import gzip
import os
import stat
import sys


def entry(out, name, mode, data=b"", ino=[0], nlink=1, rdev=0):
    ino[0] += 1
    name_b = name.encode() + b"\0"
    hdr = "070701" + "".join("%08X" % v for v in (
        ino[0], mode, 0, 0, nlink, 0, len(data), 0, 0,
        (rdev >> 8) & 0xfff, rdev & 0xff, len(name_b), 0))
    out.write(hdr.encode())
    out.write(name_b)
    out.write(b"\0" * ((4 - (110 + len(name_b)) % 4) % 4))
    out.write(data)
    out.write(b"\0" * ((4 - len(data) % 4) % 4))


def main():
    src, dst = sys.argv[1], sys.argv[2]
    gz = "--gzip" in sys.argv
    out = gzip.open(dst, "wb", compresslevel=6) if gz else open(dst, "wb")
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames.sort()
        rel = os.path.relpath(dirpath, src)
        if rel != ".":
            st = os.lstat(dirpath)
            entry(out, rel, stat.S_IFDIR | stat.S_IMODE(st.st_mode), nlink=2)
        for fn in sorted(filenames + [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]):
            full = os.path.join(dirpath, fn)
            name = os.path.normpath(os.path.join(rel, fn))
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                entry(out, name, stat.S_IFLNK | 0o777, os.readlink(full).encode())
            elif stat.S_ISREG(st.st_mode):
                with open(full, "rb") as f:
                    entry(out, name, stat.S_IFREG | stat.S_IMODE(st.st_mode), f.read())
        # don't descend into symlinked dirs
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
    entry(out, "TRAILER!!!", 0)
    out.close()


main()
