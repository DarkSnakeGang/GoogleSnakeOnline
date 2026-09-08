/**
 * Co-op session / death authority state machine.
 * Lobby → Seating → Live → Ending → Lobby
 *
 * Death only from real native death / friendly hit / explicit quit —
 * never from shared-timer arm, warmup, or bare tk.start.
 */
(function (root) {
  const STATES = {
    LOBBY: "Lobby",
    SEATING: "Seating",
    LIVE: "Live",
    ENDING: "Ending",
  };

  function CoopSessionController() {
    this.state = STATES.LOBBY;
    this.gen = 0;
    this.authority = null;
    this.boardReady = false;
    this.eventSeq = 0;
    this.poseSeq = 0;
    this.peerPoseSeq = Object.create(null);
    this.pendingInput = null;
    this.pendingPose = null;
    this.localDead = false;
    this.deadSent = false;
    this.seated = false;
    this.boardRev = 0;
    this.wallsRev = 0;
    this.moveSeq = 0;
    this.turnSeq = 0;
    this.ackedTurnSeq = 0;
    this.turns = [];
    this.lastPoseHead = null;
    this.lastHeadDir = null;
    this.lastMovementDir = null;
    this.lastPoseHead2 = null;
    this.lastMovementDir2 = null;
  }

  const OPPOSITE = {
    UP: "DOWN",
    DOWN: "UP",
    LEFT: "RIGHT",
    RIGHT: "LEFT",
  };

  function normalizedDir(value) {
    const dir = String(value || "").toUpperCase();
    return Object.prototype.hasOwnProperty.call(OPPOSITE, dir) ? dir : null;
  }

  function normalizedPoint(value) {
    if (!value || !Number.isFinite(Number(value.x)) ||
        !Number.isFinite(Number(value.y))) return null;
    return { x: Number(value.x) | 0, y: Number(value.y) | 0 };
  }

  function transitionDir(from, to) {
    if (!from || !to) return null;
    const dx = (to.x | 0) - (from.x | 0);
    const dy = (to.y | 0) - (from.y | 0);
    if (dx === 1 && dy === 0) return "RIGHT";
    if (dx === -1 && dy === 0) return "LEFT";
    if (dx === 0 && dy === 1) return "DOWN";
    if (dx === 0 && dy === -1) return "UP";
    return null;
  }

  function normalizeTurn(turn) {
    if (!turn) return null;
    const turnSeq = Number(turn.turnSeq);
    const moveSeq = Number(turn.moveSeq);
    const at = normalizedPoint(turn.at);
    const fromDir = normalizedDir(turn.fromDir);
    const toDir = normalizedDir(turn.toDir);
    if (!Number.isSafeInteger(turnSeq) || turnSeq < 1 ||
        !Number.isSafeInteger(moveSeq) || moveSeq < 0 ||
        !at || !fromDir || !toDir || fromDir === toDir ||
        OPPOSITE[fromDir] === toDir) return null;
    return {
      turnSeq: turnSeq,
      at: at,
      fromDir: fromDir,
      toDir: toDir,
      moveSeq: moveSeq,
    };
  }

  /** Merge repeated overlap plus a new contiguous suffix, bounded for wire use. */
  function mergePoseTurns(previous, incoming) {
    const bySeq = Object.create(null);
    (Array.isArray(previous) ? previous : []).forEach(function (turn) {
      const clean = normalizeTurn(turn);
      if (clean) bySeq[clean.turnSeq] = clean;
    });
    (Array.isArray(incoming) ? incoming : []).forEach(function (turn) {
      const clean = normalizeTurn(turn);
      if (clean) bySeq[clean.turnSeq] = clean;
    });
    const seqs = Object.keys(bySeq).map(Number).sort(function (a, b) {
      return a - b;
    });
    if (!seqs.length) return [];
    const contiguous = [bySeq[seqs[seqs.length - 1]]];
    for (let i = seqs.length - 2; i >= 0; i--) {
      if (seqs[i] !== contiguous[0].turnSeq - 1) break;
      contiguous.unshift(bySeq[seqs[i]]);
    }
    return contiguous.slice(-8);
  }

  CoopSessionController.prototype.is = function (name) {
    return this.state === name;
  };

  CoopSessionController.prototype.canPublishDeath = function () {
    return (
      (this.state === STATES.LIVE || this.state === STATES.SEATING) &&
      this.seated &&
      !this.deadSent
    );
  };

  CoopSessionController.prototype.canPublishPose = function () {
    return (
      this.seated &&
      (this.state === STATES.LIVE || this.state === STATES.SEATING)
    );
  };

  CoopSessionController.prototype.bindGeneration = function (
    generation,
    authority,
    boardReady
  ) {
    const gen = Number(generation);
    if (!Number.isSafeInteger(gen) || gen < 1) return false;
    if (this.gen === gen && this.authority && this.authority !== authority) {
      return false;
    }
    const fresh = this.gen !== gen;
    this.gen = gen;
    this.authority = authority;
    this.boardReady = !!boardReady;
    if (fresh) {
      this.eventSeq = 0;
      this.poseSeq = 0;
      this.peerPoseSeq = Object.create(null);
      this.pendingInput = null;
      this.pendingPose = null;
      this.localDead = false;
      this.deadSent = false;
      this.seated = false;
      this.boardRev = 0;
      this.wallsRev = 0;
      this.moveSeq = 0;
      this.turnSeq = 0;
      this.ackedTurnSeq = 0;
      this.turns = [];
      this.lastPoseHead = null;
      this.lastHeadDir = null;
      this.lastMovementDir = null;
      this.lastPoseHead2 = null;
      this.lastMovementDir2 = null;
      this.state = STATES.SEATING;
    }
    return true;
  };

  CoopSessionController.prototype.nextEventSeq = function () {
    this.eventSeq += 1;
    return this.eventSeq;
  };

  CoopSessionController.prototype.nextPoseSeq = function () {
    this.poseSeq += 1;
    return this.poseSeq;
  };

  /**
   * Enrich a post-native-tick pose. A direction change is journaled only when
   * the head transition proves the engine accepted it; raw keydown is never
   * observed and local input remains entirely native-owned.
   */
  CoopSessionController.prototype.observeNativePose = function (pose) {
    if (!pose) return pose;
    const head = normalizedPoint(pose.body && pose.body[0]);
    let headDir = normalizedDir(pose.headDir || pose.dir);
    const fromHead = this.lastPoseHead && {
      x: this.lastPoseHead.x,
      y: this.lastPoseHead.y,
    };
    const movedDir = transitionDir(fromHead, head);
    if (
      movedDir &&
      this.lastHeadDir &&
      (!headDir || OPPOSITE[this.lastHeadDir] === headDir ||
        headDir !== movedDir)
    ) {
      // The observed head path is authoritative. Never advertise an
      // impossible/rejected queue value from an uncertain obfuscated field.
      headDir = this.lastHeadDir;
    }
    if (fromHead && head &&
        (fromHead.x !== head.x || fromHead.y !== head.y)) {
      this.moveSeq += 1;
    }
    if (
      fromHead &&
      head &&
      this.lastHeadDir &&
      headDir &&
      headDir !== this.lastHeadDir &&
      OPPOSITE[this.lastHeadDir] !== headDir &&
      movedDir === headDir
    ) {
      this.turnSeq += 1;
      this.turns.push({
        turnSeq: this.turnSeq,
        at: fromHead,
        fromDir: this.lastHeadDir,
        toDir: headDir,
        moveSeq: this.moveSeq,
      });
      if (this.turns.length > 8) this.turns = this.turns.slice(-8);
    }
    pose.moveSeq = this.moveSeq;
    pose.fromHead = fromHead || head;
    pose.toHead = head;
    pose.transitionDir = movedDir;
    pose.movementDir = movedDir || this.lastMovementDir || headDir;
    pose.headDir = headDir || pose.movementDir;
    pose.dir = pose.headDir || pose.movementDir;
    pose.turns = this.turns.filter(function (turn) {
      return turn.turnSeq > this.ackedTurnSeq;
    }, this).slice(-8);
    const head2 = normalizedPoint(pose.body2 && pose.body2[0]);
    if (head2) {
      const movedDir2 = transitionDir(this.lastPoseHead2, head2);
      const headDir2 = normalizedDir(pose.headDir2) ||
        normalizedDir(pose.movementDir2);
      pose.transitionDir2 = movedDir2;
      pose.movementDir2 = movedDir2 || this.lastMovementDir2 || headDir2;
      pose.headDir2 = headDir2 || pose.movementDir2;
      if (movedDir2) this.lastMovementDir2 = movedDir2;
      this.lastPoseHead2 = head2;
    } else {
      delete pose.movementDir2;
      delete pose.headDir2;
      delete pose.transitionDir2;
      delete pose.segmentFlags2;
      delete pose.headLight2;
    }
    if (movedDir) this.lastMovementDir = movedDir;
    if (headDir) this.lastHeadDir = headDir;
    if (head) this.lastPoseHead = head;
    return pose;
  };

  CoopSessionController.prototype.ackTurns = function (turnSeq) {
    const seq = Number(turnSeq);
    if (!Number.isSafeInteger(seq) || seq <= this.ackedTurnSeq) return false;
    this.ackedTurnSeq = Math.min(seq, this.turnSeq);
    this.turns = this.turns.filter(function (turn) {
      return turn.turnSeq > this.ackedTurnSeq;
    }, this);
    return true;
  };

  CoopSessionController.prototype.queueInput = function (dir) {
    this.pendingInput = dir;
  };

  CoopSessionController.prototype.queuePose = function (pose) {
    this.pendingPose = pose || null;
  };

  CoopSessionController.prototype.markBoardReady = function (revision) {
    const rev = Number(revision);
    if (!Number.isSafeInteger(rev) || rev < 1 || rev < this.boardRev) {
      return false;
    }
    this.boardRev = rev;
    this.boardReady = true;
    if (this.seated) this.state = STATES.LIVE;
    return true;
  };

  CoopSessionController.prototype.takeQueued = function () {
    const out = { input: this.pendingInput, pose: this.pendingPose };
    this.pendingInput = null;
    this.pendingPose = null;
    return out;
  };

  CoopSessionController.prototype.canApplyBoard = function (payload) {
    if (!payload) return false;
    if (this.state !== STATES.LIVE && this.state !== STATES.SEATING) {
      return false;
    }
    const rawRev =
      payload.rev != null
        ? payload.rev
        : payload.revision != null
          ? payload.revision
          : payload.boardRevision;
    const rev = rawRev != null ? Number(rawRev) : null;
    if (rev != null && Number.isFinite(rev)) {
      if (
        this.state === STATES.SEATING &&
        payload.initial === true &&
        rev >= 1
      ) {
        return rev > (this.boardRev | 0);
      }
      return rev > (this.boardRev | 0);
    }
    // Legacy payloads without rev — allow during Live
    return this.state === STATES.LIVE || this.seated;
  };

  CoopSessionController.prototype.noteBoardRev = function (payload) {
    if (!payload) return;
    const boardRevision =
      payload.rev != null
        ? payload.rev
        : payload.revision != null
          ? payload.revision
          : payload.boardRevision;
    if (boardRevision != null && Number.isFinite(Number(boardRevision))) {
      this.boardRev = Math.max(this.boardRev | 0, Number(boardRevision) | 0);
    }
    if (payload.wallsRev != null && Number.isFinite(Number(payload.wallsRev))) {
      this.wallsRev = Math.max(
        this.wallsRev | 0,
        Number(payload.wallsRev) | 0
      );
    }
  };

  CoopSessionController.prototype.nextBoardRev = function () {
    this.boardRev = (this.boardRev | 0) + 1;
    return this.boardRev;
  };

  CoopSessionController.prototype.nextWallsRev = function () {
    this.wallsRev = (this.wallsRev | 0) + 1;
    return this.wallsRev;
  };

  /**
   * New SESSION_START / PLAY_SYNC — hard gen bump even mid-run.
   */
  CoopSessionController.prototype.enterSeating = function (generation, authority) {
    if (generation != null) {
      this.bindGeneration(generation, authority || this.authority, false);
      return this.gen;
    }
    // Legacy callers outside negotiated co-op retain the old local reset.
    this.gen = (this.gen | 0) + 1;
    this.state = STATES.SEATING;
    this.localDead = false;
    this.deadSent = false;
    this.seated = false;
    this.boardRev = 0;
    this.wallsRev = 0;
    this.boardReady = false;
    return this.gen;
  };

  CoopSessionController.prototype.markSeated = function () {
    if (this.state === STATES.ENDING || this.state === STATES.LOBBY) {
      return false;
    }
    this.seated = true;
    this.state =
      this.authority === "native-relay-v1" && !this.boardReady
        ? STATES.SEATING
        : STATES.LIVE;
    return true;
  };

  CoopSessionController.prototype.markDead = function (source) {
    if (!this.canPublishDeath()) {
      return { ok: false, reason: "blocked", source: source || "unknown" };
    }
    this.localDead = true;
    this.deadSent = true;
    return { ok: true, source: source || "unknown" };
  };

  CoopSessionController.prototype.enterEnding = function () {
    this.state = STATES.ENDING;
  };

  CoopSessionController.prototype.enterLobby = function () {
    this.state = STATES.LOBBY;
    this.localDead = false;
    this.deadSent = false;
    this.seated = false;
    this.boardRev = 0;
    this.wallsRev = 0;
    this.boardReady = false;
    this.pendingInput = null;
    this.pendingPose = null;
  };

  root.CoopSessionController = CoopSessionController;
  root.CoopSessionStates = STATES;
  root.mergeCoopPoseTurns = mergePoseTurns;
  root.normalizeCoopTurn = normalizeTurn;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CoopSessionController: CoopSessionController,
      CoopSessionStates: STATES,
      mergePoseTurns: mergePoseTurns,
      normalizeTurn: normalizeTurn,
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
