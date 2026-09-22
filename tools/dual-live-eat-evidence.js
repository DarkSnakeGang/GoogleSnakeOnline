"use strict";

/**
 * Pure checks for headed dual-live fruit eat evidence (also unit-tested).
 */
function fruitFingerprintFromSnap(snap) {
  if (!snap || !snap.fruitPos) return snap && snap.fruitFp ? snap.fruitFp : "";
  return snap.fruitPos
    .map(function (a) {
      if (!a) return "?";
      return (a.x | 0) + "," + (a.y | 0);
    })
    .sort()
    .join("|");
}

function detectEatEffect(modeId, before, after) {
  if (!before || !after) return null;
  const id = String(modeId || "").toLowerCase();
  const sh0 = before.Sh | 0;
  const sh1 = after.Sh | 0;
  if (sh1 > sh0) return { kind: "Sh", delta: sh1 - sh0 };

  const len0 = before.snakeLen | 0;
  const len1 = after.snakeLen | 0;
  if (len1 > len0) return { kind: "snakeLen", delta: len1 - len0 };

  const t0 = before.coopTotal | 0;
  const t1 = after.coopTotal | 0;
  if (t1 > t0) return { kind: "coopTotal", delta: t1 - t0 };

  const s0 = before.localScore | 0;
  const s1 = after.localScore | 0;
  if (s1 > s0) return { kind: "localScore", delta: s1 - s0 };

  const fp0 = before.fruitFp || fruitFingerprintFromSnap(before);
  const fp1 = after.fruitFp || fruitFingerprintFromSnap(after);
  const fl0 = before.fruitLen | 0;
  const fl1 = after.fruitLen | 0;
  if (fl0 > 0 && fp1 && fp0 && fp1 !== fp0 && fl1 > 0) {
    return { kind: "fruitRespawn" };
  }

  if (id === "wall") {
    const w0 = before.wallCount | 0;
    const w1 = after.wallCount | 0;
    const c0 = (before.wallCoords && before.wallCoords.length) || 0;
    const c1 = (after.wallCoords && after.wallCoords.length) || 0;
    if (w1 > w0 || c1 > c0) return { kind: "wallPlant" };
    if ((after.aaSize | 0) > (before.aaSize | 0)) return { kind: "aaSize" };
  }

  if (id === "bomb" && fl1 >= 24 && fl0 <= 1) return { kind: "bombBurst" };
  if (id === "dice" && fl0 > 0 && fl1 >= 1 && fl1 <= 6 && fl1 !== fl0) {
    return { kind: "diceRoll" };
  }

  return null;
}

function assertModeEatEvidence(modeId, baseline, afterA, evidence) {
  const id = String(modeId || "").toLowerCase();
  evidence = evidence || {};

  if (id === "key" || id === "sokoban") {
    if (!evidence.unlock || !evidence.unlock.fruitSpawned) {
      throw new Error(
        id + " unlock failed — fruit never spawned: " + JSON.stringify(evidence.unlock)
      );
    }
  }

  const hit =
    evidence.eatEffect ||
    (evidence.eatBreak &&
      detectEatEffect(id, baseline, evidence.eatBreak)) ||
    detectEatEffect(id, baseline, afterA);

  if (!hit) {
    throw new Error(
      "expected fruit eat evidence for " +
        id +
        " baseline=" +
        JSON.stringify({
          Sh: baseline && baseline.Sh,
          snakeLen: baseline && baseline.snakeLen,
          fruitLen: baseline && baseline.fruitLen,
        }) +
        " after=" +
        JSON.stringify({
          Sh: afterA && afterA.Sh,
          snakeLen: afterA && afterA.snakeLen,
          fruitLen: afterA && afterA.fruitLen,
        })
    );
  }
  return hit;
}

module.exports = {
  detectEatEffect,
  assertModeEatEvidence,
  fruitFingerprintFromSnap,
};
