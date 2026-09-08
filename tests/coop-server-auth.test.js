"use strict";

/**
 * Plan 1: server-auth co-op binder + protocol smoke.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

describe("coop server-auth binder", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.MultiplayerGsm = {
      writeNativeBody: function (snake, body) {
        snake.ka = body.map(function (p) {
          return { x: p.x | 0, y: p.y | 0 };
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
      applyCollectables: function (payload) {
        win.__lastApples = payload.apples;
      },
      makeNativePoint: function (x, y) {
        return { x: x | 0, y: y | 0 };
      },
    };
    win.__mpGame = {
      oa: { ka: [{ x: 0, y: 0 }], direction: "RIGHT" },
      Ca: { Aa: null, wa: [[0]] },
      wa: { ka: [] },
      nj: false,
    };
    win.__mpCoopServerAuth = true;
    win.__mpCoopRemotes = {};
    delete require.cache[require.resolve(path.join(ROOT, "src/coop/binder.js"))];
    require(path.join(ROOT, "src/coop/binder.js"));
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  it("applies local body growth and fruit from COOP_STATE", () => {
    const ok = win.CoopBinder.applyCoopState(
      {
        seq: 1,
        tick: 1,
        score: 2,
        snakes: [
          {
            clientId: "me",
            body: [
              { x: 5, y: 5 },
              { x: 4, y: 5 },
              { x: 3, y: 5 },
              { x: 2, y: 5 },
            ],
            dir: "RIGHT",
            alive: true,
            score: 2,
          },
          {
            clientId: "peer",
            body: [
              { x: 1, y: 1 },
              { x: 1, y: 2 },
            ],
            dir: "DOWN",
            alive: true,
            colorId: 4,
            score: 0,
          },
        ],
        fruit: [
          { x: 8, y: 8, type: 3 },
          { x: 9, y: 9, type: 3 },
        ],
      },
      "me"
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.local, true);
    assert.equal(ok.remotes, true);
    assert.equal(win.__mpGame.oa.ka.length, 4);
    assert.equal(win.__mpGame.oa.ka[0].x, 5);
    assert.ok(win.__lastApples);
    assert.equal(win.__lastApples.length, 2);
    assert.equal(win.__lastApples[0].type, 3);
    assert.ok(win.__mpCoopRemotes.peer);
    assert.equal(win.__mpCoopRemotes.peer.body.length, 2);
    assert.equal(win.__mpCoopRemotes.me, undefined);
  });

  it("keeps native death effects off and exposes a local corpse from STATE", () => {
    win.CoopBinder.applyCoopState(
      {
        seq: 2,
        snakes: [
          {
            clientId: "me",
            body: [{ x: 0, y: 0 }],
            dir: "LEFT",
            alive: false,
            score: 0,
          },
        ],
        fruit: [],
      },
      "me"
    );
    assert.equal(win.__mpGame.nj, false);
    assert.equal(win.__mpCoopLocalCorpse, true);
  });

  it("input capture sends COOP_INPUT and allows native wake", () => {
    win.__mpCoopSession = true;
    let sent = null;
    win.CoopBinder.installCoopInputCapture(function (dir) {
      sent = dir;
    });
    const ev = new win.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    let bubbled = false;
    win.addEventListener("keydown", function () {
      bubbled = true;
    });
    win.dispatchEvent(ev);
    assert.equal(sent, "RIGHT");
    assert.equal(win.__mpGame.oa.direction, "RIGHT");
    // Must NOT stopPropagation — native needs the key to tick/wake
    assert.equal(bubbled, true, "native listeners must still see the key");
  });

  it("preserves remote motion fields across STATE frames", () => {
    win.CoopBinder.applyRemotesFromState(
      {
        intervalMs: 142,
        snakes: [
          {
            clientId: "me",
            body: [{ x: 5, y: 5 }],
          },
          {
            clientId: "peer",
            body: [
              { x: 5, y: 7 },
              { x: 4, y: 7 },
            ],
            dir: "RIGHT",
            alive: true,
          },
        ],
      },
      "me"
    );
    const r1 = win.__mpCoopRemotes.peer;
    assert.ok(r1._visualBody);
    r1.__mpMotion = { coop: { fp: "seed", at: 1, step: 142, from: {}, ends: {} } };
    r1._lerpAt = 1000;
    win.MultiplayerGsm.followBodyFromHead = function (prev, next) {
      return next.map(function (p) {
        return { x: p.x, y: p.y };
      });
    };
    win.CoopBinder.applyRemotesFromState(
      {
        intervalMs: 142,
        snakes: [
          { clientId: "me", body: [{ x: 5, y: 5 }] },
          {
            clientId: "peer",
            body: [
              { x: 6, y: 7 },
              { x: 5, y: 7 },
            ],
            dir: "RIGHT",
            alive: true,
          },
        ],
      },
      "me"
    );
    const r2 = win.__mpCoopRemotes.peer;
    assert.equal(r2.body[0].x, 6);
    assert.ok(r2.__mpMotion, "motion holder must survive STATE merge");
    assert.equal(r2.__mpMotion.coop.fp, "seed");
    assert.ok(r2._visualBody);
    assert.equal(r2._lerpStepMs, 142);
  });

  it("applies grow length and fruit from STATE after eat", () => {
    win.CoopBinder.applyCoopState(
      {
        seq: 3,
        score: 1,
        snakes: [
          {
            clientId: "me",
            body: [
              { x: 6, y: 5 },
              { x: 5, y: 5 },
              { x: 4, y: 5 },
              { x: 3, y: 5 },
            ],
            dir: "RIGHT",
            alive: true,
            score: 1,
          },
        ],
        fruit: [{ x: 9, y: 9, type: 0 }],
      },
      "me"
    );
    assert.equal(win.__mpGame.oa.ka.length, 4, "grow +1 segment from STATE");
    assert.equal(win.__lastApples.length, 1, "fruit refilled / replaced from STATE");
    assert.equal(win.__mpGame.nj, false);
  });

  it("localHeadMatchesState detects seat", () => {
    win.CoopBinder.applyCoopState(
      {
        snakes: [
          {
            clientId: "me",
            body: [
              { x: 5, y: 6 },
              { x: 4, y: 6 },
            ],
            dir: "RIGHT",
            alive: true,
          },
        ],
        fruit: [],
      },
      "me"
    );
    assert.equal(
      win.CoopBinder.localHeadMatchesState(win.__mpCoopLastState, "me"),
      true
    );
    win.__mpGame.oa.ka[0].x = 8;
    assert.equal(
      win.CoopBinder.localHeadMatchesState(win.__mpCoopLastState, "me"),
      false
    );
  });
});

describe("protocol coop types", () => {
  it("exports COOP_INPUT and COOP_STATE", () => {
    const p = path.join(ROOT, "src/shared/protocol.js");
    delete require.cache[require.resolve(p)];
    const Proto = require(p);
    assert.equal(Proto.TYPES.COOP_INPUT, "COOP_INPUT");
    assert.equal(Proto.TYPES.COOP_STATE, "COOP_STATE");
  });
});
