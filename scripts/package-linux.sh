#!/usr/bin/env bash
# Genera output/streamhive-linux-<arch>.tar.gz: backend release + livekit-server + frontend + lanzador.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=$(uname -m); OUT="output/streamhive-linux-$ARCH"
cargo build --release --locked -p streamhive
(cd frontend && bun run build)
LK=runtime/bin/livekit-server; [ -x "$LK" ] || bun scripts/install-livekit.mjs
rm -rf "$OUT" && mkdir -p "$OUT/bin"
cp target/release/streamhive "$LK" "$OUT/bin/"
cp -r frontend/dist "$OUT/web"
install -m755 packaging/linux/streamhive.sh "$OUT/streamhive.sh"
tar -czf "$OUT.tar.gz" -C output "streamhive-linux-$ARCH"
ls -lh "$OUT.tar.gz"
