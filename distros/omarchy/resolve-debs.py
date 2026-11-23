#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# resolve-debs.py PACKAGES ROOT...: the packages ROOT... need, from a Packages
# file (xz -dc of one of the pinned lists): one line per package, its pool path
# and SHA-256, the roots first. Depends and Pre-Depends, the first alternative of
# each; the host's cross toolchain provides what BLOCKED names.
import re
import sys

BLOCKED = {"libc6", "libgcc-s1", "libstdc++6", "gcc-14-base", "base-files", "libc-dev-bin", "libgcc-14-dev"}


def load(path):
    pk, cur = {}, {}
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.strip() == "":
            if "Package" in cur:
                pk[cur["Package"]] = cur
            cur = {}
            continue
        m = re.match(r"^([A-Za-z0-9-]+): ?(.*)$", line.rstrip("\n"))
        if m and not line.startswith(" "):
            cur[m.group(1)] = m.group(2)
    if "Package" in cur:
        pk[cur["Package"]] = cur
    return pk


def deps(p):
    out = []
    for field in ("Pre-Depends", "Depends"):
        for alt in p.get(field, "").split(","):
            first = alt.strip().split("|")[0].strip()
            name = re.sub(r"\s*\(.*?\)", "", first).split(":")[0].strip()
            if name:
                out.append(name)
    return out


def main():
    pk = load(sys.argv[1])
    queue, seen, order, missing = list(sys.argv[2:]), set(), [], []
    while queue:
        name = queue.pop(0)
        if name in seen or name in BLOCKED:
            continue
        seen.add(name)
        if name not in pk:
            missing.append(name)
            continue
        order.append(name)
        queue.extend(deps(pk[name]))
    for name in order:
        print(f"{pk[name]['Filename']}\t{pk[name]['SHA256']}")
    sys.stderr.write(f"resolve-debs: {len(order)} packages, missing {len(missing)}: {' '.join(sorted(set(missing)))}\n")


if __name__ == "__main__":
    main()
