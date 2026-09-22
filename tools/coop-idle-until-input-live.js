"use strict";

/**
 * Headed dual-browser evidence: co-op snakes stay IDLE until each player's key.
 *
 *   node tools/coop-idle-until-input-live.js
 *
 * Dumps → .cache/e2e/idle-until-input-dual/
 * Fails if either snake crawls/dies during a no-input hold, or if peer crawls
 * when only A presses a key.
 */
const { spawn, execSync } = require("node:child_process");
const path = require("path");
const fs = require("fs");
const net = require("node:net");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(
  ROOT,
  "server",
  "target",
  "release",
  process.platform === "win32" ? "multiplayer-server.exe" : "multiplayer-server"
);
const GSM_URL = process.env.MP_E2E_GSM_URL || "https://googlesnakemods.com/v/current/";
const DUMP = path.join(ROOT, ".cache", "e2e", "idle-until-input-dual");
const CERT_DIR = path.join(ROOT, ".cache", "e2e-certs");
const KEY_PATH = path.join(CERT_DIR, "key.pem");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const FAKE_MOD_ORIGIN = "https://mp-e2e.local";
const HOLD_MS = Math.max(
  2500,
  Number(process.env.MP_IDLE_HOLD_MS != null ? process.env.MP_IDLE_HOLD_MS : 3500) | 0
);

function ensureCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return;
  const openssl = fs.existsSync("C:\\Program Files\\Git\\usr\\bin\\openssl.exe")
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
        if (u && (String(u).indexOf("MultiplayerMod.js") !== -1 || u === target)) {
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

function snapIdle() {
  const Gsm = window.MultiplayerGsm;
  const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
  const snake = g && g.oa;
  const head = snake && snake.ka && snake.ka[0];
  const body = [];
  if (snake && Array.isArray(snake.ka)) {
    for (let i = 0; i < Math.min(snake.ka.length, 5); i++) {
      const p = snake.ka[i];
      if (p) body.push({ x: p.x | 0, y: p.y | 0 });
    }
  }
  let crawlFacing = null;
  try {
    if (Gsm.coopSnakeHasCrawlFacing && Gsm.coopSnakeHasCrawlFacing(snake)) {
      crawlFacing =
        (Gsm.normalizePoseDirection &&
          Gsm.normalizePoseDirection(snake.direction || snake.dir)) ||
        snake.direction ||
        snake.dir ||
        "set";
    }
  } catch (eR) { /* ignore */ }
  const dirRaw = snake ? snake.direction : null;
  return {
    hasGame: !!g,
    head: head ? { x: head.x | 0, y: head.y | 0 } : null,
    body: body,
    direction: dirRaw,
    dir: snake ? snake.dir : null,
    Ca: snake && typeof snake.Ca === "string" ? snake.Ca : snake ? typeof snake.Ca : null,
    Ga: snake && typeof snake.Ga === "string" ? snake.Ga : snake ? typeof snake.Ga : null,
    crawlFacing: crawlFacing,
    hasCrawl:
      typeof Gsm.coopSnakeHasCrawlFacing === "function"
        ? !!Gsm.coopSnakeHasCrawlFacing(snake)
        : !!(crawlFacing || (dirRaw && dirRaw !== "NONE")),
    nj: !!(g && g.nj),
    localDead: !!window.__mpCoopLocalDead,
    playerMoved: !!(
      window.__multiplayerApp && window.__multiplayerApp._coopPlayerMoved
    ),
    tkPlaying: !!(window.timeKeeper && window.timeKeeper.playing),
    built: window.__MP_MOD_BUILT || null,
  };
}

function sameHead(a, b) {
  if (!a || !b || !a.head || !b.head) return false;
  return a.head.x === b.head.x && a.head.y === b.head.y;
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
  console.log("[idle-live] room", wsUrl, "built", built);

  const { chromium } = require("playwright");
  const chromeArgs = [
    "--ignore-certificate-errors",
    "--mute-audio",
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessPermissionPrompt",
  ];
  const browserA = await chromium.launch({
    headless: false,
    args: chromeArgs.concat(["--window-size=960,900", "--window-position=20,40"]),
  });
  const browserB = await chromium.launch({
    headless: false,
    args: chromeArgs.concat(["--window-size=960,900", "--window-position=980,40"]),
  });
  const gsmOrigin = new URL(GSM_URL).origin;
  const ctxOpts = {
    ignoreHTTPSErrors: true,
    viewport: { width: 900, height: 820 },
    permissions: ["local-network-access"],
  };
  const ctxA = await browserA.newContext(ctxOpts);
  const ctxB = await browserB.newContext(ctxOpts);
  try {
    await ctxA.grantPermissions(["local-network-access"], { origin: gsmOrigin });
    await ctxB.grantPermissions(["local-network-access"], { origin: gsmOrigin });
  } catch (_) {}

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

  const evidence = {
    built: built,
    wsUrl: wsUrl,
    holdMs: HOLD_MS,
    steps: [],
  };

  try {
    console.log("[idle-live] loading GSM + MultiplayerMod (A/B)…");
    await Promise.all([
      loadModFromUrl(ctxA, pageA, modUrl, built, modSource),
      loadModFromUrl(ctxB, pageB, modUrl, built, modSource),
    ]);
    evidence.steps.push("mod_loaded");
    await pageA.screenshot({ path: path.join(DUMP, "00-mod-loaded-a.png") });

    const joinA = await connectPage(pageA, wsUrl, "IdleA", null);
    const roomCode = joinA.roomCode;
    evidence.roomCode = roomCode;
    const joinB = await connectPage(pageB, wsUrl, "IdleB", roomCode);
    evidence.steps.push("joined");
    console.log("[idle-live] room", roomCode, joinA.clientId, joinB.clientId);

    await pageA.evaluate(function () {
      const app = window.__multiplayerApp;
      app.ui.openPuddingSettings("control");
      if (app.client.setMode) app.client.setMode("coop");
    });
    await new Promise(function (r) {
      setTimeout(r, 400);
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
      { timeout: 20000 }
    );

    const clean = { trophy: 0, count: 0, speed: 1, size: 1, apple: 0 };
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
      if (Gsm.forceMatchSettingsForPlay) Gsm.forceMatchSettingsForPlay(clean);
      window.__mpCoopPlaySettings = Object.assign({}, clean);
      window.__mpMatchPlaySettings = Object.assign({}, clean);
      try {
        window.CurrentModeNum = clean.trophy;
      } catch (eC) { /* ignore */ }
    }, clean);

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
      function () {
        const g = window.MultiplayerGsm && window.MultiplayerGsm.gameInstance();
        return !!(g && g.oa && g.oa.ka && g.oa.ka.length >= 3);
      },
      { timeout: 90000 }
    );
    await pageB.waitForFunction(
      function () {
        const g = window.MultiplayerGsm && window.MultiplayerGsm.gameInstance();
        return !!(g && g.oa && g.oa.ka && g.oa.ka.length >= 3);
      },
      { timeout: 90000 }
    );
    // Let seats settle; do NOT press keys.
    await new Promise(function (r) {
      setTimeout(r, 800);
    });

    const t0A = await pageA.evaluate(snapIdle);
    const t0B = await pageB.evaluate(snapIdle);
    evidence.t0 = { a: t0A, b: t0B };
    console.log("[idle-live] t0 A", JSON.stringify(t0A));
    console.log("[idle-live] t0 B", JSON.stringify(t0B));
    await pageA.screenshot({ path: path.join(DUMP, "01-seated-idle-a.png") });
    await pageB.screenshot({ path: path.join(DUMP, "01-seated-idle-b.png") });

    if (!t0A.head || !t0B.head) {
      throw new Error("missing heads at seat t0");
    }
    if (t0A.hasCrawl || t0B.hasCrawl || t0A.crawlFacing || t0B.crawlFacing) {
      throw new Error(
        "crawl facing already set at seat — A=" +
          JSON.stringify(t0A) +
          " B=" +
          JSON.stringify(t0B)
      );
    }
    if (t0A.nj || t0B.nj || t0A.localDead || t0B.localDead) {
      throw new Error("already dead at seat t0");
    }

    console.log("[idle-live] holding", HOLD_MS, "ms with NO keyboard input…");
    const samples = [];
    const sampleEvery = 500;
    const nSamples = Math.max(1, Math.floor(HOLD_MS / sampleEvery));
    for (let i = 0; i < nSamples; i++) {
      await new Promise(function (r) {
        setTimeout(r, sampleEvery);
      });
      const sA = await pageA.evaluate(snapIdle);
      const sB = await pageB.evaluate(snapIdle);
      samples.push({ i: i, a: sA, b: sB });
      if (!sameHead(t0A, sA) || !sameHead(t0B, sB)) {
        evidence.movedDuringHold = { a: sA, b: sB };
        throw new Error(
          "snake crawled during no-input hold sample " +
            i +
            " A " +
            JSON.stringify(t0A.head) +
            "→" +
            JSON.stringify(sA.head) +
            " B " +
            JSON.stringify(t0B.head) +
            "→" +
            JSON.stringify(sB.head)
        );
      }
      if (sA.hasCrawl || sB.hasCrawl || sA.crawlFacing || sB.crawlFacing) {
        throw new Error("crawl facing appeared during hold @" + i);
      }
      if (sA.nj || sB.nj || sA.localDead || sB.localDead) {
        throw new Error("death during idle hold @" + i);
      }
    }
    evidence.holdSamples = samples;
    evidence.steps.push("idle_hold_ok");

    const t1A = await pageA.evaluate(snapIdle);
    const t1B = await pageB.evaluate(snapIdle);
    evidence.t1 = { a: t1A, b: t1B };
    await pageA.screenshot({ path: path.join(DUMP, "02-after-hold-a.png") });
    await pageB.screenshot({ path: path.join(DUMP, "02-after-hold-b.png") });

    // Only A presses a key — B must stay idle.
    console.log("[idle-live] ArrowRight on A only…");
    await pageA.bringToFront();
    await pageA.evaluate(function () {
      const canvas =
        document.querySelector("canvas.cer0Bd") ||
        document.querySelector("canvas") ||
        document.body;
      if (canvas && canvas.focus) canvas.focus();
      try {
        if (window.MultiplayerGsm && window.MultiplayerGsm.setLocalPaused) {
          window.MultiplayerGsm.setLocalPaused(false);
        } else {
          window.pauseGame = 0;
        }
      } catch (eP) { /* ignore */ }
    });
    await pageA.keyboard.press("ArrowRight");
    await new Promise(function (r) {
      setTimeout(r, 1500);
    });
    const t2A = await pageA.evaluate(snapIdle);
    const t2B = await pageB.evaluate(snapIdle);
    evidence.t2_afterAKey = { a: t2A, b: t2B };
    await pageA.screenshot({ path: path.join(DUMP, "03-after-a-key-a.png") });
    await pageB.screenshot({ path: path.join(DUMP, "03-after-a-key-b.png") });

    if (!sameHead(t1B, t2B)) {
      throw new Error(
        "peer B crawled when only A pressed a key — " +
          JSON.stringify(t1B.head) +
          "→" +
          JSON.stringify(t2B.head)
      );
    }
    if (t2B.hasCrawl || t2B.crawlFacing) {
      throw new Error("peer B gained crawl facing from A's key: " + JSON.stringify(t2B));
    }
    if (t2B.nj || t2B.localDead) {
      throw new Error("peer B died when A pressed a key");
    }
    // A should now have facing and/or have moved (or at least left idle).
    const aEngaged =
      t2A.hasCrawl ||
      !!t2A.crawlFacing ||
      t2A.playerMoved ||
      !sameHead(t1A, t2A);
    if (!aEngaged) {
      throw new Error(
        "A did not engage after ArrowRight — still idle: " + JSON.stringify(t2A)
      );
    }
    evidence.steps.push("a_key_peer_still_idle");

    // B presses its own key — should engage without killing the proof.
    console.log("[idle-live] ArrowLeft on B…");
    await pageB.bringToFront();
    await pageB.evaluate(function () {
      const canvas =
        document.querySelector("canvas.cer0Bd") ||
        document.querySelector("canvas") ||
        document.body;
      if (canvas && canvas.focus) canvas.focus();
      try {
        if (window.MultiplayerGsm && window.MultiplayerGsm.setLocalPaused) {
          window.MultiplayerGsm.setLocalPaused(false);
        } else {
          window.pauseGame = 0;
        }
      } catch (eP) { /* ignore */ }
    });
    await pageB.keyboard.press("ArrowLeft");
    await new Promise(function (r) {
      setTimeout(r, 1500);
    });
    const t3A = await pageA.evaluate(snapIdle);
    const t3B = await pageB.evaluate(snapIdle);
    evidence.t3_afterBKey = { a: t3A, b: t3B };
    await pageA.screenshot({ path: path.join(DUMP, "04-after-b-key-a.png") });
    await pageB.screenshot({ path: path.join(DUMP, "04-after-b-key-b.png") });
    const bEngaged =
      t3B.hasCrawl ||
      !!t3B.crawlFacing ||
      t3B.playerMoved ||
      !sameHead(t2B, t3B);
    if (!bEngaged) {
      throw new Error("B did not engage after own key: " + JSON.stringify(t3B));
    }
    evidence.steps.push("b_key_ok");

    evidence.errsA = errsA;
    evidence.errsB = errsB;
    evidence.ok = true;
    fs.writeFileSync(path.join(DUMP, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log("[idle-live] OK — dumps", DUMP);
  } catch (e) {
    evidence.ok = false;
    evidence.error = String(e && e.stack ? e.stack : e);
    evidence.errsA = errsA;
    evidence.errsB = errsB;
    try {
      await pageA.screenshot({ path: path.join(DUMP, "99-fail-a.png") });
      await pageB.screenshot({ path: path.join(DUMP, "99-fail-b.png") });
    } catch (_) {}
    fs.writeFileSync(path.join(DUMP, "evidence.json"), JSON.stringify(evidence, null, 2));
    throw e;
  } finally {
    await browserA.close().catch(function () {});
    await browserB.close().catch(function () {});
    try {
      roomProc.kill();
    } catch (_) {}
  }
}

main().catch(function (e) {
  console.error("[idle-live] FAIL", e && e.stack ? e.stack : e);
  process.exit(1);
});
