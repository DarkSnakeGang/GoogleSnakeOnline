"use strict";
const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "..", "tests", "coop-gsm-e2e.test.js");
let s = fs.readFileSync(p, "utf8");

// 1) Replace applyHalfScreenBounds through end of old driveKeys with new helpers
const startBounds = "/** Apply half-screen bounds once at page birth";
const endDrive = "async function planKeysToNearestApple(page, opts) {";
const i0 = s.indexOf(startBounds);
const i1 = s.indexOf(endDrive);
if (i0 < 0 || i1 < 0) {
  console.error("bounds/drive markers", i0, i1);
  process.exit(1);
}

const drivers = `/** Apply half-screen bounds once at page birth (launch args alone are unreliable on Windows). */
async function applyHalfScreenBounds(page, side, screen) {
  if (!page) return;
  const w = Math.max(640, (screen.width / 2) | 0);
  const h = Math.max(480, screen.height | 0);
  const left = side === "right" ? w : 0;
  try {
    const session = await page.context().newCDPSession(page);
    const target = await session.send("Browser.getWindowForTarget");
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

/** Pin Chromium windows always-on-top (Windows) so headed TAS stays visible. */
function pinBrowserWindowsOnTop() {
  if (process.platform !== "win32") return;
  try {
    execSync(
      "powershell -NoProfile -Command " +
        JSON.stringify(
          "Add-Type -TypeDefinition @'\\n" +
            "using System; using System.Runtime.InteropServices; using System.Text;\\n" +
            "public class MpTopMost {\\n" +
            "  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);\\n" +
            "  [DllImport(\\"user32.dll\\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);\\n" +
            "  [DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\\n" +
            "  [DllImport(\\"user32.dll\\")] public static extern bool IsWindowVisible(IntPtr h);\\n" +
            "  [DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int X, int Y, int cx, int cy, uint f);\\n" +
            "  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);\\n" +
            "  public static int Pin() {\\n" +
            "    int n = 0;\\n" +
            "    EnumWindows((h, l) => {\\n" +
            "      if (!IsWindowVisible(h)) return true;\\n" +
            "      var sb = new StringBuilder(512);\\n" +
            "      GetWindowText(h, sb, 512);\\n" +
            "      var t = sb.ToString();\\n" +
            "      if (t.IndexOf(\\"Snake\\", StringComparison.OrdinalIgnoreCase) < 0 &&\\n" +
            "          t.IndexOf(\\"Chromium\\", StringComparison.OrdinalIgnoreCase) < 0) return true;\\n" +
            "      SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002);\\n" +
            "      n++; return true;\\n" +
            "    }, IntPtr.Zero);\\n" +
            "    return n;\\n" +
            "  }\\n" +
            "}\\n" +
            "'@; [MpTopMost]::Pin()"
        ),
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    );
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Set local snake facing for the next engine tick. Returns current ticks.
 * Pair with waitGameTick — no wall-clock key timing.
 */
async function setSnakeDir(page, dir) {
  return page.evaluate(function (d) {
    window.pauseGame = 0;
    const Gsm = window.MultiplayerGsm;
    if (Gsm && Gsm.setLocalPaused) Gsm.setLocalPaused(false);
    const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
    if (g && g.nj) g.nj = false;
    if (!g) return -1;
    if (d) {
      const hold = String(d).toUpperCase();
      if (typeof window.__fearNativeTurn === "function" && g.oa) {
        window.__fearNativeTurn(g.oa, hold);
      } else if (g.oa) {
        g.oa.direction = hold;
        if ("dir" in g.oa) g.oa.dir = hold;
        if ("Ca" in g.oa) g.oa.Ca = hold;
        if ("Ga" in g.oa) g.oa.Ga = hold;
      }
      const key =
        hold === "UP"
          ? "ArrowUp"
          : hold === "DOWN"
            ? "ArrowDown"
            : hold === "LEFT"
              ? "ArrowLeft"
              : hold === "RIGHT"
                ? "ArrowRight"
                : null;
      if (key) {
        const opts = {
          key: key,
          code: key,
          keyCode:
            key === "ArrowUp"
              ? 38
              : key === "ArrowDown"
                ? 40
                : key === "ArrowLeft"
                  ? 37
                  : 39,
          which:
            key === "ArrowUp"
              ? 38
              : key === "ArrowDown"
                ? 40
                : key === "ArrowLeft"
                  ? 37
                  : 39,
          bubbles: true,
          cancelable: true,
        };
        window.dispatchEvent(new KeyboardEvent("keydown", opts));
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
      if (!g) return false;
      if (window.pauseGame) window.pauseGame = 0;
      return (g.ticks | 0) > (t | 0);
    },
    prevTicks | 0,
    { timeout: timeoutMs || 3000 }
  );
}

/**
 * Dual tick-synced key driver — one planned dir per engine tick on each page.
 * Both snakes advance in lockstep on game.ticks (Fast speed = shorter Fb).
 */
async function driveDualTicks(pageA, pageB, dirsA, dirsB, opts) {
  opts = opts || {};
  const a = dirsA || [];
  const b = dirsB || [];
  const n = Math.max(a.length, b.length);
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const [tA, tB] = await Promise.all([
      setSnakeDir(pageA, a[i] || null),
      setSnakeDir(pageB, b[i] || null),
    ]);
    await Promise.all([
      waitGameTick(pageA, tA, opts.tickTimeoutMs || 3000),
      waitGameTick(pageB, tB, opts.tickTimeoutMs || 3000),
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

`;

s = s.slice(0, i0) + drivers + s.slice(i1);

// 2) openDualPages: pin on top after bounds
s = s.replace(
  `      await Promise.all([
        applyHalfScreenBounds(pageA, "left", screen),
        applyHalfScreenBounds(pageB, "right", screen),
      ]);
      return { ctxA: ctxA, ctxB: ctxB, pageA: pageA, pageB: pageB, screen: screen };
    }`,
  `      await Promise.all([
        applyHalfScreenBounds(pageA, "left", screen),
        applyHalfScreenBounds(pageB, "right", screen),
      ]);
      await Promise.all([pageA.bringToFront(), pageB.bringToFront()]).catch(
        function () {}
      );
      pinBrowserWindowsOnTop();
      return { ctxA: ctxA, ctxB: ctxB, pageA: pageA, pageB: pageB, screen: screen };
    }`
);

// 3) Replace TAS test body from colors assert through cover chase with planned dual cover
const tasStart = '        timeline.push({ t: "colors", a: colors[0], b: colors[1] });';
const tasEnd = '        const endedB = await pageB.evaluate(function () {';
const t0 = s.indexOf(tasStart);
const t1 = s.indexOf(tasEnd, t0);
if (t0 < 0 || t1 < 0) {
  console.error("tas markers", t0, t1);
  process.exit(1);
}

const tasBody = `        timeline.push({ t: "colors", a: colors[0], b: colors[1] });
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

        // Pre-first-eat: tick-synced dual plan (A → classic apple, B clears left).
        const approachA = await planKeysToNearestApple(pageA, { maxSteps: 16 });
        const approachBDirs = ["LEFT", "LEFT", "LEFT", "UP", "UP"];
        const padA = (approachA && approachA.dirs) || ["RIGHT", "RIGHT", "DOWN"];
        const len0 = Math.max(padA.length, approachBDirs.length);
        const aApproach = padA.slice();
        const bApproach = approachBDirs.slice();
        while (aApproach.length < len0) aApproach.push(null);
        while (bApproach.length < len0) bApproach.push(null);
        await driveDualTicks(pageA, pageB, aApproach, bApproach);
        // Finish first eat if needed (still tick-synced, both play).
        for (let step = 0; step < 12; step++) {
          const fruitLen = await pageA.evaluate(function () {
            const Gsm = window.MultiplayerGsm;
            const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
            return g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : 0;
          });
          if (fruitLen >= 24) break;
          const planA = await planKeysToNearestApple(pageA, { maxSteps: 2 });
          const planB = await planKeysToNearestApple(pageB, {
            maxSteps: 2,
            xMin: 0,
            xMax: 3,
          });
          await driveDualTicks(
            pageA,
            pageB,
            (planA && planA.dirs) || ["RIGHT"],
            (planB && planB.dirs && planB.dirs.length ? planB.dirs : ["LEFT"])
          );
        }
        await waitFruitLenAndFreeze(pageA, pageB, 24, 30000);
        await forceClaimedColors(pageA, pageB);

        dumpA = await dumpPage(pageA, "tas-bomb24-a");
        dumpB = await dumpPage(pageB, "tas-bomb24-b");
        assert.equal(dumpA.fruitLen, 24);
        assertNativePeers(dumpA, "bomb24 A");
        assertNativePeers(dumpB, "bomb24 B");
        assert.ok(
          dumpA.hudScores &&
            dumpA.hudScores.scores &&
            Object.keys(dumpA.hudScores.scores).every(function (id) {
              return dumpA.hudScores.scores[id].alive !== false;
            }),
          "both snakes alive after bomb refill"
        );

        // Dual column Hamiltonian: A left 0..4, B right 5..9 — full planned turns.
        const leftBand = buildColCycle(0, 4, 9);
        const rightBand = buildColCycle(5, 9, 9);
        const headA0 = dumpA.local && dumpA.local.head;
        const headB0 = dumpB.local && dumpB.local.head;
        // Approach each band start (still frozen — plan only), then seed apples
        // on path cells ahead so eating advances the planned route.
        const pathA = rotatePathNear(leftBand, headA0);
        const pathB = rotatePathNear(rightBand, headB0);
        const toBandA = dirsBetween(headA0, pathA[0], 20);
        const toBandB = dirsBetween(headB0, pathB[0], 20);
        // Apples on every other cell of each band path (12+12=24).
        const seedCells = [];
        for (let i = 1; i < pathA.length && seedCells.length < 12; i += 1) {
          seedCells.push(pathA[i]);
        }
        for (let i = 1; i < pathB.length && seedCells.length < 24; i += 1) {
          seedCells.push(pathB[i]);
        }
        await seedApplesOnCells(pageA, pageB, seedCells, 24);
        dumpA = await dumpPage(pageA, "tas-seed-a");
        dumpB = await dumpPage(pageB, "tas-seed-b");
        timeline.push({
          t: "seed",
          fruitA: dumpA.fruitLen,
          fruitB: dumpB.fruitLen,
          pathA: pathA.length,
          pathB: pathB.length,
          toBandA: toBandA.length,
          toBandB: toBandB.length,
          goal: goal,
        });
        assert.equal(dumpA.fruitLen, 24, "seeded cover fruit");
        assert.equal(dumpB.fruitFp, dumpA.fruitFp, "seed fruitFp A↔B");

        const matched = await waitBoardsMatch(pageA, pageB, 15000);
        dumpA = await dumpPage(pageA, "tas-pix-pre-a");
        dumpB = await dumpPage(pageB, "tas-pix-pre-b");
        assert.equal(dumpA.fruitFp, dumpB.fruitFp, "fruit must match before pixelmatch");
        assert.ok(
          matched &&
            matched.a &&
            matched.b &&
            matched.a.peerHead &&
            matched.b.peerHead &&
            matched.a.peerHead.x === matched.b.head.x &&
            matched.a.peerHead.y === matched.b.head.y &&
            matched.b.peerHead.x === matched.a.head.x &&
            matched.b.peerHead.y === matched.a.head.y,
          "boards must sync before pixelmatch"
        );
        assertBoardsMatch(dumpA, dumpB, "pre-pix");
        await assertBoardPixelMatch(pageA, pageB, "tas-pix-seed", 6.5);
        await unfreezePages(pageA, pageB);

        // Full planned dual cover: enter bands then walk serpentines once.
        const walkA = toBandA.concat(cellsToDirs(pathA));
        const walkB = toBandB.concat(cellsToDirs(pathB));
        timeline.push({
          t: "plan",
          walkA: walkA.length,
          walkB: walkB.length,
          turnsA: walkA.filter(Boolean).length,
          turnsB: walkB.filter(Boolean).length,
        });
        // Cap walk so Bomb 24 clears well under 90s (Fast ~100ms/tick).
        const maxWalk = Math.max(walkA.length, walkB.length);
        assert.ok(maxWalk < 120, "planned walk too long: " + maxWalk);

        let endedA = null;
        const chunk = 8;
        for (let off = 0; off < maxWalk; off += chunk) {
          endedA = await pageA.evaluate(function () {
            return (
              (window.__multiplayerApp &&
                window.__multiplayerApp._coopEndReason) ||
              null
            );
          });
          if (endedA === "ALL_APPLES") break;
          const sliceA = walkA.slice(off, off + chunk);
          const sliceB = walkB.slice(off, off + chunk);
          await driveDualTicks(pageA, pageB, sliceA, sliceB);
          if (off % 24 === 0) {
            const snap = await pageA.evaluate(function () {
              const Gsm = window.MultiplayerGsm;
              const g = Gsm && Gsm.gameInstance && Gsm.gameInstance();
              const app = window.__multiplayerApp;
              return {
                fruitLen:
                  g && g.wa && Array.isArray(g.wa.ka) ? g.wa.ka.length : -1,
                end: (app && app._coopEndReason) || null,
                total: (app && app._coopTotal) | 0,
                goal: (app && app._coopGoal) | 0,
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
            timeline.push({ t: "cover", off: off, snap: snap });
            assert.notEqual(snap.peer, "mosaic", "native peer mid-cover");
            if (snap.goal) assert.ok(snap.goal <= 90, "goal stayed Small");
          }
        }
        // If apples remain after plan, tick-synced BFS mop-up (both play).
        for (let mop = 0; mop < 40; mop++) {
          endedA = await pageA.evaluate(function () {
            return (
              (window.__multiplayerApp &&
                window.__multiplayerApp._coopEndReason) ||
              null
            );
          });
          if (endedA === "ALL_APPLES") break;
          const [pA, pB] = await Promise.all([
            planKeysToNearestApple(pageA, { maxSteps: 2, xMin: 0, xMax: 4 }),
            planKeysToNearestApple(pageB, { maxSteps: 2, xMin: 5, xMax: 9 }),
          ]);
          const dA = (pA && pA.dirs) || [];
          const dB = (pB && pB.dirs) || [];
          if (!dA.length && !dB.length) {
            const [fA, fB] = await Promise.all([
              planKeysToNearestApple(pageA, { maxSteps: 2 }),
              planKeysToNearestApple(pageB, { maxSteps: 2 }),
            ]);
            await driveDualTicks(
              pageA,
              pageB,
              (fA && fA.dirs) || [],
              (fB && fB.dirs) || []
            );
          } else {
            await driveDualTicks(pageA, pageB, dA, dB);
          }
        }

`;

s = s.slice(0, t0) + tasBody + s.slice(t1);

// 4) TAS test timeout 90s
s = s.replace(
  '    it("Small+Bomb dual TAS: native peers, scores, ALL_APPLES", async function () {',
  '    it("Small+Bomb dual TAS: native peers, scores, ALL_APPLES", { timeout: 90000 }, async function () {'
);

fs.writeFileSync(p, s);
console.log("patched drivers + TAS plan, len", s.length);
