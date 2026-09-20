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
    // Must match server::room::{MAX_RACE_PLAYERS, MAX_COOP_PLAYERS}
    return mode === "coop" ? 4 : 9;
  }

  /**
   * Promote spectators to players in join order until the mode cap.
   * Mutates roster client roles optimistically when setRole is omitted.
   * @returns {{ promoted: number, cap: number, playerCount: number }}
   */
  function seatAllAsPlayers(roster, setRole) {
    if (!roster || !Array.isArray(roster.clients)) {
      return { promoted: 0, cap: 0, playerCount: 0 };
    }
    const cap = playerCap(roster.mode);
    const clients = roster.clients.slice().sort(function (a, b) {
      const ja = a && a.joinOrder != null ? Number(a.joinOrder) : 1e9;
      const jb = b && b.joinOrder != null ? Number(b.joinOrder) : 1e9;
      if (ja !== jb) return ja - jb;
      return String((a && a.clientId) || "").localeCompare(
        String((b && b.clientId) || "")
      );
    });
    let playerCount = 0;
    for (let i = 0; i < clients.length; i++) {
      if (clients[i] && clients[i].role === "player") playerCount++;
    }
    let promoted = 0;
    for (let i = 0; i < clients.length; i++) {
      if (playerCount >= cap) break;
      const c = clients[i];
      if (!c || !c.clientId || c.role === "player") continue;
      c.role = "player";
      c.ready = false;
      if (typeof setRole === "function") setRole(c.clientId, "player");
      playerCount++;
      promoted++;
    }
    return { promoted: promoted, cap: cap, playerCount: playerCount };
  }

  /** True when lobby has spectators and player seats remain under the mode cap. */
  function canSeatAllAsPlayers(roster) {
    if (!roster || !Array.isArray(roster.clients) || roster.sessionActive) {
      return false;
    }
    const cap = playerCap(roster.mode);
    let players = 0;
    let spectators = 0;
    for (let i = 0; i < roster.clients.length; i++) {
      const c = roster.clients[i];
      if (!c) continue;
      if (c.role === "player") players++;
      else if (c.role === "spectator") spectators++;
    }
    if (players >= cap) return false;
    if (spectators <= 0) return false;
    return true;
  }

  /**
   * Co-op spawn Y offsets from board center by promote order.
   * Depends on total player count at Start match.
   * 1: [0]
   * 2: [-1, +1]
   * 3: [0, +2, -2]
   * 4: [-1, +1, +2, -2]
   */
  function coopSpawnOffsets(playerCount) {
    const n = Math.max(0, Math.min(4, Number(playerCount) || 0));
    if (n <= 1) return [0];
    if (n === 2) return [-1, 1];
    if (n === 3) return [0, 2, -2];
    return [-1, 1, 2, -2];
  }

  root.MultiplayerSession = {
    allPlayersReady: allPlayersReady,
    canStart: canStart,
    playerCap: playerCap,
    seatAllAsPlayers: seatAllAsPlayers,
    canSeatAllAsPlayers: canSeatAllAsPlayers,
    coopSpawnOffsets: coopSpawnOffsets,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.MultiplayerSession;
  }
})(typeof window !== "undefined" ? window : globalThis);
