# Browser MV core

This module is compiled to `src/ui/mv-core.wasm` and runs only in a Web Worker.
The Rust server does not link it. Go is a build dependency, not a runtime service.
`python scripts/build-mv-wasm.py` rebuilds the WASM and copies the matching Go
runtime. The checked-in assets were built with Go 1.22.1.

The worker builds PlayReady challenges, parses licenses, decrypts CENC/CBCS
fragments, normalizes decode timestamps and merges initialization metadata.
`c608/` rewrites malformed closed-caption samples in place (Apple starts the
c608 track with an all-zero sample, which recent FFmpeg rejects and mpv then
treats as a fatal read error) as same-size `cdat` atoms of CEA-608 null pairs.
JavaScript downloads CDN resources directly, feeds MediaSource or writes
interleaved fragments to OPFS. After muxing, the worker defragments that OPFS
file into a progressive MP4 (`ftyp`, `moov`, `mdat`) through synchronous
access handles: only sample tables are held in memory and sample data is
streamed from the fragmented file. Media data is interleaved: every track is
cut into chunks of at most one second, written in decode-time order, so video,
audio and captions for the same moment sit close together. Working memory is otherwise bounded by
current fragments and the playback buffer. No transcoding or tag writing is done.
Only the two wrapper control requests go through Rust.

Each download holds a Web Lock named after its `am-hook-mv-<uuid>` OPFS files
until they are disposed. When the MV page loads and before each download, any
such file whose lock is not held (tab closed or crashed, worker killed during
defrag) is deleted. Without Web Locks, only files untouched for 24 hours are.

## Sources

- Vendored `puppyready/` is unchanged from
  <https://git.gay/itouakirai/puppyready>, commit
  `17be0787ee7f02f27b71a99ac3d40ab2bd61ec04` (including its default device).
  Its README attributes the implementation to pyplayready and describes upstream
  licensing; the repository does not supply a separate license file.
- MP4 encryption/decryption uses `github.com/itouakirai/mp4ff`, pinned in
  `go.mod` / `go.sum`, and its Eyevinn dependencies. Their MIT notices are included.
- Workflow reference: `internal/app/mv.go`, `internal/playready-rip/run.go`,
  `internal/widevine-rip/decrypt.go` and `internal/media/mv/mux.go` in
  <https://github.com/itouakirai/apple-music-downloader>, commit
  `487f705cdb693b194fe8dfedafd1064ea6570d05`. The wrapper uses only PlayReady.
- `defrag/defrag.go` is adapted from `internal/media/defrag/defrag.go` at the
  same commit, with file-system IO replaced by `io.ReadSeeker` / `io.Writer`.
- Go's runtime notice is in `GO-LICENSE`.
- The Apple Music reference page uses MusicKit's `apple-music-video-player`.
  This implementation uses the browser's native accessible video controls and
  independent layout; no Apple player scripts are redistributed.

## Validation

`node tests/mv_hls.cjs`, `cargo test --test mv_api` and `go test ./c608 ./defrag` (in this
directory) are offline checks.
`tests/mv_live.cjs` is an opt-in real browser test and writes a downloaded MP4
under `target/`. It checks playback, seeking, cancellation, OPFS cleanup and
that media URLs go directly to Apple. Use `ffprobe` / `ffmpeg` on the resulting
file to verify its streams and decodability.
