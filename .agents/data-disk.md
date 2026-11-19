# Data disk and overlay root

kernel/README.md (Block devices) has the full user-facing description: the
data disk, the overlay root, safe mode, `kw-overlay`, image updates and
cut-off apk runs, plus the tested failure cases. This file lists what a
change must preserve.

## Pieces

- The data disk is an ext4 file system labelled `kwdata` (4 GiB, 4 KiB
  blocks), found with `findfs`, never by device name, and mounted at
  `/data` by `/etc/kw-data.sh` (`kernel/guest/kw-data.sh`) with
  `noatime,commit=1`, `discard` if the device supports it, and 1 s dirty
  expiry.
- Its template, `vendor/build/disk/kwdata.kwsparse.gz`
  (`kernel/build.sh datadisk`), is reproducible (fixed UUID, hash seed and
  timestamps) and is bundled as section `unkernel.datadisk`. The page keeps
  the disk in IndexedDB (`web/src/data.ts`, the SDK's `openDataDisk()`).
  The CLI keeps it in a file (`--data FILE`, created sparse from the
  template if missing).
- With a data disk, the initramfs root is always an overlay (`CONFIG_OVERLAY_FS`):
  `/init` runs `kw-data.sh root`, which runs `/usr/lib/kw-overlay/root`
  (`kernel/guest/overlay/root.sh`). The lower layer is the initramfs, the
  upper and work dirs are `/data/overlay/{upper,work}`, and the switch is
  `pivot_root`, with the old root kept at `/run/kw-lower`. Without the disk
  the plain initramfs root boots. On a disk root, `/data` is only
  mounted.
- `/etc/kw-shutdown` stops all processes, then unmounts `/data`, or under
  the overlay root remounts `/` and `/data` read-only, so ext4 is clean.

## Invariants

- **Never use busybox `switch_root`.** It empties rootfs, which is the lower
  layer. `pivot_root` from the initramfs works because Linux mounts
  rootfs on an immutable nullfs. Rootfs is remounted read-only before the
  switch, because a lower layer must not change while in use.
- **Keep redirect_dir, index, xino and metacopy off.** Only then does
  overlayfs define offline changes to the lower layer, which is what a new
  image under an old upper layer is. Side effect: renaming a directory that
  comes from the image fails with EXDEV, and `mv` falls back to copying.
- **Everything that decides whether to use the upper layer runs from the
  lower layer**: root.sh before the switch, and `bootwatch` from
  `/run/kw-lower` after it. So no change on `/data` can break the decision.
  Keep it that way.
- **Safe mode** boots the plain root with `/data` mounted and leaves the
  upper layer untouched. Triggers:
  - for one boot (every boot checks again): the overlay does not mount,
    the merged root's `/bin/sh` does not run under `chroot`, `/sbin/init`
    is missing, or the inittab has no `respawn`/`askfirst` entry besides
    kwtty's;
  - sticky until `kw-overlay restore`: `/data/overlay/safe` exists. It is
    written after 2 boots in a row that never reached an idle shell prompt
    (`/data/overlay/attempts`, cleared by `bootwatch` or a clean shutdown),
    or by `bootwatch` when the system stays empty for 3 s before a prompt
    (a console shell that keeps exiting). `bootwatch` does not count
    `kwtty` (always running) as activity; a kwtty session's shell at its
    prompt confirms a boot like the console's.
- The console line `kw-overlay: SAFE MODE: <reason>` is what the page
  watches for (`web/src/boot.ts`). Keep that prefix.
- `kw.root=initramfs` on the command line boots the plain root once, with
  `/data`. It is the only `kw.root=` value (page: `?root=initramfs` and the
  *Safe mode* button). Change `/data/overlay/upper` only from such a boot,
  because changing an upper layer while it is mounted is undefined.
- **Image change**: `/usr/lib/kw-image` (stamped by `alpine.sh`, unchanged
  by an identical rebuild) differs from `/data/overlay/lower`. Then
  `/usr/lib/kw-overlay/rebase` merges apk's database copy in the upper
  layer with the new image's, using the old image's package list and world
  in `/data/overlay/image`. Upper copies of new-image package files outside
  `/etc` move to `/data/overlay/rebase-TIME`. It deletes nothing, and a
  rerun gives the same result. It runs offline, before the overlay is
  mounted.
- **Cut-off apk runs**: `/etc/apk/commit_hooks.d/kw-overlay.hook` creates
  the marker `lib/apk/db/kw-commit` before each commit and removes it after.
  If the marker survives, `/usr/lib/kw-overlay/apk-cleanup` removes the
  `.apk.<hash>` temporaries and unowned files newer than the marker at the
  next boot, before the mount.

## Guest architecture

The one place where data on a data disk is discarded without the user
asking: a disk written by a guest of another architecture (riscv64 images
wrote every disk saved before the aarch64 guest). Its upper layer would put
foreign binaries and a foreign apk database over the root, and the user
decided to reset it rather than migrate, keeping only root's home. Keep it
this narrow.

- `/data/.kw-arch` names the architecture (`/etc/apk/arch`) of the guest
  that uses the disk. `kw-data.sh` (`check_arch`) checks it right after it
  mounts `/data`, before `root.sh`, so from the lower layer, for the page,
  the CLI and the SDK alike, and on a disk root too. An image without
  `/etc/apk/arch` skips it.
- Marker equal to this image's: keep. Marker naming another architecture:
  reset. No (valid) marker: reset only on positive evidence of another
  architecture in `/data/overlay/upper` (`etc/apk/arch`, else the most
  common `A:` of `lib/apk/db/installed`, else the ELF machine of the files
  directly in `bin sbin usr/bin usr/sbin lib usr/lib`); with evidence of
  this one or none (a new disk, changes that are not architecture
  specific), adopt it untouched and write the marker. So a disk of this
  architecture is never reset unless someone writes another architecture
  into its marker, or plants a foreign apk database or ELF file after
  deleting the marker.
- What a reset keeps: root's home in the upper layer,
  `/data/overlay/upper/root`, if it is a directory (a whiteout or no entry
  there: nothing to keep). It is moved by rename, so owners, modes, xattrs
  and the whiteouts and opaque markers inside stay exactly as they were,
  and `/root` shows the same files. Its contents are not scanned: foreign
  binaries a user put there stay (and fail with the image's "riscv64
  binary" message). Everything else goes: the rest of the upper layer
  (packages, apk's database and cache, `/etc`, `/usr`, `/var`, other
  homes), the work dir, `lower`, `image`, `safe`, `attempts`, set-aside
  directories, and everything else at the top of `/data` but
  `lost+found`.
- The reset happens in the guest, which has no mke2fs: it creates
  `/data/.kw-reset` (with `from`, the old architecture; built as
  `.kw-reset.new` and renamed), renames every top-level entry but
  `lost+found` into `/data/.kw-reset/N/`, creates an empty
  `/data/overlay/upper` and moves the one `/data/.kw-reset/*/overlay/upper/root`
  into it, writes the marker (tmp file and rename), then deletes
  `/data/.kw-reset`. The result is the template plus the marker and the
  home; `root.sh` then sees a new disk (no `lower`, so no rebase) and
  starts the overlay on that upper layer. A boot that finds
  `/data/.kw-reset` without a matching marker continues the reset (moving
  a half-built `/data/overlay` aside again, home and all, and finding the
  home there); with one it only deletes the directory. The home is in
  exactly one place at every cut, every step can be cut off, and progress
  only moves forward, so it neither loops nor loses `/root`. The host's
  store is not cleared or reseeded.
- A kept home carries `trusted.overlay.origin` xattrs that point into the
  old image's lower layer. With index, xino, redirect_dir and metacopy off
  they are not verified, as after any image update; the new upper
  directory gets its own `trusted.overlay.uuid` at the first mount. Tested
  by booting a riscv64-written disk (no overlay warnings, `/root` intact).
- `kw.root=initramfs` defers a reset that has not started (the disk stays
  as it was, to copy files off); a started one is finished.
- Messages (in `/run/kw-overlay.msg`, printed in yellow after the welcome
  line and listed by `kw-overlay status`):
  `kw-data: RESET: Installed packages and system changes were reset (this
  disk was written by the riscv64 guest, the guest is now aarch64). /root
  was kept.` (the last sentence only when a home was kept); under
  `kw.root=initramfs`, `kw-data: this disk was written by ...: installed
  packages and system changes are reset (/root is kept) at the next boot
  without kw.root=initramfs; ...`. While deleting, `kw-data: deleting what
  the old guest left on /data (keeping /root)...` goes straight to the
  console. The page watches for `kw-data: RESET:` (`boot.ts`: panel note,
  check row, toast); keep that prefix. The CLI and the SDK show the
  console line only.
- Tested by `test/api.test.ts` ("data disk of another guest
  architecture"): a home with a nested directory, a symlink, a dotfile of
  another owner and modes survives every reset byte for byte (names,
  modes, owners, types, contents), while `/etc`, `/home`, a package
  stand-in and a directory at the top of `/data` go and `apk info` is the
  image's again; resets cut off after the first move, after the new upper
  layer, after the home went back and after the marker all end with the
  home intact; `kw.root=initramfs` defers; a marker of the other
  architecture resets; a disk of this one keeps its changes; a whiteout
  home keeps nothing; a new disk and one with an ELF file of this
  architecture are adopted.

## Persistence in the browser

- The store `kwdisk:kwdata-v1` is keyed by the format version, not by the
  template or an ETag. It is never cleared or reseeded implicitly, and a
  new template does not touch saved disks (the guest's own reset of a disk
  from another guest architecture, above, deletes all but root's home on
  it). A layout change needs a new version, plus a migration or the user's
  export/import. If the identity
  (format, size) does not match, the page runs a fresh in-memory disk and
  says why.
- On first use the template's blocks are copied into the store in one
  transaction, which also marks the store initialized.
- The disk has a volatile write cache. Each guest flush saves every block
  written before it in one IndexedDB transaction (durability `strict`) and
  completes when that transaction commits. So the saved state is always the
  state at some completed flush, which ext4's journal handles like a power
  cut. A block leaves memory only after the save that holds it commits.
  Buffers handed to a save are frozen (copied before a later write). Keep
  every save one transaction.
- A failed save leaves its blocks dirty and returns EIO for that flush. The
  page reports it (a full quota as `QuotaExceededError`).
- One tab at a time: a Web Lock (`kwdisk:kwdata`), or a BroadcastChannel
  probe where Web Locks are missing. A tab without the lock gets an
  in-memory snapshot and a warning.
- Worker mode (`?worker=1`): the page still takes the lock,
  then sends the disk as a spec (`{ kind: "data", template: "bundled",
  mode }`, mode "snapshot" without the lock) and the kernel worker opens the
  store and is its only writer while it runs; the page's thread does not
  open `kwdisk:kwdata-v1`. Export asks the worker for the parts. Import and
  reset first ask the worker to detach the disk (stop its saves, wait for
  the one in flight, close its connection), and refuse while the kernel is
  still starting. The worker reports the kernel's exit only after the saves
  in flight have settled, because ending a worker aborts its transactions.
- Machine snapshots do not copy the disk (js.md, Disks in snapshots).
  The store's meta keeps a random `uid` (new when the store is created,
  seeded, imported or cleared) and `gen`, the disk's write generation,
  written in the same transaction as the blocks of the first save of each
  generation. A snapshot records them; a restore refuses the disk if
  either differs, because the restored kernel's ext4 caches (bitmaps,
  inodes, the journal position) would not match it and its next writes
  would corrupt the file system. Never let a restore through with a
  mismatch. A snapshot (the page's suspended session, a CLI `--restore`
  file) made by another guest architecture's kernel is refused anyway:
  its `linux_banner` (the fingerprint) differs, and in builds the page
  compares the hashed kernel URL first. The CLI's file data disk keeps the generation in
  `FILE.kwsnap`. The guest mounts `/data` with `commit=1` and 1 s dirty
  expiry, so a machine that keeps running after a snapshot usually makes
  it unrestorable within seconds; `snapshot({ stop: true })` (the CLI's
  `{suspend=FILE}`, the page's Suspend, web.md) is the way to save a
  machine with its data disk.
- The page calls `sync()` when it is hidden, on `pagehide` and before
  Reboot. Export, import and reset (`KW.exportData()`, `importData()`,
  `resetData()`) first stop the running disk's saves and refuse while
  another tab holds the lock.

## Known limits

- A hang in the console shell (not a respawn loop) needs two boots before
  safe mode. So does a kernel panic from a broken `/sbin/init` that is not
  busybox, because the check only runs `/bin/sh`.
- `apk --no-scripts` skips the commit hooks, so its cut-off runs are not
  cleaned up.
- After a rebase, a package the user had upgraded beyond the image's
  version goes back to the image's version (`apk upgrade` with a network
  brings it forward). A user package that needs a library version that the
  new image dropped is not detected (`apk fix` with a network).
- Set-aside directories (`discarded-*`, `rebase-*`) are never deleted
  automatically.
- There is no e2fsck in the initramfs. After an unclean stop, the journal is
  replayed on the next mount.
