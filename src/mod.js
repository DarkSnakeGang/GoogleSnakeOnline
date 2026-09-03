/** MultiplayerMod app controller + GSM loader hooks. */
(function (root) {
  const Client = root.MultiplayerClient;
  const VersusState = root.VersusState;
  const VersusTimeKeeper = root.VersusTimeKeeper;
  const CoopState = root.CoopState;
  const CoopNative = root.CoopNative;
  const CoopTK = root.CoopTimeKeeper;
  const UI = root.MultiplayerUI;
  const P = root.MultiplayerProtocol;
  const Gsm = root.MultiplayerGsm;
  const Colors = root.MultiplayerColors;

  function MultiplayerApp() {
    this.client = null;
    this.versus = new VersusState();
    this.coop = new CoopState();
    this.coopNative = new CoopNative();
    this.ui = new UI(this);
    this._boardTimer = null;
    this._scoreTimer = null;
    this._coopSyncTimer = null;
    this._coopPaintRaf = 0;
    this._focusCanvas = null;
    this._mosaicEl = null;
    this._mosaicCells = {};
    this._coopPaused = false;
    this._nativeCanvasHidden = false;
    this._coopSessionActive = false;
    this._coopDeadSent = false;
    this._statusEl = null;
    this._lastModeLabel = "—";
  }

  MultiplayerApp.prototype._log = function (event, detail) {
    try {
      console.info("[Multiplayer]", event, detail || "");
    } catch (e) { /* ignore */ }
  };

  MultiplayerApp.prototype.updateStatusIndicator = function () {
    if (!this._statusEl || !this._statusEl.isConnected) {
      this._statusEl = claimModIndicator();
    }
    if (!this._statusEl) return;
    const connected = !!(this.client && this.client.connected);
    let status = "Disconnected";
    if (connected) {
      const ms = this.client.lastPingMs;
      status =
        ms != null && Number.isFinite(ms)
          ? "Connected [" + Math.round(ms) + "ms]"
          : "Connected";
    }
    let type = "—";
    const mode =
      (this.client && this.client.roster && this.client.roster.mode) || null;
    if (mode === "coop") type = "Co-op Mode";
    else if (mode === "versus") type = "Versus Mode";
    else if (this._lastModeLabel && this._lastModeLabel !== "—") type = this._lastModeLabel;
    if (mode === "coop" || mode === "versus") this._lastModeLabel = type;

    // Versus attempt clock while session is live, or 00:00 after expire until next Start
    let timerPart = "";
    const sessionOn = !!(
      this.client &&
      this.client.roster &&
      this.client.roster.sessionActive
    );
    const showClock =
      mode === "versus" &&
      this.versus &&
      (sessionOn || this.versus.expired);
    if (showClock) {
      const clock = VersusState.formatAttemptClock(
        this.versus.attemptRemainingMs,
        this.versus.expired
      );
      if (clock) timerPart = " - " + clock;
    }

    this._statusEl.textContent =
      "Multiplayer Mod - " + status + " - " + type + timerPart;
    layoutHudCounters();
  };

  /** Push Pudding wall/stat counter right of the (longer) mod status line. */
  function layoutHudCounters() {
    const ind = document.getElementById("mp-mod-indicator");
    const icon = document.getElementById("stat-icon");
    const num = document.getElementById("counter-num");
    if (!icon) return;

    // Measure with left reset so relative offset is from natural position
    icon.style.left = "0px";
    if (num) num.style.left = "0px";

    // Extra gap so counter never sits on top of "Versus Mode - MM:SS"
    const GAP = 48;
    let delta = 260;
    if (ind) {
      const need = ind.getBoundingClientRect().right + GAP;
      const natural = icon.getBoundingClientRect().left;
      delta = Math.max(260, Math.ceil(need - natural));
    }
    icon.style.left = delta + "px";
    if (num) num.style.left = delta + 34 + "px";
  }

  /** Reuse Remix's mod label (beside score), do not invent a second #countdown line. */
  function claimModIndicator() {
    // Drop leftover indicators we may have wrongly put under #countdown
    document.querySelectorAll("#mp-mod-indicator").forEach(function (node) {
      const parent = node.parentElement;
      if (parent && parent.classList && parent.classList.contains("EjCLSb")) return;
      if (parent && parent.id === "countdown") node.remove();
    });

    let el = document.getElementById("mp-mod-indicator");
    if (el && el.parentElement && el.parentElement.classList.contains("EjCLSb")) {
      return el;
    }

    const parent = document.getElementsByClassName("EjCLSb")[0];
    if (parent) {
      const kids = Array.from(parent.children);
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (kid.tagName !== "DIV") continue;
        const t = (kid.textContent || "").trim();
        if (
          t === "Remix Mod" ||
          t.indexOf("Remix Mod") === 0 ||
          t.indexOf("Multiplayer Mod") === 0
        ) {
          kid.id = "mp-mod-indicator";
          return kid;
        }
      }
    }

    // Fallback: same placement Remix uses
    el = document.createElement("div");
    el.id = "mp-mod-indicator";
    el.style.cssText =
      "position:absolute;font-family:Arial,sans-serif;color:white;font-size:14px;padding-top:4px;padding-left:30px;user-select:none;";
    el.textContent = "Multiplayer Mod - Disconnected - —";
    const canvasNode = document.getElementsByClassName("jNB0Ic")[0];
    if (parent && canvasNode && canvasNode.parentElement === parent) {
      parent.insertBefore(el, canvasNode);
    } else if (parent) {
      parent.appendChild(el);
    }
    return el;
  }

  MultiplayerApp.prototype.applyControlLocks = function () {
    if (!Gsm.setNativeMenusLocked) return;
    const connected = !!(this.client && this.client.connected);
    if (!connected) {
      Gsm.setNativeMenusLocked(false);
      if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(false);
      return;
    }
    const isAdmin = this.client.isAdmin();
    if (!isAdmin) {
      // Lock match settings + Play; cosmetics stay open
      Gsm.setNativeMenusLocked(true);
    } else {
      // Admin can edit trophy/count/speed/size
      Gsm.setNativeMenusLocked(false);
    }
    // Play stays disabled for everyone while connected (Start match only)
    if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(true);
    // Always re-assert cosmetics are clickable (survives Focus helper-hide / role flips)
    if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
  };

  /**
   * Leaving spectator (promoted to player): drop Focus puppet, restore menus/death,
   * clear coop spectator flags so theme/color work again.
   */
  MultiplayerApp.prototype.clearSpectatorSeat = function () {
    this._leaveVersusFocusSpectate();
    if (Gsm.restoreControlHelper) Gsm.restoreControlHelper();
    if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
    if (typeof window !== "undefined") {
      window.__mpVersusFocusSpectate = false;
      window.__mpVersusFocusBoard = null;
      window.__mpCoopSpectator = false;
      // Don't force localDead unless an active coop spectator session remains
      if (!this._coopSessionActive) {
        window.__mpCoopLocalDead = false;
      }
    }
    if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
    this.hideNativeBoard(false);
  };

  MultiplayerApp.prototype.ensureAutoFocus = function () {
    if (!this.client || !this.client.roster) return;
    const me = this.client.me();
    if (!me || me.role !== "spectator") return;
    if (this.client.roster.mode !== "versus") return;
    const players = (this.client.roster.clients || []).filter(function (c) {
      return c.role === "player";
    });
    if (!players.length) return;
    if (
      this.versus.focusClientId &&
      players.some((p) => p.clientId === this.versus.focusClientId)
    ) {
      return;
    }
    const id = players[0].clientId;
    this.versus.setFocus(id);
    this.client.spectateFocus(id);
    if (!this.versus.boards[id] && this.client.resync) {
      this.client.resync();
    }
  };

  /**
   * Legacy name: native co-op no longer pauses/hides the board.
   * Kept to clear any prior overlay state when leaving co-op.
   */
  MultiplayerApp.prototype.setCoopAuthorityMode = function (on) {
    if (on) {
      // Native co-op: do not pause or hide the Google Snake canvas.
      this.hideNativeBoard(false);
      if (this._coopPaused) {
        Gsm.setLocalPaused(false);
        this._coopPaused = false;
      }
      if (this._focusCanvas) this._focusCanvas.style.display = "none";
    } else {
      if (this._coopPaused) {
        Gsm.setLocalPaused(false);
        this._coopPaused = false;
      }
      this.hideNativeBoard(false);
      if (this._focusCanvas) this._focusCanvas.style.display = "none";
      if (this.coopNative) this.coopNative.reset();
      this.stopCoopNativeLoop();
      this._coopSessionActive = false;
      this._coopDeadSent = false;
    }
  };

  MultiplayerApp.prototype.hideNativeBoard = function (hide) {
    const canvas =
      (Gsm.gameCanvas && Gsm.gameCanvas()) ||
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector("#canvas") ||
      document.querySelector("canvas");
    if (!canvas || canvas.id === "mp-focus-board" || (canvas.className || "").indexOf("mp-") >= 0) {
      return;
    }
    if (hide) {
      canvas.dataset.mpPrevVisibility = canvas.style.visibility || "";
      canvas.style.visibility = "hidden";
      this._nativeCanvasHidden = true;
    } else if (this._nativeCanvasHidden) {
      canvas.style.visibility = canvas.dataset.mpPrevVisibility || "";
      this._nativeCanvasHidden = false;
    }
  };

  MultiplayerApp.prototype.setSpectateMode = function (mode) {
    this.versus.setSpectateMode(mode);
    this.renderSpectateViews();
    this.ui.updateHud(this);
  };

  MultiplayerApp.prototype.renderSpectateViews = function () {
    this.renderFocusBoard();
    this.renderMosaic();
  };

  MultiplayerApp.prototype.connect = function (opts) {
    const self = this;
    if (this.client) this.disconnect();
    this.client = new Client(opts);
    this.coop.myClientId = null;
    this.versus.expired = false;

    this.client.on(P.TYPES.WELCOME, function (p) {
      self.coop.myClientId = p.clientId;
      const room = document.getElementById("mp-room-code");
      if (room) room.value = p.roomCode || "";
      self._log("WELCOME", p.roomCode);
      self.updateStatusIndicator();
    });
    this.client.on(P.TYPES.ROSTER, function (p) {
      self.versus.syncFromRoster(p);
      self.ui.updateHud(self);
      const me = self.client.me();
      const prevRole = self._lastMyRole;
      const nextRole = me && me.role;
      if (prevRole === "spectator" && nextRole === "player") {
        // Was watching → now playing: drop Focus locks so theme/color work
        self.clearSpectatorSeat();
      }
      self._lastMyRole = nextRole || null;
      self.ui.updateColorIcon(
        me && me.colorId,
        p.mode === "coop" && me && me.role === "player"
      );
      self.applyControlLocks();
      self.ensureAutoFocus();
      // Native co-op never uses the old paused/hidden board authority path
      if (p.mode !== "coop") {
        self.setCoopAuthorityMode(false);
      } else if (p.collectablesOwnerId && self.coopNative) {
        self.coopNative.collectablesOwnerId = p.collectablesOwnerId;
      }
      // Lobby / co-op: keep non-admin mode settings matched to admin
      self.applyRosterSettingsIfNeeded(p);
      // Keep in-game #color row in sync with claimed Co-op color
      if (p.mode === "coop" && me && me.role === "player" && me.colorId != null) {
        if (self._pendingColorId != null && Number(me.colorId) === Number(self._pendingColorId)) {
          self._pendingColorId = null;
        }
        const localIdx = Gsm.readSettingIndex("color");
        if (localIdx == null || Number(localIdx) !== Number(me.colorId)) {
          if (Gsm.applySnakeColor) Gsm.applySnakeColor(me.colorId);
        }
      }
      // Re-render after ensureAutoFocus so roster marks the watched player
      if (self.ui.renderRoster) self.ui.renderRoster(p);
      self.renderSpectateViews();
      self.updateStatusIndicator();
    });
    this.client.on(P.TYPES.MODE_CHANGE, function (p) {
      self._log("MODE_CHANGE", p && p.mode);
      self.versus.scores = {};
      self.versus.boards = {};
      self.versus.focusClientId = null;
      self.versus.expired = false;
      self.versus.attemptRemainingMs = null;
      self.versus.leaderClientId = null;
      self.versus.winnerClientId = null;
      self.coop.snapshot = null;
      self.endCoopNativeSession();
      self.setCoopAuthorityMode(false);
      if (VersusTimeKeeper) VersusTimeKeeper.endMode();
      if (self.client.roster && p && p.mode) {
        self.client.roster.mode = p.mode;
        self.client.roster.sessionActive = false;
        if (self.ui.renderRoster) self.ui.renderRoster(self.client.roster);
      }
      self.ui.updateHud(self);
      self.applyControlLocks();
      self.updateStatusIndicator();
      // Mode load: dismiss first-run arrow/hand tip as if already played once
      if (Gsm.installFirstRunControlTipGuard) {
        Gsm.installFirstRunControlTipGuard();
      }
      // Admin: push current trophy/count/speed/size so co-op/versus peers match
      if (self.client && self.client.isAdmin()) {
        setTimeout(function () {
          self.syncMySettingsAsAdmin();
        }, 40);
      }
    });
    this.client.on(P.TYPES.SCORE_PULSE, function (p) {
      self.versus.onScorePulse(p);
      self.ui.updateHud(self);
      // Never wipe Spec/Play buttons for score ticks — update stats in place
      if (self.ui.updateRosterScores) self.ui.updateRosterScores();
    });
    this.client.on(P.TYPES.ATTEMPT_TICK, function (p) {
      self.versus.onAttemptTick(p);
      self.ui.updateHud(self);
      self.updateStatusIndicator();
    });
    this.client.on(P.TYPES.ATTEMPT_EXPIRED, function (p) {
      self._versusRestartPending = false;
      self.versus.onExpired(p || {});
      self.versus.attemptRemainingMs = 0;
      self.applyControlLocks();
      self.ui.updateHud(self);
      if (self.ui.updateRosterScores) self.ui.updateRosterScores();
      self.updateStatusIndicator();
      self._log("ATTEMPT_EXPIRED", p && p.winnerClientId);
    });
    this.client.on(P.TYPES.BOARD_DELTA, function (p) {
      self.versus.onBoardDelta(p);
      self.ui.updateHud(self);
      self.renderSpectateViews();
    });
    this.client.on(P.TYPES.BOARD_SNAPSHOT, function (p) {
      self.versus.onBoardSnapshot(p);
      self.renderSpectateViews();
    });
    this.client.on(P.TYPES.STATE_DELTA, function () {
      // Legacy server sim — ignored for native co-op
    });
    this.client.on(P.TYPES.STATE_SNAPSHOT, function () {
      // Legacy server sim — ignored for native co-op
    });
    this.client.on(P.TYPES.SNAKE_DELTA, function (p) {
      if (!self.coopNative) return;
      // Ignore self-echo — local already applied at publishCoopState
      if (
        p &&
        p.clientId &&
        self.client &&
        p.clientId === self.client.clientId
      ) {
        return;
      }
      if (!p || !p.clientId) return;
      // Peer may arm the shared timer before pose coalesce
      if (p.timerArm || p.timerStartedAtMs != null) {
        self.armCoopRunTimer(p.timerStartedAtMs);
      }
      // During a live co-op session, coalesce latest pose per peer (apply on tick)
      if (
        self._coopSessionActive &&
        typeof window !== "undefined" &&
        typeof window.__mpCoopFlushPendingDeltas === "function"
      ) {
        if (!self._pendingCoopSnakeDeltas) {
          self._pendingCoopSnakeDeltas = Object.create(null);
        }
        self._pendingCoopSnakeDeltas[p.clientId] = p;
        return;
      }
      self.coopNative.applySnakeDelta(p);
    });
    this.client.on(P.TYPES.COLLECTABLES_DELTA, function (p) {
      if (!self.coopNative) return;
      // Ignore our own echo briefly while native board is authoritative
      if (
        p &&
        p.clientId &&
        self.client &&
        p.clientId === self.client.clientId &&
        typeof window !== "undefined" &&
        window.__mpCoopSkipFruitReapply
      ) {
        self.coopNative.applyCollectables(p);
        return;
      }
      self.coopNative.applyCollectables(p);
      if (Gsm.applyCollectables) Gsm.applyCollectables(p);
    });
    this.client.on(P.TYPES.COOP_PLAYER_DEAD, function (p) {
      if (!self.coopNative || !p) return;
      const id = p.clientId;
      if (id && self.coopNative.remotes[id]) {
        self.coopNative.remotes[id].alive = false;
        if (p.body && p.body.length) {
          self.coopNative.remotes[id].body = p.body;
        }
        self.coopNative.syncBridge();
      }
    });
    this.client.on(P.TYPES.COOP_TIMER_START, function (p) {
      self.armCoopRunTimer(p && p.timerStartedAtMs);
    });
    this.client.on(P.TYPES.SETTINGS_SYNC, function (settings) {
      self._log("SETTINGS_SYNC");
      if (self.client && self.client.roster && settings) {
        self.client.roster.settings = settings;
      }
      // Admin already has local values; applying again can open menus mid-click
      if (self.client && self.client.isAdmin()) {
        self._lastSyncedSettingsKey = self._settingsFingerprint(settings);
        return;
      }
      self.applySyncedSettings(settings);
    });
    this.client.on(P.TYPES.PLAY_SYNC, function () {
      self._log("PLAY_SYNC");
      const me = self.client.me();
      if (!me) return;
      const roster = self.client.roster || {};
      const isCoop = roster.mode === "coop";
      // Versus: PLAY_SYNC is the Start-match signal. Do not gate on stale
      // allowNewRuns — ROSTER with the fresh flag often arrives *after* PLAY_SYNC.
      // Server already enforced ready + allow_new_runs before broadcasting.
      if (me.role === "player") {
        // Prefer ready, but if SESSION_START already flipped sessionActive, start anyway
        if (!me.ready && !roster.sessionActive) return;
      } else if (me.role === "spectator") {
        if (isCoop) {
          self.startMatchLocalPlay({
            coop: true,
            spectator: true,
          });
          return;
        }
        // Versus Focus: every spectator (admin + non-admin) seats native Play
        // the same way. If Focus is already mounted from run 1, force a fresh
        // seat so run 2 matches the working first-run path.
        if (typeof window !== "undefined") {
          window.__mpStartingMatch = true;
        }
        const focusAlreadyMounted = !!self._versusFocusSpectate;
        self.ensureAutoFocus();
        self.renderFocusBoard();
        if (focusAlreadyMounted) {
          self._reseatVersusFocusForNewRun("play_sync");
        }
        return;
      } else {
        return;
      }
      if (isCoop) {
        self.startMatchLocalPlay({
          coop: true,
          spectator: me.role === "spectator",
        });
      } else if (me.role === "player") {
        // Any non-coop match (versus / default) — don't require mode==="versus"
        self.startMatchLocalPlay({ coop: false });
      }
    });
    this.client.on(P.TYPES.ERROR, function (p) {
      // Late SNAKE_DELTA / COLLECTABLES after ALL_DEAD — expected, not a UI error
      if (p && p.code === "not_coop_session") return;
      console.warn("Multiplayer ERROR", p);
      const st = document.getElementById("mp-status");
      if (st) st.textContent = "Error: " + (p.message || p.code);
      if (p && p.code === "player_cap") {
        if (st) {
          st.textContent =
            "Player cap reached (Versus ≤9, Co-op ≤4) — promote failed";
        }
      }
      if (p && (p.code === "color_taken" || p.code === "color_not_claimable")) {
        const me = self.client && self.client.me();
        const revert =
          self._colorBeforeClaim != null
            ? self._colorBeforeClaim
            : me && me.colorId != null
              ? me.colorId
              : 0;
        self._pendingColorId = null;
        self.revertLocalColor(revert);
        if (st) {
          st.textContent =
            p.code === "color_taken"
              ? "Color already taken — switched back"
              : "That color can’t be claimed — switched back";
        }
      }
      if (
        p &&
        (p.code === "player_cap" ||
          p.code === "not_admin" ||
          p.code === "bad_role" ||
          p.code === "unknown_client" ||
          p.code === "spectators_cannot_ready")
      ) {
        // Roll back optimistic Spec/Play/Ready UI from authoritative roster
        if (self.client && self.client.resync) self.client.resync();
      }
      if (p && p.code === "kicked") {
        self.disconnect();
      }
    });
    this.client.on(P.TYPES.KICK, function (p) {
      if (p && p.clientId && self.client && p.clientId === self.client.clientId) {
        self._log("KICK", "self");
        self.disconnect();
      }
    });
    this.client.on(P.TYPES.SPECTATE_FOCUS, function (p) {
      if (!p || !p.clientId) return;
      const roster = self.client && self.client.roster;
      const target =
        roster &&
        (roster.clients || []).find(function (c) {
          return c.clientId === p.clientId;
        });
      if (!target || target.role !== "player") return;
      self.versus.setFocus(p.clientId);
      if (!self.versus.boards[p.clientId] && self.client.resync) {
        self.client.resync();
      }
      self.renderSpectateViews();
      self.ui.updateHud(self);
      if (self.ui.renderRoster && roster) self.ui.renderRoster(roster);
    });
    this.client.on(P.TYPES.SESSION_END, function (p) {
      self._log("SESSION_END", p && p.reason);
      // Stop co-op publishes immediately so late ticks don't hit not_coop_session
      if (self.client && self.client.roster) {
        self.client.roster.sessionActive = false;
      }
      self._coopSessionActive = false;
      if (typeof window !== "undefined") {
        window.__mpCoopAfterTick = null;
        window.__mpCoopFlushPendingDeltas = null;
        window.__mpCoopSession = false;
        window.__mpCoopInject = false;
      }
      self.versus.attemptRemainingMs = null;
      // Co-op: freeze native run clock for everyone (ALL_DEAD / ALL_APPLES)
      if (Gsm.stopCoopRunTimer) Gsm.stopCoopRunTimer();
      // Keep last-match scores/winner until the next Start match
      const hasScores =
        self.versus.scores && Object.keys(self.versus.scores).length > 0;
      if (hasScores) {
        self.versus.expired = true;
        if (!self.versus.winnerClientId) {
          self.versus.winnerClientId = VersusState.pickLeader(
            self.versus.scores,
            self.versus.versusGoal
          );
          self.versus.leaderClientId = self.versus.winnerClientId;
        }
      }
      self._leaveVersusFocusSpectate();
      self.endCoopNativeSession();
      self.returnToMenus({ fromRemote: true });
      if (self.client && self.client.roster && self.ui.renderRoster) {
        // sessionActive already cleared at handler start
        if (hasScores) self.client.roster.attemptExpired = true;
        self.ui.renderRoster(self.client.roster);
      }
      self.ui.updateHud(self);
      self.updateStatusIndicator();
    });
    this.client.on(P.TYPES.SESSION_START, function (p) {
      self._log("SESSION_START", p && p.mode);
      // Block SETTINGS_SYNC from opening menus before PLAY_SYNC / triggerPlay
      if (typeof window !== "undefined") {
        window.__mpStartingMatch = true;
      }
      if (self.versus && self.versus.resetForNewMatch) {
        self.versus.resetForNewMatch();
      } else if (self.versus) {
        self.versus.scores = {};
        self.versus.boards = {};
        self.versus.expired = false;
        self.versus.attemptRemainingMs = null;
        self.versus.leaderClientId = null;
        self.versus.winnerClientId = null;
      }
      if (self.client && self.client.roster) {
        self.client.roster.sessionActive = true;
        // Clear stale "no new runs" before PLAY_SYNC (ROSTER may arrive later)
        self.client.roster.allowNewRuns = true;
        self.client.roster.attemptExpired = false;
        if (p && p.mode) self.client.roster.mode = p.mode;
        if (self.ui.renderRoster) self.ui.renderRoster(self.client.roster);
      }
      // Versus: SpeedInfo uses a fresh session TimeKeeper (not lifetime remix PBs)
      if (VersusTimeKeeper) {
        if (p && p.mode === "versus") VersusTimeKeeper.beginMatch();
        else VersusTimeKeeper.endMode();
      }
      self.updateStatusIndicator();
      self.ui.updateHud(self);
      if (self.ui.updateRosterScores) self.ui.updateRosterScores();
      // Apply admin match rules quietly (trophy/count/speed/size) before Play
      if (p && p.settings && !self.client.isAdmin()) {
        self.applySyncedSettings(p.settings);
      }
      if (p && p.mode === "coop") {
        self.setCoopAuthorityMode(true);
        self._coopSlots = (p.slots || []).slice();
        self._coopSpawnApplied = false;
        self._coopPlayerMoved = false;
        self._coopTimerArmed = false;
        // Timer arms on first move (COOP_TIMER_START), not at SESSION_START
        self._coopTimerStartedAtMs = null;
        if (typeof window !== "undefined") {
          window.__mpCoopLocalDead = false;
        }
        if (self.coopNative) {
          self.coopNative.reset();
          self.coopNative.sessionActive = true;
          self.coopNative.myClientId = self.client.clientId;
          self.coopNative.collectablesOwnerId =
            p.collectablesOwnerId ||
            (self.client.roster && self.client.roster.collectablesOwnerId) ||
            null;
          if (self.coopNative.beginSeedSticky) self.coopNative.beginSeedSticky(1500);
          self.coopNative.syncBridge();
        }
        self._coopDeadSent = false;
        // Spectators/players enter via PLAY_SYNC (real Play); no paint-only path
      }
    });
    this.client.on("RECONNECTING", function (p) {
      const st = document.getElementById("mp-status");
      if (st) {
        st.textContent =
          "Reconnecting… (" + (p && p.attempt) + ")";
      }
      self.updateStatusIndicator();
    });
    this.client.on("RECONNECTED", function () {
      self._log("RECONNECTED");
      self.client.resync();
      self.updateStatusIndicator();
    });
    this.client.on("CLOSE", function (ev) {
      self._log("CLOSE", ev && ev.code);
      if (VersusTimeKeeper) VersusTimeKeeper.endMode();
      self.applyControlLocks();
      self.updateStatusIndicator();
    });
    this.client.on("PING_UPDATE", function () {
      self.updateStatusIndicator();
    });

    return this.client.connect().then(function () {
      self.ui.mountHud();
      self.ensureFocusCanvas();
      self.applyControlLocks();
      self.updateStatusIndicator();
      if (Gsm.installFirstRunControlTipGuard) {
        Gsm.installFirstRunControlTipGuard();
      }
    });
  };

  MultiplayerApp.prototype.disconnect = function () {
    this._leaveVersusFocusSpectate();
    this.endCoopNativeSession();
    this.setCoopAuthorityMode(false);
    if (VersusTimeKeeper) VersusTimeKeeper.endMode();
    if (this.client) this.client.disconnect();
    this.client = null;
    if (this.ui.renderRoster) this.ui.renderRoster({ clients: [], mode: "" });
    this.ui.updateColorIcon(null, false);
    if (this._focusCanvas) this._focusCanvas.style.display = "none";
    if (this._mosaicEl) this._mosaicEl.style.display = "none";
    this.applyControlLocks();
    this.ui.updateHud(this);
    this.updateStatusIndicator();
  };

  MultiplayerApp.prototype.focusRelative = function (delta) {
    if (!this.client || !this.client.roster) return;
    const players = (this.client.roster.clients || []).filter(function (c) {
      return c.role === "player";
    });
    if (!players.length) return;
    let idx = players.findIndex((p) => p.clientId === this.versus.focusClientId);
    if (idx < 0) idx = 0;
    else idx = (idx + delta + players.length) % players.length;
    this.focusSpectatePlayer(players[idx].clientId, { keepMode: true });
  };

  /**
   * Switch spectator Focus stream to a player. Resyncs if their board cache is empty.
   * Only players can be focused — never spectators (or missing roster seats).
   * @param {string} clientId
   * @param {{ keepMode?: boolean }} [opts] keepMode: stay in mosaic/focus as-is (cycle keys)
   */
  MultiplayerApp.prototype.focusSpectatePlayer = function (clientId, opts) {
    opts = opts || {};
    if (!clientId || !this.client || !this.client.roster) return;
    const me = this.client.me();
    if (!me || me.role !== "spectator") return;
    if (this.client.roster.mode !== "versus") return;
    const target = (this.client.roster.clients || []).find(function (c) {
      return c.clientId === clientId;
    });
    if (!target || target.role !== "player") return;
    if (typeof window !== "undefined") {
      window.__mpSpectateAllowMenus = false;
    }
    this.versus.setFocus(clientId);
    this.client.spectateFocus(clientId);
    if (!opts.keepMode) {
      this.versus.setSpectateMode("focus");
      const btn = document.getElementById("mp-mosaic-toggle");
      if (btn) btn.textContent = "Mosaic";
    }
    if (!this.versus.boards[clientId] && this.client.resync) {
      this.client.resync();
    }
    this.renderSpectateViews();
    this.ui.updateHud(this);
    if (this.ui.renderRoster) {
      this.ui.renderRoster(this.client.roster);
    }
  };

  MultiplayerApp.prototype._settingsFingerprint = function (settings) {
    if (!settings || typeof settings !== "object") return "";
    const keys = ["trophy", "count", "speed", "size"];
    return keys
      .map(function (k) {
        return k + ":" + (settings[k] != null ? settings[k] : "");
      })
      .join("|");
  };

  /**
   * Apply admin match rules (trophy/count/speed/size). Retries until DOM matches
   * so lobby changes stick without waiting for Start match.
   */
  MultiplayerApp.prototype.applySyncedSettings = function (settings) {
    if (!settings || typeof settings !== "object") return;
    const self = this;
    const key = this._settingsFingerprint(settings);
    const hasAny = ["trophy", "count", "speed", "size"].some(function (k) {
      return settings[k] != null;
    });
    if (!hasAny) return;

    function matched() {
      return Gsm.settingsMatchLocal
        ? Gsm.settingsMatchLocal(settings)
        : false;
    }

    Gsm.applySettings(settings);
    if (matched()) {
      self._lastSyncedSettingsKey = key;
      return;
    }
    // Don't permanently mark as synced — roster can retry later
    if (self._settingsApplyTimer) clearTimeout(self._settingsApplyTimer);
    let attempt = 0;
    function retry() {
      self._settingsApplyTimer = null;
      if (!self.client || !self.client.connected) return;
      if (self.client.isAdmin()) return;
      if (matched()) {
        self._lastSyncedSettingsKey = key;
        return;
      }
      Gsm.applySettings(settings);
      attempt += 1;
      if (attempt < 6 && !matched()) {
        self._settingsApplyTimer = setTimeout(retry, 80 + attempt * 40);
      } else if (matched()) {
        self._lastSyncedSettingsKey = key;
      }
    }
    self._settingsApplyTimer = setTimeout(retry, 60);
  };

  /**
   * Non-admin: apply room match rules (trophy/count/speed/size) when roster
   * carries a newer settings snapshot (lobby + co-op/versus).
   */
  MultiplayerApp.prototype.applyRosterSettingsIfNeeded = function (roster) {
    if (!roster || !roster.settings) return;
    if (!this.client || this.client.isAdmin()) return;
    const key = this._settingsFingerprint(roster.settings);
    if (!key) return;
    const hasAny = ["trophy", "count", "speed", "size"].some(function (k) {
      return roster.settings[k] != null;
    });
    if (!hasAny) return;
    const matched = Gsm.settingsMatchLocal
      ? Gsm.settingsMatchLocal(roster.settings)
      : false;
    if (key === this._lastSyncedSettingsKey && matched) return;
    this.applySyncedSettings(roster.settings);
  };

  MultiplayerApp.prototype.syncMySettingsAsAdmin = function () {
    if (!this.client || !this.client.isAdmin()) return null;
    const snap = Gsm.snapshotSyncSettings
      ? Gsm.snapshotSyncSettings()
      : (function () {
          const s = Gsm.snapshotSettings();
          ["color", "apple", "graphics", "theme"].forEach(function (k) {
            delete s[k];
          });
          return s;
        })();
    this.client.syncSettings(snap);
    if (this.client.roster) this.client.roster.settings = snap;
    this._lastSyncedSettingsKey = this._settingsFingerprint(snap);
    return snap;
  };

  MultiplayerApp.prototype.revertLocalColor = function (colorId) {
    const id = colorId != null ? colorId : 0;
    if (Gsm.applySnakeColor) Gsm.applySnakeColor(id);
  };

    MultiplayerApp.prototype.onLocalColorPicked = function () {
    if (root.__mpApplyingColor) return;
    if (!this.client || !this.client.connected) return;
    const me = this.client.me();
    // Players claim for roster; spectators may still change local cosmetics
    const idx = Gsm.readSettingIndex("color");
    if (idx == null || Number.isNaN(Number(idx))) return;
    const colorId = Number(idx);

    if (!me || me.role !== "player") return;

    // Random is not claimable — snap back
    if (colorId === 46 || (Colors && Colors.isClaimable && !Colors.isClaimable(colorId))) {
      this.revertLocalColor(me.colorId != null ? me.colorId : 0);
      const st = document.getElementById("mp-status");
      if (st) st.textContent = "That color can’t be claimed — pick another";
      return;
    }

    // Same as already claimed — nothing to do
    if (me.colorId != null && Number(me.colorId) === colorId) return;

    // Co-op: refuse colors already taken by another player
    if (this.client.roster && this.client.roster.mode === "coop") {
      const clients = (this.client.roster.clients || []);
      const taken = clients.some(function (c) {
        return (
          c &&
          c.role === "player" &&
          c.clientId !== me.clientId &&
          c.colorId != null &&
          Number(c.colorId) === colorId
        );
      });
      if (taken) {
        this.revertLocalColor(me.colorId != null ? me.colorId : 0);
        const st = document.getElementById("mp-status");
        if (st) st.textContent = "That color is taken — pick another";
        return;
      }
    }

    this._pendingColorId = colorId;
    this._colorBeforeClaim = me.colorId != null ? me.colorId : null;
    this.client.claimColor(colorId);
  };

  MultiplayerApp.prototype.hookInGameColorPicker = function () {
    const self = this;
    function bindRow() {
      const row = document.getElementById("color");
      if (!row || row.__mpColorHooked) return !!row;
      row.__mpColorHooked = true;
      row.addEventListener(
        "click",
        function () {
          setTimeout(function () {
            self.onLocalColorPicked();
          }, 40);
        },
        true
      );
      return true;
    }
    if (!bindRow()) {
      setTimeout(bindRow, 300);
      setTimeout(bindRow, 1000);
    }

    // Also catch puddingMenuSelect("color", …) paths
    if (typeof root.puddingMenuSelect === "function" && !root.puddingMenuSelect.__mpColorWrapped) {
      const orig = root.puddingMenuSelect;
      root.puddingMenuSelect = function (id, index) {
        const r = orig.apply(this, arguments);
        if (id === "color" && !root.__mpApplyingColor) {
          setTimeout(function () {
            self.onLocalColorPicked();
          }, 40);
        }
        return r;
      };
      root.puddingMenuSelect.__mpColorWrapped = true;
    }
  };

  MultiplayerApp.prototype.ensureFocusCanvas = function () {
    // Floating canvas is Co-op only; Versus focus uses the native game canvas.
    if (this._focusCanvas) return this._focusCanvas;
    const c = document.createElement("canvas");
    c.id = "mp-focus-board";
    c.width = 510;
    c.height = 450;
    c.style.cssText =
      "position:fixed;left:50%;top:52%;transform:translate(-50%,-50%);z-index:9997;" +
      "border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.4);display:none;background:#aad751;" +
      "max-width:92vw;max-height:78vh;";
    document.body.appendChild(c);
    this._focusCanvas = c;
    return c;
  };

  MultiplayerApp.prototype._colorForClient = function (clientId) {
    const board =
      this.versus && this.versus.boards && this.versus.boards[clientId];

    // Prefer live scraped engine colors from that player's BOARD_DELTA
    if (board && (board.Sc || board.Yc || (board.colorSet && board.colorSet.length))) {
      const info = {
        primary: board.Sc || board.Yc || null,
        secondary: board.Yc || board.Sc || null,
        Sc: board.Sc || null,
        Yc: board.Yc || null,
      };
      if (board.colorSet && board.colorSet.length) {
        info.set = board.colorSet;
      } else if (Colors && board.colorId != null) {
        const c = Colors.getColor(board.colorId);
        if (c && c.set && c.set.length) info.set = c.set;
        if (!info.primary && c && c.primary) {
          info.primary = c.primary;
          info.secondary = c.secondary || c.primary;
        }
      }
      if (info.primary || info.set) return info;
    }

    if (!Colors) return null;
    let colorId = null;
    if (board && board.colorId != null) colorId = board.colorId;
    if (colorId == null && this.client && this.client.roster) {
      const c = (this.client.roster.clients || []).find(function (x) {
        return x.clientId === clientId;
      });
      if (c && c.colorId != null) colorId = c.colorId;
    }
    if (colorId == null) return null;
    return Colors.getColor(colorId);
  };

  MultiplayerApp.prototype._isVersusSpectator = function () {
    const me = this.client && this.client.me();
    return !!(
      me &&
      me.role === "spectator" &&
      this.client.roster &&
      this.client.roster.mode === "versus"
    );
  };

  /** Native game canvas used for Versus Focus paint (not mosaic / focus fake). */
  MultiplayerApp.prototype._versusFocusCanvas = function () {
    const c =
      (Gsm.gameCanvas && Gsm.gameCanvas()) ||
      document.querySelector("canvas.nEoGkc") ||
      document.querySelector("canvas");
    if (!c || c.id === "mp-focus-board" || (c.className || "").indexOf("mp-") >= 0) {
      return null;
    }
    return c;
  };

  /**
   * Clear Focus seat leftovers so the next spectated life matches a clean first enter.
   * Without this, a mounted Focus keeps Seated/NativeOk/RemoteStarted from run 1 and
   * run 2 goes head-only / skips startNativeRun (esp. bad for non-admin Play gating).
   */
  MultiplayerApp.prototype._clearVersusFocusSeatFlags = function (opts) {
    opts = opts || {};
    if (typeof window === "undefined") return;
    window.__mpFocusSeated = false;
    window.__mpFocusForceFullBody = true;
    window.__mpFocusSeatPoseFp = null;
    window.__mpFocusRemoteStarted = false;
    window.__mpFocusRemoteHead = null;
    window.__mpFocusRemoteBody = null;
    window.__mpFocusPoseFp = null;
    window.__mpFocusNativeOk = false;
    if (opts.requirePlay !== false) {
      window.__mpFocusRequirePlay = true;
    }
  };

  /**
   * Versus Focus: keep local death UI / engine seat matched to remote board.alive.
   * false→true means the focused player reset — re-seat Play so we are not stuck dead.
   */
  MultiplayerApp.prototype._syncVersusFocusAlive = function (board) {
    if (!board || typeof window === "undefined") return;
    const remoteAlive = board.alive !== false;
    const prev = window.__mpVersusFocusRemoteAlive;
    // Detect revive BEFORE flipping the flag so applySpectateState can full-seat
    if (prev === false && remoteAlive) {
      this._clearVersusFocusSeatFlags({ requirePlay: true });
    }
    window.__mpVersusFocusRemoteAlive = remoteAlive;
    if (!remoteAlive) {
      // Real remote death — drop first-run seat flags so the next life reseats cleanly
      // even if a dead BOARD_DELTA frame is skipped (alive→alive after auto-restart).
      this._clearVersusFocusSeatFlags({ requirePlay: true });
      return;
    }
    if (
      typeof window === "undefined" ||
      !window.__mpSpectateAllowMenus
    ) {
      if (
        !window.__mpFocusRequirePlay &&
        (Gsm.dismissDeathOverlayForRun || Gsm.hideDeathScreen)
      ) {
        if (Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
        else Gsm.hideDeathScreen();
      }
    }
    // Player restarted after a death — local puppet often stays nj/dead until Play
    if (prev === false && !this._versusFocusRevivePending) {
      this._versusFocusRevivePending = true;
      const self = this;
      setTimeout(function () {
        self._versusFocusRevivePending = false;
        if (!self._versusFocusSpectate) return;
        self._seatVersusFocusNative({ reason: "revive", force: true });
      }, 0);
    }
  };

  /**
   * One native Play seat for every Focus spectator (admin + non-admin identical).
   * force: retry even if a prior attempt claimed success.
   */
  MultiplayerApp.prototype._seatVersusFocusNative = function (opts) {
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
    if (typeof window !== "undefined") {
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
          // Only clear the Play gate on success — failed seats must keep retrying
          if (ok) {
            window.__mpFocusRequirePlay = false;
            window.__mpFocusNativeOk = true;
            window.__mpFocusSeated = false;
            window.__mpFocusForceFullBody = true;
            self._versusFocusSeatAttempts = 0;
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
        }
      },
    });
    return true;
  };

  /** Push latest focus board into the live GameInstance each native tick. */
  MultiplayerApp.prototype._installVersusFocusTick = function () {
    const self = this;
    if (typeof window === "undefined") return;
    window.__mpVersusFocusOnTick = function () {
      if (!window.__mpVersusFocusSpectate) return;
      const board =
        (self.versus && self.versus.focusBoard()) ||
        window.__mpVersusFocusBoard;
      if (!board || !Gsm.applySpectateState) return;
      if (typeof window !== "undefined") window.__mpVersusFocusBoard = board;
      self._syncVersusFocusAlive(board);
      const colorInfo = self._colorForClient(self.versus && self.versus.focusClientId);
      Gsm.applySpectateState(null, board, colorInfo, { paint: false });
      if (Gsm.hideControlHelper) Gsm.hideControlHelper();
      if (
        board.alive !== false &&
        !window.__mpFocusRequirePlay &&
        !window.__mpSpectateAllowMenus &&
        Gsm.hideDeathScreen
      ) {
        Gsm.hideDeathScreen();
      }
    };
  };

  MultiplayerApp.prototype._paintVersusFocus = function (board) {
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

  /** Keep retrying Play until Focus has a live native GameInstance (all seats). */
  MultiplayerApp.prototype._ensureVersusFocusNative = function () {
    // Do not hammer Play while the focused player is dead — wait for revive/PLAY_SYNC
    if (
      typeof window !== "undefined" &&
      window.__mpVersusFocusRemoteAlive === false
    ) {
      return;
    }
    this._seatVersusFocusNative({ reason: "ensure", force: false });
  };

  /**
   * New versus run while Focus is already mounted (PLAY_SYNC / Start match).
   * First enter seats once; without this, run 2 keeps stale NativeOk/Seated flags.
   */
  MultiplayerApp.prototype._reseatVersusFocusForNewRun = function (reason) {
    if (!this._versusFocusSpectate) {
      this._enterVersusFocusSpectate();
      return !!this._versusFocusSpectate;
    }
    this._clearVersusFocusSeatFlags({ requirePlay: true });
    this._versusFocusPlayStarted = true;
    this._versusFocusRevivePending = false;
    this._versusFocusNativeRetrying = false;
    this._versusFocusSeatAttempts = 0;
    if (typeof window !== "undefined") {
      window.__mpVersusFocusRemoteAlive = undefined;
      window.__mpSpectateMenuFp = null;
    }
    return this._seatVersusFocusNative({
      reason: reason || "new_run",
      force: true,
    });
  };

  MultiplayerApp.prototype._enterVersusFocusSpectate = function () {
    if (this._versusFocusSpectate) return;
    this._versusFocusSpectate = true;
    this._installVersusFocusTick();
    if (typeof window !== "undefined") {
      window.__mpVersusFocusSpectate = true;
      window.__mpSpectateAllowMenus = false;
      window.__mpVersusFocusPaintFallback = false;
      window.__mpSpectateMenuFp = null;
      window.__mpVersusFocusRemoteAlive = undefined;
      window.__mpFocusSeated = false;
      window.__mpFocusSeatPoseFp = null;
      window.__mpFocusRemoteStarted = false;
      window.__mpFocusRemoteHead = null;
      window.__mpFocusRemoteBody = null;
      window.__mpFocusPoseFp = null;
      window.__mpFocusRequirePlay = true;
      window.__mpFocusNativeOk = false;
      window.__mpFocusForceFullBody = true;
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

  MultiplayerApp.prototype._leaveVersusFocusSpectate = function () {
    if (!this._versusFocusSpectate) {
      if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
      if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
      return;
    }
    this._versusFocusSpectate = false;
    this._versusFocusPlayStarted = false;
    this._versusFocusRevivePending = false;
    this._versusFocusNativeRetrying = false;
    if (typeof window !== "undefined") {
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

  /** Keep focus board pointer fresh; tick hook does the native inject. */
  MultiplayerApp.prototype.startVersusFocusLoop = function () {
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
        self._paintVersusFocus(board);
      }
      if (Gsm.hideControlHelper) Gsm.hideControlHelper();
      if (
        board &&
        board.alive !== false &&
        (typeof window === "undefined" || !window.__mpSpectateAllowMenus) &&
        (typeof window === "undefined" || !window.__mpFocusRequirePlay)
      ) {
        if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
      }
      self._versusFocusRaf = requestAnimationFrame(frame);
    }
    this._versusFocusRaf = requestAnimationFrame(frame);
  };

  MultiplayerApp.prototype.stopVersusFocusLoop = function () {
    if (this._versusFocusRaf) {
      cancelAnimationFrame(this._versusFocusRaf);
      this._versusFocusRaf = 0;
    }
  };

  MultiplayerApp.prototype.renderFocusBoard = function () {
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
    // Lobby: keep death screen / match settings usable (esp. admin spectator).
    // Focus puppet only while a versus match is actually running.
    if (!isSpec || mosaicOn || !sessionOn) {
      this._leaveVersusFocusSpectate();
      if (!sessionOn) {
        if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
        if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
        this.applyControlLocks();
      }
      return;
    }

    // Enter Focus seat even before the first BOARD_DELTA — otherwise we never
    // start a local GameInstance and injects have nowhere to land.
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

  MultiplayerApp.prototype.ensureMosaic = function () {
    if (this._mosaicEl) return this._mosaicEl;
    const el = document.createElement("div");
    el.id = "mp-mosaic";
    el.style.display = "none";
    document.body.appendChild(el);
    this._mosaicEl = el;
    this._mosaicCells = {};
    const self = this;
    if (typeof window !== "undefined") {
      window.__mpMosaicRepaint = function () {
        if (self.versus && self.versus.spectateMode === "mosaic") {
          self.renderMosaic();
        }
      };
    }
    return el;
  };

  MultiplayerApp.prototype.renderMosaic = function () {
    const me = this.client && this.client.me();
    const el = this.ensureMosaic();
    const isSpec =
      me &&
      me.role === "spectator" &&
      this.client.roster &&
      this.client.roster.mode === "versus";
    const sessionOn = !!(this.client.roster && this.client.roster.sessionActive);
    if (!isSpec || this.versus.spectateMode !== "mosaic" || !sessionOn) {
      el.style.display = "none";
      return;
    }
    // Mosaic uses fake mini-boards; keep native death/settings available underneath
    this._leaveVersusFocusSpectate();

    const players = (this.client.roster.clients || []).filter(function (c) {
      return c.role === "player";
    });
    if (!players.length) {
      el.style.display = "none";
      return;
    }
    const cols = Math.min(players.length, players.length <= 4 ? 2 : 3);
    el.style.display = "grid";
    el.style.gridTemplateColumns = "repeat(" + cols + ", minmax(180px, 1fr))";

    // Mosaic chrome: prefer focused/selected player's border, else first board with theme
    let chromeBorder = null;
    const focusBoard = this.versus.boards[this.versus.focusClientId];
    if (focusBoard && focusBoard.themeColors && focusBoard.themeColors.border) {
      chromeBorder = focusBoard.themeColors.border;
    } else {
      for (let i = 0; i < players.length; i++) {
        const b = this.versus.boards[players[i].clientId];
        if (b && b.themeColors && b.themeColors.border) {
          chromeBorder = b.themeColors.border;
          break;
        }
      }
    }
    if (chromeBorder) el.style.background = chromeBorder;

    const seen = {};
    const self = this;
    players.forEach(function (p) {
      seen[p.clientId] = true;
      let cell = self._mosaicCells[p.clientId];
      if (!cell) {
        cell = document.createElement("div");
        cell.className = "mp-mosaic-cell";
        const label = document.createElement("div");
        label.className = "mp-mosaic-label";
        const canvas = document.createElement("canvas");
        // ~1.4× prior 170×150 — readable 3×3 without dominating the screen
        canvas.width = 240;
        canvas.height = 212;
        canvas.className = "mp-mosaic-canvas";
        // Name sits above the mini-board
        cell.appendChild(label);
        cell.appendChild(canvas);
        cell.onclick = function (ev) {
          if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
          }
          self.focusSpectatePlayer(p.clientId);
        };
        el.appendChild(cell);
        self._mosaicCells[p.clientId] = cell;
      }
      const labelEl = cell.querySelector(".mp-mosaic-label");
      if (labelEl) {
        const name =
          p.resolvedName || p.displayName || p.colorName || p.clientId.slice(0, 6);
        labelEl.textContent = name;
        labelEl.title = name;
      }
      cell.classList.toggle(
        "mp-mosaic-focus",
        p.clientId === self.versus.focusClientId
      );
      const canvas = cell.querySelector("canvas");
      const board = self.versus.boards[p.clientId];
      const colorInfo = self._colorForClient(p.clientId);
      // Always paint with that player's themeColors when present (never spectator local)
      if (canvas && board) {
        Gsm.drawBoardOnCanvas(canvas, board, colorInfo, board.themeColors);
      } else if (canvas) {
        Gsm.drawBoardOnCanvas(
          canvas,
          { width: 17, height: 15, body: [], apples: [] },
          colorInfo
        );
      }
    });
    Object.keys(this._mosaicCells).forEach(function (id) {
      if (!seen[id]) {
        self._mosaicCells[id].remove();
        delete self._mosaicCells[id];
      }
    });
  };

  MultiplayerApp.prototype.renderCoopOverlay = function () {
    // Deprecated — remotes inject via __mpCoopOnTick on the native canvas.
  };

  /**
   * Start match → every participating client must enter a native Play run.
   * Retries until a *live* run (not a leftover dead GameInstance on the endscreen).
   */
  MultiplayerApp.prototype.startMatchLocalPlay = function (opts) {
    opts = opts || {};
    const self = this;
    // Drop sticky death hides that trap the endscreen; tip guard stays active
    if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
    if (Gsm.installFirstRunControlTipGuard) {
      Gsm.installFirstRunControlTipGuard();
    } else if (Gsm.hideControlHelper) {
      Gsm.hideControlHelper();
    }
    if (Gsm.startNativeRun) {
      Gsm.startNativeRun({
        maxAttempts: 50,
        intervalMs: 40,
        onDone: function (ok) {
          if (!opts.coop) return;
          if (!ok) {
            // Retry Play briefly rather than seating a dead GameInstance
            setTimeout(function () {
              Gsm.startNativeRun({
                maxAttempts: 30,
                intervalMs: 40,
                onDone: function (ok2) {
                  if (ok2) {
                    self.beginCoopNativeSession({
                      spectator: !!opts.spectator,
                    });
                    return;
                  }
                  // Last chance: seat anyway and let spawn reassert catch up
                  console.debug("[Multiplayer] co-op Play cold-start; seating with reassert");
                  self.beginCoopNativeSession({
                    spectator: !!opts.spectator,
                  });
                },
              });
            }, 100);
            return;
          }
          self.beginCoopNativeSession({
            spectator: !!opts.spectator,
          });
        },
      });
      return;
    }
    // Fallback if older Gsm bundle
    if (typeof window !== "undefined") {
      window.__mpStartingMatch = true;
    }
    try {
      if (Gsm.closeSettingsPanel) Gsm.closeSettingsPanel();
      else if (typeof window !== "undefined" && typeof window.BootstrapHide === "function") {
        window.BootstrapHide();
      }
    } catch (e) { /* ignore */ }
    if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
    if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
    let attempts = 0;
    function attempt() {
      attempts++;
      try {
        Gsm.triggerPlay();
      } catch (e) { /* ignore */ }
      const live = Gsm.isNativeRunLive
        ? Gsm.isNativeRunLive()
        : !!(Gsm.gameInstance && Gsm.gameInstance() && Gsm.gameInstance().oa);
      if (live || attempts >= 40) {
        if (opts.coop) {
          self.beginCoopNativeSession({ spectator: !!opts.spectator });
        }
        if (typeof window !== "undefined") {
          setTimeout(function () {
            window.__mpStartingMatch = false;
          }, 800);
        }
        return;
      }
      setTimeout(attempt, 50);
    }
    setTimeout(attempt, 50);
  };

  /** @deprecated use startMatchLocalPlay */
  MultiplayerApp.prototype.startCoopLocalRun = function (opts) {
    this.startMatchLocalPlay({
      coop: true,
      spectator: !!(opts && opts.spectator),
    });
  };

  MultiplayerApp.prototype.beginCoopNativeSession = function (opts) {
    opts = opts || {};
    this._coopSessionActive = true;
    this._coopLastPoseFp = null;
    this._coopColorsSent = false;
    this._coopSeatedPublish = false;
    this._coopTimerArmed = false;
    this._coopTimerStartedAtMs = null;
    this._coopPlayerMoved = false;
    if (typeof window !== "undefined") {
      window.__mpCoopSpectator = !!opts.spectator;
      if (opts.spectator) {
        window.__mpCoopLocalDead = true;
      } else {
        window.__mpCoopLocalDead = false;
      }
    }
    if (this.coopNative) {
      this.coopNative.sessionActive = true;
      this.coopNative.myClientId = this.client && this.client.clientId;
      this.coopNative.injectEnabled = true;
      if (this.coopNative.beginSeedSticky) this.coopNative.beginSeedSticky(1500);
      this.coopNative.syncBridge();
    }
    // Native run clock starts when any player first moves (see armCoopRunTimer)
    if (opts.spectator && Gsm.installSpectatorTimeKeeperGuard) {
      Gsm.installSpectatorTimeKeeperGuard();
    } else if (Gsm.installSpectatorTimeKeeperGuard) {
      Gsm.installSpectatorTimeKeeperGuard();
    }

    const self = this;
    this._coopSpawnApplied = false;
    this._coopSpawnOy = null;
    // Pose publish on engine tick only after seated (or spectator)
    if (typeof window !== "undefined") {
      window.__mpCoopFlushPendingDeltas = function () {
        const pending = self._pendingCoopSnakeDeltas;
        if (!pending || !self.coopNative) return;
        self._pendingCoopSnakeDeltas = Object.create(null);
        const ids = Object.keys(pending);
        for (let i = 0; i < ids.length; i++) {
          try {
            self.coopNative.applySnakeDelta(pending[ids[i]]);
          } catch (e) {
            console.warn("__mpCoopFlushPendingDeltas", e);
          }
        }
      };
      window.__mpCoopAfterTick = function () {
        if (opts.spectator) return;
        if (!self._coopSeatedPublish && !self._coopSpawnApplied) {
          // Still re-asserting spawn — don't flood center poses
          self._reassertCoopSpawnIfNeeded();
          return;
        }
        self._reassertCoopSpawnIfNeeded();
        self.publishCoopState();
      };
      window.__mpCoopOnFriendlyDeath = function (bodySnap) {
        if (!bodySnap || !bodySnap.length) return;
        self._coopLastBody = bodySnap;
        if (self.coopNative && self.client) {
          const id = self.client.clientId;
          if (id) {
            self.coopNative.applySnakeDelta({
              clientId: id,
              body: bodySnap,
              alive: false,
            });
          }
        }
      };
    }
    // Seat when run is live; re-assert until body matches oy (native may clobber)
    let tries = 0;
    function trySpawnLoop() {
      if (opts.spectator) {
        self.applyCoopSpawnOrPark(true);
        self.seedCoopRemotesFromSlots();
        return;
      }
      const live = Gsm.isNativeRunLive ? Gsm.isNativeRunLive() : false;
      const g = Gsm.gameInstance && Gsm.gameInstance();
      if (live && g && g.oa) {
        self.applyCoopSpawnOrPark(false);
        self.seedCoopRemotesFromSlots();
        if (self._bodyMatchesSpawnOy()) {
          self._coopSpawnApplied = true;
          self._coopSeatedPublish = true;
          self.publishCoopState({ forceColors: true });
          return;
        }
      }
      tries++;
      if (tries < 40) setTimeout(trySpawnLoop, 40);
      else {
        // Give up waiting — publish whatever we have so peers see something
        self._coopSeatedPublish = true;
        self.seedCoopRemotesFromSlots();
        if (!opts.spectator) self.publishCoopState({ forceColors: true });
      }
    }
    setTimeout(trySpawnLoop, 20);
  };

  MultiplayerApp.prototype._myCoopSpawnOy = function () {
    if (this._coopSpawnOy != null) return this._coopSpawnOy;
    const myId = this.client && this.client.clientId;
    const slots = this._coopSlots || [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].clientId === myId) {
        this._coopSpawnOy = slots[i].oy != null ? Number(slots[i].oy) : 0;
        return this._coopSpawnOy;
      }
    }
    this._coopSpawnOy = 0;
    return 0;
  };

  MultiplayerApp.prototype._bodyMatchesSpawnOy = function () {
    const g = Gsm.gameInstance && Gsm.gameInstance();
    const body = g && g.oa && g.oa.ka;
    if (!body || !body.length) return false;
    // Player already moved — stop reasserting
    const dir = g.oa.direction || g.oa.dir;
    if (dir && this._coopPlayerMoved) return true;
    const expected = this._coopSpawnBody(this._myCoopSpawnOy());
    const head = body[0];
    return (
      head &&
      expected[0] &&
      Number(head.x) === expected[0].x &&
      Number(head.y) === expected[0].y
    );
  };

  MultiplayerApp.prototype._reassertCoopSpawnIfNeeded = function () {
    if (this._coopSpawnApplied) return;
    if (typeof window !== "undefined" && window.__mpCoopSpectator) return;
    const g = Gsm.gameInstance && Gsm.gameInstance();
    if (!g || !g.oa) return;
    const dir = g.oa.direction || g.oa.dir;
    if (dir) {
      // Native assigned a facing → player/input engaged; lock seat
      this._coopPlayerMoved = true;
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      return;
    }
    if (!this._bodyMatchesSpawnOy()) {
      const oy = this._myCoopSpawnOy();
      if (Gsm.applyCoopSpawnOffset) Gsm.applyCoopSpawnOffset(oy);
    } else {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
    }
  };

  /**
   * Build a length-3 idle body at board center + oy (matches applyCoopSpawnOffset).
   */
  MultiplayerApp.prototype._coopSpawnBody = function (oy, width, height) {
    const w = width || 17;
    const h = height || 15;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2) + (Number(oy) || 0);
    return [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];
  };

  /**
   * Put every co-op player into __mpCoopRemotes at their SESSION_START slot with
   * roster colors — so each client sees all snakes natively from frame 1.
   */
  MultiplayerApp.prototype.seedCoopRemotesFromSlots = function () {
    if (!this.coopNative || !this.client) return;
    const slots = this._coopSlots || [];
    if (!slots.length) return;
    const roster = this.client.roster || {};
    const clients = roster.clients || [];
    const g = Gsm.gameInstance && Gsm.gameInstance();
    let w = 17;
    let h = 15;
    try {
      const meta =
        (g && g.wa && g.wa.oa && g.wa.oa.oa) ||
        (g && g.oa && g.oa.oa) ||
        {};
      if (meta.width) w = meta.width;
      if (meta.height) h = meta.height;
    } catch (e) { /* defaults */ }

    const Colors = root.MultiplayerColors;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || !slot.clientId) continue;
      // Don't overwrite a fresher live delta we already have
      const existing = this.coopNative.remotes[slot.clientId];
      if (existing && existing.body && existing.body.length && existing._fromDelta) {
        continue;
      }
      const peer = clients.find(function (c) {
        return c.clientId === slot.clientId;
      });
      const colorId =
        peer && peer.colorId != null
          ? peer.colorId
          : existing && existing.colorId != null
            ? existing.colorId
            : null;
      let color1 = null;
      let color2 = null;
      let Sc = null;
      let Yc = null;
      if (Colors && Colors.getColor && colorId != null) {
        const c = Colors.getColor(colorId);
        if (c) {
          if (c.kind === "rainbow" && c.set && c.set.length) {
            Sc = c.set[0];
            Yc = c.set[1] || c.set[0];
          } else if (c.primary) {
            Sc = c.primary;
            Yc = c.secondary || c.primary;
          }
          color1 = Yc;
          color2 = Sc;
        }
      }
      const body = this._coopSpawnBody(slot.oy, w, h);
      this.coopNative.applySnakeDelta({
        clientId: slot.clientId,
        body: body,
        dir: null,
        width: w,
        height: h,
        alive: true,
        colorId: colorId,
        color1: color1,
        color2: color2,
        Sc: Sc,
        Yc: Yc,
        _seeded: true,
      });
    }
    this.coopNative.syncBridge();
  };

  MultiplayerApp.prototype.applyCoopSpawnOrPark = function (spectator) {
    if (spectator) {
      // Empty body so native local draw is a no-op; companions show all players
      if (Gsm.emptyLocalSnakeBody) Gsm.emptyLocalSnakeBody();
      else if (Gsm.parkLocalSnakeOffBoard) Gsm.parkLocalSnakeOffBoard();
      if (typeof window !== "undefined") {
        window.__mpCoopSpectator = true;
        window.__mpCoopLocalDead = true;
      }
      if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      return;
    }
    const oy = this._myCoopSpawnOy();
    if (Gsm.applyCoopSpawnOffset) Gsm.applyCoopSpawnOffset(oy);
    // Do not lock _coopSpawnApplied yet — beginCoopNativeSession reasserts until match
  };

  MultiplayerApp.prototype.endCoopNativeSession = function () {
    this._coopSessionActive = false;
    this._coopDeadSent = false;
    this._coopSpawnApplied = false;
    this._coopSeatedPublish = false;
    this._coopSlots = [];
    this._coopLastPoseFp = null;
    this._coopColorsSent = false;
    this._coopSpawnOy = null;
    this._coopPlayerMoved = false;
    this._coopTimerStartedAtMs = null;
    this._coopTimerArmed = false;
    if (typeof window !== "undefined") {
      window.__mpCoopLocalDead = false;
      window.__mpCoopInject = false;
      window.__mpCoopSession = false;
      window.__mpCoopSpectator = false;
      window.__mpCoopAfterTick = null;
      window.__mpCoopFlushPendingDeltas = null;
      window.__mpCoopOnFriendlyDeath = null;
      window.__mpCoopPlayerRenderer = null;
      window.__mpCoopRenderArgs = null;
      if (window.__mpCoopStopCorpsePaint) window.__mpCoopStopCorpsePaint();
    }
    this._pendingCoopSnakeDeltas = null;
    this.stopCoopNativeLoop();
    if (this._coopSyncTimer) {
      clearInterval(this._coopSyncTimer);
      this._coopSyncTimer = null;
    }
    if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
    if (this.coopNative) this.coopNative.reset();
  };

  /** @deprecated Pose publish is tick-driven via __mpCoopAfterTick. */
  MultiplayerApp.prototype.startCoopSyncTimer = function () {
    if (this._coopSyncTimer) {
      clearInterval(this._coopSyncTimer);
      this._coopSyncTimer = null;
    }
  };

  MultiplayerApp.prototype.publishCoopState = function (opts) {
    opts = opts || {};
    if (!this.client || !this.client.connected) return;
    if (!this._coopSessionActive) return;
    if (!this.client.roster || !this.client.roster.sessionActive) return;
    if (!this.client.roster || this.client.roster.mode !== "coop") return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;

    const needColors = opts.forceColors || !this._coopColorsSent;
    const scrape =
      Gsm.scrapeCoopSnakeDelta || Gsm.scrapeSnakeDelta;
    const delta = scrape
      ? scrape.call(Gsm, me.colorId, { includeColors: needColors })
      : null;
    if (!delta) return;

    delta.clientId = this.client.clientId;
    delta._fromDelta = true;
    if (this._coopDeadSent && this._coopLastBody) {
      delta.alive = false;
      delta.body = this._coopLastBody;
    }
    if (me.colorId != null && needColors) delta.colorId = me.colorId;

    const fp = Gsm.snakeDeltaFingerprint
      ? Gsm.snakeDeltaFingerprint(delta)
      : null;
    if (fp && fp === this._coopLastPoseFp && !this._coopDeadSent && !needColors) {
      return;
    }
    this._coopLastPoseFp = fp;
    if (needColors && (delta.Sc || delta.colorId != null)) {
      this._coopColorsSent = true;
    }

    // First real move after seat → arm shared timer for everyone
    if (!this._coopTimerArmed && this._coopLocalHasMoved(delta)) {
      const t = Date.now();
      this.armCoopRunTimer(t);
      delta.timerArm = true;
      delta.timerStartedAtMs = t;
    }

    // Do not apply self into remotes — paint skips myId; saves O(n) followBody/GC
    this.client.snakeDelta(delta);
    if (delta.alive === false && !this._coopDeadSent) {
      this._coopDeadSent = true;
      this._coopLastBody = delta.body;
      this.client.coopPlayerDead({ body: delta.body });
      if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
    }
  };

  /** Head left spawn (or seat already marked moved) → player is playing. */
  MultiplayerApp.prototype._coopLocalHasMoved = function (delta) {
    if (this._coopPlayerMoved) return true;
    const body = delta && delta.body;
    const head = body && body[0];
    if (!head) return false;
    const expected = this._coopSpawnBody(this._myCoopSpawnOy());
    if (!expected || !expected[0]) return false;
    return (
      Number(head.x) !== Number(expected[0].x) ||
      Number(head.y) !== Number(expected[0].y)
    );
  };

  /** Idempotent: start native TimeKeeper from shared wall-clock epoch. */
  MultiplayerApp.prototype.armCoopRunTimer = function (startedAtMs) {
    if (this._coopTimerArmed) return;
    if (typeof window !== "undefined" && window.__mpCoopSpectator) return;
    const me = this.client && this.client.me && this.client.me();
    if (me && me.role === "spectator") return;
    const t =
      startedAtMs != null && Number.isFinite(Number(startedAtMs))
        ? Number(startedAtMs)
        : Date.now();
    this._coopTimerArmed = true;
    this._coopTimerStartedAtMs = t;
    if (Gsm.startCoopRunTimer) {
      Gsm.startCoopRunTimer({
        timerStartedAtMs: t,
        maxAttempts: 40,
        intervalMs: 50,
      });
    }
  };

  /** Eater publishes full native fruit board after collect (shared spawn rules). */
  MultiplayerApp.prototype.publishCoopCollectables = function () {
    if (!this.client || !this.client.connected) return;
    if (!this._coopSessionActive) return;
    if (!this.client.roster || !this.client.roster.sessionActive) return;
    if (!this.client.roster || this.client.roster.mode !== "coop") return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;
    if (!Gsm.scrapeCollectables) return;
    const cols = Gsm.scrapeCollectables();
    if (!cols) return;
    if (this.coopNative) this.coopNative.applyCollectables(cols);
    this.client.collectablesDelta(cols);
  };

  /**
   * Retired — companions paint from __mpCoopOnTick; no syncBridge rAF spam.
   */
  MultiplayerApp.prototype.startCoopNativeLoop = function () {
    this.stopCoopNativeLoop();
  };

  MultiplayerApp.prototype.stopCoopNativeLoop = function () {
    if (this._coopPaintRaf) {
      cancelAnimationFrame(this._coopPaintRaf);
      this._coopPaintRaf = 0;
    }
    if (this.coopNative) this.coopNative.stopOverlay();
  };

  /** Soft collision retired — remotes collide inside __mpCoopOnTick. */
  MultiplayerApp.prototype.maybeCoopCrossCollision = function () {
    // no-op (true inject)
  };

  MultiplayerApp.prototype.hookLocalScorePulse = function () {
    const self = this;
    if (VersusTimeKeeper && VersusTimeKeeper.install) {
      VersusTimeKeeper.install();
    }
    Gsm.wrapTimeKeeper({
      onApple: function (timeMs, score) {
        self._pulseScore(score, timeMs, true);
        if (
          self._coopSessionActive &&
          self.client &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          const me = self.client.me();
          if (me && me.role === "player") {
            // Native eat+respawn already ran; broadcast full board to peers
            if (typeof window !== "undefined") {
              window.__mpCoopSkipFruitReapply = true;
            }
            setTimeout(function () {
              self.publishCoopCollectables();
              setTimeout(function () {
                if (typeof window !== "undefined") {
                  window.__mpCoopSkipFruitReapply = false;
                }
              }, 50);
            }, 0);
          }
        }
      },
      onDeath: function (timeMs, score) {
        // Versus Focus puppet: ignore local false deaths; only mirror remote death
        if (
          typeof window !== "undefined" &&
          window.__mpVersusFocusSpectate
        ) {
          const fb = window.__mpVersusFocusBoard;
          if (!fb || fb.alive !== false) {
            if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          }
          return;
        }
        // Co-op spectator: never treat as a real player death
        if (
          typeof window !== "undefined" &&
          window.__mpCoopSpectator
        ) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          if (Gsm.emptyLocalSnakeBody) Gsm.emptyLocalSnakeBody();
          return;
        }
        self._pulseScore(score, timeMs, false);
        self._maybePromotePb(timeMs, score);
        if (
          self._coopSessionActive &&
          self.client &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          const me = self.client.me();
          if (me && me.role === "player" && !self._coopDeadSent) {
            self._coopDeadSent = true;
            if (typeof window !== "undefined") window.__mpCoopLocalDead = true;
            const board = Gsm.scrapeBoard && Gsm.scrapeBoard();
            const scraped = board && board.body;
            self._coopLastBody =
              (self._coopLastBody && self._coopLastBody.length
                ? self._coopLastBody
                : null) ||
              (scraped && scraped.length ? scraped : null);
            self.client.coopPlayerDead({ body: self._coopLastBody });
            const delta = Gsm.scrapeCoopSnakeDelta
              ? Gsm.scrapeCoopSnakeDelta(me.colorId)
              : Gsm.scrapeSnakeDelta
                ? Gsm.scrapeSnakeDelta(me.colorId)
                : null;
            if (delta) {
              delta.alive = false;
              if (self._coopLastBody) delta.body = self._coopLastBody;
              self.client.snakeDelta(delta);
            }
            if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          }
          return;
        }
        // Versus: skip the death screen — instantly start another run
        self.restartVersusAfterDeath();
      },
      onAll: function (timeMs, score) {
        // Versus Focus puppet: keep watching; no PB from spectate
        if (
          typeof window !== "undefined" &&
          window.__mpVersusFocusSpectate
        ) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          return;
        }
        if (
          typeof window !== "undefined" &&
          window.__mpCoopSpectator
        ) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          return;
        }
        // Count/track first (Best All + scoreboard), then restart versus
        self._pulseScore(score, timeMs, false, { goalAll: true });
        self._maybePromotePb(timeMs, score);
        if (
          self._coopSessionActive &&
          self.client &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          if (Gsm.stopCoopRunTimer) Gsm.stopCoopRunTimer();
          const me = self.client.me();
          if (me && me.role === "player" && self.client.coopGoal) {
            self.client.coopGoal({ score: score, timeMs: timeMs });
          }
          return;
        }
        // Versus: after ALL apples are scored, instantly start another run
        self.restartVersusAfterDeath();
      },
    });

    if (this._scoreTimer) clearInterval(this._scoreTimer);
    this._scoreTimer = setInterval(function () {
      if (!self.client || !self.client.connected) return;
      const me = self.client.me();
      if (!me || me.role !== "player") return;
      if (!self.client.roster || self.client.roster.mode !== "versus") return;
      const s = Gsm.readScoreAndAlive();
      self.client.scorePulse({
        score: s.score,
        timeMs: s.timeMs != null && Number.isFinite(s.timeMs) ? s.timeMs : 0,
        alive: s.alive,
      });
    }, 800);
  };

  MultiplayerApp.prototype._pulseScore = function (score, timeMs, alive, extra) {
    if (!this.client || !this.client.connected) return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;
    if (!this.client.roster || this.client.roster.mode !== "versus") return;
    const payload = {
      score: score,
      timeMs: timeMs,
      alive: alive !== false,
    };
    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach(function (k) {
        payload[k] = extra[k];
      });
    }
    const goal =
      (this.versus && this.versus.versusGoal) ||
      (this.client.roster && this.client.roster.versusGoal) ||
      "score";
    const VersusState = root.VersusState;
    if (VersusState && VersusState.isTimedGoal && VersusState.isTimedGoal(goal)) {
      const meta = VersusState.goalMeta(goal);
      if (meta.all && extra && extra.goalAll) {
        payload.goalAll = true;
      } else if (meta.threshold != null && Number(score) >= meta.threshold) {
        // Server treats score >= threshold as a timed-goal hit
      }
    }
    this.client.scorePulse(payload);
  };

  /**
   * Versus only: after a death or ALL-apples clear, immediately start another
   * native run so players never sit on the endscreen (Play is locked while connected).
   * Score/goal tracking must already have been pulsed before calling this.
   * Skips when the attempt timer expired / allowNewRuns is false.
   */
  MultiplayerApp.prototype.canAutoRestartVersus = function () {
    if (!this.client || !this.client.connected) return false;
    const roster = this.client.roster;
    if (!roster || roster.mode !== "versus") return false;
    if (!roster.sessionActive) return false;
    if (roster.allowNewRuns === false) return false;
    if (roster.attemptExpired === true) return false;
    if (this.versus && this.versus.expired) return false;
    const me = this.client.me && this.client.me();
    if (!me || me.role !== "player") return false;
    if (typeof window !== "undefined") {
      if (window.__mpVersusFocusSpectate) return false;
      if (window.__mpCoopSession || window.__mpCoopSpectator) return false;
    }
    return true;
  };

  MultiplayerApp.prototype.restartVersusAfterDeath = function () {
    if (!this.canAutoRestartVersus()) return false;
    if (this._versusRestartPending) return false;
    this._versusRestartPending = true;
    // Hide endscreen immediately so death never "sticks" visually
    if (Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
    else if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
    const self = this;
    // Next macrotask so TimeKeeper death handlers finish before Play
    setTimeout(function () {
      self._versusRestartPending = false;
      if (!self.canAutoRestartVersus()) return;
      if (Gsm.startNativeRun) {
        Gsm.startNativeRun({
          maxAttempts: 40,
          intervalMs: 25,
        });
      } else if (Gsm.triggerPlay) {
        if (Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
        if (Gsm.prepareNativePlay) Gsm.prepareNativePlay();
        Gsm.triggerPlay();
      }
    }, 0);
    return true;
  };

  MultiplayerApp.prototype._maybePromotePb = function (timeMs, score) {
    try {
      // Only promote after a real versus player run wrote session storage
      if (!VersusTimeKeeper || !VersusTimeKeeper.isActive()) return;
      if (
        typeof window !== "undefined" &&
        (window.__mpVersusFocusSpectate || window.__mpCoopSpectator)
      ) {
        return;
      }
      VersusTimeKeeper.promoteSessionToRemix();
    } catch (e) {
      console.warn("PB promote", e);
    }
  };

  MultiplayerApp.prototype.hookBoardUpload = function () {
    const self = this;
    if (this._boardTimer) clearInterval(this._boardTimer);
    this._boardTimer = setInterval(function () {
      if (!self.client || !self.client.connected) return;
      const me = self.client.me();
      if (!me || me.role !== "player") return;
      if (!self.client.roster || self.client.roster.mode !== "versus") return;
      if (!self.client.roster.sessionActive) return;
      const specs = (self.client.roster.clients || []).filter(function (c) {
        return c.role === "spectator";
      });
      if (!specs.length) return;
      const board = Gsm.scrapeBoard({
        colorId: me.colorId != null ? me.colorId : undefined,
      });
      if (board) self.client.boardDelta(board);
    }, 80);
  };

  MultiplayerApp.prototype.hookCoopInput = function () {
    const self = this;
    window.addEventListener(
      "keydown",
      function (ev) {
        if (!self.client || !self.client.connected) return;
        const mode =
          self.client.roster && self.client.roster.mode;
        const me = self.client.me();
        // Block movement only while a match is running — lobby spectators
        // must still use Escape / menus freely.
        const sessionOn = !!(self.client.roster && self.client.roster.sessionActive);
        const block =
          sessionOn &&
          ((mode === "coop" && me && me.role !== "player") ||
            (mode === "versus" &&
              me &&
              me.role === "spectator" &&
              self.versus &&
              self.versus.spectateMode !== "mosaic"));
        if (!block) return;
        if (
          typeof window !== "undefined" &&
          window.__mpAllowSpectateKeyDismiss
        ) {
          return;
        }
        const k = ev.key;
        if (
          k === "ArrowUp" ||
          k === "ArrowDown" ||
          k === "ArrowLeft" ||
          k === "ArrowRight" ||
          k === "w" ||
          k === "a" ||
          k === "s" ||
          k === "d" ||
          k === "W" ||
          k === "A" ||
          k === "S" ||
          k === "D"
        ) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );
  };

  /**
   * Escape mid-match: admin aborts the room session + death screen.
   * Clients keep Escape for their own local death screen (cosmetics) —
   * it does not end the multiplayer match for others.
   */
  MultiplayerApp.prototype.hookEscapeForAdmin = function () {
    const self = this;
    if (this._escHooked) return;
    this._escHooked = true;
    document.addEventListener(
      "keydown",
      function (ev) {
        if (ev.key !== "Escape" && ev.code !== "Escape" && ev.keyCode !== 27) {
          return;
        }
        if (root.__mpEscHandling) return;
        if (!self.client || !self.client.connected) return;
        const t = ev.target;
        if (
          t &&
          (t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT" ||
            t.isContentEditable)
        ) {
          return;
        }

        if (!self.client.isAdmin()) {
          // Let native Escape end the local run so apple/theme/graphics/color
          // menus are reachable. Do not abort the room.
          // Versus focus: peek death/settings without ending spectate.
          if (
            self._versusFocusSpectate ||
            (self._isVersusSpectator && self._isVersusSpectator())
          ) {
            if (typeof window !== "undefined") {
              window.__mpSpectateAllowMenus = true;
            }
            if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
            if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
            if (Gsm.showDeathScreen) {
              Gsm.showDeathScreen({
                skipEscapeDispatch: true,
                keepRunning: true,
              });
            }
          }
          return;
        }

        ev.preventDefault();
        ev.stopImmediatePropagation();
        self.abortMatchAsAdmin("escape");
      },
      true
    );
  };

  /** Tear down local overlays and show death/settings screen. */
  MultiplayerApp.prototype.returnToMenus = function (opts) {
    opts = opts || {};
    this._versusRestartPending = false;
    if (typeof window !== "undefined") {
      window.__mpStartingMatch = false;
    }
    this.endCoopNativeSession();
    if (this.client && this.client.roster && this.client.roster.mode === "coop") {
      if (CoopTK && CoopTK.save) {
        const s = Gsm.readScoreAndAlive && Gsm.readScoreAndAlive();
        CoopTK.save("last", s && s.timeMs, s && s.score);
      }
    }
    this.setCoopAuthorityMode(false);
    if (this._focusCanvas) this._focusCanvas.style.display = "none";
    if (this._mosaicEl) this._mosaicEl.style.display = "none";
    if (Gsm.showDeathScreen) {
      Gsm.showDeathScreen({ skipEscapeDispatch: true });
    } else {
      root.pauseGame = 1;
    }
    this.applyControlLocks();
  };

  MultiplayerApp.prototype.abortMatchAsAdmin = function (reason) {
    if (!this.client || !this.client.isAdmin()) return;
    if (root.__mpEscHandling) return;
    root.__mpEscHandling = true;
    try {
      if (this.client.sessionEnd) this.client.sessionEnd(reason || "aborted");
      this.returnToMenus({ fromAdmin: true });
      // Nudge engine into quit state after our capture handler is done
      const self = this;
      setTimeout(function () {
        root.__mpEscHandling = false;
        if (Gsm.showDeathScreen) Gsm.showDeathScreen({});
        self.applyControlLocks();
      }, 0);
    } catch (e) {
      root.__mpEscHandling = false;
      throw e;
    }
  };

  MultiplayerApp.prototype.hookAdminSettingsWatch = function () {
    const self = this;
    if (this._adminSettingsWatchHooked) return;
    this._adminSettingsWatchHooked = true;

    function pushIfAdmin() {
      if (!self.client || !self.client.connected) return;
      if (root.__mpApplyingSettings || root.__mpApplyingColor) return;
      if (!self.client.isAdmin()) return;
      self.syncMySettingsAsAdmin();
    }

    // Document capture: rows may mount late; catch trophy/count/speed/size clicks
    document.addEventListener(
      "click",
      function (ev) {
        if (!self.client || !self.client.connected) return;
        if (root.__mpApplyingSettings || root.__mpApplyingColor) return;
        const t = ev.target;
        if (!t || !t.closest) return;
        // Cosmetics are always allowed for every seat
        if (t.closest("#color, #apple, #graphics, #theme")) return;
        const row = t.closest("#trophy, #count, #speed, #size");
        if (!row) return;
        if (!self.client.isAdmin()) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        setTimeout(pushIfAdmin, 50);
      },
      true
    );

    // Remix often changes modes via puddingMenuSelect — sync those too
    function wrapMenuSelect() {
      if (typeof root.puddingMenuSelect !== "function") return false;
      if (root.puddingMenuSelect.__mpSyncWrapped) return true;
      const orig = root.puddingMenuSelect;
      root.puddingMenuSelect = function (id, index) {
        const r = orig.apply(this, arguments);
        if (
          (id === "trophy" ||
            id === "count" ||
            id === "speed" ||
            id === "size") &&
          !root.__mpApplyingSettings &&
          !root.__mpApplyingColor &&
          self.client &&
          self.client.connected &&
          self.client.isAdmin()
        ) {
          setTimeout(pushIfAdmin, 50);
        }
        return r;
      };
      root.puddingMenuSelect.__mpSyncWrapped = true;
      return true;
    }
    if (!wrapMenuSelect()) {
      setTimeout(wrapMenuSelect, 300);
      setTimeout(wrapMenuSelect, 1000);
    }

    const play = Gsm.playButton();
    if (play) {
      play.addEventListener(
        "click",
        function (ev) {
          if (!self.client || !self.client.connected) return;
          // Allow Start-match-driven programmatic clicks through
          if (root.__mpAllowPlayClick) return;
          // Manual Play while connected is blocked — use Start match
          ev.preventDefault();
          ev.stopPropagation();
        },
        true
      );
    }
  };

  /** Spectators cannot steer the local game while watching Versus. */
  MultiplayerApp.prototype.hookSpectatorInputBlock = function () {
    const self = this;
    if (this._specInputHooked) return;
    this._specInputHooked = true;
    window.addEventListener(
      "keydown",
      function (ev) {
        if (!self._isVersusSpectator || !self._isVersusSpectator()) return;
        // Focus spectate paints the native canvas — swallow game controls
        const k = ev.key;
        if (
          k === "ArrowUp" ||
          k === "ArrowDown" ||
          k === "ArrowLeft" ||
          k === "ArrowRight" ||
          k === "w" ||
          k === "a" ||
          k === "s" ||
          k === "d" ||
          k === "W" ||
          k === "A" ||
          k === "S" ||
          k === "D"
        ) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );
  };

  /**
   * Speed Info header: add "Settings" left of "Details" so spectators can open
   * Pudding/Multiplayer controls without the native gear (blocked mid-run).
   */
  function ensureSpeedInfoSettingsButton(app) {
    const details = document.getElementById("time-keeper");
    if (!details || !details.parentElement) return false;
    const headerRow = details.parentElement;
    // Hide Remix's "Speed Info" title — header is just Settings + Details
    Array.from(headerRow.children || []).forEach(function (el) {
      if (
        el &&
        el.tagName === "SPAN" &&
        /speed\s*info/i.test((el.textContent || "").trim())
      ) {
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
      }
    });
    let btn = document.getElementById("mp-speedinfo-settings");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "mp-speedinfo-settings";
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = "Settings";
      btn.style.cssText =
        details.style.cssText ||
        "margin:0;padding:2px 8px;font-size:12px;line-height:1.2;color:white;background-color:#1155CC;font-family:Roboto,Arial,sans-serif;";
      let group = headerRow.querySelector(".mp-si-btn-group");
      if (!group) {
        group = document.createElement("div");
        group.className = "mp-si-btn-group";
        group.style.cssText =
          "display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:auto;";
        headerRow.insertBefore(group, details);
        group.appendChild(details);
      }
      group.insertBefore(btn, details);
    } else {
      btn.textContent = "Settings";
      if (btn.nextElementSibling !== details) {
        details.parentElement.insertBefore(btn, details);
      }
    }
    if (!btn.__mpWired) {
      btn.__mpWired = true;
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (app && app.ui && app.ui.openPuddingSettings) {
          app.ui.openPuddingSettings();
        } else if (typeof root.BootstrapShow === "function") {
          root.BootstrapShow();
        }
      });
    }
    return true;
  }

  /**
   * Remix gates SpeedInfo to Chess/Burger and otherwise shows "Switch to PuddingMod".
   * Multiplayer already bundles Pudding+Remix, so unlock full SpeedInfo here.
   */
  function unlockSpeedInfoForMultiplayer() {
    // Never prompt to leave Multiplayer for Pudding
    root.remixSpeedInfoShowSwitchMessage = function () {
      const modeLabel = document.getElementById("mode-selected");
      if (modeLabel) modeLabel.innerHTML = "";
      const modeLabel2 = document.getElementById("mode-selected2");
      if (modeLabel2) modeLabel2.innerHTML = "";
    };

    function bypassRemixSpeedInfoGates(fn) {
      if (typeof fn !== "function" || fn.__mpUngated) return fn;
      const wrapped = async function () {
        const prevActive = root.remixChessBurgerTimeKeeperActive;
        const prevOfficial = root.remixTimeKeeperOfficialSettings;
        root.remixChessBurgerTimeKeeperActive = function () {
          return true;
        };
        root.remixTimeKeeperOfficialSettings = function () {
          return true;
        };
        try {
          return await fn.apply(this, arguments);
        } finally {
          root.remixChessBurgerTimeKeeperActive = prevActive;
          root.remixTimeKeeperOfficialSettings = prevOfficial;
        }
      };
      wrapped.__mpUngated = true;
      wrapped.__remixGated = !!fn.__remixGated;
      return wrapped;
    }

    if (typeof root.SpeedInfoUpdate === "function") {
      root.SpeedInfoUpdate = bypassRemixSpeedInfoGates(root.SpeedInfoUpdate);
    }
    if (typeof root.getAllSrc === "function") {
      root.getAllSrc = bypassRemixSpeedInfoGates(root.getAllSrc);
    }
    if (typeof root.getRecordSRC === "function") {
      root.getRecordSRC = bypassRemixSpeedInfoGates(root.getRecordSRC);
    }

    // Break getAllSrc → SpeedInfoUpdate → (accidental) getAllSrc feedback:
    // skip no-op personal refreshes when category fingerprint is unchanged.
    if (typeof root.SpeedInfoUpdate === "function" && !root.SpeedInfoUpdate.__mpDeduped) {
      const gated = root.SpeedInfoUpdate;
      root.SpeedInfoUpdate = async function mpSpeedInfoUpdateDeduped() {
        let fp = "";
        try {
          const tk = root.timeKeeper;
          if (tk && typeof tk.getCurrentSetting === "function") {
            fp = [
              typeof tk.getCurrentMode === "function" ? tk.getCurrentMode() : "",
              tk.getCurrentSetting("count"),
              tk.getCurrentSetting("speed"),
              tk.getCurrentSetting("size"),
            ].join("|");
          }
        } catch (e) { /* ignore */ }
        if (
          fp &&
          fp === root.__mpSpeedInfoFp &&
          root.__mpSpeedInfoQuietUntil &&
          Date.now() < root.__mpSpeedInfoQuietUntil
        ) {
          return;
        }
        root.__mpSpeedInfoFp = fp;
        root.__mpSpeedInfoQuietUntil = Date.now() + 750;
        return gated.apply(this, arguments);
      };
      root.SpeedInfoUpdate.__mpDeduped = true;
      root.SpeedInfoUpdate.__mpUngated = true;
      root.SpeedInfoUpdate.__remixGated = !!gated.__remixGated;
    }

    if (root.isSnakeMobileVersion) return;
    if (root.__mpSpeedInfoCheckboxReady) return;
    if (typeof root.remixSpeedInfoEnableCheckbox === "function") {
      root.remixSpeedInfoEnableCheckbox();
      root.__mpSpeedInfoCheckboxReady = true;
      return;
    }
    const cb = document.getElementById("AlwaysOnTimeKeeper");
    if (cb) {
      cb.disabled = false;
      root.__mpSpeedInfoCheckboxReady = true;
    }
  }

  // --- Mod Loader API ---
  const app = new MultiplayerApp();
  root.__multiplayerApp = app;

  root.MultiplayerMod = {
    runCodeBefore: function () {
      if (root.RemixMod && typeof root.RemixMod.runCodeBefore === "function") {
        root.RemixMod.runCodeBefore();
      }
    },
    alterSnakeCode: function (code) {
      if (root.RemixMod && typeof root.RemixMod.alterSnakeCode === "function") {
        code = root.RemixMod.alterSnakeCode(code);
      }
      code = Gsm.alterSnakeCodeExposeGame(code);
      return code;
    },
    runCodeAfter: function () {
      if (root.RemixMod && typeof root.RemixMod.runCodeAfter === "function") {
        root.RemixMod.runCodeAfter();
      }
      try {
        unlockSpeedInfoForMultiplayer();
        setTimeout(unlockSpeedInfoForMultiplayer, 0);
        setTimeout(unlockSpeedInfoForMultiplayer, 400);
        if (Gsm.installModeLabelPatch) {
          Gsm.installModeLabelPatch();
          setTimeout(function () {
            if (Gsm.installModeLabelPatch) Gsm.installModeLabelPatch();
          }, 500);
        }
        app.ui.mountSettingsTab();
        ensureSpeedInfoSettingsButton(app);
        setTimeout(function () {
          ensureSpeedInfoSettingsButton(app);
        }, 0);
        setTimeout(function () {
          ensureSpeedInfoSettingsButton(app);
        }, 500);
        app.ui.mountHud();
        app.hookLocalScorePulse();
        app.hookBoardUpload();
        app.hookCoopInput();
        app.hookEscapeForAdmin();
        app.hookAdminSettingsWatch();
        app.hookSpectatorInputBlock();
        app.hookInGameColorPicker();
        if (Gsm.installFirstRunControlTipGuard) {
          Gsm.installFirstRunControlTipGuard();
          setTimeout(function () {
            if (Gsm.installFirstRunControlTipGuard) {
              Gsm.installFirstRunControlTipGuard();
            }
          }, 400);
        }
        if (root.MultiplayerVisibilityFix) {
          root.MultiplayerVisibilityFix.fix();
          setTimeout(function () {
            root.MultiplayerVisibilityFix.fix();
          }, 0);
          setTimeout(function () {
            root.MultiplayerVisibilityFix.fix();
            app.ui.mountSettingsTab();
            ensureSpeedInfoSettingsButton(app);
          }, 500);
        }
        if (typeof root.remixOrganizeSettings === "function" && !root.__mpOrganizeHooked) {
          const origOrg = root.remixOrganizeSettings;
          root.remixOrganizeSettings = function () {
            const r = origOrg.apply(this, arguments);
            app.ui.mountSettingsTab();
            unlockSpeedInfoForMultiplayer();
            ensureSpeedInfoSettingsButton(app);
            if (
              root.MultiplayerVisibilityFix &&
              typeof root.MultiplayerVisibilityFix.install === "function"
            ) {
              root.MultiplayerVisibilityFix.install();
            } else if (
              root.MultiplayerVisibilityFix &&
              typeof root.MultiplayerVisibilityFix.fix === "function"
            ) {
              root.MultiplayerVisibilityFix.fix();
            }
            return r;
          };
          root.__mpOrganizeHooked = true;
        }
        if (typeof root.SpeedInfoSetup === "function" && !root.SpeedInfoSetup.__mpSettingsBtn) {
          const origSi = root.SpeedInfoSetup;
          root.SpeedInfoSetup = function () {
            const r = origSi.apply(this, arguments);
            ensureSpeedInfoSettingsButton(app);
            return r;
          };
          root.SpeedInfoSetup.__mpSettingsBtn = true;
        }
        const ind = claimModIndicator();
        app._statusEl = ind;
        app.updateStatusIndicator();
        // Counter may mount slightly after Remix; re-layout a few times
        setTimeout(layoutHudCounters, 0);
        setTimeout(layoutHudCounters, 250);
        setTimeout(layoutHudCounters, 1000);
        if (typeof window !== "undefined" && !window.__mpHudLayoutHooked) {
          window.__mpHudLayoutHooked = true;
          window.addEventListener("resize", layoutHudCounters);
        }
      } catch (e) {
        console.error("MultiplayerMod.runCodeAfter", e);
      }
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { MultiplayerApp: MultiplayerApp, MultiplayerMod: root.MultiplayerMod };
  }
})(typeof window !== "undefined" ? window : globalThis);
