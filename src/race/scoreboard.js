/** Race scoreboard + attempt timer client state. */
(function (root) {
  const GOALS = [
    { id: "score", label: "Score" },
    { id: "best25", label: "Best 25", threshold: 25 },
    { id: "best50", label: "Best 50", threshold: 50 },
    { id: "best100", label: "Best 100", threshold: 100 },
    { id: "bestAll", label: "Best All", all: true },
  ];

  function RaceState() {
    this.scores = {};
    this.attemptRemainingMs = null;
    this.expired = false;
    this.finishOngoing = false;
    this.focusClientId = null;
    this.boards = {};
    this.spectateMode = "focus"; // focus | mosaic
    this.raceGoal = "score";
    this.leaderClientId = null;
    this.winnerClientId = null;
    /** Per-player mosaic run clocks: { startedAtMs, frozenMs }. */
    this.runClocks = {};
  }

  RaceState.GOALS = GOALS;

  RaceState.normalizeGoal = function (goal) {
    const id = String(goal || "score");
    const hit = GOALS.find(function (g) {
      return g.id === id;
    });
    return hit ? hit.id : "score";
  };

  RaceState.goalMeta = function (goal) {
    const id = RaceState.normalizeGoal(goal);
    return (
      GOALS.find(function (g) {
        return g.id === id;
      }) || GOALS[0]
    );
  };

  RaceState.goalLabel = function (goal) {
    return RaceState.goalMeta(goal).label;
  };

  RaceState.isTimedGoal = function (goal) {
    return RaceState.normalizeGoal(goal) !== "score";
  };

  RaceState.goalThreshold = function (goal) {
    const m = RaceState.goalMeta(goal);
    return m.threshold != null ? m.threshold : null;
  };

  function scoreOf(sc) {
    if (!sc) return 0;
    if (sc.bestScore != null) return Number(sc.bestScore) || 0;
    return Number(sc.score) || 0;
  }

  /** Time at which a player reached their best score (null when unknown). */
  function bestScoreTimeOf(sc) {
    const t = sc && sc.bestScoreTimeMs;
    if (t == null || !Number.isFinite(Number(t)) || Number(t) <= 0) return null;
    return Number(t);
  }

  /** Highest score first, then the player who got there fastest. */
  function compareScoreThenFastest(sa, sb) {
    const diff = scoreOf(sb) - scoreOf(sa);
    if (diff !== 0) return diff;
    const ta = bestScoreTimeOf(sa);
    const tb = bestScoreTimeOf(sb);
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
  }

  /** Best scorer (fastest on ties) — the fallback when nobody hits a timed goal. */
  function pickTopScorer(map, ids) {
    let bestId = null;
    ids.forEach(function (id) {
      const sc = map[id];
      if (!sc) return;
      if (!scoreOf(sc) && !(sc.score > 0)) return;
      if (bestId == null || compareScoreThenFastest(sc, map[bestId]) < 0) {
        bestId = id;
      }
    });
    return bestId;
  }

  /**
   * Pick leader/winner from local score map for the active goal.
   * Score → highest bestScore (tie: longer bestTimeMs).
   * Timed → fastest bestGoalTimeMs among completions; if nobody completed the
   * goal, the highest score wins, with the fastest time to it breaking ties.
   */
  RaceState.pickLeader = function (scores, goal) {
    const map = scores || {};
    const g = RaceState.normalizeGoal(goal);
    const ids = Object.keys(map);
    if (!ids.length) return null;

    if (RaceState.isTimedGoal(g)) {
      let bestId = null;
      let bestT = null;
      ids.forEach(function (id) {
        const sc = map[id];
        if (!sc || !sc.goalCompleted) return;
        const t = sc.bestGoalTimeMs;
        if (t == null || !Number.isFinite(Number(t)) || !(Number(t) > 0)) return;
        if (bestT == null || Number(t) < bestT) {
          bestT = Number(t);
          bestId = id;
        }
      });
      return bestId || pickTopScorer(map, ids);
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
  RaceState.formatGoalBest = function (sc, goal) {
    if (!sc) return "—";
    const g = RaceState.normalizeGoal(goal);
    if (RaceState.isTimedGoal(g)) {
      const goalMs = Number(sc.bestGoalTimeMs);
      // 0ms is impossible for Best 25/50/100 — treat as unset
      if (Number.isFinite(goalMs) && goalMs > 0) {
        return formatMs(goalMs);
      }
      if (sc.goalCompleted && sc.bestGoalTimeMs == null) return "done";
      // Goal not reached (or stale 0.00s PB) — show the score that counts
      const s = scoreOf(sc);
      if (!s) return "not yet";
      const t = bestScoreTimeOf(sc);
      return s + " apples" + (t != null ? " (" + formatMs(t) + ")" : "");
    }
    if (sc.bestScore != null) return String(sc.bestScore);
    if (sc.score != null) return String(sc.score);
    return "—";
  };

  /**
   * Rank clientIds by active goal (best first). Timed: completed by fastest
   * bestGoalTimeMs, then everyone else by highest score / fastest time to it;
   * Score: highest bestScore (tie → longer bestTimeMs).
   */
  RaceState.rankPlayers = function (scores, goal) {
    const map = scores || {};
    const g = RaceState.normalizeGoal(goal);
    const ids = Object.keys(map);
    const timed = RaceState.isTimedGoal(g);
    ids.sort(function (a, b) {
      const sa = map[a] || {};
      const sb = map[b] || {};
      if (timed) {
        const ca =
          !!sa.goalCompleted &&
          sa.bestGoalTimeMs != null &&
          Number(sa.bestGoalTimeMs) > 0;
        const cb =
          !!sb.goalCompleted &&
          sb.bestGoalTimeMs != null &&
          Number(sb.bestGoalTimeMs) > 0;
        if (ca !== cb) return ca ? -1 : 1;
        if (ca && cb) {
          return Number(sa.bestGoalTimeMs) - Number(sb.bestGoalTimeMs);
        }
        return compareScoreThenFastest(sa, sb);
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
  RaceState.formatGoalDetail = function (sc, goal) {
    const label = RaceState.goalLabel(goal);
    const best = RaceState.formatGoalBest(sc, goal);
    return label + " " + best;
  };

  function formatMs(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return "—";
    const t = Math.max(0, Math.floor(Number(ms) / 10) / 100);
    return t.toFixed(2) + "s";
  }

  RaceState.prototype.onScorePulse = function (payload) {
    if (!payload || !payload.clientId) return;
    if (payload.raceGoal) {
      this.raceGoal = RaceState.normalizeGoal(payload.raceGoal);
    }
    this.scores[payload.clientId] = {
      score: payload.score,
      timeMs: payload.timeMs,
      alive: payload.alive,
      bestScore: payload.bestScore,
      bestTimeMs: payload.bestTimeMs,
      bestScoreTimeMs: payload.bestScoreTimeMs,
      bestGoalTimeMs: payload.bestGoalTimeMs,
      goalCompleted: !!payload.goalCompleted,
    };
    if (payload.leaderClientId !== undefined) {
      this.leaderClientId = payload.leaderClientId || null;
    } else {
      this.leaderClientId = RaceState.pickLeader(this.scores, this.raceGoal);
    }
    this._applyRunClockPulse(payload);
  };

  /**
   * Mosaic/Focus run clocks track each player's in-game timer (ticks×Fb).
   * SCORE_PULSE / BOARD_DELTA re-anchor liveMs; labels show that value so the
   * clock advances on the same cadence as the on-screen run timer.
   */
  RaceState.prototype._applyRunClockPulse = function (payload) {
    if (!payload || !payload.clientId) return;
    if (!this.runClocks) this.runClocks = {};
    const id = payload.clientId;
    const prev = this.runClocks[id] || {};
    const next = {
      startedAtMs: prev.startedAtMs != null ? prev.startedAtMs : null,
      liveMs: prev.liveMs != null ? prev.liveMs : null,
      syncedAtMs: prev.syncedAtMs != null ? prev.syncedAtMs : null,
      frozenMs: prev.frozenMs != null ? prev.frozenMs : null,
    };
    const now = Date.now();
    if (
      payload.runStartedAtMs != null &&
      Number.isFinite(Number(payload.runStartedAtMs))
    ) {
      const started = Number(payload.runStartedAtMs);
      if (next.startedAtMs !== started) {
        next.startedAtMs = started;
        next.frozenMs = null;
        next.liveMs = 0;
        next.syncedAtMs = now;
      }
    }
    const timeOk =
      payload.timeMs != null && Number.isFinite(Number(payload.timeMs));
    const timeMs = timeOk ? Math.max(0, Number(payload.timeMs)) : null;
    if (payload.alive === false) {
      if (timeMs != null) next.frozenMs = timeMs;
      else if (next.frozenMs == null) {
        next.frozenMs = RaceState.resolveRunClockMs(next, now, 0) || 0;
      }
    } else {
      // Live again — never keep a death freeze across a new / continuing run
      next.frozenMs = null;
      if (timeMs != null) {
        next.liveMs = timeMs;
        next.syncedAtMs = now;
      }
    }
    this.runClocks[id] = next;
  };

  /** Elapsed ms for mosaic labels: frozen death time, or last live in-game sync. */
  RaceState.resolveRunClockMs = function (clock, nowMs, fallbackMs) {
    if (clock) {
      if (clock.frozenMs != null && Number.isFinite(Number(clock.frozenMs))) {
        return Math.max(0, Number(clock.frozenMs));
      }
      if (clock.liveMs != null && Number.isFinite(Number(clock.liveMs))) {
        return Math.max(0, Number(clock.liveMs));
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

  RaceState.prototype.onAttemptTick = function (payload) {
    const ms = payload && payload.remainingMs;
    this.attemptRemainingMs =
      ms == null || !Number.isFinite(Number(ms)) ? null : Number(ms);
  };

  RaceState.prototype.onExpired = function (payload) {
    this.expired = true;
    this.finishOngoing = !!(payload && payload.finishOngoing);
    if (payload && payload.winnerClientId) {
      this.winnerClientId = payload.winnerClientId;
      this.leaderClientId = payload.winnerClientId;
    } else {
      this.winnerClientId = RaceState.pickLeader(this.scores, this.raceGoal);
      this.leaderClientId = this.winnerClientId;
    }
    if (payload && payload.raceGoal) {
      this.raceGoal = RaceState.normalizeGoal(payload.raceGoal);
    }
  };

  RaceState.prototype.syncFromRoster = function (roster) {
    if (!roster) return;
    if (roster.raceGoal) {
      this.raceGoal = RaceState.normalizeGoal(roster.raceGoal);
    }
    if (roster.leaderClientId !== undefined) {
      this.leaderClientId = roster.leaderClientId || null;
    }
    if (roster.mode && roster.mode !== "race") {
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
            RaceState.pickLeader(this.scores, this.raceGoal);
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
          RaceState.pickLeader(this.scores, this.raceGoal);
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
  RaceState.prototype.resetForNewMatch = function () {
    this.scores = {};
    this.boards = {};
    this.runClocks = {};
    this.expired = false;
    this.finishOngoing = false;
    this.attemptRemainingMs = null;
    this.leaderClientId = null;
    this.winnerClientId = null;
  };

  /** Format a player's run timer (SpeedInfo-style hundredths). */
  RaceState.formatRunClock = function (ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return "—";
    const total = Math.max(0, Math.floor(Number(ms)));
    // Guard against wall-clock timestamps accidentally treated as durations
    if (total > 24 * 60 * 60 * 1000) return "—";
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const hundredths = Math.floor((total % 1000) / 10);
    const frac = String(hundredths).padStart(2, "0");
    if (m > 0) {
      return m + ":" + String(s).padStart(2, "0") + "." + frac;
    }
    return s + "." + frac + "s";
  };

  /** Format remaining attempt time as MM:SS. */
  RaceState.formatAttemptClock = function (remainingMs, expired) {
    if (expired) return "00:00";
    if (remainingMs == null || !Number.isFinite(Number(remainingMs))) return null;
    const s = Math.max(0, Math.ceil(Number(remainingMs) / 1000));
    return (
      String(Math.floor(s / 60)).padStart(2, "0") +
      ":" +
      String(s % 60).padStart(2, "0")
    );
  };

  RaceState.prototype.onBoardDelta = function (payload) {
    if (!payload) return;
    const id = payload.clientId;
    const board = payload.board || payload;
    if (id) this.boards[id] = board;
    // Board scrapes carry live ticks×Fb — keep mosaic clocks aligned every tick
    if (id && board && typeof this._applyRunClockPulse === "function") {
      this._applyRunClockPulse({
        clientId: id,
        timeMs: board.timeMs,
        alive: board.alive !== false,
        runStartedAtMs: board.runStartedAtMs,
      });
    }
  };

  RaceState.prototype.onBoardSnapshot = function (payload) {
    this.onBoardDelta(payload);
  };

  RaceState.prototype.setFocus = function (clientId) {
    this.focusClientId = clientId;
  };

  RaceState.prototype.focusBoard = function () {
    if (!this.focusClientId) return null;
    return this.boards[this.focusClientId] || null;
  };

  RaceState.prototype.playerIdsWithBoards = function () {
    return Object.keys(this.boards);
  };

  RaceState.prototype.setSpectateMode = function (mode) {
    this.spectateMode = mode === "mosaic" ? "mosaic" : "focus";
  };

  /**
   * Race session TimeKeeper — SpeedInfo shows this match's bests, not lifetime
   * Pudding/Remix PBs. Session beats that improve remix are promoted on death/ALL.
   */
  const RACE_TK_KEY = "snake_timeKeeper_race_session";
  const REMIX_TK_KEY = "snake_timeKeeper_remix";

  const RaceTimeKeeper = {
    KEY: RACE_TK_KEY,
    REMIX_KEY: REMIX_TK_KEY,
    _active: false,

    isActive: function () {
      return !!this._active;
    },

    setActive: function (on) {
      this._active = !!on;
      const tk = root.timeKeeper;
      if (tk) {
        tk._mpRaceCache = null;
        // Force remix path to re-read if leaving session mode
        if (!on) tk._storageCache = null;
      }
    },

    clearSession: function () {
      try {
        localStorage.setItem(RACE_TK_KEY, JSON.stringify({ version: 4 }));
      } catch (e) { /* ignore */ }
      const tk = root.timeKeeper;
      if (tk) tk._mpRaceCache = null;
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
        return JSON.parse(localStorage.getItem(RACE_TK_KEY) || '{"version":4}');
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
          console.warn("race PB promote failed", e);
          return false;
        }
      }
      return changed;
    },

    /** Redirect timeKeeper get/set/flush to session storage while race match TK is active. */
    install: function () {
      const tk = root.timeKeeper;
      if (!tk || tk.__mpRaceTkInstalled) return false;
      tk.__mpRaceTkInstalled = true;
      const self = this;
      const origGet = tk.getStorage && tk.getStorage.bind(tk);
      const origSet = tk.setStorage && tk.setStorage.bind(tk);
      const origFlush = tk.flushStorage && tk.flushStorage.bind(tk);

      tk.getStorage = function () {
        if (!self.isActive()) {
          return origGet ? origGet() : {};
        }
        if (!tk._mpRaceCache) {
          tk._mpRaceCache = self.loadSession();
        }
        return tk._mpRaceCache;
      };
      tk.setStorage = function (storage) {
        if (!self.isActive()) {
          return origSet ? origSet(storage) : undefined;
        }
        tk._mpRaceCache = storage || { version: 4 };
        try {
          localStorage.setItem(RACE_TK_KEY, JSON.stringify(tk._mpRaceCache));
        } catch (e) { /* ignore */ }
        tk._storageDirty = false;
      };
      if (origFlush) {
        tk.flushStorage = function () {
          if (!self.isActive()) return origFlush();
          if (!tk._storageDirty || !tk._mpRaceCache) return;
          try {
            localStorage.setItem(RACE_TK_KEY, JSON.stringify(tk._mpRaceCache));
          } catch (e) { /* ignore */ }
          tk._storageDirty = false;
        };
      }
      return true;
    },
  };

  root.RaceTimeKeeper = RaceTimeKeeper;

  /** @deprecated use RaceTimeKeeper.promoteSessionToRemix */
  RaceState.maybePromoteLocalPb = function () {
    return RaceTimeKeeper.promoteSessionToRemix();
  };

  root.RaceState = RaceState;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RaceState;
    module.exports.RaceTimeKeeper = RaceTimeKeeper;
  }
})(typeof window !== "undefined" ? window : globalThis);
