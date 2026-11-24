# Guest Vulkan on WebGPU (kwvk)

`createKernel({ vk: true })` in a browser with WebGPU gives the guest a
Vulkan 1.2 device, "kwvk (WebGPU)". The contract between the three parts is
`vk/PROTOCOL.md` (framing, messages, shader rules, and its Amendments,
which override the body); read it before changing any of them. The page's
Guest Vulkan option is in web.md (Guest Vulkan). State as of 2026-11-24.

```
app -> Vulkan loader (Debian libvulkan1) -> /usr/lib/kw/libvulkan_kw.so (vk/icd)
    -> AF_VSOCK, host CID 2, port 1018 (VK_PORT), one stream per VkInstance
    -> VkHost (js/core/vk.ts, the thread that owns the VM, both modes)
    -> VkRenderer (js/core/vk-host.ts, vk-exec.ts, vk-formats.ts) on WebGPU
    -> SPIR-V to WGSL: kwvk-naga.wasm (vk/naga, js/core/vk-shader.ts)
```

## Parts

- **ICD** (`vk/icd/`, GPL-2.0-or-later, C): thin. Instance, physical
  device, device, queue, memory (malloc'd shadows; every memory type
  host-visible and coherent), fences, semaphores, command recording and
  presentation are guest-side; every other object is made on the host by a
  message. Command buffers go as JSON at submit; host-visible memory is
  diffed and sent before each submit; buffers the bound pipeline's SPIR-V
  may write are read back at fence waits. Its physical device is an
  integrated GPU whose limits, features and formats come from the host's
  hello reply (WebGPU's). WSI: VK_KHR_wayland_surface (wl_shm buffers,
  pre-multiplied alpha), VK_KHR_xcb_surface and VK_KHR_xlib_surface
  (XPutImage), VK_EXT_headless_surface; Wayland, xcb and Xlib are
  `dlopen`ed. `KWVK_LINK` picks the link (`vsock:2:1018` default, `tcp:`,
  `unix:`); `KWVK_TRACE`, `KWVK_STATS` and `KWVK_SPIRV_DIR=DIR` (keeps
  every module) are for debugging. Built by `vk/icd/build.sh` (aarch64
  glibc, `$KW_BUILD/vk/libvulkan_kw.so`, `kw_icd.json`, the test programs
  `test/vk/guest/vk-*.c`) or `vk/icd/build.sh native` (this host,
  `$KW_BUILD/vk/native/`, for `test/vk/relay.mjs`), against the Vulkan
  headers pinned in `vk/pins.sh` (Khronos 1.4.309, trixie's loader;
  fetched into `vendor/downloads` by `vk/headers.sh`).
- **In the guest**: the base's kw layer carries the ICD and its manifest
  (`/usr/share/vulkan/icd.d/kw_icd.json`, the loader's default path: no
  environment variables); `guest/base/build.sh` runs `vk/icd/build.sh`
  (`KW_VK=0` leaves it out; about 110 KB of the layer). kernel/guest.md,
  The kw layer. Debian only (it links glibc); programs need `libvulkan1`.
- **Host** (`js/core/vk-host.ts`, `vk-exec.ts`, `vk-formats.ts`, MIT):
  implements the objects and the command stream on one GPUDevice.
  Swapchain images are read back at present (the `present` reply carries
  the pixels; the last presented texture is kept for the page,
  `renderer.image()`). A lost device fails and closes every stream, then
  calls `onLost`.
- **SDK** (`js/core/vk.ts`; js.md, Guest Vulkan): the web entry only.
  Nothing loads before the guest's first VkInstance: then the adapter (every
  feature it has, its maximum limits), the renderer's modules (chunks of
  their own) and the translator. `vm.vk`: `status` (idle, loading, ready,
  lost, failed), `stats` (streams, bytes, `losses`, `renderer`: the host's
  counters, e.g. `presents`), `device`, `loaded`, `load()`. After a lost
  device the next program gets a new device and renderer. Snapshots hold
  no renderer state: a restore drops the connections. Ignored with a log
  line on Node.
- **Translator** (`vk/naga/`, Rust on naga with passes of its own; the
  loader `js/core/vk-shader.ts`): SPIR-V to WGSL per stage with reflection
  (bindings, push constants, varyings, `requires`: the WebGPU features the
  WGSL enables). Specialization constants are baked, vertex output gets
  the Y flip, descriptor arrays are flattened, input attachments become
  textures, 8/16-bit and float16 storage is lowered to u32 words (float16
  computed in f32 without `shader-f16`). `vk/naga/build.sh` ->
  `$KW_BUILD/vk/kwvk-naga.wasm` (about 0.9 MB) -> `dist/kwvk-naga.wasm`.

## Build

- `vk/build.sh [all|naga|icd]` (as `gl/wasm/build.sh` is for GL): the ICD
  and its test programs, then the translator where cargo has the
  `wasm32-unknown-unknown` target (else a message, and the SDK has no guest
  Vulkan). `setup.sh` checks cargo as optional and runs `vk/build.sh naga`
  after `kernel/build.sh all`; `pnpm build` copies the translator (a
  warning without it); the base build includes the ICD.

## Testing

- `pnpm test:vk` (no browser, part of `pnpm test`): `VkHost` on a fake
  vsock with a fake renderer and device (lazy load, a renderer connection
  per stream, bytes both ways, close and shutdown, a lost device and a new
  one for the next program), `prepareVk`'s refusals, distinct host vsock
  ports (9p, GL, commands, WASI exec, tty, Vulkan, the page's Wayland), and
  the translator on `test/vk/guest/double.comp` (skipped without
  `kwvk-naga.wasm`).
- `node test/vk/host/check.mjs`: the host renderer alone in headless Chrome
  with a fake client. `vk/naga/test/run.ts`: the translator on the shaders
  in `vk/naga/test/shaders/`, validated in a real WebGPU; `corpus.sh`: a
  real-world corpus (Sascha Willems' examples, vkmark, GTK 4, SDL 3).
- `node test/vk/relay.mjs -- CMD` runs CMD (e.g. `vulkaninfo --summary`,
  `vendor/build/vk/native/vk-compute`) on this host against the renderer
  in headless Chrome, with `KWVK_LINK` and the native manifest set;
  without CMD it serves `tcp:127.0.0.1:10210`. It re-imports the
  renderer's sources when they change.
- `node test/vk/unkernel-check.mjs` (`--worker`; `--source`: the SDK from
  its sources, no `pnpm build`): Debian in headless Chrome with `vk: true`
  and the prepared disk `$KW_BUILD/vk/debian-vk.img` (`test/vk/debian-disk.mjs`:
  libvulkan1, vulkan-tools, libwayland-client0, wayland-utils, weston;
  139 s, 605 MiB); pushes the ICD under test (`--no-push`: the base's;
  `--kernel FILE`: another bundle). Steps: h (a raw hello over `kwbox
  vsock`), a (`vulkaninfo --summary` names kwvk), b (every
  `$KW_BUILD/vk/vk-*` test program exits 0: compute, triangle, headless,
  dynamic state, threads, depth, flat varyings), c (`vkcube --wsi wayland`
  under `weston --backend=headless --renderer=pixman --debug`, started by
  the page's `/usr/local/bin/kwvk-wl CMD`; then a running vkcube's frame
  taken by `weston-screenshooter` and judged: many colours, the LunarG
  teal, not olive). `--lose` (the device destroyed while vkcube runs; new
  programs work), `--snapshot` (a snapshot with a running vkcube,
  restored), `--cpus N` (SMP; the page cross-origin isolated). `--apps`
  boots the second-stage disk (`debian-disk.mjs --apps`: vkmark,
  gtk-4-examples, SDL 2 and 3 tests, vkd3d demos, Xvfb, x11-apps) for
  `--cmd '...'` runs, whose files in `/tmp/kwvk-out` come back to the out
  dir; `--capture-shaders` (with `--source`) writes SPIR-V the translator
  refuses; `--disk FILE` boots another prepared disk.
- `node test/vk/page-check.mjs`: the page's option (web.md, Guest Vulkan).
- WebGPU in headless Chrome here: only the Playwright Chromium
  (`~/.cache/ms-playwright/chromium-1234/`) with `--enable-unsafe-webgpu
  --enable-features=Vulkan,WebGPU --use-vulkan=swiftshader
  --use-webgpu-adapter=swiftshader --disable-dev-shm-usage` (adapter
  "google swiftshader", no `shader-f16`, 256 invocations per workgroup);
  dnf's `chromium-headless` has no adapter. Without
  `--disable-dev-shm-usage` other browsers filled `/dev/shm` (64 MiB) and
  Chrome crashed before the page ran.

## What runs (2026-11-24, SwiftShader WebGPU)

Nothing was run on a real GPU: every number is software WebGPU on this
host's CPU, with the guest under kwemu.

- unkernel-check, inline and worker mode, with `--lose`, `--snapshot` and
  `--cpus 2`: all steps pass; the renderer loads at the first connection
  in 10-20 ms.
- vulkaninfo (full, exit 0); vkcube and vkcubepp on Wayland (FIFO, MAILBOX,
  IMMEDIATE) and on X11 under Xvfb (xcb, xlib), frames right; vkmark's 7
  scenes (headless 700-1150 FPS; on Wayland 143-195 FPS); SDL 2 and SDL 3
  `testvulkan` (28-32 FPS); SDL 3's GPU API (`testgpu_simple_clear`,
  `testgpu_spinning_cube`, 27-31 FPS); GTK 4.18 with
  `GSK_RENDERER=vulkan` (gtk4-demo: as with the cairo renderer, shadow
  included; GTK's default renderer stays GL); vkd3d-gears (Direct3D 12 on
  vkd3d) under Xvfb.
- llama.cpp (ggml-vulkan, cross-built for aarch64 by
  `test/vk/guest/build-llama.sh`, not packaged in trixie): ggml selects
  kwvk and generates. stories260K (F32, `-ngl 99`, temperature 0) gives the
  CPU backend's text: 1.8 tokens/s in the guest on a loaded host against
  0.25 on the emulated CPU, 9.5 natively through the relay. stories15M
  q4_0 gives wrong text (below). Compute shaders wider than the device's
  workgroup limit (ggml's are 512, SwiftShader allows 256) are split by
  the translator where they have no barriers or shared memory. 139 of
  ggml's 156 shader variants translate and compile. Its
  `test-backend-ops` against the CPU backend (partial runs): GET_ROWS,
  SILU, SOFT_MAX, ROPE pass; CPY 209 of 211, ADD 90 of 97, MUL_MAT 209
  of 249, RMS_NORM 41 of 123.
- Presentation is by readback: a frame's pixels cross vsock and are copied
  into a wl_shm buffer or by XPutImage, 9-13 ms a frame on Wayland.

## Unsupported and open (2026-11-24)

- Not offered: geometry and tessellation shaders, texel buffers
  (samplerBuffer, imageBuffer: vkd3d's internal UAV-clear pipelines, DXVK),
  1D-array storage images (WGSL has none), linear-tiling images,
  robustBufferAccess, logicOp, multiDrawIndirect, fillModeNonSolid, wide
  lines, large points, shaderInt16/Int64/Float64, pipeline statistics
  queries, sparse resources; subgroup clustered reductions, elect and
  ballot counts in shaders (naga lacks them).
- Mesa's zink: it connects and gives up after the hello, with no message;
  it wants many more features. Low priority (guest GL has virgl). Mesa
  (25.0 in Debian 13) never picks zink while virgl works; after a virgl
  failure, GLX on a DRI3 X server tries zink on the first Vulkan device
  (kwvk) and falls back to software only because kwvk has no timeline
  semaphores, and EGL on Wayland skips kwvk only because it has no
  VK_EXT_physical_device_drm. Before offering either, export
  `LIBGL_KOPPER_DISABLE=1` in the base profile (and keep zink off EGL), or
  GL would draw through zink on kwvk.
- llama.cpp: quantized models (q4_0) give wrong text and MUL_MAT partly
  fails: about 29 shader variants fail Tint's uniformity analysis
  (`workgroupBarrier` outside uniform control flow); the norm family
  (norm, rms_norm, group_norm, l2_norm) reduces across a 512-wide
  workgroup through shared memory and cannot be split on a 256-limit
  device. Eval is bound by GPU time on SwiftShader and, for q4_0, by
  several small readbacks a token (not batched). Never run on a real GPU.
- Chrome-specific reliances: WGSL's `uniform_buffer_standard_layout`
  (push constant blocks stay std430 in a uniform buffer) and the
  `texture-component-swizzle` feature (image view swizzles; identity
  without it, logged).
- A descriptor set that the pipeline's shaders declare but the app never
  binds (GTK binds no set 1) gets placeholder resources, logged once.
