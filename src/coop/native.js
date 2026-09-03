/** Native co-op: tick-synced companion paint + collide + shared fruit (no per-frame spam). */
(function (root) {
  function CoopNative() {
    this.remotes = {};
    this.collectables = null;
    this.collectablesOwnerId = null;
    this.sessionActive = false;
    this.myClientId = null;
    this.injectEnabled = true;
    this._overlay = null;
    this._raf = 0;
  }

  CoopNative.prototype.reset = function () {
    this.remotes = {};
    this.collectables = null;
    this.sessionActive = false;
    this._seedStickyUntil = 0;
    this.syncBridge();
    this.stopOverlay();
    stopCorpsePaintLoop();
    root.__mpCoopPlayerRenderer = null;
    root.__mpCoopRenderArgs = null;
  };

  CoopNative.prototype.syncBridge = function () {
    root.__mpCoopSession = !!this.sessionActive;
    root.__mpCoopMyId = this.myClientId || null;
    root.__mpCoopRemotes = this.remotes;
    root.__mpCoopCollectables = this.collectables;
    root.__mpCoopOwnerId = this.collectablesOwnerId || null;
    root.__mpCoopInject = !!this.injectEnabled && !!this.sessionActive;
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
      ["dir", "alive", "colorId", "color1", "color2", "Sc", "Yc"].forEach(
        function (k) {
          if (payload[k] != null) keep[k] = payload[k];
        }
      );
      this.remotes[payload.clientId] = keep;
      this.syncBridge();
      return;
    }
    const next = Object.assign({}, prev || {}, payload);
    if (!payload._seeded) next._fromDelta = true;
    // Keep prior colors when a delta omits them (scrape sometimes misses Sc/Yc)
    if (prev) {
      ["colorId", "color1", "color2", "Sc", "Yc", "primary", "secondary"].forEach(
        function (k) {
          if (next[k] == null && prev[k] != null) next[k] = prev[k];
        }
      );
      // Preserve visual/lerp state across merges unless body forces a reseat
      if (prev._visualBody) next._visualBody = prev._visualBody;
      if (prev._lerpAt != null) next._lerpAt = prev._lerpAt;
      if (prev._lerpStepMs != null) next._lerpStepMs = prev._lerpStepMs;
      if (prev._paintDirty != null) next._paintDirty = prev._paintDirty;
    }
    // Never drop a corpse body when a dead/empty scrape arrives
    if (bodyEmpty && prev && prev.body && prev.body.length) {
      next.body = prev.body;
    }
    if (next.alive === false && bodyEmpty && prev && prev.body && prev.body.length) {
      next.body = prev.body;
    }
    // Spectate-style trail: advance visual body when remote head moves
    if (next.body && next.body.length) {
      const Gsm = root.MultiplayerGsm;
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
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
        next._paintDirty = true;
      } else if (!next._visualBody) {
        next._visualBody = snapshotBody(next.body);
        next._paintDirty = true;
      }
    }
    this.remotes[payload.clientId] = next;
    this.syncBridge();
  };

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

  /** Mode key from Remix ModeRegistry (e.g. "peaceful", "cheese", "wall+cheese"). */
  function coopModeKey() {
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
    const parts = String(key).toLowerCase().split(/[+|_]/);
    return parts.indexOf(String(part).toLowerCase()) >= 0;
  }

  /** Peaceful mode, cat grace, or dimension/chess peaceful badge. */
  function coopSkipFriendlyHits() {
    const key = coopModeKey();
    if (modeKeyHas(key, "peaceful")) return true;
    if ((root.cat_peaceful_ticks | 0) > 0) return true;
    if (typeof root.chess_peaceful_active === "function") {
      try {
        if (root.chess_peaceful_active()) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  function coopIsCheeseMode() {
    return modeKeyHas(coopModeKey(), "cheese");
  }

  /** Board light square parity — matches theme checker (x+y)%2===0. */
  function isCheeseLightTile(x, y) {
    return (((x | 0) + (y | 0)) & 1) === 0;
  }

  /** True when a remote body cell should block (cheese light = hole). */
  function remoteCellBlocks(x, y) {
    if (x == null || y == null) return false;
    if (coopIsCheeseMode() && isCheeseLightTile(x, y)) return false;
    return true;
  }

  CoopNative.prototype.hitsRemote = function (head, excludeId) {
    if (!head) return false;
    if (coopSkipFriendlyHits()) return false;
    const remotes = this.remoteList(excludeId);
    for (let i = 0; i < remotes.length; i++) {
      const r = remotes[i];
      const body = r.body || [];
      const lim = Math.max(0, body.length - 1);
      for (let j = 0; j < lim; j++) {
        const p = body[j];
        if (
          p &&
          p.x === head.x &&
          p.y === head.y &&
          remoteCellBlocks(p.x, p.y)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Occupancy for spawn avoidance: every remote body cell (live snakes AND
   * corpses). Cheese light tiles are holes — not occupied. Rebuilt each call.
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
      addBody(this.remotes[id] && this.remotes[id].body);
    }, this);
    if (includeLocal) {
      try {
        const g = root.__mpGame || root.__remixGame;
        if (g && g.oa && g.oa.ka) addBody(g.oa.ka);
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
    if (app && app.coopNative && typeof app.coopNative.occupancyKeys === "function") {
      return app.coopNative.occupancyKeys(false);
    }
    const keys = {};
    const cheese = coopIsCheeseMode();
    const remotes = root.__mpCoopRemotes || {};
    Object.keys(remotes).forEach(function (id) {
      const body = remotes[id] && remotes[id].body;
      (body || []).forEach(function (p) {
        if (!p || p.x == null || p.y == null) return;
        if (cheese && isCheeseLightTile(p.x, p.y)) return;
        keys[(p.x | 0) + "," + (p.y | 0)] = true;
      });
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

  /** Linear scan for a cell not on any co-op snake (and not on local body). */
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
        return { x: x, y: y };
      }
    }
    return null;
  }

  // Retired product path — kept as no-ops so old callers do not paint ghosts
  CoopNative.prototype.paintRemotesOnCanvas = function () {};
  CoopNative.prototype.paintRemotes = function () {};
  CoopNative.prototype.ensureOverlay = function () {
    return null;
  };
  CoopNative.prototype.stopOverlay = function () {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    const leftover =
      typeof document !== "undefined" &&
      document.getElementById("mp-coop-remote-overlay");
    if (leftover) {
      try {
        leftover.remove();
      } catch (e) { /* ignore */ }
    }
    this._overlay = null;
  };

  function cloneBody(body, template) {
    const Gsm = root.MultiplayerGsm;
    return (body || []).map(function (p) {
      let x = p && p.x != null ? Number(p.x) : 0;
      let y = p && p.y != null ? Number(p.y) : 0;
      if (!Number.isFinite(x)) x = 0;
      if (!Number.isFinite(y)) y = 0;
      if (Gsm && typeof Gsm.makeNativePoint === "function") {
        return Gsm.makeNativePoint(x, y, template);
      }
      const seg = { x: x, y: y };
      seg.clone = function () {
        const c = { x: this.x, y: this.y };
        c.clone = this.clone;
        return c;
      };
      return seg;
    });
  }

  /** True when every segment has finite grid coords (native render NaNs otherwise). */
  function bodyIsRenderable(body) {
    if (!body || !body.length) return false;
    for (let i = 0; i < body.length; i++) {
      const p = body[i];
      if (!p) return false;
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    }
    return true;
  }

  /**
   * PlayerRenderer.render(a,b,c) — `a` is usually lerp progress. NaN progress
   * throws Closure `Error: yi NaN NaN NaN` and kills companion paints.
   */
  function sanitizeRenderArgs(a, b, c) {
    let prog = a;
    if (typeof prog === "number" && !Number.isFinite(prog)) prog = 0;
    if (prog == null) prog = 0;
    return [prog, b === undefined ? true : b, c == null ? {} : c];
  }

  function snapshotBody(body) {
    return (body || []).map(function (p) {
      const x = p && Number.isFinite(Number(p.x)) ? Number(p.x) : 0;
      const y = p && Number.isFinite(Number(p.y)) ? Number(p.y) : 0;
      return { x: x, y: y };
    });
  }

  /** Resolve primary/shade hex for a remote (delta fields → palette). */
  function remoteGradient(remote) {
    const Colors = root.MultiplayerColors;
    const colorId =
      remote && (remote.colorId != null ? remote.colorId : remote.color_id);
    const c =
      Colors && Colors.getColor && colorId != null
        ? Colors.getColor(colorId)
        : null;
    let primary =
      (remote && (remote.Sc || remote.color2 || remote.primary)) || null;
    let secondary =
      (remote && (remote.Yc || remote.color1 || remote.secondary)) || null;
    if (c) {
      if (c.kind === "rainbow" && c.set && c.set.length) {
        if (!primary) primary = c.set[0];
        if (!secondary) secondary = c.set[1] || c.set[0];
      } else if (c.primary) {
        if (!primary) primary = c.primary;
        if (!secondary) secondary = c.secondary || c.primary;
      }
    }
    return {
      primary: primary,
      secondary: secondary || primary || null,
    };
  }

  /**
   * Temporarily paint the local GameInstance in a remote's colors (Remix Sc/Yc
   * + optional slot_yy face recolor) so companion PlayerRenderer draws correctly.
   */
  function applyRemoteColors(game, remote) {
    try {
      const grad = remoteGradient(remote);
      const primary = grad.primary;
      const secondary = grad.secondary;
      if (!primary) return null;

      const targets = [];
      if (game && game.snakeBodyConfig) targets.push(game.snakeBodyConfig);
      if (game && game.oa) targets.push(game.oa);
      if (!targets.length) return null;

      const prevList = targets.map(function (cfg) {
        return {
          cfg: cfg,
          color1: cfg.color1,
          color2: cfg.color2,
          primary: cfg.primary,
          secondary: cfg.secondary,
          Sc: cfg.Sc,
          Yc: cfg.Yc,
        };
      });
      const snake = game.oa;
      const localSc = snake && snake.Sc;
      const localYc = snake && snake.Yc;

      targets.forEach(function (cfg) {
        cfg.color1 = secondary;
        cfg.color2 = primary;
        if (cfg.primary != null) cfg.primary = primary;
        if (cfg.secondary != null) cfg.secondary = secondary;
        if (typeof cfg.Sc === "string") cfg.Sc = primary;
        if (typeof cfg.Yc === "string") cfg.Yc = secondary;
      });

      if (typeof root.slot_yy_paint_snake_hex === "function") {
        root.slot_yy_paint_snake_hex(
          game,
          primary,
          secondary,
          localSc,
          localYc
        );
        prevList._yy = { primary: localSc, secondary: localYc };
      }
      return prevList;
    } catch (e) {
      return null;
    }
  }

  function restoreColors(game, prevList) {
    if (!prevList || !prevList.length) return;
    try {
      prevList.forEach(function (prev) {
        const cfg = prev.cfg;
        if (!cfg) return;
        if (prev.color1 !== undefined) cfg.color1 = prev.color1;
        if (prev.color2 !== undefined) cfg.color2 = prev.color2;
        if (prev.primary !== undefined) cfg.primary = prev.primary;
        if (prev.secondary !== undefined) cfg.secondary = prev.secondary;
        if (prev.Sc !== undefined) cfg.Sc = prev.Sc;
        if (prev.Yc !== undefined) cfg.Yc = prev.Yc;
      });
      if (prevList._yy && typeof root.slot_yy_paint_snake_hex === "function") {
        const yy = prevList._yy;
        if (yy.primary) {
          root.slot_yy_paint_snake_hex(
            game,
            yy.primary,
            yy.secondary || yy.primary
          );
        }
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Always capture PlayerRenderer ref. After local draw, re-paint companions so
   * the next RAF does not wipe remotes (tick-only paint left them invisible).
   */
  let _paintWarnAt = 0;
  function installCoopRenderHook() {
    if (root.__mpCoopRenderInstalled) return;
    root.__mpCoopRenderInstalled = true;
    root.__mpCoopRenderingCompanions = false;

    function wrapRenderer(renderer) {
      if (!renderer || renderer.__mpCoopPaintWrapped) return;
      if (typeof renderer.render !== "function") return;
      renderer.__mpCoopPaintWrapped = true;
      const origRender = renderer.render;
      renderer.render = function (a, b, c) {
        // Idle tip / Focus puppet frames often pass NaN lerp — Closure throws
        // `Error: yi NaN NaN NaN` and kills the whole native render loop.
        const safe = sanitizeRenderArgs(a, b, c);
        root.__mpCoopPlayerRenderer = renderer;
        root.__mpCoopRenderArgs = safe;
        let out;
        try {
          out = origRender.call(this, safe[0], safe[1], safe[2]);
        } catch (e) {
          try {
            out = origRender.call(this, 0, true, safe[2]);
          } catch (e2) {
            const now = Date.now();
            if (now - _paintWarnAt > 2000) {
              _paintWarnAt = now;
              console.warn("__mp render", e2);
            }
            out = undefined;
          }
        }
        // Re-draw remotes after local snake so they stay visible between ticks
        if (
          root.__mpCoopInject &&
          root.__mpCoopSession &&
          !root.__mpCoopRenderingCompanions
        ) {
          try {
            paintCompanionsOnce(
              this.wb || this.instance || root.__mpGame || root.__remixGame,
              safe[0],
              safe[1],
              safe[2]
            );
          } catch (e3) { /* ignore */ }
        }
        return out;
      };
    }

    root.__mpCoopRenderEnter = function (renderer, a, b, c) {
      if (!renderer || typeof renderer.render !== "function") return;
      root.__mpCoopPlayerRenderer = renderer;
      root.__mpCoopRenderArgs = sanitizeRenderArgs(a, b, c);
      wrapRenderer(renderer);
    };

    root.__mpCoopAfterSnakeRender = function () {
      if (!root.__mpCoopInject || !root.__mpCoopSession) return;
      try {
        paintCompanionsOnce(null);
      } catch (e) { /* ignore */ }
    };
  }

  function resolvePlayerRenderer(game) {
    if (root.__mpCoopPlayerRenderer && typeof root.__mpCoopPlayerRenderer.render === "function") {
      return root.__mpCoopPlayerRenderer;
    }
    const g = game || root.__mpGame || root.__remixGame;
    if (!g) return null;
    const candidates = [g.playerRenderer, g.Ja, g.Ia, g.renderer, g.snakeRenderer];
    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      if (r && typeof r.render === "function") {
        root.__mpCoopPlayerRenderer = r;
        return r;
      }
    }
    return null;
  }

  /** One native companion pass using the cached PlayerRenderer (tick / corpse RAF). */
  function paintCompanionsOnce(game, arg0, arg1, arg2) {
    if (root.__mpCoopRenderingCompanions) return;
    if (!root.__mpCoopInject || !root.__mpCoopSession) return;
    const renderer = resolvePlayerRenderer(game);
    if (!renderer || typeof renderer.render !== "function") return;
    const g =
      game ||
      renderer.wb ||
      renderer.instance ||
      root.__mpGame ||
      root.__remixGame;
    if (!g || !g.oa) return;

    const myId = root.__mpCoopMyId;
    const remotes = root.__mpCoopRemotes || {};
    const ids = Object.keys(remotes);
    if (!ids.length) return;

    const cached = root.__mpCoopRenderArgs || [];
    // Only reuse local args for the opaque 3rd options bag — never local lerp
    const optsArg = arg2 !== undefined ? arg2 : cached[2];
    const snake = g.oa;
    const savedKa = snake.ka;
    const savedDir = snake.direction;
    const savedDir2 = snake.dir;
    const now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    const Gsm = root.MultiplayerGsm;
    // Snapshot local coords once — restore via writeNativeBody (reuses point objects)
    const localSnap = snapshotBody(savedKa);

    root.__mpCoopRenderingCompanions = true;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (myId && id === myId) continue;
        const r = remotes[id];
        if (!r || !bodyIsRenderable(r.body)) continue;
        let vis = r._visualBody;
        if (!bodyIsRenderable(vis)) {
          if (Gsm && typeof Gsm.followBodyFromHead === "function") {
            vis = Gsm.followBodyFromHead(null, r.body);
          } else {
            vis = snapshotBody(r.body);
          }
          r._visualBody = vis;
          if (r._lerpAt == null) r._lerpAt = now;
          r._paintDirty = true;
        }
        if (!bodyIsRenderable(vis)) continue;
        const stepMs =
          r._lerpStepMs != null && r._lerpStepMs > 0
            ? r._lerpStepMs
            : 90;
        const start = r._lerpAt != null ? r._lerpAt : now;
        let t = stepMs > 0 ? (now - start) / stepMs : 1;
        if (!Number.isFinite(t)) t = 0;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        // Always paint remotes (local RAF otherwise wipes them). writeNativeBody
        // reuses point objects so this stays cheaper than the old cloneBody path.
        const prevColors = applyRemoteColors(g, r);
        if (Gsm && typeof Gsm.writeNativeBody === "function") {
          Gsm.writeNativeBody(snake, vis);
        } else {
          snake.ka = cloneBody(vis, savedKa && savedKa[0]);
        }
        if (r.dir) {
          snake.direction = r.dir;
          if (snake.dir != null) snake.dir = r.dir;
        }
        try {
          // Per-remote crawl phase — never local __mpCoopRenderArgs[0]
          renderer.render(t, true, optsArg == null ? {} : optsArg);
        } catch (e) {
          const tnow = Date.now();
          if (tnow - _paintWarnAt > 2000) {
            _paintWarnAt = tnow;
            console.warn("__mpCoop paintCompanions", e);
          }
        }
        restoreColors(g, prevColors);
        if (t >= 1) r._paintDirty = false;
      }
    } finally {
      if (Gsm && typeof Gsm.writeNativeBody === "function" && localSnap) {
        try {
          Gsm.writeNativeBody(snake, localSnap);
        } catch (e) {
          snake.ka = savedKa;
        }
      } else {
        snake.ka = savedKa;
      }
      snake.direction = savedDir;
      if (savedDir2 !== undefined) snake.dir = savedDir2;
      root.__mpCoopRenderingCompanions = false;
    }
  }

  let _corpsePaintRaf = 0;
  let _corpsePaintSkip = 0;
  function stopCorpsePaintLoop() {
    if (_corpsePaintRaf) {
      cancelAnimationFrame(_corpsePaintRaf);
      _corpsePaintRaf = 0;
    }
    _corpsePaintSkip = 0;
  }

  /** After local death, tick may stop — keep companion paint (throttled). */
  function startCorpsePaintLoop() {
    if (_corpsePaintRaf) return;
    if (typeof requestAnimationFrame !== "function") return;
    function frame() {
      _corpsePaintRaf = 0;
      if (!root.__mpCoopSession || !root.__mpCoopInject) return;
      if (!root.__mpCoopLocalDead && !root.__mpCoopSpectator) return;
      // Every other frame — corpse RAF was a major dual-player lag source
      _corpsePaintSkip = (_corpsePaintSkip + 1) & 1;
      if (!_corpsePaintSkip) {
        try {
          paintCompanionsOnce(null);
        } catch (e) { /* ignore */ }
      }
      if (typeof requestAnimationFrame === "function") {
        _corpsePaintRaf = requestAnimationFrame(frame);
      }
    }
    _corpsePaintRaf = requestAnimationFrame(frame);
  }

  /**
   * Wrap game.Tb / game.Rb so freePos never lands on live or dead co-op snakes.
   * Occupancy is re-read every attempt (snakes move between ticks).
   */
  function wrapFreePos(game) {
    if (!game || game.__mpCoopFreePosWrapped) return;
    game.__mpCoopFreePosWrapped = true;
    ["Tb", "Rb"].forEach(function (name) {
      const orig = game[name];
      if (typeof orig !== "function") return;
      game[name] = function (excl, radius) {
        let attempts = 0;
        let pos = orig.apply(this, arguments);
        while (pos && attempts < 64) {
          const occ = readCoopOccupancy();
          const k = (pos.x | 0) + "," + (pos.y | 0);
          if (!occ[k]) break;
          attempts++;
          pos = orig.apply(this, arguments);
        }
        if (pos) {
          const occ = readCoopOccupancy();
          if (occ[(pos.x | 0) + "," + (pos.y | 0)]) {
            const scanned = findFreeSpawnCell(game || this, occ);
            if (scanned) return scanned;
          }
        }
        return pos;
      };
    });
  }

  /**
   * Remix Chess/Slot spawn helpers only mark the local snake — merge co-op
   * occupancy (live + corpse) so walls/keys/fruit plants avoid peers too.
   * Installed lazily (Remix globals appear after bundle load).
   */
  function installRemixSpawnOccupancyHooks() {
    if (typeof root.chess_occupied_keys === "function" && !root.chess_occupied_keys.__mpCoop) {
      const origKeys = root.chess_occupied_keys;
      root.chess_occupied_keys = function (game, apples, skipIndexes) {
        const keys = origKeys.call(this, game, apples, skipIndexes);
        if (!root.__mpCoopSession || !root.__mpCoopInject) return keys;
        const occ = readCoopOccupancy();
        Object.keys(occ).forEach(function (k) {
          if (keys && typeof keys.add === "function") keys.add(k);
          else if (keys && typeof keys === "object") keys[k] = true;
        });
        return keys;
      };
      root.chess_occupied_keys.__mpCoop = true;
    }

    if (typeof root.slot_free_pos === "function" && !root.slot_free_pos.__mpCoop) {
      const origSlot = root.slot_free_pos;
      root.slot_free_pos = function (mgr, flag) {
        if (!root.__mpCoopSession || !root.__mpCoopInject) {
          return origSlot.apply(this, arguments);
        }
        let attempts = 0;
        let p = origSlot.apply(this, arguments);
        while (p && attempts < 64) {
          const occ = readCoopOccupancy();
          if (!occ[(p.x | 0) + "," + (p.y | 0)]) break;
          attempts++;
          p = origSlot.apply(this, arguments);
        }
        if (p) {
          const occ = readCoopOccupancy();
          if (occ[(p.x | 0) + "," + (p.y | 0)]) {
            const game =
              (mgr && mgr.wb) || root.__mpGame || root.__remixGame;
            const scanned = findFreeSpawnCell(game, occ);
            if (scanned) {
              if (typeof root.slot_make_pos === "function") {
                return root.slot_make_pos(scanned.x, scanned.y);
              }
              return scanned;
            }
          }
        }
        return p;
      };
      root.slot_free_pos.__mpCoop = true;
    }
  }

  /**
   * Tick: freePos wrap, collide, one companion paint, optional publish hook.
   * Fruit is applied only on COLLECTABLES_DELTA (not every tick).
   */
  function installCoopTickHook() {
    if (root.__mpCoopOnTickInstalled) return;
    root.__mpCoopOnTickInstalled = true;
    root.__mpCoopOnTick = function (game) {
      if (!root.__mpCoopInject || !root.__mpCoopSession) return;
      try {
        // Apply coalesced peer poses before collide/paint
        if (typeof root.__mpCoopFlushPendingDeltas === "function") {
          try {
            root.__mpCoopFlushPendingDeltas();
          } catch (e) {
            console.warn("__mpCoopFlushPendingDeltas", e);
          }
        }
        wrapFreePos(game);
        installRemixSpawnOccupancyHooks();
        const myId = root.__mpCoopMyId;
        const remotes = root.__mpCoopRemotes || {};

        // Co-op spectator: keep local body empty so only companions are visible
        if (root.__mpCoopSpectator && game && game.oa) {
          if (!Array.isArray(game.oa.ka)) game.oa.ka = [];
          game.oa.ka.length = 0;
          root.__mpCoopLocalDead = true;
          startCorpsePaintLoop();
        }

        if (!root.__mpCoopSpectator && !coopSkipFriendlyHits()) {
          const snake = game && game.oa;
          const body = snake && snake.ka;
          const head = body && body[0];
          if (head && myId && !root.__mpCoopLocalDead) {
            let hit = false;
            Object.keys(remotes).forEach(function (id) {
              if (hit || id === myId) return;
              const r = remotes[id];
              const segs = (r && r.body) || [];
              const lim = Math.max(0, segs.length - 1);
              for (let j = 0; j < lim; j++) {
                const p = segs[j];
                if (
                  p &&
                  p.x === head.x &&
                  p.y === head.y &&
                  remoteCellBlocks(p.x, p.y)
                ) {
                  hit = true;
                  break;
                }
              }
            });
            if (hit) {
              // Snapshot before die so corpse + death anim keep a real body
              const bodySnap = snapshotBody(body);
              root.__mpCoopLocalDead = true;
              if (typeof root.__mpCoopOnFriendlyDeath === "function") {
                try {
                  root.__mpCoopOnFriendlyDeath(bodySnap);
                } catch (e) { /* ignore */ }
              }
              if (typeof game.die === "function") {
                try {
                  game.die();
                } catch (e) { /* fall through */ }
              } else if (
                root.MultiplayerGsm &&
                root.MultiplayerGsm.forceLocalDeath
              ) {
                root.MultiplayerGsm.forceLocalDeath();
              }
              startCorpsePaintLoop();
            }
          }
        }

        // Companions also re-paint after local PlayerRenderer each frame;
        // tick paint covers the first frames before wrap captures renderer.
        if (!root.__mpCoopLocalDead || root.__mpCoopSpectator) {
          paintCompanionsOnce(game);
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
  root.__mpCoopPaintCompanions = paintCompanionsOnce;
  root.__mpCoopStopCorpsePaint = stopCorpsePaintLoop;
  root.__mpCoopReadOccupancy = readCoopOccupancy;
  root.__mpCoopFindFreeSpawn = findFreeSpawnCell;
  root.__mpCoopInstallSpawnOcc = installRemixSpawnOccupancyHooks;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { CoopNative: CoopNative };
  }
})(typeof window !== "undefined" ? window : globalThis);
