"use strict";

/**
 * New co-op SESSION_START must purge leftover eat/fruit state from the prior run.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

describe("coop session reset clears eat leftovers", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpGame = {
      nj: false,
      oa: {
        ka: [
          { x: 5, y: 5, clone: function () { return { x: this.x, y: this.y }; } },
          { x: 4, y: 5, clone: function () { return { x: this.x, y: this.y }; } },
        ],
        grow: 3,
        eating: true,
        mouth: 1,
      },
      wa: {
        ka: [
          {
            pos: { x: 5, y: 5, clone: function () { return { x: 5, y: 5 }; } },
            type: 0,
            eating: true,
            eatProgress: 0.9,
          },
        ],
      },
      Ca: { Aa: new Map(), wa: [[0, 0], [0, 0]] },
    };
    win.__remixGame = win.__mpGame;
    win.__mpCoopLastState = {
      ended: true,
      seq: 99,
      fruit: [{ x: 5, y: 5, type: 0 }],
      snakes: [],
    };
    win.__mpCoopServerAuth = true;
    win.timeKeeper = { _dead: false, _lastScore: 12, lastAppleTime: 999 };
    delete require.cache[require.resolve(path.join(ROOT, "src/hooks/gsm.js"))];
    require(path.join(ROOT, "src/hooks/gsm.js"));
  });

  it("resetCoopBoardForNewSession clears fruit, grow, and last STATE", () => {
    const Gsm = win.MultiplayerGsm;
    assert.ok(Gsm.resetCoopBoardForNewSession);
    Gsm.resetCoopBoardForNewSession();
    assert.equal(win.__mpGame.wa.ka.length, 0, "fruit hosts wiped");
    assert.equal(win.__mpGame.oa.grow, 0);
    assert.equal(win.__mpGame.oa.eating, false);
    assert.equal(win.__mpCoopLastState, null, "stale COOP_STATE dropped");
    assert.equal(win.timeKeeper._lastScore, 0);
  });

  it("resetCoopBoardForNewSession zeros score, timer, and endscreen flags", () => {
    const Gsm = win.MultiplayerGsm;
    win.__mpGame.nj = true;
    win.__mpGame.Sh = 52;
    win.__mpGame.Oh = 52;
    win.timeKeeper._lastScore = 52;
    win.timeKeeper._lastTimeMs = 12345;
    win.timeKeeper.lastAppleTime = 12345;
    win.timeKeeper.__mpCoopStartedAtMs = 999;
    win.timeKeeper.playing = true;
    Gsm.resetCoopBoardForNewSession();
    assert.equal(win.__mpGame.nj, false);
    assert.equal(win.__mpGame.Sh, 0);
    assert.equal(win.__mpGame.Oh, 0);
    assert.equal(win.timeKeeper._lastScore, 0);
    assert.equal(win.timeKeeper._lastTimeMs, 0);
    assert.equal(win.timeKeeper.lastAppleTime, 0);
    assert.equal(win.timeKeeper.playing, false);
    assert.ok(
      win.timeKeeper.__mpCoopStartedAtMs == null,
      "shared timer anchor cleared"
    );
  });

  it("reapplyLastState ignores ended previous match", () => {
    require(path.join(ROOT, "src/coop/binder.js"));
    win.__mpCoopSession = true;
    win.__mpCoopLastState = { ended: true, seq: 1, fruit: [{ x: 1, y: 1 }], snakes: [] };
    const ok = win.CoopBinder.reapplyLastState();
    assert.equal(ok, false);
  });
});
