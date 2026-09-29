"use strict";

/**
 * Connect-only live check against the public server (no local room process).
 * Same GSM "Load from url" flow as wall-coop-dual-live.js, then Connect.
 *
 *   node tools/duckdns-connect-live.js
 *   node tools/duckdns-connect-live.js --strict            # no cert / LNA overrides (like a real browser)
 *   node tools/duckdns-connect-live.js --firefox --strict
 *   node tools/duckdns-connect-live.js --strict --exe=<browser.exe> --user-data-dir=<copy of a real profile>
 *   node tools/duckdns-connect-live.js --strict --load-extension=<unpacked extension dir>
 *   node tools/duckdns-connect-live.js --strict --slow     # 0.5 s between steps, highlighted, window stays open
 *   MP_WS_URL=wss://host:7777/ws MP_ROOM=ABCD node tools/duckdns-connect-live.js
 *
 * Screenshot → .cache/e2e/duckdns-connect/
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const GSM_URL = process.env.MP_E2E_GSM_URL || "https://googlesnakemods.com/v/current/";
const WS_URL = process.env.MP_WS_URL || "wss://yarmiplay.duckdns.org:7777/ws";
const ROOM = process.env.MP_ROOM || "";
const STRICT = process.argv.includes("--strict");
const FIREFOX = process.argv.includes("--firefox");
const HEADLESS = process.argv.includes("--headless");
function argValue(name) {
  const hit = process.argv.find(function (a) { return a.indexOf(name + "=") === 0; });
  return hit ? hit.slice(name.length + 1) : "";
}
const DENY_LNA = process.argv.includes("--deny-lna");
const SLOW = process.argv.includes("--slow");
const STEP_MS = SLOW ? 500 : 0;
let stepNo = 0;

async function step(page, label, selector) {
  if (!SLOW) return;
  stepNo += 1;
  console.log("[duckdns-connect] step " + stepNo + ": " + label);
  if (selector) {
    await page
      .evaluate(function (sel) {
        const el = document.querySelector(sel);
        if (!el) return;
        el.scrollIntoView({ block: "center", inline: "center" });
        el.style.outline = "3px solid #ff3b3b";
        el.style.outlineOffset = "2px";
        setTimeout(function () { el.style.outline = ""; el.style.outlineOffset = ""; }, 1200);
      }, selector)
      .catch(function () {});
  }
  await page.waitForTimeout(STEP_MS);
}

async function typeInto(page, selector, value) {
  await step(page, "type " + JSON.stringify(value) + " into " + selector, selector);
  const visible = await page.isVisible(selector).catch(function () { return false; });
  if (SLOW && visible) {
    await page.fill(selector, "");
    await page.type(selector, value, { delay: 35 });
    return;
  }
  await page.evaluate(function (a) {
    const el = document.querySelector(a.sel);
    el.value = a.v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, { sel: selector, v: value });
}
const EXE = argValue("--exe");
const LOAD_EXTENSION = argValue("--load-extension");
const USER_DATA_DIR =
  argValue("--user-data-dir") ||
  (LOAD_EXTENSION ? fs.mkdtempSync(path.join(require("os").tmpdir(), "mp-ext-")) : "");
const DUMP = path.join(ROOT, ".cache", "e2e", "duckdns-connect");
const FAKE_MOD_ORIGIN = "https://mp-e2e.local";

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
            Object.defineProperty(xhr, "readyState", { get: function () { return 4; } });
            Object.defineProperty(xhr, "status", { get: function () { return 200; } });
            Object.defineProperty(xhr, "responseText", { get: function () { return body; } });
            Object.defineProperty(xhr, "response", { get: function () { return body; } });
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
  await step(page, "open " + GSM_URL);
  await page.goto(GSM_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(
    function () { return typeof window.snakeSetDevMode === "function"; },
    null,
    { timeout: 60000 }
  );
  await step(page, "enable GSM dev mode and reload");
  await page.evaluate(function () { localStorage.setItem("snakeForceDevMode", "true"); });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#advanced-options-toggle", { timeout: 60000 });
  await step(page, "show the mod selector");
  await page.evaluate(function () {
    const el = document.getElementById("mod-selector-dialogue-container");
    if (el) el.style.display = "block";
  });
  await page.waitForSelector('input[type="radio"][value="customUrl"]', { timeout: 30000 });
  await step(page, "open advanced options (Load from url)", "#advanced-options-toggle");
  await page.click("#advanced-options-toggle");
  await page.waitForSelector("#mod-selector-dialogue.show-settings-page", { timeout: 10000 });
  await typeInto(page, "#custom-mod-name", "MultiplayerMod");
  await typeInto(page, "#custom-url", modUrl);
  await step(page, "close advanced options", "#advanced-options-toggle");
  await page.click("#advanced-options-toggle");
  await step(page, "pick the custom url mod", 'input[type="radio"][value="customUrl"]');
  await page.click('input[type="radio"][value="customUrl"]');
  page.once("dialog", function (d) { d.accept().catch(function () {}); });
  await step(page, "apply mod", "#apply-mod");
  await page.evaluate(function () { document.getElementById("apply-mod").click(); });
  await page.waitForFunction(
    function (wantBuilt) {
      return (
        window.__MP_MOD_BUILT === wantBuilt &&
        window.MultiplayerMod &&
        typeof window.MultiplayerMod.alterSnakeCode === "function"
      );
    },
    expectedBuilt,
    { timeout: 180000 }
  );
}

async function connect(page, wsUrl, displayName, roomCode) {
  await page.waitForFunction(
    function () { return !!(window.__multiplayerApp && window.__multiplayerApp.ui); },
    null,
    { timeout: 60000 }
  );
  await step(page, "open the multiplayer settings panel");
  await page.evaluate(function () {
    const ind = document.getElementById("mod-indicator");
    if (ind) ind.style.pointerEvents = "none";
    window.__multiplayerApp.ui.openPuddingSettings("control");
  });
  await page.waitForSelector("#mp-server-url", { state: "attached", timeout: 15000 });
  await typeInto(page, "#mp-server-url", wsUrl);
  await typeInto(page, "#mp-display-name", displayName);
  await typeInto(page, "#mp-room-code", roomCode);
  await step(page, "click Connect", "#mp-conn-toggle");
  const toggleVisible = await page.isVisible("#mp-conn-toggle").catch(function () { return false; });
  if (SLOW && toggleVisible) {
    await page.click("#mp-conn-toggle");
  } else {
    await page.evaluate(function () { document.getElementById("mp-conn-toggle").click(); });
  }
  let status = "";
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    status = await page.$eval("#mp-status", function (e) { return e.textContent; });
    if (!/Connecting/.test(status)) break;
  }
  const client = await page.evaluate(function () {
    const c = window.__multiplayerApp.client;
    return c ? { url: c.url, connected: !!c.connected, joined: !!c.joined, roomCode: c.roomCode } : null;
  });
  return { status: status, client: client };
}

async function main() {
  fs.mkdirSync(DUMP, { recursive: true });
  const modSource = fs.readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8");
  const m = modSource.slice(0, 400).match(/window\.__MP_MOD_BUILT="([^"]+)"/);
  if (!m) throw new Error("rebuild MultiplayerMod.js");
  const built = m[1];
  const modUrl = FAKE_MOD_ORIGIN + "/MultiplayerMod.js?t=" + encodeURIComponent(built);

  const { chromium, firefox } = require("playwright");
  const chromeArgs = STRICT
    ? ["--mute-audio"]
    : [
        "--ignore-certificate-errors",
        "--mute-audio",
        "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessPermissionPrompt",
      ];
  const ctxOpts = { viewport: { width: 900, height: 820 } };
  if (!STRICT) {
    ctxOpts.ignoreHTTPSErrors = true;
    if (!FIREFOX) ctxOpts.permissions = ["local-network-access"];
  }
  let browser = null;
  let ctx;
  if (USER_DATA_DIR) {
    // A real profile (extensions, blockers, site permissions) — Playwright disables extensions by default.
    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, Object.assign({}, ctxOpts, {
      headless: false,
      executablePath: EXE || undefined,
      args: LOAD_EXTENSION
        ? chromeArgs.concat(["--disable-extensions-except=" + LOAD_EXTENSION, "--load-extension=" + LOAD_EXTENSION])
        : chromeArgs,
      ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    }));
  } else {
    browser = FIREFOX
      ? await firefox.launch({ headless: HEADLESS })
      : await chromium.launch({
          headless: HEADLESS,
          executablePath: EXE || undefined,
          args: chromeArgs.concat(["--window-size=960,900"]),
        });
    ctx = await browser.newContext(ctxOpts);
  }
  if (DENY_LNA && !FIREFOX) {
    const cdp = await (browser ? browser.newBrowserCDPSession() : ctx.browser() && ctx.browser().newBrowserCDPSession());
    if (cdp) {
      await cdp.send("Browser.setPermission", {
        permission: { name: "local-network-access" },
        setting: "denied",
        origin: new URL(GSM_URL).origin,
      });
    }
  }
  const page = await ctx.newPage();
  const trace = [];
  page.on("pageerror", function (e) { trace.push("pageerror " + (e && e.message)); });
  page.on("requestfailed", function (r) {
    trace.push("requestfailed " + r.url().slice(0, 140) + " " + ((r.failure() && r.failure().errorText) || ""));
  });
  page.on("websocket", function (ws) {
    trace.push("ws " + ws.url());
    ws.on("socketerror", function (e) { trace.push("ws socketerror " + e); });
    ws.on("close", function () { trace.push("ws close"); });
    ws.on("framereceived", function (f) { trace.push("ws recv " + String(f.payload).slice(0, 90)); });
  });
  page.on("console", function (msg) {
    if (/websocket|ERR_(CERT|SSL|NAME|CONNECTION|BLOCKED)|certificate|\[Multiplayer\]/i.test(msg.text())) {
      trace.push("console." + msg.type() + " " + msg.text().slice(0, 200));
    }
  });

  const label =
    (FIREFOX ? "firefox" : EXE ? path.basename(EXE) : "chromium") +
    (browser ? " " + browser.version() : "") +
    (LOAD_EXTENSION ? " extension=" + path.basename(path.dirname(LOAD_EXTENSION)) : USER_DATA_DIR ? " profile=" + USER_DATA_DIR : "") +
    (STRICT ? " strict" : " test-flags");
  console.log("[duckdns-connect]", label, "→", WS_URL);
  try {
    await loadModFromUrl(ctx, page, modUrl, built, modSource);
    console.log("[duckdns-connect] mod loaded", built);
    const lna = function () {
      return page.evaluate(function () {
        return navigator.permissions
          .query({ name: "local-network-access" })
          .then(function (p) { return p.state; }, function (e) { return "n/a (" + e.message + ")"; });
      });
    };
    trace.push("local-network-access before connect: " + (await lna()));
    const res = await connect(page, WS_URL, "duckdns-probe", ROOM);
    trace.push("local-network-access after connect: " + (await lna()));
    await page.screenshot({ path: path.join(DUMP, (FIREFOX ? "firefox" : "chromium") + ".png") });
    console.log("[duckdns-connect] status:", res.status);
    console.log("[duckdns-connect] client:", JSON.stringify(res.client));
    console.log(trace.join("\n"));
    process.exitCode = res.client && res.client.joined ? 0 : 1;
    if (SLOW && !HEADLESS) {
      console.log("[duckdns-connect] leaving the window open — close it when you're done (auto-closes in 3 min)");
      await page.waitForEvent("close", { timeout: 180000 }).catch(function () {});
    }
  } finally {
    await (browser || ctx).close();
  }
}

main().catch(function (e) {
  console.error("[duckdns-connect] FAILED:", e && e.message);
  process.exit(1);
});
