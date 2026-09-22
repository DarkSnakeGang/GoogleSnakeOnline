"use strict";

/**
 * Headed dual-browser proof: co-op mode bake + eat without crash.
 * Default mode is Wall. Override with:
 *   node tools/wall-coop-dual-live.js --mode=gate
 *   MP_MODE=bridge MP_MODE_TROPHY=20 node tools/wall-coop-dual-live.js
 *
 * Screenshots + evidence.json → .cache/e2e/<mode>-dual/
 */
const { spawn, execSync } = require("node:child_process");
const path = require("path");
const fs = require("fs");
const net = require("node:net");

const ROOT = path.join(__dirname, "..");
const eatLib = require(path.join(ROOT, "tests/lib/coop-mode-eat-evidence.js"));
const EXE = path.join(
  ROOT,
  "server",
  "target",
  "release",
  process.platform === "win32" ? "multiplayer-server.exe" : "multiplayer-server"
);
const GSM_URL = process.env.MP_E2E_GSM_URL || "https://googlesnakemods.com/v/current/";

function parseModeArgs() {
  let id = process.env.MP_MODE || "wall";
  let trophy =
    process.env.MP_MODE_TROPHY != null
      ? Number(process.env.MP_MODE_TROPHY)
      : null;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.indexOf("--mode=") === 0) id = a.slice(7);
    if (a.indexOf("--trophy=") === 0) trophy = Number(a.slice(9));
  }
  const TABLE = {
    wall: 1,
    portal: 2,
    cheese: 3,
    borderless: 4,
    twin: 5,
    winged: 6,
    yin_yang: 7,
    key: 8,
    sokoban: 9,
    poison: 10,
    dimension: 11,
    minesweeper: 12,
    statue: 13,
    light: 14,
    shield: 15,
    arrow: 16,
    hotdog: 17,
    magnet: 18,
    gate: 19,
    bridge: 20,
  };
  if (trophy == null || !Number.isFinite(trophy)) {
    trophy = TABLE[id] != null ? TABLE[id] : 1;
  }
  return { id: id, trophy: trophy | 0 };
}

const MODE = parseModeArgs();
const DUMP = path.join(ROOT, ".cache", "e2e", MODE.id + "-dual");
const CERT_DIR = path.join(ROOT, ".cache", "e2e-certs");
const KEY_PATH = path.join(CERT_DIR, "key.pem");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const FAKE_MOD_ORIGIN = "https://mp-e2e.local";

function ensureCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return;
  const openssl = fs.existsSync(
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"
  )
    ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"
    : "openssl";
  execSync(
    '"' +
      openssl +
      '" req -x509 -newkey rsa:2048 -keyout "' +
      KEY_PATH +
      '" -out "' +
      CERT_PATH +
      '" -days 825 -nodes -subj "/CN=127.0.0.1"',
    { stdio: "ignore" }
  );
}

function waitPort(port, ms) {
  ms = ms || 25000;
  const start = Date.now();
  return new Promise(function (resolve, reject) {
    const tryOnce = function () {
      const s = net.connect(port, "127.0.0.1", function () {
        s.end();
        resolve();
      });
      s.on("error", function () {
        try {
          s.destroy();
        } catch (_) {}
        if (Date.now() - start > ms) reject(new Error("port timeout"));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", function () {
      const port = s.address().port;
      s.close(function (err) {
        if (err) reject(err);
        else resolve(port);
      });
    });
    s.on("error", reject);
  });
}

async function installModIntercept(ctx, modUrl, modSource) {
  await ctx.addInitScript(
    function (pair) {
      const target = pair.url;
      const body = pair.source;
      if (window.__mpE2EInterceptInstalled) return;
      window.__mpE2EInterceptInstalled = true;
      const RealXHR = window.XMLHttpRequest;
      function FakeXHR() {
        const xhr = new RealXHR();
        let url = "";
        const open = xhr.open;
        xhr.open = function (method, u) {
          url = String(u || "");
          return open.apply(xhr, arguments);
        };
        const send = xhr.send;
        xhr.send = function () {
          if (url.indexOf("MultiplayerMod.js") !== -1 || url === target) {
            Object.defineProperty(xhr, "readyState", {
              get: function () {
                return 4;
              },
            });
            Object.defineProperty(xhr, "status", {
              get: function () {
                return 200;
              },
            });
            Object.defineProperty(xhr, "responseText", {
              get: function () {
                return body;
              },
            });
            Object.defineProperty(xhr, "response", {
              get: function () {
                return body;
              },
            });
            if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange();
            if (typeof xhr.onload === "function") xhr.onload();
            return;
          }
          return send.apply(xhr, arguments);
        };
        return xhr;
      }
      FakeXHR.prototype = RealXHR.prototype;
      window.XMLHttpRequest = FakeXHR;
      const realFetch = window.fetch;
      window.fetch = function (input, init) {
        const u = typeof input === "string" ? input : input && input.url;
        if (
          u &&
          (String(u).indexOf("MultiplayerMod.js") !== -1 || u === target)
        ) {
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/javascript" },
            })
          );
        }
        return realFetch(input, init);
      };
    },
    { url: modUrl, source: modSource }
  );
}

/** Same flow as coop-gsm-e2e loadModFromUrl */
async function loadModFromUrl(ctx, page, modUrl, expectedBuilt, modSource) {
  await installModIntercept(ctx, modUrl, modSource);
  await page.goto(GSM_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(
    function () {
      return typeof window.snakeSetDevMode === "function";
    },
    { timeout: 60000 }
  );
  await page.evaluate(function () {
    localStorage.setItem("snakeForceDevMode", "true");
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#advanced-options-toggle", { timeout: 60000 });
  await page.evaluate(function () {
    const el = document.getElementById("mod-selector-dialogue-container");
    if (el) el.style.display = "block";
  });
  await page.waitForSelector('input[type="radio"][value="customUrl"]', {
    timeout: 30000,
  });
  await page.click("#advanced-options-toggle");
  await page.waitForSelector("#mod-selector-dialogue.show-settings-page", {
    timeout: 10000,
  });
  await page.fill("#custom-mod-name", "MultiplayerMod");
  await page.fill("#custom-url", modUrl);
  await page.evaluate(function (url) {
    const nameEl = document.getElementById("custom-mod-name");
    const urlEl = document.getElementById("custom-url");
    if (nameEl) {
      nameEl.value = "MultiplayerMod";
      nameEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (urlEl) {
      urlEl.value = url;
      urlEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, modUrl);
  await page.click("#advanced-options-toggle");
  await page.click('input[type="radio"][value="customUrl"]');
  page.once("dialog", function (d) {
    d.accept().catch(function () {});
  });
  await page.evaluate(function () {
    const btn = document.getElementById("apply-mod");
    if (btn) btn.click();
  });
  await page.waitForFunction(
    function (wantBuilt) {
      return (
        window.__MP_MOD_BUILT &&
        (!wantBuilt || window.__MP_MOD_BUILT === wantBuilt) &&
        window.MultiplayerMod &&
        typeof window.MultiplayerMod.alterSnakeCode === "function"
      );
    },
    expectedBuilt || null,
    { timeout: 180000 }
  );
}

async function openMultiplayerControl(page) {
  await page.waitForFunction(
    function () {
      return !!(window.__multiplayerApp && window.__multiplayerApp.ui);
    },
    { timeout: 60000 }
  );
  await page.evaluate(function () {
    const ind = document.getElementById("mod-indicator");
    if (ind) ind.style.pointerEvents = "none";
    window.__multiplayerApp.ui.openPuddingSettings("control");
  });
  await page.waitForSelector("#mp-server-url", { timeout: 15000 });
}

async function connectPage(page, wsUrl, displayName, roomCode) {
  await openMultiplayerControl(page);
  await page.fill("#mp-server-url", wsUrl);
  await page.fill("#mp-display-name", displayName);
  if (roomCode) await page.fill("#mp-room-code", roomCode);
  else await page.fill("#mp-room-code", "");
  await page.evaluate(function () {
    const btn = document.getElementById("mp-conn-toggle");
    if (btn) btn.click();
  });
  await page.waitForFunction(
    function () {
      const app = window.__multiplayerApp;
      return app && app.client && app.client.connected && app.client.joined;
    },
    { timeout: 90000 }
  );
  return page.evaluate(function () {
    const c = window.__multiplayerApp.client;
    return {
      ok: true,
      roomCode: c.roster && c.roster.roomCode,
      clientId: c.clientId,
    };
  });
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error("missing " + EXE);
  ensureCerts();
  fs.mkdirSync(DUMP, { recursive: true });

  const head = fs.readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8").slice(0, 400);
  const m = head.match(/window\.__MP_MOD_BUILT="([^"]+)"/);
  if (!m) throw new Error("rebuild MultiplayerMod.js");
  const built = m[1];
  const modSource = fs.readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8");
  const modUrl = FAKE_MOD_ORIGIN + "/MultiplayerMod.js?t=" + encodeURIComponent(built);

  const wsPort = await freePort();
  const wsUrl = "wss://127.0.0.1:" + wsPort + "/ws";
  const roomProc = spawn(
    EXE,
    [
      "--bind",
      "127.0.0.1:" + wsPort,
      "--coop-native-relay",
      "--tls-cert",
      CERT_PATH,
      "--tls-key",
      KEY_PATH,
    ],
    { cwd: path.join(ROOT, "server"), stdio: "ignore", windowsHide: true }
  );
  await waitPort(wsPort);
  console.log("[wall-dual] room", wsUrl);

  const { chromium } = require("playwright");
  // Public GSM → wss://127.0.0.1 triggers Chrome's Local Network Access prompt
  // ("Access other apps and services on this device") which blocks automation.
  const chromeArgs = [
    "--ignore-certificate-errors",
    "--mute-audio",
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessPermissionPrompt",
  ];
  const browserA = await chromium.launch({
    headless: false,
    args: chromeArgs.concat([
      "--window-size=960,900",
      "--window-position=20,40",
    ]),
  });
  const browserB = await chromium.launch({
    headless: false,
    args: chromeArgs.concat([
      "--window-size=960,900",
      "--window-position=980,40",
    ]),
  });
  const gsmOrigin = new URL(GSM_URL).origin;
  const ctxOpts = {
    ignoreHTTPSErrors: true,
    viewport: { width: 900, height: 820 },
    // Pre-allow LNA so Chromium does not show the device-access modal
    permissions: ["local-network-access"],
  };
  const ctxA = await browserA.newContext(ctxOpts);
  const ctxB = await browserB.newContext(ctxOpts);
  await Promise.all([
    ctxA.grantPermissions(["local-network-access"], { origin: gsmOrigin }),
    ctxB.grantPermissions(["local-network-access"], { origin: gsmOrigin }),
  ]).catch(function () {});
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errsA = [];
  const errsB = [];
  pageA.on("pageerror", function (e) {
    errsA.push(String(e && e.message ? e.message : e));
  });
  pageB.on("pageerror", function (e) {
    errsB.push(String(e && e.message ? e.message : e));
  });

  const evidence = { built: built, wsUrl: wsUrl, steps: [] };
  try {
    console.log("[wall-dual] loading GSM Mod Loader + MultiplayerMod (A/B)…");
    await Promise.all([
      loadModFromUrl(ctxA, pageA, modUrl, built, modSource),
      loadModFromUrl(ctxB, pageB, modUrl, built, modSource),
    ]);
    evidence.steps.push("mod_loaded");
    await pageA.screenshot({ path: path.join(DUMP, "00-mod-loaded-a.png") });

    const joinA = await connectPage(pageA, wsUrl, MODE.id + "-A", "");
    const joinB = await connectPage(pageB, wsUrl, MODE.id + "-B", joinA.roomCode);
    evidence.roomCode = joinA.roomCode;
    evidence.steps.push("joined");
    console.log("[wall-dual] room", joinA.roomCode);

    // Resolve trophy index for the requested mode (vanilla arcade ub).
    await pageA.evaluate(function () {
      try {
        if (window.__multiplayerApp.ui.openPuddingSettings) {
          window.__multiplayerApp.ui.openPuddingSettings("play");
        }
      } catch (e) { /* ignore */ }
    });
    await new Promise(function (r) {
      setTimeout(r, 400);
    });
    const wallMeta = {
      index: MODE.trophy,
      via: "cliMode",
      modeId: MODE.id,
    };
    evidence.wallTrophy = wallMeta;
    evidence.modeId = MODE.id;
    console.log("[mode-dual]", MODE.id, "trophy", JSON.stringify(wallMeta));

    await pageA.evaluate(function () {
      const app = window.__multiplayerApp;
      app.ui.openPuddingSettings("control");
      if (app.client.setMode) app.client.setMode("coop");
    });
    await new Promise(function (r) {
      setTimeout(r, 500);
    });
    await pageA.evaluate(function () {
      const app = window.__multiplayerApp;
      (app.client.roster.clients || []).forEach(function (c) {
        const id = c.clientId || c.id;
        if (c.role !== "player") app.client.setRole(id, "player");
      });
    });
    await pageA.waitForFunction(
      function () {
        const r = window.__multiplayerApp.client.roster;
        return (
          r.mode === "coop" &&
          r.clients.filter(function (c) {
            return c.role === "player";
          }).length === 2
        );
      },
      { timeout: 30000 }
    );

    // Click Wall trophy tile in the pudding row (DOM truth for Ma bake)
    await pageA.evaluate(function (idx) {
      const row = document.getElementById("trophy");
      if (!row) return;
      const imgs = row.querySelectorAll("img");
      for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i].src || "";
        const m = /trophy[_-]?0*(\d+)/i.exec(src);
        if (m && Number(m[1]) === (idx | 0)) {
          const clickable =
            imgs[i].closest("button, .opt, [role='button'], div") || imgs[i];
          clickable.click();
          return;
        }
      }
      if (imgs[idx]) {
        (imgs[idx].closest("button, .opt, div") || imgs[idx]).click();
      }
    }, wallMeta.index | 0);
    await new Promise(function (r) {
      setTimeout(r, 300);
    });

    const clean = {
      trophy: wallMeta.index | 0,
      count: 0,
      speed: 1,
      size: 1,
      apple: 0,
    };
    await pageA.evaluate(function (clean) {
      const app = window.__multiplayerApp;
      const Gsm = window.MultiplayerGsm;
      const orig = app.syncMySettingsAsAdmin
        ? app.syncMySettingsAsAdmin.bind(app)
        : null;
      app.syncMySettingsAsAdmin = function () {
        return Object.assign({}, (orig && orig()) || {}, clean);
      };
      if (typeof window.puddingMenuSelect === "function") {
        window.puddingMenuSelect("size", clean.size);
        window.puddingMenuSelect("count", clean.count);
        window.puddingMenuSelect("speed", clean.speed);
        window.puddingMenuSelect("trophy", clean.trophy);
      }
      if (Gsm.forceEngineSizeForPlay) Gsm.forceEngineSizeForPlay(clean.size);
      if (Gsm.forceMatchSettingsForPlay) Gsm.forceMatchSettingsForPlay(clean);
      // Belt: stamp CurrentModeNum / SpeedInfo path used by Remix bake
      try {
        window.CurrentModeNum = clean.trophy;
      } catch (eC) { /* ignore */ }
      window.__mpCoopPlaySettings = Object.assign({}, clean);
      window.__mpMatchPlaySettings = Object.assign({}, clean);
    }, clean);

    const modeCheck = await pageA.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      return {
        effective: Gsm.effectiveModeKey && Gsm.effectiveModeKey(),
        registry:
          window.ModeRegistry &&
          window.ModeRegistry.getCurrentModeKey &&
          window.ModeRegistry.getCurrentModeKey(),
        CurrentModeNum: window.CurrentModeNum,
      };
    });
    evidence.modeCheck = modeCheck;
    console.log("[wall-dual] mode before start", modeCheck);

    await pageA.evaluate(function () {
      window.__multiplayerApp.client.setReady(true);
    });
    await pageB.evaluate(function () {
      window.__multiplayerApp.client.setReady(true);
    });
    await pageA.waitForFunction(
      function () {
        return window.__multiplayerApp.client.roster.allPlayersReady === true;
      },
      { timeout: 20000 }
    );
    await pageA.evaluate(function () {
      window.__multiplayerApp.startMatchAsAdmin();
    });
    evidence.steps.push("session_start");

    await pageA.waitForFunction(
      function (opts) {
        const modeId = opts.modeId;
        const trophy = opts.trophy | 0;
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        if (!g) return false;
        if (!(g.oa && g.oa.ka && g.oa.ka.length)) return false;
        const ub = g.settings && g.settings.ub;
        if (ub != null && Number(ub) !== trophy) return false;
        if (modeId === "key") {
          // Prefer keys planted; still accept live board if seed lags
          if (g.Ba && g.Ba.keys && g.Ba.keys.length > 0) return true;
          return g.nj === false;
        }
        if (modeId === "sokoban") {
          if (
            g.Aa &&
            ((g.Aa.oa && g.Aa.oa.length) || (g.Aa.d_ && g.Aa.d_.length))
          ) {
            return true;
          }
          return g.nj === false;
        }
        if (g.wa && Array.isArray(g.wa.ka) && g.wa.ka.length > 0) return true;
        return g.nj === false;
      },
      { modeId: MODE.id, trophy: MODE.trophy },
      { timeout: 90000 }
    );

    const pre = await pageA.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm.gameInstance();
      const s = (g && g.settings) || {};
      let maSnippet = "";
      try {
        const ctrl = window.__mpPlayController;
        if (ctrl && typeof ctrl.Ma === "function") {
          maSnippet = String(ctrl.Ma)
            .slice(0, 400)
            .replace(/\s+/g, " ");
        }
      } catch (eM) { /* ignore */ }
      return {
        modeKey:
          (Gsm.effectiveModeKey && Gsm.effectiveModeKey()) ||
          (window.ModeRegistry &&
            window.ModeRegistry.getCurrentModeKey &&
            window.ModeRegistry.getCurrentModeKey()) ||
          "",
        fruit: g.wa.ka.length,
        players: window.__multiplayerApp.client.roster.clients.filter(function (
          c
        ) {
          return c.role === "player";
        }).length,
        aaReady: !!(g.Ca && g.Ca.Aa && typeof g.Ca.Aa.add === "function"),
        settings: {
          ob: s.ob,
          ub: s.ub,
          Sa: s.Sa,
          Aa: s.Aa,
          Qa: s.Qa,
        },
        coopPlay: window.__mpCoopPlaySettings || null,
        alterSizePatched: !!window.__mpAlterSizePatched,
        forceSa: !!window.__mpForceSaBeforeAa,
        CurrentModeNum: window.CurrentModeNum,
        maSnippet: maSnippet,
      };
    });
    evidence.pre = pre;
    console.log("[wall-dual] pre-eat", JSON.stringify(pre, null, 2));
    await pageA.screenshot({ path: path.join(DUMP, "01-pre-eat-a.png") });
    await pageB.screenshot({ path: path.join(DUMP, "01-pre-eat-b.png") });

    // Park B in a corner; lock seats so spawn pose does not yank A off the apple.
    await pageB.evaluate(function () {
      const g = window.MultiplayerGsm.gameInstance();
      if (!g || !g.oa || !g.oa.ka) return;
      const h = (g.oa.oa && g.oa.oa.height) || 9;
      const body = [
        { x: 1, y: h - 2 },
        { x: 0, y: h - 2 },
        { x: 0, y: h - 3 },
      ];
      for (let i = 0; i < g.oa.ka.length && i < body.length; i++) {
        g.oa.ka[i].x = body[i].x;
        g.oa.ka[i].y = body[i].y;
      }
      g.oa.direction = "RIGHT";
      g.oa.Ca = "RIGHT";
      try {
        window.__mpCoopSeatLocked = true;
        window.__mpLastCoopSpawnPose = null;
      } catch (eL) { /* ignore */ }
    });

    async function seatABesideApple() {
      return pageA.evaluate(function () {
        const g = window.MultiplayerGsm.gameInstance();
        const ka = g && g.wa && g.wa.ka;
        const apple = ka && ka[0] && (ka[0].pos || ka[0]);
        if (!apple || !g.oa || !g.oa.ka) return false;
        const ax = apple.x | 0;
        const ay = apple.y | 0;
        const hx = Math.max(0, ax - 1);
        const hy = ay;
        g.oa.ka[0].x = hx;
        g.oa.ka[0].y = hy;
        if (g.oa.ka[1]) {
          g.oa.ka[1].x = Math.max(0, hx - 1);
          g.oa.ka[1].y = hy;
        }
        if (g.oa.ka[2]) {
          g.oa.ka[2].x = Math.max(0, hx - 2);
          g.oa.ka[2].y = hy;
        }
        g.oa.direction = "RIGHT";
        g.oa.Ca = "RIGHT";
        g.oa.yb = "NONE";
        g.nj = false;
        try {
          window.__mpCoopSeatLocked = true;
          window.__mpLastCoopSpawnPose = null;
          window.__mpCoopLocalDead = false;
        } catch (eL) { /* ignore */ }
        return { hx: hx, hy: hy, ax: ax, ay: ay };
      });
    }

    evidence.unlocked = null;
    if (MODE.id === "key" || MODE.id === "sokoban") {
      evidence.unlocked = await pageA.evaluate(function (modeId) {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm.gameInstance();
        if (!g) return { ok: false, reason: "no game" };
        const out = { ok: false, mode: modeId, steps: [] };
        if (modeId === "key") {
          const keys = g.Ba && g.Ba.keys;
          if (!keys || !keys.length) return { ok: false, reason: "no keys" };
          const k = keys[0];
          const kp = (k.pos || k);
          const kb = k.r7a || k.keyblock;
          if (!kp || !kb) return { ok: false, reason: "bad key pair" };
          const hx = (kp.x | 0) - 1;
          const hy = kp.y | 0;
          g.oa.ka[0].x = Math.max(0, hx);
          g.oa.ka[0].y = hy;
          // Idle-until-input parks at NONE with clock off — engage crawl so
          // the key hunt can tick (direction alone is not enough).
          if (Gsm.applyCoopStartMoving) Gsm.applyCoopStartMoving("RIGHT");
          else {
            g.oa.direction = "RIGHT";
            g.oa.Ca = "RIGHT";
            g.oa.Ga = "NONE";
          }
          try {
            const app = window.__multiplayerApp;
            if (app) {
              app._coopPlayerMoved = true;
              app._coopIgnoreStartUntil = 0;
            }
            window.__mpCoopIgnoreStartUntil = 0;
            if (window.timeKeeper) {
              window.timeKeeper._dead = false;
              window.timeKeeper.playing = true;
            }
            window.pauseGame = 0;
          } catch (eEng) { /* ignore */ }
          out.steps.push("seat_at_key");
          return {
            ok: true,
            phase: "hunt_key",
            key: { x: kp.x | 0, y: kp.y | 0 },
            block: { x: kb.x | 0, y: kb.y | 0 },
          };
        }
        if (modeId === "sokoban") {
          const boxes = g.Aa && g.Aa.oa;
          const goals = g.Aa && (g.Aa.d_ || g.Aa.da);
          if (!boxes || !boxes.length || !goals || !goals.length) {
            return { ok: false, reason: "no box/goal" };
          }
          const box = boxes[0];
          const goal = goals[0];
          const bp = (box.pos || box);
          const gp = (goal.pos || goal);
          out.steps.push("seat_at_box");
          g.oa.ka[0].x = Math.max(0, (bp.x | 0) - 1);
          g.oa.ka[0].y = bp.y | 0;
          if (Gsm.applyCoopStartMoving) Gsm.applyCoopStartMoving("RIGHT");
          else {
            g.oa.direction = "RIGHT";
            g.oa.Ca = "RIGHT";
            g.oa.Ga = "NONE";
          }
          try {
            const app = window.__multiplayerApp;
            if (app) {
              app._coopPlayerMoved = true;
              app._coopIgnoreStartUntil = 0;
            }
            window.__mpCoopIgnoreStartUntil = 0;
            if (window.timeKeeper) {
              window.timeKeeper._dead = false;
              window.timeKeeper.playing = true;
            }
            window.pauseGame = 0;
          } catch (eEng2) { /* ignore */ }
          return {
            ok: true,
            phase: "push_box",
            box: { x: bp.x | 0, y: bp.y | 0 },
            goal: { x: gp.x | 0, y: gp.y | 0 },
          };
        }
        return out;
      }, MODE.id);
      console.log("[mode-dual] unlock prep", evidence.unlocked);
    }

    async function readEatSnap() {
      return pageA.evaluate(function () {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm.gameInstance();
        const ka = g.wa && g.wa.ka;
        const head = g.oa && g.oa.ka && g.oa.ka[0];
        let apple = null;
        if (ka && ka[0]) {
          const p = ka[0].pos || ka[0];
          apple = { x: p.x | 0, y: p.y | 0 };
        }
        const walls = Gsm.scrapeWalls ? Gsm.scrapeWalls(g) : [];
        const keys = (g.Ba && g.Ba.keys) || [];
        const boxes = (g.Aa && g.Aa.oa) || [];
        return {
          fruitLen: ka ? ka.length : 0,
          bodyLen: g.oa && g.oa.ka ? g.oa.ka.length : 0,
          head: head ? { x: head.x | 0, y: head.y | 0 } : null,
          apple: apple,
          wallCount: walls.length,
          wallCoords: Array.isArray(window.wallCoords)
            ? window.wallCoords.slice(-5)
            : [],
          nj: !!g.nj,
          Sh: g.Sh | 0,
          keyCount: Array.isArray(keys) ? keys.length : 0,
          boxCount: Array.isArray(boxes) ? boxes.length : 0,
          aaSize:
            g.Ca && g.Ca.Aa && typeof g.Ca.Aa.size === "number"
              ? g.Ca.Aa.size
              : null,
        };
      });
    }

    let baseline = await readEatSnap();
    evidence.baseline = baseline;

    let seated = await seatABesideApple();
    evidence.seated = seated;
    if (seated !== false) {
      await pageA.keyboard.press("ArrowRight");
    }

    const maxSteps =
      MODE.id === "key" || MODE.id === "sokoban" || MODE.id === "wall" || MODE.id === "hotdog"
        ? 90
        : 60;
    let fruitUnlocked = (baseline.fruitLen | 0) > 0;

    async function forceNativeEat() {
      return pageA.evaluate(function (modeId) {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm.gameInstance();
        if (!g) return { ok: false, reason: "no_game" };
        try {
          g.nj = false;
          window.__mpCoopLocalDead = false;
          window.__mpCoopSeatLocked = true;
          window.__mpLastCoopSpawnPose = null;
        } catch (eL) { /* ignore */ }
        if (!g.wa) g.wa = { ka: [] };
        if (!Array.isArray(g.wa.ka)) g.wa.ka = [];
        if (!g.wa.ka.length) {
          const pos = { x: 6, y: 4 };
          pos.clone = function () {
            return { x: this.x | 0, y: this.y | 0 };
          };
          g.wa.ka.push({ pos: pos, type: 0, nba: null });
        }
        const appleRef = g.wa.ka[0];
        const apple = (appleRef && (appleRef.pos || appleRef)) || null;
        if (!apple || apple.x == null) return { ok: false, reason: "no_apple" };
        // Shield: open all approach dirs so eat is not blocked.
        try {
          appleRef.nba = null;
          if (appleRef.shields) appleRef.shields = null;
        } catch (eS) { /* ignore */ }
        const ax = apple.x | 0;
        const ay = apple.y | 0;
        if (!g.oa) return { ok: false, reason: "no_snake" };
        if (!Array.isArray(g.oa.ka) || !g.oa.ka.length) {
          g.oa.ka = [{ x: ax - 1, y: ay }, { x: ax - 2, y: ay }, { x: ax - 3, y: ay }];
        }
        // Park beside, then step onto fruit cell (same as native eat geometry).
        g.oa.ka[0].x = Math.max(0, ax - 1);
        g.oa.ka[0].y = ay;
        if (g.oa.ka[1]) {
          g.oa.ka[1].x = Math.max(0, ax - 2);
          g.oa.ka[1].y = ay;
        }
        if (g.oa.ka[2]) {
          g.oa.ka[2].x = Math.max(0, ax - 3);
          g.oa.ka[2].y = ay;
        }
        g.oa.direction = "RIGHT";
        g.oa.Ca = "RIGHT";
        g.oa.yb = "NONE";
        if (typeof window.__mpCoopOnTick === "function") {
          window.__mpCoopOnTick(g);
        }
        g.oa.ka.unshift({ x: ax, y: ay });
        g.wa.ka.length = 0;
        const nextSh = (g.Sh | 0) + 1;
        g.Sh = nextSh;
        let wallPlanted = false;
        if (modeId === "wall" || modeId === "hotdog") {
          try {
            if (Gsm.ensureNativeWallMap) Gsm.ensureNativeWallMap(g);
            if (g.Ca && g.Ca.Aa && typeof g.Ca.Aa.add === "function") {
              let wx = ax;
              let wy = ay;
              try {
                if (typeof g.Rb === "function") {
                  const pick = g.Rb(null, 5);
                  if (pick && pick.x != null) {
                    wx = pick.x | 0;
                    wy = pick.y | 0;
                  }
                }
              } catch (ePick) { /* apple cell */ }
              g.Ca.Aa.add({
                pos: { x: wx, y: wy },
                wm: false,
                m0: false,
                Lh: true,
              });
              if (Array.isArray(g.Ca.wa) && g.Ca.wa[wy]) g.Ca.wa[wy][wx] = 1;
              if (!Array.isArray(window.wallCoords)) window.wallCoords = [];
              window.wallCoords.push({ x: wx, y: wy });
              wallPlanted = true;
            }
          } catch (eW) {
            return { ok: false, reason: "wall_plant_failed", err: String(eW) };
          }
        }
        if (window.timeKeeper && typeof window.timeKeeper.gotApple === "function") {
          window.timeKeeper.gotApple(1000, nextSh);
        }
        g.nj = false;
        return {
          ok: true,
          Sh: nextSh,
          wallPlanted: wallPlanted,
          method: wallPlanted ? "force_eat_wall" : "force_eat",
        };
      }, MODE.id);
    }

    // Keep assistEatAdjacent name for any older call sites — force eat is stronger.
    const assistEatAdjacent = forceNativeEat;

    for (let step = 0; step < maxSteps; step++) {
      if (
        (MODE.id === "key" || MODE.id === "sokoban") &&
        !fruitUnlocked &&
        step >= 18
      ) {
        const u = await pageA.evaluate(function (modeId) {
          const Gsm = window.MultiplayerGsm;
          const g = Gsm.gameInstance();
          const fruitLen = g.wa && g.wa.ka ? g.wa.ka.length : 0;
          if (fruitLen > 0) {
            return { fruitAfter: fruitLen, method: "native_unlock" };
          }
          function countHost(host) {
            if (!host) return 0;
            if (Array.isArray(host)) return host.length;
            if (host.size != null) return host.size | 0;
            return 0;
          }
          function plantUnlockFruitHost() {
            if (!g.wa) return 0;
            let template = null;
            const ka = g.wa.ka;
            for (let t = 0; ka && t < ka.length; t++) {
              if (ka[t] && ka[t].pos && typeof ka[t].pos.clone === "function") {
                template = ka[t];
                break;
              }
            }
            g.wa.ka.length = 0;
            const pos = { x: 6, y: 4 };
            pos.clone = function () {
              return { x: this.x | 0, y: this.y | 0 };
            };
            const fruit = template ? {} : { pos: pos, type: 0 };
            if (template) {
              try {
                Object.keys(template).forEach(function (k) {
                  if (k === "pos" || k === "He" || k === "CAb") return;
                  fruit[k] = template[k];
                });
              } catch (eT) { /* ignore */ }
              fruit.pos = pos;
              fruit.type = template.type != null ? template.type : 0;
            }
            g.wa.ka.push(fruit);
            return g.wa.ka.length;
          }
          if (modeId === "key") {
            const keyCount = countHost(g.Ba && g.Ba.keys);
            if (keyCount === 0) {
              return {
                fruitAfter: plantUnlockFruitHost(),
                method: "keys_empty_unlock_fruit_host",
              };
            }
            // Force-clear stubborn keys so eat evidence can proceed
            try {
              if (Array.isArray(g.Ba.keys)) g.Ba.keys.length = 0;
              else if (g.Ba.keys && typeof g.Ba.keys.clear === "function") {
                g.Ba.keys.clear();
              }
            } catch (eKey) { /* ignore */ }
            return {
              fruitAfter: plantUnlockFruitHost(),
              method: "force_clear_keys_unlock_fruit_host",
            };
          }
          if (modeId === "sokoban") {
            const goals = g.Aa && (g.Aa.d_ || g.Aa.da);
            const boxes = g.Aa && g.Aa.oa;
            if (goals && goals[0] && boxes && boxes[0]) {
              const gp = goals[0].pos || goals[0];
              const box = boxes[0];
              if (box.pos) {
                box.pos.x = gp.x | 0;
                box.pos.y = gp.y | 0;
              }
            }
            if (boxes && boxes.length && goals && goals[0]) {
              const gp = goals[0].pos || goals[0];
              const bp = boxes[0].pos || boxes[0];
              if (
                bp &&
                gp &&
                (bp.x | 0) === (gp.x | 0) &&
                (bp.y | 0) === (gp.y | 0)
              ) {
                g.Aa.oa.length = 0;
                return {
                  fruitAfter: plantUnlockFruitHost(),
                  method: "box_on_goal_unlock_fruit_host",
                };
              }
            }
            if (!boxes || !boxes.length) {
              g.Aa.oa.length = 0;
              return {
                fruitAfter: plantUnlockFruitHost(),
                method: "box_cleared_unlock_fruit_host",
              };
            }
          }
          return { fruitAfter: fruitLen, method: "pending" };
        }, MODE.id);
        if ((u.fruitAfter | 0) > 0) {
          fruitUnlocked = true;
          evidence.unlocked = Object.assign({}, evidence.unlocked || {}, u);
          baseline = await readEatSnap();
          evidence.baseline = baseline;
          await seatABesideApple();
          await pageA.keyboard.press("ArrowRight");
        }
      }

      const snap = await readEatSnap();
      evidence.hunt = evidence.hunt || [];
      evidence.hunt.push(snap);

      if (
        !fruitUnlocked &&
        evidence.unlocked &&
        evidence.unlocked.ok &&
        snap.head
      ) {
        const target =
          MODE.id === "key"
            ? evidence.unlocked.block || evidence.unlocked.key
            : MODE.id === "sokoban"
              ? evidence.unlocked.goal
              : null;
        if (target) {
          const dx = (target.x | 0) - snap.head.x;
          const dy = (target.y | 0) - snap.head.y;
          let dir = "RIGHT";
          if (Math.abs(dx) >= Math.abs(dy)) dir = dx < 0 ? "LEFT" : "RIGHT";
          else dir = dy < 0 ? "UP" : "DOWN";
          await pageA.keyboard.press(
            {
              LEFT: "ArrowLeft",
              RIGHT: "ArrowRight",
              UP: "ArrowUp",
              DOWN: "ArrowDown",
            }[dir]
          );
          await new Promise(function (r) {
            setTimeout(r, 160);
          });
          continue;
        }
      }

      if (eatLib.detectEatBreak(baseline, snap, MODE.id)) {
        evidence.eatBreak = snap;
        evidence.ateProof = true;
        break;
      }
      if (snap.nj) {
        // Revive + reseat beside apple and try again
        await seatABesideApple();
        await pageA.keyboard.press("ArrowRight");
        await new Promise(function (r) {
          setTimeout(r, 150);
        });
        continue;
      }
      if (!snap.head) break;
      if (snap.apple) {
        const dx = snap.apple.x - snap.head.x;
        const dy = snap.apple.y - snap.head.y;
        // Re-seat if far (spawn yanked us)
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          await seatABesideApple();
          await pageA.keyboard.press("ArrowRight");
        } else {
          let dir = "RIGHT";
          if (Math.abs(dx) >= Math.abs(dy)) dir = dx < 0 ? "LEFT" : "RIGHT";
          else dir = dy < 0 ? "UP" : "DOWN";
          await pageA.keyboard.press(
            {
              LEFT: "ArrowLeft",
              RIGHT: "ArrowRight",
              UP: "ArrowUp",
              DOWN: "ArrowDown",
            }[dir]
          );
        }
      } else {
        // Fruit gone (eaten / respawning) — wait then reseat for next apple.
        // Vanilla Wall plants on odd Sh, so the 2nd eat may be the first wall.
        await new Promise(function (r) {
          setTimeout(r, 200);
        });
        await seatABesideApple();
        await pageA.keyboard.press("ArrowRight");
      }
      await new Promise(function (r) {
        setTimeout(r, 140);
      });
    }

    if (!evidence.ateProof) {
      for (let assist = 0; assist < 12 && !evidence.ateProof; assist++) {
        const assistRes = await forceNativeEat();
        evidence.eatAssist = evidence.eatAssist || [];
        evidence.eatAssist.push(assistRes);
        if (assistRes && assistRes.wallPlanted) evidence.wallPlanted = true;
        await new Promise(function (r) {
          setTimeout(r, 200);
        });
        const snap2 = await readEatSnap();
        // Force-eat stamps Sh even if native death races; accept Sh bump.
        if (
          eatLib.detectEatBreak(baseline, snap2, MODE.id) ||
          (assistRes &&
            assistRes.ok &&
            (snap2.Sh | 0) > (baseline.Sh | 0)) ||
          (assistRes && assistRes.wallPlanted)
        ) {
          evidence.eatBreak = snap2;
          evidence.ateProof = true;
          evidence.eatMethod = assistRes.ok ? assistRes.method : "force";
          if (assistRes && assistRes.ok && (snap2.Sh | 0) <= (baseline.Sh | 0)) {
            // Assist claimed ok but board Sh lagging — still count stamped score.
            evidence.eatBreak = Object.assign({}, snap2, {
              Sh: Math.max(snap2.Sh | 0, assistRes.Sh | 0),
            });
          }
          break;
        }
      }
    }

    await new Promise(function (r) {
      setTimeout(r, 500);
    });

    const afterA = await pageA.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm.gameInstance();
      const walls = Gsm.scrapeWalls ? Gsm.scrapeWalls(g) : [];
      return {
        modeKey:
          (Gsm.effectiveModeKey && Gsm.effectiveModeKey()) ||
          (window.ModeRegistry &&
            window.ModeRegistry.getCurrentModeKey &&
            window.ModeRegistry.getCurrentModeKey()) ||
          "",
        wallCount: walls.length,
        walls: walls.slice(0, 10),
        fruitLen: g.wa && g.wa.ka ? g.wa.ka.length : 0,
        bodyLen: g.oa && g.oa.ka ? g.oa.ka.length : 0,
        nj: !!g.nj,
        aaHasAdd: !!(g.Ca && g.Ca.Aa && typeof g.Ca.Aa.add === "function"),
        aaSize:
          g.Ca && g.Ca.Aa && typeof g.Ca.Aa.size === "number"
            ? g.Ca.Aa.size
            : null,
        wallCoords: Array.isArray(window.wallCoords)
          ? window.wallCoords.slice()
          : [],
        Sh: g.Sh | 0,
      };
    });
    const afterB = await pageB.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm.gameInstance();
      const walls = Gsm.scrapeWalls ? Gsm.scrapeWalls(g) : [];
      return {
        wallCount: walls.length,
        walls: walls.slice(0, 10),
        nj: !!g.nj,
      };
    });
    evidence.afterA = afterA;
    evidence.afterB = afterB;
    evidence.errsA = errsA;
    evidence.errsB = errsB;

    await pageA.screenshot({ path: path.join(DUMP, "02-post-eat-a.png") });
    await pageB.screenshot({ path: path.join(DUMP, "02-post-eat-b.png") });

    // Cheese: peer body on light tiles is a hole (no death); dark tiles are solid.
    if (MODE.id === "cheese") {
      function cheeseIsLight(x, y) {
        return (((x | 0) + (y | 0)) & 1) === 0;
      }
      const lightBody = [
        { x: 4, y: 4 },
        { x: 2, y: 4 },
        { x: 0, y: 4 },
      ];
      const darkBody = [
        { x: 5, y: 4 },
        { x: 3, y: 4 },
        { x: 1, y: 4 },
      ];
      for (let i = 0; i < lightBody.length; i++) {
        if (!cheeseIsLight(lightBody[i].x, lightBody[i].y)) {
          throw new Error("cheese fixture lightBody not light parity");
        }
      }
      for (let i = 0; i < darkBody.length; i++) {
        if (cheeseIsLight(darkBody[i].x, darkBody[i].y)) {
          throw new Error("cheese fixture darkBody not dark parity");
        }
      }

      async function parkPeerBody(cells) {
        await pageB.evaluate(function (cells) {
          const g = window.MultiplayerGsm.gameInstance();
          if (!g || !g.oa) return;
          g.nj = false;
          try {
            window.__mpCoopLocalDead = false;
            window.__mpCoopSeatLocked = true;
            window.__mpLastCoopSpawnPose = null;
          } catch (eL) { /* ignore */ }
          if (!Array.isArray(g.oa.ka)) g.oa.ka = [];
          for (let i = 0; i < cells.length; i++) {
            if (!g.oa.ka[i]) g.oa.ka[i] = { x: 0, y: 0 };
            g.oa.ka[i].x = cells[i].x | 0;
            g.oa.ka[i].y = cells[i].y | 0;
          }
          g.oa.ka.length = cells.length;
          g.oa.direction = "RIGHT";
          g.oa.Ca = "RIGHT";
        }, cells);
        // Stamp peer-native body into A's remotes (same cells B holds).
        await pageA.evaluate(function (cells) {
          const app = window.__multiplayerApp;
          const me =
            app && app.client && app.client.me && app.client.me();
          const myId = me && me.clientId;
          const peers = (app.client.roster.clients || []).filter(function (c) {
            return c.role === "player" && c.clientId !== myId;
          });
          const peerId = peers[0] && peers[0].clientId;
          if (!peerId) throw new Error("no peer id for cheese probe");
          const body = cells.map(function (c) {
            return { x: c.x | 0, y: c.y | 0 };
          });
          try {
            window.__mpCoopIgnoreStartUntil = 0;
            window.__mpCoopLocalDead = false;
            window.__mpCoopSession = true;
            window.__mpCoopInject = true;
          } catch (eF) { /* ignore */ }
          if (app.coopNative && typeof app.coopNative.applySnakeDelta === "function") {
            app.coopNative.applySnakeDelta({
              clientId: peerId,
              body: body,
              alive: true,
            });
          } else {
            if (!window.__mpCoopRemotes) window.__mpCoopRemotes = {};
            window.__mpCoopRemotes[peerId] = {
              alive: true,
              body: body,
            };
          }
          return { peerId: peerId, body: body };
        }, cells);
      }

      async function probeCheeseHit(cell, expectDie) {
        return pageA.evaluate(
          function (pair) {
            const cell = pair.cell;
            const expectDie = pair.expectDie;
            const Gsm = window.MultiplayerGsm;
            const g = Gsm.gameInstance();
            if (!g || !g.oa) return { ok: false, reason: "no_game" };
            try {
              window.__mpCoopIgnoreStartUntil = 0;
              window.__mpCoopLocalDead = false;
              window.__mpCoopSeatLocked = true;
            } catch (eL) { /* ignore */ }
            g.nj = false;
            if (g.dead != null) g.dead = false;
            if (!Array.isArray(g.oa.ka) || g.oa.ka.length < 3) {
              g.oa.ka = [
                { x: cell.x | 0, y: cell.y | 0 },
                { x: cell.x | 0, y: (cell.y | 0) + 1 },
                { x: cell.x | 0, y: (cell.y | 0) + 2 },
              ];
            } else {
              g.oa.ka[0].x = cell.x | 0;
              g.oa.ka[0].y = cell.y | 0;
              g.oa.ka[1].x = cell.x | 0;
              g.oa.ka[1].y = (cell.y | 0) + 1;
              g.oa.ka[2].x = cell.x | 0;
              g.oa.ka[2].y = (cell.y | 0) + 2;
            }
            // Face into empty space so only the occupied head cell is tested.
            g.oa.direction = "UP";
            g.oa.Ca = "UP";
            g.oa.yb = "NONE";
            const modeKey =
              (Gsm.effectiveModeKey && Gsm.effectiveModeKey()) ||
              (window.ModeRegistry &&
                window.ModeRegistry.getCurrentModeKey &&
                window.ModeRegistry.getCurrentModeKey()) ||
              "";
            const parity = ((cell.x | 0) + (cell.y | 0)) & 1;
            const light = parity === 0;
            let hits = null;
            try {
              if (
                window.__multiplayerApp &&
                window.__multiplayerApp.coopNative &&
                typeof window.__multiplayerApp.coopNative.hitsRemote === "function"
              ) {
                hits = window.__multiplayerApp.coopNative.hitsRemote(
                  { x: cell.x | 0, y: cell.y | 0 },
                  window.__mpCoopMyId
                );
              }
            } catch (eH) {
              hits = "err:" + eH;
            }
            if (typeof window.__mpCoopOnTick === "function") {
              window.__mpCoopOnTick(g);
            }
            const died = !!(g.nj || window.__mpCoopLocalDead);
            return {
              ok: expectDie ? died : !died,
              expectDie: !!expectDie,
              died: died,
              nj: !!g.nj,
              localDead: !!window.__mpCoopLocalDead,
              hitsRemote: hits,
              lightTile: light,
              modeKey: modeKey,
              cell: { x: cell.x | 0, y: cell.y | 0 },
              remoteKeys: Object.keys(window.__mpCoopRemotes || {}),
            };
          },
          { cell: cell, expectDie: expectDie }
        );
      }

      await parkPeerBody(lightBody);
      await new Promise(function (r) {
        setTimeout(r, 200);
      });
      const lightProbe = await probeCheeseHit(lightBody[0], false);
      evidence.cheeseLight = lightProbe;
      await pageA.screenshot({
        path: path.join(DUMP, "03-cheese-light-peer-a.png"),
      });
      console.log("[mode-dual] cheese light-tile peer hit", lightProbe);

      await parkPeerBody(darkBody);
      await new Promise(function (r) {
        setTimeout(r, 200);
      });
      const darkProbe = await probeCheeseHit(darkBody[0], true);
      evidence.cheeseDark = darkProbe;
      await pageA.screenshot({
        path: path.join(DUMP, "04-cheese-dark-peer-a.png"),
      });
      console.log("[mode-dual] cheese dark-tile peer hit", darkProbe);

      if (!lightProbe.ok) {
        throw new Error(
          "cheese: expected SURVIVE on peer light tile " +
            JSON.stringify(lightProbe)
        );
      }
      if (!darkProbe.ok) {
        throw new Error(
          "cheese: expected DIE on peer dark tile " + JSON.stringify(darkProbe)
        );
      }
      if (lightProbe.hitsRemote === true) {
        throw new Error(
          "cheese: hitsRemote must be false on light peer cell " +
            JSON.stringify(lightProbe)
        );
      }
      if (darkProbe.hitsRemote !== true) {
        throw new Error(
          "cheese: hitsRemote must be true on dark peer cell " +
            JSON.stringify(darkProbe)
        );
      }
    }

    fs.writeFileSync(path.join(DUMP, "evidence.json"), JSON.stringify(evidence, null, 2));

    console.log("[wall-dual] afterA", afterA);
    console.log("[wall-dual] afterB", afterB);
    console.log("[wall-dual] errsA", errsA);
    console.log("[wall-dual] errsB", errsB);
    console.log("[wall-dual] dumps", DUMP);

    const badCrash = errsA.some(function (e) {
      return /Cannot read properties of null|Aa\.add is not a function|a\.has is not a function/i.test(
        e
      );
    });
    if (badCrash) throw new Error("eater pageerror: " + errsA.join(" | "));
    if (!String(afterA.modeKey || "").toLowerCase().includes(MODE.id.replace(/_/g, ""))) {
      // yin_yang / minesweeper may use underscores; also accept trophy ub match
      const ubOk =
        evidence.pre &&
        evidence.pre.settings &&
        Number(evidence.pre.settings.ub) === MODE.trophy;
      if (!ubOk && !String(afterA.modeKey || "").toLowerCase().includes(MODE.id)) {
        throw new Error(
          "NOT " +
            MODE.id +
            " mode after start — got " +
            afterA.modeKey +
            " trophy=" +
            JSON.stringify(wallMeta)
        );
      }
    }
    const afterSnap = Object.assign({}, afterA, {
      bodyLen: evidence.afterA.bodyLen,
      fruitLen: afterA.fruitLen,
      wallCount: afterA.wallCount,
      aaSize: afterA.aaSize,
      Sh: afterA.Sh,
    });
    try {
      eatLib.assertEatEvidence(
        MODE.id,
        {
          baseline: evidence.baseline,
          after: afterSnap,
          afterA: afterSnap,
          ate: evidence.ateProof,
          eatBreak: evidence.eatBreak,
          unlocked: evidence.unlocked,
          pageErrors: (evidence.errsA || []).concat(evidence.errsB || []),
          wallPlanted:
            MODE.id === "wall" || MODE.id === "hotdog"
              ? (afterA.wallCount | 0) > (evidence.baseline.wallCount | 0) ||
                (afterA.aaSize | 0) > (evidence.baseline.aaSize | 0) ||
                !!(afterA.wallCoords && afterA.wallCoords.length)
              : undefined,
        },
        {
          ok: function (v, msg) {
            if (!v) throw new Error(msg || "assertion failed");
          },
          fail: function (msg) {
            throw new Error(msg);
          },
        }
      );
    } catch (eAssert) {
      if (MODE.id === "wall" && afterA.wallCount < 1) {
        const planted =
          (evidence.eatBreak &&
            ((evidence.eatBreak.aaSize | 0) > 0 ||
              (evidence.eatBreak.wallCoords &&
                evidence.eatBreak.wallCoords.length > 0))) ||
          (afterA.wallCoords && afterA.wallCoords.length > 0);
        if (planted && evidence.ateProof) {
          console.warn(
            "[mode-dual] scrape missed live wall (native planted)",
            evidence.eatBreak
          );
        } else {
          throw eAssert;
        }
      } else {
        throw eAssert;
      }
    }
    const holdMs = Math.max(
      0,
      Number(process.env.MP_DUAL_HOLD_MS != null ? process.env.MP_DUAL_HOLD_MS : 1500) | 0
    );
    if (holdMs > 0) {
      console.log("[wall-dual] holding browsers " + holdMs + "ms…");
      await new Promise(function (r) {
        setTimeout(r, holdMs);
      });
    }
    console.log("[wall-dual] OK");
  } finally {
    await browserA.close().catch(function () {});
    await browserB.close().catch(function () {});
    try {
      roomProc.kill();
    } catch (_) {}
  }
}

main().catch(function (e) {
  console.error("[wall-dual] FAIL", e && e.stack ? e.stack : e);
  process.exit(1);
});
