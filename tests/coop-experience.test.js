"use strict";

/**
 * Co-op experience review — what players actually see from lobby → Start → HUD → teardown.
 * Complements unit/integration coverage with one walkthrough of mode-specific UX.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

const SETTINGS_HTML = `<!DOCTYPE html><html><body>
  <div id="settings-popup-pudding">
    <span>Pudding Mod Settings</span>
    <div id="ultra-settings-pager">
      <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
      <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
      <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
    </div>
    <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
    <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
    <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
  </div>
</body></html>`;

function loadUi(win) {
  global.window = win;
  global.document = win.document;
  win.button_color = "#1155CC";
  win.remixShowSettingsPage = function () {};
  win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
  win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
  win.RaceState = require(path.join(ROOT, "src/race/scoreboard.js"));
  const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
  delete require.cache[uiPath];
  require(path.join(ROOT, "src/ui/settingsTab.js"));
  return win.MultiplayerUI;
}

function loadAppModules(win) {
  global.window = win;
  global.document = win.document;
  global.HTMLElement = win.HTMLElement;
  global.requestAnimationFrame = function (fn) {
    return setTimeout(fn, 0);
  };
  global.cancelAnimationFrame = function (id) {
    clearTimeout(id);
  };
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

function adminApp(mode, extras) {
  extras = extras || {};
  const clients = extras.clients || [
    { clientId: "admin", role: "player", ready: true, isAdmin: true },
    { clientId: "p2", role: "player", ready: true },
  ];
  let sessionPayload = null;
  const app = {
    client: {
      connected: true,
      clientId: "admin",
      isAdmin: function () {
        return true;
      },
      me: function () {
        return { clientId: "admin", role: "player", ready: true };
      },
      roster: {
        mode: mode,
        sessionActive: false,
        allowNewRuns: true,
        clients: clients,
      },
      allowNewRuns: function () {
        return true;
      },
      setDuration: function () {},
      setRaceGoal: function () {},
      setMode: function (m) {
        this.roster.mode = m;
      },
      sessionStart: function (payload) {
        sessionPayload = payload || {};
      },
    },
    race: { scores: {}, spectateMode: "focus" },
    syncMySettingsAsAdmin: function () {
      return { trophy: 0, count: 1, speed: 0, size: 0 };
    },
    _lastStartPayload: function () {
      return sessionPayload;
    },
  };
  return app;
}

describe("co-op experience review", () => {
  let win;

  afterEach(() => {
    if (win && win.close) win.close();
    win = null;
  });

  describe("lobby (settings Match panel)", () => {
    it("shows the snake-color hint only in co-op, and hides race finish-ongoing", () => {
      win = new JSDOM(SETTINGS_HTML).window;
      const UI = loadUi(win);
      const app = adminApp("race");
      // Non-admin player box hosts the color hint
      app.client.isAdmin = function () {
        return false;
      };
      app.client.me = function () {
        return { clientId: "p2", role: "player", ready: true };
      };
      const ui = new UI(app);
      ui.mountSettingsTab();

      const hint = win.document.getElementById("mp-coop-color-hint");
      const finishWrap = win.document.getElementById("mp-finish-ongoing-wrap");
      const resetWrap = win.document.getElementById("mp-reset-on-goal-wrap");
      const resetCb = win.document.getElementById("mp-reset-on-goal");
      assert.ok(hint, "color hint element");
      assert.ok(finishWrap, "finish-ongoing wrap");
      assert.ok(resetWrap, "reset-on-goal wrap");
      assert.ok(resetCb, "reset-on-goal checkbox");
      assert.equal(resetCb.checked, false, "Reset on goal defaults off");

      ui.renderRoster({
        mode: "race",
        roomCode: "ABCD",
        sessionActive: false,
        clients: [
          { clientId: "admin", role: "player", ready: true },
          { clientId: "p2", role: "player", ready: true },
        ],
        allowNewRuns: true,
      });
      assert.equal(hint.style.display, "none", "no color hint in race");
      assert.ok(hint.classList.contains("hidden"));
      assert.notEqual(finishWrap.style.display, "none", "finish-ongoing visible in race");
      assert.notEqual(
        resetWrap.style.display,
        "none",
        "reset-on-goal visible for connected race player"
      );

      ui.renderRoster({
        mode: "race",
        roomCode: "ABCD",
        sessionActive: false,
        clients: [
          { clientId: "admin", role: "player", ready: true },
          { clientId: "p2", role: "spectator", ready: false },
        ],
        allowNewRuns: true,
      });
      // Still player in this fixture's me() — flip to spectator
      app.client.me = function () {
        return { clientId: "p2", role: "spectator", ready: false };
      };
      ui.renderRoster({
        mode: "race",
        roomCode: "ABCD",
        sessionActive: false,
        clients: [
          { clientId: "admin", role: "player", ready: true },
          { clientId: "p2", role: "spectator", ready: false },
        ],
        allowNewRuns: true,
      });
      assert.equal(
        resetWrap.style.display,
        "none",
        "reset-on-goal hidden for spectator"
      );

      app.client.me = function () {
        return { clientId: "p2", role: "player", ready: true };
      };
      ui.renderRoster({
        mode: "coop",
        roomCode: "ABCD",
        sessionActive: false,
        clients: [
          { clientId: "admin", role: "player", ready: true },
          { clientId: "p2", role: "player", ready: true },
        ],
        allowNewRuns: true,
      });
      assert.notEqual(hint.style.display, "none", "color hint visible in co-op");
      assert.ok(!hint.classList.contains("hidden"));
      assert.ok(
        /pick your snake color/i.test(hint.textContent || ""),
        "hint copy mentions unique color"
      );
      assert.equal(finishWrap.style.display, "none", "finish-ongoing hidden in co-op");
      assert.equal(resetWrap.style.display, "none", "reset-on-goal hidden in co-op");
    });

    it("Start match in co-op omits finishOngoingRuns (race still ships it)", () => {
      function runStart(mode) {
        const html = SETTINGS_HTML.replace(
          "</body>",
          '<button jsname="NSjDf" aria-label="Play"><svg></svg><span>Play</span></button></body>'
        );
        win = new JSDOM(html).window;
        global.window = win;
        global.document = win.document;
        win.button_color = "#1155CC";
        win.remixShowSettingsPage = function () {};
        [
          "shared/colors.js",
          "shared/protocol.js",
          "runtime/bridge.js",
          "session/ready.js",
          "race/scoreboard.js",
          "coop/state.js",
          "coop/native.js",
          "hooks/gsm.js",
          "net/client.js",
          "ui/settingsTab.js",
          "race/focus.js",
          "race/mosaic.js",
          "mod.js",
        ].forEach(function (rel) {
          const p = require.resolve(path.join(ROOT, "src", rel));
          delete require.cache[p];
          require(path.join(ROOT, "src", rel));
        });
        const MultiplayerApp =
          win.MultiplayerApp ||
          require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
        const app = new MultiplayerApp();
        let sessionPayload = null;
        app.client = {
          connected: true,
          clientId: "admin",
          isAdmin: function () {
            return true;
          },
          me: function () {
            return { clientId: "admin", role: "player", ready: true };
          },
          roster: {
            mode: mode,
            sessionActive: false,
            allowNewRuns: true,
            clients: [
              { clientId: "admin", role: "player", ready: true },
              { clientId: "p2", role: "player", ready: true },
            ],
          },
          setDuration: function () {},
          setRaceGoal: function () {},
          sessionStart: function (payload) {
            sessionPayload = payload || {};
          },
        };
        app.syncMySettingsAsAdmin = function () {
          return { trophy: 0, count: 1, speed: 0, size: 0 };
        };
        app.ui = new win.MultiplayerUI(app);
        app.ui.mountSettingsTab();
        app.ui.renderRoster(app.client.roster);
        win.document.getElementById("mp-finish-ongoing").checked = true;
        assert.equal(app.startMatchAsAdmin(), true);
        app._paintPlayAsStartMatch();
        return {
          payload: sessionPayload,
          label: win.document
            .querySelector('[jsname="NSjDf"]')
            .getAttribute("aria-label"),
        };
      }

      const coop = runStart("coop");
      assert.ok(coop.payload && coop.payload.settings);
      assert.equal(
        Object.prototype.hasOwnProperty.call(coop.payload, "finishOngoingRuns"),
        false
      );
      assert.equal(coop.label, "Start Co-op");

      const raceStart = runStart("race");
      assert.equal(raceStart.payload.finishOngoingRuns, true);
      assert.equal(raceStart.label, "Start Race");
    });
  });

  describe("in-match HUD", () => {
    it("live co-op clock + end copy (all apples / all dead / admin abort)", () => {
      win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
      const UI = loadUi(win);
      const app = {
        _coopTotal: 12,
        _coopGoal: 48,
        _coopTimerStartedAtMs: Date.now() - 12300,
        _coopScores: {
          a: { score: 7, alive: true },
          b: { score: 5, alive: false },
        },
        client: {
          connected: true,
          roster: {
            mode: "coop",
            sessionActive: true,
            clients: [
              { clientId: "a", role: "player", displayName: "Ada" },
              { clientId: "b", role: "player", displayName: "Bob" },
            ],
          },
          me: function () {
            return { clientId: "a", role: "player" };
          },
        },
      };
      const ui = new UI(app);
      ui.mountHud();
      if (!ui.hud) {
        ui.hud = win.document.createElement("div");
        win.document.body.appendChild(ui.hud);
      }

      ui.updateHud(app);
      assert.ok(ui.hud.innerHTML.indexOf("Team score:") >= 0);
      assert.ok(/12\.[0-9]s/.test(ui.hud.innerHTML), "live clock beside score");
      assert.ok(ui.hud.innerHTML.indexOf("Fill the board together") >= 0);

      app.client.roster.sessionActive = false;
      app._coopFinalTimeMs = 45100;
      app._coopEndReason = "ALL_APPLES";
      app._coopWon = true;
      ui.updateHud(app);
      assert.ok(ui.hud.innerHTML.indexOf("All apples!") >= 0);
      assert.ok(ui.hud.innerHTML.indexOf("45.1s") >= 0);

      app._coopEndReason = "ALL_DEAD";
      app._coopWon = false;
      ui.updateHud(app);
      assert.ok(ui.hud.innerHTML.indexOf("All snakes down") >= 0);

      app._coopEndReason = "aborted";
      ui.updateHud(app);
      assert.ok(ui.hud.innerHTML.indexOf("Ended by admin") >= 0);
    });
  });

  describe("session teardown", () => {
    it("endCoopNativeSession clears co-op window hooks left from a live run", () => {
      win = new JSDOM(`<!DOCTYPE html><html><body>
        <canvas class="nEoGkc" width="400" height="400"></canvas>
      </body></html>`, { url: "https://googlesnakemods.com/v/current" }).window;
      const MultiplayerApp = loadAppModules(win);
      const app = new MultiplayerApp();
      app._coopSessionActive = true;
      app.client = {
        connected: false,
        clientId: "me",
        roster: { mode: "coop", sessionActive: false, clients: [] },
        me: function () {
          return { clientId: "me", role: "player" };
        },
      };

      win.__mpCoopOnLocalReset = function () {};
      win.__mpLastCoopSpawnPose = { x: 8, y: 7, dir: "RIGHT" };
      win.__mpCoopBoardFull = true;
      win.__mpCoopSession = true;
      win.__mpCoopInject = true;

      app.endCoopNativeSession();

      assert.equal(app._coopSessionActive, false);
      assert.equal(win.__mpCoopOnLocalReset, null);
      assert.equal(win.__mpLastCoopSpawnPose, null);
      assert.equal(win.__mpCoopBoardFull, false);
      assert.equal(win.__mpCoopSession, false);
      assert.equal(win.__mpCoopInject, false);
    });
  });
});
