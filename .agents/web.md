# The browser page (`web/`)

A static page: a full-screen terminal ([wterm](https://wterm.dev/)), with
more terminal windows over vsock, a tmux-style status line at the bottom
and terminal-style dialogs, built with React and Tailwind (v4, a black
theme after Vercel's Geist), Vite (client) and Nitro (server and route
rules), on the SDK from source. kernel/README.md (Browser page) describes
it for users.

## Files

`web/index.html` (the inline error bootstrap, and fallback markup that
React replaces), and in `web/src/`: `main.tsx` (entry: config, renders the
app, preflight with the SDK's `checkSupport()`), `config.ts` (URL
parameters, documented at its top), `store.ts` (the UI state, read with
`useStore()`), `ui.ts` (`KW.ui`: the imperative API boot.ts and main.tsx
drive, plus `rebootUrl()`), `shortcuts.ts`, `boot.ts` (terminal and boot,
a separate chunk loaded only after the preflight passes), `windows.ts`
(terminal windows 1-9), `bottom.ts` (keeps a terminal at its bottom when
it gets shorter), `net.ts` (Wisp only), `apk.ts` (apk index prefetch), `readme.ts` (`/root/README`), `download.ts` (files the page fetches for the guest), `sdk.ts`, `kw.ts` (`window.KW`),
`data.ts` (the data disk), `session.ts` (the suspended session), `display.ts` (the guest display's state, the
mode offered, keyboard routing), `audio.ts` (Web Audio output),
`preview.ts` (the guest preview's page side), `fx.ts` (the fx coding
agent's panel: the workspace, the stores, the key mapping), `sw.ts` (the service
worker's registration and the update check), `launcher.ts` (how a demo
runs; the demos are in `src/demos/`), `style.css`
(Tailwind theme, the dialog, wterm's colours). `src/components/`: `App.tsx`
(layout, viewport, key bar visibility, pinch), `Bar.tsx` (the status line), `Launcher.tsx` (its first item and the
launcher overlay),
`Panel.tsx` (the dialog), `Options.tsx`, `Display.tsx` (the display layer,
rotation, mouse and touch input, touch controls), `Keys.tsx` (extra keys),
`Overlays.tsx` (splash, toast, paste and confirm dialogs), `Fx.tsx` (the fx
panel), `About.tsx`
(the status line's triangle and the credits dialog), `Preview.tsx`
(the preview panel), `icons.tsx`. `src/env.d.ts` declares `__KW_BUILD__`,
which `vite.config.ts` defines: the Linux release read from the committed
kernel's banner, the kernel's release tag and the page's commit (empty
where git is missing or the clone is too shallow). `web/public/vm-sw.js` is the page's
service worker (the offline copy and the preview's relay), `web/server/vm.ts` the preview's server fallback.
`web/public/manifest.webmanifest` makes the page installable (standalone, black); its icons
`icon-192.png`, `icon-512.png` (the whole logo at 6x and 16x), `icon-maskable-512.png` (inside the
border, corners filled, opaque) and `apple-touch-icon.png` are `assets/logo.svg` rendered at 32 px
and scaled nearest neighbour (`magick -filter point`).
`web/vite.config.ts` holds the COOP/COEP headers (Nitro route rules, plus
the dev server's own responses), `__KW_BUILD__` and the asset list
`/kw-assets.json`.

## The page's kernel: a local build in dev, the newest release in a build

- The page loads only `web/kernel/unkernel-alpine.wasm` (gitignored): the
  lowered kernel with Alpine bundled, about 10 MB. Building or deploying the
  page needs no kernel toolchain.
- `pnpm dev` runs the file that is there, without a network check.
  `kernel/build.sh bundle` (and so `kernel`, `alpine`, `datadisk`, `all`)
  copies its output there, so the dev server runs your latest local build.
  Only when there is no file does it download one.
- A page build (`pnpm build:web`, a deploy, the browser tests' build) always
  takes the `unkernel-alpine.wasm` attached to the newest non-draft release
  of `pithings/unkernel` (`.github/workflows/release.yml`), so a deploy
  never ships a local kernel. It downloads unless the file's sha256 is that
  release's.
- `web/scripts/kernel.ts` does both, from the `unkernel:kernel` plugin's
  `config` hook in `vite.config.ts`, so before `pnpm dev` serves or
  `pnpm build:web` builds anything. The download runs at build time because GitHub
  serves release assets without CORS (both the `github.com` redirect and
  `release-assets.githubusercontent.com`), so the browser cannot fetch them,
  and CDNs such as jsDelivr only serve files from the git tree.
  `web/kernel/release.json` records the tag and sha256 of the last
  download; a file that does not match it shows as `local` in the About
  dialog. The GitHub API gives the newest release and the
  asset's digest, which is checked. Without `GITHUB_TOKEN` (or `GH_TOKEN`)
  the API allows 60 requests an hour per IP, so on any API failure it reads
  the newest tag from `releases.atom` instead. If GitHub cannot be reached,
  a build keeps the file if it is a release's. Otherwise the build fails.
- `KW_KERNEL=<path>` uses that bundle in a build too (tag `local`), e.g.
  `KW_KERNEL=../vendor/build/bundle/unkernel-alpine.wasm pnpm build:web` to
  run the browser tests on a local kernel. `KW_KERNEL_RELEASE=<tag>` picks a
  release instead of the newest, in dev too.
- A release (the workflow, run by hand) changes a deployed page only once
  the page is rebuilt.
- `web/src/sdk.ts` imports `js/core/index.ts`, `js/web/memory.ts` and
  `js/web/platform.ts`, not `js/web.ts`, whose own bundled kernel would
  become a second 10 MB asset. Its `kernelUrl` becomes a hashed Vite asset,
  which the Node server sends precompressed (br, zstd, gzip). Compressed
  responses have no decoded length, so there is no download percentage.

## Rules

- Every URL parameter except `?simulate` has a control under Options in
  the System tab (`Options.tsx`, the store's `options`, `rebootUrl()`). A
  new parameter needs one too. The desktop test checks the mapping. The
  fields are controlled, and also read by native listeners on the form,
  because React drops change events for a value set from script (the test
  does that).
- `window.KW` is what the browser tests read, together with the element
  ids: `#bar-win-N` (window N), `#bar-new`, `#bar-display`, `#bar-log`,
  `#bar-errors`, `#status` (its CSS `color` turns red on an error) and
  `#status-label`, `#panel` (class `open`), `#confirm`. Keep them working.
- Safe areas are the CSS variables `--st`, `--sr`, `--sb`, `--sl` (style.css). On iOS,
  `--sb` is 0: the page keeps the top inset but takes the whole height below it, and the
  status line moves its ends in by `--sc` (half the bottom inset) for the round corners.
  In a home screen app (standalone) `App.tsx` sizes `#app` to the screen's height,
  rounded down, unless the keyboard is up, because iOS can report a shorter viewport there.
- An unknown or failed boot step must end in `ui.fail(...)`, so the
  indicator turns red and the panel opens. The page must never stay blank.
- Keyboard shortcuts (`shortcuts.ts`): Ctrl-A is a prefix as in GNU
  screen, and ⌘A too on Apple devices (it takes nothing from the guest). Digits
  are windows, as in screen and tmux (also Ctrl-Shift-digit, which
  terminals and browsers leave unused), so new shortcuts use letters. New
  window is n or c (as in tmux); the launcher is o, also ⌘K on Apple devices
(a `meta` code in COMMANDS; Ctrl-K is readline's kill-line, so not that
elsewhere) and Ctrl-Shift-O; Copy diagnostics is y after the prefix
  and c inside the dialog. The listener is
  on window in the capture phase and is added before display.ts's, so the
  shortcuts work while a program holds the evdev keyboard; key-ups always
  pass, so a Ctrl the guest saw go down comes up.
- The dialog is modal and keyboard-usable (`aria-modal`, `inert` while
  closed, ARIA tabs, focus trapped and returned). Options are real inputs,
  so keyboards and screen readers work on them. Questions use `ui.ask()`,
  a native modal `<dialog>`, never `confirm()`; it releases pointer lock
  first.
- Display and input: the mode offered to the guest is the stage size in
  CSS pixels (turned when the rotate chip is on), and the canvas is scaled
  to fit. While a program has the evdev keyboard open, keys go to it and
  not to the terminal. With the tablet open the pointer goes there as
  absolute positions and nothing locks; this wins when both mice are open.
  Otherwise a click with the relative mouse open takes pointer lock. Phone
  keyboards send no usable keydowns, so a hidden input's value is diffed
  against a sentinel and sent as US-layout key presses. Pointer positions
  under rotation go through `unturn()`/`localPos()` (Display.tsx). Touch
  layout choices are in localStorage (`kw.*`).
- Terminal windows (`windows.ts`): 1-9 are `vm.spawn()` sessions (js.md),
  each its own wterm. Output is read all the time, shown or not, since an
  unread `Pty` blocks its programs; the reader takes the next chunk only
  after `write()` returned and yields a task (a MessageChannel, which
  background tabs do not throttle) every 16 ms or 256 KiB. `KW.windows`
  is their API. Checked by hand only (no browser test yet).
- `?worker=1` (experimental) boots through the SDK's worker mode (js.md):
  the page compiles the kernel and passes the `WebAssembly.Module`; disks
  and the network are specs built in the worker. The data disk in worker
  mode follows data-disk.md (Persistence in the browser). `KW.kernel` and
  `globalThis.kernel` stay unset, so the browser tests (whose
  `page.type()` uses `kernel.sendInput()`) run inline only. Every way the worker can fail
  ends in `ui.fail`.
- Sound is an AudioWorklet fed by postMessage, because the kernel calls
  the import from a busy main thread; scheduled buffers are the fallback
  where there is no secure context. Checked by hand only.
- Every response carries COOP/COEP. A secure context is therefore
  cross-origin isolated, which worker mode's shared transport needs (the
  kernel's own memory is not shared). Anything cross-origin that the page
  loads must send CORP (WebSockets are exempt).
- The guest network is Wisp only. A page served from an origin outside the
  Wisp server's allow list needs its own Wisp server (js.md). A `ws://`
  server is blocked as mixed content on an `https://` page.
- apk index prefetch (`apk.ts`, described at its top): once user space
  runs, the page pushes the guest's missing or stale APKINDEX files into
  `/var/cache/apk` through `vm.exec()`, so apk skips its own index download.
  That covers the enabled repositories and the lazy ones in
  `/etc/kw-apk-lazy` (community), which kw-apk-install reads before it
  enables one (kernel/README.md). It fetches them as plain http over its own Wisp connection (the mirrors
  send no CORS headers; apk checks the signature on every load) and keeps
  them in the Cache API (`kw-apk-index-v1`), revalidated after 1 h. The
  pushed file's mtime is the time the mirror last confirmed it. Off with
  `?net=0`.
- `/root/README` (intro notes) comes from the page, not the image:
  `readme.ts` writes it through `vm.exec()` once user space runs. A stamp
  (`/var/lib/kw-readme`, the sha256 of the copy written) keeps it from
  overwriting a README the user edited or bringing back one they deleted;
  an unedited copy is replaced when the text changes. Keep its shortcuts
  and claims in step with the page.
- The safe-mode explanation comes from watching the console for
  `kw-overlay: SAFE MODE:` (`boot.ts`, see data-disk.md).
- A guest `reboot` (halt code 2) reloads the page once the last data-disk
  save has committed, at most 3 times a minute per tab (sessionStorage
  `kw-auto-reboot`); then the page stays halted and says why.
- Kernel messages go to the Kernel log tab; during boot only the newest
  shows on a transient line, and IMPORTANT ones (`js/core/console.ts`) are
  written in full. Once user space prints, "Started Linux", the "Booted
  in" summary, two notes (the repository as an OSC 8 link, and how to
  open the demo launcher; not on a resumed session), with Pip from the
  logo (`assets/logo.svg`) in truecolor half blocks to their left when
  the terminal is wide enough, and the buffered
  user-space output follow; nothing is scrolled away or erased. The desktop test checks the order.
- wterm (`@wterm/dom`, Apache-2.0; xterm.js was dropped because its touch
  scrolling had no momentum) renders rows as DOM text, and `#term` (and
  each `.term-win`) is itself the scroll container, so `#term` must not
  set `overflow`. When it gets shorter while scrolled to the bottom,
  App.tsx puts it back at the bottom before wterm refits (wterm would
  otherwise show the prompt behind the keyboard). React renders `#terms`
  and `#term` once and never touches them again. wterm takes the row
  height from `--term-row-height`, so `setTermFont()` sets both together.
  `KW.screenText()` reads its core directly, because `readText()` is async.
- Phones never zoom the page: a pinch sets the font size, two-finger
  touchmoves and Safari's `gesture*` events are cancelled (iOS ignores
  `user-scalable=no`), and wterm's hidden textarea is 16 px, because iOS
  zooms on focusing a smaller field.

## Suspend and resume

Suspend (Ctrl-A s, `s` in the dialog, the dialog footer's `#suspend`, the
status line's pause icon `#bar-suspend` while the system runs, or
`KW.suspend()` without asking) saves the running machine with the SDK's
`snapshot({ stop: true })` (js.md, Snapshots), inline or in worker mode, and
stops it. The page then shows "Suspended", the store's `suspended` is set,
and a Resume card (`#resume`, Overlays.tsx) sits at the bottom of the stage,
with a play icon `#bar-resume` in the status line. Resume (`ui.resume()`)
sets sessionStorage `kw-resume` and reloads the same URL; the load reads it
once and resumes without asking. A plain load offers to resume (`ui.ask`
with Resume and Boot fresh) before the kernel starts.

- `session.ts` keeps one session in IndexedDB `kwsnap:session-v1`, its own
  database: `meta` (time, the page's kernel URL, the banner, the device
  options, the disks' snapshot state, the console's last 64 KiB) and
  `bytes` (the `encodeSnapshot()` Blob), written in one transaction. It
  never opens `kwdisk:kwdata-v1`.
- Offered only when the kernel URL (a hashed asset: another release cannot
  resume) and the device options (Display, Sound, Network, Data disk) are
  as saved, and inline when `snapshotDiskMismatch()` passes on the opened
  data disk. A disk that changed makes the session useless, so it is
  deleted then. In worker mode the worker checks the disk; a tab without
  the disk lock is not offered it. Any refusal (a disk, a device, another
  kernel build) boots fresh with a warning line and a toast. Boot fresh
  deletes the session when it has a data disk (the fresh boot changes the
  disk), else keeps it. A resumed or refused session is deleted.
- On resume the terminal shows "Resumed the session suspended …", the
  summary, then the console's saved tail (the guest redraws nothing).
  Terminal windows 1-9 and network connections do not survive (their vsock
  and TCP ends are reset).
- No save when the tab goes away: a save needs the kernel to park, the
  memory copied and encoded (about 150 ms with the CLI, 2026-11-15) and
  about 30 MiB committed to IndexedDB, and a closing page has no
  guarantee that a transaction it starts commits. A snapshot without `stop`
  when the tab is hidden would not help: the guest writes `/data` within
  seconds, which makes it unrestorable.
- Checked by hand only (no browser test).

## Offline and updates

In a production build on a secure context, the page's service worker
(`public/vm-sw.js`, registered by `sw.ts` at scope `/`) keeps an offline
copy in the Cache API `kw-app-v1`. It never touches other caches
(`kw-apk-index-v1` is apk.ts's).

- Answers: a navigation to `/` (any query) gets the cached page at once,
  and the worker fetches `/` in the background (`refresh()`). Other
  navigations go to the network, with the cached page as the offline
  fallback. The page's own GETs under `/assets/` (the hashed build files,
  the kernel among them) come from the cache. A miss is fetched and cached.
  Everything else goes to the network: once the worker has seen that a
  client is not a preview (`pageClients`, kept until the worker stops),
  it leaves that client's other requests alone, as if there were no
  worker. A request it does pass on and that fails reaches the page as a
  network error (`Response.error()`), not as an uncaught error in the
  worker. A new build's precache fetches 4 files at a time, since the
  page may be loading the kernel meanwhile. The kernel's fetch asks `no-cache`
  (js/core/load.ts); the worker answers from the cache anyway, which is
  correct because the names are hashed.
- Updates: when the fetched `/` differs from the cached one, the worker
  reads `/kw-assets.json` (every file under `assets/`, emitted by the
  `unkernel:asset-list` plugin in vite.config.ts) and caches every file
  missing from it, then stores the list and then the page. So the cached
  page always has all its files, and a load from it never needs the
  network. A list that does not name the page's entry script (two deploys
  mixed) aborts, and the next load tries again. The cache keeps the
  current build's files and the previous list's (`/kw-assets.json?prev`:
  an older tab may still load a chunk); older ones are deleted.
- The page asks: boot.ts calls `watchUpdates()` once the kernel has
  downloaded (on a first visit the worker's precache then comes from the
  HTTP cache, since `/assets/` is immutable, not a second download), and
  again when the tab is shown after an hour. It posts `{t: "kw-check",
  entry}` with its own entry script. The worker answers `update` only
  when its own network check (just now, or within 10 s) found a build
  other than the asking page's and has cached all of it. `offline`
  means the page's own build is the cached one. The System tab's
  "Offline copy" row shows the result. On `update`, `ui.updateReady()`
  shows `↑ update` (`#bar-update`) in the status line, plus a toast. Its
  click (`ui.confirmUpdate()`) asks first while the system runs or a
  session is suspended (a new kernel cannot resume it), then reboots
  with the disks saved (`ui.reboot()`). The page never reloads by itself.
- The first visit after a deploy runs the old build; the next load runs
  the new one. A shift-reload bypasses the worker and loads from the network.
- Under `pnpm dev` the scope stays `/vm/`, so nothing of Vite's is cached.
  The worker checks its own scope (`APP`), and activation deletes
  `kw-app-*` caches there. Pages from before the offline copy registered
  the same script at `/vm/`; `sw.ts` unregisters that registration once
  `/` is active. `/vm-sw.js` and `/kw-assets.json` are `no-cache`.
- Checked by hand only, plus a scratch run on 2026-11-15 (headless
  Chromium, two builds on one port). Load 1 downloaded the kernel (5.6 MB
  on the wire). Load 2 took it from the worker, with 0 bytes on the wire.
  With the server stopped and the network off, the page booted to a shell
  prompt. After a new deploy, the old build loaded, then `#bar-update`
  showed, and a reload ran the new build. No browser test.

## Guest preview

A web server running in the guest (say on port 8000) shows in a panel
docked right of the stage (`Preview.tsx`), or in a tab of its own, at
`/vm/<vmId>/<port>/<path>`. The vmId is random per booted kernel
(`preview.ts`). Ways to open it: Ctrl-A p (it opens on the last port, or
8000; pressed again it hides or shows the panel), the Preview section in
the System tab, the status line's globe icon on the right (`#bar-preview`,
which hides and shows it; the port is in its tooltip), and `KW.preview.open(port)`. On wide screens the panel takes part of the
stage's width, so the terminal (and the display offered to the guest) gets
narrower; its left edge sets the split (localStorage `kw.previewSplit`,
default 40%) and `[□]` fills the stage. On narrow ones (under 720 px) it
fills the stage. While it covers the stage it is a view like a terminal
window or the display: picking one of those (`windows.ts` `select()`,
`toggleDisplay()`) hides it, and the status line marks only the globe as
current. Hidden, the terminal gets its width back. It has a port field, reload,
and a link that opens the URL in a new tab. It is no URL parameter, so it
has no Options control.

- Relay: `public/vm-sw.js`, a plain script served at `/vm-sw.js`, outside
  the TypeScript build: the page's one service worker (scope `/` in a
  production build, `/vm/` under the dev server; Offline and updates). The
  relay is stateless, because
  browsers stop idle service workers. For each request it posts
  `{t: "kw-vm-fetch", vmId, port, method, path, headers, body}` (path
  includes the query, body is an ArrayBuffer or null) with a
  MessagePort of its own to every window client that is not under `/vm/`
  (`clients.matchAll({type: "window", includeUncontrolled: true})`). The
  page whose vmId matches answers `accept` at once, and other tabs
  ignore the message. Then come `head` (status, statusText,
  headers), `chunk` messages (transferred ArrayBuffers), and then `end`, or
  `error` (an HTTP status before `head`). The worker sends `more` when its
  body stream pulls and `cancel` when the stream is cancelled. The page
  may send 4 chunks ahead of `more`. Transferable streams are not used,
  because Safari lacks them. With no `accept` within 5 s the worker
  answers 502 with a short text. If the guest sends no head within 60 s
  after the accept, it answers 504. `/vm/<id>/<port>` without the slash
  gets a 308 to the slash.
- Page side (`preview.ts`): boot.ts calls `attachPreview(vm)` once the
  kernel runs, and `attachPreview(null)` at exit; requests then get 503. The
  first call registers the worker (`sw.ts`, shared with the offline copy),
  only where `navigator.serviceWorker`
  exists (secure contexts). The window waits until the worker is
  active. It does not use `navigator.serviceWorker.ready`, which never
  resolves under the dev server, whose scope `/vm/` does not control the page. Requests go
  to `vm.fetch("http://localhost:<port><path>", {method, headers, body,
  redirect: "manual", signal})` (the SDK's, js.md, which follows no
  redirects and does not decode bodies). preview.ts needs only its
  `GuestFetcher` interface. At most 8 relayed requests run at once and the rest queue,
  because each guest connection forks a server process. Request headers
  lose hop-by-hop ones and `host`/`content-length`. `accept-encoding` is
  `identity`, because the browser does not decode a synthesized response.
  `origin` becomes `http://localhost:<port>`, so CSRF checks see the guest's
  own origin.
- Response headers: the worker drops hop-by-hop headers, the guest's own
  COOP/COEP/CORP, and Set-Cookie (a synthesized response cannot set
  cookies). It adds `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-origin`. A document in the
  isolated page's iframe needs a COEP. `credentialless` would also
  let a guest page's CDN assets load in Chrome and Firefox, but Safari
  does not implement it and would block the iframe. With require-corp a
  guest page's cross-origin subresources load only if they send CORP or
  CORS. A redirect to `/x` or to `http://localhost:<port>/x` is rewritten
  under the prefix.
- Root-relative URLs: a preview document's same-origin requests outside
  `/vm/` (`/style.css`, even `/assets/x.js`) go to the vmId and port of the
  client's URL with the path as it is; the worker looks up each request's
  client first. Navigations
  outside `/vm/` (a link to `/about`) are not relayed. They reach the
  server, which sends the page, and `main.tsx` sends them back under the
  prefix (`previewEscape()`: the iframe's `data-kw-preview`, or in a tab the
  referrer) instead of booting a second kernel.
- Server: `/vm/**` reaching the server (a shift-reload bypasses the worker,
  or the worker is not installed) gets a 503 page from `server/vm.ts` that
  says the preview needs the page open, not the app. Its link to `/` is
  `rel="noreferrer"`, so `previewEscape()` does not send it back.
  `/vm-sw.js` is `no-cache`, and the worker registers with
  `updateViaCache: "none"`. In `pnpm dev`, Vite serves `public/` and Nitro
  the handler; both carry COOP/COEP.
- Limits: same-origin and trusted content only, since the guest's pages can
  script the unkernel page (`parent.KW`). A sandbox without
  `allow-same-origin` would take the iframe out of the worker's control. A client-side
  router sees the `/vm/<id>/<port>` prefix in `location`. WebSockets and
  Vite-style HMR bypass service workers, so they do not reach the guest.
  Cookies are not set. A tab on the URL works only while the page that
  owns the vmId stays open, and a reload gives a new vmId. There is no
  back-pressure beyond the 4 chunks ahead plus one per pull. A long
  stream may be cut when the browser stops a worker whose event runs for
  minutes. Checked by hand only, plus a Node harness of the
  relay against a fake `vm.fetch`. No browser test.
- Trying it by hand: the image's busybox has no httpd. In a terminal
  window, run `apk add busybox-extras`, then `mkdir -p /tmp/www && echo hi >
  /tmp/www/index.html && httpd -f -p 8000 -h /tmp/www`. Or run `apk add
  python3`, then `cd /tmp/www && python3 -m http.server 8000`. Then Ctrl-A
  p, and "Go" after changing the port.

## fx

The status line's `fx` button (`#bar-fx`, left of the About triangle) and Ctrl-A f
start fx, the coding agent from fx.sh, in a panel (`#fx`, `Fx.tsx`, the
store's `fx`); pressed again they hide and show it, and its `[×]`
(`#fx-close`) stops fx. `?fx` (or `?fx=1`) starts it at load, once the
preflight passes, without waiting for the kernel; its Options control is
the `fx` check box (`#opt-fx`), and an `?fx` already in the URL stays as
written on Reboot. It is no terminal window: no status line tab, its
wterm (`#fx-term`) is outside `#terms`, so display.ts never routes its keys
to the guest. Docked right of the stage (and of the preview) on wide
screens, with its own split (localStorage `kw.fxSplit`, default 38%, the
drag shared with the preview: `dragSplit()`); over the stage under 720 px.
`fx.ts` describes the rest at its top:

- It runs libfx's wasm terminal (`createFxTerminal()`, npm `libfx`,
  Apache-2.0) under JSPI on the page's thread next to the kernel. wterm,
  libfx and `fx-term.wasm` (4 MB) load on first use, not with the page, and
  the service worker does not precache libfx's wasm (`unkernel:asset-list`
  in vite.config.ts; libfx also emits `fx-core.wasm`, which the page never
  fetches). libfx is excluded from Vite's dependency pre-bundling, which
  would break its `new URL("./fx-term.wasm", import.meta.url)`.
- Its one tool, `shell.run`, is a workspace adapter: `/bin/sh -lc
  <command>` through `vm.exec()` as root in `/root`, after user space runs
  (`KW.ready`), with fx's own deadline (at most 30 s) and Ctrl-C as the
  abort signal. `permission: "allow-sandboxed"`: no prompt per command.
  `/root/AGENTS.md` from the guest, else built-in instructions about the
  machine.
- Sign-in is fx's `/login` (Vercel device login; the URL opens in a new
  tab). vercel.com serves its OAuth discovery document without CORS
  headers (2026-11-16), so `fxFetch()` falls back to a copy of the four
  fields fx reads; the endpoints on api.vercel.com send CORS headers.
  Without it the sign-in fails in a browser and fx offers API key entry,
  which its wasm build does not have. The OAuth session, fx's settings, its
  prompt history and the conversation are in `fx.ts`'s module memory only,
  out of reach of other scripts (not in storage, not on `window` or `KW`), so
  a reload signs out. Keys `kw.fx.*` from an earlier build are removed.
- Checked by hand, plus a scratch run on 2026-11-16 (headless Chromium,
  built page): the panel docks and hides, Vercel sign-in reaches the device
  code, the narrow layout covers the stage. No browser test.

## Launcher

The status line's first item (`❯` and the shortcut as key caps,
`#bar-launcher`), ⌘K on Apple
devices, Ctrl-Shift-O or Ctrl-A o open the launcher (`#launcher`, `Launcher.tsx`, the store's `launcher`):
an overlay over the whole page in the manner of macOS Launchpad, the page
blurred behind a grid of tiles (glyph and gradient from the demo) and a
search field. The focus stays in the field (tiles take none), so
display.ts never routes its keys to a program holding the guest's
keyboard; arrows select, Enter runs, Esc clears the search, then closes; a
click on the backdrop closes. On touch devices the field is not focused.
A demo's `icon` is a glyph or a pictogram as inline SVG markup (static
strings in the demo file, set as inner HTML): project logos from Simple
Icons (CC0, the slug in a comment), else the project's own mark from its
site (the source in a comment), crafted ones otherwise.
After the demos comes a gray System tile that opens the dialog
(`PANEL_TILES`), which works in any state.

The demos are one file each in `src/demos/`, listed in order in
`src/demos/index.ts`; `launcher.ts` runs them. The page ships no assets for
them, so a demo is text only (`Demo` in launcher.ts): `files` written under
its directory (`~/demos/<id>` by default) with one `vm.exec()` each, plus
a generated `run.sh` there (`/etc/kw-apk-enable` when the demo sets
`community`, `apk add` of the `packages` not yet installed, then the
`commands`, each printed before it runs, under `set -e`). A new terminal
window named after the demo runs `sh -lc` with a wrapper in place of the
login shell: `cd <dir> && ./run.sh`, then `exec` the login shell, so the
window stays to edit and rerun (an INT trap keeps the wrapper alive through
Ctrl-C). Typing the command into a fresh shell lost the start of the line,
because the login discards input typed ahead of its prompt. The preview opens once the
guest answers http on the first of its `ports`. Alpine's nginx default
site also listens on `[::]:80`, which fails in the guest (no IPv6), so the
nginx demo replaces it. A demo may carry repository sources as text (Vite `?raw` or
`import.meta.glob`): Doom brings `kernel/guest/fbdoom` and its patches
this way, and these GPL-2.0-or-later texts keep their license inside the
MIT bundle. Files with absolute paths land outside the demo directory, and
files from an earlier launch are never removed. A demo's `downloads`
(url, SHA-256, size, guest path, an optional `unless` shell test) are
fetched by the page before its window opens (`download.ts`, described at
its top): the sites send no CORS headers and the page is cross-origin
isolated, so it speaks plain http over its own Wisp connection, as apk.ts
does, follows redirects as http (a site that redirects to https only
fails; a download with `cors`, for a site that sends
Access-Control-Allow-Origin such as releases.fx.sh, is a direct `fetch()`
instead), checks the SHA-256 and keeps the file in the Cache API
(`kw-files-v1`), then pushes it with one `vm.exec()` (through a `.part`
file, size checked). It skips a file that is in the guest already at that
size, or whose `unless` passes in the demo's directory. A failure is a toast
and a log line, not fatal, so the demo's script checks the file itself and
downloads it when it is missing (Ubuntu does). On 2026-11-15 (Node, the
default Wisp server) the Ubuntu Base tarball (31 MB) took 1.5 to 4.4 s to
fetch and 0.2 s to push. A demo with `hidden` set is left out of the launcher. A demo runs once at a time: picking one whose window
is open (a dot under its tile) shows that window. A demo whose `needs`
(display, net, sound) the page's options rule out is dimmed, with why.
Launching a demo sets `?demo=<id>` in the URL (`history.replaceState`), and
a page with `?demo=` launches that demo once the guest is up, so a reload
reopens the last demo launched; Reboot keeps it. Closing that demo's
window (or its shell exiting) removes `?demo=`; the kernel stopping does
not.
Failures are toasts. Checked by hand only.

`?showcase` (or `?demo=-`) runs `src/showcase.ts` once the guest is up: a
fast, hands-off tour of the demos, leaving out the web servers (described at its top).
Each step shows a caption and launches its demo without touching `?demo=`.
It waits for a process (`pgrep -f`), a pattern on the screen, the display or
the preview, then plays it: keys typed into the terminal, or the evdev
keyboard for glimmer and Doom. Then it closes the demo. A bar along the top
shows progress, and the tour ends on a title card. `?showcase=a,b` runs only
those steps. The tour does not wait: a demo not ready within 30 s is
skipped and logged, as is a step that fails. `?showcase=warm` launches each
demo and waits until it is ready, without captions, so apk, npm and the
Doom build come from the data disk on later tours. `KW.showcase` has
`skip()`, `pause()` and `resume()`.

## Running and deploying

- `pnpm dev`: Vite on port 8080, all interfaces. `pnpm build:web` writes
  `web/.output/`, and `pnpm start:web` runs it (port 3000 unless `PORT=`).
  `pnpm typecheck:web` type-checks it.
- On Vercel, Nitro detects the platform and writes `web/.vercel/output`.
  Elsewhere, `NITRO_PRESET=vercel pnpm build:web` produces the same for
  `vercel deploy --prebuilt`.
- A LAN `http://` page is not a secure context: no clipboard API, no
  `deviceMemory`, no Web Locks, and no cross-origin isolation. It still
  works.

## Browser tests (`web/test/`)

Agents run these only when asked. The page is tested by hand with
`pnpm dev` on port 8080, so do not start anything on that port.

`headless.mjs` (`pnpm test:web`: desktop with the JIT compiling and
cross-origin isolation asserted, phone over LAN, nojspi, fetch404, modfail,
lowmem running kwtest), `data.mjs` (data disk, overlay root, safe mode,
second tab, export/reset/import) and `net.mjs` (needs the internet). Shared
code is in `lib.mjs`. They drive Chromium over the DevTools protocol with no
npm dependencies and start the built server (`--dev` starts the Vite dev
server). They use the newest Playwright Chromium in `~/.cache/ms-playwright`
unless `--chrome PATH` or `CHROME=` is given. There is no WebKit test
script.

## Engines

- JSPI (`WebAssembly.Suspending`/`promising`) is required: Chrome/Edge
  137+, Firefox 153+, Safari 27+ (every iOS browser uses the system
  WebKit). memory64 is not needed, because the page runs the lowered
  kernel; as of 2026-11 no stable Safari has it.
- Playwright WebKit builds (2336 and 2388) behave like iOS; on 2026-11-13
  they and a real iPhone gave the same hashes with the JIT on and with
  `?jit=0`.
- **Safari 27 runs plain-http pages without a JIT** (2026-11-13, Mac and
  iPhone). On a page that is not a secure context (`http://` at a LAN,
  VPN or proxy address) Safari interprets JS and wasm: kwbench's int
  loop runs at 248 MIPS against 3670 in Chrome on the same Mac. At
  `http://localhost:<port>` or over https it has its JIT. Playwright
  WebKit has no such policy, so it cannot reproduce this. When Safari or
  an iPhone is slow, check the origin first. The page does not warn about
  it.
- JavaScriptCore collects freed JIT modules only when prompted (kwemu.md,
  Collecting freed modules). On an iPhone the JIT row of the Environment tab
  should show `collected` keeping up with `freed`, uncollected modules in
  the hundreds, and `refused` 0. Not yet measured on a phone.
