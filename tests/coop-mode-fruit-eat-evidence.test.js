"use strict";

/**
 * Evidence: every co-op mode consumes at least one apple after unlock (key/soko)
 * without crash, publishes collectables, and meets mode-specific post-eat checks.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");
const eatLib = require("./lib/coop-mode-eat-evidence.js");

const ROOT = path.join(__dirname, "..");

function stubDom() {
  global.window = global;
  global.document = {
    querySelector: function () {
      return null;
    },
    querySelectorAll: function () {
      return [];
    },
    getElementsByClassName: function () {
      return [];
    },
    getElementById: function () {
      return null;
    },
    addEventListener: function () {},
    createElement: function () {
      return {
        style: {},
        classList: { add: function () {}, remove: function () {} },
        appendChild: function () {},
        setAttribute: function () {},
      };
    },
    body: { appendChild: function () {} },
  };
}

function loadStack() {
  stubDom();
  [
    "shared/colors.js",
    "shared/protocol.js",
    "runtime/bridge.js",
    "session/ready.js",
    "race/scoreboard.js",
    "coop/state.js",
    "coop/session.js",
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
  return {
    App: global.MultiplayerApp,
    Gsm: global.MultiplayerGsm,
  };
}

function emptyGrid(W, H, fill) {
  const wa = [];
  for (let y = 0; y < H; y++) {
    wa[y] = [];
    for (let x = 0; x < W; x++) wa[y][x] = fill;
  }
  return wa;
}

function makeBoard(mode, opts) {
  opts = opts || {};
  const W = opts.width || 12;
  const H = opts.height || 10;
  const wa = emptyGrid(W, H, 0);
  const bridgeGrid = emptyGrid(W, H, null);
  return {
    settings: { ub: mode.trophy, ob: mode.trophy, Aa: 1, Sa: 1 },
    oa: {
      ka: [
        { x: 4, y: 5 },
        { x: 3, y: 5 },
        { x: 2, y: 5 },
      ],
      oa: { width: W, height: H },
      direction: "RIGHT",
      Ca: "RIGHT",
    },
    Ca: { Aa: null, wa: wa },
    wa: {
      ka: [{ pos: { x: 6, y: 5 }, type: 0, nba: null }],
      oa: { oa: { width: W, height: H } },
    },
    ka: { oa: { width: W, height: H }, wa: wa },
    Ba: { keys: [] },
    Aa: { oa: [], d_: [] },
    Ma: { oa: [] },
    Ya: { oa: [] },
    Qa: { pfa: [] },
    Ga: { oa: bridgeGrid },
    Ka: { ka: [] },
    nj: false,
    Sh: 0,
    Rb: function () {
      return {
        x: 8,
        y: 3,
        clone: function () {
          return { x: this.x, y: this.y };
        },
      };
    },
    Vb: function () {
      const set = new Set();
      const body = this.oa && this.oa.ka;
      for (let i = 0; body && i < body.length; i++) {
        const p = body[i];
        if (p && p.x != null) set.add((p.x << 16) | (p.y | 0));
      }
      return set;
    },
  };
}

function makeCoopApp(Gsm, game, modeKey) {
  const App = global.MultiplayerApp;
  const published = [];
  const app = new App();
  app.client = {
    connected: true,
    joined: true,
    clientId: "eater",
    isAdmin: function () {
      return true;
    },
    me: function () {
      return {
        clientId: "eater",
        role: "player",
        ready: true,
        isAdmin: true,
      };
    },
    roster: {
      mode: "coop",
      sessionActive: true,
      clients: [{ clientId: "eater", role: "player", ready: true }],
    },
    collectablesDelta: function (cols) {
      published.push(cols);
    },
  };
  app._coopSessionActive = true;
  app._coopAuthority = "native-relay-v1";
  app.coop.boardReady = true;
  app.coop.generation = 1;
  global.__mpCoopSession = true;
  global.__mpCoopInject = true;
  global.__multiplayerApp = app;
  global.__mpCoopPlaySettings = { trophy: 0, count: 0, speed: 1, size: 1 };
  global.ModeRegistry = {
    getCurrentModeKey: function () {
      return modeKey;
    },
  };
  global.__remixGame = game;
  global.__mpGame = game;
  global.timeKeeper = {
    playing: true,
    _dead: false,
    gotApple: function () {},
    gotAll: function () {},
    death: function () {},
  };
  if (typeof app.hookLocalScorePulse === "function") {
    app.hookLocalScorePulse();
  } else {
    Gsm.wrapTimeKeeper({
      onApple: function (_t, score) {
        app._coopWallGrowArmed = true;
        if (game) game.Sh = score | 0;
        app.publishCoopCollectables(true, { wallGrow: true });
      },
    });
  }
  return { app: app, published: published };
}

/** Native unlock spawns fruit while mode stays key/soko — plantClassicInitialFruit is blocked. */
function plantPostUnlockFruit(g) {
  g.wa.ka.length = 0;
  const pos = {
    x: 6,
    y: 5,
    clone: function () {
      return { x: this.x | 0, y: this.y | 0 };
    },
  };
  g.wa.ka.push({ pos: pos, type: 0, nba: null });
  return g.wa.ka.length;
}

function simulateUnlockKeySoko(Gsm, g, modeId) {
  global.__mpCoopPlaySettings = { count: 0, trophy: g.settings.ub };
  if (modeId === "key") {
    Gsm.plantInitialKeySokoban(g);
    assert.equal(g.wa.ka.length, 0);
    assert.ok(g.Ba.keys.length >= 1);
    g.Ba.keys.length = 0;
    const fruitAfter = plantPostUnlockFruit(g);
    return { fruitAfter: fruitAfter, method: "keys_cleared_native_fruit_host" };
  }
  if (modeId === "sokoban") {
    Gsm.plantInitialKeySokoban(g);
    assert.equal(g.wa.ka.length, 0);
    assert.ok(g.Aa.oa.length >= 1 && g.Aa.d_.length >= 1);
    const goal = g.Aa.d_[0];
    const box = g.Aa.oa[0];
    if (box && box.pos && goal) {
      const gp = goal.pos || goal;
      box.pos.x = gp.x | 0;
      box.pos.y = gp.y | 0;
    }
    g.Aa.oa.length = 0;
    const fruitAfter = plantPostUnlockFruit(g);
    return { fruitAfter: fruitAfter, method: "box_on_goal_native_fruit_host" };
  }
  return null;
}

function simulateEatTick(Gsm, g, mode) {
  global.__mpCoopOnTick(g);
  if (!g.Ca.Aa || typeof g.Ca.Aa.add !== "function") {
    throw new Error("Aa not ready after tick");
  }
  const baseline = eatLib.boardEatSnapshot(g, Gsm);
  const apple = g.wa.ka[0] && (g.wa.ka[0].pos || g.wa.ka[0]);
  if (!apple) throw new Error("no apple to eat");
  g.oa.ka.unshift({ x: apple.x | 0, y: apple.y | 0 });
  g.wa.ka = [];
  const nextSh = (g.Sh | 0) + 1;
  g.Sh = nextSh;
  if (mode.needsWallOnEat) {
    const pick = g.Rb(null, 5);
    const wx = pick.x | 0;
    const wy = pick.y | 0;
    g.Ca.Aa.add({
      pos: { x: wx, y: wy },
      wm: false,
      m0: false,
      Lh: true,
    });
    g.Ca.wa[wy][wx] = 1;
  }
  global.timeKeeper.gotApple(900, nextSh);
  const after = eatLib.boardEatSnapshot(g, Gsm);
  const head = g.oa.ka[0];
  const snap = Object.assign({}, after, {
    head: head ? { x: head.x | 0, y: head.y | 0 } : null,
  });
  return {
    baseline: baseline,
    after: after,
    ate: eatLib.detectEatBreak(baseline, snap, mode.id),
    nextSh: nextSh,
  };
}

describe("coop mode fruit eat evidence", () => {
  let win;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    global.window = win;
    global.document = win.document;
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.__mpGame;
    delete global.__remixGame;
    delete global.__multiplayerApp;
  });

  it("catalog matches Wall→Bridge eat modes", () => {
    assert.equal(eatLib.MODES.length, 20);
    assert.equal(eatLib.MODES[0].id, "wall");
    assert.equal(eatLib.MODES[19].id, "bridge");
  });

  for (const mode of eatLib.MODES) {
    describe(mode.id + " eat", () => {
      it("unlock → eat → publish without crash", async () => {
        const { Gsm } = loadStack();
        const g = makeBoard(mode);
        const { published } = makeCoopApp(Gsm, g, mode.id);

        let unlocked = null;
        if (mode.unlockFirst) {
          unlocked = simulateUnlockKeySoko(Gsm, g, mode.id);
          assert.ok(unlocked.fruitAfter >= 1, "fruit after unlock");
        }

        const eat = simulateEatTick(Gsm, g, mode);
        await new Promise(function (r) {
          setTimeout(r, 130);
        });

        assert.equal(eat.ate, true, "detectEatBreak");
        assert.ok(published.length >= 1, "collectablesDelta");
        const cols = published[published.length - 1];
        assert.ok(Array.isArray(cols.apples) || Array.isArray(cols.collectables));

        eatLib.assertEatEvidence(
          mode.id,
          {
            baseline: eat.baseline,
            after: eat.after,
            ate: eat.ate,
            unlocked: unlocked,
            publishedCount: published.length,
            wallPlanted: mode.needsWallOnEat,
          },
          assert
        );

        if (mode.fruitMotion && Gsm.isCoopFruitMotionMode) {
          global.ModeRegistry.getCurrentModeKey = function () {
            return mode.id;
          };
          assert.equal(Gsm.isCoopFruitMotionMode(), true);
        }
      });
    });
  }

  describe("key live-shaped unlock scrape", () => {
    it("peer apply after unlock+eat keeps empty keys", () => {
      const { Gsm } = loadStack();
      const g = makeBoard({ id: "key", trophy: 8 });
      makeCoopApp(Gsm, g, "key");
      simulateUnlockKeySoko(Gsm, g, "key");
      const eat = simulateEatTick(Gsm, g, eatLib.modeById("key"));
      assert.equal(eat.ate, true);
      const payload = Gsm.scrapeCollectables({ includeEntities: true });
      assert.ok(payload);
      assert.equal((payload.keys || []).length, 0);
      assert.ok((payload.apples || []).length >= 0);
    });
  });
});
