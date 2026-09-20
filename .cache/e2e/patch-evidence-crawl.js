"use strict";
const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "..", "..", "tests", "coop-gsm-e2e.test.js");
let s = fs.readFileSync(p, "utf8");
const start = s.indexOf(
  "          // Grow snakes (seed fruit ahead) then introduce L-turns."
);
const end = s.indexOf(
  "          // Paired head crops already taken as evidence-eyes-a/b (peer heads)."
);
if (start < 0 || end < 0) {
  console.error("markers", start, end);
  process.exit(1);
}
const repl = `          // Opposed crawl for tip/mid; short L for corner probe — avoid collisions.
          for (let i = 0; i < 8; i++) {
            await Promise.all([
              pageA.keyboard.press("ArrowRight").catch(function () {}),
              pageB.keyboard.press("ArrowLeft").catch(function () {}),
            ]);
            await new Promise(function (r) {
              setTimeout(r, 90);
            });
          }
          for (let i = 0; i < 3; i++) {
            await Promise.all([
              pageA.keyboard.press("ArrowUp").catch(function () {}),
              pageB.keyboard.press("ArrowDown").catch(function () {}),
            ]);
            await new Promise(function (r) {
              setTimeout(r, 90);
            });
          }
          await new Promise(function (r) {
            setTimeout(r, 150);
          });

          // Cross-client parity: A paints B as peer ≈ B paints B as local.
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

`;
s = s.slice(0, start) + repl + s.slice(end);
fs.writeFileSync(p, s);
console.log("patched", start, end);
