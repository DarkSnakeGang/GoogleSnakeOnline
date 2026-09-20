"use strict";
const { chromium } = require("playwright");
const https = require("https");
const fs = require("fs");
const path = require("path");
const net = require("net");

const ROOT = path.join(__dirname, "..");
const CERT_DIR = path.join(ROOT, ".cache", "e2e-certs");
const KEY = path.join(CERT_DIR, "key.pem");
const CERT = path.join(CERT_DIR, "cert.pem");
const built = fs
  .readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8")
  .match(/__MP_MOD_BUILT="([^"]+)"/)[1];

function freePort() {
  return new Promise(function (res, rej) {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", function () {
      const p = s.address().port;
      s.close(function () {
        res(p);
      });
    });
    s.on("error", rej);
  });
}

(async function () {
  const port = await freePort();
  const server = https.createServer(
    { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) },
    function (req, res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      console.log("SERVE", req.method, req.url);
      res.writeHead(200, { "Content-Type": "application/javascript" });
      fs.createReadStream(path.join(ROOT, "MultiplayerMod.js")).pipe(res);
    }
  );
  await new Promise(function (r) {
    server.listen(port, "127.0.0.1", r);
  });
  const modUrl =
    "https://127.0.0.1:" +
    port +
    "/MultiplayerMod.js?t=" +
    encodeURIComponent(built);
  console.log("MOD", modUrl, "built", built);

  const browser = await chromium.launch({
    headless: true,
    args: ["--ignore-certificate-errors"],
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const logs = [];
  page.on("console", function (m) {
    logs.push("CON " + m.type() + ": " + m.text());
  });
  page.on("pageerror", function (e) {
    logs.push("ERR " + e.message);
  });
  page.on("requestfailed", function (r) {
    logs.push(
      "FAIL " + r.url() + " " + (r.failure() && r.failure().errorText)
    );
  });

  await page.goto("https://googlesnakemods.com/v/current/", {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.evaluate(function () {
    localStorage.setItem("snakeForceDevMode", "true");
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#advanced-options-toggle", { timeout: 30000 });

  const fetchProbe = await page.evaluate(async function (url) {
    try {
      const r = await fetch(url);
      const t = await r.text();
      return { ok: r.ok, status: r.status, len: t.length, head: t.slice(0, 100) };
    } catch (e) {
      return { error: String(e) };
    }
  }, modUrl);
  console.log("FETCH_PROBE", JSON.stringify(fetchProbe));

  await page.evaluate(function (url) {
    const el = document.getElementById("mod-selector-dialogue-container");
    if (el) el.style.display = "block";
    document.getElementById("advanced-options-toggle").click();
    document.getElementById("custom-mod-name").value = "MultiplayerMod";
    document
      .getElementById("custom-mod-name")
      .dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("custom-url").value = url;
    document
      .getElementById("custom-url")
      .dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("advanced-options-toggle").click();
    const radio = document.querySelector('input[type=radio][value=customUrl]');
    if (radio) {
      radio.checked = true;
      radio.click();
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, modUrl);

  const stateBefore = await page.evaluate(function () {
    return {
      chosen: localStorage.getItem("snakeChosenMod"),
      adv: localStorage.getItem("snakeAdvancedSettings"),
      radioChecked: !!(
        document.querySelector('input[value=customUrl]') &&
        document.querySelector('input[value=customUrl]').checked
      ),
    };
  });
  console.log("BEFORE", JSON.stringify(stateBefore));

  page.once("dialog", function (d) {
    console.log("DIALOG", d.message());
    d.accept();
  });
  await page.evaluate(function () {
    document.getElementById("apply-mod").click();
  });
  await new Promise(function (r) {
    setTimeout(r, 12000);
  });

  const after = await page.evaluate(function () {
    return {
      chosen: localStorage.getItem("snakeChosenMod"),
      adv: localStorage.getItem("snakeAdvancedSettings"),
      built: window.__MP_MOD_BUILT || null,
      ver: window.__MP_MOD_VERSION || null,
      hasMP: !!window.MultiplayerMod,
      indicator:
        (document.getElementById("mod-indicator") &&
          document.getElementById("mod-indicator").textContent) ||
        null,
    };
  });
  console.log("AFTER", JSON.stringify(after, null, 2));
  console.log("LOGS_TAIL\n" + logs.slice(-50).join("\n"));
  await browser.close();
  server.close();
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
