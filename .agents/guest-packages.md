# Rebuilt guest packages

The aarch64 image ships the minirootfs packages as Alpine builds them.
`kernel/guest/alpine-opt.sh` can rebuild four that sit on the guest's hot
paths for kwemu's CPU, but on aarch64 it is off unless `KW_ALPINE_OPT=1`:

- Its gains (the tables below) were measured on the riscv64 guest with
  kwemu's JIT, where `-O2` with Zba/Zbb/Zbs/Zicond code and lld's layout
  shortened what the JIT ran. The A64 kwemu is an interpreter so far, and
  nothing has been measured on it.
- Alpine's aarch64 builds run as they are: their code is ARMv8.0 (gcc's
  default `-march=armv8-a`), and the instructions beyond it (LSE atomics
  through gcc's outline atomics, SVE, SHA3/SHA512 in libcrypto) are
  chosen at run time from AT_HWCAP, which never lists them (a64.md, The
  image). A rebuild would not avoid the one gap either: the AdvSIMD FP
  conversions (`fcvtzs d, d` and kin) are plain gcc code for any
  `-march`.
- The script is ported to aarch64 (Bootlin's aarch64 musl gcc, the
  aarch64 sysroot apks, `-O2 -march=armv8-a`, openssl `linux-aarch64`,
  meson `cpu_family = 'aarch64'`) with the same aports pins, so it can be
  turned on once the A64 kwemu has a JIT to tune for. Not built end to end
  on aarch64 yet (2026-11-17): the toolchain and the sysroot apks were
  fetched and checked (musl's apk holds the minirootfs's loader byte for
  byte; a test program against the utmps headers compiled, linked with
  lld and ran under qemu-aarch64), the four packages were not compiled.

| aports package | files replaced in the image |
| --- | --- |
| busybox | `/bin/busybox` |
| zlib | `/usr/lib/libz.so.1.3.2` |
| openssl | `/usr/lib/libcrypto.so.3`, `/usr/lib/libssl.so.3` |
| apk-tools | `/usr/lib/libapk.so.3.0.0`, `/sbin/apk` |

musl stays Alpine's, and so does everything else, including ssl_client and
scanelf.

## How it is built

- **Same input as Alpine.** For each package the script pins the aports
  commit recorded in the image's apk database (the `c:` field of
  `/lib/apk/db/installed`) and the APKBUILD's SHA-256. It checks every
  source and patch against the APKBUILD's sha512sums, and applies the
  patches in the APKBUILD's order. aports files come from its GitHub
  mirror at the same commit. Upstream sources fall back to Alpine's
  distfiles mirror, as abuild does. Configuration as the APKBUILD's:
  - busybox: `busyboxconfig`, with utmps linked statically;
  - openssl: Configure options, with threads on as in the native build;
  - apk-tools: abuild-meson's options and the APKBUILD's, without the lua
    and python modules and the man pages, which the image does not have.
- **The compiler.** gcc 16.2 from Bootlin's aarch64 musl toolchain
  (`vendor/toolchain-gcc/`). It builds against a sysroot of Alpine's own
  aarch64 packages (`musl-dev`, `linux-headers`, the utmps and skalibs
  static libs, and the musl runtime). musl-dev is the same version as the
  image's musl, so the binaries link to the image's
  `libc.musl-aarch64.so.1`.
- **The flags.** Alpine uses gcc 15 at `-Os`; busybox's own
  Makefile.flags adds `-Oz`, `-finline-limit=0` and
  `-fno-guess-branch-probability`. The rebuild uses `-O2 -march=armv8-a`
  and drops those busybox lines. (The riscv64 rebuild used
  `-O2 -march=rv64gc_zba_zbb_zbs_zicond`, and built openssl's
  `crypto/sha/sha256.c` at `-Os`, below; on aarch64 OpenSSL's SHA-256 is
  assembly, so that exception is gone.)
- **The linker.** lld (zig's `ld.lld`, through `-fuse-ld=lld -B`), not
  GNU ld, with `-z pack-relative-relocs` (RELR; musl supports it) and
  `--undefined-version`. busybox is not PIE. apk is PIE (gcc's default
  and abuild-meson's `b_pie`, as in Alpine); all measurements below used
  this PIE apk.
- **Stripping** as abuild does: libraries `--strip-unneeded`, programs
  fully.
- **Reproducible.** `SOURCE_DATE_EPOCH` is fixed, so busybox's and
  openssl's embedded build times do not change, and openssl's recorded
  compiler command (`openssl version -a`) names the wrapper `cc-openssl`,
  not a host path. Two clean builds gave byte-identical image files
  (2026-11-16), so a rebuild keeps the image id the overlay root keys on.
- **Into the images.** `alpine.sh` and `alpine-disk.sh` call
  `alpine-opt.sh --install "$stage"` after unpacking the minirootfs. That
  builds first when `vendor/build/alpine-opt/.stamp` is stale (it records
  the script's hash and `ALPINE_VERSION`). A full build takes about 75 s
  on 16 cores (riscv64, 2026-11-16). Without `KW_ALPINE_OPT=1` it does
  nothing (the aarch64 default). Building needs an x86_64 host (Bootlin's
  gcc). A stage
  from an `ALPINE_TARBALL` override with other package versions (e.g. the
  second image for `test/overlay-node.mjs --image2`) keeps Alpine's builds,
  with a warning.
- **`build.sh all` does not see the script.** Its check of whether the
  disk image is current does not list `alpine-opt.sh`, because changing
  `kernel/build.sh` would invalidate the CI caches. After changing the
  script, run `kernel/build.sh disk`. Plain `alpine-opt.sh` rebuilds everything; with package
  names it rebuilds only those.
- **Host tools:** meson, ninja, pkg-config, patch, lua 5.x (apk's help
  text), and perl with FindBin, IPC::Cmd and File::Compare (openssl's
  Configure). busybox's host tools build with `zig cc`. `setup.sh
  --check` checks them.
- **CI.** The release workflow installs those tools with apt in its host
  tools step. It caches what `--install` reads on a hit (`root/`,
  `.stamp`, the APKBUILDs; about 9 MB), under the key
  `alpine-opt-<hash of alpine-opt.sh and env.sh>`, exact match only. On a
  miss the rebuild adds about 4 minutes on a 4-core runner (233 s,
  riscv64, 2026-11-16). The workflow does not set `KW_ALPINE_OPT=1`, so
  on aarch64 nothing is built and that cache stays empty.
- **Keep the other caches.** The existing cache keys hash
  `kernel/build.sh` and `kernel/tools/env.sh`, and a kernel cache miss
  costs about an hour. So the rebuild is not a `build.sh` step. Before
  "Save downloads", the workflow deletes the rebuild's downloads except
  the APKBUILDs, so they stay out of that cache.
- **The apk database is unchanged.** It keeps Alpine's file checksums,
  so `apk audit` lists the six files. Upgrading one of these packages
  installs Alpine's build again, which is correct but slower. The overlay
  root's database rebase (data-disk.md) goes by package checksum, so the
  swapped files do not affect it.

## Alpine updates

`--install` compares the stage's apk database with the versions it built
(`pkgver-rpkgrel` from the pinned APKBUILDs). On a mismatch it stops with
"update kernel/guest/alpine-opt.sh". After bumping `ALPINE_VERSION`:

1. Take each package's new `c:` commit from the new image's apk database.
2. Update `commit`, `apkbuild_sha256` and the sysroot apks (versions and
   SHA-256) in the script.
3. Check that the APKBUILD's configure options still match the script's.

## Measurements (riscv64 guest)

These and the next section are the riscv64 rebuild's numbers, kept as
the rationale for the script; "B" is Zba/Zbb/Zbs. Nothing has been
measured on aarch64.

All 2026-11-16, Node CLI, JIT on. The guest timed itself with
`/proc/uptime` (10 ms steps). Medians in ms. Boots interleaved the
variants, rotating their order. Outputs were identical to stock's
throughout.

**busybox** (3 boots × 2 rounds; ash and exec: 2 boots × 4 rounds). The
commands are kwemu.md's "Alpine, timed in the guest" set.

| command | stock | gcc -O2 + B, GNU ld | clang -O2 + B | **gcc -O2 + B, lld** |
| --- | ---: | ---: | ---: | ---: |
| ash loop, 30000 iterations | 2130 | 1760 | 1930 | **1655** (-20%) |
| 200 × fork + exec | 340 | 360 | 245 | **250** (-24%) |
| `awk` sqrt loop | 2635 | 2050 | 2085 | -22% |
| `seq 100000 \| awk` | 3050 | 2675 | 2805 | -12% |
| `md5sum` busybox × 8 | 145 | 115 | 95 | -21% |
| `tar \| gzip -6 \| md5sum` | 405 | 265 | 260 | -35% |
| `seq 30000 \| sort -rn` | 2720 | 2625 | 2685 | -3% |
| `yes \| head -c 20M \| md5sum` | 3440 | 3335 | 3935 | -3% |

**Libraries** (3 boots × 3 rounds). Each variant swaps one library in, by
`LD_LIBRARY_PATH`, over the stock image; "all" swaps in zlib, openssl
and apk-tools.

| command | stock | zlib | openssl | libapk | all |
| --- | ---: | ---: | ---: | ---: | ---: |
| `apk search`, main + community indexes | 3000 | 2930 | 2870 | 2720 | 2680 (-11%) |
| `apk search`, main only | 750 | 760 | 750 | 690 | 720 |
| 30 × `apk --version` (startup) | 1300 | 1290 | 1230 | 1290 | 1100 (-15%) |
| 30 × `openssl version` (startup) | 910 | 900 | 820 | 910 | 840 (-8%) |
| `openssl dgst -sha1`, 16 MB | 270 | | 210 | | -22% |
| `openssl dgst -sha512`, 16 MB | 300 | | 210 | | -30% |
| `openssl enc -chacha20`, 16 MB | 590 | | 460 | | -22% |
| `openssl enc -aes-128-ctr`, 16 MB | 550 | | 540 | | flat (assembly) |
| `openssl dgst -sha256`, 16 MB | 480 | | 455 with sha256.c at -Os | | -5% |

The image has no `openssl` command. The benchmark used the rebuild's,
against both libcrypto builds.

## What did not help, or was worse (riscv64 guest)

- **GNU ld.** Its output has one R+X segment holding code and read-only
  data. That makes each exec about 0.5 ms slower under kwemu: 200 execs
  took 360 ms against 250 ms with lld, for the same gcc code. Every stock
  Alpine binary is linked this way (status.md, Open issues).
- **clang (zig cc) -O2.** Slower than gcc on most commands, and 9-14% slower
  than stock on `yes | head | md5sum` (two runs).
- **openssl `sha256.c` at -O2.** 500 ms against 455 ms at -Os (stock:
  480). The two builds are about the same size and both unrolled, so the
  cause is not known.
- **`-Os` for `sha1dgst.c` and `sha512.c`.** Slower than -O2 (sha1 230
  against 200 ms).
- **musl rebuilt the same way.** No consistent gain: startup was slightly
  faster, and apk with both indexes was 3% slower than with Alpine's musl.
  musl's string functions are byte-wise C, which flags do not change.

## Traps

- **gitlab.alpinelinux.org from GitHub-hosted runners.** It answers raw
  file requests with HTTP 418 (it works from other hosts), hence the
  GitHub mirror of aports.
- **Bootlin's gcc and Alpine's sysroot.** Pass `--sysroot` explicitly;
  Bootlin's wrapper then skips its own.
- **zlib's configure.** Under lld it decides "No shared library support"
  unless `--undefined-version` is set (its version-script test). The
  script fails if `libz.so.1` is missing.
- **busybox's host tools.** make exports `CC` (the cross compiler), and
  zig cc finds the host's libc by running `$CC`, so the host-cc wrapper
  unsets it.
- **busybox with clang.** clang reads the `extern T *const
  ptr_to_globals` pointers before the store that sets them, and awk
  segfaults at once. `-DBB_GLOBAL_CONST=` is busybox's documented fix.
  gcc keeps the trick.
- **Rebuilding one openssl object.** Do it through make (a CC wrapper
  that appends flags), not by hand: make otherwise recompiles the object
  with its own flags. The shared library links `libcrypto-shlib-*.o`,
  not `libcrypto-lib-*.o`.

## Measuring a change

Rebuild, then boot the bundle with
`--mount <dir>:/mnt/x:ro --input '{10}sh /mnt/x/bench.sh ...; poweroff\n'`.

- **Binaries:** copy them into `/tmp` in the guest first. Run them
  directly (`$B awk ...`) and time them with `/proc/uptime`; busybox's
  `date` has no `%N`.
- **Libraries:** point `LD_LIBRARY_PATH` at a directory holding only the
  library under test.
- **musl:** run its loader as a command
  (`ld-musl-aarch64.so.1 --library-path DIR PROG`).
- **Noise:** interleave the variants within a boot, rotate their order
  across boots, and compare medians. Boot-to-boot noise is several
  percent (kwemu.md).
