"use strict";

/**
 * Headed live race you can watch from the console Spectate panel.
 * Loads the mod like duckdns-connect-live.js, creates a room, switches to Race,
 * sets Count = Bomb, readies, starts the match, then a greedy BFS bot chases
 * apples with real arrow-key presses.
 *
 *   node tools/race-bomb-live.js
 *   node tools/race-bomb-live.js --seconds=20 --count=5
 *   node tools/race-bomb-live.js --players=3        # one window per bot, fills the mosaic
 *   node tools/race-bomb-live.js --minutes=1 --seconds=62 --linger=20   # short round: time-up, then winner
 *   MP_WS_URL=wss://host:7777/ws node tools/race-bomb-live.js
 */
const path = require("path");
const fs = require("fs");
const { loadModFromUrl, connect, FAKE_MOD_ORIGIN } = require("./duckdns-connect-live");

const ROOT = path.join(__dirname, "..");
const WS_URL = process.env.MP_WS_URL || "wss://yarmiplay.duckdns.org:7777/ws";
function argValue(name, d) {
  const hit = process.argv.find(function (a) { return a.indexOf(name + "=") === 0; });
  return hit ? hit.slice(name.length + 1) : d;
}
const SECONDS = Number(argValue("--seconds", "10")) || 10;
const COUNT_BOMB = 5;
const COUNT = Number(argValue("--count", String(COUNT_BOMB)));
const PLAYERS = Math.max(1, Math.min(8, Number(argValue("--players", "1")) || 1));
const MINUTES = Math.max(0, Number(argValue("--minutes", "0")) || 0);
const LINGER = Math.max(0, Number(argValue("--linger", "2")) || 0);

const DIRS = {
  UP: { dx: 0, dy: -1, key: "ArrowUp", back: "DOWN" },
  DOWN: { dx: 0, dy: 1, key: "ArrowDown", back: "UP" },
  LEFT: { dx: -1, dy: 0, key: "ArrowLeft", back: "RIGHT" },
  RIGHT: { dx: 1, dy: 0, key: "ArrowRight", back: "LEFT" },
};

function log() {
  console.log.apply(console, ["[race-bomb]"].concat(Array.from(arguments)));
}

async function waitFor(page, fn, arg, label, timeout) {
  try {
    await page.waitForFunction(fn, arg, { timeout: timeout || 20000, polling: 100 });
  } catch (e) {
    throw new Error("timed out waiting for " + label);
  }
}

/** Cells reachable from (x,y) without crossing `blocked`. */
function floodSize(start, blocked, w, h, cap) {
  const seen = new Set([start.x + "," + start.y]);
  const queue = [start];
  while (queue.length && seen.size < cap) {
    const c = queue.shift();
    for (const d of Object.values(DIRS)) {
      const nx = c.x + d.dx;
      const ny = c.y + d.dy;
      const k = nx + "," + ny;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen.size;
}

/** First step of the shortest safe path to any apple, else the roomiest move. */
function chooseDir(board) {
  const { body, apples, width: w, height: h, dir } = board;
  const head = body[0];
  const blocked = new Set(body.slice(0, -1).map(function (p) { return p.x + "," + p.y; }));
  const goals = new Set(apples.map(function (a) { return a.x + "," + a.y; }));
  const back = DIRS[dir] ? DIRS[dir].back : null;

  const firstMoves = [];
  for (const [name, d] of Object.entries(DIRS)) {
    if (name === back && body.length > 1) continue;
    const nx = head.x + d.dx;
    const ny = head.y + d.dy;
    const k = nx + "," + ny;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h || blocked.has(k)) continue;
    const room = floodSize({ x: nx, y: ny }, blocked, w, h, body.length + 2);
    firstMoves.push({ name, x: nx, y: ny, room });
  }
  if (!firstMoves.length) return dir || "UP";
  const roomy = firstMoves.filter(function (m) { return m.room > body.length; });
  const pool = roomy.length ? roomy : firstMoves;

  const seen = new Set([head.x + "," + head.y]);
  const queue = pool.map(function (m) {
    seen.add(m.x + "," + m.y);
    return { x: m.x, y: m.y, first: m.name };
  });
  while (queue.length) {
    const c = queue.shift();
    if (goals.has(c.x + "," + c.y)) return c.first;
    for (const d of Object.values(DIRS)) {
      const nx = c.x + d.dx;
      const ny = c.y + d.dy;
      const k = nx + "," + ny;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny, first: c.first });
    }
  }
  pool.sort(function (a, b) { return b.room - a.room; });
  return pool[0].name;
}

function readBoard(page) {
  return page.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const b = Gsm && Gsm.scrapeBoard && Gsm.scrapeBoard();
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const s = Gsm && Gsm.readScoreAndAlive ? Gsm.readScoreAndAlive() : {};
    if (!b || !b.body || !b.body.length) return null;
    return {
      body: b.body.map(function (p) { return { x: p.x | 0, y: p.y | 0 }; }),
      apples: (b.apples || []).map(function (a) {
        const p = a.pos || a;
        return { x: p.x | 0, y: p.y | 0 };
      }),
      width: b.width | 0,
      height: b.height | 0,
      dir: (g && g.oa && g.oa.direction) || "NONE",
      score: s.score | 0,
      alive: s.alive !== false,
      live: !!(Gsm.isNativeRunLive && Gsm.isNativeRunLive()),
    };
  });
}

async function waitJoined(page) {
  await waitFor(page, function () {
    const c = window.__multiplayerApp.client;
    return !!(c && c.joined && c.roster && c.me && c.me());
  }, null, "roster after join");
  return page.evaluate(function () {
    const c = window.__multiplayerApp.client;
    return { code: c.roomCode, id: c.me().clientId };
  });
}

async function readyUp(page) {
  await page.evaluate(function () {
    const app = window.__multiplayerApp;
    const me = app.client.me();
    if (me.ready) return;
    if (app._shouldUseShuffleAsReady && app._shouldUseShuffleAsReady()) {
      app._toggleReadyFromShuffle();
    } else {
      app.client.setReady(true);
    }
  });
  await waitFor(page, function () {
    const me = window.__multiplayerApp.client.me();
    return me && me.ready;
  }, null, "ready");
}

/** Admin page: Race mode, everyone seated as a player, Count stamped. */
async function setupRace(page, playerIds) {
  await page.evaluate(function () {
    const c = window.__multiplayerApp.client;
    if (c.roster.mode !== "race") c.setMode("race");
  });
  await waitFor(page, function () {
    return window.__multiplayerApp.client.roster.mode === "race";
  }, null, "race mode");

  await page.evaluate(function (ids) {
    const c = window.__multiplayerApp.client;
    ids.forEach(function (id) {
      const p = c.roster.clients.find(function (x) { return x.clientId === id; });
      if (!p || p.role !== "player") c.setRole(id, "player");
    });
  }, playerIds);
  await waitFor(page, function (ids) {
    const r = window.__multiplayerApp.client.roster;
    return ids.every(function (id) {
      return r.clients.some(function (x) { return x.clientId === id && x.role === "player"; });
    });
  }, playerIds, "player roles");

  // Menu reads lag until Play bakes, so stamp count the way the other live tools do.
  await page.evaluate(function (count) {
    const app = window.__multiplayerApp;
    const Gsm = window.MultiplayerGsm;
    if (typeof window.puddingMenuSelect === "function") window.puddingMenuSelect("count", count);
    const row = document.getElementById("count");
    if (row && row.children[count]) row.children[count].click();
    const orig = app.syncMySettingsAsAdmin ? app.syncMySettingsAsAdmin.bind(app) : null;
    app.syncMySettingsAsAdmin = function () {
      return Object.assign({}, (orig && orig()) || {}, { count: count });
    };
    if (Gsm.forceMatchSettingsForPlay) Gsm.forceMatchSettingsForPlay({ count: count });
    window.__mpMatchPlaySettings = Object.assign({}, window.__mpMatchPlaySettings || {}, { count: count });
  }, COUNT);
  log("count setting =", COUNT, COUNT === COUNT_BOMB ? "(Bomb)" : "");
}

async function startRace(admin, pages) {
  await waitFor(admin, function () {
    return window.__multiplayerApp.client.roster.allPlayersReady === true;
  }, null, "all players ready");
  log("all ready — starting race");
  // Same tick as Start: the settings panel re-renders #mp-duration from the roster.
  await admin.evaluate(function (mins) {
    if (mins) {
      localStorage.setItem("MULTIPLAYER_RACE_ATTEMPT_MIN", String(mins));
      const el = document.getElementById("mp-duration");
      if (el) el.value = String(mins);
    }
    window.__multiplayerApp.startMatchAsAdmin();
  }, MINUTES);
  await waitFor(admin, function () {
    const r = window.__multiplayerApp.client.roster;
    return r && r.sessionActive;
  }, null, "session start");
  await Promise.all(pages.map(function (page) {
    return waitFor(page, function () {
      const Gsm = window.MultiplayerGsm;
      return !!(Gsm.isNativeRunLive && Gsm.isNativeRunLive());
    }, null, "native run live", 30000);
  }));
  const started = await admin.evaluate(function () {
    const app = window.__multiplayerApp;
    const Gsm = window.MultiplayerGsm;
    const b = Gsm.scrapeBoard && Gsm.scrapeBoard();
    return {
      matchCount: app._matchSettings && app._matchSettings.count,
      menuCount: Gsm.readSettingIndex("count"),
      apples: b && b.apples ? b.apples.length : null,
      size: b ? b.width + "x" + b.height : null,
    };
  });
  log("match started:", JSON.stringify(started));
}

async function drive(page, name) {
  await page.mouse.click(450, 450).catch(function () {});
  const until = Date.now() + SECONDS * 1000;
  let lastHeadKey = "";
  let presses = 0;
  let best = 0;
  let deaths = 0;
  let wasAlive = true;
  while (Date.now() < until) {
    const b = await readBoard(page).catch(function () { return null; });
    if (!b) {
      await page.waitForTimeout(30);
      continue;
    }
    best = Math.max(best, b.score);
    if (!b.alive || !b.live) {
      if (wasAlive) {
        deaths += 1;
        log(name, "died at score", b.score, "— restarting");
      }
      wasAlive = false;
      await page.keyboard.press("Space").catch(function () {});
      await page.waitForTimeout(250);
      continue;
    }
    wasAlive = true;
    const headKey = b.body[0].x + "," + b.body[0].y + "," + b.dir;
    if (headKey !== lastHeadKey) {
      const want = chooseDir(b);
      if (want !== b.dir) {
        await page.keyboard.press(DIRS[want].key);
        presses += 1;
      }
      lastHeadKey = headKey;
    }
    await page.waitForTimeout(15);
  }
  return { presses, best, deaths };
}

async function main() {
  const modSource = fs.readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8");
  const m = modSource.slice(0, 400).match(/window\.__MP_MOD_BUILT="([^"]+)"/);
  if (!m) throw new Error("rebuild MultiplayerMod.js");
  const built = m[1];
  const modUrl = FAKE_MOD_ORIGIN + "/MultiplayerMod.js?t=" + encodeURIComponent(built);

  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: false,
    // Each bot gets its own window; keep covered windows ticking at full speed.
    args: [
      "--mute-audio",
      "--window-size=960,900",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });
  const names = [];
  for (let i = 0; i < PLAYERS; i++) names.push(i === 0 ? "race-bot" : "race-bot-" + (i + 1));
  const pages = [];
  try {
    for (let i = 0; i < PLAYERS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 820 } });
      const page = await ctx.newPage();
      page.on("pageerror", function (e) { log(names[i], "pageerror", e && e.message); });
      pages.push({ ctx, page });
    }
    await Promise.all(pages.map(function (p) {
      return loadModFromUrl(p.ctx, p.page, modUrl, built, modSource);
    }));
    log("mod loaded", built, "in", PLAYERS, "window(s)");

    const admin = pages[0].page;
    const res = await connect(admin, WS_URL, names[0], "");
    if (!res.client || !res.client.joined) throw new Error("connect failed: " + res.status);
    const first = await waitJoined(admin);
    log("room", first.code, "— open the console Spectate panel now");
    const ids = [first.id];
    for (let i = 1; i < PLAYERS; i++) {
      const r = await connect(pages[i].page, WS_URL, names[i], first.code);
      if (!r.client || !r.client.joined) throw new Error(names[i] + " connect failed: " + r.status);
      ids.push((await waitJoined(pages[i].page)).id);
    }
    await setupRace(admin, ids);
    for (const p of pages) await readyUp(p.page);
    await startRace(admin, pages.map(function (p) { return p.page; }));
    log("race live in", first.code, "—", PLAYERS, "bot(s) driving for", SECONDS + "s");
    const results = await Promise.all(pages.map(function (p, i) { return drive(p.page, names[i]); }));
    results.forEach(function (r, i) {
      log(names[i] + ": best score", r.best, "· key presses", r.presses, "· deaths", r.deaths);
    });
    if (LINGER > 2) log("bots stopped steering — keeping the room open", LINGER + "s");
    await admin.waitForTimeout(LINGER * 1000);
  } finally {
    await browser.close();
  }
}

main().catch(function (e) {
  console.error("[race-bomb] FAILED:", e && e.message);
  process.exit(1);
});
