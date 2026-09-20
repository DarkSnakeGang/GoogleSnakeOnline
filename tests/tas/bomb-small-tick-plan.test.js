"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildBombSmallTickPlan,
  renderTickAscii,
  renderPlanMarkdown,
  findHamCycle,
  cellsToCycleDirs,
  GOAL,
  BOMB_PACK,
  MAX_TICKS,
} = require("./bomb-small-tick-plan.js");

const OPP = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };

test("default plan finishes within 60 ticks at goal 84", function () {
  const plan = buildBombSmallTickPlan({});
  assert.ok(plan.ticks.length <= MAX_TICKS, "ticks=" + plan.ticks.length);
  assert.equal(plan.goal, GOAL);
  assert.equal(plan.ticks[plan.ticks.length - 1].total, GOAL);
  assert.equal(plan.ticks[plan.ticks.length - 1].note, "win");
});

test("t0 geometry matches Small Bomb spawn template", function () {
  const plan = buildBombSmallTickPlan({});
  const t0 = plan.ticks[0];
  assert.equal(t0.note, "boot");
  assert.equal(t0.headA.x, 5);
  assert.equal(t0.headA.y, 3);
  assert.equal(t0.headB.x, 5);
  assert.equal(t0.headB.y, 5);
  assert.equal(t0.faceA, "RIGHT");
  assert.equal(t0.faceB, "RIGHT");
  assert.equal(t0.apples.length, 1);
  assert.equal(t0.apples[0].x, 7);
  assert.equal(t0.apples[0].y, 4);
  assert.equal(t0.total, 0);
});

test("approach reaches first apple then bomb24 has exactly 24 apples", function () {
  const plan = buildBombSmallTickPlan({});
  const bomb = plan.ticks.find(function (t) {
    return t.note === "bomb24-place";
  });
  assert.ok(bomb, "missing bomb24-place tick");
  assert.equal(bomb.apples.length, BOMB_PACK);
  assert.equal(bomb.total, 1);
  assert.ok(bomb.eats.length >= 1);
  assert.ok(
    bomb.headA.x === 7 && bomb.headA.y === 4 ||
      bomb.headB.x === 7 && bomb.headB.y === 4,
    "eater head on (7,4)"
  );
});

test("after bomb24 fruit never exceeds 24", function () {
  const plan = buildBombSmallTickPlan({});
  let seenBomb = false;
  for (let i = 0; i < plan.ticks.length; i++) {
    const t = plan.ticks[i];
    if (t.note === "bomb24-place") seenBomb = true;
    if (seenBomb) {
      assert.ok(
        t.apples.length <= BOMB_PACK,
        "t=" + t.t + " apples=" + t.apples.length
      );
    }
  }
  assert.ok(seenBomb);
});

test("no consecutive opposite dirs for either snake", function () {
  const plan = buildBombSmallTickPlan({});
  let prevA = null;
  let prevB = null;
  for (let i = 0; i < plan.ticks.length; i++) {
    const t = plan.ticks[i];
    if (t.dirA && prevA) {
      assert.notEqual(t.dirA, OPP[prevA], "A 180 at t=" + t.t);
    }
    if (t.dirB && prevB) {
      assert.notEqual(t.dirB, OPP[prevB], "B 180 at t=" + t.t);
    }
    if (t.dirA) prevA = t.dirA;
    if (t.dirB) prevB = t.dirB;
  }
});

test("cover apples lie on the union of both cycles", function () {
  const plan = buildBombSmallTickPlan({});
  const onCycle = Object.create(null);
  (plan.pathA || []).forEach(function (c) {
    onCycle[c.x + "," + c.y] = true;
  });
  (plan.pathB || []).forEach(function (c) {
    onCycle[c.x + "," + c.y] = true;
  });
  let afterBomb = false;
  for (let i = 0; i < plan.ticks.length; i++) {
    const t = plan.ticks[i];
    if (t.note === "bomb24-place") afterBomb = true;
    if (!afterBomb || t.note === "win") continue;
    (t.apples || []).forEach(function (a) {
      assert.ok(
        onCycle[a.x + "," + a.y],
        "apple off cycle " + a.x + "," + a.y + " at t=" + t.t
      );
    });
  }
});

test("ham cycles 4x9 and 6x9 are closed", function () {
  const left = findHamCycle(0, 4, 9);
  const right = findHamCycle(4, 6, 9);
  assert.equal(left.length, 36);
  assert.equal(right.length, 54);
  const dL = cellsToCycleDirs(left);
  const dR = cellsToCycleDirs(right);
  assert.equal(dL.length, 36);
  assert.equal(dR.length, 54);
});

test("ASCII renderer smoke", function () {
  const plan = buildBombSmallTickPlan({});
  const ascii = renderTickAscii(plan.ticks[0]);
  assert.match(ascii, /t=0/);
  assert.match(ascii, /A/);
  assert.match(ascii, /B/);
  assert.match(ascii, /@/);
  const md = renderPlanMarkdown(plan);
  assert.match(md, /# Bomb Small tick plan/);
  assert.ok(md.length > 100);
});
