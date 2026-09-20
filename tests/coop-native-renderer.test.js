"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const NATIVE = path.join(ROOT, "src/coop/native.js");

function point(x, y) {
  const p = { x: x, y: y };
  p.clone = function () {
    const c = { x: this.x, y: this.y };
    c.clone = this.clone;
    return c;
  };
  return p;
}

function fakeContext(width, height) {
  const transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const ctx = {
    canvas: null,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    filter: "none",
    direction: "inherit",
    clears: 0,
    composites: 0,
    save: function () {},
    restore: function () {},
    clearRect: function () { this.clears++; },
    drawImage: function () { this.composites++; },
    getTransform: function () { return Object.assign({}, transform); },
    setTransform: function (a, b, c, d, e, f) {
      transform.a = a;
      transform.b = b;
      transform.c = c;
      transform.d = d;
      transform.e = e;
      transform.f = f;
    },
  };
  ctx.canvas = {
    width: width || 340,
    height: height || 300,
    clientWidth: width || 340,
    clientHeight: height || 300,
    style: {},
    getContext: function () { return ctx; },
  };
  return ctx;
}

function loadHarness(options) {
  options = options || {};
  global.window = global;
  [
    "__mpCoopRenderInstalled",
    "__mpCoopOnTickInstalled",
    "__mpCoopRenderParked",
    "__mpCoopNativeRenderMetrics",
    "__mpCoopNativeRenderDebug",
    "__slotFaceRef",
    "__mpFaceTintSc",
    "__slotA7",
  ].forEach(function (k) { delete global[k]; });
  delete require.cache[require.resolve(NATIVE)];

  const layers = [];
  global.document = {
    createElement: function (tag) {
      assert.equal(tag, "canvas");
      const ctx = fakeContext(options.width, options.height);
      layers.push(ctx);
      return ctx.canvas;
    },
  };
  global.__testCoopMode = options.mode || "classic";
  global.MultiplayerGsm = {
    effectiveModeKey: function () { return global.__testCoopMode; },
    drawWallSolverStyleSnake: function (ctx, body) {
      if (options.mosaic) options.mosaic.push(body[0].x);
    },
    snakeMotion: function () { return null; },
  };
  require(NATIVE);

  const localBody = [point(1, 1), point(0, 1)];
  const localFlags = [true, true];
  const companionBody = [point(15, 13), point(16, 13)];
  const companion = { ka: companionBody, wa: [true, true], status: "local-yy" };
  const local = {
    ka: localBody,
    wa: localFlags,
    direction: "RIGHT",
    Ca: "RIGHT",
    Ga: "RIGHT",
    turns: [{ x: 1, y: 1, dir: "UP" }],
    Sc: "#00f",
    Yc: "#008",
    status: "alive",
    Ra: companion,
  };
  const game = {
    oa: local,
    Ra: companion,
    ka: { ka: 20 },
    settings: { modeKey: options.mode || "classic", light: false },
    statusHost: { alive: true },
    nj: false,
    dead: false,
    isDead: false,
  };
  const main = fakeContext(options.width, options.height);
  const faceEye = { context: main, name: "oa" };
  const faceMouth = { context: main, name: "Aa" };
  const calls = [];
  let throwRemaining = options.throwRemote || 0;
  const renderer = {
    wb: game,
    ka: main,
    oa: faceEye,
    Aa: faceMouth,
    settings: { modeKey: options.mode || "classic" },
    render: function (progress, flag, args) {
      const remote = game.oa !== local;
      calls.push({
        remote: remote,
        head: game.oa.ka[0].x,
        bodyRef: game.oa.ka,
        ctx: this.ka,
        faceCtx: faceEye.context,
        progress: progress,
        nj: !!game.nj,
      });
      if (remote && options.mutateUnknown) game.unexpectedMutation = true;
      if (remote && options.mutateLocalPoint) local.ka[0].x = 99;
      if (remote && options.lockContextRemote) {
        Object.defineProperty(this, "ka", {
          value: this.ka,
          writable: false,
          configurable: true,
          enumerable: true,
        });
      }
      if (remote && throwRemaining > 0) {
        throwRemaining--;
        throw new Error("injected remote render");
      }
      // Model stock YY's settings-gated automatic reflected companion.
      if (remote && /yin.?yang/i.test(String(this.settings.modeKey))) {
        calls.push({ remote: true, automaticCompanion: true });
      }
      if (args && options.mutateArgs && remote) args.changed = true;
      return flag;
    },
  };

  global.__mpCoopInject = true;
  global.__mpCoopSession = true;
  global.__mpCoopAuthority = "native-relay-v1";
  global.__mpCoopSpectator = false;
  global.__mpCoopServerAuth = false;
  global.__mpCoopMyId = "me";
  global.__mpCoopGeneration = options.generation || 1;
  global.__mpCoopLastState = null;
  global.__mpCoopRemotes = {};
  global.__mpCoopRenderEnter(renderer);

  return {
    renderer: renderer,
    game: game,
    local: local,
    companion: companion,
    main: main,
    faceEye: faceEye,
    faceMouth: faceMouth,
    layers: layers,
    calls: calls,
  };
}

function remote(id, slot, x, yy) {
  const out = {
    clientId: id,
    slot: slot,
    alive: true,
    modeKey: yy ? "yin_yang" : "classic",
    body: [{ x: x, y: 5 }, { x: x - 1, y: 5 }],
    movementDir: "RIGHT",
    headDir: "RIGHT",
    transitionDir: "UP",
    turns: [{ x: x, y: 5, dir: "UP" }],
    Sc: "#f00",
    Yc: "#800",
  };
  if (yy) {
    out.body2 = [{ x: 16 - x, y: 9 }, { x: 17 - x, y: 9 }];
    out.movementDir2 = "LEFT";
    out.headDir2 = "LEFT";
    out.transitionDir2 = "DOWN";
    out.Sc2 = "#eee";
    out.Yc2 = "#999";
  }
  return out;
}

test("2 seats: local first, one cached native remote layer", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});

  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].remote, false, "local native render is first");
  assert.equal(h.calls[1].remote, true);
  assert.notEqual(h.calls[1].ctx, h.main, "remote uses its own layer context");
  assert.equal(h.layers.length, 1);
  assert.equal(h.layers[0].clears, 1, "dirty layer clears once");
  assert.equal(h.main.composites, 1);
  assert.equal(global.__mpCoopNativeRendererMetrics().backend, "layers");
});

test("4 seats YY performs exactly six explicit remote passes without stock duplicates", function () {
  const h = loadHarness({ mode: "yin_yang" });
  global.__mpCoopRemotes = {
    c: remote("c", 3, 12, true),
    a: remote("a", 1, 4, true),
    b: remote("b", 2, 8, true),
  };
  h.renderer.render(0.25, true, {});

  const remoteCalls = h.calls.filter(function (c) { return c.remote; });
  assert.equal(remoteCalls.length, 6);
  assert.equal(
    remoteCalls.filter(function (c) { return c.automaticCompanion; }).length,
    0,
    "settings-gated stock YY path is suppressed"
  );
  assert.deepEqual(
    remoteCalls.map(function (c) { return c.head; }),
    [4, 12, 8, 8, 12, 4],
    "frozen slot order paints primary then transmitted body2"
  );
  assert.equal(global.__mpCoopNativeRendererMetrics().renderCount, 6);
  assert.equal(h.renderer.settings.modeKey, "yin_yang", "mode setting restored");
});

test("transaction restores exact references and values after success and throw", function () {
  const h = loadHarness({ throwRemote: 1, mutateLocalPoint: true });
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  const bodyRef = h.local.ka;
  const pointRef = h.local.ka[0];
  const flagsRef = h.local.wa;
  const companionRef = h.game.Ra;
  const ctxRef = h.renderer.ka;
  const settingsRef = h.renderer.settings;

  assert.doesNotThrow(function () { h.renderer.render(0.5, true, {}); });
  assert.equal(h.game.oa, h.local);
  assert.equal(h.local.ka, bodyRef);
  assert.equal(h.local.ka[0], pointRef);
  assert.equal(h.local.ka[0].x, 1);
  assert.equal(h.local.wa, flagsRef);
  assert.equal(h.game.Ra, companionRef);
  assert.equal(h.renderer.ka, ctxRef);
  assert.equal(h.renderer.settings, settingsRef);

  h.renderer.render(0.5, true, {});
  assert.equal(h.game.oa, h.local);
  assert.equal(h.local.ka[0].x, 1);
  assert.equal(h.renderer.ka, ctxRef);
});

test("mutation audit rejects unknown host changes for the generation", function () {
  const mosaic = [];
  const h = loadHarness({ mutateUnknown: true, mosaic: mosaic });
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  // First unknown mutation is a soft retry (not sticky disable yet)
  let first = global.__mpCoopNativeRendererMetrics();
  assert.notEqual(first.fallbackReason, "mutation-audit");
  h.renderer.render(0.5, true, {});
  first = global.__mpCoopNativeRendererMetrics();
  assert.equal(first.backend, "mosaic");
  assert.equal(first.fallbackReason, "mutation-audit");
  assert.equal(h.game.unexpectedMutation, undefined, "unknown mutation restored");
  const nativeCalls = h.calls.filter(function (c) { return c.remote; }).length;
  h.renderer.render(0.5, true, {});
  assert.equal(
    h.calls.filter(function (c) { return c.remote; }).length,
    nativeCalls,
    "native remains disabled for generation"
  );
  assert.ok(mosaic.length >= 1);
});

test("restoration failure and unknown YY mode gate fail safely to mosaic", function () {
  const locked = loadHarness({ lockContextRemote: true });
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  locked.renderer.render(0.5, true, {});
  assert.equal(
    global.__mpCoopNativeRendererMetrics().fallbackReason,
    "restoration-failure"
  );

  const mosaic = [];
  const yy = loadHarness({ mode: "yin_yang", mosaic: mosaic });
  yy.renderer.settings = {};
  yy.game.settings = {};
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, true);
  yy.renderer.render(0.5, true, {});
  assert.equal(
    global.__mpCoopNativeRendererMetrics().fallbackReason,
    "yy-mode-gate-unknown"
  );
  assert.equal(yy.calls.filter(function (c) { return c.remote; }).length, 0);
  assert.ok(mosaic.length >= 2, "primary and transmitted body2 use mosaic fallback");
});

test("malformed peers skip and circuit breaker resets on generation", function () {
  const h = loadHarness({ throwRemote: 3 });
  global.__mpCoopRemotes = {
    bad: { clientId: "bad", slot: 1, alive: true, body: [{ x: NaN, y: 2 }] },
    good: remote("good", 2, 8, false),
  };
  h.renderer.render(0.5, true, {});
  h.renderer.render(0.5, true, {});
  h.renderer.render(0.5, true, {});
  assert.equal(
    global.__mpCoopNativeRendererMetrics().fallbackReason,
    "render-circuit-breaker"
  );
  assert.equal(
    h.calls.some(function (c) { return c.remote && !Number.isFinite(c.head); }),
    false
  );

  global.__mpCoopGeneration = 2;
  h.renderer.render(0.5, true, {});
  assert.equal(global.__mpCoopNativeRendererMetrics().generation, 2);
  assert.equal(global.__mpCoopNativeRendererMetrics().backend, "layers");
});

test("Light, spectator, and server-sim stay mosaic", function () {
  ["light", "spectator", "server"].forEach(function (tier) {
    const mosaic = [];
    const h = loadHarness({ mode: tier === "light" ? "light" : "classic", mosaic: mosaic });
    global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
    global.__mpCoopRemotes.peer.modeKey = global.__testCoopMode;
    if (tier === "spectator") global.__mpCoopSpectator = true;
    if (tier === "server") {
      global.__mpCoopAuthority = "server-sim-v1";
      global.__mpCoopServerAuth = true;
    }
    h.renderer.render(0.5, true, {});
    assert.equal(
      h.calls.filter(function (c) { return c.remote; }).length,
      0,
      tier + " must not use native peer passes"
    );
    assert.ok(mosaic.indexOf(8) >= 0, tier + " uses mosaic");
  });
});

test("dirty layers reuse buffers, resize releases, and composite every frame", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  const first = Object.assign({}, global.__mpCoopNativeRendererMetrics());
  const firstBodyRef = h.calls.filter(function (c) {
    return c.remote;
  })[0].bodyRef;
  // Pose change so the second frame still refreshes.
  global.__mpCoopNativeRendererMetrics().cadence = 60;
  global.__mpCoopRemotes.peer.body[0].x = 9;
  h.renderer.render(0.5, true, {});
  const secondRemote = h.calls.filter(function (c) {
    return c.remote;
  })[1];
  assert.ok(secondRemote, "expected a second peer refresh");
  assert.equal(secondRemote.bodyRef, firstBodyRef, "point buffer array is reused");
  assert.equal(global.__mpCoopNativeRendererMetrics().layerAllocations, 1);
  assert.equal(h.main.composites, 2, "cached layer composites every local frame");
  assert.ok(global.__mpCoopNativeRendererMetrics().bufferGrowth >= first.bufferGrowth);

  h.main.canvas.width = 680;
  h.main.canvas.height = 600;
  global.__mpCoopNativeRendererMetrics().cadence = 60;
  h.renderer.render(0.5, true, {});
  const resized = global.__mpCoopNativeRendererMetrics();
  assert.equal(resized.layerAllocations, 2);
  assert.equal(resized.layerReleases, 1);
});

test("adaptive cadence still tracks paint cost; every peer P5E every frame", function () {
  const realPerformance = global.performance;
  let tick = 0;
  global.performance = { now: function () { tick += 10; return tick; } };
  try {
    const h = loadHarness();
    global.__mpCoopRemotes = {
      a: remote("a", 1, 4, false),
      b: remote("b", 2, 8, false),
    };
    h.renderer.render(0.5, true, {});
    assert.equal(global.__mpCoopNativeRendererMetrics().cadence, 20);
    const refresh = global.__mpCoopNativeRendererMetrics().refreshCount;
    const renders = global.__mpCoopNativeRendererMetrics().renderCount;
    // Same poses — still refresh both peers every frame (no stride/budget).
    global.__mpCoopNativeRendererMetrics().cadence = 20;
    h.renderer.render(0.5, true, {});
    assert.equal(
      global.__mpCoopNativeRendererMetrics().refreshCount,
      refresh + 2,
      "multi-peer refreshes all seats every frame"
    );
    assert.equal(
      global.__mpCoopNativeRendererMetrics().renderCount,
      renders + 2,
      "two peers → two P5E per frame"
    );
    assert.equal(h.main.composites, 4, "two peers × two frames still composite");
  } finally {
    global.performance = realPerformance;
  }
});

test("single peer refreshes every frame at cadence 60", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.25, true, {});
  const afterFirst = global.__mpCoopNativeRendererMetrics().renderCount;
  for (let i = 0; i < 5; i++) {
    global.__mpCoopNativeRendererMetrics().cadence = 60;
    global.__mpCoopNativeRendererMetrics().averageRefreshMs = 2;
    h.renderer.render(0.25 + i * 0.1, true, {});
  }
  assert.equal(
    global.__mpCoopNativeRendererMetrics().renderCount,
    afterFirst + 5,
    "1v1 at cadence 60 must P5E every frame"
  );
  assert.equal(h.main.composites, 6);
});

test("single peer refreshes every frame even at cadence 20", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  const afterFirst = global.__mpCoopNativeRendererMetrics().renderCount;
  for (let i = 0; i < 6; i++) {
    global.__mpCoopNativeRendererMetrics().cadence = 20;
    global.__mpCoopNativeRendererMetrics().averageRefreshMs = 10;
    global.__mpCoopRemotes.peer.body[0].x = 9 + i;
    h.renderer.render(0.5, true, {});
  }
  const m = global.__mpCoopNativeRendererMetrics();
  assert.equal(
    m.renderCount,
    afterFirst + 6,
    "1v1 P5E every frame regardless of cadence metrics"
  );
});

test("two moving peers both refresh every frame", function () {
  const h = loadHarness();
  global.__mpCoopRemotes = {
    a: remote("a", 1, 4, false),
    b: remote("b", 2, 8, false),
  };
  global.__mpCoopNativeRendererMetrics(); // ensure native wrapped
  h.renderer.render(0.5, true, {});
  global.__mpCoopNativeRendererMetrics().cadence = 20;
  const afterFirst = global.__mpCoopNativeRendererMetrics().renderCount;
  const compositesAfterFirst = h.main.composites;
  for (let i = 0; i < 6; i++) {
    global.__mpCoopNativeRendererMetrics().cadence = 20;
    global.__mpCoopRemotes.a.body[0].x = 5 + i;
    global.__mpCoopRemotes.b.body[0].x = 9 + i;
    h.renderer.render(0.5, true, {});
  }
  const m = global.__mpCoopNativeRendererMetrics();
  assert.equal(
    m.renderCount,
    afterFirst + 12,
    "two peers × six frames → 12 P5E (no budget)"
  );
  assert.equal(
    h.main.composites,
    compositesAfterFirst + 12,
    "two peer layers still composite every frame"
  );
});

test("peer pass uses local lerp progress when finite", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.37, true, {});
  const remoteCalls = h.calls.filter(function (c) {
    return c.remote;
  });
  assert.ok(remoteCalls.length >= 1);
  assert.equal(
    remoteCalls[0].progress,
    0.37,
    "peer origRender must receive wrap progress for mid-tick lerp"
  );
});

test("audited frames stay every-frame via lean path (pose changes included)", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.1, true, {});
  assert.equal(global.__mpCoopNativeRendererMetrics().renderCount, 1);
  for (let i = 0; i < 5; i++) {
    // Pose changes must also stay every-frame once audited (lean pin-swap).
    global.__mpCoopRemotes.peer.body[0].x = 9 + i;
    h.renderer.render(0.2 + i * 0.1, true, {});
  }
  assert.equal(
    global.__mpCoopNativeRendererMetrics().renderCount,
    6,
    "audited frames must P5E every frame without full host snapshots"
  );
});

test("lean frames blit face cache without re-a7 every frame", function () {
  const h = loadHarness();
  const a7Calls = [];
  function makeSheet() {
    const pixels = new Uint8ClampedArray([80, 130, 242, 255]);
    return {
      ka: {
        canvas: { width: 1, height: 1 },
        drawImage: function () {},
        getImageData: function () {
          return {
            data: new Uint8ClampedArray(pixels),
            width: 1,
            height: 1,
          };
        },
        putImageData: function (img) {
          for (let i = 0; i < 4; i++) pixels[i] = img.data[i];
        },
      },
    };
  }
  function host(name) {
    return {
      name: name,
      context: h.main,
      ka: 0,
      oa: makeSheet(),
      Ba: makeSheet(),
    };
  }
  h.renderer.oa = host("oa");
  h.renderer.Aa = host("Aa");
  h.renderer.Ba = host("Ba");
  global.__slotFaceRef = h.renderer;
  h.local.Sc = "#4E7CF6";
  global.__mpFaceTintSc = "#4E7CF6";
  global.__slotA7 = function (faceHost, from, to) {
    a7Calls.push({
      host: faceHost && faceHost.name,
      from: String(from).toUpperCase(),
      to: String(to).toUpperCase(),
    });
  };
  global.MultiplayerColors = {
    getColor: function () {
      return { kind: "solid", primary: "#19D8E6", secondary: "#15B5C1" };
    },
  };
  global.__mpCoopRemotes.peer = Object.assign(remote("peer", 1, 8, false), {
    colorId: 1,
    Sc: "#19D8E6",
    Yc: "#15B5C1",
  });
  h.renderer.render(0.2, true, {});
  const a7AfterFirst = a7Calls.length;
  assert.ok(a7AfterFirst >= 1, "first pass tints peer faces via a7");
  for (let i = 0; i < 5; i++) {
    h.renderer.render(0.3 + i * 0.1, true, {});
  }
  const m = global.__mpCoopNativeRendererMetrics();
  assert.equal(m.renderCount, 6, "still every-frame peer P5E");
  assert.ok(
    a7Calls.length <= a7AfterFirst + 4,
    "lean frames must not a7 every frame (a7=" +
      a7Calls.length +
      " afterFirst=" +
      a7AfterFirst +
      ")"
  );
  assert.ok(
    (m.faceTintCacheBakes | 0) + (m.faceTintBlits | 0) >= 1,
    "face cache bake or blit metrics recorded"
  );
});

test("remoteColorInfo prefers live Sc then stock table then palette", function () {
  delete require.cache[require.resolve(NATIVE)];
  global.window = global;
  const api = require(NATIVE);
  let info = api.remoteColorInfo(
    { Sc: "#AABBCC", Yc: "#112233", colorId: 1 },
    1
  );
  assert.equal(String(info.primary).toUpperCase(), "#AABBCC");
  assert.equal(String(info.secondary).toUpperCase(), "#112233");

  global.__slotSnakeColorTable = [
    ["#4E7CF6", "#17439F"],
    ["#00C8D8", "#00A0B0"],
  ];
  global.MultiplayerColors = {
    getColor: function (id) {
      if (id === 1) {
        return { kind: "solid", primary: "#19D8E6", secondary: "#15B5C1" };
      }
      return null;
    },
    syncFromStockTable: function () {},
  };
  info = api.remoteColorInfo({ colorId: 1 }, 1);
  assert.equal(
    String(info.primary).toUpperCase(),
    "#00C8D8",
    "stock h3E beats static palette when scrape missed Sc"
  );

  delete global.__slotSnakeColorTable;
  info = api.remoteColorInfo({ colorId: 1 }, 1);
  assert.equal(String(info.primary).toUpperCase(), "#19D8E6");
});

test("direct-main native is used only when layer creation passes its budget", function () {
  const h = loadHarness();
  global.document = null;
  global.OffscreenCanvas = null;
  global.__mpCoopNativeDirectBudgetMs = 100;
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  assert.equal(global.__mpCoopNativeRendererMetrics().backend, "direct-main");
  assert.equal(
    h.calls.filter(function (c) { return c.remote; })[0].ctx,
    h.main
  );
  delete global.__mpCoopNativeDirectBudgetMs;
});

test("buildPeerSnake isolates head hosts from local snake", function () {
  delete require.cache[require.resolve(NATIVE)];
  global.window = global;
  global.__mpGame = { ka: { ka: 20 } };
  const api = require(NATIVE);
  const localDc = point(10, 20);
  const localUk = point(1, 2);
  const localUb = [{ x: 1, y: 1 }];
  const localAa = {
    pCa: 0,
    RRa: 0,
    kfa: 1.57,
    l2: 0.8,
    Maa: true,
    RPa: 1,
    zZa: 0,
    sAa: false,
    light: 2,
  };
  const local = {
    ka: [point(5, 5), point(4, 5)],
    wa: [true, true],
    Dc: localDc,
    Jb: point(10, 20),
    Uk: localUk,
    yc: point(0, 0),
    Ya: point(0, 0),
    ub: localUb,
    Aa: localAa,
    Ba: Object.assign({}, localAa, { kfa: 2.1 }),
    Ma: [{ kma: 0, Fcb: point(5, 5), Yoc: false }],
    Ja: 5,
    hb: true,
    Oa: true,
    Ka: 2,
    Lc: 3,
    Sc: "#00f",
    Yc: "#008",
    direction: "RIGHT",
    Ca: "RIGHT",
    Ga: "RIGHT",
  };
  const remote = {
    body: [{ x: 8, y: 3 }, { x: 7, y: 3 }],
    movementDir: "UP",
    Sc: "#0ff",
    Yc: "#088",
  };
  const built = api.buildPeerSnake(
    {},
    local,
    remote,
    remote.body,
    "",
    { metrics: { bufferGrowth: 0 } }
  );
  const peer = built.snake;
  assert.ok(peer.Dc);
  assert.notEqual(peer.Dc, localDc, "Dc must not alias local");
  assert.notEqual(peer.Uk, localUk, "Uk must not alias local");
  assert.notEqual(peer.ub, localUb, "ub (relative wrap) must not alias local");
  assert.notEqual(peer.Aa, localAa, "Aa face host must not alias local");
  assert.ok(
    Math.abs(peer.Aa.kfa - 0) < 1e-9,
    "peer eye look-at seeded from body facing RIGHT"
  );
  assert.equal(peer.Aa.l2, 0, "peer must not inherit local mouth");
  assert.equal(peer.Ma.length, 0, "peer must not inherit local eat particles");
  assert.equal(peer.Ja, 0, "peer must not inherit local poison face");
  assert.equal(peer.hb, false);
  assert.equal(peer.Oa, false);
  assert.equal(peer.Ka, 0);
  assert.equal(peer.Lc, 0);
  // Pixel-space seed: cell=20 → head (8,3) center = (170, 70)
  assert.equal(peer.Dc.x, 170);
  assert.equal(peer.Dc.y, 70);
  // Ya/yc seeded one cell *beyond* the tip (tip=7,3 → beyond=6,3):
  // tipPx=(150,70), beyond=(130,70)
  assert.equal(peer.Ya.x, 130, "Ya past tip along exit");
  assert.equal(peer.Ya.y, 70);
  assert.equal(peer.yc.x, 130);
  assert.equal(peer.yc.y, 70);
  // Facing follows body geometry (RIGHT), movementDir still UP for crawl
  assert.equal(peer.direction, "UP");
  assert.equal(peer.Ca, "RIGHT");
  assert.equal(peer.Ga, "RIGHT");
  peer.Dc.x = 99;
  assert.equal(localDc.x, 10, "mutating peer Dc must not change local");
  assert.equal(peer.Dc.x, 99);
  assert.equal(peer.Dc.y, 70);
  peer.ub.push({ x: 9, y: 9 });
  assert.equal(localUb.length, 1, "mutating peer ub must not change local");
  peer.Aa.kfa = 9;
  assert.equal(localAa.kfa, 1.57, "mutating peer Aa must not change local");
});

test("buildPeerSnake infers Qa for non-adjacent body gaps", function () {
  delete require.cache[require.resolve(NATIVE)];
  global.window = global;
  global.__mpGame = { ka: { ka: 20 } };
  const api = require(NATIVE);
  const local = {
    ka: [point(1, 1), point(0, 1)],
    wa: [true, true],
    direction: "RIGHT",
    Ca: "RIGHT",
    Ga: "RIGHT",
    Sc: "#00f",
    Yc: "#008",
    Dc: point(30, 30),
    Aa: { kfa: 0, l2: 0 },
    Ba: { kfa: 0, l2: 0 },
    ub: [],
    Ma: [],
    Qa: ["LEFT", "LEFT"],
  };
  // Gap between (5,3) and (2,3) → LEFT portal dir at index 0
  const body = [point(5, 3), point(2, 3), point(2, 4)];
  const remote = {
    body: body,
    movementDir: "DOWN",
    headDir: "DOWN",
    Sc: "#0ff",
    Yc: "#088",
  };
  const peer = api.buildPeerSnake(
    {},
    local,
    remote,
    body,
    "",
    { metrics: { bufferGrowth: 0 } }
  ).snake;
  assert.ok(Array.isArray(peer.Qa), "Qa must be an array");
  assert.equal(peer.Qa.length, body.length);
  assert.equal(peer.Qa[0], "LEFT", "gap head→next stores exit dir");
  assert.equal(peer.Qa[1], undefined, "adjacent step stays undefined");
});

test("peer pass recolors shared face sprites to peer Sc then restores", function () {
  const h = loadHarness();
  const a7Calls = [];
  const faceHost = function (name) {
    return { name: name, ka: 0 };
  };
  // Production: __slotFaceRef / wrapped P5E holds oa/Aa/Ba directly.
  h.renderer.oa = faceHost("oa");
  h.renderer.Aa = faceHost("Aa");
  h.renderer.Ba = faceHost("Ba");
  h.renderer.Ga = faceHost("Ga-blink");
  h.renderer.Ja = faceHost("Ja-eat");
  h.renderer.Sa = faceHost("Sa-mouth");
  global.__slotFaceRef = h.renderer;
  h.local.Sc = "#4E7CF6";
  h.renderer.settings.wa = 0;
  // Stale tracker still on stock base while body is claimable Blue — restore
  // must target Sc (#4E7CF6), not the stale #5282F2.
  global.__mpFaceTintSc = "#5282F2";
  global.__slotA7 = function (host, from, to) {
    a7Calls.push({
      host: host.name,
      from: String(from).toUpperCase(),
      to: String(to).toUpperCase(),
    });
  };
  global.MultiplayerColors = {
    getColor: function (id) {
      if (id === 1) {
        return { kind: "solid", primary: "#19D8E6", secondary: "#15B5C1" };
      }
      return null;
    },
  };
  global.__mpCoopRemotes.peer = Object.assign(remote("peer", 1, 8, false), {
    colorId: 1,
    Sc: "#19D8E6",
    Yc: "#15B5C1",
  });
  h.renderer.render(0.5, true, {});
  const toPeer = a7Calls.filter(function (c) {
    return c.to === "#19D8E6";
  });
  const restore = a7Calls.filter(function (c) {
    return c.from === "#19D8E6" && c.to === "#4E7CF6";
  });
  assert.ok(toPeer.length >= 1, "peer face hosts tint to peer Sc");
  assert.ok(
    restore.length >= 1,
    "local face tint restored to body Sc after peer pass"
  );
  const restoreHosts = restore.map(function (c) {
    return c.host;
  });
  assert.ok(
    restoreHosts.indexOf("Ga-blink") >= 0 || toPeer.some(function (c) {
      return c.host === "Ga-blink";
    }),
    "Ga overlay must be in faceSheetHosts tint path"
  );
  assert.ok(
    restoreHosts.indexOf("Ja-eat") >= 0 || toPeer.some(function (c) {
      return c.host === "Ja-eat";
    }),
    "Ja overlay must be in faceSheetHosts tint path"
  );
  assert.equal(String(global.__mpFaceTintSc).toUpperCase(), "#4E7CF6");
  assert.equal(h.main.composites, 1, "peer layer still composites on top");
});

test("buildPeerSnake uses published headDir for face Ca", function () {
  delete require.cache[require.resolve(NATIVE)];
  global.window = global;
  global.__mpGame = { ka: { ka: 20 } };
  const api = require(NATIVE);
  const local = {
    ka: [point(1, 1), point(0, 1)],
    wa: [true, true],
    direction: "RIGHT",
    Ca: "RIGHT",
    Ga: "RIGHT",
    Sc: "#00f",
    Yc: "#008",
    Dc: point(30, 30),
    Aa: { kfa: 0, l2: 0 },
    Ba: { kfa: 0, l2: 0 },
    ub: [],
    Ma: [],
  };
  const remote = {
    body: [{ x: 5, y: 4 }, { x: 5, y: 5 }], // body says UP
    movementDir: "LEFT",
    headDir: "DOWN",
    transitionDir: "DOWN",
    Sc: "#f00",
    Yc: "#800",
    colorId: 2,
  };
  global.MultiplayerColors = {
    getColor: function (id) {
      if (id === 2) return { kind: "solid", primary: "#f00", secondary: "#800" };
      return null;
    },
  };
  const peer = api.buildPeerSnake(
    {},
    local,
    remote,
    remote.body,
    "",
    { metrics: { bufferGrowth: 0 } }
  ).snake;
  assert.equal(peer.direction, "LEFT", "movement follows movementDir");
  assert.equal(peer.Ca, "UP", "face follows body geometry over stale headDir");
  assert.equal(peer.Ga, "DOWN", "transition follows transitionDir");
  assert.equal(peer.Sc, "#f00");
  assert.equal(peer.Yc, "#800");
});

test("renderPeerPass forces tick-complete b so peer head stays at peer cell", function () {
  delete require.cache[require.resolve(NATIVE)];
  global.window = global;
  const calls = [];
  const peerBody = [{ x: 8, y: 3 }, { x: 7, y: 3 }];
  const localDc = point(30, 30); // local head pixels
  const game = {
    ka: { ka: 20 },
    oa: {
      ka: [point(1, 1), point(0, 1)],
      wa: [true, true],
      Dc: localDc,
      Jb: point(30, 30),
      Uk: point(30, 30),
      yc: point(10, 30),
      Ya: point(10, 30),
      ub: [],
      Oa: false,
      Ka: 0,
      Lc: 0,
      Sc: "#0ff",
      Yc: "#088",
      direction: "RIGHT",
      Ca: "RIGHT",
    },
  };
  global.__mpGame = game;
  global.__remixGame = game;
  const api = require(NATIVE);
  const ctx = fakeContext(340, 300);
  const renderer = {
    ka: ctx,
    wb: game,
    render: function (progress, b, c) {
      calls.push({ progress: progress, b: b, c: c, oaDc: game.oa && game.oa.Dc && {
        x: game.oa.Dc.x,
        y: game.oa.Dc.y,
      }});
      // Mimic P5E: when b falsy and dirs differ, lerp toward Dc (bug path)
      if (!b && game.oa && game.oa.direction !== game.oa.Ca && game.oa.Dc) {
        game.oa.Dc.x = localDc.x;
        game.oa.Dc.y = localDc.y;
      }
    },
  };
  const state = {
    metrics: { bufferGrowth: 0, renderCount: 0 },
    audited: true,
  };
  const remotePose = {
    body: peerBody,
    movementDir: "UP",
    headDir: "RIGHT", // intentional mismatch — old path would lerp
    Sc: "#00f",
    Yc: "#008",
    alive: true,
  };
  const built = api.buildPeerSnake({}, game.oa, remotePose, peerBody, "", state);
  assert.equal(built.snake.Dc.x, 170);
  const prev = game.oa;
  game.oa = built.snake;
  renderer.render(0.5, true, null);
  game.oa = prev;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].b, true, "peer pass must force b=true");
  assert.equal(built.snake.Dc.x, 170, "forced b must not drag Dc to local head");
  assert.equal(localDc.x, 30);
});

test("layers peer pass retargets face sheet context onto seat ctx", function () {
  const h = loadHarness();
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  const remoteCalls = h.calls.filter(function (c) {
    return c.remote && c.faceCtx;
  });
  assert.ok(remoteCalls.length >= 1, "expected a remote peer render");
  const seatCtx = h.layers[0];
  assert.ok(seatCtx, "expected a seat layer canvas");
  assert.equal(
    remoteCalls[0].faceCtx,
    seatCtx,
    "face b7.context must be the seat ctx during peer paint (not main)"
  );
  assert.equal(
    remoteCalls[0].ctx,
    seatCtx,
    "renderer.ka must be the seat ctx during peer paint"
  );
  // Restored after the pass
  assert.equal(h.faceEye.context, h.main, "face context restored to main");
  assert.equal(h.faceMouth.context, h.main, "mouth context restored to main");
  const m = global.__mpCoopNativeRendererMetrics();
  assert.ok((m.faceCtxRetargets | 0) >= 1, "metrics should count face retargets");
});

test("deferred face tint restore: one restore per dirty frame not per peer", function () {
  const h = loadHarness();
  let a7Calls = 0;
  global.__slotA7 = function () {
    a7Calls++;
  };
  global.__mpFaceTintSc = "#0000FF";
  h.local.Sc = "#0000FF";
  global.__mpCoopRemotes.p1 = remote("p1", 1, 8, false);
  global.__mpCoopRemotes.p1.Sc = "#FF0000";
  global.__mpCoopRemotes.p2 = remote("p2", 2, 12, false);
  global.__mpCoopRemotes.p2.Sc = "#FF0000";
  // Two remotes same peer tint — swap once, restore once (not 2×2)
  a7Calls = 0;
  h.renderer.render(0.5, true, {});
  const m = global.__mpCoopNativeRendererMetrics();
  assert.ok((m.faceTintSwaps | 0) >= 1, "should tint to peer once");
  assert.equal(
    m.faceTintRestores | 0,
    1,
    "one deferred restore per frame, not per peer pass"
  );
  assert.equal(h.faceEye.context, h.main);
  delete global.__slotA7;
  delete global.__mpFaceTintSc;
});

test("alive peer pass clears local game.nj so peer heads stay alive", function () {
  const h = loadHarness();
  h.game.nj = true;
  h.game.dead = true;
  h.game.isDead = true;
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  const remoteCalls = h.calls.filter(function (c) {
    return c.remote && c.nj != null;
  });
  assert.ok(remoteCalls.length >= 1, "expected peer render");
  assert.equal(
    remoteCalls[0].nj,
    false,
    "alive peer must paint with game.nj cleared"
  );
  assert.equal(h.game.nj, true, "local nj restored after peer pass");
  assert.equal(h.game.dead, true);
  assert.equal(h.game.isDead, true);
});

test("dead peer pass sets game.nj for die face then restores", function () {
  const h = loadHarness();
  h.game.nj = false;
  h.game.dead = false;
  h.game.isDead = false;
  const corpse = remote("peer", 1, 8, false);
  corpse.alive = false;
  global.__mpCoopRemotes.peer = corpse;
  h.renderer.render(0.5, true, {});
  const remoteCalls = h.calls.filter(function (c) {
    return c.remote && c.nj != null;
  });
  assert.ok(remoteCalls.length >= 1, "dead peer still paints natively");
  assert.equal(
    remoteCalls[0].nj,
    true,
    "dead peer must paint with game.nj true (die face)"
  );
  assert.equal(h.game.nj, false, "local nj restored after dead peer pass");
});

test("peer nj allowlist: introducing game.nj on bare host does not audit-fail", function () {
  const h = loadHarness();
  delete h.game.nj;
  delete h.game.dead;
  delete h.game.isDead;
  global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
  h.renderer.render(0.5, true, {});
  const remoteCalls = h.calls.filter(function (c) {
    return c.remote;
  });
  assert.ok(remoteCalls.length >= 1, "peer still paints");
  assert.equal(
    global.__mpCoopNativeRendererMetrics().backend,
    "layers",
    "adding nj during pass must not trip mutation-audit"
  );
  assert.equal("nj" in h.game, false, "absent nj stays absent after restore");
});
