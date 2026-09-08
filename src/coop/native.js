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
    }
    if (payload._lerpStepMs != null) next._lerpStepMs = payload._lerpStepMs;
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
      // Co-op mid-match Reset/Escape → soft-rebind STATE only (never native reset).
      if (root.__mpCoopSession && !root.__mpCoopSpectator) {
        if (typeof root.__mpCoopOnLocalReset === "function") {
          try {
            root.__mpCoopOnLocalReset();
          } catch (e) { /* ignore */ }
        }
        return;
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

  /**
   * Linear scan for a cell not on any co-op snake, local body, or solid wall.
   * Wall mode must plant fruit / entities with the same rules as native.
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
      if (claimed != null && !used[claimed]) {
        used[claimed] = true;
        out[id] = claimed;
        continue;
      }
      // Collision (or no claim at all): take the next unused recolor entry
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

  /** Resolve primary/shade hex (+ rainbow set) for one remote. */
  function remoteColorInfo(remote, displayId) {
    const Colors = root.MultiplayerColors;
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
    };
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

  function liveNativePeers() {
    const remotes = root.__mpCoopRemotes || {};
    const myId = root.__mpCoopMyId;
    return Object.keys(remotes)
      .filter(function (id) {
        const r = remotes[id];
        return (
          (!myId || id !== myId) &&
          r &&
          (!r.clientId || r.clientId === id) &&
          r.alive !== false &&
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
      state.metrics.bufferGrowth++;
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

  function buildPeerSnake(cache, localSnake, remote, body, suffix, state) {
    cache = cache || {};
    writeCachedBody(cache, body, localSnake && localSnake.ka && localSnake.ka[0], state);
    if (!cache.snake || Object.getPrototypeOf(cache.snake) !== Object.getPrototypeOf(localSnake)) {
      cache.snake = Object.create(localSnake ? Object.getPrototypeOf(localSnake) : Object.prototype);
    }
    const snake = cache.snake;
    if (localSnake) {
      Object.keys(localSnake).forEach(function (k) {
        if (k !== "ka" && k !== "wa" && k !== "Ra") snake[k] = localSnake[k];
      });
    }
    snake.ka = cache.points;
    snake.wa = cache.flags;
    const s = suffix || "";
    const dir = remote["movementDir" + s] != null
      ? remote["movementDir" + s]
      : remote["headDir" + s] != null
        ? remote["headDir" + s]
        : remote.dir;
    copyIfPresent(snake, {
      direction: dir,
      dir: dir,
      Ca: remote["headDir" + s],
      Ga: remote["transitionDir" + s],
      turns: remote["turns" + s] || remote.turns,
      Sc: remote[s ? "Sc2" : "Sc"],
      Yc: remote[s ? "Yc2" : "Yc"],
    }, ["direction", "dir", "Ca", "Ga", "turns", "Sc", "Yc"]);
    if ("pendingTurns" in snake) snake.pendingTurns = remote["turns" + s] || remote.turns || [];
    if (remote["headLight" + s] != null) snake.headLight = remote["headLight" + s];
    copyIfPresent(snake, remote, ["poisoned", "otherDim", "status"]);
    snake.alive = true;
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
    if (nowKeys.length !== snap.keys.length) return true;
    for (let i = 0; i < snap.keys.length; i++) {
      const k = snap.keys[i];
      if (allowed && allowed[k]) continue;
      if (snap.host[k] !== snap.values[k]) return true;
    }
    return false;
  }

  function snapshotSnakeGraph(snake) {
    if (!snake) return [];
    const out = [snapshotHost(snake), snapshotHost(snake.ka), snapshotHost(snake.wa)];
    const body = snake.ka || [];
    for (let i = 0; i < body.length; i++) out.push(snapshotHost(body[i]));
    const turns = snake.turns || snake.pendingTurns || snake.Aa;
    out.push(snapshotHost(turns));
    for (let j = 0; turns && j < turns.length; j++) out.push(snapshotHost(turns[j]));
    return out;
  }

  function graphMutated(snaps) {
    for (let i = 0; i < snaps.length; i++) {
      if (hostHasUnknownMutation(snaps[i], null)) return true;
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

  function renderPeerPass(state, renderer, origRender, args, remote, body, seat, suffix, targetCtx) {
    const game = renderer.wb || root.__mpGame || root.__remixGame;
    const localSnake = game && game.oa;
    if (!game || !localSnake || remote.alive === false) return false;
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
    const snaps = [
      snapshotHost(renderer),
      snapshotHost(game),
      snapshotHost(args && args[2]),
    ];
    const localGraph = snapshotSnakeGraph(localSnake);
    const companionGraph = snapshotSnakeGraph(companion);
    const peerGraph = snapshotSnakeGraph(built.snake);
    const discoveredSnaps = discoveredRenderHosts(
      renderer,
      game,
      localSnake,
      companion
    ).map(snapshotHost);
    const isYinYang = modeKeyHas(coopModeKey(), "yin_yang");
    const modeSuppression = suppressStockCompanion(renderer, game, isYinYang);
    if (isYinYang && modeSuppression.changed === 0) {
      disableNative(state, "yy-mode-gate-unknown");
      return false;
    }
    const canvasSnap = canvasSnapshot(targetCtx);
    let threw = null;
    let auditBad = false;
    let restored = true;
    try {
      renderer.ka = targetCtx;
      game.oa = built.snake;
      if ("Ra" in game) game.Ra = null;
      origRender.call(renderer, args[0], args[1], args[2]);
      state.metrics.renderCount++;
      if (!state.audited) {
        auditBad =
          hostHasUnknownMutation(snaps[0], { ka: true }) ||
          hostHasUnknownMutation(snaps[1], { oa: true, Ra: true }) ||
          hostHasUnknownMutation(snaps[2], null) ||
          graphMutated(localGraph) ||
          graphMutated(companionGraph) ||
          graphMutated(peerGraph) ||
          graphMutated(discoveredSnaps);
      }
    } catch (e) {
      threw = e;
    } finally {
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
    copyCanvasState(mainCtx, seat.ctx);
    return seat;
  }

  function adaptCadence(state, elapsed) {
    const m = state.metrics;
    m.averageRefreshMs = m.averageRefreshMs
      ? m.averageRefreshMs * 0.8 + elapsed * 0.2
      : elapsed;
    m.cadence = m.averageRefreshMs > 8 ? 20 : m.averageRefreshMs > 4 ? 30 : 60;
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
    for (let i = 0; i < peers.length; i++) {
      const id = peers[i];
      const remote = root.__mpCoopRemotes[id];
      let seat = state.seats[id];
      if (!seat) {
        seat = { id: id, bodyCache: {}, body2Cache: {}, signature: null };
        state.seats[id] = seat;
      }
      if (!renderPeerPass(state, renderer, origRender, safe, remote, remote.body, seat, "", mainCtx)) {
        return false;
      }
      if (
        bodyIsRenderable(remote.body2) &&
        !renderPeerPass(state, renderer, origRender, safe, remote, remote.body2, seat, "2", mainCtx)
      ) {
        return false;
      }
      state.metrics.refreshCount++;
    }
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
    const peers = liveNativePeers();
    for (let p = 0; p < peers.length; p++) {
      const peerMode = root.__mpCoopRemotes[peers[p]].modeKey;
      if (peerMode && String(peerMode) !== String(mode)) {
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
    const stride = state.metrics.cadence === 60 ? 1 : state.metrics.cadence === 30 ? 2 : 3;
    const keep = Object.create(null);
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
      const dirty = sig !== seat.signature || ((state.frame - 1) % stride === 0);
      if (dirty) {
        const started = nowMs();
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
        if (!renderPeerPass(state, renderer, origRender, safe, remote, remote.body, seat, "", seat.ctx)) {
          return false;
        }
        if (bodyIsRenderable(remote.body2)) {
          if (!renderPeerPass(state, renderer, origRender, safe, remote, remote.body2, seat, "2", seat.ctx)) {
            return false;
          }
        }
        seat.signature = sig;
        state.metrics.refreshCount++;
        adaptCadence(state, Math.max(0, nowMs() - started));
      }
    }
    Object.keys(state.seats).forEach(function (id) {
      if (keep[id]) return;
      const seat = state.seats[id];
      if (seat.canvas.parentNode) {
        try { seat.canvas.parentNode.removeChild(seat.canvas); } catch (e) { /* ignore */ }
      }
      state.metrics.layerReleases++;
      delete state.seats[id];
    });
    for (let c = 0; c < peers.length; c++) {
      const seat = state.seats[peers[c]];
      if (!seat) continue;
      mainCtx.drawImage(seat.canvas, 0, 0);
      state.metrics.compositeCount++;
    }
    state.metrics.backend = "layers";
    publishNativeMetrics(state);
    return true;
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
        let usedNative = false;
        try {
          usedNative = paintNativePeers(this, origRender, safe);
        } catch (eNative) {
          const state = nativeState();
          noteNativeException(state, eNative);
          usedNative = false;
        }
        try {
          drawCoopRemotes(
            this,
            usedNative
              ? function (remote) { return remote.alive === false; }
              : null
          );
        } catch (e3) { /* ignore */ }
        return out;
      };
      renderer.render.__mpCoopOriginal = origRender;
    }

    /**
     * Seat oa.ka from COOP_STATE onto the GameInstance the renderer will paint.
     * Must run on the first frame; do not require __mpCoopSession (Play can paint
     * before beginCoop). Prefer renderer.wb over a stale __mpGame pointer.
     */
    root.__mpCoopSeatBeforeRender = function (renderer) {
      if (!root.__mpCoopServerAuth) return false;
      if (root.__mpCoopSeatLocked) return true;
      const state = root.__mpCoopLastState;
      if (!state || state.ended) return false;
      const game =
        (renderer && renderer.wb) || root.__mpGame || root.__remixGame || null;
      if (game) {
        root.__mpGame = game;
        root.__remixGame = game;
      }
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
          p.x = x;
          p.y = y;
          return p;
        }
        repairHosts(this);
        const wallPick = arguments.length >= 2 && Number(arguments[1]) === 5;
        let attempts = 0;
        let pos;
        // Native freePos (Rb) reads Aa.has / Aa.size / nba.has with no null
        // guards — co-op peer sync can leave those hosts null/{}.
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
            // Re-ensure hosts (never null Aa — that caused size crashes)
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
          if (wallPick) {
            if (!wallSpawnRejected(game || this, pos.x, pos.y)) break;
          } else {
            const occ = readSpawnOccupancy(game || this, true);
            if (!spawnCellBlocked(game || this, pos.x, pos.y, occ)) break;
          }
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
        if (pos) {
          if (wallPick) {
            if (wallSpawnRejected(game || this, pos.x, pos.y)) {
              // Native Wall mode: skip the wall — never invent an illegal cell
              return null;
            }
            return pos;
          }
          const occ = readSpawnOccupancy(game || this, true);
          if (spawnCellBlocked(game || this, pos.x, pos.y, occ)) {
            const scanned = sanitizePos(
              game || this,
              findFreeSpawnCell(game || this, occ)
            );
            if (scanned) return scanned;
            // Board full for fruit → ALL_APPLES (client-auth only)
            if (root.__mpCoopServerAuth) {
              root.__mpCoopBoardFull = false;
              return pos;
            }
            if (typeof root.__mpCoopOnBoardFull === "function") {
              try {
                root.__mpCoopOnBoardFull();
              } catch (eFull) { /* ignore */ }
            }
            root.__mpCoopBoardFull = true;
            return pos;
          }
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
            if (root.__mpCoopServerAuth) {
              root.__mpCoopBoardFull = false;
            } else {
              root.__mpCoopBoardFull = true;
              if (typeof root.__mpCoopOnBoardFull === "function") {
                try {
                  root.__mpCoopOnBoardFull();
                } catch (eFull) { /* ignore */ }
              }
            }
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

        // Co-op: native crawls between STATE ticks so head "drift" is expected.
        // Do not force-reapply every tick — that reset fruit/body and looked broken.
        // SeatBeforeRender handles first-frame body seat (fruit stays with STATE seq).
        if (root.__mpCoopSession && root.__mpCoopServerAuth) {
          /* intentional no-op */
        }

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
  root.__mpCoopInstallSpawnOcc = installRemixSpawnOccupancyHooks;
  root.__mpCoopDrawRemotes = drawCoopRemotes;
  root.__mpCoopIsSolidWall = isSolidWallCell;
  root.__mpCoopWallOccupancy = wallOccupancyKeys;
  root.__mpCoopTicksRunning = coopTicksRunning;
  root.__mpCoopDisplayColorIds = coopDisplayColorIds;
  root.__mpCoopRecolorPalette = coopRecolorPalette;
  root.__mpCoopWallSpawnRejected = wallSpawnRejected;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CoopNative: CoopNative,
      coopDisplayColorIds: coopDisplayColorIds,
      coopRecolorPalette: coopRecolorPalette,
      isSolidWallCell: isSolidWallCell,
      findFreeSpawnCell: findFreeSpawnCell,
      wallOccupancyKeys: wallOccupancyKeys,
      coopTicksRunning: coopTicksRunning,
      nativeRendererMetrics: nativeMetrics,
      resetNativeRenderer: releaseNativeBackend,
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
