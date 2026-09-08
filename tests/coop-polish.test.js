"use strict";

/**
 * Plan 1 polish: seq-gated apply, motion interval, size helpers, timer hold.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadBinder(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/binder.js"));
  delete require.cache[p];
  require(p);
}

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  const modPath = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[modPath];
  return require(path.join(ROOT, "src/hooks/gsm.js"));
}

describe("coop polish — seq gate / motion / size / timer", () => {
  let win;
  let writeCount;

  beforeEach(() => {
    writeCount = 0;
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.timeKeeper = { playing: true, _lastTimeMs: 99, _dead: false };
    win.pauseGame = 0;
    win.MultiplayerGsm = {
      writeNativeBody: function (snake, body) {
        writeCount++;
        snake.ka = body.map(function (p) {
          return { x: p.x | 0, y: p.y | 0 };
        });
      },
      ensureSnakeSegmentFlags: function () {},
      ensureNativeWallMap: function (h) {
        h.Aa = h.Aa || new Map();
      },
      ensureWallGridDense: function () {},
      applyCollectables: function (payload) {
        win.__lastApples = (payload.apples || []).map(function (a) {
          return { x: a.x | 0, y: a.y | 0 };
        });
      },
      setLocalPaused: function (p) {
        win.pauseGame = p ? 1 : 0;
      },
      makeNativePoint: function (x, y) {
        return { x: x | 0, y: y | 0 };
      },
      followBodyFromHead: function (_prev, next) {
        return (next || []).map(function (p) {
          return { x: p.x | 0, y: p.y | 0 };
        });
      },
    };
    win.__mpGame = {
      oa: {
        ka: [{ x: 0, y: 0 }],
        direction: "RIGHT",
        oa: { width: 17, height: 15 },
      },
      Ca: {
        Aa: new Map(),
        wa: Array.from({ length: 17 }, () => Array(17).fill(0)),
      },
      wa: { ka: [{ pos: { x: 1, y: 1 } }] },
      nj: false,
    };
    win.__mpCoopServerAuth = true;
    win.__mpCoopRemotes = {};
    win.__mpCoopAppliedSeq = null;
    win.__mpCoopSeatLocked = false;
    loadBinder(win);
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("same seq does not writeNativeBody again; new seq does", () => {
    const body = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ];
    const state = {
      seq: 10,
      intervalMs: 142,
      width: 17,
      height: 15,
      snakes: [{ clientId: "me", body: body, dir: "RIGHT", alive: true }],
      fruit: [{ x: 12, y: 4, type: 0 }],
    };
    const r1 = win.CoopBinder.applyCoopState(state, "me");
    assert.equal(r1.local, true);
    assert.equal(writeCount, 1);
    const r2 = win.CoopBinder.applyCoopState(state, "me");
    assert.equal(r2.skipped, true);
    assert.equal(writeCount, 1, "same seq must not rewrite body");
    const moved = Object.assign({}, state, {
      seq: 11,
      snakes: [
        {
          clientId: "me",
          body: [
            { x: 6, y: 5 },
            { x: 5, y: 5 },
            { x: 4, y: 5 },
          ],
          dir: "RIGHT",
          alive: true,
        },
      ],
    });
    const r3 = win.CoopBinder.applyCoopState(moved, "me");
    assert.equal(r3.local, true);
    assert.equal(writeCount, 2);
    assert.equal(win.__mpGame.oa.ka[0].x, 6);
  });

  it("force apply rewrites even when seq unchanged", () => {
    const state = {
      seq: 1,
      snakes: [
        {
          clientId: "me",
          body: [
            { x: 8, y: 7 },
            { x: 7, y: 7 },
            { x: 6, y: 7 },
          ],
          dir: "RIGHT",
          alive: true,
        },
      ],
      fruit: [],
    };
    win.CoopBinder.applyCoopState(state, "me");
    win.__mpGame.oa.ka[0].x = 0;
    win.__mpGame.oa.ka[0].y = 0;
    win.CoopBinder.applyCoopState(state, "me", { force: true });
    assert.equal(win.__mpGame.oa.ka[0].x, 8);
  });

  it("applies STATE fruit over native Play apples", () => {
    win.__mpGame.wa.ka = [{ pos: { x: 1, y: 1 } }];
    win.CoopBinder.applyCoopState(
      {
        seq: 2,
        snakes: [
          {
            clientId: "me",
            body: [
              { x: 5, y: 5 },
              { x: 4, y: 5 },
            ],
            dir: "RIGHT",
            alive: true,
          },
        ],
        fruit: [{ x: 12, y: 4, type: 0 }],
      },
      "me"
    );
    assert.deepEqual(win.__lastApples, [{ x: 12, y: 4 }]);
  });

  it("snakeMotion uses holder._lerpStepMs when set", () => {
    const Gsm = loadGsm(win);
    assert.ok(Gsm && Gsm.snakeMotion);
    const holder = { _lerpStepMs: 142 };
    const body1 = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ];
    const t0 = 1000;
    assert.equal(Gsm.snakeMotion(holder, "coop", body1, t0), null);
    const body2 = [
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 4, y: 5 },
    ];
    // Gap is tiny (5ms) — without forced step motion would be null
    const mid = Gsm.snakeMotion(holder, "coop", body2, t0 + 5);
    assert.ok(mid, "forced intervalMs must create a slide");
    assert.ok(mid.u >= 0 && mid.u < 1);
    assert.equal(mid.headFrom.x, 5);
  });

  it("boardDimsForSizeIndex and ensureWallGridDense shrink", () => {
    const Gsm = loadGsm(win);
    assert.deepEqual(Gsm.boardDimsForSizeIndex(1), { width: 10, height: 9 });
    assert.deepEqual(Gsm.boardDimsForSizeIndex(0), { width: 17, height: 15 });
    const host = {
      wa: Array.from({ length: 15 }, () => Array(17).fill(1)),
    };
    Gsm.ensureWallGridDense(host, 10, 9);
    assert.equal(host.wa.length, 9);
    assert.equal(host.wa[0].length, 10);
  });

  it("deferTimer-style hold leaves timeKeeper stopped until arm", () => {
    win.timeKeeper.playing = false;
    win.timeKeeper._lastTimeMs = 0;
    assert.equal(win.timeKeeper.playing, false);
    assert.equal(win.timeKeeper._lastTimeMs, 0);
    win.timeKeeper.playing = true;
    win.timeKeeper._lastTimeMs = 50;
    assert.equal(win.timeKeeper.playing, true);
  });

  it("mid-match death sets corpse flag without nj or stopping timer", () => {
    const body = [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ];
    win.timeKeeper.playing = true;
    win.__mpGame.nj = false;
    win.CoopBinder.applyCoopState(
      {
        seq: 20,
        width: 17,
        height: 15,
        snakes: [{ clientId: "me", body: body, dir: "RIGHT", alive: false }],
        fruit: [],
      },
      "me"
    );
    assert.equal(win.__mpCoopLocalCorpse, true);
    assert.equal(win.__mpGame.nj, false, "must not arm native death stars");
    assert.equal(win.timeKeeper.playing, true, "shared timer must keep running");
    assert.equal(win.timeKeeper._dead, false);
  });

  it("server-auth die guard never calls origDie or sets nj", () => {
    const Gsm = loadGsm(win);
    let origCalls = 0;
    win.__mpGame.die = function () {
      origCalls++;
      this.nj = true;
    };
    win.__mpGame.__mpFocusDieGuarded = false;
    win.__mpCoopServerAuth = true;
    win.__mpCoopLastState = {
      ended: false,
      snakes: [
        {
          clientId: "me",
          alive: false,
          body: [
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      ],
    };
    win.__mpCoopLastStateMyId = "me";
    win.__mpGame.nj = false;
    win.timeKeeper.playing = true;
    Gsm.installFocusDieGuard(win.__mpGame);
    win.__mpGame.die();
    assert.equal(origCalls, 0);
    assert.equal(win.__mpGame.nj, false);
    assert.equal(win.__mpCoopLocalCorpse, true);
    assert.equal(win.timeKeeper.playing, true);
  });

  it("fruit fingerprint skip — same fruit does not wipe hosts on force seat", () => {
    let applyCount = 0;
    win.MultiplayerGsm.applyCollectables = function (payload) {
      applyCount++;
      win.__lastApples = (payload.apples || []).map(function (a) {
        return { x: a.x | 0, y: a.y | 0 };
      });
      win.__lastFruitHardReset = !!payload.hardReset;
    };
    win.__mpCoopFruitHardReset = true;
    win.__mpCoopFruitFp = null;
    const state = {
      seq: 1,
      width: 17,
      height: 15,
      snakes: [
        {
          clientId: "me",
          body: [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
          ],
          dir: "RIGHT",
          alive: true,
        },
      ],
      fruit: [{ x: 12, y: 7, type: 0 }],
    };
    win.CoopBinder.applyCoopState(state, "me");
    assert.equal(applyCount, 1);
    assert.equal(win.__lastFruitHardReset, true);
    win.CoopBinder.applyCoopState(state, "me", {
      force: true,
      skipFruit: true,
      bodyOnly: true,
    });
    assert.equal(applyCount, 1, "skipFruit seat must not touch fruit");
    win.CoopBinder.applyCoopState(
      Object.assign({}, state, { seq: 2 }),
      "me"
    );
    assert.equal(applyCount, 1, "unchanged fruit fp must not re-apply");
    win.CoopBinder.applyCoopState(
      Object.assign({}, state, {
        seq: 3,
        fruit: [{ x: 10, y: 7, type: 0 }],
      }),
      "me"
    );
    assert.equal(applyCount, 2, "moved fruit must re-apply");
    assert.equal(win.__lastFruitHardReset, false);
  });

  it("writeLocalBody does not clear mouth/grow and skips identical bodies", () => {
    win.__mpGame.oa.ka = [
      { x: 5, y: 5, clone: function () { return this; } },
      { x: 4, y: 5, clone: function () { return this; } },
    ];
    win.__mpGame.oa.mouth = true;
    win.__mpGame.oa.grow = 2;
    win.__mpGame.oa.eating = true;
    let writes = 0;
    const prevWrite = win.MultiplayerGsm.writeNativeBody;
    win.MultiplayerGsm.writeNativeBody = function (snake, body) {
      writes++;
      return prevWrite(snake, body);
    };
    const state = {
      seq: 50,
      width: 17,
      height: 15,
      snakes: [
        {
          clientId: "me",
          body: [
            { x: 5, y: 5 },
            { x: 4, y: 5 },
          ],
          dir: "RIGHT",
          alive: true,
        },
      ],
      fruit: [],
    };
    win.CoopBinder.applyCoopState(state, "me");
    assert.equal(writes, 0, "identical body must not rewrite ka");
    assert.equal(win.__mpGame.oa.mouth, true);
    assert.equal(win.__mpGame.oa.grow, 2);
    assert.equal(win.__mpGame.oa.eating, true);
    win.CoopBinder.applyCoopState(
      Object.assign({}, state, {
        seq: 51,
        snakes: [
          {
            clientId: "me",
            body: [
              { x: 6, y: 5 },
              { x: 5, y: 5 },
            ],
            dir: "RIGHT",
            alive: true,
          },
        ],
      }),
      "me"
    );
    assert.equal(writes, 1, "moved body rewrites once");
    assert.equal(win.__mpGame.oa.mouth, true, "mouth must survive body write");
    assert.equal(win.__mpGame.oa.grow, 2, "grow must survive body write");
  });
});
