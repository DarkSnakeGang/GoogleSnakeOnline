"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function fresh(rel) {
  const p = path.join(ROOT, rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

describe("co-op dual authority and generation state", () => {
  it("requires explicit authority and freezes it per generation", () => {
    const { CoopState } = fresh("src/coop/state.js");
    const state = new CoopState();
    assert.equal(state.applySession({ generation: 1 }).ok, false);
    assert.equal(
      state.applySession({
        authority: "native-relay-v1",
        generation: 4,
        slots: [],
      }).ok,
      true
    );
    assert.equal(
      state.applySession({
        authority: "server-sim-v1",
        generation: 4,
        resync: true,
      }).reason,
      "authority_changed"
    );
    assert.equal(
      state.applySession({
        authority: "server-sim-v1",
        generation: 3,
      }).reason,
      "stale_generation"
    );
  });

  it("validates pose sequence, board revision, and speed epoch", () => {
    const { CoopState } = fresh("src/coop/state.js");
    const state = new CoopState();
    state.applySession({
      authority: "native-relay-v1",
      generation: 7,
      boardRevision: 0,
      speedEpoch: 0,
    });
    assert.equal(
      state.acceptPose({ generation: 6, clientId: "p", poseSeq: 1 }),
      false
    );
    assert.equal(
      state.acceptPose({ generation: 7, clientId: "p", poseSeq: 1 }),
      true
    );
    assert.equal(
      state.acceptPose({ generation: 7, clientId: "p", poseSeq: 1 }),
      false
    );
    assert.equal(
      state.applyBoard({ generation: 7, revision: 1, initial: true }),
      true
    );
    assert.equal(state.boardReady, false);
    assert.equal(
      state.applyBoardReady({ generation: 7, revision: 1 }),
      true
    );
    assert.equal(state.boardReady, true);
    assert.equal(
      state.applySpeed({
        generation: 7,
        speedEpoch: 1,
        sourceEventId: "eat:1",
        effectiveSpeed: { intervalMs: 100 },
      }),
      true
    );
    assert.equal(
      state.applySpeed({
        generation: 7,
        speedEpoch: 2,
        sourceEventId: "eat:1",
      }),
      false
    );
    assert.equal(
      state.applySpeed({
        generation: 7,
        speedEpoch: 2,
        sourceEventId: "eat:2",
        intervalMs: 0,
      }),
      true
    );
    assert.equal(state.speedState, 0);
  });

  it("holds native relay in Seating until board ready and flushes atomically", () => {
    const { CoopSessionController } = fresh("src/coop/session.js");
    const session = new CoopSessionController();
    assert.equal(session.bindGeneration(2, "native-relay-v1", false), true);
    session.markSeated();
    assert.equal(session.state, "Seating");
    session.queueInput("UP");
    session.queuePose({ moved: true });
    assert.equal(session.markBoardReady(1), true);
    assert.equal(session.state, "Live");
    assert.deepEqual(session.takeQueued(), {
      input: "UP",
      pose: { moved: true },
    });
    assert.deepEqual(session.takeQueued(), { input: null, pose: null });
  });

  it("accepts canonical revision while an unseated peer is Seating", () => {
    const { CoopSessionController } = fresh("src/coop/session.js");
    const session = new CoopSessionController();
    session.bindGeneration(3, "native-relay-v1", false);
    assert.equal(session.seated, false);
    assert.equal(
      session.canApplyBoard({ revision: 1, initial: true }),
      true
    );
    session.noteBoardRev({ boardRevision: 1 });
    assert.equal(session.boardRev, 1);
  });

  it("stages replay invisibly and replaces all state only at commit", () => {
    const { CoopState } = fresh("src/coop/state.js");
    const { CoopSessionController } = fresh("src/coop/session.js");
    const state = new CoopState();
    const session = new CoopSessionController();
    state.applySession({
      authority: "native-relay-v1",
      generation: 5,
      boardReady: true,
      boardRevision: 2,
      effectiveSpeed: false,
      slots: [{ clientId: "me", slot: 0 }],
    });
    state.peerPoseSeq.peer = 9;
    session.bindGeneration(5, "native-relay-v1", true);
    session.markSeated();
    session.nextEventSeq();
    session.nextPoseSeq();
    const update = state.applySession({
      authority: "native-relay-v1",
      generation: 5,
      resync: true,
      boardReady: true,
      boardRevision: 3,
      effectiveSpeed: 0,
      slots: [
        { clientId: "me", slot: 0 },
        { clientId: "peer", slot: 1 },
      ],
    });
    assert.equal(
      state.applyBoard({
        generation: 5,
        revision: 3,
        initial: true,
        apples: [{ x: 4, y: 4 }],
      }),
      true
    );
    assert.equal(
      state.applyBoardReady({ generation: 5, revision: 3 }),
      true
    );
    assert.equal(
      state.acceptPose({
        generation: 5,
        clientId: "peer",
        poseSeq: 12,
        body: [{ x: 8, y: 8 }],
      }),
      true
    );
    assert.equal(
      state.applySpeed({
        generation: 5,
        speedEpoch: 2,
        effectiveSpeed: 0,
        resync: true,
      }),
      true
    );
    state.stageTimer({ generation: 5, timerStartedAtMs: 1234 });

    assert.equal(update.fresh, false);
    assert.equal(state.resyncing, true);
    // Nothing replayed is visible before final ROSTER calls commitResync.
    assert.equal(state.boardRevision, 2);
    assert.equal(state.speedState, false);
    assert.equal(state.peerPoseSeq.peer, 9);
    assert.equal(state.slots.length, 1);
    assert.equal(session.state, "Live");
    assert.equal(session.eventSeq, 1);
    assert.equal(session.poseSeq, 1);

    const replay = state.commitResync();
    assert.equal(state.resyncing, false);
    assert.equal(state.boardRevision, 3);
    assert.equal(state.speedState, 0);
    assert.equal(state.peerPoseSeq.peer, 12);
    assert.equal(state.timerStartedAtMs, 1234);
    assert.equal(state.slots.length, 2);
    assert.equal(replay.board.apples[0].x, 4);
    assert.equal(replay.poses[0].body[0].x, 8);
    // Session-owned local mutation counters are unchanged by replay commit.
    assert.equal(session.eventSeq, 1);
    assert.equal(session.poseSeq, 1);
  });

  it("accepts an atomic resync into a generation not seen locally", () => {
    const { CoopState } = fresh("src/coop/state.js");
    const state = new CoopState();
    const update = state.applySession({
      authority: "native-relay-v1",
      generation: 8,
      resync: true,
      boardReady: false,
      boardRevision: 0,
      slots: [{ clientId: "late", slot: 0 }],
    });
    assert.equal(update.ok, true);
    assert.equal(update.fresh, true);
    assert.equal(state.generation, 0, "staged metadata stays invisible");
    state.commitResync();
    assert.equal(state.generation, 8);
    assert.equal(state.slots[0].clientId, "late");
  });
});

describe("co-op bridge authority derivation", () => {
  let oldWindow;

  beforeEach(() => {
    oldWindow = global.window;
    global.window = {};
  });

  afterEach(() => {
    global.window = oldWindow;
  });

  it("derives server auth only from negotiated authority", () => {
    const Runtime = fresh("src/runtime/bridge.js");
    Runtime.setCoopAuthority("native-relay-v1", 9, false);
    assert.equal(global.window.__mpCoopServerAuth, false);
    assert.equal(global.window.__mpCoopGeneration, 9);
    Runtime.setCoopAuthority("server-sim-v1", 10, true);
    assert.equal(global.window.__mpCoopServerAuth, true);
    assert.equal(global.window.__mpCoopBoardReady, true);
  });
});

describe("co-op relay protocol", () => {
  it("exports authority and board/speed message contracts", () => {
    const Protocol = fresh("src/shared/protocol.js");
    assert.equal(
      Protocol.COOP_AUTHORITIES.SERVER_SIM,
      "server-sim-v1"
    );
    assert.equal(Protocol.TYPES.COOP_BOARD_INIT, "COOP_BOARD_INIT");
    assert.equal(Protocol.TYPES.COOP_BOARD_READY, "COOP_BOARD_READY");
    assert.equal(
      Protocol.TYPES.COOP_SPEED_TRANSITION,
      "COOP_SPEED_TRANSITION"
    );
  });
});
