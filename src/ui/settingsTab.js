/** Multiplayer settings — own Remix top tab + Connect/Match/Roster sub-tabs. */
(function (root) {
  const Colors = root.MultiplayerColors;
  const Session = root.MultiplayerSession;

  const SUBPAGES = [
    ["connect", "Connect"],
    ["match", "Match"],
    ["roster", "Roster"],
  ];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function ensureStyles() {
    if (document.getElementById("mp-mod-styles")) return;
    const s = document.createElement("style");
    s.id = "mp-mod-styles";
    s.textContent = `
/* Shuffle → Ready. Theme switches restyle the native button; these win. */
button[jsname="qycu7d"].mp-ready-btn,
[jsname="qycu7d"].mp-ready-btn{
  color:#fff !important;
  pointer-events:auto !important;
}
button[jsname="qycu7d"].mp-ready-btn.mp-ready-off,
[jsname="qycu7d"].mp-ready-btn.mp-ready-off{
  background:#b71c1c !important;
  background-color:#b71c1c !important;
  border-color:#7f0000 !important;
}
button[jsname="qycu7d"].mp-ready-btn.mp-ready-on,
[jsname="qycu7d"].mp-ready-btn.mp-ready-on{
  background:#1b5e20 !important;
  background-color:#1b5e20 !important;
  border-color:#0d3d12 !important;
}
#mp-settings-host {
  display:flex; flex-direction:column; gap:6px; min-height:0; flex:1 1 auto;
}
#mp-subpager {
  display:grid;
  grid-template-columns:1fr 1fr 1fr;
  gap:4px;
  flex-shrink:0;
  margin-bottom:2px;
}
#mp-settings-host .mp-roster-row.mp-roster-watching {
  outline:2px solid rgba(255,255,255,0.65);
  background:rgba(255,255,255,0.1);
}
#mp-settings-host .mp-roster-watching-tag {
  margin-left:4px;
  font-size:10px;
  font-weight:700;
  letter-spacing:0.04em;
  text-transform:uppercase;
  color:rgba(255,255,255,0.9);
  opacity:0.9;
}
#mp-settings-host .mp-chip-watching {
  background:rgba(255,255,255,0.22) !important;
  font-weight:700;
}
#mp-settings-host .mp-roster-spectate-bar {
  display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0 0 6px;
}
#mp-subpager .mp-subtab {
  min-width:0;
  font-family:Roboto,Arial,sans-serif !important;
  font-size:11px !important;
  padding:6px 4px !important;
  border:none !important;
  border-radius:8px !important;
  cursor:pointer;
  line-height:1.2;
  background:rgba(0,0,0,0.22);
  color:#fff;
}
#mp-subpager .mp-subtab.mp-subtab-on {
  background: var(--mp-btn, var(--ultra-btn, #1155CC)) !important;
}
.mp-panel { display:none; }
.mp-panel.mp-panel-on { display:block; }
#mp-settings-host .mp-field { margin:0 0 4px; }
#mp-settings-host .mp-field label {
  display:block; color:rgba(255,255,255,0.75); font-family:Roboto,Arial,sans-serif;
  font-size:11px; font-weight:600; letter-spacing:0.04em; margin:0 0 2px;
}
#mp-settings-host input[type=text],
#mp-settings-host input[type=number],
#mp-settings-host select {
  width:100%; box-sizing:border-box; margin:0 0 4px; padding:6px 8px;
  background-color: var(--mp-btn, #1155CC) !important; color:#fff !important;
  font-family:Roboto,Arial,sans-serif; font-size:14px;
  border:none !important; border-radius:8px !important;
  outline:none;
}
#mp-settings-host input::placeholder { color:rgba(255,255,255,0.55); }
#mp-settings-host .pudding-settings-btn,
#mp-settings-host button.btn,
#mp-settings-host #mp-conn-toggle {
  display:block;
  width:100%;
  box-sizing:border-box;
  margin:0 0 6px !important;
  padding:8px 10px !important;
  border:none !important;
  border-radius:8px !important;
  cursor:pointer;
  font-family:Roboto,Arial,sans-serif !important;
  font-size:14px !important;
  font-weight:600 !important;
  line-height:1.2 !important;
  color:#fff !important;
  background: var(--mp-btn, #1155CC) !important;
  background-color: var(--mp-btn, #1155CC) !important;
  box-shadow:none !important;
  text-shadow:none !important;
  -webkit-appearance:none;
  appearance:none;
}
#mp-settings-host .pudding-settings-btn:hover,
#mp-settings-host #mp-conn-toggle:hover {
  filter:brightness(1.08);
}
#mp-settings-host .pudding-settings-btn:active,
#mp-settings-host #mp-conn-toggle:active {
  filter:brightness(0.95);
}
#mp-settings-host .pudding-settings-btn-row {
  display:grid; grid-template-columns:1fr 1fr; gap:4px; margin:0 0 4px;
}
#mp-settings-host .pudding-settings-btn-row .pudding-settings-btn { margin:0 !important; }
#mp-settings-host .pudding-settings-btn.mp-danger,
#mp-settings-host #mp-conn-toggle.mp-danger {
  background:#c5221f !important;
  background-color:#c5221f !important;
  color:#fff !important;
}
#mp-settings-host .pudding-settings-btn:disabled { opacity:.45; cursor:not-allowed; filter:none; }
#mp-settings-host .mp-status {
  color:rgba(255,255,255,0.9); font-family:Roboto,Arial,sans-serif; font-size:12px; margin:0 0 6px;
}
#mp-settings-host .mp-roster-toolbar {
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  margin:0 0 6px; flex-wrap:wrap;
}
#mp-settings-host .mp-roster-toolbar .mp-status { margin:0; flex:1; min-width:80px; }
#mp-settings-host .mp-roster-toggle.hidden { display:none !important; }
#mp-settings-host .mp-roster-toggle.form-check {
  display:inline-flex; align-items:center; margin:0; min-height:0; padding-left:0;
}
#mp-settings-host .mp-roster-toggle .form-check-input {
  margin:0; float:none; flex-shrink:0;
}
#mp-settings-host .mp-roster-toggle .form-check-label {
  margin:3px; color:white; font-family:Roboto,Arial,sans-serif;
}
#mp-settings-host .mp-roster {
  max-height:220px; overflow:auto; margin:0 0 6px; padding:4px;
  border:1px solid rgba(255,255,255,0.18); border-radius:6px;
  font-family:Roboto,Arial,sans-serif; font-size:12px; color:white;
  background:rgba(0,0,0,0.12);
}
#mp-settings-host .mp-roster-empty {
  padding:14px 8px; text-align:center; color:rgba(255,255,255,0.55); font-size:11px;
}
#mp-settings-host .mp-roster-row {
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:6px 8px;
  align-items:center;
  padding:7px 6px;
  border-bottom:1px solid rgba(255,255,255,0.1);
}
#mp-settings-host .mp-roster-row:last-child { border-bottom:none; }
#mp-settings-host .mp-roster-main {
  min-width:0; display:flex; flex-direction:column; gap:3px;
}
#mp-settings-host .mp-roster-name {
  display:flex; align-items:center; gap:6px; min-width:0;
  font-weight:600; font-size:12px; line-height:1.2;
}
#mp-settings-host .mp-roster-name.mp-roster-name-watch {
  cursor:pointer; border-radius:4px; padding:1px 2px; margin:-1px -2px;
}
#mp-settings-host .mp-roster-name.mp-roster-name-watch:hover {
  background:rgba(255,255,255,0.12);
  text-decoration:underline;
}
#mp-settings-host .mp-roster-name > span:last-of-type {
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
#mp-settings-host .mp-roster-dot {
  width:10px; height:10px; border-radius:50%; flex-shrink:0;
  border:1px solid rgba(255,255,255,0.55);
  background:rgba(255,255,255,0.25);
}
#mp-settings-host .mp-roster-star {
  color:#ffd54f; font-size:11px; flex-shrink:0;
}
#mp-settings-host .mp-roster-meta {
  display:flex; flex-wrap:wrap; gap:4px; align-items:center;
}
#mp-settings-host .mp-chip {
  display:inline-block; padding:1px 6px; border-radius:999px;
  font-size:10px; line-height:1.4; font-weight:500;
  background:rgba(255,255,255,0.12); color:rgba(255,255,255,0.88);
}
#mp-settings-host .mp-chip-player { background:rgba(76,175,80,0.28); }
#mp-settings-host .mp-chip-spectator { background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.7); }
#mp-settings-host .mp-chip-ready { background:rgba(33,150,243,0.35); }
#mp-settings-host .mp-chip-wait { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.55); }
#mp-settings-host .mp-roster-stats {
  font-size:10px; line-height:1.35; color:rgba(255,255,255,0.72);
  font-variant-numeric:tabular-nums;
}
#mp-settings-host .mp-roster-stats strong {
  color:rgba(255,255,255,0.95); font-weight:600;
}
#mp-settings-host .mp-roster-actions {
  display:flex; flex-direction:column; gap:3px; align-items:stretch;
}
#mp-settings-host .mp-roster .mp-mini {
  width:auto !important;
  min-width:52px;
  display:block;
  padding:3px 8px !important;
  font-size:11px !important;
  margin:0 !important;
  border-radius:6px !important;
}
#mp-settings-host .mp-admin-only.hidden,
#mp-settings-host .mp-player-only.hidden { display:none !important; }
#mp-settings-host .pudding-settings-section-title {
  display:block; color:rgba(255,255,255,0.85); font-family:Roboto,Arial,sans-serif;
  font-size:12px; font-weight:600; margin:6px 0 4px;
}
.mp-hud{position:fixed;top:48px;right:8px;z-index:9999;background:rgba(0,0,0,.55);color:#fff;
  padding:8px 10px;border-radius:8px;font:12px/1.35 Roboto,Arial,sans-serif;min-width:180px;max-width:280px}
.mp-hud h4{margin:0 0 6px;font-size:13px}
.mp-hud .mp-hud-winner{
  margin:4px 0 8px;padding:6px 8px;border-radius:6px;
  background:rgba(255,213,79,.22);border:1px solid rgba(255,213,79,.45);
  font-weight:700;font-size:12px;line-height:1.35;
}
.mp-hud .mp-hud-winner .mp-hud-winner-detail{font-weight:500;opacity:.92;font-size:11px}
.mp-hud .mp-hud-place{margin:2px 0}
.mp-hud .mp-hud-place.mp-hud-lead{color:#ffe082;font-weight:600}
.mp-hud .mp-hud-meta{opacity:.85;margin:2px 0}
.mp-color-icon{width:28px;height:28px;border-radius:6px;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3)}
#mp-mosaic{
  position:fixed;left:50%;top:12px;transform:translateX(-50%);
  z-index:9996;display:none;
  gap:10px;padding:10px;background:rgba(0,0,0,.45);border-radius:10px;
  max-width:min(96vw,1100px);max-height:58vh;overflow:auto;
  box-sizing:border-box;
}
#mp-mosaic .mp-mosaic-cell{
  position:relative;cursor:pointer;
  display:flex;flex-direction:column;align-items:stretch;gap:4px;
}
#mp-mosaic .mp-mosaic-cell canvas{
  display:block;border-radius:4px;background:transparent;cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none;width:100%;height:auto;
}
#mp-mosaic .mp-mosaic-cell .mp-mosaic-label{
  position:static;
  font:600 11px/1.25 Roboto,Arial,sans-serif;
  color:#fff;text-align:center;
  background:rgba(0,0,0,.55);padding:3px 6px;border-radius:4px;
  pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:100%;
  font-variant-numeric:tabular-nums;
}
#mp-mosaic .mp-mosaic-cell.mp-mosaic-focus canvas{outline:2px solid #fff}
#mp-mosaic .mp-mosaic-cell.mp-mosaic-focus .mp-mosaic-label{
  background:rgba(255,255,255,.22);
}
#mp-mosaic .mp-mosaic-cell.mp-mosaic-lead .mp-mosaic-label{
  background:rgba(255,213,79,.28);
  color:#ffe082;
  box-shadow:inset 0 0 0 1px rgba(255,213,79,.45);
}
/* Cat strip is shared by mosaic cells and the full-size Focus view */
.mp-mosaic-cat{
  display:none;align-items:center;justify-content:center;gap:2px;
  padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.45);
  pointer-events:none;line-height:1;
}
.mp-mosaic-cat img.mp-mosaic-cat-pip{
  width:9px;height:9px;object-fit:contain;opacity:.22;filter:grayscale(1);
}
.mp-mosaic-cat i.mp-mosaic-cat-pip{
  width:7px;height:7px;border-radius:50%;background:#ffd54f;opacity:.25;
}
.mp-mosaic-cat .mp-mosaic-cat-pip.on{opacity:1;filter:none}
.mp-mosaic-cat .mp-mosaic-cat-n{
  margin-left:4px;font:700 10px/1 Roboto,Arial,sans-serif;color:#fff;
  font-variant-numeric:tabular-nums;
}
.mp-mosaic-cat .mp-mosaic-cat-grace{
  margin-left:4px;font:10px/1 Roboto,Arial,sans-serif;color:#cfe8ff;
  opacity:.9;font-variant-numeric:tabular-nums;
}
/* Focus: one mosaic board scaled onto the game canvas. Left click-through so
   Escape peek / the gear underneath stay reachable. Padding is the border
   frame — mod.js sizes it to about one cell. */
#mp-focus-view{
  position:fixed;display:none;z-index:9996;
  box-sizing:border-box;pointer-events:none;overflow:hidden;
}
#mp-focus-view canvas.mp-focus-canvas{
  display:block;width:100%;height:100%;
}
#mp-focus-view .mp-focus-label{
  position:absolute;left:50%;top:6px;transform:translateX(-50%);
  max-width:88%;padding:3px 10px;border-radius:6px;
  background:rgba(0,0,0,.5);color:#fff;
  font:600 13px/1.3 Roboto,Arial,sans-serif;text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  pointer-events:none;font-variant-numeric:tabular-nums;
}
#mp-focus-view .mp-focus-label.mp-focus-dead{
  background:rgba(120,20,20,.6);color:#ffcdd2;
}
#mp-focus-view .mp-focus-cat{
  position:absolute;left:50%;bottom:6px;transform:translateX(-50%);
}
`;
    document.head.appendChild(s);
  }

  function themedBtn(text, extraClass) {
    // Use Remix `.btn` so theme CSS paints white-on-accent; mp styles reinforce it.
    const b = el(
      "button",
      "btn pudding-settings-btn" + (extraClass ? " " + extraClass : ""),
      text
    );
    b.type = "button";
    return b;
  }

  function lsGet(key, fallback) {
    try {
      if (typeof localStorage === "undefined") return fallback;
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(key, value == null ? "" : String(value));
    } catch (e) { /* ignore */ }
  }

  function applyThemeVars(host) {
    if (!host) return;
    const btn = root.button_color || "#1155CC";
    host.style.setProperty("--mp-btn", btn);
    host.style.setProperty("--ultra-btn", btn);
    host.querySelectorAll(".pudding-settings-btn, button.btn").forEach(function (b) {
      if (b.classList.contains("mp-danger")) {
        b.style.setProperty("background", "#c5221f", "important");
        b.style.setProperty("background-color", "#c5221f", "important");
      } else {
        b.style.setProperty("background", btn, "important");
        b.style.setProperty("background-color", btn, "important");
      }
      b.style.setProperty("color", "#fff", "important");
      b.style.setProperty("border", "none", "important");
    });
  }

  function formatMs(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return "—";
    const total = Math.max(0, Math.floor(Number(ms)));
    // Guard against wall-clock timestamps accidentally treated as durations
    if (total > 24 * 60 * 60 * 1000) return "—";
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const tenths = Math.floor((total % 1000) / 100);
    if (m > 0) {
      return m + ":" + String(s).padStart(2, "0") + "." + tenths;
    }
    return s + "." + tenths + "s";
  }

  function colorDotStyle(colorId) {
    const c = Colors && Colors.getColor ? Colors.getColor(colorId) : null;
    if (!c) return "";
    if (c.kind === "solid" && c.primary) {
      return (
        "background:linear-gradient(135deg," +
        c.primary +
        "," +
        (c.secondary || c.primary) +
        ")"
      );
    }
    if (c.set && c.set.length) {
      return "background:" + c.set[0];
    }
    return "";
  }

  function field(label, input) {
    const wrap = el("div", "mp-field");
    wrap.appendChild(el("label", null, label));
    wrap.appendChild(input);
    return wrap;
  }

  /**
   * Ensure Multiplayer is a peer of Play/Setup/Custom under settings-popup-pudding.
   * remixOrganizeSettings may shove unknown nodes into Setup — we pull the page back.
   */
  function ensureMultiplayerPage() {
    const rootEl = document.getElementById("settings-popup-pudding");
    if (!rootEl) return null;

    // Remix ships "Pudding Mod Settings" — Multiplayer just wants "Settings"
    const title = rootEl.querySelector(":scope > span");
    if (title && /pudding/i.test(title.textContent || "")) {
      title.textContent = "Settings";
    }

    let page = document.getElementById("ultra-settings-page-multiplayer");
    if (!page) {
      page = document.createElement("div");
      page.id = "ultra-settings-page-multiplayer";
      page.className = "ultra-settings-page";
    }
    if (page.parentElement !== rootEl) rootEl.appendChild(page);

    let pager = document.getElementById("ultra-settings-pager");
    if (!pager) {
      pager = document.createElement("div");
      pager.id = "ultra-settings-pager";
      const title = rootEl.querySelector(":scope > span");
      if (title && title.nextSibling) rootEl.insertBefore(pager, title.nextSibling);
      else rootEl.insertBefore(pager, rootEl.firstChild);
    }

    // 4 top tabs → 2-up grid (Play | Setup / Custom | Multiplayer)
    pager.classList.add("ultra-pager-grid");

    let tab = document.getElementById("ultra-settings-tab-multiplayer");
    if (!tab) {
      tab = document.createElement("button");
      tab.type = "button";
      tab.id = "ultra-settings-tab-multiplayer";
      tab.className = "ultra-settings-tab";
      tab.textContent = "Multiplayer";
      tab.addEventListener("click", function () {
        if (typeof root.remixShowSettingsPage === "function") {
          root.remixShowSettingsPage("multiplayer");
        } else {
          document.querySelectorAll(".ultra-settings-page").forEach(function (p) {
            p.classList.toggle(
              "ultra-page-on",
              p.id === "ultra-settings-page-multiplayer"
            );
          });
          document.querySelectorAll(".ultra-settings-tab").forEach(function (t) {
            t.classList.toggle("ultra-tab-on", t.id === "ultra-settings-tab-multiplayer");
          });
        }
        if (typeof root.remixPaintSettingsTabs === "function") {
          root.remixPaintSettingsTabs();
        }
      });
    }
    if (tab.parentElement !== pager) pager.appendChild(tab);

    // Strip legacy section dumped into Setup
    const legacy = document.getElementById("mp-settings-section");
    if (legacy && legacy.parentElement && legacy.parentElement !== page) {
      legacy.remove();
    }

    return page;
  }

  function showSubPage(id) {
    // Spectate tab retired — controls live on Roster
    if (id === "spectate") id = "roster";
    if (!SUBPAGES.some(function (p) { return p[0] === id; })) id = "connect";
    root.__mpSettingsSubPage = id;
    SUBPAGES.forEach(function (pair) {
      const name = pair[0];
      const panel = document.getElementById("mp-panel-" + name);
      const tab = document.getElementById("mp-subtab-" + name);
      const on = name === id;
      if (panel) panel.classList.toggle("mp-panel-on", on);
      if (tab) tab.classList.toggle("mp-subtab-on", on);
    });
  }

  function MultiplayerUI(app) {
    this.app = app;
    this.panel = null;
    this.hud = null;
    this.colorIconEl = null;
    this.fullscreenBtn = null;
    this._built = false;
  }

  MultiplayerUI.prototype.mountSettingsTab = function () {
    ensureStyles();
    const self = this;
    const page = ensureMultiplayerPage();
    if (!page) {
      setTimeout(function () {
        self.mountSettingsTab();
      }, 200);
      return;
    }

    // Already built — just re-home under Multiplayer page
    let host = document.getElementById("mp-settings-host");
    if (host) {
      if (host.parentElement !== page) page.appendChild(host);
      this.panel = host;
      applyThemeVars(host);
      if (typeof root.remixPaintSettingsTabs === "function") {
        root.remixPaintSettingsTabs();
      }
      return;
    }

    host = el("div");
    host.id = "mp-settings-host";
    applyThemeVars(host);

    const subpager = el("div");
    subpager.id = "mp-subpager";
    SUBPAGES.forEach(function (pair) {
      const b = el("button", "mp-subtab", pair[1]);
      b.type = "button";
      b.id = "mp-subtab-" + pair[0];
      b.addEventListener("click", function () {
        showSubPage(pair[0]);
      });
      subpager.appendChild(b);
    });
    host.appendChild(subpager);

    const panelConnect = el("div", "mp-panel");
    panelConnect.id = "mp-panel-connect";
    const panelMatch = el("div", "mp-panel");
    panelMatch.id = "mp-panel-match";
    const panelRoster = el("div", "mp-panel");
    panelRoster.id = "mp-panel-roster";
    host.appendChild(panelConnect);
    host.appendChild(panelMatch);
    host.appendChild(panelRoster);

    // --- Connect ---
    const nameIn = el("input");
    nameIn.type = "text";
    nameIn.placeholder = "Optional display name";
    nameIn.id = "mp-display-name";
    nameIn.value = lsGet("MULTIPLAYER_DISPLAY_NAME", "");

    const urlIn = el("input");
    urlIn.type = "text";
    urlIn.value = lsGet("MULTIPLAYER_SERVER_URL", "ws://127.0.0.1:7777/ws");
    urlIn.id = "mp-server-url";

    const roomIn = el("input");
    roomIn.type = "text";
    roomIn.placeholder = "Room code (blank = create)";
    roomIn.id = "mp-room-code";
    roomIn.value = lsGet("MULTIPLAYER_ROOM_CODE", "");

    function persistConnectFields() {
      lsSet("MULTIPLAYER_DISPLAY_NAME", nameIn.value.trim());
      lsSet("MULTIPLAYER_SERVER_URL", urlIn.value.trim() || "ws://127.0.0.1:7777/ws");
      lsSet("MULTIPLAYER_ROOM_CODE", roomIn.value.trim());
    }
    ["change", "blur"].forEach(function (ev) {
      nameIn.addEventListener(ev, persistConnectFields);
      urlIn.addEventListener(ev, persistConnectFields);
      roomIn.addEventListener(ev, persistConnectFields);
    });

    panelConnect.appendChild(field("Display name", nameIn));
    panelConnect.appendChild(field("Server URL", urlIn));
    panelConnect.appendChild(field("Room code", roomIn));

    const connBtn = themedBtn("Connect", "mp-conn-toggle");
    connBtn.id = "mp-conn-toggle";
    panelConnect.appendChild(connBtn);

    const status = el("div", "mp-status", "Disconnected");
    status.id = "mp-status";
    panelConnect.appendChild(status);

    // --- Match (admin + player) ---
    const adminBox = el("div", "mp-admin-only hidden");
    adminBox.id = "mp-admin-box";
    adminBox.appendChild(el("span", "pudding-settings-section-title", "Admin"));

    const modeRow = el("div", "pudding-settings-btn-row");
    const versusBtn = themedBtn("Versus");
    const coopBtn = themedBtn("Co-op");
    modeRow.appendChild(versusBtn);
    modeRow.appendChild(coopBtn);
    adminBox.appendChild(modeRow);

    const dur = el("input");
    dur.type = "number";
    dur.min = "1";
    dur.value = String(
      Math.max(1, parseInt(lsGet("MULTIPLAYER_VERSUS_ATTEMPT_MIN", "30"), 10) || 30)
    );
    dur.id = "mp-duration";
    const durField = field("Versus attempt (min)", dur);
    durField.id = "mp-duration-field";
    adminBox.appendChild(durField);

    const goalSel = el("select");
    goalSel.id = "mp-versus-goal";
    const VersusState = root.VersusState;
    (VersusState && VersusState.GOALS ? VersusState.GOALS : [
      { id: "score", label: "Score" },
      { id: "best25", label: "Best 25" },
      { id: "best50", label: "Best 50" },
      { id: "best100", label: "Best 100" },
      { id: "bestAll", label: "Best All" },
    ]).forEach(function (g) {
      const opt = el("option");
      opt.value = g.id;
      opt.textContent = g.label;
      goalSel.appendChild(opt);
    });
    const savedGoal = lsGet("MULTIPLAYER_VERSUS_GOAL", "score");
    goalSel.value =
      VersusState && VersusState.normalizeGoal
        ? VersusState.normalizeGoal(savedGoal)
        : savedGoal || "score";
    const goalField = field("Versus goal", goalSel);
    goalField.id = "mp-versus-goal-field";
    adminBox.appendChild(goalField);

    const startBtn = themedBtn("Start match");
    startBtn.id = "mp-start";
    startBtn.disabled = true;
    adminBox.appendChild(startBtn);

    const endBtn = themedBtn("End match");
    endBtn.id = "mp-end";
    endBtn.title = "Stop the run for everyone (also Esc)";
    endBtn.classList.add("hidden");
    endBtn.style.display = "none";
    adminBox.appendChild(endBtn);

    panelMatch.appendChild(adminBox);

    const playerBox = el("div", "mp-player-only hidden");
    playerBox.id = "mp-player-box";
    playerBox.appendChild(el("span", "pudding-settings-section-title", "Player"));
    const readyBtn = themedBtn("Ready");
    readyBtn.id = "mp-ready";
    playerBox.appendChild(readyBtn);
    playerBox.appendChild(
      el(
        "div",
        "mp-status",
        "Co-op: pick your snake color in the in-game color row (unique)."
      )
    );
    panelMatch.appendChild(playerBox);

    const matchHint = el(
      "div",
      "mp-status",
      "Connect first. Admin controls appear when you are room admin; Ready when you are a player."
    );
    matchHint.id = "mp-match-hint";
    panelMatch.appendChild(matchHint);

    // --- Roster ---
    const rosterToolbar = el("div", "mp-roster-toolbar");
    const rosterHint = el("div", "mp-status", "Connected players");
    rosterHint.id = "mp-roster-hint";
    const showBestWrap = el("div", "form-check form-check-inline mp-roster-toggle hidden");
    showBestWrap.id = "mp-show-best-wrap";
    const showBestCb = el("input", "form-check-input");
    showBestCb.type = "checkbox";
    showBestCb.setAttribute("role", "switch");
    showBestCb.id = "mp-show-best";
    showBestCb.checked = lsGet("MULTIPLAYER_ROSTER_SHOW_BEST", "0") === "1";
    const showBestLabel = el("label", "form-check-label", "Best times");
    showBestLabel.htmlFor = "mp-show-best";
    showBestLabel.style.cssText =
      "margin:3px;color:white;font-family:Roboto,Arial,sans-serif;";
    showBestWrap.appendChild(showBestCb);
    showBestWrap.appendChild(showBestLabel);
    rosterToolbar.appendChild(rosterHint);
    rosterToolbar.appendChild(showBestWrap);
    panelRoster.appendChild(rosterToolbar);

    // Spectate controls live on Roster (no separate Spectate tab)
    const spectateBar = el("div", "mp-roster-spectate-bar");
    spectateBar.id = "mp-roster-spectate-bar";
    spectateBar.style.display = "none";
    const mosaicBtn = themedBtn("Mosaic");
    mosaicBtn.id = "mp-mosaic-toggle";
    mosaicBtn.title = "Toggle mosaic mini-boards vs focus on one player";
    spectateBar.appendChild(mosaicBtn);
    const spectateHint = el(
      "div",
      "mp-status",
      "Click a player’s name to watch, or use Mosaic."
    );
    spectateHint.id = "mp-spectate-hint";
    spectateHint.style.margin = "0";
    spectateBar.appendChild(spectateHint);
    panelRoster.appendChild(spectateBar);

    const roster = el("div", "mp-roster");
    roster.id = "mp-roster";
    panelRoster.appendChild(roster);

    page.appendChild(host);
    this.panel = host;
    this._built = true;
    showSubPage(root.__mpSettingsSubPage || "connect");

    function setConnButton(connected) {
      if (connected) {
        connBtn.textContent = "Disconnect";
        connBtn.classList.add("mp-danger");
      } else {
        connBtn.textContent = "Connect";
        connBtn.classList.remove("mp-danger");
      }
      applyThemeVars(host);
    }

    connBtn.onclick = function () {
      const connected = !!(
        self.app.client &&
        (self.app.client.joined || self.app.client.connected)
      );
      if (connected) {
        self.app.disconnect();
        setConnButton(false);
        status.textContent = "Disconnected";
      } else {
        persistConnectFields();
        status.textContent = "Connecting…";
        self.app
          .connect({
            url: urlIn.value.trim() || "ws://127.0.0.1:7777/ws",
            displayName: nameIn.value.trim(),
            roomCode: roomIn.value.trim(),
            create: !roomIn.value.trim(),
          })
          .then(function (welcome) {
            setConnButton(true);
    // Push saved Versus attempt length once we know we're admin (WELCOME.isAdmin)
    const mins = Math.max(1, parseInt(dur.value, 10) || 30);
    lsSet("MULTIPLAYER_VERSUS_ATTEMPT_MIN", String(mins));
    if (welcome && welcome.isAdmin && self.app.client) {
      self.app.client.setDuration(mins);
      if (self.app.client.setVersusGoal) {
        self.app.client.setVersusGoal(goalSel.value);
      }
    }
          })
          .catch(function (err) {
            setConnButton(false);
            status.textContent =
              "Error: " +
              ((err && (err.message || err.code)) || "Connect failed");
          });
      }
    };
    versusBtn.onclick = function () {
      self.app.client && self.app.client.setMode("versus");
    };
    coopBtn.onclick = function () {
      self.app.client && self.app.client.setMode("coop");
    };
    dur.onchange = function () {
      const mins = Math.max(1, parseInt(dur.value, 10) || 30);
      dur.value = String(mins);
      lsSet("MULTIPLAYER_VERSUS_ATTEMPT_MIN", String(mins));
      if (self.app.client && self.app.client.isAdmin()) {
        self.app.client.setDuration(mins);
      }
    };
    dur.addEventListener("input", function () {
      const mins = Math.max(1, parseInt(dur.value, 10) || 30);
      lsSet("MULTIPLAYER_VERSUS_ATTEMPT_MIN", String(mins));
      // Push live so Start match doesn't still use the server default (30)
      if (self.app.client && self.app.client.connected && self.app.client.isAdmin()) {
        self.app.client.setDuration(mins);
      }
    });
    goalSel.onchange = function () {
      const g =
        VersusState && VersusState.normalizeGoal
          ? VersusState.normalizeGoal(goalSel.value)
          : goalSel.value;
      goalSel.value = g;
      lsSet("MULTIPLAYER_VERSUS_GOAL", g);
      if (
        self.app.client &&
        self.app.client.connected &&
        self.app.client.isAdmin() &&
        self.app.client.setVersusGoal
      ) {
        self.app.client.setVersusGoal(g);
      }
    };
    startBtn.onclick = function () {
      if (!self.app.client || !self.app.client.isAdmin()) return;
      const roster = self.app.client.roster || {};
      // After timer expiry, Start begins a *new* match (scores clear on SESSION_START).
      // Only block while a live attempt forbids new runs mid-window.
      const midAttemptNoRuns =
        roster.mode === "versus" &&
        roster.sessionActive &&
        roster.allowNewRuns === false &&
        !roster.attemptExpired;
      if (midAttemptNoRuns) return;
      if (!Session.canStart(roster)) return;
      // Always push the textbox value before starting — localStorage alone is not enough
      const mins = Math.max(1, parseInt(dur.value, 10) || 30);
      dur.value = String(mins);
      lsSet("MULTIPLAYER_VERSUS_ATTEMPT_MIN", String(mins));
      self.app.client.setDuration(mins);
      const g =
        VersusState && VersusState.normalizeGoal
          ? VersusState.normalizeGoal(goalSel.value)
          : goalSel.value;
      goalSel.value = g;
      lsSet("MULTIPLAYER_VERSUS_GOAL", g);
      if (self.app.client.setVersusGoal) self.app.client.setVersusGoal(g);
      // Bundle match rules into SESSION_START so co-op/versus peers apply
      // trophy/count/speed/size quietly under __mpStartingMatch (no menu open).
      const snap =
        self.app.syncMySettingsAsAdmin && self.app.syncMySettingsAsAdmin();
      self.app.client.sessionStart(snap ? { settings: snap } : {});
      const st = document.getElementById("mp-status");
      if (st) st.textContent = "Starting match…";
    };
    endBtn.onclick = function () {
      if (!self.app.client || !self.app.client.isAdmin()) return;
      if (self.app.abortMatchAsAdmin) self.app.abortMatchAsAdmin("ui");
      else if (self.app.client.sessionEnd) self.app.client.sessionEnd("aborted");
    };
    readyBtn.onclick = function () {
      if (!self.app.client || !self.app.client.connected) return;
      const me = self.app.client.me();
      if (!me || me.role !== "player") return;
      const next = !me.ready;
      // Optimistic so Ready/Unready flips on the first click
      me.ready = next;
      readyBtn.textContent = next ? "Unready" : "Ready";
      if (self.app.client.roster) self.renderRoster(self.app.client.roster);
      self.app.client.setReady(next);
    };

    // Stable delegation — survives roster DOM rebuilds mid-click (SCORE_PULSE etc.)
    roster.addEventListener(
      "pointerdown",
      function (ev) {
        const btn = ev.target && ev.target.closest && ev.target.closest("[data-mp-act]");
        if (!btn || !roster.contains(btn)) return;
        if (!self.app.client || !self.app.client.connected) return;
        const act = btn.getAttribute("data-mp-act");
        const id = btn.getAttribute("data-mp-id");
        if (!id) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (act === "focus") {
          const meNow = self.app.client.me();
          if (!meNow || meNow.role !== "spectator") return;
          const live =
            self.app.client.roster &&
            (self.app.client.roster.clients || []).find(function (c) {
              return c.clientId === id;
            });
          if (!live || live.role !== "player") return;
          if (self.app.focusSpectatePlayer) {
            self.app.focusSpectatePlayer(id);
          }
          if (self.app.client.roster) self.renderRoster(self.app.client.roster);
          return;
        }
        if (!self.app.client.isAdmin()) return;
        if (act === "kick") {
          self.app.client.kick(id);
          return;
        }
        if (act === "admin") {
          if (self.app.client.transferAdmin) self.app.client.transferAdmin(id);
          return;
        }
        if (act !== "role") return;
        const live =
          self.app.client.roster &&
          (self.app.client.roster.clients || []).find(function (c) {
            return c.clientId === id;
          });
        if (!live) return;
        const next = live.role === "player" ? "spectator" : "player";
        // Optimistic local patch so Spec/Play updates immediately
        live.role = next;
        live.ready = false;
        self.renderRoster(self.app.client.roster);
        self.app.client.setRole(id, next);
      },
      true
    );
    showBestCb.onchange = function () {
      lsSet("MULTIPLAYER_ROSTER_SHOW_BEST", showBestCb.checked ? "1" : "0");
      if (self.app.client && self.app.client.roster) {
        self.renderRoster(self.app.client.roster);
      }
    };
    mosaicBtn.onclick = function () {
      if (!self.app.versus) return;
      const next = self.app.versus.spectateMode === "mosaic" ? "focus" : "mosaic";
      self.app.setSpectateMode(next);
      mosaicBtn.textContent = next === "mosaic" ? "Focus view" : "Mosaic";
      if (self.app.client && self.app.client.roster) {
        self.renderRoster(self.app.client.roster);
      }
    };

    function rosterStructureKey(
      rosterData,
      isAdmin,
      showBest,
      amSpectator,
      focusId,
      spectateMode
    ) {
      const clients = (rosterData && rosterData.clients) || [];
      return (
        (rosterData && rosterData.mode) +
        "|" +
        (rosterData && rosterData.allowNewRuns) +
        "|" +
        (isAdmin ? "1" : "0") +
        "|" +
        (showBest ? "1" : "0") +
        "|" +
        (amSpectator ? "1" : "0") +
        "|" +
        (focusId || "") +
        "|" +
        (spectateMode || "") +
        "|" +
        clients
          .map(function (c) {
            return [
              c.clientId,
              c.role,
              c.ready ? "1" : "0",
              c.isAdmin ? "1" : "0",
              c.colorId == null ? "" : c.colorId,
              c.resolvedName || c.displayName || "",
            ].join(":");
          })
          .join(";")
      );
    }

    function statsHtmlFor(clientId) {
      const scores = (self.app.versus && self.app.versus.scores) || {};
      const sc = scores[clientId] || {};
      const goal =
        (self.app.versus && self.app.versus.versusGoal) ||
        (self.app.client &&
          self.app.client.roster &&
          self.app.client.roster.versusGoal) ||
        "score";
      const VersusState = root.VersusState;
      const leaderId =
        (self.app.versus &&
          (self.app.versus.winnerClientId || self.app.versus.leaderClientId)) ||
        null;
      const isLeader = leaderId && leaderId === clientId;
      const matchOver = !!(
        self.app.versus &&
        (self.app.versus.expired ||
          (self.app.client &&
            self.app.client.roster &&
            (self.app.client.roster.attemptExpired ||
              self.app.client.roster.allowNewRuns === false)))
      );
      const goalBest =
        VersusState && VersusState.formatGoalBest
          ? VersusState.formatGoalBest(sc, goal)
          : sc.bestScore != null
            ? String(sc.bestScore)
            : "—";
      const live =
        !matchOver && sc.score != null
          ? "Live " +
            sc.score +
            (sc.alive === false ? " · dead" : "") +
            (sc.timeMs != null ? " · " + formatMs(sc.timeMs) : "")
          : null;
      const goalLabel =
        VersusState && VersusState.goalLabel
          ? VersusState.goalLabel(goal)
          : "Score";
      let html =
        goalLabel +
        " <strong>" +
        goalBest +
        "</strong>" +
        (isLeader ? (matchOver ? " · winner" : " · leading") : "");
      if (live) html += "<br>" + live;
      return html;
    }

    /** Update live/best lines without destroying Spec/Play buttons. */
    self.updateRosterScores = function () {
      const rosterData = (self.app.client && self.app.client.roster) || {};
      const matchOver = !!(
        rosterData.mode === "versus" &&
        (rosterData.allowNewRuns === false ||
          rosterData.attemptExpired ||
          (self.app.versus && self.app.versus.expired))
      );
      const hasScores = !!(
        self.app.versus &&
        self.app.versus.scores &&
        Object.keys(self.app.versus.scores).length
      );
      if (!showBestCb.checked && !(matchOver && hasScores)) return;
      roster.querySelectorAll("[data-mp-stats-id]").forEach(function (node) {
        const id = node.getAttribute("data-mp-stats-id");
        const html = statsHtmlFor(id);
        if (node.innerHTML !== html) node.innerHTML = html;
      });
    };

    self.renderRoster = function (rosterData) {
      applyThemeVars(host);
      const connected = !!(self.app.client && self.app.client.connected);
      setConnButton(connected);
      status.textContent = connected
        ? "Connected · " + (rosterData.mode || "") + " · room " + (rosterData.roomCode || "")
        : "Disconnected";
      const isAdmin = self.app.client && self.app.client.isAdmin();
      const me = self.app.client && self.app.client.me();
      adminBox.classList.toggle("hidden", !isAdmin);
      playerBox.classList.toggle("hidden", !(me && me.role === "player"));
      // Spectate controls on Roster — only while you are a spectator
      const amSpectator = !!(me && me.role === "spectator");
      const isVersus = rosterData.mode === "versus";
      spectateBar.style.display = amSpectator && isVersus ? "" : "none";
      if (amSpectator && self.app.versus) {
        mosaicBtn.textContent =
          self.app.versus.spectateMode === "mosaic" ? "Focus view" : "Mosaic";
      }
      // Versus attempt length is versus-only; hide in co-op
      const isCoop = rosterData.mode === "coop";
      durField.classList.toggle("hidden", !!isCoop);
      durField.style.display = isCoop ? "none" : "";
      const goalFieldEl = document.getElementById("mp-versus-goal-field");
      if (goalFieldEl) {
        goalFieldEl.classList.toggle("hidden", !!isCoop);
        goalFieldEl.style.display = isCoop ? "none" : "";
      }
      // Keep textbox aligned with server durationMin (source of truth for the clock)
      if (
        !isCoop &&
        rosterData.durationMin != null &&
        Number.isFinite(Number(rosterData.durationMin))
      ) {
        const serverMins = String(Math.max(1, Number(rosterData.durationMin)));
        if (document.activeElement !== dur && dur.value !== serverMins) {
          dur.value = serverMins;
          lsSet("MULTIPLAYER_VERSUS_ATTEMPT_MIN", serverMins);
        }
      }
      if (!isCoop && rosterData.versusGoal && document.activeElement !== goalSel) {
        const g =
          VersusState && VersusState.normalizeGoal
            ? VersusState.normalizeGoal(rosterData.versusGoal)
            : rosterData.versusGoal;
        if (goalSel.value !== g) {
          goalSel.value = g;
          lsSet("MULTIPLAYER_VERSUS_GOAL", g);
        }
      }
      // End match is how the admin leaves a live (or stuck) run and gets
      // native trophy/count/speed/size back. Keep it up while the server still
      // has a session OR this client is still in a co-op inject — a peer who
      // quit without dying can leave sessionActive true with the admin stuck
      // on a hidden death screen.
      const sessionOn = !!rosterData.sessionActive;
      const matchOver = !!(
        rosterData.mode === "versus" &&
        (rosterData.allowNewRuns === false ||
          rosterData.attemptExpired ||
          (self.app.versus && self.app.versus.expired))
      );
      const coopLive = !!(
        (self.app && self.app._coopSessionActive) ||
        (typeof window !== "undefined" && window.__mpCoopSession)
      );
      const showEnd = !!(isAdmin && (sessionOn || coopLive));
      endBtn.classList.toggle("hidden", !showEnd);
      endBtn.style.display = showEnd ? "" : "none";
      matchHint.style.display =
        !connected || (isAdmin || (me && me.role === "player")) ? "none" : "block";
      // Start match has nothing left to do once a match is live — it comes back
      // when the session ends or the versus attempt runs out.
      const canOfferStart = !sessionOn || matchOver;
      startBtn.classList.toggle("hidden", !canOfferStart);
      startBtn.style.display = canOfferStart ? "" : "none";
      startBtn.disabled =
        !Session.canStart(rosterData) ||
        (rosterData.mode === "versus" &&
          rosterData.sessionActive &&
          rosterData.allowNewRuns === false &&
          !rosterData.attemptExpired);
      readyBtn.textContent = me && me.ready ? "Unready" : "Ready";
      // Every player readies on the in-game Shuffle→Ready button, admin
      // included; only spectator seats keep the Match Ready button.
      const useInGameReady = !!(connected && me && me.role === "player");
      readyBtn.style.display = useInGameReady ? "none" : "";
      readyBtn.classList.toggle("hidden", !!useInGameReady);
      if (self.app && self.app._paintShuffleAsReady) {
        self.app._paintShuffleAsReady();
      }
      roomIn.value = rosterData.roomCode || roomIn.value;
      if (rosterData.roomCode) lsSet("MULTIPLAYER_ROOM_CODE", rosterData.roomCode);
      if (
        rosterData.mode === "versus" &&
        (rosterData.allowNewRuns === false || rosterData.attemptExpired)
      ) {
        const suffix = rosterData.attemptExpired
          ? " · match over — results kept"
          : " · no new runs";
        status.textContent =
          (connected
            ? "Connected · versus · room " + (rosterData.roomCode || "")
            : "Disconnected") + suffix;
      }

      const showBestToggle = !!(isAdmin && showBestCb.checked);
      const hasScores = !!(
        self.app.versus &&
        self.app.versus.scores &&
        Object.keys(self.app.versus.scores).length
      );
      // After match end: show goal bests to everyone (not only admin "Best times")
      const showBest = showBestToggle || (matchOver && hasScores);
      showBestWrap.classList.toggle("hidden", !isAdmin);
      const clients = rosterData.clients || [];
      const VersusStateApi = root.VersusState;
      const goalId =
        (self.app.versus && self.app.versus.versusGoal) ||
        rosterData.versusGoal ||
        "score";
      const goalLabel =
        (VersusStateApi && VersusStateApi.goalLabel && VersusStateApi.goalLabel(goalId)) ||
        rosterData.versusGoalLabel ||
        "Score";
      const winId =
        (self.app.versus &&
          (self.app.versus.winnerClientId || self.app.versus.leaderClientId)) ||
        rosterData.leaderClientId ||
        null;

      const nPlayers = clients.filter(function (c) {
        return c.role === "player";
      }).length;
      const nSpecs = clients.length - nPlayers;
      let hint = connected
        ? clients.length +
          " connected · " +
          nPlayers +
          " play · " +
          nSpecs +
          " spec" +
          (rosterData.mode ? " · " + rosterData.mode : "")
        : "Not connected";
      if (rosterData.mode === "versus" && winId && (matchOver || hasScores)) {
        const c = clients.find(function (x) {
          return x.clientId === winId;
        });
        const nm =
          (c && (c.resolvedName || c.displayName || c.colorName)) ||
          String(winId).slice(0, 6);
        const tag = matchOver ? "Winner" : "Leading";
        const winSc =
          (self.app.versus &&
            self.app.versus.scores &&
            self.app.versus.scores[winId]) ||
          {};
        const detail =
          VersusStateApi && VersusStateApi.formatGoalDetail
            ? VersusStateApi.formatGoalDetail(winSc, goalId)
            : goalLabel;
        hint = tag + ": " + nm + " · " + detail + " — " + hint;
      }
      rosterHint.textContent = hint;

      const myId = self.app.client && self.app.client.clientId;

      const focusId =
        (self.app.versus && self.app.versus.focusClientId) || null;
      const spectateMode =
        (self.app.versus && self.app.versus.spectateMode) || "focus";
      const structKey = rosterStructureKey(
        rosterData,
        isAdmin,
        showBest,
        amSpectator,
        focusId,
        spectateMode
      );
      if (structKey === self._rosterStructKey && roster.childNodes.length) {
        // Same seats/roles — only refresh score lines
        self.updateRosterScores();
        return;
      }
      self._rosterStructKey = structKey;

      roster.innerHTML = "";
      if (!clients.length) {
        roster.appendChild(
          el("div", "mp-roster-empty", connected ? "No one else here yet" : "Connect to see the roster")
        );
        return;
      }

      clients.forEach(function (c) {
        const row = el("div", "mp-roster-row");
        row.setAttribute("data-mp-row", c.clientId);
        const watching =
          amSpectator &&
          isVersus &&
          c.role === "player" &&
          focusId &&
          focusId === c.clientId;
        if (watching) row.classList.add("mp-roster-watching");
        const main = el("div", "mp-roster-main");

        const nameRow = el("div", "mp-roster-name");
        const canWatch =
          amSpectator && isVersus && c.role === "player";
        if (canWatch) {
          nameRow.classList.add("mp-roster-name-watch");
          nameRow.setAttribute("data-mp-act", "focus");
          nameRow.setAttribute("data-mp-id", c.clientId);
          nameRow.title = watching
            ? "Spectating " +
              (c.resolvedName || c.displayName || c.colorName || "player")
            : "Click to spectate";
          nameRow.setAttribute("role", "button");
          nameRow.tabIndex = 0;
        }
        const dot = el("span", "mp-roster-dot");
        const ds = colorDotStyle(c.colorId);
        if (ds) dot.style.cssText = ds;
        nameRow.appendChild(dot);
        nameRow.appendChild(
          el("span", null, c.resolvedName || c.displayName || c.clientId.slice(0, 8))
        );
        if (c.isAdmin) {
          const star = el("span", "mp-roster-star", "★");
          star.title = "Admin";
          nameRow.appendChild(star);
        }
        if (watching) {
          nameRow.appendChild(el("span", "mp-roster-watching-tag", "Spectating"));
        }
        main.appendChild(nameRow);

        const meta = el("div", "mp-roster-meta");
        meta.appendChild(
          el(
            "span",
            "mp-chip " + (c.role === "player" ? "mp-chip-player" : "mp-chip-spectator"),
            c.role === "player" ? "Player" : "Spectator"
          )
        );
        if (c.role === "player") {
          meta.appendChild(
            el(
              "span",
              "mp-chip " + (c.ready ? "mp-chip-ready" : "mp-chip-wait"),
              c.ready ? "Ready" : "Not ready"
            )
          );
        }
        if (c.colorName) {
          meta.appendChild(el("span", "mp-chip", c.colorName));
        }
        if (watching) {
          meta.appendChild(
            el(
              "span",
              "mp-chip mp-chip-watching",
              spectateMode === "mosaic" ? "Focused" : "Spectating"
            )
          );
        }
        main.appendChild(meta);

        if (showBest && c.role === "player") {
          const stats = el("div", "mp-roster-stats");
          stats.setAttribute("data-mp-stats-id", c.clientId);
          stats.innerHTML = statsHtmlFor(c.clientId);
          main.appendChild(stats);
        }

        row.appendChild(main);

        const actions = el("div", "mp-roster-actions");
        let hasActions = false;
        if (isAdmin) {
          const promo = themedBtn(c.role === "player" ? "Spec" : "Play", "mp-mini");
          promo.setAttribute("data-mp-act", "role");
          promo.setAttribute("data-mp-id", c.clientId);
          const kick = themedBtn("Kick", "mp-mini mp-danger");
          kick.setAttribute("data-mp-act", "kick");
          kick.setAttribute("data-mp-id", c.clientId);
          actions.appendChild(promo);
          actions.appendChild(kick);
          if (c.clientId !== myId) {
            const pass = themedBtn("Pass admin", "mp-mini");
            pass.setAttribute("data-mp-act", "admin");
            pass.setAttribute("data-mp-id", c.clientId);
            pass.title = "Make this player the room admin";
            actions.appendChild(pass);
          }
          hasActions = true;
        }
        if (hasActions) row.appendChild(actions);

        roster.appendChild(row);
      });
    };

    if (typeof root.setTheme === "function" && !root.__mpThemeHooked) {
      const orig = root.setTheme;
      root.setTheme = function () {
        const r = orig.apply(this, arguments);
        applyThemeVars(document.getElementById("mp-settings-host"));
        if (typeof root.remixPaintSettingsTabs === "function") {
          root.remixPaintSettingsTabs();
        }
        return r;
      };
      root.__mpThemeHooked = true;
    }

    if (typeof root.remixPaintSettingsTabs === "function") {
      root.remixPaintSettingsTabs();
    }
  };

  MultiplayerUI.prototype.mountHud = function () {
    ensureStyles();
    if (this.hud) return;
    this.hud = el("div", "mp-hud");
    this.hud.id = "mp-hud";
    this.hud.style.display = "none";
    document.body.appendChild(this.hud);
  };

  MultiplayerUI.prototype.updateHud = function (app) {
    if (!this.hud) return;
    if (!app.client || !app.client.connected) {
      this.hud.style.display = "none";
      return;
    }
    const r = app.client.roster || {};
    // Co-op: no floating debug HUD — play inside native Snake chrome only
    if (r.mode === "coop") {
      this.hud.style.display = "none";
      return;
    }
    this.hud.style.display = "block";
    const clients = r.clients || [];
    function nameOf(id) {
      const c = clients.find(function (x) {
        return x.clientId === id;
      });
      if (!c) return id ? escapeHtml(id.slice(0, 6)) : "?";
      return escapeHtml(
        c.resolvedName || c.displayName || c.colorName || id.slice(0, 6)
      );
    }
    let html = "<h4>" + (r.mode || "").toUpperCase() + "</h4>";
    if (r.mode === "versus" && app.versus) {
      const VersusState = root.VersusState;
      const goal =
        app.versus.versusGoal || r.versusGoal || "score";
      const goalLabel =
        (VersusState && VersusState.goalLabel && VersusState.goalLabel(goal)) ||
        r.versusGoalLabel ||
        "Score";
      const scores = app.versus.scores || {};
      const matchOver = !!(
        app.versus.expired ||
        r.attemptExpired ||
        (r.allowNewRuns === false && Object.keys(scores).length)
      );
      html +=
        '<div class="mp-hud-meta">Goal: ' + escapeHtml(goalLabel) + "</div>";
      if (
        r.sessionActive &&
        app.versus.attemptRemainingMs != null &&
        !app.versus.expired
      ) {
        const s = Math.max(
          0,
          Math.ceil(Number(app.versus.attemptRemainingMs) / 1000)
        );
        html +=
          '<div class="mp-hud-meta">Attempt: ' +
          String(Math.floor(s / 60)).padStart(2, "0") +
          ":" +
          String(s % 60).padStart(2, "0") +
          "</div>";
      } else if (matchOver) {
        html += '<div class="mp-hud-meta">Attempt: ended</div>';
      }

      const winId =
        app.versus.winnerClientId ||
        app.versus.leaderClientId ||
        (VersusState && VersusState.pickLeader
          ? VersusState.pickLeader(scores, goal)
          : null);

      if (matchOver && Object.keys(scores).length) {
        html += '<div class="mp-hud-meta">Last match results</div>';
        if (winId) {
          const winSc = scores[winId] || {};
          const detail =
            VersusState && VersusState.formatGoalDetail
              ? VersusState.formatGoalDetail(winSc, goal)
              : goalLabel;
          html +=
            '<div class="mp-hud-winner">Winner: ' +
            nameOf(winId) +
            '<div class="mp-hud-winner-detail">' +
            escapeHtml(detail) +
            "</div></div>";
        } else {
          html +=
            '<div class="mp-hud-winner">No winner<div class="mp-hud-winner-detail">No scored runs</div></div>';
        }
      } else if (winId) {
        html +=
          "<div><strong>Leading: " + nameOf(winId) + "</strong></div>";
      } else if (app.versus.expired || r.allowNewRuns === false) {
        html += "<div>No new runs</div>";
      }

      const ordered =
        VersusState && VersusState.rankPlayers
          ? VersusState.rankPlayers(scores, goal)
          : Object.keys(scores);
      ordered.forEach(function (id, idx) {
        const sc = scores[id];
        if (!sc) return;
        const bestLine =
          VersusState && VersusState.formatGoalBest
            ? VersusState.formatGoalBest(sc, goal)
            : sc.bestScore != null
              ? String(sc.bestScore)
              : "—";
        const isWin = winId && winId === id;
        const place = matchOver ? idx + 1 + ". " : "";
        const mark = isWin ? " ★" : "";
        let line =
          place +
          nameOf(id) +
          ": " +
          escapeHtml(goalLabel) +
          " " +
          escapeHtml(bestLine) +
          mark;
        if (sc.score != null && !matchOver) {
          line +=
            " · live " +
            sc.score +
            (sc.alive === false ? " dead" : "");
        } else if (matchOver && sc.score != null) {
          line += " · last " + sc.score;
        }
        html +=
          '<div class="mp-hud-place' +
          (isWin ? " mp-hud-lead" : "") +
          '">' +
          line +
          "</div>";
      });
      if (app.versus.focusClientId) {
        html +=
          '<div class="mp-hud-meta">Focus: ' +
          nameOf(app.versus.focusClientId) +
          "</div>";
      }
      if (
        (clients || []).some(function (c) {
          return c.role === "spectator";
        })
      ) {
        html +=
          '<div class="mp-hud-meta">View: ' +
          (app.versus.spectateMode === "mosaic" ? "mosaic" : "focus") +
          "</div>";
      }
    }
    this.hud.innerHTML = html;
  };

  /**
   * Open Pudding settings on the Multiplayer tab (for spectators mid-match, etc.).
   * @param {string=} subPage connect|match|roster
   */
  MultiplayerUI.prototype.openPuddingSettings = function (subPage) {
    this.mountSettingsTab();
    if (typeof root.BootstrapShow === "function") {
      root.BootstrapShow();
    } else {
      const box = document.getElementById("settings-popup-pudding");
      if (box) {
        box.style.display = "block";
        box.style.visibility = "visible";
      }
    }
    if (typeof root.remixShowSettingsPage === "function") {
      root.remixShowSettingsPage("multiplayer");
    } else {
      const tab = document.getElementById("ultra-settings-tab-multiplayer");
      if (tab && typeof tab.click === "function") tab.click();
      document.querySelectorAll(".ultra-settings-page").forEach(function (p) {
        p.classList.toggle(
          "ultra-page-on",
          p.id === "ultra-settings-page-multiplayer"
        );
      });
      document.querySelectorAll(".ultra-settings-tab").forEach(function (t) {
        t.classList.toggle(
          "ultra-tab-on",
          t.id === "ultra-settings-tab-multiplayer"
        );
      });
    }
    let page = subPage;
    if (!page) {
      const me = this.app && this.app.client && this.app.client.me && this.app.client.me();
      if (me && me.role === "spectator") page = "roster";
      else page = root.__mpSettingsSubPage || "connect";
    }
    showSubPage(page);
    if (typeof root.remixPaintSettingsTabs === "function") {
      root.remixPaintSettingsTabs();
    }
  };

  MultiplayerUI.prototype.updateColorIcon = function (colorId, coopMode) {
    const Gsm = root.MultiplayerGsm;
    const fs =
      (Gsm && Gsm.fullscreenButton && Gsm.fullscreenButton()) ||
      document.querySelector('[jsname="JwM0Ie"]') ||
      document.querySelector('button[aria-label*="ullscreen" i]') ||
      this.fullscreenBtn;

    function restoreFullscreen() {
      if (fs) {
        fs.style.display = "";
        fs.style.visibility = "";
      }
      if (this.colorIconEl) this.colorIconEl.style.display = "none";
    }

    if (!coopMode) {
      restoreFullscreen.call(this);
      return;
    }
    if (!fs) return;
    this.fullscreenBtn = fs;
    fs.style.display = "none";

    if (!this.colorIconEl) {
      this.colorIconEl = el("button", "mp-color-icon");
      this.colorIconEl.type = "button";
      this.colorIconEl.setAttribute("aria-label", "Your snake color");
      // Match top-bar control footprint
      const rect = fs.getBoundingClientRect();
      const size = Math.max(24, Math.round(rect.width || 28));
      this.colorIconEl.style.cssText =
        "width:" +
        size +
        "px;height:" +
        size +
        "px;min-width:" +
        size +
        "px;padding:0;margin:0;border:none;border-radius:4px;" +
        "background-size:contain;background-repeat:no-repeat;background-position:center;" +
        "cursor:default;vertical-align:middle;flex-shrink:0;";
      if (fs.parentElement) {
        fs.parentElement.insertBefore(this.colorIconEl, fs.nextSibling);
      } else {
        document.body.appendChild(this.colorIconEl);
      }
    }
    this.colorIconEl.style.display = "";

    // Prefer cloning the selected #color menu snake art
    let artUrl = null;
    try {
      const row = document.getElementById("color");
      if (row) {
        const selected =
          row.querySelector(".tuJOWd img") ||
          row.querySelector("[class*='tuJOWd'] img") ||
          (typeof colorId === "number" && row.children[colorId]
            ? row.children[colorId].querySelector("img")
            : null);
        if (selected && selected.src) artUrl = selected.src;
      }
    } catch (e) { /* ignore */ }

    const c = Colors.getColor(colorId);
    const name =
      (Colors.colorName && Colors.colorName(colorId)) ||
      (c && (c.name || c.label)) ||
      "Snake";
    this.colorIconEl.title = "Your snake: " + name;

    if (artUrl) {
      this.colorIconEl.style.backgroundImage = "url(" + artUrl + ")";
      this.colorIconEl.style.backgroundColor = "transparent";
    } else if (c && c.kind === "solid") {
      this.colorIconEl.style.backgroundImage = "";
      this.colorIconEl.style.background =
        "linear-gradient(135deg," + c.primary + "," + (c.secondary || c.primary) + ")";
    } else if (c && c.set) {
      this.colorIconEl.style.backgroundImage = "";
      this.colorIconEl.style.background =
        "linear-gradient(90deg," + c.set.join(",") + ")";
    } else {
      this.colorIconEl.style.backgroundImage = "";
      this.colorIconEl.style.background = "#888";
    }
  };

  root.MultiplayerUI = MultiplayerUI;
  root.MultiplayerUI.escapeHtml = escapeHtml;
  if (typeof module !== "undefined" && module.exports) module.exports = MultiplayerUI;
})(typeof window !== "undefined" ? window : globalThis);
