#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /usr/lib/kw-overlay/rebase UPPER BACKUP RECORD: after an image update,
# rebase the changes' apk state onto the new image. Run by
# /usr/lib/kw-overlay/root on the plain new root (so / is the new image),
# before the overlay is mounted. RECORD (/data/overlay/image) has "name
# version" lines (pkgs) and the world file of the image the changes were last
# used with; without it the old image is taken to be the new one.
#
# A copy of apk's database in the upper layer (written by the first apk add
# or del) hides the new image's, so without this apk would believe the old
# image's packages are installed while the files are the new image's. The
# result is what apk would have if the user's commands had been run on the
# new image:
#   - packages: the new image's database entries, minus image packages the
#     user removed (in the old image, not in the user's database), plus the
#     user's own: packages in the user's database that are not in the new
#     image, except old image packages the user never changed (their files
#     were in the old image and are gone now). Without RECORD such a package
#     is kept only if its first file is in the upper layer;
#   - files: for every package of the new image, its files in the upper
#     layer (an older or newer version the user had upgraded to, or a
#     whiteout) outside /etc are moved to BACKUP, so the image's version
#     shows; /etc stays as the user left it (apk's protected config);
#   - world: the new image's, minus what the user removed from the old
#     image's, plus what the user added;
#   - scripts.tar.gz and triggers: the new image's plus the user packages'.
# Nothing is deleted: moved files keep their paths under BACKUP. Running it
# again (say, after an interruption) gives the same result.
U=$1 B=$2 R=$3
D=lib/apk/db
t=/run/kw-rebase
rm -rf $t && mkdir -p $t
say() { echo "  $*"; }

if [ -f $U/$D/installed ]; then
	# (Each input starts with a line, so FNR == 1 counts the files.)
	echo "#" > $t/oldimg
	if [ -s $R/pkgs ]; then cat $R/pkgs >> $t/oldimg; rec=1; else rec=; fi
	# Pass 1: "removed NAME", "user NAME", or "check NAME FIRST-FILE" (no record).
	awk -v rec="$rec" '
		FNR == 1 { f++ }
		f == 1 { if ($1 != "#") oi[$1] = $2; next }
		f == 2 { if (/^P:/) n[substr($0, 3)] = 1; next }
		/^P:/ { p = substr($0, 3); o[p] = 1 }
		/^V:/ { v[p] = substr($0, 3) }
		/^F:/ { d = substr($0, 3) }
		/^R:/ && !(p in f1) { f1[p] = (d == "" ? "" : d "/") substr($0, 3) }
		END {
			for (p in oi) if (!(p in o)) print "removed", p
			for (p in o) {
				if (p in n) continue
				if (rec) { if (!(p in oi) || oi[p] != v[p]) print "user", p }
				else if (p in f1) print "check", p, f1[p]
				else print "user", p
			}
		}
	' $t/oldimg /$D/installed $U/$D/installed > $t/pass1
	echo "# lists" > $t/lists
	while read -r k p f; do
		case $k in
		removed|user) echo "$k $p" >> $t/lists ;;
		check) { [ -e "$U/$f" ] || [ -L "$U/$f" ]; } && echo "user $p" >> $t/lists ;;
		esac
	done < $t/pass1
	# Pass 2: the merged database and the lists that go with it.
	awk -v t=$t '
		FNR == 1 { f++ }
		f == 1 { if ($1 == "removed") rm[$2] = 1; else if ($1 == "user") us[$2] = 1; next }
		{
			name = ver = chk = d = files = ""
			for (i = 1; i <= NF; i++) {
				k = substr($i, 1, 2); x = substr($i, 3)
				if (k == "P:") name = x
				else if (k == "V:") ver = x
				else if (k == "C:") chk = x
				else if (k == "F:") d = x
				else if (k == "R:") files = files (d == "" ? "" : d "/") x "\n"
			}
		}
		f == 2 {
			nv[name] = ver
			if (name in rm) { print name "-" ver "." > (t "/dropscripts"); print name > (t "/removed"); next }
			printf "%s\n\n", $0 > (t "/installed"); print chk > (t "/checks")
			nf[name] = files; next
		}
		f == 3 {
			if (name in us) {
				printf "%s\n\n", $0 > (t "/installed"); print chk > (t "/checks")
				print name "-" ver "." > (t "/userscripts"); print name, ver > (t "/user")
			} else if (name in nv) {
				if (nv[name] != ver) print name, ver, nv[name] > (t "/changed")
				of[name] = files
			}
		}
		END {
			for (p in nv) if (!(p in rm)) {
				c = split(nf[p] of[p], L, "\n")
				for (j = 1; j <= c; j++) if (L[j] != "" && L[j] !~ /^etc\//) mv[L[j]] = 1
			}
			for (x in mv) print x > (t "/move")
		}
	' $t/lists RS= FS='\n' /$D/installed $U/$D/installed

	# Files of the new image's packages: the image's version wins.
	moved=0
	[ -f $t/move ] && while IFS= read -r p; do
		[ -e "$U/$p" ] || [ -L "$U/$p" ] || continue
		[ -d "$U/$p" ] && [ ! -L "$U/$p" ] && continue
		mkdir -p "$B/${p%/*}" && mv "$U/$p" "$B/$p" && moved=$((moved + 1))
	done < $t/move

	# scripts.tar.gz: the image's, minus removed packages', plus the user's.
	mkdir -p $t/s $t/so
	tar -xzf /$D/scripts.tar.gz -C $t/s 2>/dev/null
	[ -f $U/$D/scripts.tar.gz ] && tar -xzf $U/$D/scripts.tar.gz -C $t/so 2>/dev/null
	[ -f $t/dropscripts ] && while read -r pre; do rm -f $t/s/"$pre"*; done < $t/dropscripts
	[ -f $t/userscripts ] && while read -r pre; do cp $t/so/"$pre"* $t/s/ 2>/dev/null; done < $t/userscripts
	(cd $t/s && ls | tar -czf $t/scripts.tar.gz -T - 2>/dev/null) || cp /$D/scripts.tar.gz $t/scripts.tar.gz
	# triggers: lines for the packages kept (by package checksum).
	cat /$D/triggers $U/$D/triggers 2>/dev/null | awk 'NR == FNR { k[$1] = 1; next } ($1 in k) && !seen[$0]++' $t/checks - > $t/triggers

	for f in installed scripts.tar.gz triggers; do
		cp $t/$f $U/$D/$f.kw-new && mv $U/$D/$f.kw-new $U/$D/$f
	done

	say "apk's database is now the new image's, plus your packages:"
	[ -s $t/user ] && say "  kept: $(awk '{ printf "%s%s", s, $1; s = " " }' $t/user)"
	[ -s $t/user ] || say "  (no packages of your own)"
	[ -f $t/changed ] && say "  now the image's version: $(awk '{ printf "%s%s %s -> %s", s, $1, $2, $3; s = ", " }' $t/changed)"
	[ -f $t/removed ] && say "  still removed, as you left them: $(tr '\n' ' ' < $t/removed)"
	[ $moved -gt 0 ] && say "  $moved files of image packages moved out of your changes to $B"
fi

# world (the upper may have one without a database, after a cut-off apk run).
if [ -f $U/etc/apk/world ]; then
	oiw=$R/world
	[ -s $oiw ] || oiw=/etc/apk/world
	awk '
		FNR == 1 { f++ }
		f == 1 { oi[$0] = 1; next }
		f == 2 { o[$0] = 1; next }
		{ n[$0] = 1 }
		END {
			for (x in oi) if (!(x in o)) delete n[x]
			for (x in o) if (!(x in oi)) n[x] = 1
			for (x in n) if (x != "") print x
		}
	' $oiw $U/etc/apk/world /etc/apk/world | sort > $t/world
	cp $t/world $U/etc/apk/world.kw-new && mv $U/etc/apk/world.kw-new $U/etc/apk/world
	say "world: $(tr '\n' ' ' < $t/world)"
fi
rm -rf $t
exit 0
