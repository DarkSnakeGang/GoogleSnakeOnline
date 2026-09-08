/** Co-op client: apply server state, input. TimeKeeper is in-memory only. */
(function (root) {
  const COOP_TK_KEY = "snake_timeKeeper_coop";
  const AUTHORITIES = {
    SERVER_SIM: "server-sim-v1",
    NATIVE_RELAY: "native-relay-v1",
  };

  function validInt(value, min) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= (min == null ? 0 : min) ? n : null;
  }

  function validAuthority(value) {
    return value === AUTHORITIES.SERVER_SIM || value === AUTHORITIES.NATIVE_RELAY;
  }

  function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
      if (arguments[i] !== null && arguments[i] !== undefined) {
        return arguments[i];
      }
    }
    return null;
  }

  function sessionValues(current, payload, generation) {
    const revision = validInt(
      payload.boardRevision != null ? payload.boardRevision : payload.revision,
      0
    );
    const speedEpoch = validInt(payload.speedEpoch, 0);
    let timer = current.timerStartedAtMs;
    if (payload.timerStartedAtMs != null) {
      const n = Number(payload.timerStartedAtMs);
      timer = Number.isFinite(n) ? n : null;
    }
    return {
      authority: payload.authority,
      generation: generation,
      settings:
        payload.settings !== null && payload.settings !== undefined
          ? payload.settings
          : current.settings || {},
      slots: Array.isArray(payload.slots)
        ? payload.slots.slice()
        : current.slots.slice(),
      collectablesOwnerId:
        payload.collectablesOwnerId !== undefined
          ? payload.collectablesOwnerId
          : current.collectablesOwnerId,
      boardRevision:
        revision == null ? current.boardRevision : revision,
      boardReady:
        payload.boardReady !== undefined
          ? payload.boardReady === true
          : current.boardReady,
      speedEpoch: speedEpoch == null ? current.speedEpoch : speedEpoch,
      speedState: firstDefined(
        payload.effectiveSpeed,
        payload.speedState,
        current.speedState
      ),
      timerStartedAtMs: timer,
    };
  }

  function assignSessionValues(target, values) {
    [
      "authority",
      "generation",
      "settings",
      "slots",
      "collectablesOwnerId",
      "boardRevision",
      "boardReady",
      "speedEpoch",
      "speedState",
      "timerStartedAtMs",
    ].forEach(function (key) {
      target[key] = values[key];
    });
  }

  function CoopState() {
    this.snapshot = null;
    this.myClientId = null;
    this.authority = null;
    this.generation = 0;
    this.settings = null;
    this.slots = [];
    this.collectablesOwnerId = null;
    this.boardRevision = 0;
    this.boardReady = false;
    this.speedEpoch = 0;
    this.speedState = null;
    this.timerStartedAtMs = null;
    this.peerPoseSeq = Object.create(null);
    this.peerTurns = Object.create(null);
    this.sourceSpeedEvents = Object.create(null);
    this.resyncing = false;
    this._resyncStage = null;
  }

  CoopState.prototype.apply = function (payload) {
    this.snapshot = payload;
  };

  CoopState.prototype.applySession = function (payload) {
    if (!payload || !validAuthority(payload.authority)) {
      return { ok: false, reason: "invalid_authority" };
    }
    const generation = validInt(payload.generation, 1);
    if (generation == null) return { ok: false, reason: "invalid_generation" };
    const resync = payload.resync === true;
    if (this.generation && generation < this.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    if (this.generation === generation && this.authority &&
        this.authority !== payload.authority) {
      return { ok: false, reason: "authority_changed" };
    }
    const fresh = generation !== this.generation;
    if (resync && payload.authority === AUTHORITIES.NATIVE_RELAY) {
      const values = sessionValues(this, payload, generation);
      this.resyncing = true;
      this._resyncStage = Object.assign(values, {
        peerPoseSeq: Object.create(null),
        peerTurns: Object.create(null),
        sourceSpeedEvents: Object.create(null),
        boardPayload: null,
        boardReadyPayload: null,
        poses: Object.create(null),
        timerPayload: null,
        speedPayload: null,
      });
      return { ok: true, fresh: fresh, resync: true };
    }
    if (fresh) {
      this.snapshot = null;
      this.peerPoseSeq = Object.create(null);
      this.peerTurns = Object.create(null);
      this.sourceSpeedEvents = Object.create(null);
      this.timerStartedAtMs = null;
    }
    this.resyncing = false;
    this._resyncStage = null;
    assignSessionValues(this, sessionValues(this, payload, generation));
    return { ok: true, fresh: fresh, resync: resync };
  };

  CoopState.prototype.acceptGeneration = function (payload) {
    const generation =
      this.resyncing && this._resyncStage
        ? this._resyncStage.generation
        : this.generation;
    return !!(
      payload &&
      validInt(payload.generation, 1) === generation
    );
  };

  CoopState.prototype.acceptPose = function (payload) {
    if (!this.acceptGeneration(payload) || !payload.clientId) return false;
    const seqs =
      this.resyncing && this._resyncStage
        ? this._resyncStage.peerPoseSeq
        : this.peerPoseSeq;
    const seq = validInt(payload.poseSeq, 1);
    if (seq == null || seq <= (seqs[payload.clientId] || 0)) {
      return false;
    }
    seqs[payload.clientId] = seq;
    const turns =
      this.resyncing && this._resyncStage
        ? this._resyncStage.peerTurns
        : this.peerTurns;
    const merge =
      typeof root.mergeCoopPoseTurns === "function"
        ? root.mergeCoopPoseTurns
        : function (_previous, incoming) {
            return Array.isArray(incoming) ? incoming.slice(-8) : [];
          };
    payload.turns = merge(turns[payload.clientId], payload.turns);
    turns[payload.clientId] = payload.turns;
    if (this.resyncing && this._resyncStage) {
      this._resyncStage.poses[payload.clientId] = payload;
    }
    return true;
  };

  CoopState.prototype.stageDeath = function (payload) {
    if (!this.acceptGeneration(payload) || !payload.clientId) return false;
    if (payload.poseSeq != null) return this.acceptPose(payload);
    if (this.resyncing && this._resyncStage) {
      this._resyncStage.poses[payload.clientId] = payload;
    }
    return true;
  };

  CoopState.prototype.applyBoard = function (payload) {
    if (!this.acceptGeneration(payload)) return false;
    const target =
      this.resyncing && this._resyncStage ? this._resyncStage : this;
    const revision = validInt(
      payload.revision != null ? payload.revision : payload.boardRevision,
      1
    );
    if (revision == null || revision < target.boardRevision) return false;
    target.boardRevision = revision;
    if (payload.boardReady === true) target.boardReady = true;
    if (
      this.resyncing &&
      this._resyncStage &&
      (payload.initial === true ||
        Array.isArray(payload.collectables) ||
        Array.isArray(payload.apples))
    ) {
      this._resyncStage.boardPayload = payload;
    }
    return true;
  };

  CoopState.prototype.applyBoardReady = function (payload) {
    if (!this.applyBoard(payload)) return false;
    const target =
      this.resyncing && this._resyncStage ? this._resyncStage : this;
    target.boardReady = true;
    if (this.resyncing && this._resyncStage) {
      this._resyncStage.boardReadyPayload = payload;
    }
    return true;
  };

  CoopState.prototype.applySpeed = function (payload) {
    if (!this.acceptGeneration(payload)) return false;
    const target =
      this.resyncing && this._resyncStage ? this._resyncStage : this;
    const isReplay = payload.resync === true;
    const epoch = validInt(payload.speedEpoch, isReplay ? 0 : 1);
    if (
      epoch == null ||
      epoch < target.speedEpoch ||
      (epoch === target.speedEpoch && !isReplay)
    ) return false;
    const source = payload.sourceEventId && String(payload.sourceEventId);
    if (source && target.sourceSpeedEvents[source]) return false;
    if (source) target.sourceSpeedEvents[source] = true;
    target.speedEpoch = epoch;
    target.speedState = firstDefined(
      payload.effectiveSpeed,
      payload.speedState,
      payload.intervalMs
    );
    if (this.resyncing && this._resyncStage) {
      this._resyncStage.speedPayload = payload;
    }
    return true;
  };

  CoopState.prototype.stageTimer = function (payload) {
    if (!this.acceptGeneration(payload)) return false;
    const value = Number(payload.timerStartedAtMs);
    if (!Number.isFinite(value)) return false;
    if (this.resyncing && this._resyncStage) {
      this._resyncStage.timerStartedAtMs = value;
      this._resyncStage.timerPayload = payload;
    } else {
      this.timerStartedAtMs = value;
    }
    return true;
  };

  CoopState.prototype.commitResync = function () {
    if (!this.resyncing || !this._resyncStage) return null;
    const stage = this._resyncStage;
    assignSessionValues(this, stage);
    this.peerPoseSeq = stage.peerPoseSeq;
    this.peerTurns = stage.peerTurns;
    this.sourceSpeedEvents = stage.sourceSpeedEvents;
    this.resyncing = false;
    this._resyncStage = null;
    return {
      board: stage.boardPayload,
      boardReady: stage.boardReadyPayload,
      poses: Object.keys(stage.poses).map(function (id) {
        return stage.poses[id];
      }),
      timer: stage.timerPayload,
      speed: stage.speedPayload,
    };
  };

  CoopState.prototype.reset = function () {
    this.snapshot = null;
    this.authority = null;
    this.generation = 0;
    this.settings = null;
    this.slots = [];
    this.collectablesOwnerId = null;
    this.boardRevision = 0;
    this.boardReady = false;
    this.speedEpoch = 0;
    this.speedState = null;
    this.timerStartedAtMs = null;
    this.peerPoseSeq = Object.create(null);
    this.peerTurns = Object.create(null);
    this.sourceSpeedEvents = Object.create(null);
    this.resyncing = false;
    this._resyncStage = null;
  };

  CoopState.prototype.mySnake = function () {
    if (!this.snapshot || !this.snapshot.snakes) return null;
    const id = this.myClientId;
    return this.snapshot.snakes.find(function (s) {
      return s.client_id === id || s.clientId === id;
    });
  };

  CoopState.prototype.myColorId = function () {
    const s = this.mySnake();
    return s ? s.color_id != null ? s.color_id : s.colorId : null;
  };

  /** Never read coop PB storage — co-op must not touch localStorage. */
  function loadCoopTimes() {
    return {};
  }

  /** Never write coop / remix PB storage from co-op. */
  function saveCoopTime() {
    return false;
  }

  root.CoopState = CoopState;
  root.CoopTimeKeeper = {
    KEY: COOP_TK_KEY,
    REMIX_KEY: "snake_timeKeeper_remix",
    load: loadCoopTimes,
    save: saveCoopTime,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CoopState: CoopState,
      CoopTimeKeeper: root.CoopTimeKeeper,
      CoopAuthorities: AUTHORITIES,
    };
  }
  root.CoopAuthorities = AUTHORITIES;
})(typeof window !== "undefined" ? window : globalThis);
