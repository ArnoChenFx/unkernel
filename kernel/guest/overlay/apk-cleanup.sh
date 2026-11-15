#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /usr/lib/kw-overlay/apk-cleanup UPPER: clean up after an apk run that was
# cut off (the tab closed, a reload, a crash). Run by /usr/lib/kw-overlay/root
# before the overlay is mounted (changing the upper layer is safe then),
# only when the marker exists, so a normal boot pays nothing.
#
# The marker, lib/apk/db/kw-commit, is created by apk's pre-commit hook
# (/etc/apk/commit_hooks.d/kw-overlay.hook) and removed by its post-commit
# hook. apk 3 unpacks each file as a .apk.<hash> temporary, renames each
# package's files into place once it is unpacked, and writes its database
# (lib/apk/db/installed) only at the end, so a run cut off in the middle
# leaves temporaries plus whole packages that no database entry owns.
# Removed: every .apk.<hash> file, and every file or symlink that no package
# in the database owns and whose inode changed after the marker was made
# (unpacked files keep the package's mtime, so the ctime tells), outside
# /root, /home, /tmp, /var/tmp, /run and /data; then directories made after
# the marker that are empty and unowned. The list goes to
# /data/overlay/apk-cleanup.log.
U=$1
m=$U/lib/apk/db/kw-commit
[ -e "$m" ] || exit 0
since=$(stat -c %Z "$m")
db=$U/lib/apk/db/installed
[ -f "$db" ] || db=/lib/apk/db/installed
log=/data/overlay/apk-cleanup.log
t=/run/kw-apk-cleanup
rm -rf $t && mkdir -p $t
cd "$U" || exit 0
# Owned paths: "F path" for directories, "R path" for files.
awk -F: '/^F:/ { d = $2; print "F " d } /^R:/ { print "R " (d == "" ? "" : d "/") $2 }' "$db" > $t/owned
skip() { find . \( -path ./root -o -path ./home -o -path ./tmp -o -path ./var/tmp -o -path ./run -o -path ./data \) -prune -o "$@"; }
skip \( -type f -o -type l \) -exec stat -c '%Z %s %n' {} + > $t/files 2>/dev/null
skip -type d -exec stat -c '%Z %n' {} + > $t/dirs 2>/dev/null
awk -v since="$since" -v count=$t/count '
	FILENAME ~ /owned$/ { if ($1 == "R") own[substr($0, 3)] = 1; next }
	{
		p = $0; sub(/^[^ ]+ [^ ]+ \.\//, "", p)
		n = p; sub(/.*\//, "", n)
		if (n ~ /^\.apk\.[0-9a-f]+$/ || ($1 >= since && !(p in own))) { print p; bytes += $2; c++ }
	}
	END { print c + 0, bytes + 0 > count }
' $t/owned $t/files > $t/remove
# Deepest first, so a directory is empty by the time it is tried.
awk -v since="$since" '
	FILENAME ~ /owned$/ { if ($1 == "F") own[substr($0, 3)] = 1; next }
	{ p = $0; sub(/^[^ ]+ \.\/?/, "", p); if ($1 >= since && p != "" && !(p in own)) print gsub("/", "/"), p }
' $t/owned $t/dirs | sort -rn | cut -d' ' -f2- > $t/rmdir
date "+== %Y-%m-%d %H:%M:%S: an apk run was cut off; removed:" >> $log
while IFS= read -r f; do rm -f "./$f" && echo "$f" >> $log; done < $t/remove
while IFS= read -r d; do rmdir "./$d" 2>/dev/null && echo "$d/" >> $log; done < $t/rmdir
rm -f "$m"
read -r c bytes < $t/count
rm -rf $t
echo "kw-overlay: an apk run was cut off: removed $c files ($((bytes / 1024)) KiB) that it had unpacked but not registered (list: $log); run that apk command again"
