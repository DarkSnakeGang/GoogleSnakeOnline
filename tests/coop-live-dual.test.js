"use strict";

/**
 * Phase 6 — Dual-client live co-op harness.
 *
 * Two clients against a real room server, each with a tickable mock engine
 * wired through seat / publish / death pipelines (not a fake "already dead" scrape).
 * Classic 17×15: idle stays alive; ArrowRight-only dies on the right border.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("path");
const net = require("node:net");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(
  ROOT,
  "server",
  "target",
  "debug",
  process.platform === "win32" ? "multiplayer-server.exe" : "multiplayer-server"
);
const PORT = 18778;
const URL = `ws://127.0.0.1:${PORT}/ws`;

const BOARD_W = 17;
const BOARD_H = 15;

function waitPort(port, ms = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.end();
        resolve();
      });
      s.on("error", () => {
        if (Date.now() - start > ms) reject(new Error("port timeout"));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.onopen = () => resolve({ ws, inbox });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      inbox.push(JSON.parse(ev.data));
    };
  });
}

function send(ws, type, payload) {
  ws.send(
    JSON.stringify({ v: 1, type, payload: payload || {}, seq: Date.now() })
  );
}

const relayCounters = new WeakMap();

function relayPayload(ws, generation, payload, pose) {
  const counters = relayCounters.get(ws) || { eventSeq: 0, poseSeq: 0 };
  counters.eventSeq++;
  const out = Object.assign(
    { generation, eventSeq: counters.eventSeq },
    payload || {}
  );
  if (pose) out.poseSeq = ++counters.poseSeq;
  relayCounters.set(ws, counters);
  return out;
}

async function waitMsg(inbox, type, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(
    "timeout waiting for " + type + " have=" + inbox.map((m) => m.type).join(",")
  );
}

async function waitRosterWhere(inbox, pred, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    while (true) {
      const i = inbox.findIndex((m) => m.type === "ROSTER");
      if (i < 0) break;
      const msg = inbox.splice(i, 1)[0];
      if (pred(msg.payload)) return msg.payload;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout waiting for roster predicate");
}

/** Length-3 RIGHT body at (x,y) head — mirrors Gsm.coopSpawnBodyFromPose. */
function bodyAt(x, y) {
  return [
    { x: x | 0, y: y | 0 },
    { x: (x | 0) - 1, y: y | 0 },
    { x: (x | 0) - 2, y: y | 0 },
  ];
}

/**
 * Tickable mock engine: crawls RIGHT each step; dies when head would leave board.
 */
function MockCoopEngine(seat) {
  this.width = BOARD_W;
  this.height = BOARD_H;
  this.x = seat.x | 0;
  this.y = seat.y | 0;
  this.alive = true;
  this.moved = false;
  this.dir = null;
  this.deathX = null;
  this.body = bodyAt(this.x, this.y);
}

MockCoopEngine.prototype.seatPose = function () {
  return { body: this.body.slice(), alive: this.alive, seated: true };
};

MockCoopEngine.prototype.applyArrowRight = function () {
  if (!this.alive) return;
  this.dir = "RIGHT";
  this.moved = true;
};

MockCoopEngine.prototype.tick = function () {
  if (!this.alive || !this.dir) return this.seatPose();
  const nextX = this.x + 1;
  if (nextX >= this.width) {
    // Border death: head attempted out-of-bounds
    this.alive = false;
    this.deathX = this.x;
    return {
      body: this.body.slice(),
      alive: false,
      seated: true,
      borderDeath: true,
    };
  }
  this.x = nextX;
  this.body = bodyAt(this.x, this.y);
  return { body: this.body.slice(), alive: true, seated: true };
};

describe("coop live dual border death", { timeout: 90000 }, () => {
  let proc;

  before(async () => {
    proc = spawn(EXE, ["--bind", `127.0.0.1:${PORT}`, "--coop-native-relay"], {
      cwd: path.join(ROOT, "server"),
      stdio: "ignore",
    });
    await waitPort(PORT);
  });

  after(() => {
    if (proc) proc.kill();
  });

  it("both survive idle, die on right border after ArrowRight-only, no false dual death from timer", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "P1" });
    const welcomeA = await waitMsg(a.inbox, "WELCOME");
    const room = welcomeA.payload.roomCode;
    const aId = welcomeA.payload.clientId;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "P2" });
    const welcomeB = await waitMsg(b.inbox, "WELCOME");
    const bId = welcomeB.payload.clientId;

    send(a.ws, "MODE_CHANGE", { mode: "coop" });
    await waitMsg(a.inbox, "MODE_CHANGE");
    send(a.ws, "SET_ROLE", { clientId: aId, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: bId, role: "player" });
    await waitRosterWhere(
      a.inbox,
      (r) => r.clients.filter((c) => c.role === "player").length === 2
    );
    send(a.ws, "READY", { ready: true });
    send(b.ws, "READY", { ready: true });
    await waitRosterWhere(a.inbox, (r) => r.allPlayersReady === true);

    a.inbox.length = 0;
    b.inbox.length = 0;
    send(a.ws, "SESSION_START", { settings: {} });
    const startA = await waitMsg(a.inbox, "SESSION_START");
    const startB = await waitMsg(b.inbox, "SESSION_START");
    await waitMsg(a.inbox, "PLAY_SYNC");
    await waitMsg(b.inbox, "PLAY_SYNC");

    assert.equal(startA.payload.mode, "coop");
    assert.equal(startA.payload.authority, "native-relay-v1");
    const generation = startA.payload.generation;
    const slots = startA.payload.slots;
    assert.ok(Array.isArray(slots) && slots.length === 2);
    const seatA = slots.find((s) => s.clientId === aId) || slots[0];
    const seatB = slots.find((s) => s.clientId === bId) || slots[1];

    const engA = new MockCoopEngine(seatA);
    const engB = new MockCoopEngine(seatB);
    const init = await waitMsg(a.inbox, "COOP_BOARD_INIT");
    assert.equal(init.payload.initializerClientId, startA.payload.collectablesOwnerId);

    // Pre-seat death must be ignored by server (warmup guard)
    send(
      a.ws,
      "COOP_PLAYER_DEAD",
      relayPayload(a.ws, generation, {
        body: engA.body,
        reason: "warmup",
      })
    );
    await new Promise((r) => setTimeout(r, 80));
    const earlyEnd = a.inbox
      .concat(b.inbox)
      .filter((m) => m.type === "SESSION_END");
    assert.equal(earlyEnd.length, 0, "pre-seat death must not end match");

    // Seat: living poses with seated:true
    function publish(ws, eng, extra, currentGeneration) {
      const pose = eng.seatPose();
      const head = pose.body[0];
      const previous = eng._lastPublishedHead || head;
      if (previous.x !== head.x || previous.y !== head.y) {
        eng._publishedMoveSeq = (eng._publishedMoveSeq || 0) + 1;
      }
      eng._lastPublishedHead = { x: head.x, y: head.y };
      send(
        ws,
        "SNAKE_DELTA",
        relayPayload(
          ws,
          currentGeneration || generation,
          Object.assign(
            {
              body: pose.body,
              dir: "RIGHT",
              headDir: "RIGHT",
              movementDir: "RIGHT",
              transitionDir:
                previous.x === head.x && previous.y === head.y ? null : "RIGHT",
              fromHead: previous,
              toHead: head,
              moveSeq: eng._publishedMoveSeq || 0,
              turns: [],
              modeKey: "classic",
              seated: true,
              moved: !!eng.moved,
              width: BOARD_W,
              height: BOARD_H,
            },
            extra || {}
          ),
          true
        )
      );
    }

    a.inbox.length = 0;
    b.inbox.length = 0;
    publish(a.ws, engA);
    publish(b.ws, engB);

    const owner =
      startA.payload.collectablesOwnerId === aId ? a : b;
    send(
      owner.ws,
      "COLLECTABLES_DELTA",
      relayPayload(owner.ws, generation, {
        initial: true,
        baseRevision: 0,
        modeKey: "classic",
        collectables: [{ x: 4, y: 4, type: 0 }],
        apples: [{ x: 4, y: 4, type: 0 }],
      })
    );
    const boardReady = await waitMsg(a.inbox, "COOP_BOARD_READY");
    assert.equal(boardReady.payload.revision, 1);

    // Idle ticks — both remain alive (no input)
    for (let i = 0; i < 5; i++) {
      publish(a.ws, engA);
      publish(b.ws, engB);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(engA.alive, true);
    assert.equal(engB.alive, true);

    // First move arms timer — must not ALL_DEAD
    engA.applyArrowRight();
    engB.applyArrowRight();
    const firstA = engA.tick();
    const firstB = engB.tick();
    a.inbox.length = 0;
    b.inbox.length = 0;
    publish(a.ws, engA, { body: firstA.body, moved: true });
    publish(b.ws, engB, { body: firstB.body, moved: true });
    const timerMsg = await waitMsg(b.inbox, "COOP_TIMER_START", 5000);
    assert.ok(timerMsg.payload.timerStartedAtMs);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      a.inbox.concat(b.inbox).filter((m) => m.type === "SESSION_END").length,
      0,
      "timer arm must not end match"
    );

    // Crawl Right until border death
    let ticks = 0;
    const maxTicks = BOARD_W + 5;
    while ((engA.alive || engB.alive) && ticks < maxTicks) {
      ticks++;
      const pa = engA.tick();
      const pb = engB.tick();
      if (pa.alive) {
        publish(a.ws, engA, { body: pa.body, moved: true });
      } else if (pa.borderDeath) {
        send(
          a.ws,
          "COOP_PLAYER_DEAD",
          relayPayload(a.ws, generation, {
            body: pa.body,
            reason: "border",
          })
        );
      }
      if (pb.alive) {
        publish(b.ws, engB, { body: pb.body, moved: true });
      } else if (pb.borderDeath) {
        send(
          b.ws,
          "COOP_PLAYER_DEAD",
          relayPayload(b.ws, generation, {
            body: pb.body,
            reason: "border",
          })
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(engA.alive, false, "P1 should die");
    assert.equal(engB.alive, false, "P2 should die");
    // Death at border: last living head x was width-1
    assert.equal(engA.deathX, BOARD_W - 1, "P1 dies at right edge, not mid-board");
    assert.equal(engB.deathX, BOARD_W - 1, "P2 dies at right edge, not mid-board");
    assert.ok(ticks > 3, "must crawl several cells before border — not instant");

    const end = await waitMsg(a.inbox, "SESSION_END", 5000);
    assert.equal(end.payload.reason, "ALL_DEAD");

    // Second SESSION_START mid-run style reset: start again after lobby ready
    send(a.ws, "READY", { ready: true });
    send(b.ws, "READY", { ready: true });
    await waitRosterWhere(a.inbox, (r) => r.allPlayersReady === true);
    a.inbox.length = 0;
    b.inbox.length = 0;
    send(a.ws, "SESSION_START", { settings: {} });
    const again = await waitMsg(a.inbox, "SESSION_START");
    assert.ok(Array.isArray(again.payload.slots));
    await waitMsg(a.inbox, "PLAY_SYNC");

    // Fresh seat — both alive again
    const engA2 = new MockCoopEngine(again.payload.slots[0]);
    publish(a.ws, engA2, {}, again.payload.generation);
    assert.equal(engA2.alive, true);
    assert.equal(engA2.x, again.payload.slots[0].x | 0);

    a.ws.close();
    b.ws.close();
  });
});
