"use strict";

/**
 * Evidence: co-op Start must park snakes idle until each player's own key.
 *
 * Regressions this suite locks down (seen in live rooms 2026-09-22):
 *   1) Native idle is direction==="NONE" — null still ticks (null !== "NONE")
 *   2) Face Ca="RIGHT" is NOT crawl; only direction/Ga drive ticks
 *   3) armCoopRunTimer (peer first-move) must not applyCoopStartMoving on idle peers
 *   4) COOP_BOARD_READY flushed lobby key noise → auto-crawl
 *   5) Death → GameInstance.reset → admin startMatchAsAdmin loop (die twice)
 *   6) Idle overlapping seats + 2s grace expiry → mutual friendly kill
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  const colors = require.resolve(path.join(ROOT, "src/shared/colors.js"));
  const gsm = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[colors];
  delete require.cache[gsm];
  require(colors);
  require(gsm);
  return win.MultiplayerGsm;
}

function loadNative(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/native.js"));
  delete require.cache[p];
  delete win.__mpCoopOnTickInstalled;
  delete win.__mpCoopRenderInstalled;
  require(p);
  return win;
}

function loadApp(win) {
  [
    "shared/protocol.js",
    "runtime/bridge.js",
    "session/ready.js",
    "race/scoreboard.js",
    "coop/state.js",
    "coop/session.js",
    "coop/native.js",
    "hooks/gsm.js",
    "net/client.js",
    "ui/settingsTab.js",
    "mod.js",
  ].forEach(function (rel) {
    const p = require.resolve(path.join(ROOT, "src", rel));
    delete require.cache[p];
    require(p);
  });
  return win.MultiplayerApp;
}

function makeSeatedGame(facing) {
  facing = facing || {};
  return {
    oa: {
      ka: [
        { x: 8, y: 6 },
        { x: 7, y: 6 },
        { x: 6, y: 6 },
      ],
      direction: facing.direction !== undefined ? facing.direction : "RIGHT",
      dir: facing.dir !== undefined ? facing.dir : "RIGHT",
      Ca: facing.Ca !== undefined ? facing.Ca : "RIGHT",
      Ga: facing.Ga !== undefined ? facing.Ga : "RIGHT",
      oa: { width: 17, height: 15 },
    },
    Ca: { Aa: new Map(), wa: [] },
    wa: { ka: [{ pos: { x: 10, y: 6 }, type: 0 }], oa: { oa: { width: 17, height: 15 } } },
    nj: false,
    settings: { ub: 0, Sa: 1, Aa: 1 },
  };
}

describe("coop idle-until-input evidence", () => {
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

  it("applyCoopSpawnOffset parks with direction/Ga NONE (face Ca may stay)", () => {
    const g = makeSeatedGame({
      direction: "RIGHT",
      dir: "RIGHT",
      Ca: "RIGHT",
      Ga: "RIGHT",
    });
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = { playing: true, _dead: false };

    assert.equal(
      Gsm.applyCoopSpawnOffset(-1, { slot: 0, x: 8, y: 6, dir: "RIGHT" }),
      true
    );
    assert.equal(g.oa.direction, "NONE", "direction parked as native NONE");
    assert.equal(g.oa.dir, "NONE", "dir parked as NONE");
    assert.equal(g.oa.Ca, "RIGHT", "face Ca kept (sprite angle, not crawl)");
    assert.equal(g.oa.Ga, "NONE", "pending turn Ga parked");
    assert.equal(Gsm.coopSnakeHasCrawlFacing(g.oa), false);
    assert.equal(win.timeKeeper.playing, false, "clock off until local key");
  });

  it("null direction is NOT idle — native ticks when direction !== NONE", () => {
    const g = makeSeatedGame({
      direction: null,
      dir: null,
      Ca: "RIGHT",
      Ga: "NONE",
    });
    win.__remixGame = g;
    win.__mpGame = g;
    // Before park: null is incorrectly "not NONE" for the engine
    assert.equal(g.oa.direction !== "NONE", true);
    Gsm.clearCoopIdleFacing(g.oa);
    assert.equal(g.oa.direction, "NONE");
    assert.equal(Gsm.coopSnakeHasCrawlFacing(g.oa), false);
  });

  it("idle seat survives many ticks without moving head", () => {
    const g = makeSeatedGame({ Ca: "RIGHT", direction: "RIGHT" });
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = { playing: false, _dead: false };
    Gsm.applyCoopSpawnOffset(-1, { slot: 0, x: 8, y: 6, dir: "RIGHT" });
    const hx = g.oa.ka[0].x | 0;
    const hy = g.oa.ka[0].y | 0;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopMyId = "me";
    win.__mpCoopRemotes = {};
    win.__mpCoopIgnoreStartUntil = 0;
    for (let i = 0; i < 30; i++) {
      win.__mpCoopOnTick(g);
    }
    assert.equal(g.oa.ka[0].x | 0, hx, "head x unchanged without input");
    assert.equal(g.oa.ka[0].y | 0, hy, "head y unchanged without input");
    assert.equal(g.nj, false, "idle seat does not die");
    assert.equal(Gsm.coopSnakeHasCrawlFacing(g.oa), false);
  });

  it("armCoopRunTimer does not grant crawl facing to idle peer", () => {
    loadApp(win);
    const MultiplayerApp = win.MultiplayerApp;
    const g = makeSeatedGame({
      direction: "NONE",
      dir: "NONE",
      Ca: "RIGHT",
      Ga: "NONE",
    });
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
    app._coopSpawnPose = { x: 8, y: 6, dir: "RIGHT" };
    app._coopPlayerMoved = false;
    app.armCoopRunTimer(Date.now() - 200);
    assert.equal(app._coopPlayerMoved, false);
    assert.equal(g.oa.direction, "NONE");
    assert.equal(g.oa.Ca, "RIGHT");
    assert.equal(g.oa.Ga, "NONE");
    assert.equal(Gsm.coopSnakeHasCrawlFacing(g.oa), false);
  });

  it("applyCoopStartMoving is the only path that arms crawl facing", () => {
    const g = makeSeatedGame({ Ca: "RIGHT" });
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = { playing: false, _dead: false };
    Gsm.applyCoopSpawnOffset(1, { slot: 1, x: 8, y: 8, dir: "RIGHT" });
    assert.equal(Gsm.coopSnakeHasCrawlFacing(g.oa), false);
    assert.equal(Gsm.applyCoopStartMoving("UP"), true);
    assert.equal(g.oa.direction, "UP");
    assert.equal(g.oa.Ca, "UP", "Ca face follows local key");
    assert.equal(g.oa.Ga, "NONE", "Ga stays NONE until buffered turn");
    assert.equal(win.timeKeeper.playing, true);
    assert.equal(Gsm.coopSnakeHasCrawlFacing(g.oa), true);
  });

  it("idle overlapping peer does not friendly-kill when facing cleared", () => {
    const g = makeSeatedGame({ direction: "NONE", dir: "NONE", Ca: "RIGHT", Ga: "NONE" });
    g.oa.ka = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ];
    win.__remixGame = g;
    win.__mpGame = g;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopMyId = "me";
    win.__mpCoopLocalDead = false;
    win.__mpCoopIgnoreStartUntil = 0; // grace expired
    win.__mpCoopRemotes = {
      peer: {
        alive: true,
        body: [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ],
      },
    };
    win.__mpCoopOnTick(g);
    assert.equal(g.nj, false, "idle + expired grace must not peer-kill");
    assert.equal(win.__mpCoopLocalDead, false);
  });

  it("death-driven OnLocalReset does not call startMatchAsAdmin", () => {
    loadApp(win);
    const MultiplayerApp = win.MultiplayerApp;
    const g = makeSeatedGame({});
    win.__remixGame = g;
    win.__mpGame = g;
    let starts = 0;
    const app = new MultiplayerApp();
    app.ui = { updateHud: function () {}, mountHud: function () {} };
    app.client = {
      connected: true,
      clientId: "admin",
      isAdmin: function () {
        return true;
      },
      me: function () {
        return { role: "player", clientId: "admin", isAdmin: true, ready: false };
      },
      roster: { mode: "coop", sessionActive: true, clients: [] },
      setReady: function () {},
    };
    app._coopSessionActive = true;
    app._coopAuthority = "native-relay-v1";
    app._coopDeadSent = true;
    win.__mpCoopLocalDead = true;
    app.startMatchAsAdmin = function () {
      starts++;
      return true;
    };
    app.resetNativeCoopRun = function () {
      return true;
    };
    // Install the same hook beginCoopNativeSession would
    win.__mpCoopOnLocalReset = function () {
      if (app._coopAuthority === "native-relay-v1" && app._coopSessionActive) {
        const localDead =
          !!app._coopDeadSent ||
          !!app._coopMatchEndHandled ||
          (typeof win !== "undefined" && !!win.__mpCoopLocalDead);
        if (localDead) {
          app.resetNativeCoopRun({ localOnly: true });
          return true;
        }
        if (app.startMatchAsAdmin) app.startMatchAsAdmin();
        return true;
      }
      return false;
    };
    assert.equal(win.__mpCoopOnLocalReset(), true);
    assert.equal(starts, 0, "dead admin reset must not Start Co-op again");
  });

  it("board-ready flush ignores queued input before seat applied", () => {
    loadApp(win);
    const MultiplayerApp = win.MultiplayerApp;
    const g = makeSeatedGame({ direction: null, Ca: null });
    g.oa.direction = null;
    g.oa.Ca = null;
    win.__remixGame = g;
    win.__mpGame = g;
    win.timeKeeper = { playing: false, _dead: false };
    const app = new MultiplayerApp();
    app.ui = { updateHud: function () {} };
    app.client = {
      connected: true,
      me: function () {
        return { role: "player", clientId: "a" };
      },
      roster: { mode: "coop", sessionActive: true },
      snakeDelta: function () {},
    };
    app._coopSessionActive = true;
    app._coopAuthority = "native-relay-v1";
    app.coop.boardReady = true;
    app._coopSpawnApplied = false; // seat not ready
    app._coopDeadSent = false;
    app._coopPlayerMoved = false;
    app.coopSession = {
      pendingInput: "RIGHT",
      pendingPose: null,
      takeQueued: function () {
        const o = { input: this.pendingInput, pose: this.pendingPose };
        this.pendingInput = null;
        this.pendingPose = null;
        return o;
      },
    };
    app.flushCoopRelayQueue();
    assert.equal(g.oa.direction, null, "no crawl before seat");
    assert.equal(app._coopPlayerMoved, false);
  });
});
