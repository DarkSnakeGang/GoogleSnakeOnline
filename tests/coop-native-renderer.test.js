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
  };
  const main = fakeContext(options.width, options.height);
  const calls = [];
  let throwRemaining = options.throwRemote || 0;
  const renderer = {
    wb: game,
    ka: main,
    settings: { modeKey: options.mode || "classic" },
    render: function (progress, flag, args) {
      const remote = game.oa !== local;
      calls.push({
        remote: remote,
        head: game.oa.ka[0].x,
        bodyRef: game.oa.ka,
        ctx: this.ka,
        progress: progress,
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
  const first = global.__mpCoopNativeRendererMetrics();
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
  assert.ok(mosaic.length >= 2);
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
  const firstBodyRef = h.calls[1].bodyRef;
  h.renderer.render(0.5, true, {});
  const secondRemote = h.calls.filter(function (c) { return c.remote; })[1];
  assert.equal(secondRemote.bodyRef, firstBodyRef, "point buffer array is reused");
  assert.equal(global.__mpCoopNativeRendererMetrics().layerAllocations, 1);
  assert.equal(h.main.composites, 2, "cached layer composites every local frame");
  assert.ok(global.__mpCoopNativeRendererMetrics().bufferGrowth >= first.bufferGrowth);

  h.main.canvas.width = 680;
  h.main.canvas.height = 600;
  h.renderer.render(0.5, true, {});
  const resized = global.__mpCoopNativeRendererMetrics();
  assert.equal(resized.layerAllocations, 2);
  assert.equal(resized.layerReleases, 1);
});

test("adaptive cadence drops to 20 while cached layers still composite", function () {
  const realPerformance = global.performance;
  let tick = 0;
  global.performance = { now: function () { tick += 10; return tick; } };
  try {
    const h = loadHarness();
    global.__mpCoopRemotes.peer = remote("peer", 1, 8, false);
    h.renderer.render(0.5, true, {});
    const refresh = global.__mpCoopNativeRendererMetrics().refreshCount;
    assert.equal(global.__mpCoopNativeRendererMetrics().cadence, 20);
    h.renderer.render(0.5, true, {});
    assert.equal(
      global.__mpCoopNativeRendererMetrics().refreshCount,
      refresh,
      "20fps cadence reuses cached layer on next frame"
    );
    assert.equal(h.main.composites, 2);
  } finally {
    global.performance = realPerformance;
  }
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
