/** Co-op client: apply server state, input, isolated TimeKeeper. */
(function (root) {
  const COOP_TK_KEY = "snake_timeKeeper_coop";

  function CoopState() {
    this.snapshot = null;
    this.myClientId = null;
  }

  CoopState.prototype.apply = function (payload) {
    this.snapshot = payload;
  };

  CoopState.prototype.mySnake = function () {
    if (!this.snapshot || !this.snapshot.snakes) return null;
    const id = this.myClientId;
    return this.snapshot.snakes.find(function (s) {
      return s.client_id === id || s.clientId === id;
    });
  };

  CoopState.prototype.myColorId = function () {
    const s = this.mySnake();
    return s ? s.color_id != null ? s.color_id : s.colorId : null;
  };

  function loadCoopTimes() {
    try {
      return JSON.parse(localStorage.getItem(COOP_TK_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveCoopTime(categoryKey, timeMs, score) {
    // Never touch snake_timeKeeper_remix
    const data = loadCoopTimes();
    const prev = data[categoryKey];
    if (!prev || (timeMs != null && timeMs > (prev.timeMs || 0))) {
      data[categoryKey] = { timeMs: timeMs, score: score, updatedAt: Date.now() };
      localStorage.setItem(COOP_TK_KEY, JSON.stringify(data));
      return true;
    }
    return false;
  }

  root.CoopState = CoopState;
  root.CoopTimeKeeper = {
    KEY: COOP_TK_KEY,
    REMIX_KEY: "snake_timeKeeper_remix",
    load: loadCoopTimes,
    save: saveCoopTime,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { CoopState: CoopState, CoopTimeKeeper: root.CoopTimeKeeper };
  }
})(typeof window !== "undefined" ? window : globalThis);
