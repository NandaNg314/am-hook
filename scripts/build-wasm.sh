#!/usr/bin/env sh
# 构建浏览器端 wasm（随二进制内嵌发布）：
#   crates/am-wasm -> src/ui/hook.wasm（歌曲解密）
#   crates/am-flac-wasm -> src/ui/flac.wasm（ALAC 转 FLAC）
#   crates/am-media-wasm -> src/ui/media.wasm（MV 的 PlayReady / CENC / 合并，歌曲与 MV 的 defrag）
# 修改 crates/ 下任一相关 crate 后需重新运行并提交产物。
# 需要：rustup target add wasm32-unknown-unknown；可选 wasm-opt（binaryen）进一步压缩。
set -eu
cd "$(dirname "$0")/.."

cargo build -p am-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_wasm.wasm src/ui/hook.wasm
cargo build -p am-flac-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_flac_wasm.wasm src/ui/flac.wasm
cargo build -p am-media-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_media_wasm.wasm src/ui/media.wasm

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-bulk-memory src/ui/hook.wasm -o src/ui/hook.wasm
  wasm-opt -Oz --enable-bulk-memory src/ui/flac.wasm -o src/ui/flac.wasm
  wasm-opt -O3 --enable-bulk-memory src/ui/media.wasm -o src/ui/media.wasm
fi

ls -l src/ui/hook.wasm
ls -l src/ui/flac.wasm
ls -l src/ui/media.wasm
