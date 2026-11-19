// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa
// Stand-ins for fx, claude and opencode in ~/.local/bin, written by the page
// through vm.exec() once user space runs (boot.ts passes the texts: kw-shim.sh
// and guest/base/rootfs/etc/profile.d/kw-path.sh). A stand-in (kw-shim.sh, described at its top)
// installs the real program on its first call, in its place, so later calls
// start the program directly. No Vite imports here: test/api.test.ts runs
// this file's shell text through the SDK.
//
// - A stand-in is written when ~/.local/bin/NAME is missing, and replaced only
//   by a newer stand-in (its second line, "# kw-shim N", has a smaller N). A
//   real program there (a file that is not a script, or a symlink) is never
//   touched, and one the user deleted comes back as a stand-in at the next
//   start.
// - Each write holds the stand-in's own lock (/tmp/.kw-shim-NAME.lock), so it
//   cannot replace a program that a first call installs at the same moment.
// - ~/.local/bin must be on PATH: Alpine's /etc/profile sets a fixed one, and
//   the base's kw layer adds it in /etc/profile.d/kw-path.sh
//   (guest/base/rootfs/etc/profile.d/kw-path.sh). The page writes that file
//   too when it is missing (a root whose changes hide the layer's copy); the
//   console's shell, started before this runs, then lacks it on that boot.
// - On the overlay root these land in the upper layer, so this happens once
//   per data disk (and for a newer stand-in); with ?data=0 (or in safe mode)
//   once per boot.
// - Failures are logged and otherwise ignored.

import type { KernelHandle } from "../../js/core/instance.ts";

export const SHIM_TOOLS = ["fx", "claude", "opencode"] as const;

/** The texts to write: the stand-in (kw-shim.sh, @TOOL@ for the name) and /etc/profile.d/kw-path.sh. */
export interface ShimTexts {
	shim: string;
	pathSh: string;
}

/**
 * $1 = the stand-in's version, $2 = the profile.d text, then the tool names;
 * stdin is the stand-in (@TOOL@ for the name). Prints each file it wrote.
 */
export const WRITE_SHIMS_SH = `set -e
v=$1 p=$2; shift 2
[ "\${HOME:-/}" != / ] || HOME=/root
b=$HOME/.local/bin
t=$(mktemp)
trap 'rm -f "$t" "$b"/.*.kw-new' EXIT
cat > "$t"
# ver FILE: FILE's kw-shim version, or nothing (not a stand-in).
ver() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(head -c 2 "$1")" = '#!' ] && head -n 2 "$1" | sed -n '2s/^# kw-shim \\([0-9][0-9]*\\)$/\\1/p'; }
mkdir -p "$b"
for n; do
	exec 9>"/tmp/.kw-shim-$n.lock"
	flock 9
	f=$b/$n
	if [ -e "$f" ] || [ -L "$f" ]; then
		i=$(ver "$f" || true)
		if [ -z "$i" ] || [ "$i" -ge "$v" ]; then exec 9>&-; continue; fi
	fi
	sed "s/@TOOL@/$n/g" "$t" > "$b/.$n.kw-new"
	chmod 755 "$b/.$n.kw-new"
	mv -f "$b/.$n.kw-new" "$f"
	exec 9>&-
	echo "$f"
done
f=/etc/profile.d/kw-path.sh
if [ ! -e "$f" ]; then
	printf '%s' "$p" > "$f.kw-new"
	mv -f "$f.kw-new" "$f"
	echo "$f"
fi`;

/** The arguments (for /bin/sh) and input of the vm.exec() that writes the stand-ins. */
export function shimsExec({ shim, pathSh }: ShimTexts): { args: string[]; input: string } {
	const version = Number(/^# kw-shim (\d+)$/m.exec(shim)?.[1]);
	if (!(version > 0)) throw new Error("kw-shim.sh has no \"# kw-shim N\" line");
	return { args: ["-c", WRITE_SHIMS_SH, "sh", String(version), pathSh, ...SHIM_TOOLS], input: shim };
}

export async function writeShims(vm: KernelHandle, texts: ShimTexts, log: (m: string) => void): Promise<void> {
	try {
		const { args, input } = shimsExec(texts);
		const r = await vm.exec("/bin/sh", args, { input });
		if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
		const wrote = r.stdout.trim().split("\n").filter(Boolean);
		if (wrote.length) log(`[shims] wrote ${wrote.join(", ")}`);
	} catch (e) {
		log(`[shims] skipped: ${(e as Error).message}`);
	}
}
