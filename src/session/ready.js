/** Session helpers: ready gate, role checks. */
(function (root) {
  function allPlayersReady(roster) {
    if (!roster || !roster.clients) return false;
    const players = roster.clients.filter(function (c) {
      return c.role === "player";
    });
    return players.length > 0 && players.every(function (p) {
      return !!p.ready;
    });
  }

  /**
   * Start match begins a new session window (clears attempt expiry on server).
   * Within an expired window, PLAY_SYNC is still blocked separately.
   */
  function canStart(roster) {
    return allPlayersReady(roster);
  }

  function playerCap(mode) {
    return mode === "coop" ? 4 : 10;
  }

  /**
   * Co-op spawn Y offsets from board center by promote order.
   * Depends on total player count at Start match.
   * 1: [0]
   * 2: [-1, +1]
   * 3: [0, +3, -2]
   * 4: [-1, +1, -4, +4]
   */
  function coopSpawnOffsets(playerCount) {
    const n = Math.max(0, Math.min(4, Number(playerCount) || 0));
    if (n <= 1) return [0];
    if (n === 2) return [-1, 1];
    if (n === 3) return [0, 3, -2];
    return [-1, 1, -4, 4];
  }

  root.MultiplayerSession = {
    allPlayersReady: allPlayersReady,
    canStart: canStart,
    playerCap: playerCap,
    coopSpawnOffsets: coopSpawnOffsets,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.MultiplayerSession;
  }
})(typeof window !== "undefined" ? window : globalThis);
