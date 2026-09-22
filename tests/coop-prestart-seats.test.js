"use strict";

/**
 * Plan 3: pre-start visual native seats — seed/paint before hard lock.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadApp(win) {
  global.window = win;
  global.document = win.document;
  global.HTMLElement = win.HTMLElement;
  global.Node = win.Node;
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
    "hooks/visibility.js",
    "net/client.js",
    "ui/settingsTab.js",
    "race/focus.js",
    "race/mosaic.js",
    "mod.js",
  ].forEach(function (rel) {
    const p = require.resolve(path.join(ROOT, "src", rel));
    delete require.cache[p];
    require(p);
  });
  return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
}

function centerBody(w, h) {
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  return [
    {
      x: cx,
      y: cy,
      clone: function () {
        return { x: this.x, y: this.y, clone: this.clone };
      },
    },
    {
      x: cx - 1,
      y: cy,
      clone: function () {
        return { x: this.x, y: this.y, clone: this.clone };
      },
    },
    {
      x: cx - 2,
      y: cy,
      clone: function () {
        return { x: this.x, y: this.y, clone: this.clone };
      },
    },
  ];
}

function makeGame(w, h) {
  return {
    nj: false,
    oa: {
      ka: centerBody(w, h),
      oa: { width: w, height: h },
      direction: null,
      dir: null,
    },
    wa: { ka: [], oa: { oa: { width: w, height: h } } },
    Ca: { Aa: new Map(), wa: [] },
  };
}

describe("coop pre-start visual seats", () => {
  let win;
  let MultiplayerApp;
  let Protocol;

  beforeEach(() => {
    win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    MultiplayerApp = loadApp(win);
    Protocol = win.MultiplayerProtocol;
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.HTMLElement;
    delete global.Node;
  });

  function makeApp(slots) {
    const game = makeGame(10, 9);
    win.__mpGame = game;
    win.__remixGame = game;
    const app = new MultiplayerApp();
    app._coopAuthority = "native-relay-v1";
    app._coopSpawnApplied = false;
    app._coopSeatedPublish = false;
    app.client = {
      connected: true,
      clientId: "me",
      roster: {
        mode: "coop",
        sessionActive: true,
        clients: [
          { clientId: "me", role: "player", colorId: 1, coopSlot: 0 },
          { clientId: "peer", role: "player", colorId: 2, coopSlot: 1 },
        ],
      },
      me: function () {
        return { clientId: "me", role: "player", colorId: 1 };
      },
      snakeDelta: function () {},
    };
    app.coopNative.sessionActive = true;
    app.coopNative.myClientId = "me";
    app.coopNative.injectEnabled = true;
    app.coopNative.syncBridge();
    app._coopSlots = slots || [
      {
        clientId: "me",
        slot: 0,
        x: 5,
        y: 3,
        dir: "RIGHT",
        oy: -1,
        boardWidth: 10,
        boardHeight: 9,
      },
      {
        clientId: "peer",
        slot: 1,
        x: 5,
        y: 5,
        dir: "RIGHT",
        oy: 1,
        boardWidth: 10,
        boardHeight: 9,
      },
    ];
    return { app, game };
  }

  it("paintCoopSeatsFromSlots seeds peer remotes; local stays native-only", () => {
    const { app, game } = makeApp();
    assert.equal(app._coopSpawnApplied, false);
    assert.equal(!!app.coop.boardReady, false);

    const ok = app.paintCoopSeatsFromSlots({ lock: false });
    assert.equal(ok, true);
    assert.equal(app._coopSpawnApplied, false, "visual paint must not hard-lock");
    assert.equal(win.__mpCoopVisualSeated, true);
    assert.equal(game.oa.ka[0].x, 5);
    assert.equal(game.oa.ka[0].y, 3);
    assert.equal(game.oa.direction, "NONE", "idle-until-key");

    const remotes = app.coopNative.remotes;
    assert.ok(remotes.peer, "peer seeded");
    assert.equal(remotes.me, undefined, "local not in remotes");
    assert.equal(remotes.peer.body[0].x, 5);
    assert.equal(remotes.peer.body[0].y, 5);
  });

  it("SESSION_START timeline: remotes seed without boardReady or spawn lock", () => {
    const { app } = makeApp();
    app.coop.boardReady = false;
    app._coopSpawnApplied = false;
    app._coopSessionActive = false;

    app.paintCoopSeatsFromSlots({ lock: false });
    assert.ok(app.coopNative.remotes.peer);
    assert.equal(app._coopSpawnApplied, false);
    assert.equal(app.coop.boardReady, false);
  });

  it("small board absolute seat is used on first visual paint", () => {
    const { app, game } = makeApp();
    // Classic center on 10×9 is (5,4)
    assert.equal(game.oa.ka[0].x, 5);
    assert.equal(game.oa.ka[0].y, 4);

    app.paintCoopSeatsFromSlots({ lock: false });
    assert.equal(game.oa.ka[0].x, 5);
    assert.equal(game.oa.ka[0].y, 3);
    assert.notEqual(game.oa.ka[0].y, Math.floor(9 / 2));
  });

  it("native-relay SeatOnPlayLive paints before session active (same-turn Play)", () => {
    const { app, game } = makeApp();
    app._coopSessionActive = false;
    win.__mpCoopInject = true;
    win.__mpCoopSession = true;
    win.__mpCoopServerAuth = false;

    win.__mpCoopSeatOnPlayLive = function () {
      app.paintCoopSeatsFromSlots({ lock: false });
      if (app._coopSessionActive) return app.trySeatCoopOnce(false);
      return !!win.__mpCoopVisualSeated;
    };

    // Simulate Play bake at Classic center, then same-turn seat hook
    game.oa.ka = centerBody(10, 9);
    assert.equal(game.oa.ka[0].y, Math.floor(9 / 2));

    const seated = win.__mpCoopSeatOnPlayLive();
    assert.equal(seated, true);
    assert.equal(game.oa.ka[0].x, 5);
    assert.equal(game.oa.ka[0].y, 3);
    assert.notEqual(game.oa.ka[0].y, Math.floor(9 / 2));
    assert.equal(app._coopSpawnApplied, false);
  });

  it("startNativeRun same-turn gate invokes SeatOnPlayLive for inject (not only server-auth)", async () => {
    const Gsm = win.MultiplayerGsm;
    const game = makeGame(10, 9);
    win.__mpGame = game;
    win.__remixGame = game;
    win.timeKeeper = { _dead: false, playing: true, start: function () {} };
    win.__mpCoopServerAuth = false;
    win.__mpCoopInject = true;
    win.__mpCoopSession = true;
    let calls = 0;
    win.__mpCoopSeatOnPlayLive = function () {
      calls++;
      return true;
    };
    // Force live so the seat branch runs on first tick
    const origLive = Gsm.isNativeRunLive;
    Gsm.isNativeRunLive = function () {
      return true;
    };
    try {
      await new Promise(function (resolve) {
        Gsm.startNativeRun({
          maxAttempts: 1,
          intervalMs: 1,
          onDone: function () {
            resolve();
          },
        });
      });
      assert.ok(calls >= 1, "SeatOnPlayLive must run for native-relay inject");
    } finally {
      Gsm.isNativeRunLive = origLive;
    }
  });

  it("ROSTER merge keeps absolute x/y/dir/board dims from prior slots", async () => {
    const Client = win.MultiplayerClient;
    const origConnect = Client.prototype.connect;
    Client.prototype.connect = function () {
      this.connected = true;
      this.clientId = "me";
      this.joined = true;
      return Promise.resolve();
    };
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
      app.applyControlLocks = function () {};
      app.updateStatusIndicator = function () {};
      app.clearSpectatorSeat = function () {};
      await app.connect({});
      app._coopAuthority = "native-relay-v1";
      app._coopSessionActive = false;
      app._coopSlots = [
        {
          clientId: "me",
          slot: 0,
          x: 5,
          y: 3,
          dir: "RIGHT",
          oy: -1,
          boardWidth: 10,
          boardHeight: 9,
        },
        {
          clientId: "peer",
          slot: 1,
          x: 5,
          y: 5,
          dir: "LEFT",
          oy: 1,
          boardWidth: 10,
          boardHeight: 9,
        },
      ];
      app.client.emit(Protocol.TYPES.ROSTER, {
        mode: "coop",
        sessionActive: true,
        clients: [
          {
            clientId: "me",
            role: "player",
            coopSlot: 0,
            playerNumber: 1,
            colorId: 1,
          },
          {
            clientId: "peer",
            role: "player",
            coopSlot: 1,
            playerNumber: 2,
            colorId: 2,
          },
        ],
      });
      const me = app._coopSlots.find(function (s) {
        return s.clientId === "me";
      });
      const peer = app._coopSlots.find(function (s) {
        return s.clientId === "peer";
      });
      assert.equal(me.x, 5);
      assert.equal(me.y, 3);
      assert.equal(me.dir, "RIGHT");
      assert.equal(me.boardWidth, 10);
      assert.equal(me.boardHeight, 9);
      assert.equal(me.oy, -1);
      assert.equal(peer.x, 5);
      assert.equal(peer.y, 5);
      assert.equal(peer.dir, "LEFT");
    } finally {
      Client.prototype.connect = origConnect;
    }
  });

  it("after hard lock, second trySeatCoopOnce does not rewrite body", () => {
    const { app, game } = makeApp();
    const Gsm = win.MultiplayerGsm;
    app._coopSessionActive = true;
    app._coopSpawnApplied = false;
    const origLive = Gsm.isNativeRunLive;
    Gsm.isNativeRunLive = function () {
      return true;
    };
    try {
      assert.equal(app.trySeatCoopOnce(false), true);
      assert.equal(app._coopSpawnApplied, true);
      assert.equal(game.oa.ka[0].y, 3);
      game.oa.ka[0].y = 4;
      assert.equal(app.trySeatCoopOnce(false), true);
      assert.equal(game.oa.ka[0].y, 4, "already seated — do not rewrite");
    } finally {
      Gsm.isNativeRunLive = origLive;
    }
  });

  it("SeatBeforeRender reseats native-relay from last spawn pose", () => {
    const game = makeGame(10, 9);
    win.__mpGame = game;
    win.__remixGame = game;
    win.__mpCoopServerAuth = false;
    win.__mpCoopInject = true;
    win.__mpCoopSession = true;
    win.__mpCoopSeatLocked = false;
    win.__mpLastCoopSpawnPose = { x: 5, y: 3, dir: "RIGHT" };
    // Clobber to classic center
    game.oa.ka = centerBody(10, 9);
    game.oa.direction = null;

    const ok = win.__mpCoopSeatBeforeRender({ wb: game, ka: null });
    assert.equal(ok, true);
    assert.equal(game.oa.ka[0].x, 5);
    assert.equal(game.oa.ka[0].y, 3);
  });
});
