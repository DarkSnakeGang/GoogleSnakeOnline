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
   * Enter Race Focus spectate mode. Focus draws the watched board itself, so
   * `__mpRaceFocusSpectate` — the gate on gsm's engine inject — stays off;
   * only the "am I watching" flag goes up. See archive/focus-native/.
   */
  function enterRaceFocus() {
    set("__mpRaceFocusWatch", true);
    set("__mpRaceFocusSpectate", false);
    set("__mpSpectateAllowMenus", false);
    set("__mpSpectateMenuFp", null);
  }

  /** Leave Race Focus. */
  function leaveRaceFocus() {
    set("__mpRaceFocusWatch", false);
    set("__mpRaceFocusSpectate", false);
    set("__mpRaceFocusBoard", null);
    set("__mpSpectateAllowMenus", false);
    set("__mpSpectateMenuFp", null);
  }

  /** After promote / leave spectate — clear Focus + co-op spectator seat flags. */
  function clearSpectatorSeat(opts) {
    opts = opts || {};
    leaveRaceFocus();
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
    set("__mpCoopLastState", null);
    set("__mpCoopLastStateMyId", null);
    set("__mpCoopLastStateSeq", -1);
    set("__mpCoopAuthReapplyScheduled", false);
    set("__mpCoopAuthority", null);
    set("__mpCoopServerAuth", false);
    set("__mpCoopGeneration", 0);
    set("__mpCoopBoardReady", false);
  }

  function setCoopAuthority(authority, generation, boardReady) {
    const serverAuth = authority === "server-sim-v1";
    set("__mpCoopAuthority", authority || null);
    set("__mpCoopServerAuth", serverAuth);
    set("__mpCoopGeneration", Number(generation) || 0);
    set("__mpCoopBoardReady", !!boardReady);
    if (serverAuth) {
      set("__mpCoopPendingRelayPose", null);
      set("__mpCoopPendingRelayInput", null);
    } else {
      set("__mpCoopLastState", null);
      set("__mpCoopLastStateMyId", null);
      set("__mpCoopLastStateSeq", -1);
      set("__mpCoopAuthReapplyScheduled", false);
    }
  }

  function beginCoopSessionFlags(opts) {
    opts = opts || {};
    set("__mpCoopSession", true);
    set("__mpCoopInject", opts.inject !== false);
    set("__mpCoopSpectator", !!opts.spectator);
    set("__mpCoopLocalDead", false);
    if (opts.authority) {
      setCoopAuthority(opts.authority, opts.generation, opts.boardReady);
    }
  }

  const Runtime = {
    get: get,
    set: set,
    enterRaceFocus: enterRaceFocus,
    leaveRaceFocus: leaveRaceFocus,
    clearSpectatorSeat: clearSpectatorSeat,
    beginMatchStart: beginMatchStart,
    endMatchStart: endMatchStart,
    endCoopSessionFlags: endCoopSessionFlags,
    beginCoopSessionFlags: beginCoopSessionFlags,
    setCoopAuthority: setCoopAuthority,
  };

  root.MultiplayerRuntime = Runtime;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Runtime;
  }
})(typeof window !== "undefined" ? window : globalThis);
