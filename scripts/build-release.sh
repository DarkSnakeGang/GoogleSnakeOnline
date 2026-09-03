#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server"
cargo build --release
echo "Built: $ROOT/server/target/release/multiplayer-server"
echo "Run: ./target/release/multiplayer-server --bind 0.0.0.0:7777"
echo "Share ws://<LAN-IP>:7777/ws"
# Optional systemd unit sketch:
# [Unit]
# Description=Google Snake Multiplayer
# [Service]
# ExecStart=/opt/multiplayer-server/multiplayer-server --bind 0.0.0.0:7777
# WorkingDirectory=/opt/multiplayer-server
# Restart=on-failure
# [Install]
# WantedBy=multi-user.target
