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
    assert.equal(typeof Gsm.startCoopRunTimer, "function");
    assert.equal(typeof Gsm.stopCoopRunTimer, "function");
    assert.equal(typeof Gsm.scrapeCoopSnakeDelta, "function");
    assert.equal(typeof Gsm.snakeDeltaFingerprint, "function");
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
      globalAlpha: 1,
      fillRect: function () { ops.push("rect"); },
      beginPath: function () {},
      arc: function () {},
      fill: function () { ops.push("fill"); },
    };
    const canvas = {
      width: 170,
      height: 150,
      getContext: function () { return ctx; },
    };
    Gsm.drawBoardOnCanvas(canvas, {
      width: 17,
      height: 15,
      body: [{ x: 1, y: 1 }],
      apples: [{ x: 3, y: 3 }],
    });
    assert.ok(ops.length > 0);
  });

  it("drawCoopSnapshot paints multiple snakes", () => {
    const ops = [];
    const ctx = {
      fillStyle: "",
      globalAlpha: 1,
      fillRect: function () { ops.push("rect"); },
      beginPath: function () {},
      arc: function () {},
      fill: function () { ops.push("fill"); },
    };
    const canvas = {
      width: 170,
      height: 150,
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
});
