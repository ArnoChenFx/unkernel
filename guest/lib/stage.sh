# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Sourced by the guest/ build scripts (bash, after env.sh): putting files
# into a staged root file system.
#
#   distro_unpack NAME VAR   the upstream tarball ($VAR_TARBALL, else the
#                            pinned $VAR_URL, fetched) extracted into
#                            $stage ($distro_out/NAME-root, image.sh), with
#                            /usr/lib/kw-distro (NAME)
#   install_tree SRC DEST    the files of the mirror tree SRC (initramfs/,
#                            rootfs/) into DEST at the same paths
#   install_common DEST      what every distro image has and the base's kw
#                            layer (RAM-resident) leaves out: the game and
#                            display self-test, /usr/bin/glimmer
#
# A mirror tree holds files at their installed path and name. Each starts
# with the repository's header (SPDX line, copyright, what the file is): a
# comment block (# or //) after an optional #! line, ended by an empty
# line; install_tree leaves that block and the empty line out, so the
# image has the file's text only. A file without comment syntax has its
# header in NAME.license next to it, which is not installed. Modes: 755
# for a file with the x bit, else 644; directories 755; symlinks as they
# are. Anything else is set by the build script.

# distro_unpack NAME VAR: sets $VAR_TARBALL and $stage. Owners, exact modes
# and hard links come from the tarball later (mktree.py), so the extraction
# needs no root; neither tarball has device nodes or xattrs.
distro_unpack() {
	local name=$1 t="$2_TARBALL" n="$2_TARBALL_NAME" u="$2_URL" s="$2_SHA256"
	if [ -z "${!t:-}" ]; then
		printf -v "$t" '%s' "$dl/${!n}"
		fetch_verified "${!u}" "${!t}" "${!s}"
	fi
	echo "$name: ${!t}"
	stage="$distro_out/$name-root"
	rm -rf "$stage"
	mkdir -p "$stage"
	tar -xzf "${!t}" -C "$stage" --no-same-owner
	chmod -R u+rwX "$stage"
	echo "$name" > "$stage/usr/lib/kw-distro"
}

# strip_header FILE: FILE without its header (see the top) on stdout; fails
# when FILE has none.
strip_header() {
	awk '
		NR == 1 && /^#!/ { print; next }
		state == 0 && /^(#|\/\/)( |$)/ { hdr = 1; next }
		state == 0 && hdr && /^$/ { state = 1; next }
		state == 0 { exit 1 }
		{ print }
		END { if (!state) exit 1 }' "$1"
}

# install_tree SRC DEST
install_tree() {
	local src=$1 dest=$2 f
	[ -d "$src" ] || { echo "install_tree: no $src" >&2; return 1; }
	while IFS= read -r -d '' f; do
		case $f in *.license) continue ;; esac
		mkdir -p "$dest/$(dirname "$f")"
		if [ -L "$src/$f" ]; then
			ln -sfn "$(readlink "$src/$f")" "$dest/$f"
		elif [ -e "$src/$f.license" ]; then
			cat "$src/$f" > "$dest/$f"
		else
			strip_header "$src/$f" > "$dest/$f" ||
				{ echo "install_tree: $src/$f has no header block (SPDX lines, then an empty line)" >&2; return 1; }
		fi
		[ -L "$src/$f" ] || if [ -x "$src/$f" ]; then chmod 755 "$dest/$f"; else chmod 644 "$dest/$f"; fi
	done < <(cd "$src" && find . \( -type f -o -type l \) -printf '%P\0' | sort -z)
}

# install_common DEST
install_common() {
	"${cc_guest[@]}" -o "$1/usr/bin/glimmer" "$guest/src/glimmer.c"
	chmod 755 "$1/usr/bin/glimmer"
}
