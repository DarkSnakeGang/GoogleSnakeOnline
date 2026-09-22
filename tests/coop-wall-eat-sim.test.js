"use strict";

/**
 * Real-ish dual co-op Wall-mode eat simulation (Playwright + MultiplayerApp).
 *
 * Boots two seated players, modeKey=wall, Aa starts null (production bug shape),
 * then runs the same sequence the eater's client hits on a fruit tick:
 *   1) __mpCoopOnTick  → ensureNativeWallMap / dense wa
 *   2) head moves onto the apple (eat)
 *   3) native p6E-style Ca.Aa.add + wa solid
 *   4) timeKeeper.gotApple → wrapTimeKeeper onApple → publishCoopCollectables({wallGrow})
 * Asserts: eater does not throw / pageerror; wall planted at eater cell; peer
 * applyBoardEntities mirrors that wall list.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer(function (req, res) {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/tests/fixtures/coop-wall-chrome.html";
    const filePath = path.join(
      ROOT,
      urlPath.replace(/^\//, "").replace(/\//g, path.sep)
    );
    if (
      !filePath.startsWith(ROOT) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
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
      resolve({ server: server, port: port, url: "http://127.0.0.1:" + port + "/" });
    });
  });
}

const LAYER_SCRIPTS = [
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

describe("coop wall-mode dual eat simulation", { timeout: 120000 }, () => {
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

  it("2 players wall mode: eater apple tick does not crash; peer gets eater wall", async () => {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", function (err) {
      pageErrors.push(String(err && err.message ? err.message : err));
    });

    await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
    for (const rel of LAYER_SCRIPTS) {
      await page.addScriptTag({ url: "/" + rel.replace(/\\/g, "/") });
    }

    const result = await page.evaluate(async function () {
      function makeWallBoard(W, H) {
        const wa = [];
        for (let y = 0; y < H; y++) {
          wa[y] = [];
          for (let x = 0; x < W; x++) wa[y][x] = 0;
        }
        return {
          oa: {
            ka: [
              { x: 5, y: 5 },
              { x: 4, y: 5 },
              { x: 3, y: 5 },
            ],
            oa: { width: W, height: H },
            direction: "RIGHT",
          },
          // Production bug shape: wall host present, Aa never initialized
          Ca: { Aa: null, wa: wa },
          wa: {
            // Apple immediately to the right of the head — next step eats it
            ka: [{ pos: { x: 6, y: 5 }, type: 0 }],
            oa: { oa: { width: W, height: H } },
          },
          nj: false,
          Rb: function () {
            // Native freePos(null,5) wall pick — return a legal interior cell
            return { x: 8, y: 3 };
          },
        };
      }

      function wallKeys(walls) {
        return (walls || [])
          .map(function (w) {
            return (w.x | 0) + "," + (w.y | 0);
          })
          .sort();
      }

      window.button_color = "#1155CC";
      window.remixShowSettingsPage = function () {};
      // Wall mode (Remix ModeRegistry)
      window.ModeRegistry = {
        getCurrentModeKey: function () {
          return "wall";
        },
      };
      window.__mpCoopPlaySettings = {
        trophy: 0,
        count: 0,
        speed: 1,
        size: 1,
      };

      const App = window.MultiplayerApp;
      const UI = window.MultiplayerUI;
      const Gsm = window.MultiplayerGsm;
      if (!App || !UI || !Gsm) {
        return { ok: false, reason: "missing App/UI/Gsm" };
      }

      const W = 17;
      const H = 15;
      const eaterGame = makeWallBoard(W, H);
      const peerGame = makeWallBoard(W, H);
      // Peer starts empty fruit + null Aa too
      peerGame.wa.ka = [];
      peerGame.Ca.Aa = null;

      window.__remixGame = eaterGame;
      window.__mpGame = eaterGame;

      const published = [];
      const app = new App();
      app.client = {
        connected: true,
        joined: true,
        clientId: "eater",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return {
            clientId: "eater",
            role: "player",
            ready: true,
            isAdmin: true,
            displayName: "Eater",
            colorId: 0,
          };
        },
        roster: {
          mode: "coop",
          roomCode: "WALL",
          sessionActive: true,
          clients: [
            {
              clientId: "eater",
              role: "player",
              ready: true,
              isAdmin: true,
              displayName: "Eater",
            },
            {
              clientId: "peer",
              role: "player",
              ready: true,
              displayName: "Peer",
            },
          ],
        },
        setMode: function () {},
        setReady: function () {},
        collectablesDelta: function (cols) {
          published.push(cols);
        },
      };
      app.ui = new UI(app);
      app._coopSessionActive = true;
      app._coopSeatedPublish = true;
      app._coopAuthority = "native-relay-v1";
      app.coop.boardReady = true;
      app.coop.generation = 1;
      app._coopSlots = [
        { clientId: "eater", slot: 0, oy: -1, x: 5, y: 5, dir: "RIGHT" },
        { clientId: "peer", slot: 1, oy: 1, x: 8, y: 8, dir: "LEFT" },
      ];
      if (app.coopSession) {
        app.coopSession.enterSeating(2, "native-relay-v1");
        app.coopSession.markSeated();
      }
      if (app.coopNative) {
        app.coopNative.sessionActive = true;
        app.coopNative.injectEnabled = true;
        app.coopNative.myClientId = "eater";
        app.coopNative.syncBridge();
      }
      window.__mpCoopSession = true;
      window.__mpCoopInject = true;
      window.__mpCoopMyId = "eater";
      window.__multiplayerApp = app;

      // Production TimeKeeper wrap (onApple → wallGrow publish with real delays)
      window.timeKeeper = {
        playing: true,
        _dead: false,
        gotApple: function () {},
        gotAll: function () {},
        death: function () {},
        start: function () {
          this.playing = true;
          this._dead = false;
        },
      };
      if (typeof app.hookLocalScorePulse === "function") {
        app.hookLocalScorePulse();
      } else {
        Gsm.wrapTimeKeeper({
          onApple: function () {
            app._coopWallGrowArmed = true;
            app.publishCoopCollectables(true, { wallGrow: true });
          },
        });
      }

      // Seat / begin-session wall host repair
      if (Gsm.applyCoopSpawnOffset) {
        Gsm.applyCoopSpawnOffset(-1, {
          slot: 0,
          x: 5,
          y: 5,
          dir: "RIGHT",
        });
      }

      const steps = [];
      let threw = null;
      try {
        // --- Native tick start (co-op hook runs before p6E) ---
        if (typeof window.__mpCoopOnTick !== "function") {
          throw new Error("__mpCoopOnTick missing");
        }
        window.__mpCoopOnTick(eaterGame);
        steps.push("tick");
        if (!eaterGame.Ca.Aa || typeof eaterGame.Ca.Aa.add !== "function") {
          throw new Error("Aa not ready after tick");
        }

        // --- Head steps onto the apple (eat) ---
        const apple = eaterGame.wa.ka[0].pos;
        eaterGame.oa.ka.unshift({ x: apple.x, y: apple.y });
        eaterGame.wa.ka = []; // fruit consumed
        steps.push("eat");

        // --- Native wall grow (p6E): freePos(null,5) then Aa.add ---
        const pick = eaterGame.Rb(null, 5);
        const wallPos = { x: pick.x | 0, y: pick.y | 0 };
        eaterGame.Ca.Aa.add({
          pos: wallPos,
          wm: false,
          m0: false,
          Lh: true,
        });
        eaterGame.Ca.wa[wallPos.y][wallPos.x] = 1;
        steps.push("p6E:" + wallPos.x + "," + wallPos.y);

        // --- gotApple → wrapped onApple → publish wallGrow ---
        window.timeKeeper.gotApple(1200, 1);
        steps.push("gotApple");
      } catch (e) {
        threw = String(e && e.stack ? e.stack : e);
      }

      // Drain onApple nested setTimeouts (0ms then 50ms wallGrow publish)
      await new Promise(function (r) {
        setTimeout(r, 120);
      });

      const eaterScrape = threw
        ? null
        : Gsm.scrapeBoardEntities(eaterGame);
      const eaterKeys = eaterScrape ? wallKeys(eaterScrape.walls) : [];

      // Peer receives the eater's published walls (wire COLLECTABLES path)
      let peerKeys = [];
      let peerThrew = null;
      let peerSolid = null;
      try {
        window.__remixGame = peerGame;
        window.__mpGame = peerGame;
        const payload =
          published.length > 0
            ? published[published.length - 1]
            : eaterScrape;
        if (!payload || !payload.walls) {
          throw new Error("no wall payload published");
        }
        Gsm.applyBoardEntities({
          walls: payload.walls,
          width: W,
          height: H,
        });
        peerKeys = wallKeys(Gsm.scrapeBoardEntities(peerGame).walls);
        const wx = eaterKeys[0] && Number(eaterKeys[0].split(",")[0]);
        const wy = eaterKeys[0] && Number(eaterKeys[0].split(",")[1]);
        peerSolid =
          wx != null && peerGame.Ca.wa[wy] ? peerGame.Ca.wa[wy][wx] | 0 : -1;
      } catch (eP) {
        peerThrew = String(eP && eP.stack ? eP.stack : eP);
      }

      return {
        ok: true,
        threw: threw,
        peerThrew: peerThrew,
        steps: steps,
        modeKey: window.ModeRegistry.getCurrentModeKey(),
        players: app.client.roster.clients.filter(function (c) {
          return c.role === "player";
        }).length,
        aaReady: !!(eaterGame.Ca.Aa && eaterGame.Ca.Aa.add),
        eaterWallKeys: eaterKeys,
        peerWallKeys: peerKeys,
        peerSolid: peerSolid,
        published: published.length,
        publishedWalls:
          published.length > 0
            ? wallKeys(published[published.length - 1].walls)
            : [],
        pageErrors: window.__fixtureErrors.slice(),
      };
    });

    assert.equal(result.ok, true, result.reason || "setup");
    assert.equal(result.modeKey, "wall");
    assert.equal(result.players, 2, "co-op match has 2 players");
    assert.equal(result.threw, null, "eater must not crash: " + result.threw);
    assert.equal(result.peerThrew, null, "peer apply: " + result.peerThrew);
    assert.equal(result.aaReady, true);
    assert.ok(result.steps.indexOf("eat") >= 0);
    assert.ok(result.steps.some(function (s) {
      return String(s).indexOf("p6E:") === 0;
    }));
    assert.ok(result.steps.indexOf("gotApple") >= 0);
    assert.ok(result.published >= 1, "wallGrow publish fired");
    assert.ok(result.eaterWallKeys.length >= 1, "eater planted a wall");
    assert.deepEqual(
      result.peerWallKeys,
      result.eaterWallKeys,
      "peer walls match eater"
    );
    assert.equal(result.peerSolid, 1, "peer wa solid at eater cell");
    assert.equal(
      pageErrors.length,
      0,
      "no pageerrors: " + pageErrors.join("; ")
    );
    assert.deepEqual(
      result.pageErrors,
      [],
      "no fixture errors: " + result.pageErrors.join("; ")
    );

    await page.close();
  });
});
