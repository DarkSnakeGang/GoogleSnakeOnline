/** WebSocket client with reconnect, heartbeat, seq-gap resync. */
(function (root) {
  const P = root.MultiplayerProtocol;

  function MultiplayerClient(options) {
    this.url = (options && options.url) || "ws://127.0.0.1:7777/ws";
    this.displayName = (options && options.displayName) || "";
    this.roomCode = (options && options.roomCode) || "";
    this.create = !!(options && options.create);
    this.ws = null;
    this.clientId = null;
    this.roster = null;
    this.handlers = {};
    this.connected = false;
    this.lastSeq = 0;
    this._wantConnected = false;
    this._userDisconnect = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._connectPromise = null;
    this.lastPingMs = null;
    this._pingSentAt = 0;
  }

  MultiplayerClient.prototype.on = function (type, fn) {
    (this.handlers[type] || (this.handlers[type] = [])).push(fn);
  };

  MultiplayerClient.prototype.emit = function (type, payload, raw) {
    const list = this.handlers[type] || [];
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload, raw);
      } catch (e) {
        console.error("MultiplayerClient handler error", type, e);
      }
    }
    const any = this.handlers["*"] || [];
    for (let i = 0; i < any.length; i++) {
      try {
        any[i](type, payload, raw);
      } catch (e) {
        console.error(e);
      }
    }
  };

  MultiplayerClient.prototype._clearTimers = function () {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  };

  MultiplayerClient.prototype._startPing = function () {
    const self = this;
    if (this._pingTimer) clearInterval(this._pingTimer);
    const beat = function () {
      if (!self.connected) return;
      self._pingSentAt = Date.now();
      self.send(P.TYPES.PING, { t: self._pingSentAt });
    };
    beat();
    this._pingTimer = setInterval(beat, 5000);
  };

  MultiplayerClient.prototype._scheduleReconnect = function () {
    const self = this;
    if (self._userDisconnect || !self._wantConnected) return;
    if (self._reconnectTimer) return;
    const attempt = Math.min(self._reconnectAttempt++, 6);
    const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
    self.emit("RECONNECTING", { attempt: attempt + 1, delay: delay });
    self._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self._openSocket(true).catch(function () {
        self._scheduleReconnect();
      });
    }, delay);
  };

  MultiplayerClient.prototype._openSocket = function (isReconnect) {
    const self = this;
    return new Promise(function (resolve, reject) {
      try {
        self.ws = new WebSocket(self.url);
      } catch (e) {
        reject(e);
        return;
      }
      let settled = false;
      self.ws.onopen = function () {
        self.connected = true;
        self._reconnectAttempt = 0;
        const create = isReconnect
          ? false
          : self.create || !self.roomCode;
        self.send(P.TYPES.HELLO, {
          displayName: self.displayName,
          roomCode: self.roomCode,
          create: create,
        });
        self._startPing();
        if (isReconnect) {
          self.resync();
          self.emit("RECONNECTED", {});
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      self.ws.onerror = function (e) {
        self.emit("ERROR", { code: "ws_error", message: "WebSocket error" });
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      self.ws.onclose = function (ev) {
        self.connected = false;
        self._clearTimers();
        self.emit("CLOSE", {
          code: ev && ev.code,
          reason: ev && ev.reason,
        });
        if (!self._userDisconnect && self._wantConnected) {
          self._scheduleReconnect();
        }
      };
      self.ws.onmessage = function (ev) {
        const parsed = P.parseMessage(ev.data);
        if (!parsed.ok) {
          self.emit("ERROR", { code: parsed.error, message: parsed.error });
          return;
        }
        const msg = parsed.msg;
        if (msg.type === P.TYPES.WELCOME) {
          self.clientId = msg.payload.clientId;
          self.roomCode = msg.payload.roomCode || self.roomCode;
          self.create = false;
          self.lastSeq = msg.seq || 0;
        }
        if (msg.type === P.TYPES.ROSTER) {
          self.roster = msg.payload;
        }
        if (msg.type === P.TYPES.PONG) {
          if (self._pingSentAt) {
            self.lastPingMs = Math.max(0, Date.now() - self._pingSentAt);
            self._pingSentAt = 0;
            self.emit("PING_UPDATE", { ms: self.lastPingMs });
          }
        }
        const seq = msg.seq || 0;
        // Debounce gap resync — +5 storms under BOARD_DELTA and trashes HUD/Focus
        if (seq && self.lastSeq && seq > self.lastSeq + 40) {
          const now = Date.now();
          if (!self._lastResyncAt || now - self._lastResyncAt > 3000) {
            self._lastResyncAt = now;
            self.resync();
          }
        }
        if (seq) self.lastSeq = Math.max(self.lastSeq || 0, seq);
        self.emit(msg.type, msg.payload, msg);
      };
    });
  };

  MultiplayerClient.prototype.connect = function () {
    this._wantConnected = true;
    this._userDisconnect = false;
    this._reconnectAttempt = 0;
    return this._openSocket(false);
  };

  MultiplayerClient.prototype.disconnect = function () {
    this._userDisconnect = true;
    this._wantConnected = false;
    this._clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) { /* ignore */ }
    }
    this.ws = null;
    this.connected = false;
    this.lastPingMs = null;
  };

  MultiplayerClient.prototype.send = function (type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const env = P.envelope(type, payload, this.clientId);
    this.ws.send(P.encode(env));
  };

  MultiplayerClient.prototype.setRole = function (clientId, role) {
    this.send(P.TYPES.SET_ROLE, { clientId: clientId, role: role });
  };
  MultiplayerClient.prototype.kick = function (clientId) {
    this.send(P.TYPES.KICK, { clientId: clientId });
  };
  MultiplayerClient.prototype.setDuration = function (minutes) {
    this.send(P.TYPES.SET_DURATION, { minutes: minutes });
  };
  MultiplayerClient.prototype.setVersusGoal = function (goal) {
    this.send(P.TYPES.SET_VERSUS_GOAL, { goal: goal });
  };
  MultiplayerClient.prototype.setReady = function (ready) {
    this.send(P.TYPES.READY, { ready: !!ready });
  };
  MultiplayerClient.prototype.claimColor = function (colorId) {
    this.send(P.TYPES.COLOR_CLAIM, { colorId: colorId });
  };
  MultiplayerClient.prototype.setMode = function (mode) {
    this.send(P.TYPES.MODE_CHANGE, { mode: mode });
  };
  MultiplayerClient.prototype.syncSettings = function (settings) {
    this.send(P.TYPES.SETTINGS_SYNC, settings || {});
  };
  MultiplayerClient.prototype.playSync = function (payload) {
    this.send(P.TYPES.PLAY_SYNC, payload || {});
  };
  MultiplayerClient.prototype.sessionStart = function (payload) {
    this.send(P.TYPES.SESSION_START, payload || {});
  };
  MultiplayerClient.prototype.sessionEnd = function (reason) {
    this.send(P.TYPES.SESSION_END, { reason: reason || "aborted" });
  };
  MultiplayerClient.prototype.sendInput = function (dir) {
    this.send(P.TYPES.INPUT, { dir: dir });
  };
  MultiplayerClient.prototype.scorePulse = function (data) {
    this.send(P.TYPES.SCORE_PULSE, data);
  };
  MultiplayerClient.prototype.transferAdmin = function (clientId) {
    this.send(P.TYPES.ADMIN_TRANSFER, { clientId: clientId });
  };
  MultiplayerClient.prototype.boardDelta = function (board) {
    this.send(P.TYPES.BOARD_DELTA, board);
  };
  MultiplayerClient.prototype.boardSnapshot = function (board) {
    this.send(P.TYPES.BOARD_SNAPSHOT, board);
  };
  MultiplayerClient.prototype.spectateFocus = function (clientId) {
    this.send(P.TYPES.SPECTATE_FOCUS, { clientId: clientId });
  };
  MultiplayerClient.prototype.snakeDelta = function (data) {
    this.send(P.TYPES.SNAKE_DELTA, data || {});
  };
  MultiplayerClient.prototype.collectablesDelta = function (data) {
    this.send(P.TYPES.COLLECTABLES_DELTA, data || {});
  };
  MultiplayerClient.prototype.coopPlayerDead = function (data) {
    this.send(P.TYPES.COOP_PLAYER_DEAD, data || {});
  };
  MultiplayerClient.prototype.coopGoal = function (data) {
    this.send(P.TYPES.COOP_GOAL, data || {});
  };
  MultiplayerClient.prototype.resync = function () {
    this.send(P.TYPES.RESYNC_REQUEST, {});
  };

  MultiplayerClient.prototype.isAdmin = function () {
    return (
      this.roster && this.roster.adminId && this.roster.adminId === this.clientId
    );
  };

  MultiplayerClient.prototype.me = function () {
    if (!this.roster || !this.roster.clients) return null;
    const id = this.clientId;
    return this.roster.clients.find(function (c) {
      return c.clientId === id;
    });
  };

  MultiplayerClient.prototype.allowNewRuns = function () {
    if (!this.roster) return true;
    if (this.roster.allowNewRuns === false) return false;
    return true;
  };

  root.MultiplayerClient = MultiplayerClient;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = MultiplayerClient;
  }
})(typeof window !== "undefined" ? window : globalThis);
