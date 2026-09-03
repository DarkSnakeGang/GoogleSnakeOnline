"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const Gsm = require(path.join(__dirname, "..", "src/hooks/gsm.js"));

describe("gsm hooks", () => {
  it("exposes play/fullscreen helpers and settings snapshot", () => {
    assert.equal(typeof Gsm.playButton, "function");
    assert.equal(typeof Gsm.fullscreenButton, "function");
    assert.equal(typeof Gsm.applySettings, "function");
    assert.equal(typeof Gsm.triggerPlay, "function");
    assert.equal(typeof Gsm.scrapeBoard, "function");
    assert.equal(typeof Gsm.alterSnakeCodeExposeGame, "function");
    assert.equal(typeof Gsm.applySpectateState, "function");
    assert.equal(typeof Gsm.resolveThemeColors, "function");
    assert.equal(typeof Gsm.applyCoopSpawnOffset, "function");
    assert.equal(typeof Gsm.parkLocalSnakeOffBoard, "function");
    assert.equal(typeof Gsm.emptyLocalSnakeBody, "function");
    assert.equal(typeof Gsm.hideControlHelper, "function");
    assert.equal(typeof Gsm.restoreControlHelper, "function");
    assert.equal(typeof Gsm.installFirstRunControlTipGuard, "function");
    assert.equal(typeof Gsm.startCoopRunTimer, "function");
    assert.equal(typeof Gsm.stopCoopRunTimer, "function");
    assert.equal(typeof Gsm.installSpectatorTimeKeeperGuard, "function");
    assert.equal(typeof Gsm.isSpectatingForTimeKeeper, "function");
    assert.equal(typeof Gsm.scrapeCoopSnakeDelta, "function");
    assert.equal(typeof Gsm.snakeDeltaFingerprint, "function");
    assert.equal(typeof Gsm.resolveAppleImageUrl, "function");
    assert.equal(typeof Gsm.drawWallSolverStyleSnake, "function");
  });

  it("patches __remixGame expose to also set __mpGame", () => {
    const inCode = "}tick(){window.__remixGame=this;var a=1;";
    const out = Gsm.alterSnakeCodeExposeGame(inCode);
    assert.ok(out.indexOf("window.__mpGame=this") >= 0);
    assert.ok(out.indexOf("window.__remixGame=this") >= 0);
    assert.ok(out.indexOf("__mpCoopOnTick") >= 0);
    assert.ok(out.indexOf("__mpVersusFocusOnTick") >= 0);
  });

  it("injects __mpGame on plain tick(){", () => {
    const out = Gsm.alterSnakeCodeExposeGame("tick(){foo();}");
    assert.ok(out.indexOf("window.__mpGame=this") >= 0);
    assert.ok(out.indexOf("window.__remixGame=this") >= 0);
    assert.ok(out.indexOf("__mpCoopOnTick") >= 0);
  });

  it("hooks snake render enter for native companions", () => {
    const out = Gsm.alterSnakeCodeExposeGame(
      "render(a,b,c){var d=a;J5E(this,f,d,!1,!1);}"
    );
    assert.ok(out.indexOf("__mpCoopRenderEnter") >= 0);
    assert.ok(out.indexOf("__mpCoopAfterSnakeRender") >= 0);
    assert.ok(out.indexOf("__mpCoopFreePos") >= 0);
  });

  it("drawBoardOnCanvas paints without throwing", () => {
    // Minimal canvas mock
    const ops = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      fillRect: function () { ops.push("rect"); },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () { ops.push("line"); },
      stroke: function () { ops.push("stroke"); },
      arc: function () {},
      fill: function () { ops.push("fill"); },
      drawImage: function () { ops.push("fruit"); },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const canvas = {
      width: 240,
      height: 212,
      getContext: function () { return ctx; },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 17,
      height: 15,
      body: [{ x: 1, y: 1 }, { x: 0, y: 1 }],
      apples: [{ x: 3, y: 3, type: 2 }],
      appleIndex: 2,
      dir: "RIGHT",
    });
    assert.ok(ops.indexOf("rect") >= 0);
    assert.ok(ops.indexOf("stroke") >= 0, "WallSolver-style body stroke");
    assert.ok(ops.indexOf("fill") >= 0, "head/eyes filled");
  });

  it("drawBoardOnCanvas cheese mode gaps light-tile body segments", () => {
    const strokes = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      setLineDash: function () {},
      fillRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      stroke: function () {
        strokes.push(1);
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const canvas = {
      width: 240,
      height: 212,
      getContext: function () {
        return ctx;
      },
    };
    // Head at (1,1) solid; (0,1) is light hole; (0,0) solid — cheese gaps
    Gsm.drawBoardOnCanvas(
      canvas,
      {
        width: 17,
        height: 15,
        modeKey: "cheese",
        body: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
          { x: 0, y: 0 },
        ],
        apples: [],
        dir: "RIGHT",
      },
      { primary: "#F53D40", secondary: "#D00B0E" }
    );
    assert.ok(strokes.length > 0, "cheese snake still strokes solid runs");
    assert.equal(Gsm.boardHasMode({ modeKey: "cheese" }, "cheese"), true);
    assert.equal(Gsm.boardHasMode({ modeKey: "wall+portal" }, "portal"), true);
  });

  it("collectMosaicLights sizes head/fruit/object radii like native", () => {
    const lights = Gsm.collectMosaicLights({
      modeKey: "light",
      headLight: 3.5,
      body: [{ x: 5, y: 5 }],
      apples: [
        { x: 8, y: 5, light: 1.5 },
        { x: 0, y: 0, light: 0 },
      ],
      mines: [{ x: 10, y: 10 }],
      keys: [{ x: 2, y: 2 }],
    });
    assert.ok(lights && lights.length >= 3);
    const head = lights.find(function (L) {
      return L.x === 5.5 && L.y === 5.5;
    });
    assert.ok(head);
    assert.equal(head.r, 3.5);
    const fruit = lights.find(function (L) {
      return L.x === 8.5 && L.y === 5.5;
    });
    assert.ok(fruit);
    assert.equal(fruit.r, 1.5);
    const deadFruit = lights.find(function (L) {
      return L.x === 0.5 && L.y === 0.5;
    });
    assert.equal(deadFruit, undefined);
    const mine = lights.find(function (L) {
      return L.x === 10.5 && L.y === 10.5;
    });
    assert.ok(mine);
    assert.equal(mine.r, Gsm.LIGHT_OBJECT_RADIUS);
    assert.equal(Gsm.LIGHT_HEAD_FLOOR, 2);
    assert.equal(Gsm.LIGHT_FRUIT_DEFAULT, 1.5);
    const floored = Gsm.collectMosaicLights({
      modeKey: "light",
      headLight: 1,
      body: [{ x: 0, y: 0 }],
      apples: [],
    });
    assert.equal(floored[0].r, 2);
  });

  it("drawBoardOnCanvas light mode hides far objects and keeps lit ones", () => {
    const fills = [];
    const arcs = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      setLineDash: function () {},
      fillRect: function (x, y, w, h) {
        fills.push({ x: x, y: y, w: w, h: h, style: this.fillStyle });
      },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      strokeRect: function () {},
      arc: function (cx, cy, r) {
        arcs.push({ cx: cx, cy: cy, r: r });
      },
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      createRadialGradient: function (x0, y0, r0, x1, y1, r1) {
        return {
          _r: r1,
          addColorStop: function () {},
        };
      },
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: function () {
        return ctx;
      },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 10,
      height: 10,
      modeKey: "light",
      headLight: 2,
      body: [
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 8, y: 8 },
      ],
      apples: [
        { x: 1, y: 4, light: 1.5 },
        { x: 9, y: 0, light: 0 },
      ],
      mines: [{ x: 9, y: 9 }],
      statues: [{ x: 9, y: 1 }],
    });
    const lights = Gsm.collectMosaicLights({
      modeKey: "light",
      headLight: 2,
      body: [{ x: 1, y: 1 }],
      apples: [
        { x: 1, y: 4, light: 1.5 },
        { x: 9, y: 0, light: 0 },
      ],
      mines: [{ x: 9, y: 9 }],
      statues: [{ x: 9, y: 1 }],
    });
    assert.equal(Gsm.mosaicCellLit(1, 1, lights), true);
    assert.equal(Gsm.mosaicCellLit(1, 4, lights), true);
    assert.equal(Gsm.mosaicCellLit(9, 9, lights), true);
    assert.equal(Gsm.mosaicCellLit(9, 1, lights), true);
    assert.equal(Gsm.mosaicCellLit(5, 5, lights), false);
    const headHalo = arcs.find(function (a) {
      return Math.abs(a.r - 20) < 0.01;
    });
    const fruitHalo = arcs.find(function (a) {
      return Math.abs(a.r - 15) < 0.01;
    });
    assert.ok(headHalo, "head halo radius 2 tiles");
    assert.ok(fruitHalo, "fruit halo radius 1.5 tiles");
    assert.ok(fills.length > 20, "board tiles painted");
  });

  it("scrapeBoard picks up snake.Aa.light and apple.light", () => {
    const prevDoc = global.document;
    global.document = {
      querySelector: function () {
        return null;
      },
      querySelectorAll: function () {
        return [];
      },
      getElementById: function () {
        return null;
      },
      getElementsByClassName: function () {
        return [];
      },
    };
    global.__remixGame = {
      oa: {
        ka: [
          { x: 3, y: 3 },
          { x: 2, y: 3 },
        ],
        direction: "RIGHT",
        Aa: { light: 4.2 },
        Ba: { light: 2.5 },
      },
      wa: {
        ka: [{ pos: { x: 6, y: 6 }, light: 1.3 }],
        oa: { oa: { width: 10, height: 10 } },
      },
      settings: {},
    };
    const prevMode = global.ModeRegistry;
    global.ModeRegistry = {
      getCurrentModeKey: function () {
        return "light";
      },
    };
    try {
      const board = Gsm.scrapeBoard({});
      assert.equal(board.headLight, 4.2);
      assert.equal(board.headLight2, 2.5);
      assert.ok(board.apples && board.apples[0]);
      assert.equal(board.apples[0].light, 1.3);
    } finally {
      delete global.__remixGame;
      if (prevMode) global.ModeRegistry = prevMode;
      else delete global.ModeRegistry;
      if (prevDoc) global.document = prevDoc;
      else delete global.document;
    }
  });

  it("portal body is not stroked across teleport gap", () => {
    assert.equal(
      Gsm.bodySegmentsAdjacent({ x: 2, y: 5 }, { x: 3, y: 5 }),
      true
    );
    assert.equal(
      Gsm.bodySegmentsAdjacent({ x: 2, y: 5 }, { x: 8, y: 5 }),
      false
    );
    const strokes = [];
    const lineSpans = [];
    let last = null;
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      setLineDash: function () {},
      fillRect: function () {},
      beginPath: function () {
        last = null;
      },
      moveTo: function (x, y) {
        last = [x, y];
      },
      lineTo: function (x, y) {
        if (last) {
          lineSpans.push(Math.hypot(x - last[0], y - last[1]));
        }
        last = [x, y];
      },
      quadraticCurveTo: function (cpx, cpy, x, y) {
        if (last) {
          lineSpans.push(Math.hypot(x - last[0], y - last[1]));
        }
        last = [x, y];
      },
      bezierCurveTo: function (_a, _b, _c, _d, x, y) {
        if (last) {
          lineSpans.push(Math.hypot(x - last[0], y - last[1]));
        }
        last = [x, y];
      },
      stroke: function () {
        strokes.push(1);
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const cell = 10;
    // Head exits portal at (8,5); remainder still entering at (2,5) — not adjacent
    Gsm.drawWallSolverStyleSnake(
      ctx,
      [
        { x: 9, y: 5 },
        { x: 8, y: 5 },
        { x: 2, y: 5 },
        { x: 1, y: 5 },
      ],
      0,
      0,
      cell,
      { primary: "#4E7CF6", secondary: "#17439F" },
      "RIGHT",
      {}
    );
    assert.ok(strokes.length >= 2, "separate runs for each portal side");
    const longBridge = lineSpans.some(function (d) {
      return d > cell * 3;
    });
    assert.equal(longBridge, false, "no stroke spanning entry→exit portal");
  });

  it("borderless/peaceful wrap does not stroke across the board", () => {
    assert.equal(Gsm.boardWraps({ modeKey: "borderless" }), true);
    assert.equal(Gsm.boardWraps({ modeKey: "peaceful" }), true);
    assert.equal(Gsm.boardWraps({ modeKey: "wall+peaceful" }), true);
    assert.equal(Gsm.boardWraps({ modeKey: "classic" }), false);
    assert.deepEqual(Gsm.normalizeBodyCell({ x: 17, y: 5 }, 17, 15), {
      x: 0,
      y: 5,
    });
    assert.deepEqual(Gsm.normalizeBodyCell({ x: -1, y: 5 }, 17, 15), {
      x: 16,
      y: 5,
    });

    const strokes = [];
    const lineSpans = [];
    let last = null;
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      setLineDash: function () {},
      fillRect: function () {},
      beginPath: function () {
        last = null;
      },
      moveTo: function (x, y) {
        last = [x, y];
      },
      lineTo: function (x, y) {
        if (last) lineSpans.push(Math.hypot(x - last[0], y - last[1]));
        last = [x, y];
      },
      stroke: function () {
        strokes.push(1);
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const cell = 10;
    // Unwrapped wrap step: 17 is adjacent to 16 in engine space, but on a
    // width-17 board that is the right-edge → left-edge jump.
    Gsm.drawWallSolverStyleSnake(
      ctx,
      [
        { x: 17, y: 5 },
        { x: 16, y: 5 },
        { x: 15, y: 5 },
      ],
      0,
      0,
      cell,
      { primary: "#4E7CF6", secondary: "#17439F" },
      "RIGHT",
      { wrapWidth: 17, wrapHeight: 15 }
    );
    assert.ok(strokes.length >= 2, "wrap jump starts a new run");
    const longBridge = lineSpans.some(function (d) {
      return d > cell * 3;
    });
    assert.equal(longBridge, false, "no stroke across the full row");

    // Already-wrapped coords (0 next to 16) must also split
    strokes.length = 0;
    lineSpans.length = 0;
    Gsm.drawWallSolverStyleSnake(
      ctx,
      [
        { x: 0, y: 5 },
        { x: 16, y: 5 },
        { x: 15, y: 5 },
      ],
      0,
      0,
      cell,
      { primary: "#4E7CF6", secondary: "#17439F" },
      "RIGHT",
      { wrapWidth: 17, wrapHeight: 15 }
    );
    assert.ok(strokes.length >= 2, "wrapped edge pair splits");
    assert.equal(
      lineSpans.some(function (d) {
        return d > cell * 3;
      }),
      false
    );
  });

  it("drawBoardOnCanvas portal mode links matching fruit types", () => {
    const dashes = [];
    const lines = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      setLineDash: function (d) {
        dashes.push(d && d.length ? "dash" : "solid");
      },
      fillRect: function () {},
      beginPath: function () {},
      moveTo: function (x, y) {
        lines.push(["m", x, y]);
      },
      lineTo: function (x, y) {
        lines.push(["l", x, y]);
      },
      stroke: function () {
        lines.push(["s"]);
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const canvas = {
      width: 240,
      height: 212,
      getContext: function () {
        return ctx;
      },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 17,
      height: 15,
      modeKey: "portal",
      body: [{ x: 1, y: 1 }],
      apples: [
        { x: 2, y: 2, type: 5 },
        { x: 8, y: 8, type: 5 },
      ],
      dir: "RIGHT",
    });
    assert.ok(dashes.indexOf("dash") >= 0, "portal pairs use dashed links");
    assert.ok(lines.some(function (op) { return op[0] === "l"; }), "draws portal link");
  });

  it("drawBoardOnCanvas paints walls for wall modes", () => {
    const fills = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      fillRect: function (x, y, w, h) {
        fills.push({ x: x, y: y, w: w, h: h, style: this.fillStyle });
      },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 170,
      height: 150,
      getContext: function () {
        return ctx;
      },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 10,
      height: 10,
      modeKey: "wall",
      walls: [{ x: 3, y: 4 }],
      body: [{ x: 1, y: 1 }],
      apples: [],
      themeColors: { light: "#aaa", dark: "#bbb", border: "#112233" },
    });
    const wallFill = fills.some(function (f) {
      return f.style === "#112233" && f.w > 0 && f.x > 0;
    });
    assert.ok(wallFill, "wall cells painted with border color");
  });

  it("filterMosaicWalls drops illegal corner walls but keeps temp/lock", () => {
    assert.equal(Gsm.isIllegalNormalWallCell(0, 0, 10, 10), true);
    assert.equal(Gsm.isIllegalNormalWallCell(1, 1, 10, 10), true);
    assert.equal(Gsm.isIllegalNormalWallCell(9, 0, 10, 10), true);
    assert.equal(Gsm.isIllegalNormalWallCell(3, 4, 10, 10), false);
    const filtered = Gsm.filterMosaicWalls(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 3, y: 4 },
        { x: 0, y: 0, temp: true },
        { x: 9, y: 9, lock: true },
      ],
      10,
      10
    );
    assert.equal(filtered.length, 3);
    assert.equal(filtered[0].x, 3);
    assert.equal(filtered[1].temp, true);
    assert.equal(filtered[2].lock, true);
  });

  it("drawBoardOnCanvas ignores phantom corner walls", () => {
    const fills = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      fillRect: function (x, y, w, h) {
        fills.push({ x: x, y: y, w: w, h: h, style: this.fillStyle });
      },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: function () {
        return ctx;
      },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 10,
      height: 10,
      modeKey: "wall",
      walls: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 9, y: 9 },
        { x: 5, y: 5 },
      ],
      body: [],
      apples: [],
      themeColors: { light: "#aaa", dark: "#bbb", border: "#WALLX" },
    });
    const wallCells = fills.filter(function (f) {
      return f.style === "#WALLX" && f.w === 10 && f.h === 10;
    });
    assert.equal(wallCells.length, 1);
    assert.equal(wallCells[0].x, 50);
    assert.equal(wallCells[0].y, 50);
  });

  it("drawBoardOnCanvas paints mode entities (key/soko/mine/statue/gate/bridge/arrow)", () => {
    const ops = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      fillRect: function () {
        ops.push("fillRect:" + this.fillStyle);
      },
      strokeRect: function () {
        ops.push("strokeRect:" + this.strokeStyle);
      },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {
        ops.push("stroke:" + this.strokeStyle);
      },
      arc: function () {},
      fill: function () {
        ops.push("fill:" + this.fillStyle);
      },
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 170,
      height: 150,
      getContext: function () {
        return ctx;
      },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 10,
      height: 10,
      modeKey: "key+sokoban+minesweeper+statue+gate+bridge+arrow",
      walls: [{ x: 0, y: 0, lock: true }],
      keys: [{ x: 1, y: 1, type: 3, keyblock: { x: 2, y: 2 } }],
      boxes: [{ x: 3, y: 3 }],
      goals: [{ x: 4, y: 4 }],
      mines: [{ x: 5, y: 5 }],
      statues: [{ x: 6, y: 6, cracked: true }],
      bridges: [{ x: 7, y: 7 }],
      gates: [{ x: 8, y: 8 }],
      arrows: [{ x: 9, y: 1, dir: "RIGHT" }],
      body: [{ x: 1, y: 8 }],
      apples: [{ x: 2, y: 8, shields: ["UP", "LEFT"] }],
      themeColors: { light: "#111111", dark: "#222222", border: "#33bb44" },
    });
    const joined = ops.join("|");
    assert.ok(joined.indexOf("#a0522d") >= 0, "sokoban box");
    assert.ok(joined.indexOf("strokeRect:#f23606") >= 0, "mine danger radius");
    assert.ok(joined.indexOf("#c62828") >= 0, "mine flag fallback");
    assert.ok(joined.indexOf("#9e9e9e") >= 0, "cracked statue");
    assert.ok(joined.indexOf("#ffd54f") >= 0, "key diamond");
    assert.ok(joined.indexOf("#e68f1b") >= 0, "bridge");
    // Native strokes shields in the theme's wall colour, not a fixed blue
    assert.ok(joined.indexOf("stroke:#33bb44") >= 0, "shield ticks use walls");
    assert.equal(joined.indexOf("rgba(70,160,255"), -1, "no hardcoded blue");
  });

  it("drawBoardOnCanvas paints bridges as full-cell solid tiles", () => {
    const fills = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      fillRect: function (x, y, w, h) {
        fills.push({ style: this.fillStyle, x: x, y: y, w: w, h: h });
      },
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: function () {
        return ctx;
      },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 5,
      height: 5,
      modeKey: "bridge",
      bridges: [{ x: 2, y: 1, color: "#c45a10" }],
      body: [],
      apples: [],
    });
    const bridge = fills.find(function (f) {
      return f.style === "#c45a10";
    });
    assert.ok(bridge, "uses scraped bridge color");
    // Full cell (no pad inset): w/h should match the mosaic cell size
    assert.ok(bridge.w > 0 && bridge.w === bridge.h, "square cell");
    const cellish = fills.some(function (f) {
      return f.style === "#c45a10" && Math.abs(f.w - f.h) < 0.01;
    });
    assert.ok(cellish);
  });

  it("drawBoardOnCanvas draws slot mode badges over fruit", () => {
    global.window = global;
    // Remix owns the mode→icon mapping; the mosaic must use it
    const asked = [];
    global.slot_trophy_url_for_mode = function (m) {
      asked.push(m);
      return "https://example.test/badge_" + m + ".png";
    };
    global.apple_img_arr = ["https://example.test/fruit.png"];
    global.Image = function FakeImage() {
      this.complete = true;
      this.naturalWidth = 64;
      this.onload = null;
      this.onerror = null;
      let src = "";
      Object.defineProperty(this, "src", {
        set: function (v) { src = v; },
        get: function () { return src; },
      });
    };
    const draws = [];
    const fills = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      fillRect: function () {},
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      roundRect: function (x, y, w, h) {
        fills.push({ style: this.fillStyle, w: w, h: h });
      },
      fill: function () {},
      drawImage: function (img, x, y, w, h) {
        draws.push({ src: img && img.src, x: x, y: y, w: w, h: h });
      },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 170,
      height: 150,
      getContext: function () { return ctx; },
    };
    try {
      Gsm.drawBoardOnCanvas(canvas, {
        width: 17,
        height: 15,
        modeKey: "slot_machine",
        body: [],
        apples: [
          { x: 2, y: 2, type: 0, slotMode: 26 },
          { x: 5, y: 5, type: 0 },            // unbadged fruit
          { x: 7, y: 7, type: 0, poison: true }, // hazards never badge
        ],
      });
      assert.ok(asked.indexOf(26) >= 0, "resolves badge through Remix");
      const badge = draws.find(function (d) {
        return /badge_26/.test(String(d.src));
      });
      assert.ok(badge, "badge icon drawn");
      const fruit = draws.find(function (d) {
        return /fruit\.png/.test(String(d.src));
      });
      assert.ok(fruit, "fruit sprite still drawn");
      assert.ok(badge.w < fruit.w, "badge is smaller than the fruit");
      // Centered on the fruit, like the native in-fruit transform
      assert.ok(
        Math.abs(badge.x + badge.w / 2 - (fruit.x + fruit.w / 2)) < 0.01,
        "badge is centered on the fruit"
      );
      // Only the badged fruit gets a chip
      assert.equal(
        draws.filter(function (d) { return /badge_/.test(String(d.src)); }).length,
        1
      );
      assert.ok(
        fills.some(function (f) { return String(f.style) === "rgba(0,0,0,0.45)"; }),
        "badge sits on the dark chip"
      );
    } finally {
      delete global.slot_trophy_url_for_mode;
      delete global.apple_img_arr;
      delete global.Image;
    }
  });

  it("drawBoardOnCanvas draws dashed bomb rings and the armed pulse", () => {
    const strokes = [];
    const fills = [];
    let dash = null;
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      lineDashOffset: 0,
      fillRect: function (x, y, w, h) {
        fills.push({ style: this.fillStyle, alpha: this.globalAlpha, w: w, h: h });
      },
      strokeRect: function (x, y, w, h) {
        strokes.push({ style: this.strokeStyle, w: w, h: h, dash: dash });
      },
      setLineDash: function (d) {
        dash = d;
      },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const canvas = {
      width: 170,
      height: 150,
      getContext: function () { return ctx; },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 17,
      height: 15,
      modeKey: "bomb_fruit",
      body: [],
      apples: [],
      bombArmTicks: 4,
      bombZones: [
        { x: 3, y: 4, arm: -1 }, // idle: ring only
        { x: 8, y: 9, arm: 2 },  // armed halfway: ring + pulse
      ],
    });

    const rings = strokes.filter(function (s) {
      return String(s.style).toLowerCase() === "#f23606";
    });
    assert.equal(rings.length, 2, "one dashed ring per zone");
    assert.ok(rings[0].w === rings[0].h, "ring is square");
    assert.ok(
      rings[0].dash && rings[0].dash.length === 2 && rings[0].dash[0] > 0,
      "ring is dashed like the in-game radius"
    );

    const pulses = fills.filter(function (f) {
      return String(f.style).toLowerCase() === "#f23606";
    });
    assert.equal(pulses.length, 1, "only the armed zone pulses");
    assert.ok(pulses[0].alpha > 0 && pulses[0].alpha < 1, "pulse is translucent");
    // arm 2 of 4 ticks → grown halfway out to the ring
    assert.ok(
      Math.abs(pulses[0].w - rings[0].w / 2) < 0.01,
      "pulse tracks the countdown"
    );

    // Idle-only board draws rings with no pulse at all
    strokes.length = 0;
    fills.length = 0;
    Gsm.drawBoardOnCanvas(canvas, {
      width: 17,
      height: 15,
      modeKey: "bomb_fruit",
      body: [],
      apples: [],
      bombZones: [{ x: 2, y: 2, arm: -1 }],
    });
    assert.equal(
      fills.filter(function (f) {
        return String(f.style).toLowerCase() === "#f23606";
      }).length,
      0
    );
  });

  it("drawBoardOnCanvas draws chess piece fallback when image missing", () => {
    const fills = [];
    const texts = [];
    const ctx = {
      fillStyle: "",
      globalAlpha: 1,
      font: "",
      textAlign: "",
      textBaseline: "",
      fillRect: function (x, y, w, h) {
        fills.push({ style: this.fillStyle });
      },
      fillText: function (t) {
        texts.push({ text: t, style: this.fillStyle });
      },
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 160,
      height: 160,
      getContext: function () { return ctx; },
    };
    // No image available (apple_img_arr absent) — should fall back to square + letter
    delete global.apple_img_arr;
    Gsm.drawBoardOnCanvas(canvas, {
      width: 10,
      height: 10,
      body: [],
      apples: [
        { x: 2, y: 2, type: 45, isPiece: true, chessPiece: "knight", chessColor: "w" },
        { x: 5, y: 5, type: 46, isPiece: true, chessPiece: "queen",  chessColor: "b" },
      ],
    });
    assert.ok(texts.some(function (t) { return t.text === "N"; }), "white knight draws N");
    assert.ok(texts.some(function (t) { return t.text === "Q"; }), "black queen draws Q");
    // White piece fallback bg is light, black piece bg is dark
    assert.ok(fills.some(function (f) { return f.style === "#f0d9b5"; }), "white piece bg");
    assert.ok(fills.some(function (f) { return f.style === "#b58863"; }), "black piece bg");
  });

  it("gates draw as a dashed line on the blocked edge, not a box", () => {
    // 10x10 board on a 100x100 canvas → cell 10, board drawn at ox=oy=0
    function paint(gates) {
      const rects = [];
      const segs = [];
      const dashes = [];
      let pending = null;
      const ctx = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        globalAlpha: 1,
        fillRect: function () {},
        strokeRect: function (x, y, w, h) {
          rects.push({ x: x, y: y, w: w, h: h, style: this.strokeStyle });
        },
        beginPath: function () {
          pending = [];
        },
        moveTo: function (x, y) {
          pending = [{ x: x, y: y }];
        },
        lineTo: function (x, y) {
          if (pending) pending.push({ x: x, y: y });
        },
        closePath: function () {},
        stroke: function () {
          if (pending && pending.length === 2) {
            segs.push({
              from: pending[0],
              to: pending[1],
              style: this.strokeStyle,
              width: this.lineWidth,
              dash: dashes[dashes.length - 1],
            });
          }
          pending = null;
        },
        arc: function () {},
        fill: function () {},
        drawImage: function () {},
        save: function () {},
        restore: function () {},
        translate: function () {},
        rotate: function () {},
        setLineDash: function (d) {
          dashes.push(d);
        },
      };
      Gsm.drawBoardOnCanvas(
        {
          width: 100,
          height: 100,
          getContext: function () {
            return ctx;
          },
        },
        {
          width: 10,
          height: 10,
          modeKey: "gate",
          gates: gates,
          body: [],
          apples: [],
        }
      );
      return { rects: rects, segs: segs };
    }

    // Flat gate at Upa=(2,3): edge between rows 3 and 4, spanning columns 2..4
    const flat = paint([
      { x: 2, y: 3, w: 2, h: 2, vertical: false, color: "#8ab35c" },
    ]);
    const flatSeg = flat.segs.find(function (s) {
      return s.style === "#8ab35c";
    });
    assert.ok(flatSeg, "gate strokes its own themed colour");
    assert.deepEqual(flatSeg.from, { x: 20, y: 40 });
    assert.deepEqual(flatSeg.to, { x: 40, y: 40 });
    assert.equal(flatSeg.width, 1, "native lineWidth is cell * 0.1");
    // 5 dashes + 4 gaps of span/9 land exactly on the 2-cell span
    assert.deepEqual(flatSeg.dash, [20 / 9, 20 / 9]);
    assert.equal(
      flat.rects.filter(function (r) {
        return r.w > 15 && r.h > 15;
      }).length,
      0,
      "no 2x2 frame around the gate"
    );

    // Vertical gate at Upa=(6,1): edge between columns 6 and 7, rows 1..3
    const vert = paint([
      { x: 6, y: 1, w: 2, h: 2, vertical: true, color: "#8ab35c" },
    ]);
    const vertSeg = vert.segs.find(function (s) {
      return s.style === "#8ab35c";
    });
    assert.ok(vertSeg);
    assert.deepEqual(vertSeg.from, { x: 70, y: 10 });
    assert.deepEqual(vertSeg.to, { x: 70, y: 30 });

    // No colour from the sender → still drawn, tinted off the theme
    const plain = paint([{ x: 2, y: 3, w: 2, h: 2, vertical: false }]);
    const plainSeg = plain.segs.find(function (s) {
      return s.from && s.from.x === 20 && s.from.y === 40;
    });
    assert.ok(plainSeg, "gate without colour still draws its edge");
  });

  it("fruit shields sit on the cell edges and close their corners", () => {
    // 10x10 board on a 100x100 canvas → cell 10, board drawn at ox=oy=0
    const rects = [];
    const segs = [];
    let pending = null;
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "round",
      lineJoin: "miter",
      globalAlpha: 1,
      fillRect: function (x, y, w, h) {
        rects.push({ x: x, y: y, w: w, h: h, style: this.fillStyle });
      },
      strokeRect: function () {},
      beginPath: function () {
        pending = [];
      },
      moveTo: function (x, y) {
        pending = [{ x: x, y: y }];
      },
      lineTo: function (x, y) {
        if (pending) pending.push({ x: x, y: y });
      },
      closePath: function () {},
      stroke: function () {
        if (pending && pending.length === 2) {
          segs.push({
            from: pending[0],
            to: pending[1],
            style: this.strokeStyle,
            width: this.lineWidth,
            cap: this.lineCap,
          });
        }
        pending = null;
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    Gsm.drawBoardOnCanvas(
      {
        width: 100,
        height: 100,
        getContext: function () {
          return ctx;
        },
      },
      {
        width: 10,
        height: 10,
        modeKey: "shield",
        body: [],
        apples: [{ x: 2, y: 3, shields: ["UP", "DOWN", "LEFT", "RIGHT"] }],
        themeColors: { light: "#111111", dark: "#222222", border: "#33bb44" },
      }
    );
    // Fruit centre is (25,35); native thickness is round(cell/5), evened, and
    // each tick is pulled in half a thickness at both ends
    const ticks = segs.filter(function (s) {
      return s.style === "#33bb44";
    });
    assert.equal(ticks.length, 4, "one tick per shielded side");
    assert.equal(ticks[0].width, 2);
    assert.equal(ticks[0].cap, "butt", "native caps are square, not round");
    function tick(from, to) {
      return ticks.some(function (s) {
        return (
          s.from.x === from.x &&
          s.from.y === from.y &&
          s.to.x === to.x &&
          s.to.y === to.y
        );
      });
    }
    assert.ok(tick({ x: 21, y: 30 }, { x: 29, y: 30 }), "top edge");
    assert.ok(tick({ x: 21, y: 40 }, { x: 29, y: 40 }), "bottom edge");
    assert.ok(tick({ x: 20, y: 31 }, { x: 20, y: 39 }), "left edge");
    assert.ok(tick({ x: 30, y: 31 }, { x: 30, y: 39 }), "right edge");
    const corners = rects.filter(function (r) {
      return r.style === "#33bb44" && r.w === 2 && r.h === 2;
    });
    assert.equal(corners.length, 4, "a block closes each corner");
    assert.deepEqual(
      corners
        .map(function (r) {
          return r.x + "," + r.y;
        })
        .sort(),
      ["19,29", "19,39", "29,29", "29,39"]
    );
  });

  it("drawBoardOnCanvas draws native orange chevron arrows", () => {
    const strokes = [];
    const rotates = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      fillRect: function () {},
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function (x, y) {
        this._m = [x, y];
      },
      lineTo: function (x, y) {
        strokes.push({
          from: this._m,
          to: [x, y],
          style: this.strokeStyle,
          width: this.lineWidth,
        });
        this._m = [x, y];
      },
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function (a) {
        rotates.push(a);
      },
      setLineDash: function () {},
    };
    Gsm.drawBoardOnCanvas(
      {
        width: 100,
        height: 100,
        getContext: function () {
          return ctx;
        },
      },
      {
        width: 10,
        height: 10,
        modeKey: "arrow",
        arrows: [
          { x: 2, y: 2, dir: "RIGHT" },
          { x: 4, y: 2, dir: "UP" },
          { x: 6, y: 2, dir: "LEFT", color: "#4E7CF6" },
        ],
        body: [],
        apples: [],
      }
    );
    assert.equal(Gsm.ARROW_DEFAULT_COLOR, "#EA7E0B");
    const orange = strokes.filter(function (s) {
      return s.style === "#EA7E0B";
    });
    const blue = strokes.filter(function (s) {
      return s.style === "#4E7CF6";
    });
    assert.ok(orange.length >= 2, "default orange chevron strokes");
    assert.ok(blue.length >= 2, "scraped arrow color");
    // RIGHT: no rotate; UP: -PI/2; LEFT: PI
    assert.ok(rotates.indexOf(-Math.PI / 2) >= 0, "UP rotate");
    assert.ok(rotates.indexOf(Math.PI) >= 0, "LEFT rotate");
    // Native lineWidth = cell/8; cell = min(100/10,100/10)=10 → 1.25
    assert.ok(
      orange.some(function (s) {
        return Math.abs(s.width - 10 / 8) < 0.01;
      }),
      "lineWidth cell/8"
    );
  });

  it("drawBoardOnCanvas draws yin yang companion body2", () => {
    let strokes = 0;
    const ctx = {
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
      stroke: function () {
        strokes++;
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    Gsm.drawBoardOnCanvas(
      {
        width: 170,
        height: 150,
        getContext: function () {
          return ctx;
        },
      },
      {
        width: 10,
        height: 10,
        modeKey: "yin_yang",
        body: [
          { x: 2, y: 2 },
          { x: 1, y: 2 },
        ],
        body2: [
          { x: 7, y: 7 },
          { x: 8, y: 7 },
        ],
        apples: [],
      },
      { primary: "#F53D40", secondary: "#D00B0E" }
    );
    assert.ok(strokes >= 2, "primary + companion snakes stroked");
  });

  it("scrapeCompanionBody: twin never invents yin-yang mirror", () => {
    const prevMode = global.ModeRegistry;
    global.ModeRegistry = {
      getCurrentModeKey: function () {
        return "twin";
      },
    };
    try {
      const body = [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ];
      const none = Gsm.scrapeCompanionBody({}, body, 10, 10);
      assert.equal(none, null, "twin without Ra.ka → no fake mirror");
      const twin = Gsm.scrapeCompanionBody(
        { Ra: { ka: [{ x: 5, y: 4 }, { x: 5, y: 5 }] } },
        body,
        10,
        10
      );
      assert.ok(twin);
      assert.equal(twin[0].x, 5);
      assert.equal(twin[0].y, 4);
    } finally {
      if (prevMode) global.ModeRegistry = prevMode;
      else delete global.ModeRegistry;
    }
  });

  it("scrapeCompanionBody: yin_yang mirrors when companion missing", () => {
    const prevMode = global.ModeRegistry;
    global.ModeRegistry = {
      getCurrentModeKey: function () {
        return "yin_yang";
      },
    };
    try {
      const mirrored = Gsm.scrapeCompanionBody(
        {},
        [
          { x: 2, y: 2 },
          { x: 1, y: 2 },
        ],
        10,
        10
      );
      assert.ok(mirrored);
      assert.equal(mirrored[0].x, 7);
      assert.equal(mirrored[0].y, 7);
    } finally {
      if (prevMode) global.ModeRegistry = prevMode;
      else delete global.ModeRegistry;
    }
  });

  it("drawSpriteSheetFrame picks key_types frame by type", () => {
    const calls = [];
    const ctx = {
      drawImage: function () {
        calls.push([].slice.call(arguments));
      },
    };
    const img = {
      complete: true,
      naturalWidth: 240,
      naturalHeight: 10,
      onload: null,
      onerror: null,
      src: "",
    };
    const prevImg = global.Image;
    global.Image = function () {
      return img;
    };
    try {
      const ok = Gsm.drawSpriteSheetFrame(
        ctx,
        "https://example.test/key_strip.png",
        3,
        24,
        10,
        20,
        30,
        30
      );
      assert.equal(ok, true);
      assert.equal(calls.length, 1);
      const a = calls[0];
      assert.equal(a[1], 3 * (240 / 24));
      assert.equal(a[3], 240 / 24);
      assert.equal(a[5], 10);
      assert.equal(a[6], 20);
      assert.equal(a[7], 30);
      assert.ok(Gsm.KEY_TYPES_URL.indexOf("key_types.png") >= 0);
      assert.ok(Gsm.KEY_TYPES_DARK_URL.indexOf("key_types_dark.png") >= 0);
    } finally {
      if (prevImg) global.Image = prevImg;
      else delete global.Image;
    }
  });

  it("drawSpriteSheetFrame reads mine.png vertically for flag frame", () => {
    const calls = [];
    const ctx = {
      drawImage: function () {
        calls.push([].slice.call(arguments));
      },
    };
    const img = {
      complete: true,
      naturalWidth: 20,
      naturalHeight: 200,
      onload: null,
      onerror: null,
      src: "",
    };
    const prevImg = global.Image;
    global.Image = function () {
      return img;
    };
    try {
      const ok = Gsm.drawSpriteSheetFrame(
        ctx,
        Gsm.MINE_FLAG_URL,
        Gsm.MINE_FLAG_FRAME,
        Gsm.MINE_FLAG_FRAMES,
        0,
        0,
        16,
        16,
        "y"
      );
      assert.equal(ok, true);
      assert.equal(calls.length, 1);
      const a = calls[0];
      assert.equal(a[1], 0);
      assert.equal(a[2], 9 * (200 / 10));
      assert.equal(a[3], 20);
      assert.equal(a[4], 200 / 10);
      assert.ok(Gsm.MINE_FLAG_URL.indexOf("mine.png") >= 0);
      assert.equal(Gsm.MINE_RADIUS_COLOR, "#f23606");
    } finally {
      if (prevImg) global.Image = prevImg;
      else delete global.Image;
    }
  });

  it("drawBoardOnCanvas draws cracked statue with cracks overlay", () => {
    const draws = [];
    const cache = Object.create(null);
    const prevImg = global.Image;
    global.Image = function () {
      const self = {
        complete: true,
        naturalWidth: 40,
        naturalHeight: 10,
        onload: null,
        onerror: null,
        src: "",
      };
      // Distinct instances so statue vs cracks stay identifiable
      Object.defineProperty(self, "src", {
        get: function () {
          return this._src || "";
        },
        set: function (v) {
          this._src = String(v);
          cache[this._src] = self;
        },
      });
      return self;
    };
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      fillRect: function () {},
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {
        draws.push([].slice.call(arguments));
      },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    try {
      Gsm.drawBoardOnCanvas(
        {
          width: 100,
          height: 100,
          getContext: function () {
            return ctx;
          },
        },
        {
          width: 5,
          height: 5,
          modeKey: "statue",
          statues: [
            { x: 1, y: 1, cracked: true },
            { x: 3, y: 3 },
          ],
          body: [],
          apples: [],
        }
      );
      assert.ok(Gsm.STATUE_URL.indexOf("trophy_13") >= 0);
      assert.ok(Gsm.STATUE_CRACKS_URL.indexOf("cracks.png") >= 0);
      // 2 statues → 2 full trophy draws; cracked adds cracks sheet (9-arg)
      const full = draws.filter(function (a) {
        return a.length === 5;
      });
      const sheets = draws.filter(function (a) {
        return a.length === 9;
      });
      assert.equal(full.length, 2, "trophy for each statue");
      assert.equal(sheets.length, 1, "cracks overlay only on cracked");
      assert.equal(sheets[0][1], 0, "cracks frame 0 sx");
    } finally {
      if (prevImg) global.Image = prevImg;
      else delete global.Image;
    }
  });

  it("drawBoardOnCanvas uses RemixUltra sokoban box/goal frames", () => {
    const frames = [];
    const img = {
      complete: true,
      naturalWidth: 80,
      naturalHeight: 10,
      onload: null,
      onerror: null,
      src: "",
    };
    const prevImg = global.Image;
    global.Image = function () {
      return img;
    };
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      fillRect: function () {},
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function () {
        // sx = frame * (naturalWidth / frames)
        const sx = arguments[1];
        frames.push(sx / (80 / 8));
      },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    try {
      Gsm.drawBoardOnCanvas(
        {
          width: 170,
          height: 150,
          getContext: function () {
            return ctx;
          },
        },
        {
          width: 10,
          height: 10,
          modeKey: "sokoban",
          goals: [{ x: 1, y: 1 }],
          boxes: [{ x: 2, y: 2 }],
          body: [],
          apples: [],
        }
      );
      assert.ok(Gsm.SOKO_BOX_URL.indexOf("v4/box.png") >= 0);
      assert.equal(Gsm.SOKO_BOX_FRAME, 0);
      assert.equal(Gsm.SOKO_GOAL_FRAME, 2);
      assert.ok(frames.indexOf(2) >= 0, "goal frame 2");
      assert.ok(frames.indexOf(0) >= 0, "box frame 0");
    } finally {
      if (prevImg) global.Image = prevImg;
      else delete global.Image;
    }
  });

  it("resolveSokoGoalUrl follows the Distinct Soko Goals toggle", () => {
    const prev = global.pudding_settings;
    const prevGfx = global.graphics_selected;
    try {
      // Remix ships the toggle on, so an absent setting still means distinct
      delete global.pudding_settings;
      global.graphics_selected = 0;
      assert.equal(Gsm.resolveSokoGoalUrl(null), Gsm.SOKO_GOAL_DISTINCT_URL);

      global.pudding_settings = { SokoGoals: true };
      assert.equal(Gsm.resolveSokoGoalUrl({}), Gsm.SOKO_GOAL_DISTINCT_URL);
      // Pixel graphics follows the scraped board, not the viewer
      assert.equal(
        Gsm.resolveSokoGoalUrl({ graphicsIndex: 1 }),
        Gsm.SOKO_GOAL_DISTINCT_PX_URL
      );
      assert.equal(
        Gsm.resolveSokoGoalUrl({ graphicsIndex: 2 }),
        Gsm.SOKO_GOAL_DISTINCT_URL
      );

      global.pudding_settings = { SokoGoals: false };
      assert.equal(Gsm.resolveSokoGoalUrl({}), Gsm.SOKO_BOX_URL);
      assert.equal(
        Gsm.resolveSokoGoalUrl({ graphicsIndex: 1 }),
        Gsm.SOKO_BOX_URL
      );
    } finally {
      if (prev === undefined) delete global.pudding_settings;
      else global.pudding_settings = prev;
      if (prevGfx === undefined) delete global.graphics_selected;
      else global.graphics_selected = prevGfx;
    }
  });

  it("drawBoardOnCanvas draws soko goals from the distinct sheet, boxes from the native one", () => {
    // One image per src so each drawImage can be traced back to its sheet
    const bySrc = {};
    const prevImg = global.Image;
    const prevSettings = global.pudding_settings;
    global.Image = function () {
      const img = {
        complete: true,
        naturalWidth: 80,
        naturalHeight: 10,
        onload: null,
        onerror: null,
      };
      Object.defineProperty(img, "src", {
        set: function (v) {
          this._src = v;
          bySrc[v] = this;
        },
        get: function () {
          return this._src;
        },
      });
      return img;
    };
    const drawn = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      globalAlpha: 1,
      fillRect: function () {},
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {},
      arc: function () {},
      fill: function () {},
      drawImage: function (img, sx) {
        drawn.push({ src: img && img._src, frame: sx / (80 / 8) });
      },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    function paint() {
      drawn.length = 0;
      // Earlier tests share one mock Image across URLs — start from a clean cache
      Gsm.resetSpriteImageCache();
      Gsm.drawBoardOnCanvas(
        {
          width: 170,
          height: 150,
          getContext: function () {
            return ctx;
          },
        },
        {
          width: 10,
          height: 10,
          modeKey: "sokoban",
          goals: [{ x: 1, y: 1 }],
          boxes: [{ x: 2, y: 2 }],
          body: [],
          apples: [],
        }
      );
    }
    try {
      global.pudding_settings = { SokoGoals: true };
      paint();
      const goal = drawn.find(function (d) {
        return d.frame === 2;
      });
      const box = drawn.find(function (d) {
        return d.frame === 0;
      });
      assert.ok(goal, "goal frame drawn");
      assert.equal(goal.src, Gsm.SOKO_GOAL_DISTINCT_URL);
      assert.ok(box, "box frame drawn");
      assert.equal(box.src, Gsm.SOKO_BOX_URL, "boxes keep the native sheet");

      global.pudding_settings = { SokoGoals: false };
      paint();
      const plain = drawn.find(function (d) {
        return d.frame === 2;
      });
      assert.ok(plain, "goal frame drawn with toggle off");
      assert.equal(plain.src, Gsm.SOKO_BOX_URL);
    } finally {
      if (prevImg) global.Image = prevImg;
      else delete global.Image;
      if (prevSettings === undefined) delete global.pudding_settings;
      else global.pudding_settings = prevSettings;
    }
  });

  it("mosaic greys the snake while the poison countdown runs", () => {
    const strokes = [];
    const ctx = {
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
      strokeRect: function () {},
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      closePath: function () {},
      stroke: function () {
        strokes.push(String(this.strokeStyle).toLowerCase());
      },
      arc: function () {},
      fill: function () {},
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: function () {
        return ctx;
      },
    };
    const board = {
      width: 10,
      height: 10,
      dir: "RIGHT",
      modeKey: "poison",
      apples: [],
      body: [
        { x: 4, y: 2 },
        { x: 3, y: 2 },
        { x: 2, y: 2 },
      ],
    };
    const blue = { primary: "#4E7CF6", secondary: "#17439F" };
    // The gradient is sampled between segments, so pin the shade family rather
    // than the endpoint hexes.
    function isGrey(hex) {
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
      return !!m && m[1] === m[2] && m[2] === m[3];
    }
    function inPoisonRange(hex) {
      const v = parseInt(hex.slice(1, 3), 16);
      return isGrey(hex) && v >= 100 && v <= 145;
    }
    function paint(colorInfo) {
      strokes.length = 0;
      Gsm.drawBoardOnCanvas(canvas, board, colorInfo);
      assert.ok(strokes.length, "snake was stroked");
    }

    paint(blue);
    assert.ok(strokes.some(isGrey) === false, "healthy snake keeps its colour");

    board.poisonTicks = 8;
    paint(blue);
    assert.ok(strokes.every(isGrey), "player colour is dropped");
    assert.ok(strokes.some(inPoisonRange), "body strokes the f3E/g3E greys");

    // Rainbow skins lose their gradient too, the way f3E/g3E override it
    paint({ set: ["#ff0000", "#00ff00", "#0000ff"] });
    assert.ok(strokes.every(isGrey), "rainbow set is ignored");
    assert.ok(strokes.some(inPoisonRange));

    // Countdown expiry has to hand the colour back
    board.poisonTicks = 0;
    paint(blue);
    assert.ok(
      strokes.some(isGrey) === false,
      "unpoisoned snake is itself again"
    );
  });

  it("scrapeBoard carries snake.Ja as the poison countdown", () => {
    const prevDoc = global.document;
    global.document = {
      querySelector: function () {
        return null;
      },
      querySelectorAll: function () {
        return [];
      },
      getElementById: function () {
        return null;
      },
      getElementsByClassName: function () {
        return [];
      },
    };
    global.__remixGame = {
      oa: {
        ka: [
          { x: 3, y: 3 },
          { x: 2, y: 3 },
        ],
        direction: "RIGHT",
        Ja: 0,
      },
      wa: { ka: [], oa: { oa: { width: 10, height: 10 } } },
      settings: {},
    };
    try {
      assert.equal(
        Gsm.scrapeBoard({}).poisonTicks,
        undefined,
        "healthy snake sends nothing"
      );
      global.__remixGame.oa.Ja = 8;
      const board = Gsm.scrapeBoard({});
      assert.equal(board.poisonTicks, 8);
      assert.equal(Gsm.boardSnakePoisoned(board), true);
    } finally {
      delete global.__remixGame;
      if (prevDoc) global.document = prevDoc;
      else delete global.document;
    }
  });

  it("scrapeBoard splits the body by snake.wa in dimension mode", () => {
    const prevDoc = global.document;
    const prevMode = global.ModeRegistry;
    global.document = {
      querySelector: function () {
        return null;
      },
      querySelectorAll: function () {
        return [];
      },
      getElementById: function () {
        return null;
      },
      getElementsByClassName: function () {
        return [];
      },
    };
    global.__remixGame = {
      oa: {
        ka: [
          { x: 8, y: 5 },
          { x: 7, y: 5 },
          { x: 6, y: 5 },
          { x: 5, y: 5 },
        ],
        direction: "RIGHT",
        // Parallel to ka: head two segments here, tail two in the other one
        wa: [true, true, false, false],
      },
      wa: { ka: [], oa: { oa: { width: 10, height: 10 } } },
      settings: {},
    };
    global.ModeRegistry = {
      getCurrentModeKey: function () {
        return "dimension";
      },
    };
    try {
      let body = Gsm.scrapeBoard({}).body;
      assert.deepEqual(
        body.map(function (p) {
          return !!p.otherDim;
        }),
        [false, false, true, true]
      );

      // A swap inverts every flag at once
      global.__remixGame.oa.wa = [false, false, true, true];
      body = Gsm.scrapeBoard({}).body;
      assert.deepEqual(
        body.map(function (p) {
          return !!p.otherDim;
        }),
        [true, true, false, false]
      );

      // Outside dimension mode the array is meaningless — never ghost anything
      global.ModeRegistry.getCurrentModeKey = function () {
        return "classic";
      };
      body = Gsm.scrapeBoard({}).body;
      assert.ok(
        body.every(function (p) {
          return !p.otherDim;
        }),
        "classic bodies are never ghosted"
      );
    } finally {
      delete global.__remixGame;
      if (prevMode) global.ModeRegistry = prevMode;
      else delete global.ModeRegistry;
      if (prevDoc) global.document = prevDoc;
      else delete global.document;
    }
  });

  it("dimension split draws one continuous snake, not two", () => {
    const strokes = [];
    let alpha = 1;
    const stack = [];
    let from = null;
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      get globalAlpha() {
        return alpha;
      },
      set globalAlpha(v) {
        alpha = v;
      },
      save: function () {
        stack.push(alpha);
      },
      restore: function () {
        if (stack.length) alpha = stack.pop();
      },
      beginPath: function () {
        from = null;
      },
      moveTo: function (x, y) {
        from = [x, y];
      },
      lineTo: function (x, y) {
        this._to = [x, y];
      },
      stroke: function () {
        if (from && this._to) {
          strokes.push({
            alpha: alpha,
            x0: from[0],
            y0: from[1],
            x1: this._to[0],
            y1: this._to[1],
            width: this.lineWidth,
          });
        }
      },
      closePath: function () {},
      arc: function () {},
      fill: function () {},
      fillRect: function () {},
      strokeRect: function () {},
      drawImage: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    // Head-first row at y=5: x=8,7,6 in this dimension, x=5,4,3 in the other
    const body = [8, 7, 6, 5, 4, 3].map(function (x, i) {
      return i < 3 ? { x: x, y: 5 } : { x: x, y: 5, otherDim: true };
    });
    Gsm.drawWallSolverStyleSnake(ctx, body, 0, 0, 10, {
      primary: "#4E7CF6",
      secondary: "#17439F",
    });

    const row = strokes.filter(function (s) {
      return s.y0 === 55 && s.y1 === 55;
    });
    const solid = row.filter(function (s) {
      return s.alpha === 1;
    });
    const ghost = row.filter(function (s) {
      return s.alpha < 1;
    });
    assert.ok(solid.length, "current-dimension part is drawn opaque");
    assert.ok(ghost.length, "other-dimension part is drawn faded");

    function span(list) {
      const xs = [];
      list.forEach(function (s) {
        xs.push(s.x0, s.x1);
      });
      return [Math.min.apply(null, xs), Math.max.apply(null, xs)];
    }
    // Cell centres are (x + 0.5) * 10
    assert.deepEqual(span(solid), [65, 85], "solid covers x=6..8 only");
    // Ghost reaches the boundary centre so the two strokes meet with no hole
    assert.deepEqual(span(ghost), [35, 65], "ghost covers x=3..6");

    // One taper across the whole body: the ghost tail must be thinner than the
    // solid head, which only holds if the runs share a taper window.
    const headW = Math.max.apply(
      null,
      solid.map(function (s) {
        return s.width;
      })
    );
    const tailW = Math.min.apply(
      null,
      ghost.map(function (s) {
        return s.width;
      })
    );
    assert.ok(tailW < headW * 0.6, "tail stays thin instead of restarting");
  });

  // Bodies arrive one tick at a time; these cover the slide that hides it.
  function motionBody(headX) {
    return [
      { x: headX, y: 5 },
      { x: headX - 1, y: 5 },
      { x: headX - 2, y: 5 },
    ];
  }

  it("snakeMotion times a tick and slides only between neighbours", () => {
    const holder = {};
    // First sight: nowhere to slide from
    assert.equal(Gsm.snakeMotion(holder, "body", motionBody(8), 1000), null);
    // Still sitting on the same cells
    assert.equal(Gsm.snakeMotion(holder, "body", motionBody(8), 1100), null);

    // One cell on, 120ms later. The landing frame must draw the old cells or
    // the snake jumps ahead and then slides backwards into place.
    const land = Gsm.snakeMotion(holder, "body", motionBody(9), 1120);
    assert.ok(land, "a timed step animates");
    assert.equal(land.u, 0);
    assert.deepEqual(land.headFrom, { x: 8, y: 5 });
    assert.deepEqual(land.tailFrom, { x: 6, y: 5 });
    assert.equal(Gsm.snakeMotionActive(holder, 1120), true);

    const mid = Gsm.snakeMotion(holder, "body", motionBody(9), 1180);
    assert.equal(mid.u, 0.5, "halfway through the measured tick");
    // Arrived: back to drawing the cells as sent
    assert.equal(Gsm.snakeMotion(holder, "body", motionBody(9), 1240), null);
    assert.equal(
      Gsm.snakeMotionActive(holder, 1400),
      false,
      "settled snakes stop asking for repaints"
    );

    // A long stall is not a tick — stretching it would crawl for half a second
    assert.equal(Gsm.snakeMotion(holder, "body", motionBody(10), 3000), null);
  });

  function paintMotionSnake(body, motion) {
    const strokes = [];
    let from = null;
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      globalAlpha: 1,
      save: function () {},
      restore: function () {},
      beginPath: function () {
        from = null;
      },
      moveTo: function (x, y) {
        from = [x, y];
      },
      lineTo: function (x, y) {
        this._to = [x, y];
      },
      stroke: function () {
        if (from && this._to) {
          strokes.push({
            x0: from[0],
            y0: from[1],
            x1: this._to[0],
            y1: this._to[1],
          });
        }
      },
      closePath: function () {},
      arc: function () {},
      fill: function () {},
      fillRect: function () {},
      strokeRect: function () {},
      drawImage: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    Gsm.drawWallSolverStyleSnake(
      ctx,
      body,
      0,
      0,
      10,
      { primary: "#4E7CF6", secondary: "#17439F" },
      null,
      motion ? { motion: motion } : undefined
    );
    return strokes;
  }

  it("the body carries one shadow underneath, not one per segment", () => {
    // The gradient is a run of overlapping strokes. Shadowing each one as it
    // goes drops a dark crescent on the stroke before it and the body reads as
    // a row of discs, so every shadowed shape has to be buried under a flat
    // repaint of itself.
    function paint(alpha) {
      const ops = [];
      let from = null;
      const ctx = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        lineCap: "round",
        lineJoin: "round",
        shadowColor: "",
        shadowBlur: 0,
        shadowOffsetY: 0,
        globalAlpha: alpha == null ? 1 : alpha,
        save: function () {},
        restore: function () {},
        beginPath: function () {
          from = null;
        },
        moveTo: function (x, y) {
          from = [x, y];
        },
        lineTo: function (x, y) {
          this._to = [x, y];
        },
        stroke: function () {
          if (from && this._to) {
            ops.push({
              kind: "stroke",
              at: from.join(",") + ">" + this._to.join(","),
              width: this.lineWidth,
              shadow: this.shadowColor,
            });
          }
        },
        arc: function (x, y, r) {
          this._arc = x + "," + y + "," + r;
        },
        fill: function () {
          if (this._arc) {
            ops.push({
              kind: "fill",
              at: this._arc,
              shadow: this.shadowColor,
            });
            this._arc = null;
          }
        },
        closePath: function () {},
        fillRect: function () {},
        strokeRect: function () {},
        drawImage: function () {},
        translate: function () {},
        rotate: function () {},
        setLineDash: function () {},
      };
      Gsm.drawWallSolverStyleSnake(
        ctx,
        [
          { x: 8, y: 5 },
          { x: 7, y: 5 },
          { x: 6, y: 5 },
          { x: 5, y: 5 },
        ],
        0,
        0,
        10,
        { primary: "#4E7CF6", secondary: "#17439F" }
      );
      return ops;
    }

    const ops = paint(1);
    const lit = function (o) {
      return o.shadow && o.shadow !== "transparent";
    };
    const shadowed = ops.filter(lit);
    assert.ok(shadowed.length, "there is still a drop shadow");
    // Nothing shadowed may be painted after the flat pass starts, or its
    // crescent lands on top of finished body again
    const firstFlat = ops.findIndex(function (o) {
      return !lit(o);
    });
    assert.equal(
      ops.slice(firstFlat).some(lit),
      false,
      "shadow pass finishes before the flat pass begins"
    );
    // Every shadowed shape is repainted flat, in place
    const flatAt = {};
    ops.filter(function (o) {
      return !lit(o);
    }).forEach(function (o) {
      flatAt[o.kind + o.at] = true;
    });
    shadowed.forEach(function (o) {
      assert.ok(flatAt[o.kind + o.at], "buried: " + o.kind + " " + o.at);
    });
    // Head skull included — its shadow used to ridge across the neck
    assert.ok(
      shadowed.some(function (o) {
        return o.kind === "fill";
      }),
      "the head is part of the shadow pass"
    );

    // A see-through body (ghost run, corpse) is painted once and unshadowed:
    // two passes would stack up and darken it
    const ghost = paint(0.55);
    assert.equal(ghost.filter(lit).length, 0);
    assert.equal(
      ghost.length + shadowed.length,
      ops.length,
      "the face is drawn once either way — only the shadow pass is dropped"
    );
  });

  it("a mid-step snake keeps its length and drops both ends back", () => {
    // Cell centres are (n + 0.5) * 10, so cells 6..8 span 65..85
    function span(strokes) {
      const xs = [];
      strokes
        .filter(function (s) {
          return s.y0 === 55 && s.y1 === 55;
        })
        .forEach(function (s) {
          xs.push(s.x0, s.x1);
        });
      return [Math.min.apply(null, xs), Math.max.apply(null, xs)];
    }
    assert.deepEqual(span(paintMotionSnake(motionBody(8), null)), [65, 85]);
    // Halfway out of cell 7 and into 8: same two cells of tube, shifted half
    assert.deepEqual(
      span(
        paintMotionSnake(motionBody(8), {
          u: 0.5,
          headFrom: { x: 7, y: 5 },
          tailFrom: { x: 5, y: 5 },
        })
      ),
      [60, 80]
    );
    // A jump that is not one cell (portal, wrap, respawn) has no path to slide
    // along, so that end draws where it was sent
    assert.deepEqual(
      span(
        paintMotionSnake(motionBody(8), {
          u: 0.5,
          headFrom: { x: 0, y: 0 },
          tailFrom: { x: 5, y: 5 },
        })
      ),
      [60, 85]
    );
  });

  it("a mid-step snake turns the corner instead of cutting it", () => {
    // Head just entered (5,6) heading down; the tail is leaving (3,5)
    const strokes = paintMotionSnake(
      [
        { x: 5, y: 6 },
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
      { u: 0.5, headFrom: { x: 5, y: 5 }, tailFrom: { x: 3, y: 5 } }
    );
    const diagonal = strokes.filter(function (s) {
      return s.x0 !== s.x1 && s.y0 !== s.y1;
    });
    assert.equal(diagonal.length, 0, "no shortcut across the corner");
    const flat = strokes.filter(function (s) {
      return s.y0 === 55 && s.y1 === 55;
    });
    const down = strokes.filter(function (s) {
      return s.x0 === 55 && s.x1 === 55;
    });
    // Tail half out of (3,5) → (4,5), body still through the corner at (5,5)
    assert.equal(Math.min.apply(null, flat.map(function (s) { return s.x0; })), 40);
    assert.equal(Math.max.apply(null, flat.map(function (s) { return s.x1; })), 55);
    // Head half into (5,6)
    assert.equal(Math.max.apply(null, down.map(function (s) { return s.y1; })), 60);
  });

  it("scrapeBoardEntities reads Map/Set hosts and arrows", () => {
    const boxes = new Set([{ pos: { x: 1, y: 2 } }]);
    const goals = new Set([{ x: 3, y: 4 }]);
    const statues = new Map();
    statues.set("a", {
      pos: { x: 5, y: 6 },
      WQ: { pdb: true, angle: 0 },
    });
    statues.set("b", {
      pos: { x: 1, y: 2 },
      WQ: { pdb: false, angle: 0 },
    });
    const walls = new Map();
    walls.set("w", { pos: { x: 0, y: 0 }, yNa: 2 });
    global.__remixGame = {
      Ca: { Aa: walls },
      Ba: {
        keys: [{ pos: { x: 8, y: 8 }, type: 2, r7a: { x: 0, y: 0 } }],
      },
      Aa: { oa: boxes, d_: goals },
      Ya: { oa: statues },
      Ma: { oa: [{ pos: { x: 9, y: 9 }, xL: 2 }] },
      Ga: {
        oa: [
          [0, 0],
          [0, { wm: false, color: "#e68f1b", Lh: true }],
        ],
      },
      Qa: {
        pfa: [
          { Upa: { x: 4, y: 5 }, vertical: false, color: "#8ab35c" },
          { Upa: { x: 6, y: 1 }, vertical: true },
        ],
      },
      Ka: {
        ka: [
          [{ direction: "NONE" }, { direction: "UP", color: "#EA7E0B" }],
          [{ direction: "LEFT" }, { direction: "NONE" }],
        ],
      },
    };
    try {
      const e = Gsm.scrapeBoardEntities(global.__remixGame);
      assert.equal(e.walls.length, 1);
      assert.equal(e.walls[0].lock, true);
      assert.equal(e.keys.length, 1);
      assert.equal(e.keys[0].type, 2);
      assert.equal(e.keys[0].keyblock.x, 0);
      assert.equal(e.keys[0].keyblock.type, 2);
      assert.equal(e.walls[0].lockType, 2);
      assert.equal(e.boxes.length, 1);
      assert.equal(e.goals.length, 1);
      assert.equal(e.statues.length, 2);
      const cracked = e.statues.filter(function (s) {
        return s.cracked;
      });
      const intact = e.statues.filter(function (s) {
        return !s.cracked;
      });
      assert.equal(cracked.length, 1);
      assert.equal(cracked[0].x, 5);
      assert.equal(intact.length, 1);
      assert.equal(intact[0].x, 1);
      assert.equal(e.mines.length, 1);
      assert.equal(e.mines[0].x, 9);
      assert.equal(e.mines[0].y, 9);
      assert.equal(e.mines[0].xL, 2);
      assert.equal(e.bridges.length, 1);
      assert.equal(e.bridges[0].x, 1);
      assert.equal(e.bridges[0].y, 1);
      assert.equal(e.bridges[0].color, "#e68f1b");
      assert.equal(e.gates.length, 2);
      assert.equal(e.gates[0].x, 4);
      assert.equal(e.gates[0].y, 5);
      assert.equal(e.gates[0].w, 2);
      assert.equal(e.gates[0].vertical, false);
      assert.equal(e.gates[0].color, "#8ab35c");
      assert.equal(e.gates[1].vertical, true);
      assert.equal(e.arrows.length, 2);
      const up = e.arrows.find(function (a) {
        return a.dir === "UP";
      });
      assert.ok(up);
      assert.equal(up.color, "#EA7E0B");
    } finally {
      delete global.__remixGame;
    }
  });

  it("drawWallSolverStyleSnake uses rainbow set along the body", () => {
    const fills = [];
    const styles = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      globalAlpha: 1,
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      stroke: function () {
        styles.push(String(this.strokeStyle));
      },
      arc: function () {},
      fill: function () {
        fills.push(String(this.fillStyle));
      },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      scale: function () {},
    };
    Gsm.drawWallSolverStyleSnake(
      ctx,
      [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
        { x: 3, y: 5 },
        { x: 2, y: 5 },
        { x: 1, y: 5 },
      ],
      0,
      0,
      20,
      {
        set: ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"],
        primary: "#e40303",
        secondary: "#750787",
      },
      "RIGHT"
    );
    assert.ok(styles.length > 0);
    assert.ok(
      fills.some(function (s) {
        return String(s).toLowerCase() === "#e40303";
      }),
      "head fill should use first rainbow color"
    );
  });

  it("drawWallSolverStyleSnake uses solid primary/secondary", () => {
    const fills = [];
    const styles = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      globalAlpha: 1,
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      stroke: function () {
        styles.push(String(this.strokeStyle));
      },
      arc: function () {},
      fill: function () {
        fills.push(String(this.fillStyle));
      },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      scale: function () {},
    };
    Gsm.drawWallSolverStyleSnake(
      ctx,
      [
        { x: 3, y: 3 },
        { x: 2, y: 3 },
        { x: 1, y: 3 },
      ],
      0,
      0,
      16,
      { primary: "#F53D40", secondary: "#D00B0E" },
      "RIGHT"
    );
    assert.ok(styles.length > 0);
    assert.ok(
      fills.some(function (s) {
        return String(s).toLowerCase() === "#f53d40";
      }),
      "head fill should use primary"
    );
  });

  it("resolveAppleImageUrl prefers apple_img_arr then CDN", () => {
    global.window = global;
    global.apple_img_arr = [
      "https://example.test/apple_a.png",
      "https://example.test/apple_b.png",
      "https://example.test/apple_c.png",
    ];
    assert.equal(
      Gsm.resolveAppleImageUrl(2, 0),
      "https://example.test/apple_c.png"
    );
    assert.equal(
      Gsm.resolveAppleImageUrl(null, 1),
      "https://example.test/apple_b.png",
      "falls back to board appleIndex"
    );
    assert.equal(
      Gsm.resolveAppleImageUrl(-1, 0),
      "https://example.test/apple_a.png"
    );
    delete global.apple_img_arr;
    const url = Gsm.resolveAppleImageUrl(3, null);
    assert.ok(/apple_03\.png$/.test(url), "CDN fallback for stock fruit");
  });

  it("drawBoardOnCanvas draws fruit sprite when image is ready", () => {
    global.window = global;
    global.apple_img_arr = ["https://example.test/fruit.png"];
    global.Image = function FakeImage() {
      this.complete = true;
      this.naturalWidth = 64;
      this.onload = null;
      this.onerror = null;
      Object.defineProperty(this, "src", {
        set: function () {},
        get: function () { return "https://example.test/fruit.png"; },
      });
    };
    const ops = [];
    const ctx = {
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
      fill: function () { ops.push("fill"); },
      drawImage: function () { ops.push("fruit"); },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    // Clear module-level image cache by using unique URL via apple_img_arr
    const gsmPath = require.resolve("../src/hooks/gsm.js");
    delete require.cache[gsmPath];
    const Fresh = require("../src/hooks/gsm.js");
    Fresh.drawBoardOnCanvas(
      { width: 40, height: 40, getContext: function () { return ctx; } },
      {
        width: 2,
        height: 2,
        body: [],
        apples: [{ x: 0, y: 0, type: 0 }],
        appleIndex: 0,
      }
    );
    assert.ok(ops.indexOf("fruit") >= 0, "must drawImage fruit sprite");
    delete global.Image;
    delete global.apple_img_arr;
  });

  it("drawBoardOnCanvas draws poison fruit as skull icon", () => {
    const urls = [];
    global.window = global;
    global.Image = function FakeImage() {
      this.complete = true;
      this.naturalWidth = 64;
      this.onload = null;
      this.onerror = null;
      Object.defineProperty(this, "src", {
        set: function (v) {
          urls.push(String(v));
        },
        get: function () {
          return urls[urls.length - 1] || "";
        },
      });
    };
    const fills = [];
    const ctx = {
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
      fill: function () {
        fills.push(this.fillStyle);
      },
      drawImage: function () {},
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const gsmPath = require.resolve("../src/hooks/gsm.js");
    delete require.cache[gsmPath];
    const Fresh = require("../src/hooks/gsm.js");
    assert.ok(Fresh.POISON_SKULL_URL.indexOf("trophy_10") >= 0);
    assert.equal(Fresh.resolvePoisonImageUrl(), Fresh.POISON_SKULL_URL);
    Fresh.drawBoardOnCanvas(
      { width: 40, height: 40, getContext: function () { return ctx; } },
      {
        width: 2,
        height: 2,
        modeKey: "poison",
        body: [],
        apples: [{ x: 0, y: 0, type: 0, poison: true }],
      }
    );
    assert.ok(
      urls.some(function (u) {
        return u.indexOf("trophy_10") >= 0;
      }),
      "loads poison skull sprite"
    );
    assert.ok(
      fills.every(function (c) {
        return c !== "rgba(142,36,170,0.35)" && c !== "#8e24aa";
      }),
      "no purple poison blob"
    );
    delete global.Image;
  });

  it("scrape + draw: dimension otherDim ghost fruit and body", () => {
    const alphas = [];
    const ctx = {
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
      drawImage: function () {},
      save: function () {
        alphas.push(this.globalAlpha);
      },
      restore: function () {},
      translate: function () {},
      rotate: function () {},
      setLineDash: function () {},
    };
    // Lh false → otherDim via mapBody/mapApples (exercise through draw input)
    const bodyMapped = [
      { x: 2, y: 2, Lh: true },
      { x: 1, y: 2, Lh: false },
      { x: 0, y: 2, Lh: false },
    ].map(function (p) {
      const o = { x: p.x, y: p.y };
      if (p.Lh === false) o.otherDim = true;
      return o;
    });
    const applesMapped = [
      { x: 5, y: 5, type: 1 },
      { x: 6, y: 6, type: 2, otherDim: true },
    ];
    assert.equal(bodyMapped[0].otherDim, undefined);
    assert.equal(bodyMapped[1].otherDim, true);
    Gsm.drawBoardOnCanvas(
      {
        width: 170,
        height: 150,
        getContext: function () {
          return ctx;
        },
      },
      {
        width: 10,
        height: 10,
        modeKey: "dimension",
        body: bodyMapped,
        apples: applesMapped,
      },
      { primary: "#F53D40", secondary: "#D00B0E" }
    );
    assert.ok(
      alphas.some(function (a) {
        return a < 0.5;
      }),
      "ghost alpha used for otherDim"
    );
  });

  it("drawCoopSnapshot paints multiple snakes", () => {
    const ops = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetY: 0,
      fillRect: function () { ops.push("rect"); },
      beginPath: function () {},
      moveTo: function () {},
      lineTo: function () {},
      stroke: function () { ops.push("stroke"); },
      arc: function () {},
      fill: function () { ops.push("fill"); },
      save: function () {},
      restore: function () {},
      translate: function () {},
      rotate: function () {},
    };
    const canvas = {
      width: 240,
      height: 212,
      getContext: function () { return ctx; },
    };
    Gsm.drawCoopSnapshot(canvas, {
      width: 17,
      height: 15,
      apple: { x: 2, y: 2 },
      snakes: [
        { client_id: "a", color_id: 0, alive: true, body: [{ x: 1, y: 1 }, { x: 0, y: 1 }] },
        { client_id: "b", color_id: 35, alive: false, body: [{ x: 5, y: 5 }] },
      ],
    });
    assert.ok(ops.length > 0);
  });

  it("snakeDeltaFingerprint changes with pose and skips unchanged", () => {
    const a = {
      alive: true,
      dir: "RIGHT",
      body: [
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      Sc: "#fff",
    };
    const b = Object.assign({}, a, {
      body: [
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
    });
    const fa = Gsm.snakeDeltaFingerprint(a);
    const fb = Gsm.snakeDeltaFingerprint(b);
    assert.notEqual(fa, fb);
    assert.equal(fa, Gsm.snakeDeltaFingerprint(a));
  });

  it("startCoopRunTimer / stopCoopRunTimer toggle timeKeeper", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    delete g.__mpCoopSpectator;
    delete g.__mpVersusFocusSpectate;
    g.timeKeeper = {
      _dead: true,
      playing: false,
      start: function () {
        this.playing = true;
        this._dead = false;
      },
    };
    assert.equal(Gsm.startCoopRunTimer(), true);
    assert.equal(g.timeKeeper.playing, true);
    assert.equal(g.timeKeeper._dead, false);
    assert.equal(Gsm.stopCoopRunTimer(), true);
    assert.equal(g.timeKeeper.playing, false);
  });

  it("spectating never starts coop timer and never saves TimeKeeper", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    delete g.__mpCoopSpectator;
    delete g.__mpVersusFocusSpectate;
    const saves = [];
    g.timeKeeper = {
      playing: false,
      runStarted: false,
      shouldTrack: function () {
        return true;
      },
      start: function () {
        this.playing = true;
        this.runStarted = true;
      },
      gotApple: function () {
        saves.push("apple");
      },
      gotAll: function () {
        saves.push("all");
      },
      death: function () {
        saves.push("death");
      },
      savePB: function () {
        saves.push("pb");
      },
    };
    // Clear wrap flags from prior tests
    delete g.timeKeeper.__mpWrapped;
    delete g.timeKeeper.__mpSpectateTkGuard;

    g.__mpCoopSpectator = true;
    assert.equal(Gsm.startCoopRunTimer({ spectator: true }), false);
    assert.equal(g.timeKeeper.playing, false);
    assert.equal(Gsm.startCoopRunTimer(), false, "flag alone blocks start");
    assert.equal(g.timeKeeper.playing, false);

    assert.equal(Gsm.installSpectatorTimeKeeperGuard(), true);
    assert.equal(g.timeKeeper.shouldTrack(), false);

    delete g.timeKeeper.__mpWrapped;
    Gsm.wrapTimeKeeper({});
    g.timeKeeper.gotApple(135, 10);
    g.timeKeeper.gotAll(135, 10);
    g.timeKeeper.death(135, 10);
    assert.deepEqual(saves, [], "orig save methods must not run while spectating");

    g.__mpCoopSpectator = false;
    g.__mpVersusFocusSpectate = true;
    assert.equal(g.timeKeeper.shouldTrack(), false);
    g.__mpVersusFocusSpectate = false;
    assert.equal(g.timeKeeper.shouldTrack(), true);
  });

  it("startCoopRunTimer retries until timeKeeper appears", async () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    delete g.timeKeeper;
    const started = Gsm.startCoopRunTimer({ maxAttempts: 20, intervalMs: 10 });
    assert.equal(started, false);
    await new Promise(function (r) {
      setTimeout(r, 30);
    });
    g.timeKeeper = {
      _dead: true,
      playing: false,
      start: function () {
        this.playing = true;
        this._dead = false;
      },
    };
    await new Promise(function (r) {
      setTimeout(r, 40);
    });
    assert.equal(g.timeKeeper.playing, true);
  });

  it("scrapeCoopSnakeDelta carries score but no board size", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    g.__remixGame = {
      oa: {
        ka: [
          { x: 1, y: 2 },
          { x: 0, y: 2 },
        ],
        direction: "RIGHT",
      },
      Sh: 99,
    };
    g.__mpGame = g.__remixGame;
    const delta = Gsm.scrapeCoopSnakeDelta(0);
    assert.ok(delta);
    // Score feeds the combined co-op total; board size stays off the channel
    assert.equal(delta.score, 99);
    assert.equal(delta.width, undefined);
    assert.ok(delta.body);
    assert.equal(delta.dir, "RIGHT");
  });

  it("co-op lag: slim pose + fruit-only collectables stay small", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    g.document = g.document || {
      getElementById: function () {
        return null;
      },
      querySelector: function () {
        return null;
      },
    };
    g.__remixGame = {
      oa: {
        ka: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
          { x: 3, y: 5 },
        ],
        direction: "RIGHT",
        Sc: "#4E7CF6",
        Yc: "#17439F",
      },
      Sh: 12,
      Ba: { keys: [{ pos: { x: 1, y: 1 } }] },
      Aa: { oa: [{ pos: { x: 2, y: 2 } }] },
      wa: {
        ka: [{ pos: { x: 8, y: 8 }, type: 0 }],
        oa: { oa: { width: 17, height: 15 } },
      },
    };
    g.__mpGame = g.__remixGame;
    const pose = Gsm.scrapeCoopSnakeDelta(0, { includeColors: false });
    assert.equal(pose.score, 12);
    assert.equal(pose.height, undefined);
    assert.equal(pose.Sc, undefined);
    const poseBytes = JSON.stringify(pose).length;
    assert.ok(poseBytes < 160, "slim pose should be small, got " + poseBytes);

    const cols = Gsm.scrapeCollectables();
    assert.ok(cols.apples);
    assert.equal(cols.keys, undefined);
    assert.equal(cols.boxes, undefined);
    assert.equal(cols.walls, undefined);
    const fruitBytes = JSON.stringify(cols).length;
    assert.ok(fruitBytes < 180, "fruit-only collectables, got " + fruitBytes);

    const fp1 = Gsm.snakeDeltaFingerprint(pose);
    const fp2 = Gsm.snakeDeltaFingerprint(pose);
    assert.equal(fp1, fp2, "unchanged pose fingerprints match (skip send)");
    pose.body[0].x = 6;
    assert.notEqual(Gsm.snakeDeltaFingerprint(pose), fp1);
  });

  it("boardDeltaFingerprint skips unchanged versus boards", () => {
    const board = {
      alive: true,
      dir: "RIGHT",
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
      apples: [{ x: 1, y: 1 }],
      score: 2,
      colorId: 0,
      Sc: "#4E7CF6",
      Yc: "#17439F",
      modeKey: "classic",
    };
    const a = Gsm.boardDeltaFingerprint(board);
    const b = Gsm.boardDeltaFingerprint(board);
    assert.equal(a, b);
    board.body[0].x = 6;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), a);
    board.body[0].x = 5;
    board.apples[0].x = 2;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), a);
    board.apples[0].x = 1;
    // Chess: type change (piece unlock) must also differ
    const fp0 = Gsm.boardDeltaFingerprint(board);
    board.apples[0].type = 42;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fp0, "type change triggers re-upload");
    delete board.apples[0].type;
    const fp1 = Gsm.boardDeltaFingerprint(board);
    board.apples[0].isPiece = true;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fp1, "isPiece change triggers re-upload");
    delete board.apples[0].isPiece;
    // Cat: spending a life / grace ticking must reach mosaic spectators
    board.catLives = 3;
    const fpCat = Gsm.boardDeltaFingerprint(board);
    board.catLives = 2;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fpCat, "cat life change re-uploads");
    board.catLives = 3;
    assert.equal(Gsm.boardDeltaFingerprint(board), fpCat);
    board.catGrace = 5;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fpCat, "cat grace change re-uploads");
    delete board.catLives;
    delete board.catGrace;
    // Poison: both edges of the countdown must reach mosaic spectators
    const fpClean = Gsm.boardDeltaFingerprint(board);
    board.poisonTicks = 8;
    const fpPoison = Gsm.boardDeltaFingerprint(board);
    assert.notEqual(fpPoison, fpClean, "getting poisoned re-uploads");
    board.poisonTicks = 7;
    assert.equal(
      Gsm.boardDeltaFingerprint(board),
      fpPoison,
      "ticking down alone does not re-upload"
    );
    board.poisonTicks = 0;
    assert.equal(Gsm.boardDeltaFingerprint(board), fpClean, "wearing off re-uploads");
    delete board.poisonTicks;
    // Dimension: a swap inverts every flag, so an even body can keep the same
    // ghost count while the solid/ghost split moves to the other end
    board.body = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5, otherDim: true },
      { x: 2, y: 5, otherDim: true },
    ];
    const fpBefore = Gsm.boardDeltaFingerprint(board);
    board.body[0].otherDim = true;
    board.body[1].otherDim = true;
    delete board.body[2].otherDim;
    delete board.body[3].otherDim;
    assert.notEqual(
      Gsm.boardDeltaFingerprint(board),
      fpBefore,
      "dimension swap re-uploads"
    );
    // Bomb Fruit: zones outlive the fruit, and each armed tick redraws the pulse
    board.bombZones = [{ x: 3, y: 4, arm: -1 }];
    const fpBomb = Gsm.boardDeltaFingerprint(board);
    board.bombZones = [{ x: 3, y: 4, arm: 3 }];
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fpBomb, "arming re-uploads");
    board.bombZones = [{ x: 5, y: 4, arm: -1 }];
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fpBomb, "moved zone re-uploads");
    board.bombZones = [{ x: 3, y: 4, arm: -1 }, { x: 9, y: 1, arm: -1 }];
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fpBomb, "new zone re-uploads");
    board.bombZones = [{ x: 3, y: 4, arm: -1 }];
    assert.equal(Gsm.boardDeltaFingerprint(board), fpBomb);
    delete board.bombZones;
    // Slot: a badge swap on a fruit that did not move must still re-upload
    board.apples = [{ x: 1, y: 1, slotMode: 26 }, { x: 4, y: 4, slotMode: 5 }];
    const fpSlot = Gsm.boardDeltaFingerprint(board);
    board.apples[1].slotMode = 28;
    assert.notEqual(Gsm.boardDeltaFingerprint(board), fpSlot, "badge swap re-uploads");
    board.apples[1].slotMode = 5;
    assert.equal(Gsm.boardDeltaFingerprint(board), fpSlot);
  });

  it("installModeLabelPatch maps unknown_N via modeToTxt", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    g.modeToTxt = {
      20: { name: "Bridge" },
      21: { name: "Peaceful" },
    };
    g.ModeRegistry = {
      labelModeKey: function (key) {
        return key;
      },
      listActiveModes: function () {
        return [
          { id: "unknown_20", label: "unknown_20", index: 20 },
          { id: "unknown_21", label: "unknown_21", index: 21 },
        ];
      },
    };
    assert.equal(Gsm.installModeLabelPatch(), true);
    assert.equal(g.ModeRegistry.labelModeKey("unknown_21"), "Peaceful");
    assert.equal(g.ModeRegistry.labelModeKey("trophy_20"), "Bridge");
    const list = g.ModeRegistry.listActiveModes();
    assert.equal(list[0].label, "Bridge");
    assert.equal(list[1].label, "Peaceful");
    assert.equal(list[1].id, "peaceful");
  });

  it("co-op collectables can ship walls, badges, burger timers and keys", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    g.__remixGame = {
      oa: { ka: [{ x: 3, y: 3 }], oa: { width: 17, height: 15 } },
      Ca: {
        wa: (function () {
          const grid = [];
          for (let y = 0; y < 15; y++) {
            grid[y] = [];
            for (let x = 0; x < 17; x++) grid[y][x] = 0;
          }
          grid[5][5] = 1;
          return grid;
        })(),
        Aa: null,
      },
      Ba: { keys: [{ pos: { x: 4, y: 4 }, type: 2, r7a: { x: 5, y: 5 } }] },
      wa: {
        ka: [
          {
            pos: { x: 8, y: 8 },
            type: 0,
            slotMode: 1,
            burgerTimer: 12,
            burgerTimerMax: 20,
          },
        ],
        oa: { oa: { width: 17, height: 15 } },
      },
    };
    g.__mpGame = g.__remixGame;
    const cols = Gsm.scrapeCollectables({ includeEntities: true });
    assert.ok(cols.walls && cols.walls.length);
    assert.ok(cols.keys && cols.keys.length);
    assert.equal(cols.apples[0].slotMode, 1);
    assert.equal(cols.apples[0].burgerTimer, 12);
    const fp = Gsm.collectablesFingerprint(cols);
    assert.ok(fp.indexOf("s1") >= 0);
    assert.ok(fp.indexOf("b12") >= 0);
  });

  it("applyBoardEntities writes the wall grid and soko boxes", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    g.__remixGame = {
      oa: { ka: [{ x: 1, y: 1 }], oa: { width: 8, height: 6 } },
      Ca: {
        wa: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
      Aa: { oa: [{ pos: { x: 0, y: 0, clone: function () { return { x: 0, y: 0, clone: this.clone }; } } }] },
      wa: { ka: [], oa: { oa: { width: 8, height: 6 } } },
    };
    g.__mpGame = g.__remixGame;
    Gsm.applyBoardEntities({
      walls: [{ x: 1, y: 1 }],
      boxes: [{ x: 2, y: 2 }],
    });
    assert.equal(g.__remixGame.Ca.wa[1][1], 1);
    assert.equal(g.__remixGame.Aa.oa[0].pos.x, 2);
  });

  it("Yin Yang corners put right-side snakes facing left", () => {
    const tr = Gsm.coopYinYangCorner(1, 17, 15);
    assert.equal(tr.dir, "LEFT");
    assert.ok(tr.x > 8);
    const body = Gsm.coopSpawnBodyFromPose(tr);
    assert.equal(body[1].x, tr.x + 1);
    const tl = Gsm.coopYinYangCorner(0, 17, 15);
    assert.equal(tl.dir, "RIGHT");
    const leftBody = Gsm.coopSpawnBodyFromPose(tl);
    assert.equal(leftBody[1].x, tl.x - 1);
  });

  it("applyCoopStartMoving assigns an idle snake its facing", () => {
    const g = typeof globalThis !== "undefined" ? globalThis : global;
    g.__remixGame = { oa: { ka: [{ x: 5, y: 5 }] } };
    g.__mpGame = g.__remixGame;
    assert.equal(Gsm.applyCoopStartMoving("LEFT"), true);
    assert.equal(g.__remixGame.oa.direction, "LEFT");
  });
});
