/** Versioned client↔server message helpers. */
(function (root) {
  const PROTOCOL_VERSION = 1;

  const TYPES = {
    HELLO: "HELLO",
    WELCOME: "WELCOME",
    ROSTER: "ROSTER",
    SET_ROLE: "SET_ROLE",
    KICK: "KICK",
    SET_DURATION: "SET_DURATION",
    SET_VERSUS_GOAL: "SET_VERSUS_GOAL",
    READY: "READY",
    COLOR_CLAIM: "COLOR_CLAIM",
    MODE_CHANGE: "MODE_CHANGE",
    SETTINGS_SYNC: "SETTINGS_SYNC",
    PLAY_SYNC: "PLAY_SYNC",
    SESSION_START: "SESSION_START",
    SESSION_END: "SESSION_END",
    INPUT: "INPUT",
    STATE_DELTA: "STATE_DELTA",
    STATE_SNAPSHOT: "STATE_SNAPSHOT",
    SCORE_PULSE: "SCORE_PULSE",
    ATTEMPT_TICK: "ATTEMPT_TICK",
    ATTEMPT_EXPIRED: "ATTEMPT_EXPIRED",
    ADMIN_TRANSFER: "ADMIN_TRANSFER",
    RESYNC_REQUEST: "RESYNC_REQUEST",
    BOARD_DELTA: "BOARD_DELTA",
    BOARD_SNAPSHOT: "BOARD_SNAPSHOT",
    SPECTATE_FOCUS: "SPECTATE_FOCUS",
    /** Native co-op: per-player snake pose/colors (server relay). */
    SNAKE_DELTA: "SNAKE_DELTA",
    /** Native co-op: shared collectables from designated owner. */
    COLLECTABLES_DELTA: "COLLECTABLES_DELTA",
    /** Native co-op: player died (corpse stays); server may end when all dead. */
    COOP_PLAYER_DEAD: "COOP_PLAYER_DEAD",
    /** Native co-op: native goal hit (e.g. ALL apples). */
    COOP_GOAL: "COOP_GOAL",
    ERROR: "ERROR",
    PING: "PING",
    PONG: "PONG",
  };

  let seqCounter = 0;

  function envelope(type, payload, from) {
    return {
      v: PROTOCOL_VERSION,
      type,
      from: from || null,
      seq: ++seqCounter,
      payload: payload || {},
      ts: Date.now(),
    };
  }

  function parseMessage(raw) {
    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      return { ok: false, error: "malformed_json", detail: String(e) };
    }
    if (!msg || typeof msg !== "object") {
      return { ok: false, error: "not_object" };
    }
    if (msg.v !== PROTOCOL_VERSION) {
      return { ok: false, error: "version_mismatch", got: msg.v };
    }
    if (!msg.type || typeof msg.type !== "string") {
      return { ok: false, error: "missing_type" };
    }
    return { ok: true, msg };
  }

  function encode(msg) {
    return JSON.stringify(msg);
  }

  const API = {
    PROTOCOL_VERSION,
    TYPES,
    envelope,
    parseMessage,
    encode,
    resetSeq() {
      seqCounter = 0;
    },
  };

  root.MultiplayerProtocol = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
