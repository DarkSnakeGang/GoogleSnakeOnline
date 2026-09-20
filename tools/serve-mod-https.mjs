#!/usr/bin/env node
/**
 * HTTPS+CORS static host for MultiplayerMod.js (GSM Load-from-url).
 * Usage: node tools/serve-mod-https.mjs [port]
 * Prints MOD_URL=https://127.0.0.1:<port>/MultiplayerMod.js
 */
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const modPath = path.join(root, "MultiplayerMod.js");
const certDir = path.join(root, ".cache", "e2e-certs");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");
const port = Number(process.env.MP_MOD_PORT || process.argv[2] || 8743) || 8743;

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
      /* try next */
    }
  }
  return null;
}

function ensureCerts() {
  fs.mkdirSync(certDir, { recursive: true });
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return true;
  const openssl = findOpenssl();
  if (!openssl) return false;
  try {
    execSync(
      '"' +
        openssl +
        '" req -x509 -newkey rsa:2048 -keyout "' +
        keyPath +
        '" -out "' +
        certPath +
        '" -days 825 -nodes -subj "/CN=127.0.0.1"',
      { stdio: "ignore" }
    );
    return fs.existsSync(keyPath) && fs.existsSync(certPath);
  } catch (e) {
    return false;
  }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  // Chrome Private Network Access: public GSM → 127.0.0.1 mod host
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
}

function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/" || urlPath === "/MultiplayerMod.js") {
    if (!fs.existsSync(modPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("MultiplayerMod.js missing — run npm run build");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    fs.createReadStream(modPath).pipe(res);
    return;
  }
  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mod: fs.existsSync(modPath) }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

const useHttps = ensureCerts();
let server;
if (useHttps) {
  server = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    handler
  );
} else {
  console.warn(
    "[serve-mod] openssl certs unavailable — serving HTTP (use Chromium --allow-running-insecure-content)"
  );
  server = http.createServer(handler);
}

server.listen(port, "127.0.0.1", function () {
  const scheme = useHttps ? "https" : "http";
  const modUrl = scheme + "://127.0.0.1:" + port + "/MultiplayerMod.js";
  console.log("MOD_HOST=" + scheme + "://127.0.0.1:" + port);
  console.log("MOD_URL=" + modUrl);
  console.log("MOD_HTTPS=" + (useHttps ? "1" : "0"));
});

export default server;
