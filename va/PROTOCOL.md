<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- Copyright (C) 2026 Pooya Parsa <pooya@pi0.io> -->
# kwva link protocol (version 4)

The guest's VA-API driver (`va/driver/kwva.c`, libva's `kw_drv_video.so`)
and the host (`js/core/va.ts`, `VaHost`; encoding in `js/core/va-enc.ts`) talk over one byte stream
per VADisplay: AF_VSOCK to host CID 2, port 1024 (`KWVA_LINK`: `vsock:CID:PORT`,
`tcp:HOST:PORT` or `unix:PATH`; `test/va/relay.mjs` serves tcp).

## Framing

As kwvk's (vk/PROTOCOL.md): each frame is `u32 total`, `u32 json_len`
(little-endian), the JSON (UTF-8), zero padding to 4 bytes, then
`total - json_len - pad` binary bytes. `total` is at most 64 MiB either way:
the host ends a stream that sends more (`lost`), the driver treats more as
a dead link. A request carries `"r": N` (from 1, per stream) and its reply
the same `r`; messages without `r` get no reply. Several requests may be in
flight: the driver's reader thread matches replies by `r`.

## Driver to host

| op | fields | binary | reply |
| --- | --- | --- | --- |
| `hello` | `version` | | `version`, `vendor` (text), `profiles` (VA profiles by name, of `vp9.0`, `h264.cb`, `h264.main`, `h264.high`, `av1.0`, `hevc.main`: what `VideoDecoder.isConfigSupported` accepts and has not failed since), `maxWidth`, `maxHeight`, `export` (true: the host can fill exported surfaces, below), `encode` (`{profile: [modes]}`: the profiles `VideoEncoder.isConfigSupported` encodes and their rate control modes, of `cqp` (only where bitrateMode "quantizer" works), `cbr`, `vbr`; `{}` without a VideoEncoder); or `err` (also for another version) |
| `ctx` | `id`, `profile`, `width`, `height`, `entry`? (`"enc"`: an encode context), `rc`? (its rate control: `cqp`, `cbr`, `vbr`) | | `{}`, or `err` (no decoder or encoder for it) |
| `ctx_free` | `id` | | none (its pictures still complete) |
| `dec` | `ctx`, `surface`, `pic`, `profile`, `refs`, `bufs`, `display`? | the buffers' bytes, one after another | none (a notice later) |
| `enc` | `ctx`, `surface`, `pic`, `profile`, `bufs`, `src` | the buffers' bytes, then the input's pixels (`src.pixels`) | none (a `coded` notice later) |
| `wait` | `pic` | | none |
| `get` | `surface`, `pic` | | the picture (below), or `err` |
| `surf_free` | `surfaces` (ids) | | none |
| `export` | `surface`, `pic`, `width`, `height`, `res` (`[y, uv]`; with `format` `"BGRX"`: `[rgb]`) | | `{}` once the host fills them, or `err` |
| `vpp` | `surface`, `pic`, `src`, `srcPic`, `matrix` (`bt601`, `bt709`), `inFull`, `outFull` | | none (a notice later) |
| `release` | | | reserved, not implemented: `err` |

- Ids are the driver's VA ids (kind in the top 4 bits, never reused while
  the counter runs). `pic` is a session-unique picture id the driver gives
  each `dec` (from 1); a surface's picture is its last `dec`'s, and the host
  forgets a picture when its surface is rendered again or freed.
- `dec` is one VA picture: every buffer vaRenderPicture got between
  vaBeginPicture and vaEndPicture, copied at vaRenderPicture. `bufs` is
  `[[type, size, num], ...]` in render order (VABufferType, element size,
  element count; `size * num` bytes each in the binary part): picture
  parameters, slice parameters, slice data, IQ matrix, probabilities, ... as
  the app sent them. `refs` are the picture ids of the surfaces the picture
  parameters name as references, in the codec's order (VP9:
  `reference_frames[8]`, H.264: `ReferenceFrames[16]`, AV1:
  `ref_frame_map[8]`, HEVC: `ReferenceFrames[15]`), 0 for none or a
  surface with no picture. `display` (`[surface, pic]`) is a second surface
  the picture writes, with a picture id of its own (AV1 with film grain
  applied: `current_display_picture`, which gets the picture shown; the
  render target is the reference); it completes with the picture and reads
  back like any.
- `enc` is one VA encode picture (VAEntrypointEncSlice): `bufs` as
  `dec`'s (sequence, picture and misc parameters as the app rendered
  them; never a coded buffer), `surface` its input, `pic` from the same
  counter. `src` says where the input's pixels are: `{"pixels": {"gen",
  "width", "height", "pitch"}}` the surface's NV12 after the buffers
  (`get`'s layout, the surface's size; `gen` the driver's count of the
  guest's writes to the surface: vaPutImage, a derived image unmapped
  after a write map); `{"kept": gen}` the host's copy of that generation
  (its `coded` notice said `kept`); `{"pic": id}` the decoded picture the
  surface holds, which the guest never read back (decode to encode:
  nothing crosses; waited for if pending; a failed one's stand-in);
  `{}` a surface never written (black). The host keeps the last pixels
  sent for each surface until `surf_free` (256 MiB a stream at most;
  beyond, the notice does not say `kept`).
- `ctx_free`: pictures of the context already sent still complete, as on a
  hardware decoder (ffmpeg destroys its context at a size change while
  frames it decoded ahead are still to be read): the host flushes the
  decoder, then closes it; a picture it gives nothing for fails.
- `wait`: the driver's vaSyncSurface is blocked on the picture (sent once
  per picture). Only then does the host's hold timer run (Decoding).
- `get`: the picture's pixels, sent once (the driver keeps them). Waits
  until the picture is done. Reply: `pic`, `format` (`"NV12"`; room for
  `"P010"`), `width`, `height`, `pitches` and `offsets` (per plane) and the
  pixels; with `failed` (why) when the picture failed, the pixels then being
  its context's last good picture, or grey. The layout both sides use: pitch
  `(width + 63) & ~63` for both planes, UV at `pitch * height`, `(height + 1)
  / 2` UV rows (a later dmabuf export can share it). A picture of another
  size is placed top left in its surface, the rest black.
- `export` (vaExportSurfaceHandle, zero-copy output): `res` are two
  virtio-gpu resources the driver made on the render node for the surface
  (`width` x `height`): Y as an R8 texture of that size, CbCr as an R8G8
  one of half of it rounded up, each its own dmabuf at offset 0 (Mesa's
  virgl imports a classic resource whole). From then until `surf_free` the
  host writes each picture of the surface into them (its NV12 planes from
  the host's own copy, top left, the rest black; a failed picture's
  stand-in as `get` gives it), when it completes and before its `ready` or
  `error` notice; a picture already done is written before this reply, and
  a surface without one gets black. So a guest that syncs the surface (or
  got this reply for a picture done already) samples the picture; its
  pixels never cross vsock. The write is a TRANSFER_TO_HOST_3D in no guest
  context through the GL host (`GpuRenderer.write`), after the virtio-gpu
  commands before it; the driver waits for its resources' creation
  (DRM_IOCTL_VIRTGPU_WAIT) before it asks. `err` without the virtio-gpu
  device with 3D (`export` false in the hello), or when the renderer has no
  such resource or it has another format (bytes per texel) than the export
  says. `get` of an exported surface still gives the exact NV12
  (the host keeps an exported surface's picture after a `get`).
- `export` of a BGRX surface (`format` `"BGRX"`, a video processing
  output): `res` is one B8G8R8X8 resource of the surface's size, written
  with its pictures (`vpp`) converted; black before one.
- `vpp` (video processing, VAProfileNone / VAEntrypointVideoProc): a
  picture `pic` on the BGRX surface `surface` that is the picture `srcPic`
  of `src` converted (the matrix, limited or full range in and out, the
  picture top left, no scaling); it completes when its input does (failed
  if the input fails or is gone), and is written into the surface's
  exported resource before its notice (drawn from the decoder's frame on
  the host's GPU where the frame's colour space is the conversion asked
  for, else converted on the host's CPU: exact to the conversion, not
  bit-defined on the GPU). A `wait` for it waits for its input. `get` of
  it answers `format` `"BGRX"`, `pitches` `[width * 4]`, `offsets` `[0]`:
  its exported resource read back where it was written there (what
  importers see), else its input converted (a picture of another size top
  left in the surface, the rest black).
- `release` (reserved): not used; exported resources live as long as their
  surface (the driver closes its handles after `surf_free`; importers keep
  theirs through their dmabufs).

## Host to driver (no `r`)

- `{"ev": "ready", "surface", "pic"}`: the picture is decoded (pixels on
  the host until a `get`).
- `{"ev": "error", "surface", "pic", "err"}`: it failed. The driver's
  vaSyncSurface still succeeds (a failed decode is no reason to end an app),
  vaQuerySurfaceError reports it, and a `get` gives the stand-in picture.
  The first failure is printed on stderr, later ones only with `KWVA_DEBUG`.
- `{"ev": "coded", "pic", "key", "kept"?}` and the chunk: an encode
  picture is done; the chunk (VP9: one frame as the encoder wrote it)
  becomes its coded buffer's one segment; `kept`: the host keeps the
  pixels sent with it. With `err` and no bytes it failed: the coded
  buffer is empty (VA_CODED_BUF_STATUS_BAD_BITSTREAM) and vaSyncBuffer
  says VA_STATUS_ERROR_ENCODING_ERROR. vaSyncBuffer and vaMapBuffer of
  the coded buffer, and vaSyncSurface of the input, wait for it.
- `{"lost": "why"}`: the host's last frame before it ends the stream.

The driver ignores notices for a picture that is not its surface's now.

## Decoding

- One WebCodecs `VideoDecoder` per `ctx` (`optimizeForLatency: true`), made
  at the first key chunk. A per-codec adapter on the host turns a `dec` into
  chunks (VP9: the slice data cut by its slice parameters, i.e. the frame or
  superframe as is); chunk timestamps are mapped back to picture ids, so
  outputs may come in any order (H.264 and HEVC: the timestamps follow the
  output order, so a decoder that hands them out sorted still pairs each
  picture with its own). An output is copied to NV12 and closed at once,
  or, where the host can draw frames on its GPU, held (at most 4 per
  context) until a `vpp` draws it (then closed uncopied) or a `get`, an
  NV12 `export`, the cap or `ctx_free` copies it; the picture's notice
  does not wait for the copy. A
  decoder that fails before its first output moves to the next
  configuration isConfigSupported accepted (another packaging,
  prefer-software); with none left the profile is no longer offered.
- The chunks since the last key chunk are kept (up to 64 MiB). A decoder
  that fails, is reclaimed by the browser (`QuotaExceededError`) or was
  flushed is made again and they are replayed into it, outputs of pictures
  nobody waits for dropped; pictures still owed come from the replay. A
  replay that fails again before a new output, or a stream with no key chunk
  since, fails its pictures until the next key frame.
- Hold timer: runs while the driver waits for a picture of the context
  (`wait`), restarted by outputs and inputs; it fires after a multiple of
  the decode latency with no output and the decoder's `decodeQueueSize` 0.
  Each context starts in model mode (the adapter predicts the outputs;
  VP9, AV1: right after the chunk; H.264: libavcodec's output process) and
  goes conservative when the decoder disagrees (an output the model says is
  held, a fire for a picture the model says is out, pictures a flush does
  not give). In model mode a picture the adapter knows the decoder holds
  for lack of input (H.264's reorder delay at a stream's end) is flushed
  after 100 ms. In conservative mode a fire gets fillers first: chunks that
  change no decoder state and make it give the picture it holds longest
  (their outputs dropped); then a flush, after which the next delta chunk
  makes the decoder again with the history replayed (.agents/va.md, Modes
  and stalls).
- H.264: each picture is one access unit (Annex B, or avcC for a decoder
  that wants a description), an SPS and a PPS made from VA's parameters
  before its slices (.agents/va.md). Key chunks are IDRs. The SPS's
  `max_num_reorder_frames` starts at 0 and is raised, with the decoder made
  again and the stream since the IDR replayed, just before a picture would
  come out of order (model) or late (conservative: the stream's own depth).
- AV1: each picture is a temporal unit with a sequence header (key chunks),
  a frame header and tile groups, all written from VA's parameters; the
  host keeps the decoder's reference slots itself (VA has no
  refresh_frame_flags) and may decode a picture once more, hidden, when the
  next picture's map shows the app kept it (.agents/va.md). Hidden frames
  are written shown, so every picture has its output.
- HEVC: each picture is one Annex B access unit, a VPS, an SPS and a PPS
  made from VA's parameters, the slice headers written again with their
  reference picture sets inline (.agents/va.md); always conservative.
- VP9 hidden frames (`show_frame` 0) give WebCodecs no output: right after
  one the host decodes a one-byte `show_existing_frame` of a slot it
  refreshed, whose output is its picture (.agents/va.md); one that refreshes
  no slot is black.

## Encoding

- One WebCodecs `VideoEncoder` per encode `ctx` (`latencyMode:
  "realtime"`: a chunk per frame, in order), configured at its first
  picture: the picture's size (VP9: `frame_width_dst`), bitrateMode from
  `rc` (CQP: "quantizer", each frame's quantizer from the picture's
  `luma_ac_qindex`), the bitrate from the misc rate control buffer
  (`bits_per_second` times `target_percentage`) or the sequence's, the
  frame rate from the misc frame rate buffer (30 without). A change of
  rate or frame rate reconfigures (no key frame); of the size, with a key
  frame. Key frames where the picture asks (VP9: `frame_type` 0 or
  `force_kf`); the rest of the reference structure is the encoder's own
  (.agents/va.md, Encode).
- An encoder that fails or is reclaimed is made again and the pictures it
  had not given encoded again, the first a key frame; a stall (no chunk
  for 8 encode latencies with nothing queued) flushes it. After two
  failures in a row without a chunk the pictures owed fail (`err`).
- `ctx_free`: its pictures still complete, then the encoder is closed.
