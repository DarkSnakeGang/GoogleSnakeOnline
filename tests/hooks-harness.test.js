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
    assert.equal(realDie, 1, "real remote death may call through");
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

  it("emptyLocalSnakeBody clears ka for coop spectator", () => {
    win.__remixGame.oa.ka = [
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const ok = Gsm.emptyLocalSnakeBody();
    assert.equal(ok, true);
    assert.equal(win.__remixGame.oa.ka.length, 0);
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

  it("locks menus for non-admin sync", () => {
    Gsm.setNativeMenusLocked(true);
    const trophy = win.document.getElementById("trophy");
    assert.equal(trophy.style.pointerEvents, "none");
    assert.equal(trophy.title, "Synced from admin");
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
        "session/ready.js",
        "versus/scoreboard.js",
        "coop/state.js",
        "coop/native.js",
        "hooks/gsm.js",
        "net/client.js",
        "ui/settingsTab.js",
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
});

describe("versus Focus spectate (console / native inject)", () => {
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
      "session/ready.js",
      "versus/scoreboard.js",
      "coop/state.js",
      "coop/native.js",
      "hooks/gsm.js",
      "net/client.js",
      "ui/settingsTab.js",
      "mod.js",
    ].forEach(function (rel) {
      const p = require.resolve(path.join(ROOT, "src", rel));
      delete require.cache[p];
      require(path.join(ROOT, "src", rel));
    });
    return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
  }

  /** Mimic L3E / PlayerRenderer clone usage that crashes spectators in console. */
  function simulateNativeRender(game) {
    const errors = [];
    try {
      (game.oa.ka || []).forEach(function (seg) {
        if (!seg || typeof seg.clone !== "function") {
          throw new TypeError("seg.clone is not a function");
        }
        seg.clone(); // PlayerRenderer clones each segment once
      });
      (game.wa.ka || []).forEach(function (b) {
        if (!b || !b.pos || typeof b.pos.clone !== "function") {
          throw new TypeError("b.pos.clone is not a function");
        }
        const c = b.pos.clone(); // L3E.render: c.push(e.pos.clone())
        if (c == null || c.x == null || c.y == null) {
          throw new Error("pos.clone returned invalid point");
        }
      });
    } catch (e) {
      errors.push(e);
    }
    return errors;
  }

  it("Focus tick inject keeps cloneable body + apple.pos (no console TypeError)", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    const consoleErrors = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = function () {
      consoleErrors.push(Array.prototype.slice.call(arguments).join(" "));
    };
    console.warn = function () {
      consoleErrors.push(Array.prototype.slice.call(arguments).join(" "));
    };
    try {
      win.__remixGame = {
        oa: { ka: [], direction: null },
        wa: { ka: [] },
        settings: {},
      };
      win.__mpGame = win.__remixGame;
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
          clients: [
            { clientId: "admin", role: "player", colorId: 0 },
            { clientId: "spec", role: "spectator" },
          ],
        },
        spectateFocus: function () {},
      };
      app.versus.spectateMode = "focus";
      app.versus.focusClientId = "admin";
      app.versus.onBoardDelta({
        clientId: "admin",
        board: {
          score: 2,
          body: [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
            { x: 3, y: 5 },
          ],
          apples: [
            { x: 10, y: 8 },
            { x: 11, y: 9 },
          ],
          dir: "RIGHT",
          colorId: 0,
          sizeIndex: 0,
          countIndex: 1,
        },
      });
      app._installVersusFocusTick();
      win.__mpVersusFocusSpectate = true;
      win.__mpVersusFocusBoard = app.versus.boards.admin;

      assert.equal(app._paintVersusFocus(app.versus.boards.admin), true);
      let errs = simulateNativeRender(win.__remixGame);
      assert.equal(errs.length, 0, errs[0] && errs[0].message);
      assert.equal(win.__remixGame.oa.ka[0].x, 5);

      // Menu sync once — second paint must not re-select menus (log spam)
      let menuCalls = 0;
      win.puddingMenuSelect = function () {
        menuCalls++;
        return true;
      };
      win.__mpSpectateMenuFp = null;
      app._paintVersusFocus(app.versus.boards.admin);
      const firstMenus = menuCalls;
      app._paintVersusFocus(app.versus.boards.admin);
      assert.equal(menuCalls, firstMenus, "menus must not re-sync every frame");

      const firstBoardRef = win.__mpVersusFocusBoard;
      app.versus.onBoardDelta({
        clientId: "admin",
        board: {
          score: 4,
          body: [
            { x: 6, y: 5 },
            { x: 5, y: 5 },
            { x: 4, y: 5 },
            { x: 3, y: 5 },
          ],
          apples: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
            { x: 4, y: 4 },
            { x: 5, y: 1 },
          ],
          dir: "RIGHT",
          sizeIndex: 0,
          countIndex: 1,
        },
      });
      assert.notEqual(app.versus.boards.admin, firstBoardRef);
      win.__mpVersusFocusBoard = firstBoardRef;
      win.__mpFocusSeated = true;
      win.__mpVersusFocusOnTick();
      errs = simulateNativeRender(win.__remixGame);
      assert.equal(errs.length, 0, errs[0] && errs[0].message);
      assert.equal(win.__remixGame.wa.ka.length, 5);
      assert.equal(win.__remixGame.oa.ka[0].x, 6);

      const cloneNoise = consoleErrors.filter(function (m) {
        return /clone is not a function/i.test(m);
      });
      assert.deepEqual(cloneNoise, []);
    } finally {
      console.error = origErr;
      console.warn = origWarn;
    }
  });

  it("repeated Focus inject after plain-pos corruption recovers without throw", () => {
    const win = makeDom();
    loadApp(win);
    const Gsm = win.MultiplayerGsm;
    win.__remixGame = {
      oa: { ka: [{ x: 0, y: 0, clone: function () { return { x: this.x, y: this.y }; } }] },
      wa: {
        ka: [
          { pos: { x: 9, y: 9 }, type: 0 }, // corrupted spectate leftover
        ],
      },
    };
    win.__mpGame = win.__remixGame;
    Gsm.applySpectateState(null, {
      body: [{ x: 2, y: 2 }, { x: 1, y: 2 }],
      apples: [{ x: 7, y: 7 }, { x: 8, y: 8 }],
      dir: "LEFT",
    });
    const errs = simulateNativeRender(win.__remixGame);
    assert.equal(errs.length, 0, errs[0] && errs[0].message);
  });

  it("Focus enter uses startNativeRun (not a single Play click)", async () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let nativeStarts = 0;
    const prev = Gsm.startNativeRun;
    Gsm.startNativeRun = function (opts) {
      nativeStarts++;
      if (opts && opts.onDone) setTimeout(function () {
        opts.onDone(true);
      }, 0);
    };
    win.__remixGame = {
      oa: { ka: [{ x: 1, y: 1 }], direction: null },
      wa: { ka: [] },
      nj: false,
    };
    win.__mpGame = win.__remixGame;
    try {
      const app = new MultiplayerApp();
      app.client = {
        connected: true,
        clientId: "spec",
        me: function () {
          return { clientId: "spec", role: "spectator" };
        },
        spectateFocus: function () {},
        roster: {
          mode: "versus",
          sessionActive: true,
          clients: [
            { clientId: "p1", role: "player", colorId: 0 },
            { clientId: "spec", role: "spectator" },
          ],
        },
      };
      app.versus.spectateMode = "focus";
      app.versus.focusClientId = "p1";
      app.versus.boards.p1 = {
        body: [
          { x: 4, y: 4 },
          { x: 3, y: 4 },
        ],
        apples: [{ x: 8, y: 8 }],
        dir: "RIGHT",
      };
      app.startVersusFocusLoop = function () {};
      app.renderFocusBoard();
      assert.ok(nativeStarts >= 1, "versus Focus must startNativeRun");
      assert.equal(win.__mpVersusFocusSpectate, true);
      app.stopVersusFocusLoop();
      app._leaveVersusFocusSpectate();
      await new Promise(function (r) {
        setTimeout(r, 20);
      });
    } finally {
      Gsm.startNativeRun = prev;
    }
  });

  it("Focus enter does not ArrowRight-dismiss tip (wrong start seat)", async () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let arrowRight = 0;
    const prevDispatch = win.document.dispatchEvent.bind(win.document);
    win.document.dispatchEvent = function (ev) {
      if (ev && (ev.key === "ArrowRight" || ev.code === "ArrowRight")) {
        arrowRight++;
      }
      return prevDispatch(ev);
    };
    const prev = Gsm.startNativeRun;
    Gsm.startNativeRun = function (opts) {
      if (opts && opts.onDone) setTimeout(function () {
        opts.onDone(true);
      }, 0);
    };
    win.__remixGame = {
      oa: { ka: [{ x: 1, y: 1 }], direction: null },
      wa: { ka: [] },
      nj: false,
    };
    win.__mpGame = win.__remixGame;
    try {
      const app = new MultiplayerApp();
      app.client = {
        connected: true,
        clientId: "spec",
        me: function () {
          return { clientId: "spec", role: "spectator" };
        },
        spectateFocus: function () {},
        roster: {
          mode: "versus",
          sessionActive: true,
          clients: [
            { clientId: "p1", role: "player", colorId: 0 },
            { clientId: "spec", role: "spectator" },
          ],
        },
      };
      app.versus.spectateMode = "focus";
      app.versus.focusClientId = "p1";
      app.versus.boards.p1 = {
        alive: true,
        body: [
          { x: 4, y: 4 },
          { x: 3, y: 4 },
        ],
        apples: [{ x: 8, y: 8 }],
        dir: "RIGHT",
      };
      app.startVersusFocusLoop = function () {};
      app.renderFocusBoard();
      await new Promise(function (r) {
        setTimeout(r, 40);
      });
      assert.equal(arrowRight, 0, "ArrowRight tip dismiss moves local snake");
      assert.equal(win.__remixGame.oa.ka[0].x, 4);
      app.stopVersusFocusLoop();
      app._leaveVersusFocusSpectate();
    } finally {
      Gsm.startNativeRun = prev;
      win.document.dispatchEvent = prevDispatch;
    }
  });

  it("Focus revive after remote death re-runs startNativeRun", async () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let nativeStarts = 0;
    Gsm.startNativeRun = function (opts) {
      nativeStarts++;
      if (opts && opts.onDone) setTimeout(function () {
        opts.onDone(true);
      }, 0);
    };
    win.__remixGame = {
      oa: { ka: [{ x: 1, y: 1 }], direction: "RIGHT" },
      wa: { ka: [] },
      nj: false,
      die: function () {
        this.nj = true;
      },
    };
    win.__mpGame = win.__remixGame;
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      spectateFocus: function () {},
      roster: {
        mode: "versus",
        sessionActive: true,
        clients: [
          { clientId: "p1", role: "player", colorId: 0 },
          { clientId: "spec", role: "spectator" },
        ],
      },
    };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "p1";
    app.versus.boards.p1 = {
      alive: true,
      body: [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      dir: "RIGHT",
    };
    app.startVersusFocusLoop = function () {};
    app._versusFocusSpectate = true;
    win.__mpVersusFocusSpectate = true;
    win.__mpVersusFocusRemoteAlive = true;
    app._paintVersusFocus(app.versus.boards.p1);
    const afterEnter = nativeStarts;
    app.versus.boards.p1 = {
      alive: false,
      body: [{ x: 4, y: 4 }],
      dir: "RIGHT",
    };
    app._paintVersusFocus(app.versus.boards.p1);
    assert.equal(win.__remixGame.nj, true);
    // Death must clear first-run seat leftovers (not wait for revive edge only)
    assert.equal(win.__mpFocusSeated, false);
    assert.equal(win.__mpFocusForceFullBody, true);
    assert.equal(win.__mpFocusNativeOk, false);
    assert.equal(win.__mpFocusRequirePlay, true);
    // Corrupt local body mid-death so second life must full-seat, not head-only
    win.__remixGame.oa.ka = [
      { x: 99, y: 99, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
      { x: 98, y: 99, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
      { x: 97, y: 99, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
    ];
    win.__mpFocusSeated = true;
    app.versus.boards.p1 = {
      alive: true,
      body: [
        { x: 6, y: 2 },
        { x: 5, y: 2 },
      ],
      dir: "UP",
    };
    app._paintVersusFocus(app.versus.boards.p1);
    assert.equal(win.__mpFocusForceFullBody, false, "full seat consumes force flag");
    assert.equal(win.__remixGame.oa.ka.length, 2, "second life must full-seat new body");
    assert.equal(win.__remixGame.oa.ka[0].x, 6);
    assert.equal(win.__remixGame.oa.ka[1].x, 5);
    await new Promise(function (r) {
      setTimeout(r, 40);
    });
    assert.ok(
      nativeStarts > afterEnter,
      "player reset must re-seat Focus with startNativeRun"
    );
    assert.equal(win.__remixGame.nj, false);
    app._leaveVersusFocusSpectate();
  });

  it("Focus second PLAY_SYNC while mounted reseats like first enter", async () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    const starts = [];
    Gsm.startNativeRun = function (opts) {
      starts.push({
        requirePlayClick: !!(opts && opts.requirePlayClick),
        deferTimer: !!(opts && opts.deferTimer),
      });
      if (opts && opts.onDone) {
        setTimeout(function () {
          opts.onDone(true);
        }, 0);
      }
    };
    win.__remixGame = {
      oa: {
        ka: [
          { x: 1, y: 1, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
          { x: 0, y: 1, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
        ],
        direction: "RIGHT",
      },
      wa: { ka: [] },
      nj: false,
    };
    win.__mpGame = win.__remixGame;
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      spectateFocus: function () {},
      roster: {
        mode: "versus",
        sessionActive: true,
        clients: [
          { clientId: "p1", role: "player", colorId: 0 },
          { clientId: "spec", role: "spectator" },
        ],
      },
    };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "p1";
    app.versus.boards.p1 = {
      alive: true,
      body: [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      dir: "RIGHT",
      apples: [{ x: 8, y: 8 }],
    };
    app.startVersusFocusLoop = function () {};
    app.renderFocusBoard();
    await new Promise(function (r) {
      setTimeout(r, 20);
    });
    assert.ok(starts.length >= 1, "first Focus enter seats");
    assert.equal(starts[0].requirePlayClick, true);
    assert.equal(starts[0].deferTimer, true);
    const afterFirst = starts.length;

    // Leftovers as if run 1 finished while Focus stayed mounted (no SESSION_END leave)
    win.__mpFocusSeated = true;
    win.__mpFocusForceFullBody = false;
    win.__mpFocusRemoteStarted = true;
    win.__mpFocusRequirePlay = false;
    win.__mpFocusNativeOk = true;
    win.__mpVersusFocusRemoteAlive = true;
    win.__remixGame.oa.ka = [
      { x: 99, y: 99, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
      { x: 98, y: 99, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
      { x: 97, y: 99, clone: function () { return { x: this.x, y: this.y, clone: this.clone }; } },
    ];
    app.versus.boards.p1 = {
      alive: true,
      body: [
        { x: 2, y: 7 },
        { x: 1, y: 7 },
      ],
      dir: "LEFT",
      apples: [{ x: 5, y: 5 }],
    };

    // Second Start match while still in Focus — must reseat like first enter
    assert.equal(app._versusFocusSpectate, true);
    app._reseatVersusFocusForNewRun("play_sync");
    await new Promise(function (r) {
      setTimeout(r, 20);
    });
    assert.ok(starts.length > afterFirst, "second run must call startNativeRun again");
    const last = starts[starts.length - 1];
    assert.equal(last.requirePlayClick, true);
    assert.equal(last.deferTimer, true);
    assert.equal(win.__mpFocusRemoteStarted, false);
    // onDone may have already painted once — either way next inject must full-seat
    win.__mpFocusForceFullBody = true;
    win.__mpFocusSeated = false;
    app._paintVersusFocus(app.versus.boards.p1);
    assert.equal(win.__remixGame.oa.ka.length, 2);
    assert.equal(win.__remixGame.oa.ka[0].x, 2);
    assert.equal(win.__remixGame.oa.ka[1].x, 1);
    app._leaveVersusFocusSpectate();
  });

  it("Focus failed seat keeps requirePlay so retries still click Play", async () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let nativeStarts = 0;
    let requirePlayOpts = [];
    Gsm.startNativeRun = function (opts) {
      nativeStarts++;
      requirePlayOpts.push(!!(opts && opts.requirePlayClick));
      if (opts && opts.onDone) {
        setTimeout(function () {
          // First attempt fails — old bug cleared requirePlay and stalled forever
          opts.onDone(nativeStarts === 1 ? false : true);
        }, 0);
      }
    };
    win.__remixGame = {
      oa: { ka: [{ x: 1, y: 1 }], direction: null },
      wa: { ka: [] },
      nj: false,
    };
    win.__mpGame = win.__remixGame;
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
      spectateFocus: function () {},
      roster: {
        mode: "versus",
        sessionActive: true,
        clients: [
          { clientId: "p1", role: "player", colorId: 0 },
          { clientId: "spec", role: "spectator" },
        ],
      },
    };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "p1";
    app.versus.boards.p1 = {
      alive: true,
      body: [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      dir: "RIGHT",
    };
    app.startVersusFocusLoop = function () {};
    app.renderFocusBoard();
    await new Promise(function (r) {
      setTimeout(r, 20);
    });
    assert.equal(win.__mpFocusRequirePlay, true, "failed seat must keep Play gate");
    assert.equal(win.__mpFocusNativeOk, false);
    await new Promise(function (r) {
      setTimeout(r, 300);
    });
    assert.ok(nativeStarts >= 2, "must retry native seat after failure");
    assert.ok(requirePlayOpts.every(Boolean), "every seat attempt requires Play");
    assert.equal(win.__mpFocusNativeOk, true);
    assert.equal(win.__mpFocusRequirePlay, false);
    app._leaveVersusFocusSpectate();
  });

  it("Focus admin and non-admin both seat via _seatVersusFocusNative", async () => {
    async function seatAs(isAdmin) {
      const win = makeDom();
      const MultiplayerApp = loadApp(win);
      const Gsm = win.MultiplayerGsm;
      let optsSeen = null;
      Gsm.startNativeRun = function (opts) {
        optsSeen = opts;
        if (opts && opts.onDone) setTimeout(function () {
          opts.onDone(true);
        }, 0);
      };
      win.__remixGame = {
        oa: { ka: [{ x: 0, y: 0 }], direction: null },
        wa: { ka: [] },
        nj: false,
      };
      win.__mpGame = win.__remixGame;
      const app = new MultiplayerApp();
      app.client = {
        connected: true,
        clientId: isAdmin ? "admin" : "spec",
        isAdmin: function () {
          return isAdmin;
        },
        me: function () {
          return {
            clientId: isAdmin ? "admin" : "spec",
            role: "spectator",
          };
        },
        spectateFocus: function () {},
        roster: {
          mode: "versus",
          sessionActive: true,
          adminId: "admin",
          clients: [
            { clientId: "p1", role: "player", colorId: 0 },
            { clientId: "admin", role: "spectator" },
            { clientId: "spec", role: "spectator" },
          ],
        },
      };
      app.versus.spectateMode = "focus";
      app.versus.focusClientId = "p1";
      app.versus.boards.p1 = {
        alive: true,
        body: [
          { x: 2, y: 2 },
          { x: 1, y: 2 },
        ],
        dir: "RIGHT",
      };
      app.startVersusFocusLoop = function () {};
      app.renderFocusBoard();
      await new Promise(function (r) {
        setTimeout(r, 20);
      });
      return { win: win, optsSeen: optsSeen, app: app };
    }
    const admin = await seatAs(true);
    const spec = await seatAs(false);
    assert.equal(!!admin.optsSeen.requirePlayClick, true);
    assert.equal(!!admin.optsSeen.deferTimer, true);
    assert.equal(!!spec.optsSeen.requirePlayClick, true);
    assert.equal(!!spec.optsSeen.deferTimer, true);
    assert.equal(admin.win.__mpFocusNativeOk, true);
    assert.equal(spec.win.__mpFocusNativeOk, true);
    admin.app._leaveVersusFocusSpectate();
    spec.app._leaveVersusFocusSpectate();
  });

  it("Focus death gate: false local die ignored; remote death sticks", () => {
    const win = makeDom();
    loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let realDie = 0;
    win.__remixGame = {
      oa: {
        ka: [
          { x: 3, y: 3 },
          { x: 2, y: 3 },
        ],
        direction: "RIGHT",
      },
      wa: { ka: [] },
      nj: false,
      die: function () {
        realDie++;
        this.nj = true;
      },
    };
    win.__mpGame = win.__remixGame;
    win.timeKeeper = { _dead: false, playing: false };
    win.__mpVersusFocusSpectate = true;
    win.__mpFocusSeated = false;
    win.__mpVersusFocusBoard = {
      alive: true,
      body: [
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
      dir: "RIGHT",
    };
    Gsm.applySpectateState(null, win.__mpVersusFocusBoard);
    win.__remixGame.die();
    assert.equal(realDie, 0);
    assert.equal(win.__remixGame.nj, false);
    win.__mpVersusFocusBoard = {
      alive: false,
      body: [{ x: 3, y: 3 }],
      dir: "RIGHT",
    };
    Gsm.applySpectateState(null, win.__mpVersusFocusBoard);
    assert.equal(win.__remixGame.nj, true);
    win.__remixGame.die();
    assert.equal(realDie, 1);
  });

  it("Focus non-admin uses native inject (no canvas paint fallback)", () => {
    const win = makeDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    let fillCalls = 0;
    const canvas = win.document.querySelector("canvas.nEoGkc");
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
    win.__remixGame = {
      oa: {
        ka: [
          {
            x: 0,
            y: 0,
            clone: function () {
              return { x: this.x, y: this.y, clone: this.clone };
            },
          },
        ],
        direction: null,
      },
      wa: { ka: [] },
      nj: false,
    };
    win.__mpGame = win.__remixGame;
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
        clients: [
          { clientId: "admin", role: "player", colorId: 4 },
          { clientId: "spec", role: "spectator" },
        ],
      },
      spectateFocus: function () {},
    };
    app.versus.focusClientId = "admin";
    app.versus.boards.admin = {
      alive: true,
      body: [
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
      apples: [{ x: 9, y: 9 }],
      dir: "UP",
      width: 17,
      height: 15,
    };
    win.__mpVersusFocusSpectate = true;
    // Stale flag from older builds must not force square paint
    win.__mpVersusFocusPaintFallback = true;
    Gsm.gameCanvas = function () {
      return canvas;
    };
    assert.equal(app._paintVersusFocus(app.versus.boards.admin), true);
    assert.equal(fillCalls, 0, "non-admin Focus must stay native");
    assert.equal(win.__remixGame.oa.ka[0].x, 3);
  });
});

describe("Multiplayer settings tab layout", () => {
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

  it("hides versus duration in coop and gates End match on sessionActive", () => {
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
    assert.ok(durField);
    assert.ok(goalField);
    assert.ok(endBtn);

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
    assert.equal(win.document.getElementById("mp-versus-goal").value, "best50");

    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.notEqual(endBtn.style.display, "none");

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

    ui.renderRoster({
      mode: "coop",
      roomCode: "ABCD",
      sessionActive: false,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.equal(durField.style.display, "none");
    assert.equal(endBtn.style.display, "none");
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
      "session/ready.js",
      "versus/scoreboard.js",
      "coop/state.js",
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

  it("non-admin spectator: sync menus locked, cosmetics + Escape peek stay usable", () => {
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
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "none");
    assert.equal(win.document.getElementById("trophy").title, "Synced from admin");
    assertPersonalClickable(win.document);
    assert.equal(Gsm.playButton().style.pointerEvents, "none");

    // Lobby: must not enter focus seat / hide death
    app.renderFocusBoard();
    assert.equal(!!app._versusFocusSpectate, false);
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    assert.notEqual(death.style.visibility, "hidden");
    assertPersonalClickable(win.document);
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

  it("versus focus during match: Escape peeks menus and stops re-hiding death", async () => {
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

    Gsm.triggerPlay = function () {};
    Gsm.startNativeRun = function (opts) {
      if (opts && opts.onDone) setTimeout(function () {
        opts.onDone(true);
      }, 0);
    };
    app.startVersusFocusLoop = function () {};
    app.renderFocusBoard();
    assert.equal(app._versusFocusSpectate, true);
    // startNativeRun is async — wait for Focus Play seat to clear requirePlay
    await new Promise(function (r) {
      setTimeout(r, 20);
    });
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    assert.equal(death.style.visibility, "hidden");

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

    // Focus loop must not re-hide while peek is on
    await new Promise(function (r) {
      setTimeout(r, 30);
    });
    assert.notEqual(death.style.visibility, "hidden");
    app._leaveVersusFocusSpectate();
  });

  it("click capture blocks only sync menus for non-admin, not cosmetics", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    let colorClicks = 0;
    let trophyClicks = 0;
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { role: "spectator" };
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
    assert.equal(trophyClicks, 0, "sync menu click blocked for non-admin");
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
});
