"use strict";

/**
 * Co-op fruit spawn: valid pool + single roll (counts 0–6 rules).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadNative(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/native.js"));
  delete require.cache[p];
  require(path.join(ROOT, "src/coop/native.js"));
  return win;
}

function makeGame(W, H, bodies) {
  const wa = [];
  for (let y = 0; y < H; y++) {
    wa[y] = [];
    for (let x = 0; x < W; x++) wa[y][x] = 0;
  }
  return {
    oa: {
      ka: (bodies && bodies.local) || [
        { x: 5, y: 4 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      oa: { width: W, height: H },
    },
    Ca: { Aa: new Map(), wa: wa },
    wa: { ka: [], oa: { oa: { width: W, height: H } } },
  };
}

describe("coop fruit spawn pool", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopRemotes = {};
    win.__mpCoopPlaySettings = { count: 0 };
    loadNative(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("excludes remote body cells from the pool", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopRemotes = {
      peer: {
        alive: true,
        body: [
          { x: 1, y: 1 },
          { x: 1, y: 2 },
          { x: 1, y: 3 },
        ],
      },
    };
    const pool = win.__mpCoopBuildFruitSpawnPool(g);
    const keys = pool.map(function (p) {
      return p.x + "," + p.y;
    });
    assert.ok(!keys.includes("1,1"));
    assert.ok(!keys.includes("1,2"));
    assert.ok(!keys.includes("5,4"), "local head excluded");
    assert.ok(keys.includes("0,0"));
    assert.ok(pool.length > 0);
  });

  it("Tally excludes manhattan ≤3 of every head", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopPlaySettings = { count: 6 };
    win.__mpCoopRemotes = {
      peer: { alive: true, body: [{ x: 8, y: 8 }] },
    };
    const pool = win.__mpCoopBuildFruitSpawnPool(g, { tally: true });
    const keys = new Set(
      pool.map(function (p) {
        return p.x + "," + p.y;
      })
    );
    // Local head (5,4): (5,4) itself and (5,5) within ≤3
    assert.ok(!keys.has("5,4"));
    assert.ok(!keys.has("5,5"));
    assert.ok(!keys.has("8,8"));
    assert.ok(!keys.has("8,7"));
    // Far corner should remain
    assert.ok(keys.has("0,0"));
  });

  it("empty pool returns null once from pick", () => {
    const g = makeGame(3, 3, {
      local: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 0, y: 2 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ],
    });
    win.__mpGame = g;
    win.__remixGame = g;
    const pool = win.__mpCoopBuildFruitSpawnPool(g);
    assert.equal(pool.length, 0);
    assert.equal(win.__mpCoopPickFruitSpawn(pool), null);
  });

  it("wrapFreePos fruit path rolls from pool without calling native Rb", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    let nativeCalls = 0;
    g.Rb = function () {
      nativeCalls++;
      return { x: 5, y: 4 }; // on local head — illegal
    };
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    const p = g.Rb(null, 0);
    assert.ok(p);
    assert.notEqual(p.x + "," + p.y, "5,4");
    assert.equal(nativeCalls, 0, "pool path must not call native freePos");
    assert.equal(
      typeof p.clone,
      "function",
      "freePos must return cloneable Od-like point for L3E.render"
    );
    const c = p.clone();
    assert.equal(c.x, p.x);
    assert.equal(c.y, p.y);
  });

  it("wrapFreePos empty pool returns null and signals board full only when packed", () => {
    const g = makeGame(2, 2, {
      local: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    });
    win.__mpGame = g;
    win.__remixGame = g;
    let full = 0;
    win.__mpCoopOnBoardFull = function () {
      full++;
    };
    g.Rb = function () {
      return { x: 0, y: 0 };
    };
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    assert.equal(g.Rb(null, 0), null);
    assert.ok(full >= 1, "packed board may ALL_APPLES");
    assert.equal(win.__mpCoopBoardFull, true);
  });

  it("wrapFreePos empty filtered pool does not ALL_APPLES when free cells remain", () => {
    // Tally count=6 excludes near-head cells; small board can empty the pool
    // while free cells still exist away from heads — must not win.
    const g = makeGame(6, 6, {
      local: [
        { x: 2, y: 2 },
        { x: 2, y: 3 },
        { x: 2, y: 4 },
      ],
    });
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopPlaySettings = { count: 6 };
    win.__mpCoopRemotes = {
      peer: {
        alive: true,
        body: [
          { x: 3, y: 2 },
          { x: 3, y: 3 },
          { x: 3, y: 4 },
        ],
      },
    };
    let full = 0;
    win.__mpCoopOnBoardFull = function () {
      full++;
    };
    g.Rb = function () {
      return { x: 0, y: 0 };
    };
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    const pool = win.__mpCoopBuildFruitSpawnPool(g);
    // If pool is empty but findFree still sees space, freePos must not win.
    const free = win.__mpCoopFindFreeSpawn(
      g,
      win.__mpCoopReadSpawnOccupancy(g, true)
    );
    if (!pool.length && free) {
      assert.equal(g.Rb(null, 0), null);
      assert.equal(full, 0, "filtered-empty pool must not ALL_APPLES");
      assert.equal(win.__mpCoopBoardFull, false);
    } else {
      // Board too open or packed differently — still must not false-win when free exists
      g.Rb(null, 0);
      if (free) {
        assert.equal(full, 0, "free cell remaining must not ALL_APPLES");
      }
    }
  });

  it("count indices 0–6 select tally radius only for 6", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    for (let c = 0; c <= 5; c++) {
      win.__mpCoopPlaySettings = { count: c };
      const pool = win.__mpCoopBuildFruitSpawnPool(g);
      // Without tally, cells adjacent to head at (5,4) like (6,4) are allowed
      const hasNear = pool.some(function (p) {
        return p.x === 6 && p.y === 4;
      });
      assert.ok(hasNear, "count " + c + " should allow near-head cell");
    }
    win.__mpCoopPlaySettings = { count: 6 };
    const tallyPool = win.__mpCoopBuildFruitSpawnPool(g);
    assert.ok(
      !tallyPool.some(function (p) {
        return p.x === 6 && p.y === 4;
      }),
      "Tally must exclude near-head"
    );
  });
});
