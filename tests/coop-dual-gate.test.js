"use strict";

/**
 * Plan 1 dual-client binder smoke (no live server):
 * - first Start seats both locals from STATE
 * - A input STATE moves only A; B stays
 * - peer remotes preserve motion across frames
 * - soft reset skips native reset
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

function makeClient(clientId, headY) {
  const win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
  global.window = win;
  global.document = win.document;
  win.__mpCoopServerAuth = true;
  win.__mpCoopSession = true;
  win.__mpCoopInject = true;
  win.__mpCoopMyId = clientId;
  win.MultiplayerGsm = {
    writeNativeBody: function (snake, body) {
      snake.ka = body.map(function (p) {
        return {
          x: p.x | 0,
          y: p.y | 0,
          clone: function () {
            return { x: this.x, y: this.y, clone: this.clone };
          },
        };
      });
    },
    ensureSnakeSegmentFlags: function (snake) {
      snake.wa = (snake.ka || []).map(function () {
        return true;
      });
    },
    ensureNativeWallMap: function (host) {
      host.Aa = host.Aa || new Map();
      return host.Aa;
    },
    applyCollectables: function () {},
    makeNativePoint: function (x, y) {
      return { x: x | 0, y: y | 0 };
    },
    followBodyFromHead: function (prev, next) {
      return (next || []).map(function (p) {
        return { x: p.x | 0, y: p.y | 0 };
      });
    },
    snakeMotion: function () {
      return null;
    },
  };
  // Start at wrong center (y=4) until STATE seats
  win.__mpGame = {
    nj: false,
    dead: false,
    reset: function () {
      win.__nativeResetCount = (win.__nativeResetCount | 0) + 1;
    },
    oa: {
      ka: [
        { x: 5, y: 4 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      direction: "RIGHT",
      oa: { width: 10, height: 9 },
    },
    wa: { ka: [], oa: { oa: { width: 10, height: 9 } } },
    Ca: { Aa: new Map(), wa: [] },
  };
  win.__remixGame = win.__mpGame;
  win.__nativeResetCount = 0;
  load(win, "src/coop/binder.js");
  load(win, "src/coop/native.js");
  win.__expectedY = headY;
  win.__clientId = clientId;
  return win;
}

function spawnState() {
  return {
    seq: 1,
    tick: 0,
    width: 10,
    height: 9,
    intervalMs: 142,
    score: 0,
    fruit: [{ x: 8, y: 4, type: 0 }],
    snakes: [
      {
        clientId: "a",
        body: [
          { x: 5, y: 3 },
          { x: 4, y: 3 },
          { x: 3, y: 3 },
        ],
        dir: "RIGHT",
        alive: true,
        score: 0,
      },
      {
        clientId: "b",
        body: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
          { x: 3, y: 5 },
        ],
        dir: "RIGHT",
        alive: true,
        score: 0,
      },
    ],
  };
}

describe("coop dual-client classic gate smoke", () => {
  let a;
  let b;

  beforeEach(() => {
    a = makeClient("a", 3);
    b = makeClient("b", 5);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("first STATE seats both locals off center before any key", () => {
    const state = spawnState();
    global.window = a;
    global.document = a.document;
    a.CoopBinder.applyCoopState(state, "a");
    assert.equal(a.__mpGame.oa.ka[0].y, 3);
    assert.equal(a.__mpCoopRemotes.b.body[0].y, 5);

    global.window = b;
    global.document = b.document;
    b.CoopBinder.applyCoopState(state, "b");
    assert.equal(b.__mpGame.oa.ka[0].y, 5);
    assert.equal(b.__mpCoopRemotes.a.body[0].y, 3);
  });

  it("A move STATE updates A local + B remote; B local stays", () => {
    const state = spawnState();
    a.CoopBinder.applyCoopState(state, "a");
    b.CoopBinder.applyCoopState(state, "b");
    // A crawls right one cell; B idle
    const moved = JSON.parse(JSON.stringify(state));
    moved.seq = 2;
    moved.tick = 1;
    moved.snakes[0].body = [
      { x: 6, y: 3 },
      { x: 5, y: 3 },
      { x: 4, y: 3 },
    ];
    a.CoopBinder.applyCoopState(moved, "a");
    b.CoopBinder.applyCoopState(moved, "b");
    assert.equal(a.__mpGame.oa.ka[0].x, 6);
    assert.equal(a.__mpGame.oa.ka[0].y, 3);
    assert.equal(b.__mpGame.oa.ka[0].x, 5, "B native must not crawl on A input");
    assert.equal(b.__mpGame.oa.ka[0].y, 5);
    assert.equal(b.__mpCoopRemotes.a.body[0].x, 6);
  });

  it("peer remote keeps motion holder across A steps", () => {
    const state = spawnState();
    b.CoopBinder.applyCoopState(state, "b");
    b.__mpCoopRemotes.a.__mpMotion = {
      coop: { fp: "keep", at: 1, step: 142, from: null, ends: {} },
    };
    const moved = JSON.parse(JSON.stringify(state));
    moved.seq = 2;
    moved.snakes[0].body = [
      { x: 6, y: 3 },
      { x: 5, y: 3 },
      { x: 4, y: 3 },
    ];
    b.CoopBinder.applyCoopState(moved, "b");
    assert.ok(b.__mpCoopRemotes.a.__mpMotion);
    assert.equal(b.__mpCoopRemotes.a.__mpMotion.coop.fp, "keep");
    assert.equal(b.__mpCoopRemotes.a._lerpStepMs, 142);
  });

  it("soft reset under server-auth does not run native reset", () => {
    global.window = a;
    global.document = a.document;
    a.__mpCoopOnLocalReset = function () {
      a.CoopBinder.reapplyLastState();
    };
    const state = spawnState();
    a.CoopBinder.applyCoopState(state, "a");
    a.__mpCoopOnTick(a.__mpGame);
    assert.equal(a.__mpGame.__mpCoopResetWrapped, true);
    a.__mpGame.reset();
    assert.equal(a.__nativeResetCount, 0, "native reset must be skipped");
    assert.equal(a.__mpGame.oa.ka[0].y, 3);
  });
});
