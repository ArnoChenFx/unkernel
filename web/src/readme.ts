// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// /root/README: intro notes in root's home, written by the page through
// vm.exec() once user space runs. The image does not carry the file (yet),
// so only the page's guests get it.
//
// - /var/lib/kw-readme holds the sha256 of the copy the page last wrote. The
//   file is written when it is missing and that stamp is too (a new disk),
//   and replaced by a newer text only while it still equals the stamped
//   copy. So a README the user edited stays as it is, and one they deleted
//   stays deleted.
// - On the overlay root both live in the upper layer, so this happens once
//   per data disk; with ?data=0 (or in safe mode) once per boot.
// - Failures are logged and otherwise ignored.

import { REPO } from "./config.ts";
import type { KernelHandle } from "./sdk.ts";

const TEXT = `Welcome to unkernel
===================

This is a Linux 7.3 kernel compiled to WebAssembly, running in your
browser tab. Nothing runs on a server. The kernel is native wasm, and the
programs are unmodified riscv64 Linux binaries, run by kwemu, a riscv64
CPU with a JIT that is linked into the kernel.

User space is Alpine Linux (musl, busybox). You are root, and this is
your home directory.

Things to try
-------------

  apk add htop      Install packages from Alpine's mirrors.
  htop              Or just type the command: if it is missing, the
                    package that provides it is installed for you
                    (KW_AUTO_APK=0 turns that off).
  glimmer           A tiny game, with graphics and sound.
  python3 -m http.server 8000
                    Guest web servers open in the page's preview
                    (Ctrl-A p).

x86_64, aarch64, i386 and arm binaries also run, through qemu-user
(installed the first time one starts). "kw-arch x86_64 CMD" makes
uname report x86_64, for installers that refuse riscv64.

The page
--------

  Ctrl-A ?          All the keyboard shortcuts (on a Mac, Cmd-A works
                    as well as Ctrl-A).
  Ctrl-A n          Another terminal window, up to 9. Ctrl-A 1-9
                    switches between them.
  Ctrl-Shift-O      The demo launcher (Cmd-K on a Mac, or the arrow at
                    the left of the status line).

The status icon opens options, diagnostics, and export or reset of your
disk.

Your changes persist
--------------------

The root file system is an overlay on a disk kept in your browser
(IndexedDB), so everything you change survives a reload. If a change
stops the system from booting, it starts in safe mode instead: your
changes stay in /data/overlay/upper, where you can fix them, and
"kw-overlay restore" boots with them again ("kw-overlay status" says
more, "kw-overlay discard" starts over from the image). Open the page
with ?data=0 for a fresh system every time.

Limits
------

- One CPU. Programs run on an emulated CPU: system calls are fast, but
  heavy computation is several times slower than native.
- No IPv6, and no inbound connections from the internet. The network
  reaches out through a Wisp proxy.
- No strace or gdb (no ptrace register sets), no seccomp.

Source, docs and the JavaScript SDK: ${REPO}
`;

// Stdin is the text. Prints "written" when it wrote /root/README.
const WRITE_SH = `set -e
f=/root/README s=/var/lib/kw-readme
[ -d /root ] || exit 0
trap 'rm -f "$f.kw"' EXIT
cat > "$f.kw"
new=$(sha256sum < "$f.kw" | cut -c1-64)
old=$(cat "$s" 2>/dev/null || true)
if [ -e "$f" ] || [ -L "$f" ]; then
	[ -n "$old" ] && [ "$old" != "$new" ] || exit 0
	[ "$(sha256sum < "$f" | cut -c1-64)" = "$old" ] || exit 0
elif [ -n "$old" ]; then
	exit 0
fi
chmod 644 "$f.kw"
mv -f "$f.kw" "$f"
mkdir -p "\${s%/*}"
echo "$new" > "$s"
echo written`;

export async function writeReadme(vm: KernelHandle, log: (m: string) => void): Promise<void> {
	try {
		const r = await vm.exec("/bin/sh", ["-c", WRITE_SH], { input: TEXT });
		if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
		if (r.stdout.trim() === "written") log("[readme] wrote /root/README");
	} catch (e) {
		log(`[readme] /root/README skipped: ${(e as Error).message}`);
	}
}
