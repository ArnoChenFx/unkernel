#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#
# Node, Bun and Claude Code timings (.agents/a64/performance.md, Measuring):
# each command RUNS times in a row (default 3), timed in the guest. Run it in
# Debian on the profile disk with test/ mounted; test/app-bench.mjs does that
# for several bundles and prints medians:
#   node js/cli.ts --distro debian --data vendor/build/profile/debian-node.img \
#     --snapshot --mem 1024 --no-net --mount test:/t --input '{8}sh /t/app-bench.sh\n'
# ASLR=0 turns address randomization off first (shared libraries and PIE
# programs then load at the same addresses in every process).
# Each run prints "RES name run ms rc=N" (run 1 is the first run of that
# binary's command in the boot), then "ALL-DONE".
runs=${RUNS:-3}
[ -n "$ASLR" ] && sudo sh -c "echo $ASLR > /proc/sys/kernel/randomize_va_space"
echo "ASLR $(cat /proc/sys/kernel/randomize_va_space)"
d=/tmp/app-bench
mkdir -p $d && cp /t/guest/app/cpu.js /t/guest/app/gen-ts.js $d/ && cd $d || exit 1
t() {
	n=$1; shift; i=1
	while [ $i -le $runs ]; do
		s=$(date +%s%N); "$@" >/dev/null 2>&1; rc=$?; e=$(date +%s%N)
		echo "RES $n $i $(( (e - s) / 1000000 )) rc=$rc"
		i=$((i + 1))
	done
}
t claude-help claude --help
t npm-version npm --version
t bun-cpu bun cpu.js ${BUN_CPU:-150}
t node-cpu node cpu.js ${NODE_CPU:-40}
t node-e0 node -e 0
t claude-version sh -c 'for i in 1 2 3 4 5; do claude --version; done'
node gen-ts.js $d/big.ts
t bun-build bun build big.ts --outfile out.js
# One pass over the three binaries again: what the others pushed out of the
# code cache shows here.
runs=1
t mixed sh -c 'claude --help; npm --version; bun cpu.js 50; claude --help; npm --version'
echo ALL-DONE
