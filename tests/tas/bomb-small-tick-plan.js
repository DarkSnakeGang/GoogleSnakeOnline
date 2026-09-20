"use strict";

/**
 * Offline tick-perfect plan for Small 10×9 Bomb 2P TAS.
 * Vanilla Bomb fruit cardinality (1 → ≤24). Dual even-width Hamiltonian
 * bands (4×9 + 6×9); apples always staged on upcoming path cells.
 */

const W = 10;
const H = 9;
const GOAL = 84; // 10*9 - 3*2
const BOMB_PACK = 24;
const MAX_TICKS = 60;
const OPP = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };

function cellKey(p) {
  return (p.x | 0) + "," + (p.y | 0);
}

function step(pos, dir) {
  const x = pos.x | 0;
  const y = pos.y | 0;
  if (dir === "LEFT") return { x: x - 1, y: y };
  if (dir === "RIGHT") return { x: x + 1, y: y };
  if (dir === "UP") return { x: x, y: y - 1 };
  if (dir === "DOWN") return { x: x, y: y + 1 };
  return { x: x, y: y };
}

function findHamCycle(x0, w, h) {
  if ((w & 1) !== 0) throw new Error("findHamCycle requires even width, got " + w);
  const x1 = x0 + w - 1;
  const total = w * h;
  const key = cellKey;
  function neighbors(p) {
    const out = [];
    const deltas = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ];
    for (let i = 0; i < 4; i++) {
      const q = { x: (p.x | 0) + deltas[i][0], y: (p.y | 0) + deltas[i][1] };
      if (q.x >= x0 && q.x <= x1 && q.y >= 0 && q.y < h) out.push(q);
    }
    return out;
  }
  const path = [];
  const used = Object.create(null);
  function freeDeg(p) {
    let c = 0;
    const n = neighbors(p);
    for (let i = 0; i < n.length; i++) if (!used[key(n[i])]) c++;
    return c;
  }
  function dfs(cur) {
    path.push(cur);
    used[key(cur)] = true;
    if (path.length === total) {
      const closes = neighbors(cur).some(function (q) {
        return q.x === path[0].x && q.y === path[0].y;
      });
      if (!closes) {
        path.pop();
        delete used[key(cur)];
        return false;
      }
      return true;
    }
    const opts = neighbors(cur).filter(function (q) {
      return !used[key(q)];
    });
    opts.sort(function (a, b) {
      return freeDeg(a) - freeDeg(b) || a.x - b.x || a.y - b.y;
    });
    for (let i = 0; i < opts.length; i++) {
      if (dfs(opts[i])) return true;
    }
    path.pop();
    delete used[key(cur)];
    return false;
  }
  const starts = [
    { x: x0, y: 0 },
    { x: x0, y: 1 },
    { x: x0 + 1, y: 0 },
  ];
  for (let s = 0; s < starts.length; s++) {
    path.length = 0;
    Object.keys(used).forEach(function (k) {
      delete used[k];
    });
    if (dfs(starts[s])) {
      return path.map(function (p) {
        return { x: p.x | 0, y: p.y | 0 };
      });
    }
  }
  throw new Error("no ham cycle for " + w + "x" + h + " at x0=" + x0);
}

function cellsToCycleDirs(cells) {
  const dirs = [];
  for (let i = 0; i < cells.length; i++) {
    const a = cells[i];
    const b = cells[(i + 1) % cells.length];
    const dx = (b.x | 0) - (a.x | 0);
    const dy = (b.y | 0) - (a.y | 0);
    if (dx === 1 && dy === 0) dirs.push("RIGHT");
    else if (dx === -1 && dy === 0) dirs.push("LEFT");
    else if (dx === 0 && dy === 1) dirs.push("DOWN");
    else if (dx === 0 && dy === -1) dirs.push("UP");
    else throw new Error("cycle gap " + cellKey(a) + "→" + cellKey(b));
  }
  return dirs;
}

function rotatePathNear(path, from) {
  if (!path || !path.length || !from) return path || [];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d =
      Math.abs((path[i].x | 0) - (from.x | 0)) +
      Math.abs((path[i].y | 0) - (from.y | 0));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return path.slice(best).concat(path.slice(0, best));
}

function nearestPathIndex(path, head) {
  if (!path || !path.length || !head) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d =
      Math.abs((path[i].x | 0) - (head.x | 0)) +
      Math.abs((path[i].y | 0) - (head.y | 0));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

let _leftCycle = null;
let _rightCycle = null;
function leftCycle() {
  if (!_leftCycle) _leftCycle = findHamCycle(0, 4, 9);
  return _leftCycle;
}
function rightCycle() {
  if (!_rightCycle) _rightCycle = findHamCycle(4, 6, 9);
  return _rightCycle;
}

function assignBands(headA, headB) {
  const left = leftCycle();
  const right = rightCycle();
  const ax = (headA && headA.x) | 0;
  const bx = (headB && headB.x) | 0;
  const aOnLeft = ax <= 3;
  const bOnLeft = bx <= 3;
  let pathA;
  let pathB;
  let aBand;
  let bBand;
  if ((aOnLeft && !bOnLeft) || (aOnLeft && bOnLeft)) {
    pathA = rotatePathNear(left, headA);
    pathB = rotatePathNear(right, headB);
    aBand = "left";
    bBand = "right";
  } else {
    pathA = rotatePathNear(right, headA);
    pathB = rotatePathNear(left, headB);
    aBand = "right";
    bBand = "left";
  }
  return {
    pathA: pathA,
    pathB: pathB,
    dirsA: cellsToCycleDirs(pathA),
    dirsB: cellsToCycleDirs(pathB),
    idxA: nearestPathIndex(pathA, headA),
    idxB: nearestPathIndex(pathB, headB),
    aBand: aBand,
    bBand: bBand,
    capA: pathA.length,
    capB: pathB.length,
  };
}

function dirsBetween(from, to, maxSteps) {
  maxSteps = maxSteps != null ? maxSteps : 20;
  if (!from || !to) return [];
  let x = from.x | 0;
  let y = from.y | 0;
  const tx = to.x | 0;
  const ty = to.y | 0;
  const dirs = [];
  for (let i = 0; i < maxSteps && (x !== tx || y !== ty); i++) {
    if (x < tx) {
      dirs.push("RIGHT");
      x++;
    } else if (x > tx) {
      dirs.push("LEFT");
      x--;
    } else if (y < ty) {
      dirs.push("DOWN");
      y++;
    } else if (y > ty) {
      dirs.push("UP");
      y--;
    }
  }
  return dirs;
}

function safeStepToward(from, to, facing) {
  if (!from || !to) return null;
  const fx = from.x | 0;
  const fy = from.y | 0;
  const tx = to.x | 0;
  const ty = to.y | 0;
  if (fx === tx && fy === ty) return null;
  const face = String(facing || "RIGHT").toUpperCase();
  const candidates = [];
  if (fx < tx) candidates.push("RIGHT");
  if (fx > tx) candidates.push("LEFT");
  if (fy < ty) candidates.push("DOWN");
  if (fy > ty) candidates.push("UP");
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] !== OPP[face]) return candidates[i];
  }
  if (face === "LEFT" || face === "RIGHT") return fy <= ty ? "DOWN" : "UP";
  return fx <= tx ? "RIGHT" : "LEFT";
}

function spawnBody(head, dir, len) {
  len = len != null ? len : 3;
  const body = [{ x: head.x | 0, y: head.y | 0 }];
  const back = OPP[dir] || "LEFT";
  for (let i = 1; i < len; i++) body.push(step(body[i - 1], back));
  return body;
}

function advanceBody(body, nextHead, grew) {
  const next = [{ x: nextHead.x | 0, y: nextHead.y | 0 }];
  const keep = grew ? body.length : Math.max(0, body.length - 1);
  for (let i = 0; i < keep; i++) next.push({ x: body[i].x | 0, y: body[i].y | 0 });
  return next;
}

function occupiedKeys(bodyA, bodyB) {
  const keys = Object.create(null);
  (bodyA || []).forEach(function (p) {
    if (p) keys[cellKey(p)] = true;
  });
  (bodyB || []).forEach(function (p) {
    if (p) keys[cellKey(p)] = true;
  });
  return keys;
}

function upcomingCells(path, idx, n, blocked) {
  const out = [];
  const seen = Object.create(null);
  if (!path || !path.length) return out;
  for (let k = 1; k <= path.length && out.length < n; k++) {
    const c = path[(idx + k) % path.length];
    const key = cellKey(c);
    if (seen[key]) continue;
    seen[key] = true;
    if (blocked && blocked[key]) continue;
    out.push({ x: c.x | 0, y: c.y | 0 });
  }
  return out;
}

/**
 * Place ≤24 apples. Always include next cell for snakes that can still grow.
 */
function placeApplesForNeed(pathA, idxA, pathB, idxB, bodyA, bodyB, need, growA, growB) {
  const n = Math.max(0, Math.min(BOMB_PACK, need | 0));
  if (n === 0) return [];
  const blocked = occupiedKeys(bodyA, bodyB);
  const out = [];
  const seen = Object.create(null);
  function push(c) {
    if (!c || out.length >= n) return;
    const k = cellKey(c);
    if (seen[k] || blocked[k]) return;
    seen[k] = true;
    out.push({ x: c.x | 0, y: c.y | 0 });
  }
  if (growA && pathA && pathA.length) push(pathA[(idxA + 1) % pathA.length]);
  if (growB && pathB && pathB.length) push(pathB[(idxB + 1) % pathB.length]);
  upcomingCells(pathA, idxA, n, blocked).forEach(push);
  upcomingCells(pathB, idxB, n, blocked).forEach(push);
  return out;
}

function planPartnerHoldDirs(head, face, tickCount, bandMaxX, bandMinX) {
  const dirs = [];
  let x = head.x | 0;
  let y = head.y | 0;
  let facing = String(face || "RIGHT").toUpperCase();
  let goingUp = y > 0;
  const xLo = bandMinX != null ? bandMinX : 0;
  const xHi = bandMaxX != null ? bandMaxX : 3;
  for (let i = 0; i < tickCount; i++) {
    let dir;
    if (goingUp) {
      if (y > 0 && OPP[facing] !== "UP") {
        dir = "UP";
        y--;
      } else {
        goingUp = false;
        if (x > xLo && OPP[facing] !== "LEFT") {
          dir = "LEFT";
          x--;
        } else if (OPP[facing] !== "DOWN") {
          dir = "DOWN";
          y++;
        } else {
          dir = "RIGHT";
          x = Math.min(xHi, x + 1);
        }
      }
    } else if (y < H - 1 && OPP[facing] !== "DOWN") {
      dir = "DOWN";
      y++;
    } else {
      goingUp = true;
      if (x < xHi && OPP[facing] !== "RIGHT") {
        dir = "RIGHT";
        x++;
      } else if (OPP[facing] !== "UP") {
        dir = "UP";
        y = Math.max(0, y - 1);
      } else {
        dir = "LEFT";
        x = Math.max(xLo, x - 1);
      }
    }
    dirs.push(dir);
    facing = dir;
  }
  return dirs;
}

function applyDirFacing(face, dir) {
  const d = String(dir || "").toUpperCase();
  if (!d || d === "NONE") return face;
  if (OPP[face] === d) return face;
  return d;
}

function cloneApples(list) {
  return (list || []).map(function (a) {
    return { x: a.x | 0, y: a.y | 0 };
  });
}

function appleSet(list) {
  const s = Object.create(null);
  (list || []).forEach(function (a) {
    s[cellKey(a)] = true;
  });
  return s;
}

function dirBetweenCells(a, b) {
  const dx = (b.x | 0) - (a.x | 0);
  const dy = (b.y | 0) - (a.y | 0);
  if (dx === 1 && dy === 0) return "RIGHT";
  if (dx === -1 && dy === 0) return "LEFT";
  if (dx === 0 && dy === 1) return "DOWN";
  if (dx === 0 && dy === -1) return "UP";
  return null;
}

function buildBombSmallTickPlan(opts) {
  opts = opts || {};
  const goal = opts.goal != null ? opts.goal | 0 : GOAL;
  let headA = {
    x: (opts.headA && opts.headA.x) != null ? opts.headA.x | 0 : 5,
    y: (opts.headA && opts.headA.y) != null ? opts.headA.y | 0 : 3,
  };
  let headB = {
    x: (opts.headB && opts.headB.x) != null ? opts.headB.x | 0 : 5,
    y: (opts.headB && opts.headB.y) != null ? opts.headB.y | 0 : 5,
  };
  let faceA = String(opts.faceA || "RIGHT").toUpperCase();
  let faceB = String(opts.faceB || "RIGHT").toUpperCase();
  const apple0 = {
    x: (opts.apple0 && opts.apple0.x) != null ? opts.apple0.x | 0 : 7,
    y: (opts.apple0 && opts.apple0.y) != null ? opts.apple0.y | 0 : 4,
  };

  let bodyA = spawnBody(headA, faceA, 3);
  let bodyB = spawnBody(headB, faceB, 3);
  let apples = [apple0];
  let total = 0;
  const ticks = [];

  function snapshot(extra) {
    ticks.push(
      Object.assign(
        {
          t: ticks.length,
          dirA: null,
          dirB: null,
          faceA: faceA,
          faceB: faceB,
          headA: { x: headA.x, y: headA.y },
          headB: { x: headB.x, y: headB.y },
          bodyA: bodyA.map(function (p) {
            return { x: p.x, y: p.y };
          }),
          bodyB: bodyB.map(function (p) {
            return { x: p.x, y: p.y };
          }),
          apples: cloneApples(apples),
          eats: [],
          total: total,
          placeApples: false,
          note: "",
        },
        extra || {}
      )
    );
  }

  snapshot({ note: "boot" });

  const distA = Math.abs(headA.x - apple0.x) + Math.abs(headA.y - apple0.y);
  const distB = Math.abs(headB.x - apple0.x) + Math.abs(headB.y - apple0.y);
  const eaterIsA = distA <= distB;
  const eaterHead = eaterIsA ? headA : headB;
  const partnerHead = eaterIsA ? headB : headA;
  const partnerFace = eaterIsA ? faceB : faceA;

  let approachDirs = dirsBetween(eaterHead, apple0, 24);
  const land = approachDirs.reduce(function (p, d) {
    return step(p, d);
  }, { x: eaterHead.x, y: eaterHead.y });
  if (land.x !== apple0.x || land.y !== apple0.y) {
    approachDirs = approachDirs.concat(dirsBetween(land, apple0, 4));
  }
  const holdDirs = planPartnerHoldDirs(partnerHead, partnerFace, approachDirs.length, 3, 0);

  for (let i = 0; i < approachDirs.length; i++) {
    const dirE = approachDirs[i];
    const dirP = holdDirs[i] || partnerFace;
    const dirA = eaterIsA ? dirE : dirP;
    const dirB = eaterIsA ? dirP : dirE;

    faceA = applyDirFacing(faceA, dirA);
    faceB = applyDirFacing(faceB, dirB);
    const nextA = step(headA, faceA);
    const nextB = step(headB, faceB);

    const beforeApples = appleSet(apples);
    const eats = [];
    let grewA = false;
    let grewB = false;
    if (beforeApples[cellKey(nextA)]) {
      eats.push("A");
      grewA = true;
      total++;
    }
    if (beforeApples[cellKey(nextB)]) {
      eats.push("B");
      grewB = true;
      total++;
    }

    headA = nextA;
    headB = nextB;
    bodyA = advanceBody(bodyA, headA, grewA);
    bodyB = advanceBody(bodyB, headB, grewB);

    if (!eats.length) {
      snapshot({
        dirA: dirA,
        dirB: dirB,
        eats: eats,
        total: total,
        note: "approach",
      });
      continue;
    }

    const bands = assignBands(headA, headB);
    apples = placeApplesForNeed(
      bands.pathA,
      bands.idxA,
      bands.pathB,
      bands.idxB,
      bodyA,
      bodyB,
      Math.min(BOMB_PACK, goal - total),
      bodyA.length < bands.capA,
      bodyB.length < bands.capB
    );
    snapshot({
      dirA: dirA,
      dirB: dirB,
      eats: eats,
      total: total,
      placeApples: true,
      note: "bomb24-place",
      idxA: bands.idxA,
      idxB: bands.idxB,
      aBand: bands.aBand,
      bBand: bands.bBand,
    });

    return finishCover(ticks, {
      headA: headA,
      headB: headB,
      faceA: faceA,
      faceB: faceB,
      bodyA: bodyA,
      bodyB: bodyB,
      apples: apples,
      total: total,
      goal: goal,
      bands: bands,
    });
  }

  throw new Error("approach never reached first apple");
}

function finishCover(ticks, state) {
  let headA = state.headA;
  let headB = state.headB;
  let faceA = state.faceA;
  let faceB = state.faceB;
  let bodyA = state.bodyA;
  let bodyB = state.bodyB;
  let apples = state.apples;
  let total = state.total;
  const goal = state.goal;
  const bands = state.bands;
  const pathA = bands.pathA;
  const pathB = bands.pathB;
  const dirsA = bands.dirsA;
  const dirsB = bands.dirsB;
  const capA = bands.capA;
  const capB = bands.capB;
  let idxA = nearestPathIndex(pathA, headA);
  let idxB = nearestPathIndex(pathB, headB);

  // Enter cycle cells without requesting a 180°.
  while (ticks.length < MAX_TICKS) {
    const onA =
      pathA[idxA] &&
      pathA[idxA].x === headA.x &&
      pathA[idxA].y === headA.y;
    const onB =
      pathB[idxB] &&
      pathB[idxB].x === headB.x &&
      pathB[idxB].y === headB.y;
    if (onA && onB) {
      // Align facing to the cycle edge that arrived here so the next
      // cycle dir is never a 180°.
      const arrA = dirBetweenCells(
        pathA[(idxA - 1 + pathA.length) % pathA.length],
        pathA[idxA]
      );
      const arrB = dirBetweenCells(
        pathB[(idxB - 1 + pathB.length) % pathB.length],
        pathB[idxB]
      );
      if (arrA) faceA = arrA;
      if (arrB) faceB = arrB;
      break;
    }

    idxA = nearestPathIndex(pathA, headA);
    idxB = nearestPathIndex(pathB, headB);
    let dirA = onA
      ? dirsA[idxA]
      : safeStepToward(headA, pathA[idxA], faceA) || faceA;
    let dirB = onB
      ? dirsB[idxB]
      : safeStepToward(headB, pathB[idxB], faceB) || faceB;
    if (OPP[faceA] === dirA) {
      dirA = faceA === "LEFT" || faceA === "RIGHT" ? "DOWN" : "RIGHT";
    }
    if (OPP[faceB] === dirB) {
      dirB = faceB === "LEFT" || faceB === "RIGHT" ? "DOWN" : "LEFT";
    }
    faceA = applyDirFacing(faceA, dirA);
    faceB = applyDirFacing(faceB, dirB);
    headA = step(headA, faceA);
    headB = step(headB, faceB);
    bodyA = advanceBody(bodyA, headA, false);
    bodyB = advanceBody(bodyB, headB, false);
    idxA = nearestPathIndex(pathA, headA);
    idxB = nearestPathIndex(pathB, headB);
    ticks.push({
      t: ticks.length,
      dirA: faceA,
      dirB: faceB,
      faceA: faceA,
      faceB: faceB,
      headA: { x: headA.x, y: headA.y },
      headB: { x: headB.x, y: headB.y },
      bodyA: bodyA.map(function (p) {
        return { x: p.x, y: p.y };
      }),
      bodyB: bodyB.map(function (p) {
        return { x: p.x, y: p.y };
      }),
      apples: cloneApples(apples),
      eats: [],
      total: total,
      placeApples: false,
      note: "enter",
      idxA: idxA,
      idxB: idxB,
    });
  }

  while (total < goal && ticks.length < MAX_TICKS) {
    if (!pathA[idxA] || pathA[idxA].x !== headA.x || pathA[idxA].y !== headA.y) {
      idxA = nearestPathIndex(pathA, headA);
    }
    if (!pathB[idxB] || pathB[idxB].x !== headB.x || pathB[idxB].y !== headB.y) {
      idxB = nearestPathIndex(pathB, headB);
    }

    const nextA = pathA[(idxA + 1) % pathA.length];
    const nextB = pathB[(idxB + 1) % pathB.length];
    const dirA = dirBetweenCells(headA, nextA) || dirsA[idxA];
    const dirB = dirBetweenCells(headB, nextB) || dirsB[idxB];

    const growA = bodyA.length < capA && total < goal;
    const growB = bodyB.length < capB && total < goal;
    const need = Math.max(0, goal - total);
    apples = placeApplesForNeed(
      pathA,
      idxA,
      pathB,
      idxB,
      bodyA,
      bodyB,
      need,
      growA,
      growB
    );

    faceA = applyDirFacing(faceA, dirA);
    faceB = applyDirFacing(faceB, dirB);

    const before = appleSet(apples);
    const eats = [];
    let grewA = false;
    let grewB = false;
    if (growA && before[cellKey(nextA)]) {
      eats.push("A");
      grewA = true;
      total++;
    }
    if (growB && before[cellKey(nextB)]) {
      eats.push("B");
      grewB = true;
      total++;
    }

    headA = { x: nextA.x | 0, y: nextA.y | 0 };
    headB = { x: nextB.x | 0, y: nextB.y | 0 };
    bodyA = advanceBody(bodyA, headA, grewA);
    bodyB = advanceBody(bodyB, headB, grewB);
    idxA = (idxA + 1) % pathA.length;
    idxB = (idxB + 1) % pathB.length;

    let note = eats.length ? "cover-eat" : "cover";
    let placeApples = !!(eats.length || total >= goal);
    if (total >= goal) {
      apples = [];
      note = "win";
      placeApples = true;
    } else if (eats.length) {
      apples = placeApplesForNeed(
        pathA,
        idxA,
        pathB,
        idxB,
        bodyA,
        bodyB,
        goal - total,
        bodyA.length < capA,
        bodyB.length < capB
      );
    }

    ticks.push({
      t: ticks.length,
      dirA: dirA,
      dirB: dirB,
      faceA: faceA,
      faceB: faceB,
      headA: { x: headA.x, y: headA.y },
      headB: { x: headB.x, y: headB.y },
      bodyA: bodyA.map(function (p) {
        return { x: p.x, y: p.y };
      }),
      bodyB: bodyB.map(function (p) {
        return { x: p.x, y: p.y };
      }),
      apples: cloneApples(apples),
      eats: eats,
      total: total,
      placeApples: placeApples,
      note: note,
      idxA: idxA,
      idxB: idxB,
    });
  }

  if (total < goal) {
    throw new Error(
      "plan exhausted " + ticks.length + " ticks with total=" + total + "/" + goal
    );
  }
  if (ticks.length > MAX_TICKS) {
    throw new Error("plan exceeds " + MAX_TICKS + " ticks: " + ticks.length);
  }

  return {
    ticks: ticks,
    goal: goal,
    width: W,
    height: H,
    bombPack: BOMB_PACK,
    maxTicks: MAX_TICKS,
    aBand: bands.aBand,
    bBand: bands.bBand,
    pathA: pathA,
    pathB: pathB,
  };
}

function renderTickAscii(tick, w, h) {
  w = w != null ? w : W;
  h = h != null ? h : H;
  const grid = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) row.push(".");
    grid.push(row);
  }
  function paint(body, headCh, bodyCh) {
    for (let i = (body || []).length - 1; i >= 0; i--) {
      const p = body[i];
      if (!p) continue;
      const x = p.x | 0;
      const y = p.y | 0;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      grid[y][x] = i === 0 ? headCh : bodyCh;
    }
  }
  paint(tick.bodyA, "A", "a");
  paint(tick.bodyB, "B", "b");
  (tick.apples || []).forEach(function (ap) {
    const x = ap.x | 0;
    const y = ap.y | 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    if (grid[y][x] === ".") grid[y][x] = "@";
  });
  const hdr =
    "t=" +
    tick.t +
    " faceA=" +
    tick.faceA +
    " faceB=" +
    tick.faceB +
    (tick.dirA ? " dirA=" + tick.dirA : "") +
    (tick.dirB ? " dirB=" + tick.dirB : "") +
    " apples=" +
    (tick.apples ? tick.apples.length : 0) +
    " total=" +
    tick.total +
    (tick.eats && tick.eats.length ? " eats=" + tick.eats.join("+") : "") +
    (tick.note ? " [" + tick.note + "]" : "");
  const lines = [
    hdr,
    "  " +
      Array.from({ length: w }, function (_, i) {
        return String(i % 10);
      }).join(""),
  ];
  for (let y = 0; y < h; y++) lines.push(String(y) + " " + grid[y].join(""));
  return lines.join("\n");
}

function renderPlanMarkdown(plan) {
  const lines = [
    "# Bomb Small tick plan",
    "",
    "- goal: " + plan.goal,
    "- ticks: " + plan.ticks.length + " (max " + plan.maxTicks + ")",
    "- bands: A=" + plan.aBand + " B=" + plan.bBand,
    "",
  ];
  for (let i = 0; i < plan.ticks.length; i++) {
    lines.push("```");
    lines.push(renderTickAscii(plan.ticks[i], plan.width, plan.height));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = {
  W: W,
  H: H,
  GOAL: GOAL,
  BOMB_PACK: BOMB_PACK,
  MAX_TICKS: MAX_TICKS,
  findHamCycle: findHamCycle,
  cellsToCycleDirs: cellsToCycleDirs,
  buildBombSmallTickPlan: buildBombSmallTickPlan,
  renderTickAscii: renderTickAscii,
  renderPlanMarkdown: renderPlanMarkdown,
  placeApplesForNeed: placeApplesForNeed,
  assignBands: assignBands,
};
