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

describe("co-op wall eat: eater authority + no crash (evidence)", () => {
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

  function wallKeys(walls) {
    return (walls || [])
      .map(function (w) {
        return (w.x | 0) + "," + (w.y | 0);
      })
      .sort();
  }

  /**
   * Evidence: eating client tick + native wall grow must not throw, and the
   * solid cell / Aa entry must be exactly the cell that client grew.
   */
  it("eater tick + p6E fruit-eat wall grow does not crash and plants eater cell", () => {
    loadNative(win);
    const g = makeWallGame({ aa: null });
    win.__remixGame = g;
    win.__mpGame = g;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopOnTickInstalled = false;
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    require(path.join(ROOT, "src/coop/native.js"));

    // Fruit about to be eaten (native would remove it; we only care wall path).
    g.wa.ka = [{ pos: { x: 8, y: 7 }, type: 0 }];

    assert.equal(typeof win.__mpCoopOnTick, "function");
    assert.doesNotThrow(function () {
      win.__mpCoopOnTick(g);
    });
    assert.ok(g.Ca.Aa, "Aa ready before p6E");

    const eaterWall = { x: 9, y: 4 };
    assert.doesNotThrow(function () {
      // Native freePos(null,5) chose this cell on the eater — plant it.
      simulateNativeWallGrowP6E(g, eaterWall.x, eaterWall.y);
      // Fruit removed after eat
      g.wa.ka = [];
    });

    assert.equal(g.Ca.wa[eaterWall.y][eaterWall.x], 1, "wa solid at eater cell");
    assert.equal(
      g.Ca.Aa.has(Gsm.wallSerialKey(eaterWall.x, eaterWall.y)),
      true,
      "Aa has eater cell"
    );

    const scraped = Gsm.scrapeBoardEntities(g);
    assert.deepEqual(wallKeys(scraped.walls), [eaterWall.x + "," + eaterWall.y]);
  });

  /**
   * Evidence: peer board adopts the eater's scraped walls — placement follows
   * the client that ate, not a peer-local invent.
   */
  it("peer applyBoardEntities mirrors eater scrape (eater places, peer receives)", () => {
    const eater = makeWallGame({ aa: null });
    const peer = makeWallGame({ aa: null });

    // Peer starts with a different pre-existing wall that must be replaced
    // when the eater's full wall list arrives (eater authority).
    win.__remixGame = peer;
    win.__mpGame = peer;
    Gsm.ensureNativeWallMap(peer.Ca);
    simulateNativeWallGrowP6E(peer, 1, 1);
    assert.equal(peer.Ca.wa[1][1], 1);

    win.__remixGame = eater;
    win.__mpGame = eater;
    Gsm.ensureNativeWallMap(eater.Ca);
    // Eater already had one wall, then ate and grew a second at a freePos cell.
    simulateNativeWallGrowP6E(eater, 2, 2);
    const eaterChosen = { x: 11, y: 6 };
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(eater, eaterChosen.x, eaterChosen.y);
    });

    const payload = Gsm.scrapeBoardEntities(eater);
    assert.ok(
      wallKeys(payload.walls).indexOf(eaterChosen.x + "," + eaterChosen.y) >= 0,
      "eater scrape includes chosen cell"
    );
    assert.equal(
      wallKeys(payload.walls).indexOf("1,1"),
      -1,
      "eater never had peer's stale 1,1"
    );

    // Switch gameInstance to peer and apply eater payload (wire receive path).
    win.__remixGame = peer;
    win.__mpGame = peer;
    assert.doesNotThrow(function () {
      Gsm.applyBoardEntities({
        walls: payload.walls,
        width: payload.width || 17,
        height: payload.height || 15,
      });
    });

    assert.equal(
      peer.Ca.wa[eaterChosen.y][eaterChosen.x],
      1,
      "peer solid matches eater placement"
    );
    assert.equal(
      peer.Ca.Aa.has(Gsm.wallSerialKey(eaterChosen.x, eaterChosen.y)),
      true,
      "peer Aa has eater cell"
    );
    assert.equal(
      peer.Ca.wa[2][2],
      1,
      "peer also has eater's earlier wall"
    );
    // Stale peer-only wall cleared when eater's list replaced Aa/wa.
    assert.equal(
      peer.Ca.wa[1][1] | 0,
      0,
      "peer dropped wall the eater did not publish"
    );
    assert.deepEqual(
      wallKeys(Gsm.scrapeBoardEntities(peer).walls),
      wallKeys(payload.walls),
      "peer scrape equals eater scrape after apply"
    );
  });

  it("two sequential eaters: second client's grow still no-crash and both walls sync", () => {
    const a = makeWallGame({ aa: null });
    const b = makeWallGame({ aa: null });

    win.__remixGame = a;
    win.__mpGame = a;
    Gsm.ensureNativeWallMap(a.Ca);
    assert.doesNotThrow(function () {
      simulateNativeWallGrowP6E(a, 4, 4);
    });
    let wire = Gsm.scrapeBoardEntities(a);

    win.__remixGame = b;
    win.__mpGame = b;
    assert.doesNotThrow(function () {
      Gsm.applyBoardEntities({
        walls: wire.walls,
        width: 17,
        height: 15,
      });
      // Second player eats — tick-style ensure then grow.
      loadNative(win);
      win.__mpCoopSession = true;
      win.__mpCoopInject = true;
      win.__mpCoopOnTickInstalled = false;
      delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
      require(path.join(ROOT, "src/coop/native.js"));
      win.__mpCoopOnTick(b);
      simulateNativeWallGrowP6E(b, 7, 7);
    });

    wire = Gsm.scrapeBoardEntities(b);
    assert.deepEqual(wallKeys(wire.walls).sort(), ["4,4", "7,7"]);

    win.__remixGame = a;
    win.__mpGame = a;
    assert.doesNotThrow(function () {
      Gsm.applyBoardEntities({
        walls: wire.walls,
        width: 17,
        height: 15,
      });
    });
    assert.equal(a.Ca.wa[7][7], 1);
    assert.equal(a.Ca.wa[4][4], 1);
    assert.deepEqual(wallKeys(Gsm.scrapeBoardEntities(a).walls).sort(), ["4,4", "7,7"]);
  });
});
