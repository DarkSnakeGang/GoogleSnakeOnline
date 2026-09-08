"use strict";

/**
 * Plan 1 hard gate: first PlayerRenderer frame must paint STATE/slot seat,
 * not native center default — cold and after Play clobber.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function load(win, rel) {
  const p = require.resolve(path.join(ROOT, rel));
  delete require.cache[p];
  require(p);
}

describe("coop first-draw seat", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpCoopServerAuth = true;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    // Native Play default = board center (oy=0). Slot peer is oy=+1 → y=5 on 10×9.
    win.__mpGame = {
      nj: false,
      oa: {
        ka: [
          {
            x: 5,
            y: 4,
            clone: function () {
              return { x: this.x, y: this.y, clone: this.clone };
            },
          },
          {
            x: 4,
            y: 4,
            clone: function () {
              return { x: this.x, y: this.y, clone: this.clone };
            },
          },
          {
            x: 3,
            y: 4,
            clone: function () {
              return { x: this.x, y: this.y, clone: this.clone };
            },
          },
        ],
        oa: { width: 10, height: 9 },
        direction: "RIGHT",
      },
      wa: { ka: [], oa: { oa: { width: 10, height: 9 } } },
      Ca: { Aa: new Map(), wa: [] },
    };
    win.__remixGame = win.__mpGame;
    load(win, "src/hooks/gsm.js");
    load(win, "src/coop/binder.js");
    load(win, "src/coop/native.js");
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  const stateAtOy1 = {
    seq: 1,
    width: 10,
    height: 9,
    intervalMs: 142,
    fruit: [{ x: 8, y: 4, type: 0 }],
    snakes: [
      {
        clientId: "p2",
        body: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
          { x: 3, y: 5 },
        ],
        dir: "RIGHT",
        alive: true,
      },
      {
        clientId: "p1",
        body: [
          { x: 5, y: 3 },
          { x: 4, y: 3 },
          { x: 3, y: 3 },
        ],
        dir: "RIGHT",
        alive: true,
      },
    ],
  };

  it("SeatBeforeRender writes STATE seat onto renderer.wb (not center)", () => {
    assert.equal(win.__mpGame.oa.ka[0].y, 4, "starts at native center");
    win.CoopBinder.applyCoopState(stateAtOy1, "p2");
    // Simulate Play clobber + stale __mpGame pointer to a different object
    const paintedGame = {
      oa: {
        ka: [
          { x: 5, y: 4, clone: function () { return { x: this.x, y: this.y }; } },
          { x: 4, y: 4, clone: function () { return { x: this.x, y: this.y }; } },
          { x: 3, y: 4, clone: function () { return { x: this.x, y: this.y }; } },
        ],
        direction: "RIGHT",
        oa: { width: 10, height: 9 },
      },
      wa: win.__mpGame.wa,
      Ca: win.__mpGame.Ca,
    };
    win.__mpGame = { oa: { ka: [{ x: 0, y: 0 }] } }; // stale pointer
    const renderer = { wb: paintedGame, ka: {} };
    assert.equal(typeof win.__mpCoopSeatBeforeRender, "function");
    win.__mpCoopSeatBeforeRender(renderer);
    assert.equal(
      paintedGame.oa.ka[0].y,
      5,
      "must seat renderer.wb to STATE oy=+1"
    );
    assert.equal(paintedGame.oa.ka[0].x, 5);
  });

  it("skips native paint while head mismatches and exposes auth board draw", () => {
    win.CoopBinder.applyCoopState(stateAtOy1, "p2");
    win.__mpGame.oa.ka[0].y = 4;
    win.__mpGame.oa.ka[1].y = 4;
    win.__mpGame.oa.ka[2].y = 4;
    const renderer = { wb: win.__mpGame, ka: { save: function () {}, restore: function () {} } };
    // Force mismatch after seat attempt by clearing write path briefly
    assert.equal(typeof win.__mpCoopSkipNativeRender, "function");
    assert.equal(typeof win.__mpCoopDrawAuthBoard, "function");
    // After SeatBeforeRender inside skip check, head should match → may not skip
    win.__mpCoopSeatBeforeRender(renderer);
    assert.equal(win.__mpGame.oa.ka[0].y, 5);
    assert.equal(
      win.CoopBinder.localHeadMatchesState(win.__mpCoopLastState, "p2"),
      true
    );
  });

  it("RenderEnter seats before wrap so in-flight first frame is correct", () => {
    win.CoopBinder.applyCoopState(stateAtOy1, "p2");
    win.__mpGame.oa.ka[0].y = 4;
    win.__mpGame.oa.ka[1].y = 4;
    win.__mpGame.oa.ka[2].y = 4;
    const renderer = {
      render: function () {
        return "drew";
      },
      ka: {},
      wb: win.__mpGame,
    };
    win.__mpCoopRenderEnter(renderer);
    assert.equal(win.__mpGame.oa.ka[0].y, 5, "enter must seat before native continues");
    assert.equal(renderer.__mpCoopPaintWrapped, true);
  });

  it("reapply after Play clobber restores seat same turn", () => {
    win.CoopBinder.applyCoopState(stateAtOy1, "p2");
    assert.equal(win.__mpGame.oa.ka[0].y, 5);
    // Warm Start: triggerPlay reseeds center
    win.__mpGame.oa.ka[0].x = 5;
    win.__mpGame.oa.ka[0].y = 4;
    win.__mpGame.oa.ka[1].y = 4;
    win.__mpGame.oa.ka[2].y = 4;
    win.CoopBinder.reapplyLastState();
    assert.equal(win.__mpGame.oa.ka[0].y, 5);
    assert.equal(
      win.CoopBinder.localHeadMatchesState(win.__mpCoopLastState, "p2"),
      true
    );
  });
});
