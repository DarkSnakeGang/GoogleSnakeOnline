"use strict";

/**
 * Shared eat-evidence expectations for co-op modes (Wall → Bridge).
 * Used by unit simulations and headed dual-live dumps.
 */

const MODES = [
  { id: "wall", trophy: 1, needsWallOnEat: true },
  { id: "portal", trophy: 2, needsWallOnEat: false },
  { id: "cheese", trophy: 3, needsWallOnEat: false },
  { id: "borderless", trophy: 4, needsWallOnEat: false },
  { id: "twin", trophy: 5, needsWallOnEat: false },
  { id: "winged", trophy: 6, needsWallOnEat: false, fruitMotion: true },
  { id: "yin_yang", trophy: 7, needsWallOnEat: false },
  { id: "key", trophy: 8, unlockFirst: true },
  { id: "sokoban", trophy: 9, unlockFirst: true },
  { id: "poison", trophy: 10, needsWallOnEat: false },
  { id: "dimension", trophy: 11, needsWallOnEat: false },
  { id: "minesweeper", trophy: 12, needsWallOnEat: false },
  { id: "statue", trophy: 13, needsWallOnEat: false },
  { id: "light", trophy: 14, needsWallOnEat: false },
  { id: "shield", trophy: 15, needsWallOnEat: false },
  { id: "arrow", trophy: 16, needsWallOnEat: false },
  { id: "hotdog", trophy: 17, needsWallOnEat: true },
  { id: "magnet", trophy: 18, needsWallOnEat: false, fruitMotion: true },
  { id: "gate", trophy: 19, needsWallOnEat: false },
  { id: "bridge", trophy: 20, needsWallOnEat: false },
];

function modeById(id) {
  for (let i = 0; i < MODES.length; i++) {
    if (MODES[i].id === id) return MODES[i];
  }
  return null;
}

/** Snapshot fields comparable across live page.evaluate and unit tests. */
function boardEatSnapshot(g, Gsm) {
  if (!g) return null;
  let walls = [];
  try {
    walls = Gsm && Gsm.scrapeWalls ? Gsm.scrapeWalls(g) : [];
  } catch (eW) {
    walls = [];
  }
  const ka = g.wa && g.wa.ka;
  let apple = null;
  if (ka && ka[0]) {
    const p = ka[0].pos || ka[0];
    if (p && p.x != null) apple = { x: p.x | 0, y: p.y | 0 };
  }
  const keys = (g.Ba && g.Ba.keys) || [];
  const boxes = (g.Aa && g.Aa.oa) || [];
  const goals = (g.Aa && (g.Aa.d_ || g.Aa.da)) || [];
  return {
    Sh: g.Sh != null ? g.Sh | 0 : 0,
    bodyLen: g.oa && g.oa.ka ? g.oa.ka.length : 0,
    fruitLen: ka ? ka.length : 0,
    apple: apple,
    wallCount: walls.length,
    aaSize:
      g.Ca && g.Ca.Aa && typeof g.Ca.Aa.size === "number" ? g.Ca.Aa.size : null,
    keyCount: Array.isArray(keys) ? keys.length : keys.size || 0,
    boxCount: Array.isArray(boxes) ? boxes.length : boxes.size || 0,
    goalCount: Array.isArray(goals) ? goals.length : goals.size || 0,
    nj: !!g.nj,
  };
}

/**
 * True when hunt loop should stop — we have evidence of a consumed apple tick.
 * Dead boards (nj) are never generic eat proof, but wall plant after an eat counts
 * even if the snake dies on the same tick.
 */
function detectEatBreak(baseline, snap, modeId) {
  if (!baseline || !snap) return false;
  const mode = modeById(modeId);
  const wallGrew =
    (snap.wallCount | 0) > (baseline.wallCount | 0) ||
    (snap.aaSize != null &&
      baseline.aaSize != null &&
      (snap.aaSize | 0) > (baseline.aaSize | 0)) ||
    ((snap.wallCoords && snap.wallCoords.length) || 0) >
      ((baseline.wallCoords && baseline.wallCoords.length) || 0);
  if (wallGrew) return true;
  if (snap.nj) return false;
  if (mode && mode.needsWallOnEat) {
    return false;
  }
  if ((snap.Sh | 0) > (baseline.Sh | 0)) return true;
  if (
    (baseline.bodyLen | 0) > 0 &&
    (snap.bodyLen | 0) > (baseline.bodyLen | 0)
  ) {
    return true;
  }
  // Fruit consumed while alive: head reached the old apple cell.
  if (
    baseline.apple &&
    snap.head &&
    (baseline.apple.x | 0) === (snap.head.x | 0) &&
    (baseline.apple.y | 0) === (snap.head.y | 0) &&
    !snap.apple
  ) {
    return true;
  }
  if (
    (baseline.fruitLen | 0) > 0 &&
    (snap.fruitLen | 0) < (baseline.fruitLen | 0) &&
    (snap.Sh | 0) > (baseline.Sh | 0)
  ) {
    return true;
  }
  return false;
}

/**
 * Validate post-hunt evidence object (live or unit).
 */
function assertEatEvidence(modeId, evidence, assert) {
  const mode = modeById(modeId);
  if (!mode) {
    assert.fail("unknown mode " + modeId);
    return;
  }
  const base = evidence.baseline;
  const after = evidence.after || evidence.afterA;
  const ate = evidence.ate || evidence.eatBreak;
  assert.ok(base, modeId + ": missing baseline");
  assert.ok(after, modeId + ": missing after snapshot");

  assert.ok(
    ate || evidence.ateProof,
    modeId +
      ": no eat proof (Sh/fruit/body/wall) — baseline=" +
      JSON.stringify(base) +
      " after=" +
      JSON.stringify(after)
  );

  if (mode.unlockFirst && (base.fruitLen | 0) === 0) {
    assert.ok(
      evidence.unlocked && (evidence.unlocked.fruitAfter | 0) >= 1,
      modeId + ": fruit must exist after unlock — " + JSON.stringify(evidence.unlocked)
    );
  }

  if (mode.needsWallOnEat) {
    const wallAfter = after.wallCount | 0;
    const coordsAfter =
      (after.wallCoords && after.wallCoords.length) ||
      (evidence.eatBreak &&
        evidence.eatBreak.wallCoords &&
        evidence.eatBreak.wallCoords.length) ||
      0;
    const wallGrow =
      wallAfter > (base.wallCount | 0) ||
      (after.aaSize | 0) > (base.aaSize | 0) ||
      coordsAfter > ((base.wallCoords && base.wallCoords.length) || 0) ||
      evidence.wallPlanted === true;
    assert.ok(
      wallGrow,
      modeId +
        ": expected wall grow after eat, walls " +
        base.wallCount +
        "→" +
        wallAfter +
        " coords=" +
        coordsAfter
    );
  }

  if (evidence.publishedCount != null) {
    assert.ok(
      evidence.publishedCount >= 1,
      modeId + ": collectables publish after eat"
    );
  }

  if (evidence.pageErrors && evidence.pageErrors.length) {
    const bad = evidence.pageErrors.some(function (e) {
      return /Cannot read properties of null|Aa\.add is not a function|a\.has is not a function/i.test(
        String(e)
      );
    });
    assert.ok(!bad, modeId + ": pageerrors " + evidence.pageErrors.join(" | "));
  }
}

module.exports = {
  MODES: MODES,
  modeById: modeById,
  boardEatSnapshot: boardEatSnapshot,
  detectEatBreak: detectEatBreak,
  assertEatEvidence: assertEatEvidence,
};
