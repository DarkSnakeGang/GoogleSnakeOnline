/**
 * Partially-native co-op.
 *
 * Remote players are drawn with the mosaic snake renderer on the native
 * canvas. Collision is body-position only (head / next step vs remotes) —
 * never by stamping snakes into the wall grid. Peaceful and Yin Yang skip
 * friendly hits; Yin Yang also uses corner seats instead of center+oy.
 */
(function (root) {
  function CoopNative() {
    this.remotes = {};
    this.collectables = null;
    this.collectablesOwnerId = null;
    this.sessionActive = false;
    this.myClientId = null;
    this.myColorId = null;
    this.injectEnabled = true;
    this.generation = 0;
    this.peerPoseSeq = Object.create(null);
  }

  CoopNative.prototype.reset = function () {
    this.remotes = {};
    this.collectables = null;
    this.sessionActive = false;
    this.generation = 0;
    this.peerPoseSeq = Object.create(null);
    this._seedStickyUntil = 0;
    releaseNativeBackend("session-reset");
    invalidateLightMask();
    this.syncBridge();
  };

  /** Fresh native peer paint path for a new match (clears circuit-breaker). */
  CoopNative.prototype.resetNativePeerPaint = function () {
    this.syncBridge();
    resetNativePeerPaint("session-begin");
  };

  CoopNative.prototype.syncBridge = function () {
    root.__mpCoopSession = !!this.sessionActive;
    root.__mpCoopMyId = this.myClientId || null;
    root.__mpCoopMyColorId = this.myColorId;
    root.__mpCoopRemotes = this.remotes;
    root.__mpCoopCollectables = this.collectables;
    root.__mpCoopOwnerId = this.collectablesOwnerId || null;
    root.__mpCoopGeneration = this.generation || root.__mpCoopGeneration || 0;
    root.__mpCoopInject = !!this.injectEnabled && !!this.sessionActive;
    _displayColorsAt = 0;
  };

  CoopNative.prototype.beginSeedSticky = function (ms) {
    this._seedStickyUntil = Date.now() + (ms != null ? ms : 1500);
  };

  CoopNative.prototype.applySnakeDelta = function (payload) {
    if (!payload || !payload.clientId) return;
    if (
      !payload._seeded &&
      !payload._fromState &&
      this.generation &&
      Number(payload.generation) !== Number(this.generation)
    ) return;
    if (payload.poseSeq != null) {
      const poseSeq = Number(payload.poseSeq);
      if (
        !Number.isSafeInteger(poseSeq) ||
        poseSeq < 1 ||
        poseSeq <= (this.peerPoseSeq[payload.clientId] || 0)
      ) return;
      this.peerPoseSeq[payload.clientId] = poseSeq;
    }
    const prev = this.remotes[payload.clientId];
    // Live deltas win over SESSION_START seeds — except empty/short during sticky window
    if (payload._seeded && prev && prev._fromDelta) return;
    const bodyEmpty = !payload.body || !payload.body.length;
    const bodyShort = !payload.body || payload.body.length < 3;
    const sticky =
      this._seedStickyUntil && Date.now() < this._seedStickyUntil;
    if (
      !payload._seeded &&
      prev &&
      prev._seeded &&
      sticky &&
      (bodyEmpty || bodyShort)
    ) {
      // Keep seeded body; merge non-body fields if useful
      const keep = Object.assign({}, prev);
      [
        "dir",
        "alive",
        "colorId",
        "color1",
        "color2",
        "Sc",
        "Yc",
        "score",
        "otherDim",
        "peaceful",
        "body2",
        "headLight",
        "headLight2",
        "poisoned",
        "slotActive",
      ].forEach(function (k) {
        if (payload[k] != null) keep[k] = payload[k];
      });
      this.remotes[payload.clientId] = keep;
      this.syncBridge();
      maybeApplyPeerSlot(payload);
      return;
    }
    const next = Object.assign(Object.create(null), prev || null, payload);
    // Drop unexpected prototype / huge body abuse
    // Prefer a stable modeKey so paintNativePeers does not sticky-disable on lag.
    if (!next.modeKey || !String(next.modeKey).trim()) {
      next.modeKey = coopModeKey() || "";
    }
    if (next.body && Array.isArray(next.body) && next.body.length > 400) {
      next.body = next.body.slice(0, 400);
    }
    if (!payload._seeded) next._fromDelta = true;
    // Keep prior colors when a delta omits them (scrape sometimes misses Sc/Yc)
    if (prev) {
      [
        "colorId",
        "color1",
        "color2",
        "Sc",
        "Yc",
        "primary",
        "secondary",
      ].forEach(function (k) {
        if (next[k] == null && prev[k] != null) next[k] = prev[k];
      });
      // Preserve visual/lerp state across merges unless body forces a reseat
      if (prev._visualBody) next._visualBody = prev._visualBody;
      if (prev._lerpAt != null) next._lerpAt = prev._lerpAt;
      if (prev._lerpStepMs != null) next._lerpStepMs = prev._lerpStepMs;
      if (prev.__mpMotion) next.__mpMotion = prev.__mpMotion;
      if (
        (next.modeKey == null || !String(next.modeKey).trim()) &&
        prev.modeKey
      ) {
        next.modeKey = prev.modeKey;
      }
    }
    if (!next.modeKey || !String(next.modeKey).trim()) {
      next.modeKey = coopModeKey() || "";
    }
    if (payload._lerpStepMs != null) next._lerpStepMs = payload._lerpStepMs;
    // Sticky corpse only after authoritative COOP_PLAYER_DEAD — transient
    // scrape alive:false must not permanently kill a peer on the HUD.
    if (prev && prev._deadSticky) {
      next.alive = false;
      next._deadSticky = true;
    }
    // Never drop a corpse body when a dead/empty scrape arrives: a co-op corpse
    // stays exactly where it died and keeps colliding.
    if (bodyEmpty && prev && prev.body && prev.body.length) {
      next.body = prev.body;
    }
    // Spectate-style trail: advance visual body when remote head moves
    if (next.body && next.body.length) {
      const Gsm = root.MultiplayerGsm;
      const now = nowMs();
      const prevHead = prev && prev.body && prev.body[0];
      const nextHead = next.body[0];
      let headMoved = !prevHead || !nextHead;
      if (prevHead && nextHead) {
        headMoved =
          Math.round(Number(prevHead.x)) !== Math.round(Number(nextHead.x)) ||
          Math.round(Number(prevHead.y)) !== Math.round(Number(nextHead.y)) ||
          (prev.body && prev.body.length) !== next.body.length;
      }
      if (headMoved) {
        if (Gsm && typeof Gsm.followBodyFromHead === "function") {
          next._visualBody = Gsm.followBodyFromHead(
            prev && prev._visualBody,
            next.body
          );
        } else {
          next._visualBody = snapshotBody(next.body);
        }
        if (prev && prev._lerpAt != null) {
          const dt = now - prev._lerpAt;
          if (dt > 30 && dt < 250) next._lerpStepMs = dt;
        }
        next._lerpAt = now;
      } else if (!next._visualBody) {
        next._visualBody = snapshotBody(next.body);
      }
    }
    this.remotes[payload.clientId] = next;
    this.syncBridge();
    maybeApplyPeerSlot(payload);
  };

  /** Apply a peer's Slot Machine roll without ping-ponging our own eat. */
  function maybeApplyPeerSlot(payload) {
    if (!payload || payload.slotActive == null) return;
    if (root.__mpCoopSkipFruitReapply) return;
    if (typeof root.setSlotActive !== "function") return;
    const next = Number(payload.slotActive) | 0;
    if (!Number.isFinite(next)) return;
    if ((root.__slotActive | 0) === next) return;
    if (root.__mpCoopLastSlotActive === next) return;
    try {
      const game = root.__mpGame || root.__remixGame;
      root.setSlotActive(next, game);
      root.__mpCoopLastSlotActive = next;
    } catch (e) { /* ignore */ }
  }

  CoopNative.prototype.applyCollectables = function (payload) {
    this.collectables = payload;
    this.syncBridge();
  };

  CoopNative.prototype.remoteList = function (excludeId) {
    const self = this;
    return Object.keys(this.remotes)
      .filter(function (id) {
        return id !== excludeId;
      })
      .map(function (id) {
        return self.remotes[id];
      });
  };

  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  function snapshotBody(body) {
    return (body || []).map(function (p) {
      const x = p && Number.isFinite(Number(p.x)) ? Number(p.x) : 0;
      const y = p && Number.isFinite(Number(p.y)) ? Number(p.y) : 0;
      const out = { x: x, y: y };
      if (p && p.otherDim) out.otherDim = true;
      return out;
    });
  }

  /** True when every segment has finite grid coords. */
  function bodyIsRenderable(body) {
    if (!body || !body.length) return false;
    for (let i = 0; i < body.length; i++) {
      const p = body[i];
      if (!p) return false;
      if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Rewrite snake.ka to finite Closure-safe points + matching wa flags.
   * Returns false when the body cannot be salvaged (caller should skip/park).
   */
  function sanitizeSnakeBody(snake) {
    if (!snake) return false;
    if (!Array.isArray(snake.ka) || !snake.ka.length) return false;
    const Gsm = root.MultiplayerGsm;
    const clean = [];
    let dirty = false;
    for (let i = 0; i < snake.ka.length; i++) {
      const p = snake.ka[i];
      if (!p) {
        dirty = true;
        continue;
      }
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        dirty = true;
        continue;
      }
      if (typeof p.clone !== "function") dirty = true;
      clean.push({ x: x, y: y });
    }
    if (!clean.length) return false;
    if (dirty || clean.length !== snake.ka.length) {
      if (Gsm && typeof Gsm.writeNativeBody === "function") {
        try {
          Gsm.writeNativeBody(snake, clean);
        } catch (eW) {
          return false;
        }
      } else {
        snake.ka.length = 0;
        for (let j = 0; j < clean.length; j++) {
          const seg = { x: clean[j].x, y: clean[j].y };
          seg.clone = function () {
            const c = { x: this.x, y: this.y };
            c.clone = this.clone;
            return c;
          };
          snake.ka.push(seg);
        }
      }
    }
    if (Gsm && typeof Gsm.ensureSnakeSegmentFlags === "function") {
      try {
        Gsm.ensureSnakeSegmentFlags(snake);
      } catch (eF) { /* ignore */ }
    }
    return bodyIsRenderable(snake.ka);
  }

  /** Local + Yin Yang twin — repair before native PlayerRenderer. */
  function sanitizeLocalSnakesForRender(game) {
    if (!game) return false;
    const ok = sanitizeSnakeBody(game.oa);
    if (game.Ra) sanitizeSnakeBody(game.Ra);
    return ok;
  }

  /* ------------------------------------------------------------------ modes */

  /** Mode key from Remix ModeRegistry (e.g. "peaceful", "wall+cheese"). */
  function coopModeKey() {
    try {
      const Gsm = root.MultiplayerGsm;
      if (Gsm && typeof Gsm.effectiveModeKey === "function") {
        return String(Gsm.effectiveModeKey() || "");
      }
      if (Gsm && typeof Gsm.scrapeModeKey === "function") {
        return String(Gsm.scrapeModeKey() || "");
      }
    } catch (eGsm) { /* ignore */ }
    try {
      if (
        root.ModeRegistry &&
        typeof root.ModeRegistry.getCurrentModeKey === "function"
      ) {
        return String(root.ModeRegistry.getCurrentModeKey() || "");
      }
    } catch (e) { /* ignore */ }
    return "";
  }

  function modeKeyHas(key, part) {
    if (!key || !part) return false;
    const parts = String(key).toLowerCase().split("+");
    return parts.indexOf(String(part).toLowerCase()) >= 0;
  }

  /** Normalize for peer paint — empty/classic/standard are the same base mode. */
  function normalizeModeKey(key) {
    const k = String(key || "")
      .toLowerCase()
      .trim();
    if (!k || k === "classic" || k === "standard" || k === "normal") return "";
    return k
      .split("+")
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean)
      .sort()
      .join("+");
  }

  /**
   * Peers often lag one tick with "" vs "classic" or omit modeKey — do not
   * sticky-disable native paint for that. Real mode conflicts still mismatch.
   */
  function modesCompatible(localKey, peerKey) {
    if (peerKey == null || peerKey === "") return true;
    const a = normalizeModeKey(localKey);
    const b = normalizeModeKey(peerKey);
    if (a === b) return true;
    // One side still resolving match settings
    if (!a || !b) return true;
    return false;
  }

  /** Peaceful mode, cat grace, yin-yang peers, or a peaceful badge on either snake. */
  function coopSkipFriendlyHits() {
    const key = coopModeKey();
    if (modeKeyHas(key, "peaceful")) return true;
    if (modeKeyHas(key, "yin_yang")) return true;
    if ((root.cat_peaceful_ticks | 0) > 0) return true;
    if (typeof root.chess_peaceful_active === "function") {
      try {
        if (root.chess_peaceful_active()) return true;
      } catch (e) { /* ignore */ }
    }
    const remotes = root.__mpCoopRemotes || {};
    const ids = Object.keys(remotes);
    for (let i = 0; i < ids.length; i++) {
      if (remotes[ids[i]] && remotes[ids[i]].peaceful) return true;
    }
    return false;
  }

  function coopIsCheeseMode() {
    return modeKeyHas(coopModeKey(), "cheese");
  }

  function coopIsDimensionMode() {
    return modeKeyHas(coopModeKey(), "dimension");
  }

  /** Board light square parity — matches theme checker (x+y)%2===0. */
  function isCheeseLightTile(x, y) {
    return (((x | 0) + (y | 0)) & 1) === 0;
  }

  /**
   * Whether the local head sits outside the dimension its own board is showing.
   * The engine keeps that per segment in `snake.wa` (parallel to `snake.ka`),
   * not on the body points. Normally false, because a head that lands in the
   * other dimension is what triggers the board swap in the first place.
   */
  function localOtherDim(game) {
    if (!coopIsDimensionMode()) return false;
    try {
      const flags = game && game.oa && game.oa.wa;
      if (!Array.isArray(flags) || !flags.length) return false;
      return !flags[0];
    } catch (e) { /* ignore */ }
    return false;
  }

  /** True when a remote cell should physically block the local head. */
  function remoteCellBlocks(seg, hostOtherDim) {
    if (!seg || seg.x == null || seg.y == null) return false;
    // Cheese: light squares are holes the snake passes through
    if (coopIsCheeseMode() && isCheeseLightTile(seg.x, seg.y)) return false;
    // Dimension: only cells sharing the local snake's dimension are solid
    if (coopIsDimensionMode() && !!seg.otherDim !== !!hostOtherDim) return false;
    return true;
  }

  function dirDelta(dir) {
    if (dir === "LEFT" || dir === 2 || dir === "2") return { x: -1, y: 0 };
    if (dir === "RIGHT" || dir === 0 || dir === "0") return { x: 1, y: 0 };
    if (dir === "UP" || dir === 3 || dir === "3") return { x: 0, y: -1 };
    if (dir === "DOWN" || dir === 1 || dir === "1") return { x: 0, y: 1 };
    return null;
  }

  function boardWraps() {
    const key = coopModeKey();
    return modeKeyHas(key, "borderless") || modeKeyHas(key, "peaceful");
  }

  function wrapCell(x, y, size) {
    let xx = x | 0;
    let yy = y | 0;
    if (!size || !(size.width > 0) || !(size.height > 0)) {
      return { x: xx, y: yy };
    }
    const w = size.width | 0;
    const h = size.height | 0;
    xx = ((xx % w) + w) % w;
    yy = ((yy % h) + h) % h;
    return { x: xx, y: yy };
  }

  function predictedHead(game) {
    const snake = game && game.oa;
    const head = snake && snake.ka && snake.ka[0];
    if (!head) return null;
    const d = dirDelta(snake.direction || snake.dir);
    if (!d) return null;
    let x = (head.x | 0) + d.x;
    let y = (head.y | 0) + d.y;
    if (boardWraps()) {
      const size = boardSizeFromGame(game);
      const w = wrapCell(x, y, size);
      x = w.x;
      y = w.y;
    }
    return { x: x, y: y };
  }

  function remoteBodyCells(remote) {
    const cells = [];
    const body = (remote && remote.body) || [];
    for (let i = 0; i < body.length; i++) {
      if (body[i]) cells.push(body[i]);
    }
    // Yin Yang companion occupies cells for spawn; hits stay friendly
    const body2 = (remote && remote.body2) || [];
    for (let j = 0; j < body2.length; j++) {
      if (body2[j]) cells.push(body2[j]);
    }
    return cells;
  }

  function remoteOccupies(x, y) {
    if (coopSkipFriendlyHits()) return false;
    const hostDim = localOtherDim(root.__mpGame || root.__remixGame);
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    const wraps = boardWraps();
    const size = wraps
      ? boardSizeFromGame(root.__mpGame || root.__remixGame)
      : null;
    const probe = wraps ? wrapCell(x, y, size) : { x: x | 0, y: y | 0 };
    const ids = Object.keys(remotes);
    for (let i = 0; i < ids.length; i++) {
      if (myId && ids[i] === myId) continue;
      const cells = remoteBodyCells(remotes[ids[i]]);
      for (let j = 0; j < cells.length; j++) {
        const p = cells[j];
        if (!p || p.x == null || p.y == null) continue;
        const cell = wraps ? wrapCell(p.x, p.y, size) : { x: p.x | 0, y: p.y | 0 };
        if (
          cell.x === probe.x &&
          cell.y === probe.y &&
          remoteCellBlocks(p, hostDim)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function killLocalOnRemote(game) {
    if (!game || coopSkipFriendlyHits()) return false;
    // Server-auth: death is STATE-only — never native die / nj stars
    if (root.__mpCoopServerAuth) return false;
    if (root.__mpCoopSpectator || root.__mpCoopLocalDead) return false;
    if (game.nj || game.dead || game.isDead) return false;
    const snake = game.oa;
    const head = snake && snake.ka && snake.ka[0];
    const next = predictedHead(game);
    const hit =
      (head && remoteOccupies(head.x, head.y)) ||
      (next && remoteOccupies(next.x, next.y));
    if (!hit) return false;
    try {
      if (typeof game.die === "function") game.die();
      else {
        game.nj = true;
        if (game.dead != null) game.dead = true;
      }
    } catch (e) {
      game.nj = true;
    }
    root.__mpCoopLocalDead = true;
    if (typeof root.__mpCoopOnFriendlyDeath === "function" && snake && snake.ka) {
      try {
        const snap = Array.prototype.map.call(snake.ka, function (p) {
          return p && { x: p.x | 0, y: p.y | 0 };
        });
        root.__mpCoopOnFriendlyDeath(snap);
      } catch (e2) { /* ignore */ }
    }
    return true;
  }

  function wrapGameReset(game) {
    if (!game || game.__mpCoopResetWrapped) return;
    if (typeof game.reset !== "function") return;
    game.__mpCoopResetWrapped = true;
    const orig = game.reset;
    game.reset = function () {
      if (root.__mpCoopSession && !root.__mpCoopSpectator) {
        const auth = root.__mpCoopAuthority;
        const serverAuth =
          !!root.__mpCoopServerAuth || auth === "server-sim-v1";
        // Server-sim: soft-rebind STATE only (never native reset).
        if (serverAuth) {
          if (typeof root.__mpCoopOnLocalReset === "function") {
            try {
              root.__mpCoopOnLocalReset();
            } catch (e) { /* ignore */ }
          }
          return;
        }
        // Native-relay: hook runs full wipe / shared SESSION_START.
        if (typeof root.__mpCoopOnLocalReset === "function") {
          try {
            if (root.__mpCoopOnLocalReset() === true) return;
          } catch (eNat) { /* fall through to orig */ }
        }
      }
      return orig.apply(this, arguments);
    };
  }

  CoopNative.prototype.hitsRemote = function (head, excludeId) {
    if (!head) return false;
    if (coopSkipFriendlyHits()) return false;
    const hostDim = localOtherDim(root.__mpGame || root.__remixGame);
    const remotes = this.remoteList(excludeId);
    const wraps = boardWraps();
    const size = wraps
      ? boardSizeFromGame(root.__mpGame || root.__remixGame)
      : null;
    const probe = wraps
      ? wrapCell(head.x, head.y, size)
      : { x: head.x | 0, y: head.y | 0 };
    for (let i = 0; i < remotes.length; i++) {
      const cells = remoteBodyCells(remotes[i]);
      for (let j = 0; j < cells.length; j++) {
        const p = cells[j];
        if (!p || p.x == null || p.y == null) continue;
        const cell = wraps ? wrapCell(p.x, p.y, size) : { x: p.x | 0, y: p.y | 0 };
        if (
          cell.x === probe.x &&
          cell.y === probe.y &&
          remoteCellBlocks(p, hostDim)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  /* -------------------------------------------------------------- occupancy */

  /**
   * Occupancy for spawn avoidance: every remote body cell (live snakes AND
   * corpses). Cheese light tiles are holes — not occupied. Unlike collision
   * this ignores peaceful/dimension: nothing should ever spawn inside a snake,
   * even one you can currently pass through.
   */
  CoopNative.prototype.occupancyKeys = function (includeLocal) {
    const keys = {};
    const cheese = coopIsCheeseMode();
    function addBody(body) {
      (body || []).forEach(function (p) {
        if (!p || p.x == null || p.y == null) return;
        if (cheese && isCheeseLightTile(p.x, p.y)) return;
        keys[(p.x | 0) + "," + (p.y | 0)] = true;
      });
    }
    Object.keys(this.remotes).forEach(function (id) {
      const r = this.remotes[id];
      addBody(r && r.body);
      addBody(r && r.body2);
    }, this);
    if (includeLocal) {
      try {
        const g = root.__mpGame || root.__remixGame;
        if (g && g.oa && g.oa.ka) addBody(g.oa.ka);
        // Local Yin Yang companion
        if (g && g.Ra && g.Ra.ka) addBody(g.Ra.ka);
        else if (g && g.oa && g.oa.Ra && g.oa.Ra.ka) addBody(g.oa.Ra.ka);
      } catch (e) { /* ignore */ }
    }
    return keys;
  };

  CoopNative.prototype.isOccupied = function (x, y, includeLocal) {
    if (x == null || y == null) return false;
    const keys = this.occupancyKeys(!!includeLocal);
    return !!keys[(x | 0) + "," + (y | 0)];
  };

  /** Fresh occupancy from bridge remotes (no app pointer required). */
  function readCoopOccupancy() {
    const app = root.__multiplayerApp;
    if (
      app &&
      app.coopNative &&
      typeof app.coopNative.occupancyKeys === "function"
    ) {
      return app.coopNative.occupancyKeys(false);
    }
    const keys = {};
    const cheese = coopIsCheeseMode();
    const remotes = root.__mpCoopRemotes || {};
    Object.keys(remotes).forEach(function (id) {
      const r = remotes[id];
      const bodies = [(r && r.body) || [], (r && r.body2) || []];
      for (let bi = 0; bi < bodies.length; bi++) {
        (bodies[bi] || []).forEach(function (p) {
          if (!p || p.x == null || p.y == null) return;
          if (cheese && isCheeseLightTile(p.x, p.y)) return;
          keys[(p.x | 0) + "," + (p.y | 0)] = true;
        });
      }
    });
    return keys;
  }

  function boardSizeFromGame(game) {
    let w = 17;
    let h = 15;
    try {
      const meta =
        (game && game.wa && game.wa.oa && game.wa.oa.oa) ||
        (game && game.oa && game.oa.oa) ||
        {};
      if (meta.width) w = meta.width | 0;
      if (meta.height) h = meta.height | 0;
    } catch (e) { /* defaults */ }
    return { width: w || 17, height: h || 15 };
  }

  /**
   * Native wall collision: non-zero / non-3 cells in Ca.wa are solid (y4E).
   * Used so fruit/snake seats avoid real Wall-mode cells the same way the
   * engine does — including after peers apply a synced wall list.
   */
  function isSolidWallCell(game, x, y) {
    const wa = wallGrid(game);
    if (!wa) return false;
    const xi = x | 0;
    const yi = y | 0;
    const row = wa[yi];
    if (!row || xi < 0 || xi >= row.length) return false;
    const v = row[xi] | 0;
    return v !== 0 && v !== 3;
  }

  /** All solid Ca.wa cells (real Wall-mode walls only — never snakes). */
  function wallOccupancyKeys(game) {
    const keys = {};
    const wa = wallGrid(game);
    if (!wa) return keys;
    for (let y = 0; y < wa.length; y++) {
      const row = wa[y];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        const v = row[x] | 0;
        if (v === 0 || v === 3) continue;
        keys[x + "," + y] = true;
      }
    }
    return keys;
  }

  function spawnCellBlocked(game, x, y, occ) {
    const k = (x | 0) + "," + (y | 0);
    if (occ && occ[k]) return true;
    return isSolidWallCell(game, x, y);
  }

  /** Pudding count index (0=1a … 6=Tally). */
  function readCountIndex() {
    try {
      const ps = root.__mpCoopPlaySettings || root.__mpMatchPlaySettings;
      if (ps && ps.count != null && Number.isFinite(Number(ps.count))) {
        return Number(ps.count) | 0;
      }
    } catch (ePs) { /* ignore */ }
    try {
      if (
        root.timeKeeper &&
        typeof root.timeKeeper.getCurrentSetting === "function"
      ) {
        const idx = Number(root.timeKeeper.getCurrentSetting("count"));
        if (Number.isFinite(idx) && idx >= 0) return idx | 0;
      }
    } catch (eTk) { /* ignore */ }
    return 0;
  }

  /** Live co-op heads (local + companion + remotes) for Tally radius. */
  function collectCoopHeads(game) {
    const heads = [];
    try {
      const local = game && game.oa && game.oa.ka && game.oa.ka[0];
      if (local && local.x != null && local.y != null) heads.push(local);
      if (game && game.Ra && game.Ra.ka && game.Ra.ka[0]) {
        heads.push(game.Ra.ka[0]);
      }
    } catch (eL) { /* ignore */ }
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    Object.keys(remotes).forEach(function (id) {
      if (myId && id === myId) return;
      const r = remotes[id];
      if (!r || r.alive === false) return;
      if (r.body && r.body[0]) heads.push(r.body[0]);
      if (r.body2 && r.body2[0]) heads.push(r.body2[0]);
    });
    return heads;
  }

  /**
   * Valid fruit spawn cells: in-bounds, not wall, not any co-op body.
   * Tally (count 6): also exclude manhattan ≤3 of every live head.
   * Also skip cells already holding fruit (multi-spawn Bomb/Dice/Tally).
   * Build the full pool first — callers roll once (no reject-retry).
   */
  function buildFruitSpawnPool(game, opts) {
    opts = opts || {};
    const g = game || root.__mpGame || root.__remixGame;
    const occ = opts.occ || readSpawnOccupancy(g, true);
    const size = boardSizeFromGame(g);
    const tally =
      opts.tally != null ? !!opts.tally : readCountIndex() === 6;
    const heads = tally ? collectCoopHeads(g) : null;
    // Reserve live fruit so batch spawns (Bomb 24) never stack
    const fruitOcc = Object.create(null);
    try {
      const apples = g && g.wa && g.wa.ka;
      for (let i = 0; apples && i < apples.length; i++) {
        const a = apples[i];
        const pos = (a && a.pos) || a;
        if (pos && pos.x != null && pos.y != null) {
          fruitOcc[(pos.x | 0) + "," + (pos.y | 0)] = true;
        }
      }
    } catch (eF) { /* ignore */ }
    const pool = [];
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        if (spawnCellBlocked(g, x, y, occ)) continue;
        if (fruitOcc[x + "," + y]) continue;
        if (heads && heads.length) {
          let near = false;
          for (let h = 0; h < heads.length; h++) {
            if (manhattan(x, y, heads[h].x, heads[h].y) <= 3) {
              near = true;
              break;
            }
          }
          if (near) continue;
        }
        pool.push({ x: x, y: y });
      }
    }
    return pool;
  }

  /** Uniform single pick from a prebuilt pool; empty → null. */
  function pickFruitSpawnFromPool(pool) {
    if (!pool || !pool.length) return null;
    let idx = 0;
    try {
      if (typeof root.crypto !== "undefined" && root.crypto.getRandomValues) {
        const buf = new Uint32Array(1);
        root.crypto.getRandomValues(buf);
        idx = buf[0] % pool.length;
      } else {
        idx = Math.floor(Math.random() * pool.length);
      }
    } catch (eRnd) {
      idx = Math.floor(Math.random() * pool.length);
    }
    const cell = pool[idx];
    return cell ? { x: cell.x | 0, y: cell.y | 0 } : null;
  }

  /**
   * Linear scan for a cell not on any co-op snake, local body, or solid wall.
   * Wall mode must plant fruit / entities with the same rules as native.
   * Prefers pool+roll when available (first cell of pool is not used for
   * deterministic scan — keep first-free for wall/entity helpers).
   */
  function findFreeSpawnCell(game, occ) {
    occ = occ || readCoopOccupancy();
    const size = boardSizeFromGame(game);
    const local = {};
    try {
      const body = game && game.oa && game.oa.ka;
      (body || []).forEach(function (p) {
        if (p && p.x != null && p.y != null) {
          local[(p.x | 0) + "," + (p.y | 0)] = true;
        }
      });
    } catch (e) { /* ignore */ }
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const k = x + "," + y;
        if (occ[k] || local[k]) continue;
        if (isSolidWallCell(game, x, y)) continue;
        return { x: x, y: y };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------- wall helpers */

  function wallGrid(game) {
    const g = game || root.__mpGame || root.__remixGame;
    const wa = g && g.Ca && g.Ca.wa;
    return Array.isArray(wa) && wa.length ? wa : null;
  }

  /* ------------------------------------------------------------------ colors */

  // Recolor order for co-op snakes whose color collides with another snake.
  const COOP_RECOLOR_IDS = [4 /* Red */, 7 /* Green */, 6 /* Yellow */];
  const COOP_DEFAULT_BLUE = 0;

  /**
   * The recolor list as this client sees it: whichever entry matches the local
   * snake's own color is swapped for default blue, so a red player never sees a
   * red companion.
   */
  function coopRecolorPalette(myColorId) {
    const mine = myColorId == null ? null : myColorId | 0;
    return COOP_RECOLOR_IDS.map(function (id) {
      return id === mine ? COOP_DEFAULT_BLUE : id;
    });
  }

  /**
   * Per-observer color assignment. Remotes keep their claimed color unless it
   * collides with the local snake or an earlier remote, in which case they take
   * the next free entry from the recolor palette. Iteration is sorted by client
   * id so the mapping is stable frame to frame.
   */
  function coopDisplayColorIds(myColorId, remotes, myId) {
    const out = {};
    const mine = myColorId == null ? null : myColorId | 0;
    const used = Object.create(null);
    if (mine != null) used[mine] = true;
    const palette = coopRecolorPalette(mine);
    let next = 0;
    const ids = Object.keys(remotes || {}).sort();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (myId && id === myId) continue;
      const r = remotes[id];
      const claimed = r && r.colorId != null ? r.colorId | 0 : null;
      // Keep claimed color on every client so peers look the same across
      // machines. Only remapping when missing or colliding with local snake.
      if (claimed != null && claimed !== mine) {
        used[claimed] = true;
        out[id] = claimed;
        continue;
      }
      let pick = null;
      while (next < palette.length) {
        const cand = palette[next++];
        if (!used[cand]) {
          pick = cand;
          break;
        }
      }
      if (pick == null) pick = claimed;
      if (pick != null) used[pick] = true;
      out[id] = pick;
    }
    return out;
  }

  // Recomputed only when the roster/color set changes (syncBridge clears it).
  let _displayColors = {};
  let _displayColorsAt = 0;
  function displayColorIds() {
    const now = nowMs();
    if (_displayColorsAt && now - _displayColorsAt < 250) return _displayColors;
    _displayColors = coopDisplayColorIds(
      root.__mpCoopMyColorId,
      root.__mpCoopRemotes || {},
      root.__mpCoopMyId
    );
    _displayColorsAt = now;
    return _displayColors;
  }

  /** Stock h3E row from the wrapped game (`__slotSnakeColorTable`). */
  function stockTableColor(displayId) {
    if (displayId == null) return null;
    const table = root.__slotSnakeColorTable;
    if (!table || typeof table !== "object") return null;
    const row = table[displayId | 0];
    if (!row) return null;
    if (Array.isArray(row) && row[0]) {
      return {
        primary: String(row[0]),
        secondary: String(row[1] || row[0]),
      };
    }
    return null;
  }

  /** Resolve primary/shade hex (+ rainbow set) for one remote. */
  function remoteColorInfo(remote, displayId) {
    const Colors = root.MultiplayerColors;
    if (
      Colors &&
      typeof Colors.syncFromStockTable === "function" &&
      root.__slotSnakeColorTable
    ) {
      try {
        Colors.syncFromStockTable(root.__slotSnakeColorTable);
      } catch (eSync) {
        /* ignore */
      }
    }
    const c =
      Colors && Colors.getColor && displayId != null
        ? Colors.getColor(displayId)
        : null;
    // A recolor overrides whatever hexes the peer published for itself.
    const recolored =
      displayId != null &&
      remote &&
      remote.colorId != null &&
      (remote.colorId | 0) !== (displayId | 0);
    let primary = recolored
      ? null
      : (remote && (remote.Sc || remote.color2 || remote.primary)) || null;
    let secondary = recolored
      ? null
      : (remote && (remote.Yc || remote.color1 || remote.secondary)) || null;
    let set = null;
    // Prefer stock engine table (h3E) over static palette when scrape missed hex.
    if (!primary || !secondary) {
      const stock = stockTableColor(displayId);
      if (stock) {
        if (!primary) primary = stock.primary;
        if (!secondary) secondary = stock.secondary;
      }
    }
    if (c) {
      if (c.kind === "rainbow" && c.set && c.set.length) {
        set = c.set;
        if (!primary) primary = c.set[0];
        if (!secondary) secondary = c.set[1] || c.set[0];
      } else if (c.primary) {
        if (!primary) primary = c.primary;
        if (!secondary) secondary = c.secondary || c.primary;
      }
    }
    return {
      primary: primary || "#4E7CF6",
      secondary: secondary || primary || "#17439F",
      set: set,
    };
  }

  /* ------------------------------------------------------------------ render */

  /** Native tile size in canvas pixels (same source Remix uses for overlays). */
  function nativeTileSize(game) {
    const g = game || root.__mpGame || root.__remixGame;
    try {
      if (typeof root.tempWalls_tile_size === "function") {
        const t = Number(root.tempWalls_tile_size(null));
        if (Number.isFinite(t) && t > 0) return t;
      }
    } catch (e) { /* ignore */ }
    try {
      if (g && g.ka && Number(g.ka.ka) > 0) return Number(g.ka.ka);
      if (g && g.Ja && g.Ja.wb && g.Ja.wb.ka && Number(g.Ja.wb.ka.ka) > 0) {
        return Number(g.Ja.wb.ka.ka);
      }
    } catch (e2) { /* ignore */ }
    return 0;
  }

  /**
   * Snake overlay layout — must match native floor/fruit (same tile + origin).
   * Do NOT invent a second fill-center board; that double-draws apples and
   * fights Classic's native chrome.
   * @returns {{w:number,h:number,cell:number,ox:number,oy:number}|null}
   */
  function authBoardLayout(renderer, game) {
    const state = root.__mpCoopLastState;
    let w = 0;
    let h = 0;
    if (state) {
      w = state.width | 0;
      h = state.height | 0;
    }
    if (!(w > 0) || !(h > 0)) {
      const sz = boardSizeFromGame(game);
      w = sz.width | 0;
      h = sz.height | 0;
    }
    if (!(w > 0) || !(h > 0)) return null;
    const cell = nativeTileSize(game);
    if (!(cell > 0)) return null;
    // Native Classic paints from the engine origin (0,0) in PlayerRenderer space
    const layout = { w: w, h: h, cell: cell, ox: 0, oy: 0 };
    root.__mpCoopAuthLayout = layout;
    return layout;
  }

  // Light-mode fog mask, rebuilt once per tick (per-frame scraping is too slow).
  let _lightMask = null;
  let _lightMaskAt = 0;
  function invalidateLightMask() {
    _lightMask = null;
    _lightMaskAt = 0;
  }

  /**
   * Light mode hides everything outside the lit disks, so remote snakes must be
   * masked too — otherwise co-op would reveal the board through the fog.
   */
  function lightMaskFor(game) {
    if (!modeKeyHas(coopModeKey(), "light")) return null;
    const now = nowMs();
    if (_lightMask && now - _lightMaskAt < 40) return _lightMask;
    const Gsm = root.MultiplayerGsm;
    if (!Gsm || typeof Gsm.collectMosaicLights !== "function") return null;
    const heads = [];
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    Object.keys(remotes).forEach(function (id) {
      if (myId && id === myId) return;
      const r = remotes[id];
      if (!r || r.alive === false) return;
      const body = r.body || [];
      if (body[0]) {
        heads.push({
          x: body[0].x,
          y: body[0].y,
          light: r.headLight != null ? r.headLight : 2,
        });
      }
      const body2 = r.body2 || [];
      if (body2[0]) {
        heads.push({
          x: body2[0].x,
          y: body2[0].y,
          light: r.headLight2 != null ? r.headLight2 : 2,
        });
      }
    });
    let mask = null;
    try {
      mask = Gsm.collectMosaicLights({
        modeKey: "light",
        body: (game && game.oa && game.oa.ka) || [],
        body2: (function () {
          try {
            if (game && game.Ra && game.Ra.ka) return game.Ra.ka;
            if (game && game.oa && game.oa.Ra && game.oa.Ra.ka) {
              return game.oa.Ra.ka;
            }
          } catch (e) { /* ignore */ }
          return [];
        })(),
        apples: (game && game.wa && game.wa.ka) || [],
        heads: heads,
      });
    } catch (e) {
      mask = null;
    }
    _lightMask = mask;
    _lightMaskAt = now;
    return mask;
  }

  let _drawWarnAt = 0;

  /**
   * Native fog only lights the local head. Clip to each remote light disk and
   * repaint shared apples/walls so teammates actually reveal the board.
   */
  function revealRemoteLightDisks(ctx, game, tile, size, lights) {
    if (!lights || !lights.length || !(tile > 0)) return;
    const Gsm = root.MultiplayerGsm;
    if (!Gsm) return;
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    const cols = root.__mpCoopCollectables || {};
    const board = {
      modeKey: "light",
      width: size.width,
      height: size.height,
      apples: cols.apples || (game && game.wa && game.wa.ka) || [],
      walls: cols.walls || [],
      keys: cols.keys,
      boxes: cols.boxes,
      goals: cols.goals,
      mines: cols.mines,
      statues: cols.statues,
      bridges: cols.bridges,
      gates: cols.gates,
      arrows: cols.arrows,
    };
    const theme = null;
    Object.keys(remotes).forEach(function (id) {
      if (myId && id === myId) return;
      const r = remotes[id];
      if (!r || r.alive === false) return;
      const heads = [];
      if (r.body && r.body[0]) {
        heads.push({
          x: r.body[0].x,
          y: r.body[0].y,
          light: r.headLight != null ? Number(r.headLight) : 2,
        });
      }
      if (r.body2 && r.body2[0]) {
        heads.push({
          x: r.body2[0].x,
          y: r.body2[0].y,
          light: r.headLight2 != null ? Number(r.headLight2) : 2,
        });
      }
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        const rTiles = Math.max(2, Number(h.light) || 2);
        const cx = (Number(h.x) + 0.5) * tile;
        const cy = (Number(h.y) + 0.5) * tile;
        const rad = rTiles * tile;
        ctx.save();
        try {
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.clip();
          if (typeof Gsm.drawBoardWalls === "function") {
            Gsm.drawBoardWalls(ctx, board, 0, 0, tile, theme, lights);
          }
          if (typeof Gsm.drawBoardModeEntities === "function") {
            Gsm.drawBoardModeEntities(ctx, board, 0, 0, tile, theme, lights);
          }
          if (typeof Gsm.drawBoardApples === "function") {
            Gsm.drawBoardApples(ctx, board, 0, 0, tile, theme, lights);
          }
        } finally {
          ctx.restore();
        }
      }
    });
  }

  /**
   * Draw every remote co-op snake into the layer the local snake was just
   * painted on. `renderer.ka` is the PlayerRenderer's 2D context and
   * `renderer.wb` its GameInstance, so cell (x,y) sits at (x*tile, y*tile) with
   * no origin offset — the same mapping Remix uses for its own overlays.
   */
  function drawCoopRemotes(renderer, acceptRemote) {
    if (!root.__mpCoopInject || !root.__mpCoopSession) return 0;
    const ctx = renderer && renderer.ka;
    if (!ctx || typeof ctx.save !== "function") return 0;
    const game = (renderer && renderer.wb) || root.__mpGame || root.__remixGame;
    let ox = 0;
    let oy = 0;
    let tile = 0;
    let size = { width: 0, height: 0 };
    // Co-op always uses fill+center auth layout (same as drawAuthBoardChrome)
    const layout =
      root.__mpCoopAuthLayout || authBoardLayout(renderer, game);
    if (!layout) return 0;
    tile = layout.cell;
    ox = layout.ox;
    oy = layout.oy;
    size = { width: layout.w, height: layout.h };

    const myId = root.__mpCoopMyId;
    const remotes = root.__mpCoopRemotes || {};
    const ids = Object.keys(remotes);
    if (!ids.length) return 0;

    const Gsm = root.MultiplayerGsm;
    if (!Gsm || typeof Gsm.drawWallSolverStyleSnake !== "function") return 0;

    const colorsById = displayColorIds();
    const modeKey = coopModeKey();
    const wraps =
      modeKeyHas(modeKey, "borderless") || modeKeyHas(modeKey, "peaceful");
    const hostDim = localOtherDim(game);
    const dimension = coopIsDimensionMode();
    const opts = {
      cheese: coopIsCheeseMode(),
      lights: lightMaskFor(game),
      wrapWidth: wraps ? size.width : 0,
      wrapHeight: wraps ? size.height : 0,
    };

    // Reveal board tiles inside remote light disks (native fog only knows local head)
    try {
      revealRemoteLightDisks(ctx, game, tile, size, opts.lights);
    } catch (eRev) { /* ignore */ }

    let drawn = 0;
    ctx.save();
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (myId && id === myId) continue;
        const r = remotes[id];
        if (!r) continue;
        if (acceptRemote && !acceptRemote(r, id)) continue;
        let body = r._visualBody;
        if (!bodyIsRenderable(body)) body = r.body;
        if (!bodyIsRenderable(body)) continue;
        // Drop seats built for a larger board — OOB paint looks like border walls
        if (size.width > 0 && size.height > 0) {
          const inBounds = body.every(function (p) {
            return (
              p &&
              (p.x | 0) >= 0 &&
              (p.y | 0) >= 0 &&
              (p.x | 0) < size.width &&
              (p.y | 0) < size.height
            );
          });
          if (!inBounds) continue;
        }
        // Deltas land one remote tick at a time but this runs every native
        // frame, so slide the snake between cells instead of hopping it. The
        // record survives merges by Object.assign, and so does the state.
        opts.motion =
          typeof Gsm.snakeMotion === "function"
            ? Gsm.snakeMotion(r, "coop", body)
            : null;
        // The mosaic renderer ghosts `otherDim` segments, but the sender tagged
        // them against the dimension its own board was showing. Retag against
        // the one the local player is standing in.
        if (dimension) {
          body = body.map(function (p) {
            const out = { x: p.x, y: p.y };
            if (!!p.otherDim !== !!hostDim) out.otherDim = true;
            return out;
          });
        }
        // A corpse / poisoned snake reads faded / grey, matching the mosaic.
        const dead = r.alive === false;
        const poisoned = !!r.poisoned;
        ctx.globalAlpha = dead ? 0.55 : 1;
        const colorInfo = poisoned
          ? { primary: "#eceff1", secondary: "#90a4ae", set: null }
          : remoteColorInfo(r, colorsById[id]);
        try {
          Gsm.drawWallSolverStyleSnake(
            ctx,
            body,
            ox,
            oy,
            tile,
            colorInfo,
            r.dir,
            opts
          );
          // Yin Yang companion
          let body2 = r.body2;
          if (bodyIsRenderable(body2)) {
            if (size.width > 0 && size.height > 0) {
              const inB = body2.every(function (p) {
                return (
                  p &&
                  (p.x | 0) >= 0 &&
                  (p.y | 0) >= 0 &&
                  (p.x | 0) < size.width &&
                  (p.y | 0) < size.height
                );
              });
              if (!inB) body2 = null;
            }
          } else {
            body2 = null;
          }
          if (body2) {
            let companionColor = poisoned
              ? { primary: "#eceff1", secondary: "#90a4ae", set: null }
              : { primary: "#eceff1", secondary: "#90a4ae", set: null };
            opts.motion =
              typeof Gsm.snakeMotion === "function"
                ? Gsm.snakeMotion(r, "coop-body2", body2)
                : null;
            Gsm.drawWallSolverStyleSnake(
              ctx,
              body2,
              ox,
              oy,
              tile,
              companionColor,
              r.dir,
              opts
            );
          }
          drawn++;
        } catch (e) {
          const t = Date.now();
          if (t - _drawWarnAt > 2000) {
            _drawWarnAt = t;
            console.warn("__mpCoop drawRemotes", e);
          }
        }
      }
    } finally {
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    return drawn;
  }

  /**
   * PlayerRenderer.render(a,b,c) — `a` is usually lerp progress. NaN progress
   * throws Closure `Error: yi NaN×4` and kills the native render loop.
   */
  function sanitizeRenderArgs(a, b, c) {
    let prog = a;
    if (typeof prog === "number" && !Number.isFinite(prog)) prog = 0;
    if (prog == null) prog = 0;
    if (typeof prog === "number") prog = Math.max(0, Math.min(1, prog));
    return [prog, b === undefined ? true : b, c == null ? {} : c];
  }

  function isYiNanError(err) {
    const msg = String((err && err.message) || err || "");
    return /\byi\b/i.test(msg) && /NaN/i.test(msg);
  }

  /* ------------------------------------------------ native peer rendering */

  const NATIVE_RELAY = "native-relay-v1";
  const NATIVE_MAX_PEERS = 3;
  const NATIVE_CANVAS_PROPS = [
    "globalAlpha",
    "globalCompositeOperation",
    "imageSmoothingEnabled",
    "imageSmoothingQuality",
    "filter",
    "direction",
  ];
  let _nativeBackend = null;

  function nativeMetrics() {
    if (!_nativeBackend) return {
      generation: Number(root.__mpCoopGeneration) || 0,
      backend: "mosaic",
      cadence: 60,
      renderCount: 0,
      refreshCount: 0,
      compositeCount: 0,
      layerAllocations: 0,
      layerReleases: 0,
      bufferGrowth: 0,
      fallbackReason: null,
    };
    return _nativeBackend.metrics;
  }

  function publishNativeMetrics(state) {
    state.metrics.audited = !!state.audited;
    root.__mpCoopNativeRenderMetrics = state.metrics;
    const now = Date.now();
    if (!state.lastDebugAt || now - state.lastDebugAt >= 1000) {
      state.lastDebugAt = now;
      root.__mpCoopNativeRenderDebug = Object.assign({}, state.metrics);
    }
  }

  function releaseNativeBackend(reason) {
    const state = _nativeBackend;
    if (!state) return;
    state._pendingPeerComposite = null;
    Object.keys(state.seats).forEach(function (id) {
      const seat = state.seats[id];
      if (seat && seat.canvas && seat.canvas.parentNode) {
        try { seat.canvas.parentNode.removeChild(seat.canvas); } catch (e) { /* ignore */ }
      }
      state.metrics.layerReleases++;
    });
    state.seats = Object.create(null);
    if (reason && !state.metrics.fallbackReason) state.metrics.fallbackReason = reason;
    publishNativeMetrics(state);
    _nativeBackend = null;
  }

  function createNativeBackend(generation) {
    releaseNativeBackend("generation-changed");
    const metrics = {
      generation: generation,
      backend: "layers",
      cadence: 60,
      renderCount: 0,
      refreshCount: 0,
      compositeCount: 0,
      layerAllocations: 0,
      layerReleases: 0,
      bufferGrowth: 0,
      fallbackReason: null,
      renderExceptions: 0,
      averageRefreshMs: 0,
      leanPassCount: 0,
      fullPassCount: 0,
      faceTintCacheBakes: 0,
      faceTintBlits: 0,
      audited: false,
    };
    clearFaceTintCache();
    _nativeBackend = {
      generation: generation,
      seats: Object.create(null),
      frame: 0,
      disabled: false,
      audited: false,
      exceptionTimes: [],
      metrics: metrics,
      lastDebugAt: 0,
    };
    publishNativeMetrics(_nativeBackend);
    return _nativeBackend;
  }

  function nativeState() {
    const generation = Number(root.__mpCoopGeneration) || 0;
    if (!_nativeBackend || _nativeBackend.generation !== generation) {
      return createNativeBackend(generation);
    }
    return _nativeBackend;
  }

  function disableNative(state, reason) {
    state.disabled = true;
    state.metrics.backend = "mosaic";
    state.metrics.fallbackReason = reason || "disabled";
    publishNativeMetrics(state);
    if (!state._fallbackWarned) {
      state._fallbackWarned = true;
      console.warn(
        "[Multiplayer] native peers → mosaic fallback:",
        state.metrics.fallbackReason
      );
    }
  }

  /** Clear sticky mosaic disable from a prior match so the next run can try native again. */
  function resetNativePeerPaint(reason) {
    releaseNativeBackend(reason || "session-begin");
    const generation = Number(root.__mpCoopGeneration) || 0;
    createNativeBackend(generation);
    root.__mpCoopNativeRenderDebug = {
      generation: generation,
      backend: "layers",
      fallbackReason: null,
      resetAt: Date.now(),
    };
  }

  function noteNativeException(state, err) {
    const now = Date.now();
    state.exceptionTimes = state.exceptionTimes.filter(function (at) {
      return now - at <= 10000;
    });
    state.exceptionTimes.push(now);
    state.metrics.renderExceptions++;
    if (state.exceptionTimes.length >= 3) {
      disableNative(state, "render-circuit-breaker");
    }
    const at = Date.now();
    if (at - _drawWarnAt > 2000) {
      _drawWarnAt = at;
      console.warn("__mpCoop native peer render", err);
    }
  }

  function isNativeRelayPlayer() {
    return (
      root.__mpCoopInject &&
      root.__mpCoopSession &&
      root.__mpCoopAuthority === NATIVE_RELAY &&
      !root.__mpCoopSpectator &&
      !modeKeyHas(coopModeKey(), "light")
    );
  }

  function remoteSlot(remote, id) {
    const n = Number(
      remote && remote.slot != null
        ? remote.slot
        : remote && remote.seat != null
          ? remote.seat
          : remote && remote.slotIndex
    );
    return Number.isFinite(n) ? n : String(id);
  }

  /**
   * Peers painted natively — live and server-dead corpses (die face via nj).
   * Self is excluded; mosaic must not redraw the same ids when this list is used.
   */
  function nativePeerIds() {
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    return Object.keys(remotes)
      .filter(function (id) {
        const r = remotes[id];
        return (
          (!myId || id !== myId) &&
          r &&
          (!r.clientId || r.clientId === id) &&
          bodyIsRenderable(r.body)
        );
      })
      .sort(function (a, b) {
        const as = remoteSlot(remotes[a], a);
        const bs = remoteSlot(remotes[b], b);
        if (typeof as === "number" && typeof bs === "number" && as !== bs) {
          return as - bs;
        }
        return String(as).localeCompare(String(bs)) || a.localeCompare(b);
      })
      .slice(0, NATIVE_MAX_PEERS);
  }

  /** @deprecated alias — alive-only filter; prefer nativePeerIds for paint. */
  function liveNativePeers() {
    const remotes = root.__mpCoopRemotes || {};
    return nativePeerIds().filter(function (id) {
      return remotes[id] && remotes[id].alive !== false;
    });
  }

  function copyCanvasState(from, to) {
    if (!from || !to) return;
    for (let i = 0; i < NATIVE_CANVAS_PROPS.length; i++) {
      const k = NATIVE_CANVAS_PROPS[i];
      try {
        if (k in from) to[k] = from[k];
      } catch (e) { /* optional context state */ }
    }
    try {
      if (typeof from.getTransform === "function" && typeof to.setTransform === "function") {
        const t = from.getTransform();
        to.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
      }
    } catch (eT) { /* old canvas */ }
  }

  function createLayer(mainCtx) {
    const source = mainCtx && mainCtx.canvas;
    if (!source) return null;
    let canvas = null;
    try {
      if (root.document && typeof root.document.createElement === "function") {
        canvas = root.document.createElement("canvas");
      } else if (typeof root.OffscreenCanvas === "function") {
        canvas = new root.OffscreenCanvas(source.width, source.height);
      }
    } catch (e) { canvas = null; }
    if (!canvas || typeof canvas.getContext !== "function") return null;
    canvas.width = source.width;
    canvas.height = source.height;
    if (canvas.style) {
      canvas.style.position = "absolute";
      canvas.style.inset = "0";
      canvas.style.width = (source.clientWidth || source.width) + "px";
      canvas.style.height = (source.clientHeight || source.height) + "px";
      canvas.style.pointerEvents = "none";
      canvas.style.opacity = "0";
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    copyCanvasState(mainCtx, ctx);
    return { canvas: canvas, ctx: ctx };
  }

  function pointFactory(template) {
    if (template && typeof template.clone === "function") {
      try {
        const p = template.clone();
        if (p) return p;
      } catch (e) { /* use plain native-shaped point */ }
    }
    const p = { x: 0, y: 0 };
    p.clone = function () {
      const c = { x: this.x, y: this.y };
      c.clone = this.clone;
      return c;
    };
    return p;
  }

  function writeCachedBody(cache, body, template, state) {
    if (!cache.points) cache.points = [];
    while (cache.points.length < body.length) {
      cache.points.push(pointFactory(template));
      if (state && state.metrics) state.metrics.bufferGrowth++;
    }
    cache.points.length = body.length;
    for (let i = 0; i < body.length; i++) {
      cache.points[i].x = Number(body[i].x);
      cache.points[i].y = Number(body[i].y);
      if (body[i].otherDim) cache.points[i].otherDim = true;
      else if ("otherDim" in cache.points[i]) delete cache.points[i].otherDim;
    }
    if (!cache.flags) cache.flags = [];
    while (cache.flags.length < body.length) cache.flags.push(true);
    cache.flags.length = body.length;
    for (let j = 0; j < body.length; j++) {
      cache.flags[j] = !body[j].otherDim;
    }
  }

  function copyIfPresent(target, source, names) {
    for (let i = 0; i < names.length; i++) {
      const k = names[i];
      if (source && source[k] != null) target[k] = source[k];
    }
  }

  function deepClonePlain(value, depth) {
    if (value == null || typeof value !== "object") return value;
    if (depth > 4) return value;
    if (typeof value.clone === "function") {
      try {
        return value.clone();
      } catch (eCl) { /* fall through */ }
    }
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        out[i] = deepClonePlain(value[i], depth + 1);
      }
      return out;
    }
    if (value instanceof Set) return new Set(value);
    if (value instanceof Map) return new Map(value);
    const out = {};
    Object.keys(value).forEach(function (k) {
      try {
        out[k] = deepClonePlain(value[k], depth + 1);
      } catch (eK) {
        out[k] = value[k];
      }
    });
    return out;
  }

  /** Stock PlayerRenderer writes these during render — not peer leaks. */
  const P5E_SNAKE_ALLOW = {
    Dc: true,
    Lc: true,
    Jb: true,
    yc: true,
    Uk: true,
    Aa: true,
    Ba: true,
    Ma: true,
    direction: true,
    dir: true,
    Ca: true,
    Ga: true,
    turns: true,
    pendingTurns: true,
    Sc: true,
    Yc: true,
    headLight: true,
    poisoned: true,
    otherDim: true,
    status: true,
    alive: true,
    ka: true,
    wa: true,
  };

  function freshHeadPoint(template, x, y) {
    const nx = Number(x);
    const ny = Number(y);
    const fx = Number.isFinite(nx) ? nx : 0;
    const fy = Number.isFinite(ny) ? ny : 0;
    if (template && typeof template.clone === "function") {
      try {
        const p = template.clone();
        p.x = fx;
        p.y = fy;
        if (typeof p.clone !== "function") {
          p.clone = function () {
            const c = { x: this.x, y: this.y };
            c.clone = this.clone;
            return c;
          };
        }
        return p;
      } catch (e) { /* fall through */ }
    }
    if (
      root.MultiplayerGsm &&
      typeof root.MultiplayerGsm.makeNativePoint === "function"
    ) {
      return root.MultiplayerGsm.makeNativePoint(fx, fy, template || null);
    }
    const p = { x: fx, y: fy };
    p.clone = function () {
      const c = { x: this.x, y: this.y };
      c.clone = this.clone;
      return c;
    };
    return p;
  }

  /** Keys that must never stay aliased from local → peer (P5E mutates them). */
  const PEER_ISOLATE_HOSTS = {
    Aa: true,
    Ba: true,
    Ma: true,
    ub: true,
    Qa: true,
    Sa: true,
    ob: true,
    Vb: true,
    Dc: true,
    Jb: true,
    Uk: true,
    yc: true,
    Ya: true,
    qc: true,
  };

  /** Stock R6E face host — never seed from local kfa/l2 (that aimed peer eyes at local). */
  function freshFaceHost(light) {
    return {
      pCa: 0,
      RRa: 0,
      kfa: 0,
      l2: 0,
      Maa: false,
      RPa: 0,
      zZa: 0,
      sAa: false,
      light: light != null ? Number(light) | 0 : 2,
    };
  }

  function peerCellPx(game) {
    try {
      if (game && game.ka && Number(game.ka.ka) > 0) return Number(game.ka.ka);
    } catch (e) { /* ignore */ }
    return 0;
  }

  /** Infer facing from head→neck (authoritative when pose dirs lag). */
  function inferDirFromBody(body) {
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

  function normalizePeerDir(value) {
    const d = String(value || "").toUpperCase();
    if (d === "UP" || d === "DOWN" || d === "LEFT" || d === "RIGHT") return d;
    return null;
  }

  /** Infer portal/gap Qa dirs from body kinks (T4E); adjacent L-turns stay undefined. */
  function inferQaFromBody(body) {
    if (!body || body.length < 2) return [];
    const out = [];
    for (let i = 0; i < body.length; i++) out.push(undefined);
    function dirBetween(a, b) {
      if (!a || !b) return null;
      const dx = (b.x | 0) - (a.x | 0);
      const dy = (b.y | 0) - (a.y | 0);
      if (dx === 1 && dy === 0) return "RIGHT";
      if (dx === -1 && dy === 0) return "LEFT";
      if (dx === 0 && dy === 1) return "DOWN";
      if (dx === 0 && dy === -1) return "UP";
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "RIGHT" : "LEFT";
      if (dy !== 0) return dy > 0 ? "DOWN" : "UP";
      return null;
    }
    for (let i = 0; i < body.length - 1; i++) {
      const a = body[i];
      const b = body[i + 1];
      if (!a || !b) continue;
      const gap =
        Math.abs((b.x | 0) - (a.x | 0)) + Math.abs((b.y | 0) - (a.y | 0));
      if (gap > 1) {
        const d = dirBetween(a, b);
        if (d) out[i] = d;
      }
    }
    return out;
  }

  function buildPeerQa(body, remote, suffix) {
    const s = suffix || "";
    const pub =
      remote["Qa" + s] ||
      remote.Qa ||
      remote["turns" + s] ||
      remote.turns;
    if (Array.isArray(pub) && pub.length && body && body.length) {
      const out = [];
      for (let i = 0; i < body.length; i++) {
        out.push(i < pub.length ? pub[i] : undefined);
      }
      return out;
    }
    return inferQaFromBody(body);
  }

  function buildPeerSnake(cache, localSnake, remote, body, suffix, state) {
    cache = cache || {};
    writeCachedBody(cache, body, localSnake && localSnake.ka && localSnake.ka[0], state);
    if (!cache.snake || Object.getPrototypeOf(cache.snake) !== Object.getPrototypeOf(localSnake)) {
      cache.snake = Object.create(localSnake ? Object.getPrototypeOf(localSnake) : Object.prototype);
    }
    const snake = cache.snake;
    if (localSnake) {
      Object.keys(localSnake).forEach(function (k) {
        if (k === "ka" || k === "wa" || k === "Ra") return;
        // Skip face/particle/head hosts — assigned fresh below (never inherit local)
        if (PEER_ISOLATE_HOSTS[k]) return;
        snake[k] = localSnake[k];
      });
    }
    snake.ka = cache.points;
    snake.wa = cache.flags;
    const s = suffix || "";
    const bodyDir = inferDirFromBody(body);
    const moveDir =
      normalizePeerDir(remote["movementDir" + s]) ||
      normalizePeerDir(remote.dir) ||
      bodyDir ||
      "RIGHT";
    // Face along the painted body exit — published headDir can lag a tick and
    // flip eyes vs the disc (A-peer proj sign ≠ B-local).
    let headDir =
      bodyDir ||
      normalizePeerDir(remote["headDir" + s]) ||
      normalizePeerDir(remote["movementDir" + s]) ||
      normalizePeerDir(remote.dir) ||
      "RIGHT";
    const OPP = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
    if (moveDir && headDir && OPP[headDir] === moveDir) {
      headDir = moveDir;
    }
    const transitionDir =
      normalizePeerDir(remote["transitionDir" + s]) ||
      headDir;
    // Always overwrite facing — leaving local Ca while peer direction differs
    // turns on P5E's Dc head-lerp and paints the peer face on the local head.
    snake.direction = moveDir;
    snake.dir = moveDir;
    snake.Ca = headDir;
    snake.Ga = transitionDir;
    if (remote["turns" + s] || remote.turns) {
      snake.turns = remote["turns" + s] || remote.turns;
    }
    // Resolve display colors (claimed / recolor) — never keep local Sc/Yc.
    try {
      const remoteId = remote.clientId || remote.id;
      const displayIds = displayColorIds();
      const displayId =
        remoteId != null && displayIds[remoteId] != null
          ? displayIds[remoteId]
          : remote.colorId != null
            ? Number(remote.colorId)
            : null;
      const info = remoteColorInfo(remote, displayId);
      if (info && info.primary) snake.Sc = info.primary;
      else if (remote[s ? "Sc2" : "Sc"] != null) snake.Sc = remote[s ? "Sc2" : "Sc"];
      if (info && info.secondary) snake.Yc = info.secondary;
      else if (remote[s ? "Yc2" : "Yc"] != null) snake.Yc = remote[s ? "Yc2" : "Yc"];
      if (info && info.primary) {
        if ("color2" in snake || snake.color2 !== undefined) snake.color2 = info.primary;
        if ("primary" in snake) snake.primary = info.primary;
      }
      if (info && info.secondary) {
        if ("color1" in snake || snake.color1 !== undefined) snake.color1 = info.secondary;
        if ("secondary" in snake) snake.secondary = info.secondary;
      }
    } catch (eColor) {
      if (remote[s ? "Sc2" : "Sc"] != null) snake.Sc = remote[s ? "Sc2" : "Sc"];
      if (remote[s ? "Yc2" : "Yc"] != null) snake.Yc = remote[s ? "Yc2" : "Yc"];
    }
    if ("pendingTurns" in snake) snake.pendingTurns = remote["turns" + s] || remote.turns || [];
    if (remote["headLight" + s] != null) snake.headLight = remote["headLight" + s];
    copyIfPresent(snake, remote, ["poisoned", "otherDim", "status"]);
    // Server-auth'd alive drives peer graph; J5E still keys off game.nj (set in pass).
    snake.alive = remote.alive !== false;

    // Fresh face + particle hosts every pass. Cloning local Aa/Ba carried
    // local eye angles (kfa/l2) onto the peer head.
    const faceLight =
      remote["headLight" + s] != null
        ? remote["headLight" + s]
        : remote.headLight;
    snake.Aa = freshFaceHost(faceLight);
    snake.Ba = freshFaceHost(faceLight);
    // Seed eye look-at to facing so the first peer frame isn't RIGHT-biased.
    const faceAngle =
      headDir === "UP"
        ? -Math.PI / 2
        : headDir === "DOWN"
          ? Math.PI / 2
          : headDir === "LEFT"
            ? Math.PI
            : 0;
    snake.Aa.kfa = faceAngle;
    snake.Ba.kfa = faceAngle;
    snake.Ma = [];
    snake.ub = [];
    // Portal/gap turn journal — never wipe to [] (T4E corner joins).
    snake.Qa = buildPeerQa(body, remote, s);
    snake.Sa = [];

    // Poison/dizzy face counters — never inherit local Ja/hb
    snake.Ja = remote.poisoned || remote["poisoned" + s] ? 2 : 0;
    snake.hb = false;

    // Isolate head geometry in *pixel* space (stock Dc after render is px).
    // Grid-seeded Dc + inter-tick lerp (b falsy) still pulled faces toward local.
    const head = body && body[0];
    const tip = body && body.length ? body[body.length - 1] : head;
    const hx = head && head.x != null ? Number(head.x) : 0;
    const hy = head && head.y != null ? Number(head.y) : 0;
    const tx = tip && tip.x != null ? Number(tip.x) : hx;
    const ty = tip && tip.y != null ? Number(tip.y) : hy;
    const game = root.__mpGame || root.__remixGame;
    const cell = peerCellPx(game);
    const toPx = function (gx, gy) {
      if (cell > 0) return { x: (gx + 0.5) * cell, y: (gy + 0.5) * cell };
      return { x: gx, y: gy };
    };
    const hp = toPx(hx, hy);
    const tipPx = toPx(tx, ty);
    // Stock P5E uses Ya as a virtual point *past* the tip for the rounded cap.
    // Seeding Ya/yc on the tip cell flattens / flips the peer tail vs local.
    let outX = 0;
    let outY = 0;
    if (body && body.length >= 2) {
      const neck = body[body.length - 2];
      const nx = neck && neck.x != null ? Number(neck.x) : tx;
      const ny = neck && neck.y != null ? Number(neck.y) : ty;
      outX = tx - nx;
      outY = ty - ny;
    }
    const outLen = Math.hypot(outX, outY);
    if (outLen < 1e-6) {
      // Fall back to movement / head facing when tip==neck (tiny snakes).
      const d = String(moveDir || headDir || "RIGHT").toUpperCase();
      if (d === "LEFT") {
        outX = -1;
        outY = 0;
      } else if (d === "UP") {
        outX = 0;
        outY = -1;
      } else if (d === "DOWN") {
        outX = 0;
        outY = 1;
      } else {
        outX = 1;
        outY = 0;
      }
    } else {
      outX /= outLen;
      outY /= outLen;
    }
    const beyond =
      cell > 0
        ? { x: tipPx.x + outX * cell, y: tipPx.y + outY * cell }
        : { x: tipPx.x + outX, y: tipPx.y + outY };
    const loc = localSnake || {};
    snake.Dc = freshHeadPoint(loc.Dc, hp.x, hp.y);
    snake.Jb = freshHeadPoint(loc.Jb, hp.x, hp.y);
    snake.Uk = freshHeadPoint(loc.Uk, hp.x, hp.y);
    snake.yc = freshHeadPoint(loc.yc, beyond.x, beyond.y);
    snake.Ya = freshHeadPoint(loc.Ya, beyond.x, beyond.y);
    if (loc.qc != null || "qc" in snake) {
      snake.qc = freshHeadPoint(loc.qc, beyond.x, beyond.y);
    }
    snake.Lc = 0;
    snake.Oa = false;
    snake.Ka = 0;
    if ("Ub" in snake) snake.Ub = 0;
    if ("Zb" in snake) snake.Zb = 0;
    if ("Ua" in snake) snake.Ua = 0;

    return { snake: snake, cache: cache };
  }

  function snapshotHost(host) {
    if (!host || (typeof host !== "object" && typeof host !== "function")) return null;
    const keys = Object.keys(host);
    const values = Object.create(null);
    for (let i = 0; i < keys.length; i++) values[keys[i]] = host[keys[i]];
    return { host: host, keys: keys, values: values };
  }

  function restoreHost(snap) {
    if (!snap) return true;
    const host = snap.host;
    let ok = true;
    Object.keys(host).forEach(function (k) {
      if (snap.keys.indexOf(k) < 0) {
        try { delete host[k]; } catch (e) { ok = false; }
      }
    });
    for (let i = 0; i < snap.keys.length; i++) {
      const k = snap.keys[i];
      try {
        host[k] = snap.values[k];
        if (host[k] !== snap.values[k]) ok = false;
      } catch (e) { ok = false; }
    }
    return ok;
  }

  function hostHasUnknownMutation(snap, allowed) {
    if (!snap) return false;
    const nowKeys = Object.keys(snap.host);
    if (nowKeys.length !== snap.keys.length) {
      // Peer pass may add allowlisted keys (e.g. game.nj) that were absent
      // on a minimal host — those are restored after; only flag other churn.
      const was = Object.create(null);
      for (let i = 0; i < snap.keys.length; i++) was[snap.keys[i]] = true;
      for (let i = 0; i < nowKeys.length; i++) {
        const k = nowKeys[i];
        if (!was[k] && !(allowed && allowed[k])) return true;
      }
      for (let i = 0; i < snap.keys.length; i++) {
        const k = snap.keys[i];
        if (!(k in snap.host) && !(allowed && allowed[k])) return true;
      }
    }
    for (let i = 0; i < snap.keys.length; i++) {
      const k = snap.keys[i];
      if (allowed && allowed[k]) continue;
      if (!(k in snap.host)) continue;
      if (snap.host[k] !== snap.values[k]) return true;
    }
    return false;
  }

  /**
   * @param {*} snake
   * @param {boolean=} slim After first successful audit, skip per-segment /
   *   per-turn host walks — host-level snapshots still restore aliases.
   */
  function snapshotSnakeGraph(snake, slim) {
    if (!snake) return [];
    const out = [snapshotHost(snake), snapshotHost(snake.ka), snapshotHost(snake.wa)];
    if (!slim) {
      const body = snake.ka || [];
      for (let i = 0; i < body.length; i++) out.push(snapshotHost(body[i]));
      const turns = snake.turns || snake.pendingTurns;
      out.push(snapshotHost(turns));
      for (let j = 0; turns && j < turns.length; j++) {
        out.push(snapshotHost(turns[j]));
      }
    }
    // Face / eat hosts — shallow restore needs these if anything still aliased
    out.push(snapshotHost(snake.Aa));
    out.push(snapshotHost(snake.Ba));
    out.push(snapshotHost(snake.Ma));
    if (!slim) {
      const ma = snake.Ma || [];
      for (let m = 0; m < ma.length; m++) {
        out.push(snapshotHost(ma[m]));
        if (ma[m] && ma[m].Fcb) out.push(snapshotHost(ma[m].Fcb));
      }
    }
    return out;
  }

  function graphMutated(snaps, allowed) {
    for (let i = 0; i < snaps.length; i++) {
      if (hostHasUnknownMutation(snaps[i], allowed)) return true;
    }
    return false;
  }

  function restoreGraph(snaps) {
    let ok = true;
    for (let i = snaps.length - 1; i >= 0; i--) {
      ok = restoreHost(snaps[i]) && ok;
    }
    return ok;
  }

  function modeGateHosts(renderer, game) {
    const hosts = [];
    function add(host) {
      if (!host || typeof host !== "object" || hosts.indexOf(host) >= 0) return;
      hosts.push(host);
    }
    add(renderer && renderer.settings);
    add(game && game.settings);
    add(renderer && renderer.modeSettings);
    add(game && game.modeSettings);
    [renderer, game].forEach(function (owner) {
      Object.keys(owner || {}).forEach(function (k) {
        const value = owner[k];
        if (value && typeof value === "object" && /setting|mode/i.test(k)) add(value);
      });
    });
    return hosts;
  }

  function discoveredRenderHosts(renderer, game, localSnake, companion) {
    const hosts = [];
    function add(host) {
      if (!host || typeof host !== "object" || hosts.indexOf(host) >= 0) return;
      hosts.push(host);
    }
    [renderer, game, localSnake, companion].forEach(function (owner) {
      Object.keys(owner || {}).forEach(function (k) {
        if (!/color|status|light|dimension|dimHost/i.test(k)) return;
        add(owner[k]);
      });
    });
    return hosts;
  }

  /**
   * Stock Yin Yang can synthesize its second snake from renderer settings even
   * after Ra is hidden. Temporarily select the neutral mode on every discovered
   * renderer/game settings host. If no gate is discoverable, native YY is unsafe.
   */
  function suppressStockCompanion(renderer, game, isYinYang) {
    const hosts = modeGateHosts(renderer, game);
    const snaps = hosts.map(snapshotHost);
    let changed = 0;
    if (isYinYang) {
      hosts.forEach(function (host) {
        Object.keys(host).forEach(function (k) {
          if (!/^(mode|modeKey|gameMode|snakeMode)$/i.test(k)) return;
          const value = host[k];
          if (typeof value !== "string" || !/yin.?yang/i.test(value)) return;
          try {
            host[k] = k.toLowerCase().indexOf("key") >= 0 ? "classic" : "";
            changed++;
          } catch (e) { /* restoration audit handles readonly hosts */ }
        });
      });
    }
    return { snapshots: snaps, changed: changed };
  }

  function canvasSnapshot(ctx) {
    if (!ctx) return null;
    const out = { ctx: ctx, values: Object.create(null), transform: null };
    for (let i = 0; i < NATIVE_CANVAS_PROPS.length; i++) {
      const k = NATIVE_CANVAS_PROPS[i];
      try { out.values[k] = ctx[k]; } catch (e) { /* ignore */ }
    }
    try {
      if (typeof ctx.getTransform === "function") out.transform = ctx.getTransform();
    } catch (eT) { /* ignore */ }
    return out;
  }

  function restoreCanvas(snap) {
    if (!snap) return true;
    let ok = true;
    Object.keys(snap.values).forEach(function (k) {
      try {
        snap.ctx[k] = snap.values[k];
        if (snap.ctx[k] !== snap.values[k]) ok = false;
      } catch (e) { ok = false; }
    });
    try {
      if (snap.transform && typeof snap.ctx.setTransform === "function") {
        const t = snap.transform;
        snap.ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
      }
    } catch (eT) { ok = false; }
    return ok;
  }

  const FACE_SPRITE_BASE = "#5282F2";

  function normalizeFaceHex(hex) {
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

  /** Current baked face tint — prefer live Sc so peer restore matches the body. */
  function localFaceTintHex(localSnake, renderer) {
    const fromSc = normalizeFaceHex(localSnake && localSnake.Sc);
    if (fromSc) return fromSc;
    const tracked = normalizeFaceHex(root.__mpFaceTintSc);
    if (tracked) return tracked;
    const settings =
      (renderer && renderer.settings) ||
      (localSnake && localSnake.settings) ||
      null;
    const wa = settings && settings.wa;
    if (wa === 0 || wa === 10) return FACE_SPRITE_BASE;
    return FACE_SPRITE_BASE;
  }

  /** Atlas "from" candidates when swapping peer face tint (stale tracker + Sc + stock). */
  function localFaceFromHints(localSnake, renderer) {
    const hints = [];
    function push(h) {
      const n = normalizeFaceHex(h);
      if (!n || hints.indexOf(n) >= 0) return;
      hints.push(n);
    }
    push(root.__mpFaceTintSc);
    push(localSnake && localSnake.Sc);
    push(FACE_SPRITE_BASE);
    const settings =
      (renderer && renderer.settings) ||
      (localSnake && localSnake.settings) ||
      null;
    const wa = settings && settings.wa;
    if (wa === 0 || wa === 10) push(FACE_SPRITE_BASE);
    return hints;
  }

  /**
   * Face sprite sheets live on P5E. Hooks wrap P5E (`__mpCoopRenderEnter`),
   * while X5E exposes the same instance as `.Ga` / `__slotFaceRef`.
   */
  function resolveFaceSheetRoot(renderer) {
    if (root.__slotFaceRef && root.__slotFaceRef.oa) return root.__slotFaceRef;
    const r = renderer || root.__mpCoopPlayerRenderer;
    if (r && r.oa && r.Aa && r.wb) return r;
    if (r && r.Ga && r.Ga.oa && r.Ga.Aa) return r.Ga;
    return null;
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

  /**
   * Stock face `b7` sprites draw through construction-time `.context`, not
   * `renderer.ka`. Seat-layer peer paint must retarget those hosts to the seat
   * ctx or eyes land on the main buffer and get covered by the composite.
   */
  function snapshotFaceSheetContexts(faceRoot) {
    const hosts = faceSheetHosts(faceRoot);
    const snaps = [];
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i];
      if (!h || !Object.prototype.hasOwnProperty.call(h, "context")) continue;
      snaps.push({ host: h, context: h.context });
    }
    return snaps;
  }

  function recolorPeerFaceSprites(renderer, fromHex, toHex) {
    const a7 = root.__slotA7;
    const face = resolveFaceSheetRoot(renderer);
    if (typeof a7 !== "function" || !face) return false;
    const from = normalizeFaceHex(fromHex);
    const to = normalizeFaceHex(toHex);
    if (!from || !to || from === to) return false;
    const hosts = faceSheetHosts(face);
    let any = false;
    for (let i = 0; i < hosts.length; i++) {
      try {
        a7(hosts[i], from, to);
        any = true;
      } catch (eA7) {
        /* ignore */
      }
    }
    return any;
  }

  /**
   * Recolor shared face atlases to `toHex` from the currently tracked tint
   * (plus one stock-base fallback). Returns true if any host was touched.
   * Cheap no-op when the atlas is already `toHex`.
   */
  function ensureFaceAtlasTint(renderer, toHex, fromHints) {
    const to = normalizeFaceHex(toHex);
    if (!to) return false;
    const current = normalizeFaceHex(root.__mpFaceTintSc);
    if (current === to) return false;
    const hints = [];
    function push(h) {
      const n = normalizeFaceHex(h);
      if (!n || n === to || hints.indexOf(n) >= 0) return;
      hints.push(n);
    }
    push(current);
    if (fromHints) {
      for (let i = 0; i < fromHints.length; i++) push(fromHints[i]);
    }
    push(FACE_SPRITE_BASE);
    let any = false;
    for (let i = 0; i < hints.length; i++) {
      if (recolorPeerFaceSprites(renderer, hints[i], to)) any = true;
    }
    if (any) root.__mpFaceTintSc = to;
    return any;
  }

  /**
   * Collect 2d contexts that hold tinted face bitmaps (eye rings + J5E overlays).
   * Must match faceSheetHosts — oa/Aa/Ba alone left Ga/Ja/Sa/… at the other
   * snake’s tint and painted opposite-color eye fringes on both local and peer.
   */
  function iterFaceTintContexts(faceRoot) {
    const out = [];
    if (!faceRoot) return out;
    const hosts = faceSheetHosts(faceRoot);
    const seen = typeof WeakSet === "function" ? new WeakSet() : null;
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i];
      const sheets = [h.oa, h.Ba, h.Ca].filter(Boolean);
      if (sheets.length) {
        for (let s = 0; s < sheets.length; s++) {
          const sheet = sheets[s];
          const ctx = sheet && sheet.ka;
          if (
            ctx &&
            ctx.canvas &&
            ctx.canvas.width > 0 &&
            ctx.canvas.height > 0 &&
            (typeof ctx.drawImage === "function" ||
              typeof ctx.getImageData === "function")
          ) {
            if (seen) {
              if (seen.has(ctx)) continue;
              seen.add(ctx);
            }
            out.push(ctx);
          }
        }
      } else if (
        h.ka &&
        h.ka.canvas &&
        h.ka.canvas.width > 0 &&
        (typeof h.ka.drawImage === "function" ||
          typeof h.ka.getImageData === "function")
      ) {
        if (seen) {
          if (seen.has(h.ka)) continue;
          seen.add(h.ka);
        }
        out.push(h.ka);
      }
    }
    return out;
  }

  function captureFaceHostImages(faceRoot) {
    const ctxs = iterFaceTintContexts(faceRoot);
    const snaps = [];
    for (let i = 0; i < ctxs.length; i++) {
      const ctx = ctxs[i];
      try {
        const w = ctx.canvas.width | 0;
        const h = ctx.canvas.height | 0;
        if (!(w > 0 && h > 0)) continue;
        let copy = null;
        try {
          if (root.document && typeof root.document.createElement === "function") {
            copy = root.document.createElement("canvas");
          } else if (typeof root.OffscreenCanvas === "function") {
            copy = new root.OffscreenCanvas(w, h);
          }
        } catch (eEl) {
          copy = null;
        }
        if (!copy || typeof copy.getContext !== "function") {
          // Fallback: ImageData snapshot
          const data = ctx.getImageData(0, 0, w, h);
          snaps.push({ ctx: ctx, data: data, w: w, h: h });
          continue;
        }
        copy.width = w;
        copy.height = h;
        const cctx = copy.getContext("2d");
        if (!cctx) continue;
        cctx.drawImage(ctx.canvas, 0, 0);
        snaps.push({ ctx: ctx, canvas: copy, w: w, h: h });
      } catch (eCap) {
        /* tainted / not ready */
      }
    }
    return snaps;
  }

  function applyFaceHostImages(snaps) {
    if (!snaps || !snaps.length) return false;
    let any = false;
    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (!s || !s.ctx) continue;
      try {
        if (s.ctx.canvas.width !== s.w || s.ctx.canvas.height !== s.h) {
          s.ctx.canvas.width = s.w;
          s.ctx.canvas.height = s.h;
        }
        if (s.canvas) {
          s.ctx.drawImage(s.canvas, 0, 0);
          any = true;
        } else if (s.data && typeof s.ctx.putImageData === "function") {
          s.ctx.putImageData(s.data, 0, 0);
          any = true;
        }
      } catch (ePut) {
        /* ignore */
      }
    }
    return any;
  }

  /** Per-hex baked face atlas snapshots — bake once (stock Play a7), blit after. */
  let _faceTintCache = Object.create(null);

  function clearFaceTintCache() {
    _faceTintCache = Object.create(null);
  }

  /**
   * Ensure ImageData cache entry for `hex`. Runs stock a7 at most once per hex,
   * then restores the live atlas so local play is undisturbed.
   */
  function ensureFaceTintCache(renderer, hex, metrics) {
    const key = normalizeFaceHex(hex);
    if (!key) return null;
    const hit = _faceTintCache[key];
    if (hit && (hit.snaps.length || hit.synthetic)) return hit;

    const face = resolveFaceSheetRoot(renderer);
    if (!face) return null;

    const liveBefore =
      normalizeFaceHex(root.__mpFaceTintSc) || FACE_SPRITE_BASE;
    const beforeSnaps = captureFaceHostImages(face);
    if (beforeSnaps.length && !_faceTintCache[liveBefore]) {
      _faceTintCache[liveBefore] = {
        snaps: beforeSnaps,
        hex: liveBefore,
        synthetic: false,
      };
    }

    if (liveBefore !== key) {
      ensureFaceAtlasTint(renderer, key, [liveBefore, FACE_SPRITE_BASE]);
    }
    const snaps = captureFaceHostImages(face);
    let entry;
    if (snaps.length) {
      entry = { snaps: snaps, hex: key, synthetic: false };
      _faceTintCache[key] = entry;
      // Full a7 restore — blit subset alone left Ga/Ja/Sa at peer tint.
      if (liveBefore !== key) {
        ensureFaceAtlasTint(renderer, liveBefore, [key, FACE_SPRITE_BASE]);
      }
    } else {
      // Harness / unloaded sheets — remember bake so callers can fall back.
      entry = { snaps: [], hex: key, synthetic: true };
      _faceTintCache[key] = entry;
      if (liveBefore !== key) {
        ensureFaceAtlasTint(renderer, liveBefore, [key, FACE_SPRITE_BASE]);
      }
    }
    if (metrics) {
      metrics.faceTintCacheBakes = (metrics.faceTintCacheBakes | 0) + 1;
    }
    return entry;
  }

  /** Apply cached peer face bake; restore local via cache (no per-frame a7). */
  function blitFaceTintFromCache(renderer, toHex, metrics) {
    const key = normalizeFaceHex(toHex);
    if (!key) return false;
    const entry = ensureFaceTintCache(renderer, key, metrics);
    if (!entry || !entry.snaps.length) return false;
    if (normalizeFaceHex(root.__mpFaceTintSc) === key) return true;
    if (!applyFaceHostImages(entry.snaps)) return false;
    root.__mpFaceTintSc = key;
    if (metrics) {
      metrics.faceTintBlits = (metrics.faceTintBlits | 0) + 1;
    }
    return true;
  }

  function renderPeerPass(state, renderer, origRender, args, remote, body, seat, suffix, targetCtx, passOpts) {
    passOpts = passOpts || {};
    const game = renderer.wb || root.__mpGame || root.__remixGame;
    const localSnake = game && game.oa;
    if (!game || !localSnake || !bodyIsRenderable(body)) return false;
    const peerAlive = remote.alive !== false;
    const built = buildPeerSnake(
      suffix ? seat.body2Cache : seat.bodyCache,
      localSnake,
      remote,
      body,
      suffix,
      state
    );
    if (suffix) seat.body2Cache = built.cache;
    else seat.bodyCache = built.cache;
    // Synthetic peer snakes never own a companion; body2 gets its own pass.
    built.snake.Ra = null;
    const companion = game.Ra || localSnake.Ra || null;
    const isYinYang = modeKeyHas(coopModeKey(), "yin_yang");
    // After the first successful audited pass, classic peers always use the
    // lean pin-swap path — full Closure host snapshots every frame (including
    // pose changes) were what made every-frame peer paint unusable.
    const lean = !!state.audited && !isYinYang;
    if (lean) {
      state.metrics.leanPassCount = (state.metrics.leanPassCount | 0) + 1;
    } else {
      state.metrics.fullPassCount = (state.metrics.fullPassCount | 0) + 1;
    }

    const localTint = localFaceTintHex(localSnake, renderer);
    const peerTint =
      normalizeFaceHex(built.snake && built.snake.Sc) || localTint;
    let faceSwapped = false;
    let faceCtxSnaps = null;

    if (lean) {
      const prevKa = renderer.ka;
      const prevOa = game.oa;
      const hadRa = Object.prototype.hasOwnProperty.call(game, "Ra");
      const prevRa = hadRa ? game.Ra : undefined;
      const hadNj = Object.prototype.hasOwnProperty.call(game, "nj");
      const prevNj = hadNj ? game.nj : undefined;
      const hadDead = Object.prototype.hasOwnProperty.call(game, "dead");
      const prevDead = hadDead ? game.dead : undefined;
      const hadIsDead = Object.prototype.hasOwnProperty.call(game, "isDead");
      const prevIsDead = hadIsDead ? game.isDead : undefined;
      const qa = game.Qa;
      const ga = game.Ga;
      const prevQaSet = qa && typeof qa.setActive === "function" ? qa.setActive : null;
      const prevGaSet = ga && typeof ga.setActive === "function" ? ga.setActive : null;
      let threw = null;
      let usedBlit = false;
      try {
        if (prevQaSet) qa.setActive = function () {};
        if (prevGaSet) ga.setActive = function () {};
        // Bake-once atlas cache (stock Play a7) then blit — correct eye rings
        // without per-frame ImageData recolor sweeps.
        if (peerTint && peerTint !== localTint) {
          usedBlit = blitFaceTintFromCache(renderer, peerTint, state.metrics);
          if (!usedBlit) {
            // Synthetic / unloaded sheets: one a7 swap (harness fallback).
            faceSwapped = ensureFaceAtlasTint(
              renderer,
              peerTint,
              localFaceFromHints(localSnake, renderer)
            );
            if (faceSwapped) {
              state.metrics.faceTintSwaps =
                (state.metrics.faceTintSwaps | 0) + 1;
            }
          }
        } else {
          // Same tint — still warm local cache for later peers.
          ensureFaceTintCache(renderer, localTint || peerTint, state.metrics);
        }
        const faceRoot = resolveFaceSheetRoot(renderer);
        if (targetCtx && faceRoot) {
          faceCtxSnaps = snapshotFaceSheetContexts(faceRoot);
          let needRetarget = false;
          for (let fi = 0; fi < faceCtxSnaps.length; fi++) {
            if (faceCtxSnaps[fi].context !== targetCtx) {
              needRetarget = true;
              break;
            }
          }
          if (needRetarget) {
            for (let fi = 0; fi < faceCtxSnaps.length; fi++) {
              try {
                faceCtxSnaps[fi].host.context = targetCtx;
              } catch (eCtx) { /* ignore */ }
            }
            state.metrics.faceCtxRetargets =
              (state.metrics.faceCtxRetargets | 0) + 1;
          } else {
            faceCtxSnaps = null;
          }
        }
        renderer.ka = targetCtx;
        game.oa = built.snake;
        if (hadRa) game.Ra = null;
        game.nj = !peerAlive;
        if (hadDead) game.dead = !peerAlive;
        if (hadIsDead) game.isDead = !peerAlive;
        let progress = args && args[0];
        if (!Number.isFinite(Number(progress))) progress = 1;
        else progress = Number(progress);
        const third = args && args[2];
        origRender.call(renderer, progress, true, third);
        state.metrics.renderCount++;
      } catch (e) {
        threw = e;
      } finally {
        if (faceCtxSnaps) {
          for (let ri = 0; ri < faceCtxSnaps.length; ri++) {
            try {
              faceCtxSnaps[ri].host.context = faceCtxSnaps[ri].context;
            } catch (eRest) { /* ignore */ }
          }
        }
        if (usedBlit) {
          blitFaceTintFromCache(renderer, localTint, state.metrics);
        } else if (
          !passOpts.deferFaceRestore &&
          (faceSwapped || normalizeFaceHex(root.__mpFaceTintSc) === peerTint)
        ) {
          if (ensureFaceAtlasTint(renderer, localTint, [peerTint, FACE_SPRITE_BASE])) {
            state.metrics.faceTintRestores =
              (state.metrics.faceTintRestores | 0) + 1;
          }
        } else if (passOpts.deferFaceRestore && faceSwapped) {
          state._deferredFaceLocalTint = localTint;
          state._deferredFacePeerTint = peerTint;
        }
        try {
          if (prevQaSet) qa.setActive = prevQaSet;
          if (prevGaSet) ga.setActive = prevGaSet;
        } catch (eSet) { /* ignore */ }
        try { renderer.ka = prevKa; } catch (eKa) { /* ignore */ }
        try { game.oa = prevOa; } catch (eOa) { /* ignore */ }
        try {
          if (hadRa) game.Ra = prevRa;
          if (hadNj) game.nj = prevNj;
          else if ("nj" in game) delete game.nj;
          if (hadDead) game.dead = prevDead;
          if (hadIsDead) game.isDead = prevIsDead;
        } catch (eGame) { /* ignore */ }
      }
      if (threw) {
        noteNativeException(state, threw);
        return false;
      }
      return true;
    }

    const snaps = [
      snapshotHost(renderer),
      snapshotHost(game),
      snapshotHost(args && args[2]),
    ];
    // First audited generation walks full graphs; later passes use slim
    // host-level snapshots to cut per-segment cost on long snakes.
    const slimSnap = !!state.audited;
    const localGraph = snapshotSnakeGraph(localSnake, slimSnap);
    const companionGraph = snapshotSnakeGraph(companion, slimSnap);
    const peerGraph = snapshotSnakeGraph(built.snake, slimSnap);
    const discoveredSnaps = discoveredRenderHosts(
      renderer,
      game,
      localSnake,
      companion
    ).map(snapshotHost);
    const modeSuppression = suppressStockCompanion(renderer, game, isYinYang);
    if (isYinYang && modeSuppression.changed === 0) {
      disableNative(state, "yy-mode-gate-unknown");
      return false;
    }
    const canvasSnap = canvasSnapshot(targetCtx);
    let threw = null;
    let auditBad = false;
    let restored = true;
    // Portal/keydoor setActive mutates nested game maps from peer geometry —
    // shallow game snapshot cannot restore those. No-op during peer paint.
    const qa = game.Qa;
    const ga = game.Ga;
    const prevQaSet = qa && typeof qa.setActive === "function" ? qa.setActive : null;
    const prevGaSet = ga && typeof ga.setActive === "function" ? ga.setActive : null;
    // Face atlases are shared — bake peer Sc only when the atlas isn't already
    // there. Restore can be deferred to the end of the peer frame so multi-color
    // dirty peers pay one a7 restore, not N.
    try {
      if (prevQaSet) qa.setActive = function () {};
      if (prevGaSet) ga.setActive = function () {};
      if (peerTint !== localTint) {
        faceSwapped = ensureFaceAtlasTint(
          renderer,
          peerTint,
          localFaceFromHints(localSnake, renderer)
        );
        if (faceSwapped) {
          state.metrics.faceTintSwaps = (state.metrics.faceTintSwaps | 0) + 1;
          // Snapshot peer bake now (atlas is at peerTint) for lean blits.
          const faceNow = resolveFaceSheetRoot(renderer);
          const peerSnaps = captureFaceHostImages(faceNow);
          const peerKey = normalizeFaceHex(peerTint);
          if (peerSnaps.length && peerKey && !_faceTintCache[peerKey]) {
            _faceTintCache[peerKey] = {
              snaps: peerSnaps,
              hex: peerKey,
              synthetic: false,
            };
            state.metrics.faceTintCacheBakes =
              (state.metrics.faceTintCacheBakes | 0) + 1;
          }
        }
      }
      // Retarget face sprite sheets onto the seat (or direct) target ctx so
      // J5E eyes/mouth draw with the body disc, not under the later composite.
      const faceRoot = resolveFaceSheetRoot(renderer);
      if (targetCtx && faceRoot) {
        faceCtxSnaps = snapshotFaceSheetContexts(faceRoot);
        let needRetarget = false;
        for (let fi = 0; fi < faceCtxSnaps.length; fi++) {
          if (faceCtxSnaps[fi].context !== targetCtx) {
            needRetarget = true;
            break;
          }
        }
        if (needRetarget) {
          for (let fi = 0; fi < faceCtxSnaps.length; fi++) {
            try {
              faceCtxSnaps[fi].host.context = targetCtx;
            } catch (eCtx) { /* ignore */ }
          }
          state.metrics.faceCtxRetargets =
            (state.metrics.faceCtxRetargets | 0) + 1;
        } else {
          faceCtxSnaps = null;
        }
      }
      renderer.ka = targetCtx;
      game.oa = built.snake;
      if ("Ra" in game) game.Ra = null;
      // Stock J5E keys die faces off game.nj — drive from server-auth'd
      // remote.alive, never inherit local death onto an alive peer.
      game.nj = !peerAlive;
      if ("dead" in game) game.dead = !peerAlive;
      if ("isDead" in game) game.isDead = !peerAlive;
      // Mid-tick lerp like the local snake — pass the wrap's progress so peers
      // slide between cells. Fall back to tick-complete when progress is junk.
      let progress = args && args[0];
      if (!Number.isFinite(Number(progress))) progress = 1;
      else progress = Number(progress);
      const third = args && args[2];
      origRender.call(renderer, progress, true, third);
      state.metrics.renderCount++;
      if (!state.audited) {
        // Stock P5E always writes lerp/face on the seated snake. Peer graph is
        // disposable; only flag local/companion/host leaks outside allowlist.
        auditBad =
          hostHasUnknownMutation(snaps[0], { ka: true }) ||
          hostHasUnknownMutation(snaps[1], {
            oa: true,
            Ra: true,
            nj: true,
            dead: true,
            isDead: true,
          }) ||
          hostHasUnknownMutation(snaps[2], null) ||
          graphMutated(localGraph, P5E_SNAKE_ALLOW) ||
          graphMutated(companionGraph, P5E_SNAKE_ALLOW) ||
          graphMutated(discoveredSnaps);
      }
    } catch (e) {
      threw = e;
    } finally {
      if (faceCtxSnaps) {
        for (let ri = 0; ri < faceCtxSnaps.length; ri++) {
          try {
            faceCtxSnaps[ri].host.context = faceCtxSnaps[ri].context;
          } catch (eRest) { /* ignore */ }
        }
      }
      if (
        !passOpts.deferFaceRestore &&
        (faceSwapped || normalizeFaceHex(root.__mpFaceTintSc) === peerTint)
      ) {
        if (ensureFaceAtlasTint(renderer, localTint, [peerTint, FACE_SPRITE_BASE])) {
          state.metrics.faceTintRestores =
            (state.metrics.faceTintRestores | 0) + 1;
        }
      } else if (passOpts.deferFaceRestore && faceSwapped) {
        state._deferredFaceLocalTint = localTint;
        state._deferredFacePeerTint = peerTint;
      }
      try {
        if (prevQaSet) qa.setActive = prevQaSet;
        if (prevGaSet) ga.setActive = prevGaSet;
      } catch (eSet) { /* ignore */ }
      restored = restoreGraph(modeSuppression.snapshots) && restored;
      restored = restoreGraph(discoveredSnaps) && restored;
      restored = restoreGraph(peerGraph) && restored;
      restored = restoreGraph(companionGraph) && restored;
      restored = restoreGraph(localGraph) && restored;
      for (let i = snaps.length - 1; i >= 0; i--) {
        restored = restoreHost(snaps[i]) && restored;
      }
      restored = restoreCanvas(canvasSnap) && restored;
    }
    if (!restored) {
      disableNative(state, "restoration-failure");
      return false;
    }
    if (auditBad) {
      if (!state._mutationAuditSoft) {
        state._mutationAuditSoft = true;
        console.warn(
          "[Multiplayer] native peer mutation soft-fail (retry once)"
        );
        return false;
      }
      disableNative(state, "mutation-audit");
      return false;
    }
    if (threw) {
      noteNativeException(state, threw);
      return false;
    }
    state.audited = true;
    return true;
  }

  function seatSignature(remote) {
    function bodySig(body) {
      return (body || []).map(function (p) {
        return p && [p.x, p.y, p.otherDim ? 1 : 0].join(":");
      }).join("|");
    }
    return [
      bodySig(remote.body),
      bodySig(remote.body2),
      remote.movementDir,
      remote.headDir,
      remote.transitionDir,
      remote.movementDir2,
      remote.headDir2,
      remote.transitionDir2,
      remote.colorId,
      remote.Sc,
      remote.Yc,
      remote.alive === false ? 0 : 1,
    ].join("/");
  }

  function ensureSeatLayer(state, id, mainCtx) {
    let seat = state.seats[id];
    const source = mainCtx.canvas;
    if (
      seat &&
      (seat.canvas.width !== source.width || seat.canvas.height !== source.height)
    ) {
      if (seat.canvas.parentNode) {
        try { seat.canvas.parentNode.removeChild(seat.canvas); } catch (e) { /* ignore */ }
      }
      state.metrics.layerReleases++;
      delete state.seats[id];
      seat = null;
    }
    if (!seat) {
      const layer = createLayer(mainCtx);
      if (!layer) return null;
      seat = {
        id: id,
        canvas: layer.canvas,
        ctx: layer.ctx,
        bodyCache: {},
        body2Cache: {},
        signature: null,
      };
      state.seats[id] = seat;
      state.metrics.layerAllocations++;
    }
    // Canvas state is copied only on dirty refresh (before renderPeerPass).
    return seat;
  }

  /** Status / diagnostics only — does not schedule or skip peer P5E. */
  function adaptCadence(state, elapsed) {
    const m = state.metrics;
    m.averageRefreshMs = m.averageRefreshMs
      ? m.averageRefreshMs * 0.8 + elapsed * 0.2
      : elapsed;
    m.cadence = m.averageRefreshMs > 8 ? 20 : m.averageRefreshMs > 4 ? 30 : 60;
  }

  function flushDeferredFaceTint(state, renderer) {
    const localTint = state._deferredFaceLocalTint;
    const peerTint = state._deferredFacePeerTint;
    state._deferredFaceLocalTint = null;
    state._deferredFacePeerTint = null;
    if (!localTint) return;
    if (blitFaceTintFromCache(renderer, localTint, state.metrics)) {
      state.metrics.faceTintRestores =
        (state.metrics.faceTintRestores | 0) + 1;
      return;
    }
    if (
      ensureFaceAtlasTint(renderer, localTint, [
        peerTint,
        FACE_SPRITE_BASE,
      ])
    ) {
      state.metrics.faceTintRestores =
        (state.metrics.faceTintRestores | 0) + 1;
    }
  }

  function paintDirectNativePeers(state, renderer, origRender, safe, peers, mainCtx) {
    if (state.directAccepted == null) {
      const probeStarted = nowMs();
      try {
        mainCtx.save();
        mainCtx.restore();
      } catch (eProbe) {
        state.directAccepted = false;
      }
      const probeMs = Math.max(0, nowMs() - probeStarted);
      const probeBudget = Number(root.__mpCoopNativeDirectBudgetMs) || 4;
      if (state.directAccepted !== false) state.directAccepted = probeMs <= probeBudget;
    }
    if (!state.directAccepted) {
      disableNative(state, "direct-main-budget");
      return false;
    }
    const started = nowMs();
    const deferOpts = { deferFaceRestore: true };
    for (let i = 0; i < peers.length; i++) {
      const id = peers[i];
      const remote = root.__mpCoopRemotes[id];
      let seat = state.seats[id];
      if (!seat) {
        seat = { id: id, bodyCache: {}, body2Cache: {}, signature: null };
        state.seats[id] = seat;
      }
      const sig = seatSignature(remote);
      const passOpts = { deferFaceRestore: true };
      if (!renderPeerPass(state, renderer, origRender, safe, remote, remote.body, seat, "", mainCtx, passOpts)) {
        flushDeferredFaceTint(state, renderer);
        return false;
      }
      if (
        bodyIsRenderable(remote.body2) &&
        !renderPeerPass(state, renderer, origRender, safe, remote, remote.body2, seat, "2", mainCtx, passOpts)
      ) {
        flushDeferredFaceTint(state, renderer);
        return false;
      }
      seat.signature = sig;
      state.metrics.refreshCount++;
    }
    flushDeferredFaceTint(state, renderer);
    const elapsed = Math.max(0, nowMs() - started);
    state.metrics.backend = "direct-main";
    adaptCadence(state, elapsed);
    publishNativeMetrics(state);
    return true;
  }

  function paintNativePeers(renderer, origRender, safe) {
    if (!isNativeRelayPlayer()) return false;
    const state = nativeState();
    if (state.disabled) return false;
    const mode = coopModeKey();
    const peers = nativePeerIds();
    for (let p = 0; p < peers.length; p++) {
      const peerMode = root.__mpCoopRemotes[peers[p]].modeKey;
      if (!modesCompatible(mode, peerMode)) {
        disableNative(state, "mode-mismatch");
        return false;
      }
    }
    const mainCtx = renderer && renderer.ka;
    if (!mainCtx || !mainCtx.canvas || typeof mainCtx.drawImage !== "function") {
      disableNative(state, "context-swap-unsupported");
      return false;
    }
    state.frame++;
    // Every peer, every frame — stride/cadence/budget skipped paints and left
    // stale seat bitmaps (jumpy peers). FPS comes from deferred face tint.
    const keep = Object.create(null);
    let framePeerPaintMs = 0;
    for (let i = 0; i < peers.length; i++) {
      const id = peers[i];
      const remote = root.__mpCoopRemotes[id];
      const seat = ensureSeatLayer(state, id, mainCtx);
      if (!seat || !seat.ctx) {
        return paintDirectNativePeers(
          state,
          renderer,
          origRender,
          safe,
          peers,
          mainCtx
        );
      }
      if (renderer.ka !== mainCtx) {
        disableNative(state, "context-swap-unsupported");
        return false;
      }
      keep[id] = true;
      const sig = seatSignature(remote);
      const started = nowMs();
      const deferOpts = { deferFaceRestore: true };
      try {
        seat.ctx.save();
        seat.ctx.setTransform(1, 0, 0, 1, 0, 0);
        seat.ctx.clearRect(0, 0, seat.canvas.width, seat.canvas.height);
        seat.ctx.restore();
      } catch (eClear) {
        disableNative(state, "context-swap-unsupported");
        return false;
      }
      copyCanvasState(mainCtx, seat.ctx);
      if (!renderPeerPass(state, renderer, origRender, safe, remote, remote.body, seat, "", seat.ctx, deferOpts)) {
        flushDeferredFaceTint(state, renderer);
        return false;
      }
      if (bodyIsRenderable(remote.body2)) {
        if (!renderPeerPass(state, renderer, origRender, safe, remote, remote.body2, seat, "2", seat.ctx, deferOpts)) {
          flushDeferredFaceTint(state, renderer);
          return false;
        }
      }
      seat.signature = sig;
      state.metrics.refreshCount++;
      framePeerPaintMs += Math.max(0, nowMs() - started);
    }
    // Metrics only (status FPS) — does not gate peer paint frequency.
    adaptCadence(state, framePeerPaintMs);
    flushDeferredFaceTint(state, renderer);
    Object.keys(state.seats).forEach(function (id) {
      if (keep[id]) return;
      const seat = state.seats[id];
      if (seat.canvas.parentNode) {
        try { seat.canvas.parentNode.removeChild(seat.canvas); } catch (e) { /* ignore */ }
      }
      state.metrics.layerReleases++;
      delete state.seats[id];
    });
    // Defer drawImage until after mosaic/auth overlays so peer heads stay on top.
    state._pendingPeerComposite = peers.slice();
    state.metrics.backend = "layers";
    publishNativeMetrics(state);
    return true;
  }

  /** Composite refreshed peer seat layers onto the main canvas (heads on top). */
  function compositePendingPeerLayers(renderer) {
    const state = nativeState();
    const peers = state._pendingPeerComposite;
    state._pendingPeerComposite = null;
    if (!peers || !peers.length) return;
    const mainCtx = renderer && renderer.ka;
    if (!mainCtx || typeof mainCtx.drawImage !== "function") return;
    for (let c = 0; c < peers.length; c++) {
      const seat = state.seats[peers[c]];
      if (!seat || !seat.canvas) continue;
      try {
        mainCtx.drawImage(seat.canvas, 0, 0);
        state.metrics.compositeCount++;
      } catch (eDraw) {
        /* ignore single-frame composite miss */
      }
    }
    publishNativeMetrics(state);
  }

  /**
   * Under server-auth with live STATE: never run PlayerRenderer — it either
   * parks off-board (yi NaN) or draws a jumpy native body + false death stars.
   * Auth board paints floor/apples/snakes with real on-board coords instead.
   */
  function shouldSkipNativeSnakeRender(renderer) {
    if (root.__mpCoopRenderParked) return true;
    const game =
      (renderer && renderer.wb) || root.__mpGame || root.__remixGame;
    if (
      root.__mpCoopServerAuth &&
      root.__mpCoopLastState &&
      !root.__mpCoopLastState.ended
    ) {
      try {
        if (typeof root.__mpCoopSeatBeforeRender === "function") {
          root.__mpCoopSeatBeforeRender(renderer);
        }
      } catch (eSeat) { /* ignore */ }
      return true;
    }
    if (!sanitizeLocalSnakesForRender(game)) return true;
    const body = game && game.oa && game.oa.ka;
    return !bodyIsRenderable(body);
  }

  function parkSpectatorBody(game) {
    if (!game || !game.oa) return;
    const snake = game.oa;
    if (!Array.isArray(snake.ka)) snake.ka = [];
    const Gsm = root.MultiplayerGsm;
    if (Gsm && typeof Gsm.writeNativeBody === "function") {
      try {
        Gsm.writeNativeBody(snake, [{ x: -8, y: -8 }]);
        root.__mpCoopRenderParked = true;
        return;
      } catch (e) { /* fall through */ }
    }
    const seg = { x: -8, y: -8 };
    seg.clone = function () {
      const c = { x: this.x, y: this.y };
      c.clone = this.clone;
      return c;
    };
    snake.ka.length = 1;
    snake.ka[0] = seg;
    root.__mpCoopRenderParked = true;
  }

  /**
   * Hook native `render(a,b,c)`. Remotes are painted right after the local
   * snake so companions stay visible on the shared board.
   */
  function installCoopRenderHook() {
    if (root.__mpCoopRenderInstalled) return;
    root.__mpCoopRenderInstalled = true;

    function wrapRenderer(renderer) {
      if (!renderer || renderer.__mpCoopPaintWrapped) return;
      if (typeof renderer.render !== "function") return;
      renderer.__mpCoopPaintWrapped = true;
      const origRender = renderer.render.__mpCoopOriginal || renderer.render;
      renderer.render = function (a, b, c) {
        // Frame timing for status FPS (EMA of 1000/dt).
        try {
          const now =
            typeof performance !== "undefined" && performance.now
              ? performance.now()
              : Date.now();
          const prev = root.__mpCoopFpsAt;
          if (prev != null && now > prev) {
            const inst = 1000 / (now - prev);
            if (Number.isFinite(inst) && inst > 0 && inst < 240) {
              const prevFps = Number(root.__mpCoopFps);
              root.__mpCoopFps = Number.isFinite(prevFps)
                ? prevFps * 0.85 + inst * 0.15
                : inst;
            }
          }
          root.__mpCoopFpsAt = now;
          // Refresh status FPS ~2Hz so the counter stays live without spam.
          const shown = root.__mpCoopFpsShownAt || 0;
          if (now - shown > 500) {
            root.__mpCoopFpsShownAt = now;
            const app = root.__multiplayerApp;
            if (app && typeof app.updateStatusIndicator === "function") {
              app.updateStatusIndicator();
            }
          }
        } catch (eFps) { /* ignore */ }
        const game =
          this.wb || root.__mpGame || root.__remixGame || null;
        // Server-auth: seat once until head matches — never every-frame reapply
        if (root.__mpCoopServerAuth && !root.__mpCoopSeatLocked) {
          try {
            if (this.wb) {
              root.__mpGame = this.wb;
              root.__remixGame = this.wb;
            }
            if (typeof root.__mpCoopSeatBeforeRender === "function") {
              root.__mpCoopSeatBeforeRender(this);
            }
          } catch (eIdle) { /* ignore */ }
        }
        // Clear park latch once a real finite body is back (new seat / Play)
        if (root.__mpCoopRenderParked && sanitizeLocalSnakesForRender(game)) {
          const body = game && game.oa && game.oa.ka;
          if (
            bodyIsRenderable(body) &&
            body[0] &&
            ((body[0].x | 0) !== -8 || (body[0].y | 0) !== -8)
          ) {
            root.__mpCoopRenderParked = false;
          }
        }
        const safe = sanitizeRenderArgs(a, b, c);
        root.__mpCoopRenderArgs = safe;
        if (shouldSkipNativeSnakeRender(this)) {
          try {
            if (typeof root.__mpCoopDrawAuthBoard === "function") {
              root.__mpCoopDrawAuthBoard(this);
            } else {
              drawCoopRemotes(this);
            }
          } catch (eSkip) { /* ignore */ }
          return undefined;
        }
        let out;
        try {
          out = origRender.call(this, safe[0], safe[1], safe[2]);
        } catch (e) {
          // Do not park at (-8,-8) and retry — that is the yi NaN root cause.
          // Sanitize finite body once; if still broken, skip this frame.
          if (isYiNanError(e) || /NaN/.test(String((e && e.message) || e))) {
            try {
              sanitizeLocalSnakesForRender(game);
              out = origRender.call(this, 0, true, safe[2]);
            } catch (e2) {
              const now = Date.now();
              if (now - _drawWarnAt > 5000) {
                _drawWarnAt = now;
                console.warn("__mp render yi NaN — skipped frame", e2);
              }
              out = undefined;
            }
          } else {
            try {
              out = origRender.call(this, 0, true, safe[2]);
            } catch (e2) {
              const now = Date.now();
              if (now - _drawWarnAt > 2000) {
                _drawWarnAt = now;
                console.warn("__mp render", e2);
              }
              out = undefined;
            }
          }
        }
        // Mosaic first only for peers native will not paint; native owns both
        // live and server-dead peer heads (die face via nj from remote.alive).
        const nativeIds = nativePeerIds();
        const nativeLikely =
          isNativeRelayPlayer() &&
          !nativeState().disabled &&
          nativeIds.length > 0;
        const nativeIdSet = Object.create(null);
        for (let ni = 0; ni < nativeIds.length; ni++) {
          nativeIdSet[nativeIds[ni]] = true;
        }
        try {
          drawCoopRemotes(
            this,
            nativeLikely
              ? function (remote, id) {
                  // Skip ids native will paint (alive or corpse).
                  if (id != null && nativeIdSet[id]) return false;
                  if (remote && remote.clientId && nativeIdSet[remote.clientId]) {
                    return false;
                  }
                  return true;
                }
              : null
          );
        } catch (e3) { /* ignore */ }
        let usedNative = false;
        try {
          usedNative = paintNativePeers(this, origRender, safe);
        } catch (eNative) {
          const state = nativeState();
          noteNativeException(state, eNative);
          usedNative = false;
        }
        if (!usedNative && nativeLikely) {
          try {
            drawCoopRemotes(this);
          } catch (eRetry) { /* ignore */ }
        }
        try {
          compositePendingPeerLayers(this);
        } catch (eComp) { /* ignore */ }
        return out;
      };
      renderer.render.__mpCoopOriginal = origRender;
    }

    /**
     * Seat oa.ka before the first paint. Server-auth uses COOP_STATE; native-relay
     * reseats from __mpLastCoopSpawnPose / visual seat so PlayerRenderer never
     * paints Classic center for that frame. Prefer renderer.wb over stale __mpGame.
     */
    root.__mpCoopSeatBeforeRender = function (renderer) {
      if (root.__mpCoopSeatLocked) return true;
      const game =
        (renderer && renderer.wb) || root.__mpGame || root.__remixGame || null;
      if (game) {
        root.__mpGame = game;
        root.__remixGame = game;
      }

      // Plan 1 server-auth STATE path (unchanged)
      if (root.__mpCoopServerAuth) {
        const state = root.__mpCoopLastState;
        if (!state || state.ended) return false;
        try {
          if (!root.CoopBinder || typeof root.CoopBinder.applyCoopState !== "function") {
            return false;
          }
          const myId = root.__mpCoopLastStateMyId || root.__mpCoopMyId;
          // Body-only seat — never force-rewrite fruit (kills native eat anim)
          const r = root.CoopBinder.applyCoopState(state, myId, {
            force: true,
            skipFruit: true,
            bodyOnly: true,
          });
          if (
            root.CoopBinder.localHeadMatchesState &&
            root.CoopBinder.localHeadMatchesState(state, myId)
          ) {
            root.__mpCoopSeatLocked = true;
          } else {
            root.__mpCoopSeatLocked = false;
          }
          return !!(r && r.ok);
        } catch (eSeat) {
          root.__mpCoopSeatLocked = false;
          return false;
        }
      }

      // Native-relay: visual reseat from last spawn pose while idle (no dir yet)
      if (!root.__mpCoopInject && !root.__mpCoopSession) return false;
      const pose = root.__mpLastCoopSpawnPose;
      if (!pose || pose.x == null || pose.y == null) return false;
      if (!game || !game.oa) return false;
      try {
        const dir = game.oa.direction || game.oa.dir;
        if (dir) return true;
        const body = game.oa.ka;
        const head = body && body[0];
        if (
          head &&
          Number(head.x) === Number(pose.x) &&
          Number(head.y) === Number(pose.y)
        ) {
          return true;
        }
        const Gsm = root.MultiplayerGsm;
        if (Gsm && typeof Gsm.applyCoopSpawnOffset === "function") {
          return !!Gsm.applyCoopSpawnOffset(pose.oy, {
            slot: pose.slot,
            x: pose.x,
            y: pose.y,
            dir: pose.dir,
            boardWidth: pose.boardWidth,
            boardHeight: pose.boardHeight,
          });
        }
        if (Gsm && typeof Gsm.coopSpawnBodyFromPose === "function" &&
            typeof Gsm.writeNativeBody === "function") {
          const seeded = Gsm.coopSpawnBodyFromPose(pose);
          if (seeded && seeded.length) {
            Gsm.writeNativeBody(game.oa, seeded);
            return true;
          }
        }
        return false;
      } catch (eNativeSeat) {
        return false;
      }
    };

    /**
     * When native body still disagrees with STATE, paint local from STATE too
     * (same mosaic path as peers) so both clients share the authoritative board.
     * Mid-match corpse fades at 0.55 — never native death stars.
     */
    function drawAuthLocalSnake(renderer) {
      if (!root.__mpCoopServerAuth) return 0;
      const state = root.__mpCoopLastState;
      if (!state || state.ended) return 0;
      const myId = root.__mpCoopLastStateMyId || root.__mpCoopMyId;
      if (!myId) return 0;
      const holder = root.__mpCoopLocalMotion;
      const snakes = state.snakes || [];
      let mine = null;
      for (let i = 0; i < snakes.length; i++) {
        if (snakes[i] && snakes[i].clientId === myId) {
          mine = snakes[i];
          break;
        }
      }
      if (!mine || !mine.body || !mine.body.length) return 0;
      const ctx = renderer && renderer.ka;
      if (!ctx || typeof ctx.save !== "function") return 0;
      const game = (renderer && renderer.wb) || root.__mpGame || root.__remixGame;
      const layout =
        root.__mpCoopAuthLayout || authBoardLayout(renderer, game);
      if (!layout) return 0;
      const tile = layout.cell;
      const ox = layout.ox;
      const oy = layout.oy;
      const Gsm = root.MultiplayerGsm;
      if (!Gsm || typeof Gsm.drawWallSolverStyleSnake !== "function") return 0;
      let body =
        holder && bodyIsRenderable(holder._visualBody)
          ? holder._visualBody
          : null;
      if (!bodyIsRenderable(body)) body = snapshotBody(mine.body);
      if (!bodyIsRenderable(body)) return 0;
      const colorsById = displayColorIds();
      const colorInfo = remoteColorInfo(
        {
          clientId: myId,
          colorId: mine.colorId != null ? mine.colorId : holder && holder.colorId,
          alive: mine.alive !== false,
        },
        colorsById[myId]
      );
      const intervalMs =
        (state.intervalMs != null
          ? Number(state.intervalMs)
          : root.__mpCoopIntervalMs) || 0;
      if (holder && intervalMs > 0) holder._lerpStepMs = intervalMs;
      const opts = {
        cheese: coopIsCheeseMode(),
        lights: lightMaskFor(game),
        wrapWidth: 0,
        wrapHeight: 0,
        motion:
          holder && typeof Gsm.snakeMotion === "function"
            ? Gsm.snakeMotion(holder, "coop-local", body)
            : null,
      };
      const dead =
        mine.alive === false ||
        root.__mpCoopLocalCorpse ||
        (holder && holder.alive === false);
      ctx.save();
      try {
        ctx.globalAlpha = dead ? 0.55 : 1;
        Gsm.drawWallSolverStyleSnake(
          ctx,
          body,
          ox,
          oy,
          tile,
          colorInfo,
          (holder && holder.dir) || mine.dir || "RIGHT",
          opts
        );
        return 1;
      } catch (eDraw) {
        return 0;
      } finally {
        ctx.restore();
      }
    }

    /**
     * Native owns Classic floor + fruit. We only skip PlayerRenderer (death
     * stars / yi NaN) and overlay SVG snakes on the same native tile grid.
     * Never fillRect / redraw apples — that double-paints against fruit render.
     */
    function drawAuthBoardChrome(renderer) {
      // Intentionally empty — keep hook for callers / tests.
      void renderer;
      void authBoardLayout;
    }

    root.__mpCoopDrawAuthBoard = function (renderer) {
      // Cache native-aligned layout for snake overlays
      try {
        const game =
          (renderer && renderer.wb) || root.__mpGame || root.__remixGame;
        authBoardLayout(renderer, game);
      } catch (eLay) { /* ignore */ }
      try {
        drawAuthLocalSnake(renderer);
      } catch (eL) { /* ignore */ }
      try {
        drawCoopRemotes(renderer);
      } catch (eR) { /* ignore */ }
    };

    root.__mpCoopRenderEnter = function (renderer) {
      try {
        if (typeof root.__mpCoopSeatBeforeRender === "function") {
          root.__mpCoopSeatBeforeRender(renderer);
        }
      } catch (ePre) { /* ignore */ }
      if (!renderer || typeof renderer.render !== "function") return;
      root.__mpCoopPlayerRenderer = renderer;
      // Seed face-tint tracking once so Ready bumps know whether Play left the
      // atlas at stock #5282F2 (default blue / rainbow) or already a7'd to Sc.
      if (!root.__mpFaceTintSc) {
        try {
          const game = renderer.wb || root.__mpGame || root.__remixGame;
          const snake = game && game.oa;
          const fromSc = normalizeFaceHex(snake && snake.Sc);
          // Prefer live Sc even when wa is still 0/10 — claimable Blue (#4E7CF6)
          // is not the stock atlas base (#5282F2).
          if (fromSc) {
            root.__mpFaceTintSc = fromSc;
          } else {
            const settings = renderer.settings || (game && game.settings);
            const wa = settings && settings.wa;
            if (wa === 0 || wa === 10) {
              root.__mpFaceTintSc = FACE_SPRITE_BASE;
            }
          }
        } catch (eTint) { /* ignore */ }
      }
      wrapRenderer(renderer);
    };
    root.__mpCoopSkipNativeRender = shouldSkipNativeSnakeRender;
    root.__mpCoopSanitizeLocalSnakes = sanitizeLocalSnakesForRender;
    // Alias used by older tests / callers
    root.__mpCoopPaintCompanions = function (gameOrRenderer) {
      const renderer =
        gameOrRenderer && gameOrRenderer.ka && gameOrRenderer.wb
          ? gameOrRenderer
          : root.__mpCoopPlayerRenderer;
      if (!renderer) return 0;
      return drawCoopRemotes(renderer);
    };
    root.__mpCoopAfterSnakeRender = root.__mpCoopPaintCompanions;
    root.__mpCoopNativeRendererReset = releaseNativeBackend;
    root.__mpCoopNativeRendererMetrics = nativeMetrics;
  }

  /* --------------------------------------------------------- spawn occupancy */

  /**
   * Occupancy for spawn: remotes + optional local body. Used by freePos wrappers
   * so fruit never lands on any snake.
   */
  function readSpawnOccupancy(game, includeLocal) {
    const occ = Object.assign({}, readCoopOccupancy());
    if (includeLocal !== false) {
      try {
        const g = game || root.__mpGame || root.__remixGame;
        const body = g && g.oa && g.oa.ka;
        (body || []).forEach(function (p) {
          if (p && p.x != null && p.y != null) {
            occ[(p.x | 0) + "," + (p.y | 0)] = true;
          }
        });
      } catch (e) { /* ignore */ }
    }
    return occ;
  }

  /**
   * Wrap game freePos helpers so fruit never lands on co-op snakes / walls,
   * and Wall-mode picks (arg === 5) obey shared-board wall spawn rules.
   * Fruit path: build valid pool → single roll (no reject-retry loops).
   */
  function wrapFreePos(game) {
    if (!game || game.__mpCoopFreePosWrapped) return;
    game.__mpCoopFreePosWrapped = true;
    ["Tb", "Rb", "Sb", "Vb"].forEach(function (name) {
      const orig = game[name];
      if (typeof orig !== "function") return;
      game[name] = function () {
        // freePos checks Ca.Aa.has(serial) — repair hosts before native runs
        function repairHosts(g) {
          try {
            if (
              root.MultiplayerGsm &&
              typeof root.MultiplayerGsm.ensureCoopTickHosts === "function"
            ) {
              root.MultiplayerGsm.ensureCoopTickHosts(g);
              return;
            }
            if (
              g &&
              g.Ca &&
              root.MultiplayerGsm &&
              typeof root.MultiplayerGsm.ensureNativeWallMap === "function"
            ) {
              root.MultiplayerGsm.ensureNativeWallMap(g.Ca);
            }
            if (
              root.MultiplayerGsm &&
              typeof root.MultiplayerGsm.ensureFruitShieldSets === "function"
            ) {
              root.MultiplayerGsm.ensureFruitShieldSets(g);
            }
          } catch (ePre) { /* ignore */ }
        }
        function sanitizePos(g, p) {
          if (!p || p.x == null || p.y == null) return null;
          const x = Math.round(Number(p.x));
          const y = Math.round(Number(p.y));
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          const size = boardSizeFromGame(g);
          if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
            return null;
          }
          // Guarantee the row exists before native writes wa[y][x]
          try {
            if (
              g &&
              g.Ca &&
              root.MultiplayerGsm &&
              typeof root.MultiplayerGsm.ensureWallGridDense === "function"
            ) {
              root.MultiplayerGsm.ensureWallGridDense(
                g.Ca,
                size.width,
                size.height
              );
            } else if (g && g.Ca && Array.isArray(g.Ca.wa) && !g.Ca.wa[y]) {
              const row = [];
              for (let i = 0; i < size.width; i++) row.push(0);
              g.Ca.wa[y] = row;
            }
          } catch (eRow) { /* ignore */ }
          // Native assigns freePos onto apple.pos and L3E.render calls .clone().
          // Pool rolls are plain {x,y} — upgrade to Od / makeNativePoint.
          if (typeof p.clone === "function") {
            p.x = x;
            p.y = y;
            return p;
          }
          try {
            if (root._ && typeof root._.Od === "function") {
              return new root._.Od(x, y);
            }
          } catch (eOd) { /* ignore */ }
          if (
            root.MultiplayerGsm &&
            typeof root.MultiplayerGsm.makeNativePoint === "function"
          ) {
            return root.MultiplayerGsm.makeNativePoint(x, y, null);
          }
          const seg = { x: x, y: y };
          seg.clone = function () {
            const c = { x: this.x, y: this.y };
            c.clone = this.clone;
            return c;
          };
          return seg;
        }
        function signalBoardFull() {
          root.__mpCoopBoardFull = true;
          if (typeof root.__mpCoopOnBoardFull === "function") {
            try {
              root.__mpCoopOnBoardFull();
            } catch (eFull) { /* ignore */ }
          }
        }
        /** True only when every cell is snake/wall — not tally head-radius empty. */
        function boardTrulyPacked(g) {
          try {
            const occ = readSpawnOccupancy(g, true);
            return !findFreeSpawnCell(g, occ);
          } catch (ePack) {
            return false;
          }
        }
        repairHosts(this);
        const wallPick = arguments.length >= 2 && Number(arguments[1]) === 5;
        const g = game || this;

        // Fruit spawn: valid pool + single roll (no 64× reject loop)
        if (!wallPick) {
          const pool = buildFruitSpawnPool(g);
          if (!pool.length) {
            // Empty tally/filtered pool must not ALL_APPLES — only a packed board.
            if (boardTrulyPacked(g)) {
              signalBoardFull();
            } else {
              root.__mpCoopBoardFull = false;
            }
            return null;
          }
          const picked = sanitizePos(g, pickFruitSpawnFromPool(pool));
          if (!picked) {
            if (boardTrulyPacked(g)) {
              signalBoardFull();
            } else {
              root.__mpCoopBoardFull = false;
            }
            return null;
          }
          root.__mpCoopBoardFull = false;
          return picked;
        }

        // Wall-mode freePos(null, 5): keep native attempt + reject rules
        let attempts = 0;
        let pos;
        function isHostCorruptError(err) {
          const msg = String((err && err.message) || err || "");
          return /has is not a function|\.has|reading ['"]size['"]|Cannot read properties of (null|undefined)/.test(
            msg
          );
        }
        function callOrig() {
          repairHosts(this);
          return sanitizePos(this, orig.apply(this, arguments));
        }
        try {
          pos = callOrig.apply(this, arguments);
        } catch (eOrig) {
          if (isHostCorruptError(eOrig)) {
            repairHosts(this);
            try {
              pos = callOrig.apply(this, arguments);
            } catch (eRetry1) {
              if (!isHostCorruptError(eRetry1)) throw eRetry1;
              pos = null;
            }
          } else {
            throw eOrig;
          }
        }
        while (pos && attempts < 64) {
          if (!wallSpawnRejected(g, pos.x, pos.y)) break;
          attempts++;
          try {
            pos = callOrig.apply(this, arguments);
          } catch (eRetry) {
            repairHosts(this);
            if (!isHostCorruptError(eRetry)) break;
            pos = null;
            break;
          }
        }
        if (pos && wallSpawnRejected(g, pos.x, pos.y)) {
          return null;
        }
        return pos;
      };
    });
  }

  /** Taxicab distance. */
  function manhattan(ax, ay, bx, by) {
    return Math.abs((ax | 0) - (bx | 0)) + Math.abs((ay | 0) - (by | 0));
  }

  /**
   * Regular Wall-mode freePos(null,5) rules on a shared multi-snake board.
   * Rejects 1×1 corner dead-end cells, snake/fruit/wall occupancy, and
   * taxicab ≤3 of any head.
   */
  function wallSpawnRejected(game, x, y) {
    const xi = x | 0;
    const yi = y | 0;
    const size = boardSizeFromGame(game);
    const Gsm = root.MultiplayerGsm;
    if (
      Gsm &&
      typeof Gsm.isIllegalNormalWallCell === "function" &&
      Gsm.isIllegalNormalWallCell(xi, yi, size.width, size.height)
    ) {
      return true;
    }
    if (isSolidWallCell(game, xi, yi)) return true;
    const occ = readSpawnOccupancy(game, true);
    if (occ[xi + "," + yi]) return true;
    // Fruit cells
    try {
      const apples = game && game.wa && game.wa.ka;
      for (let i = 0; apples && i < apples.length; i++) {
        const a = apples[i];
        const pos = (a && a.pos) || a;
        if (pos && (pos.x | 0) === xi && (pos.y | 0) === yi) return true;
      }
    } catch (eA) { /* ignore */ }
    // Head radius 3 vs every live head (local + remotes + Yin Yang companions)
    const heads = [];
    try {
      const local = game && game.oa && game.oa.ka && game.oa.ka[0];
      if (local) heads.push(local);
      if (game && game.Ra && game.Ra.ka && game.Ra.ka[0]) {
        heads.push(game.Ra.ka[0]);
      }
    } catch (eL) { /* ignore */ }
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    Object.keys(remotes).forEach(function (id) {
      if (myId && id === myId) return;
      const r = remotes[id];
      if (!r || r.alive === false) return;
      if (r.body && r.body[0]) heads.push(r.body[0]);
      if (r.body2 && r.body2[0]) heads.push(r.body2[0]);
    });
    for (let h = 0; h < heads.length; h++) {
      if (manhattan(xi, yi, heads[h].x, heads[h].y) <= 3) return true;
    }
    // Adjacent to an existing solid wall (community / native freePos rule)
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let d = 0; d < dirs.length; d++) {
      const nx = xi + dirs[d][0];
      const ny = yi + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= size.width || ny >= size.height) continue;
      if (isSolidWallCell(game, nx, ny)) return true;
    }
    return false;
  }

  /**
   * Remix Chess/Slot spawn helpers only mark the local snake — merge co-op
   * occupancy (live + corpse) and solid wall cells so walls/keys/fruit plants
   * avoid peers and Wall-mode geometry the same way native does.
   */
  function installRemixSpawnOccupancyHooks() {
    if (
      typeof root.chess_occupied_keys === "function" &&
      !root.chess_occupied_keys.__mpCoop
    ) {
      const origKeys = root.chess_occupied_keys;
      root.chess_occupied_keys = function (game, apples, skipIndexes) {
        let keys = origKeys.call(this, game, apples, skipIndexes);
        // Native / Remix spawn paths call keys.has — never return {} / Map / array
        if (!keys || typeof keys.has !== "function" || typeof keys.add !== "function") {
          const next = new Set();
          try {
            if (keys && typeof keys.forEach === "function") {
              keys.forEach(function (v, k) {
                // Set forEach(v), Map forEach(v,k) — prefer key when present
                next.add(k != null && typeof k !== "function" ? k : v);
              });
            } else if (Array.isArray(keys)) {
              keys.forEach(function (k) {
                next.add(k);
              });
            } else if (keys && typeof keys === "object") {
              Object.keys(keys).forEach(function (k) {
                if (keys[k]) next.add(k);
              });
            }
          } catch (eKeys) { /* ignore */ }
          keys = next;
        }
        if (!root.__mpCoopSession || !root.__mpCoopInject) return keys;
        function addKey(k) {
          if (k == null) return;
          keys.add(k);
        }
        const occ = readSpawnOccupancy(game, true);
        Object.keys(occ).forEach(addKey);
        const walls = wallOccupancyKeys(game);
        Object.keys(walls).forEach(addKey);
        return keys;
      };
      root.chess_occupied_keys.__mpCoop = true;
    }

    if (typeof root.slot_free_pos === "function" && !root.slot_free_pos.__mpCoop) {
      const origSlot = root.slot_free_pos;
      root.slot_free_pos = function (mgr) {
        if (!root.__mpCoopSession || !root.__mpCoopInject) {
          return origSlot.apply(this, arguments);
        }
        const game = (mgr && mgr.wb) || root.__mpGame || root.__remixGame;
        let attempts = 0;
        let p = origSlot.apply(this, arguments);
        while (p && attempts < 64) {
          const occ = readSpawnOccupancy(game, true);
          if (!spawnCellBlocked(game, p.x, p.y, occ)) break;
          attempts++;
          p = origSlot.apply(this, arguments);
        }
        if (p) {
          const occ = readSpawnOccupancy(game, true);
          if (spawnCellBlocked(game, p.x, p.y, occ)) {
            const scanned = findFreeSpawnCell(game, occ);
            if (scanned) {
              if (typeof root.slot_make_pos === "function") {
                return root.slot_make_pos(scanned.x, scanned.y);
              }
              return scanned;
            }
            // No free cell after rejects — drop only; ALL_APPLES needs a packed board.
            if (!root.__mpCoopServerAuth && !findFreeSpawnCell(game, occ)) {
              root.__mpCoopBoardFull = true;
              if (typeof root.__mpCoopOnBoardFull === "function") {
                try {
                  root.__mpCoopOnBoardFull();
                } catch (eFull) { /* ignore */ }
              }
            } else {
              root.__mpCoopBoardFull = false;
            }
            return null;
          }
        }
        return p;
      };
      root.slot_free_pos.__mpCoop = true;
    }
  }

  /* -------------------------------------------------------------- tick hook */

  /**
   * Native only ticks a snake that is moving: a player still sitting on their
   * spawn, or a spectator (who never gets a direction), never reaches onTick.
   * Anything the tick drives needs an idle path — the app polls this to decide
   * whether peer poses can wait for the next tick or must be applied now.
   * Generous enough to cover the slowest speed setting between ticks.
   */
  const COOP_TICK_STALE_MS = 500;

  function coopTicksRunning(maxAgeMs) {
    const at = Number(root.__mpCoopLastTickAt) || 0;
    if (!at) return false;
    const max = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : COOP_TICK_STALE_MS;
    const age = Date.now() - at;
    return age >= 0 && age <= max;
  }

  /**
   * Tick: apply peer poses, then body-collide vs remotes (not peaceful / YY).
   * Fruit is applied only on COLLECTABLES_DELTA (not every tick).
   */
  function installCoopTickHook() {
    if (root.__mpCoopOnTickInstalled) return;
    root.__mpCoopOnTickInstalled = true;
    root.__mpCoopOnTick = function (game) {
      root.__mpCoopLastTickAt = Date.now();
      if (!root.__mpCoopInject || !root.__mpCoopSession) return;
      try {
        // p6E wall grow / freePos / y4E run later in this same native tick —
        // wall Map, dense Ca.wa rows, fruit Sets, and snake.wa flags must exist.
        try {
          if (
            root.MultiplayerGsm &&
            typeof root.MultiplayerGsm.ensureCoopTickHosts === "function"
          ) {
            root.MultiplayerGsm.ensureCoopTickHosts(game);
          } else {
            if (game && game.Ca) {
              if (
                root.MultiplayerGsm &&
                typeof root.MultiplayerGsm.ensureNativeWallMap === "function"
              ) {
                root.MultiplayerGsm.ensureNativeWallMap(game.Ca);
              }
            }
            if (
              root.MultiplayerGsm &&
              typeof root.MultiplayerGsm.ensureFruitShieldSets === "function"
            ) {
              root.MultiplayerGsm.ensureFruitShieldSets(game);
            }
          }
        } catch (eAa) { /* ignore */ }
        if (typeof root.__mpCoopFlushPendingDeltas === "function") {
          try {
            root.__mpCoopFlushPendingDeltas();
          } catch (e) {
            console.warn("__mpCoopFlushPendingDeltas", e);
          }
        }
        wrapFreePos(game);
        installRemixSpawnOccupancyHooks();
        wrapGameReset(game);
        invalidateLightMask();

        // Spectator: park off-board (never clear ka — empty body → yi NaN×4)
        if (root.__mpCoopSpectator && game && game.oa) {
          parkSpectatorBody(game);
          root.__mpCoopLocalDead = true;
        }

        // Native-relay: local head / next step vs peer bodies (incl. corpses).
        // No-ops under peaceful / yin_yang / server-auth / already dead.
        killLocalOnRemote(game);

        if (typeof root.__mpCoopAfterTick === "function") {
          try {
            root.__mpCoopAfterTick(game);
          } catch (e) {
            console.warn("__mpCoopAfterTick", e);
          }
        }
      } catch (e) {
        console.warn("__mpCoopOnTick", e);
      }
    };
  }

  installCoopRenderHook();
  installCoopTickHook();

  root.CoopNative = CoopNative;
  root.__mpCoopReadOccupancy = readCoopOccupancy;
  root.__mpCoopReadSpawnOccupancy = readSpawnOccupancy;
  root.__mpCoopFindFreeSpawn = findFreeSpawnCell;
  root.__mpCoopBuildFruitSpawnPool = buildFruitSpawnPool;
  root.__mpCoopPickFruitSpawn = pickFruitSpawnFromPool;
  root.__mpCoopInstallSpawnOcc = installRemixSpawnOccupancyHooks;
  root.__mpCoopDrawRemotes = drawCoopRemotes;
  root.__mpCoopResetNativePeerPaint = resetNativePeerPaint;
  root.__mpCoopIsSolidWall = isSolidWallCell;
  root.__mpCoopWallOccupancy = wallOccupancyKeys;
  root.__mpCoopTicksRunning = coopTicksRunning;
  root.__mpCoopDisplayColorIds = coopDisplayColorIds;
  root.__mpCoopRecolorPalette = coopRecolorPalette;
  root.__mpCoopBuildPeerSnake = buildPeerSnake;
  root.__mpCoopWallSpawnRejected = wallSpawnRejected;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CoopNative: CoopNative,
      coopDisplayColorIds: coopDisplayColorIds,
      coopRecolorPalette: coopRecolorPalette,
      isSolidWallCell: isSolidWallCell,
      findFreeSpawnCell: findFreeSpawnCell,
      buildFruitSpawnPool: buildFruitSpawnPool,
      pickFruitSpawnFromPool: pickFruitSpawnFromPool,
      readSpawnOccupancy: readSpawnOccupancy,
      wallOccupancyKeys: wallOccupancyKeys,
      coopTicksRunning: coopTicksRunning,
      nativeRendererMetrics: nativeMetrics,
      resetNativeRenderer: releaseNativeBackend,
      resetNativePeerPaint: resetNativePeerPaint,
      buildPeerSnake: buildPeerSnake,
      remoteColorInfo: remoteColorInfo,
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
