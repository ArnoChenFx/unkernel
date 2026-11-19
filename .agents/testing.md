# Testing

The browser tests (`web/test/`, see web.md) are run only when asked; the
page is tested by hand with `pnpm dev`.

CLI exit codes: 0 = power off, 1 = halt or boot failure, 2 = restart,
124 = `--timeout`, 253 = panic, 254 = wasm trap, 255 = fatal.

## Quick checks

Run the row for what you changed, and no more.

| Change | Quick check |
| --- | --- |
| Emulator (`src/`, `test/guest/`, `include/`) | `zig build test` |
| Kernel, `kw_emu.h`, JIT | `kernel/build.sh kernel`; `node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"` (`kwtest: 0 failure(s)`, exit 0); for JIT changes, again with `--no-jit` |
| JIT control flow, regions, budget or polls | the row above; `zig build test -Dkwemu-a64-fuzz=20000` (the A64 block fuzz; a64/jit.md) |
| Guest image (`kernel/guest/`, `alpine.sh`) | `pnpm test:api`; optional: `node js/cli.ts --timeout 120 --input '{8}uname -a; apk --version\n{2}poweroff\n'` |
| Display, input, sound (kwfb, kwinput, kwsnd) | `pnpm test:api`; optional: `node test/glimmer-check.mjs --run` |
| Block, ext4, data disk | `pnpm test:block` |
| SDK (`js/`) | `pnpm typecheck`; `pnpm test:api` |
| Host file systems (9p, `kw9p`) | `pnpm test:9p`; `pnpm test:api` (after a kw9p change, `kernel/build.sh alpine` first) |
| Inbound to the guest (`vm.connect`, `vm.fetch`, kwtty CONNECT, `--forward`) | `pnpm test:http`; `pnpm test:tty`; `pnpm test:api` (after a kwtty change, `kernel/build.sh alpine` first) |
| Network | `pnpm test:net` |
| SMP code (`CONFIG_SMP` paths, per-CPU data, IPIs, CPU parking, `js/core/cpu.ts`; kernel/smp.md) | `kernel/build.sh smp` (after `kernel`, so that the bundle carries the patch); kwtest with `--smp 2` (the SMP kernel from the bundle) and once with `--kernel vendor/build/kernel-smp/vmlinux32.wasm --initrd alpine-test` (one CPU); `zig build test -Dkwemu-atomics=true` after a kwemu change |
| Bundle and kernel patch (`bundle.mjs`, `kwdiff.mjs`, `kpatch.ts`, `kremap.ts`) | `KPATCH_UP=vendor/build/kernel/vmlinux32.wasm KPATCH_SMP=vendor/build/kernel-smp/vmlinux32.wasm pnpm test:kpatch` |
| Page (`web/`) | `pnpm typecheck:web`; `pnpm build:web` |

The optional checks boot the same bundle as `pnpm test:api`, which already
runs shell commands and `glimmer --test` inline and in worker mode. Run them
when the change touches what only they cover. The Alpine boot adds `apk` and
the CLI's `--input`. `glimmer-check` compares the whole frame pixel for
pixel and the sound sample for sample, and checks the mouse and tablet
events and the CLI's `--display`, `--sound-wav` and `--worker`.

To add a test: for the emulator, a unit test in `src/a64/tests.zig` or a
guest in `test/guest/a64/` plus entries in `build.zig` (`a64_guests`) and
`test/a64-test.mjs`; for the kernel, a `CHECK(...)` in
`kernel/guest/kwtest.c`. A separate static guest program goes into the
`glimmer kwvsock ...` loop at the end of `kernel/guest/alpine.sh`, or into
the `kwtest kwbench` loop after it if it is only for tests (those, and
abitest, stay out of release bundles).

## Full matrix

Only before a release, or when asked. A row applies when the release
contains changes to that area.

| Area | Run |
| --- | --- |
| Emulator (`src/`, `test/guest/`, `include/`) | `zig build test` (it also reruns the wasm64 unit tests and the guests on a JIT host without wasm SIMD, `a64-nosimd` and `wasm64+jit/nosimd`) and `zig build test -Dkwemu-atomics=true`, then the kernel row |
| Kernel or `kw_emu.h` | `kernel/build.sh kernel` and `kernel/build.sh smp`; `node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"`, the same with `--kernel vendor/build/kernel/vmlinux`, and both again with `--no-jit` (expect `kwtest: 0 failure(s)`, exit 0); kwtest once more with `kw.isa=armv8` appended (the `isa` checks then expect SIGILL) and once with `--no-vsock`; abitest the same way (`rdinit=/usr/bin/abitest`, `abitest: 0 failure(s)`, exit 0; kernel/tests.md) with and without the JIT and with `--smp 2`; the SMP kernel (below); `node test/wasi-node.ts` (`PASS`) |
| Bundle, kernel patch, `build.sh` | `KPATCH_UP=vendor/build/kernel/vmlinux32.wasm KPATCH_SMP=vendor/build/kernel-smp/vmlinux32.wasm pnpm test:kpatch`; after a change to the stamps or the build, two clean builds into different `KW_BUILD` roots give the same `vmlinux32.wasm` files and bundle (`sha256sum`) |
| JIT (`src/emu/jitcore.zig`, `src/a64/jit/`, `js/core/jit.ts`) | the two rows above; `zig build test -Dkwemu-a64-fuzz=20000` (the A64 block fuzz, natively and on the JIT with and without SIMD; `-Dkwemu-a64-fuzz-seed=S` for other programs; a64/jit.md); Alpine with real work under JIT, `--no-jit` and a host without wasm SIMD, comparing outputs (`seq 30000 \| sort -rn \| md5sum`, `tar cf - /lib \| gzip \| md5sum` (with `--exclude=lib/apk` after an `apk add`: apk's database holds install times), `sha256sum`, awk FP output, and with `apk add openssl` digests and ciphers against the host's `openssl`); `node --expose-gc --test test/api.test.ts`. A host without SIMD: preload a module that makes `WebAssembly.validate` refuse `jitSimd()`'s 31-byte probe (js/core/jit.ts), `node --import file:///PATH/nosimd.mjs js/cli.ts ...` |
| Anything a real userland sees | `node js/cli.ts --timeout 120 --input '{8}uname -a; apk --version\n{2}poweroff\n'` |
| Block, ext4, disk script | `node js/cli.ts --disk vendor/build/disk/alpine.ext4 --snapshot --timeout 120 --input '{6}df -h /\n{2}poweroff\n'` (`/dev/root` mounted, `kw-shutdown: / is clean`) |
| Ubuntu disk (`ubuntu-disk.sh`), or anything glibc sees | `kernel/build.sh ubuntu`; `node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --snapshot --timeout 180 --input '{8}getconf GNU_LIBC_VERSION; apt --version; dpkg -l \| wc -l\n{4}poweroff\n'` (`glibc 2.44`, `apt 3.3.3`, `kw-shutdown: / is clean`, exit 0); with a network, also `apt-get update` and an `apt-get install`; after a kernel change, a systemd boot of a disk with systemd installed (`running`, no failed units; kernel/guest.md, Ubuntu) |
| Data disk (`block.ts`, `kwsparse.ts`, `web/src/data.ts`, `kw-data.sh`) | `pnpm test:block`; `pnpm test:api` (its data disk tests, among them the reset of a disk written by another guest architecture); `node js/cli.ts --data /tmp/d.img --timeout 120 --input '{8}ls /data\n{2}{sync}{2}poweroff\n'` (`sync: block flush after`, `kw-shutdown: /data is clean`; delete the image afterwards) |
| Overlay root (`kernel/guest/overlay/`, `kw-data.sh`) | `kernel/build.sh alpine`; `node test/overlay-node.mjs` (`PASS`; with a network also `--only apk --apk`); after a `rebase.sh` change, `--only update --image2 BUNDLE` (see the script's header) |
| Network (SDK or kwnet) | `pnpm test:net`; `UNKERNEL_TEST_WISP=1 node --test test/api.test.ts` |
| SDK (`js/`, `package.json`, `build.config.ts`) | `pnpm typecheck`; `pnpm test:tty`; `pnpm test:http`; `pnpm test:9p`; `pnpm test:api`; `pnpm build`, then the kwtest, Alpine and disk rows with `node dist/cli.mjs`, `UNKERNEL_DIST=1 node --test test/api.test.ts`, and `npm pack --dry-run` |
| Host file systems (`fs.ts`, `9p.ts`, `memfs.ts`, `mounts.ts`, `nodefs.ts`, `kw9p.c`) | after a kw9p change `kernel/build.sh alpine`; `pnpm test:9p`; `pnpm test:api`; `node test/9p-bench.ts` and with `--worker`, against js.md's table |
| Page (`web/`) | `pnpm typecheck:web`; `pnpm build:web` (it takes the newest release's bundle and refuses one of another kwemu ABI; until a release of this ABI exists, `KW_KERNEL=../vendor/build/bundle/unkernel-alpine.wasm pnpm build:web`) |

`node test/glimmer-check.mjs --run` takes `--no-sound` (no sound card)
and `--worker` (through the CLI's `--worker`, with input and frames in
shared memory); run it also with `--worker=messages` after a worker-mode
change. The A64 guests of `zig build test` must match qemu-aarch64 on
every runner (`ok   a64 <runner> <guest> = qemu`).

The SMP kernel (kernel/smp.md; `kernel/build.sh smp` puts it in the
bundle) runs the same checks:

- kwtest with `--smp 2`, `--smp 4` and `--smp 2 --no-jit` (add `--display
  --shm` for its kwfb and kwshm checks), and once on one CPU (`--kernel
  vendor/build/kernel-smp/vmlinux32.wasm --initrd alpine-test`);
- abitest with `--smp 2`;
- `UNKERNEL_TEST_CPUS=2 pnpm test:api` (the snapshot tests skip);
- `node test/glimmer-check.mjs --run --kernel <it> --initrd <an image>
  --smp 2`.

kwtest's `smp:`, `lse smp:`, `excl smp:`, `move:` and `jit:` checks race
by design, so one pass proves little: run `rdinit=/usr/bin/kwtest -- smp`
(only those checks, a few seconds a boot) 5 times, and 20 or more only
when chasing a race.

When you measure something, follow the rules in a64/performance.md (machine, date,
command, interleaved medians).

## Release workflow (CI)

`.github/workflows/release.yml` is the source for what CI does; the
maintainer runs it by hand from main (its `release` input unchecked makes
it a smoke run). It builds everything from source with `KW_RELEASE=1`
(kwtest, abitest and kwbench stay out of the bundle), then runs kwtest
with and without the JIT and on 2 CPUs, abitest on the UP kernel and on 2
CPUs, `pnpm typecheck`, `pnpm test:kpatch`, the tty, http and 9p tests,
and kwtest and the api tests on the built package. A release publishes
the tarball to npm and a GitHub release with the tarball and the bundle.

Not in the workflow, so only the full matrix covers them: kwtest without
the JIT on 2 CPUs, the api tests with `UNKERNEL_TEST_CPUS=2`, `zig build
test`, the block and net tests, and the Alpine, disk and Ubuntu boots.
