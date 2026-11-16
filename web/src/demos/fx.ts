// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// fx: the fx coding agent (fx.sh), its linux-x86_64 release binary
// (static) run under qemu-x86_64 on the riscv64 guest. Nothing from fx or
// qemu is in the page.
//
// The page fetches both (`downloads`, download.ts) and pushes them into the
// demo's directory, each skipped when the guest has it already:
// - the fx tarball from releases.fx.sh, which is https only but sends
//   Access-Control-Allow-Origin, so it is a direct fetch() (`cors`);
// - Alpine's riscv64 qemu-x86_64 package (community, no dependencies), the
//   one the guest's binfmt handler /etc/kw-qemu would install, over plain
//   http through Wisp.
// fx.sh checks both SHA-256s, extracts fx, and installs the package with
// apk (which checks its signature). A file the page could not get is
// downloaded in the guest instead. /usr/local/bin/fx then runs fx through
// qemu-x86_64 directly, not through binfmt: kw-qemu would also install an
// x86_64 library root on first use, which a static binary does not need.
// fx --version takes about 0.3 s this way (the aarch64 build under
// qemu-aarch64: about 0.35 s, and a larger qemu package; Node CLI,
// 2026-11-15).
import type { Demo } from "../launcher.ts";

const VER = "v0.0.17";
const FX_URL = `https://releases.fx.sh/${VER}/fx-linux-x86_64.tar.gz`;
const FX_SHA256 = "78c155d59fa59e42fd56d93037fd75041868c9c67865e8c7f0ca6dcdfac23e75";
const FX_SIZE = 4769247;

const QEMU_APK = "qemu-x86_64-11.0.3-r0.apk";
const QEMU_URL = `https://dl-cdn.alpinelinux.org/alpine/v3.24/community/riscv64/${QEMU_APK}`;
const QEMU_SHA256 = "ded1e2f79d574eee1c98a675c33a9553a5870992c1d5dbe6548d0ec0042e1ef9";
const QEMU_SIZE = 1544288;

const FX_SH = String.raw`#!/bin/sh
# fx ${VER} (linux-x86_64, static) under qemu-x86_64 on this riscv64 guest.
# Written by the unkernel launcher's fx demo.
set -e
D='\033[90m' N='\033[0m'
ok() { echo "$1  $2" | sha256sum -c >/dev/null 2>&1; }

if [ ! -x fx ]; then
	if [ ! -f fx.tar.gz ]; then
		printf "$D%s$N\n" "Fetching fx ${VER} from releases.fx.sh"
		wget -qO fx.tar.gz ${FX_URL}
	fi
	ok ${FX_SHA256} fx.tar.gz || { rm -f fx.tar.gz; echo "fx.sh: fx.tar.gz: SHA-256 mismatch" >&2; exit 1; }
	tar -xzf fx.tar.gz fx
	rm -f fx.tar.gz
fi

if [ ! -x /usr/bin/qemu-x86_64 ]; then
	if [ -f ${QEMU_APK} ] && ok ${QEMU_SHA256} ${QEMU_APK}; then
		apk add --force-non-repository ./${QEMU_APK}
	else
		/etc/kw-apk-enable   # qemu-x86_64 is in community
		apk add qemu-x86_64
	fi
fi
rm -f ${QEMU_APK}

printf '#!/bin/sh\nexec qemu-x86_64 %s "$@"\n' "$PWD/fx" > /usr/local/bin/fx
chmod 755 /usr/local/bin/fx
printf "$D%s$N\n" "fx ${VER} (x86_64) under qemu-x86_64 on riscv64." \
	"fx login signs in to a model provider; fx ask \"...\" runs one request. Ctrl-C quits."
`;

export default {
	id: "fx",
	title: "fx",
	desc: "The fx coding agent: its x86_64 Linux binary, run under qemu-user on the riscv64 guest",
	icon: "𝒇x",
	colors: ["#3f3f46", "#09090b"],
	needs: { net: true },
	files: { "fx.sh": { content: FX_SH, mode: 0o755 } },
	downloads: [
		{ url: FX_URL, sha256: FX_SHA256, size: FX_SIZE, path: "fx.tar.gz", cors: true, unless: "test -x fx" },
		{ url: QEMU_URL, sha256: QEMU_SHA256, size: QEMU_SIZE, path: QEMU_APK, unless: "test -x /usr/bin/qemu-x86_64" },
	],
	commands: ["./fx.sh", "fx"],
} satisfies Demo;
