# Testing: the full matrix

AGENTS.md lists a quick check per area. Run these longer checks before a
release, or when asked for. The browser tests (`web/test/`, see web.md)
are run only when asked; the page is tested by hand with `pnpm dev`.

| Change | Run |
| --- | --- |
| Emulator (`src/`, `test/guest/`, `include/`) | `zig build test` (it also reruns the wasm64 unit tests and the guests on a JIT host without wasm SIMD, `a64-nosimd` and `wasm64+jit/nosimd`) and `zig build test -Dkwemu-atomics=true`, then the kernel row |
| Kernel or `kw_emu.h` | `kernel/build.sh kernel` and `kernel/build.sh smp`; `node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"`, the same with `--kernel vendor/build/kernel/vmlinux`, and both again with `--no-jit` (expect `kwtest: 0 failure(s)`, exit 0); kwtest once more with `kw.isa=armv8` appended (the `isa` checks then expect SIGILL) and once with `--no-vsock`; abitest the same way (`rdinit=/usr/bin/abitest`, `abitest: 0 failure(s)`, exit 0; kernel/tests.md) with and without the JIT and with `--smp 2`; the SMP kernel as below the table; `node test/wasi-node.ts` (`PASS`) |
| Bundle, kernel patch, `build.sh` | `KPATCH_UP=vendor/build/kernel/vmlinux32.wasm KPATCH_SMP=vendor/build/kernel-smp/vmlinux32.wasm pnpm test:kpatch`; after a change to the stamps or the build, two clean builds into different `KW_BUILD` roots give the same `vmlinux32.wasm` files and bundle (`sha256sum`) |
| JIT (`src/emu/jitcore.zig`, `src/a64/jit/`, `js/core/jit.ts`) | the two rows above; after control-flow, region, budget or poll changes `zig build test -Dkwemu-a64-fuzz=20000` (the A64 block fuzz, natively and on the JIT with and without SIMD; `-Dkwemu-a64-fuzz-seed=S` for other programs; a64/jit.md); Alpine with real work under JIT, `--no-jit` and a host without wasm SIMD, comparing outputs (`seq 30000 \| sort -rn \| md5sum`, `tar cf - /lib \| gzip \| md5sum` (with `--exclude=lib/apk` after an `apk add`: apk's database holds install times), `sha256sum`, awk FP output, and with `apk add openssl` digests and ciphers against the host's `openssl`); `node --expose-gc --test test/api.test.ts`. A host without SIMD: preload a module that makes `WebAssembly.validate` refuse `jitSimd()`'s 31-byte probe (js/core/jit.ts), `node --import file:///PATH/nosimd.mjs js/cli.ts ...` |
| Anything a real userland sees | `node js/cli.ts --timeout 120 --input '{8}uname -a; apk --version\n{2}poweroff\n'` |
| Block, ext4, disk script | `node js/cli.ts --disk vendor/build/disk/alpine.ext4 --snapshot --timeout 120 --input '{6}df -h /\n{2}poweroff\n'` (`/dev/root` mounted, `kw-shutdown: / is clean`) |
| Ubuntu disk (`ubuntu-disk.sh`), or anything glibc sees | `kernel/build.sh ubuntu`; `node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --snapshot --timeout 180 --input '{8}getconf GNU_LIBC_VERSION; apt --version; dpkg -l \| wc -l\n{4}poweroff\n'` (`glibc 2.44`, `apt 3.3.3`, `kw-shutdown: / is clean`, exit 0); with a network, also `apt-get update` and an `apt-get install`; after a kernel change, a systemd boot of a disk with systemd installed (`running`, no failed units; kernel/guest.md, Ubuntu) |
| Data disk (`block.ts`, `kwsparse.ts`, `web/src/data.ts`, `kw-data.sh`) | `pnpm test:block`; `pnpm test:api` (its data disk tests, among them the reset of a disk written by another guest architecture); `node js/cli.ts --data /tmp/d.img --timeout 120 --input '{8}ls /data\n{2}{sync}{2}poweroff\n'` (`sync: block flush after`, `kw-shutdown: /data is clean`; delete the image afterwards) |
| Overlay root (`kernel/guest/overlay/`, `kw-data.sh`) | `kernel/build.sh alpine`; `node test/overlay-node.mjs` (`PASS`; with a network also `--only apk --apk`); after a `rebase.sh` change, `--only update --image2 BUNDLE` (see the script's header) |
| Network (SDK or kwnet) | `pnpm test:net`; `UNKERNEL_TEST_WISP=1 node --test test/api.test.ts` |
| SDK (`js/`, `package.json`, `build.config.ts`) | `pnpm typecheck`; `pnpm test:tty`; `pnpm test:http`; `pnpm test:9p`; `pnpm test:api`; `pnpm build`, then the kwtest, Alpine and disk rows with `node dist/cli.mjs`, `UNKERNEL_DIST=1 node --test test/api.test.ts`, and `npm pack --dry-run` |
| Host file systems (`fs.ts`, `9p.ts`, `memfs.ts`, `mounts.ts`, `nodefs.ts`, `kw9p.c`) | after a kw9p change `kernel/build.sh alpine`; `pnpm test:9p`; `pnpm test:api`; `node test/9p-bench.ts` and with `--worker`, against js.md's table |
| Page (`web/`) | `pnpm typecheck:web`; `pnpm build:web` (it takes the newest release's bundle and refuses one of another kwemu ABI; until a release of this ABI exists, `KW_KERNEL=../vendor/build/bundle/unkernel-alpine.wasm pnpm build:web`) |

A separate static guest program goes into the `glimmer kwvsock ...` loop at
the end of `kernel/guest/alpine.sh`, or into the `kwtest kwbench` loop
after it if it is only for tests (those, and abitest, stay out of release
bundles). `node test/glimmer-check.mjs --run`
boots with `--display --sound-wav`, runs `glimmer --test` and checks the
dumped frame pixel for pixel, the injected input events and the recorded
test signal sample for sample (`--no-sound`: without a sound card; `--worker`:
the same through the CLI's `--worker`, with input and frames in shared
memory; run it also with `--worker=messages` after a worker-mode change).
The SMP kernel (kernel/smp.md; `kernel/build.sh smp` puts it in the
bundle) runs the same checks: kwtest with `--smp 2`, `--smp 4` and
`--smp 2 --no-jit` (add `--display --shm` for its kwfb and kwshm checks)
and once on one CPU (`--kernel vendor/build/kernel-smp/vmlinux32.wasm
--initrd alpine-test`), abitest with `--smp 2`, `UNKERNEL_TEST_CPUS=2
pnpm test:api` (the snapshot tests skip), and `node
test/glimmer-check.mjs --run --kernel <it> --initrd <an image> --smp 2`.
Run the SMP kwtest several times: its `smp:`, `lse smp:`, `excl smp:`,
`move:` and `jit:` checks race by design. `rdinit=/usr/bin/kwtest -- smp`
runs only those (a few seconds a boot), which makes 20 or 30 repeats
cheap. The A64 guests of `zig build test` must match qemu-aarch64 on
every runner (`ok   a64 <runner> <guest> = qemu`).

When you measure something, follow the rules in a64/performance.md (machine, date,
command, interleaved medians).

## Release workflow (CI)

`.github/workflows/release.yml` runs by hand from main as a release of
the generated version `<package.json version>-<YYMMDD>-<commit>` (commit
date, UTC), which it tags `v<version>` once the build passes. Its
`release` input (on by default) unchecked makes it a smoke run. A pushed
`v<version>` tag on main is a release of that version. It refuses any
other ref before building, and stamps the version into package.json
before `pnpm build`. It builds everything from source with `KW_RELEASE=1`, so `alpine.sh`
leaves kwtest, abitest and kwbench out of `alpine.cpio` and the bundle
(`kernel/build.sh toolchain kernel smp alpine datadisk`, the last two
with `KW_SMP=1`, so the bundle must carry the SMP patch; clang 22 from
apt.llvm.org; both kwemu libraries with `zig build -Dcpu=baseline`
handed over as `KWEMU=` and `KWEMU_SMP=`, so the zig cache survives
runners with other CPU models), runs
kwtest with and without the JIT (the bundle's kernel with `--initrd
alpine-test`) and on 2 CPUs (the SMP kernel from the bundle; a hosted
runner has 4 vCPUs, so not more), abitest on the UP kernel and on 2
CPUs, `pnpm typecheck`, `pnpm test:kpatch`
on the two kernels, the tty, http and 9p
tests, `pnpm build`, kwtest (the same way) and the api tests on the built package, then
uploads `npm pack`'s tarball (`unkernel.tgz`) and the bundle. A release
publishes the tarball to npm through trusted publishing (npmjs.com trusts
`release.yml` of this repository; no token), always on the dist-tag
`latest` (given explicitly: npm requires a tag for a prerelease version), then
publishes a GitHub release with both files attached (a normal release,
marked latest). CI runs Node 26; package.json's engines stay at
>= 24. The workflow's header lists the caches. The kernel tree is restored only by an exact
patch-series key, and the kernel builds (UP and SMP, one cache) only for
that same tree.
The SMP steps (both kernels, the bundle's SMP patch, kwtest on 2 CPUs)
have run in releases since 2026-11-17. Not in the workflow: kwtest
without the JIT on 2 CPUs and the api tests with `UNKERNEL_TEST_CPUS=2`.

The aarch64 build path has not run in CI yet: the arm64 patch series
(a new kernel tree and kernel build: every kernel cache misses), the
package rebuild with Bootlin's aarch64 gcc (alpine-opt.sh downloads it,
107 MB, and the sources, 163 MB in all; the build took 79 s on 16 cores
locally, 2026-11-18), the aarch64 minirootfs and guest programs from `zig cc`,
and abitest. Run it once as a smoke run (`release` unchecked) before the
first aarch64 release; only a real run shows its time on a hosted runner
and whether kwtest's timing checks hold there with the A64 JIT. Locally
(2026-11-18) the build path's logic, run into an empty output root, gave
kernels byte for byte the same as the existing build, from a tree made by
applying `kernel/patches/linux/` to the base commit.
