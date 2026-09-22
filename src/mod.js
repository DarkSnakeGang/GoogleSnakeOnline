/** MultiplayerMod app controller + GSM loader hooks. */
(function (root) {
  const Client = root.MultiplayerClient;
  const RaceState = root.RaceState;
  const RaceTimeKeeper = root.RaceTimeKeeper;
  const CoopState = root.CoopState;
  const CoopNative = root.CoopNative;
  const CoopSessionController = root.CoopSessionController;
  const UI = root.MultiplayerUI;
  const P = root.MultiplayerProtocol;
  const Gsm = root.MultiplayerGsm;
  const Colors = root.MultiplayerColors;
  const Mp = root.MultiplayerRuntime;

  /** Idle board-sync poll — tighter than a tick so a waiting player keeps up. */
  const COOP_IDLE_SYNC_MS = 100;
  /** Keep in sync with Remix Mod's HUD label (Remix Mod vN). */
  const MULTIPLAYER_MOD_VERSION =
    (typeof root.__MP_MOD_VERSION === "string" && root.__MP_MOD_VERSION) ||
    "13";

  function MultiplayerApp() {
    this.client = null;
    this.race = new RaceState();
    this.coop = new CoopState();
    this.coopNative = new CoopNative();
    this.coopSession = CoopSessionController
      ? new CoopSessionController()
      : null;
    this.ui = new UI(this);
    this._boardTimer = null;
    this._scoreTimer = null;
    this._coopIdleSyncTimer = null;
    this._coopPaintRaf = 0;
    this._focusCanvas = null;
    this._mosaicEl = null;
    this._mosaicCells = {};
    this._coopPaused = false;
    this._nativeCanvasHidden = false;
    this._coopSessionActive = false;
    this._coopSessionGen = 0;
    this._coopAuthority = null;
    this._coopDeadSent = false;
    this._coopSlots = [];
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
      const fps = Number(
        typeof window !== "undefined" ? window.__mpCoopFps : NaN
      );
      if (Number.isFinite(fps) && fps > 0) {
        status += " " + Math.round(fps) + "fps";
      }
    }
    let type = "—";
    const mode =
      (this.client && this.client.roster && this.client.roster.mode) || null;
    if (mode === "coop") type = "Co-op Mode";
    else if (mode === "race") type = "Race Mode";
    else if (this._lastModeLabel && this._lastModeLabel !== "—") type = this._lastModeLabel;
    if (mode === "coop" || mode === "race") this._lastModeLabel = type;

    // Attempt clock lives in the Race side panel — not on this line
    this._statusEl.textContent =
      "Multiplayer Mod v" +
      MULTIPLAYER_MOD_VERSION +
      " - " +
      status +
      " - " +
      type;
    layoutHudCounters();
  };

  /**
   * Keep Pudding wall/stat counters at a fixed offset. Tracking the live mod
   * status width shoved them far right after connect ("Connected [Nms] …").
   */
  function layoutHudCounters() {
    const icon = document.getElementById("stat-icon");
    const num = document.getElementById("counter-num");
    if (!icon) return;

    const delta = 260;
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
    // Remix now uses #remix-mod-indicator ("Remix Mod v13")
    el = document.getElementById("remix-mod-indicator");
    if (el && el.parentElement && el.parentElement.classList.contains("EjCLSb")) {
      el.id = "mp-mod-indicator";
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
          /^Remix Mod v\d+/i.test(t) ||
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
    el.textContent =
      "Multiplayer Mod v" + MULTIPLAYER_MOD_VERSION + " - Disconnected - —";
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
      if (typeof window !== "undefined") {
        window.__mpSpectateSkipMatchMenus = false;
      }
      return;
    }
    const isAdmin = this.client.isAdmin();
    const roster = this.client.roster || {};
    if (typeof window !== "undefined") {
      // Focus inject must not overwrite admin trophy/count/speed/size
      window.__mpSpectateSkipMatchMenus = !!isAdmin;
      window.__mpAttemptExpired = !!(
        roster.attemptExpired ||
        roster.allowNewRuns === false ||
        (this.race && this.race.expired)
      );
    }
    // Never lock settings rows — Ready must not block trophy/count/theme/color.
    Gsm.setNativeMenusLocked(false);
    // Admin Play → Start Match / Start Co-op; everyone else stays locked out
    if (this._paintPlayAsStartMatch) this._paintPlayAsStartMatch();
    else if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(true);
    // Always re-assert cosmetics are clickable (survives Focus helper-hide / role flips)
    if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
    // Seated players (admin too): Shuffle → Ready
    if (this._paintShuffleAsReady) this._paintShuffleAsReady();
  };

  /**
   * Leaving spectator (promoted to player): drop Focus puppet, restore menus/death,
   * clear coop spectator flags so theme/color work again.
   */
  MultiplayerApp.prototype.clearSpectatorSeat = function () {
    this._leaveRaceFocusSpectate();
    if (Gsm.restoreControlHelper) Gsm.restoreControlHelper();
    if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
    if (Mp && Mp.clearSpectatorSeat) {
      Mp.clearSpectatorSeat({ keepCoopLocalDead: !!this._coopSessionActive });
    } else if (typeof window !== "undefined") {
      window.__mpRaceFocusWatch = false;
      window.__mpRaceFocusBoard = null;
      window.__mpCoopSpectator = false;
      if (!this._coopSessionActive) {
        window.__mpCoopLocalDead = false;
      }
    }
    if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
    this.hideNativeBoard(false);
    // After promote / leave spectate mid-lobby, ensure death/settings are usable
    const roster = this.client && this.client.roster;
    const expired =
      (roster && (roster.attemptExpired || roster.allowNewRuns === false)) ||
      (this.race && this.race.expired);
    const sessionOn = !!(roster && roster.sessionActive);
    if (expired || !sessionOn) {
      // Real quit — skipEscapeDispatch here used to leave settings dead
      if (this.ensureLobbyMatchMenusInteractive) {
        this._lobbyMenuPulseAt = 0;
        this.ensureLobbyMatchMenusInteractive({ force: true });
      } else if (Gsm.quitNativeRunForMenus) {
        Gsm.quitNativeRunForMenus({ pulse: true });
      } else if (Gsm.showDeathScreen) {
        Gsm.showDeathScreen({ skipEscapeDispatch: false });
      }
    }
    this.applyControlLocks();
  };

  MultiplayerApp.prototype.ensureAutoFocus = function () {
    if (!this.client || !this.client.roster) return;
    const me = this.client.me();
    if (!me || me.role !== "spectator") return;
    if (this.client.roster.mode !== "race") return;
    const players = (this.client.roster.clients || []).filter(function (c) {
      return c.role === "player";
    });
    if (!players.length) return;
    if (
      this.race.focusClientId &&
      players.some((p) => p.clientId === this.race.focusClientId)
    ) {
      return;
    }
    const id = players[0].clientId;
    this.race.setFocus(id);
    this.client.spectateFocus(id);
    if (!this.race.boards[id] && this.client.resync) {
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
      this._coopServerAuth = false;
      if (typeof window !== "undefined") {
        window.__mpCoopServerAuth = false;
      }
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
    this.race.setSpectateMode(mode);
    if (mode === "mosaic") this._ensureMosaicLabelTick();
    else this._stopMosaicLabelTick();
    this.renderSpectateViews();
    this.ui.updateHud(this);
  };

  /** Mosaic clocks follow live ticks×Fb from board/score pulses — refresh labels often. */
  MultiplayerApp.prototype._ensureMosaicLabelTick = function () {
    if (this._mosaicLabelTimer) return;
    const self = this;
    this._mosaicLabelTimer = setInterval(function () {
      if (!self.race || self.race.spectateMode !== "mosaic") return;
      if (!self.client || !self.client.roster || !self.client.roster.sessionActive) {
        return;
      }
      const me = self.client.me && self.client.me();
      if (!me || me.role !== "spectator") return;
      if (typeof self.renderMosaic === "function") {
        self.renderMosaic({ labelsOnly: true });
      }
    }, 50);
  };

  MultiplayerApp.prototype._stopMosaicLabelTick = function () {
    if (this._mosaicLabelTimer) {
      clearInterval(this._mosaicLabelTimer);
      this._mosaicLabelTimer = 0;
    }
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
    this.race.expired = false;

    this.client.on(P.TYPES.WELCOME, function (p) {
      self.coop.myClientId = p.clientId;
      const room = document.getElementById("mp-room-code");
      if (room) room.value = p.roomCode || "";
      self._log("WELCOME", p.roomCode);
      self.updateStatusIndicator();
      // After join, force a true engine quit so settings rows accept clicks
      setTimeout(function () {
        if (self.ensureLobbyMatchMenusInteractive) {
          self.ensureLobbyMatchMenusInteractive({ force: true });
        }
      }, 300);
    });
    this.client.on(P.TYPES.ROSTER, function (p) {
      if (self.coop && self.coop.resyncing) {
        self.commitCoopRelayResync();
      }
      self.race.syncFromRoster(p);
      // After ALL_DEAD / match end, ignore stale sessionActive:true on ROSTER.
      if (
        (self._coopMatchEndHandled || self._coopEndReason) &&
        self.client &&
        self.client.roster
      ) {
        self.client.roster.sessionActive = false;
      }
      self.ui.updateHud(self);
      // Prefer server-issued co-op seats from the roster (survives resync)
      if (p && p.mode === "coop" && Array.isArray(p.clients)) {
        const fromRoster = [];
        for (let i = 0; i < p.clients.length; i++) {
          const c = p.clients[i];
          if (!c || c.role !== "player" || c.coopSlot == null) continue;
          fromRoster.push({
            clientId: c.clientId,
            slot: Number(c.coopSlot) | 0,
            oy: null,
            playerNumber:
              c.playerNumber != null
                ? Number(c.playerNumber) | 0
                : (Number(c.coopSlot) | 0) + 1,
          });
        }
        fromRoster.sort(function (a, b) {
          return a.slot - b.slot;
        });
        if (
          fromRoster.length &&
          !(self._coopAuthority === "native-relay-v1" && self._coopSessionActive)
        ) {
          // Preserve absolute seats from SESSION_START — never wipe x/y/dir/dims
          const prev = self._coopSlots || [];
          for (let j = 0; j < fromRoster.length; j++) {
            const match = prev.find(function (s) {
              return s && s.clientId === fromRoster[j].clientId;
            });
            if (!match) continue;
            if (match.oy != null && fromRoster[j].oy == null) {
              fromRoster[j].oy = match.oy;
            }
            if (match.x != null) fromRoster[j].x = match.x;
            if (match.y != null) fromRoster[j].y = match.y;
            if (match.dir != null) fromRoster[j].dir = match.dir;
            if (match.boardWidth != null) {
              fromRoster[j].boardWidth = match.boardWidth;
            }
            if (match.boardHeight != null) {
              fromRoster[j].boardHeight = match.boardHeight;
            }
          }
          self._coopSlots = fromRoster;
          self._coopSpawnOy = null;
          // Late roster seats: try seating once if the match already started
          if (self._coopSessionActive && !self._coopSpawnApplied) {
            self.trySeatCoopOnce(!!(typeof window !== "undefined" && window.__mpCoopSpectator));
          }
        }
      }
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
      // Keep in-game #color row in sync with claimed Co-op color.
      // Only when the claimed id actually changes — Ready/unready roster
      // echoes must not re-select the color row (that looked like a recolor).
      if (p.mode === "coop" && me && me.role === "player" && me.colorId != null) {
        if (self._pendingColorId != null && Number(me.colorId) === Number(self._pendingColorId)) {
          self._pendingColorId = null;
        }
        const claimed = Number(me.colorId);
        if (self._lastAppliedColorId !== claimed) {
          const localIdx = Gsm.readSettingIndex("color");
          if (localIdx == null || Number(localIdx) !== claimed) {
            if (Gsm.applySnakeColor) Gsm.applySnakeColor(claimed);
          }
          self._lastAppliedColorId = claimed;
        }
      }
      // Re-render after ensureAutoFocus so roster marks the watched player
      if (self.ui.renderRoster) self.ui.renderRoster(p);
      self.renderSpectateViews();
      self.updateStatusIndicator();
    });
    this.client.on(P.TYPES.MODE_CHANGE, function (p) {
      self._log("MODE_CHANGE", p && p.mode);
      self.race.scores = {};
      self.race.boards = {};
      self.race.focusClientId = null;
      self.race.expired = false;
      self.race.attemptRemainingMs = null;
      self.race.leaderClientId = null;
      self.race.winnerClientId = null;
      self.coop.snapshot = null;
      self.endCoopNativeSession();
      self.setCoopAuthorityMode(false);
      if (RaceTimeKeeper) RaceTimeKeeper.endMode();
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
      // Admin: push current trophy/count/speed/size so co-op/race peers match
      if (self.client && self.client.isAdmin()) {
        setTimeout(function () {
          self.syncMySettingsAsAdmin();
        }, 40);
      }
    });
    this.client.on(P.TYPES.SCORE_PULSE, function (p) {
      self.race.onScorePulse(p);
      self.ui.updateHud(self);
      // Never wipe Spec/Play buttons for score ticks — update stats in place
      if (self.ui.updateRosterScores) self.ui.updateRosterScores();
      // Mosaic: refresh best/lead; run clock ticks on its own interval
      if (self.race && self.race.spectateMode === "mosaic") {
        self.renderMosaic({ labelsOnly: true });
      }
    });
    this.client.on(P.TYPES.ATTEMPT_TICK, function (p) {
      self.race.onAttemptTick(p);
      self.ui.updateHud(self);
      self.updateStatusIndicator();
    });
    this.client.on(P.TYPES.ATTEMPT_EXPIRED, function (p) {
      self._raceRestartPending = false;
      self.race.onExpired(p || {});
      self.race.attemptRemainingMs = 0;
      const finishOngoing = !!(p && p.finishOngoing);
      if (self.client && self.client.roster) {
        self.client.roster.attemptExpired = true;
        self.client.roster.allowNewRuns = false;
        self.client.roster.finishOngoingRuns = finishOngoing;
        if (!finishOngoing) {
          // Hard stop (or grace complete) — leave the live run chrome
          self.client.roster.sessionActive = false;
        }
      }
      if (typeof window !== "undefined") {
        window.__mpAttemptExpired = true;
        window.__mpSpectateAllowMenus = false;
      }
      if (finishOngoing) {
        // Soft expire: keep playing until die / ALL; no new runs
        const me = self.client && self.client.me && self.client.me();
        let stillRunning = false;
        if (me && me.role === "player" && Gsm.readScoreAndAlive) {
          const s = Gsm.readScoreAndAlive();
          stillRunning = s.alive !== false;
        }
        if (me && me.role === "spectator") stillRunning = true;
        self.ui.updateHud(self);
        if (self.ui.updateRosterScores) self.ui.updateRosterScores();
        if (self.ui.renderRoster && self.client && self.client.roster) {
          self.ui.renderRoster(self.client.roster);
        }
        self.updateStatusIndicator();
        self._log("ATTEMPT_EXPIRED", {
          finishOngoing: true,
          stillRunning: stillRunning,
        });
        if (stillRunning) return;
      }
      // Tear down Focus/mosaic + show death/settings
      self._leaveRaceFocusSpectate();
      if (self._mosaicEl) self._mosaicEl.style.display = "none";
      self.returnToMenus({ fromExpired: true });
      self.ui.updateHud(self);
      if (self.ui.updateRosterScores) self.ui.updateRosterScores();
      if (self.ui.renderRoster && self.client && self.client.roster) {
        self.ui.renderRoster(self.client.roster);
      }
      self.updateStatusIndicator();
      self._log("ATTEMPT_EXPIRED", p && p.winnerClientId);
    });
    this.client.on(P.TYPES.BOARD_DELTA, function (p) {
      self.race.onBoardDelta(p);
      self.ui.updateHud(self);
      self.renderSpectateViews();
    });
    this.client.on(P.TYPES.BOARD_SNAPSHOT, function (p) {
      self.race.onBoardSnapshot(p);
      self.renderSpectateViews();
    });
    this.client.on(P.TYPES.STATE_DELTA, function () {
      // Legacy server sim — ignored for native co-op
    });
    this.client.on(P.TYPES.STATE_SNAPSHOT, function () {
      // Legacy server sim — ignored for native co-op
    });
    this.client.on(P.TYPES.SNAKE_DELTA, function (p) {
      if (self._coopAuthority !== "native-relay-v1") return;
      if (!self.coopNative) return;
      if (!self.coop || !self.coop.acceptPose(p)) return;
      if (self.coop.resyncing) return;
      // A self-echo is the relay acknowledgement. Consume it before ignoring
      // local rendering so the repeated turn journal can be pruned.
      if (
        p &&
        p.clientId &&
        self.client &&
        p.clientId === self.client.clientId
      ) {
        if (self.coopSession && self.coopSession.ackTurns) {
          let highest = 0;
          const turns = Array.isArray(p.turns) ? p.turns : [];
          for (let i = 0; i < turns.length; i++) {
            highest = Math.max(highest, Number(turns[i].turnSeq) || 0);
          }
          self.coopSession.ackTurns(highest);
        }
        return;
      }
      if (!p || !p.clientId) return;
      // Keep roster color dots in sync with the color the peer is actually using
      if (
        p.colorId != null &&
        self.client.roster &&
        Array.isArray(self.client.roster.clients)
      ) {
        const peer = self.client.roster.clients.find(function (c) {
          return c && c.clientId === p.clientId;
        });
        if (peer && Number(peer.colorId) !== Number(p.colorId)) {
          peer.colorId = Number(p.colorId);
          if (Colors && Colors.colorName) {
            peer.colorName = Colors.colorName(peer.colorId);
          }
          if (self.ui) {
            if (self.ui.updateRosterColorDots) self.ui.updateRosterColorDots();
            else if (self.ui.renderRoster) self.ui.renderRoster(self.client.roster);
          }
        }
      }
      // Peer may arm the shared timer before pose coalesce
      if (p.timerArm || p.timerStartedAtMs != null) {
        self.armCoopRunTimer(p.timerStartedAtMs);
      }
      // During a live co-op session, coalesce latest pose per peer (apply on
      // tick) — but only while this engine actually ticks. An idle spawn or a
      // spectator never ticks, and queued poses there froze the shared board.
      // Authoritative death still applies immediately via COOP_PLAYER_DEAD.
      if (
        self._coopSessionActive &&
        typeof window !== "undefined" &&
        typeof window.__mpCoopFlushPendingDeltas === "function" &&
        self.coopTicksRunning()
      ) {
        if (!self._pendingCoopSnakeDeltas) {
          self._pendingCoopSnakeDeltas = Object.create(null);
        }
        self._pendingCoopSnakeDeltas[p.clientId] = p;
        return;
      }
      self.coopNative.applySnakeDelta(p);
      if (typeof self.refreshCoopScores === "function") self.refreshCoopScores();
    });
    this.client.on(P.TYPES.COLLECTABLES_DELTA, function (p) {
      if (self._coopAuthority === "server-sim-v1") return;
      if (self._coopAuthority !== "native-relay-v1") return;
      // Initial + runtime mid-match fruit (eater publishes; peers apply once)
      if (!p || !self.coop.applyBoard(p)) return;
      if (self.coop.resyncing) return;
      if (!self.coopNative) return;
      // Versioned board channel — peers apply only when rev advances
      if (self.coopSession && !self.coopSession.canApplyBoard(p)) {
        return;
      }
      // Dim mismatch used to drop the whole board (no fruit). Still apply —
      // in-bounds apples paint; owner/peer bake recovery can catch up later.
      if (
        p &&
        p.width != null &&
        p.height != null &&
        Gsm.gameInstance
      ) {
        try {
          const g = Gsm.gameInstance();
          const live =
            Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g);
          if (
            live &&
            live.width &&
            live.height &&
            ((p.width | 0) !== (live.width | 0) ||
              (p.height | 0) !== (live.height | 0))
          ) {
            console.warn(
              "[Multiplayer] COLLECTABLES dim mismatch payload",
              p.width,
              "x",
              p.height,
              "vs live",
              live.width,
              "x",
              live.height,
              "— applying anyway"
            );
          }
        } catch (eSz) { /* ignore */ }
      }
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
        if (self.coopSession) self.coopSession.noteBoardRev(p);
        if (Gsm.collectablesFingerprint) {
          self._coopColsFp = Gsm.collectablesFingerprint(p);
        }
        return;
      }
      self.coopNative.applyCollectables(p);
      if (Gsm.applyCollectables) {
        const fruitPayload = Object.assign({}, p);
        if (
          !fruitPayload.apples &&
          Array.isArray(fruitPayload.collectables)
        ) {
          fruitPayload.apples = fruitPayload.collectables;
        }
        // Exact shared board — no freePos top-up / no local nudge.
        // Do not force initial on every runtime delta (breaks seed/trust motion).
        fruitPayload.exactBoard = true;
        if (p.initial === true) {
          fruitPayload.initial = true;
          self._applyInitialCollectablesWithRetry(fruitPayload);
        } else {
          try {
            Gsm.applyCollectables(fruitPayload);
          } catch (eRt) { /* ignore */ }
        }
      }
      if (self.coopSession) self.coopSession.noteBoardRev(p);
      // Match local publish fingerprint so we don't echo the same board back
      if (Gsm.collectablesFingerprint) {
        self._coopColsFp = Gsm.collectablesFingerprint(p);
      }
      if (Array.isArray(p && p.walls)) {
        self._coopLastWalls = p.walls.map(function (w) {
          return w ? Object.assign({}, w) : w;
        });
        self._coopLastWallCount = p.walls.length;
      }
    });
    this.client.on(P.TYPES.COOP_STATE, function (p) {
      if (self._coopAuthority !== "server-sim-v1") return;
      self.onCoopState(p);
    });
    this.client.on(P.TYPES.COOP_PLAYER_DEAD, function (p) {
      if (
        self._coopAuthority === "native-relay-v1" &&
        !self.coop.stageDeath(p)
      ) return;
      if (self.coop.resyncing) return;
      if (!self.coopNative || !p) return;
      const id = p.clientId;
      if (!id) return;
      const myId = self.client && self.client.clientId;
      // Drop any coalesced live pose that would revive this peer on next tick.
      if (self._pendingCoopSnakeDeltas) {
        delete self._pendingCoopSnakeDeltas[id];
      }
      // Never seed remotes[myId] — local corpse is native; peers only.
      if (id !== myId) {
        let remote = self.coopNative.remotes[id];
        if (!remote) {
          remote = Object.create(null);
          remote.clientId = id;
          self.coopNative.remotes[id] = remote;
        }
        remote.alive = false;
        remote._deadSticky = true;
        if (p.body && p.body.length) {
          remote.body = p.body;
        }
        if (p.body2 && p.body2.length) {
          remote.body2 = p.body2;
        }
        self.coopNative.syncBridge();
      }
      // Write scores immediately so HUD shows "· down" even before the next scrape.
      if (!self._coopScores) self._coopScores = {};
      const prevScore =
        (self._coopScores[id] && self._coopScores[id].score) || 0;
      self._coopScores[id] = {
        score: prevScore | 0,
        alive: false,
      };
      if (typeof self.refreshCoopScores === "function") {
        self.refreshCoopScores();
      } else if (self.ui && self.ui.updateHud) {
        self.ui.updateHud(self);
      }
    });
    this.client.on(P.TYPES.COOP_TIMER_START, function (p) {
      if (
        self._coopAuthority === "native-relay-v1" &&
        !self.coop.stageTimer(p)
      ) return;
      if (self.coop.resyncing) return;
      self.armCoopRunTimer(p && p.timerStartedAtMs);
    });
    this.client.on(P.TYPES.COOP_BOARD_INIT, function (p) {
      if (
        self._coopAuthority !== "native-relay-v1" ||
        !self.coop.acceptGeneration(p)
      ) return;
      if (p.collectablesOwnerId) {
        self.coop.collectablesOwnerId = p.collectablesOwnerId;
        if (self.coopNative) {
          self.coopNative.collectablesOwnerId = p.collectablesOwnerId;
        }
      }
      self._coopBoardInitRequested = true;
      self.publishInitialCoopBoard();
    });
    this.client.on(P.TYPES.COOP_BOARD_READY, function (p) {
      if (
        self._coopAuthority !== "native-relay-v1" ||
        !self.coop.applyBoardReady(p)
      ) return;
      if (self.coop.resyncing) return;
      if (self.coopSession) {
        self.coopSession.markBoardReady(self.coop.boardRevision);
      }
      if (Mp && Mp.setCoopAuthority) {
        Mp.setCoopAuthority(
          self._coopAuthority,
          self.coop.generation,
          true
        );
      }
      try {
        if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
        else if (typeof window !== "undefined") window.pauseGame = 0;
        if (typeof window !== "undefined") {
          window.__mpCoopServerAuth = false;
        }
      } catch (eUnpause) { /* ignore */ }
      // Server clears pose caches when the board commits — force every seated
      // client to republish so peers reappear after board-ready.
      self._coopLastPoseFp = null;
      self.flushCoopRelayQueue();
      if (self._coopSeatedPublish) {
        self.publishCoopState({ forceColors: true, seated: true });
      }
      try {
        const me = self.client && self.client.me && self.client.me();
        if (me && me.colorId != null && Gsm.applySnakeColor) {
          Gsm.applySnakeColor(Number(me.colorId));
          self._lastAppliedColorId = Number(me.colorId);
        }
      } catch (eColReady) { /* ignore */ }
    });
    this.client.on(P.TYPES.COOP_SPEED_TRANSITION, function (p) {
      if (
        self._coopAuthority !== "native-relay-v1" ||
        !self.coop.applySpeed(p)
      ) return;
      if (self.coop.resyncing) return;
      // Trigger discovery is deferred; expose canonical state for the hook.
      if (typeof window !== "undefined") {
        window.__mpCoopSpeedEpoch = self.coop.speedEpoch;
        window.__mpCoopEffectiveSpeed = self.coop.speedState;
      }
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
      // Race: PLAY_SYNC is the Start-match signal. Do not gate on stale
      // allowNewRuns — ROSTER with the fresh flag often arrives *after* PLAY_SYNC.
      // Server already enforced ready + allow_new_runs before broadcasting.
      if (me.role === "player") {
        // Prefer ready, but if SESSION_START already flipped sessionActive, start anyway
        if (!me.ready && !roster.sessionActive) return;
      } else if (me.role === "spectator") {
        if (isCoop) {
          // Shared native board (all snakes + obstacles) — same Play path as
          // players, with the local snake parked off-board.
          if (typeof window !== "undefined") {
            window.__mpStartingMatch = true;
            window.__mpCoopSpectator = true;
          }
          self.hideNativeBoard(false);
          if (self._mosaicEl) self._mosaicEl.style.display = "none";
          if (self._focusCanvas) self._focusCanvas.style.display = "none";
          if (self.race) self.race.setSpectateMode("focus");
          self.startMatchLocalPlay({ coop: true, spectator: true });
          return;
        }
        // Race Focus: every spectator (admin + non-admin) seats native Play
        // the same way. If Focus is already mounted from run 1, force a fresh
        // seat so run 2 matches the working first-run path.
        if (typeof window !== "undefined") {
          window.__mpStartingMatch = true;
        }
        self.ensureAutoFocus();
        self.renderFocusBoard();
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
        // Any non-coop match (race / default) — don't require mode==="race"
        self.startMatchLocalPlay({ coop: false });
      }
    });
    this.client.on(P.TYPES.ERROR, function (p) {
      // Late SNAKE_DELTA / COLLECTABLES after ALL_DEAD — expected, not a UI error
      if (p && p.code === "not_coop_session") return;
      // Dead seat still ticking poses (or a peer's late corpse) — ignore.
      if (
        p &&
        (p.code === "seat_dead" ||
          p.code === "stale_pose_seq" ||
          p.code === "stale_generation" ||
          p.code === "seat_not_seated")
      ) {
        return;
      }
      // Pre-join race (should be gated client-side) — don't flash over real join errors
      if (p && p.code === "not_joined") return;
      console.warn("Multiplayer ERROR", p);
      const st = document.getElementById("mp-status");
      if (st) st.textContent = "Error: " + (p.message || p.code);
      if (p && p.code === "player_cap") {
        if (st) {
          st.textContent =
            "Player cap reached (Race ≤9, Co-op ≤4) — promote failed";
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
      self.race.setFocus(p.clientId);
      if (!self.race.boards[p.clientId] && self.client.resync) {
        self.client.resync();
      }
      self.renderSpectateViews();
      self.ui.updateHud(self);
      if (self.ui.renderRoster && roster) self.ui.renderRoster(roster);
    });
    this.client.on(P.TYPES.SESSION_END, function (p) {
      self._handleCoopMatchEnded((p && p.reason) || "ENDED");
      // Race / shared scoreboard bits still apply
      self.race.attemptRemainingMs = null;
      const hasScores =
        self.race.scores && Object.keys(self.race.scores).length > 0;
      if (hasScores) {
        self.race.expired = true;
        if (!self.race.winnerClientId) {
          self.race.winnerClientId = RaceState.pickLeader(
            self.race.scores,
            self.race.raceGoal
          );
          self.race.leaderClientId = self.race.winnerClientId;
        }
      }
      if (self.client && self.client.roster && self.ui.renderRoster) {
        if (hasScores) self.client.roster.attemptExpired = true;
        self.ui.renderRoster(self.client.roster);
      }
    });
    this.client.on(P.TYPES.SESSION_START, function (p) {
      self._log("SESSION_START", p && p.mode);
      let coopSessionUpdate = null;
      if (p && p.mode === "coop") {
        coopSessionUpdate = self.coop.applySession(p);
        if (!coopSessionUpdate.ok) {
          self._log("COOP_SESSION_REJECTED", coopSessionUpdate.reason);
          return;
        }
        if (
          coopSessionUpdate.resync &&
          p.authority === "native-relay-v1"
        ) {
          // Keep the current native board/remotes visible. Ordered replay
          // packets stage in CoopState and commit on the final ROSTER.
          // Route the replay even when this client has not seen the generation
          // before (for example, a spectator joining an active room).
          self._coopAuthority = p.authority;
          self._coopServerAuth = false;
          return;
        }
        self._coopAuthority = self.coop.authority;
        self._coopServerAuth =
          self._coopAuthority === "server-sim-v1";
        if (self._coopAuthority === "server-sim-v1") {
          console.warn(
            "[Multiplayer] Co-op authority is server-sim-v1; product Co-op expects native-relay-v1 (npm run server, or MULTIPLAYER_COOP_NATIVE_RELAY=true)"
          );
        }
        self._coopSessionGen = self.coop.generation;
        if (
          self.coopSession &&
          !self.coopSession.bindGeneration(
            self.coop.generation,
            self._coopAuthority,
            self.coop.boardReady
          )
        ) return;
        if (Mp && Mp.setCoopAuthority) {
          Mp.setCoopAuthority(
            self._coopAuthority,
            self.coop.generation,
            self.coop.boardReady
          );
        }
      }
      // Mid-match RESYNC: restore seats only — do not reset the live run
      if (p && p.resync) {
        if (p.mode === "coop" && Array.isArray(p.slots)) {
          self._coopSlots = p.slots.slice();
          self._coopSpawnOy = null;
          if (self.coopNative && p.collectablesOwnerId) {
            self.coopNative.collectablesOwnerId = p.collectablesOwnerId;
          }
          if (
            self._coopAuthority === "server-sim-v1" &&
            self._coopSessionActive &&
            !self._coopSpawnApplied &&
            typeof self.trySeatCoopOnce === "function"
          ) {
            self.trySeatCoopOnce(
              !!(typeof window !== "undefined" && window.__mpCoopSpectator)
            );
          }
          if (self.coopNative) {
            self.coopNative.generation = self.coop.generation;
            self.coopNative.peerPoseSeq = Object.create(null);
            self.coopNative.syncBridge();
          }
        }
        return;
      }
      // Apply match rules BEFORE __mpStartingMatch so puddingMenuSelect can
      // open/use the full apply path and size Ua is correct for the first Play.
      if (p && p.settings) {
        self._matchSettings = p.settings;
        if (Gsm.forceMatchSettingsForPlay) {
          Gsm.forceMatchSettingsForPlay(p.settings);
        } else {
          self.applySyncedSettings(p.settings);
        }
        if (
          p.mode === "coop" &&
          p.settings.apple != null &&
          Gsm.applySettings
        ) {
          try {
            Gsm.applySettings({ apple: p.settings.apple });
          } catch (eApple) { /* ignore */ }
        }
      }
      // Block SETTINGS_SYNC from opening menus before PLAY_SYNC / triggerPlay
      if (typeof window !== "undefined") {
      window.__mpStartingMatch = true;
      window.__mpAttemptExpired = false;
      if (Mp && Mp.beginMatchStart) Mp.beginMatchStart();
      }
      // Fresh match — arm the post-match menu release again
      self._adminMenusReleased = false;
      if (self.race && self.race.resetForNewMatch) {
        self.race.resetForNewMatch();
      } else if (self.race) {
        self.race.scores = {};
        self.race.boards = {};
        self.race.runClocks = {};
        self.race.expired = false;
        self.race.attemptRemainingMs = null;
        self.race.leaderClientId = null;
        self.race.winnerClientId = null;
      }
      self._raceRunStartedAtMs = null;
      self._coopScores = {};
      self._coopTotal = 0;
      self._coopGoal = null;
      self._coopGoalBoardW = null;
      self._coopGoalBoardH = null;
      self._coopGoalPlayers = null;
      self._coopWon = false;
      self._coopEndReason = null;
      self._coopMatchEndHandled = false;
      self._coopFinalTimeMs = null;
      if (typeof window !== "undefined") {
        window.__mpCoopMatchEndMenus = false;
      }
      if (self.client && self.client.roster) {
        self.client.roster.sessionActive = true;
        // Clear stale "no new runs" before PLAY_SYNC (ROSTER may arrive later)
        self.client.roster.allowNewRuns = true;
        self.client.roster.attemptExpired = false;
        if (p && p.finishOngoingRuns != null) {
          self.client.roster.finishOngoingRuns = !!p.finishOngoingRuns;
        }
        if (p && p.mode) self.client.roster.mode = p.mode;
        if (self.ui.renderRoster) self.ui.renderRoster(self.client.roster);
      }
      // Race: SpeedInfo uses a fresh session TimeKeeper (not lifetime remix PBs)
      if (RaceTimeKeeper) {
        if (p && p.mode === "race") RaceTimeKeeper.beginMatch();
        else RaceTimeKeeper.endMode();
      }
      self.updateStatusIndicator();
      self.ui.updateHud(self);
      if (self.ui.updateRosterScores) self.ui.updateRosterScores();
      // Settings already force-applied above (before __mpStartingMatch)
      if (p && p.mode === "coop") {
        self.setCoopAuthorityMode(true);
        // Every Start Co-op (incl. mid-run) = hard shared reset + reseat
        if (self.coopSession && self.coopSession.enterSeating) {
          self.coopSession.enterSeating(
            self.coop.generation,
            self._coopAuthority
          );
        }
        self._coopSlots = (p.slots || []).slice();
        self._coopBoardInitRequested = false;
        self._coopSpawnApplied = false;
        self._coopSeatedPublish = false;
        self._coopPlayerMoved = false;
        self._coopTimerArmed = false;
        self._coopColsFp = null;
        self._coopSpawnPose = null;
        self._coopSpawnOy = null;
        self._coopLastWalls = null;
        self._coopLastWallCount = null;
        self._coopWallGrowArmed = false;
        self._coopEntityFp = null;
        // Timer arms on first move (COOP_TIMER_START), not at SESSION_START
        self._coopTimerStartedAtMs = null;
        self._coopDeadSent = false;
        self._coopWon = false;
        self._coopEndReason = null;
        self._coopMatchEndHandled = false;
        self._coopFinalTimeMs = null;
        self._coopTotal = 0;
        self._coopScores = {};
        self._adminMenusReleased = false;
        if (typeof window !== "undefined") {
          window.__mpCoopLocalDead = false;
          window.__mpCoopSkipFruitReapply = false;
          window.__mpCoopBoardFull = false;
          // Drop previous match STATE before reset/rebind — otherwise tick
          // reapplyLastState keeps biting the old apple.
          window.__mpCoopLastState = null;
          window.__mpCoopLastStateMyId = null;
          window.__mpCoopLastStateSeq = -1;
          window.__mpCoopAuthReapplyScheduled = false;
          window.__mpCoopRemotes = Object.create(null);
          window.__mpCoopFruitHardReset = true;
          window.__mpCoopFruitFp = null;
          window.__mpCoopAppliedSeq = null;
        }
        if (typeof self.resetNativeCoopRun === "function") {
          self.resetNativeCoopRun({ keepSeatingFlags: true });
        } else if (Gsm.resetCoopBoardForNewSession) {
          try {
            Gsm.resetCoopBoardForNewSession();
          } catch (eReset) {
            console.warn("resetCoopBoardForNewSession", eReset);
          }
        }
        if (Gsm.ensureNativeWallMap && Gsm.gameInstance) {
          try {
            const g0 = Gsm.gameInstance();
            if (g0 && g0.Ca) Gsm.ensureNativeWallMap(g0.Ca);
          } catch (eAa0) { /* ignore */ }
        }
        if (self.coopNative) {
          self.coopNative.reset();
          self.coopNative.sessionActive = true;
          self.coopNative.myClientId = self.client.clientId;
          self.coopNative.generation = self.coop.generation;
          self.coopNative.collectablesOwnerId =
            p.collectablesOwnerId ||
            (self.client.roster && self.client.roster.collectablesOwnerId) ||
            null;
          if (self.coopNative.beginSeedSticky) self.coopNative.beginSeedSticky(1500);
          self.coopNative.syncBridge();
        }
        self._coopSeatedPublish = false;
        self._coopSpawnApplied = false;
        if (typeof window !== "undefined") {
          window.__mpCoopVisualSeated = false;
          window.__mpCoopSeatOnPlayLive = function () {
            try {
              if (self._coopAuthority === "server-sim-v1") {
                return self.ensureCoopServerAuthBoard();
              }
              // Visual paint works before beginCoop / mid-Play bake
              self.paintCoopSeatsFromSlots({ lock: false });
              if (self._coopSessionActive) {
                return self.trySeatCoopOnce(false);
              }
              return !!window.__mpCoopVisualSeated;
            } catch (eLive) {
              return false;
            }
          };
        }
        const Binder = typeof window !== "undefined" && window.CoopBinder;
        if (
          self._coopAuthority === "server-sim-v1" &&
          Binder &&
          Binder.installCoopInputCapture
        ) {
          Binder.installCoopInputCapture(function (dir) {
            if (self.client && self.client.sendCoopInput) {
              self.client.sendCoopInput(dir);
            }
          });
        }
        if (self._coopAuthority === "server-sim-v1" && p.state) {
          self.onCoopState(p.state);
        }
        if (self._coopAuthority === "server-sim-v1") {
          try {
            self.ensureCoopServerAuthBoard();
          } catch (eEns) {
            console.warn("SESSION_START ensureCoopServerAuthBoard", eEns);
          }
        }
        // Visual seat/seed as soon as slots exist (hard lock still waits for live Play)
        if (self._coopAuthority === "native-relay-v1") {
          try {
            self.paintCoopSeatsFromSlots({ lock: false });
          } catch (ePaint) {
            console.warn("SESSION_START paintCoopSeatsFromSlots", ePaint);
          }
        }
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
      self.updateStatusIndicator();
    });
    this.client.on("CLOSE", function (ev) {
      self._log("CLOSE", ev && ev.code);
      if (RaceTimeKeeper) RaceTimeKeeper.endMode();
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
    this._leaveRaceFocusSpectate();
    this.endCoopNativeSession();
    this.setCoopAuthorityMode(false);
    if (RaceTimeKeeper) RaceTimeKeeper.endMode();
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
    let idx = players.findIndex((p) => p.clientId === this.race.focusClientId);
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
    const mode = this.client.roster.mode;
    if (mode !== "race" && mode !== "coop") return;
    const target = (this.client.roster.clients || []).find(function (c) {
      return c.clientId === clientId;
    });
    if (!target || target.role !== "player") return;
    if (typeof window !== "undefined") {
      window.__mpSpectateAllowMenus = false;
    }
    this.race.setFocus(clientId);
    this.client.spectateFocus(clientId);
    if (!opts.keepMode) {
      // Co-op shared board has no mosaic/Focus split — stay on native canvas
      if (mode === "coop") {
        if (this.race) this.race.setSpectateMode("focus");
        this.hideNativeBoard(false);
        if (this._mosaicEl) this._mosaicEl.style.display = "none";
      } else {
        this.race.setSpectateMode("focus");
        const btn = document.getElementById("mp-mosaic-toggle");
        if (btn) btn.textContent = "Mosaic";
      }
    }
    if (!this.race.boards[clientId] && this.client.resync) {
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
   * carries a newer settings snapshot (lobby + co-op/race).
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
    // Co-op fruit type must match admin's apple row — server reads settings.apple
    const roster = this.client.roster || {};
    if (roster.mode === "coop" && Gsm.readSettingIndex) {
      const apple = Gsm.readSettingIndex("apple");
      if (apple != null && Number.isFinite(Number(apple))) {
        snap.apple = Number(apple) | 0;
      }
    }
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

    // Co-op: refuse colors locked by another *ready* player (unready may share until Ready bumps)
    if (this.client.roster && this.client.roster.mode === "coop") {
      const clients = (this.client.roster.clients || []);
      const taken = clients.some(function (c) {
        return (
          c &&
          c.role === "player" &&
          c.ready === true &&
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
    // Optimistic roster update so dots track the pick before ROSTER round-trip
    me.colorId = colorId;
    if (Colors && Colors.colorName) me.colorName = Colors.colorName(colorId);
    if (this.ui) {
      if (this.ui.updateColorIcon) {
        this.ui.updateColorIcon(
          colorId,
          this.client.roster &&
            this.client.roster.mode === "coop" &&
            me.role === "player"
        );
      }
      if (this.ui.renderRoster && this.client.roster) {
        this.ui.renderRoster(this.client.roster);
      } else if (this.ui.updateRosterColorDots) {
        this.ui.updateRosterColorDots();
      }
    }
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

  /** Seated players: Shuffle (jsname=qycu7d) becomes Ready — no randomize. */
  MultiplayerApp.prototype._shuffleReadyButton = function () {
    return (
      document.querySelector('[jsname="qycu7d"]') ||
      (typeof window !== "undefined" ? window.random_button : null)
    );
  };

  /**
   * Replace visible label text on the native Play button without removing its
   * icon (svg/img/canvas siblings stay put).
   */
  MultiplayerApp.prototype._setPlayButtonLabelKeepIcon = function (btn, label) {
    if (!btn || label == null) return;
    if (!btn.__mpPlayLabelSaved) {
      btn.__mpPlayLabelSaved = {
        aria: btn.getAttribute("aria-label"),
        html: btn.innerHTML,
      };
    }
    btn.setAttribute("aria-label", label);
    const leaves = btn.querySelectorAll("*");
    let textEl = null;
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      if (el.children.length) continue;
      if (/^(svg|img|canvas|path|circle|rect|use|g)$/i.test(el.tagName)) {
        continue;
      }
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (/^(play|start\b)/i.test(t)) {
        textEl = el;
        break;
      }
      if (!textEl) textEl = el;
    }
    if (textEl) {
      textEl.textContent = label;
      return;
    }
    if (
      btn.childNodes.length === 1 &&
      btn.childNodes[0].nodeType === 3
    ) {
      btn.childNodes[0].nodeValue = label;
      return;
    }
    // Icon-only / unknown structure: keep children, maintain a label span
    let span = btn.querySelector(".mp-play-start-label");
    if (!span) {
      span = document.createElement("span");
      span.className = "mp-play-start-label";
      btn.appendChild(span);
    }
    span.textContent = label;
  };

  MultiplayerApp.prototype._restorePlayButtonLabel = function (btn) {
    btn = btn || (Gsm.playButton && Gsm.playButton());
    if (!btn || !btn.__mpPlayLabelSaved) return;
    const saved = btn.__mpPlayLabelSaved;
    if (saved.aria == null) btn.removeAttribute("aria-label");
    else btn.setAttribute("aria-label", saved.aria);
    if (saved.html != null) btn.innerHTML = saved.html;
    delete btn.__mpPlayLabelSaved;
  };

  /** Can the room admin fire SESSION_START right now? */
  MultiplayerApp.prototype.canAdminStartMatch = function () {
    if (!this.client || !this.client.connected || !this.client.isAdmin()) {
      return false;
    }
    const roster = this.client.roster || {};
    if (roster.sessionActive) return false;
    const midAttemptNoRuns =
      roster.mode === "race" &&
      roster.sessionActive &&
      roster.allowNewRuns === false;
    if (midAttemptNoRuns) return false;
    const Session = root.MultiplayerSession;
    if (Session && Session.canStart && !Session.canStart(roster)) return false;
    return true;
  };

  /**
   * Native Play becomes Start Match / Start Co-op for the room admin.
   * Icon stays; only the label + click action change.
   */
  MultiplayerApp.prototype._paintPlayAsStartMatch = function () {
    const btn = Gsm.playButton && Gsm.playButton();
    if (!btn) return;
    if (!this.client || !this.client.connected) {
      this._restorePlayButtonLabel(btn);
      if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(false);
      return;
    }
    const roster = this.client.roster || {};
    const mode = roster.mode === "coop" ? "coop" : "race";
    const label = mode === "coop" ? "Start Co-op" : "Start Race";
    const isAdmin = this.client.isAdmin();
    if (!isAdmin) {
      this._restorePlayButtonLabel(btn);
      if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(true);
      btn.title = "Waiting for the room admin to start";
      return;
    }
    this._setPlayButtonLabelKeepIcon(btn, label);
    const canStart = this.canAdminStartMatch();
    if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(!canStart);
    if (roster.sessionActive) {
      btn.title = "Match in progress — use End match to stop";
    } else if (!canStart) {
      btn.title = "All players must be Ready first";
    } else {
      btn.title =
        mode === "coop"
          ? "Start co-op for everyone"
          : "Start match for everyone";
    }
  };

  /**
   * Admin Start Match / Start Co-op — same payload the old Match-tab button sent.
   * Reads race duration/goal/finish-ongoing from the settings fields or ls.
   */
  MultiplayerApp.prototype.startMatchAsAdmin = function () {
    if (!this.canAdminStartMatch()) return false;
    const roster = this.client.roster || {};
    const RaceState = root.RaceState;
    function lsGet(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : v;
      } catch (e) {
        return d;
      }
    }
    function lsSet(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) { /* ignore */ }
    }
    const durEl = document.getElementById("mp-duration");
    const mins = Math.max(
      1,
      parseInt(
        (durEl && durEl.value) ||
          lsGet("MULTIPLAYER_RACE_ATTEMPT_MIN", "30"),
        10
      ) || 30
    );
    if (durEl) durEl.value = String(mins);
    lsSet("MULTIPLAYER_RACE_ATTEMPT_MIN", String(mins));
    if (this.client.setDuration) this.client.setDuration(mins);
    const goalEl = document.getElementById("mp-race-goal");
    let g =
      (goalEl && goalEl.value) || lsGet("MULTIPLAYER_RACE_GOAL", "score");
    if (RaceState && RaceState.normalizeGoal) {
      g = RaceState.normalizeGoal(g);
    }
    if (goalEl) goalEl.value = g;
    lsSet("MULTIPLAYER_RACE_GOAL", g);
    if (this.client.setRaceGoal) this.client.setRaceGoal(g);
    const snap =
      this.syncMySettingsAsAdmin && this.syncMySettingsAsAdmin();
    const startPayload = snap ? { settings: Object.assign({}, snap) } : { settings: {} };
    // Always stamp admin apple into co-op start so server fruit type matches native
    if (roster.mode === "coop") {
      if (!startPayload.settings) startPayload.settings = {};
      if (Gsm.readSettingIndex) {
        ["trophy", "count", "speed", "size", "apple"].forEach(function (key) {
          // Never clobber values already stamped by syncMySettingsAsAdmin —
          // DOM size can stay Standard (0) while the admin forced Small.
          if (
            startPayload.settings[key] != null &&
            Number.isFinite(Number(startPayload.settings[key]))
          ) {
            return;
          }
          const v = Gsm.readSettingIndex(key);
          if (v != null && Number.isFinite(Number(v))) {
            startPayload.settings[key] = Number(v) | 0;
          }
        });
      }
      // Last-chance: DOM size row + engine Sa/Aa must match before SESSION_START
      try {
        const sizeRow = document.getElementById("size");
        const selected =
          sizeRow && sizeRow.querySelector && sizeRow.querySelector(".tuJOWd");
        if (
          selected &&
          selected.dataset &&
          selected.dataset.index != null &&
          startPayload.settings.size == null
        ) {
          startPayload.settings.size = Number(selected.dataset.index) | 0;
        }
      } catch (eDomSize) { /* ignore */ }
      if (
        startPayload.settings.size != null &&
        Gsm.forceEngineSizeForPlay
      ) {
        Gsm.forceEngineSizeForPlay(startPayload.settings.size);
      }
      if (Gsm.forceMatchSettingsForPlay) {
        Gsm.forceMatchSettingsForPlay(startPayload.settings);
      }
      try {
        if (typeof window !== "undefined") {
          window.__mpCoopPlaySettings = Object.assign(
            {},
            window.__mpCoopPlaySettings || {},
            startPayload.settings
          );
        }
      } catch (eStamp) { /* ignore */ }
    }
    if (roster.mode === "race") {
      const finishEl = document.getElementById("mp-finish-ongoing");
      const finishOngoing = finishEl
        ? !!finishEl.checked
        : lsGet("MULTIPLAYER_RACE_FINISH_ONGOING", "1") !== "0";
      lsSet(
        "MULTIPLAYER_RACE_FINISH_ONGOING",
        finishOngoing ? "1" : "0"
      );
      startPayload.finishOngoingRuns = finishOngoing;
    }
    this.client.sessionStart(startPayload);
    const st = document.getElementById("mp-status");
    if (st) {
      st.textContent =
        roster.mode === "coop" ? "Starting co-op…" : "Starting match…";
    }
    return true;
  };

  /** Every player readies here, admin included — the server waits on all seats. */
  MultiplayerApp.prototype._shouldUseShuffleAsReady = function () {
    if (!this.client || !this.client.connected) return false;
    if (this.client.joined === false) return false;
    const me = this.client.me && this.client.me();
    return !!(me && me.role === "player");
  };

  MultiplayerApp.prototype._paintShuffleAsReady = function (btn) {
    btn = btn || this._shuffleReadyButton();
    if (!btn) return;
    // Google rebuilds the menu between runs, so the click hook is claimed on
    // whatever button we find rather than once at boot.
    this._hookReadyClicks(btn);
    if (!this._shouldUseShuffleAsReady()) {
      if (btn.__mpReadyMode) {
        btn.__mpReadyMode = false;
        btn.__mpReadyPaint = null;
        btn.classList.remove("mp-ready-btn", "mp-ready-on", "mp-ready-off");
        if (btn.style.removeProperty) {
          btn.style.removeProperty("background");
          btn.style.removeProperty("background-color");
          btn.style.removeProperty("color");
          btn.style.removeProperty("border-color");
          btn.style.removeProperty("pointer-events");
        }
        btn.style.pointerEvents = "";
        btn.style.background = btn.__mpReadyOrigBg || "";
        btn.style.backgroundColor = "";
        btn.style.color = btn.__mpReadyOrigColor || "";
        btn.style.borderColor = "";
        if (
          typeof window !== "undefined" &&
          typeof window.applyRandomButtonState === "function"
        ) {
          window.applyRandomButtonState(
            !!(
              window.pudding_settings && window.pudding_settings.DisableRandom
            )
          );
        } else if (btn.__mpReadyOrigHtml != null) {
          btn.innerHTML = btn.__mpReadyOrigHtml;
        } else {
          btn.textContent = "Shuffle";
        }
      }
      return;
    }
    if (!btn.__mpReadyMode) {
      btn.__mpReadyOrigHtml = btn.innerHTML;
      btn.__mpReadyOrigBg =
        btn.style.background || btn.style.backgroundColor || "";
      btn.__mpReadyOrigColor = btn.style.color || "";
      btn.__mpReadyMode = true;
    }
    const me = this.client.me();
    const ready = !!(me && me.ready);
    btn.classList.add("mp-ready-btn");
    btn.classList.toggle("mp-ready-on", ready);
    btn.classList.toggle("mp-ready-off", !ready);
    btn.style.pointerEvents = "auto";
    btn.textContent = ready ? "Unready" : "Ready";
    // Dark green when ready, dark red when not — also pinned by .mp-ready-*
    const bg = ready ? "#1b5e20" : "#b71c1c";
    const border = ready ? "#0d3d12" : "#7f0000";
    if (btn.style.setProperty) {
      btn.style.setProperty("background", bg, "important");
      btn.style.setProperty("background-color", bg, "important");
      btn.style.setProperty("color", "#fff", "important");
      btn.style.setProperty("border-color", border, "important");
    } else {
      btn.style.background = bg;
      btn.style.backgroundColor = bg;
      btn.style.color = "#fff";
      btn.style.borderColor = border;
    }
    btn.title = ready
      ? "Click to unready"
      : "Click when ready to start";
    // Keep what the browser made of the paint: the watchdog compares against
    // this to tell somebody else's repaint from our own.
    btn.__mpReadyPaint = {
      text: btn.textContent,
      bg: btn.style.backgroundColor,
      color: btn.style.color,
    };
    this._watchReadyButton(btn);
  };

  /** Ready clicks must never reach Google's randomizer. Safe to call again. */
  MultiplayerApp.prototype._hookReadyClicks = function (btn) {
    if (!btn || btn.__mpReadyHooked) return;
    btn.__mpReadyHooked = true;
    const self = this;
    function blockShuffle(ev) {
      if (!self._shouldUseShuffleAsReady()) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    }
    // pointerdown/mousedown also fire Shuffle's randomizer on some builds
    ["pointerdown", "mousedown", "click"].forEach(function (type) {
      btn.addEventListener(
        type,
        function (ev) {
          blockShuffle(ev);
          if (type === "click") self._toggleReadyFromShuffle();
        },
        true
      );
    });
  };

  /**
   * A theme switch or a between-runs menu rebuild repaints Shuffle in Google's
   * own colours, which used to leave Ready looking like a plain button until
   * the next roster arrived. Put our paint back as soon as it is overwritten,
   * and follow the button if the menu hands us a fresh one.
   */
  MultiplayerApp.prototype._watchReadyButton = function (btn) {
    const MO = root.MutationObserver;
    if (!btn || typeof MO !== "function") return;
    const self = this;
    if (!btn.__mpReadyObserver) {
      const obs = new MO(function () {
        // Our own paint echoes back as mutations — ignore that round trip
        if (btn.__mpReadyRepainting) return;
        if (!self._shouldUseShuffleAsReady()) return;
        if (!self._readyPaintDrifted(btn)) return;
        btn.__mpReadyRepainting = true;
        try {
          self._paintShuffleAsReady(btn);
        } finally {
          setTimeout(function () {
            btn.__mpReadyRepainting = false;
          }, 0);
        }
      });
      obs.observe(btn, {
        attributes: true,
        attributeFilter: ["style", "class"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      btn.__mpReadyObserver = obs;
    }
    // Menu rebuilds swap the node out from under us; the old observer dies
    // with it, so watch the row it sits in and adopt the replacement.
    const row = btn.parentElement;
    if (row && !row.__mpReadySwapObserver) {
      const swap = new MO(function () {
        const now = self._shuffleReadyButton();
        if (now && now !== btn) self._paintShuffleAsReady(now);
      });
      swap.observe(row, { childList: true });
      row.__mpReadySwapObserver = swap;
    }
  };

  /** True when somebody repainted the button out from under our Ready state. */
  MultiplayerApp.prototype._readyPaintDrifted = function (btn) {
    const want = btn && btn.__mpReadyPaint;
    if (!want) return true;
    return (
      !btn.classList.contains("mp-ready-btn") ||
      btn.classList.contains("mp-ready-on") !==
        (want.text === "Unready") ||
      btn.textContent !== want.text ||
      btn.style.backgroundColor !== want.bg ||
      btn.style.color !== want.color
    );
  };

  MultiplayerApp.prototype._toggleReadyFromShuffle = function () {
    if (!this._shouldUseShuffleAsReady()) return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;
    const colorBefore =
      Gsm.readSettingIndex && Gsm.readSettingIndex("color");
    const next = !me.ready;
    me.ready = next;
    if (this.client.setReady) this.client.setReady(next);
    this._paintShuffleAsReady();
    this.applyControlLocks();
    // Unready in lobby: quit the engine so trophy/count/speed/size accept clicks
    if (!next && this.ensureLobbyMatchMenusInteractive) {
      this._lobbyMenuPulseAt = 0;
      this.ensureLobbyMatchMenusInteractive();
    }
    // If anything still nudged the color row, put it back
    const colorAfter =
      Gsm.readSettingIndex && Gsm.readSettingIndex("color");
    if (
      colorBefore != null &&
      colorAfter != null &&
      Number(colorBefore) !== Number(colorAfter) &&
      Gsm.applySnakeColor
    ) {
      Gsm.applySnakeColor(colorBefore);
    }
    const tabBtn = document.getElementById("mp-ready");
    if (tabBtn) tabBtn.textContent = next ? "Unready" : "Ready";
    if (this.client.roster && this.ui && this.ui.renderRoster) {
      this.ui.renderRoster(this.client.roster);
    }
  };

  MultiplayerApp.prototype.hookInGameReadyButton = function () {
    const self = this;
    function bind() {
      const btn = self._shuffleReadyButton();
      if (!btn) return false;
      // Hooks the clicks and arms the repaint watchdog
      self._paintShuffleAsReady(btn);
      return true;
    }
    if (!bind()) {
      setTimeout(bind, 300);
      setTimeout(bind, 1000);
      setTimeout(bind, 2500);
    }
    // Remix/Pudding may recolor Shuffle via applyRandomButtonState — keep Ready
    if (
      typeof window !== "undefined" &&
      typeof window.applyRandomButtonState === "function" &&
      !window.applyRandomButtonState.__mpReadyWrapped
    ) {
      const orig = window.applyRandomButtonState;
      window.applyRandomButtonState = function () {
        if (self._shouldUseShuffleAsReady()) {
          self._paintShuffleAsReady();
          return;
        }
        return orig.apply(this, arguments);
      };
      window.applyRandomButtonState.__mpReadyWrapped = true;
    }
  };

  MultiplayerApp.prototype.ensureFocusCanvas = function () {
    // Floating canvas is Co-op only; Race focus uses the native game canvas.
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
      this.race && this.race.boards && this.race.boards[clientId];

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

  MultiplayerApp.prototype._isRaceSpectator = function () {
    const me = this.client && this.client.me();
    return !!(
      me &&
      me.role === "spectator" &&
      this.client.roster &&
      this.client.roster.mode === "race"
    );
  };

  // Race Focus + mosaic live in race/focus.js and race/mosaic.js
  if (root.MultiplayerFocus && root.MultiplayerFocus.install) {
    root.MultiplayerFocus.install(MultiplayerApp);
  }
  if (root.MultiplayerMosaic && root.MultiplayerMosaic.install) {
    root.MultiplayerMosaic.install(MultiplayerApp);
  }

  MultiplayerApp.prototype.renderCoopOverlay = function () {
    // Deprecated — remotes inject via __mpCoopOnTick on the native canvas.
  };

  /**
   * Start match → every participating client must enter a native Play run.
   * One short Play attempt — no nested spawn loops. Cancelled if SESSION_END wins the race.
   */
  MultiplayerApp.prototype.startMatchLocalPlay = function (opts) {
    opts = opts || {};
    const self = this;
    const playGen = (this._matchPlayGen = (this._matchPlayGen | 0) + 1);
    if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
    if (Gsm.installFirstRunControlTipGuard) {
      Gsm.installFirstRunControlTipGuard();
    } else if (Gsm.hideControlHelper) {
      Gsm.hideControlHelper();
    }
    function sessionStillLive() {
      if (playGen !== self._matchPlayGen) return false;
      if (self._coopEndReason) return false;
      const roster = self.client && self.client.roster;
      if (roster && roster.sessionActive === false) return false;
      return true;
    }
    function beginIfLive() {
      if (!opts.coop) return;
      if (!sessionStillLive()) return;
      self.beginCoopNativeSession({
        spectator: !!opts.spectator,
      });
    }
    function runPlay() {
      if (!sessionStillLive()) return;
      if (Gsm.startNativeRun) {
        Gsm.startNativeRun({
          maxAttempts: 12,
          intervalMs: 50,
          // Co-op: native clock stays at 0 until COOP_TIMER_START (first input)
          deferTimer: !!opts.coop,
          onDone: function (ok) {
            if (!sessionStillLive()) return;
            if (!ok) {
              console.debug("[Multiplayer] co-op Play not live yet; binding STATE anyway");
            }
            beginIfLive();
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
        if (!sessionStillLive()) return;
        attempts++;
        try {
          Gsm.triggerPlay();
        } catch (e) { /* ignore */ }
        const live = Gsm.isNativeRunLive
          ? Gsm.isNativeRunLive()
          : !!(Gsm.gameInstance && Gsm.gameInstance() && Gsm.gameInstance().oa);
        if (live || attempts >= 12) {
          beginIfLive();
          if (typeof window !== "undefined") {
            setTimeout(function () {
              window.__mpStartingMatch = false;
            }, 400);
          }
          return;
        }
        setTimeout(attempt, 50);
      }
      setTimeout(attempt, 0);
    }
    // Co-op: force size/speed/count into the menu so the FIRST Play bakes the
    // right grid (Ua→Aa). After Play, assert live GameInstance size — DOM match
    // alone can still leave Standard while slots are Small.
    if (opts.coop && self._matchSettings && Gsm.applySettings) {
      let tries = 0;
      let bakeRetries = 0;
      function sizeReady() {
        if (self._matchSettings.size == null) return true;
        const want = Number(self._matchSettings.size) | 0;
        // Engine Sa is what Ma() copies — prefer it over a locked DOM row
        try {
          const g = Gsm.gameInstance && Gsm.gameInstance();
          if (g && g.settings && Number(g.settings.Sa) === want) return true;
        } catch (eSa) { /* ignore */ }
        if (!Gsm.settingsMatchLocal) return true;
        return Gsm.settingsMatchLocal({ size: want });
      }
      function expectedBakeSettings() {
        const s = self._matchSettings || {};
        // Always derive want dims from match size index — slot boardWidth can
        // lag a stale SESSION_START and soft-pass Standard vs Small.
        if (s.size != null && Number.isFinite(Number(s.size))) {
          const dims =
            (Gsm.boardDimsForSizeIndex &&
              Gsm.boardDimsForSizeIndex(s.size)) ||
            null;
          if (dims && dims.width && dims.height) {
            return {
              size: Number(s.size) | 0,
              boardWidth: dims.width,
              boardHeight: dims.height,
            };
          }
        }
        const slot0 =
          self._coopSlots && self._coopSlots[0] ? self._coopSlots[0] : null;
        if (slot0 && slot0.boardWidth && slot0.boardHeight) {
          return {
            size: s.size,
            boardWidth: slot0.boardWidth,
            boardHeight: slot0.boardHeight,
          };
        }
        return s;
      }
      function liveBakeOk() {
        if (!Gsm.liveBoardMatchesSettings) return true;
        return Gsm.liveBoardMatchesSettings(expectedBakeSettings());
      }
      function forceBakeDims() {
        const s = self._matchSettings || {};
        if (s.size == null) return false;
        let ok = false;
        try {
          if (Gsm.forceNativePlayBake) {
            ok = Gsm.forceNativePlayBake(s) === true;
          }
        } catch (eBake) { /* ignore */ }
        if (!liveBakeOk() && Gsm.forceLiveBoardDims) {
          try {
            ok = Gsm.forceLiveBoardDims(s.size) === true || ok;
          } catch (eDims) { /* ignore */ }
        }
        return ok;
      }
      function startAfterBake() {
        if (!sessionStillLive()) return;
        if (!liveBakeOk()) {
          forceBakeDims();
        }
        if (!liveBakeOk() && bakeRetries < 2) {
          bakeRetries++;
          console.warn(
            "[Multiplayer] co-op live board size mismatch after Play — re-forcing settings and Play (" +
              bakeRetries +
              "/2)"
          );
          try {
            if (Gsm.forceMatchSettingsForPlay) {
              Gsm.forceMatchSettingsForPlay(self._matchSettings);
            }
            if (Gsm.forceEngineMatchFieldsForPlay) {
              Gsm.forceEngineMatchFieldsForPlay(self._matchSettings);
            }
            forceBakeDims();
          } catch (eForce) { /* ignore */ }
          if (liveBakeOk()) {
            if (self._pendingInitialCollectables) {
              self._applyInitialCollectablesWithRetry(
                self._pendingInitialCollectables,
                0
              );
            }
            beginIfLive();
            return;
          }
          if (Gsm.startNativeRun) {
            Gsm.startNativeRun({
              maxAttempts: 12,
              intervalMs: 50,
              deferTimer: true,
              keepSettingsOpen: true,
              onDone: function () {
                if (!sessionStillLive()) return;
                startAfterBake();
              },
            });
            return;
          }
        }
        if (!liveBakeOk()) {
          console.warn(
            "[Multiplayer] co-op live board still mismatches admin size — aborting Start"
          );
          self._matchPlayGen = (self._matchPlayGen | 0) + 1;
          try {
            if (typeof window !== "undefined") {
              window.__mpStartingMatch = false;
              window.__mpStartNativeRunGen =
                (window.__mpStartNativeRunGen | 0) + 1;
            }
          } catch (eGen) { /* ignore */ }
          try {
            if (self.client && self.client.roster) {
              self.client.roster.sessionActive = false;
            }
            self._coopEndReason = "BAKE_SIZE_MISMATCH";
            if (self.ui && typeof self.ui.updateHud === "function") {
              self.ui.updateHud(self);
            }
            if (typeof self.returnToMenus === "function") {
              self.returnToMenus({ fromBakeFail: true });
            }
          } catch (eAbort) { /* ignore */ }
          return;
        }
        // Fruit may have been applied to a pre-Play host — flush again now
        if (self._pendingInitialCollectables) {
          self._applyInitialCollectablesWithRetry(
            self._pendingInitialCollectables,
            0
          );
        }
        beginIfLive();
      }
      function ensureThenPlay() {
        if (!sessionStillLive()) return;
        try {
          if (Gsm.forceMatchSettingsForPlay) {
            Gsm.forceMatchSettingsForPlay(self._matchSettings);
          }
          if (Gsm.forceEngineMatchFieldsForPlay) {
            Gsm.forceEngineMatchFieldsForPlay(self._matchSettings);
          }
        } catch (eSet) { /* ignore */ }
        tries++;
        if (!sizeReady() && tries < 12) {
          setTimeout(ensureThenPlay, 40);
          return;
        }
        if (!sizeReady()) {
          console.warn(
            "[Multiplayer] co-op size menu never matched admin — aborting Play"
          );
          return;
        }
        // Last chance: Sa→Aa must be correct the instant Play's Ma() runs
        try {
          if (typeof window !== "undefined") {
            window.__mpCoopPlaySettings = self._matchSettings;
            window.__mpMatchPlaySettings = self._matchSettings;
          }
          if (Gsm.forceEngineMatchFieldsForPlay) {
            Gsm.forceEngineMatchFieldsForPlay(self._matchSettings);
          }
          if (Gsm.forceNativePlayBake) {
            Gsm.forceNativePlayBake(self._matchSettings);
          }
        } catch (eForce2) { /* ignore */ }
        // Keep settings menu visible so native Ma() bake gate passes
        try {
          if (typeof window !== "undefined" && typeof window.BootstrapShow === "function") {
            window.BootstrapShow();
          }
        } catch (eShow) { /* ignore */ }
        if (Gsm.startNativeRun) {
          Gsm.startNativeRun({
            maxAttempts: 12,
            intervalMs: 50,
            deferTimer: true,
            keepSettingsOpen: true,
            onDone: function (okPlay) {
              if (!sessionStillLive()) return;
              if (!okPlay) {
                console.debug(
                  "[Multiplayer] co-op Play not live yet; checking bake anyway"
                );
              }
              startAfterBake();
            },
          });
        } else {
          runPlay();
        }
      }
      ensureThenPlay();
      return;
    }
    runPlay();
  };

  /** @deprecated use startMatchLocalPlay */
  MultiplayerApp.prototype.startCoopLocalRun = function (opts) {
    this.startMatchLocalPlay({
      coop: true,
      spectator: !!(opts && opts.spectator),
    });
  };

  /**
   * Initial COLLECTABLES_DELTA must land in g.wa.ka. If Play/seat has not
   * created the fruit host yet, retry briefly — native-relay has no runtime refill.
   */
  MultiplayerApp.prototype._applyInitialCollectablesWithRetry = function (
    fruitPayload,
    attempt
  ) {
    const self = this;
    attempt = attempt | 0;
    if (!fruitPayload || !Gsm.applyCollectables) return false;
    self._pendingInitialCollectables = fruitPayload;
    let ok = false;
    try {
      ok = Gsm.applyCollectables(fruitPayload) === true;
    } catch (eApply) {
      ok = false;
    }
    // Empty pre-Play wa.ka can "succeed" then Play recreates the host and
    // wipes fruit — only clear pending once native templates + count stick.
    if (ok) {
      const want = Array.isArray(fruitPayload.apples)
        ? fruitPayload.apples.length
        : Array.isArray(fruitPayload.collectables)
          ? fruitPayload.collectables.length
          : 0;
      let have = 0;
      let hasNativeTemplate = false;
      try {
        const g = Gsm.gameInstance && Gsm.gameInstance();
        const ka = g && g.wa && g.wa.ka;
        if (Array.isArray(ka)) {
          have = ka.length;
          for (let i = 0; i < ka.length; i++) {
            const a = ka[i];
            if (a && a.pos && typeof a.pos.clone === "function") {
              hasNativeTemplate = true;
              break;
            }
          }
        }
      } catch (eInspect) { /* ignore */ }
      if (want > 0 && have >= want && hasNativeTemplate) {
        self._pendingInitialCollectables = null;
        return true;
      }
      ok = false;
    }
    if (attempt >= 40) {
      console.warn(
        "[Multiplayer] initial COLLECTABLES apply failed — g.wa.ka never ready"
      );
      return false;
    }
    setTimeout(function () {
      if (!self._pendingInitialCollectables) return;
      const roster = self.client && self.client.roster;
      if (roster && roster.sessionActive === false) return;
      self._applyInitialCollectablesWithRetry(
        self._pendingInitialCollectables || fruitPayload,
        attempt + 1
      );
    }, 50);
    return false;
  };

  MultiplayerApp.prototype.beginCoopNativeSession = function (opts) {
    opts = opts || {};
    const self = this;
    // Never revive local co-op after SESSION_END / aborted Start
    const roster = this.client && this.client.roster;
    if (roster && roster.sessionActive === false) return;
    if (this._coopEndReason) return;
    this._coopSessionActive = true;
    if (this.coopSession) {
      if (!this.coopSession.is || !this.coopSession.is("Seating")) {
        this.coopSession.enterSeating();
      }
    }
    // Wall mode first-apple grow (p6E) needs Ca.Aa before any tick
    try {
      if (Gsm.ensureNativeWallMap && Gsm.gameInstance) {
        const g = Gsm.gameInstance();
        if (g && g.Ca) Gsm.ensureNativeWallMap(g.Ca);
      }
    } catch (eAa) { /* ignore */ }

    this._coopServerAuth = this._coopAuthority === "server-sim-v1";
    if (Mp && Mp.setCoopAuthority) {
      Mp.setCoopAuthority(
        this._coopAuthority,
        this.coop.generation,
        this.coop.boardReady
      );
    }
    if (typeof window !== "undefined" && this._coopAuthority === "native-relay-v1") {
      // Never leave a prior server-sim pause / auth latch on the native path
      window.__mpCoopServerAuth = false;
      try {
        if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
        else window.pauseGame = 0;
      } catch (eClearPause) { /* ignore */ }
    }

    // Fruit may have arrived before wa.ka existed — flush queued initial board
    if (this._pendingInitialCollectables) {
      this._applyInitialCollectablesWithRetry(this._pendingInitialCollectables, 0);
    }

    this._coopLastPoseFp = null;
    this._coopColorsSent = false;
    this._coopTimerArmed = false;
    this._coopTimerStartedAtMs = null;
    this._coopPlayerMoved = false;
    this._coopMatchEndHandled = false;
    this._coopColsFp = null;
    this._coopEntityFp = null;
    this._coopLastWalls = null;
    this._coopLastWallCount = null;
    this._coopWallGrowArmed = false;
    this._coopDeadSent = false;
    // Drop menu/load keypresses queued before seats exist — board-ready flush
    // used to applyCoopStartMoving from those and auto-crawl on Start.
    if (this.coopSession) {
      try {
        this.coopSession.pendingInput = null;
        this.coopSession.pendingPose = null;
      } catch (eQ) { /* ignore */ }
    }
    // Long enough that late peer seeds cannot wipe idle seats; first key clears it.
    this._coopIgnoreStartUntil = Date.now() + 15000;
    if (typeof window !== "undefined") {
      window.__mpCoopIgnoreStartUntil = this._coopIgnoreStartUntil;
      window.__mpCoopSpectator = !!opts.spectator;
      if (opts.spectator) {
        window.__mpCoopLocalDead = true;
      } else {
        window.__mpCoopLocalDead = false;
      }
      // Runtime empty-pool ALL — eater reports shared room win
      window.__mpCoopOnBoardFull = function () {
        window.__mpCoopBoardFull = true;
        if (typeof self.maybeCoopAllApples === "function") {
          self.maybeCoopAllApples("board_full");
        }
      };
    }
    if (this.coopNative) {
      this.coopNative.sessionActive = true;
      this.coopNative.myClientId = this.client && this.client.clientId;
      this.coopNative.generation = this.coop.generation;
      this.coopNative.injectEnabled = true;
      if (this.coopNative.beginSeedSticky) this.coopNative.beginSeedSticky(1500);
      this.coopNative.syncBridge();
      if (this.coopNative.resetNativePeerPaint) {
        this.coopNative.resetNativePeerPaint();
      }
    }
    if (Gsm.installSpectatorTimeKeeperGuard) {
      Gsm.installSpectatorTimeKeeperGuard();
    }

    // Authority-specific runtime. Both paths share native seating/chrome.
    this._coopSpawnApplied = false;
    this._coopSeatedPublish = false;
    this._coopSpawnOy = null;
    if (typeof window !== "undefined") {
      // Peer pose coalesce must stay on its own flush — never reuse the
      // board-ready input/pose relay queue helper here.
      window.__mpCoopFlushPendingDeltas = function () {
        self.flushPendingCoopSnakeDeltas();
      };
      if (typeof self.installNativeTickNetPublish === "function") {
        self.installNativeTickNetPublish();
      } else {
        window.__mpCoopAfterTick =
          this._coopAuthority === "native-relay-v1"
            ? function () {
                self.publishCoopState();
              }
            : function () {};
      }
      window.__mpCoopLastTickAt = 0;
      window.__mpCoopOnLocalReset = function () {
        if (self._coopAuthority === "server-sim-v1") {
          self._softRebindCoopServerAuth("reset_hook");
          return true;
        }
        if (self._coopAuthority === "native-relay-v1" && self._coopSessionActive) {
          const me = self.client && self.client.me && self.client.me();
          const localDead =
            !!self._coopDeadSent ||
            !!self._coopMatchEndHandled ||
            (self.coopSession && !!self.coopSession.localDead) ||
            (typeof window !== "undefined" && !!window.__mpCoopLocalDead);
          // Death / match-end often calls GameInstance.reset(). That must NOT
          // fire Start Co-op again (was: die → SESSION_START → die → loop).
          if (localDead) {
            if (typeof self.resetNativeCoopRun === "function") {
              self.resetNativeCoopRun({ localOnly: true });
            }
            return true;
          }
          // Admin mid-match Reset / Play-again while still alive → shared restart
          if (me && me.isAdmin && typeof self.startMatchAsAdmin === "function") {
            try {
              self.startMatchAsAdmin();
            } catch (eStart) {
              console.warn("native reset startMatchAsAdmin", eStart);
              if (typeof self.resetNativeCoopRun === "function") {
                self.resetNativeCoopRun({});
              }
            }
            return true;
          }
          // Non-admin: wipe local chrome; shared reseat arrives via SESSION_START
          if (typeof self.resetNativeCoopRun === "function") {
            self.resetNativeCoopRun({ localOnly: true });
          }
          return true;
        }
        return false;
      };
      window.__mpCoopOnFriendlyDeath =
        this._coopAuthority === "native-relay-v1"
          ? function (bodySnap) {
              self._onCoopFriendlyDeath(bodySnap);
            }
          : null;
      window.__mpCoopSeatOnPlayLive = function () {
        try {
          if (self._coopAuthority === "server-sim-v1") {
            return self.ensureCoopServerAuthBoard();
          }
          self.paintCoopSeatsFromSlots({ lock: false });
          if (self._coopSessionActive) {
            return self.trySeatCoopOnce(!!opts.spectator);
          }
          return !!window.__mpCoopVisualSeated;
        } catch (eLive) {
          return false;
        }
      };
    }
    this.startCoopIdleSync();
    const Binder = typeof window !== "undefined" && window.CoopBinder;
    if (
      this._coopAuthority === "server-sim-v1" &&
      Binder &&
      Binder.installCoopInputCapture
    ) {
      Binder.installCoopInputCapture(function (dir) {
        if (self.client && self.client.sendCoopInput) {
          self.client.sendCoopInput(dir);
        }
      });
    }
    try {
      const gDie = Gsm.gameInstance && Gsm.gameInstance();
      if (gDie && Gsm.installCoopDieGuard) Gsm.installCoopDieGuard(gDie);
      else if (gDie && Gsm.installFocusDieGuard) Gsm.installFocusDieGuard(gDie);
    } catch (eDie) { /* ignore */ }
    let savedState = null;
    let savedMyId = null;
    if (typeof window !== "undefined") {
      savedState = window.__mpCoopLastState;
      savedMyId = window.__mpCoopLastStateMyId;
    }
    if (
      this._coopAuthority === "server-sim-v1" &&
      Gsm.resetCoopBoardForNewSession
    ) {
      try {
        Gsm.resetCoopBoardForNewSession();
      } catch (eRst) { /* ignore */ }
    }
    if (savedState && !savedState.ended && typeof window !== "undefined") {
      window.__mpCoopLastState = savedState;
      window.__mpCoopLastStateMyId =
        savedMyId || (self.client && self.client.clientId);
    }
    const bindGen = (this._coopBindGen = (this._coopBindGen | 0) + 1);
    function bindBoard() {
      if (bindGen !== self._coopBindGen) return;
      try {
        self.ensureCoopServerAuthBoard();
      } catch (eBind) {
        console.warn("ensureCoopServerAuthBoard", eBind);
      }
    }
    if (this._coopAuthority === "server-sim-v1") bindBoard();
    if (
      this._coopAuthority === "server-sim-v1" &&
      typeof setTimeout === "function"
    ) {
      setTimeout(bindBoard, 0);
      setTimeout(bindBoard, 50);
      setTimeout(bindBoard, 150);
      setTimeout(bindBoard, 300);
      setTimeout(bindBoard, 600);
    }
    try {
      if (typeof window !== "undefined" && window.timeKeeper) {
        window.timeKeeper.playing = false;
        window.timeKeeper._lastTimeMs = 0;
        if (typeof window.timeKeeper.lastAppleTime === "number") {
          window.timeKeeper.lastAppleTime = 0;
        }
      }
      if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
      else if (typeof window !== "undefined") window.pauseGame = 0;
      if (typeof window !== "undefined") {
        window.__mpCoopSeatLocked = false;
        window.__mpCoopAppliedSeq = null;
        window.__mpCoopLocalMotion = null;
      }
    } catch (eTk) { /* ignore */ }
    try {
      const me = self.client && self.client.me && self.client.me();
      if (me && me.colorId != null && Gsm.applySnakeColor) {
        const claimed = Number(me.colorId);
        Gsm.applySnakeColor(claimed);
        self._lastAppliedColorId = claimed;
        if (self.coopNative) self.coopNative.myColorId = claimed;
      }
    } catch (eCol) { /* ignore */ }
    if (this._coopAuthority === "native-relay-v1") {
      this.installCoopRelayInputGate();
      this.trySeatCoopOnce(!!opts.spectator);
      this.publishInitialCoopBoard();
    }
    this.startCoopNativeLoop();
  };

  /**
   * Server-auth co-op: force local seat + peer SVGs from COOP_STATE / SESSION_START
   * slots. Safe to call repeatedly — Start match must never leave default native
   * spawn or empty remotes. Returns true only when local head matches STATE/slot.
   */
  MultiplayerApp.prototype.ensureCoopServerAuthBoard = function () {
    if (this._coopAuthority !== "server-sim-v1") {
      return false;
    }
    this._coopServerAuth = true;

    if (this.coopNative) {
      this.coopNative.sessionActive = true;
      this.coopNative.injectEnabled = true;
      this.coopNative.myClientId = this.client && this.client.clientId;
      this.coopNative.syncBridge();
    } else if (typeof window !== "undefined") {
      window.__mpCoopSession = true;
      window.__mpCoopInject = true;
      window.__mpCoopMyId = this.client && this.client.clientId;
    }

    const myId = this.client && this.client.clientId;
    const Binder = typeof window !== "undefined" && window.CoopBinder;
    let state =
      (typeof window !== "undefined" && window.__mpCoopLastState) || null;
    if (state && state.ended) state = null;

    let applied = null;
    if (state && Binder && Binder.applyCoopState) {
      try {
        applied = Binder.applyCoopState(state, myId);
      } catch (eApply) {
        console.warn("ensureCoopServerAuthBoard apply", eApply);
      }
    }

    // Fill any missing peers from SESSION_START slots (frame-1 SVG)
    try {
      this.seedCoopRemotesFromSlots({ fillMissingOnly: true });
    } catch (eSeed) {
      console.warn("ensureCoopServerAuthBoard seed", eSeed);
    }

    // Merge peers into CoopNative (preserves motion) — never clobber remotes map
    this._syncCoopRemotesFromState(state, myId);

    let expectedHead = null;
    if (state && Array.isArray(state.snakes)) {
      for (let si = 0; si < state.snakes.length; si++) {
        const sn = state.snakes[si];
        if (sn && sn.clientId === myId && sn.body && sn.body[0]) {
          expectedHead = {
            x: sn.body[0].x | 0,
            y: sn.body[0].y | 0,
            dir: sn.dir || "RIGHT",
          };
          break;
        }
      }
    }

    // Always (re)seat local when GameInstance exists — Play may have clobbered ka
    try {
      const g = Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa) {
        if (!expectedHead) {
          const seat = this._myCoopSlot();
          if (seat) {
            const pose =
              seat.x != null && seat.y != null
                ? {
                    x: Number(seat.x),
                    y: Number(seat.y),
                    dir: seat.dir || "RIGHT",
                  }
                : this._coopSpawnPoseFor(
                    seat.slot != null ? Number(seat.slot) | 0 : 0,
                    seat.oy
                  );
            expectedHead = {
              x: pose.x | 0,
              y: pose.y | 0,
              dir: pose.dir || "RIGHT",
            };
            if (!(applied && applied.local)) {
              const body = Gsm.coopSpawnBodyFromPose
                ? Gsm.coopSpawnBodyFromPose(pose)
                : this._coopSpawnBody(seat.oy);
              if (Gsm.writeNativeBody) Gsm.writeNativeBody(g.oa, body);
            }
          }
        }
        try {
          g.nj = false;
          if (g.dead != null) g.dead = false;
          if (typeof window !== "undefined" && window.timeKeeper) {
            window.timeKeeper._dead = false;
          }
          if (expectedHead) {
            const nd = expectedHead.dir || "RIGHT";
            if (g.oa.direction != null) g.oa.direction = nd;
            if (g.oa.dir != null) g.oa.dir = nd;
          }
        } catch (eLive) { /* ignore */ }
      }
    } catch (eLocal) {
      console.warn("ensureCoopServerAuthBoard local seat", eLocal);
    }

    const g2 = Gsm.gameInstance && Gsm.gameInstance();
    const head =
      g2 && g2.oa && Array.isArray(g2.oa.ka) && g2.oa.ka[0] ? g2.oa.ka[0] : null;
    const headMatch =
      !!(
        expectedHead &&
        head &&
        (head.x | 0) === (expectedHead.x | 0) &&
        (head.y | 0) === (expectedHead.y | 0)
      );
    // If STATE wrote body but head drifted (Play clobber), force rewrite once more
    if (expectedHead && g2 && g2.oa && !headMatch && Gsm.writeNativeBody) {
      try {
        const body =
          state &&
          Array.isArray(state.snakes) &&
          (function () {
            for (let i = 0; i < state.snakes.length; i++) {
              if (state.snakes[i] && state.snakes[i].clientId === myId) {
                return state.snakes[i].body;
              }
            }
            return null;
          })();
        if (body && body.length) {
          Gsm.writeNativeBody(g2.oa, body);
        } else {
          const pose = {
            x: expectedHead.x,
            y: expectedHead.y,
            dir: expectedHead.dir,
          };
          const spawnBody = Gsm.coopSpawnBodyFromPose
            ? Gsm.coopSpawnBodyFromPose(pose)
            : [
                { x: pose.x, y: pose.y },
                { x: pose.x - 1, y: pose.y },
                { x: pose.x - 2, y: pose.y },
              ];
          Gsm.writeNativeBody(g2.oa, spawnBody);
        }
      } catch (eForce) { /* ignore */ }
    }
    const head2 =
      g2 && g2.oa && Array.isArray(g2.oa.ka) && g2.oa.ka[0] ? g2.oa.ka[0] : null;
    const localOk = !!(
      expectedHead &&
      head2 &&
      (head2.x | 0) === (expectedHead.x | 0) &&
      (head2.y | 0) === (expectedHead.y | 0) &&
      g2.oa.ka.length >= 2
    );

    const remotes =
      (typeof window !== "undefined" && window.__mpCoopRemotes) || {};
    const slots = this._coopSlots || [];
    let peerSlots = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].clientId && slots[i].clientId !== myId) {
        peerSlots++;
      }
    }
    const peerRemotes = Object.keys(remotes).filter(function (id) {
      return id !== myId;
    }).length;
    const remotesOk = peerSlots === 0 || peerRemotes >= peerSlots;

    // Re-apply claimed color after Play / seat (native menu often resets)
    try {
      const me = this.client && this.client.me && this.client.me();
      if (me && me.colorId != null && Gsm.applySnakeColor) {
        const claimed = Number(me.colorId);
        if (this._lastAppliedColorId !== claimed || localOk) {
          const localIdx = Gsm.readSettingIndex
            ? Gsm.readSettingIndex("color")
            : null;
          if (localIdx == null || Number(localIdx) !== claimed) {
            Gsm.applySnakeColor(claimed);
          }
          this._lastAppliedColorId = claimed;
          if (this.coopNative) this.coopNative.myColorId = claimed;
        }
      }
    } catch (eColor) { /* ignore */ }

    // Seat lock: only mark applied when local head matches authority
    if (localOk) {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      if (typeof window !== "undefined") {
        window.__mpCoopSeatLocked = true;
      }
      if (this.coopSession && this.coopSession.markSeated) {
        try {
          this.coopSession.markSeated();
        } catch (eSeat) { /* ignore */ }
      }
    } else {
      this._coopSpawnApplied = false;
      if (typeof window !== "undefined") {
        window.__mpCoopSeatLocked = false;
      }
    }

    return localOk && remotesOk;
  };

  /**
   * Push STATE peer bodies into CoopNative via applySnakeDelta so motion/lerp
   * survives. Does not replace the remotes map wholesale.
   */
  MultiplayerApp.prototype._syncCoopRemotesFromState = function (state, myId) {
    if (!this.coopNative || !state || !Array.isArray(state.snakes)) return;
    const seen = Object.create(null);
    const intervalMs =
      state.intervalMs != null ? Number(state.intervalMs) : null;
    for (let i = 0; i < state.snakes.length; i++) {
      const s = state.snakes[i];
      if (!s || !s.clientId || s.clientId === myId) continue;
      seen[s.clientId] = true;
      try {
        const payload = {
          clientId: s.clientId,
          body: s.body || [],
          dir: s.dir || "RIGHT",
          alive: s.alive !== false,
          colorId: s.colorId,
          score: s.score | 0,
          _fromState: true,
        };
        if (intervalMs > 0) payload._lerpStepMs = intervalMs;
        this.coopNative.applySnakeDelta(payload);
      } catch (eD) {
        console.warn("_syncCoopRemotesFromState", eD);
      }
    }
    // Drop peers no longer in STATE
    try {
      const remotes = this.coopNative.remotes || {};
      const ids = Object.keys(remotes);
      for (let j = 0; j < ids.length; j++) {
        if (!seen[ids[j]]) delete remotes[ids[j]];
      }
      this.coopNative.syncBridge();
    } catch (ePrune) { /* ignore */ }
  };

  /**
   * Visual-only seat/seed from SESSION_START slots. Paints peers + local body
   * as soon as a body host exists. Does not hard-lock unless opts.lock.
   * Hard lock remains trySeatCoopOnce after live Play.
   * @param {{lock?:boolean}} [opts]
   */
  MultiplayerApp.prototype.paintCoopSeatsFromSlots = function (opts) {
    opts = opts || {};
    if (!this._coopSlots || !this._coopSlots.length) return false;
    this.seedCoopRemotesFromSlots();
    let wroteLocal = false;
    try {
      const g = Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa && typeof this._applyMyCoopSpawn === "function") {
        wroteLocal = !!this._applyMyCoopSpawn();
      }
    } catch (ePaint) { /* ignore */ }
    if (typeof window !== "undefined") {
      window.__mpCoopVisualSeated = true;
    }
    if (opts.lock === true) {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      if (this.coopSession && this.coopSession.markSeated) {
        this.coopSession.markSeated();
      }
      if (typeof window !== "undefined") {
        window.__mpCoopSeatLocked = true;
      }
    }
    const remotes = this.coopNative && this.coopNative.remotes;
    return wroteLocal || !!(remotes && Object.keys(remotes).length);
  };

  /**
   * One-shot co-op seat. Returns true when the local body is locked in place
   * (or parked for spectators). Safe to call again; no-ops once seated.
   */
  MultiplayerApp.prototype.trySeatCoopOnce = function (spectator) {
    if (!this._coopSessionActive) return false;
    // Server-auth: always (re)bind STATE seats + peer SVGs
    if (
      this._coopServerAuth ||
      (typeof window !== "undefined" && window.__mpCoopServerAuth)
    ) {
      return this.ensureCoopServerAuthBoard();
    }
    if (this._coopSpawnApplied) return true;
    if (spectator || (typeof window !== "undefined" && window.__mpCoopSpectator)) {
      this.applyCoopSpawnOrPark(true);
      this.seedCoopRemotesFromSlots();
      return true;
    }
    if (!this._myCoopSlot()) {
      return false;
    }
    const live = Gsm.isNativeRunLive ? Gsm.isNativeRunLive() : false;
    const g = Gsm.gameInstance && Gsm.gameInstance();
    if (!live || !g || !g.oa) return false;

    this.applyCoopSpawnOrPark(false);
    this.seedCoopRemotesFromSlots();
    // Re-apply claimed color after Play — native often resets the #color row
    try {
      const me = this.client && this.client.me && this.client.me();
      if (me && me.colorId != null && Gsm.applySnakeColor) {
        const claimed = Number(me.colorId);
        Gsm.applySnakeColor(claimed);
        this._lastAppliedColorId = claimed;
        if (this.coopNative) this.coopNative.myColorId = claimed;
      }
    } catch (eCol) { /* ignore */ }
    if (this._bodyMatchesSpawnOy()) {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      if (this.coopSession) this.coopSession.markSeated();
      this.publishCoopState({ forceColors: true, seated: true });
      this.publishCoopCollectables(true);
      return true;
    }
    // Wrote a seat but native may still settle — tick reassert finishes the lock
    return false;
  };

  MultiplayerApp.prototype._myCoopSlotIndex = function () {
    const slot = this._myCoopSlot();
    if (!slot) return null;
    return slot.slot != null ? Number(slot.slot) | 0 : null;
  };

  /** Server SESSION_START seat for this client (source of truth). */
  MultiplayerApp.prototype._myCoopSlot = function () {
    const myId = this.client && this.client.clientId;
    if (!myId) return null;
    const slots = this._coopSlots || [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].clientId === myId) {
        const s = Object.assign({}, slots[i]);
        if (s.slot == null) s.slot = i;
        return s;
      }
    }
    return null;
  };

  MultiplayerApp.prototype._coopSpawnPoseFor = function (slotIndex, oy, width, height) {
    const w = width || 17;
    const h = height || 15;
    if (Gsm.coopSpawnPoseForSlot) {
      return Gsm.coopSpawnPoseForSlot(slotIndex, oy, w, h);
    }
    if (Gsm.coopIsYinYang && Gsm.coopIsYinYang()) {
      return Gsm.coopYinYangCorner
        ? Gsm.coopYinYangCorner(slotIndex, w, h)
        : { x: 2, y: 1, dir: "RIGHT" };
    }
    const clamped =
      Gsm.clampCoopSpawnOy != null
        ? Gsm.clampCoopSpawnOy(oy, h)
        : Number(oy) || 0;
    return {
      x: Math.floor(w / 2),
      y: Math.floor(h / 2) + clamped,
      dir: "RIGHT",
    };
  };

  MultiplayerApp.prototype._applyMyCoopSpawn = function () {
    const seat = this._myCoopSlot();
    if (!seat) return false;
    const slot = seat.slot != null ? Number(seat.slot) | 0 : null;
    const oy =
      seat.oy != null
        ? Number(seat.oy)
        : this._myCoopSpawnOy();
    if (slot == null) return false;
    if (
      oy == null &&
      !(Number.isFinite(Number(seat.x)) && Number.isFinite(Number(seat.y)))
    ) {
      return false;
    }
    // Server seat is authoritative — pass absolute x/y when present.
    if (Gsm.applyCoopSpawnOffset) {
      const ok = Gsm.applyCoopSpawnOffset(oy, {
        slot: slot,
        x: seat.x,
        y: seat.y,
        dir: seat.dir,
        boardWidth: seat.boardWidth,
        boardHeight: seat.boardHeight,
      });
      if (
        typeof window !== "undefined" &&
        window.__mpLastCoopSpawnPose
      ) {
        this._coopSpawnPose = window.__mpLastCoopSpawnPose;
      }
      return ok;
    }
    const pose = this._coopSpawnPoseFor(slot, oy);
    this._coopSpawnPose = pose;
    return false;
  };

  MultiplayerApp.prototype._myCoopSpawnOy = function () {
    if (this._coopSpawnOy != null) return this._coopSpawnOy;
    const seat = this._myCoopSlot();
    if (seat && seat.oy != null) {
      this._coopSpawnOy = Number(seat.oy);
      return this._coopSpawnOy;
    }
    // No local invent — wait for SESSION_START slots from the server
    return null;
  };

  MultiplayerApp.prototype._bodyMatchesSpawnOy = function () {
    if (this._myCoopSlotIndex() == null) return false;
    const g = Gsm.gameInstance && Gsm.gameInstance();
    const body = g && g.oa && g.oa.ka;
    if (!body || !body.length) return false;
    // Player already moved — stop reasserting (NONE is idle, not engaged)
    if (this._coopPlayerMoved) {
      const crawl = Gsm.coopSnakeHasCrawlFacing
        ? Gsm.coopSnakeHasCrawlFacing(g.oa)
        : (function () {
            const d = g.oa.direction || g.oa.dir;
            return !!(d && d !== "NONE" && d !== "none");
          })();
      if (crawl) return true;
    }
    const expected = this._coopSpawnPose
      ? Gsm.coopSpawnBodyFromPose
        ? Gsm.coopSpawnBodyFromPose(this._coopSpawnPose)
        : null
      : null;
    const fallback =
      expected ||
      (this._myCoopSpawnOy() != null
        ? this._coopSpawnBody(this._myCoopSpawnOy())
        : null);
    if (!fallback || !fallback[0]) return false;
    const head = body[0];
    return (
      head &&
      Number(head.x) === fallback[0].x &&
      Number(head.y) === fallback[0].y
    );
  };

  MultiplayerApp.prototype._reassertCoopSpawnIfNeeded = function () {
    if (
      this._coopServerAuth ||
      (typeof window !== "undefined" && window.__mpCoopServerAuth)
    ) {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      return;
    }
    if (this._coopSpawnApplied) return;
    if (typeof window !== "undefined" && window.__mpCoopSpectator) return;
    const g = Gsm.gameInstance && Gsm.gameInstance();
    if (!g || !g.oa) return;
    // Native idle is direction==="NONE" (truthy string). Only real crawl dirs
    // mean the player engaged — never treat leftover Play facing as moved.
    const crawl =
      Gsm.coopSnakeHasCrawlFacing
        ? Gsm.coopSnakeHasCrawlFacing(g.oa)
        : (function () {
            const d = g.oa.direction || g.oa.dir;
            return !!(d && d !== "NONE" && d !== "none");
          })();
    if (crawl && this._coopPlayerMoved) {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      return;
    }
    if (!this._bodyMatchesSpawnOy()) {
      this._applyMyCoopSpawn();
    } else {
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
    }
  };

  /**
   * Build a length-3 idle body at the spawn pose (center+oy, or a Yin Yang corner).
   */
  MultiplayerApp.prototype._coopSpawnBody = function (oy, width, height, slotIndex) {
    const w = width || 17;
    const h = height || 15;
    // Prefer the wall-adjusted seat we actually wrote into the engine
    const pose =
      this._coopSpawnPose ||
      this._coopSpawnPoseFor(
        slotIndex != null ? slotIndex : this._myCoopSlotIndex(),
        oy,
        w,
        h
      );
    if (Gsm.coopSpawnBodyFromPose) return Gsm.coopSpawnBodyFromPose(pose);
    const cx = pose.x;
    const cy = pose.y;
    if (pose.dir === "LEFT") {
      return [
        { x: cx, y: cy },
        { x: cx + 1, y: cy },
        { x: cx + 2, y: cy },
      ];
    }
    return [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];
  };

  /**
   * Put every co-op player into __mpCoopRemotes at their SESSION_START slot with
   * roster colors — so each client sees all snakes natively from frame 1.
   * @param {{fillMissingOnly?:boolean}} [opts]
   */
  MultiplayerApp.prototype.seedCoopRemotesFromSlots = function (opts) {
    opts = opts || {};
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
    const myId = this.client.clientId;
    if (!this.coopNative.remotes) this.coopNative.remotes = {};

    // Prefer LIVE bake dims so peer seats match the board we actually drew.
    try {
      const live =
        Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g);
      if (live && live.width > 0 && live.height > 0) {
        w = live.width | 0;
        h = live.height | 0;
      } else if (typeof window !== "undefined" && window.__mpCoopLastState) {
        const st = window.__mpCoopLastState;
        if (st.width > 0) w = st.width | 0;
        if (st.height > 0) h = st.height | 0;
      } else if (slots[0] && slots[0].boardWidth > 0) {
        w = slots[0].boardWidth | 0;
        h = (slots[0].boardHeight | 0) || h;
      }
    } catch (eLive) { /* defaults */ }

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot || !slot.clientId) continue;
      // Local snake is native-drawn — remotes are peers only
      if (slot.clientId === myId) continue;
      const existing =
        this.coopNative.remotes[slot.clientId] ||
        (typeof window !== "undefined" &&
          window.__mpCoopRemotes &&
          window.__mpCoopRemotes[slot.clientId]);
      if (
        existing &&
        existing.body &&
        existing.body.length &&
        (opts.fillMissingOnly || existing._fromDelta || existing._fromState)
      ) {
        continue;
      }
      const peer = clients.find(function (c) {
        return c.clientId === slot.clientId;
      });
      const colorId =
        slot.colorId != null
          ? slot.colorId
          : peer && peer.colorId != null
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
      let preferred = null;
      const sx = slot.x != null ? Number(slot.x) : NaN;
      const sy = slot.y != null ? Number(slot.y) : NaN;
      const slotW =
        slot.boardWidth != null ? Number(slot.boardWidth) : null;
      const slotH =
        slot.boardHeight != null ? Number(slot.boardHeight) : null;
      const slotDimsMatch =
        slotW == null ||
        slotH == null ||
        ((slotW | 0) === (w | 0) && (slotH | 0) === (h | 0));
      if (
        slotDimsMatch &&
        Number.isFinite(sx) &&
        Number.isFinite(sy) &&
        sx >= 0 &&
        sy >= 0 &&
        sx < w &&
        sy < h
      ) {
        preferred = {
          x: Math.round(sx),
          y: Math.round(sy),
          dir: slot.dir || "RIGHT",
        };
      } else {
        preferred = this._coopSpawnPoseFor(
          slot.slot != null ? Number(slot.slot) | 0 : i,
          slot.oy,
          w,
          h
        );
      }
      const body = Gsm.coopSpawnBodyFromPose
        ? Gsm.coopSpawnBodyFromPose(preferred)
        : this._coopSpawnBody(slot.oy, w, h, i);
      this.coopNative.applySnakeDelta({
        clientId: slot.clientId,
        body: body,
        dir: preferred && preferred.dir ? preferred.dir : "RIGHT",
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
      // Park off-board — clearing ka makes PlayerRenderer throw yi NaN×4
      if (Gsm.parkLocalSnakeOffBoard) Gsm.parkLocalSnakeOffBoard();
      else if (Gsm.emptyLocalSnakeBody) Gsm.emptyLocalSnakeBody();
      if (typeof window !== "undefined") {
        window.__mpCoopSpectator = true;
        window.__mpCoopLocalDead = true;
      }
      if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
      this._coopSpawnApplied = true;
      this._coopSeatedPublish = true;
      return;
    }
    this._applyMyCoopSpawn();
    // Lock happens in trySeatCoopOnce / _reassertCoopSpawnIfNeeded when the body matches
  };

  /**
   * Full native co-op wipe: board, timer, scores, remotes, endscreen.
   * Used by SESSION_START and native-relay Reset so leftovers never stick.
   */
  MultiplayerApp.prototype.resetNativeCoopRun = function (opts) {
    opts = opts || {};
    if (Gsm.stopCoopRunTimer) {
      try {
        Gsm.stopCoopRunTimer();
      } catch (eStop) { /* ignore */ }
    }
    this._coopTimerArmed = false;
    this._coopTimerStartedAtMs = null;
    this._coopFinalTimeMs = null;
    this._coopScores = {};
    this._coopTotal = 0;
    this._coopDeadSent = false;
    this._coopWon = false;
    this._coopEndReason = null;
    this._coopMatchEndHandled = false;
    this._coopColsFp = null;
    this._coopLastWalls = null;
    this._coopLastWallCount = null;
    this._coopEntityFp = null;
    this._coopWallGrowArmed = false;
    if (!opts.keepSeatingFlags) {
      this._coopSpawnApplied = false;
      this._coopSeatedPublish = false;
      this._coopPlayerMoved = false;
      this._coopBoardInitRequested = false;
    }
    if (typeof window !== "undefined") {
      window.__mpCoopLocalDead = false;
      window.__mpCoopSkipFruitReapply = false;
      window.__mpCoopBoardFull = false;
      window.__mpCoopLastState = null;
      window.__mpCoopLastStateMyId = null;
      window.__mpCoopLastStateSeq = -1;
      window.__mpCoopAuthReapplyScheduled = false;
      window.__mpCoopRemotes = Object.create(null);
      window.__mpCoopFruitHardReset = true;
      window.__mpCoopFruitFp = null;
      window.__mpCoopAppliedSeq = null;
    }
    if (this.coopNative && this.coopNative.reset) {
      try {
        this.coopNative.reset();
      } catch (eNat) { /* ignore */ }
    }
    if (Gsm.resetCoopBoardForNewSession) {
      try {
        Gsm.resetCoopBoardForNewSession();
      } catch (eReset) {
        console.warn("resetNativeCoopRun board", eReset);
      }
    }
    if (Gsm.hideDeathScreen) {
      try {
        Gsm.hideDeathScreen();
      } catch (eHide) { /* ignore */ }
    }
    if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
    return true;
  };

  MultiplayerApp.prototype.endCoopNativeSession = function (opts) {
    opts = opts || {};
    this._coopSessionGen = (this._coopSessionGen | 0) + 1;
    this._coopSessionActive = false;
    if (this.coopSession) {
      this.coopSession.enterEnding();
      this.coopSession.enterLobby();
    }
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
    this._coopLastWalls = null;
    this._coopLastWallCount = null;
    this._coopEntityFp = null;
    this._coopServerAuth = false;
    this._coopAuthority = null;
    if (this.coop && this.coop.reset) this.coop.reset();
    if (Mp && Mp.endCoopSessionFlags) {
      Mp.endCoopSessionFlags();
    }
    if (typeof window !== "undefined") {
      window.__mpCoopLocalDead = false;
      window.__mpCoopInject = false;
      window.__mpCoopSession = false;
      window.__mpCoopSpectator = false;
      window.__mpCoopServerAuth = false;
      window.__mpCoopPlaySettings = null;
      if (typeof this.installNativeTickNetPublish === "function") {
        this.installNativeTickNetPublish();
      } else {
        window.__mpCoopAfterTick = null;
      }
      window.__mpCoopFlushPendingDeltas = null;
      window.__mpCoopOnFriendlyDeath = null;
      window.__mpCoopOnBoardFull = null;
      window.__mpCoopOnLocalReset = null;
      window.__mpCoopSeatOnPlayLive = null;
      window.__mpLastCoopSpawnPose = null;
      window.__mpCoopVisualSeated = false;
      window.__mpCoopBoardFull = false;
      window.__mpCoopPlayerRenderer = null;
      window.__mpCoopRenderArgs = null;
      window.__mpCoopRenderParked = false;
      window.__mpCoopLastTickAt = 0;
      window.__mpCoopLastState = null;
      window.__mpCoopAuthReapplyScheduled = false;
      if (window.__mpCoopStopCorpsePaint) window.__mpCoopStopCorpsePaint();
    }
    // Drop leftover fruit/mouth so the next Start is not stuck biting
    if (Gsm.resetCoopBoardForNewSession) {
      try {
        Gsm.resetCoopBoardForNewSession(null, {
          suppressHideDeath: !!opts.suppressHideDeath,
        });
      } catch (eWipe) { /* ignore */ }
    }
    this._pendingCoopSnakeDeltas = null;
    this.removeCoopRelayInputGate();
    this.stopCoopIdleSync();
    this._stopCoopHudTick();
    this.stopCoopNativeLoop();
    // Match-end path: do not restore mid-match hideDeathScreen styles —
    // that re-applies visibility:hidden before quitNativeRunForMenus.
    if (!opts.suppressHideDeath && Gsm.restoreDeathScreen) {
      Gsm.restoreDeathScreen();
    }
    if (this.coopNative) this.coopNative.reset();
  };

  /** Is the local engine ticking? Idle spawns and spectators are not. */
  MultiplayerApp.prototype.coopTicksRunning = function () {
    if (typeof window === "undefined") return false;
    if (typeof window.__mpCoopTicksRunning !== "function") return false;
    try {
      return !!window.__mpCoopTicksRunning();
    } catch (e) {
      return false;
    }
  };

  /**
   * Keep the shared board live for a player whose engine is not ticking: still
   * waiting on their first key, or spectating. Also finishes a one-shot seat if
   * begin ran before the slot/engine was ready (no poll loop).
   */
  MultiplayerApp.prototype.coopIdleSyncStep = function () {
    if (!this._coopSessionActive) return false;
    if (typeof window === "undefined") return false;
    let did = false;
    const serverAuth =
      this._coopServerAuth || !!window.__mpCoopServerAuth;
    // Seat lock: keep ensuring until local head matches STATE
    if (!this._coopSpawnApplied || (serverAuth && !this.coopTicksRunning())) {
      try {
        if (this.ensureCoopServerAuthBoard()) did = true;
      } catch (eEns) { /* ignore */ }
      if (serverAuth && !this.coopTicksRunning()) return did;
    }
    if (
      !this._coopSpawnApplied &&
      this._coopAuthority === "native-relay-v1"
    ) {
      try {
        const remotes = this.coopNative && this.coopNative.remotes;
        const needSeed = !remotes || !Object.keys(remotes).length;
        if (needSeed || !window.__mpCoopVisualSeated) {
          if (this.paintCoopSeatsFromSlots({ lock: false })) did = true;
        }
      } catch (ePaint) { /* ignore */ }
    }
    if (!this._coopSpawnApplied) {
      did =
        !!this.trySeatCoopOnce(!!window.__mpCoopSpectator) || did;
    }
    if (
      this._coopAuthority === "native-relay-v1" &&
      this._coopSpawnApplied &&
      this._coopBoardInitRequested &&
      this.coop &&
      !this.coop.boardReady
    ) {
      try {
        if (this.publishInitialCoopBoard()) did = true;
      } catch (eBoard) { /* ignore */ }
    }
    if (this.coopTicksRunning()) return did;
    const pending = this._pendingCoopSnakeDeltas;
    if (!pending || !Object.keys(pending).length) return did;
    if (typeof this.flushPendingCoopSnakeDeltas === "function") {
      this.flushPendingCoopSnakeDeltas();
      return true;
    }
    return did;
  };

  MultiplayerApp.prototype.startCoopIdleSync = function () {
    this.stopCoopIdleSync();
    if (typeof setInterval !== "function") return;
    const self = this;
    const timer = setInterval(function () {
      try {
        self.coopIdleSyncStep();
      } catch (e) {
        console.warn("coopIdleSyncStep", e);
      }
    }, COOP_IDLE_SYNC_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    this._coopIdleSyncTimer = timer;
  };

  MultiplayerApp.prototype.stopCoopIdleSync = function () {
    if (this._coopIdleSyncTimer) {
      clearInterval(this._coopIdleSyncTimer);
      this._coopIdleSyncTimer = null;
    }
  };

  MultiplayerApp.prototype.commitCoopRelayResync = function () {
    if (
      this._coopAuthority !== "native-relay-v1" ||
      !this.coop ||
      !this.coop.resyncing
    ) return false;
    const replay = this.coop.commitResync();
    if (!replay) return false;

    this._coopAuthority = this.coop.authority;
    this._coopServerAuth = false;
    this._coopSessionGen = this.coop.generation;
    this._coopSlots = this.coop.slots.slice();
    this._coopSpawnOy = null;
    if (this.coopSession) {
      this.coopSession.bindGeneration(
        this.coop.generation,
        this.coop.authority,
        this.coop.boardReady
      );
    }
    if (this.coopNative) {
      // Replace peer caches only now; the old map stayed visible during replay.
      this.coopNative.remotes = Object.create(null);
      this.coopNative.peerPoseSeq = Object.create(null);
      this.coopNative.generation = this.coop.generation;
      this.coopNative.collectablesOwnerId = this.coop.collectablesOwnerId;
      if (replay.board) {
        this.coopNative.applyCollectables(replay.board);
      }
      const myId = this.client && this.client.clientId;
      for (let i = 0; i < replay.poses.length; i++) {
        const pose = replay.poses[i];
        if (!pose || pose.clientId === myId) continue;
        this.coopNative.applySnakeDelta(pose);
      }
      this.coopNative.syncBridge();
    }
    if (replay.board && Gsm.applyCollectables) {
      Gsm.applyCollectables(replay.board);
    }
    if (this.coopSession && this.coop.boardReady) {
      this.coopSession.markBoardReady(this.coop.boardRevision);
    }
    if (replay.timer) {
      this.armCoopRunTimer(replay.timer.timerStartedAtMs);
    }
    if (typeof window !== "undefined") {
      window.__mpCoopSpeedEpoch = this.coop.speedEpoch;
      window.__mpCoopEffectiveSpeed = this.coop.speedState;
    }
    if (Mp && Mp.setCoopAuthority) {
      Mp.setCoopAuthority(
        this.coop.authority,
        this.coop.generation,
        this.coop.boardReady
      );
    }
    if (typeof this.refreshCoopScores === "function") {
      this.refreshCoopScores();
    }
    return true;
  };

  MultiplayerApp.prototype.onCoopState = function (state) {
    if (!state) return;
    if (this._coopAuthority !== "server-sim-v1") return;
    // Authoritative match end — same teardown as SESSION_END (idempotent).
    // Mid-match deaths stay on the live board (corpse); only ended tears down.
    if (state.ended) {
      if (typeof window !== "undefined") {
        window.__mpCoopLastState = state;
      }
      if (this._coopSessionActive || (this.client && this.client.roster && this.client.roster.sessionActive)) {
        this._handleCoopMatchEnded(state.endReason || state.end_reason || "ENDED");
      }
      return;
    }
    const rosterLive =
      this.client &&
      this.client.roster &&
      this.client.roster.sessionActive;
    if (
      !this._coopSessionActive &&
      !rosterLive &&
      !(typeof window !== "undefined" && window.__mpStartingMatch)
    ) {
      return;
    }
    this._coopSessionActive = true;
    const myId = this.client && this.client.clientId;
    const Binder = typeof window !== "undefined" && window.CoopBinder;
    if (Binder && Binder.applyCoopState) {
      Binder.applyCoopState(state, myId);
    }
    // Sync remotes via applySnakeDelta (preserve lerp) — never assign fresh map
    this._syncCoopRemotesFromState(state, myId);
    if (this.coopNative) {
      this.coopNative.sessionActive = true;
      this.coopNative.injectEnabled = true;
      this.coopNative.myClientId = myId;
      this.coopNative.syncBridge();
    }
    try {
      this.ensureCoopServerAuthBoard();
    } catch (eEns) { /* ignore */ }
    // Combined score from STATE
    let total = state.score | 0;
    if (Array.isArray(state.snakes)) {
      this._coopScores = this._coopScores || {};
      for (let i = 0; i < state.snakes.length; i++) {
        const s = state.snakes[i];
        if (!s || !s.clientId) continue;
        this._coopScores[s.clientId] = {
          score: s.score | 0,
          alive: s.alive !== false,
        };
      }
    }
    this._coopTotal = total;
    if (typeof this.refreshCoopScores === "function") {
      try {
        this.refreshCoopScores();
      } catch (e) { /* ignore */ }
    }
    if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
  };

  /**
   * Tear down a co-op match from COOP_STATE.ended or SESSION_END.
   * Idempotent — safe if both fire.
   */
  MultiplayerApp.prototype._handleCoopMatchEnded = function (reason) {
    if (this._coopMatchEndHandled) return;
    this._coopMatchEndHandled = true;
    this._log("COOP_MATCH_END", reason);
    this._matchPlayGen = (this._matchPlayGen | 0) + 1;
    this._coopBindGen = (this._coopBindGen | 0) + 1;
    if (typeof window !== "undefined") {
      window.__mpStartNativeRunGen = (window.__mpStartNativeRunGen | 0) + 1;
      window.__mpStartingMatch = false;
      window.__mpCoopMatchEndMenus = true;
    }
    if (this.coopSession) {
      try {
        this.coopSession.enterEnding();
        this.coopSession.enterLobby();
      } catch (eS) { /* ignore */ }
    }
    if (this.client && this.client.roster) {
      this.client.roster.sessionActive = false;
    }
    this._coopSessionActive = false;
    this._coopEndReason = reason || null;
    if (reason === "ALL_APPLES") this._coopWon = true;
    if (
      this._coopFinalTimeMs == null &&
      this._coopTimerStartedAtMs != null &&
      Number.isFinite(Number(this._coopTimerStartedAtMs))
    ) {
      this._coopFinalTimeMs = Math.max(
        0,
        Date.now() - Number(this._coopTimerStartedAtMs)
      );
    }
    if (typeof window !== "undefined") {
      if (typeof this.installNativeTickNetPublish === "function") {
        this.installNativeTickNetPublish();
      } else {
        window.__mpCoopAfterTick = null;
      }
      window.__mpCoopFlushPendingDeltas = null;
      window.__mpCoopSession = false;
      window.__mpCoopInject = false;
      // Mid-match deaths hide the native endscreen so corpses stay visible —
      // undo that so ALL_DEAD / ALL_APPLES can show Play + settings again.
      window.__mpCoopLocalDead = false;
    }
    if (Gsm.stopCoopRunTimer) Gsm.stopCoopRunTimer();
    this._leaveRaceFocusSpectate();
    // Keep `.wjOYOd` visible for match-end menus — board wipe must not re-hide.
    this.endCoopNativeSession({ suppressHideDeath: true });
    if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
    // Allow a fresh post-match menu release even if End match already latched.
    this._adminMenusReleased = false;
    this.returnToMenus({ fromRemote: true, coopMatchEnd: true });
    // Full Escape pulse — chrome-only quit leaves menus non-interactive /
    // overlay half-hidden after mid-match hideDeathScreen.
    if (Gsm.quitNativeRunForMenus) {
      try {
        Gsm.quitNativeRunForMenus({ skipEscapeDispatch: false, pulse: true });
      } catch (eQuit) { /* ignore */ }
    }
    if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
    if (this.updateStatusIndicator) this.updateStatusIndicator();
  };

  MultiplayerApp.prototype.publishCoopState = function (opts) {
    opts = opts || {};
    if (this._coopAuthority !== "native-relay-v1") return;
    if (!this.client || !this.client.connected) return;
    if (!this._coopSessionActive) return;
    if (!this.client.roster || !this.client.roster.sessionActive) return;
    if (!this.client.roster || this.client.roster.mode !== "coop") return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;
    // Refuse pose/death publishes until seating completes
    if (!this._coopSeatedPublish && !opts.seated) {
      return;
    }
    // Corpse already published via COOP_PLAYER_DEAD — further SNAKE_DELTA
    // hits seat_dead on the server and flashes "Error: seat_dead" on peers.
    if (this._coopDeadSent && !opts.forceColors) {
      return;
    }

    const needColors = opts.forceColors || !this._coopColorsSent;
    const scrape =
      Gsm.scrapeCoopSnakeDelta || Gsm.scrapeSnakeDelta;
    const delta = scrape
      ? scrape.call(Gsm, me.colorId, { includeColors: true })
      : null;
    if (!delta) return;

    delta.clientId = this.client.clientId;
    delta._fromDelta = true;
    delta.generation = this.coop.generation;
    delta.eventSeq = this.coopSession.nextEventSeq();
    delta.poseSeq = this.coopSession.nextPoseSeq();
    if (this.coopSession.observeNativePose) {
      this.coopSession.observeNativePose(delta);
    }
    delta.modeKey = Gsm.effectiveModeKey
      ? Gsm.effectiveModeKey()
      : delta.modeKey || "";
    if (opts.seated || this._coopSeatedPublish) {
      delta.seated = true;
    }
    if (this._coopDeadSent && this._coopLastBody) {
      delta.alive = false;
      delta.body = this._coopLastBody;
    } else if (delta.alive === false && !this._coopSeatedPublish) {
      // Sticky nj / warmup death must not report until seated
      if (typeof this._logCoopDeath === "function") {
        this._logCoopDeath("warmup");
      }
      delta.alive = true;
    }
    if (me.colorId != null && needColors) delta.colorId = me.colorId;

    const fp = Gsm.snakeDeltaFingerprint
      ? Gsm.snakeDeltaFingerprint(delta)
      : null;
    delta.moved = this._coopLocalHasMoved(delta);
    // Skip only when idle (same pose, not crawling). While moving, one send per tick.
    if (
      fp &&
      fp === this._coopLastPoseFp &&
      !this._coopDeadSent &&
      !needColors &&
      !delta.moved
    ) {
      return;
    }
    this._coopLastPoseFp = fp;
    if (needColors && (delta.Sc || delta.colorId != null)) {
      this._coopColorsSent = true;
    }
    if (!needColors) {
      [
        "colorId", "color1", "color2", "Sc", "Yc",
        "color1_2", "color2_2", "Sc2", "Yc2",
      ].forEach(function (key) {
        delete delta[key];
      });
    }

    delta.speedEpoch = this.coop.speedEpoch;
    // Prefer live native step length (Fb ≈ 135ms at normal) for peer lerp.
    let stepMs = NaN;
    try {
      const g =
        Gsm.gameInstance && typeof Gsm.gameInstance === "function"
          ? Gsm.gameInstance()
          : null;
      if (g && typeof g.Fb === "number") stepMs = Number(g.Fb);
    } catch (eFb) { /* ignore */ }
    if (
      (!Number.isFinite(stepMs) || stepMs <= 0) &&
      this.coop.speedState &&
      this.coop.speedState.intervalMs != null
    ) {
      stepMs = Number(this.coop.speedState.intervalMs);
    }
    if (Number.isFinite(stepMs) && stepMs > 0) {
      delta.stepIntervalMs = stepMs;
    }

    // The initial seated pose may establish the corpse/seat cache. Movement
    // poses wait for the canonical initial board.
    if (!this.coop.boardReady && delta.moved) {
      this.coopSession.queuePose(delta);
      return;
    }

    // Death on the wire is client-authoritative via COOP_PLAYER_DEAD only.
    // Never send alive:false from a false scrape — peers would show a dead
    // native-peer while this player is still alive.
    if (delta.alive === false && !this._coopDeadSent) {
      const g =
        Gsm.gameInstance && typeof Gsm.gameInstance === "function"
          ? Gsm.gameInstance()
          : null;
      const nativeDead = !!(
        g &&
        (g.nj === true ||
          g.dead === true ||
          g.isDead === true ||
          (g.oa && (g.oa.nj === true || g.oa.dead === true)))
      );
      if (!nativeDead) {
        if (typeof this._logCoopDeath === "function") {
          this._logCoopDeath("scrape_alive_false_ignored");
        }
        delta.alive = true;
      }
    }

    // Do not apply self into remotes — paint skips myId; saves O(n) followBody/GC
    this.client.snakeDelta(delta);
    if (typeof this.refreshCoopScores === "function") this.refreshCoopScores();
    if (delta.alive === false && !this._coopDeadSent) {
      // Confirmed native death — announce so peers sticky-kill this seat.
      const g =
        Gsm.gameInstance && typeof Gsm.gameInstance === "function"
          ? Gsm.gameInstance()
          : null;
      const nativeDead = !!(
        g &&
        (g.nj === true ||
          g.dead === true ||
          g.isDead === true ||
          (g.oa && (g.oa.nj === true || g.oa.dead === true)))
      );
      if (!nativeDead) {
        // Should not reach here after the pre-send guard; belt-and-suspenders.
        this._logCoopDeath("scrape_alive_false_ignored");
        return;
      }
      if (this.coopSession) {
        const marked = this.coopSession.markDead("native_die");
        if (!marked.ok) {
          this._logCoopDeath("warmup", marked.reason);
          return;
        }
      }
      this._logCoopDeath("native_die");
      this._coopDeadSent = true;
      this._coopLastBody = delta.body;
      const deathPayload = {
        generation: this.coop.generation,
        eventSeq: this.coopSession.nextEventSeq(),
        body: delta.body,
        reason: "native",
      };
      if (delta.body2 && delta.body2.length) {
        deathPayload.body2 = delta.body2;
      }
      this.client.coopPlayerDead(deathPayload);
      if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
    }
  };

  /**
   * Peer body collision (native-relay): publish death immediately with the
   * pre-die body snapshot so peers see the corpse / · down without scrape lag.
   * Always announce — killLocalOnRemote already killed the local engine, so
   * skipping the publish (warmup / not seated) leaves idle peers desynced.
   */
  MultiplayerApp.prototype._onCoopFriendlyDeath = function (bodySnap) {
    if (this._coopAuthority !== "native-relay-v1") return;
    if (!this._coopSessionActive || this._coopDeadSent) return;
    if (!this.client || !this.client.connected) return;
    if (this.coopSession) {
      const marked = this.coopSession.markDead("friendly_hit");
      if (!marked.ok) {
        // Local nj is already set — latch death anyway so we still publish.
        this.coopSession.localDead = true;
        this.coopSession.deadSent = true;
        this._logCoopDeath("friendly_hit_forced", marked.reason);
      }
    }
    const body =
      Array.isArray(bodySnap) && bodySnap.length
        ? bodySnap
        : this._coopLastBody || [];
    this._coopLastBody = body.length ? body : this._coopLastBody;
    this._coopDeadSent = true;
    this._logCoopDeath("friendly_hit");
    if (typeof window !== "undefined") window.__mpCoopLocalDead = true;
    // Mirror native_die: clear Ready so death cannot immediately Start again.
    try {
      const me = this.client.me && this.client.me();
      if (me && me.role === "player" && me.ready) {
        me.ready = false;
        if (this.client.setReady) this.client.setReady(false);
        if (typeof this.applyControlLocks === "function") this.applyControlLocks();
      }
    } catch (eReady) { /* ignore */ }
    const deathPayload = {
      generation: this.coop && this.coop.generation,
      eventSeq:
        this.coopSession && this.coopSession.nextEventSeq
          ? this.coopSession.nextEventSeq()
          : Date.now(),
      body: this._coopLastBody || body,
      reason: "friendly",
    };
    if (this.client.coopPlayerDead) {
      this.client.coopPlayerDead(deathPayload);
    }
    if (typeof this.refreshCoopScores === "function") this.refreshCoopScores();
    if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
  };

  /**
   * Apply the latest coalesced peer poses. Called from the native tick hook
   * and idle sync when the engine is not ticking.
   */
  MultiplayerApp.prototype.flushPendingCoopSnakeDeltas = function () {
    const pending = this._pendingCoopSnakeDeltas;
    if (!pending || !this.coopNative) return false;
    this._pendingCoopSnakeDeltas = Object.create(null);
    const ids = Object.keys(pending);
    if (!ids.length) return false;
    for (let i = 0; i < ids.length; i++) {
      try {
        this.coopNative.applySnakeDelta(pending[ids[i]]);
      } catch (e) {
        console.warn("flushPendingCoopSnakeDeltas", e);
      }
    }
    if (typeof this.refreshCoopScores === "function") this.refreshCoopScores();
    return true;
  };

  MultiplayerApp.prototype.flushCoopRelayQueue = function () {
    if (
      this._coopAuthority !== "native-relay-v1" ||
      !this.coop.boardReady ||
      !this.coopSession
    ) return false;
    const queued = this.coopSession.takeQueued();
    // Keep the keydown gate installed — after board-ready it latches the
    // first local key via applyCoopStartMoving (do not removeCoopRelayInputGate).
    try {
      if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
      else if (typeof window !== "undefined") window.pauseGame = 0;
    } catch (eUnpause) { /* ignore */ }
    // Only honor pre-ready keys after the local seat exists — never crawl from
    // lobby/menu key noise flushed on COOP_BOARD_READY.
    if (queued.input && this._coopSpawnApplied && !this._coopDeadSent) {
      if (Gsm.applyCoopStartMoving) {
        try {
          Gsm.applyCoopStartMoving(queued.input);
        } catch (eMove) { /* ignore */ }
      }
      this._coopPlayerMoved = true;
      this._coopIgnoreStartUntil = 0;
      if (typeof window !== "undefined") {
        window.__mpCoopIgnoreStartUntil = 0;
      }
      if (
        typeof window !== "undefined" &&
        typeof window.KeyboardEvent === "function"
      ) {
        const key = {
          UP: "ArrowUp",
          DOWN: "ArrowDown",
          LEFT: "ArrowLeft",
          RIGHT: "ArrowRight",
        }[queued.input];
        if (key) {
          window.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key: key,
              bubbles: true,
              cancelable: true,
            })
          );
        }
      }
    }
    if (queued.pose && this.client && this.client.snakeDelta) {
      this.client.snakeDelta(queued.pose);
    }
    return !!(queued.input || queued.pose);
  };

  MultiplayerApp.prototype.installCoopRelayInputGate = function () {
    if (
      this._coopRelayInputGate ||
      typeof window === "undefined" ||
      !window.addEventListener
    ) return;
    const self = this;
    const dirs = {
      ArrowUp: "UP",
      w: "UP",
      W: "UP",
      ArrowDown: "DOWN",
      s: "DOWN",
      S: "DOWN",
      ArrowLeft: "LEFT",
      a: "LEFT",
      A: "LEFT",
      ArrowRight: "RIGHT",
      d: "RIGHT",
      D: "RIGHT",
    };
    // Capture-phase: queue pre-ready keys, and on first post-seat key leave
    // native NONE-idle via applyCoopStartMoving (canvas focus is unreliable
    // while the multiplayer panel still holds DOM focus).
    this._coopRelayInputGate = function (ev) {
      if (self._coopAuthority !== "native-relay-v1") return;
      const dir = dirs[ev && ev.key];
      if (!dir || !self.coopSession) return;
      if (!self.coop.boardReady) {
        self.coopSession.queueInput(dir);
        return;
      }
      if (
        self._coopSpawnApplied &&
        !self._coopPlayerMoved &&
        !self._coopDeadSent &&
        Gsm.applyCoopStartMoving
      ) {
        try {
          Gsm.applyCoopStartMoving(dir);
        } catch (eMove) { /* ignore */ }
        self._coopPlayerMoved = true;
        self._coopIgnoreStartUntil = 0;
        if (typeof window !== "undefined") {
          window.__mpCoopIgnoreStartUntil = 0;
        }
      }
    };
    window.addEventListener("keydown", this._coopRelayInputGate, true);
  };

  MultiplayerApp.prototype.removeCoopRelayInputGate = function () {
    if (
      !this._coopRelayInputGate ||
      typeof window === "undefined" ||
      !window.removeEventListener
    ) return;
    window.removeEventListener("keydown", this._coopRelayInputGate, true);
    this._coopRelayInputGate = null;
  };

  MultiplayerApp.prototype.publishInitialCoopBoard = function () {
    if (
      this._coopAuthority !== "native-relay-v1" ||
      !this._coopBoardInitRequested ||
      this.coop.boardReady ||
      !this.client ||
      this.client.clientId !== this.coop.collectablesOwnerId ||
      !this._coopSpawnApplied ||
      !Gsm.scrapeCollectables
    ) return false;
    const keySoko =
      typeof Gsm.isKeyOrSokobanMode === "function" && Gsm.isKeyOrSokobanMode();
    // Prefer native Sna stock; if empty (force-bake), plant Classic aT for Count.
    // Key / Sokoban: plant keys/boxes/goals — never classic fruit.
    try {
      const g = Gsm.gameInstance && Gsm.gameInstance();
      if (keySoko) {
        if (Gsm.plantInitialKeySokoban) Gsm.plantInitialKeySokoban(g);
      } else {
        const ka = g && g.wa && g.wa.ka;
        const needPlant =
          !Array.isArray(ka) ||
          ka.length < 1 ||
          (ka.length === 1 &&
            ka[0] &&
            ka[0].pos &&
            (Number(ka[0].pos.x) < 0 || Number(ka[0].pos.y) < 0));
        if (needPlant && Gsm.plantClassicInitialFruit) {
          Gsm.plantClassicInitialFruit();
        } else if (Array.isArray(ka) && Gsm.matchAppleType) {
          const t = Gsm.matchAppleType();
          for (let i = 0; i < ka.length; i++) {
            if (ka[i]) ka[i].type = t;
          }
        }
        // Shield: ensure nba before scrape so peers get admin shields
        if (Gsm.assignCoopFruitShields) Gsm.assignCoopFruitShields(g);
      }
    } catch (eSeed) { /* ignore */ }
    const cols = Gsm.scrapeCollectables({ includeEntities: true });
    if (!cols) return false;
    if (!Array.isArray(cols.collectables)) {
      cols.collectables = Array.isArray(cols.apples) ? cols.apples.slice() : [];
    }
    const appleCount = Array.isArray(cols.apples) ? cols.apples.length : 0;
    const keyCount = Array.isArray(cols.keys) ? cols.keys.length : 0;
    const boxCount = Array.isArray(cols.boxes) ? cols.boxes.length : 0;
    const goalCount = Array.isArray(cols.goals) ? cols.goals.length : 0;
    const entityReady =
      keySoko && (keyCount > 0 || (boxCount > 0 && goalCount > 0));
    if (appleCount < 1 && !entityReady) {
      // Keep _coopBoardInitRequested so idle sync retries after bake lands
      return false;
    }
    cols.generation = this.coop.generation;
    cols.eventSeq = this.coopSession.nextEventSeq();
    cols.modeKey = Gsm.effectiveModeKey
      ? Gsm.effectiveModeKey()
      : cols.modeKey || "";
    cols.initial = true;
    cols.baseRevision = 0;
    if (Gsm.isCoopFruitMotionMode && Gsm.isCoopFruitMotionMode()) {
      cols.fruitMotionSeed = true;
    }
    this.client.collectablesDelta(cols);
    this._coopBoardInitRequested = false;
    return true;
  };

  MultiplayerApp.prototype.publishCoopSpeedTransition = function (
    sourceEventId,
    transition
  ) {
    if (
      this._coopAuthority !== "native-relay-v1" ||
      !this.coop.boardReady ||
      !sourceEventId ||
      !this.client ||
      !this.client.coopSpeedTransition
    ) return false;
    this.client.coopSpeedTransition({
      generation: this.coop.generation,
      eventSeq: this.coopSession.nextEventSeq(),
      sourceEventId: String(sourceEventId),
      transition: transition || {},
    });
    return true;
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
    const me = this.client && this.client.me && this.client.me();
    const isSpectator =
      !!(typeof window !== "undefined" && window.__mpCoopSpectator) ||
      !!(me && me.role === "spectator");
    const t =
      startedAtMs != null && Number.isFinite(Number(startedAtMs))
        ? Number(startedAtMs)
        : Date.now();
    this._coopTimerArmed = true;
    this._coopTimerStartedAtMs = t;
    // Do NOT set _coopPlayerMoved here — that conflates "shared clock armed"
    // with "this client already moved" and used to force idle peers to crawl.
    // Unpause so native TimeKeeper can advance (physics still server-owned)
    try {
      if (Gsm.setLocalPaused) Gsm.setLocalPaused(false);
      else if (typeof window !== "undefined") window.pauseGame = 0;
    } catch (eUnpause) { /* ignore */ }
    if (!isSpectator && Gsm.startCoopRunTimer) {
      Gsm.startCoopRunTimer({
        timerStartedAtMs: t,
        maxAttempts: 40,
        intervalMs: 50,
      });
    }
    // Belt-and-suspenders: force playing even if start() no-ops under hooks
    try {
      if (!isSpectator && typeof window !== "undefined" && window.timeKeeper) {
        const tk = window.timeKeeper;
        tk._dead = false;
        tk.playing = true;
        if (typeof tk.start === "function") {
          try {
            window.__mpCoopArmingSharedTimer = true;
            tk.start();
          } finally {
            window.__mpCoopArmingSharedTimer = false;
          }
        }
        if (Number.isFinite(t)) {
          const elapsed = Math.max(0, Date.now() - t);
          tk._lastTimeMs = elapsed;
          if (typeof tk.lastAppleTime === "number") tk.lastAppleTime = elapsed;
          tk.__mpCoopStartedAtMs = t;
        }
      }
    } catch (eTk) { /* ignore */ }
    if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
    this._ensureCoopHudTick();
    if (isSpectator) return;
    // Do NOT applyCoopStartMoving here. Shared clock arm used to force every
    // idle peer to crawl spawn.dir (usually RIGHT) the instant someone moved —
    // snakes started "by themselves" and peer-collided. Facing is local-key only
    // (flushCoopRelayQueue / applyCoopStartMoving on this client's input).
  };

  /** Keep the co-op HUD clock advancing between pose publishes. */
  MultiplayerApp.prototype._ensureCoopHudTick = function () {
    if (this._coopHudTimer) return;
    if (typeof setInterval !== "function") return;
    const self = this;
    this._coopHudTimer = setInterval(function () {
      if (!self._coopSessionActive || self._coopTimerStartedAtMs == null) {
        self._stopCoopHudTick();
        return;
      }
      if (self.ui && self.ui.updateHud) self.ui.updateHud(self);
    }, 200);
    if (this._coopHudTimer && typeof this._coopHudTimer.unref === "function") {
      this._coopHudTimer.unref();
    }
  };

  MultiplayerApp.prototype._stopCoopHudTick = function () {
    if (this._coopHudTimer) {
      clearInterval(this._coopHudTimer);
      this._coopHudTimer = null;
    }
  };

  /** Eater publishes full native fruit board after collect (shared spawn rules). */
  MultiplayerApp.prototype.publishCoopCollectables = function (force, opts) {
    opts = opts || {};
    if (this._coopAuthority === "native-relay-v1") {
      if (!this.coop.boardReady) {
        return this.publishInitialCoopBoard();
      }
      // Mid-match: any seated eater may publish runtime fruit once per eat
      if (!this.client || !this.client.connected) return false;
      if (!this._coopSessionActive) return false;
      if (!this.client.roster || this.client.roster.mode !== "coop") return false;
      const me = this.client.me();
      if (!me || me.role !== "player") return false;
      if (!Gsm.scrapeCollectables) return false;
      const cols = Gsm.scrapeCollectables({ includeEntities: true });
      if (!cols) return false;
      if (!Array.isArray(cols.collectables)) {
        cols.collectables = Array.isArray(cols.apples) ? cols.apples.slice() : [];
      }
      if (cols.apples && Gsm.nudgeCoopApplesOffSnakes) {
        const g = Gsm.gameInstance && Gsm.gameInstance();
        if (typeof window !== "undefined") window.__mpCoopBoardFull = false;
        cols.apples = Gsm.nudgeCoopApplesOffSnakes(cols.apples, g);
        cols.collectables = cols.apples;
        if (
          typeof window !== "undefined" &&
          window.__mpCoopBoardFull &&
          this.maybeCoopAllApples
        ) {
          this.maybeCoopAllApples("board_full");
        }
      }
      const wallGrow = !!opts.wallGrow || !!this._coopWallGrowArmed;
      this._coopWallGrowArmed = false;
      const prevWalls = this._coopLastWallCount;
      const nextWalls = Array.isArray(cols.walls) ? cols.walls.length : 0;
      if (
        !wallGrow &&
        prevWalls != null &&
        nextWalls < prevWalls &&
        Array.isArray(cols.walls) &&
        this._coopLastWalls
      ) {
        cols.walls = this._coopLastWalls;
      }
      if (wallGrow || prevWalls == null || nextWalls >= (prevWalls | 0)) {
        this._coopLastWallCount = nextWalls;
        this._coopLastWalls = Array.isArray(cols.walls)
          ? cols.walls.map(function (w) {
              return w ? Object.assign({}, w) : w;
            })
          : null;
      }
      const fp =
        Gsm.collectablesFingerprint && Gsm.collectablesFingerprint(cols);
      if (fp && fp === this._coopColsFp && !force && !wallGrow) return false;
      this._coopColsFp = fp;
      const baseRev = this.coopSession
        ? this.coopSession.boardRev | 0
        : (this.coop && this.coop.boardRevision) || 0;
      const nextRev = this.coopSession
        ? this.coopSession.nextBoardRev()
        : (this._coopBoardRev = (this._coopBoardRev | 0) + 1);
      cols.generation = this.coop.generation;
      cols.eventSeq = this.coopSession
        ? this.coopSession.nextEventSeq()
        : (this._coopEventSeq = (this._coopEventSeq | 0) + 1);
      cols.modeKey = Gsm.effectiveModeKey
        ? Gsm.effectiveModeKey()
        : cols.modeKey || "classic";
      cols.initial = false;
      cols.baseRevision = baseRev;
      cols.revision = nextRev;
      cols.rev = nextRev;
      if (Gsm.isCoopFruitMotionMode && Gsm.isCoopFruitMotionMode()) {
        if (force) cols.fruitMotionSeed = true;
        else cols.fruitMotionTrust = true;
      }
      if (this.coopNative) this.coopNative.applyCollectables(cols);
      this.client.collectablesDelta(cols);
      return true;
    }
    // Server sim owns fruit
    return false;
  };

  /**
   * Combined co-op score from local scrape + remote SNAKE_DELTA scores.
   * Wins when total >= W*H - walls - 3*players (shared board fill).
   */
  MultiplayerApp.prototype.refreshCoopScores = function () {
    if (!this.client || !this.client.roster || this.client.roster.mode !== "coop") {
      return;
    }
    // Match end freezes the last team totals — quitting the native run would
    // otherwise scrape score 0 and wipe the admin's HUD ("All apples!").
    if (this._coopMatchEndHandled || this._coopEndReason) {
      if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
      return;
    }
    if (!this._coopScores) this._coopScores = {};
    // Server-auth: scores come from COOP_STATE only — do not scrape native
    if (this._coopServerAuth || (typeof window !== "undefined" && window.__mpCoopServerAuth)) {
      let total = 0;
      const scores = this._coopScores;
      Object.keys(scores).forEach(function (id) {
        const sc = scores[id];
        total += sc && typeof sc === "object" ? sc.score | 0 : sc | 0;
      });
      this._coopTotal = total;
      if (this._coopGoal == null) this.ensureCoopAppleGoal();
      if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
      return;
    }
    const players = (this.client.roster.clients || []).filter(function (c) {
      return c.role === "player";
    });
    const myId = this.client.clientId;
    const remotes = (this.coopNative && this.coopNative.remotes) || {};
    let total = 0;
    const self = this;
    players.forEach(function (p) {
      let score = 0;
      let alive = true;
      if (p.clientId === myId) {
        const s = Gsm.readScoreAndAlive ? Gsm.readScoreAndAlive() : {};
        score = s.score != null ? s.score | 0 : 0;
        alive = s.alive !== false && !self._coopDeadSent;
      } else if (remotes[p.clientId]) {
        const r = remotes[p.clientId];
        // Prefer the publisher's authoritative score. Cheese / portal / fog
        // bodies are longer than apple-count, so bodyLen-3 over-reports
        // (e.g. 86 on peer while local HUD shows 48).
        if (r.score != null && Number.isFinite(Number(r.score))) {
          score = Number(r.score) | 0;
        } else {
          const bodyLen =
            r.body && r.body.length
              ? r.body.length
              : r.ka && r.ka.length
                ? r.ka.length
                : 0;
          score = bodyLen >= 3 ? bodyLen - 3 : 0;
        }
        alive = r.alive !== false;
        // Sticky peer-down only after authoritative COOP_PLAYER_DEAD.
        if (r._deadSticky) {
          alive = false;
        }
      } else if (self._coopScores[p.clientId]) {
        score = self._coopScores[p.clientId].score | 0;
        alive = self._coopScores[p.clientId].alive !== false;
      }
      self._coopScores[p.clientId] = { score: score, alive: alive };
      total += score;
    });
    this._coopTotal = total;
    if (this._coopGoal == null) this.ensureCoopAppleGoal();
    if (this.ui && this.ui.updateHud) this.ui.updateHud(this);
    if (
      this._coopGoal != null &&
      total >= this._coopGoal &&
      this._coopSessionActive &&
      this._coopAuthority !== "native-relay-v1"
    ) {
      this.maybeCoopAllApples("score");
    }
  };

  MultiplayerApp.prototype.ensureCoopAppleGoal = function () {
    const players = (
      (this.client && this.client.roster && this.client.roster.clients) ||
      []
    ).filter(function (c) {
      return c.role === "player";
    });
    const n = Math.max(
      1,
      (this._coopSlots && this._coopSlots.length) || players.length || 1
    );
    const g = Gsm.gameInstance && Gsm.gameInstance();
    let w = 0;
    let h = 0;
    let walls = 0;
    try {
      const live = Gsm.boardSizeFromGame && Gsm.boardSizeFromGame(g);
      if (live && live.width > 0 && live.height > 0) {
        w = live.width | 0;
        h = live.height | 0;
      }
    } catch (eLive) { /* ignore */ }
    // Prefer server session / seat dims over the Classic 17×15 default.
    if (!(w > 0 && h > 0)) {
      const bw =
        (this.coop && this.coop.boardWidth) ||
        (this._matchSettings && this._matchSettings.boardWidth) ||
        (this._coopSlots &&
          this._coopSlots[0] &&
          this._coopSlots[0].boardWidth);
      const bh =
        (this.coop && this.coop.boardHeight) ||
        (this._matchSettings && this._matchSettings.boardHeight) ||
        (this._coopSlots &&
          this._coopSlots[0] &&
          this._coopSlots[0].boardHeight);
      if (bw > 0 && bh > 0) {
        w = bw | 0;
        h = bh | 0;
      }
    }
    if (!(w > 0 && h > 0) && Gsm.boardDimsForSizeIndex) {
      const size =
        this.coop && this.coop.settings && this.coop.settings.size != null
          ? this.coop.settings.size
          : this._matchSettings && this._matchSettings.size;
      const dims = Gsm.boardDimsForSizeIndex(size);
      if (dims && dims.width > 0 && dims.height > 0) {
        w = dims.width | 0;
        h = dims.height | 0;
      }
    }
    if (!(w > 0 && h > 0)) {
      w = 17;
      h = 15;
    }
    try {
      if (g && g.Ca && g.Ca.Aa && typeof g.Ca.Aa.size === "number") {
        walls = g.Ca.Aa.size | 0;
      }
    } catch (eWalls) { /* ignore */ }
    const next = Gsm.coopAppleGoal
      ? Gsm.coopAppleGoal(w, h, n, walls)
      : Math.max(1, w * h - walls - 3 * n);
    // Refresh when live board dims arrive (avoid sticky Classic 17×15 → 249 on Small).
    if (
      this._coopGoal == null ||
      this._coopGoalBoardW !== w ||
      this._coopGoalBoardH !== h ||
      this._coopGoalPlayers !== n
    ) {
      this._coopGoal = next;
      this._coopGoalBoardW = w;
      this._coopGoalBoardH = h;
      this._coopGoalPlayers = n;
    }
    return this._coopGoal;
  };

  MultiplayerApp.prototype.maybeCoopAllApples = function (reason) {
    if (!this._coopSessionActive) return false;
    if (this._coopMatchEndHandled || this._coopEndReason) return false;
    if (this._coopAuthority !== "native-relay-v1") return false;
    if (!this.client || !this.client.connected) return false;
    const me = this.client.me && this.client.me();
    if (!me || me.role !== "player") return false;

    let fruitLen = 0;
    try {
      const g = Gsm.gameInstance && Gsm.gameInstance();
      const ka = g && g.wa && g.wa.ka;
      fruitLen = Array.isArray(ka) ? ka.length : 0;
    } catch (eLen) { /* ignore */ }

    // False ALL: native gotAll while fruit still on the board
    if (reason === "native_all" && fruitLen > 0) return false;
    // Never win while any fruit remains (spawn-fail must not ALL_APPLES mid-board)
    if (fruitLen > 0) return false;
    // board_full: only when the board is truly packed (no free spawn cell)
    if (reason === "board_full") {
      try {
        const g = Gsm.gameInstance && Gsm.gameInstance();
        const findFree =
          typeof window !== "undefined" && window.__mpCoopFindFreeSpawn;
        if (typeof findFree === "function") {
          const occ =
            typeof window.__mpCoopReadSpawnOccupancy === "function"
              ? window.__mpCoopReadSpawnOccupancy(g, true)
              : null;
          if (findFree(g, occ)) return false;
        }
      } catch (eFree) {
        return false;
      }
    }

    if (typeof this.client.coopGoal === "function") {
      this.client.coopGoal({
        reason: "ALL_APPLES",
        generation: this.coop && this.coop.generation,
        source: reason || "all_apples",
      });
    }
    return true;
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
  };

  MultiplayerApp.prototype._logCoopDeath = function (source, detail) {
    const entry = {
      source: source || "unknown",
      t: Date.now(),
      detail: detail || null,
      deadSent: !!this._coopDeadSent,
      session: !!this._coopSessionActive,
      gen: this._coopSessionGen | 0,
    };
    if (typeof window !== "undefined") {
      if (!Array.isArray(window.__mpCoopDeathLog)) {
        window.__mpCoopDeathLog = [];
      }
      window.__mpCoopDeathLog.push(entry);
      if (window.__mpCoopDeathLog.length > 40) {
        window.__mpCoopDeathLog.splice(0, window.__mpCoopDeathLog.length - 40);
      }
    }
    try {
      console.info("[Multiplayer] coop_death", entry);
    } catch (e) { /* ignore */ }
  };

  MultiplayerApp.prototype._killLocalCoopForReset = function (source) {
    // Co-op Reset is always soft-rebind — never publish death
    return this._softRebindCoopServerAuth(source || "reset_hook");
  };

  /**
   * Server-auth Reset / Escape: rebind COOP_STATE only.
   * Must not kill the local snake, run native reset, or wipe STATE fruit hosts.
   */
  MultiplayerApp.prototype._softRebindCoopServerAuth = function (source) {
    if (!this._coopSessionActive) return false;
    this._coopServerAuth = true;
    if (typeof window !== "undefined") window.__mpCoopServerAuth = true;
    let savedState = null;
    let savedMyId = null;
    if (typeof window !== "undefined") {
      savedState = window.__mpCoopLastState;
      savedMyId = window.__mpCoopLastStateMyId;
      window.__mpCoopLocalDead = false;
      window.__mpCoopLocalCorpse = false;
    }
    // Clear mouth/eat leftovers on the local snake only — do not wipe fruit hosts
    try {
      const g = Gsm.gameInstance && Gsm.gameInstance();
      if (g && g.oa) {
        const eatKeys = [
          "grow",
          "growth",
          "pendingGrowth",
          "toGrow",
          "mouth",
          "eating",
          "eatProgress",
          "appleBits",
        ];
        for (let ei = 0; ei < eatKeys.length; ei++) {
          const ek = eatKeys[ei];
          if (ek in g.oa) {
            g.oa[ek] = typeof g.oa[ek] === "number" ? 0 : false;
          }
        }
      }
      if (g) {
        g.nj = false;
        if (g.dead != null) g.dead = false;
        if (g.isDead != null) g.isDead = false;
      }
    } catch (eEat) { /* ignore */ }
    if (savedState && !savedState.ended && typeof window !== "undefined") {
      window.__mpCoopLastState = savedState;
      window.__mpCoopLastStateMyId =
        savedMyId || (this.client && this.client.clientId);
      window.__mpCoopSeatLocked = false;
      const Binder = window.CoopBinder;
      if (Binder && Binder.applyCoopState) {
        try {
          Binder.applyCoopState(
            savedState,
            window.__mpCoopLastStateMyId,
            { force: true, skipFruit: true, bodyOnly: true }
          );
        } catch (eApply) { /* ignore */ }
      }
    }
    try {
      this.ensureCoopServerAuthBoard();
    } catch (eEns) {
      console.warn("_softRebindCoopServerAuth", source, eEns);
      return false;
    }
    return true;
  };

  MultiplayerApp.prototype.hookLocalScorePulse = function () {
    const self = this;
    if (RaceTimeKeeper && RaceTimeKeeper.install) {
      RaceTimeKeeper.install();
    }
    Gsm.wrapTimeKeeper({
      onStart: function () {
        if (!self.client || !self.client.connected) return;
        const me = self.client.me && self.client.me();
        if (!me || me.role !== "player") return;
        if (
          self._coopSessionActive &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          // Shared run-clock arm calls tk.start() — never treat that as death.
          // Mid-match Play restart is handled by __mpCoopOnLocalReset / game.reset.
          if (typeof self._logCoopDeath === "function") {
            self._logCoopDeath(
              typeof window !== "undefined" && window.__mpCoopArmingSharedTimer
                ? "timer_arm_blocked"
                : "onStart_ignored"
            );
          }
          return;
        }
        if (!self.client.roster || self.client.roster.mode !== "race") return;
        if (!self.client.roster.sessionActive) return;
        const t = Date.now();
        self._raceRunStartedAtMs = t;
        self._raceGoalResetArmed = false;
        // Arm mosaic clocks once; viewers tick locally from this wall time
        self._pulseScore(0, 0, true, { runStartedAtMs: t });
      },
      onApple: function (timeMs, score) {
        if (
          self._coopServerAuth ||
          (typeof window !== "undefined" && window.__mpCoopServerAuth)
        ) {
          // Server owns eat / score / fruit refill — ignore native gotApple
          return;
        }
        self._pulseScore(score, timeMs, true);
        if (
          self._coopSessionActive &&
          self.client &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          const me = self.client.me();
          if (me && me.role === "player") {
            if (typeof window !== "undefined") {
              window.__mpCoopSkipFruitReapply = true;
            }
            setTimeout(function () {
              self._coopWallGrowArmed = true;
              // Bomb/Dice/Tally batch refill may land a tick after gotApple
              setTimeout(function () {
                self.publishCoopCollectables(true, { wallGrow: true });
                if (typeof self.refreshCoopScores === "function") {
                  self.refreshCoopScores();
                }
                setTimeout(function () {
                  if (typeof window !== "undefined") {
                    window.__mpCoopSkipFruitReapply = false;
                  }
                }, 50);
              }, 50);
            }, 0);
          }
        } else if (typeof self.maybeResetRaceOnGoal === "function") {
          self.maybeResetRaceOnGoal(score, timeMs);
        }
      },
      onAll: function (timeMs, score) {
        // Race spectator: keep watching; no PB from spectate
        if (self._isRaceSpectator && self._isRaceSpectator()) return;
        if (
          typeof window !== "undefined" &&
          window.__mpCoopSpectator
        ) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          return;
        }
        if (
          self._coopServerAuth ||
          (typeof window !== "undefined" && window.__mpCoopServerAuth)
        ) {
          // Native ALL is not authority — server SESSION_END owns the win
          return;
        }
        if (
          self._coopSessionActive &&
          self.client &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          // Suppress false ALL; real empty board → shared COOP_GOAL
          let fruitLen = 0;
          try {
            const g = Gsm.gameInstance && Gsm.gameInstance();
            const ka = g && g.wa && g.wa.ka;
            fruitLen = Array.isArray(ka) ? ka.length : 0;
          } catch (eAll) { /* ignore */ }
          if (fruitLen > 0) {
            if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
            try {
              if (typeof window !== "undefined" && window.timeKeeper) {
                window.timeKeeper.playing = true;
                window.timeKeeper._dead = false;
              }
            } catch (ePlay) { /* ignore */ }
            return;
          }
          if (Gsm.stopCoopRunTimer) Gsm.stopCoopRunTimer();
          if (typeof self.refreshCoopScores === "function") {
            self.refreshCoopScores();
          }
          self.maybeCoopAllApples("native_all");
          return;
        }
        // Count/track first (Best All + scoreboard), then restart race
        self._pulseScore(score, timeMs, false, { goalAll: true });
        self._raceRunStartedAtMs = null;
        self._maybePromotePb(timeMs, score);
        // Race: after ALL apples are scored, instantly start another run
        // Soft expire (finish ongoing): stay on endscreen — no new runs
        if (!self.restartRaceAfterDeath()) {
          const roster = self.client && self.client.roster;
          if (
            roster &&
            roster.mode === "race" &&
            roster.attemptExpired
          ) {
            self.returnToMenus({ fromExpired: true });
          }
        }
      },
      onDeath: function (timeMs, score) {
        // Race spectator: watching, not competing — no pulse, no PB, no
        // restart. The endscreen is left exactly as the game left it; hiding it
        // here is what used to fight the run and reset it in a loop.
        if (self._isRaceSpectator && self._isRaceSpectator()) return;
        // Co-op spectator: shared board — never treat as a real player death
        if (
          typeof window !== "undefined" &&
          window.__mpCoopSpectator
        ) {
          if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          if (Gsm.parkLocalSnakeOffBoard) Gsm.parkLocalSnakeOffBoard();
          else if (Gsm.emptyLocalSnakeBody) Gsm.emptyLocalSnakeBody();
          return;
        }
        self._pulseScore(score, timeMs, false);
        self._raceRunStartedAtMs = null;
        self._maybePromotePb(timeMs, score);
        // Dying clears Ready so match menus unlock again
        const deathMe = self.client && self.client.me && self.client.me();
        if (deathMe && deathMe.role === "player" && deathMe.ready) {
          deathMe.ready = false;
          if (self.client.setReady) self.client.setReady(false);
          self.applyControlLocks();
          if (self.client.roster && self.ui && self.ui.renderRoster) {
            self.ui.renderRoster(self.client.roster);
          }
        }
        if (
          self._coopSessionActive &&
          self.client &&
          self.client.roster &&
          self.client.roster.mode === "coop"
        ) {
          const me = self.client.me();
          if (me && me.role === "player" && !self._coopDeadSent) {
            if (self.coopSession && !self.coopSession.canPublishDeath()) {
              self._logCoopDeath("warmup");
              return;
            }
            if (self.coopSession) self.coopSession.markDead("native_die");
            self._logCoopDeath("native_die");
            self._coopDeadSent = true;
            if (typeof window !== "undefined") window.__mpCoopLocalDead = true;
            const board = Gsm.scrapeBoard && Gsm.scrapeBoard();
            const scraped = board && board.body;
            self._coopLastBody =
              (self._coopLastBody && self._coopLastBody.length
                ? self._coopLastBody
                : null) ||
              (scraped && scraped.length ? scraped : null);
            self.client.coopPlayerDead({
              generation: self.coop && self.coop.generation,
              eventSeq:
                self.coopSession && self.coopSession.nextEventSeq
                  ? self.coopSession.nextEventSeq()
                  : Date.now(),
              body: self._coopLastBody || undefined,
              reason: "native",
            });
            // Do not follow with SNAKE_DELTA — dead seats used to ERROR seat_dead
            // and flash on the status bar / peer clients during the next start.
            if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
          }
          if (typeof self.refreshCoopScores === "function") {
            self.refreshCoopScores();
          }
          return;
        }
        // Race: skip the death screen — instantly start another run
        // After attempt expiry (hard or finish-ongoing), stay on death / menus
        if (!self.restartRaceAfterDeath()) {
          const roster = self.client && self.client.roster;
          if (
            roster &&
            roster.mode === "race" &&
            roster.attemptExpired
          ) {
            self.returnToMenus({ fromExpired: true });
          }
        }
      },
    });

    if (this._scoreTimer) clearInterval(this._scoreTimer);
    this._scoreTimer = null;
    // Race scores/boards publish on native tick (installNativeTickNetPublish).
    // Death / goal paths still call _pulseScore directly.
  };

  /**
   * Native game-step net publish for co-op + race (Fb-aligned, ~135ms at normal).
   * Installed once; no-ops when session inactive.
   */
  MultiplayerApp.prototype.installNativeTickNetPublish = function () {
    const self = this;
    if (typeof window === "undefined") return;
    window.__mpCoopAfterTick = function () {
      try {
        if (!self.client || !self.client.connected) return;
        const roster = self.client.roster;
        if (!roster || !roster.sessionActive) return;
        if (roster.mode === "coop") {
          if (self._coopAuthority === "native-relay-v1") {
            self.publishCoopState();
          }
        } else if (roster.mode === "race") {
          self.publishRaceTick();
        }
      } catch (e) {
        console.warn("__mpCoopAfterTick net", e);
      }
    };
  };

  /** One BOARD_DELTA + SCORE_PULSE per native race tick (spectator cadence = Fb). */
  MultiplayerApp.prototype.publishRaceTick = function () {
    if (!this.client || !this.client.connected) return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;
    const roster = this.client.roster;
    if (!roster || roster.mode !== "race" || !roster.sessionActive) return;

    const s = Gsm.readScoreAndAlive && Gsm.readScoreAndAlive();
    if (s) {
      if (
        s.alive !== false &&
        this._raceRunStartedAtMs == null &&
        root.timeKeeper &&
        root.timeKeeper.playing
      ) {
        const elapsed =
          s.timeMs != null && Number.isFinite(Number(s.timeMs))
            ? Number(s.timeMs)
            : 0;
        this._raceRunStartedAtMs = Date.now() - Math.max(0, elapsed);
      }
      this._pulseScore(
        s.score,
        s.timeMs != null && Number.isFinite(s.timeMs) ? s.timeMs : 0,
        s.alive
      );
    }

    const specs = (roster.clients || []).filter(function (c) {
      return c.role === "spectator";
    });
    if (!specs.length) return;
    const board = Gsm.scrapeBoard({
      colorId: me.colorId != null ? me.colorId : undefined,
    });
    if (!board) return;
    try {
      const g =
        Gsm.gameInstance && typeof Gsm.gameInstance === "function"
          ? Gsm.gameInstance()
          : null;
      if (g && typeof g.Fb === "number" && Number(g.Fb) > 0) {
        board.stepIntervalMs = Number(g.Fb);
        board.intervalMs = Number(g.Fb);
      }
    } catch (eFb) { /* ignore */ }
    const fp = Gsm.boardDeltaFingerprint
      ? Gsm.boardDeltaFingerprint(board)
      : null;
    if (fp && fp === this._raceLastBoardFp) return;
    this._raceLastBoardFp = fp;
    this.client.boardDelta(board);
  };

  MultiplayerApp.prototype.hookBoardUpload = function () {
    // Tick-aligned publish replaces the old fixed 80ms board poll.
    this.installNativeTickNetPublish();
    if (this._boardTimer) clearInterval(this._boardTimer);
    this._boardTimer = null;
  };

  MultiplayerApp.prototype._pulseScore = function (score, timeMs, alive, extra) {
    if (!this.client || !this.client.connected) return;
    const me = this.client.me();
    if (!me || me.role !== "player") return;
    if (!this.client.roster || this.client.roster.mode !== "race") return;
    const payload = {
      score: score,
      timeMs: timeMs,
      alive: alive !== false,
    };
    if (
      alive !== false &&
      this._raceRunStartedAtMs != null &&
      Number.isFinite(Number(this._raceRunStartedAtMs))
    ) {
      payload.runStartedAtMs = Number(this._raceRunStartedAtMs);
    }
    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach(function (k) {
        payload[k] = extra[k];
      });
    }
    const goal =
      (this.race && this.race.raceGoal) ||
      (this.client.roster && this.client.roster.raceGoal) ||
      "score";
    const RaceState = root.RaceState;
    if (RaceState && RaceState.isTimedGoal && RaceState.isTimedGoal(goal)) {
      const meta = RaceState.goalMeta(goal);
      if (meta.all && extra && extra.goalAll) {
        payload.goalAll = true;
      } else if (meta.threshold != null && Number(score) >= meta.threshold) {
        // Server treats score >= threshold as a timed-goal hit
      }
    }
    this.client.scorePulse(payload);
  };

  /**
   * Race only: after a death or ALL-apples clear, immediately start another
   * native run so players never sit on the endscreen (Play is locked while connected).
   * Score/goal tracking must already have been pulsed before calling this.
   * Skips when the attempt timer expired / allowNewRuns is false.
   */
  MultiplayerApp.prototype.canAutoRestartRace = function () {
    if (!this.client || !this.client.connected) return false;
    const roster = this.client.roster;
    if (!roster || roster.mode !== "race") return false;
    if (!roster.sessionActive) return false;
    if (roster.allowNewRuns === false) return false;
    if (roster.attemptExpired === true) return false;
    if (this.race && this.race.expired) return false;
    const me = this.client.me && this.client.me();
    if (!me || me.role !== "player") return false;
    if (typeof window !== "undefined") {
      if (window.__mpRaceFocusWatch) return false;
      if (window.__mpCoopSession || window.__mpCoopSpectator) return false;
    }
    return true;
  };

  /** localStorage preference — Reset on goal (Best 25/50/100 mid-run restart). */
  MultiplayerApp.prototype.raceResetOnGoalEnabled = function () {
    try {
      if (typeof localStorage === "undefined") return false;
      return localStorage.getItem("MULTIPLAYER_RACE_RESET_ON_GOAL") === "1";
    } catch (e) {
      return false;
    }
  };

  /**
   * When Reset on goal is on and the room goal is Best 25/50/100, instantly
   * start a new run once this run's score hits the threshold (mid-run OK).
   */
  MultiplayerApp.prototype.maybeResetRaceOnGoal = function (score, timeMs) {
    if (!this.raceResetOnGoalEnabled()) return false;
    if (!this.canAutoRestartRace()) return false;
    if (this._raceGoalResetArmed) return false;
    const RaceState = root.RaceState;
    if (!RaceState || !RaceState.goalThreshold) return false;
    const goal =
      (this.race && this.race.raceGoal) ||
      (this.client.roster && this.client.roster.raceGoal) ||
      "score";
    const thr = RaceState.goalThreshold(goal);
    // Only Best 25 / 50 / 100 — not Score, not Best All (All already resets)
    if (thr == null || !Number.isFinite(Number(thr))) return false;
    if (Number(score) < Number(thr)) return false;
    // Need a real clock — zero-time hits are clock-reset ghosts, not completions
    if (!(Number(timeMs) > 0)) return false;
    this._raceGoalResetArmed = true;
    this._raceRunStartedAtMs = null;
    if (typeof this._maybePromotePb === "function") {
      this._maybePromotePb(timeMs, score);
    }
    return this.restartRaceAfterDeath({ forceNewRun: true });
  };

  /**
   * End the current native race run so startNativeRun will click Play again.
   * Mid-run goal reset leaves the engine "live"; without this, Play never fires.
   */
  MultiplayerApp.prototype._forceEndRaceRunForRestart = function () {
    try {
      const tk =
        typeof window !== "undefined" ? window.timeKeeper : root.timeKeeper;
      if (tk) {
        tk._dead = true;
        tk.playing = false;
      }
    } catch (eTk) { /* ignore */ }
    try {
      const g = Gsm.gameInstance && Gsm.gameInstance();
      if (g) {
        if ("nj" in g) g.nj = true;
        if ("dead" in g) g.dead = true;
      }
    } catch (eG) { /* ignore */ }
  };

  MultiplayerApp.prototype.restartRaceAfterDeath = function (opts) {
    opts = opts || {};
    if (!this.canAutoRestartRace()) return false;
    if (this._raceRestartPending) return false;
    this._raceRestartPending = true;
    // Mid-run Reset-on-goal: force not-live so startNativeRun clicks Play
    if (
      opts.forceNewRun ||
      (Gsm.isNativeRunLive && Gsm.isNativeRunLive())
    ) {
      this._forceEndRaceRunForRestart();
    }
    // Hide endscreen immediately so death never "sticks" visually
    if (Gsm.dismissDeathOverlayForRun) Gsm.dismissDeathOverlayForRun();
    else if (Gsm.hideDeathScreen) Gsm.hideDeathScreen();
    const self = this;
    // Next macrotask so TimeKeeper death handlers finish before Play
    setTimeout(function () {
      self._raceRestartPending = false;
      if (!self.canAutoRestartRace()) return;
      // Re-assert not-live in case a tick cleared flags
      if (opts.forceNewRun) self._forceEndRaceRunForRestart();
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
      // Only promote after a real race player run wrote session storage
      if (!RaceTimeKeeper || !RaceTimeKeeper.isActive()) return;
      if (
        typeof window !== "undefined" &&
        (window.__mpRaceFocusWatch || window.__mpCoopSpectator)
      ) {
        return;
      }
      RaceTimeKeeper.promoteSessionToRemix();
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
      const mode = self.client.roster && self.client.roster.mode;
      if (mode !== "race" && mode !== "coop") return;
      if (!self.client.roster.sessionActive) return;
      const specs = (self.client.roster.clients || []).filter(function (c) {
        return c.role === "spectator";
      });
      if (!specs.length) return;
      const board = Gsm.scrapeBoard({
        colorId: me.colorId != null ? me.colorId : undefined,
      });
      if (!board) return;
      const fp = Gsm.boardDeltaFingerprint
        ? Gsm.boardDeltaFingerprint(board)
        : null;
      if (fp && fp === self._raceLastBoardFp) return;
      self._raceLastBoardFp = fp;
      self.client.boardDelta(board);
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
            (mode === "race" &&
              me &&
              me.role === "spectator" &&
              self.race &&
              self.race.spectateMode !== "mosaic"));
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
   * Co-op only: non-admins cannot Space/Enter/R-start the native engine while
   * their Play button is locked. Admin is never blocked. Outside connected
   * co-op there is no gate.
   */
  MultiplayerApp.prototype.shouldBlockCoopNativeStartKey = function () {
    if (!this.client || !this.client.connected) return false;
    const roster = this.client.roster || {};
    if (roster.mode !== "coop") return false;
    if (this.client.isAdmin && this.client.isAdmin()) return false;
    return true;
  };

  MultiplayerApp.prototype.hookCoopNativeStartBlock = function () {
    const self = this;
    if (this._coopNativeStartHooked) return;
    this._coopNativeStartHooked = true;
    window.addEventListener(
      "keydown",
      function (ev) {
        if (root.__mpAllowPlayClick) return;
        if (!self.shouldBlockCoopNativeStartKey()) return;
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
        // Stock engine: Space / Enter / R call Ma() when the menu is up
        const code = ev.keyCode | ev.which | 0;
        const isStartKey =
          ev.key === " " ||
          ev.key === "Spacebar" ||
          ev.code === "Space" ||
          code === 32 ||
          ev.key === "Enter" ||
          ev.code === "Enter" ||
          code === 13 ||
          ev.key === "r" ||
          ev.key === "R" ||
          code === 82;
        if (!isStartKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") {
          ev.stopImmediatePropagation();
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
          // Race focus: peek death/settings without ending spectate.
          if (
            self._raceFocusSpectate ||
            (self._isRaceSpectator && self._isRaceSpectator())
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

        // Admin in lobby / between matches: do NOT abort — let Escape reach
        // native so menus open. Only force a quit if the engine is still live.
        const roster = self.client.roster || {};
        if (!roster.sessionActive) {
          if (
            Gsm.isNativeRunLive &&
            Gsm.isNativeRunLive() &&
            self.ensureLobbyMatchMenusInteractive
          ) {
            self.ensureLobbyMatchMenusInteractive({ force: true });
          } else if (Gsm.unlockPersonalMenus) {
            Gsm.unlockPersonalMenus();
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
    this._raceRestartPending = false;
    if (typeof window !== "undefined") {
      window.__mpStartingMatch = false;
    }
    // Match-end already ran endCoopNativeSession({ suppressHideDeath }) —
    // a second wipe would hide `.wjOYOd` again before chrome reveal.
    if (!opts.coopMatchEnd) {
      this.endCoopNativeSession();
    }
    // Co-op TimeKeeper must never write localStorage (coop or remix keys).
    this.setCoopAuthorityMode(false);
    if (this._focusCanvas) this._focusCanvas.style.display = "none";
    if (this._mosaicEl) this._mosaicEl.style.display = "none";
    const roster = this.client && this.client.roster;
    const stillLive = !!(roster && roster.sessionActive);
    // Match-end must always reveal chrome — roster can still report
    // sessionActive briefly after SESSION_END / synthetic ALL_DEAD.
    if ((opts.coopMatchEnd || !stillLive) && Gsm.showDeathScreen) {
      // Reveal menu chrome synchronously, but defer the Escape-style engine
      // quit to releaseMenusAfterMatch so it cannot fire inside a socket
      // event handler. Explicit End match already owns that guarded quit.
      if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
      if (opts.coopMatchEnd && Gsm.quitNativeRunForMenus) {
        // Force visible overlay + Escape pulse so Remix menus accept clicks.
        Gsm.quitNativeRunForMenus({
          skipEscapeDispatch: false,
          pulse: true,
        });
      } else {
        Gsm.showDeathScreen({ skipEscapeDispatch: true });
      }
    }
    if (opts.fromAdmin && !root.__mpEscHandling) {
      if (Gsm.quitNativeRunForMenus) {
        Gsm.quitNativeRunForMenus({ pulse: true });
      } else if (Gsm.showDeathScreen) {
        Gsm.showDeathScreen({ skipEscapeDispatch: false });
      } else {
        root.pauseGame = 1;
      }
    }
    this.applyControlLocks();
    this.releaseMenusAfterMatch({
      coopMatchEnd: !!opts.coopMatchEnd,
    });
  };

  /**
   * Lobby / between matches: hand the engine a quit so trophy/count/speed/size
   * accept clicks. Visible death chrome alone is not enough — Remix ignores
   * those rows until Escape-style quit runs.
   */
  MultiplayerApp.prototype.ensureLobbyMatchMenusInteractive = function (opts) {
    opts = opts || {};
    if (!Gsm.showDeathScreen && !Gsm.quitNativeRunForMenus) return;
    const c = this.client;
    if (!c || !c.connected) return;
    const me = c.me && c.me();
    if (!me || me.role !== "player") return;
    if (c.roster && c.roster.sessionActive) {
      // Match-end latch: still allow lobby pulse when sessionActive is stale.
      if (
        !(
          opts.force &&
          (this._coopMatchEndHandled ||
            this._coopEndReason ||
            (typeof window !== "undefined" && window.__mpCoopMatchEndMenus))
        )
      ) {
        return;
      }
    }
    if (root.__mpEscHandling) return;
    if (
      !opts.force &&
      this._lobbyMenuPulseAt &&
      Date.now() - this._lobbyMenuPulseAt < 400
    ) {
      return;
    }
    this._lobbyMenuPulseAt = Date.now();
    // Real engine quit — chrome-only leave trophy/count/theme unclickable
    if (Gsm.quitNativeRunForMenus) {
      Gsm.quitNativeRunForMenus({ pulse: true });
    } else {
      if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
      if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
      Gsm.showDeathScreen({});
    }
    if (Gsm.setNativeMenusLocked) Gsm.setNativeMenusLocked(false);
    if (this._paintPlayAsStartMatch) this._paintPlayAsStartMatch();
    else if (Gsm.setPlayButtonLocked) Gsm.setPlayButtonLocked(true);
    if (Gsm.unlockPersonalMenus) Gsm.unlockPersonalMenus();
  };

  /**
   * Match over: hand the engine back to Google's own menu so players can set
   * the next one up. Forcing the endscreen visible is only chrome — until the
   * engine gets the quit signal Remix's reset uses, its menu never opens and
   * the trophy/count/speed/size rows ignore every click.
   *
   * Co-op ALL_DEAD / ALL_APPLES: every player ran a local native snake, so all
   * player clients need the death screen + quit (not just the admin).
   * Race expiry: admin-only (spectators never had a local run).
   *
   * Deferred so it never dispatches from inside a socket handler. Once per
   * match — the latch clears on SESSION_START.
   */
  MultiplayerApp.prototype.releaseMenusAfterMatch = function (opts) {
    opts = opts || {};
    if (!Gsm.showDeathScreen) return;
    const self = this;
    function needsRelease() {
      const c = self.client;
      if (!c || !c.connected) return false;
      const me = c.me && c.me();
      if (!me || me.role !== "player") return false;
      // Match-end: ignore stale sessionActive (ROSTER can lag after ALL_DEAD).
      const matchEnded =
        !!opts.coopMatchEnd ||
        !!self._coopMatchEndHandled ||
        !!self._coopEndReason ||
        !!(typeof window !== "undefined" && window.__mpCoopMatchEndMenus);
      if (!matchEnded && c.roster && c.roster.sessionActive) return false;
      const mode = c.roster && c.roster.mode;
      // Co-op match end (or explicit coopMatchEnd): all players.
      if (opts.coopMatchEnd || matchEnded || mode === "coop") {
        return true;
      }
      // Race / other: only the admin who owned settings.
      if (!c.isAdmin || !c.isAdmin()) return false;
      return true;
    }
    if (this._adminMenusReleased || !needsRelease()) return;
    this._adminMenusReleased = true;
    setTimeout(function () {
      // A new match may have started in the meantime
      if (!needsRelease()) return;
      if (root.__mpEscHandling) return;
      if (self.ensureLobbyMatchMenusInteractive) {
        self.ensureLobbyMatchMenusInteractive({ force: true });
      } else {
        Gsm.showDeathScreen({});
      }
      // Co-op ALL_DEAD/ALL_APPLES: if chrome is still hidden, force a full quit.
      if (
        opts.coopMatchEnd &&
        Gsm.isDeathOverlayVisible &&
        !Gsm.isDeathOverlayVisible()
      ) {
        if (Gsm.quitNativeRunForMenus) {
          Gsm.quitNativeRunForMenus({ pulse: true });
        } else if (Gsm.showDeathScreen) {
          Gsm.showDeathScreen({ skipEscapeDispatch: false });
        }
      }
    }, 0);
  };

  /** @deprecated alias — callers / older tests */
  MultiplayerApp.prototype.releaseAdminMenusAfterMatch = function (opts) {
    return this.releaseMenusAfterMatch(opts);
  };

  MultiplayerApp.prototype.abortMatchAsAdmin = function (reason) {
    if (!this.client || !this.client.isAdmin()) return;
    // A UI click must always run: a stuck Escape latch used to swallow End
    // match and leave the admin with trophy/count/speed/size dead.
    if (reason === "ui") root.__mpEscHandling = false;
    if (root.__mpEscHandling) return;
    root.__mpEscHandling = true;
    try {
      if (this.client.roster) this.client.roster.sessionActive = false;
      this._coopSessionActive = false;
      if (typeof window !== "undefined") {
        window.__mpCoopSession = false;
        window.__mpCoopInject = false;
      }
      if (this.client.sessionEnd) this.client.sessionEnd(reason || "aborted");
      // Drop the hide we used for co-op corpses so Google's menu can come back
      if (Gsm.clearDeathOverlayOverrides) Gsm.clearDeathOverlayOverrides();
      if (Gsm.restoreDeathScreen) Gsm.restoreDeathScreen();
      this._adminMenusReleased = true;
      this.returnToMenus({ fromAdmin: true });
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
        // A Ready non-admin has frozen the shared setup: leave the row visually
        // available, but do not let a native menu click diverge locally.
        if (!self.client.isAdmin()) {
          const me = self.client.me && self.client.me();
          if (me && me.ready) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
          }
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
          ev.preventDefault();
          ev.stopPropagation();
          // Admin: native Play is Start Match / Start Co-op
          if (self.client.isAdmin() && self.canAdminStartMatch()) {
            self.startMatchAsAdmin();
          }
        },
        true
      );
    }
  };

  /** Spectators cannot steer the local game while watching Race/Co-op. */
  MultiplayerApp.prototype.hookSpectatorInputBlock = function () {
    const self = this;
    if (this._specInputHooked) return;
    this._specInputHooked = true;
    window.addEventListener(
      "keydown",
      function (ev) {
        const raceSpec =
          self._isRaceSpectator && self._isRaceSpectator();
        const coopSpec =
          typeof window !== "undefined" && !!window.__mpCoopSpectator;
        if (!raceSpec && !coopSpec) return;
        // Shared native / Focus canvas — swallow game controls
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

  root.MultiplayerApp = MultiplayerApp;
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
        if (Gsm.sanitizePostimgFruitUrls) {
          Gsm.sanitizePostimgFruitUrls();
          setTimeout(function () {
            if (Gsm.sanitizePostimgFruitUrls) Gsm.sanitizePostimgFruitUrls();
          }, 0);
          setTimeout(function () {
            if (Gsm.sanitizePostimgFruitUrls) Gsm.sanitizePostimgFruitUrls();
          }, 500);
        }
      } catch (eSan) { /* ignore */ }
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
        app.hookCoopNativeStartBlock();
        app.hookEscapeForAdmin();
        app.hookAdminSettingsWatch();
        app.hookSpectatorInputBlock();
        app.hookInGameColorPicker();
        app.hookInGameReadyButton();
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
