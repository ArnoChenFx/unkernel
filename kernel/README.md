# kernel/

Linux 7.3 built as one wasm module (`arch/wasm`, grown from Joel Severin's
linux-wasm port), with the kwemu aarch64 CPU (`src/`, contract in
`include/kw_emu.h`) linked in to run unmodified aarch64 user space, and the
guest images it boots. The overview is the top-level README.md; the
reference for changing anything here is in `.agents/` (start at
[.agents/kernel.md](../.agents/kernel.md)).

| Path | What |
| --- | --- |
| `build.sh` | every kernel-side build step (below) |
| `patches/linux/` | the kernel series on Linux v7.3.4 (`7595a62d45e`), applied as branch `kw-arm64-user` in `vendor/src/linux-wasm-kernel` (.agents/kernel.md, Tree and patch workflow) |
| `patches/llvm/` | the wasm-ld patches (.agents/toolchain.md) |
| `tools/` | `bundle.mjs` (the bundle), `kwdiff.mjs` (the UP-to-SMP patch), `kwsparse.mjs`, `mkcpio.py`, `ext4-owners.py`, `fake-llvm/` (Kbuild's toolchain wrapper), `env.sh` (pins and host tools) |
| `guest/` | the images and the programs in them (.agents/kernel/guest.md): `alpine.sh`, `alpine-opt.sh` (.agents/guest-packages.md), `alpine-disk.sh`, `ubuntu-disk.sh`, `kw-data.sh` and `overlay/` (.agents/data-disk.md), the shims, `fbdoom`, and the C programs (`kwtest`, `abitest`, `kwbench`, `glimmer`, `kwtty`, `kwvsock`, `kw9p`, `kwshm`, `kwwasi`) |

## Build

`./setup.sh` (repository root) checks the prerequisites and runs `zig
build` and `kernel/build.sh all`. Steps, each on its own:

| Step | Output |
| --- | --- |
| `toolchain` | `wasm-ld` from LLVM 22.1.8 with `patches/llvm/` (clang 22 comes from the system; .agents/toolchain.md) |
| `binaryen` | Binaryen 133 in `vendor/toolchain/binaryen` (`lower` fetches it if needed) |
| `kernel` | the UP kernel `vendor/build/kernel/vmlinux` (wasm64) with kwemu from `zig-out/lib/libkwemu.a`, then `lower` and the bundle; the quick loop |
| `smp` | the SMP kernel in `vendor/build/kernel-smp`, then the bundle with its patch |
| `lower` | `vmlinux32.wasm`, the 32-bit-memory build every host runs |
| `alpine` | `vendor/build/initramfs/alpine.cpio` and `alpine-test.cpio` |
| `disk` | `vendor/build/disk/alpine.ext4` (needs e2fsprogs) |
| `datadisk` | `vendor/build/disk/kwdata.kwsparse.gz`, the data disk template |
| `bundle` | `vendor/build/bundle/unkernel-alpine.wasm` (kernel, initramfs, command line, template, SMP patch), also copied to `web/kernel/` |
| `all` | all of the above |
| `ubuntu` | `vendor/build/disk/ubuntu.ext4`, Ubuntu Base 26.10 (not in `all`) |
| `stats` | `vendor/build/bundle/unkernel-alpine-stats.wasm`, kwemu with exit counters (`--stats`; not in `all`) |

`KSRC`, `KOUT`, `KOUT_SMP` and `KW_BUILD` build another tree or into
another output root; the header of `build.sh` lists every variable.
Downloads are pinned (`build.sh`, `tools/env.sh`).

## Run

```sh
node js/cli.ts                                                    # Alpine from the bundle; Ctrl-] quits; --help lists options
node js/cli.ts --append "console=hvc0 rdinit=/usr/bin/kwtest"     # kernel tests as /init
node js/cli.ts --smp 2 --append "console=hvc0 rdinit=/usr/bin/kwtest"   # the same on the SMP kernel
node js/cli.ts --kernel vendor/build/kernel/vmlinux --append "console=hvc0 rdinit=/usr/bin/kwtest"   # the wasm64 build
node js/cli.ts --disk vendor/build/disk/alpine.ext4               # Alpine on ext4, persistent
node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --snapshot    # Ubuntu, changes kept in memory
node js/cli.ts --data /tmp/kwdata.img                             # with the data disk at /data
```

Which tests to run for a change: AGENTS.md (Tests) and .agents/testing.md.
