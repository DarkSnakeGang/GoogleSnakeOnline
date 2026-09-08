"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

const NATIVE = path.join(__dirname, "..", "src", "coop", "native.js");

test("Chromium renders three explicit Yin Yang peers without stock twins", {
  timeout: 120000,
}, async function () {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<canvas id='game' width='340' height='300'></canvas>");
    await page.evaluate(function () {
      window.__yyCalls = [];
      window.MultiplayerGsm = {
        effectiveModeKey: function () { return "yin_yang"; },
        drawWallSolverStyleSnake: function () {},
        snakeMotion: function () { return null; },
      };
    });
    await page.addScriptTag({ path: NATIVE });
    const result = await page.evaluate(function () {
      function point(x, y) {
        return {
          x: x,
          y: y,
          clone: function () { return point(this.x, this.y); },
        };
      }
      function peer(id, slot, x) {
        return {
          clientId: id,
          slot: slot,
          alive: true,
          modeKey: "yin_yang",
          body: [point(x, 5), point(x - 1, 5)],
          body2: [point(16 - x, 9), point(17 - x, 9)],
          dir: "RIGHT",
          movementDir: "RIGHT",
          headDir: "RIGHT",
          transitionDir: "RIGHT",
          movementDir2: "LEFT",
          headDir2: "LEFT",
          transitionDir2: "LEFT",
          turns: [],
        };
      }
      const local = {
        ka: [point(1, 1), point(0, 1)],
        wa: [true, true],
        direction: "RIGHT",
      };
      const game = { oa: local, settings: { modeKey: "yin_yang" } };
      const renderer = {
        wb: game,
        ka: document.getElementById("game").getContext("2d"),
        settings: { modeKey: "yin_yang" },
        render: function () {
          if (game.oa === local) return;
          window.__yyCalls.push({
            head: game.oa.ka[0].x,
            automatic: /yin.?yang/i.test(String(this.settings.modeKey)),
          });
        },
      };
      window.__mpCoopInject = true;
      window.__mpCoopSession = true;
      window.__mpCoopAuthority = "native-relay-v1";
      window.__mpCoopSpectator = false;
      window.__mpCoopServerAuth = false;
      window.__mpCoopMyId = "me";
      window.__mpCoopGeneration = 7;
      window.__mpCoopRemotes = {
        c: peer("c", 3, 12),
        a: peer("a", 1, 4),
        b: peer("b", 2, 8),
      };
      window.__mpCoopRenderEnter(renderer);
      renderer.render(0.5, true, {});
      return {
        calls: window.__yyCalls,
        restoredLocal: game.oa === local,
        restoredMode: renderer.settings.modeKey,
        metrics: window.__mpCoopNativeRendererMetrics(),
      };
    });
    assert.deepEqual(result.calls.map(function (call) { return call.head; }),
      [4, 12, 8, 8, 12, 4]);
    assert.equal(result.calls.some(function (call) { return call.automatic; }), false);
    assert.equal(result.restoredLocal, true);
    assert.equal(result.restoredMode, "yin_yang");
    assert.equal(result.metrics.backend, "layers");
    assert.equal(result.metrics.renderCount, 6);
  } finally {
    await browser.close();
  }
});
