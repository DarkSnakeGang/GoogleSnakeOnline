# Fully-native co-op (retired)

Snapshot of the "100% native" co-op rendering approach, kept in case we go back to it.
Taken at commit `617ded184faf10e4c3bf4a00ee96ff38b3ad872d`, before co-op moved to the
partially-native model (mosaic-style remote snakes + phantom-wall collision).

This folder is **not** part of the build — `tools/build.mjs` uses an explicit
`layerFiles` list and never globs.

## What the approach was

Remote co-op players were not separate engine objects. Each client ran one local
`GameInstance`, and remote snakes were drawn by **Google's own `PlayerRenderer`**:
for every remote, `paintCompanionsOnce` temporarily wrote that remote's body into
the local snake (`game.oa.ka`), swapped the snake's colors, called
`renderer.render(t, true, opts)`, then restored the local body, direction and colors.

`native.js` in this folder is the whole mechanism. The pieces:

| Piece | Role |
| --- | --- |
| `installCoopRenderHook` / `wrapRenderer` | Captured the `PlayerRenderer` on first native `render()` and wrapped it so companions repainted after each local draw |
| `paintCompanionsOnce` | The body-swap render pass, one call per remote |
| `applyRemoteColors` / `restoreColors` | Temporarily repainted the local snake config (`Sc`/`Yc`/`color1`/`color2`, plus `slot_yy_paint_snake_hex`) in each remote's colors |
| `cloneBody` / `snapshotBody` / `bodyIsRenderable` | Native point objects with working `.clone()`, and NaN guards — Closure throws `yi NaN NaN NaN` on non-finite lerp or coords |
| `sanitizeRenderArgs` | Clamped NaN lerp progress out of `render(a,b,c)` |
| `startCorpsePaintLoop` | Throttled RAF that kept companions visible after local death, when engine ticks stop |
| `__mpCoopOnTick` friendly collision | Compared local head against remote body cells and called `game.die()` after the fact |

## Engine hooks it depended on

These live in `src/hooks/gsm.js` (`alterSnakeCodeExposeGame`) and are shared with
other features, so they were not copied here:

- `window.__mpCoopOnTick(this)` injected into native `tick()`
- `window.__mpCoopRenderEnter(this,a,b,c)` injected at the top of native `render(a,b,c)`
- `Gsm.writeNativeBody`, `Gsm.followBodyFromHead`, `Gsm.makeNativePoint`

## Why it was retired

- **Cost.** A companion pass cloned the body, recolored the snake config, ran a full
  native snake render, and restored state — per remote, per frame. With two players
  actually moving, co-op was unplayable.
- **Fragility.** Sharing one `GameInstance` and one `PlayerRenderer` across N snakes
  meant constant fights over lerp phase, colors and body ownership, and any thrown
  error inside the swap could leave the local snake seated on a remote's body.
- **Collision felt wrong.** Death was detected after the head had already entered the
  remote's cell, so the local snake visibly passed through before dying.

The replacement draws remotes with the mosaic snake renderer into the native canvas
context and stamps their cells into the native wall collision grid (`game.Ca.wa`),
which gives real native wall behaviour without a visible wall.
