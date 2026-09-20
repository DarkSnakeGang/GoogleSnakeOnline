const fs = require("fs");
const p = "tests/coop-gsm-e2e.test.js";
let s = fs.readFileSync(p, "utf8");

// Remove ensureNativePeerPaint e2e modeKey hack
const start = "/** Align peer modeKeys and clear sticky mosaic so Peaceful stays native. */\nasync function ensureNativePeerPaint(page) {";
const end = "\nasync function assertNativePeersOrRepair(page, label) {";
const i = s.indexOf(start);
const j = s.indexOf(end);
if (i < 0 || j < 0) {
  console.error("ensureNative markers", i, j);
} else {
  s = s.slice(0, i) + s.slice(j + 1);
  console.log("removed ensureNativePeerPaint");
}

// Patch planKeysToNearestApple to accept band bounds
const oldSig = `async function planKeysToNearestApple(page, opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps != null ? opts.maxSteps : 12;
  return page.evaluate(
    function (maxSteps) {`;
const newSig = `async function planKeysToNearestApple(page, opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps != null ? opts.maxSteps : 12;
  const xMin = opts.xMin;
  const xMax = opts.xMax;
  return page.evaluate(
    function (args) {
      const maxSteps = args.maxSteps;
      const xMin = args.xMin;
      const xMax = args.xMax;`;
if (!s.includes(oldSig)) {
  console.error("planKeys sig not found");
} else {
  s = s.replace(oldSig, newSig);
  s = s.replace(
    `      const apples = [];
      for (let ai = 0; ai < g.wa.ka.length; ai++) {
        const a = g.wa.ka[ai];
        const p = a && (a.pos || a);
        if (p) apples.push({ x: p.x | 0, y: p.y | 0 });
      }
      if (!apples.length) return { dirs: [], reason: "no_fruit" };`,
    `      const apples = [];
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
      if (!apples.length) return { dirs: [], reason: "no_fruit_in_band" };`
  );
  s = s.replace(
    `      return { dirs: [], reason: "stuck" };
    },
    maxSteps
  );
}`,
    `      return { dirs: [], reason: "stuck" };
    },
    { maxSteps: maxSteps, xMin: xMin, xMax: xMax }
  );
}`
  );
  console.log("planKeys band filter patched");
}

fs.writeFileSync(p, s);
console.log("done");
