# 更新日志

## v0.2.0 (2026-10-05)

### 新功能
- ✨ 添加了自动更新功能
  - 使用 `--check-update` 在启动时检查是否有新版本
  - 使用 `--auto-update` 自动下载并安装最新版本
- 🚀 添加了 GitHub Actions 自动编译工作流
  - 推送 tag 自动编译多平台二进制文件
  - 支持 Windows (x86_64)、Linux (x86_64)、macOS (x86_64 和 aarch64)

### 使用方法

#### 检查更新
```sh
am-hook --check-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

#### 自动更新
```sh
am-hook --auto-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

### 发布新版本

1. 更新 `Cargo.toml` 中的版本号
2. 创建并推送 tag：
```sh
git tag v0.2.0
git push origin v0.2.0
```
3. GitHub Actions 会自动编译并创建 Release

### 注意事项

- Windows 系统由于无法替换正在运行的可执行文件，自动更新会下载新版本到 `am-hook-new.exe`，需要手动重启完成更新
- Linux 和 macOS 系统会自动替换可执行文件，并将旧版本备份为 `am-hook-backup`
