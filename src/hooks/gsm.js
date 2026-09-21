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

  /**
   * Remix keys every custom mode (Burger/Chess/Cat/Bomb/Slot/…) off
   * window.CurrentModeNum, which the native menu only assigns from its own
   * `case "trophy":` handler on a real interaction. Programmatic applies
   * (Start match, SETTINGS_SYNC, Focus menu sync) bypass that handler, so the
   * mode number stays stale.
   *
   * That matters most on the first run of the page: mode predicates such as
   * isBurgerActive() fall back to __remixGame.settings.ub, but __remixGame is
   * only assigned from tick() — and the apple manager reset runs before the
   * first tick. With a stale mode number Burger reads as inactive there, so
   * native Poison pairs half the board (l4E) before Burger arms its timers.
   */
  function syncCurrentModeNum(idx) {
    if (typeof root.CurrentModeNum !== "number") return;
    const n = Number(idx);
    if (!Number.isFinite(n) || root.CurrentModeNum === n) return;
    root.CurrentModeNum = n;
    // Mirror the native handler's deferred trophy/SpeedInfo refresh
    try {
      if (typeof root.getAllSrc === "function") {
        const p = root.getAllSrc();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  function selectMenu(key, idx) {
    function done() {
      if (key === "trophy") syncCurrentModeNum(idx);
      return true;
    }
    if (typeof root.puddingMenuSelect === "function") {
      try {
        if (root.puddingMenuSelect(key, idx) === true) return done();
      } catch (e) {
        console.warn("puddingMenuSelect failed", key, e);
      }
    }
    if (typeof root.clickGameSettingIndex === "function") {
      try {
        if (root.clickGameSettingIndex(key, idx) === true) return done();
      } catch (e) { /* fall through */ }
    }
    const row = document.getElementById(key);
    if (row && row.children && row.children[idx] && typeof row.children[idx].click === "function") {
      row.children[idx].click();
      return done();
    }
    return false;
  }

  /**
   * Write size index onto the live engine settings object Play reads when baking.
   * Menu size lives in `settings.Sa`; Play's Ma() does `Aa = Sa` then Sna() bakes
   * from `Aa` (0→17×15, 1→10×9, 2→24×21). Writing only Aa is useless — Ma overwrites
   * it from a stale Sa. Always set both.
   */
  function forceEngineSizeForPlay(sizeIndex) {
    const idx = Number(sizeIndex);
    if (!Number.isFinite(idx) || idx < 0) return false;
    let wrote = false;
    function writeOn(settings) {
      if (!settings || typeof settings !== "object") return;
      try {
        settings.Sa = idx;
        settings.Aa = idx;
        wrote = true;
      } catch (e) { /* ignore */ }
    }
    try {
      const g = gameInstance();
      if (g) writeOn(g.settings);
    } catch (eG) { /* ignore */ }
    try {
      writeOn(root.__mpGame && root.__mpGame.settings);
      writeOn(root.__remixGame && root.__remixGame.settings);
    } catch (eR) { /* ignore */ }
    try {
      const hosts = [
        root.megaWholeSnakeObject,
        root.wholeSnakeObject,
        root.__mpSettingsHost,
      ];
      for (let i = 0; i < hosts.length; i++) {
        const h = hosts[i];
        if (h) writeOn(h.settings || h);
      }
    } catch (eH) { /* ignore */ }
    // Menu controller often holds the settings object Play's Ma() copies from
    try {
      const menu = root._puddingSnakeMenu;
      if (menu && menu.settings) writeOn(menu.settings);
    } catch (eM) { /* ignore */ }
    try {
      const saved =
        root.pudding_settings && root.pudding_settings.SavedGameSettings;
      if (saved && typeof saved === "object") saved.size = idx;
    } catch (eS) { /* ignore */ }
    return wrote;
  }

  /**
   * Mirror menu→bake dual fields the same way Play's Ma() does:
   * size Sa→Aa, count Ca→ka, speed Oa→yb, trophy/mode ob→ub.
   */
  function forceEngineMatchFieldsForPlay(settings) {
    if (!settings || typeof settings !== "object") return false;
    let wrote = false;
    function writeOn(host) {
      if (!host || typeof host !== "object") return;
      try {
        if (settings.size != null && Number.isFinite(Number(settings.size))) {
          const idx = Number(settings.size) | 0;
          host.Sa = idx;
          host.Aa = idx;
          wrote = true;
        }
        if (settings.count != null && Number.isFinite(Number(settings.count))) {
          const idx = Number(settings.count) | 0;
          host.Ca = idx;
          host.ka = idx;
          wrote = true;
        }
        if (settings.speed != null && Number.isFinite(Number(settings.speed))) {
          const idx = Number(settings.speed) | 0;
          host.Oa = idx;
          host.yb = idx;
          wrote = true;
        }
        if (settings.trophy != null && Number.isFinite(Number(settings.trophy))) {
          const idx = Number(settings.trophy) | 0;
          host.ob = idx;
          host.ub = idx;
          wrote = true;
        }
      } catch (e) { /* ignore */ }
    }
    const hosts = [];
    try {
      const g = gameInstance();
      if (g && g.settings) hosts.push(g.settings);
    } catch (eG) { /* ignore */ }
    try {
      if (root.__mpGame && root.__mpGame.settings) hosts.push(root.__mpGame.settings);
      if (root.__remixGame && root.__remixGame.settings) {
        hosts.push(root.__remixGame.settings);
      }
    } catch (eR) { /* ignore */ }
    try {
      [
        root.megaWholeSnakeObject,
        root.wholeSnakeObject,
        root.__mpSettingsHost,
        root._puddingSnakeMenu,
      ].forEach(function (h) {
        if (h && h.settings) hosts.push(h.settings);
        else if (h && ("Sa" in h || "Aa" in h)) hosts.push(h);
      });
    } catch (eH) { /* ignore */ }
    for (let i = 0; i < hosts.length; i++) writeOn(hosts[i]);
    if (settings.size != null) forceEngineSizeForPlay(settings.size);
    return wrote;
  }

  /**
   * Force match rules (trophy/count/speed/size) into the live menu for Play.
   * Play bakes W/H from settings size index (Aa) — must be correct before
   * the first NSjDf click. Ignores __mpStartingMatch quiet-only path.
   */
  function forceMatchSettingsForPlay(settings) {
    if (!settings || typeof settings !== "object") return false;
    root.__mpApplyingSettings = true;
    try {
      const keys = SYNC_KEYS.slice();
      if (settings.apple != null) keys.push("apple");
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (settings[key] == null) continue;
        const idx = Number(settings[key]);
        if (Number.isNaN(idx)) continue;
        selectMenu(key, idx);
      }
      if (settings.size != null) {
        forceEngineSizeForPlay(settings.size);
      }
      forceEngineMatchFieldsForPlay(settings);
      // Persist so a later settings restore cannot re-bake Standard
      try {
        const saved =
          root.pudding_settings && root.pudding_settings.SavedGameSettings;
        if (saved && typeof saved === "object") {
          SYNC_KEYS.forEach(function (k) {
            if (settings[k] != null) saved[k] = Number(settings[k]);
          });
          if (settings.apple != null) saved.apple = Number(settings.apple);
        }
      } catch (eSave) { /* ignore */ }
    } finally {
      root.__mpApplyingSettings = false;
    }
    return settingsMatchLocal(settings);
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
    // Don't yank the settings panel open while a co-op/race run is starting
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

  /**
   * Stock face atlases are baked once via a7("#5282F2", Sc) at Play. Mid-run
   * Ready bumps that only stamp snake.Sc leave the eye-ring / cheek sprites on
   * the old tint — recolor those hosts whenever the live claimable color moves.
   */
  const FACE_SPRITE_BASE = "#5282F2";

  function normalizeHex(hex) {
    if (typeof hex !== "string" || !hex) return null;
    let s = hex.trim();
    if (s.charAt(0) !== "#") s = "#" + s;
    if (s.length === 4) {
      s =
        "#" +
        s.charAt(1) +
        s.charAt(1) +
        s.charAt(2) +
        s.charAt(2) +
        s.charAt(3) +
        s.charAt(3);
    }
    return s.toUpperCase();
  }

  /**
   * Face sprite sheets live on P5E (blink/eat/die/…). X5E stores that as
   * `.Ga` and sets `window.__slotFaceRef`; alterSnake hooks wrap P5E itself
   * via `__mpCoopRenderEnter`, so the "renderer" may already BE P5E.
   */
  function resolveFaceSheetRoot(renderer) {
    if (root.__slotFaceRef && root.__slotFaceRef.oa) return root.__slotFaceRef;
    const r = renderer || root.__mpCoopPlayerRenderer;
    if (r && r.oa && r.Aa && r.wb) return r;
    if (r && r.Ga && r.Ga.oa && r.Ga.Aa) return r.Ga;
    return null;
  }

  function playerFaceGa(renderer) {
    return resolveFaceSheetRoot(renderer);
  }

  function resolvePlayerRenderer() {
    return root.__mpCoopPlayerRenderer || null;
  }

  function faceSheetHosts(faceRoot) {
    if (!faceRoot) return [];
    return [
      faceRoot.oa,
      faceRoot.Aa,
      faceRoot.Ba,
      faceRoot.Ga,
      faceRoot.Ma,
      faceRoot.Ja,
      faceRoot.Sa,
      faceRoot.Qa,
      faceRoot.wa,
      faceRoot.Oa,
      faceRoot.Ka,
    ].filter(Boolean);
  }

  function recolorFaceHosts(Ga, fromHex, toHex) {
    const a7 = root.__slotA7;
    if (typeof a7 !== "function" || !Ga) return false;
    const from = normalizeHex(fromHex);
    const to = normalizeHex(toHex);
    if (!from || !to || from === to) return from === to;
    const hosts = faceSheetHosts(Ga);
    let any = false;
    for (let i = 0; i < hosts.length; i++) {
      try {
        a7(hosts[i], from, to);
        any = true;
      } catch (eA7) {
        /* sprite host may still be loading */
      }
    }
    return any;
  }

  /**
   * Retint PlayerRenderer face sprites to `toHex`. Tries the tracked tint, the
   * previous Sc, and the stock base so default-blue (untinted atlas) Ready bumps
   * still recolor the eye ring.
   */
  function tintLiveFaceSprites(toHex, fromHints, renderer) {
    const to = normalizeHex(toHex);
    if (!to) return false;
    const Ga = playerFaceGa(renderer || resolvePlayerRenderer());
    if (!Ga) return false;
    const hints = [];
    function pushHint(h) {
      const n = normalizeHex(h);
      if (!n || hints.indexOf(n) >= 0) return;
      hints.push(n);
    }
    pushHint(root.__mpFaceTintSc);
    if (fromHints) {
      for (let i = 0; i < fromHints.length; i++) pushHint(fromHints[i]);
    }
    pushHint(FACE_SPRITE_BASE);
    let any = false;
    for (let i = 0; i < hints.length; i++) {
      if (hints[i] === to) continue;
      if (recolorFaceHosts(Ga, hints[i], to)) any = true;
    }
    root.__mpFaceTintSc = to;
    return any;
  }

  function applySnakeColor(colorId) {
    if (colorId == null || colorId === 46) return false;
    root.__mpApplyingColor = true;
    let ok = false;
    try {
      ok = selectMenu("color", Number(colorId));
      // Mid-run / post-Ready bumps: menu select alone may not repaint the live
      // snake — stamp Sc/Yc from the claimable palette onto the engine snake.
      try {
        const Colors = root.MultiplayerColors;
        const c =
          Colors && Colors.getColor ? Colors.getColor(Number(colorId)) : null;
        const g = gameInstance && gameInstance();
        const snake = g && g.oa;
        if (snake && c) {
          const prevSc = snake.Sc;
          if (c.kind === "rainbow" && c.set && c.set.length) {
            snake.Sc = c.set[0];
            snake.Yc = c.set[1] || c.set[0];
          } else if (c.primary) {
            snake.Sc = c.primary;
            snake.Yc = c.secondary || c.primary;
          }
          const cfg = g.snakeBodyConfig;
          if (cfg) {
            if (snake.Sc) cfg.color2 = cfg.primary = snake.Sc;
            if (snake.Yc) cfg.color1 = cfg.secondary = snake.Yc;
          }
          // Keep settings.wa in sync so stock paths that read the color index
          // (and future Play restarts) match the Ready-claimed id.
          const settings = g.settings;
          if (settings && colorId != null) {
            const id = Number(colorId);
            if (Number.isFinite(id)) {
              if ("wa" in settings) settings.wa = id;
              if ("Ja" in settings) settings.Ja = id;
              if ("Jb" in settings) settings.Jb = id;
              if ("kc" in settings) settings.kc = id;
            }
          }
          tintLiveFaceSprites(snake.Sc, [prevSc, FACE_SPRITE_BASE]);
          ok = true;
        }
      } catch (eStamp) {
        /* ignore stamp failures — menu select may still have worked */
      }
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
    overlay.style.pointerEvents = "";
    const menu = overlay.children && overlay.children[0];
    if (menu) {
      menu.style.visibility = "";
      menu.style.pointerEvents = "";
    }
  }

  /**
   * After Start-match Play: dismiss end overlay without sticky restore state.
   * (showDeathScreen's inline visible:1 was trapping non-admins on the endscreen.)
   * pointer-events:none while hidden — a full-bleed invisible overlay must not
   * steal clicks from settings if quit fails to restore visibility.
   */
  function dismissDeathOverlayForRun() {
    clearDeathOverlayOverrides();
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay) return;
    overlay.style.visibility = "hidden";
    overlay.style.opacity = "0";
    overlay.style.pointerEvents = "none";
    const menu = overlay.children && overlay.children[0];
    if (menu) {
      menu.style.visibility = "hidden";
      menu.style.pointerEvents = "none";
    }
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

  /**
   * Classic apple reset (`aT`): base (floor(3w/4), floor(h/2)).
   * Mirrors server/src/coop.rs classic_initial_fruit + Tally (index 6 = 5a stock).
   */
  function classicInitialFruit(width, height, countIndex) {
    const w = Number(width) | 0;
    const h = Number(height) | 0;
    const idx = Number(countIndex);
    if (!(w > 0) || !(h > 0)) return [];
    const baseX = Math.floor((3 * w) / 4);
    const baseY = Math.floor(h / 2);
    function at(dx, dy) {
      return { x: baseX + dx, y: baseY + dy };
    }
    const ci = Number.isFinite(idx) && idx >= 0 ? idx | 0 : 0;
    if (ci === 0 || ci === 4 || ci === 5) return [at(0, 0)];
    if (ci === 1) return [at(0, 0), at(-2, -2), at(-2, 2)];
    if (ci === 2 || ci === 3 || ci === 6) {
      // 5a / Tally / 10a core — shift left like desktop Classic stock
      const pts = [at(0, 0), at(-2, -2), at(-2, 2), at(2, -2), at(2, 2)];
      const shift = w >= 20 ? 2 : 1;
      for (let i = 0; i < pts.length; i++) pts[i].x -= shift;
      return pts;
    }
    return [at(0, 0)];
  }

  function matchAppleType() {
    let t = readSettingIndex("apple");
    if (t == null && root.__mpCoopPlaySettings && root.__mpCoopPlaySettings.apple != null) {
      t = root.__mpCoopPlaySettings.apple;
    }
    if (t == null && root.__mpMatchPlaySettings && root.__mpMatchPlaySettings.apple != null) {
      t = root.__mpMatchPlaySettings.apple;
    }
    t = Number(t);
    return Number.isFinite(t) && t >= 0 ? t | 0 : 0;
  }

  /**
   * Ensure g.wa.ka exists with at least one Od-like template so clones work.
   * Does not leave a (0,0) apple as the final board — plantClassicInitialFruit replaces.
   */
  function ensureFruitHostTemplate(g) {
    g = g || gameInstance();
    if (!g) return false;
    try {
      if (!g.wa) g.wa = {};
      if (!Array.isArray(g.wa.ka)) g.wa.ka = [];
      for (let i = 0; i < g.wa.ka.length; i++) {
        const a = g.wa.ka[i];
        if (a && a.pos && typeof a.pos.clone === "function") return true;
      }
      let pos = null;
      if (root._ && typeof root._.Od === "function") {
        try {
          pos = new root._.Od(-1, -1);
        } catch (eOd) {
          pos = null;
        }
      }
      if (!pos || typeof pos.clone !== "function") {
        pos = {
          x: -1,
          y: -1,
          clone: function () {
            return { x: this.x, y: this.y, clone: this.clone };
          },
        };
      }
      g.wa.ka.push({ pos: pos, type: matchAppleType() });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Plant Classic aT fruit for the live Count index (all modes incl. Tally).
   * Replaces dummy templates. Sets admin apple type + tally sequenceNumbers.
   */
  function plantClassicInitialFruit(gIn) {
    if (root.__mpCoopServerAuth) return false;
    const g = gIn || gameInstance();
    if (!g) return false;
    if (!ensureFruitHostTemplate(g)) return false;
    const live = boardSizeFromGame(g) || {};
    const w = Number(live.width) | 0;
    const h = Number(live.height) | 0;
    if (!(w > 0) || !(h > 0)) return false;
    let countIdx = readSettingIndex("count");
    if (countIdx == null && root.__mpCoopPlaySettings) {
      countIdx = root.__mpCoopPlaySettings.count;
    }
    countIdx = Number(countIdx);
    if (!Number.isFinite(countIdx) || countIdx < 0) countIdx = 0;
    countIdx = countIdx | 0;
    const appleType = matchAppleType();
    let pts = classicInitialFruit(w, h, countIdx);
    // 10a: fill to 10 free cells after 5a stock
    const want =
      countIdx === 3
        ? 10
        : countIdx === 6
          ? 5
          : countIdx === 1
            ? 3
            : countIdx === 2
              ? 5
              : 1;
    const occ = coopOccupiedCells(g);
    // Clear snake marks from occ for fruit plant — only walls matter for stock
    // (snakes already seated; skip occupied)
    const placed = [];
    for (let i = 0; i < pts.length && placed.length < want; i++) {
      const p = pts[i];
      if (!p) continue;
      const key = (p.x | 0) + "," + (p.y | 0);
      if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue;
      if (occ[key]) continue;
      placed.push({ x: p.x | 0, y: p.y | 0 });
      occ[key] = 1;
    }
    while (placed.length < want) {
      let found = null;
      for (let y = 0; y < h && !found; y++) {
        for (let x = 0; x < w; x++) {
          if (!occ[x + "," + y]) {
            found = { x: x, y: y };
            break;
          }
        }
      }
      if (!found) break;
      placed.push(found);
      occ[found.x + "," + found.y] = 1;
    }
    if (!placed.length) return false;
    let template = null;
    for (let t = 0; t < g.wa.ka.length; t++) {
      if (g.wa.ka[t] && g.wa.ka[t].pos && typeof g.wa.ka[t].pos.clone === "function") {
        template = g.wa.ka[t];
        break;
      }
    }
    g.wa.ka.length = 0;
    for (let i = 0; i < placed.length; i++) {
      const fruit = {};
      if (template) {
        try {
          Object.keys(template).forEach(function (k) {
            if (
              k === "pos" ||
              k === "He" ||
              k === "CAb" ||
              k === "iL" ||
              k === "nba" ||
              k === "Oba" ||
              k === "sequenceNumber"
            ) {
              return;
            }
            fruit[k] = template[k];
          });
        } catch (eC) { /* ignore */ }
      }
      fruit.pos = makeNativePoint(
        placed[i].x,
        placed[i].y,
        template && template.pos
      );
      fruit.type = appleType;
      if (fruit.nba == null) fruit.nba = new Set();
      if (countIdx === 6) {
        fruit.sequenceNumber = i + 1;
        fruit.Lh = (i + 1) % 2 === 1;
      }
      g.wa.ka.push(fruit);
    }
    try {
      if (countIdx === 6 && typeof root.retallyAllPlacedApples === "function") {
        root.retallyAllPlacedApples();
      }
    } catch (eTall) { /* ignore */ }
    return g.wa.ka.length > 0;
  }

  /**
   * When Ma()/Sna() never ran (Play path skipped), stamp live board dims so
   * boardSizeFromGame matches settings.size (Small→10×9).
   */
  function forceLiveBoardDims(sizeIndex) {
    const dims = boardDimsForSizeIndex(sizeIndex);
    if (!dims || !(dims.width > 0) || !(dims.height > 0)) return false;
    forceEngineSizeForPlay(sizeIndex);
    const g = gameInstance();
    if (!g) return false;
    let wrote = false;
    function stampOrReplace(holder, key) {
      if (!holder) return;
      try {
        const meta = holder[key];
        if (meta && typeof meta === "object") {
          try {
            meta.width = dims.width;
            meta.height = dims.height;
            wrote = true;
          } catch (eAssign) {
            /* fall through to replace */
          }
        }
        if (
          !meta ||
          Number(meta.width) !== dims.width ||
          Number(meta.height) !== dims.height
        ) {
          if (root._ && typeof root._.Vd === "function") {
            holder[key] = new root._.Vd(dims.width, dims.height);
          } else {
            holder[key] = { width: dims.width, height: dims.height };
          }
          wrote = true;
        }
      } catch (e) { /* ignore */ }
    }
    try {
      if (g.oa) stampOrReplace(g.oa, "oa");
      if (g.wa && g.wa.oa) stampOrReplace(g.wa.oa, "oa");
      if (g.wa) stampOrReplace(g.wa, "oa");
      if (g.wb && g.wb.ka) stampOrReplace(g.wb.ka, "oa");
      if (g.ka) stampOrReplace(g.ka, "oa");
      // Wall grid often drives boardSizeFromGame fallback — resize to match
      if (g.Ca && Array.isArray(g.Ca.wa)) {
        const next = [];
        for (let y = 0; y < dims.height; y++) {
          next[y] = [];
          for (let x = 0; x < dims.width; x++) {
            next[y][x] =
              g.Ca.wa[y] && g.Ca.wa[y][x] != null ? g.Ca.wa[y][x] : 0;
          }
        }
        g.Ca.wa = next;
        wrote = true;
      }
    } catch (eG) { /* ignore */ }
    const live = boardSizeFromGame(g);
    if (
      live &&
      live.width === dims.width &&
      live.height === dims.height
    ) {
      try {
        root.__mpForceLiveBoardDims = dims.width + "x" + dims.height;
      } catch (eFlag) { /* ignore */ }
      // Ma/Sna skipped — plant Classic aT so owner scrape is not empty/(0,0)
      try {
        plantClassicInitialFruit(g);
      } catch (eFruit) { /* ignore */ }
      try {
        root.__mpForceLiveBoardDims = dims.width + "x" + dims.height;
        // Last-resort visual: shrink cell when still on Standard-ish tiles
        const cellHost =
          (g.wb && g.wb.ka) || g.ka || (g.oa && g.oa.wb && g.oa.wb.ka) || null;
        if (cellHost && typeof cellHost === "object" && sizeIndex === 1) {
          const cur = Number(cellHost.ka);
          // Standard tiles are typically larger; Small Sna uses ~area/96
          if (Number.isFinite(cur) && cur > 40) {
            cellHost.ka = Math.max(24, Math.round(cur * (96 / 256)));
            wrote = true;
          }
        }
      } catch (eCell) { /* ignore */ }
      return true;
    }
    return !!wrote;
  }

  /**
   * Find the native controller that owns Ma()/Sna() and force a size bake.
   * Play's button path sometimes skips Ma when the multiplayer chrome owns the
   * click — calling Ma (then Sna if needed) after stamping Sa/Aa is the path.
   */
  function findPlayController() {
    if (
      root.__mpPlayController &&
      typeof root.__mpPlayController.Ma === "function" &&
      root.__mpPlayController.settings
    ) {
      return root.__mpPlayController;
    }
    const seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;
    const queue = [];
    function enqueue(o) {
      if (!o || typeof o !== "object") return;
      try {
        if (seen) {
          if (seen.has(o)) return;
          seen.add(o);
        }
      } catch (eSeen) {
        return;
      }
      queue.push(o);
    }
    enqueue(root.__mpPlayController);
    enqueue(root._puddingSnakeMenu);
    enqueue(root.megaWholeSnakeObject);
    enqueue(root.wholeSnakeObject);
    enqueue(root.__mpGame);
    enqueue(root.__remixGame);
    try {
      const keys = Object.keys(root);
      for (let i = 0; i < keys.length && i < 120; i++) {
        const k = keys[i];
        if (!k || k.indexOf("__") === 0 && k.indexOf("__mp") !== 0 && k.indexOf("__remix") !== 0) {
          /* still enqueue common hosts */
        }
        try {
          const v = root[k];
          if (v && typeof v === "object" && typeof v.Ma === "function") enqueue(v);
        } catch (eK) { /* ignore */ }
      }
    } catch (eWin) { /* ignore */ }
    try {
      const g = gameInstance();
      enqueue(g);
      if (g) {
        enqueue(g.wb);
        enqueue(g.menu);
      }
    } catch (eG) { /* ignore */ }
    try {
      const menu = root._puddingSnakeMenu;
      if (menu) {
        enqueue(menu.wb);
        enqueue(menu.oa);
        enqueue(menu.controller);
        enqueue(menu.game);
      }
    } catch (eMenu) { /* ignore */ }
    let found = null;
    let withSna = null;
    for (let i = 0; i < queue.length && i < 128; i++) {
      const o = queue[i];
      try {
        if (
          o &&
          typeof o.Ma === "function" &&
          o.settings &&
          typeof o.settings === "object"
        ) {
          if (!found) found = o;
          if (typeof o.Sna === "function") {
            withSna = o;
            break;
          }
        }
        if (o) {
          enqueue(o.wb);
          enqueue(o.menu);
          enqueue(o.oa);
          enqueue(o.Ha);
          enqueue(o.controller);
          enqueue(o.game);
          enqueue(o.parent);
        }
      } catch (eWalk) { /* ignore */ }
    }
    const pick = withSna || found;
    if (pick) {
      try {
        root.__mpPlayController = pick;
      } catch (eCap) { /* ignore */ }
    }
    return pick;
  }

  function forceNativePlayBake(settings) {
    if (settings) {
      forceMatchSettingsForPlay(settings);
      forceEngineMatchFieldsForPlay(settings);
    }
    const want =
      settings && settings.size != null ? Number(settings.size) | 0 : null;
    const found = findPlayController();
    if (!found) return false;
    try {
      if (want != null) {
        found.settings.Sa = want;
        found.settings.Aa = want;
        forceEngineSizeForPlay(want);
      }
      root.__mpForceSaBeforeAa = 1;
      try {
        root.__mpPlayController = found;
      } catch (eCap) { /* ignore */ }
      let ranSna = false;
      try {
        found.Ma();
      } catch (eMa) {
        console.warn("[Multiplayer] forceNativePlayBake Ma failed", eMa);
      }
      // Ma may no-op if chrome gate still closed — call Sna directly after Aa stamp
      const liveOk =
        want == null ||
        (typeof liveBoardMatchesSettings === "function" &&
          liveBoardMatchesSettings(
            settings || { size: want }
          ));
      if (!liveOk && typeof found.Sna === "function") {
        try {
          found.settings.Aa = want != null ? want : found.settings.Sa;
          found.Sna();
          ranSna = true;
          root.__mpForceSnaRan = 1;
        } catch (eSna) {
          console.warn("[Multiplayer] forceNativePlayBake Sna failed", eSna);
        }
      } else if (liveOk) {
        root.__mpForceSnaRan = root.__mpForceSnaRan || 1;
        ranSna = true;
      }
      return !!(
        liveOk ||
        ranSna ||
        (want != null &&
          found.settings &&
          Number(found.settings.Aa) === want)
      );
    } catch (eAll) {
      console.warn("[Multiplayer] forceNativePlayBake failed", eAll);
      return false;
    }
  }

  /** Close menus; do NOT force-show death (inline styles trap the endscreen). */
  function prepareNativePlay() {
    closeSettingsPanel();
    clearDeathOverlayOverrides();
    setLocalPaused(false);
    // Settings restored from storage (or already matching a SETTINGS_SYNC) never
    // pass through the native trophy handler, so reconcile before Play instead of
    // only when we change the row — mode predicates read this at apple reset.
    syncCurrentModeNum(readSettingIndex("trophy"));
  }

  /**
   * Start a native Play run once the death/menu chrome is up.
   * Cancellable via bumping __mpStartNativeRunGen (SESSION_END / abort).
   * Keep attempts low — nested 80× Play spam felt like an infinite spawn loop.
   * @param {{maxAttempts?:number,intervalMs?:number,onDone?:function(boolean),requirePlayClick?:boolean,deferTimer?:boolean}} opts
   */
  function startNativeRun(opts) {
    opts = opts || {};
    const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 12;
    const intervalMs = opts.intervalMs != null ? opts.intervalMs : 50;
    const onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    const requirePlayClick = opts.requirePlayClick === true;
    const deferTimer = opts.deferTimer === true;
    const keepSettingsOpen = opts.keepSettingsOpen === true;
    const gen = (root.__mpStartNativeRunGen = (root.__mpStartNativeRunGen | 0) + 1);
    root.__mpStartingMatch = true;
    root.__mpApplySettingsGen = (root.__mpApplySettingsGen || 0) + 1;
    if (requirePlayClick) root.__mpFocusRequirePlay = true;
    if (keepSettingsOpen) {
      clearDeathOverlayOverrides();
      setLocalPaused(false);
      syncCurrentModeNum(readSettingIndex("trophy"));
    } else {
      prepareNativePlay();
    }
    if (typeof installFirstRunControlTipGuard === "function") {
      installFirstRunControlTipGuard();
    } else {
      hideControlHelper();
    }
    let attempts = 0;
    let playClicks = 0;
    function finish(ok) {
      if (ok) {
        dismissDeathOverlayForRun();
        if (requirePlayClick) root.__mpFocusRequirePlay = false;
        if (deferTimer && root.timeKeeper) {
          try {
            root.timeKeeper.playing = false;
            root.timeKeeper._lastTimeMs = 0;
          } catch (e3) { /* ignore */ }
        }
      }
      if (typeof setTimeout === "function") {
        setTimeout(function () {
          if (gen === root.__mpStartNativeRunGen) {
            root.__mpStartingMatch = false;
          }
        }, 400);
      } else if (gen === root.__mpStartNativeRunGen) {
        root.__mpStartingMatch = false;
      }
      if (onDone) onDone(ok);
    }
    function tick() {
      if (gen !== root.__mpStartNativeRunGen) {
        // Cancelled (SESSION_END / newer Start) — do not call onDone(true)
        if (onDone) onDone(false);
        return;
      }
      attempts++;
      try {
        const needClick =
          !isNativeRunLive() || (requirePlayClick && playClicks < 1);
        if (needClick) {
          if (!keepSettingsOpen) closeSettingsPanel();
          clearDeathOverlayOverrides();
          // Re-stamp Sa/Aa (etc.) immediately before Play — Ma() copies Sa→Aa
          try {
            const forceSettings =
              root.__mpCoopPlaySettings || root.__mpMatchPlaySettings;
            if (
              forceSettings &&
              typeof forceEngineMatchFieldsForPlay === "function"
            ) {
              forceEngineMatchFieldsForPlay(forceSettings);
            } else if (
              forceSettings &&
              forceSettings.size != null &&
              typeof forceEngineSizeForPlay === "function"
            ) {
              forceEngineSizeForPlay(forceSettings.size);
            }
          } catch (eSz) { /* ignore */ }
          if (triggerPlay()) playClicks++;
          // After several clicks, force-clear dead flag if Play didn't (some skins)
          if (attempts >= 8 && root.timeKeeper && root.timeKeeper._dead) {
            root.timeKeeper._dead = false;
            if (!deferTimer && typeof root.timeKeeper.start === "function") {
              try {
                root.timeKeeper.start();
              } catch (e2) { /* ignore */ }
            }
          }
        }
        if (root.timeKeeper && !root.timeKeeper._dead) {
          dismissDeathOverlayForRun();
        }
      } catch (e) { /* ignore */ }
      // Same-turn seat as soon as Play creates oa — before rAF paints center.
      // Native-relay uses the same hook (visual paint ± hard lock); not server-auth only.
      if (
        isNativeRunLive() &&
        typeof root.__mpCoopSeatOnPlayLive === "function" &&
        (root.__mpCoopServerAuth ||
          root.__mpCoopInject ||
          root.__mpCoopSession)
      ) {
        try {
          root.__mpCoopSeatOnPlayLive();
        } catch (eSeat) { /* ignore */ }
      } else if (
        root.__mpCoopServerAuth &&
        isNativeRunLive() &&
        root.CoopBinder &&
        typeof root.CoopBinder.reapplyLastState === "function"
      ) {
        try {
          root.CoopBinder.reapplyLastState();
        } catch (eRe) { /* ignore */ }
      }
      const live = isNativeRunLive() && playClicks >= 1;
      if (live || attempts >= maxAttempts) {
        finish(!!live);
        return;
      }
      setTimeout(tick, intervalMs);
    }
    setTimeout(tick, 0);
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

  /**
   * Live in-game run clock: ticks × tick length (Fb), same as TimeKeeper hooks.
   * Falls back to resetTime wall elapsed, then last apple/death sample.
   */
  function readLiveRunTimeMs(game) {
    const g = game || gameInstance();
    try {
      if (g && typeof g.ticks === "number" && typeof g.Fb === "number") {
        const ms = Math.floor(Number(g.ticks) * Number(g.Fb));
        if (Number.isFinite(ms) && ms >= 0) return ms;
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof root.resetTime === "number" && root.resetTime > 0) {
        const ms = Date.now() - root.resetTime;
        if (Number.isFinite(ms) && ms >= 0) return ms;
      }
    } catch (e2) { /* ignore */ }
    return null;
  }

  function readScoreAndAlive() {
    const g = gameInstance();
    let score = 0;
    let alive = true;
    let timeMs = 0;
    if (g) {
      score = firstNumber(g.Sh, g.Oh, g.score, g.appleCount) | 0;
      if (g.nj || g.dead || g.isDead) alive = false;
    }
    if (root.timeKeeper) {
      // Co-op blocks TK gotApple sampling, so _lastScore can stick at 0 while
      // g.Sh advances — never let a stale TK sample wipe the live engine score.
      if (typeof root.timeKeeper._lastScore === "number") {
        score = Math.max(score, root.timeKeeper._lastScore | 0);
      }
      if (typeof root.timeKeeper._lastTimeMs === "number") timeMs = root.timeKeeper._lastTimeMs;
      if (root.timeKeeper._dead) alive = false;
      if (typeof root.timeKeeper.lastAppleTime === "number") {
        timeMs = timeMs || root.timeKeeper.lastAppleTime;
      }
    }
    // Prefer the engine's live run clock while the snake is still playing —
    // _lastTimeMs only updates on apple/death and freezes mosaic timers.
    if (alive !== false) {
      const live = readLiveRunTimeMs(g);
      if (live != null) timeMs = live;
    }
    return { score: score, timeMs: timeMs, alive: alive };
  }

  /**
   * Dimension mode tracks the snake's dimension per segment in `snake.wa`, an
   * array parallel to `snake.ka` — the body points themselves carry no `Lh`.
   * A truthy flag means that segment sits in the dimension the board is
   * currently showing; falsy means the engine fades it to the ghost alpha.
   *
   * Both arrays are kept in step: a normal step unshifts `true`, a step through
   * a portal unshifts `false`, the tail pops off both, and a swap inverts every
   * flag at once. So after a portal the head leads a solid run while the tail
   * drains out as a ghost run, which is the split mosaic has to draw.
   */
  function snakeDimFlags(snake) {
    if (!snake) return null;
    const flags = snake.wa;
    if (!Array.isArray(flags) || !flags.length) return null;
    // Board occupancy grids also live on a `wa` — those are arrays of rows
    if (Array.isArray(flags[0])) return null;
    if (!boardHasMode({ modeKey: scrapeModeKey() }, "dimension")) return null;
    return flags;
  }

  function mapBody(arr, dimFlags) {
    if (!Array.isArray(arr)) return [];
    const dims = Array.isArray(dimFlags) ? dimFlags : null;
    return arr.map(function (p, i) {
      if (!p) return { x: 0, y: 0 };
      const pt = p.pos && (p.pos.x != null || p.pos.y != null) ? p.pos : p;
      const out = {
        x: pt.x != null ? pt.x : 0,
        y: pt.y != null ? pt.y : 0,
      };
      if (dims && i < dims.length) {
        if (!dims[i]) out.otherDim = true;
        return out;
      }
      // No flag array (spectator inject, replayed pose): fall back to a tag on
      // the point itself, the way every other entity carries it.
      const lh =
        p.Lh != null
          ? p.Lh
          : p.Gh != null
            ? p.Gh
            : pt.Lh != null
              ? pt.Lh
              : pt.Gh;
      if (lh === false || p.otherDim) out.otherDim = true;
      return out;
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

  /**
   * Stock P5E draws the rounded tip using Ya as a virtual point *past* the last
   * ka cell (qc holds the deferred copy during grow). Co-op writeNativeBody must
   * refresh Ya/qc or the cap glitches toward a stale beyond-tip.
   */
  function syncNativeTailVirtual(snake) {
    if (!snake || !Array.isArray(snake.ka) || !snake.ka.length) return false;
    const tip = snake.ka[snake.ka.length - 1];
    if (!tip) return false;
    const tx = Math.round(Number(tip.x));
    const ty = Math.round(Number(tip.y));
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return false;

    let dx = 0;
    let dy = 0;
    if (snake.ka.length >= 2) {
      const neck = snake.ka[snake.ka.length - 2];
      const nx = Math.round(Number(neck && neck.x));
      const ny = Math.round(Number(neck && neck.y));
      if (Number.isFinite(nx) && Number.isFinite(ny)) {
        dx = tx - nx;
        dy = ty - ny;
      }
    }
    if (dx === 0 && dy === 0) {
      const d = String(snake.direction || snake.dir || snake.Ca || "RIGHT").toUpperCase();
      if (d === "LEFT") {
        dx = -1;
        dy = 0;
      } else if (d === "UP") {
        dx = 0;
        dy = -1;
      } else if (d === "DOWN") {
        dx = 0;
        dy = 1;
      } else {
        dx = 1;
        dy = 0;
      }
    } else if (Math.abs(dx) >= Math.abs(dy)) {
      dx = dx > 0 ? 1 : -1;
      dy = 0;
    } else {
      dx = 0;
      dy = dy > 0 ? 1 : -1;
    }

    const bx = tx + dx;
    const by = ty + dy;
    function assignVirtual(key) {
      const cur = snake[key];
      if (cur && typeof cur.clone === "function") {
        cur.x = bx;
        cur.y = by;
        return;
      }
      if (cur && typeof cur === "object") {
        cur.x = bx;
        cur.y = by;
        if (typeof cur.clone !== "function") {
          cur.clone = function () {
            return makeNativePoint(this.x, this.y, tip);
          };
        }
        return;
      }
      snake[key] = makeNativePoint(bx, by, tip);
    }
    assignVirtual("Ya");
    if (snake.qc != null || Object.prototype.hasOwnProperty.call(snake, "qc")) {
      assignVirtual("qc");
    }
    return true;
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
    // Dimension flags (snake.wa) are parallel to ka — keep lengths matched so
    // tick never indexes a stale shorter array after a co-op seat rewrite.
    try {
      ensureSnakeSegmentFlags(snake);
    } catch (eWa) { /* ignore */ }
    try {
      syncNativeTailVirtual(snake);
    } catch (eYa) { /* ignore */ }
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
      let shields = null;
      if (a) {
        if (a.type != null) type = a.type;
        else if (a.kind != null) type = a.kind;
        else if (a.Xa != null) type = a.Xa;
        else if (a.oa != null && typeof a.oa !== "object") type = a.oa;
        if (a.Oka || a.nla || a.poison) poison = true;
        // Shield mode: nba is a Set of directions covering that fruit
        const nba = a.nba;
        if (nba && typeof nba.has === "function") {
          const dirs = [];
          ["UP", "DOWN", "LEFT", "RIGHT"].forEach(function (d) {
            try {
              if (nba.has(d)) dirs.push(d);
            } catch (eDir) { /* ignore */ }
          });
          // Always emit an array (possibly empty) so peers keep a real Set
          shields = dirs;
        } else if (Array.isArray(nba)) {
          shields = nba.map(String);
        } else if (Array.isArray(a.shields)) {
          shields = a.shields.map(String);
        }
      }
      // Chess mode: piece identity sits on the fruit object
      let isPiece = undefined;
      let chessPiece = undefined; // "pawn" | "knight" | "bishop" | "rook" | "queen" | "king"
      let chessColor = undefined; // "w" | "b"
      if (a.isPiece) {
        isPiece = true;
        if (a.ChessPiece) chessPiece = String(a.ChessPiece);
        if (a.ChessColor) chessColor = String(a.ChessColor);
      }
      // Slot Machine: the mode badge this fruit activates when eaten. Native
      // badges only ordinary fruit — never poison hazards or chess pieces.
      let slotMode = undefined;
      if (a && a.slotMode != null && !isPiece && !poison) {
        const sm = Number(a.slotMode);
        if (Number.isFinite(sm)) slotMode = sm | 0;
      }
      // Winged/Magnet: fractional velocity He — seed peers once, then trust local sim
      let he = undefined;
      if (a && a.He && typeof a.He.x === "number" && typeof a.He.y === "number") {
        he = { x: Number(a.He.x), y: Number(a.He.y) };
      } else if (a && a.he && typeof a.he.x === "number") {
        he = { x: Number(a.he.x), y: Number(a.he.y) };
      }
      return {
        x: pos.x != null ? pos.x : 0,
        y: pos.y != null ? pos.y : 0,
        type: type,
        poison: poison || undefined,
        shields: shields != null ? shields : undefined,
        isPiece: isPiece,
        chessPiece: chessPiece,
        chessColor: chessColor,
        slotMode: slotMode,
        he: he,
        // Light mode: apple.light radius in tiles (native spawn 1.5, decays)
        light:
          a.light != null && Number.isFinite(Number(a.light))
            ? Number(a.light)
            : undefined,
        // Burger: ticks until this fruit rots into poison
        burgerTimer:
          a.burgerTimer != null && Number.isFinite(Number(a.burgerTimer))
            ? Number(a.burgerTimer) | 0
            : undefined,
        burgerTimerMax:
          a.burgerTimerMax != null && Number.isFinite(Number(a.burgerTimerMax))
            ? Number(a.burgerTimerMax) | 0
            : undefined,
        burgerGrey:
          a.burgerGrey != null && Number.isFinite(Number(a.burgerGrey))
            ? Number(a.burgerGrey)
            : undefined,
        // Dimension: Lh/Gh false = other dimension (ghost fruit)
        otherDim:
          a.Lh === false || a.Gh === false || a.otherDim
            ? true
            : undefined,
      };
    });
  }

  /**
   * Bomb Fruit danger zones. Native tracks these per cell rather than per fruit
   * (window.__bombFruitZones), so a fruit only ever plants a zone and eating or
   * moving it leaves the zone behind — the mosaic has to read the zone list too.
   * arm -1 is an idle dashed ring; >= 0 is an armed countdown toward the boom.
   */
  function scrapeBombZones() {
    const out = [];
    let list = null;
    try {
      if (typeof root.bombFruit_zones === "function") {
        list = root.bombFruit_zones();
      }
    } catch (eFn) { /* ignore */ }
    if (!Array.isArray(list)) list = root.__bombFruitZones;
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      if (!z || z.x == null || z.y == null) continue;
      const x = Number(z.x);
      const y = Number(z.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push({
        x: x | 0,
        y: y | 0,
        arm: z.bombX1a != null ? Number(z.bombX1a) | 0 : -1,
      });
    }
    return out;
  }

  /**
   * Native light radii live on snake.Aa/Ba.light (floor 2) and apple.light
   * (spawn 1.5). Other entities stamp ~1-tile mask blobs.
   */
  function scrapeSnakeLights(g) {
    const out = { headLight: null, headLight2: null };
    const snake = g && g.oa;
    if (!snake) return out;
    function readLight(host) {
      if (!host || host.light == null) return null;
      const n = Number(host.light);
      return Number.isFinite(n) ? n : null;
    }
    try {
      const a = readLight(snake.Aa);
      if (a != null) out.headLight = a;
      else {
        const s = readLight(snake);
        if (s != null) out.headLight = s;
      }
    } catch (eA) { /* ignore */ }
    try {
      const b = readLight(snake.Ba);
      if (b != null) out.headLight2 = b;
    } catch (eB) { /* ignore */ }
    return out;
  }

  /** Push one {x,y[,…]} from a host value into out (returns true if added). */
  function pushMappedPoint(out, p, extra) {
    if (!p) return false;
    const pos = p.pos || p;
    if (pos.x == null || pos.y == null) return false;
    const pt = { x: Number(pos.x), y: Number(pos.y) };
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] != null) pt[k] = extra[k];
      });
    }
    out.push(pt);
    return true;
  }

  /**
   * Collect grid points from arrays, Maps, Sets, or 2D grids.
   * Native hosts often use Map/Set (Aa.oa boxes, Ya.oa statues, Ca.Aa walls).
   */
  function mapPointList(src) {
    const out = [];
    if (!src) return out;
    if (Array.isArray(src)) {
      // Either [{pos}|{x,y}, …] or a 2D numeric/truthy grid
      let looks2d = src.length > 0 && Array.isArray(src[0]);
      if (looks2d) {
        for (let y = 0; y < src.length; y++) {
          const row = src[y];
          if (!row) continue;
          for (let x = 0; x < row.length; x++) {
            const cell = row[x];
            if (cell && typeof cell === "object" && (cell.x != null || cell.pos)) {
              pushMappedPoint(out, cell);
            } else if (cell) {
              // Numeric wall grids: 0/3 = empty (native y4E)
              const v = cell | 0;
              if (typeof cell === "number" && (v === 0 || v === 3)) continue;
              out.push({ x: x, y: y });
            }
          }
        }
        return out;
      }
      src.forEach(function (p) {
        pushMappedPoint(out, p);
      });
      return out;
    }
    if (typeof src !== "object") return out;
    // Map / Set
    if (typeof src.forEach === "function" && src.size != null) {
      try {
        src.forEach(function (p) {
          pushMappedPoint(out, p);
        });
        if (out.length) return out;
      } catch (eIter) { /* fall through */ }
    }
    Object.keys(src).forEach(function (k) {
      const p = src[k];
      if (!p) return;
      if (p.x != null && p.y != null) {
        out.push({ x: p.x, y: p.y });
        return;
      }
      if (p.pos && p.pos.x != null) {
        pushMappedPoint(out, p);
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
   * Wall-mode freePos rejects cells that turn a board corner into a 1×1 dead
   * end: the two edge-adjacent tiles beside each corner. The corner cell itself
   * and the inward diagonal are legal wall spawns.
   *
   * Top-left example (illegal = X, legal corner/diagonal = ·):
   *   · X .
   *   X · .
   *   . . .
   */
  function isIllegalNormalWallCell(x, y, width, height) {
    const xi = Number(x) | 0;
    const yi = Number(y) | 0;
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) return true;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return false;
    // Top-left: (1,0) and (0,1)
    if ((xi === 1 && yi === 0) || (xi === 0 && yi === 1)) return true;
    // Top-right: (w-2,0) and (w-1,1)
    if ((xi === w - 2 && yi === 0) || (xi === w - 1 && yi === 1)) return true;
    // Bottom-left: (1,h-1) and (0,h-2)
    if ((xi === 1 && yi === h - 1) || (xi === 0 && yi === h - 2)) return true;
    // Bottom-right: (w-2,h-1) and (w-1,h-2)
    if ((xi === w - 2 && yi === h - 1) || (xi === w - 1 && yi === h - 2)) {
      return true;
    }
    return false;
  }

  /** Native wall Map key: (x << 16) | y — Remix mexico/tempWalls / p6E. */
  function wallSerialKey(x, y) {
    return ((Number(x) | 0) << 16) | ((Number(y) | 0) & 65535);
  }

  /**
   * Native wall grow (p6E) does `Ca.Aa.add(wall)` with no null check.
   * freePos / checkWall use `Aa.has(serial)` — must be a real Map, never {}.
   * Keep a Map (serial keys for scrape/write) and polyfill `.add` so p6E works.
   */
  function ensureNativeWallMap(wallHost) {
    if (!wallHost) return null;
    let map = wallHost.Aa;
    // Plain objects / arrays / null crash as "a.has is not a function"
    if (
      !map ||
      typeof map.forEach !== "function" ||
      typeof map.has !== "function" ||
      typeof map.set !== "function"
    ) {
      const prev = map;
      map = new Map();
      // Best-effort migrate array / object values that look like wall entries
      try {
        if (Array.isArray(prev)) {
          prev.forEach(function (obj) {
            if (!obj) return;
            const pos = obj.pos || obj;
            if (pos && pos.x != null && pos.y != null) {
              map.set(wallSerialKey(pos.x, pos.y), obj);
            }
          });
        } else if (prev && typeof prev === "object" && typeof prev.forEach !== "function") {
          Object.keys(prev).forEach(function (k) {
            const obj = prev[k];
            if (!obj) return;
            const pos = obj.pos || obj;
            if (pos && pos.x != null && pos.y != null) {
              map.set(wallSerialKey(pos.x, pos.y), obj);
            }
          });
        }
      } catch (eMig) { /* ignore */ }
      wallHost.Aa = map;
    }
    if (typeof map.add !== "function") {
      try {
        Object.defineProperty(map, "add", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: function (obj) {
            if (!obj) return this;
            const pos = obj.pos || obj;
            if (pos && pos.x != null && pos.y != null && typeof this.set === "function") {
              this.set(wallSerialKey(pos.x, pos.y), obj);
            }
            return this;
          },
        });
      } catch (eAdd) {
        map.add = function (obj) {
          if (!obj) return this;
          const pos = obj.pos || obj;
          if (pos && pos.x != null && pos.y != null && typeof this.set === "function") {
            this.set(wallSerialKey(pos.x, pos.y), obj);
          }
          return this;
        };
      }
    }
    return map;
  }

  /** Every fruit nba must be a real Set (or absent). Plain {} / arrays crash
   * freePos / eat as "a.has is not a function". Null is also unsafe on
   * some stock paths — normalize to Set. Also repair apple.pos.clone for
   * L3E.render after co-op freePos returns plain {x,y}.
   */
  function ensureFruitShieldSets(g) {
    try {
      const list = g && g.wa && g.wa.ka;
      if (!list || !list.length) return;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a) continue;
        if (a.nba == null) {
          a.nba = new Set();
        } else if (typeof a.nba.has !== "function") {
          a.nba = Array.isArray(a.nba) ? new Set(a.nba) : new Set();
        }
        if (a.pos != null && typeof a.pos.clone !== "function") {
          const px = a.pos.x != null ? a.pos.x : 0;
          const py = a.pos.y != null ? a.pos.y : 0;
          a.pos = makeNativePoint(px, py, null);
        }
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Native tick / y4E / p6E do `Ca.wa[y][x]` with no row guard.
   * Sparse or short grids → "Cannot read properties of undefined (reading '0')".
   */
  function ensureWallGridDense(wallHost, width, height) {
    if (!wallHost) return null;
    let grid = wallHost.wa;
    if (!Array.isArray(grid)) {
      grid = [];
      wallHost.wa = grid;
    }
    let w = width | 0;
    let h = height | 0;
    if (!(w > 0) || !(h > 0)) {
      if (grid.length && Array.isArray(grid[0])) {
        h = h > 0 ? h : grid.length;
        w = w > 0 ? w : grid[0].length;
      }
    }
    if (!(w > 0)) w = 17;
    if (!(h > 0)) h = 15;
    // Shrink when server board is smaller than a leftover Play grid
    if (grid.length > h) {
      grid.length = h;
    }
    while (grid.length < h) {
      const row = [];
      for (let x = 0; x < w; x++) row.push(0);
      grid.push(row);
    }
    for (let y = 0; y < h; y++) {
      let row = grid[y];
      if (!Array.isArray(row)) {
        row = [];
        grid[y] = row;
      }
      if (row.length > w) row.length = w;
      while (row.length < w) row.push(0);
    }
    return grid;
  }

  /**
   * Dimension / segment flags (`snake.wa`) stay parallel to `snake.ka`.
   * After apple growth, a missing or short flags array → tick `wa[0]` crash.
   */
  function ensureSnakeSegmentFlags(snake) {
    if (!snake || !Array.isArray(snake.ka)) return;
    const n = snake.ka.length;
    if (!Array.isArray(snake.wa) || (snake.wa.length && typeof snake.wa[0] !== "boolean")) {
      // Don't overwrite a wall-style nested grid accidentally assigned here
      if (Array.isArray(snake.wa) && snake.wa.length && Array.isArray(snake.wa[0])) {
        return;
      }
      snake.wa = [];
    }
    while (snake.wa.length > n) snake.wa.pop();
    while (snake.wa.length < n) snake.wa.push(true);
  }

  /** Repair all hosts native tick / freePos / wall-grow touch. */
  function ensureCoopTickHosts(g) {
    if (!g) return;
    try {
      if (g.Ca) {
        ensureNativeWallMap(g.Ca);
        let w = 0;
        let h = 0;
        try {
          const sz =
            (g.oa && g.oa.oa) ||
            (g.wa && g.wa.oa && g.wa.oa.oa) ||
            null;
          if (sz) {
            w = Number(sz.width) | 0;
            h = Number(sz.height) | 0;
          }
        } catch (eSz) { /* ignore */ }
        ensureWallGridDense(g.Ca, w, h);
      }
      ensureFruitShieldSets(g);
      if (g.oa) ensureSnakeSegmentFlags(g.oa);
      if (g.Ra) ensureSnakeSegmentFlags(g.Ra);
    } catch (e) { /* ignore */ }
  }

  /**
   * Drop scrape phantom walls that can never be real normal walls (1×1
   * dead-end edge cells). Keep temp/lock/hotdog, and keep real corner /
   * diagonal walls so mosaic matches the player's board.
   */
  function filterMosaicWalls(walls, width, height) {
    if (!walls || !walls.length) return walls || [];
    const w = width != null ? width : 17;
    const h = height != null ? height : 15;
    const out = [];
    for (let i = 0; i < walls.length; i++) {
      const p = walls[i];
      if (!p) continue;
      if (p.temp || p.__tempWall || p.lock || p.hotdog) {
        out.push(p);
        continue;
      }
      if (isIllegalNormalWallCell(p.x, p.y, w, h)) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * Real walls live on Ca.Aa (Map keyed by wallSerialKey). Ca.wa also holds
   * corner sentinel markers (value 2) that must never ship as walls — merging
   * them used to stamp huge wrong solids on every co-op client.
   */
  function scrapeWalls(g) {
    const out = [];
    const wallHost = g && g.Ca;
    if (!wallHost) return out;
    // Prefer live Ca.wa dims; meta only when the grid is missing (never silent 17×15).
    const meta =
      (g && g.wa && g.wa.oa && g.wa.oa.oa) ||
      (g && g.oa && g.oa.oa) ||
      (g && g.settings && g.settings.grid) ||
      {};
    let bw = null;
    let bh = null;
    try {
      const wa = wallHost.wa || wallHost.oa;
      if (Array.isArray(wa) && wa.length) {
        bw = wa[0] && wa[0].length;
        bh = wa.length;
      }
    } catch (eSz) { /* ignore */ }
    if (bw == null) {
      bw =
        firstNumber(meta.width, meta.W) ||
        (g && g.settings && (g.settings.width || g.settings.boardWidth)) ||
        (g && g.width) ||
        null;
    }
    if (bh == null) {
      bh =
        firstNumber(meta.height, meta.H) ||
        (g && g.settings && (g.settings.height || g.settings.boardHeight)) ||
        (g && g.height) ||
        null;
    }
    let result = out;
    try {
      const byKey = Object.create(null);
      function addWall(p) {
        if (!p || p.x == null || p.y == null) return;
        const key = (p.x | 0) + "," + (p.y | 0);
        const prev = byKey[key];
        if (!prev) {
          byKey[key] = p;
          return;
        }
        if (
          (p.lock || p.lockType != null || p.temp || p.hotdog) &&
          !(prev.lock || prev.lockType != null || prev.temp || prev.hotdog)
        ) {
          byKey[key] = p;
        }
      }
      try {
        const aa = wallHost.Aa;
        if (aa && typeof aa.forEach === "function") {
          aa.forEach(function (w) {
            if (!w) return;
            const pos = w.pos || w;
            if (pos.x == null || pos.y == null) return;
            const lockType =
              w.yNa != null && Number(w.yNa) >= 0
                ? Math.max(0, Math.min(23, Number(w.yNa) | 0))
                : w.XNa != null && Number(w.XNa) >= 0
                  ? Math.max(0, Math.min(23, Number(w.XNa) | 0))
                  : null;
            addWall({
              x: Number(pos.x),
              y: Number(pos.y),
              lock: lockType != null ? true : undefined,
              lockType: lockType,
              hotdog: !!(w.ty || w.ez) || undefined,
              temp: !!(w.__tempWall || w.temp) || undefined,
            });
          });
        }
      } catch (eAa) { /* ignore */ }
      // Exact grid solids (value 1) only — never corner sentinels (value 2) or
      // empty (0/3). Plain walls sometimes exist only on wa; locks live on Aa.
      try {
        const wa = wallHost.wa || wallHost.oa;
        if (Array.isArray(wa) && wa.length && Array.isArray(wa[0])) {
          for (let y = 0; y < wa.length; y++) {
            const row = wa[y];
            if (!row) continue;
            for (let x = 0; x < row.length; x++) {
              const cell = row[x];
              if (typeof cell === "object" && cell) continue;
              if ((cell | 0) !== 1) continue;
              addWall({ x: x, y: y });
            }
          }
        }
      } catch (eWa) { /* ignore */ }
      const merged = [];
      Object.keys(byKey).forEach(function (k) {
        merged.push(byKey[k]);
      });
      result = filterMosaicWalls(merged, bw, bh);
      return result;
    } catch (eScr) {
      return result;
    }
  }

  /** Keys with fruit type + marked keyblock cell (r7a). Type 0–23 matches key_types sheet. */
  function scrapeKeys(g) {
    const out = [];
    const keys = g && g.Ba && g.Ba.keys;
    if (!keys) return out;
    function add(k) {
      if (!k) return;
      const pos = k.pos || k;
      if (pos.x == null || pos.y == null) return;
      const pt = { x: Number(pos.x), y: Number(pos.y) };
      let type = k.type;
      if (type == null) type = k.yNa;
      if (type != null && Number.isFinite(Number(type))) {
        pt.type = Math.max(0, Math.min(23, Number(type) | 0));
      }
      const block = k.r7a || k.keyblock || k.lockPos;
      if (block && block.x != null && block.y != null) {
        pt.keyblock = {
          x: Number(block.x),
          y: Number(block.y),
          type: pt.type,
        };
      }
      out.push(pt);
    }
    try {
      if (typeof keys.forEach === "function" && keys.size != null) {
        keys.forEach(add);
        return out;
      }
    } catch (eMap) { /* ignore */ }
    if (Array.isArray(keys)) {
      for (let i = 0; i < keys.length; i++) add(keys[i]);
    }
    return out;
  }

  /** Minesweeper flags (+ xL when present for fade state). */
  function scrapeMines(g) {
    const out = [];
    const host = g && g.Ma && (g.Ma.oa || g.Ma.ka);
    if (!host) return out;
    function add(m) {
      if (!m) return;
      const pos = m.pos || m;
      if (pos.x == null || pos.y == null) return;
      const pt = { x: Number(pos.x), y: Number(pos.y) };
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
      if (m.xL != null && Number.isFinite(Number(m.xL))) {
        pt.xL = Number(m.xL);
      }
      if (m.Lh === false || m.Gh === false) pt.otherDim = true;
      out.push(pt);
    }
    try {
      if (typeof host.forEach === "function" && host.size != null) {
        host.forEach(add);
        return out;
      }
    } catch (e) { /* ignore */ }
    if (Array.isArray(host)) {
      for (let i = 0; i < host.length; i++) add(host[i]);
    }
    return out;
  }
  /** Statues; cracked comes from WQ.pdb (native / Ultra place). */
  function scrapeStatues(g) {
    const out = [];
    const host = g && g.Ya && (g.Ya.oa || g.Ya.ka);
    if (!host) return out;
    function statueIsCracked(st) {
      if (!st) return false;
      if (st.cracked || st.broken || st.crack) return true;
      if (st.hits != null && Number(st.hits) > 0) return true;
      const wq = st.WQ;
      if (wq && (wq.pdb === true || wq.pdb === 1 || wq.pdb === "1")) {
        return true;
      }
      return false;
    }
    function add(st) {
      if (!st) return;
      const pos = st.pos || st;
      if (pos.x == null || pos.y == null) return;
      const pt = {
        x: Number(pos.x),
        y: Number(pos.y),
      };
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
      const wq = st.WQ;
      const angle =
        st.angle != null
          ? Number(st.angle)
          : wq && wq.angle != null
            ? Number(wq.angle)
            : NaN;
      if (Number.isFinite(angle)) pt.angle = angle;
      if (statueIsCracked(st)) pt.cracked = true;
      if (st.Lh === false || st.Gh === false) pt.otherDim = true;
      out.push(pt);
    }
    try {
      if (typeof host.forEach === "function" && host.size != null) {
        host.forEach(add);
        return out;
      }
    } catch (e) { /* ignore */ }
    if (Array.isArray(host)) {
      for (let i = 0; i < host.length; i++) add(host[i]);
    }
    return out;
  }

  /** Arrow mode tiles: Ka.ka[y][x].direction (or Rb fallback). */
  function scrapeArrows(g) {
    const out = [];
    if (!g) return out;
    let host = null;
    try {
      if (typeof root.slot_arrow_host === "function") {
        host = root.slot_arrow_host(g);
      }
    } catch (eSlot) { /* ignore */ }
    if (!host) {
      if (g.Ka && Array.isArray(g.Ka.ka)) host = g.Ka;
      else if (
        g.Rb &&
        Array.isArray(g.Rb.ka) &&
        g.Rb.ka[0] &&
        g.Rb.ka[0][0] &&
        "direction" in g.Rb.ka[0][0]
      ) {
        host = g.Rb;
      }
    }
    const ka = host && host.ka;
    if (!ka) return out;
    for (let y = 0; y < ka.length; y++) {
      const row = ka[y];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (!cell || !cell.direction || cell.direction === "NONE") continue;
        const pt = { x: x, y: y, dir: String(cell.direction) };
        if (cell.color && typeof cell.color === "string") pt.color = cell.color;
        out.push(pt);
      }
    }
    return out;
  }

  /**
   * Companion body for Yin Yang only.
   * Twin has no second snake — do not invent or scrape a body2 for it.
   * Yin Yang: prefer real second ka; else mirror across center (native j7).
   */
  function scrapeCompanionBody(g, primaryBody, width, height) {
    const mode = scrapeModeKey();
    const isYy = boardHasMode({ modeKey: mode }, "yin_yang");
    if (!isYy) return null;
    const candidates = [];
    try {
      if (g && g.Ra && g.Ra.ka) candidates.push(g.Ra.ka);
      if (g && g.oa && g.oa.Ra && g.oa.Ra.ka) candidates.push(g.oa.Ra.ka);
      // Avoid fruit / board hosts — only snake-like Ras
      if (g && g.oa && g.oa.Sa && g.oa.Sa.ka && g.oa.Sa !== g.wa && g.oa.Sa !== g.oa) {
        candidates.push(g.oa.Sa.ka);
      }
    } catch (eCand) { /* ignore */ }
    const primary = primaryBody || [];
    const p0 = primary[0];
    const dims = snakeDimFlags(g && g.oa);
    for (let i = 0; i < candidates.length; i++) {
      const mapped = mapBody(candidates[i], dims);
      if (!mapped || !mapped.length) continue;
      // Skip if identical to primary (wrong host)
      if (
        p0 &&
        mapped[0] &&
        Number(mapped[0].x) === Number(p0.x) &&
        Number(mapped[0].y) === Number(p0.y) &&
        mapped.length === primary.length
      ) {
        continue;
      }
      return mapped;
    }
    // Yin Yang only: geometric mirror fallback
    if (!primary.length) return null;
    const w = width || 17;
    const h = height || 15;
    return primary.map(function (p) {
      const out = {
        x: w - 1 - Number(p.x),
        y: h - 1 - Number(p.y),
      };
      if (p.otherDim) out.otherDim = true;
      return out;
    });
  }

  const POSE_DIRECTIONS = {
    UP: true,
    DOWN: true,
    LEFT: true,
    RIGHT: true,
  };

  function normalizePoseDirection(value) {
    const dir = String(value || "").toUpperCase();
    return POSE_DIRECTIONS[dir] ? dir : null;
  }

  /**
   * One safe adapter for native facing fields. Ca/Ga are considered only when
   * they themselves (or an explicit `.direction`/`.dir`) contain a known
   * direction; unknown obfuscated shapes are ignored rather than guessed.
   */
  function readNativeDirection(snake) {
    if (!snake) return null;
    const candidates = [
      snake.direction,
      snake.dir,
      snake.Ca,
      snake.Ga,
      snake.Ca && snake.Ca.direction,
      snake.Ca && snake.Ca.dir,
      snake.Ga && snake.Ga.direction,
      snake.Ga && snake.Ga.dir,
    ];
    for (let i = 0; i < candidates.length; i++) {
      const dir = normalizePoseDirection(candidates[i]);
      if (dir) return dir;
    }
    return null;
  }

  /** Face angle field (P5E reads oa.Ca for head sprite rotation). */
  function readNativeFaceDirection(snake) {
    if (!snake) return null;
    if (typeof snake.Ca === "string") {
      const d = normalizePoseDirection(snake.Ca);
      if (d) return d;
    }
    return readNativeDirection(snake);
  }

  /** Turn-lerp source (P5E reads oa.Ga, else oa.direction). */
  function readNativeTransitionDirection(snake) {
    if (!snake) return null;
    if (typeof snake.Ga === "string") {
      const d = normalizePoseDirection(snake.Ga);
      if (d && d !== "NONE") return d;
    }
    return (
      normalizePoseDirection(snake.direction || snake.dir) ||
      readNativeFaceDirection(snake)
    );
  }

  /** Infer facing from head→neck when scrape fields lag a tick. */
  function inferDirectionFromBody(body) {
    if (!body || body.length < 2) return null;
    const h = body[0];
    const n = body[1];
    if (!h || !n) return null;
    const dx = (h.x | 0) - (n.x | 0);
    const dy = (h.y | 0) - (n.y | 0);
    if (dx === 1 && dy === 0) return "RIGHT";
    if (dx === -1 && dy === 0) return "LEFT";
    if (dx === 0 && dy === 1) return "DOWN";
    if (dx === 0 && dy === -1) return "UP";
    return null;
  }

  function reflectDirection(dir) {
    return {
      UP: "DOWN",
      DOWN: "UP",
      LEFT: "RIGHT",
      RIGHT: "LEFT",
    }[normalizePoseDirection(dir)] || null;
  }

  function findCompanionSnake(g, primary) {
    const candidates = [];
    try {
      if (g && g.Ra && g.Ra.ka) candidates.push(g.Ra);
      if (g && g.oa && g.oa.Ra && g.oa.Ra.ka) candidates.push(g.oa.Ra);
      if (g && g.oa && g.oa.Sa && g.oa.Sa.ka &&
          g.oa.Sa !== g.wa && g.oa.Sa !== g.oa) candidates.push(g.oa.Sa);
    } catch (e) { /* ignore */ }
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (!candidate || candidate === primary || !candidate.ka) continue;
      if (
        primary &&
        primary.ka &&
        candidate.ka.length === primary.ka.length &&
        candidate.ka[0] &&
        primary.ka[0] &&
        Number(candidate.ka[0].x) === Number(primary.ka[0].x) &&
        Number(candidate.ka[0].y) === Number(primary.ka[0].y)
      ) continue;
      return candidate;
    }
    return null;
  }

  function segmentFlags(body) {
    let any = false;
    const flags = (body || []).map(function (point) {
      const flag = point && point.otherDim ? 1 : 0;
      if (flag) any = true;
      return flag;
    });
    return any ? flags : undefined;
  }

  /**
   * Extra board entities beyond fruit (walls, keys, mines, …) for co-op sync
   * and race mosaic. Best-effort against obfuscated engine fields.
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
      arrows: [],
      bombZones: [],
      headLight: null,
    };
    if (!g) return entities;
    try {
      entities.walls = scrapeWalls(g);
    } catch (e) { /* ignore */ }
    try {
      entities.keys = scrapeKeys(g);
    } catch (e) { /* ignore */ }
    try {
      if (g.Aa) {
        entities.boxes = mapPointList(g.Aa.oa);
        entities.goals = mapPointList(g.Aa.d_ || g.Aa.da);
      }
    } catch (e) { /* ignore */ }
    try {
      entities.mines = scrapeMines(g);
    } catch (e) { /* ignore */ }
    try {
      entities.statues = scrapeStatues(g);
    } catch (e) { /* ignore */ }
    try {
      entities.bridges = scrapeBridges(g);
    } catch (e) { /* ignore */ }
    try {
      entities.gates = scrapeGates(g);
    } catch (e) { /* ignore */ }
    try {
      entities.arrows = scrapeArrows(g);
    } catch (e) { /* ignore */ }
    try {
      entities.bombZones = scrapeBombZones();
    } catch (eZ) { /* ignore */ }
    try {
      const lights = scrapeSnakeLights(g);
      entities.headLight =
        lights && lights.headLight != null ? lights.headLight : null;
    } catch (eL) { /* ignore */ }
    return entities;
  }

  /** Gate mode: Qa.pfa / Qa.Yfa entries use Upa (2×2 corner) + vertical. */
  function scrapeGates(g) {
    const out = [];
    const qa = g && g.Qa;
    if (!qa) return out;
    const seen = Object.create(null);
    function addList(list) {
      if (!list) return;
      const arr = Array.isArray(list) ? list : [];
      for (let i = 0; i < arr.length; i++) {
        const gate = arr[i];
        if (!gate) continue;
        const pos = gate.Upa || gate.pos || gate;
        if (pos.x == null || pos.y == null) continue;
        const x = Number(pos.x);
        const y = Number(pos.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const pt = {
          x: x,
          y: y,
          // Native gates occupy Upa..(Upa+1) on both axes
          w: 2,
          h: 2,
        };
        if (gate.vertical === true || gate.vertical === 1 || gate.ori === "v") {
          pt.vertical = true;
        } else if (
          gate.vertical === false ||
          gate.vertical === 0 ||
          gate.ori === "h"
        ) {
          pt.vertical = false;
        }
        // A corner can carry one gate per axis — key on orientation too
        const key = x + "," + y + (pt.vertical ? "v" : "h");
        if (seen[key]) continue;
        seen[key] = 1;
        // Native tints each gate off the theme, so send its own colour
        if (typeof gate.color === "string" && gate.color) pt.color = gate.color;
        if (gate.Lh === false || gate.Gh === false || gate.Aj === false) {
          pt.otherDim = true;
        }
        out.push(pt);
      }
    }
    try {
      addList(qa.pfa);
      addList(qa.Yfa);
      // Older dumps / tests may still use oa with .pos
      if (!out.length) addList(qa.oa);
    } catch (e) { /* ignore */ }
    return out;
  }

  /** Bridge mode: Ga.oa[y][x] = { color, wm, Lh } or empty. */
  function scrapeBridges(g) {
    const out = [];
    const grid = g && g.Ga && g.Ga.oa;
    if (!grid || !Array.isArray(grid)) return out;
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (!cell) continue;
        if (typeof cell === "number" && !(cell | 0)) continue;
        const pt = { x: x, y: y };
        if (cell && typeof cell === "object") {
          if (typeof cell.color === "string" && cell.color) {
            pt.color = cell.color;
          }
          if (cell.Lh === false || cell.Gh === false) pt.otherDim = true;
        }
        out.push(pt);
      }
    }
    return out;
  }

  /** Apply entity point lists onto known hosts when present (non-destructive). */
  function applyBoardEntities(entities) {
    if (!entities) return false;
    const g = gameInstance();
    if (!g) return false;
    let applied = false;
    const meta =
      (g.wa && g.wa.oa && g.wa.oa.oa) ||
      (g.oa && g.oa.oa) ||
      {};
    // Same size order on every client: payload → live Ca.wa → meta → default
    let bw = firstNumber(entities.width, entities.boardWidth) || null;
    let bh = firstNumber(entities.height, entities.boardHeight) || null;
    try {
      const wa = g.Ca && (g.Ca.wa || g.Ca.oa);
      if (Array.isArray(wa) && wa.length) {
        if (bw == null) bw = wa[0] && wa[0].length;
        if (bh == null) bh = wa.length;
      }
    } catch (eSz) { /* ignore */ }
    if (bw == null) bw = firstNumber(meta.width, meta.W) || null;
    if (bh == null) bh = firstNumber(meta.height, meta.H) || null;
    bw = bw || 17;
    bh = bh || 15;

    function writeList(hostArr, list) {
      if (!Array.isArray(hostArr) || !Array.isArray(list)) return;
      let templatePos = null;
      let templateObj = null;
      for (let t = 0; t < hostArr.length; t++) {
        const item = hostArr[t];
        if (!item) continue;
        if (!templateObj) templateObj = item;
        const p = item.pos;
        if (p && typeof p.clone === "function") {
          templatePos = p;
          templateObj = item;
          break;
        }
      }
      while (hostArr.length > list.length) hostArr.pop();
      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        let dst = hostArr[i];
        if (!dst) {
          dst = {};
          if (templateObj) {
            try {
              Object.keys(templateObj).forEach(function (k) {
                if (k === "pos") return;
                dst[k] = templateObj[k];
              });
            } catch (eCopy) { /* ignore */ }
          }
          dst.pos = makeNativePoint(src.x, src.y, templatePos);
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
        paintEntityFields(hostArr[i], src);
      }
      applied = true;
    }

    function writeMap(map, list) {
      if (!map || !Array.isArray(list) || typeof map.forEach !== "function") {
        return;
      }
      let template = null;
      const oldByPos = Object.create(null);
      const oldObjs = [];
      try {
        map.forEach(function (v) {
          if (!v) return;
          if (!template) template = v;
          const pos = v.pos || v;
          if (pos && pos.x != null && pos.y != null) {
            oldByPos[(pos.x | 0) + "," + (pos.y | 0)] = v;
          }
          oldObjs.push(v);
        });
      } catch (eT) { /* ignore */ }

      // Reuse native instances when boxes/keys move so push/unlock keep working
      const claimed = Object.create(null);
      const next = [];
      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        if (!src || src.x == null || src.y == null) continue;
        const key = (src.x | 0) + "," + (src.y | 0);
        let obj = oldByPos[key];
        if (obj) {
          claimed[key] = true;
        } else {
          for (let j = 0; j < oldObjs.length; j++) {
            const cand = oldObjs[j];
            if (!cand || cand.__mpClaimed) continue;
            const cp = cand.pos || cand;
            const ck =
              cp && cp.x != null ? (cp.x | 0) + "," + (cp.y | 0) : "";
            if (ck && claimed[ck]) continue;
            // Leftover at a position no longer in the list = moved entity
            if (ck && !list.some(function (p) {
              return p && (p.x | 0) + "," + (p.y | 0) === ck;
            })) {
              obj = cand;
              cand.__mpClaimed = true;
              break;
            }
          }
          if (!obj) {
            for (let j2 = 0; j2 < oldObjs.length; j2++) {
              if (oldObjs[j2] && !oldObjs[j2].__mpClaimed) {
                obj = oldObjs[j2];
                obj.__mpClaimed = true;
                break;
              }
            }
          }
        }
        if (!obj) {
          obj = {};
          if (template) {
            try {
              Object.keys(template).forEach(function (k) {
                if (k === "pos" || k === "__mpClaimed") return;
                obj[k] = template[k];
              });
            } catch (eC) { /* ignore */ }
          }
          obj.pos = makeNativePoint(
            src.x,
            src.y,
            template && template.pos
          );
        } else {
          obj.__mpClaimed = true;
          if (obj.pos || (template && template.pos)) {
            obj.pos = ensureNativePos(
              obj.pos,
              src.x,
              src.y,
              (template && template.pos) || obj.pos
            );
          } else {
            obj.x = src.x;
            obj.y = src.y;
          }
        }
        paintEntityFields(obj, src);
        next.push({ key: key, obj: obj });
      }
      for (let c = 0; c < oldObjs.length; c++) {
        if (oldObjs[c]) delete oldObjs[c].__mpClaimed;
      }
      try {
        if (typeof map.clear === "function") map.clear();
        for (let n = 0; n < next.length; n++) {
          const item = next[n];
          if (typeof map.set === "function") map.set(item.key, item.obj);
          else if (typeof map.add === "function") map.add(item.obj);
        }
        applied = true;
      } catch (eM) { /* ignore */ }
    }

    function paintEntityFields(dst, src) {
      if (!dst || !src) return;
      if (src.type != null) {
        dst.type = src.type;
        dst.yNa = src.type;
      }
      if (src.lockType != null) {
        dst.yNa = src.lockType;
        dst.XNa = src.lockType;
      }
      if (src.lock) dst.lock = true;
      if (src.hotdog) {
        dst.ty = true;
        dst.ez = true;
        dst.hotdog = true;
      }
      if (src.temp) dst.temp = true;
      if (src.cracked) {
        dst.cracked = true;
        if (!dst.WQ || typeof dst.WQ !== "object") dst.WQ = {};
        dst.WQ.pdb = true;
      }
      if (src.angle != null && Number.isFinite(Number(src.angle))) {
        dst.angle = Number(src.angle);
      }
      if (src.otherDim) {
        dst.Lh = false;
        dst.Gh = false;
      }
      if (src.keyblock && src.keyblock.x != null) {
        dst.r7a = makeNativePoint(src.keyblock.x, src.keyblock.y, dst.r7a);
        if (src.keyblock.type != null) dst.r7a.type = src.keyblock.type;
      }
      if (src.xL != null) dst.xL = src.xL;
      if (src.color) dst.color = src.color;
      if (src.vertical != null) dst.vertical = !!src.vertical;
    }

    function writeNumericGrid(grid, list, emptyVal, solidVal) {
      if (!grid || !Array.isArray(grid) || !Array.isArray(list)) return;
      const want = Object.create(null);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        want[(p.x | 0) + "," + (p.y | 0)] = true;
      }
      for (let y = 0; y < grid.length; y++) {
        const row = grid[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x++) {
          if (typeof row[x] === "object" && row[x]) continue;
          const key = x + "," + y;
          if (want[key]) {
            row[x] = solidVal;
            continue;
          }
          // Only clear plain empty/solid cells — keep temp-wall counters etc.
          const v = row[x] | 0;
          if (v === solidVal || v === emptyVal) row[x] = emptyVal;
        }
      }
      applied = true;
    }

    /**
     * Write walls the way native / Remix do: Ca.Aa Map with serial keys +
     * Ca.wa occupancy. Always ensure Aa exists — p6E does Aa.add/set and
     * crashes if peers only stamped the numeric grid.
     */
    function writeWallsNative(wallHost, list) {
      if (!wallHost || !Array.isArray(list)) return;
      const map = ensureNativeWallMap(wallHost);
      if (!map) return;
      let template = null;
      const oldByPos = Object.create(null);
      try {
        map.forEach(function (v) {
          if (!v) return;
          if (!template) template = v;
          const pos = v.pos || v;
          if (pos && pos.x != null && pos.y != null) {
            oldByPos[(pos.x | 0) + "," + (pos.y | 0)] = v;
          }
        });
      } catch (eT) { /* ignore */ }

      const next = [];
      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        if (!src || src.x == null || src.y == null) continue;
        const posKey = (src.x | 0) + "," + (src.y | 0);
        let obj = oldByPos[posKey];
        if (!obj) {
          obj = {};
          if (template) {
            try {
              Object.keys(template).forEach(function (k) {
                if (k === "pos" || k === "__mpClaimed" || k === "__tempWall") {
                  return;
                }
                obj[k] = template[k];
              });
            } catch (eC) { /* ignore */ }
          }
          // Match Remix tempWalls / mexico defaults for a plain solid cell
          if (obj.wm == null) obj.wm = false;
          if (obj.m0 == null) obj.m0 = false;
          if (obj.Lh == null) obj.Lh = true;
          obj.pos = makeNativePoint(
            src.x,
            src.y,
            template && template.pos
          );
        } else if (obj.pos || (template && template.pos)) {
          obj.pos = ensureNativePos(
            obj.pos,
            src.x,
            src.y,
            (template && template.pos) || obj.pos
          );
        } else {
          obj.x = src.x;
          obj.y = src.y;
        }
        paintEntityFields(obj, src);
        next.push({
          key: wallSerialKey(src.x, src.y),
          obj: obj,
        });
      }

      try {
        if (typeof map.clear === "function") map.clear();
        for (let n = 0; n < next.length; n++) {
          const item = next[n];
          if (typeof map.set === "function") {
            map.set(item.key, item.obj);
          } else if (typeof map.add === "function") {
            map.add(item.obj);
          }
        }
        applied = true;
      } catch (eM) { /* ignore */ }

      const grid = wallHost.wa;
      // Never leave holes — native y4E/p6E index wa[y][x] without a row guard
      ensureWallGridDense(
        wallHost,
        grid && grid[0] && grid[0].length,
        grid && grid.length
      );
      const dense = wallHost.wa;
      if (!Array.isArray(dense) || !dense.length) return;
      const want = Object.create(null);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p || p.x == null || p.y == null) continue;
        want[(p.x | 0) + "," + (p.y | 0)] = true;
      }
      for (let y = 0; y < dense.length; y++) {
        const row = dense[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x++) {
          if (typeof row[x] === "object" && row[x]) continue;
          const key = x + "," + y;
          const v = row[x] | 0;
          if (want[key]) {
            // Plant a normal 1×1 solid; leave higher refcounts alone
            if (v === 0 || v === 3 || v === 2) row[x] = 1;
            else if (v < 1) row[x] = 1;
            continue;
          }
          // Only clear our stamped 1s — keep corner sentinels (2) + temp counters
          if (v === 1) row[x] = 0;
        }
      }
      applied = true;
    }

    try {
      if (entities.walls != null && g.Ca) {
        // Drop 1×1 dead-end phantoms only — corner/diagonal walls are legal.
        const walls = filterMosaicWalls(entities.walls, bw, bh);
        writeWallsNative(g.Ca, walls);
      }
    } catch (eW) { /* ignore */ }
    try {
      if (g.Ba && entities.keys != null) {
        if (Array.isArray(g.Ba.keys)) writeList(g.Ba.keys, entities.keys);
        else if (g.Ba.keys && g.Ba.keys.forEach) writeMap(g.Ba.keys, entities.keys);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Aa && entities.boxes != null) {
        if (Array.isArray(g.Aa.oa)) writeList(g.Aa.oa, entities.boxes);
        else if (g.Aa.oa && g.Aa.oa.forEach) writeMap(g.Aa.oa, entities.boxes);
      }
      if (g.Aa && entities.goals != null) {
        const gh = g.Aa.d_ || g.Aa.da;
        if (Array.isArray(g.Aa.d_)) writeList(g.Aa.d_, entities.goals);
        else if (Array.isArray(g.Aa.da)) writeList(g.Aa.da, entities.goals);
        else if (gh && gh.forEach) writeMap(gh, entities.goals);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Ma && entities.mines) {
        const mh = g.Ma.oa || g.Ma.ka;
        if (Array.isArray(mh)) writeList(mh, entities.mines);
        else if (mh && mh.forEach) writeMap(mh, entities.mines);
      }
    } catch (e) { /* ignore */ }
    try {
      if (g.Ya && entities.statues) {
        const sh = g.Ya.oa || g.Ya.ka;
        if (Array.isArray(sh)) writeList(sh, entities.statues);
        else if (sh && sh.forEach) writeMap(sh, entities.statues);
      }
    } catch (e) { /* ignore */ }
    try {
      if (entities.bridges && g.Ga && Array.isArray(g.Ga.oa)) {
        const grid = g.Ga.oa;
        for (let y = 0; y < grid.length; y++) {
          const row = grid[y];
          if (!row) continue;
          for (let x = 0; x < row.length; x++) row[x] = null;
        }
        for (let i = 0; i < entities.bridges.length; i++) {
          const p = entities.bridges[i];
          if (!p || !grid[p.y | 0]) continue;
          const cell = { color: p.color || "#578a34" };
          if (p.otherDim) {
            cell.Lh = false;
            cell.Gh = false;
          }
          grid[p.y | 0][p.x | 0] = cell;
        }
        applied = true;
      }
    } catch (eB) { /* ignore */ }
    try {
      if (entities.arrows) {
        let host = g.Ka && Array.isArray(g.Ka.ka) ? g.Ka : null;
        if (!host && g.Rb && Array.isArray(g.Rb.ka)) host = g.Rb;
        const ka = host && host.ka;
        if (ka) {
          for (let y = 0; y < ka.length; y++) {
            const row = ka[y];
            if (!row) continue;
            for (let x = 0; x < row.length; x++) {
              if (row[x] && typeof row[x] === "object") {
                row[x].direction = "NONE";
              }
            }
          }
          for (let i = 0; i < entities.arrows.length; i++) {
            const p = entities.arrows[i];
            if (!p || !ka[p.y | 0] || !ka[p.y | 0][p.x | 0]) continue;
            const cell = ka[p.y | 0][p.x | 0];
            if (typeof cell !== "object") continue;
            cell.direction = p.dir || "NONE";
            if (p.color) cell.color = p.color;
          }
          applied = true;
        }
      }
    } catch (eA) { /* ignore */ }
    try {
      if (entities.gates && g.Qa) {
        const list = entities.gates;
        const bucket = Array.isArray(g.Qa.pfa)
          ? g.Qa.pfa
          : Array.isArray(g.Qa.oa)
            ? g.Qa.oa
            : null;
        if (bucket) {
          // A gate's cell lives on Upa (the 2×2 corner), not pos, so writeList
          // would swap the native instance for a bare point and leave the
          // engine drawing the old footprint. Move them in place instead.
          const template = bucket[0] && typeof bucket[0] === "object" ? bucket[0] : null;
          while (bucket.length > list.length) bucket.pop();
          for (let i = 0; i < list.length; i++) {
            const src = list[i];
            if (!src) continue;
            let dst = bucket[i];
            if (!dst || typeof dst !== "object") {
              dst = {};
              if (template) {
                try {
                  Object.keys(template).forEach(function (k) {
                    if (k === "Upa" || k === "pos") return;
                    dst[k] = template[k];
                  });
                } catch (eGc) { /* ignore */ }
              }
              bucket[i] = dst;
            }
            dst.Upa = makeNativePoint(src.x, src.y, dst.Upa);
            paintEntityFields(dst, src);
            applied = true;
          }
        }
      }
    } catch (eG) { /* ignore */ }
    try {
      if (entities.bombZones && typeof root.bombFruit_setZones === "function") {
        root.bombFruit_setZones(entities.bombZones);
        applied = true;
      } else if (entities.bombZones && Array.isArray(root.__bombFruitZones)) {
        root.__bombFruitZones.length = 0;
        for (let i = 0; i < entities.bombZones.length; i++) {
          root.__bombFruitZones.push(entities.bombZones[i]);
        }
        applied = true;
      }
    } catch (eZ) { /* ignore */ }
    try {
      if (entities.headLight != null && g.oa) {
        if (g.oa.Aa && typeof g.oa.Aa === "object") g.oa.Aa.light = entities.headLight;
        else g.oa.light = entities.headLight;
        applied = true;
      }
    } catch (eL) { /* ignore */ }
    void bw;
    void bh;
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
    const body = mapBody(bodySrc, snakeDimFlags(snake));
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
      timeMs: scoreInfo.timeMs != null ? scoreInfo.timeMs : 0,
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

    // Eating an Oka fruit (Poison mode, or a Burger fruit that rotted) sets a
    // tick countdown on the snake and the engine greys the whole body until it
    // runs out. Carry the countdown so mosaic can mirror that instead of the
    // player's colour, and so the un-poison lands on the same tick it does
    // in-game.
    try {
      const ja = Number(snake.Ja);
      if (Number.isFinite(ja) && ja > 0) board.poisonTicks = ja | 0;
    } catch (ePoison) { /* ignore */ }

    // Mode geometry for mosaic (cheese / portal / walls / keys / …)
    try {
      board.modeKey = scrapeModeKey();
    } catch (eMode) {
      board.modeKey = "";
    }
    try {
      const entities = scrapeBoardEntities(g);
      let walls = (entities && entities.walls) || [];
      if ((!walls || !walls.length) && Array.isArray(root.wallCoords)) {
        walls = [];
        for (let wi = 0; wi < root.wallCoords.length; wi++) {
          const c = root.wallCoords[wi];
          if (Array.isArray(c) && c.length >= 2) {
            walls.push({ x: Number(c[0]), y: Number(c[1]) });
          } else if (c && c.x != null) {
            walls.push({ x: Number(c.x), y: Number(c.y) });
          }
        }
      }
      board.walls = walls;
      board.keys = (entities && entities.keys) || [];
      board.boxes = (entities && entities.boxes) || [];
      board.goals = (entities && entities.goals) || [];
      board.mines = (entities && entities.mines) || [];
      board.statues = (entities && entities.statues) || [];
      board.bridges = (entities && entities.bridges) || [];
      board.gates = (entities && entities.gates) || [];
      board.arrows = (entities && entities.arrows) || [];
      // Re-filter with known board size (scrapeWalls may lack width/height)
      board.walls = filterMosaicWalls(board.walls, board.width, board.height);
    } catch (eWall) {
      board.walls = board.walls || [];
      board.keys = [];
      board.boxes = [];
      board.goals = [];
      board.mines = [];
      board.statues = [];
      board.bridges = [];
      board.gates = [];
      board.arrows = [];
    }
    try {
      const body2 = scrapeCompanionBody(g, body, width, height);
      if (body2 && body2.length) board.body2 = body2;
    } catch (eBody2) { /* ignore */ }

    // Co-op remotes for mosaic spectate (shared board, multiple snakes)
    try {
      if (root.__mpCoopSession && root.__mpCoopRemotes) {
        const myId = root.__mpCoopMyId;
        const remotes = root.__mpCoopRemotes;
        const snakes = [];
        Object.keys(remotes).forEach(function (id) {
          if (myId && id === myId) return;
          const r = remotes[id];
          if (!r || !r.body || !r.body.length) return;
          snakes.push({
            body: r.body,
            dir: r.dir,
            alive: r.alive !== false,
            colorId: r.colorId != null ? r.colorId : null,
            Sc: r.Sc || r.color2 || null,
            Yc: r.Yc || r.color1 || null,
          });
        });
        if (snakes.length) board.snakes = snakes;
      }
    } catch (eSnakes) { /* ignore */ }

    try {
      if (boardHasMode(board, "light")) {
        const lights = scrapeSnakeLights(g);
        board.headLight =
          lights.headLight != null ? lights.headLight : 2;
        if (lights.headLight2 != null) board.headLight2 = lights.headLight2;
        else if (board.body2 && board.body2.length) board.headLight2 = 2;
      }
    } catch (eLight) { /* ignore */ }

    // Cat: lives + peaceful grace, so mosaic spectators read the same status
    // the native lives HUD gives the player.
    try {
      if (boardHasMode(board, "cat")) {
        board.catLives = Math.max(0, Number(root.cat_lives) | 0);
        const maxLives = Number(root.CAT_MAX_LIVES);
        board.catLivesMax =
          Number.isFinite(maxLives) && maxLives > 0 ? maxLives | 0 : 9;
        const grace = Math.max(0, Number(root.cat_peaceful_ticks) | 0);
        if (grace > 0) board.catGrace = grace;
      }
    } catch (eCat) { /* ignore */ }

    // Bomb Fruit: dashed danger rings live on zones, not on the fruit objects
    try {
      if (boardHasMode(board, "bomb_fruit")) {
        const zones = scrapeBombZones();
        if (zones.length) board.bombZones = zones;
        const arm = Number(root.BOMB_FRUIT_ARM_TICKS);
        if (Number.isFinite(arm) && arm > 0) board.bombArmTicks = arm | 0;
      }
    } catch (eBomb) { /* ignore */ }

    root.__mpBoardCache = board;
    return board;
  }

  function scrapeModeKey() {
    return effectiveModeKey();
  }

  /**
   * ModeRegistry key, with Slot Machine's active roll folded in as `+id`.
   * Under Slot Machine getCurrentModeKey() is just "slot_machine", so co-op
   * rules (peaceful, borderless, cheese, dimension, light, yin_yang) would
   * otherwise miss the roll.
   */
  function effectiveModeKey() {
    let key = "";
    try {
      if (root.ModeRegistry && typeof root.ModeRegistry.getCurrentModeKey === "function") {
        key = String(root.ModeRegistry.getCurrentModeKey() || "");
      }
    } catch (e) { /* ignore */ }
    if (!key) {
      try {
        if (root.timeKeeper && root.timeKeeper.mode) {
          key = String(root.timeKeeper.mode);
        }
      } catch (e2) { /* ignore */ }
    }
    try {
      if (
        typeof root.isSlotMachineActive === "function" &&
        root.isSlotMachineActive() &&
        root.__slotActive != null
      ) {
        const roll = resolveSlotModeId(root.__slotActive);
        if (roll) {
          const parts = key
            ? String(key)
                .toLowerCase()
                .split("+")
                .filter(Boolean)
            : [];
          if (parts.indexOf(roll) < 0) parts.push(roll);
          if (parts.indexOf("slot_machine") < 0 && key.indexOf("slot") >= 0) {
            /* keep slot_machine if already present */
          }
          key = parts.join("+") || roll;
        }
      }
    } catch (eSlot) { /* ignore */ }
    return key;
  }

  /** Map Slot Machine mode index → ModeRegistry id (peaceful = 20). */
  function resolveSlotModeId(modeNum) {
    const n = Number(modeNum);
    if (!Number.isFinite(n)) return null;
    const idx = n | 0;
    if (idx === 20) return "peaceful";
    try {
      if (
        root.ModeRegistry &&
        typeof root.ModeRegistry._matchMiddleId === "function" &&
        typeof root.slot_trophy_url_for_mode === "function"
      ) {
        const url = root.slot_trophy_url_for_mode(idx);
        const id = root.ModeRegistry._matchMiddleId(url);
        if (id) return id;
      }
    } catch (e) { /* ignore */ }
    try {
      const middle = root.ModeRegistry && root.ModeRegistry.MIDDLE;
      if (Array.isArray(middle)) {
        const byBit = middle.find(function (m) {
          return m && m.bitIndexV3 === idx;
        });
        if (byBit && byBit.id) return byBit.id;
        if (middle[idx] && middle[idx].id) return middle[idx].id;
      }
    } catch (e2) { /* ignore */ }
    // Remix custom rolls
    if (idx === 23) return "candy";
    if (idx === 24) return "chess";
    if (idx === 25) return "burger";
    if (idx === 26) return "cat";
    if (idx === 27) return "mexico";
    if (idx === 28) return "bomb_fruit";
    return null;
  }

  function boardHasMode(board, id) {
    if (!id) return false;
    const key = String((board && board.modeKey) || scrapeModeKey() || "");
    if (!key) return false;
    if (key === id) return true;
    const parts = key.split("+");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === id) return true;
    }
    return false;
  }

  /**
   * Winged (and Slot winged roll): fruit drifts on He each tick. Co-op must seed
   * spawn pos + direction once, then trust each client's native motion — late
   * pos sync rubber-bands fruit backwards.
   */
  function isCoopFruitMotionMode() {
    if (boardHasMode({ modeKey: scrapeModeKey() }, "winged")) return true;
    try {
      const slot = root.__slotActive != null ? Number(root.__slotActive) | 0 : -1;
      if (slot === 6) return true; // Winged roll
    } catch (e) { /* ignore */ }
    return false;
  }

  function isCheeseHoleSegment(p, bodyIndex) {
    if (!p || bodyIndex === 0) return false;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return (x + y) % 2 === 0;
  }

  /** Native head floor is 2 tiles; fruit spawn is 1.5. */
  const LIGHT_HEAD_FLOOR = 2;
  const LIGHT_FRUIT_DEFAULT = 1.5;
  const LIGHT_OBJECT_RADIUS = 1;
  const LIGHT_ARROW_RADIUS = 0.5;
  const LIGHT_GOAL_RADIUS = 0.5;
  const LIGHT_GATE_RADIUS = 1.5;
  const LIGHT_FOG_ALPHA = 0.55;

  function mosaicPointLit(px, py, lights) {
    if (!lights || !lights.length) return true;
    const x = Number(px);
    const y = Number(py);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      if (!L || !(L.r > 0)) continue;
      const dx = x - L.x;
      const dy = y - L.y;
      if (dx * dx + dy * dy <= L.r * L.r) return true;
    }
    return false;
  }

  function mosaicCellLit(ix, iy, lights) {
    return mosaicPointLit(Number(ix) + 0.5, Number(iy) + 0.5, lights);
  }

  function pushMosaicLight(out, x, y, r) {
    const lx = Number(x);
    const ly = Number(y);
    const lr = Number(r);
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !(lr > 0)) return;
    out.push({ x: lx + 0.5, y: ly + 0.5, r: lr });
  }

  /**
   * Collect light-mode mask disks in tile space (center + radius).
   * Returns null when light mode is off.
   */
  function collectMosaicLights(board) {
    if (!board || !boardHasMode(board, "light")) return null;
    const lights = [];
    const body = board.body || [];
    if (body[0]) {
      const hr =
        board.headLight != null && Number.isFinite(Number(board.headLight))
          ? Number(board.headLight)
          : LIGHT_HEAD_FLOOR;
      pushMosaicLight(lights, body[0].x, body[0].y, Math.max(LIGHT_HEAD_FLOOR, hr));
    }
    const body2 = board.body2 || [];
    if (body2[0]) {
      const hr2 =
        board.headLight2 != null && Number.isFinite(Number(board.headLight2))
          ? Number(board.headLight2)
          : LIGHT_HEAD_FLOOR;
      pushMosaicLight(
        lights,
        body2[0].x,
        body2[0].y,
        Math.max(LIGHT_HEAD_FLOOR, hr2)
      );
    }
    // Extra heads (co-op remotes) — same stamp as the local head
    const extraHeads = board.heads || [];
    for (let hi = 0; hi < extraHeads.length; hi++) {
      const h = extraHeads[hi];
      if (!h || h.x == null || h.y == null) continue;
      const hr =
        h.light != null && Number.isFinite(Number(h.light))
          ? Number(h.light)
          : LIGHT_HEAD_FLOOR;
      pushMosaicLight(lights, h.x, h.y, Math.max(LIGHT_HEAD_FLOOR, hr));
    }
    const apples = board.apples || [];
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a) continue;
      let r =
        a.light != null && Number.isFinite(Number(a.light))
          ? Number(a.light)
          : LIGHT_FRUIT_DEFAULT;
      if (r > 0) pushMosaicLight(lights, a.x, a.y, r);
    }
    function stampList(list, radius) {
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        const r =
          p.light != null && Number.isFinite(Number(p.light))
            ? Number(p.light)
            : radius;
        if (r > 0) pushMosaicLight(lights, p.x, p.y, r);
      }
    }
    stampList(board.keys, LIGHT_OBJECT_RADIUS);
    stampList(board.mines, LIGHT_OBJECT_RADIUS);
    stampList(board.statues, LIGHT_OBJECT_RADIUS);
    stampList(board.boxes, LIGHT_OBJECT_RADIUS);
    stampList(board.walls, LIGHT_OBJECT_RADIUS);
    stampList(board.bridges, LIGHT_OBJECT_RADIUS);
    // Gates are 2×2 — stamp light at footprint center
    if (board.gates) {
      for (let i = 0; i < board.gates.length; i++) {
        const p = board.gates[i];
        if (!p) continue;
        const gw = p.w != null && Number(p.w) > 0 ? Number(p.w) : 2;
        const gh = p.h != null && Number(p.h) > 0 ? Number(p.h) : 2;
        const r =
          p.light != null && Number.isFinite(Number(p.light))
            ? Number(p.light)
            : LIGHT_GATE_RADIUS;
        if (r > 0) {
          out.push({
            x: Number(p.x) + gw / 2,
            y: Number(p.y) + gh / 2,
            r: r,
          });
        }
      }
    }
    stampList(board.goals, LIGHT_GOAL_RADIUS);
    stampList(board.arrows, LIGHT_ARROW_RADIUS);
    return lights;
  }

  function darkenHex(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) return "rgba(0,0,0," + amount + ")";
    const k = 1 - Math.max(0, Math.min(1, amount));
    return (
      "rgb(" +
      Math.round(rgb[0] * k) +
      "," +
      Math.round(rgb[1] * k) +
      "," +
      Math.round(rgb[2] * k) +
      ")"
    );
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
   * Borderless / Peaceful wrap the playfield — body coords may be unwrapped
   * (x=17 next to x=16 on a width-17 board). Flat-adjacency then draws a
   * chord across the whole row after wrapping to the canvas.
   */
  function boardWraps(board) {
    return (
      boardHasMode(board, "borderless") || boardHasMode(board, "peaceful")
    );
  }

  function normalizeBodyCell(p, width, height) {
    if (!p) return p;
    let x = Number(p.x);
    let y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return p;
    const w = Number(width);
    const h = Number(height);
    if (Number.isFinite(w) && w > 0) {
      x = ((x % w) + w) % w;
    }
    if (Number.isFinite(h) && h > 0) {
      y = ((y % h) + h) % h;
    }
    if (x === p.x && y === p.y) return p;
    const out = Object.assign({}, p);
    out.x = x;
    out.y = y;
    return out;
  }

  /**
   * WallSolver-style snake: tapered tip→head stroke + googly eyes (canvas).
   * Body list is head-first (native / BOARD_DELTA); reversed to tip→head for draw.
   * opts.cheese: skip light-tile body holes (cheese mode).
   * opts.lights: light-mode disks — skip body outside the mask.
   * opts.wrapWidth/wrapHeight: torus-normalize then split portal/wrap jumps so
   * the body is not stretched across the board.
   */
  function bodySegmentsAdjacent(a, b) {
    if (!a || !b) return false;
    const ax = Number(a.x);
    const ay = Number(a.y);
    const bx = Number(b.x);
    const by = Number(b.y);
    if (
      !Number.isFinite(ax) ||
      !Number.isFinite(ay) ||
      !Number.isFinite(bx) ||
      !Number.isFinite(by)
    ) {
      return false;
    }
    return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
  }

  /** Flat gap, or neighbors only via wrap (opposite edges). */
  function bodySegmentsNeedSplit(a, b, width, height) {
    if (!bodySegmentsAdjacent(a, b)) return true;
    return false;
  }

  /* ------------------------------------------------- smooth snake movement */

  // Bodies reach us one tick at a time, so painting them straight makes the
  // snake hop a whole cell per update. snakeMotion remembers where a snake was
  // and how long its last tick took; the renderer then slides the head out of
  // the cell it used to be in and drags the tail into the one it just left.
  // Only the two ends move, so corners stay square instead of being cut. The
  // picture trails the wire by one tick, which is what buys the slide.
  const MOTION_MIN_STEP_MS = 45;
  const MOTION_MAX_STEP_MS = 500;
  // Grace after a step so a repaint loop gets one frame to land on the cell
  const MOTION_SETTLE_MS = 32;

  function motionEnd(p) {
    return { x: Number(p.x), y: Number(p.y) };
  }

  /**
   * Record `body` under `slot` on `holder` — a canvas, a remote record, any
   * object we can hang state on — and return what the renderer needs to draw
   * it mid-step: { u, headFrom, tailFrom }, or null when there is nothing to
   * animate (first sight, a stall, or a jump that is not a single step).
   */
  function snakeMotion(holder, slot, body, now) {
    if (!holder || !body || !body.length) return null;
    const head = body[0];
    const tail = body[body.length - 1];
    if (!head || !tail || head.x == null || tail.x == null) return null;
    const key = slot || "body";
    const t = now != null ? Number(now) : Date.now();
    // The interior can only change when an end does, so the ends plus the
    // length are enough to spot a tick.
    const fp =
      head.x + "," + head.y + ":" + tail.x + "," + tail.y + ":" + body.length;
    const store =
      holder.__mpMotion || (holder.__mpMotion = Object.create(null));
    let st = store[key];
    if (!st) {
      store[key] = {
        fp: fp,
        at: t,
        step: 0,
        from: null,
        ends: { head: motionEnd(head), tail: motionEnd(tail) },
      };
      return null;
    }
    if (st.fp !== fp) {
      const gap = t - st.at;
      // Prefer server step interval when present (stable slides despite jitter)
      const forced = Number(holder._lerpStepMs) || 0;
      if (forced >= MOTION_MIN_STEP_MS && forced <= MOTION_MAX_STEP_MS) {
        st.step = forced;
      } else {
        // Outside this window it is a stall, a resync or two updates in one
        // frame — none of which should be stretched into a slide.
        st.step =
          gap >= MOTION_MIN_STEP_MS && gap <= MOTION_MAX_STEP_MS ? gap : 0;
      }
      st.from = st.ends;
      st.ends = { head: motionEnd(head), tail: motionEnd(tail) };
      st.fp = fp;
      st.at = t;
    }
    if (!st.step || !st.from) return null;
    const u = (t - st.at) / st.step;
    // u === 0 still animates: the frame a tick lands on has to draw the old
    // cells, or the snake jumps ahead and then slides back into place.
    if (!(u >= 0) || u >= 1) return null;
    return { u: u, headFrom: st.from.head, tailFrom: st.from.tail };
  }

  /** Any snake on `holder` still mid-step? Drives the repaint loops. */
  function snakeMotionActive(holder, now) {
    const store = holder && holder.__mpMotion;
    if (!store) return false;
    const t = now != null ? Number(now) : Date.now();
    for (const k in store) {
      const st = store[k];
      if (st && st.step > 0 && t - st.at < st.step + MOTION_SETTLE_MS) {
        return true;
      }
    }
    return false;
  }

  function drawWallSolverStyleSnake(ctx, body, ox, oy, cell, colorInfo, dir, opts) {
    opts = opts || {};
    if (!ctx || !body || !body.length) return;
    const cheese = !!opts.cheese;
    const lights = opts.lights || null;
    const wrapW = opts.wrapWidth | 0;
    const wrapH = opts.wrapHeight | 0;
    const wrap = wrapW > 0 && wrapH > 0;
    // Normalize onto the board first so unwrapped wrap-steps (16→17) become
    // edge jumps (16→0) and split instead of stroking across the row/column.
    const src = [];
    for (let i = 0; i < body.length; i++) {
      const raw = body[i];
      if (!raw) continue;
      src.push(wrap ? normalizeBodyCell(raw, wrapW, wrapH) : raw);
    }
    if (!src.length) return;
    // Mid-step slide (see snakeMotion). Validate against the normalized body:
    // anything that is not a one-cell step — a portal, a wrap, a respawn — has
    // no path to slide along, so that end draws in place.
    let motion = null;
    if (opts.motion && opts.motion.u >= 0 && opts.motion.u < 1) {
      let hf = opts.motion.headFrom || null;
      let tf = opts.motion.tailFrom || null;
      if (hf && wrap) hf = normalizeBodyCell(hf, wrapW, wrapH);
      if (tf && wrap) tf = normalizeBodyCell(tf, wrapW, wrapH);
      if (hf && !bodySegmentsAdjacent(hf, src[0])) hf = null;
      if (tf && !bodySegmentsAdjacent(tf, src[src.length - 1])) tf = null;
      if (hf || tf) motion = { u: opts.motion.u, headFrom: hf, tailFrom: tf };
    }
    const runs = [];
    let cur = [];
    let curOther = null;
    let curStart = 0;
    let dimSplit = false;
    function closeRun() {
      if (!cur.length) return;
      runs.push({
        segs: cur,
        isHead: cur[0] === src[0],
        otherDim: !!curOther,
        start: curStart,
        // Only a dimension change leaves a body that is still physically
        // continuous — cheese holes, fog and portal jumps are real breaks.
        dimSplitPrev: dimSplit,
      });
      cur = [];
      curOther = null;
      dimSplit = false;
    }
    for (let bi = 0; bi < src.length; bi++) {
      const p = src[bi];
      if (!p) continue;
      if (cheese && isCheeseHoleSegment(p, bi)) {
        closeRun();
        continue;
      }
      if (lights && !mosaicCellLit(p.x, p.y, lights)) {
        closeRun();
        continue;
      }
      const pOther = !!p.otherDim;
      const broken =
        cur.length && bodySegmentsNeedSplit(cur[cur.length - 1], p, wrapW, wrapH);
      const flipped = cur.length && pOther !== curOther;
      if (broken || flipped) {
        const dimOnly = !!flipped && !broken;
        closeRun();
        dimSplit = dimOnly;
      }
      if (!cur.length) {
        curOther = pOther;
        curStart = bi;
      }
      cur.push(p);
    }
    closeRun();
    if (!runs.length) {
      runs.push({
        segs: [src[0]],
        isHead: true,
        otherDim: !!src[0].otherDim,
        start: 0,
        dimSplitPrev: false,
      });
    }
    // A dimension boundary would otherwise leave a one-cell hole between the
    // two strokes. The ghost side is painted under the solid one, so stretching
    // it across the boundary closes the seam without ever putting a solid
    // segment on a cell that is in the other dimension.
    for (let ri = 1; ri < runs.length; ri++) {
      const next = runs[ri];
      if (!next.dimSplitPrev) continue;
      const prev = runs[ri - 1];
      if (next.otherDim) {
        next.segs.unshift(prev.segs[prev.segs.length - 1]);
        next.start -= 1;
      } else if (prev.otherDim) {
        prev.segs.push(next.segs[0]);
      }
    }
    // Ghost (other dimension) under solid so current-dim body stays readable
    function paintRuns(ghostOnly) {
      for (let ri = 0; ri < runs.length; ri++) {
        const run = runs[ri];
        if (!!run.otherDim !== ghostOnly) continue;
        if (ghostOnly) {
          ctx.save();
          ctx.globalAlpha = 0.32;
        }
        drawWallSolverStyleSnakeRun(
          ctx,
          run.segs,
          ox,
          oy,
          cell,
          colorInfo,
          dir,
          {
            drawEyes: run.isHead,
            // Taper and gradient run across the whole body, so a split does not
            // read as two smaller snakes each with its own head and tail.
            taperStart: run.start,
            taperLength: src.length,
            motion: motion,
          }
        );
        if (ghostOnly) ctx.restore();
      }
    }
    paintRuns(true);
    paintRuns(false);
  }

  function drawWallSolverStyleSnakeRun(ctx, body, ox, oy, cell, colorInfo, dir, opts) {
    opts = opts || {};
    if (!ctx || !body || !body.length) return;
    const drawEyes = opts.drawEyes !== false;
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
    // Taper window inside the full body, so runs split off a longer snake keep
    // one continuous head→tail gradient instead of restarting their own.
    const taperLen = opts.taperLength > 1 ? opts.taperLength | 0 : 0;
    const taperStart = taperLen ? opts.taperStart | 0 : 0;
    const ownsHead = !taperLen || taperStart <= 0;
    const ownsTip = !taperLen || taperStart + n >= taperLen;

    // Mid-step slide: pull the two ends back toward the cells they came from.
    // Interior points stay on their centres, so the tube keeps its length and
    // its corners while it moves. Direction is already fixed above, off the
    // real cells, so the head keeps facing the way it is going at u≈0.
    const motion = opts.motion;
    if (motion) {
      if (ownsHead && motion.headFrom) {
        const hx = ox + (Number(motion.headFrom.x) + 0.5) * cell;
        const hy = oy + (Number(motion.headFrom.y) + 0.5) * cell;
        pts[headI] = [
          hx + (pts[headI][0] - hx) * motion.u,
          hy + (pts[headI][1] - hy) * motion.u,
        ];
      }
      if (ownsTip && motion.tailFrom && n > 1) {
        const tx = ox + (Number(motion.tailFrom.x) + 0.5) * cell;
        const ty = oy + (Number(motion.tailFrom.y) + 0.5) * cell;
        pts[0] = [
          tx + (pts[0][0] - tx) * motion.u,
          ty + (pts[0][1] - ty) * motion.u,
        ];
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
        if (ownsTip) tipPull = cell * 0.45;
        if (ownsHead) headPull = cell * 0.2;
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
      if (taperLen) {
        const bi = taperStart + (n - 1 - i);
        return Math.max(0, Math.min(1, bi / (taperLen - 1)));
      }
      return n <= 1 ? 0 : (headI - i) / headI;
    }
    function widthAt(t) {
      return headW * (1 - t) + tipW * t;
    }

    const poly = [];
    poly.push([tipX, tipY, tAt(0)]);
    for (let i = 1; i < headI; i++) {
      poly.push([pts[i][0], pts[i][1], tAt(i)]);
    }
    poly.push([headX, headY, tAt(headI)]);

    const col = mix(0);
    const neckR = headW / 2;
    const bulgeR = neckR * 0.82;
    const bulgeX = neckR * 0.12;
    const bulgeY = neckR * 0.92;
    const snoutR = neckR * 1.02;
    const snoutX = neckR * 0.78;

    // The gradient is faked with a run of short overlapping strokes, so the
    // drop shadow has to be laid down first and then buried under a flat
    // repaint of the same shapes. Shadowing each stroke as it goes drops a dark
    // crescent on the stroke before it, which is what made the body read as a
    // row of separate discs instead of one snake.
    function strokeBody() {
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
    }

    /** Skull: neck, the two eye bulges and the snout, in head colour. */
    function fillHeadBlobs() {
      ctx.save();
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
      ctx.restore();
    }

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // A see-through body — a ghost run, a corpse — is painted once and left
    // without a shadow: two passes would stack up and darken it.
    const opaque = !(ctx.globalAlpha != null && Number(ctx.globalAlpha) < 1);
    for (let pass = opaque ? 0 : 1; pass < 2; pass++) {
      const shade = pass === 0;
      ctx.shadowColor = shade ? "rgba(0,0,0,0.4)" : "transparent";
      ctx.shadowBlur = shade ? Math.max(1, cell * 0.045) : 0;
      ctx.shadowOffsetY = shade ? Math.max(1, cell * 0.05) : 0;
      strokeBody();
      if (drawEyes) fillHeadBlobs();
    }

    if (!drawEyes) {
      ctx.restore();
      return;
    }

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

    // Face sits on the skull the passes above already laid down
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.translate(headX, headY);
    ctx.rotate(angle);
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

  /** RemixUltra / native key sheets: 24 frames on X (types 0–23). */
  const KEY_TYPES_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/v19/key_types.png";
  const KEY_TYPES_DARK_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/v19/key_types_dark.png";
  const KEY_TYPE_FRAMES = 24;

  /** RemixUltra Objects tab: sokobox frame 0, sokogoal frame 2 on v4/box.png. */
  const SOKO_BOX_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/v4/box.png";
  const SOKO_BOX_FRAMES = 8;
  const SOKO_BOX_FRAME = 0;
  const SOKO_GOAL_FRAME = 2;

  /**
   * Remix "Distinct Soko Goals" (`pudding_settings.SokoGoals`, on by default)
   * swaps the box sheet for one whose goal frames are red-on-white instead of
   * theme-tinted green. Prefer Remix's embedded data: images (no postimg).
   */
  const SOKO_GOAL_FALLBACK = "rgba(255,220,80,0.9)";
  const SOKO_GOAL_DISTINCT_FALLBACK = "rgba(244,67,54,0.95)";

  /** True when the viewer has Distinct Soko Goals on (Remix defaults to on). */
  function sokoGoalsDistinct() {
    try {
      const s = root.pudding_settings;
      if (s && s.SokoGoals != null) return !!s.SokoGoals;
    } catch (e) { /* ignore */ }
    return true;
  }

  /** Remix-bundled distinct goal sheet (data: URL) or null. */
  function remixDistinctSokoGoalSrc(pixel) {
    try {
      const img = pixel ? root.distinct_soko_goal_px : root.distinct_soko_goal;
      const src = img && (img.currentSrc || img.src);
      if (
        src &&
        (src.indexOf("data:") === 0 ||
          src.indexOf("blob:") === 0 ||
          src.indexOf("https://www.google.com/") === 0)
      ) {
        return src;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Goal sheet for one board. Distinct on/off is the viewer's own cosmetic
   * preference (Remix never syncs it), while pixel/normal follows the graphics
   * setting of the board being drawn — matching `graphics_selected === 1`.
   * Never loads i.postimg.cc — Remix embeds those sheets as data URLs.
   */
  function resolveSokoGoalUrl(board) {
    if (!sokoGoalsDistinct()) return SOKO_BOX_URL;
    let gfx =
      board && board.graphicsIndex != null ? board.graphicsIndex | 0 : -1;
    if (gfx < 0) gfx = Number(root.graphics_selected) | 0;
    const remixSrc = remixDistinctSokoGoalSrc(gfx === 1);
    if (remixSrc) return remixSrc;
    // No Remix asset yet (unit tests / early boot) — native box sheet, not postimg
    return SOKO_BOX_URL;
  }

  /** Exported aliases for tests — resolve through Remix when present. */
  function sokoGoalDistinctUrl() {
    return remixDistinctSokoGoalSrc(false) || SOKO_BOX_URL;
  }
  function sokoGoalDistinctPxUrl() {
    return remixDistinctSokoGoalSrc(true) || SOKO_BOX_URL;
  }

  /** Poison-mode skull (same icon Skull Poison Fruit / Ultra place use). */
  const POISON_SKULL_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/v12/trophy_10.png";

  /**
   * Rewrite saved Custom fruit/poison postimg URLs (legacy localStorage) to
   * embedded data URLs / Google trophy. Bundle itself has no i.postimg.cc links.
   */
  function sanitizePostimgFruitUrls() {
    function fallbackFor(key, url) {
      const u = String(url || "");
      const isPx = /pixel/i.test(key) || /_px|px_/i.test(u);
      try {
        if (isPx && root.px_ghost_skull && root.px_ghost_skull.src) {
          return String(root.px_ghost_skull.src);
        }
        if (root.ghost_skull && root.ghost_skull.src) {
          return String(root.ghost_skull.src);
        }
      } catch (eG) { /* ignore */ }
      try {
        if (typeof root.remixCustomFruitDefaultSprites === "function") {
          const d = root.remixCustomFruitDefaultSprites();
          if (d) {
            if (isPx && d.Pixel) return String(d.Pixel);
            if (d.Normal) return String(d.Normal);
          }
        }
      } catch (eD) { /* ignore */ }
      return POISON_SKULL_URL;
    }
    function rewrite(url, key) {
      if (!url || typeof url !== "string") return url;
      if (url.indexOf("postimg") < 0 && url.indexOf("i.postimg.cc") < 0) {
        return url;
      }
      return fallbackFor(key || "", url);
    }
    function scrubSettings(s) {
      if (!s || typeof s !== "object") return 0;
      let n = 0;
      const keys = [
        "CustomPoisonNormal",
        "CustomPoisonPixel",
        "CustomPoisonReal",
        "CustomFruitNormal",
        "CustomFruitPixel",
        "CustomFruitReal",
      ];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (typeof s[k] !== "string") continue;
        const next = rewrite(s[k], k);
        if (next !== s[k]) {
          s[k] = next;
          n++;
        }
      }
      return n;
    }
    let changed = 0;
    try {
      changed += scrubSettings(root.pudding_settings);
    } catch (eP) { /* ignore */ }
    try {
      if (typeof localStorage !== "undefined") {
        const keys = ["RemixSettings", "pudding_settings", "PuddingSettings"];
        for (let i = 0; i < keys.length; i++) {
          const raw = localStorage.getItem(keys[i]);
          if (!raw || raw.indexOf("postimg") < 0) continue;
          try {
            const obj = JSON.parse(raw);
            if (scrubSettings(obj) > 0) {
              localStorage.setItem(keys[i], JSON.stringify(obj));
              changed++;
            }
          } catch (eJ) { /* ignore */ }
        }
      }
    } catch (eLs) { /* ignore */ }
    try {
      if (typeof root.remixSyncCustomFruitEntryFromSettings === "function") {
        root.remixSyncCustomFruitEntryFromSettings();
      }
      if (typeof root.remixPatchCustomFruitAtlas === "function") {
        root.remixPatchCustomFruitAtlas();
      }
    } catch (eAt) { /* ignore */ }
    // Block late Image loads that still point at postimg poison assets
    try {
      if (!root.__mpPostimgImgPatched && typeof Image !== "undefined") {
        const desc = Object.getOwnPropertyDescriptor(Image.prototype, "src");
        if (desc && desc.set && desc.get) {
          root.__mpPostimgImgPatched = true;
          Object.defineProperty(Image.prototype, "src", {
            configurable: true,
            enumerable: desc.enumerable,
            get: function () {
              return desc.get.call(this);
            },
            set: function (v) {
              let next = v;
              try {
                if (
                  typeof v === "string" &&
                  v.indexOf("postimg") >= 0 &&
                  (v.indexOf("poison") >= 0 ||
                    v.indexOf("ghost") >= 0 ||
                    v.indexOf("fruit") >= 0)
                ) {
                  next = rewrite(v, v);
                }
              } catch (eR) { /* ignore */ }
              return desc.set.call(this, next);
            },
          });
        }
      }
    } catch (eImg) { /* ignore */ }
    return changed;
  }

  /**
   * Poisoned-snake gradient, from the engine's f3E/g3E ([145,145,145] and
   * [100,100,100]). While the poison countdown runs, the body colour function
   * discards the player's colour — rainbow skins included — and strokes from
   * these two greys instead.
   */
  const POISON_SNAKE_PRIMARY = "#919191";
  const POISON_SNAKE_SECONDARY = "#646464";

  /** True while the engine is painting this board's snake as poisoned. */
  function boardSnakePoisoned(board) {
    return !!board && (Number(board.poisonTicks) | 0) > 0;
  }

  /** RemixUltra Objects: mine flag is frame 9 on a vertical mine.png strip. */
  const MINE_FLAG_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/mine.png";
  const MINE_FLAG_FRAMES = 10;
  const MINE_FLAG_FRAME = 9;
  /** In-game danger radius is a ~3-tile dashed square (#f23606). */
  const MINE_RADIUS_CELLS = 3;
  const MINE_RADIUS_COLOR = "#f23606";
  /** Bomb Fruit arm countdown (window.BOMB_FRUIT_ARM_TICKS) + pulse fill alpha. */
  const BOMB_ARM_TICKS_DEFAULT = 4;
  const BOMB_PULSE_ALPHA = 0.15;
  /** Slot badge chip: native draws the trophy at 45% of the fruit sprite. */
  const SLOT_BADGE_SCALE = 0.45;
  const SLOT_BADGE_BG = "rgba(0,0,0,0.45)";

  /** Statue trophy + cracks overlay (RemixUltra Objects tab). */
  const STATUE_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/v16/trophy_13.png";
  const STATUE_CRACKS_URL =
    "https://www.google.com/logos/fnbx/snake_arcade/cracks.png";
  const STATUE_CRACKS_FRAMES = 4;
  const STATUE_CRACKS_FRAME = 0;

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
   * Draw one frame from a sprite strip (horizontal by default; axis "y" for mine.png).
   * Returns true if the sprite was drawn.
   */
  function drawSpriteSheetFrame(ctx, url, frame, frames, dx, dy, dw, dh, axis) {
    if (!ctx || !url || typeof ctx.drawImage !== "function") return false;
    const img = getAppleImage(url);
    if (!img || !img.complete || !(img.naturalWidth > 0)) return false;
    const n = Math.max(1, frames | 0);
    let f = Number(frame);
    if (!Number.isFinite(f) || f < 0) f = 0;
    f = Math.min(n - 1, f | 0);
    const vert = axis === "y" || axis === "Y";
    const fw = vert ? img.naturalWidth : img.naturalWidth / n;
    const fh = vert ? img.naturalHeight / n : img.naturalHeight;
    if (!(fw > 0) || !(fh > 0)) return false;
    const sx = vert ? 0 : f * fw;
    const sy = vert ? f * fh : 0;
    try {
      ctx.drawImage(img, sx, sy, fw, fh, dx, dy, dw, dh);
      return true;
    } catch (e) {
      return false;
    }
  }

  function drawKeyTypeAt(ctx, type, x0, y0, size, dark) {
    return drawSpriteSheetFrame(
      ctx,
      dark ? KEY_TYPES_DARK_URL : KEY_TYPES_URL,
      type,
      KEY_TYPE_FRAMES,
      x0,
      y0,
      size,
      size,
      "x"
    );
  }

  function drawMineFlagAt(ctx, x0, y0, size) {
    return drawSpriteSheetFrame(
      ctx,
      MINE_FLAG_URL,
      MINE_FLAG_FRAME,
      MINE_FLAG_FRAMES,
      x0,
      y0,
      size,
      size,
      "y"
    );
  }

  function drawFullImageAt(ctx, url, x0, y0, size) {
    if (!ctx || !url || typeof ctx.drawImage !== "function") return false;
    const img = getAppleImage(url);
    if (!img || !img.complete || !(img.naturalWidth > 0)) return false;
    try {
      ctx.drawImage(img, x0, y0, size, size);
      return true;
    } catch (e) {
      return false;
    }
  }

  function drawStatueAt(ctx, x0, y0, size, cracked) {
    const drew = drawFullImageAt(ctx, STATUE_URL, x0, y0, size);
    if (!drew) return false;
    if (cracked) {
      drawSpriteSheetFrame(
        ctx,
        STATUE_CRACKS_URL,
        STATUE_CRACKS_FRAME,
        STATUE_CRACKS_FRAMES,
        x0,
        y0,
        size,
        size,
        "x"
      );
    }
    return true;
  }

  /** Dashed orange danger square around a mine (matches native #f23606 rings). */
  function drawMineRadius(ctx, ox, oy, cell, mine) {
    if (!ctx || !mine) return;
    const c = cellCenter(ox, oy, cell, mine);
    const side = cell * MINE_RADIUS_CELLS;
    const x0 = c.cx - side / 2;
    const y0 = c.cy - side / 2;
    ctx.save();
    ctx.strokeStyle = MINE_RADIUS_COLOR;
    ctx.lineWidth = Math.max(1, cell / 12);
    if (typeof ctx.setLineDash === "function") {
      const d = Math.max(2, cell / 4);
      ctx.setLineDash([d, d]);
      if (ctx.lineDashOffset != null) ctx.lineDashOffset = cell / 8;
    }
    ctx.strokeRect(x0, y0, side, side);
    ctx.restore();
  }

  /**
   * Bomb Fruit: the same dashed danger ring the player sees around each fruit,
   * plus the armed countdown pulse — a translucent square that grows out from
   * the cell toward the ring as the timer runs down (native draw_one_radius).
   */
  function drawBombZones(ctx, board, ox, oy, cell, lights) {
    const zones = (board && board.bombZones) || [];
    if (!ctx || !zones.length) return;
    const armed = Number(board.bombArmTicks);
    const armTicks = armed > 0 ? armed : BOMB_ARM_TICKS_DEFAULT;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (!z || z.x == null || z.y == null) continue;
      if (lights && !mosaicCellLit(z.x, z.y, lights)) continue;
      drawMineRadius(ctx, ox, oy, cell, z);
      const arm = z.arm != null ? Number(z.arm) : -1;
      if (!(arm > 0)) continue;
      const f = Math.max(0, Math.min(1, (armTicks - arm) / armTicks));
      const side = cell * MINE_RADIUS_CELLS * f;
      if (!(side > 0)) continue;
      const c = cellCenter(ox, oy, cell, z);
      ctx.save();
      ctx.globalAlpha = BOMB_PULSE_ALPHA;
      ctx.fillStyle = MINE_RADIUS_COLOR;
      ctx.fillRect(c.cx - side / 2, c.cy - side / 2, side, side);
      ctx.restore();
    }
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

  /**
   * Poison fruit → skull icon (poison mode trophy / Skull Poison Fruit).
   * Prefer live Ultra/Pudding assets when present.
   */
  function resolvePoisonImageUrl() {
    try {
      if (typeof root.ultraPlacePoisonSrc === "function") {
        const u = root.ultraPlacePoisonSrc();
        if (u) return String(u);
      }
    } catch (eUltra) { /* ignore */ }
    try {
      if (root.skull && root.skull.src) return String(root.skull.src);
    } catch (eSkull) { /* ignore */ }
    try {
      if (root.pudding_settings && root.pudding_settings.Skull && root.real_skull && root.real_skull.src) {
        return String(root.real_skull.src);
      }
    } catch (eReal) { /* ignore */ }
    return POISON_SKULL_URL;
  }

  /**
   * Slot badge icon for a mode id. Remix owns the mapping (its own icons for
   * modes 23–29, plus the live #trophy row), so prefer its resolver and fall
   * back to the stock trophy CDN for native modes.
   */
  function resolveSlotBadgeUrl(mode) {
    const m = Number(mode);
    if (!Number.isFinite(m) || m < 0) return "";
    const idx = m | 0;
    try {
      if (typeof root.slot_trophy_url_for_mode === "function") {
        const u = root.slot_trophy_url_for_mode(idx);
        if (u) return String(u);
      }
    } catch (e) { /* ignore */ }
    try {
      const row =
        typeof document !== "undefined"
          ? document.getElementById("trophy")
          : null;
      const el = row && row.children && row.children[idx];
      const src = el && (el.src || el.getAttribute("src"));
      if (src) return String(src);
    } catch (e2) { /* ignore */ }
    if (idx <= 21) {
      const id = idx < 10 ? "0" + idx : String(idx);
      return (
        "https://www.google.com/logos/fnbx/snake_arcade/v22/trophy_" + id + ".png"
      );
    }
    return "";
  }

  /**
   * Slot Machine badge: the mode trophy a fruit will activate, centered on the
   * sprite over a rounded dark chip (native slot_draw_badge_at_fruit).
   * Alpha is inherited rather than forced to 1 so dimension ghost fruit keep a
   * ghosted badge, and the size floor is lower than native since a mosaic cell
   * is a fraction of a real board tile.
   */
  function drawSlotBadge(ctx, cx, cy, fruitSize, mode) {
    if (!ctx) return false;
    const url = resolveSlotBadgeUrl(mode);
    if (!url) return false;
    const img = getAppleImage(url);
    if (!img || !img.complete || !(img.naturalWidth > 0)) return false;
    if (typeof ctx.drawImage !== "function") return false;
    const d = fruitSize > 0 ? fruitSize : 16;
    const size = Math.max(4, d * SLOT_BADGE_SCALE);
    const bg = size + Math.max(1, size * 0.18) * 2;
    ctx.save();
    ctx.fillStyle = SLOT_BADGE_BG;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(cx - bg / 2, cy - bg / 2, bg, bg, Math.max(2, bg * 0.22));
    } else {
      ctx.arc(cx, cy, bg / 2, 0, Math.PI * 2);
    }
    ctx.fill();
    let drew = false;
    try {
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
      drew = true;
    } catch (e) { /* cross-origin / incomplete */ }
    ctx.restore();
    return drew;
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

  /** Drop cached sprite Images so the next draw re-resolves every URL. */
  function resetSpriteImageCache() {
    Object.keys(_appleImgCache).forEach(function (k) {
      delete _appleImgCache[k];
    });
  }

  function drawBoardApples(ctx, board, ox, oy, cell, theme, lights) {
    const apples = board && board.apples;
    if (!apples || !apples.length) return;
    const appleIndex = board.appleIndex;
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a || a.x == null || a.y == null) continue;
      // Skip parked off-grid Focus placeholders
      if (Number(a.x) < 0 || Number(a.y) < 0) continue;
      if (lights && !mosaicCellLit(a.x, a.y, lights)) continue;
      const cx = ox + Number(a.x) * cell + cell / 2;
      const cy = oy + Number(a.y) * cell + cell / 2;
      const size = cell * 0.88;
      const url = a.poison
        ? resolvePoisonImageUrl()
        : resolveAppleImageUrl(a.type, appleIndex);
      const img = getAppleImage(url);
      let drew = false;
      const ghost = !!a.otherDim;
      if (ghost) {
        ctx.save();
        ctx.globalAlpha = 0.32;
      }
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
        // Chess-piece fallback: colored square (white/black) with piece initial
        if (a.isPiece && a.chessPiece) {
          const isWhite = a.chessColor === "w";
          ctx.fillStyle = isWhite ? "#f0d9b5" : "#b58863";
          ctx.fillRect(cx - cell * 0.38, cy - cell * 0.38, cell * 0.76, cell * 0.76);
          ctx.fillStyle = isWhite ? "#000" : "#fff";
          ctx.font = "bold " + Math.max(8, cell * 0.38) + "px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const initial =
            a.chessPiece === "knight" ? "N" : a.chessPiece.charAt(0).toUpperCase();
          ctx.fillText(initial, cx, cy);
        } else {
          ctx.fillStyle = a.poison
            ? "#37474f"
            : theme.apple || "#e7471d";
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Slot Machine: mode badge sits on top of the fruit sprite
      if (a.slotMode != null) {
        drawSlotBadge(ctx, cx, cy, size, a.slotMode);
      }
      if (ghost) ctx.restore();
      // Shield mode: edge ticks matching nba directions
      if (a.shields && a.shields.length) {
        drawAppleShields(ctx, cx, cy, cell, a.shields, theme);
      }
    }
  }

  function drawAppleShields(ctx, cx, cy, cell, dirs, theme) {
    if (!ctx || !dirs || !dirs.length) return;
    // Native H3E: each tick lies on the cell edge itself, a fifth of a cell
    // thick, ends pulled in by half its thickness, and every end gets a square
    // corner block — so a fruit shielded on all four sides reads as a closed
    // frame. Colour is theme slot 3, the same one walls use.
    let thick = Math.round(cell / 5);
    if (thick % 2 !== 0) thick += 1;
    if (thick < 1) thick = 1;
    const d = cell / 2;
    const b = thick / 2;
    const has = {};
    for (let i = 0; i < dirs.length; i++) {
      has[String(dirs[i]).toUpperCase()] = true;
    }
    ctx.save();
    ctx.strokeStyle = (theme && theme.border) || "#578a34";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = thick;
    ctx.lineCap = "butt";
    function edge(x0, y0, x1, y1) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    if (has.UP) edge(cx - d + b, cy - d, cx + d - b, cy - d);
    if (has.DOWN) edge(cx - d + b, cy + d, cx + d - b, cy + d);
    if (has.LEFT) edge(cx - d, cy - d + b, cx - d, cy + d - b);
    if (has.RIGHT) edge(cx + d, cy - d + b, cx + d, cy + d - b);
    // Corners are the union of the sides that touch them, so a lone side still
    // closes off with both of its own blocks
    const tl = has.LEFT || has.UP;
    const bl = has.LEFT || has.DOWN;
    const tr = has.RIGHT || has.UP;
    const br = has.RIGHT || has.DOWN;
    if (tl) ctx.fillRect(cx - d - b, cy - d - b, thick, thick);
    if (bl) ctx.fillRect(cx - d - b, cy + d - b, thick, thick);
    if (tr) ctx.fillRect(cx + d - b, cy - d - b, thick, thick);
    if (br) ctx.fillRect(cx + d - b, cy + d - b, thick, thick);
    ctx.restore();
  }

  function drawBoardWalls(ctx, board, ox, oy, cell, theme, lights) {
    const raw = board && board.walls;
    if (!ctx || !raw || !raw.length) return;
    const walls = filterMosaicWalls(raw, board.width, board.height);
    for (let i = 0; i < walls.length; i++) {
      const p = walls[i];
      if (!p) continue;
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (lights && !mosaicCellLit(x, y, lights)) continue;
      const x0 = ox + x * cell;
      const y0 = oy + y * cell;
      // Keyblocks: native yNa/XNa type → key_types_dark frame (RemixUltra)
      if (p.lock || (p.lockType != null && Number(p.lockType) >= 0)) {
        const lt =
          p.lockType != null && Number.isFinite(Number(p.lockType))
            ? Number(p.lockType)
            : 0;
        if (drawKeyTypeAt(ctx, lt, x0, y0, cell, true)) continue;
        ctx.fillStyle = "#c9a227";
        ctx.fillRect(x0, y0, cell, cell);
        ctx.strokeStyle = "rgba(80,50,0,0.55)";
        ctx.lineWidth = Math.max(1, cell * 0.06);
        ctx.beginPath();
        ctx.moveTo(x0 + cell * 0.2, y0 + cell * 0.2);
        ctx.lineTo(x0 + cell * 0.8, y0 + cell * 0.8);
        ctx.moveTo(x0 + cell * 0.8, y0 + cell * 0.2);
        ctx.lineTo(x0 + cell * 0.2, y0 + cell * 0.8);
        ctx.stroke();
        continue;
      }
      if (p.hotdog) {
        ctx.fillStyle = "#d2691e";
      } else if (p.temp || p.__tempWall) {
        ctx.fillStyle = theme && theme.border ? theme.border : "#578a34";
      } else {
        ctx.fillStyle = theme && theme.border ? theme.border : "#578a34";
      }
      ctx.fillRect(x0, y0, cell, cell);
    }
  }

  function drawBoardPortalLinks(ctx, board, ox, oy, cell, lights) {
    if (!ctx || !boardHasMode(board, "portal")) return;
    const apples = board.apples || [];
    if (apples.length < 2) return;
    const byType = Object.create(null);
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a || a.type == null) continue;
      if (lights && !mosaicCellLit(a.x, a.y, lights)) continue;
      const t = String(a.type);
      if (!byType[t]) byType[t] = [];
      byType[t].push(a);
    }
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1.2, cell * 0.1);
    ctx.setLineDash([Math.max(2, cell * 0.18), Math.max(2, cell * 0.14)]);
    Object.keys(byType).forEach(function (t) {
      const pair = byType[t];
      if (!pair || pair.length < 2) return;
      for (let i = 0; i + 1 < pair.length; i += 2) {
        const a = pair[i];
        const b = pair[i + 1];
        ctx.beginPath();
        ctx.moveTo(ox + (Number(a.x) + 0.5) * cell, oy + (Number(a.y) + 0.5) * cell);
        ctx.lineTo(ox + (Number(b.x) + 0.5) * cell, oy + (Number(b.y) + 0.5) * cell);
        ctx.stroke();
      }
    });
    // Soft rings so portal fruit read as gates even without pairs
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(120,200,255,0.7)";
    ctx.lineWidth = Math.max(1, cell * 0.08);
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a || a.type == null) continue;
      if (lights && !mosaicCellLit(a.x, a.y, lights)) continue;
      ctx.beginPath();
      ctx.arc(
        ox + (Number(a.x) + 0.5) * cell,
        oy + (Number(a.y) + 0.5) * cell,
        cell * 0.42,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  function cellCenter(ox, oy, cell, p) {
    return {
      cx: ox + (Number(p.x) + 0.5) * cell,
      cy: oy + (Number(p.y) + 0.5) * cell,
    };
  }

  /** Keys, boxes, goals, mines, statues, bridges, gates, arrows, keyblocks. */
  function drawBoardModeEntities(ctx, board, ox, oy, cell, theme, lights) {
    if (!ctx || !board) return;
    const pad = cell * 0.12;
    function vis(p) {
      return !lights || (p && mosaicCellLit(p.x, p.y, lights));
    }

    // Bridges — native obF static tiles: full-cell solid fill (theme color / #e68f1b)
    const bridges = board.bridges || [];
    for (let i = 0; i < bridges.length; i++) {
      const p = bridges[i];
      if (!p || !vis(p)) continue;
      if (p.otherDim) {
        ctx.save();
        ctx.globalAlpha = 0.32;
      }
      const x0 = ox + Number(p.x) * cell;
      const y0 = oy + Number(p.y) * cell;
      ctx.fillStyle =
        p.color && typeof p.color === "string" ? p.color : BRIDGE_DEFAULT_COLOR;
      ctx.fillRect(x0, y0, cell, cell);
      if (p.otherDim) ctx.restore();
    }

    // Sokoban goals then boxes — RemixUltra v4/box.png frames 2 / 0, with the
    // goal sheet swapped when Distinct Soko Goals is on
    const goals = board.goals || [];
    const goalUrl = resolveSokoGoalUrl(board);
    for (let i = 0; i < goals.length; i++) {
      const p = goals[i];
      if (!p || !vis(p)) continue;
      const x0 = ox + Number(p.x) * cell;
      const y0 = oy + Number(p.y) * cell;
      if (
        !drawSpriteSheetFrame(
          ctx,
          goalUrl,
          SOKO_GOAL_FRAME,
          SOKO_BOX_FRAMES,
          x0,
          y0,
          cell,
          cell
        )
      ) {
        ctx.strokeStyle =
          goalUrl === SOKO_BOX_URL
            ? SOKO_GOAL_FALLBACK
            : SOKO_GOAL_DISTINCT_FALLBACK;
        ctx.lineWidth = Math.max(1.2, cell * 0.1);
        ctx.strokeRect(x0 + pad, y0 + pad, cell - pad * 2, cell - pad * 2);
      }
    }

    const boxes = board.boxes || [];
    for (let i = 0; i < boxes.length; i++) {
      const p = boxes[i];
      if (!p || !vis(p)) continue;
      const x0 = ox + Number(p.x) * cell;
      const y0 = oy + Number(p.y) * cell;
      if (
        !drawSpriteSheetFrame(
          ctx,
          SOKO_BOX_URL,
          SOKO_BOX_FRAME,
          SOKO_BOX_FRAMES,
          x0,
          y0,
          cell,
          cell
        )
      ) {
        ctx.fillStyle = "#a0522d";
        ctx.fillRect(x0 + pad, y0 + pad, cell - pad * 2, cell - pad * 2);
      }
    }

    // Gates — native u5E draws one dashed line on the edge the gate blocks,
    // nothing else. A gate at Upa=(x,y) owns the 2×2 block from there: vertical
    // ones sit on the x+1 column edge, flat ones on the y+1 row edge, and both
    // run the 2 cells the block spans.
    const gates = board.gates || [];
    for (let i = 0; i < gates.length; i++) {
      const p = gates[i];
      if (!p) continue;
      const gw = p.w != null && Number(p.w) > 0 ? Number(p.w) : 2;
      const gh = p.h != null && Number(p.h) > 0 ? Number(p.h) : 2;
      // Visible if any cell of the 2×2 is lit (or no fog)
      let gateVis = !lights;
      if (lights) {
        for (let dy = 0; dy < gh && !gateVis; dy++) {
          for (let dx = 0; dx < gw && !gateVis; dx++) {
            if (mosaicCellLit(Number(p.x) + dx, Number(p.y) + dy, lights)) {
              gateVis = true;
            }
          }
        }
      }
      if (!gateVis) continue;
      const vertical = p.vertical === true;
      const x0 = ox + Number(p.x) * cell;
      const y0 = oy + Number(p.y) * cell;
      const span = (vertical ? gh : gw) * cell;
      ctx.save();
      if (p.otherDim) ctx.globalAlpha = 0.32;
      ctx.strokeStyle = p.color || darkenHex(theme.dark, 0.45);
      ctx.lineWidth = Math.max(1, cell * 0.1);
      ctx.lineCap = "butt";
      if (typeof ctx.setLineDash === "function") {
        // Native lands 5 dashes and 4 gaps exactly on the span, all span/9 long
        const dash = span / 9;
        ctx.setLineDash([dash, dash]);
        if (ctx.lineDashOffset != null) ctx.lineDashOffset = 0;
      }
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(x0 + cell, y0);
        ctx.lineTo(x0 + cell, y0 + span);
      } else {
        ctx.moveTo(x0, y0 + cell);
        ctx.lineTo(x0 + span, y0 + cell);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Minesweeper: dashed danger ring + flag sprite (RemixUltra mine.png frame 9)
    const mines = board.mines || [];
    for (let i = 0; i < mines.length; i++) {
      const p = mines[i];
      if (!p || !vis(p)) continue;
      if (p.otherDim) {
        ctx.save();
        ctx.globalAlpha = 0.32;
      }
      drawMineRadius(ctx, ox, oy, cell, p);
      const x0 = ox + Number(p.x) * cell;
      const y0 = oy + Number(p.y) * cell;
      if (!drawMineFlagAt(ctx, x0, y0, cell)) {
        // Fallback: simple flag pole + banner
        const c = cellCenter(ox, oy, cell, p);
        ctx.strokeStyle = "#37474f";
        ctx.lineWidth = Math.max(1, cell * 0.06);
        ctx.beginPath();
        ctx.moveTo(c.cx - cell * 0.05, c.cy + cell * 0.28);
        ctx.lineTo(c.cx - cell * 0.05, c.cy - cell * 0.28);
        ctx.stroke();
        ctx.fillStyle = "#c62828";
        ctx.beginPath();
        ctx.moveTo(c.cx - cell * 0.05, c.cy - cell * 0.28);
        ctx.lineTo(c.cx + cell * 0.28, c.cy - cell * 0.12);
        ctx.lineTo(c.cx - cell * 0.05, c.cy + cell * 0.02);
        ctx.closePath();
        ctx.fill();
      }
      if (p.otherDim) ctx.restore();
    }

    // Bomb Fruit rings sit under the fruit sprites, same as the native pass
    drawBombZones(ctx, board, ox, oy, cell, lights);

    // Statues (trophy_13 + cracks.png overlay when WQ.pdb / cracked)
    const statues = board.statues || [];
    for (let i = 0; i < statues.length; i++) {
      const p = statues[i];
      if (!p || !vis(p)) continue;
      if (p.otherDim) {
        ctx.save();
        ctx.globalAlpha = 0.32;
      }
      const x0 = ox + Number(p.x) * cell;
      const y0 = oy + Number(p.y) * cell;
      if (!drawStatueAt(ctx, x0, y0, cell, !!p.cracked)) {
        const pad = Math.max(1, cell * 0.12);
        const sx = x0 + pad;
        const sy = y0 + pad;
        const s = cell - pad * 2;
        ctx.fillStyle = p.cracked ? "#9e9e9e" : "#757575";
        ctx.fillRect(sx, sy, s, s);
        if (p.cracked) {
          ctx.strokeStyle = "rgba(40,40,40,0.75)";
          ctx.lineWidth = Math.max(1, cell * 0.07);
          ctx.beginPath();
          ctx.moveTo(sx + s * 0.15, sy + s * 0.15);
          ctx.lineTo(sx + s * 0.85, sy + s * 0.85);
          ctx.moveTo(sx + s * 0.85, sy + s * 0.15);
          ctx.lineTo(sx + s * 0.15, sy + s * 0.85);
          ctx.stroke();
        }
      }
      if (p.otherDim) ctx.restore();
    }

    // Keyblocks (type-matched dark sheet) then keys (key_types.png) — RemixUltra
    const keys = board.keys || [];
    const drawnBlocks = Object.create(null);
    // Walls with lock already painted keyblocks; still paint from keys if missing
    const walls = board.walls || [];
    for (let wi = 0; wi < walls.length; wi++) {
      const w = walls[wi];
      if (!w || !(w.lock || (w.lockType != null && Number(w.lockType) >= 0))) continue;
      drawnBlocks[Number(w.x) + "," + Number(w.y)] = 1;
    }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!k || !k.keyblock) continue;
      const kb = k.keyblock;
      if (!vis(kb)) continue;
      const bk = Number(kb.x) + "," + Number(kb.y);
      if (drawnBlocks[bk]) continue;
      const type =
        kb.type != null
          ? kb.type
          : k.type != null
            ? k.type
            : 0;
      const x0 = ox + Number(kb.x) * cell;
      const y0 = oy + Number(kb.y) * cell;
      if (!drawKeyTypeAt(ctx, type, x0, y0, cell, true)) {
        ctx.strokeStyle = "rgba(255,215,0,0.85)";
        ctx.lineWidth = Math.max(1.2, cell * 0.1);
        ctx.strokeRect(
          x0 + pad * 0.5,
          y0 + pad * 0.5,
          cell - pad,
          cell - pad
        );
      }
      drawnBlocks[bk] = 1;
    }
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!k || !vis(k)) continue;
      const x0 = ox + Number(k.x) * cell;
      const y0 = oy + Number(k.y) * cell;
      if (!drawKeyTypeAt(ctx, k.type != null ? k.type : 0, x0, y0, cell, false)) {
        const c = cellCenter(ox, oy, cell, k);
        ctx.fillStyle = "#ffd54f";
        ctx.beginPath();
        ctx.moveTo(c.cx, c.cy - cell * 0.28);
        ctx.lineTo(c.cx + cell * 0.22, c.cy);
        ctx.lineTo(c.cx, c.cy + cell * 0.28);
        ctx.lineTo(c.cx - cell * 0.22, c.cy);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Arrows
    const arrows = board.arrows || [];
    for (let i = 0; i < arrows.length; i++) {
      const a = arrows[i];
      if (!a || !vis(a)) continue;
      drawArrowGlyph(ctx, ox, oy, cell, a);
    }
  }

  /**
   * Native arrow chevron (xpl/ypl): orange V pointing in dir, lineWidth=cell/8.
   * Geometry matches source: half=cell/2, arm=0.6*half, tip=sqrt(3*arm^2/4).
   */
  /** Native bridge tile fill (placeBridge / bridgeColor helper). */
  const BRIDGE_DEFAULT_COLOR = "#e68f1b";

  const ARROW_DEFAULT_COLOR = "#EA7E0B";

  function drawArrowGlyph(ctx, ox, oy, cell, a) {
    if (!ctx || !a || !(cell > 0)) return;
    const dir = String(a.dir || a.direction || "").toUpperCase();
    if (dir !== "UP" && dir !== "DOWN" && dir !== "LEFT" && dir !== "RIGHT") {
      return;
    }
    const cx = ox + (Number(a.x) + 0.5) * cell;
    const cy = oy + (Number(a.y) + 0.5) * cell;
    const half = cell / 2;
    const arm = 0.6 * half;
    const tip = Math.sqrt((3 * arm * arm) / 4);
    ctx.save();
    ctx.translate(cx, cy);
    if (dir === "UP") ctx.rotate(-Math.PI / 2);
    else if (dir === "DOWN") ctx.rotate(Math.PI / 2);
    else if (dir === "LEFT") ctx.rotate(Math.PI);
    ctx.strokeStyle =
      a.color && typeof a.color === "string" ? a.color : ARROW_DEFAULT_COLOR;
    ctx.lineWidth = Math.max(1, cell / 8);
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    if (typeof ctx.setLineDash === "function") ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(-tip, -arm);
    ctx.lineTo(tip, 0);
    ctx.lineTo(-tip, arm);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Soft light halos sized from scraped radii (head ≥2, fruit ~1.5, objects ~1).
   * Fog / object culling is handled separately via collectMosaicLights.
   */
  function drawBoardLightGlow(ctx, board, ox, oy, cell, lights) {
    if (!ctx || !lights || !lights.length) return;
    ctx.save();
    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      if (!L || !(L.r > 0)) continue;
      const cx = ox + L.x * cell;
      const cy = oy + L.y * cell;
      const rad = L.r * cell;
      if (typeof ctx.createRadialGradient === "function") {
        const grd = ctx.createRadialGradient(cx, cy, rad * 0.15, cx, cy, rad);
        grd.addColorStop(0, "rgba(255,255,210,0.28)");
        grd.addColorStop(0.7, "rgba(255,255,200,0.08)");
        grd.addColorStop(1, "rgba(255,255,200,0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(255,255,200,0.12)";
        ctx.beginPath();
        ctx.arc(cx, cy, rad * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Paint one board (mosaic cell, Focus view, preview) onto a canvas.
   * motionKey names whose snake this is: the canvas carries the slide state,
   * and the Focus canvas is reused for every player it watches, so switching
   * player must not slide the new snake out of the old one's cells.
   */
  function drawBoardOnCanvas(canvas, board, colorInfo, themeOverride, motionKey) {
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
    const lights = collectMosaicLights(board);
    ctx.fillStyle = theme.border || "#578a34";
    ctx.fillRect(0, 0, cw, ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const base = (x + y) % 2 === 0 ? theme.light : theme.dark;
        if (lights && !mosaicCellLit(x, y, lights)) {
          ctx.fillStyle = darkenHex(base, LIGHT_FOG_ALPHA);
        } else {
          ctx.fillStyle = base;
        }
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    }
    drawBoardWalls(ctx, board, ox, oy, cell, theme, lights);
    drawBoardModeEntities(ctx, board, ox, oy, cell, theme, lights);
    drawBoardPortalLinks(ctx, board, ox, oy, cell, lights);
    drawBoardApples(ctx, board, ox, oy, cell, theme, lights);
    if (lights) drawBoardLightGlow(ctx, board, ox, oy, cell, lights);
    const snakeDrawOpts = {
      cheese: boardHasMode(board, "cheese"),
      lights: lights,
    };
    if (boardWraps(board)) {
      snakeDrawOpts.wrapWidth = w;
      snakeDrawOpts.wrapHeight = h;
    }
    // Poison outranks the player's colour for as long as the countdown runs,
    // and the engine greys the companion along with the primary body.
    const poisoned = boardSnakePoisoned(board);
    const snakeColor = poisoned
      ? { primary: POISON_SNAKE_PRIMARY, secondary: POISON_SNAKE_SECONDARY }
      : colorInfo;
    const motionSlot = motionKey ? ":" + motionKey : "";
    // Co-op remotes under the local snake (mosaic spectate shared board)
    const remoteSnakes = board.snakes || [];
    for (let ri = 0; ri < remoteSnakes.length; ri++) {
      const rs = remoteSnakes[ri];
      if (!rs || !rs.body || !rs.body.length) continue;
      let remoteColor = null;
      if (rs.Sc || rs.Yc) {
        remoteColor = {
          primary: rs.Sc || rs.Yc,
          secondary: rs.Yc || rs.Sc,
          Sc: rs.Sc || null,
          Yc: rs.Yc || null,
        };
      } else if (
        root.MultiplayerColors &&
        root.MultiplayerColors.getColor &&
        rs.colorId != null
      ) {
        remoteColor = root.MultiplayerColors.getColor(Number(rs.colorId));
      }
      snakeDrawOpts.motion = snakeMotion(
        canvas,
        "remote" + ri + motionSlot,
        rs.body
      );
      ctx.globalAlpha = rs.alive === false ? 0.5 : 1;
      drawWallSolverStyleSnake(
        ctx,
        rs.body,
        ox,
        oy,
        cell,
        remoteColor,
        rs.dir,
        snakeDrawOpts
      );
      ctx.globalAlpha = 1;
    }
    // Companion under primary: Yin Yang = muted alt; Twin = same colors
    if (board.body2 && board.body2.length) {
      let companionColor = snakeColor;
      if (!poisoned && boardHasMode(board, "yin_yang")) {
        companionColor = { primary: "#eceff1", secondary: "#90a4ae" };
      }
      snakeDrawOpts.motion = snakeMotion(
        canvas,
        "body2" + motionSlot,
        board.body2
      );
      drawWallSolverStyleSnake(
        ctx,
        board.body2,
        ox,
        oy,
        cell,
        companionColor,
        board.dir2 || board.dir,
        snakeDrawOpts
      );
    }
    snakeDrawOpts.motion = snakeMotion(canvas, "body" + motionSlot, board.body);
    drawWallSolverStyleSnake(
      ctx,
      board.body || [],
      ox,
      oy,
      cell,
      snakeColor,
      board.dir,
      snakeDrawOpts
    );
  }

  /**
   * Race Focus: local GameInstance still simulates between injects and can
   * call die() even when the remote player is alive. Never run native die UI —
   * Focus spectators must not flash the endscreen (that resets Play/seat).
   *
   * Co-op server-auth death matrix:
   * - Mid-match dead → SVG corpse only (__mpCoopLocalCorpse); never nj / origDie / deathscreen
   * - STATE alive → clear corpse flags + hideDeathScreen (kill false native flashes)
   * - Match end → _handleCoopMatchEnded owns teardown (not this guard)
   */
  function installFocusDieGuard(g) {
    if (!g || g.__mpFocusDieGuarded) return;
    g.__mpFocusDieGuarded = true;
    const origDie = typeof g.die === "function" ? g.die : null;
    g.die = function () {
      if (root.__mpRaceFocusSpectate) {
        try {
          const b = root.__mpRaceFocusBoard;
          if (b && b.alive === false) {
            this.nj = true;
            if (this.dead != null) this.dead = true;
            if (this.isDead != null) this.isDead = true;
            if (root.timeKeeper) {
              root.timeKeeper._dead = true;
              root.timeKeeper.playing = false;
            }
          } else {
            this.nj = false;
            if (this.dead) this.dead = false;
            if (this.isDead) this.isDead = false;
            if (root.timeKeeper) root.timeKeeper._dead = false;
          }
          if (!root.__mpSpectateAllowMenus) hideDeathScreen();
        } catch (e) { /* ignore */ }
        return;
      }
      if (root.__mpCoopServerAuth) {
        try {
          const state = root.__mpCoopLastState;
          const myId = root.__mpCoopLastStateMyId || root.__mpCoopMyId;
          let alive = true;
          if (state && state.ended) alive = false;
          else if (state && myId && Array.isArray(state.snakes)) {
            for (let i = 0; i < state.snakes.length; i++) {
              const s = state.snakes[i];
              if (s && s.clientId === myId) {
                alive = s.alive !== false;
                break;
              }
            }
          }
          // Never arm native death animation under server-auth
          this.nj = false;
          if (this.dead != null) this.dead = false;
          if (this.isDead != null) this.isDead = false;
          if (alive) {
            root.__mpCoopLocalCorpse = false;
            if (root.timeKeeper) root.timeKeeper._dead = false;
          } else if (!state || !state.ended) {
            root.__mpCoopLocalCorpse = true;
            if (root.timeKeeper) root.timeKeeper._dead = false;
          } else {
            root.__mpCoopLocalCorpse = true;
          }
          hideDeathScreen();
          try {
            dismissDeathOverlayForRun();
          } catch (eDismiss) { /* ignore */ }
        } catch (eAuth) { /* ignore */ }
        return; // never origDie
      }
      if (origDie) return origDie.apply(this, arguments);
    };
  }

  /** Alias — co-op install site. */
  function installCoopDieGuard(g) {
    installFocusDieGuard(g);
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
      if (root.__mpRaceFocusSpectate) {
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
   * Inject a focused player's state into the live GameInstance so the native
   * snake/fruit renderers draw the spectated run.
   *
   * Dormant: Focus draws the watched board itself now, and every branch below
   * is gated on __mpRaceFocusSpectate, which nothing sets. Kept with the rest
   * of the seat plumbing in case we go back — see archive/focus-native/.
   *
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
    // Admins own match rules — Focus must not overwrite trophy/count/speed/size.
    // After attempt expire we also skip so lobby edits stick.
    const skipMatchMenus =
      opts.skipMatchMenus === true ||
      !!root.__mpSpectateSkipMatchMenus ||
      !!root.__mpAttemptExpired;
    if (forceMenus || menuFp !== root.__mpSpectateMenuFp) {
      root.__mpApplyingSettings = true;
      try {
        if (!skipMatchMenus) {
          syncMenu("size", board.sizeIndex);
          syncMenu("count", board.countIndex);
          syncMenu("speed", board.speedIndex);
          syncMenu("trophy", board.trophyIndex);
        }
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
        if (root.__mpRaceFocusSpectate) {
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
          root.__mpRaceFocusSpectate &&
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
      if (g && root.__mpRaceFocusSpectate) {
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
            // Remote died — mark local dead for inject, but never show endscreen chrome
            g.nj = true;
            if (g.dead != null) g.dead = true;
            if (root.timeKeeper) {
              root.timeKeeper._dead = true;
              root.timeKeeper.playing = false;
            }
            if (!root.__mpSpectateAllowMenus) hideDeathScreen();
          }
          // Do not overwrite the App latch of __mpRaceFocusRemoteAlive — the
          // caller owns the death/revive edge (see archive/focus-native/).
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
        if (!root.__mpControlTipUnloadHooked) {
          root.__mpControlTipUnloadHooked = true;
          const disconnect = function () {
            try {
              if (root.__mpControlTipObserver) {
                root.__mpControlTipObserver.disconnect();
                root.__mpControlTipObserver = null;
              }
            } catch (eDisc) { /* ignore */ }
          };
          if (typeof root.addEventListener === "function") {
            root.addEventListener("pagehide", disconnect);
            root.addEventListener("beforeunload", disconnect);
          }
        }
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

  /**
   * Hide the local snake for co-op spectators. Must NOT clear `ka` — an empty
   * body makes PlayerRenderer throw Closure `yi NaN×4` and kills the render loop.
   * Park off-board instead (same as parkLocalSnakeOffBoard).
   */
  function emptyLocalSnakeBody() {
    return parkLocalSnakeOffBoard();
  }

  /** Co-op / Race Focus spectate — never persist TimeKeeper PBs or attempts. */
  function isSpectatingForTimeKeeper() {
    return !!(
      root.__mpCoopSpectator ||
      root.__mpRaceFocusWatch ||
      root.__mpRaceFocusSpectate
    );
  }

  /** Co-op session must never write remix / coop localStorage PBs. */
  function isCoopTimeKeeperBlocked() {
    return !!(
      root.__mpCoopServerAuth ||
      root.__mpCoopSession ||
      isSpectatingForTimeKeeper()
    );
  }

  /**
   * Patch shouldTrack so Remix savePB / saveScore / addAttempt / gotAll never
   * write while spectating or during co-op. Handlers in mod.js already skip MP
   * side-effects; without this, orig.gotAll still flushed impossible times.
   */
  function installSpectatorTimeKeeperGuard() {
    const tk = root.timeKeeper;
    if (!tk) return false;
    if (tk.__mpSpectateTkGuard) return true;
    tk.__mpSpectateTkGuard = true;
    const origShouldTrack =
      typeof tk.shouldTrack === "function" ? tk.shouldTrack.bind(tk) : null;
    tk.shouldTrack = function (ctx) {
      if (isCoopTimeKeeperBlocked()) return false;
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
        if (name === "death") {
          // Server-auth: native death is not authority — binder owns _dead
          if (!root.__mpCoopServerAuth) tk._dead = true;
        }
        if (name === "start") tk._dead = false;
        // Server-auth co-op: native gotApple/gotAll/death must not drive Remix
        // endscreens, PB, or stop the shared timer mid-match. Match end stops
        // the timer in _handleCoopMatchEnded.
        if (
          root.__mpCoopServerAuth &&
          (name === "gotApple" || name === "gotAll" || name === "death")
        ) {
          try {
            after && after(timeMs, score, name);
          } catch (eAuth) {
            console.warn("mp timeKeeper hook", eAuth);
          }
          return undefined;
        }
        try {
          after && after(timeMs, score, name);
        } catch (e) {
          console.warn("mp timeKeeper hook", e);
        }
        // Belt-and-suspenders: never invoke Remix save path while spectating / co-op
        if (
          isCoopTimeKeeperBlocked() &&
          (name === "gotApple" || name === "gotAll" || name === "death")
        ) {
          if (
            !root.__mpCoopServerAuth &&
            name === "death"
          ) {
            tk.playing = false;
          }
          // gotAll under co-op: leave playing alone — mod onAll suppresses false ALL
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
   * Co-op: __mpCoopOnTick each tick; __mpCoopRenderEnter caches PlayerRenderer
   * and companions paint every render frame.
   */
  function alterSnakeCodeExposeGame(code) {
    if (typeof code !== "string") return code;
    let out = code;
    try {
      if (typeof root !== "undefined") {
        root.__mpAlterSnakeRan = true;
        root.__mpAlterHadMaEntry =
          /Ma\(\)\{if\(this\.menu\.isVisible\(\)\|\|this\.wb\.nj\)\{/.test(out);
        root.__mpAlterHadAaEqSa = /a\.Aa=a\.Sa/.test(out);
        root.__mpAlterHadAaSwitch = /switch\(this\.settings\.Aa\)\{/.test(out);
      }
    } catch (eMeta) { /* ignore */ }
    // Expression-safe (commas + arrow IIFEs): BurgerMod leaves
    // `window.__remixGame=this,window.burger_settings_snapshot&&...` — statement
    // try/catch after `=this` yields `}catch(...){},window.burger...` (SyntaxError).
    const boardCacheExpr =
      "(()=>{try{window.__mpBoardCache={body:this.oa&&this.oa.ka,apples:this.wa&&this.wa.ka,dir:this.oa&&this.oa.direction};}catch(_mp){}})()";
    const coopTickExpr =
      "(()=>{try{window.__mpCoopOnTick&&window.__mpCoopOnTick(this);}catch(_mpCoop){}})()" +
      ",(()=>{try{window.__mpRaceFocusOnTick&&window.__mpRaceFocusOnTick(this);}catch(_mpVf){}})()";
    const exposeThisExpr =
      "window.__remixGame=this,window.__mpGame=this," +
      boardCacheExpr +
      "," +
      coopTickExpr;
    if (out.indexOf("window.__remixGame=this") !== -1) {
      out = out.replace(/window\.__remixGame=this/g, exposeThisExpr);
    } else if (/\}tick\(\)\{/.test(out)) {
      out = out.replace(/\}tick\(\)\{/, "}tick(){" + exposeThisExpr + ";");
    } else if (/tick\(\)\s*\{/.test(out)) {
      out = out.replace(/tick\(\)\s*\{/, "tick(){" + exposeThisExpr + ";");
    }
    if (out.indexOf("__mpCoopOnTick") === -1 && /tick\(\)\s*\{/.test(out)) {
      out = out.replace(
        /tick\(\)\s*\{/,
        "tick(){(()=>{try{window.__mpCoopOnTick&&window.__mpCoopOnTick(this);}catch(_mpCoop){}})();"
      );
    }

    // Seat oa.ka from COOP_STATE *before* native body runs (wrap alone misses
    // the first call). Pass renderer so we write renderer.wb, not a stale __mpGame.
    // If seat still mismatches, skip native snake and draw auth board (local+peers).
    if (out.indexOf("__mpCoopRenderEnter") === -1) {
      if (/render\(a,b,c\)\{/.test(out)) {
        out = out.replace(
          /render\(a,b,c\)\{/g,
          "render(a,b,c){try{if(typeof a===\"number\"&&!isFinite(a))a=0;if(a==null)a=0;}catch(_mpSA){}try{window.__mpCoopSeatBeforeRender&&window.__mpCoopSeatBeforeRender(this);}catch(_mpSB){}try{window.__mpCoopRenderEnter&&window.__mpCoopRenderEnter(this,a,b,c);}catch(_mpRE){}try{if(window.__mpCoopSkipNativeRender&&window.__mpCoopSkipNativeRender(this)){try{(window.__mpCoopDrawAuthBoard||window.__mpCoopDrawRemotes)&&(window.__mpCoopDrawAuthBoard||window.__mpCoopDrawRemotes)(this);}catch(_mpDR){}return;}}catch(_mpSK){}"
        );
      }
    }
    if (out.indexOf("__mpCoopAfterSnakeRender") === -1) {
      out += "\n;void window.__mpCoopAfterSnakeRender;\n";
    }
    if (out.indexOf("__mpCoopFreePos") === -1) {
      out += "\n;window.__mpCoopFreePos=1;\n";
    }
    // Play's Ma() does Aa=Sa then Sna() bakes dims. Force size before bake.
    // Never inject before a labeled `a:switch` (steals label) or before `case`
    // inside a switch (SyntaxError).
    if (out.indexOf("__mpForceSaBeforeAa") === -1) {
      let patched = false;
      if (/Ma\(\)\{if\(this\.menu\.isVisible\(\)\|\|this\.wb\.nj\)\{/.test(out)) {
        // Ma only bakes when the settings menu is visible — Start Co-op closes
        // the panel first, so force the gate open when match settings are set.
        out = out.replace(
          /Ma\(\)\{if\(this\.menu\.isVisible\(\)\|\|this\.wb\.nj\)\{/,
          "Ma(){try{window.__mpPlayController=this;}catch(_mpCap){}if(this.menu.isVisible()||this.wb.nj||(window.__mpCoopPlaySettings&&window.__mpCoopPlaySettings.size!=null)||(window.__mpMatchPlaySettings&&window.__mpMatchPlaySettings.size!=null)){(()=>{try{window.__mpForceSaBeforeAa=1;var _mps=window.__mpCoopPlaySettings||window.__mpMatchPlaySettings;if(_mps&&_mps.size!=null&&this.settings){this.settings.Sa=Number(_mps.size)|0;this.settings.Aa=this.settings.Sa;}}catch(_mpMa){}})();"
        );
        patched = true;
      }
      if (/\}Sna\(\)\{/.test(out) && out.indexOf("__mpForceSnaCapture") === -1) {
        out = out.replace(
          /\}Sna\(\)\{/,
          "}Sna(){try{window.__mpPlayController=this;window.__mpForceSnaRan=1;window.__mpForceSnaCapture=1;}catch(_mpSnaCap){}"
        );
        patched = true;
      }
      if (/a\.Aa=a\.Sa/.test(out)) {
        out = out.replace(
          /a\.Aa=a\.Sa/g,
          "(()=>{try{var _mps=window.__mpCoopPlaySettings||window.__mpMatchPlaySettings;if(_mps&&_mps.size!=null){a.Sa=Number(_mps.size)|0;}window.__mpForceSaBeforeAa=1;}catch(_mpMa){}})(),a.Aa=a.Sa"
        );
        patched = true;
      }
      try {
        if (typeof root !== "undefined") root.__mpAlterSizePatched = patched;
      } catch (eP) { /* ignore */ }
    }
    return out;
  }

  /**
   * Place local snake at board center + oy after co-op Play.
   * Offsets come from SESSION_START slots (count-dependent: 2→±1, 3→0/+2/−2, 4→±1/+2/−2).
   * Does NOT force a facing direction — native Snake stays idle until the player
   * presses a key (forcing RIGHT made everyone crawl on Start match).
   *
   * Yin Yang uses corners instead: left side faces right, right side faces left
   * so the body trails off the edge. Direction is still left unset until the
   * shared start signal. Wall mode starts empty — seats are never slid.
   */
  function coopSpawnBodyFromPose(pose) {
    const dir = pose && pose.dir === "LEFT" ? "LEFT" : "RIGHT";
    const x = pose && pose.x != null ? pose.x | 0 : 0;
    const y = pose && pose.y != null ? pose.y | 0 : 0;
    if (dir === "LEFT") {
      return [
        { x: x, y: y },
        { x: x + 1, y: y },
        { x: x + 2, y: y },
      ];
    }
    return [
      { x: x, y: y },
      { x: x - 1, y: y },
      { x: x - 2, y: y },
    ];
  }

  function coopSpawnBodyInBounds(body, width, height) {
    if (!body || !body.length) return false;
    const w = width | 0;
    const h = height | 0;
    for (let i = 0; i < body.length; i++) {
      const p = body[i];
      if (!p) return false;
      const x = p.x | 0;
      const y = p.y | 0;
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
    }
    return true;
  }

  /**
   * Keep center+oy seats on the live board. Server oy (±2) is fine on classic
   * 17×15 — on tiny boards larger offsets can land off-grid onto the border
   * chrome (looks like impossible walls before anyone moves).
   */
  function clampCoopSpawnOy(oy, height) {
    const h = height | 0;
    if (h < 1) return 0;
    const cy0 = Math.floor(h / 2);
    let o = Number(oy) || 0;
    if (!Number.isFinite(o)) o = 0;
    let cy = cy0 + o;
    if (cy < 0) o = -cy0;
    else if (cy >= h) o = h - 1 - cy0;
    return o | 0;
  }

  /**
   * On small boards, distinct server oy values can clamp onto the same row.
   * Nudge by slot so seats stay on different cells when height allows.
   */
  function distinctCoopSpawnY(slotIndex, oy, height, takenYs) {
    const h = height | 0;
    const cy0 = Math.floor(h / 2);
    const clamped = clampCoopSpawnOy(oy, h);
    let y = cy0 + clamped;
    y = Math.max(0, Math.min(y, h - 1));
    const taken = takenYs || Object.create(null);
    if (!taken[y]) return y;
    // Prefer alternating offsets from preferred y
    for (let d = 1; d < h; d++) {
      const up = y - d;
      const down = y + d;
      if (up >= 0 && !taken[up]) return up;
      if (down < h && !taken[down]) return down;
    }
    // Last resort: slot modulo
    return Math.max(0, Math.min((slotIndex | 0) % Math.max(1, h), h - 1));
  }

  /** Seat pose from live board size (never trust a pose built for another size). */
  function coopSpawnPoseForSlot(slotIndex, oy, width, height, yinYang) {
    const w = width || 17;
    const h = height || 15;
    if (yinYang || coopIsYinYang()) {
      return coopYinYangCorner(slotIndex, w, h);
    }
    const taken = Object.create(null);
    try {
      const remotes = root.__mpCoopRemotes || {};
      Object.keys(remotes).forEach(function (id) {
        const r = remotes[id];
        const head = r && r.body && r.body[0];
        if (head && head.y != null) taken[head.y | 0] = true;
      });
    } catch (eT) { /* ignore */ }
    const y = distinctCoopSpawnY(slotIndex, oy, h, taken);
    let x = Math.floor(w / 2);
    // Length-3 RIGHT body is x, x-1, x-2 — keep head at least 2 from left edge
    if (w >= 3) x = Math.max(2, Math.min(x, w - 1));
    else x = Math.max(0, Math.min(x, w - 1));
    return {
      x: x,
      y: y,
      dir: "RIGHT",
    };
  }

  function coopYinYangCorner(slot, width, height) {
    const w = width || 17;
    const h = height || 15;
    const leftX = Math.min(2, Math.max(0, w - 1));
    const rightX = Math.max(leftX, w - 3);
    const topY = Math.min(1, Math.max(0, h - 1));
    const botY = Math.max(topY, h - 2);
    const corners = [
      { x: leftX, y: topY, dir: "RIGHT" },
      { x: rightX, y: topY, dir: "LEFT" },
      { x: leftX, y: botY, dir: "RIGHT" },
      { x: rightX, y: botY, dir: "LEFT" },
    ];
    return corners[(slot | 0) % 4];
  }

  function coopIsYinYang() {
    try {
      const key =
        (root.ModeRegistry &&
          typeof root.ModeRegistry.getCurrentModeKey === "function" &&
          root.ModeRegistry.getCurrentModeKey()) ||
        "";
      return String(key).toLowerCase().split("+").indexOf("yin_yang") >= 0;
    } catch (e) {
      return false;
    }
  }

  function applyCoopSpawnOffset(oy, opts) {
    opts = opts || {};
    const g = gameInstance();
    if (!g || !g.oa) return false;
    // Clear sticky death from warmup / prior run before writing the seat
    try {
      g.nj = false;
      if (g.dead != null) g.dead = false;
      if (g.isDead != null) g.isDead = false;
      if (root.timeKeeper) {
        root.timeKeeper._dead = false;
        root.timeKeeper.playing = true;
      }
      if (typeof window !== "undefined") {
        window.__mpCoopLocalDead = false;
      }
    } catch (eClear) { /* ignore */ }
    try {
      ensureCoopTickHosts(g);
    } catch (eAa) { /* ignore */ }
    const meta =
      (g.wa && g.wa.oa && g.wa.oa.oa) ||
      (g.oa && g.oa.oa) ||
      (g.settings && g.settings.grid) ||
      {};
    let w = firstNumber(meta.width, meta.W) || null;
    let h = firstNumber(meta.height, meta.H) || null;
    try {
      const wa = g.Ca && g.Ca.wa;
      if (Array.isArray(wa) && wa.length) {
        if (w == null) w = wa[0] && wa[0].length;
        if (h == null) h = wa.length;
      }
    } catch (eSz) { /* ignore */ }
    w = w || 17;
    h = h || 15;
    let pose = null;
    const sx = opts.x != null ? Number(opts.x) : NaN;
    const sy = opts.y != null ? Number(opts.y) : NaN;
    const refW =
      opts.boardWidth != null ? Number(opts.boardWidth) : null;
    const refH =
      opts.boardHeight != null ? Number(opts.boardHeight) : null;
    // Slot dims may disagree with a failed bake. Still seat on the LIVE board
    // via oy/slot — never leave Classic-center with no offset.
    const dimsMismatch =
      refW != null &&
      refH != null &&
      Number.isFinite(refW) &&
      Number.isFinite(refH) &&
      ((refW | 0) !== (w | 0) || (refH | 0) !== (h | 0));
    if (dimsMismatch) {
      try {
        console.warn(
          "[Multiplayer] applyCoopSpawnOffset: slot board",
          refW,
          "x",
          refH,
          "vs live",
          w,
          "x",
          h,
          "— seating via oy on live grid"
        );
      } catch (eWarn) { /* ignore */ }
    }
    // Prefer server absolute seat only when dims match and coords land in-bounds.
    if (
      !dimsMismatch &&
      Number.isFinite(sx) &&
      Number.isFinite(sy) &&
      sx >= 0 &&
      sy >= 0 &&
      sx < w &&
      sy < h &&
      !(opts.yinYang || coopIsYinYang())
    ) {
      pose = {
        x: Math.round(sx),
        y: Math.round(sy),
        dir: opts.dir || "RIGHT",
      };
    } else if (
      !dimsMismatch &&
      Number.isFinite(sx) &&
      Number.isFinite(sy) &&
      !(opts.yinYang || coopIsYinYang())
    ) {
      pose = {
        x: Math.max(0, Math.min(Math.round(sx), w - 1)),
        y: Math.max(0, Math.min(Math.round(sy), h - 1)),
        dir: opts.dir || "RIGHT",
      };
    } else {
      pose = coopSpawnPoseForSlot(
        opts.slot != null ? opts.slot : 0,
        oy,
        w,
        h,
        opts.yinYang
      );
    }
    root.__mpLastCoopSpawnPose = pose;
    // Slide off solids / peers / illegal dead-ends when possible
    try {
      const cleared = findClearCoopSpawnPose(pose, {
        width: w,
        height: h,
        game: g,
      });
      if (cleared && cleared.x != null) {
        pose = cleared;
        root.__mpLastCoopSpawnPose = pose;
      }
    } catch (eClear) { /* keep original seat */ }
    const body = coopSpawnBodyFromPose(pose);
    try {
      // Keep native idle-until-key behavior: do not assign direction here.
      return writeNativeBody(g.oa, body);
    } catch (e) {
      console.warn("applyCoopSpawnOffset", e);
      return false;
    }
  }

  /** First co-op player moved: give this idle snake its spawn facing so it crawls. */
  function applyCoopStartMoving(dir) {
    const g = gameInstance();
    if (!g || !g.oa) return false;
    const cur = g.oa.direction || g.oa.dir;
    if (cur) return true;
    const d = dir === "LEFT" || dir === "UP" || dir === "DOWN" ? dir : "RIGHT";
    try {
      g.oa.direction = d;
      if ("dir" in g.oa) g.oa.dir = d;
      root.pauseGame = 0;
      if (g.nj) g.nj = false;
      return true;
    } catch (e) {
      console.warn("applyCoopStartMoving", e);
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
    // Match-end menus own the overlay — do not re-hide after ALL_DEAD/ALL_APPLES.
    if (root.__mpCoopMatchEndMenus) return;
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay) return;
    if (overlay.dataset.mpDeathPrevVis == null) {
      overlay.dataset.mpDeathPrevVis = overlay.style.visibility || "";
      overlay.dataset.mpDeathPrevOp = overlay.style.opacity || "";
    }
    overlay.style.visibility = "hidden";
    overlay.style.opacity = "0";
    overlay.style.pointerEvents = "none";
  }

  function restoreDeathScreen() {
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (!overlay || overlay.dataset.mpDeathPrevVis == null) return;
    overlay.style.visibility = overlay.dataset.mpDeathPrevVis;
    overlay.style.opacity = overlay.dataset.mpDeathPrevOp || "";
    overlay.style.pointerEvents = "";
    delete overlay.dataset.mpDeathPrevVis;
    delete overlay.dataset.mpDeathPrevOp;
  }

  function setNativeMenusLocked(locked, playOnly) {
    // Ready / lobby lock removed — always clear pointer-events so trophy,
    // count, speed, size, theme, and color stay clickable while connected.
    if (!playOnly) {
      SYNC_KEYS.forEach(function (id) {
        const row = document.getElementById(id);
        if (!row) return;
        row.style.pointerEvents = "";
        row.style.opacity = "";
        row.title = "";
      });
      unlockPersonalMenus();
    }
    // Play is owned by MultiplayerApp._paintPlayAsStartMatch (admin Start Match /
    // Start Co-op). Menu lock must not dim or disable it.
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

  /** Always disable Play while in a multiplayer room (non-admin / mid-match). */
  function setPlayButtonLocked(locked) {
    const play = playButton();
    if (!play) return;
    play.style.pointerEvents = locked ? "none" : "";
    play.style.opacity = locked ? "0.55" : "";
    if (locked && !play.title) {
      play.title = "Waiting for the room admin to start";
    }
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

  /** Live meta/grid size from GameInstance (after Play bake). */
  function boardSizeFromGame(g) {
    g = g || gameInstance();
    if (!g) return null;
    try {
      const meta =
        (g.oa && g.oa.oa) ||
        (g.wa && g.wa.oa && g.wa.oa.oa) ||
        null;
      let w = meta ? firstNumber(meta.width, meta.W) : null;
      let h = meta ? firstNumber(meta.height, meta.H) : null;
      if (!(w > 0) || !(h > 0)) {
        const wa = g.Ca && g.Ca.wa;
        if (Array.isArray(wa) && wa.length && Array.isArray(wa[0])) {
          h = wa.length;
          w = wa[0].length;
        }
      }
      if (!(w > 0) || !(h > 0)) return null;
      return { width: w | 0, height: h | 0 };
    } catch (e) {
      return null;
    }
  }

  /** Size menu index → Classic board dims (matches server coop::board_dims). */
  function boardDimsForSizeIndex(sizeIndex) {
    const idx = Number(sizeIndex);
    if (idx === 1) return { width: 10, height: 9 };
    if (idx === 2) return { width: 24, height: 21 };
    return { width: 17, height: 15 };
  }

  /**
   * True when the live GameInstance grid matches frozen match settings / slot dims.
   * DOM menu match is not enough — Play can still bake Standard.
   */
  function liveBoardMatchesSettings(settings, g) {
    if (!settings || typeof settings !== "object") return true;
    let wantW = null;
    let wantH = null;
    if (settings.boardWidth != null && settings.boardHeight != null) {
      wantW = Number(settings.boardWidth) | 0;
      wantH = Number(settings.boardHeight) | 0;
    } else if (settings.size != null && Number.isFinite(Number(settings.size))) {
      const dims = boardDimsForSizeIndex(settings.size);
      wantW = dims.width;
      wantH = dims.height;
    } else {
      // No size in payload — still refuse if live board is missing (not "ok")
      const liveOnly = boardSizeFromGame(g);
      return !!liveOnly;
    }
    if (!(wantW > 0) || !(wantH > 0)) return true;
    const live = boardSizeFromGame(g);
    if (!live) return false;
    return (live.width | 0) === (wantW | 0) && (live.height | 0) === (wantH | 0);
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
      // Full quit path — chrome-only was leaving settings rows dead
      return quitNativeRunForMenus({
        skipEscapeDispatch: !!opts.skipEscapeDispatch,
        pulse: opts.pulse,
      });
    }
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (overlay) {
      overlay.style.visibility = "visible";
      overlay.style.opacity = "1";
      const menu = overlay.children && overlay.children[0];
      if (menu) menu.style.visibility = "visible";
    }
    unlockPersonalMenus();
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
   * Slim co-op pose scrape: body + dir + alive + score (+ colors when
   * includeColors). No width/height on the pose channel (reduces lag); score is
   * one integer and feeds the combined co-op total.
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
    const body = mapBody(bodySrc, snakeDimFlags(snake));
    const scoreInfo = readScoreAndAlive();
    const bodyDir = inferDirectionFromBody(body);
    const moveDir =
      normalizePoseDirection(snake.direction || snake.dir) ||
      bodyDir ||
      readNativeDirection(snake) ||
      normalizePoseDirection(root.head_dir);
    const faceDir =
      readNativeFaceDirection(snake) || bodyDir || moveDir;
    const transDir =
      readNativeTransitionDirection(snake) || faceDir || moveDir;
    const out = {
      body: body,
      dir: moveDir,
      headDir: faceDir,
      movementDir: moveDir,
      transitionDir: transDir,
      modeKey: effectiveModeKey(),
      alive: scoreInfo.alive !== false,
      score: scoreInfo.score != null ? scoreInfo.score | 0 : 0,
    };
    const flags = segmentFlags(body);
    if (flags) out.segmentFlags = flags;
    try {
      const key = scrapeModeKey();
      const parts = String(key).toLowerCase().split("+");
      if (
        parts.indexOf("peaceful") >= 0 ||
        (root.cat_peaceful_ticks | 0) > 0 ||
        (typeof root.chess_peaceful_active === "function" &&
          root.chess_peaceful_active())
      ) {
        out.peaceful = true;
      }
      // Yin Yang companion (Twin has no second snake)
      if (parts.indexOf("yin_yang") >= 0) {
        let w = 17;
        let h = 15;
        try {
          const meta =
            (g && g.wa && g.wa.oa && g.wa.oa.oa) ||
            (g && g.oa && g.oa.oa) ||
            {};
          if (meta.width) w = meta.width | 0;
          if (meta.height) h = meta.height | 0;
        } catch (eSz) { /* defaults */ }
        const body2 = scrapeCompanionBody(g, body, w, h);
        if (body2 && body2.length) {
          out.body2 = body2;
          const companion = findCompanionSnake(g, snake);
          const dir2 = companion
            ? readNativeDirection(companion) || reflectDirection(out.headDir)
            : reflectDirection(out.headDir);
          const face2 = companion
            ? readNativeFaceDirection(companion) || dir2
            : dir2;
          const trans2 = companion
            ? readNativeTransitionDirection(companion) || face2
            : face2;
          out.headDir2 = face2;
          out.movementDir2 = dir2;
          out.transitionDir2 = trans2;
          const flags2 = segmentFlags(body2);
          if (flags2) out.segmentFlags2 = flags2;
          if (companion) {
            if (typeof companion.Sc === "string") out.Sc2 = companion.Sc;
            if (typeof companion.Yc === "string") out.Yc2 = companion.Yc;
            if (typeof companion.color1 === "string") out.color1_2 = companion.color1;
            if (typeof companion.color2 === "string") out.color2_2 = companion.color2;
          }
        }
      }
    } catch (eP) { /* ignore */ }
    try {
      if (typeof boardSnakePoisoned === "function") {
        if (boardSnakePoisoned({ poisonTicks: root.__mpBoardCache && root.__mpBoardCache.poisonTicks }) ||
            (g && g.oa && (g.oa.Ja > 0 || g.oa.poisonTicks > 0))) {
          out.poisoned = true;
        }
      }
      // Poison ticks live on the snake / board in several builds
      const ticks =
        (g && g.oa && (g.oa.Ja != null ? g.oa.Ja : g.oa.poisonTicks)) ||
        (root.__mpBoardCache && root.__mpBoardCache.poisonTicks);
      if (ticks != null && Number(ticks) > 0) out.poisoned = true;
    } catch (ePo) { /* ignore */ }
    try {
      const lights = scrapeSnakeLights(g);
      if (lights && lights.headLight != null) out.headLight = lights.headLight;
      if (lights && lights.headLight2 != null) out.headLight2 = lights.headLight2;
    } catch (eL) { /* ignore */ }
    try {
      if (root.__slotActive != null && Number.isFinite(Number(root.__slotActive))) {
        out.slotActive = Number(root.__slotActive) | 0;
      }
    } catch (eS) { /* ignore */ }
    if (!includeColors) return out;

    const Colors = root.MultiplayerColors;
    let color1 = null;
    let color2 = null;
    let Sc = null;
    let Yc = null;
    // Prefer claimed colorId over live snake paint — Ready bumps roster
    // before the engine snake is recolored, and peers must see the claim.
    if (colorId != null && Colors && Colors.getColor) {
      const c = Colors.getColor(colorId);
      if (c) {
        if (c.kind === "rainbow" && c.set && c.set.length) {
          Sc = c.set[0];
          Yc = c.set[1] || c.set[0];
        } else if (c.primary) {
          Sc = c.primary;
          Yc = c.secondary || c.primary;
        }
        color2 = Sc;
        color1 = Yc;
      }
    }
    try {
      const cfg = g && (g.snakeBodyConfig || snake);
      if (!Sc && snake && typeof snake.Sc === "string") Sc = snake.Sc;
      if (!Yc && snake && typeof snake.Yc === "string") Yc = snake.Yc;
      if (cfg) {
        if (!color1) color1 = cfg.color1 || cfg.secondary || Yc || null;
        if (!color2) color2 = cfg.color2 || cfg.primary || Sc || null;
        if (!Sc && typeof cfg.Sc === "string") Sc = cfg.Sc;
        if (!Yc && typeof cfg.Yc === "string") Yc = cfg.Yc;
      }
    } catch (e) { /* ignore */ }
    out.colorId = colorId != null ? colorId : null;
    out.color1 = color1;
    out.color2 = color2;
    out.Sc = Sc;
    out.Yc = Yc;
    return out;
  }

  function snakeDeltaFingerprint(delta) {
    if (!delta) return "";
    function path(body) {
      let out = "";
      for (let i = 0; i < (body || []).length; i++) {
        const p = body[i] || {};
        out += (i ? ";" : "") + (p.x | 0) + "," + (p.y | 0) +
          (p.otherDim ? "d" : "");
      }
      return out;
    }
    function turns(list) {
      return (list || []).map(function (turn) {
        const at = turn.at || {};
        return [
          turn.turnSeq | 0,
          (at.x | 0) + "," + (at.y | 0),
          turn.fromDir || "",
          turn.toDir || "",
          turn.moveSeq | 0,
        ].join(":");
      }).join(";");
    }
    return [
      delta.alive === false ? "0" : "1",
      delta.score != null ? delta.score : "",
      delta.moveSeq != null ? delta.moveSeq : "",
      delta.dir || "",
      delta.movementDir || "",
      delta.headDir || "",
      delta.transitionDir || "",
      delta.modeKey || "",
      path(delta.body),
      path(delta.body2),
      (delta.segmentFlags || []).join(""),
      (delta.segmentFlags2 || []).join(""),
      delta.movementDir2 || "",
      delta.headDir2 || "",
      delta.transitionDir2 || "",
      delta.headLight != null ? delta.headLight : "",
      delta.headLight2 != null ? delta.headLight2 : "",
      delta.colorId != null ? delta.colorId : "",
      delta.color1 || "",
      delta.color2 || "",
      delta.Sc || "",
      delta.Yc || "",
      delta.color1_2 || "",
      delta.color2_2 || "",
      delta.Sc2 || "",
      delta.Yc2 || "",
      delta.poisoned ? "p" : "",
      delta.peaceful ? "q" : "",
      delta.slotActive != null ? delta.slotActive : "",
      turns(delta.turns),
    ].join("|");
  }

  /** Compact board identity for race mosaic upload skip. */
  function boardDeltaFingerprint(board) {
    if (!board) return "";
    const body = board.body || [];
    const h = body[0];
    const apples = board.apples || [];
    const a0 = apples[0];
    const body2 = board.body2 || [];
    const h2 = body2[0];
    function len(arr) {
      return (arr && arr.length) || 0;
    }
    return (
      (board.alive === false ? "0" : "1") +
      "|" +
      (board.dir || "") +
      "|" +
      body.length +
      "|" +
      (h ? h.x + "," + h.y : "") +
      "|" +
      (board.score != null ? board.score : "") +
      "|" +
      apples.length +
      "|" +
      (a0
        ? a0.x +
          "," +
          a0.y +
          (a0.type != null ? ":" + a0.type : "") +
          (a0.isPiece ? ":P" : "") +
          (a0.shields ? ":s" + a0.shields.join("") : "") +
          (a0.otherDim ? ":D" : "")
        : "") +
      "|" +
      (function () {
        // Dimension: mosaic paints solid and ghost stretches of the body, so
        // where the runs split matters, not just how many segments are ghosted
        // — a swap inverts every flag and can leave the count untouched. Runs
        // stay short (steps unshift at the head, the tail pops), so this is a
        // few characters in practice.
        let runs = "";
        let cur = null;
        let n = 0;
        for (let i = 0; i < body.length; i++) {
          const ghost = !!(body[i] && body[i].otherDim);
          if (ghost === cur) {
            n++;
            continue;
          }
          if (cur !== null) runs += (cur ? "D" : "S") + n;
          cur = ghost;
          n = 1;
        }
        if (cur !== null) runs += (cur ? "D" : "S") + n;
        let ghostApples = 0;
        for (let j = 0; j < apples.length; j++) {
          if (apples[j] && apples[j].otherDim) ghostApples++;
        }
        return runs + ":" + ghostApples;
      })() +
      "|" +
      (board.colorId != null ? board.colorId : "") +
      "|" +
      (board.Sc || "") +
      "|" +
      (board.Yc || "") +
      "|" +
      (boardSnakePoisoned(board) ? "p" : "") +
      "|" +
      (board.modeKey || "") +
      "|" +
      len(board.walls) +
      "," +
      len(board.keys) +
      "," +
      len(board.boxes) +
      "," +
      len(board.goals) +
      "," +
      len(board.mines) +
      "," +
      len(board.statues) +
      "," +
      len(board.bridges) +
      "," +
      len(board.gates) +
      "," +
      len(board.arrows) +
      "|" +
      (board.headLight != null ? board.headLight : "") +
      "|" +
      body2.length +
      "|" +
      (h2 ? h2.x + "," + h2.y : "") +
      "|" +
      (function () {
        const snakes = board.snakes || [];
        if (!snakes.length) return "0";
        let s = String(snakes.length);
        for (let i = 0; i < snakes.length; i++) {
          const sn = snakes[i];
          const b = (sn && sn.body) || [];
          const hh = b[0];
          s +=
            ";" +
            b.length +
            ":" +
            (hh ? hh.x + "," + hh.y : "") +
            ":" +
            (sn && sn.alive === false ? "0" : "1");
        }
        return s;
      })() +
      "|" +
      (board.catLives != null ? board.catLives : "") +
      "," +
      (board.catGrace != null ? board.catGrace : "") +
      "|" +
      (function () {
        // Zones move with eats and each armed tick redraws the pulse
        const zs = board.bombZones;
        if (!zs || !zs.length) return "";
        let s = "";
        for (let i = 0; i < zs.length; i++) {
          const z = zs[i];
          if (!z) continue;
          s +=
            (i ? ";" : "") +
            z.x +
            "," +
            z.y +
            "," +
            (z.arm != null ? z.arm : -1);
        }
        return s;
      })() +
      "|" +
      (function () {
        // Slot badges reshuffle across every fruit on a badge eat, and Yin Yang
        // flips them in place, so a0 alone would not notice the change.
        let s = "";
        let any = false;
        for (let i = 0; i < apples.length; i++) {
          const a = apples[i];
          const m = a && a.slotMode != null ? a.slotMode : "";
          if (m !== "") any = true;
          s += (i ? "," : "") + m;
        }
        return any ? s : "";
      })()
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
      themeColors: board.themeColors || getBoardThemeColors(),
      appleIndex: board.appleIndex,
    };
    // Heavy board entities only when requested (trophy modes) — default fruit-only
    if (opts.includeEntities) {
      const entities = scrapeBoardEntities();
      // Re-filter against the known size, same as the mosaic board scrape
      out.walls = filterMosaicWalls(entities.walls, board.width, board.height);
      out.keys = entities.keys;
      out.boxes = entities.boxes;
      out.goals = entities.goals;
      out.mines = entities.mines;
      out.statues = entities.statues;
      out.bridges = entities.bridges;
      out.gates = entities.gates;
      out.arrows = entities.arrows;
      out.bombZones = entities.bombZones;
      out.headLight = entities.headLight;
      out.score = board.score;
    }
    return out;
  }

  function collectablesFingerprint(cols) {
    if (!cols) return "";
    function len(arr) {
      return (arr && arr.length) || 0;
    }
    const apples = cols.apples || [];
    // Winged: ignore live x/y so drifting fruit does not republish every tile.
    // Reseeds use force=true on publish; peers trust local He between seeds.
    const trustMotion =
      !!cols.fruitMotionTrust || isCoopFruitMotionMode();
    let fruit = "";
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a) continue;
      fruit +=
        (i ? ";" : "") +
        (trustMotion ? "m" : (a.x | 0) + "," + (a.y | 0) + ",") +
        (a.type != null ? a.type : "") +
        (a.poison ? "p" : "") +
        (a.slotMode != null ? "s" + a.slotMode : "") +
        (a.burgerTimer != null ? "b" + a.burgerTimer : "") +
        (a.isPiece ? "c" + (a.chessPiece || "") : "") +
        // Shield mode gains/losses can be the only change on the board
        (a.shields && a.shields.length ? "h" + a.shields.join("") : "") +
        (a.otherDim ? "d" : "");
    }
    return [
      fruit,
      (function () {
        const walls = cols.walls || [];
        if (!walls.length) return "0";
        const parts = [];
        for (let i = 0; i < walls.length; i++) {
          const w = walls[i];
          if (!w) continue;
          parts.push(
            (w.x | 0) +
              "," +
              (w.y | 0) +
              (w.temp ? "t" : "") +
              (w.lock ? "l" : "") +
              (w.hotdog ? "h" : "") +
              (w.lockType != null ? ":" + w.lockType : "")
          );
        }
        parts.sort();
        return parts.join(";");
      })(),
      pointListFingerprint(cols.keys, function (k) {
        return (
          (k.type != null ? "t" + k.type : "") +
          (k.keyblock
            ? "b" + (k.keyblock.x | 0) + "," + (k.keyblock.y | 0)
            : "")
        );
      }),
      pointListFingerprint(cols.boxes),
      pointListFingerprint(cols.goals),
      pointListFingerprint(cols.mines, function (m) {
        return m.xL != null ? "x" + m.xL : "";
      }),
      pointListFingerprint(cols.statues, function (s) {
        return (s.cracked ? "c" : "") + (s.angle != null ? "a" + s.angle : "");
      }),
      pointListFingerprint(cols.bridges),
      pointListFingerprint(cols.gates),
      pointListFingerprint(cols.arrows, function (a) {
        return a.dir || a.direction || "";
      }),
      pointListFingerprint(cols.bombZones),
    ].join("|");
  }

  /** Sorted x,y[+extra] fingerprint so key/soko moves republish. */
  function pointListFingerprint(list, extraFn) {
    if (!list || !list.length) return "0";
    const parts = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.x == null || p.y == null) continue;
      parts.push(
        (p.x | 0) +
          "," +
          (p.y | 0) +
          (extraFn ? extraFn(p) : "")
      );
    }
    parts.sort();
    return parts.length ? parts.join(";") : "0";
  }

  /**
   * During co-op, if fruit lands on any snake cell (local or remote) or a wall,
   * nudge to a free cell. Used on apply and on the eater's publish path.
   */
  function nudgeCoopApplesOffSnakes(apples, game) {
    if (!Array.isArray(apples) || !apples.length) return apples;
    if (!root.__mpCoopSession || !root.__mpCoopInject) return apples;
    const readOcc =
      root.__mpCoopReadSpawnOccupancy || root.__mpCoopReadOccupancy;
    const findFree = root.__mpCoopFindFreeSpawn;
    if (typeof readOcc !== "function") return apples;

    const placed = [];
    const reserved = {};

    function blockedKeys() {
      const occ = Object.assign({}, readOcc(game, true));
      Object.keys(reserved).forEach(function (k) {
        occ[k] = true;
      });
      return occ;
    }

    for (let i = 0; i < apples.length; i++) {
      const src = apples[i];
      const a = src ? Object.assign({}, src) : { x: 0, y: 0 };
      const x = a.x != null ? a.x | 0 : 0;
      const y = a.y != null ? a.y | 0 : 0;
      const k = x + "," + y;
      const occ = blockedKeys();
      const onWall =
        typeof root.__mpCoopIsSolidWall === "function" &&
        root.__mpCoopIsSolidWall(game, x, y);
      if (!occ[k] && !onWall) {
        reserved[k] = true;
        a.x = x;
        a.y = y;
        placed.push(a);
        continue;
      }
      let free = null;
      if (typeof findFree === "function") {
        free = findFree(game, occ);
      }
      if (!free) {
        const meta =
          (game && game.wa && game.wa.oa && game.wa.oa.oa) ||
          (game && game.oa && game.oa.oa) ||
          {};
        const w = firstNumber(meta.width, meta.W, 17) || 17;
        const h = firstNumber(meta.height, meta.H, 15) || 15;
        outer: for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const kk = xx + "," + yy;
            if (occ[kk]) continue;
            if (
              typeof root.__mpCoopIsSolidWall === "function" &&
              root.__mpCoopIsSolidWall(game, xx, yy)
            ) {
              continue;
            }
            free = { x: xx, y: yy };
            break outer;
          }
        }
      }
      if (free) {
        a.x = free.x;
        a.y = free.y;
        reserved[free.x + "," + free.y] = true;
        placed.push(a);
      } else {
        // Cannot place this apple — drop it. ALL_APPLES only when the board is
        // truly packed (no free cell) and no fruit remain after the pass.
        if (!root.__mpCoopServerAuth) {
          /* leave unplaced; caller may check empty+packed */
        }
      }
    }
    if (
      !root.__mpCoopServerAuth &&
      !placed.length &&
      apples &&
      apples.length
    ) {
      // Every apple failed to place — packed board → win; otherwise just empty.
      let anyFree = false;
      try {
        const meta =
          (game && game.wa && game.wa.oa && game.wa.oa.oa) ||
          (game && game.oa && game.oa.oa) ||
          {};
        const w = firstNumber(meta.width, meta.W, 17) || 17;
        const h = firstNumber(meta.height, meta.H, 15) || 15;
        const occ = Object.assign(
          {},
          typeof root.__mpCoopReadSpawnOccupancy === "function"
            ? root.__mpCoopReadSpawnOccupancy(game, true) || {}
            : {}
        );
        outerPack: for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            if (occ[xx + "," + yy]) continue;
            if (
              typeof root.__mpCoopIsSolidWall === "function" &&
              root.__mpCoopIsSolidWall(game, xx, yy)
            ) {
              continue;
            }
            anyFree = true;
            break outerPack;
          }
        }
      } catch (ePack) {
        anyFree = true;
      }
      if (!anyFree) {
        root.__mpCoopBoardFull = true;
        if (typeof root.__mpCoopOnBoardFull === "function") {
          try {
            root.__mpCoopOnBoardFull();
          } catch (eFull) { /* ignore */ }
        }
      } else {
        root.__mpCoopBoardFull = false;
      }
    }
    return placed;
  }

  /** Pudding/vanilla Count index → simultaneous apples on the board. */
  function expectedAppleCountFromSettings() {
    try {
      if (typeof root.getPortalPairMinimum === "function") {
        const n = Number(root.getPortalPairMinimum());
        if (Number.isFinite(n) && n > 0) return n | 0;
      }
    } catch (eMin) { /* ignore */ }
    let idx = readSettingIndex("count");
    if (idx == null) {
      try {
        if (root.timeKeeper && typeof root.timeKeeper.getCurrentSetting === "function") {
          idx = root.timeKeeper.getCurrentSetting("count");
        }
      } catch (eTk) { /* ignore */ }
    }
    idx = Number(idx);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    // Matches Pudding COUNT_MINIMA (1 / 3 / 5 / 10 / dice / bowl / …)
    const minima = { 0: 1, 1: 3, 2: 5, 3: 10, 4: 6, 5: 24, 6: 5 };
    return minima[idx] != null ? minima[idx] : 1;
  }

  /** Occupancy set for force-bake fruit seed when native freePos is missing. */
  function coopOccupiedCells(g) {
    const occ = Object.create(null);
    function mark(x, y) {
      if (x == null || y == null) return;
      occ[(Number(x) | 0) + "," + (Number(y) | 0)] = 1;
    }
    try {
      const snakes = [];
      if (g && g.oa) snakes.push(g.oa);
      if (g && Array.isArray(g.__mpPeerSnakes)) {
        for (let i = 0; i < g.__mpPeerSnakes.length; i++) {
          if (g.__mpPeerSnakes[i]) snakes.push(g.__mpPeerSnakes[i]);
        }
      }
      for (let s = 0; s < snakes.length; s++) {
        const body = snakes[s] && snakes[s].ka;
        if (!Array.isArray(body)) continue;
        for (let i = 0; i < body.length; i++) {
          const p = body[i];
          if (!p) continue;
          mark(p.x != null ? p.x : p.Xa, p.y != null ? p.y : p.Ya);
        }
      }
      if (g && g.wa && Array.isArray(g.wa.ka)) {
        for (let i = 0; i < g.wa.ka.length; i++) {
          const a = g.wa.ka[i];
          const p = a && a.pos;
          if (p) mark(p.x, p.y);
        }
      }
      if (g && g.Ca && Array.isArray(g.Ca.wa)) {
        for (let y = 0; y < g.Ca.wa.length; y++) {
          const row = g.Ca.wa[y];
          if (!row) continue;
          for (let x = 0; x < row.length; x++) {
            if (row[x]) mark(x, y);
          }
        }
      }
    } catch (eOcc) { /* ignore */ }
    return occ;
  }

  /** Grid scan free cell — used when Ma()/Sna() never ran so g.Rb is missing. */
  function coopFallbackFreePos(g) {
    const live = boardSizeFromGame(g) || {};
    const w = Math.max(1, Number(live.width) || 10);
    const h = Math.max(1, Number(live.height) || 9);
    const occ = coopOccupiedCells(g);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!occ[x + "," + y]) return { x: x, y: y };
      }
    }
    return null;
  }

  /**
   * Top up native fruit so the live Count setting is respected after co-op
   * seat / sync. Never shrinks (special modes may hold fewer briefly).
   */
  function ensureCoopFruitCount(gIn) {
    if (root.__mpCoopServerAuth) return false;
    const g = gIn || gameInstance();
    if (!g) return false;
    if (!ensureFruitHostTemplate(g)) return false;
    if (!g.wa || !Array.isArray(g.wa.ka)) return false;
    const want = expectedAppleCountFromSettings();
    if (!(want > 0)) return false;
    if (g.wa.ka.length >= want) return true;
    let planted = 0;
    const nativeFree =
      (typeof g.Rb === "function" && g.Rb.bind(g)) ||
      (typeof g.Tb === "function" && g.Tb.bind(g)) ||
      null;
    let template = null;
    for (let t = 0; t < g.wa.ka.length; t++) {
      if (g.wa.ka[t]) {
        template = g.wa.ka[t];
        break;
      }
    }
    while (g.wa.ka.length < want && planted < 64) {
      planted++;
      let pos = null;
      if (nativeFree) {
        try {
          pos = nativeFree(null, 0);
        } catch (eFp) {
          pos = null;
        }
      }
      if (!pos || pos.x == null || pos.y == null) {
        pos = coopFallbackFreePos(g);
      }
      if (!pos || pos.x == null || pos.y == null) break;
      const fruit = {};
      if (template) {
        try {
          Object.keys(template).forEach(function (k) {
            if (
              k === "pos" ||
              k === "He" ||
              k === "CAb" ||
              k === "iL" ||
              k === "nba" ||
              k === "Oba"
            ) {
              return;
            }
            fruit[k] = template[k];
          });
        } catch (eC) { /* ignore */ }
      }
      fruit.pos = makeNativePoint(
        pos.x,
        pos.y,
        template && template.pos
      );
      if (fruit.type == null) fruit.type = matchAppleType();
      if (fruit.nba == null) fruit.nba = new Set();
      g.wa.ka.push(fruit);
    }
    return g.wa.ka.length >= want;
  }

  /** Max shared apples: board cells minus walls minus length-3 seats. */
  function coopAppleGoal(width, height, playerCount, wallCount) {
    const w = Math.max(1, Number(width) || 17);
    const h = Math.max(1, Number(height) || 15);
    const n = Math.max(1, Number(playerCount) || 1);
    const walls = Math.max(0, Number(wallCount) || 0);
    return Math.max(1, w * h - walls - 3 * n);
  }

  /** Write apple positions into exposed game fields; grow/shrink list to match owner. */
  function applyCollectables(payload) {
    if (!payload || !payload.apples) return false;
    const g = gameInstance();
    let apples = payload.apples;
    const motionMode =
      !!payload.fruitMotionTrust ||
      !!payload.fruitMotionSeed ||
      isCoopFruitMotionMode();
    // Between winged seeds, never yank live fruit back to a lagged peer pose
    const trustLiveMotion = motionMode && !payload.fruitMotionSeed;
    try {
      // Initial relay into a missing/empty post-force-bake host — seed Od first
      if (payload.initial && g && apples.length > 0) {
        ensureFruitHostTemplate(g);
      }
      if (
        !trustLiveMotion &&
        !payload.exactBoard &&
        !payload.serverAuth &&
        !root.__mpCoopServerAuth
      ) {
        apples = nudgeCoopApplesOffSnakes(apples, g);
      }
      if (g && g.wa && Array.isArray(g.wa.ka)) {
        // Hard reset only on explicit request (new session). Mid-match must
        // keep fruit object identity or native eat/spawn anims restart forever.
        if (
          (payload.hardReset || root.__mpCoopFruitHardReset) &&
          (payload.serverAuth || root.__mpCoopServerAuth)
        ) {
          g.wa.ka.length = 0;
          root.__mpCoopFruitHardReset = false;
        }
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
        // Initial relay into an empty pre-Play host has no Od template — seed one
        // after Play/force-bake so pending COLLECTABLES can land.
        if (
          payload.initial &&
          apples.length > 0 &&
          !templatePos &&
          g.wa.ka.length === 0
        ) {
          if (!ensureFruitHostTemplate(g)) return false;
          templateApple = g.wa.ka[0];
          templatePos =
            templateApple && templateApple.pos && templateApple.pos.clone
              ? templateApple.pos
              : null;
          if (!templatePos) return false;
        }
        while (g.wa.ka.length > apples.length) {
          // Never drop below Count-setting floor when a peer sends a short list
          // (client-auth only). Exact initial relay boards and server-auth are exact.
          if (
            root.__mpCoopSession &&
            !root.__mpCoopServerAuth &&
            !payload.serverAuth &&
            !payload.initial &&
            g.wa.ka.length <= expectedAppleCountFromSettings()
          ) {
            break;
          }
          g.wa.ka.pop();
        }
        for (let i = 0; i < apples.length; i++) {
          const src = apples[i];
          let dst = g.wa.ka[i];
          const isNew = !dst;
          if (!dst) {
            dst = {};
            if (templateApple) {
              try {
                Object.keys(templateApple).forEach(function (k) {
                  // Match Remix fruit clone — never copy shield Sets (may be null)
                  if (
                    k === "pos" ||
                    k === "He" ||
                    k === "CAb" ||
                    k === "iL" ||
                    k === "nba" ||
                    k === "Oba" ||
                    k === "mouth" ||
                    k === "eating" ||
                    k === "eatProgress" ||
                    k === "burgerTimer" ||
                    k === "burgerTimerMax"
                  ) {
                    return;
                  }
                  dst[k] = templateApple[k];
                });
              } catch (e) { /* ignore */ }
            }
            dst.pos = makeNativePoint(src.x, src.y, templatePos);
            dst.type = src.type != null ? src.type : dst.type != null ? dst.type : 0;
            g.wa.ka[i] = dst;
            if (!templatePos && dst.pos) templatePos = dst.pos;
            if (!templateApple) templateApple = dst;
            applyFruitHe(dst, src, g);
          } else if (trustLiveMotion && !isNew) {
            // Keep local pos + He; only refresh static fruit metadata below
          } else if (dst.pos || templatePos) {
            dst.pos = ensureNativePos(dst.pos, src.x, src.y, templatePos);
            if (!templatePos && dst.pos) templatePos = dst.pos;
            applyFruitHe(dst, src, g);
          } else {
            // Rare: apple stored as a bare point
            dst.x = src.x;
            dst.y = src.y;
            if (typeof dst.clone !== "function") {
              dst.pos = makeNativePoint(src.x, src.y, templatePos);
            }
            applyFruitHe(dst, src, g);
          }
          if (src.type != null) dst.type = src.type;
          if (src.poison) {
            dst.Oka = true;
            if (dst.nla != null) dst.nla = true;
          } else {
            dst.Oka = false;
          }
          if (src.slotMode != null) dst.slotMode = src.slotMode;
          else if ("slotMode" in dst) dst.slotMode = undefined;
          if (src.isPiece) {
            dst.isPiece = true;
            if (src.chessPiece) dst.ChessPiece = src.chessPiece;
            if (src.chessColor) dst.ChessColor = src.chessColor;
          }
          if (src.burgerTimer != null) {
            dst.burgerTimer = src.burgerTimer;
            dst.burgerTimerMax =
              src.burgerTimerMax != null ? src.burgerTimerMax : src.burgerTimer;
            dst.burgerGrey = src.burgerGrey != null ? src.burgerGrey : 0;
          }
          if (src.light != null) dst.light = src.light;
          if (src.otherDim) {
            dst.Lh = false;
            dst.Gh = false;
          }
          if (Array.isArray(src.shields)) {
            // Always a real Set — native eat paths call nba.has / related Sets
            // without null guards on co-op-synthesized fruit.
            dst.nba = new Set(src.shields);
          } else if (!dst.nba || typeof dst.nba.has !== "function") {
            // null / {} / array — never leave a non-Set nba for freePos
            dst.nba = Array.isArray(dst.nba) ? new Set(dst.nba) : new Set();
          }
          try {
            delete dst.Oba;
          } catch (eOba) {
            dst.Oba = undefined;
          }
          // Guarantee wall host exists before tick can grow a wall (p6E → Aa.add)
          try {
            if (g.Ca) ensureNativeWallMap(g.Ca);
          } catch (eAaInit) { /* ignore */ }
        }
        ensureFruitShieldSets(g);
        applyBoardEntities(payload);
        // Client-auth top-up only — never invent freePos fruit for the shared
        // initial relay board (Plan 3.5) or server-auth STATE.
        if (
          root.__mpCoopSession &&
          !root.__mpCoopServerAuth &&
          !payload.serverAuth &&
          !payload.initial
        ) {
          try {
            ensureCoopFruitCount(g);
          } catch (eCnt) { /* ignore */ }
        }
        // Sync Slot Machine roll from peer (idempotent; skip if we just ate)
        try {
          if (
            payload.slotActive != null &&
            Number.isFinite(Number(payload.slotActive)) &&
            typeof root.setSlotActive === "function" &&
            !root.__mpCoopSkipFruitReapply
          ) {
            const next = Number(payload.slotActive) | 0;
            if ((root.__slotActive | 0) !== next) {
              root.setSlotActive(next, g);
              root.__mpCoopLastSlotActive = next;
            }
          }
        } catch (eSlot) { /* ignore */ }
        return true;
      }
    } catch (e) {
      console.warn("applyCollectables", e);
    }
    return false;
  }

  /** Apply winged He / enable motion helpers on a fruit object. */
  function applyFruitHe(dst, src, g) {
    if (!dst) return;
    if (src && src.he && typeof src.he.x === "number" && typeof src.he.y === "number") {
      const hx = Number(src.he.x);
      const hy = Number(src.he.y);
      if (typeof root.slot_vec === "function") {
        try {
          dst.He = root.slot_vec(hx, hy);
          dst.CAb = root.slot_vec(hx, hy);
          if (!dst.iL || typeof dst.iL.x !== "number") {
            dst.iL = root.slot_vec(1, 1);
          } else if (!dst.iL.x && !dst.iL.y) {
            dst.iL.x = 1;
            dst.iL.y = 1;
          }
        } catch (eVec) {
          dst.He = { x: hx, y: hy };
          dst.CAb = { x: hx, y: hy };
          dst.iL = dst.iL || { x: 1, y: 1 };
        }
      } else {
        dst.He = { x: hx, y: hy };
        dst.CAb = { x: hx, y: hy };
        if (!dst.iL) dst.iL = { x: 1, y: 1 };
      }
    }
    if (typeof root.slot_ensure_fruit_motion === "function") {
      try {
        root.slot_ensure_fruit_motion(dst, g);
      } catch (eMot) { /* ignore */ }
    }
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
        // Latch so wrapTimeKeeper onStart does not treat shared-clock arm as a
        // mid-match Play restart (that path was false-killing every co-op client).
        root.__mpCoopArmingSharedTimer = true;
        try {
          if (typeof tk.start === "function") tk.start();
          else tk.playing = true;
        } finally {
          root.__mpCoopArmingSharedTimer = false;
        }
        if (startedAt && Number.isFinite(startedAt)) {
          const elapsed = Math.max(0, Date.now() - startedAt);
          tk._lastTimeMs = elapsed;
          if (typeof tk.lastAppleTime === "number") tk.lastAppleTime = elapsed;
          // Hint engines that expose a wall-clock anchor
          tk.__mpCoopStartedAtMs = startedAt;
        }
        return true;
      } catch (e) {
        root.__mpCoopArmingSharedTimer = false;
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
    let killed = false;
    try {
      const g = gameInstance();
      if (g) {
        g.nj = true;
        if (g.dead != null) g.dead = true;
        if (g.isDead != null) g.isDead = true;
        if (typeof g.die === "function") {
          try {
            g.die();
            killed = true;
          } catch (eDie) { /* fall through */ }
        }
      }
    } catch (e) { /* fall through */ }
    try {
      if (root.timeKeeper) {
        root.timeKeeper._dead = true;
        root.timeKeeper.playing = false;
        if (typeof root.timeKeeper.death === "function") {
          const s = readScoreAndAlive();
          root.timeKeeper.death(s.timeMs || 0, s.score || 0);
          killed = true;
        }
      }
    } catch (e2) { /* ignore */ }
    root.pauseGame = 1;
    return killed;
  }

  /**
   * True engine quit for lobby menus. Showing the death chrome alone is not
   * enough — Remix ignores trophy/count/theme/color until Escape-style quit.
   * Keep the warm Play→stop behavior, but always finish with a real quit.
   */
  function quitNativeRunForMenus(opts) {
    opts = opts || {};
    clearDeathOverlayOverrides();
    // Reveal chrome first — forceLocalDeath / engine quit must not leave the
    // overlay stuck at opacity 0 if a later step throws.
    const overlay = document.getElementsByClassName("wjOYOd")[0];
    if (overlay) {
      overlay.style.setProperty("visibility", "visible", "important");
      overlay.style.setProperty("opacity", "1", "important");
      overlay.style.pointerEvents = "";
      const menu = overlay.children && overlay.children[0];
      if (menu) {
        menu.style.setProperty("visibility", "visible", "important");
        menu.style.pointerEvents = "";
      }
    }
    try {
      forceLocalDeath();
    } catch (eForce) { /* ignore */ }
    root.pauseGame = 1;
    try {
      const g = gameInstance();
      if (g) {
        g.nj = true;
        if (g.dead != null) g.dead = true;
        if (g.isDead != null) g.isDead = true;
      }
      if (root.timeKeeper) {
        root.timeKeeper._dead = true;
        root.timeKeeper.playing = false;
      }
    } catch (eState) { /* ignore */ }

    if (overlay) {
      overlay.style.setProperty("visibility", "visible", "important");
      overlay.style.setProperty("opacity", "1", "important");
      overlay.style.pointerEvents = "";
      const menu = overlay.children && overlay.children[0];
      // PauseMod hides the menu child while paused — force it open for settings
      if (menu) {
        menu.style.setProperty("visibility", "visible", "important");
        menu.style.pointerEvents = "";
      }
    }

    unlockPersonalMenus();
    setNativeMenusLocked(false);

    if (opts.skipEscapeDispatch) return true;
    if (root.__mpEscHandling) return true;

    function dispatchEsc() {
      if (root.__mpStartingMatch || root.__mpCoopSession) return;
      // Prefer the window this GSM instance was bound to — a free `document`
      // lookup follows global.document and can leak Escape into a later test
      // (or a later page) when a pulse timer fires after reload.
      const doc = (root && root.document) || document;
      try {
        root.__mpEscHandling = true;
        doc.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          })
        );
      } catch (eEsc) { /* ignore */ }
      finally {
        root.__mpEscHandling = false;
      }
    }

    dispatchEsc();
    // Remix sometimes needs a second Escape after die() settles
    if (typeof setTimeout === "function" && opts.pulse !== false) {
      root.__mpQuitMenusPulse = (root.__mpQuitMenusPulse | 0) + 1;
      const pulseId = root.__mpQuitMenusPulse;
      setTimeout(function () {
        if (pulseId !== root.__mpQuitMenusPulse) return;
        if (root.__mpStartingMatch || root.__mpCoopSession) return;
        root.__mpEscHandling = true;
        try {
          dispatchEsc();
        } finally {
          root.__mpEscHandling = false;
        }
      }, 80);
    }
    return true;
  }

  /**
   * Slide a co-op seat off solid walls, peer bodies, and illegal 1×1 dead-ends.
   * Returns the preferred pose when already clear, or a nearby slide.
   */
  function findClearCoopSpawnPose(pose, opts) {
    opts = opts || {};
    if (!pose || pose.x == null || pose.y == null) return pose || null;
    const g = opts.game || gameInstance();
    let w = opts.width | 0;
    let h = opts.height | 0;
    if (!w || !h) {
      try {
        const wa = g && g.Ca && g.Ca.wa;
        if (Array.isArray(wa) && wa.length) {
          w = w || (wa[0] && wa[0].length) || 0;
          h = h || wa.length || 0;
        }
      } catch (e) { /* ignore */ }
    }
    w = w || 17;
    h = h || 15;
    const dir = pose.dir === "LEFT" ? "LEFT" : "RIGHT";

    const blocked = Object.create(null);
    function markCell(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      blocked[(x | 0) + "," + (y | 0)] = true;
    }
    // Solid walls (wa===1) + Aa map
    try {
      const walls =
        opts.walls ||
        (g && g.Ca ? scrapeWalls(g) : null) ||
        [];
      for (let i = 0; i < walls.length; i++) {
        const p = walls[i];
        if (p) markCell(p.x, p.y);
      }
    } catch (eW) { /* ignore */ }
    // Peer / local bodies already seated
    try {
      const remotes = opts.remotes || root.__mpCoopRemotes || {};
      Object.keys(remotes).forEach(function (id) {
        const r = remotes[id];
        if (!r || !r.body) return;
        for (let i = 0; i < r.body.length; i++) {
          const p = r.body[i];
          if (p) markCell(p.x, p.y);
        }
      });
    } catch (eR) { /* ignore */ }
    if (opts.extraBodies) {
      for (let i = 0; i < opts.extraBodies.length; i++) {
        const body = opts.extraBodies[i];
        if (!body) continue;
        for (let j = 0; j < body.length; j++) {
          const p = body[j];
          if (p) markCell(p.x, p.y);
        }
      }
    }

    function poseClear(cand) {
      if (!cand) return false;
      if (isIllegalNormalWallCell(cand.x, cand.y, w, h)) return false;
      const body = coopSpawnBodyFromPose(cand);
      if (!coopSpawnBodyInBounds(body, w, h)) return false;
      for (let i = 0; i < body.length; i++) {
        const p = body[i];
        if (!p) return false;
        if (blocked[(p.x | 0) + "," + (p.y | 0)]) return false;
        if (isIllegalNormalWallCell(p.x, p.y, w, h)) return false;
      }
      return true;
    }

    const preferred = {
      x: Math.max(0, Math.min(pose.x | 0, w - 1)),
      y: Math.max(0, Math.min(pose.y | 0, h - 1)),
      dir: dir,
    };
    if (poseClear(preferred)) return preferred;

    // Spiral search from preferred seat (bounded)
    const maxR = Math.max(w, h);
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const cand = {
            x: preferred.x + dx,
            y: preferred.y + dy,
            dir: dir,
          };
          if (cand.x < 0 || cand.y < 0 || cand.x >= w || cand.y >= h) {
            continue;
          }
          // Keep length-3 RIGHT body clear of left edge
          if (dir === "RIGHT" && cand.x < 2) continue;
          if (dir === "LEFT" && cand.x > w - 3) continue;
          if (poseClear(cand)) return cand;
        }
      }
    }
    return preferred;
  }

  /**
   * Same entry point as the in-game Reset control: GameInstance.reset().
   * Call only after co-op session flags are cleared so wrapGameReset does not
   * treat it as a mid-match local death.
   */
  function resetNativeLikeButton(gIn) {
    const g = gIn || gameInstance();
    if (!g || typeof g.reset !== "function") return false;
    try {
      g.reset();
      return true;
    } catch (e) {
      console.warn("resetNativeLikeButton", e);
      return false;
    }
  }

  /**
   * Hard-reset native board hosts for a new co-op SESSION_START (incl. mid-run).
   * Empties walls Map (keeps wa corner sentinels), fruit list, and mode entities.
   * Also kills leftover eat/grow animation so the next match does not loop the
   * previous session's last apple bite.
   *
   * @param {*} gIn optional game host
   * @param {{suppressHideDeath?: boolean}=} opts Match-end teardown must not
   *   re-hide `.wjOYOd` after ALL_DEAD / ALL_APPLES menu handoff.
   */
  function resetCoopBoardForNewSession(gIn, opts) {
    if (
      gIn &&
      typeof gIn === "object" &&
      gIn.suppressHideDeath != null &&
      gIn.Ca == null &&
      gIn.oa == null
    ) {
      opts = gIn;
      gIn = null;
    }
    opts = opts || {};
    const g = gIn || gameInstance();
    if (!g) return false;
    let ok = false;
    try {
      g.nj = false;
      if (g.dead != null) g.dead = false;
      if (g.isDead != null) g.isDead = false;
    } catch (eDead) { /* ignore */ }
    try {
      if (typeof g.Sh === "number") g.Sh = 0;
      if (typeof g.Oh === "number") g.Oh = 0;
      if (typeof g.score === "number") g.score = 0;
      if (typeof g.appleCount === "number") g.appleCount = 0;
    } catch (eScore) { /* ignore */ }
    try {
      stopCoopRunTimer();
    } catch (eStop) { /* ignore */ }
    try {
      if (root.timeKeeper) {
        root.timeKeeper._dead = false;
        root.timeKeeper._lastScore = 0;
        root.timeKeeper._lastTimeMs = 0;
        if (typeof root.timeKeeper.lastAppleTime === "number") {
          root.timeKeeper.lastAppleTime = 0;
        }
        try {
          delete root.timeKeeper.__mpCoopStartedAtMs;
        } catch (eDel) {
          root.timeKeeper.__mpCoopStartedAtMs = null;
        }
      }
    } catch (eTk) { /* ignore */ }
    try {
      if (!opts.suppressHideDeath && typeof hideDeathScreen === "function") {
        hideDeathScreen();
      }
    } catch (eHide) { /* ignore */ }
    try {
      if (g.Ca) {
        ensureNativeWallMap(g.Ca);
        ensureWallGridDense(g.Ca);
        if (typeof g.Ca.Aa.clear === "function") {
          g.Ca.Aa.clear();
        }
        const grid = g.Ca.wa;
        if (Array.isArray(grid)) {
          for (let y = 0; y < grid.length; y++) {
            const row = grid[y];
            if (!row) continue;
            for (let x = 0; x < row.length; x++) {
              if (typeof row[x] === "object" && row[x]) continue;
              // Preserve corner sentinels (2); clear solids (1) and empties
              if ((row[x] | 0) === 1) row[x] = 0;
            }
          }
        }
        ok = true;
      }
    } catch (eW) { /* ignore */ }
    // Always wipe fruit hosts between matches. Leaving old apple objects made
    // the next co-op run loop the previous bite animation (head still on that
    // cell / fruit still carrying eat state). Server-auth rebinds from STATE;
    // client-auth Play reseeds Count.
    try {
      if (g.wa && Array.isArray(g.wa.ka)) {
        g.wa.ka.length = 0;
      }
    } catch (eFruit) { /* ignore */ }
    // Drop snake grow / mouth leftovers so render does not keep biting
    try {
      if (g.oa) {
        const snake = g.oa;
        const growKeys = [
          "grow",
          "growth",
          "pendingGrowth",
          "toGrow",
          "mouth",
          "eating",
          "eatProgress",
          "appleBits",
        ];
        for (let gi = 0; gi < growKeys.length; gi++) {
          const k = growKeys[gi];
          if (k in snake) {
            try {
              snake[k] = typeof snake[k] === "number" ? 0 : false;
            } catch (eG) { /* ignore */ }
          }
        }
        if (typeof ensureSnakeSegmentFlags === "function") {
          ensureSnakeSegmentFlags(snake);
        }
      }
    } catch (eSnake) { /* ignore */ }
    try {
      if (g.Ba && g.Ba.keys) {
        if (Array.isArray(g.Ba.keys)) g.Ba.keys.length = 0;
        else if (typeof g.Ba.keys.clear === "function") g.Ba.keys.clear();
      }
    } catch (eK) { /* ignore */ }
    try {
      if (g.Aa) {
        if (Array.isArray(g.Aa.oa)) g.Aa.oa.length = 0;
        else if (g.Aa.oa && typeof g.Aa.oa.clear === "function") g.Aa.oa.clear();
        if (Array.isArray(g.Aa.d_)) g.Aa.d_.length = 0;
        if (Array.isArray(g.Aa.da)) g.Aa.da.length = 0;
      }
    } catch (eB) { /* ignore */ }
    try {
      if (g.Ma) {
        const mh = g.Ma.oa || g.Ma.ka;
        if (Array.isArray(mh)) mh.length = 0;
        else if (mh && typeof mh.clear === "function") mh.clear();
      }
    } catch (eM) { /* ignore */ }
    try {
      if (g.Ya) {
        const sh = g.Ya.oa || g.Ya.ka;
        if (Array.isArray(sh)) sh.length = 0;
        else if (sh && typeof sh.clear === "function") sh.clear();
      }
    } catch (eS) { /* ignore */ }
    try {
      if (g.Ga && Array.isArray(g.Ga.oa)) {
        for (let y = 0; y < g.Ga.oa.length; y++) {
          const row = g.Ga.oa[y];
          if (!row) continue;
          for (let x = 0; x < row.length; x++) row[x] = null;
        }
      }
    } catch (eBr) { /* ignore */ }
    try {
      root.__mpCoopSkipFruitReapply = false;
      root.__mpCoopBoardFull = false;
      root.__mpCoopLastState = null;
      root.__mpCoopLastStateMyId = null;
      root.__mpCoopLastStateSeq = -1;
      root.__mpCoopAuthReapplyScheduled = false;
      root.__mpCoopPlayerRenderer = null;
      root.__mpCoopRenderArgs = null;
      root.__mpCoopRemotes = Object.create(null);
    } catch (eFl) { /* ignore */ }
    return ok;
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
    forceMatchSettingsForPlay: forceMatchSettingsForPlay,
    forceEngineSizeForPlay: forceEngineSizeForPlay,
    forceEngineMatchFieldsForPlay: forceEngineMatchFieldsForPlay,
    boardSizeFromGame: boardSizeFromGame,
    boardDimsForSizeIndex: boardDimsForSizeIndex,
    liveBoardMatchesSettings: liveBoardMatchesSettings,
    sanitizePostimgFruitUrls: sanitizePostimgFruitUrls,
    applySettings: applySettings,
    applySnakeColor: applySnakeColor,
    tintLiveFaceSprites: tintLiveFaceSprites,
    FACE_SPRITE_BASE: FACE_SPRITE_BASE,
    triggerPlay: triggerPlay,
    isDeathOverlayVisible: isDeathOverlayVisible,
    isNativeRunLive: isNativeRunLive,
    forceNativePlayBake: forceNativePlayBake,
    findPlayController: findPlayController,
    classicInitialFruit: classicInitialFruit,
    plantClassicInitialFruit: plantClassicInitialFruit,
    matchAppleType: matchAppleType,
    ensureFruitHostTemplate: ensureFruitHostTemplate,
    forceLiveBoardDims: forceLiveBoardDims,
    prepareNativePlay: prepareNativePlay,
    startNativeRun: startNativeRun,
    clearDeathOverlayOverrides: clearDeathOverlayOverrides,
    dismissDeathOverlayForRun: dismissDeathOverlayForRun,
    gameInstance: gameInstance,
    readScoreAndAlive: readScoreAndAlive,
    readLiveRunTimeMs: readLiveRunTimeMs,
    scrapeBoard: scrapeBoard,
    scrapeSnakeDelta: scrapeSnakeDelta,
    scrapeCoopSnakeDelta: scrapeCoopSnakeDelta,
    normalizePoseDirection: normalizePoseDirection,
    readNativeDirection: readNativeDirection,
    reflectDirection: reflectDirection,
    snakeDeltaFingerprint: snakeDeltaFingerprint,
    boardDeltaFingerprint: boardDeltaFingerprint,
    scrapeCollectables: scrapeCollectables,
    collectablesFingerprint: collectablesFingerprint,
    scrapeBoardEntities: scrapeBoardEntities,
    filterMosaicWalls: filterMosaicWalls,
    isIllegalNormalWallCell: isIllegalNormalWallCell,
    wallSerialKey: wallSerialKey,
    ensureNativeWallMap: ensureNativeWallMap,
    ensureFruitShieldSets: ensureFruitShieldSets,
    ensureWallGridDense: ensureWallGridDense,
    ensureSnakeSegmentFlags: ensureSnakeSegmentFlags,
    ensureCoopTickHosts: ensureCoopTickHosts,
    applyCollectables: applyCollectables,
    nudgeCoopApplesOffSnakes: nudgeCoopApplesOffSnakes,
    coopAppleGoal: coopAppleGoal,
    expectedAppleCountFromSettings: expectedAppleCountFromSettings,
    ensureCoopFruitCount: ensureCoopFruitCount,
    isCoopFruitMotionMode: isCoopFruitMotionMode,
    applyBoardEntities: applyBoardEntities,
    applyCoopSpawnOffset: applyCoopSpawnOffset,
    applyCoopStartMoving: applyCoopStartMoving,
    clampCoopSpawnOy: clampCoopSpawnOy,
    distinctCoopSpawnY: distinctCoopSpawnY,
    coopSpawnPoseForSlot: coopSpawnPoseForSlot,
    coopYinYangCorner: coopYinYangCorner,
    coopSpawnBodyFromPose: coopSpawnBodyFromPose,
    coopSpawnBodyInBounds: coopSpawnBodyInBounds,
    findClearCoopSpawnPose: findClearCoopSpawnPose,
    resetCoopBoardForNewSession: resetCoopBoardForNewSession,
    resetNativeLikeButton: resetNativeLikeButton,
    coopIsYinYang: coopIsYinYang,
    parkLocalSnakeOffBoard: parkLocalSnakeOffBoard,
    emptyLocalSnakeBody: emptyLocalSnakeBody,
    applySpectateState: applySpectateState,
    makeNativePoint: makeNativePoint,
    ensureNativePos: ensureNativePos,
    writeNativeBody: writeNativeBody,
    syncNativeTailVirtual: syncNativeTailVirtual,
    writeNativeHead: writeNativeHead,
    followBodyFromHead: followBodyFromHead,
    bodyTrailConnected: bodyTrailConnected,
    reapplyFocusBody: reapplyFocusBody,
    hideControlHelper: hideControlHelper,
    restoreControlHelper: restoreControlHelper,
    installFirstRunControlTipGuard: installFirstRunControlTipGuard,
    forceLocalDeath: forceLocalDeath,
    quitNativeRunForMenus: quitNativeRunForMenus,
    installFocusDieGuard: installFocusDieGuard,
    installCoopDieGuard: installCoopDieGuard,
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
    BRIDGE_DEFAULT_COLOR: BRIDGE_DEFAULT_COLOR,
    ARROW_DEFAULT_COLOR: ARROW_DEFAULT_COLOR,
    boardHasMode: boardHasMode,
    scrapeModeKey: scrapeModeKey,
    effectiveModeKey: effectiveModeKey,
    resolveSlotModeId: resolveSlotModeId,
    collectMosaicLights: collectMosaicLights,
    mosaicCellLit: mosaicCellLit,
    mosaicPointLit: mosaicPointLit,
    LIGHT_HEAD_FLOOR: LIGHT_HEAD_FLOOR,
    LIGHT_FRUIT_DEFAULT: LIGHT_FRUIT_DEFAULT,
    LIGHT_OBJECT_RADIUS: LIGHT_OBJECT_RADIUS,
    drawWallSolverStyleSnake: drawWallSolverStyleSnake,
    drawBoardApples: drawBoardApples,
    drawBoardWalls: drawBoardWalls,
    drawBoardModeEntities: drawBoardModeEntities,
    snakeMotion: snakeMotion,
    snakeMotionActive: snakeMotionActive,
    bodySegmentsAdjacent: bodySegmentsAdjacent,
    normalizeBodyCell: normalizeBodyCell,
    boardWraps: boardWraps,
    resolveAppleImageUrl: resolveAppleImageUrl,
    resolvePoisonImageUrl: resolvePoisonImageUrl,
    boardSnakePoisoned: boardSnakePoisoned,
    POISON_SNAKE_PRIMARY: POISON_SNAKE_PRIMARY,
    POISON_SNAKE_SECONDARY: POISON_SNAKE_SECONDARY,
    resolveThemeColors: resolveThemeColors,
    scrapeCompanionBody: scrapeCompanionBody,
    drawSpriteSheetFrame: drawSpriteSheetFrame,
    KEY_TYPES_URL: KEY_TYPES_URL,
    KEY_TYPES_DARK_URL: KEY_TYPES_DARK_URL,
    SOKO_BOX_URL: SOKO_BOX_URL,
    SOKO_BOX_FRAMES: SOKO_BOX_FRAMES,
    SOKO_BOX_FRAME: SOKO_BOX_FRAME,
    SOKO_GOAL_FRAME: SOKO_GOAL_FRAME,
    get SOKO_GOAL_DISTINCT_URL() {
      return sokoGoalDistinctUrl();
    },
    get SOKO_GOAL_DISTINCT_PX_URL() {
      return sokoGoalDistinctPxUrl();
    },
    resolveSokoGoalUrl: resolveSokoGoalUrl,
    resetSpriteImageCache: resetSpriteImageCache,
    POISON_SKULL_URL: POISON_SKULL_URL,
    MINE_FLAG_URL: MINE_FLAG_URL,
    MINE_FLAG_FRAMES: MINE_FLAG_FRAMES,
    MINE_FLAG_FRAME: MINE_FLAG_FRAME,
    MINE_RADIUS_COLOR: MINE_RADIUS_COLOR,
    STATUE_URL: STATUE_URL,
    STATUE_CRACKS_URL: STATUE_CRACKS_URL,
    STATUE_CRACKS_FRAMES: STATUE_CRACKS_FRAMES,
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
