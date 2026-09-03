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
  }

  CoopNative.prototype.reset = function () {
    this.remotes = {};
    this.collectables = null;
    this.sessionActive = false;
    this._seedStickyUntil = 0;
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
    root.__mpCoopInject = !!this.injectEnabled && !!this.sessionActive;
    _displayColorsAt = 0;
  };

  CoopNative.prototype.beginSeedSticky = function (ms) {
    this._seedStickyUntil = Date.now() + (ms != null ? ms : 1500);
  };

  CoopNative.prototype.applySnakeDelta = function (payload) {
    if (!payload || !payload.clientId) return;
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
      if (
        root.__mpCoopSession &&
        root.__mpCoopInject &&
        !root.__mpCoopSpectator &&
        typeof root.__mpCoopOnLocalReset === "function"
      ) {
        try {
          root.__mpCoopOnLocalReset();
        } catch (e) { /* ignore */ }
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
  function drawCoopRemotes(renderer) {
    if (!root.__mpCoopInject || !root.__mpCoopSession) return 0;
    const ctx = renderer && renderer.ka;
    if (!ctx || typeof ctx.save !== "function") return 0;
    const game = (renderer && renderer.wb) || root.__mpGame || root.__remixGame;
    const tile = nativeTileSize(game);
    if (!(tile > 0)) return 0;

    const myId = root.__mpCoopMyId;
    const remotes = root.__mpCoopRemotes || {};
    const ids = Object.keys(remotes);
    if (!ids.length) return 0;

    const Gsm = root.MultiplayerGsm;
    if (!Gsm || typeof Gsm.drawWallSolverStyleSnake !== "function") return 0;

    const colorsById = displayColorIds();
    const size = boardSizeFromGame(game);
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
            0,
            0,
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
              0,
              0,
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
    return [prog, b === undefined ? true : b, c == null ? {} : c];
  }

  /**
   * True when native PlayerRenderer must not run — empty / non-finite local body
   * would throw Closure `yi NaN×4`. Spectators park off-board (finite) so they
   * still get the shared board (apples, walls, obstacles) from native render;
   * remotes are overpainted via drawCoopRemotes.
   */
  function shouldSkipNativeSnakeRender(renderer) {
    const game =
      (renderer && renderer.wb) || root.__mpGame || root.__remixGame;
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
      const origRender = renderer.render;
      renderer.render = function (a, b, c) {
        const safe = sanitizeRenderArgs(a, b, c);
        root.__mpCoopRenderArgs = safe;
        if (shouldSkipNativeSnakeRender(this)) {
          try {
            drawCoopRemotes(this);
          } catch (eSkip) { /* ignore */ }
          return undefined;
        }
        let out;
        try {
          out = origRender.call(this, safe[0], safe[1], safe[2]);
        } catch (e) {
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
        try {
          drawCoopRemotes(this);
        } catch (e3) { /* ignore */ }
        return out;
      };
    }

    root.__mpCoopRenderEnter = function (renderer) {
      if (!renderer || typeof renderer.render !== "function") return;
      root.__mpCoopPlayerRenderer = renderer;
      wrapRenderer(renderer);
    };
    root.__mpCoopSkipNativeRender = shouldSkipNativeSnakeRender;
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
        const wallPick = arguments.length >= 2 && Number(arguments[1]) === 5;
        let attempts = 0;
        let pos = orig.apply(this, arguments);
        while (pos && attempts < 64) {
          if (wallPick) {
            if (!wallSpawnRejected(game || this, pos.x, pos.y)) break;
          } else {
            const occ = readSpawnOccupancy(game || this, true);
            if (!spawnCellBlocked(game || this, pos.x, pos.y, occ)) break;
          }
          attempts++;
          pos = orig.apply(this, arguments);
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
            const scanned = findFreeSpawnCell(game || this, occ);
            if (scanned) return scanned;
            // Board full for fruit → ALL_APPLES
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
   * Rejects corners, snake/fruit/wall occupancy, and taxicab ≤3 of any head.
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
        const keys = origKeys.call(this, game, apples, skipIndexes);
        if (!root.__mpCoopSession || !root.__mpCoopInject) return keys;
        function addKey(k) {
          if (keys && typeof keys.add === "function") keys.add(k);
          else if (keys && typeof keys === "object") keys[k] = true;
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
            root.__mpCoopBoardFull = true;
            if (typeof root.__mpCoopOnBoardFull === "function") {
              try {
                root.__mpCoopOnBoardFull();
              } catch (eFull) { /* ignore */ }
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
    };
  }
})(typeof window !== "undefined" ? window : globalThis);
