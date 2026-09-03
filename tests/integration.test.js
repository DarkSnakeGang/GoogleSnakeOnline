"use strict";

/**
 * Spawns Rust server and runs multi-client protocol checks.
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
const PORT = 18777;
const URL = `ws://127.0.0.1:${PORT}/ws`;

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
  ws.send(JSON.stringify({ v: 1, type, payload: payload || {}, seq: Date.now() }));
}

async function waitMsg(inbox, type, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for " + type + " have=" + inbox.map((m) => m.type).join(","));
}

async function waitRosterWhere(inbox, pred, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    while (true) {
      const i = inbox.findIndex((m) => m.type === "ROSTER");
      if (i < 0) break;
      const msg = inbox.splice(i, 1)[0];
      if (pred(msg.payload)) return msg.payload;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for roster predicate");
}

describe("ws integration", { timeout: 60000 }, () => {
  let proc;

  before(async () => {
    proc = spawn(EXE, ["--bind", `127.0.0.1:${PORT}`], {
      cwd: path.join(ROOT, "server"),
      stdio: "ignore",
    });
    await waitPort(PORT);
  });

  after(() => {
    if (proc) proc.kill();
  });

  it("join, promote, ready, start versus", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, roomCode: "", displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;
    const adminId = welcome.payload.clientId;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "P2" });
    const bWelcome = await waitMsg(b.inbox, "WELCOME");
    const bId = bWelcome.payload.clientId;

    send(a.ws, "SET_ROLE", { clientId: adminId, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: bId, role: "player" });
    await waitRosterWhere(
      a.inbox,
      (r) => r.clients.filter((c) => c.role === "player").length === 2
    );

    send(a.ws, "READY", { ready: true });
    send(b.ws, "READY", { ready: true });
    await waitRosterWhere(a.inbox, (r) => r.allPlayersReady === true);

    send(a.ws, "SESSION_START", {});
    const start = await waitMsg(a.inbox, "SESSION_START");
    assert.equal(start.payload.mode, "versus");

    send(b.ws, "SESSION_END", {});
    const denied = await waitMsg(b.inbox, "ERROR");
    assert.match(String(denied.payload.code || denied.payload.message || ""), /not_admin/);

    send(a.ws, "SESSION_END", {});
    const endA = await waitMsg(a.inbox, "SESSION_END");
    const endB = await waitMsg(b.inbox, "SESSION_END");
    assert.equal(endA.payload.reason, "aborted");
    assert.equal(endB.payload.reason, "aborted");

    a.ws.close();
    b.ws.close();
  });

  it("coop color claim Pride", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const id = welcome.payload.clientId;
    send(a.ws, "MODE_CHANGE", { mode: "coop" });
    await waitMsg(a.inbox, "MODE_CHANGE");
    send(a.ws, "SET_ROLE", { clientId: id, role: "player" });
    await waitRosterWhere(a.inbox, (r) =>
      r.clients.some((c) => c.clientId === id && c.role === "player")
    );
    send(a.ws, "COLOR_CLAIM", { colorId: 35 });
    const roster = await waitRosterWhere(a.inbox, (r) => {
      const me = r.clients.find((c) => c.clientId === id);
      return me && me.colorId === 35;
    });
    const me = roster.clients.find((c) => c.clientId === id);
    assert.equal(me.colorName, "Pride");
    a.ws.close();
  });

  it("SETTINGS_SYNC fans out to peers", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "A" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "B" });
    await waitMsg(b.inbox, "WELCOME");

    send(a.ws, "SETTINGS_SYNC", { trophy: 2, count: 1, speed: 0, size: 1 });
    const sync = await waitMsg(b.inbox, "SETTINGS_SYNC");
    assert.equal(sync.payload.trophy, 2);
    assert.equal(sync.payload.size, 1);
    a.ws.close();
    b.ws.close();
  });

  it("coop SESSION_START emits PLAY_SYNC for native co-op", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Host" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const id = welcome.payload.clientId;
    send(a.ws, "MODE_CHANGE", { mode: "coop" });
    await waitMsg(a.inbox, "MODE_CHANGE");
    send(a.ws, "SET_ROLE", { clientId: id, role: "player" });
    await waitRosterWhere(a.inbox, (r) =>
      r.clients.some((c) => c.clientId === id && c.role === "player")
    );
    send(a.ws, "READY", { ready: true });
    await waitRosterWhere(a.inbox, (r) => r.allPlayersReady === true);
    a.inbox.length = 0;
    send(a.ws, "SESSION_START", {
      settings: { trophy: 2, count: 1, speed: 0, size: 0 },
    });
    const start = await waitMsg(a.inbox, "SESSION_START");
    assert.equal(start.payload.mode, "coop");
    assert.ok(Array.isArray(start.payload.slots), "slots on SESSION_START");
    assert.equal(start.payload.slots.length, 1);
    assert.equal(start.payload.slots[0].oy, 0);
    assert.equal(
      start.payload.timerStartedAtMs,
      undefined,
      "timer arms on first move, not SESSION_START"
    );
    assert.equal(start.payload.settings.trophy, 2);
    assert.equal(start.payload.settings.count, 1);
    const play = await waitMsg(a.inbox, "PLAY_SYNC");
    assert.ok(play);
    a.ws.close();
  });

  it("coop arms shared timer on first SNAKE_DELTA timerArm", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Host" });
    const aWelcome = await waitMsg(a.inbox, "WELCOME");
    const aId = aWelcome.payload.clientId;
    const room = aWelcome.payload.roomCode;
    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "Guest" });
    const bId = (await waitMsg(b.inbox, "WELCOME")).payload.clientId;
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
    await waitMsg(a.inbox, "SESSION_START");
    await waitMsg(b.inbox, "SESSION_START");
    const epoch = Date.now();
    send(a.ws, "SNAKE_DELTA", {
      body: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
      alive: true,
      timerArm: true,
      timerStartedAtMs: epoch,
    });
    const timerA = await waitMsg(a.inbox, "COOP_TIMER_START");
    const timerB = await waitMsg(b.inbox, "COOP_TIMER_START");
    assert.equal(timerA.payload.timerStartedAtMs, epoch);
    assert.equal(timerB.payload.timerStartedAtMs, epoch);
    a.ws.close();
    b.ws.close();
  });

  it("coop auto-assigns distinct colors on promote and rejects taken claims", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Host" });
    const aWelcome = await waitMsg(a.inbox, "WELCOME");
    const aId = aWelcome.payload.clientId;
    const room = aWelcome.payload.roomCode;
    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "Guest" });
    const bId = (await waitMsg(b.inbox, "WELCOME")).payload.clientId;
    send(a.ws, "MODE_CHANGE", { mode: "coop" });
    await waitMsg(a.inbox, "MODE_CHANGE");
    send(a.ws, "SET_ROLE", { clientId: aId, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: bId, role: "player" });
    const roster = await waitRosterWhere(
      a.inbox,
      (r) => {
        const players = r.clients.filter((c) => c.role === "player");
        return (
          players.length === 2 &&
          players.every((p) => p.colorId != null) &&
          players[0].colorId !== players[1].colorId
        );
      }
    );
    const colors = roster.clients
      .filter((c) => c.role === "player")
      .map((c) => c.colorId);
    assert.equal(new Set(colors).size, 2, "players must have distinct colors");
    const aColor = roster.clients.find((c) => c.clientId === aId).colorId;
    a.inbox.length = 0;
    send(b.ws, "COLOR_CLAIM", { colorId: aColor });
    const err = await waitMsg(b.inbox, "ERROR");
    assert.equal(err.payload.code, "color_taken");
    a.ws.close();
    b.ws.close();
  });

  it("coop enforces player cap of 4", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Host" });
    const aId = (await waitMsg(a.inbox, "WELCOME")).payload.clientId;
    const room = (await waitMsg(a.inbox, "ROSTER")).payload.roomCode;

    const others = [];
    for (let i = 0; i < 4; i++) {
      const c = await wsClient();
      send(c.ws, "HELLO", {
        create: false,
        roomCode: room,
        displayName: "P" + i,
      });
      const id = (await waitMsg(c.inbox, "WELCOME")).payload.clientId;
      others.push({ c, id });
    }

    send(a.ws, "MODE_CHANGE", { mode: "coop" });
    await waitMsg(a.inbox, "MODE_CHANGE");

    send(a.ws, "SET_ROLE", { clientId: aId, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: others[0].id, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: others[1].id, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: others[2].id, role: "player" });
    await waitRosterWhere(
      a.inbox,
      (r) => r.clients.filter((x) => x.role === "player").length === 4
    );

    a.inbox.length = 0;
    send(a.ws, "SET_ROLE", { clientId: others[3].id, role: "player" });
    const err = await waitMsg(a.inbox, "ERROR");
    assert.equal(err.payload.code, "player_cap");

    a.ws.close();
    others.forEach(({ c }) => c.ws.close());
  });

  it("RESYNC returns roster after join", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Solo" });
    await waitMsg(a.inbox, "WELCOME");
    // drain initial roster
    await waitMsg(a.inbox, "ROSTER");
    send(a.ws, "RESYNC_REQUEST", {});
    const roster = await waitMsg(a.inbox, "ROSTER");
    assert.ok(roster.payload.clients.length >= 1);
    a.ws.close();
  });

  it("SCORE_PULSE fans out to all clients", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;
    const adminId = welcome.payload.clientId;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "P2" });
    const bWelcome = await waitMsg(b.inbox, "WELCOME");
    const bId = bWelcome.payload.clientId;

    const spec = await wsClient();
    send(spec.ws, "HELLO", { create: false, roomCode: room, displayName: "Spec" });
    await waitMsg(spec.inbox, "WELCOME");

    send(a.ws, "SET_ROLE", { clientId: bId, role: "player" });
    await waitRosterWhere(b.inbox, (r) =>
      r.clients.some((c) => c.clientId === bId && c.role === "player")
    );

    send(b.ws, "SCORE_PULSE", { score: 11, timeMs: 2200, alive: true });
    const pulseA = await waitMsg(a.inbox, "SCORE_PULSE");
    const pulseSpec = await waitMsg(spec.inbox, "SCORE_PULSE");
    assert.equal(pulseA.payload.clientId, bId);
    assert.equal(pulseA.payload.score, 11);
    assert.equal(pulseSpec.payload.score, 11);
    assert.ok(pulseA.payload.bestScore >= 11);
    void adminId;
    a.ws.close();
    b.ws.close();
    spec.ws.close();
  });

  it("SET_VERSUS_GOAL tracks Best 25 leader", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "P2" });
    const bWelcome = await waitMsg(b.inbox, "WELCOME");
    const bId = bWelcome.payload.clientId;

    send(a.ws, "SET_ROLE", { clientId: bId, role: "player" });
    await waitRosterWhere(b.inbox, (r) =>
      r.clients.some((c) => c.clientId === bId && c.role === "player")
    );

    send(a.ws, "SET_VERSUS_GOAL", { goal: "best25" });
    const rosterGoal = await waitRosterWhere(
      a.inbox,
      (r) => r.versusGoal === "best25"
    );
    assert.equal(rosterGoal.versusGoalLabel, "Best 25");

    send(b.ws, "SCORE_PULSE", { score: 25, timeMs: 4000, alive: true });
    const pulse = await waitMsg(a.inbox, "SCORE_PULSE");
    assert.equal(pulse.payload.versusGoal, "best25");
    assert.equal(pulse.payload.goalCompleted, true);
    assert.equal(pulse.payload.bestGoalTimeMs, 4000);
    assert.equal(pulse.payload.leaderClientId, bId);

    send(a.ws, "SET_ROLE", { clientId: welcome.payload.clientId, role: "player" });
    await waitRosterWhere(a.inbox, (r) =>
      r.clients.some((c) => c.clientId === welcome.payload.clientId && c.role === "player")
    );
    // Clear b's inbox so we don't pick up b's earlier SCORE_PULSE echo
    b.inbox.length = 0;
    send(a.ws, "SCORE_PULSE", { score: 30, timeMs: 3500, alive: true });
    const pulse2 = await waitMsg(b.inbox, "SCORE_PULSE");
    assert.equal(pulse2.payload.clientId, welcome.payload.clientId);
    assert.equal(pulse2.payload.leaderClientId, welcome.payload.clientId);
    assert.equal(pulse2.payload.bestGoalTimeMs, 3500);

    a.ws.close();
    b.ws.close();
  });

  it("BOARD_DELTA relays to spectators only", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;

    const player = await wsClient();
    send(player.ws, "HELLO", { create: false, roomCode: room, displayName: "P1" });
    const pWelcome = await waitMsg(player.inbox, "WELCOME");
    const pId = pWelcome.payload.clientId;

    const otherPlayer = await wsClient();
    send(otherPlayer.ws, "HELLO", {
      create: false,
      roomCode: room,
      displayName: "P2",
    });
    const opWelcome = await waitMsg(otherPlayer.inbox, "WELCOME");
    const opId = opWelcome.payload.clientId;

    send(a.ws, "SET_ROLE", { clientId: pId, role: "player" });
    send(a.ws, "SET_ROLE", { clientId: opId, role: "player" });
    await waitRosterWhere(
      a.inbox,
      (r) => r.clients.filter((c) => c.role === "player").length === 2
    );

    // clear inboxes
    player.inbox.length = 0;
    otherPlayer.inbox.length = 0;
    a.inbox.length = 0;

    send(player.ws, "BOARD_DELTA", {
      body: [{ x: 1, y: 1 }],
      apples: [{ x: 5, y: 5 }],
      score: 4,
      alive: true,
      width: 17,
      height: 15,
    });

    const boardToSpec = await waitMsg(a.inbox, "BOARD_DELTA");
    assert.equal(boardToSpec.payload.clientId, pId);
    assert.equal(boardToSpec.payload.board.score, 4);

    // Other player should NOT receive board (wait briefly)
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(
      otherPlayer.inbox.filter((m) => m.type === "BOARD_DELTA").length,
      0
    );

    a.ws.close();
    player.ws.close();
    otherPlayer.ws.close();
  });

  it("KICK removes client; target may rejoin as spectator", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "Victim" });
    const bWelcome = await waitMsg(b.inbox, "WELCOME");
    const bId = bWelcome.payload.clientId;

    send(a.ws, "KICK", { clientId: bId });
    const err = await waitMsg(b.inbox, "ERROR");
    assert.equal(err.payload.code, "kicked");

    await waitRosterWhere(
      a.inbox,
      (r) => !r.clients.some((c) => c.clientId === bId)
    );

    // Rejoin same room as new spectator
    const b2 = await wsClient();
    send(b2.ws, "HELLO", { create: false, roomCode: room, displayName: "Victim" });
    const again = await waitMsg(b2.inbox, "WELCOME");
    const roster = await waitRosterWhere(a.inbox, (r) =>
      r.clients.some((c) => c.clientId === again.payload.clientId)
    );
    const rejoined = roster.clients.find(
      (c) => c.clientId === again.payload.clientId
    );
    assert.equal(rejoined.role, "spectator");

    a.ws.close();
    try {
      b.ws.close();
    } catch (e) { /* ignore */ }
    b2.ws.close();
  });

  it("admin succession on disconnect", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;
    const adminId = welcome.payload.clientId;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "Next" });
    const bWelcome = await waitMsg(b.inbox, "WELCOME");
    const bId = bWelcome.payload.clientId;

    await waitRosterWhere(b.inbox, (r) => r.adminId === adminId);
    a.ws.close();

    const roster = await waitRosterWhere(b.inbox, (r) => r.adminId === bId);
    assert.equal(roster.adminId, bId);
    b.ws.close();
  });

  it("rejects 31st connection with room_full", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Host" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;

    const clients = [a];
    for (let i = 0; i < 29; i++) {
      const c = await wsClient();
      send(c.ws, "HELLO", { create: false, roomCode: room, displayName: "C" + i });
      await waitMsg(c.inbox, "WELCOME");
      clients.push(c);
    }

    const overflow = await wsClient();
    send(overflow.ws, "HELLO", {
      create: false,
      roomCode: room,
      displayName: "Overflow",
    });
    const err = await waitMsg(overflow.inbox, "ERROR");
    assert.equal(err.payload.code, "room_full");

    for (const c of clients) c.ws.close();
    overflow.ws.close();
  });

  it("PLAY_SYNC fans out when all ready", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;
    const adminId = welcome.payload.clientId;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "P2" });
    const bWelcome = await waitMsg(b.inbox, "WELCOME");
    const bId = bWelcome.payload.clientId;

    send(a.ws, "SET_ROLE", { clientId: adminId, role: "player" });
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
    send(a.ws, "PLAY_SYNC", {});
    const playB = await waitMsg(b.inbox, "PLAY_SYNC");
    assert.ok(playB);
    a.ws.close();
    b.ws.close();
  });

  it("coop 3 players share SNAKE_DELTA after start", async () => {
    const a = await wsClient();
    send(a.ws, "HELLO", { create: true, displayName: "A" });
    const welcome = await waitMsg(a.inbox, "WELCOME");
    const room = welcome.payload.roomCode;
    const aId = welcome.payload.clientId;

    const b = await wsClient();
    send(b.ws, "HELLO", { create: false, roomCode: room, displayName: "B" });
    const bId = (await waitMsg(b.inbox, "WELCOME")).payload.clientId;

    const c = await wsClient();
    send(c.ws, "HELLO", { create: false, roomCode: room, displayName: "C" });
    const cId = (await waitMsg(c.inbox, "WELCOME")).payload.clientId;

    const spec = await wsClient();
    send(spec.ws, "HELLO", { create: false, roomCode: room, displayName: "Spec" });
    await waitMsg(spec.inbox, "WELCOME");

    send(a.ws, "MODE_CHANGE", { mode: "coop" });
    await waitMsg(a.inbox, "MODE_CHANGE");
    for (const id of [aId, bId, cId]) {
      send(a.ws, "SET_ROLE", { clientId: id, role: "player" });
    }
    await waitRosterWhere(
      a.inbox,
      (r) => r.clients.filter((x) => x.role === "player").length === 3
    );

    send(a.ws, "COLOR_CLAIM", { colorId: 0 });
    send(b.ws, "COLOR_CLAIM", { colorId: 1 });
    send(c.ws, "COLOR_CLAIM", { colorId: 2 });
    send(a.ws, "READY", { ready: true });
    send(b.ws, "READY", { ready: true });
    send(c.ws, "READY", { ready: true });
    await waitRosterWhere(a.inbox, (r) => r.allPlayersReady === true);

    send(a.ws, "SESSION_START", {});
    const startSpec = await waitMsg(spec.inbox, "SESSION_START");
    assert.ok(Array.isArray(startSpec.payload.slots));
    assert.equal(startSpec.payload.slots.length, 3);
    const oys = startSpec.payload.slots.map((s) => s.oy).sort((x, y) => x - y);
    assert.deepEqual(oys, [-2, 0, 3]);
    await waitMsg(spec.inbox, "PLAY_SYNC");

    spec.inbox.length = 0;
    send(a.ws, "SNAKE_DELTA", {
      body: [{ x: 1, y: 1 }],
      alive: true,
      width: 17,
      height: 15,
      colorId: 0,
    });
    const delta = await waitMsg(spec.inbox, "SNAKE_DELTA", 8000);
    assert.equal(delta.payload.clientId, aId);
    assert.ok(Array.isArray(delta.payload.body));
    assert.equal(delta.payload.alive, true);

    // Any player (not only admin/owner) may publish fruit after native eat
    b.inbox.length = 0;
    c.inbox.length = 0;
    spec.inbox.length = 0;
    send(b.ws, "COLLECTABLES_DELTA", {
      apples: [
        { x: 4, y: 4 },
        { x: 9, y: 9 },
      ],
      width: 17,
      height: 15,
    });
    const fruit = await waitMsg(spec.inbox, "COLLECTABLES_DELTA", 8000);
    assert.equal(fruit.payload.clientId, bId);
    assert.equal(fruit.payload.apples.length, 2);

    // End match then late pose — server must not ERROR(not_coop_session)
    send(a.ws, "SESSION_END", { reason: "ALL_DEAD" });
    await waitMsg(a.inbox, "SESSION_END");
    a.inbox.length = 0;
    b.inbox.length = 0;
    send(a.ws, "SNAKE_DELTA", {
      body: [{ x: 2, y: 2 }],
      alive: false,
    });
    send(b.ws, "COLLECTABLES_DELTA", { apples: [{ x: 1, y: 1 }] });
    await new Promise(function (r) {
      setTimeout(r, 120);
    });
    const lateErrs = a.inbox
      .concat(b.inbox)
      .filter(function (m) {
        return (
          m.type === "ERROR" &&
          m.payload &&
          (m.payload.code === "not_coop_session" ||
            m.payload.message === "not_coop_session")
        );
      });
    assert.equal(lateErrs.length, 0, "late co-op packets must be silent");

    a.ws.close();
    b.ws.close();
    c.ws.close();
    spec.ws.close();
  });

  it("versus: non-admin spectator receives admin BOARD_DELTA", async () => {
    const admin = await wsClient();
    send(admin.ws, "HELLO", { create: true, displayName: "Admin" });
    const welcome = await waitMsg(admin.inbox, "WELCOME");
    const adminId = welcome.payload.clientId;
    const room = welcome.payload.roomCode;

    const spec = await wsClient();
    send(spec.ws, "HELLO", {
      create: false,
      roomCode: room,
      displayName: "Spec",
    });
    await waitMsg(spec.inbox, "WELCOME");

    send(admin.ws, "MODE_CHANGE", { mode: "versus" });
    await waitMsg(admin.inbox, "MODE_CHANGE");
    send(admin.ws, "SET_ROLE", { clientId: adminId, role: "player" });
    await waitRosterWhere(admin.inbox, (r) =>
      r.clients.some((c) => c.clientId === adminId && c.role === "player")
    );
    send(admin.ws, "READY", { ready: true });
    await waitRosterWhere(admin.inbox, (r) => r.allPlayersReady === true);

    admin.inbox.length = 0;
    spec.inbox.length = 0;
    send(admin.ws, "SESSION_START", {});
    await waitMsg(admin.inbox, "SESSION_START");
    await waitMsg(spec.inbox, "SESSION_START");

    send(spec.ws, "SPECTATE_FOCUS", { clientId: adminId });
    await waitMsg(spec.inbox, "SPECTATE_FOCUS");

    spec.inbox.length = 0;
    send(admin.ws, "BOARD_DELTA", {
      body: [
        { x: 7, y: 7 },
        { x: 6, y: 7 },
        { x: 5, y: 7 },
      ],
      apples: [{ x: 2, y: 2 }],
      dir: "RIGHT",
      score: 3,
      alive: true,
      sizeIndex: 0,
      countIndex: 1,
    });
    const delta = await waitMsg(spec.inbox, "BOARD_DELTA", 5000);
    assert.equal(delta.payload.clientId, adminId);
    assert.ok(delta.payload.board);
    assert.equal(delta.payload.board.body[0].x, 7);
    assert.equal(delta.payload.board.apples.length, 1);
    // Admin (player) must not receive their own BOARD_DELTA relay
    const adminGot = admin.inbox.filter((m) => m.type === "BOARD_DELTA");
    assert.equal(adminGot.length, 0);

    admin.ws.close();
    spec.ws.close();
  });
});
