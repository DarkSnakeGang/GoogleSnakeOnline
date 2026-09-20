"use strict";

/**
 * Server-auth co-op Reset must soft-rebind STATE, not run native reset / kill.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

describe("coop soft reset under server-auth", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpCoopServerAuth = true;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpCoopSpectator = false;
    let nativeReset = 0;
    win.__mpGame = {
      reset: function () {
        nativeReset++;
      },
      oa: { ka: [{ x: 1, y: 1 }], direction: "RIGHT" },
    };
    win.__remixGame = win.__mpGame;
    win.__mpNativeResetCount = function () {
      return nativeReset;
    };
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/native.js"))];
    // Minimal stubs so native.js loads
    win.MultiplayerGsm = win.MultiplayerGsm || {};
    require(path.join(ROOT, "src/coop/native.js"));
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("wrapGameReset skips native reset and calls soft hook", () => {
    let soft = 0;
    win.__mpCoopOnLocalReset = function () {
      soft++;
    };
    // Force wrap via tick hook path: call internal by constructing through onTick
    const game = win.__mpGame;
    // installCoopTickHook already ran; trigger wrap by simulating onTick enter
    assert.equal(typeof win.__mpCoopOnTick, "function");
    win.__mpCoopOnTick(game);
    assert.equal(game.__mpCoopResetWrapped, true);
    game.reset();
    assert.equal(soft, 1, "soft rebind hook fired");
    assert.equal(win.__mpNativeResetCount(), 0, "native reset must not run");
  });

  it("auth overlay uses native tile origin — does not paint floor/apples", () => {
    win.__mpCoopLastState = {
      width: 17,
      height: 15,
      ended: false,
      snakes: [],
      fruit: [{ x: 3, y: 3, type: 0 }],
    };
    win.__mpGame.ka = { ka: 20 };
    const fills = [];
    const arcs = [];
    const canvas = { width: 800, height: 600 };
    const ctx = {
      canvas: canvas,
      save: function () {},
      restore: function () {},
      fillRect: function (x, y, w, h) {
        fills.push({ x: x, y: y, w: w, h: h });
      },
      beginPath: function () {},
      arc: function (cx, cy) {
        arcs.push({ cx: cx, cy: cy });
      },
      fill: function () {},
    };
    const renderer = { ka: ctx, wb: win.__mpGame };
    assert.equal(typeof win.__mpCoopDrawAuthBoard, "function");
    win.__mpCoopDrawAuthBoard(renderer);
    const layout = win.__mpCoopAuthLayout;
    assert.ok(layout, "layout cached");
    assert.equal(layout.cell, 20);
    assert.equal(layout.ox, 0);
    assert.equal(layout.oy, 0);
    // Must not cover the canvas or redraw apples — native owns those
    assert.equal(fills.length, 0, "no manual floor fill");
    assert.equal(arcs.length, 0, "no manual apple arcs");
  });

  it("native-relay Reset invokes wipe hook and does not call orig when hook returns true", () => {
    win.__mpCoopServerAuth = false;
    win.__mpCoopAuthority = "native-relay-v1";
    win.__mpCoopSession = true;
    win.__mpGame.__mpCoopResetWrapped = false;
    let wipe = 0;
    let nativeReset = 0;
    win.__mpGame.reset = function () {
      nativeReset++;
    };
    win.__mpCoopOnLocalReset = function () {
      wipe++;
      return true;
    };
    win.__mpCoopOnTick(win.__mpGame);
    assert.equal(win.__mpGame.__mpCoopResetWrapped, true);
    win.__mpGame.reset();
    assert.equal(wipe, 1, "native wipe hook fired");
    assert.equal(nativeReset, 0, "orig reset swallowed when hook returns true");
  });
});

describe("coop ensureCoopServerAuthBoard latch", () => {
  function loadApp(win) {
    global.window = win;
    global.document = win.document;
    global.HTMLElement = win.HTMLElement;
    global.requestAnimationFrame = function (fn) {
      return setTimeout(fn, 0);
    };
    global.cancelAnimationFrame = function (id) {
      clearTimeout(id);
    };
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
    return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
  }

  it("does not re-latch __mpCoopSession when _coopAuthority is null", () => {
    const win = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://googlesnakemods.com/v/current",
    }).window;
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    app._coopAuthority = null;
    app._coopServerAuth = false;
    win.__mpCoopSession = false;
    win.__mpCoopInject = false;
    const ok = app.ensureCoopServerAuthBoard();
    assert.equal(ok, false);
    assert.equal(win.__mpCoopSession, false, "must not re-latch after ALL_APPLES");
    assert.equal(app._coopServerAuth, false);
  });

  it("resetNativeCoopRun clears scores, timer epoch, and remotes", () => {
    const win = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://googlesnakemods.com/v/current",
    }).window;
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    app._coopTimerStartedAtMs = 12345;
    app._coopTimerArmed = true;
    app._coopFinalTimeMs = 999;
    app._coopScores = { a: 52, b: 0 };
    app._coopTotal = 52;
    app._coopEndReason = "all_apples";
    app._coopWon = true;
    win.__mpCoopRemotes = { peer: { score: 12 } };
    win.__mpCoopLastState = { seq: 9 };
    win.__mpGame = {
      nj: true,
      Sh: 52,
      Oh: 52,
      oa: { ka: [], grow: 0 },
      wa: { ka: [{ pos: { x: 1, y: 1 } }] },
      Ca: { Aa: new Map(), wa: [[0]] },
    };
    win.__remixGame = win.__mpGame;
    win.timeKeeper = {
      playing: true,
      _lastScore: 52,
      _lastTimeMs: 1000,
      __mpCoopStartedAtMs: 1,
    };
    app.resetNativeCoopRun({});
    assert.equal(app._coopTimerStartedAtMs, null);
    assert.equal(app._coopTimerArmed, false);
    assert.equal(app._coopFinalTimeMs, null);
    assert.deepEqual(app._coopScores, {});
    assert.equal(app._coopTotal, 0);
    assert.equal(app._coopEndReason, null);
    assert.equal(app._coopWon, false);
    assert.equal(win.__mpCoopLastState, null);
    assert.equal(Object.keys(win.__mpCoopRemotes).length, 0);
    assert.equal(win.__mpGame.Sh, 0);
    assert.equal(win.timeKeeper.playing, false);
  });
});
