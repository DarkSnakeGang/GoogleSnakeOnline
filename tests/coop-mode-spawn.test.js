"use strict";

/**
 * Mode object spawn: board.Ga freePos + head radius; Key/Sokoban initial
 * objects (no fruit) + scrape/apply sync.
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
    ka: { oa: { width: W, height: H }, wa: wa },
    Ba: { keys: [] },
    Aa: { oa: [], d_: [] },
    Rb: function () {
      return { x: 0, y: 0, clone: function () { return { x: this.x, y: this.y }; } };
    },
    Vb: function () {
      return { x: 1, y: 1, clone: function () { return { x: this.x, y: this.y }; } };
    },
  };
}

describe("coop mode object spawn pool / board.Ga", () => {
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
        return "minesweeper";
      },
    };
    loadNative(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("objectModeNeedsHeadRadius true for wall/poison/mines/gate/bridge/key/soko", () => {
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("wall"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("poison"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("minesweeper"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("gate"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("bridge"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("key"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("sokoban"), true);
    assert.equal(win.__mpCoopObjectModeNeedsHeadRadius("classic"), false);
  });

  it("buildFruitSpawnPool applies head ≤3 in object modes without Tally", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopPlaySettings = { count: 0 };
    win.ModeRegistry.getCurrentModeKey = function () {
      return "minesweeper";
    };
    win.__mpCoopRemotes = {
      peer: { alive: true, body: [{ x: 8, y: 8 }] },
    };
    const pool = win.__mpCoopBuildFruitSpawnPool(g);
    const keys = new Set(
      pool.map(function (p) {
        return p.x + "," + p.y;
      })
    );
    assert.ok(!keys.has("5,4"), "local head excluded");
    assert.ok(!keys.has("5,5"), "≤3 of local head");
    assert.ok(!keys.has("8,8"), "peer head excluded");
    assert.ok(!keys.has("8,7"), "≤3 of peer head");
    assert.ok(keys.has("0,0"));
  });

  it("board.Ga rebind uses wrapped pool (not original Rb on head)", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    // Board starts with unbound original freePos (construction-time bind)
    let nativeCalls = 0;
    const origRb = function () {
      nativeCalls++;
      return { x: 5, y: 4 };
    };
    g.Rb = origRb;
    g.ka.Ga = origRb.bind(g);
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    assert.equal(g.ka.Ga.__mpCoopFreePos, true);
    const p = g.ka.Ga(null, 0);
    assert.ok(p);
    assert.notEqual(p.x + "," + p.y, "5,4");
    assert.equal(typeof p.clone, "function");
    assert.equal(nativeCalls, 0, "pool path must not call original Rb");
  });

  it("fear_spawn_pick rejects peer cell and re-rolls from pool", () => {
    const g = makeGame(10, 9);
    win.__mpGame = g;
    win.__remixGame = g;
    win.ModeRegistry.getCurrentModeKey = function () {
      return "poison";
    };
    win.__mpCoopRemotes = {
      peer: {
        alive: true,
        body: [
          { x: 1, y: 1 },
          { x: 1, y: 2 },
        ],
      },
    };
    win.fear_spawn_pick = function () {
      return { x: 1, y: 1 };
    };
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));
    win.__mpCoopOnTick(g);
    assert.equal(win.fear_spawn_pick.__mpCoop, true);
    const p = win.fear_spawn_pick(function () {}, g.ka, null, 4);
    assert.ok(p);
    assert.notEqual(p.x + "," + p.y, "1,1");
  });
});

describe("coop key/sokoban initial seed + sync", () => {
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
        return "key";
      },
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
    win.__mpGame = g;
    win.__remixGame = g;
    return g;
  }

  it("plantClassicInitialFruit no-ops under key mode", () => {
    const g = gameAt(10, 9);
    g.wa.ka = [];
    assert.equal(Gsm.isKeyOrSokobanMode(), true);
    assert.equal(Gsm.plantClassicInitialFruit(g), false);
    assert.equal(g.wa.ka.length, 0);
  });

  it("plantInitialKeySokoban plants keys with keyblocks and clears fruit", () => {
    const g = gameAt(10, 9);
    g.wa.ka = [{ pos: { x: 7, y: 4 } }];
    assert.equal(Gsm.plantInitialKeySokoban(g), true);
    assert.equal(g.wa.ka.length, 0, "fruit cleared");
    assert.ok(g.Ba.keys.length >= 1);
    const k = g.Ba.keys[0];
    assert.ok(k.pos && k.pos.x != null);
    assert.ok(k.r7a && k.r7a.x != null);
    assert.notEqual(k.pos.x + "," + k.pos.y, k.r7a.x + "," + k.r7a.y);
    assert.equal(k.type, 0);
  });

  it("plantInitialKeySokoban plants boxes+goals under sokoban", () => {
    win.ModeRegistry.getCurrentModeKey = function () {
      return "sokoban";
    };
    const g = gameAt(10, 9);
    g.wa.ka = [{ pos: { x: 2, y: 2 } }];
    assert.equal(Gsm.plantInitialKeySokoban(g), true);
    assert.equal(g.wa.ka.length, 0);
    assert.ok(g.Aa.oa.length >= 1);
    assert.ok(g.Aa.d_.length >= 1);
  });

  it("scrape + applyBoardEntities round-trips keys with type and keyblock", () => {
    const g = gameAt(10, 9);
    assert.equal(Gsm.plantInitialKeySokoban(g), true);
    const cols = Gsm.scrapeCollectables({ includeEntities: true });
    assert.ok(cols.keys && cols.keys.length >= 1);
    assert.equal((cols.apples || []).length, 0);
    const src = cols.keys[0];
    assert.ok(src.keyblock);
    // Peer board
    const peer = gameAt(10, 9);
    peer.Ba.keys = [];
    peer.wa.ka = [{ pos: { x: 0, y: 0 } }];
    win.__mpGame = peer;
    win.__remixGame = peer;
    assert.equal(
      Gsm.applyBoardEntities({
        keys: cols.keys,
        boxes: [],
        goals: [],
        walls: [],
        width: 10,
        height: 9,
      }),
      true
    );
    assert.ok(peer.Ba.keys.length >= 1);
    const pk = peer.Ba.keys[0];
    assert.equal(pk.pos.x | 0, src.x | 0);
    assert.equal(pk.pos.y | 0, src.y | 0);
    assert.equal(pk.type, src.type);
    assert.ok(pk.r7a);
    assert.equal(pk.r7a.x | 0, src.keyblock.x | 0);
    assert.equal(pk.r7a.y | 0, src.keyblock.y | 0);
  });

  it("scrape + applyBoardEntities round-trips sokoban boxes and goals", () => {
    win.ModeRegistry.getCurrentModeKey = function () {
      return "sokoban";
    };
    const g = gameAt(10, 9);
    assert.equal(Gsm.plantInitialKeySokoban(g), true);
    const cols = Gsm.scrapeCollectables({ includeEntities: true });
    assert.ok(cols.boxes.length >= 1);
    assert.ok(cols.goals.length >= 1);
    const peer = gameAt(10, 9);
    peer.Aa.oa = [];
    peer.Aa.d_ = [];
    win.__mpGame = peer;
    win.__remixGame = peer;
    assert.equal(
      Gsm.applyBoardEntities({
        keys: [],
        boxes: cols.boxes,
        goals: cols.goals,
        walls: [],
        width: 10,
        height: 9,
      }),
      true
    );
    assert.equal(peer.Aa.oa.length, cols.boxes.length);
    assert.equal(peer.Aa.d_.length, cols.goals.length);
  });

  it("keeps native key stock and only clears fruit", () => {
    const g = gameAt(10, 9);
    g.Ba.keys = [
      {
        pos: { x: 2, y: 2, clone: function () { return { x: 2, y: 2 }; } },
        r7a: { x: 3, y: 3 },
        type: 5,
      },
    ];
    g.wa.ka = [{ pos: { x: 7, y: 4 } }];
    assert.equal(Gsm.plantInitialKeySokoban(g), true);
    assert.equal(g.Ba.keys.length, 1);
    assert.equal(g.Ba.keys[0].type, 5);
    assert.equal(g.wa.ka.length, 0);
  });
});
