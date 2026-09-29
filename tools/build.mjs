#!/usr/bin/env node
/**
 * Build MultiplayerMod.js = RemixMod.js (bundled) + multiplayer layer.
 * Set REMIX_PATH to RemixMod.js, or place sibling ../GoogleSnakeRemix/RemixMod.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const out = path.join(root, "MultiplayerMod.js");

const remixCandidates = [
  process.env.REMIX_PATH,
  path.join(root, "vendor", "RemixMod.js"),
  path.join(root, "..", "GoogleSnakeRemix", "RemixMod.js"),
].filter(Boolean);

let remixSrc = null;
for (const c of remixCandidates) {
  if (fs.existsSync(c)) {
    remixSrc = c;
    break;
  }
}

const layerFiles = [
  "src/shared/colors.js",
  "src/shared/protocol.js",
  "src/runtime/bridge.js",
  "src/net/client.js",
  "src/session/ready.js",
  "src/race/scoreboard.js",
  "src/coop/state.js",
  "src/coop/session.js",
  "src/coop/native.js",
  "src/coop/binder.js",
  "src/hooks/gsm.js",
  "src/hooks/visibility.js",
  "src/ui/settingsTab.js",
  "src/race/focus.js",
  "src/race/mosaic.js",
  "src/mod.js",
];

const parts = [];
const builtAt = new Date().toISOString();
parts.push("/* MultiplayerMod — Remix + Multiplayer LAN layer */\n");
parts.push("/* Built: " + builtAt + " */\n");

// HUD version — keep in sync with Remix Mod vN (see RemixInit indicator).
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const modDisplayVersion = String(
  pkg.modDisplayVersion != null ? pkg.modDisplayVersion : "13"
);
parts.push(
  "window.__MP_MOD_VERSION=" + JSON.stringify(modDisplayVersion) + ";\n"
);
parts.push("window.__MP_MOD_BUILT=" + JSON.stringify(builtAt) + ";\n");

if (remixSrc) {
  console.log("Bundling Remix from", remixSrc);
  let remixCode = fs.readFileSync(remixSrc, "utf8");
  // SpeedInfo: treat MultiplayerMod like PuddingMod (Pudding is already bundled)
  remixCode = remixCode.replace(
    /localStorage\.getItem\('snakeChosenMod'\) === "PuddingMod" \|\| window\.NepDebug/g,
    'localStorage.getItem(\'snakeChosenMod\') === "PuddingMod" || localStorage.getItem(\'snakeChosenMod\') === "MultiplayerMod" || window.NepDebug || window.MultiplayerMod'
  );
  // Pudding turns on NepDebug for every "Load from url" mod, which pulls CSS/libraries
  // from its author's Live Server (http://127.0.0.1:5500) and triggers Chrome's
  // Local Network Access prompt. That is how players load MultiplayerMod, so debug
  // mode is opt-in only (localStorage.NepDebug = "true").
  const nepDebugCustomUrl =
    /if \(localStorage\.getItem\('snakeChosenMod'\) === "customUrl"\) \{\s*console\.log\("Detect customUrl - enabling debug mode and printing initial code"\)\s*window\.NepDebug = true;\s*\}/;
  if (!nepDebugCustomUrl.test(remixCode)) {
    throw new Error("build: Pudding customUrl→NepDebug block not found — update the patch in tools/build.mjs");
  }
  remixCode = remixCode.replace(
    nepDebugCustomUrl,
    'if (localStorage.getItem("NepDebug") === "true") {\n    window.NepDebug = true;\n  }'
  );
  // DiceCounts inject failures are soft (engine string drift) — don't red-console on Classic
  remixCode = remixCode.replace(
    /console\.error\("DiceCounts: failed to ([^"]+)"\)/g,
    'console.debug("DiceCounts: skipped ($1)")'
  );
  parts.push("\n/* ==== BEGIN RemixMod ==== */\n");
  parts.push(remixCode);
  parts.push("\n/* ==== END RemixMod ==== */\n");
} else {
  console.warn(
    "WARNING: RemixMod.js not found. Building multiplayer-only layer.\n" +
      "Set REMIX_PATH or clone GoogleSnakeRemix as sibling for full bundle."
  );
  parts.push(
    "\nwindow.RemixMod = window.RemixMod || { runCodeBefore(){}, alterSnakeCode(c){return c;}, runCodeAfter(){} };\n"
  );
}

for (const f of layerFiles) {
  const p = path.join(root, f);
  parts.push("\n/* ==== " + f + " ==== */\n");
  parts.push(fs.readFileSync(p, "utf8"));
}

fs.writeFileSync(out, parts.join("\n"));
console.log("Wrote", out, "(" + Math.round(fs.statSync(out).size / 1024) + " KB)");
