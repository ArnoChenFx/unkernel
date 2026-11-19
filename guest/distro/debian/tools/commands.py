# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# commands.py PACKAGES CONTENTS... > MAP: the command -> package map of the
# Debian image (/usr/lib/kw-commands, read by kw-apt-install), one "NAME
# PACKAGE" line per command, sorted. From Contents-* of main (build.sh):
# every file directly in /usr/bin, /usr/sbin, /bin or /sbin of a package
# that PACKAGES (Packages, plain text) lists. Where several packages ship a
# command, the one picked is the first by: not -dev, the shortest name,
# the name. Commands that update-alternatives makes (vim, nc: the packages
# ship vim.basic, nc.openbsd) are not in Contents; for a NAME.SUFFIX with
# no NAME in any package, NAME maps to the same pick among the packages
# with a NAME.* that are named NAME or NAME-* (vim.basic of vim; not
# in.ftpd or a tool.py); ALIASES below adds the rest (nc) and overrides the
# pick where it is not the usual one.
import gzip, re, sys

ALIASES = {
    "vi": "vim-tiny", "view": "vim-tiny", "nc": "netcat-openbsd", "netcat": "netcat-openbsd",
    "cc": "gcc", "c++": "g++", "java": "default-jre-headless",
    "javac": "default-jdk-headless", "lua": "lua5.4", "telnet": "inetutils-telnet",
    "go": "golang-go", "gofmt": "golang-go",
}

pkgs = set(re.findall(r"^Package: (\S+)$", open(sys.argv[1]).read(), re.M))
line = re.compile(r"^(?:usr/)?s?bin/([^/\s]+)\s+(\S+)$")
cmds, alts = {}, {}
for f in sys.argv[2:]:
    with gzip.open(f, "rt", encoding="utf-8", errors="replace") as fh:
        for l in fh:
            m = line.match(l)
            if not m:
                continue
            name, owners = m.groups()
            if not re.fullmatch(r"[A-Za-z0-9._+-]+", name):
                continue
            ps = {o.rsplit("/", 1)[-1] for o in owners.split(",")} & pkgs
            cmds.setdefault(name, set()).update(ps)
            base, dot, _ = name.partition(".")
            if dot and base:
                alts.setdefault(base, set()).update(ps)
key = lambda p: (p.endswith("-dev"), len(p), p)
out = {n: min(ps, key=key) for n, ps in cmds.items() if ps}
for n, ps in alts.items():
    if n not in out and any(p == n or p.startswith(n + "-") for p in ps):
        out[n] = min(ps, key=key)
for n, p in ALIASES.items():
    if p not in pkgs:
        sys.exit(f"commands.py: alias {n}: no package {p}")
    out[n] = p
sys.stdout.write("".join(f"{n} {out[n]}\n" for n in sorted(out)))
