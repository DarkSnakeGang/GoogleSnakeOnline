"use strict";

/**
 * GSM-like DOM + game object harness for hook-dependent paths.
 * Does not need live googlesnakemods.com — mocks Remix/Pudding APIs.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  global.HTMLElement = win.HTMLElement;
  global.KeyboardEvent = win.KeyboardEvent;
  // Clear cached module so it binds to this window
  const modPath = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[modPath];
  const colorsPath = require.resolve(path.join(ROOT, "src/shared/colors.js"));
  delete require.cache[colorsPath];
  require(path.join(ROOT, "src/shared/colors.js"));
  return require(path.join(ROOT, "src/hooks/gsm.js"));
}

function makeDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="trophy"><div class="a"></div><div class="tuJOWd"></div><div class="a"></div></div>
    <div id="count"><div class="tuJOWd"></div><div class="b"></div></div>
    <div id="speed"><div class="c"></div><div class="tuJOWd"></div></div>
    <div id="size"><div class="tuJOWd"></div></div>
    <div id="color"><div></div><div></div><div class="tuJOWd"></div></div>
    <div id="apple"><div class="tuJOWd"></div><div></div></div>
    <div id="graphics"><div class="tuJOWd"></div><div></div></div>
    <div id="theme"><div class="tuJOWd"></div><div></div></div>
    <button jsname="NSjDf" aria-label="Play">Play</button>
    <button jsname="JwM0Ie" aria-label="Fullscreen">FS</button>
    <div jsname="iyH4Cb"></div>
    <canvas class="nEoGkc" width="400" height="400"></canvas>
  </body></html>`, { url: "https://googlesnakemods.com/v/current" });
  return dom.window;
}

describe("GSM hook harness", () => {
  let win;
  let Gsm;
  let selects;

  beforeEach(() => {
    win = makeDom();
    selects = [];
    win.puddingMenuSelect = function (id, index) {
      selects.push({ id, index });
      return true;
    };
    win.readGameSettingIndex = function (id) {
      const row = win.document.getElementById(id);
      if (!row) return 0;
      for (let i = 0; i < row.children.length; i++) {
        if ((row.children[i].className || "").includes("tuJOWd")) return i;
      }
      return 0;
    };
    win.pauseGame = 0;
    win.__remixGame = {
      Sh: 7,
      nj: false,
      oa: {
        ka: [
          { x: 3, y: 4 },
          { x: 2, y: 4 },
        ],
        direction: "RIGHT",
        Ta: 2,
      },
      wa: {
        ka: [{ pos: { x: 8, y: 9 }, type: 0 }],
        oa: { oa: { width: 17, height: 15 } },
      },
    };
    win.timeKeeper = {
      getCurrentSetting: function (id) {
        return win.readGameSettingIndex(id);
      },
      start: function () {},
      gotApple: function () {},
      gotAll: function () {},
      death: function () {},
    };
    Gsm = loadGsm(win);
  });

  it("snapshots and applies settings via puddingMenuSelect", () => {
    const snap = Gsm.snapshotSettings();
    assert.equal(snap.trophy, 1);
    assert.equal(snap.speed, 1);
    selects = [];
    Gsm.applySettings({ trophy: 2, count: 0, speed: 0, size: 0 });
    assert.ok(selects.some((s) => s.id === "trophy" && s.index === 2));
    assert.ok(selects.some((s) => s.id === "speed" && s.index === 0));
  });

  it("trophy apply updates CurrentModeNum for Remix mode predicates", () => {
    // Remix only assigns CurrentModeNum from its native `case "trophy":` handler,
    // which puddingMenuSelect bypasses. Stale value = Burger reads as inactive at
    // apple reset, so native Poison half-poisons the board on the first run.
    win.CurrentModeNum = 0;
    Gsm.applySettings({ trophy: 2 });
    assert.equal(win.CurrentModeNum, 2, "mode number follows the trophy row");

    // Non-trophy applies must not touch it
    Gsm.applySettings({ speed: 0 });
    assert.equal(win.CurrentModeNum, 2);
  });

  it("prepareNativePlay reconciles CurrentModeNum from the live trophy row", () => {
    // Settings restored from storage (or already matching a SETTINGS_SYNC) never
    // pass through selectMenu, so Start match must reconcile before Play.
    win.CurrentModeNum = 0;
    selects = [];
    Gsm.applySettings({ trophy: 1 }); // already selected in the DOM → no select
    assert.equal(selects.length, 0, "no menu write when the row already matches");
    Gsm.prepareNativePlay();
    assert.equal(win.CurrentModeNum, 1);
  });

  it("CurrentModeNum is not invented when Remix is absent", () => {
    delete win.CurrentModeNum;
    Gsm.applySettings({ trophy: 2 });
    Gsm.prepareNativePlay();
    assert.equal(typeof win.CurrentModeNum, "undefined");
  });

  it("scrapes board from __remixGame Chess-shaped fields", () => {
    const board = Gsm.scrapeBoard();
    assert.ok(board);
    assert.equal(board.body.length, 2);
    assert.equal(board.body[0].x, 3);
    assert.equal(board.apples[0].x, 8);
    assert.equal(board.score, 7);
    assert.equal(board.alive, true);
    assert.equal(board.width, 17);
  });

  it("scrapes cat lives + grace only for cat mode", () => {
    win.cat_lives = 3;
    win.CAT_MAX_LIVES = 9;
    win.cat_peaceful_ticks = 4;

    win.timeKeeper.mode = "classic";
    const plain = Gsm.scrapeBoard();
    assert.equal(plain.catLives, undefined, "no cat fields off cat mode");

    win.timeKeeper.mode = "cat";
    const board = Gsm.scrapeBoard();
    assert.equal(board.catLives, 3);
    assert.equal(board.catLivesMax, 9);
    assert.equal(board.catGrace, 4);

    // Grace is only carried while it is counting down
    win.cat_peaceful_ticks = 0;
    win.cat_lives = 0;
    const spent = Gsm.scrapeBoard();
    assert.equal(spent.catLives, 0);
    assert.equal(spent.catGrace, undefined);

    // Blended keys keep cat detection
    win.timeKeeper.mode = "burger+cat";
    win.cat_lives = 2;
    assert.equal(Gsm.scrapeBoard().catLives, 2);
  });

  it("scrapes slot badges only for ordinary fruit", () => {
    win.__remixGame.wa.ka = [
      { pos: { x: 1, y: 1 }, type: 0, slotMode: 26 },
      { pos: { x: 2, y: 2 }, type: 0, slotMode: 0 }, // mode 0 is a real badge
      { pos: { x: 3, y: 3 }, type: 0 },
      { pos: { x: 4, y: 4 }, type: 0, slotMode: 5, Oka: true }, // poison hazard
      { pos: { x: 5, y: 5 }, type: 9, slotMode: 5, isPiece: true }, // chess piece
    ];
    const apples = Gsm.scrapeBoard().apples;
    assert.equal(apples[0].slotMode, 26);
    assert.equal(apples[1].slotMode, 0, "mode 0 must survive the null check");
    assert.equal(apples[2].slotMode, undefined);
    assert.equal(apples[3].slotMode, undefined, "poison carries no badge");
    assert.equal(apples[4].slotMode, undefined, "chess pieces carry no badge");
  });

  it("scrapes bomb fruit zones from the cell zone list", () => {
    win.BOMB_FRUIT_ARM_TICKS = 4;
    // Native keeps zones per cell, so an eaten fruit leaves its zone behind
    win.__bombFruitZones = [
      { x: 3, y: 4, bombX1a: -1 },
      { x: 8, y: 9, bombX1a: 2 },
    ];

    win.timeKeeper.mode = "classic";
    assert.equal(Gsm.scrapeBoard().bombZones, undefined, "no zones off bomb mode");

    win.timeKeeper.mode = "bomb_fruit";
    const board = Gsm.scrapeBoard();
    assert.deepEqual(board.bombZones, [
      { x: 3, y: 4, arm: -1 },
      { x: 8, y: 9, arm: 2 },
    ]);
    assert.equal(board.bombArmTicks, 4);

    // Prefer the accessor when Remix exposes it
    win.bombFruit_zones = function () {
      return [{ x: 1, y: 1, bombX1a: 0 }];
    };
    assert.deepEqual(Gsm.scrapeBoard().bombZones, [{ x: 1, y: 1, arm: 0 }]);
    delete win.bombFruit_zones;

    // Missing zone state must not throw or emit an empty field
    win.__bombFruitZones = [];
    assert.equal(Gsm.scrapeBoard().bombZones, undefined);
  });

  it("scrapeBoard includes themeColors and colorId", () => {
    win.themes = [
      {
        name: "PlayerTheme",
        light_tiles: "#aabbcc",
        dark_tiles: "#112233",
        border: "#445566",
      },
    ];
    // theme menu index 0 selected in DOM
    const board = Gsm.scrapeBoard({ colorId: 35 });
    assert.ok(board);
    assert.equal(board.themeIndex, 0);
    assert.ok(board.themeColors);
    assert.equal(board.themeColors.light, "#aabbcc");
    assert.equal(board.themeColors.dark, "#112233");
    assert.equal(board.colorId, 35);
    // Pride rainbow should resolve live colors + full set for mosaic
    assert.equal(board.Sc, "#e40303");
    assert.ok(board.colorSet && board.colorSet.length >= 6);
    assert.equal(board.colorSet[0], "#e40303");
  });

  it("scrapeBoard resolves solid Sc/Yc from colorId when engine lacks them", () => {
    const board = Gsm.scrapeBoard({ colorId: 4 });
    assert.ok(board);
    assert.equal(board.colorId, 4);
    assert.equal(board.Sc, "#F53D40");
    assert.equal(board.Yc, "#D00B0E");
    assert.equal(board.colorSet, null);
  });

  it("drawBoardOnCanvas prefers board.themeColors over spectator local theme", () => {
    win.themes = [
      {
        name: "Local",
        light_tiles: "#000001",
        dark_tiles: "#000002",
        border: "#000003",
      },
    ];
    const fills = [];
    const canvas = {
      width: 20,
      height: 20,
      getContext: function () {
        return {
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          lineCap: "butt",
          lineJoin: "miter",
          globalAlpha: 1,
          shadowColor: "",
          shadowBlur: 0,
          shadowOffsetY: 0,
          fillRect: function () {
            fills.push(this.fillStyle);
          },
          beginPath: function () {},
          moveTo: function () {},
          lineTo: function () {},
          stroke: function () {},
          arc: function () {},
          fill: function () {},
          save: function () {},
          restore: function () {},
          translate: function () {},
          rotate: function () {},
        };
      },
    };
    Gsm.drawBoardOnCanvas(
      canvas,
      {
        width: 2,
        height: 2,
        body: [],
        apples: [],
        themeColors: {
          light: "#ffaaaa",
          dark: "#ffbbbb",
          border: "#ffcccc",
          apple: "#e7471d",
        },
      },
      null
    );
    assert.ok(fills.includes("#ffcccc"), "border from player theme");
    assert.ok(fills.includes("#ffaaaa"), "light from player theme");
    assert.ok(fills.includes("#ffbbbb"), "dark from player theme");
    assert.ok(!fills.includes("#000001"), "must not use spectator local light");
  });

  it("applySpectateState injects natively without canvas paint by default", () => {
    selects = [];
    let painted = false;
    let fillCalls = 0;
    const canvas = {
      width: 40,
      height: 40,
      getContext: function () {
        painted = true;
        return {
          fillStyle: "",
          fillRect: function () {
            fillCalls++;
          },
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    win.__remixGame.oa.ka = [];
    const result = Gsm.applySpectateState(
      canvas,
      {
        width: 17,
        height: 15,
        body: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        apples: [{ x: 8, y: 8, type: 2 }],
        themeIndex: 0,
        colorId: 0,
        appleIndex: 1,
        sizeIndex: 0,
        dir: "RIGHT",
        themeColors: {
          light: "#111111",
          dark: "#222222",
          border: "#333333",
          apple: "#e7471d",
        },
      },
      { primary: "#4E7CF6", secondary: "#17439F" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.painted, false, "native Focus must not fillRect");
    assert.equal(result.injected, true);
    assert.equal(painted, false);
    assert.equal(fillCalls, 0);
    assert.equal(win.__remixGame.oa.ka.length, 2);
    assert.equal(win.__remixGame.oa.ka[0].x, 1);
    assert.equal(typeof win.__remixGame.oa.ka[0].clone, "function");
    assert.equal(typeof win.__remixGame.oa.ka[1].clone, "function");
    const cloned = win.__remixGame.oa.ka[0].clone();
    assert.equal(cloned.x, 1);
    assert.equal(cloned.y, 1);
    assert.equal(typeof cloned.clone, "function");
    assert.equal(win.__remixGame.oa.direction, "RIGHT");
    assert.ok(selects.some(function (s) { return s.id === "apple"; }));
  });

  it("applySpectateState preserves native segment clone when extending body", () => {
    function NativePt(x, y) {
      this.x = x;
      this.y = y;
    }
    NativePt.prototype.clone = function () {
      return new NativePt(this.x, this.y);
    };
    win.__remixGame.oa.ka = [new NativePt(0, 0)];
    Gsm.applySpectateState(null, {
      body: [
        { x: 3, y: 4 },
        { x: 2, y: 4 },
        { x: 1, y: 4 },
      ],
      dir: "LEFT",
    });
    assert.equal(win.__remixGame.oa.ka.length, 3);
    assert.equal(win.__remixGame.oa.ka[0].x, 3);
    assert.ok(win.__remixGame.oa.ka[0] instanceof NativePt);
    assert.ok(win.__remixGame.oa.ka[1] instanceof NativePt);
    assert.equal(typeof win.__remixGame.oa.ka[2].clone, "function");
    const c2 = win.__remixGame.oa.ka[2].clone();
    assert.equal(c2.x, 1);
    assert.equal(c2.y, 4);
  });

  it("applySpectateState opts.paint true can fillRect for debug/mosaic helpers", () => {
    let painted = false;
    const canvas = {
      width: 40,
      height: 40,
      getContext: function () {
        painted = true;
        return {
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          lineCap: "butt",
          lineJoin: "miter",
          globalAlpha: 1,
          shadowColor: "",
          shadowBlur: 0,
          shadowOffsetY: 0,
          fillRect: function () {},
          beginPath: function () {},
          moveTo: function () {},
          lineTo: function () {},
          stroke: function () {},
          arc: function () {},
          fill: function () {},
          save: function () {},
          restore: function () {},
          translate: function () {},
          rotate: function () {},
        };
      },
    };
    win.__remixGame.oa.ka = [];
    const result = Gsm.applySpectateState(
      canvas,
      {
        width: 17,
        height: 15,
        body: [{ x: 2, y: 2 }],
        apples: [],
        dir: "LEFT",
      },
      { primary: "#4E7CF6" },
      { paint: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.painted, true);
    assert.equal(result.injected, true);
    assert.equal(painted, true);
    assert.equal(win.__remixGame.oa.ka[0].x, 2);
  });

  it("applySpectateState opts.paint false skips canvas paint", () => {
    let painted = false;
    const canvas = {
      width: 40,
      height: 40,
      getContext: function () {
        painted = true;
        return {
          fillStyle: "",
          fillRect: function () {},
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    win.__remixGame.oa.ka = [];
    const result = Gsm.applySpectateState(
      canvas,
      {
        width: 17,
        height: 15,
        body: [{ x: 2, y: 2 }],
        apples: [],
        dir: "LEFT",
      },
      { primary: "#4E7CF6" },
      { paint: false }
    );
    assert.equal(result.ok, true);
    assert.equal(result.painted, false);
    assert.equal(result.injected, true);
    assert.equal(painted, false);
    assert.equal(win.__remixGame.oa.ka[0].x, 2);
  });

  it("Focus spectate injects into game without painting squares", () => {
    let fillCalls = 0;
    const canvas = win.document.querySelector("canvas.nEoGkc");
    assert.ok(canvas);
    canvas.getContext = function () {
      return {
        fillStyle: "",
        fillRect: function () {
          fillCalls++;
        },
        beginPath: function () {},
        arc: function () {},
        fill: function () {},
      };
    };
    win.__remixGame.oa.ka = [{ x: 0, y: 0 }];
    win.__remixGame.wa.ka = [];
    const board = {
      width: 17,
      height: 15,
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
      apples: [{ x: 10, y: 10, type: 3 }],
      themeColors: {
        light: "#aadc4c",
        dark: "#9ad344",
        border: "#578a34",
        apple: "#e7471d",
      },
      colorId: 0,
      appleIndex: 0,
      sizeIndex: 0,
      dir: "RIGHT",
    };
    const result = Gsm.applySpectateState(canvas, board, {
      primary: "#4E7CF6",
      secondary: "#17439F",
    });
    assert.equal(result.ok, true);
    assert.equal(result.painted, false);
    assert.equal(result.injected, true);
    assert.equal(fillCalls, 0);
    assert.equal(win.__remixGame.oa.ka[0].x, 5);
    assert.equal(win.__remixGame.wa.ka.length, 1);
    assert.equal(win.__remixGame.wa.ka[0].type, 3);
    assert.equal(typeof win.__remixGame.wa.ka[0].pos.clone, "function");
  });

  it("applySpectateState apple.pos.clone works when fruit list was empty (versus Focus)", () => {
    // Repro: spectator Play starts with wa.ka=[], BOARD_DELTA grows apples with
    // plain {x,y} pos → native L3E.render throws `b.pos.clone is not a function`.
    win.__remixGame.oa.ka = [];
    win.__remixGame.wa.ka = [];
    const errors = [];
    const result = Gsm.applySpectateState(null, {
      body: [
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
      apples: [
        { x: 8, y: 4, type: 0 },
        { x: 9, y: 5, type: 1 },
      ],
      dir: "UP",
    });
    assert.equal(result.injected, true);
    assert.equal(win.__remixGame.wa.ka.length, 2);
    // Simulate fruit renderer (L3E.render) calling pos.clone on every apple
    win.__remixGame.wa.ka.forEach(function (b) {
      try {
        const c = b.pos.clone();
        assert.equal(typeof c.clone, "function");
        assert.equal(c.x, b.pos.x);
        assert.equal(c.y, b.pos.y);
      } catch (e) {
        errors.push(String(e && e.message ? e.message : e));
      }
    });
    // Body segments must also remain cloneable for PlayerRenderer
    win.__remixGame.oa.ka.forEach(function (seg) {
      try {
        const c = seg.clone();
        assert.equal(c.x, seg.x);
      } catch (e) {
        errors.push(String(e && e.message ? e.message : e));
      }
    });
    assert.deepEqual(errors, []);
  });

  it("Focus die guard ignores local die while remote board.alive", () => {
    let realDie = 0;
    win.__remixGame.die = function () {
      realDie++;
      this.nj = true;
    };
    win.__remixGame.nj = false;
    win.__mpVersusFocusSpectate = true;
    win.__mpVersusFocusBoard = {
      alive: true,
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
      dir: "RIGHT",
    };
    Gsm.applySpectateState(null, win.__mpVersusFocusBoard);
    assert.equal(win.__remixGame.__mpFocusDieGuarded, true);
    win.__remixGame.die();
    assert.equal(realDie, 0, "false local death must not run");
    assert.equal(win.__remixGame.nj, false);
    win.__mpVersusFocusBoard = {
      alive: false,
      body: [{ x: 5, y: 5 }],
      dir: "RIGHT",
    };
    Gsm.applySpectateState(null, win.__mpVersusFocusBoard);
    assert.equal(win.__remixGame.nj, true, "remote death must mark dead");
    win.__remixGame.die();
    assert.equal(realDie, 0, "Focus must never call native die (endscreen)");
  });

  it("Focus revive clears stuck death when remote alive after false", () => {
    win.__mpVersusFocusSpectate = true;
    win.__remixGame.nj = true;
    win.__remixGame.dead = true;
    win.timeKeeper._dead = true;
    win.__mpFocusSeated = false;
    Gsm.applySpectateState(null, {
      alive: false,
      body: [{ x: 2, y: 2 }],
      dir: "LEFT",
    });
    assert.equal(win.__remixGame.nj, true);
    win.__mpFocusSeated = false;
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 9, y: 3 },
        { x: 8, y: 3 },
      ],
      dir: "RIGHT",
    });
    assert.equal(win.__remixGame.nj, false);
    assert.equal(win.__remixGame.dead, false);
    assert.equal(win.timeKeeper._dead, false);
    assert.equal(win.__remixGame.oa.ka[0].x, 9);
    assert.equal(win.__remixGame.oa.ka[0].y, 3);
  });

  it("Focus start inject seats remote body not local spawn leftovers", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    win.__remixGame.oa.ka = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
    ];
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 11, y: 7 },
        { x: 10, y: 7 },
        { x: 9, y: 7 },
      ],
      dir: "RIGHT",
    });
    assert.equal(win.__remixGame.oa.ka.length, 3);
    assert.equal(win.__remixGame.oa.ka[0].x, 11);
    assert.equal(win.__remixGame.oa.ka[0].y, 7);
    assert.equal(win.__remixGame.oa.direction, "RIGHT");
  });

  it("Focus after seat writes full remote body (connected trail)", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    win.timeKeeper.playing = false;
    win.timeKeeper._lastTimeMs = 0;
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 2, y: 5 },
        { x: 1, y: 5 },
        { x: 0, y: 5 },
      ],
      dir: "RIGHT",
    });
    assert.equal(win.__mpFocusSeated, true);
    assert.equal(win.__mpFocusRemoteStarted, false);
    assert.equal(win.timeKeeper.playing, false);
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 3, y: 5 },
        { x: 2, y: 5 },
        { x: 1, y: 5 },
      ],
      dir: "RIGHT",
    });
    assert.equal(win.__remixGame.oa.ka[0].x, 3);
    assert.equal(win.__remixGame.oa.ka[0].y, 5);
    // Connected trail — full remote list, not head-only
    assert.equal(win.__remixGame.oa.ka[1].x, 2);
    assert.equal(win.__remixGame.oa.ka[2].x, 1);
    assert.equal(Gsm.bodyTrailConnected(win.__remixGame.oa.ka), true);
    assert.equal(win.__mpFocusRemoteStarted, true);
    assert.equal(win.timeKeeper.playing, true);
  });

  it("Focus length change after seat reseats full remote body (connected)", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      dir: "RIGHT",
      apples: [{ x: 10, y: 10 }],
    });
    // Local wrongly longer / corrupt tail
    win.__remixGame.oa.ka.push({
      x: 2,
      y: 4,
      clone: function () {
        return { x: this.x, y: this.y, clone: this.clone };
      },
    });
    win.__remixGame.oa.ka[1].x = 99;
    win.__remixGame.oa.ka[1].y = 99;
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 5, y: 4 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      dir: "RIGHT",
      apples: [{ x: 10, y: 10 }],
    });
    assert.equal(win.__remixGame.oa.ka[0].x, 5, "head synced");
    assert.equal(win.__remixGame.oa.ka.length, 3, "length matches remote");
    assert.equal(win.__remixGame.oa.ka[1].x, 4);
    assert.equal(win.__remixGame.oa.ka[2].x, 3);
    assert.equal(Gsm.bodyTrailConnected(win.__remixGame.oa.ka), true);
  });

  it("Focus empty apples while remote alive parks fruit (no ALL/nj loop)", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    win.__remixGame.nj = false;
    win.__remixGame.wa.ka = [
      { pos: { x: 8, y: 8, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } }, type: 0 },
    ];
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
      dir: "RIGHT",
      apples: [{ x: 8, y: 8 }],
    });
    assert.equal(win.__remixGame.wa.ka.length, 1);
    // Remote briefly reports empty fruit while still alive (pre-restart / scrape gap)
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 3, y: 2 },
        { x: 2, y: 2 },
      ],
      dir: "RIGHT",
      apples: [],
    });
    assert.ok(win.__remixGame.wa.ka.length >= 1, "must not clear to zero apples");
    const pos = win.__remixGame.wa.ka[0].pos;
    assert.ok(pos.x < 0 || pos.y < 0, "parked off-grid so local cannot eat");
    assert.equal(win.__remixGame.nj, false);
    // Still alive clears must not flip nj
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 4, y: 2 },
        { x: 3, y: 2 },
      ],
      dir: "RIGHT",
      apples: [],
    });
    assert.equal(win.__remixGame.nj, false);
    assert.ok(win.__remixGame.wa.ka.length >= 1);
  });

  it("Focus tick guard reseats connected body after local physics crawl", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    win.__remixGame.tick = function () {
      this.oa.ka[0].x += 1;
    };
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
        { x: 2, y: 4 },
      ],
      dir: "RIGHT",
    });
    assert.equal(win.__remixGame.__mpFocusTickGuarded, true);
    win.__remixGame.tick();
    assert.equal(win.__remixGame.oa.ka[0].x, 4, "post-tick must pin remote head");
    assert.equal(win.__remixGame.oa.ka[1].x, 3, "neck stays with remote");
    assert.equal(Gsm.bodyTrailConnected(win.__remixGame.oa.ka), true);
  });

  it("Focus inject methods: head-only fragments; follow and full-body stay connected", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    const seat = [
      { x: 2, y: 5 },
      { x: 1, y: 5 },
      { x: 0, y: 5 },
    ];
    const next = [
      { x: 3, y: 5 },
      { x: 2, y: 5 },
      { x: 1, y: 5 },
    ];
    Gsm.applySpectateState(null, { alive: true, body: seat, dir: "RIGHT" });

    // Method A (legacy head-only) — reproduces the spectate glitch
    const headOnly = [
      { x: 3, y: 5 },
      { x: 1, y: 5 },
      { x: 0, y: 5 },
    ];
    assert.equal(
      Gsm.bodyTrailConnected(headOnly),
      false,
      "head-only leaves a gap (the bug in the screenshot)"
    );

    // Method B — followBodyFromHead then write
    const followKa = seat.map(function (p) {
      return {
        x: p.x,
        y: p.y,
        clone: function () {
          return { x: this.x, y: this.y, clone: this.clone };
        },
      };
    });
    const vis = Gsm.followBodyFromHead(followKa, next);
    Gsm.writeNativeBody({ ka: followKa }, vis);
    assert.equal(Gsm.bodyTrailConnected(followKa), true, "follow stays connected");
    assert.equal(followKa[0].x, 3);
    assert.equal(followKa[1].x, 2);

    // Method C — full remote body write
    const fullKa = seat.map(function (p) {
      return {
        x: p.x,
        y: p.y,
        clone: function () {
          return { x: this.x, y: this.y, clone: this.clone };
        },
      };
    });
    Gsm.writeNativeBody({ ka: fullKa }, next);
    assert.equal(Gsm.bodyTrailConnected(fullKa), true, "full body stays connected");
    assert.deepEqual(
      fullKa.map(function (p) {
        return { x: p.x, y: p.y };
      }),
      next
    );

    // Product path uses C (full remote body on pose change)
    Gsm.applySpectateState(null, { alive: true, body: next, dir: "RIGHT" });
    assert.equal(Gsm.bodyTrailConnected(win.__remixGame.oa.ka), true);
    assert.equal(win.__remixGame.oa.ka[0].x, 3);
    assert.equal(win.__remixGame.oa.ka[1].x, 2);
  });

  it("Focus unchanged pose does not rewrite body (avoids flicker)", () => {
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 6, y: 6 },
        { x: 5, y: 6 },
      ],
      dir: "UP",
    });
    win.__remixGame.oa.ka[1].x = 5;
    win.__remixGame.oa.ka[1].y = 6;
    // Marker: corrupt would stick if we rewrote; skip on same pose
    const before = win.__remixGame.oa.ka[1].x;
    Gsm.applySpectateState(null, {
      alive: true,
      body: [
        { x: 6, y: 6 },
        { x: 5, y: 6 },
      ],
      dir: "UP",
    });
    assert.equal(win.__remixGame.oa.ka[1].x, before, "same pose skips body write");
  });

  it("Focus requirePlayClick prevents false-live when death overlay is pre-hidden", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "hidden";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: false, playing: false };
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusRequirePlay = true;
    win.__mpLastPlayClickAt = 0;
    assert.equal(Gsm.isNativeRunLive(), false, "hidden overlay alone is not live");

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
      win.timeKeeper._dead = false;
    };
    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 8,
        intervalMs: 5,
        requirePlayClick: true,
        deferTimer: true,
        onDone: resolve,
      });
    });
    assert.equal(ok, true);
    assert.ok(clicks >= 1, "must click Play for Focus seat");
    assert.equal(win.timeKeeper.playing, false, "timer deferred until remote moves");
    overlay.remove();
  });

  it("followBodyFromHead advances one cell without copying local length wrongly", () => {
    const next = Gsm.followBodyFromHead(
      [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ],
      [
        { x: 3, y: 2 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ]
    );
    assert.deepEqual(next[0], { x: 3, y: 2 });
    assert.deepEqual(next[1], { x: 2, y: 2 });
    assert.deepEqual(next[2], { x: 1, y: 2 });
  });

  it("applyCollectables repairs apples that already have plain pos without clone", () => {
    win.__remixGame.wa.ka = [
      { pos: { x: 1, y: 1 }, type: 0 }, // broken — no clone (pre-fix leftover)
    ];
    assert.equal(typeof win.__remixGame.wa.ka[0].pos.clone, "undefined");
    Gsm.applyCollectables({
      apples: [
        { x: 4, y: 5 },
        { x: 6, y: 7 },
      ],
    });
    assert.equal(win.__remixGame.wa.ka.length, 2);
    win.__remixGame.wa.ka.forEach(function (a) {
      assert.equal(typeof a.pos.clone, "function", "pos must be cloneable");
      const c = a.pos.clone();
      assert.equal(c.x, a.pos.x);
      assert.equal(c.y, a.pos.y);
    });
    assert.equal(win.__remixGame.wa.ka[0].pos.x, 4);
    assert.equal(win.__remixGame.wa.ka[1].pos.y, 7);
  });

  it("applyCollectables preserves native Od pos.prototype.clone when extending list", () => {
    function Od(x, y) {
      this.x = x;
      this.y = y;
    }
    Od.prototype.clone = function () {
      return new Od(this.x, this.y);
    };
    win.__remixGame.wa.ka = [{ pos: new Od(1, 1), type: 2, Xa: 2 }];
    Gsm.applyCollectables({
      apples: [
        { x: 3, y: 3, type: 2 },
        { x: 4, y: 4, type: 2 },
      ],
    });
    assert.equal(win.__remixGame.wa.ka.length, 2);
    assert.ok(win.__remixGame.wa.ka[0].pos instanceof Od);
    assert.ok(win.__remixGame.wa.ka[1].pos instanceof Od);
    const c = win.__remixGame.wa.ka[1].pos.clone();
    assert.ok(c instanceof Od);
    assert.equal(c.x, 4);
  });

  it("installFirstRunControlTipGuard hides tip and injects CSS guard", () => {
    const canvas = win.document.querySelector("canvas.nEoGkc");
    const tip = win.document.createElement("div");
    tip.className = "ahZmw";
    tip.setAttribute("jsname", "IoE5Ec");
    const inner = win.document.createElement("div");
    inner.className = "rNjvu";
    tip.appendChild(inner);
    canvas.parentElement.appendChild(tip);
    delete win.__mpControlTipGuardInstalled;
    delete win.__mpControlTipDismissed;
    const oldStyle = win.document.getElementById("mp-control-tip-guard");
    if (oldStyle) oldStyle.remove();
    assert.equal(typeof Gsm.installFirstRunControlTipGuard, "function");
    assert.equal(Gsm.installFirstRunControlTipGuard(), true);
    assert.equal(win.__mpControlTipDismissed, true);
    const css = win.document.getElementById("mp-control-tip-guard");
    assert.ok(css);
    assert.ok(css.textContent.indexOf(".ahZmw") >= 0);
    assert.ok(css.textContent.indexOf(".rNjvu") >= 0);
    assert.equal(tip.dataset.mpHelperHidden, "1");
    assert.equal(tip.style.display, "none");
    // restoreControlHelper must not bring the tip back while guard is active
    Gsm.restoreControlHelper();
    assert.equal(tip.style.display, "none");
  });

  it("hideControlHelper marks compact absolute overlays", () => {
    const canvas = win.document.querySelector("canvas.nEoGkc");
    const tip = win.document.createElement("div");
    tip.style.cssText =
      "position:absolute;width:100px;height:100px;left:50px;top:120px;";
    canvas.parentElement.appendChild(tip);
    // jsdom getComputedStyle may not return position from style — set via attribute path
    Object.defineProperty(tip, "getBoundingClientRect", {
      value: function () {
        return {
          width: 100,
          height: 100,
          top: 120,
          left: 50,
          right: 150,
          bottom: 220,
        };
      },
    });
    // Force computed style position for jsdom
    const orig = win.getComputedStyle;
    win.getComputedStyle = function (el) {
      if (el === tip) {
        return { position: "absolute" };
      }
      return orig.call(win, el);
    };
    Gsm.hideControlHelper();
    assert.equal(tip.dataset.mpHelperHidden, "1");
    assert.equal(tip.style.visibility, "hidden");
    Gsm.restoreControlHelper();
    assert.equal(tip.dataset.mpHelperHidden, undefined);
    win.getComputedStyle = orig;
  });

  it("hideControlHelper does not touch top-bar HUD strip", () => {
    const shell = win.document.createElement("div");
    shell.className = "EjCLSb";
    const hud = win.document.createElement("div");
    hud.id = "mp-mod-indicator";
    hud.style.cssText = "position:absolute;width:100px;height:40px;";
    Object.defineProperty(hud, "getBoundingClientRect", {
      value: function () {
        return { width: 100, height: 40, top: 10, left: 10, right: 110, bottom: 50 };
      },
    });
    shell.appendChild(hud);
    win.document.body.appendChild(shell);
    const orig = win.getComputedStyle;
    win.getComputedStyle = function (el) {
      if (el === hud) return { position: "absolute" };
      return orig.call(win, el);
    };
    Gsm.hideControlHelper();
    assert.equal(hud.dataset.mpHelperHidden, undefined);
    assert.notEqual(hud.style.visibility, "hidden");
    win.getComputedStyle = orig;
    shell.remove();
  });

  it("emptyLocalSnakeBody parks off-board (never clears ka)", () => {
    win.__remixGame.oa.ka = [
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const ok = Gsm.emptyLocalSnakeBody();
    assert.equal(ok, true);
    assert.ok(win.__remixGame.oa.ka.length >= 1, "ka must stay non-empty");
    assert.equal(win.__remixGame.oa.ka[0].x, -8);
    assert.equal(win.__mpCoopLocalDead, true);
  });

  it("parkLocalSnakeOffBoard moves local head off grid", () => {
    win.__remixGame.oa.ka = [{ x: 1, y: 1 }];
    const ok = Gsm.parkLocalSnakeOffBoard();
    assert.equal(ok, true);
    assert.equal(win.__remixGame.oa.ka[0].x, -8);
    assert.equal(win.__mpCoopLocalDead, true);
  });

  it("alterSnakeCode injects __mpGame + board cache", () => {
    const inCode = "}tick(){window.__remixGame=this;var a=this.Aa,b=this.nj;";
    const out = Gsm.alterSnakeCodeExposeGame(inCode);
    assert.ok(out.includes("window.__mpGame=this"));
    assert.ok(out.includes("__mpBoardCache"));
    assert.ok(out.includes("__mpCoopOnTick"));
  });

  it("alterSnakeCode hooks render enter for companions", () => {
    const out = Gsm.alterSnakeCodeExposeGame(
      "render(a,b,c){var d=a;J5E(this,f,d,!1,!1);}"
    );
    assert.ok(out.includes("__mpCoopRenderEnter"));
    assert.ok(out.includes("isFinite(a)"));
    assert.ok(out.includes("__mpCoopSkipNativeRender"));
    assert.ok(out.includes("__mpCoopAfterSnakeRender"));
  });

  it("applyCollectables resizes apple list to match owner", () => {
    win.__remixGame.wa.ka = [
      { pos: { x: 1, y: 1 }, type: 0 },
      { pos: { x: 2, y: 2 }, type: 0 },
      { pos: { x: 3, y: 3 }, type: 0 },
    ];
    const ok = Gsm.applyCollectables({
      apples: [
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ],
    });
    assert.equal(ok, true);
    assert.equal(win.__remixGame.wa.ka.length, 2);
    assert.equal(win.__remixGame.wa.ka[0].pos.x, 5);
    assert.equal(win.__remixGame.wa.ka[1].pos.y, 6);
  });

  it("applyCollectables nudges fruit off co-op snake cells", () => {
    const nativePath = require.resolve(path.join(ROOT, "src/coop/native.js"));
    delete require.cache[nativePath];
    delete win.__mpCoopRenderInstalled;
    delete win.__mpCoopOnTickInstalled;
    require(path.join(ROOT, "src/coop/native.js"));
    const { CoopNative } = win.CoopNative
      ? { CoopNative: win.CoopNative }
      : require(path.join(ROOT, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.applySnakeDelta({
      clientId: "corpse",
      alive: false,
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
    });
    win.__multiplayerApp = { coopNative: cn };
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__remixGame.wa.ka = [{ pos: { x: 0, y: 0 }, type: 0 }];

    const ok = Gsm.applyCollectables({
      apples: [{ x: 5, y: 5, type: 1 }],
    });
    assert.equal(ok, true);
    const pos = win.__remixGame.wa.ka[0].pos;
    assert.notEqual(pos.x + "," + pos.y, "5,5");
    assert.equal(cn.isOccupied(pos.x, pos.y), false);

    win.__mpCoopSession = false;
    win.__mpCoopInject = false;
    delete win.__multiplayerApp;
  });

  it("applyCoopSpawnOffset writes centered body with oy", () => {
    win.__remixGame.oa.ka = [{ x: 0, y: 0 }];
    win.__remixGame.oa.direction = "UP";
    const ok = Gsm.applyCoopSpawnOffset(2);
    assert.equal(ok, true);
    assert.equal(win.__remixGame.oa.ka.length, 3);
    assert.equal(win.__remixGame.oa.ka[0].y, Math.floor(15 / 2) + 2);
    assert.equal(win.__remixGame.oa.ka[0].x, Math.floor(17 / 2));
    // Must not force RIGHT — Start match should leave snakes idle until a key
    assert.equal(win.__remixGame.oa.direction, "UP");
  });

  it("applyCoopSpawnOffset keeps center+oy even if wall cells exist", () => {
    const w = 17;
    const h = 15;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    // Wall mode starts empty; even if mid-run walls appear, seats stay fixed
    win.__remixGame.Ca = { wa: [] };
    for (let y = 0; y < h; y++) {
      win.__remixGame.Ca.wa[y] = [];
      for (let x = 0; x < w; x++) win.__remixGame.Ca.wa[y][x] = 0;
    }
    win.__remixGame.Ca.wa[cy][cx] = 1;
    win.__remixGame.Ca.wa[cy][cx - 1] = 1;
    win.__remixGame.Ca.wa[cy][cx - 2] = 1;
    win.__remixGame.oa.ka = [{ x: 0, y: 0 }];
    win.__remixGame.oa.direction = null;
    const ok = Gsm.applyCoopSpawnOffset(0);
    assert.equal(ok, true);
    const head = win.__remixGame.oa.ka[0];
    assert.equal(head.x, cx, "exact center x");
    assert.equal(head.y, cy, "exact center y");
  });

  it("applyCoopSpawnOffset clamps oy onto small boards", () => {
    // Small size (~7×7): server oy ±4 would paint off the grid
    const w = 7;
    const h = 7;
    win.__remixGame.oa.oa = { width: w, height: h };
    if (win.__remixGame.wa && win.__remixGame.wa.oa) {
      win.__remixGame.wa.oa.oa = { width: w, height: h };
    }
    win.__remixGame.oa.ka = [{ x: 0, y: 0 }];
    win.__remixGame.oa.direction = null;
    assert.equal(Gsm.clampCoopSpawnOy(4, h), 3);
    assert.equal(Gsm.clampCoopSpawnOy(-4, h), -3);
    const ok = Gsm.applyCoopSpawnOffset(4, { slot: 0 });
    assert.equal(ok, true);
    const head = win.__remixGame.oa.ka[0];
    assert.ok(head.x >= 0 && head.x < w, "x in bounds got " + head.x);
    assert.ok(head.y >= 0 && head.y < h, "y in bounds got " + head.y);
    assert.equal(head.y, Math.floor(h / 2) + 3);
    win.__remixGame.oa.ka.forEach(function (p) {
      assert.ok(p.x >= 0 && p.x < w && p.y >= 0 && p.y < h, "body in bounds");
    });
    // Restore classic size for later harness tests
    win.__remixGame.oa.oa = { width: 17, height: 15 };
    if (win.__remixGame.wa && win.__remixGame.wa.oa) {
      win.__remixGame.wa.oa.oa = { width: 17, height: 15 };
    }
  });

  it("locks match menus while Ready (title + play stay gated)", () => {
    Gsm.setNativeMenusLocked(true);
    const trophy = win.document.getElementById("trophy");
    assert.equal(trophy.style.pointerEvents, "none");
    assert.equal(trophy.title, "Unready to change settings");
    const play = Gsm.playButton();
    assert.equal(play.style.pointerEvents, "none");
    assert.match(play.title, /Start match/i);
    // Cosmetics stay clickable
    ["color", "apple", "graphics", "theme"].forEach((id) => {
      const row = win.document.getElementById(id);
      assert.ok(row, id);
      assert.equal(row.style.pointerEvents, "");
      assert.equal(row.title, "");
    });
    Gsm.setNativeMenusLocked(false);
    assert.equal(trophy.style.pointerEvents, "");
    Gsm.setPlayButtonLocked(true);
    assert.equal(play.style.pointerEvents, "none");
    Gsm.setPlayButtonLocked(false);
    assert.equal(play.style.pointerEvents, "");
  });

  it("unlockPersonalMenus clears sticky helper-hide on cosmetics", () => {
    const theme = win.document.getElementById("theme");
    theme.style.pointerEvents = "none";
    theme.style.visibility = "hidden";
    theme.dataset.mpHelperHidden = "1";
    Gsm.unlockPersonalMenus();
    assert.equal(theme.style.pointerEvents, "");
    assert.equal(theme.style.visibility, "");
    assert.equal(theme.dataset.mpHelperHidden, undefined);
  });

  it("drawBoardOnCanvas uses theme tile colors when present", () => {
    win.themes = [
      {
        name: "Test",
        light_tiles: "#111111",
        dark_tiles: "#222222",
        border: "#333333",
      },
    ];
    win.readGameSettingIndex = () => 0;
    const canvas = {
      width: 34,
      height: 30,
      getContext: function () {
        return {
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          lineCap: "butt",
          lineJoin: "miter",
          globalAlpha: 1,
          shadowColor: "",
          shadowBlur: 0,
          shadowOffsetY: 0,
          fillRect: function () {},
          beginPath: function () {},
          moveTo: function () {},
          lineTo: function () {},
          stroke: function () {},
          arc: function () {},
          fill: function () {},
          save: function () {},
          restore: function () {},
          translate: function () {},
          rotate: function () {},
        };
      },
    };
    Gsm.drawBoardOnCanvas(
      canvas,
      { width: 2, height: 2, body: [{ x: 0, y: 0 }], apples: [] },
      { primary: "#ff0000", secondary: "#00ff00" }
    );
    const theme = Gsm.getBoardThemeColors();
    assert.equal(theme.light, "#111111");
    assert.equal(theme.dark, "#222222");
  });

  it("SETTINGS_SYNC ignores personal cosmetics", () => {
    win.puddingMenuSelect = function (id, index) {
      win.__applied = win.__applied || [];
      win.__applied.push([id, index]);
      return true;
    };
    win.__applied = [];
    // Use values that differ from DOM selection (trophy=1, count=0) so apply runs
    Gsm.applySettings({
      trophy: 2,
      count: 1,
      apple: 3,
      graphics: 1,
      theme: 2,
      color: 5,
    });
    const keys = win.__applied.map((x) => x[0]);
    assert.ok(keys.includes("trophy"));
    assert.ok(keys.includes("count"));
    assert.ok(!keys.includes("apple"));
    assert.ok(!keys.includes("graphics"));
    assert.ok(!keys.includes("theme"));
    assert.ok(!keys.includes("color"));
    const sync = Gsm.snapshotSyncSettings();
    assert.equal(sync.apple, undefined);
    assert.equal(sync.color, undefined);
    assert.equal(sync.graphics, undefined);
    assert.equal(sync.theme, undefined);
  });

  it("lobby SETTINGS_SYNC prefers quiet apply without opening panel", () => {
    win.__opened = 0;
    win._openSnakeSettingsPanel = function () {
      win.__opened += 1;
      return true;
    };
    win.puddingMenuSelect = function () {
      return true;
    };
    win.__mpStartingMatch = false;
    win.__mpCoopSession = false;
    Gsm.applySettings({ trophy: 2, count: 1, speed: 0, size: 1 });
    assert.equal(win.__opened, 0, "should not open settings for lobby sync when API works");
  });

  it("SETTINGS_SYNC during match start does not open settings panel", () => {
    let opened = 0;
    win._openSnakeSettingsPanel = function () {
      opened++;
    };
    win.__mpStartingMatch = true;
    win.puddingMenuSelect = function () {
      return false;
    };
    Gsm.applySettings({ trophy: 2, size: 1 });
    assert.equal(opened, 0);
    win.__mpStartingMatch = false;
  });

  it("SETTINGS_SYNC delayed open aborts once Start match begins", async () => {
    let opened = 0;
    win._openSnakeSettingsPanel = function () {
      opened++;
      return true;
    };
    win.puddingMenuSelect = function () {
      return false;
    };
    win.__mpStartingMatch = false;
    Gsm.applySettings({ trophy: 2, size: 1 });
    assert.ok(opened >= 1);
    // Simulate SESSION_START arriving before delayed retries fire
    win.__mpStartingMatch = true;
    win.__mpApplySettingsGen = (win.__mpApplySettingsGen || 0) + 1;
    const before = opened;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(opened, before);
    win.__mpStartingMatch = false;
  });

  it("closeSettingsPanel calls Remix close helper", () => {
    let closed = 0;
    win._closeSnakeSettingsPanel = function () {
      closed++;
      return true;
    };
    assert.equal(Gsm.closeSettingsPanel(), true);
    assert.equal(closed, 1);
  });

  it("isNativeRunLive is false for leftover dead GameInstance on endscreen", () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "visible";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: true };
    win.__remixGame.nj = false;
    // oa still present after death — old Start match logic treated this as ready
    assert.ok(win.__remixGame.oa);
    assert.equal(Gsm.isNativeRunLive(), false);
    assert.equal(Gsm.isDeathOverlayVisible(), true);

    win.timeKeeper._dead = false;
    overlay.style.visibility = "hidden";
    assert.equal(Gsm.isNativeRunLive(), true);
    overlay.remove();
  });

  it("startNativeRun dismisses sticky showDeathScreen inline styles", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    win.document.body.appendChild(overlay);
    // Old prepareNativePlay path forced these — Play cannot clear them
    Gsm.showDeathScreen({ skipEscapeDispatch: true });
    assert.equal(overlay.style.visibility, "visible");
    assert.equal(win.__remixGame.nj, true, "death screen must quit engine");
    win.timeKeeper = { _dead: true, start: function () { this._dead = false; } };
    win.__mpGame = win.__remixGame;

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
      win.timeKeeper._dead = false;
      win.__remixGame.nj = false;
      if (win.__remixGame.dead != null) win.__remixGame.dead = false;
    };

    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 12,
        intervalMs: 5,
        onDone: resolve,
      });
    });
    assert.equal(ok, true);
    assert.ok(clicks >= 1, "must click Play to reseat after death screen");
    assert.equal(Gsm.isDeathOverlayVisible(), false);
    assert.equal(Gsm.isNativeRunLive(), true);
    overlay.remove();
  });

  it("startNativeRun keeps clicking Play until endscreen clears", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "visible";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: true };
    win.__mpGame = win.__remixGame;

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
      // First click alone is not enough (settings/death race); succeed on 3rd
      if (clicks >= 3) {
        win.timeKeeper._dead = false;
        overlay.style.visibility = "hidden";
      }
    };

    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 10,
        intervalMs: 5,
        onDone: resolve,
      });
    });
    assert.equal(ok, true);
    assert.ok(clicks >= 3);
    assert.equal(Gsm.isNativeRunLive(), true);
    assert.equal(Gsm.isDeathOverlayVisible(), false);
    overlay.remove();
  });

  it("startNativeRun does not stop early just because GameInstance.oa exists", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "visible";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: true };
    assert.ok(win.__remixGame.oa);

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
    };

    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 4,
        intervalMs: 5,
        onDone: resolve,
      });
    });
    assert.equal(ok, false);
    assert.ok(clicks >= 4, "must retry Play while still on endscreen");
    assert.equal(Gsm.isNativeRunLive(), false);
    overlay.remove();
  });

  it("pauses local game for coop authority", () => {
    // Native co-op no longer pauses/hides the board; helper is a no-op clear path
    Gsm.setLocalPaused(true);
    assert.equal(!!win.pauseGame, true);
    Gsm.setLocalPaused(false);
    assert.equal(!!win.pauseGame, false);
  });

  it("showDeathScreen pauses run and reveals overlay", () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    const menu = win.document.createElement("div");
    overlay.appendChild(menu);
    win.document.body.appendChild(overlay);
    Gsm.setLocalPaused(false);
    win.__remixGame.nj = false;
    overlay.style.visibility = "hidden";
    menu.style.visibility = "hidden";
    Gsm.showDeathScreen({ skipEscapeDispatch: true });
    assert.equal(!!win.pauseGame, true, "run must stop behind death screen");
    assert.equal(win.__remixGame.nj, true);
    assert.equal(overlay.style.visibility, "visible");
    assert.equal(menu.style.visibility, "visible");
    overlay.remove();
  });

  it("showDeathScreen keepRunning leaves Focus peek ticking", () => {
    Gsm.setLocalPaused(false);
    win.__remixGame.nj = false;
    Gsm.showDeathScreen({ skipEscapeDispatch: true, keepRunning: true });
    assert.equal(!!win.pauseGame, false);
    assert.equal(win.__remixGame.nj, false);
  });

  it("triggerPlay clicks NSjDf", () => {
    let clicked = false;
    Gsm.playButton().onclick = function () {
      clicked = true;
    };
    assert.equal(Gsm.triggerPlay(), true);
    assert.equal(clicked, true);
  });

  it("wrapTimeKeeper pulses apple/death", () => {
    const events = [];
    Gsm.wrapTimeKeeper({
      onApple: (t, s) => events.push(["apple", t, s]),
      onDeath: (t, s) => events.push(["death", t, s]),
    });
    win.timeKeeper.gotApple(1200, 3);
    win.timeKeeper.death(1500, 3);
    assert.deepEqual(events[0], ["apple", 1200, 3]);
    assert.deepEqual(events[1], ["death", 1500, 3]);
    assert.equal(win.timeKeeper._dead, true);
  });

  it("drawCoopSnapshot renders corpses faded", () => {
    const canvas = win.document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 212;
    const ops = [];
    canvas.getContext = function () {
      return {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        globalAlpha: 1,
        shadowColor: "",
        shadowBlur: 0,
        shadowOffsetY: 0,
        fillRect: () => ops.push("r"),
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => ops.push("s"),
        arc: () => {},
        fill: () => ops.push("f"),
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
      };
    };
    Gsm.drawCoopSnapshot(canvas, {
      width: 17,
      height: 15,
      apple: { x: 1, y: 1 },
      snakes: [
        {
          client_id: "a",
          color_id: 0,
          alive: false,
          body: [
            { x: 4, y: 4 },
            { x: 3, y: 4 },
          ],
        },
        {
          client_id: "b",
          color_id: 35,
          alive: true,
          body: [{ x: 8, y: 8 }],
        },
      ],
    });
    assert.ok(ops.length > 0);
  });
});

describe("mosaic / focus versus state", () => {
  it("toggles spectate mode and lists boards", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.onBoardDelta({ clientId: "p1", board: { score: 1, body: [] } });
    v.onBoardDelta({ clientId: "p2", board: { score: 2, body: [] } });
    assert.equal(v.spectateMode, "focus");
    v.setSpectateMode("mosaic");
    assert.equal(v.spectateMode, "mosaic");
    assert.equal(v.playerIdsWithBoards().length, 2);
  });

  it("stores player themeColors on board delta", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.onBoardDelta({
      clientId: "p1",
      board: {
        score: 1,
        body: [],
        themeColors: { light: "#aaa", dark: "#bbb", border: "#ccc" },
        colorId: 35,
      },
    });
    assert.equal(v.boards.p1.themeColors.light, "#aaa");
    assert.equal(v.boards.p1.colorId, 35);
  });

  it("stores live Sc/Yc/colorSet on board delta for mosaic colors", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.onBoardDelta({
      clientId: "p1",
      board: {
        score: 1,
        body: [],
        colorId: 11,
        Sc: "#3888F8",
        Yc: "#E4425E",
        colorSet: null,
      },
    });
    assert.equal(v.boards.p1.Sc, "#3888F8");
    assert.equal(v.boards.p1.Yc, "#E4425E");
  });

  it("_colorForClient prefers board Sc/Yc and rainbow set", () => {
    const { window: win } = makeDom();
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    const MultiplayerApp = (function loadAppLocal() {
      global.window = win;
      global.document = win.document;
      [
        "shared/colors.js",
        "shared/protocol.js",
        "runtime/bridge.js",
        "session/ready.js",
        "versus/scoreboard.js",
        "coop/state.js",
        "coop/native.js",
        "hooks/gsm.js",
        "net/client.js",
        "ui/settingsTab.js",
        "versus/focus.js",
        "versus/mosaic.js",
        "mod.js",
      ].forEach(function (rel) {
        const p = require.resolve(path.join(ROOT, "src", rel));
        delete require.cache[p];
        require(path.join(ROOT, "src", rel));
      });
      return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
    })();
    const app = Object.create(MultiplayerApp.prototype);
    app.versus = {
      boards: {
        p1: {
          colorId: 35,
          Sc: "#e40303",
          Yc: "#750787",
          colorSet: ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"],
        },
        p2: {
          colorId: 4,
          Sc: "#F53D40",
          Yc: "#D00B0E",
        },
      },
    };
    app.client = { roster: { clients: [] } };
    const pride = app._colorForClient("p1");
    assert.ok(pride);
    assert.equal(pride.primary, "#e40303");
    assert.ok(pride.set && pride.set.length === 6);
    const red = app._colorForClient("p2");
    assert.ok(red);
    assert.equal(red.primary, "#F53D40");
    assert.equal(red.secondary, "#D00B0E");
  });

  it("mosaic click path sets focusClientId and focus mode", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.setSpectateMode("mosaic");
    v.setFocus("p2");
    v.setSpectateMode("focus");
    assert.equal(v.focusClientId, "p2");
    assert.equal(v.spectateMode, "focus");
  });

  it("renderMosaic labels show run timer, best, and lead star", () => {
    const { window: win } = makeDom();
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    const MultiplayerApp = (function loadAppLocal() {
      global.window = win;
      global.document = win.document;
      [
        "shared/colors.js",
        "shared/protocol.js",
        "runtime/bridge.js",
        "session/ready.js",
        "versus/scoreboard.js",
        "coop/state.js",
        "coop/native.js",
        "hooks/gsm.js",
        "net/client.js",
        "ui/settingsTab.js",
        "versus/focus.js",
        "versus/mosaic.js",
        "mod.js",
      ].forEach(function (rel) {
        const p = require.resolve(path.join(ROOT, "src", rel));
        delete require.cache[p];
        require(path.join(ROOT, "src", rel));
      });
      return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
    })();
    const VersusState = win.VersusState;
    const app = new MultiplayerApp();
    app.versus.setSpectateMode("mosaic");
    app.versus.versusGoal = "score";
    app.versus.leaderClientId = "p1";
    const started = Date.now() - 12300;
    app.versus.scores = {
      p1: { score: 3, timeMs: 99999, alive: true, bestScore: 15, bestTimeMs: 40000 },
      p2: { score: 1, timeMs: 5000, alive: false, bestScore: 8, bestTimeMs: 20000 },
    };
    app.versus.runClocks = {
      p1: { startedAtMs: started, frozenMs: null },
      p2: { startedAtMs: started - 100000, frozenMs: 5000 },
    };
    app.versus.boards = {
      p1: { width: 17, height: 15, body: [], apples: [], timeMs: 10000 },
      p2: { width: 17, height: 15, body: [], apples: [], timeMs: 5000 },
    };
    app.client = {
      me: function () {
        return { role: "spectator", clientId: "spec" };
      },
      roster: {
        mode: "versus",
        sessionActive: true,
        versusGoal: "score",
        clients: [
          { clientId: "p1", role: "player", displayName: "Blue" },
          { clientId: "p2", role: "player", displayName: "Red" },
          { clientId: "spec", role: "spectator" },
        ],
      },
    };
    app._leaveVersusFocusSpectate = function () {};
    app._colorForClient = function () {
      return { primary: "#00f", secondary: "#00a" };
    };
    const Gsm = win.MultiplayerGsm;
    const prevDraw = Gsm.drawBoardOnCanvas;
    Gsm.drawBoardOnCanvas = function () {};
    try {
      app.renderMosaic();
      const label1 = app._mosaicCells.p1.querySelector(".mp-mosaic-label");
      const label2 = app._mosaicCells.p2.querySelector(".mp-mosaic-label");
      assert.ok(label1);
      // Live clock from startedAtMs (~12.3s), not score.timeMs 99999
      assert.match(label1.textContent, /^★ Blue · 12\.[0-9]s · best 15$/);
      assert.ok(app._mosaicCells.p1.classList.contains("mp-mosaic-lead"));
      assert.match(label2.textContent, /^Red · 5\.0s · best 8$/);
      assert.equal(app._mosaicCells.p2.classList.contains("mp-mosaic-lead"), false);
      // Apple-style timeMs pulse must not jump the mosaic clock
      app.versus.onScorePulse({
        clientId: "p1",
        score: 4,
        timeMs: 45600,
        alive: true,
        bestScore: 15,
        runStartedAtMs: started,
      });
      app.versus.leaderClientId = "p2";
      app.renderMosaic({ labelsOnly: true });
      assert.match(label1.textContent, /^Blue · 12\.[0-9]s · best 15$/);
      assert.match(label2.textContent, /^★ Red · 5\.0s · best 8$/);
      assert.equal(VersusState.formatRunClock(12300), "12.3s");
      assert.equal(
        VersusState.resolveRunClockMs({ startedAtMs: 1000, frozenMs: null }, 3500),
        2500
      );
      assert.equal(
        VersusState.resolveRunClockMs({ startedAtMs: 1000, frozenMs: 900 }, 9999),
        900
      );
    } finally {
      Gsm.drawBoardOnCanvas = prevDraw;
      if (app._stopMosaicLabelTick) app._stopMosaicLabelTick();
      if (app._mosaicEl && app._mosaicEl.remove) app._mosaicEl.remove();
    }
  });

  it("renderMosaic shows cat lives pips and grace", () => {
    const { window: win } = makeDom();
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    const MultiplayerApp = (function loadAppLocal() {
      global.window = win;
      global.document = win.document;
      [
        "shared/colors.js",
        "shared/protocol.js",
        "runtime/bridge.js",
        "session/ready.js",
        "versus/scoreboard.js",
        "coop/state.js",
        "coop/native.js",
        "hooks/gsm.js",
        "net/client.js",
        "ui/settingsTab.js",
        "versus/focus.js",
        "versus/mosaic.js",
        "mod.js",
      ].forEach(function (rel) {
        const p = require.resolve(path.join(ROOT, "src", rel));
        delete require.cache[p];
        require(path.join(ROOT, "src", rel));
      });
      return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
    })();
    const app = new MultiplayerApp();
    app.versus.setSpectateMode("mosaic");
    app.versus.scores = {};
    app.versus.runClocks = {};
    app.versus.boards = {
      // Cat player: 3 of 9 lives left, grace ticking
      p1: {
        width: 17, height: 15, body: [], apples: [],
        catLives: 3, catLivesMax: 9, catGrace: 4,
      },
      // Non-cat player: no lives strip at all
      p2: { width: 17, height: 15, body: [], apples: [] },
    };
    app.client = {
      me: function () {
        return { role: "spectator", clientId: "spec" };
      },
      roster: {
        mode: "versus",
        sessionActive: true,
        clients: [
          { clientId: "p1", role: "player", displayName: "Blue" },
          { clientId: "p2", role: "player", displayName: "Red" },
          { clientId: "spec", role: "spectator" },
        ],
      },
    };
    app._leaveVersusFocusSpectate = function () {};
    app._colorForClient = function () {
      return { primary: "#00f", secondary: "#00a" };
    };
    const Gsm = win.MultiplayerGsm;
    const prevDraw = Gsm.drawBoardOnCanvas;
    const prevActive = Gsm.snakeMotionActive;
    Gsm.drawBoardOnCanvas = function () {};
    try {
      app.renderMosaic();
      const cat1 = app._mosaicCells.p1.querySelector(".mp-mosaic-cat");
      const cat2 = app._mosaicCells.p2.querySelector(".mp-mosaic-cat");
      assert.ok(cat1);
      assert.equal(cat1.style.display, "flex");
      assert.equal(
        cat1.querySelectorAll(".mp-mosaic-cat-pip").length,
        9,
        "one pip per max life"
      );
      assert.equal(
        cat1.querySelectorAll(".mp-mosaic-cat-pip.on").length,
        3,
        "lit pips match remaining lives"
      );
      assert.equal(cat1.querySelector(".mp-mosaic-cat-n").textContent, "3");
      assert.equal(cat1.querySelector(".mp-mosaic-cat-grace").textContent, "4");
      assert.match(cat1.title, /Cat lives 3\/9 · grace 4/);

      // No cat data → strip stays hidden and empty
      assert.equal(cat2.style.display, "none");
      assert.equal(cat2.querySelectorAll(".mp-mosaic-cat-pip").length, 0);

      // Spending a life repaints; grace ending drops the countdown
      app.versus.boards.p1 = {
        width: 17, height: 15, body: [], apples: [],
        catLives: 2, catLivesMax: 9,
      };
      app.renderMosaic({ labelsOnly: true });
      assert.equal(cat1.querySelectorAll(".mp-mosaic-cat-pip.on").length, 2);
      assert.equal(cat1.querySelector(".mp-mosaic-cat-n").textContent, "2");
      assert.equal(cat1.querySelector(".mp-mosaic-cat-grace"), null);

      // Cat mode ending hides the strip again
      delete app.versus.boards.p1.catLives;
      app.renderMosaic({ labelsOnly: true });
      assert.equal(cat1.style.display, "none");

      // Between deltas, only the cells whose snake is mid-step get repainted,
      // and no label or DOM work runs with them.
      const painted = [];
      Gsm.drawBoardOnCanvas = function (canvas, board, colorInfo, theme, key) {
        painted.push(key);
      };
      Gsm.snakeMotionActive = function (canvas) {
        return canvas === app._mosaicCells.p1.querySelector("canvas");
      };
      app._animateMosaicBoards();
      assert.deepEqual(painted, ["p1"]);
      Gsm.snakeMotionActive = function () {
        return false;
      };
      app._animateMosaicBoards();
      assert.deepEqual(painted, ["p1"], "settled boards are left alone");
    } finally {
      Gsm.drawBoardOnCanvas = prevDraw;
      Gsm.snakeMotionActive = prevActive;
      if (app._stopMosaicLabelTick) app._stopMosaicLabelTick();
      if (app._stopMosaicAnim) app._stopMosaicAnim();
      if (app._mosaicEl && app._mosaicEl.remove) app._mosaicEl.remove();
    }
  });
});

describe("versus Focus spectate (mosaic view)", () => {
  function loadApp(win) {
    global.window = win;
    global.document = win.document;
    global.HTMLElement = win.HTMLElement;
    global.KeyboardEvent = win.KeyboardEvent;
    function raf(fn) {
      return setTimeout(fn, 0);
    }
    function caf(id) {
      clearTimeout(id);
    }
    global.requestAnimationFrame = raf;
    global.cancelAnimationFrame = caf;
    win.requestAnimationFrame = raf;
    win.cancelAnimationFrame = caf;
    [
      "shared/colors.js",
      "shared/protocol.js",
      "runtime/bridge.js",
      "session/ready.js",
      "versus/scoreboard.js",
      "coop/state.js",
      "coop/native.js",
      "hooks/gsm.js",
      "net/client.js",
      "ui/settingsTab.js",
      "versus/focus.js",
      "versus/mosaic.js",
      "mod.js",
    ].forEach(function (rel) {
      const p = require.resolve(path.join(ROOT, "src", rel));
      delete require.cache[p];
      require(path.join(ROOT, "src", rel));
    });
    return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
  }

  /** Spectator watching "admin", session live, Focus (not mosaic) view. */
  function makeSpectatorApp(win, MultiplayerApp, board) {
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: true,
        versusGoal: "score",
        clients: [
          { clientId: "admin", role: "player", colorId: 4, resolvedName: "Ada" },
          { clientId: "spec", role: "spectator" },
        ],
      },
      spectateFocus: function () {},
      resync: function () {},
    };
    app.applyControlLocks = function () {};
    app._colorForClient = function () {
      return { primary: "#4e7cf6", secondary: "#3b5fd0" };
    };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "admin";
    if (board) app.versus.boards.admin = board;
    return app;
  }

  function liveBoard(extra) {
    return Object.assign(
      {
        width: 17,
        height: 15,
        alive: true,
        score: 6,
        body: [
          { x: 3, y: 3 },
          { x: 2, y: 3 },
        ],
        apples: [{ x: 9, y: 9 }],
        dir: "UP",
        themeColors: { light: "#aad751", dark: "#a2d149", border: "#578a34" },
      },
      extra || {}
    );
  }

  /** What Focus hands the mosaic renderer (the renderer itself is tested in gsm). */
  function recordPaints(win) {
    const draws = [];
    win.MultiplayerGsm.drawBoardOnCanvas = function (canvas, board, colorInfo) {
      draws.push({ canvas: canvas, board: board, colorInfo: colorInfo });
    };
    return draws;
  }

  function stubGameCanvasBox(win, box) {
    const canvas = win.document.querySelector("canvas.nEoGkc");
    canvas.getBoundingClientRect = function () {
      return box;
    };
    win.MultiplayerGsm.gameCanvas = function () {
      return canvas;
    };
    return canvas;
  }

  it("Focus paints the watched board over the game canvas, seating nothing", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const draws = recordPaints(win);
    stubGameCanvasBox(win, { left: 40, top: 60, width: 612, height: 540 });
    const death = win.document.createElement("div");
    death.className = "wjOYOd";
    death.style.visibility = "visible";
    win.document.body.appendChild(death);
    let playClicks = 0;
    let nativeRuns = 0;
    win.document
      .querySelector('[jsname="NSjDf"]')
      .addEventListener("click", function () {
        playClicks++;
      });
    win.MultiplayerGsm.startNativeRun = function () {
      nativeRuns++;
    };
    win.MultiplayerGsm.triggerPlay = function () {
      playClicks++;
    };
    win.__remixGame = {
      oa: { ka: [{ x: 1, y: 1 }], direction: "LEFT" },
      wa: { ka: [] },
    };
    win.__mpGame = win.__remixGame;
    const app = makeSpectatorApp(win, MultiplayerApp, liveBoard());
    try {
      app.renderFocusBoard();
      const view = win.document.getElementById("mp-focus-view");
      assert.ok(view, "focus view must mount");
      assert.equal(view.style.display, "block");
      assert.equal(draws.length, 1);
      assert.equal(draws[0].canvas.className, "mp-focus-canvas");
      assert.equal(draws[0].board, app.versus.boards.admin);
      // Sits exactly on the game canvas, with a border frame around the board
      assert.equal(view.style.left, "40px");
      assert.equal(view.style.top, "60px");
      assert.equal(view.style.width, "612px");
      assert.equal(view.style.height, "540px");
      const pad = parseInt(view.style.padding, 10);
      assert.ok(pad >= 8 && pad <= 40, "one-cell border frame, got " + pad);
      assert.match(view.style.background, /578a34|87, ?138, ?52/);
      // The seat loop used to click Play every 45 frames and re-hide the
      // endscreen every frame, which is what reset it over and over.
      for (let i = 0; i < 30; i++) app.renderFocusBoard();
      assert.equal(nativeRuns, 0, "focus must not seat a native run");
      assert.equal(playClicks, 0, "focus must not click Play");
      assert.equal(death.style.visibility, "visible", "endscreen untouched");
      assert.equal(win.__mpVersusFocusWatch, true);
      assert.equal(win.__mpVersusFocusSpectate, false, "engine inject stays off");
      assert.deepEqual(win.__remixGame.oa.ka, [{ x: 1, y: 1 }]);
      assert.equal(win.__remixGame.oa.direction, "LEFT");
    } finally {
      app._leaveVersusFocusSpectate();
    }
  });

  it("Focus label tracks the watched player, clock, best and death", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    recordPaints(win);
    stubGameCanvasBox(win, { left: 0, top: 0, width: 612, height: 540 });
    const app = makeSpectatorApp(win, MultiplayerApp, liveBoard());
    const started = Date.now() - 4200;
    app.versus.scores = {
      admin: { score: 6, bestScore: 12, timeMs: 4200, alive: true },
    };
    app.versus.runClocks = { admin: { startedAtMs: started, frozenMs: null } };
    try {
      app.renderFocusBoard();
      const label = win.document.querySelector("#mp-focus-view .mp-focus-label");
      assert.match(label.textContent, /^Ada · 6 · 4\.[0-9]s · best 12$/);
      assert.equal(label.classList.contains("mp-focus-dead"), false);
      app.versus.boards.admin = liveBoard({ alive: false, score: 9 });
      app.versus.runClocks.admin = { startedAtMs: started, frozenMs: 4300 };
      app.renderFocusBoard();
      assert.match(label.textContent, /^Ada · 9 · 4\.3s · best 12 · dead$/);
      assert.ok(label.classList.contains("mp-focus-dead"));
    } finally {
      app._leaveVersusFocusSpectate();
    }
  });

  it("Escape peek steps the Focus view aside, then it comes back", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    recordPaints(win);
    stubGameCanvasBox(win, { left: 0, top: 0, width: 612, height: 540 });
    const app = makeSpectatorApp(win, MultiplayerApp, liveBoard());
    try {
      app.renderFocusBoard();
      const view = win.document.getElementById("mp-focus-view");
      assert.equal(view.style.display, "block");
      win.__mpSpectateAllowMenus = true;
      app.renderFocusBoard();
      assert.equal(view.style.display, "none", "peek must expose the native UI");
      assert.equal(app._versusFocusSpectate, true, "still watching");
      win.__mpSpectateAllowMenus = false;
      app.renderFocusBoard();
      assert.equal(view.style.display, "block");
    } finally {
      app._leaveVersusFocusSpectate();
    }
  });

  it("Focus repaints between deltas while the snake is mid-step", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const draws = recordPaints(win);
    stubGameCanvasBox(win, { left: 0, top: 0, width: 612, height: 540 });
    const app = makeSpectatorApp(win, MultiplayerApp, liveBoard());
    let active = true;
    win.MultiplayerGsm.snakeMotionActive = function () {
      return active;
    };
    try {
      app.renderFocusBoard();
      assert.equal(draws.length, 1);
      assert.ok(app._focusAnimRaf, "animation loop runs while watching");
      // Each frame repaints the canvas for the player being watched
      assert.equal(app._animateVersusFocus(), true);
      assert.equal(draws.length, 2);
      assert.equal(draws[1].canvas.className, "mp-focus-canvas");
      // Landed on the cell: nothing left to animate
      active = false;
      assert.equal(app._animateVersusFocus(), false);
      assert.equal(draws.length, 2);
      // Peeking at the menus: the view is hidden, so do not paint it
      active = true;
      win.__mpSpectateAllowMenus = true;
      assert.equal(app._animateVersusFocus(), false);
      assert.equal(draws.length, 2);
      win.__mpSpectateAllowMenus = false;
    } finally {
      app._leaveVersusFocusSpectate();
      assert.ok(!app._focusAnimRaf, "loop stops with the view");
    }
  });

  it("mosaic / session end drops the view and hands back the death screen", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    recordPaints(win);
    stubGameCanvasBox(win, { left: 0, top: 0, width: 612, height: 540 });
    const app = makeSpectatorApp(win, MultiplayerApp, liveBoard());
    let restored = 0;
    win.MultiplayerGsm.restoreDeathScreen = function () {
      restored++;
    };
    try {
      app.renderFocusBoard();
      const view = win.document.getElementById("mp-focus-view");
      assert.ok(app._versusFocusTimer, "label tick runs while watching");
      app.versus.spectateMode = "mosaic";
      app.renderFocusBoard();
      assert.equal(view.style.display, "none");
      assert.equal(app._versusFocusSpectate, false);
      assert.ok(!app._versusFocusTimer, "label tick stopped");
      assert.equal(win.__mpVersusFocusWatch, false);
      assert.ok(restored >= 1, "death screen handed back");
    } finally {
      app._leaveVersusFocusSpectate();
    }
  });
});

describe("Multiplayer settings tab layout", () => {
  it("escapes display names in versus HUD innerHTML", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
      </div>
      <div class="FL0c2d"><div class="sXu3u"></div></div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    win.VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    assert.ok(UI, "MultiplayerUI should load");
    const app = {
      client: {
        connected: true,
        roster: {
          mode: "versus",
          sessionActive: true,
          clients: [
            {
              clientId: "evil",
              role: "player",
              displayName: '<img src=x onerror="window.__xss=1">',
              resolvedName: '<img src=x onerror="window.__xss=1">',
            },
          ],
        },
        me: function () {
          return { clientId: "spec", role: "spectator" };
        },
      },
      versus: {
        spectateMode: "focus",
        scores: { evil: { score: 3, bestScore: 3 } },
        winnerClientId: "evil",
        expired: true,
      },
    };
    const ui = new UI(app);
    assert.equal(typeof ui.mountHud, "function");
    ui.mountHud();
    if (!ui.hud) {
      ui.hud = win.document.createElement("div");
      ui.hud.id = "mp-hud";
      win.document.body.appendChild(ui.hud);
    }
    ui.updateHud(app);
    assert.equal(win.__xss, undefined);
    assert.ok(ui.hud.innerHTML.indexOf("<img") < 0);
    assert.ok(ui.hud.innerHTML.indexOf("&lt;img") >= 0);
    assert.ok(ui.hud.innerHTML.indexOf("mp-hud-winner") >= 0, "winner banner");
    assert.ok(ui.hud.innerHTML.indexOf("Winner:") >= 0);
    assert.ok(ui.hud.innerHTML.indexOf("Score 3") >= 0, "goal detail");
    assert.ok(ui.hud.innerHTML.indexOf("Last match results") >= 0);
  });

  it("versus HUD announces ranked last-match results to all players", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    win.VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const app = {
      client: {
        connected: true,
        roster: {
          mode: "versus",
          sessionActive: false,
          attemptExpired: true,
          allowNewRuns: false,
          versusGoal: "score",
          clients: [
            {
              clientId: "p1",
              role: "player",
              displayName: "Alice",
              resolvedName: "Alice",
            },
            {
              clientId: "p2",
              role: "player",
              displayName: "Bob",
              resolvedName: "Bob",
            },
          ],
        },
        me: function () {
          return { clientId: "p2", role: "player" };
        },
      },
      versus: {
        spectateMode: "focus",
        versusGoal: "score",
        expired: true,
        winnerClientId: "p1",
        leaderClientId: "p1",
        scores: {
          p1: { score: 12, bestScore: 40, bestTimeMs: 1000 },
          p2: { score: 5, bestScore: 18, bestTimeMs: 500 },
        },
      },
    };
    const ui = new UI(app);
    ui.mountHud();
    if (!ui.hud) {
      ui.hud = win.document.createElement("div");
      ui.hud.id = "mp-hud";
      win.document.body.appendChild(ui.hud);
    }
    ui.updateHud(app);
    const html = ui.hud.innerHTML;
    assert.ok(html.indexOf("mp-hud-winner") >= 0);
    assert.ok(html.indexOf("Winner: Alice") >= 0);
    assert.ok(html.indexOf("Score 40") >= 0);
    assert.ok(html.indexOf("1. Alice") >= 0);
    assert.ok(html.indexOf("2. Bob") >= 0);
    assert.ok(html.indexOf("mp-hud-lead") >= 0);
  });

  it("mounts as own top tab with Connect/Match/Roster sub-tabs", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function (id) {
      win.document.querySelectorAll(".ultra-settings-page").forEach(function (p) {
        p.classList.toggle(
          "ultra-page-on",
          p.id === "ultra-settings-page-" + id
        );
      });
    };
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const ui = new UI({ client: null, versus: { spectateMode: "focus" } });
    ui.mountSettingsTab();

    const tab = win.document.getElementById("ultra-settings-tab-multiplayer");
    const page = win.document.getElementById("ultra-settings-page-multiplayer");
    const pager = win.document.getElementById("ultra-settings-pager");
    assert.ok(tab);
    assert.ok(page);
    assert.equal(page.parentElement.id, "settings-popup-pudding");
    assert.equal(
      win.document.querySelector("#settings-popup-pudding > span").textContent,
      "Settings"
    );
    assert.ok(pager.classList.contains("ultra-pager-grid"));
    assert.equal(win.document.getElementById("mp-subpager").children.length, 3);
    assert.ok(win.document.getElementById("mp-panel-connect"));
    assert.ok(win.document.getElementById("mp-panel-match"));
    assert.ok(win.document.getElementById("mp-panel-roster"));
    assert.equal(win.document.getElementById("mp-panel-spectate"), null);
    assert.ok(win.document.getElementById("mp-roster-spectate-bar"));
    assert.ok(win.document.getElementById("mp-mosaic-toggle"));
    const mosaicCss = Array.from(win.document.querySelectorAll("style"))
      .map(function (s) { return s.textContent || ""; })
      .join("\n");
    assert.ok(
      /#mp-mosaic\{[^}]*left:\s*50%/.test(mosaicCss),
      "mosaic should be horizontally centered"
    );
    assert.ok(
      /#mp-mosaic\{[^}]*top:\s*12px/.test(mosaicCss),
      "mosaic should sit at the top of the screen"
    );
    assert.ok(
      /max-width:\s*min\(96vw,\s*1100px\)/.test(mosaicCss) ||
        /max-width:min\(96vw,1100px\)/.test(mosaicCss),
      "mosaic max width allows larger tiles"
    );
    assert.ok(
      win.document.getElementById("mp-panel-connect").classList.contains("mp-panel-on")
    );
    // Setup must not contain multiplayer host
    assert.equal(
      win.document.querySelector("#ultra-settings-page-setup #mp-settings-host"),
      null
    );
  });

  it("hides Spectate buttons for players and restores them for spectators", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    win.VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;

    let role = "player";
    const app = {
      client: {
        connected: true,
        clientId: "p1",
        isAdmin: function () {
          return false;
        },
        me: function () {
          return { clientId: "p1", role: role, ready: true };
        },
        roster: {
          mode: "versus",
          roomCode: "ABCD",
          sessionActive: false,
          clients: [
            { clientId: "admin", role: "player", ready: true },
            { clientId: "p1", role: role, ready: true },
          ],
        },
      },
      versus: { scores: {}, spectateMode: "focus", focusClientId: "admin" },
      focusSpectatePlayer: function (id) {
        this.versus.focusClientId = id;
        this.versus.spectateMode = "focus";
      },
      setSpectateMode: function (mode) {
        this.versus.spectateMode = mode;
      },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();

    function assertSpectateUi(expectSpectator) {
      const bar = win.document.getElementById("mp-roster-spectate-bar");
      const mosaic = win.document.getElementById("mp-mosaic-toggle");
      assert.ok(bar && mosaic);
      assert.equal(bar.style.display, expectSpectator ? "" : "none");
      const nameWatch = win.document.querySelectorAll(
        ".mp-roster-name-watch[data-mp-act=\"focus\"]"
      );
      assert.equal(nameWatch.length, expectSpectator ? 1 : 0);
      // Spectators themselves are never focus targets
      const specRow = win.document.querySelector('[data-mp-row="p1"]');
      if (expectSpectator && specRow) {
        assert.equal(
          specRow.querySelectorAll('[data-mp-act="focus"]').length,
          0,
          "cannot click-spectate a spectator"
        );
      }
    }

    app.client.roster.clients[1].role = "player";
    role = "player";
    ui.renderRoster(app.client.roster);
    assertSpectateUi(false);

    role = "spectator";
    app.client.roster.clients[1].role = "spectator";
    ui.renderRoster(app.client.roster);
    assertSpectateUi(true);
    const watchingRow = win.document.querySelector(
      '.mp-roster-row.mp-roster-watching[data-mp-row="admin"]'
    );
    assert.ok(watchingRow, "focused player should be marked as spectating");
    assert.ok(
      watchingRow.querySelector(".mp-roster-watching-tag"),
      "Spectating tag on name"
    );

    role = "player";
    app.client.roster.clients[1].role = "player";
    ui.renderRoster(app.client.roster);
    assertSpectateUi(false);
  });

  it("hides versus duration in coop and swaps Start/End on sessionActive", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    win.VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const app = {
      client: {
        connected: true,
        clientId: "admin",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return { clientId: "admin", role: "player", ready: true };
        },
        roster: null,
      },
      versus: { scores: {}, spectateMode: "focus" },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();

    const durField = win.document.getElementById("mp-duration-field");
    const goalField = win.document.getElementById("mp-versus-goal-field");
    const endBtn = win.document.getElementById("mp-end");
    const startBtn = win.document.getElementById("mp-start");
    assert.ok(durField);
    assert.ok(goalField);
    assert.ok(endBtn);
    assert.ok(startBtn);

    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: false,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
      versusGoal: "best50",
    });
    assert.notEqual(durField.style.display, "none");
    assert.notEqual(goalField.style.display, "none");
    assert.equal(endBtn.style.display, "none");
    assert.notEqual(startBtn.style.display, "none");
    assert.equal(win.document.getElementById("mp-versus-goal").value, "best50");

    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.notEqual(endBtn.style.display, "none");
    assert.equal(startBtn.style.display, "none", "no Start while a match runs");

    // Attempt ran out with finish-ongoing grace: session stays live → Start stays hidden
    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: true,
      attemptExpired: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: false,
    });
    assert.equal(
      startBtn.style.display,
      "none",
      "Start stays hidden while finish-ongoing grace keeps sessionActive"
    );

    // After the session fully ends, Start comes back for the next match
    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: false,
      attemptExpired: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: false,
    });
    assert.notEqual(startBtn.style.display, "none");

    ui.renderRoster({
      mode: "coop",
      roomCode: "ABCD",
      sessionActive: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.equal(durField.style.display, "none");
    assert.equal(goalField.style.display, "none");
    assert.notEqual(endBtn.style.display, "none");
    assert.equal(startBtn.style.display, "none");

    ui.renderRoster({
      mode: "coop",
      roomCode: "ABCD",
      sessionActive: false,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.equal(durField.style.display, "none");
    assert.equal(endBtn.style.display, "none");
    assert.notEqual(startBtn.style.display, "none");

    // Stuck co-op: server session flag dropped or a peer never died, but this
    // client is still injected — End match stays so the admin can quit out.
    app._coopSessionActive = true;
    ui.renderRoster({
      mode: "coop",
      roomCode: "ABCD",
      sessionActive: false,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.notEqual(endBtn.style.display, "none", "End match while local co-op still live");
  });

  it("shows Pass admin on roster rows and hides Match dropdown", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const transferred = [];
    const app = {
      client: {
        connected: true,
        clientId: "admin",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return { clientId: "admin", role: "player", ready: true };
        },
        transferAdmin: function (id) {
          transferred.push(id);
        },
        roster: {
          mode: "coop",
          roomCode: "ABCD",
          sessionActive: false,
          clients: [
            { clientId: "admin", role: "player", ready: true, isAdmin: true },
            { clientId: "p2", role: "player", ready: true },
          ],
        },
      },
      versus: { scores: {}, spectateMode: "focus" },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();
    assert.equal(win.document.getElementById("mp-pass-admin"), null);
    ui.renderRoster(app.client.roster);
    const passBtns = win.document.querySelectorAll('[data-mp-act="admin"]');
    assert.equal(passBtns.length, 1);
    assert.match(passBtns[0].textContent || "", /Pass admin/i);
    passBtns[0].dispatchEvent(
      new win.Event("pointerdown", { bubbles: true, cancelable: true })
    );
    assert.deepEqual(transferred, ["p2"]);
  });

  it("adds Settings button left of Details in Speed Info", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="si-personal">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 3px;">
          <span>Speed Info</span>
          <button class="btn" id="time-keeper" jsname="time-keeper">Details</button>
        </div>
      </div>
      <div id="settings-popup-pudding" style="visibility:hidden;display:none;">
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.BootstrapShow = function () {
      const box = win.document.getElementById("settings-popup-pudding");
      box.style.display = "block";
      box.style.visibility = "visible";
      win.bootstrapVisible = true;
    };
    win.remixShowSettingsPage = function (id) {
      win.document.querySelectorAll(".ultra-settings-page").forEach(function (p) {
        p.classList.toggle(
          "ultra-page-on",
          p.id === "ultra-settings-page-" + id
        );
      });
    };
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const app = {
      client: {
        connected: true,
        me: function () {
          return { role: "spectator" };
        },
      },
      versus: { spectateMode: "focus" },
    };
    app.ui = new UI(app);
    app.ui.mountSettingsTab();

    // Mirror ensureSpeedInfoSettingsButton from mod (unit-level DOM insert)
    const details = win.document.getElementById("time-keeper");
    const headerRow = details.parentElement;
    Array.from(headerRow.children || []).forEach(function (el) {
      if (
        el &&
        el.tagName === "SPAN" &&
        /speed\s*info/i.test((el.textContent || "").trim())
      ) {
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
      }
    });
    const btn = win.document.createElement("button");
    btn.id = "mp-speedinfo-settings";
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Settings";
    const group = win.document.createElement("div");
    group.className = "mp-si-btn-group";
    headerRow.insertBefore(group, details);
    group.appendChild(btn);
    group.appendChild(details);
    btn.addEventListener("click", function () {
      app.ui.openPuddingSettings();
    });

    assert.equal(btn.textContent, "Settings");
    assert.equal(btn.nextElementSibling, details);
    const title = headerRow.querySelector("span");
    assert.ok(title);
    assert.equal(title.style.display, "none");
    btn.click();
    const box = win.document.getElementById("settings-popup-pudding");
    assert.equal(box.style.visibility, "visible");
    assert.ok(
      win.document
        .getElementById("ultra-settings-page-multiplayer")
        .classList.contains("ultra-page-on")
    );
    assert.ok(
      win.document.getElementById("mp-panel-roster").classList.contains("mp-panel-on")
    );
  });

  it("Start match pushes Versus attempt minutes from the textbox", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    let durationSent = null;
    let sessionStarted = false;
    let sessionPayload = null;
    const app = {
      client: {
        connected: true,
        clientId: "admin",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return { clientId: "admin", role: "player", ready: true };
        },
        roster: {
          mode: "versus",
          sessionActive: false,
          allowNewRuns: true,
          clients: [
            { clientId: "admin", role: "player", ready: true },
            { clientId: "p2", role: "player", ready: true },
          ],
        },
        allowNewRuns: function () {
          return true;
        },
        setDuration: function (mins) {
          durationSent = mins;
        },
        setVersusGoal: function () {},
        sessionStart: function (payload) {
          sessionStarted = true;
          sessionPayload = payload || {};
        },
      },
      versus: { scores: {}, spectateMode: "focus" },
      syncMySettingsAsAdmin: function () {
        return { trophy: 0, count: 1, speed: 0, size: 0 };
      },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();
    const dur = win.document.getElementById("mp-duration");
    const startBtn = win.document.getElementById("mp-start");
    dur.value = "7";
    ui.renderRoster(app.client.roster);
    startBtn.disabled = false;
    startBtn.click();
    assert.equal(durationSent, 7);
    assert.equal(sessionStarted, true);
    assert.ok(sessionPayload && sessionPayload.settings);
    assert.equal(sessionPayload.settings.count, 1);
  });
});

describe("spectator / admin menu access", () => {
  function loadApp(win) {
    global.window = win;
    global.document = win.document;
    global.HTMLElement = win.HTMLElement;
    global.KeyboardEvent = win.KeyboardEvent;
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
      "versus/scoreboard.js",
      "coop/state.js",
      "coop/native.js",
      "hooks/gsm.js",
      "net/client.js",
      "ui/settingsTab.js",
      "versus/focus.js",
      "versus/mosaic.js",
      "mod.js",
    ].forEach(function (rel) {
      const p = require.resolve(path.join(ROOT, "src", rel));
      delete require.cache[p];
      require(p);
    });
    return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
  }

  function menuDom() {
    return new (require("jsdom").JSDOM)(`<!DOCTYPE html><html><body>
      <div class="wjOYOd" style="visibility:visible;opacity:1">
        <div>
          <div id="trophy"><div class="tuJOWd"></div><div></div></div>
          <div id="count"><div class="tuJOWd"></div></div>
          <div id="speed"><div class="tuJOWd"></div></div>
          <div id="size"><div class="tuJOWd"></div></div>
          <div id="color"><div class="tuJOWd"></div><div></div></div>
          <div id="apple"><div class="tuJOWd"></div></div>
          <div id="graphics"><div class="tuJOWd"></div></div>
          <div id="theme"><div class="tuJOWd"></div></div>
          <button jsname="NSjDf" aria-label="Play">Play</button>
        </div>
      </div>
      <canvas class="nEoGkc" width="400" height="400"></canvas>
    </body></html>`, { url: "https://googlesnakemods.com/v/current" }).window;
  }

  function assertPersonalClickable(doc) {
    ["color", "apple", "graphics", "theme"].forEach(function (id) {
      const row = doc.getElementById(id);
      assert.ok(row, id);
      assert.equal(row.style.pointerEvents, "", id + " pointer-events");
      assert.equal(row.style.opacity, "", id + " opacity");
      assert.notEqual(row.style.visibility, "hidden", id + " visibility");
    });
  }

  it("spectator menus unlocked until Ready; cosmetics + Escape peek stay usable", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: false,
        adminId: "admin",
        clients: [
          { clientId: "admin", role: "player" },
          { clientId: "spec", role: "spectator" },
        ],
      },
      spectateFocus: function () {},
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "admin";

    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
    assert.equal(win.document.getElementById("trophy").title, "");
    assertPersonalClickable(win.document);
    assert.equal(Gsm.playButton().style.pointerEvents, "none");

    // Lobby: must not enter focus seat / hide death
    app.renderFocusBoard();
    assert.equal(!!app._versusFocusSpectate, false);
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    assert.notEqual(death.style.visibility, "hidden");
    assertPersonalClickable(win.document);
  });

  it("Ready player locks match menus; Unready unlocks", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const me = { clientId: "p1", role: "player", ready: true };
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "p1",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return me;
      },
      roster: {
        mode: "versus",
        sessionActive: false,
        adminId: "admin",
        clients: [me],
      },
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "none");
    assert.equal(
      win.document.getElementById("trophy").title,
      "Unready to change settings"
    );
    me.ready = false;
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
  });

  it("admin player Unready keeps match menus unlocked in lobby", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let deathFull = 0;
    const prevShow = Gsm.showDeathScreen;
    Gsm.showDeathScreen = function (opts) {
      if (!opts || !opts.skipEscapeDispatch) deathFull++;
      if (prevShow) return prevShow.apply(this, arguments);
    };
    const me = { clientId: "admin", role: "player", ready: false };
    const app = new MultiplayerApp();
    let aborted = 0;
    app.client = {
      connected: true,
      clientId: "admin",
      isAdmin: function () {
        return true;
      },
      me: function () {
        return me;
      },
      roster: {
        mode: "versus",
        sessionActive: false,
        adminId: "admin",
        clients: [me],
      },
      sessionEnd: function () {
        aborted++;
      },
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
    assert.equal(win.document.getElementById("trophy").title, "");

    // Promote-to-player / lobby path must quit the engine so rows click
    app.clearSpectatorSeat();
    assert.ok(deathFull >= 1, "engine quit so trophy rows accept clicks");

    app.hookEscapeForAdmin();
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(aborted, 0, "lobby Escape must not abort the room");

    me.ready = true;
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "none");
    me.ready = false;
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
  });

  it("admin spectator in lobby: sync menus unlocked", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "admin",
      isAdmin: function () {
        return true;
      },
      me: function () {
        return { clientId: "admin", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: false,
        adminId: "admin",
        clients: [{ clientId: "admin", role: "spectator" }],
      },
      spectateFocus: function () {},
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
    assert.equal(win.document.getElementById("trophy").title, "");
    assertPersonalClickable(win.document);
    app.renderFocusBoard();
    assert.equal(!!app._versusFocusSpectate, false);
    assertPersonalClickable(win.document);
  });

  /** Roster as the server leaves it once the attempt is spent. */
  function overRoster(role) {
    return {
      mode: "versus",
      sessionActive: false,
      attemptExpired: true,
      allowNewRuns: false,
      adminId: "admin",
      clients: [{ clientId: "admin", role: role }],
    };
  }

  function seatedApp(win, MultiplayerApp, opts) {
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "admin",
      isAdmin: function () {
        return opts.admin;
      },
      me: function () {
        return { clientId: "admin", role: opts.role };
      },
      roster: opts.roster,
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    return app;
  }

  function countEscapes(win) {
    const seen = { n: 0 };
    win.document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") seen.n++;
    });
    return seen;
  }

  const nextTick = function () {
    return new Promise(function (r) {
      setTimeout(r, 5);
    });
  };

  it("match over: the admin who played gets the engine quit so settings answer", async () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = seatedApp(win, MultiplayerApp, {
      admin: true,
      role: "player",
      roster: overRoster("player"),
    });
    const esc = countEscapes(win);

    app.returnToMenus({ fromExpired: true });
    // Revealing the endscreen is chrome only; the quit signal waits a tick so
    // it never fires inside the handler that is still unwinding.
    assert.equal(esc.n, 0);
    await nextTick();
    assert.equal(esc.n, 1, "engine must be quit out of the spent run");
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
    assertPersonalClickable(win.document);

    // One release per match, however many end messages arrive
    app.returnToMenus({ fromRemote: true });
    await nextTick();
    assert.equal(esc.n, 1);
  });

  it("a live match, a spectating admin and plain players keep the engine alone", async () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const esc = countEscapes(win);

    const live = seatedApp(win, MultiplayerApp, {
      admin: true,
      role: "player",
      roster: { mode: "versus", sessionActive: true, adminId: "admin", clients: [] },
    });
    live.returnToMenus({});
    await nextTick();
    assert.equal(esc.n, 0, "a running match must not be quit from under us");

    const watching = seatedApp(win, MultiplayerApp, {
      admin: true,
      role: "spectator",
      roster: overRoster("spectator"),
    });
    watching.returnToMenus({ fromExpired: true });
    await nextTick();
    assert.equal(esc.n, 0, "a spectating admin had no run to quit");

    const guest = seatedApp(win, MultiplayerApp, {
      admin: false,
      role: "player",
      roster: overRoster("player"),
    });
    guest.returnToMenus({ fromRemote: true });
    await nextTick();
    assert.equal(esc.n, 0, "non-admins still leave on their own Escape");
  });

  it("End match quits the engine even if Escape was already latched", async () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = seatedApp(win, MultiplayerApp, {
      admin: true,
      role: "player",
      roster: {
        mode: "coop",
        sessionActive: true,
        adminId: "admin",
        clients: [{ clientId: "admin", role: "player" }],
      },
    });
    app._coopSessionActive = true;
    let ended = 0;
    app.client.sessionEnd = function () {
      ended++;
    };
    const esc = countEscapes(win);
    win.__mpEscHandling = true;
    app.abortMatchAsAdmin("ui");
    assert.equal(ended, 1);
    await nextTick();
    assert.equal(esc.n, 1, "End match must still send the engine quit");
    assert.equal(!!win.__mpEscHandling, false);
    assert.equal(app.client.roster.sessionActive, false);
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
  });

  it("versus focus during match: endscreen left alone, Escape peeks menus", async () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: true,
        adminId: "admin",
        clients: [
          { clientId: "admin", role: "player" },
          { clientId: "spec", role: "spectator" },
        ],
      },
      spectateFocus: function () {},
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "admin";
    app.versus.boards.admin = { width: 2, height: 2, body: [], apples: [] };

    let nativeRuns = 0;
    Gsm.triggerPlay = function () {};
    Gsm.startNativeRun = function () {
      nativeRuns++;
    };
    Gsm.drawBoardOnCanvas = function () {};
    app.renderFocusBoard();
    assert.equal(app._versusFocusSpectate, true);
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    const view = win.document.getElementById("mp-focus-view");
    assert.equal(view.style.display, "block");
    // Watching draws the board: no seat, and the endscreen is left as-is
    assert.equal(nativeRuns, 0);
    assert.notEqual(death.style.visibility, "hidden");

    // Wire Escape hook and peek
    app.hookEscapeForAdmin();
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(win.__mpSpectateAllowMenus, true);
    assert.notEqual(death.style.visibility, "hidden");
    assertPersonalClickable(win.document);

    // The label tick is the only thing still running — it must step aside for
    // the peek instead of bouncing the endscreen back and forth.
    await new Promise(function (r) {
      setTimeout(r, 260);
    });
    assert.notEqual(death.style.visibility, "hidden");
    assert.equal(view.style.display, "none");
    assert.equal(nativeRuns, 0);
    app._leaveVersusFocusSpectate();
  });

  it("click capture blocks sync menus only while Ready, not cosmetics", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    let colorClicks = 0;
    let trophyClicks = 0;
    const me = { role: "player", ready: true };
    app.client = {
      connected: true,
      clientId: "p1",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return me;
      },
    };
    app.hookAdminSettingsWatch();

    const color = win.document.getElementById("color").children[0];
    const trophy = win.document.getElementById("trophy").children[1];
    color.addEventListener("click", function () {
      colorClicks++;
    });
    trophy.addEventListener("click", function () {
      trophyClicks++;
    });

    color.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    trophy.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.equal(colorClicks, 1, "cosmetic click reaches target");
    assert.equal(trophyClicks, 0, "sync menu click blocked while Ready");

    me.ready = false;
    trophy.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.equal(trophyClicks, 1, "sync menu click reaches target when Unready");
  });

  it("hideControlHelper does not disable wrappers that own menu rows", () => {
    const win = menuDom();
    loadGsm(win);
    const Gsm = win.MultiplayerGsm;
    const wrap = win.document.createElement("div");
    wrap.style.position = "absolute";
    wrap.style.cssText =
      "position:absolute;left:10px;top:100px;width:200px;height:200px;";
    // Move menus under an absolute wrapper that would otherwise be tip-hidden
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    const inner = death.children[0];
    wrap.appendChild(inner);
    win.document.body.appendChild(wrap);
    Object.defineProperty(wrap, "getBoundingClientRect", {
      value: function () {
        return { width: 200, height: 200, top: 100, left: 10, right: 210, bottom: 300 };
      },
    });
    Gsm.hideControlHelper();
    assert.notEqual(wrap.dataset.mpHelperHidden, "1");
    assertPersonalClickable(win.document);
  });

  /** A menu row holding Google's Shuffle button, plus a click spy. */
  function shuffleDom(win) {
    const row = win.document.createElement("div");
    const shuffle = win.document.createElement("button");
    shuffle.setAttribute("jsname", "qycu7d");
    shuffle.textContent = "Shuffle";
    row.appendChild(shuffle);
    win.document.body.appendChild(row);
    win.random_button = shuffle;
    const spy = { shuffled: false };
    shuffle.addEventListener("click", function () {
      spy.shuffled = true;
    });
    return { row: row, shuffle: shuffle, spy: spy };
  }

  function readyApp(win, MultiplayerApp, opts) {
    const app = new MultiplayerApp();
    const me = { clientId: "p1", role: "player", ready: false };
    app.__me = me;
    app.__readySent = null;
    app.client = {
      connected: true,
      joined: true,
      clientId: "p1",
      isAdmin: function () {
        return !!(opts && opts.admin);
      },
      me: function () {
        return me;
      },
      setReady: function (v) {
        app.__readySent = v;
      },
      roster: {
        mode: "versus",
        clients: [{ clientId: "p1", role: "player", ready: false }],
      },
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    return app;
  }

  it("players ready on Shuffle, admin and guest alike (no shuffle on click)", () => {
    [false, true].forEach(function (admin) {
      const win = menuDom();
      const dom = shuffleDom(win);
      const MultiplayerApp = loadApp(win);
      const app = readyApp(win, MultiplayerApp, { admin: admin });
      const who = admin ? "admin" : "guest";

      app.hookInGameReadyButton();
      assert.equal(dom.shuffle.textContent, "Ready", who);
      assert.equal(dom.shuffle.style.backgroundColor, "rgb(183, 28, 28)", who);
      assert.ok(dom.shuffle.classList.contains("mp-ready-btn"), who);
      assert.ok(dom.shuffle.classList.contains("mp-ready-off"), who);

      dom.shuffle.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true })
      );
      assert.equal(dom.spy.shuffled, false, who + " must not randomize");
      assert.equal(app.__readySent, true, who);
      assert.equal(app.__me.ready, true, who);
      assert.equal(dom.shuffle.textContent, "Unready", who);
      assert.equal(dom.shuffle.style.backgroundColor, "rgb(27, 94, 32)", who);
      assert.ok(dom.shuffle.classList.contains("mp-ready-on"), who);

      // Spectators hand the real Shuffle back
      app.__me.role = "spectator";
      app._paintShuffleAsReady();
      assert.equal(dom.shuffle.__mpReadyMode, false, who);
    });
  });

  it("Ready keeps its colour when the theme repaints Shuffle", async () => {
    const win = menuDom();
    const dom = shuffleDom(win);
    const MultiplayerApp = loadApp(win);
    const app = readyApp(win, MultiplayerApp, { admin: true });
    app.hookInGameReadyButton();
    assert.equal(dom.shuffle.style.backgroundColor, "rgb(183, 28, 28)");

    // A theme switch drops Google's own colours back on the button
    dom.shuffle.classList.remove("mp-ready-btn", "mp-ready-off");
    dom.shuffle.style.background = "#4a752c";
    dom.shuffle.style.backgroundColor = "#4a752c";
    dom.shuffle.style.color = "#000";
    await nextTick();
    assert.equal(dom.shuffle.style.backgroundColor, "rgb(183, 28, 28)", "bg back");
    assert.equal(dom.shuffle.style.color, "rgb(255, 255, 255)", "text back");
    assert.equal(dom.shuffle.textContent, "Ready");

    // Remix restoring its saved label counts as a reset too
    dom.shuffle.innerHTML = "<span>Shuffle</span>";
    await nextTick();
    assert.equal(dom.shuffle.textContent, "Ready", "label back");

    // A menu rebuild hands us a different button: it gets painted and hooked
    dom.shuffle.remove();
    const fresh = win.document.createElement("button");
    fresh.setAttribute("jsname", "qycu7d");
    fresh.textContent = "Shuffle";
    dom.row.appendChild(fresh);
    win.random_button = fresh;
    await nextTick();
    assert.equal(fresh.textContent, "Ready", "replacement painted");
    fresh.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.equal(app.__readySent, true, "replacement toggles ready");
    assert.equal(fresh.textContent, "Unready");
  });
});
