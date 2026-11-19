#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
"""Write a newc cpio archive of a directory tree.

usage: mkcpio.py <dir> <out.cpio> [--gzip] [--links] [--owners ROOTFS.tar]
                 [--node NAME:c|b:MAJOR:MINOR:MODE]...
Directories, regular files and symlinks are stored, owned by root; modes are
kept. Device nodes in the tree are skipped (devtmpfs provides /dev).
  --links    hard links stay hard links (else each is a copy): every name
             gets the same inode number, and the first carries the data,
             which the kernel's unpacker (init/initramfs.c) links up.
  --owners   entries the tarball also has get its uid and gid, and, for a
             directory or regular file in both, its exact mode (the tree's
             modes may have been loosened to read it as a user).
  --node     adds a device node (mode in octal), e.g. dev/console:c:5:1:600,
             so the kernel finds a console before /init mounts devtmpfs.
"""
import gzip
import os
import stat
import sys
import tarfile

_ino = [0]


def entry(out, name, mode, data=b"", ino=None, nlink=1, rdev=0, uid=0, gid=0):
    if ino is None:
        _ino[0] += 1
        ino = _ino[0]
    name_b = name.encode() + b"\0"
    hdr = "070701" + "".join("%08X" % v for v in (
        ino, mode, uid, gid, nlink, 0, len(data), 0, 0,
        (rdev >> 8) & 0xfff, rdev & 0xff, len(name_b), 0))
    out.write(hdr.encode())
    out.write(name_b)
    out.write(b"\0" * ((4 - (110 + len(name_b)) % 4) % 4))
    out.write(data)
    out.write(b"\0" * ((4 - len(data) % 4) % 4))


def options(argv):
    opts = {"gzip": False, "links": False, "owners": None, "nodes": []}
    pos, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a in ("--gzip", "--links"):
            opts[a[2:]] = True
        elif a in ("--owners", "--node"):
            i += 1
            if a == "--owners":
                opts["owners"] = argv[i]
            else:
                opts["nodes"].append(argv[i])
        else:
            pos.append(a)
        i += 1
    if len(pos) != 2:
        raise SystemExit(__doc__)
    return pos, opts


def tar_members(path):
    """{relative name: TarInfo}, names as os.path.normpath gives them."""
    members = {}
    with tarfile.open(path) as t:
        for m in t.getmembers():
            name = os.path.normpath(m.name)
            if name not in (".", ".."):
                members[name] = m
    return members


def main():
    (src, dst), opts = options(sys.argv[1:])
    tar = tar_members(opts["owners"]) if opts["owners"] else {}
    out = gzip.open(dst, "wb", compresslevel=6) if opts["gzip"] else open(dst, "wb")
    links = {}   # (st_dev, st_ino) -> the inode number of its first name

    def meta(name, kind, mode):
        """uid, gid and mode for an entry, from the tarball if it has it."""
        m = tar.get(name)
        if m is None:
            return 0, 0, mode
        same = (kind == "dir" and m.isdir()) or (kind == "reg" and (m.isfile() or m.islnk()))
        return m.uid, m.gid, (stat.S_IMODE(m.mode) if same else mode)

    for dirpath, dirnames, filenames in os.walk(src):
        dirnames.sort()
        rel = os.path.relpath(dirpath, src)
        if rel != ".":
            st = os.lstat(dirpath)
            uid, gid, mode = meta(rel, "dir", stat.S_IMODE(st.st_mode))
            entry(out, rel, stat.S_IFDIR | mode, nlink=2, uid=uid, gid=gid)
        for fn in sorted(filenames + [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]):
            full = os.path.join(dirpath, fn)
            name = os.path.normpath(os.path.join(rel, fn))
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                uid, gid, _ = meta(name, "lnk", 0)
                entry(out, name, stat.S_IFLNK | 0o777, os.readlink(full).encode(), uid=uid, gid=gid)
            elif stat.S_ISREG(st.st_mode):
                uid, gid, mode = meta(name, "reg", stat.S_IMODE(st.st_mode))
                key = (st.st_dev, st.st_ino)
                if opts["links"] and st.st_nlink > 1 and key in links:
                    entry(out, name, stat.S_IFREG | mode, ino=links[key], nlink=st.st_nlink, uid=uid, gid=gid)
                    continue
                with open(full, "rb") as f:
                    data = f.read()
                if opts["links"] and st.st_nlink > 1:
                    _ino[0] += 1
                    links[key] = _ino[0]
                    entry(out, name, stat.S_IFREG | mode, data, ino=_ino[0], nlink=st.st_nlink, uid=uid, gid=gid)
                else:
                    entry(out, name, stat.S_IFREG | mode, data, uid=uid, gid=gid)
        # don't descend into symlinked dirs
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
    for spec in opts["nodes"]:
        name, kind, major, minor, mode = spec.split(":")
        fmt = {"c": stat.S_IFCHR, "b": stat.S_IFBLK}[kind]
        entry(out, name, fmt | int(mode, 8), rdev=(int(major) << 8) | int(minor))
    entry(out, "TRAILER!!!", 0)
    out.close()


main()
