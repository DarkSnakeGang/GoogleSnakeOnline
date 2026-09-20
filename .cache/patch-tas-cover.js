const fs = require("fs");
const p = "tests/coop-gsm-e2e.test.js";
let s = fs.readFileSync(p, "utf8");
const start =
  "        // Separate into bands with non-crossing moves (A left, B right).";
const end = "        const endedB = await pageB.evaluate(function () {";
const i = s.indexOf(start);
const j = s.indexOf(end);
if (i < 0 || j < 0) {
  console.error("markers", i, j);
  process.exit(1);
}
const repl = `        // Dual BFS chase of seeded cover apples (peer bodies blocked).
        let endedA = null;
        let step = 0;
        const deadline = Date.now() + 300000;
        while (Date.now() < deadline) {
          endedA = await pageA.evaluate(function () {
            return (
              (window.__multiplayerApp &&
                window.__multiplayerApp._coopEndReason) ||
              null
            );
          });
          if (endedA === "ALL_APPLES") break;
          const dead = await pageA.evaluate(function () {
            const app = window.__multiplayerApp;
            const me = app && app.client && app.client.me && app.client.me();
            const id = me && (me.clientId || me.id);
            const s = app && app._coopScores && id != null && app._coopScores[id];
            return s && s.alive === false;
          });
          if (dead) {
            timeline.push({ t: "died", step: step });
            assert.fail("A died during cover chase");
          }
          const [planA, planB] = await Promise.all([
            planKeysToNearestApple(pageA, { maxSteps: 3 }),
            planKeysToNearestApple(pageB, { maxSteps: 3 }),
          ]);
          await Promise.all([
            driveKeys(pageA, (planA && planA.dirs) || ["UP"]),
            driveKeys(pageB, (planB && planB.dirs) || ["DOWN"]),
          ]);
          step += 3;
          if (step % 24 === 0) {
            const snap = await pageA.evaluate(function () {
              const Gsm = window.MultiplayerGsm;
              const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
              return {
                fruitLen:
                  g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : -1,
                end:
                  (window.__multiplayerApp &&
                    window.__multiplayerApp._coopEndReason) ||
                  null,
                total:
                  (window.__multiplayerApp &&
                    window.__multiplayerApp._coopTotal) |
                  0,
                peer:
                  (window.__mpCoopNativeRenderMetrics &&
                    window.__mpCoopNativeRenderMetrics.backend) ||
                  null,
                head:
                  g && g.oa && g.oa.ka && g.oa.ka[0]
                    ? { x: g.oa.ka[0].x | 0, y: g.oa.ka[0].y | 0 }
                    : null,
              };
            });
            timeline.push({ t: "cover", step: step, snap: snap });
            assert.notEqual(snap.peer, "mosaic", "native peer mid-cover");
          }
        }

`;
s = s.slice(0, i) + repl + s.slice(j);
fs.writeFileSync(p, s);
console.log("patched", i, j);
