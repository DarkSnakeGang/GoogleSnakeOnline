"use strict";

/**
 * Shield mode: Vb occupancy Set + peer serials, head ≤3 fruit pool,
 * initial nba plant, scrape/apply sync.
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

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  const p = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[p];
  require(p);
  return win.MultiplayerGsm;
}

function makeGame(W, H) {
  const wa = [];
  for (let y = 0; y < H; y++) {
    wa[y] = [];
    for (let x = 0; x < W; x++) wa[y][x] = 0;
  }
  return {
    oa: {
      ka: [
        { x: 5, y: 4 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      oa: { width: W, height: H },
    },
    Ca: { Aa: new Map(), wa: wa },
    wa: { ka: [], oa: { oa: { width: W, height: H } } },
    ka: { oa: { width: W, height: H }, wa: wa },
    settings: {},
    Rb: function () {
      return { x: 0, y: 0, clone: function () { return { x: this.x, y: this.y }; } };
    },
    Vb: function (extra, mode) {
      // Native occupancy builder: Set of serials (local body)
      const set = new Set();
      const body = this.oa && this.oa.ka;
      for (let i = 0; body && i < body.length; i++) {
        const p = body[i];
        if (p && p.x != null) set.add((p.x << 16) | p.y);
      }
      if (extra && extra.x != null) set.add((extra.x << 16) | extra.y);
      if (Number(mode) === 5) {
        return { x: 2, y: 2, clone: function () { return { x: 2, y: 2 }; } };
      }
      return set;
    },
  };
}

describe("coop shield Vb occupancy + head radius", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopRemotes = {};
    win.__mpCoopPlaySettings = { count: 0 };
    win.ModeRegistry = {
      getCurrentModeKey: function () {
        return "shield";
      },
    };
    loadNative(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("objectModeNeedsHeadRadius includes shield", () => {
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("shield"), true);
  });

  it("buildFruitSpawnPool excludes ≤3 of heads in shield mode", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopRemotes = {
      peer: { alive: true, body: [{ x: 8, y: 8 }] },
    };
    const pool = win.__mpCoopBuildFruitSpawnPool(g);
    const keys = new Set(
      pool.map(function (p) {
        return p.x + "," + p.y;
      })
    );
    assert.ok(!keys.has("5,4"));
    assert.ok(!keys.has("5,5"));
    assert.ok(!keys.has("8,8"));
    assert.ok(!keys.has("8,7"));
    assert.ok(keys.has("0,0"));
  });

  it("Vb(pos, 2) returns Set including remote body serials", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopRemotes = {
      peer: {
        alive: true,
        body: [
          { x: 6, y: 4 },
          { x: 7, y: 4 },
        ],
      },
    };
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    const fruitPos = { x: 6, y: 5 };
    const set = g.Vb(fruitPos, 2);
    assert.ok(set && typeof set.has === "function", "must be a Set");
    assert.equal(typeof set.add, "function");
    // Local head
    assert.equal(set.has((5 << 16) | 4), true);
    // Peer body next to fruit
    assert.equal(set.has((6 << 16) | 4), true);
    assert.equal(set.has((7 << 16) | 4), true);
    // board.Ca rebound uses same Vb
    assert.equal(g.ka.Ca.__mpCoopFreePos, true);
    const viaCa = g.ka.Ca(fruitPos, 2);
    assert.ok(viaCa && viaCa.has((6 << 16) | 4));
  });

  it("Vb wallPick (null,5) still returns a point not a Set", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    const p = g.Vb(null, 5);
    assert.ok(p);
    assert.ok(p.x != null && p.y != null);
    assert.equal(typeof p.has, "undefined");
  });
});

describe("coop shield initial nba + sync", () => {
  let win;
  let Gsm;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    win.__mpCoopSession = true;
    win.__mpCoopServerAuth = false;
    win.__mpCoopInject = true;
    win.__mpCoopPlaySettings = { size: 1, count: 0, apple: 0 };
    win.ModeRegistry = {
      getCurrentModeKey: function () {
        return "shield";
      },
    };
    win.__slotP3E = function (_host, pos) {
      const s = new Set(["UP", "LEFT"]);
      s.__fromMock = true;
      s.__pos = pos;
      return s;
    };
    loadNative(win);
    Gsm = loadGsm(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function gameAt(w, h) {
    const g = makeGame(w, h);
    // Fruit host needs cloneable pos template for plant
    g.wa.ka = [
      {
        pos: {
          x: -1,
          y: -1,
          clone: function () {
            return { x: this.x, y: this.y, clone: this.clone };
          },
        },
        nba: new Set(),
      },
    ];
    win.__mpGame = g;
    win.__remixGame = g;
    return g;
  }

  it("isShieldMode true under ModeRegistry shield", () => {
    assert.equal(Gsm.isShieldMode(), true);
  });

  it("plantClassicInitialFruit assigns nba via __slotP3E", () => {
    const g = gameAt(10, 9);
    assert.equal(Gsm.plantClassicInitialFruit(g), true);
    assert.ok(g.wa.ka.length >= 1);
    const nba = g.wa.ka[0].nba;
    assert.ok(nba instanceof Set);
    assert.equal(nba.has("UP"), true);
    assert.equal(nba.has("LEFT"), true);
  });

  it("assignCoopFruitShields fills empty nba only", () => {
    const g = gameAt(10, 9);
    g.wa.ka = [
      {
        pos: { x: 3, y: 3 },
        nba: new Set(["DOWN"]),
      },
      {
        pos: { x: 4, y: 4 },
        nba: new Set(),
      },
    ];
    assert.equal(Gsm.assignCoopFruitShields(g), true);
    assert.equal(g.wa.ka[0].nba.has("DOWN"), true);
    assert.equal(g.wa.ka[0].nba.size, 1, "existing nba kept");
    assert.equal(g.wa.ka[1].nba.has("UP"), true);
  });

  it("scrape + apply round-trips shield dirs", () => {
    const g = gameAt(10, 9);
    assert.equal(Gsm.plantClassicInitialFruit(g), true);
    const cols = Gsm.scrapeCollectables({ includeEntities: true });
    assert.ok(cols.apples && cols.apples.length >= 1);
    assert.deepEqual(cols.apples[0].shields, ["UP", "LEFT"]);
    const peer = gameAt(10, 9);
    peer.wa.ka = [
      {
        pos: {
          x: 0,
          y: 0,
          clone: function () {
            return { x: this.x, y: this.y, clone: this.clone };
          },
        },
        nba: new Set(),
      },
    ];
    win.__mpGame = peer;
    win.__remixGame = peer;
    assert.equal(
      Gsm.applyCollectables({
        apples: cols.apples,
        exactBoard: true,
        initial: true,
      }),
      true
    );
    assert.ok(peer.wa.ka[0].nba instanceof Set);
    assert.equal(peer.wa.ka[0].nba.has("UP"), true);
    assert.equal(peer.wa.ka[0].nba.has("LEFT"), true);
  });
});
