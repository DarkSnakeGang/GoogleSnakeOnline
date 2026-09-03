# Native Focus spectate (retired)

Snapshot of the Focus spectate view from when it puppeted a real `GameInstance`,
kept in case we go back to it. Taken at commit
`617ded184faf10e4c3bf4a00ee96ff38b3ad872d`, before Focus moved to drawing the
watched board with the mosaic renderer.

This folder is **not** part of the build — `tools/build.mjs` uses an explicit
`layerFiles` list and never globs.

## What the approach was

The spectator did not draw the watched player at all. It started a real local
run and then overwrote that engine's state from every `BOARD_DELTA`, so Google's
own renderer drew the remote player's snake, fruit and mode entities. Watching
looked exactly like playing, because it *was* the game — just with someone
else's board written into it each tick.

Getting there needed a seat: `startNativeRun` clicked Play until
`isNativeRunLive()` agreed a run existed, then `applySpectateState` wrote the
remote body into `game.oa.ka` and the remote fruit into `game.wa.ka`.

## Engine hooks it depended on

These all live in `src/hooks/gsm.js` and are gated on
`window.__mpVersusFocusSpectate`, so they go dormant on their own now that
nothing sets that flag:

- `applySpectateState` — writes remote body/fruit/entities into the local engine
- `startNativeRun` / `isNativeRunLive` / `prepareNativePlay` — seat a run
- `installFocusDieGuard` — swallow local `die()` while the remote is alive
- `installFocusTickGuard` + `reapplyFocusBody` — undo local physics each tick
- `__mpVersusFocusOnTick` — per-tick re-inject, patched in by
  `alterSnakeCodeExposeGame`
- the `__mpFocus*` seat flags, whose lifecycle lived in `src/runtime/bridge.js`
  (`clearFocusSeat`, `markFocusSeatSuccess`, `markFocusSeatFailed`,
  `prepareFocusSeatAttempt`)

## Why it was retired

The seat was never stable. A spectator has no input, so the puppet run kept
dying on its own and every death had to be caught and undone: the die guard, the
tick guard, the off-grid parked apple to dodge the empty-fruit `ALL` path, and a
per-frame `hideDeathScreen()`.

Admin spectators broke it outright. Escape peek sets `__mpSpectateAllowMenus`,
which stops the per-frame `hideDeathScreen()`, so the endscreen came back — and
the re-seat check running every 45 frames answered by clicking Play again. The
run restarted, died with no input, showed the endscreen, and got restarted:
a visible loop of the deathscreen resetting over and over.

The replacement draws the board instead of becoming it. Focus is now one big
mosaic cell sized to the game canvas, the spectator's own game is left
completely alone, and there is no seat, no Play click and no death UI to fight.
