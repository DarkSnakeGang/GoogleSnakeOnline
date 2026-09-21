"use strict";

/**
 * Sokoban boxes: are mid-match pushes synced like fruit, or only initial seed?
 * Evidence for scrape/apply move, publish-on-fingerprint, and tick publish gap.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

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
  return global.MultiplayerApp;
}

function makeSokoGame(W, H) {
  return {
    oa: {
      ka: [
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      oa: { width: W, height: H },
    },
    wa: {
      ka: [],
      oa: { oa: { width: W, height: H } },
    },
    Ca: { Aa: new Map(), wa: [] },
    Ba: { keys: [] },
    Aa: {
      oa: [
        {
          pos: {
            x: 4,
            y: 4,
            clone: function () {
              return { x: this.x, y: this.y };
            },
          },
        },
      ],
      d_: [
        {
          pos: {
            x: 8,
            y: 8,
            clone: function () {
              return { x: this.x, y: this.y };
            },
          },
        },
      ],
    },
    settings: {},
  };
}

describe("coop sokoban box mid-match sync", () => {
  let win;
  let Gsm;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopPlaySettings = { count: 0 };
    win.ModeRegistry = {
      getCurrentModeKey: function () {
        return "sokoban";
      },
    };
    Gsm = loadGsm(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("runtime applyBoardEntities moves an existing box to the payload cell", () => {
    const peer = makeSokoGame(12, 10);
    peer.Aa.oa[0].pos.x = 4;
    peer.Aa.oa[0].pos.y = 4;
    win.__remixGame = peer;
    win.__mpGame = peer;

    assert.equal(
      Gsm.applyBoardEntities({
        boxes: [{ x: 6, y: 5 }],
        goals: [{ x: 8, y: 8 }],
        keys: [],
        width: 12,
        height: 10,
      }),
      true
    );
    assert.equal(peer.Aa.oa.length, 1);
    assert.equal(peer.Aa.oa[0].pos.x, 6);
    assert.equal(peer.Aa.oa[0].pos.y, 5);
  });

  it("applyCollectables with empty apples still applies moved boxes", () => {
    const peer = makeSokoGame(12, 10);
    peer.Aa.oa[0].pos.x = 3;
    peer.Aa.oa[0].pos.y = 3;
    win.__remixGame = peer;
    win.__mpGame = peer;

    // Sokoban boards ship apples: [] — apply must not bail before entities
    assert.equal(
      Gsm.applyCollectables({
        apples: [],
        boxes: [{ x: 7, y: 2 }],
        goals: [{ x: 8, y: 8 }],
        exactBoard: true,
      }),
      true
    );
    assert.equal(peer.Aa.oa[0].pos.x, 7);
    assert.equal(peer.Aa.oa[0].pos.y, 2);
  });

  it("scrape after local push → fingerprint change → peer apply matches", () => {
    const local = makeSokoGame(12, 10);
    win.__remixGame = local;
    win.__mpGame = local;

    const before = Gsm.scrapeCollectables({ includeEntities: true });
    assert.equal(before.boxes[0].x, 4);
    assert.equal(before.boxes[0].y, 4);

    // Simulate native push
    local.Aa.oa[0].pos.x = 5;
    local.Aa.oa[0].pos.y = 4;

    const after = Gsm.scrapeCollectables({ includeEntities: true });
    assert.notEqual(
      Gsm.collectablesFingerprint(before),
      Gsm.collectablesFingerprint(after),
      "box push must change collectables fingerprint"
    );
    assert.equal(after.boxes[0].x, 5);

    const peer = makeSokoGame(12, 10);
    peer.Aa.oa[0].pos.x = 4;
    peer.Aa.oa[0].pos.y = 4;
    win.__remixGame = peer;
    win.__mpGame = peer;
    assert.equal(
      Gsm.applyCollectables({
        apples: after.apples || [],
        boxes: after.boxes,
        goals: after.goals,
        exactBoard: true,
      }),
      true
    );
    assert.equal(peer.Aa.oa[0].pos.x, 5);
    assert.equal(peer.Aa.oa[0].pos.y, 4);
  });
});

describe("coop sokoban box publish wiring", () => {
  afterEach(() => {
    stubDom();
  });

  it("publishCoopCollectables republishes when box xy changes", () => {
    const MultiplayerApp = loadModApp();
    const boards = [];
    let boxX = 4;
    global.MultiplayerGsm.isCoopFruitMotionMode = function () {
      return false;
    };
    global.MultiplayerGsm.isKeyOrSokobanMode = function () {
      return true;
    };
    global.MultiplayerGsm.effectiveModeKey = function () {
      return "sokoban";
    };
    global.MultiplayerGsm.scrapeCollectables = function () {
      return {
        apples: [],
        collectables: [],
        boxes: [{ x: boxX, y: 4 }],
        goals: [{ x: 8, y: 8 }],
      };
    };
    global.MultiplayerGsm.collectablesFingerprint = function (cols) {
      const b = cols.boxes && cols.boxes[0];
      return "box:" + (b ? b.x + "," + b.y : "");
    };

    const app = new MultiplayerApp();
    app._coopAuthority = "native-relay-v1";
    app._coopSessionActive = true;
    app.coop.boardReady = true;
    app.coop.generation = 1;
    app.coopSession.bindGeneration(1, "native-relay-v1", false);
    app.coopSession.enterSeating(1, "native-relay-v1");
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

    assert.equal(app.publishCoopCollectables(false), true);
    assert.equal(boards[0].boxes[0].x, 4);

    // Unchanged → skipped
    assert.equal(app.publishCoopCollectables(false), false);

    // Local push
    boxX = 5;
    assert.equal(app.publishCoopCollectables(false), true);
    assert.equal(boards[1].boxes[0].x, 5);
  });

  it("evidence: afterTick publishes snake state, not collectables (box push gap)", () => {
    const MultiplayerApp = loadModApp();
    const app = new MultiplayerApp();
    let stateCalls = 0;
    let colsCalls = 0;
    app._coopAuthority = "native-relay-v1";
    app.publishCoopState = function () {
      stateCalls++;
    };
    app.publishCoopCollectables = function () {
      colsCalls++;
      return true;
    };
    app.client = {
      connected: true,
      roster: { mode: "coop", sessionActive: true },
    };
    app.installNativeTickNetPublish();
    assert.equal(typeof global.__mpCoopAfterTick, "function");
    global.__mpCoopAfterTick();
    assert.equal(stateCalls, 1, "tick net publishes pose");
    assert.equal(
      colsCalls,
      0,
      "tick net does NOT publish collectables — box pushes stay local until eat/force"
    );
  });
});
