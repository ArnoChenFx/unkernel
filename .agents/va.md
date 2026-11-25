# Guest VA-API on WebCodecs (kwva)

`createKernel({ va: true })` in a browser with WebCodecs gives the guest a
VA-API decoder, "kwva (WebCodecs)": hardware video decode as far as the
guest can tell, done by the page's `VideoDecoder`. VP9 profile 0, H.264
(Constrained Baseline, Main, High: 8-bit 4:2:0, progressive or MBAFF), AV1
Main (8-bit 4:2:0) and HEVC Main (8-bit 4:2:0; offered only where
`isConfigSupported` takes it, and its WebCodecs leg is unverified),
decoded; pictures read back as NV12, or, with guest GL's virtio-gpu
device, exported as dmabufs that the host fills (Zero-copy output, below:
mpv's `--hwdec=vaapi`). VP9 profile 0 encode where the page has a
`VideoEncoder` for it (Encode, below: ffmpeg's `vp9_vaapi`). The link is
`va/PROTOCOL.md`. State as of
2026-11-25. Verified only on Chromium's software decoders (libvpx,
FFmpeg's h264, dav1d) in headless Chromium: hardware decoders, HEVC's
WebCodecs leg, Firefox playback through the driver and the real page are
unverified (Unsupported and open, Not run).

```
app (ffmpeg, mpv) -> libva (Debian libva2 2.22) -> kw_drv_video.so (va/driver)
    -> AF_VSOCK, host CID 2, port 1024 (VA_PORT), one stream per VADisplay
    -> VaHost (js/core/va.ts, the thread that owns the VM, both modes)
    -> one WebCodecs VideoDecoder per VA context -> VideoFrame -> NV12 -> back on demand
    -> or, exported: NV12 -> GpuRenderer.write -> the surface's virtio-gpu resources
       (textures in the renderer's WebGL2) -> sampled by the guest's GL (Mesa virgl)
    -> or, video processing into an exported BGRX surface: VideoFrame -> GpuRenderer.video
    -> encode: NV12 (sent when it changed) or the host's decoded picture
       -> one WebCodecs VideoEncoder per VA encode context -> the chunk -> the coded buffer
       (texSubImage2D into the resource's texture, no CPU copy) -> the page's compositor
```

## Parts

- **Driver** (`va/driver/kwva.c`, GPL-2.0-or-later, C, one file): libva's
  `__vaDriverInit_1_22` and the decode subset of the vtable. Per-codec
  knowledge is the `codecs[]` table (VA profile, wire name, minimum element
  size per buffer type (the fields before `va_reserved`), where the picture
  parameters name reference surfaces, and a second surface a picture
  writes: AV1's `current_display_picture` when film grain is applied, sent
  as `display` with a picture id of its own); the rest is codec-neutral.
  vaDestroyContext leaves its pictures pending: they still complete
  (PROTOCOL.md, `ctx_free`). vaRenderPicture copies every buffer into the
  context; vaEndPicture sends them all with a new picture id (`dec`). A
  reader thread reads everything the host sends, so requests from several
  threads are in flight at once: vaSyncSurface waits on a condition
  variable for the host's notice (no transfer, no link lock), decode
  submission never waits behind it. Pixels move only on vaGetImage or
  vaMapBuffer of a derived image (`get`, once per picture, cached until the
  surface is rendered again), into the surface's storage (the `store_*`
  functions: process memory now, the seam for host-held surfaces). A picture
  that failed on the host syncs successfully, reads back as the context's
  last good picture (grey without one), shows in vaQuerySurfaceError, and is
  printed once. Object ids carry their kind in the top 4 bits and a counter
  (never reused while it runs), so a stale id is invalid, never another
  object; destroying a surface detaches its derived images. Also
  QuerySurfaceStatus, QueryImageFormats (NV12), Create/Derive/Get/
  DestroyImage, Map/UnmapBuffer; ExportSurfaceHandle and video processing
  (NV12 to BGRX) where the host can fill exported surfaces (Zero-copy
  output). VP9 encode (Encode, below): VAEntrypointEncSlice, coded
  buffers, SyncBuffer, MapBuffer2, PutImage (no scaling). No PutSurface
  or subpictures; decode RT
  format YUV420 only (a 10-bit stream gets no surfaces: ffmpeg decodes it
  in software). `KWVA_LINK` picks the link (`vsock:2:1024` default, `tcp:`,
  `unix:`); `KWVA_DEBUG=1` logs; errors go to stderr (`kwva: ...`, each
  line once). Without a host (the option off, Node) vaInitialize fails
  silently (a line with `KWVA_DEBUG`). Built by `va/build.sh` (aarch64
  glibc, `$KW_BUILD/va/kw_drv_video.so`, `va-decode` and `va-encode`) or `va/build.sh
  native` (`$KW_BUILD/va/native/`), against the libva headers pinned in
  `va/pins.sh` (2.22.0, trixie's; `va/headers.sh` generates
  `va_version.h`). Neither links libva.
- **In the guest**: the base's kw layer carries
  `/usr/lib/aarch64-linux-gnu/dri/kw_drv_video.so` and the link
  `virtio_gpu_drv_video.so` to it. libva names a DRM device's driver after
  its kernel driver (libva 2.22 `VA_DRM_GetDriverNames`: virtio_gpu is not
  in its map, so the name is `virtio_gpu`), so Debian's libva2 loads it
  with no environment variables; `LIBVA_DRIVER_NAME=kw` names it directly.
  libva needs a display: DRM, i.e. the virtio-gpu device (`gpu`; the
  page's guest GL device) for `/dev/dri/renderD128`. The link shadows
  mesa-va-drivers' file of that name: the image does not carry it, apt
  installs no recommends, and an installed mesa-va-drivers replaces it in
  the upper layer; removing that package again leaves an overlay whiteout
  over the layer's link (libva then finds no driver: `LIBVA_DRIVER_NAME=kw`,
  or make the link again). `guest/base/build.sh` runs `va/build.sh`
  (`KW_VA=0` leaves both out). kernel/guest.md, The kw layer. Debian
  only (glibc).
- **Host** (`js/core/va.ts`, MIT; the codecs in `va-vp9.ts`, `va-h264.ts`,
  `va-av1.ts`, `va-hevc.ts`; what they share, the `CodecAdapter` interface
  and the bit writer and reader, in `va-codec.ts`; encoding in
  `va-enc.ts`, Encode below): `VaHost` serves the
  port; each stream is a `VaSession`. Nothing happens before the first
  connection; then `VideoDecoder.isConfigSupported` for each entry of
  `CODECS` (each packaging the adapter has, at 1080p and 4K, and with
  prefer-hardware and prefer-software for the vendor string and
  `status.support`) decides the hello's profiles and maximum size (`ctx`
  refuses a profile not offered). Codec knowledge is a `CodecAdapter` per
  context (`config()`; `picture()`: a VA picture's buffers to chunks, with
  the key-frame test and pictures that give no output of their own; a
  chunk may ask for a `restart` (the decoder made again and the history
  replayed with chunks re-made by their `remake`), carry an `order` (its
  timestamp: the output order, for codecs that reorder) or a `hold` (it
  waits for the context's next picture); `held()`, `mode()`,
  `conservative()`, `filler()`, `dropped()`, `variants`; below); the session
  does the rest, codec-neutral: one decoder per context, made at the first
  key chunk, `optimizeForLatency: true`, `hardwareAcceleration` from
  `va.hardwareAcceleration` (default no-preference); timestamps are mapped
  back to picture ids (the output order for H.264 and HEVC, so a decoder
  that hands out timestamps in sorted order still pairs each picture with
  its own; the decode order otherwise); outputs are copied to NV12 (I420
  interleaved in JS, NV12 as is, anything else through `copyTo({ format:
  "RGBA" })`, or a 2D canvas for a frame copyTo() refuses (format null),
  then back to YUV with the frame's matrix, BT.601 where it names none:
  logged, not exact) and closed: at once, or, where the GPU can draw frames,
  when the picture's first consumer decides, at most 4 held per context
  (Frame lifetime, below), so a hardware decoder's frame pool never runs
  dry. Recovery: the chunks since the last key chunk are kept
  (64 MiB at most) and replayed into a new decoder after a decoder error, a
  reclamation (Chrome reclaims idle decoders with `QuotaExceededError`,
  hardware ones even in a foreground tab; logged as such, not as an error)
  or a flush; a second error before any new output fails the pictures until
  the next key frame. Configurations: at `ctx` the ladder of
  configurations isConfigSupported accepts (each packaging variant with
  the preferred acceleration, then with prefer-software); a decoder that
  fails before the context's first output (NotSupportedError, or an error
  within its first chunks) moves to the next rung, the history replayed;
  with none left the profile is taken back (`status.broken`, a log line)
  and later connections are not offered it. `ctx_free` flushes the decoder
  and lets its pictures complete before closing it, as a hardware driver
  finishes what was submitted (ffmpeg destroys its context at a resolution
  change while frames it decoded ahead are still to be read). A key chunk
  with `reconfigure` flushes the decoder before `configure()`, which would
  drop what it holds. A picture whose surface is rendered again while it is
  pending but that writes another surface too (AV1's display picture) stays
  until its output completes that one. Frames over 64 MiB end the stream.
- **Modes and stalls**: each context starts in its adapter's model mode
  (VP9, AV1: each shown picture comes out right after its chunk; H.264:
  libavcodec's output process, below) and goes conservative, for good, when
  its decoder disagrees: an output the model says is still held, the hold
  timer firing for a picture the model says is out, or a flush that leaves
  pictures without an output (dropped). One `[host] va:` log line names the
  context, its codec string, what decodes and why; later contexts of that
  profile start conservative (`VaOptions.mode: "conservative"` makes every
  context start there; `VaHost.setOptions()` is the test hook). HEVC has
  no model. The hold timer runs while the driver waits for a picture
  (`wait`) and is restarted by every output and input: model mode 8 decode
  latencies (250 ms to 2 s; 500 ms before the first output; 100 ms for a
  picture the model knows is held for lack of input, which is then
  flushed); conservative mode 3 latencies plus 5 ms (10 ms to 1 s). In
  conservative mode a stall first gets the adapter's fillers, chunks that
  change no decoder state and make a decoder holding outputs give the one
  it holds longest (VP9: a show_existing_frame of slot 0; AV1: a
  show_existing_frame of a slot holding a non-key frame; H.264: one
  non-reference picture of P_Skip macroblocks, below; their outputs are
  dropped): as many at once as it took last time, one more per further
  fire (at most 8; H.264 one per picture). After 4 stalls in a row that
  fillers resolved, fillers go in as soon as the guest waits (no timer;
  every 32nd wait checks without). A stall fillers cannot resolve (none can
  be made, or they did not release the picture; after 3 such pictures in a
  row no more fillers) flushes the decoder, and the next delta chunk makes
  it again with the history replayed: a cost that grows with the distance
  from the last key frame. Pictures a flush does not give were dropped: the
  adapter may declare more (H.264: a deeper reorder) and a replay gives
  them, else they fail.
- **VP9** (`va-vp9.ts`): the chunk is the slice data as is (superframes
  too); frame headers are parsed and checked (frame_marker, sync code,
  length). Frames with `show_frame` 0 (alt-refs) give WebCodecs no output,
  while VA expects every surface to complete: right after a hidden picture
  the adapter adds a one-byte `show_existing_frame` of a slot its last frame
  refreshed, and that output is the hidden picture. Right after, not at the
  read: ffmpeg shows a hidden frame only through a later
  show_existing_frame, which it handles without a VA picture, and its CLI's
  decoder thread runs ahead of the read, so the slot may hold another
  picture by then. A show_existing_frame changes no decoder state (libvpx
  `vp9_receive_compressed_data` keeps last_show_frame, prev_frame and the
  segmentation map; the VP9 spec likewise). A hidden frame that refreshes
  no slot is black. VA's VP9 picture parameters are sent but not needed.
- **H.264** (`va-h264.ts`, `h264Adapter`): each picture becomes one access
  unit, an SPS and a PPS made from VA's parameters, then the picture's
  slice NAL units as VA has them (from the NAL header; a start code some
  apps include is stripped). Every chunk carries both, so any chunk after a
  key decodes in a fresh decoder, several PPS ids work and a replay needs
  nothing more. Packagings (`variants`, the configuration ladder): Annex B;
  avcC (a description of the SPS and PPS, length-prefixed units with the
  parameter sets in band too) for decoders that want one; Annex B without
  the VUI for one that rejects it (then conservative, nothing to raise).
  Each slice header is parsed (the first through dec_ref_pic_marking) with
  VA's fields and checked against VA's slice parameters and frame_num: a
  mismatch fails the picture. What VA does not carry: the PPS id (from the
  slice header; the SPS id is always 0); num_ref_idx_l0/l1_default (the
  effective counts of the picture's slices without
  num_ref_idx_active_override_flag, else the last known for that PPS id:
  only those slices use it); scaling lists (VA's are the effective ones,
  raster order: all of them into the PPS when not flat); profile_idc (the
  VA profile's, raised to Main or High, sticky, when the picture uses their
  tools); level_idc (the smallest for the picture size and DPB, 3.1 at
  least with MinLumaBiPredSize8x8, which ffmpeg sets for level 3.1 up); no
  cropping (surfaces hold the whole coded picture, as a hardware decoder's;
  ffmpeg crops after the download); VUI with only bitstream_restriction.
  Key chunks are IDRs: Chromium refuses a non-IDR I picture as the first
  chunk after `configure()` or `flush()` ("A key frame is required"; it
  takes one mid-stream), and no SEI reaches the host, so open-GOP recovery
  points are deltas and a replay starts at the last IDR. A key chunk whose
  codec string or size changed reconfigures. The chunk's timestamp is its
  place in the output order (the IDR period and the POC).
- **H.264 output delay**: WebCodecs outputs in POC order and holds pictures
  as the SPS says. Chromium's software decoder (FFmpeg's h264, measured
  2026-11-25 on x264 B-pyramid clips with `optimizeForLatency`) holds
  exactly `max_num_reorder_frames` when bitstream_restriction is present,
  and drops a picture that comes after one already output: reorder 0
  dropped 44 of 60 and 247 of 300 frames, 1 dropped 14 and 96, the
  stream's own 2 none; without the VUI it held 3 to 4 and dropped 1 to 2;
  without `optimizeForLatency` (frame threads) one frame more. VA does not
  carry the stream's reorder depth, and the guest's app syncs each surface
  right after its own decoder's delay (libavcodec's `has_b_frames`: the
  original VUI's value), so a larger host delay stalls a single-threaded
  app (plain `-hwaccel vaapi`, mpv) at every picture. Model mode keeps an
  exact model of libavcodec's output process (`OutputModel`:
  h264_select_output_frame with bitstream_restriction) and starts at 0; a
  picture that would come out of order raises the depth to the least that
  drops nothing since the IDR (`leastReorder`) and asks for a `restart`
  (an x264 B-pyramid stream: at its 3rd and 4th pictures); max_dec_frame_
  buffering is the level's DPB. Conservative mode assumes nothing:
  max_num_reorder_frames is the stream's own depth as H.264 defines it (the
  most pictures before one in decode order and after it in output order,
  `streamReorder`, since the IDR), raised with a restart when a picture
  needs more; max_dec_frame_buffering the least the SPS allows
  (max(num_ref_frames, reorder)), for decoders that hold pictures until the
  DPB is full; its filler, for the picture X the guest waits for, is a
  non-reference P picture of P_Skip macroblocks (CAVLC, a PPS id the
  stream does not use) with frame_num one past the last reference picture's
  and POC X + 1: it comes out right after X in POC order and before every
  later picture (the stream's POCs are even: POC type 0 with only even POCs
  so far, or type 2, where it is the last reference picture's POC + 1), and
  changes no reference state. No filler for MBAFF or POC type 1 (a flush
  instead), one per picture (the only free POC).
- **AV1** (`va-av1.ts`, `av1Adapter`): each picture becomes a temporal
  unit: a temporal delimiter, a sequence header OBU (key chunks), a frame
  header OBU and tile group OBUs, all written. The sequence header carries
  VA's fields and turns on what lets every frame header field VA has be
  written as VA has it (enable_warped_motion, enable_superres,
  enable_restoration, enable_ref_frame_mvs, screen content tools and
  integer MVs chosen per frame, separate_uv_delta_q), 16-bit frame sizes
  (max: the context's; frame_size_override_flag where a frame differs), no
  frame ids, timing, decoder model or colour description. The frame header
  is written field by field from VA's values, which are the effective ones
  (ffmpeg's CBS infers what a frame does not code from its references):
  loop filter deltas with update flags for all, segmentation with VA's
  update flags, film grain always with update_grain, delta q/lf, CDEF,
  loop restoration (FrameRestorationType back to lr_type), tx mode,
  reference_select, skip mode (written when skipModeAllowed, derived from
  the slots' order hints), superres, error_resilient_mode (with
  ref_order_hint[] of the slots), disable_cdf_update, tile info (uniform:
  the TileColsLog2 that gives VA's count; else VA's sizes;
  context_update_tile_id; 4-byte tile sizes), global motion coded relative
  to the parameters the decoder loads from the primary reference frame's
  slot (kept per slot). VA has no refresh_frame_flags: the adapter keeps
  the decoder's 8 slots itself (picture, order hint, frame type, global
  motion) and names its slots in ref_frame_idx. A picture goes into a slot
  whose picture the app's map (`ref_frame_map`, as picture ids) no longer
  has or holds twice: no later picture can refer to it. With none (the
  app's map holds 8 distinct pictures, common with libaom) the chunk waits
  for the next picture (`hold`): its map says whether the app kept it and
  which picture it gave up; if the guest waits for the picture first (a
  single-threaded app), it is decoded unstored, and if the next map keeps
  it, decoded again first, hidden (show_frame 0, showable_frame 1), into
  the slot just freed: decoding depends only on the slots ref_frame_idx
  names, so the second decode is the first's. Hidden frames are written
  with show_frame 1, so their picture comes out at once (the app shows
  them later through show_existing_frame, without VA); that changes
  nothing a slot stores (show_frame only decides whether showable_frame is
  read, and film grain is reset for a frame neither shown nor showable,
  which VA's apply_grain 0 writes too). Film grain: the host's decoder
  (Chromium's dav1d) applies it, so the output, which goes to
  `current_display_picture`, is what ffmpeg's software decode (libdav1d)
  shows; the reference surface (`current_frame`) gets the same pixels
  (the app only refers to it; nothing applies grain-free output). An app
  exporting film grain (VA's film_grain_params_present 0) gets none
  applied. Key chunks are shown key frames. Refused per picture: hidden
  key frames (showing one refreshes every slot), large-scale tile, other
  profiles, 10 and 12 bits (not offered: RT format YUV420 only),
  monochrome. Codec string `av01.0.LLM.08`, the level from the size.
- **HEVC** (`va-hevc.ts`, `hevcAdapter`, conservative only; the WebCodecs
  leg is unverified): each picture becomes one Annex B access unit, a VPS,
  an SPS and a PPS made from VA's parameters, then its slices. VA does not
  carry the SPS's short-term reference picture sets (slice headers name
  one by index) or its long-term candidates, only their numbers and, for a
  set coded in the slice header, its size in bits (`st_rps_bits`). So the
  SPS has none and every slice header is written again with its set
  inline, rebuilt from VA's ReferenceFrames (ffmpeg names there exactly the
  pictures of the RPS: ST_CURR_BEFORE, ST_CURR_AFTER, LT_CURR, or none for
  the ones kept for later), negative pictures by decreasing POC, positive
  ones by increasing POC; the header is parsed to its end and the rest of
  it copied bit for bit, the slice data byte for byte (entry points count
  slice data bytes). Long-term pictures coded in the slice header are
  copied; ones naming SPS candidates are refused. Scaling lists (VA's are
  the effective ones) go into the PPS, which may change from picture to
  picture. Main profile, the level from the size, no conformance window,
  7 temporal sub-layers declared with one ordering info (VA does not say
  how many), sps_max_num_reorder_pics the stream's own depth (raised with a
  restart), no VUI. Key chunks: IDR and BLA pictures and the stream's first
  (a CRA's RASL pictures need what came before it). Codec string
  `hev1.1.6.L<level>.90` (Annex B, parameter sets in band). No filler (it
  would need a CABAC-coded picture): stalls flush.
- **SDK** (`createKernel({ va })`, `vm.va`: `status` (idle, ready, failed;
  `profiles`, `hardware`, `support` per profile, `broken`), `stats`
  (streams, bytes, decoders, pictures, hidden, frames, readbacks, bytesRead,
  showExisting, failed, errors, reclaims, flushes, replays, replayed,
  restarts, holdFires, fillers, dropped, modeSwitches, fallbacks; exports,
  exported (surfaces bound now), uploads, uploadBytes, uploadMs,
  uploadFailed; video processing by path: gpuUploads and gpuUploadMs
  (frames drawn on the GPU), cpuConversions and cpuConversionMs (converted
  on the CPU and uploaded as bytes), gpuFallbacks (per reason: colour, not
  exported (yet), copied to NV12 already, the draw failed, upload: cpu,
  ...); copies and copyMs (VideoFrame.copyTo to NV12), framesHeld
  (VideoFrames not closed yet), framesHeldPeak, framesEvicted (copied
  because of the cap); and
  `contexts`: per open context and the last 8 closed ones, its profile,
  size, codec string and whether it had a description, the configured
  hardwareAcceleration, what decodes as far as WebCodecs tells (`decoder`:
  from that preference and isConfigSupported's prefer-hardware and
  prefer-software answers), the VideoFrame format (I420: software as a
  rule, NV12: hardware), mode and why, pictures, frames, failed, restarts,
  replays, holdFires, fillers, flushes, dropped, early outputs, fallbacks,
  decode latency, the frames' colour space as WebCodecs reports it
  (`colorSpace`) and the adapter's state (H.264: reorder, packaging; AV1:
  pictures decoded again, held, hidden); `encode`: pictures, chunks, key
  frames, where the pixels came from (uploads, kept, decoded), recoveries
  and each encode context's codec string, rate control and latency),
  `status.encode`/`encodeModes`, `load()`, and the test hooks
  `inject()` and `setOptions()`). Not in snapshots: a restore drops the
  streams. Ignored with a log line where there is no `VideoDecoder` (Node).
- **Page**: on by default on Debian where the page's thread has
  `VideoDecoder` (`cfg.va`, config.ts; `?va=0` turns it off for a load);
  needs the guest GL device (not with `?gpu=0`), which also gives zero-copy
  output (createKernel passes `vm.gl.gpu` to the VA host); `?va=cpu` keeps
  video processing on the CPU (`VaOptions.upload: "cpu"`). No Settings box
  or status row yet.

## Zero-copy output

vaExportSurfaceHandle (DRM PRIME 2) where the page has guest GL's
virtio-gpu device with 3D (`gl` and `gpu`, WebGL2; the hello's `export`):
a surface's pixels are guest GPU resources that the host fills from its
own NV12 copy of each picture, so they never cross vsock or guest memory.
"Zero-copy" is the guest's view only: on the host an NV12 export's picture
is still copied on the CPU, three times: `VideoFrame.copyTo` into a JS NV12
buffer (for a hardware decoder's frame a GPU-to-CPU readback), its rows
into the GL module's heap, and from there into the two textures (the
renderer's texture upload). Video processing into an exported BGRX surface
(mpv's `--vo=dmabuf-wayland`) draws the VideoFrame into the texture on the
GPU instead (below). Without the device (`?gpu=0`, the CLI, no WebGL2) the
driver offers no export and readback works as before.

- **Driver**: at a surface's first export it makes two virtio-gpu
  resources on its own open of the render node (libva's device, else
  renderD128: not libva's fd, as GEM handles are per open file and an
  importer on the same fd would close the driver's), Y as R8 (the surface's
  size) and CbCr as R8G8 (half, rounded up), 2D textures with a one-page
  guest backing (nothing maps them), waits for their creation
  (DRM_IOCTL_VIRTGPU_WAIT), and names them to the host (`export`). Each
  export gives new dmabuf fds (PRIME_HANDLE_TO_FD): separate layers
  (DRM_FORMAT_R8 and GR88, one object each, offset 0) or composed (one
  NV12 layer of the two objects), modifier LINEAR, fourcc NV12. Two
  objects because Mesa's virgl imports a classic resource whole (plane
  offsets are dropped for non-blob resources, `virgl_resource_from_handle`).
  The resources live as long as the surface (handles closed after
  `surf_free`; importers keep theirs).
- **Host** (`VaSession`, `Binding`): from the export on, each picture of
  the surface is written into the two textures when it completes, before
  its notice (`#finish` -> `#upload` -> `GpuRenderer.write`: a
  TRANSFER_TO_HOST_3D in no guest context with the rows copied into the
  module's heap, after every virtio-gpu command before it); a picture done
  before the export is written before the reply. Ordering: the guest
  samples after vaSyncSurface (or after the export's reply for a done
  picture), and its draw reaches the renderer after the write, on the same
  thread and WebGL2 context in both modes (in worker mode virtio-gpu
  requests and vsock packets share the worker's channel; the VideoDecoder,
  the VA host and the renderer are all on the page's thread, so frames are
  never transferred). A picture of an exported NV12 surface is copied to
  NV12 when it comes out; the bytes stay with the picture (also after a
  `get` for an exported surface) until its surface is rendered again or
  freed. A failed picture's resources get its readback stand-in. Resources
  of another format than the export says (the guest names them) are not
  written: an export error or `uploadFailed`. Cost past `copyTo`: one
  copy of the planes into the heap and two texture uploads, 0.4-0.5 ms at
  720p and 1.2 ms at 1080p here (`uploadMs`), on the host's CPU for a
  software decoder; a hardware decoder's frames make a GPU-to-CPU copy in
  `copyTo` first.
- **Video processing** (VAProfileNone / VAEntrypointVideoProc, only where
  export works): NV12 into BGRX surfaces (VA_RT_FORMAT_RGB32), colour
  conversion only (no filters, no scaling: the picture top left), for
  compositors that take RGB dmabufs only. A BGRX surface exports as one
  XRGB8888 resource with a backing of its size (wland's relay refuses a
  buffer past its resource's guest backing). Its picture (`vpp`) is made
  when the input completes, before its notice; the driver's vaEndPicture
  waits for that (mpv and ffmpeg never sync the output, and the commit
  follows at once), on either path:
  - GPU (default where the renderer has `video()`): the input's held
    VideoFrame drawn into the resource's texture (`GpuRenderer.video`:
    texSubImage2D, RGBA, no colour management or premultiply; the frame's
    visible rect, top left, cropped to the surface, e.g. 1920x1080 of a
    1088-row H.264 frame; the rest black), then closed uncopied. The
    browser converts by the frame's colour space, so the path is taken only
    where that is the conversion asked for (`frameConversion`: bt709 is
    BT.709, smpte170m, bt470bg and none are BT.601, as Chromium 151 converts
    a frame naming no matrix; limited unless fullRange) and full-range RGB
    is asked; the frame's display size must be its visible size (else drawn
    scaled). This virgl build keeps B8G8R8X8 as RGBA8 texels in RGBA order
    (transfers swizzle on a GLES host), so the frame's RGB lands right; the
    resource is not Y_0_TOP (the upload's row 0 is the top). The
    renderer's state (pixel store, unpack buffer, the active unit's 2D
    binding) is restored, between the guest's commands (all on one
    thread).
  - CPU (otherwise, per picture, counted in `gpuFallbacks` by reason): the
    frame copied to NV12 (`copyTo`), converted (`nv12ToBgrx`, BT.601 or
    BT.709 from the pipeline parameters, limited or full range, 16.16 fixed
    point, chroma from the nearest sample) and uploaded (`write`). Reasons:
    no renderer or a lost context, `upload: "cpu"`, the surface not
    exported yet (mpv exports a surface after its first picture), the frame
    copied already (read back first, or over the cap), a colour space other
    than the one asked for, limited-range RGB asked, the draw failed (a GL
    error, or a browser whose texSubImage2D refuses a VideoFrame), a
    display size other than the visible one.
  Read back (ffmpeg's `scale_vaapi` + `hwdownload,format=bgr0`, mpv's
  screenshots): `get` answers BGRX, the exported resource read back
  (`GpuRenderer.read`) where the picture was written there, else (not
  exported) the input converted on the CPU; the driver makes BGRX images
  (vaCreateImage, vaDeriveImage, vaGetImage of a BGRX surface into a BGRX
  image). BGRX is in vaQueryImageFormats and the VPP config's surface
  formats (ffmpeg's bgr0 frames need it); vaQueryVideoProcPipelineCaps
  points `caps` at the driver's arrays (ffmpeg passes it uninitialised).
  The host logs the conversion each stream asks for when it changes.
- **Frame lifetime** (`Held`): where the renderer can draw frames and
  `upload` is not "cpu", a decoder output is held uncopied and its picture
  is done at once; the first consumer decides: a `vpp` into an exported
  BGRX surface draws it and closes it; a `get`, an NV12 export of its
  surface (or an NV12-exported surface's picture as it comes out), a
  `vpp` that goes the CPU way, `ctx_free` and a context replaced copy it
  to NV12 and close it; the surface rendered again or freed closes it
  (none of its pictures left), the stream's end closes all. AV1's display
  picture shares its picture's frame. At most 4 frames are held per
  context (HOLD_MAX): beyond, the oldest is copied to NV12 and closed, as
  every frame was before (an app that never reads, such as ffmpeg's
  `-f null`, pays that copy). A picture read back after the GPU took its
  frame gets the stand-in (failed) once, and the stream's later frames
  are copied to NV12 as well after their draw, so readback stays exact.
  A failed picture's stand-in is the context's last picture copied to
  NV12, on the GPU path possibly an older one, or grey.

What the consumers take (sources read 2026-11-25: mpv 0.40.0, ffmpeg
7.1.5, firefox-esr 153.7.0esr, gst-plugins-bad and -base 1.26.2, Mesa
25.0.7, all Debian trixie):

- **mpv** (`video/out/hwdec/hwdec_vaapi.c`, `dmabuf_interop_gl.c`,
  `dmabuf_interop_pl.c`, `dmabuf_interop_wl.c`, `vo_dmabuf_wayland.c`):
  probes the sw formats of vaQueryImageFormats by exporting a fresh
  surface of each (no picture: the host writes black) and needs as many
  planes as the format has. `--vo=gpu`/`gpu-next`: separate layers, each
  plane imported as an EGLImage (R8, GR88; modifiers passed where EGL has
  the extension), GLES needs GL_OES_EGL_image (desktop GL would need
  GL_EXT_EGL_image_storage). `--vo=dmabuf-wayland`: composed layers handed
  to the compositor as a wl_buffer; the layer's format must be in the
  compositor's linux-dmabuf table, and wland's has AR24, XR24, AB24, XB24
  only ("drm format 'NV12(0000000000000000)' is not supported by
  compositor"), so mpv converts with scale_vaapi to bgr0, which the video
  processing above serves.
- **ffmpeg** (`libavcodec/vaapi_decode.c`, `libavutil/hwcontext_vaapi.c`):
  a decoder's sw format is the best match of the config's surface formats
  for the stream (NV12 for 8-bit 4:2:0); its map has no RGB entries, so an
  RGB-only decoder config fails ("No usable formats"); frames of a format
  need it in vaQueryImageFormats.
- **Firefox** (`widget/gtk/vaapitest/vaapitest.cpp`,
  `dom/media/platforms/ffmpeg/FFmpegVideoDecoder.cpp`,
  `FFmpegVideoFramePool.cpp`, `widget/gtk/DMABufSurface.cpp`,
  `widget/gtk/GfxInfo.cpp`, `security/sandbox/linux/SandboxFilter.cpp`):
  the probe opens the render node, vaInitialize, and vaCreateConfig per
  profile; decoding exports every frame with separate layers, read only,
  then vaSyncSurface; NV12, YV12, P010, P016 only (RGB refused); each layer
  one plane, any object per layer (fds dup'ed), EGLImages R8 and GR88 of
  the descriptor's size, modifiers passed unless INVALID. Decoding runs in
  the RDD process, whose seccomp filter refuses socket() (EACCES): the
  driver's vsock link fails there unless `MOZ_DISABLE_RDD_SANDBOX=1`.
- **GStreamer** (`gst-libs/gst/va/gstvadisplay.c`, `sys/va/gstvacaps.c`,
  `gstvabasedec.c`, `gst-libs/gst/va/gstvaallocator.c`; gst-plugins-base
  `gst-libs/gst/gl/gstglupload.c`, `egl/gstglcontext_egl.c`): registers
  elements only for Intel and Mesa vendor strings unless
  `GST_VA_ALL_DRIVERS=1`; offers memory:DMABuf only with DRM_PRIME(_2) in
  the surface attributes and a LINEAR (not INVALID) modifier on a probe
  export; exports each surface once at allocation (read-write, separate
  layers, one plane per layer asserted) and pushes buffers without
  vaSyncSurface, so a sink can sample before the host wrote the picture
  (the guest kernel's virtio-gpu submit waits on no implicit fences).
- **Mesa** (`src/gallium/winsys/virgl/drm/virgl_drm_winsys.c`,
  `src/gallium/drivers/virgl/virgl_resource.c`, `virgl_screen.c`,
  `src/gallium/frontends/dri/dri2.c`): imports a PRIME fd of another
  opener's resource by PRIME_FD_TO_HANDLE and RESOURCE_INFO (the host
  resource id), keeps the EGL attributes' size as the template, accepts
  any modifier, has no query_dmabuf_modifiers (EGL lists formats without
  modifiers, which GStreamer takes as LINEAR only); NV12 is listed through
  YUV lowering to R8 and RG88, sampled through samplerExternalOES.

Decisions: NV12 as exact planes rather than RGB, since every consumer
that maps surfaces into GL (mpv, Firefox, GStreamer) takes only YUV
fourccs and converts in its own shaders (the guest's GL on the GPU), and
the picture stays exact; the browser's conversion of a VideoFrame
(`texImage2D`) is inexact and RGB-only. RGB only for dmabuf-wayland,
through video processing, where the browser's conversion is what the app
asked for anyway: drawn from the VideoFrame on the GPU (no readback of a
hardware frame, no CPU conversion), the CPU path kept as the fallback and
the exact reference. No `vaPutSurface` (X11): nothing that runs here needs
it.

## Encode

`VAEntrypointEncSlice` for VP9 profile 0 (8-bit 4:2:0) where
`VideoEncoder.isConfigSupported` takes VP9 (`js/core/va-enc.ts`; the
hello's `encode`; `vainfo` lists `VAProfileVP9Profile0 :
VAEntrypointEncSlice`). One `VideoEncoder` per encode context, configured
at its first picture, `latencyMode: "realtime"` (one chunk per frame, in
order; measured: never held). Codec knowledge is an `EncoderAdapter` per
context (`ENCODERS`: the picture's parameters read, the codec string,
per-frame options such as CQP's quantizer, chunk fix-ups); the rest is
codec-neutral (`VaEncoders`).

- **What the app dictates and WebCodecs does not let it**: VA's VP9
  encode lets the app choose the frame type, the reference slots and which
  to refresh (`ref_flags`, `refresh_frame_flags`, `reference_frames[8]`),
  the reconstructed surface, QP and loop filter, segmentation, tiles,
  hidden frames and superframes (ffmpeg's `vaapi_encode_vp9.c` sends all
  of them: refresh 0xff and the last frame in slot 0 without B-frames).
  The encoder makes its own choices for all but the key frames
  (`keyFrame` where `frame_type` is 0 or `force_kf` is set) and, in CQP,
  each frame's quantizer (`luma_ac_qindex` to libvpx's 0 to 63, the
  nearest of `vp9_quantizer_to_qindex`). The app only muxes the bytes and
  the encoder keeps its own references, so the stream is valid whatever
  reference structure the app believed it asked for. The driver
  advertises what keeps apps on that subset: `VAConfigAttribEncMaxRefFrames`
  1 (one list-0 reference, none in list 1: ffmpeg then uses I and P
  frames whatever `-bf`, so no hidden frames and nothing to reorder; the
  `vp9_superframe` filter the WebM muxer inserts passes single frames
  through), `VAConfigAttribEncPackedHeaders` none (the encoder writes the
  whole frame), the host's rate control modes. Ignored: the reference
  fields above, `reconstructed_frame`, loop filter and sharpness, delta
  QPs, segmentation, tiles, `intra_period` and `kf_*` (ffmpeg asks for
  each key frame anyway), HRD, quality level; max frame size and ROI are
  not offered. A picture asking for a hidden frame (`show_frame` 0) is
  encoded shown (logged once).
- **Reconstructed surfaces** get nothing (a readback gives black): apps
  name them only as references for the hardware, which here is the
  encoder's own; ffmpeg and GStreamer never read them.
- **Rate control**: `cqp` (offered only where bitrateMode "quantizer"
  works), `cbr` ("constant"), `vbr` ("variable"), from the config's
  `VAConfigAttribRateControl` (CQP by default). The bitrate is
  `VAEncMiscParameterRateControl`'s `bits_per_second` times its
  `target_percentage` (ffmpeg's VBR without `-maxrate` sends twice the
  target at 50%), else the sequence's; the frame rate
  `VAEncMiscParameterFrameRate`'s (30 without). A change reconfigures
  (`configure()` without a flush: no key frame, libvpx takes the rate at
  the next frame; under 1 ms in Chromium 151); another size, with a key
  frame. ffmpeg's default (no `-b:v`) tries ICQ, then CQP: CQP at
  quality 100 (qindex 100, quantizer 25).
- **Inputs**: NV12 surfaces the app writes through a derived image
  (ffmpeg's hwupload: vaDeriveImage, vaMapBuffer2 with
  VA_MAPBUFFER_FLAG_WRITE, which reads nothing back) or vaPutImage (no
  scaling; a rectangle short of the surface reads the rest back first).
  The driver counts those writes (a generation per surface); an encode
  sends the surface's pixels (its whole store, `get`'s layout) unless the
  host keeps that generation already (an unchanged surface encoded again:
  ffmpeg's frame duplication, a static source; the host keeps each
  surface's last upload until `surf_free`, 256 MiB a stream) or the
  surface holds a decoded picture the guest never read back (decode to
  encode, `-hwaccel vaapi -hwaccel_output_format vaapi`): then the host
  encodes its own copy of the picture, waiting for it if pending, as one
  more consumer under Frame lifetime: its held VideoFrame, cloned (still
  held for later consumers), else its NV12; nothing crosses vsock. The
  guest's NV12 goes to the encoder as BT.601 limited (VA carries no
  colour; ffmpeg's swscale makes NV12 so by default and its decoders take
  a VP9 stream of unknown colour so; libvpx writes BT.709 for a frame
  naming none); a decoded picture keeps its decoder's colour space, also
  when it was copied to NV12 (past the hold cap: ffmpeg decodes ahead),
  since a stream mixing the two made Chromium's encoder start key frames.
- **Output**: the chunk comes with the picture's notice (`coded`) and
  becomes the coded buffer's one `VACodedBufferSegment` (status 0;
  VA_CODED_BUF_STATUS_FRAME_SIZE_OVERFLOW when larger than the buffer,
  still returned whole; a failed picture: empty,
  VA_CODED_BUF_STATUS_BAD_BITSTREAM). vaSyncBuffer (ffmpeg's async encode,
  2 pictures in flight) and vaMapBuffer of the coded buffer wait on the
  condition variable for the notice, as vaSyncSurface does for a decode
  (no link lock); vaSyncSurface of the input waits too. Coded buffers
  hold no memory of their own (ffmpeg's are 3 times the surface's size).
- **Robustness**: each VideoFrame the host makes is closed after
  `encode()` (which clones it), a decoded frame's clone after its chunk;
  inputs are kept until their chunk for a replay. An encoder error or a
  reclamation (QuotaExceededError, also an encoder found closed before
  its error callback) makes a new encoder that encodes the pictures the
  old one had not given again, the first a key frame: the stream stays
  decodable (ffmpeg's packet flags do not mark that key frame). After two
  failures in a row without a chunk the pictures owed fail (each new
  picture tries once more; reclamations do not count). A stall (no chunk
  for 8 encode latencies, 100 ms to 2 s, 1 s before the first, with
  nothing queued) flushes the encoder; pictures the flush does not give
  go to a new one. A destroyed context's pictures still complete. Chunks
  over 63 MiB fail; buffers, input layouts and sizes are checked.
- **Sizes**: any, odd too (641x361); VP9 surfaces are 64-aligned
  (ffmpeg's reconstructed surfaces, the context's size), the frame is the
  picture parameters' size; a resolution change is a new context.

## Adding a codec

- Host: a `CodecKind` in `CODECS` (wire profile name, a codec string to
  probe) and an adapter in a module of its own (`va-h264.ts`,
  `va-av1.ts`, `va-hevc.ts` are the patterns). `picture()` gets every VA
  buffer of the picture with its type and element size (`VA_BUF`;
  `sliceRanges()` cuts slice data by slice parameters) and `refs`.
  `mode()` is required (a codec without a model returns "conservative");
  `filler()` where a state-neutral chunk exists; `order` on chunks where
  the decoder reorders; `variants`/`probe()` for packagings a decoder may
  want instead.
- `config()` may return null until the first picture brings what the
  description needs; Annex B / OBU stream form needs no description.
- Driver: a `codecs[]` entry: profile, wire name, minimum sizes of its
  buffer types, `nrefs` and a `refs()` reading the reference surfaces out of
  its picture parameters, and `display()` if a picture writes a second
  surface.
- Check every synthesised header against a real stream's or read it back
  (test/va-h264.test.ts, test/va-av1.test.ts), then decode through the
  relay with a native ffmpeg (Testing): a wrong field usually shows as an
  error in the first picture. For a codec no decoder here takes, `--dump`
  with a stand-in decoder (HEVC: `--stub-hevc`) and decode the dump
  natively.
- Encode: an `EncodeKind` in `ENCODERS` (va-enc.ts) and its
  `EncoderAdapter` (`picture()` reads the codec's sequence and picture
  parameters into `EncodeParams`, `config()` the codec string and keys of
  its own, `options()` per-frame options, `chunk()` fix-ups); in the
  driver the codec's `enc_pic_min`, `enc_seq_min` and `enc_coded_off`
  (where the picture parameters name the coded buffer).
- ffmpeg downloads with vaCreateImage + vaGetImage + vaMapBuffer per frame
  (`vaapi_map_frame`: derive only for non-read or direct maps), and calls
  vaSyncSurface first; a sync error there is `AVERROR(EIO)` to hwdownload.

## Testing

- `pnpm test:va` (no browser): `test/va.test.ts`: VP9 headers on libvpx's
  own frame headers (vp90-2-10-show-existing-frame{,2}, checked against the
  frame counts of their `.md5` files) and refused garbage; `frameToNv12`'s
  NV12, odd-size I420 and RGBA paths and a format-null frame's canvas; `VaHost` on a fake vsock and a fake
  WebCodecs whose outputs carry their chunk's tag byte: the hello (version
  check), notices and `get`, hidden pictures, a slow decoder not flushed, a
  holding one gone conservative and released by a filler, reclaimed and
  failing decoders, picture ids across a freed and reused surface, failures
  while handling a picture, `ctx_free` (its pictures still complete), an
  oversized frame, split frames, `inject("fail")`; export into a fake
  GPU's resources (black before a picture, each picture's exact planes at
  its completion, a done picture at the export, a surface larger than its
  picture, readback after an export, `surf_free`, a renderer that cannot
  write, resources of another format) and `vpp` (BT.709 and BT.601 values,
  an input still pending, a gone input, an input decoded over and held by
  its decoder while the output is waited for, read back as BGRX).
  `test/va-frames.test.ts`: frame lifetime with a fake GPU that draws
  frames, on the fake decoders (which count frames not closed and closed
  twice): a vpp drawing its input's frame (before the input came out) and
  closing it uncopied, the BGRX readback from the texture, a readback after
  the GPU took the frame (the stand-in once, then copies); colour, a
  failing draw, `upload: "cpu"` and an unexported output going the CPU way;
  the cap (7 outputs, 4 held, 3 copied), readback, surface reuse,
  surf_free, an NV12 export, ctx_free and the stream's end; a display
  picture sharing its picture's frame, an orphaned input; an H.264 decoder
  holding 2 more (fillers, flushes, replays): no frame left open.
  `test/va-decoders.test.ts`: fake decoders (`test/va-fake.ts`) that are
  not the modelled one, each running H.264 (B-pyramid over two IDR
  periods, P-only) and VP9 (hidden frames) as a single-threaded app (each
  picture synced and read right after its own output delay) and as a
  decode-ahead one: libavcodec's output exactly (the model), holding 1 or
  2 more than declared (dropping late pictures or not), holding to the DPB,
  ignoring the reorder depth and holding 4, decode order at once, sorted
  timestamps (with and without holding), needing a description (avcC
  after Annex B fails), rejecting the VUI; every picture must be its own,
  and the stalls, fillers, flushes, restarts and fallbacks of each are
  printed (Results); also the mode switch and its log line, VaOptions.mode,
  later contexts starting conservative, the stats a report needs.
  `test/va-h264.test.ts`: the bit writer and reader, emulation prevention,
  x264's SPS and PPS (Baseline, High with B-pyramid, custom scaling lists in
  the PPS, MBAFF) parsed, written and parsed again, the SPS and PPS the
  adapter makes from VA's parameters against x264's fields and slice
  headers, PPS ids and default reference counts, the output model and
  `leastReorder`, levels, refusals. `test/va-av1.test.ts`: AV1's ns, su,
  leb128 and the global motion code against libavcodec's decoder of it,
  the sequence header read back, the slots (stored in a free slot, held for
  the next picture's map, decoded again), the filler, refusals; HEVC's RPS
  from VA's ReferenceFrames and a slice header naming an SPS set written
  again inline, its slice data kept, a long-term mismatch refused.
  `test/va-enc.test.ts`: encoding (VaEncoders) on a fake VideoEncoder
  whose chunk carries its frame's first luma byte: pictures with pixels,
  kept pixels, decoded pictures as inputs, key frames, rate control from
  the misc buffers and a change of it, CQP's quantizer, an encoder failing,
  reclaimed (closed before its callback), holding its output (the stall
  flush), dropping it at a flush, failing for good, injections, ctx_free
  with pictures in flight, hostile input, the stream's end; through
  VaHost: the hello, an encode context, decoded pictures as inputs (a
  pending one whose surface is decoded into again; on the GPU path a held
  frame cloned, not copied, then read back); every VideoFrame closed once.
  `pnpm test:vk` checks that the host's vsock ports are distinct.
- `node test/va/relay.mjs [--inject WHAT:EVERY] [--dump DIR] [--stub-hevc]
  [--hold-extra N] -- CMD`: the host in headless Chromium (the Playwright
  one; WebCodecs needs no GPU flags) on a tcp port, CMD run with
  `KWVA_LINK` set, e.g. `vendor/build/va/native/va-decode -d
  vendor/build/va/native/kw_drv_video.so clip.ivf`. `va-decode`
  (`va/test/va-decode.c`) drives the driver's vtable without libva as
  ffmpeg's hwaccel does (VP9 only: superframes split, show_existing_frame
  read from the slot's surface, readback by vaDeriveImage and vaGetImage in
  turn) and prints each frame's MD5 as libvpx's test vectors' `.md5` files
  do. `-e` (`va/test/va-export.h`) also exports each shown picture (before
  its sync, as mpv), imports both planes as EGLImages (surfaceless EGL on
  the render node, libEGL loaded at run time), draws each plane as it is
  (must equal the readback exactly: 8-bit texels to 8-bit channels at texel
  centres through normalized coordinates, so a size mismatch shows) and a
  BT.601 limited conversion (within 1 of the CPU's double arithmetic: the
  GPU's float math and rounding to 8 bits are not bit-defined against it);
  `-E` also the composed NV12 image through samplerExternalOES, Mesa
  converting (within 3: its own coefficients). `--inject` runs `VaHost.inject()` (reclaim, error, flush, fail)
  every EVERY pictures. `--dump DIR` appends every chunk the host decodes
  (not replays or fillers) to `DIR/ctx-ID.PROFILE`; `--stub-hevc` gives
  HEVC a stand-in decoder (grey pictures) where WebCodecs has none;
  `--hold-extra 16` keeps HEVC's SPS the same through a stream (the
  declared reorder at the DPB), so the dump decodes natively (a changed SPS
  mid-stream resets ffmpeg's DPB). `test/va/webm-ivf.mjs` turns a WebM file
  into IVF. H.264, AV1 and HEVC run through a native ffmpeg: on a host with
  no DRM node (this one), a Debian trixie container (ffmpeg 7.1 with
  libaom, SVT-AV1, libdav1d, libx265; libva 2.22; the native driver,
  `--network host`) with an `LD_PRELOAD` whose `drmGetNodeTypeFromFd`
  answers 2 (a render node), `LIBVA_DRIVER_NAME=kw LIBVA_DRIVERS_PATH=...
  KWVA_LINK=tcp:127.0.0.1:10220 ffmpeg -init_hw_device vaapi=va:/dev/null
  -hwaccel vaapi -hwaccel_device va ...` against the same ffmpeg's software
  decode (`-fps_mode passthrough`: libaom's vectors repeat timestamps); for
  HEVC the dump against software decode with `-apply_cropping 0` (the
  SPS has no conformance window): seconds per clip. The container shares
  the host's PID namespace: kill nothing inside it by pattern.
- `node test/va/check.mjs` (`--worker`, `--no-push`, `--skip`, `--cmd`):
  Debian in headless Chromium with `va: true, gpu: true` and the prepared
  disk `$KW_BUILD/va/debian-va.img` (`test/va/debian-disk.mjs`: vainfo,
  ffmpeg, mpv; 118 s, 547 MiB); samples downloaded once into
  `$KW_BUILD/va/samples`; the H.264 clips (x264 of the 720p VP9 clip, its
  table `H264`) and the AV1 ones (libaom and SVT-AV1 of it, table `AV1`)
  are made in the guest by Debian's ffmpeg the first time and kept there,
  `h264-twopps` by `test/va/h264-pps.mjs` (every other picture on a second
  PPS with another pic_init_qp, slice headers rewritten). Steps: vainfo
  (plain and `--display drm`: VP9, the three H.264 profiles, AV1), va-decode
  on libvpx's vectors against their MD5s, ffmpeg `-hwaccel vaapi` against
  ffmpeg's software decode (framemd5 of yuv420p), decode-ahead (hwdownload)
  on every clip and plain (the decoder thread reads each frame) on some,
  where more hold-timer flushes than one per VA context fail the step;
  libaom's AV1 vectors against their per-frame MD5s; recovery (va-decode
  and ffmpeg with decoders reclaimed, flushed and failed mid-stream, VP9,
  H.264 and AV1 in both modes: still exact; ffmpeg with every 20th picture
  failing: it goes on); modes (`VaHost.setOptions`: H.264 conservative from
  the start, decode-ahead and plain, and plain with H.264 declaring 1 and 2
  more reorder frames than it needs, so Chromium's decoder holds that many
  more than the model: exact frames whatever the stalls); frame rates; mpv
  `--hwdec=vaapi-copy` (VP9, H.264, AV1); encode (`skip=encode`):
  ffmpeg's `vp9_vaapi` from testsrc2 (CQP, `-global_quality 60`, VBR and
  CBR at 2 Mbit/s, `-g 30`, 641x361, 1080p), the 720p clip, a
  decode-to-encode transcode (nothing uploaded) and with encoders
  reclaimed, failed and flushed mid-stream, each output decoded in
  software in the guest (`/tmp/enc/check.sh`): every frame, the key frames
  asked, the bitrate within half to 1.5 times the target, PSNR against the
  source; `va-encode` (`va/test/va-encode.c`: the driver's vtable without
  libva, pixels by vaPutImage, a derived image or unchanged surfaces)
  through vaPutImage; frame rates of ffmpeg and of `va-encode` with pixels
  sent each frame and with unchanged surfaces (the upload's cost). Each step's line has its
  pictures, stalls, fillers, flushes, restarts, replays and modes.
- `node test/va/check.mjs --gl` (with `--worker`, `--skip` as above):
  zero-copy, guest GL on (WebGL2 on ANGLE/SwiftShader, `--gl-flags`), the
  renderer from `$KW_BUILD/gl-wasm`: `export` (va-decode `-e` on the
  vectors and 30 frames of the 720p clip, `-E` on the first), `wland` (mpv
  `--hwdec=vaapi` in a Wayland window on wland/headless on the page, the
  image's relay with `--dmabuf virtgpu`, `gpu.resolve` = `vm.gl.gpu.image`:
  `--vo=gpu` and `dmabuf-wayland` judged (uses vaapi, no readback, every
  frame uploaded, presented by GPU resource, a sampled frame with many
  colours; dmabuf-wayland: at least 90% of the pictures drawn on the GPU,
  the sampled frame against the CPU path's conversion of the same picture
  (`VaOptions.verify`, `vm.va.reference()`) within a mean difference of 2
  and 99% within 8 a channel; also on H.264, and with `upload: "cpu"`, all
  on the CPU), `gpu-next` reported; `--vos`), `bgr0` (ffmpeg `scale_vaapi=
  format=bgr0,hwdownload` on VP9, H.264 and AV1 638x358 against swscale's
  conversion of the same NV12 with the matrix and ranges asked: PSNR at
  least 38 dB), `mpvfps` (`--vo=gpu` vaapi against vaapi-copy, and
  `dmabuf-wayland` with video processing on the GPU and on the CPU
  (`vaapi-cpu`), VP9 and H.264, 720p and 1080p, `--mpv-frames`, untimed,
  swap interval 0: frames/s, the guest's CPU per frame from bash's `time`,
  and the host's cost per picture by path). `--disk $KW_BUILD/va/debian-va-apps.img`
  (`debian-disk.mjs --apps`: firefox-esr, GStreamer; 1.5 GiB) with
  `--gst` (vah264dec and vavp9dec into glimagesink in the window) and
  `--firefox` (`--ffclips`; a page with `<video autoplay muted loop>`, a
  fresh profile, `MOZ_DISABLE_RDD_SANDBOX=1`, until the host decoded 90
  pictures for it or 600 s); `--cpus N` (the SMP kernel in worker mode,
  the page cross-origin isolated) and `--mem MIB` for Firefox.
  `--mpv-env`/`--mpv-grep`, `--gst-env`/`--gst-grep` for debugging.

## Results

This host: i7-10700K, Chromium 151 (Playwright's chromium-1234) WebCodecs
(libvpx, FFmpeg's h264 and dav1d in software; no hardware decoder, no HEVC),
the guest under kwemu on one CPU, `test/va/check.mjs` inline (driver pushed)
and `--worker --no-push` (the base's driver): all 113 steps pass
in both (94 before encode); with `--gl` all 141 inline (122 before
encode, also in worker mode then) (2026-11-25).

- vainfo lists `VAProfileVP9Profile0`, `VAProfileH264ConstrainedBaseline`,
  `VAProfileH264Main`, `VAProfileH264High` and `VAProfileAV1Profile0` with
  `VAEntrypointVLD`, driver "kwva (WebCodecs: software)", with no
  environment variables (HEVC is not offered: no decoder takes it).
- va-decode: every frame's MD5 equals libvpx's for
  vp90-2-10-show-existing-frame (13 frames, 4 hidden), -frame2 (16) and
  vp90-2-08-tile-4x4 (1080p, 5), natively through the relay and in the
  guest, also with the decoder reclaimed, flushed or failed every few
  pictures.
- VP9, ffmpeg 7.1 `-hwaccel vaapi`: framemd5 equal to its software decode on the
  three vectors, 60 frames of Big Buck Bunny 720p and arf720 (90 frames
  with 6 alt-refs in superframes; 60 of them also with decoders reclaimed,
  flushed and failed mid-stream). With every 20th picture failing on the
  host ffmpeg exits 0 with all 60 frames, those 3 being the previous one.
- H.264, ffmpeg 7.1 `-hwaccel vaapi` framemd5 equal to its software decode
  in the guest, every frame, decode-ahead on all of: Big Buck Bunny 720p (60
  frames) and 1080p (30), x264 Baseline, Main, High, B-pyramid with 3
  B-frames and 4 references, custom asymmetric scaling lists (PPS), 4
  slices per frame, open GOP (keyint 30, 90 frames), 1000x562 (cropped by
  ffmpeg), MBAFF, a 720p-to-480p change (two VA contexts), a Main-to-High
  change (one context: the profile raised, a reconfigure at the IDR), two
  PPS ids; plain on BBB 720p, B-pyramid, open GOP, the resolution change
  and two PPS ids, each with at most the one 100 ms flush at the stream's
  end. Recovery: the 300 frames of BBB 720p (one IDR mid-way, pictures held
  across it) with decoders reclaimed, flushed and failed every 7, 11 and 13
  pictures, decode-ahead and plain: exact. Every B-frame stream needed two
  reorder raises (0 to 1 to 2 at its 3rd and 4th pictures); Baseline and
  the two-PPS clip none.
- H.264 against a decoder that is not the modelled one, on the real one
  (Chromium's FFmpeg h264, steps `mode-*`): conservative from the start
  (decode-ahead and plain) and with Chromium's decoder holding 1 more
  than the model says (plain), exact on BBB 720p, Baseline (POC type 2),
  B-pyramid, open GOP and MBAFF; holding 2 more (plain), exact on
  B-pyramid. Holding 1 more: one stall in model mode, the switch, then a
  filler per picture (MBAFF: a flush per picture, no filler). Holding 2
  more: a filler, then a flush per picture with its replay.
- AV1, ffmpeg 7.1 `-hwaccel vaapi` (the av1 decoder with VA) framemd5 equal
  to ffmpeg's software decode (libdav1d, film grain applied) in the guest,
  every frame, decode-ahead on all of: libaom's vectors
  av1-1-b8-23-film_grain-50, -22-svc-L1T2 and -06-mfmv (also equal to
  libaom's own per-frame MD5s: the reference decoder's output, grain
  included), Big Buck Bunny's AV1 clips 720p (60 frames) and 1080p (30;
  test-videos.co.uk), libaom 720p (60 frames, keyint 30: hidden alt-refs
  and show_existing_frame), SVT-AV1 (60), SVT-AV1 film grain 12 (60),
  SVT-AV1 superres (denominators 12 and 11), libaom 4x2 uniform tiles and
  3x3 tiles, libaom 638x358; plain on BBB 720p, libaom and film grain.
  Recovery (reclaimed, flushed, failed every 7, 11, 13 pictures) on BBB
  720p and libaom, decode-ahead and plain: exact. Natively through the
  relay as well, also libaom's -01-size-16x16, -66x66 and -04-cdfupdate,
  and the remaining clips plain. "Exact" with film grain: the guest's
  software decode and libaom's MD5s apply grain too (AV1's grain synthesis
  is normative), so the grained frames are compared bit for bit. Pictures
  decoded again (the app's map held 8 pictures, the picture waited for
  before the next came), natively: BBB 720p plain 288 of 301, libaom plain
  28 of 60; decode-ahead none (292 and 42 held for the next picture's map
  instead).
- HEVC (no WebCodecs decoder here: the access units the adapter makes,
  dumped through the relay with a stand-in decoder and decoded by ffmpeg
  7.1's native hevc decoder) frame-exact against software decode of the
  original, decode-ahead and plain: x265 (WPP on: default with B-pyramid,
  4 references and 4 B-frames, 4 slices, default scaling lists, 1000x562,
  open GOP with CRA and RASL pictures, closed GOP), Big Buck Bunny's HEVC
  720p (300 frames, test-videos.co.uk), and JCT-VC conformance streams
  (HM-made, sets in the SPS): TILES_A/B, RPS_A/B/E/F (inter RPS
  prediction), DSLICE_A (dependent slices, WPP), WP_A (weighted
  prediction), RPLM_A (list modification), SLIST_A/B (scaling lists, SPS and
  PPS, predicted), PPS_A (several PPS), CONFWIN_A, ipcm_A, NUT_A (NAL unit
  types, temporal sub-layers), STRUCT_B, POC_A. LTRPSPS_A (long-term
  pictures named by SPS candidates) is refused, by design. x265 makes no
  long-term references or tiles, and puts every set in the slice header.
- Frame rates (2026-11-25; inline driver pushed, worker the base's), BBB's 10 s clips, ffmpeg's rtime,
  decode-ahead (`-hwaccel_output_format vaapi -vf hwdownload`) / plain
  (`-hwaccel vaapi -f null`):

  | frames/s | 720p inline | 720p worker | 1080p inline | 1080p worker |
  | --- | --- | --- | --- | --- |
  | VP9 | 171 / 154 | 167 / 133 | 93 / - | 86 / - |
  | H.264 (model mode) | 124 / 120 | 174 / 106 | 81 / 74 | 90 / 63 |
  | H.264 conservative from the start | 128 / 117 | 175 / 107 | | |
  | H.264, decoder holding 1 more (fillers), plain | 87 | 80 | | |
  | H.264, decoder holding 2 more (flushes), plain, 60 frames | 13 | 16 | | |
  | AV1 | 151 / 81 | 157 / 72 | 91 / 64 | 84 / 55 |

  (VP9 720p and 1080p: 300 frames; H.264 1080p: 600 at 60 Hz; AV1: 300.)
  Conservative mode costs nothing where the decoder is the modelled one (3
  stalls per stream instead of 1: the switch's restarts and the end).
  Holding 1 more costs a filler per picture (the first few after a 10 ms
  timer, then at once): 87 instead of 120. Holding 2 more costs a flush and
  a replay from the IDR per picture: 13. AV1 plain is slower than
  decode-ahead because most pictures are decoded twice (above). ffmpeg's
  software decode in the guest: 9 frames/s at 720p (VP9). Natively through
  the relay the host decodes H.264 and VP9 at 175-195 frames/s at 720p, AV1
  (BBB) at about 150.

- Fake decoders (`pnpm test:va`, the report at its end; stalls are
  hold-timer fires, a plain app on H.264 B-pyramid of 22 pictures over two
  IDR periods, P-only of 12, VP9 of 10 with 2 hidden):

  | fake decoder | H.264 B-pyramid | H.264 P-only | VP9 |
  | --- | --- | --- | --- |
  | libavcodec's output (the model) | 1 (the end, 100 ms flush) | 0 | 0 |
  | holds 1 more (dropping late ones or not; sorted timestamps too) | 6, 18 fillers, 1 flush | 5, 12 fillers | 4, 10 fillers |
  | holds 2 more | 15, 4 fillers, 10 flushes | 16, 3 fillers, 12 flushes | 5, 20 fillers |
  | holds to the DPB | 15, 3 fillers, 11 flushes | 16, 3 fillers, 12 flushes | 34, 24 fillers, 10 flushes (holds 16) |
  | ignores the reorder depth, holds 4 | 15, 3 fillers, 11 flushes | 16, 3 fillers, 12 flushes | 7, 40 fillers |
  | decode order at once | 0 | 0 | 0 |
  | sorted timestamps | 3, 2 fillers, 1 flush | 0 | 0 |
  | needs a description (1 fallback to avcC) | 3, 2 fillers, 1 flush | 0 | |
  | rejects the VUI (2 fallbacks) | 3, 2 fillers, 1 flush | 15, 3 fillers, 12 flushes | |

  Every picture comes out as its own in every variant, plain and
  decode-ahead (decode-ahead: at most 4 stalls). The first stall of a
  holding decoder is model mode's (250 to 500 ms); after it, 10 ms timers
  and, once fillers keep working, none.

- mpv 0.40 `--hwdec=vaapi-copy --vo=null` uses vaapi-copy on VP9, H.264 and
  AV1.
- Zero-copy (2026-11-25, `check.mjs --gl`, WebGL2 on ANGLE/SwiftShader,
  inline and `--worker`, the driver pushed and `--no-push`): va-decode
  `-e` on libvpx's three vectors and 30 frames of the 720p clip: every
  exported picture's planes drawn through EGL equal its readback exactly,
  its BT.601 conversion within 1 (at most 1 seen), the composed NV12
  image (Mesa's conversion) within 1 too. mpv `--hwdec=vaapi` in a Wayland
  window on wland/headless (the relay of the Debian image, wland
  0.1.0-261124-3c987e5): `--vo=gpu` (GLES, "Using EGL dmabuf interop via
  GL_OES_EGL_image", `VO: [gpu] 1280x720 vaapi[nv12]`), `--vo=gpu-next`
  and `--vo=dmabuf-wayland` (`vaapi[bgr0]` through scale_vaapi): 0
  readbacks, one upload per frame, every frame a commit by GPU resource, a
  sampled frame a picture of the clip (150 000 to 460 000 colours).
- Video processing on the GPU (2026-11-25, `check.mjs --gl`, inline and
  `--worker`; software decoders, so the frames are I420 in memory and the
  GPU-to-GPU claim for hardware frames is unverified here): mpv
  `--vo=dmabuf-wayland` on VP9 and H.264 at 720p and 1080p: 118 of 121
  pictures drawn from the VideoFrame (the first 3, before mpv exported
  their surfaces, on the CPU), 0 copies to NV12 but where checked, at most
  6 frames open at once (4 held plus copies in flight); the frames report
  `bt709 limited` (Chromium's software VP9, H.264 and AV1 decoders tag
  streams without a colour description so; a frame built with no matrix
  converts as BT.601), which is what mpv asks for at 720p and up, so
  BT.601 pictures (mpv's guess below 720 rows) go the CPU way, counted as
  `colour`. A sampled compositor frame against the CPU path's conversion
  of the same picture: max 10 to 12, mean 0.8, 99% within 8 a channel
  (Chromium converts software frames with libyuv here; its BT.709
  coefficients are coarser than its BT.601 ones: on test frames BT.709
  limited max 7, mean 0.94, BT.601 max 2, mean 0.16; full range max 1).
  ffmpeg `scale_vaapi=format=bgr0,hwdownload` (BGRX read back, converted on
  the CPU) against swscale's conversion of the same NV12: 39.6 to 40.6 dB
  on VP9 720p, H.264 720p and AV1 638x358 (ffmpeg asks BT.709 for all
  three, and limited-range RGB where the stream says tv).
- Host cost per picture and mpv's frame rate, GPU against CPU video
  processing (2026-11-25, inline and worker mode, i7-10700K, SwiftShader, software
  decoders, 120 frames untimed; frames/s; host ms a picture: GPU the draw,
  CPU the copy to NV12 plus conversion and upload):

  | `--vo=dmabuf-wayland` | 720p VP9 | 1080p VP9 | 720p H.264 | 1080p H.264 |
  | --- | --- | --- | --- | --- |
  | GPU (default) | 24.4, 9.8 | 16.6, 17.6 | 22.8, 8.8 | 16.3, 16.0 |
  | CPU (`upload: "cpu"`) | 26.2, 1.3 + 7.6 | 18.8, 2.7 + 16.8 | 24.9, 1.2 + 7.1 | 17.1, 2.4 + 17.4 |
  | GPU, worker mode | 26.0, 9.5 | 18.2, 16.8 | 25.6, 9.6 | 17.8, 16.2 |
  | CPU, worker mode | 26.5, 1.4 + 7.7 | 19.2, 2.8 + 16.8 | 25.5, 1.3 + 7.2 | 18.3, 2.4 + 17.0 |

  No gain on this host: for a frame in memory Chromium's texSubImage2D
  converts it with libyuv and uploads it synchronously in the call (8 ms a
  720p frame, 13 to 15 ms a 1080p one in a bare page; the getError after it
  adds under 1 ms), about what the copy and the JS conversion cost. The
  gain is for hardware frames (the M4 Pro: `copyTo` readback plus 8.7 ms
  of conversion and upload at 1080p), not measured here. The compositor's
  image of each commit (`image()`, the drawing buffer resized to it) cost
  1.4 to 2.3 ms at 720p and 3 to 5.4 ms at 1080p on either path.
- Frame rates and the guest's CPU per frame (2026-11-25, inline, one CPU,
  i7-10700K, SwiftShader; BBB's 10 s clips, 120 frames, `--untimed
  --opengl-swapinterval=0`, wall clock and user+sys of mpv; frames/s,
  ms a frame; runs vary by about 10%):

  | mpv | 720p VP9 | 1080p VP9 | 720p H.264 | 1080p H.264 |
  | --- | --- | --- | --- | --- |
  | `--vo=gpu --hwdec=vaapi` (zero-copy) | 11.9, 81 | 5.1, 189 | 11.6, 83 | 5.2, 154 |
  | `--vo=gpu --hwdec=vaapi-copy` | 10.6, 91 | 4.7, 180 | 10.9, 79 | 4.7, 205 |
  | `--vo=dmabuf-wayland --hwdec=vaapi` | 27.0, 27 | 19.5, 27 | 24.3, 27 | 17.8, 29 |
  | `--vo=gpu-next --hwdec=vaapi` | 18.3, 51 | | | |

  The copy path moves 1.4 MB a 720p frame and 3 MB a 1080p one over vsock
  (160 and 360 MiB for 120 frames); zero-copy moves none. With `--vo=gpu`
  the frame rate hardly moves: mpv's own GL rendering through Mesa's virgl
  under kwemu costs 70 to 190 ms of guest CPU a frame either way, and the
  copy's share of it (the readback, the NV12 copy, the texture upload) is
  10 to 50 ms. `--vo=dmabuf-wayland` leaves out the guest's GL entirely: 2.2
  to 3.8 times the copy path, bounded at 1080p by the host's BGRX
  conversion (16 ms a frame in JS here; 7 ms at 720p; on the GPU path the
  browser's draw costs about the same here, above). The host's NV12
  upload is 0.4 to 0.6 ms a 720p frame and 1.1 to 1.3 ms a 1080p one.
  Worker mode (720p VP9): `--vo=gpu` 10.0, `gpu-next` 19.7,
  `dmabuf-wayland` 26.5 frames/s.
- Firefox (firefox-esr 153.7.0esr, `debian-disk.mjs --apps`): its probe
  (`vaapitest -d /dev/dri/renderD128`) accepts the driver: `VAAPI_SUPPORTED
  TRUE`, codecs 1296 (H.264, VP9, AV1 decode). Playing a clip did not reach
  the driver in this harness: on wland/headless, 2 GiB, inline on one CPU
  and in worker mode on 4 (`--cpus 4`), with `MOZ_DISABLE_RDD_SANDBOX=1`
  and hardware decoding forced, Firefox mapped its window (50 to 100
  commits by GPU resource in 6 to 10 min) but never loaded the local page
  (its title never changed), its RDD process announced "support=H264
  SWDEC" only, and no VA context was made (`opened` counted the probe
  alone). Not examined further (firefox-esr is slow in this guest).
- GStreamer 1.26.2 (`--gst`): with `GST_VA_ALL_DRIVERS=1` vah264dec,
  vavp9dec and vaav1dec register with memory:VAMemory, memory:DMABuf
  (DMA_DRM, `drm-format=NV12`) and system memory caps; into glimagesink
  in the window (and glupload with gldownload) the decoder is offered
  system memory only, so frames go by readback (300 readbacks for 300
  frames), and a capsfilter forcing memory:DMABuf does not link (glupload
  answers DMA_DRM caps only once it has a GL context). Not zero-copy.
- Encode (2026-11-25, `check.mjs` inline, the driver pushed; Chromium
  151's software VP9 encoder, libvpx: `isConfigSupported` says
  prefer-software only, up to 4096x2304, odd sizes too): vainfo lists
  `VAProfileVP9Profile0 : VAEntrypointEncSlice`. ffmpeg 7.1 `vp9_vaapi`,
  each output decoded in software in the guest, every frame, PSNR (Y, U,
  V average) against the same source through NV12:

  | source, options | frames | key frames | kbit/s | PSNR dB |
  | --- | --- | --- | --- | --- |
  | testsrc2 720p, default (CQP, quality 100) | 120 | 0 | 9456 | 55.3 |
  | same, `-rc_mode CQP -global_quality 60` | 60 | 0 | 10589 | 58.6 |
  | same, `-b:v 2M` (VBR) | 120 | 0 | 1500 | 36.8 |
  | same, `-b:v 2M -maxrate 2M` (CBR) | 120 | 0 | 2044 | 38.4 |
  | same, `-b:v 2M -g 30` | 120 | 0 30 60 90 | 1580 | 36.8 |
  | testsrc2 641x361, `-b:v 1M` | 60 | 0 | 682 | 39.4 |
  | testsrc2 1080p, `-b:v 4M` | 60 | 0 | 2795 | 37.7 |
  | Big Buck Bunny 720p (software decode, uploaded), `-b:v 1M -g 60` | 120 | 0 60 | 1346 | 37.2 |
  | the same clip decoded by VA-API and encoded (transcode), `-b:v 2M` | 120 | 0 | 2180 | 37.9 |
  | testsrc2 720p `-b:v 2M`, encoders reclaimed, failed, flushed every 7, 11, 13 pictures | 120 | 25 | 1685 | 36.0 |

  libvpx stays under its target on testsrc2's flat colour (VBR) and gives
  more than it on Big Buck Bunny over 4 s (key frames weigh). The
  transcode sent no pixels (120 pictures from the host's own decoded
  pictures; the same stream tagged BT.601 measured 41.0 dB, so the PSNR
  of a stream depends on its colour tag in this comparison, ffmpeg 7.1's
  filters converting); the recovery run made 27 new encoders, each starting with a
  key frame, and every frame decodes. libvpx also adds key frames of its
  own at scene cuts (va-encode's pattern, which flips every 8 frames: 17
  in 120). Natively through the relay (the podman image's ffmpeg) the same
  plus 642x362, 16x16, 300 frames of the clip and of the transcode.
  vaPutImage, derived-image writes and unchanged surfaces give the same
  stream (va-encode at 641x361).
- Encode frame rates and the upload's cost (2026-11-25, one CPU,
  i7-10700K, `-b:v 2M`; frames/s inline / worker; va-encode's ms a frame
  inline):

  | | 720p | 1080p |
  | --- | --- | --- |
  | ffmpeg `vp9_vaapi` from testsrc2 (hwupload) | 70 / 57 | 36 / 37 |
  | ffmpeg making the same source alone (testsrc2, NV12) | 104 / 108 | 53 / - |
  | va-encode, pixels sent each frame | 80.8 / 78.2; 12.4 ms (writing 1.8, vaEndPicture 1.8, sync 8.7) | 47.1 / 43.3; 21.2 ms (3.8, 4.6, 12.8) |
  | va-encode, unchanged surfaces (nothing sent) | 176 / 161; 5.7 ms | 95.6 / 94.9; 10.5 ms |

  va-encode waits for each picture before the next (ffmpeg keeps 2 in
  flight). Sending a frame's NV12 (1.4 MB at 720p, 3.1 MB at 1080p) costs
  about 5 ms at 720p and 7 ms at 1080p beyond writing it (vaEndPicture's
  write into vsock plus the host turning more bytes into a VideoFrame),
  about 270 and 440 MB/s; ffmpeg's encode from testsrc2 is bounded by
  making the source in the guest. The host's encode itself is 4 to 8 ms
  a 720p frame and 12 ms a 1080p one (libvpx realtime).
- Firefox, Safari and WebKit not run: Playwright's WebKit (webkit-2388)
  does not start here (no GStreamer libraries), there is no Playwright
  Firefox, and neither has JSPI for the kernel (only the relay would run).

## Unsupported and open (2026-11-25)

- Codecs: VP9 profile 0, H.264 Constrained Baseline, Main and High, AV1
  Main 8-bit, HEVC Main 8-bit (WebCodecs leg unverified; offered only where
  isConfigSupported says yes, e.g. Chrome with a hardware HEVC decoder,
  Safari). VP8 is not offered (VA's VP8 slice data starts after the frame
  tag and key frame header, and VA's picture parameters lack show_frame, so
  the frame would need rebuilding). 10-bit (VP9 profile 2, AV1 10-bit, HEVC
  Main10) needs P010 surfaces and readback: not offered.
- H.264 refused per picture with a reason (the first printed by the
  driver, the picture reads back as the last good one): field pictures
  (PAFF; MBAFF works), FMO, 4:2:2 and 4:4:4, more than 8 bits (High 10 and
  the like are not offered), pic_order_cnt_type 1 (VA lacks its offsets),
  data partitioning, MVC. Plain Baseline streams (FMO/ASO allowed) go
  through ffmpeg's Constrained Baseline mapping or not at all, as on any
  VA driver.
- H.264 open-GOP and recovery-point streams decode, but a replay starts at
  the last IDR (the 64 MiB history may run out first: then a lost decoder
  fails pictures until an IDR), and a stream that starts at, or is sought
  to, a non-IDR I picture fails until an IDR: Chromium wants an IDR first
  after `configure()`. Rewriting such a picture into an IDR would need its
  slice headers rewritten (frame_num 0, dec_ref_pic_marking).
- Decoders other than the modelled ones (hardware, Safari, Firefox,
  Android's MediaCodec) are untried: the fake decoders and Chromium's own
  decoder made to hold more stand in. What they cost when they hold
  pictures: a single-threaded app gets a filler per picture where one
  suffices (H.264 POC type 0 with even POCs or type 2; VP9; AV1), else a
  flush per picture with a replay from the last key frame (H.264 holding
  2 or more, MBAFF, odd POCs; HEVC always). Decode-ahead apps rarely stall.
  `vm.va.stats.contexts` says which happened.
- AV1: a single-threaded app pays a second decode for pictures stored while
  the app's map holds 8 pictures (above); hidden key frames and
  large-scale tile are refused. HEVC: long-term pictures named by SPS
  candidates are refused; no filler (stalls flush).
- Zero-copy output (Zero-copy output, above): no PutSurface (X11).
  Importers that size the EGLImage smaller than the surface sample it
  stretched: virgl's sampler views use the host texture's size, so mpv,
  whose H.264 frames are cropped to the stream's size (1920x1080 of a
  1088-row surface), shows a 1080p H.264 picture squeezed by 8/1088 with
  the padding rows at the bottom; VP9 and AV1 surfaces are the frame's
  size, Firefox imports the descriptor's size. `mpv --vd-apply-cropping=no`
  keeps the whole surface and crops in the renderer. A fix would need the
  crop in VA (it has none) or virglrenderer honouring the guest's template
  size. GStreamer: elements only with `GST_VA_ALL_DRIVERS=1`; into
  glimagesink (glupload on virgl EGL) the decoder is offered system memory
  only, so frames go the copy path (exact; checked against the same
  pipeline); with DMABuf it would push buffers without vaSyncSurface, which
  needs implicit fencing the guest kernel's virtio-gpu does not do (a
  frame could show the picture before; nothing done). `--vo=dmabuf-wayland`
  goes through BGRX (drawn from the VideoFrame by the browser, or converted
  on the host's CPU); NV12 straight to the compositor needs wland to take
  it (below). Video processing does colour conversion only (no scaling,
  deinterlacing or other filters). Its GPU path: pixels not bit-defined
  (the browser's conversion and chroma upsampling); taken only where the
  frame's colour space is the conversion asked for, and the frames of
  streams without a colour description report what the browser assumes
  (Chromium's software decoders: BT.709 limited), not the stream's matrix,
  which VA does not carry (BT.601 asked of them goes the CPU way); a frame
  naming no matrix is assumed BT.601 as Chromium 151 converts it, unchecked
  on other browsers; Firefox's and Safari's texSubImage2D of a VideoFrame
  untried (a failing draw falls back per picture); a picture read back
  after the GPU took its frame gets a stand-in once (the stream copies
  from then on).
- What would take NV12 dmabufs to the page's compositor without the BGRX
  step (for wland): its relay (`--dmabuf virtgpu`) offering DRM_FORMAT_NV12
  (LINEAR) and naming a buffer's two planes by their two resources (each
  plane its own dmabuf, offset 0; the relay's bounds check takes each
  plane's resource with the plane's own stride and height, and these
  resources have a one-page guest backing, so the check must not apply to
  planes the host only samples, or the driver gives them a full backing),
  wland's GpuRef carrying a resource per plane, and the page's resolver
  composing the two textures (the GL host could draw them through a
  BT.601/709 shader into an ImageBitmap as `image()` does for one).
- Encode: VP9 profile 0 only (H.264, HEVC, AV1 would be an
  `EncoderAdapter` each; H.264: ffmpeg's `h264_vaapi` asks for packed
  sequence, slice and SEI headers and only warns without them, writes no
  extradata then, and its MP4 muxer builds avcC from the first packet, so
  WebCodecs' Annex B with parameter sets in band on key frames should do;
  the same one-reference attribute keeps it on P frames). Not honoured:
  the app's reference structure, hidden frames, QP outside CQP, loop
  filter, HRD, quality level (above); no ROI, max frame size, temporal
  layers, packed headers, 10-bit, ICQ/QVBR/AVBR. Colour: guest NV12 is
  tagged BT.601 limited whatever it is (VA says nothing). A key frame the
  host inserts after a recovery is not flagged in the app's packet. Only
  Chromium's software encoder (libvpx) tried; hardware encoders,
  GStreamer's `vavp9enc` and the real page not run.
- libva needs a DRM display: without the virtio-gpu device (`?gpu=0`, the
  CLI) there is none. On a Wayland or X11 session libva may pick those
  backends first: `vainfo --display drm --device /dev/dri/renderD128`,
  ffmpeg `-hwaccel_device /dev/dri/renderD128`.
- Profiles 1 to 3 of VP9 (4:4:4, 10-bit) are not offered; the
  show_existing_frame the host adds is written for profiles 0 to 2; P010
  is only reserved.
- Resolution changes inside a context: the picture comes back at its own
  size, top left in the surface, the rest black (ffmpeg makes a new
  context for H.264's).
- Not run: a real GPU (its hardware decoder, and zero-copy output's cost
  there: copyTo of a GPU frame, then the upload; video processing's draw of
  a hardware frame, GPU to GPU), Firefox and Safari as
  hosts, Firefox decoding through the driver (above), zero-copy on the page
  itself (only wland/headless in check.mjs), worker mode under load beyond
  check.mjs, SMP beyond the Firefox runs.
