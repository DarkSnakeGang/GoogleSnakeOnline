"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const root = path.join(__dirname, "..");
const Colors = require(path.join(root, "src/shared/colors.js"));
const Protocol = require(path.join(root, "src/shared/protocol.js"));
const Session = require(path.join(root, "src/session/ready.js"));
const VersusState = require(path.join(root, "src/versus/scoreboard.js"));
const { CoopTimeKeeper } = require(path.join(root, "src/coop/state.js"));

describe("colors palette", () => {
  it("includes solids, rainbows, and random", () => {
    assert.equal(Colors.colorName(0), "Blue");
    assert.equal(Colors.colorName(10), "Default Rainbow");
    assert.equal(Colors.colorName(35), "Pride");
    assert.equal(Colors.colorName(45), "Catalonia");
    assert.equal(Colors.colorName(46), "Random");
    assert.ok(Colors.isClaimable(10));
    assert.ok(!Colors.isClaimable(46));
    assert.equal(Colors.CLAIMABLE_IDS.length, 46); // 0-45 except we have 47 entries minus random = 46 claimable? 
    // solids 34 (0-9,11-34) + rainbows 12 = 46
    assert.equal(Colors.CLAIMABLE_IDS.length, 46);
  });

  it("disambiguates versus color names", () => {
    const roster = [
      { clientId: "a", colorId: 0, joinOrder: 1 },
      { clientId: "b", colorId: 0, joinOrder: 2 },
    ];
    assert.equal(Colors.displayNameFor(roster[0], roster), "Blue");
    assert.equal(Colors.displayNameFor(roster[1], roster), "Blue 2");
  });
});

describe("protocol", () => {
  it("parses and rejects bad version", () => {
    Protocol.resetSeq();
    const env = Protocol.envelope("HELLO", { roomCode: "X" });
    assert.equal(env.v, 1);
    const ok = Protocol.parseMessage(JSON.stringify(env));
    assert.ok(ok.ok);
    const bad = Protocol.parseMessage(JSON.stringify({ v: 9, type: "HELLO" }));
    assert.equal(bad.ok, false);
  });
});

describe("ready gate", () => {
  it("requires all players ready", () => {
    assert.equal(
      Session.canStart({
        clients: [
          { role: "player", ready: true },
          { role: "player", ready: false },
        ],
      }),
      false
    );
    assert.equal(
      Session.canStart({
        clients: [
          { role: "player", ready: true },
          { role: "spectator", ready: false },
        ],
      }),
      true
    );
    assert.equal(Session.canStart({ clients: [], attemptExpired: false }), false);
  });

  it("coop spawn offsets depend on player count", () => {
    assert.deepEqual(Session.coopSpawnOffsets(1), [0]);
    assert.deepEqual(Session.coopSpawnOffsets(2), [-1, 1]);
    assert.deepEqual(Session.coopSpawnOffsets(3), [0, 3, -2]);
    assert.deepEqual(Session.coopSpawnOffsets(4), [-1, 1, -4, 4]);
  });
});

describe("versus PLAY_SYNC start gate", () => {
  it("SESSION_START mode + sessionActive lets non-admin player start without mode===versus", () => {
    // Mirrors mod PLAY_SYNC: coop uses coop path; otherwise any player starts.
    function shouldStartLocalPlay(me, roster) {
      if (!me) return null;
      const isCoop = roster.mode === "coop";
      if (me.role === "player") {
        if (!me.ready && !roster.sessionActive) return null;
      } else if (!(isCoop && me.role === "spectator")) {
        return null;
      }
      if (isCoop) return { coop: true, spectator: me.role === "spectator" };
      if (me.role === "player") return { coop: false };
      return null;
    }
    const me = { role: "player", ready: true };
    // Mode not yet "versus" on roster (stale) but SESSION_START flipped session
    assert.deepEqual(
      shouldStartLocalPlay(me, { mode: "", sessionActive: true }),
      { coop: false }
    );
    assert.deepEqual(
      shouldStartLocalPlay(me, { mode: "versus", sessionActive: true }),
      { coop: false }
    );
    assert.equal(
      shouldStartLocalPlay(
        { role: "player", ready: false },
        { mode: "versus", sessionActive: false }
      ),
      null
    );
  });
});

describe("coop timekeeper isolation", () => {
  it("uses separate key from remix", () => {
    assert.notEqual(CoopTimeKeeper.KEY, CoopTimeKeeper.REMIX_KEY);
    assert.equal(CoopTimeKeeper.KEY, "snake_timeKeeper_coop");
  });
});

describe("versus session timekeeper", () => {
  function mockLocalStorage() {
    const store = {};
    return {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      setItem: function (k, v) {
        store[k] = String(v);
      },
      removeItem: function (k) {
        delete store[k];
      },
      _store: store,
    };
  }

  it("SpeedInfo getStorage uses session key while versus match is active", () => {
    const ls = mockLocalStorage();
    global.localStorage = ls;
    // Lifetime remix PB — must NOT appear in session SpeedInfo
    ls.setItem(
      "snake_timeKeeper_remix",
      JSON.stringify({
        version: 4,
        "25-classic-0-0-0": { time: 1000, date: "old", att: 9, sum: 9000 },
      })
    );
    const tk = {
      _storageCache: null,
      _storageDirty: false,
      getStorage: function () {
        if (!this._storageCache) {
          this._storageCache = JSON.parse(
            ls.getItem("snake_timeKeeper_remix") || '{"version":4}'
          );
        }
        return this._storageCache;
      },
      setStorage: function (storage) {
        this._storageCache = storage;
        ls.setItem("snake_timeKeeper_remix", JSON.stringify(storage));
        this._storageDirty = false;
      },
      flushStorage: function () {
        if (!this._storageDirty || !this._storageCache) return;
        ls.setItem("snake_timeKeeper_remix", JSON.stringify(this._storageCache));
        this._storageDirty = false;
      },
    };
    global.window = global;
    global.timeKeeper = tk;
    // Reload scoreboard against this window/localStorage
    const sbPath = require.resolve(path.join(root, "src/versus/scoreboard.js"));
    delete require.cache[sbPath];
    require(sbPath);
    const VTK = global.VersusTimeKeeper;
    assert.ok(VTK);
    assert.equal(VTK.KEY, "snake_timeKeeper_versus_session");
    VTK.install();
    VTK.beginMatch();
    assert.equal(VTK.isActive(), true);
    const sessionStore = tk.getStorage();
    assert.equal(sessionStore["25-classic-0-0-0"], undefined);
    // Write a session PB the way TimeKeeper does
    sessionStore["25-classic-0-0-0"] = { time: 5000, date: "now", att: 1, sum: 5000 };
    tk.setStorage(sessionStore);
    assert.equal(
      JSON.parse(ls.getItem("snake_timeKeeper_versus_session"))["25-classic-0-0-0"].time,
      5000
    );
    // Remix lifetime untouched
    assert.equal(
      JSON.parse(ls.getItem("snake_timeKeeper_remix"))["25-classic-0-0-0"].time,
      1000
    );
    // Promote only if better (5000 is worse than 1000 for timed — no change)
    assert.equal(VTK.promoteSessionToRemix(), false);
    // Better session time promotes
    sessionStore["25-classic-0-0-0"] = { time: 800, date: "now", att: 1, sum: 800 };
    tk.setStorage(sessionStore);
    assert.equal(VTK.promoteSessionToRemix(), true);
    assert.equal(
      JSON.parse(ls.getItem("snake_timeKeeper_remix"))["25-classic-0-0-0"].time,
      800
    );
    VTK.endMode();
    assert.equal(VTK.isActive(), false);
    assert.equal(tk.getStorage()["25-classic-0-0-0"].time, 800);
  });
});

describe("versus expired sync", () => {
  it("marks expired from roster allowNewRuns", () => {
    const v = new VersusState();
    assert.equal(v.expired, false);
    v.syncFromRoster({ allowNewRuns: false });
    assert.equal(v.expired, true);
    v.syncFromRoster({ allowNewRuns: true, sessionActive: true });
    assert.equal(v.expired, false);
  });

  it("keeps last-match scores until resetForNewMatch", () => {
    const v = new VersusState();
    v.onScorePulse({
      clientId: "p1",
      score: 12,
      bestScore: 12,
      timeMs: 1000,
      alive: false,
    });
    v.onExpired({ winnerClientId: "p1" });
    assert.equal(v.scores.p1.bestScore, 12);
    assert.equal(v.winnerClientId, "p1");
    // End match / lobby roster — results stay
    v.syncFromRoster({
      sessionActive: false,
      attemptExpired: true,
      allowNewRuns: true,
      leaderClientId: "p1",
    });
    assert.equal(v.expired, true);
    assert.equal(v.scores.p1.bestScore, 12);
    assert.equal(v.winnerClientId, "p1");
    v.resetForNewMatch();
    assert.equal(Object.keys(v.scores).length, 0);
    assert.equal(v.winnerClientId, null);
    assert.equal(v.expired, false);
  });

  it("stores board under clientId", () => {
    const v = new VersusState();
    v.onBoardDelta({ clientId: "p1", board: { score: 2 } });
    v.setFocus("p1");
    assert.equal(v.focusBoard().score, 2);
  });

  it("formats attempt clock as MM:SS", () => {
    assert.equal(VersusState.formatAttemptClock(125000, false), "02:05");
    assert.equal(VersusState.formatAttemptClock(500, false), "00:01");
    assert.equal(VersusState.formatAttemptClock(0, false), "00:00");
    assert.equal(VersusState.formatAttemptClock(null, false), null);
    assert.equal(VersusState.formatAttemptClock(9999, true), "00:00");
  });

  it("clears attemptRemainingMs when session is inactive", () => {
    const v = new VersusState();
    v.attemptRemainingMs = 60000;
    v.syncFromRoster({ mode: "versus", sessionActive: false, allowNewRuns: true });
    assert.equal(v.attemptRemainingMs, null);
  });

  it("onAttemptTick coerces remainingMs to number", () => {
    const v = new VersusState();
    v.onAttemptTick({ remainingMs: "1800000" });
    assert.equal(v.attemptRemainingMs, 1800000);
  });
});

describe("versus goal leader", () => {
  it("Score goal picks highest bestScore", () => {
    const scores = {
      a: { bestScore: 10, score: 10, bestTimeMs: 1000 },
      b: { bestScore: 22, score: 22, bestTimeMs: 500 },
      c: { bestScore: 22, score: 5, bestTimeMs: 900 },
    };
    // tie on 22 → longer bestTimeMs wins
    assert.equal(VersusState.pickLeader(scores, "score"), "c");
  });

  it("Best 25 picks fastest goal completion", () => {
    const scores = {
      a: { bestScore: 40, goalCompleted: true, bestGoalTimeMs: 8000 },
      b: { bestScore: 30, goalCompleted: true, bestGoalTimeMs: 5000 },
      c: { bestScore: 50, goalCompleted: false, bestGoalTimeMs: null },
    };
    assert.equal(VersusState.pickLeader(scores, "best25"), "b");
    assert.equal(VersusState.goalLabel("bestAll"), "Best All");
    assert.equal(VersusState.formatGoalBest(scores.b, "best25"), "5.00s");
  });

  it("onExpired sets winnerClientId", () => {
    const vs = new VersusState();
    vs.versusGoal = "score";
    vs.scores = {
      a: { bestScore: 3, score: 3 },
      b: { bestScore: 9, score: 9 },
    };
    vs.onExpired({ winnerClientId: "b", versusGoal: "score" });
    assert.equal(vs.expired, true);
    assert.equal(vs.winnerClientId, "b");
    assert.equal(vs.leaderClientId, "b");
  });
});

describe("versus PLAY_SYNC race", () => {
  it("allowNewRuns can be stale false until ROSTER after SESSION_START", () => {
    // Documents why PLAY_SYNC must not gate on allowNewRuns():
    // server emits SESSION_START → PLAY_SYNC → ROSTER; clients still hold
    // allowNewRuns:false from a prior expired attempt when PLAY_SYNC arrives.
    const Client = require(path.join(root, "src/net/client.js"));
    const c = new Client({ url: "ws://127.0.0.1:9/ws" });
    c.roster = {
      mode: "versus",
      allowNewRuns: false,
      attemptExpired: true,
      sessionActive: false,
    };
    assert.equal(c.allowNewRuns(), false);
    // SESSION_START handler clears these before PLAY_SYNC runs
    c.roster.sessionActive = true;
    c.roster.allowNewRuns = true;
    c.roster.attemptExpired = false;
    assert.equal(c.allowNewRuns(), true);
  });
});

describe("gsm lock helpers", () => {
  it("exposes menu lock and pause helpers", () => {
    const Gsm = require(path.join(root, "src/hooks/gsm.js"));
    assert.equal(typeof Gsm.setNativeMenusLocked, "function");
    assert.equal(typeof Gsm.setLocalPaused, "function");
    assert.equal(typeof Gsm.drawCoopSnapshot, "function");
  });
});

describe("coop native inject bridge", () => {
  it("mirrors remotes onto __mpCoopRemotes and detects hits", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.myClientId = "me";
    cn.applySnakeDelta({
      clientId: "other",
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
        { x: 3, y: 5 },
      ],
      alive: false,
    });
    assert.ok(global.__mpCoopRemotes.other);
    assert.equal(global.__mpCoopSession, true);
    assert.equal(cn.hitsRemote({ x: 5, y: 5 }, "me"), true);
    assert.equal(cn.hitsRemote({ x: 3, y: 5 }, "me"), false);
    assert.equal(typeof global.__mpCoopOnTick, "function");
    assert.equal(typeof global.__mpCoopRenderEnter, "function");
    assert.equal(typeof global.__mpCoopAfterSnakeRender, "function");
    assert.equal(typeof global.__mpCoopPaintCompanions, "function");
    assert.deepEqual(cn.occupancyKeys(false)["5,5"], true);

    // Spectator tick empties local body
    global.__mpCoopInject = true;
    global.__mpCoopSpectator = true;
    const game = { oa: { ka: [{ x: 1, y: 1 }] }, Tb: function () {} };
    global.__mpCoopOnTick(game);
    assert.equal(game.oa.ka.length, 0);
    global.__mpCoopSpectator = false;
  });

  it("paints companions once from tick using cached renderer (not per-frame wrap)", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));
    require(path.join(root, "src/shared/colors.js"));

    const calls = [];
    const game = {
      oa: {
        ka: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        Sc: "#4E7CF6",
        Yc: "#17439F",
        color1: "#17439F",
        color2: "#4E7CF6",
      },
      Tb: function () {},
    };
    const renderer = {
      wb: game,
      render: function (a, b, c) {
        calls.push({
          a: a,
          body0: game.oa.ka[0] && game.oa.ka[0].x,
          Sc: game.oa.Sc,
        });
      },
    };

    global.__mpCoopInject = true;
    global.__mpCoopSession = true;
    global.__mpCoopMyId = "me";
    global.__mpCoopLocalDead = false;
    global.__mpCoopSpectator = false;
    global.__mpCoopRemotes = {
      other: {
        clientId: "other",
        body: [
          { x: 8, y: 7 },
          { x: 7, y: 7 },
          { x: 6, y: 7 },
        ],
        colorId: 4, // Red
        Sc: "#F53D40",
        Yc: "#D00B0E",
      },
    };

    // Capture renderer only — must not paint companions on enter
    global.__mpCoopRenderEnter(renderer, 0.5, true, {});
    assert.equal(calls.length, 0, "render enter must not paint companions");
    assert.equal(global.__mpCoopPlayerRenderer, renderer);

    // Calling local render alone must not wrap into N companion frames
    renderer.render(0.5, true, {});
    assert.equal(calls.length, 1, "plain render is local-only");

    // Tick drives one companion pass
    global.__mpCoopOnTick(game);
    assert.ok(calls.length >= 2, "tick should paint companions once");
    const companion = calls.find(function (c) {
      return c.body0 === 8 && c.Sc === "#F53D40";
    });
    assert.ok(companion, "companion should draw at seeded body with Red Sc");
    assert.equal(game.oa.Sc, "#4E7CF6");
    assert.equal(game.oa.ka[0].x, 1);
  });

  it("keeps corpse body when a dead delta arrives empty", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.applySnakeDelta({
      clientId: "p2",
      body: [
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
      alive: true,
    });
    cn.applySnakeDelta({
      clientId: "p2",
      body: [],
      alive: false,
    });
    assert.equal(cn.remotes.p2.alive, false);
    assert.equal(cn.remotes.p2.body.length, 2);
    assert.equal(cn.remotes.p2.body[0].x, 3);
  });

  it("keeps seeded colors when a later delta omits them", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.applySnakeDelta({
      clientId: "p2",
      body: [{ x: 1, y: 1 }],
      colorId: 7,
      Sc: "#35B63E",
      Yc: "#298E30",
      _seeded: true,
    });
    cn.applySnakeDelta({
      clientId: "p2",
      body: [
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
      alive: true,
    });
    assert.equal(cn.remotes.p2.Sc, "#35B63E");
    assert.equal(cn.remotes.p2.colorId, 7);
    assert.equal(cn.remotes.p2.body[0].x, 2);
    assert.equal(cn.remotes.p2._fromDelta, true);
  });

  it("blocks spawns on live and dead snakes and updates as bodies move", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.syncBridge();
    global.__multiplayerApp = { coopNative: cn };

    cn.applySnakeDelta({
      clientId: "live",
      alive: true,
      body: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
    });
    cn.applySnakeDelta({
      clientId: "dead",
      alive: false,
      body: [
        { x: 9, y: 9 },
        { x: 8, y: 9 },
      ],
    });
    assert.equal(cn.isOccupied(2, 2), true);
    assert.equal(cn.isOccupied(9, 9), true);
    assert.equal(cn.isOccupied(0, 0), false);

    // Move live snake — old cell frees, new cell blocks
    cn.applySnakeDelta({
      clientId: "live",
      alive: true,
      body: [
        { x: 3, y: 2 },
        { x: 2, y: 2 },
      ],
    });
    assert.equal(cn.isOccupied(1, 2), false);
    assert.equal(cn.isOccupied(3, 2), true);

    let n = 0;
    const game = {
      oa: { ka: [{ x: 0, y: 0 }], oa: { width: 17, height: 15 } },
      Tb: function () {
        n++;
        // First few picks land on live head, then free
        if (n < 3) return { x: 3, y: 2 };
        return { x: 5, y: 5 };
      },
    };
    global.__mpCoopInject = true;
    global.__mpCoopSession = true;
    global.__mpCoopOnTick(game);
    const pos = game.Tb();
    assert.deepEqual(pos, { x: 5, y: 5 });

    // Remix chess_occupied_keys merges co-op cells
    global.chess_occupied_keys = function () {
      return new Set(["0,0"]);
    };
    global.__mpCoopInstallSpawnOcc();
    const keys = global.chess_occupied_keys();
    assert.equal(keys.has("3,2"), true);
    assert.equal(keys.has("9,9"), true);
    assert.equal(keys.has("0,0"), true);

    delete global.__multiplayerApp;
    delete global.__mpCoopSession;
    delete global.__mpCoopInject;
    delete global.__mpCoopSpectator;
    delete global.__mpCoopLocalDead;
    delete global.__mpCoopRemotes;
    delete global.chess_occupied_keys;
  });
});

describe("versus instant death reset", () => {
  function loadApp() {
    global.window = global;
    global.__mpCoopSession = false;
    global.__mpCoopSpectator = false;
    global.__mpCoopInject = false;
    global.__mpVersusFocusSpectate = false;
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
      addEventListener: function () {},
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
      const p = require.resolve(path.join(root, "src", rel));
      delete require.cache[p];
      require(p);
    });
    return (
      global.MultiplayerApp ||
      require(path.join(root, "src/mod.js")).MultiplayerApp
    );
  }

  it("canAutoRestartVersus gates on session + allowNewRuns + player", () => {
    const MultiplayerApp = loadApp();
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      me: function () {
        return { role: "player" };
      },
      roster: {
        mode: "versus",
        sessionActive: true,
        allowNewRuns: true,
      },
    };
    app.versus.expired = false;
    assert.equal(app.canAutoRestartVersus(), true);

    app.client.roster.allowNewRuns = false;
    assert.equal(app.canAutoRestartVersus(), false);

    app.client.roster.allowNewRuns = true;
    app.versus.expired = true;
    assert.equal(app.canAutoRestartVersus(), false);

    app.versus.expired = false;
    app.client.roster.mode = "coop";
    assert.equal(app.canAutoRestartVersus(), false);

    app.client.roster.mode = "versus";
    app.client.me = function () {
      return { role: "spectator" };
    };
    assert.equal(app.canAutoRestartVersus(), false);
  });

  it("restartVersusAfterDeath calls startNativeRun", async () => {
    const MultiplayerApp = loadApp();
    const Gsm = global.MultiplayerGsm;
    let started = 0;
    const prev = Gsm.startNativeRun;
    Gsm.startNativeRun = function () {
      started++;
    };
    try {
      const app = new MultiplayerApp();
      app.client = {
        connected: true,
        me: function () {
          return { role: "player" };
        },
        roster: {
          mode: "versus",
          sessionActive: true,
          allowNewRuns: true,
        },
      };
      assert.equal(app.restartVersusAfterDeath(), true);
      assert.equal(app.restartVersusAfterDeath(), false); // debounced
      await new Promise(function (r) {
        setTimeout(r, 20);
      });
      assert.equal(started, 1);
    } finally {
      Gsm.startNativeRun = prev;
    }
  });
});
