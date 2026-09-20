const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "../..");

function menuDom() {
  return new JSDOM(
    `<!DOCTYPE html><html><body>
  <div class="wjOYOd"><div>
    <div id="trophy"><div class="tuJOWd"></div></div>
    <div id="count"><div class="tuJOWd"></div></div>
    <div id="speed"><div class="tuJOWd"></div></div>
    <div id="size"><div class="tuJOWd"></div></div>
    <button jsname="NSjDf">Play</button>
  </div></div>
  <canvas class="nEoGkc"></canvas>
</body></html>`,
    { url: "https://example.test/", pretendToBeVisual: true }
  ).window;
}

function loadApp(win) {
  global.window = win;
  global.document = win.document;
  global.HTMLElement = win.HTMLElement;
  global.KeyboardEvent = win.KeyboardEvent;
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
  return win.MultiplayerApp;
}

const win = menuDom();
const MultiplayerApp = loadApp(win);
const app = new MultiplayerApp();
app.client = {
  connected: true,
  clientId: "admin",
  isAdmin: function () {
    return true;
  },
  me: function () {
    return { clientId: "admin", role: "player" };
  },
  roster: {
    mode: "coop",
    sessionActive: true,
    adminId: "admin",
    clients: [{ clientId: "admin", role: "player" }],
  },
  sessionEnd: function () {},
};
app.ui = { updateHud: function () {}, renderRoster: function () {} };
app._coopSessionActive = true;

const t0 = Date.now();
const times = [];
win.document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") {
    times.push({
      t: Date.now() - t0,
      stack: new Error().stack.split("\n").slice(2, 9).map(function (s) {
        return s.trim();
      }),
    });
  }
});

const realST = setTimeout;
let schedLog = [];
global.setTimeout = function (fn, ms) {
  if (ms === 80 || ms === 0 || ms === 5) {
    schedLog.push({ ms: ms, t: Date.now() - t0 });
  }
  return realST(fn, ms);
};

win.__mpEscHandling = true;
app.abortMatchAsAdmin("ui");

realST(function () {
  console.log("at5 times", JSON.stringify(times, null, 2));
  console.log("sched", JSON.stringify(schedLog));
}, 5);
realST(function () {
  console.log("at100 n", times.length);
  process.exit(0);
}, 100);
