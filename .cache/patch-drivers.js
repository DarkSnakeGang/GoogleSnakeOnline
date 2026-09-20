/** Apply half-screen bounds once at page birth (launch args alone are unreliable on Windows). */
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
      'powershell -NoProfile -Command "' +
        "Add-Type -TypeDefinition @'" +
        "using System; using System.Runtime.InteropServices; using System.Text;" +
        "public class MpTopMost {" +
        "  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);" +
        "  [DllImport(\\\"user32.dll\\\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);" +
        "  [DllImport(\\\"user32.dll\\\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);" +
        "  [DllImport(\\\"user32.dll\\\")] public static extern bool IsWindowVisible(IntPtr h);" +
        "  [DllImport(\\\"user32.dll\\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int X, int Y, int cx, int cy, uint f);" +
        "  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);" +
        "  public static int Pin() {" +
        "    int n = 0;" +
        "    EnumWindows((h, l) => {" +
        "      if (!IsWindowVisible(h)) return true;" +
        "      var sb = new StringBuilder(512);" +
        "      GetWindowText(h, sb, 512);" +
        "      var t = sb.ToString();" +
        "      if (t.IndexOf(\\\"Snake\\\", StringComparison.OrdinalIgnoreCase) < 0 &&" +
        "          t.IndexOf(\\\"Chromium\\\", StringComparison.OrdinalIgnoreCase) < 0 &&" +
        "          t.IndexOf(\\\"Google\\\", StringComparison.OrdinalIgnoreCase) < 0) return true;" +
        "      SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002);" +
        "      n++; return true;" +
        "    }, IntPtr.Zero);" +
        "    return n;" +
        "  }" +
        "}" +
        "'@; [MpTopMost]::Pin()" +
        '"',
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    );
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Set local snake facing for the *next* engine tick. Returns current ticks.
 * Does not wall-clock sleep — pair with waitGameTick.
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
 * No wall-clock key timing; both snakes advance in lockstep on game.ticks.
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

/** Single-page tick-synced driver (matrix / helpers). */
async function driveKeys(page, dirs, opts) {
  opts = opts || {};
  if (!dirs || !dirs.length) return;
  for (let i = 0; i < dirs.length; i++) {
    const t = await setSnakeDir(page, dirs[i]);
    await waitGameTick(page, t, opts.tickTimeoutMs || 3000);
  }
}
