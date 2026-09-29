# multiplayer-server

Dedicated non-playing WebSocket room server for MultiplayerMod.

## Run (LAN / internet) — recommended

From the repo root, `start-server.bat` (or the console binary) opens a **True Dark** control GUI:

```bash
cargo run --release --manifest-path server/Cargo.toml --bin multiplayer-console
```

- GUI: `http://127.0.0.1:7778` — Start / Stop / **Restart** (rebuilds), live log, **spectate** (co-op shared board · race mosaic/focus)
- Game WS: `ws://<lan-or-public-ip>:7777/ws`
- Spectate JSON: `GET http://127.0.0.1:7777/api/spectate` (also proxied at `:7778/api/spectate`)

**Restart** runs `cargo build --release --bin multiplayer-server`, then relaunches the game process on the latest binary.

### UPnP (cross-internet)

UPnP is **off by default**. Enable with `--upnp` / `MULTIPLAYER_UPNP=true` to open an IGD **TCP** port forward for the bind port (description `GoogleSnakeOnline`) and log a public join URL (`ws://PUBLIC:7777/ws`).

- **Stop** in the console (and Ctrl+C on the game binary) **DeletePortMapping** when a mapping was opened.
- Console GUI `:7778` is **not** mapped — host-only controls.

Discovery sends SSDP from **every** IPv4 adapter (Hyper-V / WSL / VPN adapters no longer hide the router); the adapter that hears the router is the forward target. Router errors are logged with their UPnP error code.

Note: plain `ws://` to a public IP is blocked from HTTPS GSM (mixed content). Use **Secure WSS** below.

### Secure WSS for googlesnakemods.com (Let's Encrypt via DuckDNS)

`https://googlesnakemods.com` can only open `wss://` with a browser-trusted certificate. The server gets a free Let's Encrypt certificate for a free DuckDNS name, validated over DNS, so **no inbound port besides 7777 is needed**:

1. Sign in at [duckdns.org](https://www.duckdns.org) (GitHub/Google), add a subdomain (e.g. `yarmiplay`), and copy the **token** shown on the page.
2. In the console, enter the subdomain and paste the token in the **DuckDNS** row, then **Save**.
3. Tick **Secure WSS (Let's Encrypt)**. The game server restarts, points `yarmiplay.duckdns.org` at your public IP, and requests the certificate. This takes about 30–60 s.
4. Wait for `Public join URL: wss://yarmiplay.duckdns.org:7777/ws` in the log / **Public join URL** cell (click to copy).
5. Friends paste that `wss://` URL into the mod's **Server URL** on googlesnakemods.com.

How it works:

- DNS-01: Let's Encrypt asks for a TXT record at `_acme-challenge.yarmiplay.duckdns.org`; the server sets it through the DuckDNS API, waits until public DNS shows it, lets Let's Encrypt check, then clears it. Nothing connects to your PC except players on 7777 (opened via UPnP).
- The certificate is a normal 90-day one; the server renews at half-life and hot-swaps it without a restart. The DuckDNS name is kept on your current public IP (checked every 5 minutes), so an IP change needs no new certificate.
- The token is stored only in `console-settings.json` (git-ignored) and passed to the game server through the `MULTIPLAYER_DUCKDNS_TOKEN` environment variable, never on the command line or in logs.
- If issuance fails for any reason, the server logs why and falls back to plain `ws://` on the same port, so LAN and `http://` pages keep working.
- Your own browser may need NAT loopback (hairpin) to reach your public IP; friends outside your network are unaffected.
- Account + certs live in `acme/` (git-ignored). Tick **staging** to test against the untrusted staging CA without spending production rate limits.

Without a DuckDNS token, **Secure WSS** falls back to a certificate for your bare public IP (6-day `shortlived` profile). Let's Encrypt only validates IPs on external TCP **80** or **443** (UPnP-forwarded to local `7780` during issuance), so that mode only works if your ISP and router let one of those ports through.

CLI equivalent:

```bash
MULTIPLAYER_DUCKDNS_TOKEN=<token> multiplayer-server --bind 0.0.0.0:7777 --upnp --acme --duckdns-domain yarmiplay
multiplayer-server --bind 0.0.0.0:7777 --upnp --acme --acme-staging   # public-IP mode, staging CA
```

## Run game server only

```bash
cargo run --release --manifest-path server/Cargo.toml --bin multiplayer-server -- --bind 0.0.0.0:7777
```

Clients connect to `ws://<lan-or-public-ip>:7777/ws`.

## Tick / net cadence

- **In-game step:** clients publish co-op poses / race boards on each native Snake tick (`g.Fb`, ~135ms at normal speed).
- **Server room loop:** 16ms flush/GC/sim accumulator (not the pose clock). Native-relay poses fan out as soon as they arrive.
- **Console spectate:** polls `/api/spectate` every 16ms.

## Config

| Flag / env | Default | Meaning |
|------------|---------|---------|
| `--bind` / `MULTIPLAYER_BIND` | `0.0.0.0:7777` | Game listen address |
| `--gui-bind` / `MULTIPLAYER_GUI_BIND` | `0.0.0.0:7778` | Console GUI (`multiplayer-console` only) |
| `--upnp` / `MULTIPLAYER_UPNP` | `false` | Map TCP bind port via UPnP/IGD |
| `--no-upnp` | — | Force UPnP off (redundant when default is off) |
| `--acme` / `MULTIPLAYER_ACME` | `false` | Let's Encrypt IP certificate → serve `wss://` (conflicts with `--tls-*`) |
| `--acme-ip` / `MULTIPLAYER_ACME_IP` | auto | Public IP to certify (default: UPnP WAN IP, else HTTPS lookup) |
| `--acme-dir` / `MULTIPLAYER_ACME_DIR` | `acme` | Account + certificate cache |
| `--acme-challenge-port` / `MULTIPLAYER_ACME_CHALLENGE_PORT` | `7780` | Local port receiving forwarded external :80 challenges |
| `--acme-staging` / `MULTIPLAYER_ACME_STAGING` | `false` | Use the staging CA (untrusted, for testing) |
| `--acme-email` / `MULTIPLAYER_ACME_EMAIL` | — | Optional ACME contact e-mail |
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
