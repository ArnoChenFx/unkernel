# Testing: the full matrix

AGENTS.md lists a quick check per area. Run these longer checks before a
release, or when asked for. The browser tests (`web/test/`, see web.md)
are run only when asked; the page is tested by hand with `pnpm dev`.

| Change | Run |
| --- | --- |
| Emulator (`src/`, `guest/`, `include/`) | `zig build test`, then the kernel row |
| Kernel or `kw_emu.h` | `kernel/build.sh kernel`; `node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"`, the same with `--kernel vendor/build/kernel/vmlinux`, and both again with `--no-jit` (expect `kwtest: 0 failure(s)`, exit 0); `node test/wasi-node.ts` (`PASS`) |
| JIT (`src/emu/jit.zig`, `js/core/jit.ts`) | the two rows above; `zig build test -Dkwemu-fp-fuzz=1000000` after FP changes; `zig build fuzz -- 20000` after control-flow changes; Alpine with real work under JIT and `--no-jit`, comparing outputs (`seq 30000 \| sort -rn \| md5sum`, `tar cf - /lib \| gzip \| md5sum`, `sha256sum`); `node --expose-gc --test test/api.test.ts` |
| Anything a real userland sees | `node js/cli.ts --timeout 120 --input '{8}uname -a; apk --version\n{2}poweroff\n'` |
| Block, ext4, disk script | `node js/cli.ts --disk vendor/build/disk/alpine.ext4 --snapshot --timeout 120 --input '{6}df -h /\n{2}poweroff\n'` (`/dev/root` mounted, `kw-shutdown: / is clean`) |
| Ubuntu disk (`ubuntu-disk.sh`), or anything glibc sees | `kernel/build.sh ubuntu`; `node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --snapshot --timeout 180 --input '{8}getconf GNU_LIBC_VERSION; apt --version; dpkg -l \| wc -l\n{4}poweroff\n'` (`glibc 2.39`, `apt 2.8.3`, `kw-shutdown: / is clean`, exit 0); with a network, also `apt-get update` and an `apt-get install`; after a kernel change, a systemd boot of a disk with systemd installed (`running`, no failed units; kernel/README.md, Ubuntu) |
| Data disk (`block.ts`, `kwsparse.ts`, `web/src/data.ts`, `kw-data.sh`) | `pnpm test:block`; `node js/cli.ts --data /tmp/d.img --timeout 120 --input '{8}ls /data\n{2}{sync}{2}poweroff\n'` (`sync: block flush after`, `kw-shutdown: /data is clean`; delete the image afterwards) |
| Overlay root (`kernel/guest/overlay/`, `kw-data.sh`) | `kernel/build.sh alpine`; `node test/overlay-node.mjs` (`PASS`; with a network also `--only apk --apk`); after a `rebase.sh` change, `--only update --image2 BUNDLE` (see the script's header) |
| Network (SDK or kwnet) | `pnpm test:net`; `UNKERNEL_TEST_WISP=1 node --test test/api.test.ts` |
| SDK (`js/`, `package.json`, `build.config.ts`) | `pnpm typecheck`; `pnpm test:tty`; `pnpm test:http`; `pnpm test:9p`; `pnpm test:api`; `pnpm build`, then the kwtest, Alpine and disk rows with `node dist/cli.mjs`, `UNKERNEL_DIST=1 node --test test/api.test.ts`, and `npm pack --dry-run` |
| Host file systems (`fs.ts`, `9p.ts`, `memfs.ts`, `mounts.ts`, `nodefs.ts`, `kw9p.c`) | after a kw9p change `kernel/build.sh alpine`; `pnpm test:9p`; `pnpm test:api`; `node test/9p-bench.ts` and with `--worker`, against js.md's table |
| Page (`web/`) | `pnpm typecheck:web`; `pnpm build:web` |

A separate static guest program goes into the `glimmer kwvsock ...` loop at
the end of `kernel/guest/alpine.sh`, or into the `kwtest kwbench` loop
after it if it is only for tests (those stay out of release bundles). `node test/glimmer-check.mjs --run`
boots with `--display --sound-wav`, runs `glimmer --test` and checks the
dumped frame pixel for pixel, the injected input events and the recorded
test signal sample for sample (`--no-sound`: without a sound card; `--worker`:
the same through the CLI's `--worker`, with input and frames in shared
memory; run it also with `--worker=messages` after a worker-mode change).
An SMP kernel (kernel.md, SMP) runs the same checks: kwtest with `--smp
2` and `--smp 4` (add `--display --shm` for its kwfb and kwshm checks),
`UNKERNEL_TEST_KERNEL=<a bundle of it> UNKERNEL_TEST_CPUS=2 node --test
test/api.test.ts` (the snapshot tests skip), and `node
test/glimmer-check.mjs --run --kernel <it> --initrd <an image> --smp 2`.
Emulator guests print
`name: N checks, 0 failures`.

When you measure something, follow the rules in kwemu.md (machine, date,
command, interleaved medians).

## Release workflow (CI)

`.github/workflows/release.yml` runs by hand from main as a release of
the generated version `<package.json version>-<YYMMDD>-<commit>` (commit
date, UTC), which it tags `v<version>` once the build passes. Its
`release` input (on by default) unchecked makes it a smoke run. A pushed
`v<version>` tag on main is a release of that version. It refuses any
other ref before building, and stamps the version into package.json
before `pnpm build`. It builds everything from source with `KW_RELEASE=1`, so `alpine.sh`
leaves kwtest and kwbench out of `alpine.cpio` and the bundle
(`kernel/build.sh toolchain kernel alpine datadisk`, clang 22 from
apt.llvm.org; kwemu with `zig build -Dcpu=baseline` handed over as
`KWEMU=`, so the zig cache survives runners with other CPU models), runs
kwtest with and without the JIT (the bundle's kernel with `--initrd
alpine-test`), `pnpm typecheck`, the tty, http and 9p
tests, `pnpm build`, kwtest (the same way) and the api tests on the built package, then
uploads `npm pack`'s tarball (`unkernel.tgz`) and the bundle. A release
publishes the tarball to npm through trusted publishing (npmjs.com trusts
`release.yml` of this repository; no token), always on the dist-tag
`latest` (given explicitly: npm requires a tag for a prerelease version), then
publishes a GitHub release with both files attached (a normal release,
marked latest). CI runs Node 26; package.json's engines stay at
>= 24. The workflow's header lists the caches. The kernel tree is restored only by an exact
patch-series key, and the kernel build only for that same tree.
