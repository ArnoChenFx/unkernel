# Rebuilt guest packages

The Alpine image ships the minirootfs packages as Alpine builds them,
except four that sit on the guest's hot paths, which
`kernel/guest/alpine-opt.sh` rebuilds for kwemu's CPU:

| aports package | files replaced in the image |
| --- | --- |
| busybox | `/bin/busybox` |
| zlib | `/usr/lib/libz.so.1.3.2` |
| openssl | `/usr/lib/libcrypto.so.3`, `/usr/lib/libssl.so.3` |
| apk-tools | `/usr/lib/libapk.so.3.0.0`, `/sbin/apk` |

musl stays Alpine's, and so does everything else, including ssl_client and
scanelf.

What the rebuild avoids: kwemu's JIT compiles integer, load/store and
branch instructions, and hands every FP, AdvSIMD, crypto, exclusive and
system instruction back to the interpreter as a `generic` op; a compiled
block runs only up to its first one (a64.md, JIT). Alpine's `-Os` code is
almost free of them, but gcc's `-O2` is not (the vectorizer, FP registers
as spill space, scalar AdvSIMD idioms such as `uqsub`), and libcrypto
picks its NEON and crypto-extension code from AT_HWCAP, which kwemu
advertises.

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
  `-fno-guess-branch-probability`. The rebuild uses
  `-O2 -march=armv8-a -fno-tree-vectorize` and drops those busybox lines.
  Every C file that allows it is compiled with `-mgeneral-regs-only` too:
  the `cc` wrapper tries that first and compiles again without it when it
  fails, which is what a file with float types does (awk, printf, seq,
  sleep and the like). Of busybox's 518 objects 29 use FP or AdvSIMD
  registers at all, of libcrypto's 782 C objects 12, of apk-tools' 69 six,
  of zlib's 19 one.
  gcc's outline atomics stay (`-moutline-atomics`, the default: on musl
  they always take the exclusive path, a64.md, The image).
- **Variadic functions keep their FP registers.** A variadic function
  compiled with `-mgeneral-regs-only` does not save the FP argument
  registers in its prologue, so a `double` passed to it reads as garbage
  (busybox `awk 'BEGIN{printf "%.2f", 1.25}'` printed `0.00` through
  libbb's formatting helpers). The wrapper force-includes `kw-gro.h`
  on the first attempt, whose `va_start` uses an FP register operand; a
  file that defines a variadic function then fails that attempt and is
  built without `-mgeneral-regs-only` (busybox's `ash.c` among them).
- **libcrypto runs its integer code.** A patch in the script makes
  `OPENSSL_cpuid_setup` return with no capabilities unless the
  `OPENSSL_armcap` environment variable sets them (as upstream): no NEON,
  AES, PMULL, SHA-1, SHA-256 or SHA-3 code, so AES is `aes_core.c`, GHASH
  the 4-bit table code, SHA and ChaCha20/Poly1305 the scalar assembly.
  Under kwemu that is faster for every algorithm (Measurements).
- **The linker.** lld (zig's `ld.lld`, through `-fuse-ld=lld -B`), not
  GNU ld, with `-z pack-relative-relocs` (RELR; musl supports it) and
  `--undefined-version`. busybox is not PIE. apk is PIE (gcc's default
  and abuild-meson's `b_pie`, as in Alpine).
- **Stripping** as abuild does: libraries `--strip-unneeded`, programs
  fully.
- **Reproducible.** `SOURCE_DATE_EPOCH` is fixed, so busybox's and
  openssl's embedded build times do not change, and openssl's recorded
  compiler command (`openssl version -a`) names the wrapper `cc-openssl`,
  not a host path. Two clean builds gave byte-identical image files
  (2026-11-18), so a rebuild keeps the image id the overlay root keys on.
- **Into the images.** `alpine.sh` and `alpine-disk.sh` call
  `alpine-opt.sh --install "$stage"` after unpacking the minirootfs. That
  builds first when `vendor/build/alpine-opt/.stamp` is stale (it records
  the script's hash and `ALPINE_VERSION`). A full build takes about 80 s
  on 16 cores (2026-11-18). Building needs an x86_64 host (Bootlin's gcc);
  elsewhere, or to keep Alpine's builds, set `KW_ALPINE_OPT=0`. A stage
  from an `ALPINE_TARBALL` override with other package versions (e.g. the
  second image for `test/overlay-node.mjs --image2`) keeps Alpine's builds,
  with a warning.
- **Size.** The image grows by about 570 KiB (busybox 995 KiB against
  919 KiB, libcrypto 4.9 MiB against 4.4 MiB), the gzipped initramfs
  in the bundle by 0.3 MiB; initramfs pages stay resident.
- **`build.sh all` does not see the script.** Its check of whether the
  disk image is current does not list `alpine-opt.sh`, because changing
  `kernel/build.sh` would invalidate the CI caches. After changing the
  script, run `kernel/build.sh disk`. Plain `alpine-opt.sh` rebuilds
  everything; with package names it rebuilds only those.
- **Host tools:** meson, ninja, pkg-config, patch, lua 5.x (apk's help
  text), and perl with FindBin, IPC::Cmd and File::Compare (openssl's
  Configure). busybox's host tools build with `zig cc`. `setup.sh
  --check` checks them.
- **CI.** The release workflow installs those tools with apt in its host
  tools step. It caches what `--install` reads on a hit (`root/`,
  `.stamp`, the APKBUILDs; about 9 MB), under the key
  `alpine-opt-<hash of alpine-opt.sh and env.sh>`, exact match only. On a
  miss the rebuild adds a few minutes (riscv64's took 233 s on a 4-core
  runner, 2026-11-16).
- **Keep the other caches.** The existing cache keys hash
  `kernel/build.sh` and `kernel/tools/env.sh`, and a kernel cache miss
  costs about an hour. So the rebuild is not a `build.sh` step. Before
  "Save downloads", the workflow deletes the rebuild's downloads except
  the APKBUILDs, so they stay out of that cache.
- **The apk database is unchanged.** It keeps Alpine's file checksums,
  so `apk audit` lists the six files. Upgrading one of these packages
  installs Alpine's build again, which is correct but slower (2026-11-18,
  on a data disk: `apk upgrade` replaced the rebuilt zlib 1.3.2-r1 with
  Alpine's 1.4-r0 in the overlay's upper layer, and `apk audit` then
  listed the other five). The overlay root's database rebase (data-disk.md)
  goes by package checksum, so the swapped files do not affect it.

## Alpine updates

`--install` compares the stage's apk database with the versions it built
(`pkgver-rpkgrel` from the pinned APKBUILDs). On a mismatch it stops with
"update kernel/guest/alpine-opt.sh". After bumping `ALPINE_VERSION`:

1. Take each package's new `c:` commit from the new image's apk database.
2. Update `commit`, `apkbuild_sha256` and the sysroot apks (versions and
   SHA-256) in the script.
3. Check that the APKBUILD's configure options still match the script's,
   and that the armcap patch still applies (the script stops if not).

## Measurements

All 2026-11-18, i7-10700K, Node CLI, UP kernel with the JIT. The guest
timed itself with `/proc/uptime` (10 ms steps). Boots interleaved the
variants, rotating their order; medians.

**The image** (5 boots per image, interleaved; guest seconds, timed by
`/proc/uptime`; each command once per boot, in this order, network on,
apk's cache off; a busybox testsuite boot ran alongside). riscv64 is main's
image (its own rebuilt packages, its JIT), for reference.

| command | riscv64 | aarch64, Alpine's builds | **aarch64, rebuilt** |
| --- | ---: | ---: | ---: |
| `apk update` | 1.17 | 1.38 | **1.33** |
| `apk search -q busybox` | 0.77 | 0.86 | **0.86** |
| `apk search` | 0.77 | 0.83 | **0.87** |
| `apk search -d compiler` | 0.82 | 0.95 | **1.00** |
| `apk info -v` | 0.63 | 0.71 | **0.72** |
| `apk add --simulate git` | 0.65 | 0.73 | **0.72** |
| `apk add jq` | 1.30 | 1.50 | **1.39** (-7%) |
| `apk del jq` | 0.67 | 0.77 | **0.78** |
| `apk add git` | 2.24 | 2.80 | **2.46** (-12%) |
| `apk add python3` | 3.73 | 4.84 | **4.32** (-11%) |
| python3 loop | 0.79 | 0.76 | **0.74** |
| ash loop, 30000 iterations | 1.86 | 2.53 | **2.24** (-11%) |
| `seq 100000 \| sort -r` | 2.78 | 2.98 | **3.05** |
| `seq 250000 \| gzip \| gunzip` | 2.20 | 3.70 | **2.55** (-31%) |
| `sha256sum`, 8 MB | 0.51 | 0.54 | **0.54** |
| `find / -xdev` | 0.10 | 0.10 | **0.09** |

The apk commands that only parse the index stay within the noise
(their libraries are no faster, below); downloads (TLS) and package
extraction (zlib, SHA-256) are where the installs gain. `sort` and
`gzip` here include busybox `seq`, whose `double` arithmetic is
generic ops in every build.

**OpenSSL in the image** (`openssl speed -evp ALG -bytes 16384
-seconds 2`, MB/s; public key in operations/s; the rebuild's `openssl`
command against the image's libcrypto; 2 boots each, medians). riscv64
is main's rebuilt libcrypto with its Zkn/Zbkb code.

| | riscv64 | aarch64, Alpine's | **aarch64, rebuilt** |
| --- | ---: | ---: | ---: |
| sha256 | 46 | 26 | **59** |
| sha512 | 137 | 117 | **125** |
| sha1 | 118 | 33 | **151** |
| aes-128-gcm | 53 | 14 | **24** |
| aes-256-gcm | 48 | 11 | **20** |
| aes-256-ctr | 52 | 14 | **25** |
| aes-128-cbc | 92 | 21 | **43** |
| chacha20-poly1305 | 71 | 5 | **162** |
| rsa2048 sign / verify | 49 / 2380 | 83 / 3070 | **55-79 / 3060** |
| ecdsa p256 sign / verify | 39 / 51 | 1950 / 800 | **2030 / 715** |
| x25519 | 2410 | 2600 | **3130** |

AES stays at half riscv64's speed: riscv64's AES round instructions are
compiled by its JIT, aarch64's `aes_core.c` does 16 table loads a round.

**Correctness** (2026-11-18): digests (md5, sha1, sha224 to sha512,
sha512-256, sha3-256, shake128, blake2b512) and `openssl enc` (AES CBC,
CTR, CFB, OFB, ChaCha20) of a 3 MB file under qemu-aarch64, with the
default and with `OPENSSL_armcap` set, equal the host's openssl, and
decryption round-trips; TLS 1.3 (AES-128-GCM, AES-256-GCM,
ChaCha20-Poly1305) and TLS 1.2 (ECDHE-ECDSA with AES-GCM, ChaCha20,
AES-CBC) against a host `openssl s_server` carried 270 KB each way
intact. busybox's testsuite in the guest: the same 13 failures as
Alpine's busybox (wget without a network, `hostname -d`, timezone data,
three sed cases, cpio hardlinks, unzip, strings, an awk gsub case), all
other tests pass with both.

**busybox** (ms; 4 runs of 2 boots × 3 rounds each, every run with
stock, `-O2` and some of the others: 24 samples for stock and `-O2`, 18
for the choice, 12 for "no vectorizer", 6 for the rest; each variant's
busybox copied into `/tmp` and run directly). "GRO" is
`-mgeneral-regs-only` per file, "guarded" with the `va_start` check
(above); the unguarded build is wrong (awk's `printf "%.2f"`) and only
shows what the guard costs.

| command | stock | gcc 16 -Os | -O2 | -O2, no vectorizer | **-O2, no vectorizer, guarded GRO** | -O2, guarded GRO | -O2, no vectorizer, GRO unguarded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ash loop, 20000 iterations | 1760 | 1735 | 1380 | 1500 | **1545** (-12%) | 1490 | 1370 |
| 150 × fork + exec | 240 | 220 | 230 | 230 | **230** (-4%) | 240 | 220 |
| `awk` sqrt loop, 150000 | 2360 | 2115 | 1910 | 2050 | **2070** (-12%) | 2080 | 2015 |
| `seq 60000 \| awk` | 1780 | 1625 | 1565 | 1645 | **1650** (-7%) | 1655 | 1605 |
| `sort -rn`, 30000 lines | 2805 | 2745 | 2740 | 2815 | **2875** (+2%) | 2715 | 2670 |
| `sha256sum`, 4 MB | 100 | 100 | 2350 | 100 | **100** | 100 | 95 |
| `tar \| gzip -6 \| gunzip \| md5sum`, 1.3 MB | 1570 | 1485 | 895 | 1000 | **785** (-50%) | 890 | 750 |
| `sed \| grep -c`, 30000 lines | 940 | 1005 | 900 | 910 | **915** (-3%) | 915 | 890 |

Plain `-O2` is the fastest build for ash and awk and was kept out only
by its vectorized code: `sha256sum` 23 times slower than stock, and
`sha512sum` 14% generic ops in qemu. Its ash advantage is not in the
instructions: an ash loop runs the same count (qemu: 40.6M against 40.7M)
and the same generic share (0.29%) as the chosen build, but on a
`-Dkwemu-stats` kernel 90.1% of its retired instructions ran compiled
against 85.5%, with fewer hand-backs in the chosen build (191K against
233K); the cause, maybe how the code falls on pages (a decoded block
ends at a page boundary), is not known.

**Instruction mix** (qemu-aarch64 `-d in_asm,exec,nochain` traces,
words classified by `kwemu-a64-classify`): `-O2` busybox `sha256sum`
ran 43.7% generic ops (`fmov` 25%: general registers spilled to FP
registers; vectorized message schedule: `shl`, `usra`, `eor`, `add` on
`.2s`); without the vectorizer, 0%. Stock `gzip` runs 0.59% generic
(`uqsub h`, scalar saturating subtract in `fill_window`), the `-O2`
build without the vectorizer the same, with `-mgeneral-regs-only` 0%.
The total instruction counts drop 2-16% from stock to the rebuild (ash
45.5M to 40.7M, sort 194M to 178M).

**Libraries** (3 boots × 2 rounds, ms or MB/s). Each variant is a
directory with libz, libcrypto, libssl, libapk and apk, used through
`LD_LIBRARY_PATH` and its own apk binary over the stock image; apk's
package cache on, so `apk add` reads no network. `stock, armcap=0` is
Alpine's libcrypto with `OPENSSL_armcap=0`.

| command | stock | stock, armcap=0 | **-O2** | -O2 -mno-outline-atomics | -Os |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 × `apk --version` | 510 | 505 | **450** (-12%) | 480 | 525 |
| `apk search` (main) | 810 | 825 | **805** | 805 | 815 |
| `apk search -d compiler` | 915 | 950 | **930** | 940 | 955 |
| `apk info -v` | 660 | 695 | **685** | 690 | 730 |
| `apk add --simulate git` | 720 | 750 | **710** | 725 | 780 |
| `apk add jq` (cached) | 820 | 870 | **810** | 810 | 845 |
| `apk del jq` | 765 | 760 | **720** (-6%) | 720 | 775 |
| python3 `zlib`: 4 MB compress, 4 × decompress | 1070 | 1080 | **770** (-28%) | 770 | 870 |
| `wget https://` APKINDEX (TLS) | 650 | 620 | **575** (-12%) | 610 | 620 |
| `openssl speed -evp sha256` | 25 | 59 | **58** | 63 | 63 |
| aes-128-gcm | 14 | 20 | **24** | 23 | 20 |
| chacha20-poly1305 | 5 | 164 | **167** | 146 | 164 |
| sha512 | 114 | 113 | **122** | 99 | 115 |

The apk commands that parse the index are flat: they run no generic ops
to speak of on either build (qemu: 0.41% stock, 0.05% rebuilt, the
SHA-1 crypto instructions of the index signature check) and execute
about the same number of instructions (232M against 234M for `apk search
-q busybox`). Their time is the JIT's own (below).

**OpenSSL per capability** (`openssl speed -evp ALG -bytes 16384
-seconds 1`, MB/s, Alpine's libcrypto, one run each, `OPENSSL_armcap`
set in the environment; 0x8bd is what kwemu's HWCAP gives it):

| algorithm | 0x8bd (NEON + AES, PMULL, SHA1, SHA2, SHA3) | 0x1 (NEON) | 0x25 (NEON, AES, PMULL) | 0x10 (SHA2) | **0** |
| --- | ---: | ---: | ---: | ---: | ---: |
| sha256 | 25.4 | 3.1 | 3.1 | 25.3 | **56.9** |
| sha1 | 30.5 | 139 | 151 | 151 | **146** |
| sha512 | 117 | 113 | 112 | 109 | **115** |
| aes-128-gcm | 14.0 | 3.0 | 13.7 | 18.9 | **19.9** |
| aes-256-ctr | 12.3 | 2.3 | 14.0 | 19.5 | **20.9** |
| aes-128-cbc | 19.6 | 1.9 | 20.7 | 28.5 | **33.3** |
| chacha20-poly1305 | 4.4 | 4.7 | 4.6 | 163 | **167** |
| md5 | 304 | 336 | 334 | 303 | **326** |

The NEON paths (vpaes, the NEON SHA-256 and GHASH, ChaCha20 for long
inputs) are the slowest: each AdvSIMD instruction is a generic op. The
crypto-extension instructions do a lot per op, but each still hands the
block back, and the integer code around them is short. With 0 everything
runs compiled. SHA-512 is integer in every column (HWCAP_SHA512 is off,
status.md).

## What did not help, or was worse

- **`-O2` with the vectorizer** (gcc's default since gcc 12): busybox
  `sha256sum` 23 times slower than stock, `sha512sum` 14% generic ops
  (above). Fastest for ash and awk otherwise.
- **`-O2 -fno-tree-loop-vectorize`** (the SLP vectorizer left on), no
  GRO: `sha256sum` still 27% generic ops (`fmov` spills 21%, SLP `add`,
  `eor`, `and` on V registers), `gzip` 0.6% (`uqsub`).
- **`-O2` with guarded GRO**, vectorizer on (it can only act in the files
  that keep the FP registers): ash 1490 against 1545 ms, gzip 890
  against 785; no clear winner, and the vectorizer stays a risk in those
  files.
- **`-Os` (gcc 16).** busybox: ash as stock, gzip -5% against -50%;
  libraries: zlib -19% against -28%, apk startup +3%.
- **`-mno-outline-atomics`.** Inline LL/SC instead of the helper calls:
  no gain (apk startup 480 against 450 ms, the rest flat). Exclusives are
  generic ops either way.
- **Capability subsets for OpenSSL.** No algorithm is faster with any
  capability bit set (table above), so the patch clears them all instead
  of masking some.
- **GNU ld** (stock Alpine binaries): 150 execs of busybox 230 ms
  against 220 ms with lld, about 0.07 ms per exec on aarch64 (riscv64
  measured 0.5 ms, 2026-11-16).
- **musl** is not rebuilt. Its generic ops show up in the profiles
  (status.md, Open issues): `dup`/`movi` in memset (0.2% of ash's
  instructions) and `ldaxr`/`stlxr` in malloc's locks (0.06% in ash, 0.4%
  in awk), each ending a compiled block.

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
- **`-mgeneral-regs-only` and variadic functions** (above): a whole-build
  `-mgeneral-regs-only` does not compile busybox or libcrypto, and a
  per-file one without the `va_start` guard compiles and silently
  corrupts `double` varargs.
- **Rebuilding one openssl object.** Do it through make (a CC wrapper
  that appends flags), not by hand: make otherwise recompiles the object
  with its own flags. The shared library links `libcrypto-shlib-*.o`,
  not `libcrypto-lib-*.o`.

## Measuring a change

Rebuild, then boot the bundle with
`--mount <dir>:/mnt/x:ro --input '{10}sh /mnt/x/bench.sh ...; poweroff\n'`.

- **Binaries:** copy them into `/tmp` in the guest first, each busybox
  as `/tmp/<variant>/busybox` (busybox picks the applet from its file
  name). Run them directly (`$B awk ...`) and time them with
  `/proc/uptime`; busybox's `date` has no `%N`.
- **Libraries:** point `LD_LIBRARY_PATH` at a directory holding only the
  library under test. The image has no `openssl` command; the rebuild's
  (`root/usr/bin/openssl`) works against either libcrypto.
- **OpenSSL capabilities:** `OPENSSL_armcap=<mask>` in the environment
  (`openssl info -cpusettings` prints the one in effect).
- **Instruction mix:** `qemu-aarch64 -L <stage> -d in_asm,exec,nochain
  -D log <program>`, count each translated block's words by its executions,
  and classify them with `zig-out/bin/kwemu-a64-classify` (`generic` =
  interpreted).
- **Where kwemu spends it:** a `-Dkwemu-stats` kernel and the CLI's
  `--stats` (kwemu.md): compiled share, hand-backs per op kind,
  interpreted ops per kind.
- **Correctness:** compare digests and `openssl enc` output with the
  host's openssl (also with `OPENSSL_armcap` set, so the other paths stay
  right), run TLS 1.2 and 1.3 suites against a host `openssl s_server`,
  and run busybox's testsuite in the guest against stock busybox.
- **musl:** run its loader as a command
  (`ld-musl-aarch64.so.1 --library-path DIR PROG`).
- **Noise:** interleave the variants within a boot, rotate their order
  across boots, and compare medians. Boot-to-boot noise is several
  percent (kwemu.md).
