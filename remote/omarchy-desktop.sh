#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 ARNO <arnochen101@gmail.com>
# The Omarchy desktop as a page of its own: start-omarchy.sh --desktop.
exec sh "$(dirname "$0")/start-omarchy.sh" --desktop "$@"
