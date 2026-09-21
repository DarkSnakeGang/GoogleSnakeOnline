"use strict";

/**
 * Winged + Magnet co-op: seed/trust, nearest-head magnet, peer-body bounce.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadNative(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/native.js"));
  delete require.cache[p];
  delete win.__mpCoopRenderInstalled;
  delete win.__mpCoopOnTickInstalled;
  require(path.join(ROOT, "src/coop/native.js"));
  return win;
}

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  const p = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[p];
  const colorsPath = require.resolve(path.join(ROOT, "src/shared/colors.js"));
  delete require.cache[colorsPath];
  require(path.join(ROOT, "src/shared/colors.js"));
  require(p);
  return win.MultiplayerGsm;
}

function makeGame(W, H) {
  return {
    oa: {
      ka: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ],
      oa: { width: W, height: H },
    },
    wa: {
      ka: [],
      oa: { oa: { width: W, height: H } },
    },
    settings: {},
  };
}

describe("coop winged/magnet fruit motion", () => {
  let win;
  let Gsm;

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
        return "classic";
      },
    };
    Gsm = loadGsm(win);
    loadNative(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("isCoopFruitMotionMode true for magnet + slot 18", () => {
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };
    assert.equal(Gsm.isCoopFruitMotionMode(), true);

    win.ModeRegistry.getCurrentModeKey = function () {
      return "classic";
    };
    win.__slotActive = 18;
    assert.equal(Gsm.isCoopFruitMotionMode(), true);

    delete win.__slotActive;
    win.ModeRegistry.getCurrentModeKey = function () {
      return "winged";
    };
    assert.equal(Gsm.isCoopFruitMotionMode(), true);

    win.ModeRegistry.getCurrentModeKey = function () {
      return "classic";
    };
    assert.equal(Gsm.isCoopFruitMotionMode(), false);
  });

  it("magnet: seed applies pos+He; trust delta does not yank", () => {
    const g = makeGame(12, 10);
    g.wa.ka = [
      {
        pos: {
          x: 4,
          y: 4,
          clone: function () {
            return { x: this.x, y: this.y };
          },
        },
        type: 0,
        He: { x: 0.5, y: 0 },
        CAb: { x: 0.5, y: 0 },
        iL: { x: 1, y: 1 },
      },
    ];
    win.__remixGame = g;
    win.__mpGame = g;
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };

    assert.equal(
      Gsm.applyCollectables({
        fruitMotionSeed: true,
        apples: [{ x: 8, y: 3, type: 0, he: { x: -0.5, y: 0.5 } }],
      }),
      true
    );
    assert.equal(g.wa.ka[0].pos.x, 8);
    assert.equal(g.wa.ka[0].pos.y, 3);
    assert.equal(g.wa.ka[0].He.x, -0.5);
    assert.equal(g.wa.ka[0].He.y, 0.5);

    g.wa.ka[0].pos.x = 7.5;
    g.wa.ka[0].pos.y = 3.5;
    g.wa.ka[0].He.x = 0.5;
    g.wa.ka[0].He.y = -0.5;

    assert.equal(
      Gsm.applyCollectables({
        fruitMotionTrust: true,
        apples: [{ x: 1, y: 1, type: 0, he: { x: -0.5, y: -0.5 } }],
      }),
      true
    );
    assert.equal(g.wa.ka[0].pos.x, 7.5);
    assert.equal(g.wa.ka[0].pos.y, 3.5);
    assert.equal(g.wa.ka[0].He.x, 0.5);
    assert.equal(g.wa.ka[0].He.y, -0.5);
  });

  it("fingerprint ignores xy under magnet motion mode", () => {
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };
    const a = { apples: [{ x: 3, y: 4, type: 0 }] };
    const b = { apples: [{ x: 9, y: 1, type: 0 }] };
    assert.equal(
      Gsm.collectablesFingerprint(a),
      Gsm.collectablesFingerprint(b),
      "magnet motion mode must ignore live apple xy"
    );
  });

  it("nearest-head retarget: remote closer than local → He aims at remote", () => {
    const g = makeGame(17, 15);
    // Local head at (2,2)
    g.oa.ka[0] = { x: 2, y: 2 };
    // Fruit near remote at (10,10)
    g.wa.ka = [
      {
        pos: { x: 9, y: 10 },
        He: { x: -0.5, y: -0.5 },
        CAb: { x: 0, y: 0 },
        iL: { x: 1, y: 1 },
      },
    ];
    win.__mpGame = g;
    win.__remixGame = g;
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };
    win.__mpCoopRemotes = {
      peer: {
        alive: true,
        body: [{ x: 10, y: 10 }, { x: 11, y: 10 }],
      },
    };
    win.__mpCoopMyId = "me";

    const n = win.__mpCoopRetargetMagnetHe(g);
    assert.ok(n >= 1);
    assert.equal(g.wa.ka[0].He.x, 0.5, "fruit left of remote → He.x +0.5");
    assert.equal(g.wa.ka[0].He.y, 0, "same y as remote → park He.y");
  });

  it("peer bounce: fruit into remote body cell flips He (peer-only occ)", () => {
    const g = makeGame(17, 15);
    const fruit = {
      pos: { x: 5, y: 5 },
      He: { x: 0.5, y: 0 },
      CAb: { x: 0.5, y: 0 },
      iL: { x: 1, y: 1 },
    };
    g.wa.ka = [fruit];
    win.__mpGame = g;
    win.__remixGame = g;
    win.ModeRegistry.getCurrentModeKey = function () {
      return "winged";
    };
    // Peer-only occupancy — no local cells required
    const peerOcc = { "6,5": true };
    const changed = win.__mpCoopBounceFruitOffBodies(g, fruit, peerOcc);
    assert.equal(changed, true);
    assert.equal(fruit.He.x, -0.5, "bounce flips He.x away from peer cell");
  });

  it("magnet peer bounce parks He axis (V3E-style)", () => {
    const g = makeGame(17, 15);
    const fruit = {
      pos: { x: 5, y: 5 },
      He: { x: 0.5, y: 0.5 },
      CAb: { x: 0, y: 0 },
      iL: { x: 1, y: 1 },
    };
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };
    const peerOcc = { "6,5": true };
    assert.equal(win.__mpCoopBounceFruitOffBodies(g, fruit, peerOcc), true);
    assert.equal(fruit.He.x, 0, "magnet parks He.x into CAb");
    assert.equal(fruit.CAb.x, 0.5);
  });

  it("scrape he round-trips through applyCollectables seed", () => {
    const g = makeGame(12, 10);
    g.wa.ka = [
      {
        pos: {
          x: 4,
          y: 5,
          clone: function () {
            return { x: this.x, y: this.y };
          },
        },
        type: 0,
        He: { x: 0.5, y: -0.5 },
        CAb: { x: 0.5, y: -0.5 },
        iL: { x: 1, y: 1 },
      },
    ];
    win.__remixGame = g;
    win.__mpGame = g;
    win.ModeRegistry.getCurrentModeKey = function () {
      return "winged";
    };

    const cols = Gsm.scrapeCollectables();
    assert.ok(cols && cols.apples && cols.apples[0]);
    assert.deepEqual(cols.apples[0].he, { x: 0.5, y: -0.5 });
    assert.equal(cols.apples[0].x, 4);
    assert.equal(cols.apples[0].y, 5);

    // Peer board starts elsewhere; seed must overwrite pos+He from wire
    const peer = makeGame(12, 10);
    peer.wa.ka = [
      {
        pos: {
          x: 1,
          y: 1,
          clone: function () {
            return { x: this.x, y: this.y };
          },
        },
        type: 0,
        He: { x: -0.5, y: 0.5 },
        CAb: { x: -0.5, y: 0.5 },
        iL: { x: 1, y: 1 },
      },
    ];
    win.__remixGame = peer;
    win.__mpGame = peer;
    assert.equal(
      Gsm.applyCollectables({
        fruitMotionSeed: true,
        apples: cols.apples,
      }),
      true
    );
    assert.equal(peer.wa.ka[0].pos.x, 4);
    assert.equal(peer.wa.ka[0].pos.y, 5);
    assert.equal(peer.wa.ka[0].He.x, 0.5);
    assert.equal(peer.wa.ka[0].He.y, -0.5);
  });

  it("dual-sim: same seed + remotes → matching pos/He after N ticks", () => {
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };
    win.__mpCoopMyId = "me";
    const remotes = {
      peer: {
        alive: true,
        body: [
          { x: 10, y: 8 },
          { x: 11, y: 8 },
          { x: 12, y: 8 },
        ],
      },
    };

    function cloneGame() {
      const g = makeGame(17, 15);
      g.oa.ka = [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ];
      g.wa.ka = [
        {
          pos: { x: 8, y: 8 },
          He: { x: 0.5, y: 0 },
          CAb: { x: 0.5, y: 0 },
          iL: { x: 1, y: 1 },
        },
      ];
      return g;
    }

    function stepClient(game) {
      // Native fruit update (pos += He when iL open)
      const f = game.wa.ka[0];
      if (f.iL && f.iL.x) f.pos.x += f.He.x;
      if (f.iL && f.iL.y) f.pos.y += f.He.y;
      // Shared post-tick: nearest-head + peer bounce
      win.__mpCoopApplyFruitMotionTick(game);
    }

    const a = cloneGame();
    const b = cloneGame();
    win.__mpCoopRemotes = remotes;

    // Seed both from the same wire payload
    const seed = {
      fruitMotionSeed: true,
      apples: [{ x: 8, y: 8, type: 0, he: { x: 0.5, y: 0 } }],
    };
    win.__remixGame = a;
    win.__mpGame = a;
    assert.equal(Gsm.applyCollectables(seed), true);
    win.__remixGame = b;
    win.__mpGame = b;
    assert.equal(Gsm.applyCollectables(seed), true);

    for (let t = 0; t < 12; t++) {
      win.__mpGame = a;
      win.__remixGame = a;
      stepClient(a);
      win.__mpGame = b;
      win.__remixGame = b;
      stepClient(b);
    }

    assert.equal(a.wa.ka[0].pos.x, b.wa.ka[0].pos.x);
    assert.equal(a.wa.ka[0].pos.y, b.wa.ka[0].pos.y);
    assert.equal(a.wa.ka[0].He.x, b.wa.ka[0].He.x);
    assert.equal(a.wa.ka[0].He.y, b.wa.ka[0].He.y);
    // Fruit should have been pulled toward remote at (10,8) and bounced
    assert.ok(
      a.wa.ka[0].pos.x !== 8 || a.wa.ka[0].He.x !== 0.5,
      "motion must leave the seed pose or He"
    );
  });

  it("microtask after OnTick: magnet retarget wins over native local-head pull", async () => {
    const g = makeGame(17, 15);
    g.oa.ka[0] = { x: 2, y: 2 };
    // Keep fruit >1 tile from peer so bounce does not park the retargeted He
    g.wa.ka = [
      {
        pos: { x: 7, y: 10 },
        He: { x: 0, y: 0 },
        CAb: { x: 0, y: 0 },
        iL: { x: 1, y: 1 },
      },
    ];
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopMyId = "me";
    win.ModeRegistry.getCurrentModeKey = function () {
      return "magnet";
    };
    win.__mpCoopRemotes = {
      peer: { alive: true, body: [{ x: 10, y: 10 }] },
    };

    win.__mpCoopOnTick(g);
    // Native magnet would pull toward local (2,2) during the rest of tick()
    g.wa.ka[0].He.x = -0.5;
    g.wa.ka[0].He.y = -0.5;

    await Promise.resolve(); // flush queueMicrotask from scheduleCoopFruitMotionAfterTick

    assert.equal(g.wa.ka[0].He.x, 0.5, "post-tick retarget toward remote");
    assert.equal(g.wa.ka[0].He.y, 0, "same y as remote parks He.y");
  });

  it("companion Ra body participates in fruit bounce occupancy", () => {
    const g = makeGame(17, 15);
    g.oa.ka = [{ x: 0, y: 0 }]; // far local
    g.Ra = {
      ka: [
        { x: 6, y: 5 },
        { x: 7, y: 5 },
      ],
    };
    g.wa.ka = [
      {
        pos: { x: 5, y: 5 },
        He: { x: 0.5, y: 0 },
        CAb: { x: 0.5, y: 0 },
        iL: { x: 1, y: 1 },
      },
    ];
    win.__mpGame = g;
    win.__remixGame = g;
    win.__mpCoopRemotes = {};
    win.ModeRegistry.getCurrentModeKey = function () {
      return "winged";
    };

    win.__mpCoopApplyFruitMotionTick(g);
    assert.equal(
      g.wa.ka[0].He.x,
      -0.5,
      "fruit bouncing off companion body flips He.x"
    );
  });

  it("multi-tick bounce chain off peer stays deterministic", () => {
    win.ModeRegistry.getCurrentModeKey = function () {
      return "winged";
    };
    const peerOcc = {
      "8,5": true,
      "8,6": true,
      "8,4": true,
    };
    function run(fruit) {
      const g = makeGame(17, 15);
      for (let t = 0; t < 6; t++) {
        if (fruit.iL.x) fruit.pos.x += fruit.He.x;
        if (fruit.iL.y) fruit.pos.y += fruit.He.y;
        win.__mpCoopBounceFruitOffBodies(g, fruit, peerOcc);
      }
      return { x: fruit.pos.x, y: fruit.pos.y, hx: fruit.He.x, hy: fruit.He.y };
    }
    const a = run({
      pos: { x: 5, y: 5 },
      He: { x: 0.5, y: 0 },
      CAb: { x: 0.5, y: 0 },
      iL: { x: 1, y: 1 },
    });
    const b = run({
      pos: { x: 5, y: 5 },
      He: { x: 0.5, y: 0 },
      CAb: { x: 0.5, y: 0 },
      iL: { x: 1, y: 1 },
    });
    assert.deepEqual(a, b);
    assert.ok(a.hx === -0.5 || a.x < 8, "must reverse before or at peer wall");
  });
});

/**
 * Publish/receive wiring through MultiplayerApp (seed/trust flags + initial).
 */
describe("coop fruit motion publish/receive wire", () => {
  let Protocol;

  function stubDom() {
    global.window = global;
    global.document = {
      querySelector: function () {
        return null;
      },
      querySelectorAll: function () {
        return [];
      },
      getElementsByClassName: function () {
        return [];
      },
      getElementById: function () {
        return null;
      },
      addEventListener: function () {},
      createElement: function () {
        return {
          style: {},
          classList: { add: function () {}, remove: function () {} },
          appendChild: function () {},
          setAttribute: function () {},
        };
      },
      body: { appendChild: function () {} },
    };
  }

  function loadModApp() {
    stubDom();
    [
      "shared/colors.js",
      "shared/protocol.js",
      "runtime/bridge.js",
      "session/ready.js",
      "race/scoreboard.js",
      "coop/state.js",
      "coop/session.js",
      "coop/native.js",
      "hooks/gsm.js",
      "hooks/visibility.js",
      "net/client.js",
      "ui/settingsTab.js",
      "race/focus.js",
      "race/mosaic.js",
      "mod.js",
    ].forEach(function (rel) {
      const p = require.resolve(path.join(ROOT, "src", rel));
      delete require.cache[p];
      require(p);
    });
    Protocol = global.MultiplayerProtocol;
    return global.MultiplayerApp;
  }

  afterEach(() => {
    // Keep a durable DOM stub: connect() / gsm hideControlHelper schedule
    // timers that touch document after the test body returns.
    stubDom();
  });

  it("publishInitialCoopBoard sets fruitMotionSeed in motion mode", () => {
    const MultiplayerApp = loadModApp();
    const boards = [];
    global.MultiplayerGsm.isCoopFruitMotionMode = function () {
      return true;
    };
    global.MultiplayerGsm.scrapeCollectables = function () {
      return {
        apples: [{ x: 3, y: 4, type: 0, he: { x: 0.5, y: -0.5 } }],
        collectables: [{ x: 3, y: 4, type: 0, he: { x: 0.5, y: -0.5 } }],
      };
    };
    global.MultiplayerGsm.effectiveModeKey = function () {
      return "magnet";
    };
    global.MultiplayerGsm.isKeyOrSokobanMode = function () {
      return false;
    };

    const app = new MultiplayerApp();
    app._coopAuthority = "native-relay-v1";
    app._coopBoardInitRequested = true;
    app._coopSpawnApplied = true;
    app.coop.collectablesOwnerId = "me";
    app.coop.boardReady = false;
    app.coop.generation = 1;
    app.coopSession.bindGeneration(1, "native-relay-v1", false);
    app.client = {
      connected: true,
      clientId: "me",
      roster: { mode: "coop", sessionActive: true },
      me: function () {
        return { clientId: "me", role: "player" };
      },
      collectablesDelta: function (cols) {
        boards.push(cols);
      },
    };
    assert.equal(app.publishInitialCoopBoard(), true);
    assert.equal(boards.length, 1);
    assert.equal(boards[0].fruitMotionSeed, true);
    assert.equal(boards[0].initial, true);
    assert.deepEqual(boards[0].apples[0].he, { x: 0.5, y: -0.5 });
  });

  it("publishCoopCollectables force→seed, else→trust", () => {
    const MultiplayerApp = loadModApp();
    const boards = [];
    let fpN = 0;
    global.MultiplayerGsm.isCoopFruitMotionMode = function () {
      return true;
    };
    global.MultiplayerGsm.scrapeCollectables = function () {
      fpN++;
      return {
        apples: [{ x: fpN, y: 4, type: 0, he: { x: 0.5, y: 0 } }],
        collectables: [{ x: fpN, y: 4, type: 0, he: { x: 0.5, y: 0 } }],
      };
    };
    global.MultiplayerGsm.collectablesFingerprint = function (cols) {
      return "fp-" + (cols.apples && cols.apples[0] && cols.apples[0].x);
    };
    global.MultiplayerGsm.effectiveModeKey = function () {
      return "winged";
    };

    const app = new MultiplayerApp();
    app._coopAuthority = "native-relay-v1";
    app._coopSessionActive = true;
    app.coop.boardReady = true;
    app.coop.generation = 2;
    app.coopSession.bindGeneration(2, "native-relay-v1", false);
    app.coopSession.enterSeating(2, "native-relay-v1");
    app.coopSession.markSeated();
    app.coopNative = { applyCollectables: function () {} };
    app.client = {
      connected: true,
      clientId: "me",
      roster: { mode: "coop", sessionActive: true },
      me: function () {
        return { clientId: "me", role: "player" };
      },
      collectablesDelta: function (cols) {
        boards.push(cols);
      },
    };

    assert.equal(app.publishCoopCollectables(true), true);
    assert.equal(boards[0].fruitMotionSeed, true);
    assert.equal(boards[0].fruitMotionTrust, undefined);
    assert.equal(boards[0].initial, false);

    assert.equal(app.publishCoopCollectables(false), true);
    assert.equal(boards[1].fruitMotionTrust, true);
    assert.equal(boards[1].fruitMotionSeed, undefined);
  });

  it("COLLECTABLES receive: runtime keeps trust flags; does not force initial", async () => {
    const MultiplayerApp = loadModApp();
    const applied = [];
    global.MultiplayerGsm.applyCollectables = function (payload) {
      applied.push(Object.assign({}, payload));
      return true;
    };
    global.MultiplayerGsm.collectablesFingerprint = function () {
      return "x";
    };
    global.MultiplayerGsm.gameInstance = function () {
      return null;
    };

    const Client = global.MultiplayerClient;
    const origConnect = Client.prototype.connect;
    Client.prototype.connect = function () {
      this.connected = true;
      this.clientId = "peer";
      return Promise.resolve();
    };
    let app;
    try {
      app = new MultiplayerApp();
      app.ui = {
        mountHud: function () {},
        updateHud: function () {},
        updateColorIcon: function () {},
        renderRoster: function () {},
      };
      app.ensureFocusCanvas = function () {};
      app.applyControlLocks = function () {};
      app.updateStatusIndicator = function () {};
      // connect() schedules a 300ms lobby menu call — keep it off document
      app.ensureLobbyMatchMenusInteractive = function () {};
      await app.connect({});
      app._coopAuthority = "native-relay-v1";
      app.coop.applySession({
        authority: "native-relay-v1",
        generation: 3,
        boardReady: true,
        slots: [],
      });
      app.coop.generation = 3;
      app.coop.boardRevision = 0;
      app.coopSession.bindGeneration(3, "native-relay-v1", false);
      app.coopSession.enterSeating(3, "native-relay-v1");
      app.coopSession.markSeated();
      app.coopNative = { applyCollectables: function () {} };
      app._applyInitialCollectablesWithRetry = function (payload) {
        applied.push(Object.assign({}, payload, { _viaRetry: true }));
        return true;
      };

      app.client.emit(Protocol.TYPES.COLLECTABLES_DELTA, {
        generation: 3,
        revision: 1,
        rev: 1,
        initial: true,
        fruitMotionSeed: true,
        apples: [{ x: 2, y: 2, type: 0, he: { x: 0.5, y: 0 } }],
        clientId: "owner",
      });
      assert.ok(applied.length >= 1);
      const initialPayload = applied[0];
      assert.equal(initialPayload.initial, true);
      assert.equal(initialPayload.exactBoard, true);
      assert.equal(initialPayload.fruitMotionSeed, true);

      applied.length = 0;
      app.client.emit(Protocol.TYPES.COLLECTABLES_DELTA, {
        generation: 3,
        revision: 2,
        rev: 2,
        initial: false,
        fruitMotionTrust: true,
        apples: [{ x: 9, y: 9, type: 0, he: { x: -0.5, y: 0.5 } }],
        clientId: "owner",
      });
      assert.equal(applied.length, 1);
      assert.notEqual(applied[0].initial, true);
      assert.equal(applied[0].exactBoard, true);
      assert.equal(applied[0].fruitMotionTrust, true);
      assert.deepEqual(applied[0].apples[0].he, { x: -0.5, y: 0.5 });
    } finally {
      Client.prototype.connect = origConnect;
      try {
        if (app && typeof app.disconnect === "function") app.disconnect();
      } catch (eDisc) { /* ignore */ }
    }
  });
});
