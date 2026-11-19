#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa
#
# The apk and shell bench that .agents/a64.md and guest-packages.md quote:
# 20 commands, each timed in the guest from /proc/uptime (10 ms steps).
# Run it inside the guest (a network for apk; it installs jq, git and
# python3), e.g. with the directory mounted:
#   node js/cli.ts --mount test:/t --timeout 600 --input '{8}sh /t/guest-bench.sh\n'
# Each command prints "RES name seconds rc=N", then "ALL-DONE". Compare
# builds with boots interleaved and medians (kwemu.md, Numbers).
t() { n=$1; shift; read s _ </proc/uptime; "$@" >/dev/null 2>&1; rc=$?; read e _ </proc/uptime; echo "RES $n $(awk "BEGIN{printf \"%.2f\", $e-$s}") rc=$rc"; }
t apk-version apk --version
t apk-update apk update
t apk-update2 apk update
t apk-search-one apk search -q busybox
t apk-search-all apk search
t apk-search-desc apk search -d compiler
t apk-info apk info -v
t apk-sim-git apk add --simulate git
t apk-sim-big apk add --simulate gcc g++ python3 nodejs
t apk-add-jq apk add jq
t apk-del-jq apk del jq
t apk-add-git apk add git
t apk-add-python apk add python3
t py-hello python3 -c 'print(sum(i*i for i in range(200000)))'
t git-version git --version
t ash-loop sh -c 'i=0; while [ $i -lt 30000 ]; do i=$((i+1)); done'
t sort sh -c 'seq 100000 | sort -r'
t gzip sh -c 'seq 250000 | gzip | gunzip'
t sha256 sh -c 'head -c 8000000 /dev/zero | sha256sum'
t find sh -c 'find / -xdev | wc -l'
echo ALL-DONE
