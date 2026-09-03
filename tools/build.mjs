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
  "src/versus/scoreboard.js",
  "src/coop/state.js",
  "src/coop/native.js",
  "src/hooks/gsm.js",
  "src/hooks/visibility.js",
  "src/ui/settingsTab.js",
  "src/versus/focus.js",
  "src/versus/mosaic.js",
  "src/mod.js",
];

const parts = [];
parts.push("/* MultiplayerMod — Remix + Multiplayer LAN layer */\n");
parts.push("/* Built: " + new Date().toISOString() + " */\n");

if (remixSrc) {
  console.log("Bundling Remix from", remixSrc);
  let remixCode = fs.readFileSync(remixSrc, "utf8");
  // SpeedInfo: treat MultiplayerMod like PuddingMod (Pudding is already bundled)
  remixCode = remixCode.replace(
    /localStorage\.getItem\('snakeChosenMod'\) === "PuddingMod" \|\| window\.NepDebug/g,
    'localStorage.getItem(\'snakeChosenMod\') === "PuddingMod" || localStorage.getItem(\'snakeChosenMod\') === "MultiplayerMod" || window.NepDebug || window.MultiplayerMod'
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
