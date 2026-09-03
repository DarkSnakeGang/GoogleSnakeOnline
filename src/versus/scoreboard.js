/** Versus scoreboard + attempt timer client state. */
(function (root) {
  const GOALS = [
    { id: "score", label: "Score" },
    { id: "best25", label: "Best 25", threshold: 25 },
    { id: "best50", label: "Best 50", threshold: 50 },
    { id: "best100", label: "Best 100", threshold: 100 },
    { id: "bestAll", label: "Best All", all: true },
  ];

  function VersusState() {
    this.scores = {};
    this.attemptRemainingMs = null;
    this.expired = false;
    this.focusClientId = null;
    this.boards = {};
    this.spectateMode = "focus"; // focus | mosaic
    this.versusGoal = "score";
    this.leaderClientId = null;
    this.winnerClientId = null;
    /** Per-player mosaic run clocks: { startedAtMs, frozenMs }. */
    this.runClocks = {};
  }

  VersusState.GOALS = GOALS;

  VersusState.normalizeGoal = function (goal) {
    const id = String(goal || "score");
    const hit = GOALS.find(function (g) {
      return g.id === id;
    });
    return hit ? hit.id : "score";
  };

  VersusState.goalMeta = function (goal) {
    const id = VersusState.normalizeGoal(goal);
    return (
      GOALS.find(function (g) {
        return g.id === id;
      }) || GOALS[0]
    );
  };

  VersusState.goalLabel = function (goal) {
    return VersusState.goalMeta(goal).label;
  };

  VersusState.isTimedGoal = function (goal) {
    return VersusState.normalizeGoal(goal) !== "score";
  };

  VersusState.goalThreshold = function (goal) {
    const m = VersusState.goalMeta(goal);
    return m.threshold != null ? m.threshold : null;
  };

  /**
   * Pick leader/winner from local score map for the active goal.
   * Score → highest bestScore (tie: longer bestTimeMs).
   * Timed → fastest bestGoalTimeMs among completions.
   */
  VersusState.pickLeader = function (scores, goal) {
    const map = scores || {};
    const g = VersusState.normalizeGoal(goal);
    const ids = Object.keys(map);
    if (!ids.length) return null;

    if (VersusState.isTimedGoal(g)) {
      let bestId = null;
      let bestT = null;
      ids.forEach(function (id) {
        const sc = map[id];
        if (!sc || !sc.goalCompleted) return;
        const t = sc.bestGoalTimeMs;
        if (t == null || !Number.isFinite(Number(t))) return;
        if (bestT == null || Number(t) < bestT) {
          bestT = Number(t);
          bestId = id;
        }
      });
      return bestId;
    }

    let bestId = null;
    let bestS = null;
    let bestT = null;
    ids.forEach(function (id) {
      const sc = map[id];
      if (!sc) return;
      const s = sc.bestScore != null ? Number(sc.bestScore) : Number(sc.score) || 0;
      if (!s && !(sc.score > 0)) return;
      const t =
        sc.bestTimeMs != null
          ? Number(sc.bestTimeMs)
          : sc.timeMs != null
            ? Number(sc.timeMs)
            : 0;
      const better =
        bestS == null ||
        s > bestS ||
        (s === bestS && (bestT == null || t > bestT));
      if (better) {
        bestS = s;
        bestT = t;
        bestId = id;
      }
    });
    return bestId;
  };

  /** One-line best summary for roster / HUD under the active goal. */
  VersusState.formatGoalBest = function (sc, goal) {
    if (!sc) return "—";
    const g = VersusState.normalizeGoal(goal);
    if (VersusState.isTimedGoal(g)) {
      if (sc.bestGoalTimeMs == null) {
        return sc.goalCompleted ? "done" : "not yet";
      }
      return formatMs(sc.bestGoalTimeMs);
    }
    if (sc.bestScore != null) return String(sc.bestScore);
    if (sc.score != null) return String(sc.score);
    return "—";
  };

  /**
   * Rank clientIds by active goal (best first). Timed: completed by fastest
   * bestGoalTimeMs; Score: highest bestScore (tie → longer bestTimeMs).
   */
  VersusState.rankPlayers = function (scores, goal) {
    const map = scores || {};
    const g = VersusState.normalizeGoal(goal);
    const ids = Object.keys(map);
    const timed = VersusState.isTimedGoal(g);
    ids.sort(function (a, b) {
      const sa = map[a] || {};
      const sb = map[b] || {};
      if (timed) {
        const ca = !!sa.goalCompleted && sa.bestGoalTimeMs != null;
        const cb = !!sb.goalCompleted && sb.bestGoalTimeMs != null;
        if (ca !== cb) return ca ? -1 : 1;
        if (ca && cb) {
          return Number(sa.bestGoalTimeMs) - Number(sb.bestGoalTimeMs);
        }
        const aScore = sa.bestScore != null ? Number(sa.bestScore) : Number(sa.score) || 0;
        const bScore = sb.bestScore != null ? Number(sb.bestScore) : Number(sb.score) || 0;
        return bScore - aScore;
      }
      const aScore = sa.bestScore != null ? Number(sa.bestScore) : Number(sa.score) || 0;
      const bScore = sb.bestScore != null ? Number(sb.bestScore) : Number(sb.score) || 0;
      if (aScore !== bScore) return bScore - aScore;
      const aTime =
        sa.bestTimeMs != null
          ? Number(sa.bestTimeMs)
          : sa.timeMs != null
            ? Number(sa.timeMs)
            : 0;
      const bTime =
        sb.bestTimeMs != null
          ? Number(sb.bestTimeMs)
          : sb.timeMs != null
            ? Number(sb.timeMs)
            : 0;
      return bTime - aTime;
    });
    return ids;
  };

  /** "Score 42" / "Best 25 12.34s" for winner / place lines. */
  VersusState.formatGoalDetail = function (sc, goal) {
    const label = VersusState.goalLabel(goal);
    const best = VersusState.formatGoalBest(sc, goal);
    return label + " " + best;
  };

  function formatMs(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return "—";
    const t = Math.max(0, Math.floor(Number(ms) / 10) / 100);
    return t.toFixed(2) + "s";
  }

  VersusState.prototype.onScorePulse = function (payload) {
    if (!payload || !payload.clientId) return;
    if (payload.versusGoal) {
      this.versusGoal = VersusState.normalizeGoal(payload.versusGoal);
    }
    this.scores[payload.clientId] = {
      score: payload.score,
      timeMs: payload.timeMs,
      alive: payload.alive,
      bestScore: payload.bestScore,
      bestTimeMs: payload.bestTimeMs,
      bestGoalTimeMs: payload.bestGoalTimeMs,
      goalCompleted: !!payload.goalCompleted,
    };
    if (payload.leaderClientId !== undefined) {
      this.leaderClientId = payload.leaderClientId || null;
    } else {
      this.leaderClientId = VersusState.pickLeader(this.scores, this.versusGoal);
    }
    this._applyRunClockPulse(payload);
  };

  /**
   * Mosaic timers arm once at run start (runStartedAtMs) and tick locally.
   * Apple / periodic timeMs pulses must not jump the live clock.
   */
  VersusState.prototype._applyRunClockPulse = function (payload) {
    if (!payload || !payload.clientId) return;
    if (!this.runClocks) this.runClocks = {};
    const id = payload.clientId;
    const prev = this.runClocks[id] || {};
    const next = {
      startedAtMs: prev.startedAtMs != null ? prev.startedAtMs : null,
      frozenMs: prev.frozenMs != null ? prev.frozenMs : null,
    };
    if (
      payload.runStartedAtMs != null &&
      Number.isFinite(Number(payload.runStartedAtMs))
    ) {
      const started = Number(payload.runStartedAtMs);
      if (next.startedAtMs !== started) {
        next.startedAtMs = started;
        next.frozenMs = null;
      }
    }
    if (payload.alive === false) {
      if (
        payload.timeMs != null &&
        Number.isFinite(Number(payload.timeMs))
      ) {
        next.frozenMs = Number(payload.timeMs);
      } else if (next.startedAtMs != null && next.frozenMs == null) {
        next.frozenMs = Math.max(0, Date.now() - next.startedAtMs);
      }
    }
    this.runClocks[id] = next;
  };

  /** Elapsed ms for mosaic labels: local tick from start, or frozen on death. */
  VersusState.resolveRunClockMs = function (clock, nowMs, fallbackMs) {
    if (clock) {
      if (clock.frozenMs != null && Number.isFinite(Number(clock.frozenMs))) {
        return Math.max(0, Number(clock.frozenMs));
      }
      if (
        clock.startedAtMs != null &&
        Number.isFinite(Number(clock.startedAtMs))
      ) {
        const now =
          nowMs != null && Number.isFinite(Number(nowMs))
            ? Number(nowMs)
            : Date.now();
        return Math.max(0, now - Number(clock.startedAtMs));
      }
    }
    if (fallbackMs != null && Number.isFinite(Number(fallbackMs))) {
      return Number(fallbackMs);
    }
    return null;
  };

  VersusState.prototype.onAttemptTick = function (payload) {
    const ms = payload && payload.remainingMs;
    this.attemptRemainingMs =
      ms == null || !Number.isFinite(Number(ms)) ? null : Number(ms);
  };

  VersusState.prototype.onExpired = function (payload) {
    this.expired = true;
    if (payload && payload.winnerClientId) {
      this.winnerClientId = payload.winnerClientId;
      this.leaderClientId = payload.winnerClientId;
    } else {
      this.winnerClientId = VersusState.pickLeader(this.scores, this.versusGoal);
      this.leaderClientId = this.winnerClientId;
    }
    if (payload && payload.versusGoal) {
      this.versusGoal = VersusState.normalizeGoal(payload.versusGoal);
    }
  };

  VersusState.prototype.syncFromRoster = function (roster) {
    if (!roster) return;
    if (roster.versusGoal) {
      this.versusGoal = VersusState.normalizeGoal(roster.versusGoal);
    }
    if (roster.leaderClientId !== undefined) {
      this.leaderClientId = roster.leaderClientId || null;
    }
    if (roster.mode && roster.mode !== "versus") {
      this.attemptRemainingMs = null;
    }
    const hasScores = Object.keys(this.scores || {}).length > 0;
    if (!roster.sessionActive) {
      this.attemptRemainingMs = null;
      // Between matches: keep last-attempt results until SESSION_START clears them
      if (roster.attemptExpired || hasScores) {
        this.expired = true;
        if (!this.winnerClientId) {
          this.winnerClientId =
            roster.leaderClientId ||
            VersusState.pickLeader(this.scores, this.versusGoal);
        }
      } else if (roster.allowNewRuns !== false) {
        this.expired = false;
        this.winnerClientId = null;
      }
    }
    if (roster.allowNewRuns === false || roster.attemptExpired === true) {
      this.expired = true;
      if (!this.winnerClientId) {
        this.winnerClientId =
          roster.leaderClientId ||
          VersusState.pickLeader(this.scores, this.versusGoal);
      }
    } else if (
      roster.sessionActive &&
      roster.allowNewRuns === true &&
      !roster.attemptExpired
    ) {
      // Live attempt in progress
      this.expired = false;
      this.winnerClientId = null;
    }
  };

  /** Clear board/score state for a brand-new Start match. */
  VersusState.prototype.resetForNewMatch = function () {
    this.scores = {};
    this.boards = {};
    this.runClocks = {};
    this.expired = false;
    this.attemptRemainingMs = null;
    this.leaderClientId = null;
    this.winnerClientId = null;
  };

  /** Format a player's run timer (SpeedInfo-style). */
  VersusState.formatRunClock = function (ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return "—";
    const total = Math.max(0, Math.floor(Number(ms)));
    // Guard against wall-clock timestamps accidentally treated as durations
    if (total > 24 * 60 * 60 * 1000) return "—";
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const tenths = Math.floor((total % 1000) / 100);
    if (m > 0) {
      return m + ":" + String(s).padStart(2, "0") + "." + tenths;
    }
    return s + "." + tenths + "s";
  };

  /** Format remaining attempt time as MM:SS. */
  VersusState.formatAttemptClock = function (remainingMs, expired) {
    if (expired) return "00:00";
    if (remainingMs == null || !Number.isFinite(Number(remainingMs))) return null;
    const s = Math.max(0, Math.ceil(Number(remainingMs) / 1000));
    return (
      String(Math.floor(s / 60)).padStart(2, "0") +
      ":" +
      String(s % 60).padStart(2, "0")
    );
  };

  VersusState.prototype.onBoardDelta = function (payload) {
    if (!payload) return;
    const id = payload.clientId;
    const board = payload.board || payload;
    if (id) this.boards[id] = board;
  };

  VersusState.prototype.onBoardSnapshot = function (payload) {
    this.onBoardDelta(payload);
  };

  VersusState.prototype.setFocus = function (clientId) {
    this.focusClientId = clientId;
  };

  VersusState.prototype.focusBoard = function () {
    if (!this.focusClientId) return null;
    return this.boards[this.focusClientId] || null;
  };

  VersusState.prototype.playerIdsWithBoards = function () {
    return Object.keys(this.boards);
  };

  VersusState.prototype.setSpectateMode = function (mode) {
    this.spectateMode = mode === "mosaic" ? "mosaic" : "focus";
  };

  /**
   * Versus session TimeKeeper — SpeedInfo shows this match's bests, not lifetime
   * Pudding/Remix PBs. Session beats that improve remix are promoted on death/ALL.
   */
  const VERSUS_TK_KEY = "snake_timeKeeper_versus_session";
  const REMIX_TK_KEY = "snake_timeKeeper_remix";

  const VersusTimeKeeper = {
    KEY: VERSUS_TK_KEY,
    REMIX_KEY: REMIX_TK_KEY,
    _active: false,

    isActive: function () {
      return !!this._active;
    },

    setActive: function (on) {
      this._active = !!on;
      const tk = root.timeKeeper;
      if (tk) {
        tk._mpVersusCache = null;
        // Force remix path to re-read if leaving session mode
        if (!on) tk._storageCache = null;
      }
    },

    clearSession: function () {
      try {
        localStorage.setItem(VERSUS_TK_KEY, JSON.stringify({ version: 4 }));
      } catch (e) { /* ignore */ }
      const tk = root.timeKeeper;
      if (tk) tk._mpVersusCache = null;
    },

    beginMatch: function () {
      this.clearSession();
      this.setActive(true);
      if (root.timeKeeper && typeof root.timeKeeper.refreshSpeedInfo === "function") {
        try {
          root.timeKeeper.refreshSpeedInfo();
        } catch (e) { /* ignore */ }
      }
    },

    endMode: function () {
      this.setActive(false);
      if (root.timeKeeper && typeof root.timeKeeper.refreshSpeedInfo === "function") {
        try {
          root.timeKeeper.refreshSpeedInfo();
        } catch (e) { /* ignore */ }
      }
    },

    loadSession: function () {
      try {
        return JSON.parse(localStorage.getItem(VERSUS_TK_KEY) || '{"version":4}');
      } catch (e) {
        return { version: 4 };
      }
    },

    loadRemix: function () {
      try {
        return JSON.parse(localStorage.getItem(REMIX_TK_KEY) || '{"version":4}');
      } catch (e) {
        return { version: 4 };
      }
    },

    /**
     * Copy session timed PBs / highscore into remix when they beat lifetime.
     * Never writes opponents' times — only local session storage.
     */
    promoteSessionToRemix: function () {
      const session = this.loadSession();
      const remix = this.loadRemix();
      let changed = false;
      Object.keys(session).forEach(function (key) {
        if (!key || key === "version") return;
        const s = session[key];
        if (!s || typeof s !== "object") return;
        const r = remix[key];
        if (key.indexOf("att-") === 0) return; // attempts stay session-only
        if (key.indexOf("H-") === 0) {
          // Highscore: higher score wins; tie → longer survival time
          const sScore = s.score != null ? Number(s.score) : 0;
          const rScore = r && r.score != null ? Number(r.score) : -1;
          const sTime = s.time != null ? Number(s.time) : 0;
          const rTime = r && r.time != null ? Number(r.time) : 0;
          if (!r || sScore > rScore || (sScore === rScore && sTime > rTime)) {
            remix[key] = Object.assign({}, s);
            changed = true;
          }
          return;
        }
        // Timed PB (25/50/100/ALL): lower time is better
        if (s.time == null || !Number.isFinite(Number(s.time))) return;
        if (!r || r.time == null || Number(s.time) < Number(r.time)) {
          remix[key] = Object.assign({}, s);
          changed = true;
        }
      });
      if (changed) {
        try {
          localStorage.setItem(REMIX_TK_KEY, JSON.stringify(remix));
          const tk = root.timeKeeper;
          if (tk) tk._storageCache = null;
        } catch (e) {
          console.warn("versus PB promote failed", e);
          return false;
        }
      }
      return changed;
    },

    /** Redirect timeKeeper get/set/flush to session storage while versus match TK is active. */
    install: function () {
      const tk = root.timeKeeper;
      if (!tk || tk.__mpVersusTkInstalled) return false;
      tk.__mpVersusTkInstalled = true;
      const self = this;
      const origGet = tk.getStorage && tk.getStorage.bind(tk);
      const origSet = tk.setStorage && tk.setStorage.bind(tk);
      const origFlush = tk.flushStorage && tk.flushStorage.bind(tk);

      tk.getStorage = function () {
        if (!self.isActive()) {
          return origGet ? origGet() : {};
        }
        if (!tk._mpVersusCache) {
          tk._mpVersusCache = self.loadSession();
        }
        return tk._mpVersusCache;
      };
      tk.setStorage = function (storage) {
        if (!self.isActive()) {
          return origSet ? origSet(storage) : undefined;
        }
        tk._mpVersusCache = storage || { version: 4 };
        try {
          localStorage.setItem(VERSUS_TK_KEY, JSON.stringify(tk._mpVersusCache));
        } catch (e) { /* ignore */ }
        tk._storageDirty = false;
      };
      if (origFlush) {
        tk.flushStorage = function () {
          if (!self.isActive()) return origFlush();
          if (!tk._storageDirty || !tk._mpVersusCache) return;
          try {
            localStorage.setItem(VERSUS_TK_KEY, JSON.stringify(tk._mpVersusCache));
          } catch (e) { /* ignore */ }
          tk._storageDirty = false;
        };
      }
      return true;
    },
  };

  root.VersusTimeKeeper = VersusTimeKeeper;

  /** @deprecated use VersusTimeKeeper.promoteSessionToRemix */
  VersusState.maybePromoteLocalPb = function () {
    return VersusTimeKeeper.promoteSessionToRemix();
  };

  root.VersusState = VersusState;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = VersusState;
    module.exports.VersusTimeKeeper = VersusTimeKeeper;
  }
})(typeof window !== "undefined" ? window : globalThis);
