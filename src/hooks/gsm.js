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
   */
  function isNativeRunLive() {
    const g = gameInstance();
    if (!g || !g.oa) return false;
    if (g.nj || g.dead || g.isDead) return false;
    if (root.timeKeeper && root.timeKeeper._dead) return false;
    if (!isDeathOverlayVisible()) return true;
    // Engine alive but our sticky inline styles left the endscreen up — dismiss
    if (root.__mpStartingMatch) {
      dismissDeathOverlayForRun();
      return !isDeathOverlayVisible();
    }
    return false;
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
   * @param {{maxAttempts?:number,intervalMs?:number,onDone?:function(boolean)}} opts
   */
  function startNativeRun(opts) {
    opts = opts || {};
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 50;
    const intervalMs = opts.intervalMs != null ? opts.intervalMs : 40;
    const onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    root.__mpStartingMatch = true;
    root.__mpApplySettingsGen = (root.__mpApplySettingsGen || 0) + 1;
    prepareNativePlay();
    let attempts = 0;
    function tick() {
      attempts++;
      try {
        if (!isNativeRunLive()) {
          closeSettingsPanel();
          // Undo spectate/hideDeathScreen so the Play control is hittable
          clearDeathOverlayOverrides();
          triggerPlay();
          // After several clicks, force-clear dead flag if Play didn't (some skins)
          if (attempts >= 8 && root.timeKeeper && root.timeKeeper._dead) {
            root.timeKeeper._dead = false;
            if (typeof root.timeKeeper.start === "function") {
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
      if (isNativeRunLive() || attempts >= maxAttempts) {
        const ok = isNativeRunLive();
        if (ok) dismissDeathOverlayForRun();
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
   * Native PlayerRenderer calls seg.clone() on body points. Plain {x,y} from
   * BOARD_DELTA / spectate inject crash spectators — always keep a clone fn.
   */
  function makeNativePoint(x, y, template) {
    const nx = x != null ? Number(x) : 0;
    const ny = y != null ? Number(y) : 0;
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
      if (cur && typeof cur.clone === "function") {
        cur.x = p.x != null ? p.x : 0;
        cur.y = p.y != null ? p.y : 0;
      } else {
        snake.ka[i] = makeNativePoint(
          p.x != null ? p.x : 0,
          p.y != null ? p.y : 0,
          template || cur
        );
        if (!template) template = snake.ka[i];
      }
    }
    return true;
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
      while (hostArr.length > list.length) hostArr.pop();
      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        let dst = hostArr[i];
        if (!dst) {
          dst = { x: src.x, y: src.y };
          hostArr[i] = dst;
        } else if (dst.pos) {
          dst.pos.x = src.x;
          dst.pos.y = src.y;
        } else {
          dst.x = src.x;
          dst.y = src.y;
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
    (board.apples || []).forEach(function (a) {
      ctx.fillStyle = theme.apple || "#e7471d";
      ctx.beginPath();
      ctx.arc(
        ox + a.x * cell + cell / 2,
        oy + a.y * cell + cell / 2,
        cell * 0.35,
        0,
        Math.PI * 2
      );
      ctx.fill();
    });
    let head = "#17439F";
    let body = "#4E7CF6";
    if (colorInfo) {
      if (colorInfo.primary) {
        body = colorInfo.primary;
        head = colorInfo.secondary || colorInfo.primary;
      }
      if (colorInfo.set && colorInfo.set.length) {
        body = colorInfo.set[0];
        head = colorInfo.set[0];
      }
    }
    const segments = board.body || [];
    segments.forEach(function (p, i) {
      if (colorInfo && colorInfo.set && colorInfo.set.length) {
        ctx.fillStyle = colorInfo.set[i % colorInfo.set.length];
      } else {
        ctx.fillStyle = i === 0 ? head : body;
      }
      const pad = Math.max(1, cell * 0.08);
      ctx.fillRect(
        ox + p.x * cell + pad,
        oy + p.y * cell + pad,
        cell - pad * 2,
        cell - pad * 2
      );
    });
  }

  /**
   * Versus Focus: inject focused player's state into the live GameInstance so
   * native snake/fruit renderers draw the spectated run. Paint is opt-in only
   * (opts.paint === true) — product Focus must stay native.
   * Returns { ok, injected, painted }.
   */
  function applySpectateState(canvas, board, colorInfo, opts) {
    opts = opts || {};
    if (!board) return { ok: false, injected: false, painted: false };

    function syncMenu(key, idx) {
      if (idx == null || typeof idx !== "number" || Number.isNaN(Number(idx))) return;
      const cur = readSettingIndex(key);
      if (cur == null || Number(cur) !== Number(idx)) {
        selectMenu(key, Number(idx));
      }
    }

    // Match rules (board size / fruit count) — critical for native chrome
    syncMenu("size", board.sizeIndex);
    syncMenu("count", board.countIndex);
    syncMenu("speed", board.speedIndex);
    syncMenu("trophy", board.trophyIndex);
    // Focused player's cosmetics so fruit sprites + snake skin match
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

    let injected = false;
    try {
      const g = gameInstance();
      if (g && g.oa && Array.isArray(board.body)) {
        // Must keep .clone() on segments — plain {x,y} crashes PlayerRenderer
        injected = writeNativeBody(g.oa, board.body);
        if (board.dir) {
          g.oa.direction = board.dir;
          if (g.oa.dir != null) g.oa.dir = board.dir;
        }
      }
      if (g && g.wa && Array.isArray(board.apples)) {
        applyCollectables({ apples: board.apples });
      }
    } catch (e) {
      console.warn("applySpectateState inject", e);
    }

    let painted = false;
    if (opts.paint === true && canvas) {
      drawBoardOnCanvas(canvas, board, colorInfo, board.themeColors);
      painted = true;
    }
    return { ok: true, injected: injected, painted: painted };
  }

  /**
   * Hide Google's first-move keyboard / hand tip (stays up if spectator keys are blocked).
   */
  function hideControlHelper() {
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

    // Known / historical class names for the keys tip
    [
      "Dg7Yne",
      "X5KmMd",
      "FL0X2d",
      "cL8wbc",
      "oN3vdf",
      "SMkkBb",
      "UfY0Tc",
    ].forEach(function (cls) {
      const nodes = document.getElementsByClassName(cls);
      for (let i = 0; i < nodes.length; i++) maybeHide(nodes[i]);
    });
  }

  function restoreControlHelper() {
    document.querySelectorAll("[data-mp-helper-hidden='1']").forEach(function (el) {
      el.style.visibility = "";
      el.style.opacity = "";
      el.style.pointerEvents = "";
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

  function wrapTimeKeeper(handlers) {
    handlers = handlers || {};
    const tk = root.timeKeeper;
    if (!tk || tk.__mpWrapped) return false;
    tk.__mpWrapped = true;
    tk._lastScore = 0;
    tk._lastTimeMs = 0;
    tk._dead = false;

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
    root.pauseGame = false;
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (overlay) {
      overlay.style.visibility = "visible";
      overlay.style.opacity = "1";
      const menu = overlay.children && overlay.children[0];
      if (menu) menu.style.visibility = "visible";
    }
    // Sync engine quit state (same signal Remix reset uses), unless caller
    // already came from an Escape keydown (avoids re-entrancy).
    if (opts && opts.skipEscapeDispatch) return;
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
      body.forEach(function (p, i) {
        // Corpses stay visible but faded — still drawn as obstacles
        ctx.globalAlpha = alive ? 1 : 0.5;
        if (c && c.set && c.set.length) {
          ctx.fillStyle = c.set[i % c.set.length];
        } else if (c && c.primary) {
          ctx.fillStyle = i === 0 ? c.secondary || c.primary : c.primary;
        } else {
          ctx.fillStyle = i === 0 ? "#17439F" : "#4E7CF6";
        }
        const pad = Math.max(1, cell * 0.08);
        ctx.fillRect(
          ox + p.x * cell + pad,
          oy + p.y * cell + pad,
          cell - pad * 2,
          cell - pad * 2
        );
      });
      ctx.globalAlpha = 1;
    });
  }

  function scrapeSnakeDelta(colorId) {
    return scrapeCoopSnakeDelta(colorId);
  }

  /**
   * Slim co-op pose scrape: body + dir + alive + colors only (no menu walks).
   */
  function scrapeCoopSnakeDelta(colorId) {
    const g = gameInstance();
    const bodySrc =
      (g && g.oa && g.oa.ka) ||
      root.head_pos ||
      (root.__mpBoardCache && root.__mpBoardCache.body);
    if (!bodySrc && !g) return null;
    const snake = (g && g.oa) || {};
    const body = mapBody(bodySrc);
    const scoreInfo = readScoreAndAlive();
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
    const meta =
      (g && g.wa && g.wa.oa && g.wa.oa.oa) ||
      (snake && snake.oa) ||
      (g && g.settings && g.settings.grid) ||
      {};
    return {
      body: body,
      dir: snake.direction || snake.dir || root.head_dir || null,
      width: firstNumber(meta.width, meta.W, 17) || 17,
      height: firstNumber(meta.height, meta.H, 15) || 15,
      score: scoreInfo.score,
      alive: scoreInfo.alive !== false,
      colorId: colorId != null ? colorId : null,
      color1: color1,
      color2: color2,
      Sc: Sc,
      Yc: Yc,
    };
  }

  function snakeDeltaFingerprint(delta) {
    if (!delta) return "";
    const body = delta.body || [];
    let s =
      (delta.alive === false ? "0" : "1") +
      "|" +
      (delta.dir || "") +
      "|" +
      body.length;
    for (let i = 0; i < body.length; i++) {
      const p = body[i];
      s += "|" + (p && p.x) + "," + (p && p.y);
    }
    if (delta.Sc) s += "|" + delta.Sc;
    if (delta.Yc) s += "|" + delta.Yc;
    return s;
  }

  function scrapeCollectables() {
    const board = scrapeBoard();
    if (!board) return null;
    const entities = scrapeBoardEntities();
    return {
      apples: board.apples || [],
      width: board.width,
      height: board.height,
      score: board.score,
      walls: entities.walls,
      keys: entities.keys,
      boxes: entities.boxes,
      goals: entities.goals,
      mines: entities.mines,
      statues: entities.statues,
      bridges: entities.bridges,
      gates: entities.gates,
    };
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
        while (g.wa.ka.length > apples.length) {
          g.wa.ka.pop();
        }
        for (let i = 0; i < apples.length; i++) {
          const src = apples[i];
          let dst = g.wa.ka[i];
          if (!dst) {
            dst = { pos: { x: src.x, y: src.y }, type: src.type != null ? src.type : 0 };
            g.wa.ka[i] = dst;
          }
          if (dst.pos) {
            dst.pos.x = src.x;
            dst.pos.y = src.y;
          } else {
            dst.x = src.x;
            dst.y = src.y;
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

  /** Start native run clock for co-op (everyone on PLAY_SYNC). */
  function startCoopRunTimer() {
    const tk = root.timeKeeper;
    if (!tk) return false;
    try {
      tk._dead = false;
      if (typeof tk.start === "function") tk.start();
      else tk.playing = true;
      return true;
    } catch (e) {
      console.warn("startCoopRunTimer", e);
      return false;
    }
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
    writeNativeBody: writeNativeBody,
    hideControlHelper: hideControlHelper,
    restoreControlHelper: restoreControlHelper,
    forceLocalDeath: forceLocalDeath,
    startCoopRunTimer: startCoopRunTimer,
    stopCoopRunTimer: stopCoopRunTimer,
    wrapTimeKeeper: wrapTimeKeeper,
    alterSnakeCodeExposeGame: alterSnakeCodeExposeGame,
    drawBoardOnCanvas: drawBoardOnCanvas,
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
