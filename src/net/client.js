/** WebSocket client with reconnect, heartbeat, seq-gap resync. */
(function (root) {
  const P = root.MultiplayerProtocol;

  /** Server rejected HELLO — do not treat socket-open as joined. */
  const HELLO_FAIL_CODES = {
    room_not_found: true,
    bad_room: true,
    room_full: true,
    hello_timeout: true,
  };

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
    this.joined = false;
    this.lastSeq = 0;
    this._wantConnected = false;
    this._userDisconnect = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._helloTimer = null;
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
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
  };

  MultiplayerClient.prototype._startPing = function () {
    const self = this;
    if (this._pingTimer) clearInterval(this._pingTimer);
    const beat = function () {
      if (!self.joined || !self.connected) return;
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
      self.joined = false;

      function settleOk(welcomePayload) {
        if (settled) return;
        settled = true;
        if (self._helloTimer) {
          clearTimeout(self._helloTimer);
          self._helloTimer = null;
        }
        resolve(welcomePayload || {});
      }

      function settleFail(err) {
        if (settled) return;
        settled = true;
        if (self._helloTimer) {
          clearTimeout(self._helloTimer);
          self._helloTimer = null;
        }
        // Failed HELLO must not loop forever on a dead/missing room
        if (!isReconnect) self._wantConnected = false;
        else if (err && HELLO_FAIL_CODES[err.code]) self._wantConnected = false;
        self.joined = false;
        self.connected = false;
        try {
          if (self.ws) self.ws.close();
        } catch (e) { /* ignore */ }
        reject(err || new Error("hello_failed"));
      }

      self._helloTimer = setTimeout(function () {
        if (self.joined || settled) return;
        const err = {
          code: "hello_timeout",
          message: "Server did not welcome — check room code / server",
        };
        self.emit("ERROR", err);
        settleFail(err);
      }, 10000);

      self.ws.onopen = function () {
        self.connected = true;
        self._reconnectAttempt = 0;
        const create = isReconnect
          ? false
          : self.create || !self.roomCode;
        // Only HELLO until WELCOME — ping/resync/admin cmds caused "Send HELLO first"
        self.send(P.TYPES.HELLO, {
          displayName: self.displayName,
          roomCode: self.roomCode,
          create: create,
        });
      };
      self.ws.onerror = function (e) {
        self.emit("ERROR", { code: "ws_error", message: "WebSocket error" });
        if (!settled) settleFail(e);
      };
      self.ws.onclose = function (ev) {
        const wasJoined = self.joined;
        self.connected = false;
        self.joined = false;
        self._clearTimers();
        self.emit("CLOSE", {
          code: ev && ev.code,
          reason: ev && ev.reason,
        });
        if (!settled) {
          settleFail({
            code: "ws_closed",
            message: "Connection closed before join",
          });
          return;
        }
        if (!self._userDisconnect && self._wantConnected && wasJoined) {
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
        if (msg.type === P.TYPES.ERROR && !self.joined) {
          const code = msg.payload && msg.payload.code;
          // Pre-join noise from a raced PING — ignore (gated sends should prevent this)
          if (code === "not_joined") return;
          // room_not_found / bad_room / room_full / join errors — fail connect()
          self.emit(msg.type, msg.payload, msg);
          settleFail(msg.payload || { code: code || "hello_failed" });
          return;
        }
        if (msg.type === P.TYPES.WELCOME) {
          self.clientId = msg.payload.clientId;
          self.roomCode = msg.payload.roomCode || self.roomCode;
          self.create = false;
          self.joined = true;
          self.lastSeq = msg.seq || 0;
          self._startPing();
          if (isReconnect) {
            self.resync();
            self.emit("RECONNECTED", {});
          }
          self.emit(msg.type, msg.payload, msg);
          settleOk(msg.payload);
          return;
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
    this.joined = false;
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
    this.joined = false;
    this.lastPingMs = null;
  };

  MultiplayerClient.prototype.send = function (type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return;
    // Gate everything except HELLO until the server welcomes us
    if (type !== P.TYPES.HELLO && !this.joined) return;
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
