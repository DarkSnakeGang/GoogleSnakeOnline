/**
 * Versus Focus spectate — the watched player's board drawn with the mosaic
 * renderer, sized to the game canvas.
 *
 * Focus used to puppet a real local run so Google's renderer drew the remote
 * player (see archive/focus-native/). It now draws the board itself: the
 * spectator's own game is never started, seated or restarted, which is what
 * used to bounce the endscreen in a loop.
 *
 * Installed onto MultiplayerApp (keeps mod.js as the session orchestrator).
 */
(function (root) {
  /** Run clock ticks locally; the board itself repaints on BOARD_DELTA. */
  const LABEL_TICK_MS = 200;
  /** Overlay box used when the game canvas cannot be measured. */
  const FALLBACK_W = 612;
  const FALLBACK_H = 540;
  /** Backing store past 2x DPR buys nothing and costs fill rate. */
  const MAX_DPR = 2;

  function install(App) {
    if (!App || App.__mpFocusInstalled) return;
    App.__mpFocusInstalled = true;

    const Gsm = root.MultiplayerGsm;
    const Mp = root.MultiplayerRuntime;
    const VersusState = root.VersusState;

    /**
     * Focus sits on the game canvas, so everything the page draws around it
     * (top bar, apple counter, fullscreen button) stays visible.
     */
    function gameCanvasBox() {
      const c = Gsm && Gsm.gameCanvas ? Gsm.gameCanvas() : null;
      if (!c || typeof c.getBoundingClientRect !== "function") return null;
      let r = null;
      try {
        r = c.getBoundingClientRect();
      } catch (e) {
        return null;
      }
      if (!r || !(r.width > 1) || !(r.height > 1)) return null;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    function fallbackBox() {
      const vw = Number(root.innerWidth) || FALLBACK_W;
      const vh = Number(root.innerHeight) || FALLBACK_H;
      const width = Math.min(FALLBACK_W, vw * 0.92);
      const height = Math.min(FALLBACK_H, vh * 0.78);
      return {
        left: (vw - width) / 2,
        top: (vh - height) / 2,
        width: width,
        height: height,
      };
    }

    function peekingMenus() {
      return typeof window !== "undefined" && !!window.__mpSpectateAllowMenus;
    }

    function rosterSeat(app, clientId) {
      const clients =
        (app.client && app.client.roster && app.client.roster.clients) || [];
      for (let i = 0; i < clients.length; i++) {
        if (clients[i].clientId === clientId) return clients[i];
      }
      return null;
    }

    App.prototype.ensureVersusFocusView = function () {
      if (this._focusView) return this._focusView;
      const el = document.createElement("div");
      el.id = "mp-focus-view";
      el.style.display = "none";
      const canvas = document.createElement("canvas");
      canvas.className = "mp-focus-canvas";
      canvas.width = FALLBACK_W;
      canvas.height = FALLBACK_H;
      const label = document.createElement("div");
      label.className = "mp-focus-label";
      const cat = document.createElement("div");
      cat.className = "mp-mosaic-cat mp-focus-cat";
      el.appendChild(canvas);
      el.appendChild(label);
      el.appendChild(cat);
      document.body.appendChild(el);
      this._focusView = el;
      this._focusViewCanvas = canvas;
      return el;
    };

    /**
     * Track the live canvas box. The board is inset by roughly one cell so the
     * border frame reads like the in-game one on all four sides instead of only
     * where the renderer happens to letterbox.
     */
    App.prototype._layoutVersusFocusView = function (board) {
      const el = this.ensureVersusFocusView();
      const box = gameCanvasBox() || fallbackBox();
      const cols = (board && board.width) || 17;
      const rows = (board && board.height) || 15;
      const cell = Math.min(box.width / (cols + 2), box.height / (rows + 2));
      const pad = Math.max(3, Math.round(cell));
      el.style.left = Math.round(box.left) + "px";
      el.style.top = Math.round(box.top) + "px";
      el.style.width = Math.round(box.width) + "px";
      el.style.height = Math.round(box.height) + "px";
      el.style.padding = pad + "px";
      const canvas = this._focusViewCanvas;
      if (canvas) {
        const dpr = Math.min(
          MAX_DPR,
          Math.max(1, Number(root.devicePixelRatio) || 1)
        );
        const w = Math.max(1, Math.round((box.width - pad * 2) * dpr));
        const h = Math.max(1, Math.round((box.height - pad * 2) * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
      }
      return el;
    };

    /** Watched player, run clock and best — the mosaic label at game size. */
    App.prototype._paintVersusFocusLabel = function (board) {
      const view = this._focusView;
      const el = view && view.querySelector(".mp-focus-label");
      if (!el) return;
      const id = this.versus.focusClientId;
      const seat = rosterSeat(this, id) || {};
      const name =
        seat.resolvedName ||
        seat.displayName ||
        seat.colorName ||
        (id ? String(id).slice(0, 6) : "—");
      const goal =
        (this.versus && this.versus.versusGoal) ||
        (this.client && this.client.roster && this.client.roster.versusGoal) ||
        "score";
      const sc = this.versus.scores && this.versus.scores[id];
      const runClock = this.versus.runClocks && this.versus.runClocks[id];
      const fallbackMs =
        sc && sc.timeMs != null && Number.isFinite(Number(sc.timeMs))
          ? Number(sc.timeMs)
          : board && board.timeMs != null && Number.isFinite(Number(board.timeMs))
            ? Number(board.timeMs)
            : null;
      const timeMs =
        VersusState && VersusState.resolveRunClockMs
          ? VersusState.resolveRunClockMs(runClock, Date.now(), fallbackMs)
          : fallbackMs;
      const clock =
        VersusState && VersusState.formatRunClock
          ? VersusState.formatRunClock(timeMs)
          : timeMs == null
            ? "—"
            : String(Math.floor(timeMs / 1000)) + "s";
      const best =
        VersusState && VersusState.formatGoalBest
          ? VersusState.formatGoalBest(sc, goal)
          : sc && sc.bestScore != null
            ? String(sc.bestScore)
            : "—";
      const score =
        board && Number.isFinite(Number(board.score))
          ? Number(board.score)
          : sc && Number.isFinite(Number(sc.score))
            ? Number(sc.score)
            : null;
      const dead = !!(board && board.alive === false);
      let text = name;
      if (score != null) text += " · " + score;
      text += " · " + clock + " · best " + best;
      if (dead) text += " · dead";
      el.classList.toggle("mp-focus-dead", dead);
      if (el.textContent !== text) {
        el.textContent = text;
        el.title = text;
      }
    };

    App.prototype._paintVersusFocus = function (board) {
      if (!board || !Gsm.drawBoardOnCanvas) return false;
      // Escape peek: step aside so the native death screen and the menus it
      // unlocks are actually reachable underneath.
      if (peekingMenus()) {
        if (this._focusView) this._focusView.style.display = "none";
        return false;
      }
      const el = this._layoutVersusFocusView(board);
      el.style.display = "block";
      const theme = board.themeColors;
      el.style.background = (theme && theme.border) || "#578a34";
      const colorInfo = this._colorForClient(this.versus.focusClientId);
      Gsm.drawBoardOnCanvas(
        this._focusViewCanvas,
        board,
        colorInfo,
        theme,
        this.versus.focusClientId
      );
      this._paintVersusFocusLabel(board);
      if (this._paintMosaicCatLives) {
        this._paintMosaicCatLives(el.querySelector(".mp-focus-cat"), board);
      }
      return true;
    };

    App.prototype._enterVersusFocusSpectate = function () {
      if (this._versusFocusSpectate) return;
      this._versusFocusSpectate = true;
      if (Mp && Mp.enterVersusFocus) Mp.enterVersusFocus();
      else if (typeof window !== "undefined") {
        window.__mpVersusFocusWatch = true;
        window.__mpSpectateAllowMenus = false;
        window.__mpSpectateMenuFp = null;
      }
      if (Gsm.installSpectatorTimeKeeperGuard) {
        Gsm.installSpectatorTimeKeeperGuard();
      }
      this.hideNativeBoard(false);
      this.ensureAutoFocus();
      this.startVersusFocusLoop();
      this.startVersusFocusAnim();
    };

    /**
     * Leaving is also the "not spectating" path (mosaic, session end, promote),
     * so the native death screen / personal menus are always handed back.
     */
    App.prototype._leaveVersusFocusSpectate = function () {
      const wasWatching = !!this._versusFocusSpectate;
      this._versusFocusSpectate = false;
      this.stopVersusFocusLoop();
      this.stopVersusFocusAnim();
      if (this._focusView) this._focusView.style.display = "none";
      if (wasWatching) {
        if (Mp && Mp.leaveVersusFocus) Mp.leaveVersusFocus();
        else if (typeof window !== "undefined") {
          window.__mpVersusFocusWatch = false;
          window.__mpSpectateAllowMenus = false;
        }
        if (Gsm.restoreControlHelper) Gsm.restoreControlHelper();
      }
      if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
      if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
    };

    App.prototype.startVersusFocusLoop = function () {
      if (this._versusFocusTimer) return;
      const self = this;
      // Also picks up window resizes and the end of an Escape peek.
      this._versusFocusTimer = setInterval(function () {
        if (!self._versusFocusSpectate) return;
        const board = self.versus && self.versus.focusBoard();
        if (board) self._paintVersusFocus(board);
      }, LABEL_TICK_MS);
    };

    App.prototype.stopVersusFocusLoop = function () {
      if (this._versusFocusTimer) {
        clearInterval(this._versusFocusTimer);
        this._versusFocusTimer = 0;
      }
    };

    /**
     * The board only lands on deltas, but the snake slides between them, so
     * repaint the canvas while a step is in flight. Canvas only — layout, the
     * label and the cat strip stay on the slower tick above.
     */
    App.prototype._animateVersusFocus = function () {
      if (peekingMenus()) return false;
      const canvas = this._focusViewCanvas;
      if (!canvas || typeof Gsm.snakeMotionActive !== "function") return false;
      if (!Gsm.snakeMotionActive(canvas)) return false;
      const board = this.versus && this.versus.focusBoard();
      if (!board) return false;
      Gsm.drawBoardOnCanvas(
        canvas,
        board,
        this._colorForClient(this.versus.focusClientId),
        board.themeColors,
        this.versus.focusClientId
      );
      return true;
    };

    App.prototype.startVersusFocusAnim = function () {
      if (this._focusAnimRaf) return;
      const raf =
        typeof root.requestAnimationFrame === "function"
          ? root.requestAnimationFrame.bind(root)
          : null;
      if (!raf) return;
      const self = this;
      function frame() {
        if (!self._focusAnimRaf) return;
        if (!self._versusFocusSpectate) {
          self._focusAnimRaf = 0;
          return;
        }
        self._focusAnimRaf = raf(frame);
        self._animateVersusFocus();
      }
      this._focusAnimRaf = raf(frame);
    };

    App.prototype.stopVersusFocusAnim = function () {
      if (!this._focusAnimRaf) return;
      if (typeof root.cancelAnimationFrame === "function") {
        try {
          root.cancelAnimationFrame(this._focusAnimRaf);
        } catch (e) { /* ignore */ }
      }
      this._focusAnimRaf = 0;
    };

    App.prototype.renderFocusBoard = function () {
      if (this._focusCanvas) {
        this._focusCanvas.style.display = "none";
      }

      const isSpec = this._isVersusSpectator();
      const mosaicOn = this.versus.spectateMode === "mosaic";
      const sessionOn = !!(
        this.client &&
        this.client.roster &&
        this.client.roster.sessionActive
      );
      if (!isSpec || mosaicOn || !sessionOn) {
        this._leaveVersusFocusSpectate();
        if (!sessionOn) this.applyControlLocks();
        return;
      }

      this._enterVersusFocusSpectate();
      // No board cached yet (just switched player): draw the empty frame rather
      // than leaving the last player's pixels up until the first delta lands.
      this._paintVersusFocus(
        this.versus.focusBoard() || {
          width: 17,
          height: 15,
          body: [],
          apples: [],
        }
      );
    };
  }

  root.MultiplayerFocus = { install: install };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { install: install };
  }
})(typeof window !== "undefined" ? window : globalThis);
