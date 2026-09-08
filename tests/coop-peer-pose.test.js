"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function fresh(rel) {
  const file = path.join(ROOT, rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

function pose(x, y, dir, body2) {
  const out = { body: [{ x: x, y: y }], dir: dir, headDir: dir };
  if (body2) out.body2 = body2;
  return out;
}

describe("Plan 2 peer pose contract", () => {
  beforeEach(() => {
    delete global.window;
    global.timeKeeper = { mode: "classic" };
    global.__remixGame = null;
    global.__mpGame = null;
  });

  it("anchors accepted turns at the pre-move head and rejects reversals", () => {
    const { CoopSessionController } = fresh("src/coop/session.js");
    const session = new CoopSessionController();
    session.observeNativePose(pose(4, 4, "RIGHT"));
    const turned = session.observeNativePose(pose(4, 3, "UP"));
    assert.deepEqual(turned.fromHead, { x: 4, y: 4 });
    assert.deepEqual(turned.toHead, { x: 4, y: 3 });
    assert.equal(turned.moveSeq, 1);
    assert.deepEqual(turned.turns, [{
      turnSeq: 1,
      at: { x: 4, y: 4 },
      fromDir: "RIGHT",
      toDir: "UP",
      moveSeq: 1,
    }]);

    const rejected = session.observeNativePose(pose(5, 3, "DOWN"));
    assert.equal(rejected.turns.length, 1, "reversal is not journaled");
    assert.equal(rejected.headDir, "UP", "uncertain queue value fails safely");
  });

  it("repeats at most eight unacknowledged turns and prunes on ack", () => {
    const { CoopSessionController } = fresh("src/coop/session.js");
    const session = new CoopSessionController();
    session.observeNativePose(pose(10, 10, "RIGHT"));
    const dirs = ["UP", "LEFT", "DOWN", "RIGHT"];
    let x = 10;
    let y = 10;
    let latest;
    for (let i = 0; i < 10; i++) {
      const dir = dirs[i % dirs.length];
      if (dir === "UP") y--;
      if (dir === "DOWN") y++;
      if (dir === "LEFT") x--;
      if (dir === "RIGHT") x++;
      latest = session.observeNativePose(pose(x, y, dir));
    }
    assert.equal(latest.turns.length, 8);
    assert.equal(latest.turns[0].turnSeq, 3);
    assert.equal(latest.turns[7].turnSeq, 10);
    assert.equal(session.ackTurns(7), true);
    latest = session.observeNativePose(pose(x + 1, y, "RIGHT"));
    assert.deepEqual(latest.turns.map((turn) => turn.turnSeq), [8, 9, 10]);
  });

  it("merges overlap and contiguous suffix before pose coalescing", () => {
    const Session = fresh("src/coop/session.js");
    const { CoopState } = fresh("src/coop/state.js");
    const state = new CoopState();
    state.applySession({
      authority: "native-relay-v1",
      generation: 2,
    });
    function turn(n) {
      return {
        turnSeq: n,
        at: { x: n, y: 1 },
        fromDir: n % 2 ? "RIGHT" : "UP",
        toDir: n % 2 ? "UP" : "LEFT",
        moveSeq: n,
      };
    }
    const first = {
      generation: 2,
      clientId: "peer",
      poseSeq: 1,
      turns: [turn(1), turn(2)],
    };
    const latest = {
      generation: 2,
      clientId: "peer",
      poseSeq: 2,
      turns: [turn(2), turn(3)],
    };
    assert.equal(state.acceptPose(first), true);
    assert.equal(state.acceptPose(latest), true);
    assert.deepEqual(latest.turns.map((value) => value.turnSeq), [1, 2, 3]);
    assert.deepEqual(
      Session.mergePoseTurns(latest.turns, [turn(3), turn(4)])
        .map((value) => value.turnSeq),
      [1, 2, 3, 4]
    );
  });

  it("fingerprints full bends, twin, facing, turns, mode, and render state", () => {
    const Gsm = fresh("src/hooks/gsm.js");
    const base = {
      alive: true,
      body: [{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
      body2: [{ x: 13, y: 13 }],
      dir: "RIGHT",
      headDir: "RIGHT",
      movementDir: "RIGHT",
      transitionDir: "RIGHT",
      modeKey: "yin_yang",
      headLight2: 2,
      turns: [],
    };
    const fp = Gsm.snakeDeltaFingerprint(base);
    function changed(patch) {
      return Gsm.snakeDeltaFingerprint(Object.assign({}, base, patch));
    }
    assert.notEqual(changed({
      body: [{ x: 3, y: 1 }, { x: 3, y: 2 }, { x: 2, y: 2 }],
    }), fp, "same head/length but different bend");
    assert.notEqual(changed({ body2: [{ x: 12, y: 13 }] }), fp);
    assert.notEqual(changed({ headDir: "UP" }), fp);
    assert.notEqual(changed({ modeKey: "twin" }), fp);
    assert.notEqual(changed({ headLight2: 1 }), fp);
    assert.notEqual(changed({ turns: [{
      turnSeq: 1,
      at: { x: 3, y: 1 },
      fromDir: "RIGHT",
      toDir: "UP",
      moveSeq: 2,
    }] }), fp);
  });

  it("reflects Yin Yang fallback directions and emits no Twin body2", () => {
    global.timeKeeper = { mode: "yin_yang" };
    global.__remixGame = {
      oa: {
        ka: [{ x: 3, y: 4 }, { x: 2, y: 4 }],
        direction: "RIGHT",
      },
      wa: { oa: { oa: { width: 17, height: 15 } } },
    };
    global.__mpGame = global.__remixGame;
    let Gsm = fresh("src/hooks/gsm.js");
    let delta = Gsm.scrapeCoopSnakeDelta(0, { includeColors: false });
    assert.ok(delta.body2);
    assert.equal(delta.headDir2, "LEFT");
    assert.equal(delta.movementDir2, "LEFT");

    global.timeKeeper.mode = "twin";
    Gsm = fresh("src/hooks/gsm.js");
    delta = Gsm.scrapeCoopSnakeDelta(0, { includeColors: false });
    assert.equal(delta.body2, undefined);
    assert.equal(delta.headDir2, undefined);
  });

  it("prefers actual companion facing and visual style", () => {
    global.timeKeeper = { mode: "yin_yang" };
    global.__remixGame = {
      oa: {
        ka: [{ x: 3, y: 4 }, { x: 2, y: 4 }],
        direction: "RIGHT",
      },
      Ra: {
        ka: [{ x: 8, y: 9 }, { x: 8, y: 10 }],
        direction: "UP",
        Sc: "#111111",
        Yc: "#eeeeee",
      },
      wa: { oa: { oa: { width: 17, height: 15 } } },
    };
    global.__mpGame = global.__remixGame;
    const Gsm = fresh("src/hooks/gsm.js");
    const delta = Gsm.scrapeCoopSnakeDelta(0, { includeColors: false });
    assert.equal(delta.headDir2, "UP");
    assert.equal(delta.movementDir2, "UP");
    assert.equal(delta.Sc2, "#111111");
    assert.equal(delta.Yc2, "#eeeeee");
  });

  it("publishes canonical modeKey on initial board and every pose", () => {
    const Session = fresh("src/coop/session.js");
    const State = fresh("src/coop/state.js");
    const Protocol = fresh("src/shared/protocol.js");
    global.MultiplayerClient = function () {};
    global.RaceState = function () {};
    global.CoopState = State.CoopState;
    global.CoopNative = function () {};
    global.CoopSessionController = Session.CoopSessionController;
    global.MultiplayerUI = function () {};
    global.MultiplayerProtocol = Protocol;
    global.MultiplayerColors = {};
    global.MultiplayerRuntime = {};
    global.MultiplayerGsm = {
      effectiveModeKey: () => "slot_machine+yin_yang",
      scrapeCollectables: () => ({ apples: [] }),
      scrapeCoopSnakeDelta: () => ({
        body: [{ x: 2, y: 2 }],
        dir: "RIGHT",
        headDir: "RIGHT",
        movementDir: "RIGHT",
      }),
      snakeDeltaFingerprint: () => String(Math.random()),
    };
    const { MultiplayerApp } = fresh("src/mod.js");
    const app = new MultiplayerApp();
    const boards = [];
    const poses = [];
    app._coopAuthority = "native-relay-v1";
    app._coopBoardInitRequested = true;
    app._coopSpawnApplied = true;
    app._coopSessionActive = true;
    app._coopSeatedPublish = true;
    app.coop.authority = "native-relay-v1";
    app.coop.generation = 4;
    app.coop.collectablesOwnerId = "me";
    app.coop.boardReady = false;
    app.coopSession.bindGeneration(4, "native-relay-v1", false);
    app.coopSession.markSeated();
    app.client = {
      connected: true,
      clientId: "me",
      roster: { mode: "coop", sessionActive: true },
      me: () => ({ clientId: "me", role: "player", colorId: 0 }),
      collectablesDelta: (value) => boards.push(value),
      snakeDelta: (value) => poses.push(value),
      coopPlayerDead: () => {},
    };
    assert.equal(app.publishInitialCoopBoard(), true);
    assert.equal(boards[0].modeKey, "slot_machine+yin_yang");
    app.coop.boardReady = true;
    app.publishCoopState({ forceColors: true, seated: true });
    assert.equal(poses[0].modeKey, "slot_machine+yin_yang");
  });
});
