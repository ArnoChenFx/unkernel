# Guest images

What `kernel/guest/` puts in the images. The rebuilt packages are in
guest-packages.md, the data disk and overlay root in data-disk.md.

## Alpine initramfs (`kernel/build.sh alpine`, `guest/alpine.sh`)

The only initramfs: `vendor/build/initramfs/alpine.cpio`, plus
`alpine-test.cpio`, which always has the test programs. The cpio archives
are written by `tools/mkcpio.py` (no root needed).

- The Alpine aarch64 minirootfs 3.24.4 (version and checksum pinned in
  `tools/env.sh`; `ALPINE_TARBALL=file` overrides), with a small `/init`
  and an inittab with `hvc0::respawn:-/bin/sh` and
  `::respawn:/usr/bin/kwtty serve`. `/init` mounts cgroup2 at
  `/sys/fs/cgroup` (as does the Alpine disk's fstab).
- busybox, zlib, libcrypto, libssl, libapk and apk are rebuilt for kwemu
  (`guest/alpine-opt.sh`, guest-packages.md; `KW_ALPINE_OPT=0` keeps
  Alpine's builds). Every other package is Alpine's own build.
- Programs from `kernel/guest/*.c`, built static with `zig cc -target
  aarch64-linux-musl -mcpu=generic` (ARMv8.0): `glimmer`, `kwvsock`,
  `kwshm`, `kwtty`, `kw9p`, `kwwasi`, and the test programs `kwtest`, `kwbench` and
  `abitest` (tests.md). New code must stay within what kwemu implements:
  check it with the coverage classifier (a64/isa.md).
- The test programs come as a second cpio archive after the image's, which
  the kernel unpacks after the first. With `KW_RELEASE=1` (the release
  workflow) `alpine.sh` leaves them out of `alpine.cpio`, so release
  bundles, the npm package and the deployed page have none; boot a release
  bundle with `--initrd alpine-test` to run them. The choice is in
  `alpine.sh`, not `build.sh`, because `build.sh` is part of CI's kernel
  cache key.
- `/usr/lib/kw-image` is the image id (`alpine-<version>-<hash of the
  tree>`, unchanged by an identical rebuild; the test programs are not part
  of it), which the overlay root uses to detect image updates
  (data-disk.md).

## Alpine disk (`kernel/build.sh disk`, `guest/alpine-disk.sh`)

`vendor/build/disk/alpine.ext4` (`DISK_SIZE`, default 512M; `all` keeps an
image newer than its inputs, `disk` always rebuilds): the same minirootfs
as a sparse ext4 image, made without root: `mke2fs -d` from the extracted
tree, then `tools/ext4-owners.py` emits debugfs `sif` commands that make
every inode root-owned and restore the tarball's modes and owners (setuid,
`/etc/shadow` root:shadow). Inode tables and journal are zeroed at mkfs
time (no lazyinit writes on first boot); `e2fsck -fn` checks it. It boots
the real `/sbin/init` (busybox) with an inittab running `/etc/kw-rc`
(mount -a, hostname), `/etc/kw-net.sh` and a shell on hvc0;
`::shutdown:/etc/kw-shutdown` kills everything and remounts `/` read-only,
so `poweroff` leaves the file system clean. `node js/cli.ts --disk
vendor/build/disk/alpine.ext4` boots it with `root=/dev/wda rw`.

## Data disk template (`kernel/build.sh datadisk`)

`vendor/build/disk/kwdata.kwsparse.gz`: an empty ext4 labelled `kwdata`, 4
GiB, made with `mke2fs -t ext4 -b 4096 -L kwdata -m 0 -J size=8 -E
lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,orphan_file_size=32K`
and the ext4 features of `alpine-disk.sh`'s image (pinned in a generated
`mke2fs.conf`), checked with `e2fsck -fn`, then encoded by
`tools/kwsparse.mjs` (554 non-zero blocks, 17 KiB gzipped). The orphan
file is 8 blocks instead of 256, because the kernel reads it one block at
a time at every mount; give `orphan_file_size` a unit (a bare number is
blocks). Reproducible: fixed `-U` and `hash_seed`, and
`E2FSPROGS_FAKE_TIME`/`SOURCE_DATE_EPOCH`. `all` runs it before `bundle`
and goes on with a warning without mke2fs.

## In the Alpine image

- **Network setup**: the inittab runs `/etc/kw-net.sh`, which brings up
  `lo` and, if eth0 exists, runs `udhcpc` (it writes `/etc/resolv.conf`).
  The guest clock is host wall time, so TLS works.
- **apk repositories**: apk starts with `main` only, because every apk
  command that loads the indexes parses all enabled ones (~0.65 s for main,
  ~2.7 s with community, 2026-11-15). The community line is in
  `/etc/kw-apk-lazy`, and `/etc/kw-apk-enable` appends it to
  `/etc/apk/repositories` when something needs it, for good (packages
  installed with `apk add -X URL` would not be upgraded later). The page
  pushes index files into apk's cache (web.md, apk index prefetch).
- **Command not found**: in an interactive root shell with a default
  route, a missing command is installed with `apk add cmd:NAME` and run
  (`/etc/profile.d/kw-apk.sh`, a busybox ash `command_not_found_handle`,
  and `/etc/kw-apk-install`). ash passes only the command name, so the
  arguments come from the history line, and only for a simple line (after
  `htop; ls` it asks to run the command again); `$?` is 127 either way.
  `KW_AUTO_APK=0` turns it off. kw-apk-install looks the command up in a
  list of the `cmd:` names each cached index provides
  (`/var/cache/kw-apk/*.cmds`, rebuilt when the index changes: ~1.2 s for
  main, ~3.1 s for community; a lookup ~0.1 s). A command in none of the
  enabled repositories is looked up in the lazy ones: their index is
  fetched with wget to the name apk uses for its cache
  (`APKINDEX.<8 hex digits of sha1(index URL)>.tar.gz`, unless the page has
  pushed it), and on a hit the repository is enabled and apk reuses that
  file.
- **`~/.local/bin` first on PATH** (`/etc/profile.d/kw-path.sh`): Alpine's
  `/etc/profile` sets a fixed PATH; this prepends `$HOME/.local/bin` for
  every login shell, and kwtty gives programs it starts directly the same
  PATH. Per-user installs go there (`pip install --user`, the fx and
  claude installers), and so do the page's stand-ins (web.md, Stand-ins).
- **bwrap shim** (`/usr/local/bin/bwrap`, `guest/bwrap-shim.sh`): no
  seccomp, so it drops `--seccomp FD` and runs `/usr/bin/bwrap` with the
  rest. GTK programs need it to load images (Xfce).
- **curl shim** (`/usr/local/bin/curl`, `guest/curl-shim.sh`) over busybox
  wget, because the real curl costs about 2.4 MB of download and 5 MB of
  RAM. It handles only GET requests with `-L` whose result it can
  reproduce exactly (`curl -fsSL URL | sh`, `curl -fLo FILE URL`; options
  `-f -s -S -L -k -g -o -O -H -A -e -m`). Anything else (other options, a
  body, no `-L`, credentials, an HTTP error without `-f`, a TLS failure)
  runs the real curl, installed on first use by `/etc/kw-apk-install
  curl`; after that the shim execs `/usr/bin/curl`. Output is written only
  after a complete transfer, so `curl | sh` does not stream.
- **Foreign binaries**: x86_64, riscv64, i386 (i486-i686) and arm
  (armv5-armv7, little-endian; the kernel has no AArch32) run through
  qemu-user. The inittab runs `/etc/kw-binfmt.sh`, which registers the
  four ELF types (flag P, `CONFIG_BINFMT_MISC`) with the interpreter
  `/etc/kw-qemu`, and WASI `.wasm` programs with `/usr/bin/kwwasi`, which
  runs them on the host's wasm engine (js.md, WASI programs). **Guest only:
  never run it on the host.**
  The first time an architecture is needed (as root, with a network, under
  a lock so parallel execs do not race apk) kw-qemu enables community and
  installs `qemu-ARCH` and a library root at qemu's default prefix
  `/usr/gnemul/qemu-ARCH`: musl, libgcc, libstdc++ and gcompat (glibc's
  loader names and sonames on musl), about 4 MB, verified with that
  architecture's keys from `alpine-keys`. More: `apk add --root
  /usr/gnemul/qemu-ARCH --arch APKARCH --keys-dir
  /usr/share/apk/keys/APKARCH PKG` (APKARCH `x86` for i386, `armv7` for
  arm). Expect several times slower than native aarch64: qemu's TCG output
  is new code to kwemu.
- **`kw-arch ARCH [command...]`** runs a command (default a shell) with
  `uname` and `arch` reporting x86_64, riscv64, i686 or armv7l, for
  installers that pick their download by `uname -m` (`curl -fsSL
  https://opencode.ai/install | kw-arch x86_64 bash`). Only the commands
  are faked (shims in `/usr/lib/kw-arch`, first on PATH), not `uname()`.
- **Data disk**: `/etc/kw-data.sh` mounts a `kwdata` disk at `/data` and
  starts the overlay root (data-disk.md).
- **Known upstream crash, not ours**: `time nosuchcmd` prints status 127
  and then segfaults at address 0 (exit 139; checked 2026-11-19, busybox
  1.37.0-r31, musl 1.2.6-r3). busybox `time`'s vfork child calls `exit()`
  when exec fails. musl's `exit()` stores the caller's tid in a static
  `exit_lock` to catch re-entry, and the child shares the parent's memory
  and thread pointer. When the parent then calls `exit()` it finds its
  own tid there and hits `a_crash()` (`strb wzr, [x0]` at
  `ld-musl-aarch64.so.1` `exit+0x78`). The fix belongs in busybox (the
  child should call `_exit`). If a vfork child crashes or exits oddly,
  rule this out before suspecting `CLONE_VM` in kwemu or arch/wasm.
  `qemu-aarch64` does not reproduce it, because qemu-user runs vfork as a
  plain fork.

## Guest tools (`kernel/guest/*.c`)

- `kwvsock connect PORT [CID]` and `kwvsock listen PORT` pipe stdin and
  stdout over a vsock connection.
- `kwtty serve [PORT]` (from inittab) serves sessions to the host on vsock
  port 1022 (privileged, so no unprivileged program can take it; only CID
  2 may connect, since there is no authentication). Each connection gets
  its own pty, size and resizes, and root's login shell or the program the
  host names (argv, working directory, environment), and a hangup when the
  host closes. The environment starts with HOME, USER, LOGNAME, SHELL, TERM
  (on a pty, or when the host sets it) and a login shell's PATH. With PIPES
  the program gets stdin, stdout and stderr pipes instead, in a session of
  its own (a hangup goes to its process group), and EOF closes its stdin.
  With CONNECT there is no program: kwtty connects to a TCP port on
  127.0.0.1 and relays bytes, passing half-closes on (`vm.connect()`,
  `vm.fetch()`, the CLI's `--forward`). The protocol is described at the
  top of `kwtty.c` and `js/core/tty.ts` (js.md). `socket(AF_VSOCK)` works
  without a transport, so kwtty asks `/dev/vsock` for the local CID
  (`IOCTL_VM_SOCKETS_GET_LOCAL_CID`) and, without a device, sleeps in
  `pause()` instead of exiting, so init does not respawn it every second.
- `kw9p NAME DIR [ro]` mounts a host file system (devices.md, 9p); the SDK
  runs it through kwtty.
- `kwshm memfd SIZE [SEED]` and `kwshm export FILE` export a patterned
  memfd or a file and print its id.
- `glimmer` is a small game for the display, keyboard and mouse at any
  size, with synthesised sound effects when there is a sound card (22050 Hz
  stereo through the raw ALSA ioctls, about 46 ms queued; M or Tab mutes,
  `--no-sound`). `glimmer --test` draws a fixed pattern, plays 1 s each of
  440 Hz on both channels, 660 Hz left and 880 Hz right, and prints every
  input event; `node test/glimmer-check.mjs --run` checks all three from
  the host (`--no-sound`: without a sound card).

## Ubuntu (`kernel/build.sh ubuntu`, `guest/ubuntu-disk.sh`)

Ubuntu Base 26.10 arm64 (glibc 2.44, dpkg, apt 3.3, perl-base, uutils
coreutils; no init system, no python;
`ubuntu-base-26.10-base-arm64.tar.gz` from
`cdimage.ubuntu.com/ubuntu-base/releases/26.10/release/`, SHA-256 pinned in
`tools/env.sh`, `UBUNTU_TARBALL=file` overrides) as
`vendor/build/disk/ubuntu.ext4`, 2 GiB sparse (`DISK_SIZE`), about 165 MiB
allocated, built like the Alpine disk. Its arm64 baseline is ARMv8.0
(glibc sees `AT_HWCAP` 0x2209fb and no SVE, BTI or MOPS). The tarball has
no device nodes, xattrs or file capabilities; its two hard links survive
`mke2fs -d`; `ext4-owners.py` restores owners and setuid/setgid bits
(`su`, `passwd`, `mount`, `unix_chkpwd` root:shadow,
`/var/cache/apt/archives/partial` owned by `_apt`). The script adds:

- `/sbin/init` -> `/usr/local/sbin/kw-init`, a bash script as PID 1: it
  mounts `/proc`, `/sys`, `/dev/pts`, `/dev/shm` and `/run` (fstab), runs
  `kw-net`, and starts `bash -l` on the console in its own session. When
  that shell exits, or on `poweroff`/`reboot`/`halt` (wrappers in
  `/usr/local/sbin` that signal PID 1, and defer to the system's own once
  an init system is installed), it kills everything, remounts `/`
  read-only (`kw-shutdown: / is clean`) and calls reboot(2) through perl.
- `/usr/local/sbin/kw-net`: Ubuntu Base has neither iproute2 nor a DHCP
  client, so this perl script sets lo up and eth0 to 10.0.2.15/24, gateway
  10.0.2.2, with the classic ioctls; `/etc/resolv.conf` points at
  10.0.2.3.
- hostname, hosts, fstab, a `TERM` fix, and a drop-in that logs root in on
  hvc0 once systemd's `serial-getty@hvc0` exists.

```sh
node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --snapshot          # root shell; poweroff
node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --snapshot --append "console=hvc0 root=/dev/wda rw init=/bin/bash"
node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --mem 1024          # persistent: apt-get update && apt-get install ...
node js/cli.ts --disk vendor/build/disk/ubuntu.ext4 --mem 1024 --input '{5}apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv udev dbus && poweroff\n'
```

Measured 2026-11-18 (x86-64, Node 24, JIT on, `--mem 1024`): `apt-get
update` (20.4 MB of indexes) 29 s; `apt-get install --no-install-recommends
htop` 8 s; systemd, systemd-sysv, udev and dbus (13 packages) 23 s. After
an apt run that replaced a file kw-init's bash has mapped (installing
systemd does), the read-only remount at poweroff fails with "mount point
is busy"; ext4's journal recovers at the next mount.

**systemd** 261 runs as PID 1 once installed (`systemd-sysv` replaces
`/sbin/init`; `init=/usr/local/sbin/kw-init` still boots the plain shell,
with the network, which nothing configures under systemd yet). udev is
needed: without it `dev-hvc0.device` never appears and the console getty
times out after 90 s. 2026-11-18: `Startup finished in 183ms (kernel) +
8.116s (userspace)` (graphical.target), `systemctl is-system-running`
says `running`, no failed units, 38 processes; `poweroff` goes through
systemd's shutdown. What it copes without: `bpf` (BPF_SYSCALL off) and
`keyctl` (KEYS off) return ENOSYS (no BPF firewalling or device control,
no session keyrings); no seccomp (`SystemCallFilter=` skipped), no IPv6, no
`SO_PASSSEC`, only the `pids` cgroup controller, no modules, missing
sysctls (`kernel/core_pattern`, IPv6 `use_tempaddr`, `yama/ptrace_scope`).
The config it needs is in config.md.
