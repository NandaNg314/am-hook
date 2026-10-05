# CHANGELOG

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
