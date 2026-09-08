"use strict";

/**
 * Chromium UI: Control tab + co-op first-apple wall grow (p6E Aa.add).
 * Opens a real browser page, mounts the Multiplayer Control UI, seats a mock
 * native engine with null Ca.Aa, runs the co-op tick hook, then simulates
 * native wall grow — must not throw.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/coop-wall-chrome.html");

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer(function (req, res) {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/tests/fixtures/coop-wall-chrome.html";
    const filePath = path.join(ROOT, urlPath.replace(/^\//, "").replace(/\//g, path.sep));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", function () {
      const { port } = server.address();
      resolve({ server, port, url: "http://127.0.0.1:" + port + "/" });
    });
  });
}

describe("chrome UI co-op first-apple wall grow", { timeout: 120000 }, () => {
  let serverInfo;
  let browser;

  before(async () => {
    serverInfo = await startStaticServer();
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (serverInfo && serverInfo.server) serverInfo.server.close();
  });

  it("Control tab shows Reset on goal in race; co-op first apple does not null-crash p6E", async () => {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", function (err) {
      pageErrors.push(String(err && err.message ? err.message : err));
    });

    await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });

    // Load layer scripts the same order as the mod build
    const scripts = [
      "src/shared/colors.js",
      "src/shared/protocol.js",
      "src/runtime/bridge.js",
      "src/session/ready.js",
      "src/race/scoreboard.js",
      "src/coop/state.js",
      "src/coop/session.js",
      "src/coop/native.js",
      "src/hooks/gsm.js",
      "src/net/client.js",
      "src/ui/settingsTab.js",
      "src/mod.js",
    ];
    for (const rel of scripts) {
      await page.addScriptTag({ url: "/" + rel.replace(/\\/g, "/") });
    }

    // Mount Control tab UI
    const uiOk = await page.evaluate(function () {
      window.button_color = "#1155CC";
      window.remixShowSettingsPage = function () {};
      const App = window.MultiplayerApp;
      const UI = window.MultiplayerUI;
      if (!App || !UI) return { ok: false, reason: "missing App/UI" };
      const app = new App();
      app.client = {
        connected: true,
        joined: true,
        clientId: "admin",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return {
            clientId: "admin",
            role: "player",
            ready: true,
            isAdmin: true,
            displayName: "Admin",
          };
        },
        roster: {
          mode: "race",
          roomCode: "TEST",
          sessionActive: false,
          clients: [
            {
              clientId: "admin",
              role: "player",
              ready: true,
              isAdmin: true,
              displayName: "Admin",
            },
          ],
          allowNewRuns: true,
          finishOngoingRuns: true,
          raceGoal: "best25",
        },
        setMode: function () {},
        setReady: function () {},
        setDuration: function () {},
        setRaceGoal: function () {},
      };
      app.ui = new UI(app);
      app.ui.mountSettingsTab();
      app.ui.renderRoster(app.client.roster);
      window.__mpTestApp = app;
      return { ok: true };
    });
    assert.equal(uiOk.ok, true, uiOk.reason || "UI mount");

    await page.waitForSelector("#mp-panel-control", { timeout: 5000 });
    // Connected race player — Reset on goal must show
    const resetVisible = await page.isVisible("#mp-reset-on-goal-wrap");
    assert.equal(
      resetVisible,
      true,
      "Reset on goal visible when connected race player"
    );
    const resetCb = page.locator("#mp-reset-on-goal");
    assert.equal(await resetCb.isChecked(), false, "defaults off");

    // Spectator — hide
    await page.evaluate(function () {
      const app = window.__mpTestApp;
      app.client.me = function () {
        return {
          clientId: "admin",
          role: "spectator",
          ready: false,
          isAdmin: true,
          displayName: "Admin",
        };
      };
      app.ui.renderRoster(app.client.roster);
    });
    assert.equal(
      await page.isVisible("#mp-reset-on-goal-wrap"),
      false,
      "hidden for spectator"
    );

    // Back to player for co-op hide check
    await page.evaluate(function () {
      const app = window.__mpTestApp;
      app.client.me = function () {
        return {
          clientId: "admin",
          role: "player",
          ready: true,
          isAdmin: true,
          displayName: "Admin",
        };
      };
      app.client.roster.mode = "coop";
      app.client.roster.clients = [
        { clientId: "admin", role: "player", ready: true, isAdmin: true },
        { clientId: "p2", role: "player", ready: true },
      ];
      app.ui.renderRoster(app.client.roster);
    });
    assert.equal(await page.isVisible("#mp-reset-on-goal-wrap"), false);

    // Simulate admin co-op session with null Aa, then first-apple wall grow
    const eatResult = await page.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const app = window.__mpTestApp;
      const W = 17;
      const H = 15;
      const wa = [];
      for (let y = 0; y < H; y++) {
        wa[y] = [];
        for (let x = 0; x < W; x++) wa[y][x] = 0;
      }
      // Production bug shape: wall host exists, Aa never initialized
      const game = {
        oa: {
          ka: [
            { x: 8, y: 7 },
            { x: 7, y: 7 },
            { x: 6, y: 7 },
          ],
          oa: { width: W, height: H },
        },
        Ca: { Aa: null, wa: wa },
        wa: {
          ka: [{ pos: { x: 4, y: 4 }, type: 0 }],
          oa: { oa: { width: W, height: H } },
        },
        nj: false,
      };
      window.__remixGame = game;
      window.__mpGame = game;

      app._coopSessionActive = true;
      app._coopSeatedPublish = true;
      app._coopSlots = [
        { clientId: "admin", slot: 0, oy: -1, x: 8, y: 6 },
        { clientId: "p2", slot: 1, oy: 1, x: 8, y: 8 },
      ];
      if (app.coopSession) {
        app.coopSession.enterSeating();
        app.coopSession.markSeated();
      }
      if (app.coopNative) {
        app.coopNative.sessionActive = true;
        app.coopNative.injectEnabled = true;
        app.coopNative.myClientId = "admin";
        app.coopNative.syncBridge();
      }
      window.__mpCoopSession = true;
      window.__mpCoopInject = true;

      // Seat path + begin session wall ensure
      if (Gsm.applyCoopSpawnOffset) {
        Gsm.applyCoopSpawnOffset(-1, { slot: 0, x: 8, y: 6 });
      }
      if (Gsm.ensureNativeWallMap) Gsm.ensureNativeWallMap(game.Ca);

      // Co-op tick runs at start of native tick — must prep Aa before p6E
      if (typeof window.__mpCoopOnTick === "function") {
        window.__mpCoopOnTick(game);
      }

      const before = game.Ca.Aa;
      let threw = null;
      try {
        // Obfuscated native wall grow (p6E)
        game.Ca.Aa.add({
          pos: { x: 5, y: 5 },
          wm: false,
          m0: false,
          Lh: true,
        });
        game.Ca.wa[5][5] = 1;
      } catch (e) {
        threw = String(e && e.message ? e.message : e);
      }

      // Publish wall grow like onApple
      if (app.publishCoopCollectables) {
        app._coopWallGrowArmed = true;
        app.client.connected = true;
        app.client.roster.mode = "coop";
        app.client.roster.sessionActive = true;
        app.client.me = function () {
          return { role: "player", colorId: 0 };
        };
        app.client.collectablesDelta = function () {};
        app.publishCoopCollectables(true, { wallGrow: true });
      }

      return {
        threw: threw,
        aaType: before && before.constructor && before.constructor.name,
        hasAdd: !!(before && typeof before.add === "function"),
        size: before && before.size,
        solid: game.Ca.wa[5][5],
        pageErrors: window.__fixtureErrors.slice(),
      };
    });

    assert.equal(eatResult.threw, null, "p6E.add must not throw: " + eatResult.threw);
    assert.equal(eatResult.hasAdd, true);
    assert.equal(eatResult.solid, 1);
    assert.ok(eatResult.size >= 1);
    assert.equal(pageErrors.length, 0, "no page errors: " + pageErrors.join("; "));

    await page.close();
  });
});
