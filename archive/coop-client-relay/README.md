# Client-authoritative co-op relay (retired)

Snapshot notes for the co-op play model used before Plan 1 (server-authoritative Classic cutover).

This folder is **not** part of the build. Versus was never part of this path.

## What the approach was

Each client ran a full Google Snake `GameInstance` as **local truth**:

- `SNAKE_DELTA` — each player published pose/colors; peers drew remotes (mosaic SVG) and applied body-hit collision locally
- `COLLECTABLES_DELTA` — any player (often the eater) published fruit/walls; peers applied into native hosts
- Wall grow, freePos, eat, and death were decided **on clients**, then reconciled over the wire
- `ensure*` / freePos repair layers fought Closure null hosts (`Ca.Aa`, fruit `nba`, …)

Live code that embodied this lived mainly in:

- `src/coop/native.js` (remotes, freePos wraps, tick collision)
- `src/mod.js` (`publishCoopState`, `publishCoopCollectables`, SNAKE/COLLECTABLES handlers)
- `server/src/room.rs` (relay-only `cmd_snake_delta` / `cmd_collectables_delta`)

## Why it was retired

N native engines disagreed on fruit, walls, and deaths. Fixes to one crash class (null Map `.size`, fake-pause menus, apple count) destabilized others. Authority is now a single Rust sim (`COOP_INPUT` → step → `COOP_STATE`); clients bind STATE into native for display and draw **peer snakes as SVG only**.

## Replacement

See plan **Co-op stabilize path** (Plan 1) and `server/src/coop.rs` + `src/coop/binder.js`.
