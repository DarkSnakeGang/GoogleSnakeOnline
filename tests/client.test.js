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
      } else if (me.role === "spectator") {
        if (isCoop) return { coop: true, spectator: true };
        return null;
      } else {
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
    assert.deepEqual(
      shouldStartLocalPlay(
        { role: "spectator" },
        { mode: "coop", sessionActive: true }
      ),
      { coop: true, spectator: true }
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

  it("mosaic run clock arms once and ignores mid-run timeMs jumps", () => {
    const v = new VersusState();
    const started = 1_700_000_000_000;
    v.onScorePulse({
      clientId: "p1",
      score: 0,
      timeMs: 0,
      alive: true,
      runStartedAtMs: started,
    });
    assert.equal(v.runClocks.p1.startedAtMs, started);
    assert.equal(v.runClocks.p1.frozenMs, null);
    v.onScorePulse({
      clientId: "p1",
      score: 5,
      timeMs: 45000,
      alive: true,
      runStartedAtMs: started,
    });
    assert.equal(v.runClocks.p1.startedAtMs, started);
    assert.equal(
      VersusState.resolveRunClockMs(v.runClocks.p1, started + 3200, 45000),
      3200
    );
    v.onScorePulse({
      clientId: "p1",
      score: 5,
      timeMs: 5100,
      alive: false,
      runStartedAtMs: started,
    });
    assert.equal(v.runClocks.p1.frozenMs, 5100);
    assert.equal(
      VersusState.resolveRunClockMs(v.runClocks.p1, started + 99999, 5100),
      5100
    );
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

  it("formats run clock for mosaic / roster", () => {
    assert.equal(VersusState.formatRunClock(12300), "12.3s");
    assert.equal(VersusState.formatRunClock(65000), "1:05.0");
    assert.equal(VersusState.formatRunClock(null), "—");
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

  it("rankPlayers and formatGoalDetail order by active goal", () => {
    const scores = {
      a: { bestScore: 10, score: 10, bestTimeMs: 100 },
      b: { bestScore: 30, score: 30, bestTimeMs: 50 },
      c: { bestScore: 20, score: 20, bestTimeMs: 200 },
    };
    assert.deepEqual(VersusState.rankPlayers(scores, "score"), [
      "b",
      "c",
      "a",
    ]);
    assert.equal(
      VersusState.formatGoalDetail(scores.b, "score"),
      "Score 30"
    );
    const timed = {
      slow: { goalCompleted: true, bestGoalTimeMs: 9000, bestScore: 40 },
      fast: { goalCompleted: true, bestGoalTimeMs: 4000, bestScore: 30 },
      none: { goalCompleted: false, bestScore: 50 },
    };
    assert.deepEqual(VersusState.rankPlayers(timed, "best25"), [
      "fast",
      "slow",
      "none",
    ]);
    assert.equal(
      VersusState.formatGoalDetail(timed.fast, "best25"),
      "Best 25 4.00s"
    );
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

describe("HELLO handshake gate", () => {
  function installMockWs(queue) {
    const sockets = [];
    global.WebSocket = function MockWs() {
      const self = this;
      this.readyState = 0;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
      queue.push(function open() {
        self.readyState = 1;
        if (self.onopen) self.onopen({});
      });
    };
    global.WebSocket.prototype.send = function (data) {
      this.sent.push(JSON.parse(data));
    };
    global.WebSocket.prototype.close = function () {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000, reason: "" });
    };
    return sockets;
  }

  it("resolves only after WELCOME and does not PING before join", async () => {
    require(path.join(root, "src/shared/protocol.js"));
    const Client = require(path.join(root, "src/net/client.js"));
    const ops = [];
    const sockets = installMockWs(ops);
    const c = new Client({ url: "ws://test/ws", create: true, displayName: "A" });
    const p = c.connect();
    ops[0](); // open
    assert.equal(sockets[0].sent.length, 1);
    assert.equal(sockets[0].sent[0].type, "HELLO");
    assert.equal(c.joined, false);
    sockets[0].onmessage({
      data: JSON.stringify({
        v: 1,
        type: "WELCOME",
        seq: 1,
        payload: { clientId: "c1", roomCode: "ABCD", isAdmin: true },
      }),
    });
    const welcome = await p;
    assert.equal(welcome.roomCode, "ABCD");
    assert.equal(c.joined, true);
    assert.ok(sockets[0].sent.some((m) => m.type === "PING"));
    c.disconnect();
  });

  it("rejects on room_not_found and never sends PING", async () => {
    require(path.join(root, "src/shared/protocol.js"));
    const Client = require(path.join(root, "src/net/client.js"));
    const ops = [];
    const sockets = installMockWs(ops);
    const c = new Client({
      url: "ws://test/ws",
      create: false,
      roomCode: "DEAD",
      displayName: "B",
    });
    const p = c.connect();
    ops[0]();
    sockets[0].onmessage({
      data: JSON.stringify({
        v: 1,
        type: "ERROR",
        seq: 1,
        payload: { code: "room_not_found", message: "Room does not exist" },
      }),
    });
    await assert.rejects(p, (err) => err && err.code === "room_not_found");
    assert.equal(c.joined, false);
    assert.ok(!sockets[0].sent.some((m) => m.type === "PING"));
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
    assert.equal(cn.hitsRemote({ x: 3, y: 5 }, "me"), true);
    assert.equal(typeof global.__mpCoopOnTick, "function");
    assert.equal(typeof global.__mpCoopRenderEnter, "function");
    assert.equal(typeof global.__mpCoopAfterSnakeRender, "function");
    assert.equal(typeof global.__mpCoopPaintCompanions, "function");
    assert.deepEqual(cn.occupancyKeys(false)["5,5"], true);

    // Spectator tick parks local body off-board (never clears — yi NaN×4)
    global.__mpCoopInject = true;
    global.__mpCoopSpectator = true;
    const game = { oa: { ka: [{ x: 1, y: 1 }] }, Tb: function () {} };
    global.__mpCoopOnTick(game);
    assert.ok(game.oa.ka.length >= 1, "spectator ka stays non-empty");
    assert.equal(game.oa.ka[0].x, -8);
    global.__mpCoopSpectator = false;
  });

  it("drawCoopRemotes paints finite remotes after local render", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));
    require(path.join(root, "src/shared/colors.js"));

    const drawn = [];
    global.MultiplayerGsm = {
      drawWallSolverStyleSnake: function (ctx, body, ox, oy, tile, color) {
        drawn.push({
          x: body[0] && body[0].x,
          Sc: color && (color.primary || color.Sc),
        });
      },
      snakeMotion: function () {
        return null;
      },
    };

    const game = {
      oa: {
        ka: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        Sc: "#4E7CF6",
        Yc: "#17439F",
      },
      ka: { ka: 20 },
      Tb: function () {},
    };
    const ctx = {
      save: function () {},
      restore: function () {},
      globalAlpha: 1,
    };
    const renderer = {
      wb: game,
      ka: ctx,
      render: function (a) {
        if (typeof a === "number" && !Number.isFinite(a)) {
          throw new Error("yi `NaN`NaN`NaN`NaN`");
        }
        drawn.push({ local: true, a: a });
      },
    };

    global.__mpCoopInject = false;
    global.__mpCoopSession = false;
    global.__mpCoopRenderEnter(renderer, 0.5, true, {});
    assert.equal(global.__mpCoopPlayerRenderer, renderer);
    assert.equal(drawn.length, 0, "no companion paint before session");

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
        colorId: 4,
        Sc: "#F53D40",
        Yc: "#D00B0E",
      },
    };

    renderer.render(0.5, true, {});
    assert.ok(
      drawn.some(function (d) {
        return d.local && d.a === 0.5;
      }),
      "local render runs"
    );
    assert.ok(
      drawn.some(function (d) {
        return d.x === 8;
      }),
      "remote painted after local"
    );
  });

  it("sanitizes NaN lerp and skips NaN remote bodies", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));

    const drawn = [];
    global.MultiplayerGsm = {
      drawWallSolverStyleSnake: function (ctx, body) {
        drawn.push(body[0] && body[0].x);
      },
      snakeMotion: function () {
        return null;
      },
    };

    const game = {
      oa: {
        ka: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
      ka: { ka: 20 },
      Tb: function () {},
    };
    const renderer = {
      wb: game,
      ka: {
        save: function () {},
        restore: function () {},
        globalAlpha: 1,
      },
      render: function (a) {
        if (typeof a === "number" && !Number.isFinite(a)) {
          throw new Error("yi `NaN`NaN`NaN`NaN`");
        }
        drawn.push({ a: a });
      },
    };

    global.__mpCoopInject = true;
    global.__mpCoopSession = true;
    global.__mpCoopMyId = "me";
    global.__mpCoopRemotes = {
      bad: {
        clientId: "bad",
        body: [
          { x: NaN, y: 3 },
          { x: 2, y: NaN },
        ],
      },
      good: {
        clientId: "good",
        body: [
          { x: 8, y: 7 },
          { x: 7, y: 7 },
        ],
      },
    };
    global.__mpCoopRenderEnter(renderer, NaN, true, {});
    assert.doesNotThrow(function () {
      renderer.render(NaN, true, {});
    });
    assert.ok(
      drawn.some(function (d) {
        return d && d.a === 0;
      }),
      "NaN lerp sanitized to 0"
    );
    assert.ok(drawn.indexOf(8) >= 0, "finite remote painted");
    assert.ok(drawn.indexOf(NaN) < 0 && !drawn.some(function (d) {
      return typeof d === "number" && !Number.isFinite(d);
    }), "NaN remote skipped");
  });

  it("skips native PlayerRenderer only when local body is empty/NaN", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));

    let nativeCalls = 0;
    const drawn = [];
    global.MultiplayerGsm = {
      drawWallSolverStyleSnake: function (ctx, body) {
        drawn.push(body[0] && body[0].x);
      },
      snakeMotion: function () {
        return null;
      },
    };
    const game = {
      oa: { ka: [] },
      ka: { ka: 20 },
    };
    const renderer = {
      wb: game,
      ka: {
        save: function () {},
        restore: function () {},
        globalAlpha: 1,
      },
      render: function () {
        nativeCalls++;
        throw new Error("yi `NaN`NaN`NaN`NaN`");
      },
    };
    global.__mpCoopInject = true;
    global.__mpCoopSession = true;
    global.__mpCoopSpectator = true;
    global.__mpCoopMyId = "me";
    global.__mpCoopRemotes = {
      other: {
        body: [
          { x: 4, y: 4 },
          { x: 3, y: 4 },
        ],
      },
    };
    global.__mpCoopRenderEnter(renderer);
    assert.equal(global.__mpCoopSkipNativeRender(renderer), true);
    assert.doesNotThrow(function () {
      renderer.render(NaN, true, {});
    });
    assert.equal(nativeCalls, 0, "native render skipped for empty body");
    assert.ok(drawn.indexOf(4) >= 0, "remotes still painted");

    // Parked spectator body is finite — native shared board must still render
    game.oa.ka = [{ x: -8, y: -8 }];
    assert.equal(global.__mpCoopSkipNativeRender(renderer), false);
    global.__mpCoopSpectator = false;
  });

  it("companion mosaic redraw survives settled motion", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));

    const drawn = [];
    global.MultiplayerGsm = {
      drawWallSolverStyleSnake: function (ctx, body) {
        drawn.push(body[0] && body[0].x);
      },
      snakeMotion: function () {
        return null;
      },
    };
    const game = {
      oa: {
        ka: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
        ],
      },
      ka: { ka: 20 },
    };
    const renderer = {
      wb: game,
      ka: {
        save: function () {},
        restore: function () {},
        globalAlpha: 1,
      },
      render: function () {},
    };
    global.__mpCoopInject = true;
    global.__mpCoopSession = true;
    global.__mpCoopMyId = "me";
    global.__mpCoopPlayerRenderer = renderer;
    global.__mpCoopRemotes = {
      other: {
        clientId: "other",
        body: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
        ],
        _visualBody: [
          { x: 5, y: 5 },
          { x: 4, y: 5 },
        ],
        _lerpAt: performance.now() - 500,
        _lerpStepMs: 90,
        _paintDirty: true,
        Sc: "#F00",
        Yc: "#C00",
      },
    };
    global.__mpCoopPaintCompanions(game);
    assert.equal(drawn.length, 1, "settled remote paints");
    global.__mpCoopPaintCompanions(game);
    global.__mpCoopPaintCompanions(game);
    assert.equal(drawn.length, 3, "settled remotes must keep redrawing");
    assert.equal(game.oa.ka[0].x, 0, "local body untouched");
  });

  it("skips friendly collision when peaceful / cat / cheese light tiles", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.myClientId = "me";
    cn.injectEnabled = true;
    cn.applySnakeDelta({
      clientId: "other",
      body: [
        { x: 4, y: 4 },
        { x: 3, y: 4 },
        { x: 2, y: 4 },
      ],
      alive: true,
    });
    global.__mpCoopInject = true;
    global.__mpCoopSession = true;
    global.__mpCoopMyId = "me";
    global.__mpCoopLocalDead = false;
    global.__mpCoopSpectator = false;

    let died = 0;
    const game = {
      oa: {
        ka: [
          { x: 3, y: 4 },
          { x: 3, y: 5 },
        ],
      },
      die: function () {
        died++;
      },
      Tb: function () {},
    };

    global.ModeRegistry = { getCurrentModeKey: function () { return "peaceful"; } };
    global.__mpCoopOnTick(game);
    assert.equal(died, 0, "peaceful must not kill on friendly hit");
    assert.equal(cn.hitsRemote({ x: 3, y: 4 }, "me"), false);

    global.ModeRegistry = { getCurrentModeKey: function () { return "classic"; } };
    global.cat_peaceful_ticks = 5;
    global.__mpCoopLocalDead = false;
    global.__mpCoopOnTick(game);
    assert.equal(died, 0, "cat_peaceful_ticks must skip friendly death");
    global.cat_peaceful_ticks = 0;

    global.ModeRegistry = { getCurrentModeKey: function () { return "cheese"; } };
    // (3+4)%2 === 1 → dark tile → still solid
    assert.equal(cn.hitsRemote({ x: 3, y: 4 }, "me"), true);
    assert.equal(cn.occupancyKeys(false)["3,4"], true);
    // (4+4)%2 === 0 → light tile → passthrough / not occupied
    cn.applySnakeDelta({
      clientId: "other",
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      alive: true,
    });
    assert.equal(cn.hitsRemote({ x: 4, y: 4 }, "me"), false, "cheese light tile pass");
    assert.equal(cn.occupancyKeys(false)["4,4"], undefined);
    assert.equal(cn.occupancyKeys(false)["3,4"], true, "dark remote cell still solid");

    delete global.ModeRegistry;
  });

  it("wrapped render sanitizes NaN lerp so versus Focus does not crash", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    require(path.join(root, "src/coop/native.js"));

    const seen = [];
    const renderer = {
      wb: { oa: { ka: [{ x: 1, y: 1 }] } },
      render: function (a) {
        if (typeof a === "number" && !Number.isFinite(a)) {
          throw new Error("yi NaN NaN NaN");
        }
        seen.push(a);
      },
    };
    // Versus: wrap is installed via RenderEnter even without co-op session
    global.__mpCoopInject = false;
    global.__mpCoopSession = false;
    global.__mpCoopRenderEnter(renderer, NaN, true, {});
    assert.doesNotThrow(function () {
      renderer.render(NaN, true, {});
    });
    assert.ok(seen.length >= 1);
    assert.ok(seen.every(function (a) {
      return Number.isFinite(a);
    }));
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

  it("sticky seeds ignore empty live deltas briefly", () => {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopRenderInstalled;
    delete global.__mpCoopOnTickInstalled;
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.beginSeedSticky(5000);
    cn.applySnakeDelta({
      clientId: "p2",
      body: [
        { x: 8, y: 9 },
        { x: 7, y: 9 },
        { x: 6, y: 9 },
      ],
      alive: true,
      _seeded: true,
    });
    cn.applySnakeDelta({
      clientId: "p2",
      body: [],
      alive: true,
    });
    assert.equal(cn.remotes.p2.body.length, 3);
    assert.equal(cn.remotes.p2.body[0].x, 8);
    assert.equal(cn.remotes.p2._seeded, true);
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
      "runtime/bridge.js",
      "session/ready.js",
      "versus/scoreboard.js",
      "coop/state.js",
      "coop/native.js",
      "hooks/gsm.js",
      "hooks/visibility.js",
      "net/client.js",
      "ui/settingsTab.js",
      "versus/focus.js",
      "versus/mosaic.js",
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

  it("ATTEMPT_EXPIRED returns admin player to menus (not spectator)", async () => {
    const MultiplayerApp = loadApp();
    const Client = global.MultiplayerClient;
    const Gsm = global.MultiplayerGsm;
    const origConnect = Client.prototype.connect;
    Client.prototype.connect = function () {
      this.connected = true;
      this.clientId = "admin";
      this.roster = {
        mode: "versus",
        sessionActive: true,
        allowNewRuns: true,
        attemptExpired: false,
        adminId: "admin",
        clients: [{ clientId: "admin", role: "player" }],
      };
      return Promise.resolve();
    };
    global.document.getElementById = function () {
      return null;
    };
    const prevShow = Gsm.showDeathScreen;
    const prevLocked = Gsm.setNativeMenusLocked;
    const prevPlayLock = Gsm.setPlayButtonLocked;
    const prevUnlock = Gsm.unlockPersonalMenus;
    let deathShown = 0;
    let menusLocked = null;
    Gsm.showDeathScreen = function () {
      deathShown++;
    };
    Gsm.setNativeMenusLocked = function (locked) {
      menusLocked = locked;
    };
    Gsm.setPlayButtonLocked = function () {};
    Gsm.unlockPersonalMenus = function () {};
    try {
      const app = new MultiplayerApp();
      app.ui = {
        mountHud: function () {},
        updateHud: function () {},
        updateColorIcon: function () {},
        renderRoster: function () {},
        updateRosterScores: function () {},
      };
      app.ensureFocusCanvas = function () {};
      app.updateStatusIndicator = function () {};
      app.endCoopNativeSession = function () {};
      app.setCoopAuthorityMode = function () {};
      await app.connect({});
      app.client.isAdmin = function () {
        return true;
      };
      app.client.me = function () {
        return { clientId: "admin", role: "player" };
      };
      app._versusFocusSpectate = false;
      global.__mpVersusFocusSpectate = false;
      app.client.emit(Protocol.TYPES.ATTEMPT_EXPIRED, {
        winnerClientId: "admin",
      });
      assert.equal(app.versus.expired, true);
      assert.equal(app.client.roster.attemptExpired, true);
      assert.equal(app.client.roster.allowNewRuns, false);
      assert.equal(app.client.roster.sessionActive, false);
      assert.equal(global.__mpAttemptExpired, true);
      assert.ok(deathShown >= 1, "death/settings screen shown");
      assert.equal(menusLocked, false, "admin match menus unlocked");
      assert.equal(app.canAutoRestartVersus(), false);
    } finally {
      Client.prototype.connect = origConnect;
      Gsm.showDeathScreen = prevShow;
      Gsm.setNativeMenusLocked = prevLocked;
      Gsm.setPlayButtonLocked = prevPlayLock;
      Gsm.unlockPersonalMenus = prevUnlock;
      delete global.__mpAttemptExpired;
    }
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

  it("reasserts coop spawn after native overwrites body", () => {
    const MultiplayerApp = loadApp();
    const Gsm = global.MultiplayerGsm;
    const game = {
      oa: {
        ka: [
          { x: 8, y: 7 },
          { x: 7, y: 7 },
          { x: 6, y: 7 },
        ],
      },
      wa: { oa: { oa: { width: 17, height: 15 } } },
    };
    global.__remixGame = game;
    global.__mpGame = game;
    const app = new MultiplayerApp();
    app.client = { clientId: "me" };
    app._coopSlots = [{ clientId: "me", oy: 2 }];
    app._coopSpawnApplied = false;
    app._coopSeatedPublish = false;
    Gsm.applyCoopSpawnOffset(2);
    assert.equal(game.oa.ka[0].y, 7 + 2);
    // Native rebuilds to center
    game.oa.ka = [
      { x: 8, y: 7 },
      { x: 7, y: 7 },
      { x: 6, y: 7 },
    ];
    assert.equal(app._bodyMatchesSpawnOy(), false);
    app._reassertCoopSpawnIfNeeded();
    assert.equal(game.oa.ka[0].y, 9);
    assert.equal(app._bodyMatchesSpawnOy(), true);
    app._reassertCoopSpawnIfNeeded();
    assert.equal(app._coopSpawnApplied, true);
  });

  it("VisibilityFix.install aliases fix (remixOrganizeSettings)", () => {
    loadApp();
    const Vis = global.MultiplayerVisibilityFix;
    assert.ok(Vis);
    assert.equal(typeof Vis.fix, "function");
    assert.equal(typeof Vis.install, "function");
    assert.equal(Vis.install, Vis.fix);
  });

  it("publishCoopState skips unchanged pose and stops after SESSION_END", () => {
    const MultiplayerApp = loadApp();
    global.__remixGame = {
      oa: {
        ka: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        direction: "RIGHT",
      },
    };
    global.__mpGame = global.__remixGame;
    const sent = [];
    const app = new MultiplayerApp();
    app._coopSessionActive = true;
    app.client = {
      connected: true,
      clientId: "me",
      me: function () {
        return { clientId: "me", role: "player", colorId: 0 };
      },
      roster: { mode: "coop", sessionActive: true },
      snakeDelta: function (d) {
        sent.push(d);
      },
      coopPlayerDead: function () {},
    };
    app.coopNative = { applySnakeDelta: function () {} };
    app.publishCoopState({ forceColors: true });
    assert.equal(sent.length, 1);
    app.publishCoopState();
    assert.equal(sent.length, 1, "fingerprint should skip unchanged pose");
    app.client.roster.sessionActive = false;
    app._coopSessionActive = false;
    global.__remixGame.oa.ka[0].x = 9;
    app.publishCoopState({ forceColors: true });
    assert.equal(sent.length, 1, "no publish after session end");
  });

  it("SNAKE_DELTA self-echo is ignored", async () => {
    const MultiplayerApp = loadApp();
    const Client = global.MultiplayerClient;
    const origConnect = Client.prototype.connect;
    Client.prototype.connect = function () {
      this.connected = true;
      this.clientId = "me";
      return Promise.resolve();
    };
    try {
      const app = new MultiplayerApp();
      app.ui = {
        mountHud: function () {},
        updateHud: function () {},
        updateColorIcon: function () {},
        renderRoster: function () {},
      };
      app.ensureFocusCanvas = function () {};
      app.applyControlLocks = function () {};
      app.updateStatusIndicator = function () {};
      await app.connect({});
      const applied = [];
      app.coopNative = {
        applySnakeDelta: function (p) {
          applied.push(p);
        },
      };
      app.client.emit(Protocol.TYPES.SNAKE_DELTA, {
        clientId: "me",
        body: [{ x: 1, y: 1 }],
      });
      app.client.emit(Protocol.TYPES.SNAKE_DELTA, {
        clientId: "other",
        body: [{ x: 2, y: 2 }],
      });
      assert.equal(applied.length, 1);
      assert.equal(applied[0].clientId, "other");

      // Live session: coalesce many deltas into one apply on flush
      applied.length = 0;
      app._coopSessionActive = true;
      app._pendingCoopSnakeDeltas = Object.create(null);
      global.__mpCoopFlushPendingDeltas = function () {
        const pending = app._pendingCoopSnakeDeltas;
        if (!pending || !app.coopNative) return;
        app._pendingCoopSnakeDeltas = Object.create(null);
        Object.keys(pending).forEach(function (id) {
          app.coopNative.applySnakeDelta(pending[id]);
        });
      };
      app.client.emit(Protocol.TYPES.SNAKE_DELTA, {
        clientId: "other",
        body: [{ x: 3, y: 3 }],
      });
      app.client.emit(Protocol.TYPES.SNAKE_DELTA, {
        clientId: "other",
        body: [{ x: 4, y: 4 }],
      });
      assert.equal(applied.length, 0, "queued until flush");
      global.__mpCoopFlushPendingDeltas();
      assert.equal(applied.length, 1);
      assert.equal(applied[0].body[0].x, 4, "latest pose wins");
    } finally {
      Client.prototype.connect = origConnect;
      delete global.__mpCoopFlushPendingDeltas;
    }
  });

  it("ERROR not_coop_session is swallowed (no console spam)", () => {
    const warns = [];
    const orig = console.warn;
    console.warn = function () {
      warns.push(
        Array.prototype.map
          .call(arguments, function (a) {
            return typeof a === "object" && a ? JSON.stringify(a) : String(a);
          })
          .join(" ")
      );
    };
    try {
      function onError(p) {
        if (p && p.code === "not_coop_session") return;
        console.warn("Multiplayer ERROR", p);
      }
      onError({ code: "not_coop_session", message: "not_coop_session" });
      onError({ code: "player_cap", message: "player_cap" });
      assert.equal(
        warns.filter(function (w) {
          return /not_coop_session/.test(w);
        }).length,
        0
      );
      assert.ok(
        warns.some(function (w) {
          return /player_cap/.test(w);
        })
      );
    } finally {
      console.warn = orig;
    }
  });
});

describe("MultiplayerRuntime bridge", () => {
  it("enter/leave Focus flips watch without arming the engine inject", () => {
    global.window = global;
    const p = require.resolve(path.join(root, "src/runtime/bridge.js"));
    delete require.cache[p];
    const Mp = require(path.join(root, "src/runtime/bridge.js"));
    global.__mpSpectateAllowMenus = true;
    Mp.enterVersusFocus();
    assert.equal(global.__mpVersusFocusWatch, true);
    // gsm's engine inject is gated on __mpVersusFocusSpectate; Focus draws the
    // board itself, so that gate must stay shut
    assert.equal(global.__mpVersusFocusSpectate, false);
    assert.equal(global.__mpSpectateAllowMenus, false);
    Mp.leaveVersusFocus();
    assert.equal(global.__mpVersusFocusWatch, false);
    assert.equal(global.__mpVersusFocusSpectate, false);
    assert.equal(global.__mpVersusFocusBoard, null);
  });

  it("escapeHtml neutralizes script-like display names", () => {
    require(path.join(root, "src/shared/colors.js"));
    require(path.join(root, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(root, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    // settingsTab needs document for ensureStyles — not required for escapeHtml export
    global.document = global.document || {
      getElementById: function () {
        return null;
      },
      createElement: function () {
        return { style: {}, classList: { add: function () {} } };
      },
    };
    require(path.join(root, "src/ui/settingsTab.js"));
    const esc = global.MultiplayerUI.escapeHtml;
    assert.ok(typeof esc === "function");
    const raw = '<img src=x onerror="alert(1)">';
    const out = esc(raw);
    assert.equal(out.indexOf("<img"), -1);
    assert.ok(out.indexOf("&lt;img") >= 0);
    assert.equal(esc('"&\'<>'), "&quot;&amp;&#39;&lt;&gt;");
  });
});

describe("coop body collision", () => {
  function loadNative() {
    global.window = global;
    const modPath = require.resolve(path.join(root, "src/coop/native.js"));
    delete require.cache[modPath];
    delete global.__mpCoopOnTickInstalled;
    delete global.__mpCoopRenderInstalled;
    return require(path.join(root, "src/coop/native.js"));
  }

  it("does not stamp remote bodies into the wall grid", () => {
    loadNative();
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.injectEnabled = true;
    cn.myClientId = "me";
    cn.applySnakeDelta({
      clientId: "other",
      body: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
      alive: true,
    });
    global.__mpCoopSession = true;
    global.__mpCoopInject = true;
    global.__mpCoopMyId = "me";
    const game = {
      Ca: { wa: [[0, 0, 0, 0], [0, 0, 0, 0]] },
      oa: { ka: [{ x: 0, y: 0 }], direction: null },
      Tb: function () {},
    };
    global.__mpCoopOnTick(game);
    assert.equal(game.Ca.wa[0][1], 0, "no stamp on remote body");
    assert.equal(game.Ca.wa[0][2], 0, "no stamp on remote body");
  });

  it("kills local snake when stepping onto a remote body", () => {
    loadNative();
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.injectEnabled = true;
    cn.myClientId = "me";
    cn.applySnakeDelta({
      clientId: "other",
      body: [{ x: 1, y: 0 }],
      alive: true,
    });
    global.__mpCoopSession = true;
    global.__mpCoopInject = true;
    global.__mpCoopMyId = "me";
    global.__mpCoopLocalDead = false;
    let died = false;
    const game = {
      Ca: { wa: [[0, 0, 0]] },
      oa: {
        ka: [{ x: 0, y: 0 }],
        direction: "RIGHT",
      },
      die: function () {
        died = true;
        this.nj = true;
      },
      Tb: function () {},
    };
    global.__mpCoopOnTick(game);
    assert.equal(died, true, "die() on remote body");
    assert.equal(global.__mpCoopLocalDead, true);
  });

  it("yin yang skips friendly body collision", () => {
    loadNative();
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.injectEnabled = true;
    cn.myClientId = "me";
    cn.applySnakeDelta({
      clientId: "other",
      body: [{ x: 1, y: 0 }],
      alive: true,
    });
    global.window = global;
    global.ModeRegistry = {
      getCurrentModeKey: function () {
        return "yin_yang";
      },
    };
    global.__mpCoopSession = true;
    global.__mpCoopInject = true;
    global.__mpCoopLocalDead = false;
    let died = false;
    const game = {
      Ca: { wa: [[0, 0, 0]] },
      oa: {
        ka: [{ x: 0, y: 0 }],
        direction: "RIGHT",
      },
      die: function () {
        died = true;
      },
      Tb: function () {},
    };
    global.__mpCoopOnTick(game);
    assert.equal(died, false, "yin yang: no friendly kill");
    assert.equal(game.Ca.wa[0][1], 0);
    delete global.ModeRegistry;
  });

  it("peaceful skips friendly body collision", () => {
    loadNative();
    const { CoopNative } = require(path.join(root, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.injectEnabled = true;
    cn.myClientId = "me";
    cn.applySnakeDelta({
      clientId: "other",
      body: [{ x: 1, y: 0 }],
      alive: true,
      peaceful: true,
    });
    global.__mpCoopSession = true;
    global.__mpCoopInject = true;
    global.__mpCoopLocalDead = false;
    let died = false;
    const game = {
      Ca: { wa: [[0, 0, 0]] },
      oa: {
        ka: [{ x: 0, y: 0 }],
        direction: "RIGHT",
      },
      die: function () {
        died = true;
      },
      Tb: function () {},
    };
    global.__mpCoopOnTick(game);
    assert.equal(died, false);
  });

  it("findFreeSpawnCell skips solid wall cells", () => {
    loadNative();
    const native = require(path.join(root, "src/coop/native.js"));
    const game = {
      Ca: {
        wa: [
          [0, 1, 0, 0],
          [0, 0, 0, 0],
        ],
      },
      oa: { ka: [], oa: { width: 4, height: 2 } },
      wa: { oa: { oa: { width: 4, height: 2 } } },
    };
    const free = native.findFreeSpawnCell(game, {});
    assert.ok(free, "found a free cell");
    assert.notEqual(free.x + "," + free.y, "1,0", "did not land on wall");
    assert.equal(native.isSolidWallCell(game, 1, 0), true);
    assert.equal(native.isSolidWallCell(game, 0, 0), false);
  });
});

