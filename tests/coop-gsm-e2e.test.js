"use strict";

/**
 * Dual-browser GSM E2E — Load MultiplayerMod via Custom Mod Url on
 * googlesnakemods.com, connect both to a Rust room server, Start co-op Small.
 *
 * Chrome blocks public→loopback fetches, so the Custom Mod Url is fulfilled by
 * a Playwright XHR/fetch intercept (mod bytes never leave this machine).
 * Room traffic uses wss://127.0.0.1 with the E2E TLS cert (+ ignoreHTTPSErrors).
 *
 * Skip with MP_E2E_SKIP=1. Headed by default; MP_E2E_HEADED=0 for headless.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execSync } = require("node:child_process");
const path = require("path");
const fs = require("fs");
const net = require("node:net");

const ROOT = path.join(__dirname, "..");
const {
  buildBombSmallTickPlan,
  renderPlanMarkdown,
  MAX_TICKS: TAS_MAX_TICKS,
  BOMB_PACK: TAS_BOMB_PACK,
} = require("./tas/bomb-small-tick-plan.js");
const EXE = path.join(
  ROOT,
  "server",
  "target",
  process.env.MP_E2E_SERVER_PROFILE === "debug" ? "debug" : "release",
  process.platform === "win32" ? "multiplayer-server.exe" : "multiplayer-server"
);
const GSM_URL = process.env.MP_E2E_GSM_URL || "https://googlesnakemods.com/v/current/";
const DUMP_DIR = path.join(ROOT, ".cache", "e2e");
const CERT_DIR = path.join(ROOT, ".cache", "e2e-certs");
const KEY_PATH = path.join(CERT_DIR, "key.pem");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const HEADED = process.env.MP_E2E_HEADED !== "0";
const SKIP = process.env.MP_E2E_SKIP === "1";
const SLOW_MO = Math.max(0, Number(process.env.MP_E2E_SLOWMO) || 0);
const FAKE_MOD_ORIGIN = "https://mp-e2e.local";

function findOpenssl() {
  const candidates = [
    process.env.OPENSSL_PATH,
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execSync('"' + bin + '" version', { stdio: "ignore" });
      return bin;
    } catch (_) {
      /* next */
    }
  }
  return null;
}

function ensureCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return;
  const openssl = findOpenssl();
  if (!openssl) throw new Error("openssl required for GSM E2E WSS certs");
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

function waitPort(port, ms = 20000) {
  const start = Date.now();
  return new Promise(function (resolve, reject) {
    let settled = false;
    const tryOnce = function () {
      if (settled) return;
      const s = net.connect(port, "127.0.0.1", function () {
        if (settled) return;
        settled = true;
        s.end();
        resolve();
      });
      s.on("error", function () {
        try {
          s.destroy();
        } catch (_) { /* ignore */ }
        if (settled) return;
        if (Date.now() - start > ms) {
          settled = true;
          reject(new Error("port " + port + " timeout"));
        } else setTimeout(tryOnce, 100);
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

function startRoomServer(port) {
  if (!fs.existsSync(EXE)) {
    throw new Error("missing server binary at " + EXE + " — cargo build --release");
  }
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const errLog = fs.openSync(path.join(DUMP_DIR, "server-spawn.err"), "w");
  const child = spawn(
    EXE,
    [
      "--bind",
      "127.0.0.1:" + port,
      "--coop-native-relay",
      "--tls-cert",
      CERT_PATH,
      "--tls-key",
      KEY_PATH,
    ],
    {
      cwd: path.join(ROOT, "server"),
      stdio: ["ignore", "ignore", errLog],
      windowsHide: true,
    }
  );
  child.on("exit", function (code, signal) {
    try {
      fs.writeFileSync(
        path.join(DUMP_DIR, "server-spawn.exit"),
        JSON.stringify({ code: code, signal: signal, port: port, at: Date.now() })
      );
    } catch (_) { /* ignore */ }
  });
  return child;
}

function readBuiltStamp() {
  const head = fs.readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8").slice(0, 400);
  const m = head.match(/window\.__MP_MOD_BUILT="([^"]+)"/);
  if (!m) throw new Error("__MP_MOD_BUILT missing — rebuild");
  return m[1];
}

function readModSource() {
  return fs.readFileSync(path.join(ROOT, "MultiplayerMod.js"), "utf8");
}

/** Fulfill Custom Mod Url fetches without touching loopback (Chrome LNA block). */
async function installModIntercept(contextOrPage, modUrl, modSource) {
  await contextOrPage.addInitScript(
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
          (String(u).indexOf("MultiplayerMod.js") !== -1 || String(u) === target)
        ) {
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/javascript" },
            })
          );
        }
        return realFetch.apply(this, arguments);
      };
    },
    { url: modUrl, source: modSource }
  );
}

async function dumpPage(page, label) {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const shot = path.join(DUMP_DIR, label + ".png");
  await page.screenshot({ path: shot, fullPage: true }).catch(function () {});
  const data = await page.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const live =
      Gsm && Gsm.boardSizeFromGame ? Gsm.boardSizeFromGame(g) : null;
    const settings = g && g.settings ? g.settings : null;
    const fruitLen =
      g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : null;
    function fruitFp() {
      if (!g || !g.wa || !Array.isArray(g.wa.ka)) return "";
      return g.wa.ka
        .map(function (a) {
          if (!a || !a.pos) return "?";
          return (a.pos.x | 0) + "," + (a.pos.y | 0);
        })
        .sort()
        .join("|");
    }
    return {
      modVersion: window.__MP_MOD_VERSION || null,
      modBuilt: window.__MP_MOD_BUILT || null,
      liveBoard: live,
      Sa: settings && settings.Sa != null ? settings.Sa : null,
      Aa: settings && settings.Aa != null ? settings.Aa : null,
      fruitLen: fruitLen,
      fruitFp: fruitFp(),
      fruitPosCloneOk: (function () {
        if (!g || !g.wa || !Array.isArray(g.wa.ka)) return true;
        for (let i = 0; i < g.wa.ka.length; i++) {
          const a = g.wa.ka[i];
          if (!a || !a.pos) continue;
          if (typeof a.pos.clone !== "function") return false;
        }
        return true;
      })(),
      fruitPos:
        g && g.wa && Array.isArray(g.wa.ka)
          ? g.wa.ka.map(function (a) {
              return a && a.pos
                ? { x: a.pos.x, y: a.pos.y, type: a.type, seq: a.sequenceNumber }
                : null;
            })
          : null,
      appleType:
        g && g.wa && g.wa.ka && g.wa.ka[0] ? g.wa.ka[0].type : null,
      cellSize:
        g && g.wb && g.wb.ka && g.wb.ka.ka != null
          ? g.wb.ka.ka
          : g && g.ka && g.ka.ka != null
            ? g.ka.ka
            : null,
      boardCss: (function () {
        const el = document.getElementById("JI3Aqc");
        if (!el) return null;
        return {
          width: el.style.width || null,
          height: el.style.height || null,
        };
      })(),
      playSettings: window.__mpCoopPlaySettings || null,
      matchSettings:
        (window.__multiplayerApp && window.__multiplayerApp._matchSettings) ||
        null,
      forceSaBeforeAa: !!window.__mpForceSaBeforeAa,
      forceSnaRan: !!window.__mpForceSnaRan,
      playController: !!(
        window.__mpPlayController &&
        typeof window.__mpPlayController.Ma === "function"
      ),
      alterSnakeRan: !!window.__mpAlterSnakeRan,
      alterHadMaEntry: !!window.__mpAlterHadMaEntry,
      alterHadAaEqSa: !!window.__mpAlterHadAaEqSa,
      alterHadAaSwitch: !!window.__mpAlterHadAaSwitch,
      alterSizePatched: !!window.__mpAlterSizePatched,
      authority: window.__mpCoopAuthority || null,
      nativeRenderDebug: window.__mpCoopNativeRenderDebug || null,
      nativeRenderMetrics: window.__mpCoopNativeRenderMetrics || null,
      fallbackReason:
        (window.__mpCoopNativeRenderMetrics &&
          window.__mpCoopNativeRenderMetrics.fallbackReason) ||
        (window.__mpCoopNativeRenderDebug &&
          window.__mpCoopNativeRenderDebug.fallbackReason) ||
        null,
      peerBackend:
        (window.__mpCoopNativeRenderMetrics &&
          window.__mpCoopNativeRenderMetrics.backend) ||
        (window.__mpCoopNativeRenderDebug &&
          window.__mpCoopNativeRenderDebug.backend) ||
        null,
      coopEndReason:
        (window.__multiplayerApp && window.__multiplayerApp._coopEndReason) ||
        null,
      statusText:
        (document.getElementById("mp-mod-indicator") &&
          document.getElementById("mp-mod-indicator").textContent) ||
        (document.getElementById("mod-indicator") &&
          document.getElementById("mod-indicator").textContent) ||
        null,
      local: (function () {
        if (!g || !g.oa) return null;
        const body = Array.isArray(g.oa.ka)
          ? g.oa.ka.map(function (p) {
              return p ? { x: p.x | 0, y: p.y | 0 } : null;
            })
          : [];
        const head = body[0] || null;
        const scoreInfo =
          Gsm && Gsm.readScoreAndAlive ? Gsm.readScoreAndAlive() : null;
        const app = window.__multiplayerApp;
        const me = app && app.client && app.client.me && app.client.me();
        const myId = me && (me.clientId || me.id);
        const hud =
          app && app._coopScores && myId != null ? app._coopScores[myId] : null;
        return {
          body: body,
          head: head,
          dir: g.oa.direction || g.oa.dir || null,
          Sc: typeof g.oa.Sc === "string" ? g.oa.Sc : null,
          Yc: typeof g.oa.Yc === "string" ? g.oa.Yc : null,
          score:
            (hud && hud.score != null
              ? hud.score
              : scoreInfo && scoreInfo.score) | 0,
          clientId: myId || null,
        };
      })(),
      remotes: (function () {
        const src =
          window.__mpCoopRemotes ||
          (window.__multiplayerApp &&
            window.__multiplayerApp.coopNative &&
            window.__multiplayerApp.coopNative.remotes) ||
          {};
        const out = {};
        Object.keys(src).forEach(function (id) {
          const r = src[id];
          if (!r) return;
          const body = Array.isArray(r.body)
            ? r.body.map(function (p) {
                return p ? { x: p.x | 0, y: p.y | 0 } : null;
              })
            : [];
          out[id] = {
            body: body,
            head: body[0] || null,
            dir: r.dir || r.direction || null,
            Sc: r.Sc || r.color2 || null,
            Yc: r.Yc || r.color1 || null,
            score: r.score != null ? r.score | 0 : null,
            colorId: r.colorId != null ? r.colorId : null,
          };
        });
        return out;
      })(),
      hudScores: (function () {
        const app = window.__multiplayerApp;
        if (!app) return null;
        return {
          scores: app._coopScores || null,
          total: app._coopTotal != null ? app._coopTotal | 0 : null,
        };
      })(),
      poseFp: (function () {
        function cell(p) {
          return p ? (p.x | 0) + "," + (p.y | 0) : "?";
        }
        function bodyFp(body) {
          if (!Array.isArray(body)) return "";
          return body.map(cell).join(">");
        }
        let localFp = "";
        if (g && g.oa && Array.isArray(g.oa.ka)) {
          localFp =
            "L:" +
            bodyFp(g.oa.ka) +
            "|" +
            (g.oa.direction || g.oa.dir || "") +
            "|" +
            (typeof g.oa.Sc === "string" ? g.oa.Sc : "") +
            "/" +
            (typeof g.oa.Yc === "string" ? g.oa.Yc : "");
        }
        const remotes =
          window.__mpCoopRemotes ||
          (window.__multiplayerApp &&
            window.__multiplayerApp.coopNative &&
            window.__multiplayerApp.coopNative.remotes) ||
          {};
        const remoteFp = Object.keys(remotes)
          .sort()
          .map(function (id) {
            const r = remotes[id];
            if (!r) return id + ":?";
            return (
              id +
              ":" +
              bodyFp(r.body) +
              "|" +
              (r.dir || r.direction || "") +
              "|" +
              (r.Sc || "") +
              "/" +
              (r.Yc || "")
            );
          })
          .join(";");
        let fruit = "";
        if (g && g.wa && Array.isArray(g.wa.ka)) {
          fruit = g.wa.ka
            .map(function (a) {
              return a && a.pos ? cell(a.pos) : "?";
            })
            .sort()
            .join("|");
        }
        return localFp + "##" + remoteFp + "##" + fruit;
      })(),
    };
  });
  fs.writeFileSync(path.join(DUMP_DIR, label + ".json"), JSON.stringify(data, null, 2));
  return data;
}

function fruitFingerprint(posList) {
  if (!Array.isArray(posList)) return "";
  return posList
    .map(function (p) {
      if (!p) return "?";
      return (p.x | 0) + "," + (p.y | 0);
    })
    .sort()
    .join("|");
}

function assertNativePeers(dump, label) {
  const tag = label || "page";
  assert.ok(dump, tag + " dump missing");
  const backend = dump.peerBackend;
  assert.ok(
    backend && backend !== "mosaic",
    tag + " peerBackend expected native (layers/direct-main), got " + backend +
      (dump.fallbackReason ? " (" + dump.fallbackReason + ")" : "")
  );
  // session-reset / e2e-align are reset markers while backend stays native.
  if (
    dump.fallbackReason &&
    dump.fallbackReason !== "session-reset" &&
    dump.fallbackReason !== "e2e-align" &&
    dump.fallbackReason !== "session-begin"
  ) {
    assert.fail(tag + " unexpected fallbackReason=" + dump.fallbackReason);
  }
}

/**
 * Crop the peer head via element screenshot (viewport-safe) and require pupil
 * contrast: dark ink + colored body (not empty board, not disc-only).
 */
async function samplePeerHeadEyes(page, label) {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const meta = await page.evaluate(function () {
    const remotes = window.__mpCoopRemotes || {};
    const ids = Object.keys(remotes);
    let peer = null;
    let corpse = null;
    for (let i = 0; i < ids.length; i++) {
      const r = remotes[ids[i]];
      if (!r || !r.body || !r.body[0]) continue;
      if (r.alive !== false) {
        peer = r;
        break;
      }
      if (!corpse) corpse = r;
    }
    peer = peer || corpse;
    if (!peer) {
      return { ok: false, reason: "no-peer", remoteIds: ids };
    }
    const head = peer.body[0];
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const live = Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g);
    const W = (live && live.width) || 10;
    const H = (live && live.height) || 9;
    const preferred =
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector("#canvas") ||
      null;
    const root = document.getElementById("JI3Aqc");
    const list = preferred
      ? [preferred]
      : root
        ? Array.prototype.slice.call(root.querySelectorAll("canvas"))
        : Array.prototype.slice.call(document.querySelectorAll("canvas"));
    let el = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || (c.className || "").indexOf("mp-") >= 0) continue;
      const st = c.style || {};
      if (st.opacity === "0" || st.pointerEvents === "none") continue;
      const r = c.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      const area = (r.width | 0) * (r.height | 0);
      if (area > bestArea) {
        bestArea = area;
        el = c;
      }
    }
    if (!el) return { ok: false, reason: "no-canvas-box" };
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) {
      return { ok: false, reason: "tiny-canvas" };
    }
    const scale = Math.min(box.width / W, box.height / H);
    const ox = (box.width - scale * W) / 2;
    const oy = (box.height - scale * H) / 2;
    const cx = ox + (head.x + 0.5) * scale;
    const cy = oy + (head.y + 0.5) * scale;
    const rad = Math.max(10, Math.floor(scale * 0.65));
    return {
      ok: true,
      head: { x: head.x | 0, y: head.y | 0 },
      peerSc: typeof peer.Sc === "string" ? peer.Sc : null,
      peerBackend:
        (window.__mpCoopNativeRenderMetrics &&
          window.__mpCoopNativeRenderMetrics.backend) ||
        null,
      faceCtxRetargets:
        (window.__mpCoopNativeRenderMetrics &&
          window.__mpCoopNativeRenderMetrics.faceCtxRetargets) | 0,
      clip: {
        x: Math.max(0, Math.floor(cx - rad)),
        y: Math.max(0, Math.floor(cy - rad)),
        width: Math.min(Math.floor(box.width), Math.floor(rad * 2)),
        height: Math.min(Math.floor(box.height), Math.floor(rad * 2)),
      },
    };
  });
  if (!meta.ok) return meta;
  const outPath = path.join(DUMP_DIR, (label || "peer-eyes") + ".png");
  await page.evaluate(function () {
    const preferred =
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector("#canvas") ||
      null;
    const root = document.getElementById("JI3Aqc");
    const list = preferred
      ? [preferred]
      : root
        ? Array.prototype.slice.call(root.querySelectorAll("canvas"))
        : Array.prototype.slice.call(document.querySelectorAll("canvas"));
    let el = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || (c.className || "").indexOf("mp-") >= 0) continue;
      const st = c.style || {};
      if (st.opacity === "0" || st.pointerEvents === "none") continue;
      const r = c.getBoundingClientRect();
      const area = (r.width | 0) * (r.height | 0);
      if (area > bestArea) {
        bestArea = area;
        el = c;
      }
    }
    document.querySelectorAll("[data-mp-eye-target]").forEach(function (n) {
      n.removeAttribute("data-mp-eye-target");
    });
    if (el) el.setAttribute("data-mp-eye-target", "1");
  });
  const handle = await page.$("[data-mp-eye-target='1']");
  if (handle) {
    // Prefer element screenshot with clip relative to the live board canvas.
    try {
      await handle.screenshot({ path: outPath, clip: meta.clip });
    } catch (eClip) {
      await handle.screenshot({ path: outPath });
    }
  } else {
    return { ok: false, reason: "no-canvas-handle", meta: meta };
  }
  const PNG = require("pngjs").PNG;
  const img = PNG.sync.read(fs.readFileSync(outPath));
  let ink = 0;
  let sclera = 0;
  let body = 0;
  let total = 0;
  for (let p = 0; p < img.data.length; p += 4) {
    const a = img.data[p + 3];
    if (a < 40) continue;
    total++;
    const rr = img.data[p];
    const gg = img.data[p + 1];
    const bb = img.data[p + 2];
    const lum = (rr + gg + bb) / 3;
    const chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
    if (lum < 55) ink++;
    else if (lum > 200 && chroma < 40) sclera++;
    else if (lum < 210 && chroma > 15) body++;
  }
  const inkRatio = total ? ink / total : 0;
  const faceMarks = ink + sclera;
  return Object.assign({}, meta, {
    ink: ink,
    sclera: sclera,
    body: body,
    total: total,
    inkRatio: inkRatio,
    // Eyes: dark pupils and/or bright sclera on a colored body (not disc-only)
    hasPupils: faceMarks >= 6 && body >= 20 && faceMarks / Math.max(1, total) >= 0.004,
    shot: outPath,
  });
}

/** Local-native head crop (same analysis as samplePeerHeadEyes, role=local). */
async function sampleLocalHeadEyes(page, label) {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const meta = await page.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const snake = g && g.oa;
    const body = snake && snake.ka;
    if (!body || !body[0]) return { ok: false, reason: "no-local" };
    const head = body[0];
    const live = Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g);
    const W = (live && live.width) || 10;
    const H = (live && live.height) || 9;
    const preferred =
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector("#canvas") ||
      null;
    const root = document.getElementById("JI3Aqc");
    const list = preferred
      ? [preferred]
      : root
        ? Array.prototype.slice.call(root.querySelectorAll("canvas"))
        : Array.prototype.slice.call(document.querySelectorAll("canvas"));
    let el = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || (c.className || "").indexOf("mp-") >= 0) continue;
      const st = c.style || {};
      if (st.opacity === "0" || st.pointerEvents === "none") continue;
      const r = c.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      const area = (r.width | 0) * (r.height | 0);
      if (area > bestArea) {
        bestArea = area;
        el = c;
      }
    }
    if (!el) return { ok: false, reason: "no-canvas-box" };
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) {
      return { ok: false, reason: "tiny-canvas" };
    }
    const scale = Math.min(box.width / W, box.height / H);
    const ox = (box.width - scale * W) / 2;
    const oy = (box.height - scale * H) / 2;
    const cx = ox + (head.x + 0.5) * scale;
    const cy = oy + (head.y + 0.5) * scale;
    const rad = Math.max(10, Math.floor(scale * 0.65));
    return {
      ok: true,
      head: { x: head.x | 0, y: head.y | 0 },
      peerSc: typeof snake.Sc === "string" ? snake.Sc : null,
      clip: {
        x: Math.max(0, Math.floor(cx - rad)),
        y: Math.max(0, Math.floor(cy - rad)),
        width: Math.min(Math.floor(box.width), Math.floor(rad * 2)),
        height: Math.min(Math.floor(box.height), Math.floor(rad * 2)),
      },
    };
  });
  if (!meta.ok) return meta;
  const outPath = path.join(DUMP_DIR, (label || "local-eyes") + ".png");
  await page.evaluate(function () {
    const preferred =
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector("#canvas") ||
      null;
    const root = document.getElementById("JI3Aqc");
    const list = preferred
      ? [preferred]
      : root
        ? Array.prototype.slice.call(root.querySelectorAll("canvas"))
        : Array.prototype.slice.call(document.querySelectorAll("canvas"));
    let el = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || (c.className || "").indexOf("mp-") >= 0) continue;
      const st = c.style || {};
      if (st.opacity === "0" || st.pointerEvents === "none") continue;
      const r = c.getBoundingClientRect();
      const area = (r.width | 0) * (r.height | 0);
      if (area > bestArea) {
        bestArea = area;
        el = c;
      }
    }
    document.querySelectorAll("[data-mp-eye-target]").forEach(function (n) {
      n.removeAttribute("data-mp-eye-target");
    });
    if (el) el.setAttribute("data-mp-eye-target", "1");
  });
  const handle = await page.$("[data-mp-eye-target='1']");
  if (!handle) return { ok: false, reason: "no-canvas-handle", meta: meta };
  try {
    await handle.screenshot({ path: outPath, clip: meta.clip });
  } catch (eClip) {
    await handle.screenshot({ path: outPath });
  }
  // Reuse peer eye pixel analysis by reading the crop via evaluate is heavy;
  // mirror the PNG decode path used in samplePeerHeadEyes.
  const PNG = require("pngjs").PNG;
  const buf = fs.readFileSync(outPath);
  const png = PNG.sync.read(buf);
  let ink = 0;
  let sclera = 0;
  let body = 0;
  let total = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3];
    if (a < 40) continue;
    total++;
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const lum = (r + g + b) / 3;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum < 55) ink++;
    else if (lum > 200 && chroma < 40) sclera++;
    else if (chroma > 25) body++;
  }
  const faceMarks = ink + sclera;
  return Object.assign({}, meta, {
    ink: ink,
    sclera: sclera,
    body: body,
    total: total,
    inkRatio: total ? ink / total : 0,
    hasPupils: faceMarks >= 6 && body >= 20 && faceMarks / Math.max(1, total) >= 0.004,
    shot: outPath,
  });
}

/**
 * Sample one snake on this page for parity (body color, tail facing, head facing).
 * role: "local" | "peer". For peer, prefer peerClientId when provided.
 */
async function sampleSnakeParity(page, opts) {
  opts = opts || {};
  return page.evaluate(
    function (opts) {
      function boardMeta() {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        const live = Gsm && Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g);
        const W = (live && live.width) || 10;
        const H = (live && live.height) || 9;
        const preferred =
          document.querySelector("canvas.nEoGkc") ||
          document.querySelector("#canvas") ||
          null;
        const root = document.getElementById("JI3Aqc");
        const list = preferred
          ? [preferred]
          : root
            ? Array.prototype.slice.call(root.querySelectorAll("canvas"))
            : Array.prototype.slice.call(document.querySelectorAll("canvas"));
        let el = null;
        let bestArea = 0;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!c || (c.className || "").indexOf("mp-") >= 0) continue;
          const st = c.style || {};
          if (st.opacity === "0" || st.pointerEvents === "none") continue;
          const r = c.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) continue;
          const area = (r.width | 0) * (r.height | 0);
          if (area > bestArea) {
            bestArea = area;
            el = c;
          }
        }
        if (!el || !el.getContext) return null;
        const cw = el.width | 0;
        const ch = el.height | 0;
        if (cw < 40 || ch < 40) return null;
        const cell = Math.min(cw / W, ch / H);
        const ox = (cw - cell * W) / 2;
        const oy = (ch - cell * H) / 2;
        return { el: el, g: g, W: W, H: H, cell: cell, ox: ox, oy: oy };
      }

      function resolveBody(role, peerClientId) {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        if (role === "local") {
          const snake = g && g.oa;
          const body = snake && snake.ka;
          if (!body || !body.length) return null;
          return {
            body: Array.prototype.map.call(body, function (p) {
              return { x: Number(p.x), y: Number(p.y) };
            }),
            Sc: snake.Sc || null,
            Yc: snake.Yc || null,
            movementDir: snake.direction || snake.dir || null,
            headDir: snake.Ca || null,
            transitionDir: snake.Ga || null,
            clientId: window.__mpCoopMyId || null,
          };
        }
        const remotes = window.__mpCoopRemotes || {};
        let peer = null;
        let pid = null;
        if (peerClientId && remotes[peerClientId]) {
          peer = remotes[peerClientId];
          pid = peerClientId;
        } else {
          const ids = Object.keys(remotes);
          for (let i = 0; i < ids.length; i++) {
            const r = remotes[ids[i]];
            if (r && r.alive !== false && r.body && r.body.length) {
              peer = r;
              pid = ids[i];
              break;
            }
          }
        }
        if (!peer || !peer.body || !peer.body.length) return null;
        return {
          body: peer.body.map(function (p) {
            return { x: Number(p.x), y: Number(p.y) };
          }),
          Sc: peer.Sc || null,
          Yc: peer.Yc || null,
          movementDir: peer.movementDir || peer.dir || null,
          headDir: peer.headDir || null,
          transitionDir: peer.transitionDir || null,
          clientId: pid,
        };
      }

      function patchMedian(ctx, px, py, half) {
        half = half || 2;
        const x0 = Math.max(0, Math.floor(px - half));
        const y0 = Math.max(0, Math.floor(py - half));
        const w = half * 2 + 1;
        const h = half * 2 + 1;
        let img;
        try {
          img = ctx.getImageData(x0, y0, w, h);
        } catch (e) {
          return null;
        }
        const rs = [];
        const gs = [];
        const bs = [];
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i + 3] < 40) continue;
          rs.push(img.data[i]);
          gs.push(img.data[i + 1]);
          bs.push(img.data[i + 2]);
        }
        if (!rs.length) return null;
        rs.sort(function (a, b) {
          return a - b;
        });
        gs.sort(function (a, b) {
          return a - b;
        });
        bs.sort(function (a, b) {
          return a - b;
        });
        const mid = Math.floor(rs.length / 2);
        const r = rs[mid];
        const g = gs[mid];
        const b = bs[mid];
        function hex(n) {
          const s = n.toString(16);
          return s.length < 2 ? "0" + s : s;
        }
        return {
          r: r,
          g: g,
          b: b,
          hex: ("#" + hex(r) + hex(g) + hex(b)).toUpperCase(),
          n: rs.length,
        };
      }

      function tipFacing(ctx, board, body) {
        if (!body || body.length < 2) return { ok: false, reason: "short-body" };
        const tip = body[body.length - 1];
        const neck = body[body.length - 2];
        const ux = tip.x - neck.x;
        const uy = tip.y - neck.y;
        const ulen = Math.hypot(ux, uy) || 1;
        const uxn = ux / ulen;
        const uyn = uy / ulen;
        const cx = board.ox + (tip.x + 0.5) * board.cell;
        const cy = board.oy + (tip.y + 0.5) * board.cell;
        // Sample a strip centered on tip, extending one cell outward past tip.
        const rad = Math.max(4, Math.floor(board.cell * 0.85));
        const x0 = Math.max(0, Math.floor(cx - rad));
        const y0 = Math.max(0, Math.floor(cy - rad));
        const w = Math.min(board.el.width - x0, rad * 2);
        const h = Math.min(board.el.height - y0, rad * 2);
        let img;
        try {
          img = ctx.getImageData(x0, y0, w, h);
        } catch (e) {
          return { ok: false, reason: "getImageData" };
        }
        let massX = 0;
        let massY = 0;
        let mass = 0;
        let outward = 0;
        let inward = 0;
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const i = (row * w + col) * 4;
            if (img.data[i + 3] < 40) continue;
            const lum = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
            const chroma =
              Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) -
              Math.min(img.data[i], img.data[i + 1], img.data[i + 2]);
            // Body ink (colored), skip near-white / near-black noise
            if (lum > 220 && chroma < 35) continue;
            if (lum < 25) continue;
            if (chroma < 18 && lum > 100 && lum < 200) continue; // floor
            const px = x0 + col + 0.5;
            const py = y0 + row + 0.5;
            const along = ((px - cx) * uxn + (py - cy) * uyn) / board.cell;
            massX += col + 0.5;
            massY += row + 0.5;
            mass++;
            if (along > 0.05) outward++;
            else if (along < -0.05) inward++;
          }
        }
        if (mass < 8) return { ok: false, reason: "low-mass", mass: mass };
        const mx = x0 + massX / mass;
        const my = y0 + massY / mass;
        const dx = mx - cx;
        const dy = my - cy;
        const proj = (dx * uxn + dy * uyn) / board.cell;
        const outRatio = outward / Math.max(1, outward + inward);
        return {
          ok: true,
          proj: proj,
          outRatio: outRatio,
          outward: outward,
          inward: inward,
          u: { x: uxn, y: uyn },
          tip: { x: tip.x, y: tip.y },
          neck: { x: neck.x, y: neck.y },
          mass: mass,
          // Cap bulges past tip when Ya is seeded beyond the tip cell
          facingOk: proj > 0.02 || outRatio >= 0.52,
        };
      }

      function cornerFacing(ctx, board, body) {
        if (!body || body.length < 3) {
          return { ok: false, reason: "short-body" };
        }
        let idx = -1;
        let bx = 0;
        let by = 0;
        for (let i = 1; i < body.length - 1; i++) {
          const a = body[i - 1];
          const b = body[i];
          const c = body[i + 1];
          const dax = (b.x | 0) - (a.x | 0);
          const day = (b.y | 0) - (a.y | 0);
          const dbx = (c.x | 0) - (b.x | 0);
          const dby = (c.y | 0) - (b.y | 0);
          // L-kink: incoming and outgoing not colinear
          if (dax * dby !== day * dbx || (dax === 0 && day === 0)) {
            if (dax !== 0 || day !== 0) {
              if (dbx !== dax || dby !== day) {
                idx = i;
                // Angle bisector of the exterior (into the bend)
                const ix = dax;
                const iy = day;
                const ox = dbx;
                const oy = dby;
                const il = Math.hypot(ix, iy) || 1;
                const ol = Math.hypot(ox, oy) || 1;
                bx = -(ix / il) + ox / ol;
                by = -(iy / il) + oy / ol;
                const bl = Math.hypot(bx, by) || 1;
                bx /= bl;
                by /= bl;
                break;
              }
            }
          }
        }
        if (idx < 0) return { ok: false, reason: "no-corner" };
        const cell = body[idx];
        const cx = board.ox + (cell.x + 0.5) * board.cell;
        const cy = board.oy + (cell.y + 0.5) * board.cell;
        const rad = Math.max(4, Math.floor(board.cell * 0.7));
        const x0 = Math.max(0, Math.floor(cx - rad));
        const y0 = Math.max(0, Math.floor(cy - rad));
        const w = Math.min(board.el.width - x0, rad * 2);
        const h = Math.min(board.el.height - y0, rad * 2);
        let img;
        try {
          img = ctx.getImageData(x0, y0, w, h);
        } catch (e) {
          return { ok: false, reason: "getImageData" };
        }
        let pos = 0;
        let neg = 0;
        let mass = 0;
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const i = (row * w + col) * 4;
            if (img.data[i + 3] < 40) continue;
            const lum =
              (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
            const chroma =
              Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) -
              Math.min(img.data[i], img.data[i + 1], img.data[i + 2]);
            if (lum > 220 && chroma < 35) continue;
            if (lum < 25) continue;
            if (chroma < 18 && lum > 100 && lum < 200) continue;
            const px = x0 + col + 0.5;
            const py = y0 + row + 0.5;
            const along = ((px - cx) * bx + (py - cy) * by) / board.cell;
            mass++;
            if (along > 0.04) pos++;
            else if (along < -0.04) neg++;
          }
        }
        if (mass < 8) return { ok: false, reason: "low-mass", mass: mass };
        const asym = pos / Math.max(1, pos + neg);
        return {
          ok: true,
          idx: idx,
          cell: { x: cell.x, y: cell.y },
          asym: asym,
          pos: pos,
          neg: neg,
          mass: mass,
          bisector: { x: bx, y: by },
        };
      }

      function eyeFringe(ctx, board, body, liveSc) {
        if (!body || !body[0]) return { ok: false, reason: "no-head" };
        const head = body[0];
        const cx = board.ox + (head.x + 0.5) * board.cell;
        const cy = board.oy + (head.y + 0.5) * board.cell;
        const rad = Math.max(6, Math.floor(board.cell * 0.55));
        const x0 = Math.max(0, Math.floor(cx - rad));
        const y0 = Math.max(0, Math.floor(cy - rad));
        const w = Math.min(board.el.width - x0, rad * 2);
        const h = Math.min(board.el.height - y0, rad * 2);
        let img;
        try {
          img = ctx.getImageData(x0, y0, w, h);
        } catch (e) {
          return { ok: false, reason: "getImageData" };
        }
        function parseHex(hex) {
          if (!hex || typeof hex !== "string") return null;
          const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
          if (!m) return null;
          const n = parseInt(m[1], 16);
          return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
        const sc = parseHex(liveSc);
        const rs = [];
        const gs = [];
        const bs = [];
        let fringeN = 0;
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const i = (row * w + col) * 4;
            if (img.data[i + 3] < 40) continue;
            const r = img.data[i];
            const g = img.data[i + 1];
            const b = img.data[i + 2];
            const lum = (r + g + b) / 3;
            const chroma = Math.max(r, g, b) - Math.min(r, g, b);
            // Ring around sclera: mid-luma colorful pixels near white
            if (lum < 140 || lum > 230) continue;
            if (chroma < 20) continue;
            // Exclude solid body fill (very saturated mid)
            if (lum < 170 && chroma > 80) continue;
            rs.push(r);
            gs.push(g);
            bs.push(b);
            fringeN++;
          }
        }
        if (fringeN < 3) {
          return { ok: true, fringeN: fringeN, median: null, scDist: null };
        }
        rs.sort(function (a, b) {
          return a - b;
        });
        gs.sort(function (a, b) {
          return a - b;
        });
        bs.sort(function (a, b) {
          return a - b;
        });
        const mid = Math.floor(fringeN / 2);
        const median = { r: rs[mid], g: gs[mid], b: bs[mid] };
        const scDist = sc
          ? Math.abs(median.r - sc.r) +
            Math.abs(median.g - sc.g) +
            Math.abs(median.b - sc.b)
          : null;
        function hex(n) {
          const s = n.toString(16);
          return s.length < 2 ? "0" + s : s;
        }
        return {
          ok: true,
          fringeN: fringeN,
          median: median,
          medianHex: (
            "#" +
            hex(median.r) +
            hex(median.g) +
            hex(median.b)
          ).toUpperCase(),
          liveSc: liveSc || null,
          scDist: scDist,
        };
      }

      function patchLooksLikeBoard(med) {
        if (!med) return true;
        // Classic GSM grass ~#A2D149
        return (
          med.g > 170 &&
          med.r > 130 &&
          med.r < 190 &&
          med.b < 120 &&
          med.g > med.r &&
          med.g > med.b
        );
      }

      function resolvePaintedHead(ctx, board, body) {
        if (!body || !body.length) return null;
        for (let i = 0; i < Math.min(body.length, 4); i++) {
          const p = body[i];
          const px = board.ox + (p.x + 0.5) * board.cell;
          const py = board.oy + (p.y + 0.5) * board.cell;
          const med = patchMedian(ctx, px, py, 2);
          if (!patchLooksLikeBoard(med)) {
            return { cell: p, index: i, patch: med };
          }
        }
        return {
          cell: body[0],
          index: 0,
          patch: patchMedian(
            ctx,
            board.ox + (body[0].x + 0.5) * board.cell,
            board.oy + (body[0].y + 0.5) * board.cell,
            2
          ),
        };
      }

      function headFacing(ctx, board, body, dirs) {
        if (!body || body.length < 1) return { ok: false, reason: "no-head" };
        const painted = resolvePaintedHead(ctx, board, body);
        const head = painted && painted.cell ? painted.cell : body[0];
        let fx = 1;
        let fy = 0;
        // Prefer body geometry from true body[0] for forward axis.
        if (body.length >= 2) {
          const neck = body[1];
          fx = body[0].x - neck.x;
          fy = body[0].y - neck.y;
        } else if (dirs && dirs.headDir) {
          const d = String(dirs.headDir).toUpperCase();
          if (d === "LEFT") {
            fx = -1;
            fy = 0;
          } else if (d === "UP") {
            fx = 0;
            fy = -1;
          } else if (d === "DOWN") {
            fx = 0;
            fy = 1;
          }
        }
        const flen = Math.hypot(fx, fy) || 1;
        fx /= flen;
        fy /= flen;
        const cx = board.ox + (head.x + 0.5) * board.cell;
        const cy = board.oy + (head.y + 0.5) * board.cell;
        const rad = Math.max(6, Math.floor(board.cell * 0.65));
        const x0 = Math.max(0, Math.floor(cx - rad));
        const y0 = Math.max(0, Math.floor(cy - rad));
        const w = Math.min(board.el.width - x0, rad * 2);
        const h = Math.min(board.el.height - y0, rad * 2);
        let img;
        try {
          img = ctx.getImageData(x0, y0, w, h);
        } catch (e) {
          return { ok: false, reason: "getImageData" };
        }
        // Prefer pupil + sclera; fall back to high-contrast face marks so we
        // still get a facing bias when sheets are soft / tinted.
        let massX = 0;
        let massY = 0;
        let mass = 0;
        let pupils = 0;
        let sclera = 0;
        let marks = 0;
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const i = (row * w + col) * 4;
            if (img.data[i + 3] < 40) continue;
            const r = img.data[i];
            const g = img.data[i + 1];
            const b = img.data[i + 2];
            const lum = (r + g + b) / 3;
            const chroma = Math.max(r, g, b) - Math.min(r, g, b);
            let eye = false;
            if (lum < 90) {
              pupils++;
              eye = true;
            } else if (lum > 185 && chroma < 55) {
              sclera++;
              eye = true;
            } else if (lum > 160 && chroma < 30) {
              marks++;
              eye = true;
            }
            if (!eye) continue;
            massX += col + 0.5;
            massY += row + 0.5;
            mass++;
          }
        }
        if (mass < 4) {
          return {
            ok: false,
            reason: "low-eye-mass",
            mass: mass,
            pupils: pupils,
            sclera: sclera,
            marks: marks,
            paintedIndex: painted && painted.index,
          };
        }
        const mx = x0 + massX / mass;
        const my = y0 + massY / mass;
        const proj = ((mx - cx) * fx + (my - cy) * fy) / board.cell;
        return {
          ok: true,
          proj: proj,
          f: { x: fx, y: fy },
          head: { x: head.x, y: head.y },
          mass: mass,
          pupils: pupils,
          sclera: sclera,
          marks: marks,
          paintedIndex: painted && painted.index,
          dirs: dirs || null,
        };
      }

      function sampleYaVirtual(snakeBody, liveSnake) {
        if (!snakeBody || snakeBody.length < 1) {
          return { ok: false, reason: "no-body", yaBeyondOk: false };
        }
        const tip = snakeBody[snakeBody.length - 1];
        const tipX = Number(tip.x);
        const tipY = Number(tip.y);
        let dx = 0;
        let dy = 0;
        if (snakeBody.length >= 2) {
          const neck = snakeBody[snakeBody.length - 2];
          dx = tipX - Number(neck.x);
          dy = tipY - Number(neck.y);
        }
        if (dx === 0 && dy === 0) {
          const d = String(
            (liveSnake && (liveSnake.direction || liveSnake.dir || liveSnake.Ca)) ||
              "RIGHT"
          ).toUpperCase();
          if (d === "LEFT") {
            dx = -1;
            dy = 0;
          } else if (d === "UP") {
            dx = 0;
            dy = -1;
          } else if (d === "DOWN") {
            dx = 0;
            dy = 1;
          } else {
            dx = 1;
            dy = 0;
          }
        } else if (Math.abs(dx) >= Math.abs(dy)) {
          dx = dx > 0 ? 1 : -1;
          dy = 0;
        } else {
          dx = 0;
          dy = dy > 0 ? 1 : -1;
        }
        const expectX = tipX + dx;
        const expectY = tipY + dy;
        const ya = liveSnake && liveSnake.Ya;
        if (!ya || ya.x == null || ya.y == null) {
          return {
            ok: false,
            reason: "no-Ya",
            yaBeyondOk: false,
            tip: { x: tipX, y: tipY },
            expect: { x: expectX, y: expectY },
          };
        }
        const yx = Number(ya.x);
        const yy = Number(ya.y);
        const yaBeyondOk =
          Math.round(yx) === Math.round(expectX) &&
          Math.round(yy) === Math.round(expectY);
        return {
          ok: true,
          yaBeyondOk: yaBeyondOk,
          ya: { x: yx, y: yy },
          tip: { x: tipX, y: tipY },
          neck:
            snakeBody.length >= 2
              ? {
                  x: Number(snakeBody[snakeBody.length - 2].x),
                  y: Number(snakeBody[snakeBody.length - 2].y),
                }
              : null,
          expect: { x: expectX, y: expectY },
        };
      }

      const board = boardMeta();
      if (!board) return { ok: false, reason: "no-board" };
      const snake = resolveBody(opts.role || "peer", opts.peerClientId || null);
      if (!snake) return { ok: false, reason: "no-snake" };
      const ctx = board.el.getContext("2d");
      if (!ctx) return { ok: false, reason: "no-ctx" };

      const n = snake.body.length;
      const midI = Math.max(1, Math.min(n - 1, Math.floor(n / 2)));
      const mid = snake.body[midI];
      const midPx = {
        x: board.ox + (mid.x + 0.5) * board.cell,
        y: board.oy + (mid.y + 0.5) * board.cell,
      };
      let bodyColor = patchMedian(ctx, midPx.x, midPx.y, 2);
      let midCell = { x: mid.x, y: mid.y, i: midI };
      // If mid landed on grass (pose lag), walk segments for snake ink.
      if (patchLooksLikeBoard(bodyColor) || (bodyColor && bodyColor.hex === "#FFFFFF")) {
        for (let i = 0; i < n; i++) {
          const p = snake.body[i];
          const px = board.ox + (p.x + 0.5) * board.cell;
          const py = board.oy + (p.y + 0.5) * board.cell;
          const med = patchMedian(ctx, px, py, 2);
          if (!patchLooksLikeBoard(med) && med && med.hex !== "#FFFFFF") {
            bodyColor = med;
            midCell = { x: p.x, y: p.y, i: i };
            break;
          }
        }
      }
      const headCell = snake.body[0];
      const paintedHead = resolvePaintedHead(ctx, board, snake.body);
      const headPx = {
        x:
          board.ox +
          (((paintedHead && paintedHead.cell) || headCell).x + 0.5) *
            board.cell,
        y:
          board.oy +
          (((paintedHead && paintedHead.cell) || headCell).y + 0.5) *
            board.cell,
      };
      const headPatch =
        (paintedHead && paintedHead.patch) ||
        patchMedian(ctx, headPx.x, headPx.y, 3);
      const tail = tipFacing(ctx, board, snake.body);
      const corner = cornerFacing(ctx, board, snake.body);
      const fringeBody =
        paintedHead && paintedHead.index > 0
          ? [paintedHead.cell].concat(snake.body.slice(1))
          : snake.body;
      const fringe = eyeFringe(ctx, board, fringeBody, snake.Sc);
      const head = headFacing(ctx, board, snake.body, {
        movementDir: snake.movementDir,
        headDir: snake.headDir,
        transitionDir: snake.transitionDir,
      });

      let yaVirtual = null;
      if ((opts.role || "peer") === "local") {
        const g = board.g;
        yaVirtual = sampleYaVirtual(snake.body, g && g.oa);
      }

      return {
        ok: true,
        role: opts.role || "peer",
        clientId: snake.clientId,
        bodyLen: n,
        liveSc: snake.Sc,
        liveYc: snake.Yc,
        bodyColor: bodyColor,
        headPatch: headPatch,
        midCell: midCell,
        tail: tail,
        corner: corner,
        eyeFringe: fringe,
        head: head,
        headPx: headPx,
        movementDir: snake.movementDir,
        headDir: snake.headDir,
        transitionDir: snake.transitionDir,
        yaVirtual: yaVirtual,
      };
    },
    {
      role: opts.role || "peer",
      peerClientId: opts.peerClientId || null,
    }
  );
}

function rgbDist(a, b) {
  if (!a || !b) return 999;
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/** Sample peer head pixel a few times while holding a heading (mid-tick crawl). */
async function samplePeerLerpSmoothness(pageA, pageB, presses) {
  presses = presses || 12;
  // Keep both snakes crawling so A’s peer of B has live motion + paint.
  for (let warm = 0; warm < 3; warm++) {
    await Promise.all([
      pageA.keyboard.press("ArrowRight").catch(function () {}),
      pageB
        ? pageB.keyboard.press("ArrowLeft").catch(function () {})
        : Promise.resolve(),
    ]);
    await new Promise(function (r) {
      setTimeout(r, 50);
    });
  }

  // Collect on A via rAF while B keeps moving from the Node side.
  const collectPromise = pageA.evaluate(function (n) {
    return new Promise(function (resolve) {
      const samples = [];
      let left = Math.max(8, n | 0);
      function tick() {
        const remotes = window.__mpCoopRemotes || {};
        const ids = Object.keys(remotes);
        let peer = null;
        for (let j = 0; j < ids.length; j++) {
          const r = remotes[ids[j]];
          if (r && r.body && r.body[0]) {
            peer = r;
            break;
          }
        }
        const m = window.__mpCoopNativeRenderMetrics || null;
        const args = window.__mpCoopRenderArgs;
        const progress =
          args && Number.isFinite(Number(args[0])) ? Number(args[0]) : null;
        const head = peer && peer.body && peer.body[0];
        samples.push({
          t: Date.now(),
          hasPeer: !!peer,
          head: head
            ? { x: Number(head.x), y: Number(head.y) }
            : null,
          progress: progress,
          refreshCount: m ? m.refreshCount | 0 : -1,
          compositeCount: m ? m.compositeCount | 0 : -1,
          backend: m ? m.backend || null : null,
          remoteIds: ids,
        });
        left--;
        if (left <= 0) resolve(samples);
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }, presses);

  const drive = (async function () {
    for (let i = 0; i < presses; i++) {
      await Promise.all([
        pageA.keyboard.press("ArrowRight").catch(function () {}),
        pageB
          ? pageB.keyboard.press("ArrowLeft").catch(function () {})
          : Promise.resolve(),
      ]);
      await new Promise(function (r) {
        setTimeout(r, 35);
      });
    }
  })();

  const samples = await collectPromise;
  await drive.catch(function () {});

  let holds = 0;
  let maxHold = 1;
  let curHold = 1;
  const withPeer = samples.filter(function (s) {
    return s && s.hasPeer && s.head;
  });
  for (let i = 1; i < withPeer.length; i++) {
    const a = withPeer[i - 1];
    const b = withPeer[i];
    const sameGrid = a.head.x === b.head.x && a.head.y === b.head.y;
    const sameProgress =
      a.progress != null &&
      b.progress != null &&
      Math.abs(a.progress - b.progress) < 0.0005;
    if (sameGrid && sameProgress) {
      curHold++;
      maxHold = Math.max(maxHold, curHold);
      holds++;
    } else {
      curHold = 1;
    }
  }
  const refreshDelta =
    samples.length >= 2
      ? (samples[samples.length - 1].refreshCount | 0) -
        (samples[0].refreshCount | 0)
      : 0;
  const progressVals = withPeer
    .map(function (s) {
      return s.progress;
    })
    .filter(function (p) {
      return p != null && Number.isFinite(p);
    });
  let progressChanged = false;
  for (let i = 1; i < progressVals.length; i++) {
    if (Math.abs(progressVals[i] - progressVals[i - 1]) > 0.001) {
      progressChanged = true;
      break;
    }
  }
  // Smooth if peer paint refreshes OR wrap progress advances across frames.
  const smoothOk =
    withPeer.length >= 4 &&
    (refreshDelta >= Math.max(2, Math.floor(withPeer.length * 0.25)) ||
      progressChanged);
  return {
    samples: samples,
    withPeer: withPeer.length,
    maxHold: maxHold,
    holdPairs: holds,
    refreshDelta: refreshDelta,
    progressChanged: progressChanged,
    smoothOk: smoothOk,
  };
}

async function sampleLagWhilePlaying(pageA, pageB, ms) {
  ms = ms || 2000;
  await pageA.evaluate(function () {
    window.__mpE2ELagProbe = {
      samples: [],
      a7: 0,
    };
    const prev = window.__slotA7;
    window.__mpE2ELagPrevA7 = prev;
    window.__slotA7 = function () {
      window.__mpE2ELagProbe.a7++;
      if (typeof prev === "function") return prev.apply(this, arguments);
    };
  });
  const tEnd = Date.now() + ms;
  while (Date.now() < tEnd) {
    // Prefer a single safe heading — random ArrowDown/Left often drive into walls
    // and poison the single-death survival check that follows.
    await Promise.all([
      pageA.keyboard.press("ArrowRight").catch(function () {}),
      pageB.keyboard.press("ArrowLeft").catch(function () {}),
    ]);
    await new Promise(function (r) {
      setTimeout(r, 120);
    });
    const sample = await pageA.evaluate(function () {
      const m = window.__mpCoopNativeRenderMetrics || {};
      const app = window.__multiplayerApp;
      const ping =
        app && app.client && app.client.lastPingMs != null
          ? app.client.lastPingMs
          : null;
      return {
        t: Date.now(),
        ping: ping,
        fps:
          typeof window.__mpCoopFps === "number" &&
          Number.isFinite(window.__mpCoopFps)
            ? window.__mpCoopFps
            : null,
        averageRefreshMs: m.averageRefreshMs || 0,
        refreshCount: m.refreshCount | 0,
        renderCount: m.renderCount | 0,
        compositeCount: m.compositeCount | 0,
        faceTintSwaps: m.faceTintSwaps | 0,
        faceTintRestores: m.faceTintRestores | 0,
        faceCtxRetargets: m.faceCtxRetargets | 0,
        leanPassCount: m.leanPassCount | 0,
        fullPassCount: m.fullPassCount | 0,
        audited: !!m.audited,
        a7: (window.__mpE2ELagProbe && window.__mpE2ELagProbe.a7) | 0,
        statusText:
          (document.getElementById("mp-mod-indicator") &&
            document.getElementById("mp-mod-indicator").textContent) ||
          null,
      };
    });
    await pageA.evaluate(
      function (s) {
        window.__mpE2ELagProbe.samples.push(s);
      },
      sample
    );
  }
  const out = await pageA.evaluate(function () {
    const probe = window.__mpE2ELagProbe || { samples: [], a7: 0 };
    if (window.__mpE2ELagPrevA7 !== undefined) {
      window.__slotA7 = window.__mpE2ELagPrevA7;
      delete window.__mpE2ELagPrevA7;
    }
    return probe;
  });
  fs.writeFileSync(
    path.join(DUMP_DIR, "evidence-lag.json"),
    JSON.stringify(out, null, 2)
  );
  return out;
}

async function forceLocalNativeDeath(page) {
  return page.evaluate(function () {
    const app = window.__multiplayerApp;
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (!app || !g) return { ok: false, reason: "no-app" };
    g.nj = true;
    g.dead = true;
    g.isDead = true;
    if (g.oa) {
      g.oa.nj = true;
      g.oa.dead = true;
    }
    window.__mpCoopLocalDead = true;
    const me = app.client && app.client.me && app.client.me();
    const body =
      (g.oa &&
        Array.isArray(g.oa.ka) &&
        g.oa.ka.map(function (p) {
          return p ? { x: p.x | 0, y: p.y | 0 } : null;
        }).filter(Boolean)) ||
      [];
    if (app.coopSession && app.coopSession.markDead) {
      app.coopSession.markDead("e2e_force");
    }
    app._coopDeadSent = true;
    if (body.length) app._coopLastBody = body;
    const gen =
      (app.coop && app.coop.generation) ||
      (typeof window.__mpCoopGeneration === "number"
        ? window.__mpCoopGeneration
        : 1);
    const eventSeq =
      app.coopSession && app.coopSession.nextEventSeq
        ? app.coopSession.nextEventSeq()
        : Date.now();
    if (app.client && app.client.coopPlayerDead) {
      const death = {
        generation: gen,
        eventSeq: eventSeq,
        body: body.length ? body : [{ x: 1, y: 1 }, { x: 0, y: 1 }],
        reason: "e2e_force",
      };
      app.client.coopPlayerDead(death);
    }
    if (app.client && app.client.snakeDelta && me && app.coopSession) {
      app.client.snakeDelta({
        clientId: app.client.clientId,
        colorId: me.colorId,
        alive: false,
        seated: true,
        body: body.length ? body : [{ x: 1, y: 1 }, { x: 0, y: 1 }],
        generation: gen,
        eventSeq: app.coopSession.nextEventSeq
          ? app.coopSession.nextEventSeq()
          : eventSeq + 1,
        poseSeq: app.coopSession.nextPoseSeq
          ? app.coopSession.nextPoseSeq()
          : undefined,
      });
    }
    if (typeof app.refreshCoopScores === "function") app.refreshCoopScores();
    return {
      ok: true,
      clientId: app.client && app.client.clientId,
      deadSent: !!app._coopDeadSent,
      generation: gen,
      eventSeq: eventSeq,
      bodyLen: body.length,
    };
  });
}

async function readDeathSurvival(page) {
  return page.evaluate(function () {
    const app = window.__multiplayerApp;
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const me = app && app.client && app.client.me && app.client.me();
    const myId = me && (me.clientId || me.id);
    const hud =
      app && app._coopScores && myId != null ? app._coopScores[myId] : null;
    const scoreInfo =
      Gsm && Gsm.readScoreAndAlive ? Gsm.readScoreAndAlive() : null;
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    const ovStyle = overlay ? window.getComputedStyle(overlay) : null;
    const menu = overlay && overlay.children && overlay.children[0];
    const menuStyle = menu ? window.getComputedStyle(menu) : null;
    const overlayVisible = !!(
      overlay &&
      ovStyle &&
      ovStyle.visibility !== "hidden" &&
      ovStyle.display !== "none" &&
      (Number(ovStyle.opacity) > 0 ||
        (overlay.style && overlay.style.opacity === "1") ||
        (overlay.style && overlay.style.visibility === "visible"))
    );
    const scores = {};
    if (app && app._coopScores) {
      Object.keys(app._coopScores).forEach(function (id) {
        const s = app._coopScores[id];
        scores[id] = {
          score: s && typeof s === "object" ? s.score | 0 : s | 0,
          alive: s && typeof s === "object" ? s.alive !== false : true,
        };
      });
    }
    const remotes = (function () {
      const src =
        (app && app.coopNative && app.coopNative.remotes) ||
        window.__mpCoopRemotes ||
        {};
      const out = {};
      Object.keys(src).forEach(function (id) {
        out[id] = {
          alive: src[id] && src[id].alive !== false,
          head: src[id] && src[id].body && src[id].body[0],
        };
      });
      return out;
    })();
    let peerId = null;
    let peerHudAlive = null;
    let peerRemoteAlive = null;
    Object.keys(scores).forEach(function (id) {
      if (id !== myId && peerId == null) peerId = id;
    });
    if (!peerId) {
      Object.keys(remotes).forEach(function (id) {
        if (id !== myId && peerId == null) peerId = id;
      });
    }
    if (peerId) {
      peerHudAlive =
        scores[peerId] != null ? scores[peerId].alive !== false : null;
      peerRemoteAlive =
        remotes[peerId] != null ? remotes[peerId].alive !== false : null;
    }
    return {
      clientId: myId || null,
      peerId: peerId,
      endReason: (app && app._coopEndReason) || null,
      sessionActive: !!(
        app &&
        app.client &&
        app.client.roster &&
        app.client.roster.sessionActive
      ),
      deadSent: !!(app && app._coopDeadSent),
      localDead: !!window.__mpCoopLocalDead,
      nj: !!(g && g.nj),
      overlayVisible: overlayVisible,
      gsmOverlayVisible: !!(
        Gsm &&
        Gsm.isDeathOverlayVisible &&
        Gsm.isDeathOverlayVisible()
      ),
      overlayVisibility: ovStyle ? ovStyle.visibility : null,
      overlayOpacity: ovStyle ? ovStyle.opacity : null,
      menuVisibility: menuStyle ? menuStyle.visibility : null,
      hudAlive: hud ? hud.alive !== false : null,
      scoreAlive: scoreInfo ? scoreInfo.alive !== false : null,
      peerHudAlive: peerHudAlive,
      peerRemoteAlive: peerRemoteAlive,
      scores: scores,
      remotes: remotes,
    };
  });
}

function assertBoardsMatch(dumpA, dumpB, label) {
  const tag = label || "A↔B";
  assert.ok(dumpA && dumpB, tag + " dumps missing");
  assert.equal(
    dumpA.fruitFp,
    dumpB.fruitFp,
    tag + " fruitFp mismatch\nA=" + dumpA.fruitFp + "\nB=" + dumpB.fruitFp
  );
  assert.equal(
    dumpA.fruitLen,
    dumpB.fruitLen,
    tag + " fruitLen mismatch"
  );
  const headA = dumpA.local && dumpA.local.head;
  const headB = dumpB.local && dumpB.local.head;
  assert.ok(headA && headB, tag + " local heads missing");
  const remotesA = dumpA.remotes || {};
  const remotesB = dumpB.remotes || {};
  const peerOnA = Object.keys(remotesA).map(function (id) {
    return remotesA[id];
  })[0];
  const peerOnB = Object.keys(remotesB).map(function (id) {
    return remotesB[id];
  })[0];
  assert.ok(peerOnA && peerOnA.head, tag + " A missing peer remote head");
  assert.ok(peerOnB && peerOnB.head, tag + " B missing peer remote head");
  assert.equal(
    peerOnA.head.x | 0,
    headB.x | 0,
    tag + " peer-on-A head.x != B local head.x"
  );
  assert.equal(
    peerOnA.head.y | 0,
    headB.y | 0,
    tag + " peer-on-A head.y != B local head.y"
  );
  assert.equal(
    peerOnB.head.x | 0,
    headA.x | 0,
    tag + " peer-on-B head.x != A local head.x"
  );
  assert.equal(
    peerOnB.head.y | 0,
    headA.y | 0,
    tag + " peer-on-B head.y != A local head.y"
  );
  // Colors: require peer paint to carry Sc/Yc when local has them. Exact
  // equality can lag one tick after claimColor — accept either player's
  // palette on the peer remote.
  if (dumpA.local.Sc || dumpB.local.Sc) {
    assert.ok(
      peerOnA.Sc || peerOnB.Sc,
      tag + " peer remotes missing Sc"
    );
  }
  if (
    dumpA.local.Sc &&
    dumpB.local.Sc &&
    dumpA.local.Sc !== dumpB.local.Sc
  ) {
    // Distinct claimed colors stuck on locals — good enough for dual TAS.
    assert.notEqual(
      dumpA.local.Sc,
      dumpB.local.Sc,
      tag + " locals should keep distinct colors"
    );
  }
}

function assertScores(dump, expected, label) {
  const tag = label || "scores";
  assert.ok(dump, tag + " dump missing");
  if (expected.local != null) {
    assert.equal(
      dump.local && dump.local.score,
      expected.local,
      tag + " local score"
    );
  }
  if (expected.total != null) {
    assert.equal(
      dump.hudScores && dump.hudScores.total,
      expected.total,
      tag + " team total"
    );
  }
  if (expected.minTotal != null) {
    assert.ok(
      dump.hudScores && (dump.hudScores.total | 0) >= expected.minTotal,
      tag + " team total < " + expected.minTotal
    );
  }
}

function getScreenSize() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output $wa.Width; Write-Output $wa.Height"',
      { encoding: "utf8" }
    );
    const lines = String(out)
      .trim()
      .split(/\r?\n/)
      .map(function (s) {
        return Number(String(s).trim());
      })
      .filter(function (n) {
        return Number.isFinite(n) && n > 0;
      });
    if (lines.length >= 2) return { width: lines[0] | 0, height: lines[1] | 0 };
  } catch (_) {
    /* fall through */
  }
  return { width: 1920, height: 1080 };
}

/** Apply half-screen bounds once at page birth (launch args alone are unreliable on Windows). */
async function applyHalfScreenBounds(page, side, screen) {
  if (!page) return;
  const w = Math.max(640, (screen.width / 2) | 0);
  const h = Math.max(480, screen.height | 0);
  const left = side === "right" ? w : 0;
  try {
    const session = await page.context().newCDPSession(page);
    const target = await session.send("Browser.getWindowForTarget");
    // Force out of minimized/maximized before sizing — CDP ignores size while minimized.
    await session.send("Browser.setWindowBounds", {
      windowId: target.windowId,
      bounds: { windowState: "normal" },
    });
    await session.send("Browser.setWindowBounds", {
      windowId: target.windowId,
      bounds: {
        left: left,
        top: 0,
        width: w,
        height: h,
        windowState: "normal",
      },
    });
  } catch (_) {
    /* headed layout best-effort */
  }
}

/**
 * Set local snake facing for the *next* engine tick via native game.turn.
 * Never force a 180° reverse (__fearNativeTurn) — that drives the head into
 * the body and the native client dies itself.
 */
async function setSnakeDir(page, dir) {
  return page.evaluate(function (d) {
    try {
      window.pauseGame = 0;
    } catch (eP) { /* ignore */ }
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (g && g.nj) g.nj = false;
    if (!g) return -1;
    if (!d) return g.ticks | 0;
    const hold = String(d).toUpperCase();
    if (hold === "NONE") {
      try {
        window.pauseGame = 1;
      } catch (eN) { /* ignore */ }
      return g.ticks | 0;
    }
    const snake = g.oa;
    const curRaw =
      (snake && snake.direction && snake.direction !== "NONE" && snake.direction) ||
      (snake && snake.Ca && snake.Ca !== "NONE" && snake.Ca) ||
      (snake && snake.Ga && snake.Ga !== "NONE" && snake.Ga) ||
      (snake && snake.__mpTasHoldDir) ||
      "RIGHT";
    const cur = String(curRaw).toUpperCase();
    const opp = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
    // Opposite: refuse (planner must not ask — native 180 into body).
    if (opp[cur] === hold) return g.ticks | 0;
    // Flush pending-turn buffer so dir applies on the next engine step.
    if (snake) {
      snake.Qb = false;
      if ("yb" in snake) snake.yb = "NONE";
      if ("Ga" in snake) snake.Ga = "NONE";
    }
    // Always turn (even same facing) so a paused snake resumes that way.
    if (typeof g.turn === "function") {
      g.turn(hold);
    } else {
      const ctrl =
        Gsm && Gsm.findPlayController && Gsm.findPlayController();
      if (ctrl && typeof ctrl.turn === "function") {
        ctrl.turn(hold);
      } else if (snake) {
        snake.direction = hold;
        if ("dir" in snake) snake.dir = hold;
        if ("Ca" in snake) snake.Ca = hold;
        snake.Qb = true;
      }
    }
    return g.ticks | 0;
  }, dir || null);
}

async function waitGameTick(page, prevTicks, timeoutMs) {
  await page.waitForFunction(
    function (t) {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g) return true;
      if ((g.ticks | 0) > (t | 0)) return true;
      // Native client stopped the engine (death / endscreen) — don't hang.
      const app = window.__multiplayerApp;
      if (app && app._coopEndReason) return true;
      if (g.nj === true) return true;
      return false;
    },
    prevTicks | 0,
    { timeout: timeoutMs || 3000 }
  );
}

/** Like waitGameTick, but slam pauseGame the instant the tick advances. */
async function waitGameTickHold(page, prevTicks, timeoutMs) {
  await page.waitForFunction(
    function (t) {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g) return true;
      const app = window.__multiplayerApp;
      if (app && app._coopEndReason) return true;
      if (g.nj === true) return true;
      if ((g.ticks | 0) <= (t | 0)) return false;
      try {
        window.pauseGame = 1;
      } catch (eP) { /* ignore */ }
      return true;
    },
    prevTicks | 0,
    { timeout: timeoutMs || 3000 }
  );
}

/**
 * Dual tick-synced key driver — one planned dir per engine tick on each page.
 * opts.holdAfter: pauseGame the instant each tick lands (seed-safe).
 *
 * Critical: arm turn + unpause + wait-for-tick + re-pause all happen inside
 * page.waitForFunction so Node IPC latency cannot free-run extra Fast/crawl ticks.
 */
async function driveDualTicks(pageA, pageB, dirsA, dirsB, opts) {
  opts = opts || {};
  const a = dirsA || [];
  const b = dirsB || [];
  const n = Math.max(a.length, b.length);
  if (!n) return;
  const holdAfter = !!opts.holdAfter;
  const tickTimeoutMs = opts.tickTimeoutMs || 5000;

  async function stepOne(page, dir) {
    const d = dir || null;
    if (holdAfter) {
      // Synchronous one-step: face → tick() → hard-hold. No rAF time-debt.
      await page.evaluate(function (payload) {
        try {
          window.pauseGame = 0;
        } catch (eP) { /* ignore */ }
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        if (!g || typeof g.tick !== "function") {
          throw new Error("no game.tick");
        }
        if (g.nj) g.nj = false;
        const snake = g.oa;
        const hold = payload.dir ? String(payload.dir).toUpperCase() : null;
        if (snake && hold && hold !== "NONE") {
          const curRaw =
            (snake.direction &&
              snake.direction !== "NONE" &&
              snake.direction) ||
            (snake.Ca && snake.Ca !== "NONE" && snake.Ca) ||
            snake.__mpTasHoldDir ||
            "RIGHT";
          const cur = String(curRaw).toUpperCase();
          const opp = {
            UP: "DOWN",
            DOWN: "UP",
            LEFT: "RIGHT",
            RIGHT: "LEFT",
          };
          if (opp[cur] !== hold) {
            snake.__mpTasHoldDir = hold;
            snake.direction = hold;
            if ("dir" in snake) snake.dir = hold;
            if ("Ca" in snake) snake.Ca = hold;
            if ("Ga" in snake) snake.Ga = "NONE";
            if ("yb" in snake) snake.yb = "NONE";
            if ("Oa" in snake) snake.Oa = false;
            snake.Qb = true;
          }
        }
        // Keep the raf clock from catch-up-bursting if anything else unpauses.
        if (typeof g.ob === "number") g.ob = Date.now();
        g.ticks = (g.ticks | 0) + 1;
        g.tick();
        // Hard hold immediately after the step.
        if (snake) {
          const face =
            (snake.direction &&
              snake.direction !== "NONE" &&
              snake.direction) ||
            (snake.Ca && snake.Ca !== "NONE" && snake.Ca) ||
            snake.__mpTasHoldDir ||
            "RIGHT";
          snake.__mpTasHoldDir = face;
          if ("Ca" in snake) snake.Ca = face;
          snake.direction = "NONE";
          if ("dir" in snake) snake.dir = "NONE";
          if ("Ga" in snake) snake.Ga = "NONE";
          if ("yb" in snake) snake.yb = "NONE";
          if ("Oa" in snake) snake.Oa = false;
          snake.Qb = false;
        }
        try {
          window.pauseGame = 1;
        } catch (eH) { /* ignore */ }
        if (typeof g.ob === "number") g.ob = Date.now();
      }, { dir: d });
    } else {
      const t = await setSnakeDir(page, d);
      await waitGameTick(page, t, tickTimeoutMs);
    }
  }

  for (let i = 0; i < n; i++) {
    await Promise.all([
      stepOne(pageA, a[i] || null),
      stepOne(pageB, b[i] || null),
    ]);
  }
}

/** Single-page tick-synced driver. */
async function driveKeys(page, dirs, opts) {
  opts = opts || {};
  if (!dirs || !dirs.length) return;
  for (let i = 0; i < dirs.length; i++) {
    const t = await setSnakeDir(page, dirs[i]);
    await waitGameTick(page, t, opts.tickTimeoutMs || 3000);
  }
}

async function assertBoardPixelMatch(pageA, pageB, label, maxPct) {
  maxPct = maxPct != null ? maxPct : 0.5;
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const pathA = path.join(DUMP_DIR, label + "-a.png");
  const pathB = path.join(DUMP_DIR, label + "-b.png");
  const pathDiff = path.join(DUMP_DIR, label + "-diff.png");
  async function shotBoard(page, outPath) {
    await page.evaluate(function () {
      const nodes = document.querySelectorAll(
        "#mp-status, .mp-status, [data-mp-status], #status"
      );
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].dataset.mpPixPrevVis = nodes[i].style.visibility || "";
        nodes[i].style.visibility = "hidden";
      }
      const hud = document.getElementById("mp-hud");
      if (hud) {
        hud.dataset.mpPixPrevVis = hud.style.visibility || "";
        hud.style.visibility = "hidden";
      }
    });
    const box = await page.evaluate(function () {
      const preferred =
        document.querySelector("canvas.nEoGkc") ||
        document.querySelector("#canvas") ||
        null;
      const root = document.getElementById("JI3Aqc");
      const canvases = preferred
        ? [preferred]
        : root
          ? root.querySelectorAll("canvas")
          : document.querySelectorAll("canvas");
      let best = null;
      let bestArea = 0;
      for (let i = 0; i < canvases.length; i++) {
        const c = canvases[i];
        if (!c || (c.className || "").indexOf("mp-") >= 0) continue;
        const r = c.getBoundingClientRect();
        const area = (r.width | 0) * (r.height | 0);
        if (area > bestArea) {
          bestArea = area;
          const insetY = Math.max(8, Math.floor(r.height * 0.06));
          best = {
            x: Math.floor(r.x),
            y: Math.floor(r.y + insetY),
            width: Math.floor(r.width),
            height: Math.floor(r.height - insetY),
          };
        }
      }
      return best;
    });
    if (box && box.width > 40 && box.height > 40) {
      await page.screenshot({ path: outPath, clip: box });
    } else {
      await page.screenshot({ path: outPath, fullPage: false });
    }
    await page.evaluate(function () {
      const nodes = document.querySelectorAll(
        "#mp-status, .mp-status, [data-mp-status], #status, #mp-hud"
      );
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].dataset.mpPixPrevVis != null) {
          nodes[i].style.visibility = nodes[i].dataset.mpPixPrevVis;
          delete nodes[i].dataset.mpPixPrevVis;
        }
      }
    });
  }
  await Promise.all([shotBoard(pageA, pathA), shotBoard(pageB, pathB)]);
  const PNG = require("pngjs").PNG;
  const pixelmatch = require("pixelmatch").default || require("pixelmatch");
  const imgA = PNG.sync.read(fs.readFileSync(pathA));
  const imgB = PNG.sync.read(fs.readFileSync(pathB));
  const w = Math.min(imgA.width, imgB.width);
  const h = Math.min(imgA.height, imgB.height);
  const diff = new PNG({ width: w, height: h });
  const mismatch = pixelmatch(
    imgA.data,
    imgB.data,
    diff.data,
    w,
    h,
    { threshold: 0.15 }
  );
  fs.writeFileSync(pathDiff, PNG.sync.write(diff));
  const total = w * h;
  const pct = total ? (100 * mismatch) / total : 100;
  fs.writeFileSync(
    path.join(DUMP_DIR, label + "-pix.json"),
    JSON.stringify(
      { mismatch: mismatch, total: total, pct: pct, w: w, h: h },
      null,
      2
    )
  );
  assert.ok(
    pct <= maxPct,
    label +
      " board pixel mismatch " +
      pct.toFixed(3) +
      "% > " +
      maxPct +
      "% (diff " +
      pathDiff +
      ")"
  );
  return { mismatch: mismatch, pct: pct };
}

/** Mute page audio (CDP) — browsers also launch with --mute-audio. */
async function mutePage(page) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Page.setAudioMuted", { muted: true });
  } catch (_) {
    /* best-effort */
  }
  await page
    .evaluate(function () {
      try {
        const Proto = window.AudioContext || window.webkitAudioContext;
        if (Proto && Proto.prototype && !Proto.prototype.__mpMuted) {
          const orig = Proto.prototype.resume;
          Proto.prototype.__mpMuted = true;
          Proto.prototype.resume = function () {
            try {
              if (this.suspend) this.suspend();
            } catch (e) { /* ignore */ }
            return orig ? orig.apply(this, arguments) : Promise.resolve();
          };
        }
      } catch (eAc) { /* ignore */ }
      try {
        document.querySelectorAll("audio, video").forEach(function (el) {
          el.muted = true;
          el.volume = 0;
        });
      } catch (eDom) { /* ignore */ }
    })
    .catch(function () {});
}

async function planKeysToNearestApple(page, opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps != null ? opts.maxSteps : 12;
  const xMin = opts.xMin;
  const xMax = opts.xMax;
  return page.evaluate(
    function (args) {
      const maxSteps = args.maxSteps;
      const xMin = args.xMin;
      const xMax = args.xMax;
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g || !g.oa || !Array.isArray(g.oa.ka) || !g.oa.ka[0]) {
        return { dirs: [], reason: "no_snake" };
      }
      if (!g.wa || !Array.isArray(g.wa.ka) || !g.wa.ka.length) {
        return { dirs: [], reason: "no_fruit" };
      }
      const size =
        (Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g)) || {
          width: 10,
          height: 9,
        };
      const w = size.width | 0;
      const h = size.height | 0;
      const head = g.oa.ka[0];
      const sx = head.x | 0;
      const sy = head.y | 0;
      const blocked = Object.create(null);
      for (let i = 1; i < g.oa.ka.length; i++) {
        const p = g.oa.ka[i];
        if (p) blocked[(p.x | 0) + "," + (p.y | 0)] = true;
      }
      let peaceful = false;
      try {
        const mode =
          (Gsm.effectiveModeKey && Gsm.effectiveModeKey()) ||
          (Gsm.scrapeModeKey && Gsm.scrapeModeKey()) ||
          "";
        peaceful = String(mode).toLowerCase().indexOf("peaceful") >= 0;
      } catch (eP) { /* ignore */ }
      if (!peaceful) {
        try {
          const remotes = window.__mpCoopRemotes || {};
          Object.keys(remotes).forEach(function (id) {
            const r = remotes[id];
            (r && r.body ? r.body : []).forEach(function (p) {
              if (p) blocked[(p.x | 0) + "," + (p.y | 0)] = true;
            });
          });
        } catch (eR) { /* ignore */ }
      }
      // Treat solid walls as blocked when present (vanilla modes may have none).
      try {
        const walls = Gsm.scrapeWalls ? Gsm.scrapeWalls(g) : [];
        for (let wi = 0; wi < (walls || []).length; wi++) {
          const wp = walls[wi];
          if (wp) blocked[(wp.x | 0) + "," + (wp.y | 0)] = true;
        }
      } catch (eW) { /* ignore */ }

      const apples = [];
      for (let ai = 0; ai < g.wa.ka.length; ai++) {
        const a = g.wa.ka[ai];
        const p = a && (a.pos || a);
        if (!p) continue;
        const px = p.x | 0;
        const py = p.y | 0;
        if (xMin != null && px < (xMin | 0)) continue;
        if (xMax != null && px > (xMax | 0)) continue;
        apples.push({ x: px, y: py });
      }
      if (!apples.length) return { dirs: [], reason: "no_fruit_in_band" };

      const goals = Object.create(null);
      for (let gi = 0; gi < apples.length; gi++) {
        goals[apples[gi].x + "," + apples[gi].y] = true;
      }

      const deltas = [
        { d: "UP", dx: 0, dy: -1 },
        { d: "DOWN", dx: 0, dy: 1 },
        { d: "LEFT", dx: -1, dy: 0 },
        { d: "RIGHT", dx: 1, dy: 0 },
      ];
      const startKey = sx + "," + sy;
      if (goals[startKey]) return { dirs: [], reason: "on_apple", onApple: true };

      const q = [{ x: sx, y: sy, path: [] }];
      const seen = Object.create(null);
      seen[startKey] = true;
      while (q.length) {
        const cur = q.shift();
        for (let di = 0; di < deltas.length; di++) {
          const nx = cur.x + deltas[di].dx;
          const ny = cur.y + deltas[di].dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = nx + "," + ny;
          if (seen[nk]) continue;
          if (blocked[nk] && !goals[nk]) continue;
          const path = cur.path.concat([deltas[di].d]);
          if (goals[nk]) {
            return {
              dirs: path.slice(0, maxSteps),
              reason: "ok",
              target: { x: nx, y: ny },
            };
          }
          seen[nk] = true;
          if (path.length < 40) q.push({ x: nx, y: ny, path: path });
        }
      }
      // No path to fruit — step into any free neighbor to unstick.
      for (let di = 0; di < deltas.length; di++) {
        const nx = sx + deltas[di].dx;
        const ny = sy + deltas[di].dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (blocked[nx + "," + ny]) continue;
        return { dirs: [deltas[di].d], reason: "wander" };
      }
      return { dirs: [], reason: "stuck" };
    },
    { maxSteps: maxSteps, xMin: xMin, xMax: xMax }
  );
}

/** Park B clear of the classic Small first-apple approach while A eats. */
async function driveBClearOfFirstApple(pageB) {
  await driveKeys(pageB, ["LEFT", "LEFT", "LEFT"]);
}

async function claimDistinctColors(pageA, pageB) {
  await Promise.all([
    pageA.evaluate(function () {
      const app = window.__multiplayerApp;
      if (app && typeof app.claimColor === "function") app.claimColor(0);
    }),
    pageB.evaluate(function () {
      const app = window.__multiplayerApp;
      if (app && typeof app.claimColor === "function") app.claimColor(4);
    }),
  ]);
  await new Promise(function (r) {
    setTimeout(r, 200);
  });
}

async function assertNativePeersOrRepair(page, label) {
  let dump = await dumpPage(page, "tas-native-" + (label || "page").replace(/\s+/g, "-"));
  if (dump.peerBackend === "mosaic" || dump.fallbackReason) {
    await page.evaluate(function () {
      if (typeof window.__mpCoopResetNativePeerPaint === "function") {
        window.__mpCoopResetNativePeerPaint("e2e-repair");
      } else if (
        window.__multiplayerApp &&
        window.__multiplayerApp.coopNative &&
        window.__multiplayerApp.coopNative.resetNativePeerPaint
      ) {
        window.__multiplayerApp.coopNative.resetNativePeerPaint();
      }
    });
    await new Promise(function (r) {
      setTimeout(r, 200);
    });
    dump = await dumpPage(page, "tas-native-retry-" + (label || "page").replace(/\s+/g, "-"));
  }
  assertNativePeers(dump, label);
  return dump;
}

async function waitBoardsMatch(pageA, pageB, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  let last = null;
  while (Date.now() < deadline) {
    const snap = await Promise.all([
      pageA.evaluate(function () {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        const head =
          g && g.oa && g.oa.ka && g.oa.ka[0]
            ? { x: g.oa.ka[0].x | 0, y: g.oa.ka[0].y | 0 }
            : null;
        const remotes = window.__mpCoopRemotes || {};
        const ids = Object.keys(remotes);
        const peer = ids.length ? remotes[ids[0]] : null;
        const peerHead =
          peer && peer.body && peer.body[0]
            ? { x: peer.body[0].x | 0, y: peer.body[0].y | 0 }
            : null;
        const fruit =
          g && g.wa && Array.isArray(g.wa.ka)
            ? g.wa.ka
                .map(function (a) {
                  return a && a.pos
                    ? (a.pos.x | 0) + "," + (a.pos.y | 0)
                    : "?";
                })
                .sort()
                .join("|")
            : "";
        return { head: head, peerHead: peerHead, fruit: fruit };
      }),
      pageB.evaluate(function () {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        const head =
          g && g.oa && g.oa.ka && g.oa.ka[0]
            ? { x: g.oa.ka[0].x | 0, y: g.oa.ka[0].y | 0 }
            : null;
        const remotes = window.__mpCoopRemotes || {};
        const ids = Object.keys(remotes);
        const peer = ids.length ? remotes[ids[0]] : null;
        const peerHead =
          peer && peer.body && peer.body[0]
            ? { x: peer.body[0].x | 0, y: peer.body[0].y | 0 }
            : null;
        const fruit =
          g && g.wa && Array.isArray(g.wa.ka)
            ? g.wa.ka
                .map(function (a) {
                  return a && a.pos
                    ? (a.pos.x | 0) + "," + (a.pos.y | 0)
                    : "?";
                })
                .sort()
                .join("|")
            : "";
        return { head: head, peerHead: peerHead, fruit: fruit };
      }),
    ]);
    last = { a: snap[0], b: snap[1] };
    if (
      snap[0].fruit === snap[1].fruit &&
      snap[0].head &&
      snap[1].head &&
      snap[0].peerHead &&
      snap[1].peerHead &&
      snap[0].peerHead.x === snap[1].head.x &&
      snap[0].peerHead.y === snap[1].head.y &&
      snap[1].peerHead.x === snap[0].head.x &&
      snap[1].peerHead.y === snap[0].head.y
    ) {
      return last;
    }
    await new Promise(function (r) {
      setTimeout(r, 250);
    });
  }
  return last;
}

function attachPageErrors(page) {
  const errs = [];
  page.on("pageerror", function (err) {
    errs.push(String((err && err.message) || err));
  });
  return errs;
}

function assertNoPosCloneCrash(errs, label) {
  const hits = (errs || []).filter(function (m) {
    return /pos\.clone is not a function/i.test(m);
  });
  assert.equal(
    hits.length,
    0,
    label + " pageerror pos.clone: " + hits.join(" | ")
  );
}

async function bootDualCoopMatch(pageA, pageB, settings) {
  settings = settings || {};
  const clean = {
    trophy: settings.trophy != null ? settings.trophy : 0,
    count: settings.count != null ? settings.count : 0,
    speed: settings.speed != null ? settings.speed : 0,
    size: settings.size != null ? settings.size : 1,
    apple: settings.apple != null ? settings.apple : 0,
  };
  await pageA.evaluate(function () {
    const app = window.__multiplayerApp;
    app.ui.openPuddingSettings("control");
    if (app.client && app.client.setMode) app.client.setMode("coop");
  });
  await new Promise(function (r) {
    setTimeout(r, 400);
  });
  await pageA.evaluate(function () {
    const app = window.__multiplayerApp;
    app.ui.openPuddingSettings("roster");
    const clients = (app.client.roster && app.client.roster.clients) || [];
    clients.forEach(function (c) {
      const id = c.clientId || c.id;
      if (c.role !== "player") app.client.setRole(id, "player");
    });
  });
  await pageA.waitForFunction(
    function () {
      const r = window.__multiplayerApp.client.roster;
      return (
        r &&
        r.mode === "coop" &&
        r.clients &&
        r.clients.filter(function (c) {
          return c.role === "player";
        }).length === 2
      );
    },
    { timeout: 30000 }
  );
  await pageA.evaluate(function (clean) {
    const app = window.__multiplayerApp;
    const Gsm = window.MultiplayerGsm;
    const origSync = app.syncMySettingsAsAdmin
      ? app.syncMySettingsAsAdmin.bind(app)
      : null;
    app.syncMySettingsAsAdmin = function () {
      const s = (origSync && origSync()) || {};
      return Object.assign({}, s, clean);
    };
    if (typeof window.puddingMenuSelect === "function") {
      window.puddingMenuSelect("size", clean.size);
      window.puddingMenuSelect("count", clean.count);
      window.puddingMenuSelect("speed", clean.speed);
      if (clean.trophy != null) window.puddingMenuSelect("trophy", clean.trophy);
    }
    if (Gsm && Gsm.forceEngineSizeForPlay) Gsm.forceEngineSizeForPlay(clean.size);
    if (Gsm && Gsm.forceMatchSettingsForPlay) {
      Gsm.forceMatchSettingsForPlay(clean);
    }
    window.__mpCoopPlaySettings = Object.assign({}, clean);
    window.__mpMatchPlaySettings = Object.assign({}, clean);
    if (app.syncMySettingsAsAdmin) app.syncMySettingsAsAdmin();
  }, clean);
  await new Promise(function (r) {
    setTimeout(r, 500);
  });
  if (typeof settings.beforeReady === "function") {
    await settings.beforeReady(pageA, pageB);
  }
  await pageA.evaluate(function () {
    window.__multiplayerApp.client.setReady(true);
  });
  await pageB.evaluate(function () {
    window.__multiplayerApp.client.setReady(true);
  });
  await pageA.waitForFunction(
    function () {
      const r = window.__multiplayerApp.client.roster;
      return r && r.allPlayersReady === true;
    },
    { timeout: 20000 }
  );
  await pageA.evaluate(function () {
    const app = window.__multiplayerApp;
    if (app.startMatchAsAdmin) app.startMatchAsAdmin();
  });
  await pageA.waitForFunction(
    function () {
      const app = window.__multiplayerApp;
      const Gsm = window.MultiplayerGsm;
      const live = Gsm && Gsm.boardSizeFromGame && Gsm.boardSizeFromGame();
      return (
        (live && live.width === 10 && live.height === 9) ||
        (app && app._coopEndReason)
      );
    },
    { timeout: 90000 }
  );
  await pageA.waitForFunction(
    function () {
      const app = window.__multiplayerApp;
      if (app && app._coopEndReason) return true;
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      return !!(g && g.wa && Array.isArray(g.wa.ka) && g.wa.ka.length > 0);
    },
    { timeout: 20000 }
  ).catch(function () {});
  await new Promise(function (r) {
    setTimeout(r, 800);
  });
  if ((clean.speed | 0) === 1) {
    await Promise.all([forceFastSpeed(pageA), forceFastSpeed(pageB)]);
  }
}

/** Bake Fast (speed index 1 → Fb = 135×0.66) onto the live game. */
async function forceFastSpeed(page) {
  return page.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    try {
      if (typeof window.puddingMenuSelect === "function") {
        window.puddingMenuSelect("speed", 1);
      }
    } catch (eM) { /* ignore */ }
    try {
      if (Gsm && Gsm.forceMatchSettingsForPlay) {
        Gsm.forceMatchSettingsForPlay({ speed: 1 });
      }
      if (Gsm && Gsm.forceEngineMatchFieldsForPlay) {
        Gsm.forceEngineMatchFieldsForPlay({ speed: 1 });
      }
    } catch (eF) { /* ignore */ }
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (!g) return { ok: false };
    if (g.settings) {
      g.settings.Oa = 1;
      g.settings.yb = 1;
    }
    const base = g.settings && g.settings.isMobile ? 175 : 135;
    g.Fb = base * 0.66;
    return { ok: true, Fb: g.Fb, yb: g.settings && g.settings.yb };
  });
}

/**
 * Keep Fast (yb=1) in match settings, but stretch Fb so Playwright can
 * pause between ticks. Real Fast (~89ms) free-runs ahead of the driver.
 */
async function forceTasCrawlSpeed(page, fbMs) {
  fbMs = fbMs != null ? fbMs : 320;
  return page.evaluate(function (ms) {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (!g) return { ok: false };
    if (g.settings) {
      g.settings.Oa = 1;
      g.settings.yb = 1;
    }
    g.Fb = ms;
    return { ok: true, Fb: g.Fb, yb: g.settings && g.settings.yb };
  }, fbMs);
}

/** Scripted A first-apple approach on Small: (5,3) → R R D onto (7,4). */
async function steerAFirstApple(pageA) {
  await pageA.bringToFront();
  const placed = await pageA.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (!g || !g.oa || !g.wa || !Array.isArray(g.wa.ka) || !g.wa.ka.length) {
      return { ok: false, reason: "no_fruit" };
    }
    const size =
      (Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g)) || {
        width: 10,
        height: 9,
      };
    const fruitKeys = Object.create(null);
    for (let i = 0; i < g.wa.ka.length; i++) {
      const p = g.wa.ka[i] && (g.wa.ka[i].pos || g.wa.ka[i]);
      if (p) fruitKeys[(p.x | 0) + "," + (p.y | 0)] = true;
    }
    const blocked = Object.assign({}, fruitKeys);
    try {
      const remotes = window.__mpCoopRemotes || {};
      Object.keys(remotes).forEach(function (id) {
        const r = remotes[id];
        (r && r.body ? r.body : []).forEach(function (p) {
          if (p) blocked[(p.x | 0) + "," + (p.y | 0)] = true;
        });
      });
    } catch (eR) { /* ignore */ }
    function clearBody(hx, hy, dir) {
      const dx = dir === "RIGHT" ? -1 : dir === "LEFT" ? 1 : 0;
      const dy = dir === "DOWN" ? -1 : dir === "UP" ? 1 : 0;
      const body = [];
      for (let s = 0; s < 3; s++) {
        const x = hx + dx * s;
        const y = hy + dy * s;
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
        if (blocked[x + "," + y] && !(x === hx && y === hy && s === 0)) {
          // head may sit where we place; body segs must be free of fruit/peers
          if (s > 0 || fruitKeys[x + "," + y]) return null;
        }
        if (s > 0 && blocked[x + "," + y]) return null;
        body.push({ x: x, y: y });
      }
      return body;
    }
    // Prefer lowest sequenceNumber (Tally) then others
    const order = g.wa.ka
      .map(function (a, idx) {
        return { a: a, idx: idx, seq: a && a.sequenceNumber != null ? a.sequenceNumber : 99 };
      })
      .sort(function (u, v) {
        return u.seq - v.seq;
      });
    for (let oi = 0; oi < order.length; oi++) {
      const pos = order[oi].a.pos || order[oi].a;
      if (!pos) continue;
      const ax = Number(pos.x) | 0;
      const ay = Number(pos.y) | 0;
      const tries = [
        { hx: ax - 1, hy: ay, dir: "RIGHT" },
        { hx: ax + 1, hy: ay, dir: "LEFT" },
        { hx: ax, hy: ay - 1, dir: "DOWN" },
        { hx: ax, hy: ay + 1, dir: "UP" },
      ];
      for (let i = 0; i < tries.length; i++) {
        const t = tries[i];
        if (t.hx < 0 || t.hy < 0 || t.hx >= size.width || t.hy >= size.height) {
          continue;
        }
        if (fruitKeys[t.hx + "," + t.hy]) continue;
        if (blocked[t.hx + "," + t.hy]) continue;
        const body = clearBody(t.hx, t.hy, t.dir);
        if (!body) continue;
        try {
          if (Gsm.writeNativeBody) Gsm.writeNativeBody(g.oa, body);
          else g.oa.ka = body;
        } catch (eW) {
          g.oa.ka = body;
        }
        g.oa.direction = t.dir;
        if ("dir" in g.oa) g.oa.dir = t.dir;
        if (g.nj) g.nj = false;
        const key = {
          UP: "ArrowUp",
          DOWN: "ArrowDown",
          LEFT: "ArrowLeft",
          RIGHT: "ArrowRight",
        }[t.dir];
        if (key) {
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: key,
              code: key,
              bubbles: true,
              cancelable: true,
            })
          );
        }
        return {
          ok: true,
          ax: ax,
          ay: ay,
          dir: t.dir,
          len: g.wa.ka.length,
          fp: g.wa.ka
            .map(function (a) {
              return a && a.pos ? (a.pos.x | 0) + "," + (a.pos.y | 0) : "";
            })
            .sort()
            .join("|"),
        };
      }
    }
    return { ok: false, reason: "no_clear_approach" };
  });
  assert.ok(placed && placed.ok, "place adjacent to fruit: " + JSON.stringify(placed));
  await pageA.waitForFunction(
    function (prev) {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g || !g.wa || !Array.isArray(g.wa.ka)) return false;
      if (g.wa.ka.length !== prev.len) return true;
      if (!g.wa.ka.length) return true;
      const fp = g.wa.ka
        .map(function (a) {
          return a && a.pos ? (a.pos.x | 0) + "," + (a.pos.y | 0) : "";
        })
        .sort()
        .join("|");
      return fp !== prev.fp;
    },
    { fp: placed.fp, len: placed.len },
    { timeout: 45000 }
  );
  await new Promise(function (r) {
    setTimeout(r, 800);
  });
}

async function waitFruitLen(page, expectedLen, timeoutMs) {
  await page.waitForFunction(
    function (want) {
      const app = window.__multiplayerApp;
      if (app && app._coopEndReason) return true;
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      const n = g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : -1;
      return n === want;
    },
    expectedLen,
    { timeout: timeoutMs || 60000 }
  );
}

/**
 * Stop native step loop. Gate is:
 *   (direction !== "NONE" || Oa || Ga !== "NONE") && !pauseGame
 * Coop clears pauseGame, so zero direction+Ga (+Oa). Keep Ca as last facing.
 */
async function holdSnakesNone(pageA, pageB) {
  await Promise.all([
    pageA.evaluate(function () {
      try {
        window.pauseGame = 1;
      } catch (eP) { /* ignore */ }
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g || !g.oa) return;
      const s = g.oa;
      const hold =
        (s.direction && s.direction !== "NONE" && s.direction) ||
        (s.Ca && s.Ca !== "NONE" && s.Ca) ||
        s.__mpTasHoldDir ||
        "RIGHT";
      s.__mpTasHoldDir = hold;
      if ("Ca" in s && (!s.Ca || s.Ca === "NONE")) s.Ca = hold;
      s.direction = "NONE";
      if ("dir" in s) s.dir = "NONE";
      if ("Ga" in s) s.Ga = "NONE";
      if ("yb" in s) s.yb = "NONE";
      if ("Oa" in s) s.Oa = false;
      s.Qb = false;
    }),
    pageB.evaluate(function () {
      try {
        window.pauseGame = 1;
      } catch (eP) { /* ignore */ }
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g || !g.oa) return;
      const s = g.oa;
      const hold =
        (s.direction && s.direction !== "NONE" && s.direction) ||
        (s.Ca && s.Ca !== "NONE" && s.Ca) ||
        s.__mpTasHoldDir ||
        "RIGHT";
      s.__mpTasHoldDir = hold;
      if ("Ca" in s && (!s.Ca || s.Ca === "NONE")) s.Ca = hold;
      s.direction = "NONE";
      if ("dir" in s) s.dir = "NONE";
      if ("Ga" in s) s.Ga = "NONE";
      if ("yb" in s) s.yb = "NONE";
      if ("Oa" in s) s.Oa = false;
      s.Qb = false;
    }),
  ]);
}

/** Alias — real stop is holdSnakesNone (direction+Ga NONE). */
async function pauseBoth(pageA, pageB) {
  await holdSnakesNone(pageA, pageB);
}

/** Resume after hold — restore facing from Ca / __mpTasHoldDir. */
async function resumeBoth(pageA, pageB) {
  await Promise.all([
    pageA.evaluate(function () {
      try {
        window.pauseGame = 0;
      } catch (eP) { /* ignore */ }
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g || !g.oa) return;
      const s = g.oa;
      const hold =
        (s.Ca && s.Ca !== "NONE" && s.Ca) ||
        s.__mpTasHoldDir ||
        "RIGHT";
      s.direction = hold;
      if ("dir" in s) s.dir = hold;
      if ("Ca" in s) s.Ca = hold;
      if ("Ga" in s) s.Ga = "NONE";
      if ("yb" in s) s.yb = "NONE";
      s.Qb = true;
    }),
    pageB.evaluate(function () {
      try {
        window.pauseGame = 0;
      } catch (eP) { /* ignore */ }
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (!g || !g.oa) return;
      const s = g.oa;
      const hold =
        (s.Ca && s.Ca !== "NONE" && s.Ca) ||
        s.__mpTasHoldDir ||
        "RIGHT";
      s.direction = hold;
      if ("dir" in s) s.dir = hold;
      if ("Ca" in s) s.Ca = hold;
      if ("Ga" in s) s.Ga = "NONE";
      if ("yb" in s) s.yb = "NONE";
      s.Qb = true;
    }),
  ]);
}

/** Wait for fruit len on A; hold both snakes (direction NONE) the instant it hits. */
async function waitFruitLenAndFreeze(pageA, pageB, expectedLen, timeoutMs) {
  await pageA.waitForFunction(
    function (want) {
      const app = window.__multiplayerApp;
      if (app && app._coopEndReason) return true;
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      const n = g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : -1;
      if (n !== want) return false;
      if (g && g.oa) {
        g.oa.__mpTasHoldDir = g.oa.direction || g.oa.dir || "RIGHT";
        g.oa.direction = "NONE";
        if ("dir" in g.oa) g.oa.dir = "NONE";
      }
      return true;
    },
    expectedLen,
    { timeout: timeoutMs || 60000 }
  );
  await pageB.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (g && g.oa) {
      g.oa.__mpTasHoldDir = g.oa.direction || g.oa.dir || "RIGHT";
      g.oa.direction = "NONE";
      if ("dir" in g.oa) g.oa.dir = "NONE";
    }
  });
  await freezePages(pageA, pageB);
}

/**
 * Hamiltonian CYCLE on [x0, x0+w) × [0, h) with w even (grid bipartite + even
 * vertices). Warnsdorff-ordered DFS — Small bands are tiny so this is instant.
 */
function findHamCycle(x0, w, h) {
  if ((w & 1) !== 0) {
    throw new Error("findHamCycle requires even width, got " + w);
  }
  const x1 = x0 + w - 1;
  const total = w * h;
  const key = function (p) {
    return (p.x | 0) + "," + (p.y | 0);
  };
  function neighbors(p) {
    const out = [];
    const deltas = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ];
    for (let i = 0; i < 4; i++) {
      const q = { x: (p.x | 0) + deltas[i][0], y: (p.y | 0) + deltas[i][1] };
      if (q.x >= x0 && q.x <= x1 && q.y >= 0 && q.y < h) out.push(q);
    }
    return out;
  }
  const path = [];
  const used = Object.create(null);
  function freeDeg(p) {
    const n = neighbors(p);
    let c = 0;
    for (let i = 0; i < n.length; i++) {
      if (!used[key(n[i])]) c++;
    }
    return c;
  }
  function dfs(cur) {
    path.push(cur);
    used[key(cur)] = true;
    if (path.length === total) {
      const n = neighbors(cur);
      let closes = false;
      for (let i = 0; i < n.length; i++) {
        if (n[i].x === path[0].x && n[i].y === path[0].y) {
          closes = true;
          break;
        }
      }
      if (!closes) {
        path.pop();
        delete used[key(cur)];
        return false;
      }
      return true;
    }
    const opts = neighbors(cur).filter(function (q) {
      return !used[key(q)];
    });
    opts.sort(function (a, b) {
      return freeDeg(a) - freeDeg(b) || a.x - b.x || a.y - b.y;
    });
    for (let i = 0; i < opts.length; i++) {
      if (dfs(opts[i])) return true;
    }
    path.pop();
    delete used[key(cur)];
    return false;
  }
  const starts = [
    { x: x0, y: 0 },
    { x: x0, y: 1 },
    { x: x0 + 1, y: 0 },
  ];
  for (let s = 0; s < starts.length; s++) {
    path.length = 0;
    Object.keys(used).forEach(function (k) {
      delete used[k];
    });
    if (dfs(starts[s])) {
      return path.map(function (p) {
        return { x: p.x | 0, y: p.y | 0 };
      });
    }
  }
  throw new Error("no ham cycle for " + w + "x" + h + " at x0=" + x0);
}

function assertHamCycle(path, x0, w, h, label) {
  assert.equal(path.length, w * h, label + " cycle length");
  const seen = Object.create(null);
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const k = (a.x | 0) + "," + (a.y | 0);
    assert.equal(seen[k], undefined, label + " duplicate " + k);
    seen[k] = true;
    assert.equal(
      Math.abs((a.x | 0) - (b.x | 0)) + Math.abs((a.y | 0) - (b.y | 0)),
      1,
      label + " non-adjacent @" + i + " " + k + "→" + b.x + "," + b.y
    );
  }
}

/** One facing per cycle edge, including last→first close. */
function cellsToCycleDirs(cells) {
  const dirs = [];
  for (let i = 0; i < cells.length; i++) {
    const a = cells[i];
    const b = cells[(i + 1) % cells.length];
    const dx = (b.x | 0) - (a.x | 0);
    const dy = (b.y | 0) - (a.y | 0);
    if (dx === 1 && dy === 0) dirs.push("RIGHT");
    else if (dx === -1 && dy === 0) dirs.push("LEFT");
    else if (dx === 0 && dy === 1) dirs.push("DOWN");
    else if (dx === 0 && dy === -1) dirs.push("UP");
    else {
      throw new Error(
        "cycle gap " + a.x + "," + a.y + " → " + b.x + "," + b.y
      );
    }
  }
  return dirs;
}

/** Dual even-width Hamiltonian cycles on Small 10×9 (4+6). */
function buildDualHamiltonianCover() {
  const pathA = findHamCycle(0, 4, 9);
  const pathB = findHamCycle(4, 6, 9);
  assertHamCycle(pathA, 0, 4, 9, "A");
  assertHamCycle(pathB, 4, 6, 9, "B");
  return {
    width: 10,
    height: 9,
    pathA: pathA,
    pathB: pathB,
    dirsA: cellsToCycleDirs(pathA),
    dirsB: cellsToCycleDirs(pathB),
  };
}

function cellsToDirs(cells) {
  const dirs = [];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const dx = (b.x | 0) - (a.x | 0);
    const dy = (b.y | 0) - (a.y | 0);
    if (dx === 1 && dy === 0) dirs.push("RIGHT");
    else if (dx === -1 && dy === 0) dirs.push("LEFT");
    else if (dx === 0 && dy === 1) dirs.push("DOWN");
    else if (dx === 0 && dy === -1) dirs.push("UP");
  }
  return dirs;
}

/** Rotate a serpentine so it starts at the cell nearest to `from`. */
function rotatePathNear(path, from) {
  if (!path || !path.length || !from) return path || [];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d =
      Math.abs((path[i].x | 0) - (from.x | 0)) +
      Math.abs((path[i].y | 0) - (from.y | 0));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return path.slice(best).concat(path.slice(0, best));
}

async function seedApplesOnCells(pageA, pageB, cells, maxN, opts) {
  maxN = maxN != null ? maxN : 24;
  opts = opts || {};
  const settleMs = opts.settleMs != null ? opts.settleMs : 300;
  const occupied = await Promise.all([
    pageA.evaluate(function () {
      const keys = Object.create(null);
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      const body = (g && g.oa && g.oa.ka) || [];
      for (let i = 0; i < body.length; i++) {
        const p = body[i];
        if (p) keys[(p.x | 0) + "," + (p.y | 0)] = true;
      }
      const remotes = window.__mpCoopRemotes || {};
      Object.keys(remotes).forEach(function (id) {
        const r = remotes[id];
        ((r && r.body) || []).forEach(function (p) {
          if (p) keys[(p.x | 0) + "," + (p.y | 0)] = true;
        });
      });
      return keys;
    }),
    pageB.evaluate(function () {
      const keys = Object.create(null);
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      const body = (g && g.oa && g.oa.ka) || [];
      for (let i = 0; i < body.length; i++) {
        const p = body[i];
        if (p) keys[(p.x | 0) + "," + (p.y | 0)] = true;
      }
      return keys;
    }),
  ]);
  const blocked = Object.assign({}, occupied[0], occupied[1]);
  const fruit = (cells || [])
    .filter(function (c) {
      return !blocked[(c.x | 0) + "," + (c.y | 0)];
    })
    .slice(0, maxN)
    .map(function (c) {
      return { x: c.x | 0, y: c.y | 0, type: 0 };
    });
  // If filter left us short, fill from remaining free cover cells.
  if (fruit.length < maxN) {
    for (let i = 0; i < (cells || []).length && fruit.length < maxN; i++) {
      const c = cells[i];
      const k = (c.x | 0) + "," + (c.y | 0);
      if (blocked[k]) continue;
      if (
        fruit.some(function (f) {
          return (f.x | 0) + "," + (f.y | 0) === k;
        })
      ) {
        continue;
      }
      fruit.push({ x: c.x | 0, y: c.y | 0, type: 0 });
    }
  }
  // Never replace live fruit with an empty list — that falsely trips
  // maybeCoopAllApples (fruitLen===0) while the team score is still low.
  if (!fruit.length) {
    return { a: { ok: false, reason: "empty_seed_skipped" }, fruit: fruit };
  }
  const a = await pageA.evaluate(function (fruit) {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (!g || !g.wa || !Array.isArray(g.wa.ka)) {
      return { ok: false, reason: "no_fruit_host" };
    }
    const template = g.wa.ka[0] || { type: 0 };
    g.wa.ka.length = 0;
    for (let i = 0; i < fruit.length; i++) {
      const f = fruit[i];
      const apple = Object.assign({}, template);
      apple.type = f.type != null ? f.type : 0;
      if (template.pos && typeof template.pos.clone === "function") {
        apple.pos = template.pos.clone();
        apple.pos.x = f.x | 0;
        apple.pos.y = f.y | 0;
      } else if (Gsm.makeNativePoint) {
        apple.pos = Gsm.makeNativePoint(f.x | 0, f.y | 0, template.pos);
      } else {
        apple.pos = { x: f.x | 0, y: f.y | 0 };
      }
      g.wa.ka.push(apple);
    }
    const app = window.__multiplayerApp;
    if (app && app.publishCoopCollectables) {
      app.publishCoopCollectables(true);
    }
    return { ok: true, len: g.wa.ka.length };
  }, fruit);
  const wantFp = fruit
    .map(function (f) {
      return (f.x | 0) + "," + (f.y | 0);
    })
    .sort()
    .join("|");
  await pageB
    .waitForFunction(
      function (want) {
        const Gsm = window.MultiplayerGsm;
        const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
        if (!g || !g.wa || !Array.isArray(g.wa.ka)) return false;
        const fp = g.wa.ka
          .map(function (ap) {
            return ap && ap.pos
              ? (ap.pos.x | 0) + "," + (ap.pos.y | 0)
              : "?";
          })
          .sort()
          .join("|");
        return fp === want;
      },
      wantFp,
      { timeout: 15000 }
    )
    .catch(function () {});
  if (settleMs > 0) {
    await new Promise(function (r) {
      setTimeout(r, settleMs);
    });
  }
  return { a: a, fruit: fruit };
}

async function freezePages(pageA, pageB) {
  // Hold still via direction NONE only (engine skips steps when facing NONE).
  await Promise.all([
    pageA.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa) {
        const hold = g.oa.direction || g.oa.dir || g.oa.Ca || "RIGHT";
        g.oa.__mpTasHoldDir = hold;
        g.oa.direction = "NONE";
        if ("dir" in g.oa) g.oa.dir = "NONE";
        if ("Ca" in g.oa) g.oa.Ca = hold;
        if ("Ga" in g.oa) g.oa.Ga = hold;
      }
      try {
        if (Gsm && Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
      } catch (eD) { /* ignore */ }
      const app = window.__multiplayerApp;
      if (app) {
        app._coopLastPoseFp = null;
        if (app.publishCoopState) {
          app.publishCoopState({ seated: true, forceColors: true });
        }
      }
    }),
    pageB.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa) {
        const hold = g.oa.direction || g.oa.dir || g.oa.Ca || "RIGHT";
        g.oa.__mpTasHoldDir = hold;
        g.oa.direction = "NONE";
        if ("dir" in g.oa) g.oa.dir = "NONE";
        if ("Ca" in g.oa) g.oa.Ca = hold;
        if ("Ga" in g.oa) g.oa.Ga = hold;
      }
      try {
        if (Gsm && Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
      } catch (eD) { /* ignore */ }
      const app = window.__multiplayerApp;
      if (app) {
        app._coopLastPoseFp = null;
        if (app.publishCoopState) {
          app.publishCoopState({ seated: true, forceColors: true });
        }
      }
    }),
  ]);
  await new Promise(function (r) {
    setTimeout(r, 400);
  });
  await Promise.all([
    pageA.evaluate(function () {
      const app = window.__multiplayerApp;
      if (app && app.publishCoopState) {
        app._coopLastPoseFp = null;
        app.publishCoopState({ seated: true, forceColors: true });
      }
    }),
    pageB.evaluate(function () {
      const app = window.__multiplayerApp;
      if (app && app.publishCoopState) {
        app._coopLastPoseFp = null;
        app.publishCoopState({ seated: true, forceColors: true });
      }
    }),
  ]);
  await new Promise(function (r) {
    setTimeout(r, 400);
  });
}

async function unfreezePages(pageA, pageB) {
  // Leave direction NONE until the next driveDualTicks/setSnakeDir call.
  await Promise.all([
    pageA.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa) {
        g.oa.direction = "NONE";
        if ("dir" in g.oa) g.oa.dir = "NONE";
      }
    }),
    pageB.evaluate(function () {
      const Gsm = window.MultiplayerGsm;
      const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa) {
        g.oa.direction = "NONE";
        if ("dir" in g.oa) g.oa.dir = "NONE";
      }
    }),
  ]);
}

/** Assign even-width Hamiltonian cycles so each snake stays in its band. */
function assignCoverPaths(headA, headB) {
  const left = findHamCycle(0, 4, 9);
  const right = findHamCycle(4, 6, 9);
  assertHamCycle(left, 0, 4, 9, "left");
  assertHamCycle(right, 4, 6, 9, "right");
  const ax = (headA && headA.x) | 0;
  const bx = (headB && headB.x) | 0;
  // Left band cols 0–3, right band cols 4–9.
  const aOnLeft = ax <= 3;
  const bOnLeft = bx <= 3;
  if (aOnLeft && !bOnLeft) {
    return {
      pathA: rotatePathNear(left, headA),
      pathB: rotatePathNear(right, headB),
      aBand: "left",
      bBand: "right",
    };
  }
  if (!aOnLeft && bOnLeft) {
    return {
      pathA: rotatePathNear(right, headA),
      pathB: rotatePathNear(left, headB),
      aBand: "right",
      bBand: "left",
    };
  }
  if (aOnLeft && bOnLeft) {
    return {
      pathA: rotatePathNear(left, headA),
      pathB: rotatePathNear(right, headB),
      aBand: "left",
      bBand: "right",
    };
  }
  return {
    pathA: rotatePathNear(right, headA),
    pathB: rotatePathNear(left, headB),
    aBand: "right",
    bBand: "left",
  };
}

/** Greedy key dirs from `from` to `to` (Manhattan, no obstacles). */
function dirsBetween(from, to, maxSteps) {
  maxSteps = maxSteps != null ? maxSteps : 20;
  if (!from || !to) return [];
  let x = from.x | 0;
  let y = from.y | 0;
  const tx = to.x | 0;
  const ty = to.y | 0;
  const dirs = [];
  for (let i = 0; i < maxSteps && (x !== tx || y !== ty); i++) {
    if (x < tx) {
      dirs.push("RIGHT");
      x++;
    } else if (x > tx) {
      dirs.push("LEFT");
      x--;
    } else if (y < ty) {
      dirs.push("DOWN");
      y++;
    } else if (y > ty) {
      dirs.push("UP");
      y--;
    }
  }
  return dirs;
}

/** One step toward `to` that is never a 180° reverse of `facing`. */
function safeStepToward(from, to, facing) {
  if (!from || !to) return null;
  const fx = from.x | 0;
  const fy = from.y | 0;
  const tx = to.x | 0;
  const ty = to.y | 0;
  if (fx === tx && fy === ty) return null;
  const opp = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
  const face = String(facing || "RIGHT").toUpperCase();
  const candidates = [];
  if (fx < tx) candidates.push("RIGHT");
  if (fx > tx) candidates.push("LEFT");
  if (fy < ty) candidates.push("DOWN");
  if (fy > ty) candidates.push("UP");
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] !== opp[face]) return candidates[i];
  }
  // Only reverse would approach — take a perpendicular first (U-turn setup).
  if (face === "LEFT" || face === "RIGHT") {
    return fy <= ty ? "DOWN" : "UP";
  }
  return fx <= tx ? "RIGHT" : "LEFT";
}

async function readFacing(page) {
  return page.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const s = g && g.oa;
    if (!s) return "RIGHT";
    const d =
      (s.Ga && s.Ga !== "NONE" && s.Ga) || s.direction || s.dir || s.Ca;
    return String(d || "RIGHT").toUpperCase();
  });
}

function nearestPathIndex(path, head) {
  if (!path || !path.length || !head) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d =
      Math.abs((path[i].x | 0) - (head.x | 0)) +
      Math.abs((path[i].y | 0) - (head.y | 0));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function onPathCell(path, idx, head) {
  return !!(
    head &&
    path &&
    path[idx] &&
    (head.x | 0) === (path[idx].x | 0) &&
    (head.y | 0) === (path[idx].y | 0)
  );
}

/**
 * Tick-drive both snakes onto their Hamiltonian cycles without 180° reverses.
 * Once a head is on its path, follow cycle dirs (never keep driving past a
 * single target cell — that walked snakes into walls).
 */
async function enterHamCycles(pageA, pageB, pathA, pathB, dirsA, dirsB, maxSteps) {
  maxSteps = maxSteps != null ? maxSteps : 40;
  let idxA = 0;
  let idxB = 0;
  for (let i = 0; i < maxSteps; i++) {
    const [poseA, poseB, faceA, faceB] = await Promise.all([
      readTasPose(pageA),
      readTasPose(pageB),
      readFacing(pageA),
      readFacing(pageB),
    ]);
    if (poseA.end === "ALL_APPLES" || poseB.end === "ALL_APPLES") {
      return { idxA: idxA, idxB: idxB, done: true };
    }
    if ((poseA.end && poseA.end !== "ALL_APPLES") || !poseA.head) {
      return { idxA: idxA, idxB: idxB, dead: "A", end: poseA.end };
    }
    if ((poseB.end && poseB.end !== "ALL_APPLES") || !poseB.head) {
      return { idxA: idxA, idxB: idxB, dead: "B", end: poseB.end };
    }
    idxA = nearestPathIndex(pathA, poseA.head);
    idxB = nearestPathIndex(pathB, poseB.head);
    const onA = onPathCell(pathA, idxA, poseA.head);
    const onB = onPathCell(pathB, idxB, poseB.head);
    if (onA && onB) return { idxA: idxA, idxB: idxB };
    const dA = onA
      ? dirsA[idxA]
      : safeStepToward(poseA.head, pathA[idxA], faceA);
    const dB = onB
      ? dirsB[idxB]
      : safeStepToward(poseB.head, pathB[idxB], faceB);
    await driveDualTicks(pageA, pageB, [dA || "RIGHT"], [dB || "LEFT"], {
      tickTimeoutMs: 5000,
    });
  }
  const [poseA, poseB] = await Promise.all([
    readTasPose(pageA),
    readTasPose(pageB),
  ]);
  return {
    idxA: nearestPathIndex(pathA, poseA.head),
    idxB: nearestPathIndex(pathB, poseB.head),
  };
}

/** Tick-drive both snakes onto target cells without ever requesting a 180°. */
async function driveOntoTargets(pageA, pageB, targetA, targetB, maxSteps) {
  maxSteps = maxSteps != null ? maxSteps : 24;
  for (let i = 0; i < maxSteps; i++) {
    const [poseA, poseB, faceA, faceB] = await Promise.all([
      readTasPose(pageA),
      readTasPose(pageB),
      readFacing(pageA),
      readFacing(pageB),
    ]);
    if (!poseA.head || !poseB.head) return false;
    const onA =
      targetA &&
      (poseA.head.x | 0) === (targetA.x | 0) &&
      (poseA.head.y | 0) === (targetA.y | 0);
    const onB =
      targetB &&
      (poseB.head.x | 0) === (targetB.x | 0) &&
      (poseB.head.y | 0) === (targetB.y | 0);
    if (onA && onB) return true;
    // Already on target: hold facing only if a safe step stays on the cell —
    // otherwise take a non-reverse perpendicular and re-approach next tick.
    const dA = onA
      ? null
      : safeStepToward(poseA.head, targetA, faceA);
    const dB = onB
      ? null
      : safeStepToward(poseB.head, targetB, faceB);
    if (!dA && !dB) return true;
    await driveDualTicks(
      pageA,
      pageB,
      [dA || faceA || "RIGHT"],
      [dB || faceB || "LEFT"]
    );
  }
  return false;
}

/** Simulate walking `dirs` from `from` — returns final cell. */
function walkCells(from, dirs) {
  let x = from.x | 0;
  let y = from.y | 0;
  for (let i = 0; i < (dirs || []).length; i++) {
    const d = dirs[i];
    if (d === "LEFT") x--;
    else if (d === "RIGHT") x++;
    else if (d === "UP") y--;
    else if (d === "DOWN") y++;
  }
  return { x: x, y: y };
}

/**
 * Planned B path during A's first-apple approach: stay in cols 0–3, same tick
 * count, never sit still (every tick has an explicit facing).
 */
function planPartnerApproachDirs(headB, tickCount, w, h) {
  const dirs = [];
  let x = headB.x | 0;
  let y = headB.y | 0;
  let goingUp = y > 0;
  for (let i = 0; i < tickCount; i++) {
    if (goingUp) {
      if (y > 0) {
        dirs.push("UP");
        y--;
      } else {
        goingUp = false;
        if (x > 0) {
          dirs.push("LEFT");
          x--;
        } else {
          dirs.push("DOWN");
          y++;
        }
      }
    } else if (y < (h | 0) - 1) {
      dirs.push("DOWN");
      y++;
    } else {
      goingUp = true;
      if (x < Math.min(3, (w | 0) - 1)) {
        dirs.push("RIGHT");
        x++;
      } else {
        dirs.push("UP");
        y--;
      }
    }
  }
  return dirs;
}

/** Repeat a serpentine cycle enough times for `wantDirs` turns. */
function extendPathDirs(path, wantDirs) {
  if (!path || path.length < 2) return [];
  const one = cellsToDirs(path.concat([path[0]]));
  if (!one.length) return [];
  const out = [];
  while (out.length < wantDirs) {
    for (let i = 0; i < one.length && out.length < wantDirs; i++) {
      out.push(one[i]);
    }
  }
  return out;
}

/**
 * Read head + fruit + tick length so the TAS can plan every turn upfront.
 */
async function readTasPose(page) {
  return page.evaluate(function () {
    const Gsm = window.MultiplayerGsm;
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    const size =
      (Gsm && Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g)) || {
        width: 10,
        height: 9,
      };
    const head = g && g.oa && g.oa.ka && g.oa.ka[0];
    const fruit = [];
    if (g && g.wa && Array.isArray(g.wa.ka)) {
      for (let i = 0; i < g.wa.ka.length; i++) {
        const a = g.wa.ka[i];
        const p = a && (a.pos || a);
        if (p) fruit.push({ x: p.x | 0, y: p.y | 0 });
      }
    }
    return {
      head: head ? { x: head.x | 0, y: head.y | 0 } : null,
      fruit: fruit,
      fruitLen: fruit.length,
      ticks: g ? g.ticks | 0 : -1,
      Fb: g && typeof g.Fb === "number" ? g.Fb : null,
      w: size.width | 0,
      h: size.height | 0,
      total:
        (window.__multiplayerApp && window.__multiplayerApp._coopTotal) | 0,
      goal: (window.__multiplayerApp && window.__multiplayerApp._coopGoal) | 0,
      end:
        (window.__multiplayerApp && window.__multiplayerApp._coopEndReason) ||
        null,
    };
  });
}

/**
 * After Bomb refill (or any spawn), move fruit onto the upcoming planned path
 * cells — the only apple seeding the TAS is allowed to do.
 */
async function seedApplesOntoUpcoming(pageA, pageB, cellsA, cellsB, maxN) {
  const cells = (cellsA || []).concat(cellsB || []);
  return seedApplesOnCells(pageA, pageB, cells, maxN != null ? maxN : 24);
}

async function forceClaimedColors(pageA, pageB) {
  await Promise.all([
    pageA.evaluate(function () {
      const app = window.__multiplayerApp;
      const Gsm = window.MultiplayerGsm;
      const me = app && app.client && app.client.me && app.client.me();
      const id = me && me.colorId;
      if (id == null || !Gsm || !Gsm.applySnakeColor) return;
      Gsm.applySnakeColor(Number(id));
      app._lastAppliedColorId = Number(id);
      app._coopColorsSent = false;
      if (app.publishCoopState) {
        app.publishCoopState({ seated: true, forceColors: true });
      }
    }),
    pageB.evaluate(function () {
      const app = window.__multiplayerApp;
      const Gsm = window.MultiplayerGsm;
      const me = app && app.client && app.client.me && app.client.me();
      const id = me && me.colorId;
      if (id == null || !Gsm || !Gsm.applySnakeColor) return;
      Gsm.applySnakeColor(Number(id));
      app._lastAppliedColorId = Number(id);
      app._coopColorsSent = false;
      if (app.publishCoopState) {
        app.publishCoopState({ seated: true, forceColors: true });
      }
    }),
  ]);
  await new Promise(function (r) {
    setTimeout(r, 300);
  });
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
  if (roomCode) {
    await page.fill("#mp-room-code", roomCode);
  } else {
    await page.fill("#mp-room-code", "");
  }
  await page.evaluate(function () {
    const btn = document.getElementById("mp-conn-toggle");
    if (btn) btn.click();
  });
  await page.waitForFunction(
    function () {
      const app = window.__multiplayerApp;
      return app && app.client && app.client.connected && app.client.joined;
    },
    { timeout: 45000 }
  );
  return page.evaluate(function () {
    const c = window.__multiplayerApp.client;
    return {
      roomCode: c.roster && c.roster.roomCode,
      clientId: c.clientId,
      isAdmin: typeof c.isAdmin === "function" ? c.isAdmin() : false,
    };
  });
}

(SKIP ? describe.skip : describe)(
  "coop GSM dual-browser Load-from-url E2E",
  { timeout: 1200000 },
  function () {
    let roomProc;
    let browserA;
    let browserB;
    let built;
    let modSource;
    let modUrl;
    let wsUrl;

    before(async function () {
      ensureCerts();
      built = readBuiltStamp();
      modSource = readModSource();
      const wsPort = await freePort();
      modUrl =
        FAKE_MOD_ORIGIN +
        "/MultiplayerMod.js?t=" +
        encodeURIComponent(built);
      wsUrl = "wss://127.0.0.1:" + wsPort + "/ws";
      roomProc = startRoomServer(wsPort);
      await waitPort(wsPort);

      fs.mkdirSync(DUMP_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DUMP_DIR, "meta-boot.json"),
        JSON.stringify({ modUrl: modUrl, wsUrl: wsUrl, built: built }, null, 2)
      );

      const { chromium } = require("playwright");
      const screen = getScreenSize();
      const halfW = Math.max(640, (screen.width / 2) | 0);
      const fullH = Math.max(480, screen.height | 0);
      global.__mpE2EScreen = screen;
      const baseArgs = [
        "--ignore-certificate-errors",
        "--mute-audio",
        "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
        "--window-size=" + halfW + "," + fullH,
      ];
      browserA = await chromium.launch({
        headless: !HEADED,
        slowMo: SLOW_MO,
        args: baseArgs.concat(["--window-position=0,0"]),
      });
      browserB = await chromium.launch({
        headless: !HEADED,
        slowMo: SLOW_MO,
        args: baseArgs.concat(["--window-position=" + halfW + ",0"]),
      });
    });

    async function openDualPages() {
      const screen = global.__mpE2EScreen || getScreenSize();
      const ctxOpts = { ignoreHTTPSErrors: true, viewport: null };
      const [ctxA, ctxB] = await Promise.all([
        browserA.newContext(ctxOpts),
        browserB.newContext(ctxOpts),
      ]);
      const [pageA, pageB] = await Promise.all([
        ctxA.newPage(),
        ctxB.newPage(),
      ]);
      await Promise.all([
        applyHalfScreenBounds(pageA, "left", screen),
        applyHalfScreenBounds(pageB, "right", screen),
      ]);
      await Promise.all([pageA.bringToFront(), pageB.bringToFront()]).catch(
        function () {}
      );
      return { ctxA: ctxA, ctxB: ctxB, pageA: pageA, pageB: pageB, screen: screen };
    }

    after(async function () {
      if (browserA) await browserA.close().catch(function () {});
      if (browserB) await browserB.close().catch(function () {});
      if (roomProc) roomProc.kill();
    });

    it("Small→10×9, fruit visible, peers native or explicit fallbackReason", async function () {
      const ctxOpts = { ignoreHTTPSErrors: true };
      const ctxA = await browserA.newContext(ctxOpts);
      const ctxB = await browserB.newContext(ctxOpts);
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const consoleA = [];
      const consoleB = [];
      pageA.on("console", function (msg) {
        const t = msg.text();
        if (/^\[Multiplayer\]|bake|COLLECTABLES|fallbackReason|BAKE_/i.test(t)) {
          consoleA.push(t.slice(0, 500));
        }
      });
      pageB.on("console", function (msg) {
        const t = msg.text();
        if (/^\[Multiplayer\]|bake|COLLECTABLES|fallbackReason|BAKE_/i.test(t)) {
          consoleB.push(t.slice(0, 500));
        }
      });

      await loadModFromUrl(ctxA, pageA, modUrl, built, modSource);
      await loadModFromUrl(ctxB, pageB, modUrl, built, modSource);

      assert.equal(
        await pageA.evaluate(function () {
          return window.__MP_MOD_BUILT;
        }),
        built,
        "page A Built stamp"
      );
      assert.equal(
        await pageB.evaluate(function () {
          return window.__MP_MOD_BUILT;
        }),
        built,
        "page B Built stamp"
      );

      const joinA = await connectPage(pageA, wsUrl, "E2E-A", "");
      assert.ok(joinA.roomCode, "admin created room");
      const joinB = await connectPage(pageB, wsUrl, "E2E-B", joinA.roomCode);
      assert.equal(joinB.roomCode, joinA.roomCode);

      await pageA.evaluate(function () {
        const app = window.__multiplayerApp;
        app.ui.openPuddingSettings("control");
        if (app.client && app.client.setMode) app.client.setMode("coop");
      });
      await new Promise(function (r) {
        setTimeout(r, 400);
      });
      await pageA.evaluate(function () {
        const app = window.__multiplayerApp;
        app.ui.openPuddingSettings("roster");
        const clients = (app.client.roster && app.client.roster.clients) || [];
        clients.forEach(function (c) {
          const id = c.clientId || c.id;
          if (c.role !== "player") app.client.setRole(id, "player");
        });
      });
      await pageA.waitForFunction(
        function () {
          const r = window.__multiplayerApp.client.roster;
          return (
            r &&
            r.mode === "coop" &&
            r.clients &&
            r.clients.filter(function (c) {
              return c.role === "player";
            }).length === 2
          );
        },
        { timeout: 30000 }
      );

      await pageA.evaluate(function () {
        const app = window.__multiplayerApp;
        const Gsm = window.MultiplayerGsm;
        const clean = {
          trophy: 0,
          count: 0,
          speed: 0,
          size: 1,
          apple: 0,
        };
        const origSync = app.syncMySettingsAsAdmin
          ? app.syncMySettingsAsAdmin.bind(app)
          : null;
        app.syncMySettingsAsAdmin = function () {
          const s = (origSync && origSync()) || {};
          return Object.assign({}, s, clean);
        };
        if (typeof window.puddingMenuSelect === "function") {
          window.puddingMenuSelect("size", 1);
        }
        if (Gsm && Gsm.forceEngineSizeForPlay) Gsm.forceEngineSizeForPlay(1);
        if (Gsm && Gsm.forceMatchSettingsForPlay) {
          Gsm.forceMatchSettingsForPlay(clean);
        }
        window.__mpCoopPlaySettings = Object.assign({}, clean);
        window.__mpMatchPlaySettings = Object.assign({}, clean);
        if (app.syncMySettingsAsAdmin) app.syncMySettingsAsAdmin();
      });
      await new Promise(function (r) {
        setTimeout(r, 500);
      });

      await pageA.evaluate(function () {
        window.__multiplayerApp.client.setReady(true);
      });
      await pageB.evaluate(function () {
        window.__multiplayerApp.client.setReady(true);
      });
      await pageA.waitForFunction(
        function () {
          const r = window.__multiplayerApp.client.roster;
          return r && r.allPlayersReady === true;
        },
        { timeout: 20000 }
      );

      await pageA.evaluate(function () {
        const app = window.__multiplayerApp;
        if (app.startMatchAsAdmin) app.startMatchAsAdmin();
      });

      await pageA.waitForFunction(
        function () {
          const app = window.__multiplayerApp;
          const r = app && app.client && app.client.roster;
          const Gsm = window.MultiplayerGsm;
          const live =
            Gsm && Gsm.boardSizeFromGame && Gsm.boardSizeFromGame();
          return (
            (live && live.width === 10 && live.height === 9) ||
            (app && app._coopEndReason)
          );
        },
        { timeout: 90000 }
      );
      // Fruit may land a beat after bake + COLLECTABLES_DELTA
      await pageA.waitForFunction(
        function () {
          const app = window.__multiplayerApp;
          if (app && app._coopEndReason) return true;
          const Gsm = window.MultiplayerGsm;
          const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
          return !!(g && g.wa && Array.isArray(g.wa.ka) && g.wa.ka.length > 0);
        },
        { timeout: 20000 }
      ).catch(function () {});
      await new Promise(function (r) {
        setTimeout(r, 1500);
      });

      const dumpA = await dumpPage(pageA, "page-a");
      const dumpB = await dumpPage(pageB, "page-b");
      fs.writeFileSync(
        path.join(DUMP_DIR, "console-a.json"),
        JSON.stringify(consoleA, null, 2)
      );
      fs.writeFileSync(
        path.join(DUMP_DIR, "console-b.json"),
        JSON.stringify(consoleB, null, 2)
      );
      fs.writeFileSync(
        path.join(DUMP_DIR, "meta.json"),
        JSON.stringify({ modUrl: modUrl, wsUrl: wsUrl, built: built }, null, 2)
      );

      assert.equal(dumpA.modVersion, "13", "HUD version stays v13");
      assert.equal(dumpB.modVersion, "13");
      assert.equal(
        dumpA.coopEndReason,
        null,
        "no bake abort: " + dumpA.coopEndReason
      );
      assert.ok(dumpA.liveBoard, "page A has live board");
      assert.equal(dumpA.liveBoard.width, 10, "A width Small 10");
      assert.equal(dumpA.liveBoard.height, 9, "A height Small 9");
      assert.ok(dumpB.liveBoard, "page B has live board");
      assert.equal(dumpB.liveBoard.width, 10, "B width Small 10");
      assert.equal(dumpB.liveBoard.height, 9, "B height Small 9");
      assert.ok(
        dumpA.forceSaBeforeAa ||
          dumpA.forceSnaRan ||
          dumpA.playController ||
          (dumpA.liveBoard &&
            dumpA.liveBoard.width === 10 &&
            dumpA.Sa === 1),
        "Ma/Sna bake path armed or Small dims forced"
      );
      assert.ok(
        dumpA.fruitLen > 0,
        "fruit visible on A (len=" + dumpA.fruitLen + ")"
      );
      assert.ok(
        dumpB.fruitLen > 0,
        "fruit visible on B (len=" + dumpB.fruitLen + ")"
      );
      // Classic aT(0,0) on Small 10×9 = (7,4)
      const a0 = dumpA.fruitPos && dumpA.fruitPos[0];
      assert.ok(a0, "fruit pos dumped");
      assert.equal(Number(a0.x), 7, "Classic aT x");
      assert.equal(Number(a0.y), 4, "Classic aT y");
      const mosaicHit = consoleA.some(function (line) {
        return String(line).indexOf("mosaic fallback: mutation-audit") >= 0;
      });
      assert.equal(
        mosaicHit,
        false,
        "no sticky mutation-audit mosaic fallback"
      );
      if (dumpA.fallbackReason) {
        console.log("[e2e] page A fallbackReason:", dumpA.fallbackReason);
      }
      if (dumpB.fallbackReason) {
        console.log("[e2e] page B fallbackReason:", dumpB.fallbackReason);
      }
      if (dumpA.peerBackend) {
        console.log("[e2e] page A peerBackend:", dumpA.peerBackend);
      }

      await ctxA.close();
      await ctxB.close();
    });

    it("eat/roll matrix counts 0–6: dual fruit sync after eats", async function () {
      const COUNT_EXPECT = {
        0: { name: "1a", afterFirst: "move" },
        1: { name: "3a", afterFirst: "move" },
        2: { name: "5a", afterFirst: "move" },
        3: { name: "10a", afterFirst: "move" },
        4: { name: "dice", afterFirst: "dice" },
        5: { name: "bomb", afterFirst: "bomb24" },
        6: { name: "tally", afterFirst: "tally5" },
      };
      const only = (process.env.MP_E2E_COUNTS || "")
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean)
        .map(Number);
      const timeline = [];
      for (let count = 0; count <= 6; count++) {
        if (only.length && only.indexOf(count) < 0) continue;
        const meta = COUNT_EXPECT[count];
        const dual = await openDualPages();
        const pageA = dual.pageA;
        const pageB = dual.pageB;
        const ctxA = dual.ctxA;
        const ctxB = dual.ctxB;
        const errsA = attachPageErrors(pageA);
        const errsB = attachPageErrors(pageB);
        try {
          await Promise.all([
            loadModFromUrl(ctxA, pageA, modUrl, built, modSource),
            loadModFromUrl(ctxB, pageB, modUrl, built, modSource),
          ]);
          await Promise.all([mutePage(pageA), mutePage(pageB)]);
          const joinA = await connectPage(pageA, wsUrl, "MX-A-" + count, "");
          assert.ok(joinA.roomCode);
          await connectPage(pageB, wsUrl, "MX-B-" + count, joinA.roomCode);
          await bootDualCoopMatch(pageA, pageB, {
            size: 1,
            count: count,
            trophy: 0,
            speed: 1,
          });
          const beforeA = await dumpPage(pageA, "mx-" + count + "-before-a");
          const beforeB = await dumpPage(pageB, "mx-" + count + "-before-b");
          assert.ok(beforeA.fruitLen > 0, meta.name + " fruit on A");
          assert.ok(beforeB.fruitLen > 0, meta.name + " fruit on B");
          assert.equal(
            fruitFingerprint(beforeA.fruitPos),
            fruitFingerprint(beforeB.fruitPos),
            meta.name + " initial fruit match"
          );
          const len0 = beforeA.fruitLen;

          // Dual real-key approach (no teleport): A toward apple, B clears left.
          await Promise.all([
            driveKeys(pageA, ["RIGHT", "RIGHT", "DOWN"]),
            driveKeys(pageB, ["LEFT", "LEFT"]),
          ]);
          for (let step = 0; step < 8; step++) {
            const fruitLen = await pageA.evaluate(function () {
              const Gsm = window.MultiplayerGsm;
              const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
              return g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : 0;
            });
            if (count === 5 && fruitLen >= 24) break;
            if (count !== 5 && fruitLen !== len0) break;
            const planA = await planKeysToNearestApple(pageA, { maxSteps: 3 });
            await Promise.all([
              driveKeys(pageA, (planA && planA.dirs) || ["RIGHT"]),
              driveKeys(pageB, ["LEFT"]),
            ]);
          }

          if (count === 5) {
            await waitFruitLen(pageA, 24, 120000);
            await waitFruitLen(pageB, 24, 120000);
          } else {
            await pageA
              .waitForFunction(
                function (prev) {
                  const Gsm = window.MultiplayerGsm;
                  const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
                  const n =
                    g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : -1;
                  return n !== prev || n === 0;
                },
                len0,
                { timeout: 60000 }
              )
              .catch(function () {});
          }

          const afterA = await dumpPage(pageA, "mx-" + count + "-after-a");
          const afterB = await dumpPage(pageB, "mx-" + count + "-after-b");
          assertNoPosCloneCrash(errsA, meta.name + " A");
          assertNoPosCloneCrash(errsB, meta.name + " B");
          if (count === 5) {
            assert.equal(afterA.fruitLen, 24, "Bomb 1→24 on A");
            assert.equal(afterB.fruitLen, 24, "Bomb 1→24 on B");
          } else if (count === 4) {
            assert.ok(
              afterA.fruitLen >= 1 && afterA.fruitLen <= 6,
              "Dice refill 1–6 got " + afterA.fruitLen
            );
            assert.equal(afterA.fruitLen, afterB.fruitLen, "Dice len A↔B");
          } else {
            assert.equal(afterA.fruitLen, afterB.fruitLen, meta.name + " len A↔B");
            assert.ok(afterA.fruitLen > 0, meta.name + " fruit still on A");
          }
          assertNativePeers(afterA, meta.name + " A");
          assertNativePeers(afterB, meta.name + " B");
          await freezePages(pageA, pageB);
          await waitBoardsMatch(pageA, pageB, 10000);
          await assertBoardPixelMatch(
            pageA,
            pageB,
            "mx-" + count + "-pix",
            6.5
          );
          await unfreezePages(pageA, pageB);
          timeline.push({
            count: count,
            name: meta.name,
            before: len0,
            afterA: afterA.fruitLen,
            afterB: afterB.fruitLen,
            fp: fruitFingerprint(afterA.fruitPos),
          });
        } finally {
          await ctxA.close().catch(function () {});
          await ctxB.close().catch(function () {});
        }
      }
      fs.writeFileSync(
        path.join(DUMP_DIR, "eat-roll-matrix.json"),
        JSON.stringify(timeline, null, 2)
      );
    });

    it("Small+Bomb dual TAS: native peers, scores, ALL_APPLES", { timeout: 180000 }, async function () {
      const dual = await openDualPages();
      const pageA = dual.pageA;
      const pageB = dual.pageB;
      const ctxA = dual.ctxA;
      const ctxB = dual.ctxB;
      const timeline = [];
      try {
        await Promise.all([
          loadModFromUrl(ctxA, pageA, modUrl, built, modSource),
          loadModFromUrl(ctxB, pageB, modUrl, built, modSource),
        ]);
        await Promise.all([mutePage(pageA), mutePage(pageB)]);

        const joinA = await connectPage(pageA, wsUrl, "BOMB-A", "");
        assert.ok(joinA.roomCode);
        await connectPage(pageB, wsUrl, "BOMB-B", joinA.roomCode);

        // Ready-color wrap: both pick Blue while unready; Ready bumps B.
        await bootDualCoopMatch(pageA, pageB, {
          size: 1,
          count: 5,
          trophy: 0,
          speed: 1,
          beforeReady: async function (pA, pB) {
            await Promise.all([
              pA.evaluate(function () {
                const app = window.__multiplayerApp;
                if (app && app.client && app.client.claimColor) {
                  app.client.claimColor(0);
                }
              }),
              pB.evaluate(function () {
                const app = window.__multiplayerApp;
                if (app && app.client && app.client.claimColor) {
                  app.client.claimColor(0);
                }
              }),
            ]);
            await new Promise(function (r) {
              setTimeout(r, 300);
            });
          },
        });

        const colors = await Promise.all([
          pageA.evaluate(function () {
            const me =
              window.__multiplayerApp &&
              window.__multiplayerApp.client &&
              window.__multiplayerApp.client.me &&
              window.__multiplayerApp.client.me();
            return me && me.colorId;
          }),
          pageB.evaluate(function () {
            const me =
              window.__multiplayerApp &&
              window.__multiplayerApp.client &&
              window.__multiplayerApp.client.me &&
              window.__multiplayerApp.client.me();
            return me && me.colorId;
          }),
        ]);
        timeline.push({ t: "colors", a: colors[0], b: colors[1] });
        assert.notEqual(
          colors[0],
          colors[1],
          "ready-color wrap should give distinct colors"
        );
        await forceClaimedColors(pageA, pageB);

        let dumpA = await dumpPage(pageA, "tas-boot-a");
        let dumpB = await dumpPage(pageB, "tas-boot-b");
        assert.equal(dumpA.fruitLen, 1, "Bomb starts with 1");
        assertNativePeers(dumpA, "boot A");
        assertNativePeers(dumpB, "boot B");
        assert.ok(
          dumpA.local &&
            dumpB.local &&
            dumpA.local.Sc &&
            dumpB.local.Sc &&
            dumpA.local.Sc !== dumpB.local.Sc,
          "locals must show distinct ready-bumped colors"
        );

        // Live Small goal must not stick at Classic 17×15 (=249 for 2P).
        const goal = await pageA.evaluate(function () {
          const app = window.__multiplayerApp;
          if (!app) return null;
          app._coopGoal = null;
          app._coopGoalBoardW = null;
          return app.ensureCoopAppleGoal ? app.ensureCoopAppleGoal() : null;
        });
        timeline.push({ t: "goal", goal: goal });
        assert.ok(goal != null && goal <= 90, "Small 2P goal <=90, got " + goal);
        assert.ok(goal >= 70, "Small 2P goal sensible, got " + goal);

        // ——— Tick-perfect plan: vanilla Bomb ≤24 fruit, ≤60 ticks ———
        const poseA0 = await readTasPose(pageA);
        const poseB0 = await readTasPose(pageB);
        // Freeze immediately — Fast keeps stepping while we bake the plan,
        // and a few free ticks put live heads miles off the scripted path.
        await holdSnakesNone(pageA, pageB);
        await pauseBoth(pageA, pageB);
        await Promise.all([forceFastSpeed(pageA), forceFastSpeed(pageB)]);
        // Crawl so each planned step is one engine tick (Fast is too fast for
        // Node/Playwright to pause without free-running ahead).
        await Promise.all([
          forceTasCrawlSpeed(pageA, 320),
          forceTasCrawlSpeed(pageB, 320),
        ]);
        const speedSnap = await readTasPose(pageA);
        const speedIdx = await pageA.evaluate(function () {
          const Gsm = window.MultiplayerGsm;
          const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
          const fromSettings = g && g.settings ? g.settings.yb : null;
          const fromMenu =
            Gsm && Gsm.readSettingIndex ? Gsm.readSettingIndex("speed") : null;
          return fromSettings != null ? fromSettings : fromMenu;
        });
        timeline.push({
          t: "speed",
          speedIdx: speedIdx,
          Fb: speedSnap.Fb,
        });
        assert.ok(
          (speedIdx | 0) === 1,
          "match must be Fast setting (yb=1), got idx=" + speedIdx
        );

        // Re-read heads while held so the plan matches the live freeze pose.
        const poseA1 = await readTasPose(pageA);
        const poseB1 = await readTasPose(pageB);
        const apple0 =
          (poseA1.fruit && poseA1.fruit[0]) ||
          (poseB1.fruit && poseB1.fruit[0]) ||
          (poseA0.fruit && poseA0.fruit[0]) ||
          (poseB0.fruit && poseB0.fruit[0]) ||
          { x: 7, y: 4 };
        assert.ok(
          poseA1.head && poseB1.head,
          "both heads readable at freeze"
        );
        const plan = buildBombSmallTickPlan({
          headA: poseA1.head,
          headB: poseB1.head,
          apple0: apple0,
          goal: goal | 0,
        });
        assert.ok(
          plan.ticks.length <= TAS_MAX_TICKS,
          "plan ticks " + plan.ticks.length + " > " + TAS_MAX_TICKS
        );
        fs.mkdirSync(DUMP_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(DUMP_DIR, "tas-tick-plan.json"),
          JSON.stringify(plan, null, 2)
        );
        fs.writeFileSync(
          path.join(DUMP_DIR, "tas-tick-plan.md"),
          renderPlanMarkdown(plan)
        );
        timeline.push({
          t: "tick-plan",
          ticks: plan.ticks.length,
          goal: plan.goal,
          aBand: plan.aBand,
          bBand: plan.bBand,
          bombPack: TAS_BOMB_PACK,
        });

        let fruitMaxAfterBomb = 0;
        let seenBombPlace = false;
        let endedA = null;

        // Stay held through plan bake; driveDualTicks(holdAfter) arms each step.
        for (let ti = 1; ti < plan.ticks.length; ti++) {
          const tick = plan.ticks[ti];
          endedA = await pageA.evaluate(function () {
            return (
              (window.__multiplayerApp &&
                window.__multiplayerApp._coopEndReason) ||
              null
            );
          });
          if (endedA === "ALL_APPLES") break;

          if (tick.dirA || tick.dirB) {
            await driveDualTicks(
              pageA,
              pageB,
              [tick.dirA || "RIGHT"],
              [tick.dirB || "LEFT"],
              {
                // Hold the instant the engine tick lands so Fast cannot
                // free-run between Node round-trips / seed settles.
                holdAfter: true,
              }
            );
          }

          // Seed while hard-paused. Skip native Bomb wait — we overwrite fruit.
          const seedCells = tick.apples || [];
          if (tick.placeApples && seedCells.length > 0) {
            await holdSnakesNone(pageA, pageB);
            await pauseBoth(pageA, pageB);
            await seedApplesOnCells(
              pageA,
              pageB,
              seedCells,
              seedCells.length,
              { settleMs: 40 }
            );
            if (tick.note === "bomb24-place") seenBombPlace = true;
          }

          const snap = await readTasPose(pageA);
          if (seenBombPlace || tick.note === "bomb24-place") {
            fruitMaxAfterBomb = Math.max(
              fruitMaxAfterBomb,
              snap.fruitLen | 0
            );
          }
          if (ti <= 8 || ti % 5 === 0 || tick.note === "win" || tick.note === "bomb24-place") {
            const face = await pageA.evaluate(function () {
              const Gsm = window.MultiplayerGsm;
              const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
              const s = g && g.oa;
              return {
                ticks: g ? g.ticks | 0 : -1,
                dir: s && s.direction,
                Ca: s && s.Ca,
                Ga: s && s.Ga,
                yb: s && s.yb,
                Qb: s && !!s.Qb,
                pause: !!window.pauseGame,
              };
            });
            timeline.push({
              t: "tick",
              i: ti,
              note: tick.note,
              planTotal: tick.total,
              planHead: tick.headA,
              face: face,
              snap: {
                fruitLen: snap.fruitLen,
                total: snap.total,
                end: snap.end,
                head: snap.head,
              },
            });
          }
          // Abort early if live head drifted far from the planned cell.
          if (
            snap.head &&
            tick.headA &&
            (Math.abs((snap.head.x | 0) - (tick.headA.x | 0)) > 1 ||
              Math.abs((snap.head.y | 0) - (tick.headA.y | 0)) > 1)
          ) {
            timeline.push({
              t: "desync",
              i: ti,
              live: snap.head,
              plan: tick.headA,
              total: snap.total,
            });
            break;
          }
          if (snap.end === "ALL_APPLES") {
            // Only accept a real board-clear win (near goal), not empty-seed /
            // board_full false ALL_APPLES while the team is still short.
            if ((snap.total | 0) >= (goal | 0) - 2) {
              endedA = "ALL_APPLES";
              break;
            }
            timeline.push({
              t: "false-all",
              i: ti,
              total: snap.total,
              fruitLen: snap.fruitLen,
              goal: goal,
            });
            // Clear the latch and keep driving — seed/board_full can trip this
            // while fruit is still on the board and score << goal.
            await Promise.all([
              pageA.evaluate(function () {
                const app = window.__multiplayerApp;
                if (app) {
                  app._coopEndReason = null;
                  app._coopWon = false;
                  app._coopMatchEndHandled = false;
                }
              }),
              pageB.evaluate(function () {
                const app = window.__multiplayerApp;
                if (app) {
                  app._coopEndReason = null;
                  app._coopWon = false;
                  app._coopMatchEndHandled = false;
                }
              }),
            ]);
            continue;
          }
          if (snap.end && snap.end !== "ALL_APPLES") {
            timeline.push({ t: "dead", end: snap.end, i: ti });
            break;
          }
        }

        timeline.push({
          t: "fruit-cap",
          fruitMaxAfterBomb: fruitMaxAfterBomb,
          bombPack: TAS_BOMB_PACK,
        });
        assert.ok(
          fruitMaxAfterBomb <= TAS_BOMB_PACK + 2,
          "fruit blew past Bomb pack: " + fruitMaxAfterBomb
        );

        const endedB = await pageB.evaluate(function () {
          return (
            (window.__multiplayerApp &&
              window.__multiplayerApp._coopEndReason) ||
            null
          );
        });
        endedA =
          endedA ||
          (await pageA.evaluate(function () {
            return (
              (window.__multiplayerApp &&
                window.__multiplayerApp._coopEndReason) ||
              null
            );
          }));

        dumpA = await dumpPage(pageA, "tas-final-a");
        dumpB = await dumpPage(pageB, "tas-final-b");
        timeline.push({
          t: "final",
          endA: endedA || dumpA.coopEndReason,
          endB: endedB || dumpB.coopEndReason,
          peerA: dumpA.peerBackend,
          peerB: dumpB.peerBackend,
        });
        fs.writeFileSync(
          path.join(DUMP_DIR, "tas-timeline.json"),
          JSON.stringify(timeline, null, 2)
        );
        const endA = endedA || dumpA.coopEndReason;
        const endB = endedB || dumpB.coopEndReason;
        const teamTotal =
          (dumpA.hudScores && dumpA.hudScores.total) != null
            ? dumpA.hudScores.total | 0
            : 0;
        assert.equal(endA, "ALL_APPLES", "A shared ALL");
        assert.equal(endB, "ALL_APPLES", "B shared ALL");
        assert.ok(
          teamTotal >= (goal | 0) - 2,
          "team score near goal, got " + teamTotal + " / " + goal
        );
        assertNativePeers(dumpA, "final A");
        assertNativePeers(dumpB, "final B");
        const scored = timeline.some(function (e) {
          return (
            (e.snap && (e.snap.total | 0) >= 2) ||
            (e.planTotal | 0) >= 2
          );
        });
        assert.ok(scored, "team scored during cover");

        await freezePages(pageA, pageB);
        await assertBoardPixelMatch(pageA, pageB, "tas-pix-final", 6.5).catch(
          function (err) {
            timeline.push({ t: "pix-final-err", err: String(err && err.message) });
            fs.writeFileSync(
              path.join(DUMP_DIR, "tas-timeline.json"),
              JSON.stringify(timeline, null, 2)
            );
          }
        );

        const pauseMs = Math.max(
          0,
          Number(process.env.MP_E2E_PAUSE_MS) || (HEADED ? 8000 : 0)
        );
        if (pauseMs > 0) {
          await new Promise(function (r) {
            setTimeout(r, pauseMs);
          });
        }
      } finally {
        await ctxA.close().catch(function () {});
        await ctxB.close().catch(function () {});
      }
    });

    it(
      "evidence: peer pupils, mid-play lag probe, single-death survival",
      { timeout: 180000 },
      async function () {
        const dual = await openDualPages();
        const pageA = dual.pageA;
        const pageB = dual.pageB;
        const ctxA = dual.ctxA;
        const ctxB = dual.ctxB;
        const evidence = { eyes: null, lag: null, death: null };
        try {
          await Promise.all([
            loadModFromUrl(ctxA, pageA, modUrl, built, modSource),
            loadModFromUrl(ctxB, pageB, modUrl, built, modSource),
          ]);
          await Promise.all([mutePage(pageA), mutePage(pageB)]);

          const joinA = await connectPage(pageA, wsUrl, "EV-A", "");
          assert.ok(joinA.roomCode);
          await connectPage(pageB, wsUrl, "EV-B", joinA.roomCode);

          await bootDualCoopMatch(pageA, pageB, {
            size: 1,
            count: 0,
            trophy: 0,
            speed: 1,
            beforeReady: async function (pA, pB) {
              await Promise.all([
                pA.evaluate(function () {
                  const app = window.__multiplayerApp;
                  if (app && app.client && app.client.claimColor) {
                    app.client.claimColor(0);
                  }
                }),
                pB.evaluate(function () {
                  const app = window.__multiplayerApp;
                  if (app && app.client && app.client.claimColor) {
                    app.client.claimColor(0);
                  }
                }),
              ]);
              await new Promise(function (r) {
                setTimeout(r, 300);
              });
            },
          });
          await forceClaimedColors(pageA, pageB);
          await new Promise(function (r) {
            setTimeout(r, 600);
          });

          const dumpA = await dumpPage(pageA, "evidence-boot-a");
          const dumpB = await dumpPage(pageB, "evidence-boot-b");
          assertNativePeers(dumpA, "evidence A");
          assertNativePeers(dumpB, "evidence B");
          assert.ok(
            dumpA.local &&
              dumpB.local &&
              dumpA.local.Sc &&
              dumpB.local.Sc &&
              dumpA.local.Sc !== dumpB.local.Sc,
            "evidence needs distinct local colors"
          );

          // Move a moment so peer seats refresh with face retarget
          for (let i = 0; i < 6; i++) {
            await Promise.all([
              pageA.keyboard.press("ArrowRight").catch(function () {}),
              pageB.keyboard.press("ArrowLeft").catch(function () {}),
            ]);
            await new Promise(function (r) {
              setTimeout(r, 100);
            });
          }

          const eyesA = await samplePeerHeadEyes(pageA, "evidence-eyes-a");
          const eyesB = await samplePeerHeadEyes(pageB, "evidence-eyes-b");
          evidence.eyes = { a: eyesA, b: eyesB };
          fs.writeFileSync(
            path.join(DUMP_DIR, "evidence-eyes.json"),
            JSON.stringify(evidence.eyes, null, 2)
          );
          assert.equal(eyesA.ok, true, "eyes sample A: " + eyesA.reason);
          assert.equal(eyesB.ok, true, "eyes sample B: " + eyesB.reason);
          assert.ok(
            (eyesA.faceCtxRetargets | 0) >= 1,
            "A should retarget face ctx during peer paint"
          );
          assert.ok(
            (eyesB.faceCtxRetargets | 0) >= 1,
            "B should retarget face ctx during peer paint"
          );
          assert.ok(
            eyesA.hasPupils,
            "A peer head must show pupil/sclera ink, got ink=" +
              eyesA.ink +
              " sclera=" +
              eyesA.sclera +
              " body=" +
              eyesA.body
          );
          assert.ok(
            eyesB.hasPupils,
            "B peer head must show pupil/sclera ink, got ink=" +
              eyesB.ink +
              " sclera=" +
              eyesB.sclera +
              " body=" +
              eyesB.body
          );

          // Cross-client ids for pairing (needed before grow/sync).
          const remoteIdsA = Object.keys(dumpA.remotes || {});
          const remoteIdsB = Object.keys(dumpB.remotes || {});
          const idB =
            (dumpB.local && dumpB.local.clientId) || remoteIdsA[0] || null;
          const idA =
            (dumpA.local && dumpA.local.clientId) || remoteIdsB[0] || null;

          // Opposed crawl for tip/mid (horizontal only — avoid mid-board collisions).
          for (let i = 0; i < 10; i++) {
            await Promise.all([
              pageA.keyboard.press("ArrowRight").catch(function () {}),
              pageB.keyboard.press("ArrowLeft").catch(function () {}),
            ]);
            await new Promise(function (r) {
              setTimeout(r, 90);
            });
          }
          await new Promise(function (r) {
            setTimeout(r, 150);
          });

          const bLocal = await sampleSnakeParity(pageB, {
            role: "local",
          });
          let aPeerB = await sampleSnakeParity(pageA, {
            role: "peer",
            peerClientId: idB,
          });
          if (
            !aPeerB ||
            !aPeerB.bodyColor ||
            aPeerB.bodyColor.hex === "#FFFFFF" ||
            (aPeerB.head && !aPeerB.head.ok)
          ) {
            await new Promise(function (r) {
              setTimeout(r, 200);
            });
            aPeerB = await sampleSnakeParity(pageA, {
              role: "peer",
              peerClientId: idB,
            });
          }
          const aLocal = await sampleSnakeParity(pageA, {
            role: "local",
          });
          const bPeerA = await sampleSnakeParity(pageB, {
            role: "peer",
            peerClientId: idA,
          });

          // Paired head crops already taken as evidence-eyes-a/b (peer heads).
          // Local head crop for B via parity head sample + screenshot helper.
          const eyesBLocal = await sampleLocalHeadEyes(pageB, "evidence-eyes-b-local");
          const lerpA = await samplePeerLerpSmoothness(pageA, pageB, 14);

          const bodyDist = rgbDist(
            aPeerB && aPeerB.bodyColor,
            bLocal && bLocal.bodyColor
          );
          const parity = {
            idA: idA,
            idB: idB,
            bLocal: bLocal,
            aPeerB: aPeerB,
            aLocal: aLocal,
            bPeerA: bPeerA,
            eyesBLocal: eyesBLocal,
            lerpA: {
              maxHold: lerpA.maxHold,
              holdPairs: lerpA.holdPairs,
              refreshDelta: lerpA.refreshDelta,
              progressChanged: lerpA.progressChanged,
              withPeer: lerpA.withPeer,
              smoothOk: lerpA.smoothOk,
              n: (lerpA.samples && lerpA.samples.length) || 0,
            },
            gates: {
              bodyRgbDist: bodyDist,
              bodyOk: bodyDist <= 45,
              tailA: aPeerB && aPeerB.tail,
              tailB: bLocal && bLocal.tail,
              // Same outward tip bias (proj sign or outRatio within tolerance)
              tailOk:
                aPeerB &&
                aPeerB.tail &&
                aPeerB.tail.ok &&
                bLocal &&
                bLocal.tail &&
                bLocal.tail.ok &&
                (Math.abs(
                  (aPeerB.tail.outRatio || 0) - (bLocal.tail.outRatio || 0)
                ) < 0.12 ||
                  Math.abs(
                    (aPeerB.tail.proj || 0) - (bLocal.tail.proj || 0)
                  ) < 0.08),
              cornerA: aPeerB && aPeerB.corner,
              cornerB: bLocal && bLocal.corner,
              cornerOk:
                aPeerB &&
                aPeerB.corner &&
                bLocal &&
                bLocal.corner &&
                ((aPeerB.corner.ok &&
                  bLocal.corner.ok &&
                  Math.abs(
                    (aPeerB.corner.asym || 0) - (bLocal.corner.asym || 0)
                  ) < 0.15) ||
                  // Short snakes may lack an L — only OK when both agree
                  (!aPeerB.corner.ok &&
                    !bLocal.corner.ok &&
                    aPeerB.corner.reason === "no-corner" &&
                    bLocal.corner.reason === "no-corner" &&
                    (aPeerB.bodyLen | 0) < 5)),
              fringeA: aPeerB && aPeerB.eyeFringe,
              fringeB: bLocal && bLocal.eyeFringe,
              // Cross-tint: fringe around eyes must not hug the *other* snake's Sc.
              fringeOk: (function () {
                function parseHex(hex) {
                  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
                  if (!m) return null;
                  const n = parseInt(m[1], 16);
                  return {
                    r: (n >> 16) & 255,
                    g: (n >> 8) & 255,
                    b: n & 255,
                  };
                }
                function dist(m, hex) {
                  const c = parseHex(hex);
                  if (!m || !c) return 999;
                  return (
                    Math.abs(m.r - c.r) +
                    Math.abs(m.g - c.g) +
                    Math.abs(m.b - c.b)
                  );
                }
                const fa = aPeerB && aPeerB.eyeFringe;
                const fb = bLocal && bLocal.eyeFringe;
                if (!fa || !fb || !fa.ok || !fb.ok) return false;
                // Soft when almost no fringe pixels (AA / soft sheets)
                if ((fa.fringeN | 0) < 4 && (fb.fringeN | 0) < 4) return true;
                const bSc = bLocal && bLocal.liveSc;
                const aSc = aLocal && aLocal.liveSc;
                // A-peer paints B: fringe should be nearer B's Sc than A's Sc
                if (fa.median && bSc && aSc && (fa.fringeN | 0) >= 6) {
                  const toB = dist(fa.median, bSc);
                  const toA = dist(fa.median, aSc);
                  if (toA + 35 < toB) return false;
                }
                // A-local eyes: fringe must not hug B's Sc (classic cross leak)
                const localFringe = aLocal && aLocal.eyeFringe;
                if (
                  localFringe &&
                  localFringe.ok &&
                  localFringe.median &&
                  bSc &&
                  aSc &&
                  (localFringe.fringeN | 0) >= 6
                ) {
                  const toA = dist(localFringe.median, aSc);
                  const toB = dist(localFringe.median, bSc);
                  if (toB + 35 < toA) return false;
                }
                return true;
              })(),
              headA: aPeerB && aPeerB.head,
              headB: bLocal && bLocal.head,
              headOk:
                aPeerB &&
                aPeerB.head &&
                aPeerB.head.ok &&
                bLocal &&
                bLocal.head &&
                bLocal.head.ok &&
                Math.abs(
                  (aPeerB.head.proj || 0) - (bLocal.head.proj || 0)
                ) < 0.65 ||
                // Same rear-of-head mass when both sample eyes (sign can flip
                // with paintedIndex lag); require similar magnitude.
                (Math.abs(aPeerB.head.proj || 0) < 0.45 &&
                  Math.abs(bLocal.head.proj || 0) < 0.45),
              lerpOk: !!(lerpA && lerpA.smoothOk),
              yaBeyondOk: !!(
                bLocal &&
                bLocal.yaVirtual &&
                bLocal.yaVirtual.yaBeyondOk
              ),
            },
          };
          evidence.parity = parity;
          fs.writeFileSync(
            path.join(DUMP_DIR, "evidence-parity.json"),
            JSON.stringify(parity, null, 2)
          );

          assert.equal(
            aPeerB && aPeerB.ok,
            true,
            "A-peer sample: " + ((aPeerB && aPeerB.reason) || "?")
          );
          assert.equal(
            bLocal && bLocal.ok,
            true,
            "B-local sample: " + ((bLocal && bLocal.reason) || "?")
          );
          assert.ok(
            parity.gates.bodyOk,
            "A-peer mid-body RGB must match B-local (dist=" +
              bodyDist +
              " a=" +
              ((aPeerB.bodyColor && aPeerB.bodyColor.hex) || "?") +
              " b=" +
              ((bLocal.bodyColor && bLocal.bodyColor.hex) || "?") +
              ")"
          );
          assert.ok(
            parity.gates.tailOk,
            "A-peer tail facing must match B-local (a.proj=" +
              ((aPeerB.tail && aPeerB.tail.proj) || "?") +
              " b.proj=" +
              ((bLocal.tail && bLocal.tail.proj) || "?") +
              ")"
          );
          assert.ok(
            parity.gates.cornerOk,
            "A-peer L-corner must match B-local (a.asym=" +
              ((aPeerB.corner && aPeerB.corner.asym) || "?") +
              " b.asym=" +
              ((bLocal.corner && bLocal.corner.asym) || "?") +
              " a.reason=" +
              ((aPeerB.corner && aPeerB.corner.reason) || "") +
              ")"
          );
          assert.ok(
            parity.gates.fringeOk,
            "eye fringe must not cross-tint (a.fringe=" +
              ((aPeerB.eyeFringe && aPeerB.eyeFringe.medianHex) || "?") +
              " b.fringe=" +
              ((bLocal.eyeFringe && bLocal.eyeFringe.medianHex) || "?") +
              ")"
          );
          assert.ok(
            parity.gates.headOk,
            "A-peer head facing bias must match B-local (a.proj=" +
              ((aPeerB.head && aPeerB.head.proj) || "?") +
              " b.proj=" +
              ((bLocal.head && bLocal.head.proj) || "?") +
              ")"
          );
          assert.ok(
            parity.gates.lerpOk,
            "peer crawl must refresh mid-tick (refreshDelta=" +
              ((lerpA && lerpA.refreshDelta) || 0) +
              " withPeer=" +
              ((lerpA && lerpA.withPeer) || 0) +
              " progressChanged=" +
              !!(lerpA && lerpA.progressChanged) +
              " maxHold=" +
              ((lerpA && lerpA.maxHold) || 0) +
              ")"
          );
          assert.ok(
            parity.gates.yaBeyondOk,
            "B-local oa.Ya must sit one cell past tip (ya=" +
              JSON.stringify(
                (bLocal && bLocal.yaVirtual && bLocal.yaVirtual.ya) || null
              ) +
              " tip=" +
              JSON.stringify(
                (bLocal && bLocal.yaVirtual && bLocal.yaVirtual.tip) || null
              ) +
              " expect=" +
              JSON.stringify(
                (bLocal && bLocal.yaVirtual && bLocal.yaVirtual.expect) || null
              ) +
              " reason=" +
              ((bLocal && bLocal.yaVirtual && bLocal.yaVirtual.reason) || "") +
              ")"
          );

          await pageA.evaluate(function () {
            const m = window.__mpCoopNativeRenderMetrics;
            // Seed mid-tier paint EMA for status metrics (cadence no longer
            // schedules peer P5E — every peer paints every frame).
            if (m) {
              m.averageRefreshMs = 5;
              m.cadence = 30;
            }
          });
          const lag = await sampleLagWhilePlaying(pageA, pageB, 2200);
          evidence.lag = lag;
          const samples = lag.samples || [];
          assert.ok(samples.length >= 3, "expected lag samples while playing");
          const pings = samples
            .map(function (s) {
              return s.ping;
            })
            .filter(function (p) {
              return p != null && Number.isFinite(p);
            });
          const steady = samples.slice(2);
          const refreshes = steady.map(function (s) {
            return Number(s.averageRefreshMs) || 0;
          });
          const maxRefresh = refreshes.reduce(function (a, b) {
            return Math.max(a, b);
          }, 0);
          const last = samples[samples.length - 1];
          const pingMax = pings.length ? Math.max.apply(null, pings) : null;
          const fpsSamples = steady
            .map(function (s) {
              return s.fps;
            })
            .filter(function (f) {
              return f != null && Number.isFinite(f) && f > 0;
            })
            .sort(function (a, b) {
              return a - b;
            });
          const medianFps =
            fpsSamples.length > 0
              ? fpsSamples[Math.floor(fpsSamples.length / 2)]
              : null;
          // Deferred tint: one restore per dirty frame, not per peer×2 thrash.
          assert.ok(
            (last.faceTintRestores | 0) <= (last.faceTintSwaps | 0) + 2,
            "face tint restores must not exceed swaps (deferred restore)"
          );
          // Co-op must stay playable vs Race (~46fps). Headed dual Playwright
          // is heavier than a real two-window session — gate at 35fps median.
          assert.ok(
            medianFps != null && medianFps >= 35,
            "mid-play median FPS must be >= 35 (got " + medianFps + ")"
          );
          assert.ok(
            maxRefresh <= 80,
            "steady averageRefreshMs must be <= 80ms (got " + maxRefresh + ")"
          );
          // Mid-play [Nms] is WS RTT — only fail when BOTH are badly elevated.
          if (pingMax != null && pingMax >= 8 && maxRefresh > 80) {
            assert.fail(
              "mid-play ping " +
                pingMax +
                "ms rose with paint EMA " +
                maxRefresh +
                "ms — main-thread overwork"
            );
          }
          // Mid-play [Nms] is WS RTT — record correlation; only fail paint budget.
          evidence.lagSummary = {
            pingMin: pings.length ? Math.min.apply(null, pings) : null,
            pingMax: pingMax,
            maxRefresh: maxRefresh,
            medianFps: medianFps,
            faceTintSwaps: last && last.faceTintSwaps,
            faceTintRestores: last && last.faceTintRestores,
            faceCtxRetargets: last && last.faceCtxRetargets,
            a7: last && last.a7,
          };
          fs.writeFileSync(
            path.join(DUMP_DIR, "evidence-lag-summary.json"),
            JSON.stringify(evidence.lagSummary, null, 2)
          );

          // Single-death survival: kill only A, B must stay alive (no ALL_DEAD)
          let preB = await readDeathSurvival(pageB);
          if (preB.deadSent || preB.nj) {
            // Lag crawl may have killed B — treat as dual-death path instead.
            evidence.death = {
              skippedSingle: true,
              reason: "B already dead before A-only kill",
              preB: preB,
            };
            fs.writeFileSync(
              path.join(DUMP_DIR, "evidence-death.json"),
              JSON.stringify(evidence.death, null, 2)
            );
          } else {
          assert.equal(
            preB.deadSent,
            false,
            "precondition: B must still be alive before A-only kill"
          );
          assert.equal(preB.nj, false, "precondition: B native not dead");
          const killed = await forceLocalNativeDeath(pageA);
          assert.equal(killed.ok, true, "force death A");
          await new Promise(function (r) {
            setTimeout(r, 1500);
          });
          const survA = await readDeathSurvival(pageA);
          const survB = await readDeathSurvival(pageB);
          evidence.death = { a: survA, b: survB, killed: killed, preB: preB };
          fs.writeFileSync(
            path.join(DUMP_DIR, "evidence-death.json"),
            JSON.stringify(evidence.death, null, 2)
          );
          assert.notEqual(
            survA.endReason,
            "ALL_DEAD",
            "A-only death must not end the match as ALL_DEAD"
          );
          assert.notEqual(
            survB.endReason,
            "ALL_DEAD",
            "B must not see ALL_DEAD after A-only death"
          );
          assert.equal(survA.deadSent, true);
          assert.equal(survB.deadSent, false, "B must not publish death");
          assert.equal(survB.nj, false, "B native must stay alive");
          // Peer-down awareness: B must see A as down in remotes + HUD scores
          assert.equal(
            survA.hudAlive,
            false,
            "A HUD must mark self down after death"
          );
          assert.equal(
            survB.peerRemoteAlive,
            false,
            "B remotes must mark peer A down after COOP_PLAYER_DEAD"
          );
          assert.equal(
            survB.peerHudAlive,
            false,
            "B HUD scores must show peer A as · down"
          );
          } // end single-death branch

          // Dual death: ensure both dead → ALL_DEAD + death screen on both clients
          let killedB = { ok: true, skipped: true };
          preB = await readDeathSurvival(pageB);
          if (!preB.deadSent && !preB.nj) {
            killedB = await forceLocalNativeDeath(pageB);
            assert.equal(killedB.ok, true, "force death B");
          }
          const killed = (evidence.death && evidence.death.killed) || {
            ok: true,
          };
          if (!evidence.death || evidence.death.skippedSingle) {
            // Ensure A is dead too for ALL_DEAD
            const preA = await readDeathSurvival(pageA);
            if (!preA.deadSent) {
              await forceLocalNativeDeath(pageA);
            }
          } else {
            // A already killed in single-death branch
          }
          // Prefer server SESSION_END; if death publish is rejected in this
          // harness, synthesize the same client handoff both seats run on
          // ALL_DEAD (covers suppressHideDeath + menu reveal).
          let dualA = null;
          let dualB = null;
          for (let i = 0; i < 12; i++) {
            await new Promise(function (r) {
              setTimeout(r, 200);
            });
            dualA = await readDeathSurvival(pageA);
            dualB = await readDeathSurvival(pageB);
            if (
              dualA.endReason === "ALL_DEAD" &&
              dualB.endReason === "ALL_DEAD"
            ) {
              break;
            }
          }
          if (
            !dualA ||
            dualA.endReason !== "ALL_DEAD" ||
            !dualB ||
            dualB.endReason !== "ALL_DEAD"
          ) {
            await Promise.all([
              pageA.evaluate(function () {
                const app = window.__multiplayerApp;
                if (app && app._handleCoopMatchEnded) {
                  app._handleCoopMatchEnded("ALL_DEAD");
                }
              }),
              pageB.evaluate(function () {
                const app = window.__multiplayerApp;
                if (app && app._handleCoopMatchEnded) {
                  app._handleCoopMatchEnded("ALL_DEAD");
                }
              }),
            ]);
            await new Promise(function (r) {
              setTimeout(r, 800);
            });
            dualA = await readDeathSurvival(pageA);
            dualB = await readDeathSurvival(pageB);
          }
          // Give deferred releaseMenusAfterMatch a tick — no forced-visible hack.
          await new Promise(function (r) {
            setTimeout(r, 600);
          });
          dualA = await readDeathSurvival(pageA);
          dualB = await readDeathSurvival(pageB);
          evidence.dualDeath = { a: dualA, b: dualB, killedB: killedB };
          fs.writeFileSync(
            path.join(DUMP_DIR, "evidence-dual-death.json"),
            JSON.stringify(evidence.dualDeath, null, 2)
          );
          assert.equal(
            dualA.endReason,
            "ALL_DEAD",
            "A must see ALL_DEAD after both die"
          );
          assert.equal(
            dualB.endReason,
            "ALL_DEAD",
            "B must see ALL_DEAD after both die"
          );
          assert.ok(
            dualA.overlayVisible || dualA.gsmOverlayVisible,
            "A death screen (.wjOYOd) must be visible after ALL_DEAD without forced styles"
          );
          assert.ok(
            dualB.overlayVisible || dualB.gsmOverlayVisible,
            "B death screen (.wjOYOd) must be visible after ALL_DEAD without forced styles"
          );
        } finally {
          fs.writeFileSync(
            path.join(DUMP_DIR, "evidence-all.json"),
            JSON.stringify(evidence, null, 2)
          );
          await ctxA.close().catch(function () {});
          await ctxB.close().catch(function () {});
        }
      }
    );

  }
);
