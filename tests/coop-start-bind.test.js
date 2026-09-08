"use strict";

/**
 * Server-auth co-op Start must seat local body + peer remotes every time.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function load(win, rel) {
  const p = require.resolve(path.join(ROOT, rel));
  delete require.cache[p];
  require(p);
}

describe("coop server-auth start bind", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
    win.__mpCoopServerAuth = true;
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__mpGame = {
      nj: false,
      oa: {
        ka: [
          { x: 5, y: 4, clone: function () { return { x: this.x, y: this.y }; } },
          { x: 4, y: 4, clone: function () { return { x: this.x, y: this.y }; } },
          { x: 3, y: 4, clone: function () { return { x: this.x, y: this.y }; } },
        ],
        oa: { width: 10, height: 9 },
        direction: "RIGHT",
      },
      wa: { ka: [], oa: { oa: { width: 10, height: 9 } } },
      Ca: { Aa: new Map(), wa: [] },
    };
    win.__remixGame = win.__mpGame;
    load(win, "src/hooks/gsm.js");
    load(win, "src/coop/binder.js");
  });

  it("applyCoopState sets remotes even before caring about return shape", () => {
    const r = win.CoopBinder.applyCoopState(
      {
        seq: 1,
        width: 10,
        height: 9,
        fruit: [{ x: 7, y: 4, type: 0 }],
        snakes: [
          {
            clientId: "me",
            body: [
              { x: 5, y: 3 },
              { x: 4, y: 3 },
              { x: 3, y: 3 },
            ],
            dir: "RIGHT",
            alive: true,
            colorId: 1,
          },
          {
            clientId: "peer",
            body: [
              { x: 5, y: 5 },
              { x: 4, y: 5 },
              { x: 3, y: 5 },
            ],
            dir: "RIGHT",
            alive: true,
            colorId: 2,
          },
        ],
      },
      "me"
    );
    assert.equal(r.ok, true);
    assert.equal(r.remotes, true);
    assert.equal(r.local, true);
    assert.ok(win.__mpCoopRemotes.peer);
    assert.equal(win.__mpCoopRemotes.peer.body[0].y, 5);
    assert.equal(win.__mpGame.oa.ka[0].y, 3, "local seated at server oy");
    assert.equal(win.__mpCoopRemotes.me, undefined, "local not in remotes");
  });

  it("applyRemotesFromState works with no GameInstance", () => {
    win.__mpGame = null;
    win.__remixGame = null;
    const ok = win.CoopBinder.applyRemotesFromState(
      {
        snakes: [
          { clientId: "a", body: [{ x: 1, y: 1 }], dir: "RIGHT", alive: true },
          { clientId: "b", body: [{ x: 2, y: 2 }], dir: "LEFT", alive: true },
        ],
      },
      "a"
    );
    assert.equal(ok, true);
    assert.ok(win.__mpCoopRemotes.b);
    assert.equal(win.__mpCoopRemotes.a, undefined);
  });
});
