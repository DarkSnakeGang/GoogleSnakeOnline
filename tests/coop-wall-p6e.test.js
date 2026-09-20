"use strict";

/**
 * First-apple wall grow (native p6E → Ca.Aa.add).
 * Reproduces the co-op crash: Aa was null when the eater's tick grew a wall.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  const gsmPath = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[gsmPath];
  require(path.join(ROOT, "src/hooks/gsm.js"));
  return win.MultiplayerGsm;
}

function loadNative(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/native.js"));
  delete require.cache[p];
  require(path.join(ROOT, "src/coop/native.js"));
  return win.CoopNative;
}

/** Minimal native wall grow — same call shape as obfuscated p6E. */
function simulateNativeWallGrowP6E(game, x, y) {
  const wall = {
    pos: { x: x | 0, y: y | 0 },
    wm: false,
    m0: false,
    Lh: true,
  };
  game.Ca.Aa.add(wall);
  if (Array.isArray(game.Ca.wa) && game.Ca.wa[y]) {
    game.Ca.wa[y][x] = 1;
  }
  return wall;
}

function makeWallGame(opts) {
  opts = opts || {};
  const W = opts.width || 17;
  const H = opts.height || 15;
  const wa = [];
  for (let y = 0; y < H; y++) {
    wa[y] = [];
    for (let x = 0; x < W; x++) wa[y][x] = 0;
  }
  return {
    oa: {
      ka: [
        { x: 8, y: 7 },
        { x: 7, y: 7 },
        { x: 6, y: 7 },
      ],
      oa: { width: W, height: H },
    },
    Ca: {
      Aa: opts.aa === undefined ? null : opts.aa,
      wa: wa,
    },
    wa: {
      ka: [{ pos: { x: 3, y: 3 }, type: 0 }],
      oa: { oa: { width: W, height: H } },
    },
  };
}

describe("co-op first-apple p6E wall Map", () => {
  let win;
  let Gsm;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    Gsm = loadGsm(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("ensureNativeWallMap creates Map with .add when Aa is null", () => {
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    assert.equal(g.Ca.Aa, null);
    const map = Gsm.ensureNativeWallMap(g.Ca);
    assert.ok(map);
    assert.equal(g.Ca.Aa, map);
    assert.equal(typeof map.add, "function");
    assert.equal(typeof map.set, "function");
    assert.equal(typeof map.forEach, "function");
  });

  it("native-style p6E.add does not throw after ensure (was null Aa crash)", () => {
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    Gsm.ensureNativeWallMap(g.Ca);
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(g, 4, 4);
    });
    assert.equal(g.Ca.wa[4][4], 1);
    assert.equal(g.Ca.Aa.size, 1);
    const key = Gsm.wallSerialKey(4, 4);
    assert.ok(g.Ca.Aa.has(key));
  });

  it("crashes without ensure — documents the production bug", () => {
    const g = makeWallGame({ aa: null });
    assert.throws(function () {
      simulateNativeWallGrowP6E(g, 4, 4);
    }, /Cannot read properties of null|null/);
  });

  it("co-op tick hook ensures Aa before simulated wall grow", () => {
    loadNative(win);
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    // Force reinstall tick hook for this window
    win.__mpCoopOnTickInstalled = false;
    const CoopNative = win.CoopNative;
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.injectEnabled = true;
    cn.syncBridge();
    // installCoopTickHook runs via CoopNative ctor side effects? Check exports
    if (typeof win.__mpCoopOnTick !== "function") {
      // Manually require install by touching module that sets it
      const nativePath = require.resolve(path.join(ROOT, "src/coop/native.js"));
      delete require.cache[nativePath];
      require(path.join(ROOT, "src/coop/native.js"));
    }
    assert.equal(typeof win.__mpCoopOnTick, "function", "tick hook installed");
    win.__mpCoopOnTick(g);
    assert.ok(g.Ca.Aa, "Aa after tick");
    assert.equal(typeof g.Ca.Aa.add, "function");
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(g, 5, 5);
    });
    assert.equal(g.Ca.Aa.size, 1);
  });

  it("applyCoopSpawnOffset ensures wall Map on seat", () => {
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    Gsm.applyCoopSpawnOffset(0, { slot: 0, x: 8, y: 7, dir: "RIGHT" });
    assert.ok(g.Ca.Aa);
    assert.equal(typeof g.Ca.Aa.add, "function");
  });

  it("resetCoopBoardForNewSession leaves Aa ready for p6E.add", () => {
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    Gsm.resetCoopBoardForNewSession(g);
    assert.ok(g.Ca.Aa);
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(g, 2, 2);
    });
  });

  it("peer applyBoardEntities then local p6E.add keeps Map alive", () => {
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    Gsm.applyBoardEntities({
      walls: [{ x: 3, y: 3 }],
      width: 17,
      height: 15,
    });
    assert.ok(g.Ca.Aa);
    assert.equal(typeof g.Ca.Aa.add, "function");
    // First apple as admin after peer sync
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(g, 6, 6);
    });
    assert.ok(g.Ca.Aa.size >= 2);
  });

  it("plain-object Aa is replaced so .has works (13th-apple crash)", () => {
    const g = makeWallGame({ aa: {} });
    win.__remixGame = g;
    win.__mpGame = g;
    assert.equal(typeof g.Ca.Aa.has, "undefined");
    const map = Gsm.ensureNativeWallMap(g.Ca);
    assert.equal(typeof map.has, "function");
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(g, 4, 4);
      assert.equal(map.has(Gsm.wallSerialKey(4, 4)), true);
    });
  });

  it("array Aa migrates wall entries into Map", () => {
    const wall = { pos: { x: 2, y: 2 }, wm: false };
    const g = makeWallGame({ aa: [wall] });
    Gsm.ensureNativeWallMap(g.Ca);
    assert.equal(typeof g.Ca.Aa.has, "function");
    assert.equal(g.Ca.Aa.has(Gsm.wallSerialKey(2, 2)), true);
  });

  it("ensureFruitShieldSets repairs {} nba before freePos .has", () => {
    const g = makeWallGame({ aa: null });
    g.wa.ka[0].nba = {};
    Gsm.ensureFruitShieldSets(g);
    assert.ok(g.wa.ka[0].nba instanceof Set);
    assert.equal(typeof g.wa.ka[0].nba.has, "function");
  });

  it("wrapFreePos recovers when native Rb throws a.has", () => {
    loadNative(win);
    const g = makeWallGame({ aa: {} });
    win.__remixGame = g;
    win.__mpGame = g;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    let calls = 0;
    g.Rb = function () {
      calls++;
      if (calls === 1) {
        throw new TypeError("a.has is not a function");
      }
      return { x: 10, y: 10 };
    };
    // Install wrap via tick hook path
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    assert.equal(typeof win.__mpCoopOnTick, "function");
    win.__mpCoopOnTick(g);
    assert.equal(typeof g.Rb, "function");
    assert.doesNotThrow(function () {
      const p = g.Rb(null, 5);
      assert.ok(p);
    });
    assert.equal(typeof g.Ca.Aa.has, "function");
    assert.ok(calls >= 2);
  });

  it("wrapFreePos recovers null.size (apple-eat freePos crash)", () => {
    loadNative(win);
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    let calls = 0;
    g.Rb = function () {
      calls++;
      if (calls === 1) {
        throw new TypeError("Cannot read properties of null (reading 'size')");
      }
      return { x: 10, y: 10 };
    };
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    assert.doesNotThrow(function () {
      const p = g.Rb(null, 5);
      assert.ok(p);
      assert.equal(p.x, 10);
    });
    assert.ok(g.Ca.Aa);
    assert.equal(typeof g.Ca.Aa.size, "number");
    assert.ok(calls >= 2);
  });

  it("ensureWallGridDense fills missing rows (tick reading '0' crash)", () => {
    const g = makeWallGame({ aa: null });
    // Punch a hole like a sparse grid after bad sync
    g.Ca.wa[5] = undefined;
    g.oa.oa = { width: 17, height: 15 };
    assert.equal(g.Ca.wa[5], undefined);
    assert.throws(function () {
      return g.Ca.wa[5][0];
    }, /undefined/);
    Gsm.ensureCoopTickHosts(g);
    assert.ok(Array.isArray(g.Ca.wa[5]));
    assert.equal(g.Ca.wa[5][0], 0);
    assert.doesNotThrow(function () {
      g.Ca.wa[5][0] = 1;
    });
  });

  it("ensureSnakeSegmentFlags grows with body after apple", () => {
    const g = makeWallGame({ aa: null });
    g.oa.ka = [
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
    ];
    g.oa.wa = undefined;
    Gsm.ensureSnakeSegmentFlags(g.oa);
    assert.ok(Array.isArray(g.oa.wa));
    assert.equal(g.oa.wa.length, 3);
    assert.equal(g.oa.wa[0], true);
    // Simulate apple growth
    g.oa.ka.push({ x: 2, y: 1 });
    Gsm.ensureSnakeSegmentFlags(g.oa);
    assert.equal(g.oa.wa.length, 4);
  });

  it("10×9 board: first wall grow + scrape round-trip", () => {
    const g = makeWallGame({ aa: null, width: 10, height: 9 });
    win.__remixGame = g;
    win.__mpGame = g;
    Gsm.ensureNativeWallMap(g.Ca);
    simulateNativeWallGrowP6E(g, 4, 4);
    const entities = Gsm.scrapeBoardEntities(g);
    assert.ok(entities.walls.some(function (p) {
      return p.x === 4 && p.y === 4;
    }));
  });
});
