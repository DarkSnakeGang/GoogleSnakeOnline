/**
 * Central multiplayer runtime flags.
 *
 * Engine string-patches (gsm alterSnakeCode) and tick hooks still read flat
 * `window.__mp*` names — those stay. This module owns the *lifecycle* of those
 * flags so Focus/Play/Escape paths do not sprinkle ad-hoc assignments.
 */
(function (root) {
  function win() {
    return typeof root !== "undefined" ? root : null;
  }

  function set(key, value) {
    const w = win();
    if (!w) return;
    w[key] = value;
  }

  function get(key, fallback) {
    const w = win();
    if (!w) return fallback;
    return w[key] !== undefined ? w[key] : fallback;
  }

  /**
   * Enter Versus Focus spectate mode. Focus draws the watched board itself, so
   * `__mpVersusFocusSpectate` — the gate on gsm's engine inject — stays off;
   * only the "am I watching" flag goes up. See archive/focus-native/.
   */
  function enterVersusFocus() {
    set("__mpVersusFocusWatch", true);
    set("__mpVersusFocusSpectate", false);
    set("__mpSpectateAllowMenus", false);
    set("__mpSpectateMenuFp", null);
  }

  /** Leave Versus Focus. */
  function leaveVersusFocus() {
    set("__mpVersusFocusWatch", false);
    set("__mpVersusFocusSpectate", false);
    set("__mpVersusFocusBoard", null);
    set("__mpSpectateAllowMenus", false);
    set("__mpSpectateMenuFp", null);
  }

  /** After promote / leave spectate — clear Focus + co-op spectator seat flags. */
  function clearSpectatorSeat(opts) {
    opts = opts || {};
    leaveVersusFocus();
    set("__mpCoopSpectator", false);
    if (!opts.keepCoopLocalDead) {
      set("__mpCoopLocalDead", false);
    }
  }

  function beginMatchStart() {
    set("__mpStartingMatch", true);
    set("__mpAttemptExpired", false);
  }

  function endMatchStart() {
    set("__mpStartingMatch", false);
  }

  function endCoopSessionFlags() {
    set("__mpCoopAfterTick", null);
    set("__mpCoopFlushPendingDeltas", null);
    set("__mpCoopSession", false);
    set("__mpCoopInject", false);
    set("__mpCoopSpectator", false);
    set("__mpCoopLocalDead", false);
    set("__mpCoopSkipFruitReapply", false);
  }

  function beginCoopSessionFlags(opts) {
    opts = opts || {};
    set("__mpCoopSession", true);
    set("__mpCoopInject", opts.inject !== false);
    set("__mpCoopSpectator", !!opts.spectator);
    set("__mpCoopLocalDead", false);
  }

  const Runtime = {
    get: get,
    set: set,
    enterVersusFocus: enterVersusFocus,
    leaveVersusFocus: leaveVersusFocus,
    clearSpectatorSeat: clearSpectatorSeat,
    beginMatchStart: beginMatchStart,
    endMatchStart: endMatchStart,
    endCoopSessionFlags: endCoopSessionFlags,
    beginCoopSessionFlags: beginCoopSessionFlags,
  };

  root.MultiplayerRuntime = Runtime;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Runtime;
  }
})(typeof window !== "undefined" ? window : globalThis);
