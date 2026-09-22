"use strict";

/**
 * Evidence: co-op start must not auto-crawl idle peers when the shared timer
 * arms (peer first-move). That forced RIGHT + playing=true caused lag catch-up
 * ticks to kill snakes before local input.
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
  require(path.join(ROOT, "src/shared/colors.js"));
  require(p);
  return win.MultiplayerGsm;
}

function loadNative(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/native.js"));
  delete require.cache[p];
  delete win.__mpCoopOnTickInstalled;
  delete win.__mpCoopRenderInstalled;
  require(p);
  return win.CoopNative;
}

function loadApp(win) {
  const scripts = [
    "src/shared/protocol.js",
    "src/runtime/bridge.js",
    "src/session/ready.js",
    "src/race/scoreboard.js",
    "src/coop/state.js",
    "src/coop/session.js",
    "src/net/client.js",
    "src/ui/settingsTab.js",
    "src/mod.js",
  ];
  for (const rel of scripts) {
    const p = require.resolve(path.join(ROOT, rel));
    delete require.cache[p];
    require(p);
  }
  return win.MultiplayerApp;
}

describe("coop start lag / idle peer crawl", () => {
  let win;
  let Gsm;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
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

  it("applyCoopSpawnOffset clears stale facing and keeps TimeKeeper stopped", () => {
    const g = {
      oa: {
        ka: [
          { x: 8, y: 7 },
          { x: 7, y: 7 },
          { x: 6, y: 7 },
        ],
        direction: "RIGHT",
        dir: "RIGHT",
        Ca: "RIGHT",
        Ga: "RIGHT",
        oa: { width: 17, height: 15 },
      },
      Ca: { Aa: null, wa: [] },
      wa: { ka: [], oa: { oa: { width: 17, height: 15 } } },
      nj: false,
    };
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = { playing: true, _dead: false };

    assert.equal(
      Gsm.applyCoopSpawnOffset(-1, { slot: 0, x: 8, y: 6, dir: "RIGHT" }),
      true
    );
    assert.equal(g.oa.direction, "NONE", "stale Play facing parked as NONE");
    assert.equal(g.oa.dir, "NONE");
    assert.equal(g.oa.Ca, "RIGHT", "face Ca kept");
    assert.equal(g.oa.Ga, "NONE", "pending Ga parked");
    assert.equal(win.timeKeeper.playing, false, "clock stays off until local move");
  });

  it("armCoopRunTimer does not force idle peer to crawl RIGHT", () => {
    const MultiplayerApp = loadApp(win);
    const g = {
      oa: {
        ka: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
          { x: 3, y: 5 },
        ],
        direction: null,
        oa: { width: 17, height: 15 },
      },
      Ca: { Aa: new Map(), wa: [] },
      wa: { ka: [], oa: { oa: { width: 17, height: 15 } } },
      nj: false,
    };
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = {
      playing: false,
      _dead: false,
      start: function () {
        this.playing = true;
      },
    };

    const app = new MultiplayerApp();
    app.ui = { updateHud: function () {}, mountHud: function () {} };
    app.client = {
      connected: true,
      me: function () {
        return { role: "player", clientId: "idle" };
      },
      roster: { mode: "coop", sessionActive: true },
    };
    app._coopSessionActive = true;
    app._coopAuthority = "native-relay-v1";
    app._coopSpawnPose = { x: 5, y: 5, dir: "RIGHT", boardWidth: 17, boardHeight: 15 };
    app._coopPlayerMoved = false;

    app.armCoopRunTimer(Date.now() - 500);

    assert.equal(app._coopTimerArmed, true);
    assert.equal(win.timeKeeper.playing, true, "HUD/clock may arm");
    assert.equal(
      app._coopPlayerMoved,
      false,
      "idle peer must not be marked moved"
    );
    assert.equal(
      g.oa.direction,
      null,
      "must not applyCoopStartMoving on shared timer"
    );
    assert.equal(g.oa.dir == null || g.oa.dir === null, true);
  });

  it("killLocalOnRemote skips during start grace window", () => {
    const g = {
      oa: {
        ka: [{ x: 5, y: 5 }],
        direction: "RIGHT",
        oa: { width: 17, height: 15 },
      },
      nj: false,
      die: function () {
        this.nj = true;
      },
    };
    win.__remixGame = g;
    win.__mpGame = g;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopMyId = "me";
    win.__mpCoopRemotes = {
      other: {
        clientId: "other",
        body: [
          { x: 6, y: 5 },
          { x: 7, y: 5 },
        ],
        alive: true,
      },
    };
    win.__mpCoopIgnoreStartUntil = Date.now() + 5000;

    assert.equal(typeof win.__mpCoopOnTick, "function");
    win.__mpCoopOnTick(g);
    assert.equal(g.nj, false, "grace blocks friendly kill");

    win.__mpCoopIgnoreStartUntil = 0;
    win.__mpCoopOnTick(g);
    assert.equal(g.nj, true, "after grace, predicted head into peer dies");
  });

  it("local applyCoopStartMoving ends grace and starts clock", () => {
    const g = {
      oa: { ka: [{ x: 5, y: 5 }] },
    };
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = { playing: false, _dead: false };
    win.__mpCoopIgnoreStartUntil = Date.now() + 10000;

    assert.equal(Gsm.applyCoopStartMoving("UP"), true);
    assert.equal(g.oa.direction, "UP");
    assert.equal(win.__mpCoopIgnoreStartUntil, 0);
    assert.equal(win.timeKeeper.playing, true);
  });
});
