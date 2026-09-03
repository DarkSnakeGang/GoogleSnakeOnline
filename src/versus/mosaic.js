/**
 * Versus mosaic spectate — mini-board grid over all players.
 * Installed onto MultiplayerApp.
 */
(function (root) {
  function install(App) {
    if (!App || App.__mpMosaicInstalled) return;
    App.__mpMosaicInstalled = true;

    const Gsm = root.MultiplayerGsm;
    const VersusState = root.VersusState;

    // Beyond this a pip row stops being readable in a mosaic cell — show a count.
    const CAT_PIP_LIMIT = 12;

    /**
     * Cat lives strip for one mosaic cell. Mirrors the native lives HUD: one
     * cat per life, spent ones dimmed, plus the peaceful-grace countdown.
     * Rebuilt only when the values change (renders run on every board delta).
     */
    function paintCatLives(el, board) {
      if (!el) return;
      const lives = board && board.catLives;
      if (lives == null) {
        if (el.__mpCatFp !== "off") {
          el.__mpCatFp = "off";
          el.textContent = "";
          el.style.display = "none";
          el.removeAttribute("title");
        }
        return;
      }
      const max = Math.max(1, Number(board.catLivesMax) || 9);
      const n = Math.max(0, Math.min(max, Number(lives) | 0));
      const grace = board.catGrace != null ? Math.max(0, Number(board.catGrace) | 0) : 0;
      const icon = (typeof root !== "undefined" && root.CAT_ICON) || "";
      const fp = n + "/" + max + ":" + grace + ":" + (icon ? "i" : "d");
      el.style.display = "flex";
      el.title =
        "Cat lives " + n + "/" + max + (grace > 0 ? " · grace " + grace : "");
      if (el.__mpCatFp === fp) return;
      el.__mpCatFp = fp;
      el.textContent = "";
      const doc = el.ownerDocument || document;
      if (max <= CAT_PIP_LIMIT) {
        for (let i = 0; i < max; i++) {
          let pip;
          if (icon) {
            pip = doc.createElement("img");
            pip.src = icon;
            pip.alt = "";
          } else {
            pip = doc.createElement("i");
          }
          pip.className = "mp-mosaic-cat-pip" + (i < n ? " on" : "");
          el.appendChild(pip);
        }
      }
      const count = doc.createElement("b");
      count.className = "mp-mosaic-cat-n";
      count.textContent = max <= CAT_PIP_LIMIT ? String(n) : n + "/" + max;
      el.appendChild(count);
      if (grace > 0) {
        const g = doc.createElement("span");
        g.className = "mp-mosaic-cat-grace";
        g.textContent = String(grace);
        el.appendChild(g);
      }
    }

    // Focus draws the same strip at game size.
    App.prototype._paintMosaicCatLives = function (el, board) {
      paintCatLives(el, board);
    };

    function animFrames() {
      return typeof root.requestAnimationFrame === "function"
        ? root.requestAnimationFrame.bind(root)
        : null;
    }

    /**
     * Boards land one tick at a time and the renderer slides the snake between
     * cells, so cells that are mid-step need repainting between deltas. Canvas
     * only — labels, classes and the cat strip stay on the 200ms tick.
     */
    App.prototype._ensureMosaicAnim = function () {
      if (this._mosaicAnimRaf) return;
      const raf = animFrames();
      if (!raf) return;
      const self = this;
      function frame() {
        if (!self._mosaicAnimRaf) return;
        if (!self.versus || self.versus.spectateMode !== "mosaic") {
          self._mosaicAnimRaf = 0;
          return;
        }
        self._mosaicAnimRaf = raf(frame);
        self._animateMosaicBoards();
      }
      this._mosaicAnimRaf = raf(frame);
    };

    App.prototype._stopMosaicAnim = function () {
      if (!this._mosaicAnimRaf) return;
      if (typeof root.cancelAnimationFrame === "function") {
        try {
          root.cancelAnimationFrame(this._mosaicAnimRaf);
        } catch (e) { /* ignore */ }
      }
      this._mosaicAnimRaf = 0;
    };

    App.prototype._animateMosaicBoards = function () {
      const cells = this._mosaicCells;
      if (!cells || typeof Gsm.snakeMotionActive !== "function") return;
      const self = this;
      Object.keys(cells).forEach(function (id) {
        const cell = cells[id];
        const canvas =
          (cell && cell.__mpCanvas) ||
          (cell && cell.querySelector ? cell.querySelector("canvas") : null);
        if (!canvas || !Gsm.snakeMotionActive(canvas)) return;
        const board = self.versus.boards[id];
        if (!board) return;
        Gsm.drawBoardOnCanvas(
          canvas,
          board,
          self._colorForClient(id),
          board.themeColors,
          id
        );
      });
    };

    App.prototype.ensureMosaic = function () {
      if (this._mosaicEl) return this._mosaicEl;
      const el = document.createElement("div");
      el.id = "mp-mosaic";
      el.style.display = "none";
      document.body.appendChild(el);
      this._mosaicEl = el;
      this._mosaicCells = {};
      const self = this;
      if (typeof window !== "undefined") {
        window.__mpMosaicRepaint = function () {
          if (self.versus && self.versus.spectateMode === "mosaic") {
            self.renderMosaic();
          }
        };
      }
      return el;
    };

    App.prototype.renderMosaic = function (opts) {
      opts = opts || {};
      const labelsOnly = !!opts.labelsOnly;
      const me = this.client && this.client.me();
      const el = this.ensureMosaic();
      const mode = this.client.roster && this.client.roster.mode;
      const isSpec =
        me &&
        me.role === "spectator" &&
        (mode === "versus" || mode === "coop");
      const sessionOn = !!(this.client.roster && this.client.roster.sessionActive);
      // Co-op spectators are mosaic-only (no native Focus seat)
      const mosaicOn =
        mode === "coop" || this.versus.spectateMode === "mosaic";
      if (!isSpec || !mosaicOn || !sessionOn) {
        el.style.display = "none";
        if (typeof this._stopMosaicLabelTick === "function") {
          this._stopMosaicLabelTick();
        }
        this._stopMosaicAnim();
        return;
      }
      if (mode === "coop" && this.versus.spectateMode !== "mosaic") {
        this.versus.setSpectateMode("mosaic");
      }
      if (typeof this._ensureMosaicLabelTick === "function") {
        this._ensureMosaicLabelTick();
      }
      this._ensureMosaicAnim();
      if (!labelsOnly) this._leaveVersusFocusSpectate();

      const players = (this.client.roster.clients || []).filter(function (c) {
        return c.role === "player";
      });
      if (!players.length) {
        el.style.display = "none";
        return;
      }
      const cols = Math.min(players.length, players.length <= 4 ? 2 : 3);
      el.style.display = "grid";
      el.style.gridTemplateColumns = "repeat(" + cols + ", minmax(180px, 1fr))";

      if (!labelsOnly) {
        let chromeBorder = null;
        const focusBoard = this.versus.boards[this.versus.focusClientId];
        if (focusBoard && focusBoard.themeColors && focusBoard.themeColors.border) {
          chromeBorder = focusBoard.themeColors.border;
        } else {
          for (let i = 0; i < players.length; i++) {
            const b = this.versus.boards[players[i].clientId];
            if (b && b.themeColors && b.themeColors.border) {
              chromeBorder = b.themeColors.border;
              break;
            }
          }
        }
        if (chromeBorder) el.style.background = chromeBorder;
      }

      const seen = {};
      const self = this;
      const goal =
        (this.versus && this.versus.versusGoal) ||
        (this.client.roster && this.client.roster.versusGoal) ||
        "score";
      const leadId =
        (this.versus &&
          (this.versus.winnerClientId || this.versus.leaderClientId)) ||
        (VersusState && VersusState.pickLeader
          ? VersusState.pickLeader(this.versus.scores, goal)
          : null);
      players.forEach(function (p) {
        seen[p.clientId] = true;
        let cell = self._mosaicCells[p.clientId];
        if (!cell) {
          cell = document.createElement("div");
          cell.className = "mp-mosaic-cell";
          const label = document.createElement("div");
          label.className = "mp-mosaic-label";
          const catLives = document.createElement("div");
          catLives.className = "mp-mosaic-cat";
          const canvas = document.createElement("canvas");
          canvas.width = 240;
          canvas.height = 212;
          canvas.className = "mp-mosaic-canvas";
          cell.appendChild(label);
          cell.appendChild(catLives);
          cell.appendChild(canvas);
          cell.onclick = function (ev) {
            if (ev) {
              ev.preventDefault();
              ev.stopPropagation();
            }
            self.focusSpectatePlayer(p.clientId);
          };
          el.appendChild(cell);
          // The animation loop looks this up every frame
          cell.__mpCanvas = canvas;
          self._mosaicCells[p.clientId] = cell;
        }
        const isLead = !!(leadId && leadId === p.clientId);
        cell.classList.toggle("mp-mosaic-lead", isLead);
        const labelEl = cell.querySelector(".mp-mosaic-label");
        if (labelEl) {
          const name =
            p.resolvedName ||
            p.displayName ||
            p.colorName ||
            p.clientId.slice(0, 6);
          const boardForTime = self.versus.boards[p.clientId];
          const sc = self.versus.scores && self.versus.scores[p.clientId];
          const runClock =
            self.versus.runClocks && self.versus.runClocks[p.clientId];
          const fallbackMs =
            sc && sc.timeMs != null && Number.isFinite(Number(sc.timeMs))
              ? Number(sc.timeMs)
              : boardForTime &&
                  boardForTime.timeMs != null &&
                  Number.isFinite(Number(boardForTime.timeMs))
                ? Number(boardForTime.timeMs)
                : null;
          const timeMs =
            VersusState && VersusState.resolveRunClockMs
              ? VersusState.resolveRunClockMs(runClock, Date.now(), fallbackMs)
              : fallbackMs;
          const clock =
            VersusState && VersusState.formatRunClock
              ? VersusState.formatRunClock(timeMs)
              : timeMs == null
                ? "—"
                : String(Math.floor(timeMs / 1000)) + "s";
          const best =
            VersusState && VersusState.formatGoalBest
              ? VersusState.formatGoalBest(sc, goal)
              : sc && sc.bestScore != null
                ? String(sc.bestScore)
                : "—";
          const text =
            (isLead ? "★ " : "") + name + " · " + clock + " · best " + best;
          labelEl.textContent = text;
          labelEl.title = text;
        }
        cell.classList.toggle(
          "mp-mosaic-focus",
          p.clientId === self.versus.focusClientId
        );
        paintCatLives(
          cell.querySelector(".mp-mosaic-cat"),
          self.versus.boards[p.clientId]
        );
        if (labelsOnly) return;
        const canvas = cell.querySelector("canvas");
        const board = self.versus.boards[p.clientId];
        const colorInfo = self._colorForClient(p.clientId);
        if (canvas && board) {
          Gsm.drawBoardOnCanvas(
            canvas,
            board,
            colorInfo,
            board.themeColors,
            p.clientId
          );
        } else if (canvas) {
          Gsm.drawBoardOnCanvas(
            canvas,
            { width: 17, height: 15, body: [], apples: [] },
            colorInfo
          );
        }
      });
      Object.keys(this._mosaicCells).forEach(function (id) {
        if (!seen[id]) {
          self._mosaicCells[id].remove();
          delete self._mosaicCells[id];
        }
      });
    };
  }

  root.MultiplayerMosaic = { install: install };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { install: install };
  }
})(typeof window !== "undefined" ? window : globalThis);
