# multiplayer-server

Dedicated non-playing WebSocket room server for MultiplayerMod.

## Run (LAN)

```bash
cargo run --release -- --bind 0.0.0.0:7777
```

Clients connect to `ws://<lan-ip>:7777/ws`.

## Config

| Flag / env | Default | Meaning |
|------------|---------|---------|
| `--bind` / `MULTIPLAYER_BIND` | `0.0.0.0:7777` | Listen address |
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
