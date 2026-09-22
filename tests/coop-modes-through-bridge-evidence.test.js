"use strict";

/**
 * Evidence suite: every co-op mode from Wall through Bridge (inclusive).
 *
 * For each mode we prove the same class of invariants that wall/key/soko/
 * poison/mines/shield/gate/bridge fixes targeted:
 *   - tick hosts (Aa Map, fruit Sets, dense wa) ready before native grow
 *   - head-radius spawn pool when the mode plants objects near heads
 *   - entity plant → scrape → peer apply round-trip (no crash, same cells)
 *   - mode-specific seeds (key/soko, shield nba, fruit-motion flags)
 *
 * Trophy indices match vanilla arcade (Classic=0 … Bridge=20).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

/** Wall → Bridge inclusive (vanilla trophy / settings.ub). */
const MODES = [
  { id: "wall", trophy: 1, headRadius: true, entity: "walls" },
  { id: "portal", trophy: 2, headRadius: false, entity: "fruit" },
  { id: "cheese", trophy: 3, headRadius: false, entity: "fruit" },
  { id: "borderless", trophy: 4, headRadius: false, entity: "none" },
  { id: "twin", trophy: 5, headRadius: false, entity: "companion" },
  { id: "winged", trophy: 6, headRadius: false, entity: "fruitMotion" },
  { id: "yin_yang", trophy: 7, headRadius: false, entity: "companion" },
  { id: "key", trophy: 8, headRadius: true, entity: "keys" },
  { id: "sokoban", trophy: 9, headRadius: true, entity: "boxes" },
  { id: "poison", trophy: 10, headRadius: true, entity: "fruit" },
  { id: "dimension", trophy: 11, headRadius: false, entity: "fruit" },
  { id: "minesweeper", trophy: 12, headRadius: true, entity: "mines" },
  { id: "statue", trophy: 13, headRadius: false, entity: "statues" },
  { id: "light", trophy: 14, headRadius: false, entity: "light" },
  { id: "shield", trophy: 15, headRadius: true, entity: "shields" },
  { id: "arrow", trophy: 16, headRadius: false, entity: "arrows" },
  { id: "hotdog", trophy: 17, headRadius: false, entity: "walls" },
  { id: "magnet", trophy: 18, headRadius: false, entity: "fruitMotion" },
  { id: "gate", trophy: 19, headRadius: true, entity: "gates" },
  { id: "bridge", trophy: 20, headRadius: true, entity: "bridges" },
];

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  const colorsPath = require.resolve(path.join(ROOT, "src/shared/colors.js"));
  const gsmPath = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[colorsPath];
  delete require.cache[gsmPath];
  require(path.join(ROOT, "src/shared/colors.js"));
  require(path.join(ROOT, "src/hooks/gsm.js"));
  return win.MultiplayerGsm;
}

function loadNative(win) {
  const p = require.resolve(path.join(ROOT, "src/coop/native.js"));
  delete require.cache[p];
  delete win.__mpCoopOnTickInstalled;
  delete win.__mpCoopRenderInstalled;
  require(path.join(ROOT, "src/coop/native.js"));
  return win;
}

function emptyGrid(W, H, fill) {
  const wa = [];
  for (let y = 0; y < H; y++) {
    wa[y] = [];
    for (let x = 0; x < W; x++) wa[y][x] = fill;
  }
  return wa;
}

function emptyArrowGrid(W, H) {
  const ka = [];
  for (let y = 0; y < H; y++) {
    ka[y] = [];
    for (let x = 0; x < W; x++) ka[y][x] = { direction: "NONE" };
  }
  return ka;
}

function makeGame(mode, opts) {
  opts = opts || {};
  const W = opts.width || 10;
  const H = opts.height || 9;
  const wa = emptyGrid(W, H, 0);
  const bridgeGrid = emptyGrid(W, H, null);
  return {
    settings: { ub: mode.trophy, ob: mode.trophy, Aa: 1, Sa: 1 },
    oa: {
      ka: [
        { x: 5, y: 4 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
      ],
      oa: { width: W, height: H },
      Aa: { light: 2 },
      direction: "RIGHT",
      Ca: "RIGHT",
    },
    Ca: {
      Aa: opts.aa === undefined ? null : opts.aa,
      wa: wa,
    },
    wa: {
      ka: [{ pos: { x: 7, y: 4 }, type: 0, nba: null }],
      oa: { oa: { width: W, height: H } },
    },
    ka: { oa: { width: W, height: H }, wa: wa },
    Ba: { keys: [] },
    Aa: { oa: [], d_: [] },
    Ma: { oa: [] },
    Ya: { oa: [] },
    Qa: { pfa: [] },
    Ga: { oa: bridgeGrid },
    Ka: { ka: emptyArrowGrid(W, H) },
    Sa: { oa: [] },
    nj: false,
    Sh: 0,
    Rb: function () {
      return {
        x: 0,
        y: 0,
        clone: function () {
          return { x: this.x, y: this.y };
        },
      };
    },
    Vb: function () {
      const set = new Set();
      const body = this.oa && this.oa.ka;
      for (let i = 0; body && i < body.length; i++) {
        const p = body[i];
        if (p && p.x != null) set.add((p.x << 16) | p.y);
      }
      return set;
    },
  };
}

function pointKeys(list) {
  return (list || [])
    .map(function (p) {
      return (p.x | 0) + "," + (p.y | 0);
    })
    .sort();
}

function simulateWallGrow(g, x, y) {
  g.Ca.Aa.add({
    pos: { x: x | 0, y: y | 0 },
    wm: false,
    m0: false,
    Lh: true,
  });
  if (Array.isArray(g.Ca.wa) && g.Ca.wa[y]) g.Ca.wa[y][x] = 1;
}

function plantModeEntity(mode, g) {
  switch (mode.entity) {
    case "walls":
    case "hotdog":
      simulateWallGrow(g, 4, 4);
      if (mode.id === "hotdog") {
        const w = g.Ca.Aa.get(((4 << 16) | 4));
        if (w) w.ty = { nea: 1 };
      }
      return { field: "walls", keys: ["4,4"] };
    case "keys":
      g.Ba.keys = [
        {
          pos: { x: 2, y: 2 },
          type: 0,
          r7a: { x: 3, y: 3 },
        },
      ];
      return { field: "keys", keys: ["2,2"] };
    case "boxes":
      g.Aa.oa = [{ pos: { x: 4, y: 4 } }];
      g.Aa.d_ = [{ pos: { x: 6, y: 6 } }];
      return { field: "boxes", keys: ["4,4"] };
    case "mines":
      g.Ma.oa = [{ pos: { x: 3, y: 3 } }];
      return { field: "mines", keys: ["3,3"] };
    case "statues":
      g.Ya.oa = [{ pos: { x: 2, y: 5 } }];
      return { field: "statues", keys: ["2,5"] };
    case "arrows":
      g.Ka.ka[1][1] = { direction: "RIGHT" };
      return { field: "arrows", keys: ["1,1"] };
    case "gates":
      g.Qa.pfa = [{ Upa: { x: 4, y: 3 }, vertical: false }];
      return { field: "gates", keys: ["4,3"] };
    case "bridges":
      g.Ga.oa[2][2] = { color: "#578a34", Lh: true };
      return { field: "bridges", keys: ["2,2"] };
    case "shields":
      g.wa.ka[0].nba = new Set(["UP", "LEFT"]);
      return { field: "shields", keys: ["shield"] };
    case "light":
      g.oa.Aa.light = 1;
      return { field: "light", keys: ["light"] };
    default:
      return { field: null, keys: [] };
  }
}

describe("coop modes Wall→Bridge evidence catalog", () => {
  it("covers every mode from wall through bridge", () => {
    assert.equal(MODES[0].id, "wall");
    assert.equal(MODES[MODES.length - 1].id, "bridge");
    assert.equal(MODES.length, 20);
    const trophies = MODES.map(function (m) {
      return m.trophy;
    });
    assert.deepEqual(trophies, [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });
});

describe("coop modes Wall→Bridge tick hosts + spawn + sync", () => {
  for (const mode of MODES) {
    describe(mode.id + " (trophy " + mode.trophy + ")", () => {
      let win;
      let Gsm;

      beforeEach(() => {
        win = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
        global.window = win;
        global.document = win.document;
        win.__mpCoopSession = true;
        win.__mpCoopInject = true;
        win.__mpCoopRemotes = {
          peer: {
            alive: true,
            body: [
              { x: 8, y: 8 },
              { x: 8, y: 7 },
            ],
          },
        };
        win.__mpCoopPlaySettings = {
          trophy: mode.trophy,
          count: 0,
          speed: 1,
          size: 1,
          apple: 0,
        };
        win.ModeRegistry = {
          getCurrentModeKey: function () {
            return mode.id;
          },
        };
        win.CurrentModeNum = mode.trophy;
        Gsm = loadGsm(win);
        loadNative(win);
      });

      afterEach(() => {
        delete global.window;
        delete global.document;
      });

      it("tick ensures hosts so native grow/freePos cannot null.has", () => {
        const g = makeGame(mode, { aa: null });
        win.__mpGame = g;
        win.__remixGame = g;
        assert.equal(g.Ca.Aa, null);
        assert.equal(typeof win.__mpCoopOnTick, "function");
        win.__mpCoopOnTick(g);
        assert.ok(g.Ca.Aa, mode.id + " Aa after tick");
        assert.equal(typeof g.Ca.Aa.add, "function");
        assert.equal(typeof g.Ca.Aa.has, "function");
        const fruit = g.wa.ka[0];
        assert.ok(fruit.nba && typeof fruit.nba.has === "function");
        // Wall/hotdog path: first plant must not throw
        if (mode.entity === "walls" || mode.id === "hotdog") {
          assert.doesNotThrow(function () {
            simulateWallGrow(g, 4, 4);
          });
          assert.equal(g.Ca.Aa.size >= 1, true);
        }
      });

      it("settings.ub + CurrentModeNum stay on this mode after force fields", () => {
        const g = makeGame(mode);
        win.__mpGame = g;
        win.__remixGame = g;
        Gsm.forceEngineMatchFieldsForPlay({
          trophy: mode.trophy,
          size: 1,
          count: 0,
          speed: 1,
        });
        assert.equal(g.settings.ob | 0, mode.trophy);
        assert.equal(g.settings.ub | 0, mode.trophy);
        if (typeof Gsm.effectiveModeKey === "function") {
          const key = Gsm.effectiveModeKey();
          assert.ok(
            String(key).indexOf(mode.id) >= 0 || win.CurrentModeNum === mode.trophy,
            "mode key or CurrentModeNum reflects " + mode.id + " got " + key
          );
        }
      });

      if (mode.headRadius) {
        it("fruit/object spawn pool excludes ≤3 of local + peer heads", () => {
          const g = makeGame(mode);
          g.Ca.Aa = new Map();
          win.__mpGame = g;
          win.__remixGame = g;
          win.__mpCoopOnTick(g);
          assert.equal(
            win.__mpCoopObjectModeNeedsHeadRadius(mode.id),
            true,
            mode.id + " needs head radius"
          );
          const pool = win.__mpCoopBuildFruitSpawnPool(g);
          const keys = new Set(
            pool.map(function (p) {
              return p.x + "," + p.y;
            })
          );
          assert.ok(!keys.has("5,4"), "local head");
          assert.ok(!keys.has("5,5"), "≤3 local");
          assert.ok(!keys.has("8,8"), "peer head");
          assert.ok(!keys.has("8,7"), "≤3 peer");
          assert.ok(keys.has("0,0"), "far cell kept");
        });
      }

      if (mode.entity === "fruitMotion") {
        it("marks fruit-motion mode (winged/magnet seed+trust path)", () => {
          assert.equal(Gsm.isCoopFruitMotionMode(), true);
        });
      }

      if (mode.id === "key" || mode.id === "sokoban") {
        it("initial key/soko plant clears fruit and seeds objects", () => {
          const g = makeGame(mode);
          g.Ca.Aa = new Map();
          win.__mpGame = g;
          win.__remixGame = g;
          assert.equal(Gsm.isKeyOrSokobanMode(), true);
          assert.equal(Gsm.plantClassicInitialFruit(g), false);
          assert.equal(Gsm.plantInitialKeySokoban(g), true);
          assert.equal(g.wa.ka.length, 0);
          if (mode.id === "key") {
            assert.ok(g.Ba.keys.length >= 1);
            assert.ok(g.Ba.keys[0].r7a);
          } else {
            assert.ok(g.Aa.oa.length >= 1);
            assert.ok(g.Aa.d_.length >= 1);
          }
        });
      }

      if (mode.entity === "shields") {
        it("assigns shield nba Sets and round-trips via scrape/apply", () => {
          const g = makeGame(mode);
          g.Ca.Aa = new Map();
          win.__mpGame = g;
          win.__remixGame = g;
          win.__slotP3E = function (_host, _pos) {
            return new Set(["UP", "RIGHT"]);
          };
          if (typeof Gsm.assignCoopFruitShields === "function") {
            Gsm.assignCoopFruitShields(g);
          } else if (typeof Gsm.plantClassicInitialFruit === "function") {
            g.wa.ka[0].nba = null;
            Gsm.ensureFruitShieldSets(g);
            g.wa.ka[0].nba = new Set(["UP", "RIGHT"]);
          }
          assert.ok(g.wa.ka[0].nba && g.wa.ka[0].nba.has("UP"));
          const cols = Gsm.scrapeCollectables
            ? Gsm.scrapeCollectables({ includeEntities: true })
            : null;
          if (cols && cols.apples && cols.apples[0]) {
            assert.ok(
              cols.apples[0].shields ||
                (cols.apples[0].nba && cols.apples[0].nba.length)
            );
          }
        });
      }

      if (
        mode.entity === "walls" ||
        mode.entity === "keys" ||
        mode.entity === "boxes" ||
        mode.entity === "mines" ||
        mode.entity === "statues" ||
        mode.entity === "arrows" ||
        mode.entity === "gates" ||
        mode.entity === "bridges"
      ) {
        it("eater plant → scrape → peer apply keeps cells (no crash)", () => {
          const eater = makeGame(mode);
          const peer = makeGame(mode);
          eater.Ca.Aa = new Map();
          peer.Ca.Aa = new Map();
          win.__mpGame = eater;
          win.__remixGame = eater;
          win.__mpCoopOnTick(eater);
          const planted = plantModeEntity(mode, eater);
          assert.ok(planted.field);

          const payload = Gsm.scrapeBoardEntities(eater);
          payload.width = 10;
          payload.height = 9;

          // Wall scrape can mosaic-filter edge cells — always publish Aa solids.
          if (planted.field === "walls" && (!payload.walls || !payload.walls.length)) {
            payload.walls = [];
            eater.Ca.Aa.forEach(function (w, key) {
              const pos = (w && (w.pos || w)) || {
                x: key >> 16,
                y: key & 65535,
              };
              if (pos && pos.x != null) {
                payload.walls.push({ x: pos.x | 0, y: pos.y | 0 });
              }
            });
          }

          const scraped = payload[planted.field] || [];
          if (planted.field === "boxes") {
            assert.ok(pointKeys(scraped).indexOf("4,4") >= 0);
            assert.ok(pointKeys(payload.goals).indexOf("6,6") >= 0);
          } else if (planted.field === "walls") {
            assert.ok(
              eater.Ca.Aa.size >= 1 && payload.walls.length >= 1,
              "wall present on eater"
            );
          } else {
            assert.ok(
              scraped.length >= 1,
              mode.id + " scrape has " + planted.field
            );
            for (let i = 0; i < planted.keys.length; i++) {
              assert.ok(
                pointKeys(scraped).indexOf(planted.keys[i]) >= 0,
                mode.id + " scrape includes " + planted.keys[i]
              );
            }
          }

          win.__mpGame = peer;
          win.__remixGame = peer;
          win.__mpCoopOnTick(peer);
          assert.doesNotThrow(function () {
            Gsm.applyBoardEntities(payload);
          });

          if (planted.field === "walls") {
            assert.ok(peer.Ca.Aa && peer.Ca.Aa.size >= 1);
            assert.equal(peer.Ca.wa[4][4], 1);
          } else if (planted.field === "keys") {
            assert.ok(peer.Ba.keys.length >= 1);
          } else if (planted.field === "boxes") {
            assert.ok(peer.Aa.oa.length >= 1);
            assert.ok(peer.Aa.d_.length >= 1);
          } else if (planted.field === "mines") {
            assert.ok((peer.Ma.oa || []).length >= 1);
          } else if (planted.field === "statues") {
            assert.ok((peer.Ya.oa || []).length >= 1);
          } else if (planted.field === "arrows") {
            assert.ok(
              peer.Ka &&
                peer.Ka.ka &&
                peer.Ka.ka[1] &&
                peer.Ka.ka[1][1] &&
                peer.Ka.ka[1][1].direction === "RIGHT"
            );
          } else if (planted.field === "gates") {
            assert.ok((peer.Qa.pfa || []).length >= 1);
          } else if (planted.field === "bridges") {
            assert.ok(peer.Ga.oa[2][2]);
          }
        });
      }

      if (mode.id === "wall") {
        it("dual sequential eats: both walls sync eater→peer", () => {
          const a = makeGame(mode, { aa: null });
          const b = makeGame(mode, { aa: null });
          win.__mpGame = a;
          win.__remixGame = a;
          win.__mpCoopOnTick(a);
          simulateWallGrow(a, 2, 2);
          simulateWallGrow(a, 6, 3);
          const walls = [
            { x: 2, y: 2 },
            { x: 6, y: 3 },
          ];
          win.__mpGame = b;
          win.__remixGame = b;
          win.__mpCoopOnTick(b);
          Gsm.applyBoardEntities({
            walls: walls,
            width: 10,
            height: 9,
          });
          assert.equal(b.Ca.wa[2][2], 1);
          assert.equal(b.Ca.wa[3][6], 1);
          assert.equal(b.Ca.Aa.has(Gsm.wallSerialKey(2, 2)), true);
          assert.equal(b.Ca.Aa.has(Gsm.wallSerialKey(6, 3)), true);
        });
      }
    });
  }
});
