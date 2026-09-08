"use strict";

/**
 * Playwright: offline settings must actually CHANGE values after clicks.
 *
 * Asserts via MultiplayerGsm.readSettingIndex / puddingMenuSelect — not a fake
 * click counter.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const SETTING_IDS = ["trophy", "count", "speed", "size", "theme"];

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer(function (req, res) {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/tests/fixtures/menus-offline.html";
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

async function readSettings(page) {
  return page.evaluate(function () {
    return window.__readAllSettings();
  });
}

/** Click option index N inside a setting row; returns readSettingIndex + selected state. */
async function clickSettingOption(page, id, index) {
  return page.evaluate(
    function (pair) {
      const row = document.getElementById(pair.id);
      const opt = row && row.children[pair.index];
      if (!opt) throw new Error("missing option " + pair.id + "[" + pair.index + "]");
      opt.click();
      const Gsm = window.MultiplayerGsm;
      const idx = Gsm.readSettingIndex(pair.id);
      const selected = row.querySelector(".tuJOWd");
      return {
        index: idx,
        selectedIndex: selected ? Number(selected.dataset.index) : null,
        store: window.timeKeeper.getCurrentSetting(pair.id),
      };
    },
    { id: id, index: index }
  );
}

describe("playwright offline settings menus", { timeout: 120000 }, () => {
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

  it("clicking setting options changes readSettingIndex (pre-warm baseline)", async () => {
    const page = await browser.newPage();
    await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ url: "/src/hooks/gsm.js" });

    const before = await readSettings(page);
    for (const id of SETTING_IDS) {
      assert.equal(before[id], 0, id + " starts at 0");
    }

    // Change each setting to a non-zero index and verify Gsm sees it
    const targets = { trophy: 2, count: 3, speed: 1, size: 2, theme: 1 };
    for (const id of SETTING_IDS) {
      const res = await clickSettingOption(page, id, targets[id]);
      assert.equal(res.index, targets[id], id + " readSettingIndex after click");
      assert.equal(res.store, targets[id], id + " timeKeeper store after click");
      assert.equal(res.selectedIndex, targets[id], id + " tuJOWd on chosen option");
    }

    const after = await readSettings(page);
    assert.deepEqual(after, targets);

    // Mouse path (not only evaluate click): speed → Normal (0)
    await page.click("#speed .opt >> nth=0");
    assert.equal((await readSettings(page)).speed, 0);

    await page.close();
  });

  it("live run / hidden overlay: clicks do not change settings; quit restores changes", async () => {
    const page = await browser.newPage();
    await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ url: "/src/hooks/gsm.js" });

    await page.evaluate(function () {
      window.MultiplayerGsm.dismissDeathOverlayForRun();
      window.__mpGame.nj = false;
      window.__mpGame.dead = false;
      window.timeKeeper._dead = false;
      window.pauseGame = 0;
      window.__menuBlockedHits = 0;
    });

    const before = await readSettings(page);
    await page.evaluate(function () {
      document.querySelector("#trophy .opt:nth-child(2)").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
    });
    const mid = await readSettings(page);
    assert.deepEqual(mid, before, "settings must not change while run is live");
    assert.ok(
      (await page.evaluate(function () {
        return window.__menuBlockedHits | 0;
      })) >= 1
    );

    await page.evaluate(function () {
      window.MultiplayerGsm.quitNativeRunForMenus({ pulse: false });
      const overlay = document.querySelector(".wjOYOd");
      overlay.style.visibility = "visible";
      overlay.style.opacity = "1";
      overlay.style.pointerEvents = "";
      window.__mpGame.nj = true;
      window.__mpGame.dead = true;
      window.timeKeeper._dead = true;
      window.pauseGame = 1;
    });

    await page.click("#trophy .opt >> nth=2");
    assert.equal((await readSettings(page)).trophy, 2, "trophy changes after quit unlock");

    await page.close();
  });
});
