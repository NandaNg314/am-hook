# CHANGELOG

## v0.2.2 (2026-10-06)

### New Features
- ✨ The lyrics translation button is now a lyrics options menu
  - Adjust lyrics text size (70%–150%) and font weight (Light to Heavy)
  - Switch the lyrics source between Apple Music and the [AMLL TTML DB](https://amll.dev/reference/http-api/overview): looked up by Apple Music song ID, falling back to Apple Music lyrics for songs it doesn't have; it is only contacted when chosen
  - Download the TTML lyrics being shown
  - Text size, font weight and lyrics source are saved in the browser
- ✨ Read the AMLL TTML DB dialect (inline translations and romanizations, background vocal translations) and credit its lyric authors

### Bug Fixes
- 🐛 Clicking a song on the Favorite Songs page played the wrong track

## v0.2.1 (2026-10-06)

### Bug Fixes
- 🐛 Compare versions numerically; v0.10.0 and later were treated as older releases
- 🐛 Check for updates in the background with timeouts, so an unreachable GitHub no longer delays startup
- 🐛 Report a clear HTTP error on non-2xx responses such as GitHub API rate limiting
- 🐛 `--auto-update` on an unsupported platform now reports an error instead of crashing
- 🐛 On Linux/macOS the executable is replaced atomically; it stays intact if any step fails
- 🐛 The Windows manual update steps name the actual exe file

### Other
- CI runs tests for the whole workspace; end-to-end tests that need the live CDN / wrapper-lite are ignored by default
- Upgraded GitHub Actions to current versions (Node.js 24)

## v0.2.0 (2026-10-05)

### New Features
- ✨ Added auto-update functionality
  - Use `--check-update` to check for updates on startup
  - Use `--auto-update` to automatically download and install the latest version
- 🚀 Added GitHub Actions automated build workflow
  - Automatically builds multi-platform binaries when tags are pushed
  - Supports Windows (x86_64), Linux (x86_64), macOS (x86_64 and aarch64)

### Usage

#### Check for updates
```sh
am-hook --check-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

#### Auto-update
```sh
am-hook --auto-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

### Releasing a new version

1. Update the version number in `Cargo.toml`
2. Create and push a tag:
```sh
git tag v0.2.0
git push origin v0.2.0
```
3. GitHub Actions will automatically build and create a Release

### Notes

- On Windows, since the running executable cannot be replaced, auto-update will download the new version to `am-hook-new.exe`. Manual restart is required to complete the update.
- On Linux and macOS, the executable will be automatically replaced, with the old version backed up as `am-hook-backup`.

---

## v0.1.0

Initial release
