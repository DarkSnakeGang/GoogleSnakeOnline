/** GSM / Remix hooks — puddingMenuSelect, __remixGame, Play/settings, board scrape. */
(function (root) {
  const SETTING_KEYS = ["trophy", "count", "speed", "size", "color", "apple", "graphics", "theme"];
  /** Admin-synced match rules — clients cannot change these while connected. */
  const SYNC_KEYS = ["trophy", "count", "speed", "size"];
  /** Per-client cosmetics — never locked or overwritten by SETTINGS_SYNC. */
  const PERSONAL_KEYS = ["color", "apple", "graphics", "theme"];

  function playButton() {
    return (
      document.querySelector('[jsname="NSjDf"]') ||
      document.querySelector('[jsname^="NSjDf"]') ||
      document.querySelector('button[jsname="NSjDf"]') ||
      document.querySelector('button[aria-label*="Play" i]') ||
      document.querySelector('[aria-label="Play"]')
    );
  }

  function fullscreenButton() {
    return (
      document.querySelector('[jsname="JwM0Ie"]') ||
      document.querySelector('button[aria-label*="ullscreen" i]')
    );
  }

  function settingsGear() {
    return (
      document.querySelector('div[jsname="iyH4Cb"]') ||
      document.querySelector('div[jsname^="iyH4Cb"]')
    );
  }

  function gameCanvas() {
    return (
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector('canvas[class*="nEo"]') ||
      document.querySelector("#canvas") ||
      Array.prototype.find.call(document.querySelectorAll("canvas"), function (c) {
        return c.id !== "mp-focus-board" && !(c.className || "").includes("mp-");
      })
    );
  }

  function openSettingsPanel() {
    // Never yank menus open while Start match is driving Play
    if (root.__mpStartingMatch || root.__mpCoopSession) return false;
    if (typeof root._openSnakeSettingsPanel === "function") {
      try {
        if (root._openSnakeSettingsPanel()) return true;
      } catch (e) { /* fall through */ }
    }
    const gear = settingsGear();
    if (gear && typeof gear.click === "function") {
      gear.click();
      return true;
    }
    return false;
  }

  /** Close native Google settings (and pudding bootstrap) so Play can start. */
  function closeSettingsPanel() {
    let closed = false;
    try {
      if (typeof root.BootstrapHide === "function") {
        root.BootstrapHide();
        closed = true;
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof root._closeSnakeSettingsPanel === "function") {
        if (root._closeSnakeSettingsPanel()) closed = true;
      }
    } catch (e) { /* ignore */ }
    if (!closed) {
      const back =
        document.querySelector(".p17HVe") ||
        document.querySelector('[class^="p17HVe"]') ||
        document.querySelector('[class*="p17HVe"]');
      if (back && typeof back.click === "function") {
        try {
          back.click();
          closed = true;
        } catch (e) { /* ignore */ }
      }
    }
    return closed;
  }

  function readSettingIndex(id) {
    if (typeof root.readGameSettingIndex === "function") {
      try {
        const v = root.readGameSettingIndex(id);
        if (typeof v === "number") return v;
      } catch (e) { /* fall through */ }
    }
    if (root.timeKeeper && typeof root.timeKeeper.getCurrentSetting === "function") {
      try {
        const v = root.timeKeeper.getCurrentSetting(id);
        if (typeof v === "number") return v;
      } catch (e) { /* fall through */ }
    }
    const row = document.getElementById(id) || document.querySelector("#" + id);
    if (!row || !row.children) return null;
    const kids = Array.from(row.children);
    let idx = kids.findIndex(function (el) {
      return el.classList && (el.classList.contains("tuJOWd") || /tuJOWd/.test(el.className || ""));
    });
    if (idx >= 0) return idx;
    const classes = kids.map(function (el) {
      return el.className;
    });
    for (let i = 0; i < kids.length; i++) {
      if (classes.filter(function (c) { return c === classes[i]; }).length === 1) return i;
    }
    return null;
  }

  function snapshotSettings() {
    if (typeof root.saveCurrentGameSettings === "function") {
      try {
        root.saveCurrentGameSettings();
        if (root.pudding_settings && root.pudding_settings.SavedGameSettings) {
          return Object.assign({}, root.pudding_settings.SavedGameSettings);
        }
      } catch (e) { /* fall through */ }
    }
    const out = {};
    SETTING_KEYS.forEach(function (k) {
      const v = readSettingIndex(k);
      if (v != null) out[k] = v;
    });
    return out;
  }

  function selectMenu(key, idx) {
    if (typeof root.puddingMenuSelect === "function") {
      try {
        if (root.puddingMenuSelect(key, idx) === true) return true;
      } catch (e) {
        console.warn("puddingMenuSelect failed", key, e);
      }
    }
    if (typeof root.clickGameSettingIndex === "function") {
      try {
        if (root.clickGameSettingIndex(key, idx) === true) return true;
      } catch (e) { /* fall through */ }
    }
    const row = document.getElementById(key);
    if (row && row.children && row.children[idx] && typeof row.children[idx].click === "function") {
      row.children[idx].click();
      return true;
    }
    return false;
  }

  /**
   * Apply synced settings. Prefer quiet puddingMenuSelect first so lobby
   * changes apply without opening menus; open panel only if DOM still mismatches.
   * Delayed retries are aborted if Start match begins (__mpStartingMatch).
   */
  function applySettings(settings) {
    if (!settings || typeof settings !== "object") return false;
    root.__mpApplySettingsGen = (root.__mpApplySettingsGen || 0) + 1;
    const gen = root.__mpApplySettingsGen;
    function quietApply() {
      let ok = true;
      let needed = false;
      root.__mpApplyingSettings = true;
      try {
        SETTING_KEYS.forEach(function (key) {
          if (settings[key] == null || key.charAt(0) === "_") return;
          if (PERSONAL_KEYS.indexOf(key) >= 0) return;
          const idx = Number(settings[key]);
          if (Number.isNaN(idx)) return;
          const cur = readSettingIndex(key);
          if (cur != null && Number(cur) === idx) return;
          needed = true;
          if (!selectMenu(key, idx)) ok = false;
        });
      } finally {
        root.__mpApplyingSettings = false;
      }
      if (!needed) return true;
      return ok || settingsMatchLocal(settings);
    }
    // Don't yank the settings panel open while a co-op/versus run is starting
    if (root.__mpStartingMatch || root.__mpCoopSession) {
      return quietApply();
    }
    // Lobby / idle: try API first so peers update immediately without a panel flash
    if (typeof root.puddingMenuSelect === "function") {
      if (quietApply()) return true;
    }
    // Prevent SETTINGS_SYNC → DOM click → admin sync → SETTINGS_SYNC loops
    if (root.__mpApplyingSettings) {
      // Another apply in flight — gen bump already invalidates it; retry quiet
      return quietApply();
    }
    root.__mpApplyingSettings = true;
    let opened = false;
    let ok = true;
    function applyOnce() {
      let all = true;
      SETTING_KEYS.forEach(function (key) {
        if (settings[key] == null || key.charAt(0) === "_") return;
        // Cosmetics are personal — never from SETTINGS_SYNC
        if (PERSONAL_KEYS.indexOf(key) >= 0) return;
        const idx = Number(settings[key]);
        if (Number.isNaN(idx)) return;
        const cur = readSettingIndex(key);
        if (cur != null && Number(cur) === idx) return;
        if (!selectMenu(key, idx)) all = false;
      });
      return all;
    }
    function stillCurrent() {
      return (
        gen === root.__mpApplySettingsGen &&
        !root.__mpStartingMatch &&
        !root.__mpCoopSession
      );
    }
    try {
      if (!applyOnce() || !settingsMatchLocal(settings)) {
        opened = openSettingsPanel();
        if (typeof setTimeout === "function") {
          setTimeout(function () {
            if (!stillCurrent()) return;
            applyOnce();
          }, 40);
          setTimeout(function () {
            if (!stillCurrent()) {
              root.__mpApplyingSettings = false;
              return;
            }
            applyOnce();
            root.__mpApplyingSettings = false;
          }, 120);
        } else {
          ok = applyOnce();
          root.__mpApplyingSettings = false;
        }
      } else if (typeof setTimeout === "function") {
        setTimeout(function () {
          if (gen === root.__mpApplySettingsGen) {
            root.__mpApplyingSettings = false;
          }
        }, 80);
      } else {
        root.__mpApplyingSettings = false;
      }
    } catch (e) {
      root.__mpApplyingSettings = false;
      throw e;
    }
    return ok || opened || settingsMatchLocal(settings);
  }

  function applySnakeColor(colorId) {
    if (colorId == null || colorId === 46) return false;
    root.__mpApplyingColor = true;
    let ok = false;
    try {
      ok = selectMenu("color", Number(colorId));
    } finally {
      setTimeout(function () {
        root.__mpApplyingColor = false;
      }, 0);
    }
    return ok;
  }

  function triggerPlay() {
    const btn = playButton();
    // Bypass the multiplayer Play lock (pointer-events + capture click stopper)
    root.__mpAllowPlayClick = true;
    try {
      if (btn && typeof btn.click === "function") {
        const prevPe = btn.style.pointerEvents;
        const prevOp = btn.style.opacity;
        btn.style.pointerEvents = "";
        btn.style.opacity = "";
        btn.click();
        btn.style.pointerEvents = prevPe;
        btn.style.opacity = prevOp;
        root.__mpLastPlayClickAt = Date.now();
        return true;
      }
      // Keyboard fallback used by some skins
      const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      document.dispatchEvent(ev);
      root.__mpLastPlayClickAt = Date.now();
    } catch (e) { /* ignore */ }
    finally {
      root.__mpAllowPlayClick = false;
    }
    return false;
  }

  /** Strip inline visibility we may have forced — let Google own the overlay. */
  function clearDeathOverlayOverrides() {
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay) return;
    delete overlay.dataset.mpDeathPrevVis;
    delete overlay.dataset.mpDeathPrevOp;
    overlay.style.visibility = "";
    overlay.style.opacity = "";
    const menu = overlay.children && overlay.children[0];
    if (menu) menu.style.visibility = "";
  }

  /**
   * After Start-match Play: dismiss end overlay without sticky restore state.
   * (showDeathScreen's inline visible:1 was trapping non-admins on the endscreen.)
   */
  function dismissDeathOverlayForRun() {
    clearDeathOverlayOverrides();
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay) return;
    overlay.style.visibility = "hidden";
    overlay.style.opacity = "0";
    const menu = overlay.children && overlay.children[0];
    if (menu) menu.style.visibility = "hidden";
  }

  function isDeathOverlayVisible() {
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay) return false;
    if (overlay.style.visibility === "hidden") return false;
    if (overlay.style.display === "none") return false;
    if (overlay.style.opacity === "0") return false;
    try {
      if (typeof root.getComputedStyle === "function") {
        const cs = root.getComputedStyle(overlay);
        if (cs) {
          if (cs.visibility === "hidden" || cs.display === "none") return false;
          if (parseFloat(cs.opacity) === 0) return false;
        }
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  /**
   * True only when a real in-progress run is on the canvas.
   * A leftover GameInstance after death still has oa — that alone is NOT live.
   * Focus may hide the death overlay before Play — require a real Play click then.
   */
  function isNativeRunLive() {
    const g = gameInstance();
    if (!g || !g.oa) return false;
    if (!Array.isArray(g.oa.ka) || !g.oa.ka.length) return false;
    if (g.nj || g.dead || g.isDead) return false;
    if (root.timeKeeper && root.timeKeeper._dead) return false;
    if (isDeathOverlayVisible()) {
      // Engine alive but our sticky inline styles left the endscreen up — dismiss
      if (root.__mpStartingMatch) {
        dismissDeathOverlayForRun();
        // Still require a real Play if the engine was quit/paused behind menus
        const g2 = gameInstance();
        if (g2 && (g2.nj || g2.dead || g2.isDead)) return false;
        if (root.timeKeeper && root.timeKeeper._dead) return false;
        return !isDeathOverlayVisible();
      }
      return false;
    }
    // Focus seats hide the overlay early; without this non-admin never clicks Play
    if (root.__mpFocusRequirePlay) {
      const at = root.__mpLastPlayClickAt;
      if (!at || Date.now() - at > 20000) return false;
    }
    return true;
  }

  /** Close menus; do NOT force-show death (inline styles trap the endscreen). */
  function prepareNativePlay() {
    closeSettingsPanel();
    clearDeathOverlayOverrides();
    setLocalPaused(false);
  }

  /**
   * Keep clicking Play until a live run starts (or attempts exhausted).
   * Used by Start match so non-admins leave the endscreen.
   * @param {{maxAttempts?:number,intervalMs?:number,onDone?:function(boolean),requirePlayClick?:boolean,deferTimer?:boolean}} opts
   */
  function startNativeRun(opts) {
    opts = opts || {};
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 50;
    const intervalMs = opts.intervalMs != null ? opts.intervalMs : 40;
    const onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    const requirePlayClick = opts.requirePlayClick === true;
    const deferTimer = opts.deferTimer === true;
    root.__mpStartingMatch = true;
    root.__mpApplySettingsGen = (root.__mpApplySettingsGen || 0) + 1;
    if (requirePlayClick) root.__mpFocusRequirePlay = true;
    prepareNativePlay();
    if (typeof installFirstRunControlTipGuard === "function") {
      installFirstRunControlTipGuard();
    } else {
      hideControlHelper();
    }
    let attempts = 0;
    let playClicks = 0;
    function tick() {
      attempts++;
      try {
        const needClick =
          !isNativeRunLive() || (requirePlayClick && playClicks < 1);
        if (needClick) {
          closeSettingsPanel();
          // Undo spectate/hideDeathScreen so the Play control is hittable
          clearDeathOverlayOverrides();
          if (triggerPlay()) playClicks++;
          // After several clicks, force-clear dead flag if Play didn't (some skins)
          if (attempts >= 8 && root.timeKeeper && root.timeKeeper._dead) {
            root.timeKeeper._dead = false;
            // Focus: do not start the run clock until the remote player moves
            if (!deferTimer && typeof root.timeKeeper.start === "function") {
              try {
                root.timeKeeper.start();
              } catch (e2) { /* ignore */ }
            }
          }
        }
        // Engine started but sticky inline CSS left the endscreen up
        if (root.timeKeeper && !root.timeKeeper._dead) {
          dismissDeathOverlayForRun();
        }
      } catch (e) { /* ignore */ }
      const live =
        isNativeRunLive() && (!requirePlayClick || playClicks >= 1);
      if (live || attempts >= maxAttempts) {
        const ok = live;
        if (ok) {
          dismissDeathOverlayForRun();
          if (requirePlayClick) root.__mpFocusRequirePlay = false;
          // Focus seats: keep clock stopped until remote actually moves
          if (deferTimer && root.timeKeeper) {
            try {
              root.timeKeeper.playing = false;
              root.timeKeeper._lastTimeMs = 0;
            } catch (e3) { /* ignore */ }
          }
        }
        if (typeof setTimeout === "function") {
          setTimeout(function () {
            root.__mpStartingMatch = false;
          }, 800);
        } else {
          root.__mpStartingMatch = false;
        }
        if (onDone) onDone(ok);
        return;
      }
      setTimeout(tick, intervalMs);
    }
    setTimeout(tick, intervalMs);
  }

  function gameInstance() {
    return root.__mpGame || root.__remixGame || null;
  }

  function firstNumber() {
    for (let i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === "number" && !Number.isNaN(arguments[i])) return arguments[i];
    }
    return 0;
  }

  function readScoreAndAlive() {
    const g = gameInstance();
    let score = 0;
    let alive = true;
    let timeMs = 0;
    if (g) {
      score = firstNumber(g.Sh, g.Oh, g.score, g.appleCount);
      if (g.nj || g.dead || g.isDead) alive = false;
    }
    if (root.timeKeeper) {
      if (typeof root.timeKeeper._lastScore === "number") score = root.timeKeeper._lastScore;
      if (typeof root.timeKeeper._lastTimeMs === "number") timeMs = root.timeKeeper._lastTimeMs;
      if (root.timeKeeper._dead) alive = false;
      if (typeof root.timeKeeper.lastAppleTime === "number") {
        timeMs = timeMs || root.timeKeeper.lastAppleTime;
      }
    }
    return { score: score, timeMs: timeMs, alive: alive };
  }

  function mapBody(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (p) {
      if (!p) return { x: 0, y: 0 };
      return { x: p.x != null ? p.x : 0, y: p.y != null ? p.y : 0 };
    });
  }

  /**
   * Native PlayerRenderer / fruit renderers call .clone() on body points and
   * apple.pos (Closure _.Od). Plain {x,y} from BOARD_DELTA / spectate inject
   * throws `b.pos.clone is not a function` — always keep a clone fn.
   */
  function makeNativePoint(x, y, template) {
    let nx = x != null ? Number(x) : 0;
    let ny = y != null ? Number(y) : 0;
    if (!Number.isFinite(nx)) nx = 0;
    if (!Number.isFinite(ny)) ny = 0;
    if (template && typeof template.clone === "function") {
      try {
        const c = template.clone();
        c.x = nx;
        c.y = ny;
        if (typeof c.clone !== "function") {
          c.clone = function () {
            return makeNativePoint(this.x, this.y, template);
          };
        }
        return c;
      } catch (e) { /* fall through */ }
    }
    const seg = { x: nx, y: ny };
    seg.clone = function () {
      return makeNativePoint(this.x, this.y, null);
    };
    return seg;
  }

  /** Ensure a coordinate object used as apple/entity `.pos` has .clone(). */
  function ensureNativePos(pos, x, y, template) {
    const nx = x != null ? Number(x) : 0;
    const ny = y != null ? Number(y) : 0;
    if (pos && typeof pos.clone === "function") {
      pos.x = nx;
      pos.y = ny;
      return pos;
    }
    return makeNativePoint(nx, ny, template || pos || null);
  }

  /** Write board.body into game.oa.ka without stripping native point methods. */
  function writeNativeBody(snake, body) {
    if (!snake || !Array.isArray(body)) return false;
    if (!Array.isArray(snake.ka)) snake.ka = [];
    const nextLen = body.length;
    let template = null;
    for (let t = 0; t < snake.ka.length; t++) {
      if (snake.ka[t] && typeof snake.ka[t].clone === "function") {
        template = snake.ka[t];
        break;
      }
    }
    while (snake.ka.length > nextLen) snake.ka.pop();
    for (let i = 0; i < nextLen; i++) {
      const p = body[i] || { x: 0, y: 0 };
      const cur = snake.ka[i];
      const x = Math.round(Number(p.x != null ? p.x : 0));
      const y = Math.round(Number(p.y != null ? p.y : 0));
      if (cur && typeof cur.clone === "function") {
        cur.x = Number.isFinite(x) ? x : 0;
        cur.y = Number.isFinite(y) ? y : 0;
      } else {
        snake.ka[i] = makeNativePoint(
          Number.isFinite(x) ? x : 0,
          Number.isFinite(y) ? y : 0,
          template || cur
        );
        if (!template) template = snake.ka[i];
      }
    }
    return true;
  }

  /** Correct only the head cell — native body-follow owns the rest. */
  function writeNativeHead(snake, head, dir) {
    if (!snake || !head) return false;
    if (!Array.isArray(snake.ka) || !snake.ka.length) return false;
    const hx = Math.round(Number(head.x));
    const hy = Math.round(Number(head.y));
    if (!Number.isFinite(hx) || !Number.isFinite(hy)) return false;
    const cur = snake.ka[0];
    if (cur && typeof cur.clone === "function") {
      cur.x = hx;
      cur.y = hy;
    } else {
      snake.ka[0] = makeNativePoint(hx, hy, cur);
    }
    if (dir) {
      snake.direction = dir;
      if (snake.dir != null) snake.dir = dir;
    }
    return true;
  }

  /**
   * Classic follow: new head, previous segments shift forward.
   * Used for Focus head-sync and co-op companion visuals.
   */
  function followBodyFromHead(prevBody, nextBody) {
    if (!nextBody || !nextBody.length) return prevBody || [];
    const head = nextBody[0];
    const hx = Math.round(Number(head.x));
    const hy = Math.round(Number(head.y));
    if (!Number.isFinite(hx) || !Number.isFinite(hy)) {
      return nextBody.map(function (p) {
        return {
          x: Math.round(Number(p.x)) || 0,
          y: Math.round(Number(p.y)) || 0,
        };
      });
    }
    const wantLen = nextBody.length;
    if (!prevBody || !prevBody.length || prevBody.length !== wantLen) {
      return nextBody.map(function (p) {
        return {
          x: Math.round(Number(p.x)) || 0,
          y: Math.round(Number(p.y)) || 0,
        };
      });
    }
    const ph = prevBody[0];
    const px = Math.round(Number(ph.x));
    const py = Math.round(Number(ph.y));
    const jump = Math.abs(hx - px) + Math.abs(hy - py);
    if (jump === 0) {
      // Unchanged head — reuse prior visual body (no per-tick alloc)
      return prevBody;
    }
    if (jump > 1) {
      // Teleport / corner cut — seat full remote body
      return nextBody.map(function (p) {
        return {
          x: Math.round(Number(p.x)) || 0,
          y: Math.round(Number(p.y)) || 0,
        };
      });
    }
    const out = [{ x: hx, y: hy }];
    for (let i = 0; i < wantLen - 1; i++) {
      const s = prevBody[i];
      out.push({
        x: Math.round(Number(s.x)) || 0,
        y: Math.round(Number(s.y)) || 0,
      });
    }
    return out;
  }

  function mapApples(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (a) {
      const pos = (a && a.pos) || a || {};
      let type = null;
      let poison = false;
      if (a) {
        if (a.type != null) type = a.type;
        else if (a.kind != null) type = a.kind;
        else if (a.Xa != null) type = a.Xa;
        else if (a.oa != null && typeof a.oa !== "object") type = a.oa;
        if (a.Oka || a.nla || a.poison) poison = true;
      }
      return {
        x: pos.x != null ? pos.x : 0,
        y: pos.y != null ? pos.y : 0,
        type: type,
        poison: poison || undefined,
      };
    });
  }

  /** Collect grid points from array or {x,y} map-like structures. */
  function mapPointList(src) {
    const out = [];
    if (!src) return out;
    if (Array.isArray(src)) {
      src.forEach(function (p) {
        if (!p) return;
        const pos = p.pos || p;
        if (pos.x == null || pos.y == null) return;
        out.push({ x: pos.x, y: pos.y });
      });
      return out;
    }
    if (typeof src !== "object") return out;
    Object.keys(src).forEach(function (k) {
      const p = src[k];
      if (!p) return;
      if (p.x != null && p.y != null) {
        out.push({ x: p.x, y: p.y });
        return;
      }
      // 2D grid: src[y][x] truthy
      if (Array.isArray(p)) {
        for (let x = 0; x < p.length; x++) {
          if (p[x]) out.push({ x: x, y: Number(k) || 0 });
        }
      }
    });
    return out;
  }

  /**
   * Extra board entities beyond fruit (walls, keys, mines, …) for co-op sync.
   * Best-effort against obfuscated engine fields — missing hosts are skipped.
   */
  function scrapeBoardEntities(g) {
    g = g || gameInstance();
    const entities = {
      walls: [],
      keys: [],
      boxes: [],
      goals: [],
      mines: [],
      statues: [],
      bridges: [],
      gates: [],
    };
    if (!g) return entities;
    try {
      const wallHost = g.Ca;
      if (wallHost) {
        entities.walls = mapPointList(wallHost.Aa || wallHost.wa || wallHost.oa);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Ba && g.Ba.keys) entities.keys = mapPointList(g.Ba.keys);
    } catch (e) { /* ignore */ }
    try {
      if (g.Aa) {
        entities.boxes = mapPointList(g.Aa.oa);
        entities.goals = mapPointList(g.Aa.d_ || g.Aa.da);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Ma) entities.mines = mapPointList(g.Ma.oa || g.Ma.ka);
    } catch (e) { /* ignore */ }
    try {
      if (g.Ya) entities.statues = mapPointList(g.Ya.oa || g.Ya.ka);
    } catch (e) { /* ignore */ }
    try {
      if (g.Ga) entities.bridges = mapPointList(g.Ga.oa);
    } catch (e) { /* ignore */ }
    try {
      if (g.Qa) entities.gates = mapPointList(g.Qa.pfa || g.Qa.Yfa || g.Qa.oa);
    } catch (e) { /* ignore */ }
    return entities;
  }

  /** Apply entity point lists onto known hosts when present (non-destructive). */
  function applyBoardEntities(entities) {
    if (!entities) return false;
    const g = gameInstance();
    if (!g) return false;
    let applied = false;
    function writeList(hostArr, list) {
      if (!Array.isArray(hostArr) || !Array.isArray(list)) return;
      let templatePos = null;
      for (let t = 0; t < hostArr.length; t++) {
        const p = hostArr[t] && hostArr[t].pos;
        if (p && typeof p.clone === "function") {
          templatePos = p;
          break;
        }
      }
      while (hostArr.length > list.length) hostArr.pop();
      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        let dst = hostArr[i];
        if (!dst) {
          dst = { pos: makeNativePoint(src.x, src.y, templatePos) };
          hostArr[i] = dst;
        } else if (dst.pos || templatePos) {
          dst.pos = ensureNativePos(dst.pos, src.x, src.y, templatePos);
          if (!templatePos && dst.pos) templatePos = dst.pos;
        } else if (typeof dst.clone === "function") {
          dst.x = src.x;
          dst.y = src.y;
        } else {
          dst.x = src.x;
          dst.y = src.y;
          if (typeof dst.clone !== "function") {
            hostArr[i] = makeNativePoint(src.x, src.y, null);
          }
        }
      }
      applied = true;
    }
    try {
      if (g.Ba && Array.isArray(g.Ba.keys) && entities.keys) {
        writeList(g.Ba.keys, entities.keys);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Aa && Array.isArray(g.Aa.oa) && entities.boxes) {
        writeList(g.Aa.oa, entities.boxes);
      }
      if (g.Aa && Array.isArray(g.Aa.d_) && entities.goals) {
        writeList(g.Aa.d_, entities.goals);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Ma && Array.isArray(g.Ma.oa) && entities.mines) {
        writeList(g.Ma.oa, entities.mines);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Ya && Array.isArray(g.Ya.oa) && entities.statues) {
        writeList(g.Ya.oa, entities.statues);
      }
    } catch (e) { /* ignore */ }
    return applied;
  }

  function scrapeBoard(opts) {
    opts = opts || {};
    const g = gameInstance();
    // Chess/Remix globals as fallbacks when tick caches them
    const bodySrc =
      (g && g.oa && g.oa.ka) ||
      root.head_pos ||
      (root.__mpBoardCache && root.__mpBoardCache.body);
    const appleSrc =
      (g && g.wa && g.wa.ka) ||
      root.appleArray ||
      (root.__mpBoardCache && root.__mpBoardCache.apples);
    if (!bodySrc && !g) return null;

    const snake = (g && g.oa) || {};
    const fruit = (g && g.wa) || {};
    const body = mapBody(bodySrc);
    const apples = mapApples(appleSrc);
    const boardMeta =
      (fruit && fruit.oa && fruit.oa.oa) ||
      (snake && snake.oa) ||
      (g && g.settings && g.settings.grid) ||
      {};
    const scoreInfo = readScoreAndAlive();
    const width = firstNumber(boardMeta.width, boardMeta.W, 17) || 17;
    const height = firstNumber(boardMeta.height, boardMeta.H, 15) || 15;

    let themeIndex = readSettingIndex("theme");
    if (themeIndex == null && root.pudding_settings && root.pudding_settings.theme != null) {
      themeIndex = Number(root.pudding_settings.theme);
    }
    const themeColors = getBoardThemeColors();

    let colorId = opts.colorId;
    if (colorId == null) {
      colorId = readSettingIndex("color");
    }

    // Live engine colors (what the player actually looks like right now)
    let Sc = null;
    let Yc = null;
    try {
      if (typeof snake.Sc === "string" && snake.Sc) Sc = snake.Sc;
      if (typeof snake.Yc === "string" && snake.Yc) Yc = snake.Yc;
    } catch (e) { /* ignore */ }
    try {
      const cfg = g && (g.snakeBodyConfig || snake);
      if (cfg) {
        if (!Sc && (cfg.color2 || cfg.primary)) Sc = cfg.color2 || cfg.primary;
        if (!Yc && (cfg.color1 || cfg.secondary)) Yc = cfg.color1 || cfg.secondary;
      }
    } catch (e2) { /* ignore */ }

    const Colors = root.MultiplayerColors;
    let colorSet = null;
    if (Colors && Colors.getColor && colorId != null) {
      const c = Colors.getColor(Number(colorId));
      if (c) {
        if (c.set && c.set.length) colorSet = c.set.slice();
        // Engine may not expose Sc/Yc yet — resolve from the player's color id
        if (c.kind === "rainbow" && c.set && c.set.length) {
          if (!Sc) Sc = c.set[0];
          if (!Yc) Yc = c.set[c.set.length - 1] || c.set[0];
        } else if (c.primary) {
          if (!Sc) Sc = c.primary;
          if (!Yc) Yc = c.secondary || c.primary;
        }
      }
    }

    const board = {
      body: body,
      dir: snake.direction || snake.dir || root.head_dir || "RIGHT",
      length: snake.Ta || body.length,
      apples: apples,
      width: width,
      height: height,
      score: scoreInfo.score,
      alive: scoreInfo.alive !== false,
      themeIndex: themeIndex,
      themeColors: themeColors,
      colorId: colorId != null ? Number(colorId) : null,
      Sc: Sc,
      Yc: Yc,
      colorSet: colorSet,
      // Cosmetics + match rules so Focus spectators can mirror the run natively
      appleIndex: readSettingIndex("apple"),
      graphicsIndex: readSettingIndex("graphics"),
      sizeIndex: readSettingIndex("size"),
      countIndex: readSettingIndex("count"),
      speedIndex: readSettingIndex("speed"),
      trophyIndex: readSettingIndex("trophy"),
    };
    root.__mpBoardCache = board;
    return board;
  }

  function resolveThemeColors(board, themeOverride) {
    if (themeOverride && themeOverride.light) return themeOverride;
    if (board && board.themeColors && board.themeColors.light) return board.themeColors;
    return getBoardThemeColors();
  }

  function hexToRgb(hex) {
    const s = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (x) {
          return Math.max(0, Math.min(255, x | 0))
            .toString(16)
            .padStart(2, "0");
        })
        .join("")
    );
  }

  /**
   * WallSolver-style snake: tapered tip→head stroke + googly eyes (canvas).
   * Body list is head-first (native / BOARD_DELTA); reversed to tip→head for draw.
   */
  function drawWallSolverStyleSnake(ctx, body, ox, oy, cell, colorInfo, dir) {
    if (!ctx || !body || !body.length) return;
    const pts = [];
    for (let i = body.length - 1; i >= 0; i--) {
      const p = body[i];
      if (!p) continue;
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts.push([ox + (x + 0.5) * cell, oy + (y + 0.5) * cell]);
    }
    const n = pts.length;
    if (!n) return;
    const headI = n - 1;
    const neckI = n > 1 ? n - 2 : 0;
    let ux = 1;
    let uy = 0;
    if (n > 1) {
      const dx = pts[headI][0] - pts[neckI][0];
      const dy = pts[headI][1] - pts[neckI][1];
      const len = Math.hypot(dx, dy) || 1;
      ux = dx / len;
      uy = dy / len;
    } else if (dir) {
      const d = String(dir).toUpperCase();
      if (d === "UP") {
        ux = 0;
        uy = -1;
      } else if (d === "DOWN") {
        ux = 0;
        uy = 1;
      } else if (d === "LEFT") {
        ux = -1;
        uy = 0;
      } else {
        ux = 1;
        uy = 0;
      }
    }
    let tipPull = 0;
    let headPull = 0;
    if (n > 1) {
      const gapPx = Math.hypot(
        pts[0][0] - pts[headI][0],
        pts[0][1] - pts[headI][1]
      );
      if (gapPx < cell * 1.25) {
        tipPull = cell * 0.45;
        headPull = cell * 0.2;
      }
    }
    let tipX = pts[0][0];
    let tipY = pts[0][1];
    if (n > 1 && tipPull) {
      const dx = pts[1][0] - pts[0][0];
      const dy = pts[1][1] - pts[0][1];
      const len = Math.hypot(dx, dy) || 1;
      tipX += (dx / len) * tipPull;
      tipY += (dy / len) * tipPull;
    }
    const headX = pts[headI][0] - ux * headPull;
    const headY = pts[headI][1] - uy * headPull;
    const angle = Math.atan2(uy, ux);
    const headW = cell * 0.7;
    const tipW = cell * 0.32;

    let headCol = [0x5b, 0x8d, 0xef];
    let tipCol = [0x2a, 0x4a, 0xb8];
    let rainbowSet = null;
    if (colorInfo) {
      if (colorInfo.set && colorInfo.set.length) {
        rainbowSet = colorInfo.set;
      }
      const headHex =
        colorInfo.primary ||
        colorInfo.Sc ||
        (rainbowSet && rainbowSet[0]) ||
        null;
      const tipHex =
        colorInfo.secondary ||
        colorInfo.Yc ||
        (rainbowSet && rainbowSet[rainbowSet.length - 1]) ||
        colorInfo.primary ||
        colorInfo.Sc ||
        null;
      const hRgb = hexToRgb(headHex);
      const tRgb = hexToRgb(tipHex);
      if (hRgb) headCol = hRgb;
      if (tRgb) tipCol = tRgb;
    }
    function mix(t) {
      // t=0 at head, t=1 at tip — rainbow samples the player's set along the body
      if (rainbowSet && rainbowSet.length > 1) {
        const f = Math.max(0, Math.min(1, t)) * (rainbowSet.length - 1);
        const i0 = Math.floor(f);
        const i1 = Math.min(rainbowSet.length - 1, i0 + 1);
        const u = f - i0;
        const c0 = hexToRgb(rainbowSet[i0]) || headCol;
        const c1 = hexToRgb(rainbowSet[i1]) || tipCol;
        return rgbToHex(
          c0.map(function (v, i) {
            return Math.round(v + (c1[i] - v) * u);
          })
        );
      }
      const c = headCol.map(function (v, i) {
        return Math.round(v + (tipCol[i] - v) * t);
      });
      return rgbToHex(c);
    }
    function tAt(i) {
      return n <= 1 ? 0 : (headI - i) / headI;
    }
    function widthAt(t) {
      return headW * (1 - t) + tipW * t;
    }

    const poly = [];
    poly.push([tipX, tipY, 1]);
    for (let i = 1; i < headI; i++) {
      poly.push([pts[i][0], pts[i][1], tAt(i)]);
    }
    poly.push([headX, headY, 0]);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = Math.max(1, cell * 0.045);
    ctx.shadowOffsetY = Math.max(1, cell * 0.05);
    for (let i = 0; i < poly.length - 1; i++) {
      const x0 = poly[i][0];
      const y0 = poly[i][1];
      const t0 = poly[i][2];
      const x1 = poly[i + 1][0];
      const y1 = poly[i + 1][1];
      const t1 = poly[i + 1][2];
      const steps = 4;
      for (let s = 0; s < steps; s++) {
        const u0 = s / steps;
        const u1 = (s + 1) / steps;
        const xa = x0 + (x1 - x0) * u0;
        const ya = y0 + (y1 - y0) * u0;
        const xb = x0 + (x1 - x0) * u1;
        const yb = y0 + (y1 - y0) * u1;
        const t = t0 * (1 - (u0 + u1) / 2) + t1 * ((u0 + u1) / 2);
        ctx.strokeStyle = mix(t);
        ctx.lineWidth = widthAt(t);
        ctx.beginPath();
        ctx.moveTo(xa, ya);
        ctx.lineTo(xb, yb);
        ctx.stroke();
      }
    }

    const col = mix(0);
    const neckR = headW / 2;
    const bulgeR = neckR * 0.82;
    const bulgeX = neckR * 0.12;
    const bulgeY = neckR * 0.92;
    const snoutR = neckR * 1.02;
    const snoutX = neckR * 0.78;
    const eyeR = Math.max(2.6, bulgeR * 0.72);
    const eyeX = bulgeX + bulgeR * 0.02;
    const eyeY = bulgeY;
    const pupilR = Math.max(1.3, eyeR * 0.4);
    const pupilFwd = eyeR * 0.38;
    const pupilIn = eyeR * 0.1;
    const nostrilR = Math.max(0.7, neckR * 0.08);
    const nostrilX = snoutX + snoutR * 0.58;
    const nostrilY = neckR * 0.14;
    const pupilCol = tipCol
      ? rgbToHex(
          tipCol.map(function (v) {
            return Math.round(v * 0.55);
          })
        )
      : "#1a3a8a";
    const nostrilCol = tipCol ? rgbToHex(tipCol) : "#2a4a9a";

    ctx.fillStyle = col;
    ctx.translate(headX, headY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.arc(0, 0, neckR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bulgeX, -bulgeY, bulgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bulgeX, bulgeY, bulgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(snoutX, 0, snoutR, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(eyeX, -eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pupilCol;
    ctx.beginPath();
    ctx.arc(eyeX + pupilFwd, -eyeY + pupilIn, pupilR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(eyeX + pupilFwd, eyeY - pupilIn, pupilR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = nostrilCol;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(nostrilX, -nostrilY, nostrilR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(nostrilX, nostrilY, nostrilR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Cache of fruit sprite Images keyed by URL. */
  const _appleImgCache = Object.create(null);
  let _mosaicFruitRepaintTimer = 0;

  function scheduleMosaicFruitRepaint() {
    if (_mosaicFruitRepaintTimer) return;
    _mosaicFruitRepaintTimer = setTimeout(function () {
      _mosaicFruitRepaintTimer = 0;
      if (typeof root.__mpMosaicRepaint === "function") {
        try {
          root.__mpMosaicRepaint();
        } catch (e) { /* ignore */ }
      }
    }, 40);
  }

  /**
   * Resolve fruit sprite URL from apple.type (or board appleIndex fallback).
   * Prefers live #apple / apple_img_arr (includes Remix custom fruit).
   */
  function resolveAppleImageUrl(type, appleIndex) {
    let idx = type;
    if (idx == null || idx === "" || Number(idx) < 0 || Number.isNaN(Number(idx))) {
      idx = appleIndex;
    }
    idx = Number(idx);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    idx = idx | 0;

    try {
      if (root.apple_img_arr && root.apple_img_arr[idx]) {
        return String(root.apple_img_arr[idx]);
      }
    } catch (e) { /* ignore */ }
    try {
      const el =
        typeof document !== "undefined" ? document.getElementById("apple") : null;
      if (el && el.children && el.children[idx] && el.children[idx].src) {
        return String(el.children[idx].src);
      }
    } catch (e2) { /* ignore */ }

    // Stock Google Snake fruit CDN (custom pudding fruit only via menu above)
    const pad = idx < 10 ? "0" + idx : String(Math.min(idx, 99));
    return (
      "https://www.google.com/logos/fnbx/snake_arcade/v3/apple_" + pad + ".png"
    );
  }

  function getAppleImage(url) {
    if (!url) return null;
    let img = _appleImgCache[url];
    if (img) return img;
    const ImgCtor =
      typeof root.Image === "function"
        ? root.Image
        : typeof Image === "function"
          ? Image
          : null;
    if (!ImgCtor) return null;
    img = new ImgCtor();
    img.decoding = "async";
    img.onload = function () {
      scheduleMosaicFruitRepaint();
    };
    img.onerror = function () {
      /* keep fallback circle */
    };
    try {
      img.src = url;
    } catch (e) {
      return null;
    }
    _appleImgCache[url] = img;
    return img;
  }

  function drawBoardApples(ctx, board, ox, oy, cell, theme) {
    const apples = board && board.apples;
    if (!apples || !apples.length) return;
    const appleIndex = board.appleIndex;
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a || a.x == null || a.y == null) continue;
      // Skip parked off-grid Focus placeholders
      if (Number(a.x) < 0 || Number(a.y) < 0) continue;
      const cx = ox + Number(a.x) * cell + cell / 2;
      const cy = oy + Number(a.y) * cell + cell / 2;
      const size = cell * 0.88;
      const url = resolveAppleImageUrl(a.type, appleIndex);
      const img = getAppleImage(url);
      let drew = false;
      if (
        img &&
        img.complete &&
        img.naturalWidth > 0 &&
        typeof ctx.drawImage === "function"
      ) {
        try {
          ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
          drew = true;
        } catch (e) { /* cross-origin / incomplete */ }
      }
      if (!drew) {
        ctx.fillStyle = a.poison
          ? "#8e24aa"
          : theme.apple || "#e7471d";
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
      if (a.poison) {
        ctx.fillStyle = "rgba(142,36,170,0.35)";
        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawBoardOnCanvas(canvas, board, colorInfo, themeOverride) {
    if (!canvas || !board) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const theme = resolveThemeColors(board, themeOverride);
    const w = board.width || 17;
    const h = board.height || 15;
    const cw = canvas.width;
    const ch = canvas.height;
    const cell = Math.min(cw / w, ch / h);
    const ox = (cw - cell * w) / 2;
    const oy = (ch - cell * h) / 2;
    ctx.fillStyle = theme.border || "#578a34";
    ctx.fillRect(0, 0, cw, ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? theme.light : theme.dark;
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    }
    drawBoardApples(ctx, board, ox, oy, cell, theme);
    drawWallSolverStyleSnake(
      ctx,
      board.body || [],
      ox,
      oy,
      cell,
      colorInfo,
      board.dir
    );
  }

  /**
   * Versus Focus: local GameInstance still simulates between injects and can
   * call die() even when the remote player is alive. Swallow those false deaths.
   */
  function installFocusDieGuard(g) {
    if (!g || g.__mpFocusDieGuarded) return;
    g.__mpFocusDieGuarded = true;
    const origDie = typeof g.die === "function" ? g.die : null;
    g.die = function () {
      if (root.__mpVersusFocusSpectate) {
        const b = root.__mpVersusFocusBoard;
        // Only honor die when the focused board says the remote is dead
        if (!b || b.alive !== false) {
          try {
            this.nj = false;
            if (this.dead) this.dead = false;
            if (root.timeKeeper) root.timeKeeper._dead = false;
            if (!root.__mpSpectateAllowMenus) hideDeathScreen();
          } catch (e) { /* ignore */ }
          return;
        }
      }
      if (origDie) return origDie.apply(this, arguments);
    };
  }

  /** Grow local ka when remote is longer — never rewrite existing tail segments. */
  function extendNativeBodyLength(snake, cleanBody) {
    if (!snake || !Array.isArray(cleanBody) || !cleanBody.length) return false;
    if (!Array.isArray(snake.ka)) snake.ka = [];
    const have = snake.ka.length;
    const want = cleanBody.length;
    if (have >= want) return false;
    let template = null;
    for (let t = 0; t < snake.ka.length; t++) {
      if (snake.ka[t] && typeof snake.ka[t].clone === "function") {
        template = snake.ka[t];
        break;
      }
    }
    for (let i = have; i < want; i++) {
      const p = cleanBody[i] || cleanBody[want - 1];
      snake.ka.push(
        makeNativePoint(
          Math.round(Number(p.x)) || 0,
          Math.round(Number(p.y)) || 0,
          template
        )
      );
      if (!template) template = snake.ka[i];
    }
    return true;
  }

  /** True when remote head jumped >1 cell (respawn / teleport) — needs full seat. */
  function focusHeadTeleported(localKa, remoteHead) {
    if (!remoteHead) return false;
    if (!localKa || !localKa[0]) return true;
    const lx = Math.round(Number(localKa[0].x));
    const ly = Math.round(Number(localKa[0].y));
    const rx = Math.round(Number(remoteHead.x));
    const ry = Math.round(Number(remoteHead.y));
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) return true;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return false;
    return Math.abs(rx - lx) + Math.abs(ry - ly) > 1;
  }

  /** Pose key for remote board body + dir (drives Focus head-sync). */
  function focusPoseFingerprint(board) {
    if (!board) return "";
    const body = board.body || [];
    let s = (board.alive === false ? "0" : "1") + "|" + (board.dir || "") + "|" + body.length;
    for (let i = 0; i < body.length; i++) {
      const p = body[i];
      s += "|" + (p && p.x) + "," + (p && p.y);
    }
    return s;
  }

  /**
   * After each native tick, keep the Focus puppet on the remote pose.
   * Head-only re-pin left neck/tail stranded (fragmented body). Snap the
   * full remote body when local physics drifts or the trail disconnects;
   * leave a matching connected trail alone so PlayerRenderer can crawl.
   */
  function installFocusTickGuard(g) {
    if (!g || g.__mpFocusTickGuarded) return;
    if (typeof g.tick !== "function") return;
    g.__mpFocusTickGuarded = true;
    const origTick = g.tick;
    g.tick = function () {
      const ret = origTick.apply(this, arguments);
      if (root.__mpVersusFocusSpectate) {
        try {
          reapplyFocusBody(this);
        } catch (e) { /* ignore */ }
      }
      return ret;
    };
  }

  /** True when consecutive segments are adjacent (manhattan ≤ 1). */
  function bodyTrailConnected(body) {
    if (!body || body.length < 2) return true;
    for (let i = 1; i < body.length; i++) {
      const a = body[i - 1];
      const b = body[i];
      if (!a || !b) return false;
      const d =
        Math.abs(Math.round(Number(a.x)) - Math.round(Number(b.x))) +
        Math.abs(Math.round(Number(a.y)) - Math.round(Number(b.y)));
      if (d > 1) return false;
    }
    return true;
  }

  function reapplyFocusBody(g) {
    g = g || gameInstance();
    if (!g || !g.oa) return false;
    const remote = root.__mpFocusRemoteBody;
    if (!remote || !remote.length) {
      const head = root.__mpFocusRemoteHead;
      if (!head) return false;
      return writeNativeHead(g.oa, head, root.__mpFocusRemoteDir);
    }
    const local = g.oa.ka;
    const lh = local && local[0];
    const rh = remote[0];
    const headMatch =
      lh &&
      rh &&
      Math.round(Number(lh.x)) === Math.round(Number(rh.x)) &&
      Math.round(Number(lh.y)) === Math.round(Number(rh.y));
    if (
      headMatch &&
      local.length === remote.length &&
      bodyTrailConnected(local)
    ) {
      if (root.__mpFocusRemoteDir) {
        g.oa.direction = root.__mpFocusRemoteDir;
        if (g.oa.dir != null) g.oa.dir = root.__mpFocusRemoteDir;
      }
      return true;
    }
    const ok = writeNativeBody(g.oa, remote);
    if (root.__mpFocusRemoteDir) {
      g.oa.direction = root.__mpFocusRemoteDir;
      if (g.oa.dir != null) g.oa.dir = root.__mpFocusRemoteDir;
    }
    return ok;
  }

  /** @deprecated use reapplyFocusBody — kept for callers/tests */
  function reapplyFocusHead(g) {
    return reapplyFocusBody(g);
  }

  /**
   * Versus Focus: inject focused player's state into the live GameInstance so
   * native snake/fruit renderers draw the spectated run. Paint is opt-in only
   * (opts.paint === true) — product Focus must stay native for admin and
   * non-admin alike (never canvas-square fallback).
   * After the initial seat, each remote pose change writes the full body list
   * so the trail stays connected (head-only inject fragmented the body).
   * Returns { ok, injected, painted, menusSynced }.
   */
  function applySpectateState(canvas, board, colorInfo, opts) {
    opts = opts || {};
    if (!board) return { ok: false, injected: false, painted: false, menusSynced: false };

    function syncMenu(key, idx) {
      if (idx == null || typeof idx !== "number" || Number.isNaN(Number(idx))) return false;
      const cur = readSettingIndex(key);
      if (cur == null || Number(cur) !== Number(idx)) {
        selectMenu(key, Number(idx));
        return true;
      }
      return false;
    }

    const menuFp = [
      board.sizeIndex,
      board.countIndex,
      board.speedIndex,
      board.trophyIndex,
      board.themeIndex,
      board.appleIndex,
      board.graphicsIndex,
      board.colorId != null
        ? board.colorId
        : colorInfo && colorInfo.id != null
          ? colorInfo.id
          : "",
    ].join("|");
    let menusSynced = false;
    const forceMenus = opts.forceMenus === true;
    if (forceMenus || menuFp !== root.__mpSpectateMenuFp) {
      root.__mpApplyingSettings = true;
      try {
        syncMenu("size", board.sizeIndex);
        syncMenu("count", board.countIndex);
        syncMenu("speed", board.speedIndex);
        syncMenu("trophy", board.trophyIndex);
        if (board.themeIndex != null) syncMenu("theme", board.themeIndex);
        if (board.appleIndex != null) syncMenu("apple", board.appleIndex);
        if (board.graphicsIndex != null) syncMenu("graphics", board.graphicsIndex);

        const colorId =
          board.colorId != null
            ? board.colorId
            : colorInfo && colorInfo.id != null
              ? colorInfo.id
              : null;
        if (colorId != null && applySnakeColor) {
          const curColor = readSettingIndex("color");
          if (curColor == null || Number(curColor) !== Number(colorId)) {
            applySnakeColor(Number(colorId));
          }
        }
        root.__mpSpectateMenuFp = menuFp;
        menusSynced = true;
      } finally {
        root.__mpApplyingSettings = false;
      }
    }

    let injected = false;
    try {
      const g = gameInstance();
      const cleanBody = [];
      if (Array.isArray(board.body)) {
        for (let bi = 0; bi < board.body.length; bi++) {
          const p = board.body[bi];
          if (!p) continue;
          const x = Math.round(Number(p.x));
          const y = Math.round(Number(p.y));
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          cleanBody.push({ x: x, y: y });
        }
      }

      if (g && g.oa && cleanBody.length) {
        if (root.__mpVersusFocusSpectate) {
          const poseFp = focusPoseFingerprint(board);
          const localLen = Array.isArray(g.oa.ka) ? g.oa.ka.length : 0;
          const forceFull = root.__mpFocusForceFullBody === true;
          const teleported =
            root.__mpFocusSeated &&
            focusHeadTeleported(g.oa.ka, cleanBody[0]);
          // Full body on first seat / revive / teleport
          const needFull =
            forceFull ||
            !root.__mpFocusSeated ||
            !localLen ||
            teleported ||
            opts.forceFullBody === true;
          const poseChanged = poseFp !== root.__mpFocusPoseFp;
          if (needFull) {
            injected = writeNativeBody(g.oa, cleanBody);
            // Only mark a live seat when remote is alive — death inject must not
            // consume ForceFullBody / flip Seated (breaks second-run reseat).
            if (board.alive !== false) {
              root.__mpFocusSeated = true;
              root.__mpFocusForceFullBody = false;
              root.__mpFocusSeatPoseFp = poseFp;
              root.__mpFocusRemoteStarted = false;
            }
          } else if (poseChanged) {
            // Write the full remote body list together. Head-only left gaps;
            // follow-from-corrupt-local could keep bad segments. BOARD_DELTA
            // already sends the complete trail — seat it and let PlayerRenderer
            // crawl between cells. Skip writes when pose is unchanged (no flicker).
            injected = writeNativeBody(g.oa, cleanBody);
            if (
              !root.__mpFocusRemoteStarted &&
              root.__mpFocusSeatPoseFp &&
              poseFp !== root.__mpFocusSeatPoseFp
            ) {
              root.__mpFocusRemoteStarted = true;
            }
          } else {
            // Same remote pose — leave ka so native crawl/lerp can run
            injected = true;
          }
          root.__mpFocusPoseFp = poseFp;
          root.__mpFocusRemoteHead = cleanBody[0];
          root.__mpFocusRemoteBody = cleanBody;
          root.__mpFocusRemoteDir = board.dir || null;
          if (board.dir) {
            g.oa.direction = board.dir;
            if (g.oa.dir != null) g.oa.dir = board.dir;
          }
        } else {
          injected = writeNativeBody(g.oa, cleanBody);
          if (board.dir) {
            g.oa.direction = board.dir;
            if (g.oa.dir != null) g.oa.dir = board.dir;
          }
        }
      }
      if (g && g.wa && Array.isArray(board.apples)) {
        if (
          root.__mpVersusFocusSpectate &&
          board.alive !== false &&
          board.apples.length === 0
        ) {
          // Empty fruit + alive remote → native ALL/nj death loop.
          // Park one off-grid apple (clears on-board fruit so local can't eat).
          applyCollectables({ apples: [{ x: -9, y: -9 }] });
        } else {
          applyCollectables({ apples: board.apples });
        }
      }
      if (g && root.__mpVersusFocusSpectate) {
        try {
          installFocusDieGuard(g);
          installFocusTickGuard(g);
          const remoteAlive = board.alive !== false;
          if (remoteAlive) {
            g.nj = false;
            if (g.dead) g.dead = false;
            if (g.isDead) g.isDead = false;
            if (root.timeKeeper) {
              root.timeKeeper._dead = false;
              if (root.__mpFocusRemoteStarted) {
                if (root.timeKeeper.playing === false) {
                  root.timeKeeper.playing = true;
                  if (typeof root.timeKeeper.start === "function") {
                    try {
                      root.timeKeeper.start();
                    } catch (eStart) { /* ignore */ }
                  }
                }
              } else {
                root.timeKeeper.playing = false;
                root.timeKeeper._lastTimeMs = 0;
              }
            }
            if (typeof root.pauseGame !== "undefined") root.pauseGame = false;
            if (
              !root.__mpFocusRequirePlay &&
              !root.__mpStartingMatch &&
              !root.__mpSpectateAllowMenus
            ) {
              hideDeathScreen();
            }
          } else {
            // Remote actually died — keep dead; do not hide death chrome
            g.nj = true;
            if (g.dead != null) g.dead = true;
            if (root.timeKeeper) {
              root.timeKeeper._dead = true;
              root.timeKeeper.playing = false;
            }
          }
          root.__mpVersusFocusRemoteAlive = remoteAlive;
        } catch (eAlive) { /* ignore */ }
      }
    } catch (e) {
      console.warn("applySpectateState inject", e);
    }

    let painted = false;
    // Product Focus is native-only. Canvas paint is explicit opts.paint (mosaic/debug).
    if (opts.paint === true && canvas) {
      drawBoardOnCanvas(canvas, board, colorInfo, board.themeColors);
      painted = true;
    }
    return {
      ok: true,
      injected: injected,
      painted: painted,
      menusSynced: menusSynced,
    };
  }

  const CONTROL_TIP_CLASSES = [
    // Current GSM (keys.svg tip)
    "ahZmw",
    "rNjvu",
    // Historical class names
    "Dg7Yne",
    "X5KmMd",
    "FL0X2d",
    "cL8wbc",
    "oN3vdf",
    "SMkkBb",
    "UfY0Tc",
  ];

  const CONTROL_TIP_CSS =
    CONTROL_TIP_CLASSES.map(function (c) {
      return "." + c;
    }).join(",") +
    ',[jsname="IoE5Ec"],[data-mp-helper-hidden="1"]{' +
    "visibility:hidden!important;opacity:0!important;" +
    "pointer-events:none!important;display:none!important;}";

  function hideControlTipNodes() {
    if (typeof document === "undefined") return;
    CONTROL_TIP_CLASSES.forEach(function (cls) {
      const nodes = document.getElementsByClassName(cls);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        el.style.display = "none";
        el.dataset.mpHelperHidden = "1";
      }
    });
    try {
      const byJs = document.querySelectorAll('[jsname="IoE5Ec"]');
      for (let j = 0; j < byJs.length; j++) {
        const el = byJs[j];
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        el.style.display = "none";
        el.dataset.mpHelperHidden = "1";
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Hide Google's first-move keyboard / hand tip (stays up if spectator keys are blocked).
   */
  function hideControlHelper() {
    // Always hit current tip nodes first (full-bleed .ahZmw fails size heuristics)
    hideControlTipNodes();

    // Walk near-canvas chrome only — NEVER the top bar shell (EjCLSb) or we
    // hide score / Multiplayer status / counters on non-admin spectators.
    const canvas = gameCanvas();
    const roots = [];
    if (canvas && canvas.parentElement) roots.push(canvas.parentElement);
    const jnb = document.getElementsByClassName("jNB0Ic")[0];
    if (jnb && jnb.parentElement && roots.indexOf(jnb.parentElement) < 0) {
      roots.push(jnb.parentElement);
    }

    function maybeHide(el) {
      if (!el || el === canvas || el.tagName === "CANVAS") return;
      if (el.id && String(el.id).indexOf("mp-") === 0) return;
      if (el.classList && el.classList.contains("wjOYOd")) return;
      // Never hide settings / cosmetics / HUD / match-rule rows
      const id = el.id || "";
      if (
        id === "settings-popup-pudding" ||
        id === "speedinfo-popup-pudding" ||
        id === "mp-mod-indicator" ||
        id === "countdown" ||
        id === "stat-icon" ||
        id === "counter-num" ||
        id === "theme" ||
        id === "color" ||
        id === "apple" ||
        id === "graphics" ||
        id === "trophy" ||
        id === "count" ||
        id === "speed" ||
        id === "size"
      ) {
        return;
      }
      if (
        el.closest &&
        (el.closest("#settings-popup-pudding") ||
          el.closest("#speedinfo-popup-pudding") ||
          el.closest(".EjCLSb") ||
          el.closest("#theme") ||
          el.closest("#color") ||
          el.closest("#apple") ||
          el.closest("#graphics") ||
          el.closest("#trophy") ||
          el.closest("#count") ||
          el.closest("#speed") ||
          el.closest("#size"))
      ) {
        return;
      }
      // Never hide a wrapper that owns the in-game setting rows
      if (
        el.querySelector &&
        el.querySelector(
          "#theme, #color, #apple, #graphics, #trophy, #count, #speed, #size"
        )
      ) {
        return;
      }
      if (el.dataset && el.dataset.mpHelperHidden === "1") {
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        return;
      }
      let cs;
      try {
        cs = root.getComputedStyle ? root.getComputedStyle(el) : null;
      } catch (e) {
        return;
      }
      if (!cs) return;
      const pos = cs.position;
      if (pos !== "absolute" && pos !== "fixed") return;
      const r = el.getBoundingClientRect();
      if (r.width < 48 || r.width > 320 || r.height < 48 || r.height > 320) return;
      // Tip is a compact overlay; skip full-bleed dimmers
      if (r.width > 280 && r.height > 280) return;
      // Skip anything in the top HUD strip
      if (r.top < 72) return;
      el.style.visibility = "hidden";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
      el.dataset.mpHelperHidden = "1";
    }

    roots.forEach(function (rootEl) {
      if (!rootEl || !rootEl.children) return;
      Array.prototype.forEach.call(rootEl.children, maybeHide);
      // One level deeper (tip often nested)
      Array.prototype.forEach.call(rootEl.children, function (child) {
        if (!child || !child.children) return;
        Array.prototype.forEach.call(child.children, maybeHide);
      });
    });
  }

  /**
   * Treat the page as if the player already took a first run: keep the
   * arrow+hand tip permanently dismissed (no ArrowRight — that moves the snake).
   */
  function installFirstRunControlTipGuard() {
    if (typeof document === "undefined") return false;
    root.__mpControlTipDismissed = true;

    // Always refresh CSS (class list evolves; old installs had stale selectors)
    try {
      let style = document.getElementById("mp-control-tip-guard");
      if (!style) {
        style = document.createElement("style");
        style.id = "mp-control-tip-guard";
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = CONTROL_TIP_CSS;
    } catch (e) { /* ignore */ }

    hideControlHelper();

    if (root.__mpControlTipGuardInstalled) {
      return true;
    }
    root.__mpControlTipGuardInstalled = true;

    // Tip is injected on first Play after refresh — re-hide when it appears
    try {
      if (typeof MutationObserver === "function" && document.body) {
        let scheduled = 0;
        const obs = new MutationObserver(function () {
          if (scheduled) return;
          scheduled = root.setTimeout
            ? root.setTimeout(function () {
                scheduled = 0;
                hideControlHelper();
              }, 0)
            : (hideControlHelper(), 0);
        });
        obs.observe(document.body, { childList: true, subtree: true });
        root.__mpControlTipObserver = obs;
      }
    } catch (e2) { /* ignore */ }

    // Short burst after load / Play (tip often mounts a few frames late)
    [0, 50, 150, 400, 1000, 2000].forEach(function (ms) {
      try {
        setTimeout(hideControlHelper, ms);
      } catch (e3) { /* ignore */ }
    });
    return true;
  }

  function restoreControlHelper() {
    // Do not resurrect the first-run tip once the MP guard is active
    if (root.__mpControlTipDismissed) {
      hideControlHelper();
      return;
    }
    document.querySelectorAll("[data-mp-helper-hidden='1']").forEach(function (el) {
      el.style.visibility = "";
      el.style.opacity = "";
      el.style.pointerEvents = "";
      el.style.display = "";
      delete el.dataset.mpHelperHidden;
    });
  }

  /** Empty local snake body (co-op spectator — companions only). */
  function emptyLocalSnakeBody() {
    const g = gameInstance();
    if (!g || !g.oa) return false;
    try {
      if (!Array.isArray(g.oa.ka)) g.oa.ka = [];
      g.oa.ka.length = 0;
      return true;
    } catch (e) {
      console.warn("emptyLocalSnakeBody", e);
      return false;
    }
  }

  /** Co-op / versus Focus spectate — never persist TimeKeeper PBs or attempts. */
  function isSpectatingForTimeKeeper() {
    return !!(root.__mpCoopSpectator || root.__mpVersusFocusSpectate);
  }

  /**
   * Patch shouldTrack so Remix savePB / saveScore / addAttempt / gotAll never
   * write while spectating. Handlers in mod.js already skip MP side-effects;
   * without this, orig.gotAll still flushed impossible times (e.g. 135ms ALL).
   */
  function installSpectatorTimeKeeperGuard() {
    const tk = root.timeKeeper;
    if (!tk) return false;
    if (tk.__mpSpectateTkGuard) return true;
    tk.__mpSpectateTkGuard = true;
    const origShouldTrack =
      typeof tk.shouldTrack === "function" ? tk.shouldTrack.bind(tk) : null;
    tk.shouldTrack = function (ctx) {
      if (isSpectatingForTimeKeeper()) return false;
      return origShouldTrack ? origShouldTrack(ctx) : true;
    };
    return true;
  }

  function wrapTimeKeeper(handlers) {
    handlers = handlers || {};
    const tk = root.timeKeeper;
    if (!tk || tk.__mpWrapped) {
      installSpectatorTimeKeeperGuard();
      return false;
    }
    tk.__mpWrapped = true;
    tk._lastScore = 0;
    tk._lastTimeMs = 0;
    tk._dead = false;
    installSpectatorTimeKeeperGuard();

    function wrap(name, after) {
      const orig = tk[name];
      if (typeof orig !== "function") return;
      tk[name] = function (timeMs, score) {
        tk._lastTimeMs = timeMs;
        tk._lastScore = score;
        if (name === "death") tk._dead = true;
        if (name === "start") tk._dead = false;
        try {
          after && after(timeMs, score, name);
        } catch (e) {
          console.warn("mp timeKeeper hook", e);
        }
        // Belt-and-suspenders: never invoke Remix save path while spectating
        if (
          isSpectatingForTimeKeeper() &&
          (name === "gotApple" || name === "gotAll" || name === "death")
        ) {
          if (name === "death" || name === "gotAll") {
            tk.playing = false;
          }
          return undefined;
        }
        return orig.apply(this, arguments);
      };
    }

    wrap("start", handlers.onStart);
    wrap("gotApple", handlers.onApple);
    wrap("gotAll", handlers.onAll);
    wrap("death", handlers.onDeath);
    return true;
  }

  /**
   * After Remix/Chess tick patches, also set __mpGame and cache board fields.
   * Co-op: __mpCoopOnTick each tick; __mpCoopRenderEnter only caches PlayerRenderer
   * (companions paint once per tick, not every render frame).
   */
  function alterSnakeCodeExposeGame(code) {
    if (typeof code !== "string") return code;
    let out = code;
    const coopTick =
      "try{window.__mpCoopOnTick&&window.__mpCoopOnTick(this);}catch(_mpCoop){}" +
      "try{window.__mpVersusFocusOnTick&&window.__mpVersusFocusOnTick(this);}catch(_mpVf){}";
    if (out.indexOf("window.__remixGame=this") !== -1) {
      out = out.replace(
        /window\.__remixGame=this/g,
        "window.__remixGame=this;window.__mpGame=this;try{window.__mpBoardCache={body:this.oa&&this.oa.ka,apples:this.wa&&this.wa.ka,dir:this.oa&&this.oa.direction};}catch(_mp){}" +
          coopTick
      );
    } else if (/\}tick\(\)\{/.test(out)) {
      out = out.replace(
        /\}tick\(\)\{/,
        "}tick(){window.__mpGame=this;window.__remixGame=this;try{window.__mpBoardCache={body:this.oa&&this.oa.ka,apples:this.wa&&this.wa.ka,dir:this.oa&&this.oa.direction};}catch(_mp){}" +
          coopTick
      );
    } else if (/tick\(\)\s*\{/.test(out)) {
      out = out.replace(
        /tick\(\)\s*\{/,
        "tick(){window.__mpGame=this;window.__remixGame=this;" + coopTick
      );
    }
    if (out.indexOf("__mpCoopOnTick") === -1 && /tick\(\)\s*\{/.test(out)) {
      out = out.replace(
        /tick\(\)\s*\{/,
        "tick(){try{window.__mpCoopOnTick&&window.__mpCoopOnTick(this);}catch(_mpCoop){}"
      );
    }

    // Capture PlayerRenderer ref for tick-synced companion paints
    if (out.indexOf("__mpCoopRenderEnter") === -1) {
      if (/render\(a,b,c\)\{/.test(out)) {
        out = out.replace(
          /render\(a,b,c\)\{/g,
          "render(a,b,c){try{window.__mpCoopRenderEnter&&window.__mpCoopRenderEnter(this,a,b,c);}catch(_mpRE){}"
        );
      }
    }
    if (out.indexOf("__mpCoopAfterSnakeRender") === -1) {
      out += "\n;void window.__mpCoopAfterSnakeRender;\n";
    }
    if (out.indexOf("__mpCoopFreePos") === -1) {
      out += "\n;window.__mpCoopFreePos=1;\n";
    }
    return out;
  }

  /**
   * Place local snake at board center + oy after co-op Play.
   * Offsets come from SESSION_START slots (count-dependent: 2→±1, 3→0/+3/−2, 4→±1/±4).
   * Does NOT force a facing direction — native Snake stays idle until the player
   * presses a key (forcing RIGHT made everyone crawl on Start match).
   */
  function applyCoopSpawnOffset(oy) {
    const g = gameInstance();
    if (!g || !g.oa) return false;
    const meta =
      (g.wa && g.wa.oa && g.wa.oa.oa) ||
      (g.oa && g.oa.oa) ||
      (g.settings && g.settings.grid) ||
      {};
    const w = firstNumber(meta.width, meta.W, 17) || 17;
    const h = firstNumber(meta.height, meta.H, 15) || 15;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2) + (Number(oy) || 0);
    const body = [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];
    try {
      // Keep native idle-until-key behavior: do not assign direction here.
      return writeNativeBody(g.oa, body);
    } catch (e) {
      console.warn("applyCoopSpawnOffset", e);
      return false;
    }
  }

  /** Park spectator local snake off-board so only remotes matter. */
  function parkLocalSnakeOffBoard() {
    const g = gameInstance();
    if (!g || !g.oa) return false;
    try {
      writeNativeBody(g.oa, [{ x: -8, y: -8 }]);
      root.__mpCoopLocalDead = true;
      return true;
    } catch (e) {
      console.warn("parkLocalSnakeOffBoard", e);
      return false;
    }
  }

  function getBoardThemeColors() {
    const out = {
      light: "#aad751",
      dark: "#a2d149",
      border: "#578a34",
      apple: "#e7471d",
    };
    try {
      const themes = root.themes;
      let idx = readSettingIndex("theme");
      if (idx == null && root.pudding_settings && root.pudding_settings.theme != null) {
        idx = root.pudding_settings.theme;
      }
      if (themes && typeof idx === "number" && themes[idx]) {
        const t = themes[idx];
        if (t.light_tiles) out.light = t.light_tiles;
        if (t.dark_tiles) out.dark = t.dark_tiles;
        if (t.border) out.border = t.border;
      }
    } catch (e) { /* defaults */ }
    return out;
  }

  /** Hide native death/end overlay so the in-game canvas is visible. */
  function hideDeathScreen() {
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay) return;
    if (overlay.dataset.mpDeathPrevVis == null) {
      overlay.dataset.mpDeathPrevVis = overlay.style.visibility || "";
      overlay.dataset.mpDeathPrevOp = overlay.style.opacity || "";
    }
    overlay.style.visibility = "hidden";
    overlay.style.opacity = "0";
  }

  function restoreDeathScreen() {
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay || overlay.dataset.mpDeathPrevVis == null) return;
    overlay.style.visibility = overlay.dataset.mpDeathPrevVis;
    overlay.style.opacity = overlay.dataset.mpDeathPrevOp || "";
    delete overlay.dataset.mpDeathPrevVis;
    delete overlay.dataset.mpDeathPrevOp;
  }

  function setNativeMenusLocked(locked, playOnly) {
    if (!playOnly) {
      SYNC_KEYS.forEach(function (id) {
        const row = document.getElementById(id);
        if (!row) return;
        row.style.pointerEvents = locked ? "none" : "";
        row.style.opacity = locked ? "0.55" : "";
        row.title = locked ? "Synced from admin" : "";
      });
      unlockPersonalMenus();
    }
    const play = playButton();
    if (play) {
      play.style.pointerEvents = locked ? "none" : "";
      play.style.opacity = locked ? "0.55" : "";
      play.title = locked
        ? playOnly
          ? "Use Start match in Multiplayer"
          : "Use Start match in Multiplayer"
        : "";
    }
  }

  /** Cosmetics (theme/color/apple/graphics) must stay clickable for every role. */
  function unlockPersonalMenus() {
    PERSONAL_KEYS.forEach(function (id) {
      const row = document.getElementById(id);
      if (!row) return;
      row.style.pointerEvents = "";
      row.style.opacity = "";
      row.style.visibility = "";
      row.title = "";
      if (row.dataset) delete row.dataset.mpHelperHidden;
    });
  }

  /** Always disable Play while in a multiplayer room (Start match only). */
  function setPlayButtonLocked(locked) {
    const play = playButton();
    if (!play) return;
    play.style.pointerEvents = locked ? "none" : "";
    play.style.opacity = locked ? "0.55" : "";
    play.title = locked ? "Use Start match in Multiplayer" : "";
  }

  /** Snapshot for SETTINGS_SYNC — match rules only, no personal cosmetics. */
  function snapshotSyncSettings() {
    const snap = snapshotSettings();
    PERSONAL_KEYS.forEach(function (k) {
      delete snap[k];
    });
    return snap;
  }

  /** True when local trophy/count/speed/size match the given sync payload. */
  function settingsMatchLocal(settings) {
    if (!settings || typeof settings !== "object") return false;
    let saw = false;
    for (let i = 0; i < SYNC_KEYS.length; i++) {
      const key = SYNC_KEYS[i];
      if (settings[key] == null) continue;
      saw = true;
      const want = Number(settings[key]);
      if (Number.isNaN(want)) continue;
      const cur = readSettingIndex(key);
      if (cur == null || Number(cur) !== want) return false;
    }
    return saw;
  }

  function setLocalPaused(paused) {
    root.pauseGame = paused ? 1 : 0;
  }

  function isLocalPaused() {
    return !!root.pauseGame;
  }

  /** Reveal native death/end overlay so settings + Play are usable. */
  function showDeathScreen(opts) {
    opts = opts || {};
    // Keep Focus menu-peek ticking; otherwise STOP the run behind the chrome.
    if (!opts.keepRunning) {
      root.pauseGame = 1;
      try {
        const g = gameInstance();
        if (g) {
          g.nj = true;
          if (g.dead != null) g.dead = true;
        }
        if (root.timeKeeper) {
          root.timeKeeper._dead = true;
          root.timeKeeper.playing = false;
        }
      } catch (e) { /* ignore */ }
    }
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (overlay) {
      overlay.style.visibility = "visible";
      overlay.style.opacity = "1";
      const menu = overlay.children && overlay.children[0];
      if (menu) menu.style.visibility = "visible";
    }
    // Sync engine quit state (same signal Remix reset uses), unless caller
    // already came from an Escape keydown (avoids re-entrancy).
    if (opts.skipEscapeDispatch) return;
    if (root.__mpEscHandling) return;
    try {
      root.__mpEscHandling = true;
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch (e) { /* ignore */ }
    finally {
      root.__mpEscHandling = false;
    }
  }

  function drawCoopSnapshot(canvas, snap, colorsApi) {
    if (!canvas || !snap) return;
    const Colors = colorsApi || root.MultiplayerColors;
    const w = snap.width || 17;
    const h = snap.height || 15;
    const apples = snap.apple ? [snap.apple] : snap.apples || [];
    drawBoardOnCanvas(canvas, { width: w, height: h, apples: apples, body: [] });
    const ctx = canvas.getContext("2d");
    const cw = canvas.width;
    const ch = canvas.height;
    const cell = Math.min(cw / w, ch / h);
    const ox = (cw - cell * w) / 2;
    const oy = (ch - cell * h) / 2;
    (snap.snakes || []).forEach(function (s) {
      const body = s.body || [];
      const alive = s.alive !== false;
      const colorId = s.color_id != null ? s.color_id : s.colorId;
      const c = Colors && Colors.getColor ? Colors.getColor(colorId) : null;
      ctx.globalAlpha = alive ? 1 : 0.5;
      drawWallSolverStyleSnake(ctx, body, ox, oy, cell, c, s.dir);
      ctx.globalAlpha = 1;
    });
  }

  function scrapeSnakeDelta(colorId) {
    return scrapeCoopSnakeDelta(colorId);
  }

  /**
   * Slim co-op pose scrape: body + dir + alive (+ colors when includeColors).
   * No width/height/score on the pose channel (reduces lag).
   */
  function scrapeCoopSnakeDelta(colorId, opts) {
    opts = opts || {};
    const includeColors = opts.includeColors !== false;
    const g = gameInstance();
    const bodySrc =
      (g && g.oa && g.oa.ka) ||
      root.head_pos ||
      (root.__mpBoardCache && root.__mpBoardCache.body);
    if (!bodySrc && !g) return null;
    const snake = (g && g.oa) || {};
    const body = mapBody(bodySrc);
    const scoreInfo = readScoreAndAlive();
    const out = {
      body: body,
      dir: snake.direction || snake.dir || root.head_dir || null,
      alive: scoreInfo.alive !== false,
    };
    if (!includeColors) return out;

    const Colors = root.MultiplayerColors;
    let color1 = null;
    let color2 = null;
    let Sc = null;
    let Yc = null;
    try {
      const cfg = g && (g.snakeBodyConfig || snake);
      if (snake) {
        if (typeof snake.Sc === "string") Sc = snake.Sc;
        if (typeof snake.Yc === "string") Yc = snake.Yc;
      }
      if (cfg) {
        color1 = cfg.color1 || cfg.secondary || Yc || null;
        color2 = cfg.color2 || cfg.primary || Sc || null;
        if (!Sc && typeof cfg.Sc === "string") Sc = cfg.Sc;
        if (!Yc && typeof cfg.Yc === "string") Yc = cfg.Yc;
      }
    } catch (e) { /* ignore */ }
    if ((!Sc || !Yc) && colorId != null && Colors && Colors.getColor) {
      const c = Colors.getColor(colorId);
      if (c) {
        if (c.kind === "rainbow" && c.set && c.set.length) {
          if (!Sc) Sc = c.set[0];
          if (!Yc) Yc = c.set[1] || c.set[0];
        } else if (c.primary) {
          if (!Sc) Sc = c.primary;
          if (!Yc) Yc = c.secondary || c.primary;
        }
        if (!color2) color2 = Sc;
        if (!color1) color1 = Yc;
      }
    }
    out.colorId = colorId != null ? colorId : null;
    out.color1 = color1;
    out.color2 = color2;
    out.Sc = Sc;
    out.Yc = Yc;
    return out;
  }

  function snakeDeltaFingerprint(delta) {
    if (!delta) return "";
    // Pose identity is head + length + dir (+ alive) — avoid O(n) string growth
    const body = delta.body || [];
    const h = body[0];
    return (
      (delta.alive === false ? "0" : "1") +
      "|" +
      (delta.dir || "") +
      "|" +
      body.length +
      "|" +
      (h ? h.x + "," + h.y : "")
    );
  }

  function scrapeCollectables(opts) {
    opts = opts || {};
    const board = scrapeBoard();
    if (!board) return null;
    const out = {
      apples: board.apples || [],
      width: board.width,
      height: board.height,
    };
    // Heavy board entities only when requested (trophy modes) — default fruit-only
    if (opts.includeEntities) {
      const entities = scrapeBoardEntities();
      out.walls = entities.walls;
      out.keys = entities.keys;
      out.boxes = entities.boxes;
      out.goals = entities.goals;
      out.mines = entities.mines;
      out.statues = entities.statues;
      out.bridges = entities.bridges;
      out.gates = entities.gates;
      out.score = board.score;
    }
    return out;
  }

  /**
   * During co-op, if synced fruit lands on a live/dead snake cell, nudge to a
   * free cell locally (safety net — eater freePos should already avoid snakes).
   */
  function nudgeCoopApplesOffSnakes(apples, game) {
    if (!Array.isArray(apples) || !apples.length) return apples;
    if (!root.__mpCoopSession || !root.__mpCoopInject) return apples;
    const readOcc = root.__mpCoopReadOccupancy;
    const findFree = root.__mpCoopFindFreeSpawn;
    if (typeof readOcc !== "function") return apples;

    const out = apples.map(function (a) {
      return a ? Object.assign({}, a) : { x: 0, y: 0 };
    });
    const reserved = {};

    function blockedKeys() {
      const occ = Object.assign({}, readOcc());
      Object.keys(reserved).forEach(function (k) {
        occ[k] = true;
      });
      return occ;
    }

    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const x = a.x != null ? a.x | 0 : 0;
      const y = a.y != null ? a.y | 0 : 0;
      const k = x + "," + y;
      const occ = blockedKeys();
      if (!occ[k]) {
        reserved[k] = true;
        a.x = x;
        a.y = y;
        continue;
      }
      let free = null;
      if (typeof findFree === "function") {
        free = findFree(game, occ);
      }
      if (!free) {
        // Fallback scan without helper
        const meta =
          (game && game.wa && game.wa.oa && game.wa.oa.oa) ||
          (game && game.oa && game.oa.oa) ||
          {};
        const w = firstNumber(meta.width, meta.W, 17) || 17;
        const h = firstNumber(meta.height, meta.H, 15) || 15;
        outer: for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const kk = xx + "," + yy;
            if (!occ[kk]) {
              free = { x: xx, y: yy };
              break outer;
            }
          }
        }
      }
      if (free) {
        a.x = free.x;
        a.y = free.y;
        reserved[free.x + "," + free.y] = true;
      } else {
        reserved[k] = true;
      }
    }
    return out;
  }

  /** Write apple positions into exposed game fields; grow/shrink list to match owner. */
  function applyCollectables(payload) {
    if (!payload || !payload.apples) return false;
    const g = gameInstance();
    let apples = payload.apples;
    try {
      apples = nudgeCoopApplesOffSnakes(apples, g);
      if (g && g.wa && Array.isArray(g.wa.ka)) {
        // Native fruit render does `apple.pos.clone()` — keep a template Od/point.
        let templateApple = null;
        let templatePos = null;
        for (let t = 0; t < g.wa.ka.length; t++) {
          const a = g.wa.ka[t];
          if (!a) continue;
          if (!templateApple) templateApple = a;
          if (a.pos && typeof a.pos.clone === "function") {
            templatePos = a.pos;
            templateApple = a;
            break;
          }
        }
        while (g.wa.ka.length > apples.length) {
          g.wa.ka.pop();
        }
        for (let i = 0; i < apples.length; i++) {
          const src = apples[i];
          let dst = g.wa.ka[i];
          if (!dst) {
            dst = {};
            if (templateApple) {
              try {
                Object.keys(templateApple).forEach(function (k) {
                  if (k === "pos") return;
                  dst[k] = templateApple[k];
                });
              } catch (e) { /* ignore */ }
            }
            dst.pos = makeNativePoint(src.x, src.y, templatePos);
            dst.type = src.type != null ? src.type : dst.type != null ? dst.type : 0;
            g.wa.ka[i] = dst;
            if (!templatePos && dst.pos) templatePos = dst.pos;
            if (!templateApple) templateApple = dst;
          } else if (dst.pos || templatePos) {
            dst.pos = ensureNativePos(dst.pos, src.x, src.y, templatePos);
            if (!templatePos && dst.pos) templatePos = dst.pos;
          } else {
            // Rare: apple stored as a bare point
            dst.x = src.x;
            dst.y = src.y;
            if (typeof dst.clone !== "function") {
              dst.pos = makeNativePoint(src.x, src.y, templatePos);
            }
          }
          if (src.type != null) dst.type = src.type;
          if (src.poison) {
            dst.Oka = true;
            if (dst.nla != null) dst.nla = true;
          }
        }
        applyBoardEntities(payload);
        return true;
      }
    } catch (e) {
      console.warn("applyCollectables", e);
    }
    return false;
  }

  /** Start native run clock for co-op players (not spectators). */
  function startCoopRunTimer(opts) {
    opts = opts || {};
    if (opts.spectator || isSpectatingForTimeKeeper()) return false;
    installSpectatorTimeKeeperGuard();
    const startedAt = opts.timerStartedAtMs != null ? Number(opts.timerStartedAtMs) : null;
    function applyOnce() {
      const tk = root.timeKeeper;
      if (!tk) return false;
      if (isSpectatingForTimeKeeper()) return true;
      try {
        tk._dead = false;
        if (typeof tk.start === "function") tk.start();
        else tk.playing = true;
        if (startedAt && Number.isFinite(startedAt)) {
          const elapsed = Math.max(0, Date.now() - startedAt);
          tk._lastTimeMs = elapsed;
          if (typeof tk.lastAppleTime === "number") tk.lastAppleTime = elapsed;
          // Hint engines that expose a wall-clock anchor
          tk.__mpCoopStartedAtMs = startedAt;
        }
        return true;
      } catch (e) {
        console.warn("startCoopRunTimer", e);
        return false;
      }
    }
    if (applyOnce()) return true;
    // Retry until timeKeeper exists (cold first Start)
    let tries = 0;
    const max = opts.maxAttempts != null ? opts.maxAttempts : 40;
    const iv = opts.intervalMs != null ? opts.intervalMs : 50;
    const timer = setInterval(function () {
      tries++;
      if (applyOnce() || tries >= max) clearInterval(timer);
    }, iv);
    return false;
  }

  /** Freeze native run clock (all-dead / ALL apples) — leave last time visible. */
  function stopCoopRunTimer() {
    const tk = root.timeKeeper;
    if (!tk) return false;
    try {
      tk.playing = false;
      if (typeof tk.stop === "function") {
        try {
          tk.stop();
        } catch (e) { /* ignore */ }
      }
      return true;
    } catch (e) {
      console.warn("stopCoopRunTimer", e);
      return false;
    }
  }

  function slugFromModeName(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  /**
   * SpeedInfo ModeRegistry: never show unknown_N when modeToTxt has a name.
   * Covers all trophy indices (Peaceful 21 and every other mode).
   */
  function installModeLabelPatch() {
    const MR = root.ModeRegistry;
    if (!MR || MR.__mpModeLabelPatched) return false;
    MR.__mpModeLabelPatched = true;

    function labelFromIndex(index) {
      const mt = root.modeToTxt && root.modeToTxt[index];
      if (mt && mt.name) {
        return { id: slugFromModeName(mt.name) || "mode_" + index, label: mt.name };
      }
      return null;
    }

    function resolveUnknownKey(key) {
      if (!key || typeof key !== "string") return null;
      let m = key.match(/^unknown_(\d+)$/);
      if (!m) m = key.match(/^trophy_(\d+)$/);
      if (!m) return null;
      return labelFromIndex(Number(m[1]));
    }

    if (typeof MR.labelModeKey === "function") {
      const origLabel = MR.labelModeKey.bind(MR);
      MR.labelModeKey = function (key) {
        const resolved = resolveUnknownKey(key);
        if (resolved) return resolved.label;
        const out = origLabel(key);
        if (out && /^unknown_/.test(String(out))) {
          const again = resolveUnknownKey(String(out));
          if (again) return again.label;
        }
        return out;
      };
    }

    if (typeof MR.listActiveModes === "function") {
      const origList = MR.listActiveModes.bind(MR);
      MR.listActiveModes = function () {
        const list = origList();
        if (!Array.isArray(list)) return list;
        return list.map(function (m) {
          if (!m) return m;
          const idx = m.index != null ? m.index : null;
          if (m.id && !/^unknown_/.test(m.id) && m.label && !/^unknown_/.test(m.label)) {
            return m;
          }
          const fromIdx = idx != null ? labelFromIndex(idx) : null;
          const fromId = resolveUnknownKey(m.id);
          const hit = fromIdx || fromId;
          if (!hit) return m;
          return {
            id: hit.id,
            label: hit.label,
            index: m.index,
          };
        });
      };
      // Preserve remix marker if present
      if (origList.__remix) MR.listActiveModes.__remix = true;
    }
    return true;
  }

  /** Force local death so cross-snake collision ends the native run. */
  function forceLocalDeath() {
    try {
      const g = gameInstance();
      if (g && typeof g.die === "function") {
        g.die();
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      if (root.timeKeeper && typeof root.timeKeeper.death === "function") {
        const s = readScoreAndAlive();
        root.timeKeeper.death(s.timeMs || 0, s.score || 0);
        return true;
      }
    } catch (e2) { /* ignore */ }
    showDeathScreen({ skipEscapeDispatch: false });
    return false;
  }

  root.MultiplayerGsm = {
    SETTING_KEYS: SETTING_KEYS,
    SYNC_KEYS: SYNC_KEYS,
    PERSONAL_KEYS: PERSONAL_KEYS,
    playButton: playButton,
    fullscreenButton: fullscreenButton,
    settingsGear: settingsGear,
    gameCanvas: gameCanvas,
    openSettingsPanel: openSettingsPanel,
    closeSettingsPanel: closeSettingsPanel,
    readSettingIndex: readSettingIndex,
    snapshotSettings: snapshotSettings,
    snapshotSyncSettings: snapshotSyncSettings,
    settingsMatchLocal: settingsMatchLocal,
    applySettings: applySettings,
    applySnakeColor: applySnakeColor,
    triggerPlay: triggerPlay,
    isDeathOverlayVisible: isDeathOverlayVisible,
    isNativeRunLive: isNativeRunLive,
    prepareNativePlay: prepareNativePlay,
    startNativeRun: startNativeRun,
    clearDeathOverlayOverrides: clearDeathOverlayOverrides,
    dismissDeathOverlayForRun: dismissDeathOverlayForRun,
    gameInstance: gameInstance,
    readScoreAndAlive: readScoreAndAlive,
    scrapeBoard: scrapeBoard,
    scrapeSnakeDelta: scrapeSnakeDelta,
    scrapeCoopSnakeDelta: scrapeCoopSnakeDelta,
    snakeDeltaFingerprint: snakeDeltaFingerprint,
    scrapeCollectables: scrapeCollectables,
    scrapeBoardEntities: scrapeBoardEntities,
    applyCollectables: applyCollectables,
    applyBoardEntities: applyBoardEntities,
    applyCoopSpawnOffset: applyCoopSpawnOffset,
    parkLocalSnakeOffBoard: parkLocalSnakeOffBoard,
    emptyLocalSnakeBody: emptyLocalSnakeBody,
    applySpectateState: applySpectateState,
    makeNativePoint: makeNativePoint,
    ensureNativePos: ensureNativePos,
    writeNativeBody: writeNativeBody,
    writeNativeHead: writeNativeHead,
    followBodyFromHead: followBodyFromHead,
    bodyTrailConnected: bodyTrailConnected,
    reapplyFocusBody: reapplyFocusBody,
    hideControlHelper: hideControlHelper,
    restoreControlHelper: restoreControlHelper,
    installFirstRunControlTipGuard: installFirstRunControlTipGuard,
    forceLocalDeath: forceLocalDeath,
    installFocusDieGuard: installFocusDieGuard,
    installFocusTickGuard: installFocusTickGuard,
    focusPoseFingerprint: focusPoseFingerprint,
    startCoopRunTimer: startCoopRunTimer,
    stopCoopRunTimer: stopCoopRunTimer,
    installModeLabelPatch: installModeLabelPatch,
    isSpectatingForTimeKeeper: isSpectatingForTimeKeeper,
    installSpectatorTimeKeeperGuard: installSpectatorTimeKeeperGuard,
    wrapTimeKeeper: wrapTimeKeeper,
    alterSnakeCodeExposeGame: alterSnakeCodeExposeGame,
    drawBoardOnCanvas: drawBoardOnCanvas,
    drawWallSolverStyleSnake: drawWallSolverStyleSnake,
    resolveAppleImageUrl: resolveAppleImageUrl,
    resolveThemeColors: resolveThemeColors,
    drawCoopSnapshot: drawCoopSnapshot,
    setNativeMenusLocked: setNativeMenusLocked,
    unlockPersonalMenus: unlockPersonalMenus,
    setPlayButtonLocked: setPlayButtonLocked,
    setLocalPaused: setLocalPaused,
    isLocalPaused: isLocalPaused,
    showDeathScreen: showDeathScreen,
    hideDeathScreen: hideDeathScreen,
    restoreDeathScreen: restoreDeathScreen,
    getBoardThemeColors: getBoardThemeColors,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.MultiplayerGsm;
  }
})(typeof window !== "undefined" ? window : globalThis);
