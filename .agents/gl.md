# Guest GL through virgl on WebGL2

The design, what was measured, how to test, and what is open. It is in
unkernel: `createKernel({ gl: true })` in a browser (unkernel, below), and
the page's Guest GL option, `?gl=1` (The page, below; web.md, Guest GL). All
work happens on the `webgl` branch (this worktree). Do not change `main`,
and do not commit until asked.

## Goal

Give guest programs hardware GL in the browser, in place of llvmpipe under
kwemu. The guest runs stock Mesa with the `virgl` driver; the host runs
virglrenderer compiled to wasm against one WebGL2 context.

```
guest: app -> Mesa virgl (virpipe) -> /tmp/.virgl_test -> /usr/lib/kw/vtest-bridge
       -> kwvsock, host CID 2, port 1019 ...
host:  ... -> VsockHost -> StreamHost -> virglrenderer (wasm) -> WebGL2
       (one context, OffscreenCanvas, on the thread that owns the VM)
```

Decided, do not reopen without new facts:

- WebGL2, not WebGPU. Zink needs logic ops, transform feedback and
  non-solid fill, which WebGPU lacks; Venus needs host Vulkan 1.1 and
  guest-mappable device memory.
- The vtest protocol first (a byte stream, no kernel driver). virtio-gpu in
  the kernel comes last, if at all.
- Browser only. Node has neither WebGL nor WebGPU.
- No window system work here. Frames come back by readback (vtest transfer),
  as in every test below. wland (a Wayland compositor for the page,
  `/workspace/github/pithings/wland`) is a later, separate integration and
  is not a prerequisite.

The guest sees GL 2.1 compatibility (GLSL 1.20) and GLES 3.0 (GLSL ES
3.00): no compute shaders, no texture buffers, no GL 3.3 core.

## What exists (2026-11-21)

| Path | What |
| --- | --- |
| `gl/patches/virglrenderer/` | the one series on virglrenderer 1.3.0 (tag commit ca50e00), both builds; see Patches |
| `gl/wasm/` | the wasm module: `build.sh` (emscripten pinned in `pins.sh`; also the `native` build), `kw_virgl.c`/`.h` (C API, GL context hooks, vtest I/O), `kw_gl.js` (GL entry points made from WebGL2), `gl-missing.txt` (the stubs), `epoxy/` (libepoxy stand-in), `post.js` (`Module.virgl`, the page's renderer); see WebGL2 |
| `gl/wasm/test/check.mjs` | loads the module in headless Chromium: init on WebGL2, caps, a parked busy wait, two inline clients, `Module.virgl.Renderer` |
| `gl/bridge/` | `vtest-bridge.c` (vtest socket to WebSocket or byte stream, fd termination) and the page that hosts a renderer: the wasm module or the relay to a native server; `README.md` has the wire dialect and the renderer interface |
| `test/gl/vtest-check.sh` | the check suite on this host; see Testing |
| `test/gl/bridge-check.sh` | the same suite with every byte through the page in headless Chromium; `--wasm` against the wasm renderer |
| `test/gl/kwgl-state.c` | the stale-state check run by `vtest-check.sh state` (surfaceless EGL clients taking turns) |
| `js/core/gl.ts`, `gl-stream.ts` | the SDK's host side: `createKernel({ gl })`, `GlHost` (`vm.gl`), `StreamHost`; see unkernel |
| `test/gl/debian-disk.mjs` | makes the prepared data disk once (Mesa and the test programs installed in Debian's upper layer) |
| `test/gl/unkernel-check.mjs`, `unkernel.html`, `unkernel-page.js` | the whole path in unkernel in headless Chromium; see Testing |
| `test/gl/page-check.mjs` | the page's GL option in headless Chromium (the dev server, `?gl=1`); see The page |
| `guest/base/rootfs/etc/profile.d/kw-gl.sh` | the guest's shells' `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1` when the command line has `kw.gl=1` |
| `web/` (`config.ts`, `boot.ts` `showGl()`, `scripts/kernel.ts`, `vite.config.ts`) | the page's Guest GL option and how the page gets `virgl.*` (web.md, Guest GL) |
| `test/gl/build-guest-state.sh` | `kwgl-state.c` for the Debian guest (aarch64 glibc, linked against stand-ins for libEGL and libGLESv2) |
| `vendor/src/virglrenderer-wasm` (gitignored) | the source of both builds: branch `kw-wasm` = 1.3.0 + the series |
| `vendor/build/gl-wasm`, `vendor/build/gl-native` | `virgl.{mjs,wasm}`; `vtest/virgl_test_server` |
| `vendor/build/gl/` | `debian-gl.img` (the prepared disk), `kwgl-state-aarch64`, `vtest-bridge` (`build-guest.sh`) |

`vendor/` is not a record: commit on `kw-wasm` and re-export the series
(`gl/wasm/build.sh` has the command). `build.sh` never re-applies an
existing `kw-wasm`; it warns when its commit count and the series differ.

```sh
gl/wasm/build.sh             # toolchain, source, the module (a few min the first time)
gl/wasm/build.sh native      # virgl_test_server of the same source for vtest-check.sh
```

The native build needs (Fedora 44) `libepoxy-devel mesa-libgbm-devel
libdrm-devel mesa-libEGL-devel python3-pyyaml meson ninja`.

## Patches

In order, each with its reason in the commit message:

1. the single GL context mode (Single GL context);
2. the GL blitter's shaders as GLSL ES 3.00 on a GLES 3.0 host: they are
   GLSL ES 3.10, which such a host rejects, and then those blits (3D
   mipmaps, swizzled formats) do nothing;
3. vtest ignores SIGPIPE, so a dead client cannot kill a `--no-fork` server;
4. to 6. emscripten: meson without `-pthread`, Mesa's util, the DRM ioctl
   macros;
7. vtest for an embedder: its own I/O, GL context hooks, backing stores in
   plain memory, the implicit fence counters (`vtest_renderer_fences`);
8. the mixed-attachment probe with a sized format (WebGL rejects unsized
   `GL_RED`, and the pending error then refused every command);
9. sampler view swizzles applied in the shaders on a host without
   `GL_TEXTURE_SWIZZLE_*` (WebGL2), probed at init; the GL blitter takes the
   source format's swizzle into its shader;
10. `VIRGL_RENDERER_COARSE_GL_ERRORS`: GL errors checked once per command
    buffer instead of after each command (glGetError is a round trip in
    WebGL; every command of a buffer is one context's).

## Single GL context

`VIRGL_RENDERER_SINGLE_GL_CONTEXT` (vtest: `--single-gl-context` or
`VTEST_SINGLE_GL_CONTEXT`; patch 1) runs every renderer context, sub
context and the GL blitter on the GL context that `vrend_renderer_init`
creates. It lives in `vrend_renderer.c`, not in a winsys, so the web build
gets it with any winsys; the wasm module always sets it. It needs a GLES
host (on desktop GL it warns and keeps one context per sub context) and
ignores `VIRGL_RENDERER_THREAD_SYNC`.

`vrend_state.gl_owner` names the sub context whose state the GL context
holds. Every place that used to make a sub context's GL context current
calls `vrend_single_acquire`, which, when the owner changes:

- ends the old owner's active queries into a fresh GL query object (the
  result adds up, or ORs for boolean queries, the parts), its render
  condition, a running transform feedback, and its clip planes;
- resets to the GL defaults everything any sub context or the blitter
  changes (blend, colour mask, depth, stencil, scissor, cull, polygon
  offset, rasterizer discard, line width, depth clamp, clip control, sample
  mask and shading, program, transform feedback binding);
- emits the new owner's state: framebuffer and VAO bindings, transform
  feedback object, the last rasterizer state it bound (its `hw_rs_state`
  shadows forced), depth and stencil enables and depth function and mask
  from its shadows, colour mask from `hw_blend_state`, blend colour,
  viewports, depth ranges and scissors, sample mask and minimum sample
  shading (new shadows, as these were emitted once and never stored), and
  restarts its queries and render condition; texture units, samplers,
  uniform buffers, stencil functions and blend functions are marked dirty
  for the next draw or clear.

State every user binds before use is left alone: program (bound per draw
and clear), array, element, copy, indirect and uniform buffer bindings,
pixel store (each transfer sets and resets it), front face and primitive
restart (per draw). The blitter enters through
`vrend_renderer_single_enter_blitter` (owner released, defaults, texture
unit 0 with no sampler object, its VAO and buffer bound), and the client is
re-acquired after the blit. A sub context's creation releases the owner
before creating its objects; its destruction ends active transform
feedback and clears `gl_owner`. Fence checks no longer switch to context 0
in this mode (any context serves for sync objects).

Not covered, as no GLES 3.0 host has the feature: a split query used as a
render condition or read through a query buffer object counts only its
last part; transform feedback without TF objects (`transform_feedback2`);
desktop-only state (polygon stipple and clip plane equations in the
compatibility profile, tessellation default levels).

## WebGL2

The module renders through emscripten's WebGL2 bindings. What WebGL2 lacks
is made up at three levels, the shim first:

- `kw_gl.js` (JS library):
  - **Buffer types.** WebGL types a buffer at its first binding: an element
    array buffer can be bound nowhere else but the copy targets, nor the
    other way round, and the GPU cannot copy between the two kinds. Mesa's
    virgl streams vertices and indices through the same buffers, so vrend's
    buffers are never element buffers: binding one to
    `GL_ELEMENT_ARRAY_BUFFER` binds its element twin, made on first use.
    Data calls (`kw_glBufferData` and the rest; `epoxy/gl.h` renames vrend's
    calls) go to the buffer, through a copy target, and to its twin; a GPU
    write (buffer copy, transform feedback) marks the twin stale, and an
    indexed draw reloads a stale twin by reading the buffer back.
  - **Buffer maps.** `glMapBufferRange` is a copy in module memory (filled by
    `getBufferSubData` unless all of it is invalidated), written back by
    `bufferSubData` at unmap or flush: buffer upload and readback,
    stride-0 vertex attributes.
  - **Indexed blend and colour mask** on `OES_draw_buffers_indexed`, whose
    GLES name vrend's feature check finds in emscripten's extension list.
  - **Base vertex and base instance draws**:
    `WEBGL_draw_instanced_base_vertex_base_instance` when present (a draft
    extension: Chromium shows it only with `--enable-webgl-draft-extensions`,
    so not here), else every enabled array attribute is pointed that many
    elements further for the draw. Whether the check suite draws with a
    base vertex is not known.
  - `glFramebufferTexture3D(OES)` as `framebufferTextureLayer` (3D mipmaps
    through the blitter), `glGetQueryObjectiv`.
  - **Renderer name**: `glGetString(GL_RENDERER)` answers the unmasked name
    (`WEBGL_debug_renderer_info`) where WebGL says "WebKit WebGL", so the
    guest's renderer string, `virgl (...)` (vrend forwards GL_RENDERER in
    the caps, 63 bytes at most), names the WebGL implementation: here
    `virgl (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`.
- `epoxy/gl.h`: aliases (`glGetQueryObjecti64v`, `glQueryCounter` and others
  to emscripten's EXT names).
- vrend patches: the sized probe format (8), texture swizzles in the
  shaders (9), coarse error checks (10).

What the suite proved needed, by the error it hit first: the buffer maps
(every buffer upload), the element twins (glmark2's desktop scene binds a
vertex buffer as its index buffer), the swizzles (any RGBX texture),
`framebufferTextureLayer` (3D mipmaps), the clamped inline transfers
(below, Weston). Stale twins and buffer readback through a map ran through
no failing case.

`gl-missing.txt` lists what stays a stub (logs its first call, returns 0).
On a GLES host vrend reaches none of it in the check suite (no stub logged
in any run). What vrend could still reach: `glGetTexImage` and friends are
not called on GLES (vrend reports them missing and reads back only formats
`glReadPixels` can read; Mesa reads the others back through a blit, as the
caps' readback formats tell it), 1D textures (vrend skips them on GLES),
and everything behind features that are off.

Formats: BGRA is stored as RGBA with a red/blue swizzle, as on any GLES
host, which patch 9 makes work in WebGL; frames of BGRA X11 windows and
Weston's BGRA client buffers come out right.

Extensions WebGL2 has but vrend does not see, all unused by the check
suite and left off: `EXT_disjoint_timer_query_webgl2` (vrend looks for
`GL_EXT_disjoint_timer_query`; the entry points are aliased already),
`WEBGL_clip_cull_distance` (the shaders would need
`GL_ANGLE_clip_cull_distance`), `WEBGL_polygon_mode` (vrend has no GLES
polygon mode path), `WEBGL_stencil_texturing` (vrend wants GLES 3.1),
`WEBGL_multi_draw`. `EXT_clip_control`, `EXT_depth_clamp`,
`EXT_polygon_offset_clamp`, `EXT_texture_mirror_clamp_to_edge`,
`EXT_conservative_depth`, `NV_shader_noperspective_interpolation` and
`OES_draw_buffers_indexed` are seen under their GLES names.

Shaders: ANGLE's WebGL validator accepted every shader vrend and its
blitter wrote in the check suite (glmark2's 32 scenes, neverball, Weston,
the state clients); no compile or link failure was logged.

Inline transfers: Mesa's `TRANSFER_GET2` may ask for more than a
resource's backing holds (Weston's 500x400 client asks 819,200 bytes of an
800,000-byte backing); the native server does not check, and the module,
like vtest-bridge, copies what the backing has and pads the reply.

Fences: a fence is a `glFenceSync` plus `glFlush` at submit, retired by
polling (`glClientWaitSync`, timeout 0). Without the sync thread vtest's
`RESOURCE_BUSY_WAIT` with the wait flag loops until no client has a fence
in flight, and in WebGL a sync object signals only between tasks, so the
loop would never end. The module parks the client instead, noting the last
fence submitted; `kw_virgl_poll` from a later task answers the wait once
that fence has retired (the page polls through a message for the first 16
rounds, then 1 ms timeouts). Waiting for that fence rather than for all to
be idle matters with several clients, whose submissions would otherwise
keep the parked one waiting. Measured (2026-11-21, bridge-check `--wasm`):
glmark2-es2 over 16 scenes of 2 s parked 2,674 busy waits for 13.9 s in
all (5 ms each); the six `multi` clients 110 to 300 each. The page logs
these counts when a client closes.

## Measured (2026-11-21, Fedora 44 container, no GPU)

Native: host GL llvmpipe (Mesa 26.2.7), surfaceless EGL, held to GLES 3.0
with 41 extensions that WebGL2 lacks disabled. Browser: headless Chromium,
WebGL 2.0 on ANGLE/SwiftShader (`--use-angle=swiftshader
--enable-unsafe-swiftshader`). Clients: Mesa's virgl driver over vtest
(`GALLIUM_DRIVER=virpipe`) on Xvfb, unmodified.

- The guest side reports GLES 3.0 and GL 2.1 on both renderers.
- **The wasm renderer passes the whole suite** (`bridge-check.sh --wasm`):
  info, es2 and gl (all 16 scenes each), sdl, weston, multi and state, no
  unexpected line in the page's log, frames looked at (every glmark2 scene,
  neverball's menu, Weston with a client, six clients at once). state's 60
  frames equal those of the same clients run alone on a second page; against
  the native multi-context renderer 51 checksums differ, by rounding
  (SwiftShader against llvmpipe; no pixel differs by more than 2%).
- FPS through the same bridge and page, wasm renderer against the relay to
  the native server (shared, noisy host; one run each): glmark2-es2 build
  90 / 115, texture 107 / 136, shading 87 / 105, desktop 37 / 80, ideas 61
  / 111, jellyfish 84 / 117, terrain 12 / 16, shadow 95 / 84, refract 27 /
  24, loop 124 / 122. Most scenes 0.75 to 1.1 of the relay; desktop and
  ideas, with many small draws, about half. Before patch 10, ideas ran at 6
  (three glGetError round trips a draw). Native without the bridge is 2 to 3
  times the relay.
- **One GL context needs state handling.** Every context on one GL context
  with nothing restored passes the screenshot tests with `--fork`, where no
  two clients share a renderer, but with one server process the `state`
  test fails (36 of 44 frames differ, queries count other clients'
  samples). With the single GL context mode all 60 frames match in every
  run; disabling any one part of its restore makes frames differ.
- **Two upstream bugs of a server that all clients share** (unpatched
  1.3.0 with `--no-fork`, any host GL) broke the client that drew last,
  seen as GL_INVALID_FRAMEBUFFER_OPERATION in Weston when a Wayland EGL
  client started: `vrend_renderer_fill_caps` ran its framebuffer probes on
  whichever GL context was current and left framebuffer 0 bound, and
  `vrend_create_context` made the new GL context current while the previous
  client stayed recorded as current. The series fixes both (caps on context
  0; a created context clears the current one). In WebGL the first would
  have drawn into the canvas with no error.
- Those features WebGL2 lacks that Mesa's llvmpipe cannot hide
  (`MESA_EXTENSION_OVERRIDE` disables every always-on extension with any
  one of them) were only testable against the real WebGL2, above.

From the source (1.3.0): GL contexts are created in
`vrend_renderer_create_sub_ctx` and switched through
`vrend_clicbs->make_current`; GL is reached through libepoxy; the vtest
server (`vtest/`) uses fork or threads, unix sockets, memfds and an
eventfd. vtest forks one server process per client unless given
`--no-fork`, also with `--multi-clients`; only `--no-fork` puts several
clients on one renderer, as the page does.

### unkernel (2026-11-21, `unkernel-check.mjs`, headless Chromium 157)

The guest is Debian 13 on the UP kernel (inline; worker mode passes (a)
and (b) the same), 1024 MiB, the prepared disk. The WebGL2 is ANGLE on
SwiftShader (software: every virgl number is a floor for a page with a
GPU). One run each, on the shared host:

- `vm.gl.ready` 0.6 s after the page started (boot, module, forwarder
  linked); `eglinfo -B -p surfaceless` on virgl 1.5 s: `virgl (ANGLE
  (Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`, GLES 3.0 and GL 2.1
  (Mesa 25.0.7).
- `kwgl-state` (7 clients, 8 turns, 64x64): all 60 checksums of the
  interleaved run equal each client's alone in the guest, and equal the
  host's own run of the same clients through `bridge-check.sh --wasm
  state` (x86 Mesa 26.2.7, the same renderer): the pixels are the
  renderer's, whatever carried them. On llvmpipe in the guest 52 of 60
  differ (rounding, as against the native renderer). 3.2 s on virgl, 32.4 s
  on llvmpipe.
- glmark2-es2 under Xvfb at 640x480, 10 s a scene, the same command with
  and without `GALLIUM_DRIVER=virpipe` (FPS from glmark2's mean frame time):

  | Scene | virgl (WebGL2 on SwiftShader) | llvmpipe (in the guest, under kwemu) | Ratio |
  | --- | --- | --- | --- |
  | build | 93.2 | 4.30 | 22x |
  | texture | 98.8 | 4.08 | 24x |
  | shading (phong) | 91.9 | 0.82 | 112x |
  | jellyfish | 69.8 | 0.32 | 218x |
  | desktop | 38.2 | 0.16 | 239x |

  virgl here is as fast as Mesa on this host through the bridge's
  WebSocket to the same renderer (Measured, above: build 90, texture 107,
  jellyfish 84, desktop 37, also 640x480, 2 s a scene): the browser's
  renderer bounds it, not the emulated guest or kwvsock. Each frame comes back to the guest
  by readback and goes to Xvfb by XPutImage, for virgl and llvmpipe alike.
- The prepared disk: 290 MiB used of a 4 GiB sparse image; made in 55 s
  (boot, apt over the direct network, power-off).

## Work packages

1. **Single context, hardened (native).** Done: Single GL context. Check:
   `test/gl/vtest-check.sh --single`.
2. **Emscripten build.** Done: `gl/wasm`. Check: `node gl/wasm/test/check.mjs`.
3. **WebGL2 gaps.** Done for everything the check suite exercises: WebGL2.
   Next, by what real programs would hit: timer queries, clip and cull
   distances, polygon mode through the WEBGL extensions; dEQP and piglit
   (below) would find the rest.
4. **Bridge and browser harness.** Done: `gl/bridge`, `bridge-check.sh`
   (relay or `--wasm`).
5. **unkernel.** Done: unkernel, below. Check: `node test/gl/unkernel-check.mjs`.
   The page's option: done (The page). Check: `node test/gl/page-check.mjs`.
   Next: frames to the page's display (X on kwfb, unverified; kwshm, or
   wland), and the busy wait (Open questions).

## unkernel

`createKernel({ gl: true })` (js.md, Guest GL; README.md):

- **Host** (`js/core/gl.ts`): on the thread that owns the VM, in both
  modes (vsock is served there: in worker mode the kernel's worker only
  passes packets), the module is imported from `new URL("./virgl.mjs",
  import.meta.url)` of the web entry (dist/virgl.mjs and virgl.wasm,
  copied by `pnpm build`; never fetched without `gl`), the renderer is
  `Module.virgl.Renderer` on a 1x1 OffscreenCanvas's WebGL2, and
  `StreamHost` (`js/core/gl-stream.ts`) serves every connection to vsock
  port 1019. Node: ignored with a log line (no OffscreenCanvas), unless
  `gl.renderer` gives a renderer object (the relay works there).
- **Guest** (`/usr/lib/kw/vtest-bridge`, kernel/guest.md): the bridge
  built stream-only, in the base's kw layer (in the bundle, so it always
  matches the SDK that speaks its link; 67 KB of RAM-resident layer for
  every distro, Alpine included, which cannot use it). The SDK starts it
  through kwtty as root once the renderer is up (`bridge --link
  vsock:2:1019 --daemon`); it makes `/tmp/.virgl_test` mode 0666 when the
  host sends READY, and `vm.gl.ready` resolves on its LOG line saying so.
- **Mesa**: not in the image; `apt-get install mesa-utils libegl-mesa0
  libgles2` (surfaceless, about 45 MB download), plus `libgl1-mesa-dri
  libglx-mesa0 xvfb xauth glmark2-es2-x11 glmark2-x11` for X11 (all of it:
  72 packages, 60 MB download, 238 MB installed). Debian trixie's Mesa
  25.0.7 has virpipe. Clients run with `GALLIUM_DRIVER=virpipe
  LIBGL_ALWAYS_SOFTWARE=1`, surfaceless or under Xvfb; without
  `GALLIUM_DRIVER` the same programs run on llvmpipe in the guest.
- **Snapshots**: renderer state is not saved. A restore resets the link
  (GL clients in the guest end); the restored guest's forwarder
  reconnects within a second and the new host's start of it exits 0.
  Verified on Node with the relay renderer (2026-11-21): eglinfo on virgl
  before the snapshot and after the restore, the same forwarder process.
- Alpine's Mesa has no virgl driver: Debian only.

## The page

`?gl=1` (Options: Guest GL; default off; web.md, Guest GL) boots with
`gl: true` on Debian, where the page's build has the renderer and the
page's thread has WebGL2; otherwise the option is disabled with the
reason. The page builds with `virgl.mjs` and `virgl.wasm` from
`vendor/build/gl-wasm/` (with a local kernel), `KW_GL=<dir>`, or the
release's assets of those names (release.yml attaches them); the dev
server answers `/_gl/virgl.*`, a build emits both into
`/assets/virgl-<hash>/`; only a load with GL on fetches them. With GL on
the page adds `kw.gl=1` to the command line, for which the base's
`/etc/profile.d/kw-gl.sh` exports `GALLIUM_DRIVER=virpipe
LIBGL_ALWAYS_SOFTWARE=1` in the guest's shells, so plain `eglinfo` or
`glmark2-es2` uses virgl. The Environment tab's Guest GL row names the
WebGL2 renderer (unmasked; a software one, SwiftShader, llvmpipe or WARP,
is a warning and a toast) and `vm.gl.stats`; the browser console has
`[unkernel] guest GL: WebGL2 renderer ...`.

Checked 2026-11-21, `test/gl/page-check.mjs` (the dev server, Playwright's
headless Chromium on SwiftShader, `?gl=1&data=0&cpus=1`, worker mode):
`vm.gl.ready` 2.7 s after the page was opened; a login shell had the
variables and `/tmp/.virgl_test`; `apt-get install mesa-utils
libegl-mesa0 libgles2` over the page's network (deb.debian.org through the
CORS mirror) took 46 s; then `eglinfo -B -p surfaceless`: `virgl (ANGLE
(Google, Vulkan 1.3.0 (SwiftShader Device (Sub...)`, OpenGL ES 3.0 Mesa
25.0.7. The built server sends `/assets/virgl-*/virgl.{mjs,wasm}` with
JavaScript and wasm types, br-encoded, immutable (curl, not a browser).
Not checked: a GL client on the page's display (X.Org's fbdev driver on
kwfb, `sudo Xorg :0`, then `DISPLAY=:0 glmark2-es2`) and its frame rate
(kwfb is read about 50 times a second, at most about 1M pixels), packages
kept across reloads on the data disk, a real GPU, Firefox and Safari.

## Testing

```sh
gl/wasm/build.sh && gl/wasm/build.sh native
node gl/wasm/test/check.mjs                  # the module alone, a few s
test/gl/bridge-check.sh --wasm               # the suite on the wasm renderer, about 5 min
test/gl/bridge-check.sh --wasm --keep state  # one test, keep the logs and frames
test/gl/bridge-check.sh --single             # the suite through the page to the native server
test/gl/vtest-check.sh --single              # the native server alone, about 2 min
test/gl/vtest-check.sh --fork                # a server process per client
test/gl/vtest-check.sh --server "$(command -v virgl_test_server)" info es2
test/gl/stream-check.sh state                # the stream link (unix socket) to the relay
test/gl/stream-check.sh --guest state        # the same through the guest's build under qemu-aarch64
node test/gl/debian-disk.mjs                 # the prepared disk, once (skipped when it exists)
node test/gl/unkernel-check.mjs              # unkernel in headless Chromium, about 4 min
node test/gl/unkernel-check.mjs --worker --skip c   # worker mode, without the benchmark
node test/gl/page-check.mjs                  # the page's option (dev server, port 8091), about 1 min; needs the internet
node test/gl/page-check.mjs --no-apt         # without Mesa: GL up and the guest's environment only
```

`unkernel-check.mjs` builds what it needs and skips what exists: `pnpm
build` (the page imports `/dist/web.mjs`; `--no-build` skips it), the
prepared disk `vendor/build/gl/debian-gl.img` (`debian-disk.mjs`: boots
Debian on Node with the direct network, apt-installs the packages of
unkernel above as root, powers off cleanly; delete it after a new Debian
image, since its upper layer belongs to the image it was made on), and
`kwgl-state` for the guest (`build-guest-state.sh`). It serves the Debian
image and the disk read-only with Range requests (the guest's writes stay
in the page's memory), and the page boots with `gl: true` and runs: (a)
`eglinfo -B -p surfaceless` on virpipe (the renderer must be `virgl
(...)`); (b) `kwgl-state` interleaved against each client alone, as
`vtest-check.sh state` judges it, and with `--state-ref FILE` (the
`state.txt` that `bridge-check.sh --wasm --keep state` keeps) against the
host's own run, plus the same clients on llvmpipe (reported, not judged);
its frames are written as PPM; (c) glmark2-es2 under Xvfb, the same scenes
at the same size on virgl and on llvmpipe (`--size`, `--scenes`). The
steps' output, the page's log and the guest's console go to `--out`
(default a new `/tmp/kwgl.*`).

Tests: `info` (versions), `es2` and `gl` (glmark2, 16 scenes each; the
`.png` has a frame of each scene), `sdl` (neverball), `weston` (GL
compositor with a GL client), `multi` (six clients at once), `state`
(`kwgl-state.c`: seven surfaceless EGL clients, each with its own
deliberately different GL state set once, take turns frame by frame on the
server under test; each frame's checksum must equal that of the same client
run alone on a reference: the native multi-context server, or with `--wasm`
a second page with a fresh wasm renderer; it covers texture units and
samplers, uniform buffers, blend, colour mask, depth, stencil, cull, polygon
offset, scissor, viewport and depth range, vertex attribute enables, an
occlusion query open across turns, 3D mipmaps through the GL blitter, and
two contexts in one client). The screenshot tests only know that something
was drawn: look at the frames. With `--wasm` the page's log (the renderer's
stderr included) must have no unexpected line; `--glcheck` logs every
WebGL call that raises an error and `--glcount` the most frequent calls
(both fail that check by design). vtest-check's default server is
`vendor/build/gl-native`; it prints the one it uses. Unix socket paths must
stay under 108 bytes, so the scripts work in `/tmp/kwgl.*`.

Results (2026-11-21, the series of Patches):

| Run | Result |
| --- | --- |
| `bridge-check.sh --wasm` | all pass, logs clean |
| `bridge-check.sh --single` (relay) | all pass on the series before its last patch; not rerun since |
| `vtest-check.sh --single` | all pass, log clean |
| `vtest-check.sh` (multi-context, one process) | all pass, log clean |
| `vtest-check.sh --fork`, `--single --fork` | all pass; in some runs a client killed mid-command leaves a `VTEST_CLIENT_ERROR_COMMAND_DISPATCH` line |
| `stream-check.sh state`, `--guest state` | pass |
| `stream-check.sh info state` | state times out (its clients wait 120 s for replies the relay never brings), also at the commit before unkernel; `state` alone passes. Not examined |
| `unkernel-check.mjs` (inline; `--worker --skip c`) | all pass; Measured |
| `page-check.mjs` | all pass; The page |

Workloads that need no window system of ours (so nothing waits on wland):

| Workload | State |
| --- | --- |
| Xvfb with any X11 GL client (glmark2, SDL games, nested Weston) | works; what the scripts use. Xvfb needs no display device, so the same runs in the guest. |
| Surfaceless EGL through virgl | works with no display server at all (`kwgl-state.c` is one). |
| dEQP-GLES2/GLES3 and piglit | not packaged in Fedora; build from source. This is what Mesa's CI runs for virgl over vtest, with expectation lists in Mesa's tree (`src/gallium/drivers/virgl/ci/`). The best correctness suite now that the basics pass. |
| SDL's `offscreen` video driver | did not go through virgl as is: it picks an EGL device and Mesa then refuses the software driver. Unexplored further. |
| GL as compute (machine learning) | stops at GLES 3.0: no compute shaders, so no llama.cpp. A fragment-shader workload such as TensorFlow.js's WebGL backend is the only kind that could fit; unverified. |

## Open questions

- Readback cost per frame over kwvsock, and when to move it to kwshm: at
  640x480 the guest gets as many frames as a host client through the
  bridge (unkernel, Measured), so kwvsock is not the limit on SwiftShader;
  not measured with a GPU-backed WebGL2, where it may be.
- Frames on the page's display: whether X.Org's fbdev driver on kwfb
  presents virgl's frames as Xvfb does (the driver reads each frame back
  and puts it to X either way), and at what rate.
- Not tried in unkernel: the SMP kernel (`cpus` > 1; vsock and so GL stay
  on the owner's thread, as on one CPU), Firefox and Safari (WebGL2 and
  OffscreenCanvas in a page's main thread exist there), and a GPU.
- The busy wait costs about 5 ms a frame (fence latency across tasks).
  Through the inline dialect a readback's data travels with its
  `TRANSFER_GET2` reply, which `glReadPixels` fills synchronously, so a
  busy wait could be answered at once; whether anything else relies on it
  (glFinish timing, back pressure) is unexamined.
- Draw-heavy scenes run at half the relay's rate in the browser; the
  remaining per-draw cost (state calls through emscripten, the base vertex
  emulation's attribute queries) is unmeasured in detail (`--glcount`).
