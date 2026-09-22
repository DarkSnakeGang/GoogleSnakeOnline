"use strict";

/**
 * Run headed dual-live evidence for every mode from Wall through Bridge.
 *
 *   node tools/mode-coop-dual-live.js
 *   node tools/mode-coop-dual-live.js --only=wall,key,gate,bridge
 *   node tools/mode-coop-dual-live.js --from=poison --through=bridge
 *
 * Each mode invokes tools/wall-coop-dual-live.js with --mode / --trophy.
 * Dumps land in .cache/e2e/<mode>-dual/
 */
const { spawnSync } = require("node:child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "wall-coop-dual-live.js");

const ALL = [
  { id: "wall", trophy: 1 },
  { id: "portal", trophy: 2 },
  { id: "cheese", trophy: 3 },
  { id: "borderless", trophy: 4 },
  { id: "twin", trophy: 5 },
  { id: "winged", trophy: 6 },
  { id: "yin_yang", trophy: 7 },
  { id: "key", trophy: 8 },
  { id: "sokoban", trophy: 9 },
  { id: "poison", trophy: 10 },
  { id: "dimension", trophy: 11 },
  { id: "minesweeper", trophy: 12 },
  { id: "statue", trophy: 13 },
  { id: "light", trophy: 14 },
  { id: "shield", trophy: 15 },
  { id: "arrow", trophy: 16 },
  { id: "hotdog", trophy: 17 },
  { id: "magnet", trophy: 18 },
  { id: "gate", trophy: 19 },
  { id: "bridge", trophy: 20 },
];

function parseArgs() {
  let only = null;
  let from = "wall";
  let through = "bridge";
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.indexOf("--only=") === 0) {
      only = a
        .slice(7)
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    }
    if (a.indexOf("--from=") === 0) from = a.slice(7);
    if (a.indexOf("--through=") === 0) through = a.slice(10);
  }
  if (only && only.length) {
    return ALL.filter(function (m) {
      return only.indexOf(m.id) >= 0;
    });
  }
  const i0 = ALL.findIndex(function (m) {
    return m.id === from;
  });
  const i1 = ALL.findIndex(function (m) {
    return m.id === through;
  });
  const a = i0 >= 0 ? i0 : 0;
  const b = i1 >= 0 ? i1 : ALL.length - 1;
  return ALL.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function main() {
  const modes = parseArgs();
  if (!modes.length) {
    console.error("[mode-dual] no modes selected");
    process.exit(2);
  }
  console.log(
    "[mode-dual] running",
    modes.length,
    "modes:",
    modes
      .map(function (m) {
        return m.id;
      })
      .join(", ")
  );
  const results = [];
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i];
    console.log("\n==========", m.id, "(trophy", m.trophy + ")", "==========");
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--mode=" + m.id, "--trophy=" + m.trophy],
      {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          MP_MODE: m.id,
          MP_MODE_TROPHY: String(m.trophy),
        }),
        stdio: "inherit",
      }
    );
    const ok = r.status === 0;
    results.push({ id: m.id, trophy: m.trophy, ok: ok, status: r.status });
    if (!ok) {
      console.error("[mode-dual] FAIL", m.id, "status", r.status);
    } else {
      console.log("[mode-dual] OK", m.id);
    }
  }
  const failed = results.filter(function (r) {
    return !r.ok;
  });
  console.log("\n[mode-dual] summary", {
    passed: results.length - failed.length,
    failed: failed.length,
    modes: results,
  });
  if (failed.length) process.exit(1);
}

main();
