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
});
