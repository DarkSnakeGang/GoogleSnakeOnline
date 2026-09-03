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

  it("scrapeCoopSnakeDelta omits score by default", () => {
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
    assert.equal(delta.score, undefined);
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
    assert.equal(pose.score, undefined);
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
});
