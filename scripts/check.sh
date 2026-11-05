#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun scripts/build-session-guest.mjs
cargo fmt --check
cargo test --workspace --locked
(cd frontend && bun run build && bun test)
python3 -m unittest discover -s scripts -p 'test_*.py'
