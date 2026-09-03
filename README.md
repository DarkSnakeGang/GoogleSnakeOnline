# Google Snake Online — MultiplayerMod

Online / LAN multiplayer for Google Snake on **[googlesnakemods.com](https://googlesnakemods.com/)** (GSM v13).  
One Mod Loader entry: **`MultiplayerMod`** — fully-featured **Remix is bundled in**. Dedicated **Rust** room server (not a playing browser).

**Repo:** [DarkSnakeGang/GoogleSnakeOnline](https://github.com/DarkSnakeGang/GoogleSnakeOnline)

## Features

| Mode | Players | Behavior |
|------|---------|----------|
| **Versus** | ≤9 | Independent local games; server relays scores/times, settings/Play, attempt timer; Focus + Mosaic spectate (3×3) |
| **Co-op** | ≤4 | Client-native Google Snake + room relay; remotes painted once per engine tick (native `PlayerRenderer`); shared fruit; spawn Y by count (2: ±1, 3: 0/+3/−2, 4: ±1/−4/+4); corpses stay and collide; fruit/objects never spawn on live or dead snakes; unique colors |

- Rooms: ≤**30** connections; join as **spectator**; admin promotes to player  
- First joiner = **admin** (may spectate or play); kick, pass-admin, succession  
- **Ready** gate: Start only when all players Ready  
- Versus attempt timer (default 30 min); Co-op TimeKeeper uses `snake_timeKeeper_coop` only  
- Named Remix/Pudding snake colors (fallback display names)

## Quick start

### 1. Room server

```powershell
npm run server
# or release binary:
cd server
cargo build --release
.\target\release\multiplayer-server.exe --bind 0.0.0.0:7777
```

Clients connect to:

`ws://127.0.0.1:7777/ws` (local) · `ws://<your-lan-ip>:7777/ws` (LAN)

Allow TCP **7777** in Windows Firewall for LAN.

**TLS is optional.** Friends on LAN should use plain `ws://` (no certs). For GSM over HTTPS / public internet, either:

- put Caddy / nginx / Cloudflare Tunnel in front, **or**
- run with native wss: `--tls-cert cert.pem --tls-key key.pem` → `wss://host:7777/ws`

Logs: `server/logs/multiplayer-YYYY-MM-DD.log` (`RUST_LOG=info`).

Ubuntu / Docker:

```bash
cd server && cargo build --release
./target/release/multiplayer-server --bind 0.0.0.0:7777

# optional
cd server && docker compose up --build
```

### 2. Client (GSM)

```bash
npm run build   # bundles sibling GoogleSnakeRemix/RemixMod.js + multiplayer layer → MultiplayerMod.js
```

Load **`MultiplayerMod.js`** in the Mod Loader (select MultiplayerMod only).  
Open the **Multiplayer** settings tab → set server URL → Connect.

**Mixed content:** GSM is HTTPS, so browsers may block `ws://`. For public internet use `wss://` (TLS) or Tunnel; for LAN testing use an HTTP FBX origin or a local proxy.

Env / localStorage: `MULTIPLAYER_SERVER_URL`.

## Protocol

Versioned JSON over WebSocket (`/ws`): `v`, `type`, `from`, `seq`, `payload`.  

Lobby / match: `HELLO`, `ROSTER`, `SET_ROLE`, `KICK`, `READY`, `COLOR_CLAIM`, `MODE_CHANGE`, `SETTINGS_SYNC`, `PLAY_SYNC`, `SESSION_START`, `SESSION_END`, `ERROR`, …  

Versus: `SCORE_PULSE`, `ATTEMPT_*`, `BOARD_DELTA`, `SPECTATE_FOCUS`, …  

Co-op: `SNAKE_DELTA`, `COLLECTABLES_DELTA`, `COOP_PLAYER_DEAD`, `COOP_GOAL` (legacy `STATE_*` ignored).

## Repo layout

- `MultiplayerMod.js` — built loader entry (Remix + multiplayer)
- `src/` — multiplayer JS (net, session, versus, coop, ui)
- `server/` — Rust `multiplayer-server`
- `tests/` — Node client unit tests
- `tools/build.mjs` — concat Remix + layer
- `scripts/build-release.ps1` / `.sh` — native binaries

## Tests

```bash
npm test                          # client unit tests
cargo test --manifest-path server/Cargo.toml
npm run test:all
```

### Manual GSM checklist

Your only GSM site change: add the **MultiplayerMod** radio in the Mod Loader. Everything below is covered by automated harness + WS tests; still worth a quick smoke on GSM after you wire the radio:

- [x] Hooks: settings/`puddingMenuSelect`, Play `NSjDf`, `__mpGame` scrape, pause, TimeKeeper wrap (see `tests/hooks-harness.test.js`)
- [x] Multi-client: kick, succession, SCORE_PULSE, BOARD_DELTA→spectators, room_full(31), PLAY_SYNC, Co-op 3+spec (see `tests/integration.test.js`)
- [x] Versus focus + **mosaic** multi-board spectator UI
- [x] Co-op spawn occupancy (live + corpse) + fruit nudge (see `tests/client.test.js`, harness)
- [ ] Optional smoke on GSM v13 after Mod Loader radio: Connect → Ready → Start → focus/mosaic / co-op

## Caps & defaults

- Connections / room: **30**
- Versus players: **10** · Co-op players: **4**
- Default Versus duration: **30** minutes
- Default bind: `0.0.0.0:7777`

## License

See [LICENSE](LICENSE). Remix is a separate DarkSnakeGang project — respect its license when bundling.
