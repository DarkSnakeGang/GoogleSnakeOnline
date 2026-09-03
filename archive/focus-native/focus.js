/**
 * Versus Focus spectate — native GameInstance puppet for one watched player.
 * Installed onto MultiplayerApp (keeps mod.js as the session orchestrator).
 */
(function (root) {
  function install(App) {
    if (!App || App.__mpFocusInstalled) return;
    App.__mpFocusInstalled = true;

    const Gsm = root.MultiplayerGsm;
    const Mp = root.MultiplayerRuntime;

    App.prototype._clearVersusFocusSeatFlags = function (opts) {
      if (Mp && Mp.clearFocusSeat) Mp.clearFocusSeat(opts);
      else if (typeof window !== "undefined") {
        window.__mpFocusSeated = false;
        window.__mpFocusForceFullBody = true;
        window.__mpFocusSeatPoseFp = null;
        window.__mpFocusRemoteStarted = false;
        window.__mpFocusRemoteHead = null;
        window.__mpFocusRemoteBody = null;
        window.__mpFocusPoseFp = null;
        window.__mpFocusNativeOk = false;
        if (!opts || opts.requirePlay !== false) {
          window.__mpFocusRequirePlay = true;
        }
      }
    };

    /**
     * Versus Focus: keep local death UI / engine seat matched to remote board.alive.
     * Edge-trigger death clears; debounce revive so auto-restart alive flicker does not
     * spam Play / flash the endscreen and leave the spectator stuck at spawn.
     */
    App.prototype._syncVersusFocusAlive = function (board) {
      if (!board || typeof window === "undefined") return;
      const remoteAlive = board.alive !== false;
      const prev = window.__mpVersusFocusRemoteAlive;

      if (!remoteAlive) {
        if (this._versusFocusReviveTimer) {
          clearTimeout(this._versusFocusReviveTimer);
          this._versusFocusReviveTimer = null;
        }
        this._versusFocusAliveStreak = 0;
        if (prev !== false) {
          this._clearVersusFocusSeatFlags({ requirePlay: true });
        }
        window.__mpVersusFocusRemoteAlive = false;
        if (!window.__mpSpectateAllowMenus) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
        }
        return;
      }

      if (prev === false) {
        this._versusFocusAliveStreak = (this._versusFocusAliveStreak || 0) + 1;
        if (this._versusFocusReviveTimer) return;
        const self = this;
        this._versusFocusReviveTimer = setTimeout(function () {
          self._versusFocusReviveTimer = null;
          if (!self._versusFocusSpectate) return;
          const b = self.versus && self.versus.focusBoard();
          if (!b || b.alive === false) {
            self._versusFocusAliveStreak = 0;
            return;
          }
          self._clearVersusFocusSeatFlags({ requirePlay: true });
          window.__mpVersusFocusRemoteAlive = true;
          if (!window.__mpSpectateAllowMenus) {
            if (Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
            else if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          }
          if (self._versusFocusNativeRetrying) {
            self._versusFocusReseatQueued = true;
            return;
          }
          if (
            window.__mpFocusNativeOk &&
            Gsm.isNativeRunLive &&
            Gsm.isNativeRunLive()
          ) {
            window.__mpFocusRequirePlay = false;
            window.__mpFocusForceFullBody = true;
            window.__mpFocusSeated = false;
            self._paintVersusFocus(b);
            return;
          }
          self._seatVersusFocusNative({ reason: "revive", force: false });
        }, 220);
        return;
      }

      window.__mpVersusFocusRemoteAlive = true;
      this._versusFocusAliveStreak = 0;
      if (!window.__mpSpectateAllowMenus) {
        if (
          !window.__mpFocusRequirePlay &&
          (Gsm.dismissDeathOverlayForRun || Gsm.hideDeathScreen)
        ) {
          if (Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
          else Gsm.hideDeathScreen();
        }
      }
    };

    App.prototype._seatVersusFocusNative = function (opts) {
      opts = opts || {};
      if (!this._versusFocusSpectate) {
        this._enterVersusFocusSpectate();
      }
      if (!this._versusFocusSpectate) return false;
      if (this._versusFocusNativeRetrying && !opts.force) return false;
      if (
        !opts.force &&
        typeof window !== "undefined" &&
        window.__mpFocusNativeOk &&
        Gsm.isNativeRunLive &&
        Gsm.isNativeRunLive()
      ) {
        return true;
      }
      if (!Gsm.startNativeRun) return false;
      this._versusFocusNativeRetrying = true;
      if (Mp && Mp.prepareFocusSeatAttempt) Mp.prepareFocusSeatAttempt();
      else if (typeof window !== "undefined") {
        window.__mpFocusRequirePlay = true;
        window.__mpFocusNativeOk = false;
        window.__mpFocusSeated = false;
        window.__mpFocusForceFullBody = true;
      }
      const self = this;
      const attempt = (this._versusFocusSeatAttempts =
        (this._versusFocusSeatAttempts || 0) + 1);
      Gsm.startNativeRun({
        maxAttempts: opts.maxAttempts != null ? opts.maxAttempts : 50,
        intervalMs: opts.intervalMs != null ? opts.intervalMs : 40,
        requirePlayClick: true,
        deferTimer: true,
        onDone: function (ok) {
          self._versusFocusNativeRetrying = false;
          if (typeof window !== "undefined") {
            if (ok) {
              if (Mp && Mp.markFocusSeatSuccess) Mp.markFocusSeatSuccess();
              else {
                window.__mpFocusRequirePlay = false;
                window.__mpFocusNativeOk = true;
                window.__mpFocusSeated = false;
                window.__mpFocusForceFullBody = true;
              }
              self._versusFocusSeatAttempts = 0;
            } else if (Mp && Mp.markFocusSeatFailed) {
              Mp.markFocusSeatFailed();
            } else {
              window.__mpFocusRequirePlay = true;
              window.__mpFocusNativeOk = false;
            }
          }
          const board = self.versus && self.versus.focusBoard();
          if (board) self._paintVersusFocus(board);
          if (
            ok &&
            (typeof window === "undefined" || !window.__mpSpectateAllowMenus) &&
            Gsm.hideDeathScreen
          ) {
            Gsm.hideDeathScreen();
          }
          if (!ok && opts.retry !== false && attempt < 6) {
            setTimeout(function () {
              if (!self._versusFocusSpectate) return;
              if (typeof window !== "undefined" && window.__mpFocusNativeOk) return;
              self._seatVersusFocusNative({ reason: "retry", force: true });
            }, 250);
          } else if (self._versusFocusReseatQueued) {
            self._versusFocusReseatQueued = false;
            if (
              self._versusFocusSpectate &&
              typeof window !== "undefined" &&
              window.__mpVersusFocusRemoteAlive !== false
            ) {
              self._seatVersusFocusNative({ reason: "queued_revive", force: false });
            }
          }
        },
      });
      return true;
    };

    App.prototype._installVersusFocusTick = function () {
      const self = this;
      if (typeof window === "undefined") return;
      window.__mpVersusFocusOnTick = function () {
        if (!window.__mpVersusFocusSpectate) return;
        const board =
          (self.versus && self.versus.focusBoard()) ||
          window.__mpVersusFocusBoard;
        if (!board || !Gsm.applySpectateState) return;
        window.__mpVersusFocusBoard = board;
        self._syncVersusFocusAlive(board);
        const colorInfo = self._colorForClient(
          self.versus && self.versus.focusClientId
        );
        Gsm.applySpectateState(null, board, colorInfo, { paint: false });
        if (Gsm.hideControlHelper) Gsm.hideControlHelper();
        if (!window.__mpSpectateAllowMenus && Gsm.hideDeathScreen) {
          Gsm.hideDeathScreen();
        }
      };
    };

    App.prototype._paintVersusFocus = function (board) {
      if (!board) return false;
      if (typeof window !== "undefined") {
        window.__mpVersusFocusBoard = board;
      }
      this._syncVersusFocusAlive(board);
      const colorInfo = this._colorForClient(this.versus.focusClientId);
      if (!Gsm.applySpectateState) return false;
      const result = Gsm.applySpectateState(null, board, colorInfo, {
        paint: false,
      });
      return !!(result && result.ok && result.injected);
    };

    App.prototype._ensureVersusFocusNative = function () {
      if (
        typeof window !== "undefined" &&
        window.__mpVersusFocusRemoteAlive === false
      ) {
        return;
      }
      this._seatVersusFocusNative({ reason: "ensure", force: false });
    };

    App.prototype._reseatVersusFocusForNewRun = function (reason) {
      if (!this._versusFocusSpectate) {
        this._enterVersusFocusSpectate();
        return !!this._versusFocusSpectate;
      }
      this._clearVersusFocusSeatFlags({ requirePlay: true });
      this._versusFocusPlayStarted = true;
      this._versusFocusRevivePending = false;
      this._versusFocusNativeRetrying = false;
      this._versusFocusReseatQueued = false;
      this._versusFocusSeatAttempts = 0;
      if (this._versusFocusReviveTimer) {
        clearTimeout(this._versusFocusReviveTimer);
        this._versusFocusReviveTimer = null;
      }
      if (typeof window !== "undefined") {
        window.__mpVersusFocusRemoteAlive = undefined;
        window.__mpSpectateMenuFp = null;
      }
      return this._seatVersusFocusNative({
        reason: reason || "new_run",
        force: true,
      });
    };

    App.prototype._enterVersusFocusSpectate = function () {
      if (this._versusFocusSpectate) return;
      this._versusFocusSpectate = true;
      this._installVersusFocusTick();
      if (Mp && Mp.enterVersusFocus) Mp.enterVersusFocus();
      else if (typeof window !== "undefined") {
        window.__mpVersusFocusSpectate = true;
        window.__mpSpectateAllowMenus = false;
        window.__mpVersusFocusPaintFallback = false;
        window.__mpSpectateMenuFp = null;
        window.__mpVersusFocusRemoteAlive = undefined;
        this._clearVersusFocusSeatFlags({ requirePlay: true });
      }
      this._versusFocusRevivePending = false;
      this._versusFocusNativeRetrying = false;
      if (Gsm.installSpectatorTimeKeeperGuard) Gsm.installSpectatorTimeKeeperGuard();
      if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
      if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
      if (Gsm.hideControlHelper) Gsm.hideControlHelper();
      this.hideNativeBoard(false);
      this.ensureAutoFocus();
      if (!this._versusFocusPlayStarted) {
        this._versusFocusPlayStarted = true;
        this._seatVersusFocusNative({ reason: "enter", force: true });
      }
      this.startVersusFocusLoop();
    };

    App.prototype._leaveVersusFocusSpectate = function () {
      if (!this._versusFocusSpectate) {
        if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
        if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
        return;
      }
      this._versusFocusSpectate = false;
      this._versusFocusPlayStarted = false;
      this._versusFocusRevivePending = false;
      this._versusFocusNativeRetrying = false;
      if (Mp && Mp.leaveVersusFocus) Mp.leaveVersusFocus();
      else if (typeof window !== "undefined") {
        window.__mpVersusFocusSpectate = false;
        window.__mpVersusFocusBoard = null;
        window.__mpSpectateAllowMenus = false;
        window.__mpVersusFocusPaintFallback = false;
        window.__mpSpectateMenuFp = null;
        window.__mpVersusFocusRemoteAlive = undefined;
        window.__mpFocusRequirePlay = false;
        window.__mpFocusNativeOk = false;
        window.__mpFocusSeated = false;
        window.__mpFocusSeatPoseFp = null;
        window.__mpFocusRemoteStarted = false;
        window.__mpFocusRemoteHead = null;
        window.__mpFocusRemoteBody = null;
        window.__mpFocusPoseFp = null;
        window.__mpFocusForceFullBody = false;
      }
      this.stopVersusFocusLoop();
      if (Gsm.restoreControlHelper) Gsm.restoreControlHelper();
      if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
      if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
    };

    App.prototype.startVersusFocusLoop = function () {
      const self = this;
      if (this._versusFocusRaf) return;
      let frames = 0;
      function frame() {
        self._versusFocusRaf = 0;
        if (!self._versusFocusSpectate) return;
        frames++;
        if (frames % 45 === 0) self._ensureVersusFocusNative();
        const board = self.versus && self.versus.focusBoard();
        if (board) {
          if (typeof window !== "undefined") window.__mpVersusFocusBoard = board;
          self._syncVersusFocusAlive(board);
          const needRafInject =
            board.alive === false ||
            (typeof window !== "undefined" &&
              (!!window.__mpFocusRequirePlay || !window.__mpFocusNativeOk));
          if (needRafInject) {
            self._paintVersusFocus(board);
          }
        }
        if (Gsm.hideControlHelper) Gsm.hideControlHelper();
        if (
          board &&
          (typeof window === "undefined" || !window.__mpSpectateAllowMenus) &&
          (typeof window === "undefined" || !window.__mpFocusRequirePlay)
        ) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
        }
        self._versusFocusRaf = requestAnimationFrame(frame);
      }
      this._versusFocusRaf = requestAnimationFrame(frame);
    };

    App.prototype.stopVersusFocusLoop = function () {
      if (this._versusFocusRaf) {
        cancelAnimationFrame(this._versusFocusRaf);
        this._versusFocusRaf = 0;
      }
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
        if (!sessionOn) {
          if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
          if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
          this.applyControlLocks();
        }
        return;
      }

      this._enterVersusFocusSpectate();
      const board = this.versus.focusBoard();
      if (board) {
        this._paintVersusFocus(board);
      }
      if (
        typeof window === "undefined" ||
        (!window.__mpFocusRequirePlay && !window.__mpSpectateAllowMenus)
      ) {
        if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
      }
    };
  }

  root.MultiplayerFocus = { install: install };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { install: install };
  }
})(typeof window !== "undefined" ? window : globalThis);
