# Remote mode

The remote backend runs unkernel's kernel on this computer and serves the web
desktop from `http://127.0.0.1:8787/?remote=1`. The page is the same web app
as in a browser; the kernel, the data disk and the distro images stay on this
computer, and the page talks to the kernel over a WebSocket. One kernel runs
at a time, with one CPU.

The backend is Bun code (`remote/cli.ts`, `remote/server.ts`, `remote/backend.ts`).
Bun is its only requirement at run time: a release carries the backend bundled
into one file, the page, and the kernel.

## Linux and macOS, from a release

Needs [Bun](https://bun.sh) 1.4.5 or newer (`curl -fsSL https://bun.sh/install | bash`,
then `bun upgrade`), `curl` or `wget`, `sha256sum` or `shasum`, and `unzip`
(or `bsdtar`, or `python3`).

```sh
curl -fsSL https://github.com/ArnoChenFx/unkernel/releases/latest/download/update.sh | sh
# or download update.sh from a remote-v* release, then:
sh update.sh
```

The first run installs the newest release under `~/.unkernel/app`, starts the
backend and opens the page. Later runs of `~/.unkernel/app/update.sh` download
only the files that changed and start the new version;
`~/.unkernel/app/start.sh` starts the installed version without updating.
Ctrl+C stops the backend after it saves the guest's disk (the scripts `exec`
Bun, so the signal reaches it directly). Same layout, checks and atomic switch as
the Windows updater, with `current.txt` for the running version and
`update.lock` against concurrent runs; the data directory (`~/.unkernel/remote`)
is never touched.

| `update.sh` option | Meaning |
| --- | --- |
| `--check` | Report whether an update is available; change nothing. |
| `--no-update` | Start the installed version without contacting GitHub. |
| `--no-start` | Install or update, then do not start the backend. |
| `--tag remote-v...` | Install that release instead of the newest. |
| `--force` | Reinstall the release even when it is installed. |
| `--repo owner/name` | The fork whose releases are used. |
| `-d DIR`, `--dir DIR` | The install directory (default `~/.unkernel/app`, or `UNKERNEL_APP`); absolute or relative. |
| `--data`, `--work`, `--cache`, `--port`, `--config`, `--no-net`, `--no-open` | Passed to the backend through `start.sh` (see Settings). |

With the one-liner, pass options after `sh -s --`, for example
`curl -fsSL .../update.sh | sh -s -- --no-open --port 8790`.

## Windows, from a release

1. Install Bun: `powershell -c "irm bun.sh/install.ps1 | iex"`.
2. Download `update.ps1` (or `update.cmd`) from a `remote-v*` release of the
   fork, [ArnoChenFx/unkernel](https://github.com/ArnoChenFx/unkernel/releases).
3. Run it: `powershell -ExecutionPolicy Bypass -File update.ps1`.

The first run installs the newest release under `%USERPROFILE%\.unkernel\app`,
starts the backend and opens the page. Later, run
`%USERPROFILE%\.unkernel\app\update.cmd`: it fetches the newest release,
downloads only the files that changed, and starts it. Its options:

| Option | Meaning |
| --- | --- |
| `-Check` | Report whether an update is available; change nothing. |
| `-NoUpdate` | Start the installed version without contacting GitHub. |
| `-NoStart` | Install or update, then do not start the backend. |
| `-Tag remote-v...` | Install that release instead of the newest. |
| `-Force` | Reinstall the release even when it is installed. |
| `-Repo owner/name` | The fork whose releases are used (default `ArnoChenFx/unkernel`). |
| `-Dir DIR` | The install directory (default `%USERPROFILE%\.unkernel\app`, or `UNKERNEL_APP`). |
| `-Data`, `-Work`, `-Cache`, `-Port`, `-Config`, `-NoNet`, `-NoOpen` | Passed to the backend (see Settings). |

Running `update.ps1` needs PowerShell 5.1 (built into Windows) or PowerShell 7.

### What an update does

- It takes the newest `remote-v*` release of the fork and reads its
  `manifest.json`, which lists every file of the install with its size, its
  sha256 and the asset that holds it.
- A file already installed with the same sha256 is reused. An archive is
  downloaded only when one of its files changed: the app archive and the kernel
  archive are named by the hash of their files, so the kernel archive keeps its
  name and its bytes when only the app changed. Distro images are not in the
  release's archives: the manifest names their upstream release URLs and hashes,
  and an image is downloaded only when it is not in the installed version.
- Every download is checked against the manifest before anything is installed.
  The new version is assembled in `partial-<tag>` and renamed to
  `versions\<tag>`; `current.txt` is then replaced by a rename. A failed update
  leaves the running version in place: when one is installed, it starts that
  version with a warning, and the update exits with an error only when nothing
  is installed yet, or with `-Check`.
- The previous version stays in `versions\` until the next update.

### Layout

```
%USERPROFILE%\.unkernel\app\
  versions\<tag>\          one install, at the paths of the repository:
                           remote\ (the backend bundle and its worker, the start
                           scripts, the updater, the example settings, this
                           README), web\.output\ (the page, its kernel, GL
                           renderer and Vulkan translator, the distro images),
                           LICENSE*, and
                           manifest.json, the release's manifest
  current.txt              the tag that runs
  update.ps1, update.cmd   the launchers; update.ps1 hands over to versions\<current>\remote\update.ps1
                           (Linux and macOS: update.sh, start.sh under ~/.unkernel/app, the same way)
  unkernel-remote.json     the settings file for installs (optional, kept across updates)
  downloads\, partial-*    transient, while an update runs
%USERPROFILE%\.unkernel\remote\   the data disk, /work and the distro cache: updates never touch them
```

## From a source checkout

Needs Node 24, pnpm (`corepack enable`) and Bun. In the checkout:

```
git pull
remote\start-windows.cmd -Rebuild
```

`-Rebuild` runs `pnpm build:web`, which fetches the kernel from the upstream
release the checkout names (`web/kernel/`). Without `-Rebuild`, the start uses
the existing web build, and builds it when it is missing. On other systems,
run `bun --bun remote/cli.ts [options]` after `pnpm build:web`.

## Settings

Each setting comes from the first of: a flag, an `UNKERNEL_REMOTE_*` variable,
the settings file, and the default.

| Setting | Flag | Variable | Default |
| --- | --- | --- | --- |
| `data` | `--data FILE` | `UNKERNEL_REMOTE_DATA` | `~/.unkernel/remote/data.img` |
| `work` | `--work DIR` or `none` | `UNKERNEL_REMOTE_WORK` | `~/.unkernel/remote/work` |
| `cache` | `--cache DIR` | `UNKERNEL_REMOTE_CACHE` | `~/.unkernel/remote/cache` |
| `web` | `--web DIR` | `UNKERNEL_REMOTE_WEB` | the page of the install or checkout |
| `port` | `--port N` | `UNKERNEL_REMOTE_PORT` | `8787` |
| `net` | `--no-net`, `--net on\|off` | `UNKERNEL_REMOTE_NET` | on |

The settings file is JSON with those keys (`remote/unkernel-remote.example.json`).
It is read from `--config FILE`, from `UNKERNEL_REMOTE_CONFIG`, or from
`remote\unkernel-remote.json` of the checkout when that exists. For an install,
put it at `%USERPROFILE%\.unkernel\app\unkernel-remote.json`: the updater passes
it on, and it survives updates. Relative paths in the file are relative to the
file.

`remote\start-windows.ps1` stops the backend on Ctrl+C: it saves the guest's
disk first and releases the data disk's lock (`<data>.lock`).

## Guest GL (experimental)

`?gl=1` runs the guest's 3D on the browser's WebGL2. On `/kiosk?gl=1` and on
`/?remote=1&gl=1` (with an image that has virgl: Omarchy or Debian), the
kernel and the disk stay on the backend. Its virtio-gpu 3D commands cross the
link to the page, where the virgl renderer (`virgl.mjs` and `virgl.wasm` of the
bundle, `js/core/gl-gpu.ts`) runs them. The kiosk draws the guest's scanout from
the renderer's bitmap, so the frame is not read back through the backend.

- Without the query the CPU path is the default, and the page says that guest GL
  is off and why. The 2D virtio-gpu (dumb buffers) stays on either way.
- The page's WebGL2 must work. The kiosk's corner note names the WebGL2
  implementation. Where that is a software rasterizer (SwiftShader, llvmpipe)
  the note says `software, not a GPU`: the guest's GL is correct there, but
  it is no GPU and its speed says nothing about one.
- One page owns the kernel. A second page takes it over, and the first one
  says so (`The machine stopped`); reloading that page takes the kernel back.
- A lost WebGL2 context ends the guest's GL programs: the note says so, and
  the picture stays as it was. Reload the page to start them again.
- Vulkan is still off (`?vk`).

The guest's texture uploads cross the link to the page: about 1.1 MB per drawn
frame in a terminal that scrolls (measured 2026-11-25). The CPU path sends each
RGBA frame to the page and gets its buffer back, about 3.7 MB each way per frame.

Tested on 2026-11-25 with the Omarchy image in headless Chrome 157 on Linux,
where WebGL2 is SwiftShader. Windows Chrome is not tested.

## Release and sync (maintainers)

Two workflows in `.github/workflows/` publish this fork's releases. Both use
only the workflow's `GITHUB_TOKEN`; the repository holds no secrets.

### Releases: `remote-release.yml`

It makes the release of a `remote-v<...>` tag that points at a commit of
`main`. It runs when such a tag is pushed, when it is started by hand with the
tag as its input, and when `remote-sync.yml` calls it. The tag is created at
that commit when it does not exist. A release of the tag that is not a draft is
left as it is; a draft left by a run that was cut off is replaced.

The build checks the code (`pnpm typecheck`, `pnpm typecheck:web`, the remote
tests), builds the page with `pnpm build:web` (the kernel and the distro images
come from the newest release of `pithings/unkernel`; a local build is never
used), installs Bun 1.4.5 (checked against its sha256), packs the release with
`remote/scripts/release.ts`, and smoke-tests the install with
`remote/scripts/smoke.ts`: Bun runs the bundle, the page is served, the kernel
boots and stops, and the data disk's lock is released. The release is created
as a draft with these assets, and published as the latest release once they are
all uploaded:

- `unkernel-remote-app-<hash>.zip`: the backend bundle and its worker, the page
  without its kernel, the start scripts, the updater, the example settings and
  the docs;
- `unkernel-remote-kernel-<hash>.zip`: the page's kernel (UP and SMP), the GL
  renderer and the Vulkan translator (`kwvk-naga`), all from the upstream release;
- `manifest.json`: every install file with its size, sha256 and asset, and the
  upstream distro images with their URLs and sha256;
- `update.ps1`, `update.cmd`, `update.sh` and `start.sh`, for the first download.

An archive's `<hash>` is the hash of the files it holds, so an archive changes
its name only when one of its files changes.

### Sync: `remote-sync.yml` and `remote/scripts/sync-upstream.sh`

The sync runs daily at 04:23 UTC, and on demand (`force_release` releases
`main` even without new upstream commits). It merges `pithings/unkernel`'s
`main` into this fork's `main` with a merge commit: nothing is rebased, and
nothing is force-pushed.

- Nothing new upstream: nothing happens.
- New upstream commits, merged cleanly: `main` is pushed, and the merge commit
  is released as `remote-v<YYMMDD>-<sha7>`.
- A conflict: `main` is not pushed. The conflicted merge goes to
  `upstream-sync/<sha7>`, and one draft pull request for that branch is opened.
  Resolve the conflict on that branch and merge the pull request by hand. Then
  release `main` with a run of `remote-sync.yml` with `force_release`, or start
  `remote-release.yml` by hand with a new tag. Pull requests are never merged
  automatically.

A push made with `GITHUB_TOKEN` starts no other workflow run, so the sync cannot
release by pushing a tag. It calls `remote-release.yml` (`workflow_call`) in the
same run, with the tag and the commit it has merged. If that release fails,
`main` keeps the merge: fix the problem on `main`, then start `Remote release`
by hand with a new tag.

`remote/test/sync.test.ts` runs the script on temporary repositories with a fake
`gh`.

### Prerequisites on the fork

- GitHub Actions enabled.
- Settings > Actions > General > "Allow GitHub Actions to create and approve
  pull requests": the conflict's draft pull request needs it.
- No branch protection on `main` that stops `github-actions[bot]` from pushing
  the merge commit.
- A public repository's scheduled workflows are disabled after 60 days without
  activity; enable `Remote sync` again under Actions when that happens.

### By hand

`remote/scripts/release.ts` builds the same assets on a machine: set `BUN` to a
Bun binary, run `pnpm build:web`, then
`node remote/scripts/release.ts --tag remote-v<...> --repo owner/name --commit <sha>`.
It writes the assets to `remote/dist/`, and the install to `remote/dist/install/`.

## Upstream files

The remote mode adds no code to upstream's own paths except the four hooks
below. They are the only upstream-owned files the fork changes, so they are the
only ones that can conflict with upstream changes. The fork does not edit
upstream's docs (README.md, AGENTS.md, .agents/, guest/, kernel/, vk/): the
notes on the fork's differences live in this file and in
`distros/omarchy/README.md`.

- `web/src/boot.ts`: the remote branch of boot (a connection to the backend
  instead of a kernel in this page, the data disk as a file on the backend's
  computer, and the storage and suspend actions that the backend does not offer).
- `web/src/config.ts`: the `remote` field of the page's configuration, and
  `GL_DISTROS`, which includes Omarchy beside Debian (the last section of
  `distros/omarchy/README.md` has the difference from `.agents/web.md`).
- `web/src/main.tsx`: the page's configuration is read through `remote/web/page.ts`.
- `web/scripts/kernel.ts`: the extra distro images of `KW_EXTRA_DISTROS`
  (`remote/scripts/fetch-extra-distros.ts`) join the release's images.

Everything else lives in `remote/`, `distros/omarchy/` and in
`.github/workflows/remote-*.yml` and `omarchy-image.yml`. The ignore rule for
`remote/extra-distros/` is in `remote/.gitignore`.
