"use strict";

/**
 * Plan 3.5: native-relay default path — live bake gate, spawn dim check,
 * initial fruit exact apply (no freePos top-up).
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
  require(p);
  return win.MultiplayerGsm;
}

describe("plan 3.5 bake + initial fruit", () => {
  let win;
  let Gsm;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    win.__mpCoopSession = true;
    win.__mpCoopServerAuth = false;
    win.__mpCoopInject = true;
    Gsm = loadGsm(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function gameAt(w, h) {
    const g = {
      nj: false,
      oa: {
        ka: [{ x: 1, y: 1 }],
        oa: { width: w, height: h },
        direction: null,
      },
      wa: {
        ka: [],
        oa: { oa: { width: w, height: h } },
      },
      Ca: { Aa: new Map(), wa: [] },
    };
    for (let y = 0; y < h; y++) {
      g.Ca.wa[y] = [];
      for (let x = 0; x < w; x++) g.Ca.wa[y][x] = 0;
    }
    win.__mpGame = g;
    win.__remixGame = g;
    return g;
  }

  it("liveBoardMatchesSettings rejects Standard bake vs Small settings", () => {
    gameAt(17, 15);
    assert.equal(
      Gsm.liveBoardMatchesSettings({ size: 1 }),
      false,
      "17x15 must not match Small"
    );
    gameAt(10, 9);
    assert.equal(Gsm.liveBoardMatchesSettings({ size: 1 }), true);
    assert.equal(
      Gsm.liveBoardMatchesSettings({ boardWidth: 10, boardHeight: 9 }),
      true
    );
  });

  it("applyCoopSpawnOffset soft-seats via oy when slot dims disagree with live", () => {
    gameAt(17, 15);
    const ok = Gsm.applyCoopSpawnOffset(1, {
      slot: 0,
      x: 5,
      y: 3,
      dir: "RIGHT",
      boardWidth: 10,
      boardHeight: 9,
    });
    assert.equal(ok, true, "must still seat on live grid");
    const head = win.__mpGame.oa.ka[0];
    // oy=1 on 17x15 → centerY+1 = 7+1 = 8 (not Small absolute 5,3)
    assert.equal(head.x, 8);
    assert.equal(head.y, 8);
  });

  it("applyCoopSpawnOffset accepts absolute seat when dims match", () => {
    gameAt(10, 9);
    const ok = Gsm.applyCoopSpawnOffset(1, {
      slot: 0,
      x: 5,
      y: 3,
      dir: "RIGHT",
      boardWidth: 10,
      boardHeight: 9,
    });
    assert.equal(ok, true);
    assert.equal(win.__mpGame.oa.ka[0].x, 5);
    assert.equal(win.__mpGame.oa.ka[0].y, 3);
  });

  it("initial relay apply does not freePos top-up fruit count", () => {
    const g = gameAt(10, 9);
    // Pretend Count wants many apples — without initial, top-up would invent
    win.__mpCoopSession = true;
    win.__mpCoopServerAuth = false;
    // Seed one apple already on the board
    g.wa.ka = [
      {
        pos: {
          x: 2,
          y: 2,
          clone: function () {
            return { x: this.x, y: this.y, clone: this.clone };
          },
        },
        type: 0,
        nba: new Set(),
      },
    ];
    const before = g.wa.ka.length;
    const ok = Gsm.applyCollectables({
      apples: [{ x: 4, y: 4, type: 0 }],
      initial: true,
      width: 10,
      height: 9,
    });
    assert.equal(ok, true);
    assert.equal(
      g.wa.ka.length,
      1,
      "initial board must stay exact — no ensureCoopFruitCount top-up"
    );
    assert.equal(g.wa.ka[0].pos.x, 4);
    assert.equal(g.wa.ka[0].pos.y, 4);
    assert.equal(before, 1);
  });

  it("forceEngineSizeForPlay writes settings.Sa and settings.Aa (Ma copies Sa→Aa)", () => {
    const g = gameAt(17, 15);
    g.settings = { Sa: 0, Aa: 0 };
    win.__mpGame = g;
    assert.equal(typeof Gsm.forceEngineSizeForPlay, "function");
    assert.equal(Gsm.forceEngineSizeForPlay(1), true);
    assert.equal(g.settings.Sa, 1, "menu size Sa must be set");
    assert.equal(g.settings.Aa, 1, "bake size Aa must be set");
    Gsm.forceEngineSizeForPlay(2);
    assert.equal(g.settings.Sa, 2);
    assert.equal(g.settings.Aa, 2);
  });

  it("forceEngineMatchFieldsForPlay mirrors count/speed dual fields", () => {
    const g = gameAt(10, 9);
    g.settings = { Sa: 0, Aa: 0, Ca: 0, ka: 0, Oa: 0, yb: 0 };
    win.__mpGame = g;
    Gsm.forceEngineMatchFieldsForPlay({ size: 1, count: 2, speed: 1 });
    assert.equal(g.settings.Sa, 1);
    assert.equal(g.settings.Aa, 1);
    assert.equal(g.settings.Ca, 2);
    assert.equal(g.settings.ka, 2);
    assert.equal(g.settings.Oa, 1);
    assert.equal(g.settings.yb, 1);
  });

  it("applyCollectables seeds fruit host when initial relay finds empty/missing wa.ka", () => {
    const g = gameAt(10, 9);
    delete g.wa.ka;
    assert.equal(
      Gsm.applyCollectables({
        apples: [{ x: 1, y: 1, type: 0 }],
        initial: true,
      }),
      true
    );
    assert.equal(g.wa.ka.length, 1);
    assert.equal(g.wa.ka[0].pos.x, 1);
    // Empty pre-Play host — ensureFruitHostTemplate seeds Od so initial can land
    g.wa.ka = [];
    assert.equal(
      Gsm.applyCollectables({
        apples: [{ x: 2, y: 2, type: 0 }],
        initial: true,
      }),
      true
    );
    assert.equal(g.wa.ka.length, 1);
    assert.equal(g.wa.ka[0].pos.x, 2);
  });

  it("ensureCoopFruitCount plants Count fruit without native freePos", () => {
    const g = gameAt(10, 9);
    g.wa.ka = [];
    assert.equal(Gsm.ensureCoopFruitCount(g), true);
    assert.ok(g.wa.ka.length >= 1);
    assert.ok(g.wa.ka[0].pos && typeof g.wa.ka[0].pos.clone === "function");
  });

  it("classicInitialFruit covers 1a/3a/5a/10a/Tally on Small", () => {
    // Small 10×9: aT(0,0)=(7,4)
    assert.deepEqual(Gsm.classicInitialFruit(10, 9, 0), [{ x: 7, y: 4 }]);
    assert.equal(Gsm.classicInitialFruit(10, 9, 1).length, 3);
    assert.equal(Gsm.classicInitialFruit(10, 9, 2).length, 5);
    assert.equal(Gsm.classicInitialFruit(10, 9, 6).length, 5);
    assert.equal(Gsm.classicInitialFruit(10, 9, 3).length, 5);
  });

  it("plantClassicInitialFruit places aT and admin apple type", () => {
    const g = gameAt(10, 9);
    g.wa.ka = [];
    win.__mpCoopPlaySettings = { size: 1, count: 0, apple: 3 };
    assert.equal(Gsm.plantClassicInitialFruit(g), true);
    assert.equal(g.wa.ka.length, 1);
    assert.equal(g.wa.ka[0].pos.x, 7);
    assert.equal(g.wa.ka[0].pos.y, 4);
    assert.equal(g.wa.ka[0].type, 3);
  });

  it("plantClassicInitialFruit tally assigns sequenceNumbers", () => {
    const g = gameAt(10, 9);
    g.wa.ka = [];
    win.__mpCoopPlaySettings = { size: 1, count: 6, apple: 0 };
    assert.equal(Gsm.plantClassicInitialFruit(g), true);
    assert.equal(g.wa.ka.length, 5);
    assert.equal(g.wa.ka[0].sequenceNumber, 1);
    assert.equal(g.wa.ka[4].sequenceNumber, 5);
  });

  it("sanitizePostimgFruitUrls rewrites saved CustomPoison postimg paths", () => {
    win.pudding_settings = {
      CustomPoisonNormal: "https://i.postimg.cc/abc/poison-ghost.png",
      CustomPoisonPixel: "https://i.postimg.cc/xyz/poison-ghost-px.png",
      CustomFruitNormal: "data:image/png;base64,AAA",
    };
    win.ghost_skull = { src: "data:image/png;base64,GHOST" };
    win.px_ghost_skull = { src: "data:image/png;base64,PXGHOST" };
    const n = Gsm.sanitizePostimgFruitUrls();
    assert.ok(n > 0);
    assert.equal(
      win.pudding_settings.CustomPoisonNormal,
      "data:image/png;base64,GHOST"
    );
    assert.equal(
      win.pudding_settings.CustomPoisonPixel,
      "data:image/png;base64,PXGHOST"
    );
    assert.equal(win.pudding_settings.CustomFruitNormal, "data:image/png;base64,AAA");
  });
});
