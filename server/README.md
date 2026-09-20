# multiplayer-server

Dedicated non-playing WebSocket room server for MultiplayerMod.

## Run (LAN) — recommended

From the repo root, `start-server.bat` (or the console binary) opens a **True Dark** control GUI:

```bash
cargo run --release --manifest-path server/Cargo.toml --bin multiplayer-console
```

- GUI: `http://127.0.0.1:7778` — Start / Stop / **Restart** (rebuilds), live log, **spectate** (co-op shared board · race mosaic/focus)
- Game WS: `ws://<lan-ip>:7777/ws`
- Spectate JSON: `GET http://127.0.0.1:7777/api/spectate` (also proxied at `:7778/api/spectate`)

**Restart** runs `cargo build --release --bin multiplayer-server`, then relaunches the game process on the latest binary.

## Run game server only

```bash
cargo run --release --manifest-path server/Cargo.toml --bin multiplayer-server -- --bind 0.0.0.0:7777
```

Clients connect to `ws://<lan-ip>:7777/ws`.

## Config

| Flag / env | Default | Meaning |
|------------|---------|---------|
| `--bind` / `MULTIPLAYER_BIND` | `0.0.0.0:7777` | Game listen address |
| `--gui-bind` / `MULTIPLAYER_GUI_BIND` | `0.0.0.0:7778` | Console GUI (`multiplayer-console` only) |
| `--coop-native-relay` / `MULTIPLAYER_COOP_NATIVE_RELAY` | `true` | Co-op product path (`native-relay-v1`). Set `false` for legacy server-sim |
| `--log-dir` / `MULTIPLAYER_LOG_DIR` | `logs` | Rolling log files |
| `RUST_LOG` | `info` | tracing filter |

## Docker (optional)

```bash
docker compose up --build
```

## TLS / wss (optional)

**Default = plain `ws://`.** Fine for LAN friends.

For native TLS on this process (e.g. public GSM / mixed-content):

```bash
multiplayer-server --bind 0.0.0.0:7777 --tls-cert fullchain.pem --tls-key privkey.pem
# clients: wss://host:7777/ws
```

Env: `MULTIPLAYER_TLS_CERT`, `MULTIPLAYER_TLS_KEY`. Both required together.

You can also terminate TLS in front (Caddy, nginx, Cloudflare Tunnel) and keep this process on plain WS.
