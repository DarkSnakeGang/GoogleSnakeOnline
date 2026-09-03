"use strict";

/**
 * GSM-like DOM + game object harness for hook-dependent paths.
 * Does not need live googlesnakemods.com — mocks Remix/Pudding APIs.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

function loadGsm(win) {
  global.window = win;
  global.document = win.document;
  global.HTMLElement = win.HTMLElement;
  global.KeyboardEvent = win.KeyboardEvent;
  // Clear cached module so it binds to this window
  const modPath = require.resolve(path.join(ROOT, "src/hooks/gsm.js"));
  delete require.cache[modPath];
  const colorsPath = require.resolve(path.join(ROOT, "src/shared/colors.js"));
  delete require.cache[colorsPath];
  require(path.join(ROOT, "src/shared/colors.js"));
  return require(path.join(ROOT, "src/hooks/gsm.js"));
}

function makeDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="trophy"><div class="a"></div><div class="tuJOWd"></div><div class="a"></div></div>
    <div id="count"><div class="tuJOWd"></div><div class="b"></div></div>
    <div id="speed"><div class="c"></div><div class="tuJOWd"></div></div>
    <div id="size"><div class="tuJOWd"></div></div>
    <div id="color"><div></div><div></div><div class="tuJOWd"></div></div>
    <div id="apple"><div class="tuJOWd"></div><div></div></div>
    <div id="graphics"><div class="tuJOWd"></div><div></div></div>
    <div id="theme"><div class="tuJOWd"></div><div></div></div>
    <button jsname="NSjDf" aria-label="Play">Play</button>
    <button jsname="JwM0Ie" aria-label="Fullscreen">FS</button>
    <div jsname="iyH4Cb"></div>
    <canvas class="nEoGkc" width="400" height="400"></canvas>
  </body></html>`, { url: "https://googlesnakemods.com/v/current" });
  return dom.window;
}

describe("GSM hook harness", () => {
  let win;
  let Gsm;
  let selects;

  beforeEach(() => {
    win = makeDom();
    selects = [];
    win.puddingMenuSelect = function (id, index) {
      selects.push({ id, index });
      return true;
    };
    win.readGameSettingIndex = function (id) {
      const row = win.document.getElementById(id);
      if (!row) return 0;
      for (let i = 0; i < row.children.length; i++) {
        if ((row.children[i].className || "").includes("tuJOWd")) return i;
      }
      return 0;
    };
    win.pauseGame = 0;
    win.__remixGame = {
      Sh: 7,
      nj: false,
      oa: {
        ka: [
          { x: 3, y: 4 },
          { x: 2, y: 4 },
        ],
        direction: "RIGHT",
        Ta: 2,
      },
      wa: {
        ka: [{ pos: { x: 8, y: 9 }, type: 0 }],
        oa: { oa: { width: 17, height: 15 } },
      },
    };
    win.timeKeeper = {
      getCurrentSetting: function (id) {
        return win.readGameSettingIndex(id);
      },
      start: function () {},
      gotApple: function () {},
      gotAll: function () {},
      death: function () {},
    };
    Gsm = loadGsm(win);
  });

  it("snapshots and applies settings via puddingMenuSelect", () => {
    const snap = Gsm.snapshotSettings();
    assert.equal(snap.trophy, 1);
    assert.equal(snap.speed, 1);
    selects = [];
    Gsm.applySettings({ trophy: 2, count: 0, speed: 0, size: 0 });
    assert.ok(selects.some((s) => s.id === "trophy" && s.index === 2));
    assert.ok(selects.some((s) => s.id === "speed" && s.index === 0));
  });

  it("scrapes board from __remixGame Chess-shaped fields", () => {
    const board = Gsm.scrapeBoard();
    assert.ok(board);
    assert.equal(board.body.length, 2);
    assert.equal(board.body[0].x, 3);
    assert.equal(board.apples[0].x, 8);
    assert.equal(board.score, 7);
    assert.equal(board.alive, true);
    assert.equal(board.width, 17);
  });

  it("scrapeBoard includes themeColors and colorId", () => {
    win.themes = [
      {
        name: "PlayerTheme",
        light_tiles: "#aabbcc",
        dark_tiles: "#112233",
        border: "#445566",
      },
    ];
    // theme menu index 0 selected in DOM
    const board = Gsm.scrapeBoard({ colorId: 35 });
    assert.ok(board);
    assert.equal(board.themeIndex, 0);
    assert.ok(board.themeColors);
    assert.equal(board.themeColors.light, "#aabbcc");
    assert.equal(board.themeColors.dark, "#112233");
    assert.equal(board.colorId, 35);
  });

  it("drawBoardOnCanvas prefers board.themeColors over spectator local theme", () => {
    win.themes = [
      {
        name: "Local",
        light_tiles: "#000001",
        dark_tiles: "#000002",
        border: "#000003",
      },
    ];
    const fills = [];
    const canvas = {
      width: 20,
      height: 20,
      getContext: function () {
        return {
          fillStyle: "",
          fillRect: function () {
            fills.push(this.fillStyle);
          },
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    Gsm.drawBoardOnCanvas(
      canvas,
      {
        width: 2,
        height: 2,
        body: [],
        apples: [],
        themeColors: {
          light: "#ffaaaa",
          dark: "#ffbbbb",
          border: "#ffcccc",
          apple: "#e7471d",
        },
      },
      null
    );
    assert.ok(fills.includes("#ffcccc"), "border from player theme");
    assert.ok(fills.includes("#ffaaaa"), "light from player theme");
    assert.ok(fills.includes("#ffbbbb"), "dark from player theme");
    assert.ok(!fills.includes("#000001"), "must not use spectator local light");
  });

  it("applySpectateState injects natively without canvas paint by default", () => {
    selects = [];
    let painted = false;
    let fillCalls = 0;
    const canvas = {
      width: 40,
      height: 40,
      getContext: function () {
        painted = true;
        return {
          fillStyle: "",
          fillRect: function () {
            fillCalls++;
          },
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    win.__remixGame.oa.ka = [];
    const result = Gsm.applySpectateState(
      canvas,
      {
        width: 17,
        height: 15,
        body: [
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        apples: [{ x: 8, y: 8, type: 2 }],
        themeIndex: 0,
        colorId: 0,
        appleIndex: 1,
        sizeIndex: 0,
        dir: "RIGHT",
        themeColors: {
          light: "#111111",
          dark: "#222222",
          border: "#333333",
          apple: "#e7471d",
        },
      },
      { primary: "#4E7CF6", secondary: "#17439F" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.painted, false, "native Focus must not fillRect");
    assert.equal(result.injected, true);
    assert.equal(painted, false);
    assert.equal(fillCalls, 0);
    assert.equal(win.__remixGame.oa.ka.length, 2);
    assert.equal(win.__remixGame.oa.ka[0].x, 1);
    assert.equal(typeof win.__remixGame.oa.ka[0].clone, "function");
    assert.equal(typeof win.__remixGame.oa.ka[1].clone, "function");
    const cloned = win.__remixGame.oa.ka[0].clone();
    assert.equal(cloned.x, 1);
    assert.equal(cloned.y, 1);
    assert.equal(typeof cloned.clone, "function");
    assert.equal(win.__remixGame.oa.direction, "RIGHT");
    assert.ok(selects.some(function (s) { return s.id === "apple"; }));
  });

  it("applySpectateState preserves native segment clone when extending body", () => {
    function NativePt(x, y) {
      this.x = x;
      this.y = y;
    }
    NativePt.prototype.clone = function () {
      return new NativePt(this.x, this.y);
    };
    win.__remixGame.oa.ka = [new NativePt(0, 0)];
    Gsm.applySpectateState(null, {
      body: [
        { x: 3, y: 4 },
        { x: 2, y: 4 },
        { x: 1, y: 4 },
      ],
      dir: "LEFT",
    });
    assert.equal(win.__remixGame.oa.ka.length, 3);
    assert.equal(win.__remixGame.oa.ka[0].x, 3);
    assert.ok(win.__remixGame.oa.ka[0] instanceof NativePt);
    assert.ok(win.__remixGame.oa.ka[1] instanceof NativePt);
    assert.equal(typeof win.__remixGame.oa.ka[2].clone, "function");
    const c2 = win.__remixGame.oa.ka[2].clone();
    assert.equal(c2.x, 1);
    assert.equal(c2.y, 4);
  });

  it("applySpectateState opts.paint true can fillRect for debug/mosaic helpers", () => {
    let painted = false;
    const canvas = {
      width: 40,
      height: 40,
      getContext: function () {
        painted = true;
        return {
          fillStyle: "",
          fillRect: function () {},
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    win.__remixGame.oa.ka = [];
    const result = Gsm.applySpectateState(
      canvas,
      {
        width: 17,
        height: 15,
        body: [{ x: 2, y: 2 }],
        apples: [],
        dir: "LEFT",
      },
      { primary: "#4E7CF6" },
      { paint: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.painted, true);
    assert.equal(result.injected, true);
    assert.equal(painted, true);
    assert.equal(win.__remixGame.oa.ka[0].x, 2);
  });

  it("applySpectateState opts.paint false skips canvas paint", () => {
    let painted = false;
    const canvas = {
      width: 40,
      height: 40,
      getContext: function () {
        painted = true;
        return {
          fillStyle: "",
          fillRect: function () {},
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    win.__remixGame.oa.ka = [];
    const result = Gsm.applySpectateState(
      canvas,
      {
        width: 17,
        height: 15,
        body: [{ x: 2, y: 2 }],
        apples: [],
        dir: "LEFT",
      },
      { primary: "#4E7CF6" },
      { paint: false }
    );
    assert.equal(result.ok, true);
    assert.equal(result.painted, false);
    assert.equal(result.injected, true);
    assert.equal(painted, false);
    assert.equal(win.__remixGame.oa.ka[0].x, 2);
  });

  it("Focus spectate injects into game without painting squares", () => {
    let fillCalls = 0;
    const canvas = win.document.querySelector("canvas.nEoGkc");
    assert.ok(canvas);
    canvas.getContext = function () {
      return {
        fillStyle: "",
        fillRect: function () {
          fillCalls++;
        },
        beginPath: function () {},
        arc: function () {},
        fill: function () {},
      };
    };
    win.__remixGame.oa.ka = [{ x: 0, y: 0 }];
    win.__remixGame.wa.ka = [];
    const board = {
      width: 17,
      height: 15,
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
      apples: [{ x: 10, y: 10, type: 3 }],
      themeColors: {
        light: "#aadc4c",
        dark: "#9ad344",
        border: "#578a34",
        apple: "#e7471d",
      },
      colorId: 0,
      appleIndex: 0,
      sizeIndex: 0,
      dir: "RIGHT",
    };
    const result = Gsm.applySpectateState(canvas, board, {
      primary: "#4E7CF6",
      secondary: "#17439F",
    });
    assert.equal(result.ok, true);
    assert.equal(result.painted, false);
    assert.equal(result.injected, true);
    assert.equal(fillCalls, 0);
    assert.equal(win.__remixGame.oa.ka[0].x, 5);
    assert.equal(win.__remixGame.wa.ka.length, 1);
    assert.equal(win.__remixGame.wa.ka[0].type, 3);
  });

  it("hideControlHelper marks compact absolute overlays", () => {
    const canvas = win.document.querySelector("canvas.nEoGkc");
    const tip = win.document.createElement("div");
    tip.style.cssText =
      "position:absolute;width:100px;height:100px;left:50px;top:120px;";
    canvas.parentElement.appendChild(tip);
    // jsdom getComputedStyle may not return position from style — set via attribute path
    Object.defineProperty(tip, "getBoundingClientRect", {
      value: function () {
        return {
          width: 100,
          height: 100,
          top: 120,
          left: 50,
          right: 150,
          bottom: 220,
        };
      },
    });
    // Force computed style position for jsdom
    const orig = win.getComputedStyle;
    win.getComputedStyle = function (el) {
      if (el === tip) {
        return { position: "absolute" };
      }
      return orig.call(win, el);
    };
    Gsm.hideControlHelper();
    assert.equal(tip.dataset.mpHelperHidden, "1");
    assert.equal(tip.style.visibility, "hidden");
    Gsm.restoreControlHelper();
    assert.equal(tip.dataset.mpHelperHidden, undefined);
    win.getComputedStyle = orig;
  });

  it("hideControlHelper does not touch top-bar HUD strip", () => {
    const shell = win.document.createElement("div");
    shell.className = "EjCLSb";
    const hud = win.document.createElement("div");
    hud.id = "mp-mod-indicator";
    hud.style.cssText = "position:absolute;width:100px;height:40px;";
    Object.defineProperty(hud, "getBoundingClientRect", {
      value: function () {
        return { width: 100, height: 40, top: 10, left: 10, right: 110, bottom: 50 };
      },
    });
    shell.appendChild(hud);
    win.document.body.appendChild(shell);
    const orig = win.getComputedStyle;
    win.getComputedStyle = function (el) {
      if (el === hud) return { position: "absolute" };
      return orig.call(win, el);
    };
    Gsm.hideControlHelper();
    assert.equal(hud.dataset.mpHelperHidden, undefined);
    assert.notEqual(hud.style.visibility, "hidden");
    win.getComputedStyle = orig;
    shell.remove();
  });

  it("emptyLocalSnakeBody clears ka for coop spectator", () => {
    win.__remixGame.oa.ka = [
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const ok = Gsm.emptyLocalSnakeBody();
    assert.equal(ok, true);
    assert.equal(win.__remixGame.oa.ka.length, 0);
  });

  it("parkLocalSnakeOffBoard moves local head off grid", () => {
    win.__remixGame.oa.ka = [{ x: 1, y: 1 }];
    const ok = Gsm.parkLocalSnakeOffBoard();
    assert.equal(ok, true);
    assert.equal(win.__remixGame.oa.ka[0].x, -8);
    assert.equal(win.__mpCoopLocalDead, true);
  });

  it("alterSnakeCode injects __mpGame + board cache", () => {
    const inCode = "}tick(){window.__remixGame=this;var a=this.Aa,b=this.nj;";
    const out = Gsm.alterSnakeCodeExposeGame(inCode);
    assert.ok(out.includes("window.__mpGame=this"));
    assert.ok(out.includes("__mpBoardCache"));
    assert.ok(out.includes("__mpCoopOnTick"));
  });

  it("alterSnakeCode hooks render enter for companions", () => {
    const out = Gsm.alterSnakeCodeExposeGame(
      "render(a,b,c){var d=a;J5E(this,f,d,!1,!1);}"
    );
    assert.ok(out.includes("__mpCoopRenderEnter"));
    assert.ok(out.includes("__mpCoopAfterSnakeRender"));
  });

  it("applyCollectables resizes apple list to match owner", () => {
    win.__remixGame.wa.ka = [
      { pos: { x: 1, y: 1 }, type: 0 },
      { pos: { x: 2, y: 2 }, type: 0 },
      { pos: { x: 3, y: 3 }, type: 0 },
    ];
    const ok = Gsm.applyCollectables({
      apples: [
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ],
    });
    assert.equal(ok, true);
    assert.equal(win.__remixGame.wa.ka.length, 2);
    assert.equal(win.__remixGame.wa.ka[0].pos.x, 5);
    assert.equal(win.__remixGame.wa.ka[1].pos.y, 6);
  });

  it("applyCollectables nudges fruit off co-op snake cells", () => {
    const nativePath = require.resolve(path.join(ROOT, "src/coop/native.js"));
    delete require.cache[nativePath];
    delete win.__mpCoopRenderInstalled;
    delete win.__mpCoopOnTickInstalled;
    require(path.join(ROOT, "src/coop/native.js"));
    const { CoopNative } = win.CoopNative
      ? { CoopNative: win.CoopNative }
      : require(path.join(ROOT, "src/coop/native.js"));
    const cn = new CoopNative();
    cn.sessionActive = true;
    cn.applySnakeDelta({
      clientId: "corpse",
      alive: false,
      body: [
        { x: 5, y: 5 },
        { x: 4, y: 5 },
      ],
    });
    win.__multiplayerApp = { coopNative: cn };
    win.__mpCoopSession = true;
    win.__mpCoopInject = true;
    win.__remixGame.wa.ka = [{ pos: { x: 0, y: 0 }, type: 0 }];

    const ok = Gsm.applyCollectables({
      apples: [{ x: 5, y: 5, type: 1 }],
    });
    assert.equal(ok, true);
    const pos = win.__remixGame.wa.ka[0].pos;
    assert.notEqual(pos.x + "," + pos.y, "5,5");
    assert.equal(cn.isOccupied(pos.x, pos.y), false);

    win.__mpCoopSession = false;
    win.__mpCoopInject = false;
    delete win.__multiplayerApp;
  });

  it("applyCoopSpawnOffset writes centered body with oy", () => {
    win.__remixGame.oa.ka = [{ x: 0, y: 0 }];
    win.__remixGame.oa.direction = "UP";
    const ok = Gsm.applyCoopSpawnOffset(2);
    assert.equal(ok, true);
    assert.equal(win.__remixGame.oa.ka.length, 3);
    assert.equal(win.__remixGame.oa.ka[0].y, Math.floor(15 / 2) + 2);
    assert.equal(win.__remixGame.oa.ka[0].x, Math.floor(17 / 2));
    // Must not force RIGHT — Start match should leave snakes idle until a key
    assert.equal(win.__remixGame.oa.direction, "UP");
  });

  it("locks menus for non-admin sync", () => {
    Gsm.setNativeMenusLocked(true);
    const trophy = win.document.getElementById("trophy");
    assert.equal(trophy.style.pointerEvents, "none");
    assert.equal(trophy.title, "Synced from admin");
    const play = Gsm.playButton();
    assert.equal(play.style.pointerEvents, "none");
    assert.match(play.title, /Start match/i);
    // Cosmetics stay clickable
    ["color", "apple", "graphics", "theme"].forEach((id) => {
      const row = win.document.getElementById(id);
      assert.ok(row, id);
      assert.equal(row.style.pointerEvents, "");
      assert.equal(row.title, "");
    });
    Gsm.setNativeMenusLocked(false);
    assert.equal(trophy.style.pointerEvents, "");
    Gsm.setPlayButtonLocked(true);
    assert.equal(play.style.pointerEvents, "none");
    Gsm.setPlayButtonLocked(false);
    assert.equal(play.style.pointerEvents, "");
  });

  it("unlockPersonalMenus clears sticky helper-hide on cosmetics", () => {
    const theme = win.document.getElementById("theme");
    theme.style.pointerEvents = "none";
    theme.style.visibility = "hidden";
    theme.dataset.mpHelperHidden = "1";
    Gsm.unlockPersonalMenus();
    assert.equal(theme.style.pointerEvents, "");
    assert.equal(theme.style.visibility, "");
    assert.equal(theme.dataset.mpHelperHidden, undefined);
  });

  it("drawBoardOnCanvas uses theme tile colors when present", () => {
    win.themes = [
      {
        name: "Test",
        light_tiles: "#111111",
        dark_tiles: "#222222",
        border: "#333333",
      },
    ];
    win.readGameSettingIndex = () => 0;
    const canvas = {
      width: 34,
      height: 30,
      getContext: function () {
        return {
          fillStyle: "",
          fillRect: function () {},
          beginPath: function () {},
          arc: function () {},
          fill: function () {},
        };
      },
    };
    Gsm.drawBoardOnCanvas(
      canvas,
      { width: 2, height: 2, body: [{ x: 0, y: 0 }], apples: [] },
      { primary: "#ff0000", secondary: "#00ff00" }
    );
    const theme = Gsm.getBoardThemeColors();
    assert.equal(theme.light, "#111111");
    assert.equal(theme.dark, "#222222");
  });

  it("SETTINGS_SYNC ignores personal cosmetics", () => {
    win.puddingMenuSelect = function (id, index) {
      win.__applied = win.__applied || [];
      win.__applied.push([id, index]);
      return true;
    };
    win.__applied = [];
    // Use values that differ from DOM selection (trophy=1, count=0) so apply runs
    Gsm.applySettings({
      trophy: 2,
      count: 1,
      apple: 3,
      graphics: 1,
      theme: 2,
      color: 5,
    });
    const keys = win.__applied.map((x) => x[0]);
    assert.ok(keys.includes("trophy"));
    assert.ok(keys.includes("count"));
    assert.ok(!keys.includes("apple"));
    assert.ok(!keys.includes("graphics"));
    assert.ok(!keys.includes("theme"));
    assert.ok(!keys.includes("color"));
    const sync = Gsm.snapshotSyncSettings();
    assert.equal(sync.apple, undefined);
    assert.equal(sync.color, undefined);
    assert.equal(sync.graphics, undefined);
    assert.equal(sync.theme, undefined);
  });

  it("lobby SETTINGS_SYNC prefers quiet apply without opening panel", () => {
    win.__opened = 0;
    win._openSnakeSettingsPanel = function () {
      win.__opened += 1;
      return true;
    };
    win.puddingMenuSelect = function () {
      return true;
    };
    win.__mpStartingMatch = false;
    win.__mpCoopSession = false;
    Gsm.applySettings({ trophy: 2, count: 1, speed: 0, size: 1 });
    assert.equal(win.__opened, 0, "should not open settings for lobby sync when API works");
  });

  it("SETTINGS_SYNC during match start does not open settings panel", () => {
    let opened = 0;
    win._openSnakeSettingsPanel = function () {
      opened++;
    };
    win.__mpStartingMatch = true;
    win.puddingMenuSelect = function () {
      return false;
    };
    Gsm.applySettings({ trophy: 2, size: 1 });
    assert.equal(opened, 0);
    win.__mpStartingMatch = false;
  });

  it("SETTINGS_SYNC delayed open aborts once Start match begins", async () => {
    let opened = 0;
    win._openSnakeSettingsPanel = function () {
      opened++;
      return true;
    };
    win.puddingMenuSelect = function () {
      return false;
    };
    win.__mpStartingMatch = false;
    Gsm.applySettings({ trophy: 2, size: 1 });
    assert.ok(opened >= 1);
    // Simulate SESSION_START arriving before delayed retries fire
    win.__mpStartingMatch = true;
    win.__mpApplySettingsGen = (win.__mpApplySettingsGen || 0) + 1;
    const before = opened;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(opened, before);
    win.__mpStartingMatch = false;
  });

  it("closeSettingsPanel calls Remix close helper", () => {
    let closed = 0;
    win._closeSnakeSettingsPanel = function () {
      closed++;
      return true;
    };
    assert.equal(Gsm.closeSettingsPanel(), true);
    assert.equal(closed, 1);
  });

  it("isNativeRunLive is false for leftover dead GameInstance on endscreen", () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "visible";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: true };
    win.__remixGame.nj = false;
    // oa still present after death — old Start match logic treated this as ready
    assert.ok(win.__remixGame.oa);
    assert.equal(Gsm.isNativeRunLive(), false);
    assert.equal(Gsm.isDeathOverlayVisible(), true);

    win.timeKeeper._dead = false;
    overlay.style.visibility = "hidden";
    assert.equal(Gsm.isNativeRunLive(), true);
    overlay.remove();
  });

  it("startNativeRun dismisses sticky showDeathScreen inline styles", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    win.document.body.appendChild(overlay);
    // Old prepareNativePlay path forced these — Play cannot clear them
    Gsm.showDeathScreen({ skipEscapeDispatch: true });
    assert.equal(overlay.style.visibility, "visible");
    win.timeKeeper = { _dead: true, start: function () { this._dead = false; } };
    win.__mpGame = win.__remixGame;

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
      win.timeKeeper._dead = false;
    };

    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 12,
        intervalMs: 5,
        onDone: resolve,
      });
    });
    assert.equal(ok, true);
    assert.ok(clicks >= 1);
    assert.equal(Gsm.isDeathOverlayVisible(), false);
    assert.equal(Gsm.isNativeRunLive(), true);
    overlay.remove();
  });

  it("startNativeRun keeps clicking Play until endscreen clears", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "visible";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: true };
    win.__mpGame = win.__remixGame;

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
      // First click alone is not enough (settings/death race); succeed on 3rd
      if (clicks >= 3) {
        win.timeKeeper._dead = false;
        overlay.style.visibility = "hidden";
      }
    };

    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 10,
        intervalMs: 5,
        onDone: resolve,
      });
    });
    assert.equal(ok, true);
    assert.ok(clicks >= 3);
    assert.equal(Gsm.isNativeRunLive(), true);
    assert.equal(Gsm.isDeathOverlayVisible(), false);
    overlay.remove();
  });

  it("startNativeRun does not stop early just because GameInstance.oa exists", async () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    overlay.style.visibility = "visible";
    win.document.body.appendChild(overlay);
    win.timeKeeper = { _dead: true };
    assert.ok(win.__remixGame.oa);

    let clicks = 0;
    Gsm.playButton().onclick = function () {
      clicks++;
    };

    const ok = await new Promise(function (resolve) {
      Gsm.startNativeRun({
        maxAttempts: 4,
        intervalMs: 5,
        onDone: resolve,
      });
    });
    assert.equal(ok, false);
    assert.ok(clicks >= 4, "must retry Play while still on endscreen");
    assert.equal(Gsm.isNativeRunLive(), false);
    overlay.remove();
  });

  it("pauses local game for coop authority", () => {
    // Native co-op no longer pauses/hides the board; helper is a no-op clear path
    Gsm.setLocalPaused(true);
    assert.equal(!!win.pauseGame, true);
    Gsm.setLocalPaused(false);
    assert.equal(!!win.pauseGame, false);
  });

  it("showDeathScreen clears pause and reveals overlay", () => {
    const overlay = win.document.createElement("div");
    overlay.className = "wjOYOd";
    const menu = win.document.createElement("div");
    overlay.appendChild(menu);
    win.document.body.appendChild(overlay);
    Gsm.setLocalPaused(true);
    overlay.style.visibility = "hidden";
    menu.style.visibility = "hidden";
    Gsm.showDeathScreen({ skipEscapeDispatch: true });
    assert.equal(!!win.pauseGame, false);
    assert.equal(overlay.style.visibility, "visible");
    assert.equal(menu.style.visibility, "visible");
    overlay.remove();
  });

  it("triggerPlay clicks NSjDf", () => {
    let clicked = false;
    Gsm.playButton().onclick = function () {
      clicked = true;
    };
    assert.equal(Gsm.triggerPlay(), true);
    assert.equal(clicked, true);
  });

  it("wrapTimeKeeper pulses apple/death", () => {
    const events = [];
    Gsm.wrapTimeKeeper({
      onApple: (t, s) => events.push(["apple", t, s]),
      onDeath: (t, s) => events.push(["death", t, s]),
    });
    win.timeKeeper.gotApple(1200, 3);
    win.timeKeeper.death(1500, 3);
    assert.deepEqual(events[0], ["apple", 1200, 3]);
    assert.deepEqual(events[1], ["death", 1500, 3]);
    assert.equal(win.timeKeeper._dead, true);
  });

  it("drawCoopSnapshot renders corpses faded", () => {
    const canvas = win.document.createElement("canvas");
    canvas.width = 170;
    canvas.height = 150;
    const ops = [];
    canvas.getContext = function () {
      return {
        fillStyle: "",
        globalAlpha: 1,
        fillRect: () => ops.push("r"),
        beginPath: () => {},
        arc: () => {},
        fill: () => ops.push("f"),
      };
    };
    Gsm.drawCoopSnapshot(canvas, {
      width: 17,
      height: 15,
      apple: { x: 1, y: 1 },
      snakes: [
        {
          client_id: "a",
          color_id: 0,
          alive: false,
          body: [
            { x: 4, y: 4 },
            { x: 3, y: 4 },
          ],
        },
        {
          client_id: "b",
          color_id: 35,
          alive: true,
          body: [{ x: 8, y: 8 }],
        },
      ],
    });
    assert.ok(ops.length > 0);
  });
});

describe("mosaic / focus versus state", () => {
  it("toggles spectate mode and lists boards", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.onBoardDelta({ clientId: "p1", board: { score: 1, body: [] } });
    v.onBoardDelta({ clientId: "p2", board: { score: 2, body: [] } });
    assert.equal(v.spectateMode, "focus");
    v.setSpectateMode("mosaic");
    assert.equal(v.spectateMode, "mosaic");
    assert.equal(v.playerIdsWithBoards().length, 2);
  });

  it("stores player themeColors on board delta", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.onBoardDelta({
      clientId: "p1",
      board: {
        score: 1,
        body: [],
        themeColors: { light: "#aaa", dark: "#bbb", border: "#ccc" },
        colorId: 35,
      },
    });
    assert.equal(v.boards.p1.themeColors.light, "#aaa");
    assert.equal(v.boards.p1.colorId, 35);
  });

  it("mosaic click path sets focusClientId and focus mode", () => {
    const VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const v = new VersusState();
    v.setSpectateMode("mosaic");
    v.setFocus("p2");
    v.setSpectateMode("focus");
    assert.equal(v.focusClientId, "p2");
    assert.equal(v.spectateMode, "focus");
  });
});

describe("Multiplayer settings tab layout", () => {
  it("mounts as own top tab with Connect/Match/Roster sub-tabs", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function (id) {
      win.document.querySelectorAll(".ultra-settings-page").forEach(function (p) {
        p.classList.toggle(
          "ultra-page-on",
          p.id === "ultra-settings-page-" + id
        );
      });
    };
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const ui = new UI({ client: null, versus: { spectateMode: "focus" } });
    ui.mountSettingsTab();

    const tab = win.document.getElementById("ultra-settings-tab-multiplayer");
    const page = win.document.getElementById("ultra-settings-page-multiplayer");
    const pager = win.document.getElementById("ultra-settings-pager");
    assert.ok(tab);
    assert.ok(page);
    assert.equal(page.parentElement.id, "settings-popup-pudding");
    assert.equal(
      win.document.querySelector("#settings-popup-pudding > span").textContent,
      "Settings"
    );
    assert.ok(pager.classList.contains("ultra-pager-grid"));
    assert.equal(win.document.getElementById("mp-subpager").children.length, 3);
    assert.ok(win.document.getElementById("mp-panel-connect"));
    assert.ok(win.document.getElementById("mp-panel-match"));
    assert.ok(win.document.getElementById("mp-panel-roster"));
    assert.equal(win.document.getElementById("mp-panel-spectate"), null);
    assert.ok(win.document.getElementById("mp-roster-spectate-bar"));
    assert.ok(win.document.getElementById("mp-mosaic-toggle"));
    assert.ok(
      win.document.getElementById("mp-panel-connect").classList.contains("mp-panel-on")
    );
    // Setup must not contain multiplayer host
    assert.equal(
      win.document.querySelector("#ultra-settings-page-setup #mp-settings-host"),
      null
    );
  });

  it("hides Spectate buttons for players and restores them for spectators", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    win.VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;

    let role = "player";
    const app = {
      client: {
        connected: true,
        clientId: "p1",
        isAdmin: function () {
          return false;
        },
        me: function () {
          return { clientId: "p1", role: role, ready: true };
        },
        roster: {
          mode: "versus",
          roomCode: "ABCD",
          sessionActive: false,
          clients: [
            { clientId: "admin", role: "player", ready: true },
            { clientId: "p1", role: role, ready: true },
          ],
        },
      },
      versus: { scores: {}, spectateMode: "focus", focusClientId: "admin" },
      focusSpectatePlayer: function (id) {
        this.versus.focusClientId = id;
        this.versus.spectateMode = "focus";
      },
      setSpectateMode: function (mode) {
        this.versus.spectateMode = mode;
      },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();

    function assertSpectateUi(expectSpectator) {
      const bar = win.document.getElementById("mp-roster-spectate-bar");
      const mosaic = win.document.getElementById("mp-mosaic-toggle");
      assert.ok(bar && mosaic);
      assert.equal(bar.style.display, expectSpectator ? "" : "none");
      const nameWatch = win.document.querySelectorAll(
        ".mp-roster-name-watch[data-mp-act=\"focus\"]"
      );
      assert.equal(nameWatch.length, expectSpectator ? 1 : 0);
      // Spectators themselves are never focus targets
      const specRow = win.document.querySelector('[data-mp-row="p1"]');
      if (expectSpectator && specRow) {
        assert.equal(
          specRow.querySelectorAll('[data-mp-act="focus"]').length,
          0,
          "cannot click-spectate a spectator"
        );
      }
    }

    app.client.roster.clients[1].role = "player";
    role = "player";
    ui.renderRoster(app.client.roster);
    assertSpectateUi(false);

    role = "spectator";
    app.client.roster.clients[1].role = "spectator";
    ui.renderRoster(app.client.roster);
    assertSpectateUi(true);
    const watchingRow = win.document.querySelector(
      '.mp-roster-row.mp-roster-watching[data-mp-row="admin"]'
    );
    assert.ok(watchingRow, "focused player should be marked as spectating");
    assert.ok(
      watchingRow.querySelector(".mp-roster-watching-tag"),
      "Spectating tag on name"
    );

    role = "player";
    app.client.roster.clients[1].role = "player";
    ui.renderRoster(app.client.roster);
    assertSpectateUi(false);
  });

  it("hides versus duration in coop and gates End match on sessionActive", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    win.VersusState = require(path.join(ROOT, "src/versus/scoreboard.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const app = {
      client: {
        connected: true,
        clientId: "admin",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return { clientId: "admin", role: "player", ready: true };
        },
        roster: null,
      },
      versus: { scores: {}, spectateMode: "focus" },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();

    const durField = win.document.getElementById("mp-duration-field");
    const goalField = win.document.getElementById("mp-versus-goal-field");
    const endBtn = win.document.getElementById("mp-end");
    assert.ok(durField);
    assert.ok(goalField);
    assert.ok(endBtn);

    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: false,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
      versusGoal: "best50",
    });
    assert.notEqual(durField.style.display, "none");
    assert.notEqual(goalField.style.display, "none");
    assert.equal(endBtn.style.display, "none");
    assert.equal(win.document.getElementById("mp-versus-goal").value, "best50");

    ui.renderRoster({
      mode: "versus",
      roomCode: "ABCD",
      sessionActive: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.notEqual(endBtn.style.display, "none");

    ui.renderRoster({
      mode: "coop",
      roomCode: "ABCD",
      sessionActive: true,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.equal(durField.style.display, "none");
    assert.equal(goalField.style.display, "none");
    assert.notEqual(endBtn.style.display, "none");

    ui.renderRoster({
      mode: "coop",
      roomCode: "ABCD",
      sessionActive: false,
      clients: [{ clientId: "admin", role: "player", ready: true }],
      allowNewRuns: true,
    });
    assert.equal(durField.style.display, "none");
    assert.equal(endBtn.style.display, "none");
  });

  it("adds Settings button left of Details in Speed Info", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="si-personal">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 3px;">
          <span>Speed Info</span>
          <button class="btn" id="time-keeper" jsname="time-keeper">Details</button>
        </div>
      </div>
      <div id="settings-popup-pudding" style="visibility:hidden;display:none;">
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.BootstrapShow = function () {
      const box = win.document.getElementById("settings-popup-pudding");
      box.style.display = "block";
      box.style.visibility = "visible";
      win.bootstrapVisible = true;
    };
    win.remixShowSettingsPage = function (id) {
      win.document.querySelectorAll(".ultra-settings-page").forEach(function (p) {
        p.classList.toggle(
          "ultra-page-on",
          p.id === "ultra-settings-page-" + id
        );
      });
    };
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    const app = {
      client: {
        connected: true,
        me: function () {
          return { role: "spectator" };
        },
      },
      versus: { spectateMode: "focus" },
    };
    app.ui = new UI(app);
    app.ui.mountSettingsTab();

    // Mirror ensureSpeedInfoSettingsButton from mod (unit-level DOM insert)
    const details = win.document.getElementById("time-keeper");
    const headerRow = details.parentElement;
    Array.from(headerRow.children || []).forEach(function (el) {
      if (
        el &&
        el.tagName === "SPAN" &&
        /speed\s*info/i.test((el.textContent || "").trim())
      ) {
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
      }
    });
    const btn = win.document.createElement("button");
    btn.id = "mp-speedinfo-settings";
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Settings";
    const group = win.document.createElement("div");
    group.className = "mp-si-btn-group";
    headerRow.insertBefore(group, details);
    group.appendChild(btn);
    group.appendChild(details);
    btn.addEventListener("click", function () {
      app.ui.openPuddingSettings();
    });

    assert.equal(btn.textContent, "Settings");
    assert.equal(btn.nextElementSibling, details);
    const title = headerRow.querySelector("span");
    assert.ok(title);
    assert.equal(title.style.display, "none");
    btn.click();
    const box = win.document.getElementById("settings-popup-pudding");
    assert.equal(box.style.visibility, "visible");
    assert.ok(
      win.document
        .getElementById("ultra-settings-page-multiplayer")
        .classList.contains("ultra-page-on")
    );
    assert.ok(
      win.document.getElementById("mp-panel-roster").classList.contains("mp-panel-on")
    );
  });

  it("Start match pushes Versus attempt minutes from the textbox", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="settings-popup-pudding">
        <span>Pudding Mod Settings</span>
        <div id="ultra-settings-pager">
          <button type="button" id="ultra-settings-tab-play" class="ultra-settings-tab">Play</button>
          <button type="button" id="ultra-settings-tab-setup" class="ultra-settings-tab">Setup</button>
          <button type="button" id="ultra-settings-tab-custom" class="ultra-settings-tab">Custom</button>
        </div>
        <div id="ultra-settings-page-play" class="ultra-settings-page ultra-page-on"></div>
        <div id="ultra-settings-page-setup" class="ultra-settings-page"></div>
        <div id="ultra-settings-page-custom" class="ultra-settings-page"></div>
      </div>
    </body></html>`);
    const win = dom.window;
    global.window = win;
    global.document = win.document;
    win.button_color = "#1155CC";
    win.remixShowSettingsPage = function () {};
    win.MultiplayerColors = require(path.join(ROOT, "src/shared/colors.js"));
    win.MultiplayerSession = require(path.join(ROOT, "src/session/ready.js"));
    const uiPath = require.resolve(path.join(ROOT, "src/ui/settingsTab.js"));
    delete require.cache[uiPath];
    require(path.join(ROOT, "src/ui/settingsTab.js"));
    const UI = win.MultiplayerUI;
    let durationSent = null;
    let sessionStarted = false;
    let sessionPayload = null;
    const app = {
      client: {
        connected: true,
        clientId: "admin",
        isAdmin: function () {
          return true;
        },
        me: function () {
          return { clientId: "admin", role: "player", ready: true };
        },
        roster: {
          mode: "versus",
          sessionActive: false,
          allowNewRuns: true,
          clients: [
            { clientId: "admin", role: "player", ready: true },
            { clientId: "p2", role: "player", ready: true },
          ],
        },
        allowNewRuns: function () {
          return true;
        },
        setDuration: function (mins) {
          durationSent = mins;
        },
        setVersusGoal: function () {},
        sessionStart: function (payload) {
          sessionStarted = true;
          sessionPayload = payload || {};
        },
      },
      versus: { scores: {}, spectateMode: "focus" },
      syncMySettingsAsAdmin: function () {
        return { trophy: 0, count: 1, speed: 0, size: 0 };
      },
    };
    const ui = new UI(app);
    ui.mountSettingsTab();
    const dur = win.document.getElementById("mp-duration");
    const startBtn = win.document.getElementById("mp-start");
    dur.value = "7";
    ui.renderRoster(app.client.roster);
    startBtn.disabled = false;
    startBtn.click();
    assert.equal(durationSent, 7);
    assert.equal(sessionStarted, true);
    assert.ok(sessionPayload && sessionPayload.settings);
    assert.equal(sessionPayload.settings.count, 1);
  });
});

describe("spectator / admin menu access", () => {
  function loadApp(win) {
    global.window = win;
    global.document = win.document;
    global.HTMLElement = win.HTMLElement;
    global.KeyboardEvent = win.KeyboardEvent;
    global.requestAnimationFrame = function (fn) {
      return setTimeout(fn, 0);
    };
    global.cancelAnimationFrame = function (id) {
      clearTimeout(id);
    };
    [
      "shared/colors.js",
      "shared/protocol.js",
      "session/ready.js",
      "versus/scoreboard.js",
      "coop/state.js",
      "coop/native.js",
      "hooks/gsm.js",
      "net/client.js",
      "ui/settingsTab.js",
      "mod.js",
    ].forEach(function (rel) {
      const p = require.resolve(path.join(ROOT, "src", rel));
      delete require.cache[p];
      require(p);
    });
    return win.MultiplayerApp || require(path.join(ROOT, "src/mod.js")).MultiplayerApp;
  }

  function menuDom() {
    return new (require("jsdom").JSDOM)(`<!DOCTYPE html><html><body>
      <div class="wjOYOd" style="visibility:visible;opacity:1">
        <div>
          <div id="trophy"><div class="tuJOWd"></div><div></div></div>
          <div id="count"><div class="tuJOWd"></div></div>
          <div id="speed"><div class="tuJOWd"></div></div>
          <div id="size"><div class="tuJOWd"></div></div>
          <div id="color"><div class="tuJOWd"></div><div></div></div>
          <div id="apple"><div class="tuJOWd"></div></div>
          <div id="graphics"><div class="tuJOWd"></div></div>
          <div id="theme"><div class="tuJOWd"></div></div>
          <button jsname="NSjDf" aria-label="Play">Play</button>
        </div>
      </div>
      <canvas class="nEoGkc" width="400" height="400"></canvas>
    </body></html>`, { url: "https://googlesnakemods.com/v/current" }).window;
  }

  function assertPersonalClickable(doc) {
    ["color", "apple", "graphics", "theme"].forEach(function (id) {
      const row = doc.getElementById(id);
      assert.ok(row, id);
      assert.equal(row.style.pointerEvents, "", id + " pointer-events");
      assert.equal(row.style.opacity, "", id + " opacity");
      assert.notEqual(row.style.visibility, "hidden", id + " visibility");
    });
  }

  it("non-admin spectator: sync menus locked, cosmetics + Escape peek stay usable", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: false,
        adminId: "admin",
        clients: [
          { clientId: "admin", role: "player" },
          { clientId: "spec", role: "spectator" },
        ],
      },
      spectateFocus: function () {},
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "admin";

    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "none");
    assert.equal(win.document.getElementById("trophy").title, "Synced from admin");
    assertPersonalClickable(win.document);
    assert.equal(Gsm.playButton().style.pointerEvents, "none");

    // Lobby: must not enter focus seat / hide death
    app.renderFocusBoard();
    assert.equal(!!app._versusFocusSpectate, false);
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    assert.notEqual(death.style.visibility, "hidden");
    assertPersonalClickable(win.document);
  });

  it("admin spectator in lobby: sync menus unlocked", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "admin",
      isAdmin: function () {
        return true;
      },
      me: function () {
        return { clientId: "admin", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: false,
        adminId: "admin",
        clients: [{ clientId: "admin", role: "spectator" }],
      },
      spectateFocus: function () {},
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.applyControlLocks();
    assert.equal(win.document.getElementById("trophy").style.pointerEvents, "");
    assert.equal(win.document.getElementById("trophy").title, "");
    assertPersonalClickable(win.document);
    app.renderFocusBoard();
    assert.equal(!!app._versusFocusSpectate, false);
    assertPersonalClickable(win.document);
  });

  it("versus focus during match: Escape peeks menus and stops re-hiding death", async () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const Gsm = win.MultiplayerGsm;
    const app = new MultiplayerApp();
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { clientId: "spec", role: "spectator" };
      },
      roster: {
        mode: "versus",
        sessionActive: true,
        adminId: "admin",
        clients: [
          { clientId: "admin", role: "player" },
          { clientId: "spec", role: "spectator" },
        ],
      },
      spectateFocus: function () {},
    };
    app.ui = { updateHud: function () {}, renderRoster: function () {} };
    app.versus.spectateMode = "focus";
    app.versus.focusClientId = "admin";
    app.versus.boards.admin = { width: 2, height: 2, body: [], apples: [] };

    Gsm.triggerPlay = function () {};
    app.renderFocusBoard();
    assert.equal(app._versusFocusSpectate, true);
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    assert.equal(death.style.visibility, "hidden");

    // Wire Escape hook and peek
    app.hookEscapeForAdmin();
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      })
    );
    assert.equal(win.__mpSpectateAllowMenus, true);
    assert.notEqual(death.style.visibility, "hidden");
    assertPersonalClickable(win.document);

    // Focus loop must not re-hide while peek is on
    await new Promise(function (r) {
      setTimeout(r, 30);
    });
    assert.notEqual(death.style.visibility, "hidden");
    app._leaveVersusFocusSpectate();
  });

  it("click capture blocks only sync menus for non-admin, not cosmetics", () => {
    const win = menuDom();
    const MultiplayerApp = loadApp(win);
    const app = new MultiplayerApp();
    let colorClicks = 0;
    let trophyClicks = 0;
    app.client = {
      connected: true,
      clientId: "spec",
      isAdmin: function () {
        return false;
      },
      me: function () {
        return { role: "spectator" };
      },
    };
    app.hookAdminSettingsWatch();

    const color = win.document.getElementById("color").children[0];
    const trophy = win.document.getElementById("trophy").children[1];
    color.addEventListener("click", function () {
      colorClicks++;
    });
    trophy.addEventListener("click", function () {
      trophyClicks++;
    });

    color.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    trophy.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.equal(colorClicks, 1, "cosmetic click reaches target");
    assert.equal(trophyClicks, 0, "sync menu click blocked for non-admin");
  });

  it("hideControlHelper does not disable wrappers that own menu rows", () => {
    const win = menuDom();
    loadGsm(win);
    const Gsm = win.MultiplayerGsm;
    const wrap = win.document.createElement("div");
    wrap.style.position = "absolute";
    wrap.style.cssText =
      "position:absolute;left:10px;top:100px;width:200px;height:200px;";
    // Move menus under an absolute wrapper that would otherwise be tip-hidden
    const death = win.document.getElementsByClassName("wjOYOd")[0];
    const inner = death.children[0];
    wrap.appendChild(inner);
    win.document.body.appendChild(wrap);
    Object.defineProperty(wrap, "getBoundingClientRect", {
      value: function () {
        return { width: 200, height: 200, top: 100, left: 10, right: 210, bottom: 300 };
      },
    });
    Gsm.hideControlHelper();
    assert.notEqual(wrap.dataset.mpHelperHidden, "1");
    assertPersonalClickable(win.document);
  });
});
