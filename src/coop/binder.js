/**
 * Co-op native binder — force GameInstance to display server COOP_STATE.
 * Plan 1: local snake + fruit + score/death. Peers stay SVG (native.js).
 * Body/fruit apply only when seq changes (or force) so native crawl cannot fight STATE.
 */
(function (root) {
  function gameInstance() {
    return (
      root.__mpGame ||
      root.__remixGame ||
      (root.MultiplayerGsm && root.MultiplayerGsm.gameInstance
        ? root.MultiplayerGsm.gameInstance()
        : null)
    );
  }

  function dirToNative(dir) {
    const d = String(dir || "RIGHT").toUpperCase();
    if (d === "UP" || d === "DOWN" || d === "LEFT" || d === "RIGHT") return d;
    return "RIGHT";
  }

  function snapshotBody(body) {
    return (body || []).map(function (p) {
      return { x: (p && p.x) | 0, y: (p && p.y) | 0 };
    });
  }

  /**
   * Mid-match death = SVG corpse only (no native nj/stars/deathscreen).
   * Never stop TimeKeeper.playing here — shared run continues until match end.
   * Situations: alive → clear corpse; dead+!ended → __mpCoopLocalCorpse; ended → match teardown owns timer.
   */
  function syncLocalAliveFlags(state, myId) {
    if (!state || !myId) return;
    const g = gameInstance();
    if (!g) return;
    const snakes = state.snakes || [];
    let mine = null;
    for (let i = 0; i < snakes.length; i++) {
      if (snakes[i] && snakes[i].clientId === myId) {
        mine = snakes[i];
        break;
      }
    }
    if (!mine) return;
    const alive = mine.alive !== false && !state.ended;
    try {
      // Never arm native death stars under server-auth
      g.nj = false;
      if (g.dead != null) g.dead = false;
      if (g.isDead != null) g.isDead = false;
      if (alive) {
        root.__mpCoopLocalCorpse = false;
        if (root.timeKeeper) root.timeKeeper._dead = false;
      } else if (!state.ended) {
        root.__mpCoopLocalCorpse = true;
        // Keep shared timer running for survivors / HUD
        if (root.timeKeeper) root.timeKeeper._dead = false;
      } else {
        root.__mpCoopLocalCorpse = true;
      }
    } catch (e) { /* ignore */ }
  }

  function bodiesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if ((a[i].x | 0) !== (b[i].x | 0) || (a[i].y | 0) !== (b[i].y | 0)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Peers → SVG remotes. Merge in place so __mpMotion / _visualBody survive.
   * Never depends on GameInstance (must work before Play).
   */
  function applyRemotesFromState(state, myId) {
    if (!state) return false;
    try {
      const prevAll = root.__mpCoopRemotes || Object.create(null);
      const remotes = Object.create(null);
      const snakes = state.snakes || [];
      const Gsm = root.MultiplayerGsm;
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      const intervalMs =
        state.intervalMs != null ? Number(state.intervalMs) : null;
      for (let i = 0; i < snakes.length; i++) {
        const s = snakes[i];
        if (!s || !s.clientId || s.clientId === myId) continue;
        const prev = prevAll[s.clientId] || {};
        const nextBody = snapshotBody(s.body);
        const next = {
          clientId: s.clientId,
          body: nextBody,
          dir: s.dir || "RIGHT",
          alive: s.alive !== false,
          colorId: s.colorId != null ? s.colorId : prev.colorId,
          score: s.score | 0,
          _fromState: true,
        };
        // Preserve motion / visual trail across STATE frames
        if (prev.__mpMotion) next.__mpMotion = prev.__mpMotion;
        if (prev._lerpAt != null) next._lerpAt = prev._lerpAt;
        if (prev._lerpStepMs != null) next._lerpStepMs = prev._lerpStepMs;
        if (intervalMs > 0) next._lerpStepMs = intervalMs;
        const prevHead = prev.body && prev.body[0];
        const nextHead = nextBody[0];
        let headMoved = !prevHead || !nextHead;
        if (prevHead && nextHead) {
          headMoved =
            (prevHead.x | 0) !== (nextHead.x | 0) ||
            (prevHead.y | 0) !== (nextHead.y | 0) ||
            (prev.body && prev.body.length) !== nextBody.length;
        }
        if (headMoved) {
          if (Gsm && typeof Gsm.followBodyFromHead === "function") {
            next._visualBody = Gsm.followBodyFromHead(prev._visualBody, nextBody);
          } else {
            next._visualBody = snapshotBody(nextBody);
          }
          next._lerpAt = now;
        } else if (prev._visualBody) {
          next._visualBody = prev._visualBody;
        } else {
          next._visualBody = snapshotBody(nextBody);
        }
        remotes[s.clientId] = next;
      }
      root.__mpCoopRemotes = remotes;
      return Object.keys(remotes).length > 0 || snakes.length <= 1;
    } catch (eR) {
      console.warn("applyRemotesFromState", eR);
      return false;
    }
  }

  function writeLocalBody(g, Gsm, body, opts) {
    if (!g || !g.oa) return false;
    const preserveAnim = !(opts && opts.clearAnim);
    // Skip no-op rewrites — snapping ka every STATE tick kills native crawl lerp
    if (
      preserveAnim &&
      Array.isArray(g.oa.ka) &&
      bodiesEqual(
        Array.prototype.map.call(g.oa.ka, function (p) {
          return p && { x: p.x | 0, y: p.y | 0 };
        }),
        body
      )
    ) {
      return false;
    }
    if (typeof Gsm.writeNativeBody === "function") {
      Gsm.writeNativeBody(g.oa, body);
    } else if (Array.isArray(g.oa.ka)) {
      g.oa.ka.length = 0;
      for (let b = 0; b < body.length; b++) {
        const p = body[b];
        g.oa.ka.push(
          Gsm.makeNativePoint
            ? Gsm.makeNativePoint(p.x, p.y)
            : { x: p.x | 0, y: p.y | 0 }
        );
      }
    } else {
      return false;
    }
    if (typeof Gsm.ensureSnakeSegmentFlags === "function") {
      Gsm.ensureSnakeSegmentFlags(g.oa);
    }
    // Never clear mouth/grow/eat here mid-match — that is what made native
    // snakes unusable. Session reset / soft-rebind clear anim leftovers instead.
    if (!preserveAnim) {
      try {
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
      } catch (eEat) { /* ignore */ }
    }
    return true;
  }

  function fruitFingerprint(state) {
    const apples = (state && (state.fruit || state.apples)) || [];
    let fp = String(apples.length);
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      if (!a) {
        fp += "|x";
        continue;
      }
      fp +=
        "|" +
        ((a.x | 0) +
          "," +
          (a.y | 0) +
          "," +
          (a.type != null ? a.type : a.type_id != null ? a.type_id : 0));
    }
    return fp;
  }

  function writeFruit(g, Gsm, state, opts) {
    const apples = state.fruit || state.apples || [];
    const hardReset = !!(opts && opts.hardReset);
    if (typeof Gsm.applyCollectables === "function") {
      Gsm.applyCollectables({
        apples: apples.map(function (a) {
          return {
            x: a.x | 0,
            y: a.y | 0,
            type: a.type != null ? a.type : a.type_id != null ? a.type_id : 0,
          };
        }),
        serverAuth: true,
        hardReset: hardReset,
      });
      return true;
    }
    if (g.wa && Array.isArray(g.wa.ka)) {
      if (hardReset) g.wa.ka.length = 0;
      while (g.wa.ka.length > apples.length) g.wa.ka.pop();
      for (let i = 0; i < apples.length; i++) {
        const src = apples[i];
        let dst = g.wa.ka[i];
        if (!dst) {
          dst = { pos: { x: src.x | 0, y: src.y | 0 }, type: src.type | 0 };
          g.wa.ka.push(dst);
        } else if (dst.pos) {
          dst.pos.x = src.x | 0;
          dst.pos.y = src.y | 0;
        } else {
          dst.x = src.x | 0;
          dst.y = src.y | 0;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Apply authoritative STATE into native hosts.
   * Remotes always update. Local body + fruit only when seq changes (or force).
   * Fruit is never rewritten on force-seat — that kills native eat animations.
   * @param {object} state
   * @param {string} myId
   * @param {{force?:boolean, skipFruit?:boolean, bodyOnly?:boolean}} [opts]
   * @returns {{ok:boolean, remotes:boolean, local:boolean, fruit:boolean, skipped?:boolean}}
   */
  function applyCoopState(state, myId, opts) {
    const result = {
      ok: false,
      remotes: false,
      local: false,
      fruit: false,
      skipped: false,
    };
    if (!state || !root.__mpCoopServerAuth) return result;

    const force = !!(opts && opts.force);
    const skipFruit = !!(opts && (opts.skipFruit || opts.bodyOnly));
    const bodyOnly = !!(opts && opts.bodyOnly);
    const seq = state.seq | 0;
    const prevSeq =
      root.__mpCoopAppliedSeq != null ? root.__mpCoopAppliedSeq | 0 : null;
    const seqUnchanged = prevSeq != null && prevSeq === seq && !force;

    root.__mpCoopLastState = state;
    root.__mpCoopLastStateMyId = myId;
    root.__mpCoopLastStateSeq = seq;
    root.__mpCoopLastStateTick = state.tick | 0;
    if (state.intervalMs != null) {
      root.__mpCoopIntervalMs = Number(state.intervalMs) || 0;
    }

    if (!bodyOnly) {
      result.remotes = applyRemotesFromState(state, myId);
    }

    // Auth-local motion holder (SVG path) — keep across frames
    try {
      const holder =
        root.__mpCoopLocalMotion ||
        (root.__mpCoopLocalMotion = { clientId: myId });
      holder.clientId = myId;
      if (root.__mpCoopIntervalMs > 0) {
        holder._lerpStepMs = root.__mpCoopIntervalMs;
      }
      const snakes = state.snakes || [];
      let mine = null;
      for (let i = 0; i < snakes.length; i++) {
        if (snakes[i] && snakes[i].clientId === myId) {
          mine = snakes[i];
          break;
        }
      }
      if (mine && mine.body && mine.body.length) {
        const nextBody = snapshotBody(mine.body);
        const prevBody = holder.body;
        const headMoved = !bodiesEqual(prevBody, nextBody);
        holder.body = nextBody;
        holder.dir = mine.dir || "RIGHT";
        holder.alive = mine.alive !== false;
        holder.colorId = mine.colorId;
        if (headMoved) {
          const Gsm = root.MultiplayerGsm;
          const now =
            typeof performance !== "undefined" && performance.now
              ? performance.now()
              : Date.now();
          if (Gsm && typeof Gsm.followBodyFromHead === "function") {
            holder._visualBody = Gsm.followBodyFromHead(
              holder._visualBody,
              nextBody
            );
          } else {
            holder._visualBody = snapshotBody(nextBody);
          }
          holder._lerpAt = now;
        } else if (!holder._visualBody) {
          holder._visualBody = snapshotBody(nextBody);
        }
      }
    } catch (eMot) { /* ignore */ }

    // Always sync death flags from STATE — even when seq is unchanged.
    syncLocalAliveFlags(state, myId);

    if (seqUnchanged) {
      result.skipped = true;
      result.ok = result.remotes;
      return result;
    }

    const g = gameInstance();
    const Gsm = root.MultiplayerGsm;
    if (!g || !Gsm) {
      root.__mpCoopAppliedSeq = seq;
      result.ok = result.remotes;
      return result;
    }

    // Board meta from server (grid bake happens at Play — do not poke size menu)
    try {
      const bw = state.width | 0;
      const bh = state.height | 0;
      if (bw > 0 && bh > 0) {
        const metas = [];
        if (g.oa && g.oa.oa) metas.push(g.oa.oa);
        if (g.wa && g.wa.oa && g.wa.oa.oa) metas.push(g.wa.oa.oa);
        for (let mi = 0; mi < metas.length; mi++) {
          const m = metas[mi];
          if (!m) continue;
          if (m.width != null) m.width = bw;
          if (m.height != null) m.height = bh;
          if (m.W != null) m.W = bw;
          if (m.H != null) m.H = bh;
        }
        if (g.width != null) g.width = bw;
        if (g.height != null) g.height = bh;
        if (typeof Gsm.ensureWallGridDense === "function" && g.Ca) {
          try {
            Gsm.ensureWallGridDense(g.Ca, bw, bh);
          } catch (eGrid) { /* ignore */ }
        }
      }
    } catch (eDim) { /* ignore */ }

    if (!skipFruit) {
      try {
        const fp = fruitFingerprint(state);
        const hardReset = !!root.__mpCoopFruitHardReset;
        if (hardReset || fp !== root.__mpCoopFruitFp) {
          if (writeFruit(g, Gsm, state, { hardReset: hardReset })) {
            result.fruit = true;
            root.__mpCoopFruitFp = fp;
            if (hardReset) root.__mpCoopFruitHardReset = false;
          }
        }
      } catch (eFruit) {
        console.warn("applyCoopState fruit", eFruit);
      }
    }

    try {
      const snakes = state.snakes || [];
      let mine = null;
      for (let i = 0; i < snakes.length; i++) {
        if (snakes[i] && snakes[i].clientId === myId) {
          mine = snakes[i];
          break;
        }
      }
      if (mine && g.oa) {
        const body = mine.body || [];
        if (writeLocalBody(g, Gsm, body)) {
          const nd = dirToNative(mine.dir);
          try {
            // Only poke facing when it actually changes — perpetual assigns
            // fight native head turn / mouth timing.
            if (g.oa.direction != null && g.oa.direction !== nd) {
              g.oa.direction = nd;
            }
            if (g.oa.dir != null && g.oa.dir !== nd) g.oa.dir = nd;
          } catch (eDir) { /* ignore */ }
          result.local = true;
        }
      }
    } catch (eSnake) {
      console.warn("applyCoopState snake", eSnake);
    }

    try {
      if (g.Ca && typeof Gsm.ensureNativeWallMap === "function") {
        Gsm.ensureNativeWallMap(g.Ca);
      }
    } catch (eW) { /* ignore */ }

    // Body-only seat must not advance seq gate (fruit still pending)
    if (!bodyOnly && !skipFruit) {
      root.__mpCoopAppliedSeq = seq;
    } else if (!bodyOnly && skipFruit && !seqUnchanged) {
      // Force seat with skipFruit: still advance seq so we don't loop body writes
      root.__mpCoopAppliedSeq = seq;
    }
    result.ok = result.remotes || result.local || result.fruit;
    return result;
  }

  /**
   * Re-bind last STATE body only when head drifted — never wipe fruit.
   */
  function reapplyLastState(opts) {
    if (!root.__mpCoopServerAuth) return false;
    if (!root.__mpCoopLastState) return false;
    if (root.__mpCoopLastState.ended) return false;
    const force = !!(opts && opts.force);
    const myId = root.__mpCoopLastStateMyId;
    if (
      !force &&
      typeof localHeadMatchesState === "function" &&
      localHeadMatchesState(root.__mpCoopLastState, myId) &&
      root.__mpCoopSeatLocked
    ) {
      return true;
    }
    // Body-only — fruit rewrites from render/tick destroy native eat anims
    const r = applyCoopState(root.__mpCoopLastState, myId, {
      force: true,
      skipFruit: true,
      bodyOnly: true,
    });
    return !!(r && r.ok);
  }

  /**
   * True when local head matches STATE (or expected) within 0 cells.
   */
  function localHeadMatchesState(state, myId) {
    if (!state || !myId) return false;
    const g = gameInstance();
    if (!g || !g.oa || !Array.isArray(g.oa.ka) || !g.oa.ka[0]) return false;
    const snakes = state.snakes || [];
    let mine = null;
    for (let i = 0; i < snakes.length; i++) {
      if (snakes[i] && snakes[i].clientId === myId) {
        mine = snakes[i];
        break;
      }
    }
    if (!mine || !mine.body || !mine.body[0]) return false;
    const h = g.oa.ka[0];
    const e = mine.body[0];
    return (h.x | 0) === (e.x | 0) && (h.y | 0) === (e.y | 0);
  }

  /**
   * Capture arrow keys → COOP_INPUT + immediate local facing.
   * Facing only — native crawl stays paused under server-auth.
   */
  function installCoopInputCapture(sendDirFn) {
    if (root.__mpCoopInputInstalled) return;
    root.__mpCoopInputInstalled = true;
    const map = {
      ArrowUp: "UP",
      ArrowDown: "DOWN",
      ArrowLeft: "LEFT",
      ArrowRight: "RIGHT",
      w: "UP",
      W: "UP",
      s: "DOWN",
      S: "DOWN",
      a: "LEFT",
      A: "LEFT",
      d: "RIGHT",
      D: "RIGHT",
    };
    root.addEventListener(
      "keydown",
      function (ev) {
        if (!root.__mpCoopServerAuth || !root.__mpCoopSession) return;
        const dir = map[ev.key];
        if (!dir) return;
        try {
          const g = gameInstance();
          if (g && g.oa) {
            if (g.oa.direction != null) g.oa.direction = dir;
            if (g.oa.dir != null) g.oa.dir = dir;
          }
          // Face the auth SVG head immediately (STATE may lag a tick)
          const holder =
            root.__mpCoopLocalMotion ||
            (root.__mpCoopLocalMotion = {});
          holder.dir = dir;
        } catch (e) { /* ignore */ }
        if (typeof sendDirFn === "function") sendDirFn(dir);
      },
      true
    );
  }

  root.CoopBinder = {
    applyCoopState: applyCoopState,
    applyRemotesFromState: applyRemotesFromState,
    reapplyLastState: reapplyLastState,
    localHeadMatchesState: localHeadMatchesState,
    installCoopInputCapture: installCoopInputCapture,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.CoopBinder;
  }
})(typeof window !== "undefined" ? window : globalThis);
